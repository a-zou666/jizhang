/** 七、首页：顶部进度 + 日历 + 明细 */

import { bindCalendarSwipe, renderCalendar } from "./calendar.js";
import { renderDetail } from "./detail.js";
import { getSettings, monthTotal } from "./store.js";
import { closeModal, haptic, openModal } from "./ui.js";
import { $, clamp, yuan } from "./util.js";
import { goToMonth, view } from "./view.js";

/** 首页整体渲染 */
export function renderHome() {
  renderProgress();
  renderCalendar();
  renderDetail();
}

/* ---------------- 月进度 ---------------- */
function renderProgress() {
  const budget = Math.max(0, Number(getSettings().budget) || 0);
  const spent = monthTotal(view.month);
  const ratio = budget > 0 ? spent / budget : 0;
  const percent = clamp(ratio * 100, 0, 100);

  $("#monthSpent").textContent = yuan(spent);
  $("#monthBudget").textContent = budget > 0 ? `/ ${yuan(budget)}` : "/ 未设置预算";
  $("#monthRatio").textContent = `${(ratio * 100).toFixed(1)}%`;
  $("#progressFill").style.width = `${percent}%`;

  const track = $("#progressTrack");
  track.setAttribute("aria-valuenow", String(Math.round(percent)));
  track.setAttribute("aria-valuetext", `已用 ${yuan(spent)}，预算 ${yuan(budget)}`);

  const over = budget > 0 && spent > budget;
  $("#monthProgress").classList.toggle("is-over", over);
  if (over) $("#monthRatio").textContent = `超支 ${(ratio * 100 - 100).toFixed(1)}%`;
}

/* ---------------- 十二、月份选择弹窗 ---------------- */
export function openMonthPicker() {
  let year = view.month.getFullYear();
  const selectedMonth = view.month.getMonth();

  const monthChips = Array.from(
    { length: 12 },
    (_, index) =>
      `<button class="chip${index === selectedMonth ? " is-selected" : ""}" data-month="${index}" type="button">${index + 1}月</button>`,
  ).join("");

  openModal(
    `<p class="modal-title">选择月份</p>
     <div class="month-picker__head">
       <button class="ghost-btn month-picker__nav" id="mpPrev" type="button" aria-label="上一年">‹</button>
       <span class="t-title3" id="mpYear">${year}年</span>
       <button class="ghost-btn month-picker__nav" id="mpNext" type="button" aria-label="下一年">›</button>
     </div>
     <div class="month-grid" id="mpMonths">${monthChips}</div>`,
    {
      onMount: (panel) => {
        const yearLabel = panel.querySelector("#mpYear");
        const months = [...panel.querySelectorAll("#mpMonths .chip")];

        panel.querySelector("#mpPrev").addEventListener("click", () => {
          year -= 1;
          yearLabel.textContent = `${year}年`;
        });
        panel.querySelector("#mpNext").addEventListener("click", () => {
          year += 1;
          yearLabel.textContent = `${year}年`;
        });

        for (const chip of months) {
          chip.addEventListener("click", () => {
            haptic();
            closeModal();
            goToMonth(new Date(year, Number(chip.dataset.month), 1));
          });
        }
      },
    },
  );
}
