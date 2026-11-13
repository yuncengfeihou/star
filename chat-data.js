// chat-data.js - 聊天收藏数据的读取与保存（原 api.js 的数据部分）
//
// 职责：读取聊天列表与全量聊天数据（含收藏）、保存指定聊天的元数据（带失败重试）、
//       调用 ST 的 /api/characters/chats、/api/chats/get、/api/chats/group/get、/api/chats/save。
//
// 分层：本模块只依赖 state / utils / domain / Logger，不依赖任何 UI 模块（可被数据层复用与单测）。

import { getContext } from '../../../extensions.js';
import { getRequestHeaders } from '../../../../script.js';
import { timestampToMoment } from '../../../utils.js';
import { state, findChatData } from './state.js';
import { buildVirtualFavorites, preserveSwipeViewIndexes, setVirtualFavorites } from './domain.js';
import { isAbortError, stripJsonlExt } from './utils.js';
import Logger from './Logger.js';

// ==================== 收藏索引（favorites_count / favorites_updated_at） ====================
//
// 收藏真实数据存放在每条消息的 swipe_info[].star_favorite 里，但「某个聊天到底有没有收藏」
// 只能靠 chat_metadata 里的轻量索引判断——否则每打开一次面板 / 每扫一次角色，都要把该角色
// 所有聊天全量读一遍（大文件环境下这是分钟级开销）。索引字段：
//   - favorites_count          虚拟收藏数（= 有收藏的消息数）
//   - favorites_updated_at     写入时刻（增量加载的新鲜度信号）
//   - favorites_index_version  索引格式版本（FAVORITES_INDEX_VERSION）
//
// 为什么必须有 version：≤2.3.0 的实现只在「落库时的元数据副本」里写前两个字段——既不写回
// 实时 chatMetadata（ST 自己保存聊天时写的就是实时对象，会把文件里的旧值覆盖回去），
// 条数还取自可能已过时的虚拟收藏缓存。于是出现过「消息里明明有 star_favorite，文件里
// favorites_count 却是 0」的脏文件；而读取侧把 count===0 当作「确定无收藏」直接跳过，
// 这些聊天的收藏就在侧栏与角色切换器里彻底消失（数据还在，只是查不到）。
// 带上 version 之后，读取侧能区分「会维护索引的版本写出的可信索引」与「旧版本可能写脏的
// 索引」，后者一律回退到全量读取核对，不再无条件信任 count===0。
export const FAVORITES_INDEX_VERSION = 2;

/**
 * 该聊天的收藏索引是否可信（由会维护索引的插件版本写出）。
 * 不可信时禁止用 `favorites_count === 0` 直接跳过加载，必须全量读取核对。
 */
export function isFavoritesIndexTrustworthy(chatMetadata) {
    return chatMetadata?.favorites_index_version === FAVORITES_INDEX_VERSION;
}

// 会话级备忘：索引不可信且 count===0 的聊天，全量核对后确认「确实没有收藏」的记在这里，
// 避免同一次会话里每次打开面板 / 每次重扫都重复读取同一个文件。
// 只记「核对为空」的结果——核对出有收藏的聊天本来就要把数据读进缓存才能展示，记了也没用。
const _verifiedWithoutFavorites = new Set();

function buildVerifiedKey(fileName, characterId = null, groupId = null) {
    const owner = (groupId !== null && groupId !== undefined) ? `g:${groupId}` : `c:${characterId}`;
    return `${owner}|${stripJsonlExt(fileName)}`;
}

/**
 * 是否可以安全跳过该聊天的全量加载（即「确定没有收藏」）。
 * 只有 count===0 才有歧义，因此只在这个分支上做判断。
 */
export function canSkipChatWithoutFavorites(chatMetadata, fileName, characterId = null, groupId = null) {
    if (chatMetadata?.favorites_count !== 0) return false;
    if (isFavoritesIndexTrustworthy(chatMetadata)) return true;
    return _verifiedWithoutFavorites.has(buildVerifiedKey(fileName, characterId, groupId));
}

/** 记录「索引不可信、但全量核对后确实没有收藏」，供同一次会话内跳过重复读取。 */
export function rememberChatWithoutFavorites(fileName, characterId = null, groupId = null) {
    _verifiedWithoutFavorites.add(buildVerifiedKey(fileName, characterId, groupId));
}

/**
 * 撤销「已核对为空」的备忘（该聊天收藏发生变化时调用，避免漏掉新增收藏）。
 */
export function forgetChatWithoutFavorites(fileName, characterId = null, groupId = null) {
    _verifiedWithoutFavorites.delete(buildVerifiedKey(fileName, characterId, groupId));
}

// ==================== 读取 ====================

/**
 * 获取当前上下文（角色/群组）下所有聊天的收藏数据。
 * @param {boolean} skipCurrentChat - 是否跳过当前聊天（当前聊天已用 getContext 即时渲染）
 * @param {{signal?: AbortSignal}} options
 */
export async function getAllChatFavoritesForCurrentContext(skipCurrentChat = false, options = {}) {
    const context = getContext();
    if (!context) return [];

    const currentChatFile = stripJsonlExt(context.chatId || '');
    let chatListResponse, requestBody;
    const allFavoritesData = [];

    const processChatList = async (list) => {
        for (const chatMeta of list) {
            // 每轮开始前检查是否已被取消，避免无意义的网络请求继续
            if (options.signal?.aborted) break;
            const chatFileNameNoExt = stripJsonlExt(chatMeta.file_name);
            if (!chatFileNameNoExt || (skipCurrentChat && chatFileNameNoExt === currentChatFile)) {
                continue;
            }
            // 元数据预过滤：favorites_count 为 0 且索引可信（或本会话已核对过为空）→ 确定无收藏，跳过。
            // 索引不可信（旧版本写脏过 count）时必须回退到全量核对，否则会漏掉
            // 「消息里有 star_favorite、索引却是 0」的聊天（见文件顶部说明）。
            // 群组聊天列表（/api/chats/search）不带 chat_metadata，此过滤对其不生效，保持全量判断
            if (canSkipChatWithoutFavorites(chatMeta.chat_metadata, chatFileNameNoExt, context.characterId, context.groupId)) {
                continue;
            }
            // 增量加载：缓存中已有且数据未变化的聊天直接跳过（「面板二次打开秒开」的关键）。
            // 判断依据 favorites_updated_at：收藏写回时更新（见 saveSpecificChatMetadata），
            // 缓存时间戳 >= 元数据时间戳 → 缓存新鲜，跳过本次加载。
            // 必须同时匹配角色/群组身份，避免跨角色浏览后误跳过其他角色的聊天；
            // 群组聊天列表不带 chat_metadata（无 favorites_updated_at）→ 不命中，保持全量判断。
            const cachedChat = state.allChatsFavoritesData.find(c => {
                if (stripJsonlExt(c.fileName) !== chatFileNameNoExt) return false;
                if (!!c.isGroup !== !!context.groupId) return false;
                return c.isGroup ? c.groupId === context.groupId : c.characterId === context.characterId;
            });
            const cachedUpdatedAt = cachedChat?.metadata?.favorites_updated_at;
            const metaUpdatedAt = chatMeta.chat_metadata?.favorites_updated_at;
            if (cachedChat && Array.isArray(cachedChat.messages)
                && typeof cachedUpdatedAt === 'number' && typeof metaUpdatedAt === 'number'
                && metaUpdatedAt <= cachedUpdatedAt) {
                continue;
            }

            let fullChatData;
            try {
                fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId, chatMeta, { signal: options.signal });
            } catch (e) {
                // 被取消则中断整个循环；单个聊天加载失败则跳过继续下一个
                if (isAbortError(e, options.signal)) break;
                continue;
            }
            if (fullChatData && (fullChatData.metadata?.favorites?.length > 0)) {
                allFavoritesData.push({
                    fileName: chatFileNameNoExt,
                    displayName: chatFileNameNoExt,
                    metadata: fullChatData.metadata,
                    favorites: fullChatData.metadata.favorites || [],
                    messages: fullChatData.messages || [],
                    isGroup: !!context.groupId,
                    characterId: context.characterId,
                    groupId: context.groupId,
                });
            } else if (chatMeta.chat_metadata?.favorites_count === 0) {
                // 索引不可信但又确实没有收藏：记入会话备忘，避免每次打开面板都重复读这个文件
                rememberChatWithoutFavorites(chatFileNameNoExt, context.characterId, context.groupId);
            }
        }
    };

    if (context.groupId) {
        requestBody = { group_id: context.groupId, query: '' };
        try {
            chatListResponse = await fetch('/api/chats/search', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
            if (!chatListResponse.ok) throw new Error(`Failed to fetch chat list for group ${context.groupId}: ${chatListResponse.status}`);
            const groupChatsMetadataList = await chatListResponse.json();
            if (Array.isArray(groupChatsMetadataList)) {
                await processChatList(groupChatsMetadataList);
            }
        } catch (error) {
            // 取消属于正常中断，不打错误日志
            if (!isAbortError(error, options.signal)) Logger.error(`Error fetching group chats:`, error);
        }
    } else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const charObj = context.characters[context.characterId];
        // metadata: true 让接口返回每个聊天的 chat_metadata（含 favorites_count），供上方预过滤使用
        requestBody = { avatar_url: charObj.avatar, metadata: true };
        try {
            chatListResponse = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
            if (!chatListResponse.ok) throw new Error(`Failed to fetch chat list for character ${context.characterId}: ${chatListResponse.status}`);
            const characterChatsArray = await chatListResponse.json();
            if (Array.isArray(characterChatsArray)) {
                await processChatList(characterChatsArray);
            }
        } catch (error) {
            if (!isAbortError(error, options.signal)) Logger.error(`Error fetching character chats:`, error);
        }
    }

    return allFavoritesData;
}

/**
 * 获取完整聊天数据（元数据 + 消息数组），并把收藏规范化为虚拟收藏数组。
 * 兼容 ST 多种响应形态：数组（首元素为元数据）/空对象/单对象。
 * @returns {Promise<{metadata: object, messages: Array}>}
 */
export async function getFullChatData(characterId, groupId, chatFileNameNoExt, isGroup, providedMetadata = null, options = {}) {
    Logger.debug(`getFullChatData: chat=${chatFileNameNoExt}, isGroup=${isGroup}`);
    const context = getContext();
    let endpoint, requestBody;
    let finalMetadataObject = { favorites: [] };
    let messages = [];
    try {
        if (isGroup) {
            if (!groupId) return null;
            endpoint = '/api/chats/group/get';
            requestBody = { id: groupId, chat_id: chatFileNameNoExt };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
            if (response.ok) {
                const groupChatData = await response.json();
                if (Array.isArray(groupChatData)) {
                    if (groupChatData.length > 0 && typeof groupChatData[0] === 'object' && !Array.isArray(groupChatData[0]) && (groupChatData[0].user_name !== undefined || groupChatData[0].character_name !== undefined)) {
                        const rawMetadata = groupChatData[0];
                        if (typeof rawMetadata.chat_metadata === 'object' && rawMetadata.chat_metadata !== null) {
                            finalMetadataObject = JSON.parse(JSON.stringify(rawMetadata.chat_metadata));
                        } else {
                            finalMetadataObject = JSON.parse(JSON.stringify(rawMetadata));
                        }
                        messages = groupChatData.slice(1);
                    } else {
                        messages = groupChatData;
                    }
                }
            }
            if (groupId === context.groupId && chatFileNameNoExt === stripJsonlExt(context.chatId || '')) {
                finalMetadataObject = JSON.parse(JSON.stringify(context.chatMetadata || { favorites: [] }));
            } else if (providedMetadata) {
                if (typeof providedMetadata.chat_metadata === 'object' && providedMetadata.chat_metadata !== null) {
                    finalMetadataObject = JSON.parse(JSON.stringify(providedMetadata.chat_metadata));
                } else {
                    finalMetadataObject = JSON.parse(JSON.stringify(providedMetadata));
                }
            } else {
                const cachedChat = state.allChatsFavoritesData.find(c => c.isGroup === true && c.groupId === groupId && stripJsonlExt(c.fileName) === chatFileNameNoExt);
                if (cachedChat && cachedChat.metadata) {
                    finalMetadataObject = JSON.parse(JSON.stringify(cachedChat.metadata));
                }
            }
        } else {
            if (characterId === undefined || characterId === null || !context.characters || !context.characters[characterId]) return null;
            const charObj = context.characters[characterId];
            endpoint = '/api/chats/get';
            requestBody = { ch_name: charObj.name, file_name: chatFileNameNoExt, avatar_url: charObj.avatar };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
            if (!response.ok) return null;
            const chatDataResponse = await response.json();
            if (Object.keys(chatDataResponse).length === 0 && chatDataResponse.constructor === Object) {
                finalMetadataObject = { favorites: [] };
                messages = [];
            } else if (Array.isArray(chatDataResponse) && chatDataResponse.length > 0) {
                if (typeof chatDataResponse[0] === 'object' && chatDataResponse[0] !== null && !Array.isArray(chatDataResponse[0])) {
                    const rawMetadata = chatDataResponse[0];
                    if (typeof rawMetadata.chat_metadata === 'object' && rawMetadata.chat_metadata !== null) {
                        finalMetadataObject = JSON.parse(JSON.stringify(rawMetadata.chat_metadata));
                    } else {
                        finalMetadataObject = JSON.parse(JSON.stringify(rawMetadata));
                    }
                    messages = chatDataResponse.slice(1);
                } else {
                    messages = chatDataResponse.filter(item => typeof item === 'object' && item !== null);
                    finalMetadataObject = { favorites: [] };
                }
            } else if (typeof chatDataResponse === 'object' && chatDataResponse !== null && Object.keys(chatDataResponse).length > 0 && !Array.isArray(chatDataResponse)) {
                if (chatDataResponse.user_name !== undefined || chatDataResponse.character_name !== undefined || chatDataResponse.create_date !== undefined) {
                    if (typeof chatDataResponse.chat_metadata === 'object' && chatDataResponse.chat_metadata !== null) {
                        finalMetadataObject = JSON.parse(JSON.stringify(chatDataResponse.chat_metadata));
                    } else {
                        finalMetadataObject = JSON.parse(JSON.stringify(chatDataResponse));
                    }
                    messages = [];
                } else {
                    finalMetadataObject = { favorites: [] };
                    messages = [];
                }
            } else {
                finalMetadataObject = { favorites: [] };
                messages = [];
            }
        }
        if (!finalMetadataObject || typeof finalMetadataObject !== 'object') {
            finalMetadataObject = {};
        }
        finalMetadataObject.favorites = buildVirtualFavorites(messages);
        return { metadata: finalMetadataObject, messages };
    } catch (error) {
        // 请求被取消时向上抛出，让批量加载的循环能及时中断，而非静默返回空数据继续下一轮
        if (isAbortError(error, options.signal)) throw error;
        Logger.error(`getFullChatData error for "${chatFileNameNoExt}":`, error);
        return { metadata: { favorites: [] }, messages: [] };
    }
}

// ==================== 保存 ====================

// 大文件（>25MB）聊天在 Windows 下全量写回时，若与后台读取（如收藏面板打开时的
// 其他聊天加载、角色切换器扫描）并发，write-file-atomic 的 rename 会因文件被占用
// 报 EPERM（瞬时文件锁）。重试可等锁释放后成功；最终失败则 rethrow 并明确提示，
// 避免收藏静默丢失（刷新页面后消失）。
const MAX_SAVE_RETRIES = 3;

/**
 * 保存指定聊天的元数据（收藏的唯一落库入口）。
 * - 剥离虚拟 favorites，只写收藏索引（count / updated_at / index_version），避免 JSONL 冗余膨胀
 * - 条数一律按「即将落库的消息数组」现算，不信任调用方传入的 favorites（可能已过时）
 * - 自动识别目标聊天所属角色/群组（支持跨角色保存：当前 context 可能并非该收藏所属角色）
 * - 失败重试 3 次（指数退避），最终失败 rethrow 供调用方回滚
 */
export async function saveSpecificChatMetadata(chatFileNameNoExt, metadataToSave, messagesArray = null) {
    Logger.debug(`saveSpecificChatMetadata: chat=${chatFileNameNoExt}`);
    const context = getContext();

    // ---- 数据准备（只做一次，重试时复用同一份快照） ----
    // 从缓存查找该聊天所属的角色/群组信息（支持跨角色保存：当前 context 可能并非该收藏所属角色）
    const cachedChat = findChatData(chatFileNameNoExt);
    const isGroupChat = cachedChat ? !!cachedChat.isGroup : !!context.groupId;
    const targetCharacterId = (cachedChat && cachedChat.characterId !== undefined && cachedChat.characterId !== null) ? cachedChat.characterId : context.characterId;
    const targetGroupId = (cachedChat && cachedChat.groupId !== undefined && cachedChat.groupId !== null) ? cachedChat.groupId : context.groupId;

    if (messagesArray === null) {
        const fullChatData = await getFullChatData(targetCharacterId, targetGroupId, chatFileNameNoExt, isGroupChat);
        if (!fullChatData || !fullChatData.messages) {
            toastr.error(`保存收藏夹变动时错误：无法加载聊天消息。`);
            return;
        }
        messagesArray = fullChatData.messages;
    }

    // 剥离虚拟的 favorites 数组，防止其被真实写入 JSONL 导致文件臃肿；
    // 同时注入收藏索引（count / updated_at / index_version）：
    //   - favorites_count           供 /api/characters/chats 返回聊天元数据时直接筛选
    //   - favorites_updated_at      收藏索引缓存的增量刷新信号（时间戳变化 = 收藏可能变化）
    //   - favorites_index_version   标记「索引由会维护它的版本写出」，读取侧才敢信任 count===0
    //
    // 条数一律以「即将落库的消息数组」现算，而不是取调用方传入的 metadata.favorites：
    // 后者可能是上一次的虚拟收藏缓存（预览重载、缓存与实时数组分离等都会让它过时），
    // 据此写出的正是「文件里有 star_favorite、favorites_count 却是 0」这类脏索引。
    // 重建时保留「每张卡片正在看第几个 swipe」：保存成功后会把虚拟收藏回写到实时/缓存元数据，
    // 不保留的话每次落库都会把用户切换到的 2/N 重置回 1/N。
    const liveFavorites = preserveSwipeViewIndexes(buildVirtualFavorites(messagesArray), metadataToSave?.favorites);
    const metadataClone = JSON.parse(JSON.stringify(metadataToSave));
    delete metadataClone.favorites;
    metadataClone.favorites_count = liveFavorites.length;
    metadataClone.favorites_updated_at = Date.now();
    metadataClone.favorites_index_version = FAVORITES_INDEX_VERSION;

    // 把索引回写到调用方持有的元数据对象（实时 chatMetadata 或缓存条目）：
    // 只写落库副本的话，ST 自己保存聊天时会把文件里上一次的旧索引又覆盖回去。
    // 虚拟 favorites 一律走 setVirtualFavorites（不可枚举），避免被宿主 saveChat 的
    // 浅拷贝带进 JSONL；此处仍要写，因为面板依赖 cache.metadata.favorites。
    setVirtualFavorites(metadataToSave, liveFavorites);
    metadataToSave.favorites_count = metadataClone.favorites_count;
    metadataToSave.favorites_updated_at = metadataClone.favorites_updated_at;
    metadataToSave.favorites_index_version = FAVORITES_INDEX_VERSION;

    // 索引已重算并落库，「已核对为空」的会话备忘对该聊天失效
    forgetChatWithoutFavorites(chatFileNameNoExt, targetCharacterId, targetGroupId);

    const finalMetadataObjectForSave = {
        user_name: context.userAlias || context.name1 || "User",
        character_name: "Unknown",
        create_date: metadataToSave.create_date || timestampToMoment(Date.now()).format('YYYY-MM-DD HH:mm:ss'),
        chat_metadata: metadataClone
    };
    const chatContentToSave = [];
    chatContentToSave.push(finalMetadataObjectForSave);
    chatContentToSave.push(...messagesArray);
    const requestBody = { chat: chatContentToSave, file_name: chatFileNameNoExt, force: true };

    if (isGroupChat) {
        if (targetGroupId === undefined || targetGroupId === null) { toastr.error("无法保存群组聊天收藏：群组ID未知。"); return; }
        requestBody.is_group = true;
        requestBody.id = targetGroupId;
        const group = context.groups?.find(g => g.id === targetGroupId);
        finalMetadataObjectForSave.character_name = group ? group.name : "Group Chat";
    } else {
        if (targetCharacterId === undefined || targetCharacterId === null || !context.characters || !context.characters[targetCharacterId]) { toastr.error("无法保存角色聊天收藏：角色信息未知。"); return; }
        const charObj = context.characters[targetCharacterId];
        requestBody.ch_name = charObj.name;
        requestBody.avatar_url = charObj.avatar;
        finalMetadataObjectForSave.character_name = charObj.name;
    }
    chatContentToSave[0] = finalMetadataObjectForSave;

    // ---- 带重试的保存请求 ----
    for (let attempt = 1; attempt <= MAX_SAVE_RETRIES; attempt++) {
        try {
            const response = await fetch('/api/chats/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), cache: 'no-cache' });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Server responded with ${response.status}: ${errorText}`);
            }
            const chatDataInCache = findChatData(chatFileNameNoExt);
            if (chatDataInCache) {
                chatDataInCache.metadata = JSON.parse(JSON.stringify(metadataToSave));
                // 虚拟 favorites 是不可枚举的，JSON 深拷贝不会带上它；但面板的
                // 「编辑备注/标签/取消收藏」要靠 cache.metadata.favorites 用 favId 定位
                // （见 core.js 的 findFavSwipesInTarget），因此这里必须显式补回去。
                chatDataInCache.favorites = metadataToSave.favorites || [];
                setVirtualFavorites(chatDataInCache.metadata, chatDataInCache.favorites);
                chatDataInCache.messages = JSON.parse(JSON.stringify(messagesArray));
            }
            // 标记 TTL 内缓存有变更（仅作切换器 UI 提示，重扫由 TTL 时间驱动，见 ui/character-switcher.js）
            state.charactersCacheStale = true;
            return;
        } catch (error) {
            const lastAttempt = attempt === MAX_SAVE_RETRIES;
            Logger.error(`Error in saveSpecificChatMetadata for ${chatFileNameNoExt}${lastAttempt ? '' : `（第 ${attempt} 次，准备重试）`}`, error);
            if (lastAttempt) {
                toastr.error(`保存聊天 "${chatFileNameNoExt}" 的收藏夹变动失败：${error.message || '未知错误'}。请检查服务器连接后重试，当前改动可能未保存。`);
                // rethrow：让调用方（如编辑原文的回滚逻辑）感知失败，避免 UI 与文件不一致
                throw error;
            }
            // 递增退避：2s、4s、8s……等待瞬时文件锁释放。
            // （保存前已中断预加载扫描，服务端已开始的读取会在数秒内清理完毕，此间隔足够避开 EPERM 窗口）
            await new Promise(resolve => setTimeout(resolve, attempt * 2000));
        }
    }
}
