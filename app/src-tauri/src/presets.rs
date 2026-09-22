//! AI 助手预设（工单 T06，docs/spec/AI助手预设.md）。
//!
//! 预设只作用于普通对话，固定 AI 命令与人物对话各有各的提示合同（spec §一）。
//! 内置预设是代码里的只读种子——磁盘上只存用户预设与默认标记，所以内置
//! 定义随版本升级自动生效、不可被破坏；用户预设增删改走整表校验读写。
//! 存储与供应商配置同款：应用数据目录 `ai/presets.json`，不进创作库。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::ai::ai_dir;
use crate::book_file::{read_text, write_text_atomic};

pub const PRESETS_FILE: &str = "presets.json";
/// 内置定义的版本号：内置预设改词、增删时递增，旧文件读入时据此走升级。
pub const BUILTIN_VERSION: u32 = 1;
/// 未选默认、或默认指向已删除的预设时，兜底回内置通用助手（spec §六）。
pub const GENERAL_PRESET_ID: &str = "builtin:general";

/// 一份助手预设。内置与用户预设同构，靠 id 前缀区分：内置一律 `builtin:` 开头。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AssistantPreset {
    pub id: String,
    pub name: String,
    /// 一句话说明。
    pub description: String,
    /// 图标（emoji 等），空＝无。
    pub icon: String,
    /// 识别色（#rrggbb），空＝无。
    pub color: String,
    pub system_prompt: String,
    /// 供应商/模型覆盖；None＝跟随全局当前选择（spec §三）。
    pub provider_override: Option<String>,
    pub model_override: Option<String>,
}

/// 磁盘文件：只存用户预设与默认标记，内置预设不落盘。
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PresetFile {
    /// 写入时看到的内置版本；旧文件缺省 0，读入时推进到当前值。
    builtin_version: u32,
    default_preset_id: Option<String>,
    user_presets: Vec<AssistantPreset>,
}

/// 读出的完整视图：内置（代码生成，永远最新）＋用户预设＋默认标记。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetState {
    pub builtins: Vec<AssistantPreset>,
    pub user_presets: Vec<AssistantPreset>,
    pub default_preset_id: String,
    pub builtin_version: u32,
}

/// 保存载荷：默认标记＋整份用户预设表（内置不可通过保存通道改动）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSave {
    pub default_preset_id: String,
    pub user_presets: Vec<AssistantPreset>,
}

pub fn presets_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(ai_dir(app)?.join(PRESETS_FILE))
}

/// 内置四预设（spec §二）。通用助手的系统提示与前端 `ai.ts::DEFAULT_SYSTEM_PROMPT`
/// 是同一份基线——旧会话没有预设字段时回退通用助手（spec §六），行为不能漂移。
pub fn builtin_presets() -> Vec<AssistantPreset> {
    fn preset(
        id: &str,
        name: &str,
        description: &str,
        color: &str,
        system_prompt: &str,
    ) -> AssistantPreset {
        AssistantPreset {
            id: id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            icon: String::new(),
            color: color.to_string(),
            system_prompt: system_prompt.to_string(),
            provider_override: None,
            model_override: None,
        }
    }
    vec![
        preset(
            GENERAL_PRESET_ID,
            "通用助手",
            "普通问答，不主动套写作方法。",
            "#7a746a",
            "你是「工笔」（个人网文创作工具）里的写作助手，帮用户拆书、找灵感、构思剧情。回答用中文，简明直接，多用要点。",
        ),
        preset(
            "builtin:analyst",
            "拆书教练",
            "追问结构、效果与「如果是我写」。",
            "#ae432e",
            "你是「工笔」的拆书教练，陪用户拆解他自己读过的书。针对他写下的拆书记录追问三件事：结构（这段为什么成立）、效果（爽点与张力落在哪里）、迁移（如果是我写会怎么处理）。多用提问少下结论，让用户自己想明白；材料之外的原文内容不要编造。回答用中文，简明直接。",
        ),
        preset(
            "builtin:ideator",
            "构思搭档",
            "基于已有素材发散，不越过作者设定。",
            "#2f6f68",
            "你是「工笔」的构思搭档，基于用户已有的素材（矛盾、单元、人物、类型圈等）帮他发散剧情可能。给选项不给答案：一次最多三个方向，每个说清「动用哪条已有素材、长出什么戏」；不越过作者已有设定，不替他拍板；用户没给过的设定不要当作既定事实。回答用中文，简明直接，多用要点。",
        ),
        preset(
            "builtin:editor",
            "文字编辑",
            "讨论表达、节奏与可读性，不直接改文件。",
            "#334f78",
            "你是「工笔」的文字编辑，和用户讨论表达、节奏与可读性：句子顺不顺、信息密度合不合适、情绪递进断没断。指出问题时引用用户给的原文并说明理由；可以给改法示例，但不主动整段重写，除非用户明确要求；不改动任何文件。回答用中文，简明直接。",
        ),
    ]
}

/// 读预设。文件缺失/存空＝初始态；读不懂的拒绝覆盖（与关系表同一纪律），
/// 由界面给出修复提示。
pub fn load(path: &Path) -> Result<PresetState, String> {
    let mut file = if !path.is_file() {
        PresetFile::default()
    } else {
        let text = read_text(path)?;
        if text.trim().is_empty() {
            PresetFile::default()
        } else {
            serde_json::from_str(&text).map_err(|e| format!("预设文件解析失败：{e}"))?
        }
    };
    repair(&mut file);
    Ok(state_from(file))
}

/// 校验并整表写入；成功返回整理后的读态（前端直接用它刷新界面）。
pub fn save(path: &Path, save: &PresetSave) -> Result<PresetState, String> {
    let mut user_presets = save.user_presets.clone();
    for preset in &mut user_presets {
        normalize_preset(preset);
    }
    let default_id = save.default_preset_id.trim();
    validate(&user_presets, default_id)?;
    let file = PresetFile {
        builtin_version: BUILTIN_VERSION,
        default_preset_id: Some(default_id.to_string()),
        user_presets,
    };
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建预设目录失败：{e}"))?;
    }
    let text =
        serde_json::to_string_pretty(&file).map_err(|e| format!("预设序列化失败：{e}"))?;
    write_text_atomic(path, &text)?;
    Ok(state_from(file))
}

fn state_from(file: PresetFile) -> PresetState {
    PresetState {
        builtins: builtin_presets(),
        user_presets: file.user_presets,
        default_preset_id: file
            .default_preset_id
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| GENERAL_PRESET_ID.to_string()),
        builtin_version: file.builtin_version,
    }
}

/// 读态整理（宽进）：字段修剪、空覆盖归 None、内置版本推进、悬空默认回通用助手。
fn repair(file: &mut PresetFile) {
    // 升级钩子：内置定义跨版本变化（改名、增删）时，在这里迁移旧文件的引用；
    // v1 首版没有落盘的内置数据，悬空默认由下面的存在性检查兜底。
    file.builtin_version = file.builtin_version.max(BUILTIN_VERSION);
    let mut seen = HashSet::new();
    file.user_presets.retain_mut(|p| {
        normalize_preset(p);
        !p.id.is_empty() && seen.insert(p.id.clone())
    });
    let id = file
        .default_preset_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(GENERAL_PRESET_ID);
    if !id_known(id, &file.user_presets) {
        file.default_preset_id = Some(GENERAL_PRESET_ID.to_string());
    } else {
        file.default_preset_id = Some(id.to_string());
    }
}

/// 单个预设的田间修理：去首尾空白、空覆盖归 None。
fn normalize_preset(preset: &mut AssistantPreset) {
    preset.id = preset.id.trim().to_string();
    preset.name = preset.name.trim().to_string();
    preset.description = preset.description.trim().to_string();
    preset.icon = preset.icon.trim().to_string();
    preset.color = preset.color.trim().to_string();
    preset.system_prompt = preset.system_prompt.trim().to_string();
    preset.provider_override = trimmed_or_none(preset.provider_override.take());
    preset.model_override = trimmed_or_none(preset.model_override.take());
}

fn trimmed_or_none(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 写态校验（严出）：保住「内置不可破坏、默认唯一且存在」两条底线。
fn validate(user_presets: &[AssistantPreset], default_id: &str) -> Result<(), String> {
    let mut seen = HashSet::new();
    for preset in user_presets {
        if preset.id.starts_with("builtin:") {
            return Err(format!("「{}」：内置预设不可新增或覆盖。", preset.id));
        }
        if !seen.insert(preset.id.clone()) {
            return Err(format!("预设 id 重复：{}。", preset.id));
        }
        if preset.name.is_empty() {
            return Err("每个预设都需要名称。".to_string());
        }
        if preset.system_prompt.is_empty() {
            return Err(format!("「{}」缺少系统提示。", preset.name));
        }
        if !preset.color.is_empty() && !valid_color(&preset.color) {
            return Err(format!("「{}」的识别色需要 #rrggbb 格式。", preset.name));
        }
    }
    let default_known = id_known(default_id, user_presets);
    if !default_known {
        return Err(
            "默认助手不存在；删除默认预设时需要先选择新的默认（或回到通用助手）。".to_string(),
        );
    }
    Ok(())
}

fn valid_color(color: &str) -> bool {
    let hex = color.strip_prefix('#').unwrap_or("");
    hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit())
}

/// 默认标记的存在性判断：通用助手、其余内置、用户预设三处可指（读写两侧共用）。
fn id_known(id: &str, user_presets: &[AssistantPreset]) -> bool {
    id == GENERAL_PRESET_ID
        || builtin_presets().iter().any(|p| p.id == id)
        || user_presets.iter().any(|p| p.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::TempDir;

    fn user_preset(id: &str, name: &str) -> AssistantPreset {
        AssistantPreset {
            id: id.to_string(),
            name: name.to_string(),
            description: "说明".to_string(),
            icon: "✍".to_string(),
            color: "#ae432e".to_string(),
            system_prompt: "你是测试助手。".to_string(),
            provider_override: None,
            model_override: None,
        }
    }

    #[test]
    fn 没有文件时给初始态_四内置_默认通用助手() {
        let tmp = TempDir::new().unwrap();
        let state = load(&tmp.path().join("presets.json")).unwrap();
        assert_eq!(
            state.builtins.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec![GENERAL_PRESET_ID, "builtin:analyst", "builtin:ideator", "builtin:editor"],
        );
        assert_eq!(state.default_preset_id, GENERAL_PRESET_ID);
        assert!(state.user_presets.is_empty());
        assert_eq!(state.builtin_version, BUILTIN_VERSION);
    }

    #[test]
    fn 内置预设字段齐全且提示非空_不携带覆盖() {
        for preset in builtin_presets() {
            assert!(!preset.name.is_empty(), "{} 缺名称", preset.id);
            assert!(!preset.description.is_empty(), "{} 缺说明", preset.id);
            assert!(!preset.system_prompt.trim().is_empty(), "{} 缺系统提示", preset.id);
            assert!(preset.provider_override.is_none(), "{} 不应带供应商覆盖", preset.id);
            assert!(preset.model_override.is_none(), "{} 不应带模型覆盖", preset.id);
            assert!(valid_color(&preset.color), "{} 识别色格式不对", preset.id);
        }
        // 通用助手与前端 ai.ts::DEFAULT_SYSTEM_PROMPT 必须逐字相同（旧会话
        // 回退口径）——这里锁全文，前端那份以本侧为准。
        assert_eq!(
            builtin_presets()[0].system_prompt,
            "你是「工笔」（个人网文创作工具）里的写作助手，帮用户拆书、找灵感、构思剧情。回答用中文，简明直接，多用要点。"
        );
    }

    #[test]
    fn 用户预设增改删与设默认整表往返() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("presets.json");

        // 新增＋设为默认。
        let mut a = user_preset("u-1", "我的军师");
        a.provider_override = Some("p-deepseek".to_string());
        a.model_override = Some("deepseek-chat".to_string());
        let state = save(&path, &PresetSave {
            default_preset_id: "u-1".to_string(),
            user_presets: vec![a],
        })
        .unwrap();
        assert_eq!(state.default_preset_id, "u-1");

        // 重启后保持一致。
        let reloaded = load(&path).unwrap();
        assert_eq!(reloaded.default_preset_id, "u-1");
        assert_eq!(reloaded.user_presets.len(), 1);
        assert_eq!(reloaded.user_presets[0].provider_override.as_deref(), Some("p-deepseek"));

        // 删除默认预设时换新默认（通用助手），整表再存。
        let state = save(&path, &PresetSave {
            default_preset_id: GENERAL_PRESET_ID.to_string(),
            user_presets: vec![],
        })
        .unwrap();
        assert_eq!(state.default_preset_id, GENERAL_PRESET_ID);
        assert!(load(&path).unwrap().user_presets.is_empty());
    }

    #[test]
    fn 保存会修剪字段并把空覆盖归为跟随全局() {
        let tmp = TempDir::new().unwrap();
        let mut a = user_preset(" u-1 ", "  我的军师  ");
        a.provider_override = Some("  ".to_string());
        a.model_override = Some(" deepseek-chat ".to_string());
        let state = save(&tmp.path().join("presets.json"), &PresetSave {
            default_preset_id: "u-1".to_string(),
            user_presets: vec![a],
        })
        .unwrap();
        assert_eq!(state.user_presets[0].id, "u-1");
        assert_eq!(state.user_presets[0].name, "我的军师");
        assert_eq!(state.user_presets[0].provider_override, None);
        assert_eq!(state.user_presets[0].model_override.as_deref(), Some("deepseek-chat"));
    }

    #[test]
    fn 默认唯一且必须存在_删除默认必须先换默认() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("presets.json");
        // 默认指向不存在的预设（比如删了默认预设还照存）→ 拒绝。
        let err = save(&path, &PresetSave {
            default_preset_id: "u-gone".to_string(),
            user_presets: vec![user_preset("u-1", "我的军师")],
        })
        .unwrap_err();
        assert!(err.contains("默认助手不存在"), "{err}");
        assert!(!path.exists(), "校验失败不应落盘");
    }

    #[test]
    fn 用户预设字段底线_名称提示必填_颜色格式_内置不可覆盖() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("presets.json");

        let mut no_name = user_preset("u-1", "我的军师");
        no_name.name = "  ".to_string();
        assert!(save(&path, &PresetSave {
            default_preset_id: GENERAL_PRESET_ID.to_string(),
            user_presets: vec![no_name],
        })
        .unwrap_err()
        .contains("名称"));

        let mut no_prompt = user_preset("u-1", "我的军师");
        no_prompt.system_prompt = "".to_string();
        assert!(save(&path, &PresetSave {
            default_preset_id: GENERAL_PRESET_ID.to_string(),
            user_presets: vec![no_prompt],
        })
        .unwrap_err()
        .contains("系统提示"));

        let mut bad_color = user_preset("u-1", "我的军师");
        bad_color.color = "red".to_string();
        assert!(save(&path, &PresetSave {
            default_preset_id: GENERAL_PRESET_ID.to_string(),
            user_presets: vec![bad_color],
        })
        .unwrap_err()
        .contains("#rrggbb"));

        let mut builtin_copy = user_preset("builtin:general", "假的通用助手");
        builtin_copy.system_prompt = "被改了".to_string();
        assert!(save(&path, &PresetSave {
            default_preset_id: GENERAL_PRESET_ID.to_string(),
            user_presets: vec![builtin_copy],
        })
        .unwrap_err()
        .contains("内置预设"));

        let dup = vec![user_preset("u-1", "甲"), user_preset("u-1", "乙")];
        assert!(save(&path, &PresetSave {
            default_preset_id: GENERAL_PRESET_ID.to_string(),
            user_presets: dup,
        })
        .unwrap_err()
        .contains("重复"));
        assert!(!path.exists());
    }

    #[test]
    fn 旧配置兼容_缺键多键与空默认都能读() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("presets.json");
        std::fs::write(
            &path,
            json!({
                // 无 version / builtinVersion / defaultPresetId，还带未知键。
                "userPresets": [
                    {
                        "id": "u-1",
                        "name": "我的军师",
                        "description": "说明",
                        "icon": "",
                        "color": "",
                        "systemPrompt": "你是测试助手。",
                        "providerOverride": null,
                        "modelOverride": "",
                        "unknownKey": true
                    }
                ],
                "unknownTop": 1
            })
            .to_string(),
        )
        .unwrap();
        let state = load(&path).unwrap();
        assert_eq!(state.default_preset_id, GENERAL_PRESET_ID);
        assert_eq!(state.user_presets.len(), 1);
        assert_eq!(state.user_presets[0].model_override, None);
        assert_eq!(state.builtin_version, BUILTIN_VERSION);

        // defaultPresetId 显式为 null 也回通用助手。
        std::fs::write(&path, json!({"defaultPresetId": null, "userPresets": []}).to_string()).unwrap();
        assert_eq!(load(&path).unwrap().default_preset_id, GENERAL_PRESET_ID);
    }

    #[test]
    fn 内置升级_旧版本文件读入时推进且用户数据保留_悬空默认回通用() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("presets.json");
        // 模拟旧版本写的文件：builtinVersion 0，默认指向一个已不存在的内置。
        std::fs::write(
            &path,
            json!({
                "version": 1,
                "builtinVersion": 0,
                "defaultPresetId": "builtin:removed-in-v2",
                "userPresets": [user_preset("u-1", "我的军师")]
            })
            .to_string(),
        )
        .unwrap();
        let state = load(&path).unwrap();
        assert_eq!(state.builtin_version, BUILTIN_VERSION);
        assert_eq!(state.default_preset_id, GENERAL_PRESET_ID);
        assert_eq!(state.user_presets.len(), 1);
        // 内置定义来自代码：磁盘上没有任何可被改坏的内置数据。
        assert_eq!(state.builtins.len(), 4);
    }

    #[test]
    fn 读态容错_重复id保留首个_空白默认作罢_坏文件拒绝覆盖() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("presets.json");

        std::fs::write(
            &path,
            json!({
                "builtinVersion": BUILTIN_VERSION,
                "defaultPresetId": "  ",
                "userPresets": [
                    user_preset("u-1", "第一个"),
                    { "id": "u-1", "name": "第二个", "systemPrompt": "你是测试助手。" }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let state = load(&path).unwrap();
        assert_eq!(state.user_presets.len(), 1);
        assert_eq!(state.user_presets[0].name, "第一个");
        assert_eq!(state.default_preset_id, GENERAL_PRESET_ID);

        std::fs::write(&path, "{不是 json".to_string()).unwrap();
        assert!(load(&path).unwrap_err().contains("预设文件解析失败"));
    }
}
