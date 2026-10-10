#!/usr/bin/env node
/**
 * Rust 侧的「调用参数个数」静态检查
 *
 * 本机缺 mingw gcc，cargo check 编不过 ring，改完 Rust 只能靠 CI 兜底；
 * 而改动里最容易犯、CI 又要等十几分钟才暴露的错误就是「函数加了参数，旧调用点没跟上」。
 * 这里用轻量解析把 lib.rs 里自己定义的函数和调用点对齐一遍，几毫秒出结果。
 *
 * 用法：node scripts/check-rust-calls.mjs [--self-test]
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(HERE, "..", "src-tauri", "src");

/* ---------- 去掉注释与字面量：括号/逗号只按代码结构算 ---------- */
function stripLiterals(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "r" && next === "#") {
      i += 2;
      while (i < source.length && !(source[i] === '"' && source[i + 1] === "#")) i += 1;
      i += 2;
      out += '""';
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    if (c === "'") {
      const n1 = source[i + 1];
      const n2 = source[i + 2];
      // 生命周期：&'a str（后面紧跟标识符而不是另一个引号）
      if (n1 && /[A-Za-z_]/.test(n1) && n2 !== "'") {
        out += `'${n1}`;
        i += 2;
        continue;
      }
      i += 1;
      out += "''";
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/** 找到 open 括号对应的 close 括号下标，返回 -1 表示不闭合 */
function matchParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按「深度 0 的逗号」切分，空内容算 0 项 */
function splitArgs(inner) {
  const body = inner.trim();
  if (!body) return [];
  const parts = [];
  let depth = 0;
  let current = "";
  for (const c of body) {
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** 解析出 { name -> [arity...] } 与所有调用点 { name, arity, line } */
function parse(source) {
  const text = stripLiterals(source);
  const defs = new Map();
  const defCallSites = new Set();

  for (const match of text.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) continue;
    const params = splitArgs(text.slice(open + 1, close)).filter(
      (part) => part.trim() && !/^&?self$/.test(part.trim()),
    );
    const name = match[1];
    defs.set(name, [...(defs.get(name) ?? []), params.length]);
    defCallSites.add(open);
  }

  const calls = [];
  for (const match of text.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    if (defCallSites.has(open)) continue; // 这是函数定义本身
    const before = text.slice(0, match.index).trimEnd();
    if (before.endsWith(".") || before.endsWith("::") || before.endsWith("fn")) continue; // 方法调用 / 限定路径
    const close = matchParen(text, open);
    if (close === -1) continue;
    const name = match[1];
    if (!defs.has(name)) continue; // 不是本文件定义的函数（标准库 / 宏 / 类型构造）
    calls.push({
      name,
      arity: splitArgs(text.slice(open + 1, close)).length,
      line: text.slice(0, match.index).split("\n").length,
    });
  }

  return { defs, calls };
}

function checkFile(file) {
  const source = readFileSync(file, "utf8");
  const { defs, calls } = parse(source);
  const problems = [];
  for (const call of calls) {
    const arities = [...new Set(defs.get(call.name) ?? [])];
    if (arities.length !== 1) continue; // 同名重载：不猜
    if (arities[0] === call.arity) continue;
    problems.push(`${file}:${call.line} ${call.name}() 传了 ${call.arity} 个参数，定义是 ${arities[0]} 个`);
  }
  return { problems, functions: defs.size, calls: calls.length };
}

function main() {
  const files = readdirSync(SRC_DIR)
    .filter((name) => name.endsWith(".rs"))
    .map((name) => join(SRC_DIR, name));
  if (!files.length) {
    console.error(`没有找到 Rust 源文件：${SRC_DIR}`);
    process.exit(1);
  }

  let functions = 0;
  let calls = 0;
  const problems = [];
  for (const file of files) {
    const result = checkFile(file);
    functions += result.functions;
    calls += result.calls;
    problems.push(...result.problems);
  }

  if (problems.length) {
    console.error("Rust 调用参数个数对不上：");
    for (const line of problems) console.error(`  ✗ ${line}`);
    process.exit(1);
  }
  console.log(`  ✓ Rust 调用参数自洽：${functions} 个函数 / ${calls} 处调用全部对齐`);

  checkAuthHeaderByProtocol(files);
}

/**
 * 鉴权头必须按协议区分。
 *
 * 拿真实事故换来的检查：`list_models` 曾经不管什么协议都发 `Authorization: Bearer`，
 * 于是选「Claude 原生」的服务商（MiniMax /anthropic 等）**永远拉不到模型** ——
 * 它们只认 `x-api-key`。而正常对话是分协议的，表现为「能聊天、却拉不出模型」，
 * 很难往"拉模型的鉴权头写漏了"上想。
 *
 * 这里做的是「成对出现」检查：凡是发请求的函数，只要出现了 `Bearer`，
 * 同一函数体内就必须同时出现 `x-api-key`（说明它按协议分过支）。
 */
function checkAuthHeaderByProtocol(files) {
  const problems = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // 以「函数定义」为界粗切；只关心带 http 请求的那几段
    for (const block of splitIntoFunctions(source)) {
      const hasBearer = /"Authorization"|Authorization:/.test(block.body);
      const hasXApiKey = /x-api-key/.test(block.body);
      if (hasBearer && !hasXApiKey) {
        problems.push(`${file} ${block.name}()：发的是 Bearer，但没有按协议改用 x-api-key`);
      }
    }
  }
  if (problems.length) {
    console.error("鉴权头没有按协议区分（Claude 原生会拉不到模型 / 请求 401）：");
    for (const line of problems) console.error(`  ✗ ${line}`);
    process.exit(1);
  }
  console.log("  ✓ 鉴权头按协议区分：发 Bearer 的地方都同时处理了 x-api-key");
}

/** 把源码粗切成 { name, body } 的函数块，够用于「同一函数体内成对出现」的判断 */
function splitIntoFunctions(source) {
  const out = [];
  // 匹配 `fn 名字(...)  ...  {` 起始，然后靠花括号配平取整块
  const re = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/g;
  let match;
  while ((match = re.exec(source))) {
    const braceStart = source.indexOf("{", match.index);
    if (braceStart === -1) continue;
    let depth = 0;
    let end = braceStart;
    for (let i = braceStart; i < source.length; i += 1) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ name: match[1], body: source.slice(match.index, end + 1) });
  }
  return out;
}

/* ---------- 自检：故意漏一个参数，必须被抓出来 ---------- */
if (process.argv.includes("--self-test")) {
  const sample = `
struct ImageInput { mime: String }
async fn request_model(a: &str, b: &str, image: Option<&ImageInput>) -> Result<String, String> {
    Ok(format!("{}{}", a, b))
}
async fn caller() {
    let _ = request_model("x", "y").await;
}
`;
  const { defs, calls } = parse(sample);
  const ok1 = (defs.get("request_model") ?? []).join() === "3";
  const ok2 = calls.length === 1 && calls[0].arity === 2 && calls[0].name === "request_model";
  const fixed = parse(sample.replace('request_model("x", "y")', 'request_model("x", "y", None)'));
  const ok3 = fixed.calls[0].arity === 3;

  // 鉴权头检查的自检：只发 Bearer 的要判为问题，加了 x-api-key 的才算过
  const badAuth = splitIntoFunctions(`
async fn list_models() {
    http.get(&url).header("Authorization", format!("Bearer {}", key)).send().await
}
`);
  const goodAuth = splitIntoFunctions(`
async fn list_models(protocol: &str) {
    if protocol == "claude" { http.get(&url).header("x-api-key", key) }
    else { http.get(&url).header("Authorization", format!("Bearer {}", key)) }
}
`);
  const looksBad = (blocks) =>
    blocks.some((b) => /"Authorization"|Authorization:/.test(b.body) && !/x-api-key/.test(b.body));
  const ok4 = looksBad(badAuth) === true;
  const ok5 = looksBad(goodAuth) === false;

  if (!ok1 || !ok2 || !ok3 || !ok4 || !ok5) {
    console.error(`  ✗ 自检失败：${JSON.stringify({ ok1, ok2, ok3, ok4, ok5 })}`);
    process.exit(1);
  }
  console.log("  ✓ check-rust-calls 自检通过（漏传参数 / 鉴权头漏协议都会被抓出来）");
} else {
  main();
}
