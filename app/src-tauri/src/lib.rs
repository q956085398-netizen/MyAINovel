mod ai;
mod book_file;
mod chapter;
mod foreshadow;
mod inspiration;
mod library;
mod project;
mod search;
mod trope;
mod vocabulary;

use std::path::{Path, PathBuf};

use ai::{AiConfig, AiState, ChatSession, ChatSessionSummary, ChatStreamEvent, ChatStreamReq};
use book_file::{BookMeta, ChapterAnchor, MdContent, SaveResult};
use chapter::{ChapterEntry, SnapshotEntry, UnitBrief, WritingStats};
use foreshadow::{Foreshadow, ForeshadowView};
use inspiration::{CardDraft, ImportEntry, InspirationCard};
use library::BookEntry;
use project::{
    ArrangementCheck, ArrangementItem, Circle, NoteDraft, NoteEntry, NoteKind, ProjectEntry,
    ProjectMeta,
};
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

/// 正文读入带版本指纹（ADR 0004）：保存时带回对账，防 Obsidian 抢写被静默覆盖。
#[tauri::command]
fn read_book_md(path: String) -> Result<MdContent, String> {
    book_file::read_book_md(Path::new(&path))
}

/// base＝载入时的指纹；盘上不符判冲突（force＝用户确认覆盖）。
#[tauri::command]
fn save_book_md(
    path: String,
    content: String,
    base: Option<String>,
    force: bool,
) -> Result<SaveResult, String> {
    book_file::save_book_md(Path::new(&path), &content, base.as_deref(), force)
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

// --- 构思项目（工单 #4，docs/spec/构思数据模型.md）：项目/ 下一书一文件夹 ---

#[tauri::command]
fn scan_projects(root: String) -> Result<Vec<ProjectEntry>, String> {
    project::scan_projects(Path::new(&root))
}

#[tauri::command]
fn create_project(root: String, title: String) -> Result<ProjectEntry, String> {
    project::create_project(Path::new(&root), &title)
}

#[tauri::command]
fn read_project_meta(project: String) -> Result<ProjectMeta, String> {
    project::read_project_meta(Path::new(&project))
}

#[tauri::command]
fn save_project_meta(project: String, meta: ProjectMeta) -> Result<(), String> {
    project::write_project_meta(Path::new(&project), &meta)
}

#[tauri::command]
fn scan_notes(project: String, kind: NoteKind) -> Result<Vec<NoteEntry>, String> {
    project::scan_notes(Path::new(&project), kind)
}

/// prev_path：编辑既有笔记时的旧位置；改名会挪文件。
#[tauri::command]
fn save_note(
    project: String,
    draft: NoteDraft,
    prev_path: Option<String>,
) -> Result<NoteEntry, String> {
    project::save_note(
        Path::new(&project),
        &draft,
        prev_path.as_deref().map(Path::new),
    )
}

#[tauri::command]
fn delete_note(path: String) -> Result<(), String> {
    project::delete_note(Path::new(&path))
}

#[tauri::command]
fn read_circle(project: String) -> Result<Circle, String> {
    project::read_circle(Path::new(&project))
}

#[tauri::command]
fn save_circle(project: String, circle: Circle) -> Result<(), String> {
    project::save_circle(Path::new(&project), &circle)
}

#[tauri::command]
fn read_arrangement(project: String) -> Result<Vec<ArrangementItem>, String> {
    project::read_arrangement(Path::new(&project))
}

#[tauri::command]
fn save_arrangement(project: String, items: Vec<ArrangementItem>) -> Result<(), String> {
    project::save_arrangement(Path::new(&project), &items)
}

/// 排布体检（只提示不拦截）：对当前列表（可含未保存改动）现算。
#[tauri::command]
fn check_arrangement(project: String, items: Vec<ArrangementItem>) -> Result<ArrangementCheck, String> {
    project::check_project_arrangement(Path::new(&project), &items)
}

/// 矛盾提为单元：建单元草稿、矛盾状态改「已成单元」。
#[tauri::command]
fn promote_contradiction(path: String) -> Result<NoteEntry, String> {
    project::promote_contradiction(Path::new(&path))
}

/// 故事卡转生单元草稿：建单元、卡片「关联」记去向（工单 #9）。
#[tauri::command]
fn transmute_story_card(
    root: String,
    card_path: String,
    project: String,
) -> Result<NoteEntry, String> {
    project::transmute_story_card(
        Path::new(&root),
        Path::new(&card_path),
        Path::new(&project),
    )
}

// --- 书写板块（工单 #5，docs/spec/书写编辑器.md）：正文一章一文件 ---

#[tauri::command]
fn scan_chapters(project: String) -> Result<Vec<ChapterEntry>, String> {
    chapter::scan_chapters(Path::new(&project))
}

#[tauri::command]
fn create_chapter(project: String, title: String) -> Result<ChapterEntry, String> {
    chapter::create_chapter(Path::new(&project), &title)
}

#[tauri::command]
fn rename_chapter(path: String, title: String) -> Result<ChapterEntry, String> {
    chapter::rename_chapter(Path::new(&path), &title)
}

#[tauri::command]
fn delete_chapter(path: String) -> Result<(), String> {
    chapter::delete_chapter(Path::new(&path))
}

#[tauri::command]
fn renumber_chapters(project: String) -> Result<Vec<ChapterEntry>, String> {
    chapter::renumber_chapters(Path::new(&project))
}

/// 章节保存：指纹闸（ADR 0004）＋保存前快照。
#[tauri::command]
fn save_chapter_md(
    project: String,
    path: String,
    content: String,
    base: Option<String>,
    force: bool,
) -> Result<SaveResult, String> {
    chapter::save_chapter_md(
        Path::new(&project),
        Path::new(&path),
        &content,
        base.as_deref(),
        force,
    )
}

#[tauri::command]
fn list_chapter_snapshots(project: String, path: String) -> Result<Vec<SnapshotEntry>, String> {
    chapter::list_chapter_snapshots(Path::new(&project), Path::new(&path))
}

#[tauri::command]
fn read_chapter_snapshot(path: String) -> Result<String, String> {
    chapter::read_chapter_snapshot(Path::new(&path))
}

#[tauri::command]
fn save_chapter_paste_image(project: String, ext: String, bytes: Vec<u8>) -> Result<String, String> {
    chapter::save_chapter_paste_image(Path::new(&project), &ext, &bytes)
}

#[tauri::command]
fn find_unit_for_chapter(project: String, ordinal: u32) -> Result<Option<UnitBrief>, String> {
    chapter::find_unit_for_chapter(Path::new(&project), ordinal)
}

// --- 伏笔系统（工单 #6，docs/spec/伏笔系统.md）：项目根 伏笔.yaml ---

#[tauri::command]
fn read_foreshadows(project: String) -> Result<Vec<Foreshadow>, String> {
    foreshadow::read_foreshadows(Path::new(&project))
}

/// 看板：伏笔 ＋ 现扫正文算出的未收章数/超期/引文失配（无索引，ADR 0002）。
#[tauri::command]
fn foreshadow_board(project: String) -> Result<Vec<ForeshadowView>, String> {
    foreshadow::foreshadow_board(Path::new(&project))
}

#[tauri::command]
fn add_foreshadow(project: String, name: String) -> Result<Vec<Foreshadow>, String> {
    foreshadow::add_pending_foreshadow(Path::new(&project), &name)
}

#[tauri::command]
fn annotate_foreshadow(
    project: String,
    name: String,
    chapter: u32,
    quote: String,
) -> Result<Vec<Foreshadow>, String> {
    foreshadow::annotate_foreshadow(Path::new(&project), &name, chapter, &quote)
}

#[tauri::command]
fn recover_foreshadow(
    project: String,
    name: String,
    chapter: u32,
    quote: String,
    kind: String,
    note: Option<String>,
) -> Result<Vec<Foreshadow>, String> {
    foreshadow::recover_foreshadow(
        Path::new(&project),
        &name,
        chapter,
        &quote,
        &kind,
        note.as_deref(),
    )
}

#[tauri::command]
fn set_foreshadow_state(
    project: String,
    name: String,
    state: String,
) -> Result<Vec<Foreshadow>, String> {
    foreshadow::set_foreshadow_state(Path::new(&project), &name, &state)
}

#[tauri::command]
fn delete_foreshadow(project: String, name: String) -> Result<Vec<Foreshadow>, String> {
    foreshadow::delete_foreshadow(Path::new(&project), &name)
}

fn writing_stats_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("定位应用数据目录失败：{e}"))?
        .join("书写");
    Ok(dir.join("统计.json"))
}

#[tauri::command]
fn load_writing_stats(app: tauri::AppHandle) -> Result<WritingStats, String> {
    chapter::load_writing_stats(&writing_stats_path(&app)?)
}

#[tauri::command]
fn save_writing_stats(app: tauri::AppHandle, stats: WritingStats) -> Result<(), String> {
    chapter::save_writing_stats(&writing_stats_path(&app)?, &stats)
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
            scan_projects,
            create_project,
            read_project_meta,
            save_project_meta,
            scan_notes,
            save_note,
            delete_note,
            read_circle,
            save_circle,
            read_arrangement,
            save_arrangement,
            check_arrangement,
            promote_contradiction,
            transmute_story_card,
            scan_chapters,
            create_chapter,
            rename_chapter,
            delete_chapter,
            renumber_chapters,
            save_chapter_md,
            list_chapter_snapshots,
            read_chapter_snapshot,
            save_chapter_paste_image,
            find_unit_for_chapter,
            read_foreshadows,
            foreshadow_board,
            add_foreshadow,
            annotate_foreshadow,
            recover_foreshadow,
            set_foreshadow_state,
            delete_foreshadow,
            load_writing_stats,
            save_writing_stats,
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
