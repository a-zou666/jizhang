#!/usr/bin/env node
/**
 * 给 `tauri android build` 产出的 APK 签名（zipalign → apksigner）。
 *
 * 为什么需要这个脚本：Tauri 生成的 `src-tauri/gen/android/app/build.gradle.kts`
 * 里根本没有 `signingConfigs`，release 变体没有签名配置，Gradle 就只会产出
 * `app-<abi>-release-unsigned.apk` —— 名字里的 unsigned 就是这么来的。
 * 生成的工程每次 `tauri android init` 都会重建，所以不在 gen/ 里手改，
 * 而是在构建完成后对产物签名（和 inject-android-permissions.mjs 一个思路）。
 *
 * 环境变量（由 GitHub Actions 从 Secrets 注入）：
 *   KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD
 * 四个里缺任何一个 → 打印说明并原样退出 0（CI 不会红，只是继续出未签名包）。
 *
 * 用法：
 *   node scripts/sign-android-apk.mjs
 *   node scripts/sign-android-apk.mjs --self-test
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APK_DIR = resolve(HERE, "..", "src-tauri", "gen", "android", "app", "build", "outputs", "apk");

/** apksigner 读不出清单时的兜底 minSdk（Android 7.0，和 Tauri 默认一致） */
const MIN_SDK_FALLBACK = 24;

/** build-tools 目录下挑版本号最高的那个（35.0.0 > 34.0.0 > 30.0.3） */
export function versionKey(name) {
  const parts = String(name)
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  return parts.map((n) => (Number.isFinite(n) ? n : 0));
}

export function compareVersions(a, b) {
  const left = versionKey(a);
  const right = versionKey(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 从 build-tools 的目录名里选出最新版本的目录名 */
export function pickLatestBuildTool(names) {
  const usable = (names ?? []).filter((name) => /^\d+(?:\.\d+)*$/.test(String(name)));
  if (!usable.length) return null;
  return usable.slice().sort(compareVersions).at(-1);
}

/** `xxx-release-unsigned.apk` → `xxx-release.apk`（已经没有 -unsigned 就加 .signed） */
export function signedName(name) {
  if (name.includes("-unsigned")) return name.replace("-unsigned", "");
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}.signed${name.slice(dot)}` : `${name}.signed`;
}

/** 递归找出所有 .apk */
function findApks(dir) {
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

function findBuildTools() {
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!root) return null;
  const dir = join(root, "build-tools");
  if (!existsSync(dir)) return null;
  const version = pickLatestBuildTool(readdirSync(dir));
  return version ? join(dir, version) : null;
}

function run(bin, args, env) {
  return execFileSync(bin, args, { stdio: "pipe", env: { ...process.env, ...env } });
}

/* ------------------------------------------------------------------ *
 * 自检
 * ------------------------------------------------------------------ */
function selfTest() {
  const cases = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    cases.push({ name, ok, actual, expected });
  };

  check("挑最新 build-tools（乱序）", pickLatestBuildTool(["30.0.3", "35.0.0", "34.0.0"]), "35.0.0");
  check("挑最新 build-tools（rc 目录跳过）", pickLatestBuildTool(["35.0.0-rc1"]), null);
  check("挑最新 build-tools（空）", pickLatestBuildTool([]), null);
  check("版本号比较 35 > 34", Math.sign(compareVersions("35.0.0", "34.0.0")), 1);
  check("版本号比较 位数不同", Math.sign(compareVersions("35", "34.9.9")), 1);
  check(
    "签名后文件名去掉 -unsigned",
    signedName("app-arm64-release-unsigned.apk"),
    "app-arm64-release.apk",
  );
  check(
    "没有 -unsigned 时另起名",
    signedName("app-arm64-release.apk"),
    "app-arm64-release.signed.apk",
  );

  let failed = 0;
  for (const item of cases) {
    if (item.ok) {
      console.log(`  ✓ ${item.name}`);
    } else {
      failed += 1;
      console.error(`  ✗ ${item.name} → 得到 ${JSON.stringify(item.actual)}，期望 ${JSON.stringify(item.expected)}`);
    }
  }
  if (failed) {
    console.error(`[sign-apk] 自检失败：${cases.length - failed}/${cases.length} 通过`);
    process.exit(1);
  }
  console.log(`[sign-apk] 自检通过：${cases.length}/${cases.length} 个用例`);
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const secrets = {
    base64: (process.env.KEYSTORE_BASE64 ?? "").trim(),
    storePassword: process.env.KEYSTORE_PASSWORD ?? "",
    alias: (process.env.KEY_ALIAS ?? "").trim(),
    keyPassword: process.env.KEY_PASSWORD ?? "",
  };
  const hasSecrets = Object.values(secrets).every((value) => String(value).length > 0);

  const apks = findApks(APK_DIR);
  if (!apks.length) {
    console.error(`[sign-apk] 没找到 APK（${APK_DIR}），先跑构建`);
    process.exit(1);
  }

  if (!hasSecrets) {
    console.log("[sign-apk] 未提供签名密钥，跳过签名 —— 产物仍是未签名 APK。");
    console.log("[sign-apk] 需要 4 个 Secrets：KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD");
    for (const apk of apks) console.log(`  = ${basename(apk)}（未签名）`);
    return;
  }

  const tools = findBuildTools();
  if (!tools) {
    console.error("[sign-apk] 找不到 build-tools（zipalign / apksigner），检查 ANDROID_HOME");
    process.exit(1);
  }
  const zipalign = join(tools, process.platform === "win32" ? "zipalign.exe" : "zipalign");
  const apksigner = join(tools, process.platform === "win32" ? "apksigner.bat" : "apksigner");

  const tmp = join(APK_DIR, ".sign-tmp");
  mkdirSync(tmp, { recursive: true });
  const keystore = join(tmp, "upload-keystore.jks");
  writeFileSync(keystore, Buffer.from(secrets.base64.replace(/\s+/g, ""), "base64"));

  // 密码走 env: 前缀，不出现在命令行里
  const signEnv = {
    KS_STORE_PASSWORD: secrets.storePassword,
    KS_KEY_PASSWORD: secrets.keyPassword,
  };

  for (const apk of apks) {
    const name = basename(apk);
    const aligned = join(tmp, `aligned-${name}`);
    const out = join(dirname(apk), signedName(name));

    run(zipalign, ["-p", "-f", "4", apk, aligned]);
    // apksigner 会自己从 AndroidManifest 里读 minSdkVersion；万一读不出来
    // （清单被加固 / 异常打包）就用 --min-sdk-version 兜底，避免整个构建挂掉
    run(
      apksigner,
      [
        "sign",
        "--ks", keystore,
        "--ks-key-alias", secrets.alias,
        "--ks-pass", "env:KS_STORE_PASSWORD",
        "--key-pass", "env:KS_KEY_PASSWORD",
        "--min-sdk-version", String(MIN_SDK_FALLBACK),
        "--out", out,
        aligned,
      ],
      signEnv,
    );
    rmSync(apk, { force: true });
    rmSync(aligned, { force: true });

    const cert = run(apksigner, ["verify", "--print-certs", out]).toString();
    const sha256 = /SHA-256\s*:\s*([0-9a-fA-F:]+)/.exec(cert)?.[1] ?? "?";
    console.log(`  ✓ ${basename(out)} 已签名（证书 SHA-256: ${sha256.slice(0, 32)}…）`);
  }

  rmSync(tmp, { recursive: true, force: true });
  console.log(`[sign-apk] 完成：${apks.length} 个 APK 已签名（v1 + v2）`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
