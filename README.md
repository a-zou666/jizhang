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
- **账单统计**：底部「账单」页按日期区间查账（默认本月开头 → 今天，开始 / 结束都能改，另有本月 / 上月 / 近 7 天 / 近 30 天 / 全部快捷区间）；**环形图**展示各分类占比、圆心是区间合计，旁边给出笔数 / 日均 / 最大单笔三个指标；**消费明细可按分类筛选**（点「全部 / 餐饮 / 交通…」筛选条，或直接点分类榜那一行，环形图会同步压暗其它分类，再点一次取消），明细按日期分组并带当天小计，每行列出分类 · 时间 · 金额
- **iOS 毛玻璃**：真正的 backdrop-blur 磨砂面板，彩色渐变底衬
- **明细管理**：左滑删除、长按编辑、数据本地存储（不上云）
- **识图记账**：对话页可以直接发小票 / 账单 / 支付截图，视觉模型自己读出每一笔（需支持图片的模型）
- **模型管理**：内置智谱 GLM / 豆包（火山方舟）/ 腾讯混元 / DeepSeek / 通义千问等预设，点一下填好地址；**从 API 拉取会先弹出选择框**，可以搜索模型 ID 再勾选要用的（不会再一次性全拉进来，里面一堆不能用的模型）；已拉取的模型支持**多选批量删除**，删完留在原地可以接着删
- **数据导出 / 导入**：JSON / CSV 导出，导入时可选「合并」或「覆盖恢复」；备份里的 API Key 一律脱敏，导入不会覆盖本机真实凭据

## 界面截图

下面每张都是 `node scripts/screenshots.mjs` 真实跑 App 截出来的（无头 Chromium，390×844 手机视口），不是设计稿。

| 首页 · 日历记账 | 对话页 · AI 记账 | 账单页 · 环形图区间统计 |
| --- | --- | --- |
| ![首页](docs/screenshots/home.png?v=4) | ![对话页](docs/screenshots/chat.png?v=4) | ![账单页](docs/screenshots/bills.png?v=4) |

| 账单页 · 按分类筛选 | 设置页 | 模型管理 |
| --- | --- | --- |
| ![分类筛选](docs/screenshots/bills-filter.png?v=4) | ![设置页](docs/screenshots/settings.png?v=4) | ![模型管理](docs/screenshots/model-manager.png?v=4) |

| 已拉取的模型（多选删除） | 从 API 拉取（搜索 + 勾选） | 识图记账（发小票） |
| --- | --- | --- |
| ![模型列表](docs/screenshots/model-list.png?v=4) | ![拉取选择框](docs/screenshots/model-fetch.png?v=4) | ![识图记账](docs/screenshots/chat-image.png?v=4) |

| 对话里的账目卡片 | 记一笔 | 编辑 / 删除 |
| --- | --- | --- |
| ![账目卡片](docs/screenshots/chat-card.png?v=4) | ![记一笔](docs/screenshots/quick-add.png?v=4) | ![编辑记录](docs/screenshots/edit-record.png?v=4) |

## 下载

Android APK 由 GitHub Actions 自动构建并发布到 [Releases](https://github.com/a-zou666/jizhang/releases)，push 到 `main` 即触发。

构建完成后会用仓库 Secrets 里的 upload keystore 对 APK 签名（`zipalign` → `apksigner`，见 `scripts/sign-android-apk.mjs`），
所以 Release 里的包可以直接安装（未签名的 APK 系统是不让装的）。下载时按机型选：

| 机型 | 文件 |
| --- | --- |
| 现代手机（arm64） | `app-arm64-release.apk` |
| 老设备（armeabi-v7a） | `app-arm-release.apk` |

首次安装需在系统设置里允许「安装未知来源应用」。升级安装必须用同一个签名的包，否则会提示「应用未安装」，
需要先卸载旧版本 —— 这会清掉本机账目，**升级前建议先在设置里导出备份**。

### App 内更新（走自建分发站，不需要翻墙）

设置页 → **软件更新**：App 去自己的分发站读一份几百字节的版本清单，有新版就弹出「版本号 + 更新说明」，
点**立即下载**用系统浏览器打开 APK 直链，浏览器自动开始下载，下完点一下即可安装。

清单与 APK 都在同一台服务器、同一个域名下 —— 一条链路，没有第三方跳转。

| 用途 | 地址 |
| --- | --- |
| 版本清单 | `https://apk.电脑.tech:9443/latest.json` |
| APK 直链 | `https://apk.电脑.tech:9443/app-arm64-release.apk` |
| 下载页（手动兜底，手机浏览器可直开） | `https://apk.电脑.tech:9444/` |

> **注意两个端口的证书不一样，别混**（这一点踩了很久的坑）：
>
> | 端口 | 给谁用 | 证书 |
> | --- | --- | --- |
> | **9443** | App 内更新（清单 + APK） | **自签**，App 里内置了对应根 CA |
> | **9444** | 用户浏览器打开下载页 | **Let's Encrypt**，零警告 |
>
> 为什么 App 那侧要自签：Let's Encrypt 从 2025 年起换了中间证书体系，`.tech` 域名拿到的链是
> `域名证书 → YR2 → Root YR → ISRG Root X1`。其中 `Root YR` 是新根，**各家客户端信任库的收录进度极不一致** ——
> 实测同一个地址：Windows 有、Ubuntu 22.04 没有、部分 Android 机型也没有。表现就是
> 「电脑浏览器能打开、手机 App 里连不上」，而且换台机器症状还不一样，极难归因。
>
> 既然域名和服务器都是自己的，干脆**绕开公共 CA 体系**：服务器用自签根 CA 签证书，App 把这张根 CA
> 编译进二进制（`src-tauri/certs/apk-ca.crt`，通过 `include_str!` 读入），校验时只认它。
> 这样免疫所有系统 CA 库差异，也不受 Let's Encrypt 换不换体系影响。根 CA 有效期 **10 年**，
> 服务器证书 **3 年**；续期只要用同一张根 CA 重签，**App 端不用发版**。
>
> 但浏览器不认自签证书，所以下载页另开 9444 走 Let's Encrypt —— 用户点开零警告。
> 两个端口读的是同一个目录 `/var/www/apk`，内容一致，不用双份维护。

> 站点只放行 `/`、`/index.html`、`/latest.json`、`/*.apk`、`/healthz`，其余一律 404
> —— 这台机器上还跑着其它生产服务，不能被当成任意文件服务器。

> 域名 `apk.电脑.tech` 在代码里写成 punycode **`apk.xn--wnyy6w.tech`**：部分运行时对中文域名的处理
> 不一致，写 ASCII 最稳。`xn--` 后那段 base36 肉眼分不出对错（曾经把 `电脑` 误写成 `xn--nyqx68a`，
> 那其实是 `徳健`，等于指向一个不存在的域名，症状是「点了检查更新却检测不到新版本」），
> 所以两侧都有防回归测试：解 punycode 回中文再比对。

#### 为什么不再用 Gitee（实测数据）

一开始 APK 与清单都放在 Gitee，但**上传慢得没法用**。在香港 Azure 机器上实测（2026-10-09）：

| 方向 | 速度 |
| --- | --- |
| 香港 → GitHub 下载 7MB | **5 MB/s** |
| 香港 → GitHub 上传 2MB | **876 KB/s** |
| 香港 → Gitee **上传** 2MB | **30~50 KB/s** |
| 香港 → Gitee 下载（Release 直链） | 463 KB/s |
| GitHub Actions → Gitee 上传 8MB | **约 4~8 分钟** |
| Gitee TCP connect / TLS 握手 | 0.46s / 0.72s（链路本身没问题） |

**结论：慢的不是跨境，是 Gitee 自己的附件上传接口。**

中途试过「Gitee 只存清单、APK 走香港裸 IP」—— 也不行，有两个致命问题：

1. 读清单要过 Gitee 的**两级 302**，最终落到带临时 token 的 CDN（`foruda.gitee.com`），
   手机走移动网络经常超时 → 实测 0.1.2 **检测不到** 0.1.3。
2. 裸 IP + `http://` 在 **Android 7+ 默认被系统拦掉**（`cleartextTrafficPermitted=false`），
   要放行得改 AndroidManifest，而 `src-tauri/gen/` 不入库、每次 CI 重新生成，很脆。

**最终方案：彻底不要第三方。** 一台服务器同时提供清单与 APK：

```
GitHub Actions ──构建+签名──> GitHub Release（只存构建产物）
                                    │ 本机每 5 分钟拉取（下行 174MB/s）
                                    ▼
                /var/www/apk + nginx
                  ├─ :9443  自签证书  ← App 内更新（清单 + APK）
                  └─ :9444  Let's Encrypt ← 用户浏览器打开下载页
                          （同一个目录，内容一致；实测下载 4.9MB/s）
```

比 Gitee 的 463KB/s 快约 **10 倍**，一次同步全程约 10 秒。

#### 分发站怎么运作

中转机（`104.208.75.62`，Ubuntu 22.04 香港 Azure）上：

| 部件 | 位置 |
| --- | --- |
| 同步脚本 | `/home/azhou/apk-sync/mirror-apk-to-hk.mjs`（源码在仓库 `scripts/`） |
| 执行封装（cron 调它） | `/home/azhou/apk-sync/mirror-run.sh` |
| 定时任务 | `*/5 * * * *` 每 5 分钟一次 |
| 站点根目录 | `/var/www/apk`（APK + latest.json + index.html） |
| nginx（App，自签） | `/etc/nginx/sites-enabled/apk-mirror`（独立 server 块，**只监听 9443 HTTPS**） |
| nginx（浏览器，LE） | `/etc/nginx/sites-enabled/apk-web`（独立 server 块，**只监听 9444 HTTPS**） |
| 自签根 CA / 服务器证书 | `/etc/nginx/ssl-apk/`（`apk-ca.crt`、`apk-server.crt`、`ssl-apk-selfsigned-chain.pem`） |
| LE 链（剔根 CA） | `/etc/nginx/ssl-apk/le-chain.pem`（由 deploy hook 重建） |
| 密钥/配置 | `/etc/ai-ledger-mirror.env`（`chmod 600`，含 `PUBLIC_BASE`=9443 / `PAGE_BASE`=9444） |
| 运行日志 | `/home/azhou/apk-sync/mirror.log`（自动保留最近 500 行） |

脚本做的事：读 GitHub 最新 Release → 按 ABI 下 APK（先写 `.part` 再 `rename`，保证用户不会下到半截文件）
→ 版本没变就跳过（幂等）→ 生成清单（APK 地址指向 `PUBLIC_BASE`，`page_url` 指向 `PAGE_BASE`）。

> **注意**：这台机器上还跑着别的东西（Caddy 占 80/8443，nginx 占 443/8888 做团队路由反代，
> docker 跑 New API）。所以两个分发站都必须是**独立 server 块**、用**独立端口 9443/9444**，
> 千万不要去改现有配置。

手动触发一次同步：

```bash
ssh azhou@104.208.75.62 '/home/azhou/apk-sync/mirror-run.sh'
ssh azhou@104.208.75.62 'tail -20 /home/azhou/apk-sync/mirror.log'
```

**证书各自的生命周期：**

| 证书 | 有效期 | 怎么续 |
| --- | --- | --- |
| 9443 自签根 CA | 10 年 | 基本不用动；换域名/换 CA 才要重新生成并**重发 App** |
| 9443 服务器证书 | 3 年 | 用同一张根 CA 重签，**App 不用发版**，只 reload nginx |
| 9444 Let's Encrypt | 90 天 | `certbot.timer` 自动续期，deploy hook 重建 `le-chain.pem` 并 reload |

> 续期 hook 在 `/etc/letsencrypt/renewal-hooks/deploy/`：`rebuild-apk-chain.sh`（重建 9444 的 LE 链，
> 剔掉 certbot fullchain 末尾的根 CA）+ `reload-nginx.sh`（reload）。9443 的自签证书不归 certbot 管。

> 为什么不在 App 内直接下载并静默安装：Android 7+ 安装 APK 必须走 FileProvider 生成 `content://` URI 再发
> `ACTION_VIEW` Intent，而 Tauri 2 的 Rust 侧拿不到 Activity / JNIEnv，官方也没有对应插件；强行 JNI 调用容易
> 直接 JVM crash。交给系统浏览器是最稳的一条路。相关取舍写在 `src-tauri/src/update.rs` 开头。

## 模型管理（App 内设置页）

设置页 → **模型管理**：

1. **添加服务商**：可以直接点预设（智谱 GLM / 豆包 / 混元 / DeepSeek / 通义千问…），也可以手填：名称 + 协议 + 接口地址 + API Key
2. **从 API 拉取**：点服务商右侧「设置」→「从 API 拉取」，会先弹出**选择框**：顶部搜索模型 ID，勾选要用的再点「添加选中」。已经在池里的会标灰，不会重复加
3. **管理已拉取的模型**：每行左侧有勾选框，可以**多选后一次删掉**；顶部的「全选」按当前结果全选。单删之后仍留在弹窗里，不用每次重新进设置
4. **选当前用哪个模型**：在「对话」页顶部胶囊点开，列出所有已拉取的模型，点一个即切换（地址 / Key 跟着切到它所属的服务商）

服务商与模型都只保存在本机，全部由你手动增删改——不会自动建档、也不会自动切换。

### 常用服务商（App 里点一下自动填好）

| 服务商 | 接口地址（补全后） | 常用模型 | 识图 |
| --- | --- | --- | --- |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4/chat/completions` | `glm-4.7-flash`（免费）、`glm-4.7`、`glm-4.6` | `glm-4.6v-flash`（免费）、`glm-4.6v`、`glm-ocr` |
| 豆包（火山方舟） | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | `doubao-seed-2-1-pro-260915`、Lite、接入点 ID（`ep-` 开头） | `doubao-seed-2-0-mini-260428`、`doubao-seed-vision`、`doubao-ocr` |
| 腾讯混元 TokenHub | `https://tokenhub.tencentcloudmaas.com/v1/chat/completions` | `hy3`、`hy3-preview` | `hy-vision-2.0-instruct`、`hy-vision-1.5-thinking` |
| 腾讯混元（旧入口） | `https://api.hunyuan.cloud.tencent.com/v1/chat/completions` | `hy3`、`hunyuan-turbos`、`hunyuan-lite` | 旧视觉模型已下线 |
| DeepSeek | `https://api.deepseek.com/v1/chat/completions` | `deepseek-chat`、`deepseek-reasoner` | — |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `qwen-plus`、`qwen-turbo` | `qwen-vl-max` |

> ⚠️ 火山方舟的 `https://ark.cn-beijing.volces.com/api/compatible` 是 **Anthropic（Claude）** 协议入口，不是 OpenAI 兼容入口；想走 OpenAI SDK 的请用 `/api/v3`。列表里自动拉到的模型如果名字带 `seedream / seedance / cogview / cogvideo` 是生图/生视频模型，不要选作默认模型，否则 `/chat/completions` 会 404。\n
三家都是 OpenAI 兼容协议，鉴权统一 `Authorization: Bearer <API Key>`。

### 接口地址怎么填

- 填**基址**（`https://api.deepseek.com`、`https://open.bigmodel.cn/api/paas/v4`、`https://ark.cn-beijing.volces.com/api/v3`）或**完整地址**（`…/chat/completions`）都行，完整地址原样使用；
- 已经带版本号（`v1` / `v3` / `v4`）的只补资源名，不会重复插一个 `/v1`；
- 表单下方会实时显示「实际请求：…」，填错一眼就能看出来；
- 各协议默认地址：Claude 原生 `https://api.anthropic.com`、OpenAI 原生 `https://api.openai.com`。

### 识图记账

对话页输入框左边是图片按钮：可以一次选多张小票 / 账单 / 支付截图（最多 9 张），直接发送（也可以补一句话），
视觉模型会自己读出每一笔，回来还是同一张「确认入账 / 忽略」卡片。

- 需要启用一个**支持图片输入**的模型（如 `glm-4.6v-flash`、`doubao-seed-2-0-mini-260428`、`hy-vision-2.0-instruct`）。
  只有当服务端明确表示「这个模型吃不了图片」时，App 才会提示换视觉模型并附上服务端原文；
  Key 错、额度用完、地址错、超时这类失败按原文如实报出，不会一律归咎于模型；
- 图片在本机压缩（最长边 1280）后再送模型，聊天记录里只留小缩略图（单条最多 12 张、最近 30 条带图消息保留），原图不入库；
- 一次选多张时，某张读不出来（格式怪 / 太大 / 解码失败）只作废这一张，其余照常发出，并提示有几张没读出来；
- 清空对话会把这些缩略图一起清掉。

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
