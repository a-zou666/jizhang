/** 单条记录编辑弹窗（确认页与明细列表共用） */

import { categoryColor, getSettings } from "./store.js";
import { closeModal, confirmDialog, openModal, toast } from "./ui.js";
import { escapeHtml, formatMoney, fromKey, round2 } from "./util.js";

/**
 * @param {{ item: string, amount: number, date: string, category: string }} record
 * @param {(patch: {item: string, amount: number, date: string, category: string}) => void} onSave
 * @param {{ onDelete?: () => void, deleteLabel?: string }} [options] 传了 onDelete 才显示删除按钮
 */
export function openRecordEditor(record, onSave, options = {}) {
  const { categories } = getSettings();
  const current = categories.includes(record.category) ? record.category : categories[0];
  const onDelete = typeof options.onDelete === "function" ? options.onDelete : null;

  const chips = categories
    .map(
      (name) => `
      <button class="chip${name === current ? " is-selected" : ""}" data-cat="${escapeHtml(name)}" type="button">
        <span class="calendar-cell__dot" style="background:${categoryColor(name)}"></span>${escapeHtml(name)}
      </button>`,
    )
    .join("");

  openModal(
    `<p class="modal-title">编辑记录</p>
     <div class="field-stack">
       <label class="field-label" for="edItem">物品</label>
       <input class="settings-input" id="edItem" type="text" value="${escapeHtml(record.item)}" placeholder="买了什么" />

       <label class="field-label" for="edAmount">金额</label>
       <input class="settings-input" id="edAmount" type="number" inputmode="decimal" step="0.01" min="0"
              value="${escapeHtml(String(record.amount))}" placeholder="0.00" />

       <label class="field-label" for="edDate">日期</label>
       <input class="settings-input" id="edDate" type="date" value="${escapeHtml(record.date)}" />

       <label class="field-label">分类</label>
       <div class="chip-row" id="edCats">${chips}</div>
     </div>
     <div class="modal-actions">
       ${onDelete ? '<button class="ghost-btn ghost-btn--danger" id="edDelete" type="button">删除</button>' : ""}
       <button class="ghost-btn" id="edCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="edSave" type="button">保存</button>
     </div>`,
    {
      onMount: (panel) => {
        let selected = current;
        panel.querySelectorAll("#edCats .chip").forEach((chip) => {
          chip.addEventListener("click", () => {
            selected = chip.dataset.cat;
            panel
              .querySelectorAll("#edCats .chip")
              .forEach((node) => node.classList.toggle("is-selected", node === chip));
          });
        });

        panel.querySelector("#edCancel").addEventListener("click", closeModal);

        if (onDelete) {
          panel.querySelector("#edDelete").addEventListener("click", () => {
            const label = `${record.item || "这条记录"} ¥${formatMoney(record.amount)}`;
            closeModal();
            confirmDialog({
              title: options.deleteLabel ?? "删除这条记录？",
              message: label,
              confirmLabel: "删除",
              danger: true,
              onConfirm: () => {
                onDelete();
                toast("已删除");
              },
            });
          });
        }

        panel.querySelector("#edSave").addEventListener("click", () => {
          const item = panel.querySelector("#edItem").value.trim();
          const amount = round2(Math.abs(Number(panel.querySelector("#edAmount").value)));
          const date = panel.querySelector("#edDate").value;
          if (!item) return toast("请填写物品名称", "error");
          if (!Number.isFinite(amount) || amount <= 0) return toast("请填写有效金额", "error");
          if (!fromKey(date)) return toast("请选择有效日期", "error");
          closeModal();
          onSave({ item, amount, date, category: selected });
        });
      },
    },
  );
}
