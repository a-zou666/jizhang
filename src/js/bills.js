/**
 * 账单页：按日期区间统计「一共花了多少 + 各分类分别花了多少」，下方逐条列出明细。
 *
 * 区间默认「本月 1 号 → 今天」，开始 / 结束都能单独改（也可以点快捷区间一键切）。
 * 这里只做统计与展示，不改动任何账目 —— 与首页（按天看）、对话页（AI 记账）分开。
 */

import { categoryColor, getRecords, recordsInRange, sumByCategory } from "./store.js";
import { toast } from "./ui.js";
import {
  $,
  addDays,
  addMonths,
  dateKey,
  el,
  fromKey,
  round2,
  startOfMonth,
  today,
  yuan,
} from "./util.js";

/** 当前区间（YYYY-MM-DD；空串表示不限）。默认本月开头 → 今天 */
let range = defaultRange();

function defaultRange() {
  return { start: dateKey(startOfMonth(today())), end: dateKey(today()) };
}

/** 快捷区间：都按「今天」推算，不依赖用户在首页翻到哪个月 */
const PRESETS = [
  {
    key: "month",
    label: "本月",
    make: () => ({ start: dateKey(startOfMonth(today())), end: dateKey(today()) }),
  },
  {
    key: "lastMonth",
    label: "上月",
    make: () => {
      const first = addMonths(startOfMonth(today()), -1);
      return { start: dateKey(first), end: dateKey(addDays(addMonths(first, 1), -1)) };
    },
  },
  {
    key: "week",
    label: "近 7 天",
    make: () => ({ start: dateKey(addDays(today(), -6)), end: dateKey(today()) }),
  },
  {
    key: "month30",
    label: "近 30 天",
    make: () => ({ start: dateKey(addDays(today(), -29)), end: dateKey(today()) }),
  },
  { key: "all", label: "全部", make: () => ({ start: "", end: "" }) },
];

/* ---------------- 渲染 ----------------
 * 统计用的纯函数（recordsInRange / sumByCategory）放在 store.js 的数据层，
 * 这样它们不依赖 DOM，能直接在 node:test 里单测。
 */

export function renderBills() {
  const startInput = $("#billsStart");
  if (!startInput) return; // 还没装配这个页面（例如被裁剪过的 DOM）

  const endInput = $("#billsEnd");
  // 回填输入框：切快捷区间 / 纠正非法区间后，输入要跟着变
  if (startInput.value !== range.start) startInput.value = range.start;
  if (endInput && endInput.value !== range.end) endInput.value = range.end;

  const records = recordsInRange(getRecords(), range.start, range.end);
  const total = round2(records.reduce((sum, record) => sum + record.amount, 0));

  $("#billsRangeText").textContent = rangeText();
  $("#billsTotal").textContent = yuan(total);
  $("#billsCount").textContent = records.length
    ? `${records.length} 笔 · 日均 ${yuan(avgPerDay(total, records))}`
    : "这个区间还没有账目";

  renderPresets();
  renderCategories(records);
  renderRecords(records);
}

/** 区间跨了多少天：用于「日均」。全区间（不限）时按有账目的天数算 */
function avgPerDay(total, records) {
  if (!records.length) return 0;
  const days = daysInRange(records);
  return days > 0 ? total / days : total;
}

function daysInRange(records) {
  if (range.start && range.end) {
    const from = fromKey(range.start);
    const to = fromKey(range.end);
    if (from && to) return Math.max(1, Math.round((to - from) / 86400000) + 1);
    return 1;
  }
  // 不限区间：用最早一笔到今天（或最晚一笔）来估
  const dates = records.map((record) => record.date).sort();
  const from = fromKey(dates[0]);
  const to = fromKey(dates[dates.length - 1]);
  if (!from || !to) return 1;
  return Math.max(1, Math.round((to - from) / 86400000) + 1);
}

function rangeText() {
  if (!range.start && !range.end) return "全部账目";
  if (range.start === range.end) return dateLabel(range.start);
  const from = range.start ? dateLabel(range.start) : "最早";
  const to = range.end ? dateLabel(range.end) : "至今";
  return `${from} → ${to}`;
}

function dateLabel(key) {
  const date = fromKey(key);
  if (!date) return key || "—";
  const now = today();
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 记账时间（HH:MM），来自记录创建时间戳；老数据没有就留空 */
function timeText(record) {
  const at = Number(record.createdAt);
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/* ---------------- 快捷区间 ---------------- */
function renderPresets() {
  const row = $("#billsPresets");
  if (!row) return;
  row.replaceChildren(
    ...PRESETS.map((preset) => {
      const made = preset.make();
      const active = made.start === range.start && made.end === range.end;
      const chip = el("button", {
        class: `chip${active ? " is-selected" : ""}`,
        type: "button",
        text: preset.label,
      });
      chip.addEventListener("click", () => {
        range = made;
        renderBills();
      });
      return chip;
    }),
  );
}

/* ---------------- 各分类金额 ---------------- */
function renderCategories(records) {
  const box = $("#billsCats");
  const countLabel = $("#billsCatCount");
  if (!box) return;

  const cats = sumByCategory(records);
  if (countLabel) countLabel.textContent = cats.length ? `${cats.length} 个分类` : "";

  if (!cats.length) {
    box.replaceChildren(el("p", { class: "bills-empty", text: "这个区间还没有账目，换个日期试试" }));
    return;
  }

  box.replaceChildren(
    ...cats.map((item) => {
      const color = categoryColor(item.category);
      return el("div", { class: "bills-cat" }, [
        el("span", {
          class: "bills-cat__dot",
          "aria-hidden": "true",
          style: `background:${color}`,
        }),
        el("span", { class: "bills-cat__name", text: item.category }),
        el("span", { class: "bills-cat__percent t-numeric", text: `${item.percent.toFixed(1)}%` }),
        el("span", { class: "bills-cat__amount t-numeric", text: yuan(item.amount) }),
        el("span", { class: "bills-cat__track" }, [
          el("span", {
            class: "bills-cat__fill",
            style: `width:${item.percent.toFixed(1)}%;background:${color}`,
          }),
        ]),
      ]);
    }),
  );
}

/* ---------------- 逐条明细 ---------------- */
function renderRecords(records) {
  const list = $("#billsList");
  const countLabel = $("#billsListCount");
  if (!list) return;

  if (countLabel) countLabel.textContent = records.length ? `${records.length} 笔` : "";
  if (!records.length) {
    list.replaceChildren(el("li", { class: "bills-empty", text: "这个区间还没有账目" }));
    return;
  }

  list.replaceChildren(
    ...records.map((record) => {
      const time = timeText(record);
      return el("li", { class: "bills-record" }, [
        el("span", {
          class: "bills-record__dot",
          "aria-hidden": "true",
          style: `background:${categoryColor(record.category)}`,
        }),
        el("span", { class: "bills-record__main" }, [
          el("span", { class: "bills-record__item", text: record.item }),
          // 分类 · 日期 时间 —— 一眼看到这笔属于哪一类、什么时候花的
          el("span", {
            class: "bills-record__meta",
            text: `${record.category} · ${dateLabel(record.date)}${time ? ` ${time}` : ""}`,
          }),
        ]),
        el("span", { class: "bills-record__amount t-numeric", text: yuan(record.amount) }),
      ]);
    }),
  );
}

/* ---------------- 事件绑定 ---------------- */
export function bindBills() {
  const startInput = $("#billsStart");
  const endInput = $("#billsEnd");
  if (!startInput || !endInput) return;

  startInput.value = range.start;
  endInput.value = range.end;

  startInput.addEventListener("change", () => {
    const value = String(startInput.value ?? "").trim();
    if (!value) return;
    // 开始晚于结束就把结束一起带过去，别让区间变成空的
    if (range.end && value > range.end) {
      toast("开始日期晚于结束日期，已把结束日期调整为同一天", "error");
      range = { start: value, end: value };
    } else {
      range = { start: value, end: range.end };
    }
    renderBills();
  });

  endInput.addEventListener("change", () => {
    const value = String(endInput.value ?? "").trim();
    if (!value) return;
    if (range.start && value < range.start) {
      toast("结束日期早于开始日期，已把开始日期调整为同一天", "error");
      range = { start: value, end: value };
    } else {
      range = { start: range.start, end: value };
    }
    renderBills();
  });
}
