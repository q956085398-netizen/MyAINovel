mod ai;
mod book_file;
mod inspiration;
mod library;
mod search;
mod trope;
mod vocabulary;

use std::path::{Path, PathBuf};

use ai::{AiConfig, AiState, ChatSession, ChatSessionSummary, ChatStreamEvent, ChatStreamReq};
use book_file::{BookMeta, ChapterAnchor};
use inspiration::{CardDraft, ImportEntry, InspirationCard};
use library::BookEntry;
use trope::TropeSpan;
use vocabulary::Vocabulary;

#[tauri::command]
fn scan_library(root: String) -> Result<Vec<BookEntry>, String> {
    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("不是有效的文件夹：{root}"));
    }
    library::scan_library(&path)
}

#[tauri::command]
fn read_book_md(path: String) -> Result<String, String> {
    book_file::read_text(Path::new(&path))
}

#[tauri::command]
fn save_book_md(path: String, content: String) -> Result<(), String> {
    book_file::write_text_atomic(Path::new(&path), &content)
}

#[tauri::command]
fn read_book_meta(md_path: String) -> Result<BookMeta, String> {
    book_file::read_book_meta(Path::new(&md_path))
}

#[tauri::command]
fn save_book_meta(md_path: String, meta: BookMeta) -> Result<(), String> {
    book_file::write_book_meta(Path::new(&md_path), &meta)
}

#[tauri::command]
fn next_chapter_line(content: String, template: String) -> String {
    book_file::next_chapter_line(&content, &template)
}

#[tauri::command]
fn save_paste_image(md_path: String, ext: String, bytes: Vec<u8>) -> Result<String, String> {
    book_file::save_paste_image(Path::new(&md_path), &ext, &bytes)
}

#[tauri::command]
fn list_chapters(content: String, template: String) -> Vec<ChapterAnchor> {
    book_file::list_chapters(&content, &template)
}

#[tauri::command]
fn read_tropes(md_path: String) -> Result<Vec<TropeSpan>, String> {
    trope::read_tropes(Path::new(&md_path))
}

#[tauri::command]
fn save_tropes(md_path: String, tropes: Vec<TropeSpan>) -> Result<(), String> {
    trope::write_tropes(Path::new(&md_path), &tropes)
}

/// 类型/解法词表（工单 #10）：库根「词表.yaml」＋库内已用词的合成提示；
/// 首次调用若词表文件不存在会落盘类型种子。
#[tauri::command]
fn load_vocab(root: String) -> Result<Vocabulary, String> {
    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("不是有效的文件夹：{root}"));
    }
    vocabulary::load_vocab(&path)
}

#[tauri::command]
fn search_library(root: String, query: String) -> Result<Vec<search::SearchHit>, String> {
    search::search_library(&PathBuf::from(&root), &query)
}

#[tauri::command]
fn scan_inspirations(root: String) -> Result<Vec<InspirationCard>, String> {
    inspiration::scan_inspirations(Path::new(&root))
}

/// prev_path：编辑既有卡片时的旧位置；改标题/换类别会改名挪目录。
#[tauri::command]
fn save_inspiration_card(
    root: String,
    draft: CardDraft,
    prev_path: Option<String>,
) -> Result<InspirationCard, String> {
    inspiration::save_card(
        Path::new(&root),
        &draft,
        prev_path.as_deref().map(Path::new),
    )
}

#[tauri::command]
fn delete_inspiration_card(path: String) -> Result<(), String> {
    inspiration::delete_card(Path::new(&path))
}

/// 解析旧「灵感.md」为待确认条目（只读，不改原文件）。
#[tauri::command]
fn import_inspiration_preview(path: String) -> Result<Vec<ImportEntry>, String> {
    let content = book_file::read_text(Path::new(&path))?;
    Ok(inspiration::import_preview(&content))
}

/// 确认导入：source_path 取文件名记入卡片「来源」（如「导入自 灵感.md」）。
#[tauri::command]
fn confirm_import_inspirations(
    root: String,
    entries: Vec<ImportEntry>,
    source_path: Option<String>,
) -> Result<Vec<String>, String> {
    let label = source_path.as_deref().map(|p| {
        let name = Path::new(p)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.to_string());
        format!("导入自 {name}")
    });
    Ok(
        inspiration::confirm_import(Path::new(&root), &entries, label.as_deref())?
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
    )
}

// --- AI 侧边栏（设计共识 §七）：配置与会话存应用数据目录，流式对话走 Channel ---

#[tauri::command]
fn load_ai_config(app: tauri::AppHandle) -> Result<AiConfig, String> {
    ai::load_config(&ai::config_path(&app)?)
}

#[tauri::command]
fn save_ai_config(app: tauri::AppHandle, config: AiConfig) -> Result<(), String> {
    ai::save_config(&ai::config_path(&app)?, &config)
}

#[tauri::command]
fn list_chat_sessions(app: tauri::AppHandle) -> Result<Vec<ChatSessionSummary>, String> {
    ai::list_sessions(&ai::sessions_dir(&app)?)
}

#[tauri::command]
fn load_chat_session(app: tauri::AppHandle, id: String) -> Result<ChatSession, String> {
    ai::load_session(&ai::sessions_dir(&app)?, &id)
}

#[tauri::command]
fn save_chat_session(app: tauri::AppHandle, session: ChatSession) -> Result<(), String> {
    ai::save_session(&ai::sessions_dir(&app)?, &session)
}

#[tauri::command]
fn delete_chat_session(app: tauri::AppHandle, id: String) -> Result<(), String> {
    ai::delete_session(&ai::sessions_dir(&app)?, &id)
}

/// 流式对话：增量经 onEvent Channel 回推，前端以 token 配对「停止」。
#[tauri::command]
async fn chat_stream(
    state: tauri::State<'_, AiState>,
    req: ChatStreamReq,
    token: u64,
    on_event: tauri::ipc::Channel<ChatStreamEvent>,
) -> Result<(), String> {
    ai::chat_stream(&state, &req, token, |event| {
        let _ = on_event.send(event);
    })
    .await
}

#[tauri::command]
fn chat_cancel(state: tauri::State<'_, AiState>, token: u64) {
    state.cancel(token);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AiState::default())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            read_book_md,
            save_book_md,
            read_book_meta,
            save_book_meta,
            next_chapter_line,
            save_paste_image,
            list_chapters,
            read_tropes,
            save_tropes,
            load_vocab,
            search_library,
            scan_inspirations,
            save_inspiration_card,
            delete_inspiration_card,
            import_inspiration_preview,
            confirm_import_inspirations,
            load_ai_config,
            save_ai_config,
            list_chat_sessions,
            load_chat_session,
            save_chat_session,
            delete_chat_session,
            chat_stream,
            chat_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
