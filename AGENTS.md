# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个 SillyTavern 扩展插件，名为"聊天收藏器"（Star）。用户可以收藏聊天消息并管理这些收藏。
版本号以 `manifest.json` 为唯一事实来源（运行时读取，勿在别处手工同步）。

## 设计哲学

1. **职责分离** - 数据（`core.js` / `chat-data.js` / `scan.js`）与展示（`ui/`）分离，依赖方向单向：UI → 数据，反向协作一律走 `hooks.js` 的钩子/注册中心
2. **渐进增强** - 当前聊天数据立即显示，其他聊天异步后台加载
3. **状态驱动** - UI 渲染基于 `state` 对象，而非直接读取 DOM
4. **样式隔离** - 新增 CSS ID/Class 一律 `star-` 前缀，避免污染 SillyTavern 宿主环境
5. **按需加载** - 重 UI 模块（收藏面板/预览/设置/截图/字体子集化/AI 答疑）在交互发生时才动态导入
6. **用户体验优先** - 支持长按、快捷键、预览模式、截图等便捷操作

## 目录结构

```
star/
├── AGENTS.md              # 本文件（开发指南）
├── KNOWN_ISSUES.md        # 已知问题清单（未修复项，按优先级排序；修一条删一条）
├── README.md              # 面向使用者：功能、安装、开发命令
├── manifest.json          # 插件清单（version 为版本号唯一事实来源）
├── index.js               # 主入口：只做启动编排（各步骤委托给下列模块）
├── bootstrap/             # 启动期注册（全部轻量，不引入重 UI）
│   ├── entry-button.js    #   魔法棒面板内的「收藏」入口按钮
│   ├── floating-buttons.js#   常驻悬浮按钮（收藏面板/截图/结束预览）
│   ├── shortcuts.js       #   全局快捷键 Alt+S / Alt+F
│   └── chat-events.js     #   ST 事件 + 聊天区 DOM 监听 + 收藏图标交互
├── state.js               # 全局状态 + 设置 schema + getSetting/setSetting + findChatData
├── hooks.js               # 跨层钩子与「可取消后台任务」注册中心（零依赖）
├── Logger.js              # 统一日志（级别控制 + 内存历史 + 导出）
├── utils.js               # 通用纯函数（转义/文件名归一/版本比较/取消判断…，可单测）
├── domain.js              # 收藏领域纯逻辑（虚拟收藏构建/迁移/swipe 定位，可单测）
├── markdown.js            # 极简 Markdown → HTML 渲染器（可单测）
├── core.js                # 收藏增删改查 + 聊天区收藏图标同步
├── chat-data.js           # 聊天数据读取与落库（含保存重试）
├── scan.js                # 跨角色收藏扫描（角色切换器数据源）
├── update.js              # 更新检查与更新弹窗
├── migration.js           # 旧版收藏数据迁移引擎（纯逻辑在 domain.js）
├── worker.js              # modern-screenshot 的 Web Worker（第三方压缩产物）
├── style.css              # 全部样式（star 前缀 + CSS 变量主题）
├── update.html            # 更新公告内容模板
├── eslint.config.js       # ESLint 扁平配置（宿主全局已声明）
├── package.json           # 开发期工具链（check / lint / test / verify）
├── scripts/               # 开发脚本：语法门 + 版本号校验 + 样式作用域收敛
├── tests/                 # 纯函数单元测试（node --test）
├── lib/                   # 第三方库（升级说明见 lib/README.md）
└── ui/                    # UI 模块（见下方索引）
```

## UI 模块索引

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `modal-gateway.js` | 收藏面板懒加载网关（极轻，启动期可安全导入） | `openFavoritesModal` `closeFavoritesModal` `registerFavoritesModal` |
| `main.js` | 收藏面板：模态框、侧栏、搜索、标签筛选、分页、聊天列表、收藏项渲染、移动端菜单 | `openFavoritesModal` `renderFavoritesView` `switchToCharacter` `abortBackgroundLoad` |
| `favorite-icon.js` | 聊天区收藏图标点击切换（刻意保持轻量，不拉入面板依赖） | `handleFavoriteToggle` |
| `components.js` | 通用弹窗（确认/输入/文本/编辑器/标签）——叶子模块，可被数据层静态导入 | `showConfirmModal` `showInputModal` `showTextModal` `showEditorModal` `showTagsModal` |
| `preview.js` | 预览模式 + 上下文查看器 | `enterPreviewMode` `exitPreviewMode` `handleViewContext` |
| `iframes.js` | HTML 代码块 iframe 渲染（面板与预览共用，消除二者循环依赖） | `renderIframesInElement` |
| `scope.js` | 插件 UI 作用域名单（tooltip 接管范围与键盘激活共用） | `STAR_UI_SCOPE` `isInStarScope` |
| `a11y.js` | 键盘可达性：让 `role="button"` 图标支持 Enter/Space 激活 | `initA11y` |
| `settings.js` | 设置：头像长按菜单、上下文范围/分页、使用指南、截图设置 | `showAvatarLongPressMenu` |
| `theme.js` | 主题唯一事实来源（`documentElement` 上的 `data-star-theme`）+ 切换涟漪动效 | `applyTheme` `isDarkTheme` `toggleThemeAnimated` `THEME_CHANGED_EVENT` |
| `screenshot.js` | 截图：选择弹窗、多消息截图、元素截图 | `captureScreenshotMessages` `captureElementScreenshot` |
| `font-subset.js` | 字体子集化：接管截图字体处理，三级缓存，截图提速 7~8 倍 | `initFontSystem` `buildSvgFontCss` `customImageFetchFn` |
| `debug.js` | 调试日志面板 | `initDebugPanel` `toggleDebugPanel` |
| `character-switcher.js` | 跨角色收藏切换器（底部抽屉） | `openCharacterSwitcher` `preloadCharacterFavorites` |
| `qa.js` | AI 答疑面板（流式传输、自定义 API、思维链渲染） | `ensureQAStructure` `openQAPanel` |
| `migration.js` | 数据迁移 UI（确认弹窗 + 悬浮球 + 进度面板） | `showMigrationDialog` |

> 注：`ui/index.js`（barrel）已移除——在无打包器的项目里它会导致启动时全量解析所有 UI 模块，
> 且名称冲突会被静默丢弃。改为各调用点按路径导入，重模块走 `await import()`。
>
> 样式作用域：`style.css` 中所有历史通用类名（`fav-*` / `favorites-*` / `context-*` / `favorite-item` /
> `user-message` 等）已加容器前缀（`#favoritesModal` / `#context-messages-frame` / `#chat`），
> 类名本身未改（JS 查询不受影响）。详见「样式开发规范」。

## 核心模块职责

- **state.js**：`state` 运行时状态、`SETTINGS` 设置 schema、`getSetting/setSetting`（唯一读写入口）、
  `findChatData(fileName)`（缓存查找唯一入口）、`loadLocalVersion()`（从 manifest 读取版本号）。
- **hooks.js**：`getCoreHooks()`（数据层需要 UI 协作时的钩子）、`registerCanceller()` /
  `runCancellers()`（切换聊天时统一取消后台任务）。**数据层不得直接 import ui/**。
- **core.js**：收藏 CRUD + 图标同步。所有写操作统一走 `resolveWriteTarget()` 定位 →
  `mutateSwipeFavorite()` 修改 → `commitFavoriteWrite()` 重建缓存并落库这三步；新增写操作请复用这条链路，
  不要自己遍历 `swipe_info`（否则会漏掉缓存重建，表现为「删了还显示」）。
- **chat-data.js**：`getAllChatFavoritesForCurrentContext`（后台加载其他聊天）、`getFullChatData`、
  `saveSpecificChatMetadata`（**收藏唯一落库入口**，剥离虚拟 favorites、3 次指数退避重试）。
- **scan.js**：`scanAllCharactersForFavorites(onProgress, { signal, onFound })`，群组/角色统一处理。
- **bootstrap/chat-events.js**：ST 事件 + MutationObserver，DOM 相关回调统一 150ms 防抖。

## 关键设计概念

### 数据存储

收藏数据**直接写入 ST 原生 `message.swipe_info[swipeId].star_favorite`**（而非 `chatMetadata.favorites`，
后者仅作为 UI 层的虚拟缓存）。这样 ST 删除 swipe 时收藏会随之清理。每个 swipe 项结构：

```javascript
{
    id: uuid,
    note: string,
    tags: string[],        // 可选，老数据无此字段
    create_date: number    // Date.now()
}
```

UI 层通过 `buildVirtualFavorites(messages)`（在 `domain.js`）从消息数组动态构建虚拟收藏数组
（同一条消息可收藏多个 swipe）：

```javascript
{
    id: uuid,                   // 取「第一个」收藏的 swipe 的 id
    messageId: string,          // 消息在聊天数组中的索引（String 形式）
    sender: string,
    role: 'user' | 'character',
    note: string,
    favoritedSwipes: [...],     // 该消息下所有已收藏的 swipe（按 create_date 升序）
    currentSwipeViewIndex: 0
}
```

> 多 swipe 场景下卡片传入的 `favId` 是「当前查看的那个 swipe」的 id，
> 因此查找必须用 `findFavSwipesById(favorites, favId)`（按 favoritedSwipes 包含关系匹配），
> 不能用 `favorites.find(f => f.id === favId)`——后者会漏掉非首个 swipe。
>
> `currentSwipeViewIndex` 属于纯 UI 状态：任何重建虚拟收藏（写操作、保存落库、缓存失效）都必须经
> `preserveSwipeViewIndexes(newFavs, oldFavs)` 迁移位置，否则改备注/标签或落库后会跳回 1/N，
> 标签筛选依赖的索引快照也会还原错误。

**虚拟收藏数组必须写成不可枚举属性**（`domain.js` 的 `setVirtualFavorites`）。宿主 `saveChat()` 是
`const metadata = { ...chat_metadata }` 浅拷贝后整体序列化进 JSONL，只要这个纯 UI 缓存是可枚举的，
它就会被写进用户的聊天文件——每条收藏在文件里出现两份，其中一份还带 `currentSwipeViewIndex` 这类
纯 UI 字段，构成第二个不可信的事实来源（实测已复现）。
新增任何往 `chatMetadata` 上挂收藏数据的地方，都必须走 `setVirtualFavorites`；
`saveSpecificChatMetadata` 里把元数据深拷贝进缓存时，也要记得用 `setVirtualFavorites` 补回
（否则面板的「编辑备注/取消收藏」会因为 `cache.metadata.favorites` 丢失而定位不到收藏项）。

### 缓存机制与失效规则

| 缓存 | 键 / 存放位置 | 何时失效 |
|---|---|---|
| 虚拟收藏数组 | chat 数组引用 + 长度 + `chatMetadata` 引用（core.js 模块级变量） | **任何收藏写操作后必须调用 `rebuildVirtualFavoritesCache`**；面板首次打开传 `forceRebuild=true` |
| 多聊天收藏数据 | `state.allChatsFavoritesData`（按文件名索引） | 打开面板时重新加载；`favorites_updated_at` 未变化的聊天跳过（增量秒开） |
| 「核对为空」备忘 | `chat-data.js` 模块级 Set（键 = 角色/群组 + 文件名） | 会话级；`saveSpecificChatMetadata` 写入该聊天时撤销 |
| 待落库收藏补丁 | `core.js` 模块级 Map（键 = `消息索引:swipe索引[:消息指纹]`） | 成功落库后清空；切换聊天时用于重放到目标聊天文件 |
| 角色收藏索引 | `state.charactersWithFavorites` + `charactersCacheTimestamp` | TTL 10 分钟（`SCAN_CACHE_TTL`）；`charactersCacheStale` 仅作 UI 提示，不自动重扫 |
| 字体/图片 | 内存 Map + IndexedDB + Worker（`ui/font-subset.js`） | 设置 → 截图设置 → 缓存管理；字体文件变更需 `invalidateFontCaches()` |
| 更新检查 | `lastUpdateCheck` / `updateInfo` 设置项 | 24h 过期；强制检查传 `force=true` |

### 收藏索引与「有无收藏」的判定（易错）

「某个聊天有没有收藏」在侧栏（`getAllChatFavoritesForCurrentContext`）与角色切换器（`scan.js`）里
都靠 `chat_metadata.favorites_count` 预过滤——不查它就要把该角色所有聊天全量读一遍。三条硬约束：

1. **索引必须同时写进实时 `chatMetadata`**（`core.js` 的 `stampFavoritesIndex`）。
   SillyTavern 自己也会保存聊天（生成消息 / 切换 swipe / 切换角色），写的正是实时对象；
   只写「落库时的元数据副本」会让 ST 把文件里上一次的旧索引覆盖回去。
2. **条数以消息数组现算**，不能取调用方传入的 `metadata.favorites`（可能是过时的虚拟缓存）。
   历史上这两条同时踩中，写出过「消息里有 `star_favorite`、`favorites_count` 却是 0」的文件，
   而读取侧又无条件信任 `count === 0`，导致这些聊天的收藏在侧栏与切换器里彻底消失。
3. **`count === 0` 只在 `favorites_index_version === FAVORITES_INDEX_VERSION` 时才可信**；
   否则必须全量读取核对（核对为空的记入会话备忘，避免反复读取）。新增/修改索引字段时请一并升级版本号。

### 收藏写操作不能被「切换聊天 / 退出预览」吞掉（易错）

当前聊天的保存有 800ms 防抖，而以下操作会**丢弃内存里的 chat 数组**：

- ST 切换聊天：`openCharacterChat` / `openGroupChat` → `clearChat({clearData:true})`，**且不保存**；
- `exitPreviewMode()` / `handleEditMessageContent()` → `reloadCurrentChat()`，从文件重读 chat 与 chat_metadata。

因此：

- 任何会 reload 的路径，**必须先 `await flushPendingFavoriteSave()`**（`core.js`）再 reload，
  否则预览里的收藏/取消收藏会被文件内容覆盖（表现为「点了取消收藏，退出预览后依然收藏」）；
- 防抖期间被切换聊天时，靠 `commitFavoriteWrite` 记录的**待落库收藏补丁**兜底：
  `saveCurrentChatFavorites` 发现聊天已切换时会「重读目标聊天文件 + `applyFavoritePatch` 重放 + 落库」，
  而不是像 ST 原 `saveMetadataDebounced` 那样直接放弃（放弃会让「收藏后立刻切换聊天」永久丢失收藏）；
  - 补丁地址是「消息索引 + swipe 索引」，而**索引会随消息增删漂移**，所以
    `buildFavoritePatch(prev, next, messages)` 会把消息身份指纹编进补丁键
    （`消息索引:swipe索引:指纹`，指纹 = `send_date`+`name`+`is_user` 的 FNV-1a）。
    重放时指纹不符（原消息已被删）就整条跳过，绝不写到别的消息上；消息没有 `send_date`
    时退回旧键格式（宁可宽松，也不能因为取不到身份就丢收藏）。
  - `applyFavoritePatch` 还拒绝为「该消息上不存在的 swipe」凭空创建 `swipe_info` 槽位
    （唯一的例外是完全无 swipe 的消息，即用户消息，只允许 0 号槽）。
    新增补丁相关的调用点请一并传 `messages`，否则身份保护会静默失效。
- **同一聊天被 ST 重载**（点击聊天列表里的当前聊天、扩展调用 `reloadCurrentChat`）同样会丢弃内存改动。
  处理链：`CHAT_CHANGED` → `replayPendingFavoritePatchForCurrentChat()`（把补丁重放到刚加载的数组 +
  立即落库）；保存前 `saveCurrentChatFavorites` 会把待落库补丁重放到即将写盘的数组；若检测到
  `chat.length === 0` 而缓存里仍有消息（说明正处于 `clearChat → getChat` 之间），跳过本次写盘。
  `flushPendingFavoriteSave()` 还会等待已经启动的在途保存。新增「会丢弃内存改动」的调用点时别漏掉这条链。
- 新增收藏写操作时请沿用 `resolveWriteTarget`（非当前聊天且不在缓存时返回 `messagesArray = null`，
  各写操作据此拒绝本次修改，**不要**退化成写 `context.chat`，那会把当前聊天写进别的聊天文件）。
- **未显式指定目标时一律按当前聊天处理，禁止回退到 `state.currentViewingChatFile`**——那是收藏面板
  正在浏览的聊天（用过「切换角色」后可能属于别的角色），聊天区的操作按它定位会把收藏写进别的聊天文件
  （历史 bug：Alt+S 写串到另一个角色）。面板内的操作请显式传入 `state.currentViewingChatFile`。

### 星标状态必须按「当前 swipe」判定（易错）

星标点亮对应的是 `message.swipe_info[message.swipe_id].star_favorite`，不是「这条消息有没有收藏」。
按消息判定会在多 swipe 场景下说谎：图标显示已收藏、点下去却给当前 swipe **新增**一条收藏
（表现为「取消收藏没作用，消息反而多了一条收藏」——预览模式曾如此）。聊天区与预览模式必须同规则：
聊天区走 `refreshFavoriteIconsInView`，预览走 `enterPreviewMode` 里的同款判定。

### 消息被删除后要重算收藏索引（易错）

收藏存放在消息自身，消息一删收藏随之消失，`removeFavoriteById` 会找不到目标——此时不要直接 `return`，
否则实时 `favorites_count` 会停在删除前的值，ST 之后保存聊天就把它写进文件（「已无收藏却显示 1 条」）。
`bootstrap/chat-events.js` 的 `MESSAGE_DELETED` 处理器统一调用 `core.js` 的
`syncCurrentChatFavoritesIndex()` 重算并写回。

### 事件驱动

监听 SillyTavern 核心事件（见 `bootstrap/chat-events.js`）：

- `CHAT_CHANGED` - 退出预览、取消后台任务（`runCancellers`）、中止迁移、更新图标
- `MESSAGE_DELETED` - 同步删除收藏并重渲染面板
- `MESSAGE_RECEIVED/SENT` - 新消息时添加收藏图标
- `MESSAGE_SWIPED/UPDATED` - 定向刷新该消息的图标（不遍历整个 #chat）
- `MORE_MESSAGES_LOADED` - 历史消息加载后补图标
- MutationObserver 兜底 ST 自身重渲染导致的图标丢失（与事件同用 150ms 防抖）

### 主题系统

**唯一事实来源是 `<html>` 上的 `data-star-theme`**（由 `ui/theme.js` 的 `applyTheme()` 单点写入），
主题偏好经 `setSetting('theme', ...)` 持久化。`--star-*` 变量已命名空间隔离，写在根元素不会污染宿主，
所有插件组件（面板/预览/上下文查看器/答题/截图/调试/迁移/角色切换器/tooltip）直接继承。

- **不要**再往具体容器上写 `data-star-theme`：历史上需要在 8 个容器上分别同步，漏一处就是一块颜色不对的补丁；
  且逐容器同步会让「涟漪切换」无法成立——动效要求整屏在同一帧内换成新主题。
- **界面风格（skin）**：`<html data-star-skin>`（`classic` / `galgame`）由 `ui/theme.js` 的 `applySkin()` 单点写入，
  与主题一样只声明令牌在根元素。令牌块必须写成 `html[data-star-theme="dark"]`：面板对话框上还镜像着
  `data-star-theme`（供存量代码读 dataset），写成 `[data-star-theme="dark"]` 会让对话框重新声明整套暗色令牌、
  把根元素上的 skin 覆盖掉。
- **启动即应用**：`index.js` 在 `initSettings()` 之后调用 `applySavedTheme()`（主题 + 风格），
  这样更新公告、数据迁移等独立浮层在收藏面板打开之前也能拿到正确配色。
- **面板背景图**：入口在设置菜单的「外观与背景」（`ui/appearance.js`）。图片在浏览器内压缩到 1920px 以内后
  写入 IndexedDB（库 `star-appearance`），通过 `<html style="--star-user-bg:url(...)">` + `data-star-bg="on"`
  应用到面板；不写 `settings.json`、不上传。IDB 不可用时仅本次会话生效并明确提示。
  新增顶层浮层时要同步三处：`ui/scope.js`、`ui/main.js` 的 Esc 白名单、`style.css` 的无障碍名单
  （焦点环 / reduced-motion）。
- 主题由按钮触发时走 `toggleThemeAnimated(originEl)`：基于 View Transitions API，
  以被点击按钮的「底边中点」为圆心做 `clip-path: circle()` 扩散（从侧栏左下角铺满整个界面）。
  浏览器不支持或用户开启「减少动态效果」时静默降级为瞬时切换。
- 依赖「当前主题」的 UI 必须订阅 `THEME_CHANGED_EVENT`（`star:theme-changed`）而不是在调用处同步读取：
  主题是在 View Transition 的更新回调里才真正应用的，调用处读到的仍是旧主题。
- 切换期间 `<html>` 上会挂 `star-theme-switching`，用于冻结面板内的微过渡（否则同一段动画会跑两遍）。

### 按需加载与失败可见性（易错）

启动路径刻意轻量，重 UI 模块一律 `await import()`。这条链路有两个必须遵守的点：

1. **每个用户可见的懒加载入口都要 `try/catch` + 可见提示**。模块解析失败（部署不完整、改了导出名忘了同步）
   抛的是 Promise 拒绝，`await` 不捕获就只在控制台留一条错，用户看到的是「点了没反应」。
   涉及：`ui/modal-gateway.js` 的 `openFavoritesModal`、`bootstrap/entry-button.js`、
   `bootstrap/floating-buttons.js`、`bootstrap/shortcuts.js`、`bootstrap/chat-events.js`（收藏图标点击、CHAT_CHANGED 退出预览）、
   `ui/character-switcher.js`、`ui/qa.js`、`ui/preview.js` 的 `enterPreviewMode`。
2. **失败路径要把状态复位**，不能只提示：CHAT_CHANGED 里退出预览失败必须清 `isPreviewingContext`，
   否则插件永久停在「预览中」，Alt+S / Alt+F 等守卫全部失效。

### 预览模式（写目标易错）

可临时在主聊天界面查看历史消息上下文。状态由两个字段共同描述：

- `state.isPreviewingContext` —— 是否处于预览；
- `state.previewingChatFile` —— **被预览的是哪个聊天**（进入预览时记录，退出时清空）。

**聊天区**（`#chat` 里的星标点击、长按编辑备注）的写目标必须走
`state.resolveChatAreaTargetChatFile()`：预览时返回 `previewingChatFile`，否则返回 ST 当前聊天。
**绝不能用 `state.currentViewingChatFile`** —— 那是收藏面板正在浏览的聊天。预览期间用户仍可打开面板
并「切换角色」（`switchToCharacter` 不退出预览），而 `#chat` 里显示的还是被预览聊天的内容，
按面板变量定位就会把 `star_favorite` 写进**另一个角色的聊天文件**（实测可复现：A 的文件纹丝不动，
C 的文件多出一条收藏和错误的索引）。

区分两类调用点：

- **面板内的操作**（编辑备注/标签、取消收藏、编辑原文、进预览）目标是面板正在浏览的聊天，
  由 `ui/main.js` 显式传入 `state.currentViewingChatFile`；
- **聊天区的操作**按上面的解析函数定位。

`exitPreviewMode()` 会 `reloadCurrentChat()`，因此必须先 `flushPendingFavoriteSave()`（见上一节）。

另外三条与预览窗口本身有关的不变量：

- **窗口固定 5 条且在尾部向前补偿**：`startIndex = clamp(msgIndex - 2, 0, len - 5)`。
  只做「前置 2 条」会让 `endIndex` 提前撞到 `len`，收藏最后一条消息时只显示 3 条。
- **`state.screenshotSelection` 属于「本次预览」**：`enterPreviewMode` 必须清空它。否则在预览里改看
  另一条收藏后，截图弹窗仍按旧区间报数，而旧区间里的楼层已不在 `#chat` 里 —— 弹窗显示 3 条、实际只截到 1 条。
  恢复选择时还要用**本次预览实际存在的楼层**收敛 `min/max`，「截取」按钮直接发送实际存在的 id 列表。
- **自动隐藏监听必须幂等**：`_setupPreviewAutoHide()` 开头先 `_teardownPreviewAutoHide()`。
  监听器引用存在 `state._previewAutoHideHandlers` 上，被覆盖后就再也摘不掉，在预览里连续预览多条收藏会无上限累积。

### 分层浮层的成对关闭（易错）

插件的浮层分两类，**关闭主层时必须一并关闭依附于它的独立遮罩**：

- `#favoritesModal`（`--star-z-modal`，10000）—— 收藏面板主层；
- `#star-options-menu-overlay`（`--star-z-float`，10002）—— 头像长按/右键的设置小菜单，
  自带全屏遮罩与 `backdrop-filter`，层级**高于**面板，且打开时会把主遮罩的 `backdrop-filter` 置为 `none`。

因此 `closeFavoritesModal()` 必须调用 `closeAvatarLongPressMenu()`（它的唯一清理入口：
移除遮罩 DOM、恢复主遮罩 `backdrop-filter`、摘掉 `window.resize` 监听）。
只关面板会让设置菜单与整屏模糊遮罩留在页面上，用户必须再点一次空白处才能恢复。

**Esc 白名单同步**：新增浮层时必须在 `ui/main.js` 的 `handleEscKey` 里登记——
有独立 Esc 处理的放进 `TEMP_MODALS`（如 `star-qa-settings-overlay`、`star-img-preview-overlay`），
否则主面板会抢在同一层之前关闭；没有独立处理的浮层要自己补（答疑设置浮层即在 capture 阶段单独关闭）。
调试面板的可见性判断必须用 `style.display` 而非 `classList.contains('visible')`：
rAF 入场动画与关闭存在竞态，残留的 `visible` 类会让主面板 Esc 永久失效。

### 截图子系统

`ui/screenshot.js` + `ui/font-subset.js` + `worker.js` 协同：

- 关闭 modern-screenshot 库的字体嵌入（`font: false`），改由 `font-subset.js` 按本次截图文本逐字符匹配
  `unicode-range`，只下载命中的少数子集字体文件，通过 `onCreateForeignObjectSvg` 注入 SVG（提速 7~8 倍）。
- 外链图片经 `customImageFetchFn` 三级缓存转 dataURL，跨域失败时回退占位图。
- 截图支持预览模式内的消息选择弹窗、多消息截图、Canvas 尺寸上限 14000。
- **弹窗声明的条数必须等于实际生成的图片数**：可用楼层以 `#chat` 里真实存在的 `mesid` 为准，
  报数、勾选、`selectedIds()`、保存的选择区间都用同一份列表（按 `min..max` 逐号生成 id 会让不存在的楼层
  静默落在 `Logger.warn` 里）。弹窗打开到点「截取」之间消息仍可能被删/重渲染，因此
  `captureScreenshotMessages` 会重新统计 `actualIds`：缺楼层必须提示、按实际条数命名文件，
  空画布直接报错；拼接画布同样受 `MAX_CANVAS_DIMENSION` 约束（超限等比缩小）。
- `downloadCanvas` 的 `revokeObjectURL` 必须延迟：立即释放会让 Firefox 取消尚未开始的下载。
- **IndexedDB 不可用**（隐私模式/配额）时，字体与图片缓存读取必须按「未命中」继续走网络，
  不能把异常抛给截图主流程；`clearAllFontCache` 要同时清 `CACHED_FA_CSS`（FA 字体另有一份内存缓存）。

### 角色切换器

`ui/character-switcher.js`：扫描所有角色/群组，列出「有收藏的角色」，点击切换收藏面板至该角色数据。
扫描结果缓存在 `state.charactersWithFavorites`，**缓存刷新由 TTL 时间驱动**（`SCAN_CACHE_TTL` 默认 10 分钟）：
TTL 内即使有收藏变更（`charactersCacheStale = true`）也不自动重扫，仅提示可手动刷新；缓存过期后打开切换器时
「旧数据先行 + 后台刷新」；刷新按钮始终强制重扫。

- **扫描期间增量渲染**：`scanAllCharactersForFavorites` 通过 `options.onFound` 每发现一个有收藏的角色即回调，
  切换器边扫边渲染，扫描期间即可搜索、点击切换，无需等全量扫描完成。

### 收藏面板后台加载

打开收藏面板时 `loadOtherChatsInBackground` 调用 `getAllChatFavoritesForCurrentContext`
（`chat-data.js`），加载当前角色其余聊天的收藏。**增量加载缓存**：缓存中已有且 `favorites_updated_at`
未变化的聊天直接跳过（须匹配角色/群组身份），实现「面板二次打开秒开」。

### AI 答疑面板

`ui/qa.js`：浮动按钮 + 聊天式面板，支持流式传输、思维链折叠渲染、自定义 API
（`qaApiEndpoint` / `qaApiKey` / `qaModel`，经 `getSetting/setSetting` 读写）。

### 调试日志面板

`ui/debug.js`：浮动按钮 + 日志弹窗，读取 `Logger.logHistory`，支持级别筛选、下载、清空、主题适配。

## 开发命令

扩展**无需构建**，改 JS/CSS 后刷新浏览器即可。仓库提供零构建的检查工具：

```bash
npm run check        # 语法检查（node --check）+ 导入一致性（相对路径/导出名）+ 版本号一致性
npm run lint         # ESLint（重点：no-undef / no-unused-vars）
npm test             # 纯函数单元测试（node --test）
npm run css:scope    # 样式作用域自查（--write 可自动加容器前缀）
npm run tokens:check # 设计令牌门禁（规则内不得出现裸圆角 / 裸时长 / 裸 z-index / 裸缓动）
npm run verify       # 以上全部（提交前建议执行）
```

- 新增纯函数（无 DOM/无状态依赖）时，请放到 `utils.js` / `domain.js` / `markdown.js` 并补 `tests/` 用例。
- **动手前先看 `KNOWN_ISSUES.md`**：未修复的缺陷（含文件:行号、复现步骤、验证方式）都记在那里；
  修完一条就删掉该节，并把新的不变量补进本文件。已修复的历史坑写在下面的「关键设计概念」里，不要重复登记。
- `tests/browser-regression.mjs` 是**浏览器端**回归套件，覆盖纯函数测不到的「插件 ↔ 宿主接缝」
  （宿主浅拷贝是否带走虚拟 favorites、保存负载是否带实时元数据、预览态写目标、Esc 层级、监听器泄漏）。
  在 ST 页面里手动跑一次：
  ```js
  const { runStarRegressionSuite } = await import('/scripts/extensions/third-party/star/tests/browser-regression.mjs');
  console.table(await runStarRegressionSuite());   // 全部 pass:true 才算通过
  ```
  它用假的 200 响应拦截 `/api/chats/save` 只捕获负载、不写盘，改动过的状态都会还原；
  但它会短暂改动真实收藏，**请在测试用聊天上跑**。
- `scripts/check-imports.mjs` 会校验相对导入的目标文件是否存在、命名导入是否真的被导出——
  无打包器时这类错误只会在浏览器跑到那一行才暴露，**新增/移动文件后务必跑一次 `npm run check`**。
- `worker.js` 与 `lib/**` 是第三方压缩产物，已在 ESLint 与语法门中排除。

## 代码风格

1. **模块导入** - ES6 import，路径相对于 `extensions.js` / `script.js`；同一目录模块用相对路径
2. **依赖方向** - UI → 数据单向；数据层需要 UI 协作时用 `hooks.js`，**不要在数据层 import `ui/`**
3. **按需加载** - 重 UI 模块用 `await import()`（不要用 `.then()` 链）；启动路径只导入轻量模块
4. **HTML 模板** - 使用 JavaScript 模板字符串内联 HTML，避免单独的 HTML 文件
5. **转义** - 用户可控文本（备注、角色名、标签、文件名、来自聊天文件的 `star_favorite.id`）插入 HTML/属性前必须 `escapeHtml()`（来自 `utils.js`）。
   **Markdown 链接**（`markdown.js` / `ui/qa.js`）必须经 `isSafeLinkUrl` 白名单（http/https/mailto/相对地址），
   并且转义引号——答疑正文、思维链与 API 错误响应体都会进入这条渲染路径。
6. **错误处理** - 所有 API 调用包含 try-catch，使用 Logger 记录；空 catch 需注明为何静默
7. **异步操作** - 使用 async/await 而非 Promise 链
8. **事件监听** - 动态创建的元素需使用事件委托或及时清理监听器
9. **中文注释** - 注释使用中文，说明"为什么"而非"做什么"

## 样式开发规范

1. **统一样式文件** - 所有样式写入 `style.css`（含 `update.html` 的样式）；**禁止内联 `style="..."`**
   （动态显隐等必须由 JS 计算的值除外）
2. **颜色格式** - 统一使用 `RGBA` 格式
3. **样式隔离** - 新增 CSS ID/Class 一律 `star-` 前缀；写入宿主聊天区的元素必须加容器限定。
   历史遗留类名（`fav-*` / `favorites-*` / `context-*` / `favorite-item` 等）已统一收敛到容器前缀下：
   `#favoritesModal`（面板与侧栏）、`#context-messages-frame`（上下文查看器/预览气泡）、`#chat`（消息区收藏图标）。
   **新增规则必须自带作用域**——要么是 `star-` 前缀的新类名，要么写入上述容器之一；
   不要新增裸通用类名（如 `.message-box`、`.item`），否则会与宿主或其他扩展互相污染。
   可用 `npm run css:scope` 自查是否还存在未加作用域的遗留类名。
4. **显式属性定义** - 对于 `input`、`textarea`、`button` 等易被全局样式影响的元素，必须明确定义所有视觉属性
5. **`!important` 用法** - 用于对抗宿主全局样式，但应通过「提高选择器特异性（容器前缀）」替代
   可避免的部分；新增规则不要无脑加（存量仍较多，属渐进治理：新代码不再叠加）
6. **主题系统** - 使用 CSS 变量定义颜色，通过 `data-star-theme` 属性切换亮/暗模式（唯一事实来源在
   `<html>` 上，见「主题系统」章节）
7. **设计令牌** - `style.css` 顶部的 `0. DESIGN TOKENS` 段定义了间距 / 圆角 / 阴影 / 层级 / 时长 / 缓动。
   新代码一律引用令牌：`var(--star-radius-md)` 而不是 `12px`，`var(--star-dur-base)` 而不是 `0.2s`。
   同时也**不要用 `transition: all`**——把布局属性一并纳入动画是掉帧与「连带抖动」的常见来源，
   交互反馈统一用 `var(--star-transition-hover)`。
   - **已彻底清零、并由门禁强制**：圆角（原 13 种取值）、过渡与动画时长、`z-index`（原 24 个裸数字）、
     缓动曲线（原 10 份副本）。`npm run tokens:check` 会在规则内发现裸值时失败，已接入 `npm run verify`。
   - **尚未迁移（渐进治理）**：间距（`padding`/`margin`/`gap`，约 310 处）与阴影（约 49 处）仍是字面量。
     改到哪个组件就顺手换成 `--star-space-*` / `--star-shadow-*`，本轮的「无裸值」结论**不覆盖这两类**。
   - **z-index 是「保号命名」**：`--star-z-*` 的数值刻意与改造前逐一相同，只做命名，不做重新编号。
     原因：这些浮层与宿主页面、其他扩展的浮层共处同一个根层叠上下文，改动数值会改变彼此的遮挡关系，
     而那部分不在本插件可控范围内。新增浮层时**请挑一个现成的层级令牌**（阶梯顺序见令牌段注释），
     确实需要新层级时再追加，并保持「数值越大越靠前」可读。
   - **刻意保留的字面量**（`tokens:check` 会作为提示列出，不判失败）：`prefers-reduced-motion` 块里的
     `0.01ms`/`0ms` 是「关闭动效」的语义值；循环动画周期（骨架屏 1.3s、未读脉冲 2s、等待点 1.4s）
     与 `animation-delay` 相位偏移属于组件专属数值，不是设计语言。
8. **文字与强调色** - 淡紫强调色（`--star-accent-primary*`）在亮/暗主题下都是**浅底**，
   其上的文字必须用 `--star-text-on-accent`（深色）。用 `--star-text-inverse`（亮色=白）会得到约 1.3:1 的
   不可读对比度。
9. **加载态** - 用骨架屏而非裸文本：`showLoadingPlaceholder()`（`ui/main.js`）+ `.star-skeleton*` 类。
   骨架容器带 `star-loading-placeholder` 标记类，渲染完成时由 `clearLoadingPlaceholder()` 统一移除——
   面板是往 `modalBodyElement` 里 prepend/append 而非重建，残留占位会挤占布局。
10. **新装 UI 的无障碍三件套** - 焦点环（`:focus-visible`）、`prefers-reduced-motion`、`safe-area`
    已在 `style.css` 的 BASE 段按「容器名单」统一覆盖。新增顶层容器时，**把它的选择器补进那三处名单**
    （名单与 `ui/scope.js` 的 `STAR_UI_SCOPE` 保持一致，CSS 无法 import 该常量，需同步维护）。
11. **可访问性** - 可点击图标用 `role="button"` + `tabindex="0"` + `aria-label`，装饰性图标加 `aria-hidden="true"`。
   `role`+`tabindex` 只让元素可被 Tab 聚焦，**不会**让 Enter/Space 触发点击——
   这部分由 `ui/a11y.js` 通过一次委托统一补齐（作用域名单见 `ui/scope.js`），
   因此新增图标只需补属性，不必自己绑键盘事件。

```css
/* 正确示例 */
#favoritesModal .favorites-search-input {
    background-color: var(--star-bg-input) !important;
    color: var(--star-text-main) !important;
    border: 1px solid var(--star-border-input) !important;
    /* 明确定义所有属性 */
}
```

## 重要注意事项

1. **ID 处理** - 聊天文件名可能含 `.jsonl` 后缀，统一用 `stripJsonlExt()`（锚定结尾，幂等）
2. **预览模式** - 预览时**聊天区**的收藏操作作用于 `state.previewingChatFile`（被预览的聊天），
   由 `state.resolveChatAreaTargetChatFile()` 统一解析；面板内的操作才用 `state.currentViewingChatFile`。
   详见「预览模式（写目标易错）」
3. **长按事件** - 收藏图标支持长按编辑备注（600ms），需区分点击和长按（长按后需吞掉随后的 click）
4. **iframe 渲染** - HTML 代码块通过 iframe 渲染（`ui/iframes.js`），需桥接 window 函数
5. **设置持久化** - 所有插件设置经 `getSetting/setSetting`（`state.js`）；新增设置项需登记进 `SETTINGS` schema。
   **严禁使用 `localStorage`**（截图字体/图片缓存使用 IndexedDB，属例外）
6. **元数据保存** - 当前聊天与其他聊天统一走 `saveSpecificChatMetadata()`（内部自带重试与失败提示）；
   保存当前聊天必须传 `context.chat` 真实数组**与实时的 `context.chatMetadata`**，不能传缓存副本。
   注意 `getContext()` 返回的是**值快照**，而宿主的 `updateChatMetadata()` 是整体换对象
   （`chat_metadata = {...chat_metadata, ...newValues}`），所以保存前要重新取一次 context。
   缓存里的 `metadata` 在每次保存成功后会被替换成深拷贝（`chat-data.js`），
   与实时对象必然分叉——拿它落库会把其它扩展/宿主自上次收藏保存以来写入的字段
   （`variables` / `world_info` / `tainted` / 各扩展命名空间）静默回滚（实测复现过）
7. **收藏写操作** - 必须复用 `core.js` 的「定位 → `mutateSwipeFavorite` → `commitFavoriteWrite`」链路，
   以保证虚拟收藏缓存被重建（否则 UI 与数据不同步）
8. **后台任务取消** - 异步后台扫描/加载必须支持 `AbortController`，用 `isAbortError()` 判断；
   切换聊天时由 `runCancellers()` 统一取消（新模块请用 `registerCanceller()` 注册）
9. **截图字体** - 修改截图逻辑时需了解 `font-subset.js` 的映射构建与缓存失效机制（`invalidateFontCaches`），
   字体文件变更后需清缓存才能生效
10. **版本号** - 只改 `manifest.json`；`state.js` 的兜底值由 `npm run check` 校验一致性
