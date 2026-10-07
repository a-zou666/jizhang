/** 八、底部停靠区 · 输入条：AI 文本解析记账 + 快捷分类 */

import { hasBackend, parseAccounting } from "./bridge.js";
import { openConfirm } from "./confirm.js";
import { icon } from "./icons.js";
import { addRecords, categoryColor, getSettings } from "./store.js";
import { closeModal, haptic, openModal, toast } from "./ui.js";
import { $, dateKey, el, escapeHtml, round2 } from "./util.js";
import { view } from "./view.js";

export function bindComposer({ onNeedSettings } = {}) {
  const form = $("#composer");
  const input = $("#composerInput");
  const action = $("#composerAction");
  const plus = $("#composerPlus");

  let busy = false;
  let sendMode = false;

  /* ---------------- 输入激活态：占位按钮在输入态显示为「发送」 ---------------- */
  function setSendMode(on) {
    if (sendMode === on) return;
    sendMode = on;
    form.classList.toggle("is-active", on);
    action.classList.toggle("is-send", on);
    action.setAttribute("aria-label", on ? "发送" : "添加一笔");
    action.innerHTML = icon(on ? "send" : "plus", { size: 22 });
  }

  input.addEventListener("focus", () => setSendMode(true));
  input.addEventListener("input", () => setSendMode(Boolean(input.value.trim())));
  input.addEventListener("blur", () => {
    if (!input.value.trim()) setSendMode(false);
  });

  /* ---------------- 解析入账 ---------------- */
  async function submit(raw) {
    const text = String(raw ?? "").trim();
    if (!text || busy) return;
    if (hasBackend() && !getSettings().apiKey) {
      toast("请先在设置里配置 API Key", "error");
      onNeedSettings?.();
      return;
    }

    busy = true;
    action.disabled = true;
    const loading = toast("AI 正在解析…");
    try {
      const { records, skipped } = await parseAccounting(text, getSettings());
      if (!records.length) {
        toast(
          skipped ? `识别到 ${skipped} 条，但都缺少金额或日期` : "没能识别出账单，换个说法试试",
          "error",
        );
        return;
      }
      if (skipped) toast(`另有 ${skipped} 条缺少金额或日期，已跳过`, "warning");
      input.value = "";
      input.blur();
      setSendMode(false);
      openConfirm(records);
    } catch (error) {
      console.error(error);
      toast(`解析失败：${error?.message ?? error}`, "error");
    } finally {
      busy = false;
      action.disabled = false;
      loading?.remove?.();
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(input.value);
  });

  action.addEventListener("click", (event) => {
    event.preventDefault();
    if (!sendMode) {
      // 占位态：当作「+」的快捷入口，直接打开快捷记账面板
      openQuickAdd();
      return;
    }
    submit(input.value);
  });

  plus.addEventListener("click", (event) => {
    event.preventDefault();
    openQuickAdd();
  });

  /* ---------------- 快捷记账（手动添加一条） ---------------- */
  function openQuickAdd() {
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
    const html = `
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
      </div>`;
    openModal(html, {
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
        panel.querySelector("#qaAmount").addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        });
        panel.querySelector("#qaItem").focus();
      },
    });
  }

  // 初始化占位按钮图标（避免点击瞬间出现空白）
  setSendMode(false);
}
