/** 应用入口：装配状态、视图与事件 */

import { bindCalendarNav, bindCalendarSwipe } from "./calendar.js";
import { bindComposer } from "./composer.js";
import { bindConfirmSheet } from "./confirm.js";
import { closeOpenRows } from "./gesture.js";
import { openBudgetEditor, openMonthPicker, renderHome } from "./home.js";
import { hydrateIcons, navIcon } from "./icons.js";
import { bindSettings, renderSettings } from "./settings.js";
import { load, onStorageError, subscribe } from "./store.js";
import { toast } from "./ui.js";
import { $, $$ } from "./util.js";
import { goToday, shiftMonth, subscribeView, view } from "./view.js";

/* ---------------- 启动 ---------------- */
load();
onStorageError(reportStorageProblem);
hydrateIcons();
bindConfirmSheet();
bindSettings();
bindComposer({ onNeedSettings: () => switchTab("settings") });
bindCalendarSwipe();
bindCalendarNav();
bindChrome();

subscribe(() => renderAll());
subscribeView(() => renderAll());
renderAll();
switchTab(view.tab, { force: true });

/* ---------------- 渲染 ---------------- */
function renderAll() {
  renderHome();
  renderSettings();
}

/* ---------------- 存储故障提示 ----------------
 * 记账最怕「以为记上了，其实没存住」。写入失败、本地数据损坏、部分记录
 * 被跳过，都不能只写进 console —— 用户看不到 console。 */
function reportStorageProblem(problem) {
  if (!problem) return; // 恢复正常不打扰用户（写入成功时会回调一次 null）
  if (problem.kind === "write") {
    toast(
      "写入本机存储失败：新记录重启后会丢失。请先在设置里导出备份，并清理存储空间后重试",
      "error",
      7000,
    );
    return;
  }
  if (problem.kind === "dropped") {
    toast(`${problem.dropped} 条本地记录格式损坏已跳过，其余账目正常`, "warning", 6000);
    return;
  }
  const parts = ["本机保存的账目读不出来，当前显示为空"];
  if (problem.backedUp) parts.push("原始内容已另存备份");
  parts.push(problem.backedUp ? "可在设置里重新导入" : "请勿新增记录以免覆盖");
  toast(parts.join("；"), "error", 8000);
}

/* ---------------- 顶栏 / 底部导航 ---------------- */
function bindChrome() {
  $("#todayBtn").addEventListener("click", () => {
    goToday();
  });

  const title = $("#monthTitle");
  title.addEventListener("click", openMonthPicker);
  title.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openMonthPicker();
    }
  });

  // 当月预算就填在首页「本月支出」旁边：翻到哪个月，改的就是哪个月
  $("#monthBudgetBtn").addEventListener("click", openBudgetEditor);

  for (const item of $$(".tabbar__item")) {
    item.addEventListener("click", () => switchTab(item.dataset.tab));
  }
  renderTabIcons();

  // 点击空白处收起所有左滑删除
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".detail-row, .confirm-row")) closeOpenRows();
  });
}

function switchTab(tab, { force = false } = {}) {
  if (!force && view.tab === tab) return;
  view.tab = tab;
  for (const page of $$(".page")) {
    page.classList.toggle("is-active", page.dataset.page === tab);
  }
  // 当前页标记：供 CSS / 调试定位「现在在哪个界面」
  // （外观作用域不依赖它 —— 用的是各 .page 自己的 data-page，所以每个界面永远独立）
  document.getElementById("app")?.setAttribute("data-page", tab);
  renderTabIcons();
  closeOpenRows();
}

function renderTabIcons() {
  for (const node of $$(".tabbar__item")) {
    const tab = node.dataset.tab;
    const active = tab === view.tab;
    node.classList.toggle("is-active", active);
    const holder = node.querySelector("[data-tab-icon]");
    if (holder) holder.innerHTML = navIcon(tab, active);
  }
}
