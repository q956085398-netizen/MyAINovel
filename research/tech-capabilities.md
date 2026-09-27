# 调研报告：CodeMirror 6 中文长文写作 + Tauri 2 文件能力

调研日期：2026-09-06。版本口径：CodeMirror 6（@codemirror/* 6.x 系）、Tauri 2.x（插件 2.x、Rust ≥ 1.77.2）。运行环境假设：Tauri 2 + React + TS，Windows（WebView2）优先。
标注体系：【现成可用】有官方/成熟生态支持；【需自建】无现成轮子但 API 支撑充分；【有坑】可用但有已知风险需绕行。

## 结论速览

| 条目 | 结论 | 一句话 |
|---|---|---|
| A1 百万字性能/拆分 | 现成可用（推荐按章拆分） | CM6 官方有百万行 demo；按章拆文件后单编辑器毫无压力 |
| A2 中文字数统计 | 需自建（小体量） | Intl.Segmenter 分词 + code point 计数；网文计费口径=计标点不计空格 |
| A2 选区字数提示 | 现成可用（API 级） | selection 主选区 sliceString 统计即可 |
| A3 打字机模式 | 现成可用 | 有 npm 包 codemirror-typewriter-scrolling；官方 scrollIntoView/scrollMargins/centerOn |
| A3 行高亮/行淡化/禅模式 | 需自建（简单） | 官方 highlightActiveLine 现成；淡化用 line decoration 自建；禅模式=UI 层 |
| A4 按章节折叠 | 需自建（薄） | codeFolding 现成，但 markdown 标题默认不可折叠，需自定义 foldable |
| A4 大纲导航 | 需自建 | 扫标题 + 跳转 scrollIntoView，无官方组件 |
| A5 选区装饰+右键菜单 | 现成可用（官方 API） | Decoration.mark + domEventHandlers({contextmenu})，均为官方一等公民 |
| A5 标记持久化到 md 源 | 有坑（方案取舍） | 推荐 HTML 注释包 id + 侧文件/SQLite 存元数据 |
| A6 本地词典校对 | 需自建（规则级可行） | 「的地得」=词性规则；有 Obsidian 同类 TS 插件可参考；模型级不建议前端 |
| B1 文件监听 | 现成可用（有坑） | tauri-plugin-fs watch 官方支持；Windows 下事件粒度粗/重复，建议 Rust 侧 notify-debouncer |
| B2 原子写 | 现成可用 | 同目录 temp+fsync+rename，NTFS 上 MoveFileEx 原子替换；有现成 crate |
| B3 与 Obsidian 并发防护 | 需自建 | 文件锁不现实；保存前 mtime+size+hash 快照比对，分歧弹窗不自动合并 |
| B4 SQLite 可弃索引 | 现成可用 | tauri-plugin-sql 官方（sqlx）或自建 rusqlite；中文 FTS5 需自建分词【有坑】 |

---

## A. CodeMirror 6 中文长文写作

### A1 大文档性能边界与拆分策略 —— 【现成可用，推荐按章拆分】

- 官方架构保证：`Text` 类型是"immutable tree-shaped representation"（绳索树风格），官方参考手册明确三条能力：按 UTF-16 偏移/行号高效索引、"Structure-sharing immutable updates"（更新结构共享，不整体复制）、访问/迭代文档片段"without copying or concatenating big strings"。渲染只画视口内可见行，与文档总长基本无关。来源：[CM6 Reference Manual - Text](https://codemirror.net/docs/ref/#text)
- 官方大文档演示：[million demo](https://codemirror.net/examples/million/) 加载"几百万行"文档仍可编辑；语法高亮是渐进式的（滚得远时高亮暂时"追不上"，编辑器不活跃时解析完全暂停以省电省内存）。
- 已知边界（坑）：
  - 超长**单行**比多行更危险：[codemirror/dev#1089](https://github.com/codemirror/dev/issues/1089) 报告单行 3 万字符即出渲染故障。中文小说一行=一段，段落普遍在几百字内，风险低，但要注意粘贴不换行的长文本。
  - 主动 `forceParsing` 在 ~300 万行文档上会冻结数分钟（[discuss 5569](https://discuss.codemirror.net/t/syntax-highlighting-disappears-if-large-documents-are-scrolled-fast/5569)）——不要对超大文档强制全量解析。
- 推荐拆分策略：**按章一文件**（网文单章 2000–6000 字），CM6 单实例只加载当前章。理由：单章远低于任何性能边界；全文级功能（跨章检索、统计、伏笔索引）不应走 CM6，走 SQLite 索引（见 B4）。百万字=数百章文件，编辑器层面永远只处理几 KB–几十 KB 文本。
- 参考：Sourcegraph 从 Monaco 迁到 CM 的复盘也印证 CM6 视口懒渲染是处理大文件的关键架构优势（[来源](https://sourcegraph.com/blog/migrating-monaco-codemirror)）。

### A2 中文字数统计（含/不含标点、网文计费口径）+ 选区字数 —— 【需自建（小体量），API 现成】

- 现代分词方案：`Intl.Segmenter('zh', { granularity: 'word' })`，可按 `isWordLike` 过滤标点，是 TC39 标准提案落地 API（[TC39 proposal](https://github.com/tc39/proposal-intl-segmenter)、[MDN Blog](https://developer.mozilla.org/en-US/blog/javascript-intl-segmenter-i18n/)、中日文计数实践 [SO #76537699](https://stackoverflow.com/questions/76537699/how-to-count-number-of-words-in-chinese-japanese-content-in-javascript)）。
- 网文计费口径（以起点为代表，来源为起点官方问答页，属二手转述口径、以平台计数系统为准）：
  - 计数**不含空格**（[起点问答](https://m.qidian.com/ask/qqbkghvpetuen)、[起点问答 2](https://www.qidian.com/ask/qqbamfoqbzfyc)）；
  - 入 V 计费标点**计入**字数，大致以 Word 计数为参照，按**千字**计费单位（[起点问答](https://www.qidian.com/ask/qqbzfzfiqfoxa)、[知乎讨论](https://www.zhihu.com/question/290397109)）。
  - 结论：UI 应同时展示两个口径——「计费字数」（去空白、含标点的 code point 数）与「纯汉字数」（不含标点，用 `/\p{Script=Han}/gu` 计数即可，无需分词器）。晋江/番茄逐家口径**未能核实**，做成可配置。
- 选区字数提示：CM6 API 级支持——`updateListener` 里 `update.selectionSet` 时取 `state.selection.main`，`doc.sliceString(from, to)` 后按上法统计，成本 O(选区长度)。（API 依据：[官方 Reference](https://codemirror.net/docs/ref/)；监听模式参考 [discuss 2395](https://discuss.codemirror.net/t/codemirror-6-proper-way-to-listen-for-changes/2395)）
- 大文档性能注意：全文统计是 O(n)，每键重算不可取。按章拆分后天然是「章内统计 + 各章缓存求和」；章内统计也应在 `docChanged` 上防抖/空闲执行（性能讨论：[discuss 2395](https://discuss.codemirror.net/t/codemirror-6-proper-way-to-listen-for-changes/2395)、[CM6 官方 Ref](https://codemirror.net/docs/ref/)）。`doc.length` 与行数是 O(1)，可直接实时显示。

### A3 打字机模式 / 行高亮 / 行淡化 / 禅模式 —— 【打字机现成可用；淡化/禅模式需自建（简单）】

- 打字机模式（光标保持视口中央）：
  - 现成包：[azu/codemirror-typewriter-scrolling](https://github.com/azu/codemirror-typewriter-scrolling)（npm 安装即用）。
  - 自建路径：`EditorView.scrollIntoView(pos, {y: 'center'})` / `scrollMargins` facet（[官方 Ref](https://codemirror.net/docs/ref/)、[discuss 3042](https://discuss.codemirror.net/t/how-to-use-scrollmargin/3042)）；changelog 中还有 `centerOn` effect。Joplin（同为 CM6 编辑器）的打字机插件讨论可作为实现参考（[Joplin 论坛](https://discourse.joplinapp.org/t/advice-needed-building-a-typewriter-mode-plugin/19828)）。Obsidian 生态的同类诉求讨论：[forum.obsidian.md](https://forum.obsidian.md/t/typewriter-scrolling/131)。
- 当前行高亮：官方 `@codemirror/view` 的 `highlightActiveLine()` 现成可用（[官方 Ref](https://codemirror.net/docs/ref/)）。
- 行淡化（非当前行/段变暗）：需自建，做法是 ViewPlugin + line decoration 给非活动行加 dim class；先例：[atomic-editor](https://github.com/kenforthewin/atomic-editor)（"Inline decorations hide syntax tokens on inactive lines without changing line heights"）与 [Pamela Fox 的 line-highlighting 教程](http://blog.pamelafox.org/2022/07/line-highlighting-extension-for-code.html)。
- 禅模式 = 全屏/隐藏侧栏 + 行淡化 + 打字机叠加，UI 层自建。扩展的运行时开关用官方 `Compartment` 机制（[discuss 4667](https://discuss.codemirror.net/t/toggling-extensions/4667)）。

### A4 折叠（按章节/场景）+ 大纲导航 —— 【需自建（薄层）】

- 折叠引擎现成：`@codemirror/language` 的 `codeFolding()` / `foldGutter()` / `foldable()` / `foldNodeProp`。
- 坑：**markdown 标题默认不可折叠**，需要自定义 foldable——从标题行折到下一个同级（或任意更高级）标题。官方论坛有完整讨论与实现：[Fold Markdown headings - v6](https://discuss.codemirror.net/t/fold-markdown-headings/5544)。折叠按行关联 range，语法树方案取最外层匹配节点（[discuss 8021](https://discuss.codemirror.net/t/interesting-list-folding-behavior/8021)）。
- 「按章节折叠」在按章拆分架构下天然是文件树层的折叠；章内按二级标题/场景分隔符折叠走上述自定义 foldable。
- 折叠状态持久化：CM6 折叠状态存在 editor state，不落盘；Joplin 有持久化折叠的插件先例（[Joplin 论坛](https://discourse.joplinapp.org/t/persistent-text-folding-in-editor/16183)），需要的话自建映射表。
- 大纲导航：无官方组件，需自建——用 `syntaxTree` 遍历 `ATXHeading` 节点（或直接逐行正则）产出大纲列表，点击项 `dispatch` 选区到目标行 + `scrollIntoView(t, {y:'center'})` 跳转（[discuss 4388](https://discuss.codemirror.net/t/codemirror-6-move-cursor-to-specific-line-and-mark-its-text/4388)）。Obsidian 的 Outline 核心插件即此思路。

### A5 选区装饰 + 右键菜单打标记 + 持久化（伏笔标注交互基础）—— 【装饰与菜单：现成可用（官方 API）；持久化：有坑（方案取舍）】

**交互层（现成）：**
- `Decoration.mark({class, attributes})` 是官方最常用装饰类型，语法高亮本身就是 mark decoration 实现的（[官方 Decorations 示例](https://codemirror.net/examples/decoration/)）。模式：StateField/StateEffect + `DecorationSet`，文档变更时 `decorations.map(changedRanges)` 自动跟随选区移动——打过的标记随编辑自动平移，这是官方设计内行为。参考：[高亮子串讨论](https://discuss.codemirror.net/t/codemirror-6-highlighting-specific-substring/6615)、[SO](https://stackoverflow.com/questions/72599672/how-to-search-and-highlight-a-substring-in-codemirror-6)。
- 右键菜单：`EditorView.domEventHandlers({ contextmenu(event, view) {...} })` 官方 API，`event.preventDefault()` + return true 即可完全接管菜单（[discuss 2956](https://discuss.codemirror.net/t/add-right-click-context-menu-with-custom-menu-items/2956)、[关闭时机讨论 7759](https://discuss.codemirror.net/t/context-menu-tooltip-in-v6-and-how-to-trigger-its-close/7759)）。Tauri 2 下就是普通 DOM 菜单，无特殊限制。

**持久化层（方案对比，坑在取舍）：**

| 方案 | 兼容性 | 优点 | 缺点 | 来源 |
|---|---|---|---|---|
| HTML 注释 `<!-- fk:ID -->` | CommonMark 标准内，Obsidian/任意 md 工具渲染时忽略 | 零生态成本、纯文本自包含、导出不丢 | 编辑态视觉噪音；导出 HTML 源码仍可见；多行/嵌套需转义 | [SO: comments in markdown](https://stackoverflow.com/questions/4823468/comments-in-markdown)、[CommonMark 论坛](https://talk.commonmark.org/t/method-for-comments-especially-multiline/208) |
| Obsidian `%% ... %%` | 仅 Obsidian 系 | Obsidian 编辑/阅读视图都隐藏 | 非标准语法，出 Obsidian 生态即裸露 | [Obsidian 论坛 CriticMarkup 帖内对照](https://forum.obsidian.md/t/support-critic-markup/18485)；官方帮助页未能抓取原文，**此点为通识+论坛佐证** |
| 自定义语法（如 CriticMarkup `{>> <<}`） | 编辑标记生态（Marked 2、MultiMarkdown 等） | 语义明确、有工具链 | 「伏笔」是自定义语义，现有生态不认，需要自己写解析/渲染 | [CriticMarkup 官方语法](https://fletcher.github.io/MultiMarkdown-6/syntax/critic.html)、[MacStories](https://www.macstories.net/news/criticmarkup-plain-text-syntax-for-editorial-reviews/)、[toolkit](https://github.com/CriticMarkup/CriticMarkup-toolkit) |
| 侧文件锚点（markers.json：文件+位置指纹） | 与正文完全解耦 | 不污染正文 | 锚点漂移必须处理（前后文字指纹匹配回填）；与 Obsidian 的正文修改要靠重定位算法 | 无单一权威先例，属通行做法（syncthing/Obsidian 同步冲突副本同理保留侧信息） |

**推荐结论：混合方案**——正文内嵌最小标记 `<!-- fk:ID -->`（包裹或前置于伏笔文本），标记的元数据（类型、颜色、备注、回收/兑现状态）存 SQLite（B4）或侧文件。这样：正文在任何 md 工具里都可读且渲染时标记隐形；元数据变更不动正文（减少与 Obsidian 的写冲突面）；打开文件时正则重扫标记重建装饰（外部改动后也能恢复，与 B3 的 reload 流程衔接）。

### A6 本地词典校对（错词/敏感词/「的地得」）—— 【需自建；规则/词典级可行，模型级不建议前端】

- 「的地得」本质是词性判断问题（名词前用「的」、动词/副词前用「地」、补语前用「得」），可行路径 = 分词 + 词性标注 + 规则词典，纯 JS/本地可做。最直接同类先例：[obsidian-webnovel-assistant](https://github.com/hatanochihiro/obsidian-webnovel-assistant)（TS/Obsidian 插件，校对全本地零联网，内置「的地得」规则词典与基础错词库，词典数据设置内手动下载）。
- 词典资源：错词/形近音近混淆集与敏感词库可取自 [funNLP 资源合集](https://github.com/fighting41love/funnlp)；英文侧 [ECDICT](https://github.com/skywind3000/ecdict) 结构可借鉴。
- 词典匹配算法：SymSpell 有 JS 实现（速度快、自带高频词，社区评测见[词典工具讨论](https://forum.freemdict.com/t/topic/655)）；敏感词扫描用 Aho-Corasick/DFA，纯 JS 成熟。
- 深度模型方案（pycorrector，MacBERT 系）是 Python 栈（[GitHub](https://github.com/shibing624/pycorrector)），作为规则设计参考即可，不建议塞进 Tauri 前端（体积/推理成本不成比例）。
- LanguageTool 可自托管但中文规则少，且有「的得地」误报的开放 issue（[languagetool#11837](https://github.com/languagetool-org/languagetool/issues/11837)），不作为依赖。
- CM6 集成形态：校对命中处加 mark decoration 波浪线（同 A5 机制），点击/悬停出建议卡片。整体判定：**可自建、非研究性难点，但需要人工维护词典**，首版可只做敏感词（DFA，确定性高）+「的地得」规则（收益最高）。

---

## B. Tauri 2 文件能力

### B1 文件监听（tauri-plugin-fs watch / notify-rs，Windows）—— 【现成可用（官方插件），有坑要绕】

- 官方能力（[v2.tauri.app/plugin/file-system](https://v2.tauri.app/plugin/file-system/)）：`watch`（防抖，`delayMs` 可调）/ `watchImmediate`；需 `features = ["watch"]`；**默认非递归**，子目录要 `recursive: true`；权限需 `fs:allow-watch` + 显式 scope（allow/deny 路径，deny 优先）。
- Windows 下的坑（底层为 notify-rs，Win32 `ReadDirectoryChangesW`）：
  - 事件类型粒度粗：`ModifyKind`/`RemoveKind` 在 Windows 上常为 `Any`（[notify#261](https://github.com/notify-rs/notify/issues/261)）——**不要依赖细粒度事件类型做业务判断**。
  - 一次保存多次事件：编辑器「写临时文件+rename」会表现为 create/remove 而非 modify，且重复 Modify 频发，建议 debouncer（[Rust 论坛](https://users.rust-lang.org/t/problem-with-notify-crate-v6-1/99877)、[Reddit](https://www.reddit.com/r/rust/comments/wq0oy2/rust_notify_filewatcher_is_not_debouncing_events/)、[notify-win known problems](https://lib.rs/crates/notify-win)）。
  - WSL 环境走 inotify 后端，Windows 侧改动会丢事件（[notify#254](https://github.com/notify-rs/notify/issues/254)）——发布环境是真 Windows 即可，注意别在 WSL 路径上测试。
  - Tauri v2 插件层：watch 单文件时回调可能只触发一次，workaround 是递归监听父目录（[SO](https://stackoverflow.com/questions/76215826/tauri-fs-watch-plugin-only-runs-watcher-callback-once)、[Reddit](https://www.reddit.com/r/rust/comments/13dlksv/callback_for_tauripluginfswatch_only_runs_once/)）；webview 刷新后 callback id 丢失报错（[plugins-workspace#2961](https://github.com/tauri-apps/plugins-workspace/issues/2961)）。
  - 大目录高频事件可能溢出丢事件（[notify docs 已知问题](https://docs.rs/notify/)、微软同源说明 [InternalBufferOverflowException](https://learn.microsoft.com/en-us/dotnet/api/system.io.internalbufferoverflowexception)）。
- **推荐架构**：监听逻辑放 Rust 侧——`notify-debouncer-full` 自建 watcher，经 Tauri event 发规范化事件（路径+粗类型）给前端；避免依赖 JS 侧 watch 的 callback 生命周期问题。这与 B3 的「外部改动检测」共用一条事件通道。

### B2 原子写（临时文件+rename 在 NTFS）—— 【现成可用（成熟模式+现成 crate）】

- 标准做法：在**目标同目录**建临时文件 → 写入 → flush+fsync → rename 覆盖目标。同文件系统是 rename 原子性的前提（这也是 tempfile crate 提供 `new_in` 的原因：[SO](https://stackoverflow.com/questions/70362352/atomic-file-create-write)）。
- Windows/NTFS 行为：Rust `std::fs::rename` 在 Windows 映射到 `MoveFileEx` + `MOVEFILE_REPLACE_EXISTING`，NTFS 上对已存在目标的替换是原子的；社区共识与 crate 实现均确认（[Rust 论坛](https://users.rust-lang.org/t/how-to-write-replace-files-atomically/42821)、[rust-atomicwrites](https://github.com/untitaker/rust-atomicwrites)）。
- 现成 crate：[atomicwrites](https://github.com/untitaker/rust-atomicwrites)（POSIX+Windows）、[atomic-write-file](https://docs.rs/atomic-write-file)（同目录临时文件+rename）；或参考 [reth 的 atomic_write_file](https://reth.rs/docs/reth_fs_util/fn.atomic_write_file.html)（含 fsync）自行实现，量级很小。
- Windows 特有坑：目标文件若被其他进程以不兼容共享模式打开句柄，rename 覆盖可能失败（sharing violation）——**与 Obsidian 并存时必须捕获失败并重试/提示**（POSIX 下 open 句柄不影响 rename，Windows 不是）。此差异点在 [Rust 论坛讨论](https://users.rust-lang.org/t/how-to-write-replace-files-atomically/42821)及 Windows API 语义中有依据。
- 与 B1 的联动：我们的 temp+rename 保存会让监听方（包括 Obsidian 自己的 watcher）收到 create/remove 而非 modify——Obsidian 能正常处理外部 rename 覆盖（其「文件已被外部修改」机制即为此设计），但自家 watcher 要按 B1 建议做事件归并。

### B3 与 Obsidian 并发编辑同一 vault 的冲突防护 —— 【需自建：无锁，检测+提示+冲突副本】

- 文件锁不可行：Obsidian 不遵守任何第三方锁协议，Windows 上也没有跨应用的强制锁约定。现实手段是**保存前检测 + 分歧不自动合并**：
  1. 打开文件时记录快照：`mtime` + `size`（Windows NTFS mtime 精度 100ns，足够）。
  2. 保存前 `stat` 比对快照；不一致 → 加第二道防线：对磁盘文件做快速内容 hash（如 xxhash）与载入时 hash 比对，排除纯 mtime 被触碰（云盘/同步盘会平移 mtime 造成假冲突，Syncthing+Obsidian 大量案例：[Syncthing 论坛](https://forum.syncthing.net/t/sync-conflicts-when-file-only-edited-on-one-device/25954)、[syncthing#8604](https://github.com/syncthing/syncthing/issues/8604)）。
  3. 确认外部修改后弹窗：保留我们版本为副本 / 用磁盘版本覆盖本地 / 手动 diff 合并。这是 Obsidian（「file has been modified externally」对话框，[论坛案例](https://forum.obsidian.md/t/bug-modified-externally-message-constantly-appears-erasing-my-text/26090)）与 VS Code 同款策略。
- 检测通道复用 B1 的 Rust 侧 watcher：外部改动事件到达时，若该文件在编辑器中打开且本地有未保存修改 → 标记冲突；无本地修改 → 静默重载。
- 场景有利面：单人写作时极少真的在两个编辑器同时改同一章，主要风险是「Obsidian 常开+自动保存」与我们自动保存的窗口竞争——所以**检测必须放在保存时刻**（TOCTOU 窗口最小化），而不是只在打开时。
- 已知现实坑（据 Obsidian 论坛多帖）：云盘同步 + 自动保存会产生副本文件与误报，产品上建议文档明确「不支持网盘实时同步的 vault 并用」。

### B4 SQLite 作为可弃索引（tauri-plugin-sql vs 自建 Rust 侧）—— 【现成可用；中文 FTS5 有坑】

- 官方插件 [tauri-plugin-sql](https://v2.tauri.app/plugin/sql/)（[GitHub tauri-apps/plugins-workspace](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/sql)）：基于 **sqlx**，SQLite 经 cargo feature 启用；默认库路径相对 AppConfig 目录；**自带版本化 migrations API**（`Migration{version, description, sql, kind}`，全部在事务内执行，失败整体回滚，支持 preload）。前端 `Database.load('sqlite:test.db')` 即用。权限默认仅 load/select/close，写操作要在 capabilities 加 `sql:allow-execute`。
- 取舍：
  - **tauri-plugin-sql**：上手最快，SQL 散落前端、sqlx 参数是运行时校验。适合索引读写简单的前期。
  - **自建 Rust 侧**（rusqlite 或社区 [tauri-plugin-rusqlite2](https://crates.io/crates/tauri-plugin-rusqlite2)）：类型安全、事务控制自由、**可加载自定义 FTS5 tokenizer**。若要做中文全文检索，这条路几乎是必然——**坑：SQLite FTS5 默认 tokenizer（unicode61）不切中文**（中文整句成单 token），必须自建 jieba 分词 tokenizer（rusqlite 可 `load_extension`/Rust 侧实现）或入库前预分词存「空格分隔 token 列」再建 FTS5 索引。
  - 可弃索引定位合理：真源是 markdown 文件，SQLite 全部可重建；百万字级（数 MB 文本）全量重建在秒级，日常增量按章更新。建议 WAL 模式（读不阻塞）。
  - 社区实践参考：[Tauri 官方教程 todo+sqlite+sqlx](https://tauritutorials.com/blog/building-a-todo-app-in-tauri-with-sqlite-and-sqlx)、[Tauri 2 + React + SQLite](https://dev.to/focuscookie/tauri-20-sqlite-db-react-2aem)；路径相对性的坑见 [SO](https://stackoverflow.com/questions/78015812/failed-to-connect-a-sqlite-file-in-tauri-vue-project)。

---

## 版本与未决事项

- 版本：CodeMirror 6.x（2026-09 仍在 6.x 系列上演进）；Tauri 2.x，插件（fs/sql）2.x，Rust ≥ 1.77.2；打字机包 codemirror-typewriter-scrolling（npm）。
- **未能核实**：
  - Obsidian 官方帮助页 Comments 原文（页面为 JS 渲染，无法抓取正文；`%%`/HTML 注释行为以论坛与通识佐证）。
  - 晋江/番茄等非起点平台的计费字数口径（建议产品层做成可配置口径）。
  - tauri-plugin-fs watch 在 WebView2 下 contextmenu 无关（无关项），未发现 Windows 11 24H2+ 特有回归报告。
- 来源均以官方文档（codemirror.net、v2.tauri.app、docs.rs、Microsoft Learn）与一手 issue/forum 讨论为主，二手信息已标注。

## 关键来源索引

官方：[CM6 Ref - Text](https://codemirror.net/docs/ref/#text) / [million demo](https://codemirror.net/examples/million/) / [decorations 示例](https://codemirror.net/examples/decoration/) / [Tauri 2 fs 插件](https://v2.tauri.app/plugin/file-system/) / [Tauri 2 sql 插件](https://v2.tauri.app/plugin/sql/) / [notify docs](https://docs.rs/notify/)
一手 issue/讨论：[cm dev#1089 长单行](https://github.com/codemirror/dev/issues/1089)、[fold markdown headings](https://discuss.codemirror.net/t/fold-markdown-headings/5544)、[contextmenu](https://discuss.codemirror.net/t/add-right-click-context-menu-with-custom-menu-items/2956)、[notify#261](https://github.com/notify-rs/notify/issues/261)、[notify#254 WSL](https://github.com/notify-rs/notify/issues/254)、[plugins-workspace#2961](https://github.com/tauri-apps/plugins-workspace/issues/2961)、[languagetool#11837](https://github.com/languagetool-org/languagetool/issues/11837)
