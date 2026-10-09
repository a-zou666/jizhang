/** 前后端桥接：Tauri invoke 封装 + 非 Tauri 环境兜底 */

import { mockImage, mockIntent, mockParse, mockTestConnection } from "./mock.js";
import { normalizeDateKey, parseAmount } from "./util.js";

const tauriInvoke = () => {
  const api = globalThis.__TAURI__;
  return typeof api?.core?.invoke === "function" ? api.core.invoke : null;
};

export const hasBackend = () => Boolean(tauriInvoke());

async function invoke(command, args) {
  const call = tauriInvoke();
  if (!call) throw new Error("当前环境没有 Tauri 后端");
  return call(command, args);
}

function normalizeRaw(raw, index) {
  return {
    id: raw?.id ?? `ai-${Date.now().toString(36)}-${index}`,
    date: normalizeDateKey(raw?.date) ?? "",
    item: String(raw?.item ?? "未命名"),
    category: String(raw?.category ?? "其他"),
    amount: parseAmount(raw?.amount) ?? 0,
    createdAt: Date.now() + index,
  };
}

/**
 * 调用大模型解析自然语言账单
 *
 * 归一化（日期 → YYYY-MM-DD、金额 → 数字）在 normalizeRaw 里做，
 * 这里只统计「救不回来」的条目数并回传，避免解析结果被静默丢掉。
 * @returns {Promise<{records: Array<{id,date,item,category,amount,createdAt}>, skipped: number}>}
 */
export async function parseAccounting(text, settings) {
  const list = hasBackend()
    ? await invoke("process_accounting", {
        text,
        protocol: settings.protocol,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        apiModel: settings.model,
        categories: settings.categories,
      })
    : mockParse(text);

  const normalized = (Array.isArray(list) ? list : []).map(normalizeRaw);
  const records = normalized.filter((record) => record.amount > 0 && record.date);
  return { records, skipped: normalized.length - records.length };
}

/**
 * 意图识别 + 记账二合一：一次无状态调用支持「新增 / 删除 / 查询 / 闲聊」。
 * ledger 为紧凑账目快照（每行 `序号|日期|物品|分类|金额`，最新在前，至多 100 行），
 * 由调用方构造；ids 返回的是账目行序号（从 1 开始），调用方据此映射回真实记录。
 * @returns {Promise<{op: "add"|"del"|"query"|"none", items: Array, ids: number[], reply: string}>}
 */
/** 解析等待上限：超过就放弃并让用户重试，避免界面一直转圈没有反馈 */
export const AI_TIMEOUT_MS = 25000;

/** 归一化一次意图调用的返回：日期 / 金额兜底，并剔除救不回来的条目 */
function normalizeIntent(result) {
  const items = (Array.isArray(result?.items) ? result.items : [])
    .map(normalizeRaw)
    .filter((record) => record.amount > 0 && record.date);
  return {
    op: String(result?.op ?? "none"),
    items,
    ids: Array.isArray(result?.ids) ? result.ids.map((id) => Number(id)).filter(Number.isFinite) : [],
    reply: String(result?.reply ?? ""),
  };
}

/** 解析失败时统一成一句人话，前端直接展示并可重试 */
function describeIntentError(error) {
  return new Error(
    error?.message === "请求超时"
      ? `模型 ${AI_TIMEOUT_MS / 1000} 秒未响应，请稍后重试或换一个模型`
      : String(error?.message ?? error),
  );
}

export async function parseIntent(text, settings, ledger) {
  if (!hasBackend()) return mockIntent(text, ledger);

  const call = () =>
    invoke("process_intent", {
      text,
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      apiModel: settings.model,
      categories: settings.categories,
      ledger,
    });

  let result;
  try {
    result = await withTimeout(call(), AI_TIMEOUT_MS);
  } catch (error) {
    // 超时或后端异常统一成一句人话，前端直接展示并可重试
    throw describeIntentError(error);
  }

  return normalizeIntent(result);
}

/**
 * 识图记账：把图片（data URL 数组）连同可选的一句话交给视觉模型，
 * 让它自己从小票 / 账单 / 支付截图里读出每一笔并输出同样的意图 JSON。
 * 支持一次多张图（如多张小票），用法与 parseIntent 完全一致，前端复用同一套 add / del / query 卡片。
 * @param {string[]} images data URL 数组（前端已压缩）
 */
export async function parseImage(text, images, settings, ledger) {
  if (!hasBackend()) return mockImage(text, ledger);

  const call = () =>
    invoke("process_image", {
      text,
      images,
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      apiModel: settings.model,
      categories: settings.categories,
      ledger,
    });

  let result;
  try {
    result = await withTimeout(call(), AI_TIMEOUT_MS);
  } catch (error) {
    throw describeIntentError(error);
  }

  return normalizeIntent(result);
}

/**
 * 测试 API 连通性
 * @returns {Promise<{ok: boolean, message: string, model?: string}>}
 */
export async function testConnection(settings) {
  if (!hasBackend()) return mockTestConnection(settings);
  try {
    const result = await invoke("test_connection", {
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      apiModel: settings.model,
    });
    return { ok: Boolean(result?.ok), message: String(result?.message ?? ""), model: result?.model };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error) };
  }
}

/**
 * 从兼容协议 `/v1/models` 拉取可用模型列表。
 *
 * 健壮性：超时（15s）+ 至多 1 次重试；全部失败时用「上次成功拉取的真实模型」兜底，
 * 但绝不返回任何假模型/示例列表。无后端环境直接 ok:false 且不提供任何模型。
 * @returns {Promise<{ok: boolean, message: string, models: string[], cached?: boolean}>}
 */
const MODEL_CACHE_KEY = "ai-ledger/models-cache";

function loadModelCache() {
  try {
    const raw = localStorage.getItem(MODEL_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveModelCache(cache) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 隐私模式 / 配额满：缓存失败不影响主流程 */
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("请求超时")), ms)),
  ]);
}

export async function listModels(settings) {
  if (!hasBackend()) {
    return {
      ok: false,
      message: "当前环境无法直接拉取模型，请在 App 中配置并拉取真实模型列表",
      models: [],
    };
  }
  const cache = loadModelCache();
  const key = `${settings.protocol}@${settings.baseUrl}`;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await withTimeout(
        invoke("list_models", {
          protocol: settings.protocol,
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
        }),
        15000,
      );
      const models = Array.isArray(result?.models) ? result.models.map((m) => String(m)) : [];
      cache[key] = models;
      saveModelCache(cache);
      return {
        ok: Boolean(result?.ok),
        message: String(result?.message ?? ""),
        models,
      };
    } catch (error) {
      lastError = error;
    }
  }
  // 全部失败：回退到上次成功拉取的真实列表（不造任何假模型）
  if (cache[key]?.length) {
    return {
      ok: true,
      cached: true,
      message: "使用上次成功拉取的模型列表（本次请求失败）",
      models: cache[key],
    };
  }
  return { ok: false, message: String(lastError?.message ?? lastError), models: [] };
}


