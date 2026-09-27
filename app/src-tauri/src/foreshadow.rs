//! 伏笔系统（工单 #6，docs/spec/伏笔系统.md）：跨章节的长期线索对象，
//! 带状态机（待埋→已埋→部分收/已收，旁支弃用）。
//!
//! **正文零污染**：锚点＝「章序数 ＋ 引文」，不往正文插任何标记；数据落
//! 项目根 `伏笔.yaml`（应用受管，整表重写；写路径原子，ADR 0004）。
//! 章序数对改名/删章稳定（重编号会挪动锚点）、引文定位章内位置——两者
//! 失配一律**只提示不自动改**（看板标「引文失配」）。
//! 与三线（#7）共用 thread.rs 底座：锚点形状、单文件读写、现扫派生。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::map_scalar;
use crate::thread::{self, Anchor, AnchorView, Payoff, PayoffView};

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Foreshadow {
    /// 伏笔名＝身份；同名在「从正文标注」时合并（追加埋设/回收）。
    pub name: String,
    /// 五态之一；缺省读作「待埋」。
    pub state: String,
    /// 独立于伏笔业务状态的展示位置；旧数据缺键时为 false。
    #[serde(default)]
    pub pending: bool,
    pub planted: Vec<Anchor>,
    pub recovered: Vec<Payoff>,
}

/// 看板条目：在 Foreshadow 之上加派生字段（超期、引文失配）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowView {
    pub name: String,
    pub state: String,
    pub pending: bool,
    pub planted: Vec<AnchorView>,
    pub recovered: Vec<PayoffView>,
    /// 距当前最大章序已过多少章未收（仅已埋/部分收有值）。
    pub uncollected_chapters: Option<u32>,
    /// 未收章数 ≥ OVERDUE_CHAPTERS。
    pub overdue: bool,
}

pub fn foreshadow_path(project: &Path) -> PathBuf {
    project.join(FORESHADOW_FILE)
}

// ---------- 读写 ----------

#[derive(Debug, Clone)]
struct ForeshadowRow {
    raw: Mapping,
    item: Foreshadow,
}

fn validate_optional_string(
    map: &Mapping,
    key: &str,
    path: &Path,
    location: &str,
) -> Result<(), String> {
    match map.get(Value::String(key.to_string())) {
        None | Some(Value::Null | Value::String(_)) => Ok(()),
        Some(_) => Err(format!("{} {location}的「{key}」应为文本", path.display())),
    }
}

fn parse_foreshadow(map: &Mapping, path: &Path, index: usize) -> Result<Foreshadow, String> {
    let name = map_scalar(map, "名")
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| format!("{} 第 {index} 项缺「名」", path.display()))?;
    validate_optional_string(map, "状态", path, &format!("第 {index} 项"))?;
    let pending = match map.get(Value::String("待打磨".into())) {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            return Err(format!(
                "{} 第 {index} 项的「待打磨」应为布尔值",
                path.display()
            ));
        }
    };
    for (record_index, row) in thread::map_rows(map, "埋设", path, index)?
        .iter()
        .enumerate()
    {
        let location = format!("第 {index} 项「埋设」第 {} 条", record_index + 1);
        validate_optional_string(row, "引文", path, &location)?;
    }
    for (record_index, row) in thread::map_rows(map, "回收", path, index)?
        .iter()
        .enumerate()
    {
        let location = format!("第 {index} 项「回收」第 {} 条", record_index + 1);
        for field in ["引文", "类型", "说明"] {
            validate_optional_string(row, field, path, &location)?;
        }
    }
    Ok(Foreshadow {
        name,
        state: map_scalar(map, "状态").unwrap_or_else(|| STATE_PENDING.to_string()),
        pending,
        planted: thread::map_anchors(map, "埋设", path, index)?,
        recovered: thread::map_payoffs(map, "回收", path, index, RECOVERY_STAGE)?,
    })
}

fn read_rows(project: &Path) -> Result<Vec<ForeshadowRow>, String> {
    thread::read_threads(
        &foreshadow_path(project),
        "伏笔条目（名/状态/待打磨/埋设/回收）",
        |map, path, index| {
            Ok(ForeshadowRow {
                raw: map.clone(),
                item: parse_foreshadow(map, path, index)?,
            })
        },
    )
}

fn write_rows(project: &Path, rows: &[ForeshadowRow]) -> Result<(), String> {
    let path = foreshadow_path(project);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
    }
    let value = Value::Sequence(
        rows.iter()
            .map(|row| Value::Mapping(row.raw.clone()))
            .collect(),
    );
    let text = serde_yaml::to_string(&value).map_err(|e| format!("无法生成伏笔 yaml：{e}"))?;
    crate::book_file::write_text_atomic(&path, &text)
}

fn save_rows(project: &Path, rows: &[ForeshadowRow]) -> Result<Vec<Foreshadow>, String> {
    write_rows(project, rows)?;
    Ok(rows.iter().map(|row| row.item.clone()).collect())
}

fn optional_target_index(rows: &[ForeshadowRow], name: &str) -> Result<Option<usize>, String> {
    let mut matches = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.item.name == name);
    let Some((index, _)) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(format!("伏笔「{name}」重名，无法安全修改"));
    }
    Ok(Some(index))
}

fn target_index(rows: &[ForeshadowRow], name: &str) -> Result<usize, String> {
    optional_target_index(rows, name)?
        .ok_or_else(|| format!("没有找到伏笔「{name}」，可能已被删除或改名"))
}

fn set_row_state(row: &mut ForeshadowRow, state: &str) {
    row.raw.insert(
        Value::String("状态".into()),
        Value::String(state.to_string()),
    );
    row.item.state = state.to_string();
}

fn append_record(row: &mut ForeshadowRow, key: &str, value: Mapping) {
    let key = Value::String(key.to_string());
    let mut rows = match row.raw.remove(&key) {
        Some(Value::Sequence(rows)) => rows,
        _ => Vec::new(),
    };
    rows.push(Value::Mapping(value));
    row.raw.insert(key, Value::Sequence(rows));
}

fn anchor_value(anchor: &Anchor) -> Mapping {
    let mut row = Mapping::new();
    row.insert(
        Value::String("章".into()),
        Value::Number(anchor.chapter.into()),
    );
    row.insert(
        Value::String("引文".into()),
        Value::String(anchor.quote.clone()),
    );
    row
}

fn payoff_value(payoff: &Payoff) -> Mapping {
    let mut row = anchor_value(&Anchor {
        chapter: payoff.chapter,
        quote: payoff.quote.clone(),
    });
    row.insert(
        Value::String("类型".into()),
        Value::String(payoff.kind.clone()),
    );
    if let Some(note) = payoff.note.as_deref() {
        row.insert(
            Value::String("说明".into()),
            Value::String(note.to_string()),
        );
    }
    row
}

fn new_row(item: Foreshadow) -> ForeshadowRow {
    let mut raw = Mapping::new();
    raw.insert(Value::String("名".into()), Value::String(item.name.clone()));
    raw.insert(
        Value::String("状态".into()),
        Value::String(item.state.clone()),
    );
    if item.pending {
        raw.insert(Value::String("待打磨".into()), Value::Bool(true));
    }
    if !item.planted.is_empty() {
        raw.insert(
            Value::String("埋设".into()),
            thread::anchors_value(&item.planted),
        );
    }
    if !item.recovered.is_empty() {
        raw.insert(
            Value::String("回收".into()),
            thread::payoffs_value(&item.recovered),
        );
    }
    ForeshadowRow { raw, item }
}

pub fn read_foreshadows(project: &Path) -> Result<Vec<Foreshadow>, String> {
    Ok(read_rows(project)?
        .into_iter()
        .map(|row| row.item)
        .collect())
}

// ---------- 操作 ----------

/// 看板新建待埋：只填名字；重名报错不合并（合并只发生在「从正文标注」时，
/// 与单元同名同款纪律）。
pub fn add_pending_foreshadow(project: &Path, name: &str) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("伏笔名不能为空".to_string());
    }
    let mut rows = read_rows(project)?;
    if optional_target_index(&rows, name)?.is_some() {
        return Err(format!("已存在同名伏笔「{name}」"));
    }
    rows.push(new_row(Foreshadow {
        name: name.to_string(),
        state: STATE_PENDING.to_string(),
        pending: false,
        planted: Vec::new(),
        recovered: Vec::new(),
    }));
    save_rows(project, &rows)
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
    let mut rows = read_rows(project)?;
    let anchor = Anchor {
        chapter,
        quote: quote.to_string(),
    };
    match optional_target_index(&rows, name)? {
        Some(index) => {
            let row = &mut rows[index];
            let dup = row
                .item
                .planted
                .iter()
                .any(|a| a.chapter == chapter && a.quote == anchor.quote);
            if !dup {
                append_record(row, "埋设", anchor_value(&anchor));
                row.item.planted.push(anchor);
            }
            if row.item.state.trim().is_empty() || row.item.state == STATE_PENDING {
                set_row_state(row, STATE_PLANTED);
            }
        }
        None => rows.push(new_row(Foreshadow {
            name: name.to_string(),
            state: STATE_PLANTED.to_string(),
            pending: false,
            planted: vec![anchor],
            recovered: Vec::new(),
        })),
    }
    save_rows(project, &rows)
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
    let mut rows = read_rows(project)?;
    let index = target_index(&rows, name)?;
    let row = &mut rows[index];
    let payoff = Payoff {
        chapter,
        quote: quote.to_string(),
        kind: kind.to_string(),
        note: note.map(str::to_string),
    };
    let dup = row.item.recovered.iter().any(|r| {
        r.chapter == chapter && r.quote == quote && r.kind == kind && r.note.as_deref() == note
    });
    if !dup {
        append_record(row, "回收", payoff_value(&payoff));
        row.item.recovered.push(payoff);
    }
    if row.item.state != STATE_DROPPED {
        let state = if kind == RECOVERY_FINAL {
            STATE_DONE
        } else {
            STATE_PARTIAL
        };
        set_row_state(row, state);
    }
    save_rows(project, &rows)
}

/// 改状态（看板）：五态任切，含弃用与恢复。
pub fn set_foreshadow_state(
    project: &Path,
    name: &str,
    state: &str,
) -> Result<Vec<Foreshadow>, String> {
    let state = state.trim();
    if !STATES.contains(&state) {
        return Err(format!(
            "未知状态「{state}」（待埋｜已埋｜部分收｜已收｜弃用）"
        ));
    }
    let name = name.trim();
    let mut rows = read_rows(project)?;
    let index = target_index(&rows, name)?;
    set_row_state(&mut rows[index], state);
    save_rows(project, &rows)
}

/// 切换独立的待打磨展示状态；退出时移除键，其他字段原样保留。
pub fn set_foreshadow_pending(
    project: &Path,
    name: &str,
    pending: bool,
) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("伏笔名不能为空".to_string());
    }
    let mut rows = read_rows(project)?;
    let index = target_index(&rows, name)?;
    let row = &mut rows[index];
    let key = Value::String("待打磨".into());
    let changed = if pending {
        let already_true = matches!(row.raw.get(&key), Some(Value::Bool(true)));
        if !already_true {
            row.raw.insert(key, Value::Bool(true));
        }
        !already_true
    } else {
        row.raw.remove(&key).is_some()
    };
    row.item.pending = pending;
    if changed {
        save_rows(project, &rows)
    } else {
        Ok(rows.into_iter().map(|row| row.item).collect())
    }
}

pub fn delete_foreshadow(project: &Path, name: &str) -> Result<Vec<Foreshadow>, String> {
    let name = name.trim();
    let mut rows = read_rows(project)?;
    let index = target_index(&rows, name)?;
    rows.remove(index);
    save_rows(project, &rows)
}

// ---------- 看板（派生视图，现扫） ----------

/// 看板数据：读伏笔.yaml ＋ 现扫正文算超期与引文失配（无索引，#12）。
pub fn foreshadow_board(project: &Path) -> Result<Vec<ForeshadowView>, String> {
    let list = read_foreshadows(project)?;
    let texts = thread::ChapterTexts::load(project)?;
    let max_ordinal = texts.max_ordinal();
    Ok(list
        .into_iter()
        .map(|f| {
            let last_planted_chapter = f.planted.iter().map(|a| a.chapter).max();
            let uncollected_chapters = match (f.state.as_str(), last_planted_chapter) {
                (STATE_PLANTED, Some(last)) | (STATE_PARTIAL, Some(last)) => {
                    Some(thread::chapters_since(max_ordinal, last))
                }
                _ => None,
            };
            ForeshadowView {
                name: f.name,
                state: f.state,
                pending: f.pending,
                planted: texts.anchor_views(&f.planted),
                recovered: texts.payoff_views(&f.recovered),
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
        write(&project.join(format!("正文/{ordinal:04} {title}.md")), body);
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

        let list = recover_foreshadow(
            &p,
            "黄铜钥匙",
            12,
            "钥匙又出现",
            RECOVERY_STAGE,
            Some("半露"),
        )
        .unwrap();
        assert_eq!(list[0].state, STATE_PARTIAL);
        assert_eq!(list[0].recovered[0].note.as_deref(), Some("半露"));

        // 完全相同的一条不重复追加。
        let list = recover_foreshadow(
            &p,
            "黄铜钥匙",
            12,
            "钥匙又出现",
            RECOVERY_STAGE,
            Some("半露"),
        )
        .unwrap();
        assert_eq!(list[0].recovered.len(), 1);

        let list =
            recover_foreshadow(&p, "黄铜钥匙", 30, "钥匙开了门", RECOVERY_FINAL, None).unwrap();
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
    fn 读写_旧格式默认普通对象_编辑保留未知键_损坏报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &foreshadow_path(&p),
            "- 名: 钥匙\n  状态: 已埋\n  私货: 会丢\n  埋设:\n  - 章: 1\n    引文: 钥匙\n",
        );
        let list = read_foreshadows(&p).unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].pending);
        set_foreshadow_pending(&p, "钥匙", true).unwrap();
        let raw = fs::read_to_string(foreshadow_path(&p)).unwrap();
        assert!(raw.contains("私货: 会丢"), "条目内未知键应保留：{raw}");
        assert!(raw.contains("名: 钥匙"));
        assert!(read_foreshadows(&p).unwrap()[0].pending);

        write(&foreshadow_path(&p), "名: 不是列表\n");
        assert!(read_foreshadows(&p).is_err());
        write(&foreshadow_path(&p), "- 状态: 已埋\n");
        assert!(read_foreshadows(&p).is_err());
        write(&foreshadow_path(&p), "- 名: 错误布尔值\n  待打磨: 是\n");
        assert!(read_foreshadows(&p).is_err());
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
        set_foreshadow_pending(&p, "待埋的", true).unwrap();

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
        assert!(pending.pending, "待打磨与业务状态分别呈现");
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

    #[test]
    fn 待打磨_往返只改原条目并保留未知字段与次序() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &foreshadow_path(&p),
            "- 名: 黄铜钥匙\n  状态: 部分收\n  私货: 手写说明\n  埋设:\n  - 章: 1\n    引文: 钥匙出现\n    锚点备注: 留着\n  回收:\n  - 章: 2\n    引文: 阶段回收\n    类型: 阶段\n    说明: 只收一半\n    回收备注: 原样保留\n- 名: 玉佩\n  状态: 待埋\n",
        );

        let before = read_foreshadows(&p).unwrap();
        assert!(!before[0].pending, "旧格式缺键时按普通伏笔读取");

        // 初次读取后由外部工具补字段；切换操作必须重读最新表再合并。
        let external = fs::read_to_string(foreshadow_path(&p))
            .unwrap()
            .replace("私货: 手写说明", "私货: 外部刚补");
        write(&foreshadow_path(&p), &external);

        let updated = set_foreshadow_pending(&p, "黄铜钥匙", true).unwrap();
        assert!(updated[0].pending);
        assert_eq!(updated[0].state, STATE_PARTIAL, "待打磨与业务状态独立");
        assert_eq!(
            updated
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["黄铜钥匙", "玉佩"]
        );

        let annotated = annotate_foreshadow(&p, "黄铜钥匙", 3, "后续埋设").unwrap();
        assert!(annotated[0].pending);
        let recovered = recover_foreshadow(
            &p,
            "黄铜钥匙",
            4,
            "继续回收",
            RECOVERY_STAGE,
            Some("留有余地"),
        )
        .unwrap();
        assert!(recovered[0].pending);

        let edited = set_foreshadow_state(&p, "黄铜钥匙", STATE_PLANTED).unwrap();
        assert!(edited[0].pending, "编辑业务状态时保持待打磨");
        assert_eq!(edited[0].state, STATE_PLANTED);

        set_foreshadow_pending(&p, "黄铜钥匙", false).unwrap();
        let restored = read_foreshadows(&p).unwrap();
        assert!(!restored[0].pending);
        assert_eq!(restored[0].state, STATE_PLANTED);
        assert_eq!(
            restored
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            ["黄铜钥匙", "玉佩"]
        );

        let raw = fs::read_to_string(foreshadow_path(&p)).unwrap();
        assert!(
            raw.contains("私货: 外部刚补"),
            "待打磨切换保留外部新字段：{raw}"
        );
        assert!(
            raw.contains("锚点备注: 留着"),
            "待打磨切换保留嵌套未知键：{raw}"
        );
        assert!(
            raw.contains("回收备注: 原样保留"),
            "追加回收时保留未知键：{raw}"
        );
        let yaml: Value = serde_yaml::from_str(&raw).unwrap();
        let Value::Sequence(rows) = yaml else {
            panic!("伏笔表应保持列表形状")
        };
        let Value::Mapping(first) = &rows[0] else {
            panic!("第一条应为映射")
        };
        assert!(
            !first.contains_key(Value::String("待打磨".into())),
            "退出待打磨应移除键"
        );
    }

    #[test]
    fn 待打磨_损坏表陈旧目标与重名均拒绝写入() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &foreshadow_path(&p),
            "- 名: 钥匙\n  状态: 已埋\n- 名: 钥匙\n  状态: 待埋\n",
        );
        let duplicate = fs::read(foreshadow_path(&p)).unwrap();
        assert!(set_foreshadow_pending(&p, "钥匙", true).is_err());
        assert_eq!(fs::read(foreshadow_path(&p)).unwrap(), duplicate);

        write(&foreshadow_path(&p), "- 名: 改名后的钥匙\n  状态: 已埋\n");
        let renamed = fs::read(foreshadow_path(&p)).unwrap();
        assert!(set_foreshadow_pending(&p, "钥匙", true).is_err());
        assert_eq!(fs::read(foreshadow_path(&p)).unwrap(), renamed);

        write(&foreshadow_path(&p), "这不是伏笔列表\n");
        let damaged = fs::read(foreshadow_path(&p)).unwrap();
        assert!(set_foreshadow_pending(&p, "改名后的钥匙", true).is_err());
        assert_eq!(fs::read(foreshadow_path(&p)).unwrap(), damaged);
    }
}
