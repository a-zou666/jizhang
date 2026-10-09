#!/usr/bin/env node
/**
 * APK 中转同步：GitHub Release → 本机 nginx（:9443）→ Gitee（只推清单）。
 *
 * ## 为什么需要这个脚本
 *
 * 实测（2026-10-09，香港 Azure 机器）：
 *   香港 → GitHub 下载 7MB        5 MB/s
 *   香港 → Gitee  上传 2MB        30~50 KB/s   ← 瓶颈在这里
 *   GitHub Actions → Gitee 上传   10~24 KB/s
 *   Gitee TCP connect / TLS       0.46s / 0.72s（链路本身没问题）
 *
 * 结论：**慢的不是跨境，是 Gitee 自己的附件上传接口。** 所以「换台机器推 Gitee」
 * 只能快 2~3 倍，治不了本。真正的解法是**让 Gitee 不必承载 APK 本体**：
 *
 *   GitHub Actions ──5MB/s──> GitHub Release（只存构建产物）
 *                                    │ 本脚本下载（174MB/s 下行）
 *                                    ▼
 *                          本机 /var/www/apk + nginx :9443（43MB/s 上行）
 *                                    │ 只推 437 字节的 latest.json
 *                                    ▼
 *                              Gitee Release（秒传）
 *
 * App 端 `MANIFEST_URL` 仍然指向 Gitee 的 `latest.json`（国内可达、地址不变），
 * 但清单里的 `apk.arm64` / `apk.arm` 指向本机直链。于是：
 *   - 推 Gitee 的数据量从 ~12MB 降到几百字节
 *   - 用户下载走本机 43MB/s，比 Gitee 的 463KB/s 快两个数量级
 *
 * ## 环境变量
 *
 *   GITEE_TOKEN        必填（推清单用；缺了只更新本地文件，不推 Gitee）
 *   GITEE_OWNER        可选，默认 yykzz
 *   GITEE_REPO         可选，默认 jizhang
 *   GITEE_RELEASE_TAG  可选，默认 latest
 *   GH_REPO            可选，默认 a-zou666/jizhang（GitHub 仓库坐标）
 *   PUBLIC_BASE        可选，默认 http://104.208.75.62:9443（APK 直链前缀）
 *   APK_DIR            可选，默认 /var/www/apk
 *   FORCE              设 1 时即使版本没变也重新同步
 *
 * ## 用法
 *
 *   node scripts/mirror-apk-to-hk.mjs              # 同步一次
 *   node scripts/mirror-apk-to-hk.mjs --dry-run    # 只看要做什么
 *   node scripts/mirror-apk-to-hk.mjs --self-test  # 纯函数自检
 *
 * 退出码：0 成功（含「已是最新，跳过」）；非 0 失败（cron 会发告警邮件）。
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ==========================================================================
   默认值
   ========================================================================== */

/** 与 update.rs / store.js 的更新源保持一致 */
const DEFAULT_OWNER = "yykzz";
const DEFAULT_REPO = "jizhang";
const DEFAULT_TAG = "latest";

/** GitHub 仓库（构建产物的来源） */
const DEFAULT_GH_REPO = "a-zou666/jizhang";

/** APK 直链前缀：换成域名时只改这一处 */
const DEFAULT_PUBLIC_BASE = "http://104.208.75.62:9443";

/** APK 落地目录（nginx root） */
const DEFAULT_APK_DIR = "/var/www/apk";

const GITEE_API = "https://gitee.com/api/v5";
const GITHUB_API = "https://api.github.com";

/** 下载 APK 的超时（8MB 在香港机器上不到 1 秒，给 5 分钟足够宽裕） */
const DOWNLOAD_TIMEOUT_MS = 300_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** 只认这两种 ABI —— CI 也是 --target aarch64 armv7 */
const WANTED_ABIS = ["arm64", "arm"];

/* ==========================================================================
   纯函数（可单测，不碰网络/文件系统）
   ========================================================================== */

/** GitHub 资产名 → ABI。`app-arm64-release.apk` → `arm64`；认不出返回 null */
export function abiOfAsset(fileName) {
  const name = String(fileName ?? "").toLowerCase();
  if (!name.endsWith(".apk")) return null;
  if (name.includes("arm64") || name.includes("aarch64")) return "arm64";
  if (/(^|[-_.])arm([-_.]|$)/.test(name) || name.includes("armeabi")) return "arm";
  return null;
}

/** 从 GitHub Release 的 assets 里，按 ABI 各挑一个（跳过 unsigned） */
export function pickAssets(assets) {
  const picked = {};
  for (const asset of Array.isArray(assets) ? assets : []) {
    const name = String(asset?.name ?? "");
    const abi = abiOfAsset(name);
    if (!abi) continue;
    if (name.toLowerCase().includes("unsigned")) continue;
    const existing = picked[abi];
    // 已有就保留先到的，保证幂等（同名文件只会有一个）
    if (!existing) picked[abi] = { name, url: asset.browser_download_url, size: asset.size ?? 0 };
  }
  return picked;
}

/**
 * 把 GitHub 的 tag（`android-v0.1.1-55`）还原成版本号（`0.1.1`）。
 *
 * 认不出就返回空串 —— 宁可让清单 version 空着，也不要瞎猜一个错的版本号，
 * 那会让 App 的版本比较失效（可能永远提示「已是最新」或者反复提示更新）。
 */
export function versionFromTag(tag) {
  const text = String(tag ?? "").trim();
  const match = text.match(/v(\d+\.\d+\.\d+)/);
  return match ? match[1] : "";
}

/** 从 GitHub Release 对象里取「最新且可用」的那个 */
export function pickLatestRelease(releases) {
  const list = (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.draft)
    .slice()
    .sort((a, b) => String(b.published_at ?? "").localeCompare(String(a.published_at ?? "")));
  return list[0] ?? null;
}

/** 生成 App 端要读的清单。APK 地址指向本机，page_url 指向 Gitee（国内可达） */
export function buildMirrorManifest({ version, notes, publicBase, assets, owner, repo }) {
  const base = String(publicBase ?? "").replace(/\/+$/, "");
  const url = (abi) => {
    const asset = assets?.[abi];
    return asset ? `${base}/${asset.name}` : "";
  };
  return {
    schema: 1,
    version: String(version ?? "").trim(),
    notes: String(notes ?? "").trim(),
    apk: {
      arm64: url("arm64"),
      arm: url("arm"),
      universal: "",
    },
    page_url: `https://gitee.com/${owner}/${repo}/releases`,
    published_at: new Date().toISOString(),
  };
}

/** sha256（用于判断「GitHub 上的包和本地是不是同一个」） */
export function sha256Of(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/** 把 GitHub 给的 `owner/repo` 拆开（GitHub 的资产名 / 路径里常带 owner 前缀） */
export function normalizeRepo(input) {
  const text = String(input ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(text)) return null;
  const [owner, repo] = text.split("/");
  return { owner, repo };
}

/* ==========================================================================
   HTTP 助手
   ========================================================================== */

/** 把 `fetch failed` 还原出底层原因（Node 会把 ECONNRESET/超时全裹成一句） */
function describeFetchError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "请求超时";
  const cause = error?.cause;
  if (!cause) return error?.message ?? String(error);
  const code = cause.code ?? cause.errno ?? "";
  const detail = cause.message ?? cause.toString();
  return code ? `${detail}（${code}）` : detail;
}

async function githubJson(path, { token } = {}) {
  const headers = { "User-Agent": "ai-ledger-mirror", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${path} 失败（HTTP ${response.status}）：${response.statusText}`);
  }
  return response.json();
}

/**
 * 下载到 `目标文件.part`，校验通过后再 `rename` 成正式名。
 *
 * **必须走临时文件 + 原子 rename**：nginx 直接读目录，如果边下边写正式文件，
 * 用户可能下到一个「长度对但内容不完整」的 APK（装到一半报解析失败）。
 * rename 在同一文件系统上是原子的，用户要么看到旧版、要么看到完整新版。
 */
async function downloadTo(url, destPath, { expectedSize = 0 } = {}) {
  const tmpPath = `${destPath}.part`;
  const response = await fetch(url, {
    headers: { "User-Agent": "ai-ledger-mirror" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）：${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error(`下载到 0 字节：${url}`);
  if (expectedSize && buffer.length !== expectedSize) {
    throw new Error(`大小不符：拿到 ${buffer.length} 字节，GitHub 标称 ${expectedSize} 字节`);
  }
  writeFileSync(tmpPath, buffer);
  renameSync(tmpPath, destPath);
  return buffer.length;
}

/* ==========================================================================
   Gitee：只推清单
   ========================================================================== */

/**
 * 判断是不是「网络层抖动」——值得重试的错误。
 *
 * 只对连接类问题重试：Node 的 fetch 把底层网络错误裹成 `TypeError: fetch failed`
 * 并把真因塞在 `error.cause`（超时是 `UND_ERR_CONNECT_TIMEOUT`、被重置是
 * `ECONNRESET`），另外 `AbortSignal.timeout` 触发的是 `TimeoutError`。
 *
 * **4xx / 5xx 业务错误一律不重试**：令牌坏了、仓库名写错了，重试一百次也是
 * 同一个结果，只会把日志刷满、还拖慢 cron。
 */
export function isTransientNetworkError(error) {
  if (!error) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const code = error.cause?.code ?? error.code ?? "";
  if (["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN"].includes(code)) {
    return true;
  }
  // 业务错误（我们自己在 gitee() 里抛的）带 `HTTP xxx`，明确不算抖动
  return /fetch failed/i.test(error.message ?? "") && !/HTTP \d/.test(error.message ?? "");
}

/** 重试包装：指数退避（0.8s / 2.4s / 5.6s），只重试网络抖动 */
async function withRetry(fn, { attempts = 4, onRetry, label = "请求" } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientNetworkError(error)) throw error;
      const wait = Math.round(800 * 3 ** (attempt - 1));
      onRetry?.(attempt, describeFetchError(error), wait);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw new Error(`${label}失败：${describeFetchError(lastError)}`);
}

async function gitee(path, { method = "GET", token, body, form, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = new URL(`${GITEE_API}${path}`);
  const headers = { "User-Agent": "ai-ledger-mirror" };
  let payload;
  if (form) {
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
  const response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON（出错时可能是 HTML） */
  }
  if (!response.ok) {
    const detail = json?.error_description || json?.message || text.slice(0, 200) || response.statusText;
    throw new Error(`Gitee ${method} ${path} 失败（HTTP ${response.status}）：${detail}`);
  }
  return json;
}

/**
 * 把本地清单作为 Release 附件推到 Gitee。
 *
 * 和 publish-gitee-release.mjs 里的做法一致：**先删同名旧附件再传**。
 * Gitee 附件允许重名，不删的话每次发布会多一份，列表越堆越长。
 * 但这次传的只有几百字节，删+传总共一两秒。
 *
 * 整段都包了退避重试：Gitee 偶发连接超时（实测撞到过
 * `UND_ERR_CONNECT_TIMEOUT`，同一时刻 curl 却是 200），而重传几百字节
 * 几乎没成本，重试几次比让 cron 报错划算得多。
 */
async function pushManifestToGitee({ owner, repo, tag, token, manifestPath, releaseBody, branch, onRetry }) {
  const retry = { onRetry, label: "推送清单到 Gitee" };

  let releaseId = null;
  try {
    releaseId = await withRetry(async () => {
      const release = await gitee(`/repos/${owner}/${repo}/releases/tags/${tag}`, { token });
      return release?.id ?? null;
    }, retry);
  } catch {
    /* 404 说明还没建过（或刚被读失败），下面走创建分支 */
  }

  if (!releaseId) {
    const payload = { tag_name: tag, name: `${owner}/${repo} 最新版`, body: releaseBody };
    if (branch) payload.target_commitish = branch;
    const created = await withRetry(
      () => gitee(`/repos/${owner}/${repo}/releases`, { method: "POST", token, body: payload }),
      retry,
    );
    releaseId = created.id;
    console.log(`[mirror] Gitee Release #${releaseId} 已创建`);
  }

  const name = basename(manifestPath);
  const previousId = await withRetry(async () => {
    const files = await gitee(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, { token });
    return (Array.isArray(files) ? files : []).find((f) => (f.name ?? f.title) === name)?.id ?? null;
  }, retry);
  if (previousId) {
    await withRetry(
      () => gitee(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files/${previousId}`, { method: "DELETE", token }),
      retry,
    );
    console.log(`[mirror] 已删除 Gitee 上的旧 ${name}`);
  }

  // 每次尝试都要**重新构造 FormData**：FormData / Blob 是一次性的，
  // 把同一个实例重放给 fetch，某些实现下会直接失败（publish-gitee-release 踩过）。
  const body = readFileSync(manifestPath);
  await withRetry(() => {
    const form = new FormData();
    form.append("access_token", token);
    form.append("file", new Blob([body]), name);
    // 几百字节，30 秒超时绰绰有余
    return gitee(`/repos/${owner}/${repo}/releases/${releaseId}/attach_files`, {
      method: "POST",
      form,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  }, retry);
  console.log(`[mirror] 已推送 ${name} 到 Gitee（${statSync(manifestPath).size} 字节）`);
}

/* ==========================================================================
   自检
   ========================================================================== */

function selfTest() {
  const cases = [];
  const check = (name, actual, expected) => {
    cases.push({ name, ok: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
  };

  check("识别 arm64", abiOfAsset("app-arm64-release.apk"), "arm64");
  check("识别 armv7", abiOfAsset("app-arm-release.apk"), "arm");
  check("清单文件不算 APK", abiOfAsset("latest.json"), null);

  const picked = pickAssets([
    { name: "app-arm64-release-unsigned.apk", browser_download_url: "u1", size: 1 },
    { name: "app-arm64-release.apk", browser_download_url: "u2", size: 7211355 },
    { name: "app-arm-release.apk", browser_download_url: "u3", size: 5138781 },
    { name: "latest.json", browser_download_url: "u4", size: 10 },
  ]);
  check("挑出 arm64（跳过 unsigned）", picked.arm64.name, "app-arm64-release.apk");
  check("挑出 arm", picked.arm.name, "app-arm-release.apk");
  check("不会把 unsigned 也算进去", Object.keys(picked).sort(), ["arm", "arm64"]);

  check("tag 还原版本号", versionFromTag("android-v0.1.1-55"), "0.1.1");
  check("老格式 tag 也能还原", versionFromTag("v0.2.0"), "0.2.0");
  check("认不出就返回空串（不瞎猜）", versionFromTag("nightly"), "");

  const latest = pickLatestRelease([
    { tag_name: "a", published_at: "2026-01-01T00:00:00Z", draft: false },
    { tag_name: "b", published_at: "2026-03-01T00:00:00Z", draft: false },
    { tag_name: "c", published_at: "2026-04-01T00:00:00Z", draft: true },
  ]);
  check("按时间取最新且跳过 draft", latest.tag_name, "b");

  const manifest = buildMirrorManifest({
    version: "0.1.1",
    notes: "修了个 bug",
    publicBase: "http://104.208.75.62:9443/",
    assets: { arm64: { name: "app-arm64-release.apk" }, arm: { name: "app-arm-release.apk" } },
    owner: "yykzz",
    repo: "jizhang",
  });
  check("清单 arm64 指向本机", manifest.apk.arm64, "http://104.208.75.62:9443/app-arm64-release.apk");
  check("清单 arm 指向本机", manifest.apk.arm, "http://104.208.75.62:9443/app-arm-release.apk");
  check("page_url 仍指 Gitee（国内可达）", manifest.page_url, "https://gitee.com/yykzz/jizhang/releases");
  check("缺 ABI 时留空不报错", buildMirrorManifest({ version: "1", publicBase: "http://x", assets: {}, owner: "a", repo: "b" }).apk.arm, "");

  check("仓库坐标解析", normalizeRepo("a-zou666/jizhang"), { owner: "a-zou666", repo: "jizhang" });
  check("仓库坐标带空格能容错", normalizeRepo("  a-zou666/jizhang "), { owner: "a-zou666", repo: "jizhang" });
  check("非法坐标返回 null", normalizeRepo("jizhang"), null);

  // 重试判定：网络抖动要重试，业务错误（4xx/令牌坏）绝不能重试 ——
  // 后者重试一百次也是同样结果，只会刷满日志、拖慢 cron。
  check(
    "连接超时要重试（实测撞到过）",
    isTransientNetworkError(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("Connect TimeoutError"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      }),
    ),
    true,
  );
  check(
    "连接被重置要重试",
    isTransientNetworkError(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      }),
    ),
    true,
  );
  check("AbortSignal 超时要重试", isTransientNetworkError(Object.assign(new Error("x"), { name: "TimeoutError" })), true);
  check(
    "业务错误（HTTP 404）不重试",
    isTransientNetworkError(new Error("Gitee GET /repos/a/b 失败（HTTP 404）：Not Found Project")),
    false,
  );
  check(
    "业务错误（HTTP 401 坏令牌）不重试",
    isTransientNetworkError(new Error("Gitee POST /repos/a/b/releases 失败（HTTP 401）：token 无效")),
    false,
  );
  check("普通错误不重试", isTransientNetworkError(new Error("boom")), false);

  let failed = 0;
  for (const item of cases) {
    if (item.ok) console.log(`  ✓ ${item.name}`);
    else {
      failed += 1;
      console.error(`  ✗ ${item.name} → 得到 ${JSON.stringify(item.actual)}，期望 ${JSON.stringify(item.expected)}`);
    }
  }
  if (failed) {
    console.error(`[mirror] 自检失败：${cases.length - failed}/${cases.length} 通过`);
    process.exit(1);
  }
  console.log(`[mirror] 自检通过：${cases.length}/${cases.length} 个用例`);
}

/* ==========================================================================
   主流程
   ========================================================================== */

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
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
  const ghRepoRaw = (process.env.GH_REPO ?? "").trim() || DEFAULT_GH_REPO;
  const publicBase = (process.env.PUBLIC_BASE ?? "").trim() || DEFAULT_PUBLIC_BASE;
  const apkDir = resolve((process.env.APK_DIR ?? "").trim() || DEFAULT_APK_DIR);
  const force = (process.env.FORCE ?? "").trim() === "1";
  const ghToken = (process.env.GH_TOKEN ?? "").trim();
  const notes = (process.env.RELEASE_NOTES ?? "").trim();

  const ghRepo = normalizeRepo(ghRepoRaw);
  if (!ghRepo) {
    console.error(`[mirror] GH_REPO 格式不对：${ghRepoRaw}（应形如 owner/repo）`);
    process.exit(1);
  }

  console.log(`[mirror] 来源 GitHub：${ghRepo.owner}/${ghRepo.repo}`);
  console.log(`[mirror] 落地目录：${apkDir}`);
  console.log(`[mirror] 直链前缀：${publicBase}`);

  // 1) 找 GitHub 上最新的 Release
  const releases = await githubJson(`/repos/${ghRepo.owner}/${ghRepo.repo}/releases?per_page=10`, {
    token: ghToken,
  });
  const release = pickLatestRelease(releases);
  if (!release) {
    console.error("[mirror] GitHub 上没有可用的 Release");
    process.exit(1);
  }
  const version = versionFromTag(release.tag_name);
  console.log(`[mirror] 最新 Release：${release.tag_name} → 版本 ${version || "（无法解析）"}`);

  const assets = pickAssets(release.assets);
  const wanted = WANTED_ABIS.filter((abi) => assets[abi]);
  if (!wanted.length) {
    console.error(`[mirror] Release ${release.tag_name} 里没有可用的 arm64 / arm APK`);
    process.exit(1);
  }
  console.log(`[mirror] 待同步：${wanted.map((abi) => assets[abi].name).join("、")}`);

  // 2) 幂等：本机已有该版本清单且版本一致 → 跳过（除非 FORCE）
  mkdirSync(apkDir, { recursive: true });
  const manifestPath = join(apkDir, "latest.json");
  const localManifest = readFileSafe(manifestPath);
  let localVersion = "";
  try {
    localVersion = JSON.parse(localManifest)?.version ?? "";
  } catch {
    /* 旧文件坏了就重写 */
  }
  if (!force && version && localVersion === version) {
    console.log(`[mirror] 本机已是 ${version}，无需同步（FORCE=1 可强制）`);
    return;
  }

  // 3) 下载（先落 .part 再原子 rename）
  const downloaded = [];
  for (const abi of wanted) {
    const asset = assets[abi];
    const dest = join(apkDir, asset.name);
    if (dryRun) {
      console.log(`[mirror] dry-run：会下载 ${asset.name}（${(asset.size / 1024 / 1024).toFixed(2)} MB）`);
      continue;
    }
    const started = Date.now();
    const size = await downloadTo(asset.url, dest, { expectedSize: asset.size });
    const cost = ((Date.now() - started) / 1000).toFixed(1);
    const mbps = (size / 1024 / 1024 / (cost / 1000 || 1)).toFixed(1);
    console.log(`  ↓ ${asset.name}（${(size / 1024 / 1024).toFixed(2)} MB，${cost}s ≈ ${mbps} MB/s）`);
    downloaded.push({ abi, name: asset.name, path: dest, sha256: sha256Of(dest) });
  }

  // 4) 生成清单
  const manifest = buildMirrorManifest({ version, notes, publicBase, assets, owner, repo });
  if (dryRun) {
    console.log("[mirror] dry-run：清单内容如下：");
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  // 同样走原子写：nginx 可能正在读这个文件
  const manifestTmp = `${manifestPath}.part`;
  writeFileSync(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(manifestTmp, manifestPath);
  try {
    chmodSync(manifestPath, 0o644);
  } catch {
    /* 非关键 */
  }
  console.log(`[mirror] 本地清单已写入 ${manifestPath}`);

  // 5) 推清单到 Gitee
  if (!token) {
    console.log("[mirror] 未配置 GITEE_TOKEN，仅更新本机。需要在 /etc/ai-ledger-mirror.env 里配。");
    return;
  }
  const branch = await (async () => {
    try {
      const info = await gitee(`/repos/${owner}/${repo}`, {});
      return String(info?.default_branch ?? "").trim();
    } catch {
      return "";
    }
  })();
  await pushManifestToGitee({
    owner,
    repo,
    tag,
    token,
    manifestPath,
    branch,
    releaseBody:
      `本 Release 由香港中转机（${publicBase}）自动维护，只承载更新清单 latest.json。\n` +
      "\n" +
      "APK 本体不在 Gitee —— 走中转机直链（快约 12 倍），地址见 latest.json 里的 apk.arm64 / apk.arm。\n" +
      "\n" +
      "App 内的「软件更新」读这个清单，不需要翻墙。",
    onRetry: (attempt, reason, wait) => {
      console.warn(`[mirror] Gitee 抖动（${reason}），第 ${attempt} 次重试，${wait}ms 后…`);
    },
  });

  console.log(`[mirror] 完成：版本 ${version}，APK ${downloaded.length} 个，清单已上 Gitee`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[mirror] 失败：${describeFetchError(error)}`);
    process.exit(1);
  });
}
