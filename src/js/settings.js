/** 十、设置页 */

import { testConnection } from "./bridge.js";
import { hydrateIcons } from "./icons.js";
import { openModelManager } from "./models.js";
import {
  addCategory,
  categoryColor,
  clearRecords,
  exportPayload,
  getActiveProvider,
  getProviders,
  getRecords,
  getSettings,
  removeCategory,
  setSettings,
} from "./store.js";
import { closeModal, confirmDialog, openModal, pickOption, promptText, toast } from "./ui.js";
import { $, dateKey, el, round2, yuan } from "./util.js";

/* ---------------- 渲染 ---------------- */
export function renderSettings() {
  const settings = getSettings();
  const active = getActiveProvider();

  // 连接区只有「模型管理」一个入口：服务商、Key、模型全在里面维护，
  // 这里只显示当前用的是谁，不再重复摆一套协议 / 地址 / Key / 模型
  $("#modelManagerValue").textContent = active
    ? `${active.name} · ${settings.model || "未选模型"}`
    : getProviders().length
      ? `${getProviders().length} 个服务商（未启用）`
      : "未添加";

  $("#weekStartValue").textContent = settings.weekStart === 0 ? "周日" : "周一";
  $("#budgetValue").textContent = yuan(settings.budget);
  $("#categoryValue").textContent = `${settings.categories.length} 个分类`;
}

/* ---------------- 事件绑定 ---------------- */
export function bindSettings() {
  /* 模型管理 */
  $("#rowModels").addEventListener("click", () => {
    openModelManager(() => renderSettings());
  });

  /* 测试连接：测的是当前启用的服务商 */
  $("#testBtn").addEventListener("click", async () => {
    const current = getSettings();
    const label = $("#testBtnLabel");
    const value = $("#testValue");
    const box = $("#testResult");

    if (!current.apiKey) {
      toast("先在「模型管理」里把服务商配好", "error");
      return;
    }

    label.textContent = "测试中…";
    value.textContent = "";
    box.className = "test-result";
    box.textContent = "";

    const result = await testConnection(current);
    label.textContent = "测试连接";

    if (result.ok) {
      value.textContent = `✓ ${result.model || current.model || "连接正常"}`;
      box.textContent = result.message || `连接成功，模型：${result.model || current.model || "未知"}`;
      box.className = "test-result is-visible is-ok";
      toast("连接成功", "ok");
    } else {
      box.textContent = result.message || "连接失败";
      box.className = "test-result is-visible is-error";
      toast("连接失败", "error");
    }
  });

  /* 周起始日 */
  $("#rowWeekStart").addEventListener("click", () => {
    const current = getSettings();
    pickOption({
      title: "周起始日",
      value: String(current.weekStart),
      options: [
        { value: "1", title: "周一", desc: "日历从周一开始" },
        { value: "0", title: "周日", desc: "日历从周日开始" },
      ],
      onPick: (value) => setSettings({ weekStart: Number(value) === 0 ? 0 : 1 }),
    });
  });

  /* 月预算 */
  $("#rowBudget").addEventListener("click", () => {
    promptText({
      title: "月预算",
      value: String(getSettings().budget),
      placeholder: "5000",
      inputMode: "decimal",
      onConfirm: (text) => {
        const value = round2(Number(String(text).replace(/[^\d.]/g, "")));
        if (!Number.isFinite(value) || value <= 0) return toast("请输入有效金额", "error");
        setSettings({ budget: value });
        toast("预算已更新", "ok");
      },
    });
  });

  /* 分类管理 */
  $("#rowCategories").addEventListener("click", openCategoryManager);

  /* 数据导出 */
  $("#rowExport").addEventListener("click", exportData);

  /* 清空账单 */
  $("#rowClear").addEventListener("click", () => {
    const count = getRecords().length;
    if (!count) return toast("还没有可清空的账单", "error");
    confirmDialog({
      title: "清空全部账单",
      message: `将删除全部 ${count} 条记录，且无法撤销。`,
      confirmLabel: "清空",
      danger: true,
      onConfirm: () => {
        clearRecords();
        toast("已清空", "ok");
      },
    });
  });
}

/* ---------------- 分类管理弹窗 ---------------- */
function openCategoryManager() {
  openModal(
    `<p class="modal-title">分类管理</p>
     <div id="catList"></div>
     <div class="settings-input-row" style="margin-top:var(--space-4)">
       <input class="settings-input" id="catNew" type="text" placeholder="新分类名称" maxlength="12" />
       <button class="show-key-btn" id="catAdd" type="button">添加</button>
     </div>
     <div class="modal-actions">
       <button class="primary-btn primary-btn--compact" id="catDone" type="button">完成</button>
     </div>`,
    {
      onMount: (panel) => {
        const list = panel.querySelector("#catList");

        const rowFor = (name, count) => {
          const dot = el("span", { class: "calendar-cell__dot", "aria-hidden": "true" });
          dot.style.background = categoryColor(name);

          const remove = el("button", {
            class: "category-row__delete",
            type: "button",
            "aria-label": `删除分类 ${name}`,
          });
          remove.innerHTML = `<span data-icon="trash"></span>`;
          remove.addEventListener("click", () => {
            if (!removeCategory(name)) return toast("至少保留一个分类", "error");
            paint();
          });

          return el("div", { class: "category-row" }, [
            dot,
            el("span", { class: "category-row__name", text: name }),
            el("span", { class: "category-row__count", text: `${count} 笔` }),
            remove,
          ]);
        };

        function paint() {
          const { categories } = getSettings();
          const counts = new Map();
          for (const record of getRecords()) {
            counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
          }
          list.replaceChildren(...categories.map((name) => rowFor(name, counts.get(name) ?? 0)));
          hydrateIcons(list);
        }

        const add = () => {
          const input = panel.querySelector("#catNew");
          if (!addCategory(input.value)) return toast("分类为空或已存在", "error");
          input.value = "";
          paint();
        };

        panel.querySelector("#catAdd").addEventListener("click", add);
        panel.querySelector("#catNew").addEventListener("keydown", (event) => {
          if (event.key === "Enter") add();
        });
        panel.querySelector("#catDone").addEventListener("click", closeModal);

        paint();
      },
    },
  );
}

/* ---------------- 数据导出 ---------------- */
function exportData() {
  pickOption({
    title: "数据导出",
    value: "json",
    options: [
      { value: "json", title: "下载 JSON 文件", desc: "包含全部账单与设置" },
      { value: "csv", title: "下载 CSV 表格", desc: "可用 Excel / 表格软件打开" },
      { value: "clipboard", title: "复制 JSON 到剪贴板", desc: "适合直接粘贴到别处" },
    ],
    onPick: (value) => {
      const payload = exportPayload();
      const stamp = dateKey(new Date());

      if (value === "clipboard") {
        navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(
          () => toast("已复制到剪贴板", "ok"),
          () => toast("复制失败，请改用下载", "error"),
        );
        return;
      }
      if (value === "csv") {
        download(`ai-ledger-${stamp}.csv`, toCsv(payload.records), "text/csv");
        toast("已导出 CSV", "ok");
        return;
      }
      download(`ai-ledger-${stamp}.json`, JSON.stringify(payload, null, 2), "application/json");
      toast("已导出 JSON", "ok");
    },
  });
}

function download(filename, content, type) {
  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function toCsv(records) {
  const head = "日期,分类,物品,金额";
  const rows = records.map((record) =>
    [record.date, record.category, record.item, record.amount].map(csvCell).join(","),
  );
  return `\uFEFF${[head, ...rows].join("\n")}`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
