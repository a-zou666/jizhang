/** 十二、软件更新：检查自建分发服务器上的新版本，并引导用户下载安装 */

import { checkUpdate } from "./bridge.js";
import { icon } from "./icons.js";
import {
  APP_VERSION,
  UPDATE_RELEASES_PAGE,
  cleanReleaseNotes,
  normalizeUpdateResult,
} from "./store.js";
import { closeModal, openModal, toast } from "./ui.js";
import { el, escapeHtml } from "./util.js";

/** 打开外部链接的超时：拉起浏览器是瞬时动作，超过这个时间一定是卡住了 */
const OPEN_TIMEOUT_MS = 8000;

/* ---------------- 入口：设置页那一行 ---------------- */

/**
 * 点「软件更新」做的事：先检查，再按结果弹窗。
 *
 * 为什么先弹一个「检查中」：清单要过一次网络（虽然只有几百字节），
 * 不给出反馈的话用户会以为按钮没反应，然后连点好几次。
 */
export async function openUpdatePanel() {
  showChecking();

  let result;
  try {
    result = normalizeUpdateResult(await checkUpdate(APP_VERSION), APP_VERSION);
  } catch (error) {
    result = normalizeUpdateResult(
      { ok: false, message: String(error?.message ?? error) },
      APP_VERSION,
    );
  }

  if (result.failed) {
    showFailure(result);
    return;
  }
  if (result.hasUpdate) {
    showUpdateAvailable(result);
    return;
  }
  showUpToDate(result);
}

/** 「检查中…」（不可点遮罩关闭，避免误触中断） */
function showChecking() {
  openModal(
    `<p class="modal-title">检查更新</p>
     <div class="update-state">
       <span class="update-spinner" aria-hidden="true"></span>
       <p class="update-state__text">正在检查新版本…</p>
     </div>`,
    { dismissable: false },
  );
}

/** 已是最新 */
function showUpToDate(result) {
  openModal(
    `<p class="modal-title">已是最新</p>
     <div class="update-state">
       <span class="update-state__badge update-state__badge--ok">${icon("check", { size: 26 })}</span>
       <p class="update-state__text">当前版本 v${escapeHtml(result.currentVersion)}</p>
       <p class="update-state__hint">已经是最新版本，不需要更新</p>
     </div>
     <div class="modal-actions">
       <button class="primary-btn primary-btn--compact" id="updClose" type="button">知道了</button>
     </div>`,
    {
      onMount: (panel) => {
        panel.querySelector("#updClose").addEventListener("click", closeModal);
      },
    },
  );
}

/** 检查失败 */
function showFailure(result) {
  const hint = result.hint || `可以到发布页手动看看：${UPDATE_RELEASES_PAGE}`;
  openModal(
    `<p class="modal-title">检查更新失败</p>
     <div class="update-state">
       <span class="update-state__badge update-state__badge--warn">${icon("alert", { size: 26 })}</span>
       <p class="update-state__text">${escapeHtml(result.message || "没能获取版本信息")}</p>
       <p class="update-state__hint">${escapeHtml(hint)}</p>
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="updRetry" type="button">重试</button>
       <button class="primary-btn primary-btn--compact" id="updManual" type="button">手动查看</button>
     </div>`,
    {
      onMount: (panel) => {
        panel.querySelector("#updRetry").addEventListener("click", () => {
          closeModal();
          openUpdatePanel();
        });
        panel.querySelector("#updManual").addEventListener("click", () => {
          openExternal(UPDATE_RELEASES_PAGE);
        });
      },
    },
  );
}

/** 有新版本 */
function showUpdateAvailable(result) {
  const notes = cleanReleaseNotes(result.notes);
  const target = result.downloadUrl || result.pageUrl || UPDATE_RELEASES_PAGE;

  openModal(
    `<p class="modal-title">发现新版本</p>
     <div class="update-version">
       <span class="update-version__new">v${escapeHtml(result.latestVersion)}</span>
       <span class="update-version__old">当前 v${escapeHtml(result.currentVersion)}</span>
     </div>
     ${notes ? `<div class="update-notes">${escapeHtml(notes)}</div>` : ""}
     <p class="update-tip">
       点「立即下载」会用浏览器打开安装包链接，下载完点一下即可安装（升级不会清掉本机账目）。
     </p>
     <div class="modal-actions">
       <button class="ghost-btn" id="updLater" type="button">以后再说</button>
       <button class="primary-btn primary-btn--compact" id="updDownload" type="button">立即下载</button>
     </div>`,
    {
      onMount: (panel) => {
        panel.querySelector("#updLater").addEventListener("click", closeModal);
        const button = panel.querySelector("#updDownload");
        button.addEventListener("click", async () => {
          button.disabled = true;
          button.textContent = "正在打开…";
          const opened = await openExternal(target);
          // 无论成功与否都把弹窗关掉：成功时浏览器已经在下载了，
          // 失败时用户手上有 toast 提示，留着弹窗只会挡视线
          closeModal();
          if (opened) {
            toast("已打开下载链接，请在浏览器里完成下载", "ok", 3200);
          } else {
            toast(`没能自动打开浏览器，请手动访问：${target}`, "error", 6000);
          }
        });
      },
    },
  );
}

/* ---------------- 打开外部链接 ---------------- */

/**
 * 用系统浏览器打开链接。
 *
 * 两条路都试一遍，任一条成功即可：
 * 1. Tauri 的 opener 插件（`__TAURI__.opener.openUrl`）—— Android 上走系统 Intent，
 *    是官方推荐方式；
 * 2. `window.open` 兜底 —— 万一某个平台没有 opener（旧包 / 桌面调试），
 *    WebView 通常也会把新窗口请求交给系统浏览器。
 *
 * 注意不能用 `location.href = url`：那会把当前页面导航走，
 * 在 Tauri 里表现为「App 变成浏览器」，用户回不来。
 */
async function openExternal(url) {
  const target = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) return false;

  const opener = globalThis.__TAURI__?.opener;
  if (opener?.openUrl) {
    try {
      await withTimeout(Promise.resolve(opener.openUrl(target)), OPEN_TIMEOUT_MS);
      return true;
    } catch {
      /* 落到 window.open 再试一次 */
    }
  }

  try {
    const handle = window.open(target, "_blank", "noopener,noreferrer");
    // 有些 WebView 会返回 null 但依然打开了外部浏览器，所以 null 不当失败处理
    if (handle) handle.opener = null;
    return true;
  } catch {
    return false;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("打开超时")), ms)),
  ]);
}
