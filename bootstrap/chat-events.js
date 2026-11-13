// bootstrap/chat-events.js - SillyTavern 核心事件与聊天区 DOM 监听
//
// 集中处理「聊天数据变化 → 收藏图标/缓存同步」这条链路：
//   - CHAT_CHANGED：退出预览、取消后台任务、重算缓存、补图标
//   - MESSAGE_DELETED：同步删除收藏
//   - MESSAGE_RECEIVED/SENT/SWIPED/UPDATED/MORE_MESSAGES_LOADED：补/刷新图标
//   - MutationObserver：兜底 ST 自身重渲染导致的图标丢失
//   - 收藏图标点击 / 长按编辑备注（事件委托，动态重建的 DOM 无需重新绑定）
//
// 所有 DOM 相关回调统一 150ms 防抖：既避免高频事件（流式输出、批量加载）反复全量遍历 #chat，
// 又保证图标在一个可感知的时延内补上。

import { eventSource, event_types } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { state } from '../state.js';
import { stripJsonlExt } from '../utils.js';
import {
    ensureFavoritesArrayExists,
    ensureCurrentChatIsCached,
    addFavoriteIconsToMessages,
    refreshFavoriteIconsInView,
    syncCurrentChatFavoritesIndex,
    replayPendingFavoritePatchForCurrentChat,
    handleEditNoteFromChat,
} from '../core.js';
import { abortMigration } from '../migration.js';
import { runCancellers, getCoreHooks } from '../hooks.js';
import Logger from '../Logger.js';

const DOM_SYNC_DELAY = 150;      // DOM 相关的收藏图标同步统一防抖时长
const LONG_PRESS_MS = 600;       // 收藏图标长按（编辑备注）判定时长

export function registerChatEvents() {
    registerChatChanged();
    registerMessageEvents();
    registerFavoriteIconInteractions();
    observeChatDom();
}

// ==================== 聊天切换 ====================

function registerChatChanged() {
    eventSource.on(event_types.CHAT_CHANGED, async () => {
        // 预览模式必须退出：预览时收藏操作作用于 currentViewingChatFile，切换聊天后语境已变。
        // 按需加载：只有真的进过预览（因此预览模块已加载）才会命中，不会把 UI 拉进启动路径。
        if (state.isPreviewingContext) {
            try {
                const { exitPreviewMode } = await import('../ui/preview.js');
                await exitPreviewMode();
            } catch (error) {
                // 模块解析失败时同步复位标记，避免插件永久停在「预览中」（收藏快捷键会全部失效）
                Logger.error('退出预览模式失败:', error);
                state.isPreviewingContext = false;
                state.previewingChatFile = null;
            }
        }

        // 取消进行中的后台任务（收藏面板的其他聊天加载、角色切换器预加载/扫描）
        runCancellers('chat-changed');
        // 切换上下文时中止进行中的数据迁移（迁移中的聊天身份已变化，避免误存到新角色目录）
        abortMigration();

        // 防抖窗口内聊天被 ST 重载（同一聊天）：内存数组已被文件内容替换，
        // 必须把待落库的收藏补丁重放回来，否则这次改动会随重载丢失。
        await replayPendingFavoritePatchForCurrentChat();

        ensureFavoritesArrayExists();
        ensureCurrentChatIsCached();

        setTimeout(() => {
            addFavoriteIconsToMessages();
            refreshFavoriteIconsInView();
        }, DOM_SYNC_DELAY);
    });
}

// ==================== 消息增删改 ====================

function registerMessageEvents() {
    // 参数语义注意：ST 发的是 `eventSource.emit(MESSAGE_DELETED, chat.length)`
    // （见 public/script.js 的 deleteMessage），即**删除后的消息条数**，不是被删那条的下标。
    // 拿它当 messageId 去查收藏永远是查不到的（该下标必然越界），所以这里不这么做：
    // 收藏跟随消息一起消失，索引重算统一交给 syncCurrentChatFavoritesIndex()——
    // 它按删除后的真实消息数组现算，无论 ST 传什么都不会算错。
    eventSource.on(event_types.MESSAGE_DELETED, (chatLengthAfterDelete) => {
        Logger.debug(`监听到消息删除，删除后条数: ${chatLengthAfterDelete}`);
        const chatMetadata = ensureFavoritesArrayExists();
        if (!chatMetadata) return;

        // 消息被删后收藏随之消失，removeFavoriteById 已找不到目标；不重算的话实时
        // favorites_count 会停在删除前的值，ST 之后保存聊天就把它写进文件
        // （表现为「已无收藏却显示 1 条」）。
        syncCurrentChatFavoritesIndex();

        // 面板开着且正显示当前聊天 → 让面板自行重渲染（钩子由 ui/main.js 在加载时注入，
        // 面板未加载时 state.modalElement 为空，本分支自然不会进入）
        const context = getContext();
        if (state.modalElement && state.modalElement.classList.contains('visible')
            && state.currentViewingChatFile === stripJsonlExt(context.chatId || '')) {
            const refresh = getCoreHooks().refreshFavoritesView;
            if (typeof refresh === 'function') {
                Promise.resolve(refresh(state.currentViewingChatFile))
                    .catch(err => Logger.debug('重渲染收藏面板失败:', err));
            }
        }
        setTimeout(refreshFavoriteIconsInView, DOM_SYNC_DELAY);
    });

    const handleNewMessage = () => setTimeout(() => {
        if (!state.isPreviewingContext) addFavoriteIconsToMessages();
    }, DOM_SYNC_DELAY);
    eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
    eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);

    // 定向刷新当前 swipe 的消息图标，避免全量遍历 #chat（消息多时卡顿）
    const handleMessageUpdate = (messageId) => setTimeout(() => {
        if (!state.isPreviewingContext) refreshFavoriteIconsInView(String(messageId));
    }, DOM_SYNC_DELAY);
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdate);

    eventSource.on(event_types.MORE_MESSAGES_LOADED, () => setTimeout(() => {
        if (!state.isPreviewingContext) {
            addFavoriteIconsToMessages();
            refreshFavoriteIconsInView();
        }
    }, DOM_SYNC_DELAY));
}

// ==================== 收藏图标交互（事件委托） ====================

function registerFavoriteIconInteractions() {
    let longPressTimeout;
    let isLongPress = false;

    $(document)
        .on('mousedown touchstart', '.favorite-toggle-icon', function (event) {
            if (event.type === 'touchstart') {
                event.preventDefault();
            }

            const self = this;
            isLongPress = false;
            longPressTimeout = setTimeout(() => {
                isLongPress = true;
                handleEditNoteFromChat(self);
            }, LONG_PRESS_MS);
        })
        .on('mouseup mouseleave touchend touchcancel', '.favorite-toggle-icon', () => {
            clearTimeout(longPressTimeout);
        })
        .on('click', '.favorite-toggle-icon', async function (event) {
            // 长按已触发时，阻止随后的 click 再次切换收藏状态
            if (isLongPress) {
                isLongPress = false;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            try {
                const { handleFavoriteToggle } = await import('../ui/favorite-icon.js');
                await handleFavoriteToggle($(this));
            } catch (error) {
                Logger.error('收藏图标点击处理失败:', error);
                toastr.error('收藏操作失败，请刷新页面或检查扩展文件是否完整');
            }
        });
}

// ==================== 聊天区 DOM 变化兜底 ====================

function observeChatDom() {
    const chatElement = document.getElementById('chat');
    if (!chatElement) return;

    let domSyncTimer = null;
    const chatObserver = new MutationObserver((mutations) => {
        if (state.isPreviewingContext) return;
        if (!mutations.some(m => m.addedNodes.length > 0)) return;

        // 与其余事件处理保持一致：150ms 防抖 + 全量补图标
        // （流式输出期间 ST 会高频重建消息 DOM，逐次 rAF 全量遍历 #chat 代价过高）
        clearTimeout(domSyncTimer);
        domSyncTimer = setTimeout(addFavoriteIconsToMessages, DOM_SYNC_DELAY);
    });
    chatObserver.observe(chatElement, { childList: true });
}
