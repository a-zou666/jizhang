/** 快捷记账：手动添加一条（首页悬浮按钮 / 对话页都能调） */

import { addRecords, categoryColor, getSettings } from "./store.js";
import { closeModal, haptic, openModal, toast } from "./ui.js";
import { escapeHtml, round2 } from "./util.js";
import { dateKey } from "./util.js";
import { view } from "./view.js";

export function openQuickAdd() {
  const cats = getSettings().categories ?? [];
  const initialCategory = cats[0] ?? "其他";
  let category = initialCategory;
  const chipsHtml = cats
    .map(
      (cat) => `
      <button class="chip${cat === initialCategory ? " is-selected" : ""}" data-cat="${escapeHtml(cat)}" type="button">
        <span class="calendar-cell__dot" style="background:${escapeHtml(categoryColor(cat))}"></span>${escapeHtml(cat)}
      </button>`,
    )
    .join("");

  openModal(
    `
    <p class="modal-title">记一笔</p>
    <div class="field-stack">
      <label class="field-label" for="qaItem">物品</label>
      <input class="settings-input" id="qaItem" type="text" placeholder="例如：午餐" />
      <label class="field-label" for="qaAmount">金额</label>
      <input class="settings-input" id="qaAmount" type="number" inputmode="decimal" step="0.01" placeholder="0.00" />
      <label class="field-label">分类</label>
      <div class="chip-row" id="qaCats">${chipsHtml}</div>
    </div>
    <div class="modal-actions">
      <button class="ghost-btn" id="qaCancel" type="button">取消</button>
      <button class="primary-btn primary-btn--compact" id="qaSave" type="button">保存</button>
    </div>`,
    {
      onMount: (panel) => {
        panel.querySelectorAll("#qaCats .chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            category = chip.dataset.cat;
            panel
              .querySelectorAll("#qaCats .chip")
              .forEach((node) => node.classList.toggle("is-selected", node === chip));
          });
        });
        panel.querySelector("#qaCancel").addEventListener("click", closeModal);
        const commit = () => {
          const item = panel.querySelector("#qaItem").value.trim();
          const amount = round2(Math.abs(Number(panel.querySelector("#qaAmount").value)));
          if (!item) return toast("请填写物品名称", "error");
          if (!Number.isFinite(amount) || amount <= 0) return toast("请填写有效金额", "error");
          closeModal();
          addRecords([{ date: dateKey(view.selected), item, category, amount }]);
          haptic(8);
          toast("已记一笔", "ok");
        };
        panel.querySelector("#qaSave").addEventListener("click", commit);
        panel.querySelector("#qaAmount").addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        });
        panel.querySelector("#qaItem").focus();
      },
    },
  );
}
