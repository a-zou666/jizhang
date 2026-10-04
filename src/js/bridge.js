/** 前后端桥接：Tauri invoke 封装 + 非 Tauri 环境兜底 */

import { mockParse, mockTestConnection } from "./mock.js";

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
  const amount = Number(raw?.amount);
  return {
    id: raw?.id ?? `ai-${Date.now().toString(36)}-${index}`,
    date: String(raw?.date ?? "").slice(0, 10),
    item: String(raw?.item ?? "未命名"),
    category: String(raw?.category ?? "其他"),
    amount: Number.isFinite(amount) ? Math.abs(amount) : 0,
    createdAt: Date.now() + index,
  };
}

/**
 * 调用大模型解析自然语言账单
 * @returns {Promise<Array<{id,date,item,category,amount,createdAt}>>}
 */
export async function parseAccounting(text, settings) {
  if (!hasBackend()) {
    return mockParse(text);
  }
  const raw = await invoke("process_accounting", {
    text,
    protocol: settings.protocol,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    apiModel: settings.model,
    categories: settings.categories,
  });
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map(normalizeRaw)
    .filter((record) => record.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(record.date));
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
