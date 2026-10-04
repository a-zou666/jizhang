use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::command;

#[derive(Serialize, Deserialize, Debug)]
pub struct Expense {
    date: String,
    item: String,
    category: String,
    amount: f64,
}

// 接收来自前端的 api_key, api_url 和 api_model
#[command]
async fn process_accounting(
    text: String,
    api_key: String,
    api_url: String,
    api_model: String,
) -> Result<Vec<Expense>, String> {
    // 强制输出 JSON 数组的 Prompt
    let prompt = "你是一个记账助手。请提取支出记录并严格返回以下 JSON 数组格式，不要有任何其他字符或 Markdown 代码块：[{\"date\":\"YYYY-MM-DD\",\"item\":\"物品\",\"category\":\"分类\",\"amount\":12.5}]";

    let client = Client::new();

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&json!({
            "model": api_model,
            "messages": [
                {"role": "system", "content": prompt},
                {"role": "user", "content": text}
            ],
            "temperature": 0.0
        }))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let res_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("JSON解析失败: {}", e))?;

    // 提取模型返回的文本
    let content = res_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("[]");

    // 过滤掉可能存在的 ```json 代码块包裹，提高容错率
    let clean_content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let expenses: Vec<Expense> = serde_json::from_str(clean_content).map_err(|e| {
        format!(
            "大模型返回的数据格式不对: {}\n原始数据: {}",
            e, clean_content
        )
    })?;

    Ok(expenses)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![process_accounting])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
