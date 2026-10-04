/** 七、首页：顶部进度 + 日历 + 明细 */

import { bindCalendarSwipe, renderCalendar } from "./calendar.js";
import { renderDetail } from "./detail.js";
import { getSettings, monthTotal } from "./store.js";
import { closeModal, haptic, openModal } from "./ui.js";
import { $, clamp, yuan } from "./util.js";
import { goToMonth, view } from "./view.js";

/** 首页整体渲染 */
export function renderHome() {
  renderGreet();
  renderProgress();
  renderCalendar();
  renderDetail();
}

/* ---------------- 顶部问候 ---------------- */
function renderGreet() {
  const greet = $("#homeGreet");
  if (!greet) return;
  const hour = new Date().getHours();
  const part =
    hour < 5 ? "深夜啦，记得早点休息" :
    hour < 9 ? "早上好，今天也要省一点" :
    hour < 12 ? "上午好" :
    hour < 14 ? "中午好，吃了什么好吃的？" :
    hour < 18 ? "下午好" :
    hour < 22 ? "晚上好，今天的支出怎么样？" :
    "夜深了，别忘了明天的预算";
  greet.textContent = part;
}

/* ---------------- 月进度 ---------------- */
function renderProgress() {
  const budget = Math.max(0, Number(getSettings().budget) || 0);
  const spent = monthTotal(view.month);
  const ratio = budget > 0 ? spent / budget : 0;
  const percent = clamp(ratio * 100, 0, 100);

  $("#monthSpent").textContent = yuan(spent);
  $("#monthBudget").textContent = budget > 0 ? `/ ${yuan(budget)}` : "/ 未设置预算";
  $("#progressFill").style.width = `${percent}%`;

  const track = $("#progressTrack");
  track.setAttribute("aria-valuenow", String(Math.round(percent)));
  track.setAttribute("aria-valuetext", `已用 ${yuan(spent)}，预算 ${yuan(budget)}`);

  const over = budget > 0 && spent > budget;
  const wrap = $("#monthProgress");
  wrap.classList.toggle("is-over", over);

  const ratioLabel = $("#monthRatio");
  const hint = $("#monthHint");
  if (over) {
    ratioLabel.textContent = `超支 ${(ratio * 100 - 100).toFixed(1)}%`;
    hint.textContent = `已经花了 ${yuan(spent - budget)}，下个月可以再挤一挤`;
  } else if (budget <= 0) {
    ratioLabel.textContent = "未设预算";
    hint.textContent = "设定一个预算，跟踪每月支出";
  } else if (ratio >= 0.9) {
    ratioLabel.textContent = `${(ratio * 100).toFixed(1)}%`;
    hint.textContent = `仅剩 ${yuan(budget - spent)}，本月快用完了`;
  } else if (ratio >= 0.5) {
    ratioLabel.textContent = `${(ratio * 100).toFixed(1)}%`;
    hint.textContent = `已过半，还剩 ${yuan(budget - spent)}`;
  } else {
    ratioLabel.textContent = `${(ratio * 100).toFixed(1)}%`;
    hint.textContent = `还剩 ${yuan(budget - spent)}，继续保持`;
  }
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
