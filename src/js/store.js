/** 应用状态：账单记录 + 设置（localStorage 持久化） */

import { dateKey, monthKey, round2, today, uid } from "./util.js";

const STORAGE_KEY = "ai-ledger/v1";
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

/* ---------------- 持久化 ---------------- */
function sanitizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const amount = Number(raw.amount);
  if (!Number.isFinite(amount)) return null;
  const date = String(raw.date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {
    id: String(raw.id ?? uid()),
    date,
    item: String(raw.item ?? "未命名"),
    category: String(raw.category ?? "其他"),
    amount: round2(Math.abs(amount)),
    createdAt: Number(raw.createdAt ?? Date.now()),
  };
}

export function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const next = DEFAULT_STATE();
    if (Array.isArray(parsed?.records)) {
      next.records = parsed.records.map(sanitizeRecord).filter(Boolean);
    }
    const settings = parsed?.settings;
    if (settings && typeof settings === "object") {
      Object.assign(next.settings, {
        protocol: PROTOCOL_PRESETS[settings.protocol] ? settings.protocol : "openai-compatible",
        baseUrl: String(settings.baseUrl ?? ""),
        apiKey: String(settings.apiKey ?? ""),
        model: String(settings.model ?? ""),
        weekStart: Number(settings.weekStart) === 0 ? 0 : 1,
        budget: Number.isFinite(Number(settings.budget)) ? round2(Number(settings.budget)) : 5000,
        categories:
          Array.isArray(settings.categories) && settings.categories.length
            ? settings.categories.map((name) => String(name)).filter(Boolean)
            : [...DEFAULT_CATEGORIES],
      });
    }
    state = next;
  } catch (error) {
    console.warn("[store] 读取本地数据失败，使用默认状态", error);
    state = DEFAULT_STATE();
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("[store] 写入本地数据失败", error);
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
  if (next?.settings && typeof next.settings === "object") {
    Object.assign(fresh.settings, next.settings);
  }
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
