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

const DEFAULT_CLAUDE_URL: &str = "https://api.anthropic.com";
const DEFAULT_OPENAI_URL: &str = "https://api.openai.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 2048;

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

/// 把用户填写的 Base URL 补全成真正的请求地址
fn endpoint(protocol: &str, base_url: &str) -> String {
    let raw = base_url.trim().trim_end_matches('/');
    let base = if raw.is_empty() {
        default_base_url(protocol).to_string()
    } else {
        raw.to_string()
    };

    if protocol == "claude" {
        if base.ends_with("/v1/messages") {
            base
        } else if base.ends_with("/v1") {
            format!("{}/messages", base)
        } else {
            format!("{}/v1/messages", base)
        }
    } else if base.ends_with("/chat/completions") {
        base
    } else if base.ends_with("/v1") {
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
) -> Result<String, String> {
    if api_key.trim().is_empty() {
        return Err("请先在设置页填写 API Key".into());
    }
    if api_model.trim().is_empty() {
        return Err("请先在设置页填写模型名称".into());
    }

    let url = endpoint(protocol, base_url);
    let http = client()?;

    let request = if protocol == "claude" {
        http.post(&url)
            .header("x-api-key", api_key.trim())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&json!({
                "model": api_model.trim(),
                "max_tokens": MAX_TOKENS,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_text}],
                "temperature": 0.0
            }))
    } else {
        http.post(&url)
            .header("Authorization", format!("Bearer {}", api_key.trim()))
            .json(&json!({
                "model": api_model.trim(),
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_text}
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

#[command]
async fn test_connection(
    protocol: String,
    base_url: String,
    api_key: String,
    api_model: String,
) -> Result<TestResult, String> {
    let protocol = normalize_protocol(&protocol);
    let prompt = "只回复两个字：正常";

    match request_model(&protocol, &base_url, &api_key, &api_model, prompt, "连接测试").await {
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
        raw.to_string()
    };
    if base.ends_with("/models") {
        base
    } else if base.ends_with("/v1") {
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

/// 把麦克风录制的音频转写为文字（OpenAI 兼容 Whisper 接口）。
/// `audio_base64` 是 data:audio/...;base64,XXXX 中的 base64 部分；`mime` 是 MIME 类型。
#[command]
async fn transcribe_audio(
    protocol: String,
    base_url: String,
    api_key: String,
    api_model: String,
    audio_base64: String,
    mime: String,
) -> Result<String, String> {
    let protocol = normalize_protocol(&protocol);
    if api_key.trim().is_empty() {
        return Err("请先在设置页填写 API Key".into());
    }
    if api_model.trim().is_empty() {
        return Err("请先在设置页填写模型名称".into());
    }
    if audio_base64.trim().is_empty() {
        return Err("未收到音频数据".into());
    }

    // 把 base64 解码成字节
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.trim())
        .map_err(|e| format!("音频数据不是合法 base64: {}", e))?;

    // 取后缀（webm/m4a/wav/mp3/ogg/amr）作为 filename
    let suffix = mime
        .split('/')
        .nth(1)
        .map(|s| s.split(';').next().unwrap_or(""))
        .unwrap_or("webm")
        .to_ascii_lowercase();
    // 限定白名单：避免 `audio/x-m4a` 等被 OpenAI 当作未知类型拒绝
    let suffix = match suffix.as_str() {
        "x-m4a" | "m4a" => "m4a",
        "mp4" | "mpeg" => "mp4",
        "wav" | "x-wav" => "wav",
        "mp3" => "mp3",
        "ogg" | "oga" => "ogg",
        other if other.is_empty() => "webm",
        other => other,
    };
    let file_name = format!("audio.{}", suffix);

    // 复用 endpoint() 拼出 base，覆写为 /audio/transcriptions
    let raw = base_url.trim().trim_end_matches('/');
    let base = if raw.is_empty() {
        default_base_url(protocol).to_string()
    } else {
        raw.to_string()
    };
    let base = if base.ends_with("/audio/transcriptions") {
        base
    } else if base.ends_with("/v1") {
        format!("{}/audio/transcriptions", base)
    } else {
        format!("{}/v1/audio/transcriptions", base)
    };

    let http = client()?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime)
        .map_err(|e| format!("构造音频上传失败: {}", e))?;
    let form = reqwest::multipart::Form::new()
        .text("model", api_model.trim().to_string())
        .part("file", part);

    let response = http
        .post(&base)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("语音识别网络请求失败: {}", e))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("语音识别响应不是合法 JSON（HTTP {}）: {}", status, e))?;

    if !status.is_success() {
        return Err(format!(
            "语音识别接口返回 HTTP {}：{}",
            status,
            error_message(&body)
        ));
    }

    // 兼容 { "text": "..." } 与 { choices:[...]} 两种格式
    if let Some(t) = body.get("text").and_then(|v| v.as_str()) {
        return Ok(t.to_string());
    }
    if let Some(text) = body["choices"][0]["message"]["content"].as_str() {
        return Ok(text.to_string());
    }
    if let Some(text) = body["choices"][0]["text"].as_str() {
        return Ok(text.to_string());
    }

    Err(format!(
        "无法从响应里提取转写文本：{}",
        truncate(&body.to_string(), 300)
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            process_accounting,
            test_connection,
            list_models,
            transcribe_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
