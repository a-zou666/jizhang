#!/usr/bin/env node
/**
 * 向 tauri android init 生成的工程注入自定义 MainActivity.kt，
 * 把 Android 系统栏 / 刘海的高度桥接进 WebView 的 CSS 变量。
 *
 * 为什么需要：Android 的 WebView 不支持 env(safe-area-inset-top)（永远是 0），
 * 而 Tauri 默认 edge-to-edge，页面内容会顶进状态栏和刘海。
 * 本脚本覆盖默认的 MainActivity，在原生层读取 WindowInsets，
 * 把像素写进 :root 的 --safe-area-top / --safe-area-bottom。
 *
 * 用法：
 *   node scripts/inject-safe-area.mjs          # 写入（需先 tauri android init）
 *   node scripts/inject-safe-area.mjs --check  # 校验已注入
 *   node scripts/inject-safe-area.mjs --self-test
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const CONF = JSON.parse(readFileSync(resolve(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));

/** com.azhou.ai-ledger -> com/azhou/ai_ledger（段内非法字符替换为下划线） */
function packagePathOf(identifier) {
  return identifier
    .split(".")
    .map((segment) => {
      const sanitized = segment.replace(/[^A-Za-z0-9_]/g, "_");
      return /^[0-9]/.test(sanitized) ? `_${sanitized}` : sanitized;
    })
    .join("/");
}

const IDENTIFIER = CONF.identifier ?? "";
if (!IDENTIFIER) {
  console.error("tauri.conf.json 缺少 identifier");
  process.exit(1);
}

const PKG = packagePathOf(IDENTIFIER);
const JAVA_DIR = resolve(ROOT, "src-tauri", "gen", "android", "app", "src", "main", "java", PKG);
const MAIN_ACTIVITY = join(JAVA_DIR, "MainActivity.kt");

const MARKER = "SAFE-AREA-BRIDGE";

const TEMPLATE = `package ${PKG.replaceAll("/", ".")}

import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.WebView

/**
 * ${MARKER}：由 scripts/inject-safe-area.mjs 注入。
 *
 * Android 的 WebView 不支持 env(safe-area-inset-top)（永远是 0），而 App 是
 * edge-to-edge 全屏，页面会顶进状态栏和刘海。这里在原生层读取 WindowInsets，
 * 把像素值写进 WebView 里 :root 的 --safe-area-top / --safe-area-bottom，
 * 页面布局照常使用这两个变量，不需要任何 Web 侧适配。
 */
class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // WebView 由 wry 异步创建，轮询等它出现（约最多 15 秒）
    pollWebView(0)
  }

  private fun pollWebView(attempt: Int) {
    if (attempt > 60) return
    val root = findViewById<ViewGroup>(android.R.id.content)
    val found = root?.let { findWebView(it) }
    if (found == null) {
      root?.postDelayed({ pollWebView(attempt + 1) }, 250)
      return
    }
    webView = found
    bindInsets(found)
  }

  private fun findWebView(group: ViewGroup): WebView? {
    for (i in 0 until group.childCount) {
      val child = group.getChildAt(i)
      if (child is WebView) return child
      if (child is ViewGroup) findWebView(child)?.let { return it }
    }
    return null
  }

  private fun bindInsets(view: WebView) {
    view.setOnApplyWindowInsetsListener { _, insets ->
      dispatchInsets(insets)
      insets
    }
    view.requestApplyInsets()
    // 页面在 WebView 就绪之后才开始加载；多补几次注入，
    // 保证页面 documentElement 就绪后至少命中一次
    for (delayMs in longArrayOf(600, 1500, 3000, 5000, 8000)) {
      view.postDelayed({ view.requestApplyInsets() }, delayMs)
    }
  }

  private fun dispatchInsets(insets: WindowInsets) {
    val top: Int
    val bottom: Int
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val bars = insets.getInsets(
        WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout(),
      )
      top = bars.top
      bottom = bars.bottom
    } else {
      @Suppress("DEPRECATION")
      top = insets.systemWindowInsetTop
      @Suppress("DEPRECATION")
      bottom = insets.systemWindowInsetBottom
    }
    val js = "window.__safeInsets={top:\${top},bottom:\${bottom}};" +
      "try{document.documentElement.style.setProperty('--safe-area-top','\${top}px');" +
      "document.documentElement.style.setProperty('--safe-area-bottom','\${bottom}px');}catch(e){}"
    webView?.evaluateJavascript(js, null)
  }
}
`;

function inject() {
  if (!existsSync(resolve(ROOT, "src-tauri", "gen", "android"))) {
    console.error("还没初始化 Android 工程：先运行 npm run tauri android init");
    process.exit(1);
  }
  mkdirSync(JAVA_DIR, { recursive: true });
  writeFileSync(MAIN_ACTIVITY, TEMPLATE);
  console.log(`已写入 ${MAIN_ACTIVITY}（包 ${PKG.replaceAll("/", ".")}）`);
}

function check() {
  if (!existsSync(MAIN_ACTIVITY)) {
    console.error(`--check 失败：${MAIN_ACTIVITY} 不存在`);
    process.exit(1);
  }
  const source = readFileSync(MAIN_ACTIVITY, "utf8");
  const required = [MARKER, "safe-area-top", "TauriActivity", `package ${PKG.replaceAll("/", ".")}`];
  const missing = required.filter((token) => !source.includes(token));
  if (missing.length) {
    console.error(`--check 失败：MainActivity.kt 缺少 ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("safe-area 桥接已注入：MainActivity.kt 存在且包含所需逻辑");
}

function selfTest() {
  const required = ["package com.azhou.ai_ledger", MARKER, "WindowInsets", "evaluateJavascript"];
  const missing = required.filter((token) => !TEMPLATE.includes(token));
  if (missing.length) fail(`模板缺少 ${missing.join(", ")}`);
  ok(`MainActivity 模板完整（含 ${required.length} 项关键内容）`);

  if (packagePathOf("com.azhou.ai-ledger") !== "com/azhou/ai_ledger") {
    fail("包名推导错误");
  }
  if (packagePathOf("com.example.app") !== "com/example/app") {
    fail("普通包名推导错误");
  }
  ok("包名推导正确（含 - 转 _ 的场景）");
}

/* ---------------- 测试骨架 ---------------- */
let failed = false;
function ok(message) {
  console.log(`  ✓ ${message}`);
}
function fail(message) {
  failed = true;
  console.error(`  ✗ ${message}`);
}

const mode = process.argv[2];
if (mode === "--check") check();
else if (mode === "--self-test") {
  selfTest();
  process.exit(failed ? 1 : 0);
} else inject();
