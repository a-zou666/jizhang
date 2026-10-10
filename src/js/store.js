/** 应用状态：账单记录 + 设置（localStorage 持久化） */

import {
  dateKey,
  fromKey,
  monthKey,
  normalizeDateKey,
  parseAmount,
  round2,
  today,
  uid,
} from "./util.js";

const STORAGE_KEY = "ai-ledger/v1";
/** 本地数据损坏读不出来时，先把原始内容备份到这里，避免被下一次写入覆盖掉 */
const RECOVERY_KEY = "ai-ledger/v1.recovered";
const PALETTE_SIZE = 6;

/**
 * 应用版本号。构建时由 vite.config.js 从 package.json 注入（`__APP_VERSION__`），
 * 未构建的环境（node --test / 直接跑源码）回退成占位，不硬编码具体版本。
 */
export const APP_VERSION = (() => {
  try {
    return typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
})();

export const DEFAULT_CATEGORIES = ["餐饮", "交通", "数码", "日用", "娱乐", "其他"];

/* ==========================================================================
   软件更新源
   ========================================================================== */

/**
 * 更新源站点。**全项目更新源的唯一真相**（Rust 侧 update.rs 有同一份常量，
 * 那一边负责实际拉清单；这里这份用于「打开浏览器兜底」与提示文案，两边必须一致）。
 *
 * 是自己搭的分发服务器（Azure 香港），清单与 APK 都由它提供，全程 HTTPS。
 * 曾经挂过 Gitee，但它的附件**上传**只有 10~50 KB/s，而且读清单要过两级 302
 * 跳到带临时 token 的 CDN（foruda.gitee.com），手机移动网络下经常超时 ——
 * 表现就是「点了检查更新却检测不到新版本」。现在整条链路只有这一台服务器。
 *
 * 域名是中文的 `电脑.tech`，**写成 punycode** `xn--wnyy6w.tech`：部分运行时
 * 对 IDN 的处理不一致，写死了最稳。
 */
export const UPDATE_HOST = "apk.xn--wnyy6w.tech";

/**
 * 「打开下载页」的兜底地址 —— 指向 **:9444**。
 *
 * ## 为什么是 9444 而不是 9443
 *
 * 两个端口职责不同，别混：
 * - **:9443** 是 App 内更新用的（清单 + APK）。证书是**自签**的，App 里内置了
 *   对应根 CA 所以能验通；但**浏览器不认自签证书**。
 * - **:9444** 是给用户浏览器看的下载页，走 Let's Encrypt，零警告。
 *
 * 这个常量只在「后端没返回 page_url」时兜底 —— 正常情况下清单里的 `page_url`
 * 已经是 9444 了。放成 9443 的话用户点「打开下载页」会撞上证书警告。
 */
export const UPDATE_RELEASES_PAGE = `https://${UPDATE_HOST}:9444/`;

/**
 * 比较两个版本号。返回 true 表示 `remote` 比 `current` 新。
 *
 * 与 Rust 侧 update.rs 的 compare_versions 保持同一套规则：
 * 数字段逐个比，段数不同时缺的补 0；预发布版（-beta）小于同号正式版。
 * 两边各一份是刻意的 —— 前端要在「没有后端」时也能给出结论，且这段是纯逻辑可单测。
 */
export function isNewerVersion(remote, current) {
  const parse = (raw) => {
    const text = String(raw ?? "").trim().replace(/^[vV]/, "");
    const dash = text.indexOf("-");
    const core = dash >= 0 ? text.slice(0, dash) : text;
    const pre = dash >= 0 && text.slice(dash + 1).trim().length > 0;
    const numbers = core.split(/[._+]/).map((part) => {
      const digits = part.match(/^\d+/);
      return digits ? Number(digits[0]) : 0;
    });
    return { numbers, pre };
  };

  const left = parse(remote);
  const right = parse(current);
  const len = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < len; i += 1) {
    const a = left.numbers[i] ?? 0;
    const b = right.numbers[i] ?? 0;
    if (a !== b) return a > b;
  }
  // 数字段相同：预发布版 < 正式版
  if (left.pre && !right.pre) return false;
  if (!left.pre && right.pre) return true;
  return false;
}

/**
 * 把「检查更新」的返回整理成前端直接可用的一份结果。
 *
 * 后端返回的 ok=false 与「invoke 抛异常」在这里统一成同一种形状，
 * 调用方只需要看 `failed` 一个字段，不用分别处理两条错误路径。
 */
export function normalizeUpdateResult(raw, fallbackVersion) {
  const current = String(raw?.currentVersion ?? fallbackVersion ?? APP_VERSION);
  const latest = String(raw?.latestVersion ?? "").trim();
  const failed = !raw?.ok;
  return {
    failed,
    hasUpdate: Boolean(raw?.hasUpdate),
    currentVersion: current,
    latestVersion: latest,
    notes: String(raw?.notes ?? "").trim(),
    downloadUrl: String(raw?.downloadUrl ?? "").trim(),
    pageUrl: String(raw?.pageUrl ?? "").trim() || UPDATE_RELEASES_PAGE,
    message: String(raw?.message ?? "").trim(),
    hint: String(raw?.hint ?? "").trim(),
  };
}

/** 更新说明里可能带 markdown 列表，转成纯文本行，方便直接塞进弹窗 */
export function cleanReleaseNotes(notes) {
  return String(notes ?? "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*[-*+]\s+/, "· ")
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 12)
    .join("\n");
}

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

/**
 * 常用服务商预设：点一下自动填好名称 / 协议 / 地址，并带上这家常用的模型 ID
 * （识图用的视觉模型放在前面标注出来）。只填字段、不自动启用 —— 启用仍然要用户点。
 * 地址都写成「基址」，完整请求地址由 util.buildEndpoint 补全；用户也可以直接在
 * 表单里粘完整地址（…/chat/completions），原样使用。
 */
export const PROVIDER_PRESETS = [
  {
    key: "zhipu",
    name: "智谱 GLM",
    protocol: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyHint: "open.bigmodel.cn → API Keys（形如 xxxx.yyyy）",
    models: [
      { id: "glm-4.7-flash", alias: "GLM-4.7-Flash（免费）" },
      { id: "glm-4.7", alias: "GLM-4.7" },
      { id: "glm-4.6", alias: "GLM-4.6" },
      { id: "glm-4.6v-flash", alias: "GLM-4.6V-Flash（免费·识图）" },
      { id: "glm-4.6v", alias: "GLM-4.6V（识图）" },
      { id: "glm-ocr", alias: "GLM-OCR（票据识别）" },
    ],
  },
  {
    key: "ark",
    name: "豆包（火山方舟）",
    protocol: "openai-compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyHint: "火山方舟控制台 → API Key；模型可填接入点 ID（ep- 开头）或模型名",
    models: [
      { id: "doubao-seed-2-1-pro-260915", alias: "豆包 2.1 Pro" },
      { id: "doubao-seed-2-1-lite-260915", alias: "豆包 2.1 Lite" },
      { id: "doubao-seed-2-0-mini-260428", alias: "豆包 2.0 mini（多模态·识图）" },
      { id: "doubao-seed-vision", alias: "豆包视觉理解（识图）" },
      { id: "doubao-ocr", alias: "豆包 OCR（票据）" },
      { id: "glm-5.1", alias: "GLM-5.1（方舟托管）" },
      { id: "deepseek-v4-pro", alias: "DeepSeek V4 Pro（方舟托管）" },
    ],
  },
  {
    key: "hunyuan",
    name: "腾讯混元 TokenHub",
    protocol: "openai-compatible",
    baseUrl: "https://tokenhub.tencentcloudmaas.com/v1",
    keyHint: "腾讯云 TokenHub 控制台创建 Key（广州节点；也可换 intl / us 节点）",
    models: [
      { id: "hy3", alias: "Hy3" },
      { id: "hy3-preview", alias: "Hy3 Preview" },
      { id: "hy-vision-2.0-instruct", alias: "HY-Vision 2.0（识图）" },
      { id: "hy-vision-1.5-thinking", alias: "HY-Vision 1.5 Thinking（识图）" },
    ],
  },
  {
    key: "hunyuan-legacy",
    name: "腾讯混元（旧入口）",
    protocol: "openai-compatible",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    keyHint: "旧版混元入口（视觉模型已下线，仅文本）",
    models: [
      { id: "hy3", alias: "Hy3" },
      { id: "hunyuan-turbos", alias: "Hunyuan TurboS" },
      { id: "hunyuan-lite", alias: "Hunyuan Lite（免费）" },
    ],
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    keyHint: "platform.deepseek.com → API Keys",
    models: [
      { id: "deepseek-chat", alias: "DeepSeek V3" },
      { id: "deepseek-reasoner", alias: "DeepSeek R1（推理）" },
    ],
  },
  {
    key: "qwen",
    name: "通义千问",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyHint: "阿里云百炼 → API Key",
    models: [
      { id: "qwen-plus", alias: "Qwen Plus" },
      { id: "qwen-turbo", alias: "Qwen Turbo" },
      { id: "qwen-vl-max", alias: "Qwen-VL-Max（识图）" },
    ],
  },
];

const DEFAULT_STATE = () => ({
  records: [],
  // 对话页的消息流（只存最近 CHAT_LIMIT 条，纯本机）
  chat: [],
  settings: {
    protocol: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
    weekStart: 1,
    budget: 5000,
    // 单月预算：{ "YYYY-MM": 金额 }，没单独设置的月份沿用 budget
    budgets: {},
    categories: [...DEFAULT_CATEGORIES],
    // 模型管理：服务商列表 + 当前启用的服务商 id
    // providers: [{ id, name, protocol, baseUrl, apiKey, model, models: [{ id, alias }] }]
    providers: [],
    activeProviderId: "",
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
  // ⚠️ 只清洗一次，之后复用。
  //
  // 历史上这里算了两遍，而 `sanitizeProvider` 缺 id 时**会现场生成一个 id**。
  // 两遍得到两套不同 id：providers 里存第一批、activeProviderId 却拿第二批去比 ——
  // 永远匹配不上 → activeProviderId 被清成 ""，App 就**静默回退到顶层的
  // settings.apiKey**（很可能是另一家的 Key），远端收到不认识的 Key 报 401，
  // 而界面上「当前启用的是谁」看着完全正常。
  //
  // 现在 `sanitizeProvider` 的兜底 id 已经改成**确定性**派生（同一份数据反复清洗
  // 结果一致），但「只算一次」本身仍然要保留：少一次无用功，也少一处将来走样的机会。
  const providers = sanitizeProviders(raw.providers);
  const wanted = String(raw.activeProviderId ?? "").trim();
  return {
    protocol: PROTOCOL_PRESETS[raw.protocol] ? raw.protocol : base.protocol,
    baseUrl: String(raw.baseUrl ?? "").trim(),
    apiKey: String(raw.apiKey ?? ""),
    model: String(raw.model ?? "").trim(),
    weekStart: Number(raw.weekStart) === 0 ? 0 : 1,
    budget: Number.isFinite(budget) ? Math.max(0, round2(budget)) : base.budget,
    budgets: sanitizeBudgets(raw.budgets),
    categories: categories.length ? categories : [...base.categories],
    providers,
    // 指向了不存在的服务商就当成「没有启用任何服务商」
    activeProviderId: providers.some((item) => item.id === wanted) ? wanted : "",
  };
}

/** 模型条目统一成 { id, alias }，去重去空、丢弃非法项 */
function sanitizeModels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const value = typeof item === "string" ? { id: item, alias: "" } : item;
    if (!value || typeof value !== "object") continue;
    const id = String(value.id ?? "").trim().slice(0, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, alias: String(value.alias ?? "").trim().slice(0, 60) });
  }
  return out.slice(0, 300);
}

/* ---------------- 对话页消息流 ---------------- */
const CHAT_LIMIT = 200;
/**
 * 消息里的图片只存缩略图（气泡显示用）与预览图（点开看大图用），且限制体积：
 * 原图可能有几百 KB，200 条消息全存下来会直接把 localStorage 撑爆。
 */
export const CHAT_IMAGE_LIMIT = 40_000;
/** 预览图比缩略图大，单独给一个上限（超过就退回用缩略图预览，聊胜于无） */
export const CHAT_VIEW_LIMIT = 160_000;
/** 缩略图只保留最近若干条：更早的消息清掉图片、文字照旧留着 */
const CHAT_IMAGE_KEEP = 30;
/** 单条消息最多保留多少张缩略图（多张小票也能存，但别太离谱） */
const MAX_CHAT_IMAGES = 12;

/** 只放行「真的是图片且不太大」的缩略图，其余一律丢弃（不影响文字与其他字段） */
function sanitizeChatImage(raw) {
  if (typeof raw !== "string" || !raw.startsWith("data:image/")) return "";
  return raw.length > CHAT_IMAGE_LIMIT ? "" : raw;
}

/**
 * 预览图：必须**与同位置的缩略图配对**才保留。
 *
 * 用下标与 images 对齐（images[i] 对应 views[i]），这样渲染时不必再猜
 * 哪张对应哪张；缺预览图的位置留空串，界面会自动退回缩略图。
 */
function sanitizeChatViews(raw, count) {
  if (!Array.isArray(raw) || !count) return [];
  const out = [];
  for (let index = 0; index < count; index += 1) {
    const value = raw[index];
    const ok = typeof value === "string" && value.startsWith("data:image/") && value.length <= CHAT_VIEW_LIMIT;
    out.push(ok ? value : "");
  }
  return out;
}

/** 从后往前数，超过 CHAT_IMAGE_KEEP 条带图的消息就把它的图片清空（文字保留） */
function pruneChatImages(messages) {
  let seen = 0;
  const out = messages.slice();
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if (!out[index].images?.length) continue;
    seen += 1;
    if (seen > CHAT_IMAGE_KEEP) out[index] = { ...out[index], images: [], views: [] };
  }
  return out;
}

/**
 * 消息：{ id, role: "user" | "assistant", text, kind, items[], state, at, images }
 * kind: text（纯聊天）/ add（待入账）/ del（待删除）/ query（查询结果）
 * images: 用户发的图片缩略图数组（data URL，超上限会自动丢弃），支持一次发多张
 * 账目快照直接存在消息里，重进界面才能原样还原，不用重新问一遍 AI
 */
function sanitizeChatMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const role = raw.role === "user" ? "user" : "assistant";
  const kind = ["text", "add", "del", "query"].includes(raw.kind) ? raw.kind : "text";
  const items = Array.isArray(raw.items)
    ? raw.items.map(sanitizeRecord).filter(Boolean).slice(0, 50)
    : [];
  // 兼容老数据：旧字段 image（单张）并入 images（数组）
  const rawImages = Array.isArray(raw.images)
    ? raw.images
    : raw.image
      ? [raw.image].filter(Boolean)
      : [];
  const images = rawImages
    .map(sanitizeChatImage)
    .filter(Boolean)
    .slice(0, MAX_CHAT_IMAGES);
  // 预览图与缩略图按下标配对：images[i] ↔ views[i]，缺失的位置留空串
  const views = sanitizeChatViews(raw.views, images.length);
  return {
    id: String(raw.id ?? uid()),
    role,
    text: String(raw.text ?? "").slice(0, 2000),
    kind: kind === "text" || items.length ? kind : "text",
    items,
    state: ["pending", "done", "ignored", "error"].includes(raw.state) ? raw.state : "done",
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
    images,
    views,
  };
}

function sanitizeChat(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeChatMessage).filter(Boolean).slice(-CHAT_LIMIT);
}

export const getChat = () => state.chat;

export function appendChat(message) {
  const clean = sanitizeChatMessage(message);
  if (!clean) return null;
  state.chat = pruneChatImages([...state.chat, clean].slice(-CHAT_LIMIT));
  commit("chat");
  return clean;
}

export function updateChat(id, patch) {
  const index = state.chat.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const merged = sanitizeChatMessage({ ...state.chat[index], ...patch, id });
  if (!merged) return null;
  state.chat = state.chat.map((item, i) => (i === index ? merged : item));
  commit("chat");
  return merged;
}

export function clearChat() {
  if (!state.chat.length) return;
  state.chat = [];
  commit("chat");
}

/** 单月预算的键必须是 YYYY-MM，金额非负，最多存 240 个月（20 年） */
function sanitizeBudgets(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) continue;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) continue;
    out[key] = round2(amount);
    if (Object.keys(out).length >= 240) break;
  }
  return out;
}

/**
 * 服务商（模型供应商）条目收口。
 * 服务商与模型全部由用户在「模型管理」里显式增删改，不存在任何自动建档 / 自动恢复：
 * 只有用户点了「启用」，它的地址与 Key 才会写进当前连接参数。
 *
 * `index` 只用于「没 id 时怎么补」——见下面对 `fallbackId` 的说明。
 */
function sanitizeProvider(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim().slice(0, 40) || "未命名服务商";
  // 缺 id 时的兜底必须是**确定的**，不能用 `uid()` 现场摇一个随机值 ——
  // 否则同一份数据被清洗两次会得到两个不同的 id。
  //
  // 这不是理论问题：`sanitizeSettings` 曾经把服务商列表算了两遍，于是
  // providers 里存第一批 id、activeProviderId 却拿第二批去比 → 永远对不上 →
  // 被清成空 → App 静默回退到顶层 apiKey（可能来自另一家服务商）→ 远端 401，
  // 而界面上「当前启用的是哪家」看起来完全正常，极难排查。
  //
  // 用「下标 + 名称」派生：同一份数据反复清洗结果一致，且不同服务商几乎不会撞。
  const fallbackId = `p${index}-${name.slice(0, 24)}`;
  const id = String(raw.id ?? "").trim().slice(0, 64) || fallbackId;
  return {
    id,
    name,
    protocol: PROTOCOL_PRESETS[raw.protocol] ? raw.protocol : "openai-compatible",
    baseUrl: String(raw.baseUrl ?? "").trim().slice(0, 300),
    apiKey: String(raw.apiKey ?? "").slice(0, 500),
    model: String(raw.model ?? "").trim().slice(0, 120),
    models: sanitizeModels(raw.models),
  };
}

function sanitizeProviders(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => sanitizeProvider(item, index))
    .filter(Boolean)
    .slice(0, 30);
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
    next.chat = sanitizeChat(parsed?.chat);
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

/**
 * 账目按日期区间过滤（供「账单页」统计用）。
 * YYYY-MM-DD 可直接字符串比较；空端点表示不限。
 * 结果按日期倒序（同一天按记账时间倒序），最新的排在最前面。
 */
export function recordsInRange(records, start, end) {
  return (records ?? [])
    .filter((record) => {
      if (start && record.date < start) return false;
      if (end && record.date > end) return false;
      return true;
    })
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (b.createdAt ?? 0) - (a.createdAt ?? 0);
    });
}

/** 按分类汇总金额（降序）并算出占总支出的百分比 */
export function sumByCategory(records) {
  const totals = new Map();
  let sum = 0;
  for (const record of records ?? []) {
    totals.set(record.category, (totals.get(record.category) ?? 0) + record.amount);
    sum += record.amount;
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({
      category,
      amount: round2(amount),
      percent: sum > 0 ? (amount / sum) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

/** 区间跨越的天数（闭区间，含首尾）；任一端为空 / 不合法时返回 0 */
export function daysBetween(start, end) {
  const from = fromKey(start);
  const to = fromKey(end);
  if (!from || !to) return 0;
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

/** 明细按日期分组（沿用传入顺序，通常已由 recordsInRange 排成日期倒序） */
export function groupRecordsByDate(records) {
  const groups = new Map();
  for (const record of records ?? []) {
    if (!groups.has(record.date)) groups.set(record.date, []);
    groups.get(record.date).push(record);
  }
  return [...groups.entries()].map(([date, list]) => ({
    date,
    total: round2(list.reduce((sum, record) => sum + record.amount, 0)),
    records: list,
  }));
}

/** 只留下某个分类的账目；分类为空 / 不传表示不筛（原样返回） */
export function filterByCategory(records, category) {
  if (!category) return [...(records ?? [])];
  return (records ?? []).filter((record) => record.category === category);
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
  const next = { ...state.settings, ...patch };
  state.settings = next;
  commit("settings");
}

/* ---------------- 预算：默认月预算 + 单月覆盖 ---------------- */
const monthKeyOf = (dateOrKey) =>
  typeof dateOrKey === "string" ? dateOrKey : monthKey(dateOrKey);

/** 某个月生效的预算：这个月单独设过就用它的，否则沿用默认月预算 */
export function getMonthBudget(dateOrKey) {
  const own = state.settings.budgets?.[monthKeyOf(dateOrKey)];
  return typeof own === "number" ? own : Math.max(0, Number(state.settings.budget) || 0);
}

/** 这个月是不是单独设过（用于界面上提示「本月已单独设置」） */
export function hasOwnMonthBudget(dateOrKey) {
  return typeof state.settings.budgets?.[monthKeyOf(dateOrKey)] === "number";
}

export function setMonthBudget(dateOrKey, value) {
  const key = monthKeyOf(dateOrKey);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return false;
  const amount = round2(Number(value));
  if (!Number.isFinite(amount) || amount < 0) return false;
  state.settings = { ...state.settings, budgets: { ...(state.settings.budgets ?? {}), [key]: amount } };
  commit("settings");
  return true;
}

/** 恢复成默认月预算 */
export function resetMonthBudget(dateOrKey) {
  const key = monthKeyOf(dateOrKey);
  if (!state.settings.budgets?.[key]) return false;
  const budgets = { ...state.settings.budgets };
  delete budgets[key];
  state.settings = { ...state.settings, budgets };
  commit("settings");
  return true;
}

/* ---------------- 模型管理：服务商 + 模型 ---------------- */
export const getProviders = () => state.settings.providers;

export function getProvider(id) {
  return state.settings.providers.find((item) => item.id === id) ?? null;
}

export function getActiveProvider() {
  return state.settings.providers.find((item) => item.id === state.settings.activeProviderId) ?? null;
}

function writeProviders(providers) {
  state.settings = { ...state.settings, providers: sanitizeProviders(providers) };
  commit("settings");
}

/** 新建一个服务商（默认不改动当前连接，用户点「启用」才生效） */
export function addProvider(input) {
  // 新建时**显式**给一个全新 id：这是「新服务商」，本来就要跟别人不同。
  // 不能靠 sanitizeProvider 里那个「按名称派生」的兜底 —— 用户完全可能
  // 建两个同名服务商（比如同一家的两个 Key），派生 id 会撞。
  const provider = sanitizeProvider({ ...input, id: uid() });
  if (!provider) return null;
  writeProviders([...state.settings.providers, provider]);
  return getProvider(provider.id);
}

export function updateProvider(id, patch) {
  const index = state.settings.providers.findIndex((item) => item.id === id);
  if (index === -1) return null;
  const existing = state.settings.providers[index];
  // 没传 apiKey 或传了空串时，保留已有的 Key：编辑页的密码框留空不易察觉，
  // 若直接拿空串覆盖，会把已经存好的 Key 静默清空，导致拉模型 / 对话 401。
  const nextApiKey =
    "apiKey" in patch && patch.apiKey ? patch.apiKey : existing.apiKey;
  const merged = sanitizeProvider({ ...existing, ...patch, apiKey: nextApiKey, id });
  if (!merged) return null;
  const providers = [...state.settings.providers];
  providers[index] = merged;
  writeProviders(providers);
  return getProvider(id);
}

export function removeProvider(id) {
  const before = state.settings.providers.length;
  const providers = state.settings.providers.filter((item) => item.id !== id);
  if (providers.length === before) return false;
  const active = state.settings.activeProviderId === id ? "" : state.settings.activeProviderId;
  state.settings = { ...state.settings, providers: sanitizeProviders(providers), activeProviderId: active };
  commit("settings");
  return true;
}

/** 启用：把这个服务商的地址 / Key / 模型写进当前连接参数（不走界面，供导入 / 测试调用） */
export function activateProvider(id) {
  const provider = getProvider(id);
  if (!provider) return null;
  const model = provider.model || provider.models[0]?.id || "";
  state.settings = {
    ...state.settings,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model,
    activeProviderId: provider.id,
    providers: state.settings.providers.map((item) =>
      item.id === provider.id ? { ...item, model } : item,
    ),
  };
  commit("settings");
  return getProvider(id);
}

/**
 * 在对话页顶部的「选择模型」里点一个模型：它属于哪个服务商，就切换到那个服务商。
 * 界面上换模型**只有这一个入口**（设置 → 模型管理只管「有哪些模型可拉取」）；
 * 这样「当前用的模型」始终是用户在对话页显式选出来的，
 * 切到 Minimax 就走 Minimax 的 URL，切到智谱就走智谱的 URL。
 */
export function selectModel(providerId, modelId) {
  const provider = getProvider(providerId);
  if (!provider) return false;
  if (!provider.models.some((item) => item.id === modelId)) return false;
  state.settings = {
    ...state.settings,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: modelId,
    activeProviderId: provider.id,
  };
  commit("settings");
  return true;
}

/**
 * 当前连接参数改动：写进顶层，同时同步到已启用的服务商
 * （只同步用户正在编辑的这一家，不会去碰别的服务商，也不会自动切换）
 */
export function patchConnection(patch) {
  const allowed = {};
  for (const key of ["protocol", "baseUrl", "apiKey", "model"]) {
    if (key in patch) {
      // apiKey 为空串时跳过：连接编辑页的密码框不会回显旧 Key，
      // 留空几乎总是「没改 Key」，而不是「要清空 Key」。跳过它，
      // 顶层和已启用服务商的旧 Key 都会被保留，避免保存后拉模型 / 对话 401。
      if (key === "apiKey" && !patch.apiKey) continue;
      allowed[key] = patch[key];
    }
  }
  if (!Object.keys(allowed).length) return;
  const activeId = state.settings.activeProviderId;
  const next = { ...state.settings, ...allowed };
  if (activeId) {
    next.providers = state.settings.providers.map((item) =>
      item.id === activeId ? sanitizeProvider({ ...item, ...allowed, id: item.id }) ?? item : item,
    );
  }
  state.settings = next;
  commit("settings");
}

/** 往服务商里加模型（幂等：已存在的不重复加） */
export function addProviderModels(id, list) {
  const provider = getProvider(id);
  if (!provider) return 0;
  const incoming = sanitizeModels(list);
  const known = new Set(provider.models.map((item) => item.id));
  const fresh = incoming.filter((item) => !known.has(item.id));
  if (!fresh.length) return 0;
  const providers = state.settings.providers.map((item) =>
    item.id === id ? { ...item, models: [...item.models, ...fresh] } : item,
  );
  writeProviders(providers);
  return fresh.length;
}

export function removeProviderModel(id, modelId) {
  return removeProviderModels(id, [modelId]) > 0;
}

/**
 * 批量移除模型（单删也是走这里）。
 * 当前正在用的那个模型被删掉时，自动回退到剩下的第一个（没有就置空），
 * 免得连接指向一个已经不存在的模型。
 * @returns {number} 真正删掉的个数
 */
export function removeProviderModels(id, modelIds) {
  const provider = getProvider(id);
  if (!provider) return 0;
  const doomed = new Set((modelIds ?? []).map((value) => String(value)));
  const models = provider.models.filter((item) => !doomed.has(item.id));
  const removed = provider.models.length - models.length;
  if (!removed) return 0;

  const fallback = models[0]?.id ?? "";
  const providers = state.settings.providers.map((item) => {
    if (item.id !== id) return item;
    return { ...item, models, model: doomed.has(item.model) ? fallback : item.model };
  });
  writeProviders(providers);
  if (
    state.settings.activeProviderId === id &&
    state.settings.model &&
    doomed.has(state.settings.model)
  ) {
    patchConnection({ model: fallback });
  }
  return removed;
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
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    // 导出不泄露任何 Key：当前连接的 Key 与每个服务商的 Key 都要脱敏
    settings: {
      ...state.settings,
      apiKey: state.settings.apiKey ? "***" : "",
      providers: state.settings.providers.map((provider) => ({
        ...provider,
        apiKey: provider.apiKey ? "***" : "",
      })),
    },
    records: [...state.records].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
  };
}

/** 导入备份：mode="replace" 覆盖恢复，mode="merge" 追加合并 */
export function importBackup(raw, { mode = "replace" } = {}) {
  const incoming = Array.isArray(raw?.records)
    ? raw.records.map(sanitizeRecord).filter(Boolean)
    : [];
  if (!incoming.length) return { ok: false, reason: "备份里没有可导入的账目" };

  // 备份里的 API Key 是导出时脱敏的 ***，不能拿它覆盖本机真实凭据
  const settings = mergeImportedSettings(raw?.settings);

  if (mode === "replace") {
    state.records = sortRecords(incoming);
    state.chat = sanitizeChat(raw?.chat);
    state.settings = settings;
    commit("all");
    return { ok: true, mode, added: incoming.length, total: incoming.length };
  }

  const ids = new Set(state.records.map((record) => record.id));
  const fingerprints = new Set(state.records.map(fingerprint));
  const fresh = incoming.filter(
    (record) => !ids.has(record.id) && !fingerprints.has(fingerprint(record)),
  );
  for (const record of fresh) fingerprints.add(fingerprint(record));

  state.records = sortRecords(state.records.concat(fresh));
  state.settings = settings;
  commit("all");
  return {
    ok: true,
    mode,
    added: fresh.length,
    skipped: incoming.length - fresh.length,
    total: state.records.length,
  };
}

/** 同一笔账的指纹：日期 + 物品 + 金额相同就视为重复 */
const fingerprint = (record) => `${record.date}|${record.item}|${record.amount}`;

const sortRecords = (list) =>
  [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));

/** 导入的设置：脱敏的 Key 保留本机值，其余按校验规则收口 */
function mergeImportedSettings(raw) {
  const base = sanitizeSettings(raw, state.settings);
  const keepSecret = (incoming, current) =>
    !incoming || incoming === "***" ? current : incoming;
  const providers = (base.providers ?? []).map((provider) => {
    const mine = state.settings.providers.find((item) => item.id === provider.id);
    return mine ? { ...provider, apiKey: keepSecret(provider.apiKey, mine.apiKey) } : provider;
  });
  return { ...base, apiKey: keepSecret(base.apiKey, state.settings.apiKey), providers };
}

export function replaceAll(next) {
  const fresh = DEFAULT_STATE();
  if (Array.isArray(next?.records)) fresh.records = next.records.map(sanitizeRecord).filter(Boolean);
  fresh.chat = sanitizeChat(next?.chat);
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
