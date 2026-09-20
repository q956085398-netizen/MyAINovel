//! 书写板块的章节文件（工单 #5，docs/spec/书写编辑器.md）。
//!
//! 一章一文件 `正文/<NNNN 标题>.md`（工单 #4 的布局）：扫描、新建/重命名/
//! 删除/重编号、双口径字数、保存前快照、单元区间反查、每日写作统计。
//! 保存复用 ADR 0004 的内容指纹闸；快照与统计都不是创作数据（可丢）。

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::book_file::{
    billed_word_count, content_fingerprint, file_stem_of, han_word_count, has_md_extension,
    is_hidden, read_text, scalar_to_string, snapshot_existing_file, snapshot_files,
    snapshot_restore_point, split_frontmatter, strip_bom, write_screenshot, write_text_atomic,
    SaveResult,
};
use crate::book_file::snapshot_dir as snapshot_dir_under;

pub const ATTACHMENT_DIR: &str = "附件";
pub const DEFAULT_DAILY_GOAL: u32 = 2000;
pub const STATUS_DRAFT: &str = "草稿";
pub const STATUS_DONE: &str = "完稿";

// ---------- 章节条目 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterEntry {
    pub path: PathBuf,
    pub file_name: String,
    /// 文件名里的章序；不合规文件（无数字前缀）为 None。
    pub ordinal: Option<u32>,
    pub title: String,
    /// 草稿｜完稿（缺省＝草稿）。
    pub status: String,
    /// 计费字数（去空白、含标点，不含 frontmatter）。
    pub word_count: u64,
    /// 纯汉字数（不含标点）。
    pub han_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStats {
    pub word_count: u64,
    pub han_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEntry {
    pub path: PathBuf,
    /// Unix 毫秒，列表按时间倒序。
    pub time: u64,
    pub word_count: u64,
}

/// 光标拆章的只读预览。确认时整个对象原样回传，其中的
/// 内容指纹是 ADR 0004 乐观锁的对账依据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSplitPreview {
    pub source_path: PathBuf,
    pub target_path: PathBuf,
    pub ordinal: u32,
    pub title: String,
    pub target_exists: bool,
    pub before: String,
    pub after: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterSplitResult {
    pub updated: ChapterEntry,
    pub created: ChapterEntry,
    pub fingerprint: String,
}

/// 联动侧栏的单元摘要（本章所在单元＋它在排布里的位置）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitBrief {
    pub name: String,
    pub core: Option<String>,
    pub types: Vec<String>,
    /// 单元整体情绪承诺；桥段局部情绪曲线另由本章意图读取。
    pub emotion_goal: Option<String>,
    pub body: String,
    pub start_chapter: Option<u32>,
    pub end_chapter: Option<u32>,
    /// 在排布.yaml 中的位次（1 起）；未排布＝None。
    pub index: Option<usize>,
    pub total: usize,
    pub line: Option<String>,
    pub map: Option<String>,
    pub upgrade_battle: Option<String>,
    pub pace: Option<String>,
}

pub fn chapters_dir(project: &Path) -> PathBuf {
    project.join(crate::project::TEXT_DIR)
}

// ---------- 字数口径 ----------

/// 章节双口径字数（实现见 book_file：全应用共用一套规则，前端有镜像）。
pub fn chapter_stats(content: &str) -> ChapterStats {
    ChapterStats {
        word_count: billed_word_count(content),
        han_count: han_word_count(content),
    }
}

// ---------- 扫描 ----------

/// 文件名 stem →（序数，标题）；无数字前缀返回 None。
fn parse_chapter_name(stem: &str) -> Option<(u32, String)> {
    let stem = stem.trim_start();
    let digits: String = stem.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let ordinal = digits.parse::<u32>().ok()?;
    Some((ordinal, stem[digits.len()..].trim_start().to_string()))
}

/// 章节文件名：四位零填充序数＋可选「 标题」。
fn chapter_file_name(ordinal: u32, title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        format!("{ordinal:04}.md")
    } else {
        format!("{ordinal:04} {title}.md")
    }
}

/// 章节标题清洗：Windows 非法字符换下划线、去尾部点与空格、限长 80 字。
/// 与构思笔记不同，**空标题合法**（文件就叫 `0007.md`）。
fn sanitize_title(raw: &str) -> String {
    let mut t: String = raw
        .trim()
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\t' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    while t.ends_with(['.', ' ']) {
        t.pop();
    }
    t.chars().take(80).collect()
}

fn read_status(content: &str) -> String {
    let Some((yaml, _)) = split_frontmatter(strip_bom(content)) else {
        return STATUS_DRAFT.to_string();
    };
    let Ok(Value::Mapping(map)) = serde_yaml::from_str::<Value>(&yaml) else {
        return STATUS_DRAFT.to_string();
    };
    let value = map
        .get(Value::String("状态".to_string()))
        .and_then(scalar_to_string)
        .map(|s| s.trim().to_string());
    match value.as_deref() {
        Some(STATUS_DONE) => STATUS_DONE.to_string(),
        _ => STATUS_DRAFT.to_string(),
    }
}

fn read_chapter_entry(path: &Path) -> ChapterEntry {
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (ordinal, title) = match parse_chapter_name(&stem) {
        Some((ordinal, title)) => (Some(ordinal), title),
        None => (None, stem),
    };
    let content = read_text(path).unwrap_or_default();
    let stats = chapter_stats(&content);
    ChapterEntry {
        path: path.to_path_buf(),
        file_name,
        ordinal,
        title,
        status: read_status(&content),
        word_count: stats.word_count,
        han_count: stats.han_count,
    }
}

/// 扫 `正文/`：按章序升序，未编号文件排最后（按文件名）。读失败的单章
/// 降级为空内容，不拖垮整个列表（与书库扫描同一纪律）。
pub fn scan_chapters(project: &Path) -> Result<Vec<ChapterEntry>, String> {
    let dir = chapters_dir(project);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<ChapterEntry> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) || !path.is_file() || !has_md_extension(&path) {
            continue;
        }
        out.push(read_chapter_entry(&path));
    }
    out.sort_by(|a, b| match (a.ordinal, b.ordinal) {
        (Some(x), Some(y)) => x.cmp(&y).then_with(|| a.file_name.cmp(&b.file_name)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.file_name.cmp(&b.file_name),
    });
    Ok(out)
}

// ---------- 新建 / 重命名 / 删除 / 重编号 ----------

/// 新建章：序＝现有合规序数最大值＋1（中间有洞也不撞号）。
pub fn create_chapter(project: &Path, title: &str) -> Result<ChapterEntry, String> {
    let dir = chapters_dir(project);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    let next = scan_chapters(project)?
        .iter()
        .filter_map(|c| c.ordinal)
        .max()
        .unwrap_or(0)
        .saturating_add(1);
    let path = dir.join(chapter_file_name(next, &sanitize_title(title)));
    if path.exists() {
        return Err(format!("{} 已存在", path.display()));
    }
    write_text_atomic(&path, "")?;
    Ok(read_chapter_entry(&path))
}

/// 重命名章：只改标题，序不动（未编号文件则改整名）。
pub fn rename_chapter(path: &Path, title: &str) -> Result<ChapterEntry, String> {
    let stem = path
        .file_stem()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target_name = match parse_chapter_name(&stem) {
        Some((ordinal, _)) => chapter_file_name(ordinal, &sanitize_title(title)),
        None => {
            let title = sanitize_title(title);
            if title.is_empty() {
                return Err("未编号的章节文件必须有标题".to_string());
            }
            format!("{title}.md")
        }
    };
    let dir = path
        .parent()
        .ok_or_else(|| format!("{} 没有父目录", path.display()))?;
    let target = dir.join(&target_name);
    if target == path {
        return Ok(read_chapter_entry(path));
    }
    if target.exists() {
        return Err(format!("{} 已存在", target.display()));
    }
    fs::rename(path, &target).map_err(|e| format!("无法重命名 {}：{e}", path.display()))?;
    Ok(read_chapter_entry(&target))
}

fn byte_index_at_utf16(content: &str, offset: usize) -> Option<usize> {
    let mut units = 0usize;
    for (byte, ch) in content.char_indices() {
        if units == offset {
            return Some(byte);
        }
        units += ch.len_utf16();
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(content.len())
}

fn body_start_byte(content: &str) -> Result<usize, String> {
    let stripped = strip_bom(content);
    if stripped.lines().next().is_some_and(|line| line.trim() == "---") {
        if split_frontmatter(stripped).is_none() {
            return Err("章节 frontmatter 未闭合，请先修复后再拆章".to_string());
        }
        let body = crate::book_file::body_after_frontmatter(content);
        return Ok(body.as_ptr() as usize - content.as_ptr() as usize);
    }
    Ok(0)
}

/// 只读预览：光标位置使用 CodeMirror/JavaScript 的 UTF-16 偏移。
pub fn preview_chapter_split(
    project: &Path,
    source: &Path,
    cursor_utf16: usize,
    title: &str,
) -> Result<ChapterSplitPreview, String> {
    if source.parent() != Some(chapters_dir(project).as_path()) {
        return Err("只能拆分当前项目正文目录里的章节".to_string());
    }
    let entry = read_chapter_entry(source);
    let ordinal = entry
        .ordinal
        .ok_or_else(|| "未编号章不能拆分，请先为它编号".to_string())?
        .checked_add(1)
        .ok_or_else(|| "章序已达上限，无法拆分".to_string())?;
    let bytes = fs::read(source).map_err(|e| format!("无法读取文件 {}：{e}", source.display()))?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let split_byte = byte_index_at_utf16(&content, cursor_utf16)
        .ok_or_else(|| "光标不在有效文本边界上".to_string())?;
    if split_byte < body_start_byte(&content)? {
        return Err("只能在章节正文位置拆章".to_string());
    }
    let title = sanitize_title(title);
    let target_path = chapters_dir(project).join(chapter_file_name(ordinal, &title));
    let target_exists = target_path.exists();
    Ok(ChapterSplitPreview {
        source_path: source.to_path_buf(),
        target_path,
        ordinal,
        title,
        target_exists,
        before: content[..split_byte].to_string(),
        after: content[split_byte..].to_string(),
        fingerprint: content_fingerprint(&bytes).to_string(),
    })
}

static SPLIT_PUBLISH_ID: AtomicU64 = AtomicU64::new(1);

#[cfg(windows)]
fn rename_new_atomic(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_WRITE_THROUGH: u32 = 0x0000_0008;
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // 不带 REPLACE_EXISTING：目标被外部程序抢先创建时必须失败。
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_WRITE_THROUGH) };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn rename_new_atomic(from: &Path, to: &Path) -> io::Result<()> {
    // 非 Windows 的便携回退：hard_link 同样具有 create-if-absent 语义，
    // 且只会把已完整写好的同目录临时文件发布为可见章节。
    fs::hard_link(from, to)?;
    fs::remove_file(from)
}

fn publish_new_chapter(path: &Path, content: &str) -> Result<(), String> {
    let id = SPLIT_PUBLISH_ID.fetch_add(1, Ordering::Relaxed);
    let stage = path.with_file_name(format!(".拆章发布-{}-{id}.tmp", std::process::id()));
    write_text_atomic(&stage, content)?;
    if let Err(e) = rename_new_atomic(&stage, path) {
        let _ = fs::remove_file(&stage);
        return Err(format!("无法发布新章 {}：{e}", path.display()));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SplitStep {
    SourceSnapshot,
    TargetSnapshot,
    TargetPublish,
    TargetPublished,
    SourceReplace,
}

fn split_chapter_with_hook<F>(
    project: &Path,
    preview: &ChapterSplitPreview,
    mut hook: F,
) -> Result<ChapterSplitResult, String>
where
    F: FnMut(SplitStep) -> Result<(), String>,
{
    if preview.source_path.parent() != Some(chapters_dir(project).as_path())
        || preview.target_path.parent() != Some(chapters_dir(project).as_path())
    {
        return Err("拆章路径不属于当前项目正文目录".to_string());
    }
    let expected_target = chapters_dir(project)
        .join(chapter_file_name(preview.ordinal, &sanitize_title(&preview.title)));
    if preview.target_path != expected_target {
        return Err("拆章目标文件名与预览不一致".to_string());
    }
    let old = fs::read(&preview.source_path)
        .map_err(|e| format!("无法读取文件 {}：{e}", preview.source_path.display()))?;
    if content_fingerprint(&old).to_string() != preview.fingerprint {
        return Err("原章在预览后已被外部修改，请重新加载并再次预览".to_string());
    }
    let current = String::from_utf8_lossy(&old);
    if format!("{}{}", preview.before, preview.after) != current {
        return Err("拆章预览内容与原章不一致，请重新预览".to_string());
    }
    if preview.target_path.exists() {
        return Err(format!("{} 已存在，不会覆盖", preview.target_path.display()));
    }

    // 恢复点是提交闸，不是事后尽力而为：任一快照无法完成时，
    // 两份正文都还没开始改动。空内容按全局快照纪律不落空文件。
    hook(SplitStep::SourceSnapshot)?;
    snapshot_restore_point(&snapshot_dir(project, &preview.source_path), &old)
    .map_err(|e| format!("无法建立原章恢复点，已取消拆章：{e}"))?;
    hook(SplitStep::TargetSnapshot)?;
    snapshot_restore_point(
        &snapshot_dir(project, &preview.target_path),
        preview.after.as_bytes(),
    )
    .map_err(|e| format!("无法建立新章恢复点，已取消拆章：{e}"))?;

    // 两条可见写路都复用同目录临时文件＋rename（ADR 0004）。
    // 原章在新章完整发布前始终留在原位；原章替换失败就撤回新章。
    hook(SplitStep::TargetPublish)?;
    publish_new_chapter(&preview.target_path, &preview.after)
        .map_err(|e| format!("无法创建新章：{e}"))?;
    let target_fingerprint = content_fingerprint(preview.after.as_bytes()).to_string();
    let rollback_target = |reason: String| -> Result<ChapterSplitResult, String> {
        let id = SPLIT_PUBLISH_ID.fetch_add(1, Ordering::Relaxed);
        let quarantine = preview.target_path.with_file_name(format!(
            ".拆章撤回-{}-{id}.md",
            std::process::id()
        ));
        if let Err(e) = fs::rename(&preview.target_path, &quarantine) {
            return Err(format!("{reason}；无法撤回新章：{e}"));
        }
        let owned = fs::read(&quarantine)
            .map(|bytes| content_fingerprint(&bytes).to_string() == target_fingerprint)
            .unwrap_or(false);
        if !owned {
            return match rename_new_atomic(&quarantine, &preview.target_path) {
                Ok(()) => Err(format!(
                    "{reason}；新章在撤回前已被外部修改，已原样恢复"
                )),
                Err(restore) => Err(format!(
                    "{reason}；外部修改内容已保留在 {}，恢复原名失败：{restore}",
                    quarantine.display()
                )),
            };
        }
        // 不直接删除：隔离文件不参与章节扫描，也使任何失败都有可恢复副本。
        Err(format!(
            "{reason}；新章已撤回，原章保持完整（恢复副本：{}）",
            quarantine.display()
        ))
    };
    if let Err(e) = hook(SplitStep::TargetPublished) {
        return rollback_target(format!("拆章提交已中止：{e}"));
    }
    // 外部程序若在发布新章后改了它，不再继续截断原章。
    let target_still_ours = fs::read(&preview.target_path)
        .map(|bytes| content_fingerprint(&bytes).to_string() == target_fingerprint)
        .unwrap_or(false);
    if !target_still_ours {
        return rollback_target("新章发布后已被外部修改，已取消原章替换".to_string());
    }
    if let Err(e) = hook(SplitStep::SourceReplace) {
        return rollback_target(format!("拆章提交已中止：{e}"));
    }
    match save_chapter_md(
        project,
        &preview.source_path,
        &preview.before,
        Some(&preview.fingerprint),
        false,
    ) {
        Ok(SaveResult::Saved { .. }) => {}
        Ok(SaveResult::Conflict) => {
            return rollback_target(
                "原章在预览后已被外部修改，请重新加载并再次预览".to_string(),
            );
        }
        Err(e) => return rollback_target(format!("无法替换原章：{e}")),
    }

    Ok(ChapterSplitResult {
        updated: read_chapter_entry(&preview.source_path),
        created: read_chapter_entry(&preview.target_path),
        fingerprint: content_fingerprint(preview.before.as_bytes()).to_string(),
    })
}

/// 确认拆章：两份结果先完整落到同目录临时文件，再提交；
/// 提交中途失败会删除新章并恢复原章，不留半成品。
pub fn split_chapter(
    project: &Path,
    preview: &ChapterSplitPreview,
) -> Result<ChapterSplitResult, String> {
    split_chapter_with_hook(project, preview, |_| Ok(()))
}

/// 删除章文件。快照留在 `.gongbi/历史/` 不删（文件没了还能手动取回）。
pub fn delete_chapter(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|e| format!("无法删除 {}：{e}", path.display()))
}

struct RenumberJob {
    path: PathBuf,
    ordinal: u32,
    title: String,
}

/// 重编号：把合规章节按当前顺序重排为 1..N（修手删造成的空洞）。
/// 目标名互相占位时先用点开头临时名让路；失败即中断报错。
pub fn renumber_chapters(project: &Path) -> Result<Vec<ChapterEntry>, String> {
    let dir = chapters_dir(project);
    let chapters = scan_chapters(project)?;
    let mut occupied: HashSet<String> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    let mut pending: Vec<RenumberJob> = Vec::new();
    let mut target = 0u32;
    for chapter in &chapters {
        if chapter.ordinal.is_none() {
            continue;
        }
        target += 1;
        if chapter.ordinal != Some(target) {
            pending.push(RenumberJob {
                path: chapter.path.clone(),
                ordinal: target,
                title: chapter.title.clone(),
            });
        }
    }

    let mut guard = 0usize;
    while !pending.is_empty() {
        guard += 1;
        if guard > 10_000 {
            return Err("重编号未收敛，已中止".to_string());
        }
        let mut progress = false;
        let mut i = 0;
        while i < pending.len() {
            let target_name = chapter_file_name(pending[i].ordinal, &pending[i].title);
            if occupied.contains(&target_name) {
                i += 1;
                continue;
            }
            let job = pending.remove(i);
            let dest = dir.join(&target_name);
            fs::rename(&job.path, &dest)
                .map_err(|e| format!("重编号失败（{}）：{e}", job.path.display()))?;
            if let Some(old) = job.path.file_name() {
                occupied.remove(&old.to_string_lossy().into_owned());
            }
            occupied.insert(target_name);
            progress = true;
        }
        if !progress {
            // 环：把第一个挪到临时名（点开头，扫描天然忽略），下一轮再落位。
            let job = pending.remove(0);
            let tmp_name = format!(".重编号-{:04}-{guard}.tmp", job.ordinal);
            let tmp_path = dir.join(&tmp_name);
            fs::rename(&job.path, &tmp_path)
                .map_err(|e| format!("重编号失败（{}）：{e}", job.path.display()))?;
            if let Some(old) = job.path.file_name() {
                occupied.remove(&old.to_string_lossy().into_owned());
            }
            occupied.insert(tmp_name);
            pending.push(RenumberJob {
                path: tmp_path,
                ..job
            });
        }
    }
    scan_chapters(project)
}

// ---------- 保存（指纹闸＋保存前快照） ----------

/// 章节快照目录：项目内 `.gongbi/历史/<章文件名>/`（收口在 book_file）。
pub fn snapshot_dir(project: &Path, chapter: &Path) -> PathBuf {
    snapshot_dir_under(project, &file_stem_of(chapter))
}

/// 章节保存：同一道指纹闸（ADR 0004），写盘前留快照。
pub fn save_chapter_md(
    project: &Path,
    path: &Path,
    content: &str,
    base: Option<&str>,
    force: bool,
) -> Result<SaveResult, String> {
    if !force {
        let matches_base = match fs::read(path) {
            Ok(bytes) => base.is_some_and(|b| *b == content_fingerprint(&bytes).to_string()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => base.is_none(),
            Err(e) => return Err(format!("无法读取文件 {}：{e}", path.display())),
        };
        if !matches_base {
            return Ok(SaveResult::Conflict);
        }
    }
    snapshot_existing_file(&snapshot_dir(project, path), path);
    write_text_atomic(path, content)?;
    Ok(SaveResult::Saved {
        fingerprint: content_fingerprint(content.as_bytes()).to_string(),
    })
}

/// 当前章的历史版本列表（时间倒序）。
pub fn list_chapter_snapshots(project: &Path, chapter: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let dir = snapshot_dir(project, chapter);
    let mut out: Vec<SnapshotEntry> = Vec::new();
    for path in snapshot_files(&dir) {
        if !has_md_extension(&path) {
            continue;
        }
        let time = fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let content = read_text(&path).unwrap_or_default();
        out.push(SnapshotEntry {
            path,
            time,
            word_count: chapter_stats(&content).word_count,
        });
    }
    out.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| b.path.cmp(&a.path)));
    Ok(out)
}

pub fn read_chapter_snapshot(path: &Path) -> Result<String, String> {
    read_text(path)
}

// ---------- 附件 ----------

/// 正文粘贴图片：落项目 `附件/`（#4 约定），返回从 `正文/` 出发的相对链接。
pub fn save_chapter_paste_image(project: &Path, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let dir = project.join(ATTACHMENT_DIR);
    let file_name = write_screenshot(&dir, ext, bytes)?;
    Ok(format!("../{ATTACHMENT_DIR}/{file_name}"))
}

// ---------- 联动侧栏：本章所在单元 ----------

/// 按单元 frontmatter 的「起章/止章」区间反查本章所属单元，并带上它在
/// 排布.yaml 里的位次与属性。区间只提示不校验（重叠时取先扫到的）。
pub fn find_unit_for_chapter(project: &Path, ordinal: u32) -> Result<Option<UnitBrief>, String> {
    let units = crate::project::scan_notes(project, crate::project::NoteKind::Unit)?;
    let Some(unit) = units.into_iter().find(|u| {
        let after_start = u.start_chapter.is_none_or(|s| ordinal >= s);
        let before_end = u.end_chapter.is_none_or(|e| ordinal <= e);
        (u.start_chapter.is_some() || u.end_chapter.is_some()) && after_start && before_end
    }) else {
        return Ok(None);
    };
    let arrangement = crate::project::read_arrangement(project).unwrap_or_default();
    let total = arrangement.len();
    let position = arrangement.iter().position(|a| a.unit == unit.name);
    let item = position.and_then(|i| arrangement.get(i));
    Ok(Some(UnitBrief {
        name: unit.name.clone(),
        core: unit.core.clone(),
        types: unit.types.clone(),
        emotion_goal: unit.emotion_goal.clone(),
        body: unit.body.clone(),
        start_chapter: unit.start_chapter,
        end_chapter: unit.end_chapter,
        index: position.map(|i| i + 1),
        total,
        line: item.and_then(|a| a.line.clone()),
        map: item.and_then(|a| a.map.clone()),
        upgrade_battle: item.and_then(|a| a.upgrade_battle.clone()),
        pace: item.and_then(|a| a.pace.clone()),
    }))
}

// ---------- 每日写作统计（应用状态，不进创作目录） ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WritingStats {
    #[serde(default = "default_daily_goal")]
    pub daily_goal: u32,
    /// 日期（YYYY-MM-DD）→ 当日净增量（可为负）。
    #[serde(default)]
    pub daily: BTreeMap<String, i64>,
}

fn default_daily_goal() -> u32 {
    DEFAULT_DAILY_GOAL
}

impl Default for WritingStats {
    fn default() -> Self {
        WritingStats {
            daily_goal: DEFAULT_DAILY_GOAL,
            daily: BTreeMap::new(),
        }
    }
}

pub fn load_writing_stats(path: &Path) -> Result<WritingStats, String> {
    if !path.is_file() {
        return Ok(WritingStats::default());
    }
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(WritingStats::default());
    }
    serde_json::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", path.display()))
}

pub fn save_writing_stats(path: &Path, stats: &WritingStats) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    }
    let text =
        serde_json::to_string_pretty(stats).map_err(|e| format!("无法生成统计 json：{e}"))?;
    write_text_atomic(path, &text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn project(root: &Path) -> PathBuf {
        let dir = root.join("项目/《大魏读书人》");
        fs::create_dir_all(dir.join("正文")).unwrap();
        dir
    }

    #[test]
    fn 扫描_按章序排序_未编号排最后() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0010 第十章.md"), "正文");
        write(&p.join("正文/0002 第二章.md"), "正文");
        write(&p.join("正文/随手记.md"), "杂记");
        write(&p.join("正文/.隐藏.md"), "看不见");
        write(&p.join("正文/非md.txt"), "不算");

        let list = scan_chapters(&p).unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].ordinal, Some(2));
        assert_eq!(list[0].title, "第二章");
        assert_eq!(list[1].ordinal, Some(10));
        assert_eq!(list[2].ordinal, None);
        assert_eq!(list[2].title, "随手记");
        assert_eq!(list[2].file_name, "随手记.md");
    }

    #[test]
    fn 扫描_空标题与四位填充都认() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0007.md"), "");
        let list = scan_chapters(&p).unwrap();
        assert_eq!(list[0].ordinal, Some(7));
        assert_eq!(list[0].title, "");
    }

    #[test]
    fn 状态_frontmatter缺省草稿_完稿认得出() {
        assert_eq!(read_status("正文而已"), "草稿");
        assert_eq!(read_status("---\n状态: 草稿\n---\n正文"), "草稿");
        assert_eq!(read_status("---\n状态: 完稿\n---\n正文"), "完稿");
        assert_eq!(read_status("---\n状态: 完稿\n乱写"), "草稿", "未闭合按草稿");
    }

    #[test]
    fn 字数_排除frontmatter_计费含标点_汉字不含() {
        let content = "---\n状态: 完稿\n---\n\n你好，世界！\n第二行。";
        let stats = chapter_stats(content);
        // 你好，世界！第二行。＝10 个非空白字符（含两个标点）
        assert_eq!(stats.word_count, 10);
        // 汉字：你好世界第二行 ＝ 7
        assert_eq!(stats.han_count, 7);
    }

    #[test]
    fn 字数_未闭合frontmatter整块不算() {
        let stats = chapter_stats("---\n状态: 草稿\n");
        assert_eq!(stats.word_count, 0);
        assert_eq!(stats.han_count, 0);
    }

    #[test]
    fn 字数_与前端同口径的边界() {
        // BOM 剥掉不算字、NEL(U+0085) 算空白（Unicode White_Space）
        assert_eq!(chapter_stats("\u{feff}a").word_count, 1);
        assert_eq!(chapter_stats("\u{85}a").word_count, 1);
        // 々、〇、扩展 B 都算汉字
        assert_eq!(chapter_stats("〇々\u{20000}").han_count, 3);
    }

    #[test]
    fn 新建章_取最大序加一_标题可空() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0002 旧章.md"), "正文");
        let created = create_chapter(&p, "新章").unwrap();
        assert_eq!(created.ordinal, Some(3));
        assert_eq!(created.file_name, "0003 新章.md");
        let blank = create_chapter(&p, "  ").unwrap();
        assert_eq!(blank.ordinal, Some(4));
        assert_eq!(blank.file_name, "0004.md");
    }

    #[test]
    fn 重命名_保序改标题_同序撞名报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 甲.md"), "甲");
        write(&p.join("正文/0002 乙.md"), "乙");
        let renamed = rename_chapter(&p.join("正文/0001 甲.md"), "甲改").unwrap();
        assert_eq!(renamed.file_name, "0001 甲改.md");
        assert_eq!(renamed.ordinal, Some(1), "序不动");
        write(&p.join("正文/0001 乙.md"), "占位");
        assert!(
            rename_chapter(&p.join("正文/0001 甲改.md"), "乙").is_err(),
            "同序同名已存在时报错"
        );
    }

    #[test]
    fn 重编号_补空洞_跳过未编号文件() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 甲.md"), "甲");
        write(&p.join("正文/0004 乙.md"), "乙");
        write(&p.join("正文/0009 丙.md"), "丙");
        write(&p.join("正文/随笔.md"), "不动");
        let list = renumber_chapters(&p).unwrap();
        let numbered: Vec<Option<u32>> = list.iter().map(|c| c.ordinal).collect();
        assert_eq!(numbered, vec![Some(1), Some(2), Some(3), None]);
        assert!(p.join("正文/0001 甲.md").is_file());
        assert!(p.join("正文/0002 乙.md").is_file());
        assert!(p.join("正文/0003 丙.md").is_file());
        assert!(p.join("正文/随笔.md").is_file());
    }

    #[test]
    fn 重编号_目标名互相占位也能收敛() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        // 空洞在最前：0002→0001、0003→0002，形成 0001 占位链
        write(&p.join("正文/0002 甲.md"), "甲");
        write(&p.join("正文/0003 乙.md"), "乙");
        let list = renumber_chapters(&p).unwrap();
        let numbered: Vec<Option<u32>> = list.iter().map(|c| c.ordinal).collect();
        assert_eq!(numbered, vec![Some(1), Some(2)]);
        assert!(p.join("正文/0001 甲.md").is_file());
        assert!(p.join("正文/0002 乙.md").is_file());
    }

    #[test]
    fn 保存_指纹闸拦外部修改_force覆盖_首次覆盖留快照() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let chapter = p.join("正文/0001 甲.md");
        write(&chapter, "第一版");
        let base = crate::book_file::read_book_md(&chapter).unwrap().fingerprint;

        let first = save_chapter_md(&p, &chapter, "第二版", Some(&base), false).unwrap();
        let fingerprint = match first {
            SaveResult::Saved { fingerprint } => fingerprint,
            SaveResult::Conflict => panic!("指纹对得上不该冲突"),
        };
        assert_eq!(read_text(&chapter).unwrap(), "第二版");
        let snapshots = list_chapter_snapshots(&p, &chapter).unwrap();
        assert_eq!(snapshots.len(), 1, "首次覆盖留下第一版快照");
        assert_eq!(read_chapter_snapshot(&snapshots[0].path).unwrap(), "第一版");

        // 盘上被外部改成第三版：带旧指纹保存判冲突，不写盘
        write(&chapter, "第三版");
        let conflicted = save_chapter_md(&p, &chapter, "第四版", Some(&fingerprint), false).unwrap();
        assert_eq!(conflicted, SaveResult::Conflict);
        assert_eq!(read_text(&chapter).unwrap(), "第三版");

        // force 覆盖成功；5 分钟节流内不再补快照（下一版由别的测试覆盖）
        save_chapter_md(&p, &chapter, "第四版", Some(&fingerprint), true).unwrap();
        assert_eq!(read_text(&chapter).unwrap(), "第四版");
        assert_eq!(list_chapter_snapshots(&p, &chapter).unwrap().len(), 1);
    }

    #[test]
    fn 拆章预览_章中分开并保留中文边界() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let chapter = p.join("正文/0003 夜宴.md");
        let content = "---\n状态: 完稿\n---\n\n前半章。\n后半章。";
        write(&chapter, content);
        let split_at = content.find("后半章").unwrap();
        let cursor_utf16 = content[..split_at].encode_utf16().count();

        let preview = preview_chapter_split(&p, &chapter, cursor_utf16, "风雨欲来").unwrap();

        assert_eq!(preview.ordinal, 4);
        assert_eq!(preview.title, "风雨欲来");
        assert_eq!(preview.target_path, p.join("正文/0004 风雨欲来.md"));
        assert_eq!(preview.before, "---\n状态: 完稿\n---\n\n前半章。\n");
        assert_eq!(preview.after, "后半章。");
        assert!(!preview.fingerprint.is_empty());
    }

    #[test]
    fn 拆章_章首章尾与空后半段都可提交() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());

        let at_start = p.join("正文/0001 甲.md");
        write(&at_start, "全部移走");
        let preview = preview_chapter_split(&p, &at_start, 0, "乙").unwrap();
        let result = split_chapter(&p, &preview).unwrap();
        assert_eq!(read_text(&at_start).unwrap(), "");
        assert_eq!(read_text(&result.created.path).unwrap(), "全部移走");

        let at_end = p.join("正文/0010 丙.md");
        write(&at_end, "全部保留");
        let preview = preview_chapter_split(&p, &at_end, "全部保留".encode_utf16().count(), "丁").unwrap();
        let result = split_chapter(&p, &preview).unwrap();
        assert_eq!(read_text(&at_end).unwrap(), "全部保留");
        assert_eq!(read_text(&result.created.path).unwrap(), "");
        assert_eq!(result.created.word_count, 0);
    }

    #[test]
    fn 拆章_目标重名与预览后外部修改都零写入() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let source = p.join("正文/0003 甲.md");
        let target = p.join("正文/0004 乙.md");
        write(&source, "前后");
        write(&target, "原第四章");

        let duplicate = preview_chapter_split(&p, &source, 1, "乙").unwrap();
        assert!(duplicate.target_exists, "重名也要先给出可改标题的预览");
        let duplicate_error = split_chapter(&p, &duplicate).unwrap_err();
        assert!(duplicate_error.contains("已存在"), "{duplicate_error}");
        assert_eq!(read_text(&source).unwrap(), "前后");
        assert_eq!(read_text(&target).unwrap(), "原第四章");

        let preview = preview_chapter_split(&p, &source, 1, "另一章").unwrap();
        write(&source, "外部改过");
        let err = split_chapter(&p, &preview).unwrap_err();
        assert!(err.contains("外部修改"), "{err}");
        assert_eq!(read_text(&source).unwrap(), "外部改过");
        assert!(!preview.target_path.exists());
    }

    #[test]
    fn 拆章_不允许在frontmatter内或未编号章执行() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let numbered = p.join("正文/0001 甲.md");
        write(&numbered, "---\n状态: 草稿\n---\n正文");
        let err = preview_chapter_split(&p, &numbered, 4, "乙").unwrap_err();
        assert!(err.contains("正文位置"), "{err}");

        let unnumbered = p.join("正文/随笔.md");
        write(&unnumbered, "正文");
        let err = preview_chapter_split(&p, &unnumbered, 1, "乙").unwrap_err();
        assert!(err.contains("未编号"), "{err}");
    }

    #[test]
    fn 拆章_新章已创建时失败会撤回并恢复原章() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let source = p.join("正文/0006 甲.md");
        write(&source, "前半后半");
        let preview = preview_chapter_split(&p, &source, 2, "乙").unwrap();

        let err = split_chapter_with_hook(&p, &preview, |step| {
            if step == SplitStep::TargetPublished {
                Err("注入的写入失败".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap_err();

        assert!(err.contains("新章已撤回"), "{err}");
        assert_eq!(read_text(&source).unwrap(), "前半后半");
        assert!(!preview.target_path.exists());
    }

    #[test]
    fn 拆章_新章发布后原章冲突会撤回新章且保留外部内容() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let source = p.join("正文/0008 甲.md");
        write(&source, "前半后半");
        let preview = preview_chapter_split(&p, &source, 2, "乙").unwrap();

        let err = split_chapter_with_hook(&p, &preview, |step| {
            if step == SplitStep::TargetPublished {
                write(&source, "外部在提交途中改动");
            }
            Ok(())
        })
        .unwrap_err();

        assert!(err.contains("外部修改"), "{err}");
        assert_eq!(read_text(&source).unwrap(), "外部在提交途中改动");
        assert!(!preview.target_path.exists());
    }

    #[test]
    fn 拆章_回滚前新章被外部改写时不会删除外部内容() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let source = p.join("正文/0009 甲.md");
        write(&source, "前半后半");
        let preview = preview_chapter_split(&p, &source, 2, "乙").unwrap();

        let err = split_chapter_with_hook(&p, &preview, |step| {
            if step == SplitStep::TargetPublished {
                write(&preview.target_path, "外部程序改写的新章");
                Err("迫使回滚".to_string())
            } else {
                Ok(())
            }
        })
        .unwrap_err();

        assert!(err.contains("已原样恢复"), "{err}");
        assert_eq!(read_text(&source).unwrap(), "前半后半");
        assert_eq!(
            read_text(&preview.target_path).unwrap(),
            "外部程序改写的新章"
        );
    }

    #[test]
    fn 拆章_各写入阶段失败都不改正文() {
        for failed_step in [
            SplitStep::SourceSnapshot,
            SplitStep::TargetSnapshot,
            SplitStep::TargetPublish,
            SplitStep::SourceReplace,
        ] {
            let tmp = TempDir::new().unwrap();
            let p = project(tmp.path());
            let source = p.join("正文/0012 甲.md");
            write(&source, "前半后半");
            let preview = preview_chapter_split(&p, &source, 2, "乙").unwrap();

            let err = split_chapter_with_hook(&p, &preview, |step| {
                if step == failed_step {
                    Err(format!("注入 {step:?} 失败"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();

            assert!(err.contains("注入"), "{failed_step:?}: {err}");
            assert_eq!(read_text(&source).unwrap(), "前半后半");
            assert!(!preview.target_path.exists(), "{failed_step:?}");
        }
    }

    #[test]
    fn 拆章_空后半章也有强制恢复点() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let source = p.join("正文/0020 甲.md");
        write(&source, "全部保留");
        let preview = preview_chapter_split(
            &p,
            &source,
            "全部保留".encode_utf16().count(),
            "乙",
        )
        .unwrap();

        split_chapter(&p, &preview).unwrap();

        let snapshots = list_chapter_snapshots(&p, &preview.target_path).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(read_chapter_snapshot(&snapshots[0].path).unwrap(), "");
    }

    #[test]
    fn 单元区间_反查本章所属单元与排布位次() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let unit = p.join("构思/单元/初入京城.md");
        write(
            &unit,
            "---\n核心矛盾: 混入新朝\n类型:\n- 掉马甲\n起章: 1\n止章: 20\n---\n\n1. 初入京城\n",
        );
        write(
            &p.join("构思/单元/宫变前夜.md"),
            "---\n起章: 21\n止章: 40\n---\n",
        );
        write(
            &p.join("构思/排布.yaml"),
            "- 单元: 初入京城\n  线: 主线\n  地图: 京城\n  升级战斗: 升级\n  节奏: 紧绷\n",
        );

        let brief = find_unit_for_chapter(&p, 7).unwrap().unwrap();
        assert_eq!(brief.name, "初入京城");
        assert_eq!(brief.core.as_deref(), Some("混入新朝"));
        assert_eq!(brief.index, Some(1));
        assert_eq!(brief.total, 1);
        assert_eq!(brief.line.as_deref(), Some("主线"));
        assert_eq!(brief.body.trim(), "1. 初入京城");

        let brief = find_unit_for_chapter(&p, 25).unwrap().unwrap();
        assert_eq!(brief.name, "宫变前夜");
        assert_eq!(brief.index, None, "没排布就没有位次");

        assert!(find_unit_for_chapter(&p, 99).unwrap().is_none());
    }

    #[test]
    fn 粘贴图片_落项目附件_回相对链接() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let rel = save_chapter_paste_image(&p, "png", &[1, 2, 3]).unwrap();
        assert_eq!(rel, "../附件/截图-1.png");
        assert!(p.join("附件/截图-1.png").is_file());
        let rel2 = save_chapter_paste_image(&p, "png", &[4]).unwrap();
        assert_eq!(rel2, "../附件/截图-2.png");
    }

    #[test]
    fn 每日统计_缺文件取默认_往返一致() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("书写/统计.json");
        let stats = load_writing_stats(&path).unwrap();
        assert_eq!(stats.daily_goal, DEFAULT_DAILY_GOAL);

        let mut stats = WritingStats::default();
        stats.daily.insert("2026-09-08".to_string(), 1234);
        save_writing_stats(&path, &stats).unwrap();
        let loaded = load_writing_stats(&path).unwrap();
        assert_eq!(loaded, stats);
    }
}
