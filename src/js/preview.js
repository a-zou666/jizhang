/**
 * 图片预览：点对话气泡里的图 → 全屏浮层看大图。
 *
 * 为什么不用模态弹窗那套（ui.js 的 openModal）：那是「对话框」语义 ——
 * 带面板内边距、可点遮罩关闭、还会记录 onClose 回调。看大图要的是**纯黑底 +
 * 图片居中铺满**，且希望点**任意位置**都能关（包括图片自己），跟相册一致。
 * 单独一个浮层更简单，也不会和对话页的弹窗状态互相干扰。
 *
 * 浮层平时不存在的，第一次点图才创建，之后复用同一个节点。
 */

let overlay = null;
let currentList = [];
let currentIndex = 0;

/** 只有能按下的图片才配预览：data URL 才算数，空串/外链一律忽略 */
export function isPreviewable(src) {
  return typeof src === "string" && src.startsWith("data:image/");
}

function ensureOverlay() {
  if (overlay?.isConnected) return overlay;

  overlay = document.createElement("div");
  overlay.classList.add("image-viewer");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "图片预览");
  overlay.hidden = true;

  // 图片本体：点击不冒泡到遮罩（否则点图会立刻关掉，用户根本看不清）
  const image = document.createElement("img");
  image.classList.add("image-viewer__img");
  image.alt = "预览图片";
  image.addEventListener("click", (event) => event.stopPropagation());

  // 关掉按钮：图标是「×」，放右上角，和系统图片查看器习惯一致
  const close = document.createElement("button");
  close.classList.add("image-viewer__close");
  close.type = "button";
  close.setAttribute("aria-label", "关闭预览");
  close.textContent = "×";
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closePreview();
  });

  // 多张时给左右切换 + 计数
  const counter = document.createElement("span");
  counter.classList.add("image-viewer__counter");

  const prev = document.createElement("button");
  prev.classList.add("image-viewer__nav", "is-prev");
  prev.type = "button";
  prev.setAttribute("aria-label", "上一张");
  prev.textContent = "‹";
  prev.addEventListener("click", (event) => {
    event.stopPropagation();
    step(-1);
  });

  const next = document.createElement("button");
  next.classList.add("image-viewer__nav", "is-next");
  next.type = "button";
  next.setAttribute("aria-label", "下一张");
  next.textContent = "›";
  next.addEventListener("click", (event) => {
    event.stopPropagation();
    step(1);
  });

  // 点遮罩任意处关闭（点图片已被图片自己拦下）
  overlay.addEventListener("click", closePreview);
  overlay.append(image, close, prev, next, counter);
  document.body.append(overlay);

  return overlay;
}

/** 上一张 / 下一张；只有一张时按钮不显示，这里也不会被触发 */
function step(delta) {
  if (currentList.length < 2) return;
  currentIndex = (currentIndex + delta + currentList.length) % currentList.length;
  paint();
}

function paint() {
  if (!overlay) return;
  const image = overlay.querySelector(".image-viewer__img");
  const counter = overlay.querySelector(".image-viewer__counter");
  const multi = currentList.length > 1;

  image.src = currentList[currentIndex] ?? "";
  counter.textContent = multi ? `${currentIndex + 1} / ${currentList.length}` : "";
  counter.hidden = !multi;
  overlay.querySelector(".is-prev").hidden = !multi;
  overlay.querySelector(".is-next").hidden = !multi;
}

/**
 * 打开预览。
 * @param {string[]} sources 可预览的图片地址（data URL）
 * @param {number} index 从第几张开始
 */
export function openPreview(sources, index = 0) {
  const list = (sources ?? []).filter(isPreviewable);
  if (!list.length) return;

  currentList = list;
  currentIndex = Math.min(Math.max(0, Number(index) || 0), list.length - 1);

  const node = ensureOverlay();
  paint();
  node.hidden = false;
  // 打开期间锁住底层页面滚动，免得滑动时聊天列表跟着动
  document.body.classList.add("is-viewing-image");
}

export function closePreview() {
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  overlay.querySelector(".image-viewer__img").src = "";
  currentList = [];
  currentIndex = 0;
  document.body.classList.remove("is-viewing-image");
}

/** Esc 关闭；左右方向键切换。绑在 document 上，一次注册全程有效 */
export function bindPreviewKeys(target = document) {
  target.addEventListener("keydown", (event) => {
    if (!overlay || overlay.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closePreview();
    } else if (event.key === "ArrowLeft") {
      step(-1);
    } else if (event.key === "ArrowRight") {
      step(1);
    }
  });
}

export const __testing = { isPreviewable };
