use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub stream: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct ChatCompletionResponse {
    pub choices: Vec<Choice>,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct Choice {
    pub index: u32,
    pub message: AssistantMessage,
    pub logprobs: Option<serde_json::Value>,
    pub finish_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct AssistantMessage {
    pub role: String,
    #[serde(default)]
    pub content: Option<serde_json::Value>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub reasoning: Option<serde_json::Value>,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct ModelListResponse {
    pub data: Vec<ModelData>,
}

#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct ModelData {
    pub id: String,
}
