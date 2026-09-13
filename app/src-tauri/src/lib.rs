mod ai;
mod ai_context;
mod book_file;
mod chapter;
mod cover;
mod expectation;
mod export;
mod foreshadow;
mod inspiration;
mod library;
mod project;
mod proofread;
mod relationship;
mod search;
mod thread;
mod trope;
mod vocabulary;

use std::path::{Path, PathBuf};

use ai::{AiConfig, AiState, ChatSession, ChatSessionSummary, ChatStreamEvent, ChatStreamReq};
use book_file::{BookMeta, ChapterAnchor, MdContent, SaveResult};
use chapter::{ChapterEntry, SnapshotEntry, UnitBrief, WritingStats};
use expectation::{Expectation, ExpectationBoard};
use export::{ChapterRange, ExportReport, ExportTemplate};
use foreshadow::{Foreshadow, ForeshadowView};
use inspiration::{CardDraft, ImportEntry, InspirationCard};
use library::BookEntry;
use project::{
    ArrangementCheck, ArrangementItem, Circle, NoteDraft, NoteEntry, NoteKind, ProjectEntry,
    ProjectMeta,
};
use proofread::ProofReport;
use relationship::{Confluence, RelationshipTable, RelationshipView};
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

/// 新建拆书书（工单 #20）：一书一文件夹＋模板初始稿（工单 #29：库根
/// 拆书模板套用、{书名} 替换），yaml/附件懒生成。
#[tauri::command]
fn create_book(root: String, title: String) -> Result<BookEntry, String> {
    library::create_book(&PathBuf::from(&root), &title)
}

/// 打开拆书模板（工单 #29，spec 拆书保存与模板 §三）：库根 拆书模板.md
/// 不存在先落默认模板（懒生成），返回的条目交同一拆书编辑器编辑。
#[tauri::command]
fn open_book_template(root: String) -> Result<BookEntry, String> {
    library::open_book_template(&PathBuf::from(&root))
}

/// 新建库空文件夹判定（工单 #21）：选中的文件夹是否为空（含隐藏项）；
/// 非空时前端向人确认，不自动清洗。
#[tauri::command]
fn is_empty_dir(path: String) -> Result<bool, String> {
    library::is_empty_library_dir(Path::new(&path))
}

/// 设封面（工单 #23）：选图拷为 cover_dir/封面.<ext>（旧封面删除替换），
/// 返回封面文件路径。封面是全应用第一处图片渲染——本地图片加载走
/// asset 协议（convertFileSrc），scope 由 grant_asset_scope 运行时授权。
#[tauri::command]
fn set_cover(cover_dir: String, image_path: String) -> Result<String, String> {
    cover::set_cover(Path::new(&cover_dir), Path::new(&image_path))
        .map(|p| p.to_string_lossy().into_owned())
}

/// 把一个路径加进 asset 协议 scope（目录递归、文件单点）：库位置用户
/// 自选，静态 scope 留空、打开/新建库时现授权；自定义编辑器背景图
/// （库外文件）同理。
#[tauri::command]
fn grant_asset_scope(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let scope = app.asset_protocol_scope();
    let target = PathBuf::from(&path);
    if target.is_dir() {
        scope
            .allow_directory(&target, true)
            .map_err(|e| format!("无法授权目录访问：{e}"))
    } else {
        scope.allow_file(&target).map_err(|e| format!("无法授权文件访问：{e}"))
    }
}

/// 正文读入带版本指纹（ADR 0004）：保存时带回对账，防 Obsidian 抢写被静默覆盖。
#[tauri::command]
fn read_book_md(path: String) -> Result<MdContent, String> {
    book_file::read_book_md(Path::new(&path))
}

/// 打开书时的一次性迁移（工单 #30，spec 拆书保存与模板 §五）：yaml 四键
/// 非空值生成书档块插稿顶、yaml 四键删除（桥段/未知键/章前缀原样）。
/// 返回 md 是否被改写（true 时前端重读正文）；yaml 解析失败报 Err——
/// 前端只记警告不拦打开（读不懂的表拒绝改写）。
#[tauri::command]
fn migrate_book_header(md_path: String) -> Result<bool, String> {
    book_file::migrate_book_header(Path::new(&md_path))
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

/// 角色卡转生书内人物：建人物、卡片「关联」记去向（工单 #8）。
#[tauri::command]
fn transmute_character_card(
    root: String,
    card_path: String,
    project: String,
) -> Result<NoteEntry, String> {
    project::transmute_character_card(
        Path::new(&root),
        Path::new(&card_path),
        Path::new(&project),
    )
}

// --- 人物关系画布（工单 #8，docs/spec/人物关系画布.md）：构思/人物关系.yaml ---

/// 画布数据：图例 ＋ 画得出来的边 ＋ 失效引用/图例外的类型（只提示）。
/// 表坏了降级为缺省图例＋空表并带 warning，不拖垮画布。
#[tauri::command]
fn read_relationships(project: String) -> Result<RelationshipView, String> {
    Ok(relationship::relationship_view(Path::new(&project)))
}

/// 整表写（读-合-写：顶层未知键保留，ADR 0004 原子写）；返回重算后的视图。
#[tauri::command]
fn save_relationships(
    project: String,
    table: RelationshipTable,
) -> Result<RelationshipView, String> {
    let path = PathBuf::from(&project);
    relationship::save_table(&path, &table)?;
    Ok(relationship::relationship_view(&path))
}

/// 人物交汇（只读派生）：他们之间的边 ＋ 共同出现的单元（现扫，零结构）。
#[tauri::command]
fn character_confluence(project: String, names: Vec<String>) -> Result<Confluence, String> {
    relationship::character_confluence(Path::new(&project), &names)
}

/// 选中数人「提为矛盾」：建矛盾草稿（涉及人物＋边预填，不生成剧情内容）。
#[tauri::command]
fn promote_characters(
    project: String,
    names: Vec<String>,
    name: Option<String>,
) -> Result<NoteEntry, String> {
    relationship::promote_characters_to_contradiction(
        Path::new(&project),
        &names,
        name.as_deref(),
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

// --- 三线（工单 #7，docs/spec/期待感三线.md）：项目根 三线.yaml ---

#[tauri::command]
fn read_expectations(project: String) -> Result<Vec<Expectation>, String> {
    expectation::read_expectations(Path::new(&project))
}

/// 时间线看板：三线 ＋ 现扫正文算出的未推进章数/超期/引文失配。
#[tauri::command]
fn expectation_board(project: String) -> Result<ExpectationBoard, String> {
    expectation::expectation_board(Path::new(&project))
}

#[tauri::command]
fn add_expectation(
    project: String,
    name: String,
    kind: String,
    horizon: String,
) -> Result<Vec<Expectation>, String> {
    expectation::add_expectation(Path::new(&project), &name, &kind, &horizon)
}

#[tauri::command]
fn annotate_expectation(
    project: String,
    name: String,
    chapter: u32,
    quote: String,
    kind: String,
    horizon: String,
) -> Result<Vec<Expectation>, String> {
    expectation::annotate_expectation(Path::new(&project), &name, chapter, &quote, &kind, &horizon)
}

#[tauri::command]
fn fulfill_expectation(
    project: String,
    name: String,
    chapter: u32,
    quote: String,
    kind: String,
    note: Option<String>,
) -> Result<Vec<Expectation>, String> {
    expectation::fulfill_expectation(
        Path::new(&project),
        &name,
        chapter,
        &quote,
        &kind,
        note.as_deref(),
    )
}

#[tauri::command]
fn set_expectation_state(
    project: String,
    name: String,
    state: String,
) -> Result<Vec<Expectation>, String> {
    expectation::set_expectation_state(Path::new(&project), &name, &state)
}

#[tauri::command]
fn set_expectation_meta(
    project: String,
    name: String,
    kind: String,
    horizon: String,
) -> Result<Vec<Expectation>, String> {
    expectation::set_expectation_meta(Path::new(&project), &name, &kind, &horizon)
}

#[tauri::command]
fn delete_expectation(project: String, name: String) -> Result<Vec<Expectation>, String> {
    expectation::delete_expectation(Path::new(&project), &name)
}

// --- 导出与发布（工单 #14，docs/spec/导出与发布.md）：只读派生，只写项目内 导出/ ---

#[tauri::command]
fn load_export_templates(app: tauri::AppHandle) -> Result<Vec<ExportTemplate>, String> {
    export::load_templates(&export::templates_path(&app)?)
}

#[tauri::command]
fn save_export_templates(
    app: tauri::AppHandle,
    templates: Vec<ExportTemplate>,
) -> Result<(), String> {
    export::save_templates(&export::templates_path(&app)?, &templates)
}

#[tauri::command]
fn export_book(
    project: String,
    range: ChapterRange,
    template: ExportTemplate,
) -> Result<ExportReport, String> {
    export::export_book(Path::new(&project), range, &template)
}

/// 预览（不落盘）：看清清洗效果再决定导出。
#[tauri::command]
fn preview_export(
    project: String,
    range: ChapterRange,
    template: ExportTemplate,
) -> Result<String, String> {
    export::preview_export(Path::new(&project), range, &template)
}

/// 发布前校对：只读正文，词库取库根「校对/」（root 为空＝只用内置规则）。
#[tauri::command]
fn proofread_chapters(
    root: String,
    project: String,
    range: ChapterRange,
) -> Result<ProofReport, String> {
    proofread::proofread_chapters(Path::new(&root), Path::new(&project), range)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    export::reveal_path(Path::new(&path))
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

/// AI 命令的材料（工单 #15，docs/spec/AI命令集.md）：按固定口径从盘上现读
/// 组装成一段纯文本，只读不写；提示词在前端 ai.ts，两处各管一段。
/// `subjects`＝选中的人名，只有「人物关系梳理」用（工单 #8 §6.3）。
#[tauri::command]
fn build_ai_context(
    kind: String,
    project: String,
    chapter: Option<u32>,
    subjects: Option<Vec<String>>,
) -> Result<String, String> {
    ai_context::build_context(
        &kind,
        Path::new(&project),
        chapter,
        subjects.as_deref().unwrap_or(&[]),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AiState::default())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            create_book,
            open_book_template,
            is_empty_dir,
            set_cover,
            grant_asset_scope,
            read_book_md,
            migrate_book_header,
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
            transmute_character_card,
            read_relationships,
            save_relationships,
            character_confluence,
            promote_characters,
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
            read_expectations,
            expectation_board,
            add_expectation,
            annotate_expectation,
            fulfill_expectation,
            set_expectation_state,
            set_expectation_meta,
            delete_expectation,
            load_writing_stats,
            save_writing_stats,
            load_export_templates,
            save_export_templates,
            export_book,
            preview_export,
            proofread_chapters,
            reveal_path,
            load_ai_config,
            save_ai_config,
            list_chat_sessions,
            load_chat_session,
            save_chat_session,
            delete_chat_session,
            chat_stream,
            chat_cancel,
            build_ai_context
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
