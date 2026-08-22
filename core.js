// core.js - 核心业务逻辑模块（收藏增删改查）

import { getContext } from '../../../extensions.js';
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

// ==================== 虚拟收藏数组缓存 ====================

// 缓存键为 chat 数组引用 + 长度 + chatMetadata 引用（消息增删必然改变长度；内容替换不影响收藏结构）。
// 加入 chatMetadata 引用作为「聊天身份」校验：ST 每次加载聊天都会重新赋值 chat_metadata，
// 即使 chat 数组被 ST 原地 splice 填充（引用与最终长度不变），身份变化也能让缓存失效，
// 避免读操作命中内容已变但引用/长度未变的脏缓存（表现为面板显示错误条数）。
// 收藏写操作（增/删/改备注）重建后主动写入缓存；读操作（ensureFavoritesArrayExists）
// 命中时直接复用，避免对上千条消息的聊天在每次渲染/切换收藏时反复全量遍历。
let _virtualFavoritesCacheChat = null;
let _virtualFavoritesCacheLength = -1;
let _virtualFavoritesCacheMeta = null;
let _virtualFavoritesCacheResult = null;

function buildVirtualFavoritesCached(messages, chatMetadata = null) {
    const length = Array.isArray(messages) ? messages.length : 0;
    if (_virtualFavoritesCacheResult && messages === _virtualFavoritesCacheChat && length === _virtualFavoritesCacheLength && chatMetadata === _virtualFavoritesCacheMeta) {
        return _virtualFavoritesCacheResult;
    }
    const result = buildVirtualFavorites(messages);
    _virtualFavoritesCacheChat = messages;
    _virtualFavoritesCacheLength = length;
    _virtualFavoritesCacheMeta = chatMetadata ?? null;
    _virtualFavoritesCacheResult = result;
    return result;
}

/**
 * 收藏写操作（增/删/改备注/改标签）后强制重建虚拟收藏缓存并写入缓存。
 * 写操作只改变 swipe_info 的收藏结构、不改变 chat 长度，而缓存键是「引用 + 长度」，
 * 若沿用 buildVirtualFavoritesCached 会命中旧缓存，导致 UI 与实际数据不一致（如删除后仍显示、改标签后不刷新）。
 */
function rebuildVirtualFavoritesCache(messagesArray, chatMetadata = null) {
    const result = buildVirtualFavorites(messagesArray);
    _virtualFavoritesCacheChat = messagesArray;
    _virtualFavoritesCacheLength = Array.isArray(messagesArray) ? messagesArray.length : 0;
    _virtualFavoritesCacheMeta = chatMetadata ?? null;
    _virtualFavoritesCacheResult = result;
    return result;
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
 * @param {boolean} [forceRebuild] - 为 true 时强制重建缓存（不命中缓存）。
 *   面板首次打开等关键展示点传入，即使此前存在脏缓存也能纠正。
 */
export function ensureFavoritesArrayExists(forceRebuild = false) {
    let context;
    try {
        context = getContext();
        if (!context || !context.chatMetadata) return null;
    } catch (e) {
        return null;
    }
    context.chatMetadata.favorites = forceRebuild
        ? rebuildVirtualFavoritesCache(context.chat, context.chatMetadata)
        : buildVirtualFavoritesCached(context.chat, context.chatMetadata);
    return context.chatMetadata;
}

// ==================== 当前聊天收藏保存（防抖 + 失败重试） ====================

// ST 的 saveMetadataDebounced 会对整个 26MB 聊天全量写回且内部吞掉错误：
// 大文件下与后台读取（收藏面板打开时的其他聊天加载/角色切换器扫描）并发时，
// Windows 下 write-file-atomic 的 rename 会因文件被占用报 EPERM，保存静默失败、
// 收藏刷新后丢失。改由插件自管防抖保存：走 saveSpecificChatMetadata
// （剥离虚拟 favorites 避免 ST 持久化冗余、带失败重试 + 明确失败提示）。
let _favoriteSaveTimer = null;
let _favoriteSaveSeq = 0;

function scheduleFavoriteSave() {
    clearTimeout(_favoriteSaveTimer);
    // 记录触发时的聊天标识：防抖到期后若已切换聊天则放弃本次保存（与 ST 原 saveMetadataDebounced
    // 的角色切换保护一致），避免把旧聊天的改动写到新聊天文件上。
    const context = getContext();
    const chatFileNoExt = String(context.chatId || '').replace('.jsonl', '');
    _favoriteSaveTimer = setTimeout(() => {
        _favoriteSaveTimer = null;
        const seq = ++_favoriteSaveSeq;
        void saveCurrentChatFavorites(seq, chatFileNoExt);
    }, 800);
}

async function saveCurrentChatFavorites(seq, expectedChatFileNoExt) {
    // 防抖窗口内又触发了新保存 → 本次跳过（下一次会带上最新数据）
    if (seq !== _favoriteSaveSeq) return;

    const context = getContext();
    const chatFileNoExt = String(context.chatId || '').replace('.jsonl', '');
    // 防抖期间切换了聊天：放弃本次保存（旧聊天的改动无法安全写回，与 ST 原行为一致）
    if (!chatFileNoExt || chatFileNoExt !== expectedChatFileNoExt) return;

    const chatDataInCache = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileNoExt);
    // 防抖期间可能已切换聊天，跳过陈旧的保存任务
    if (seq !== _favoriteSaveSeq) return;

    const metadataToSave = chatDataInCache?.metadata || context.chatMetadata;
    // 保存当前聊天必须用 ST 的 context.chat 真实数组（cache.messages 可能是
    // 上次保存后的深拷贝，若保存副本会丢失 ST 侧新增/修改的消息，且收藏写入
    // 的是 context.chat（见 addFavorite 等），两者必须一致）。
    const messagesArray = context.chat;
    if (!metadataToSave || !Array.isArray(messagesArray)) return;

    // 保存前中断后台预加载扫描：打开面板时的预加载会对所有角色（含当前聊天）
    // 全量读取 26MB 文件，与本次全量写回并发时，Windows 下文件锁会导致
    // write-file-atomic 的 rename 失败（EPERM），收藏保存失败、刷新后丢失。
    try {
        const { abortPreload } = await import('./ui/index.js');
        abortPreload();
    } catch (e) {
        // 动态导入失败不阻断保存（预加载中断只是尽力而为）
    }

    try {
        await saveSpecificChatMetadata(chatFileNoExt, metadataToSave, messagesArray);
    } catch (error) {
        // saveSpecificChatMetadata 内部已重试并 toastr 提示，这里兜底记录
        Logger.error('保存当前聊天收藏失败:', error);
    }
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
    // 当前聊天必须写 ST 的 context.chat（cache.messages 可能是保存后的深拷贝副本，
    // 写入副本会导致聊天区图标与实际数据脱节）；只有其他聊天才用缓存的消息数组。
    const messagesArray = (chatFileToModify === currentContextChatIdNoExt)
        ? context.chat
        : (chatDataInCache ? chatDataInCache.messages : context.chat);

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

    const virtualFavs = rebuildVirtualFavoritesCache(messagesArray);
    if (chatDataInCache) {
        chatDataInCache.favorites = virtualFavs;
        if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
    }

    if (chatFileToModify === currentContextChatIdNoExt) {
        context.chatMetadata.favorites = virtualFavs;
        scheduleFavoriteSave();
    } else {
        // 保存其他聊天收藏（saveSpecificChatMetadata 内部已重试并提示，此处静默吞掉拒绝）
        saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray).catch(() => {});
    }

    return newItem;
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
    // 当前聊天必须写 ST 的 context.chat（cache.messages 可能是保存后的深拷贝副本，
    // 写入副本会导致聊天区图标与实际数据脱节）；只有其他聊天才用缓存的消息数组。
    const messagesArray = (chatFileToModify === currentContextChatIdNoExt)
        ? context.chat
        : (chatDataInCache ? chatDataInCache.messages : context.chat);
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
        const virtualFavs = rebuildVirtualFavoritesCache(messagesArray);
        if (chatDataInCache) {
            chatDataInCache.favorites = virtualFavs;
            if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
        }

        if (chatFileToModify === currentContextChatIdNoExt) {
            context.chatMetadata.favorites = virtualFavs;
            scheduleFavoriteSave();
        } else {
            // 保存其他聊天收藏（saveSpecificChatMetadata 内部已重试并提示，此处静默吞掉拒绝）
            saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray).catch(() => {});
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
    // 当前聊天必须写 ST 的 context.chat（cache.messages 可能是保存后的深拷贝副本，
    // 写入副本会导致聊天区图标与实际数据脱节）；只有其他聊天才用缓存的消息数组。
    const messagesArray = (chatFileToModify === currentContextChatIdNoExt)
        ? context.chat
        : (chatDataInCache ? chatDataInCache.messages : context.chat);
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
        const virtualFavs = rebuildVirtualFavoritesCache(messagesArray);
        if (chatDataInCache) {
            chatDataInCache.favorites = virtualFavs;
            if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
        }
        if (chatFileToModify === currentContextChatIdNoExt) {
            context.chatMetadata.favorites = virtualFavs;
            scheduleFavoriteSave();
        } else {
            // 保存其他聊天收藏（saveSpecificChatMetadata 内部已重试并提示，此处静默吞掉拒绝）
            saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray).catch(() => {});
        }
    }
}

/**
 * 更新收藏标签（tags 数组，与备注 note 并存互不干扰）。
 * 老数据无 tags 字段时视为空数组，天然兼容。
 */
export function updateFavoriteTags(favoriteId, tags, targetChatFile = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : (state.currentViewingChatFile || currentContextChatIdNoExt);

    const chatDataInCache = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
    // 当前聊天必须写 ST 的 context.chat（cache.messages 可能是保存后的深拷贝副本，
    // 写入副本会导致聊天区图标与实际数据脱节）；只有其他聊天才用缓存的消息数组。
    const messagesArray = (chatFileToModify === currentContextChatIdNoExt)
        ? context.chat
        : (chatDataInCache ? chatDataInCache.messages : context.chat);
    if (!messagesArray) return;

    // 清洗：去空、去重、去首尾空格
    const cleanTags = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];

    let updated = false;
    for (let i = 0; i < messagesArray.length; i++) {
        const msg = messagesArray[i];
        if (msg && msg.swipe_info) {
            for (let sId = 0; sId < msg.swipe_info.length; sId++) {
                const info = msg.swipe_info[sId];
                if (info && info.star_favorite && info.star_favorite.id === favoriteId) {
                    info.star_favorite.tags = cleanTags;
                    updated = true;
                    break;
                }
            }
        }
        if (updated) break;
    }

    if (updated) {
        // 标签内容变化，标记角色切换器缓存过期（缓存的 messages 里有旧标签）
        state.charactersCacheStale = true;
        const virtualFavs = rebuildVirtualFavoritesCache(messagesArray);
        if (chatDataInCache) {
            chatDataInCache.favorites = virtualFavs;
            if (chatDataInCache.metadata) chatDataInCache.metadata.favorites = virtualFavs;
        }
        if (chatFileToModify === currentContextChatIdNoExt) {
            context.chatMetadata.favorites = virtualFavs;
            scheduleFavoriteSave();
        } else {
            // 保存其他聊天收藏（saveSpecificChatMetadata 内部已重试并提示，此处静默吞掉拒绝）
            saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, messagesArray).catch(() => {});
        }
    }
}

/**
 * 在多条收藏中查找包含指定 swipe 收藏 id 的 favoritedSwipes 列表。
 * 虚拟收藏的 fav.id 是「第一个」收藏的 swipe id，而卡片传入的 favId 是当前查看的 swipe id，
 * 多 Swipe 收藏时必须按「favoritedSwipes 中包含该 id」查找，否则非首个 swipe 会找不到收藏项、并误读第一条的数据。
 * @returns {Array|null} 命中的 favoritedSwipes 列表，未命中返回 null
 */
function findFavSwipesById(favorites, favId) {
    return (favorites || []).find(fav => (fav.favoritedSwipes || []).some(s => s.id === favId))?.favoritedSwipes || null;
}

/**
 * 从收藏面板编辑标签（与 handleEditNote 对称）。
 */
export async function handleEditTags(favId, targetChatFile = null) {
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl', '') : state.currentViewingChatFile;
    let favSwipes = null;
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    if (chatFileToModify === currentContextChatIdNoExt) {
        const meta = ensureFavoritesArrayExists();
        favSwipes = findFavSwipesById(meta?.favorites, favId);
    } else if (chatFileToModify && state.allChatsFavoritesData.length > 0) {
        const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
        favSwipes = findFavSwipesById(chatData?.metadata?.favorites, favId);
    }

    if (!favSwipes) {
        toastr.error('无法找到收藏项');
        return;
    }

    // 优先取与 favId 精确匹配的 swipe（多 swipe 场景下卡片 favId 是当前查看的那条），兜底取第一条
    const swipe = favSwipes.find(s => s.id === favId) || favSwipes[0];
    const currentTags = Array.isArray(swipe?.tags) ? [...swipe.tags] : [];

    const { showTagsModal } = await import('./ui/index.js');
    const newTags = await showTagsModal(currentTags, '编辑标签');
    if (newTags === null) return;

    const unchanged = newTags.length === currentTags.length && newTags.every(t => currentTags.includes(t));
    if (!unchanged) {
        updateFavoriteTags(favId, newTags, chatFileToModify);
        // 刷新面板以显示标签徽章（updateFavoriteTags 已重建虚拟收藏缓存，重渲染即可拿到新 tags）
        if (state.modalElement && state.modalElement.classList.contains('visible')) {
            const { renderFavoritesView } = await import('./ui/index.js');
            await renderFavoritesView(state.currentViewingChatFile);
        }
    }
}

/**
 * 判断消息是否“完全空白”（无法收藏）：正文为空，且无思维链、无任何 swipe 文本。
 * ST 中 AI 生成中的消息 mes 可能为空，但 extra.reasoning（思维链）有内容且是界面最后一条，
 * 这类消息不能被当作空占位跳过，否则 Alt+S 会收藏到“倒数第二条”。
 */
function isBlankMessage(m) {
    if (!m) return true;
    if (typeof m.mes === 'string' && m.mes.trim()) return false;
    if (m.extra && m.extra.reasoning && String(m.extra.reasoning).trim()) return false;
    if (Array.isArray(m.swipes) && m.swipes.some(s => typeof s === 'string' && s.trim())) return false;
    return true;
}

/**
 * 全局快捷键（Alt+S）：收藏/取消收藏当前聊天最后一条消息。
 * 在预览模式下不应触发（预览的是临时加载的历史上下文，非当前聊天）。
 */
export function toggleFavoriteLastMessage() {
    const context = getContext();
    if (!context || !Array.isArray(context.chat) || context.chat.length === 0) {
        toastr.info('当前聊天没有可收藏的消息');
        return;
    }

    // 从末尾向前找最后一条“有实际内容”的消息（跳过完全空白占位）
    let idx = -1, msg = null;
    for (let i = context.chat.length - 1; i >= 0; i--) {
        const m = context.chat[i];
        if (!isBlankMessage(m)) {
            idx = i;
            msg = m;
            break;
        }
    }
    if (!msg) {
        toastr.info('当前聊天没有可收藏的消息');
        return;
    }

    ensureCurrentChatIsCached();
    const swipeId = msg.swipe_id || 0;
    if (msg.swipe_info && msg.swipe_info[swipeId] && msg.swipe_info[swipeId].star_favorite) {
        const favId = msg.swipe_info[swipeId].star_favorite.id;
        removeFavoriteById(favId);
        toastr.info('已取消收藏最后一条消息');
    } else {
        addFavorite({ messageId: String(idx), sender: msg.name, role: msg.is_user ? 'user' : 'character' });
        toastr.success('已收藏最后一条消息（再次按 Alt+S 可取消）');
    }
    setTimeout(refreshFavoriteIconsInView, 100);
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
    let favSwipes = null;
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    if (chatFileToModify === currentContextChatIdNoExt) {
        const meta = ensureFavoritesArrayExists();
        favSwipes = findFavSwipesById(meta?.favorites, favId);
    } else if (chatFileToModify && state.allChatsFavoritesData.length > 0) {
        const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
        favSwipes = findFavSwipesById(chatData?.metadata?.favorites, favId);
    }

    if (!favSwipes) {
        toastr.error('无法找到收藏项');
        return;
    }

    // 优先取与 favId 精确匹配的 swipe（卡片 favId 是当前查看的那条），兜底取第一条
    const swipe = favSwipes.find(s => s.id === favId) || favSwipes[0];
    const currentNote = swipe ? (swipe.note || '') : '';

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
 * 传入 targetMesId 时只定向刷新该消息（MESSAGE_SWIPED/UPDATED 等高频场景），
 * 否则全量刷新（切换聊天/批量加载后使用）。
 */
export function refreshFavoriteIconsInView(targetMesId = null) {
    const context = getContext();
    if (!context || !context.chat) return;

    // 定向刷新时图标已存在，无需补图标；全量刷新时先补齐缺失图标
    if (targetMesId === null || targetMesId === undefined) {
        addFavoriteIconsToMessages();
    }

    const selector = (targetMesId === null || targetMesId === undefined)
        ? '#chat .mes'
        : `#chat .mes[mesid="${targetMesId}"]`;

    $(selector).each(function() {
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
