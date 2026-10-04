/**
 * 每个视图独立的外观配置（主题色 / 玻璃效果 / 圆角 / 密度）
 *
 * 设计目标：每个 UI（首页、设置页、弹窗、底部输入条）都能单独调整、单独预览、
 * 单独重置，改一个不影响其他视图。
 *
 * 实现方式：把每个视图的配置编译成一条作用域 CSS 规则注入 <style>，
 * 只覆盖该视图的 CSS 变量 —— 不动 tokens.css 里的全局设计变量。
 */

/* ---------------- 可选项 ---------------- */

export const ACCENT_OPTIONS = [
  { value: "#00C2FF", label: "晴空蓝" },
  { value: "#3B82F6", label: "经典蓝" },
  { value: "#14B8A6", label: "青瓷绿" },
  { value: "#22C55E", label: "草木绿" },
  { value: "#A855F7", label: "梦幻紫" },
  { value: "#F472B6", label: "樱粉" },
  { value: "#FB923C", label: "暖橙" },
  { value: "#64748B", label: "石墨灰" },
];

export const GLASS_OPTIONS = [
  { value: "off", label: "关闭", desc: "完全实色，最高可读性" },
  { value: "light", label: "微透", desc: "轻微磨砂，几乎不牺牲可读性" },
  { value: "medium", label: "标准", desc: "推荐的玻璃质感" },
  { value: "strong", label: "通透", desc: "更强的透视与模糊" },
];

export const RADIUS_OPTIONS = [
  { value: "sharp", label: "直角", desc: "小圆角，工具感更强" },
  { value: "soft", label: "柔和", desc: "默认圆角" },
  { value: "round", label: "圆润", desc: "大圆角，气泡感更强" },
];

export const DENSITY_OPTIONS = [
  { value: "compact", label: "紧凑", desc: "信息更密集，一屏看更多" },
  { value: "cozy", label: "标准", desc: "默认间距" },
  { value: "roomy", label: "宽松", desc: "留白更多，更透气" },
];

const ACCENTS = new Set(ACCENT_OPTIONS.map((option) => option.value));
const GLASSES = new Set(GLASS_OPTIONS.map((option) => option.value));
const RADII = new Set(RADIUS_OPTIONS.map((option) => option.value));
const DENSITIES = new Set(DENSITY_OPTIONS.map((option) => option.value));

/* ---------------- 视图定义 ---------------- */

/** 每个视图的默认外观 + 展示名 + 说明 */
export const VIEWS = {
  home: {
    label: "首页",
    desc: "日历、月进度与明细列表",
    defaults: { accent: "#00C2FF", glass: "medium", radius: "soft", density: "cozy" },
  },
  settings: {
    label: "设置页",
    desc: "API 配置与偏好分组",
    defaults: { accent: "#3B82F6", glass: "medium", radius: "soft", density: "cozy" },
  },
  sheet: {
    label: "弹窗与弹层",
    desc: "确认入账、模态弹窗、底部半屏",
    defaults: { accent: "#00C2FF", glass: "medium", radius: "round", density: "cozy" },
  },
  composer: {
    label: "底部输入条",
    desc: "文本/语音记账输入条与语音波纹",
    defaults: { accent: "#00C2FF", glass: "strong", radius: "round", density: "cozy" },
  },
};

export const VIEW_KEYS = Object.keys(VIEWS);

/** 默认外观配置（供 store 初始化使用） */
export function DEFAULT_APPEARANCE() {
  const result = {};
  for (const key of VIEW_KEYS) result[key] = { ...VIEWS[key].defaults };
  return result;
}

/** 容错：外部数据（localStorage / 导入）只保留合法字段，不修改调用方传入的对象 */
export function sanitizeAppearance(raw) {
  const result = {};
  for (const key of VIEW_KEYS) {
    const defaults = VIEWS[key].defaults;
    const source = raw && typeof raw === "object" ? raw[key] : null;
    const target = { ...defaults };
    if (source && typeof source === "object") {
      if (typeof source.accent === "string" && ACCENTS.has(source.accent.toUpperCase())) {
        target.accent = source.accent.toUpperCase();
      }
      if (GLASSES.has(source.glass)) target.glass = source.glass;
      if (RADII.has(source.radius)) target.radius = source.radius;
      if (DENSITIES.has(source.density)) target.density = source.density;
    }
    result[key] = target;
  }
  return result;
}

/* ---------------- 变量编译 ---------------- */

const GLASS_TOKENS = {
  off: { alpha: 1, blur: 0, sat: 1, border: 1, shadow: 0.12 },
  light: { alpha: 0.94, blur: 8, sat: 1.1, border: 1, shadow: 0.14 },
  medium: { alpha: 0.86, blur: 16, sat: 1.3, border: 1, shadow: 0.16 },
  strong: { alpha: 0.72, blur: 26, sat: 1.6, border: 1, shadow: 0.2 },
};

/**
 * 当前 WebView 是否真的能模糊背景。
 *
 * 老 WebView（Chrome < 76 或没开 -webkit- 前缀）不支持 backdrop-filter：模糊整体失效，
 * 只剩下「半透明背景」——面板会变成底下的字透上来的糊成一片，比不用玻璃还难看。
 * 检测不到模糊能力时把玻璃退化成不透明实色面板（配色 / 圆角 / 密度都不受影响）。
 */
export function supportsGlassBlur() {
  const css = globalThis.CSS;
  // 判断不了就按「支持」处理，别去改变默认观感
  if (!css || typeof css.supports !== "function") return true;
  return (
    css.supports("backdrop-filter", "blur(1px)") ||
    css.supports("-webkit-backdrop-filter", "blur(1px)")
  );
}

const RADIUS_TOKENS = {
  sharp: {
    "--radius-xs": "2px",
    "--radius-sm": "4px",
    "--radius-md": "6px",
    "--radius-lg": "8px",
    "--radius-xl": "10px",
    "--radius-2xl": "12px",
    "--radius-3xl": "16px",
  },
  soft: {
    "--radius-xs": "4px",
    "--radius-sm": "8px",
    "--radius-md": "12px",
    "--radius-lg": "16px",
    "--radius-xl": "20px",
    "--radius-2xl": "24px",
    "--radius-3xl": "32px",
  },
  round: {
    "--radius-xs": "6px",
    "--radius-sm": "12px",
    "--radius-md": "16px",
    "--radius-lg": "22px",
    "--radius-xl": "28px",
    "--radius-2xl": "34px",
    "--radius-3xl": "40px",
  },
};

const DENSITY_TOKENS = {
  compact: {
    "--density-gap": "0.5rem",
    "--density-pad": "0.75rem",
    "--density-cell": "2.25rem",
    "--density-lh": "1.4",
  },
  cozy: {
    "--density-gap": "0.75rem",
    "--density-pad": "1rem",
    "--density-cell": "2.6rem",
    "--density-lh": "1.5",
  },
  roomy: {
    "--density-gap": "1rem",
    "--density-pad": "1.25rem",
    "--density-cell": "2.95rem",
    "--density-lh": "1.6",
  },
};

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return { r: 0, g: 194, b: 255 };
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

/** 与 --text-primary 同族的墨色：浅主题色上写它，深主题色上写白 */
const INK = "#0B1220";
const WHITE = "#FFFFFF";
/**
 * 正文级 WCAG AA 对比度。留 3% 余量，避免算出来刚好 4.50 被取整或合成后掉到线下。
 * 所有颜色换算都自己实现而不用 CSS 的 color-mix()：Android WebView 的内核版本
 * 不一定支持，一旦不支持整条变量会失效，按钮文字会直接掉回默认色。
 */
const BODY_RATIO = 4.5;
const SAFE_RATIO = BODY_RATIO * 1.03;

/** 两个十六进制色按 t 线性混合（t=0 取 a，t=1 取 b） */
function mixHex(a, b, t) {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  const channel = (x, y) =>
    Math.max(0, Math.min(255, Math.round(x + (y - x) * t)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(from.r, to.r)}${channel(from.g, to.g)}${channel(from.b, to.b)}`;
}

/** WCAG 相对亮度 */
function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度 */
function contrast(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 把 color 沿「更亮 / 更暗」方向推进，直到与 against 的对比度刚好达标。
 * 用二分而不是固定的压暗比例：同一个比例压在亮色（#00C2FF）和暗色（#64748B）上
 * 效果差很多，固定比例必然有一部分主题色不达标。
 */
function fitContrast(color, against, target, lighter) {
  const toward = lighter ? WHITE : "#000000";
  let low = 0;
  let high = 1;
  let best = color;
  for (let i = 0; i < 30; i += 1) {
    const t = (low + high) / 2;
    const candidate = mixHex(color, toward, t);
    if (contrast(candidate, against) >= target) {
      best = candidate;
      high = t;
    } else {
      low = t;
    }
  }
  return best;
}

/**
 * 一个主题色编译出按钮底色对、其上的文字色、以及浅色底上的墨色。
 * 主题色是用户自选的（8 选 1），亮暗跨度很大，所以文字色按亮度自动在
 * 「白字 / 墨字」之间选，底色再按选中的文字色反推到达标为止。
 */
function accentTokens(accent) {
  const useWhite = contrast(WHITE, accent) >= contrast(INK, accent);
  const onAccent = useWhite ? WHITE : INK;
  const surface = fitContrast(accent, onAccent, SAFE_RATIO, !useWhite);
  return {
    onAccent,
    surface,
    // 渐变第二站：白字底更深、墨字底更浅，两端都朝各自安全的方向走
    surfaceDeep: mixHex(surface, useWhite ? "#000000" : WHITE, 0.26),
    // rgba(accent, .14) 叠在白玻璃上的实际颜色。ink 要在这个最难的浅底上达标，
    // 那么它在纯白玻璃底上（更亮）必然更宽松。
    ink: fitContrast(accent, mixHex(accent, WHITE, 0.86), SAFE_RATIO, false),
  };
}

/** 把一个视图的配置编译成 CSS 变量声明块 */
function declarationsFor(config) {
  const accent = ACCENTS.has(String(config.accent).toUpperCase())
    ? String(config.accent).toUpperCase()
    : VIEWS.home.defaults.accent;
  const { r, g, b } = hexToRgb(accent);
  const tone = accentTokens(accent);
  const glass = GLASS_TOKENS[config.glass] ?? GLASS_TOKENS.medium;
  // 不支持背景模糊时：alpha 顶到 1、模糊归零，玻璃变成不透明实色面板（见 supportsGlassBlur）
  const canBlur = supportsGlassBlur();
  const alpha = canBlur ? glass.alpha : 1;
  const blur = canBlur ? glass.blur : 0;
  const radius = RADIUS_TOKENS[config.radius] ?? RADIUS_TOKENS.soft;
  const density = DENSITY_TOKENS[config.density] ?? DENSITY_TOKENS.cozy;

  const lines = [
    `--app-accent: ${accent};`,
    `--app-accent-rgb: ${r} ${g} ${b};`,
    `--app-accent-soft: rgba(${r}, ${g}, ${b}, 0.14);`,
    `--app-accent-softer: rgba(${r}, ${g}, ${b}, 0.07);`,
    // 实心色块（fly-chip 飞入角标）用达标后的底色，且不透明：
    // 半透明会让底色被浅色背景拉亮，白字/墨字的对比度就守不住了。
    `--app-accent-strong: ${tone.surface};`,
    `--app-accent-btn: ${tone.surface};`,
    `--app-accent-btn-2: ${tone.surfaceDeep};`,
    `--app-on-accent: ${tone.onAccent};`,
    `--app-accent-ink: ${tone.ink};`,
    `--glass-alpha: ${(alpha * 100).toFixed(0)}%;`,
    `--glass-alpha-strong: ${(Math.min(1, alpha + 0.12) * 100).toFixed(0)}%;`,
    `--glass-blur: ${blur}px;`,
    `--glass-blur-strong: ${Math.round(blur * 1.6)}px;`,
    `--glass-saturate: ${glass.sat};`,
    `--glass-border-color: rgba(255, 255, 255, ${glass.border ? 0.55 : 0});`,
    `--glass-hairline: rgba(${r}, ${g}, ${b}, 0.16);`,
    `--glass-shadow: ${glass.shadow};`,
  ];
  for (const [name, value] of Object.entries(radius)) lines.push(`${name}: ${value};`);
  for (const [name, value] of Object.entries(density)) lines.push(`${name}: ${value};`);
  return lines.join("\n  ");
}

/** 每个视图的 CSS 作用域：每个界面各自独立，互不影响 */
const SCOPE_SELECTORS = {
  home: '#app .page[data-page="home"]',
  settings: '#app .page[data-page="settings"]',
  sheet: ".backdrop, .sheet, .modal-root",
  composer: "#app .dock, #app .voice-wave",
};

const STYLE_ID = "app-appearance-vars";

/** 把外观配置注入 DOM（幂等：重复调用只更新同一个 <style>） */
export function applyAppearance(appearance) {
  const head = document.head;
  if (!head) return;
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    head.append(style);
  }
  const blocks = [];
  for (const key of VIEW_KEYS) {
    const config = appearance?.[key] ?? VIEWS[key].defaults;
    blocks.push(`/* ${VIEWS[key].label} */\n${SCOPE_SELECTORS[key]} {\n  ${declarationsFor(config)}\n}`);
  }
  style.textContent = blocks.join("\n\n");
}

/** 供 UI 显示当前摘要，例如「标准 · 柔和 · 晴空蓝」 */
export function describeAppearance(config) {
  const glass = GLASS_OPTIONS.find((option) => option.value === config?.glass);
  const radius = RADIUS_OPTIONS.find((option) => option.value === config?.radius);
  const density = DENSITY_OPTIONS.find((option) => option.value === config?.density);
  const accent = ACCENT_OPTIONS.find(
    (option) => option.value === String(config?.accent ?? "").toUpperCase(),
  );
  return [glass?.label, radius?.label, density?.label, accent?.label].filter(Boolean).join(" · ");
}
