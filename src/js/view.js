/** 视图状态：当前 Tab / 可见月份 / 选中日期 */

import { addMonths, isSameDay, startOfDay, startOfMonth, today } from "./util.js";

export const view = {
  tab: "home",
  month: startOfMonth(today()),
  selected: startOfDay(today()),
  /** 用户是否手动选过日期（决定「今天」按钮的高亮） */
  pinned: false,
};

const listeners = new Set();

export function subscribeView(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(reason) {
  for (const listener of [...listeners]) listener(reason);
}

export const isCurrentMonth = (date) =>
  date.getFullYear() === view.month.getFullYear() && date.getMonth() === view.month.getMonth();

/** 选中某天（自动切换到该天所在月份） */
export function selectDate(date, { silent = false } = {}) {
  view.selected = startOfDay(date);
  view.pinned = true;
  if (!isCurrentMonth(view.selected)) view.month = startOfMonth(view.selected);
  if (!silent) emit("date");
}

/** 翻月（不改变已选日期） */
export function shiftMonth(delta, { silent = false } = {}) {
  view.month = addMonths(view.month, delta);
  if (!silent) emit("month");
}

export function goToMonth(date, { silent = false } = {}) {
  view.month = startOfMonth(date);
  if (!silent) emit("month");
}

/** 回到今天：月份 + 选中日期一起复位 */
export function goToday({ silent = false } = {}) {
  view.month = startOfMonth(today());
  view.selected = today();
  view.pinned = true;
  if (!silent) emit("today");
}

export const isSelected = (date) => isSameDay(date, view.selected);
