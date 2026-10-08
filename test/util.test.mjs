/** util.js 纯函数单元测试（零依赖，Node 内置 node:test 运行） */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildEndpoint,
  buildModelsEndpoint,
  clamp,
  dateKey,
  escapeHtml,
  formatCellAmount,
  formatMoney,
  isSameDay,
  monthKey,
  monthMatrix,
  normalizeDateKey,
  parseAmount,
  round2,
  weekdayOrder,
  yuan,
} from "../src/js/util.js";

test("parseAmount 宽松解析金额", () => {
  assert.equal(parseAmount(120), 120);
  assert.equal(parseAmount("¥120"), 120);
  assert.equal(parseAmount("120元"), 120);
  assert.equal(parseAmount("1,234.5"), 1234.5);
  assert.equal(parseAmount("1.2万"), 12000);
  assert.equal(parseAmount("-120"), 120); // 金额取绝对值
  assert.equal(parseAmount("３００"), 300); // 全角数字
  assert.equal(parseAmount("不详"), null); // 无法识别
  assert.equal(parseAmount(""), null);
});

test("normalizeDateKey 补零与非法拦截", () => {
  assert.equal(normalizeDateKey("2026-10-4"), "2026-10-04");
  assert.equal(normalizeDateKey("2026/10/04"), "2026-10-04");
  assert.equal(normalizeDateKey("2026.10.4"), "2026-10-04");
  assert.equal(normalizeDateKey("2026年10月4日"), "2026-10-04");
  assert.equal(normalizeDateKey("20261004"), "2026-10-04");
  assert.equal(normalizeDateKey("2026-02-31"), null); // 溢出日期
  assert.equal(normalizeDateKey("2026-13-01"), null);
  assert.equal(normalizeDateKey(""), null);
});

test("formatMoney 千分位与小数", () => {
  assert.equal(formatMoney(120), "120");
  assert.equal(formatMoney(1234.5), "1,234.5");
  assert.equal(formatMoney(1000), "1,000");
  assert.equal(formatMoney(-50), "-50");
  assert.equal(yuan(120), "¥120");
});

test("round2 两位小数", () => {
  assert.equal(round2(2.5), 2.5);
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
});

test("日期辅助", () => {
  const d = new Date(2026, 9, 4);
  assert.equal(dateKey(d), "2026-10-04");
  assert.equal(monthKey(d), "2026-10");
  assert.equal(isSameDay(d, new Date(2026, 9, 4)), true);
  assert.equal(isSameDay(d, new Date(2026, 9, 5)), false);
});

test("weekdayOrder 周一开头", () => {
  assert.deepEqual(weekdayOrder(1), [1, 2, 3, 4, 5, 6, 0]);
  assert.deepEqual(weekdayOrder(0), [0, 1, 2, 3, 4, 5, 6]);
});

test("monthMatrix 长度补齐到 7 的倍数", () => {
  const cells = monthMatrix(2026, 9, 1); // 2026-10
  assert.equal(cells.length % 7, 0);
  assert.ok(cells.some((c) => c instanceof Date && c.getDate() === 1));
  assert.ok(cells.some((c) => c instanceof Date && c.getDate() === 31));
});

test("clamp / escapeHtml / formatCellAmount", () => {
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(escapeHtml('<a>&"'), "&lt;a&gt;&amp;&quot;");
  assert.equal(formatCellAmount(120), "120");
  assert.equal(formatCellAmount(12000), "1.2万");
});

test("接口地址补全：各家前缀不一样也能拼对", () => {
  // 不带版本：补 /v1
  assert.equal(
    buildEndpoint("openai-compatible", "https://api.deepseek.com"),
    "https://api.deepseek.com/v1/chat/completions",
  );
  // 已带 /v1
  assert.equal(
    buildEndpoint("openai-compatible", "https://api.hunyuan.cloud.tencent.com/v1/"),
    "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
  );
  // 智谱 v4 / 方舟 v3：只补资源名，不能再插一个 /v1
  assert.equal(
    buildEndpoint("openai-compatible", "https://open.bigmodel.cn/api/paas/v4"),
    "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  );
  assert.equal(
    buildEndpoint("openai-compatible", "https://ark.cn-beijing.volces.com/api/v3"),
    "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
  );
  // 方舟兼容入口：没有版本号，按 OpenAI 习惯补 /v1
  assert.equal(
    buildEndpoint("openai-compatible", "https://ark.cn-beijing.volces.com/api/compatible"),
    "https://ark.cn-beijing.volces.com/api/compatible/v1/chat/completions",
  );
  // 直接粘完整地址：原样使用
  const full = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  assert.equal(buildEndpoint("openai-compatible", full), full);
  // Claude 走 /v1/messages
  assert.equal(buildEndpoint("claude", "https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  // 空地址回落到协议默认
  assert.equal(buildEndpoint("openai", ""), "https://api.openai.com/v1/chat/completions");
});

test("模型列表地址：完整地址也不会被拼歪", () => {
  assert.equal(
    buildModelsEndpoint("openai-compatible", "https://api.deepseek.com"),
    "https://api.deepseek.com/v1/models",
  );
  assert.equal(
    buildModelsEndpoint("openai-compatible", "https://open.bigmodel.cn/api/paas/v4"),
    "https://open.bigmodel.cn/api/paas/v4/models",
  );
  assert.equal(
    buildModelsEndpoint("openai-compatible", "https://ark.cn-beijing.volces.com/api/v3/chat/completions"),
    "https://ark.cn-beijing.volces.com/api/v3/models",
  );
  assert.equal(
    buildModelsEndpoint("openai-compatible", "https://ark.cn-beijing.volces.com/api/compatible"),
    "https://ark.cn-beijing.volces.com/api/compatible/v1/models",
  );
});
