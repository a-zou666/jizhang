/** 七、首页：顶部进度 + 日历 + 明细 */

import { bindCalendarSwipe, renderCalendar } from "./calendar.js";
import { renderDetail } from "./detail.js";
import {
  getMonthBudget,
  getSettings,
  hasOwnMonthBudget,
  monthRecords,
  monthTotal,
  recordsOf,
  resetMonthBudget,
  setMonthBudget,
  todayKey,
} from "./store.js";
import { closeModal, haptic, openModal, toast } from "./ui.js";
import { $, clamp, el, yuan } from "./util.js";
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

  // 顺带报一句今天的情况：顶部一眼就能看到今天记了多少
  // 问候语本身可能已经包含「今天」，所以小结直接用「已记 N 笔 / 还没有记账」的写法
  const records = recordsOf(todayKey());
  const todayTotal = records.reduce((sum, record) => sum + record.amount, 0);
  const detail = records.length
    ? `已记 ${records.length} 笔 · ${yuan(todayTotal)}`
    : "还没有记账";
  greet.replaceChildren(
    el("span", { text: part }),
    el("span", { class: "home-header__greet-detail", text: detail }),
  );
}

/* ---------------- 月进度 ---------------- */
function renderProgress() {
  // 预算按「当前查看的月份」取：这个月单独设过就用它的，否则用默认月预算
  const budget = getMonthBudget(view.month);
  const spent = monthTotal(view.month);
  const ratio = budget > 0 ? spent / budget : 0;
  const percent = clamp(ratio * 100, 0, 100);

  $("#monthSpent").textContent = yuan(spent);
  $("#monthBudget").textContent = budget > 0 ? `/ ${yuan(budget)}` : "/ 未设置预算";
  $("#monthBudgetCta").textContent = hasOwnMonthBudget(view.month) ? "本月已改" : "改";
  $("#progressFill").style.width = `${percent}%`;

  // 日历面板的抬头：本月支出合计 + 笔数
  const count = monthRecords(view.month).length;
  $("#calendarSpent").textContent = yuan(spent);
  $("#calendarCount").textContent = count ? `· ${count} 笔` : "";

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
    hint.textContent = "点旁边的预算，给这个月定个数";
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

/* ---------------- 当月预算：就填在首页的「本月支出」旁边 ---------------- */
export function openBudgetEditor() {
  const date = view.month;
  const fallback = Math.max(0, Number(getSettings().budget) || 0);
  const current = getMonthBudget(date);
  const own = hasOwnMonthBudget(date);

  openModal(
    `<p class="modal-title">${date.getFullYear()}年${date.getMonth() + 1}月预算</p>
     <p class="t-footnote mm-hint">只改这一个月；其他月份沿用默认 ${yuan(fallback)}</p>
     <div class="field-stack">
       <input class="settings-input" id="budgetInput" type="text" inputmode="decimal"
              placeholder="${fallback || "5000"}" value="${current || ""}" />
     </div>
     <div class="modal-actions">
       ${own ? '<button class="ghost-btn" id="budgetReset" type="button">恢复默认</button>' : ""}
       <button class="ghost-btn" id="budgetCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="budgetSave" type="button">保存</button>
     </div>`,
    {
      onMount: (panel) => {
        const input = panel.querySelector("#budgetInput");
        input.focus();
        input.select?.();

        const submit = () => {
          const value = Number(String(input.value).replace(/[^\d.]/g, ""));
          if (!Number.isFinite(value) || value <= 0) return toast("请输入有效金额", "error");
          setMonthBudget(date, value);
          closeModal();
          toast(`${date.getMonth() + 1}月预算已设为 ${yuan(value)}`, "ok");
        };

        panel.querySelector("#budgetSave").addEventListener("click", submit);
        panel.querySelector("#budgetCancel").addEventListener("click", closeModal);
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") submit();
        });
        panel.querySelector("#budgetReset")?.addEventListener("click", () => {
          resetMonthBudget(date);
          closeModal();
          toast(`${date.getMonth() + 1}月已恢复默认预算`, "ok");
        });
      },
    },
  );
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
