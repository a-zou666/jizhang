//! 软件更新：检查 Gitee 上的新版本，并把用户送到新版安装包的下载地址。
//!
//! ## 为什么更新源是 Gitee 而不是 GitHub
//!
//! GitHub 在国内经常连不上。更新链路只要经过 GitHub，就等于「永远更新不了」。
//! 所以 CI 仍然跑在 GitHub Actions 上打包签名，但产出的 APK 与 latest.json
//! 会被推送到 Gitee Release，App 只跟 Gitee 说话。
//!
//! ## 为什么不在 App 内下载 APK 并自动安装
//!
//! 试过，行不通，记录在这里免得以后又有人踩：
//! - 官方 `tauri-plugin-opener` 在 Android 上**被限制为只能打开 URL**，
//!   `openPath` 打不开本地文件（文档明写 "android: Only allows to open URLs via open"）；
//! - Android 7+ 要让系统安装器接受一个 APK，必须通过 `FileProvider` 拿到
//!   `content://` URI，再发 `ACTION_VIEW` + `application/vnd.android.package-archive`
//!   的 Intent。Tauri 2 的 Rust 侧拿不到 Activity / JNIEnv 引用（不在主线程上下文），
//!   直接 JNI 调用容易 JVM crash 或 DetachedThread；
//! - 唯一正路是自建一个带 Kotlin 代码的 Tauri 插件，而 `src-tauri/gen/` 是
//!   `tauri android init` 生成的、不入库，每次 CI 都要重新注入，很脆。
//!
//! ## 采用方案：检查在 App 内，下载交给浏览器
//!
//! 用户点「立即更新」时，直接把**清单里的 APK 直链**丢给系统浏览器 ——
//! 浏览器自己会立刻开始下载，下完点一下就能装，不需要先打开网页再手动点下载。
//! 这样零 Kotlin、零插件、零额外权限，且不受签名与分区存储影响。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/* ==========================================================================
   更新源常量
   ========================================================================== */

/// 更新源：**自建的分发服务器**（香港），清单与 APK 都从这里取。
///
/// ## 为什么不用 Gitee 了
///
/// 之前清单挂在 Gitee 的 Release 附件上，实测有两个硬伤：
///
/// 1. **上传慢得没法用** —— Gitee 的附件上传接口只有 10~50 KB/s
///    （同一台机器传 GitHub 有 876 KB/s、从 Gitee 下载也有 463 KB/s），
///    一个包要传几分钟还常超时。慢的是 Gitee 的附件服务，不是跨境。
/// 2. **下载链路又长又脆** —— 读一个几百字节的清单要**两级 302**：
///      gitee.com/.../releases/download/latest/latest.json
///        └─302─> gitee.com/.../attach_files/<id>/download/latest.json
///            └─302─> foruda.gitee.com/attach_file/<id>/latest.json?token=…&ts=…
///    最终落在**带临时 token 的 CDN 域名**上。手机走移动网络时这条链路经常
///    超时，表现就是「点了检查更新却检测不到新版本」。
///
/// 现在改成一台自己的服务器（Azure 香港）用 nginx 同时提供清单与 APK：
/// 一条链路、一个证书、没有第三方跳转。
///
/// ## 为什么用域名 + HTTPS，不用裸 IP + HTTP
///
/// Android 7+ 默认**禁止明文 HTTP 流量**，用 `http://` 地址会被系统直接拦掉；
/// 要放行得改 AndroidManifest，而 `src-tauri/gen/` 是 `tauri android init`
/// 生成的、不入库，每次 CI 都得重新注入（麦克风权限已经吃过这个亏）。
/// 加个域名走 HTTPS 这些坑全部消失。
///
/// 域名是中文的 `电脑.tech`，punycode 为 `xn--wnyy6w.tech`。这里**写 punycode**：
/// 部分运行时对 IDN 的处理不一致，写死了最稳（curl / reqwest / WebView 都认）。
pub const UPDATE_HOST: &str = "apk.xn--wnyy6w.tech";

/// 更新清单地址。App 只认这一个 URL —— 发布流程每次覆盖同一个文件，
/// 所以地址永远不变，不用跟着版本号改代码。
///
/// 端口是 **9443**：这个端口用**自签证书**（根 CA 内置在 App 里，见
/// `TRUSTED_CA_PEM`），所以不受各家系统 CA 库影响。
pub const MANIFEST_URL: &str = "https://apk.xn--wnyy6w.tech:9443/latest.json";

/// APK 直链前缀。清单里若只给了文件名（没给完整地址），就用它拼。
///
/// 与 `MANIFEST_URL` 同端口（9443，自签）。清单实际给的是完整地址，
/// 这里只是「相对文件名」的兜底 —— 两边保持一致，改端口时别漏。
pub const DOWNLOAD_PREFIX: &str = "https://apk.xn--wnyy6w.tech:9443";

/// 发布页（找不到具体附件时兜底）。
///
/// 端口是 **9444**，与上面两个**不同** —— 这里就是给**用户浏览器**打开的：
/// - :9443 是自签证书，App 认（内置了根 CA），但**浏览器会报警告**；
/// - :9444 走 Let's Encrypt，浏览器零警告。
///
/// 正常情况下这个常量用不上 —— 清单里的 `page_url` 已经是 9444（由
/// `scripts/mirror-apk-to-hk.mjs` 的 `PAGE_BASE` 写入）。这里是最后兜底。
pub const RELEASES_PAGE: &str = "https://apk.xn--wnyy6w.tech:9444/";

/// 发布页地址（自建服务器，就是站点根）。
///
/// 保留成函数是为了不动调用方 —— `lib.rs` 里用它兜底提示文案。
pub fn releases_page() -> String {
    RELEASES_PAGE.to_string()
}

/// 我们自己那张**自签根 CA** 的 PEM，编译期打进二进制。
///
/// ## 为什么不再依赖任何系统 CA 库
///
/// 这块踩过一个大坑，值得写清楚：
///
/// Let's Encrypt 从 2025 年起启用新的中间证书体系，`.tech` 域名拿到的链是
/// `域名证书 → YR2 → Root YR → ISRG Root X1`。其中 `Root YR` 是新根，
/// **各家客户端信任库的收录进度极不一致** —— 实测同一个地址：
///
/// - Windows 系统 CA 库：有，验签通过；
/// - Ubuntu 22.04 的 `ca-certificates`：**没有**，报 `unable to get local issuer certificate`；
/// - 部分 Android 机型（系统根证书更新依赖厂商 OTA）：也没有。
///
/// 表现就是「浏览器/电脑能打开、App 里的检查更新连不上」，而且**换了机型表现还不一样** ——
/// 归因成本极高。这期间还叠加了两个更迷惑的现象：
///
/// - `reqwest` 默认的 `rustls-tls` 走 `webpki-roots`（编译期静态列表），
///   连系统 CA 都不看，覆盖率又是另一套；
/// - rustls 严格遵守 RFC 8446「服务器不得发送根 CA」，只要链尾是 CA 就直接报
///   `CaUsedAsEndEntity`，而 OpenSSL/BoringSSL 会容忍 —— 又一次「浏览器行、App 不行」。
///
/// 既然域名、服务器、证书全是我们自己的，最稳的做法是**彻底绕开公共 CA 体系**：
/// 服务器改用自签根 CA 签发证书，App 内置这张根 CA 作为**唯一**信任锚。
/// 这样：不看系统 CA 库（免疫上面所有差异）、不用管 Let's Encrypt 换不换体系、
/// 根 CA 有效期 10 年也基本不用动。安全上也不弱 —— 信任范围收窄到了「只有这一张证书」，
/// 比信任全球 150+ 个公共根 CA 更严格。
///
/// 证书轮换：**只需要在服务器上用同一张根 CA 重签服务器证书**，App 无需发版。
/// 只有换域名/换根 CA 才要更新这个文件和 `certs/` 下的证书。
pub const TRUSTED_CA_PEM: &str = include_str!("../certs/apk-ca.crt");

/// 拉清单的超时。
///
/// 自建服务器在香港、走 HTTPS，正常几十毫秒就回；给 20s 是给移动网络留余量。
/// （之前挂 Gitee 时要过两级 302 跳到带临时 token 的 CDN，20s 经常不够 ——
/// 换自建源之后这个超时已经很宽裕了。）
const FETCH_TIMEOUT_SECS: u64 = 20;

/* ==========================================================================
   数据结构
   ========================================================================== */

/// 各 ABI 的 APK 下载地址（CI 生成）
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct ApkUrls {
    #[serde(default)]
    pub arm64: String,
    #[serde(default)]
    pub arm: String,
    /// 通用包兜底
    #[serde(default)]
    pub universal: String,
}

/// 更新清单（CI 生成，作为 Release 附件 latest.json 上传）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct UpdateManifest {
    /// 清单格式版本，便于以后扩展
    #[serde(default)]
    pub schema: u32,
    /// 最新版本号，形如 0.1.1（不带 v 前缀）
    pub version: String,
    /// 发布说明
    #[serde(default)]
    pub notes: String,
    /// 按 ABI 分的下载地址
    #[serde(default)]
    pub apk: ApkUrls,
    /// 发布页地址（兜底跳转）
    #[serde(default)]
    pub page_url: String,
    /// 发布时间
    #[serde(default)]
    pub published_at: String,
}

impl UpdateManifest {
    /// 本机该下的 APK 地址。
    ///
    /// 清单里 `apk.*` 允许写「完整地址」也可以只写「文件名」—— 后者由
    /// `resolve_download` 补成 Release 附件直链，这样 CI 侧生成清单时更省事，
    /// 也方便以后换域名。挑不到任何 APK 时兜底到发布页。
    pub fn download_url_for(&self, arch: &str) -> String {
        let picked = pick_download_url(&self.apk, arch);
        let resolved = resolve_download(DOWNLOAD_PREFIX, &picked);
        if !resolved.is_empty() {
            return resolved;
        }
        if !self.page_url.trim().is_empty() {
            return self.page_url.trim().to_string();
        }
        RELEASES_PAGE.to_string()
    }
}

/// 检查更新的返回体。
///
/// 注意：无论「连不上服务器」还是「已是最新版」都返回 Ok，用 ok 字段区分。
/// 这样前端只需要处理一种返回形状，不用把网络错误当成 invoke 异常来 catch。
///
/// ## `rename_all = "camelCase"` 不能省
///
/// Tauri 的 `invoke` 就是拿 serde 原样序列化，**不会**自动把 snake_case 转成
/// camelCase。而这个结构体是全项目唯一带多词字段的返回体（其它那边只有
/// `ok` / `message` / `models` 这种单词，怎么写都一样），于是很容易漏。
///
/// 漏掉的后果极其隐蔽：JS 里读 `result.hasUpdate` 得到 `undefined`，
/// `Boolean(undefined)` 是 `false` —— App **能连上、能验签、能拿到 0.1.7 清单，
/// 却一口咬定「已是最新」**，而且不报任何错。`currentVersion` 也一样读不到，
/// 前端只能回退到传进去的 `APP_VERSION`，于是弹窗里显示的「当前版本 v0.1.6」
/// 看上去完全正常，进一步掩盖了问题。
///
/// 所以这里必须显式声明，且最好在测试里钉死（见 `update_check_result_uses_camel_case`）。
#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub ok: bool,
    pub message: String,
    /// 远端最新版本号
    pub latest_version: String,
    /// 当前 App 版本号
    pub current_version: String,
    /// 是否有新版本
    pub has_update: bool,
    /// 发布说明
    pub notes: String,
    /// 本机该用的安装包直链（已按 ABI 选好）
    pub download_url: String,
    /// 发布页（兜底）
    pub page_url: String,
    /// 失败时给一句能照着做的排查提示
    pub hint: String,
}

impl UpdateCheckResult {
    /// 失败结果的统一构造：把「为什么失败 + 怎么办」写清楚
    pub fn failure(current: &str, message: String, hint: String) -> Self {
        Self {
            ok: false,
            message,
            latest_version: String::new(),
            current_version: current.to_string(),
            has_update: false,
            notes: String::new(),
            download_url: String::new(),
            page_url: RELEASES_PAGE.to_string(),
            hint,
        }
    }
}

/* ==========================================================================
   版本比对
   ========================================================================== */

/// 把 "v0.1.2" / "0.1.2-beta.1" 切成数字段 + 预发布标记。
/// 非数字段（beta/rc）统一记 0，并用预发布标记保证 正式版 > 预发布版。
fn parse_version(raw: &str) -> (Vec<u64>, bool) {
    let text = raw.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match text.split_once('-') {
        Some((head, tail)) => (head, !tail.trim().is_empty()),
        None => (text, false),
    };
    let numbers = core
        .split(['.', '_', '+'])
        .map(|part| {
            // "2b" 这类混杂段取前导数字
            let digits: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse::<u64>().unwrap_or(0)
        })
        .collect::<Vec<u64>>();
    (numbers, pre)
}

/// 比较两个版本号。纯函数，单测覆盖。
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let (left, left_pre) = parse_version(a);
    let (right, right_pre) = parse_version(b);
    let len = left.len().max(right.len());
    for i in 0..len {
        let l = left.get(i).copied().unwrap_or(0);
        let r = right.get(i).copied().unwrap_or(0);
        if l != r {
            return l.cmp(&r);
        }
    }
    match (left_pre, right_pre) {
        (true, false) => std::cmp::Ordering::Less, // 0.2.0-beta < 0.2.0
        (false, true) => std::cmp::Ordering::Greater,
        _ => std::cmp::Ordering::Equal,
    }
}

/// 远端是否比本机新
pub fn is_newer(remote: &str, current: &str) -> bool {
    compare_versions(remote, current) == std::cmp::Ordering::Greater
}

/* ==========================================================================
   下载地址
   ========================================================================== */

/// 本机 CPU 架构（Android 上 aarch64 / arm / x86_64）
pub fn current_arch() -> &'static str {
    std::env::consts::ARCH
}

/// 按 ABI 从清单里挑下载地址。挑选顺序：精确 ABI → 通用包 → arm64 兜底。
///
/// 为什么兜底到 arm64 而不是报错：现在绝大多数手机是 64 位 ARM，
/// 拿不到架构信息时给 arm64 至少是「多半能用」；真装错了系统也会拦下。
pub fn pick_download_url(apk: &ApkUrls, arch: &str) -> String {
    let exact = match arch {
        "aarch64" => apk.arm64.trim(),
        "arm" | "armv7" | "armv7l" => apk.arm.trim(),
        _ => "",
    };
    if !exact.is_empty() {
        return exact.to_string();
    }
    if !apk.universal.trim().is_empty() {
        return apk.universal.trim().to_string();
    }
    if !apk.arm64.trim().is_empty() {
        return apk.arm64.trim().to_string();
    }
    apk.arm.trim().to_string()
}

/// 用固定的 Release 附件直链前缀拼出 APK 地址。
/// 清单里 `apk.*` 允许只填文件名（更省事、也不怕以后换域名），这里补全。
pub fn resolve_download(prefix: &str, value: &str) -> String {
    let raw = value.trim();
    if raw.is_empty() {
        return String::new();
    }
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    format!("{}/{}", prefix.trim_end_matches('/'), raw.trim_start_matches('/'))
}

/// 从任意 JSON 值里读清单：兼容「对象本身」与「数组里的第一个元素」。
/// 兼容数组是为了以后万一改成查询 Release 列表接口也不会炸。
pub fn parse_manifest(value: &Value) -> Result<UpdateManifest, String> {
    let object = match value {
        Value::Array(items) => items.first().ok_or("更新清单是空数组")?,
        other => other,
    };
    serde_json::from_value(object.clone()).map_err(|e| format!("更新清单格式不对：{}", e))
}

/* ==========================================================================
   网络
   ========================================================================== */

/// 拉取更新清单。
///
/// 自建服务器直接返回 JSON，没有重定向；reqwest 默认也是跟随的，不用特殊处理。
/// 但没有发布记录时返回 404，所以这里单独把 404 说明白。
///
/// ## TLS 信任锚：只用我们自己那张自签 CA
///
/// 注意 `tls_built_in_root_certs(false)` —— 关掉 reqwest 内置的所有根证书，
/// 再用 `add_root_certificate` 只加我们这一张。这样客户端不再看系统 CA 库，
/// 也不看 `webpki-roots`，彻底免疫各家信任库收录进度不一致的问题。
/// 详见 `TRUSTED_CA_PEM` 的注释。
pub async fn fetch_manifest(url: &str) -> Result<UpdateManifest, String> {
    let ca = reqwest::Certificate::from_pem(TRUSTED_CA_PEM.as_bytes())
        .map_err(|e| format!("内置的根证书无法解析（构建有问题）：{}", e))?;

    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        // 关掉内置根证书，改为「只信任我们自己的根 CA」。
        // 顺序要紧：先关内置、再 add_root_certificate。
        .tls_built_in_root_certs(false)
        .add_root_certificate(ca)
        // 只用 HTTP/1.1。
        //
        // 清单只有 300 多字节，h2 的多路复用毫无收益；而 h2 协商（ALPN + SETTINGS）
        // 反而多一轮往返、也多一处可能出问题的地方 —— 实测在移动网络上撞到过
        // TLS 层 `bad key share` 导致整个请求失败（`error sending request`）。
        // 降成 h1 后链路最短、最容易排查。
        .http1_only()
        .user_agent("ai-ledger-updater")
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{}", e))?;

    let response = http
        .get(url)
        .send()
        .await
        .map_err(|e| describe_request_error(url, &e))?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("更新服务器上还没有发布记录".into());
    }
    if !status.is_success() {
        return Err(format!("更新服务器返回 HTTP {}", status));
    }

    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("更新清单不是合法 JSON：{}", e))?;
    parse_manifest(&body)
}

/// 把 `reqwest` 的失败翻译成人能看懂的话。
///
/// reqwest 的 `Display` 往往只有一句 `error sending request for url (...)`，
/// **真正的线索全埋在 `source()` 链里**（TLS 握手失败 / DNS 解析失败 / 连接超时
/// 都会长成这样）。此前只透出最外层，导致「连不上」这种没法排查的提示 ——
/// 现在把整条 source 链拼出来。
fn describe_request_error(url: &str, error: &reqwest::Error) -> String {
    // 逐层往下取 source，**先收集成 String 再拼** —— 直接把 &dyn Error 串起来会
    // 撞生命周期（每层的引用寿命绑在上一层上，`while let` 收不住）。
    let mut parts = vec![error.to_string()];
    // 完全限定写 `std::error::Error`：这个模块顶部没有 `use std::error::Error`
    // （引进来容易和 serde 的 trait 命名打架），这里也就一处用到。
    let mut current: &(dyn std::error::Error + 'static) = error;
    while let Some(inner) = current.source() {
        let text = inner.to_string();
        if !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
        current = inner;
    }
    let detail = parts.join(" ← ");

    // 按最常见的几种原因给出下一步，别让用户对着英文报错发呆。
    let lower = detail.to_lowercase();
    let hint = if lower.contains("certificate") || lower.contains("unknownissuer") {
        "证书校验失败。若浏览器能打开该地址，多是客户端的根证书列表没跟上 —— 升级到最新版 App 再试。"
    } else if lower.contains("dns") || lower.contains("name or service") || lower.contains("lookup") {
        "域名解析失败，检查手机网络（换 WiFi / 关掉代理或 VPN 再试）。"
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "连接超时，可能是当前网络屏蔽了该端口，换个网络再试。"
    } else {
        return format!(
            "连不上更新服务器：{}\n错误详情：{}\n可以先到发布页手动下载：{}",
            url, detail, RELEASES_PAGE
        );
    };

    format!("连不上更新服务器：{}\n错误详情：{}\n{}", url, detail, hint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn releases_page_matches_constant() {
        assert_eq!(releases_page(), RELEASES_PAGE);
    }

    /// 返回给前端的字段名必须是 camelCase。
    ///
    /// 这条是拿真实事故换来的：漏了 `rename_all` 时，App 能连上、能验签、
    /// 能拿到最新的 0.1.7 清单，却因为读不到 `hasUpdate`（实际是 `has_update`）
    /// 而一直显示「已是最新」，且**不报任何错**，排查成本极高。
    #[test]
    fn update_check_result_uses_camel_case() {
        let json = serde_json::to_value(UpdateCheckResult {
            ok: true,
            message: "m".into(),
            latest_version: "0.1.7".into(),
            current_version: "0.1.6".into(),
            has_update: true,
            notes: "n".into(),
            download_url: "d".into(),
            page_url: "p".into(),
            hint: "h".into(),
        })
        .expect("序列化不该失败");

        // 前端读的就是这几个名字，一个都不能变
        for key in [
            "hasUpdate",
            "latestVersion",
            "currentVersion",
            "downloadUrl",
            "pageUrl",
        ] {
            assert!(json.get(key).is_some(), "返回体缺少 camelCase 字段 {key}");
        }
        // 反过来，snake_case 不该出现在返回体里
        for key in ["has_update", "latest_version", "current_version", "download_url"] {
            assert!(
                json.get(key).is_none(),
                "返回体不该出现 snake_case 字段 {key}（前端读不到）"
            );
        }
    }

    #[test]
    fn update_source_is_self_hosted_https() {
        // 更新源必须是**自建服务器的域名**，且走 HTTPS。
        //
        // 这里刻意断言**不含 gitee.com** —— 之前挂 Gitee 时读清单要过两级 302
        // 跳到带临时 token 的 CDN（foruda.gitee.com），手机移动网络下经常超时，
        // 表现就是「点了检查更新但检测不到新版本」。如果有人「顺手改回 Gitee」，
        // 必须让这条测试红。
        for (label, url) in [
            ("MANIFEST_URL", MANIFEST_URL),
            ("DOWNLOAD_PREFIX", DOWNLOAD_PREFIX),
            ("RELEASES_PAGE", RELEASES_PAGE),
        ] {
            assert!(
                !url.contains("gitee.com"),
                "{label} 不该再指 Gitee：{url}"
            );
            assert!(
                url.starts_with("https://"),
                "{label} 必须走 HTTPS（Android 默认拦明文 HTTP）：{url}"
            );
            assert!(
                url.contains(UPDATE_HOST),
                "{label} 必须指向 {UPDATE_HOST}：{url}"
            );
        }

        // ## 端口分工：清单/APK 走 9443（自签），下载页走 9444（Let's Encrypt）
        //
        // 这两个端口**不能互换**：
        // - :9443 是自签证书 —— App 内置了根 CA 才认，**浏览器不认**；
        // - :9444 是 Let's Encrypt —— 浏览器零警告。
        //
        // 清单与 APK 必须是 9443（App 走内置信任锚）；下载页给浏览器看，必须 9444。
        // 写反的话症状是「App 更新好了但点开下载页弹证书警告」（或反过来）。
        assert!(
            MANIFEST_URL.contains(":9443") && DOWNLOAD_PREFIX.contains(":9443"),
            "清单与 APK 必须走 :9443（自签，App 内置根 CA）：{MANIFEST_URL}"
        );
        assert!(
            RELEASES_PAGE.contains(":9444"),
            "下载页必须走 :9444（Let's Encrypt，浏览器不认自签）：{RELEASES_PAGE}"
        );
        assert!(
            !RELEASES_PAGE.contains(":9443"),
            "下载页不能是 :9443 —— 浏览器会警告证书不受信任：{RELEASES_PAGE}"
        );
    }

    #[test]
    fn update_host_is_punycode() {
        // 域名是中文的 `电脑.tech`。这里必须写 punycode 形式 ——
        // 部分运行时对 IDN 的处理不一致，写中文可能连不上。
        assert_eq!(UPDATE_HOST, "apk.xn--wnyy6w.tech");
        assert!(
            UPDATE_HOST.is_ascii(),
            "更新源域名必须是 ASCII（punycode）：{UPDATE_HOST}"
        );
        // 光比对字面量不够：`xn--` 前缀后是一段 base36，**很容易抄错且肉眼看不出来**
        // （曾经把 `电脑` 写成 `xn--nyqx68a`，那其实是 `徳健`，等于指向一个不存在的域名）。
        // 这里用 punycode 算法从字面量推导一遍，确认它确实代表 `电脑`。
        assert_eq!(
            decode_punycode_label("xn--wnyy6w"),
            "电脑",
            "更新源域名的 punycode 解不出 `电脑` —— 常量抄错了"
        );
    }

    /// 手写的 base64 / SHA-256 是给下面的指纹断言用的 —— 它们自己先得是对的。
    ///
    /// 不然「哈希实现写错 → 指纹断言也对错了值 → 测试全绿」这种假通过最坑。
    /// 这里用公开的标准向量钉一下。
    #[test]
    fn test_helpers_are_correct() {
        // SHA-256 标准向量
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
        // base64 标准向量：覆盖 1/2/3 字节尾组 + 跨组（8 字节 → 两组以上）
        assert_eq!(base64_decode("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(base64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(base64_decode("YQ==").unwrap(), b"a");
        assert_eq!(base64_decode("YWI=").unwrap(), b"ab");
        assert_eq!(base64_decode("YWJjZA==").unwrap(), b"abcd");
        assert_eq!(base64_decode("aGVsbG8gd29ybGQ=").unwrap(), b"hello world");
        // 单独的 1 个字符不是合法 base64 组 → 应当返回 None 而不是静默出错
        assert!(base64_decode("a").is_none());
        // 来回一趟 PEM 的正文：解出来的 DER 要能重新算出同一个指纹长度
        let der = pem_to_der(TRUSTED_CA_PEM).expect("内置证书 PEM 解不出 DER");
        assert!(der.len() > 500, "CA 证书的 DER 不该这么短：{}", der.len());
        assert_eq!(der[0], 0x30, "DER 应当以 SEQUENCE(0x30) 开头");
        assert_eq!(der[1] & 0x80, 0x80, "证书 DER 用长格式长度（与真实文件一致）");
    }

    /// 内置的根 CA 必须**确实是那张签发服务器证书的 CA**。
    ///
    /// 这条测试很关键：服务器换成自签证书后，App 侧只信任 `certs/apk-ca.crt`。
    /// 万一有人换了服务器证书却没同步更新这个文件（或反过来），App 会静默地
    /// 「永远连不上更新服务器」，而错误信息只有一句 TLS 校验失败 —— 极难归因。
    /// 这里把固定的指纹钉住，任何一方改动都会立刻让测试红。
    #[test]
    fn trusted_ca_is_our_self_signed_root() {
        // PEM 结构：必须是单张证书、标准头尾
        assert!(
            TRUSTED_CA_PEM.contains("-----BEGIN CERTIFICATE-----")
                && TRUSTED_CA_PEM.contains("-----END CERTIFICATE-----"),
            "内置根证书不是合法 PEM"
        );
        assert_eq!(
            TRUSTED_CA_PEM.matches("-----BEGIN CERTIFICATE-----").count(),
            1,
            "内置根证书文件里应当只有一张证书（多了说明误把中间证书/链塞进来了）"
        );
        // 交给 reqwest 解析一遍，确保它能被真正用起来（不只是长得像 PEM）
        reqwest::Certificate::from_pem(TRUSTED_CA_PEM.as_bytes())
            .expect("内置根证书 reqwest 解析失败 —— App 会因此连不上更新服务器");

        // 证书主题要能对上，避免「拿错了别的证书」
        let subject = extract_pem_subject_cn(TRUSTED_CA_PEM);
        assert_eq!(
            subject.as_deref(),
            Some("ai-ledger APK Distribution CA"),
            "内置根证书的主题不对，可能拿错了文件"
        );

        // DER 的 SHA-256 指纹钉死。改这张证书（或它在服务器上被重签）时必须同步改这里，
        // **顺便也就强制了「换证书 = 改测试 = 重新发版」这个流程**。
        assert_eq!(
            sha256_fingerprint_hex(TRUSTED_CA_PEM).as_deref(),
            Some("dbfa05c10ef8bce10583d6850a2d6fef511abef4d474c75866210d5659bbfabe"),
            "内置根证书指纹变了。若确实换了证书，请同步更新这条断言（它是有意为之的护栏）"
        );
    }

    /// PEM → DER 的 SHA-256 十六进制指纹（小写、无分隔）。
    fn sha256_fingerprint_hex(pem: &str) -> Option<String> {
        let der = pem_to_der(pem)?;
        Some(sha256_hex(&der))
    }

    /// 从 PEM 里取 subject 的 CN（只用于测试自检）。
    ///
    /// 做法：PEM → DER，然后在 DER 里搜明文的 CN 值 —— 证书里 CN 是
    /// UTF8String/PrintableString 存的原文明文，能直接子串命中。
    /// 不引 x509 解析库：这里只是「确认拿对了文件」，不值得多一个依赖。
    fn extract_pem_subject_cn(pem: &str) -> Option<String> {
        let der = pem_to_der(pem)?;
        let haystack = String::from_utf8_lossy(&der);
        for candidate in ["ai-ledger APK Distribution CA", "apk.xn--wnyy6w.tech"] {
            if haystack.contains(candidate) {
                return Some(candidate.to_string());
            }
        }
        None
    }

    /// PEM 文本 → DER 字节。
    fn pem_to_der(pem: &str) -> Option<Vec<u8>> {
        let body: String = pem
            .lines()
            .map(|line| line.trim())
            .filter(|line| !line.starts_with("-----") && !line.is_empty())
            .collect();
        base64_decode(&body)
    }

    /// 标准 base64 解码（只做标准字母表，容忍 `=` 填充与内部换行）。
    fn base64_decode(text: &str) -> Option<Vec<u8>> {
        fn value(c: u8) -> Option<u8> {
            match c {
                b'A'..=b'Z' => Some(c - b'A'),
                b'a'..=b'z' => Some(c - b'a' + 26),
                b'0'..=b'9' => Some(c - b'0' + 52),
                b'+' => Some(62),
                b'/' => Some(63),
                _ => None,
            }
        }
        let clean: Vec<u8> = text
            .bytes()
            .filter(|b| !b.is_ascii_whitespace() && *b != b'=')
            .collect();
        let mut out = Vec::with_capacity(clean.len() / 4 * 3);
        for chunk in clean.chunks(4) {
            if chunk.len() == 1 {
                return None; // 单个字符不构成合法 base64 组
            }
            // 每组 4 个 base64 字符 → 24 位 → 最多 3 字节。
            // **每组独立累加** —— 之前把 `n` 写在循环外没重置，导致跨组串味。
            let mut n: u32 = 0;
            for &byte in chunk {
                n = (n << 6) | u32::from(value(byte)?);
            }
            // 补齐到 4 组（24 位），这样数据正好落在 u32 的低 24 位 → 取 to_be_bytes()[1..]
            n <<= 6 * (4 - chunk.len());
            let bytes = n.to_be_bytes();
            let count = chunk.len() - 1; // 2→1、3→2、4→3
            out.extend_from_slice(&bytes[1..=count]);
        }
        Some(out)
    }

    /// SHA-256（纯标准库实现，FIPS 180-4）。
    ///
    /// 只为了在单测里算个指纹，**不值得为此引一个 sha2 依赖**（那会白白增大
    /// 二进制，而这个逻辑退役后没有任何运行时开销）。
    fn sha256_hex(data: &[u8]) -> String {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
            0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
            0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
            0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
            0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
            0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
            0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
            0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
            0xc67178f2,
        ];
        let mut h: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];

        let mut message = data.to_vec();
        let bit_len = (data.len() as u64) * 8;
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&bit_len.to_be_bytes());

        for block in message.chunks(64) {
            let mut w = [0u32; 64];
            for (i, chunk) in block.chunks(4).enumerate() {
                w[i] = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7)
                    ^ w[i - 15].rotate_right(18)
                    ^ (w[i - 15] >> 3);
                let s1 =
                    w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }

            let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
                (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ ((!e) & g);
                let temp1 = hh
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let temp2 = s0.wrapping_add(maj);

                hh = g;
                g = f;
                f = e;
                e = d.wrapping_add(temp1);
                d = c;
                c = b;
                b = a;
                a = temp1.wrapping_add(temp2);
            }
            h[0] = h[0].wrapping_add(a);
            h[1] = h[1].wrapping_add(b);
            h[2] = h[2].wrapping_add(c);
            h[3] = h[3].wrapping_add(d);
            h[4] = h[4].wrapping_add(e);
            h[5] = h[5].wrapping_add(f);
            h[6] = h[6].wrapping_add(g);
            h[7] = h[7].wrapping_add(hh);
        }

        h.iter().map(|word| format!("{word:08x}")).collect()
    }

    /// RFC 3492 punycode 解码（只做单个标签，够校验用）。
    ///
    /// 只依赖标准库，不引第三方 crate：这点逻辑不值得多一个依赖。
    fn decode_punycode_label(label: &str) -> String {
        let body = label.strip_prefix("xn--").expect("应当带 xn-- 前缀");
        // 最后一个 '-' 之前是 ASCII 基本码点，之后是增量编码
        let (basic, encoded) = match body.rfind('-') {
            Some(i) => (&body[..i], &body[i + 1..]),
            None => ("", body),
        };
        let mut output: Vec<char> = basic.chars().collect();
        if encoded.is_empty() {
            return output.into_iter().collect();
        }

        const BASE: u32 = 36;
        const TMIN: u32 = 1;
        const TMAX: u32 = 26;
        const SKEW: u32 = 38;
        const DAMP: u32 = 700;
        const INITIAL_BIAS: u32 = 72;
        const INITIAL_N: u32 = 128;

        let digit = |c: char| -> u32 {
            match c {
                'a'..='z' => c as u32 - 'a' as u32,
                'A'..='Z' => c as u32 - 'A' as u32,
                '0'..='9' => c as u32 - '0' as u32 + 26,
                _ => panic!("非法 punycode 字符：{c}"),
            }
        };

        let mut n = INITIAL_N;
        let mut i: u32 = 0;
        let mut bias = INITIAL_BIAS;
        let mut chars = encoded.chars().peekable();

        while chars.peek().is_some() {
            let old_i = i;
            let mut w: u32 = 1;
            let mut k = BASE;
            loop {
                let c = chars.next().expect("punycode 增量编码被截断");
                let d = digit(c);
                i += d * w;
                let t = if k <= bias {
                    TMIN
                } else if k >= bias + TMAX {
                    TMAX
                } else {
                    k - bias
                };
                if d < t {
                    break;
                }
                w *= BASE - t;
                k += BASE;
            }
            let len = output.len() as u32 + 1;
            bias = {
                let num = if i / len == 0 { 1 } else { i / len } + 1;
                let num = num * (BASE - TMIN) / (i - old_i + num * (BASE - TMIN));
                DAMP * num + (DAMP * num) / (i - old_i + 1)
            };
            // 插到 i % len 位置（i 是 0-based 累积偏移）
            n += i / len;
            i %= len;
            output.insert(i as usize, char::from_u32(n).expect("非法码点"));
            i += 1;
        }
        output.into_iter().collect()
    }

    #[test]
    fn punycode_decoder_works() {
        // 顺手把解码器本身钉一下，免得它写错了反而让上面那个断言看着「通过」
        assert_eq!(decode_punycode_label("xn--wnyy6w"), "电脑");
        // 同一个域名整体解出来应当拼回中文
        assert_eq!(
            domain_to_unicode(UPDATE_HOST),
            "apk.电脑.tech",
            "更新源域名解出来不是 apk.电脑.tech"
        );
    }

    /// 把 punycode 域名逐标签解回 Unicode（只认 `xn--` 标签，其余原样）。
    fn domain_to_unicode(host: &str) -> String {
        host.split('.')
            .map(|label| {
                if label.starts_with("xn--") {
                    decode_punycode_label(label)
                } else {
                    label.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join(".")
    }

    #[test]
    fn resolve_download_keeps_absolute_url() {
        // 清单里给的是完整 URL，拼接前缀不能把它改坏
        assert_eq!(
            resolve_download("https://apk.xn--wnyy6w.tech", "https://apk.xn--wnyy6w.tech/app-arm64-release.apk"),
            "https://apk.xn--wnyy6w.tech/app-arm64-release.apk"
        );
        assert_eq!(
            resolve_download("https://x", "https://a.example/b.apk"),
            "https://a.example/b.apk"
        );
        // 相对文件名才拼前缀
        assert_eq!(resolve_download("https://x/", "/app.apk"), "https://x/app.apk");
        assert_eq!(resolve_download("https://x", "app.apk"), "https://x/app.apk");
        assert_eq!(resolve_download("https://x", "  "), "");
    }

    #[test]
    fn version_compare_basic() {
        assert_eq!(compare_versions("0.1.1", "0.1.0"), Greater);
        assert_eq!(compare_versions("v0.1.1", "0.1.0"), Greater);
        assert_eq!(compare_versions("0.1.0", "0.1.0"), Equal);
        assert_eq!(compare_versions("0.0.9", "0.1.0"), Less);
        assert_eq!(compare_versions("0.10", "0.9.9"), Greater);
        assert_eq!(compare_versions("1.0", "0.99.99"), Greater);
        // 段数不同：0.1 与 0.1.0 等价
        assert_eq!(compare_versions("0.1", "0.1.0"), Equal);
    }

    #[test]
    fn version_compare_prerelease() {
        assert_eq!(compare_versions("0.2.0-beta", "0.2.0"), Less);
        assert_eq!(compare_versions("0.2.0", "0.2.0-beta"), Greater);
        assert_eq!(compare_versions("0.2.0-beta", "0.2.0-beta.2"), Equal);
    }

    #[test]
    fn is_newer_flag() {
        assert!(is_newer("0.1.1", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }

    #[test]
    fn abi_pick() {
        let apk = ApkUrls {
            arm64: "a64.apk".into(),
            arm: "a32.apk".into(),
            universal: String::new(),
        };
        assert_eq!(pick_download_url(&apk, "aarch64"), "a64.apk");
        assert_eq!(pick_download_url(&apk, "arm"), "a32.apk");
        // 未知 ABI → 退回 arm64
        assert_eq!(pick_download_url(&apk, "x86_64"), "a64.apk");

        let uni = ApkUrls {
            arm64: String::new(),
            arm: String::new(),
            universal: "u.apk".into(),
        };
        assert_eq!(pick_download_url(&uni, "aarch64"), "u.apk");
    }

    #[test]
    fn download_url_resolution() {
        let prefix = "https://gitee.com/o/r/releases/download/latest";
        // 只给文件名 → 补成完整直链
        assert_eq!(
            resolve_download(prefix, "app-arm64-release.apk"),
            "https://gitee.com/o/r/releases/download/latest/app-arm64-release.apk"
        );
        // 已经给了绝对地址 → 原样保留
        assert_eq!(
            resolve_download(prefix, "https://cdn.example.com/a.apk"),
            "https://cdn.example.com/a.apk"
        );
        // 空值 → 空
        assert_eq!(resolve_download(prefix, "   "), "");
    }

    #[test]
    fn manifest_download_url_for() {
        let manifest = UpdateManifest {
            schema: 1,
            version: "0.1.1".into(),
            notes: String::new(),
            apk: ApkUrls {
                arm64: "a64.apk".into(),
                arm: "a32.apk".into(),
                universal: String::new(),
            },
            page_url: String::new(),
            published_at: String::new(),
        };
        assert_eq!(
            manifest.download_url_for("aarch64"),
            "https://gitee.com/yykzz/jizhang/releases/download/latest/a64.apk"
        );
        assert_eq!(
            manifest.download_url_for("arm"),
            "https://gitee.com/yykzz/jizhang/releases/download/latest/a32.apk"
        );

        // 完全没有 APK 信息 → 兜底到发布页
        let empty = UpdateManifest {
            schema: 1,
            version: "0.1.1".into(),
            notes: String::new(),
            apk: ApkUrls::default(),
            page_url: String::new(),
            published_at: String::new(),
        };
        assert_eq!(empty.download_url_for("aarch64"), RELEASES_PAGE);
    }

    #[test]
    fn manifest_from_object_and_array() {
        let object = serde_json::json!({"version": "0.1.1", "apk": {"arm64": "a"}});
        assert_eq!(parse_manifest(&object).unwrap().version, "0.1.1");

        let array = serde_json::json!([{"version": "0.1.2"}]);
        assert_eq!(parse_manifest(&array).unwrap().version, "0.1.2");

        assert!(parse_manifest(&serde_json::json!([])).is_err());
    }
}
