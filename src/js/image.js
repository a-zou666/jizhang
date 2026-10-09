/**
 * 对话页识图记账：选图 → 压缩 → 生成「送模型的大图」「气泡缩略图」「预览图」
 *
 * 只压缩不上传：图片最终以 data URL 形式交给 Rust 端的 process_image，
 * 全程留在本机；消息里保存缩略图（气泡用）与预览图（点开看大图用），
 * 送模型的原图不入库 —— 否则 200 条消息能把 localStorage 撑爆。
 */

/** 送模型的最长边：再大也识别不出更多细节，只会白白多花 token */
const FULL_EDGE = 1280;
/** 气泡里显示的缩略图最长边 */
const THUMB_EDGE = 192;
/**
 * 点开预览用的中等图最长边。
 *
 * 取 720：小票 / 账单截图放大后字还能看清，体积又远小于 1280 的原图
 * （缩略图只有 192，直接拉大是糊的，没法当预览用）。
 */
const VIEW_EDGE = 720;
const FULL_QUALITY = 0.82;
const THUMB_QUALITY = 0.6;
const VIEW_QUALITY = 0.72;
/** 原图上限：超过就让用户换一张，避免大图把内存和 token 都吃光 */
export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("这张图片读不出来，换一张试试"));
    reader.readAsDataURL(file);
  });
}

function decode(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new globalThis.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("这张图片打不开，换一张试试"));
    image.src = dataUrl;
  });
}

/** 重编码：等比缩到 edge 以内并转成 JPEG；环境不支持 canvas 时返回 null（调用方退回原图） */
async function reencode(dataUrl, edge, quality) {
  const image = await decode(dataUrl);
  const width = Number(image.naturalWidth || image.width || 0);
  const height = Number(image.naturalHeight || image.height || 0);
  if (!width || !height) throw new Error("这张图片打不开，换一张试试");

  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext?.("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL?.("image/jpeg", quality);
  return typeof out === "string" && out.startsWith("data:image/") ? out : null;
}

export function isImageFile(file) {
  const type = String(file?.type ?? "");
  return !type || type.startsWith("image/");
}

/**
 * 从 <input type="file"> 的 change 事件里安全取出文件。
 *
 * 必须先把 FileList 拷成数组再清空 input：执行 `input.value = ""` 会立刻把
 * 同一个 FileList 清空（Chromium / Android WebView 都是这个行为），之后再读
 * 只剩空列表 —— 表现就是「选完图什么都没发生」，而且没有任何报错。
 *
 * 返回的数组是快照，与 input 之后的状态无关。
 * @param {FileList|File[]|null} fileList
 * @returns {File[]}
 */
export function snapshotFiles(fileList) {
  return Array.from(fileList ?? []).filter((file) => file && typeof file === "object");
}

/**
 * 把一个 File 变成可直接发送的图片对象
 * @returns {Promise<{dataUrl: string, thumb: string, view: string, mime: string, name: string}>}
 */
export async function prepareImage(file) {
  if (!file) throw new Error("没有选到图片");
  if (!isImageFile(file)) throw new Error("只能发图片（小票 / 账单 / 支付截图）");
  const size = Number(file.size ?? 0);
  if (size > IMAGE_MAX_BYTES) throw new Error("图片太大了（上限 12MB），换一张试试");

  const raw = await readAsDataUrl(file);
  if (!raw.startsWith("data:image/")) throw new Error("只能发图片（小票 / 账单 / 支付截图）");

  const mime = String(file.type || "image/jpeg");
  const full = (await reencode(raw, FULL_EDGE, FULL_QUALITY).catch(() => null)) ?? raw;
  const thumb = (await reencode(raw, THUMB_EDGE, THUMB_QUALITY).catch(() => null)) ?? raw;
  // 预览图失败时退回原图：点开能看到比缩略图清楚的内容，比空白强
  const view = (await reencode(raw, VIEW_EDGE, VIEW_QUALITY).catch(() => null)) ?? full;
  return { dataUrl: full, thumb, view, mime, name: String(file.name ?? "图片") };
}

/**
 * 批量把多个 File 变成可发送的图片对象（每张独立压缩 / 生成缩略图）。
 *
 * 逐张独立处理：某一张读不出来（格式怪 / 太大 / 解码失败）只作废这一张，
 * 不会连累同批其它图片 —— 一次选了 5 张里有 1 张坏掉，照样能发剩下 4 张。
 * @returns {Promise<{images: Array, errors: Error[]}>}
 */
export async function prepareImages(files) {
  const list = snapshotFiles(files);
  if (!list.length) throw new Error("没有选到图片");

  const settled = await Promise.allSettled(list.map((file) => prepareImage(file)));
  const images = [];
  const errors = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value) images.push(outcome.value);
    else if (outcome.status === "rejected") errors.push(outcome.reason);
  }
  if (!images.length) throw errors[0] ?? new Error("没有选到图片");
  return { images, errors };
}

export const __testing = { FULL_EDGE, THUMB_EDGE, VIEW_EDGE, isImageFile };
