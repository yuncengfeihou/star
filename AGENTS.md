# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 SillyTavern 扩展插件，名为"聊天收藏器"（Star）。用户可以收藏聊天消息并管理这些收藏。当前版本 v2.2.0。

## 设计哲学

1. **职责分离** - 每个模块专注于单一职责，core.js 处理业务逻辑，api.js 处理数据交互，ui/ 处理展示
2. **渐进增强** - 当前聊天数据立即加载显示，其他聊天数据异步后台加载
3. **状态驱动** - UI 渲染基于 `state` 对象，而非直接读取 DOM
4. **样式隔离** - 所有样式使用 `star` 前缀，避免污染 SillyTavern 宿主环境
5. **用户体验优先** - 支持长按、快捷键、预览模式、截图等便捷操作

## 代码架构

模块化架构，职责分离：

- **index.js** - 主入口，初始化插件，绑定 SillyTavern 核心事件监听器，内联收藏按钮模板
- **state.js** - 全局状态和插件设置管理
- **Logger.js** - 统一日志管理，支持日志级别、内存历史与导出
- **core.js** - 收藏的增删改查核心逻辑（直接读写 `msg.swipe_info.star_favorite`）
- **api.js** - 后端 API 交互（聊天数据获取、元数据保存、更新检查、跨角色扫描）
- **worker.js** - Web Worker（压缩版），截图时并行下载图片/字体资源，避免阻塞主线程
- **ui/** - UI 层模块化目录（10 个模块，见下方 UI 层架构）
- **style.css** - 完整样式（3042 行），使用 CSS 变量支持亮/暗主题
- **input_button.html** - 收藏按钮入口模板（用于注册进魔法棒面板）
- **update.html** - 更新通知内容模板
- **settings_display.html** - 占位空文件
- **lib/** - 第三方库
  - **modern-screenshot.js** - 截图库本地副本（CDN 兜底：unpkg 4.7.0）
  - **modern-screenshot-4.7.0/** - 该库完整源码仓库（开发参考用）

## 关键设计概念

### 数据存储
收藏数据**直接写入 ST 原生 `message.swipe_info[swipeId].star_favorite`**（而非 `chatMetadata.favorites`，后者仅作为 UI 层的虚拟缓存）。这样 ST 删除 swipe 时收藏会随之清理。每个 swipe 项结构：
```javascript
{
    id: uuid,
    note: string,
    create_date: number   // Date.now()
}
```

UI 层通过 `buildVirtualFavorites(messages)` 从消息数组动态构建虚拟收藏数组（同一条消息可收藏多个 swipe）：
```javascript
{
    id: uuid,
    messageId: string,          // 消息在聊天数组中的索引（String 形式）
    sender: string,
    role: 'user' | 'character',
    note: string,
    favoritedSwipes: [...],     // 该消息下所有已收藏的 swipe
    currentSwipeViewIndex: 0
}
```

### 缓存机制
- `state.allChatsFavoritesData` 缓存多个聊天的收藏数据。当前聊天数据来自 `getContext()`，其他聊天通过 API 异步加载。
- **字体/图片三级缓存**（截图子系统）：L1 内存 Map + L2 IndexedDB（跨会话持久化）+ Web Worker 并行下载，见 `ui/font-subset.js`。

### 事件驱动
监听 SillyTavern 核心事件：
- `CHAT_CHANGED` - 切换聊天时退出预览、取消后台加载、更新收藏图标
- `MESSAGE_DELETED` - 删除消息时同步删除收藏
- `MESSAGE_RECEIVED/SENT` - 新消息时添加收藏图标
- `MESSAGE_SWIPED/UPDATED` - 刷新收藏状态
- `MORE_MESSAGES_LOADED` - 历史消息加载后补图标
- 另有 MutationObserver 监听聊天区 DOM 变化，新增节点时补收藏图标

### 主题系统
通过 `data-star-theme` 属性切换亮/暗模式，主题偏好存储在 `extension_settings[PLUGIN_NAME].theme`。CSS 变量定义所有颜色。

### 预览模式
可临时在主聊天界面查看历史消息上下文。状态通过 `state.isPreviewingContext` 追踪，收藏操作影响 `currentViewingChatFile` 而非当前聊天。

### 截图子系统
`ui/screenshot.js` + `ui/font-subset.js` + `worker.js` 协同：
- 关闭 modern-screenshot 库的字体嵌入（`font: false`），改由 `font-subset.js` 按本次截图文本逐字符匹配 `unicode-range`，只下载命中的少数子集字体文件，通过 `onCreateForeignObjectSvg` 注入 SVG（截图提速 7~8 倍）。
- 外链图片经 `customImageFetchFn` 三级缓存转 dataURL，跨域失败时回退占位图。
- 截图支持预览模式内的消息选择弹窗、多消息截图、Canvas 尺寸上限 14000。

### 角色切换器
`ui/character-switcher.js`：扫描所有角色/群组，列出「有收藏的角色」，点击切换收藏面板至该角色数据。扫描结果缓存在 `state.charactersWithFavorites`，增删收藏后置 `charactersCacheStale = true` 触发重新扫描。

### AI 答疑面板
`ui/qa.js`：浮动按钮 + 聊天式面板，支持流式传输、思维链折叠渲染、自定义 API（`qaApiEndpoint`/`qaApiKey`/`qaModel`）。

### 调试日志面板
`ui/debug.js`：浮动按钮 + 日志弹窗，读取 `Logger.logHistory`，支持级别筛选、下载、清空、主题适配。

### UI 层架构
UI 层采用模块化设计，各司其职：

- **main.js** - 核心面板渲染与主逻辑（模态框、侧栏、搜索过滤、分页、收藏项渲染、移动端操作菜单）
- **components.js** - 通用弹窗组件（确认/输入/文本/编辑器对话框），保持代码复用
- **preview.js** - 预览模式逻辑，包括进入/退出预览、上下文查看
- **settings.js** - 设置相关（主题切换、头像长按菜单、上下文范围/分页设置、使用指南、截图设置）
- **screenshot.js** - 截图功能（选择弹窗、多消息截图、元素截图）
- **font-subset.js** - 字体子集化（截图字体映射构建、IndexedDB 缓存、SVG 字体注入）
- **debug.js** - 调试日志面板
- **character-switcher.js** - 跨角色收藏切换器
- **qa.js** - AI 答疑面板
- **index.js** - 统一导出模块（Barrel File），简化导入路径

## 常用开发命令

无构建步骤。修改 JS 文件后刷新浏览器即可。

## 样式开发规范

1. **统一样式文件** - 所有样式统一写入 `style.css`（包括 `update.html` 的样式）
2. **颜色格式** - 统一使用 `RGBA` 格式
3. **样式隔离** - 所有 CSS ID/Class 必须使用 `star` 前缀，避免污染父网页样式
4. **显式属性定义** - 对于 `input`、`textarea`、`button` 等易被全局样式影响的元素，必须明确定义所有视觉属性
5. **主题系统** - 使用 CSS 变量定义颜色，通过 `data-star-theme` 属性切换亮/暗模式
6. **HTML 模板** - 优先使用 JavaScript 模板字符串内联 HTML；静态独立模板（如 `update.html`）是例外

```css
/* 正确示例 */
#favoritesModal .favorites-search-input {
    background-color: var(--star-bg-input) !important;
    color: var(--star-text-main) !important;
    border: 1px solid var(--star-border-input) !important;
    /* 明确定义所有属性 */
}
```

## 代码风格

1. **模块导入** - 使用 ES6 import，路径相对于 `extensions.js` 或 `script.js`
2. **UI 模块化** - UI 相关代码按功能拆分到 `ui/` 目录下各模块，通过 `ui/index.js` 统一导出
3. **HTML 模板** - 使用 JavaScript 模板字符串内联 HTML，避免单独的 HTML 文件
4. **错误处理** - 所有 API 调用必须包含 try-catch，使用 Logger 记录错误
5. **异步操作** - 使用 async/await 而非 Promise 链
6. **事件监听** - 动态创建的元素需使用事件委托或及时清理监听器
7. **中文注释** - 注释使用中文，说明"为什么"而非"做什么"

## 重要注意事项

1. **ID 处理** - 聊天文件名可能包含 `.jsonl` 后缀，需统一处理（`String(id).replace('.jsonl', '')`）
2. **预览模式** - 预览时收藏操作影响 `currentViewingChatFile`，非当前聊天
3. **长按事件** - 收藏图标支持长按编辑备注（600ms），需区分点击和长按
4. **iframe 渲染** - HTML 代码块通过 iframe 渲染，需桥接 window 函数
5. **设置持久化** - 所有插件设置（主题、调试面板状态、上下文查看模式、QA 配置等）统一存储在 `extension_settings[PLUGIN_NAME]` 中，修改后调用 `saveSettingsDebounced()`。**严禁使用 `localStorage` 存储任何插件数据**（截图字体/图片缓存使用 IndexedDB，属例外）。
6. **元数据保存** - 当前聊天使用 `saveMetadataDebounced()`，其他聊天使用 `saveSpecificChatMetadata()`
7. **HTML 模板** - 所有 HTML 使用 JavaScript 模板字符串内联，便于动态生成和维护
8. **后台任务取消** - 异步后台扫描/加载（角色扫描、其他聊天加载、图片下载）必须支持 `AbortController` 取消，用 `isAbortError()` 判断，切换聊天/角色时调用 `abortBackgroundLoad()` / `abortPreload()` 避免旧数据污染新上下文
9. **截图字体** - 修改截图相关逻辑时需了解 `font-subset.js` 的映射构建与缓存失效机制（`invalidateFontCaches`），字体文件变更后需清缓存才能生效
