/**
 * 版本号递增脚本 —— 一个命令改完两处，不用手抄。
 *
 * ## 为什么要有这个脚本
 *
 * 版本号在仓库里出现在**两个文件**，而且必须同步：
 *
 *   1. `package.json` 的 `version` —— **唯一的权威来源**。
 *      `src-tauri/tauri.conf.json` 里 `"version": "../package.json"` 指向它，
 *      所以 APK 的 versionName 就是它；Vite 也把它注入前端
 *      （`__APP_VERSION__` → `store.js` 的 `APP_VERSION` → 设置页显示）。
 *   2. `src-tauri/Cargo.toml` 的 `version` —— 只是 Rust crate 自己的版本，
 *      不进 APK，但**不跟着改会让人以为有两套版本号**。
 *
 * 手改的问题是「改了一个忘了另一个」，而症状是**界面显示 0.1.7、Cargo 里还是 0.1.6**
 * —— 平时看不出来，排查起来莫名其妙。所以交给脚本一次改完。
 *
 * 另外 `package-lock.json` 里**没有**版本号（本项目 lock 文件不含 root version），
 * 所以不用管它。
 *
 * ## 用法
 *
 *   node scripts/bump-version.mjs            # 最后一段 +1（0.1.6 → 0.1.7）
 *   node scripts/bump-version.mjs 0.2.0      # 指定版本
 *   node scripts/bump-version.mjs --dry-run  # 只看会改成什么
 *   node scripts/bump-version.mjs --self-test
 *
 * 退出码：0 成功；非 0 失败。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 版本号出现的两个文件（相对仓库根） */
export const VERSION_FILES = {
  packageJson: "package.json",
  cargoToml: "src-tauri/Cargo.toml",
};

/**
 * 把版本号的最后一段 +1。
 *
 * 只认 `x.y.z` 三段（本项目一直这么用）。故意**不做**「段数自动补齐」之类的智能 ——
 * 版本号是要人看的，猜错了比报错更烦。非法输入直接抛错。
 */
export function nextVersion(current) {
  const text = String(current ?? "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) {
    throw new Error(`版本号格式不对：${JSON.stringify(current)}（应为 x.y.z，例如 0.1.6）`);
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

/** 用户手填的版本号也要校验 —— 同一套规则，别放过非法值 */
export function assertValidVersion(version) {
  const text = String(version ?? "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(text)) {
    throw new Error(`版本号格式不对：${JSON.stringify(version)}（应为 x.y.z）`);
  }
  return text;
}

/**
 * 读出两个文件里当前的版本号，并**断言它们一致**。
 *
 * 不一致说明上一次 bump 没跑完（或有人手改了其中一个）—— 这时候直接停，
 * 而不是在错的基础上继续 +1，否则两处会越差越远。
 */
export function readVersions({ readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const pkg = JSON.parse(readFile(join(ROOT, VERSION_FILES.packageJson)));
  const cargoText = readFile(join(ROOT, VERSION_FILES.cargoToml));
  // Cargo.toml 里 `[package]` 的 version 是**第一个**顶格 `version = "..."`；
  // `[dependencies]` 下的都是 `tauri = { version = ...` 这种带等号前空格的写法，不会误伤。
  const cargoMatch = /^version\s*=\s*"([^"]+)"/m.exec(cargoText);
  if (!cargoMatch) {
    throw new Error(`在 ${VERSION_FILES.cargoToml} 里找不到顶格的 version = "..." 行`);
  }
  return { packageJson: pkg.version, cargoToml: cargoMatch[1] };
}

/** 生成改好版本号的文件内容（纯字符串替换，保持原有排版与注释） */
export function applyVersionToPackageJson(original, version) {
  const parsed = JSON.parse(original);
  parsed.version = version;
  // 保留 2 空格缩进 + 行尾换行，和仓库里其它 json 一致
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function applyVersionToCargoToml(original, version) {
  // 只替换**顶格**那一行（`^version`），别碰依赖里的 `version = ` 写法
  return original.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`);
}

/* ==========================================================================
   自检
   ========================================================================== */

function selfTest() {
  let passed = 0;
  const failures = [];
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (ok) {
      passed += 1;
    } else {
      failures.push(`  ✗ ${label}\n      实际：${JSON.stringify(actual)}\n      期望：${JSON.stringify(expected)}`);
    }
  };
  const throws = (label, fn) => {
    try {
      fn();
      failures.push(`  ✗ ${label} —— 本该抛错却通过了`);
    } catch {
      passed += 1;
    }
  };

  // 递增：只动最后一段，不碰前两段（0.1.9 → 0.1.10 不是 0.2.0）
  check("0.1.6 → 0.1.7", nextVersion("0.1.6"), "0.1.7");
  check("0.1.9 → 0.1.10", nextVersion("0.1.9"), "0.1.10");
  check("0.9.99 → 0.9.100", nextVersion("0.9.99"), "0.9.100");
  check("1.0.0 → 1.0.1", nextVersion("1.0.0"), "1.0.1");
  check("前后空白能容错", nextVersion("  0.1.6  "), "0.1.7");
  // 非法输入直接抛，不猜
  throws("两段的 0.1 要抛错", () => nextVersion("0.1"));
  throws("带 v 前缀要抛错（版本号本身不带 v）", () => nextVersion("v0.1.6"));
  throws("空串要抛错", () => nextVersion(""));
  throws("null 要抛错", () => nextVersion(null));

  // 手填版本号的校验
  check("合法版本号原样返回", assertValidVersion(" 0.2.0 "), "0.2.0");
  throws("手填 0.2 也要抛错", () => assertValidVersion("0.2"));

  // 替换逻辑：只改该改的地方
  const cargo = [
    "[package]",
    'name = "ai-ledger"',
    'version = "0.1.6"',
    "",
    "[dependencies]",
    '# taureqwest 的 version 出现在注释里，不能被替换',
    'tauri = { version = "2.0.0", features = [] }',
    'reqwest = { version = "0.12", default-features = false }',
  ].join("\n");
  const newCargo = applyVersionToCargoToml(cargo, "0.1.7");
  check("Cargo.toml：顶格 version 被改", /^version = "0\.1\.7"$/m.test(newCargo), true);
  check("Cargo.toml：依赖里的 tauri 版本没被动", newCargo.includes('tauri = { version = "2.0.0"'), true);
  check("Cargo.toml：依赖里的 reqwest 版本没被动", newCargo.includes('reqwest = { version = "0.12"'), true);
  check("Cargo.toml：注释没被动", newCargo.includes("不能被替换"), true);
  check("Cargo.toml：行数不变", newCargo.split("\n").length, cargo.split("\n").length);

  const pkg = '{\n  "name": "jizhang",\n  "version": "0.1.6",\n  "type": "module"\n}\n';
  const newPkg = applyVersionToPackageJson(pkg, "0.1.7");
  check("package.json：版本被改", JSON.parse(newPkg).version, "0.1.7");
  check("package.json：其它字段保留", JSON.parse(newPkg).name, "jizhang");
  check("package.json：缩进是 2 空格", newPkg.includes('\n  "name"'), true);
  check("package.json：以换行结尾", newPkg.endsWith("\n"), true);

  // 真实文件读一遍：两个来源必须一致，且能正常解析
  const versions = readVersions();
  check("真实仓库里两个版本号一致", versions.packageJson, versions.cargoToml);
  check("真实版本号是 x.y.z", /^\d+\.\d+\.\d+$/.test(versions.packageJson), true);

  if (failures.length) {
    console.error("自检失败：\n" + failures.join("\n"));
    process.exit(1);
  }
  console.log(`[bump] 自检通过：${passed}/${passed} 个用例`);
}

/* ==========================================================================
   主流程
   ========================================================================== */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const dryRun = argv.includes("--dry-run");
  const explicit = argv.find((arg) => !arg.startsWith("-"));

  const current = readVersions();
  if (current.packageJson !== current.cargoToml) {
    console.error(
      `[bump] 两处版本号不一致，先修好再 bump：\n` +
        `  ${VERSION_FILES.packageJson}: ${current.packageJson}\n` +
        `  ${VERSION_FILES.cargoToml}: ${current.cargoToml}`
    );
    process.exit(1);
  }

  const target = explicit ? assertValidVersion(explicit) : nextVersion(current.packageJson);
  console.log(`[bump] ${current.packageJson} → ${target}`);

  if (dryRun) {
    console.log("[bump] dry-run：没有写入任何文件");
    return;
  }

  const pkgPath = join(ROOT, VERSION_FILES.packageJson);
  const cargoPath = join(ROOT, VERSION_FILES.cargoToml);
  writeFileSync(pkgPath, applyVersionToPackageJson(readFileSync(pkgPath, "utf8"), target), "utf8");
  writeFileSync(cargoPath, applyVersionToCargoToml(readFileSync(cargoPath, "utf8"), target), "utf8");

  // 写完立刻回读校验 —— 别信「我以为写成功了」
  const after = readVersions();
  if (after.packageJson !== target || after.cargoToml !== target) {
    console.error(`[bump] 写入后校验失败：${JSON.stringify(after)}`);
    process.exit(1);
  }
  console.log(`[bump] 已写入：${VERSION_FILES.packageJson}、${VERSION_FILES.cargoToml}`);
  console.log(`[bump] 下一步：git add -A && git commit && git push（CI 会自动构建发布）`);
}

main();
