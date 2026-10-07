# AI 记账 · 本轮更新总结

> 上一版本文档曾声称「语音权限问题修复」，实际只改了 `src/js/composer.js` 的日志输出，
> 没有触碰 Android 原生 —— 权限依旧被拒。本版本改为**真正修复**，并重做布局与外观配置；
> 另外顺手修掉了两处会**悄悄丢账**的真实缺陷：记账入口的解析结果被静默丢弃（第 5 节）、
> 本机存储写入失败却显示「已入账」（第 6 节）。

## 1 ✅ 语音无法使用（真正的根因修复）

**现象**：Android 上长按麦克风，立刻弹出两条 toast
`无法访问麦克风：Permission denied` / `语音识别失败：not-allowed`，用户从没见过系统授权框。

**根因**（追到源码级）：
1. Wry 的 `RustWebChromeClient.onPermissionRequest` 遇到 `RESOURCE_AUDIO_CAPTURE` 时，会通过
   `WryActivity.requestPermissions()` 走 `RequestMultiplePermissions` 弹系统授权框 —— 前提是
   权限已在 `AndroidManifest.xml` 里声明。
2. Tauri 自带的 Android 库清单是空的，应用模板也不声明 `RECORD_AUDIO` → Android 立即拒绝，
   授权框从未出现 → WebView 把 `getUserMedia` 判为 `NotAllowedError`。
3. `src/js/composer.js` 的旧逻辑在 MediaRecorder 失败后**继续尝试 WebSpeechRecognition**，
   于是同一个权限问题被报了两次（截图里的两条 toast）。

**修复**：
- 新增 `scripts/inject-android-permissions.mjs`：在 `tauri android init` 之后、构建之前，
  向 `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 注入
  `RECORD_AUDIO` + `MODIFY_AUDIO_SETTINGS`；幂等、带写入后校验。
- `.github/workflows/build-android.yml` 增加对应步骤，APK 每次构建都带权限。
- 运行时授权框仍由 Wry 的 WebChromeClient 自动处理，无需写 Kotlin。
- `lib.rs` 未改动：Tauri 2 的 `on_permission_request` 需要 `unstable` feature，且文档明确
  Android 下 `PermissionResponse::Allow` 对运行时权限无效。

**前端加固**（`src/js/composer.js`）：
- 引擎级联改为「引擎一旦报错就立即返回」，不再叠加第二次尝试 → 只会出现一条 toast。
- `microphoneErrorText()` 区分 `NotAllowedError` / 无设备 / 被占用 / 授权超时，
  移动端直接提示「设置 → 应用 → AI 记账 → 权限 → 麦克风」。
- `getAudioStream()` 给 `getUserMedia` 加 8s 超时，避免授权框挂起把长按状态锁死。

## 2 ✅ 布局重构（原来「很乱」的原因）

发现三个真实缺陷：

| 问题 | 原因 | 修复 |
| --- | --- | --- |
| 打字排版全乱 | `t-hero`/`t-title1`/`t-title3`/`t-caption`/`t-footnote` 五个排版类**在 CSS 里根本不存在** | 在 `tokens.css` 补齐语义化排版类 |
| 底部半屏遮罩透明 | `--color-backdrop` 变量未定义 | 定义 `rgba(12,20,33,0.38)`，并补 `--spacing-*` 兼容别名 |
| 内容被两层悬浮条夹住 | 输入条与导航栏各自 `position: fixed`，页面要预留两段 padding | 合并为单层 `.dock` 停靠区（输入条在上、导航栏在下），页面只预留一次 |

其他布局调整：

- 月进度从「头部大色块」改为 `.spend-overview` 概览行，首屏能看见日历。
- **首页顶部进一步收编**：删掉 `.home-header__title-group` 包装与 `.home-title` 那套样式，
  「10月」这个月份按钮搬进**日历面板抬头**（`.panel__head` 里，仍用 `#monthTitle`），
  抬头右侧显示本月笔数、下方一行显示本月支出合计（`#calendarCount` / `#calendarSpent`）。
  顶部现在只剩「问候语 + 今天」一行，问候语后面挂一句今日小结（「已记 3 笔 · ¥45」/「还没有记账」），
  既消掉了「月份在顶部出现两次」的重复，也把原本空着的大白块填上了有效信息。
- 日历格子从 `aspect-ratio: 1` 正方块改为 `--density-cell` 高度，留出更多列表空间。
- 明细卡、日历卡统一为 `.panel` 面板语义。

## 3 ✅ 玻璃拟态

- 新增玻璃令牌：`--glass-alpha / --glass-blur / --glass-blur-strong / --glass-saturate / --glass-border-color / --glass-hairline / --glass-shadow`。
- 落点（都在「合适的位置」，不是全屏铺开）：吸顶页头、底部停靠区、面板卡片、设置分组、底部半屏、模态弹窗、语音波纹遮罩。
- 背景改为径向渐变 + 主题色微光，让 `backdrop-filter` 真正有东西可透。
- **降级是真的做了**：`appearance.js` 的 `supportsGlassBlur()` 会探一下 `backdrop-filter`（含 `-webkit-` 前缀），
  不支持时把 `--glass-alpha` 顶到 `100%`、`--glass-blur` 归零，玻璃退化成**不透明实色面板**，
  而不是「底下的字透上来」。冒烟测试里把 `CSS.supports` 强制成 `false` 来验证这条路径。

## 4 ✅ 每个界面独立配置

设置页 → **外观（每个界面单独配置）** → **界面外观**。

| 界面 | 配置项 |
| --- | --- |
| 首页 | 主题色（8 种）/ 玻璃效果（关闭·微透·标准·通透）/ 圆角（直角·柔和·圆润）/ 密度（紧凑·标准·宽松） |
| 设置页 | 同上，独立一套 |
| 弹窗与弹层 | 同上，独立一套 |
| 底部输入条 | 同上，独立一套 |

实现：`src/js/appearance.js` 把每个界面的配置编译成**一条作用域 CSS 规则**写入
`<style id="app-appearance-vars">`，只覆盖该界面自己的 CSS 变量：

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

改一个界面**不会影响**其他界面（`tokens.css` 的全局设计令牌完全不动）。
配置存 localStorage 的 `appearance` 字段，随数据导出一起备份；每个界面有「恢复此界面」。

## 6 ✅ 本机存储故障不再静默（顺手修掉的「存不上却显示成功」）

同一类问题的另一半在**写入**路径上：`store.js` 的 `persist()` 原来只 `console.warn`。
于是存储写不进去时（配额满、无痕/隐私模式），用户照样看到「已入账 1 笔」，重启后账目全部消失。

- 新增 `onStorageError(handler)` / `getStorageProblem()`：写入失败、本地数据损坏、
  坏记录被跳过都会回调给界面；**注册时立刻用当前状态回放一次**，所以 `load()` 阶段的读故障也不会漏。
- `app.js` 收到故障后按类型提示（不是 console，用户看不到 console）：
  - `write` → 「写入本机存储失败：新记录重启后会丢失。请先在设置里导出备份，并清理存储空间后重试」；
  - `read` → 「本机保存的账目读不出来，当前显示为空；原始内容已另存备份，可在设置里重新导入」；
  - `dropped` → 「N 条本地记录格式损坏已跳过，其余账目正常」；
  - 恢复正常（下一次写入成功）→ 不打扰用户。
- **数据救援**：本地数据解析不了时，先把原始内容另存到 `ai-ledger/v1.recovered` 再重置 ——
  否则下一次写入就会把这堆字节永久覆盖，数据再没机会救回来。
- `ui.js` 的 `toast(message, type, duration)` 增加时长参数，存储类故障提示多停留一会儿（6~8 秒）。

## 文件变更

**新增**
- `src/js/appearance.js` — 外观配置模型 + 作用域 CSS 编译 + 注入 + 主题色对比度求解
- `scripts/inject-android-permissions.mjs` — AndroidManifest 权限注入
- `scripts/preview.mjs` — 零依赖静态预览服务器（`npm run preview`）
- `scripts/smoke.mjs` — 无浏览器冒烟测试（最小 DOM 桩 + 真实模块）
- `UPDATE_SUMMARY.md`（本文件，重写）

**修改**
- `src/index.html` — 单层 `.dock` 停靠区、`.spend-overview` 概览、日历面板抬头、外观入口
- `src/styles/tokens.css` — 补排版类 / `--color-backdrop` / 玻璃与密度令牌 / 三个主题色按钮令牌；
  灰度文字令牌按对比度反推（`--text-tertiary`、`--text-placeholder`）；删掉整批没人用的死工具类
  （含没人引用的 `--glass-alpha-soft`）
- `src/styles/app.css` — 完全重写（停靠区、玻璃层、面板、外观配置 UI）；
  按钮改用 `--app-accent-btn` / `--app-on-accent`；toast 语义底色改为达标值；
  删掉 `.card` / `.toast--*` / `.calendar-cell__amount` 等死规则
- `src/js/home.js` — 顶部收编到一行 + 日历面板抬头（本月合计 / 笔数）+ 今日小结
- `src/js/composer.js` — 语音引擎级联 + 可操作错误提示 + 授权超时；解析结果被跳过时提示用户
- `src/js/store.js` — `appearance` 状态、`setViewAppearance`、导入导出；
  `sanitizeRecord` / `sanitizeSettings` 收口（读本地与导入 JSON 共用）；
  `onStorageError` 上报存储故障 + 损坏数据先备份到 `ai-ledger/v1.recovered`
- `src/js/util.js` — `normalizeDateKey()` / `parseAmount()`：日期与金额的唯一归一化入口
- `src/js/bridge.js` — `parseAccounting()` 返回 `{ records, skipped }`，不再静默丢弃
- `src/js/confirm.js` — 确认页与落库共用同一套归一化；toast 报真正入账的条数
- `src/js/settings.js` — 外观配置弹窗
- `src/js/app.js` — 启动时应用外观、`data-page` 作用域标记
- `src/js/ui.js` — 修正失效的 CSS 变量引用
- `src/js/icons.js` — 未知图标名告警（不再静默渲染成空白）
- `scripts/inject-android-permissions.mjs` — 幂等注入 + `--check` + 9 个用例自检
- `package.json` — `npm run check` / `npm run smoke` / `npm run preview`
- `.github/workflows/build-android.yml` — 权限注入 + 校验 + 静态检查
- `README.md` — 界面、外观配置、语音权限、浏览器预览、解析结果的数据收口、目录结构、校验

## 验证

```bash
npm run check     # 语法检查 + 权限脚本自检（9 用例）+ 冒烟测试（53 项，全部通过）
node scripts/smoke.mjs
node scripts/inject-android-permissions.mjs --self-test
npm run preview   # 浏览器里看布局 / 玻璃 / 每个界面独立外观
```

冒烟测试覆盖：`src/js` 下 17 个模块全部真实 import 一遍、`app.js` 完整启动流程、日历渲染、
月份按钮落在日历面板抬头、本月合计与笔数、问候语附带今日小结、外观弹窗交互、
「改首页主题色不影响设置页」、外观持久化、语音引擎短路逻辑、解析结果的日期/金额归一化、
存储故障上报（写入失败 / 数据损坏备份 / 坏记录条数 / 注册回放）、CSS 关键契约，
以及六条**静态一致性审计**：

- **CSS 变量自洽**：`app.css` + `tokens.css` + `index.html` 里 `var(--x)` 引用的 97 个变量，
  必须要么有全局定义、要么由外观配置按视图提供 —— 否则报错。（审计前先剥注释，
  免得注释里举例的 `var(--foo)` 被当成真实引用。）
  这条审计当场抓出一个潜伏 bug：「测试连接」用了**不存在的 `--color-primary-dark`**，
  文字颜色一直是继承色。已改为 `.settings-row--action` + `--app-accent-ink`，顺带让它跟随该界面的主题色。
- **图标自洽**：模板与代码里用到的 8 个图标名必须都在 `ICONS` 的 16 个键里；
  并验证未知图标名会 `console.warn` 而不是静默渲染成空白。
- **无死样式**：164 个类名都必须真的有人用。这条抓到另一个真实缺陷 ——
  `ui.js` 的 toast 生成的是 `toast is-error` 形式，而样式表里只有 `.toast--error`，
  **选择器永远匹配不上，所有 toast（包括报错）都掉回默认深色胶囊**：
  这正是「语音权限明明报错，却只看到两个黑条」的样式原因。同类死规则还有
  `.card`、`.calendar-cell__amount`、以及 `tokens.css` 里整批 `text-*` / `font-*` / `leading-*` 工具类，已一并清除。
  > 教训：审计「类名是否被使用」时，不能把 JS 里所有标识符都算作已用 ——
  > `{ glass: "medium" }` 这种对象键会把死样式 `.glass` 误判成「有人在用」；
  > 也只在取出值**之后**掏空模板插值，否则写在 `${...}` 里的 `class="option-item__desc"` 会被一起抹掉、变成假死样式。
- **配色对比度（WCAG AA，本轮新增）**：56 组前景/背景必须达到各自阈值（正文 4.5:1、提示文字 3:1）。
  颜色**从 `tokens.css` 与 `appearance.js` 的产出里读**，不是写死在测试里的期望值 ——
  于是这条审计一落地就抓出一批真实问题（括号内为修订前实测值）：
  - 灰度文字：`--text-tertiary` 3.63、`--text-placeholder` 2.04（都压在 `--bg-tertiary` 上）；
  - 语义色：白字压 `--color-success` 2.16 / `--color-danger` 3.34；
    金额文字 `--color-expense` 3.34、`--color-income` 2.16；`--color-danger` 压在
    `--color-danger-bg` 上 2.86；发送按钮绿色渐变 2.16 / 3.77；左滑删除按钮白字 3.34；
  - toast 三个语义底色：ok 2.97、error 4.41、warning 2.58；
  - 主题色按钮白字：八个主题色里七个不达标（最差的 `#00C2FF` 只有 2.07），
    主题色墨色作文字也有多个落在 3.36~4.19。

  修订后正文级最低 **4.54:1**。用变异测试确认过它真的会咬人：把 `--text-tertiary` 改成 `#999999`，
  审计立刻失败并点名 `--text-tertiary on --bg-tertiary 2.58 < 4.5`。
- **玻璃降级（本轮新增）**：把 `CSS.supports` 强制成「不支持 `backdrop-filter`」，断言外观样式里
  `--glass-alpha` = `100%`、`--glass-blur` = `0px`（老 WebView 上必须退化成不透明实色面板）；
  恢复后再断言回到默认的 `86%`，确认降级没有污染正常路径。
- **预览服务器自洽（本轮新增）**：`preview.mjs` 的 `/` 与静态路径解析、`../` 越权必须返回 `null`、
  `.js` / `.css` / `.html` 的 MIME 必须正确（模块脚本 MIME 错了浏览器会直接拒绝执行）。

> 沙箱内无法启动 headless Chrome（mojo 需要命名管道），因此未产出截图；
> 视觉结论来自 DOM 结构 + 作用域 CSS 的断言、CSS 契约检查与配色对比度计算。
> 现在可以用 `npm run preview` 在浏览器里直接核对外观（见 README）。

## 5 ✅ 解析结果的数据收口（顺手修掉的静默丢账）

前四项之外的发现：**记账入口在悄悄丢数据**。大模型返回的日期/金额格式并不稳定，
而旧的校验是严格正则 + `Number()`：

| 模型返回 | 旧行为 | 现在 |
| --- | --- | --- |
| `date: "2026-10-4"`（没补零） | 正则 `^\d{4}-\d{2}-\d{2}$` 不匹配 → **整条丢弃** | 归一化成 `2026-10-04` |
| `date: "2026/10/3"` / `"2026年10月4日"` | 丢弃 | 归一化 |
| `amount: "120元"` / `"¥28.5"` / `"1,234"` | `Number()` 得 `NaN` → 金额记 0 → **被 `amount > 0` 过滤掉** | 解析成 `120` / `28.5` / `1234` |
| `amount: "1.2万"` | 丢弃 | `12000` |
| 确认页 toast | 报 `pending.length`，与实际落库条数无关 | 报真正入账的条数，差额并告知 |

- 归一化只有一套：`util.js` 的 `normalizeDateKey()` / `parseAmount()`，
  `bridge.js`（AI 结果）→ `confirm.js`（确认页）→ `store.js`（落库）三处共用，
  不会再出现「确认页显示 3 笔、实际只进 2 笔」。
- `parseAccounting()` 改为返回 `{ records, skipped }`，救不回来的条数经 toast 告诉用户。
- 顺带收口 `replaceAll()`（导入 JSON）：以前是 `Object.assign` 直接进 state，
  非法 `weekStart` / 负数 `budget` / 分类里混进对象都能写进运行态；
  现在与 `load()` 共用 `sanitizeSettings()`（白名单重建、分类去重去空、上限 40 个）。
- 回归检查加进冒烟测试（+7 项，含 6 种日期写法、8 种金额写法、假装后端返回脏数据的端到端用例）。

## 主题色对比度是怎么修的

八个主题色亮暗跨度很大（`#00C2FF` 相对亮度 0.45，`#64748B` 只有 0.17），
原来的做法是「固定压暗 0.78」，必然有一部分主题色不达标。改成按对比度反推：

- `accentTokens(accent)` 先用相对亮度在白字 / 墨字（`#0B1220`）之间选文字色；
- 再把底色用**二分**推进到与文字色 ≥4.635:1（4.5 留 3% 余量），不写死比例；
- 输出 `--app-accent-btn` / `--app-accent-btn-2`（按钮渐变两端，
  正好替换掉原先跨度过大的 `accent → accent-ink`）、`--app-on-accent`（其上文字色）、
  `--app-accent-ink`（浅色底上的墨色，用于选中态文字、图标与强调文字），
  并让 `--app-accent-strong` 也用达标底色、且**改成不透明**（原为 `rgba(...,0.92)`，
  被浅色背景拉亮 8% 后白字对比度会从 4.76 掉到 4.08），避免飞入角标的白字发虚。
- 审计还会检查 `--app-accent-strong` 的 alpha 必须是 1，防止有人把它改回半透明。
- 灰度令牌同步按阈值反推：`--text-tertiary` `#718096 → #637084`（在 `--bg-tertiary` 上 4.54），
  `--text-placeholder` `#A0AEC0 → #838E9D`（3.00）。
- 语义色同样分了两套用途，按阈值反推后合并成同一个值：
  `--color-success` / `--color-income` `#00C896 → #007A5C`（白字 5.33、作文字 5.33），
  `--color-danger` / `--color-expense` `#FF4757 → #C62828`（白字 5.62、作文字 5.62、
  压 `--color-danger-bg` 4.82）；发送按钮渐变第二站 `#059669 → #056E4F`（6.27）。
  `*-bg` / `*-light` 是浅色蒙版，保持原值不动。
- toast 三个语义底色改为白字达标值：ok `rgba(0,122,92,.94)`、error `rgba(198,40,40,.95)`；
  琥珀色亮度天然偏高，白字压不下去，所以 `is-warning` 改用深墨色文字 `#3D2600` 配 `rgba(255,176,32,.96)`（7.78）。


## 待验证

- 真机安装新 APK，确认长按麦克风会弹出系统授权框、授权后能录音转写。
- 在真机上确认玻璃效果与密度配置的实际观感。
- 解析收口只做了自动化验证（含假装后端返回 `2026-10-4` / `¥28.5` 的端到端用例），
  真实模型返回的脏格式覆盖面还需要跑几次语音记账观察。
