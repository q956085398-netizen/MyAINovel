//! 拆书稿文件操作：正文读写、书级元数据（双文件制的 .yaml 侧）、
//! 粘贴截图落盘、下一章前缀计算。写入均走临时文件＋改名、长活缓冲
//! 覆盖保存带版本指纹对账（ADR 0004）。
//!
//! BookMeta 走 Tauri IPC（camelCase JSON）；yaml 侧键为中文且合并保留
//! 未知键——用户在 Obsidian 手补的字段不能被「书级资料」保存抹掉。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::library::{chapter_digits, is_chapter_heading};

/// 书级元数据 v0：字段按设计共识 §四的书级四项＋章前缀模板。
/// 最终 schema 由工单 #13 定稿。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub title: Option<String>,
    pub track_record: Option<String>,
    pub summary: Option<String>,
    pub golden_finger: Option<String>,
    pub chapter_prefix: Option<String>,
}

pub const DEFAULT_CHAPTER_PREFIX: &str = "第{n}章";

fn read_bytes(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("无法读取文件 {}：{e}", path.display()))
}

pub fn read_text(path: &Path) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_bytes(path)?).into_owned())
}

// --- 正文长活缓冲的版本指纹（ADR 0004）：读带出、存带回、不符即拦 ---

/// 正文内容＋载入时的版本指纹。指纹是内容哈希的字符串形态，
/// 前端当不透明令牌保管、保存时原样带回（避开 u64 超 JS 安全整数）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MdContent {
    pub content: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveResult {
    Saved { fingerprint: String },
    Conflict,
}

/// 内容指纹：字节数混入的 FNV-1a 64。用于覆盖保存前的对账（不是
/// 密码学场景），长度混入让「同哈希不同长」的构造只剩理论可能。
pub(crate) fn content_fingerprint(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 带指纹读正文：指纹算在原始字节上，盘上内容不变则不变。
pub fn read_book_md(path: &Path) -> Result<MdContent, String> {
    let bytes = read_bytes(path)?;
    Ok(MdContent {
        fingerprint: content_fingerprint(&bytes).to_string(),
        content: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// 带对账的覆盖保存（ADR 0004）：盘上指纹与 base 不符（外部程序改过、
/// 删过，或载入时不存在而期间被创建）一律判冲突拒绝写盘；force 跳过
/// 对账直接覆盖。保存成功返回新内容自身的指纹，供连续保存续带。
pub fn save_book_md(
    path: &Path,
    content: &str,
    base: Option<&str>,
    force: bool,
) -> Result<SaveResult, String> {
    if !force {
        let matches_base = match fs::read(path) {
            Ok(bytes) => base.is_some_and(|b| *b == content_fingerprint(&bytes).to_string()),
            // 载入时不存在（base 无指纹）而文件被外部创建，同样判冲突。
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => base.is_none(),
            Err(e) => return Err(format!("无法读取文件 {}：{e}", path.display())),
        };
        if !matches_base {
            return Ok(SaveResult::Conflict);
        }
    }
    write_text_atomic(path, content)?;
    Ok(SaveResult::Saved {
        fingerprint: content_fingerprint(content.as_bytes()).to_string(),
    })
}

/// 去掉正文开头的 BOM，避免遮蔽首行章标题。
pub(crate) fn strip_bom(content: &str) -> &str {
    content.strip_prefix('\u{feff}').unwrap_or(content)
}

// --- 字数口径（全应用共用：书库、项目、书写章节同一套，避免两套数） ---

/// 计费字数：非空白字符数（含标点，起点口径的近似）。
pub(crate) fn count_billed(text: &str) -> u64 {
    text.chars().filter(|c| !c.is_whitespace()).count() as u64
}

/// 纯汉字数：Han 脚本字符（含扩展区、部首补充、々/〇）。
pub(crate) fn count_han(text: &str) -> u64 {
    text.chars().filter(|c| is_han(*c)).count() as u64
}

/// Han 脚本码点区间（Unicode Scripts.txt；与前端 chapterFile.ts 的
/// 区间表保持一致——两边各一份，改一处要同步另一处）。
pub(crate) fn is_han(c: char) -> bool {
    matches!(
        c as u32,
        0x2E80..=0x2E99
            | 0x2E9B..=0x2EF3
            | 0x2F00..=0x2FD5
            | 0x3005
            | 0x3007
            | 0x3021..=0x3029
            | 0x3038..=0x303B
            | 0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2A6DF
            | 0x2A700..=0x2B739
            | 0x2B740..=0x2B81D
            | 0x2B820..=0x2CEA1
            | 0x2CEB0..=0x2EBE0
            | 0x2EBF0..=0x2EE5D
            | 0x30000..=0x3134A
            | 0x31350..=0x323AF
    )
}

/// 去掉开头 frontmatter 块后的正文（字数统计排除它）。未闭合时整块视为
/// frontmatter——写了一半的头部不该混进字数。
pub(crate) fn body_after_frontmatter(content: &str) -> &str {
    let content = strip_bom(content);
    let Some(first) = content.split('\n').next() else {
        return content;
    };
    if first.trim() != "---" {
        return content;
    }
    if content.len() == first.len() {
        return "";
    }
    let after_first = &content[first.len() + 1..];
    let mut offset = 0;
    for line in after_first.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']).trim() == "---" {
            return &after_first[offset + line.len()..];
        }
        offset += line.len();
    }
    ""
}

/// 正文内容的计费字数（去 frontmatter、去空白、含标点）。
pub(crate) fn billed_word_count(content: &str) -> u64 {
    count_billed(body_after_frontmatter(content))
}

/// 正文内容的纯汉字数（去 frontmatter）。
pub(crate) fn han_word_count(content: &str) -> u64 {
    count_han(body_after_frontmatter(content))
}

// --- yaml 底图读写：双文件制的 .yaml 侧共用（书级元数据、桥段列表都走这里） ---

/// yaml 读为映射底图：文件不存在视为空底；存在但解析失败返回 Err
/// （调用方须先把错误亮给用户，再决定是否覆盖写）。
pub(crate) fn read_yaml_mapping(yaml: &Path) -> Result<serde_yaml::Mapping, String> {
    if !yaml.is_file() {
        return Ok(serde_yaml::Mapping::new());
    }
    let text = read_text(yaml)?;
    let value: Value =
        serde_yaml::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", yaml.display()))?;
    Ok(value.as_mapping().cloned().unwrap_or_default())
}

/// 写侧用的宽松底图：任何读取/解析失败都按空底处理（保存即整文件覆盖）。
pub(crate) fn lossy_yaml_mapping(yaml: &Path) -> serde_yaml::Mapping {
    read_yaml_mapping(yaml).unwrap_or_default()
}

pub(crate) fn write_yaml_mapping(yaml: &Path, map: serde_yaml::Mapping) -> Result<(), String> {
    let text =
        serde_yaml::to_string(&Value::Mapping(map)).map_err(|e| format!("无法生成 yaml：{e}"))?;
    write_text_atomic(yaml, &text)
}

pub fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    write_bytes_atomic(path, content.as_bytes())
}

/// 字节版原子写（快照副本、粘贴图片等非字符串内容共用）。
pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_file_name(format!(
        "{}.gongbi.tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unnamed")
    ));
    if let Err(e) = fs::write(&tmp, bytes) {
        return Err(format!("无法写入临时文件 {}：{e}", tmp.display()));
    }
    // std 的 rename 在 Windows 上带 REPLACE_EXISTING，可直接覆盖。
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("无法保存文件 {}：{e}", path.display()));
    }
    Ok(())
}

pub(crate) fn sibling_yaml_path(md_path: &Path) -> PathBuf {
    let mut yaml = md_path.to_path_buf();
    yaml.set_extension("yaml");
    yaml
}

// --- 扫描与文件名的共用小工具（书库、灵感库、构思项目三处同一套约定） ---

/// 点名以「.」开头的文件/目录：扫描一律跳过（Obsidian 的 .obsidian 等）。
pub(crate) fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

pub(crate) fn has_md_extension(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

/// 目标文件名被占用时续号（标题-2、标题-3……）；self_path 即目标时
/// 不续（编辑既有文件不算冲突）。
pub(crate) fn unique_file_path(
    dir: &Path,
    file_name: &str,
    self_path: Option<&Path>,
) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() || Some(first.as_path()) == self_path {
        return first;
    }
    let stem = first
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "未命名".to_string());
    for n in 2.. {
        let candidate = dir.join(format!("{stem}-{n}.md"));
        if !candidate.exists() || Some(candidate.as_path()) == self_path {
            return candidate;
        }
    }
    unreachable!()
}

/// Windows 非法文件名字符替换为下划线、去尾部点与空格、限长 80 字；
/// 净化后没有任何字母/数字/汉字（空白、纯符号）报错。
pub(crate) fn sanitize_file_name(raw: &str) -> Result<String, String> {
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
    let t: String = t.chars().take(80).collect();
    if t.is_empty() || !t.chars().any(|c| c.is_alphanumeric()) {
        return Err("名称不能为空（或只剩符号）".to_string());
    }
    Ok(t)
}

// --- yaml 映射的读写小工具（书级 yaml、项目 yaml、frontmatter 共用） ---

/// 取标量键：去空白，空串按无处理（手写的 yaml 常见空值）。
pub(crate) fn map_scalar(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.get(Value::String(key.to_string()))
        .and_then(scalar_to_string)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 取列表键：yaml 列表逐项取标量；单个标量按分隔符拆（手写常见）。
pub(crate) fn map_list(map: &serde_yaml::Mapping, key: &str) -> Vec<String> {
    let Some(value) = map.get(Value::String(key.to_string())) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    match value {
        Value::Sequence(seq) => {
            for v in seq {
                if let Some(s) = scalar_to_string(v) {
                    push_split(&mut out, &s);
                }
            }
        }
        scalar => {
            if let Some(s) = scalar_to_string(scalar) {
                push_split(&mut out, &s);
            }
        }
    }
    out
}

pub(crate) fn set_map_scalar(map: &mut Mapping, key: &str, value: Option<&str>) {
    let k = Value::String(key.to_string());
    match value.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            map.insert(k, Value::String(s.to_string()));
        }
        None => {
            map.remove(&k);
        }
    }
}

/// 取可选整数键：标量能解析为 u32 才算（手写 yaml 可能是字符串形态）。
pub(crate) fn map_u32(map: &serde_yaml::Mapping, key: &str) -> Option<u32> {
    map_scalar(map, key).and_then(|s| s.parse::<u32>().ok())
}

pub(crate) fn set_map_u32(map: &mut Mapping, key: &str, value: Option<u32>) {
    let k = Value::String(key.to_string());
    match value {
        Some(v) => {
            map.insert(k, Value::Number(v.into()));
        }
        None => {
            map.remove(&k);
        }
    }
}

pub(crate) fn set_map_list(map: &mut Mapping, key: &str, values: &[String]) {
    let k = Value::String(key.to_string());
    let cleaned: Vec<Value> = values
        .iter()
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(|v| Value::String(v.to_string()))
        .collect();
    if cleaned.is_empty() {
        map.remove(&k);
    } else {
        map.insert(k, Value::Sequence(cleaned));
    }
}

/// 分隔符拆值并入列表（去重、保序）。
pub(crate) fn push_split(out: &mut Vec<String>, s: &str) {
    for part in s.split(['、', '，', ',', '；', ';', ' ', '\t']) {
        let p = part.trim();
        if !p.is_empty() && !out.iter().any(|t| t == p) {
            out.push(p.to_string());
        }
    }
}

// --- frontmatter 笔记文件（灵感卡、构思笔记共用）：yaml 头 + 自由正文 ---

/// frontmatter 块（起始 `---` 行到下一个 `---` 行）；不完整时返回 None。
/// 返回（yaml 文本带尾换行，正文文本）。
pub(crate) fn split_frontmatter(raw: &str) -> Option<(String, String)> {
    let mut lines = raw.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut yaml_lines: Vec<&str> = Vec::new();
    let mut body_lines: Option<Vec<&str>> = None;
    for line in lines {
        match body_lines.as_mut() {
            None => {
                if line.trim() == "---" {
                    body_lines = Some(Vec::new());
                } else {
                    yaml_lines.push(line);
                }
            }
            Some(body) => body.push(line),
        }
    }
    let body_lines = body_lines?;
    let yaml = if yaml_lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", yaml_lines.join("\n"))
    };
    let body = body_lines.join("\n");
    let body = body.strip_prefix('\n').unwrap_or(&body).to_string();
    Some((yaml, body))
}

/// 读文件的 frontmatter 映射；文件不存在、无 frontmatter 或解析失败返回 None
/// （调用方按空底处理，保存即重建——与灵感卡同一策略）。
pub(crate) fn frontmatter_mapping(path: &Path) -> Option<Mapping> {
    let raw = read_text(path).ok()?;
    let (yaml_text, _) = split_frontmatter(strip_bom(&raw))?;
    match serde_yaml::from_str::<Value>(&yaml_text) {
        Ok(Value::Mapping(map)) => Some(map),
        _ => None,
    }
}

/// 写 frontmatter＋正文：`---\nyaml---\n\n正文`；映射为空时只写正文
/// （避免落盘一个空的 `{}` 块）。整文件原子写（ADR 0004）。
pub(crate) fn write_frontmatter(path: &Path, map: Mapping, body: &str) -> Result<(), String> {
    let body = body.trim_start_matches('\n');
    if map.is_empty() {
        return write_text_atomic(path, body);
    }
    let yaml_text =
        serde_yaml::to_string(&Value::Mapping(map)).map_err(|e| format!("无法生成 yaml：{e}"))?;
    let content = if body.trim().is_empty() {
        format!("---\n{yaml_text}---\n")
    } else {
        format!("---\n{yaml_text}---\n\n{body}")
    };
    write_text_atomic(path, &content)
}

pub(crate) fn scalar_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn meta_scalar(map: &serde_yaml::Mapping, key: &str) -> Option<String> {
    map.get(Value::String(key.to_string()))
        .and_then(scalar_to_string)
}

fn mapping_set(map: &mut serde_yaml::Mapping, key: &str, value: Option<&str>) {
    let k = Value::String(key.to_string());
    match value {
        Some(s) => {
            let v = coerce_like(map.get(&k), s);
            map.insert(k, v);
        }
        None => {
            map.remove(&k);
        }
    }
}

/// 新值与旧值同形时保持标量类型：yaml 里的「成绩: 20000」
/// 不会因为走了一趟表单就变成带引号的 '20000'。
fn coerce_like(old: Option<&Value>, s: &str) -> Value {
    match old {
        Some(Value::Number(_)) => {
            if let Ok(i) = s.parse::<i64>() {
                return Value::Number(i.into());
            }
            if let Ok(f) = s.parse::<f64>() {
                return Value::Number(f.into());
            }
        }
        Some(Value::Bool(_)) => {
            if let Ok(b) = s.parse::<bool>() {
                return Value::Bool(b);
            }
        }
        _ => {}
    }
    Value::String(s.to_string())
}

/// 从 yaml 底图取书级四项＋章前缀（中文键）。供书库扫描复用，一次读盘两用。
pub(crate) fn meta_from_mapping(map: &serde_yaml::Mapping) -> BookMeta {
    BookMeta {
        title: meta_scalar(map, "书名"),
        track_record: meta_scalar(map, "成绩"),
        summary: meta_scalar(map, "简介"),
        golden_finger: meta_scalar(map, "金手指"),
        chapter_prefix: meta_scalar(map, "章前缀"),
    }
}

pub fn read_book_meta(md_path: &Path) -> Result<BookMeta, String> {
    let map = read_yaml_mapping(&sibling_yaml_path(md_path))?;
    Ok(meta_from_mapping(&map))
}

pub fn write_book_meta(md_path: &Path, meta: &BookMeta) -> Result<(), String> {
    let yaml = sibling_yaml_path(md_path);
    // 以现有 yaml 为底合并：未知键原样保留；解析失败的旧文件按空底处理
    // （前端在读到解析错误时会先警告）。
    let mut map = lossy_yaml_mapping(&yaml);
    mapping_set(&mut map, "书名", meta.title.as_deref());
    mapping_set(&mut map, "成绩", meta.track_record.as_deref());
    mapping_set(&mut map, "简介", meta.summary.as_deref());
    mapping_set(&mut map, "金手指", meta.golden_finger.as_deref());
    mapping_set(&mut map, "章前缀", meta.chapter_prefix.as_deref());
    write_yaml_mapping(&yaml, map)
}

/// 粘贴截图的落盘位置：一书一文件夹（拆书.md）用书内「附件/」；
/// 根目录散文件的 .md 与其他书同层，各建「附件/<书名>/」避免混放。
fn attachment_subdir(md_path: &Path) -> PathBuf {
    match md_path.file_name().and_then(|n| n.to_str()) {
        Some("拆书.md") => PathBuf::from("附件"),
        _ => PathBuf::from("附件").join(file_stem_of(md_path)),
    }
}

fn file_stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// 保存一张剪贴板图片，返回可直接嵌入 markdown 的相对路径（正斜杠）。
pub fn save_paste_image(md_path: &Path, ext: &str, bytes: &[u8]) -> Result<String, String> {
    let sub = attachment_subdir(md_path);
    let dir = md_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(&sub);
    let file_name = write_screenshot(&dir, ext, bytes)?;
    Ok(sub.join(&file_name).to_string_lossy().replace('\\', "/"))
}

/// 把剪贴板图片写进 dir，返回文件名「截图-N.ext」（按目录内现有编号递增，
/// 保证唯一）。拆书正文与书写正文的附件落点不同，写入本体共用这一份。
pub(crate) fn write_screenshot(dir: &Path, ext: &str, bytes: &[u8]) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|e| format!("无法创建附件文件夹 {}：{e}", dir.display()))?;

    let mut n: u32 = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().into_string().ok() else {
                continue;
            };
            let Some(stem) = name.strip_suffix(&format!(".{ext}")) else {
                continue;
            };
            if let Some(num) = stem.strip_prefix("截图-") {
                if let Ok(v) = num.parse::<u32>() {
                    n = n.max(v);
                }
            }
        }
    }
    n += 1;

    let file_name = format!("截图-{n}.{ext}");
    write_bytes_atomic(&dir.join(&file_name), bytes)?;
    Ok(file_name)
}

/// 下一章前缀：优先按模板自身匹配到的最大编号续号；模板没匹配到过
/// 时退回「第X章」式标题（阿拉伯章号优先，否则按章标题行数＋1）。
/// 前缀/字数统计都是粗略启发，不追求精确（设计共识 §四）。
pub fn next_chapter_line(content: &str, template: &str) -> String {
    let template = normalized_template(template);
    let Some((pre, suf)) = template.split_once("{n}") else {
        return template.to_string();
    };

    let mut max_num: Option<u64> = None;
    let mut count: u64 = 0;
    for line in strip_bom(content).lines() {
        let t = line.trim_start_matches(['#', ' ', '\t']);
        let tmpl_num = template_number(t, pre, suf);
        let is_heading = is_chapter_heading(line);
        if tmpl_num.is_some() || is_heading {
            count += 1;
            let num = tmpl_num.or_else(|| {
                if is_heading {
                    chapter_digits(line).and_then(arabic_value)
                } else {
                    None
                }
            });
            if let Some(v) = num {
                max_num = Some(max_num.map_or(v, |m: u64| m.max(v)));
            }
        }
    }
    let n = max_num.map_or(count + 1, |m| m + 1);
    format!("{pre}{n}{suf}")
}

/// 行首按模板前缀匹配章号；后缀为空时取行首连续（全角）数字。
fn template_number(line: &str, pre: &str, suf: &str) -> Option<u64> {
    let rest = line.strip_prefix(pre)?;
    if suf.is_empty() {
        let digits: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || ('０'..='９').contains(c))
            .collect();
        return arabic_value(&digits);
    }
    let end = rest.find(suf)?;
    arabic_value(&rest[..end])
}

fn normalized_template(template: &str) -> &str {
    // 只做空判回退，不裁剪：模板首尾空格可能是刻意的（如「Chapter {n}: 」）。
    if template.trim().is_empty() {
        DEFAULT_CHAPTER_PREFIX
    } else {
        template
    }
}

/// 章标题锚点：正文里第几个章标题（ordinal，1 起）及其原始行号。
/// 桥段标注的起止即用该序数——中文数字章号无法可靠转数值，序数对
/// 任意前缀模板都成立；列表展示口径同为序数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterAnchor {
    pub ordinal: u32,
    /// 去掉 # 前缀与首尾空白后的整行标题文本。
    pub title: String,
    /// 1 起行号。
    pub line: u32,
}

/// 列出正文中的章标题锚点。带 {n} 的模板匹配「模板式＋第X章式」两类
/// 标题（与续号同一套启发，见 next_chapter_line）；无占位符的模板按
/// 字面前缀匹配。
pub fn list_chapters(content: &str, template: &str) -> Vec<ChapterAnchor> {
    let template = normalized_template(template);
    let mut anchors: Vec<ChapterAnchor> = Vec::new();
    for (idx, line) in strip_bom(content).lines().enumerate() {
        let t = line.trim_start_matches(['#', ' ', '\t']);
        let is_start = match template.split_once("{n}") {
            Some((pre, suf)) => template_number(t, pre, suf).is_some() || is_chapter_heading(line),
            None => t.starts_with(template),
        };
        if is_start {
            anchors.push(ChapterAnchor {
                ordinal: anchors.len() as u32 + 1,
                title: t.trim().to_string(),
                line: idx as u32 + 1,
            });
        }
    }
    anchors
}

fn arabic_value(digits: &str) -> Option<u64> {
    let normalized: String = digits
        .chars()
        .map(|c| match c {
            '０'..='９' => char::from(b'0' + (c as u32 - '０' as u32) as u8),
            other => other,
        })
        .collect();
    normalized.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn 读写正文_往返一致() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "第一章\n旧内容");

        write_text_atomic(&md, "第一章\n新内容").unwrap();
        assert_eq!(read_text(&md).unwrap(), "第一章\n新内容");
        assert!(!root.join("书.md.gongbi.tmp").exists());
    }

    #[test]
    fn 指纹_ipc_走_camelCase_与标签形态() {
        let json = serde_json::to_string(&MdContent {
            content: "正文".into(),
            fingerprint: "42".into(),
        })
        .unwrap();
        assert!(json.contains("\"fingerprint\""));

        let saved = serde_json::to_string(&SaveResult::Saved {
            fingerprint: "7".into(),
        })
        .unwrap();
        assert!(saved.contains("\"status\":\"saved\""));
        assert!(saved.contains("\"fingerprint\":\"7\""));
        let conflict = serde_json::to_string(&SaveResult::Conflict).unwrap();
        assert!(conflict.contains("\"status\":\"conflict\""));
    }

    #[test]
    fn 保存_指纹相符_落盘并返回新指纹() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "旧内容");

        let loaded = read_book_md(&md).unwrap();
        assert_eq!(loaded.content, "旧内容");

        let result = save_book_md(&md, "新内容", Some(&loaded.fingerprint), false).unwrap();
        let SaveResult::Saved { fingerprint } = result else {
            panic!("指纹相符不该判冲突");
        };
        assert_eq!(read_text(&md).unwrap(), "新内容");
        // 连续保存不误报：带着上一次返回的新指纹再存。
        assert_eq!(
            save_book_md(&md, "再改", Some(&fingerprint), false).unwrap(),
            SaveResult::Saved {
                fingerprint: read_book_md(&md).unwrap().fingerprint
            }
        );
    }

    #[test]
    fn 保存_外部改过_判冲突不写盘() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "旧内容");

        let loaded = read_book_md(&md).unwrap();
        write(&md, "Obsidian 抢先保存的内容");

        assert_eq!(
            save_book_md(&md, "我的修改", Some(&loaded.fingerprint), false).unwrap(),
            SaveResult::Conflict
        );
        assert_eq!(read_text(&md).unwrap(), "Obsidian 抢先保存的内容");
    }

    #[test]
    fn 保存_force_跳过对账直接覆盖() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "外部内容");

        let result = save_book_md(&md, "以我为准", None, true).unwrap();
        assert!(matches!(result, SaveResult::Saved { .. }));
        assert_eq!(read_text(&md).unwrap(), "以我为准");
    }

    #[test]
    fn 保存_文件被外部删除_判冲突() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "旧内容");

        let loaded = read_book_md(&md).unwrap();
        fs::remove_file(&md).unwrap();

        assert_eq!(
            save_book_md(&md, "我的修改", Some(&loaded.fingerprint), false).unwrap(),
            SaveResult::Conflict
        );
    }

    #[test]
    fn 保存_载入时不存在() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        fs::create_dir_all(&root).unwrap();
        let md = root.join("新书.md");

        // 新文件首存：base 无指纹，正常落盘。
        assert!(matches!(
            save_book_md(&md, "第一笔", None, false).unwrap(),
            SaveResult::Saved { .. }
        ));
        assert_eq!(read_text(&md).unwrap(), "第一笔");

        // 载入时不存在、期间被外部创建：base 仍无指纹也判冲突。
        let md2 = root.join("被抢注.md");
        write(&md2, "别人的");
        assert_eq!(
            save_book_md(&md2, "我的", None, false).unwrap(),
            SaveResult::Conflict
        );
    }

    #[test]
    fn 元数据_ipc_走_camelCase() {
        let meta = BookMeta {
            title: Some("书名甲".into()),
            track_record: Some("均订 2 万".into()),
            golden_finger: Some("每日签到".into()),
            chapter_prefix: Some("第{n}章".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"trackRecord\""));
        assert!(json.contains("\"goldenFinger\""));
        let back: BookMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back, meta);
    }

    #[test]
    fn 元数据_缺省为空_写入后往返() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");

        assert_eq!(read_book_meta(&md).unwrap(), BookMeta::default());

        let meta = BookMeta {
            title: Some("书名甲".into()),
            track_record: Some("均订 2 万".into()),
            summary: Some("少年得金手指".into()),
            golden_finger: Some("每日签到".into()),
            chapter_prefix: Some("第{n}章".into()),
        };
        write_book_meta(&md, &meta).unwrap();

        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(yaml_text.contains("书名: 书名甲"));
        assert!(yaml_text.contains("金手指: 每日签到"));

        assert_eq!(read_book_meta(&md).unwrap(), meta);
    }

    #[test]
    fn 元数据_保留未知键与数字标量() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(
            &root.join("书.yaml"),
            "书名: 旧名\n成绩: 20000\n自定义键: 保留我\n",
        );

        let meta = read_book_meta(&md).unwrap();
        assert_eq!(meta.title.as_deref(), Some("旧名"));
        assert_eq!(meta.track_record.as_deref(), Some("20000"));

        let mut updated = meta.clone();
        updated.title = Some("新名".into());
        write_book_meta(&md, &updated).unwrap();

        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(yaml_text.contains("自定义键: 保留我"));
        assert!(yaml_text.contains("书名: 新名"));
        assert!(yaml_text.contains("成绩: 20000"));
    }

    #[test]
    fn 元数据_清空字段_移除键() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "书名: 旧名\n自定义键: 保留我\n");

        write_book_meta(&md, &BookMeta::default()).unwrap();
        let yaml_text = fs::read_to_string(root.join("书.yaml")).unwrap();
        assert!(!yaml_text.contains("书名:"));
        assert!(yaml_text.contains("自定义键: 保留我"));
    }

    #[test]
    fn 元数据_损坏_yaml_报错不静默() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书.md");
        write(&md, "");
        write(&root.join("书.yaml"), "{{{{不是 yaml");

        assert!(read_book_meta(&md).is_err());
    }

    #[test]
    fn 附件_一书一文件夹_落书内附件目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("《书》/拆书.md");
        write(&md, "");

        let rel = save_paste_image(&md, "png", b"png-bytes").unwrap();
        assert_eq!(rel, "附件/截图-1.png");
        assert_eq!(
            fs::read(root.join("《书》/附件/截图-1.png")).unwrap(),
            b"png-bytes"
        );

        let rel2 = save_paste_image(&md, "png", b"more").unwrap();
        assert_eq!(rel2, "附件/截图-2.png");
    }

    #[test]
    fn 附件_散文件_按书名分目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书乙.md");
        write(&md, "");

        let rel = save_paste_image(&md, "jpeg", b"jpg").unwrap();
        assert_eq!(rel, "附件/书乙/截图-1.jpeg");
        assert!(root.join("附件/书乙/截图-1.jpeg").is_file());
    }

    #[test]
    fn 下一章_默认模板_阿拉伯续号() {
        let content = "第1章\n正文\n## 第3章 标题\n正文";
        assert_eq!(next_chapter_line(content, DEFAULT_CHAPTER_PREFIX), "第4章");
    }

    #[test]
    fn 下一章_全角数字_按数值续号() {
        assert_eq!(next_chapter_line("第２０章\n", "第{n}章"), "第21章");
    }

    #[test]
    fn 下一章_中文数字_按行数续号() {
        assert_eq!(next_chapter_line("第一章\n第二章\n", "第{n}章"), "第3章");
    }

    #[test]
    fn 下一章_空文档_从第1章开始() {
        assert_eq!(next_chapter_line("", "第{n}章"), "第1章");
    }

    #[test]
    fn 下一章_自定义模板() {
        assert_eq!(next_chapter_line("第9章", "Chapter {n}: "), "Chapter 10: ");
    }

    #[test]
    fn 下一章_自定义模板_按模板自身续号() {
        assert_eq!(
            next_chapter_line("Chapter 1: 开\nChapter 9: 续", "Chapter {n}: "),
            "Chapter 10: "
        );
    }

    #[test]
    fn 下一章_模板无占位符_原样返回() {
        assert_eq!(next_chapter_line("x", "【场景】"), "【场景】");
    }

    #[test]
    fn 下一章_空模板_回退默认() {
        assert_eq!(next_chapter_line("第4章", ""), "第5章");
        assert_eq!(next_chapter_line("第4章", "   "), "第5章");
    }

    #[test]
    fn 下一章_bom_首行章号也参与续号() {
        assert_eq!(next_chapter_line("\u{feff}第4章\n", "第{n}章"), "第5章");
    }

    #[test]
    fn 章锚点_混合标题_按序数编号并记行号() {
        let content = "开场白\n第1章 甲\n正文\n## 第12章：乙\n正文提第三章不算\n第三章 丙";
        let anchors = list_chapters(content, DEFAULT_CHAPTER_PREFIX);
        let titles: Vec<&str> = anchors.iter().map(|a| a.title.as_str()).collect();
        assert_eq!(titles, vec!["第1章 甲", "第12章：乙", "第三章 丙"]);
        assert_eq!(anchors[0].line, 2);
        assert_eq!(anchors[1].line, 4);
        assert_eq!(anchors[2].line, 6);
    }

    #[test]
    fn 章锚点_自定义模板_兼容第x章式标题() {
        let content = "第1章 旧式\nChapter 2: 新式";
        let anchors = list_chapters(content, "Chapter {n}: ");
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[1].title, "Chapter 2: 新式");
    }

    #[test]
    fn 章锚点_无占位符模板_按字面前缀() {
        let content = "【场景】开场\n普通行\n【场景】转折";
        let anchors = list_chapters(content, "【场景】");
        assert_eq!(anchors.len(), 2);
        assert_eq!(anchors[1].ordinal, 2);
        assert_eq!(anchors[1].line, 3);
    }

    #[test]
    fn 章锚点_空文档_返回空() {
        assert!(list_chapters("", DEFAULT_CHAPTER_PREFIX).is_empty());
    }

    #[test]
    fn 章锚点_bom_不遮挡首行() {
        let anchors = list_chapters("\u{feff}第一章\n正文", DEFAULT_CHAPTER_PREFIX);
        assert_eq!(anchors.len(), 1);
        assert_eq!(anchors[0].line, 1);
    }
}
