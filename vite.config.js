import { readFileSync } from "node:fs";

import { defineConfig } from "vite";

// 版本号单一来源：package.json。构建时注入 __APP_VERSION__，
// 前端用 import.meta.env 读到，避免 package.json / 设置页 / 导出文件各写一份对不上。
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// 前端构建配置：以 src/ 为根，产物输出到项目根 dist/（Tauri 接管打包）。
// base 用相对路径，保证 Tauri 用 file:/asset: 协议加载时资源路径正确。
export default defineConfig({
  root: "src",
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2020",
    assetsInlineLimit: 4096,
  },
});
