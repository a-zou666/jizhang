/** 前后端桥接：Tauri invoke 封装 + 非 Tauri 环境兜底 */

import { mockParse, mockTestConnection } from "./mock.js";
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
 * 从兼容协议 `/v1/models` 拉取可用模型列表
 * @returns {Promise<{ok: boolean, message: string, models: string[]}>}
 */
export async function listModels(settings) {
  if (!hasBackend()) {
    // 浏览器环境：给出兜底建议列表
    return {
      ok: true,
      message: "本地预览：使用示例模型列表；实际模型请在 Android App 中拉取",
      models: [
        "gpt-4o-mini",
        "gpt-4o",
        "gpt-5",
        "claude-3-5-sonnet",
        "claude-3-7-sonnet",
        "gemini-2.0-flash",
      ],
    };
  }
  try {
    const result = await invoke("list_models", {
      protocol: settings.protocol,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
    });
    return {
      ok: Boolean(result?.ok),
      message: String(result?.message ?? ""),
      models: Array.isArray(result?.models) ? result.models.map((m) => String(m)) : [],
    };
  } catch (error) {
    return { ok: false, message: String(error?.message ?? error), models: [] };
  }
}


