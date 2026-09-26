//! 人物关系画布（工单 #8，docs/spec/人物关系画布.md）。
//!
//! **关系网＝一张网住一个文件**：`构思/人物关系.yaml`（图例 ＋ 边表），
//! 人物文件只管小传（#4 的纪律「关系不在这里定」）。一张网一个文件，
//! 反向关系由应用现算——**没有镜像副本，也就没有一致性问题**。
//!
//! **坐标不落盘**：画布布局是由边表与人物分组现算的纯函数派生
//! （#12 无索引纪律）；文件里的东西只有图例与边，没有位置。
//!
//! **引用失效只提示不校验**：边引用了不存在的人物（画不出来）、引用了
//! 图例外的类型（照画缺省样式）都只列出来，删改留给人。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};

use crate::book_file::{
    map_scalar, read_yaml_mapping, sanitize_file_name, write_yaml_mapping,
};
use crate::project::{self, NoteDraft, NoteEntry, NoteKind};

pub const RELATION_FILE: &str = "人物关系.yaml";

pub const DIRECTED: &str = "有向";
pub const UNDIRECTED: &str = "无向";

/// 图例项的色板：按图例顺序取色（手写文件里留空色的项，读/写两侧都按
/// 位置补——读回来一致，落盘也不留空色）。
const PALETTE: [&str; 8] = [
    "#c0392b", "#7f8c8d", "#8e44ad", "#2e86c1", "#d68910", "#16a085", "#c2185b", "#5d6d7e",
];

/// 缺省图例（四类种子，单一事实源）：师徒有向，其余无向。
/// 与 #10 词表同一条先例——类型有内置种子起步，人可增删改。
const DEFAULT_LEGEND: [(&str, bool); 4] = [
    ("师徒", true),
    ("敌对", false),
    ("私情", false),
    ("亲戚", false),
];

/// 边引用了图例外的类型时的兜底样式（前端 types.ts 有镜像常量）。
pub const FALLBACK_COLOR: &str = "#7f8c8d";
pub const FALLBACK_DIRECTED: bool = true;

// ---------- 数据模型 ----------

/// 图例项：画布级「可命名、有序、可绑定方向的分类集合」。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendItem {
    pub name: String,
    pub color: String,
    /// 方向是图例项的属性，边继承它（不逐条设）。
    pub directed: bool,
}

/// 一条关系（边）：起→止 只表示有向边的方向，不表示归属。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    /// 新社会网的载入版本与条目位置，编辑端点时仍能归还该条目的未知键。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_row: Option<String>,
    pub from: String,
    pub to: String,
    /// 类型，按名引用图例项（图例外照画缺省样式，只提示）。
    pub kind: String,
    pub note: Option<String>,
    /// 秘密标记：可叠加在任何类型上的布尔（方法论「未解之谜」）。
    pub secret: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipTable {
    #[serde(default)]
    pub fingerprint: Option<String>,
    pub legend: Vec<LegendItem>,
    pub edges: Vec<Relationship>,
}

/// 画布视图（派生，只读）：图例、边、失效引用、图例外的类型。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipView {
    pub fingerprint: Option<String>,
    pub legend: Vec<LegendItem>,
    /// 文件里的**全部**边，保文件次序——**保存时的唯一底稿**：
    /// 失效引用的边也在里面，整表写回才不会把它们悄悄丢掉。
    ///（画布只画两端人物都在的那些，见 `missing`。）
    pub edges: Vec<Relationship>,
    /// 其中引用了不存在人物的边（画不出来，只列给人看）——`edges` 的子集。
    pub missing: Vec<Relationship>,
    /// 边引用的、图例里没有的类型（照画兜底样式）；首见次序、去重。
    pub unknown_kinds: Vec<String>,
    /// 边表文件坏了（画布降级为缺省图例＋空表）时显式告警。
    pub warning: Option<String>,
}

/// 人物交汇（只读派生）：他们之间的边 ＋ 共同出现的单元。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confluence {
    pub edges: Vec<Relationship>,
    pub units: Vec<ConfluenceUnit>,
}

/// 一个提到过 ≥2 个选中人物的单元（人名纯文本提及，零结构）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfluenceUnit {
    pub name: String,
    /// 这个单元正文里提到过的选中人物。
    pub persons: Vec<String>,
}

pub fn default_legend() -> Vec<LegendItem> {
    DEFAULT_LEGEND
        .iter()
        .enumerate()
        .map(|(i, (name, directed))| LegendItem {
            name: (*name).to_string(),
            color: palette_color(i),
            directed: *directed,
        })
        .collect()
}

fn palette_color(index: usize) -> String {
    PALETTE[index % PALETTE.len()].to_string()
}

pub fn relationship_path(project: &Path) -> PathBuf {
    if crate::social::graph_path(project).exists() {
        return crate::social::graph_path(project);
    }
    project.join(project::CONCEPT_DIR).join(RELATION_FILE)
}

// ---------- 读写 ----------

/// 读关系表：**文件不存在＝缺省图例＋空边表**（懒生成，与 `项目.yaml`
/// 同款）；存在但读不懂＝显式报错（调用方决定怎么亮给人看）。
pub fn read_table(project: &Path) -> Result<RelationshipTable, String> {
    let path = relationship_path(project);
    if !path.is_file() {
        return Ok(RelationshipTable {
            fingerprint: None,
            legend: default_legend(),
            edges: Vec::new(),
        });
    }
    let mut map = read_yaml_mapping(&path)?;
    if path == crate::social::graph_path(project) {
        map = crate::social::read_graph(project)?;
        // 旧人物画布仅投影人—人关系；组织边仍由同一社会网保存。
        if let Some(Value::Sequence(rows)) = map.get_mut(Value::String("关系".into())) {
            rows.retain(|v| v.as_mapping().is_some_and(|r| {
                map_scalar(r,"起类").as_deref().unwrap_or("人物") == "人物"
                    && map_scalar(r,"止类").as_deref().unwrap_or("人物") == "人物"
            }));
        }
    }
    let mut edges = edges_from(&map, &path)?;
    let fingerprint = if path == crate::social::graph_path(project) {
        let raw = std::fs::read(&path).map_err(|e|e.to_string())?;
        let version = crate::book_file::content_fingerprint(&raw);
        for (index, edge) in edges.iter_mut().enumerate() {
            edge.source_row = Some(format!("{version}:{index}"));
        }
        Some(version.to_string())
    } else { None };
    Ok(RelationshipTable {
        fingerprint,
        legend: legend_from(&map, &path)?,
        edges,
    })
}

/// 整表写（读-合-写：顶层未知键原样保留，ADR 0004 原子写）。
/// **读不懂的文件拒绝覆盖**（与 `vocabulary.rs` 的损坏词表同款）：画布在
/// 文件坏掉时是降级显示的（缺省图例＋空表），此时照常保存会把用户手写的
/// 整张网换成空表。所以先按读路径校验一遍——语法坏、形状坏都不写。
/// 条目内不认的键会被丢弃（应用受管，与伏笔.yaml 同一条纪律）。
pub fn save_table(project: &Path, table: &RelationshipTable) -> Result<(), String> {
    crate::social::ensure_idle(project)?;
    let legend = normalize_legend(&table.legend)?;
    let edges = normalize_edges(&table.edges)?;
    let path = relationship_path(project);
    if path == crate::social::graph_path(project) {
        return crate::social::save_person_relationships(project, &legend, &edges, table.fingerprint.as_deref());
    }
    read_table(project)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("无法创建文件夹 {}：{e}", parent.display()))?;
    }
    let mut map = read_yaml_mapping(&path)?;
    map.insert(Value::String("图例".into()), legend_value(&legend));
    map.insert(Value::String("关系".into()), edges_value(&edges));
    write_yaml_mapping(&path, map)
}

fn legend_from(map: &Mapping, path: &Path) -> Result<Vec<LegendItem>, String> {
    let Some(value) = map.get(Value::String("图例".into())) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 的「图例」应为列表", path.display()));
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| {
            let Value::Mapping(row) = item else {
                return Err(format!("{} 图例第 {} 项应为映射（名/色/方向）", path.display(), i + 1));
            };
            let name = map_scalar(row, "名")
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| format!("{} 图例第 {} 项缺「名」", path.display(), i + 1))?;
            let color = map_scalar(row, "色").unwrap_or_else(|| palette_color(i));
            // 方向只有两个值；认不出/缺省一律按「无向」画（约定值，只提示不校验），
            // 不为一个手滑的方向值把整张网判成读不懂。
            let directed = map_scalar(row, "方向").as_deref() == Some(DIRECTED);
            Ok(LegendItem {
                name,
                color,
                directed,
            })
        })
        .collect()
}

fn edges_from(map: &Mapping, path: &Path) -> Result<Vec<Relationship>, String> {
    let Some(value) = map.get(Value::String("关系".into())) else {
        return Ok(Vec::new());
    };
    if value.is_null() {
        return Ok(Vec::new());
    }
    let Value::Sequence(seq) = value else {
        return Err(format!("{} 的「关系」应为列表", path.display()));
    };
    seq.iter()
        .enumerate()
        .map(|(i, item)| {
            let Value::Mapping(row) = item else {
                return Err(format!(
                    "{} 关系第 {} 项应为映射（起/止/类型/描述/秘密）",
                    path.display(),
                    i + 1
                ));
            };
            let at = i + 1;
            let required = |key: &str| {
                map_scalar(row, key)
                    .filter(|v| !v.trim().is_empty())
                    .ok_or_else(|| format!("{} 关系第 {at} 项缺「{key}」", path.display()))
            };
            let secret = match row.get(Value::String("秘密".into())) {
                None | Some(Value::Null) => false,
                Some(Value::Bool(b)) => *b,
                Some(_) => {
                    return Err(format!(
                        "{} 关系第 {at} 项的「秘密」应为 true/false",
                        path.display()
                    ))
                }
            };
            Ok(Relationship {
                source_row: None,
                from: required("起")?,
                to: required("止")?,
                kind: required("类型")?,
                note: map_scalar(row, "描述"),
                secret,
            })
        })
        .collect()
}

/// 落盘前的收口：名称非空、图例不重名、两端不是同一个人（列表项本身可以重复）。
fn normalize_legend(legend: &[LegendItem]) -> Result<Vec<LegendItem>, String> {
    let mut out: Vec<LegendItem> = Vec::new();
    for item in legend {
        let name = item.name.trim();
        if name.is_empty() {
            return Err("图例项的名称不能为空".to_string());
        }
        if out.iter().any(|l| l.name == name) {
            return Err(format!("图例里有两项同名「{name}」，先改名再保存"));
        }
        let color = item.color.trim();
        out.push(LegendItem {
            name: name.to_string(),
            color: if color.is_empty() {
                palette_color(out.len())
            } else {
                color.to_string()
            },
            directed: item.directed,
        });
    }
    Ok(out)
}

fn normalize_edges(edges: &[Relationship]) -> Result<Vec<Relationship>, String> {
    edges
        .iter()
        .map(|edge| {
            let from = edge.from.trim();
            let to = edge.to.trim();
            let kind = edge.kind.trim();
            if from.is_empty() || to.is_empty() {
                return Err("关系的两端都要选人物".to_string());
            }
            if from == to {
                return Err(format!("关系的两端不能是同一个人（{from}）"));
            }
            if kind.is_empty() {
                return Err("关系要选一个类型".to_string());
            }
            Ok(Relationship {
                source_row: edge.source_row.clone(),
                from: from.to_string(),
                to: to.to_string(),
                kind: kind.to_string(),
                note: edge
                    .note
                    .as_deref()
                    .map(str::trim)
                    .filter(|n| !n.is_empty())
                    .map(str::to_string),
                secret: edge.secret,
            })
        })
        .collect()
}

fn legend_value(legend: &[LegendItem]) -> Value {
    Value::Sequence(
        legend
            .iter()
            .map(|item| {
                let mut m = Mapping::new();
                m.insert(Value::String("名".into()), Value::String(item.name.clone()));
                m.insert(Value::String("色".into()), Value::String(item.color.clone()));
                m.insert(
                    Value::String("方向".into()),
                    Value::String(if item.directed { DIRECTED } else { UNDIRECTED }.to_string()),
                );
                Value::Mapping(m)
            })
            .collect(),
    )
}

fn edges_value(edges: &[Relationship]) -> Value {
    Value::Sequence(
        edges
            .iter()
            .map(|edge| {
                let mut m = Mapping::new();
                m.insert(Value::String("起".into()), Value::String(edge.from.clone()));
                m.insert(Value::String("止".into()), Value::String(edge.to.clone()));
                m.insert(Value::String("类型".into()), Value::String(edge.kind.clone()));
                if let Some(note) = edge.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                    m.insert(Value::String("描述".into()), Value::String(note.to_string()));
                }
                // 缺省否，只写 true（文件干净：没秘密的边不长尾巴）。
                if edge.secret {
                    m.insert(Value::String("秘密".into()), Value::Bool(true));
                }
                Value::Mapping(m)
            })
            .collect(),
    )
}

// ---------- 派生视图（现扫，无索引） ----------

/// 画布数据：读关系表＋现扫人物名单，算失效引用、图例外的类型。
/// 表坏了**不拖垮画布**——降级为缺省图例＋空表并显式告警（#4 同款）。
pub fn relationship_view(project: &Path) -> RelationshipView {
    let persons = person_names(project);
    match read_table(project) {
        Ok(table) => {
            let mut missing = Vec::new();
            let mut unknown_kinds: Vec<String> = Vec::new();
            for edge in &table.edges {
                if !persons.contains(&edge.from) || !persons.contains(&edge.to) {
                    missing.push(edge.clone());
                }
                if !table.legend.iter().any(|l| l.name == edge.kind)
                    && !unknown_kinds.contains(&edge.kind)
                {
                    unknown_kinds.push(edge.kind.clone());
                }
            }
            RelationshipView {
                fingerprint: table.fingerprint,
                legend: table.legend,
                edges: table.edges,
                missing,
                unknown_kinds,
                warning: None,
            }
        }
        Err(e) => RelationshipView {
            fingerprint: None,
            legend: default_legend(),
            edges: Vec::new(),
            missing: Vec::new(),
            unknown_kinds: Vec::new(),
            warning: Some(e),
        },
    }
}

/// 人物名单（人名＝文件名），现扫 `构思/人物/`。
fn person_names(project: &Path) -> Vec<String> {
    project::scan_notes(project, NoteKind::Character)
        .map(|list| list.into_iter().map(|n| n.name).collect())
        .unwrap_or_default()
}

/// 人物交汇：他们之间的边 ＋ 共同出现的单元（正文提到 ≥2 个选中人物的
/// 那些，零结构、不新增字段）。
pub fn character_confluence(project: &Path, names: &[String]) -> Result<Confluence, String> {
    let names = clean_names(names)?;
    if names.len() < 2 {
        return Err("至少选两个人物再看交汇".to_string());
    }
    let edges = read_table(project)?
        .edges
        .into_iter()
        .filter(|e| names.contains(&e.from) && names.contains(&e.to))
        .collect();
    let units = project::scan_notes(project, NoteKind::Unit)?
        .into_iter()
        .filter_map(|unit| {
            let persons: Vec<String> = names
                .iter()
                .filter(|n| unit.body.contains(n.as_str()))
                .cloned()
                .collect();
            (persons.len() >= 2).then_some(ConfluenceUnit {
                name: unit.name,
                persons,
            })
        })
        .collect();
    Ok(Confluence { edges, units })
}

// ---------- 提为矛盾 ----------

/// 选中数人「提为矛盾」（spec §6.1）：建 `构思/矛盾/<名>.md`，正文给
/// 空骨架 ＋ 一行「涉及人物」（人名＋他们之间的边，带类型与秘密标记）。
/// **不生成剧情内容**（ADR 0003）——矛盾是种子，边是「这几个人为什么能
/// 凑出剧情」的最小依据，分析结论会变成要维护的欠账。
/// 同名矛盾已存在报错让人裁决（不自动续号）。
pub fn promote_characters_to_contradiction(
    project: &Path,
    names: &[String],
    name: Option<&str>,
) -> Result<NoteEntry, String> {
    let names = clean_names(names)?;
    if names.len() < 2 {
        return Err("至少选两个人物再提为矛盾".to_string());
    }
    let persons = person_names(project);
    for n in &names {
        if !persons.contains(n) {
            return Err(format!("没有找到人物「{n}」"));
        }
    }
    let title = match name.map(str::trim).filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => names.join("·"),
    };
    let safe = sanitize_file_name(&title)?;
    let path = project::notes_dir(project, NoteKind::Contradiction).join(format!("{safe}.md"));
    if path.exists() {
        return Err(format!("已存在同名矛盾「{safe}」，先改名或删掉旧矛盾再提"));
    }

    let table = read_table(project)?;
    let mut draft = NoteDraft::new(NoteKind::Contradiction, title);
    draft.status = Some("池中".to_string());
    draft.body = character_prefill(&names, &table);
    project::save_note(project, &draft, None)
}

/// 预填正文：一行「涉及人物：张三（师徒→李四·秘密）、王五」。
/// 每条边挂在它的「起」名下（无向边用「－」），选中集之外的边不写。
fn character_prefill(names: &[String], table: &RelationshipTable) -> String {
    let parts: Vec<String> = names
        .iter()
        .map(|person| {
            let edges: Vec<String> = table
                .edges
                .iter()
                .filter(|e| &e.from == person && names.contains(&e.to))
                .map(|e| edge_prefill(e, &table.legend))
                .collect();
            if edges.is_empty() {
                person.clone()
            } else {
                format!("{person}（{}）", edges.join("、"))
            }
        })
        .collect();
    format!("涉及人物：{}\n", parts.join("、"))
}

/// 人物的边里，这个类型是不是有向（图例命中）；图例外走兜底。
/// 单一实现：预填正文（本模块）与 AI 材料（ai_context）共用，前端有镜像。
pub fn directed_of(kind: &str, legend: &[LegendItem]) -> bool {
    legend
        .iter()
        .find(|l| l.name == kind)
        .map(|l| l.directed)
        .unwrap_or(FALLBACK_DIRECTED)
}

/// 人名收口：去空白、去重保序（空的忽略）；一个都不剩就报错。
pub fn clean_names(names: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for name in names {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if !out.iter().any(|n| n == name) {
            out.push(name.to_string());
        }
    }
    if out.is_empty() {
        return Err("没有选中人物".to_string());
    }
    Ok(out)
}

fn edge_prefill(edge: &Relationship, legend: &[LegendItem]) -> String {
    let arrow = if directed_of(&edge.kind, legend) {
        "→"
    } else {
        "－"
    };
    let secret = if edge.secret { "·秘密" } else { "" };
    format!("{}{arrow}{}{secret}", edge.kind, edge.to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::NoteKind;
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
        fs::create_dir_all(dir.join("构思/人物")).unwrap();
        dir
    }

    fn person(project: &Path, name: &str, group: &str) {
        write(
            &project.join(format!("构思/人物/{name}.md")),
            &format!("---\n分组: {group}\n---\n\n{name}的小传。\n"),
        );
    }

    fn unit(project: &Path, name: &str, body: &str) {
        write(
            &project.join(format!("构思/单元/{name}.md")),
            &format!("---\n核心矛盾: {name}\n---\n\n{body}\n"),
        );
    }

    fn edge(from: &str, to: &str, kind: &str) -> Relationship {
        Relationship {
            source_row: None,
            from: from.to_string(),
            to: to.to_string(),
            kind: kind.to_string(),
            note: None,
            secret: false,
        }
    }

    #[test]
    fn 读_文件不存在给缺省图例与空边表() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let table = read_table(&p).unwrap();
        assert_eq!(table.legend, default_legend());
        assert_eq!(table.legend.len(), 4);
        assert_eq!(table.legend[0].name, "师徒");
        assert!(table.legend[0].directed);
        assert!(!table.legend[1].directed);
        assert!(table.edges.is_empty());
        assert!(!relationship_path(&p).exists(), "读不该落盘（懒生成）");
    }

    #[test]
    fn 写读_往返_方向与秘密只写必要的键() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let mut table = read_table(&p).unwrap();
        table.edges.push(Relationship {
            source_row: None,
            from: "张三".into(),
            to: "李四".into(),
            kind: "师徒".into(),
            note: Some("收徒实为监视".into()),
            secret: true,
        });
        table.edges.push(edge("张三", "王五", "敌对"));
        save_table(&p, &table).unwrap();

        let raw = fs::read_to_string(relationship_path(&p)).unwrap();
        assert!(raw.contains("名: 师徒"), "{raw}");
        assert!(raw.contains("方向: 有向"), "{raw}");
        assert!(raw.contains("方向: 无向"), "{raw}");
        assert!(raw.contains("秘密: true"), "{raw}");
        // 没秘密的边不长尾巴、没描述的边不写「描述」。
        assert_eq!(raw.matches("秘密: true").count(), 1, "{raw}");
        assert_eq!(raw.matches("描述:").count(), 1, "{raw}");

        let back = read_table(&p).unwrap();
        assert_eq!(back.legend, table.legend);
        assert_eq!(back.edges, table.edges);
    }

    #[test]
    fn 写_顶层未知键保留_条目内未知键丢弃() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(
            &relationship_path(&p),
            "备注: 手写的说明\n图例:\n- 名: 师徒\n  色: \"#c0392b\"\n  方向: 有向\n  私货: 会丢\n",
        );
        let table = read_table(&p).unwrap();
        save_table(&p, &table).unwrap();
        let raw = fs::read_to_string(relationship_path(&p)).unwrap();
        assert!(raw.contains("备注: 手写的说明"), "顶层未知键该保留：{raw}");
        assert!(!raw.contains("私货"), "条目内未知键整表重写会丢：{raw}");
    }

    #[test]
    fn 读_损坏或不合法显式报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&relationship_path(&p), "图例: 不是列表\n");
        assert!(read_table(&p).is_err());
        write(&relationship_path(&p), "关系:\n- 起: 张三\n  止: 李四\n");
        assert!(read_table(&p).unwrap_err().contains("类型"));
        write(&relationship_path(&p), "关系:\n- 起: 张三\n  止: 李四\n  类型: 师徒\n  秘密: 是\n");
        assert!(read_table(&p).unwrap_err().contains("秘密"));
    }

    #[test]
    fn 读_认不出的方向按无向() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        // 方向是这两个值的约定值、只提示不校验：一个手滑值不该把整张网判成读不懂。
        write(
            &relationship_path(&p),
            "图例:\n- 名: 师徒\n  色: \"#c0392b\"\n  方向: 有向\n- 名: 旧识\n  方向: 单相思\n- 名: 亲戚\n",
        );
        let table = read_table(&p).unwrap();
        assert_eq!(table.legend.len(), 3);
        assert!(table.legend[0].directed);
        assert!(!table.legend[1].directed, "认不出的方向按无向");
        assert!(!table.legend[2].directed, "缺省方向按无向");
        assert_eq!(table.legend[1].color, PALETTE[1], "缺省色按位置补");
    }

    #[test]
    fn 写_读不懂的文件拒绝覆盖() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        // 画布在坏文件上是降级显示的（缺省图例＋空表）；照常保存会把整张网换成空表。
        for broken in ["关系: 不是列表\n", "{{{{ 不是 yaml\n"] {
            write(&relationship_path(&p), broken);
            let view = relationship_view(&p);
            let err = save_table(
                &p,
                &RelationshipTable {
                    fingerprint: view.fingerprint,
                    legend: view.legend,
                    edges: view.edges,
                },
            )
            .unwrap_err();
            assert!(!err.is_empty(), "{broken}");
            assert_eq!(
                fs::read_to_string(relationship_path(&p)).unwrap(),
                broken,
                "读不懂的文件不该被覆盖"
            );
        }
    }

    #[test]
    fn 写_图例重名与两端同人报错_空色按位置补() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        let mut table = read_table(&p).unwrap();
        table.legend.push(LegendItem {
            name: "师徒".into(),
            color: String::new(),
            directed: true,
        });
        assert!(save_table(&p, &table).unwrap_err().contains("同名"));

        let mut table = read_table(&p).unwrap();
        table.legend.push(LegendItem {
            name: "上下级".into(),
            color: String::new(),
            directed: true,
        });
        table.edges.push(edge("张三", "张三", "师徒"));
        assert!(save_table(&p, &table).unwrap_err().contains("同一个人"));

        let mut table = read_table(&p).unwrap();
        table.legend.push(LegendItem {
            name: "上下级".into(),
            color: String::new(),
            directed: true,
        });
        save_table(&p, &table).unwrap();
        let back = read_table(&p).unwrap();
        assert_eq!(back.legend[4].color, PALETTE[4]);
    }

    #[test]
    fn 视图_失效引用与图例外的类型只提示() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        let mut table = read_table(&p).unwrap();
        table.edges.push(edge("张三", "李四", "师徒"));
        table.edges.push(edge("张三", "查无此人", "师徒"));
        table.edges.push(edge("李四", "张三", "旧识"));
        table.edges.push(edge("李四", "张三", "旧识"));
        save_table(&p, &table).unwrap();

        let view = relationship_view(&p);
        assert!(view.warning.is_none());
        // edges 是文件里的全部边（保存底稿，失效引用那条也在），保文件次序。
        assert_eq!(view.edges.len(), 4);
        assert_eq!(view.missing.len(), 1);
        assert_eq!(view.missing[0].to, "查无此人");
        assert_eq!(view.edges[1], view.missing[0]);
        // 图例外类型首见次序、去重。
        assert_eq!(view.unknown_kinds, vec!["旧识".to_string()]);
        assert_eq!(view.legend.len(), 4);
    }

    #[test]
    fn 视图_存回不丢失效引用与图例外类型() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        let mut table = read_table(&p).unwrap();
        table.edges.push(edge("张三", "查无此人", "旧识"));
        save_table(&p, &table).unwrap();

        let view = relationship_view(&p);
        // 画布存回用的就是 view.edges——失效引用必须留在里面，不然一次保存就没了。
        save_table(&p, &RelationshipTable {
            fingerprint: view.fingerprint,
            legend: view.legend,
            edges: view.edges,
        })
        .unwrap();
        let back = read_table(&p).unwrap();
        assert_eq!(back.edges, table.edges);
    }

    #[test]
    fn 视图_表坏了降级并告警() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        write(&relationship_path(&p), "关系: 不是列表\n");
        let view = relationship_view(&p);
        assert!(view.warning.is_some());
        assert_eq!(view.legend, default_legend());
        assert!(view.edges.is_empty());
    }

    #[test]
    fn 交汇_边与共同单元_单人报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        person(&p, "王五", "敌方");
        unit(&p, "初入京城", "张三与李四在城门口相遇。");
        unit(&p, "宫变前夜", "只有王五在场。");
        unit(&p, "夜宴", "张三、李四、王五同桌。");
        let mut table = read_table(&p).unwrap();
        table.edges.push(edge("张三", "李四", "师徒"));
        table.edges.push(edge("张三", "王五", "敌对"));
        save_table(&p, &table).unwrap();

        let names = vec!["张三".to_string(), "李四".to_string()];
        let found = character_confluence(&p, &names).unwrap();
        assert_eq!(found.edges.len(), 1);
        assert_eq!(found.edges[0].kind, "师徒");
        let unit_names: Vec<&str> = found.units.iter().map(|u| u.name.as_str()).collect();
        assert_eq!(unit_names, vec!["初入京城", "夜宴"], "只留提到 ≥2 人的单元");
        // persons 只列「选中的」人物：王五在正文里也出现过，但没被选中。
        assert_eq!(found.units[1].persons, vec!["张三", "李四"]);

        assert!(character_confluence(&p, &["张三".to_string()]).is_err());
    }

    #[test]
    fn 交集_去重去空白保序() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        let names = vec![" 张三 ".to_string(), "张三".to_string(), "李四".to_string()];
        let found = character_confluence(&p, &names).unwrap();
        assert!(found.units.is_empty());
        assert!(character_confluence(&p, &[" ".to_string()]).is_err());
    }

    #[test]
    fn 提为矛盾_预填人名与边_同名报错_单人报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        person(&p, "王五", "敌方");
        let mut table = read_table(&p).unwrap();
        table.edges.push(Relationship {
            source_row: None,
            from: "张三".into(),
            to: "李四".into(),
            kind: "师徒".into(),
            note: Some("收徒实为监视".into()),
            secret: true,
        });
        table.edges.push(Relationship {
            source_row: None,
            from: "李四".into(),
            to: "王五".into(),
            kind: "敌对".into(),
            note: None,
            secret: false,
        });
        // 选中集之外的边不进预填。
        table.edges.push(Relationship {
            source_row: None,
            from: "王五".into(),
            to: "赵六".into(),
            kind: "私情".into(),
            note: None,
            secret: false,
        });
        save_table(&p, &table).unwrap();

        let names = vec!["张三".to_string(), "李四".to_string()];
        let note = promote_characters_to_contradiction(&p, &names, Some("师徒疑云")).unwrap();
        assert_eq!(note.kind, NoteKind::Contradiction);
        assert_eq!(note.name, "师徒疑云");
        assert_eq!(note.status.as_deref(), Some("池中"));
        // 只有选中集内的边进预填（李四→王五 的边不写：王五不在这一份种子里）；
        // 秘密边带「·秘密」，无向边用「－」。
        assert_eq!(note.body, "涉及人物：张三（师徒→李四·秘密）、李四");

        assert!(promote_characters_to_contradiction(&p, &names, Some("师徒疑云"))
            .unwrap_err()
            .contains("同名矛盾"));
        assert!(promote_characters_to_contradiction(&p, &["张三".to_string()], None).is_err());
        assert!(promote_characters_to_contradiction(
            &p,
            &["张三".to_string(), "查无此人".to_string()],
            None
        )
        .unwrap_err()
        .contains("没有找到人物"));
    }

    #[test]
    fn 提为矛盾_名字缺省串人名() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        let names = vec!["张三".to_string(), "李四".to_string()];
        let note = promote_characters_to_contradiction(&p, &names, None).unwrap();
        assert_eq!(note.name, "张三·李四");
        assert_eq!(note.body, "涉及人物：张三、李四");
    }

    #[test]
    fn 提为矛盾_表坏了显式报错() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        write(&relationship_path(&p), "关系: 不是列表\n");
        let names = vec!["张三".to_string(), "李四".to_string()];
        assert!(promote_characters_to_contradiction(&p, &names, None).is_err());
    }

    /// 临时库全流程冒烟：建人物 → 连边（落盘）→ 读回画布 → 交汇 →
    /// 提为矛盾 → AI 材料，一条链走通，并确认落盘的 yaml 是人能读的。
    #[test]
    fn 端到端_临时库全流程冒烟() {
        let tmp = TempDir::new().unwrap();
        let p = project(tmp.path());
        person(&p, "张三", "主角阵营");
        person(&p, "李四", "主角阵营");
        unit(&p, "初入京城", "张三与李四在城门口相遇。");
        unit(&p, "宫变前夜", "张三独闯宫门。");
        write(&p.join("构思/类型圈.md"), "---\n类型:\n  - 掉马甲\n---\n");

        // 连边：图例用缺省四类种子，加一条秘密边。
        let mut table = read_table(&p).unwrap();
        table.edges.push(Relationship {
            source_row: None,
            from: "张三".into(),
            to: "李四".into(),
            kind: "师徒".into(),
            note: Some("收徒实为监视".into()),
            secret: true,
        });
        save_table(&p, &table).unwrap();

        let raw = fs::read_to_string(relationship_path(&p)).unwrap();
        assert!(raw.contains("名: 师徒") && raw.contains("秘密: true"), "{raw}");

        // 读回画布：图例、边、无失效引用。
        let view = relationship_view(&p);
        assert!(view.warning.is_none());
        assert_eq!(view.edges.len(), 1);
        assert!(view.missing.is_empty());
        assert!(view.unknown_kinds.is_empty(), "{:?}", view.unknown_kinds);

        // 交汇：共同出现的单元只有一个。
        let names = vec!["张三".to_string(), "李四".to_string()];
        let found = character_confluence(&p, &names).unwrap();
        assert_eq!(found.edges.len(), 1);
        assert_eq!(
            found.units.iter().map(|u| u.name.as_str()).collect::<Vec<_>>(),
            vec!["初入京城"]
        );

        // 提为矛盾：预填人名与边，状态池中。
        let note = promote_characters_to_contradiction(&p, &names, None).unwrap();
        assert_eq!(note.name, "张三·李四");
        assert_eq!(note.body, "涉及人物：张三（师徒→李四·秘密）、李四");
        assert!(p.join("构思/矛盾/张三·李四.md").is_file());

        // AI 材料（只读）：小传、边、类型圈、矛盾标题都在。
        let material =
            crate::ai_context::build_context("人物关系梳理", &p, None, &names).unwrap();
        assert!(material.contains("- 张三 ｜ 分组：主角阵营"), "{material}");
        assert!(material.contains("张三 → 李四 ｜ 类型：师徒"), "{material}");
        assert!(material.contains("【类型圈】掉马甲"), "{material}");
        assert!(material.contains("【已有矛盾】共 1 条：张三·李四"), "{material}");
    }
}
