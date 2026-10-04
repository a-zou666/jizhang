/** 通用工具：日期、金额、DOM */

/* ---------------- DOM ---------------- */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* ---------------- 日期 ---------------- */
export const pad2 = (value) => String(value).padStart(2, "0");

/** YYYY-MM-DD（本地时区） */
export function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function fromKey(key) {
  const [year, month, day] = String(key)
    .split(/[-/.]/)
    .map((part) => Number(part));
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

export const today = () => startOfDay(new Date());

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addDays(date, delta) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

export function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

export function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

export function monthKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

/** 周起始日为 weekStart（0=周日 1=周一）时，表头顺序 */
export function weekdayOrder(weekStart) {
  return Array.from({ length: 7 }, (_, index) => (index + weekStart) % 7);
}

/**
 * 生成月历矩阵（含前后补位 null）
 * @returns {Array<Date|null>}
 */
export function monthMatrix(year, month, weekStart = 1) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = new Array(lead).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function monthTitle(date) {
  return `${date.getMonth() + 1}月 · ${date.getFullYear()}`;
}

export function fullDateLabel(date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 周${WEEKDAY_LABELS[date.getDay()]}`;
}

/** 明细卡标题：今天 / 昨天 / X月X日 */
export function detailTitleFor(date) {
  const now = today();
  if (isSameDay(date, now)) return "今日明细";
  if (isSameDay(date, addDays(now, -1))) return "昨日明细";
  return `${date.getMonth() + 1}月${date.getDate()}日明细`;
}

/* ---------------- 金额 ---------------- */
export function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/** 1234.5 → "1,234.5"；整数不带小数 */
export function formatMoney(value) {
  const amount = round2(Number(value) || 0);
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const text = Number.isInteger(abs)
    ? String(abs)
    : abs.toFixed(2).replace(/0$/, "").replace(/\.$/, "");
  const [int, dec] = text.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}${dec ? `.${dec}` : ""}`;
}

/** ¥1,234 */
export function yuan(value) {
  return `¥${formatMoney(value)}`;
}

/** 日历格子内的紧凑金额：120 / 1234 / 1.2万（目前未使用，保留供后续复用） */
export function formatCellAmount(value) {
  const amount = round2(Number(value) || 0);
  if (amount >= 10000) {
    const wan = amount / 10000;
    return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1).replace(/\.0$/, "")}万`;
  }
  return formatMoney(amount);
}

/* ---------------- 杂项 ---------------- */
export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function debounce(fn, wait = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
