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

/**
 * 宽松解析日期文本 → 补零的 YYYY-MM-DD；无法识别返回 null。
 *
 * 大模型返回的日期格式五花八门（2026-10-4 / 2026/10/4 / 2026.10.4 / 2026年10月4日 /
 * 2026-10-04T12:00:00Z），只要稍微不一样，旧的严格正则就会把用户刚记的账整条丢掉。
 * 这里作为唯一的日期收口点：能认出来的都归一化，认不出来才交给调用方决定。
 */
export function normalizeDateKey(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : dateKey(value);
  const text = String(value ?? "").trim();
  if (!text) return null;

  // 年 + 1~2 位月 + 1~2 位日，分隔符容忍 - / . 年月日（可跟「日」或时间部分），另接受紧凑写法 20261004
  const hit =
    text.match(/^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/) ??
    text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!hit) return null;

  const year = Number(hit[1]);
  const month = Number(hit[2]);
  const day = Number(hit[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // 2026-02-31 会被 Date 顺延到 3 月，回读三段校验挡掉这类溢出日期
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return dateKey(date);
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

/** 全角数字与标点 → 半角（中文输入法里很容易带出来） */
function toHalfWidth(text) {
  return text
    .replace(/[\uFF10-\uFF19]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF0E\u3002]/g, ".")
    .replace(/\uFF0C/g, ",");
}

/**
 * 宽松解析金额 → 正数（保留 2 位小数）；无法识别返回 null。
 *
 * 大模型经常返回 "¥120" / "1,234.5" / "120元" / "1.2万" 这类字符串，
 * 而 Number("120元") 是 NaN —— 旧实现会因此把整条账单静默丢掉。
 */
export function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.abs(round2(value)) : null;
  const text = toHalfWidth(String(value ?? "")).trim();
  if (!text) return null;

  const scale = text.includes("万") ? 10000 : text.includes("千") ? 1000 : 1;
  const cleaned = text.replace(/[¥￥$€£]|元|块|人民币|[\s,]/g, "");
  const hit = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!hit) return null;

  const amount = Number(hit[0]);
  if (!Number.isFinite(amount)) return null;
  return Math.abs(round2(amount * scale));
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

/* ---------------- 接口地址补全 ---------------- */
/**
 * 各家地址长得不一样：DeepSeek 是 https://api.deepseek.com（要补 /v1），
 * 智谱是 .../api/paas/v4、火山方舟是 .../api/v3、混元是 .../v1（只需补资源名），
 * 还有人直接粘完整地址 .../chat/completions。这里统一补全成真正的请求地址，
 * 规则与 Rust 端 lib.rs 的 endpoint() 保持一致。
 */
export function hasVersionSegment(base) {
  const last = String(base).split("/").pop() ?? "";
  const body = last.startsWith("v") ? last.slice(1) : last;
  return Boolean(body) && /^\d/.test(body);
}

/** 剥掉已经写全的资源名，避免在 .../chat/completions 后面再拼一段 */
const stripResource = (base) => {
  for (const suffix of ["/chat/completions", "/messages", "/models"]) {
    if (base.endsWith(suffix)) return base.slice(0, -suffix.length).replace(/\/+$/, "");
  }
  return base;
};

const DEFAULT_URLS = {
  claude: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  "openai-compatible": "https://api.openai.com",
};

/** Base URL（或完整地址）→ 对话请求地址 */
export function buildEndpoint(protocol, baseUrl) {
  const raw = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const base = raw || DEFAULT_URLS[protocol] || DEFAULT_URLS["openai-compatible"];
  if (protocol === "claude") {
    if (base.endsWith("/v1/messages")) return base;
    if (base.endsWith("/messages")) return base;
    if (hasVersionSegment(base)) return `${base}/messages`;
    return `${base}/v1/messages`;
  }
  if (base.endsWith("/chat/completions")) return base;
  if (hasVersionSegment(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** Base URL（或完整地址）→ 模型列表地址（供「从 API 拉取」用） */
export function buildModelsEndpoint(protocol, baseUrl) {
  const raw = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const base = stripResource(raw || DEFAULT_URLS[protocol] || DEFAULT_URLS["openai-compatible"]);
  if (hasVersionSegment(base)) return `${base}/models`;
  return `${base}/v1/models`;
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
