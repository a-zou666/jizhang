#!/usr/bin/env node
/**
 * 向 tauri android init 生成的 AndroidManifest.xml 注入权限占位。
 *
 * 当前应用不再使用麦克风输入（语音录入已下线），所以这个脚本现在只是个
 * 钩子壳：保留 CLI 与自检矩阵，方便后续真要加权限时直接在这里挂上。
 *
 * 用法：
 *   node scripts/inject-android-permissions.mjs [manifestPath]
 *   node scripts/inject-android-permissions.mjs --check
 *   node scripts/inject-android-permissions.mjs --self-test
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST = resolve(
  HERE,
  "..",
  "src-tauri",
  "gen",
  "android",
  "app",
  "src",
  "main",
  "AndroidManifest.xml",
);

/** 必须声明的权限，顺序即写入顺序 */
export const REQUIRED_PERMISSIONS = [];

const MANIFEST_OPEN = /<manifest\b[^>]*>/;

/** 去掉 XML 注释，避免把注释里的权限当成已声明 */
function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

/** 是否已在清单里声明（容忍单/双引号与多余空格） */
function hasPermission(xml, name) {
  const pattern = new RegExp(
    `android:name\\s*=\\s*["']${name.replace(/\./g, "\\.")}["']`,
  );
  return pattern.test(stripComments(xml));
}

/** 推断缩进：取 <manifest> 后面第一行有内容的行的前导空白 */
function detectIndent(xml, afterIndex) {
  const rest = xml.slice(afterIndex);
  const line = rest.split(/\r?\n/).find((l) => l.trim().length > 0);
  const indent = line?.match(/^[ \t]*/)?.[0] ?? "";
  return indent.length ? indent : "    ";
}

/**
 * 纯函数：返回注入后的清单文本。
 * @returns {{ text: string, added: string[], alreadyPresent: string[] }}
 */
export function injectPermissions(xml) {
  const absent = REQUIRED_PERMISSIONS.filter((n) => !hasPermission(xml, n));
  const alreadyPresent = REQUIRED_PERMISSIONS.filter((n) => hasPermission(xml, n));

  if (!absent.length) return { text: xml, added: [], alreadyPresent };

  const open = MANIFEST_OPEN.exec(xml);
  if (!open) {
    throw new Error("未匹配到 <manifest ...> 起始标签，无法注入权限");
  }

  const eol = xml.includes("\r\n") ? "\r\n" : "\n";
  const indent = detectIndent(xml, open.index + open[0].length);
  const block = absent
    .map((name) => `${indent}<uses-permission android:name="${name}" />`)
    .join(eol);

  const insertAt = open.index + open[0].length;
  // 起始标签后若已有换行，就接在该换行之后，避免和后续内容挤在一行
  const tailMatch = /^[ \t]*\r?\n/.exec(xml.slice(insertAt));
  const cut = tailMatch ? insertAt + tailMatch[0].length : insertAt;
  const prefix = xml.slice(0, cut);
  const suffix = xml.slice(cut);
  const text = prefix + block + eol + suffix;

  return { text, added: absent, alreadyPresent };
}

/** 简单校验：权限必须在 <application> 之前声明 */
function validate(xml) {
  const problems = [];
  const applicationIndex = xml.indexOf("<application");
  const body = stripComments(xml);
  for (const name of REQUIRED_PERMISSIONS) {
    const pattern = new RegExp(
      `android:name\\s*=\\s*["']${name.replace(/\./g, "\\.")}["']`,
    );
    const match = pattern.exec(body);
    if (!match) {
      problems.push(`${name} 未在清单中声明`);
      continue;
    }
    if (applicationIndex !== -1 && match.index > applicationIndex) {
      problems.push(`${name} 声明在 <application> 之后`);
    }
  }
  if (!MANIFEST_OPEN.test(xml)) problems.push("清单缺少 <manifest> 根标签");
  return problems;
}

/* ------------------------------------------------------------------ *
 * 自检：REQUIRED_PERMISSIONS 为空时，脚本应当原样返回
 * ------------------------------------------------------------------ */
const SELF_TEST_CASES = [
  {
    name: "空权限列表 → 幂等，零改动",
    input: [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">`,
      `    <application android:label="app">`,
      `    </application>`,
      `</manifest>`,
      ``,
    ].join("\n"),
    expectAdded: 0,
    expectIdempotent: true,
  },
  {
    name: "CRLF 换行原样保留",
    input: [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">`,
      `    <application android:label="app">`,
      `    </application>`,
      `</manifest>`,
      ``,
    ].join("\r\n"),
    expectAdded: 0,
    expectEol: "\r\n",
  },
  {
    name: "带 UTF-8 BOM",
    input:
      "\uFEFF<?xml version=\"1.0\" encoding=\"utf-8\"?>\n" +
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n` +
      `    <application />\n</manifest>\n`,
    expectAdded: 0,
    expectBom: true,
  },
];

function selfTest() {
  let passed = 0;
  const failures = [];

  for (const testCase of SELF_TEST_CASES) {
    const label = testCase.name;
    let result;
    try {
      result = injectPermissions(testCase.input);
    } catch (error) {
      failures.push(`${label} → 抛错：${error.message}`);
      continue;
    }
    const { text, added } = result;
    const problems = [];

    if (added.length !== testCase.expectAdded) {
      problems.push(`新增 ${added.length} 条，期望 ${testCase.expectAdded} 条`);
    }
    problems.push(...validate(text));

    if (testCase.expectIdempotent) {
      const again = injectPermissions(text);
      if (again.text !== text) problems.push("重复运行产生了改动（非幂等）");
    }
    if (testCase.expectEol && !text.includes(testCase.expectEol)) {
      problems.push(`未保留换行风格 ${JSON.stringify(testCase.expectEol)}`);
    }
    if (testCase.expectBom && !text.startsWith("\uFEFF")) {
      problems.push("丢失 UTF-8 BOM");
    }
    if (testCase.expectKeeps && !text.includes(testCase.expectKeeps)) {
      problems.push("改动破坏了已有内容");
    }
    if (testCase.expectAdded > 0) {
      // 注入后的权限必须都排在 <application> 之前
      const appIndex = text.indexOf("<application");
      for (const name of REQUIRED_PERMISSIONS) {
        const idx = text.indexOf(`android:name="${name}"`);
        if (idx === -1) problems.push(`${name} 注入后找不到`);
        else if (appIndex !== -1 && idx > appIndex) {
          problems.push(`${name} 落在了 <application> 之后`);
        }
      }
    }

    if (problems.length) failures.push(`${label} → ${problems.join("；")}`);
    else passed += 1;
  }

  for (const failure of failures) console.error(`  ✗ ${failure}`);
  if (failures.length) {
    console.error(
      `[android-permissions] 自检失败：${passed}/${SELF_TEST_CASES.length} 通过`,
    );
    process.exit(1);
  }
  console.log(
    `[android-permissions] 自检通过：${passed}/${SELF_TEST_CASES.length} 个用例`,
  );
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const checkOnly = argv.includes("--check");
  const pathArg = argv.find((a) => !a.startsWith("--"));
  const manifestPath = resolve(pathArg ?? DEFAULT_MANIFEST);

  if (!existsSync(manifestPath)) {
    console.error(`[android-permissions] 找不到清单文件：${manifestPath}`);
    console.error("[android-permissions] 请先执行 `npm run tauri android init`。");
    process.exit(1);
  }

  const original = readFileSync(manifestPath, "utf8");
  const originalProblems = validate(original);

  if (checkOnly) {
    if (originalProblems.length) {
      for (const problem of originalProblems) {
        console.error(`  ✗ ${problem}`);
      }
      console.error(
        "[android-permissions] 检查失败：请运行 node scripts/inject-android-permissions.mjs",
      );
      process.exit(1);
    }
    console.log("[android-permissions] 检查通过：当前没有需要注入的权限。");
    return;
  }

  let result;
  try {
    result = injectPermissions(original);
  } catch (error) {
    console.error(`[android-permissions] ${error.message}`);
    console.error(original.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  }

  const { text, added, alreadyPresent } = result;

  if (!added.length) {
    console.log("[android-permissions] 当前没有需要注入的权限（REQUIRED_PERMISSIONS 为空）。");
    return;
  }

  const problems = validate(text);
  if (problems.length) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error("[android-permissions] 校验失败，未写入文件。");
    process.exit(1);
  }

  writeFileSync(manifestPath, text, "utf8");
  console.log(`[android-permissions] 已写入 ${manifestPath}`);
  for (const name of result.added) console.log(`  + ${name}`);
  for (const name of alreadyPresent) console.log(`  = ${name}（已存在）`);
  console.log("[android-permissions] 校验通过。");
}

// 只有被直接执行时才跑 CLI（被 import 时保持纯函数可用）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
