#!/usr/bin/env node
/**
 * 本地预览服务器（零依赖）
 *
 * src/ 没有构建步骤，但 index.html 用的是 `<script type="module">`，
 * 直接 file:// 打开会被浏览器的模块 CORS 策略挡住（Failed to load module script），
 * 所以给一条命令：
 *
 *   npm run preview          # → http://127.0.0.1:4173
 *   npm run preview -- 8080  # 换个端口
 *
 * 没有 Tauri 后端时 bridge.js 会自动回退到 mock.js，所以界面布局、玻璃效果、
 * 每个界面独立外观、日历、明细、AI 解析（本地兜底），都能在浏览器里直接验证。
 * 只有麦克风权限与录音转写必须真机（Android 权限来自 APK 清单）。
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const HOST = "127.0.0.1";
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** 解析请求路径 → 磁盘路径；越出 src/ 返回 null */
export function resolveRequestPath(pathname) {
  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const target = normalize(join(ROOT, relative));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, "index.html");
  return target;
}

export function contentTypeFor(file) {
  return MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
  const file = resolveRequestPath(url.pathname);
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
  };

  if (!file) return send(403, "403 只允许访问 src/ 内的文件");
  if (!existsSync(file)) return send(404, `404 找不到 ${url.pathname}`);

  response.writeHead(200, { "content-type": contentTypeFor(file), "cache-control": "no-store" });
  createReadStream(file).pipe(response);
});

// 只有被直接执行时才监听端口，被 import（例如自检脚本）时保持纯函数可用
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    console.log(`AI 记账预览：http://${HOST}:${PORT}`);
    console.log(`静态目录：${ROOT}`);
    console.log("没有 Tauri 后端时走 mock.js 兜底；麦克风权限与录音转写仍需真机。");
  });
}

export { server };
