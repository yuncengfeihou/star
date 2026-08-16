// core.js - 核心业务逻辑模块（收藏增删改查）

import { getContext, saveMetadataDebounced } from '../../../extensions.js';
import { uuidv4, timestampToMoment } from '../../../utils.js';
import { reloadCurrentChat, getRequestHeaders, chat } from '../../../../script.js';
import { state, PLUGIN_NAME } from './state.js';
import { saveSpecificChatMetadata } from './api.js';
import Logger from './Logger.js';

/**
 * 将基于 message.swipe_info.star_favorite 的数据，构建为 UI 层所需的虚拟 favorites 数组。
 */
export function buildVirtualFavorites(messages) {
    let extractedFavorites = [];
    (messages || []).forEach((msg, index) => {
        // 抛弃 msg.extra，直接深入 ST 底层的 msg.swipe_info 寻找我们写入的 star_favorite 对象
        if (!msg || !msg.swipe_info) return;

        let favoritedSwipes = [];
        // 安全遍历所有的 swipe_info
        for (let sId = 0; sId < msg.swipe_info.length; sId++) {
            const info = msg.swipe_info[sId];
            if (info && info.star_favorite) {
                favoritedSwipes.push({
                    swipeId: String(sId),
                    ...info.star_favorite
                });
            }
        }

        if (favoritedSwipes.length > 0) {
            favoritedSwipes.sort((a, b) => a.create_date - b.create_date);
            extractedFavorites.push({
                id: favoritedSwipes[0].id,
                messageId: String(index),
                sender: msg.name || 'Unknown',
                role: msg.is_user ? 'user' : 'character',
                note: favoritedSwipes[0].note || '',
                favoritedSwipes: favoritedSwipes,
                currentSwipeViewIndex: 0
            });
        }
    });
    return extractedFavorites;
}

const messageButtonHtml = `
    <div class="mes_button favorite-toggle-icon interactable" title="收藏/取消收藏 (长按编辑备注)" tabindex="0">
        <i class="fa-solid fa-star"></i>
    </div>
`;

// ==================== 核心业务逻辑函数 ====================

/**
 * 确保当前聊天已缓存。
 * 防止在打开模态框前收藏时出现"chat cache not found"错误。
 */
export function ensureCurrentChatIsCached() {
    try {
        const context = getContext();
        if (!context || !context.chatId) return;

        const currentContextChatIdNoExt = String(context.chatId).replace('.jsonl', '');

        const isAlreadyCached = state.allChatsFavoritesData.some(
            chatData => String(chatData.fileName).replace('.jsonl', '') === currentContextChatIdNoExt
        );

        if (isAlreadyCached) {
            return;
        }

        const currentChatMetadata = ensureFavoritesArrayExists() || { favorites: [] };

        const newCacheEntry = {
            fileName: currentContextChatIdNoExt,
            displayName: currentContextChatIdNoExt,
            metadata: currentChatMetadata,
            favorites: currentChatMetadata.favorites || [],
            messages: context.chat || [],
            isGroup: !!context.groupId,
            characterId: context.characterId,
            groupId: context.groupId,
        };

        state.allChatsFavoritesData.push(newCacheEntry);
        Logger.info(`已缓存新聊天数据: ${currentContextChatIdNoExt}`);

    } catch (error) {
        Logger.error('缓存当前聊天失败:', error);
    }
}

/**
 * 确保当前上下文中包含虚拟的 favorites 数组，兼容旧的同步读取方式。
 */
export function ensureFavoritesArrayExists() {
    let context;
    try {
        context = getContext();
        if (!context || !context.chatMetadata) return null;
    } catch (e) {
        return null;
    }
    context.chatMetadata.favorites = buildVirtualFavorites(context.chat);
    return context.chatMetadata;
}

/**
 * 添加收藏（直接写入 message.swipe_info）。
 */
export function addFavorite(messageInfo, targetChatFile = null) {
    Logger.debug(`addFavorite: msgId=${messageInfo.messageId}, targetChat=${targetChatFile || '(当前)'}`);
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : (state.currentViewingChatFile || currentContextChatIdNoExt);

    const chatDataInCache = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
    const messagesArray = chatDataInCache ? chatDataInCache.messages : context.chat;

    if (!messagesArray) {
        Logger.warn('addFavorite: 消息数组为空');
        return null;
    }

    const msgIndex = parseInt(messageInfo.messageId, 10);
    const message = messagesArray[msgIndex];
    if (!message) {
        Logger.warn(`addFavorite: 未找到索引 ${msgIndex} 的消息`);
        return null;
    }

    const swipeId = message.swipe_id || 0;
    // 如果 ST 因为意外未初始化 swipe_info，我们需要防御性补全
    if (!message.swipe_info) message.swipe_info = [];
    if (!message.swipe_info[swipeId]) message.swipe_info[swipeId] = {};

    if (message.swipe_info[swipeId].star_favorite) {
        Logger.debug('addFavorite: 该 swipe 已收藏，跳过');
        return message.swipe_info[swipeId].star_favorite;
    }

    const newItem = {
        id: uuidv4(),
        note: '',
        create_date: Date.now()
    };
    // 直接存入 ST 原生的 swipe_info 中，ST 删 swipe 时，连带引索和文本一起火化
    message.swipe_info[swipeId].star_favorite = newItem;
    Logger.success(`addFavorite: 收藏成功, favId=${newItem.id}, msgId=${messageInfo.messageId}`);
    // 收藏数变化，标记角色切换器缓存过期，下次打开重新扫描
    state.charactersCacheStale = true;

    const virtualFavs = buildVirtualFavorites(messagesArray);
    if (chatDataInCache) {
        chatDataInCache.favorites = virtualFavs;
        if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
    }

    if (chatFileToModify === currentContextChatIdNoExt) {
        context.chatMetadata.favorites = virtualFavs;
        saveMetadataDebounced();
    } else {
        saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray);
    }

    return newItem;
}

export function addFavoriteLogic() {
    // 已弃用
}

/**
 * 通过唯一 ID 遍历删除 swipe_info 中的收藏。
 */
export function removeFavoriteById(favoriteId, targetChatFile = null) {
    Logger.debug(`removeFavoriteById: favId=${favoriteId}, targetChat=${targetChatFile || '(当前)'}`);
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : (state.currentViewingChatFile || currentContextChatIdNoExt);

    const chatDataInCache = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
    const messagesArray = chatDataInCache ? chatDataInCache.messages : context.chat;
    if (!messagesArray) {
        Logger.warn('removeFavoriteById: 消息数组为空');
        return false;
    }

    let removed = false;
    for (let i = 0; i < messagesArray.length; i++) {
        const msg = messagesArray[i];
        if (msg && msg.swipe_info) {
            for (let sId = 0; sId < msg.swipe_info.length; sId++) {
                const info = msg.swipe_info[sId];
                if (info && info.star_favorite && info.star_favorite.id === favoriteId) {
                    delete info.star_favorite; // 物理删除该 Swipe 对应的收藏
                    removed = true;
                    break;
                }
            }
        }
        if (removed) break;
    }

    if (removed) {
        Logger.success(`removeFavoriteById: 删除成功, favId=${favoriteId}`);
        // 收藏数变化，标记角色切换器缓存过期
        state.charactersCacheStale = true;
        const virtualFavs = buildVirtualFavorites(messagesArray);
        if (chatDataInCache) {
            chatDataInCache.favorites = virtualFavs;
            if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
        }

        if (chatFileToModify === currentContextChatIdNoExt) {
            context.chatMetadata.favorites = virtualFavs;
            saveMetadataDebounced();
        } else {
            saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray);
        }
    } else {
        Logger.warn(`removeFavoriteById: 未找到 favId=${favoriteId}`);
    }
    return removed;
}

/**
 * 更新收藏备注。
 */
export function updateFavoriteNote(favoriteId, note, targetChatFile = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : (state.currentViewingChatFile || currentContextChatIdNoExt);

    const chatDataInCache = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
    const messagesArray = chatDataInCache ? chatDataInCache.messages : context.chat;
    if (!messagesArray) return;

    let updated = false;
    for (let i = 0; i < messagesArray.length; i++) {
        const msg = messagesArray[i];
        if (msg && msg.swipe_info) {
            for (let sId = 0; sId < msg.swipe_info.length; sId++) {
                const info = msg.swipe_info[sId];
                if (info && info.star_favorite && info.star_favorite.id === favoriteId) {
                    info.star_favorite.note = note;
                    updated = true;
                    break;
                }
            }
        }
        if (updated) break;
    }

    if (updated) {
        // 备注内容变化，标记角色切换器缓存过期（缓存的 messages 里有旧备注）
        state.charactersCacheStale = true;
        const virtualFavs = buildVirtualFavorites(messagesArray);
        if (chatDataInCache) {
            chatDataInCache.favorites = virtualFavs;
            if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
        }
        if (chatFileToModify === currentContextChatIdNoExt) {
            context.chatMetadata.favorites = virtualFavs;
            saveMetadataDebounced();
        } else {
            saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray);
        }
    }
}

/**
 * 从弹窗取消收藏。
 */
export async function handleDeleteFavoriteFromPopup(favId, messageId, targetChatFile = null) {
    const chatFileForDeletion = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : state.currentViewingChatFile;
    try {
        const { showConfirmModal } = await import('./ui/index.js');
        const confirmResult = await showConfirmModal('确定要取消这条收藏吗？', '确认取消', { hideHeader: true, noBorder: true });
        if (confirmResult) {
            const removed = removeFavoriteById(favId, chatFileForDeletion);
            if (removed) {
                // 这个函数需要在 ui.js 中导入
                const { renderFavoritesView } = await import('./ui/index.js');
                await renderFavoritesView(state.currentViewingChatFile);

                const context = getContext();
                if (String(chatFileForDeletion).replace('.jsonl', '') === String(context.chatId || '').replace('.jsonl', '')) {
                    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
                    if (messageElement.length) {
                        messageElement.find('.favorite-toggle-icon').removeClass('favorited');
                    }
                }
                toastr.success('收藏已取消');
            } else {
                toastr.error('取消收藏失败');
            }
        }
    } catch (error) {
        Logger.error('deleting favorite:', error);
        toastr.error('取消收藏时发生错误');
    }
}

/**
 * 编辑消息原文。
 */
export async function handleEditMessageContent(favId, messageId, targetChatFile = null, swipeId = null) {
    const chatFileToModify = String(targetChatFile).replace('.jsonl', '');

    const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
    if (!chatData || !Array.isArray(chatData.messages)) {
        toastr.error('错误：找不到此收藏对应的聊天数据缓存。');
        return;
    }

    const msgIndex = parseInt(messageId, 10);
    if (isNaN(msgIndex) || msgIndex < 0 || msgIndex >= chatData.messages.length) {
        toastr.error(`错误：消息索引无效 (${messageId})。`);
        return;
    }

    const messageToEdit = chatData.messages[msgIndex];
    const targetSwipeId = swipeId !== null ? swipeId : (messageToEdit.swipe_id || 0);

    let originalContent = messageToEdit.mes;
    if (messageToEdit.swipes && messageToEdit.swipes[targetSwipeId] !== undefined) {
        originalContent = messageToEdit.swipes[targetSwipeId];
    }

    // 获取内心独白（reasoning）内容
    const originalReasoning = (messageToEdit.extra && messageToEdit.extra.reasoning) ? messageToEdit.extra.reasoning : '';

    const { showEditorModal } = await import('./ui/index.js');
    const result = await showEditorModal('编辑消息原文', originalContent, {
        reasoningContent: originalReasoning
    });

    if (result === null) {
        return;
    }

    // 兼容旧格式（纯文本）和新格式（{content, reasoning}）
    let newContent, newReasoning;
    if (typeof result === 'object' && result !== null) {
        newContent = result.content;
        newReasoning = result.reasoning;
    } else {
        newContent = result;
        newReasoning = originalReasoning;
    }

    // 检查是否有实际修改
    if (newContent === originalContent && newReasoning === originalReasoning) {
        return;
    }

    if (newContent !== originalContent) {
        if (messageToEdit.swipes && messageToEdit.swipes[targetSwipeId] !== undefined) {
            messageToEdit.swipes[targetSwipeId] = newContent;
            // 核心修复：如果修改的正是当前激活的 swipe，我们需要同步修改 msg.mes，确保 ST 在页面上渲染正确的内容
            if (String(targetSwipeId) === String(messageToEdit.swipe_id || 0)) {
                messageToEdit.mes = newContent;
            }
        } else {
            messageToEdit.mes = newContent;
        }
    }

    // 保存内心独白
    if (newReasoning !== originalReasoning) {
        if (!messageToEdit.extra) messageToEdit.extra = {};
        if (newReasoning.trim() === '') {
            delete messageToEdit.extra.reasoning;
        } else {
            messageToEdit.extra.reasoning = newReasoning;
        }
    }

    try {
        await saveSpecificChatMetadata(chatFileToModify, chatData.metadata, chatData.messages);
        const changedParts = [];
        if (newContent !== originalContent) changedParts.push('原文');
        if (newReasoning !== originalReasoning) changedParts.push('内心独白');
        toastr.success(`消息${changedParts.join('和')}已成功修改并保存！`);
        const { renderFavoritesView } = await import('./ui/index.js');
        await renderFavoritesView(state.currentViewingChatFile);

        const context = getContext();
        const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
        if (chatFileToModify === currentContextChatIdNoExt) {
            await reloadCurrentChat();
        }
    } catch (error) {
        messageToEdit.mes = originalContent;
        Logger.error('Failed to save edited message content:', error);
        toastr.error('保存修改失败，请检查控制台获取更多信息。');
    }
}

/**
 * 编辑备注。
 */
export async function handleEditNote(favId, targetChatFile = null) {
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : state.currentViewingChatFile;
    let favorite = null;
    let currentNote = '';
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    if (chatFileToModify === currentContextChatIdNoExt) {
        const meta = ensureFavoritesArrayExists();
        favorite = meta?.favorites?.find(fav => fav.id === favId);
    } else if (chatFileToModify && state.allChatsFavoritesData.length > 0) {
        const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
        favorite = chatData?.metadata?.favorites?.find(fav => fav.id === favId);
    }

    if (favorite) {
        currentNote = favorite.note || '';
    } else {
        toastr.error('无法找到收藏项');
        return;
    }

    const { showInputModal } = await import('./ui/index.js');
    const newNote = await showInputModal('', '编辑备注', currentNote, { isNoteMode: true });

    if (newNote !== null && newNote !== currentNote) {
        updateFavoriteNote(favId, newNote, chatFileToModify);

        if (state.modalElement && state.modalElement.classList.contains('visible')) {
            const favItemEl = state.modalBodyElement.querySelector(`.favorite-item[data-fav-id="${favId}"]`);
            if (!favItemEl) return;

            let noteEl = favItemEl.querySelector('.fav-note-content');

            if (newNote.length > 0) {
                if (!noteEl) {
                    noteEl = document.createElement('div');
                    noteEl.className = 'fav-note-content';
                    const headerInfo = favItemEl.querySelector('.fav-header-info');
                    if (headerInfo) headerInfo.prepend(noteEl);
                }
                noteEl.textContent = newNote;
            } else {
                if (noteEl) noteEl.remove();
            }
        }
    }
}

/**
 * 从聊天界面编辑备注。
 */
export async function handleEditNoteFromChat(targetIcon) {
    ensureCurrentChatIsCached();
    const messageElement = $(targetIcon).closest('.mes');
    if (!messageElement.length) return;

    const messageIdString = messageElement.attr('mesid');
    if (!messageIdString) return;

    const context = getContext();
    const currentChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    const messageIndex = parseInt(messageIdString, 10);
    const message = context.chat[messageIndex];
    if (!message) return;

    const swipeId = message.swipe_id || 0;
    let favItem = null;
    if (message.swipe_info && message.swipe_info[swipeId] && message.swipe_info[swipeId].star_favorite) {
        favItem = message.swipe_info[swipeId].star_favorite;
    }
    const wasAlreadyFavorited = !!favItem;
    let favIdToEdit = favItem ? favItem.id : null;
    const iconElement = $(targetIcon).find('i');

    if (!wasAlreadyFavorited) {
        const messageInfo = { messageId: messageIdString, sender: message.name, role: message.is_user ? 'user' : 'character' };
        const newItem = addFavorite(messageInfo, currentChatIdNoExt);
        if (!newItem) {
            toastr.error('收藏失败，无法添加备注。');
            return;
        }
        favItem = newItem;
        favIdToEdit = newItem.id;
        $(targetIcon).addClass('favorited');
    }

    const currentNote = favItem ? favItem.note || '' : '';
    const { showInputModal } = await import('./ui/index.js');
    const result = await showInputModal('', '编辑备注', currentNote, { isNoteMode: true });

    if (result !== null) {
        if (result !== currentNote) {
            updateFavoriteNote(favIdToEdit, result, currentChatIdNoExt);
        }
    } else {
        if (!wasAlreadyFavorited) {
            removeFavoriteById(favIdToEdit, currentChatIdNoExt);
            $(targetIcon).removeClass('favorited');
        }
    }
}

/**
 * 为消息添加收藏图标。
 */
export function addFavoriteIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const buttonContainer = $(this).find('.mes_block .ch_name .mes_buttons');
        if (buttonContainer.length && !buttonContainer.find('.favorite-toggle-icon').length) {
            const buttons = buttonContainer.children('.mes_button');
            if (buttons.length >= 2) {
                buttons.eq(-2).before(messageButtonHtml);
            } else {
                buttonContainer.prepend(messageButtonHtml);
            }
        }
    });
}

/**
 * 刷新视图中的收藏图标。
 */
export function refreshFavoriteIconsInView() {
    const context = getContext();
    if (!context || !context.chat) return;
    addFavoriteIconsToMessages();

    $('#chat').find('.mes').each(function() {
        const messageId = $(this).attr('mesid');
        if (messageId) {
            const messageIndex = parseInt(messageId, 10);
            const msg = context.chat[messageIndex];
            let isFavorited = false;
            if (msg && msg.swipe_info) {
                const swipeId = msg.swipe_id || 0;
                if (msg.swipe_info[swipeId] && msg.swipe_info[swipeId].star_favorite) {
                    isFavorited = true;
                }
            }
            const iconElement = $(this).find('.favorite-toggle-icon i');
            if (iconElement.length) {
                $(this).find('.favorite-toggle-icon').toggleClass('favorited', isFavorited);
            }
        }
    });
}
