/** util.js 纯函数单元测试（零依赖，Node 内置 node:test 运行） */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
