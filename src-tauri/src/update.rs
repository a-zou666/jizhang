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
pub const MANIFEST_URL: &str = "https://apk.xn--wnyy6w.tech/latest.json";

/// APK 直链前缀。清单里若只给了文件名（没给完整地址），就用它拼。
pub const DOWNLOAD_PREFIX: &str = "https://apk.xn--wnyy6w.tech";

/// 发布页（找不到具体附件时兜底）。就是站点根目录。
pub const RELEASES_PAGE: &str = "https://apk.xn--wnyy6w.tech/";

/// 发布页地址（自建服务器，就是站点根）。
///
/// 保留成函数是为了不动调用方 —— `lib.rs` 里用它兜底提示文案。
pub fn releases_page() -> String {
    RELEASES_PAGE.to_string()
}

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
#[derive(Serialize, Debug, Clone)]
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
pub async fn fetch_manifest(url: &str) -> Result<UpdateManifest, String> {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
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
