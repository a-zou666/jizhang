/** 应用入口：装配状态、视图与事件 */

import { bindCalendarSwipe } from "./calendar.js";
import { bindComposer } from "./composer.js";
import { bindConfirmSheet } from "./confirm.js";
import { closeOpenRows } from "./gesture.js";
import { openMonthPicker, renderHome } from "./home.js";
import { hydrateIcons, navIcon } from "./icons.js";
import { bindSettings, renderSettings } from "./settings.js";
import { load, subscribe } from "./store.js";
import { $, $$ } from "./util.js";
import { goToday, subscribeView, view } from "./view.js";

/* ---------------- 启动 ---------------- */
load();
hydrateIcons();
bindConfirmSheet();
bindSettings();
bindComposer({ onNeedSettings: () => switchTab("settings") });
bindCalendarSwipe();
bindChrome();

subscribe(() => renderAll());
subscribeView(() => renderAll());
renderAll();

/* ---------------- 渲染 ---------------- */
function renderAll() {
  renderHome();
  renderSettings();
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

  for (const item of $$(".tabbar__item")) {
    item.addEventListener("click", () => switchTab(item.dataset.tab));
  }
  renderTabIcons();

  // 点击空白处收起所有左滑删除
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".detail-row, .confirm-row")) closeOpenRows();
  });
}

function switchTab(tab) {
  if (view.tab === tab) return;
  view.tab = tab;
  for (const page of $$(".page")) {
    page.classList.toggle("is-active", page.dataset.page === tab);
  }
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
