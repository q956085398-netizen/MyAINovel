# MyAINovel / 工笔

个人网文创作工具「工笔」：拆书积累 → 灵感沉淀 → 构思写作。Windows 优先，界面全中文，数据保持纯文本（Markdown + YAML），随时可回到 Obsidian。

技术栈：Tauri 2 + React + TypeScript（应用代码在 [`app/`](./app/)）。

## 启动

两条路（详见 [docs/spec/启动与分发.md](./docs/spec/启动与分发.md)）：

### 日常：双击启动器（推荐）

双击仓库根的 **`启动工笔.vbs`**：无终端窗口，直接以开发模式（`npm run tauri dev`）拉起应用——**代码总是最新**，改完代码或拉取后无需重打包。

- 冷启动要等增量编译：**数秒到数十秒，首次更久**，属预期；启动器会先弹一个自动消失的「正在启动」提示。
- 想在桌面放个入口：双击 **`建桌面快捷方式.vbs`**，一键创建指向启动器的「工笔」快捷方式。

### 备份：安装包 / 独立 exe（代码快照）

构建一次产物（NSIS 安装包＋独立 exe）：

```powershell
cd app
npm run tauri build -- --bundles nsis
```

产物路径（`0.1.0` 为版本号，随 `app/src-tauri/tauri.conf.json` 变化）：

| 产物 | 路径 |
|---|---|
| NSIS 安装包 | `app/src-tauri/target/release/bundle/nsis/工笔_0.1.0_x64-setup.exe` |
| 独立 exe（绿色） | `app/src-tauri/target/release/工笔.exe` |

安装包安装后桌面图标启动为纯 GUI（release 无终端窗口）。**注意**：安装包/独立 exe 是构建时的代码快照，升级需重新构建；数据（库文件夹）不受影响。

> MSI 打包在本机 WiX `light.exe` 起不来（环境问题，与仓库无关），故固定用 `--bundles nsis`；需要 MSI 时先排查 WiX/.NET 运行时再跑 `npm run tauri build`。

## 开发

```powershell
cd app
npm install
npm run tauri dev   # 开发运行
```

测试：`app/src-tauri/` 下 `cargo test`（Rust 侧）；前端 `npm run build`（含 tsc 类型检查）。

## 文档

- 领域词汇表：[CONTEXT.md](./CONTEXT.md)
- 设计总览：[docs/设计共识.md](./docs/设计共识.md)
- 重大决策：[docs/adr/](./docs/adr/)
- 实现级规格：[docs/spec/](./docs/spec/)
