/**
 * 模型相关界面，分两块各管一件事：
 *  - openModelManager（设置 → 模型管理）：服务商 + 可选模型池，
 *    决定「有哪些模型能被拉进 App 用」，不在这里选当前用哪个；
 *  - openModelPicker（对话页顶部胶囊）：从模型池里挑一个当前用的模型。
 */

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
import { buildEndpoint, el } from "./util.js";

/* ============ 一级：模型管理（只维护「有哪些模型可用」） ============ */
export function openModelManager(onClose = null) {
  openModal(
    `<p class="modal-title">模型管理</p>
     <p class="t-footnote mm-hint">这里把各服务商的模型拉进 App：添加服务商，再点它右侧「设置」，把模型「从 API 拉取」或手动填进来。<br />具体用哪一个，去「对话」页顶部那个胶囊里选 —— 拉到的模型全部都能在那儿挑，不做限制。</p>
     <div class="mm-section">
       <div class="mm-section__head">
         <span class="mm-section__title">服务商</span>
         <button class="primary-btn primary-btn--compact" id="mmAdd" type="button">添加服务商</button>
       </div>
       <div class="mm-list" id="mmProviders"></div>
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="mmClose" type="button">关闭</button>
     </div>`,
    {
      onClose: onClose ?? undefined,
      onMount: (panel) => {
        // 进二级（编辑 / 拉取）再回来时，整个面板重建
        const reopen = () => openModelManager(onClose);
        panel.querySelector("#mmClose").addEventListener("click", closeModal);
        panel.querySelector("#mmAdd").addEventListener("click", () => openProviderEditor(null, reopen));
        paintProviders(panel.querySelector("#mmProviders"), reopen);
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
        text: "还没有服务商。点上方「添加服务商」，填好名称 / 地址 / Key，再把可用的模型加进来。",
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
      isActive ? el("span", { class: "mm-badge", text: "在用" }) : null,
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

/* ============ 对话页顶部胶囊：选择这次用哪个模型 ============ */
/**
 * 列出所有服务商下的可用模型（即模型池），点一个就换成它：
 * 地址 / Key 跟着切到它所属的服务商（selectModel 是唯一的切换入口）。
 * 池子为空时引导去「模型管理」加模型。
 */
export function openModelPicker({ onManage } = {}) {
  const { activeProviderId, model: currentModel } = getSettings();
  const groups = getProviders()
    .map((provider) => ({ provider, models: provider.models }))
    .filter((group) => group.models.length);

  if (!groups.length) {
    openModal(
      `<p class="modal-title">选择模型</p>
       <p class="mm-empty">还没有可选的模型。先去「模型管理」加一个服务商，再点「从 API 拉取」把模型拉进来。</p>
       <div class="modal-actions">
         <button class="ghost-btn" id="mpClose" type="button">关闭</button>
         <button class="primary-btn primary-btn--compact" id="mpManage" type="button">去模型管理</button>
       </div>`,
      {
        onMount: (panel) => {
          panel.querySelector("#mpClose").addEventListener("click", closeModal);
          panel.querySelector("#mpManage").addEventListener("click", () => {
            closeModal();
            onManage?.();
          });
        },
      },
    );
    return;
  }

  openModal(
    `<p class="modal-title">选择模型</p>
     <p class="t-footnote mm-hint">这里只是挑「用哪一个」；要加新的模型去「模型管理」</p>
     <div class="mp-body" id="mpBody"></div>
     <div class="modal-actions">
       <button class="ghost-btn" id="mpManage" type="button">模型管理</button>
       <button class="primary-btn primary-btn--compact" id="mpClose" type="button">完成</button>
     </div>`,
    {
      onMount: (panel) => {
        const body = panel.querySelector("#mpBody");
        body.replaceChildren(
          ...groups.map(({ provider, models }) => {
            const list = el("div", { class: "mm-list" });
            for (const model of models) {
              const isCurrent = activeProviderId === provider.id && currentModel === model.id;
              const label = model.alias || model.id;
              const main = el("button", { class: "mm-row__main", type: "button" }, [
                el("span", { class: "mm-row__title" }, [
                  el("span", { text: label }),
                  isCurrent ? el("span", { class: "mm-badge", text: "在用" }) : null,
                ]),
                el("span", {
                  class: "mm-row__desc",
                  text: model.alias ? model.id : provider.name,
                }),
              ]);
              main.addEventListener("click", () => {
                if (isCurrent) return toast(`${label} 已经是当前模型`, "ok");
                selectModel(provider.id, model.id);
                closeModal();
                toast(`已切换到 ${provider.name} · ${label}`, "ok");
              });
              list.append(el("div", { class: `mm-row${isCurrent ? " is-active" : ""}` }, [main]));
            }
            return el("div", { class: "mp-group" }, [
              el("span", { class: "mp-group__name", text: provider.name }),
              list,
            ]);
          }),
        );

        panel.querySelector("#mpClose").addEventListener("click", closeModal);
        panel.querySelector("#mpManage").addEventListener("click", () => {
          closeModal();
          onManage?.();
        });
      },
    },
  );
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

/* ================= 从 API 拉取：拉到的模型全部进池 ================= */
/**
 * 正常拉取：拿到接口返回的模型列表后，全部加入这家服务商的模型池
 * （已有的不重复加）。这里**不做**「勾选哪些能进池」的限制 ——
 * 拉取只负责把模型带进 App，具体用哪个去对话页顶部的胶囊里选。
 */
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

  // 拉到的全部进池：不去勾选、不限制。用哪个在对话页胶囊里挑。
  const added = addProviderModels(providerId, ids);
  repaint?.();
  const total = getProvider(providerId)?.models.length ?? 0;
  toast(
    added ? `已拉取并加入 ${added} 个新模型（共 ${total} 个）` : `拉到的模型都已在池中（共 ${total} 个）`,
    "ok",
  );
}
