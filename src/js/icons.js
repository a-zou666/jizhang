/**
 * 十二、图标规范
 * 风格：SF Symbols 语义 / 线宽 1.5 / 尺寸 导航 24 · 列表 20 · 内联 16
 * 填充规则：选中态填充，未选态描边
 */

const STROKE = `fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;

const GEAR_PATH =
  "M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.08A1.7 1.7 0 0 0 10.11 3.04V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z";

/** 图标内容（<svg> 内部片段） */
export const ICONS = {
  /* 导航 · 首页 */
  calendarOutline: `
    <rect x="3.25" y="4.9" width="17.5" height="16" rx="3.4" ${STROKE} />
    <path d="M3.25 9.9h17.5" ${STROKE} />
    <path d="M8.2 3.1v3.6M15.8 3.1v3.6" ${STROKE} />`,
  calendarFilled: `
    <path fill-rule="evenodd" clip-rule="evenodd" d="M8 2.4c.6 0 1.05.47 1.05 1.05v1.3h5.9v-1.3a1.05 1.05 0 1 1 2.1 0v1.36a4.1 4.1 0 0 1 3.7 4.08v9.06a4.1 4.1 0 0 1-4.1 4.1H7.35a4.1 4.1 0 0 1-4.1-4.1V8.9a4.1 4.1 0 0 1 3.7-4.08V3.45C6.95 2.87 7.4 2.4 8 2.4Zm-2.6 7.55c0 .58.47 1.05 1.05 1.05h11.1a1.05 1.05 0 1 0 0-2.1H6.45c-.58 0-1.05.47-1.05 1.05Z" fill="currentColor" />`,

  /* 导航 · 设置 */
  settingsOutline: `
    <path d="${GEAR_PATH}" ${STROKE} />
    <circle cx="12" cy="12" r="3.1" ${STROKE} />`,
  settingsFilled: `
    <path d="${GEAR_PATH}" fill="currentColor" />
    <circle cx="12" cy="12" r="3" fill="#ffffff" />`,

  /* 导航 · 对话 */
  chatOutline: `
    <path d="M20.1 11.6c0 4.1-3.63 7.42-8.1 7.42-.93 0-1.83-.14-2.66-.4L4.6 20.4l1.2-3.5a7.1 7.1 0 0 1-1.7-4.3c0-4.1 3.63-7.42 8.1-7.42s8.1 3.32 8.1 7.42Z" ${STROKE} />`,
  chatFilled: `
    <path d="M12 3.6c4.66 0 8.4 3.32 8.4 7.42 0 1.5-.51 2.9-1.4 4.08.3.9.72 1.9 1.14 2.83.3.66-.4 1.36-1.06 1.08l-3.3-1.4c-.86.24-1.77.37-2.72.37-4.65 0-8.4-3.32-8.4-7.42C4.66 6.92 7.4 3.6 12 3.6Z" fill="currentColor" />`,

  /* 导航 · 账单 */
  billsOutline: `
    <rect x="4.6" y="2.9" width="14.8" height="18.2" rx="3.2" ${STROKE} />
    <path d="M8.4 8.1h7.2M8.4 12h7.2M8.4 15.9h4.6" ${STROKE} />`,
  billsFilled: `
    <rect x="4.6" y="2.9" width="14.8" height="18.2" rx="3.2" fill="currentColor" />
    <path d="M8.4 8.1h7.2M8.4 12h7.2M8.4 15.9h4.6" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" />`,

  /* 首页 · 今天 */
  calendarToday: `
    <rect x="3.25" y="4.9" width="17.5" height="16" rx="3.4" ${STROKE} />
    <path d="M3.25 9.9h17.5" ${STROKE} />
    <path d="M8.2 3.1v3.6M15.8 3.1v3.6" ${STROKE} />
    <circle cx="12" cy="15.1" r="2.1" fill="currentColor" />`,

  /* 悬浮输入条 */
  plus: `<path d="M12 5.2v13.6M5.2 12h13.6" ${STROKE} />`,
  mic: `
    <rect x="9.1" y="2.6" width="5.8" height="11.4" rx="2.9" ${STROKE} />
    <path d="M5.6 11.7a6.4 6.4 0 0 0 12.8 0" ${STROKE} />
    <path d="M12 18.1v3.3" ${STROKE} />`,
  send: `<path d="M12 19.4V4.9" ${STROKE} /><path d="M5.9 11 12 4.9 18.1 11" ${STROKE} />`,

  /* 对话 · 识图 */
  image: `
    <rect x="3.2" y="4.6" width="17.6" height="14.8" rx="3.2" ${STROKE} />
    <circle cx="8.7" cy="9.9" r="1.6" ${STROKE} />
    <path d="M4.1 17.2l4.4-4.4a1.8 1.8 0 0 1 2.5 0l2.9 2.9 1.8-1.8a1.8 1.8 0 0 1 2.5 0l1.7 1.7" ${STROKE} />`,

  /* 通用 */
  close: `<path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" ${STROKE} />`,
  chevronRight: `<path d="M9.2 5.2 16 12l-6.8 6.8" ${STROKE} />`,

  chevronLeft: `<path d="M14.8 5.2 8 12l6.8 6.8" ${STROKE} />`,
  check: `<path d="M4.8 12.6l5 5L19.2 6.6" ${STROKE} />`,
  trash: `
    <path d="M4.4 7h15.2" ${STROKE} />
    <path d="M9.6 7V4.8h4.8V7" ${STROKE} />
    <path d="M6.6 7l.86 12.1a1.8 1.8 0 0 0 1.8 1.7h5.48a1.8 1.8 0 0 0 1.8-1.7L17.4 7" ${STROKE} />`,
  alert: `
    <path d="M12 3.9 21.2 19.8H2.8L12 3.9Z" ${STROKE} />
    <path d="M12 10v4.1" ${STROKE} />
    <circle cx="12" cy="17.1" r="0.9" fill="currentColor" />`,
  sparkles: `
    <path d="M11.6 3.4 13.2 8.3 18.1 9.9 13.2 11.5 11.6 16.4 10 11.5 5.1 9.9 10 8.3 11.6 3.4Z" ${STROKE} />
    <path d="M18.4 15.2 19.2 17.6 21.6 18.4 19.2 19.2 18.4 21.6 17.6 19.2 15.2 18.4 17.6 17.6 18.4 15.2Z" ${STROKE} />`,
  refresh: `
    <path d="M20 12a8 8 0 1 1-2.34-5.66" ${STROKE} />
    <path d="M20 4.4V10h-5.6" ${STROKE} />`,

  /* 设置 · 数据 */
  download: `
    <path d="M12 3.5v9.5" ${STROKE} />
    <path d="M7.5 12.5 12 17l4.5-4.5" ${STROKE} />
    <path d="M4 16.8v1.7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.7" ${STROKE} />`,
  upload: `
    <path d="M12 17V7.5" ${STROKE} />
    <path d="M7.5 12 12 7.5 16.5 12" ${STROKE} />
    <path d="M4 16.8v1.7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.7" ${STROKE} />`,
};

/** 取图标的 <svg> 外层包裹 */
export function icon(name, { size = 24, className = "" } = {}) {
  const body = ICONS[name];
  if (!body) return "";
  const cls = className ? ` class="${className}"` : "";
  return `<svg${cls} viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${body}</svg>`;
}

/** 导航图标：按选中态切换描边 / 填充（选中 24pt，未选 22pt） */
export function navIcon(tab, active) {
  const size = active ? 24 : 22;
  if (tab === "home") return icon(active ? "calendarFilled" : "calendarOutline", { size });
  if (tab === "chat") return icon(active ? "chatFilled" : "chatOutline", { size });
  if (tab === "bills") return icon(active ? "billsFilled" : "billsOutline", { size });
  return icon(active ? "settingsFilled" : "settingsOutline", { size });
}

/** 把静态 HTML 中所有 [data-icon] 占位节点替换为真实图标 */
export function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => {
    const name = node.getAttribute("data-icon");
    const size = Number(node.getAttribute("data-icon-size")) || 24;
    if (!ICONS[name]) console.warn(`[icons] 未知图标名：${name}（会渲染成空白）`);
    node.innerHTML = icon(name, { size });
  });
}
