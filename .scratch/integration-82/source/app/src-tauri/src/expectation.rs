//! 期待感/目标三线（工单 #7，docs/spec/期待感三线.md）：跨章节的期待/目标
//! 线索，按档位（短/中/长）分三行。与伏笔同构不同表——共用 thread.rs 底座
//! （锚点＝章序数＋引文、单文件整表重写、现扫派生），数据落项目根
//! `三线.yaml`（应用受管；写路径原子，ADR 0004）。正文零污染。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::{content_fingerprint, map_scalar, write_text_atomic};
use crate::thread::{self, Anchor, AnchorView, Payoff, PayoffView};

pub const EXPECTATION_FILE: &str = "三线.yaml";

/// 类别：期待＝读者想知道结果；目标＝主角下一步去哪里（约定值只提示不校验）。
pub const KIND_EXPECTATION: &str = "期待";
pub const KIND_GOAL: &str = "目标";
pub const KINDS: [&str; 2] = [KIND_EXPECTATION, KIND_GOAL];

/// 档位＝时间线网格的三行（约定值只提示不校验）。
pub const HORIZON_SHORT: &str = "短";
pub const HORIZON_MID: &str = "中";
pub const HORIZON_LONG: &str = "长";
pub const HORIZONS: [&str; 3] = [HORIZON_SHORT, HORIZON_MID, HORIZON_LONG];

/// 五态（约定值只提示不校验；应用操作时只接受这五个）。
pub const STATE_PENDING: &str = "待埋";
pub const STATE_PLANTED: &str = "已埋";
pub const STATE_PARTIAL: &str = "部分兑现";
pub const STATE_DONE: &str = "已兑现";
pub const STATE_DROPPED: &str = "弃用";
pub const STATES: [&str; 5] = [
    STATE_PENDING,
    STATE_PLANTED,
    STATE_PARTIAL,
    STATE_DONE,
    STATE_DROPPED,
];

/// 兑现类型：阶段＝部分兑现，终结＝已兑现。
pub const PAYOFF_STAGE: &str = "阶段";
pub const PAYOFF_FINAL: &str = "终结";

/// 超期阈值按档位（章）：短≈两个桥段、中≈一个单元、长≈2~3 个单元。
/// 只提示不拦截；复活信号＝用户想调（届时进 项目.yaml）。
pub const OVERDUE_SHORT: u32 = 8;
pub const OVERDUE_MID: u32 = 20;
pub const OVERDUE_LONG: u32 = 50;

/// 手写的未知档位按中档阈值提示（只提示不校验）。
pub fn overdue_threshold(horizon: &str) -> u32 {
    match horizon.trim() {
        HORIZON_SHORT => OVERDUE_SHORT,
        HORIZON_LONG => OVERDUE_LONG,
        _ => OVERDUE_MID,
    }
}

// ---------- 数据模型 ----------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expectation {
    /// 期待线名＝身份；同名在「从正文标注」时合并（追加埋设/兑现）。
    pub name: String,
    /// 期待｜目标；缺省读作「期待」。
    pub kind: String,
    /// 短｜中｜长；缺省读作「中」。
    pub horizon: String,
    /// 五态之一；缺省读作「待埋」。
    pub state: String,
    /// 独立于五态状态机的待打磨标记；false 不落盘。
    pub pending: bool,
    pub planted: Vec<Anchor>,
    pub fulfilled: Vec<Payoff>,
}

/// 看板条目：在 Expectation 之上加派生字段（未推进章数、超期、引文失配）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectationView {
    pub name: String,
    pub kind: String,
    pub horizon: String,
    pub state: String,
    pub pending: bool,
    pub planted: Vec<AnchorView>,
    pub fulfilled: Vec<PayoffView>,
    /// 距当前最大章序已过多少章未推进（仅已埋/部分兑现有值）。
    pub unadvanced_chapters: Option<u32>,
    pub overdue: bool,
}

/// 时间线网格的数据：轴长＋条目。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectationBoard {
    /// 轴长＝max(全书最大章序, 锚点最大章)——锚点落在已删章上也不越界。
    pub max_chapter: u32,
    /// 三线.yaml 当前内容指纹，作为待打磨键切换的乐观锁版本。
    pub table_fingerprint: Option<String>,
    pub items: Vec<ExpectationView>,
}

pub fn expectation_path(project: &Path) -> PathBuf {
    project.join(EXPECTATION_FILE)
}

// ---------- 读写 ----------

struct ExpectationSnapshot {
    items: Vec<Expectation>,
    raw: Option<String>,
    fingerprint: Option<String>,
}

fn parse_expectation(map: &Mapping, path: &Path, index: usize) -> Result<Expectation, String> {
    let name = map_scalar(map, "名")
        .filter(|n| !n.trim().is_empty())
        .ok_or_else(|| format!("{} 第 {index} 项缺「名」", path.display()))?;
    let pending_key = Value::String("待打磨".into());
    let pending = match map.get(&pending_key) {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(_) => {
            return Err(format!(
                "{} 第 {index} 项的「待打磨」应为布尔值",
                path.display()
            ));
        }
    };
    Ok(Expectation {
        name,
        kind: map_scalar(map, "类别").unwrap_or_else(|| KIND_EXPECTATION.to_string()),
        horizon: map_scalar(map, "档位").unwrap_or_else(|| HORIZON_MID.to_string()),
        state: map_scalar(map, "状态").unwrap_or_else(|| STATE_PENDING.to_string()),
        pending,
        planted: thread::map_anchors(map, "埋设", path, index)?,
        fulfilled: thread::map_payoffs(map, "兑现", path, index, PAYOFF_STAGE)?,
    })
}

fn read_expectation_snapshot(project: &Path) -> Result<ExpectationSnapshot, String> {
    let path = expectation_path(project);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ExpectationSnapshot {
                items: Vec::new(),
                raw: None,
                fingerprint: None,
            });
        }
        Err(error) => return Err(format!("无法读取文件 {}：{error}", path.display())),
    };
    let fingerprint = content_fingerprint(&bytes).to_string();
    let raw = String::from_utf8(bytes).map_err(|error| {
        format!(
            "无法解析 {}：不是有效的 UTF-8 文本（{error}）",
            path.display()
        )
    })?;
    let items = thread::parse_threads_text(
        &raw,
        &path,
        "期待线条目（名/类别/档位/状态/待打磨/埋设/兑现）",
        parse_expectation,
    )?;
    Ok(ExpectationSnapshot {
        items,
        raw: Some(raw),
        fingerprint: Some(fingerprint),
    })
}

pub fn read_expectations(project: &Path) -> Result<Vec<Expectation>, String> {
    Ok(read_expectation_snapshot(project)?.items)
}

pub fn write_expectations(project: &Path, list: &[Expectation]) -> Result<(), String> {
    let snapshot = read_expectation_snapshot(project)?;
    let mut current: Value = match snapshot.raw.as_deref() {
        Some(raw) if raw.trim().is_empty() => Value::Sequence(Vec::new()),
        Some(raw) => serde_yaml::from_str(raw).map_err(|error| {
            format!("无法解析 {}：{error}", expectation_path(project).display())
        })?,
        None => Value::Sequence(Vec::new()),
    };
    let Value::Sequence(current_rows) = &mut current else {
        return Err(format!(
            "{} 顶层应为期待线列表",
            expectation_path(project).display()
        ));
    };
    if current_rows.len() != snapshot.items.len() {
        return Err(format!(
            "{} 条目数发生变化，请重新载入",
            expectation_path(project).display()
        ));
    }

    let mut seen = std::collections::HashSet::new();
    for item in &snapshot.items {
        if !seen.insert(item.name.as_str()) {
            return Err(format!("期待线「{}」重名，无法安全保存", item.name));
        }
    }
    seen.clear();
    for item in list {
        if !seen.insert(item.name.as_str()) {
            return Err(format!("期待线「{}」重名，无法安全保存", item.name));
        }
    }

    let mut rows = Vec::with_capacity(list.len());
    for item in list {
        let Some(index) = snapshot
            .items
            .iter()
            .position(|current| current.name == item.name)
        else {
            rows.push(Value::Mapping(render_expectation(item)));
            continue;
        };
        let mut map = current_rows[index]
            .as_mapping()
            .cloned()
            .ok_or_else(|| format!("期待线「{}」的数据格式异常", item.name))?;
        merge_expectation(&mut map, &snapshot.items[index], item);
        rows.push(Value::Mapping(map));
    }
    let text = serde_yaml::to_string(&Value::Sequence(rows))
        .map_err(|error| format!("无法生成 yaml：{error}"))?;
    write_text_atomic(&expectation_path(project), &text)
}

fn render_expectation(item: &Expectation) -> Mapping {
    let mut map = Mapping::new();
    map.insert(
        Value::String("名".into()),
        Value::String(item.name.trim().to_string()),
    );
    map.insert(
        Value::String("类别".into()),
        Value::String(non_empty(&item.kind, KIND_EXPECTATION)),
    );
    map.insert(
        Value::String("档位".into()),
        Value::String(non_empty(&item.horizon, HORIZON_MID)),
    );
    map.insert(
        Value::String("状态".into()),
        Value::String(non_empty(&item.state, STATE_PENDING)),
    );
    if item.pending {
        map.insert(Value::String("待打磨".into()), Value::Bool(true));
    }
    if !item.planted.is_empty() {
        map.insert(
            Value::String("埋设".into()),
            thread::anchors_value(&item.planted),
        );
    }
    if !item.fulfilled.is_empty() {
        map.insert(
            Value::String("兑现".into()),
            thread::payoffs_value(&item.fulfilled),
        );
    }
    map
}

fn merge_expectation(map: &mut Mapping, current: &Expectation, next: &Expectation) {
    set_string_if_changed(map, "类别", &current.kind, &next.kind);
    set_string_if_changed(map, "档位", &current.horizon, &next.horizon);
    set_string_if_changed(map, "状态", &current.state, &next.state);
    if next.pending {
        map.insert(Value::String("待打磨".into()), Value::Bool(true));
    }
    merge_rows(
        map,
        "埋设",
        &current.planted,
        &next.planted,
        thread::anchors_value,
    );
    merge_rows(
        map,
        "兑现",
        &current.fulfilled,
        &next.fulfilled,
        thread::payoffs_value,
    );
}

fn set_string_if_changed(map: &mut Mapping, key: &str, current: &str, next: &str) {
    if current != next {
        map.insert(
            Value::String(key.to_string()),
            Value::String(non_empty(next, current)),
        );
    }
}

fn merge_rows<T: PartialEq>(
    map: &mut Mapping,
    key: &str,
    current: &[T],
    next: &[T],
    render: impl Fn(&[T]) -> Value,
) {
    if current == next {
        return;
    }
    if next.is_empty() {
        map.remove(Value::String(key.to_string()));
        return;
    }
    if next.len() > current.len() && next.starts_with(current) {
        let Value::Sequence(additional) = render(&next[current.len()..]) else {
            return;
        };
        let map_key = Value::String(key.to_string());
        if let Some(Value::Sequence(existing)) = map.get_mut(&map_key) {
            existing.extend(additional);
        } else {
            map.insert(map_key, Value::Sequence(additional));
        }
        return;
    }
    map.insert(Value::String(key.to_string()), render(next));
}

/// 只切换原目标条目的「待打磨」键。先比对页面读取时的整表指纹，
/// 再从当前 YAML 映射上单点修改，保留未知字段、其他条目与条目次序。
pub fn set_expectation_pending(
    project: &Path,
    name: &str,
    pending: bool,
    expected_fingerprint: &str,
) -> Result<crate::book_file::SaveResult, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("期待线名不能为空".to_string());
    }
    let path = expectation_path(project);
    let snapshot = read_expectation_snapshot(project)?;
    if snapshot.fingerprint.as_deref() != Some(expected_fingerprint) {
        return Ok(crate::book_file::SaveResult::Conflict);
    }
    let Some(raw) = snapshot.raw else {
        return Err(format!("没有找到期待线「{name}」"));
    };
    let mut value: Value = serde_yaml::from_str(&raw)
        .map_err(|error| format!("无法解析 {}：{error}", path.display()))?;
    let Value::Sequence(rows) = &mut value else {
        return Err(format!("{} 顶层应为期待线列表", path.display()));
    };
    let matches: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter_map(|(index, row)| {
            row.as_mapping()
                .and_then(|map| map_scalar(map, "名"))
                .is_some_and(|row_name| row_name == name)
                .then_some(index)
        })
        .collect();
    let index = match matches.as_slice() {
        [] => return Err(format!("没有找到期待线「{name}」")),
        [index] => *index,
        _ => return Err(format!("期待线「{name}」重名，无法安全定位")),
    };
    let Some(map) = rows[index].as_mapping_mut() else {
        // The table was validated above; this remains a defensive guard if its shape changes.
        return Err(format!("{} 第 {} 项应为映射", path.display(), index + 1));
    };
    let key = Value::String("待打磨".into());
    if pending {
        map.insert(key, Value::Bool(true));
    } else {
        map.remove(&key);
    }
    let text = serde_yaml::to_string(&value).map_err(|error| format!("无法生成 yaml：{error}"))?;
    write_text_atomic(&path, &text)?;
    Ok(crate::book_file::SaveResult::Saved {
        fingerprint: content_fingerprint(text.as_bytes()).to_string(),
    })
}

fn non_empty(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

// ---------- 操作 ----------

fn check_kind(kind: &str) -> Result<String, String> {
    let kind = kind.trim();
    if KINDS.contains(&kind) {
        Ok(kind.to_string())
    } else {
        Err(format!("未知类别「{kind}」（期待｜目标）"))
    }
}

fn check_horizon(horizon: &str) -> Result<String, String> {
    let horizon = horizon.trim();
    if HORIZONS.contains(&horizon) {
        Ok(horizon.to_string())
    } else {
        Err(format!("未知档位「{horizon}」（短｜中｜长）"))
    }
}

/// 看板新建待埋：填名字＋类别＋档位；重名报错不合并。
pub fn add_expectation(
    project: &Path,
    name: &str,
    kind: &str,
    horizon: &str,
) -> Result<Vec<Expectation>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("期待线名不能为空".to_string());
    }
    let kind = check_kind(kind)?;
    let horizon = check_horizon(horizon)?;
    let mut list = read_expectations(project)?;
    if list.iter().any(|e| e.name == name) {
        return Err(format!("已存在同名期待线「{name}」"));
    }
    list.push(Expectation {
        name: name.to_string(),
        kind,
        horizon,
        state: STATE_PENDING.to_string(),
        pending: false,
        planted: Vec::new(),
        fulfilled: Vec::new(),
    });
    write_expectations(project, &list)?;
    Ok(list)
}

/// 记为三线：同名不存在→新建（已埋，用弹窗选的类别/档位）；已存在→追加
/// 埋设（待埋→已埋），类别/档位以已有为准。同（章, 引文）重复标注不重复追加。
pub fn annotate_expectation(
    project: &Path,
    name: &str,
    chapter: u32,
    quote: &str,
    kind: &str,
    horizon: &str,
) -> Result<Vec<Expectation>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("期待线名不能为空".to_string());
    }
    let quote = quote.trim();
    if quote.is_empty() {
        return Err("引文不能为空".to_string());
    }
    let mut list = read_expectations(project)?;
    let anchor = Anchor {
        chapter,
        quote: quote.to_string(),
    };
    match list.iter_mut().find(|e| e.name == name) {
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
        None => {
            let kind = check_kind(kind)?;
            let horizon = check_horizon(horizon)?;
            list.push(Expectation {
                name: name.to_string(),
                kind,
                horizon,
                state: STATE_PLANTED.to_string(),
                pending: false,
                planted: vec![anchor],
                fulfilled: Vec::new(),
            });
        }
    }
    write_expectations(project, &list)?;
    Ok(list)
}

/// 兑现三线：追加兑现记录；终结→已兑现，阶段→部分兑现（弃用不覆盖）。
pub fn fulfill_expectation(
    project: &Path,
    name: &str,
    chapter: u32,
    quote: &str,
    kind: &str,
    note: Option<&str>,
) -> Result<Vec<Expectation>, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("期待线名不能为空".to_string());
    }
    let quote = quote.trim();
    if quote.is_empty() {
        return Err("引文不能为空".to_string());
    }
    let kind = match kind.trim() {
        PAYOFF_STAGE => PAYOFF_STAGE,
        PAYOFF_FINAL => PAYOFF_FINAL,
        other => return Err(format!("兑现类型只能是「阶段」或「终结」，收到「{other}」")),
    };
    let note = note.map(str::trim).filter(|n| !n.is_empty());
    let mut list = read_expectations(project)?;
    let item = list
        .iter_mut()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("没有找到期待线「{name}」"))?;
    let dup = item.fulfilled.iter().any(|p| {
        p.chapter == chapter && p.quote == quote && p.kind == kind && p.note.as_deref() == note
    });
    if !dup {
        item.fulfilled.push(Payoff {
            chapter,
            quote: quote.to_string(),
            kind: kind.to_string(),
            note: note.map(str::to_string),
        });
    }
    if item.state != STATE_DROPPED {
        item.state = if kind == PAYOFF_FINAL {
            STATE_DONE
        } else {
            STATE_PARTIAL
        }
        .to_string();
    }
    write_expectations(project, &list)?;
    Ok(list)
}

/// 改状态（看板）：五态任切，含弃用与恢复。
pub fn set_expectation_state(
    project: &Path,
    name: &str,
    state: &str,
) -> Result<Vec<Expectation>, String> {
    let state = state.trim();
    if !STATES.contains(&state) {
        return Err(format!(
            "未知状态「{state}」（待埋｜已埋｜部分兑现｜已兑现｜弃用）"
        ));
    }
    let name = name.trim();
    let mut list = read_expectations(project)?;
    let item = list
        .iter_mut()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("没有找到期待线「{name}」"))?;
    item.state = state.to_string();
    write_expectations(project, &list)?;
    Ok(list)
}

/// 改类别/档位（看板详情卡）：重分类。手写的未知值**保持不变**时放行
/// （只提示不校验），只有真要改成新值才校验——否则改类别会被未知档位卡住。
pub fn set_expectation_meta(
    project: &Path,
    name: &str,
    kind: &str,
    horizon: &str,
) -> Result<Vec<Expectation>, String> {
    let name = name.trim();
    let mut list = read_expectations(project)?;
    let item = list
        .iter_mut()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("没有找到期待线「{name}」"))?;
    let kind = kind.trim();
    if kind != item.kind {
        item.kind = check_kind(kind)?;
    }
    let horizon = horizon.trim();
    if horizon != item.horizon {
        item.horizon = check_horizon(horizon)?;
    }
    write_expectations(project, &list)?;
    Ok(list)
}

pub fn delete_expectation(project: &Path, name: &str) -> Result<Vec<Expectation>, String> {
    let name = name.trim();
    let mut list = read_expectations(project)?;
    let before = list.len();
    list.retain(|e| e.name != name);
    if list.len() == before {
        return Err(format!("没有找到期待线「{name}」"));
    }
    write_expectations(project, &list)?;
    Ok(list)
}

// ---------- 看板（派生视图，现扫） ----------

/// 时间线网格数据：读三线.yaml ＋ 现扫正文算未推进章数/超期/引文失配。
/// 未推进＝最大章序 − 最近一次锚点章（埋设或兑现都算推进，与伏笔只算埋设不同）。
pub fn expectation_board(project: &Path) -> Result<ExpectationBoard, String> {
    let snapshot = read_expectation_snapshot(project)?;
    let table_fingerprint = snapshot.fingerprint;
    let list = snapshot.items;
    let texts = thread::ChapterTexts::load(project)?;
    let max_ordinal = texts.max_ordinal();
    let mut max_chapter = max_ordinal;
    for item in &list {
        for anchor in &item.planted {
            max_chapter = max_chapter.max(anchor.chapter);
        }
        for payoff in &item.fulfilled {
            max_chapter = max_chapter.max(payoff.chapter);
        }
    }
    let items = list
        .into_iter()
        .map(|item| {
            let last_anchor = item
                .planted
                .iter()
                .map(|a| a.chapter)
                .chain(item.fulfilled.iter().map(|p| p.chapter))
                .max();
            let unadvanced_chapters = match (item.state.as_str(), last_anchor) {
                (STATE_PLANTED, Some(last)) | (STATE_PARTIAL, Some(last)) => {
                    Some(thread::chapters_since(max_ordinal, last))
                }
                _ => None,
            };
            let threshold = overdue_threshold(&item.horizon);
            ExpectationView {
                name: item.name,
                kind: item.kind,
                horizon: item.horizon,
                state: item.state,
                pending: item.pending,
                planted: texts.anchor_views(&item.planted),
                fulfilled: texts.payoff_views(&item.fulfilled),
                unadvanced_chapters,
                overdue: unadvanced_chapters.is_some_and(|n| n >= threshold),
            }
        })
        .collect();
    Ok(ExpectationBoard {
        max_chapter,
        table_fingerprint,
        items,
    })
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

    fn fingerprint(board: &ExpectationBoard) -> &str {
        board.table_fingerprint.as_deref().unwrap()
    }

    #[test]
    fn 新建待埋_类别档位_重名报错_未知值报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let list =
            add_expectation(&p, "主角何时亮出金手指", KIND_EXPECTATION, HORIZON_SHORT).unwrap();
        assert_eq!(list[0].state, STATE_PENDING);
        assert_eq!(list[0].kind, KIND_EXPECTATION);
        assert_eq!(list[0].horizon, HORIZON_SHORT);

        assert!(add_expectation(&p, "主角何时亮出金手指", KIND_GOAL, HORIZON_LONG).is_err());
        assert!(add_expectation(&p, "  ", KIND_EXPECTATION, HORIZON_SHORT).is_err());
        assert!(add_expectation(&p, "别的", "悬念", HORIZON_SHORT).is_err());
        assert!(add_expectation(&p, "别的", KIND_EXPECTATION, "超长").is_err());
    }

    #[test]
    fn 标注_新建已埋_同名追加_已有类别档位不被覆盖() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());

        let list = annotate_expectation(
            &p,
            "木匣里的东西",
            1,
            "他摸了摸怀里的木匣",
            KIND_EXPECTATION,
            HORIZON_SHORT,
        )
        .unwrap();
        assert_eq!(list[0].state, STATE_PLANTED);
        assert_eq!(list[0].horizon, HORIZON_SHORT);

        // 同章同引文重复标注不重复追加。
        let list = annotate_expectation(
            &p,
            "木匣里的东西",
            1,
            "他摸了摸怀里的木匣",
            KIND_EXPECTATION,
            HORIZON_SHORT,
        )
        .unwrap();
        assert_eq!(list[0].planted.len(), 1);

        // 后续章再标注 → 追加埋设；传别的类别/档位不改已有值。
        let list = annotate_expectation(
            &p,
            "木匣里的东西",
            5,
            "木匣还在怀里",
            KIND_GOAL,
            HORIZON_LONG,
        )
        .unwrap();
        assert_eq!(list[0].planted.len(), 2);
        assert_eq!(list[0].kind, KIND_EXPECTATION);
        assert_eq!(list[0].horizon, HORIZON_SHORT);

        // 先建待埋，再从正文标注 → 升已埋。
        add_expectation(&p, "玉佩", KIND_GOAL, HORIZON_MID).unwrap();
        let list = annotate_expectation(&p, "玉佩", 2, "腰间的玉佩不见了", KIND_GOAL, HORIZON_MID)
            .unwrap();
        let jade = list.iter().find(|e| e.name == "玉佩").unwrap();
        assert_eq!(jade.state, STATE_PLANTED);
        assert_eq!(jade.planted.len(), 1);

        // 新建时校验类别/档位；空引文/空名报错且不落盘。
        assert!(annotate_expectation(&p, "新的", 1, "引文", "悬念", HORIZON_SHORT).is_err());
        assert!(
            annotate_expectation(&p, "  ", 1, "引文", KIND_EXPECTATION, HORIZON_SHORT).is_err()
        );
        assert!(annotate_expectation(&p, "名", 1, "  ", KIND_EXPECTATION, HORIZON_SHORT).is_err());
    }

    #[test]
    fn 兑现_阶段部分兑现_终结已兑现_弃用不覆盖_重复不追加() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        annotate_expectation(&p, "木匣", 1, "木匣", KIND_EXPECTATION, HORIZON_SHORT).unwrap();

        let list =
            fulfill_expectation(&p, "木匣", 9, "木匣开了", PAYOFF_STAGE, Some("只露一角")).unwrap();
        assert_eq!(list[0].state, STATE_PARTIAL);
        assert_eq!(list[0].fulfilled[0].note.as_deref(), Some("只露一角"));

        // 完全相同的一条不重复追加。
        let list =
            fulfill_expectation(&p, "木匣", 9, "木匣开了", PAYOFF_STAGE, Some("只露一角")).unwrap();
        assert_eq!(list[0].fulfilled.len(), 1);

        let list = fulfill_expectation(&p, "木匣", 30, "铜钱见光", PAYOFF_FINAL, None).unwrap();
        assert_eq!(list[0].state, STATE_DONE);
        assert_eq!(list[0].fulfilled.len(), 2);

        // 弃用态不被兑现覆盖。
        set_expectation_state(&p, "木匣", STATE_DROPPED).unwrap();
        let list = fulfill_expectation(&p, "木匣", 31, "又收一次", PAYOFF_STAGE, None).unwrap();
        assert_eq!(list[0].state, STATE_DROPPED);

        // 未知类型/未知条目报错。
        assert!(fulfill_expectation(&p, "木匣", 32, "x", "彻底", None).is_err());
        assert!(fulfill_expectation(&p, "没有这条", 32, "x", PAYOFF_STAGE, None).is_err());
    }

    #[test]
    fn 状态与元数据_任切_未知报错_删除() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        annotate_expectation(&p, "木匣", 1, "木匣", KIND_EXPECTATION, HORIZON_SHORT).unwrap();
        for state in STATES {
            let list = set_expectation_state(&p, "木匣", state).unwrap();
            assert_eq!(list[0].state, state);
        }
        assert!(set_expectation_state(&p, "木匣", "烂尾").is_err());

        let list = set_expectation_meta(&p, "木匣", KIND_GOAL, HORIZON_LONG).unwrap();
        assert_eq!(list[0].kind, KIND_GOAL);
        assert_eq!(list[0].horizon, HORIZON_LONG);
        assert!(set_expectation_meta(&p, "木匣", "悬念", HORIZON_LONG).is_err());
        assert!(set_expectation_meta(&p, "木匣", KIND_GOAL, "超长").is_err());

        let list = delete_expectation(&p, "木匣").unwrap();
        assert!(list.is_empty());
        assert!(delete_expectation(&p, "木匣").is_err());

        // 手写的未知档位：原样带回时放行（只提示不校验），改别的字段不被它卡住。
        write(
            &expectation_path(&p),
            "- 名: 手写的线\n  类别: 期待\n  档位: 超长\n  状态: 已埋\n",
        );
        let list = set_expectation_meta(&p, "手写的线", KIND_GOAL, "超长").unwrap();
        assert_eq!(list[0].horizon, "超长");
        assert_eq!(list[0].kind, KIND_GOAL);
        // 真要改成新值时才校验：未知值报错，合法值生效。
        assert!(set_expectation_meta(&p, "手写的线", KIND_GOAL, "巨长").is_err());
        let list = set_expectation_meta(&p, "手写的线", KIND_GOAL, HORIZON_SHORT).unwrap();
        assert_eq!(list[0].horizon, HORIZON_SHORT);
    }

    #[test]
    fn 读写_默认值_未知键保留_损坏报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        // 手写条目：缺类别/档位/状态 → 期待/中/待埋；往返不要求旧文件迁移。
        write(
            &expectation_path(&p),
            "- 名: 手写的线\n  私货: 保留\n  埋设:\n  - 章: 2\n    引文: 手写\n    锚点私货: 也保留\n",
        );
        let list = read_expectations(&p).unwrap();
        assert_eq!(list[0].kind, KIND_EXPECTATION);
        assert_eq!(list[0].horizon, HORIZON_MID);
        assert_eq!(list[0].state, STATE_PENDING);
        write_expectations(&p, &list).unwrap();
        let raw = fs::read_to_string(expectation_path(&p)).unwrap();
        assert!(raw.contains("私货: 保留"), "条目内未知键应保留：{raw}");
        assert!(raw.contains("锚点私货: 也保留"), "嵌套未知键应保留：{raw}");
        assert!(raw.contains("名: 手写的线"));

        // 兑现缺「类型」→ 阶段。
        write(
            &expectation_path(&p),
            "- 名: 线\n  状态: 部分兑现\n  兑现:\n  - 章: 3\n    引文: 兑现了\n",
        );
        let list = read_expectations(&p).unwrap();
        assert_eq!(list[0].fulfilled[0].kind, PAYOFF_STAGE);

        write(&expectation_path(&p), "名: 不是列表\n");
        assert!(read_expectations(&p).is_err());
        write(&expectation_path(&p), "- 类别: 期待\n");
        assert!(read_expectations(&p).is_err());
    }

    #[test]
    fn 待打磨_期待感与目标往返_保留条目字段和原顺序() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &expectation_path(&p),
            "- 名: 期待线\n  类别: 期待\n  档位: 短\n  状态: 部分兑现\n  私货: 原样留下\n  埋设:\n  - 章: 2\n    引文: 怀里的木匣\n  兑现:\n  - 章: 5\n    引文: 木匣开启\n    类型: 阶段\n    说明: 只露一角\n- 名: 目标线\n  类别: 目标\n  档位: 长\n  状态: 已埋\n  待打磨: false\n  私货: 第二条也留下\n",
        );

        let initial = expectation_board(&p).unwrap();
        assert!(initial.items.iter().all(|item| !item.pending));
        set_expectation_pending(&p, "期待线", true, fingerprint(&initial)).unwrap();

        let after_expectation = expectation_board(&p).unwrap();
        let expectation = after_expectation
            .items
            .iter()
            .find(|item| item.name == "期待线")
            .unwrap();
        assert!(expectation.pending);
        assert_eq!(expectation.kind, KIND_EXPECTATION);
        assert_eq!(expectation.horizon, HORIZON_SHORT);
        assert_eq!(expectation.state, STATE_PARTIAL);
        assert_eq!(expectation.planted[0].quote, "怀里的木匣");
        assert_eq!(expectation.fulfilled[0].note.as_deref(), Some("只露一角"));
        set_expectation_pending(&p, "目标线", true, fingerprint(&after_expectation)).unwrap();

        let both_pending = expectation_board(&p).unwrap();
        assert!(both_pending.items.iter().all(|item| item.pending));
        let target = both_pending
            .items
            .iter()
            .find(|item| item.name == "目标线")
            .unwrap();
        assert_eq!(target.kind, KIND_GOAL);
        assert_eq!(target.horizon, HORIZON_LONG);
        assert_eq!(target.state, STATE_PLANTED);
        set_expectation_pending(&p, "期待线", false, fingerprint(&both_pending)).unwrap();

        let after_exit = expectation_board(&p).unwrap();
        let expectation = after_exit
            .items
            .iter()
            .find(|item| item.name == "期待线")
            .unwrap();
        assert!(!expectation.pending);
        assert_eq!(expectation.kind, KIND_EXPECTATION);
        assert_eq!(expectation.horizon, HORIZON_SHORT);
        assert_eq!(expectation.state, STATE_PARTIAL);
        set_expectation_pending(&p, "目标线", false, fingerprint(&after_exit)).unwrap();

        let raw = fs::read_to_string(expectation_path(&p)).unwrap();
        let rows: Vec<Value> = serde_yaml::from_str(&raw).unwrap();
        assert_eq!(rows.len(), 2);
        let first = rows[0].as_mapping().unwrap();
        let second = rows[1].as_mapping().unwrap();
        assert_eq!(map_scalar(first, "名").as_deref(), Some("期待线"));
        assert_eq!(map_scalar(second, "名").as_deref(), Some("目标线"));
        assert!(!first.contains_key(Value::String("待打磨".into())));
        assert!(!second.contains_key(Value::String("待打磨".into())));
        assert_eq!(map_scalar(first, "私货").as_deref(), Some("原样留下"));
        assert_eq!(map_scalar(second, "私货").as_deref(), Some("第二条也留下"));
    }

    #[test]
    fn 待打磨_外部修改或重名时拒绝覆盖() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &expectation_path(&p),
            "- 名: 唯一线\n  类别: 期待\n  档位: 中\n  状态: 待埋\n  私货: 原值\n",
        );
        let before_external_change = expectation_board(&p).unwrap();
        let external = "- 名: 唯一线\n  类别: 期待\n  档位: 长\n  状态: 待埋\n  私货: 外部更新\n";
        write(&expectation_path(&p), external);
        assert!(matches!(
            set_expectation_pending(&p, "唯一线", true, fingerprint(&before_external_change)),
            Ok(crate::book_file::SaveResult::Conflict)
        ));
        assert_eq!(fs::read_to_string(expectation_path(&p)).unwrap(), external);

        let before_damage = expectation_board(&p).unwrap();
        let damaged = "- 名: 唯一线\n  待打磨: [\n";
        write(&expectation_path(&p), damaged);
        assert!(set_expectation_pending(&p, "唯一线", true, fingerprint(&before_damage)).is_err());
        assert_eq!(fs::read_to_string(expectation_path(&p)).unwrap(), damaged);

        let duplicate = "- 名: 重名线\n  类别: 期待\n- 名: 重名线\n  类别: 目标\n";
        write(&expectation_path(&p), duplicate);
        let current = expectation_board(&p).unwrap();
        assert!(set_expectation_pending(&p, "重名线", true, fingerprint(&current)).is_err());
        assert_eq!(fs::read_to_string(expectation_path(&p)).unwrap(), duplicate);
    }

    #[test]
    fn 待打磨_编辑业务状态时保留原标记锚点和未知字段() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &expectation_path(&p),
            "- 名: 去京城\n  类别: 目标\n  档位: 长\n  状态: 已埋\n  待打磨: true\n  私货: 留着\n  埋设:\n  - 章: 3\n    引文: 启程\n    锚点备注: 留着\n",
        );

        let updated = set_expectation_state(&p, "去京城", STATE_PARTIAL).unwrap();
        assert!(updated[0].pending);
        assert_eq!(updated[0].state, STATE_PARTIAL);
        assert_eq!(updated[0].kind, KIND_GOAL);
        assert_eq!(updated[0].horizon, HORIZON_LONG);
        assert_eq!(updated[0].planted[0].quote, "启程");
        let raw = fs::read_to_string(expectation_path(&p)).unwrap();
        assert!(raw.contains("待打磨: true"));
        assert!(raw.contains("私货: 留着"));
        assert!(raw.contains("锚点备注: 留着"));
    }

    #[test]
    fn 看板_未推进按最近锚点_超期按档位_失配() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        chapter(&p, 1, "初入江湖", "他摸了摸怀里的木匣，没敢打开。");
        chapter(&p, 10, "夜宴", "木匣开了，里面是一枚旧铜钱。");
        chapter(&p, 26, "远行", "主角收拾行囊。");

        // 短线：埋于 1、阶段兑现于 10 → 最近锚点 10，最大章序 26 → 16 章未推进 → 超期（阈值 8）。
        annotate_expectation(
            &p,
            "木匣",
            1,
            "他摸了摸怀里的木匣，没敢打开。",
            KIND_EXPECTATION,
            HORIZON_SHORT,
        )
        .unwrap();
        fulfill_expectation(
            &p,
            "木匣",
            10,
            "木匣开了，里面是一枚旧铜钱。",
            PAYOFF_STAGE,
            None,
        )
        .unwrap();

        // 中线：只埋于 26 → 未推进 0，不超期。
        annotate_expectation(&p, "去京城", 26, "主角收拾行囊。", KIND_GOAL, HORIZON_MID).unwrap();

        // 长线：埋于 1，未推进 25 → 阈值 50，不超期但记数。
        annotate_expectation(
            &p,
            "主角身世",
            1,
            "他摸了摸怀里的木匣，没敢打开。",
            KIND_EXPECTATION,
            HORIZON_LONG,
        )
        .unwrap();

        // 已兑现/待埋/弃用不算未推进。
        annotate_expectation(
            &p,
            "已还的账",
            1,
            "他摸了摸怀里的木匣，没敢打开。",
            KIND_GOAL,
            HORIZON_SHORT,
        )
        .unwrap();
        fulfill_expectation(
            &p,
            "已还的账",
            10,
            "木匣开了，里面是一枚旧铜钱。",
            PAYOFF_FINAL,
            None,
        )
        .unwrap();
        add_expectation(&p, "还没写", KIND_EXPECTATION, HORIZON_SHORT).unwrap();
        annotate_expectation(
            &p,
            "弃了的",
            1,
            "他摸了摸怀里的木匣，没敢打开。",
            KIND_EXPECTATION,
            HORIZON_SHORT,
        )
        .unwrap();
        set_expectation_state(&p, "弃了的", STATE_DROPPED).unwrap();

        // 引文失配：章 1 里找不到这句话。
        annotate_expectation(
            &p,
            "失配的线",
            1,
            "这句话已经不在正文里了",
            KIND_EXPECTATION,
            HORIZON_SHORT,
        )
        .unwrap();

        let board = expectation_board(&p).unwrap();
        assert_eq!(board.max_chapter, 26);

        let boxed = board.items.iter().find(|v| v.name == "木匣").unwrap();
        assert_eq!(boxed.state, STATE_PARTIAL);
        assert_eq!(boxed.unadvanced_chapters, Some(16));
        assert!(boxed.overdue);
        assert!(!boxed.planted[0].stale);
        assert!(!boxed.fulfilled[0].stale);

        let capital = board.items.iter().find(|v| v.name == "去京城").unwrap();
        assert_eq!(capital.unadvanced_chapters, Some(0));
        assert!(!capital.overdue);

        let identity = board.items.iter().find(|v| v.name == "主角身世").unwrap();
        assert_eq!(identity.unadvanced_chapters, Some(25));
        assert!(!identity.overdue, "长线阈值 50，25 章还不算超期");

        let done = board.items.iter().find(|v| v.name == "已还的账").unwrap();
        assert_eq!(done.state, STATE_DONE);
        assert_eq!(done.unadvanced_chapters, None);

        let pending = board.items.iter().find(|v| v.name == "还没写").unwrap();
        assert_eq!(pending.unadvanced_chapters, None);

        let dropped = board.items.iter().find(|v| v.name == "弃了的").unwrap();
        assert_eq!(dropped.unadvanced_chapters, None);

        let stale = board.items.iter().find(|v| v.name == "失配的线").unwrap();
        assert!(stale.planted[0].stale);
    }

    #[test]
    fn 看板_轴长含已删章的锚点_缺章文件算失配() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        chapter(&p, 1, "初入江湖", "钥匙。");
        // 锚点落在章 9，但章文件不存在（被删）→ 轴长仍到 9，且标失配。
        annotate_expectation(&p, "钥匙", 9, "钥匙", KIND_EXPECTATION, HORIZON_SHORT).unwrap();
        let board = expectation_board(&p).unwrap();
        assert_eq!(board.max_chapter, 9);
        assert!(board.items[0].planted[0].stale);
        // 最大章序仍是 1（现扫只看盘上章文件），未推进＝1-9 饱和减 → 0。
        assert_eq!(board.items[0].unadvanced_chapters, Some(0));
    }
}
