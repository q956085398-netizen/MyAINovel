//! AI 侧边栏（设计共识 §七、ADR 0003）：OpenAI 兼容供应商配置、多会话存储、流式对话。
//! 供应商配置（含 API Key）与对话会话是应用数据而非创作数据，存应用数据目录，
//! 不落入可能同步到 Obsidian 的库文件夹（ADR 0002 约束的是库数据）。
//! 网络请求走 Rust 侧，绕开 webview 的 CORS 限制。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::book_file::{read_text, write_text_atomic};

// ---------- 供应商配置 ----------

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProvider {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Default, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default)]
    pub providers: Vec<AiProvider>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
}

pub fn load_config(path: &Path) -> Result<AiConfig, String> {
    if !path.is_file() {
        return Ok(AiConfig::default());
    }
    let text = read_text(path)?;
    serde_json::from_str(&text).map_err(|e| format!("供应商配置解析失败：{e}"))
}

pub fn save_config(path: &Path, config: &AiConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text =
        serde_json::to_string_pretty(config).map_err(|e| format!("配置序列化失败：{e}"))?;
    write_text_atomic(path, &text)
}

// ---------- 会话存储 ----------

/// meta 为前端 opaque 载荷（编辑器命令的选区行号等），后端只存取不解释。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
}

/// 会话的人物对话标签（工单 #16，docs/spec/人物对话.md §三）：记录这个
/// 会话在跟哪本书的哪个人物聊。只用于列表显示与再打开识别——人物/项目
/// 改名后标签失效只提示，不回写不清理。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatPersona {
    pub project: String,
    pub person: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    /// Unix 秒，前端生成。
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<ChatMessage>,
    /// 人物对话标签（普通 AI 会话为 None；旧会话文件缺此键＝None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona: Option<ChatPersona>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at: u64,
    pub message_count: usize,
    pub persona: Option<ChatPersona>,
}

/// 会话 id 只允许字母数字、连字符、下划线，杜绝路径逃逸。
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn session_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

pub fn save_session(dir: &Path, session: &ChatSession) -> Result<(), String> {
    if !valid_session_id(&session.id) {
        return Err(format!("非法会话 id：{}", session.id));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("创建会话目录失败：{e}"))?;
    let text =
        serde_json::to_string_pretty(session).map_err(|e| format!("会话序列化失败：{e}"))?;
    write_text_atomic(&session_path(dir, &session.id), &text)
}

pub fn load_session(dir: &Path, id: &str) -> Result<ChatSession, String> {
    if !valid_session_id(id) {
        return Err(format!("非法会话 id：{id}"));
    }
    let text = read_text(&session_path(dir, id))
        .map_err(|e| format!("读取会话失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("会话解析失败：{e}"))
}

/// 全量列出会话摘要，最近更新在前；单个会话文件损坏不拖垮整列表。
pub fn list_sessions(dir: &Path) -> Result<Vec<ChatSessionSummary>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| format!("读取会话目录失败：{e}"))? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = read_text(&path) else { continue };
        let Ok(session) = serde_json::from_str::<ChatSession>(&text) else { continue };
        out.push(ChatSessionSummary {
            id: session.id,
            title: session.title,
            updated_at: session.updated_at,
            message_count: session.messages.len(),
            persona: session.persona,
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

pub fn delete_session(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_session_id(id) {
        return Err(format!("非法会话 id：{id}"));
    }
    let path = session_path(dir, id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除会话失败：{e}"))?;
    }
    Ok(())
}

// ---------- SSE 解析（OpenAI 兼容 stream 格式） ----------

/// 字节级 SSE 增量解析。按 `\n` 切行：多字节 UTF-8 字符不含 0x0A 字节，
/// 网络分块把中文截在半截也不会产生替换字符。
#[derive(Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
    /// 当前事件已累积的 data 行（多行 data 以 \n 连接后才是载荷）。
    pending: Option<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入一段网络字节，返回其中完整事件（空行分隔）的 data 载荷。
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let mut line = &line[..line.len() - 1]; // 去掉 \n
            if line.last() == Some(&b'\r') {
                line = &line[..line.len() - 1];
            }
            self.take_line(String::from_utf8_lossy(line).into_owned().as_str(), &mut events);
        }
        events
    }

    /// 流结束时收尾：处理最后一段没有换行结尾的残余行与未闭合事件。
    pub fn finish(&mut self) -> Vec<String> {
        let rest = String::from_utf8_lossy(&self.buf).into_owned();
        self.buf.clear();
        let mut events = Vec::new();
        if !rest.is_empty() {
            self.take_line(&rest, &mut events);
        }
        if let Some(data) = self.pending.take() {
            events.push(data);
        }
        events
    }

    fn take_line(&mut self, line: &str, events: &mut Vec<String>) {
        if line.is_empty() {
            if let Some(data) = self.pending.take() {
                events.push(data);
            }
            return;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            let entry = self.pending.get_or_insert_with(String::new);
            if !entry.is_empty() {
                entry.push('\n');
            }
            entry.push_str(rest);
        }
        // 其余字段（event:/id:/retry:）与 `:` 注释行忽略。
    }
}

/// 从一条 chat.completions 流事件 JSON 里取增量文本。
pub fn extract_delta(event: &Value) -> Option<String> {
    event
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(|s| s.to_string())
}

/// 末个分块带的 finish_reason（stop/length/…）。
pub fn extract_finish_reason(event: &Value) -> Option<String> {
    event
        .get("choices")?
        .get(0)?
        .get("finish_reason")?
        .as_str()
        .map(|s| s.to_string())
}

// ---------- 请求构造 ----------

pub fn chat_completions_url(base_url: &str) -> String {
    format!("{}/chat/completions", base_url.trim_end_matches('/'))
}

/// 组请求体：meta 等本地字段不出后端。
pub fn build_request_body(model: &str, messages: &[ChatMessage]) -> Value {
    json!({
        "model": model,
        "stream": true,
        "messages": messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect::<Vec<_>>(),
    })
}

// ---------- 流式对话命令 ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamReq {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub messages: Vec<ChatMessage>,
}

/// 前端 Channel 上的事件；Done 在正常结束、被取消或流截断时都发出，
/// reason 取 finish_reason，本地取消用固定值 "stopped"。
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatStreamEvent {
    Delta { text: String },
    Done { reason: Option<String> },
}

pub const STOPPED_REASON: &str = "stopped";

/// 取消标记集：chat_cancel 置位，chat_stream 逐分块检查。
#[derive(Default)]
pub struct AiState {
    cancelled: Mutex<HashSet<u64>>,
}

impl AiState {
    pub fn cancel(&self, token: u64) {
        self.cancelled.lock().unwrap().insert(token);
    }

    fn is_cancelled(&self, token: u64) -> bool {
        self.cancelled.lock().unwrap().contains(&token)
    }

    fn clear(&self, token: u64) {
        self.cancelled.lock().unwrap().remove(&token);
    }
}

/// 流式对话主体。拉取 SSE → 逐增量发 Delta → 结束发 Done。
/// 非成功状态码时尽量把供应商错误信息透出。
pub async fn chat_stream(
    state: &AiState,
    req: &ChatStreamReq,
    token: u64,
    mut on_event: impl FnMut(ChatStreamEvent),
) -> Result<(), String> {
    state.clear(token);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;
    let response = client
        .post(chat_completions_url(&req.base_url))
        .bearer_auth(&req.api_key)
        .json(&build_request_body(&req.model, &req.messages))
        .send()
        .await
        .map_err(|e| format!("请求供应商失败：{e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| body.trim().to_string());
        return Err(format!("供应商返回 {status}：{detail}"));
    }

    let mut decoder = SseDecoder::new();
    let mut stream = response.bytes_stream();
    // 取消不能只等下一个分块：供应商停发数据时用户点「停止」也必须立刻生效，
    // 所以用 select 同时盯数据流与心跳。
    let mut ticker = tokio::time::interval(Duration::from_millis(200));
    let mut finish_reason = None;
    loop {
        let item = tokio::select! {
            _ = ticker.tick() => {
                if state.is_cancelled(token) {
                    on_event(ChatStreamEvent::Done {
                        reason: Some(STOPPED_REASON.to_string()),
                    });
                    state.clear(token);
                    return Ok(());
                }
                continue;
            }
            item = stream.next() => item,
        };
        let Some(bytes) = item else { break };
        let bytes = bytes.map_err(|e| format!("读取流失败：{e}"))?;
        if state.is_cancelled(token) {
            on_event(ChatStreamEvent::Done {
                reason: Some(STOPPED_REASON.to_string()),
            });
            state.clear(token);
            return Ok(());
        }
        for payload in decoder.feed(&bytes) {
            if payload == "[DONE]" {
                on_event(ChatStreamEvent::Done {
                    reason: finish_reason.clone(),
                });
                return Ok(());
            }
            let Ok(event) = serde_json::from_str::<Value>(&payload) else {
                continue;
            };
            if let Some(reason) = extract_finish_reason(&event) {
                finish_reason = Some(reason);
            }
            if let Some(text) = extract_delta(&event) {
                on_event(ChatStreamEvent::Delta { text });
            }
        }
    }
    // 连接关闭：已收完的残余事件仍要出净，再发 Done 收尾
    // （[DONE] 可能恰好残留在没有换行结尾的尾部，由 finish 兜出）。
    for payload in decoder.finish() {
        if payload == "[DONE]" {
            break;
        }
        if let Ok(event) = serde_json::from_str::<Value>(&payload) {
            if let Some(reason) = extract_finish_reason(&event) {
                finish_reason = Some(reason);
            }
            if let Some(text) = extract_delta(&event) {
                on_event(ChatStreamEvent::Delta { text });
            }
        }
    }
    on_event(ChatStreamEvent::Done { reason: finish_reason });
    Ok(())
}

// ---------- 应用数据目录布局 ----------

pub fn ai_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("定位应用数据目录失败：{e}"))?;
    Ok(dir.join("ai"))
}

pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join("providers.json"))
}

pub fn sessions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join("sessions"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sse_basic_events_and_done() {
        let mut d = SseDecoder::new();
        let chunk = b"data: {\"a\":1}\n\ndata: [DONE]\n\n";
        assert_eq!(d.feed(chunk), vec![r#"{"a":1}"#.to_string(), "[DONE]".to_string()]);
        assert!(d.finish().is_empty());
    }

    #[test]
    fn sse_chunk_split_inside_multibyte_char() {
        // "你好" 的 UTF-8 字节被网络分块拦腰截断，且事件尾的空行在下一块才到。
        let payload = format!("data: {{\"t\":\"{}\"}}", "你好");
        let bytes = payload.as_bytes();
        let mut d = SseDecoder::new();
        assert!(d.feed(&bytes[..bytes.len() - 3]).is_empty());
        assert!(d.feed(&bytes[bytes.len() - 3..]).is_empty());
        assert_eq!(d.feed(b"\n\n"), vec![r#"{"t":"你好"}"#.to_string()]);
        let parsed: Value = serde_json::from_str(r#"{"t":"你好"}"#).unwrap();
        assert_eq!(parsed["t"].as_str(), Some("你好"));
    }

    #[test]
    fn sse_crlf_comment_and_multiline_data() {
        let mut d = SseDecoder::new();
        let chunk = b": ping\r\ndata: line1\r\ndata: line2\r\n\r\ndata: tail";
        assert_eq!(d.feed(chunk), vec!["line1\nline2".to_string()]);
        // 没有空行收尾的事件由 finish 兜出。
        assert_eq!(d.finish(), vec!["tail".to_string()]);
    }

    #[test]
    fn sse_finish_flushes_event_without_trailing_newline() {
        let mut d = SseDecoder::new();
        assert!(d.feed(b"data: x").is_empty());
        assert_eq!(d.finish(), vec!["x".to_string()]);
    }

    #[test]
    fn extract_delta_and_finish_reason() {
        let delta = json!({"choices":[{"delta":{"content":"掉"}}]});
        assert_eq!(extract_delta(&delta), Some("掉".to_string()));
        assert_eq!(extract_finish_reason(&delta), None);
        let last = json!({"choices":[{"delta":{},"finish_reason":"stop"}]});
        assert_eq!(extract_delta(&last), None);
        assert_eq!(extract_finish_reason(&last), Some("stop".to_string()));
        assert_eq!(extract_delta(&json!({})), None);
    }

    #[test]
    fn request_body_shape() {
        let messages = vec![
            ChatMessage {
                role: "system".into(),
                content: "ctx".into(),
                meta: None,
            },
            ChatMessage {
                role: "user".into(),
                content: "hi".into(),
                meta: Some(json!({"kind":"梳理"})),
            },
        ];
        let body = build_request_body("m1", &messages);
        assert_eq!(body["model"], "m1");
        assert_eq!(body["stream"], true);
        assert_eq!(
            body["messages"],
            json!([{"role":"system","content":"ctx"},{"role":"user","content":"hi"}])
        );
    }

    #[test]
    fn completions_url_joins() {
        assert_eq!(
            chat_completions_url("https://api.x.com/v1/"),
            "https://api.x.com/v1/chat/completions"
        );
        assert_eq!(
            chat_completions_url("https://api.x.com/v1"),
            "https://api.x.com/v1/chat/completions"
        );
    }

    #[test]
    fn config_round_trip_and_default_on_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("providers.json");
        assert!(load_config(&path).unwrap().providers.is_empty());

        let cfg = AiConfig {
            providers: vec![AiProvider {
                id: "p1".into(),
                name: "深度求索".into(),
                base_url: "https://api.deepseek.com/v1".into(),
                api_key: "sk-x".into(),
                model: "deepseek-chat".into(),
            }],
            active_provider_id: Some("p1".into()),
        };
        save_config(&path, &cfg).unwrap();
        assert_eq!(load_config(&path).unwrap().providers[0].model, "deepseek-chat");
    }

    #[test]
    fn session_round_trip_list_delete() {
        let dir = tempfile::tempdir().unwrap();
        let s = ChatSession {
            id: "s1".into(),
            title: "梳理".into(),
            created_at: 1,
            updated_at: 5,
            messages: vec![ChatMessage {
                role: "user".into(),
                content: "hi".into(),
                meta: Some(json!({"kind":"小结","startLine":3})),
            }],
            persona: None,
        };
        save_session(dir.path(), &s).unwrap();
        let loaded = load_session(dir.path(), "s1").unwrap();
        assert_eq!(loaded.messages[0].meta, Some(json!({"kind":"小结","startLine":3})));

        let mut s2 = s.clone();
        s2.id = "s2".into();
        s2.updated_at = 9;
        save_session(dir.path(), &s2).unwrap();
        let list = list_sessions(dir.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "s2"); // 最近更新在前
        assert_eq!(list[1].message_count, 1);

        delete_session(dir.path(), "s2").unwrap();
        delete_session(dir.path(), "s2").unwrap(); // 幂等
        assert_eq!(list_sessions(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn session_id_rejects_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = ChatSession {
            id: "../evil".into(),
            title: String::new(),
            created_at: 0,
            updated_at: 0,
            messages: vec![],
            persona: None,
        };
        assert!(save_session(dir.path(), &s).is_err());
        assert!(load_session(dir.path(), "../evil").is_err());
        s.id = "ok-id_1".into();
        assert!(save_session(dir.path(), &s).is_ok());
    }

    #[test]
    fn list_sessions_skips_broken_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("broken.json"), "not json").unwrap();
        std::fs::write(dir.path().join("note.txt"), "ignore me").unwrap();
        assert!(list_sessions(dir.path()).unwrap().is_empty());
    }

    #[test]
    fn persona_tag_round_trip_and_legacy_sessions() {
        let dir = tempfile::tempdir().unwrap();
        // 旧会话文件（没有 persona 键）读回来是 None，照常工作。
        std::fs::write(
            dir.path().join("legacy.json"),
            r#"{"id":"legacy","title":"旧会话","createdAt":1,"updatedAt":2,"messages":[]}"#,
        )
        .unwrap();
        assert!(load_session(dir.path(), "legacy").unwrap().persona.is_none());

        // 人物对话会话：标签往返，列表摘要也带。
        let s = ChatSession {
            id: "persona".into(),
            title: "跟张三聊".into(),
            created_at: 1,
            updated_at: 5,
            messages: vec![],
            persona: Some(ChatPersona {
                project: "《大魏读书人》".into(),
                person: "张三".into(),
            }),
        };
        save_session(dir.path(), &s).unwrap();
        assert_eq!(
            load_session(dir.path(), "persona").unwrap().persona,
            Some(ChatPersona {
                project: "《大魏读书人》".into(),
                person: "张三".into(),
            })
        );
        let list = list_sessions(dir.path()).unwrap();
        assert_eq!(list[0].id, "persona");
        assert_eq!(list[0].persona.as_ref().map(|p| p.person.as_str()), Some("张三"));
        assert!(list[1].persona.is_none());

        // 无标签会话存盘不落 persona 键——文件形状与旧会话完全一致。
        let plain = ChatSession {
            id: "plain".into(),
            title: String::new(),
            created_at: 0,
            updated_at: 0,
            messages: vec![],
            persona: None,
        };
        save_session(dir.path(), &plain).unwrap();
        let text = std::fs::read_to_string(dir.path().join("plain.json")).unwrap();
        assert!(!text.contains("persona"), "{text}");
    }

    #[test]
    fn cancel_flag_lifecycle() {
        let state = AiState::default();
        state.cancel(7);
        assert!(state.is_cancelled(7));
        state.clear(7);
        assert!(!state.is_cancelled(7));
    }
}
