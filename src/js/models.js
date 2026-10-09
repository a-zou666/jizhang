/** 模型管理：服务商管理（连接配置）+ 模型选择（当前用哪个） */

import { listModels } from "./bridge.js";
import { hydrateIcons } from "./icons.js";
import {
  PROTOCOL_ORDER,
  PROTOCOL_PRESETS,
  PROVIDER_PRESETS,
  addProvider,
  addProviderModels,
  getProvider,
  getProviders,
  getSettings,
  patchConnection,
  removeProvider,
  removeProviderModel,
  selectModel,
  updateProvider,
} from "./store.js";
import { closeModal, confirmDialog, openModal, toast } from "./ui.js";
import { buildEndpoint, el, escapeHtml } from "./util.js";

/* ================= 一级：模型管理（服务商管理 + 模型选择） ================= */
export function openModelManager(onClose = null) {
  openModal(
    `<p class="modal-title">模型管理</p>
     <p class="t-footnote mm-hint">先在「服务商管理」里添加并配置每个服务商有哪些模型，再到下方「模型选择」挑一个用</p>
     <div class="mm-section">
       <div class="mm-section__head">
         <span class="mm-section__title">服务商管理</span>
         <button class="primary-btn primary-btn--compact" id="mmAdd" type="button">添加服务商</button>
       </div>
       <div class="mm-list" id="mmProviders"></div>
     </div>
     <div class="mm-section">
       <div class="mm-section__head">
         <span class="mm-section__title">模型选择</span>
       </div>
       <p class="t-footnote mm-hint">点一个模型即切换到它所属的服务商（自动换 URL）</p>
       <div class="mm-list" id="mmModelChoice"></div>
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="mmClose" type="button">关闭</button>
     </div>`,
    {
      onClose: onClose ?? undefined,
      onMount: (panel) => {
        // 进二级（编辑 / 拉取）再回来时，整个面板重建
        const reopen = () => openModelManager(onClose);
        const paint = () => {
          paintProviders(panel.querySelector("#mmProviders"), reopen);
          paintModelChoice(panel.querySelector("#mmModelChoice"), paint);
        };

        panel.querySelector("#mmClose").addEventListener("click", closeModal);
        panel.querySelector("#mmAdd").addEventListener("click", () => openProviderEditor(null, reopen));
        paint();
      },
    },
  );
}

function paintProviders(list, reopen) {
  const providers = getProviders();
  if (!providers.length) {
    list.replaceChildren(
      el("p", {
        class: "mm-empty",
        text: "还没有服务商。点上方「添加服务商」，填好名称 / 地址 / Key，并配置它家可用的模型。",
      }),
    );
    return;
  }
  list.replaceChildren(...providers.map((provider) => providerRow(provider, reopen)));
  hydrateIcons(list);
}

function providerRow(provider, reopen) {
  const isActive = getSettings().activeProviderId === provider.id;
  const main = el("div", { class: "mm-row__main" }, [
    el("span", { class: "mm-row__title" }, [
      el("span", { text: provider.name }),
      isActive ? el("span", { class: "mm-badge", text: "当前" }) : null,
    ]),
    el("span", {
      class: "mm-row__desc",
      text: [
        PROTOCOL_PRESETS[provider.protocol]?.label ?? "OpenAI 兼容",
        provider.baseUrl || "未设置地址",
        `${provider.models.length} 个模型`,
      ].join(" · "),
    }),
  ]);

  // 整行只挂一个「设置」按钮：打开编辑（连接信息 + 可选模型都在里面）
  const setBtn = el("button", {
    class: "mm-row__action",
    type: "button",
    "aria-label": `设置 ${provider.name}`,
    html: '<span data-icon="settingsOutline"></span>',
  });
  setBtn.addEventListener("click", () => openProviderEditor(provider.id, reopen));

  return el("div", { class: `mm-row${isActive ? " is-active" : ""}` }, [main, setBtn]);
}

/* ================= 模型选择：跨服务商聚合 ================= */
function paintModelChoice(list, repaint) {
  const providers = getProviders();
  const { activeProviderId, model: currentModel } = getSettings();
  const choices = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      choices.push({
        provider,
        model,
        isCurrent: activeProviderId === provider.id && currentModel === model.id,
      });
    }
  }
  if (!choices.length) {
    list.replaceChildren(
      el("p", { class: "mm-empty", text: "还没有可选模型：去上方服务商里添加，或「从 API 拉取」。" }),
    );
    return;
  }
  list.replaceChildren(...choices.map((item) => choiceRow(item, repaint)));
  hydrateIcons(list);
}

function choiceRow(item, repaint) {
  const { provider, model, isCurrent } = item;
  const main = el("button", { class: "mm-row__main", type: "button" }, [
    el("span", { class: "mm-row__title" }, [
      el("span", { text: model.alias || model.id }),
      isCurrent ? el("span", { class: "mm-badge", text: "在用" }) : null,
    ]),
    el("span", { class: "mm-row__desc", text: `${provider.name} · ${model.id}` }),
  ]);
  main.addEventListener("click", () => {
    if (isCurrent) return toast(`${provider.name} · ${model.id} 已是当前模型`, "ok");
    selectModel(provider.id, model.id);
    repaint();
    toast(`已切换到 ${provider.name}`, "ok");
  });
  return el("div", { class: `mm-row${isCurrent ? " is-active" : ""}` }, [main]);
}

/* ================= 服务商编辑 / 新增 ================= */
function openProviderEditor(id, onDone) {
  const editing = id ? getProvider(id) : null;
  const current = editing ?? { name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "" };

  // 新增时才给预设：点一下把名称 / 协议 / 地址和这家常用模型一起带上
  const presetBlock = editing
    ? ""
    : `<div class="mm-presets">
         <span class="mm-field__label">常用服务商（点一下自动填）</span>
         <div class="chip-row" id="pvPresetRow"></div>
       </div>`;

  // 编辑时才有「可选模型」管理区；新增保存后点「设置」再配置
  const modelSection = editing
    ? `<div class="mm-section mm-models">
         <div class="mm-section__head">
           <span class="mm-section__title">可选模型</span>
           <button class="show-key-btn" id="pvFetch" type="button">从 API 拉取</button>
         </div>
         <div class="mm-list" id="pvModelList"></div>
         <div class="settings-input-row" style="margin-top:var(--space-3)">
           <input class="settings-input" id="pvModelId" type="text" spellcheck="false"
                  autocapitalize="off" placeholder="模型 ID，如 deepseek-chat" />
           <button class="show-key-btn" id="pvModelAdd" type="button">添加</button>
         </div>
       </div>`
    : `<div class="mm-section mm-models">
         <p class="t-footnote mm-hint" style="margin:0">保存后点这家的「设置」，即可在这里添加模型或「从 API 拉取」。</p>
       </div>`;

  openModal(
    `<p class="modal-title">${editing ? "编辑服务商" : "添加服务商"}</p>
     ${presetBlock}
     <div class="field-stack">
       <label class="mm-field">
         <span class="mm-field__label">名称</span>
         <input class="settings-input" id="pvName" type="text" maxlength="40" placeholder="如 DeepSeek / Minimax" />
       </label>
       <label class="mm-field">
         <span class="mm-field__label">协议</span>
         <select class="settings-input" id="pvProtocol">
           ${PROTOCOL_ORDER.map(
             (value) =>
               `<option value="${value}">${PROTOCOL_PRESETS[value].label}</option>`,
           ).join("")}
         </select>
       </label>
       <label class="mm-field">
         <span class="mm-field__label">接口地址</span>
         <input class="settings-input" id="pvUrl" type="text" inputmode="url" spellcheck="false"
                autocapitalize="off" autocorrect="off"
                placeholder="https://open.bigmodel.cn/api/paas/v4" />
         <span class="mm-field__hint" id="pvUrlHint"></span>
       </label>
       <label class="mm-field">
         <span class="mm-field__label">API Key</span>
         <input class="settings-input" id="pvKey" type="password" spellcheck="false"
                autocapitalize="off" placeholder="sk-..." />
         <span class="mm-field__hint" id="pvKeyHint"></span>
       </label>
     </div>
     ${modelSection}
     <div class="modal-actions">
       ${editing ? '<button class="ghost-btn ghost-btn--danger" id="pvDelete" type="button">删除</button>' : ""}
       <button class="ghost-btn" id="pvCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="pvSave" type="button">保存</button>
     </div>`,
    {
      onClose: onDone ?? undefined,
      onMount: (panel) => {
        panel.querySelector("#pvName").value = current.name;
        panel.querySelector("#pvProtocol").value = current.protocol;
        panel.querySelector("#pvUrl").value = current.baseUrl;
        panel.querySelector("#pvKey").value = current.apiKey;
        panel.querySelector("#pvName").focus();

        // 选中的预设：保存时把它家的模型一起带进去
        let picked = null;
        const urlInput = panel.querySelector("#pvUrl");
        const protocolInput = panel.querySelector("#pvProtocol");
        const urlHint = panel.querySelector("#pvUrlHint");
        const keyHint = panel.querySelector("#pvKeyHint");

        // 地址怎么补全，直接当场显示出来，避免「填了却请求错地址」
        const refreshHint = () => {
          const value = urlInput.value.trim();
          urlHint.textContent = value
            ? `实际请求：${buildEndpoint(protocolInput.value, value.replace(/\/+$/, ""))}`
            : "填基址（…/v1、…/api/v3）或完整地址（…/chat/completions）都行";
        };
        urlInput.addEventListener("input", refreshHint);
        protocolInput.addEventListener("change", refreshHint);
        refreshHint();

        const presetRow = panel.querySelector("#pvPresetRow");
        if (presetRow) {
          const chips = PROVIDER_PRESETS.map((preset) => {
            const chip = el("button", { class: "chip", type: "button", text: preset.name });
            chip.addEventListener("click", () => {
              picked = preset;
              panel.querySelector("#pvName").value = preset.name;
              protocolInput.value = preset.protocol;
              urlInput.value = preset.baseUrl;
              keyHint.textContent = preset.keyHint;
              chips.forEach((item) => item.classList.toggle("is-selected", item === chip));
              refreshHint();
              toast(`${preset.name}：还差 API Key，模型已预置 ${preset.models.length} 个`, "ok");
            });
            return chip;
          });
          presetRow.replaceChildren(...chips);
        }

        panel.querySelector("#pvCancel").addEventListener("click", closeModal);

        panel.querySelector("#pvSave").addEventListener("click", () => {
          const name = panel.querySelector("#pvName").value.trim();
          const protocol = panel.querySelector("#pvProtocol").value;
          const baseUrl = panel.querySelector("#pvUrl").value.trim();
          const apiKey = panel.querySelector("#pvKey").value.trim();

          if (!name) return toast("请填写服务商名称", "error");
          if (!baseUrl) return toast("请填写接口地址", "error");

          if (editing) {
            updateProvider(editing.id, { name, protocol, baseUrl, apiKey });
            // 正在用的这家改了连接参数，当前连接跟着更新（模型选择不变）
            if (getSettings().activeProviderId === editing.id) {
              patchConnection({ protocol, baseUrl, apiKey });
            }
            toast("已保存", "ok");
          } else {
            addProvider({
              name,
              protocol,
              baseUrl,
              apiKey,
              model: "",
              models: picked?.models ?? [],
            });
            toast(
              picked
                ? `已添加 ${name}（预置 ${picked.models.length} 个模型，点「设置」可继续加）`
                : `已添加 ${name}（在列表里点它右侧 ⚙ 即可添加模型）`,
              "ok",
            );
          }
          closeModal();
        });

        panel.querySelector("#pvDelete")?.addEventListener("click", () => {
          confirmDialog({
            title: `删除 ${current.name}`,
            message: "它的模型列表会一起删除，当前连接不受影响。",
            confirmLabel: "删除",
            danger: true,
            onConfirm: () => {
              removeProvider(editing.id);
              toast("已删除服务商", "ok");
              closeModal();
              onDone?.();
            },
          });
        });

        // 编辑态：渲染「可选模型」管理区
        if (editing) {
          const providerId = editing.id;
          const paintModels = () => {
            const currentProvider = getProvider(providerId);
            const models = currentProvider?.models ?? [];
            const listEl = panel.querySelector("#pvModelList");
            if (!models.length) {
              listEl.replaceChildren(
                el("p", { class: "mm-empty", text: "还没模型：手动填一个 ID，或点「从 API 拉取」。" }),
              );
              return;
            }
            listEl.replaceChildren(...models.map((model) => modelChip(providerId, model, paintModels)));
            hydrateIcons(listEl);
          };
          paintModels();

          const addOne = () => {
            const input = panel.querySelector("#pvModelId");
            const modelId = input.value.trim();
            if (!modelId) return toast("请填写模型 ID", "error");
            const added = addProviderModels(providerId, [modelId]);
            if (!added) return toast("这个模型已经在列表里了", "error");
            input.value = "";
            paintModels();
            toast(`已添加 ${modelId}`, "ok");
          };
          panel.querySelector("#pvModelAdd").addEventListener("click", addOne);
          panel.querySelector("#pvModelId").addEventListener("keydown", (event) => {
            if (event.key === "Enter") addOne();
          });
          panel.querySelector("#pvFetch").addEventListener("click", () => {
            fetchModelsInto(providerId, paintModels);
          });
        }
      },
    },
  );
}

function modelChip(providerId, model, repaint) {
  const main = el("div", { class: "mm-row__main" }, [
    el("span", { class: "mm-row__title", text: model.alias || model.id }),
    model.alias ? el("span", { class: "mm-row__desc", text: model.id }) : null,
  ]);

  const remove = el("button", {
    class: "mm-row__action",
    type: "button",
    "aria-label": `删除模型 ${model.id}`,
    html: '<span data-icon="trash"></span>',
  });
  remove.addEventListener("click", () => {
    const provider = getProvider(providerId);
    confirmDialog({
      title: "删除模型",
      message: `从 ${provider?.name ?? "该服务商"} 移除 ${model.id}（只是不在这个 App 里显示，不会动服务商上的模型）。`,
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => {
        removeProviderModel(providerId, model.id);
        repaint();
      },
    });
  });

  return el("div", { class: "mm-row" }, [main, remove]);
}

/* ================= 从 API 拉取后勾选加入 ================= */
export async function fetchModelsInto(providerId, repaint) {
  const provider = getProvider(providerId);
  if (!provider) return;
  if (!provider.apiKey) return toast("先在这个服务商里填好 API Key", "error");
  if (!provider.baseUrl) return toast("先在这个服务商里填好 Base URL", "error");

  const loading = toast("正在拉取模型…");
  let result;
  try {
    result = await listModels({
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    });
  } finally {
    loading.remove();
  }

  if (!result?.ok) return toast(result?.message || "拉取模型失败", "error");
  const ids = [...new Set(result.models.map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return toast("没有可用的模型", "error");

  const owned = new Set(provider.models.map((item) => item.id));
  openModal(
    `<p class="modal-title">拉取到 ${ids.length} 个模型</p>
     <p class="t-footnote mm-hint">勾选要加入 ${escapeHtml(provider.name)} 的模型（已加入的不会重复添加）</p>
     <div class="mm-list" id="mmPickList"></div>
     <div class="modal-actions">
       <button class="ghost-btn" id="mmPickAll" type="button">全选</button>
       <button class="primary-btn primary-btn--compact" id="mmPickAdd" type="button">加入所选</button>
     </div>`,
    {
      onMount: (panel) => {
        const list = panel.querySelector("#mmPickList");
        const boxes = ids.map((id) => {
          const label = el("label", { class: "mm-pick" }, [
            el("input", { type: "checkbox", value: id, checked: !owned.has(id) }),
            el("span", { class: "mm-pick__id", text: id }),
            owned.has(id) ? el("span", { class: "mm-badge mm-badge--muted", text: "已加入" }) : null,
          ]);
          return label;
        });
        list.replaceChildren(...boxes);

        panel.querySelector("#mmPickAll").addEventListener("click", () => {
          const turnOn = boxes.some((box) => !box.querySelector("input").checked);
          boxes.forEach((box) => {
            box.querySelector("input").checked = turnOn;
          });
        });
        panel.querySelector("#mmPickAdd").addEventListener("click", () => {
          const picked = boxes.filter((box) => box.querySelector("input").checked).map((box) => box.querySelector("input").value);
          if (!picked.length) return toast("还没有勾选模型", "error");
          const added = addProviderModels(providerId, picked);
          closeModal();
          repaint?.();
          toast(added ? `已加入 ${added} 个模型` : "这些模型都已在列表中", added ? "ok" : "error");
        });
      },
    },
  );
}
