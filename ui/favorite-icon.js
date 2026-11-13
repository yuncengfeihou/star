// ui/favorite-icon.js - 聊天区收藏图标的点击切换
//
// 特意保持「轻」：用户在聊天消息上点一下星标，不应该触发收藏面板那一整条 UI 依赖链
// （因此本模块只依赖 core/state/utils，不依赖 ui/main.js）。
// 长按编辑备注与图标的注入分别由 bootstrap/chat-events.js 与 core.js 负责。

import { getContext } from '../../../../extensions.js';
import { state, findChatData, resolveChatAreaTargetChatFile } from '../state.js';
import { stripJsonlExt } from '../utils.js';
import {
    ensureCurrentChatIsCached,
    ensureFavoritesArrayExists,
    addFavorite,
    removeFavoriteById,
} from '../core.js';
import Logger from '../Logger.js';

/**
 * 切换某条消息当前 swipe 的收藏状态。
 * @param {JQuery} $target - .favorite-toggle-icon 元素
 */
export async function handleFavoriteToggle($target) {
    Logger.debug('触发收藏切换');
    ensureCurrentChatIsCached();

    if (!$target || !$target.length) return;
    const messageElement = $target.closest('.mes');
    if (!messageElement || !messageElement.length) return;

    const messageIdString = messageElement.attr('mesid');
    if (!messageIdString) return;

    let context;
    try {
        context = getContext();
    } catch (e) {
        return;
    }

    const targetChatFile = resolveChatAreaTargetChatFile();
    if (!targetChatFile) return;

    // 获取正确的聊天数据
    let chatData = null;
    let currentChatMetadata;
    if (state.isPreviewingContext) {
        chatData = findChatData(targetChatFile);
        if (!chatData) {
            toastr.error('无法在预览模式下切换收藏状态');
            return;
        }
        currentChatMetadata = chatData.metadata;
    } else {
        currentChatMetadata = ensureFavoritesArrayExists();
    }
    if (!currentChatMetadata) return;

    // 当前聊天一律以 ST 的 context.chat 为准，与 core.js 的写入目标保持一致：
    // 缓存里的 messages 可能是上一次保存后的深拷贝，用副本判断「是否已收藏」会与实际
    // 写入的数组脱节（表现为取消收藏点了没反应，或者反而又收藏了一次）。
    const currentChatFile = stripJsonlExt(context.chatId || '');
    const messages = (targetChatFile !== currentChatFile)
        ? chatData.messages
        : context.chat;
    const message = messages[parseInt(messageIdString, 10)];
    if (!message) return;

    const swipeId = message.swipe_id || 0;
    const isCurrentlyFavorited = !!(message.swipe_info?.[swipeId]?.star_favorite);

    if (!isCurrentlyFavorited) {
        $target.addClass('favorited');
        // 写入失败（如预览缓存缺失）时回滚图标，避免界面与真实数据不一致
        if (!addFavorite({ messageId: messageIdString, sender: message.name, role: message.is_user ? 'user' : 'character' }, targetChatFile)) {
            $target.removeClass('favorited');
        }
    } else {
        $target.removeClass('favorited');
        if (!removeFavoriteById(message.swipe_info[swipeId].star_favorite.id, targetChatFile)) {
            $target.addClass('favorited');
        }
    }
}
