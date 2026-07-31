# Note Calendar 更新说明

> 基于 Is-Ming/obsidian-note-calendar v1.0.1 修改
> 更新日期：2026-07-08
> 版本：1.0.1 → 1.1.0

---

## 修复的问题

### 1. 创建笔记时输入已有文件夹路径提示失败

**根因**：`createNote` 方法中 `currentPath += part + '/'` 导致路径带尾部斜杠，Obsidian API `getAbstractFileByPath()` 查询带斜杠路径返回 null，导致尝试重复创建已存在的文件夹而抛出异常。同时未调用 `normalizePath()`，Windows 反斜杠 `\` 不兼容。

**修复**：
- 从 `obsidian` 模块导入 `normalizePath` 函数
- 所有路径使用 `normalizePath()` 标准化（处理反斜杠、首尾斜杠等）
- 文件夹逐级创建时不带尾部斜杠

### 2. 创建笔记不调用日记模板

**根因**：`vault.create(filePath, '')` 创建空文件，完全绕过 Obsidian 核心"日记"插件的模板注入机制。

**修复**：
- 新增 `getTemplateContent(type, title)` 方法
- 模板来源优先级：插件设置 > 核心"日记"插件的 Template file location
- 支持模板变量替换：`{{date}}`、`{{date:FORMAT}}`、`{{time}}`、`{{time:FORMAT}}`、`{{title}}`
- 使用 `window.moment` 格式化日期
- 模板路径自动补全 `.md` 后缀
- 创建笔记后自动打开

### 3. 背景色改为白色

**修改**：CSS 变量调整

| 变量 | 原值 | 新值 |
|---|---|---|
| `--calendar-bg` | `#1e1e1e` | `#ffffff` |
| `--calendar-border` | `#3d3d3d` | `#e0e0e0` |
| `--calendar-text` | `#e0e0e0` | `#333333` |
| `--calendar-hover` | `#2d2d2d` | `#f5f5f5` |

同时修复"班"字标记和周末调休上班日期文字在白色背景上的可见性。

---

## 新增功能

### 1. 默认创建文件夹路径

在设置面板新增"默认创建文件夹路径"配置项（位于"日记模板文件路径"下方）。

- 设置后，创建笔记对话框中文件夹路径自动填充默认值
- 留空则默认为根目录
- 创建时可在对话框中手动修改，不影响设置里的默认值

### 2. 背景颜色可自定义

在设置面板新增"背景颜色"颜色选择器（位于"主题颜色"下方）。

- 操作方式与"周末颜色"、"主题颜色"一致
- 通过 CSS 变量 `--calendar-bg` 动态应用
- 默认值为白色 `#ffffff`

---

## 文件清单

| 文件 | 说明 |
|---|---|
| `main.js` | 核心逻辑（路径修复 + 模板支持 + 新增功能） |
| `styles.css` | 样式（白色背景 + CSS 变量调整） |
| `manifest.json` | 版本号更新至 1.1.0 |
| `lunar.js` | 未修改（原样保留） |

## 安装方法

1. 将本目录下的所有文件复制到 Obsidian Vault 的 `.obsidian/plugins/note-calendar/` 目录（覆盖旧文件，保留 `data.json`）
2. 重启 Obsidian
3. 在设置中确认 Note Calendar 插件已启用
4. 如有笔记文件夹路径配置，点击"重新扫描笔记"

## 致谢

- 原插件作者：[Is-Ming](https://github.com/Is-Ming)
- 原插件仓库：https://github.com/Is-Ming/obsidian-note-calendar
