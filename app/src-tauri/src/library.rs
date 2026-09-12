//! 拆书库扫描：识别「根目录散文件」与「一书一文件夹」两种既有布局（ADR 0002）。
//! 只读不写，不搬动、不改写用户文件。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::book_file::{
    has_md_extension, is_hidden, meta_from_mapping, read_yaml_mapping, sanitize_file_name,
    sibling_yaml_path, write_text_atomic, BookMeta,
};
use crate::inspiration::LIBRARY_DIR;
use crate::proofread::PROOFREAD_DIR;
use crate::trope::{tropes_from_mapping, TropeSpan};

/// 构思项目在库根下的目录名；书库扫描、全文搜索、词表聚合（共用本模块的
/// 书文件收集）跳过该目录——拆书与构思只经「词表.yaml ＋ 灵感库」通行，
/// 见 docs/spec/构思数据模型.md。
pub const PROJECTS_DIR: &str = "项目";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    /// 根目录散文件：书的 .md 直接放在库根目录。
    Scattered,
    /// 一书一文件夹：每本书独占一个子文件夹（拆书.md + .yaml + 附件/）。
    FolderBook,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookEntry {
    pub name: String,
    pub layout: Layout,
    pub primary_md: PathBuf,
    pub md_count: u32,
    pub chapter_count: u32,
    pub word_count: u64,
    /// 同名 .yaml 的书级四项＋章前缀；无 yaml 或损坏时为缺省（编辑器打开会告警）。
    pub meta: BookMeta,
    /// 同名 .yaml 的桥段标注列表；无 yaml 或损坏时为空。
    pub tropes: Vec<TropeSpan>,
    /// 封面文件（约定文件名 附件/封面.png|jpg|webp，现查现识别，零 yaml 键）；
    /// 无封面为 None，前端以书名首字占位。删文件即撤。
    pub cover: Option<PathBuf>,
    /// 封面目录（「设封面」的拷贝落点）：一书一文件夹＝书内 附件/，
    /// 散文件书＝库根 附件/<书名>/（与截图粘贴同路径纪律）。
    pub cover_dir: PathBuf,
}

struct MdStats {
    chapters: u32,
    words: u64,
}

/// 一本书在盘上的全部 .md 与主文件（书库扫描与全文搜索共用同一套布局识别）。
pub(crate) struct BookFiles {
    pub(crate) name: String,
    pub(crate) layout: Layout,
    pub(crate) mds: Vec<PathBuf>,
    pub(crate) primary_md: PathBuf,
}

pub fn scan_library(root: &Path) -> Result<Vec<BookEntry>, String> {
    let root = root.to_path_buf();
    Ok(collect_book_files(&root)?
        .into_iter()
        .map(|files| book_entry(&root, files))
        .collect())
}

/// 封面目录（约定）：一书一文件夹＝书内 附件/；散文件书＝库根
/// 附件/<书名>/（与 book_file::attachment_subdir 同路径纪律）。
fn cover_dir_for(root: &Path, files: &BookFiles) -> PathBuf {
    match files.layout {
        Layout::FolderBook => files.primary_md.parent().unwrap_or(root).join("附件"),
        Layout::Scattered => root.join("附件").join(&files.name),
    }
}

/// 新建拆书书（工单 #20，spec 书库新建与展示 §二）：一律一书一文件夹——
/// 建「《书名》/」＋空 拆书.md；yaml 与 附件/ 懒生成（首次结构化标注/贴图
/// 才落盘，#13 纪律）。重名报错不续号：书是唯一的，同名是误操作
/// （同 create_project）。
pub fn create_book(root: &Path, title: &str) -> Result<BookEntry, String> {
    if !root.is_dir() {
        return Err(format!("不是有效的文件夹：{}", root.display()));
    }
    let title = title.trim().trim_start_matches('《').trim_end_matches('》').trim();
    let name =
        sanitize_file_name(title).map_err(|_| "书名不能为空（或只剩符号）".to_string())?;
    let dir = root.join(format!("《{name}》"));
    if dir.exists() {
        return Err(format!("已存在同名书「{name}」"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建文件夹 {}：{e}", dir.display()))?;
    let primary_md = dir.join("拆书.md");
    write_text_atomic(&primary_md, "")
        .map_err(|e| format!("无法创建拆书稿 {}：{e}", primary_md.display()))?;
    Ok(book_entry(
        root,
        BookFiles {
            name: format!("《{name}》"),
            layout: Layout::FolderBook,
            mds: vec![primary_md.clone()],
            primary_md,
        },
    ))
}

pub(crate) fn collect_book_files(root: &Path) -> Result<Vec<BookFiles>, String> {
    let entries =
        fs::read_dir(root).map_err(|e| format!("无法读取文件夹 {}：{e}", root.display()))?;
    let mut books: Vec<BookFiles> = Vec::new();
    let mut subdirs: Vec<PathBuf> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if is_hidden(&path) {
            continue;
        }
        if path.is_dir() {
            subdirs.push(path);
        } else if has_md_extension(&path) {
            books.push(BookFiles {
                name: file_stem_of(&path),
                layout: Layout::Scattered,
                mds: vec![path.clone()],
                primary_md: path,
            });
        }
    }
    for dir in subdirs {
        // 「灵感库/」是卡片目录、「项目/」是构思工程、「校对/」是词库，都不是一本书。
        if dir
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n == LIBRARY_DIR || n == PROJECTS_DIR || n == PROOFREAD_DIR)
        {
            continue;
        }
        if let Some(files) = folder_book_files(&dir) {
            books.push(files);
        }
    }
    books.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(books)
}

fn folder_book_files(dir: &Path) -> Option<BookFiles> {
    let mut mds: Vec<PathBuf> = Vec::new();
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_hidden(&path) && path.is_file() && has_md_extension(&path) {
            mds.push(path);
        }
    }
    if mds.is_empty() {
        return None;
    }
    mds.sort();

    let primary = mds
        .iter()
        .find(|p| p.file_name().is_some_and(|n| n == "拆书.md"))
        .unwrap_or(&mds[0])
        .clone();

    Some(BookFiles {
        name: dir.file_name()?.to_string_lossy().into_owned(),
        layout: Layout::FolderBook,
        mds,
        primary_md: primary,
    })
}

fn book_entry(root: &Path, files: BookFiles) -> BookEntry {
    let (chapters, words) = files
        .mds
        .iter()
        .map(|md| md_stats(md))
        .fold((0u32, 0u64), |(c, w), s| (c + s.chapters, w + s.words));

    let (meta, tropes) = meta_and_tropes(&files.primary_md);
    let cover_dir = cover_dir_for(root, &files);
    let cover = crate::cover::find_cover(&cover_dir);
    BookEntry {
        name: files.name,
        layout: files.layout,
        primary_md: files.primary_md,
        md_count: files.mds.len() as u32,
        chapter_count: chapters,
        word_count: words,
        meta,
        tropes,
        cover,
        cover_dir,
    }
}

/// 主文件同名 .yaml 的书级元数据＋桥段；书库列表对损坏 yaml 降级为缺省
/// （不因一本书的坏文件拖垮整个扫描），编辑器打开该书时会显式告警。
fn meta_and_tropes(primary_md: &Path) -> (BookMeta, Vec<TropeSpan>) {
    match read_yaml_mapping(&sibling_yaml_path(primary_md)) {
        Ok(map) => (
            meta_from_mapping(&map),
            tropes_from_mapping(&map).unwrap_or_default(),
        ),
        Err(_) => (BookMeta::default(), Vec::new()),
    }
}

/// 词表聚合用：主文件同名 yaml 的桥段列表，损坏降级为空（提示尽力而为）。
pub(crate) fn tropes_lossy(primary_md: &Path) -> Vec<TropeSpan> {
    meta_and_tropes(primary_md).1
}

fn md_stats(md: &Path) -> MdStats {
    let Ok(bytes) = fs::read(md) else {
        return MdStats {
            chapters: 0,
            words: 0,
        };
    };
    let raw = String::from_utf8_lossy(&bytes);
    let content = raw.strip_prefix('\u{feff}').unwrap_or(&raw);

    MdStats {
        chapters: content.lines().filter(|l| is_chapter_heading(l)).count() as u32,
        // 与项目/书写章节同一口径（去 frontmatter、去空白、含标点）。
        words: crate::book_file::billed_word_count(content),
    }
}

/// 行首「第X章」中的 X 部分（容忍标题符号与空白前缀），非章标题行返回 None。
pub(crate) fn chapter_digits(line: &str) -> Option<&str> {
    let t = line.trim_start_matches(['#', ' ', '\t']);
    let rest = t.strip_prefix('第')?;
    let end = rest.find('章')?;
    Some(&rest[..end])
}

/// 行首匹配默认章前缀「第X章」。仅用于统计与续号；结构化拆章
/// 由编辑器的显式开章动作负责（设计共识 §四），不追求此处的精确。
pub(crate) fn is_chapter_heading(line: &str) -> bool {
    let Some(digits) = chapter_digits(line) else {
        return false;
    };
    (1..=8).contains(&digits.chars().count())
        && digits.chars().all(|c| {
            matches!(
                c,
                '0'..='9' | '０'..='９' | '〇' | '零' | '一' | '二' | '三' | '四' | '五' | '六'
                    | '七' | '八' | '九' | '两' | '十' | '百' | '千' | '万'
            )
        })
}

fn file_stem_of(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
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
    fn 散文件布局_根目录_md_即书_携带_yaml_侧数据() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书甲.md"), "# 第1章\n正文\n## 第2章\n正文");
        write(
            &root.join("书甲.yaml"),
            "书名: 书甲\n成绩: 均订2万\n桥段:\n- 起: 1\n  止: 2\n  类型: [掉马甲]\n",
        );
        write(&root.join("书乙.md"), "第一章\n第二章\n第三章");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 2);

        let 甲 = books.iter().find(|b| b.name == "书甲").unwrap();
        assert_eq!(甲.layout, Layout::Scattered);
        assert_eq!(甲.chapter_count, 2);
        assert_eq!(甲.md_count, 1);
        assert_eq!(甲.meta.title.as_deref(), Some("书甲"));
        assert_eq!(甲.meta.track_record.as_deref(), Some("均订2万"));
        assert_eq!(甲.tropes.len(), 1);
        assert_eq!(甲.tropes[0].types, vec!["掉马甲".to_string()]);

        let 乙 = books.iter().find(|b| b.name == "书乙").unwrap();
        assert_eq!(乙.chapter_count, 3);
        assert_eq!(乙.meta, BookMeta::default());
        assert!(乙.tropes.is_empty());
    }

    #[test]
    fn 一书一文件夹_识别_主文件取_拆书_md_读其_yaml() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(
            &root.join("《书丙》/拆书.md"),
            "第1章\n甲乙丙\n第2章\n丙乙甲",
        );
        write(
            &root.join("《书丙》/拆书.yaml"),
            "书名: 书丙\n金手指: 签到\n",
        );
        write(&root.join("《书丙》/附件/截图.png"), "png");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 1);
        let book = &books[0];
        assert_eq!(book.name, "《书丙》");
        assert_eq!(book.layout, Layout::FolderBook);
        assert!(book.primary_md.ends_with("拆书.md"));
        assert_eq!(book.meta.title.as_deref(), Some("书丙"));
        assert_eq!(book.meta.golden_finger.as_deref(), Some("签到"));
        assert_eq!(book.chapter_count, 2);
        assert_eq!(book.word_count, 12); // 附件 png 不计入
    }

    #[test]
    fn 损坏_yaml_该书降级为缺省_不拖垮扫描() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("坏书.md"), "第1章");
        write(&root.join("坏书.yaml"), "{{{{不是 yaml");
        write(&root.join("好书.md"), "第1章");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 2);
        let 坏 = books.iter().find(|b| b.name == "坏书").unwrap();
        assert_eq!(坏.meta, BookMeta::default());
        assert!(坏.tropes.is_empty());
    }

    #[test]
    fn 混合布局_两种并存() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("散书.md"), "第1章");
        write(&root.join("《夹书》/拆书.md"), "第1章");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 2);
        assert_eq!(
            books
                .iter()
                .filter(|b| b.layout == Layout::Scattered)
                .count(),
            1
        );
        assert_eq!(
            books
                .iter()
                .filter(|b| b.layout == Layout::FolderBook)
                .count(),
            1
        );
    }

    #[test]
    fn 灵感库目录_不算书() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书甲.md"), "第1章");
        write(
            &root.join("灵感库/故事卡/外卖成神.md"),
            "---\n标签: [故事]\n---\n\n正文",
        );
        write(&root.join("灵感库/未分类/随手记.md"), "一条点子");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, "书甲");
    }

    #[test]
    fn 项目目录_不算书() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书甲.md"), "第1章");
        write(&root.join("项目/《我的书》/项目.yaml"), "书名: 我的书\n");
        write(&root.join("项目/《我的书》/正文/0001 初入江湖.md"), "第1章 初入江湖");
        // 项目/ 根下的散 .md 也不该被当成一本叫「项目」的书。
        write(&root.join("项目/随手记.md"), "不属于拆书");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, "书甲");
    }

    #[test]
    fn 无_md_的文件夹_不算书() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("附件/图.png"), "png");
        write(&root.join("素材/note.txt"), "杂项");

        assert!(scan_library(&root).unwrap().is_empty());
    }

    #[test]
    fn 隐藏目录与文件_跳过() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join(".obsidian/app.json"), "{}");
        write(&root.join(".草稿.md"), "第1章");

        assert!(scan_library(&root).unwrap().is_empty());
    }

    #[test]
    fn 文件夹内多个_md_合并统计() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书丁/前情.md"), "第一章\n一二三");
        write(&root.join("书丁/拆书.md"), "第二章\n四五六");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 1);
        let book = &books[0];
        assert_eq!(book.name, "书丁");
        assert_eq!(book.md_count, 2);
        assert_eq!(book.chapter_count, 2);
        assert_eq!(book.word_count, 12);
        assert!(book.primary_md.ends_with("拆书.md"));
    }

    #[test]
    fn 大写扩展名_MD_也识别() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("旧书.MD"), "第1章");

        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, "旧书");
    }

    #[test]
    fn 空目录_返回空() {
        let root = TempDir::new().unwrap();
        assert!(scan_library(root.path()).unwrap().is_empty());
    }

    #[test]
    fn 根目录不存在_报错而非空列表() {
        let missing = TempDir::new().unwrap().path().join("不存在的子目录");
        assert!(scan_library(&missing).is_err());
    }

    #[test]
    fn 章前缀判定() {
        assert!(is_chapter_heading("第1章 开端"));
        assert!(is_chapter_heading("## 第12章：翻脸"));
        assert!(is_chapter_heading("第一百零一章"));
        assert!(is_chapter_heading("第２０章")); // 全角数字
        assert!(!is_chapter_heading("第一次相遇"));
        assert!(!is_chapter_heading("第三种颜色"));
        assert!(!is_chapter_heading("第 abc 章"));
        assert!(!is_chapter_heading("正文提到第三章不算"));
    }

    #[test]
    fn bom_不遮挡首行章前缀() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("记事本.md"), "\u{feff}第一章\n正文");

        let books = scan_library(&root).unwrap();
        assert_eq!(books[0].chapter_count, 1);
    }

    // --- 新建书（spec 书库新建与展示 §二）---

    #[test]
    fn 新建书_一书一文件夹_空拆书稿_懒生成() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        let book = create_book(&root, "我的新书").unwrap();

        assert_eq!(book.name, "《我的新书》");
        assert_eq!(book.layout, Layout::FolderBook);
        assert!(book.primary_md.ends_with("拆书.md"));
        // 落点：只建《书名》/＋空 拆书.md；yaml 与附件/懒生成，不预建。
        assert_eq!(fs::read_to_string(&book.primary_md).unwrap(), "");
        assert!(!root.join("《我的新书》/拆书.yaml").exists());
        assert!(!root.join("《我的新书》/附件").exists());

        // 扫描立刻能认出这本书。
        let books = scan_library(&root).unwrap();
        assert_eq!(books.len(), 1);
        assert_eq!(books[0].name, "《我的新书》");
    }

    #[test]
    fn 新建书_同名报错_不自动续号() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();
        create_book(&root, "书甲").unwrap();

        let err = create_book(&root, "书甲").unwrap_err();
        assert!(err.contains("书甲"), "报错应指名书名：{err}");
        // 不续号：库里只有一本。
        assert_eq!(scan_library(&root).unwrap().len(), 1);
    }

    #[test]
    fn 新建书_书名清洗_去书名号与空白_非法字符替换() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        let book = create_book(&root, " 《剑/来：外传》 ").unwrap();
        assert_eq!(book.name, "《剑_来：外传》");
        assert!(root.join("《剑_来：外传》/拆书.md").is_file());

        // 只剩符号/空串报错，不建目录。
        assert!(create_book(&root, "《  》").is_err());
        assert!(create_book(&root, "《??》").is_err());
        let entries = fs::read_dir(&root).unwrap().count();
        assert_eq!(entries, 1, "失败的新建不应留下目录");
    }

    // --- 封面扫描（工单 #23，spec 书库新建与展示 §五）---

    #[test]
    fn 封面_一书一文件夹_落书内附件() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("《书丙》/拆书.md"), "第1章");
        write(&root.join("《书丙》/附件/封面.png"), "png");

        let books = scan_library(&root).unwrap();
        assert_eq!(
            books[0].cover,
            Some(root.join("《书丙》/附件/封面.png"))
        );
        assert_eq!(books[0].cover_dir, root.join("《书丙》/附件"));
    }

    #[test]
    fn 封面_散文件书_落库根附件_按书名分目录() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书乙.md"), "第1章");
        write(&root.join("附件/书乙/封面.jpg"), "jpg");

        let books = scan_library(&root).unwrap();
        assert_eq!(books[0].cover, Some(root.join("附件/书乙/封面.jpg")));
        assert_eq!(books[0].cover_dir, root.join("附件/书乙"));
    }

    #[test]
    fn 封面_无封面为空_删文件即撤() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("书甲.md"), "第1章");
        write(&root.join("附件/书甲/封面.png"), "png");

        let books = scan_library(&root).unwrap();
        assert!(books[0].cover.is_some());
        fs::remove_file(root.join("附件/书甲/封面.png")).unwrap();
        assert!(scan_library(&root).unwrap()[0].cover.is_none());
    }

    #[test]
    fn 封面_多扩展名并存_按_png_优先() {
        let root = TempDir::new().unwrap().path().to_path_buf();
        write(&root.join("《书》/拆书.md"), "第1章");
        write(&root.join("《书》/附件/封面.webp"), "w");
        write(&root.join("《书》/附件/封面.jpg"), "j");
        write(&root.join("《书》/附件/封面.png"), "p");

        assert_eq!(
            scan_library(&root).unwrap()[0].cover,
            Some(root.join("《书》/附件/封面.png"))
        );
    }

    #[test]
    fn 封面_端到端_新建库_新建书_设封面_扫描识别() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_path_buf();

        let book = create_book(&root, "我的新书").unwrap();
        assert!(book.cover.is_none(), "新书无封面");

        // 模拟用户选图：库外一张 png。
        let picked = tmp.path().join("选图.png");
        fs::write(&picked, b"png bytes").unwrap();
        let dest = crate::cover::set_cover(&book.cover_dir, &picked).unwrap();
        assert_eq!(dest, root.join("《我的新书》/附件/封面.png"));

        let books = scan_library(&root).unwrap();
        assert_eq!(books[0].cover.as_deref(), Some(dest.as_path()));
        assert_eq!(fs::read(&dest).unwrap(), "png bytes".as_bytes(), "拷贝而非引用");
    }
}
