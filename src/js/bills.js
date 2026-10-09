/**
 * 账单页：按日期区间统计「一共花了多少 + 各分类分别花了多少」，下方逐条列出明细。
 *
 * 区间默认「本月 1 号 → 今天」，开始 / 结束都能单独改（也可以点快捷区间一键切）。
 * 这里只做统计与展示，不改动任何账目 —— 与首页（按天看）、对话页（AI 记账）分开。
 *
 * 页面结构（自上而下三块）：
 *   ① 日期区间：开始 / 结束 + 快捷区间
 *   ② 区间概览：环形图（各分类占比，圆心是区间合计）+ 三个关键指标 + 分类金额榜
 *   ③ 消费明细：可按分类筛选（默认全部），再按日期分组，每行给出分类 · 时间 · 金额
 * 统计用的纯函数（recordsInRange / sumByCategory / daysBetween / groupRecordsByDate /
 * filterByCategory）都放在 store.js 的数据层，不依赖 DOM，能直接在 node:test 里单测。
 */

import {
  categoryColor,
  daysBetween,
  filterByCategory,
  getRecords,
  groupRecordsByDate,
  recordsInRange,
  sumByCategory,
} from "./store.js";
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

/** 消费明细的分类筛选：空串 = 全部；只影响明细，区间概览始终是整个区间的账 */
let categoryFilter = "";

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
  const totalText = yuan(total);

  $("#billsRangeText").textContent = rangeText();

  // 圆心金额：位数多了就降一档字号，避免撑破圆环内圈
  const totalNode = $("#billsTotal");
  totalNode.textContent = totalText;
  totalNode.classList.toggle("is-long", totalText.length > 8);
  $("#billsCount").textContent = records.length ? `${records.length} 笔` : "还没有账目";

  renderPresets();
  renderStats(records, total);

  // 分类汇总一次，环形图、分类榜、筛选条共用同一份数据
  const cats = sumByCategory(records);
  // 换了区间后，如果之前选的分类在新区间里根本没有，就退回「全部」
  if (categoryFilter && !cats.some((item) => item.category === categoryFilter)) {
    categoryFilter = "";
  }

  renderDonut(cats);
  renderCategories(cats);
  renderFilter(cats, records);

  const shown = filterByCategory(records, categoryFilter);
  renderRecords(shown, records.length);
}

/** 区间跨了多少天：用于「日均」。全区间（不限）时按有账目的天数算 */
function avgPerDay(total, records) {
  if (!records.length) return 0;
  const days = daysInRange(records);
  return days > 0 ? total / days : total;
}

function daysInRange(records) {
  const bounded = daysBetween(range.start, range.end);
  if (bounded) return bounded;
  // 不限区间：用最早一笔到最晚一笔来估
  const dates = records.map((record) => record.date).sort();
  if (!dates.length) return 1;
  return daysBetween(dates[0], dates[dates.length - 1]) || 1;
}

function rangeText() {
  if (!range.start && !range.end) return "全部账目";
  if (range.start === range.end) return dateLabel(range.start);
  const from = range.start ? dateLabel(range.start) : "最早";
  const to = range.end ? dateLabel(range.end) : "至今";
  const days = daysBetween(range.start, range.end);
  return days ? `${from} → ${to} · 共 ${days} 天` : `${from} → ${to}`;
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

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 分组标题里的星期；今天直接写「今天」，比星期更好认 */
function weekdayText(key) {
  const date = fromKey(key);
  if (!date) return "";
  if (key === dateKey(today())) return "今天";
  return WEEKDAYS[date.getDay()] ?? "";
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

/* ---------------- 环形图 ----------------
 * SVG 用 100×100 的 viewBox：半径 42、线宽 13，环带外沿 48.5 不会溢出。
 * 每段用 stroke-dasharray 画自己那一份周长，段与段之间留 GAP 个单位当缝隙。
 */
const DONUT_R = 42;
const DONUT_C = 2 * Math.PI * DONUT_R;
const DONUT_GAP = 1.8;

function renderDonut(cats) {
  const box = $("#billsDonut");
  if (!box) return;

  const track = `<circle class="bills-donut__track" cx="50" cy="50" r="${DONUT_R}" />`;
  const open = `<svg class="bills-donut__svg" viewBox="0 0 100 100" role="presentation">`;
  const close = "</svg>";

  if (!cats.length) {
    box.innerHTML = `${open}${track}${close}`;
    return;
  }

  let offset = 0;
  const arcs = cats
    .map((item) => {
      const span = (item.percent / 100) * DONUT_C;
      // 扣掉缝隙，但至少留一点长度，免得占比极小的分类整段消失
      const length = Math.max(span - DONUT_GAP, 0.8);
      // 明细按分类筛选时，把没被选中的弧段压暗，跟下面的筛选条呼应
      const dim = categoryFilter && categoryFilter !== item.category ? " is-dim" : "";
      const arc =
        `<circle class="bills-donut__arc${dim}" cx="50" cy="50" r="${DONUT_R}" ` +
        `stroke-dasharray="${length.toFixed(2)} ${(DONUT_C - length).toFixed(2)}" ` +
        `stroke-dashoffset="${(-offset).toFixed(2)}" ` +
        `style="stroke:${categoryColor(item.category)}" />`;
      offset += span;
      return arc;
    })
    .join("");

  // 从 12 点方向顺时针开始画
  box.innerHTML = `${open}${track}<g class="bills-donut__arcs" transform="rotate(-90 50 50)">${arcs}</g>${close}`;
}

/* ---------------- 关键指标 ---------------- */
function renderStats(records, total) {
  const box = $("#billsStats");
  if (!box) return;

  const max = records.reduce((peak, record) => Math.max(peak, record.amount), 0);
  const rows = [
    { label: "笔数", value: `${records.length} 笔` },
    { label: "日均", value: yuan(avgPerDay(total, records)) },
    { label: "最大单笔", value: yuan(max) },
  ];

  box.replaceChildren(
    ...rows.map((row) =>
      el("li", { class: "bills-stat" }, [
        el("span", { class: "bills-stat__label", text: row.label }),
        el("span", { class: "bills-stat__value t-numeric", text: row.value }),
      ]),
    ),
  );
}

/* ---------------- 各分类金额 ---------------- */
function renderCategories(cats) {
  const box = $("#billsCats");
  const countLabel = $("#billsCatCount");
  if (!box) return;

  if (countLabel) countLabel.textContent = cats.length ? `${cats.length} 个分类` : "";

  if (!cats.length) {
    box.replaceChildren(el("p", { class: "bills-empty", text: "这个区间还没有账目，换个日期试试" }));
    return;
  }

  box.replaceChildren(
    ...cats.map((item) => {
      const color = categoryColor(item.category);
      const active = categoryFilter === item.category;
      // 整个分类行也是一个筛选入口：点一下只看这个分类，再点一下回到全部
      const row = el(
        "button",
        {
          class: `bills-cat${active ? " is-active" : ""}`,
          type: "button",
          "aria-pressed": active ? "true" : "false",
          title: active ? "取消筛选，看全部" : `只看「${item.category}」`,
        },
        [
          el("span", {
            class: "bills-cat__dot",
            "aria-hidden": "true",
            style: `background:${color}`,
          }),
          el("span", { class: "bills-cat__name", text: item.category }),
          el("span", { class: "bills-cat__percent t-numeric", text: `${item.percent.toFixed(1)}%` }),
          el("span", { class: "bills-cat__amount t-numeric", text: yuan(item.amount) }),
        ],
      );
      row.addEventListener("click", () => {
        categoryFilter = active ? "" : item.category;
        renderBills();
      });
      return row;
    }),
  );
}

/* ---------------- 明细的分类筛选条 ----------------
 * 「全部」+ 区间内出现过的分类；点已选中的分类就退回全部。
 */
function renderFilter(cats, records) {
  const row = $("#billsFilter");
  if (!row) return;

  const countOf = (category) =>
    records.reduce((sum, record) => sum + (record.category === category ? 1 : 0), 0);

  const chips = [
    { key: "", label: "全部", count: records.length },
    ...cats.map((item) => ({ key: item.category, label: item.category, count: countOf(item.category) })),
  ];

  row.replaceChildren(
    ...chips.map((chip) => {
      const active = categoryFilter === chip.key;
      const node = el("button", {
        class: `chip${active ? " is-selected" : ""}`,
        type: "button",
        "aria-pressed": active ? "true" : "false",
        text: `${chip.label} ${chip.count}`,
      });
      node.addEventListener("click", () => {
        // 再点一次已选中的就取消筛选，回到「全部」
        categoryFilter = active ? "" : chip.key;
        renderBills();
      });
      return node;
    }),
  );
}

/* ---------------- 逐条明细（按日期分组） ---------------- */
function renderRecords(records, totalCount = records.length) {
  const list = $("#billsList");
  const countLabel = $("#billsListCount");
  if (!list) return;

  // 筛选中显示「筛出来的 / 区间总共」，不筛选时只显示总笔数
  if (countLabel) {
    countLabel.textContent = categoryFilter
      ? `${records.length} / ${totalCount} 笔`
      : totalCount
        ? `${totalCount} 笔`
        : "";
  }
  if (!records.length) {
    list.replaceChildren(
      el("p", {
        class: "bills-empty",
        text: categoryFilter ? `这个区间没有「${categoryFilter}」的账目` : "这个区间还没有账目",
      }),
    );
    return;
  }

  list.replaceChildren(
    ...groupRecordsByDate(records).map((group) =>
      el("section", { class: "bills-day" }, [
        el("header", { class: "bills-day__head" }, [
          // 日期 + 星期（今天直接写「今天」），右边是当天小计
          el("span", {
            class: "bills-day__date",
            text: `${dateLabel(group.date)} · ${weekdayText(group.date)}`,
          }),
          el("span", { class: "bills-day__total t-numeric", text: yuan(group.total) }),
        ]),
        el(
          "ul",
          { class: "bills-day__list" },
          group.records.map((record) => {
            const time = timeText(record);
            return el("li", { class: "bills-record" }, [
              el("span", {
                class: "bills-record__dot",
                "aria-hidden": "true",
                style: `background:${categoryColor(record.category)}`,
              }),
              el("span", { class: "bills-record__main" }, [
                el("span", { class: "bills-record__item", text: record.item }),
                // 分类 · 记账时间 —— 日期已经在分组标题上，行内不再重复
                el("span", {
                  class: "bills-record__meta",
                  text: `${record.category}${time ? ` · ${time}` : ""}`,
                }),
              ]),
              el("span", { class: "bills-record__amount t-numeric", text: yuan(record.amount) }),
            ]);
          }),
        ),
      ]),
    ),
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
