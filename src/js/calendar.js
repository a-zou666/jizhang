/** 七、首页 · 日历网格 */

import { attachHorizontalSwipe } from "./gesture.js";
import { dailyTotals, getSettings, recordsOf } from "./store.js";
import { haptic } from "./ui.js";
import {
  $,
  WEEKDAY_LABELS,
  dateKey,
  el,
  formatMoney,
  isSameDay,
  monthMatrix,
  monthTitle,
  today,
  weekdayOrder,
} from "./util.js";
import { selectDate, shiftMonth, view } from "./view.js";

/** 由 bindCalendarSwipe 注入：判断本次点击是否应由滑动吞掉 */
let consumeSwipeClick = () => false;

/** 渲染周表头 + 日历格子 */
export function renderCalendar() {
  const { weekStart } = getSettings();

  $("#monthTitle").textContent = monthTitle(view.month);

  const weekdayRow = $("#weekdayRow");
  weekdayRow.replaceChildren(
    ...weekdayOrder(weekStart).map((weekday) => el("span", { text: WEEKDAY_LABELS[weekday] })),
  );

  const todayDate = today();
  const totals = dailyTotals(view.month);
  const grid = $("#calendarGrid");

  grid.replaceChildren(
    ...monthMatrix(view.month.getFullYear(), view.month.getMonth(), weekStart).map((date) => {
      if (!date) {
        return el("div", { class: "calendar-cell is-blank", "aria-hidden": "true" });
      }

      const key = dateKey(date);
      const total = totals.get(key) ?? 0;
      const classes = ["calendar-cell"];
      const isToday = isSameDay(date, todayDate);
      if (isToday) classes.push("is-today");
      if (date > todayDate) classes.push("is-future");
      if (isSameDay(date, view.selected)) classes.push("is-selected");
      if (total > 0) classes.push("has-records");

      const amountText = formatMoney(total);
      const children = [
        el("span", { class: "calendar-cell__day", text: String(date.getDate()) }),
        el("span", {
          class: "calendar-cell__amount t-numeric" + (total > 0 ? " is-nonzero" : ""),
          text: amountText,
        }),
      ];

      const label = [`${date.getMonth() + 1}月${date.getDate()}日`];
      if (isToday) label.push("今天");
      label.push(total > 0 ? `支出 ${amountText} 元` : "无支出");

      return el(
        "button",
        {
          class: classes.join(" "),
          type: "button",
          dataset: { date: key },
          "aria-label": label.join("，"),
          "aria-pressed": isSameDay(date, view.selected) ? "true" : "false",
          onclick: () => {
            if (consumeSwipeClick()) return;
            haptic();
            selectDate(date);
          },
        },
        children,
      );
    }),
  );
}

/** 绑定日历横向滑动翻月 */
export function bindCalendarSwipe() {
  consumeSwipeClick = attachHorizontalSwipe($("#calendarCard"), {
    onShift: (delta) => {
      haptic();
      shiftMonth(delta);
    },
  });
}

/** 绑定日历头部上/下月导航按钮 */
export function bindCalendarNav() {
  const prev = $("#calPrev");
  const next = $("#calNext");
  if (prev) {
    prev.addEventListener("click", () => {
      haptic();
      shiftMonth(-1);
    });
  }
  if (next) {
    next.addEventListener("click", () => {
      haptic();
      shiftMonth(1);
    });
  }
}
