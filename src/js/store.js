/** 应用状态：账单记录 + 设置（localStorage 持久化） */

import { dateKey, normalizeDateKey, monthKey, parseAmount, round2, today, uid } from "./util.js";

const STORAGE_KEY = "ai-ledger/v1";
/** 本地数据损坏读不出来时，先把原始内容备份到这里，避免被下一次写入覆盖掉 */
const RECOVERY_KEY = "ai-ledger/v1.recovered";
const PALETTE_SIZE = 6;

export const DEFAULT_CATEGORIES = ["餐饮", "交通", "数码", "日用", "娱乐", "其他"];

/** 协议预设：切换协议类型时套用默认 Base URL */
export const PROTOCOL_PRESETS = {
  claude: {
    label: "Claude 原生",
    desc: "Anthropic API 格式，需 api.anthropic.com",
    baseUrl: "https://api.anthropic.com",
  },
  openai: {
    label: "OpenAI 原生",
    desc: "OpenAI 官方格式",
    baseUrl: "https://api.openai.com",
  },
  "openai-compatible": {
    label: "OpenAI 兼容",
    desc: "第三方代理（AnyRouter / TeamorRouter 等）",
    baseUrl: "",
  },
};

export const PROTOCOL_ORDER = ["claude", "openai", "openai-compatible"];

const DEFAULT_STATE = () => ({
  records: [],
  settings: {
    protocol: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    weekStart: 1,
    budget: 5000,
    categories: [...DEFAULT_CATEGORIES],
  },
});

let state = DEFAULT_STATE();
const listeners = new Set();

/**
 * 最近一次存储故障（null 表示正常）。
 * 记账应用最怕「以为存上了、其实没存」：写入失败（配额满 / 隐私模式）、
 * 本地数据损坏解析不了、部分记录格式坏掉被跳过，都必须让用户看见。
 */
let storageProblem = null;
const storageListeners = new Set();

/**
 * 订阅存储故障。`handler` 收到故障对象，恢复正常时收到 `null`。
 * 注册时会**立刻**用当前状态回调一次，所以 `load()` 阶段就发生的读故障也不会漏掉。
 * 故障对象形如：`{ kind: "write" | "read" | "dropped", detail?, backedUp?, dropped? }`
 */
export function onStorageError(handler) {
  storageListeners.add(handler);
  handler(storageProblem);
  return () => storageListeners.delete(handler);
}

export const getStorageProblem = () => storageProblem;

function reportStorage(problem) {
  const before = `${storageProblem?.kind ?? ""}|${storageProblem?.detail ?? ""}|${storageProblem?.dropped ?? ""}`;
  const after = `${problem?.kind ?? ""}|${problem?.detail ?? ""}|${problem?.dropped ?? ""}`;
  storageProblem = problem;
  if (before !== after) storageListeners.forEach((listener) => listener(problem));
}

/* ---------------- 持久化 ---------------- */
function sanitizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const amount = parseAmount(raw.amount);
  if (amount === null) return null;
  const date = normalizeDateKey(raw.date);
  if (!date) return null;
  const createdAt = Number(raw.createdAt);
  return {
    id: String(raw.id ?? uid()),
    date,
    item: String(raw.item ?? "未命名"),
    category: String(raw.category ?? "其他"),
    amount: round2(Math.abs(amount)),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
  };
}

/**
 * 设置项收口：load()（读本地）与 replaceAll()（导入 JSON）共用。
 * 以前导入数据是直接 Object.assign 进 state，非法值（weekStart: "x"、
 * 分类里混进对象等）会绕过校验写进运行态，这里统一按白名单重建。
 */
function sanitizeSettings(raw, base) {
  if (!raw || typeof raw !== "object") return { ...base };
  const budget = Number(raw.budget);
  const categories = Array.isArray(raw.categories)
    ? [
        ...new Set(
          raw.categories
            .filter((name) => typeof name === "string")
            .map((name) => name.trim())
            .filter(Boolean),
        ),
      ].slice(0, 40)
    : [];
  return {
    protocol: PROTOCOL_PRESETS[raw.protocol] ? raw.protocol : base.protocol,
    baseUrl: String(raw.baseUrl ?? "").trim(),
    apiKey: String(raw.apiKey ?? ""),
    model: String(raw.model ?? "").trim(),
    weekStart: Number(raw.weekStart) === 0 ? 0 : 1,
    budget: Number.isFinite(budget) ? Math.max(0, round2(budget)) : base.budget,
    categories: categories.length ? categories : [...base.categories],
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    // 读得出来就是好的：上一次写入失败（如果发生在本会话之前）不再算数
    if (!raw) {
      if (storageProblem?.kind !== "write") reportStorage(null);
      return;
    }
    const parsed = JSON.parse(raw);
    const next = DEFAULT_STATE();
    let dropped = 0;
    if (Array.isArray(parsed?.records)) {
      next.records = parsed.records.map(sanitizeRecord).filter(Boolean);
      dropped = parsed.records.length - next.records.length;
    }
    next.settings = sanitizeSettings(parsed?.settings, next.settings);
    state = next;
    if (dropped > 0) reportStorage({ kind: "dropped", dropped });
    else if (storageProblem?.kind !== "write") reportStorage(null);
  } catch (error) {
    console.warn("[store] 读取本地数据失败，使用默认状态", error);
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (readError) {
      console.warn("[store] 连原始内容也读不出来", readError);
    }
    // 关键：先把读不出来的原始内容另存一份，再重置 ——
    // 否则下一次写入就会把这堆字节永久覆盖掉，数据再也没机会救回来。
    let backedUp = false;
    if (raw) {
      try {
        localStorage.setItem(RECOVERY_KEY, raw);
        backedUp = true;
      } catch (backupError) {
        console.warn("[store] 备份损坏的本地数据失败", backupError);
      }
    }
    state = DEFAULT_STATE();
    reportStorage({
      kind: "read",
      detail: String(error?.message ?? error),
      backedUp,
      recoverable: Boolean(raw),
    });
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    reportStorage(null); // 之前失败过的话，让用户知道已经恢复正常
  } catch (error) {
    console.warn("[store] 写入本地数据失败", error);
    reportStorage({ kind: "write", detail: String(error?.message ?? error) });
  }
}

/* ---------------- 订阅 ---------------- */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function commit(reason) {
  persist();
  listeners.forEach((listener) => listener(reason));
}

/* ---------------- 读取 ---------------- */
export const getState = () => state;
export const getRecords = () => state.records;
export const getSettings = () => state.settings;

export function categoryColor(name) {
  const categories = state.settings.categories;
  const index = categories.indexOf(name);
  
  // 使用新的色彩映射
  const colorMap = {
    '餐饮': 'var(--cat-food)',
    '交通': 'var(--cat-transport)',
    '购物': 'var(--cat-shopping)',
    '数码': 'var(--cat-shopping)',
    '娱乐': 'var(--cat-entertainment)',
    '医疗': 'var(--cat-healthcare)',
    '住房': 'var(--cat-housing)',
    '日用': 'var(--cat-shopping)',
    '教育': 'var(--cat-education)',
    '其他': 'var(--cat-other)',
  };
  
  // 优先使用预定义颜色
  if (colorMap[name]) return colorMap[name];
  
  // 回退到循环色板
  const colors = [
    'var(--cat-food)',
    'var(--cat-transport)',
    'var(--cat-shopping)',
    'var(--cat-entertainment)',
    'var(--cat-healthcare)',
    'var(--cat-housing)',
    'var(--cat-education)',
    'var(--cat-other)',
  ];
  
  return index >= 0 ? colors[index % colors.length] : 'var(--cat-other)';
}

export function recordsOf(key) {
  return state.records.filter((record) => record.date === key);
}

export function totalOf(key) {
  return round2(recordsOf(key).reduce((sum, record) => sum + record.amount, 0));
}

export function monthRecords(date) {
  const key = monthKey(date);
  return state.records.filter((record) => record.date.startsWith(key));
}

export function monthTotal(date) {
  return round2(monthRecords(date).reduce((sum, record) => sum + record.amount, 0));
}

/** 某天出现的分类（按色板顺序，去重） */
export function categoriesOf(key) {
  const seen = new Set();
  const result = [];
  for (const record of recordsOf(key)) {
    if (seen.has(record.category)) continue;
    seen.add(record.category);
    result.push(record.category);
  }
  return result;
}

export function dailyTotals(date) {
  const map = new Map();
  for (const record of monthRecords(date)) {
    map.set(record.date, round2((map.get(record.date) ?? 0) + record.amount));
  }
  return map;
}

/* ---------------- 写入 ---------------- */
export function addRecords(list) {
  const added = list.map(sanitizeRecord).filter(Boolean);
  if (!added.length) return [];
  state.records = [...state.records, ...added];
  commit("records");
  return added;
}

export function updateRecord(id, patch) {
  const index = state.records.findIndex((record) => record.id === id);
  if (index === -1) return null;
  const merged = sanitizeRecord({ ...state.records[index], ...patch, id });
  if (!merged) return null;
  state.records = state.records.map((record, i) => (i === index ? merged : record));
  commit("records");
  return merged;
}

export function removeRecord(id) {
  const before = state.records.length;
  state.records = state.records.filter((record) => record.id !== id);
  if (state.records.length !== before) commit("records");
}

export function clearRecords() {
  if (!state.records.length) return;
  state.records = [];
  commit("records");
}

export function setSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  commit("settings");
}

export function addCategory(name) {
  const clean = String(name ?? "").trim();
  if (!clean || state.settings.categories.includes(clean)) return false;
  state.settings = { ...state.settings, categories: [...state.settings.categories, clean] };
  commit("settings");
  return true;
}

export function removeCategory(name) {
  if (state.settings.categories.length <= 1) return false;
  const categories = state.settings.categories.filter((item) => item !== name);
  if (categories.length === state.settings.categories.length) return false;
  state.settings = { ...state.settings, categories };
  commit("settings");
  return true;
}

/** 供数据导出 / 预览使用 */
export function exportPayload() {
  return {
    app: "ai-ledger",
    version: "0.1.0",
    exportedAt: new Date().toISOString(),
    settings: { ...state.settings, apiKey: state.settings.apiKey ? "***" : "" },
    records: [...state.records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}

export function replaceAll(next) {
  const fresh = DEFAULT_STATE();
  if (Array.isArray(next?.records)) fresh.records = next.records.map(sanitizeRecord).filter(Boolean);
  // 导入的 JSON 也要走同一套校验，别让脏数据从这条路绕过 load()
  fresh.settings = sanitizeSettings(next?.settings, fresh.settings);
  state = fresh;
  commit("all");
}

/** 默认选中日期：有账单的最近一天，否则今天 */
export function latestRecordDate() {
  if (!state.records.length) return today();
  const latest = state.records
    .map((record) => record.date)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0];
  const [year, month, day] = latest.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? today() : date;
}

export const todayKey = () => dateKey(today());
