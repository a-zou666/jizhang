import { defineConfig } from "vite";

// 前端构建配置：以 src/ 为根，产物输出到项目根 dist/（Tauri 接管打包）。
// base 用相对路径，保证 Tauri 用 file:/asset: 协议加载时资源路径正确。
export default defineConfig({
  root: "src",
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2020",
    assetsInlineLimit: 4096,
  },
});
