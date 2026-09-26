//! 组织与社会关系：文件实体、显式成员关系和可恢复的兼容升级（#58）。

use crate::book_file::{
    content_fingerprint, map_scalar, sanitize_file_name, set_map_scalar, split_frontmatter,
    strip_bom, write_text_atomic,
};
use crate::project::{self, NoteKind};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn key(s: &str) -> Value {
    Value::String(s.into())
}
pub fn graph_path(p: &Path) -> PathBuf {
    p.join("构思/关系.yaml")
}
fn journal_path(p: &Path) -> PathBuf {
    p.join(".gongbi/社会升级.json")
}
fn org_dir(p: &Path) -> PathBuf {
    p.join("构思/组织")
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationDraft {
    pub name: String,
    pub purpose: Option<String>,
    pub location: Option<String>,
    pub conflict: Option<String>,
    pub secret: Option<String>,
    pub body: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub path: PathBuf,
    pub draft: OrganizationDraft,
    pub fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Membership {
    pub person: String,
    pub organization: String,
    pub kind: String,
    pub role: Option<String>,
    pub status: String,
    pub secret: bool,
    pub note: Option<String>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocialWorkspace {
    pub organizations: Vec<Organization>,
    pub persons: Vec<String>,
    pub memberships: Vec<Membership>,
    pub fingerprint: String,
    pub upgraded: bool,
    pub recovery_needed: bool,
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("无法读取 {}：{e}", path.display())),
    }
}
fn strict_md(raw: &str) -> Result<(Mapping, String), String> {
    let raw = strip_bom(raw);
    if let Some((yaml, body)) = split_frontmatter(raw) {
        let map = if yaml.trim().is_empty() {
            Mapping::new()
        } else {
            match serde_yaml::from_str::<Value>(&yaml).map_err(|e| format!("档案头部损坏：{e}"))?
            {
                Value::Mapping(m) => m,
                _ => return Err("档案头部应为映射".into()),
            }
        };
        Ok((map, body))
    } else if raw.lines().next().is_some_and(|s| s.trim() == "---") {
        Err("档案头部未闭合，拒绝覆盖".into())
    } else {
        Ok((Mapping::new(), raw.into()))
    }
}
fn md_text(map: &Mapping, body: &str) -> Result<String, String> {
    Ok(format!(
        "---\n{}---\n\n{}",
        serde_yaml::to_string(map).map_err(|e| e.to_string())?,
        body
    ))
}
fn version(raw: &Option<String>) -> String {
    raw.as_ref()
        .map(|s| content_fingerprint(s.as_bytes()).to_string())
        .unwrap_or_else(|| "missing".into())
}
fn assert_version(path: &Path, expected: &str) -> Result<(), String> {
    if version(&read_optional(path)?) != expected {
        return Err("文件在载入后已改变，请刷新后重试".into());
    }
    Ok(())
}
pub(crate) fn ensure_idle(p: &Path) -> Result<(), String> {
    if journal_path(p).exists() {
        Err("上次社会关系升级未完成，请先恢复升级".into())
    } else {
        Ok(())
    }
}
fn organization(path: &Path) -> Result<Organization, String> {
    let raw = read_optional(path)?.ok_or("组织文件不存在")?;
    let (map, body) = strict_md(&raw)?;
    for k in ["目的", "所在地", "矛盾", "秘密"] {
        if let Some(v) = map.get(key(k)) {
            if !v.is_null() && !v.is_string() {
                return Err(format!("{} 的「{k}」应为文字，拒绝覆盖", path.display()));
            }
        }
    }
    Ok(Organization {
        path: path.into(),
        fingerprint: content_fingerprint(raw.as_bytes()).to_string(),
        draft: OrganizationDraft {
            name: crate::book_file::file_stem_of(path),
            purpose: map_scalar(&map, "目的"),
            location: map_scalar(&map, "所在地"),
            conflict: map_scalar(&map, "矛盾"),
            secret: map_scalar(&map, "秘密"),
            body,
        },
    })
}
pub fn save_organization(
    p: &Path,
    draft: &OrganizationDraft,
    expected: Option<&str>,
) -> Result<Organization, String> {
    ensure_idle(p)?;
    let name = sanitize_file_name(&draft.name)?;
    let path = org_dir(p).join(format!("{name}.md"));
    assert_version(&path, expected.unwrap_or("missing"))?;
    if path.exists() {
        organization(&path)?;
    }
    let mut map = match read_optional(&path)? {
        Some(s) => strict_md(&s)?.0,
        None => Mapping::new(),
    };
    for (k, v) in [
        ("目的", &draft.purpose),
        ("所在地", &draft.location),
        ("矛盾", &draft.conflict),
        ("秘密", &draft.secret),
    ] {
        set_map_scalar(&mut map, k, v.as_deref());
    }
    fs::create_dir_all(org_dir(p)).map_err(|e| e.to_string())?;
    write_text_atomic(&path, &md_text(&map, &draft.body)?)?;
    organization(&path)
}
pub fn delete_organization(p: &Path, name: &str, expected: &str) -> Result<(), String> {
    ensure_idle(p)?;
    let path = org_dir(p).join(format!("{}.md", sanitize_file_name(name)?));
    assert_version(&path, expected)?;
    fs::remove_file(path).map_err(|e| e.to_string())
}

/// 旧社会网不改写；新网一旦存在就是唯一来源。条目内未知键保留。
pub fn read_graph(p: &Path) -> Result<Mapping, String> {
    let path = if graph_path(p).exists() {
        graph_path(p)
    } else {
        project::notes_dir(p, NoteKind::Character)
            .parent()
            .unwrap()
            .join("人物关系.yaml")
    };
    let map = match read_optional(&path)? {
        None => Mapping::new(),
        Some(s) if s.trim().is_empty() => Mapping::new(),
        Some(s) => match serde_yaml::from_str::<Value>(&s)
            .map_err(|e| format!("{} 损坏：{e}", path.display()))?
        {
            Value::Mapping(m) => m,
            _ => return Err(format!("{} 应为映射，拒绝覆盖", path.display())),
        },
    };
    validate_graph(&map)?;
    Ok(map)
}
fn rows(map: &Mapping) -> Result<Vec<Mapping>, String> {
    match map.get(key("关系")) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Sequence(s)) => s
            .iter()
            .map(|v| match v {
                Value::Mapping(m) => Ok(m.clone()),
                _ => Err("社会关系条目应为映射".into()),
            })
            .collect(),
        _ => Err("社会关系应为列表".into()),
    }
}
fn node_kind(row: &Mapping, side: &str) -> Result<String, String> {
    match row.get(key(side)) {
        None | Some(Value::Null) => Ok("人物".into()),
        Some(Value::String(s)) if s == "人物" || s == "组织" => Ok(s.clone()),
        _ => Err(format!("「{side}」应为人物或组织")),
    }
}
fn required(row: &Mapping, k: &str) -> Result<String, String> {
    match row.get(key(k)) {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.clone()),
        _ => Err(format!("社会关系缺少有效的「{k}」")),
    }
}
fn boolean(row: &Mapping, k: &str) -> Result<bool, String> {
    match row.get(key(k)) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(format!("「{k}」应为 true/false")),
    }
}
fn validate_graph(map: &Mapping) -> Result<(), String> {
    if let Some(v) = map.get(key("图例")) {
        if !v.is_null() {
            let Value::Sequence(s) = v else {
                return Err("关系图例应为列表".into());
            };
            for v in s {
                let Value::Mapping(m) = v else {
                    return Err("图例项应为映射".into());
                };
                required(m, "名")?;
                for k in ["色", "方向"] {
                    if let Some(value) = m.get(key(k)) {
                        if !value.is_null() && !value.is_string() {
                            return Err(format!("图例的「{k}」应为文字"));
                        }
                    }
                }
            }
        }
    }
    for r in rows(map)? {
        required(&r, "起")?;
        required(&r, "止")?;
        required(&r, "类型")?;
        node_kind(&r, "起类")?;
        node_kind(&r, "止类")?;
        boolean(&r, "秘密")?;
        for k in ["职位", "描述"] {
            if let Some(v) = r.get(key(k)) {
                if !v.is_null() && !v.is_string() {
                    return Err(format!("「{k}」应为文字"));
                }
            }
        }
        if let Some(v) = r.get(key("任职")) {
            if !v.is_null() && v.as_str() != Some("现任") && v.as_str() != Some("前任") {
                return Err("任职应为现任或前任".into());
            }
        }
    }
    Ok(())
}
fn is_membership(r: &Mapping) -> bool {
    node_kind(r, "起类").as_deref() == Ok("人物") && node_kind(r, "止类").as_deref() == Ok("组织")
}
fn membership(r: &Mapping) -> Result<Membership, String> {
    Ok(Membership {
        person: required(r, "起")?,
        organization: required(r, "止")?,
        kind: required(r, "类型")?,
        role: map_scalar(r, "职位"),
        status: map_scalar(r, "任职").unwrap_or_else(|| "现任".into()),
        secret: boolean(r, "秘密")?,
        note: map_scalar(r, "描述"),
    })
}
fn member_row(m: &Membership, mut row: Mapping) -> Result<Mapping, String> {
    for (k, v) in [
        ("起", &m.person),
        ("止", &m.organization),
        ("类型", &m.kind),
    ] {
        if v.trim().is_empty() {
            return Err(format!("「{k}」不能为空"));
        }
        row.insert(key(k), key(v.trim()));
    }
    if m.status != "现任" && m.status != "前任" {
        return Err("任职应为现任或前任".into());
    }
    row.insert(key("起类"), key("人物"));
    row.insert(key("止类"), key("组织"));
    row.insert(key("任职"), key(&m.status));
    row.insert(key("秘密"), Value::Bool(m.secret));
    set_map_scalar(&mut row, "职位", m.role.as_deref());
    set_map_scalar(&mut row, "描述", m.note.as_deref());
    Ok(row)
}
pub fn workspace(p: &Path) -> Result<SocialWorkspace, String> {
    let mut organizations = vec![];
    if org_dir(p).exists() {
        for e in fs::read_dir(org_dir(p)).map_err(|e| e.to_string())? {
            let path = e.map_err(|e| e.to_string())?.path();
            if path.is_file()
                && crate::book_file::has_md_extension(&path)
                && !crate::book_file::is_hidden(&path)
            {
                organizations.push(organization(&path)?);
            }
        }
    }
    organizations.sort_by(|a, b| a.draft.name.cmp(&b.draft.name));
    let graph = read_graph(p)?;
    let memberships = rows(&graph)?
        .iter()
        .filter(|r| is_membership(r))
        .map(membership)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(SocialWorkspace {
        organizations,
        persons: project::scan_notes(p, NoteKind::Character)?
            .into_iter()
            .map(|n| n.name)
            .collect(),
        memberships,
        fingerprint: version(&read_optional(&graph_path(p))?),
        upgraded: graph_path(p).exists(),
        recovery_needed: journal_path(p).exists(),
    })
}
#[cfg(test)]
pub fn save_membership(
    p: &Path,
    m: &Membership,
    previous: Option<&Membership>,
) -> Result<(), String> {
    let expected = version(&read_optional(&graph_path(p))?);
    edit_membership(p, Some(m), previous, &expected)
}

/// 兼容旧人物画布的窄写：保留组织边、布局及所有未编辑条目的手补字段。
pub fn save_person_relationships(
    p: &Path,
    legend: &[crate::relationship::LegendItem],
    edges: &[crate::relationship::Relationship],
    expected: Option<&str>,
) -> Result<(), String> {
    ensure_idle(p)?;
    assert_version(
        &graph_path(p),
        expected.ok_or("缺少社会关系版本，请刷新画布")?,
    )?;
    let mut map = read_graph(p)?;
    let old = rows(&map)?;
    let person_edge = |r: &Mapping| {
        node_kind(r, "起类").as_deref() == Ok("人物")
            && node_kind(r, "止类").as_deref() == Ok("人物")
    };
    let original: Vec<Mapping> = old.iter().filter(|r| person_edge(r)).cloned().collect();
    let version = version(&read_optional(&graph_path(p))?);
    let mut used = std::collections::HashSet::new();
    let mut next: Vec<Value> = old
        .iter()
        .filter(|r| !person_edge(r))
        .cloned()
        .map(Value::Mapping)
        .collect();
    for e in edges {
        let found = if let Some(source) = &e.source_row {
            let (base, index) = source.split_once(':').ok_or("关系来源标识损坏，请刷新")?;
            if base != version {
                return Err("社会关系在载入后已改变，请刷新画布".into());
            }
            let index: usize = index.parse().map_err(|_| "关系来源标识损坏，请刷新")?;
            if index >= original.len() || !used.insert(index) {
                return Err("关系来源条目失效，请刷新".into());
            }
            Some(index)
        } else {
            original.iter().enumerate().position(|(i, r)| {
                !used.contains(&i) && {
                    map_scalar(r, "起").as_deref() == Some(&e.from)
                        && map_scalar(r, "止").as_deref() == Some(&e.to)
                        && map_scalar(r, "类型").as_deref() == Some(&e.kind)
                }
            })
        };
        if let Some(i) = found {
            used.insert(i);
        }
        let mut r = found.map(|i| original[i].clone()).unwrap_or_default();
        for (k, v) in [("起", &e.from), ("止", &e.to), ("类型", &e.kind)] {
            r.insert(key(k), key(v));
        }
        r.insert(key("起类"), key("人物"));
        r.insert(key("止类"), key("人物"));
        r.insert(key("秘密"), Value::Bool(e.secret));
        set_map_scalar(&mut r, "描述", e.note.as_deref());
        next.push(Value::Mapping(r));
    }
    let old_legend = map
        .get(key("图例"))
        .and_then(Value::as_sequence)
        .cloned()
        .unwrap_or_default();
    let legend = legend
        .iter()
        .map(|l| {
            let mut r = old_legend
                .iter()
                .filter_map(Value::as_mapping)
                .find(|r| map_scalar(r, "名").as_deref() == Some(&l.name))
                .cloned()
                .unwrap_or_default();
            r.insert(key("名"), key(&l.name));
            r.insert(key("色"), key(&l.color));
            r.insert(key("方向"), key(if l.directed { "有向" } else { "无向" }));
            Value::Mapping(r)
        })
        .collect();
    map.insert(key("关系"), Value::Sequence(next));
    map.insert(key("图例"), Value::Sequence(legend));
    crate::book_file::write_yaml_mapping(&graph_path(p), map)
}
pub fn edit_membership(
    p: &Path,
    next: Option<&Membership>,
    previous: Option<&Membership>,
    expected: &str,
) -> Result<(), String> {
    ensure_idle(p)?;
    if !graph_path(p).exists() {
        return Err("请先预览并确认升级社会关系".into());
    }
    assert_version(&graph_path(p), expected)?;
    let mut map = read_graph(p)?;
    let mut all = rows(&map)?;
    let index = if let Some(prev) = previous {
        Some(
            all.iter()
                .position(|r| is_membership(r) && membership(r).as_ref() == Ok(prev))
                .ok_or("原关系已改变，请刷新")?,
        )
    } else {
        None
    };
    match (next, index) {
        (Some(m), Some(i)) => all[i] = member_row(m, all[i].clone())?,
        (Some(m), None) => all.push(member_row(m, Mapping::new())?),
        (None, Some(i)) => {
            all.remove(i);
        }
        (None, None) => return Err("未选择要删除的关系".into()),
    }
    map.insert(
        key("关系"),
        Value::Sequence(all.into_iter().map(Value::Mapping).collect()),
    );
    crate::book_file::write_yaml_mapping(&graph_path(p), map)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: PathBuf,
    pub before: Option<String>,
    pub after: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradePreview {
    pub organizations: Vec<String>,
    pub changes: Vec<FileChange>,
    pub guards: Vec<(PathBuf, String)>,
}

pub fn preview_upgrade(p: &Path) -> Result<UpgradePreview, String> {
    ensure_idle(p)?;
    let mut graph = read_graph(p)?;
    if !graph_path(p).exists() && !p.join("构思/人物关系.yaml").exists() {
        let legend = crate::relationship::default_legend()
            .into_iter()
            .map(|l| {
                let mut row = Mapping::new();
                row.insert(key("名"), key(&l.name));
                row.insert(key("色"), key(&l.color));
                row.insert(key("方向"), key(if l.directed { "有向" } else { "无向" }));
                Value::Mapping(row)
            })
            .collect();
        graph.insert(key("图例"), Value::Sequence(legend));
    }
    let mut all = rows(&graph)?;
    let mut preview = UpgradePreview {
        organizations: vec![],
        changes: vec![],
        guards: vec![],
    };
    // 锁定包括没有分组的全部人物，防止预览后添加/变更分组。
    for n in project::scan_notes(p, NoteKind::Character)? {
        let raw = read_optional(&n.path)?.ok_or("人物文件不存在")?;
        preview.guards.push((
            n.path.clone(),
            content_fingerprint(raw.as_bytes()).to_string(),
        ));
        let (mut map, body) = strict_md(&raw)?;
        if let Some(group) = map.get(key("分组")) {
            if !group.is_null() && !group.is_string() {
                return Err(format!("{} 的「分组」应为文字，拒绝升级", n.path.display()));
            }
        }
        let Some(group) = map_scalar(&map, "分组").filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        let name = sanitize_file_name(group.trim())?;
        if name != group.trim() {
            return Err(format!("分组「{group}」需要先改为合法组织名"));
        }
        let target = org_dir(p).join(format!("{name}.md"));
        if !preview.organizations.contains(&name) {
            match read_optional(&target)? {
                Some(_) => {
                    organization(&target)?;
                    preview
                        .guards
                        .push((target.clone(), version(&read_optional(&target)?)));
                }
                None => preview.changes.push(FileChange {
                    path: target,
                    before: None,
                    after: "---\n---\n\n".into(),
                }),
            }
            preview.organizations.push(name.clone());
        }
        let m = Membership {
            person: n.name,
            organization: name,
            kind: "成员".into(),
            role: None,
            status: "现任".into(),
            secret: false,
            note: None,
        };
        if !all
            .iter()
            .any(|r| is_membership(r) && membership(r).as_ref() == Ok(&m))
        {
            all.push(member_row(&m, Mapping::new())?);
        }
        map.remove(key("分组"));
        preview.changes.push(FileChange {
            path: n.path,
            before: Some(raw),
            after: md_text(&map, &body)?,
        });
    }
    graph.insert(
        key("关系"),
        Value::Sequence(
            all.into_iter()
                .map(|mut r| {
                    if !r.contains_key(key("起类")) {
                        r.insert(key("起类"), key("人物"));
                    }
                    if !r.contains_key(key("止类")) {
                        r.insert(key("止类"), key("人物"));
                    }
                    Value::Mapping(r)
                })
                .collect(),
        ),
    );
    let legacy = p.join("构思/人物关系.yaml");
    preview
        .guards
        .push((legacy.clone(), version(&read_optional(&legacy)?)));
    let before = read_optional(&graph_path(p))?;
    let after = serde_yaml::to_string(&graph).map_err(|e| e.to_string())?;
    if before.as_deref() != Some(&after) {
        preview.changes.push(FileChange {
            path: graph_path(p),
            before,
            after,
        });
    }
    Ok(preview)
}

/// 写前日志保存完整前镜像；所有发布与撤回均原子替换，失败保留恢复入口。
pub fn confirm_upgrade(p: &Path, preview: &UpgradePreview) -> Result<(), String> {
    let current = preview_upgrade(p)?;
    if &current != preview {
        return Err("项目在预览后已改变，请重新预览".into());
    }
    if current.changes.is_empty() {
        return Ok(());
    }
    fs::create_dir_all(p.join(".gongbi")).map_err(|e| e.to_string())?;
    write_text_atomic(
        &journal_path(p),
        &serde_json::to_string(&current).map_err(|e| e.to_string())?,
    )?;
    for c in &current.changes {
        let result = (|| {
            assert_version(&c.path, &version(&c.before))?;
            fs::create_dir_all(c.path.parent().unwrap()).map_err(|e| e.to_string())?;
            write_text_atomic(&c.path, &c.after)
        })();
        if let Err(e) = result {
            return match recover_upgrade(p) {
                Ok(()) => Err(format!("升级失败，文件已恢复：{e}")),
                Err(r) => Err(format!("升级失败：{e}；恢复仍需处理：{r}")),
            };
        }
    }
    fs::remove_file(journal_path(p)).map_err(|e| format!("升级已写入，但恢复日志尚未清理：{e}"))
}
pub fn recover_upgrade(p: &Path) -> Result<(), String> {
    let Some(raw) = read_optional(&journal_path(p))? else {
        return Ok(());
    };
    let journal: UpgradePreview =
        serde_json::from_str(&raw).map_err(|e| format!("恢复日志损坏：{e}"))?;
    // 日志不能被手改成项目外的写路径，先验证整份再撤回。
    for c in &journal.changes {
        if !c.path.starts_with(p)
            || c.path
                .components()
                .any(|x| matches!(x, std::path::Component::ParentDir))
            || !(c.path == graph_path(p)
                || c.path.parent() == Some(org_dir(p).as_path())
                || c.path.parent() == Some(project::notes_dir(p, NoteKind::Character).as_path()))
        {
            return Err("恢复日志包含无效路径".into());
        }
        let now = read_optional(&c.path)?;
        if now != c.before && now.as_deref() != Some(&c.after) {
            return Err(format!(
                "{} 在升级中断后已改变，保留原文件与恢复日志",
                c.path.display()
            ));
        }
    }
    for c in journal.changes.iter().rev() {
        if read_optional(&c.path)? == c.before {
            continue;
        }
        if let Some(before) = &c.before {
            write_text_atomic(&c.path, before)?;
        } else {
            fs::remove_file(&c.path).map_err(|e| e.to_string())?;
        }
    }
    fs::remove_file(journal_path(p)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn 旧项目预览不落盘_确认后多组织关系可重开() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        fs::create_dir_all(p.join("构思/人物")).unwrap();
        let person = p.join("构思/人物/张三.md");
        let original = "---\n分组: 青山宗\n别名: [小三]\n手补: 保留\n---\n\n人物小传\n";
        fs::write(&person, original).unwrap();
        let preview = preview_upgrade(p).unwrap();
        assert_eq!(preview.organizations, vec!["青山宗"]);
        assert_eq!(fs::read_to_string(&person).unwrap(), original);
        assert!(!p.join("构思/关系.yaml").exists());
        confirm_upgrade(p, &preview).unwrap();
        assert_eq!(workspace(p).unwrap().memberships.len(), 1);
        let updated = fs::read_to_string(&person).unwrap();
        assert!(updated.contains("手补: 保留") && updated.contains("人物小传"));
        assert!(!updated.contains("分组:"));
        save_organization(
            p,
            &OrganizationDraft {
                name: "暗卫".into(),
                body: "暗中护卫".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        save_membership(
            p,
            &Membership {
                person: "张三".into(),
                organization: "暗卫".into(),
                kind: "成员".into(),
                role: Some("统领".into()),
                status: "前任".into(),
                secret: true,
                note: Some("隐退".into()),
            },
            None,
        )
        .unwrap();
        let reopened = workspace(p).unwrap();
        assert_eq!(reopened.organizations.len(), 2);
        assert_eq!(reopened.memberships.len(), 2);
        assert_eq!(reopened.memberships[1].role.as_deref(), Some("统领"));
        assert!(reopened.memberships[1].secret);
        assert_eq!(reopened.memberships[1].status, "前任");
    }

    #[test]
    fn 组织编辑保留未知键_冲突与损坏拒绝覆盖_删除留关系() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        let d = OrganizationDraft {
            name: "青山宗".into(),
            body: "创立宗门".into(),
            ..Default::default()
        };
        let org = save_organization(p, &d, None).unwrap();
        assert!(save_organization(p, &d, None).is_err(), "同名不能覆盖");
        let raw = "---\n目的: 守山\n手补: [甲, 乙]\n---\n\n创立宗门";
        fs::write(&org.path, raw).unwrap();
        assert!(save_organization(p, &d, Some(&org.fingerprint)).is_err());
        let current = workspace(p).unwrap().organizations.remove(0);
        let updated = save_organization(
            p,
            &OrganizationDraft {
                purpose: Some("护人".into()),
                ..d.clone()
            },
            Some(&current.fingerprint),
        )
        .unwrap();
        assert!(fs::read_to_string(&updated.path).unwrap().contains("手补:"));
        let preview = preview_upgrade(p).unwrap();
        confirm_upgrade(p, &preview).unwrap();
        let m = Membership {
            person: "青山宗".into(),
            organization: "青山宗".into(),
            kind: "成员".into(),
            role: None,
            status: "现任".into(),
            secret: false,
            note: None,
        };
        save_membership(p, &m, None).unwrap();
        delete_organization(p, &d.name, &updated.fingerprint).unwrap();
        let view = workspace(p).unwrap();
        assert!(view.organizations.is_empty());
        assert_eq!(view.memberships, vec![m]);
        fs::write(&updated.path, "---\n目的: [不应丢弃]\n---\n正文").unwrap();
        let broken = fs::read_to_string(&updated.path).unwrap();
        let fingerprint = content_fingerprint(broken.as_bytes()).to_string();
        assert!(save_organization(p, &d, Some(&fingerprint)).is_err());
        assert_eq!(fs::read_to_string(&updated.path).unwrap(), broken);
    }

    #[test]
    fn 预览后外部修改或目标碰撞_不改变旧项目() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        fs::create_dir_all(p.join("构思/人物")).unwrap();
        let person = p.join("构思/人物/张三.md");
        fs::write(&person, "---\n分组: 青山宗\n---\n小传").unwrap();
        let preview = preview_upgrade(p).unwrap();
        fs::write(&person, "---\n分组: 青山宗\n手补: 新增\n---\n小传").unwrap();
        assert!(confirm_upgrade(p, &preview).unwrap_err().contains("已改变"));
        assert!(!graph_path(p).exists());
        assert!(!org_dir(p).exists());
        let preview = preview_upgrade(p).unwrap();
        save_organization(
            p,
            &OrganizationDraft {
                name: "青山宗".into(),
                body: "已有组织".into(),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(confirm_upgrade(p, &preview).is_err());
        assert!(fs::read_to_string(&person).unwrap().contains("分组:"));
    }

    #[test]
    fn 损坏旧结构和损坏人物_拒绝升级且原文件完整() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        fs::create_dir_all(p.join("构思/人物")).unwrap();
        let legacy = p.join("构思/人物关系.yaml");
        for raw in [
            "[错误]",
            "单个字符串",
            "关系: 错误",
            "关系:\n- 起: 甲\n  止: 乙\n  类型: 成员\n  秘密: 错误",
            "图例: [错误]",
        ] {
            fs::write(&legacy, raw).unwrap();
            assert!(preview_upgrade(p).is_err());
            assert_eq!(fs::read_to_string(&legacy).unwrap(), raw);
            assert!(!graph_path(p).exists());
        }
        fs::remove_file(legacy).unwrap();
        fs::write(p.join("构思/人物/甲.md"), "---\n分组: [错误\n---\n小传").unwrap();
        assert!(preview_upgrade(p).is_err());
        fs::write(
            p.join("构思/人物/甲.md"),
            "---\n分组: [不能忽略]\n---\n小传",
        )
        .unwrap();
        assert!(preview_upgrade(p).is_err());
        assert!(!graph_path(p).exists());
    }

    #[test]
    fn 升级与旧画布窄写_保留图例布局及每条关系手补键() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        fs::create_dir_all(p.join("构思")).unwrap();
        let legacy = p.join("构思/人物关系.yaml");
        let raw = "备注: 保存\n布局: {甲: [1, 2]}\n图例:\n- 名: 师徒\n  方向: 有向\n  手补: 图例保留\n关系:\n- 起: 甲\n  止: 乙\n  类型: 师徒\n  手补: 关系保留\n- 起类: 组织\n  起: 甲\n  止类: 组织\n  止: 乙\n  类型: 盟友\n  手补: 组织保留\n";
        fs::write(&legacy, raw).unwrap();
        let preview = preview_upgrade(p).unwrap();
        confirm_upgrade(p, &preview).unwrap();
        assert_eq!(fs::read_to_string(&legacy).unwrap(), raw);
        let mut table = crate::relationship::read_table(p).unwrap();
        assert_eq!(table.edges.len(), 1);
        table.edges[0].to = "丙".into();
        table.edges[0].kind = "旧识".into();
        crate::relationship::save_table(p, &table).unwrap();
        let written = fs::read_to_string(graph_path(p)).unwrap();
        assert!(written.contains("止: 丙") && written.contains("类型: 旧识"));
        assert!(
            crate::relationship::save_table(p, &table).is_err(),
            "过期来源版本不能再次整表保存"
        );
        for expected in ["图例保留", "关系保留", "组织保留", "布局:", "备注: 保存"]
        {
            assert!(written.contains(expected), "{written}");
        }
        let m = Membership {
            person: "甲".into(),
            organization: "甲".into(),
            kind: "成员".into(),
            role: None,
            status: "现任".into(),
            secret: false,
            note: None,
        };
        save_membership(p, &m, None).unwrap();
        let view = workspace(p).unwrap();
        let next = Membership {
            role: Some("长老".into()),
            ..m.clone()
        };
        edit_membership(p, Some(&next), Some(&m), &view.fingerprint).unwrap();
        assert!(
            edit_membership(p, None, Some(&next), &view.fingerprint).is_err(),
            "旧指纹不能删除新关系"
        );
        let view = workspace(p).unwrap();
        edit_membership(p, None, Some(&next), &view.fingerprint).unwrap();
        assert!(workspace(p).unwrap().memberships.is_empty());
        assert!(fs::read_to_string(graph_path(p))
            .unwrap()
            .contains("组织保留"));
    }

    #[test]
    fn 中断后重开_显式恢复_外部修改不会被撤回覆盖() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        fs::create_dir_all(p.join("构思/人物")).unwrap();
        let person = p.join("构思/人物/甲.md");
        let original = "---\n分组: 山门\n---\n小传";
        fs::write(&person, original).unwrap();
        let preview = preview_upgrade(p).unwrap();
        fs::create_dir_all(p.join(".gongbi")).unwrap();
        fs::create_dir_all(org_dir(p)).unwrap();
        fs::write(journal_path(p), serde_json::to_string(&preview).unwrap()).unwrap();
        // 模拟在发布组织及人物之后、社会网发布之前进程中断。
        for c in preview.changes.iter().take(2) {
            fs::write(&c.path, &c.after).unwrap();
        }
        assert!(workspace(p).unwrap().recovery_needed);
        assert!(preview_upgrade(p).is_err());
        let table = crate::relationship::read_table(p).unwrap();
        assert!(
            crate::relationship::save_table(p, &table).is_err(),
            "新社会网尚未发布也必须拦截旧画布保存"
        );
        assert!(!p.join("构思/人物关系.yaml").exists());
        fs::write(&person, "外部新增文字").unwrap();
        assert!(recover_upgrade(p).is_err());
        assert_eq!(fs::read_to_string(&person).unwrap(), "外部新增文字");
        fs::write(&person, &preview.changes[1].after).unwrap();
        recover_upgrade(p).unwrap();
        assert_eq!(fs::read_to_string(&person).unwrap(), original);
        assert!(!org_dir(p).join("山门.md").exists());
        assert!(!graph_path(p).exists());
        confirm_upgrade(p, &preview_upgrade(p).unwrap()).unwrap();
        assert_eq!(workspace(p).unwrap().memberships.len(), 1);
    }

    #[test]
    fn 发布失败自动恢复_可以再次升级() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        fs::create_dir_all(p.join("构思/人物")).unwrap();
        let person = p.join("构思/人物/甲.md");
        let original = "---\n分组: 山门\n---\n小传";
        fs::write(&person, original).unwrap();
        let preview = preview_upgrade(p).unwrap();
        // 组织目标的父路径被文件占用，阻断发布；预览仍能完整计算。
        fs::write(org_dir(p), "不能作为目录").unwrap();
        assert!(confirm_upgrade(p, &preview).is_err());
        assert_eq!(fs::read_to_string(&person).unwrap(), original);
        assert!(!graph_path(p).exists());
        fs::remove_file(org_dir(p)).unwrap();
        recover_upgrade(p).unwrap();
        confirm_upgrade(p, &preview_upgrade(p).unwrap()).unwrap();
        assert_eq!(workspace(p).unwrap().memberships.len(), 1);
    }

    #[test]
    fn 过期画布删除最后一条关系_不得清空外部新增关系() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path();
        confirm_upgrade(p, &preview_upgrade(p).unwrap()).unwrap();
        let mut first = crate::relationship::read_table(p).unwrap();
        first.edges.push(crate::relationship::Relationship {
            source_row: None,
            from: "甲".into(),
            to: "乙".into(),
            kind: "师徒".into(),
            note: None,
            secret: false,
        });
        crate::relationship::save_table(p, &first).unwrap();
        let mut stale = crate::relationship::read_table(p).unwrap();
        let mut concurrent = crate::relationship::read_table(p).unwrap();
        concurrent.edges.push(crate::relationship::Relationship {
            source_row: None,
            from: "甲".into(),
            to: "丙".into(),
            kind: "旧识".into(),
            note: None,
            secret: false,
        });
        crate::relationship::save_table(p, &concurrent).unwrap();
        stale.edges.clear();
        let before = fs::read_to_string(graph_path(p)).unwrap();
        assert!(crate::relationship::save_table(p, &stale).is_err());
        assert_eq!(fs::read_to_string(graph_path(p)).unwrap(), before);
        assert_eq!(crate::relationship::read_table(p).unwrap().edges.len(), 2);
    }
}
