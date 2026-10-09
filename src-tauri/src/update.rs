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

/// Gitee 仓库坐标。清单（`latest.json`）就挂在这个仓库的 Release 附件里，
/// 换仓库只改这里两行（下面的地址常量是它的展开，Rust 的 const 不能拼接
/// 字符串，所以那些地址仍是字面量 —— 改仓库时记得同步改）。
pub const GITEE_OWNER: &str = "yykzz";
pub const GITEE_REPO: &str = "jizhang";

/// 更新清单地址：固定指向 Release 附件 `latest.json`。
///
/// 用「固定文件名的 Release 附件」而不是查询 Release 列表接口，原因是
/// 列表接口返回数组、附件地址还要再拼一次，而且每个 tag 名字可能不同；
/// 固定附件名让 App 端永远只认一个 URL。仓库公开时该地址匿名可下。
///
/// **清单留在 Gitee 是刻意的**：这个文件只有几百字节，Gitee 秒传，而国内
/// 直连 Gitee 又快又稳。它只负责「告诉 App 有新版本、去哪儿下」。
///
/// tag 用固定的 `latest`（发布流程每次更新同一个 Release），这样清单地址
/// 永远不变，App 端不用跟着版本号改代码。
pub const MANIFEST_URL: &str = "https://gitee.com/yykzz/jizhang/releases/download/latest/latest.json";

/// APK 直链前缀（**香港中转机**，不是 Gitee）。
///
/// 为什么 APK 不放在 Gitee：实测 Gitee 的附件**上传**接口只有 10~50 KB/s
/// （同一台机器传 GitHub 有 876 KB/s，从 Gitee **下载**也有 463 KB/s），
/// 一个 8MB 的包要传好几分钟还常超时。慢的是 Gitee 的附件服务本身，不是跨境。
///
/// 所以改成：CI 只把 APK 传 GitHub Release（快）→ 香港机器定时拉取并挂到
/// 自己的 nginx（上行 43MB/s）→ 只把几百字节的 `latest.json` 推给 Gitee。
/// 详见仓库 `scripts/mirror-apk-to-hk.mjs` 与 README「更新链路」。
///
/// 正常情况下清单里的 `apk.arm64` / `apk.arm` 已经是**完整地址**，用不到这个
/// 前缀；它只在清单缺地址时的兜底路径上生效。
pub const DOWNLOAD_PREFIX: &str = "http://104.208.75.62:9443";

/// 发布页（找不到具体附件时兜底）。仍指向 Gitee —— 国内可达。
pub const RELEASES_PAGE: &str = "https://gitee.com/yykzz/jizhang/releases";

/// 发布页地址。由仓库坐标拼出来 —— 这样 `GITEE_OWNER` / `GITEE_REPO`
/// 是「活」的常量，改一处就能影响展示，不用去翻下面的字面量。
pub fn releases_page() -> String {
    format!("https://gitee.com/{}/{}/releases", GITEE_OWNER, GITEE_REPO)
}

/// 拉清单的超时：国内直连 Gitee 很快，给 20s 已经很宽裕
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
/// Gitee 的附件下载会 302 跳到对象存储，reqwest 默认跟随重定向，不用特殊处理。
/// 但没有 Release 时 Gitee 返回的是 HTML 404 页面，所以这里单独把 404 说明白。
pub async fn fetch_manifest(url: &str) -> Result<UpdateManifest, String> {
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
        .user_agent("ai-ledger-updater")
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{}", e))?;

    let response = http
        .get(url)
        .send()
        .await
        .map_err(|e| format!("连不上更新服务器：{}", e))?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering::*;

    #[test]
    fn releases_page_matches_constant() {
        // 防止「改仓库坐标忘了改字面量」：两者必须永远一致
        assert_eq!(releases_page(), RELEASES_PAGE);
        assert!(MANIFEST_URL.starts_with(&format!(
            "https://gitee.com/{}/{}",
            GITEE_OWNER, GITEE_REPO
        )));
    }

    #[test]
    fn download_prefix_points_to_hk_mirror() {
        // APK 本体走香港中转机（Gitee 附件上传只有 10~50KB/s，放不住大文件）。
        // 这里刻意断言**不是** Gitee —— 如果有人「顺手改回去」，必须让测试红，
        // 否则又会退回到「一个包传好几分钟」的老路。
        assert!(
            !DOWNLOAD_PREFIX.contains("gitee.com"),
            "APK 直链前缀不该再指 Gitee：{DOWNLOAD_PREFIX}"
        );
        assert!(
            DOWNLOAD_PREFIX.starts_with("http://") || DOWNLOAD_PREFIX.starts_with("https://"),
            "直链前缀必须是完整地址：{DOWNLOAD_PREFIX}"
        );
        // 清单地址仍留在 Gitee（几百字节，秒传，国内可达）
        assert!(MANIFEST_URL.contains("gitee.com"));
    }

    #[test]
    fn resolve_download_keeps_absolute_url() {
        // 中转机清单里给的是完整 URL，拼接前缀不能把它改坏
        assert_eq!(
            resolve_download("http://104.208.75.62:9443", "http://104.208.75.62:9443/app-arm64-release.apk"),
            "http://104.208.75.62:9443/app-arm64-release.apk"
        );
        assert_eq!(
            resolve_download("http://x", "https://a.example/b.apk"),
            "https://a.example/b.apk"
        );
        // 相对文件名才拼前缀
        assert_eq!(resolve_download("http://x/", "/app.apk"), "http://x/app.apk");
        assert_eq!(resolve_download("http://x", "app.apk"), "http://x/app.apk");
        assert_eq!(resolve_download("http://x", "  "), "");
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
