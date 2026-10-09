#!/usr/bin/env node
/**
 * 用无头 Chromium 把 App 真实跑一遍，截出各页面原图（不依赖手工上传的截图）。
 *
 * 用法：
 *   node scripts/preview.mjs &        # 先起本地预览（浏览器兜底模式，无需 Rust）
 *   node scripts/screenshots.mjs
 *
 * 需要本地有 Chromium：npx playwright@1.49.0 install chromium
 * （playwright-core 用 --no-save 装，不进 package.json，CI 不依赖它）
 */

import { chromium } from "playwright-core";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "docs", "screenshots");
const BASE = process.env.PREVIEW_URL ?? "http://127.0.0.1:8080/";

/* ---------------- 演示数据：让每个界面都有内容 ---------------- */
// 日期相对「今天」算，避免截图时首页（只显示当天记录）因固定日期落空
function dateKey(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const DAY = (offset = 0) => dateKey(offset);
const at = (offset = 0, h = 9) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
};

const records = [
  { id: "d1", date: DAY(0), item: "拿铁", category: "餐饮", amount: 32, createdAt: at(0, 8) },
  { id: "d2", date: DAY(0), item: "地铁", category: "交通", amount: 6, createdAt: at(0, 9) },
  { id: "d3", date: DAY(1), item: "电影票", category: "娱乐", amount: 78, createdAt: at(1, 20) },
  { id: "d4", date: DAY(2), item: "洗发水", category: "日用", amount: 49.9, createdAt: at(2, 19) },
  { id: "d5", date: DAY(3), item: "键盘", category: "数码", amount: 259, createdAt: at(3, 15) },
  { id: "d6", date: DAY(5), item: "房租", category: "居住", amount: 1800, createdAt: at(5, 10) },
  { id: "d7", date: DAY(6), item: "火锅", category: "餐饮", amount: 168, createdAt: at(6, 18) },
  { id: "d8", date: DAY(7), item: "水果", category: "餐饮", amount: 45.5, createdAt: at(7, 11) },
];

const providers = [
  {
    id: "pv-deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-demo",
    model: "deepseek-chat",
    models: [{ id: "deepseek-chat", alias: "" }, { id: "deepseek-reasoner", alias: "" }],
  },
  {
    id: "pv-minimax",
    name: "MiniMax",
    protocol: "openai-compatible",
    baseUrl: "https://api.minimax.chat/v1",
    apiKey: "sk-demo",
    model: "MiniMax-M2",
    models: [{ id: "MiniMax-M2", alias: "" }, { id: "MiniMax-Text-01", alias: "" }],
  },
];

/* 演示用的多张缩略图（真实渲染进气泡，不手工 P 图），用来体现「一次发多张」 */
const svgThumb = (body) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240">${body}</svg>`,
  )}`;

const receiptThumb = svgThumb(`
  <rect width="180" height="240" fill="#F2F4F7"/>
  <rect x="16" y="18" width="148" height="204" rx="6" fill="#FFFFFF" stroke="#DFE3E8"/>
  <text x="90" y="46" font-size="14" text-anchor="middle" fill="#111827">便利小票</text>
  <line x1="30" y1="58" x2="150" y2="58" stroke="#E5E7EB"/>
  <text x="30" y="82" font-size="11" fill="#374151">拿铁 × 1</text><text x="150" y="82" font-size="11" text-anchor="end" fill="#111827">32.00</text>
  <text x="30" y="104" font-size="11" fill="#374151">三明治 × 1</text><text x="150" y="104" font-size="11" text-anchor="end" fill="#111827">18.50</text>
  <text x="30" y="126" font-size="11" fill="#374151">纸巾 × 2</text><text x="150" y="126" font-size="11" text-anchor="end" fill="#111827">6.00</text>
  <line x1="30" y1="142" x2="150" y2="142" stroke="#E5E7EB"/>
  <text x="30" y="164" font-size="12" fill="#111827">合计</text><text x="150" y="164" font-size="12" text-anchor="end" fill="#DC2626">56.50</text>
  <text x="90" y="196" font-size="9" text-anchor="middle" fill="#9CA3AF">2026-10-08 09:12</text>`);

const paymentThumb = svgThumb(`
  <rect width="180" height="240" fill="#ECFDF3"/>
  <circle cx="90" cy="60" r="26" fill="#16A34A"/>
  <path d="M80 60 l7 8 l13 -16" stroke="#FFFFFF" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="90" y="108" font-size="14" text-anchor="middle" fill="#111827">支付成功</text>
  <text x="90" y="140" font-size="20" text-anchor="middle" fill="#16A34A">¥56.50</text>
  <line x1="30" y1="160" x2="150" y2="160" stroke="#BBF7D0"/>
  <text x="30" y="184" font-size="11" fill="#374151">便利店</text><text x="150" y="184" font-size="11" text-anchor="end" fill="#111827">微信支付</text>
  <text x="90" y="212" font-size="9" text-anchor="middle" fill="#6B7280">2026-10-08 09:12</text>`);

const menuThumb = svgThumb(`
  <rect width="180" height="240" fill="#FFF7ED"/>
  <rect x="16" y="18" width="148" height="204" rx="6" fill="#FFFFFF" stroke="#FED7AA"/>
  <text x="90" y="46" font-size="14" text-anchor="middle" fill="#9A3412">外卖订单</text>
  <line x1="30" y1="58" x2="150" y2="58" stroke="#FFEDD5"/>
  <text x="30" y="82" font-size="11" fill="#374151">麻辣香锅</text><text x="150" y="82" font-size="11" text-anchor="end" fill="#111827">42.00</text>
  <text x="30" y="104" font-size="11" fill="#374151">米饭 × 2</text><text x="150" y="104" font-size="11" text-anchor="end" fill="#111827">4.00</text>
  <text x="30" y="126" font-size="11" fill="#374151">可乐 × 1</text><text x="150" y="126" font-size="11" text-anchor="end" fill="#111827">6.00</text>
  <line x1="30" y1="142" x2="150" y2="142" stroke="#FFEDD5"/>
  <text x="30" y="164" font-size="12" fill="#111827">合计</text><text x="150" y="164" font-size="12" text-anchor="end" fill="#DC2626">52.00</text>
  <text x="90" y="196" font-size="9" text-anchor="middle" fill="#9CA3AF">2026-10-08 12:30</text>`);

const demoImages = [receiptThumb, paymentThumb, menuThumb];

const chat = [
  {
    id: "c1",
    role: "user",
    text: "昨天买电影票 78，今天咖啡 32",
    kind: "text",
    items: [],
    state: "done",
    at: at(8, 10),
  },
  {
    id: "c2",
    role: "assistant",
    text: "识别到 2 笔，确认后入账：",
    kind: "add",
    state: "done",
    at: at(8, 10),
    items: [
      { id: "c2a", date: DAY(7), item: "电影票", category: "娱乐", amount: 78, createdAt: at(7, 20) },
      { id: "c2b", date: DAY(8), item: "咖啡", category: "餐饮", amount: 32, createdAt: at(8, 8) },
    ],
  },
  {
    id: "c2b",
    role: "user",
    text: "",
    kind: "text",
    items: [],
    state: "done",
    at: at(8, 10),
    images: demoImages,
  },
  {
    id: "c2c",
    role: "assistant",
    text: "从这几张图里读出 3 笔，确认后入账：",
    kind: "add",
    state: "pending",
    at: at(8, 10),
    items: [
      { id: "c2d", date: DAY(8), item: "拿铁", category: "餐饮", amount: 32, createdAt: at(8, 9) },
      { id: "c2e", date: DAY(8), item: "三明治", category: "餐饮", amount: 18.5, createdAt: at(8, 9) },
      { id: "c2f", date: DAY(8), item: "纸巾", category: "日用", amount: 6, createdAt: at(8, 9) },
    ],
  },
  {
    id: "c3",
    role: "user",
    text: "这个月餐饮花了多少",
    kind: "text",
    items: [],
    state: "done",
    at: at(8, 11),
  },
  {
    id: "c4",
    role: "assistant",
    text: "本月餐饮共 3 笔，合计 ¥245.50",
    kind: "query",
    state: "done",
    at: at(8, 11),
    items: [
      { id: "c4a", date: DAY(8), item: "拿铁", category: "餐饮", amount: 32, createdAt: at(8, 8) },
      { id: "c4b", date: DAY(2), item: "火锅", category: "餐饮", amount: 168, createdAt: at(2, 18) },
      { id: "c4c", date: DAY(1), item: "水果", category: "餐饮", amount: 45.5, createdAt: at(1, 11) },
    ],
  },
];

const seed = {
  records,
  chat,
  settings: {
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-demo",
    model: "deepseek-chat",
    weekStart: 1,
    budget: 2600,
    budgets: { [dateKey(0).slice(0, 7)]: 2600 },
    categories: ["餐饮", "交通", "日用", "娱乐", "居住", "数码", "医疗", "其他"],
    providers,
    activeProviderId: "pv-deepseek",
  },
};

/* ---------------- 截图（带断言，避免截到空壳界面） ---------------- */
const shots = [];

/**
 * @param {string} selector 该界面必须存在的元素
 * @param {number} [minCount] 最少出现几次
 */
async function shoot(page, name, selector, minCount = 1) {
  const count = await page.locator(selector).count();
  if (count < minCount) {
    throw new Error(`${name}：只找到 ${count} 个 ${selector}（期望 >= ${minCount}），界面可能没渲染出来`);
  }
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(name);
  console.log(`  ✓ ${name}.png  (${selector} × ${count})`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  // 清掉旧图，保证 docs/screenshots 里只有本次真实渲染的界面
  for (const file of readdirSync(OUT)) {
    if (/^(device|preview)-\d+\.(png|jpg)$/.test(file)) rmSync(join(OUT, file));
  }

  // 优先用 playwright 自带的 chromium（作者环境；npx playwright@1.49.0 install chromium）；
  // 本机没下载时兜底用系统已装的 Chrome（支持 CHROME_BIN 覆盖路径）
  let browser;
  try {
    browser = await chromium.launch({ args: ["--no-sandbox"] });
  } catch {
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_BIN ||
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ["ai-ledger/v1", JSON.stringify(seed)],
  );
  // 预置一份「上次成功拉取的模型列表」缓存：预览环境没有真后端，
  // listModels 会回退到这份缓存 —— 这样「从 API 拉取」的选择框在截图里也能演示。
  await context.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [
      "ai-ledger/models-cache",
      JSON.stringify({
        "openai-compatible@https://api.deepseek.com": [
          "deepseek-chat",
          "deepseek-reasoner",
          "deepseek-vl2",
          "deepseek-coder",
        ],
      }),
    ],
  );

  const page = await context.newPage();
  page.on("pageerror", (error) => console.warn("  ! 页面报错：", error.message));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  /* 首页 */
  await shoot(page, "home", ".detail-row", 2);

  /* 首页 → 记一笔 */
  await page.click("#fabAdd");
  await page.waitForTimeout(450);
  await page.fill("#qaItem", "午饭");
  await page.fill("#qaAmount", "28");
  await page.waitForTimeout(150);
  await shoot(page, "quick-add", "#qaItem", 1);
  await page.click("#qaCancel");
  await page.waitForTimeout(400);

  /* 首页 → 明细编辑（含删除） */
  const firstRow = await page.$(".detail-row__swipe");
  if (firstRow) {
    await firstRow.click();
    await page.waitForTimeout(450);
    await shoot(page, "edit-record", "#edDelete", 1);
    await page.click("#edCancel");
    await page.waitForTimeout(400);
  }

  /* 对话页 */
  await page.click('.tabbar__item[data-tab="chat"]');
  await page.waitForTimeout(500);
  await shoot(page, "chat", ".chat-row", 4);
  await page.evaluate(() => document.querySelector(".chat-bubble__image")?.scrollIntoView({ behavior: "instant", block: "start" }));
  await page.waitForTimeout(200);
  await shoot(page, "chat-image", ".chat-bubble__image", demoImages.length);

  /* 设置页 */
  await page.click('.tabbar__item[data-tab="settings"]');
  await page.waitForTimeout(500);
  await shoot(page, "settings", "#rowModels", 1);

  /* 账单页：日期区间 + 环形图区间概览 + 逐条明细 */
  await page.click('.tabbar__item[data-tab="bills"]');
  await page.waitForTimeout(600);
  await shoot(page, "bills", ".bills-cat", 2);

  /* 账单页 · 按分类筛选：点一个分类，明细只剩这一类 */
  await page.locator("#billsFilter").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const filterChips = await page.$$("#billsFilter .chip");
  if (filterChips[1]) {
    await filterChips[1].click();
    await page.waitForTimeout(500);
    await shoot(page, "bills-filter", ".bills-record", 1);
    // 取消筛选，回到全部（后面的截图不依赖它，但保持界面干净）
    const resetChips = await page.$$("#billsFilter .chip");
    if (resetChips[0]) await resetChips[0].click();
    await page.waitForTimeout(300);
  }

  /* 回到设置页 → 模型管理 */
  await page.click('.tabbar__item[data-tab="settings"]');
  await page.waitForTimeout(400);

  /* 设置 → 模型管理 */
  await page.click("#rowModels");
  await page.waitForTimeout(500);
  await shoot(page, "model-manager", ".mm-row", 2);

  /* 模型管理 → 某个服务商的模型列表 */
  const actions = await page.$$(".mm-row .mm-row__action");
  if (actions[0]) {
    await actions[0].click();
    await page.waitForTimeout(500);
    await shoot(page, "model-list", ".mm-row", 2);

    /* 从 API 拉取：弹出的选择框（搜索 + 勾选，不再一次性全拉进来）
       预览环境没有真后端，拉不到线上模型；这里直接把「拉回来的候选」喂给
       同一个入口 openFetchPickerWith，截出来的就是真实的那个选择框。 */
    const fetched = await page.evaluate(async () => {
      const mod = await import("/js/models.js");
      const store = await import("/js/store.js");
      const providerId = store.getProviders()[0]?.id;
      if (!providerId || typeof mod.openFetchPickerWith !== "function") return false;
      mod.openFetchPickerWith(
        providerId,
        ["deepseek-chat", "deepseek-reasoner", "deepseek-vl2", "deepseek-coder", "deepseek-r1"],
        () => {},
      );
      return true;
    });
    if (fetched) {
      await page.waitForTimeout(400);
      await page.fill("#fpSearch", "deepseek");
      await page.waitForTimeout(300);
      const fpBoxes = await page.$$("#fpList .mm-check:not([disabled])");
      for (const box of fpBoxes.slice(0, 2)) await box.check().catch(() => {});
      await page.waitForTimeout(300);
      await shoot(page, "model-fetch", "#fpList .mm-row", 1);
      await page.click("#fpCancel").catch(() => {});
      await page.waitForTimeout(400);
    }

    await page.click("#pvCancel").catch(() => {}); // 先关服务商编辑（嵌套弹窗）
    await page.waitForTimeout(400);
  }
  await page.click("#mmClose").catch(() => {}); // 再关模型管理
  await page.waitForTimeout(400);

  /* 回到对话页，现场发一句话看 AI 卡片 */
  await page.click('.tabbar__item[data-tab="chat"]');
  await page.waitForTimeout(400);
  await page.fill("#chatInput", "昨天买电影票 78，地铁 6");
  await page.click("#chatSend");
  await page.waitForTimeout(2200);
  await shoot(page, "chat-card", ".chat-card", 1);

  await browser.close();
  console.log(`\n共 ${shots.length} 张，输出到 docs/screenshots/`);
}

export { seed, demoImages };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
