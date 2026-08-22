// ui/qa.js - AI答疑面板模块（支持流式传输、完善消息渲染、自定义API）

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { state, PLUGIN_NAME } from '../state.js';
import { getUsageGuidePlainText } from './settings.js';
import Logger from '../Logger.js';

// =================================================================
//                         CONSTANTS
// =================================================================

const QA_MODAL_ID = 'star-qa-modal';
const QA_CONTAINER_CLASS = 'star-qa-container';
const QA_HEADER_CLASS = 'star-qa-header';
const QA_TITLE_CLASS = 'star-qa-title';
const QA_CLOSE_CLASS = 'star-qa-close';
const QA_BODY_CLASS = 'star-qa-body';
const QA_FOOTER_CLASS = 'star-qa-footer';
const QA_INPUT_CLASS = 'star-qa-input';
const QA_SEND_CLASS = 'star-qa-send';
const QA_STOP_CLASS = 'star-qa-stop';
const QA_TYPING_CLASS = 'star-qa-typing';

/**
 * 构建系统提示词（内置知识库）。
 * 第一部分：官方「使用说明」的完整内容，动态取自 ui/settings.js（getUsageGuidePlainText），
 *           与使用说明弹窗共用同一数据源，保证内容始终同步。
 * 第二部分：插件作者补充的精确技术细节（使用说明未覆盖或需更精确的信息）。
 */
function buildSystemPrompt() {
    return `你是一个名为「Star小助手」的AI助手，专门帮助用户解答关于 SillyTavern 的「聊天收藏器」(Star) 插件的问题。以下是该插件的知识库，包含官方「使用说明」的完整内容，以及补充的精确技术细节。请严格基于这些内容准确回答，不要编造不存在的功能、按钮或设置。回答要具体，尽量提到按钮位置、图标样式和操作路径。若两部分描述存在不一致，以第二部分「补充技术细节」为准。

# 第一部分：插件官方使用说明（完整内容）

${getUsageGuidePlainText()}

# 第二部分：补充技术细节（使用说明之外的精确信息）

## 插件基本信息
「聊天收藏器」(Star) 是一个 SillyTavern 扩展插件，当前版本 v2.2.0（作者 uhhhh15）。它帮助用户在与 AI 角色/群组聊天时收藏重要的消息，并提供备注、搜索、上下文预览、截图导出、跨角色浏览、AI 答疑等能力。安装并启用后，魔法棒🪄扩展菜单中会出现「收藏」按钮（星形图标+文字"收藏"）。

## 收藏与取消收藏
1. 每条消息右上角（角色名旁的操作按钮区）有一个半透明的空心星形图标：**单击**收藏（变为实心黄色），**再次单击**取消收藏（恢复空心），取消时无确认弹窗。
2. 收藏按消息的 Swipe（同一条消息的不同版本）**独立存储**：同一消息的不同 Swipe 可以分别收藏、分别加备注。
3. 收藏数据写入消息的 swipe_info 结构，因此删除消息时对应的收藏会自动同步清理，不会留下孤儿数据。
4. 聊天界面里也可以直接预览收藏状态：星标实心 = 已收藏，空心 = 未收藏。

## 备注（Note）
- **长按消息旁的星标约 0.6 秒**可直接编辑备注（鼠标按住或手指长按均可）。
- 若该消息尚未收藏，长按会**先自动收藏再编辑备注**；若此时取消弹窗，会自动撤销刚才的收藏。
- 也可以在收藏面板的卡片上点击「编辑备注」按钮（羽毛笔图标）修改。
- 备注输入框的占位文字是"输入备注内容..."；备注按 Swipe 独立存储，切换 Swipe 时备注跟随变化。

## 收藏管理面板
- **打开方式**：点击 SillyTavern 聊天输入框左边的魔法棒🪄 →「收藏」按钮（或直接从收藏卡片的 👁️ 预览按钮重新打开）。
- **标题栏**：左上角是当前角色/群组头像（**单击**展开/收起左侧边栏，**长按约 0.6 秒或右键**弹出设置菜单）；中间显示当前角色/群聊名；右侧依次是搜索框、关闭按钮（X）。
- **左侧边栏**：列出所有有收藏的聊天（当前聊天即使没有收藏也会显示），每项显示聊天文件名+收藏数量徽标，选中的高亮；侧栏底部有「切换角色」按钮（fa-users 图标）、太阳/月亮主题切换按钮（title"切换主题"）、AI 答疑按钮（气泡图标，title"AI答疑助手"）和齿轮设置按钮（fa-gear，title"打开设置"）。
- **主区域**：收藏卡片列表，按楼层号（消息索引）升序排列；底部有分页栏（收藏数超过每页数量时出现）。
- **性能表现**：打开面板时当前聊天的收藏**立即**渲染显示，其他聊天的收藏在后台异步加载（侧栏显示"加载中..."占位）；切换聊天或角色时会自动取消未完成的加载，避免旧数据污染。

## 搜索
- 搜索框占位文字为"检索收藏..."，点击放大镜图标展开搜索框并聚焦，输入即实时过滤；输入框失焦且内容为空时自动收起。
- **默认同时搜索消息正文和备注**；点击搜索框左侧的漏斗图标（title"仅搜索备注"）激活后，**只搜索备注内容**（图标高亮表示已激活）。点击过滤按钮时不会让搜索框失焦收起。

## 收藏卡片上的每个按钮（按图标说明）
1. **👁️ 预览上下文**（fa-eye，title"预览上下文"）— 进入预览模式，在主聊天界面临时加载该消息及附近共 5 条消息。
2. **⛶ 查看上下文**（fa-expand，title"查看上下文"）— 打开独立的"消息上下文"弹窗，显示前后 contextViewRange 条消息（默认前后各 1 条，共 3 条），支持单消息/列表两种模式切换，右上角可截图。
3. **✏️ 编辑原文**（fa-pencil，title"编辑原文"）— 打开编辑器**永久修改**消息正文，可同时编辑"内心独白"（思维链）；修改会写入聊天文件并重载当前聊天，**不可撤销**。编辑器有两个区域：💭 内心独白 和 💬 消息正文，底部按钮为"取消"/"保存"。
4. **🪶 编辑备注**（fa-feather-pointed，title"编辑备注"）— 编辑当前 Swipe 的备注。
5. **🗑️ 取消收藏**（fa-trash，title"取消收藏"）— 弹出确认框"确定要取消这条收藏吗？"，确认后删除收藏（不删除原消息），成功提示"收藏已取消"。
6. **⋮ 更多操作**（fa-ellipsis-vertical，title"更多操作"）— 移动端小屏设备上其他按钮隐藏时，通过它访问「编辑原文 / 编辑备注 / 取消收藏」三项。
7. **‹ / › 箭头 + 1/N 计数** — 仅当同一消息有多个被收藏的 Swipe 时出现（title"上一个收藏的Swipe"/"下一个收藏的Swipe"），循环切换查看的 Swipe，备注和正文跟随切换。

## 分页与跳转
- 收藏数超过每页数量时底部出现分页栏：‹ 上一页 / 页码 / › 下一页，当前页高亮；页码布局为第 1 页 + 当前页±2 + 末页，中间用省略号"..."表示。
- **双击当前页码**可弹出输入框"请输入要跳转的页码 (1-N)"（按钮文字"跳转"），输入无效页码时提示"请输入有效的页码 (1-N)"。

## 跨角色浏览（角色切换器）
- **入口**：收藏面板左侧边栏底部的「切换角色」按钮（fa-users 图标，title"切换角色（跨角色浏览收藏）"），从底部向上滑出抽屉。
- 抽屉标题"切换角色"；右上角有刷新按钮（fa-rotate，title"重新扫描所有角色"）和关闭按钮；搜索框占位文字"搜索角色名…"（默认不聚焦，避免移动端弹出键盘）。
- 自动扫描所有角色和群组（群组带"群"徽标），每项显示头像+角色名+"N 个聊天"+收藏总数徽标，按收藏总数降序排列。
- 状态提示："正在准备扫描…"、扫描中"扫描中 x/y · 角色名"、完成"扫描完成：N 个角色，共 M 条收藏"、无结果"没有匹配的角色"。
- 点击某个角色项立即切换到该角色的收藏（提示"已切换到「名字」的收藏"），**不会改变 SillyTavern 当前打开的聊天**。
- 打开收藏面板时会在后台预扫描所有角色，让切换器"秒开"；增删收藏后缓存自动标记过期，下次打开会重新扫描。

## 预览模式
- **进入**：点击收藏卡片的 👁️ 按钮（或查看上下文弹窗中的对应入口）。
- **行为**：关闭收藏面板、隐藏顶部栏、**不能发送新消息**（底部输入框被替换为「结束预览」按钮）、固定加载收藏消息附近共 5 条消息（目标消息前后各 2 条）、自动滚动到目标消息。
- **右侧浮动两个圆形按钮**：👁️（title"打开收藏面板"）重新打开收藏面板（可无缝切换查看其他收藏的预览）；📷（title"截图预览消息"）打开截图范围选择弹窗。
- **退出方式**：点击「结束预览」按钮（挂载在输入区位置）、或切换聊天（自动退出预览）。注意：实际代码中 Escape 键不会退出预览模式（Escape 只用于关闭各类弹窗），建议使用"结束预览"按钮。
- 预览区域滚动时浮动按钮自动隐藏、停顿约 600ms 后恢复；右键/长按隐藏后约 800ms 恢复。
- 预览模式不影响聊天记录，退出后自动恢复原聊天内容。

## 截图功能
- **入口1**：预览模式下点击右侧 📷 相机浮动按钮。
- **入口2**："查看上下文"弹窗右上角的相机按钮（title"截图当前消息"），按当前模式截取单消息或整个上下文。
- **范围选择弹窗**（"📷 选择截图范围"）：提示"勾选要截取的消息楼层 — 自动保持连续选择"；列出预览区所有消息（楼层号+发送者+正文前 20 字预览）；**勾选自动保持连续范围**，底部显示"已选范围: #min — #max（N 条）"或"未选择"；未选择时"截取"按钮禁用。选择状态在预览模式内保持，退出预览后清除。
- **技术细节**：导出格式为 JPEG 质量 0.92（文件名显示 .png，实际下载为 .jpg）；Canvas 尺寸上限 14000px；截图时自动过滤消息操作按钮和收藏星标图标；字体和图片资源走三级缓存（内存/IndexedDB/网络），二次截图极快；多条消息逐条截图后按实际间距垂直拼接。
- **提示文案**：加载库"正在加载截图库..."、处理中"正在截图..."、成功"截图已保存: 文件名 (xx KB)"、失败"截图库加载失败，请检查网络连接"。

## 主题切换
- **入口**：点击收藏面板左侧边栏底部的**太阳/月亮图标**（位于「切换角色」按钮下方、AI 答疑气泡图标左侧）。
- 支持亮色/暗色两档，点击后立即生效并保存，提示"已切换至暗色主题"/"已切换至白天主题"。亮色主题显示太阳图标，暗色主题显示月亮图标。

## 设置菜单（当前分组结构）
- **弹出方式**：长按或右键收藏面板左上角头像，或点击侧栏底部齿轮（fa-gear）。菜单为**分组布局**，共 3 组，每项右侧显示当前状态值：
  1. **显示**：上下文范围（fa-arrows-left-right-to-line）— 决定"查看上下文"弹窗显示前后各几条消息（默认 1，即共 3 条；设为 2 显示前后各 2 条共 5 条；设为 0 只显示收藏消息本身）。**只影响"查看上下文"弹窗，预览模式固定加载 5 条**。右侧显示"前后各 N 条"。输入必须是非负整数，非法输入提示"请输入一个有效的非负整数。"并阻止关闭弹窗。每页收藏数（fa-list-ol）— 每页显示的收藏卡片数量（默认 10 条，建议 5~30，过大会影响加载性能），保存后立即刷新并重置到第一页。右侧显示"N 条"。输入必须为正整数（>0），非法提示"请输入一个有效的正整数。"。
  2. **功能**：截图设置（fa-image）— 打开"截图设置 — 缓存管理"弹窗：分「🔤 字体缓存」和「🖼️ 图片缓存」两个区块，显示缓存数量和占用大小；字体集可点击展开查看内部文件，**长按 600ms 删除**单条/单集；单击图片行可预览；右上角可一键清空全部字体或图片缓存。清空后下次截图会自动重新下载资源。快捷键（fa-keyboard）— Alt+S 收藏/取消收藏、Alt+F 开关面板，右侧显示"Alt+S / Alt+F"。
  3. **其他**：日志面板（fa-bug）— 切换调试日志面板，右侧显示"已启用/已关闭"。启用后页面左侧出现🐛浮动图标（title"打开调试日志面板"），点击打开"调试日志"弹窗。使用说明（fa-book-open）— 打开内置帮助文档，含侧边导航（10 个章节：欢迎使用/基本操作/收藏面板/搜索与翻页/收藏项操作/预览模式/截图功能/主题与设置/更新插件/常见问题），移动端（≤768px）侧栏默认折叠。

## 调试日志面板
- **入口**：设置菜单「启用日志面板」后，页面左侧出现🐛图标，点击打开"调试日志"弹窗。
- **功能**：日志级别筛选下拉（ALL / ERROR / WARN / INFO / SUCCESS / DEBUG，默认 ALL）；清空按钮（fa-eraser，提示"日志已清空"）；下载按钮（fa-download，导出文件名格式"StarPlugin_DebugLog_时间戳.txt"，提示"日志文件已开始下载"）。
- 日志内存上限 500 条（超出自动覆盖最旧的）；每条格式为"[HH:MM:SS] [级别] 消息"。
- 空态文案："暂无日志记录"（完全无日志）/ "暂无匹配的日志记录"（被筛选过滤）。
- 关闭方式：X 按钮、点击遮罩、Escape 键。

## AI 答疑面板（Star 小助手）
- **入口**：收藏面板左侧边栏底部的 AI 答疑按钮（气泡图标，位于太阳/月亮主题切换图标右侧、设置齿轮图标左侧）。
- **发送方式**：Enter 发送，Shift+Enter 换行；支持流式输出（打字机效果）、Markdown 渲染（标题/粗体/斜体/代码/列表/引用/链接/表格）、停止生成按钮（红色停止图标）、清空对话按钮（扫帚图标，标题"清空对话"）。
- **内心独白**：如果模型返回思维链内容（reasoning_content），会默认折叠在"💭 内心独白"区域（点击展开），不会影响正文显示，也不会写入后续对话上下文。
- **配置入口**：答疑面板内右上角齿轮图标（fa-gear）。
- **配置项（修改后自动保存，无手动保存按钮）**：API 地址（OpenAI 兼容格式，支持 /chat/completions 完整路径或 base URL）、API 密钥（密码输入框）、模型名称（如 gpt-3.5-turbo、gpt-4o、deepseek-chat、qwen-turbo）。回复固定使用流式传输（打字机效果），无需配置。
- 兼容任何 OpenAI Chat Completions 格式的 API（OpenAI、硅基流动、DeepSeek、Ollama 等）；密钥仅存储在本地浏览器，不会上传到第三方服务器。
- 对话历史仅保存在内存中，刷新页面后清空；点击右上角扫帚图标可清空对话（超过 1 条消息时弹确认框）。
- 未配置 API 时发送消息，会提示先配置 API 接口（告知设置入口和需要填写的三项内容）。

## 数据存储与备份
- **收藏数据**实际存储在聊天文件（.jsonl）每条消息的 swipe_info 结构中（message.swipe_info[swipeId].star_favorite），随聊天记录一起保存在服务端 chats 目录，随聊天一起备份/迁移。**删除聊天文件 = 丢失该聊天所有收藏**。
- UI 读取时通过 core.js 的 buildVirtualFavorites() 把 swipe_info 汇总为"虚拟 favorites 数组"挂在 chatMetadata.favorites 上供界面使用——它只是运行时虚拟数据，**不会写入文件**。
- 收藏数会以 favorites_count 字段形式保存，供角色/聊天列表接口快速筛选，不会把虚拟收藏数组写入文件造成臃肿；另会注入 favorites_updated_at 时间戳，作为收藏索引缓存的增量刷新信号（时间戳变化 = 收藏可能变化）。
- **插件设置**（主题、每页数量、上下文范围、日志面板开关、QA 配置等）存储在 SillyTavern 的 extension_settings 中（键名 star）。
- 收藏**不会自动跨设备同步**，请使用 SillyTavern 自带的下载备份/导入备份功能迁移。

## 更新机制
- 插件初始化时自动检查更新（从 GitHub 仓库获取版本信息），**24 小时内不重复请求**（本地有缓存时直接使用）。
- 有新版时，魔法棒中「收藏」按钮旁会出现**红色"可更新"徽标**（悬停提示"发现新版本: vX.Y.Z"）。
- 点击徽标 → 弹出"发现新版本"确认弹窗（显示更新日志内容，唯一按钮"立即更新"）→ 确认后请求后端更新（POST /api/extensions/update）→ 成功后提示"更新成功！3秒后将自动刷新页面..."并自动刷新。
- 取消更新会提示"更新已取消。"；已是最新版本时提示"当前已是最新版本。"；失败会提示"更新失败，服务器返回状态: xxx"或"更新请求发生错误，请查看控制台日志。"。
- 更新失败时，可尝试重新卸载再安装：https://github.com/uhhhh15/star.git
- 新版本插件**首次打开收藏面板**时，会自动弹出"Star 更新日志"弹窗（按钮"知道了"），关闭后记录已读，下次不再弹出。

## 快捷键与键盘交互
- **Alt + S**：收藏/取消收藏当前聊天最后一条消息（输入框内与预览模式下不触发）。
- **Alt + F**：快速打开/关闭收藏面板。
- **Escape 键逐层关闭**（子弹窗优先，最后才关主面板）：确认/输入/标签/编辑器/AI答疑/调试/截图选择/使用指南等自带 Esc 的子弹窗 → 标签筛选菜单 → 设置小菜单 → 截图设置 → 上下文查看器 → 收藏面板主窗口。
- 聊天界面的收藏星标：按住约 0.6 秒为长按（编辑备注），快速点击为收藏/取消收藏。
- 角色切换器打开时按 Escape 只关闭切换器，不会连带关闭收藏面板。

## 常见问题（FAQ）
1. **收藏的数据存储在哪里？** 存在聊天文件（.jsonl）的消息 swipe_info 结构中，随聊天存于服务端 chats 目录；插件设置存在 settings_extension；删除聊天文件会丢失该聊天的所有收藏。
2. **为什么有些消息没有星标图标？** 确认插件已加载（魔法棒🪄里能看到"收藏"按钮）；刷新页面；滚动聊天区域触发重新渲染（插件监听了聊天区域 DOM 变化自动补图标）。
3. **收藏面板显示"原始消息内容不可用或已删除"？** 该收藏来自其他聊天，当前上下文拿不到数据，后台异步加载中稍等刷新；持续显示可能是原聊天文件已被删除（收藏条目仍在但无法显示内容）。
4. **收藏能跨设备同步吗？** 不能自动同步；用 SillyTavern 的下载备份/导入备份迁移。
5. **预览模式和正常模式有什么区别？** 预览模式临时替换聊天显示、不能发送新消息、不影响聊天记录，退出后恢复原状；切换聊天会自动退出预览。
6. **截图功能无法使用？** 查看控制台或日志面板的报错；在"截图设置"里清空字体和图片缓存；确认网络正常（字体需在线下载）；刷新页面重试。
7. **如何反馈问题？** 到"类脑/旅程"社区搜索"聊天收藏器"帖子反馈，或在 GitHub 仓库提交 Issue。

## 回复要求
- 用简洁、友好的中文回复，优先给出操作步骤，让用户能照着做。
- 回答时尽量提到具体的按钮位置、图标样式和面板入口，方便用户找到。
- 如果用户的问题不在你的知识范围内，如实说明并建议检查更新或反馈到社区，不要编造。
- 可以适当使用 emoji 让回复更生动。`;
}

// 对话历史（内存中，不持久化）
let conversationHistory = [];

// 流式请求的 AbortController
let streamAbortController = null;
let isStreaming = false;

/**
 * 重置对话历史，并重新加入系统提示词（固定使用内置知识库，不支持自定义）。
 */
function resetConversation() {
    conversationHistory = [
        { role: 'system', content: buildSystemPrompt() }
    ];
}

// 模块加载时初始化
resetConversation();

// =================================================================
//                      DOM 结构创建
// =================================================================

/**
 * 确保浮动按钮和答疑面板 DOM 存在。
 */
export function ensureQAStructure() {
    // --- 答疑面板 ---
    if (!document.getElementById(QA_MODAL_ID)) {
        const modal = document.createElement('div');
        modal.id = QA_MODAL_ID;
        const ms = (k, v) => modal.style.setProperty(k, v, 'important');
        ms('display', 'none'); ms('position', 'fixed'); ms('top', '0'); ms('left', '0');
        ms('z-index', '10010');
        ms('background-color', 'rgba(0,0,0,0.4)');
        ms('backdrop-filter', 'blur(4px)');
        ms('opacity', '0');
        ms('padding', '0'); ms('margin', '0'); ms('border', 'none');
        ms('width', '100vw'); ms('height', '100vh');

        const container = document.createElement('div');
        container.className = QA_CONTAINER_CLASS;
        const css = (k, v) => container.style.setProperty(k, v, 'important');
        css('position', 'absolute');
        css('width', '480px');
        css('max-width', '92vw');
        css('height', '560px');
        css('max-height', '82vh');
        css('display', 'flex');
        css('flex-direction', 'column');
        css('border-radius', '16px');
        css('overflow', 'hidden');
        css('border', '1px solid var(--star-border-main)');
        css('padding', '0');
        css('margin', '0');
        css('background-color', 'var(--star-bg-dialog)');
        css('box-shadow', '0 8px 40px rgba(0,0,0,0.25)');

        const header = document.createElement('div');
        header.className = QA_HEADER_CLASS;
        const hcss = (k, v) => header.style.setProperty(k, v, 'important');
        hcss('display', 'flex'); hcss('align-items', 'center');
        hcss('padding', '12px 16px'); hcss('flex-shrink', '0');
        hcss('border-bottom', '1px solid var(--star-border-main)');
        hcss('background-color', 'var(--star-bg-header)');
        hcss('gap', '8px');
        header.innerHTML = `
            <h3 class="${QA_TITLE_CLASS}" style="flex:1;margin:0;font-size:16px;font-weight:600;color:var(--star-text-main);">🤖 Star 小助手</h3>
            <div class="star-qa-clear-btn" title="清空对话" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:8px;font-size:14px;color:var(--star-text-muted);"><i class="fa-solid fa-broom"></i></div>
            <div class="star-qa-settings-btn" title="AI答疑设置" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:8px;font-size:14px;color:var(--star-text-muted);"><i class="fa-solid fa-gear"></i></div>
            <div class="star-qa-min-btn" title="最小化" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:8px;font-size:14px;color:var(--star-text-muted);"><i class="fa-solid fa-minus"></i></div>
            <div class="${QA_CLOSE_CLASS}" title="关闭" style="width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:8px;font-size:16px;color:var(--star-text-muted);"><i class="fa-solid fa-xmark"></i></div>
        `;

        const body = document.createElement('div');
        body.className = QA_BODY_CLASS;
        const bcss = (k, v) => body.style.setProperty(k, v, 'important');
        bcss('flex', '1 1 auto'); bcss('overflow-y', 'auto');
        bcss('padding', '16px'); bcss('display', 'flex');
        bcss('flex-direction', 'column'); bcss('gap', '12px');
        bcss('background-color', 'var(--star-bg-item)');

        const footer = document.createElement('div');
        footer.className = QA_FOOTER_CLASS;
        const fcss = (k, v) => footer.style.setProperty(k, v, 'important');
        fcss('display', 'flex'); fcss('align-items', 'flex-end');
        fcss('gap', '8px'); fcss('padding', '10px 14px');
        fcss('flex-shrink', '0');
        fcss('background-color', 'var(--star-bg-header)');
        footer.innerHTML = `
            <textarea class="${QA_INPUT_CLASS}" placeholder="输入你的问题，Enter 发送 / Shift+Enter 换行" rows="1" style="flex:1;resize:none;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.5;max-height:100px;min-height:40px;outline:none;font-family:inherit;"></textarea>
            <button class="${QA_STOP_CLASS}" title="停止生成" style="display:none;width:40px;height:40px;border-radius:50%;border:none;align-items:center;justify-content:center;font-size:16px;cursor:pointer;flex-shrink:0;background:rgba(255,68,68,0.85);color:#fff;"><i class="fa-solid fa-stop"></i></button>
            <button class="${QA_SEND_CLASS}" title="发送" style="width:40px;height:40px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;flex-shrink:0;background:var(--star-accent-primary);color:#fff;"><i class="fa-solid fa-paper-plane"></i></button>
        `;

        container.appendChild(header);
        container.appendChild(body);
        container.appendChild(footer);
        modal.appendChild(container);
        document.body.appendChild(modal);

        // 发送按钮事件
        const sendBtn = modal.querySelector(`.${QA_SEND_CLASS}`);
        const stopBtn = modal.querySelector(`.${QA_STOP_CLASS}`);
        const inputEl = modal.querySelector(`.${QA_INPUT_CLASS}`);

        sendBtn.addEventListener('click', () => handleQASend(inputEl));
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleQASend(inputEl);
            }
        });

        // 停止按钮
        stopBtn.addEventListener('click', stopStreaming);

        // 设置按钮（打开 AI 答疑设置）
        const settingsBtn = header.querySelector('.star-qa-settings-btn');
        settingsBtn.addEventListener('click', () => {
            showQASettingsPopup();
        });

        // 最小化按钮（隐藏弹窗并显示浮动恢复按钮，保留对话与流式状态）
        const minBtn = header.querySelector('.star-qa-min-btn');
        minBtn.addEventListener('click', minimizeQAPanel);

        // 清空对话按钮
        const clearBtn = header.querySelector('.star-qa-clear-btn');
        clearBtn.addEventListener('click', () => {
            const body = modal.querySelector(`.${QA_BODY_CLASS}`);
            const msgCount = body.querySelectorAll('.star-qa-message').length;
            if (msgCount <= 1) return; // 只有欢迎消息不弹确认
            import('./components.js').then(m => {
                m.showConfirmModal('确定要清空所有对话记录吗？', '清空对话', { hideHeader: true, noBorder: true }).then(confirmed => {
                    if (confirmed) {
                        resetQAChat();
                        toastr.info('对话已清空', '', { timeOut: 1500 });
                    }
                });
            });
        });

        // 关闭按钮
        modal.querySelector(`.${QA_CLOSE_CLASS}`).addEventListener('click', closeQAPanel);

        // 点击遮罩关闭
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeQAPanel();
        });

        // ESC 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.getPropertyValue('display') === 'block') {
                closeQAPanel();
            }
        });

        // 窗口大小变化时重新居中
        window.addEventListener('resize', () => {
            if (modal.style.getPropertyValue('display') === 'block') {
                centerQAModal(modal);
            }
        });
    }
}

// =================================================================
//                      面板开关
// =================================================================

/**
 * 打开答疑面板。
 */
export function openQAPanel() {
    ensureQAStructure();

    // 若存在最小化后的浮动恢复按钮，一并移除
    const restoreBtn = document.getElementById('star-qa-restore-btn');
    if (restoreBtn) restoreBtn.remove();

    const modal = document.getElementById(QA_MODAL_ID);
    if (!modal) return;

    // 应用主题
    applyQATheme();

    // 如果是首次打开或历史为空，渲染欢迎消息
    const body = modal.querySelector(`.${QA_BODY_CLASS}`);
    if (body && body.children.length === 0) {
        renderWelcomeMessage(body);
    }

    // 显示并居中
    modal.style.setProperty('display', 'block', 'important');
    centerQAModal(modal);
    modal.style.setProperty('opacity', '1', 'important');
}

/**
 * 关闭答疑面板。
 */
export function closeQAPanel() {
    // 关闭面板时中止正在进行的流式请求
    if (isStreaming && streamAbortController) {
        streamAbortController.abort();
        streamAbortController = null;
        isStreaming = false;
    }
    // 若存在最小化后的浮动恢复按钮，一并移除
    const restoreBtn = document.getElementById('star-qa-restore-btn');
    if (restoreBtn) restoreBtn.remove();
    const modal = document.getElementById(QA_MODAL_ID);
    if (modal) {
        modal.style.setProperty('display', 'none', 'important');
        modal.style.setProperty('opacity', '0', 'important');
        // 恢复 UI 状态
        setStreamingState(modal, false);
    }
}

/**
 * 最小化答疑面板：隐藏弹窗但保留对话与流式状态（不中止流式、不清空对话），
 * 并在屏幕右下角显示一个浮动恢复按钮，点击可重新展开面板继续提问。
 */
export function minimizeQAPanel() {
    const modal = document.getElementById(QA_MODAL_ID);
    if (!modal) return;
    modal.style.setProperty('display', 'none', 'important');
    modal.style.setProperty('opacity', '0', 'important');

    // 创建浮动恢复按钮（避免重复创建）
    if (document.getElementById('star-qa-restore-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'star-qa-restore-btn';
    btn.className = 'star-qa-restore-btn';
    const savedTheme = extension_settings[PLUGIN_NAME]?.theme || 'light';
    if (savedTheme === 'dark') btn.dataset.starTheme = 'dark';
    btn.title = '恢复 AI 答疑';
    btn.innerHTML = '<i class="fa-solid fa-comment-dots"></i>';
    btn.addEventListener('click', () => {
        btn.remove();
        openQAPanel();
    });
    document.body.appendChild(btn);
}

/**
 * 渲染欢迎消息。
 */
function renderWelcomeMessage(body) {
    body.innerHTML = `
        <div class="star-qa-message star-qa-assistant">
            <div class="star-qa-bubble">
                <p>你好！👋 我是 <strong>Star 小助手</strong>，专门帮你解答「聊天收藏器」插件的使用问题。</p>
                <p>你可以问我：</p>
                <ul>
                    <li>如何收藏和取消收藏消息？</li>
                    <li>怎么给收藏添加备注？</li>
                    <li>预览模式是什么？</li>
                    <li>怎么切换暗色主题？</li>
                    <li>如何跨角色查看收藏？</li>
                </ul>
                <p>直接输入问题，我会尽力帮你解答！✨</p>
            </div>
        </div>
    `;
}

// =================================================================
//                      消息发送与 API 调用
// =================================================================

/**
 * 设置流式状态并更新 UI。
 */
function setStreamingState(modal, streaming) {
    isStreaming = streaming;
    const sendBtn = modal.querySelector(`.${QA_SEND_CLASS}`);
    const stopBtn = modal.querySelector(`.${QA_STOP_CLASS}`);
    const inputEl = modal.querySelector(`.${QA_INPUT_CLASS}`);

    if (streaming) {
        sendBtn.style.setProperty('display', 'none', 'important');
        stopBtn.style.setProperty('display', 'flex', 'important');
        inputEl.disabled = true;
    } else {
        sendBtn.style.setProperty('display', 'flex', 'important');
        stopBtn.style.setProperty('display', 'none', 'important');
        inputEl.disabled = false;
        inputEl.focus();
    }
}

/**
 * 停止当前流式生成。
 */
function stopStreaming() {
    if (streamAbortController) {
        streamAbortController.abort();
        streamAbortController = null;
    }
    isStreaming = false;

    const modal = document.getElementById(QA_MODAL_ID);
    if (modal) {
        setStreamingState(modal, false);

        // 移除残留的加载动画
        const body = modal.querySelector(`.${QA_BODY_CLASS}`);
        const typingEl = body.querySelector(`.${QA_TYPING_CLASS}`);
        if (typingEl) typingEl.remove();
    }
}

/**
 * 处理发送按钮点击。
 */
async function handleQASend(inputEl) {
    const message = inputEl.value.trim();
    if (!message || isStreaming) return;

    const modal = document.getElementById(QA_MODAL_ID);
    const body = modal.querySelector(`.${QA_BODY_CLASS}`);

    // 禁用输入
    setStreamingState(modal, true);
    inputEl.value = '';

    // 渲染用户消息
    appendQAMessage(body, 'user', message);

    // 渲染加载动画
    const typingEl = document.createElement('div');
    typingEl.className = `star-qa-message star-qa-assistant ${QA_TYPING_CLASS}`;
    typingEl.innerHTML = '<div class="star-qa-bubble"><span class="star-qa-dot"></span><span class="star-qa-dot"></span><span class="star-qa-dot"></span></div>';
    body.appendChild(typingEl);
    scrollQABody(body);

    // 检查 API 配置
    const settings = extension_settings[PLUGIN_NAME];
    if (!settings.qaApiEndpoint || !settings.qaApiKey) {
        typingEl.remove();
        appendQAMessage(body, 'assistant',
            '⚠️ 请先配置 API 接口！\n\n' +
            '点击答疑面板右上角 **齿轮图标** → 打开「AI答疑设置」，填入：\n' +
            '1. API 地址（OpenAI兼容格式，如 https://api.openai.com/v1/chat/completions）\n' +
            '2. API 密钥\n' +
            '3. 模型名称（可选，默认 gpt-3.5-turbo）'
        );
        setStreamingState(modal, false);
        return;
    }

    // 添加用户消息到历史
    conversationHistory.push({ role: 'user', content: message });

    try {
        const model = settings.qaModel || 'gpt-3.5-turbo';
        const useStream = true; // 最终版：固定启用流式传输

        // 移除加载动画
        typingEl.remove();

        // 创建一个空的助手消息气泡用于流式填充
        const assistantMsgEl = document.createElement('div');
        assistantMsgEl.className = 'star-qa-message star-qa-assistant';
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'star-qa-bubble';
        assistantMsgEl.appendChild(bubbleEl);
        body.appendChild(assistantMsgEl);
        scrollQABody(body);

        if (useStream) {
            await callQAApiStream(settings.qaApiEndpoint, settings.qaApiKey, model, conversationHistory, bubbleEl, body);
        } else {
            const response = await callQAApi(settings.qaApiEndpoint, settings.qaApiKey, model, conversationHistory);
            if (response && response.content) {
                // 思维链（reasoning_content）单独折叠展示，只有正文写入对话历史
                bubbleEl.innerHTML = formatQAContent(response.content, response.reasoning);
                conversationHistory.push({ role: 'assistant', content: response.content });
            } else {
                bubbleEl.innerHTML = '<p>抱歉，API 返回了空回复，请稍后重试。</p>';
            }
        }

        scrollQABody(body);

    } catch (error) {
        // 移除任何残留的加载动画
        const remainingTyping = body.querySelector(`.${QA_TYPING_CLASS}`);
        if (remainingTyping) remainingTyping.remove();

        let errorMsg = '请求失败：' + (error.message || '未知错误');
        if (error.name === 'AbortError') {
            errorMsg = '⏸️ 已停止生成';
        } else if (error.message && error.message.includes('Failed to fetch')) {
            errorMsg = '⚠️ 网络请求失败，请检查：\n1. API 地址是否正确\n2. 网络连接是否正常\n3. API 服务是否可用';
        } else if (error.message && error.message.includes('401')) {
            errorMsg = '⚠️ API 密钥无效（401 未授权），请检查密钥是否正确。';
        } else if (error.message && error.message.includes('429')) {
            errorMsg = '⚠️ API 请求过于频繁（429），请稍后重试。';
        }

        Logger.error('AI答疑API请求失败:', error);
        appendQAMessage(body, 'assistant', errorMsg);
    }

    setStreamingState(modal, false);
}

/**
 * 调用 OpenAI-compatible API（非流式）。
 * 返回 { content, reasoning }，reasoning 为 DeepSeek 等模型返回的思维链内容。
 */
async function callQAApi(endpoint, apiKey, model, messages) {
    const url = endpoint.trim().replace(/\/+$/, '');
    const finalUrl = url.endsWith('/chat/completions') ? url : url + '/chat/completions';

    const response = await fetch(finalUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
        }),
    });

    if (!response.ok) {
        throw new Error(`API 返回错误状态: ${response.status}`);
    }

    const data = await response.json();
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
        const message = data.choices[0].message;
        return {
            content: message.content || '',
            reasoning: message.reasoning_content || '',
        };
    }
    return null;
}

/**
 * 调用 OpenAI-compatible API（流式 SSE）。
 * 使用 fetch + ReadableStream 解析 SSE 事件。
 * 兼容 DeepSeek 的 reasoning_content 字段：思维链默认折叠展示，不写入对话历史。
 */
async function callQAApiStream(endpoint, apiKey, model, messages, bubbleEl, body) {
    const url = endpoint.trim().replace(/\/+$/, '');
    const finalUrl = url.endsWith('/chat/completions') ? url : url + '/chat/completions';

    // 创建 AbortController
    streamAbortController = new AbortController();

    let fullContent = '';
    let fullReasoning = '';

    try {
        const response = await fetch(finalUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                stream: true,
            }),
            signal: streamAbortController.signal,
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API 返回错误状态: ${response.status} — ${errorText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // 按行分割 SSE 数据
            const lines = buffer.split('\n');
            // 最后一个可能是不完整的行，留在 buffer
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;

                // SSE 格式: "data: {...}"
                if (trimmed.startsWith('data: ')) {
                    const jsonStr = trimmed.substring(6);

                    // 检查是否是 [DONE] 标记
                    if (jsonStr === '[DONE]') {
                        // 流结束
                        conversationHistory.push({ role: 'assistant', content: fullContent });
                        return;
                    }

                    try {
                        const data = JSON.parse(jsonStr);
                        const delta = data.choices?.[0]?.delta;
                        const contentDelta = delta?.content;
                        const reasoningDelta = delta?.reasoning_content;
                        if (reasoningDelta) {
                            fullReasoning += reasoningDelta;
                        }
                        if (contentDelta) {
                            fullContent += contentDelta;
                        }
                        if (contentDelta || reasoningDelta) {
                            // 流式重建会重置 details 的 open 状态：记住用户是否已展开内心独白，重建后保持
                            const reasoningEl = bubbleEl.querySelector('.star-qa-reasoning');
                            const wasOpen = reasoningEl ? reasoningEl.hasAttribute('open') : false;
                            // 实时更新气泡内容（内心独白折叠在顶部，正文在下）
                            bubbleEl.innerHTML = formatQAContent(fullContent, fullReasoning);
                            if (wasOpen) {
                                const el = bubbleEl.querySelector('.star-qa-reasoning');
                                if (el) el.setAttribute('open', '');
                            }
                            scrollQABody(body);
                        }

                        // 检查 finish_reason
                        const finishReason = data.choices?.[0]?.finish_reason;
                        if (finishReason === 'stop' || finishReason === 'length') {
                            conversationHistory.push({ role: 'assistant', content: fullContent });
                            return;
                        }
                    } catch (parseErr) {
                        // 某些实现可能发送非标准 JSON，忽略解析错误继续
                    }
                }
            }
        }

        // 正常结束（reader done 但没有 [DONE] 标记）
        if (fullContent) {
            conversationHistory.push({ role: 'assistant', content: fullContent });
        }
    } finally {
        streamAbortController = null;
    }
}

// =================================================================
//                      UI 辅助函数
// =================================================================

/**
 * 追加一条消息到面板（非流式）。
 */
function appendQAMessage(body, role, content) {
    const roleClass = role === 'user' ? 'star-qa-user' : 'star-qa-assistant';
    const messageEl = document.createElement('div');
    messageEl.className = `star-qa-message ${roleClass}`;
    messageEl.innerHTML = `<div class="star-qa-bubble">${formatQAContent(content)}</div>`;
    body.appendChild(messageEl);
    scrollQABody(body);
}

/**
 * 格式化消息内容。
 * 支持：
 * - reasoning（思维链/内心独白）默认折叠展示，点击展开
 * - 正文中的 ＜think＞...＜/think＞ 或 <think>...</think> 思维标记：默认折叠为思维链，且不显示在正文中
 * - 标题、粗体、斜体、行内代码、代码块、列表、引用、链接、水平线
 */
function formatQAContent(text, reasoning = '') {
    // 提取正文中的思维标记（支持 <think>…</think> 与 ＜think＞…＜/think＞ 全半角两种写法）
    let extraReasoning = '';
    text = text.replace(/<think>([\s\S]*?)<\/think>|＜think＞([\s\S]*?)＜\/think＞/g, (_, a, b) => {
        extraReasoning += (a ?? b ?? '');
        return '';
    });

    // 拼接 API 返回的思维链（reasoning_content）与正文中的思维标记
    const chainParts = [reasoning, extraReasoning].filter(p => p && p.trim());
    const chainHtml = chainParts.length > 0
        ? `<details class="star-qa-reasoning">
            <summary class="star-qa-reasoning-summary">
                <span class="star-qa-reasoning-icon"><i class="fa-solid fa-brain"></i></span>
                <span class="star-qa-reasoning-label">内心独白</span>
                <span class="star-qa-reasoning-hint">点击查看思考过程</span>
                <i class="fa-solid fa-chevron-right star-qa-reasoning-arrow"></i>
            </summary>
            <div class="star-qa-reasoning-content">${renderMarkdown(chainParts.join('\n\n'))}</div>
          </details>`
        : '';

    // 正文为空时（纯思维链回复）仍保留一个空的正文容器，避免布局错位
    return chainHtml + `<div class="star-qa-answer">${renderMarkdown(text)}</div>`;
}

/**
 * 将纯文本按增强 Markdown 规则渲染为 HTML。
 * 支持：标题、粗体、斜体、行内代码、代码块、列表、引用、链接、水平线
 */
function renderMarkdown(text) {
    if (!text) return '';

    // 1. 保护代码块（先处理，避免被后续规则影响）
    const codeBlocks = [];
    let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        // 转义 HTML 实体
        const escaped = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const langClass = lang ? ` class="language-${lang}"` : '';
        codeBlocks.push(`<pre><code${langClass}>${escaped}</code></pre>`);
        return `\u0000CB${idx}\u0000`;
    });

    // 2. 保护行内代码
    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        const idx = inlineCodes.length;
        const escaped = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        inlineCodes.push(`<code>${escaped}</code>`);
        return `\u0000IC${idx}\u0000`;
    });

    // 3. HTML 转义（排除占位符）
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 4. 粗体 **text** 和斜体 *text*
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 5. 链接 [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 6. 按行处理：标题、列表、引用、水平线
    const lines = html.split('\n');
    const result = [];
    let inUl = false;
    let inOl = false;
    let inBlockquote = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        const trimmed = line.trim();

        // 标题
        const hMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (hMatch) {
            if (inUl) { result.push('</ul>'); inUl = false; }
            if (inOl) { result.push('</ol>'); inOl = false; }
            if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
            const level = hMatch[1].length;
            result.push(`<h${level}>${hMatch[2]}</h${level}>`);
            continue;
        }

        // 水平线
        if (/^[-*_]{3,}\s*$/.test(trimmed)) {
            if (inUl) { result.push('</ul>'); inUl = false; }
            if (inOl) { result.push('</ol>'); inOl = false; }
            if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
            result.push('<hr>');
            continue;
        }

        // 引用
        const bqMatch = trimmed.match(/^>\s?(.*)$/);
        if (bqMatch) {
            if (inUl) { result.push('</ul>'); inUl = false; }
            if (inOl) { result.push('</ol>'); inOl = false; }
            if (!inBlockquote) { result.push('<blockquote>'); inBlockquote = true; }
            result.push(bqMatch[1] || '<br>');
            continue;
        }

        // 有序列表
        const olMatch = trimmed.match(/^(\d+)[.)]\s+(.+)$/);
        if (olMatch) {
            if (inUl) { result.push('</ul>'); inUl = false; }
            if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
            if (!inOl) { result.push('<ol>'); inOl = true; }
            result.push(`<li>${olMatch[2]}</li>`);
            continue;
        }

        // 无序列表
        const ulMatch = trimmed.match(/^[-*+]\s+(.+)$/);
        if (ulMatch) {
            if (inOl) { result.push('</ol>'); inOl = false; }
            if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
            if (!inUl) { result.push('<ul>'); inUl = true; }
            result.push(`<li>${ulMatch[1]}</li>`);
            continue;
        }

        // 空行
        if (trimmed === '') {
            if (inUl) { result.push('</ul>'); inUl = false; }
            if (inOl) { result.push('</ol>'); inOl = false; }
            if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
            result.push('<br>');
            continue;
        }

        // 普通段落行
        if (inUl) { result.push('</ul>'); inUl = false; }
        if (inOl) { result.push('</ol>'); inOl = false; }
        if (inBlockquote) { result.push('</blockquote>'); inBlockquote = false; }
        result.push(line);
    }

    if (inUl) result.push('</ul>');
    if (inOl) result.push('</ol>');
    if (inBlockquote) result.push('</blockquote>');

    html = result.join('\n');

    // 7. 恢复行内代码
    html = html.replace(/\u0000IC(\d+)\u0000/g, (_, idx) => inlineCodes[parseInt(idx)]);
    // 8. 恢复代码块
    html = html.replace(/\u0000CB(\d+)\u0000/g, (_, idx) => codeBlocks[parseInt(idx)]);

    return html;
}

/**
 * 滚动面板到底部。
 */
function scrollQABody(body) {
    requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight;
    });
}

/**
 * 居中答疑弹窗。
 */
function centerQAModal(modal) {
    const container = modal.querySelector(`.${QA_CONTAINER_CLASS}`);
    if (!container) return;
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    const dw = container.offsetWidth;
    const dh = container.offsetHeight;
    container.style.left = `${Math.max(0, (ww - dw) / 2)}px`;
    container.style.top = `${Math.max(0, (wh - dh) / 2)}px`;
}

/**
 * 应用主题到答疑面板和浮动按钮。
 */
export function applyQATheme() {
    const modal = document.getElementById(QA_MODAL_ID);
    if (modal) {
        const container = modal.querySelector(`.${QA_CONTAINER_CLASS}`);
        if (container) {
            const savedTheme = extension_settings[PLUGIN_NAME]?.theme || 'light';
            if (savedTheme === 'dark') {
                container.setAttribute('data-star-theme', 'dark');
            } else {
                container.removeAttribute('data-star-theme');
            }
        }
    }
}

/**
 * 清空对话（供外部调用）。
 */
export function resetQAChat() {
    resetConversation();
    const modal = document.getElementById(QA_MODAL_ID);
    if (modal) {
        const body = modal.querySelector(`.${QA_BODY_CLASS}`);
        if (body) {
            body.innerHTML = '';
            renderWelcomeMessage(body);
        }
    }
}

// =================================================================
//                      AI答疑设置弹窗
// =================================================================

/**
 * HTML 转义辅助函数。
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 显示 AI 答疑 API 配置弹窗。
 * 设置修改后自动保存（防抖），无需手动点击"保存设置"。
 */
export function showQASettingsPopup() {
    const existing = document.getElementById('star-qa-settings-overlay');
    if (existing) existing.remove();

    const settings = extension_settings[PLUGIN_NAME];
    const currentEndpoint = settings.qaApiEndpoint || '';
    const currentKey = settings.qaApiKey || '';
    const currentModel = settings.qaModel || 'gpt-3.5-turbo';

    const overlay = document.createElement('div');
    overlay.id = 'star-qa-settings-overlay';
    overlay.className = 'star-qa-settings-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'star-qa-settings-dialog';
    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        dialog.dataset.starTheme = 'dark';
    }
    dialog.innerHTML = `
        <div class="star-qa-settings-header">
            <div class="star-qa-settings-title">🤖 AI答疑设置</div>
            <div class="star-qa-settings-close"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="star-qa-settings-body">
            <div class="star-qa-settings-desc">
                <p>配置 OpenAI 兼容的 API 接口，启用内置的 <strong>Star 小助手</strong> 来解答插件使用问题。</p>
                <p>支持任何兼容 OpenAI Chat Completions 格式的 API（如 OpenAI、硅基流动、DeepSeek、Ollama 等）。</p>
                <hr>
                <p><strong>注意：</strong>API 密钥仅存储在本地浏览器中，不会上传到任何第三方服务器。</p>
                <p><strong>提示：</strong>修改以下设置后会自动保存，无需手动点击保存按钮。</p>
            </div>
            <div class="star-qa-settings-field">
                <label for="star-qa-endpoint">API 地址</label>
                <input type="text" id="star-qa-endpoint" class="star-qa-settings-input"
                    placeholder="https://api.openai.com/v1/chat/completions"
                    value="${escapeHtml(currentEndpoint)}">
                <span class="star-qa-settings-hint">支持 /chat/completions 完整路径或 base URL</span>
            </div>
            <div class="star-qa-settings-field">
                <label for="star-qa-key">API 密钥</label>
                <input type="password" id="star-qa-key" class="star-qa-settings-input"
                    placeholder="sk-..."
                    value="${escapeHtml(currentKey)}">
                <span class="star-qa-settings-hint">密钥不会显示明文，输入后请妥善保管</span>
            </div>
            <div class="star-qa-settings-field">
                <label for="star-qa-model">模型名称</label>
                <input type="text" id="star-qa-model" class="star-qa-settings-input"
                    placeholder="gpt-3.5-turbo"
                    value="${escapeHtml(currentModel)}">
                <span class="star-qa-settings-hint">如 gpt-3.5-turbo、gpt-4o、deepseek-chat、qwen-turbo 等</span>
            </div>
            <div class="star-qa-settings-saved" id="star-qa-settings-saved-tip">✅ 设置已自动保存</div>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const centerDialog = () => {
        const ww = window.innerWidth;
        const wh = window.innerHeight;
        const dw = dialog.offsetWidth;
        const dh = dialog.offsetHeight;
        dialog.style.left = `${Math.max(0, (ww - dw) / 2)}px`;
        dialog.style.top = `${Math.max(0, (wh - dh) / 2)}px`;
    };

    centerDialog();
    window.addEventListener('resize', centerDialog);

    const closeOverlay = () => {
        window.removeEventListener('resize', centerDialog);
        overlay.style.setProperty('opacity', '0', 'important');
        setTimeout(() => overlay.remove(), 300);
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
    });
    dialog.querySelector('.star-qa-settings-close').addEventListener('click', closeOverlay);

    // ==========================================
    // 自动保存（防抖）：输入/切换即保存，无手动保存按钮
    // ==========================================
    const savedTip = dialog.querySelector('#star-qa-settings-saved-tip');
    let savedTipTimer = null;

    const showSavedTip = () => {
        savedTip.classList.add('show');
        clearTimeout(savedTipTimer);
        savedTipTimer = setTimeout(() => savedTip.classList.remove('show'), 1800);
    };

    const endpointEl = dialog.querySelector('#star-qa-endpoint');
    const keyEl = dialog.querySelector('#star-qa-key');
    const modelEl = dialog.querySelector('#star-qa-model');

    // 防抖保存：文本输入 500ms 无操作后保存
    let saveTimer = null;
    const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            settings.qaApiEndpoint = endpointEl.value.trim();
            settings.qaApiKey = keyEl.value.trim();
            settings.qaModel = modelEl.value.trim() || 'gpt-3.5-turbo';
            saveSettingsDebounced();
            Logger.debug('AI答疑设置已自动保存');
            showSavedTip();
        }, 500);
    };

    endpointEl.addEventListener('input', scheduleSave);
    keyEl.addEventListener('input', scheduleSave);
    modelEl.addEventListener('input', scheduleSave);

    // 显示弹窗：直接设置 opacity 为 1（不使用 CSS transition，避免 !important 冲突）
    overlay.style.setProperty('opacity', '1', 'important');
}