# MyAINovel / 工笔

个人网文创作工具「工笔」的设计与实现仓库。拆书积累 → 灵感沉淀 → 构思写作。纯个人使用，Windows 优先，界面全中文。

- 应用代码：`app/`（Tauri 2 + React + TypeScript；`npm run tauri dev` 运行，`src-tauri/` 下 `cargo test`）
- 启动脚本：仓库根 `启动工笔.vbs`、`建桌面快捷方式.vbs`（**必须存为 UTF-16LE+BOM**——WSH 不认 UTF-8，写成 UTF-8 会报「未结束的字符串常量」）
- 领域词汇表：[CONTEXT.md](./CONTEXT.md)（只记录概念与术语）
- 设计总览：[docs/设计共识.md](./docs/设计共识.md)
- 重大决策：[docs/adr/](./docs/adr/)
- 实现级规格：`docs/spec/`（wayfinder 地图产出）

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues; use the `gh` CLI for all operations (create/read/list/comment/label/close). Wayfinder maps and tickets are issues labelled `wayfinder:map` / `wayfinder:<type>`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. Read them before exploring; use the glossary's vocabulary (拆书、桥段、单元、矛盾、章节拍、类型、解法、灵感库、故事卡片). See `docs/agents/domain.md`.
