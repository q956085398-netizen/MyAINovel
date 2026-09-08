//! 伏笔系统（工单 #6，docs/spec/伏笔系统.md）：跨章节的长期线索对象，
//! 带状态机（待埋→已埋→部分收/已收，旁支弃用）。
//!
//! **正文零污染**：锚点＝「章序数 ＋ 引文」，不往正文插任何标记；数据落
//! 项目根 `伏笔.yaml`（应用受管，整表重写；写路径原子，ADR 0004）。
//! 章序数对改名/删章稳定（重编号会挪动锚点）、引文定位章内位置——两者
//! 失配一律**只提示不自动改**（看板标「引文失配」）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::{map_scalar, map_u32, read_text, write_text_atomic};
use crate::chapter::scan_chapters;

pub const FORESHADOW_FILE: &str = "伏笔.yaml";

/// 五态（约定值只提示不校验；应用操作时只接受这五个）。
pub const STATE_PENDING: &str = "待埋";
pub const STATE_PLANTED: &str = "已埋";
pub const STATE_PARTIAL: &str = "部分收";
pub const STATE_DONE: &str = "已收";
pub const STATE_DROPPED: &str = "弃用";
pub const STATES: [&str; 5] = [
    STATE_PENDING,
    STATE_PLANTED,
    STATE_PARTIAL,
    STATE_DONE,
    STATE_DROPPED,
];

/// 回收类型：阶段＝部分收，终结＝已收。
pub const RECOVERY_STAGE: &str = "阶段";
pub const RECOVERY_FINAL: &str = "终结";

/// 超期阈值：已埋/部分收的伏笔，埋设章距当前最大章序 ≥ 20 章未收即标超期
/// （约一个单元的篇幅；只提示不拦截）。
pub const OVERDUE_CHAPTERS: u32 = 20;

// ---------- 数据模型 ----------

/// 埋设锚点：章序数（第几个章标题，1 起）＋ 选中引文。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowAnchor {
    pub chapter: u32,
    pub quote: String,
}

/// 回收记录：章序数＋引文＋类型（阶段｜终结）＋可选说明。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowRecovery {
    pub chapter: u32,
    pub quote: String,
    pub kind: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreshadow {
    /// 伏笔名＝身份；同名在「从正文标注」时合并（追加埋设/回收）。
    pub name: String,
    /// 五态之一；缺省读作「待埋」。
    pub state: String,
    pub planted: Vec<ForeshadowAnchor>,
    pub recovered: Vec<ForeshadowRecovery>,
}

/// 看板条目：在 Foreshadow 之上加派生字段（超期、引文失配）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowView {
    pub name: String,
    pub state: String,
    pub planted: Vec<AnchorView>,
    pub recovered: Vec<RecoveryView>,
    /// 距当前最大章序已过多少章未收（仅已埋/部分收有值）。
    pub uncollected_chapters: Option<u32>,
    /// 未收章数 ≥ OVERDUE_CHAPTERS。
    pub overdue: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorView {
    pub chapter: u32,
    pub quote: String,
    /// 引文在该章正文里找不到（章文件缺失也算失配）。
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryView {
    pub chapter: u32,
    pub quote: String,
    pub kind: String,
    pub note: Option<String>,
    pub stale: bool,
}

pub fn foreshadow_path(project: &Path) -> PathBuf {
    project.join(FORESHADOW_FILE)
}

// ---------- 引文匹配（全应用单一规则；前端有镜像） ----------

/// 引文定位：先精确子串；不中则去掉全部空白（Unicode White_Space，
/// 与 book_file/chapterFile 的字数口径同一张表）后再匹配，用于容忍
/// 换行/缩进差异。返回原始文本的字节区间；空引文＝None。
pub fn find_quote(text: &str, quote: &str) -> Option<(usize, usize)> {
    let quote = quote.trim();
    if quote.is_empty() {
        return None;
    }
    if let Some(start) = text.find(quote) {
        return Some((start, start + quote.len()));
    }
    let (norm, map) = strip_whitespace_map(text);
    let (norm_quote, _) = strip_whitespace_map(quote);
    if norm_quote.is_empty() {
        return None;
    }
    let at = norm.find(&norm_quote)?;
    // norm 与 norm_quote 都是无空白字符串，at 必落在字符边界上。
    let first = map.get(norm[..at].chars().count())?;
    let last = map.get(norm[..at].chars().count() + norm_quote.chars().count() - 1)?;
    Some((first.0, last.1))
}

/// 去掉空白字符，返回（无空白文本，每个保留字符的原始字节区间）。
fn strip_whitespace_map(text: &str) -> (String, Vec<(usize, usize)>) {
    let mut norm = String::new();
    let mut map = Vec::new();
    for (offset, ch) in text.char_indices() {
        if ch.is_whitespace() {
            continue;
        }
        norm.push(ch);
        map.push((offset, offset + ch.len_utf8()));
    }
    (norm, map)
}

// ---------- 读写 ----------

pub fn read_foreshadows(project: &Path) -> Result<Vec<Foreshadow>, String> {
    let path = foreshadow_path(project);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = read_text(&path)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_yaml::from_str(&text)
        .map_err(|e| format!("无法解析 {}：{e}", path.display()))?;
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 顶层应为列表（伏笔条目）", path.display()));
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| item_from_value(item, &path, i + 1))
        .collect()
}

fn item_from_value(value: &Value, path: &Path, index: usize) -> Result<Foreshadow, String> {
    let Value::Mapping(map) = value else {
        return Err(format!("{} 第 {index} 项应为映射（名/状态/埋设/回收）", path.display()));
    };
    let name = map_scalar(&map, "名")
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| format!("{} 第 {index} 项缺「名」", path.display()))?;
    let state = map_scalar(&map, "状态").unwrap_or_else(|| STATE_PENDING.to_string());
    let planted = map_anchors(&map, "埋设", path, index)?;
    let recovered = map_recoveries(&map, "回收", path, index)?;
    Ok(Foreshadow {
        name,
        state,
        planted,
        recovered,
    })
}

fn map_anchors(
    map: &Mapping,
    key: &str,
    path: &Path,
    index: usize,
) -> Result<Vec<ForeshadowAnchor>, String> {
    Ok(map_rows(map, key, path, index)?
        .iter()
        .enumerate()
        .map(|(i, row)| {
            Ok(ForeshadowAnchor {
                chapter: required_chapter(row, key, path, index, i)?,
                quote: map_scalar(row, "引文").unwrap_or_default(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?)
}

fn map_recoveries(
    map: &Mapping,
    key: &str,
    path: &Path,
    index: usize,
) -> Result<Vec<ForeshadowRecovery>, String> {
    Ok(map_rows(map, key, path, index)?
        .iter()
        .enumerate()
        .map(|(i, row)| {
            Ok(ForeshadowRecovery {
                chapter: required_chapter(row, key, path, index, i)?,
                quote: map_scalar(row, "引文").unwrap_or_default(),
                kind: map_scalar(row, "类型").unwrap_or_else(|| RECOVERY_STAGE.to_string()),
                note: map_scalar(row, "说明"),
            })
        })
        .collect::<Result<Vec<_>, String>>()?)
}

/// 取「埋设/回收」列表的原始行（每行必须是映射）；缺键/null 视为空表。
fn map_rows<'a>(
    map: &'a Mapping,
    key: &str,
    path: &Path,
    index: usize,
) -> Result<Vec<&'a Mapping>, String> {
    let Some(value) = map.get(Value::String(key.to_string())) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 第 {index} 项的「{key}」应为列表", path.display()));
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| match item {
            Value::Mapping(m) => Ok(m),
            _ => Err(format!(
                "{} 第 {index} 项「{key}」第 {} 条应为映射（章/引文）",
                path.display(),
                i + 1
            )),
        })
        .collect()
}

fn required_chapter(
    row: &Mapping,
    key: &str,
    path: &Path,
    index: usize,
    row_index: usize,
) -> Result<u32, String> {
    map_u32(row, "章").ok_or_else(|| {
        format!(
            "{} 第 {index} 项「{key}」第 {} 条缺「章」",
            path.display(),
            row_index + 1
        )
    })
}

pub fn write_foreshadows(project: &Path, list: &[Foreshadow]) -> Result<(), String> {
    let path = foreshadow_path(project);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
    }
    let seq: Vec<Value> = list.iter().map(item_to_value).collect();
    let text = serde_yaml::to_string(&Value::Sequence(seq))
        .map_err(|e| format!("无法生成 yaml：{e}"))?;
    write_text_atomic(&path, &text)
}

fn item_to_value(item: &Foreshadow) -> Value {
    let mut map = Mapping::new();
    map.insert(
        Value::String("名".into()),
        Value::String(item.name.trim().to_string()),
    );
    let state = item.state.trim();
    map.insert(
        Value::String("状态".into()),
        Value::String(if state.is_empty() { STATE_PENDING } else { state }.to_string()),
    );
    if !item.planted.is_empty() {
        let seq: Vec<Value> = item
            .planted
            .iter()
            .map(|a| {
                let mut m = Mapping::new();
                m.insert(Value::String("章".into()), Value::Number(a.chapter.into()));
                m.insert(
                    Value::String("引文".into()),
                    Value::String(a.quote.trim().to_string()),
                );
                Value::Mapping(m)
            })
            .collect();
        map.insert(Value::String("埋设".into()), Value::Sequence(seq));
    }
    if !item.recovered.is_empty() {
        let seq: Vec<Value> = item
            .recovered
            .iter()
            .map(|r| {
                let mut m = Mapping::new();
                m.insert(Value::String("章".into()), Value::Number(r.chapter.into()));
                m.insert(
                    Value::String("引文".into()),
                    Value::String(r.quote.trim().to_string()),
                );
                m.insert(
                    Value::String("类型".into()),
                    Value::String(r.kind.trim().to_string()),
                );
                if let Some(note) = r.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    m.insert(Value::String("说明".into()), Value::String(note.to_string()));
                }
                Value::Mapping(m)
            })
            .collect();
        map.insert(Value::String("回收".into()), Value::Sequence(seq));
    }
    Value::Mapping(map)
}

// ---------- 操作 ----------

/// 看板新建待埋：只填名字；重名报错不合并（合并只发生在「从正文标注」时，
/// 与单元同名同款纪律）。
pub fn add_pending_foreshadow(project: &Path, name: &str) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("伏笔名不能为空".to_string());
    }
    let mut list = read_foreshadows(project)?;
    if list.iter().any(|f| f.name == name) {
        return Err(format!("已存在同名伏笔「{name}」"));
    }
    list.push(Foreshadow {
        name: name.to_string(),
        state: STATE_PENDING.to_string(),
        planted: Vec::new(),
        recovered: Vec::new(),
    });
    write_foreshadows(project, &list)?;
    Ok(list)
}

/// 设为伏笔：同名不存在→新建（已埋）；已存在→追加埋设（待埋→已埋）。
/// 同（章, 引文）重复标注不重复追加。
pub fn annotate_foreshadow(
    project: &Path,
    name: &str,
    chapter: u32,
    quote: &str,
) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("伏笔名不能为空".to_string());
    }
    let quote = quote.trim();
    if quote.is_empty() {
        return Err("引文不能为空".to_string());
    }
    let mut list = read_foreshadows(project)?;
    let anchor = ForeshadowAnchor {
        chapter,
        quote: quote.to_string(),
    };
    match list.iter_mut().find(|f| f.name == name) {
        Some(item) => {
            let dup = item
                .planted
                .iter()
                .any(|a| a.chapter == chapter && a.quote == anchor.quote);
            if !dup {
                item.planted.push(anchor);
            }
            if item.state.trim().is_empty() || item.state == STATE_PENDING {
                item.state = STATE_PLANTED.to_string();
            }
        }
        None => list.push(Foreshadow {
            name: name.to_string(),
            state: STATE_PLANTED.to_string(),
            planted: vec![anchor],
            recovered: Vec::new(),
        }),
    }
    write_foreshadows(project, &list)?;
    Ok(list)
}

/// 回收伏笔：追加回收记录；终结→已收，阶段→部分收（弃用不覆盖）。
pub fn recover_foreshadow(
    project: &Path,
    name: &str,
    chapter: u32,
    quote: &str,
    kind: &str,
    note: Option<&str>,
) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("伏笔名不能为空".to_string());
    }
    let quote = quote.trim();
    if quote.is_empty() {
        return Err("引文不能为空".to_string());
    }
    let kind = match kind.trim() {
        RECOVERY_STAGE => RECOVERY_STAGE,
        RECOVERY_FINAL => RECOVERY_FINAL,
        other => return Err(format!("回收类型只能是「阶段」或「终结」，收到「{other}」")),
    };
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    let mut list = read_foreshadows(project)?;
    let item = list
        .iter_mut()
        .find(|f| f.name == name)
        .ok_or_else(|| format!("没有找到伏笔「{name}」"))?;
    let dup = item.recovered.iter().any(|r| {
        r.chapter == chapter && r.quote == quote && r.kind == kind && r.note.as_deref() == note
    });
    if !dup {
        item.recovered.push(ForeshadowRecovery {
            chapter,
            quote: quote.to_string(),
            kind: kind.to_string(),
            note: note.map(str::to_string),
        });
    }
    if item.state != STATE_DROPPED {
        item.state = if kind == RECOVERY_FINAL {
            STATE_DONE
        } else {
            STATE_PARTIAL
        }
        .to_string();
    }
    write_foreshadows(project, &list)?;
    Ok(list)
}

/// 改状态（看板）：五态任切，含弃用与恢复。
pub fn set_foreshadow_state(
    project: &Path,
    name: &str,
    state: &str,
) -> Result<Vec<Foreshadow>, String> {
    let state = state.trim();
    if !STATES.contains(&state) {
        return Err(format!("未知状态「{state}」（待埋｜已埋｜部分收｜已收｜弃用）"));
    }
    let name = name.trim();
    let mut list = read_foreshadows(project)?;
    let item = list
        .iter_mut()
        .find(|f| f.name == name)
        .ok_or_else(|| format!("没有找到伏笔「{name}」"))?;
    item.state = state.to_string();
    write_foreshadows(project, &list)?;
    Ok(list)
}

pub fn delete_foreshadow(project: &Path, name: &str) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    let mut list = read_foreshadows(project)?;
    let before = list.len();
    list.retain(|f| f.name != name);
    if list.len() == before {
        return Err(format!("没有找到伏笔「{name}」"));
    }
    write_foreshadows(project, &list)?;
    Ok(list)
}

// ---------- 看板（派生视图，现扫） ----------

/// 看板数据：读伏笔.yaml ＋ 现扫正文算超期与引文失配（无索引，#12）。
pub fn foreshadow_board(project: &Path) -> Result<Vec<ForeshadowView>, String> {
    let list = read_foreshadows(project)?;
    let chapters = scan_chapters(project)?;
    let max_ordinal = chapters.iter().filter_map(|c| c.ordinal).max().unwrap_or(0);
    let mut texts: BTreeMap<u32, Option<String>> = BTreeMap::new();
    for chapter in &chapters {
        if let Some(ordinal) = chapter.ordinal {
            texts.insert(ordinal, read_text(&chapter.path).ok());
        }
    }
    let stale = |chapter: u32, quote: &str| -> bool {
        match texts.get(&chapter) {
            Some(Some(text)) => find_quote(text, quote).is_none(),
            // 章文件缺失（被删/被重编号挪走）也算失配。
            _ => true,
        }
    };
    Ok(list
        .into_iter()
        .map(|f| {
            let last_planted_chapter = f.planted.iter().map(|a| a.chapter).max();
            let uncollected_chapters = match (f.state.as_str(), last_planted_chapter) {
                (STATE_PLANTED, Some(last)) | (STATE_PARTIAL, Some(last)) => {
                    Some(max_ordinal.saturating_sub(last))
                }
                _ => None,
            };
            ForeshadowView {
                name: f.name,
                state: f.state,
                planted: f
                    .planted
                    .into_iter()
                    .map(|a| AnchorView {
                        stale: stale(a.chapter, &a.quote),
                        chapter: a.chapter,
                        quote: a.quote,
                    })
                    .collect(),
                recovered: f
                    .recovered
                    .into_iter()
                    .map(|r| RecoveryView {
                        stale: stale(r.chapter, &r.quote),
                        chapter: r.chapter,
                        quote: r.quote,
                        kind: r.kind,
                        note: r.note,
                    })
                    .collect(),
                uncollected_chapters,
                overdue: uncollected_chapters.is_some_and(|n| n >= OVERDUE_CHAPTERS),
            }
        })
        .collect())
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

    fn chapter(project: &Path, ordinal: u32, title: &str, body: &str) {
        write(
            &project.join(format!("正文/{ordinal:04} {title}.md")),
            body,
        );
    }

    #[test]
    fn 标注_新建与同名追加_待埋升已埋() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());

        let list = annotate_foreshadow(&p, "黄铜钥匙", 1, "他摸了摸口袋里的黄铜钥匙").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, STATE_PLANTED);
        assert_eq!(list[0].planted.len(), 1);

        // 同章同引文重复标注不重复追加。
        let list = annotate_foreshadow(&p, "黄铜钥匙", 1, "他摸了摸口袋里的黄铜钥匙").unwrap();
        assert_eq!(list[0].planted.len(), 1);

        // 后续章再标注 → 追加埋设。
        let list = annotate_foreshadow(&p, "黄铜钥匙", 5, "钥匙又出现了").unwrap();
        assert_eq!(list[0].planted.len(), 2);

        // 先建待埋，再从正文标注 → 状态升已埋。
        let list = annotate_foreshadow(&p, "玉佩", 2, "腰间的玉佩不见了").unwrap();
        let jade = list.iter().find(|f| f.name == "玉佩").unwrap();
        assert_eq!(jade.state, STATE_PLANTED);
        assert_eq!(jade.planted.len(), 1);

        // 手写的「待埋」条目被同名标注合并，而不是新建第二条。
        write(&foreshadow_path(&p), "- 名: 残卷\n  状态: 待埋\n");
        let list = annotate_foreshadow(&p, "残卷", 3, "残卷上写着什么").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, STATE_PLANTED);
    }

    #[test]
    fn 待埋_新建重名报错_空名报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let list = add_pending_foreshadow(&p, "黄铜钥匙").unwrap();
        assert_eq!(list[0].state, STATE_PENDING);
        assert!(add_pending_foreshadow(&p, "黄铜钥匙").is_err());
        assert!(add_pending_foreshadow(&p, "  ").is_err());
        // 从正文标注同名条目 → 合并成一条并升「已埋」。
        let list = annotate_foreshadow(&p, "黄铜钥匙", 1, "钥匙").unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, STATE_PLANTED);
    }

    #[test]
    fn 标注_空名或空引文报错_不落盘() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        assert!(annotate_foreshadow(&p, "  ", 1, "引文").is_err());
        assert!(annotate_foreshadow(&p, "名", 1, "  ").is_err());
        assert!(!foreshadow_path(&p).exists());
    }

    #[test]
    fn 回收_阶段部分收_终结已收_弃用不覆盖() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        annotate_foreshadow(&p, "黄铜钥匙", 1, "钥匙").unwrap();

        let list =
            recover_foreshadow(&p, "黄铜钥匙", 12, "钥匙又出现", RECOVERY_STAGE, Some("半露")).unwrap();
        assert_eq!(list[0].state, STATE_PARTIAL);
        assert_eq!(list[0].recovered[0].note.as_deref(), Some("半露"));

        // 完全相同的一条不重复追加。
        let list =
            recover_foreshadow(&p, "黄铜钥匙", 12, "钥匙又出现", RECOVERY_STAGE, Some("半露")).unwrap();
        assert_eq!(list[0].recovered.len(), 1);

        let list = recover_foreshadow(&p, "黄铜钥匙", 30, "钥匙开了门", RECOVERY_FINAL, None).unwrap();
        assert_eq!(list[0].state, STATE_DONE);
        assert_eq!(list[0].recovered.len(), 2);

        // 弃用态不被回收覆盖。
        set_foreshadow_state(&p, "黄铜钥匙", STATE_DROPPED).unwrap();
        let list =
            recover_foreshadow(&p, "黄铜钥匙", 31, "又收一次", RECOVERY_STAGE, None).unwrap();
        assert_eq!(list[0].state, STATE_DROPPED);
    }

    #[test]
    fn 回收_未知类型与未知伏笔报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        annotate_foreshadow(&p, "钥匙", 1, "钥匙").unwrap();
        assert!(recover_foreshadow(&p, "钥匙", 2, "x", "彻底", None).is_err());
        assert!(recover_foreshadow(&p, "没有这条", 2, "x", RECOVERY_STAGE, None).is_err());
    }

    #[test]
    fn 状态_五态任切_未知状态报错_删除() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        annotate_foreshadow(&p, "钥匙", 1, "钥匙").unwrap();
        for state in STATES {
            let list = set_foreshadow_state(&p, "钥匙", state).unwrap();
            assert_eq!(list[0].state, state);
        }
        assert!(set_foreshadow_state(&p, "钥匙", "烂尾").is_err());
        let list = delete_foreshadow(&p, "钥匙").unwrap();
        assert!(list.is_empty());
        assert!(delete_foreshadow(&p, "钥匙").is_err());
    }

    #[test]
    fn 读写_往返_未知键丢弃_损坏报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &foreshadow_path(&p),
            "- 名: 钥匙\n  状态: 已埋\n  私货: 会丢\n  埋设:\n  - 章: 1\n    引文: 钥匙\n",
        );
        let list = read_foreshadows(&p).unwrap();
        assert_eq!(list.len(), 1);
        write_foreshadows(&p, &list).unwrap();
        let raw = fs::read_to_string(foreshadow_path(&p)).unwrap();
        assert!(!raw.contains("私货"), "条目内未知键整表重写会丢：{raw}");
        assert!(raw.contains("名: 钥匙"));

        write(&foreshadow_path(&p), "名: 不是列表\n");
        assert!(read_foreshadows(&p).is_err());
        write(&foreshadow_path(&p), "- 状态: 已埋\n");
        assert!(read_foreshadows(&p).is_err());
    }

    #[test]
    fn 匹配_精确_去空白_不中为失配() {
        assert_eq!(find_quote("前面钥匙后面", "钥匙"), Some((6, 12)));
        // 引文含换行/缩进：去空白后仍命中。
        let text = "他摸了摸口袋里的\n那把黄铜钥匙，若有所思。";
        let quote = "口袋里的那把黄铜钥匙";
        let (from, to) = find_quote(text, quote).unwrap();
        assert_eq!(&text[from..to], "口袋里的\n那把黄铜钥匙");
        assert!(find_quote(text, "完全不存在").is_none());
        assert!(find_quote(text, "   ").is_none());
        // 空文本。
        assert!(find_quote("", "钥匙").is_none());
    }

    #[test]
    fn 看板_超期与失配_按状态算未收章数() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        chapter(&p, 1, "初入江湖", "他摸了摸口袋里的黄铜钥匙。");
        chapter(&p, 25, "夜宴", "钥匙开了门。");
        annotate_foreshadow(&p, "钥匙", 1, "他摸了摸口袋里的黄铜钥匙。").unwrap();
        annotate_foreshadow(&p, "失配的线索", 1, "这句话已经不在正文里了").unwrap();
        annotate_foreshadow(&p, "已收的", 1, "钥匙").unwrap();
        recover_foreshadow(&p, "已收的", 25, "钥匙开了门。", RECOVERY_FINAL, None).unwrap();
        set_foreshadow_state(&p, "已收的", STATE_DONE).unwrap();
        annotate_foreshadow(&p, "待埋的", 1, "钥匙").unwrap();
        set_foreshadow_state(&p, "待埋的", STATE_PENDING).unwrap();

        let board = foreshadow_board(&p).unwrap();
        let key = board.iter().find(|v| v.name == "钥匙").unwrap();
        // 最大章序 25，最近埋设章 1 → 24 章未收 → 超期。
        assert_eq!(key.uncollected_chapters, Some(24));
        assert!(key.overdue);
        assert!(!key.planted[0].stale);

        let stale = board.iter().find(|v| v.name == "失配的线索").unwrap();
        assert!(stale.planted[0].stale);

        let done = board.iter().find(|v| v.name == "已收的").unwrap();
        assert_eq!(done.uncollected_chapters, None);
        assert!(!done.overdue);
        assert!(!done.recovered[0].stale);

        let pending = board.iter().find(|v| v.name == "待埋的").unwrap();
        assert_eq!(pending.state, STATE_PENDING);
        assert_eq!(pending.uncollected_chapters, None);
    }

    #[test]
    fn 看板_缺章文件算失配() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        annotate_foreshadow(&p, "钥匙", 7, "钥匙").unwrap();
        let board = foreshadow_board(&p).unwrap();
        assert!(board[0].planted[0].stale);
    }
}
