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
  removeProviderModels,
  selectModel,
  updateProvider,
} from "./store.js";
import { closeModal, confirmDialog, openModal, toast } from "./ui.js";
import { buildEndpoint, el, escapeHtml } from "./util.js";

/** 拉取弹窗里一次最多渲染多少行（上游动辄几百个模型，全渲染会很卡） */
const FETCH_RENDER_LIMIT = 200;

/*
 * 弹窗是单例（#modalPanel 会被复用），而「删除模型」要先弹确认框、再回到编辑弹窗，
 * 确认框会把编辑弹窗的内容整个覆盖掉。所以编辑 / 拉取这两层正在编辑的内容
 * 都放在这里持有：确认框一关，就按这份状态把原界面原样重开
 * —— 这样单删之后能留在原地接着删，不用每次重新进设置。
 */
let editorSession = null; // { providerId, draft:{name,protocol,baseUrl,apiKey}, picked:Set, onDone }
let pickerSession = null; // { providerId, all, inPool, picked, keyword, onPicked }

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
/**
 * @param {string|null} id 服务商 id；null = 新增
 * @param {Function} onDone 关闭后回调（回到模型管理一级）
 * @param {{draft?: object, picked?: Set<string>}} [carry]
 *        从确认框回来时带上的现场：未保存的连接信息 + 已勾选的模型。
 *        没有就新建一份空白的（正常进入时的行为）。
 */
function openProviderEditor(id, onDone, carry) {
  const editing = id ? getProvider(id) : null;
  const current = editing ?? { name: "", protocol: "openai-compatible", baseUrl: "", apiKey: "" };

  // 现场：优先用带过来的，其次从 store 读，最后才是空表单
  const draft = carry?.draft ?? {
    name: current.name,
    protocol: current.protocol,
    baseUrl: current.baseUrl,
    apiKey: current.apiKey,
  };
  // 勾选状态跨重绘保留；本次要删的模型走 pickerSession.picked 之外的一条线
  const picked = carry?.picked ?? new Set();
  if (editing) editorSession = { providerId: editing.id, draft, picked, onDone };
  else editorSession = null;

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
         <div class="mm-bulk" id="pvBulk" hidden>
           <button class="chip" id="pvSelectAll" type="button">全选</button>
           <button class="chip chip--danger" id="pvBulkDelete" type="button">删除选中</button>
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
        const nameInput = panel.querySelector("#pvName");
        nameInput.value = draft.name;
        panel.querySelector("#pvProtocol").value = draft.protocol;
        panel.querySelector("#pvUrl").value = draft.baseUrl;
        panel.querySelector("#pvKey").value = draft.apiKey;
        nameInput.focus();

        // 用户改了什么就实时记进 draft：删除模型中途重开时，填一半的内容不会丢
        const rememberDraft = () => {
          if (!editorSession) return;
          editorSession.draft = {
            name: nameInput.value,
            protocol: panel.querySelector("#pvProtocol").value,
            baseUrl: panel.querySelector("#pvUrl").value,
            apiKey: panel.querySelector("#pvKey").value,
          };
        };
        panel.querySelector(".field-stack")?.addEventListener("input", rememberDraft);
        panel.querySelector(".field-stack")?.addEventListener("change", rememberDraft);

        // 选中的服务商预设：保存时把它家的模型一起带进去
        let pickedPreset = null;
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
              pickedPreset = preset;
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
              models: pickedPreset?.models ?? [],
            });
            toast(
              pickedPreset
                ? `已添加 ${name}（预置 ${pickedPreset.models.length} 个模型，点「设置」可继续加）`
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

        // 编辑态：渲染「可选模型」管理区（多选 + 批量删除）
        if (editing) {
          const providerId = editing.id;
          const listEl = panel.querySelector("#pvModelList");
          const bulkEl = panel.querySelector("#pvBulk");
          const selectAllBtn = panel.querySelector("#pvSelectAll");
          const bulkDeleteBtn = panel.querySelector("#pvBulkDelete");

          // 只重画列表：删完不关弹窗，可以接着删下一个
          const paintModels = () => {
            const models = getProvider(providerId)?.models ?? [];
            const ids = new Set(models.map((model) => model.id));
            for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);

            if (!models.length) {
              listEl.replaceChildren(
                el("p", { class: "mm-empty", text: "还没模型：手动填一个 ID，或点「从 API 拉取」。" }),
              );
            } else {
              listEl.replaceChildren(...models.map((model) => modelRow(model)));
              hydrateIcons(listEl);
            }
            paintBulk(models.length);
          };

          const paintBulk = (total) => {
            const count = picked.size;
            bulkEl.hidden = total === 0;
            selectAllBtn.textContent = count === total && total > 0 ? "取消全选" : "全选";
            bulkDeleteBtn.disabled = count === 0;
            bulkDeleteBtn.textContent = count ? `删除选中 (${count})` : "删除选中";
          };

          // 一行 = 复选框 + 模型信息 + 单删。取消勾选时只更新顶部按钮，不整体重绘
          const modelRow = (model) => {
            const check = el("input", {
              class: "mm-check",
              type: "checkbox",
              "aria-label": `选择模型 ${model.id}`,
            });
            check.checked = picked.has(model.id);
            check.addEventListener("change", () => {
              if (check.checked) picked.add(model.id);
              else picked.delete(model.id);
              paintBulk(getProvider(providerId)?.models.length ?? 0);
            });

            const main = el("label", { class: "mm-row__main mm-row__main--tight" }, [
              check,
              el("span", { class: "mm-row__text" }, [
                el("span", { class: "mm-row__title", text: model.alias || model.id }),
                model.alias ? el("span", { class: "mm-row__desc", text: model.id }) : null,
              ]),
            ]);

            const remove = el("button", {
              class: "mm-row__action",
              type: "button",
              "aria-label": `删除模型 ${model.id}`,
              html: '<span data-icon="trash"></span>',
            });
            remove.addEventListener("click", () => {
              const provider = getProvider(providerId);
              // 确认框是另一个弹窗（会顶掉编辑弹窗），所以先「记住现场」，
              // 删完再带着现场把编辑弹窗原样重开 —— 不用每次重新进设置
              const revisit = () => openProviderEditor(providerId, onDone, { draft, picked });
              confirmDialog({
                title: "删除模型",
                message: `从 ${provider?.name ?? "该服务商"} 移除 ${model.id}（只是不在这个 App 里显示，不会动服务商上的模型）。`,
                confirmLabel: "删除",
                danger: true,
                onClose: revisit,
                onConfirm: () => {
                  removeProviderModels(providerId, [model.id]);
                  revisit();
                },
              });
            });

            return el("div", { class: "mm-row" }, [main, remove]);
          };

          selectAllBtn.addEventListener("click", () => {
            const models = getProvider(providerId)?.models ?? [];
            const allPicked = picked.size === models.length && models.length > 0;
            picked.clear();
            if (!allPicked) models.forEach((model) => picked.add(model.id));
            paintModels();
          });

          bulkDeleteBtn.addEventListener("click", () => {
            const count = picked.size;
            if (!count) return;
            const provider = getProvider(providerId);
            const revisit = () => openProviderEditor(providerId, onDone, { draft, picked });
            confirmDialog({
              title: `删除 ${count} 个模型`,
              message: `从 ${provider?.name ?? "该服务商"} 一次性移除这 ${count} 个模型（不会动服务商上的模型）。`,
              confirmLabel: `删除 ${count} 个`,
              danger: true,
              onClose: revisit,
              onConfirm: () => {
                const removed = removeProviderModels(providerId, [...picked]);
                picked.clear();
                revisit();
                toast(`已删除 ${removed} 个模型`, "ok");
              },
            });
          });

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
            openFetchPicker(providerId, () => openProviderEditor(providerId, onDone, { draft, picked }));
          });
        }
      },
    },
  );
}

/* ================= 从 API 拉取：搜索 + 勾选后入池 ================= */
/**
 * 拉取流程分两步，避免「一次性全拉进来、里面一堆不能用的模型」：
 *  1. 先去服务商把模型列表取回来（不写库）；
 *  2. 弹出选择框：顶部搜索过滤，勾选要用的，确认后才写进模型池。
 * 已经在池里 / 已勾选的模型会置灰标出来，不会重复添加。
 */
async function openFetchPicker(providerId, repaint) {
  const provider = getProvider(providerId);
  if (!provider) return;
  if (!provider.apiKey) return toast("先在这个服务商里填好 API Key", "error");
  if (!provider.baseUrl) return toast("先在这个服务商里填好 Base URL", "error");

  const loading = toast("正在拉取模型列表…");
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

  const all = [...new Set(result.models.map((id) => String(id).trim()).filter(Boolean))];
  if (!all.length) return toast("没有可用的模型", "error");
  openFetchPickerWith(providerId, all, repaint);
}

/**
 * 拿到候选列表之后的开框逻辑，单独拆出来：
 *  - 拉取流程（openFetchPicker）取回列表后调它；
 *  - 也能被测试 / 截图脚本直接调用，省掉「必须有真后端」这一条。
 */
export function openFetchPickerWith(providerId, all, repaint) {
  if (!getProvider(providerId) || !all?.length) return;
  // 已在池里的照旧标灰；勾选与关键词都留在 session 里，关掉再开也还在
  pickerSession = {
    providerId,
    all: [...all],
    inPool: new Set((getProvider(providerId)?.models ?? []).map((model) => model.id)),
    picked: new Set(),
    keyword: "",
    repaint,
  };
  paintFetchPicker();
}

function paintFetchPicker() {
  const session = pickerSession;
  if (!session) return;
  const { providerId, all, inPool, picked, repaint } = session;
  const provider = getProvider(providerId);
  if (!provider) {
    pickerSession = null;
    return;
  }

  openModal(
    `<p class="modal-title">选择要添加的模型</p>
     <p class="t-footnote mm-hint">从 ${escapeHtml(provider.name)} 拉到 ${all.length} 个模型。搜索并勾选需要的（已在池中的会标出来）。</p>
     <div class="mm-fetch">
       <input class="settings-input" id="fpSearch" type="search" spellcheck="false"
              autocapitalize="off" placeholder="搜索模型 ID，如 deepseek / glm-4" />
       <div class="mm-bulk" id="fpBulk">
         <span class="t-footnote" id="fpCount"></span>
         <span class="mm-bulk__spacer"></span>
         <button class="chip" id="fpSelectAll" type="button">全选</button>
       </div>
       <div class="mm-list mm-list--tall" id="fpList"></div>
     </div>
     <div class="modal-actions">
       <button class="ghost-btn" id="fpCancel" type="button">取消</button>
       <button class="primary-btn primary-btn--compact" id="fpConfirm" type="button">添加选中</button>
     </div>`,
    {
      onMount: (panel) => {
        const search = panel.querySelector("#fpSearch");
        const listEl = panel.querySelector("#fpList");
        const bulkEl = panel.querySelector("#fpBulk");
        const selectAll = panel.querySelector("#fpSelectAll");
        const countEl = panel.querySelector("#fpCount");
        const confirm = panel.querySelector("#fpConfirm");

        // 关键词记进 session：确认 / 取消回来时输入框还是原样
        search.value = session.keyword;

        const matches = () => {
          const keyword = search.value.trim().toLowerCase();
          if (!keyword) return all;
          return all.filter((id) => id.toLowerCase().includes(keyword));
        };

        const paint = () => {
          const shown = matches();
          // 候选太多时只渲染前若干行，避免一次性建几百个节点卡住
          const rows = shown.slice(0, FETCH_RENDER_LIMIT);
          if (!rows.length) {
            listEl.replaceChildren(el("p", { class: "mm-empty", text: "没有匹配的模型，换个关键词试试。" }));
          } else {
            listEl.replaceChildren(...rows.map((id) => row(id)));
          }

          const n = picked.size;
          bulkEl.hidden = false;
          const selectable = shown.filter((id) => !inPool.has(id));
          const allPicked = selectable.length > 0 && selectable.every((id) => picked.has(id));
          selectAll.textContent = allPicked ? "取消全选" : "全选";
          countEl.textContent =
            rows.length < shown.length
              ? `显示前 ${rows.length} / ${shown.length} 个 · 已选 ${n} 个`
              : `${shown.length} 个 · 已选 ${n} 个`;
          confirm.disabled = n === 0;
          confirm.textContent = n ? `添加选中 (${n})` : "添加选中";
        };

        const row = (id) => {
          const already = inPool.has(id);
          const check = el("input", {
            class: "mm-check",
            type: "checkbox",
            "aria-label": `选择模型 ${id}`,
            disabled: already,
          });
          check.checked = already || picked.has(id);
          check.addEventListener("change", () => {
            if (check.checked) picked.add(id);
            else picked.delete(id);
            paint();
          });
          return el("label", { class: `mm-row${already ? " is-muted" : ""}` }, [
            el("span", { class: "mm-row__main mm-row__main--tight" }, [
              check,
              el("span", { class: "mm-row__text" }, [
                el("span", { class: "mm-row__title", text: id }),
                already ? el("span", { class: "mm-row__desc", text: "已在池中" }) : null,
              ]),
            ]),
          ]);
        };

        search.addEventListener("input", () => {
          session.keyword = search.value;
          paint();
        });
        selectAll.addEventListener("click", () => {
          const selectable = matches().filter((id) => !inPool.has(id));
          const allPicked = selectable.length > 0 && selectable.every((id) => picked.has(id));
          if (allPicked) selectable.forEach((id) => picked.delete(id));
          else selectable.forEach((id) => picked.add(id));
          paint();
        });

        // 取消 / 关闭都回到编辑弹窗（带着现场），不是一路退到模型管理
        const backToEditor = () => {
          pickerSession = null;
          repaint?.();
        };
        panel.querySelector("#fpCancel").addEventListener("click", () => {
          closeModal();
          backToEditor();
        });

        confirm.addEventListener("click", () => {
          const ids = [...picked];
          if (!ids.length) return;
          const added = addProviderModels(providerId, ids);
          // 加完回到编辑弹窗：模型列表里马上能看到新加的
          closeModal();
          backToEditor();
          const total = getProvider(providerId)?.models.length ?? 0;
          toast(
            added ? `已添加 ${added} 个模型（共 ${total} 个）` : `这 ${ids.length} 个模型都已经在池中了`,
            "ok",
          );
        });

        paint();
        search.focus();
      },
    },
  );
}

/** 供外部（如冒烟测试 / 其他入口）直接触发拉取选择框 */
export const fetchModelsInto = openFetchPicker;
