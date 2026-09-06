mod book_file;
mod library;
mod search;
mod trope;

use std::path::{Path, PathBuf};

use book_file::{BookMeta, ChapterAnchor};
use library::BookEntry;
use trope::TropeSpan;

#[tauri::command]
fn scan_library(root: String) -> Result<Vec<BookEntry>, String> {
    let path = PathBuf::from(&root);
    if !path.is_dir() {
        return Err(format!("不是有效的文件夹：{root}"));
    }
    library::scan_library(&path)
}

#[tauri::command]
fn read_book_md(path: String) -> Result<String, String> {
    book_file::read_text(Path::new(&path))
}

#[tauri::command]
fn save_book_md(path: String, content: String) -> Result<(), String> {
    book_file::write_text_atomic(Path::new(&path), &content)
}

#[tauri::command]
fn read_book_meta(md_path: String) -> Result<BookMeta, String> {
    book_file::read_book_meta(Path::new(&md_path))
}

#[tauri::command]
fn save_book_meta(md_path: String, meta: BookMeta) -> Result<(), String> {
    book_file::write_book_meta(Path::new(&md_path), &meta)
}

#[tauri::command]
fn next_chapter_line(content: String, template: String) -> String {
    book_file::next_chapter_line(&content, &template)
}

#[tauri::command]
fn save_paste_image(md_path: String, ext: String, bytes: Vec<u8>) -> Result<String, String> {
    book_file::save_paste_image(Path::new(&md_path), &ext, &bytes)
}

#[tauri::command]
fn list_chapters(content: String, template: String) -> Vec<ChapterAnchor> {
    book_file::list_chapters(&content, &template)
}

#[tauri::command]
fn read_tropes(md_path: String) -> Result<Vec<TropeSpan>, String> {
    trope::read_tropes(Path::new(&md_path))
}

#[tauri::command]
fn save_tropes(md_path: String, tropes: Vec<TropeSpan>) -> Result<(), String> {
    trope::write_tropes(Path::new(&md_path), &tropes)
}

#[tauri::command]
fn search_library(root: String, query: String) -> Result<Vec<search::SearchHit>, String> {
    search::search_library(&PathBuf::from(&root), &query)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_library,
            read_book_md,
            save_book_md,
            read_book_meta,
            save_book_meta,
            next_chapter_line,
            save_paste_image,
            list_chapters,
            read_tropes,
            save_tropes,
            search_library
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
