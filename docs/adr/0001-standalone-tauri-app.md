# 独立应用（Tauri 2），而非 Obsidian 插件或 Electron

用户已在 Obsidian 中积累了全部写作素材，仍选择独立应用：避免"装修 Obsidian"式的精力分散，需要一个专注、可深度定制的操作界面，而不是寄居在笔记工具里的插件。技术栈：Tauri 2 + React + TypeScript + CodeMirror 6，Windows 优先，界面全中文。

## Considered Options

- **Obsidian 插件**（否决）：编辑器、文件管理、侧边栏全部现成，AI 侧边栏也有成熟先例；但受插件 API 约束，且用户明确担心注意力会落入配置工具而非创作本身。
- **Electron**（否决）：全 JS、资料最厚，但体积与内存开销大，个人长期维护不划算。
- **Tauri 2**（选定）：体积小、用系统 WebView、文件系统能力够用。

## Consequences

编辑器与文件管理需要自建（最大的一块自建成本）；因数据保持纯文本（见 0002），将来迁回 Obsidian 或换任何工具的成本有界。
