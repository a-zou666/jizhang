/** 七、首页 · 明细列表 */

import { openRecordEditor } from "./editor.js";
import { attachLongPress, attachSwipeReveal } from "./gesture.js";
import { categoryColor, recordsOf, removeRecord, updateRecord } from "./store.js";
import { haptic, toast } from "./ui.js";
import { $, dateKey, detailTitleFor, el, escapeHtml, formatMoney, yuan } from "./util.js";
import { view } from "./view.js";

/** 渲染选中日期的明细列表 */
export function renderDetail() {
  const key = dateKey(view.selected);
  const records = recordsOf(key);
  const total = records.reduce((sum, record) => sum + record.amount, 0);

  $("#detailTitle").textContent = detailTitleFor(view.selected);
  $("#detailCount").textContent = records.length ? `${records.length} 笔` : "";
  $("#detailTotal").textContent = yuan(total);

  const list = $("#detailList");
  if (!records.length) {
    list.replaceChildren(
      el("li", { class: "empty-state", text: "这一天还没有记账，在下面说一句试试" }),
    );
    return;
  }
  list.replaceChildren(...records.map(renderRow));
}

function renderRow(record) {
  const row = el("li", { class: "detail-row", dataset: { id: record.id } });

  const dot = el("span", { class: "calendar-cell__dot", "aria-hidden": "true" });
  dot.style.background = categoryColor(record.category);

  const main = el("div", { class: "detail-row__swipe" }, [
    el("span", { class: "detail-row__cat" }, [dot, el("span", { text: record.category })]),
    el("span", { class: "detail-row__item", text: record.item }),
    el("span", { class: "detail-row__amount t-numeric", text: yuan(record.amount) }),
  ]);

  const remove = el("button", {
    class: "detail-row__delete",
    type: "button",
    text: "删除",
    "aria-label": `删除 ${record.item} ¥${formatMoney(record.amount)}`,
  });
  remove.addEventListener("click", () => {
    haptic(12);
    row.classList.add("is-removing");
    window.setTimeout(() => {
      removeRecord(record.id);
      toast("已删除");
    }, 220);
  });

  row.append(main, remove);

  attachSwipeReveal(row, main);
  attachLongPress(main, () => {
    haptic(14);
    openRecordEditor(record, (patch) => {
      updateRecord(record.id, patch);
      haptic();
    });
  });

  return row;
}

/** 供确认入账动画使用：当前日历中某天的格子 */
export const cellFor = (key) =>
  document.querySelector(`#calendarGrid .calendar-cell[data-date="${escapeHtml(key)}"]`);
