/** 十、设置页 */

import {
  ACCENT_OPTIONS,
  DENSITY_OPTIONS,
  GLASS_OPTIONS,
  RADIUS_OPTIONS,
  VIEWS,
  VIEW_KEYS,
  describeAppearance,
} from "./appearance.js";
import { listModels, testConnection } from "./bridge.js";
import { hydrateIcons } from "./icons.js";
import {
  PROTOCOL_ORDER,
  PROTOCOL_PRESETS,
  addCategory,
  categoryColor,
  clearRecords,
  exportPayload,
  getAppearance,
  getRecords,
  getSettings,
  removeCategory,
  resetViewAppearance,
  setSettings,
  setViewAppearance,
} from "./store.js";
import { closeModal, confirmDialog, openModal, pickOption, promptText, toast } from "./ui.js";
import { $, dateKey, el, round2, yuan } from "./util.js";

const fetchedModels = new Map();

function syncModelOptions(selectedModel = "") {
  const select = $("#modelName");
  const models = [...(fetchedModels.get(getSettings().baseUrl) ?? [])];
  if (selectedModel && !models.includes(selectedModel)) models.unshift(selectedModel);
  select.replaceChildren(
    el("option", { value: "", text: models.length ? "请选择模型" : "先拉取可用模型" }),
    ...models.map((id) => el("option", { value: id, text: id })),
  );
  select.disabled = models.length === 0;
  select.value = selectedModel && models.includes(selectedModel) ? selectedModel : "";
}

/* ---------------- 渲染 ---------------- */
export function renderSettings() {
  const settings = getSettings();

  $("#protocolValue").textContent = PROTOCOL_PRESETS[settings.protocol].label;
  syncInput($("#baseUrl"), settings.baseUrl);
  syncInput($("#apiKey"), settings.apiKey);
  syncModelOptions(settings.model);

  $("#weekStartValue").textContent = settings.weekStart === 0 ? "周日" : "周一";
  $("#budgetValue").textContent = yuan(settings.budget);
  $("#categoryValue").textContent = `${settings.categories.length} 个分类`;

  const appearanceValue = $("#appearanceValue");
  if (appearanceValue) {
    appearanceValue.textContent = `${VIEW_KEYS.length} 个界面可调`;
  }
}

/** 输入框同步：正在编辑的输入框不打断 */
function syncInput(input, value) {
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

/* ---------------- 事件绑定 ---------------- */
export function bindSettings() {
  /* 协议类型 */
  $("#rowProtocol").addEventListener("click", () => {
    const current = getSettings();
    pickOption({
      title: "协议类型",
      value: current.protocol,
      options: PROTOCOL_ORDER.map((value) => ({
        value,
        title: PROTOCOL_PRESETS[value].label,
        desc: PROTOCOL_PRESETS[value].desc,
      })),
      onPick: (value) => {
        const preset = PROTOCOL_PRESETS[value];
        const patch = { protocol: value };
        const presetUrls = Object.values(PROTOCOL_PRESETS).map((item) => item.baseUrl);
        if (!current.baseUrl || presetUrls.includes(current.baseUrl)) patch.baseUrl = preset.baseUrl;
        setSettings(patch);
        toast(`已切换为${preset.label}`, "ok");
      },
    });
  });

  /* API 参数 */
  $("#baseUrl").addEventListener("change", (event) => setSettings({ baseUrl: event.target.value.trim() }));
  $("#modelName").addEventListener("change", (event) => setSettings({ model: event.target.value }));
  $("#apiKey").addEventListener("change", (event) => setSettings({ apiKey: event.target.value.trim() }));

  $("#toggleKey").addEventListener("click", () => {
    const input = $("#apiKey");
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    $("#toggleKey").textContent = hidden ? "隐藏" : "显示";
  });

  /* 拉取模型列表 */
  hydrateIcons($("#fetchModels"));
  $("#fetchModels").addEventListener("click", fetchModels);

  /* ---------------- 拉取模型 ---------------- */
  async function fetchModels() {
    const current = getSettings();
    if (!current.apiKey) return toast("请先填写 API Key", "error");
    if (!current.baseUrl) return toast("请先填写 Base URL", "error");

    const btn = $("#fetchModels");
    btn.disabled = true;
    const loading = toast("正在拉取模型…");
    try {
      const result = await listModels(current);
      const input = $("#modelName");

      if (!result.ok) {
        toast(result.message || "拉取模型失败", "error");
        return;
      }
      if (!result.models.length) {
        toast("没有可用的模型", "error");
        return;
      }
      const models = [...new Set(result.models.map((model) => model.trim()).filter(Boolean))];
      fetchedModels.set(current.baseUrl, models);
      const selected = models.includes(current.model) ? current.model : models[0];
      syncModelOptions(selected);
      setSettings({ model: selected });
      toast(`已加载 ${models.length} 个模型`, "ok");
    } finally {
      btn.disabled = false;
      loading.remove();
    }
  }

  /* 测试连接 */
  $("#testBtn").addEventListener("click", async () => {
    const current = getSettings();
    const label = $("#testBtnLabel");
    const value = $("#testValue");
    const box = $("#testResult");

    if (!current.apiKey) {
      toast("请先填写 API Key", "error");
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

  /* 外观：每个界面单独配置 */
  $("#rowAppearance").addEventListener("click", openAppearanceEditor);

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

/* ---------------- 外观配置弹窗（每个界面独立） ---------------- */
function openAppearanceEditor() {
  let current = "home";

  openModal(
    `<p class="modal-title">界面外观</p>
     <div class="appearance-tabs" id="apTabs"></div>
     <div class="appearance-body" id="apBody"></div>
     <div class="modal-actions">
       <button class="ghost-btn" id="apResetView" type="button">恢复此界面</button>
       <button class="primary-btn primary-btn--compact" id="apDone" type="button">完成</button>
     </div>`,
    {
      onMount: (panel) => {
        const tabsHolder = panel.querySelector("#apTabs");
        const body = panel.querySelector("#apBody");

        tabsHolder.replaceChildren(
          ...VIEW_KEYS.map((key) =>
            el(
              "button",
              {
                class: `appearance-tab${key === current ? " is-active" : ""}`,
                type: "button",
                dataset: { view: key },
              },
              [
                el("span", { class: "appearance-tab__label", text: VIEWS[key].label }),
                el("span", { class: "appearance-tab__desc", text: VIEWS[key].desc }),
              ],
            ),
          ),
        );

        tabsHolder.addEventListener("click", (event) => {
          const button = event.target.closest(".appearance-tab");
          if (!button || button.dataset.view === current) return;
          current = button.dataset.view;
          for (const node of tabsHolder.querySelectorAll(".appearance-tab")) {
            node.classList.toggle("is-active", node.dataset.view === current);
          }
          paint();
        });

        /** 单选控件组 */
        const choiceField = ({ caption, value, options, onPick }) => {
          const field = el("div", { class: "appearance-field" });
          field.append(el("p", { class: "appearance-field__caption" }, [el("span", { text: caption })]));
          const holder = el("div", { class: "appearance-choices" });
          for (const option of options) {
            const button = el("button", {
              class: `appearance-choice${option.value === value ? " is-active" : ""}`,
              type: "button",
              dataset: { value: option.value },
              text: option.label,
              title: option.desc ?? "",
            });
            button.addEventListener("click", () => {
              onPick(option.value);
              paint();
            });
            holder.append(button);
          }
          field.append(holder);
          return field;
        };

        /** 主题色色板 */
        const accentField = (value, onPick) => {
          const field = el("div", { class: "appearance-field" });
          field.append(
            el("p", { class: "appearance-field__caption" }, [el("span", { text: "主题色" })]),
          );
          const holder = el("div", { class: "appearance-swatches" });
          for (const option of ACCENT_OPTIONS) {
            const button = el("button", {
              class: `appearance-swatch${option.value === value ? " is-active" : ""}`,
              type: "button",
              dataset: { value: option.value },
              "aria-label": option.label,
              title: option.label,
            });
            button.style.background = option.value;
            button.addEventListener("click", () => {
              onPick(option.value);
              paint();
            });
            holder.append(button);
          }
          field.append(holder);
          return field;
        };

        function paint() {
          const config = getAppearance()[current];
          const field = el("div", { class: "appearance-field" });
          field.append(
            el("p", { class: "appearance-field__caption" }, [
              el("span", { text: "当前方案" }),
              el("span", { class: "appearance-field__value", text: describeAppearance(config) }),
            ]),
          );

          body.replaceChildren(
            field,
            accentField(config.accent, (accent) => setViewAppearance(current, { accent })),
            choiceField({
              caption: "玻璃效果",
              value: config.glass,
              options: GLASS_OPTIONS,
              onPick: (glass) => setViewAppearance(current, { glass }),
            }),
            choiceField({
              caption: "圆角",
              value: config.radius,
              options: RADIUS_OPTIONS,
              onPick: (radius) => setViewAppearance(current, { radius }),
            }),
            choiceField({
              caption: "密度",
              value: config.density,
              options: DENSITY_OPTIONS,
              onPick: (density) => setViewAppearance(current, { density }),
            }),
            el("p", {
              class: "t-footnote",
              text: "修改立即生效，并只作用于当前选中的界面；四个界面互不影响。",
            }),
          );
        }

        panel.querySelector("#apResetView").addEventListener("click", () => {
          resetViewAppearance(current);
          paint();
          toast(`已恢复「${VIEWS[current].label}」默认外观`, "ok");
        });

        panel.querySelector("#apDone").addEventListener("click", closeModal);

        paint();
      },
      onClose: () => {
        renderSettings();
      },
    },
  );
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
