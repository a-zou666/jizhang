/** 对话页：像聊天软件一样跟 AI 记账（消息流 + 内联卡片） */

import { hasBackend, parseImage, parseIntent } from "./bridge.js";
import { openConfirm } from "./confirm.js";
import { icon } from "./icons.js";
import { prepareImages, snapshotFiles } from "./image.js";
import { openModelPicker } from "./models.js";
import {
  addRecords,
  appendChat,
  categoryColor,
  clearChat,
  getActiveProvider,
  getChat,
  getProviders,
  getRecords,
  getSettings,
  removeRecord,
  updateChat,
} from "./store.js";
import { confirmDialog, haptic, toast } from "./ui.js";
import { $, escapeHtml, round2, yuan } from "./util.js";

/** 空态给的几个例子：点一下直接发 */
const SUGGESTIONS = [
  "昨天买鼠标花了 120",
  "这个月吃饭一共花了多少",
  "删掉昨天那笔咖啡",
];

let busy = false;
/** 一次最多挂几张待发送图片 */
const MAX_PENDING_IMAGES = 9;
/** 已选好、还没发出去的图片（数组，发出后清空；只留缩略图进历史） */
let pendingImages = [];

/* ---------------- 待发送的图片（可多张） ---------------- */
function setPendingImages(list) {
  pendingImages = (list ?? []).slice(-MAX_PENDING_IMAGES);
  renderAttach();
}

function clearPendingImages() {
  pendingImages = [];
  renderAttach();
}

function renderAttach() {
  const box = $("#chatAttach");
  if (!box) return;
  box.replaceChildren();
  box.hidden = pendingImages.length === 0;

  const input = $("#chatInput");
  if (input) {
    input.placeholder = pendingImages.length ? "补充说明（可留空）" : "说点什么…";
  }
  if (!pendingImages.length) return;

  const meta = document.createElement("span");
  meta.classList.add("chat-attach__meta");
  meta.textContent = `已选 ${pendingImages.length} 张`;
  box.append(meta);

  pendingImages.forEach((img, idx) => {
    const item = document.createElement("div");
    item.classList.add("chat-attach__item");

    const thumb = document.createElement("img");
    thumb.classList.add("chat-attach__img");
    thumb.src = img.thumb || img.dataUrl;
    thumb.alt = `待发送图片 ${idx + 1}`;

    const remove = document.createElement("button");
    remove.classList.add("chat-attach__remove");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除这张图片");
    remove.innerHTML = icon("close", { size: 14 });
    remove.addEventListener("click", () => setPendingImages(pendingImages.filter((_, i) => i !== idx)));

    item.append(thumb, remove);
    box.append(item);
  });
}

/** 选完图：批量压缩 + 生成缩略图，失败只提示不打断输入 */
async function onPickImages(fileList) {
  const files = snapshotFiles(fileList);
  if (!files.length) return;
  const room = MAX_PENDING_IMAGES - pendingImages.length;
  if (room <= 0) {
    toast(`最多同时选 ${MAX_PENDING_IMAGES} 张`, "error");
    return;
  }
  try {
    const { images, errors } = await prepareImages(files.slice(0, room));
    setPendingImages([...pendingImages, ...images]);
    haptic(8);
    if (errors.length) {
      console.error(errors[0]);
      toast(`有 ${errors.length} 张没读出来：${errors[0]?.message ?? "格式不支持"}`, "error");
    }
  } catch (error) {
    console.error(error);
    toast(error?.message ?? "图片读取失败", "error");
  }
}

/* ---------------- 渲染 ---------------- */
export function renderChat() {
  const list = $("#chatList");
  if (!list) return;

  const messages = getChat();
  const empty = $("#chatEmpty");
  const suggestions = $("#chatSuggest");

  empty.hidden = messages.length > 0;
  suggestions.hidden = messages.length > 0;

  list.replaceChildren(...messages.map((message) => bubbleFor(message)));
  scrollToEnd();

  // 头部胶囊：现在用的是哪个服务商 / 模型
  const provider = getActiveProvider();
  const model = getSettings().model;
  $("#chatModelName").textContent = provider
    ? `${provider.name}${model ? ` · ${model}` : " · 未选模型"}`
    : getProviders().length
      ? "未选模型"
      : "未添加服务商";

  $("#chatClear").hidden = messages.length === 0;
}

function scrollToEnd() {
  const scroller = $("#chatScroll");
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function timeText(at) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const fileRowHtml = (record) => `
  <div class="intent-row">
    <span class="intent-row__cat">
      <span class="calendar-cell__dot" style="background:${escapeHtml(categoryColor(record.category))}"></span>
      <span>${escapeHtml(record.category)}</span>
    </span>
    <span class="intent-row__main">
      <span class="intent-row__item">${escapeHtml(record.item)}</span>
      <span class="intent-row__date">${escapeHtml(record.date)}</span>
    </span>
    <span class="intent-row__amount">${escapeHtml(yuan(record.amount))}</span>
  </div>`;

function bubbleFor(message) {
  const isUser = message.role === "user";
  const wrap = document.createElement("div");
  wrap.classList.add("chat-row");
  if (isUser) wrap.classList.add("is-user");

  const avatar = document.createElement("span");
  avatar.classList.add("chat-avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.innerHTML = isUser ? "我" : icon("sparkles", { size: 18 });
  wrap.append(avatar);

  const body = document.createElement("div");
  body.classList.add("chat-bubble");

  if (message.images?.length) {
    const gallery = document.createElement("div");
    gallery.classList.add("chat-bubble__images");
    for (const src of message.images) {
      const image = document.createElement("img");
      image.classList.add("chat-bubble__image");
      image.src = src;
      image.alt = "上传的图片";
      gallery.append(image);
    }
    body.append(gallery);
  }

  if (message.text) {
    const text = document.createElement("p");
    text.classList.add("chat-bubble__text");
    text.textContent = message.text;
    body.append(text);
  }

  if (message.kind !== "text" && message.items.length) {
    body.append(cardFor(message));
  }

  if (message.state === "error") {
    const hint = document.createElement("p");
    hint.classList.add("chat-bubble__hint");
    hint.textContent = "没有成功，可以再发一次";
    body.append(hint);
  }

  const time = document.createElement("span");
  time.classList.add("chat-bubble__time");
  time.textContent = timeText(message.at);
  body.append(time);

  wrap.append(body);
  return wrap;
}

/** 消息里的账目卡片：记账 / 删除 / 查询各有各的动作 */
function cardFor(message) {
  const card = document.createElement("div");
  card.classList.add("chat-card");

  const list = document.createElement("div");
  list.classList.add("intent-list");
  list.innerHTML = message.items.map(fileRowHtml).join("");
  card.append(list);

  const total = round2(message.items.reduce((sum, item) => sum + item.amount, 0));
  const foot = document.createElement("div");
  foot.classList.add("chat-card__foot");

  const summary = document.createElement("span");
  summary.classList.add("chat-card__summary");
  summary.textContent = `${message.items.length} 笔 · 合计 ${yuan(total)}`;
  foot.append(summary);

  if (message.kind === "add" && message.state === "pending") {
    const confirm = button("确认入账", "primary-btn primary-btn--compact", () => {
      openConfirm(message.items, {
        onCommitted: () => {
          updateChat(message.id, { state: "done" });
          renderChat();
        },
      });
    });
    const ignore = button("忽略", "ghost-btn", () => {
      updateChat(message.id, { state: "ignored" });
      renderChat();
    });
    foot.append(ignore, confirm);
  }

  if (message.kind === "del" && message.state === "pending") {
    const del = button("删除这些", "ghost-btn ghost-btn--danger", () => {
      confirmDialog({
        title: `删除 ${message.items.length} 笔账目？`,
        message: "删掉后无法撤销。",
        confirmLabel: "删除",
        danger: true,
        onConfirm: () => {
          for (const item of message.items) removeRecord(item.id);
          updateChat(message.id, { state: "done", text: `已删除 ${message.items.length} 笔账目` });
          haptic(12);
          renderChat();
          toast(`已删除 ${message.items.length} 笔账目`, "ok");
        },
      });
    });
    const cancel = button("取消", "ghost-btn", () => {
      updateChat(message.id, { state: "ignored" });
      renderChat();
    });
    foot.append(cancel, del);
  }

  if (message.kind === "query") {
    const done = document.createElement("span");
    done.classList.add("chat-card__done");
    done.textContent = "以上为本机统计";
    foot.append(done);
  }

  if (message.state === "done" && message.kind !== "query") {
    const done = document.createElement("span");
    done.classList.add("chat-card__done");
    done.textContent = message.kind === "add" ? "已入账" : "已删除";
    foot.append(done);
  }
  if (message.state === "ignored") {
    const done = document.createElement("span");
    done.classList.add("chat-card__done");
    done.textContent = "已忽略";
    foot.append(done);
  }

  card.append(foot);
  return card;
}

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.classList.add(...className.split(" "));
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

/* ---------------- 发送 ---------------- */
export async function sendMessage(raw, images = pendingImages) {
  const text = String(raw ?? "").trim();
  const input = $("#chatInput");
  if (busy) return;
  if (!text && !images?.length) return;

  if (hasBackend()) {
    // 模型池在设置里维护，用哪个模型在这里选 —— 没选就没法请求，先说清楚该去哪一步
    if (!getProviders().length) {
      toast("先去 设置 → 模型管理 添加服务商并拉取模型", "error");
      return;
    }
    if (!getSettings().model || !getSettings().apiKey) {
      toast("先点顶部胶囊选一个要用的模型", "error");
      return;
    }
  }

  busy = true;
  $("#chatSend").disabled = true;
  if (input) input.value = "";
  if (images?.length) clearPendingImages();

  appendChat({
    role: "user",
    text,
    kind: "text",
    state: "done",
    at: Date.now(),
    images: (images ?? []).map((item) => item.thumb).filter(Boolean),
  });
  const thinking = appendChat({
    role: "assistant",
    text: "正在处理…",
    kind: "text",
    state: "pending",
    at: Date.now(),
  });
  renderChat();

  try {
    const result = await (images?.length ? runImage(text, images) : runIntent(text));
    updateChat(thinking.id, result);
  } catch (error) {
    console.error(error);
    updateChat(thinking.id, {
      text: `没处理成功：${error?.message ?? error}。可以再发一次，或换个说法。`,
      kind: "text",
      state: "error",
    });
  } finally {
    busy = false;
    $("#chatSend").disabled = false;
    renderChat();
  }
}

/** 一次独立请求：拿账目快照 → 解析 → 组装成一条助理消息 */
async function runIntent(text) {
  const { lines, byLineId } = buildLedger();
  const result = await parseIntent(text, getSettings(), lines);
  return routeIntent(result, byLineId);
}

/** 识图记账：把多张图片交给视觉模型，回来后走同一套 add / del / query 路由 */
async function runImage(text, images) {
  const { lines, byLineId } = buildLedger();
  const dataUrls = images.map((item) => item.dataUrl);
  const result = await parseImage(text, dataUrls, getSettings(), lines);
  return routeIntent(result, byLineId);
}

/** 把模型返回的意图翻译成界面上的一条消息 */
function routeIntent({ op, items, ids, reply }, byLineId) {
  if (op === "add" && items?.length) {
    return { text: "识别到这些账目，确认后入账：", kind: "add", items, state: "pending" };
  }
  if (op === "del") {
    const records = resolveIds(ids, byLineId);
    if (!records.length) return { text: reply || "没找到要删除的账目", kind: "text", state: "done" };
    return { text: `要删除这 ${records.length} 笔吗？`, kind: "del", items: records, state: "pending" };
  }
  if (op === "query") {
    const records = resolveIds(ids, byLineId);
    if (!records.length) return { text: reply || "没有匹配的账目", kind: "text", state: "done" };
    const total = round2(records.reduce((sum, record) => sum + record.amount, 0));
    return {
      text: `${reply ? `${reply}\n` : ""}共 ${records.length} 笔，合计 ${yuan(total)}：`,
      kind: "query",
      items: records.slice(0, 30),
      state: "done",
    };
  }
  return { text: reply || "这句话和记账无关，试试「昨天买鼠标 120」", kind: "text", state: "done" };
}

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

const resolveIds = (ids, byLineId) => [...new Set(ids ?? [])].map((id) => byLineId.get(id)).filter(Boolean);

/* ---------------- 事件绑定 ---------------- */
export function bindChat({ onNeedSettings } = {}) {
  const input = $("#chatInput");
  const send = $("#chatSend");

  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  };

  send.addEventListener("click", () => sendMessage(input.value));
  input.addEventListener("input", grow);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage(input.value);
    }
  });

  // 识图记账：点图标选图（可多选），选好后挂在输入区上方，发送时一起给模型
  const imageBtn = $("#chatImage");
  const fileInput = $("#chatFile");
  if (imageBtn && fileInput) {
    imageBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      // 顺序很关键：必须先把 FileList 拷成数组，再清空 input。
      // `input.value = ""` 会立刻把同一个 FileList 清空，若先清空再读就只剩空列表，
      // 结果就是「选完图界面毫无反应」且不报错。
      const files = snapshotFiles(fileInput.files);
      fileInput.value = "";
      // 清空 value 在部分浏览器会再触发一次 change，那时 files 为空（或用户取消选择），静默忽略
      if (files.length) await onPickImages(files);
    });
    clearPendingImages();
  }

  // 顶部胶囊 = 选择这次用哪个模型（模型池在设置 → 模型管理里维护）
  $("#chatModel").addEventListener("click", () => openModelPicker({ onManage: () => onNeedSettings?.() }));

  $("#chatClear").addEventListener("click", () => {
    confirmDialog({
      title: "清空对话",
      message: "只清掉这里的聊天记录与图片，账目不受影响。",
      confirmLabel: "清空",
      danger: true,
      onConfirm: () => {
        clearChat();
        clearPendingImages();
        renderChat();
        toast("对话已清空", "ok");
      },
    });
  });

  // 空态的示例：点一下就发出去
  $("#chatSuggest").replaceChildren(
    ...SUGGESTIONS.map((text) => {
      const chip = document.createElement("button");
      chip.classList.add("chip");
      chip.type = "button";
      chip.dataset.text = text;
      chip.textContent = text;
      return chip;
    }),
  );
  $("#chatSuggest").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-text]");
    if (!chip) return;
    sendMessage(chip.dataset.text);
  });
}
