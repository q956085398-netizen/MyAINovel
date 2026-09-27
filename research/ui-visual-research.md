# UI 视觉调研（工单 #39 参考方向素材）

只记录从一手来源（官方文档、上游仓库源码）读到的数字。社区镜像/第三方主题/issue 转述显式标注「二手来源」；抓不到一手数字的写「未找到一手来源」。不含设计建议。`--x: 1px` 形式为来源原始写法，URL 保持原样。

## 1. Obsidian

**结论速览**：4px/2px 双网格 + 四档圆角 + 四档图标字号 + 「UI 字号绝对、正文相对」双轨字体；图标直接用 Lucide；动效/阴影在官方文档里没有数值页（见 1.6）。

### 1.1 圆角（官方 Reference > CSS variables > Foundations > Radiuses）
`--radius-s: 4px` / `--radius-m: 8px` / `--radius-l: 12px` / `--radius-xl: 16px`。组件另有 `--modal-radius`、`--clickable-icon-radius`、`--tab-radius` 等，默认引用这四档（组件变量名来自社区参考，二手）。

### 1.2 间距：4px 网格 + 2px 细网格（官方 Spacing）
官方原文：Obsidian uses a 4-pixel grid；变量名两个数字 = base 与倍数（`--size-4-1` = 4×1 = 4px）；2px 网格「use sparingly and only when you need more fine-grained spacing」。
| 2px 网格 | 值 | 4px 网格 | 值 |
| --- | --- | --- | --- |
| `--size-2-1` | `2px` | `--size-4-1` | `4px` |
| `--size-2-2` | `4px` | `--size-4-2` | `8px` |
| `--size-2-3` | `6px` | `--size-4-3` | `12px` |
| | | `--size-4-4` | `16px` |
| | | `--size-4-5` | `20px` |
| | | `--size-4-6` | `24px` |
| | | `--size-4-8` | `32px` |
| | | `--size-4-9` | `36px` |
| | | `--size-4-12` | `48px` |
| | | `--size-4-16` | `64px` |
| | | `--size-4-18` | `72px` |
4px 档位不连续（无 28/40/44/52/56/60px）。社区参考（二手）称该尺度 1:1 对应 Tailwind 默认 spacing scale。

### 1.3 字号层级（官方 Typography）
官方原文：编辑器里用相对变量 `--font-*`，UI 用固定变量 `--font-ui-*`。
| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `--font-text-size` | `16px` | 编辑器正文（用户可在 Appearance 改） |
| `--font-smallest` / `--font-smaller` / `--font-small` | `0.8em` / `0.875em` / `0.933em` | 相对字号 |
| `--font-ui-smaller` | `12px` | |
| `--font-ui-small` | `13px` | |
| `--font-ui-medium` | `15px` | |
| `--font-ui-large` | `20px` | |
字重 `--font-thin`(100) … `--font-black`(900) 共 9 档。行高只有两档：`--line-height-normal: 1.5`、`--line-height-tight: 1.3`（tight 用于搜索结果/树节点/tooltip）。粗体推荐用 `--bold-modifier`（官方建议 100–300）叠加。

### 1.4 图标：直接采用 Lucide（官方 Icons）
官方原文：Obsidian uses the Lucide icon library, which includes more than 800 icons（该数字偏旧，Lucide 现有数千个）。
| 变量 | 尺寸 | 描边 |
| --- | --- | --- |
| `--icon-xs` | `14px` | `--icon-xs-stroke-width: 2px` |
| `--icon-s` | `16px` | `--icon-s-stroke-width: 2px` |
| `--icon-m` | `18px` | `--icon-m-stroke-width: 1.75px` |
| `--icon-l` | `18px` | `--icon-l-stroke-width: 1.75px` |
| `--icon-xl` | `32px` | `--icon-xl-stroke-width: 1.25px` |
即小图标 2px 描边，18px 起 1.75px，32px 降到 1.25px——「尺寸越大描边越细」的一手样例。另有 `--icon-stroke`、`--icon-color/hover/active/focused`、`--icon-opacity*`、`--clickable-icon-radius`。

### 1.5 层级与描边
z-index 十档：`--layer-cover: 5`、`--layer-sidedock: 10`、`--layer-status-bar: 15`、`--layer-popover: 30`、`--layer-slides: 45`、`--layer-modal: 50`、`--layer-notice: 60`、`--layer-menu: 65`、`--layer-tooltip: 70`、`--layer-dragged-item: 80`。描边仅 `--border-width: 1px`。光标 `--cursor: default`（交互元素跟随系统箭头）、`--cursor-link: pointer`。

### 1.6 动效（二手来源）
官方 docs 仓库 Foundations 目录**没有** Animations/Shadow 页面，app.css 未开源，只能引社区转述（两个独立二手来源数值一致）：`--anim-duration-none: 0`、`superfast: 70ms`、`fast: 140ms`、`moderate: 300ms`、`slow: 560ms`；曲线 `smooth: cubic-bezier(0.45,0.05,0.55,0.95)`、`delay: cubic-bezier(0.65,0.05,0.36,1)`、`jumpy: cubic-bezier(0.68,-0.55,0.27,1.55)`、`swing: cubic-bezier(0,0.55,0.45,1)`。阴影变量名（二手，未给值）：`--shadow-xs`、`--shadow-s`（卡片/下拉）、`--shadow-l`（popover/modal）、`--input-shadow`、`--input-shadow-hover`，定义在 `.theme-light`/`.theme-dark` 上。另一二手来源（catppuccin 主题抄上游默认值）给出上游阴影实例：`--pdf-shadow: 0 0 0 1px rgba(0,0,0,5%), 0 2px 8px rgba(0,0,0,10%)`。

### 1.7 亮/暗颜色层级（官方 Colors）
| 变量 | Light | Dark |
| --- | --- | --- |
| `--color-base-00` | `#ffffff` | `#1c1c1c` |
| `--color-base-05` | `#fcfcfc` | `#212121` |
| `--color-base-10` | `#fafafa` | `#232323` |
| `--color-base-20` | `#f6f6f6` | `#282828` |
| `--color-base-25` | `#efefef` | `#2e2e2e` |
| `--color-base-30` | `#e4e4e4` | `#333333` |
| `--color-base-35` | `#dadada` | `#3f3f3f` |
| `--color-base-40` | `#bdbdbd` | `#555555` |
| `--color-base-50` | `#ababab` | `#666666` |
| `--color-base-60` | `#707070` | `#999999` |
| `--color-base-70` | `#5c5c5c` | `#b3b3b3` |
| `--color-base-100` | `#222222` | `#dadada` |
暗色下 base-00→base-20 是**变亮**的（#1c1c1c → #282828），即「次级表面比正文面更亮」靠色阶而非阴影；但「语义变量 ↔ base 档位」的映射官方只给描述不给值，细节只能引社区参考（二手）。强调色为用户可配 HSL，默认 `--accent-h: 258`、`--accent-s: 88%`、`--accent-l: 66%`，派生 `--color-accent-1/2` 供 hover/active。扩展色亮暗各一套，暗色**统一提亮**而非降饱和：`--color-red #e93147 → #fb464c`、`--color-purple #7852ee → #a882ff`、`--color-blue #086ddd → #027aff`。自 1.13 起混色改 OKLCH，RGB 变量 deprecated（官方建议 `color-mix(in oklch, var(--color-red) 20%, transparent)` 替代 `rgba(var(--color-red-rgb), .2)`）。官方文档里的社区参考另给一套 base 值（如 dark base-25 为 `#2a2a2a`，与官方 `#2e2e2e` 不一致）——说明二手数值不可直接引用。

来源：https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Radiuses.md ；同目录 Spacing.md、Typography.md、Icons.md、Colors.md、Layers.md、Borders.md（同一 GitHub 目录，逐文件核对）｜二手动效/阴影名：https://github.com/aidenlx/zotlit/blob/main/.agents/skills/obsidian-css/references/foundations.md ｜二手交叉验证：https://github.com/catppuccin/obsidian/blob/main/scss/base/_app-variables.scss

## 2. 思源笔记 SiYuan（开源；SCSS/CSS 在 app/ 下）

**结论速览**：圆角 3 档（3/6/12px）；间距基元 4px；UI 字号 14px、编辑器默认 16px；行高 1.625；阴影硬编码在默认主题里，暗色改用「内嵌白色高光 + 1px 外描边」；图标为自绘 24×24 SVG sprite、描边 1.7px。

### 2.1 设计变量（`app/appearance/themes/daylight|midnight/theme.css`）
| 变量 | daylight | midnight |
| --- | --- | --- |
| `--b3-border-radius` | `6px` | `6px` |
| `--b3-border-radius-s` | `3px` | `3px` |
| `--b3-border-radius-b` | `12px` | `12px` |
| `--b3-font-size`（UI） | `14px` | `14px` |
| `--b3-layout-space` | `4px` | `4px` |
| `--b3-layout-space-margin` | `-4px` | `-4px` |
圆角只有 3 档，6px 为默认，12px 专给弹窗（`.b3-dialog__container { border-radius: var(--b3-border-radius-b) }`）。

### 2.2 阴影（亮/暗两套，硬编码在主题里）
| 变量 | daylight | midnight |
| --- | --- | --- |
| `--b3-point-shadow` | `0 0 1px 0 rgba(0,0,0,.1), 0 0 2px 0 rgba(0,0,0,.2)` | `inset 0 .5px .5px .5px rgba(255,255,255,.12), 0 3px 8px rgba(0,0,0,.3), 0 0 0 0 transparent` |
| `--b3-dialog-shadow` | `0 8px 24px rgba(0,0,0,.2)` | `0 8px 24px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.12)` |
| `--b3-button-shadow` | `0 1px 2px 0 rgb(0 0 0 / .3), 0 1px 3px 1px rgb(0 0 0 / .15)` | key 阴影改 `rgb(255 255 255 /.15)` |
| `--b3-button-active-shadow` | `0 2px 3px 1px rgb(0 0 0 / .3), 0 2px 4px 2px rgb(0 0 0 / .15)` | key 阴影改 `rgb(255 255 255 /.15)` |
| `--b3-tooltips-shadow` | `0 2px 8px rgba(0,0,0,.1)` | `0 2px 8px rgba(0,0,0,.5)` |
| `--b3-av-gallery-shadow` | `rgba(0,0,0,0.04) 0px 2px 4px 0px, var(--b3-border-color) 0px 0px 0px 1px` | 同亮色 |
button shadow 两条与 Material elevation-2 逐字一致，dialog shadow 与 Material elevation-24 一致（思源实际照抄了 Material 阴影梯度）。

### 2.3 动效（散落各处，无统一 token 数量）
`--b3-background-transition: background 20ms ease-in 0s`；`--b3-color-transition: color .2s cubic-bezier(0, 0, .2, 1) 0ms`；按钮 `transition: box-shadow 280ms ease`；弹窗遮罩 `opacity 150ms linear`；弹窗容器 `opacity 75ms linear, transform 150ms 0ms cubic-bezier(0, 0, .2, 1)`（Material standard curve）；图标 `transition: fill .15s ease-in-out`。弹窗结构：`max-width: 88vw`、`border: 1px solid var(--b3-theme-surface-lighter)`、header `padding: 9px 24px; line-height: 24px; font-size: 16px`。

### 2.4 字号与排版
UI `--b3-font-size: 14px`；次级文字大量写死 `12px`（`_main.scss`、`_dialog.scss`、`_card.scss`），卡片大数字 `36px`，对话框标题 `16px`。编辑器字号由内核配置注入：`kernel/conf/editor.go` 默认 `FontSize: 16`，前端拼 `--b3-font-size-editor: ${window.siyuan.config.editor.fontSize}px`。正文行高 `1.625`（`_typography.scss`）；标题阶梯 `1.75em / 1.55em / 1.38em / 1.25em / 1.13em / 1em`；代码块 `max-width: 620px`；`height: calc(var(--b3-font-size-editor) * 1.625)`。

### 2.5 编辑区写作栏宽（container query，`protyle/_protyle.scss`）
>760px：左右 padding 各 `96px`；>952px：`calc((100cqi - 760px) / 2)`——正文有效宽锁定 **760px** 居中；>2280px：`calc(100cqi * .382 / 1.382)`（黄金分割留白）。这是思源一手「measure」实现。

### 2.6 图标方案
`app/appearance/icons/litheness/icon.js` 为单 SVG sprite：`<symbol>` + `stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"`；`viewBox="0 0 24 24"` 出现 **231 次**（另有 `0 0 32 32` 6 次、`-2 -2 36 36` 12 次等特例）；`stroke-width="1.7"` 227 次（另有 1.5 5 次、1.75 1 次）。全局 `component/_svg.scss`：`svg { stroke-width: 0; stroke: currentColor }`。下拉箭头用 data-URI SVG（`--b3-select-background`，24×24，`fill='rgba(95, 99, 104, .68)'`，暗色 `rgba(154, 160, 166, .68)`）。

### 2.7 亮/暗主题差异
| 变量 | daylight | midnight |
| --- | --- | --- |
| `--b3-theme-background` | `#fff` | `#1e1e1e` |
| `--b3-theme-surface` | `#f6f6f6` | `#2c2c2c` |
| `--b3-body-background` | `#EBECF0` | `#2e3236` |
| `--b3-theme-on-background` | `#222` | `#dadada` |
| `--b3-theme-primary` | `#3575f0` | `#3575f0` |
| `--b3-theme-primary-light/lighter/lightest` | `rgba(53,117,240,.54/.38/.12)` | `rgba(53,117,240,.72/.48/.24)` |
| switch 选中色 | `var(--b3-theme-primary)` | `#a8c7fa`（粉彩蓝） |
| `--b3-mask-background` | `rgba(220,220,220,.4)` | `rgba(10,10,10,.4)` |
| 卡片 error/warning/info/success | `#f5d1cf / #ffe8c8 / #d6eaf9 / #d7eed8` | `#442724 / #554636 / #28405c / #425347` |

来源：https://github.com/siyuan-note/siyuan/blob/master/app/appearance/themes/daylight/theme.css 与 .../midnight/theme.css ｜https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/component/_button.scss 、_dialog.scss、_typography.scss、_svg.scss ｜https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/protyle/_protyle.scss ｜https://github.com/siyuan-note/siyuan/blob/master/app/appearance/icons/litheness/icon.js ｜https://github.com/siyuan-note/siyuan/blob/master/kernel/conf/editor.go 、https://github.com/siyuan-note/siyuan/blob/master/app/src/util/assets.ts

## 3. Typora（官方默认主题仓库 + 官方主题文档）

**结论速览**：写作列 = newsprint `40em`（≥1400px 时 914px）/ github `860px`（宽屏 1024 → 1200）；正文 16px、行高 1.5–1.6；「纸面」= html/body 直接铺底色（newsprint 是暖纸 `#f3f2ee` + 墨色 `#1f0909` + PT Serif）；面板/窗口靠一套官方主题变量着色；暗色侧栏比正文面**更深**。

### 3.1 `#write` 写作列
newsprint.css：`#write { max-width: 40em }`，`@media (min-width: 1400px) { #write { max-width: 914px } }`；被注释掉的旧方案是 `padding-left/right: calc(50% - 17em)`（34em 内容 + 居中），`@media (max-width: 36em)` 时 `padding: 1em`。github.css：`#write { max-width: 860px; padding: 30px; padding-bottom: 100px }`，宽屏 `@media` 依次 `max-width: 1024px`、`1200px`。

### 3.2 「纸面」怎么搭
官方中文文档「基本规则」第 2 条：默认字号必须放在 `html` 上、其余用 `rem`，否则偏好设置里的字号调节不生效。newsprint：`html, body { background-color: #f3f2ee; font-family: "PT Serif", 'Times New Roman', Times, serif; color: #1f0909; line-height: 1.5em }`，`html { font-size: 16px }`；标题 `h1 1.875em/1.6em`、`h2 1.3125em/1.15`、`h3 1.125em`、正文 `1em`、段落 `padding-bottom: .8125em`；行内代码 `font-size: .875em; line-height: 1.714285em`。github：`html { font-size: 16px }`、`body { color: rgb(51,51,51); line-height: 1.6 }`；`h1 2.25em/1.2`、`h2 1.75em/1.225`、`h3 1.5em/1.43`、`h4 1.25em`。

### 3.3 官方主题变量（窗口/面板入口）
亮色（github.css）：`--side-bar-bg-color: #fafafa`、`--control-text-color: #777`、`--item-hover-bg-color: #E6F0FE`。暗色（night.css）：`--bg-color: #363B40`、`--side-bar-bg-color: #2E3033`、`--text-color: #b8bfc6`、`--select-text-bg-color: #4a89dc`、`--item-hover-bg-color: #0a0d16`（后被覆盖为 `#70717d`）、`--control-text-color: #b7b7b7` / hover `#eee`、`--window-border: 1px solid #555`、`--active-file-bg-color: rgb(34,34,34)` / `--active-file-border-color: #8d8df0`、`--primary-color: #a3d5fe`（后被覆盖为 `#6dc1e7`）、`--rawblock-edit-panel-bd: #333`、`--search-select-bg-color: #428bca`。面板细节：night 下 `#typora-sidebar { box-shadow: none; border-right: none }`，`.mac-seamless-mode #typora-sidebar { background-color: var(--side-bar-bg-color) }`。

来源：https://github.com/typora/typora-default-themes/blob/master/themes/newsprint.css 、.../github.css 、.../night.css ｜官方文档：https://github.com/typora/theme.typora.io/blob/gh-pages/_posts/doc/2016-07-16-Write-Custom-Theme_zh.md

## 4. iA Writer / Ulysses（闭源，仅官方站点口径）

**标注：本节全为一手来源，但属产品/营销级表述，不含工程数字。**
Ulysses 官方首页原文：「a pleasant, focused writing experience」「distraction-free interface keeps you in the flow」「Work in a distraction-free environment and focus on writing.」「markup-based text editor」「no need to lift the fingers from the keyboard」。页面**没有**栏宽、每行字符数、字号、行高、主题/暗色的任何规格；仅页脚一个「Styles & Themes」链接。iA Writer 官方站点抓到的页面同样没有 measure 或居中栏宽声明；iA 官方文章《The Web Is All About Typography》与《In Search of the Perfect Writing Font》**均未**出现 45–75 或 65–75 字符的行长建议。因此「65–75 字符」**未找到一手来源**；业界可引用的一手数字只有 Windows 的 50–60 字符（见第 5 节）。

来源：https://ulysses.app/ ｜https://ia.net/writer ｜https://ia.net/topics/the-web-is-all-about-typography-period ｜https://ia.net/topics/in-search-of-the-perfect-writing-font ｜https://learn.microsoft.com/en-us/windows/apps/design/style/typography

## 5. Windows Fluent 2 / Windows 11（本机平台规范）

**结论速览**：圆角只有 8/4/0 三档（`ControlCornerRadius=4`、`OverlayCornerRadius=8`）；层级 = elevation 数值 + 恒定 1px stroke（Window/Dialog 128、Flyout 32、Tooltip 16、Card 8、Control 2、Layer 1），不是纯阴影；动效命名时长 250/167/83ms，进入 decelerate `cubic-bezier(0,0,0,1)`、退出 accelerate `cubic-bezier(1,0,1,1)`；字阶 12/16 → 68/92，最小 12px Regular / 14px Semibold。

### 5.1 圆角（Geometry in Windows 11）
| 圆角 | 用法（原文） |
| --- | --- |
| `8px` | Top-level containers such as app windows, flyouts and dialogs |
| `4px` | In-page elements such as buttons and list backplates |
| `0px` | Straight edges that intersect with other straight edges；窗口吸附/最大化不圆 |
补充：Rectangle 控件（Button/CheckBox/ComboBox/TextBox/ListView）4px；Flyout/overlay（ContentDialog、Flyout、MenuFlyout、TeachingTip）8px，**ToolTip 例外 4px**；bar 类（ProgressBar/ScrollBar/Slider）4px。全局资源 `ControlCornerRadius`（默认 4px）、`OverlayCornerRadius`（默认 8px）可在 App.xaml 覆盖。

### 5.2 Fluent 2 圆角/间距/描边 token（上游源码）
`borderRadius`：`None 0`、`Small 2`、`Medium 4`、`Large 6`、`XLarge 8`、`2XLarge 12`、`3XLarge 16`、`4XLarge 24`、`5XLarge 32`、`6XLarge 40`、`Circular 10000px`（px）。`spacing`：`none 0`、`xxs 2`、`xs 4`、`sNudge 6`、`s 8`、`mNudge 10`、`m 12`、`l 16`、`xl 20`、`xxl 24`、`xxxl 32`（px）。`strokeWidth`：`Thin 1px`、`Thick 2px`、`Thicker 3px`、`Thickest 4px`。

### 5.3 层级/阴影
| 元素 | Elevation 值 | Stroke width |
| --- | --- | --- |
| Window | 128 | 1 |
| Dialog | 128 | 1 |
| Flyout | 32 | 1 |
| Tooltip | 16 | 1 |
| Card | 8 | 1 |
| Control | 2 | 1 |
| Layer | 1 | 1 |
| 控件 Rest/Hover/Pressed | 2 / 2 / 1 | 1 |
官方原文：「Shadows and contour (outlines) are used on controls and surfaces to subtly communicate an object's elevation」「The intensity of the rendered shadow changes depending on the theme at parity of value」「Overusing shadows … can diminish their impact and create visual noise」。Fluent token 构造：`shadow2/4/8/16/28/64 = 0 0 2px <ambient>, 0 <N>px <N>px <key>`（N = 2/4/8/16/28/64），官方规范原文「shadow 2 has 2 pixel blur and shadow 64 has 64 pixel blur」；用途映射如 `$shadow28` = bottom sheet/side navigation/raised tab bars，`$shadow64` = 亮色 pop-up dialogs、暗色 panels。
| 阴影颜色 token | Light | Dark |
| --- | --- | --- |
| `colorNeutralShadowAmbient` | `rgba(0,0,0,0.12)` | `rgba(0,0,0,0.24)` |
| `colorNeutralShadowKey` | `rgba(0,0,0,0.14)` | `rgba(0,0,0,0.28)` |
| `...AmbientLighter / KeyLighter` | `0.06` / `0.07` | `0.12` / `0.14` |
| `...AmbientDarker / KeyDarker` | `0.20` / `0.24` | `0.40` / `0.48` |

### 5.4 动效 token
Fluent 2 duration：`UltraFast 50ms`、`Faster 100ms`、`Fast 150ms`、`Normal 200ms`、`Gentle 250ms`、`Slow 300ms`、`Slower 400ms`、`UltraSlow 500ms`。WinUI 3 控件时长：`ControlNormalAnimationDuration 250ms`、`ControlFastAnimationDuration 167ms`、`ControlFasterAnimationDuration 83ms`。
| Fluent 2 curve token | cubic-bezier | 官方用途 |
| --- | --- | --- |
| `curveAccelerateMax` | `cubic-bezier(0.9,0.1,1,0.2)` | 退出（强） |
| `curveAccelerateMid` | `cubic-bezier(1,0,1,1)` | 退出：对象离开场景 |
| `curveAccelerateMin` | `cubic-bezier(0.8,0,0.78,1)` | 退出（弱） |
| `curveDecelerateMax` | `cubic-bezier(0.1,0.9,0.2,1)` | 进入（强） |
| `curveDecelerateMid` | `cubic-bezier(0,0,0,1)` | 进入：对象/UI 进入场景 |
| `curveDecelerateMin` | `cubic-bezier(0.33,0,0.1,1)` | 进入（弱） |
| `curveEasyEaseMax` | `cubic-bezier(0.8,0,0.2,1)` | 场景内移动 |
| `curveEasyEase` | `cubic-bezier(0.33,0,0.67,1)` | 场景内移动 |
| `curveLinear` | `cubic-bezier(0,0,1,1)` | 匀速（如旋转） |
Learn 原文规则：「Fast Out, Slow In」= `cubic-bezier(0, 0, 0, 1)`「Use for objects or UI entering the scene」；「Slow Out, Fast In」= `cubic-bezier(1, 0, 1, 1)`「Use for UI or objects that are exiting the scene」。Fluent 2 motion 页另有：「Give larger elements more time to animate than smaller elements」；场景四类 Enter and exit / Elevation / Top level / Container transform；无障碍要求提供 "no motion" 设置（WCAG）。

### 5.5 字号层级
Windows 11 type ramp（Weight / Size/line height，单位 epx）：
| 样式 | 字重 | 字号/行高 |
| --- | --- | --- |
| Caption | Small | 12/16 |
| Body | Text（Regular） | 14/20 |
| Body strong | Text semibold | 14/20 |
| Body large | Text | 18/24 |
| Body large strong | Text semibold | 18/24 |
| Subtitle | Display semibold | 20/28 |
| Title | Display semibold | 28/36 |
| Title large | Display semibold | 40/52 |
| Display | Display semibold | 68/92 |
官方限制原文：「Minimum values: 14px Semibold, 12px Regular. Text smaller than these sizes and weights are illegible in some languages」「Bold and Italic styles are not part of the Windows type ramp. Use Semibold instead of Bold for emphasis」。字体 Segoe UI Variable 两轴 `wght` 100–700、`opsz` 自动（8pt–36pt 光学缩放）；中文字体表明确写「Microsoft YaHei UI（Regular, Bold, Light）= User-interface font for Simplified Chinese」。
Fluent 2 typography token：`caption2 10/14`、`caption1 12/16`（400/600 两档）、`body1 14/20`（400/600/700）、`body2 16/22`、`subtitle2 16/22`(600)、`subtitle1 20/28`(600)、`title3 24/32`(600)、`title2 28/36`(600)、`title1 32/40`(600)、`largeTitle 40/52`(600)、`display 68/92`(600)。字重 token `Regular 400`、`Medium 500`、`Semibold 600`、`Bold 700`；基础字体栈 `'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, Roboto, 'Helvetica Neue', sans-serif`。

### 5.6 色彩/材质（暗色适配）
Learn 原文：「In both light and dark color modes, darker colors indicate background surfaces of less importance. Important surfaces are highlighted with lighter and brighter colors.」Fluent 中性背景：Light `#ffffff / #fafafa / #f5f5f5 / #f0f0f0 / #ebebeb / #e6e6e6`；Dark `#292929 / #1f1f1f / #141414 / #0a0a0a / #000000 / #333333`（`colorNeutralBackground1..6`）。Fluent 2 color 原文：「Use lighter neutrals on surfaces to highlight areas of primary focus and create a sense of hierarchy」「In dark mode, the colors of the shared palette shift in saturation and brightness to reduce eye strain」。材质：Mica（不透明、随壁纸着色、mode aware、自带 active/inactive）、Acrylic（半透明磨砂，仅瞬时表面，mode aware）、Smoke（模态遮罩，**always translucent black in both light and dark mode**）。

来源：https://learn.microsoft.com/en-us/windows/apps/design/style/rounded-corner ｜.../design/motion/timing-and-easing ｜.../design/style/typography ｜.../design/signature-experiences/layering 、/color 、/materials ｜https://fluent2.microsoft.design/elevation 、/color 、/motion ｜https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/borderRadius.ts 、spacings.ts、strokeWidths.ts、durations.ts、curves.ts、fonts.ts、typographyStyles.ts ｜.../tokens/src/utils/shadows.ts ｜.../tokens/src/alias/darkColor.ts 、lightColor.ts

## 6. Material 3 动效（交叉验证）

来源为 AndroidX Compose Material3 token 定义（M3 规范的落地实现，一手）；m3.material.io 与 m2.material.io 正文为 JS 渲染，抓不到。
时长（ms）：`Short1..4 = 50/100/150/200`；`Medium1..4 = 250/300/350/400`；`Long1..4 = 450/500/550/600`；`ExtraLong1..4 = 700/800/900/1000`。
曲线：`EasingEmphasized (0.2, 0.0, 0.0, 1.0)`、`EasingEmphasizedAccelerate (0.3, 0.0, 0.8, 0.15)`、`EasingEmphasizedDecelerate (0.05, 0.7, 0.1, 1.0)`、`EasingStandard (0.2, 0.0, 0.0, 1.0)`、`EasingStandardAccelerate (0.3, 0.0, 1.0, 1.0)`、`EasingStandardDecelerate (0.0, 0.0, 0.0, 1.0)`、`EasingLegacy (0.4, 0.0, 0.2, 1.0)`、`EasingLegacyAccelerate (0.4, 0.0, 1.0, 1.0)`、`EasingLegacyDecelerate (0.0, 0.0, 0.2, 1.0)`、`EasingLinear (0.0, 0.0, 1.0, 1.0)`。注意当前 token 版本里 `EasingStandard` 与 `EasingEmphasized` 数值相同（0.2,0,0,1），区分靠 `EmphasizedAccelerate/Decelerate`；旧版规范的 standard = (0.4,0,0.2,1)（现标记为 `Legacy`）——**两份来源不一致，引用须注明版本**。
高度：`Level0..5 = 0/1/3/6/8/12 dp`（M3 用 surface tint 表达高度，见第 8 节）。

来源：https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/MotionTokens.kt ｜同目录 ElevationTokens.kt ｜（抓不到正文，仅存在性引用）https://m3.material.io/styles/motion/easing-and-duration/tokens-specs

## 7. 可用于 React 的图标库

**结论速览**：Lucide / Tabler 都是「24×24 网格 + 2px 描边」；Phosphor 用 6 个字重（含 thin/light）替代描边调节；Material Symbols 是可变字体而非逐图标组件。
| 维度 | Lucide | Tabler | Phosphor | Material Symbols |
| --- | --- | --- | --- | --- |
| 网格 | 24×24（规范强制） | 24×24 | 自绘图标要求 256×256 | 文档可抓页未给网格尺寸（未找到一手数字）；默认 opsz 24 |
| 默认描边 | 2px（规范强制，不许混用粗细） | 2px | 无描边概念（填充路径，6 字重） | 可变字体 `wght` 100–700 |
| 可调描边 | `strokeWidth` 任意值；`nonScalingStroke` 使描边不随尺寸缩放 | React `stroke` prop，默认 2（仅 outline） | `weight` 切 thin/light/regular/bold/fill/duotone | `wght` 100–700；`GRAD` -50–200 微调粗细 |
| 尺寸 | 默认 24px；`size` prop / CSS | 默认 24；`size` prop | `size: number｜string`，默认由 `IconContext` 设 | 字体字号；`opsz` 轴 20–48 |
| 其它轴 | — | — | `duotone` 背景层 20% 不透明度 | `FILL` 0–1、`ROND` 0–100 |
| License | ISC（Feather 来源部分 MIT） | MIT | MIT | Apache 2.0 |
| React 包 | `lucide-react` | `@tabler/icons-react` | `@phosphor-icons/react`（官方说明由 `phosphor-react` 迁移） | 官方为可变字体，无官方逐图标 React 组件 |
| Tree-shaking | 文档示例均为具名导入 | 分 outline/filled 两套包 | README 明示 supports tree-shaking，并建议按文件路径导入 | 不适用；官文提到默认设置加载 3,800+ 图标 |
各库细节：Lucide 规范 4 条硬规则——24×24 canvas、≥1px safe zone、描边必须 2px 且不许混用、必须 round line joins；尺寸文档「By default, the size of all icons is 24px by 24px」；描边文档「These have a default stroke width of 2px」并给 `nonScalingStroke`：「when `nonScalingStroke` is enabled and the `size` of the icons is set to 48px the `strokeWidth` will still be 2px on the screen」——默认行为是描边随尺寸等比缩放（16px 渲染时 2px 描边实际约 1.33px、18px 时约 1.5px；这两个为等比推算，非来源原话）。Tabler README 原文：「A set of 6,184 free, MIT-licensed, high-quality SVG icons … Each icon is designed on a 24x24 grid with a 2px stroke.」（outline 5,130 + filled 1,054）；`@tabler/icons-react` props 表 `size` 默认 `24`、`color` 默认 `currentColor`、`stroke` 默认 `2`。Phosphor：`weight` 可选 `"thin" | "light" | "regular" | "bold" | "fill" | "duotone"`，duotone 背景层 20% 不透明度，自绘图标「design your icons on a 256x256 pixel grid」。Material Symbols：官方 CSS API 轴定义 `...:opsz,wght,FILL,GRAD,ROND@20..48,100..700,0..1,-50..200,0..100`；官方文档（本次抓其 zh 镜像）原文「默认的静态字体（粗细 400、光学尺寸 24、圆角 50、等级 0、填充 0）」。细线/中文字重可用范围（客观项）：仅 Phosphor 官方提供独立 thin/light 字重；Lucide/Tabler 靠改 `strokeWidth`/`stroke`（官方允许任意值）；Material Symbols 靠 `wght`（100–700）与 `GRAD`。「哪个更适中文细线编辑感」属主观判断，本文件不裁决。

来源：https://github.com/lucide-icons/lucide/blob/main/docs/contribute/icons/design-principles.md ｜.../docs/guide/react/basics/sizing.md、stroke-width.md ｜.../LICENSE ｜https://github.com/tabler/tabler-icons/blob/main/README.md 、packages/icons-react/README.md ｜https://github.com/phosphor-icons/react/blob/master/README.md 、LICENSE ｜https://github.com/phosphor-icons/core/blob/main/README.md ｜https://developers.google.com/fonts/docs/material_symbols（经 zh 镜像 https://developers.google.cn/fonts/docs/material_symbols 抓取）｜https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD,ROND@20..48,100..700,0..1,-50..200,0..100 ｜https://github.com/google/material-design-icons/blob/master/LICENSE

## 8. 暗色模式下的「纸质/阅读表面」适配策略

**结论**：可抓到的四家一手来源指向同三件事——(1) 抬表面亮度而非加阴影；(2) 强化边界（1px 描边 / 内嵌高光 / 更深的阴影 alpha）；(3) 强调色降饱和或换粉彩。逐条数字：

### 8.1 Windows / Fluent
「darker colors indicate background surfaces of less importance. Important surfaces are highlighted with lighter and brighter colors.」每个 elevation 层级恒定 `Stroke width: 1`，且「The intensity of the rendered shadow changes depending on the theme at parity of value」（Fluent token 表现为 dark alpha 0.24/0.28 vs light 0.12/0.14）。表面色阶：Light `#ffffff → #e6e6e6`（1→6 渐深），Dark `#292929 → #000000`（1→5 渐深，6 为 `#333333`）——暗色下「更亮 = 更靠前」。「In dark mode, the colors of the shared palette shift in saturation and brightness to reduce eye strain」。Mica 不透明 mode-aware；Acrylic 仅瞬时表面；Smoke 两模式恒为半透明黑。

### 8.2 Material 3：surface container 阶 + surface tint，而非阴影
| token | Dark | Light |
| --- | --- | --- |
| `Surface` | `#141218`（Neutral6, rgb 20,18,24） | `#FEF7FF`（Neutral98, rgb 254,247,255） |
| `SurfaceContainerLowest` | `#0F0D13`（Neutral4） | `#FFFFFF`（Neutral100） |
| `SurfaceContainerLow` | `#1D1B20`（Neutral10） | `#F7F2FA`（Neutral96） |
| `SurfaceContainer` | `#211F26`（Neutral12） | `#F3EDF7`（Neutral94） |
| `SurfaceContainerHigh` | `#2B2930`（Neutral17） | `#ECE6F0`（Neutral92） |
| `SurfaceContainerHighest` | `#36343B`（Neutral22） | （对应更浅档） |
| `SurfaceBright` | `#3B383E`（Neutral24） | `#FEF7FF`（Neutral98） |
| `SurfaceDim` | `#141218`（Neutral6） | `#DED8E1`（Neutral87） |
暗色表面 `#141218 → #36343B` **带轻微紫红偏色**（primary 派生 neutral），非纯灰；`SurfaceTint = Primary`（官方用 surface tint 表达高度，不叠阴影）。亮色 `#FEF7FF → #ECE6F0` 渐深，暗色 `#141218 → #36343B` 渐亮。

### 8.3 Obsidian：base 色阶整体翻转（见 1.7）
`--color-base-00`（`#ffffff` ↔ `#1c1c1c`）与 `--color-base-20`（`#f6f6f6` ↔ `#282828`）：亮色次级表面比主表面**暗**，暗色次级表面比主表面**亮**，同一变量名两套方向。扩展色暗色统一提亮（`--color-red #e93147 → #fb464c`）。阴影数值未公开（见 1.6）。

### 8.4 SiYuan：内嵌白色高光 + 1px 外描边替代阴影，主色粉彩化
`--b3-point-shadow` 亮→暗：纯黑双层投影 → `inset 0 .5px .5px .5px rgba(255,255,255,.12), 0 3px 8px rgba(0,0,0,.3)`；`--b3-dialog-shadow`：`0 8px 24px rgba(0,0,0,.2)` → `0 8px 24px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.12)`（alpha ×4 + 白描边）；switch 选中色 `var(--b3-theme-primary)` → `#a8c7fa`；表面三级变亮 `#1e1e1e`（背景）→ `#2c2c2c`（面板）→ body 底 `#2e3236`。

### 8.5 Typora：暗色「纸」不做纯黑，侧栏比正文面更深
night.css：`--bg-color: #363B40`（偏暖深灰）、`--text-color: #b8bfc6`（非纯白）、`--side-bar-bg-color: #2E3033`（**比正文面更深**，与 Obsidian/Windows 方向相反）、`--window-border: 1px solid #555`（1px 描边替代阴影）、`#typora-sidebar { box-shadow: none; border-right: none }`。

### 8.6 未找到一手来源
Notion 无公开设计规范/变量文档；Apple HIG「Dark Mode」与 Material 2 dark theme 页面为 JS 渲染，本次取不到正文（故不引用常被转述的 `#121212`、elevation overlay 百分比等值）；iA Writer / Ulysses 无暗色主题公开规格。

来源：https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color 、/layering 、/materials ｜https://fluent2.microsoft.design/color ｜https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/alias/darkColor.ts 、lightColor.ts ｜https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ColorDarkTokens.kt 、ColorLightTokens.kt、PaletteTokens.kt ｜https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Colors.md ｜https://github.com/siyuan-note/siyuan/blob/master/app/appearance/themes/midnight/theme.css ｜https://github.com/typora/typora-default-themes/blob/master/themes/night.css

## 汇总：可引用的硬数字

### 间距
- Obsidian 4px 网格 `--size-4-1..18 = 4/8/12/16/20/24/32/36/48/64/72px`（不连续），2px 细网格 `2/4/6px`（https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Spacing.md）
- Fluent 2 spacing token `0/2/4/6/8/10/12/16/20/24/32px`（https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/spacings.ts）
- SiYuan 布局基元 `--b3-layout-space: 4px`（负 margin `-4px`）（https://github.com/siyuan-note/siyuan/blob/master/app/appearance/themes/daylight/theme.css）
- Typora 正文 padding `30px`、`padding-bottom: 100px`（https://github.com/typora/typora-default-themes/blob/master/themes/github.css）
- Windows 全部 elevation 层级统一 `Stroke width: 1`；Obsidian 仅 `--border-width: 1px`（https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/layering）

### 圆角
- Obsidian `--radius-s/m/l/xl = 4/8/12/16px`（https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Radiuses.md）
- Windows 11：窗口/flyout/dialog `8px`、页内控件与 bars `4px`、直边相交 `0px`，ToolTip 例外 `4px`；`ControlCornerRadius=4px`、`OverlayCornerRadius=8px`（https://learn.microsoft.com/en-us/windows/apps/design/style/rounded-corner）
- Fluent 2 `Small 2 / Medium 4 / Large 6 / XLarge 8 / 2XLarge 12 / 3XLarge 16 / 4XLarge 24 / Circular 10000px`（https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/borderRadius.ts）
- SiYuan `--b3-border-radius-s = 3px`、`--b3-border-radius = 6px`、`--b3-border-radius-b = 12px`（弹窗专用）（https://github.com/siyuan-note/siyuan/blob/master/app/appearance/themes/daylight/theme.css）

### 阴影层次
- Windows elevation：Window/Dialog `128`、Flyout `32`、Tooltip `16`、Card `8`、Control `2`（Pressed 降到 `1`）、Layer `1`，全部 1px stroke（https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/layering）
- Fluent 阴影 `0 0 2px ambient, 0 Npx Npx key`（N = 2/4/8/16/28/64），"shadow 2 has 2 pixel blur and shadow 64 has 64 pixel blur"（https://fluent2.microsoft.design/elevation）
- Fluent 阴影 alpha：Light `rgba(0,0,0,.12)/.14`，Dark `rgba(0,0,0,.24)/.28`（https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/alias/darkColor.ts）
- SiYuan 弹窗 `0 8px 24px rgba(0,0,0,.2)`、按钮 `0 1px 2px 0 rgb(0 0 0/.3), 0 1px 3px 1px rgb(0 0 0/.15)`；暗色弹窗 `0 8px 24px rgba(0,0,0,.8), 0 0 0 1px rgba(255,255,255,.12)`（https://github.com/siyuan-note/siyuan/blob/master/app/appearance/themes/midnight/theme.css）
- Material 高度 `Level0..5 = 0/1/3/6/8/12dp`（https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/ElevationTokens.kt）
- Obsidian `--shadow-*` 数值**未找到一手来源**（https://docs.obsidian.md/Reference/CSS+variables/CSS+variables）

### 动效
- Fluent 2 duration `UltraFast 50 / Faster 100 / Fast 150 / Normal 200 / Gentle 250 / Slow 300 / Slower 400 / UltraSlow 500ms`（https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/durations.ts）
- WinUI 3 控件时长 `250ms / 167ms / 83ms`（https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing）
- Windows 进入 `cubic-bezier(0,0,0,1)`、退出 `cubic-bezier(1,0,1,1)`（https://learn.microsoft.com/en-us/windows/apps/design/motion/timing-and-easing）
- Fluent 2 curve `accelerateMid (1,0,1,1)`、`decelerateMid (0,0,0,1)`、`easyEase (0.33,0,0.67,1)`、`easyEaseMax (0.8,0,0.2,1)`、`linear (0,0,1,1)`（https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/curves.ts）
- Material 3 duration `Short1..4 = 50/100/150/200`、`Medium1..4 = 250/300/350/400`、`Long1..4 = 450/500/550/600`、`ExtraLong1..4 = 700/800/900/1000ms`（https://github.com/androidx/androidx/blob/androidx-main/compose/material3/material3/src/commonMain/kotlin/androidx/compose/material3/tokens/MotionTokens.kt）
- Material 3 easing `Emphasized (0.2,0,0,1)`、`EmphasizedAccelerate (0.3,0,0.8,0.15)`、`EmphasizedDecelerate (0.05,0.7,0.1,1)`、`StandardDecelerate (0,0,0,1)`（同上 MotionTokens.kt）
- Obsidian 动效（二手）`70 / 140 / 300 / 560ms`，`smooth (0.45,0.05,0.55,0.95)`、`swing (0,0.55,0.45,1)`（https://github.com/aidenlx/zotlit/blob/main/.agents/skills/obsidian-css/references/foundations.md）
- SiYuan 按钮 `box-shadow 280ms ease`、弹窗 `transform 150ms 0ms cubic-bezier(0,0,.2,1)`、遮罩 `opacity 150ms linear`、背景 `20ms ease-in`（https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/component/_dialog.scss）

### 图标
- Obsidian `14px/2px`、`16px/2px`、`18px/1.75px`、`32px/1.25px`；图标库直接用 Lucide（https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Icons.md）
- Lucide 24×24、≥1px safe zone、强制 2px 描边、round joins；默认渲染 24px；`nonScalingStroke` 使 48px 时仍屏幕 2px；ISC（Feather 部分 MIT）（https://github.com/lucide-icons/lucide/blob/main/docs/contribute/icons/design-principles.md）
- Tabler 6,184 图标（outline 5,130 / filled 1,054）、24×24、2px、MIT；`size` 默认 24、`stroke` 默认 2（https://github.com/tabler/tabler-icons/blob/main/README.md）
- Phosphor 6 字重 `thin/light/regular/bold/fill/duotone`；duotone 背景层 20% 不透明度；自绘 256×256；MIT；官方声明 tree-shaking（https://github.com/phosphor-icons/react/blob/master/README.md）
- Material Symbols `opsz 20..48`、`wght 100..700`、`FILL 0..1`、`GRAD -50..200`、`ROND 0..100`；默认「粗细 400、光学尺寸 24、圆角 50、等级 0、填充 0」；Apache 2.0；字体分发（https://developers.google.com/fonts/docs/material_symbols）
- SiYuan 自绘 sprite：231 个 symbol 用 `viewBox="0 0 24 24"`，`stroke-width="1.7"`（227 次），round caps/joins（https://github.com/siyuan-note/siyuan/blob/master/app/appearance/icons/litheness/icon.js）

### 字号层级
- Obsidian UI 固定 `12/13/15/20px`，编辑正文 `16px`，行高仅 `1.5`/`1.3`（https://raw.githubusercontent.com/obsidianmd/obsidian-developer-docs/main/en/Reference/CSS%20variables/Foundations/Typography.md）
- Windows type ramp `12/16`、`14/20`、`18/24`、`20/28`、`28/36`、`40/52`、`68/92`；最小 12px Regular / 14px Semibold；中文用 Microsoft YaHei UI（https://learn.microsoft.com/en-us/windows/apps/design/style/typography）
- Fluent 2 `caption2 10/14`、`caption1 12/16`、`body1 14/20`、`body2 16/22`、`subtitle1 20/28`、`title3 24/32`、`title2 28/36`、`title1 32/40`、`largeTitle 40/52`、`display 68/92`；字重 400/500/600/700（https://github.com/microsoft/fluentui/blob/master/packages/tokens/src/global/fonts.ts）
- 正文行高：Obsidian `1.5`、Typora github `1.6`、Typora newsprint `1.5em`、SiYuan `1.625`（https://github.com/siyuan-note/siyuan/blob/master/app/src/assets/scss/component/_typography.scss）
- 写作列宽：Typora newsprint `40em`（≥1400px 窗口 `914px`）、Typora github `860px`、SiYuan 正文有效宽 `760px`（container query `(100cqi - 760px) / 2` 居中）（https://github.com/typora/typora-default-themes/blob/master/themes/newsprint.css）
- 每行字符数：Windows「Keep to 50–60 letters per line」，上下限 20–60；iA Writer / Ulysses 的「65–75 字符」**未找到一手来源**（https://learn.microsoft.com/en-us/windows/apps/design/style/typography）
