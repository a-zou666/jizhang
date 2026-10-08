# AI 记账 · jizhang

[![Build Android](https://github.com/a-zou666/jizhang/actions/workflows/build-android.yml/badge.svg)](https://github.com/a-zou666/jizhang/actions/workflows/build-android.yml)
[![Release](https://img.shields.io/github/v/release/a-zou666/jizhang?color=%2300C2FF)](https://github.com/a-zou666/jizhang/releases)

一句话记账的日历 App：说出「昨天买鼠标 120」，AI 自动拆成「日期 / 分类 / 物品 / 金额」，确认后落进日历。

## 它能听懂什么

| 你说 | 它做 |
| --- | --- |
| 「昨天买鼠标 120，咖啡 18」 | 解析成两笔账，确认后入账 |
| 「把咖啡删了」 | 找到那笔账，确认后删除 |
| 「这个月咖啡花了多少」 | 列出明细 + 本地算好的合计 |
| 「今天天气怎么样」 | 一句话简短答复，不记账 |

每条指令都是**一次独立请求**：不带历史对话，只发一段紧凑提示词 + 最近账目快照，输出一个 JSON —— 最省 token 的做法。

## 特性

- **对话式记账**：独立的「对话」页，像豆包 / 元宝那样聊天；AI 识别后在对话里给出账目卡片，点「确认入账」落账
- **日历记账**：月支出概览与预算进度、每日金额小字、左右滑动或按钮翻月（可看历史）
- **iOS 毛玻璃**：真正的 backdrop-blur 磨砂面板，彩色渐变底衬
- **明细管理**：左滑删除、长按编辑、数据本地存储（不上云）
- **模型管理**：可添加多个服务商（Claude / OpenAI / OpenAI 兼容），各自维护模型列表，手动添加或拉取后勾选，随时切换启用
- **数据导出 / 导入**：JSON / CSV 导出，导入时可选「合并」或「覆盖恢复」；备份里的 API Key 一律脱敏，导入不会覆盖本机真实凭据

## 界面截图

下面每张都是 `node scripts/screenshots.mjs` 真实跑 App 截出来的（无头 Chromium，390×844 手机视口），不是设计稿。

| 首页 · 日历记账 | 对话页 · AI 记账 | 设置页 |
| --- | --- | --- |
| ![首页](docs/screenshots/home.png) | ![对话页](docs/screenshots/chat.png) | ![设置页](docs/screenshots/settings.png) |

| 对话里的账目卡片 | 记一笔 | 编辑 / 删除 |
| --- | --- | --- |
| ![账目卡片](docs/screenshots/chat-card.png) | ![记一笔](docs/screenshots/quick-add.png) | ![编辑记录](docs/screenshots/edit-record.png) |

| 模型管理 | 服务商的模型列表 |
| --- | --- |
| ![模型管理](docs/screenshots/model-manager.png) | ![模型列表](docs/screenshots/model-list.png) |

## 下载

Android APK 由 GitHub Actions 自动构建并发布到 [Releases](https://github.com/a-zou666/jizhang/releases)，push 到 `main` 即触发。

## 模型管理（App 内设置页）

设置页 → **模型管理**：

1. **添加服务商**：名称 + 协议 + Base URL + API Key
2. **添加模型**：手动填模型 ID，或「从 API 拉取」后勾选加入
3. **启用**：点列表里的服务商即启用，它的地址 / Key / 默认模型写入当前连接

服务商与模型都只保存在本机，全部由你手动增删改——不会自动建档、也不会自动切换。

| 协议 | 默认 Base URL |
| --- | --- |
| Claude 原生 | `https://api.anthropic.com` |
| OpenAI 原生 | `https://api.openai.com` |
| OpenAI 兼容 | 自行填写（如 `https://api.example.com`） |

Base URL 填到域名即可，程序自动补全 `/v1/chat/completions` 或 `/v1/messages`。

## 开发

```bash
npm install        # 安装依赖
npm run dev        # Vite 开发服务器
npm run check      # 语法 + 单测 + 冒烟测试
npm run preview    # 浏览器预览（无需 Rust，走本地兜底解析）
npm run screenshots  # 真实渲染并截取各页面（需先起 preview，且本地装过 chromium）
npm run tauri dev  # 桌面端调试（需 Rust 工具链）
```

技术栈：原生 HTML/CSS/ES Module + Vite + Tauri 2 (Rust)。数据只存本机 localStorage。
