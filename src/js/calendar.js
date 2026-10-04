/** 七、首页 · 日历网格 */

import { attachHorizontalSwipe } from "./gesture.js";
import { categoriesOf, categoryColor, dailyTotals, getSettings } from "./store.js";
import { haptic } from "./ui.js";
import {
  $,
  WEEKDAY_LABELS,
  dateKey,
  el,
  formatCellAmount,
  isSameDay,
  monthMatrix,
  monthTitle,
  today,
  weekdayOrder,
  yuan,
} from "./util.js";
import { selectDate, shiftMonth, view } from "./view.js";

const MAX_DOTS = 3;

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

      const children = [
        el("span", { class: "calendar-cell__day", text: String(date.getDate()) }),
      ];

      if (total > 0) {
        const text = formatCellAmount(total);
        const amountClass = ["calendar-cell__amount"];
        if (text.length >= 5) amountClass.push("is-tiny");
        else if (text.length >= 4) amountClass.push("is-compact");
        children.push(el("span", { class: amountClass.join(" "), text }), dotsFor(key));
      } else {
        children.push(el("span", { class: "calendar-cell__dots", "aria-hidden": "true" }));
      }

      const label = [`${date.getMonth() + 1}月${date.getDate()}日`];
      if (isToday) label.push("今天");
      label.push(total > 0 ? `支出 ${yuan(total)}` : "无支出");

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

/** 分类色点：最多 3 个，超出显示 +N */
function dotsFor(key) {
  const categories = categoriesOf(key);
  const wrap = el("span", { class: "calendar-cell__dots", "aria-hidden": "true" });
  for (const name of categories.slice(0, MAX_DOTS)) {
    const dot = el("span", { class: "calendar-cell__dot" });
    dot.style.background = categoryColor(name);
    wrap.append(dot);
  }
  if (categories.length > MAX_DOTS) {
    wrap.append(
      el("span", { class: "calendar-cell__more", text: `+${categories.length - MAX_DOTS}` }),
    );
  }
  return wrap;
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
