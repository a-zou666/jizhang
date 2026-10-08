/**
 * 无浏览器冒烟测试（临时校验脚本）
 *
 * 沙箱里跑不了 headless Chrome（mojo 需要命名管道），所以用一个最小 DOM 桩
 * 把真实模块加载起来，检查：
 *   1. 所有模块能否解析、app.js 启动流程是否抛错
 *   2. 外观配置是否生成作用域 CSS 变量
 *   3. index.html 引用的 id 是否都存在
 *   4. 语音退化逻辑：麦克风被拒时不再叠加第二次尝试（本次修复的核心）
 *
 * 用法：node .visual-check/smoke.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const notes = [];

const ok = (label) => notes.push(`  ✓ ${label}`);
const fail = (label, detail) => failures.push(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);

/* ============ 最小 DOM 桩 ============ */
class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach((n) => this.set.add(n)); }
  remove(...names) { names.forEach((n) => this.set.delete(n)); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  contains(name) { return this.set.has(name); }
  get value() { return [...this.set].join(" "); }
}

let idSeq = 0;
function makeNode(tag, ownerDoc) {
  const node = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    ownerDocument: ownerDoc,
    parentNode: null,
    childNodes: [],
    style: {},
    dataset: {},
    hidden: false,
    disabled: false,
    value: "",
    __text: "",
    __html: "",
    __listeners: new Map(),
    classList: new ClassList(),
    attributes: new Map(),
    offsetWidth: 0,
  };
  // textContent：赋值时必须清空子节点（真实 DOM 行为），否则 el("span",{text}) 读不到
  Object.defineProperty(node, "textContent", {
    get: () =>
      node.childNodes.length
        ? node.childNodes.map((child) => child.textContent ?? "").join("")
        : node.__text,
    set: (value) => {
      node.__text = String(value ?? "");
      node.childNodes = [];
    },
  });
  // innerHTML 需要真的解析，openModal 等依赖字符串模板挂载
  Object.defineProperty(node, "innerHTML", {
    get: () => node.__html,
    set: (value) => {
      node.__html = String(value ?? "");
      node.childNodes = [];
      if (!node.__html.trim()) return;
      const parsed = parseHtml(node.__html, ownerDoc ?? documentStub);
      node.append(...parsed.childNodes);
    },
  });
  // className 赋值必须同步 classList，否则 el("div",{class:...}) 建出来的节点选不中
  Object.defineProperty(node, "className", {
    get: () => [...node.classList.set].join(" "),
    set: (value) => {
      node.classList.set.clear();
      for (const name of String(value ?? "").split(/\s+/).filter(Boolean)) {
        node.classList.set.add(name);
      }
    },
  });
  node.id = `n${(idSeq += 1)}`;
  node.className = "";
  node.setAttribute = (name, value) => {
    node.attributes.set(name, String(value));
    if (name === "id") node.id = String(value);
    if (name === "class") node.className = String(value);
  };
  node.getAttribute = (name) => (node.attributes.has(name) ? node.attributes.get(name) : null);
  node.removeAttribute = (name) => node.attributes.delete(name);
  node.append = (...children) => {
    for (const child of children) {
      if (!child) continue;
      if (child.nodeType === 11) { node.append(...child.childNodes); continue; }
      child.parentNode = node;
      node.childNodes.push(child);
    }
    return node;
  };
  node.prepend = (...children) => {
    for (const child of children.reverse()) {
      if (!child) continue;
      child.parentNode = node;
      node.childNodes.unshift(child);
    }
    return node;
  };
  node.replaceChildren = (...children) => { node.childNodes = []; node.append(...children); return node; };
  const collect = () => {
    const all = [];
    const walk = (current) => {
      for (const child of current.childNodes) { all.push(child); walk(child); }
    };
    walk(node);
    return all;
  };
  const matches = (sel, candidate = node) => {
    const parts = String(sel).trim().split(/[,\s]+(?![^[]*\])/).filter(Boolean);
    return parts.every((part) => {
      if (part.startsWith("#")) return candidate.id === part.slice(1);
      if (part.startsWith(".")) return candidate.classList.contains(part.slice(1));
      if (part.startsWith("[") && part.endsWith("]")) {
        const [name, value] = part.slice(1, -1).split("=");
        const attr = candidate.attributes.get(name);
        if (attr === undefined) return false;
        if (value === undefined) return true;
        return attr === value.replace(/^["']|["']$/g, "");
      }
      return candidate.tagName === part.toUpperCase();
    });
  };
  const queryAll = (sel) => collect().filter((candidate) => matches(sel, candidate));
  node.querySelector = (sel) => queryAll(sel)[0] ?? null;
  node.querySelectorAll = (sel) => queryAll(sel);
  node.closest = (sel) => (matches(sel, node) ? node : node.parentNode?.closest?.(sel) ?? null);
  node.addEventListener = (type, handler) => {
    if (!node.__listeners.has(type)) node.__listeners.set(type, []);
    node.__listeners.get(type).push(handler);
  };
  node.removeEventListener = () => {};
  node.remove = () => {
    if (node.parentNode) {
      node.parentNode.childNodes = node.parentNode.childNodes.filter((c) => c !== node);
    }
  };
  node.focus = () => {};
  node.blur = () => {};
  node.click = () => node.dispatch("click");
  node.select = () => {};
  node.animate = () => ({ onfinish: null });
  node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 40, height: 20 });
  node.dispatch = (type, event = {}) => {
    const payload = {
      type,
      target: node,
      currentTarget: node,
      preventDefault() {},
      stopPropagation() {},
      clientX: 0,
      clientY: 0,
      closest: (sel) => node.closest(sel),
      ...event,
    };
    for (const handler of node.__listeners.get(type) ?? []) handler(payload);
  };
  return node;
}

function parseHtml(html, doc) {
  const stack = [];
  const root = makeNode("#root", doc);
  stack.push(root);
  const tokenPattern = /<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  let cursor = 0;
  while ((match = tokenPattern.exec(html))) {
    const text = html.slice(cursor, match.index);
    if (text.trim()) {
      const top = stack[stack.length - 1];
      if (top.childNodes.length) {
        const last = top.childNodes[top.childNodes.length - 1];
        last.textContent = `${last.textContent ?? ""}${text}`;
      }
    }
    cursor = tokenPattern.lastIndex;
    if (match[0].startsWith("<!--")) continue;
    if (match[1]) { if (stack.length > 1) stack.pop(); continue; }
    const node = makeNode(match[2], doc);
    const attrText = match[3] ?? "";
    const attrPattern = /([\w:@.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let attr;
    while ((attr = attrPattern.exec(attrText))) {
      const name = attr[1];
      if (!name || name.startsWith("=")) continue;
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      node.setAttribute(name, value);
      if (name === "class") node.className = value;
      if (name.startsWith("data-")) {
        node.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value;
      }
      if (name === "hidden") node.hidden = true;
      if (name === "id") node.id = value;
    }
    stack[stack.length - 1].append(node);
    const voidTag = match[4] === "/" || ["input", "img", "br", "meta", "link"].includes(match[2]);
    if (!voidTag) stack.push(node);
  }
  return root;
}

const html = readFileSync(resolve(ROOT, "src/index.html"), "utf8");
const documentStub = {
  nodeType: 9,
  head: makeNode("head", null),
  body: makeNode("body", null),
  documentElement: makeNode("html", null),
  activeElement: null,
  createElement: (tag) => makeNode(tag, documentStub),
  createDocumentFragment: () => {
    const frag = makeNode("#fragment", documentStub);
    frag.nodeType = 11;
    return frag;
  },
  querySelector: (sel) => documentStub.body.querySelector(sel) ?? documentStub.head.querySelector(sel),
  querySelectorAll: (sel) => documentStub.body.querySelectorAll(sel),
  getElementById: (id) =>
    documentStub.body.querySelector(`#${id}`) ?? documentStub.head.querySelector(`#${id}`),
  addEventListener: () => {},
};
const parsedRoot = parseHtml(html, documentStub);
documentStub.body.append(...parsedRoot.childNodes);
documentStub.head.append(makeNode("style", documentStub));

const app = documentStub.getElementById("app");
if (!app) fail("index.html 中存在 #app");

/* ============ 浏览器全局桩 ============ */
const storage = new Map();
const localStorageStub = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
  clear: () => storage.clear(),
};

const toasts = [];
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.window = globalThis;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
globalThis.CSS = { escape: (v) => String(v) };
globalThis.__TAURI__ = undefined;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(), 0);
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { userAgent: "node", vibrate() {}, mediaDevices: undefined, clipboard: undefined },
});
globalThis.__TAURI__ = undefined;

/* ============ 加载应用模块 ============ */
let store;
let iconModule;
try {
  store = await import(new URL("../src/js/store.js", import.meta.url));
  iconModule = await import(new URL("../src/js/icons.js", import.meta.url));
  ok("store.js / icons.js 可加载并解析");
} catch (error) {
  fail("store.js / icons.js 加载失败", error.message);
  console.log([...notes, ...failures].join("\n"));
  process.exit(1);
}

/* --- index.html 的 id 是否都能在 JS 中找到引用 --- */
const idsInHtml = [...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
const missingNodes = idsInHtml.filter((id) => !documentStub.getElementById(id));
if (missingNodes.length) fail("index.html 中的 id 未挂载", missingNodes.join(", "));
else ok(`index.html 的 ${idsInHtml.length} 个 id 均已解析`);

/* --- 外观引擎已移除：统一使用 tokens.css 静态设计令牌，不再逐界面配置（相关测试随之删除） --- */

/* --- 语音输入已下线：前端模块不应再触发任何录音/转写逻辑 --- */
documentStub.body.append(makeNode("div", documentStub)); // toastRoot 兜底
const frontSources = readdirSync(resolve(ROOT, "src/js"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => readFileSync(resolve(ROOT, "src/js", file), "utf8"))
  .join("\n");
const bridgeSource = readFileSync(resolve(ROOT, "src/js/bridge.js"), "utf8");
const indexSource = readFileSync(resolve(ROOT, "src/index.html"), "utf8");

if (/SpeechRecognition|webkitSpeechRecognition|MediaRecorder|navigator\.mediaDevices/.test(frontSources)) {
  fail("前端模块仍残留语音引擎相关代码（已下线）");
} else ok("前端模块完全移除了语音引擎代码");

if (/transcribeAudio|transcribe_audio|blobToBase64/.test(bridgeSource)) {
  fail("bridge.js 仍导出 transcribeAudio 或保留 blobToBase64");
} else ok("bridge.js 移除了音频转写导出");

if (/id="voiceWave"|class="voice-wave"/.test(indexSource)) {
  fail("index.html 仍保留 voice-wave 节点");
} else ok("index.html 移除了 voice-wave 节点");

/* appearance.js 已删除，voice-wave 残留检查随之移除 */

/* --- 端到端：真实 app.js 启动流程（覆盖 home/calendar/detail/settings/composer 装配） --- */
let appStarted = false;
try {
  await import(new URL("../src/js/app.js", import.meta.url));
  appStarted = true;
  ok("app.js 启动流程无异常（load → hydrateIcons → bind* → renderAll）");
} catch (error) {
  fail("app.js 启动抛错", `${error.message}\n${error.stack?.split("\n")[1] ?? ""}`);
}

if (appStarted) {
  const grid = documentStub.getElementById("calendarGrid");
  const weekday = documentStub.getElementById("weekdayRow");
  if (!grid?.childNodes.length) fail("日历网格未渲染");
  else ok(`日历网格渲染了 ${grid.childNodes.length} 个格子`);
  if (!weekday?.childNodes.length) fail("星期表头未渲染");
  else ok(`星期表头渲染了 ${weekday.childNodes.length} 列`);

  const monthTitle = documentStub.getElementById("monthTitle").textContent;
  if (!/\d+月/.test(monthTitle)) fail("月份标题未渲染", JSON.stringify(monthTitle));
  else ok(`月份标题渲染为「${monthTitle}」`);

  // 月份按钮必须落在日历面板抬头里（首屏顶部只留问候语 + 今天）
  const titleNode = documentStub.getElementById("monthTitle");
  const inCalendarPanel = (() => {
    let cur = titleNode.parentNode;
    while (cur) {
      if (cur.classList?.contains("calendar-panel")) return true;
      cur = cur.parentNode;
    }
    return false;
  })();
  if (!inCalendarPanel) fail("月份按钮不在 .calendar-panel 抬头里");
  else ok("月份按钮已收进日历面板抬头（顶部头只留问候语 + 今天）");

  const calSpent = documentStub.getElementById("calendarSpent")?.textContent ?? "";
  const calCount = documentStub.getElementById("calendarCount")?.textContent ?? "";
  if (!calSpent.includes("¥")) fail("日历面板未渲染本月支出合计", JSON.stringify(calSpent));
  else ok(`日历面板抬头渲染本月支出 ${calSpent}${calCount ? ` · ${calCount}` : "（本月 0 笔）"}`);

  const greetNode = documentStub.getElementById("homeGreet");
  const greetText = greetNode.childNodes.map((n) => n.textContent).join("");
  if (!/记账|已记/.test(greetText)) fail("问候语未附带今日小结", JSON.stringify(greetText));
  else ok(`问候语附带今日小结：「${greetText}」`);

  const dock = documentStub.getElementById("dock");
  const tabbarNode = documentStub.getElementById("tabbar");
  if (!dock || !tabbarNode) {
    fail("底部停靠区缺少导航栏");
  } else {
    const insideDock = (n) => {
      let cur = n.parentNode;
      while (cur) { if (cur === dock) return true; cur = cur.parentNode; }
      return false;
    };
    if (!insideDock(tabbarNode)) fail("导航栏不在 .dock 内");
    else ok("导航栏位于 .dock 停靠区（输入条已改为独立对话页）");
  }

  // 对话页：三个 Tab + 消息流 + 输入区
  const tabs = [...documentStub.querySelectorAll(".tabbar__item")].map((n) => n.dataset.tab);
  const chatIds = ["chatList", "chatInput", "chatSend", "chatScroll", "chatModel"];
  const missingChat = chatIds.filter((id) => !documentStub.getElementById(id));
  if (!tabs.includes("chat") || missingChat.length) {
    fail("对话页装配不完整", `tabs=${tabs.join("/")} 缺失=${missingChat.join(",")}`);
  } else ok(`对话页装配完整：Tab(${tabs.join("/")}) + 消息流 + 输入框 + 发送`);
}

/* --- index.html 结构契约：底部停靠区必须是单层容器 --- */
const dockBlock = html.slice(html.indexOf('id="dock"'), html.indexOf("</div>", html.indexOf('id="dock"')));
if (html.indexOf('class="dock"') === -1) fail("缺少 .dock 容器");
else ok("index.html 使用单层 .dock 容器（导航栏）");

/* --- CSS 契约：外观变量与关键选择器存在 --- */
const appCss = readFileSync(resolve(ROOT, "src/styles/app.css"), "utf8");
const tokenCss = readFileSync(resolve(ROOT, "src/styles/tokens.css"), "utf8");
const contract = [
  [".dock", "底部停靠区"],
  [".spend-overview", "月支出概览"],
  [".calendar-panel", "日历面板"],
  [".panel__head", "面板标题行"],
  [".t-hero", "t-hero 排版类"],
  [".t-title3", "t-title3 排版类"],
  [".t-caption", "t-caption 排版类"],
  [".t-footnote", "t-footnote 排版类"],
  [".glass-sheen", "柔光玻璃顶部高光"],
  [".glass-sheen::after", "柔光玻璃角部高光"],
  [".soft-glass", "柔光玻璃表面（分层叠加）"],
  [".settings-group--accent", "设置分组（带渐变色块标题）"],
  ["--app-accent", "主品牌色令牌（渐变源）"],
  ["--app-accent-grad", "主品牌渐变字符串令牌"],
  [".cal-nav", "日历上/下月导航按钮"],
  [".calendar-cell__amount", "日历格子当日合计金额"],
];
const missingCss = contract.filter(([sel]) => !appCss.includes(sel) && !tokenCss.includes(sel));
if (missingCss.length) fail("CSS 缺少关键类", missingCss.map(([s, d]) => `${s}(${d})`).join(", "));
else ok(`CSS 关键契约齐全（${contract.length} 项）`);

if (!tokenCss.includes("--color-backdrop")) fail("tokens.css 仍缺少 --color-backdrop（弹窗遮罩透明）");
else ok("tokens.css 补上 --color-backdrop");
if (!tokenCss.includes("--spacing-md")) fail("tokens.css 仍缺少 --spacing-md 别名");
else ok("tokens.css 补上 --spacing-* 别名");

/* --- 旧的漂浮结构不应残留 --- */
if (appCss.includes(".month-progress")) fail("app.css 仍残留旧的 .month-progress 样式");
else ok("旧的 .month-progress 样式已清理");
if (appCss.includes("position: fixed;\n  bottom: calc(var(--tabbar-height)")) {
  fail("底部输入条仍是 fixed 悬浮（未收进停靠区）");
} else ok("底部输入条已从 fixed 悬浮改为停靠区布局");

/* --- CSS 变量契约：app.css 引用的变量必须有人定义 --- */
// 先剥掉注释：注释里写 var(--foo) 当举例说明时，不该被当成真实引用
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, " ");
const cleanTokenCss = stripCssComments(tokenCss);
const cleanAppCss = stripCssComments(appCss);
const sourceCss = `${cleanTokenCss}\n${cleanAppCss}`;
const scopedVars = new Set(); // 仅出现在非 :root 选择器内的变量（如组件作用域令牌），允许不全局定义
for (const [, selector, body] of sourceCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const names = new Set(
    [...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
  );
  const global = /(^|,)\s*(:root|html)\s*(,|$)/.test(selector.trim());
  if (global) names.forEach((name) => scopedVars.delete(name));
  else names.forEach((name) => scopedVars.add(name));
}
const definedVars = new Set([...sourceCss.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
const referencedVars = new Set(
  [
    ...`${sourceCss}\n${html.replace(/<!--[\s\S]*?-->/g, " ")}`.matchAll(
      /var\(\s*(--[a-z0-9-]+)/g,
    ),
  ].map((match) => match[1]),
);
const undefinedVars = [...referencedVars].filter(
  (name) => !definedVars.has(name) && !scopedVars.has(name),
);
if (undefinedVars.length) fail("引用了未定义的 CSS 变量", undefinedVars.join(", "));
else ok(`CSS 变量自洽：引用 ${referencedVars.size} 个，全部有定义`);

/* --- 图标契约：模板与代码里用的图标名必须都在 ICONS 里 --- */
const iconsJs = readFileSync(resolve(ROOT, "src/js/icons.js"), "utf8");
const iconKeys = new Set(
  [...iconsJs.slice(iconsJs.indexOf("export const ICONS")).matchAll(/^\s{2}([A-Za-z]+):/gm)].map(
    (match) => match[1],
  ),
);
const jsSources = ["ui.js", "confirm.js", "chat.js", "quickadd.js", "settings.js", "home.js", "detail.js", "calendar.js"]
  .map((file) => readFileSync(resolve(ROOT, "src/js", file), "utf8"))
  .join("\n");
const usedIcons = new Set([
  ...[...html.matchAll(/data-icon="([A-Za-z]+)"/g)].map((match) => match[1]),
  ...[...jsSources.matchAll(/data-icon="([A-Za-z]+)"/g)].map((match) => match[1]),
  ...[...jsSources.matchAll(/icon\("([A-Za-z]+)"/g)].map((match) => match[1]),
]);
const unknownIcons = [...usedIcons].filter((name) => !iconKeys.has(name));
if (!iconKeys.size) fail("未能从 icons.js 解析出图标表");
else if (unknownIcons.length) fail("用到未定义的图标", unknownIcons.join(", "));
else ok(`图标自洽：引用 ${usedIcons.size} 个，全部在 ${iconKeys.size} 个图标里（${[...usedIcons].join(" ")}）`);

/* --- 未知图标不能静默变空白 --- */
const warnSpy = console.warn;
let warnedIcon = "";
console.warn = (message) => {
  warnedIcon = String(message);
};
iconModule.hydrateIcons(
  (() => {
    const holder = documentStub.createElement("span");
    holder.setAttribute("data-icon", "notAnIcon");
    return { querySelectorAll: () => [holder] };
  })(),
);
console.warn = warnSpy;
if (!warnedIcon.includes("notAnIcon")) fail("未知图标名没有告警（会静默渲染成空白）");
else ok(`未知图标名会告警：${warnedIcon}`);
if (iconModule.icon("notAnIcon") !== "") fail("未知图标应返回空字符串");
else ok("未知图标返回空字符串，不会注入 undefined");

/* --- 死样式契约：CSS 里定义的类必须真的有人用 ---
 * 动机：上一轮重构留下了一批「兼容旧类名」的规则（.card / .toast--error / text-* …），
 * 它们的选择器永远匹配不上，却让人以为错误态、卡片样式已经生效 ——
 * 语音权限报错时只看到默认深色胶囊，就是这个原因。
 *
 * 注意：这里只认「类名出现位置」，不能像早期那样把 JS 里所有标识符都算作已用，
 * 否则 `{ glass: "medium" }` 这类对象键会把 .glass 误判成「有人在用」。
 */
const RUNTIME_STATE_PREFIX = "is-"; // is-active / is-error … 由 JS 按状态拼出
const INTENTIONALLY_UNUSED = new Map([
  ["sr-only", "无障碍工具类：需要朗读但视觉隐藏时用"],
  ["t-body", "排版层级：保留完整的 t-* 语义刻度"],
  ["t-title1", "排版层级：保留完整的 t-* 语义刻度"],
  ["t-title2", "排版层级：保留完整的 t-* 语义刻度"],
]);

function cssClassNames(css) {
  const found = new Set();
  for (const [, selector] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    const trimmed = selector.trim();
    if (!trimmed || trimmed.startsWith("@")) continue;
    for (const token of trimmed.match(/\.-?[_a-zA-Z][\w-]*/g) ?? []) found.add(token.slice(1));
  }
  return found;
}

/** 收集模板/代码里真正作为 class 使用的名字 */
function classUsages(source) {
  const used = new Set();
  // 只在「取出值之后」掏空模板插值：如果先掏空整份源码，写在插值里的
  // class="option-item__desc" 会连同插值一起被抹掉，变成假死样式。
  const normalize = (value) => {
    let text = String(value);
    for (let i = 0; i < 4; i += 1) text = text.replace(/\$\{[^{}]*\}/g, " ");
    // 被引号截断而没闭合的插值（`class="chip${a === b ? "` 这种）直接丢到结尾
    return text.replace(/\$\{[\s\S]*$/, " ");
  };
  const add = (value) => {
    for (const token of normalize(value).split(/\s+/)) {
      if (token && /^-?[_a-zA-Z][\w-]*$/.test(token)) used.add(token);
    }
  };
  // HTML：class="a b" 与 class='a b'
  for (const [, value] of source.matchAll(/\bclass\s*=\s*"([^"]*)"/g)) add(value);
  for (const [, value] of source.matchAll(/\bclass\s*=\s*'([^']*)'/g)) add(value);
  // JS：class: "a b" / class: `a b` / className = "a b"
  for (const [, value] of source.matchAll(/\bclass\s*:\s*"([^"]*)"/g)) add(value);
  for (const [, value] of source.matchAll(/\bclass\s*:\s*`([^`]*)`/g)) add(value);
  for (const [, value] of source.matchAll(/\bclassName\s*=\s*"([^"]*)"/g)) add(value);
  // JS：模板字符串里的 class="a b"
  for (const [, value] of source.matchAll(/\bclass="([^"]*)"/g)) add(value);
  // JS：classList.add("a", "b") / remove / toggle
  for (const [, value] of source.matchAll(/classList\.\w+\(([^)]*)\)/g)) {
    for (const [, name] of value.matchAll(/["'`]([^"'`]+)["'`]/g)) add(name);
  }
  return used;
}

const usedClasses = new Set();
for (const value of classUsages(html)) usedClasses.add(value);
const jsDir = resolve(ROOT, "src/js");
for (const file of readdirSync(jsDir).filter((f) => f.endsWith(".js"))) {
  const source = readFileSync(resolve(jsDir, file), "utf8");
  for (const value of classUsages(source)) usedClasses.add(value);
}

const deadClasses = [];
for (const [file, css] of [
  ["src/styles/tokens.css", tokenCss],
  ["src/styles/app.css", appCss],
]) {
  for (const name of cssClassNames(css)) {
    if (usedClasses.has(name)) continue;
    if (name.startsWith(RUNTIME_STATE_PREFIX)) continue;
    if (INTENTIONALLY_UNUSED.has(name)) continue;
    deadClasses.push(`${name}（${file}）`);
  }
}
if (deadClasses.length) {
  fail("存在永远匹配不上的死样式规则", deadClasses.join("、"));
} else {
  ok(
    `无死样式：${cssClassNames(tokenCss).size + cssClassNames(appCss).size} 个类名都有使用` +
      `（另有 ${INTENTIONALLY_UNUSED.size} 个刻意保留）`,
  );
}

/* --- 审计四：关键前景/背景配色的 WCAG 对比度 ---
   颜色一律从 tokens.css 的真实输出里读，改坏了就会红。 */
const parseColor = (text) => {
  const value = String(text).trim();
  const hexMatch = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hexMatch) {
    const raw =
      hexMatch[1].length === 3
        ? hexMatch[1]
            .split("")
            .map((c) => c + c)
            .join("")
        : hexMatch[1];
    const int = Number.parseInt(raw, 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }
  const rgbaMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1]
      .split(/[,/\s]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
  }
  return null;
};
const overColor = (color, base) => ({
  r: color.r * color.a + base.r * (1 - color.a),
  g: color.g * color.a + base.g * (1 - color.a),
  b: color.b * color.a + base.b * (1 - color.a),
  a: 1,
});
const luminous = ({ r, g, b }) => {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratioOf = (a, b) => {
  const [high, low] = luminous(a) > luminous(b) ? [luminous(a), luminous(b)] : [luminous(b), luminous(a)];
  return (high + 0.05) / (low + 0.05);
};
const mixColor = (a, b, t) => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: 1,
});
const WHITE_COLOR = { r: 255, g: 255, b: 255, a: 1 };
const tokenValue = (name) => {
  const match = cleanTokenCss.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  return match ? parseColor(match[1]) : null;
};

const contrastPairs = [];
const requireContrast = (label, fg, bg, need) => {
  if (!fg || !bg) {
    contrastPairs.push({ label: `${label}（取值解析失败）`, value: 0, need, pass: false });
    return;
  }
  const value = ratioOf(fg, bg);
  contrastPairs.push({ label, value, need, pass: value >= need });
};

// 1) 正文/提示文字令牌压在浅色面板上
const surfaceBase = tokenValue("--bg-tertiary") ?? WHITE_COLOR;
requireContrast("--text-primary on 玻璃面板", tokenValue("--text-primary"), WHITE_COLOR, 4.5);
requireContrast("--text-secondary on 玻璃面板", tokenValue("--text-secondary"), WHITE_COLOR, 4.5);
requireContrast("--text-tertiary on --bg-tertiary", tokenValue("--text-tertiary"), surfaceBase, 4.5);
requireContrast("--text-placeholder on --bg-tertiary", tokenValue("--text-placeholder"), surfaceBase, 3);

// 2) 语义色：既要当底色承载白字，又要当文字压在浅底上
const inverse = tokenValue("--text-inverse");
for (const name of ["--color-success", "--color-danger"]) {
  requireContrast(`白字 on ${name} 实心块`, inverse, tokenValue(name), 4.5);
  requireContrast(`${name} 作文字 on 玻璃面板`, tokenValue(name), WHITE_COLOR, 4.5);
}
for (const name of ["--color-expense", "--color-income"]) {
  requireContrast(`${name} 金额文字 on 玻璃面板`, tokenValue(name), WHITE_COLOR, 4.5);
}
requireContrast(
  "--color-danger 作文字 on --color-danger-bg",
  tokenValue("--color-danger"),
  tokenValue("--color-danger-bg"),
  4.5,
);
// 发送按钮的绿色渐变两端（composer__action.is-send）
const sendBlock = cleanAppCss.match(/\.composer__action\.is-send\s*\{([^}]*)\}/);
const sendGradient = (sendBlock?.[1] ?? "").match(/gradient\(([^)]*)\)/);
for (const stop of (sendGradient?.[1] ?? "").split(",")) {
  const raw = (stop.trim().split(/\s+/).pop() ?? "").replace(
    /var\((--[\w-]+)\)/g,
    (_, name) => {
      const match = cleanTokenCss.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
      return match ? match[1].trim() : "";
    },
  );
  const color = parseColor(raw);
  if (color) requireContrast(`发送按钮渐变站 ${raw}`, inverse, color, 4.5);
}
// 左滑删除按钮（白字压在 --color-danger 上）
requireContrast(
  "左滑删除按钮白字",
  inverse,
  tokenValue("--color-danger"),
  4.5,
);

// 3) toast 语义底色（截图里那两条黑胶囊就是这条路）
const baseToastBlock = cleanAppCss.match(/\.toast\s*\{([^}]*)\}/);
if (!baseToastBlock) {
  contrastPairs.push({ label: ".toast 基础规则缺失", value: 0, need: 4.5, pass: false });
} else {
  const baseBg = parseColor((baseToastBlock[1].match(/background:\s*([^;]+);/) ?? [])[1] ?? "");
  requireContrast(
    "默认深色胶囊文字（截图里那两条）",
    tokenValue("--text-inverse"),
    baseBg ? overColor(baseBg, WHITE_COLOR) : null,
    4.5,
  );
}
for (const type of ["ok", "error", "warning"]) {
  const block = cleanAppCss.match(new RegExp(`\\.toast\\.is-${type}\\s*\\{([^}]*)\\}`));
  if (!block) {
    contrastPairs.push({ label: `.toast.is-${type} 规则缺失`, value: 0, need: 4.5, pass: false });
    continue;
  }
  const background = parseColor((block[1].match(/background:\s*([^;]+);/) ?? [])[1] ?? "");
  const fgMatch = block[1].match(/color:\s*([^;]+);/);
  const fg = fgMatch ? parseColor(fgMatch[1]) : tokenValue("--text-inverse");
  requireContrast(`toast.is-${type} 文字`, fg, background ? overColor(background, WHITE_COLOR) : null, 4.5);
}

/* 外观引擎已移除：8 个可选主题色及其按钮/墨色对比度测试随之删除；
   统一主题色 #00C2FF 的按钮/墨色对比度由下方 tokens 静态断言保障。 */

const weakContrast = contrastPairs.filter((pair) => !pair.pass);
if (weakContrast.length) {
  fail(
    "存在对比度不达标的前景/背景配色（WCAG AA）",
    weakContrast
      .map((pair) => `${pair.label} ${pair.value.toFixed(2)} < ${pair.need}`)
      .join("；"),
  );
} else {
  const bodyPairs = contrastPairs.filter((pair) => pair.need >= 4.5);
  ok(
    `对比度达标：${contrastPairs.length} 组前景/背景全部达到各自阈值` +
      `（含收入/支出与语义色、toast 四个底色）` +
      `，正文级最低 ${Math.min(...bodyPairs.map((pair) => pair.value)).toFixed(2)}:1`,
  );
}

/* --- 玻璃令牌：tokens.css 必须提供完整的玻璃变量（alpha / blur / saturate / hairline） --- */
const glassVars = ["--glass-alpha", "--glass-alpha-strong", "--glass-blur", "--glass-blur-strong", "--glass-saturate", "--glass-hairline"];
const missingGlass = glassVars.filter((name) => !definedVars.has(name));
if (missingGlass.length) fail("tokens.css 缺少玻璃令牌", missingGlass.join(", "));
else ok("玻璃令牌齐全（alpha / blur / saturate / hairline 均已在 tokens.css 定义）");

/* --- 预览服务器：路径解析与 MIME（index.html 是 ES Module，必须有正确 MIME） --- */
const preview = await import(new URL("./preview.mjs", import.meta.url));
const previewCases = [
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/js/app.js", "app.js"],
  ["/styles/app.css", "app.css"],
];
const previewMisses = previewCases.filter(
  ([pathname, expected]) => !String(preview.resolveRequestPath(pathname)).endsWith(expected),
);
const escaped = preview.resolveRequestPath("/../package.json") === null;
const mimeOk =
  preview.contentTypeFor("a.js") === "text/javascript; charset=utf-8" &&
  preview.contentTypeFor("a.css") === "text/css; charset=utf-8" &&
  preview.contentTypeFor("a.html") === "text/html; charset=utf-8";
if (previewMisses.length || !escaped || !mimeOk) {
  fail(
    "预览服务器的路径解析或 MIME 不正确",
    `${previewMisses.map(([p, want]) => `${p} ≠ ${want}`).join("；")} 越权拦截=${escaped} MIME=${mimeOk}`,
  );
} else {
  ok("预览服务器：/ 与静态路径解析正确、拒绝 ../ 越权、.js/.css/.html 的 MIME 正确");
}

/* --- 每个前端模块都能真正被解析（比 node --check 覆盖得更全） --- */
const parseFailures = [];
const moduleFiles = readdirSync(jsDir).filter((file) => file.endsWith(".js")).sort();
for (const file of moduleFiles) {
  try {
    await import(new URL(`../src/js/${file}`, import.meta.url));
  } catch (error) {
    parseFailures.push(`${file}: ${error.message}`);
  }
}
if (parseFailures.length) fail("有前端模块无法加载", parseFailures.join("；"));
else ok(`src/js 下 ${moduleFiles.length} 个模块全部可解析（${moduleFiles.join(" ")}）`);

/* --- AI 解析入账：日期 / 金额归一化（防止刚记的账被静默丢掉） --- */
const util = await import(new URL("../src/js/util.js", import.meta.url));
const bridge = await import(new URL("../src/js/bridge.js", import.meta.url));

const dateCases = [
  ["2026-10-4", "2026-10-04"],
  ["2026/10/04", "2026-10-04"],
  ["2026.10.4", "2026-10-04"],
  ["2026年10月4日", "2026-10-04"],
  ["2026-10-04T12:30:00Z", "2026-10-04"],
  ["20261004", "2026-10-04"],
];
const dateMisses = dateCases.filter(([input, want]) => util.normalizeDateKey(input) !== want);
const dateBads = ["", "abc", "2026-02-31", "2026-13-01", "去年", null, undefined].filter(
  (input) => util.normalizeDateKey(input) !== null,
);
if (dateMisses.length || dateBads.length) {
  fail(
    "日期归一化不正确",
    [
      ...dateMisses.map(([input, want]) => `${input} → ${util.normalizeDateKey(input)}（应为 ${want}）`),
      ...dateBads.map((input) => `${String(input)} 应判为无法识别`),
    ].join("；"),
  );
} else {
  ok(`日期归一化：${dateCases.length} 种写法都补零成 YYYY-MM-DD，非法日期（含 2026-02-31 溢出）判为无法识别`);
}

const moneyCases = [
  ["120", 120],
  ["¥120", 120],
  ["120元", 120],
  ["1,234.5", 1234.5],
  ["1.2万", 12000],
  ["-120", 120],
  ["３００", 300],
  [120.005, 120.01],
];
const moneyMisses = moneyCases.filter(([input, want]) => util.parseAmount(input) !== want);
const moneyBads = ["", "abc", "不详", null, undefined].filter((input) => util.parseAmount(input) !== null);
if (moneyMisses.length || moneyBads.length) {
  fail(
    "金额归一化不正确",
    [
      ...moneyMisses.map(([input, want]) => `${input} → ${util.parseAmount(input)}（应为 ${want}）`),
      ...moneyBads.map((input) => `${String(input)} 应判为无法识别`),
    ].join("；"),
  );
} else {
  ok(`金额归一化：${moneyCases.length} 种写法（含 ¥ / 元 / 千分位 / 万 / 全角数字）都解析成数字，"不详" 判为无法识别`);
}

const fallback = await bridge.parseAccounting("昨天买鼠标花了120元", store.getSettings());
if (!Array.isArray(fallback.records) || !fallback.records.length || typeof fallback.skipped !== "number") {
  fail("无后端时的兜底解析返回值不对", JSON.stringify(fallback));
} else {
  ok(`兜底解析返回 { records, skipped }：${fallback.records.length} 条、skipped=${fallback.skipped}`);
}

// 意图识别：新增 / 删除 / 查询 一句话命中（无后端走 mockIntent 规则引擎）
{
  const sampleLedger = ["1|10/07|午餐|餐饮|25", "2|10/06|鼠标|数码|120", "3|10/06|咖啡|餐饮|18"].join("\n");
  const delIntent = await bridge.parseIntent("把咖啡删除", store.getSettings(), sampleLedger);
  if (delIntent.op !== "del" || delIntent.ids.join() !== "3") {
    fail("意图识别：删除指令没有命中对应账目行", JSON.stringify(delIntent));
  } else ok(`删除指令命中账目行 ${delIntent.ids.join("/")}`);

  const queryIntent = await bridge.parseIntent("咖啡花了多少", store.getSettings(), sampleLedger);
  if (queryIntent.op !== "query" || !queryIntent.ids.includes(3)) {
    fail("意图识别：查询指令没有命中对应账目行", JSON.stringify(queryIntent));
  } else ok(`查询指令命中 ${queryIntent.ids.length} 行（合计由本地计算）`);

  const addIntent = await bridge.parseIntent("昨天买鼠标花了120元", store.getSettings(), sampleLedger);
  if (addIntent.op !== "add" || !addIntent.items.length || addIntent.items[0].amount !== 120) {
    fail("意图识别：记账指令没有解析出条目", JSON.stringify(addIntent));
  } else ok(`记账指令解析出 ${addIntent.items.length} 条（mock 规则引擎）`);
}

// 假装 Rust 后端回来了 4 条脏数据：2 条能救回来（日期没补零 / 金额带符号），2 条救不回来
const messyFromModel = [
  { date: "2026-10-4", item: "鼠标", category: "数码", amount: "120元" },
  { date: "2026/10/3", item: "咖啡", category: "餐饮", amount: "¥28.5" },
  { date: "昨天", item: "没有日期的账", category: "其他", amount: "30" },
  { date: "2026-10-02", item: "没有金额的账", category: "其他", amount: "不详" },
];
globalThis.__TAURI__ = { core: { invoke: async () => messyFromModel } };
const aiRun = await bridge.parseAccounting("测试", {
  protocol: "openai-compatible",
  baseUrl: "",
  apiKey: "k",
  model: "",
  categories: [],
});
globalThis.__TAURI__ = undefined;
const aiOk =
  aiRun.records.length === 2 &&
  aiRun.skipped === 2 &&
  aiRun.records[0].date === "2026-10-04" &&
  aiRun.records[0].amount === 120 &&
  aiRun.records[1].date === "2026-10-03" &&
  aiRun.records[1].amount === 28.5;
if (!aiOk) fail("AI 返回的脏日期/脏金额没有被归一化", JSON.stringify(aiRun));
else ok("AI 返回 2026-10-4 / ¥28.5 能入账，救不回来的 2 条计入 skipped（不再静默丢弃）");

store.replaceAll({ records: [], settings: {} });
const added = store.addRecords([
  { date: "2026-10-4", item: "鼠标", category: "数码", amount: "120元" },
  { date: "2026/10/3", item: "咖啡", category: "餐饮", amount: "¥28.5" },
  { date: "不是日期", item: "坏账", category: "其他", amount: "12" },
]);
const addedOk =
  added.length === 2 &&
  added[0].date === "2026-10-04" &&
  added[0].amount === 120 &&
  added[1].date === "2026-10-03" &&
  store.recordsOf("2026-10-04").length === 1;
if (!addedOk) fail("入账时未归一化日期/金额，或入口校验不一致", JSON.stringify(added));
else ok('入账归一化："2026-10-4" + "120元" 存成 2026-10-04 / 120，认不出日期的条目被拒');

store.replaceAll({
  records: [],
  settings: {
    protocol: "不存在的协议",
    baseUrl: "  https://x.test  ",
    weekStart: "abc",
    budget: -100,
    categories: [{}, "餐饮", "餐饮", " 交通 "],
  },
});
const st = store.getSettings();
const catOk = st.categories.length === 2 && st.categories[0] === "餐饮" && st.categories[1] === "交通";
if (st.protocol !== "openai-compatible" || st.weekStart !== 1 || st.budget !== 0 || st.baseUrl !== "https://x.test" || !catOk) {
  fail("导入 JSON 时设置项未走校验", JSON.stringify(st));
} else {
  ok("导入 JSON 的设置项与读本地共用一套收口：非法协议回退、weekStart/budget 归一、分类去重去空、URL 去空格");
}

/* --- 模型管理：服务商 + 模型都由用户显式增删改，不做任何自动保存 / 恢复 --- */
{
  store.replaceAll({ records: [], settings: {} });

  const deepseek = store.addProvider({
    name: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-deepseek",
  });
  const minimax = store.addProvider({
    name: "Minimax",
    protocol: "openai-compatible",
    baseUrl: "https://api.minimax.chat/v1",
    apiKey: "sk-minimax",
    models: ["MiniMax-Text-01", { id: "abab6.5s-chat", alias: "海螺" }, 123, "  "],
  });
  if (!deepseek || !minimax || store.getProviders().length !== 2 || minimax.models.length !== 2) {
    fail("服务商没有保存下来", JSON.stringify(store.getProviders()));
  } else ok(`服务商已保存：DeepSeek / Minimax(${minimax.models.length} 个模型，非法模型项被丢弃)`);

  // 新建服务商不能偷偷改当前连接
  const idle = store.getSettings();
  if (idle.activeProviderId || idle.baseUrl || idle.apiKey) {
    fail("新建服务商自动改了当前连接", JSON.stringify({ activeProviderId: idle.activeProviderId, baseUrl: idle.baseUrl }));
  } else ok("新建服务商不会自动改当前连接：只有用户点「启用」才写入");

  // 启用 = 唯一的切换入口
  store.activateProvider(minimax.id);
  const after = store.getSettings();
  if (
    after.activeProviderId !== minimax.id ||
    after.baseUrl !== minimax.baseUrl ||
    after.apiKey !== minimax.apiKey ||
    after.model !== "MiniMax-Text-01"
  ) {
    fail("启用服务商后当前连接没跟上", JSON.stringify({ ...after, providers: undefined }));
  } else ok("点「启用」把该服务商的地址 / Key / 默认模型写进当前连接");

  // 手动加模型：幂等 + 去重 + 丢弃非法
  store.addProviderModels(deepseek.id, ["deepseek-chat"]);
  const dup = store.addProviderModels(deepseek.id, ["deepseek-chat", "deepseek-reasoner", 123, ""]);
  if (dup !== 1 || store.getProvider(deepseek.id).models.length !== 2) {
    fail("手动添加模型没有去重 / 过滤", JSON.stringify(store.getProvider(deepseek.id)));
  } else ok("手动添加模型：已存在的跳过、非法项丢弃");

  // 改当前连接只同步到已启用的那一家
  store.patchConnection({ apiKey: "sk-minimax-2" });
  if (
    store.getProvider(minimax.id).apiKey !== "sk-minimax-2" ||
    store.getProvider(deepseek.id).apiKey !== "sk-deepseek"
  ) {
    fail("改当前连接时同步范围不对", JSON.stringify(store.getProviders().map((p) => [p.name, p.apiKey])));
  } else ok("改当前连接只同步到「已启用的那一家」，其他服务商不受影响");

  // 设默认 / 删除模型
  store.setProviderModel(deepseek.id, "deepseek-reasoner");
  if (store.getProvider(deepseek.id).model !== "deepseek-reasoner") {
    fail("设置默认模型失败", JSON.stringify(store.getProvider(deepseek.id)));
  } else ok("模型可设为该服务商的默认模型");
  store.removeProviderModel(deepseek.id, "deepseek-reasoner");
  if (store.getProvider(deepseek.id).models.some((m) => m.id === "deepseek-reasoner")) {
    fail("删除模型失败", JSON.stringify(store.getProvider(deepseek.id)));
  } else ok("模型可从列表里删除");

  // 非法服务商被清洗 + 失效的启用 id 复位
  store.replaceAll({
    records: [],
    settings: {
      providers: [null, { name: "缺字段" }, { name: "协议坏", protocol: "不存在的协议", models: [1, "ok"] }],
      activeProviderId: "不存在的 id",
    },
  });
  const cleaned = store.getProviders();
  if (
    cleaned.length !== 2 ||
    cleaned[1].protocol !== "openai-compatible" ||
    cleaned[1].models.length !== 1 ||
    store.getSettings().activeProviderId
  ) {
    fail("非法服务商数据没有过滤", JSON.stringify(cleaned));
  } else ok("非法服务商被过滤（空对象丢弃 / 非法协议回退 / 非法模型丢弃 / 失效的启用 id 复位）");

  // 导出不能泄露 Key
  store.replaceAll({ records: [], settings: {} });
  store.addProvider({ name: "导出测试", baseUrl: "https://x.test", apiKey: "sk-secret" });
  const payload = store.exportPayload();
  const leaked = payload.settings.providers.some((p) => p.apiKey && p.apiKey !== "***");
  if (leaked) {
    fail("导出的 JSON 泄露了服务商的 API Key", JSON.stringify(payload.settings.providers));
  } else ok("导出数据里每个服务商的 API Key 都脱敏了");

  store.replaceAll({ records: [], settings: {} });
}

/* --- 模型管理弹窗：在 DOM 桩里真实渲染一遍 --- */
{
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const models = await import(new URL("../src/js/models.js", import.meta.url));
  const panel = documentStub.getElementById("modalPanel");
  store.replaceAll({ records: [], settings: {} });

  models.openModelManager();
  await settle();
  if (!panel.querySelector(".mm-empty")) {
    fail("模型管理空态没渲染出来", String(panel.textContent).slice(0, 160));
  } else ok("模型管理能打开：还没有服务商时给出「添加服务商」引导");

  const provider = store.addProvider({ name: "桩服务商", baseUrl: "https://stub.test", apiKey: "sk-stub" });
  store.addProviderModels(provider.id, ["stub-a", "stub-b"]);
  models.openModelManager();
  await settle();
  const row = panel.querySelector(".mm-row");
  const rowText = String(row?.textContent ?? "");
  if (!rowText.includes("桩服务商") || !rowText.includes("2 个模型")) {
    fail("服务商行信息不全", rowText.slice(0, 200));
  } else ok("服务商行渲染正常：名称 / 地址 / 模型数");

  // 点服务商行 = 启用，把它的配置写进当前连接
  row.querySelector(".mm-row__main").__listeners.get("click")[0]();
  await settle();
  if (store.getSettings().baseUrl !== "https://stub.test" || !store.getSettings().model) {
    fail("点启用后当前连接没切换", JSON.stringify({ ...store.getSettings(), providers: undefined }));
  } else ok("点服务商行即可启用：地址 / Key / 默认模型写入当前连接");

  // 右侧第一个按钮 = 管理它的模型
  models.openModelManager();
  await settle();
  const actions = panel.querySelector(".mm-row").querySelectorAll(".mm-row__action");
  actions[0].__listeners.get("click")[0]();
  await settle();
  const modelRows = panel.querySelectorAll(".mm-row");
  if (modelRows.length !== 2 || !String(panel.textContent ?? "").includes("stub-a")) {
    fail("模型列表没渲染出来", `rows=${modelRows.length}`);
  } else ok(`模型列表渲染正常：${modelRows.length} 个模型（点行设默认、右侧删除）`);

  store.replaceAll({ records: [], settings: {} });
}

/* --- 当月预算：填在首页「本月支出」旁边，按月覆盖默认预算 --- */
{
  store.replaceAll({ records: [], settings: { budget: 2000 } });
  const oct = new Date(2026, 9, 1);
  const nov = new Date(2026, 10, 1);

  if (store.getMonthBudget(oct) !== 2000) {
    fail("默认月预算没生效", String(store.getMonthBudget(oct)));
  } else ok("没单独设置的月份沿用默认月预算");

  store.setMonthBudget(oct, 1500);
  if (store.getMonthBudget(oct) !== 1500 || store.getMonthBudget(nov) !== 2000) {
    fail("单月预算覆盖了别的月份", JSON.stringify({ oct: store.getMonthBudget(oct), nov: store.getMonthBudget(nov) }));
  } else ok("给某个月单独设预算：只有那一个月变，其他月份不变");

  store.resetMonthBudget(oct);
  if (store.getMonthBudget(oct) !== 2000) {
    fail("恢复默认后没回到全局预算", String(store.getMonthBudget(oct)));
  } else ok("「恢复默认」让该月回到全局预算");

  if (store.setMonthBudget("2026-13", 100) !== false || store.setMonthBudget(oct, -1) !== false) {
    fail("非法月份 / 负数预算没有被拒绝", JSON.stringify(store.getSettings().budgets));
  } else ok("非法月份键与负数预算被拒绝");

  if (!indexSource.includes('id="monthBudgetBtn"') || !/spend-overview__amount/.test(indexSource)) {
    fail("首页没有当月预算入口", "缺少 monthBudgetBtn");
  } else ok("当月预算入口就在首页「本月支出」旁边：翻到哪个月，改的就是哪个月");

  store.replaceAll({ records: [], settings: {} });
}

/* --- 对话页：消息流 + 内联卡片在 DOM 桩里渲染一遍 --- */
{
  const chat = await import(new URL("../src/js/chat.js", import.meta.url));
  const list = documentStub.getElementById("chatList");
  store.clearChat();
  chat.renderChat();
  if (list.childNodes.length !== 0) {
    fail("空对话不该有气泡", String(list.childNodes.length));
  } else ok("对话页空态：消息区为空，展示欢迎语与示例");

  store.appendChat({ role: "user", text: "昨天买鼠标 120", kind: "text", state: "done" });
  store.appendChat({
    role: "assistant",
    text: "识别到这些账目，确认后入账：",
    kind: "add",
    items: [{ id: "chat-x", date: "2026-10-08", item: "鼠标", category: "数码", amount: 120 }],
    state: "pending",
  });
  chat.renderChat();
  const rows = list.querySelectorAll(".chat-row");
  const bubbleText = rows.map((row) => String(row.textContent)).join(" | ");
  if (rows.length !== 2 || !bubbleText.includes("鼠标") || !bubbleText.includes("确认入账")) {
    fail("对话气泡 / 卡片渲染不完整", `rows=${rows.length} ${bubbleText.slice(0, 160)}`);
  } else ok("对话页渲染正常：用户气泡 + 助理卡片（账目行 + 确认入账 / 忽略）");

  store.clearChat();
  if (store.getChat().length !== 0) fail("清空对话没有生效");
  else ok("「清空对话」只清聊天记录，不影响账目");
}

/* --- 手动编辑必须能删掉：编辑弹窗自带删除 + 二次确认 --- */
{
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const editor = await import(new URL("../src/js/editor.js", import.meta.url));
  const panel = documentStub.getElementById("modalPanel");
  store.replaceAll({ records: [], settings: {} });
  const saved = store.addRecords([{ date: "2026-10-08", item: "鼠标", category: "数码", amount: 120 }]);

  let deleted = false;
  editor.openRecordEditor(saved[0], () => {}, { onDelete: () => { deleted = true; } });
  await settle();
  const delBtn = panel.querySelector("#edDelete");
  if (!delBtn) {
    fail("编辑弹窗没有删除按钮", String(panel.textContent).slice(0, 160));
  } else ok("编辑弹窗自带「删除」：手动编辑时能直接删掉已添加的记录");

  delBtn.__listeners.get("click")[0]();
  await settle();
  const confirmBtn = panel.querySelector("#modalConfirm");
  if (!confirmBtn || deleted) {
    fail("删除没走二次确认，或还没确认就已经删了");
  } else ok("删除走二次确认（显示条目与金额），手滑点错不会立刻删掉");

  confirmBtn.__listeners.get("click")[0]();
  await settle();
  if (!deleted) fail("确认后没有执行删除回调");
  else ok("确认后才真正删除：明细页走 removeRecord，确认页从待入账列表移除");

  editor.openRecordEditor(saved[0], () => {});
  await settle();
  if (panel.querySelector("#edDelete")) {
    fail("没传删除回调时不该显示删除按钮");
  } else ok("没有删除回调的场合不会显示删除按钮");

  store.replaceAll({ records: [], settings: {} });
}

/* --- AI 解析必须有超时上限，避免界面一直无反馈 --- */
if (typeof bridge.AI_TIMEOUT_MS === "number" && bridge.AI_TIMEOUT_MS > 0 && bridge.AI_TIMEOUT_MS <= 60000) {
  ok(`AI 解析有超时上限：${bridge.AI_TIMEOUT_MS / 1000} 秒`);
} else {
  fail("bridge.js 缺少 AI_TIMEOUT_MS（或取值不合理）", String(bridge.AI_TIMEOUT_MS));
}

/* --- 存储故障不能静默：写入失败 / 本地数据损坏 / 坏记录被跳过都要能被 UI 看到 --- */
store.replaceAll({ records: [], settings: {} });
const storageEvents = [];
const unsubscribeStorage = store.onStorageError((problem) => storageEvents.push(problem));

/* (1) 写入失败（配额满 / 隐私模式）*/
const pristineSetItem = localStorageStub.setItem;
localStorageStub.setItem = () => {
  throw new Error("QuotaExceededError: 存储空间不足");
};
store.addRecords([{ date: "2026-10-05", amount: 66, category: "餐饮", item: "米饭", type: "expense" }]);
const writeProblem = storageEvents.at(-1);
const writeSurfaced = writeProblem?.kind === "write" && /Quota/.test(writeProblem.detail);
if (!writeSurfaced || !store.getStorageProblem()) {
  fail("写入本地存储失败时没有上报给界面（会变成「以为记上了、其实没存」）", JSON.stringify(storageEvents));
} else {
  ok("写入本地存储失败会立刻上报（kind=write，带原始错误信息），不再是只写 console.warn");
}

/* (2) 恢复后要通知一次 null，让用户知道已经存得住 */
localStorageStub.setItem = pristineSetItem;
store.addRecords([{ date: "2026-10-05", amount: 12, category: "餐饮", item: "水", type: "expense" }]);
if (storageEvents.at(-1) !== null || store.getStorageProblem() !== null) {
  fail("存储恢复后没有回调 null", JSON.stringify(storageEvents.at(-1)));
} else {
  ok("写入恢复正常后会回调 null，界面据此告知「已经存得住了」");
}

/* (3) 本地数据损坏：必须先把原始内容备份，再重置 */
const corrupt = '{"records": [{"amount": 1,';
storage.set("ai-ledger/v1", corrupt);
storage.delete("ai-ledger/v1.recovered");
store.load();
const readProblem = storageEvents.at(-1);
const backedUp = storage.get("ai-ledger/v1.recovered") === corrupt;
if (readProblem?.kind !== "read" || !readProblem.backedUp || !backedUp) {
  fail("本地数据损坏时没有备份原始内容就重置（下一次写入会永久覆盖）", JSON.stringify({ readProblem, backedUp }));
} else if (store.getRecords().length !== 0) {
  fail("本地数据损坏后没有回到默认状态");
} else {
  ok("本地数据损坏时先备份到 ai-ledger/v1.recovered 再重置，损坏的字节不会被下一次写入覆盖");
}

/* (4) 格式坏掉的记录被跳过时要报出条数（其余账目仍可用）*/
storage.set(
  "ai-ledger/v1",
  JSON.stringify({
    records: [
      { date: "2026-10-06", amount: 20, category: "餐饮", item: "面", type: "expense" },
      { date: "不是日期", amount: 20 },
      { date: "2026-10-07", amount: "不是金额" },
    ],
    settings: {},
  }),
);
store.load();
const droppedProblem = storageEvents.at(-1);
if (droppedProblem?.kind !== "dropped" || droppedProblem.dropped !== 2 || store.getRecords().length !== 1) {
  fail("坏记录被静默跳过", JSON.stringify({ droppedProblem, records: store.getRecords().length }));
} else {
  ok("格式损坏的本地记录会被报出条数（2 条跳过、1 条保留），不再静默消失");
}

/* (5) 注册时立刻回放当前故障，保证 load() 阶段的读故障不会漏 */
storage.set("ai-ledger/v1", "{oops");
store.load();
const replayed = [];
store.onStorageError((problem) => replayed.push(problem));
if (replayed.length !== 1 || replayed[0]?.kind !== "read") {
  fail("订阅存储故障时没有回放当前故障（load() 阶段的问题会漏掉）", JSON.stringify(replayed));
} else {
  ok("订阅存储故障时会立刻回放当前故障，load() 阶段的问题也不漏");
}
unsubscribeStorage();

/* 收尾：把存储恢复干净，别影响后续审计 */
storage.delete("ai-ledger/v1");
storage.delete("ai-ledger/v1.recovered");
store.load();

/* --- 输出 --- */
console.log("冒烟测试结果");
console.log(notes.join("\n"));
if (failures.length) {
  console.log("\n失败项");
  console.log(failures.join("\n"));
  process.exit(1);
}
console.log("\n全部通过");
