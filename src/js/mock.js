/**
 * 本地兜底解析器（非 Tauri 环境 / 浏览器预览时使用）
 * 让 UI 在没有 Rust 后端的情况下依然完全可用、可演示、可自动化验证。
 */

import { addDays, dateKey, pad2, round2, today } from "./util.js";

const CATEGORY_KEYWORDS = {
  餐饮: [
    "饭", "菜", "面", "粉", "豆浆", "咖啡", "奶茶", "外卖", "早餐", "午餐", "晚餐", "夜宵",
    "火锅", "烧烤", "水果", "零食", "食堂", "麦当劳", "肯德基", "星巴克", "蜜雪", "吃", "喝",
    "包子", "馒头", "披萨", "汉堡", "寿司", "蛋糕",
  ],
  交通: [
    "打车", "地铁", "公交", "高铁", "火车", "机票", "飞机", "加油", "停车", "滴滴", "出租",
    "单车", "共享", "车费", "油费", "过路费",
  ],
  数码: [
    "鼠标", "键盘", "电脑", "手机", "显示器", "耳机", "充电", "数据线", "u盘", "硬盘",
    "相机", "电池", "音箱", "路由器", "平板", "主机", "显卡",
  ],
  日用: [
    "纸巾", "洗发", "牙膏", "牙刷", "洗衣", "日用", "超市", "卫生纸", "沐浴", "拖把",
    "垃圾袋", "毛巾", "水杯", "锅", "碗", "灯泡", "洗衣液",
  ],
  娱乐: [
    "电影", "游戏", "门票", "ktv", "演唱会", "旅游", "健身", "会员", "按摩", "剧本杀",
    "密室", "演出", "展览", "手办", "充值",
  ],
};

const RELATIVE_DAYS = [
  { words: ["大前天"], delta: -3 },
  { words: ["前天"], delta: -2 },
  { words: ["昨天", "昨日", "昨晚"], delta: -1 },
  { words: ["今天", "今日", "刚才", "刚刚"], delta: 0 },
  { words: ["明天", "明日"], delta: 1 },
];

function detectCategory(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestLength = 0;
  for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
    for (const word of words) {
      if (lower.includes(word) && word.length > bestLength) {
        best = category;
        bestLength = word.length;
      }
    }
  }
  return best;
}

function detectDate(text, base) {
  for (const { words, delta } of RELATIVE_DAYS) {
    if (words.some((word) => text.includes(word))) return addDays(base, delta);
  }
  const monthDay = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  if (monthDay) {
    const date = new Date(base.getFullYear(), Number(monthDay[1]) - 1, Number(monthDay[2]));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const numeric = text.match(/(\d{1,2})[/.\-](\d{1,2})/);
  if (numeric) {
    const date = new Date(base.getFullYear(), Number(numeric[1]) - 1, Number(numeric[2]));
    if (!Number.isNaN(date.getTime())) return date;
  }
  return base;
}

function detectAmount(text) {
  const matches = [...text.matchAll(/(\d+(?:\.\d{1,2})?)/g)].map((match) => Number(match[1]));
  const plausible = matches.filter((value) => value > 0 && value < 1_000_000);
  if (!plausible.length) return null;
  return round2(Math.max(...plausible));
}

function detectItem(text) {
  let item = text;
  for (const { words } of RELATIVE_DAYS) {
    for (const word of words) item = item.replaceAll(word, "");
  }
  item = item
    .replace(/(\d+(?:\.\d{1,2})?)\s*(块钱|块|元|钱|rmb|￥|¥)?/gi, "")
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]?/g, "")
    .replace(/[，,。.、；;！!？?：:\s]+/g, "")
    .replace(/^(我|买|了|花了|花|付|支付|消费|支出|花了钱)+/g, "")
    .replace(/(买|花了|花|付|支付|消费|支出|的)+$/g, "");
  return item || "未命名";
}

/** 把整句拆成多条待记账条目 */
function splitSegments(text) {
  return String(text)
    .split(/[\n;；。]|(?:还有)|(?:另外)|(?:以及)|(?:然后)|(?:，)|(?:,)|(?:、)|(?:和)/g)
    .map((part) => part.trim())
    .filter((part) => part && /\d/.test(part));
}

export function mockParse(text, fallbackDate = today()) {
  const segments = splitSegments(text);
  const source = segments.length ? segments : /\d/.test(text) ? [text.trim()] : [];
  const created = Date.now();
  return source
    .map((segment, index) => {
      const amount = detectAmount(segment);
      if (amount === null) return null;
      const date = detectDate(segment, fallbackDate);
      return {
        id: `mock-${created}-${index}`,
        date: dateKey(date),
        item: detectItem(segment),
        category: detectCategory(segment) ?? "其他",
        amount,
        createdAt: created + index,
      };
    })
    .filter(Boolean);
}

export async function mockTestConnection(settings) {
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (!settings.baseUrl) {
    return { ok: false, message: "请先填写 Base URL" };
  }
  if (!settings.apiKey) {
    return { ok: false, message: "请先填写 API Key" };
  }
  if (!settings.model) {
    return { ok: false, message: "请先填写模型名称" };
  }
  return { ok: true, message: `连接成功 · ${settings.model}`, model: settings.model };
}

export const __testing = { detectAmount, detectCategory, detectDate, detectItem, splitSegments, pad2 };
