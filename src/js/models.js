/** 模型管理：服务商（模型供应商）+ 各自模型的增删改查 */

import { listModels } from "./bridge.js";
import { hydrateIcons } from "./icons.js";
import {
  PROTOCOL_ORDER,
  PROTOCOL_PRESETS,
  PROVIDER_PRESETS,
  activateProvider,
  addProvider,
  addProviderModels,
  getActiveProvider,
  getProvider,
  getProviders,
  getSettings,
  removeProvider,
  removeProviderModel,
  setProviderModel,
  updateProvider,
} from "./store.js";
import { closeModal, confirmDialog, openModal, toast } from "./ui.js";
import { buildEndpoint, el, escapeHtml } from "./util.js";

/* ================= 一级：服务商列表 ================= */
export function openModelManager(onClose = null) {
  openModal(
    `<p class="modal-title">模型管理</p>
     <p class="t-footnote mm-hint">服务商与模型都在这里手动维护；点「启用」才会写入当前连接</p>
     <div class="mm-list" id="mmList"></div>
     <div class="modal-actions">
       <button class="ghost-btn" id="mmClose" type="button">关闭</button>
       <button class="primary-btn primary-btn--compact" id="mmAdd" type="button">添加服务商</button>
     </div>`,
    {
      onClose: onClose ?? undefined,
      onMount: (panel) => {
        const list = panel.querySelector("#mmList");
        // 进二级再回来时，整个一级面板要重建（弹窗内容是共用的一个容器）
        const reopen = () => openModelManager(onClose);

        function paint() {
          const providers = getProviders();
          const activeId = getSettings().activeProviderId;
          if (!providers.length) {
            list.replaceChildren(
              el("p", {
                class: "mm-empty",
                text: "还没有服务商。点下方「添加服务商」，填好名称 / 地址 / Key，再添加它家的模型。",
              }),
            );
            return;
          }
          list.replaceChildren(
            ...providers.map((provider) => providerRow(provider, provider.id === activeId, paint, reopen)),
          );
          hydrateIcons(list);
        }

        panel.querySelector("#mmClose").addEventListener("click", closeModal);
        panel.querySelector("#mmAdd").addEventListener("click", () => openProviderEditor(null, reopen));
        paint();
      },
    },
  );
}

function providerRow(provider, isActive, repaint, reopen) {
  const main = el("button", { class: "mm-row__main", type: "button" }, [
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
        provider.model ? `默认 ${provider.model}` : "未选默认模型",
      ].join(" · "),
    }),
  ]);
  main.addEventListener("click", () => {
    if (isActive) return toast(`${provider.name} 已是当前服务商`, "ok");
    activateProvider(provider.id);
    repaint();
    toast(`已启用 ${provider.name}`, "ok");
  });

  const modelsBtn = el("button", {
    class: "mm-row__action",
    type: "button",
    "aria-label": `管理 ${provider.name} 的模型`,
    html: '<span data-icon="sparkles"></span>',
  });
  modelsBtn.addEventListener("click", () => openModelList(provider.id, reopen));

  const editBtn = el("button", {
    class: "mm-row__action",
    type: "button",
    "aria-label": `编辑 ${provider.name}`,
    html: '<span data-icon="settingsOutline"></span>',
  });
  editBtn.addEventListener("click", () => openProviderEditor(provider.id, reopen));

  return el("div", { class: `mm-row${isActive ? " is-active" : ""}` }, [main, modelsBtn, editBtn]);
}

/* ================= 服务商编辑 / 新增 ================= */
function openProviderEditor(id, onDone) {
  const editing = id ? getProvider(id) : null;
  const current = editing ?? { name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "" };

  // 默认模型直接在服务商表单里选：不用跑到模型列表再设一遍
  const modelOptions = editing?.models.length
    ? editing.models
        .map(
          (model) =>
            `<option value="${escapeHtml(model.id)}"${model.id === editing.model ? " selected" : ""}>${
              model.alias ? `${escapeHtml(model.alias)}（${escapeHtml(model.id)}）` : escapeHtml(model.id)
            }</option>`,
        )
        .join("")
    : "";

  // 新增时才给预设：点一下把名称 / 协议 / 地址和这家常用模型一起带上
  const presetBlock = editing
    ? ""
    : `<div class="mm-presets">
         <span class="mm-field__label">常用服务商（点一下自动填）</span>
         <div class="chip-row" id="pvPresetRow"></div>
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
       ${
         editing
           ? `<label class="mm-field">
                <span class="mm-field__label">默认模型</span>
                <select class="settings-input" id="pvModel">
                  ${
                    modelOptions ||
                    '<option value="">还没有模型，先在「模型」里添加</option>'
                  }
                </select>
              </label>`
           : ""
       }
     </div>
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
            const model = panel.querySelector("#pvModel")?.value.trim() ?? editing.model;
            updateProvider(editing.id, { name, protocol, baseUrl, apiKey, model });
            // 正在用的这家被改了参数，当前连接跟着更新
            if (getSettings().activeProviderId === editing.id) activateProvider(editing.id);
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
                ? `已添加 ${name}（预置 ${picked.models.length} 个模型，点右侧 ✨ 挑一个设为默认）`
                : `已添加 ${name}（在列表里点它即可启用）`,
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
      },
    },
  );
}

/* ================= 二级：某服务商的模型 ================= */
function openModelList(providerId, onDone) {
  const provider = getProvider(providerId);
  if (!provider) return onDone?.();

  openModal(
    `<p class="modal-title">模型 · ${escapeHtml(provider.name)}</p>
     <p class="t-footnote mm-hint">点某个模型设为默认；也可以手动添加模型 ID，或从 API 拉取后勾选</p>
     <div class="mm-list" id="mmModelList"></div>
     <div class="settings-input-row" style="margin-top:var(--space-3)">
       <input class="settings-input" id="mmModelId" type="text" spellcheck="false"
              autocapitalize="off" placeholder="模型 ID，如 deepseek-chat" />
       <button class="show-key-btn" id="mmModelAdd" type="button">添加</button>
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="mmModelFetch" type="button">从 API 拉取</button>
       <button class="primary-btn primary-btn--compact" id="mmModelDone" type="button">完成</button>
     </div>`,
    {
      onClose: onDone ?? undefined,
      onMount: (panel) => {
        const list = panel.querySelector("#mmModelList");

        function paint() {
          const current = getProvider(providerId);
          if (!current) return;
          if (!current.models.length) {
            list.replaceChildren(
              el("p", { class: "mm-empty", text: "还没有模型：手动填一个 ID，或点「从 API 拉取」勾选加入。" }),
            );
            return;
          }
          list.replaceChildren(...current.models.map((model) => modelRow(providerId, model, current.model, paint)));
          hydrateIcons(list);
        }

        const addOne = () => {
          const input = panel.querySelector("#mmModelId");
          const id = input.value.trim();
          if (!id) return toast("请填写模型 ID", "error");
          const added = addProviderModels(providerId, [id]);
          if (!added) return toast("这个模型已经在列表里了", "error");
          input.value = "";
          paint();
          toast(`已添加 ${id}`, "ok");
        };

        panel.querySelector("#mmModelAdd").addEventListener("click", addOne);
        panel.querySelector("#mmModelId").addEventListener("keydown", (event) => {
          if (event.key === "Enter") addOne();
        });
        panel.querySelector("#mmModelDone").addEventListener("click", closeModal);
        panel.querySelector("#mmModelFetch").addEventListener("click", () => {
          fetchModelsInto(providerId, paint);
        });

        paint();
      },
    },
  );
}

function modelRow(providerId, model, defaultId, repaint) {
  const isDefault = model.id === defaultId;
  const main = el("button", { class: "mm-row__main", type: "button" }, [
    el("span", { class: "mm-row__title" }, [
      el("span", { text: model.alias || model.id }),
      isDefault ? el("span", { class: "mm-badge", text: "默认" }) : null,
    ]),
    model.alias ? el("span", { class: "mm-row__desc", text: model.id }) : null,
  ]);
  main.addEventListener("click", () => {
    if (isDefault) return toast(`${model.id} 已是默认模型`, "ok");
    setProviderModel(providerId, model.id);
    repaint();
    toast(`默认模型：${model.id}`, "ok");
  });

  const remove = el("button", {
    class: "mm-row__action",
    type: "button",
    "aria-label": `删除模型 ${model.id}`,
    html: '<span data-icon="trash"></span>',
  });
  remove.addEventListener("click", () => {
    confirmDialog({
      title: "删除模型",
      message: `从列表中移除 ${model.id}（只是不在这个 App 里显示，不会动服务商上的模型）。`,
      confirmLabel: "删除",
      danger: true,
      onConfirm: () => {
        removeProviderModel(providerId, model.id);
        repaint();
      },
    });
  });

  return el("div", { class: `mm-row${isDefault ? " is-active" : ""}` }, [main, remove]);
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

