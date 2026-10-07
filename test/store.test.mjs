/** 模型管理（服务商 + 模型）的数据层单测 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

/* store.js 走 localStorage 持久化，node 里给个内存桩 */
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const mod = await import("../src/js/store.js");

beforeEach(() => {
  mod.replaceAll({ records: [], settings: {} });
});

describe("服务商（模型供应商）", () => {
  it("新增的服务商不会自动改动当前连接", () => {
    const provider = mod.addProvider({
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-x",
    });
    assert.ok(provider.id);
    const settings = mod.getSettings();
    assert.equal(settings.activeProviderId, "");
    assert.equal(settings.baseUrl, "");
    assert.equal(settings.apiKey, "");
  });

  it("名称缺失时给出兜底名，非法协议回退为 OpenAI 兼容", () => {
    const provider = mod.addProvider({ protocol: "不存在的协议", baseUrl: "https://x.test" });
    assert.equal(provider.name, "未命名服务商");
    assert.equal(provider.protocol, "openai-compatible");
  });

  it("更新 / 删除服务商", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test" });
    mod.updateProvider(provider.id, { name: "B", apiKey: "sk-b" });
    assert.equal(mod.getProvider(provider.id).name, "B");
    assert.equal(mod.getProvider(provider.id).apiKey, "sk-b");

    assert.equal(mod.removeProvider(provider.id), true);
    assert.equal(mod.getProvider(provider.id), null);
    assert.equal(mod.removeProvider("不存在的 id"), false);
  });

  it("删除当前启用的服务商后，启用状态复位", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test" });
    mod.activateProvider(provider.id);
    assert.equal(mod.getSettings().activeProviderId, provider.id);
    mod.removeProvider(provider.id);
    assert.equal(mod.getSettings().activeProviderId, "");
  });
});

describe("启用服务商 = 唯一的切换入口", () => {
  it("启用后把地址 / Key / 默认模型写进当前连接", () => {
    const provider = mod.addProvider({
      name: "Minimax",
      protocol: "claude",
      baseUrl: "https://api.minimax.chat/v1",
      apiKey: "sk-minimax",
      models: [{ id: "MiniMax-Text-01" }, { id: "abab6.5s-chat" }],
    });
    mod.activateProvider(provider.id);
    const settings = mod.getSettings();
    assert.equal(settings.protocol, "claude");
    assert.equal(settings.baseUrl, "https://api.minimax.chat/v1");
    assert.equal(settings.apiKey, "sk-minimax");
    assert.equal(settings.model, "MiniMax-Text-01");
    assert.equal(mod.getActiveProvider().id, provider.id);
  });

  it("启用不存在的服务商返回 null，且不动当前连接", () => {
    assert.equal(mod.activateProvider("nope"), null);
    assert.equal(mod.getSettings().activeProviderId, "");
  });
});

describe("模型列表", () => {
  it("手动添加：去空、去重、丢弃非法项，重复添加返回 0", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test" });
    assert.equal(mod.addProviderModels(provider.id, ["m1", "m1", "  ", 7, { id: "m2", alias: "别名" }]), 2);
    assert.deepEqual(
      mod.getProvider(provider.id).models.map((item) => item.id),
      ["m1", "m2"],
    );
    assert.equal(mod.addProviderModels(provider.id, ["m1"]), 0);
  });

  it("设为默认 / 删除模型", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", models: ["m1", "m2"] });
    mod.setProviderModel(provider.id, "m2");
    assert.equal(mod.getProvider(provider.id).model, "m2");

    mod.removeProviderModel(provider.id, "m2");
    assert.deepEqual(
      mod.getProvider(provider.id).models.map((item) => item.id),
      ["m1"],
    );
    // 被删掉的正好是默认模型时，默认回退到剩下的第一个
    assert.equal(mod.getProvider(provider.id).model, "m1");
  });

  it("启用的服务商设默认模型会同步到当前连接", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", models: ["m1", "m2"] });
    mod.activateProvider(provider.id);
    mod.setProviderModel(provider.id, "m2");
    assert.equal(mod.getSettings().model, "m2");
  });
});

describe("当前连接改动只同步到已启用的那一家", () => {
  it("其他服务商不受影响", () => {
    const a = mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-a" });
    mod.addProvider({ name: "B", baseUrl: "https://b.test", apiKey: "sk-b" });
    mod.activateProvider(a.id);

    mod.patchConnection({ apiKey: "sk-a-2", model: "m9" });
    assert.equal(mod.getSettings().apiKey, "sk-a-2");
    assert.equal(mod.getProvider(a.id).apiKey, "sk-a-2");
    assert.equal(mod.getProvider(a.id).model, "m9");
    assert.equal(mod.getSettings().model, "m9");
    assert.equal(mod.getProviders().find((item) => item.name === "B").apiKey, "sk-b");
  });

  it("没有启用服务商时只写当前连接", () => {
    mod.patchConnection({ baseUrl: "https://temp.test", apiKey: "sk-temp" });
    assert.equal(mod.getSettings().baseUrl, "https://temp.test");
    assert.deepEqual(mod.getProviders(), []);
  });
});

describe("导入 / 导出的收口", () => {
  it("导入的非法服务商被清洗，失效的启用 id 复位", () => {
    mod.replaceAll({
      records: [],
      settings: {
        providers: [null, { name: "坏" }, { name: "好", protocol: "不存在的协议", models: [1, "ok"] }],
        activeProviderId: "不存在的 id",
      },
    });
    const providers = mod.getProviders();
    assert.equal(providers.length, 2);
    assert.equal(providers[1].protocol, "openai-compatible");
    assert.deepEqual(providers[1].models, [{ id: "ok", alias: "" }]);
    assert.equal(mod.getSettings().activeProviderId, "");
  });

  it("导出时每个服务商的 API Key 都脱敏", () => {
    mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-secret" });
    mod.patchConnection({ apiKey: "sk-current" });
    const payload = mod.exportPayload();
    assert.equal(payload.settings.apiKey, "***");
    assert.ok(payload.settings.providers.every((item) => item.apiKey === "***"));
  });
});
