/** UI 通用件：Toast / 模态弹窗 / 飞入动效 / 触感 */

import { icon } from "./icons.js";
import { $, el, escapeHtml } from "./util.js";

/* ---------------- 图层开关（配合 CSS 过渡） ---------------- */
const REDUCED = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const SHEET_MS = REDUCED ? 0 : 250;

let hideTimer = null;

export function openLayer(node) {
  // 上一次关闭还没落地就又打开（弹窗之间连续跳转）时，取消那个隐藏动作
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  node.hidden = false;
  requestAnimationFrame(() => node.classList.add("is-open"));
}

export function closeLayer(node) {
  node.classList.remove("is-open");
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    node.hidden = true;
  }, SHEET_MS + 20);
}

/* ---------------- Toast ---------------- */
export function toast(message, type = "", duration = 2200) {
  const root = $("#toastRoot");
  const node = el("div", { class: `toast${type ? ` is-${type}` : ""}`, text: message });
  root.append(node);
  window.setTimeout(() => {
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), SHEET_MS + 60);
  }, duration);
  return node;
}

/* ---------------- 通用模态弹窗 ---------------- */
let onModalClose = null;

export function closeModal() {
  const root = $("#modalRoot");
  if (root.hidden) return;
  closeLayer(root);
  const callback = onModalClose;
  onModalClose = null;
  if (callback) callback();
}

/**
 * @param {string} html 面板内部 HTML
 * @param {{ onMount?: (panel: HTMLElement) => void, onClose?: () => void, dismissable?: boolean }} options
 */
export function openModal(html, options = {}) {
  const root = $("#modalRoot");
  const panel = $("#modalPanel");
  panel.innerHTML = html;
  onModalClose = options.onClose ?? null;
  root.dataset.dismissable = options.dismissable === false ? "no" : "yes";
  openLayer(root);
  requestAnimationFrame(() => options.onMount?.(panel));
}

$("#modalRoot")?.addEventListener("click", (event) => {
  const root = event.currentTarget;
  if (event.target === root && root.dataset.dismissable !== "no") closeModal();
});

/* ---------------- 选项选择弹窗 ---------------- */
/**
 * @param {{ title: string, options: Array<{value: string, title: string, desc?: string}>, value: string, onPick: (value: string) => void }} config
 */
export function pickOption({ title, options, value, onPick }) {
  const items = options
    .map(
      (option) => `
      <button class="option-item${option.value === value ? " is-selected" : ""}" data-value="${escapeHtml(option.value)}" type="button">
        <span class="option-item__body">
          <span class="option-item__title">${escapeHtml(option.title)}</span>
          ${option.desc ? `<span class="option-item__desc">${escapeHtml(option.desc)}</span>` : ""}
        </span>
        <span class="option-item__check" data-icon="check"></span>
      </button>`,
    )
    .join("");

  openModal(
    `<p class="modal-title">${escapeHtml(title)}</p>
     <div class="option-list">${items}</div>`,
    {
      onMount: (panel) => {
        panel.querySelectorAll("[data-icon]").forEach((node) => {
          node.innerHTML = icon(node.getAttribute("data-icon"), { size: 20 });
        });
        panel.querySelectorAll(".option-item").forEach((button) => {
          button.addEventListener("click", () => {
            closeModal();
            onPick(button.dataset.value);
          });
        });
      },
    },
  );
}

/* ---------------- 文本输入弹窗 ---------------- */
export function promptText({ title, value = "", placeholder = "", inputMode = "text", onConfirm }) {
  openModal(
    `<p class="modal-title">${escapeHtml(title)}</p>
     <div class="field-stack">
       <input class="settings-input" id="modalTextInput" value="${escapeHtml(value)}"
              placeholder="${escapeHtml(placeholder)}" inputmode="${inputMode}" />
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="modalCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="modalConfirm" type="button">确定</button>
     </div>`,
    {
      onMount: (panel) => {
        const input = panel.querySelector("#modalTextInput");
        input.focus();
        input.select?.();
        const submit = () => {
          const next = input.value.trim();
          closeModal();
          if (next) onConfirm(next);
        };
        panel.querySelector("#modalConfirm").addEventListener("click", submit);
        panel.querySelector("#modalCancel").addEventListener("click", closeModal);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") submit();
        });
      },
    },
  );
}

/* ---------------- 二次确认 ---------------- */
/**
 * @param {{ title: string, message?: string, confirmLabel?: string, danger?: boolean,
 *           onConfirm?: Function, onClose?: Function }} config
 *        onClose：确认框关闭（确认或取消都算）后回调。
 *        确认框复用的是同一个弹窗容器，会把下面那层弹窗覆盖掉，
 *        所以调用方可以用 onClose 把原来的弹窗按原样重开。
 */
export function confirmDialog({
  title,
  message,
  confirmLabel = "确定",
  danger = false,
  onConfirm,
  onClose,
}) {
  openModal(
    `<p class="modal-title">${escapeHtml(title)}</p>
     ${message ? `<p class="t-footnote" style="text-align:center;color:var(--text-secondary);margin-bottom:var(--space-4)">${escapeHtml(message)}</p>` : ""}
     <div class="modal-actions">
       <button class="ghost-btn" id="modalCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="modalConfirm" type="button"
         ${danger ? 'style="background:var(--color-danger)"' : ""}>${escapeHtml(confirmLabel)}</button>
     </div>`,
    {
      onClose: onClose ?? undefined,
      onMount: (panel) => {
        panel.querySelector("#modalConfirm").addEventListener("click", () => {
          closeModal();
          onConfirm?.();
        });
        panel.querySelector("#modalCancel").addEventListener("click", closeModal);
      },
    },
  );
}

/* ---------------- 十一、确认入账：飞入动效 ---------------- */
export function flyChip({ label, from, to, onFinish }) {
  const layer = $("#flyLayer");
  const chip = el("div", { class: "fly-chip", text: label });
  chip.style.left = `${from.x}px`;
  chip.style.top = `${from.y}px`;
  layer.append(chip);

  if (REDUCED) {
    chip.remove();
    onFinish?.();
    return;
  }

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const animation = chip.animate(
    [
      { transform: "translate(-50%, -50%) scale(1)", opacity: 1, offset: 0 },
      {
        transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55 - 26}px)) scale(0.92)`,
        opacity: 1,
        offset: 0.62,
      },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.35)`,
        opacity: 0,
        offset: 1,
      },
    ],
    { duration: 350, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)", fill: "forwards" },
  );
  animation.onfinish = () => {
    chip.remove();
    onFinish?.();
  };
}

export function pulseCell(cell) {
  if (!cell || REDUCED) return;
  cell.classList.remove("is-receiving");
  void cell.offsetWidth;
  cell.classList.add("is-receiving");
  window.setTimeout(() => cell.classList.remove("is-receiving"), 400);
}

export function haptic(pattern = 8) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 忽略：桌面端不支持 */
  }
}

export const motionMs = { sheet: SHEET_MS, page: REDUCED ? 0 : 300, cell: REDUCED ? 0 : 150 };
