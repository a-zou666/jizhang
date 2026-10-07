# AI 记账 · jizhang

一个用一句话记账的日历 App：说出「昨天买鼠标 120」，AI 自动拆成「日期 / 分类 / 物品 / 金额」，确认后落进日历。

- 前端：原生 HTML + CSS + ES Module（无构建步骤，`src/` 直接就是产物）
- 后端：Tauri 2（Rust）负责调用大模型 API 与数据本地存储
- 移动端：GitHub Actions 自动构建 Android APK 并发布到 Releases

## 界面

- **底部停靠区**：输入条与导航栏收进同一块玻璃面板，不再悬浮遮挡内容
  - **输入条**：一句话记账；长按麦克风走系统语音识别（Web）或 MediaRecorder + 后端 Whisper（Tauri / Android）；`+` 打开快捷分类
- **首页顶部**：只留一句问候语（附带今日小结「已记 N 笔 · ¥X」）+「今天」按钮
- **日历**：月支出概览（预算进度 + 剩余提示）、月份抬头（点它选月，并显示本月合计与笔数）、每日分类色点、左右滑动翻月
- **明细**：当日每条记录左滑删除、长按编辑；底部合计
- **确认页**：AI 解析结果按日期分组，可逐条改错、左滑删除，确认后飞入日历
- **设置**：协议类型 / Base URL / API Key / 模型名称（带「拉取」按钮自动从 `/v1/models` 获取）/ 测试连接 / 周起始日 / 月预算 / 分类管理 / **界面外观** / 数据导出 / 清空账单

## 外观配置（每个界面独立）

设置页 →「外观（每个界面单独配置）」→「界面外观」，可分别为 **首页 / 设置页 / 弹窗与弹层 / 底部输入条** 四个界面独立调整：

| 配置项 | 可选值 | 作用 |
| --- | --- | --- |
| 主题色 | 8 种预设 | 强调色、选中态、进度条、按钮渐变 |
| 玻璃效果 | 关闭 / 微透 / 标准 / 通透 | 透明度 + 背景模糊 + 饱和度 |
| 圆角 | 直角 / 柔和 / 圆润 | 卡片、按钮、输入框圆角尺度 |
| 密度 | 紧凑 / 标准 / 宽松 | 间距、日历格子高度、行高 |

实现方式：`src/js/appearance.js` 把每个界面的配置编译成**一条作用域 CSS 规则**写进 `<style id="app-appearance-vars">`，
只覆盖该界面自己的 CSS 变量（`tokens.css` 的全局设计令牌不动），所以改一个界面不会影响其他界面：

```css
/* 首页 */
#app .page[data-page="home"] { --app-accent: #00C2FF; --glass-blur: 16px; ... }
/* 设置页 */
#app .page[data-page="settings"] { --app-accent: #3B82F6; ... }
/* 弹窗与弹层 */
.backdrop, .sheet, .modal-root { ... }
/* 底部输入条 */
#app .dock, #app .voice-wave { ... }
```

配置存在 localStorage 的 `appearance` 字段，随数据导出一起备份；每个界面都有「恢复此界面」。

## 三种 API 协议

| 协议类型 | 说明 | 默认 Base URL |
| --- | --- | --- |
| Claude 原生 | Anthropic API 格式 | `https://api.anthropic.com` |
| OpenAI 原生 | OpenAI 官方格式 | `https://api.openai.com` |
| OpenAI 兼容 | 第三方代理（AnyRouter / TeamorRouter 等） | 自行填写 |

Base URL 只填到域名即可（如 `https://api.example.com`），程序会自动补 `/v1/messages` 或 `/v1/chat/completions`。

## 语音权限（Android）

APK 的 `AndroidManifest.xml` 必须声明录音权限，否则 WebView 连系统授权框都弹不出来，
`getUserMedia` 直接是 `NotAllowedError: Permission denied`（表面上像「语音功能坏了」）。

Tauri 生成的 Android 工程默认不声明该权限，因此 CI 在 `tauri android init` 之后、构建之前执行：

```bash
node scripts/inject-android-permissions.mjs
```

脚本会往 `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 注入
`android.permission.RECORD_AUDIO` 与 `android.permission.MODIFY_AUDIO_SETTINGS`（幂等，已存在则跳过）。
运行时授权框由 Wry 的 `RustWebChromeClient` 自动处理，不需要自己写 Kotlin。

> `src-tauri/gen/android` 不纳入版本控制（每次构建重新生成），所以权限完全依赖这个脚本注入。

## 开发

```bash
npm install          # 仅安装 @tauri-apps/cli
npm run tauri dev    # 桌面端调试（需要 Rust 工具链）
npm run check        # 语法检查 + 权限脚本自检 + 冒烟测试（53 项）
```

## 在浏览器里预览（不用出 APK）

`index.html` 用的是 ES Module，直接双击用 `file://` 打开会被浏览器的模块跨域策略挡住（页面全白）。
所以内置了一个零依赖的静态服务器：

```bash
npm run preview              # http://127.0.0.1:4173
npm run preview -- 8080      # 换端口
```

没有 Tauri 后端时 `bridge.js` 会自动回退到 `mock.js`，所以**布局、玻璃效果、每个界面独立外观、
日历、明细、AI 解析（本地兜底）都能先在浏览器里看**；只有麦克风授权与录音转写必须真机。

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
    store.js          localStorage 数据层（账单 + 设置 + 外观）
    appearance.js     每个界面独立的外观配置 → 作用域 CSS 变量
    bridge.js         调用 Rust 命令 / 浏览器兜底
    mock.js           无后端时的本地解析规则
    home.js           月度进度 + 日历 + 明细的组合渲染
    calendar.js       日历网格
    detail.js         当日明细列表
    editor.js         记录编辑弹窗
    composer.js       底部输入条（文本 / 语音 / 快捷分类）
    confirm.js        确认入账半屏弹窗与飞入动效
    settings.js       设置页、外观配置、分类管理、数据导出
    gesture.js        左滑、长按、横向滑动
    ui.js             弹窗 / toast / 底部弹层 / 飞入
    icons.js          SF Symbols 风格图标
    util.js           日期、金额、DOM 小工具
scripts/
  inject-android-permissions.mjs   向生成的 AndroidManifest 注入录音权限
  preview.mjs                      零依赖静态预览服务器（npm run preview）
  smoke.mjs                        无浏览器冒烟测试（最小 DOM 桩 + 真实模块）
src-tauri/
  src/lib.rs          四个命令：process_accounting、test_connection、list_models、transcribe_audio
```

## 校验

`scripts/smoke.mjs` 是不依赖浏览器的冒烟测试（最小 DOM 桩 + 真实模块）：

```bash
npm run check        # 语法检查 + 权限脚本自检 + 冒烟测试（53 项）
node scripts/smoke.mjs
node scripts/inject-android-permissions.mjs --self-test   # 9 个清单用例
```

覆盖：模块解析（`src/js` 下 17 个模块全部真正 import 一遍）、`app.js` 启动流程、日历渲染、
每个界面外观互不影响、外观持久化、语音退化逻辑（引擎报错后不再叠加第二次尝试）、
解析结果的日期/金额归一化、本机存储故障上报、CSS 关键契约，以及六条静态一致性审计 ——

- **CSS 变量自洽**：`var(--x)` 引用的变量必须要么有全局定义、要么由外观配置按视图提供，
  防止再出现「用了不存在的变量、样式静默失效」（此前 `--color-primary-dark` 就是这么漏掉的）。
- **图标自洽**：模板与代码用到的图标名必须都在 `ICONS` 里；未知图标名会告警而不是渲染成空白。
- **无死样式**：CSS 里定义的类名必须真的有人用。这条抓到过一个真实缺陷 ——
  `ui.js` 的 toast 生成的是 `toast is-error` 形式，而样式表里写的是 `.toast--error`，
  选择器永远匹配不上，**所有 toast（包括报错）都掉回默认深色胶囊**：
  这就是「语音权限明明报错，却只看到两个黑条」的样式原因。
- **配色对比度（WCAG AA）**：文字令牌、收入/支出与语义色、toast 四个底色、以及**八个主题色各自的
  按钮底色对与墨色**都要达到 4.5:1（提示文字 3:1）。颜色全部从 `tokens.css` 与 `appearance.js`
  的真实输出里读，不是写死在测试里的期望值，所以改动颜色令牌会立刻反映出来。
- **玻璃降级**：把 `CSS.supports` 换成「不支持 `backdrop-filter`」，断言外观样式的
  `--glass-alpha` 变成 `100%`、`--glass-blur` 变成 `0px` —— 老 WebView 上玻璃要退化成不透明实色面板，
  而不是把底下的字透上来；恢复后再断言回到默认通透度。
- **预览服务器自洽**：`preview.mjs` 的 `/` 与静态路径解析、`../` 越权必须返回 `null`、
  `.js` / `.css` / `.html` 的 MIME 必须正确（模块脚本 MIME 错了浏览器会直接拒绝执行）。

### 主题色与对比度

八个主题色的亮暗跨度很大，白字压在最亮的 `#00C2FF` 上只有 2.07:1（看不清）。
所以主题色不直接当按钮底色用，而是由 `appearance.js` 的 `accentTokens()` 编译：

- 按相对亮度在**白字 / 墨字**（`#0B1220`）之间自动选一个文字色；
- 再把底色沿对应方向推进到对比度达标（二分求解，不写死压暗比例）；
- 输出 `--app-accent-btn` / `--app-accent-btn-2`（按钮渐变两端）、`--app-on-accent`（其上文字色）、
  `--app-accent-ink`（浅色底上的墨色，用于选中态文字、图标与「测试连接」这类强调文字）。

这样换任意主题色，按钮与强调文字的对比度都自动达标，八个主题色实测正文级最低 4.54:1。
语义色（收入绿 / 支出红、成功 / 危险、以及 toast 三个底色）也按同一套阈值反推过：
`--color-success` `#00C896 → #007A5C`、`--color-danger` `#FF4757 → #C62828`（原值当白字底只有 2.16 / 3.34）。

## 解析结果的数据收口

大模型回来的日期和金额格式并不稳定，而账目一旦在入口被丢掉，用户是看不见的。所以入口只有一套归一化
（`util.js` 的 `normalizeDateKey()` / `parseAmount()`），`bridge.js`（AI 结果）、`confirm.js`（确认页）、
`store.js`（落库）三处共用：

| 输入 | 归一化结果 |
| --- | --- |
| `2026-10-4` / `2026/10/04` / `2026.10.4` / `2026年10月4日` / `2026-10-04T12:30:00Z` / `20261004` | `2026-10-04` |
| `2026-02-31`、`2026-13-01`、`去年` | 无法识别（交调用方决定：确认页落到今天，落库时拒绝） |
| `120` / `¥120` / `120元` / `1,234.5` / `1.2万` / `-120` / 全角 `３００` | `120` / `120` / `120` / `1234.5` / `12000` / `120` / `300` |

- `parseAccounting()` 返回 `{ records, skipped }`：救不回来的条数会经 toast 告诉用户，
  **不再静默丢弃**（以前 `Number("120元")` 是 `NaN`，整条账会无声消失）。
- 确认页 toast 报的是**真正落库**的条数；导入 JSON 的设置项也走和读本地同一套校验
  （非法协议回退、`weekStart` / `budget` 归一、分类去重去空）。

## 本机存储出问题时会发生什么

账目只存在本机 `localStorage`，所以「存不住」和「读不出」都必须让用户看见，而不是只写进 console：

| 情况 | 行为 |
| --- | --- |
| 写入失败（配额满 / 无痕模式） | 立刻提示「写入本机存储失败：新记录重启后会丢失」，并建议先导出备份；写入恢复正常后不再打扰 |
| 本地数据损坏解析不了 | **先把原始内容另存到 `ai-ledger/v1.recovered`**，再重置为默认状态，并提示「原始内容已另存备份，可在设置里重新导入」 |
| 部分记录格式损坏 | 跳过坏记录，其余正常加载，并提示「N 条本地记录格式损坏已跳过」 |
| 以上任意状态 | `store.js` 的 `onStorageError()` 会把故障回调给界面；注册时会**立刻回放当前状态**，所以启动阶段的问题也不会漏 |

