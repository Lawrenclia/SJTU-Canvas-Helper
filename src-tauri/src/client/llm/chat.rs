use super::model::{ChatCompletionRequest, ChatCompletionResponse, Message, ModelListResponse};
use crate::{
    error::{AppError, Result},
    model::{LLMChatResponse, LLMConfig, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL},
    utils,
};
use async_trait::async_trait;
use reqwest::Client;
use std::time::Duration;
use tokio::sync::RwLock;

#[async_trait]
pub trait LLMClient: Send + Sync {
    async fn chat(&self, prompt: String) -> Result<String>;
    async fn chat_response(&self, prompt: String) -> Result<LLMChatResponse>;
    async fn set_configs(&self, configs: Vec<LLMConfig>);
}

pub struct OpenAICompatibleClient {
    configs: RwLock<Vec<LLMConfig>>,
    cli: Client,
}

fn strip_think_blocks(text: &str) -> String {
    let mut remaining = text;
    let mut cleaned = String::new();

    loop {
        let Some(start) = remaining.find("<think>") else {
            cleaned.push_str(remaining);
            break;
        };

        cleaned.push_str(&remaining[..start]);
        let after_start = &remaining[start + "<think>".len()..];
        let Some(end) = after_start.find("</think>") else {
            break;
        };
        remaining = &after_start[end + "</think>".len()..];
    }

    cleaned
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_api_root(base_url: &str) -> String {
    let trimmed = base_url.trim();
    let base = if trimmed.is_empty() {
        DEFAULT_LLM_BASE_URL
    } else {
        trimmed
    };

    let base = base.trim_end_matches('/');

    if let Some(prefix) = base.strip_suffix("/chat/completions") {
        return prefix.to_owned();
    }

    if let Some(prefix) = base.strip_suffix("/models") {
        return prefix.to_owned();
    }

    base.to_owned()
}

fn normalize_base_url(base_url: &str) -> String {
    format!("{}/chat/completions", normalize_api_root(base_url))
}

fn normalize_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        DEFAULT_LLM_MODEL.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn normalize_models_url(base_url: &str) -> String {
    format!("{}/models", normalize_api_root(base_url))
}

async fn send_chat_completion(
    cli: &Client,
    config: &LLMConfig,
    prompt: String,
) -> Result<LLMChatResponse> {
    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::LLMError("请先在设置页填写 LLM API Key。".to_string()));
    }

    let request = ChatCompletionRequest {
        model: normalize_model(&config.model),
        messages: vec![
            Message {
                role: "system".to_string(),
                content: "You are a helpful assistant.".to_string(),
            },
            Message {
                role: "user".to_string(),
                content: prompt,
            },
        ],
        stream: false,
    };

    let endpoint = normalize_base_url(&config.base_url);
    let response = cli
        .post(endpoint)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&request)
        .send()
        .await?;
    let status = response.status();
    let data = response.bytes().await?;

    if !status.is_success() {
        let body = String::from_utf8_lossy(&data).to_string();
        let message = if body.trim().is_empty() {
            format!("请求失败，状态码：{status}")
        } else {
            format!("请求失败，状态码：{status}，响应：{body}")
        };
        return Err(AppError::LLMError(message));
    }

    let chat_resp = utils::json::parse_json::<ChatCompletionResponse>(&data)?;
    let response = chat_resp
        .choices
        .into_iter()
        .next()
        .map(|choice| {
            let content = strip_think_blocks(&extract_text(&choice.message.content))
                .trim()
                .to_owned();
            let reasoning_content = extract_reasoning_content(&choice.message).trim().to_owned();
            LLMChatResponse {
                content,
                reasoning_content,
            }
        })
        .unwrap_or_default();

    if response.content.trim().is_empty() {
        return Err(AppError::LLMError(
            "LLM 返回了空内容，请检查模型配置后重试。".to_string(),
        ));
    }

    Ok(response)
}

async fn fetch_models(
    cli: &Client,
    config: &LLMConfig,
) -> Result<Vec<String>> {
    let api_key = config.api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::LLMError("请先填写对应节点的 LLM API Key。".to_string()));
    }

    let endpoint = normalize_models_url(&config.base_url);
    let response = cli
        .get(endpoint)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Accept", "application/json")
        .send()
        .await?;
    let status = response.status();
    let data = response.bytes().await?;

    if !status.is_success() {
        let body = String::from_utf8_lossy(&data).to_string();
        let message = if body.trim().is_empty() {
            format!("拉取模型列表失败，状态码：{status}")
        } else {
            format!("拉取模型列表失败，状态码：{status}，响应：{body}")
        };
        return Err(AppError::LLMError(message));
    }

    let model_resp = utils::json::parse_json::<ModelListResponse>(&data)?;
    let mut models = model_resp
        .data
        .into_iter()
        .map(|item| item.id)
        .filter(|item| !item.trim().is_empty())
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();

    if models.is_empty() {
        return Err(AppError::LLMError(
            "接口未返回可用模型，请确认该 API 兼容 OpenAI 的 /models。".to_string(),
        ));
    }

    Ok(models)
}

fn display_name(config: &LLMConfig, index: usize) -> String {
    let trimmed = config.name.trim();
    if trimmed.is_empty() {
        format!("LLM {}", index + 1)
    } else {
        trimmed.to_owned()
    }
}

fn normalize_config(config: &LLMConfig) -> LLMConfig {
    let mut normalized = config.clone();
    if normalized.base_url.trim().is_empty() {
        normalized.base_url = DEFAULT_LLM_BASE_URL.to_owned();
    }
    if normalized.model.trim().is_empty() {
        normalized.model = DEFAULT_LLM_MODEL.to_owned();
    }
    normalized
}

fn extract_text(value: &Option<serde_json::Value>) -> String {
    let Some(value) = value else {
        return String::new();
    };

    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part {
                serde_json::Value::Object(map) => {
                    let part_type = map
                        .get("type")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();

                    if matches!(part_type, "text" | "output_text" | "input_text" | "") {
                        map.get("text")
                            .and_then(|value| value.as_str())
                            .map(ToOwned::to_owned)
                            .or_else(|| {
                                map.get("content")
                                    .and_then(|value| value.as_str())
                                    .map(ToOwned::to_owned)
                            })
                    } else {
                        None
                    }
                }
                serde_json::Value::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn extract_reasoning_content_from_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part {
                serde_json::Value::Object(map) => {
                    let part_type = map
                        .get("type")
                        .and_then(|value| value.as_str())
                        .unwrap_or_default();

                    if part_type.contains("reason") {
                        map.get("text")
                            .and_then(|value| value.as_str())
                            .map(ToOwned::to_owned)
                            .or_else(|| {
                                map.get("content")
                                    .and_then(|value| value.as_str())
                                    .map(ToOwned::to_owned)
                            })
                            .or_else(|| {
                                map.get("reasoning_content")
                                    .and_then(|value| value.as_str())
                                    .map(ToOwned::to_owned)
                            })
                    } else {
                        None
                    }
                }
                serde_json::Value::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Object(map) => map
            .get("text")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
            .or_else(|| {
                map.get("content")
                    .map(extract_reasoning_content_from_value)
                    .filter(|value| !value.trim().is_empty())
            })
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn extract_reasoning_content(message: &super::model::AssistantMessage) -> String {
    if let Some(reasoning_content) = &message.reasoning_content {
        if !reasoning_content.trim().is_empty() {
            return reasoning_content.clone();
        }
    }

    if let Some(reasoning) = &message.reasoning {
        let content = extract_reasoning_content_from_value(reasoning);
        if !content.trim().is_empty() {
            return content;
        }
    }

    String::new()
}

async fn send_chat_with_fallback(
    cli: &Client,
    configs: &[LLMConfig],
    prompt: String,
) -> Result<LLMChatResponse> {
    let normalized_configs = configs
        .iter()
        .map(normalize_config)
        .filter(|config| config.enabled && !config.api_key.trim().is_empty())
        .collect::<Vec<_>>();

    if normalized_configs.is_empty() {
        return Err(AppError::LLMError(
            "请先配置至少一个启用的 LLM 选项。".to_string(),
        ));
    }

    let mut errors = Vec::new();
    for (index, config) in normalized_configs.into_iter().enumerate() {
        let config_name = display_name(&config, index);
        tracing::info!("Trying LLM config: {}", config_name);
        match send_chat_completion(cli, &config, prompt.clone()).await {
            Ok(response) => {
                tracing::info!("LLM config succeeded: {}", config_name);
                return Ok(response);
            }
            Err(error) => {
                tracing::warn!("LLM config failed: {} - {}", config_name, error);
                errors.push(format!("{}: {}", config_name, error));
            }
        }
    }

    Err(AppError::LLMError(format!(
        "所有 LLM 选项都调用失败：{}",
        errors.join(" | ")
    )))
}

pub async fn chat_with_configs(configs: Vec<LLMConfig>, prompt: String) -> Result<String> {
    let response = chat_with_configs_response(configs, prompt).await?;
    Ok(response.content)
}

pub async fn chat_with_configs_response(
    configs: Vec<LLMConfig>,
    prompt: String,
) -> Result<LLMChatResponse> {
    let client = Client::builder().timeout(Duration::from_secs(180)).build()?;
    send_chat_with_fallback(&client, &configs, prompt).await
}

pub async fn list_models(config: LLMConfig) -> Result<Vec<String>> {
    let client = Client::builder().timeout(Duration::from_secs(60)).build()?;
    let normalized = normalize_config(&config);
    fetch_models(&client, &normalized).await
}

pub fn new_llm_client(configs: Vec<LLMConfig>) -> Result<Box<dyn LLMClient>> {
    let client = Client::builder().timeout(Duration::from_secs(180)).build()?;
    let llm_cli = OpenAICompatibleClient {
        configs: RwLock::new(configs),
        cli: client,
    };
    Ok(Box::new(llm_cli))
}

#[async_trait]
impl LLMClient for OpenAICompatibleClient {
    async fn set_configs(&self, configs: Vec<LLMConfig>) {
        (*self.configs.write().await) = configs;
    }

    async fn chat(&self, prompt: String) -> Result<String> {
        let response = self.chat_response(prompt).await?;
        Ok(response.content)
    }

    async fn chat_response(&self, prompt: String) -> Result<LLMChatResponse> {
        let configs = self.configs.read().await.clone();
        send_chat_with_fallback(&self.cli, &configs, prompt).await
    }
}

#[cfg(test)]
mod test {
    use crate::client::llm::chat;
    use crate::error::Result;
    use crate::model::LLMConfig;
    use std::env;

    #[tokio::test]
    #[ignore]
    async fn test_deepseek_llm() -> Result<()> {
        let api_key = env::var("API_KEY").unwrap_or_default();
        let cli = chat::new_llm_client(vec![LLMConfig {
            api_key,
            ..Default::default()
        }])?;
        let resp = cli.chat("你好！".into()).await?;
        println!("resp: {resp}");
        Ok(())
    }
}
