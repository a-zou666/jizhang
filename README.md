# AI 记账 · jizhang

一个用一句话记账的日历 App：说出「昨天买鼠标 120」，AI 自动拆成「日期 / 分类 / 物品 / 金额」，确认后落进日历。

- 前端：原生 HTML + CSS + ES Module（无构建步骤，`src/` 直接就是产物）
- 后端：Tauri 2（Rust）负责调用大模型 API 与数据本地存储
- 移动端：GitHub Actions 自动构建 Android APK 并发布到 Releases

## 界面

- **底部悬浮输入条**：一句话记账；长按麦克风走系统语音识别转文字；`+` 打开快捷分类
- **日历**：月总支出 / 月预算进度条、每日金额与分类色点、左右滑动翻月、点击大标题选月
- **明细**：当日每条记录左滑删除、长按编辑；底部合计
- **确认页**：AI 解析结果按日期分组，可逐条改错、左滑删除，确认后飞入日历
- **设置**：协议类型 / Base URL / API Key / 模型名称 / 测试连接 / 周起始日 / 月预算 / 分类管理 / 数据导出 / 清空账单

## 三种 API 协议

| 协议类型 | 说明 | 默认 Base URL |
| --- | --- | --- |
| Claude 原生 | Anthropic API 格式 | `https://api.anthropic.com` |
| OpenAI 原生 | OpenAI 官方格式 | `https://api.openai.com` |
| OpenAI 兼容 | 第三方代理（AnyRouter / TeamorRouter 等） | 自行填写 |

Base URL 只填到域名即可（如 `https://api.example.com`），程序会自动补 `/v1/messages` 或 `/v1/chat/completions`。

## 开发

```bash
npm install          # 仅安装 @tauri-apps/cli
npm run tauri dev    # 桌面端调试（需要 Rust 工具链）
```

前端是纯静态资源，也可以直接用浏览器打开 `src/index.html` 预览（此时没有 Tauri 后端，AI 解析会走内置的本地兜底规则）。

## 构建

```bash
npm run tauri build            # 桌面端
npm run tauri android build    # Android（需先 npm run tauri android init）
```

推送到 `main` 会自动触发 `.github/workflows/build-android.yml`，把 APK 发布到 GitHub Releases。

## 目录结构

```
src/
  index.html          应用外壳（首页 / 设置 / 输入条 / 确认页 / 弹窗容器）
  styles/
    tokens.css        设计令牌：色彩、字体、间距、圆角、阴影、动效
    app.css           组件样式
  js/
    app.js            入口：装配状态、视图与事件
    view.js           视图状态（当前页签、当前月、选中日期）
    store.js          localStorage 数据层（账单 + 设置）
    bridge.js         调用 Rust 命令 / 浏览器兜底
    mock.js           无后端时的本地解析规则
    home.js           月度进度 + 日历 + 明细的组合渲染
    calendar.js       日历网格
    detail.js         当日明细列表
    editor.js         记录编辑弹窗
    composer.js       底部输入条（文本 / 语音 / 快捷分类）
    confirm.js        确认入账半屏弹窗与飞入动效
    settings.js       设置页与分类管理、数据导出
    gesture.js        左滑、长按、横向滑动
    ui.js             弹窗 / toast / 底部弹层 / 飞入
    icons.js          SF Symbols 风格图标
    util.js           日期、金额、DOM 小工具
src-tauri/
  src/lib.rs          两个命令：process_accounting、test_connection
```
