// scan.js - 跨角色收藏扫描（原 api.js 的扫描部分）
//
// 职责：扫描所有角色与群组，产出「有收藏的角色」轻量索引，供角色切换器使用。
// 设计：仅依赖聊天元数据的 favorites_count（count>0 直接采用、count===0 跳过、
//      缺少该字段的旧数据才拉一次全量确认），不缓存完整消息/收藏数据，避免内存膨胀。

import { getContext } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';
import {
    FAVORITES_INDEX_VERSION,
    canSkipChatWithoutFavorites,
    getFullChatData,
    rememberChatWithoutFavorites,
} from './chat-data.js';
import { isAbortError, stripJsonlExt } from './utils.js';
import Logger from './Logger.js';

/**
 * 扫描所有角色（含群组），找出含收藏的角色及其收藏数。
 * 用于角色切换器：建立「有收藏的角色」轻量索引，切换角色时按需拉取完整数据。
 * @param {function} onProgress - 进度回调 (current, total, charName)
 * @param {object} options - { signal: AbortSignal, onFound: (entry) => void }
 *   onFound 为增量回调：每发现一个有收藏的角色/群组即触发，供 UI 边扫边渲染（扫描期间即可搜索/切换）
 * @returns {Promise<Array>} [{characterId, name, avatar, isGroup, totalFavorites, chatsWithFavorites}]
 *   其中 chatsWithFavorites 为 [{fileName, displayName, favoritesCount, last_mes}]
 */
export async function scanAllCharactersForFavorites(onProgress, options = {}) {
    const context = getContext();
    if (!context || !context.characters) return [];
    const { onFound } = options;
    const characters = context.characters;
    const groups = context.groups || [];
    const result = [];

    // --- 角色扫描 ---
    for (let i = 0; i < characters.length; i++) {
        if (options.signal?.aborted) break;
        const ch = characters[i];
        if (!ch || !ch.avatar) {
            onProgress?.(i + 1, characters.length + groups.length, ch?.name || '');
            continue;
        }
        onProgress?.(i + 1, characters.length + groups.length, ch.name);

        // 1) 取该角色的聊天文件列表（轻量，只返回元数据）
        let chatList = [];
        try {
            const resp = await fetch('/api/characters/chats', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: ch.avatar, metadata: true }),
                signal: options.signal,
            });
            if (resp.ok) {
                const data = await resp.json();
                chatList = Array.isArray(data) ? data : [];
            }
        } catch (e) {
            if (isAbortError(e, options.signal)) break;
            Logger.warn(`获取角色「${ch.name}」聊天列表失败，跳过该角色`);
            continue;
        }
        if (chatList.length === 0) continue;

        // 2) 根据聊天元数据中的 favorites_count 预过滤，避免无收藏聊天被全量拉取：
        //    - count > 0 → 元数据已确认有收藏，直接采用计数（零全量请求）
        //    - count === 0 且索引可信（或本会话已核对过为空）→ 确定无收藏，跳过
        //    - 其余（缺该字段的旧数据 / 旧版本写脏的 count===0）→ 拉一次全量核对
        //      注意：旧版本可能写出「消息里有 star_favorite、favorites_count 却是 0」的脏索引，
        //      无条件信任 count===0 会让这些聊天的收藏在切换器里彻底查不到（见 chat-data.js 顶部说明）。
        // 扫描结果只保留轻量索引（不缓存完整消息/收藏数据，切换角色时按需拉取，避免内存膨胀）
        const chatsWithFavorites = [];
        const staleChats = [];
        for (const chatMeta of chatList) {
            if (options.signal?.aborted) break;
            const count = chatMeta.chat_metadata?.favorites_count;
            const chatFileNameNoExt = stripJsonlExt(chatMeta.file_name);
            if (!chatFileNameNoExt) continue;
            if (canSkipChatWithoutFavorites(chatMeta.chat_metadata, chatFileNameNoExt, i, null)) continue;
            if (count > 0) {                // 明确有收藏，信元数据（零全量请求）
                chatsWithFavorites.push({
                    fileName: chatFileNameNoExt,
                    displayName: chatFileNameNoExt,
                    favoritesCount: count,
                    last_mes: chatMeta.last_mes || '',
                });
            } else {                        // 索引缺失或不可信，需拉一次确认
                staleChats.push(chatMeta);
            }
        }

        // 索引不可信的聊天逐个拉全量核对；确认有收藏的补写索引（下次保存时落盘）
        if (staleChats.length > 0) {
            await Promise.all(staleChats.map(async (chatMeta) => {
                if (options.signal?.aborted) return;
                const chatFileNameNoExt = stripJsonlExt(chatMeta.file_name);
                if (!chatFileNameNoExt) return;
                try {
                    const fullChatData = await getFullChatData(i, null, chatFileNameNoExt, false, chatMeta, { signal: options.signal });
                    const actualCount = fullChatData?.metadata?.favorites?.length || 0;
                    if (actualCount > 0) {
                        // 自动修正：补上可信索引，下次该聊天落库时写入 JSONL
                        if (fullChatData.metadata) {
                            fullChatData.metadata.favorites_count = actualCount;
                            fullChatData.metadata.favorites_index_version = FAVORITES_INDEX_VERSION;
                        }
                        chatsWithFavorites.push({
                            fileName: chatFileNameNoExt,
                            displayName: chatFileNameNoExt,
                            favoritesCount: actualCount,
                            last_mes: chatMeta.last_mes || '',
                        });
                    } else {
                        // 核对确认确实没有收藏：记入会话备忘，避免每次重扫都重复读这个文件
                        rememberChatWithoutFavorites(chatFileNameNoExt, i, null);
                    }
                } catch (e) {
                    if (isAbortError(e, options.signal)) return;
                    Logger.debug(`读取索引不可信的聊天失败（已跳过）: ${chatFileNameNoExt}`, e);
                }
            }));
        }

        if (chatsWithFavorites.length > 0) {
            chatsWithFavorites.sort((a, b) => b.favoritesCount - a.favoritesCount);
            const totalFavorites = chatsWithFavorites.reduce((s, c) => s + c.favoritesCount, 0);
            const entry = {
                characterId: i, name: ch.name, avatar: ch.avatar, isGroup: false,
                totalFavorites, chatsWithFavorites,
            };
            result.push(entry);
            onFound?.(entry);
        }
    }

    // --- 群组扫描 ---
    for (let g = 0; g < groups.length; g++) {
        if (options.signal?.aborted) break;
        const grp = groups[g];
        if (!grp || !grp.id) {
            onProgress?.(characters.length + g + 1, characters.length + groups.length, '');
            continue;
        }
        onProgress?.(characters.length + g + 1, characters.length + groups.length, grp.name || '群聊');

        const fileList = Array.isArray(grp.chats) ? grp.chats : [];
        if (fileList.length === 0) continue;

        const chatsWithFavorites = [];
        await Promise.all(fileList.map(async (rawName) => {
            if (options.signal?.aborted) return;
            const chatFileNameNoExt = stripJsonlExt(rawName);
            if (!chatFileNameNoExt) return;
            try {
                const fullChatData = await getFullChatData(null, grp.id, chatFileNameNoExt, true, null, { signal: options.signal });
                if (fullChatData && fullChatData.metadata?.favorites?.length > 0) {
                    chatsWithFavorites.push({
                        fileName: chatFileNameNoExt,
                        displayName: chatFileNameNoExt,
                        favoritesCount: fullChatData.metadata.favorites.length,
                    });
                }
            } catch (e) {
                if (isAbortError(e, options.signal)) return;
                Logger.debug('读取群组聊天失败（已跳过）', e);
            }
        }));

        if (chatsWithFavorites.length > 0) {
            chatsWithFavorites.sort((a, b) => b.favoritesCount - a.favoritesCount);
            const totalFavorites = chatsWithFavorites.reduce((s, c) => s + c.favoritesCount, 0);
            const entry = {
                characterId: null, name: grp.name || '未命名群聊', avatar: grp.avatar || '', groupId: grp.id, isGroup: true,
                totalFavorites, chatsWithFavorites,
            };
            result.push(entry);
            onFound?.(entry);
        }
    }

    return result;
}
