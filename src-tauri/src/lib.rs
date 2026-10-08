use std::time::Duration;

use chrono::{Datelike, Local, NaiveDate};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::command;

/// 一条记账记录（字段与前端 `src/js/store.js` 的记录结构对齐）
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Expense {
    pub date: String,
    pub item: String,
    pub category: String,
    pub amount: f64,
}

/// 测试连接的返回体
#[derive(Serialize, Debug, Clone)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub model: String,
}

/// 模型列表接口返回体
#[derive(Serialize, Debug, Clone)]
pub struct ModelsResult {
    pub ok: bool,
    pub message: String,
    pub models: Vec<String>,
}

/// 意图识别结果：add=记账 / del=删除 / query=查询 / none=无关闲聊
#[derive(Serialize, Debug, Clone)]
pub struct IntentResult {
    pub op: String,
    pub items: Vec<Expense>,
    pub ids: Vec<usize>,
    pub reply: String,
}

const DEFAULT_CLAUDE_URL: &str = "https://api.anthropic.com";
const DEFAULT_OPENAI_URL: &str = "https://api.openai.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 768;

/* ==========================================================================
   协议适配
   ========================================================================== */

fn normalize_protocol(protocol: &str) -> &'static str {
    match protocol.trim().to_lowercase().as_str() {
        "claude" | "anthropic" => "claude",
        "openai" => "openai",
        _ => "openai-compatible",
    }
}

fn default_base_url(protocol: &str) -> &'static str {
    match protocol {
        "claude" => DEFAULT_CLAUDE_URL,
        "openai" => DEFAULT_OPENAI_URL,
        _ => DEFAULT_OPENAI_URL,
    }
}

/// 形如 /v1、/api/paas/v4、/api/v3 这种「已经带版本号」的地址：后面只拼资源名即可
/// （各家前缀不统一 —— 智谱 v4、方舟 v3、混元 v1 —— 统一补 /v1 会拼出错误地址）
fn has_version_segment(base: &str) -> bool {
    let last = base.rsplit('/').next().unwrap_or_default();
    let body = last.strip_prefix('v').unwrap_or(last);
    !body.is_empty() && body.chars().next().is_some_and(|c| c.is_ascii_digit())
}

/// 剥掉已经写全的资源名，避免在 .../chat/completions 后面再拼一段
fn strip_resource(base: &str) -> String {
    for suffix in ["/chat/completions", "/messages", "/models"] {
        if let Some(rest) = base.strip_suffix(suffix) {
            return rest.trim_end_matches('/').to_string();
        }
    }
    base.to_string()
}

/// 把用户填写的 Base URL（或完整地址）补全成真正的请求地址
fn endpoint(protocol: &str, base_url: &str) -> String {
    let raw = base_url.trim().trim_end_matches('/');
    let base = if raw.is_empty() {
        default_base_url(protocol).to_string()
    } else {
        raw.to_string()
    };

    if protocol == "claude" {
        if base.ends_with("/v1/messages") || base.ends_with("/messages") {
            base
        } else if has_version_segment(&base) {
            format!("{}/messages", base)
        } else {
            format!("{}/v1/messages", base)
        }
    } else if base.ends_with("/chat/completions") {
        base
    } else if has_version_segment(&base) {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    }
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("初始化网络客户端失败: {}", e))
}

/// 发送请求并提取模型返回的纯文本
async fn request_model(
    protocol: &str,
    base_url: &str,
    api_key: &str,
    api_model: &str,
    system_prompt: &str,
    user_text: &str,
    image: Option<&ImageInput>,
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("请先在设置页填写 API Key".into());
    }
    if api_model.trim().is_empty() {
        return Err("请先在设置页拉取并选择模型".into());
    }

    let url = endpoint(protocol, base_url);
    let http = client()?;

    // 带图时 content 变成「文字 + 图片」的数组，两种协议写法不同
    let content = match image {
        None => json!(user_text),
        Some(img) => {
            if protocol == "claude" {
                json!([
                    {"type": "text", "text": user_text},
                    {"type": "image", "source": {
                        "type": "base64",
                        "media_type": img.mime,
                        "data": img.data
                    }}
                ])
            } else {
                json!([
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {
                        "url": format!("data:{};base64,{}", img.mime, img.data)
                    }}
                ])
            }
        }
    };

    let request = if protocol == "claude" {
        http.post(&url)
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&json!({
                "model": api_model.trim(),
                "max_tokens": MAX_TOKENS,
                "system": system_prompt,
                "messages": [{"role": "user", "content": content}],
                "temperature": 0.0
            }))
    } else {
        http.post(&url)
            .header("Authorization", format!("Bearer {}", api_key.trim()))
            .json(&json!({
                "model": api_model.trim(),
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": content}
                ],
                "temperature": 0.0
            }))
    };

    let response = request
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("响应不是合法 JSON（HTTP {}）: {}", status, e))?;

    if !status.is_success() {
        return Err(format!(
            "接口返回 HTTP {}：{}",
            status,
            error_message(&body)
        ));
    }

    if protocol == "claude" {
        // {"content":[{"type":"text","text":"..."}]}
        if let Some(text) = body["content"]
            .as_array()
            .and_then(|items| items.iter().find_map(|item| item["text"].as_str()))
        {
            return Ok(text.to_string());
        }
        if let Some(text) = body["completion"].as_str() {
            return Ok(text.to_string());
        }
    } else {
        if let Some(text) = body["choices"][0]["message"]["content"].as_str() {
            return Ok(text.to_string());
        }
        if let Some(text) = body["choices"][0]["text"].as_str() {
            return Ok(text.to_string());
        }
    }

    Err(format!("无法从返回内容中提取文本：{}", truncate(&body.to_string(), 400)))
}

fn error_message(body: &Value) -> String {
    let candidate = &body["error"]["message"];
    if let Some(text) = candidate.as_str() {
        return truncate(text, 300);
    }
    if let Some(text) = body["message"].as_str() {
        return truncate(text, 300);
    }
    truncate(&body.to_string(), 300)
}

fn truncate(text: &str, limit: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(limit).collect();
    format!("{}…", cut)
}

/* ==========================================================================
   归一化
   ========================================================================== */

fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// 把模型给出的日期统一成 YYYY-MM-DD，无法识别时退回 fallback
fn normalize_date(raw: &str, fallback: &str) -> String {
    let text = raw.trim();
    if text.is_empty() {
        return fallback.to_string();
    }

    let cleaned = text
        .replace('年', "-")
        .replace('月', "-")
        .replace("日", "")
        .replace('/', "-")
        .replace('.', "-")
        .trim_end_matches('-')
        .to_string();

    if let Ok(date) = NaiveDate::parse_from_str(&cleaned, "%Y-%m-%d") {
        return date.format("%Y-%m-%d").to_string();
    }

    // "10-3" / "3" 这类缺年份的写法，按今年补全
    let parts: Vec<&str> = cleaned.split('-').filter(|s| !s.is_empty()).collect();
    if parts.len() == 2 {
        if let (Ok(month), Ok(day)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
            return compose_date(today().year(), month, day, fallback);
        }
    }
    if let Ok(day) = cleaned.parse::<u32>() {
        let now = today();
        return compose_date(now.year(), now.month(), day, fallback);
    }

    fallback.to_string()
}

fn compose_date(year: i32, month: u32, day: u32, fallback: &str) -> String {
    match NaiveDate::from_ymd_opt(year, month, day) {
        Some(date) => date.format("%Y-%m-%d").to_string(),
        None => fallback.to_string(),
    }
}

/// 分类必须在用户配置的分类表里，否则落到「其他」
fn normalize_category(raw: &str, categories: &[String]) -> String {
    let text = raw.trim();
    let fallback = categories
        .iter()
        .find(|name| name.as_str() == "其他")
        .or_else(|| categories.last())
        .cloned()
        .unwrap_or_else(|| "其他".to_string());

    if text.is_empty() || categories.is_empty() {
        return fallback;
    }
    if let Some(hit) = categories.iter().find(|name| name.as_str() == text) {
        return hit.clone();
    }
    if let Some(hit) = categories
        .iter()
        .find(|name| !name.is_empty() && (text.contains(name.as_str()) || name.contains(text)))
    {
        return hit.clone();
    }
    fallback
}

fn normalize_item(raw: &str) -> String {
    let text = raw.trim().trim_matches(|c: char| c == '"' || c == '\'').trim();
    if text.is_empty() {
        "未命名".to_string()
    } else {
        truncate(text, 40)
    }
}

fn parse_amount(value: &Value) -> f64 {
    if let Some(number) = value.as_f64() {
        return number.abs();
    }
    if let Some(text) = value.as_str() {
        let cleaned: String = text
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == '.' || *c == '-')
            .collect();
        if let Ok(number) = cleaned.parse::<f64>() {
            return number.abs();
        }
    }
    0.0
}

fn first_string(value: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|item| item.as_str()) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

/// 从模型输出里抠出 JSON 数组（容忍 ```json 代码块与前后废话）
fn extract_array(content: &str) -> Result<Vec<Value>, String> {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(cleaned) {
        return Ok(items);
    }
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(cleaned) {
        for key in ["records", "data", "items", "list", "expenses"] {
            if let Some(Value::Array(items)) = map.get(key) {
                return Ok(items.clone());
            }
        }
    }

    let start = cleaned.find('[');
    let end = cleaned.rfind(']');
    if let (Some(start), Some(end)) = (start, end) {
        if start < end {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&cleaned[start..=end]) {
                return Ok(items);
            }
        }
    }

    Err(format!(
        "大模型返回的内容不是合法的 JSON 数组：{}",
        truncate(cleaned, 300)
    ))
}

/// 从模型输出里抠出 JSON 对象（容忍 ```json 代码块与前后废话）
fn extract_object(content: &str) -> Result<Value, String> {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Ok(object @ Value::Object(_)) = serde_json::from_str::<Value>(cleaned) {
        return Ok(object);
    }

    let start = cleaned.find('{');
    let end = cleaned.rfind('}');
    if let (Some(start), Some(end)) = (start, end) {
        if start < end {
            if let Ok(object @ Value::Object(_)) = serde_json::from_str::<Value>(&cleaned[start..=end]) {
                return Ok(object);
            }
        }
    }

    Err(format!(
        "大模型返回的内容不是合法的 JSON 对象：{}",
        truncate(cleaned, 300)
    ))
}

/* ==========================================================================
   命令
   ========================================================================== */

#[command]
async fn process_accounting(
    text: String,
    protocol: String,
    base_url: String,
    api_key: String,
    api_model: String,
    categories: Option<Vec<String>>,
) -> Result<Vec<Expense>, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("请先说点什么，比如「昨天买鼠标 120」".into());
    }

    let protocol = normalize_protocol(&protocol);
    let categories: Vec<String> = categories
        .unwrap_or_default()
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    let today = today().format("%Y-%m-%d").to_string();

    let category_hint = if categories.is_empty() {
        "餐饮、交通、数码、日用、娱乐、其他".to_string()
    } else {
        categories.join("、")
    };

    let system_prompt = format!(
        "你是一个中文记账助手。从用户的自然语言里提取每一笔支出，只输出 JSON 数组，不要输出任何解释、Markdown 代码块或多余字符。\n\
         数组每个元素形如：{{\"date\":\"YYYY-MM-DD\",\"item\":\"物品\",\"category\":\"分类\",\"amount\":12.5}}\n\
         要求：\n\
         1. 今天是 {today}，相对时间（今天/昨天/前天/上周五等）必须换算成 YYYY-MM-DD；未提到时间时用今天 {today}。\n\
         2. category 只能从这些分类里选：{category_hint}。拿不准就用「其他」。\n\
         3. amount 是数字（单位元），不要带货币符号。\n\
         4. item 是简短的物品或消费名目，去掉数量与价格。\n\
         5. 一句话里有多笔消费就输出多条。",
        today = today,
        category_hint = category_hint
    );

    let content = request_model(
        protocol,
        &base_url,
        &api_key,
        &api_model,
        &system_prompt,
        trimmed,
    )
    .await?;

    let items = extract_array(&content)?;

    let mut records = Vec::new();
    for item in items {
        let amount = parse_amount(&item.get("amount").cloned().unwrap_or(Value::Null));
        if amount <= 0.0 {
            continue;
        }
        let raw_date = first_string(&item, &["date", "time", "day"]);
        let raw_category = first_string(&item, &["category", "categoryName", "type", "tag"]);
        let raw_item = first_string(&item, &["item", "name", "title", "desc", "description"]);

        records.push(Expense {
            date: normalize_date(&raw_date, &today),
            item: normalize_item(&raw_item),
            category: normalize_category(&raw_category, &categories),
            amount: (amount * 100.0).round() / 100.0,
        });
    }

    if records.is_empty() {
        return Err("没有解析出有效的支出记录，换个说法再试试".into());
    }

    Ok(records)
}

/// 可选图片输入：mime + base64 正文（允许调用方直接传 data URL）
struct ImageInput {
    mime: String,
    data: String,
}

fn clean_categories(raw: Option<Vec<String>>) -> Vec<String> {
    raw.unwrap_or_default()
        .into_iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

fn intent_prompt(today: &str, categories: &[String], ledger: &str) -> String {
    let category_hint = if categories.is_empty() {
        "餐饮、交通、数码、日用、娱乐、其他".to_string()
    } else {
        categories.join("、")
    };
    let ledger_text = ledger
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .take(100)
        .collect::<Vec<_>>()
        .join("\n");
    let ledger_block = if ledger_text.is_empty() {
        "（暂无账目）".to_string()
    } else {
        ledger_text
    };

    format!(
        "你是记账助手，管理用户的支出账本。今天是 {today}。\n\
         用户分类：{category_hint}\n\
         账本（每行=序号|日期|物品|分类|金额，最新在前）：\n\
         {ledger_block}\n\
         根据用户这句话判断意图，只输出一个 JSON 对象，禁止任何解释、Markdown 或多余字符：\n\
         - 记账/新增支出：{{\"op\":\"add\",\"items\":[{{\"date\":\"YYYY-MM-DD\",\"item\":\"物品\",\"category\":\"分类\",\"amount\":12.5}}]}}\n\
         - 删除账目：{{\"op\":\"del\",\"ids\":[账本序号]}}\n\
         - 查询/统计：{{\"op\":\"query\",\"ids\":[涉及行的序号],\"reply\":\"一句话答复，金额留给本地计算\"}}\n\
         - 与记账无关的闲聊：{{\"op\":\"none\",\"reply\":\"一句话简短答复\"}}\n\
         规则：相对日期（今天/昨天/前天/上周五等）换算为 YYYY-MM-DD，未提日期默认今天；\n\
         amount 是数字不带符号；一句话含多笔支出输出多条；ids 只能取账本里已有的序号；\n\
         category 只能从用户分类里选，拿不准用「其他」。"
    )
}

fn parse_intent_content(
    content: &str,
    categories: &[String],
    today: &str,
) -> Result<IntentResult, String> {
    let intent = extract_object(&content)?;
    let op = intent
        .get("op")
        .and_then(|value| value.as_str())
        .unwrap_or("none")
        .trim()
        .to_lowercase();
    let reply = intent
        .get("reply")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let ids: Vec<usize> = intent
        .get("ids")
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|value| value.as_u64().map(|id| id as usize))
                .filter(|id| *id >= 1)
                .collect()
        })
        .unwrap_or_default();

    let mut items = Vec::new();
    if op == "add" {
        if let Some(list) = intent.get("items").and_then(|value| value.as_array()) {
            for item in list {
                let amount = parse_amount(&item.get("amount").cloned().unwrap_or(Value::Null));
                if amount <= 0.0 {
                    continue;
                }
                let raw_date = first_string(item, &["date", "time", "day"]);
                let raw_category = first_string(item, &["category", "categoryName", "type", "tag"]);
                let raw_item = first_string(item, &["item", "name", "title", "desc", "description"]);
                items.push(Expense {
                    date: normalize_date(&raw_date, today),
                    item: normalize_item(&raw_item),
                    category: normalize_category(&raw_category, categories),
                    amount: (amount * 100.0).round() / 100.0,
                });
            }
        }
    }

    let op = match op.as_str() {
        "add" if !items.is_empty() => "add".to_string(),
        "add" => "none".to_string(),
        "del" if !ids.is_empty() => "del".to_string(),
        "del" => "none".to_string(),
        "query" if !ids.is_empty() => "query".to_string(),
        "query" => "none".to_string(),
        _ => "none".to_string(),
    };

    Ok(IntentResult {
        op,
        items,
        ids,
        reply,
    })
}

/// 意图识别 + 记账解析二合一：一次无状态调用完成「新增 / 删除 / 查询 / 闲聊」。
/// 账目上下文由前端以紧凑行文本（`序号|日期|物品|分类|金额`）传入，
/// 每次对话不携带历史消息 —— 输入=提示词+一句话+账目快照，输出=一个 JSON 对象。
#[command]
async fn process_intent(
    text: String,
    protocol: String,
    base_url: String,
    api_key: String,
    api_model: String,
    categories: Option<Vec<String>>,
    ledger: Option<String>,
) -> Result<IntentResult, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("请先说点什么，比如「昨天买鼠标 120」".into());
    }

    let categories = clean_categories(categories);
    let today = today().format("%Y-%m-%d").to_string();
    let prompt = intent_prompt(&today, &categories, &ledger.unwrap_or_default());

    let content = request_model(
        &normalize_protocol(&protocol),
        &base_url,
        &api_key,
        &api_model,
        &prompt,
        trimmed,
        None,
    )
    .await?;

    parse_intent_content(&content, &categories, &today)
}

/// 识图记账：把小票 / 支付截图交给视觉模型，解析结果跟文字指令完全一致
#[command]
async fn process_image(
    text: String,
    image: String,
    mime: String,
    protocol: String,
    base_url: String,
    api_key: String,
    api_model: String,
    categories: Option<Vec<String>>,
    ledger: Option<String>,
) -> Result<IntentResult, String> {
    // 允许前端直接传 data URL，这里只要逗号后面的 base64 正文
    let data = image.rsplit(',').next().unwrap_or_default().trim().to_string();
    if data.is_empty() {
        return Err("图片内容是空的".into());
    }
    let media = if mime.trim().is_empty() {
        "image/jpeg".to_string()
    } else {
        mime.trim().to_string()
    };
    let user_text = if text.trim().is_empty() {
        "请按这张图片记账"
    } else {
        text.trim()
    };

    let categories = clean_categories(categories);
    let today = today().format("%Y-%m-%d").to_string();
    let mut prompt = intent_prompt(&today, &categories, &ledger.unwrap_or_default());
    prompt.push_str(
        "\n用户会附上一张图片（小票 / 账单 / 支付截图）：请从图片里读出每一笔消费，\
         按上面的规则输出 JSON；图片里没有消费信息或看不清就输出 op=none。",
    );

    let image_input = ImageInput { mime: media, data };
    let content = request_model(
        &normalize_protocol(&protocol),
        &base_url,
        &api_key,
        &api_model,
        &prompt,
        user_text,
        Some(&image_input),
    )
    .await?;

    parse_intent_content(&content, &categories, &today)
}

#[command]
async fn test_connection(
    protocol: String,
    base_url: String,
    api_key: String,
    api_model: String,
) -> Result<TestResult, String> {
    let protocol = normalize_protocol(&protocol);
    let prompt = "只回复两个字：正常";

    match request_model(&protocol, &base_url, &api_key, &api_model, prompt, "连接测试", None).await {
        Ok(reply) => Ok(TestResult {
            ok: true,
            message: format!("连接成功：{}", truncate(&reply, 80)),
            model: api_model.trim().to_string(),
        }),
        Err(error) => Ok(TestResult {
            ok: false,
            message: error,
            model: String::new(),
        }),
    }
}

/// 把 Base URL 规整成 `/v1/models` 端点
fn models_endpoint(protocol: &str, base_url: &str) -> String {
    let raw = base_url.trim().trim_end_matches('/');
    let base = if raw.is_empty() {
        default_base_url(protocol).to_string()
    } else {
        strip_resource(&raw)
    };
    if has_version_segment(&base) {
        format!("{}/models", base)
    } else {
        format!("{}/v1/models", base)
    }
}

/// 从 `/v1/models` 接口拉取可用模型列表（OpenAI 兼容协议）
#[command]
async fn list_models(protocol: String, base_url: String, api_key: String) -> Result<ModelsResult, String> {
    let protocol = normalize_protocol(&protocol);
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Ok(ModelsResult {
            ok: false,
            message: "请先填写 API Key".into(),
            models: vec![],
        });
    }

    let url = models_endpoint(protocol, &base_url);
    let http = client()?;

    let response = http
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("anthropic-version", ANTHROPIC_VERSION) // Anthropic 忽略，多写无害
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("响应不是合法 JSON（HTTP {}）: {}", status, e))?;

    if !status.is_success() {
        return Ok(ModelsResult {
            ok: false,
            message: format!("接口返回 HTTP {}：{}", status, error_message(&body)),
            models: vec![],
        });
    }

    // 兼容多种字段命名
    let models: Vec<String> = if let Some(items) = body.get("data").and_then(|v| v.as_array()) {
        items
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .or_else(|| item.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect()
    } else if let Some(items) = body.get("models").and_then(|v| v.as_array()) {
        items
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .or_else(|| item.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect()
    } else if let Some(items) = body.as_array() {
        items
            .iter()
            .filter_map(|item| {
                item.get("id")
                    .or_else(|| item.get("name"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            })
            .collect()
    } else {
        vec![]
    };

    let mut models = models;
    models.sort();
    models.dedup();

    if models.is_empty() {
        return Ok(ModelsResult {
            ok: false,
            message: "接口返回成功，但没有解析出任何模型 ID".into(),
            models: vec![],
        });
    }

    Ok(ModelsResult {
        ok: true,
        message: format!("已获取 {} 个模型", models.len()),
        models,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            process_accounting,
            process_intent,
            process_image,
            test_connection,
            list_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
