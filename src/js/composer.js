/** 八、底部停靠区 · 输入条：AI 文本解析记账 + 快捷分类 */

import { hasBackend, parseIntent } from "./bridge.js";
import { openConfirm } from "./confirm.js";
import { icon } from "./icons.js";
import { addRecords, categoryColor, getRecords, getSettings, removeRecord } from "./store.js";
import { closeModal, haptic, openModal, toast } from "./ui.js";
import { $, dateKey, escapeHtml, round2, yuan } from "./util.js";
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

  /* ---------------- 意图识别：新增 / 删除 / 查询 ---------------- */

  /** 紧凑账目快照：每行 `序号|日期|物品|分类|金额`，最新在前，至多 100 行（省 token） */
  function buildLedger() {
    const records = [...getRecords()]
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.createdAt ?? 0) - (a.createdAt ?? 0)))
      .slice(0, 100);
    const lines = [];
    const byLineId = new Map();
    records.forEach((record, index) => {
      const lineId = index + 1;
      byLineId.set(lineId, record);
      lines.push(
        `${lineId}|${record.date.slice(5).replace("-", "/")}|${record.item}|${record.category}|${record.amount}`,
      );
    });
    return { lines: lines.join("\n"), byLineId };
  }

  /** 账目行序号 → 真实记录 */
  const resolveIds = (ids, byLineId) =>
    [...new Set(ids)].map((id) => byLineId.get(id)).filter(Boolean);

  /** 账目行 HTML（复用确认页的 .confirm-row 结构） */
  const recordRowHtml = (record) => `
    <div class="confirm-row">
      <div class="confirm-row__main">
        <span class="confirm-row__cat">
          <span class="calendar-cell__dot" style="background:${escapeHtml(categoryColor(record.category))}"></span>
          <span>${escapeHtml(record.category)}</span>
        </span>
        <span class="confirm-row__item">${escapeHtml(record.item)}</span>
        <span class="confirm-row__amount t-numeric">${escapeHtml(yuan(record.amount))}</span>
      </div>
    </div>`;

  /** 删除确认弹窗 */
  function openDeleteConfirm(records) {
    openModal(
      `
      <p class="modal-title">删除 ${records.length} 笔账目？</p>
      <div class="intent-list">
        ${records.map((record) => `${recordRowHtml(record)}<p class="intent-row-date t-caption">${escapeHtml(record.date)}</p>`).join("")}
      </div>
      <div class="modal-actions">
        <button class="ghost-btn" id="delCancel" type="button">取消</button>
        <button class="primary-btn primary-btn--compact" id="delConfirm" type="button">删除</button>
      </div>`,
      {
        onMount: (panel) => {
          panel.querySelector("#delCancel").addEventListener("click", closeModal);
          panel.querySelector("#delConfirm").addEventListener("click", () => {
            closeModal();
            for (const record of records) removeRecord(record.id);
            haptic(12);
            toast(`已删除 ${records.length} 笔账目`, "ok");
          });
        },
      },
    );
  }

  /** 查询结果弹窗：明细 + 本地计算的合计 */
  function openQueryResult(records, reply) {
    const total = round2(records.reduce((sum, record) => sum + record.amount, 0));
    const shown = records.slice(0, 30);
    const more =
      records.length > 30 ? `<p class="t-footnote">…还有 ${records.length - 30} 笔</p>` : "";
    openModal(
      `
      <p class="modal-title">查询结果</p>
      ${reply ? `<p class="t-footnote intent-reply">${escapeHtml(reply)}</p>` : ""}
      <div class="intent-list">${shown.map(recordRowHtml).join("")}${more}</div>
      <p class="query-total">共 ${records.length} 笔 · 合计 <b class="t-numeric">${escapeHtml(yuan(total))}</b></p>
      <div class="modal-actions">
        <button class="primary-btn primary-btn--compact" id="qDone" type="button">好的</button>
      </div>`,
      {
        onMount: (panel) => {
          panel.querySelector("#qDone").addEventListener("click", closeModal);
        },
      },
    );
  }

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
      const { lines, byLineId } = buildLedger();
      const { op, items, ids, reply } = await parseIntent(text, getSettings(), lines);

      if (op === "add") {
        if (!items.length) {
          toast("没能识别出账单，换个说法试试", "error");
          return;
        }
        input.value = "";
        input.blur();
        setSendMode(false);
        openConfirm(items);
      } else if (op === "del") {
        const records = resolveIds(ids, byLineId);
        if (!records.length) {
          toast(reply || "没找到要删除的账目", "warning");
          return;
        }
        input.value = "";
        input.blur();
        setSendMode(false);
        openDeleteConfirm(records);
      } else if (op === "query") {
        const records = resolveIds(ids, byLineId);
        if (!records.length) {
          toast(reply || "没有匹配的账目", "warning");
          return;
        }
        input.value = "";
        input.blur();
        setSendMode(false);
        openQueryResult(records, reply);
      } else {
        toast(reply || "这句话和记账无关，试试「昨天买鼠标 120」", "info");
      }
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
