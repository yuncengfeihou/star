// migration.js - 旧版收藏数据迁移引擎
// 背景：旧版（uhhhh15/star）把收藏存在聊天元数据 chat_metadata.favorites（只记录消息索引），
// 新版改存消息自身的 swipe_info.star_favorite。此模块负责把旧格式数据注入到对应消息元数据中，
// 幂等、可中断、以角色为单位后台逐个迁移。
//
// 纯数据逻辑（isLegacyFormat / migrateLegacyFavorites）位于 domain.js，本模块只负责编排与落库。

import { getContext, extension_settings } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';
import { state, findChatData, setSetting, PLUGIN_NAME } from './state.js';
import { isLegacyFormat, migrateLegacyFavorites, buildVirtualFavorites } from './domain.js';
import { isAbortError, stripJsonlExt } from './utils.js';
import { getFullChatData, saveSpecificChatMetadata } from './chat-data.js';
import Logger from './Logger.js';

// 迁移标记键：唯一决定「是否已处理过首次迁移提示」。
// 存在即短路（无论值），不再检测旧数据、不再弹窗。
export const MIGRATION_FLAG = 'dataMigration';

// 迁移进度状态（供 UI 读取）
export const migrationStatus = {
    running: false,   // 是否有后台迁移在进行
    aborted: false,   // 是否被暂停/中止
    finished: false,  // 是否完成过一轮迁移
};

let migrationController = null;

/**
 * 首次运行新版时的迁移标记初始化。
 * 【重要】必须先于 initSettings() 调用：此刻 extension_settings[PLUGIN_NAME]
 * 尚未被补默认键，若其中已有任何数据，只可能来自旧版插件（新版一旦跑过，flag 必然已写入）。
 * flag 已存在 → 直接短路返回，绝不再次检测旧数据（幂等闸门）。
 *
 * 注意：此处**有意**直接读写 extension_settings 原始对象，而非走 state.js 的 getSetting/setSetting——
 * 「配置里是否已有任何键」这个判断本身就是判定依据，一旦被默认值填充就失效。
 *
 * @returns {boolean} true = 老用户首次运行新版，需要弹出迁移确认
 */
export function initMigrationFlag() {
    const raw = extension_settings[PLUGIN_NAME];
    const hasFlag = raw && raw[MIGRATION_FLAG] !== undefined;
    if (hasFlag) return false;

    // 首次运行：配置里已有数据 = 老用户（旧版插件留下的痕迹）
    const isLegacyUser = !!raw && Object.keys(raw).length > 0;
    setSetting(MIGRATION_FLAG, isLegacyUser ? 'pending' : 'done');
    Logger.info(`数据迁移标记初始化：${isLegacyUser ? '老用户(pending)' : '新用户(done)'}`);
    return isLegacyUser;
}

/**
 * 优先迁移当前聊天（内存中已完成注入，零网络开销），保存后旧格式即被剥离。
 * @returns {Promise<{migrated:number, skipped:number, done:boolean}>}
 */
export async function migrateCurrentChat() {
    const context = getContext();
    if (!context || !context.chatMetadata) return { migrated: 0, skipped: 0, done: false };
    const favs = context.chatMetadata.favorites;
    if (!isLegacyFormat(favs)) return { migrated: 0, skipped: 0, done: false };

    const result = migrateLegacyFavorites(context.chat, favs);
    // 重建虚拟收藏（swipe_info 已写入，供 UI 立即显示）
    context.chatMetadata.favorites = buildVirtualFavorites(context.chat);
    const chatFile = stripJsonlExt(context.chatId || '');
    try {
        await saveSpecificChatMetadata(chatFile, context.chatMetadata, context.chat);
        Logger.success(`当前聊天迁移完成：${chatFile}（${result.migrated} 条）`);
        return { ...result, done: true };
    } catch (error) {
        Logger.error('迁移当前聊天保存失败:', error);
        return { ...result, done: false };
    }
}

/**
 * 确保迁移目标聊天已进入 allChatsFavoritesData 缓存。
 * saveSpecificChatMetadata 依赖缓存识别聊天所属角色/群组；若不在缓存，
 * 会回退到「当前上下文」的角色，把其他角色的聊天误存到当前角色目录下。
 */
function ensureChatCached(chatFileNoExt, characterId, fullChatData) {
    if (findChatData(chatFileNoExt)) return;
    state.allChatsFavoritesData.push({
        fileName: chatFileNoExt,
        displayName: chatFileNoExt,
        metadata: fullChatData.metadata,
        favorites: fullChatData.metadata.favorites || [],
        messages: fullChatData.messages,
        isGroup: false,
        characterId: characterId,
        groupId: null,
    });
}

/**
 * 后台扫描所有角色的聊天并迁移旧格式收藏。
 * - 以角色为单位（按 context.characters 数组顺序），组内聊天按 last_mes 倒序（最后活跃优先）
 * - 只处理「chat_metadata.favorites 为旧格式」的聊天；已迁移（旧格式已被保存剥离）自动跳过（幂等）
 * - 每个聊天：读全量 → 注入 → 保存（写回时旧格式被剥离）
 * - AbortController 可随时中断；单聊天失败不中断整体
 * @param {object} options - { signal, onProgress(info) }
 *   onProgress 回调：{ phase:'scan'|'migrate', charIndex, charTotal, charName, chatIndex?, chatTotal?, chatName? }
 * @returns {Promise<{migrated:number, chats:number, skippedChats:number, aborted:boolean}>}
 */
export async function scanAndMigrate(options = {}) {
    const { signal } = options;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
    const context = getContext();
    if (!context || !Array.isArray(context.characters)) {
        return { migrated: 0, chats: 0, skippedChats: 0, aborted: false };
    }

    let migrated = 0;
    let chats = 0;
    let skippedChats = 0;
    const characters = context.characters;

    for (let i = 0; i < characters.length; i++) {
        if (signal?.aborted) return { migrated, chats, skippedChats, aborted: true };
        const ch = characters[i];
        if (!ch || !ch.avatar) continue;
        onProgress({ phase: 'scan', charIndex: i, charTotal: characters.length, charName: ch.name || '' });

        // 取该角色的聊天列表（metadata: true 返回每个聊天的 chat_metadata）
        let chatList = [];
        try {
            const resp = await fetch('/api/characters/chats', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: ch.avatar, metadata: true }),
                signal,
            });
            if (resp.ok) {
                const data = await resp.json();
                chatList = Array.isArray(data) ? data : [];
            }
        } catch (error) {
            if (isAbortError(error, signal)) return { migrated, chats, skippedChats, aborted: true };
            Logger.warn(`获取角色「${ch.name}」聊天列表失败，跳过该角色`);
            continue;
        }

        // 过滤：仅旧格式收藏的聊天；按最后活跃时间倒序（最后活跃的聊天优先迁完）
        const legacyChats = chatList
            .filter(c => isLegacyFormat(c.chat_metadata?.favorites))
            .sort((a, b) => (Number(b.last_mes) || 0) - (Number(a.last_mes) || 0));

        for (let j = 0; j < legacyChats.length; j++) {
            if (signal?.aborted) return { migrated, chats, skippedChats, aborted: true };
            const chatMeta = legacyChats[j];
            const chatFileNoExt = stripJsonlExt(chatMeta.file_name);
            if (!chatFileNoExt) { skippedChats++; continue; }
            onProgress({
                phase: 'migrate',
                charIndex: i,
                charTotal: characters.length,
                charName: ch.name || '',
                chatIndex: j,
                chatTotal: legacyChats.length,
                chatName: chatFileNoExt,
            });

            // 读全量聊天数据（含消息数组）
            let fullChatData;
            try {
                fullChatData = await getFullChatData(i, null, chatFileNoExt, false, chatMeta, { signal });
            } catch (error) {
                if (isAbortError(error, signal)) return { migrated, chats, skippedChats, aborted: true };
                skippedChats++;
                continue;
            }
            if (!fullChatData || !Array.isArray(fullChatData.messages)) { skippedChats++; continue; }

            const result = migrateLegacyFavorites(fullChatData.messages, chatMeta.chat_metadata.favorites);
            if (result.migrated === 0) { skippedChats++; continue; }

            // 保存前先入缓存（保证 saveSpecificChatMetadata 用正确的角色身份写回）
            ensureChatCached(chatFileNoExt, i, fullChatData);
            try {
                await saveSpecificChatMetadata(chatFileNoExt, fullChatData.metadata, fullChatData.messages);
                migrated += result.migrated;
                chats++;
            } catch (error) {
                Logger.error(`迁移聊天「${chatFileNoExt}」保存失败:`, error);
                skippedChats++;
            }
        }
    }
    return { migrated, chats, skippedChats, aborted: false };
}

/**
 * 开始一轮后台迁移（先取消进行中的）。
 * @returns {Promise<object>} scanAndMigrate 的结果
 */
export function startMigration(options = {}) {
    abortMigration();
    const controller = new AbortController();
    migrationController = controller;
    migrationStatus.running = true;
    migrationStatus.aborted = false;
    return scanAndMigrate({ ...options, signal: controller.signal })
        .finally(() => {
            if (migrationController === controller) {
                migrationController = null;
                migrationStatus.running = false;
            }
        });
}

/**
 * 中止进行中的迁移（已迁移的聊天保持完成态，重跑幂等跳过）。
 */
export function abortMigration() {
    if (migrationController) {
        migrationController.abort();
        migrationController = null;
        migrationStatus.running = false;
        migrationStatus.aborted = true;
    }
}

/**
 * 是否有迁移在进行中。
 */
export function isMigrationRunning() {
    return migrationStatus.running;
}

/**
 * 标记迁移已完成（pending → done），后续不再提示。
 */
export function setMigrationDone() {
    if (extension_settings[PLUGIN_NAME]) {
        setSetting(MIGRATION_FLAG, 'done');
        Logger.info('数据迁移标记已置为 done');
    }
}

