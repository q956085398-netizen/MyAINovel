//! 导出与发布（工单 #14，docs/spec/导出与发布.md）。
//!
//! 导出是**只读派生动作**：读 `正文/` 与 `项目.yaml`，只写
//! `项目/《书名》/导出/`，永不改动创作文件（ADR 0002）；删掉导出目录
//! 重跑即得。渠道模板存应用状态（与 AI 供应商配置同款），不进创作目录。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::book_file::{
    billed_word_count, body_after_frontmatter, read_text, render_chapter_head, strip_bom,
    write_text_atomic,
};
use crate::chapter::{scan_chapters, ChapterEntry};

pub const EXPORT_DIR: &str = "导出";
pub const TEMPLATES_FILE: &str = "模板.json";
pub const FORMAT_TXT: &str = "txt";
pub const FORMAT_MD: &str = "md";
pub const DEFAULT_MIN_WORDS: u32 = 2000;
/// 预览截断长度（字符）：够看清清洗效果，又不至于把整本书搬进对话框。
const PREVIEW_CHARS: usize = 4000;

// ---------- 渠道模板 ----------

/// 命名导出配置。渠道模板是「平台习惯」不是「这本书的数据」，所以存
/// 应用状态、跨项目共用；章前缀始终取项目.yaml，模板不重复存。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTemplate {
    pub name: String,
    /// txt｜md。
    pub format: String,
    /// 是否补章节标题行（正文文件里没有标题，标题在文件名）。
    pub chapter_heading: bool,
    /// 标题模板，占位符 {章号}/{标题}；缺省＝「{章号} {标题}」。
    pub heading_template: Option<String>,
    /// 段间空行数（0｜1）。
    pub blank_lines: u8,
    /// 段首缩进两个全角空格。
    pub indent: bool,
    /// 单章字数提示下限（0＝不提示）。
    pub min_words: u32,
    /// 单章字数提示上限（0＝不限）。
    pub max_words: u32,
}

impl Default for ExportTemplate {
    fn default() -> Self {
        ExportTemplate {
            name: "默认".to_string(),
            format: FORMAT_TXT.to_string(),
            chapter_heading: true,
            heading_template: None,
            blank_lines: 1,
            // 工单 #33：默认勾选——复制到发布渠道后免逐段重缩进。
            indent: true,
            min_words: DEFAULT_MIN_WORDS,
            max_words: 0,
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct TemplateFile {
    #[serde(default)]
    templates: Vec<ExportTemplate>,
}

pub fn templates_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("定位应用数据目录失败：{e}"))?
        .join("导出");
    Ok(dir.join(TEMPLATES_FILE))
}

/// 读模板；没存过（或存成空表）时给一份内置「默认」。
pub fn load_templates(path: &Path) -> Result<Vec<ExportTemplate>, String> {
    if !path.is_file() {
        return Ok(vec![ExportTemplate::default()]);
    }
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(vec![ExportTemplate::default()]);
    }
    let file: TemplateFile =
        serde_json::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", path.display()))?;
    if file.templates.is_empty() {
        return Ok(vec![ExportTemplate::default()]);
    }
    Ok(file.templates)
}

pub fn save_templates(path: &Path, templates: &[ExportTemplate]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(&TemplateFile {
        templates: templates.to_vec(),
    })
    .map_err(|e| format!("无法生成模板 json：{e}"))?;
    write_text_atomic(path, &text)
}

// ---------- 范围与报告 ----------

/// 章节范围；from/to 全空＝全书。单章＝from==to（区间的一个特例）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChapterRange {
    pub from: Option<u32>,
    pub to: Option<u32>,
}

impl ChapterRange {
    pub fn contains(&self, ordinal: u32) -> bool {
        self.from.is_none_or(|f| ordinal >= f) && self.to.is_none_or(|t| ordinal <= t)
    }

    pub fn is_all(&self) -> bool {
        self.from.is_none() && self.to.is_none()
    }

    /// 文件名里的范围标记：全书｜0007｜0007-0020｜0007起｜至0020。
    fn label(&self) -> String {
        match (self.from, self.to) {
            (None, None) => "全书".to_string(),
            (Some(f), Some(t)) if f == t => format!("{f:04}"),
            (Some(f), Some(t)) => format!("{f:04}-{t:04}"),
            (Some(f), None) => format!("{f:04}起"),
            (None, Some(t)) => format!("至{t:04}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChapterReport {
    pub ordinal: u32,
    pub title: String,
    pub file_name: String,
    pub word_count: u64,
    /// 本章删掉的图片数（txt 渠道不能带图）。
    pub images_dropped: u32,
    /// 空章 / 字数越界 / frontmatter 未闭合等提示（只提示不拦截）。
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: PathBuf,
    pub format: String,
    pub chapter_count: u32,
    pub word_count: u64,
    pub chapters: Vec<ExportChapterReport>,
    /// 整体警告：未编号文件跳过等。
    pub warnings: Vec<String>,
}

// ---------- 清洗（txt 口径；纯函数，单测主体） ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Cleaned {
    pub body: String,
    pub images: u32,
    /// frontmatter 未闭合：整段按正文导出（不吞内容），由报告提示。
    pub unclosed_frontmatter: bool,
}

/// 去掉开头 frontmatter 块；未闭合时返回（整段内容, true）。
fn split_body(raw: &str) -> (&str, bool) {
    let content = strip_bom(raw);
    let first = content.split('\n').next().unwrap_or("");
    if first.trim() != "---" {
        return (content, false);
    }
    let closed = content
        .split_inclusive('\n')
        .skip(1)
        .any(|line| line.trim_end_matches(['\r', '\n']).trim() == "---");
    if closed {
        (body_after_frontmatter(content), false)
    } else {
        (content, true)
    }
}

/// 按模板清洗一章正文。md 只去 frontmatter；txt 另去 markdown 标记、
/// 规范化空行、可选段首缩进。
pub fn clean_body(raw: &str, template: &ExportTemplate) -> Cleaned {
    let (body, unclosed) = split_body(raw);
    let (body, images) = if template.format == FORMAT_MD {
        (body.trim_matches('\n').to_string(), 0)
    } else {
        clean_txt(body, template)
    };
    Cleaned {
        body,
        images,
        unclosed_frontmatter: unclosed,
    }
}

fn clean_txt(body: &str, template: &ExportTemplate) -> (String, u32) {
    let mut out: Vec<String> = Vec::new();
    let mut images = 0u32;
    for raw_line in body.lines() {
        let mut line = raw_line.trim_end().to_string();
        if line.trim_start().starts_with("```") {
            continue;
        }
        while line.trim_start().starts_with('>') {
            let t = line.trim_start();
            line = t[1..].trim_start().to_string();
        }
        line = strip_heading(&line);
        line = strip_list_marker(&line);
        let (stripped, dropped) = strip_links(&line);
        images += dropped;
        line = strip_emphasis(&stripped);
        line = line.trim_end().to_string();
        if line.trim().is_empty() {
            // 连续空行压成模板规定的段间空行数；开头的空行不留。
            if out.last().is_some_and(|prev| !prev.is_empty()) {
                for _ in 0..template.blank_lines {
                    out.push(String::new());
                }
            }
            continue;
        }
        if template.indent {
            line = format!("　　{line}");
        }
        out.push(line);
    }
    while out.last().is_some_and(|line| line.is_empty()) {
        out.pop();
    }
    (out.join("\n"), images)
}

/// `# 标题` → 标题；`#1`（井号后无空白）原样保留。
fn strip_heading(line: &str) -> String {
    let t = line.trim_start();
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if hashes > 0 && hashes <= 6 {
        let rest = &t[hashes..];
        if rest.is_empty() || rest.starts_with([' ', '\t']) {
            return rest.trim_start().to_string();
        }
    }
    line.to_string()
}

/// `- 项`/`1. 项`/`1、项` → 项；`——他说`、`---` 这类正文标点原样保留。
fn strip_list_marker(line: &str) -> String {
    let t = line.trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if !digits.is_empty() {
        let rest = &t[digits.len()..];
        if let Some(r) = rest
            .strip_prefix('.')
            .or_else(|| rest.strip_prefix(')'))
            .or_else(|| rest.strip_prefix('、'))
        {
            if r.is_empty() || r.starts_with([' ', '\t']) {
                return r.trim_start().to_string();
            }
        }
    }
    if let Some(r) = t
        .strip_prefix('-')
        .or_else(|| t.strip_prefix('*'))
        .or_else(|| t.strip_prefix('+'))
    {
        if r.is_empty() || r.starts_with([' ', '\t']) {
            return r.trim_start().to_string();
        }
    }
    line.to_string()
}

/// `[文字](链接)`/`[文字][引用]` → 文字；`![图](路径)` 整条删除并计数。
fn strip_links(line: &str) -> (String, u32) {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut images = 0u32;
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '!' && chars.get(i + 1) == Some(&'[') {
            if let Some((end, _)) = inline_link(&chars, i + 1) {
                images += 1;
                i = end;
                continue;
            }
        }
        if chars[i] == '[' {
            if let Some((end, text)) = inline_link(&chars, i) {
                out.push_str(&text);
                i = end;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, images)
}

/// 从 `[` 起解析 `[文字](目标)` 或 `[文字][引用]`，返回（结束下标, 文字）。
fn inline_link(chars: &[char], open: usize) -> Option<(usize, String)> {
    if chars.get(open) != Some(&'[') {
        return None;
    }
    let mut depth = 0usize;
    let mut close = None;
    for (i, c) in chars.iter().enumerate().skip(open) {
        match c {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(i);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let text: String = chars[open + 1..close].iter().collect();
    let end = match chars.get(close + 1)? {
        '(' => {
            let mut depth = 0usize;
            let mut end = None;
            for (i, c) in chars.iter().enumerate().skip(close + 1) {
                match c {
                    '(' => depth += 1,
                    ')' => {
                        depth -= 1;
                        if depth == 0 {
                            end = Some(i);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            end? + 1
        }
        '[' => {
            let end = chars
                .iter()
                .enumerate()
                .skip(close + 1)
                .find(|(_, c)| **c == ']')
                .map(|(i, _)| i)?;
            end + 1
        }
        _ => return None,
    };
    Some((end, text))
}

/// 去强调标记：**成对**出现的 `*`/`_`/`~`/`` ` `` 游程去掉，落单的保留
/// （网文里的打码、算式、分隔线都长成落单的样子）。下划线另守一条
/// CommonMark 规矩：词内下划线（`a_b_c`）不成标记。
fn strip_emphasis(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let marks = ['*', '_', '~', '`'];
    let drops: Vec<Vec<bool>> = marks
        .iter()
        .map(|mark| paired_marks(&chars, *mark))
        .collect();
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        let drop = marks
            .iter()
            .position(|mark| mark == c)
            .is_some_and(|slot| drops[slot][i]);
        if !drop {
            out.push(*c);
        }
    }
    out
}

/// 同一个标记字符的游程配对：能开的入栈、能闭的与最近的开口配成一对，
/// 配上的位置标 true（该去掉）。配不上的（落单）保持 false。
fn paired_marks(chars: &[char], marker: char) -> Vec<bool> {
    // （起点，长度，能开，能闭）
    let mut runs: Vec<(usize, usize, bool, bool)> = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != marker {
            i += 1;
            continue;
        }
        let mut len = 1usize;
        while chars.get(i + len) == Some(&marker) {
            len += 1;
        }
        let prev = i.checked_sub(1).map(|k| chars[k]);
        let next = chars.get(i + len).copied();
        let left_ws = prev.is_none_or(char::is_whitespace);
        let right_ws = next.is_none_or(char::is_whitespace);
        let (can_open, can_close) = if marker == '_' {
            // 词内下划线不算标记：开侧要求左边不是词字符，闭侧要求右边不是。
            (
                !right_ws && prev.is_none_or(|c| !c.is_alphanumeric()),
                !left_ws && next.is_none_or(|c| !c.is_alphanumeric()),
            )
        } else {
            (!right_ws, !left_ws)
        };
        runs.push((i, len, can_open, can_close));
        i += len;
    }

    let mut drop = vec![false; chars.len()];
    let mut stack: Vec<usize> = Vec::new();
    for (index, (start, len, can_open, can_close)) in runs.iter().enumerate() {
        if *can_close {
            if let Some(open) = stack.pop() {
                let (open_start, open_len, _, _) = runs[open];
                for slot in drop.iter_mut().skip(open_start).take(open_len) {
                    *slot = true;
                }
                for slot in drop.iter_mut().skip(*start).take(*len) {
                    *slot = true;
                }
                continue;
            }
        }
        if *can_open {
            stack.push(index);
        }
    }
    drop
}

// ---------- 组装与落盘 ----------

struct BuiltExport {
    content: String,
    title: String,
    chapters: Vec<ExportChapterReport>,
    warnings: Vec<String>,
}

/// 书名：项目.yaml 的「书名」优先，缺省取文件夹名（去《》），非法字符换下划线。
fn project_title(project: &Path) -> String {
    let meta_title = crate::project::read_project_meta(project)
        .ok()
        .and_then(|meta| meta.title);
    let raw = meta_title.unwrap_or_else(|| {
        project
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    let cleaned: String = raw
        .trim()
        .trim_start_matches('《')
        .trim_end_matches('》')
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned
    }
}

fn render_heading(entry: &ChapterEntry, prefix: Option<&str>, template: &ExportTemplate) -> String {
    let head = render_chapter_head(entry.ordinal.unwrap_or(0), prefix);
    let tpl = template
        .heading_template
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or("{章号} {标题}");
    tpl.replace("{章号}", &head)
        .replace("{标题}", entry.title.trim())
        .trim()
        .to_string()
}

/// 读盘、清洗、拼装（不落盘）；导出与预览共用。
fn build_export(
    project: &Path,
    range: ChapterRange,
    template: &ExportTemplate,
) -> Result<BuiltExport, String> {
    let chapters = scan_chapters(project)?;
    let prefix = crate::project::read_project_meta(project)
        .ok()
        .and_then(|meta| meta.chapter_prefix);
    let mut blocks: Vec<String> = Vec::new();
    let mut reports: Vec<ExportChapterReport> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for entry in &chapters {
        let Some(ordinal) = entry.ordinal else {
            warnings.push(format!(
                "「{}」没有章号前缀，不参与导出（要导出请改成 `0001 标题.md` 这样的名字）",
                entry.file_name
            ));
            continue;
        };
        if !range.contains(ordinal) {
            continue;
        }
        let raw = read_text(&entry.path).unwrap_or_default();
        let cleaned = clean_body(&raw, template);
        let body = cleaned.body.trim_matches('\n').to_string();
        let words = billed_word_count(&body);
        let mut notes: Vec<String> = Vec::new();
        if cleaned.unclosed_frontmatter {
            notes.push("frontmatter 未闭合，已整段按正文导出".to_string());
        }
        if cleaned.images > 0 {
            notes.push(format!("删除图片 {} 张", cleaned.images));
        }
        if words == 0 {
            notes.push("空章".to_string());
        } else {
            if template.min_words > 0 && words < u64::from(template.min_words) {
                notes.push(format!("低于模板下限 {} 字", template.min_words));
            }
            if template.max_words > 0 && words > u64::from(template.max_words) {
                notes.push(format!("超过模板上限 {} 字", template.max_words));
            }
        }
        let mut block = String::new();
        if template.chapter_heading {
            block.push_str(&render_heading(entry, prefix.as_deref(), template));
            block.push('\n');
        }
        block.push_str(&body);
        blocks.push(block);
        reports.push(ExportChapterReport {
            ordinal,
            title: entry.title.clone(),
            file_name: entry.file_name.clone(),
            word_count: words,
            images_dropped: cleaned.images,
            notes,
        });
    }

    if reports.is_empty() {
        return Err(if range.is_all() {
            "这本书还没有可导出的章节（未编号文件不参与导出）".to_string()
        } else {
            format!("范围 {} 里没有章节", range.label())
        });
    }
    let content = blocks.join(&"\n".repeat(1 + usize::from(template.blank_lines)));
    Ok(BuiltExport {
        content,
        title: project_title(project),
        chapters: reports,
        warnings,
    })
}

/// 导出到 `项目/《书名》/导出/`；同名不覆盖，续 -2、-3（截图命名同款）。
pub fn export_book(
    project: &Path,
    range: ChapterRange,
    template: &ExportTemplate,
) -> Result<ExportReport, String> {
    let built = build_export(project, range, template)?;
    let dir = project.join(EXPORT_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    let ext = if template.format == FORMAT_MD { "md" } else { "txt" };
    let stamp = chrono::Local::now().format("%Y%m%d").to_string();
    let base = format!("{}-{}-{stamp}", built.title, range.label());
    let mut path = dir.join(format!("{base}.{ext}"));
    for n in 2.. {
        if !path.exists() {
            break;
        }
        path = dir.join(format!("{base}-{n}.{ext}"));
    }
    write_text_atomic(&path, &built.content)?;
    Ok(ExportReport {
        path,
        format: template.format.clone(),
        chapter_count: built.chapters.len() as u32,
        word_count: built.chapters.iter().map(|c| c.word_count).sum(),
        chapters: built.chapters,
        warnings: built.warnings,
    })
}

/// 预览（不落盘）：返回前 PREVIEW_CHARS 个字符，截断时加省略提示。
pub fn preview_export(
    project: &Path,
    range: ChapterRange,
    template: &ExportTemplate,
) -> Result<String, String> {
    let built = build_export(project, range, template)?;
    if built.content.chars().count() <= PREVIEW_CHARS {
        return Ok(built.content);
    }
    let mut out: String = built.content.chars().take(PREVIEW_CHARS).collect();
    out.push_str("\n\n……（预览截断，完整内容见导出文件）");
    Ok(out)
}

// ---------- 打开导出目录 ----------

/// 在文件管理器里定位导出文件（Windows 用 explorer /select）。
pub fn reveal_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("{} 不存在", path.display()));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
            .map_err(|e| format!("无法打开文件管理器：{e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()
            .map_err(|e| format!("无法打开访达：{e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("无法打开文件管理器：{e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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

    /// 工单 #33 起默认模板「段首缩进」默认开；按「不缩进」口径断言的旧用例
    /// 显式关掉，不随默认值漂。
    fn no_indent() -> ExportTemplate {
        let mut t = ExportTemplate::default();
        t.indent = false;
        t
    }

    #[test]
    fn 清洗_去frontmatter与标记_保留正文() {
        let raw = "---\n状态: 完稿\n---\n\n# 第一节\n\n**粗**与*斜*，还有`码`。\n\n> 引用一句\n- 列表项\n1. 有序项\n\n[文字](https://x.com)与![截图](../附件/截图-1.png)";
        let cleaned = clean_body(raw, &no_indent());
        assert!(!cleaned.unclosed_frontmatter);
        assert_eq!(cleaned.images, 1);
        assert_eq!(
            cleaned.body,
            "第一节\n\n粗与斜，还有码。\n\n引用一句\n列表项\n有序项\n\n文字与"
        );
    }

    #[test]
    fn 清洗_落单标记保留_成对才去() {
        let cleaned = clean_body("傻*\n他说 *重要\n成对的**粗**去掉", &no_indent());
        assert_eq!(cleaned.body, "傻*\n他说 *重要\n成对的粗去掉");
    }

    #[test]
    fn 清洗_词边界单星号去标记() {
        let cleaned = clean_body("*斜体* 与 a_b_c", &no_indent());
        assert_eq!(cleaned.body, "斜体 与 a_b_c");
    }


    #[test]
    fn 清洗_空行压缩与段首缩进() {
        let mut template = ExportTemplate::default();
        template.indent = true;
        let cleaned = clean_body("甲\n\n\n\n乙\n", &template);
        assert_eq!(cleaned.body, "　　甲\n\n　　乙");
        template.blank_lines = 0;
        let cleaned = clean_body("甲\n\n乙\n", &template);
        assert_eq!(cleaned.body, "　　甲\n　　乙");
    }

    #[test]
    fn 清洗_分隔线与打码星号不被吃掉() {
        let cleaned = clean_body("他说***，然后\n---\n甲", &no_indent());
        assert_eq!(cleaned.body, "他说***，然后\n---\n甲");
    }

    #[test]
    fn 清洗_md格式只去frontmatter() {
        let mut template = ExportTemplate::default();
        template.format = FORMAT_MD.to_string();
        let cleaned = clean_body("---\n状态: 完稿\n---\n\n# 标题\n**粗**", &template);
        assert_eq!(cleaned.body, "# 标题\n**粗**");
        assert_eq!(cleaned.images, 0, "md 不删图片");
    }

    #[test]
    fn 清洗_frontmatter未闭合不吞内容() {
        let cleaned = clean_body("---\n状态: 草稿\n正文没了闭合", &ExportTemplate::default());
        assert!(cleaned.unclosed_frontmatter);
        assert!(cleaned.body.contains("正文没了闭合"));
    }

    #[test]
    fn 导出_全书_标题行与范围报告() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0002 初入江湖.md"), "甲甲甲");
        write(&p.join("正文/0001 醒来.md"), "乙乙乙");
        write(&p.join("正文/随手记.md"), "不参与");
        write(&p.join("项目.yaml"), "书名: 大魏读书人\n章前缀: 第{n}章\n");

        let report = export_book(&p, ChapterRange::default(), &no_indent()).unwrap();
        assert_eq!(report.chapter_count, 2);
        assert_eq!(report.chapters[0].ordinal, 1);
        assert_eq!(report.chapters[1].ordinal, 2);
        assert_eq!(report.warnings.len(), 1);
        assert!(report.warnings[0].contains("随手记"));
        let file_name = report.path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(file_name.starts_with("大魏读书人-全书-"), "{file_name}");
        assert!(file_name.ends_with(".txt"), "{file_name}");

        let text = fs::read_to_string(&report.path).unwrap();
        assert_eq!(text, "第1章 醒来\n乙乙乙\n\n第2章 初入江湖\n甲甲甲");
        assert!(report.path.starts_with(p.join(EXPORT_DIR)));
    }

    #[test]
    fn 导出_区间与单章_文件名与内容只含选中章() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        for n in 1..=3 {
            write(&p.join(format!("正文/{n:04} 第{n}章.md")), &format!("正文{n}"));
        }
        let range = ChapterRange {
            from: Some(2),
            to: Some(3),
        };
        let report = export_book(&p, range, &ExportTemplate::default()).unwrap();
        assert_eq!(report.chapter_count, 2);
        assert!(report
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("大魏读书人-0002-0003-"));
        let text = fs::read_to_string(&report.path).unwrap();
        assert!(!text.contains("正文1"));
        assert!(text.contains("正文2") && text.contains("正文3"));

        let single = ChapterRange {
            from: Some(2),
            to: Some(2),
        };
        let report = export_book(&p, single, &ExportTemplate::default()).unwrap();
        assert_eq!(report.chapter_count, 1);
        assert!(report
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("-0002-"));
    }

    #[test]
    fn 导出_同名不覆盖_续号() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 甲.md"), "甲");
        let first = export_book(&p, ChapterRange::default(), &ExportTemplate::default()).unwrap();
        let second = export_book(&p, ChapterRange::default(), &ExportTemplate::default()).unwrap();
        assert_ne!(first.path, second.path);
        assert!(second
            .path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("-2.txt"));
        assert!(first.path.is_file() && second.path.is_file());
    }

    #[test]
    fn 导出_字数越界与空章只提示不拦截() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 空.md"), "---\n状态: 草稿\n---\n");
        write(&p.join("正文/0002 短.md"), "太短了");
        let report = export_book(&p, ChapterRange::default(), &ExportTemplate::default()).unwrap();
        assert_eq!(report.chapter_count, 2);
        assert!(report.chapters[0].notes.iter().any(|n| n == "空章"));
        assert!(report.chapters[1]
            .notes
            .iter()
            .any(|n| n.contains("低于模板下限")));
    }

    #[test]
    fn 导出_标题模板与关闭标题行() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0007 初入江湖.md"), "正文");
        let mut template = no_indent();
        template.heading_template = Some("{标题}｜{章号}".to_string());
        let report = export_book(&p, ChapterRange::default(), &template).unwrap();
        let text = fs::read_to_string(&report.path).unwrap();
        assert!(text.starts_with("初入江湖｜第7章\n正文"));

        template.chapter_heading = false;
        let report = export_book(&p, ChapterRange::default(), &template).unwrap();
        assert_eq!(fs::read_to_string(&report.path).unwrap(), "正文");
    }

    #[test]
    fn 导出_范围内没有章节报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 甲.md"), "甲");
        let range = ChapterRange {
            from: Some(9),
            to: Some(10),
        };
        assert!(export_book(&p, range, &ExportTemplate::default()).is_err());
    }

    #[test]
    fn 预览_截断加提示_不落盘() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&p.join("正文/0001 甲.md"), &"字".repeat(PREVIEW_CHARS + 100));
        let text = preview_export(&p, ChapterRange::default(), &ExportTemplate::default()).unwrap();
        assert!(text.ends_with("……（预览截断，完整内容见导出文件）"));
        assert!(!p.join(EXPORT_DIR).exists(), "预览不写盘");
    }

    #[test]
    fn 模板_缺文件给默认_往返一致() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("导出/模板.json");
        let defaults = load_templates(&path).unwrap();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].name, "默认");
        assert_eq!(defaults[0].format, FORMAT_TXT);

        let custom = ExportTemplate {
            name: "起点".to_string(),
            format: FORMAT_TXT.to_string(),
            chapter_heading: true,
            heading_template: Some("{章号} {标题}".to_string()),
            blank_lines: 1,
            indent: true,
            min_words: 2000,
            max_words: 20000,
        };
        save_templates(&path, &[custom.clone()]).unwrap();
        assert_eq!(load_templates(&path).unwrap(), vec![custom]);
    }

    #[test]
    fn 书名_取项目yaml_缺省文件夹名() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        assert_eq!(project_title(&p), "大魏读书人");
        write(&p.join("项目.yaml"), "书名: 大魏读书人\n");
        assert_eq!(project_title(&p), "大魏读书人");
        // 文件名非法字符换下划线，书名本身不被截断
        write(&p.join("项目.yaml"), "书名: \"带*星号: 的书名\"\n");
        assert_eq!(project_title(&p), "带_星号_ 的书名");
    }

    #[test]
    fn 导出_ipc_走_camelCase_与前端字段对齐() {
        let range: ChapterRange = serde_json::from_str(r#"{"from":3,"to":null}"#).unwrap();
        assert!(range.contains(3) && !range.contains(2), "缺字段按不限处理");

        let template: ExportTemplate = serde_json::from_str(
            r#"{"name":"默认","format":"txt","chapterHeading":true,"headingTemplate":null,
                "blankLines":1,"indent":true,"minWords":2000,"maxWords":0}"#,
        )
        .unwrap();
        assert_eq!(template, ExportTemplate::default());

        let report = ExportReport {
            path: PathBuf::from("导出/甲-全书-20260910.txt"),
            format: FORMAT_TXT.to_string(),
            chapter_count: 1,
            word_count: 3,
            chapters: vec![ExportChapterReport {
                ordinal: 1,
                title: "甲".to_string(),
                file_name: "0001 甲.md".to_string(),
                word_count: 3,
                images_dropped: 0,
                notes: Vec::new(),
            }],
            warnings: Vec::new(),
        };
        let value = serde_json::to_value(&report).unwrap();
        for key in ["path", "format", "chapterCount", "wordCount", "chapters", "warnings"] {
            assert!(value.get(key).is_some(), "缺字段 {key}");
        }
        for key in ["ordinal", "title", "fileName", "wordCount", "imagesDropped", "notes"] {
            assert!(value["chapters"][0].get(key).is_some(), "章报告缺字段 {key}");
        }
    }
}
