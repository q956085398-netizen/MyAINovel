//! 拆书稿文件操作：正文读写、书级元数据（双文件制的 .yaml 侧）、
//! 粘贴截图落盘、下一章前缀计算。写入均走临时文件＋改名、长活缓冲
//! 覆盖保存带版本指纹对账（ADR 0004）、覆盖前留历史快照（书写章节
//! 的快照也收口在这里，工单 #28）。
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
    snapshot_existing_file(&book_snapshot_dir(path), path);
    write_text_atomic(path, content)?;
    Ok(SaveResult::Saved {
        fingerprint: content_fingerprint(content.as_bytes()).to_string(),
    })
}

// --- 覆盖前快照（工单 #28）：拆书稿与书写章节同一套机制 ---

/// 快照根目录（点开头，Obsidian 与全部扫描天然忽略）。
pub const SNAPSHOT_ROOT: &str = ".gongbi";
pub const SNAPSHOT_DIR: &str = "历史";
pub const MAX_SNAPSHOTS: usize = 200;
/// 两次快照的最小间隔（自动保存频繁，防额度被十几分钟耗光）。
pub const SNAPSHOT_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(300);

/// 快照目录：base 下 `.gongbi/历史/<key>/`。书写章＝项目根＋章文件名；
/// 拆书稿＝书文件夹（或库根散文件）＋文件名 stem。
pub fn snapshot_dir(base: &Path, key: &str) -> PathBuf {
    base.join(SNAPSHOT_ROOT).join(SNAPSHOT_DIR).join(key)
}

/// 拆书稿快照目录：随 md 所在目录——一书一文件夹＝书内 `.gongbi/历史/<stem>/`，
/// 库根散文件书＝库根 `.gongbi/历史/<书名>/`（spec 拆书保存与模板 §二）。
fn book_snapshot_dir(md_path: &Path) -> PathBuf {
    snapshot_dir(
        md_path.parent().unwrap_or_else(|| Path::new(".")),
        &file_stem_of(md_path),
    )
}

/// 覆盖前把盘上旧内容留一份快照（读不到旧文件＝首存，不留）。
/// 失败只记日志——两条保存路径（拆书稿/书写章）共用这一段。
pub(crate) fn snapshot_existing_file(dir: &Path, path: &Path) {
    if let Ok(old) = fs::read(path) {
        if let Err(e) = snapshot_before_overwrite(dir, &old) {
            eprintln!("快照失败（不影响保存）：{e}");
        }
    }
}

/// 目录内的快照文件，按（修改时间，文件名）升序——取最新用 `pop()`。
pub(crate) fn snapshot_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && has_md_extension(p))
        .map(|path| {
            let time = fs::metadata(&path)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
            (time, path)
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    files.into_iter().map(|(_, path)| path).collect()
}

/// 覆盖前留一份「被覆盖的上一版」；与最近一份快照内容相同则跳过。
/// 失败不阻断保存——快照是保险，不是闸。
pub(crate) fn snapshot_before_overwrite(dir: &Path, old_bytes: &[u8]) -> Result<(), String> {
    snapshot_with_gap(dir, old_bytes, SNAPSHOT_MIN_GAP)
}

/// 快照节流：自动保存每几秒写盘一次，逐次留快照会在十几分钟内把
/// 200 份额度耗尽——两次快照至少隔 min_gap；空白内容（刚建的空稿）不留。
pub(crate) fn snapshot_with_gap(
    dir: &Path,
    old_bytes: &[u8],
    min_gap: std::time::Duration,
) -> Result<(), String> {
    if String::from_utf8_lossy(old_bytes).trim().is_empty() {
        return Ok(());
    }
    if let Some(latest) = snapshot_files(dir).pop() {
        if fs::read(&latest).map(|b| b == old_bytes).unwrap_or(false) {
            return Ok(());
        }
        if min_gap > std::time::Duration::ZERO {
            let too_soon = fs::metadata(&latest)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age < min_gap);
            if too_soon {
                return Ok(());
            }
        }
    }
    fs::create_dir_all(dir).map_err(|e| format!("无法创建历史目录 {}：{e}", dir.display()))?;
    // 毫秒级时间戳：同一秒内连存也保持字典序，且碰撞几乎不可能。
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S%3f").to_string();
    let mut name = format!("{stamp}.md");
    for n in 2.. {
        if !dir.join(&name).exists() {
            break;
        }
        name = format!("{stamp}-{n}.md");
    }
    write_bytes_atomic(&dir.join(&name), old_bytes)?;
    thin_snapshots(dir);
    Ok(())
}

/// 只留最近 MAX_SNAPSHOTS 份，超出删最旧。
pub(crate) fn thin_snapshots(dir: &Path) {
    let files = snapshot_files(dir);
    let overflow = files.len().saturating_sub(MAX_SNAPSHOTS);
    for path in files.into_iter().take(overflow) {
        let _ = fs::remove_file(path);
    }
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

// --- 书档（工单 #30，spec 拆书保存与模板 §四/§五）：书级四项上纸面 ---

/// 书档四项：`> [!书档]` 块里键名行（`书名：`等起始行）的解析面，
/// 书库列表取数与表单编辑共用。章前缀不入书档——它是全局设置（spec §六）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookHeader {
    pub title: Option<String>,
    pub track_record: Option<String>,
    pub summary: Option<String>,
    pub golden_finger: Option<String>,
}

/// yaml 侧车里迁往书档的四个键；桥段、章前缀与未知键不在此列。
const HEADER_YAML_KEYS: [&str; 4] = ["书名", "成绩", "简介", "金手指"];

/// 行的块引用体（去行首空白、`>` 与其后空白）；非引用行返回 None。
fn quote_body(line: &str) -> Option<&str> {
    let line = line.trim_start_matches([' ', '\t', '\u{feff}']);
    let rest = line.strip_prefix('>')?;
    Some(rest.trim_start_matches(' '))
}

/// callout 首行引用体里 `[!类型]` 的类型名；折叠标记 `-`/`+` 容忍。
fn callout_type(quote_body: &str) -> Option<&str> {
    let rest = quote_body.trim_start().strip_prefix("[!")?;
    let end = rest.find(']')?;
    let name = rest[..end].strip_suffix(['-', '+']).unwrap_or(&rest[..end]);
    (!name.is_empty()).then_some(name)
}

/// 正文里第一个书档块的（起、止）行号（1 起）：块＝自 `> [!书档]` 行起
/// 连续的引用行；非书档的引用块整块跳过（callout 标记只在块首才算）。
fn find_book_header_lines(content: &str) -> Option<(usize, usize)> {
    let lines: Vec<&str> = strip_bom(content).lines().collect();
    let mut idx = 0;
    while idx < lines.len() {
        if quote_body(lines[idx]).is_some() {
            let start = idx;
            while idx + 1 < lines.len() && quote_body(lines[idx + 1]).is_some() {
                idx += 1;
            }
            if callout_type(quote_body(lines[start]).unwrap_or("")) == Some("书档") {
                return Some((start + 1, idx + 1));
            }
        }
        idx += 1;
    }
    None
}

/// 键名行：四个键之一起始（全角/半角冒号均可），返回（键，值）。
fn header_key_line(body: &str) -> Option<(&'static str, &str)> {
    for key in HEADER_YAML_KEYS {
        if let Some(rest) = body.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix('：').or_else(|| rest.strip_prefix(':')) {
                return Some((key, value.trim()));
            }
        }
    }
    None
}

/// 解析书档四项：首个书档块的键名行——重复键取首见、空值不算，
/// 非键名行是自由备注不参与（约定换自由，spec §四）。无书档块返回 None。
pub fn parse_book_header(content: &str) -> Option<BookHeader> {
    let (start, end) = find_book_header_lines(content)?;
    let mut header = BookHeader::default();
    let mut seen: Vec<&str> = Vec::new();
    for line in strip_bom(content).lines().take(end).skip(start - 1) {
        let Some((key, value)) = quote_body(line).and_then(header_key_line) else {
            continue;
        };
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        let slot = match key {
            "书名" => &mut header.title,
            "成绩" => &mut header.track_record,
            "简介" => &mut header.summary,
            _ => &mut header.golden_finger,
        };
        *slot = (!value.is_empty()).then(|| value.to_string());
    }
    Some(header)
}

/// 由四项生成书档块文本（只落非空项，块自带尾换行、不带分隔空行）。
fn book_header_block_text(header: &BookHeader) -> String {
    let mut block = String::from("> [!书档]\n");
    for (key, value) in [
        ("书名", &header.title),
        ("成绩", &header.track_record),
        ("简介", &header.summary),
        ("金手指", &header.golden_finger),
    ] {
        if let Some(v) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            block.push_str("> ");
            block.push_str(key);
            block.push('：');
            block.push_str(v);
            block.push('\n');
        }
    }
    block
}

/// 书档块插到稿顶（BOM 之后），与原正文隔一个空行；正文为空只落块。
fn insert_book_header(content: &str, block: &str) -> String {
    let body = strip_bom(content);
    let bom = &content[..content.len() - body.len()];
    if body.trim().is_empty() {
        format!("{bom}{block}")
    } else {
        format!("{bom}{block}\n{body}")
    }
}

/// 打开书时的一次性迁移（spec 拆书保存与模板 §五）：md 无书档块且 yaml
/// 四键有非空值 → 生成书档块插稿顶；md 已有书档块 → 不搬值（md 为准），
/// yaml 四键一律删除、桥段/未知键/章前缀原样保留（读-合-写）。yaml 无
/// 四键则不写盘（幂等：迁过一次就查无此键）。yaml 解析失败返回 Err——
/// 读不懂的表拒绝改写。返回值＝md 是否被改写（true 时调用方应重读）。
pub fn migrate_book_header(md_path: &Path) -> Result<bool, String> {
    let yaml = sibling_yaml_path(md_path);
    if !yaml.is_file() {
        return Ok(false);
    }
    let mut map = read_yaml_mapping(&yaml)?;
    if !HEADER_YAML_KEYS
        .iter()
        .any(|k| map.contains_key(Value::String((*k).to_string())))
    {
        return Ok(false);
    }
    let meta = meta_from_mapping(&map);
    let old_md = read_text(md_path)?;
    let mut md_changed = false;
    if parse_book_header(&old_md).is_none() {
        let block = book_header_block_text(&BookHeader {
            title: meta.title,
            track_record: meta.track_record,
            summary: meta.summary,
            golden_finger: meta.golden_finger,
        });
        if block != "> [!书档]\n" {
            write_text_atomic(md_path, &insert_book_header(&old_md, &block))?;
            md_changed = true;
        }
    }
    for k in HEADER_YAML_KEYS {
        map.remove(Value::String(k.to_string()));
    }
    if map.is_empty() {
        // 只剩四个书级键：整文件删除比留一个空 `{}` 干净；桥段标注
        // 首次落盘时会按懒生成重建。
        fs::remove_file(&yaml).map_err(|e| format!("无法删除空 yaml {}：{e}", yaml.display()))?;
    } else {
        write_yaml_mapping(&yaml, map)?;
    }
    Ok(md_changed)
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

/// 文件名 stem（无扩展名）：快照目录、附件分目录共用。
pub(crate) fn file_stem_of(path: &Path) -> String {
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

/// 章号文案（`第7章`）：按章前缀模板渲染，缺省 `第{n}章`；模板无 {n}
/// 时直接拼在模板后。与前端 chapterFile.ts::chapterHead 同一规则（导出
/// 与界面显示必须一致），改一处要同步另一处。
pub fn render_chapter_head(ordinal: u32, prefix: Option<&str>) -> String {
    let template = prefix
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(DEFAULT_CHAPTER_PREFIX);
    match template.split_once("{n}") {
        Some((pre, suf)) => format!("{pre}{ordinal}{suf}"),
        None => format!("{template}{ordinal}"),
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
    fn 保存_首次覆盖留快照_落书内隐藏目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("《书》/拆书.md");
        write(&md, "第一版");
        let base = read_book_md(&md).unwrap().fingerprint;

        save_book_md(&md, "第二版", Some(&base), false).unwrap();
        let dir = snapshot_dir(&root.join("《书》"), "拆书");
        let files = snapshot_files(&dir);
        assert_eq!(files.len(), 1, "首次覆盖留下上一版快照");
        assert_eq!(read_text(&files[0]).unwrap(), "第一版");
        // 快照根在书内点开头目录里，扫描（is_hidden）从根上忽略。
        assert!(is_hidden(&root.join("《书》/.gongbi")));
    }

    #[test]
    fn 保存_散文件书_快照落库根按书名分目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书乙.md");
        write(&md, "第一版");
        let base = read_book_md(&md).unwrap().fingerprint;

        save_book_md(&md, "第二版", Some(&base), false).unwrap();
        let latest = snapshot_files(&root.join(".gongbi/历史/书乙"))
            .pop()
            .unwrap();
        assert_eq!(read_text(&latest).unwrap(), "第一版");
    }

    #[test]
    fn 快照_同内容不重复_空白不留_节流_超上限删最旧() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let dir = snapshot_dir(&root, "拆书");

        snapshot_with_gap(&dir, "第一版".as_bytes(), std::time::Duration::ZERO).unwrap();
        assert_eq!(snapshot_files(&dir).len(), 1);
        // 与最近快照同内容：不重复存
        snapshot_with_gap(&dir, "第一版".as_bytes(), std::time::Duration::ZERO).unwrap();
        assert_eq!(snapshot_files(&dir).len(), 1);
        // 新内容：存
        snapshot_with_gap(&dir, "第二版".as_bytes(), std::time::Duration::ZERO).unwrap();
        assert_eq!(snapshot_files(&dir).len(), 2);
        // 空白内容：不留
        snapshot_with_gap(&dir, "  \n".as_bytes(), std::time::Duration::ZERO).unwrap();
        assert_eq!(snapshot_files(&dir).len(), 2);
        // 距最近快照不足间隔：节流跳过
        snapshot_with_gap(
            &dir,
            "第三版".as_bytes(),
            std::time::Duration::from_secs(3600),
        )
        .unwrap();
        assert_eq!(snapshot_files(&dir).len(), 2);

        // 造 205 份假快照，thin 只留 200
        for i in 0..205 {
            write(&dir.join(format!("20200101-{i:06}.md")), "旧");
        }
        thin_snapshots(&dir);
        assert_eq!(snapshot_files(&dir).len(), MAX_SNAPSHOTS);
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

    #[test]
    fn 章号文案_缺省前缀_自定义模板_无占位符() {
        assert_eq!(render_chapter_head(7, None), "第7章");
        assert_eq!(render_chapter_head(7, Some("  ")), "第7章");
        // 与前端 chapterHead 同款：前缀先 trim（界面显示与导出一致）
        assert_eq!(render_chapter_head(7, Some("Chapter {n}: ")), "Chapter 7:");
        assert_eq!(render_chapter_head(7, Some("第")), "第7");
    }

    // --- 书档（工单 #30，spec 拆书保存与模板 §四/§五）---

    #[test]
    fn 书档解析_键名行_含自由行与半角冒号() {
        let content = "> [!书档]\n> 书名：大魏读书人\n> 随手备注一行\n> 成绩:均订两万\n> 简介：少年得金手指\n> 金手指：每日签到\n> 书名：重复的不要\n\n第1章\n";
        let header = parse_book_header(content).unwrap();
        assert_eq!(header.title.as_deref(), Some("大魏读书人"));
        assert_eq!(header.track_record.as_deref(), Some("均订两万"));
        assert_eq!(header.summary.as_deref(), Some("少年得金手指"));
        assert_eq!(header.golden_finger.as_deref(), Some("每日签到"));
    }

    #[test]
    fn 书档解析_空值不算_多块取首块() {
        let content = "开场白\n\n> [!书档]\n> 书名：甲\n> 成绩：\n\n正文\n\n> [!书档]\n> 书名：乙\n";
        let header = parse_book_header(content).unwrap();
        assert_eq!(header.title.as_deref(), Some("甲"));
        assert_eq!(header.track_record, None);

        // 无书档块（普通引用、别的 callout）返回 None。
        assert!(parse_book_header("> [!小结]\n> 书名：不算\n").is_none());
        assert!(parse_book_header("> 普通引用\n> 书名：不算\n").is_none());
        assert!(parse_book_header("").is_none());
    }

    #[test]
    fn 书档解析_折叠标记与首块判定() {
        // Obsidian 折叠形态 `[!书档]-` 也认；书档夹在别的引用块后仍取得到首块。
        let content = "> [!点评]\n> 别的块\n\n> [!书档]-\n> 书名：甲\n";
        let header = parse_book_header(content).unwrap();
        assert_eq!(header.title.as_deref(), Some("甲"));
    }

    #[test]
    fn 书档块生成_只落非空项() {
        let block = book_header_block_text(&BookHeader {
            title: Some(" 甲 ".into()),
            track_record: None,
            summary: Some("".into()),
            golden_finger: Some("签到".into()),
        });
        assert_eq!(block, "> [!书档]\n> 书名：甲\n> 金手指：签到\n");
    }

    #[test]
    fn 书档插顶_正文为空与有正文() {
        assert_eq!(insert_book_header("", "> [!书档]\n"), "> [!书档]\n");
        assert_eq!(
            insert_book_header("第1章\n正文", "> [!书档]\n"),
            "> [!书档]\n\n第1章\n正文"
        );
        // BOM 保持在最前。
        assert_eq!(
            insert_book_header("\u{feff}第1章", "> [!书档]\n"),
            "\u{feff}> [!书档]\n\n第1章"
        );
    }

    #[test]
    fn 迁移_四键非空_搬值删键_保留桥段未知键章前缀() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("《书》/拆书.md");
        write(&md, "第1章\n正文");
        write(
            &root.join("《书》/拆书.yaml"),
            "书名: 书甲\n成绩: 均订两万\n简介: 少年得金手指\n金手指: 签到\n章前缀: \"Chapter {n}: \"\n桥段:\n- 起: 1\n  止: 2\n  类型: [掉马甲]\n自定义键: 保留我\n",
        );

        assert!(migrate_book_header(&md).unwrap(), "md 应被改写");
        let migrated = read_text(&md).unwrap();
        assert_eq!(
            migrated,
            "> [!书档]\n> 书名：书甲\n> 成绩：均订两万\n> 简介：少年得金手指\n> 金手指：签到\n\n第1章\n正文"
        );
        let yaml_text = read_text(&root.join("《书》/拆书.yaml")).unwrap();
        assert!(!yaml_text.contains("书名:"), "四键应删除：{yaml_text}");
        assert!(!yaml_text.contains("成绩:"));
        assert!(yaml_text.contains("章前缀:"));
        assert!(yaml_text.contains("掉马甲"), "桥段标注无损");
        assert!(yaml_text.contains("自定义键: 保留我"));

        // 幂等：再跑一次查无四键，不写盘。
        assert!(!migrate_book_header(&md).unwrap());
        assert_eq!(read_text(&md).unwrap(), migrated);
    }

    #[test]
    fn 迁移_md已有书档_只删键不搬值() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书乙.md");
        write(&md, "> [!书档]\n> 书名：纸面上的\n\n第1章");
        write(&root.join("书乙.yaml"), "书名: yaml里的\n成绩: 均订\n");

        assert!(!migrate_book_header(&md).unwrap(), "md 未被改写");
        let text = read_text(&md).unwrap();
        assert!(text.contains("书名：纸面上的"));
        assert!(!text.contains("yaml里的"), "md 为准、不搬值");
        assert!(!root.join("书乙.yaml").exists(), "只剩四键的 yaml 整文件删除");
    }

    #[test]
    fn 迁移_空值不搬_但键仍清() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书丙.md");
        write(&md, "第1章");
        write(&root.join("书丙.yaml"), "书名: \n成绩: ''\n备注: 留\n");

        assert!(!migrate_book_header(&md).unwrap());
        assert_eq!(read_text(&md).unwrap(), "第1章", "全空值不生成书档块");
        let yaml_text = read_text(&root.join("书丙.yaml")).unwrap();
        assert_eq!(yaml_text, "备注: 留\n");
    }

    #[test]
    fn 迁移_无yaml或无四键_不写盘() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("书丁.md");
        write(&md, "第1章");
        assert!(!migrate_book_header(&md).unwrap());

        write(&root.join("书丁.yaml"), "桥段: []\n");
        let before = fs::read(&root.join("书丁.yaml")).unwrap();
        assert!(!migrate_book_header(&md).unwrap());
        assert_eq!(fs::read(&root.join("书丁.yaml")).unwrap(), before);
    }

    #[test]
    fn 迁移_yaml解析失败_报错不写盘() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("坏书.md");
        write(&md, "第1章");
        let yaml = root.join("坏书.yaml");
        write(&yaml, "{{{{不是 yaml");

        assert!(migrate_book_header(&md).is_err());
        assert_eq!(read_text(&md).unwrap(), "第1章", "读不懂就不迁");
        assert!(yaml.is_file(), "坏 yaml 原样保留");
    }

    #[test]
    fn 迁移_散文件书_同样插顶() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        let md = root.join("散书.md");
        write(&md, "第一章\n正文");
        write(&root.join("散书.yaml"), "金手指: 签到\n");

        assert!(migrate_book_header(&md).unwrap());
        assert_eq!(
            read_text(&md).unwrap(),
            "> [!书档]\n> 金手指：签到\n\n第一章\n正文"
        );
        // 只剩四键 → yaml 删除；桥段标注懒生成会重建。
        assert!(!root.join("散书.yaml").exists());
    }
}
