# Note Calendar 更新说明

> 基于 Is-Ming/obsidian-note-calendar v1.0.1 修改
> 更新日期：2026-08-19
> 版本：1.1.0 → 1.2.0

---

## v1.2.0 更新内容（2026-08-19）

### 性能优化

#### 1. 全库扫描并行化
`scanNotes` 原来在循环里逐个 `await` 文件 stat（顺序 IO），且对每个文件输出日志。现改为 `Promise.all` 并行读取，大 vault 初始扫描显著提速。

#### 2. 增量文件索引（核心改动）
新增反向索引 `fileIndex`（`Map<path, {path, title, ctime, mtime}>`）。文件创建/修改/重命名/删除事件现在只增量更新单个文件：

- `create`/`modify` → `refreshFile(path)`：更新单文件的索引与日期缓存
- `rename` → `handleRename(old, new)`：复用旧条目的 ctime/mtime（重命名不改文件时间），用新路径重建条目，标题可靠刷新，绕开 stat 时序问题
- `delete` → `handleDelete(path)`：从索引与缓存移除

删除了原来每次事件都全库重扫的 `updateTodayNote`/`rescanDate`/`handleFileRename`，以及 500ms `setTimeout` 延迟。事件响应从 O(全库文件数) 降为 O(日期条目数)，且即时生效。

#### 3. 农历计算缓存
`getDayInfo(date)` 按 `YYYY-MM-DD` 缓存每日农历文本、农历/阳历节日、节气、调休、周末标记；`getMonthLunarInfo(year, month)` 缓存头部农历标题。lunar.js 相关方法均为纯函数，缓存安全（软上限 2000 条）。切换月份与重渲染不再重复调用 lunar.js。

### 新增功能

#### 键盘方向键导航
日历网格可聚焦（`tabIndex`）。聚焦后：
- `↑↓←→` 移动选中日期 ±7/±1 天，跨月自动切换视图
- `Enter` 打开选中日期的第一个笔记
- 点击日期后自动回焦网格，鼠标键盘可混用

### Bug 修复

| 问题 | 修复 |
|---|---|
| 文件夹前缀误匹配（"日记"误命中"日记本/x.md"） | 新增 `isPathInFolder`：路径 `normalizePath` 标准化后按 `folder + '/'` 精确前缀判断 |
| 两套周数算法（网格 ISO 8601 vs 周记标题变体），年末边界不一致 | 删除 `CalendarView.getWeekNumber`，统一用 `CalendarModel` 的 ISO 8601 实现 |
| 重命名笔记标题不更新 | `handleRename` 复用旧索引条目时间戳，直接以新路径重建，不依赖 stat |
| 设置文本/字号每敲一键就存盘+全量重渲染 | 新增 `debounce` 工具，文本输入 400ms、字号滑块 300ms 防抖 |
| 创建笔记后全库重扫 | 改为 `refreshFile` 增量刷新单文件 |

### 代码清理
- 移除全部 `console.log` 调试日志（约 30 处），保留 `console.error`
- 删除死代码 `createDayCell`；`createNotesList` 简化为空容器；抽取 `createNoteButtons` 消除重复
- 对话框内联样式迁入 CSS 类（`.nc-modal-*`）
- `var` 统一为 `const`；`main.js` 净减约 200 行

---

## v1.1.0 更新内容（2026-07-08）

### 修复的问题

#### 1. 创建笔记时输入已有文件夹路径提示失败

**根因**：`createNote` 方法中 `currentPath += part + '/'` 导致路径带尾部斜杠，Obsidian API `getAbstractFileByPath()` 查询带斜杠路径返回 null，导致尝试重复创建已存在的文件夹而抛出异常。同时未调用 `normalizePath()`，Windows 反斜杠 `\` 不兼容。

**修复**：
- 从 `obsidian` 模块导入 `normalizePath` 函数
- 所有路径使用 `normalizePath()` 标准化（处理反斜杠、首尾斜杠等）
- 文件夹逐级创建时不带尾部斜杠

#### 2. 创建笔记不调用日记模板

**根因**：`vault.create(filePath, '')` 创建空文件，完全绕过 Obsidian 核心"日记"插件的模板注入机制。

**修复**：
- 新增 `getTemplateContent(type, title)` 方法
- 模板来源优先级：插件设置 > 核心"日记"插件的 Template file location
- 支持模板变量替换：`{{date}}`、`{{date:FORMAT}}`、`{{time}}`、`{{time:FORMAT}}`、`{{title}}`
- 使用 `window.moment` 格式化日期
- 模板路径自动补全 `.md` 后缀
- 创建笔记后自动打开

#### 3. 背景色改为白色

**修改**：CSS 变量调整

| 变量 | 原值 | 新值 |
|---|---|---|
| `--calendar-bg` | `#1e1e1e` | `#ffffff` |
| `--calendar-border` | `#3d3d3d` | `#e0e0e0` |
| `--calendar-text` | `#e0e0e0` | `#333333` |
| `--calendar-hover` | `#2d2d2d` | `#f5f5f5` |

同时修复"班"字标记和周末调休上班日期文字在白色背景上的可见性。

---

### 新增功能

#### 1. 默认创建文件夹路径

在设置面板新增"默认创建文件夹路径"配置项（位于"日记模板文件路径"下方）。

- 设置后，创建笔记对话框中文件夹路径自动填充默认值
- 留空则默认为根目录
- 创建时可在对话框中手动修改，不影响设置里的默认值

#### 2. 背景颜色可自定义

在设置面板新增"背景颜色"颜色选择器（位于"主题颜色"下方）。

- 操作方式与"周末颜色"、"主题颜色"一致
- 通过 CSS 变量 `--calendar-bg` 动态应用
- 默认值为白色 `#ffffff`

---

### 文件清单

| 文件 | 说明 |
|---|---|
| `main.js` | 核心逻辑（路径修复 + 模板支持 + 新增功能） |
| `styles.css` | 样式（白色背景 + CSS 变量调整） |
| `manifest.json` | 版本号更新至 1.1.0 |
| `lunar.js` | 未修改（原样保留） |

### 安装方法

1. 将本目录下的所有文件复制到 Obsidian Vault 的 `.obsidian/plugins/note-calendar/` 目录（覆盖旧文件，保留 `data.json`）
2. 重启 Obsidian
3. 在设置中确认 Note Calendar 插件已启用
4. 如有笔记文件夹路径配置，点击"重新扫描笔记"

### 致谢

- 原插件作者：[Is-Ming](https://github.com/Is-Ming)
- 原插件仓库：https://github.com/Is-Ming/obsidian-note-calendar
