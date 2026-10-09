/**
 * 对话页识图记账：选图 → 压缩 → 生成「送模型的大图」和「气泡里的小缩略图」
 *
 * 只压缩不上传：图片最终以 data URL 形式交给 Rust 端的 process_image，
 * 全程留在本机；消息里只保存缩略图（见 store 的 CHAT_IMAGE_LIMIT），原图不入库。
 */

/** 送模型的最长边：再大也识别不出更多细节，只会白白多花 token */
const FULL_EDGE = 1280;
/** 气泡里显示的缩略图最长边 */
const THUMB_EDGE = 192;
const FULL_QUALITY = 0.82;
const THUMB_QUALITY = 0.6;
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
 * 把一个 File 变成可直接发送的图片对象
 * @returns {Promise<{dataUrl: string, thumb: string, mime: string, name: string}>}
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
  return { dataUrl: full, thumb, mime, name: String(file.name ?? "图片") };
}

/**
 * 批量把多个 File 变成可发送的图片对象（每张独立压缩 / 生成缩略图）。
 * 任何一张不合法都会抛错，由调用方决定是整批失败还是挑出能用的。
 * @returns {Promise<Array<{dataUrl: string, thumb: string, mime: string, name: string}>>}
 */
export async function prepareImages(files) {
  const list = Array.from(files ?? []);
  if (!list.length) throw new Error("没有选到图片");
  const prepared = await Promise.all(list.map((file) => prepareImage(file)));
  return prepared.filter(Boolean);
}

export const __testing = { FULL_EDGE, THUMB_EDGE, isImageFile };
