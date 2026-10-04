use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::env;
use tauri::command;

// 定义账单数据结构，需与前端和 LLM 的 JSON 对应
#[derive(Serialize, Deserialize, Debug)]
pub struct Expense {
    pub date: String,
    pub item: String,
    pub category: String,
    pub amount: f64,
}

// 核心处理命令：前端可以通过 invoke 调用这个函数
#[command]
async fn process_accounting(text: String) -> Result<Vec<Expense>, String> {
    let api_key = env::var("AI_LEDGER_API_KEY").ok();
    let api_url = env::var("AI_LEDGER_API_URL")
        .unwrap_or_else(|_| "https://api.openai.com/v1/chat/completions".to_string());
    let model = env::var("AI_LEDGER_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());
    if api_key.as_deref().map_or(true, str::is_empty) {
        return parse_local_expense(&text);
    }

    // 2. 构造 System Prompt 强制要求结构化输出
    let prompt = "你是一个记账助手。请提取支出记录并严格返回以下 JSON 数组格式，不要有任何其他字符：[{\"date\":\"YYYY-MM-DD\",\"item\":\"物品\",\"category\":\"分类\",\"amount\":12.5}]";

    let client = Client::new();

    // 3. 发送请求给 LLM
    let response = client
        .post(api_url)
        .header(
            "Authorization",
            format!("Bearer {}", api_key.unwrap_or_default()),
        )
        .json(&json!({
            "model": model,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": text}
            ],
            "temperature": 0.0
        }))
        .send()
        .await
        .map_err(|e| format!("请求模型服务失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("模型服务返回错误: {e}"))?;

    let res_json: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

    // 4. 解析大模型返回的 JSON 文本
    let content = res_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("[]");

    parse_expense_json(content)
}

fn parse_expense_json(content: &str) -> Result<Vec<Expense>, String> {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str(cleaned).map_err(|e| format!("模型返回的账单格式无效: {e}"))
}

fn parse_local_expense(text: &str) -> Result<Vec<Expense>, String> {
    let amount = text
        .split_whitespace()
        .find_map(|word| {
            let number = word
                .trim_matches(|character: char| !character.is_ascii_digit() && character != '.');
            number.parse::<f64>().ok()
        })
        .ok_or_else(|| "没有识别到金额，请输入类似“午餐 25 元”".to_string())?;
    let category = if text.contains("吃") || text.contains("餐") || text.contains("饭") {
        "餐饮"
    } else if text.contains("车") || text.contains("地铁") || text.contains("打车") {
        "交通"
    } else {
        "其他"
    };
    Ok(vec![Expense {
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
        item: text.to_string(),
        category: category.to_string(),
        amount,
    }])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // 注册刚刚写好的命令，让前端可以调用
        .invoke_handler(tauri::generate_handler![process_accounting])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
