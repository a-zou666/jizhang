/** 九、AI 解析确认页（半屏弹窗） */

import { openRecordEditor } from "./editor.js";
import { attachLongPress, attachSwipeReveal } from "./gesture.js";
import { addRecords, categoryColor } from "./store.js";
import { closeLayer, flyChip, haptic, openLayer, pulseCell, toast } from "./ui.js";
import { $, dateKey, el, formatMoney, fromKey, fullDateLabel, normalizeDateKey, parseAmount, yuan } from "./util.js";

let pending = [];
let afterCommit = null;

/* ---------------- 打开 / 关闭 ---------------- */
export function openConfirm(records, { onCommitted } = {}) {
  pending = records.map((raw, index) => normalize(raw, index));
  afterCommit = onCommitted ?? null;
  renderSheet();
  openLayer($("#confirmSheet"));
  $("#backdrop").classList.add("is-open");
  haptic();
}

function closeConfirm() {
  closeLayer($("#confirmSheet"));
  $("#backdrop").classList.remove("is-open");
  pending = [];
  afterCommit = null;
}

function normalize(raw, index) {
  // 日期认不出来才落到今天；金额认不出来按 0 处理（确认页里还能手改）
  const createdAt = Number(raw?.createdAt);
  return {
    id: String(raw?.id ?? `pending-${Date.now().toString(36)}-${index}`),
    date: normalizeDateKey(raw?.date) ?? dateKey(new Date()),
    item: String(raw?.item ?? "未命名"),
    category: String(raw?.category ?? "其他"),
    amount: parseAmount(raw?.amount) ?? 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now() + index,
  };
}

/* ---------------- 渲染 ---------------- */
function groupByDate(list) {
  const grouped = new Map();
  for (const record of list) {
    if (!grouped.has(record.date)) grouped.set(record.date, []);
    grouped.get(record.date).push(record);
  }
  return [...grouped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function renderSheet() {
  const body = $("#sheetBody");
  const total = pending.reduce((sum, record) => sum + record.amount, 0);

  $("#sheetCount").textContent = String(pending.length);
  $("#sheetTotal").textContent = yuan(total);
  $("#confirmBtn").disabled = pending.length === 0;

  body.replaceChildren(
    ...groupByDate(pending).map(([date, records]) => {
      const label = fromKey(date);
      return el("div", { class: "confirm-group" }, [
        el("p", { class: "confirm-group__date t-caption", text: label ? fullDateLabel(label) : date }),
        el("div", { class: "confirm-group__rows" }, records.map(renderRow)),
      ]);
    }),
  );
}

function renderRow(record) {
  const row = el("div", { class: "confirm-row", dataset: { id: record.id } });

  const dot = el("span", { class: "calendar-cell__dot", "aria-hidden": "true" });
  dot.style.background = categoryColor(record.category);

  const main = el("div", { class: "confirm-row__main" }, [
    el("span", { class: "confirm-row__cat" }, [dot, el("span", { text: record.category })]),
    el("span", { class: "confirm-row__item", text: record.item }),
    el("span", { class: "confirm-row__amount t-numeric", text: yuan(record.amount) }),
  ]);

  const remove = el("button", {
    class: "confirm-row__delete",
    type: "button",
    text: "删除",
    "aria-label": `删除 ${record.item} ¥${formatMoney(record.amount)}`,
  });
  remove.addEventListener("click", () => {
    haptic(12);
    pending = pending.filter((item) => item.id !== record.id);
    row.classList.add("is-removing");
    window.setTimeout(() => {
      renderSheet();
      if (!pending.length) closeConfirm();
    }, 220);
  });

  row.append(main, el("div", { class: "confirm-row__actions" }, [remove]));

  const swipe = attachSwipeReveal(row, main);

  const edit = () => {
    haptic(14);
    openRecordEditor(record, (patch) => {
      Object.assign(record, patch);
      renderSheet();
    });
  };
  attachLongPress(main, edit);
  // 轻点只负责收起左滑，编辑走长按（避免滑动结束时误触编辑器）
  main.addEventListener("click", (event) => {
    if (event.target.closest(".confirm-row__delete")) return;
    if (swipe.isOpen()) swipe.close();
  });

  return row;
}

/* ---------------- 确认入账（飞入日历） ---------------- */
const centerOf = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
const selectorValue = (value) => CSS.escape(String(value));

function cellOf(date) {
  return document.querySelector(
    `#calendarGrid .calendar-cell[data-date="${selectorValue(date)}"]`,
  );
}

function commit() {
  const list = pending.slice();
  if (!list.length) return;

  const flights = [];
  for (const record of list) {
    const row = document.querySelector(`.confirm-row[data-id="${selectorValue(record.id)}"]`);
    const cell = cellOf(record.date);
    if (!row || !cell) continue;
    flights.push({
      record,
      from: centerOf(row.getBoundingClientRect()),
      to: centerOf(cell.getBoundingClientRect()),
    });
  }

  haptic([10, 30, 10]);
  const notify = afterCommit;
  const saved = addRecords(list);
  closeConfirm();
  notify?.();

  flights.forEach(({ record, from, to }, index) => {
    window.setTimeout(() => flyChip({ label: yuan(record.amount), from, to }), index * 45);
  });

  const landing = flights.length ? (flights.length - 1) * 45 + 360 : 0;
  window.setTimeout(() => {
    for (const record of list) {
      const cell = cellOf(record.date);
      if (cell) pulseCell(cell);
    }
  }, landing + 40);

  // toast 用真正落库的条数，别在有条目被校验拦下时还报「已入账 N 笔」
  const missing = list.length - saved.length;
  toast(
    missing ? `已入账 ${saved.length} 笔，${missing} 条缺少金额或日期` : `已入账 ${list.length} 笔`,
    missing ? "warning" : "ok",
  );
}

/* ---------------- 一次性事件绑定 ---------------- */
export function bindConfirmSheet() {
  $("#sheetClose").addEventListener("click", closeConfirm);
  $("#confirmBtn").addEventListener("click", commit);
  $("#backdrop").addEventListener("click", closeConfirm);
}
