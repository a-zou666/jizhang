/** 账单页纯逻辑：按日期区间过滤 + 按分类汇总 */

import { test } from "node:test";
import assert from "node:assert/strict";

// 统计函数放在数据层 store.js（不依赖 DOM），账单页只是消费它们
import { recordsInRange, sumByCategory } from "../src/js/store.js";

const rec = (id, date, category, amount, createdAt = 0) => ({
  id,
  date,
  item: id,
  category,
  amount,
  createdAt,
});

const sample = [
  rec("a", "2026-10-01", "餐饮", 30, 1),
  rec("b", "2026-10-05", "交通", 10, 2),
  rec("c", "2026-10-05", "餐饮", 20, 3),
  rec("d", "2026-09-30", "娱乐", 100, 4),
  rec("e", "2026-10-09", "数码", 50, 5),
];

test("区间过滤：只保留区间内的账目，且按日期倒序（同一天按时间倒序）", () => {
  const result = recordsInRange(sample, "2026-10-01", "2026-10-09").map((r) => r.id);
  assert.deepEqual(result, ["e", "c", "b", "a"]);
});

test("区间过滤：两端都是闭区间，边界当天会被算进来", () => {
  assert.deepEqual(recordsInRange(sample, "2026-10-01", "2026-10-01").map((r) => r.id), ["a"]);
  assert.deepEqual(recordsInRange(sample, "2026-10-09", "2026-10-09").map((r) => r.id), ["e"]);
});

test("区间过滤：空端点表示不限，能取全部 / 只限一边", () => {
  assert.equal(recordsInRange(sample, "", "").length, 5);
  assert.deepEqual(recordsInRange(sample, "2026-10-06", "").map((r) => r.id), ["e"]);
  assert.deepEqual(recordsInRange(sample, "", "2026-09-30").map((r) => r.id), ["d"]);
});

test("区间过滤：区间内没有账目时返回空数组（不报错）", () => {
  assert.deepEqual(recordsInRange(sample, "2025-01-01", "2025-01-31"), []);
  assert.deepEqual(recordsInRange([], "2026-10-01", "2026-10-09"), []);
});

test("分类汇总：金额降序，同分类相加", () => {
  const result = sumByCategory(sample);
  // 娱乐 100 > 餐饮(30+20)=50 = 数码 50 > 交通 10
  assert.deepEqual(result.map((item) => item.category), ["娱乐", "餐饮", "数码", "交通"]);
  assert.equal(result.find((item) => item.category === "餐饮").amount, 50);

  const amounts = result.map((item) => item.amount);
  assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), "金额应当按降序排列");
});

test("分类汇总：占比之和为 100（单分类时为 100）", () => {
  const all = sumByCategory(sample);
  const sum = all.reduce((acc, item) => acc + item.percent, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6, `占比之和应为 100，实际 ${sum}`);

  const one = sumByCategory([rec("x", "2026-10-01", "餐饮", 12)]);
  assert.equal(one[0].percent, 100);
});

test("分类汇总：空输入返回空数组，不会出现 division by zero", () => {
  assert.deepEqual(sumByCategory([]), []);
  const zero = sumByCategory([rec("z", "2026-10-01", "餐饮", 0)]);
  assert.equal(zero[0].percent, 0);
});
