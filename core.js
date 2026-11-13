// core.js - 核心业务逻辑模块（收藏增删改查）
//
// 分层约定（重构后）：
//   - 本模块只做「收藏数据的读写 + 必要的 DOM 同步」，不反向依赖 ui/main.js、ui/character-switcher.js。
//     需要「刷新收藏面板」「保存前中断后台预加载」这类跨层动作时，通过 hooks.js 的注册中心由 UI 模块注入，
//     从而避免 core ↔ ui 的循环依赖（此前用 8 处动态 import 绕过）。
//   - 通用弹窗（确认/输入/标签/编辑器）来自 ui/components.js —— 它是只依赖 state 的叶子模块，
//     静态导入不会形成循环，因此不必再动态引入。
//   - 纯数据逻辑（虚拟收藏构建、旧格式迁移、swipe 定位）集中在 domain.js，可独立单测。

import { getContext } from '../../../extensions.js';
import { uuidv4 } from '../../../utils.js';
import { reloadCurrentChat } from '../../../../script.js';
import { state, findChatData, resolveChatAreaTargetChatFile } from './state.js';
import {
    applyFavoritePatch,
    buildFavoritePatch,
    buildVirtualFavorites,
    findFavSwipesById,
    isBlankMessage,
    mutateSwipeFavorite,
    preserveSwipeViewIndexes,
    setVirtualFavorites,
} from './domain.js';
import { stripJsonlExt } from './utils.js';
import { FAVORITES_INDEX_VERSION, getFullChatData, saveSpecificChatMetadata } from './chat-data.js';
import {
    showConfirmModal,
    showInputModal,
    showEditorModal,
    showTagsModal,
} from './ui/components.js';
import { getCoreHooks } from './hooks.js';
import Logger from './Logger.js';

// ==================== 跨层钩子（见 hooks.js） ====================
// 本模块需要触发、但实现位于上层 UI 模块的动作（保存前中断预加载 / 收藏变化后刷新面板）
// 走 hooks.js 的注册中心，避免数据层 import UI 层造成循环依赖。

async function refreshFavoritesViewIfNeeded() {
    if (!state.modalElement || !state.modalElement.classList.contains('visible')) return;
    const hook = getCoreHooks().refreshFavoritesView;
    if (typeof hook !== 'function') {
        Logger.debug('未注入 refreshFavoritesView 钩子，跳过面板刷新');
        return;
    }
    await hook(state.currentViewingChatFile);
}

// ==================== 虚拟收藏数组缓存 ====================

// 缓存键为 chat 数组引用 + 长度 + chatMetadata 引用（消息增删必然改变长度；内容替换不影响收藏结构）。
// 加入 chatMetadata 引用作为「聊天身份」校验：ST 每次加载聊天都会重新赋值 chat_metadata，
// 即使 chat 数组被 ST 原地 splice 填充（引用与最终长度不变），身份变化也能让缓存失效，
// 避免读操作命中内容已变但引用/长度未变的脏缓存（表现为面板显示错误条数）。
// 收藏写操作（增/删/改备注/改标签）重建后主动写入缓存；读操作（ensureFavoritesArrayExists）
// 命中时直接复用，避免对上千条消息的聊天在每次渲染/切换收藏时反复全量遍历。
let _virtualFavoritesCacheChat = null;
let _virtualFavoritesCacheLength = -1;
let _virtualFavoritesCacheMeta = null;
let _virtualFavoritesCacheResult = null;

function writeVirtualFavoritesCache(messagesArray, chatMetadata, result) {
    _virtualFavoritesCacheChat = messagesArray;
    _virtualFavoritesCacheLength = Array.isArray(messagesArray) ? messagesArray.length : 0;
    _virtualFavoritesCacheMeta = chatMetadata ?? null;
    _virtualFavoritesCacheResult = result;
    return result;
}

function buildVirtualFavoritesCached(messages, chatMetadata = null) {
    const length = Array.isArray(messages) ? messages.length : 0;
    if (_virtualFavoritesCacheResult && messages === _virtualFavoritesCacheChat && length === _virtualFavoritesCacheLength && chatMetadata === _virtualFavoritesCacheMeta) {
        return _virtualFavoritesCacheResult;
    }
    // 重建时带上旧虚拟收藏里的「卡片正在看第几个 swipe」，避免一次缓存失效就把用户位置重置
    const rebuilt = preserveSwipeViewIndexes(buildVirtualFavorites(messages), chatMetadata?.favorites);
    return writeVirtualFavoritesCache(messages, chatMetadata, rebuilt);
}

/**
 * 收藏写操作（增/删/改备注/改标签）后强制重建虚拟收藏缓存并写入缓存。
 * 写操作只改变 swipe_info 的收藏结构、不改变 chat 长度，而缓存键是「引用 + 长度」，
 * 若沿用 buildVirtualFavoritesCached 会命中旧缓存，导致 UI 与实际数据不一致（如删除后仍显示、改标签后不刷新）。
 * @param {Array|null} previousFavorites - 改动前的虚拟收藏，用于保留每张卡片的 swipe 查看位置
 */
function rebuildVirtualFavoritesCache(messagesArray, chatMetadata = null, previousFavorites = null) {
    const rebuilt = preserveSwipeViewIndexes(buildVirtualFavorites(messagesArray), previousFavorites);
    return writeVirtualFavoritesCache(messagesArray, chatMetadata, rebuilt);
}

const messageButtonHtml = `
    <div class="mes_button favorite-toggle-icon interactable" title="收藏/取消收藏 (长按编辑备注)" tabindex="0" role="button" aria-label="收藏或取消收藏这条消息">
        <i class="fa-solid fa-star" aria-hidden="true"></i>
    </div>
`;

// ==================== 收藏数据定位（写操作的统一前置） ====================

/**
 * 解析本次写操作的目标聊天，并取出对应的消息数组。
 *
 * 为什么必须区分「当前聊天」与「其他聊天」：
 *   - 当前聊天必须写 ST 的 context.chat 真实数组（cache.messages 可能是保存后的深拷贝副本，
 *     写入副本会导致聊天区图标与实际数据脱节）；
 *   - 其他聊天（跨角色浏览/预览模式）只能通过缓存里的消息数组写入。
 *
 * @param {string|null} targetChatFile - 目标聊天文件名（可带 .jsonl），null 表示当前查看的聊天
 * @returns {{chatFile:string, currentChatFile:string, isCurrent:boolean, cache:object|null, messagesArray:Array|null}}
 */
function resolveWriteTarget(targetChatFile = null) {
    const context = getContext();
    const currentChatFile = stripJsonlExt(context.chatId || '');
    // 未显式指定目标时一律按「当前聊天」处理。
    // 注意：绝不能回退到 state.currentViewingChatFile —— 那是收藏面板正在浏览的聊天，
    // 用过「切换角色」后它可能是**另一个角色**的聊天；聊天区的操作（Alt+S 收藏最后一条消息、
    // 聊天区图标等）按它定位就会把收藏写进别的聊天文件（实测 Alt+S 会写串）。
    // 面板内的操作（编辑备注/标签、取消收藏）都由 ui/main.js 传入显式目标。
    const chatFile = stripJsonlExt(targetChatFile) || currentChatFile;
    const isCurrent = !!chatFile && chatFile === currentChatFile;
    const cache = findChatData(chatFile);
    // 非当前聊天只能写缓存里的消息数组；缓存缺失时**不能**退化成 context.chat ——
    // 那会把当前聊天的消息写进另一个聊天的文件（数据串档）。此时返回 null，
    // 由各写操作自行拒绝本次修改（见 AGENTS.md「收藏写操作」）。
    const messagesArray = isCurrent ? context.chat : (cache ? cache.messages : null);
    return { chatFile, currentChatFile, isCurrent, cache, messagesArray };
}

/**
 * 把收藏索引字段写进「实时元数据对象」。
 *
 * 为什么不能只在落库时写副本：ST 自己也会保存聊天（生成消息、切换 swipe、切换角色时
 * 写的是实时 chat_metadata），它会把文件里上一次的旧索引原样覆盖回去。索引一旦变成
 * 「消息里有 star_favorite、favorites_count 却是 0」，该聊天的收藏就会在侧栏与角色
 * 切换器里彻底查不到（读取侧把 count===0 当作确定无收藏）。
 */
function stampFavoritesIndex(chatMetadata, favoritesCount) {
    if (!chatMetadata || typeof chatMetadata !== 'object') return;
    chatMetadata.favorites_count = favoritesCount;
    chatMetadata.favorites_updated_at = Date.now();
    chatMetadata.favorites_index_version = FAVORITES_INDEX_VERSION;
}

/**
 * 写操作完成后的统一收尾：重建虚拟收藏缓存 + 按目标类型落库。
 * 所有收藏写操作都必须走这里，否则会出现「UI 刷新了但文件没存」「文件存了但 UI 没刷新」这类不同步问题。
 */
function commitFavoriteWrite({ chatFile, isCurrent, cache, messagesArray }) {
    // 改动前的收藏状态。这里必须在覆盖 cache.favorites 之前取：
    //   - 当前聊天的保存有防抖，期间可能被切换聊天打断，需据此算补丁；
    //   - 两种聊天都用它保留「卡片正在看第几个 swipe」，否则每次写操作都会跳回 1/N。
    const previousFavorites = (cache && Array.isArray(cache.favorites))
        ? cache.favorites
        : (isCurrent ? (getContext().chatMetadata?.favorites || null) : null);

    const virtualFavs = rebuildVirtualFavoritesCache(messagesArray, null, previousFavorites);

    if (cache) {
        cache.favorites = virtualFavs;
        if (cache.metadata) setVirtualFavorites(cache.metadata, virtualFavs);
    }

    if (isCurrent) {
        const chatMetadata = getContext().chatMetadata;
        // 不可枚举：否则宿主 saveChat() 的 {...chat_metadata} 会把这个纯 UI 缓存写进 JSONL
        setVirtualFavorites(chatMetadata, virtualFavs);
        // 索引同步写进实时元数据，ST 之后的任何一次保存都会带上正确的索引（见 stampFavoritesIndex）
        stampFavoritesIndex(chatMetadata, virtualFavs.length);
        recordPendingFavoritePatch(chatFile, previousFavorites, virtualFavs, messagesArray);
        scheduleFavoriteSave();
    } else if (cache) {
        // 其他聊天直接落库（saveSpecificChatMetadata 内部已重试并提醒用户，这里只留调试痕迹）。
        // 注意：只能调用一次——重复调用会对同一个文件并发写两次，在 Windows 上徒增文件锁冲突。
        saveSpecificChatMetadata(chatFile, cache.metadata, messagesArray)
            .catch(e => Logger.debug('保存其他聊天收藏失败（已内部提示）:', e));
    } else {
        Logger.warn(`收藏已修改但目标聊天 ${chatFile} 不在缓存中，无法持久化`);
    }

    // 收藏数变化：标记 TTL 内缓存有变更（仅作切换器 UI 提示，重扫由 TTL 时间驱动，见 ui/character-switcher.js）
    state.charactersCacheStale = true;
    return virtualFavs;
}

// ==================== 待落库的收藏补丁（防抖期间被切换聊天的兜底） ====================
//
// 当前聊天的收藏保存有 800ms 防抖，但 ST 切换聊天时（openCharacterChat → clearChat
// ({clearData:true})）会直接把内存里的 chat 数组丢掉、并且**不保存**。于是
// 「收藏一条消息后立刻切换聊天」时，防抖到期的保存已经没有数组可写，收藏会永久丢失。
//
// 补丁只记录「哪些消息的哪个 swipe 应该处于什么收藏状态」（幂等的完整快照，几十字节/条），
// 因此可以在切换之后重新读取目标聊天文件、把补丁重放上去再落库，把这次改动救回来。
let _pendingFavoritePatch = new Map();
let _pendingFavoritePatchChatFile = '';

/** 把一次收藏改动折算成补丁（按聊天归档：换了聊天就重新开始累积）。 */
function recordPendingFavoritePatch(chatFile, previousFavorites, nextFavorites, messagesArray = null) {
    if (!chatFile) return;
    if (_pendingFavoritePatchChatFile !== chatFile) {
        _pendingFavoritePatch = new Map();
        _pendingFavoritePatchChatFile = chatFile;
    }
    // 传入消息数组：补丁键会带上消息身份指纹，重放时才能发现「索引已漂移」
    // （防抖窗口内删过消息时，同一个索引可能已经是另一条消息）
    for (const [key, value] of buildFavoritePatch(previousFavorites, nextFavorites, messagesArray)) {
        _pendingFavoritePatch.set(key, value);
    }
}

/** 收藏改动已落库（或确认无法落库）后清空补丁，避免之后被重放到已经更新的数据上。 */
function clearPendingFavoritePatch(chatFile) {
    if (chatFile && _pendingFavoritePatchChatFile !== chatFile) return;
    _pendingFavoritePatch = new Map();
    _pendingFavoritePatchChatFile = '';
}

/**
 * 目标聊天已被切换走时的兜底落库：重读该聊天文件 → 重放补丁 → 保存。
 * 读不到消息（聊天已删除/读取失败）时直接放弃，绝不写出空聊天覆盖文件。
 */
async function flushPendingFavoritePatchForChat(chatFile) {
    const patch = (_pendingFavoritePatchChatFile === chatFile) ? _pendingFavoritePatch : null;
    if (!patch || patch.size === 0) return;

    const cache = findChatData(chatFile);
    if (!cache) {
        Logger.warn(`聊天已切换且缓存中找不到 ${chatFile}，无法补写收藏改动`);
        clearPendingFavoritePatch(chatFile);
        return;
    }

    try {
        const fullChatData = await getFullChatData(
            cache.characterId ?? null,
            cache.groupId ?? null,
            chatFile,
            !!cache.isGroup
        );
        if (!fullChatData || !Array.isArray(fullChatData.messages) || fullChatData.messages.length === 0) {
            Logger.warn(`聊天已切换且无法读回 ${chatFile} 的消息，收藏改动未补写`);
            clearPendingFavoritePatch(chatFile);
            return;
        }

        const applied = applyFavoritePatch(fullChatData.messages, patch);
        await saveSpecificChatMetadata(chatFile, fullChatData.metadata, fullChatData.messages);
        Logger.info(`聊天已切换，收藏改动已按补丁补写回 ${chatFile}（${applied} 条）`);
        clearPendingFavoritePatch(chatFile);
    } catch (error) {
        // 网络/文件锁等失败：saveSpecificChatMetadata 内部已重试并提示，这里只记录
        Logger.error(`切换聊天后补写收藏失败（${chatFile}）:`, error);
        clearPendingFavoritePatch(chatFile);
    }
}

/**
 * 确保当前聊天已缓存。
 * 防止在打开模态框前收藏时出现"chat cache not found"错误。
 */
export function ensureCurrentChatIsCached() {
    try {
        const context = getContext();
        if (!context || !context.chatId) return;

        const currentChatFile = stripJsonlExt(context.chatId);
        if (findChatData(currentChatFile)) return;

        const currentChatMetadata = ensureFavoritesArrayExists() || { favorites: [] };

        state.allChatsFavoritesData.push({
            fileName: currentChatFile,
            displayName: currentChatFile,
            metadata: currentChatMetadata,
            favorites: currentChatMetadata.favorites || [],
            messages: context.chat || [],
            isGroup: !!context.groupId,
            characterId: context.characterId,
            groupId: context.groupId,
        });
        Logger.info(`已缓存新聊天数据: ${currentChatFile}`);

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
    const previousFavorites = Array.isArray(context.chatMetadata.favorites) ? context.chatMetadata.favorites : null;
    const virtualFavorites = forceRebuild
        ? rebuildVirtualFavoritesCache(context.chat, context.chatMetadata, previousFavorites)
        : buildVirtualFavoritesCached(context.chat, context.chatMetadata);
    // 不可枚举：宿主 saveChat() 的 {...chat_metadata} 不该把纯 UI 缓存带进 JSONL（见 domain.js）
    setVirtualFavorites(context.chatMetadata, virtualFavorites);
    return context.chatMetadata;
}

/**
 * 消息数组发生「收藏以外的」变化后，重算并写回当前聊天的收藏索引。
 *
 * 为什么需要它：收藏存在消息自身（swipe_info.star_favorite）里，删除消息时收藏是**随消息一起
 * 消失**的——`removeFavoriteById` 找不到目标就直接返回，于是实时 chatMetadata 上的
 * `favorites_count` 还停在删除前的值。SillyTavern 之后保存聊天会把这个过期计数写进文件，
 * 而侧栏预过滤与角色切换器徽标都以它为准（表现为「已经没有任何收藏的聊天仍显示有 1 条收藏」）。
 */
export function syncCurrentChatFavoritesIndex() {
    const context = getContext();
    if (!context || !Array.isArray(context.chat) || !context.chatMetadata) return;
    const cache = findChatData(stripJsonlExt(context.chatId || ''));
    const previousFavorites = Array.isArray(context.chatMetadata.favorites)
        ? context.chatMetadata.favorites
        : (cache?.favorites || null);
    const virtualFavs = rebuildVirtualFavoritesCache(context.chat, context.chatMetadata, previousFavorites);
    setVirtualFavorites(context.chatMetadata, virtualFavs);
    stampFavoritesIndex(context.chatMetadata, virtualFavs.length);

    if (cache) {
        cache.favorites = virtualFavs;
        if (cache.metadata) setVirtualFavorites(cache.metadata, virtualFavs);
    }
    state.charactersCacheStale = true;
}

// ==================== 当前聊天收藏保存（防抖 + 失败重试） ====================

// ST 的 saveMetadataDebounced 会对整个 26MB 聊天全量写回且内部吞掉错误：
// 大文件下与后台读取（收藏面板打开时的其他聊天加载/角色切换器扫描）并发时，
// Windows 下 write-file-atomic 的 rename 会因文件被占用报 EPERM，保存静默失败、
// 收藏刷新后丢失。改由插件自管防抖保存：走 saveSpecificChatMetadata
// （剥离虚拟 favorites 避免 ST 持久化冗余、带失败重试 + 明确失败提示）。
// 收藏保存防抖时长：合并连续点击（连点两下星标只写一次全量文件），同时给后台读取
// 留出退让窗口。代价是「改动后立刻切换聊天/退出预览」可能赶不上这次保存，
// 因此凡是会丢弃内存改动的调用点必须先 await flushPendingFavoriteSave()。
const FAVORITE_SAVE_DEBOUNCE_MS = 800;

let _favoriteSaveTimer = null;
let _favoriteSaveSeq = 0;
// 本次待保存的目标聊天标识（flush 时复用，保证「待保存」只有一个事实来源）
let _favoriteSaveChatFile = '';
// 已启动（防抖到点）的保存 Promise：flush 必须等待它，否则 reload 会与在途写盘竞态
let _favoriteSavePromise = null;

function scheduleFavoriteSave() {
    clearTimeout(_favoriteSaveTimer);
    // 记录触发时的聊天标识：防抖到期后若已切换聊天则放弃本次保存（与 ST 原 saveMetadataDebounced
    // 的角色切换保护一致），避免把旧聊天的改动写到新聊天文件上。
    const context = getContext();
    _favoriteSaveChatFile = stripJsonlExt(context.chatId || '');
    _favoriteSaveTimer = setTimeout(() => {
        _favoriteSaveTimer = null;
        const seq = ++_favoriteSaveSeq;
        const savePromise = saveCurrentChatFavorites(seq, _favoriteSaveChatFile);
        _favoriteSavePromise = savePromise;
        // saveCurrentChatFavorites 内部已捕获所有异常，这里的 finally 只负责清理引用
        savePromise.finally(() => {
            if (_favoriteSavePromise === savePromise) _favoriteSavePromise = null;
        });
    }, FAVORITE_SAVE_DEBOUNCE_MS);
}

async function saveCurrentChatFavorites(seq, expectedChatFile) {
    // 防抖窗口内又触发了新保存 → 本次跳过（下一次会带上最新数据）
    if (seq !== _favoriteSaveSeq) return;

    const context = getContext();
    const chatFile = stripJsonlExt(context.chatId || '');
    // 防抖期间切换了聊天：内存里的 chat 数组已被 ST 丢弃（clearChat），
    // 此时不能再写 context.chat（那是新聊天），改为对目标聊天「重读文件 + 重放补丁」。
    if (chatFile !== expectedChatFile) {
        await flushPendingFavoritePatchForChat(expectedChatFile);
        return;
    }
    if (!chatFile) return;

    // 防抖期间可能已切换聊天，跳过陈旧的保存任务
    if (seq !== _favoriteSaveSeq) return;

    // 保存前中断后台预加载扫描：打开面板时的预加载会对所有角色（含当前聊天）
    // 全量读取 26MB 文件，与本次全量写回并发时，Windows 下文件锁会导致
    // write-file-atomic 的 rename 失败（EPERM），收藏保存失败、刷新后丢失。
    // 钩子未注入或执行失败都不阻断保存（预加载中断只是尽力而为）。
    try {
        await getCoreHooks().beforeSave?.();
    } catch (e) {
        Logger.debug('保存前的后台预加载中断失败（不影响保存）:', e);
    }

    // beforeSave 是异步的，期间可能已经切换了聊天——ST 切换聊天时是**原地**替换同一个
    // chat 数组的内容（chat.splice），messagesArray 这个引用会跟着指向新聊天的消息，
    // 直接写就会把新聊天的消息写进旧聊天的文件。此时改走补丁重放。
    // 这里同时重新取一次 context：getContext() 返回的是**值快照**，而宿主的
    // updateChatMetadata() 是整体换对象（chat_metadata = {...chat_metadata, ...newValues}），
    // 沿用旧快照会写回一个已经被换掉的元数据对象。
    const liveContext = getContext();
    if (stripJsonlExt(liveContext.chatId || '') !== chatFile) {
        await flushPendingFavoritePatchForChat(chatFile);
        return;
    }

    // 元数据一律用**实时对象**：本函数只保存当前聊天，而 cache.metadata 在每次保存成功后
    // 会被替换成深拷贝快照（见 saveSpecificChatMetadata），它与实时对象必然分叉。
    // 若沿用缓存副本，其它扩展/宿主自上次收藏保存以来写入的字段
    // （variables / world_info / tainted / 各扩展自己的命名空间）会被静默回滚。
    const metadataToSave = liveContext.chatMetadata;
    // 保存当前聊天必须用 ST 的 context.chat 真实数组（cache.messages 可能是
    // 上次保存后的深拷贝，若保存副本会丢失 ST 侧新增/修改的消息，且收藏写入
    // 的是 context.chat（见 addFavorite 等），两者必须一致）。
    const messagesArray = liveContext.chat;
    if (!metadataToSave || !Array.isArray(messagesArray)) return;

    // ST 重载同一聊天时（clearChat → getChat）chat 数组会短暂为空；此写盘会把聊天文件清空。
    // 缓存里还有消息 = 这不是「真的空聊天」，保留补丁，等重载完成后的 CHAT_CHANGED 重放。
    if (messagesArray.length === 0) {
        const cache = findChatData(chatFile);
        if (cache && Array.isArray(cache.messages) && cache.messages.length > 0) {
            Logger.warn('收藏保存时检测到聊天数组为空（疑似 ST 正在重载），已跳过本次写盘，等待重载后的补丁重放');
            return;
        }
    }

    // 兜底：防抖窗口内该聊天被 ST 重载（getChat/openCharacterChat 会 clearChat 后重读文件），
    // 内存数组已被替换成「不含刚做改动」的文件内容。此时把待落库补丁重放到即将保存的数组上，
    // 保证这次写盘一定包含用户的收藏改动（补丁是幂等的，正常路径下重放为 0 次生效）。
    if (_pendingFavoritePatchChatFile === chatFile && _pendingFavoritePatch.size > 0) {
        const applied = applyFavoritePatch(messagesArray, _pendingFavoritePatch);
        if (applied > 0) {
            Logger.debug(`保存前重放了 ${applied} 条待落库收藏改动（聊天在防抖期间被重载）`);
            const virtualFavs = rebuildVirtualFavoritesCache(messagesArray, metadataToSave, metadataToSave.favorites);
            setVirtualFavorites(metadataToSave, virtualFavs);
            stampFavoritesIndex(metadataToSave, virtualFavs.length);
            const cache = findChatData(chatFile);
            if (cache) {
                cache.favorites = virtualFavs;
                if (cache.metadata) setVirtualFavorites(cache.metadata, virtualFavs);
            }
            refreshFavoriteIconsInView();
        }
    }

    try {
        await saveSpecificChatMetadata(chatFile, metadataToSave, messagesArray);
        // 已按内存数据落库，待落库补丁作废（否则之后切换聊天会被重放到更新的数据上）
        clearPendingFavoritePatch(chatFile);
    } catch (error) {
        // saveSpecificChatMetadata 内部已重试并 toastr 提示，这里兜底记录
        Logger.error('保存当前聊天收藏失败:', error);
    }
}

/**
 * 立即落库尚未到期的收藏改动（没有待保存任务时什么也不做）。
 *
 * 必须在任何「会丢弃内存改动」的 reload 之前调用：退出预览与编辑原文都会走
 * reloadCurrentChat()，而 ST 会从文件重新读取 chat 与 chat_metadata（chat.splice +
 * 重新赋值 chat_metadata），把还没落库的收藏改动直接覆盖掉——表现为
 * 「在预览里取消收藏，退出预览后消息依然是收藏状态」。
 *
 * 已切换聊天时本次保存会被 saveCurrentChatFavorites 的聊天标识校验放弃，
 * 不会把旧聊天的消息写到新聊天文件上。
 */
export async function flushPendingFavoriteSave() {
    if (_favoriteSaveTimer === null) {
        // 防抖已到点、写盘还在途：必须等它结束，否则随后的 reload 会读到旧文件
        if (_favoriteSavePromise) {
            try {
                await _favoriteSavePromise;
            } catch (error) {
                Logger.debug('等待在途收藏保存失败（后续 reload 会读到服务端结果）:', error);
            }
        }
        return;
    }
    clearTimeout(_favoriteSaveTimer);
    _favoriteSaveTimer = null;
    const seq = ++_favoriteSaveSeq;
    const savePromise = saveCurrentChatFavorites(seq, _favoriteSaveChatFile);
    _favoriteSavePromise = savePromise;
    try {
        await savePromise;
    } finally {
        if (_favoriteSavePromise === savePromise) _favoriteSavePromise = null;
    }
}

/**
 * 聊天重载后把「待落库收藏补丁」重放到当前聊天并立即落库。
 *
 * 场景：收藏后 800ms 防抖内，ST 重载了**同一个聊天**（点击聊天列表里的当前聊天、
 * 扩展调用 reloadCurrentChat 等）。clearChat 会丢弃内存数组，重读的文件里没有这次改动；
 * 若不处理，防抖到点的保存会把重载后的数组写回并把补丁清空——收藏被静默丢弃。
 * 在 CHAT_CHANGED 时调用本函数：先重放到刚加载的数组，rebuild 缓存/索引，再立即保存。
 * 聊天已切换（补丁属于别的聊天）时为空操作。
 */
export async function replayPendingFavoritePatchForCurrentChat() {
    const context = getContext();
    const chatFile = stripJsonlExt(context?.chatId || '');
    if (!chatFile || _pendingFavoritePatchChatFile !== chatFile || _pendingFavoritePatch.size === 0) return;

    const messages = context.chat;
    if (!Array.isArray(messages) || !context.chatMetadata) return;

    const applied = applyFavoritePatch(messages, _pendingFavoritePatch);
    clearPendingFavoritePatch(chatFile);
    if (applied === 0) return;

    Logger.info(`聊天重载后补写收藏改动 ${applied} 条（${chatFile}）`);
    const virtualFavs = rebuildVirtualFavoritesCache(messages, context.chatMetadata, context.chatMetadata.favorites);
    setVirtualFavorites(context.chatMetadata, virtualFavs);
    stampFavoritesIndex(context.chatMetadata, virtualFavs.length);
    const cache = findChatData(chatFile);
    if (cache) {
        cache.favorites = virtualFavs;
        if (cache.metadata) setVirtualFavorites(cache.metadata, virtualFavs);
    }
    state.charactersCacheStale = true;

    // 本次立即落库，取消尚未到期的旧防抖任务（否则它会用刚保存过的数据再写一次）
    if (_favoriteSaveTimer !== null) {
        clearTimeout(_favoriteSaveTimer);
        _favoriteSaveTimer = null;
    }
    _favoriteSaveSeq++;

    try {
        await saveSpecificChatMetadata(chatFile, context.chatMetadata, messages);
    } catch (error) {
        Logger.error('重载后补写收藏失败:', error);
    }
    refreshFavoriteIconsInView();
    await refreshFavoritesViewIfNeeded();
}

// ==================== 收藏增删改 ====================

/**
 * 添加收藏（直接写入 message.swipe_info）。
 * @returns {object|null} 新建的收藏对象（{id, note, create_date}），失败/已存在时返回已有对象或 null
 */
export function addFavorite(messageInfo, targetChatFile = null) {
    Logger.debug(`addFavorite: msgId=${messageInfo.messageId}, targetChat=${targetChatFile || '(当前)'}`);
    const { chatFile, isCurrent, cache, messagesArray } = resolveWriteTarget(targetChatFile);
    if (!Array.isArray(messagesArray)) {
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

    commitFavoriteWrite({ chatFile, isCurrent, cache, messagesArray });
    return newItem;
}

/**
 * 通过唯一 ID 遍历删除 swipe_info 中的收藏。
 */
export function removeFavoriteById(favoriteId, targetChatFile = null) {
    Logger.debug(`removeFavoriteById: favId=${favoriteId}, targetChat=${targetChatFile || '(当前)'}`);
    const { chatFile, isCurrent, cache, messagesArray } = resolveWriteTarget(targetChatFile);
    if (!Array.isArray(messagesArray)) {
        Logger.warn('removeFavoriteById: 消息数组为空');
        return false;
    }

    const removed = mutateSwipeFavorite(messagesArray, favoriteId, () => 'delete');
    if (!removed) {
        Logger.warn(`removeFavoriteById: 未找到 favId=${favoriteId}`);
        return false;
    }

    Logger.success(`removeFavoriteById: 删除成功, favId=${favoriteId}`);
    commitFavoriteWrite({ chatFile, isCurrent, cache, messagesArray });
    return true;
}

/**
 * 更新收藏备注（写入 swipe 数据本身，而非任何 UI 副本）。
 */
export function updateFavoriteNote(favoriteId, note, targetChatFile = null) {
    const { chatFile, isCurrent, cache, messagesArray } = resolveWriteTarget(targetChatFile);
    if (!Array.isArray(messagesArray)) return;

    const updated = mutateSwipeFavorite(messagesArray, favoriteId, (fav) => {
        fav.note = note;
        return 'update';
    });
    if (updated) commitFavoriteWrite({ chatFile, isCurrent, cache, messagesArray });
}

/**
 * 更新收藏标签（tags 数组，与备注 note 并存互不干扰）。
 * 老数据无 tags 字段时视为空数组，天然兼容。
 */
export function updateFavoriteTags(favoriteId, tags, targetChatFile = null) {
    const { chatFile, isCurrent, cache, messagesArray } = resolveWriteTarget(targetChatFile);
    if (!Array.isArray(messagesArray)) return;

    // 清洗：去空、去重、去首尾空格
    const cleanTags = [...new Set((tags || []).map(t => String(t).trim()).filter(Boolean))];

    const updated = mutateSwipeFavorite(messagesArray, favoriteId, (fav) => {
        fav.tags = cleanTags;
        return 'update';
    });
    if (updated) commitFavoriteWrite({ chatFile, isCurrent, cache, messagesArray });
}

// ==================== 收藏编辑入口（弹窗交互） ====================

/**
 * 在「当前聊天」或「缓存中的其他聊天」里定位某收藏所属的 swipe 列表。
 * @returns {Array|null} favoritedSwipes 列表
 */
function findFavSwipesInTarget(favId, chatFileToModify, currentChatFile) {
    if (chatFileToModify === currentChatFile) {
        return findFavSwipesById(ensureFavoritesArrayExists()?.favorites, favId);
    }
    if (!chatFileToModify) return null;
    const chatData = findChatData(chatFileToModify);
    return findFavSwipesById(chatData?.metadata?.favorites, favId);
}

/**
 * 从收藏面板编辑标签（与 handleEditNote 对称）。
 */
export async function handleEditTags(favId, targetChatFile = null) {
    const context = getContext();
    const currentChatFile = stripJsonlExt(context.chatId || '');
    const chatFileToModify = stripJsonlExt(targetChatFile) || state.currentViewingChatFile;

    const favSwipes = findFavSwipesInTarget(favId, chatFileToModify, currentChatFile);
    if (!favSwipes) {
        toastr.error('无法找到收藏项');
        return;
    }

    // 优先取与 favId 精确匹配的 swipe（多 swipe 场景下卡片 favId 是当前查看的那条），兜底取第一条
    const swipe = favSwipes.find(s => s.id === favId) || favSwipes[0];
    const currentTags = Array.isArray(swipe?.tags) ? [...swipe.tags] : [];

    const newTags = await showTagsModal(currentTags, '编辑标签');
    if (newTags === null) return;

    const unchanged = newTags.length === currentTags.length && newTags.every(t => currentTags.includes(t));
    if (unchanged) return;

    updateFavoriteTags(favId, newTags, chatFileToModify);
    // 刷新面板以显示标签徽章（updateFavoriteTags 已重建虚拟收藏缓存，重渲染即可拿到新 tags）
    await refreshFavoritesViewIfNeeded();
}

/**
 * 编辑备注（收藏面板入口）。
 */
export async function handleEditNote(favId, targetChatFile = null) {
    const context = getContext();
    const currentChatFile = stripJsonlExt(context.chatId || '');
    const chatFileToModify = stripJsonlExt(targetChatFile) || state.currentViewingChatFile;

    const favSwipes = findFavSwipesInTarget(favId, chatFileToModify, currentChatFile);
    if (!favSwipes) {
        toastr.error('无法找到收藏项');
        return;
    }

    // 优先取与 favId 精确匹配的 swipe（卡片 favId 是当前查看的那条），兜底取第一条
    const swipe = favSwipes.find(s => s.id === favId) || favSwipes[0];
    const currentNote = swipe ? (swipe.note || '') : '';

    const newNote = await showInputModal('', '编辑备注', currentNote, { isNoteMode: true });
    if (newNote === null || newNote === currentNote) return;

    updateFavoriteNote(favId, newNote, chatFileToModify);

    // 就地更新卡片上的备注（无需整表重渲染）
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
        } else if (noteEl) {
            noteEl.remove();
        }
    }
}

/**
 * 从聊天界面编辑备注（长按收藏图标触发）。
 * 未收藏时先收藏再编辑；若用户在弹窗中取消，则回滚这次「为编辑而收藏」。
 *
 * 目标聊天按「聊天区」语义解析（预览模式下 = 被预览的聊天，见 state.resolveChatAreaTargetChatFile）：
 * 旧实现读的是 context.chat、写的是当前聊天，因此在预览另一个聊天时，长按星标会把
 * 备注与「为编辑而收藏」的那条收藏写进当前聊天，而不是用户正在看的那一条。
 * @param {Element} targetIcon - .favorite-toggle-icon 元素
 * @param {string|null} [targetChatFile] - 显式指定目标聊天（不传则按聊天区语义解析）
 */
export async function handleEditNoteFromChat(targetIcon, targetChatFile = null) {
    ensureCurrentChatIsCached();
    const messageElement = $(targetIcon).closest('.mes');
    if (!messageElement.length) return;

    const messageIdString = messageElement.attr('mesid');
    if (!messageIdString) return;

    const context = getContext();
    const currentChatFile = stripJsonlExt(context.chatId || '');
    const chatFile = stripJsonlExt(targetChatFile) || resolveChatAreaTargetChatFile();
    if (!chatFile) return;

    const isCurrent = chatFile === currentChatFile;
    const messagesArray = isCurrent ? context.chat : (findChatData(chatFile)?.messages || null);
    if (!Array.isArray(messagesArray)) return;

    const message = messagesArray[parseInt(messageIdString, 10)];
    if (!message) return;

    const swipeId = message.swipe_id || 0;
    let favItem = message.swipe_info?.[swipeId]?.star_favorite || null;
    const wasAlreadyFavorited = !!favItem;

    if (!wasAlreadyFavorited) {
        const messageInfo = { messageId: messageIdString, sender: message.name, role: message.is_user ? 'user' : 'character' };
        favItem = addFavorite(messageInfo, chatFile);
        if (!favItem) {
            toastr.error('收藏失败，无法添加备注。');
            return;
        }
        $(targetIcon).addClass('favorited');
    }

    const favIdToEdit = favItem.id;
    const currentNote = favItem.note || '';
    const result = await showInputModal('', '编辑备注', currentNote, { isNoteMode: true });

    if (result !== null) {
        if (result !== currentNote) updateFavoriteNote(favIdToEdit, result, chatFile);
    } else if (!wasAlreadyFavorited) {
        removeFavoriteById(favIdToEdit, chatFile);
        $(targetIcon).removeClass('favorited');
    }
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
        if (!isBlankMessage(context.chat[i])) {
            idx = i;
            msg = context.chat[i];
            break;
        }
    }
    if (!msg) {
        toastr.info('当前聊天没有可收藏的消息');
        return;
    }

    ensureCurrentChatIsCached();
    // 显式传当前聊天：这是聊天区快捷键，目标必须与「面板正在浏览哪个聊天」无关
    const currentChatFile = stripJsonlExt(context.chatId || '');
    const swipeId = msg.swipe_id || 0;
    if (msg.swipe_info?.[swipeId]?.star_favorite) {
        removeFavoriteById(msg.swipe_info[swipeId].star_favorite.id, currentChatFile);
        toastr.info('已取消收藏最后一条消息');
    } else {
        addFavorite({ messageId: String(idx), sender: msg.name, role: msg.is_user ? 'user' : 'character' }, currentChatFile);
        toastr.success('已收藏最后一条消息（再次按 Alt+S 可取消）');
    }
    setTimeout(refreshFavoriteIconsInView, 100);
}

/**
 * 从弹窗取消收藏。
 */
export async function handleDeleteFavoriteFromPopup(favId, messageId, targetChatFile = null) {
    const chatFileForDeletion = stripJsonlExt(targetChatFile) || state.currentViewingChatFile;
    try {
        const confirmResult = await showConfirmModal('确定要取消这条收藏吗？', '确认取消', { hideHeader: true, noBorder: true });
        if (!confirmResult) return;

        const removed = removeFavoriteById(favId, chatFileForDeletion);
        if (!removed) {
            toastr.error('取消收藏失败');
            return;
        }

        await refreshFavoritesViewIfNeeded();

        // 若删的是当前聊天，同步熄灭聊天区的收藏图标
        const context = getContext();
        if (chatFileForDeletion === stripJsonlExt(context.chatId || '')) {
            const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
            if (messageElement.length) {
                messageElement.find('.favorite-toggle-icon').removeClass('favorited');
            }
        }
        toastr.success('收藏已取消');
    } catch (error) {
        Logger.error('deleting favorite:', error);
        toastr.error('取消收藏时发生错误');
    }
}

/**
 * 编辑消息原文（含内心独白）。
 * 直接改写目标聊天的消息数据并落库；当前聊天额外触发 reloadCurrentChat 让聊天区同步。
 */
export async function handleEditMessageContent(favId, messageId, targetChatFile = null, swipeId = null) {
    const chatFileToModify = stripJsonlExt(targetChatFile);
    const chatData = findChatData(chatFileToModify);
    if (!chatData || !Array.isArray(chatData.messages)) {
        toastr.error('错误：找不到此收藏对应的聊天数据缓存。');
        return;
    }

    // 当前聊天一律以 ST 的 context.chat 为准：缓存里的 messages 可能是上一次保存后的深拷贝，
    // 与实时数组不是同一个对象；若改的是副本，保存时会用旧副本覆盖掉刚发生的收藏改动。
    const isCurrentChat = chatFileToModify === stripJsonlExt(getContext().chatId || '');
    const messages = isCurrentChat ? getContext().chat : chatData.messages;

    const msgIndex = parseInt(messageId, 10);
    if (isNaN(msgIndex) || msgIndex < 0 || msgIndex >= messages.length) {
        toastr.error(`错误：消息索引无效 (${messageId})。`);
        return;
    }

    const messageToEdit = messages[msgIndex];
    const targetSwipeId = swipeId !== null ? swipeId : (messageToEdit.swipe_id || 0);

    let originalContent = messageToEdit.mes;
    if (messageToEdit.swipes && messageToEdit.swipes[targetSwipeId] !== undefined) {
        originalContent = messageToEdit.swipes[targetSwipeId];
    }
    const originalReasoning = (messageToEdit.extra && messageToEdit.extra.reasoning) ? messageToEdit.extra.reasoning : '';

    const result = await showEditorModal('编辑消息原文', originalContent, {
        reasoningContent: originalReasoning
    });
    if (result === null) return;

    // 兼容旧格式（纯文本）和新格式（{content, reasoning}）
    let newContent, newReasoning;
    if (typeof result === 'object' && result !== null) {
        newContent = result.content;
        newReasoning = result.reasoning;
    } else {
        newContent = result;
        newReasoning = originalReasoning;
    }

    if (newContent === originalContent && newReasoning === originalReasoning) return;

    // 记录本次到底改了哪些字段：保存失败时只回滚真正动过的部分
    const editingSwipeText = !!(messageToEdit.swipes && messageToEdit.swipes[targetSwipeId] !== undefined);
    const editingActiveSwipe = String(targetSwipeId) === String(messageToEdit.swipe_id || 0);

    if (newContent !== originalContent) {
        if (editingSwipeText) {
            messageToEdit.swipes[targetSwipeId] = newContent;
            // 核心修复：如果修改的正是当前激活的 swipe，我们需要同步修改 msg.mes，确保 ST 在页面上渲染正确的内容
            if (editingActiveSwipe) {
                messageToEdit.mes = newContent;
            }
        } else {
            messageToEdit.mes = newContent;
        }
    }

    if (newReasoning !== originalReasoning) {
        if (!messageToEdit.extra) messageToEdit.extra = {};
        if (newReasoning.trim() === '') {
            delete messageToEdit.extra.reasoning;
        } else {
            messageToEdit.extra.reasoning = newReasoning;
        }
    }

    try {
        // 保存前先把待落库的收藏改动写回文件：随后的 reloadCurrentChat() 会从文件重读
        // chat 与 chat_metadata，未落库的收藏改动会被直接覆盖掉（与退出预览同一类问题）。
        await flushPendingFavoriteSave();
        // 当前聊天用实时元数据：chatData.metadata 是缓存里的深拷贝快照，
        // 拿它落库会回滚其它扩展/宿主在此期间写入的字段（与收藏保存同一类问题）。
        const metadataForSave = isCurrentChat ? getContext().chatMetadata : chatData.metadata;
        await saveSpecificChatMetadata(chatFileToModify, metadataForSave, messages);
        const changedParts = [];
        if (newContent !== originalContent) changedParts.push('原文');
        if (newReasoning !== originalReasoning) changedParts.push('内心独白');
        toastr.success(`消息${changedParts.join('和')}已成功修改并保存！`);

        await refreshFavoritesViewIfNeeded();

        if (isCurrentChat) {
            await reloadCurrentChat();
        }
    } catch (error) {
        // 保存失败：完整回滚本次改动过的字段（swipe 文本 / 当前 mes / 内心独白），
        // 只回滚 mes 会让 swipe 与 reasoning 的脏改动被 ST 后续保存写进文件。
        if (editingSwipeText) {
            messageToEdit.swipes[targetSwipeId] = originalContent;
            if (editingActiveSwipe) messageToEdit.mes = originalContent;
        } else {
            messageToEdit.mes = originalContent;
        }
        if (messageToEdit.extra) {
            if (originalReasoning.trim() === '') {
                delete messageToEdit.extra.reasoning;
            } else {
                messageToEdit.extra.reasoning = originalReasoning;
            }
        }
        Logger.error('Failed to save edited message content:', error);
        toastr.error('保存修改失败，请检查控制台获取更多信息。');
    }
}

// ==================== 聊天区收藏图标 ====================

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
        if (!messageId) return;

        const msg = context.chat[parseInt(messageId, 10)];
        const swipeId = msg?.swipe_id || 0;
        const isFavorited = !!(msg && msg.swipe_info && msg.swipe_info[swipeId] && msg.swipe_info[swipeId].star_favorite);

        if ($(this).find('.favorite-toggle-icon i').length) {
            $(this).find('.favorite-toggle-icon').toggleClass('favorited', isFavorited);
        }
    });
}
