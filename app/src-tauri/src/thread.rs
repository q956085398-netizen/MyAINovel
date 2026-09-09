//! 跨章节线索的共享底座（工单 #7，docs/spec/期待感三线.md §一）：
//! 伏笔（#6）与三线（#7）同构——锚点＝「章序数 ＋ 引文」、单文件整表读写、
//! 现扫派生（引文失配、未推进章数）。本模块放两边共用的形状（锚点/兑现/
//! 视图行）、读写与算法；状态值、操作与各自的看板条目留在各自模块。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::{map_scalar, map_u32, read_text, write_text_atomic};
use crate::chapter::scan_chapters;

// ---------- 数据模型 ----------

/// 埋设锚点：章序数（第几个章标题，1 起）＋ 选中引文。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub chapter: u32,
    pub quote: String,
}

/// 兑现/回收记录：章序数＋引文＋类型（阶段｜终结）＋可选说明。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Payoff {
    pub chapter: u32,
    pub quote: String,
    pub kind: String,
    pub note: Option<String>,
}

/// 锚点视图：引文在该章正文里找不到（章文件缺失也算失配）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorView {
    pub chapter: u32,
    pub quote: String,
    pub stale: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoffView {
    pub chapter: u32,
    pub quote: String,
    pub kind: String,
    pub note: Option<String>,
    pub stale: bool,
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

/// 读一张线索表（yaml 顶层列表）；文件不存在/空＝空表，解析失败显式报错。
/// `label` 只进错误信息（如「伏笔条目（名/状态/埋设/回收）」）。
pub fn read_threads<T>(
    path: &Path,
    label: &str,
    parse: impl Fn(&Mapping, &Path, usize) -> Result<T, String>,
) -> Result<Vec<T>, String> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = read_text(path)?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: Value =
        serde_yaml::from_str(&text).map_err(|e| format!("无法解析 {}：{e}", path.display()))?;
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 顶层应为列表（{label}）", path.display()));
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| {
            let Value::Mapping(map) = item else {
                return Err(format!(
                    "{} 第 {} 项应为映射（{label}）",
                    path.display(),
                    i + 1
                ));
            };
            parse(map, path, i + 1)
        })
        .collect()
}

/// 整表重写（原子写，ADR 0004）；`render` 把一条线索渲染成 yaml 映射。
pub fn write_threads<T>(
    path: &Path,
    list: &[T],
    render: impl Fn(&T) -> Value,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
    }
    let seq: Vec<Value> = list.iter().map(|item| render(item)).collect();
    let text = serde_yaml::to_string(&Value::Sequence(seq))
        .map_err(|e| format!("无法生成 yaml：{e}"))?;
    write_text_atomic(path, &text)
}

/// 取「埋设/兑现」列表的原始行（每行必须是映射）；缺键/null 视为空表。
pub fn map_rows<'a>(
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

pub fn map_anchors(
    map: &Mapping,
    key: &str,
    path: &Path,
    index: usize,
) -> Result<Vec<Anchor>, String> {
    map_rows(map, key, path, index)?
        .iter()
        .enumerate()
        .map(|(i, row)| {
            Ok(Anchor {
                chapter: required_chapter(row, key, path, index, i)?,
                quote: map_scalar(row, "引文").unwrap_or_default(),
            })
        })
        .collect()
}

pub fn map_payoffs(
    map: &Mapping,
    key: &str,
    path: &Path,
    index: usize,
    default_kind: &str,
) -> Result<Vec<Payoff>, String> {
    map_rows(map, key, path, index)?
        .iter()
        .enumerate()
        .map(|(i, row)| {
            Ok(Payoff {
                chapter: required_chapter(row, key, path, index, i)?,
                quote: map_scalar(row, "引文").unwrap_or_default(),
                kind: map_scalar(row, "类型").unwrap_or_else(|| default_kind.to_string()),
                note: map_scalar(row, "说明"),
            })
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

pub fn anchors_value(list: &[Anchor]) -> Value {
    Value::Sequence(
        list.iter()
            .map(|a| {
                let mut m = Mapping::new();
                m.insert(Value::String("章".into()), Value::Number(a.chapter.into()));
                m.insert(
                    Value::String("引文".into()),
                    Value::String(a.quote.trim().to_string()),
                );
                Value::Mapping(m)
            })
            .collect(),
    )
}

pub fn payoffs_value(list: &[Payoff]) -> Value {
    Value::Sequence(
        list.iter()
            .map(|p| {
                let mut m = Mapping::new();
                m.insert(Value::String("章".into()), Value::Number(p.chapter.into()));
                m.insert(
                    Value::String("引文".into()),
                    Value::String(p.quote.trim().to_string()),
                );
                m.insert(
                    Value::String("类型".into()),
                    Value::String(p.kind.trim().to_string()),
                );
                if let Some(note) = p.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    m.insert(Value::String("说明".into()), Value::String(note.to_string()));
                }
                Value::Mapping(m)
            })
            .collect(),
    )
}

// ---------- 现扫派生（无索引，#12） ----------

/// 现扫各章正文：引文失配判定与最大章序，伏笔/三线看板共用。
pub struct ChapterTexts {
    texts: BTreeMap<u32, Option<String>>,
}

impl ChapterTexts {
    pub fn load(project: &Path) -> Result<Self, String> {
        let chapters = scan_chapters(project)?;
        let mut texts: BTreeMap<u32, Option<String>> = BTreeMap::new();
        for chapter in &chapters {
            if let Some(ordinal) = chapter.ordinal {
                texts.insert(ordinal, read_text(&chapter.path).ok());
            }
        }
        Ok(Self { texts })
    }

    /// 全书最大章序（没有编号章＝0）。
    pub fn max_ordinal(&self) -> u32 {
        self.texts.keys().copied().max().unwrap_or(0)
    }

    /// 引文在指定章里找不到＝失配；章文件缺失（被删/被重编号挪走）也算失配。
    pub fn stale(&self, chapter: u32, quote: &str) -> bool {
        match self.texts.get(&chapter) {
            Some(Some(text)) => find_quote(text, quote).is_none(),
            _ => true,
        }
    }

    pub fn anchor_views(&self, anchors: &[Anchor]) -> Vec<AnchorView> {
        anchors
            .iter()
            .map(|a| AnchorView {
                chapter: a.chapter,
                quote: a.quote.clone(),
                stale: self.stale(a.chapter, &a.quote),
            })
            .collect()
    }

    pub fn payoff_views(&self, payoffs: &[Payoff]) -> Vec<PayoffView> {
        payoffs
            .iter()
            .map(|p| PayoffView {
                chapter: p.chapter,
                quote: p.quote.clone(),
                kind: p.kind.clone(),
                note: p.note.clone(),
                stale: self.stale(p.chapter, &p.quote),
            })
            .collect()
    }
}

/// 距当前最大章序已过多少章（饱和减）。
pub fn chapters_since(max_ordinal: u32, last_chapter: u32) -> u32 {
    max_ordinal.saturating_sub(last_chapter)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn write(path: &Path, content: &str) {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(path, content).unwrap();
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
        assert!(find_quote("", "钥匙").is_none());
    }

    #[test]
    fn 读_空文件空表_顶层非列表报错() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path: PathBuf = tmp.path().join("三线.yaml");
        assert!(read_threads(&path, "条目", |_, _, _| Ok(())).unwrap().is_empty());
        write(&path, "名: 不是列表\n");
        assert!(read_threads(&path, "条目", |_, _, _| Ok(())).is_err());
        write(&path, "- 名: 缺映射字段的解析由调用方管\n");
        let parsed = read_threads(&path, "条目", |map, _, _| {
            Ok(map_scalar(map, "名").unwrap_or_default())
        })
        .unwrap();
        assert_eq!(parsed, vec!["缺映射字段的解析由调用方管".to_string()]);
        write(&path, "- 标量\n");
        assert!(read_threads(&path, "条目", |_, _, _| Ok(())).is_err());
    }

    #[test]
    fn 读写_锚点与兑现往返() {
        let tmp = tempfile::TempDir::new().unwrap();
        let path = tmp.path().join("三线.yaml");
        let anchors = vec![Anchor {
            chapter: 3,
            quote: "  钥匙  ".into(),
        }];
        let payoffs = vec![Payoff {
            chapter: 9,
            quote: "开了门".into(),
            kind: "终结".into(),
            note: Some("收干净".into()),
        }];

        let mut map = Mapping::new();
        map.insert(Value::String("埋设".into()), anchors_value(&anchors));
        map.insert(Value::String("兑现".into()), payoffs_value(&payoffs));
        let text = serde_yaml::to_string(&Value::Mapping(map)).unwrap();
        let back: Mapping = serde_yaml::from_str(&text).unwrap();
        // 引文落盘去首尾空白，读回一致；说明保留。
        assert_eq!(
            map_anchors(&back, "埋设", &path, 1).unwrap(),
            vec![Anchor {
                chapter: 3,
                quote: "钥匙".into()
            }]
        );
        assert_eq!(
            map_payoffs(&back, "兑现", &path, 1, "阶段").unwrap(),
            payoffs
        );

        // 缺键/null＝空表；行不是映射＝报错；缺「章」＝报错。
        assert!(map_anchors(&Mapping::new(), "埋设", &path, 1)
            .unwrap()
            .is_empty());
        let scalar_row: Mapping = serde_yaml::from_str("埋设:\n- 3\n").unwrap();
        assert!(map_anchors(&scalar_row, "埋设", &path, 1).is_err());
        let no_chapter: Mapping = serde_yaml::from_str("埋设:\n- 引文: 钥匙\n").unwrap();
        assert!(map_anchors(&no_chapter, "埋设", &path, 1).is_err());
    }
}
