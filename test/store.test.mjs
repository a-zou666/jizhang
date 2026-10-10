/** 模型管理（服务商 + 模型）的数据层单测 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { domainToASCII, domainToUnicode } from "node:url";

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

  it("在「模型选择」里选一个模型 = 切换到它所属的服务商", () => {
    const a = mod.addProvider({ name: "A", baseUrl: "https://a.test", models: ["m1", "m2"] });
    const b = mod.addProvider({ name: "B", baseUrl: "https://b.test", models: ["x1"] });
    assert.equal(mod.selectModel(a.id, "m2"), true);
    assert.equal(mod.getSettings().activeProviderId, a.id);
    assert.equal(mod.getSettings().model, "m2");
    assert.equal(mod.getSettings().baseUrl, "https://a.test");
    assert.equal(mod.getActiveProvider().id, a.id);

    assert.equal(mod.selectModel(b.id, "x1"), true);
    assert.equal(mod.getSettings().activeProviderId, b.id);
    assert.equal(mod.getSettings().model, "x1");

    // 不存在的模型 / 服务商：拒绝
    assert.equal(mod.selectModel(a.id, "nope"), false);
    assert.equal(mod.selectModel("不存在的 id", "m1"), false);
    assert.equal(mod.getSettings().activeProviderId, b.id);
  });

  it("删除模型：删掉的是当前模型时回退到剩下一个", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", models: ["m1", "m2"] });
    mod.selectModel(provider.id, "m2");
    mod.removeProviderModel(provider.id, "m2");
    assert.deepEqual(
      mod.getProvider(provider.id).models.map((item) => item.id),
      ["m1"],
    );
    assert.equal(mod.getSettings().model, "m1");
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

describe("保存服务商时，空 Key 不能把已有的 Key 清掉", () => {
  /* 真实事故：编辑服务商时密码框不回显旧 Key，留空保存会把已存 Key 静默清空，
   * 之后拉模型 / 对话都 401，而界面上「当前启用的是哪家」看起来完全正常。 */
  it("updateProvider 传空 apiKey 时保留已有 Key", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-original" });
    mod.updateProvider(provider.id, { name: "A2", apiKey: "" });
    assert.equal(mod.getProvider(provider.id).apiKey, "sk-original");
    assert.equal(mod.getProvider(provider.id).name, "A2");
  });

  it("updateProvider 不传 apiKey 时同样保留已有 Key", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-original" });
    mod.updateProvider(provider.id, { name: "A2" });
    assert.equal(mod.getProvider(provider.id).apiKey, "sk-original");
  });

  it("updateProvider 传新 Key 时正常覆盖", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-old" });
    mod.updateProvider(provider.id, { apiKey: "sk-new" });
    assert.equal(mod.getProvider(provider.id).apiKey, "sk-new");
  });

  it("patchConnection 传空 apiKey 时，顶层与已启用服务商的 Key 都保留", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-original" });
    mod.activateProvider(provider.id);
    // 连接编辑页改了地址但没动 Key 栏
    mod.patchConnection({ baseUrl: "https://a2.test", apiKey: "" });
    assert.equal(mod.getSettings().apiKey, "sk-original");
    assert.equal(mod.getProvider(provider.id).apiKey, "sk-original");
    assert.equal(mod.getSettings().baseUrl, "https://a2.test");
  });

  it("patchConnection 传新 apiKey 时正常覆盖", () => {
    const provider = mod.addProvider({ name: "A", baseUrl: "https://a.test", apiKey: "sk-old" });
    mod.activateProvider(provider.id);
    mod.patchConnection({ apiKey: "sk-new" });
    assert.equal(mod.getSettings().apiKey, "sk-new");
    assert.equal(mod.getProvider(provider.id).apiKey, "sk-new");
  });
});

describe("服务商 id 必须稳定（activeProviderId 不能莫名丢失）", () => {
  /* 拿真实事故换来的回归测试：
   * sanitizeSettings 曾经把服务商列表清洗两遍，而缺 id 时每次都会现场摇一个随机 id，
   * 于是 providers 里存第一批、activeProviderId 却拿第二批去比 → 永远对不上 →
   * 被清成 "" → App 静默回退到顶层 apiKey（可能是别家的）→ 远端 401，
   * 而界面上「当前启用的哪家」看起来完全正常。 */
  it("缺 id 的老数据：清洗两次得到同一套 id（幂等）", () => {
    store.set(
      "ai-ledger/v1",
      JSON.stringify({
        records: [],
        chat: [],
        settings: {
          providers: [{ name: "豆包（火山方舟）" }, { name: "mini" }],
          activeProviderId: "",
        },
      }),
    );
    mod.load();
    const first = mod.getProviders().map((item) => item.id);
    mod.load();
    const second = mod.getProviders().map((item) => item.id);
    assert.deepEqual(second, first, "同一份数据反复清洗，id 必须一致");
    assert.ok(first.every(Boolean), "每个服务商都要有 id");
  });

  it("activeProviderId 指向的服务商 id 能对上，就不会被清空", () => {
    store.set(
      "ai-ledger/v1",
      JSON.stringify({
        records: [],
        chat: [],
        settings: {
          providers: [{ name: "豆包" }, { name: "mini" }],
          // 缺 id 的兜底 id 由「下标 + 名称」派生，第 0 条是 p0-豆包
          activeProviderId: "p0-豆包",
        },
      }),
    );
    mod.load();
    assert.equal(mod.getSettings().activeProviderId, "p0-豆包");
    assert.equal(mod.getActiveProvider().name, "豆包");
  });

  it("同名服务商各自独立（新建时用全新 id，不靠名称派生）", () => {
    const a = mod.addProvider({ name: "同名", baseUrl: "https://a.test", apiKey: "sk-a" });
    const b = mod.addProvider({ name: "同名", baseUrl: "https://b.test", apiKey: "sk-b" });
    assert.notEqual(a.id, b.id, "两个同名服务商必须是不同 id");
    assert.equal(mod.getProvider(a.id).apiKey, "sk-a");
    assert.equal(mod.getProvider(b.id).apiKey, "sk-b");
  });

  it("activeProviderId 指向不存在的服务商时才清空", () => {
    store.set(
      "ai-ledger/v1",
      JSON.stringify({
        records: [],
        chat: [],
        settings: { providers: [{ name: "豆包" }], activeProviderId: "根本不存在" },
      }),
    );
    mod.load();
    assert.equal(mod.getSettings().activeProviderId, "");
    assert.equal(mod.getActiveProvider(), null);
  });
});

describe("预算：默认月预算 + 单月覆盖", () => {
  const october = new Date(2026, 9, 1);
  const november = new Date(2026, 10, 1);

  it("没单独设置的月份沿用默认月预算", () => {
    mod.patchConnection({}); // 无操作，确保状态干净
    mod.setSettings({ budget: 3000 });
    assert.equal(mod.getMonthBudget(october), 3000);
    assert.equal(mod.hasOwnMonthBudget(october), false);
  });

  it("某个月单独设预算后，只有那个月变", () => {
    mod.setSettings({ budget: 3000 });
    assert.equal(mod.setMonthBudget(october, 1800), true);
    assert.equal(mod.getMonthBudget(october), 1800);
    assert.equal(mod.getMonthBudget(november), 3000);
    assert.equal(mod.hasOwnMonthBudget(october), true);
  });

  it("恢复默认后回到全局预算", () => {
    mod.setSettings({ budget: 3000 });
    mod.setMonthBudget(october, 1800);
    assert.equal(mod.resetMonthBudget(october), true);
    assert.equal(mod.getMonthBudget(october), 3000);
    assert.equal(mod.resetMonthBudget(october), false);
  });

  it("拒绝非法月份键与负数金额", () => {
    assert.equal(mod.setMonthBudget("2026-13", 100), false);
    assert.equal(mod.setMonthBudget("不是月份", 100), false);
    assert.equal(mod.setMonthBudget(october, -50), false);
    assert.deepEqual(mod.getSettings().budgets, {});
  });

  it("导入的预算数据被清洗", () => {
    mod.replaceAll({
      records: [],
      settings: { budget: 2000, budgets: { "2026-10": 1500, "2026-02-30": 900, bad: 100, "2027-01": -5 } },
    });
    assert.deepEqual(mod.getSettings().budgets, { "2026-10": 1500 });
    assert.equal(mod.getMonthBudget(october), 1500);
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

describe("对话里的图片（识图记账）", () => {
  const thumb = "data:image/jpeg;base64,THUMB";

  it("消息里只存缩略图，非法 / 超大图片不入库", () => {
    mod.clearChat();
    mod.appendChat({ role: "user", text: "小票", kind: "text", state: "done", images: [thumb] });
    assert.equal(mod.getChat()[0].images[0], thumb);

    mod.appendChat({ role: "user", text: "假图", images: ["javascript:alert(1)"] });
    mod.appendChat({ role: "user", text: "大图", images: [`data:image/png;base64,${"A".repeat(50_000)}`] });
    assert.equal(mod.getChat()[1].images.length, 0);
    assert.equal(mod.getChat()[2].images.length, 0);
  });

  it("预览图与缩略图按下标配对（点开看大图用）", () => {
    mod.clearChat();
    const view = "data:image/jpeg;base64,VIEW";
    mod.appendChat({
      role: "user",
      text: "两张",
      kind: "text",
      state: "done",
      images: [`${thumb}A`, `${thumb}B`],
      views: [view, ""],
    });
    const message = mod.getChat()[0];
    assert.equal(message.images.length, 2);
    assert.equal(message.views.length, 2);
    assert.equal(message.views[0], view);
    // 缺预览图的位置留空串，渲染时退回缩略图，不硬补成 undefined
    assert.equal(message.views[1], "");
  });

  it("预览图过大或不是图片时丢弃，长度与缩略图对齐", () => {
    mod.clearChat();
    mod.appendChat({
      role: "user",
      text: "混合",
      kind: "text",
      state: "done",
      images: [`${thumb}A`, `${thumb}B`, `${thumb}C`],
      views: [
        "data:image/jpeg;base64,OK",
        `data:image/png;base64,${"A".repeat(200_000)}`,
        "javascript:alert(1)",
      ],
    });
    const message = mod.getChat()[0];
    // 长度永远跟 images 一样，坏值落成空串而不是被删掉（否则下标就错位了）
    assert.equal(message.views.length, 3);
    assert.equal(message.views[0], "data:image/jpeg;base64,OK");
    assert.equal(message.views[1], "");
    assert.equal(message.views[2], "");
  });

  it("老消息没有 views 字段也不会崩（升级前的历史）", () => {
    mod.clearChat();
    mod.appendChat({ role: "user", text: "旧消息", kind: "text", state: "done", images: [thumb] });
    assert.deepEqual(mod.getChat()[0].views, []);
  });

  it("清理旧消息图片时，预览图一起清掉", () => {
    mod.clearChat();
    const view = "data:image/jpeg;base64,VIEW";
    for (let i = 0; i < 35; i += 1) {
      mod.appendChat({
        role: "user",
        text: `第 ${i} 条`,
        kind: "text",
        state: "done",
        images: [thumb],
        views: [view],
      });
    }
    const chat = mod.getChat();
    assert.equal(chat[0].images.length, 0);
    assert.equal(chat[0].views.length, 0);
    assert.equal(chat.at(-1).views[0], view);
  });

  it("缩略图只保留最近若干条，更早的消息文字照旧", () => {
    mod.clearChat();
    for (let i = 0; i < 40; i += 1) {
      mod.appendChat({ role: "user", text: `第 ${i} 条`, kind: "text", state: "done", images: [thumb] });
    }
    const chat = mod.getChat();
    assert.equal(chat.length, 40);
    assert.equal(chat.filter((item) => item.images.length).length, 30);
    assert.equal(chat[0].images.length, 0);
    assert.equal(chat[0].text, "第 0 条");
    assert.equal(chat.at(-1).images[0], thumb);
  });

  it("清空对话把图片一起清掉，账目不受影响", () => {
    mod.clearChat();
    mod.addRecords([{ date: "2026-10-08", item: "鼠标", category: "数码", amount: 120 }]);
    mod.appendChat({ role: "user", text: "小票", kind: "text", state: "done", images: [thumb] });
    assert.equal(mod.getChat()[0].images[0], thumb);

    mod.clearChat();
    assert.deepEqual(mod.getChat(), []);
    assert.equal(mod.getRecords().length, 1);
  });
});

describe("软件更新（纯逻辑）", () => {
  it("版本号比较：常规递进", () => {
    assert.equal(mod.isNewerVersion("0.1.1", "0.1.0"), true);
    assert.equal(mod.isNewerVersion("v0.1.1", "0.1.0"), true);
    assert.equal(mod.isNewerVersion("0.1.0", "0.1.0"), false);
    assert.equal(mod.isNewerVersion("0.0.9", "0.1.0"), false);
    // 段数不同按补 0 处理
    assert.equal(mod.isNewerVersion("0.10", "0.9.9"), true);
    assert.equal(mod.isNewerVersion("0.1", "0.1.0"), false);
    assert.equal(mod.isNewerVersion("1.0", "0.99.99"), true);
  });

  it("版本号比较：预发布小于同号正式版", () => {
    assert.equal(mod.isNewerVersion("0.2.0-beta", "0.2.0"), false);
    assert.equal(mod.isNewerVersion("0.2.0", "0.2.0-beta"), true);
    assert.equal(mod.isNewerVersion("0.2.0-beta", "0.2.0-beta.2"), false);
  });

  it("版本号比较：空值与异常输入不炸", () => {
    assert.equal(mod.isNewerVersion("", "0.1.0"), false);
    assert.equal(mod.isNewerVersion(null, "0.1.0"), false);
    assert.equal(mod.isNewerVersion("abc", "0.1.0"), false);
    assert.equal(mod.isNewerVersion("0.0.0-dev", "0.0.0-dev"), false);
  });

  it("更新源常量指向自建服务器（不能退回 Gitee / GitHub）", () => {
    // 必须走 HTTPS：Android 默认拦明文 HTTP，用 http:// 会被系统直接拒掉。
    assert.match(mod.UPDATE_RELEASES_PAGE, /^https:\/\//);
    // 域名用 punycode 形式（中文域名 `电脑.tech` 转写而来）。
    // 断言「是 ASCII」是为了防止有人改回中文字面量 —— 部分运行时对 IDN 处理不一致。
    assert.equal(mod.UPDATE_HOST, "apk.xn--wnyy6w.tech");
    assert.ok(/^[\x20-\x7e]+$/.test(mod.UPDATE_HOST), "域名必须是 ASCII（punycode）");
    assert.ok(mod.UPDATE_RELEASES_PAGE.includes(mod.UPDATE_HOST));
    // 这两个都是被淘汰的第三方源，一个都不能回退
    assert.ok(!mod.UPDATE_RELEASES_PAGE.includes("gitee.com"));
    assert.ok(!mod.UPDATE_RELEASES_PAGE.includes("github.com"));
  });

  it("下载页兜底地址走浏览器端口（:9444），不是 App 端口（:9443）", () => {
    // 两个端口用**不同的证书**，搞混了用户就会撞上证书警告：
    //   :9443 = App 内更新（自签证书，App 内置根 CA 才认；浏览器不认）
    //   :9444 = 用户浏览器打开下载页（Let's Encrypt，零警告）
    // 所以这个常量的端口**必须是 9444** —— 它是给浏览器用的。
    assert.match(
      mod.UPDATE_RELEASES_PAGE,
      /:9444\/$/,
      `下载页兜底地址必须指向 :9444（浏览器端口），现在是 ${mod.UPDATE_RELEASES_PAGE}`
    );
    assert.ok(
      !mod.UPDATE_RELEASES_PAGE.includes(":9443"),
      "下载页不能指向 :9443 —— 那是自签证书，浏览器会报警告"
    );
  });

  it("更新源域名的 punycode 真的解回 `电脑.tech`（抄错立刻红）", () => {
    // `xn--` 后面是一段 base36，肉眼根本分不出对错：
    // `xn--nyqx68a` 看着也像模像样，实际解出来是 `徳健` —— 等于指向一个不存在的域名，
    // 而且症状是「点了更新却检测不到新版本」，极难归因。这里用运行时交叉验证。
    const decoded = domainToUnicode(mod.UPDATE_HOST);
    assert.equal(decoded, "apk.电脑.tech", `punycode 解出来是 ${decoded}，不是 apk.电脑.tech`);
    // 反向：把中文再编回去，必须和常量逐字相同
    assert.equal(domainToASCII("apk.电脑.tech"), mod.UPDATE_HOST);
  });

  it("归一化检查结果：成功且有更新", () => {
    const result = mod.normalizeUpdateResult(
      {
        ok: true,
        hasUpdate: true,
        latestVersion: "0.2.0",
        currentVersion: "0.1.0",
        notes: "- 修了个 bug",
        downloadUrl: "https://gitee.com/x/y/releases/download/latest/a.apk",
        pageUrl: "https://gitee.com/x/y/releases",
        message: "发现新版本 0.2.0",
      },
      "0.1.0",
    );
    assert.equal(result.failed, false);
    assert.equal(result.hasUpdate, true);
    assert.equal(result.latestVersion, "0.2.0");
    assert.equal(result.downloadUrl.endsWith("a.apk"), true);
  });

  it("归一化检查结果：失败时兜底到发布页", () => {
    const result = mod.normalizeUpdateResult({ ok: false, message: "连不上" }, "0.1.0");
    assert.equal(result.failed, true);
    assert.equal(result.hasUpdate, false);
    assert.equal(result.currentVersion, "0.1.0");
    assert.equal(result.pageUrl, mod.UPDATE_RELEASES_PAGE);
    assert.equal(result.message, "连不上");
  });

  it("归一化检查结果：完全空的返回也不炸", () => {
    const result = mod.normalizeUpdateResult(undefined, "0.1.0");
    assert.equal(result.failed, true);
    assert.equal(result.currentVersion, "0.1.0");
    assert.equal(result.latestVersion, "");
  });

  it("更新说明清洗：markdown 转纯文本且限行", () => {
    const notes = mod.cleanReleaseNotes(
      [
        "# 更新",
        "- 修了个 bug",
        "* 加了新功能",
        "**加粗**文本",
        "`代码`样式",
        "1. 有序项",
        "",
        "   ",
      ].join("\n"),
    );
    const lines = notes.split("\n");
    assert.equal(lines[0], "更新");
    assert.equal(lines[1], "· 修了个 bug");
    assert.equal(lines[2], "· 加了新功能");
    assert.equal(lines[3], "加粗文本");
    assert.equal(lines[4], "代码样式");
    // 空行被剔除
    assert.equal(lines.includes(""), false);
  });

  it("更新说明清洗：空输入返回空串", () => {
    assert.equal(mod.cleanReleaseNotes(null), "");
    assert.equal(mod.cleanReleaseNotes(undefined), "");
    assert.equal(mod.cleanReleaseNotes("   "), "");
  });
});
