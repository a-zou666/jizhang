#!/usr/bin/env node
/**
 * 把签名好的 APK 与更新清单发布到 Gitee Release。
 *
 * 为什么要这一步：GitHub 在国内经常连不上，如果 App 的更新链路走 GitHub，
 * 等于「永远更新不了」。所以 CI 仍在 GitHub Actions 上打包签名（那边免费、
 * 量大），但产物要**再推一份到 Gitee**，App 只认 Gitee 的地址。
 *
 * 做法：固定用一个 tag（默认 `latest`）承载「当前最新版」。每次发布都
 * 更新同一个 Release 的附件，这样 App 端的清单地址与 APK 直链**永远不变**，
 * 不用跟着版本号改代码：
 *   latest.json                                  ← App 拉这个
 *   app-arm64-release.apk / app-arm-release.apk  ← 用户在浏览器里下的
 *
 * 环境变量（由 GitHub Actions 从 Secrets 注入）：
 *   GITEE_TOKEN           必填，Gitee 私人令牌（要有 projects 权限）
 *   GITEE_OWNER/GITEE_REPO 可选，默认与 App 内的更新源常量一致
 *   GITEE_RELEASE_TAG     可选，默认 latest
 * 缺 GITEE_TOKEN → 打印说明并退出 0（CI 不红，只是这次不推 Gitee）。
 *
 * 分支：建 Release 时用的 `target_commitish` 从仓库接口读 `default_branch`。
 * **不要写死** —— GitHub 默认分支是 `main`，Gitee 是 `master`；写死错的名字
 * 时 Gitee 会返回 HTTP 404「Not Found Project」，很容易误判成「仓库不存在」。
 *
 * 用法：
 *   node scripts/publish-gitee-release.mjs
 *   node scripts/publish-gitee-release.mjs --dry-run   # 只打印要发什么
 *   node scripts/publish-gitee-release.mjs --self-test
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const APK_DIR = resolve(ROOT, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
const PACKAGE_JSON = resolve(ROOT, "package.json");

const API = "https://gitee.com/api/v5";

/** 与 store.js / update.rs 里的更新源保持一致的默认值 */
const DEFAULT_OWNER = "yykzz";
const DEFAULT_REPO = "jizhang";
const DEFAULT_TAG = "latest";

/** 附件直链前缀，App 端靠它拼下载地址（三者必须一致） */
const DOWNLOAD_BASE = (owner, repo, tag) =>
  `https://gitee.com/${owner}/${repo}/releases/download/${tag}`;

/* ==========================================================================
   纯函数（可单测）
   ========================================================================== */

/** `app-arm64-release-unsigned.apk` → `arm64`；认不出返回 null */
export function abiOfApk(fileName) {
  const name = String(fileName ?? "").toLowerCase();
  if (!name.endsWith(".apk")) return null;
  if (name.includes("arm64") || name.includes("aarch64")) return "arm64";
  if (/(^|[-_.])arm([-_.]|$)/.test(name) || name.includes("armeabi")) return "arm";
  return null;
}

/**
 * 从 APK 文件列表里挑出每个 ABI 该发布的那个。
 *
 * 优先要**已签名**的（名字里不含 unsigned）。签名脚本会删掉 unsigned 原件，
 * 但万一签名被跳过（没配 Secrets），这里也别把未签名的包当成正式产物发出去 ——
 * 未签名的 APK 用户装了会失败，发出去等于发了个坏包。
 */
export function pickReleaseApks(fileNames) {
  const picked = {};
  for (const name of fileNames) {
    const abi = abiOfApk(name);
    if (!abi) continue;
    const signed = !String(name).toLowerCase().includes("unsigned");
    const current = picked[abi];
    if (!current) {
      picked[abi] = { name, signed };
      continue;
    }
    // 已签名优先；同为已签名时保持先遇到的（文件名稳定）
    if (signed && !current.signed) picked[abi] = { name, signed };
  }
  return picked;
}

/** 生成更新清单对象（App 端 check_update 解析的就是它） */
export function buildManifest({ version, notes, owner, repo, tag, apks, publishedAt }) {
  const base = DOWNLOAD_BASE(owner, repo, tag);
  const url = (file) => (file ? `${base}/${file}` : "");
  return {
    schema: 1,
    version: String(version ?? "").trim(),
    notes: String(notes ?? "").trim(),
    apk: {
      arm64: url(apks?.arm64?.name),
      arm: url(apks?.arm?.name),
      universal: "",
    },
    page_url: `https://gitee.com/${owner}/${repo}/releases`,
    published_at: publishedAt ?? new Date().toISOString(),
  };
}

/** 递归找出所有 .apk */
export function findApks(dir) {
  const found = [];
  if (!existsSync(dir)) return found;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".apk")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * 建 Release 的请求体。
 *
 * `branch` 为空时**必须整个省掉** `target_commitish`：传空串或传错分支名，
 * Gitee 都会报 HTTP 404「Not Found Project」（GitHub 那边是 main，Gitee 是
 * master，写死必然踩坑）。省掉这个字段，Gitee 会用仓库默认分支。
 */
export function buildReleaseBody({ tag, name, body, branch }) {
  const payload = { tag_name: String(tag ?? "").trim(), name, body };
  const trimmed = String(branch ?? "").trim();
  if (trimmed) payload.target_commitish = trimmed;
  return payload;
}

/* ==========================================================================
   HTTP
   ========================================================================== */

async function gitee(path, { method = "GET", token, body, form } = {}) {
  const url = new URL(`${API}${path}`);
  const headers = { "User-Agent": "ai-ledger-ci" };
  let payload;

  if (form) {
    // multipart：附件上传必须走这个
    payload = form;
  } else {
    const data = { ...(body ?? {}), access_token: token };
    if (method === "GET") {
      for (const [key, value] of Object.entries(data)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    } else {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(data);
    }
  }

  const response = await fetch(url, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（Gitee 出错时可能返回 HTML），下面按状态码报错 */
  }
  if (!response.ok) {
    const detail = json?.error_description || json?.message || text.slice(0, 200) || response.statusText;
    throw new Error(`Gitee ${method} ${path} 失败（HTTP ${response.status}）：${detail}`);
  }
  return json;
}

/**
 * 用一次轻量的「我是谁」请求验令牌。
 *
 * 必须**先验**再干活：令牌坏掉时 Gitee 有一堆接口会返回
 * HTTP 404「Not Found Project」（而不是 401），照着这个报错去查，会一路
 * 往「仓库地址写错了 / 仓库不存在」的方向瞎找，实际原因是令牌失效。
 * 这里prominently 把「令牌无效」点出来，省掉这段排查。
 */
async function verifyToken({ owner, repo, token }) {
  const url = new URL(`${API}/user`);
  url.searchParams.set("access_token", token);
  const response = await fetch(url, { headers: { "User-Agent": "ai-ledger-ci" } });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.json())?.message ?? "";
    } catch {
      /* 非 JSON 就用状态码 */
    }
    throw new Error(
      `GITEE_TOKEN 校验失败（HTTP ${response.status}）：${detail || response.statusText}\n` +
        "      令牌无效或已过期。请到 Gitee → 设置 → 私人令牌 重新生成，" +
        "确保勾选 projects 权限，然后更新仓库 Secrets 里的 GITEE_TOKEN。\n" +
        `      目标仓库：https://gitee.com/${owner}/${repo}`,
    );
  }
}

/** 用 FormData 传一个文件（Node 18+ 原生支持） */
function fileForm(filePath, extra = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(extra)) form.append(key, String(value));
  const data = readFileSync(filePath);
  form.append("file", new Blob([data]), basename(filePath));
  return form;
}

/* ==========================================================================
   发布流程
   ========================================================================== */

/**
 * 找仓库的默认分支。
 *
 * 这个值不能写死：GitHub 那边是 `main`，而 Gitee 镜像仓库默认分支是 `master`。
 * 往 Gitee 建 Release 时如果 `target_commitish` 指向一个不存在的分支，
 * 接口会返回 HTTP 404「Not Found Project」——看起来像「仓库不存在」，
 * 其实只是分支名不对，很容易查错方向。
 *
 * 另外：带坏令牌请求会 401，而**不带令牌**请求公开仓库是 200。所以这里
 * 明确不传令牌 —— 公开仓库的默认分支是公开信息，读得到更稳。
 */
async function defaultBranch({ owner, repo }) {
  try {
    const info = await gitee(`/repos/${owner}/${repo}`, {});
    const branch = String(info?.default_branch ?? "").trim();
    if (branch) return branch;
  } catch (error) {
    // 公开仓库匿名就能读。这里读不到，几乎可以断定是 owner/repo 写错了
    // （Gitee 对不存在的仓库统一回 404「Not Found Project」，不说细节）。
    throw new Error(
      `读不到仓库 ${owner}/${repo}：${error.message}\n` +
        `      请确认 GITEE_OWNER / GITEE_REPO 两个 Secrets 的值正确（注意别带空格或换行）。\n` +
        "      自测方法：匿名访问这个接口应该返回 200 ——\n" +
        `      https://gitee.com/api/v5/repos/${owner}/${repo}`,
    );
  }
  return "";
}

/** 找到 tag 对应的 Release，没有就建一个 */
async function ensureRelease({ owner, repo, tag, token, name, body, branch }) {
  try {
    const release = await gitee(`/repos/${owner}/${repo}/releases/tags/${tag}`, { token });
    if (release?.id) return { id: release.id, created: false };
  } catch {
    /* 404 说明还没建过，往下走创建分支 */
  }
  const created = await gitee(`/repos/${owner}/${repo}/releases`, {
    method: "POST",
    token,
    body: buildReleaseBody({ tag, name, body, branch }),
  });
  return { id: created.id, created: true };
}

/** 列出该 Release 已有的附件 */
async function listAttachments({ owner, repo, releaseId, token }) {
  const files = await gitee(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, { token });
  return Array.isArray(files) ? files : [];
}

/** 删掉同名旧附件（同一个 Release 重复发布时必须先删，否则会堆积多份） */
async function removeAttachment({ owner, repo, releaseId, fileId, token }) {
  await gitee(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files/${fileId}`, {
    method: "DELETE",
    token,
  });
}

async function uploadAttachment({ owner, repo, releaseId, token, filePath }) {
  return gitee(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, {
    method: "POST",
    form: fileForm(filePath, { access_token: token }),
  });
}

/* ==========================================================================
   自检
   ========================================================================== */

function selfTest() {
  const cases = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push({ name, ok, actual, expected });
  };

  check("识别 arm64", abiOfApk("app-arm64-release.apk"), "arm64");
  check("识别 aarch64", abiOfApk("app-aarch64-release.apk"), "arm64");
  check("识别 armv7", abiOfApk("app-arm-release.apk"), "arm");
  check("识别 armeabi", abiOfApk("app-armeabi-v7a-release.apk"), "arm");
  check("非 apk 返回 null", abiOfApk("latest.json"), null);
  check("x86 不认识", abiOfApk("app-x86_64-release.apk"), null);

  const picked = pickReleaseApks([
    "app-arm64-release-unsigned.apk",
    "app-arm64-release.apk",
    "app-arm-release-unsigned.apk",
  ]);
  check("优先挑已签名（arm64）", picked.arm64.name, "app-arm64-release.apk");
  check("arm 只有未签名时也要挑", picked.arm.name, "app-arm-release-unsigned.apk");

  const manifest = buildManifest({
    version: "0.1.1",
    notes: "修了个 bug",
    owner: "o",
    repo: "r",
    tag: "latest",
    apks: { arm64: { name: "a64.apk" }, arm: { name: "a32.apk" } },
    publishedAt: "2026-01-01T00:00:00Z",
  });
  check("清单 version", manifest.version, "0.1.1");
  check("清单 arm64 直链", manifest.apk.arm64, "https://gitee.com/o/r/releases/download/latest/a64.apk");
  check("清单 arm 直链", manifest.apk.arm, "https://gitee.com/o/r/releases/download/latest/a32.apk");
  check("清单 schema", manifest.schema, 1);

  // 分支名不能写死：GitHub 是 main，Gitee 是 master，传错会 404 Not Found Project
  check("指定分支时带上 target_commitish", buildReleaseBody({ tag: "latest", name: "n", body: "b", branch: "master" }), {
    tag_name: "latest",
    name: "n",
    body: "b",
    target_commitish: "master",
  });
  check(
    "没拿到分支时省掉 target_commitish（交给 Gitee 用默认分支）",
    buildReleaseBody({ tag: "latest", name: "n", body: "b", branch: "" }),
    { tag_name: "latest", name: "n", body: "b" },
  );

  let failed = 0;
  for (const item of cases) {
    if (item.ok) {
      console.log(`  ✓ ${item.name}`);
    } else {
      failed += 1;
      console.error(
        `  ✗ ${item.name} → 得到 ${JSON.stringify(item.actual)}，期望 ${JSON.stringify(item.expected)}`,
      );
    }
  }
  if (failed) {
    console.error(`[gitee-release] 自检失败：${cases.length - failed}/${cases.length} 通过`);
    process.exit(1);
  }
  console.log(`[gitee-release] 自检通过：${cases.length}/${cases.length} 个用例`);
}

/* ==========================================================================
   主流程
   ========================================================================== */

function readVersion() {
  try {
    return JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).version ?? "";
  } catch {
    return "";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const dryRun = argv.includes("--dry-run");

  const owner = (process.env.GITEE_OWNER ?? "").trim() || DEFAULT_OWNER;
  const repo = (process.env.GITEE_REPO ?? "").trim() || DEFAULT_REPO;
  const tag = (process.env.GITEE_RELEASE_TAG ?? "").trim() || DEFAULT_TAG;
  const token = (process.env.GITEE_TOKEN ?? "").trim();
  const version = readVersion();

  const apks = pickReleaseApks(findApks(APK_DIR).map((p) => basename(p)));
  const pathOf = (name) => findApks(APK_DIR).find((p) => basename(p) === name);
  const files = Object.values(apks).filter(Boolean);

  if (!files.length) {
    console.error(`[gitee-release] 没找到可发布的 APK（${APK_DIR}），先跑构建`);
    process.exit(1);
  }

  const unsigned = files.filter((item) => !item.signed);
  if (unsigned.length) {
    console.warn(
      `[gitee-release] 警告：${unsigned.map((i) => i.name).join("、")} 未签名，` +
        "用户很难装上；请检查 KEYSTORE_* Secrets 是否配好",
    );
  }

  const manifest = buildManifest({
    version,
    notes: (process.env.RELEASE_NOTES ?? "").trim(),
    owner,
    repo,
    tag,
    apks,
  });

  console.log(`[gitee-release] 目标：${owner}/${repo} @ ${tag}`);
  console.log(`[gitee-release] 版本：${version}`);
  for (const item of files) console.log(`  = ${item.name}${item.signed ? "" : "（未签名）"}`);
  console.log(`[gitee-release] 清单 apk.arm64 = ${manifest.apk.arm64}`);
  console.log(`[gitee-release] 清单 apk.arm   = ${manifest.apk.arm}`);

  if (dryRun) {
    console.log("[gitee-release] dry-run：不上传。清单内容如下：");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (!token) {
    console.log("[gitee-release] 未提供 GITEE_TOKEN，跳过发布到 Gitee。");
    console.log("[gitee-release] 需要在仓库 Secrets 里配置 GITEE_TOKEN（Gitee 私人令牌）。");
    return;
  }

  const branch = await defaultBranch({ owner, repo });
  console.log(`[gitee-release] 默认分支：${branch || "（接口未返回，交给 Gitee 决定）"}`);

  // 先验令牌：坏令牌时 Gitee 有一堆接口会回 404「Not Found Project」，
  // 照那个报错查会一路跑偏，这里直接把「令牌无效」挑明。
  await verifyToken({ owner, repo, token });

  const { id: releaseId, created } = await ensureRelease({
    owner,
    repo,
    tag,
    token,
    branch,
    name: `${owner}/${repo} 最新版`,
    body: "本 Release 由 CI 自动维护，始终承载最新构建产物。App 从附件 latest.json 获取版本信息。",
  });
  console.log(`[gitee-release] Release #${releaseId}${created ? "（新建）" : "（复用）"}`);

  // 先把最新清单写到本地临时文件，方便一起上传
  const manifestPath = resolve(ROOT, "dist", "latest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const uploads = [...files.map((item) => pathOf(item.name)).filter(Boolean), manifestPath];
  const existing = await listAttachments({ owner, repo, releaseId, token });
  const byName = new Map(existing.map((file) => [file.name ?? file.title, file]));

  for (const filePath of uploads) {
    const name = basename(filePath);
    const previous = byName.get(name);
    if (previous?.id) {
      await removeAttachment({ owner, repo, releaseId, fileId: previous.id, token });
      console.log(`  - 覆盖旧附件 ${name}`);
    }
    const size = statSync(filePath).size;
    await uploadAttachment({ owner, repo, releaseId, token, filePath });
    console.log(`  + 已上传 ${name}（${(size / 1024 / 1024).toFixed(2)} MB）`);
  }

  console.log(`[gitee-release] 完成：${uploads.length} 个附件已发布到 Gitee`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[gitee-release] 失败：${error.message}`);
    process.exit(1);
  });
}
