#!/usr/bin/env node
/**
 * APK 中转同步：GitHub Release → 本机 nginx（HTTPS）→ App 直接从这里取。
 *
 * ## 为什么需要这个脚本
 *
 * 两条实测结论（2026-10-09，香港 Azure 机器）：
 *
 * 1. **Gitee 的附件上传慢得没法用** —— 香港传 Gitee 只有 30~50 KB/s
 *    （传 GitHub 有 876 KB/s，从 Gitee **下载**也有 463 KB/s）。慢的是 Gitee
 *    的附件服务本身，不是跨境。
 *
 * 2. **Gitee 的附件下载链路又长又脆** —— 读一个清单要两级 302：
 *      gitee.com/.../releases/download/latest/latest.json
 *        └─302─> gitee.com/yykzz/jizhang/attach_files/<id>/download/latest.json
 *            └─302─> foruda.gitee.com/attach_file/<id>/latest.json?token=…&ts=…
 *    最终落在一个**带临时 token 的 CDN 域名**上。手机走移动网络时这条链路
 *    经常超时，表现为 App「点了检查更新但检测不到新版本」。
 *
 * 于是彻底不用 Gitee：
 *
 *   GitHub Actions ──5MB/s──> GitHub Release（只存构建产物）
 *                                    │ 本脚本下载（174MB/s 下行）
 *                                    ▼
 *                      本机 /var/www/apk + nginx（HTTPS，43MB/s 上行）
 *                                    │
 *                                    ▼
 *              App 读 /latest.json，APK 从同一域名下（一条链路，一个证书）
 *
 * App 端 `MANIFEST_URL` 与 `DOWNLOAD_PREFIX` 都指向本机域名，全程 HTTPS。
 *
 * ## 环境变量
 *
 *   GH_REPO      可选，默认 a-zou666/jizhang（GitHub 仓库坐标）
 *   PUBLIC_BASE  可选，默认 https://apk.xn--wnyy6w.tech（对外地址前缀）
 *   APK_DIR      可选，默认 /var/www/apk
 *   FORCE        设 1 时即使版本没变也重新同步
 *   GH_TOKEN     可选，GitHub API 令牌（提一下速率限制，匿名也够用）
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
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/* ==========================================================================
   默认值
   ========================================================================== */

/** GitHub 仓库（构建产物的来源） */
const DEFAULT_GH_REPO = "a-zou666/jizhang";

/**
 * 对外地址前缀。清单与 APK 都从这里取。
 *
 * 用域名 + HTTPS 而不是裸 IP + HTTP，原因是 **Android 7+ 默认禁止明文 HTTP**
 * （`cleartextTrafficPermitted` 默认 false），用 `http://` 的清单地址会被系统
 * 直接拦掉；要放行得改 AndroidManifest（而 `src-tauri/gen/` 不入库，每次 CI
 * 都要重新注入，很脆 —— 麦克风权限已经吃过这个亏）。加个域名走 HTTPS 全解决。
 *
 * 域名是中文的 `电脑.tech`，punycode 为 `xn--wnyy6w.tech`。这里**写 punycode**：
 * 部分运行时对 IDN 的处理不一致，写死了最稳。
 */
const DEFAULT_PUBLIC_BASE = "https://apk.xn--wnyy6w.tech";

/** APK 落地目录（nginx root） */
const DEFAULT_APK_DIR = "/var/www/apk";

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

/** 生成 App 端要读的清单。APK 地址与 page_url 都指向本机域名 */
export function buildMirrorManifest({ version, notes, publicBase, assets }) {
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
    // 发布页也指本机：Gitee 整条链路已弃用，兜底不该再把人引过去
    page_url: `${base}/`,
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
   网络重试
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
  // 业务错误（我们自己在请求里抛的）带 `HTTP xxx`，明确不算抖动
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
    publicBase: "https://apk.xn--wnyy6w.tech/",
    assets: { arm64: { name: "app-arm64-release.apk" }, arm: { name: "app-arm-release.apk" } },
  });
  check("清单 arm64 指向本机", manifest.apk.arm64, "https://apk.xn--wnyy6w.tech/app-arm64-release.apk");
  check("清单 arm 指向本机", manifest.apk.arm, "https://apk.xn--wnyy6w.tech/app-arm-release.apk");
  check("page_url 也指本机（不再引向 Gitee）", manifest.page_url, "https://apk.xn--wnyy6w.tech/");
  check("清单里不该出现 gitee", JSON.stringify(manifest).includes("gitee"), false);
  check("缺 ABI 时留空不报错", buildMirrorManifest({ version: "1", publicBase: "https://x", assets: {} }).apk.arm, "");

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
    isTransientNetworkError(new Error("GitHub /repos/a/b 失败（HTTP 404）：Not Found")),
    false,
  );
  check(
    "业务错误（HTTP 401 坏令牌）不重试",
    isTransientNetworkError(new Error("GitHub /repos/a/b 失败（HTTP 401）：Bad credentials")),
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
  const manifest = buildMirrorManifest({ version, notes, publicBase, assets });
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

  // 到这里就完事了 —— 清单和 APK 都在同一台机器上由 nginx 提供，
  // 不需要再往任何第三方（Gitee）推东西。App 拉清单和下载 APK 走同一个域名。
  console.log(`[mirror] 完成：版本 ${version}，APK ${downloaded.length} 个`);
  console.log(`[mirror] 清单地址：${publicBase}/latest.json`);
  for (const item of downloaded) console.log(`[mirror]   APK：${publicBase}/${item.name}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`[mirror] 失败：${describeFetchError(error)}`);
    process.exit(1);
  });
}
