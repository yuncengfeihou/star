// domain.js - 收藏领域纯逻辑（只处理数据，不碰 DOM / 扩展设置 / 网络）
//
// 设计约束：本文件**不导入任何其他模块**，所有函数对「消息数组 / 收藏数组」做纯计算，
// 因此可被 Node 直接导入做单元测试（见 tests/domain.test.mjs），也可被数据层与 UI 层共用。
//
// 数据模型（务必与 AGENTS.md 保持一致）：
//   - 收藏真实存放位置：message.swipe_info[swipeId].star_favorite = { id, note, create_date, tags? }
//   - UI 层使用的「虚拟收藏」由 buildVirtualFavorites 从消息数组动态构建：
//       { id, messageId, sender, role, note, favoritedSwipes[], currentSwipeViewIndex }
//     其中 id 取「该消息第一个收藏的 swipe」的 id，多 swipe 场景需用 findFavSwipesById 查找。

/**
 * 将基于 message.swipe_info.star_favorite 的数据，构建为 UI 层所需的虚拟 favorites 数组。
 * 同一消息可收藏多个 swipe，此时合并为一个虚拟收藏项（favoritedSwipes 数组）。
 */
export function buildVirtualFavorites(messages) {
    const extractedFavorites = [];
    (messages || []).forEach((msg, index) => {
        // 抛弃 msg.extra，直接深入 ST 底层的 msg.swipe_info 寻找我们写入的 star_favorite 对象
        if (!msg || !msg.swipe_info) return;

        const favoritedSwipes = [];
        // 安全遍历所有的 swipe_info
        for (let sId = 0; sId < msg.swipe_info.length; sId++) {
            const info = msg.swipe_info[sId];
            const starFavorite = info && info.star_favorite;
            // 只接受「对象」形态：真值非对象（true / 字符串 / 数组）属于脏数据（手工改文件、
            // 其它工具写入），展开后会产生 id 为 undefined 的幽灵收藏，而
            // findFavSwipesById(favorites, undefined) 会把它当成合法命中，造成收藏串台。
            if (typeof starFavorite !== 'object' || starFavorite === null || Array.isArray(starFavorite)) continue;
            favoritedSwipes.push({
                swipeId: String(sId),
                ...starFavorite
            });
        }

        if (favoritedSwipes.length > 0) {
            favoritedSwipes.sort(compareByCreateDate);
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

/**
 * 按收藏时间升序；缺失/非法 create_date 一律排到最后。
 *
 * 旧写法是直接相减，而 `undefined - 100` 是 NaN —— 比较器一旦返回 NaN 就被当作「相等」，
 * 排序退化成「按 swipe 下标」，于是没有时间戳的老数据会抢占「最早收藏」的位置，
 * 进而决定虚拟收藏的 id 与卡片上显示的备注（收藏项指向了错误的 swipe）。
 */
function compareByCreateDate(a, b) {
    const timeA = Number.isFinite(a?.create_date) ? a.create_date : Infinity;
    const timeB = Number.isFinite(b?.create_date) ? b.create_date : Infinity;
    return timeA - timeB;
}

/**
 * 把 UI 用的虚拟收藏数组挂到 chat_metadata 上，并保持**不可枚举**。
 *
 * 为什么必须不可枚举：宿主 saveChat() 是 `const metadata = { ...chat_metadata }`（浅拷贝）
 * 之后整体序列化进 JSONL。只要它是可枚举属性，这个纯 UI 缓存就会被一起写进用户的聊天文件——
 * 每条收藏在文件里出现两份，其中一份还带 currentSwipeViewIndex 这种纯 UI 字段，
 * 构成第二个不可信的事实来源（实测已复现）。
 * 改成不可枚举后，`{...meta}` 与 JSON.stringify 都不会带上它，
 * 而插件内部 `chatMetadata.favorites` 的读写完全不受影响。
 * @returns {Array} 传入的 favorites，便于链式使用
 */
export function setVirtualFavorites(chatMetadata, favorites) {
    if (!chatMetadata || typeof chatMetadata !== 'object') return favorites;
    Object.defineProperty(chatMetadata, 'favorites', {
        value: favorites,
        writable: true,
        configurable: true,
        enumerable: false,
    });
    return favorites;
}

/**
 * 把「每张卡片正在看第几个 swipe」从旧收藏数组带到新收藏数组。
 *
 * buildVirtualFavorites 每次都会把 currentSwipeViewIndex 重置为 0，而收藏写操作
 * （编辑备注/标签、增删收藏、保存后重建缓存）都会重建一次虚拟收藏。不迁移的话，
 * 用户在多 swipe 卡片上切到 2/2 后改一下备注，下次渲染就跳回 1/N；
 * 标签筛选的快照（进入筛选时记录索引）也会因此还原错误。
 * 仅在索引仍落在新 favoritedSwipes 范围内时保留。
 * @param {Array} favorites - 新构建的虚拟收藏（就地修改）
 * @param {Array|null} previousFavorites - 改动前的虚拟收藏
 * @returns {Array} 传入的 favorites
 */
export function preserveSwipeViewIndexes(favorites, previousFavorites) {
    if (!Array.isArray(favorites) || !Array.isArray(previousFavorites)) return favorites;
    const previous = new Map();
    for (const fav of previousFavorites) {
        if (fav && fav.messageId !== undefined) {
            previous.set(String(fav.messageId), fav.currentSwipeViewIndex || 0);
        }
    }
    for (const fav of favorites) {
        const idx = previous.get(String(fav.messageId));
        if (Number.isInteger(idx) && idx > 0 && idx < (fav.favoritedSwipes?.length || 0)) {
            fav.currentSwipeViewIndex = idx;
        }
    }
    return favorites;
}

/**
 * 消息指纹：补丁重放时用来确认「这个索引现在指向的还是原来那条消息」。
 *
 * 补丁的地址是「消息索引 + swipe 索引」，而索引会随消息增删漂移。防抖窗口内删掉一条消息
 * 再切换聊天时，同一个索引可能已经属于**另一条消息**，重放就会把收藏写到别人身上。
 * 指纹只用于内存比对，永远不会写进 star_favorite；消息没有 send_date 时返回空串，
 * 此时退化为旧行为（宁可宽松，也不能因为取不到身份就把用户的收藏丢掉）。
 * @returns {string} 不含 ':' 的短标识（补丁键以 ':' 分段）
 */
function messageFingerprint(message) {
    const sendDate = message?.send_date;
    if (typeof sendDate !== 'string' || !sendDate) return '';
    const seed = `${sendDate}|${message?.name ?? ''}|${message.is_user ? 1 : 0}`;
    // FNV-1a 32 位 → base36
    let hash = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
        hash ^= seed.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
}

/**
 * 该 swipe 槽位是否允许写入。
 * - 槽位已存在（swipe_info 里已有该下标）→ 允许
 * - 消息本身有对应 swipe（swipes 更长）→ 允许（swipe_info 尚未补齐的情形）
 * - 消息完全没有 swipe（典型的用户消息：swipes 与 swipe_info 都是空）→ 只允许 0 号槽
 * 其余一律拒绝：越界写入会凭空造出 `swipe_info[5] = {}` 这类幽灵槽位并写进聊天文件。
 */
function isWritableSwipeSlot(message, swipeId) {
    if (!Number.isInteger(swipeId) || swipeId < 0) return false;
    const swipeInfoLength = Array.isArray(message.swipe_info) ? message.swipe_info.length : 0;
    const swipesLength = Array.isArray(message.swipes) ? message.swipes.length : 0;
    if (swipeId < swipeInfoLength) return true;
    if (swipeId < swipesLength) return true;
    return swipeId === 0 && swipeInfoLength === 0 && swipesLength === 0;
}

/**
 * 在多条收藏中查找包含指定 swipe 收藏 id 的 favoritedSwipes 列表。
 * 虚拟收藏的 fav.id 是「第一个」收藏的 swipe id，而卡片传入的 favId 是当前查看的 swipe id，
 * 多 Swipe 收藏时必须按「favoritedSwipes 中包含该 id」查找，否则非首个 swipe 会找不到收藏项、并误读第一条的数据。
 * @returns {Array|null} 命中的 favoritedSwipes 列表，未命中返回 null
 */
export function findFavSwipesById(favorites, favId) {
    return (favorites || []).find(fav => (fav.favoritedSwipes || []).some(s => s.id === favId))?.favoritedSwipes || null;
}

/**
 * 判断消息是否「完全空白」（无法收藏）：正文为空，且无思维链、无任何 swipe 文本。
 * ST 中 AI 生成中的消息 mes 可能为空，但 extra.reasoning（思维链）有内容且是界面最后一条，
 * 这类消息不能被当作空占位跳过，否则 Alt+S 会收藏到「倒数第二条」。
 */
export function isBlankMessage(m) {
    if (!m) return true;
    if (typeof m.mes === 'string' && m.mes.trim()) return false;
    if (m.extra && m.extra.reasoning && String(m.extra.reasoning).trim()) return false;
    if (Array.isArray(m.swipes) && m.swipes.some(s => typeof s === 'string' && s.trim())) return false;
    return true;
}

/**
 * 把虚拟收藏摊平成 `${messageId}:${swipeId}` → 收藏 swipe 的映射。
 * 收藏的真实存放位置是 message.swipe_info[swipeId].star_favorite，所以「消息索引 + swipe 索引」
 * 就是一条收藏的唯一地址；切换聊天后要重放收藏改动时，靠这个地址定位（见 buildFavoritePatch）。
 */
export function flattenFavoriteSwipes(favorites) {
    const map = new Map();
    for (const fav of favorites || []) {
        for (const swipe of fav.favoritedSwipes || []) {
            map.set(`${fav.messageId}:${swipe.swipeId}`, swipe);
        }
    }
    return map;
}

/**
 * 计算收藏补丁：新状态的全部收藏（幂等写入）+ 旧状态中已消失的 swipe（值为 null = 删除）。
 *
 * 为什么需要它：当前聊天的收藏保存有 800ms 防抖，而 ST 切换聊天时（openCharacterChat →
 * clearChat({clearData:true})）会直接把内存里的 chat 数组丢掉、且不保存。用户「收藏后立刻
 * 切换聊天」时，防抖到期的保存已无数组可写，收藏就会永久丢失。补丁是幂等的完整快照，
 * 足以在切换后「重新读文件 + 重放补丁」把这次改动落库。
 *
 * @param {Array} previousFavorites - 改动前的虚拟收藏
 * @param {Array} nextFavorites - 改动后的虚拟收藏
 * @param {Array} [messages] - 改动时的消息数组。传入时会为每条补丁附上消息指纹
 *   （键变成 `消息索引:swipe索引:指纹`），重放时校验索引没有漂移；不传则保持旧键格式。
 * @returns {Map<string, object|null>} 补丁
 */
export function buildFavoritePatch(previousFavorites, nextFavorites, messages = null) {
    const patch = new Map();
    const next = flattenFavoriteSwipes(nextFavorites);

    // 地址（补丁键）生成：能取到消息身份时带上指纹，取不到就退回旧格式
    const addressOf = (messageId, swipeId) => {
        const base = `${messageId}:${swipeId}`;
        if (!Array.isArray(messages)) return base;
        const fingerprint = messageFingerprint(messages[parseInt(messageId, 10)]);
        return fingerprint ? `${base}:${fingerprint}` : base;
    };

    for (const [key, swipe] of next) {
        // 只保留 star_favorite 自身的字段（swipeId 属于地址，不写回数据里）
        const starFavorite = {
            id: swipe.id,
            note: typeof swipe.note === 'string' ? swipe.note : '',
            create_date: swipe.create_date,
        };
        if (Array.isArray(swipe.tags) && swipe.tags.length > 0) starFavorite.tags = [...swipe.tags];
        const [messageId, swipeId] = String(key).split(':');
        patch.set(addressOf(messageId, swipeId), starFavorite);
    }

    // 旧状态里有、新状态里没有 → 该 swipe 的收藏已被取消
    for (const key of flattenFavoriteSwipes(previousFavorites).keys()) {
        if (next.has(key)) continue;
        const [messageId, swipeId] = String(key).split(':');
        patch.set(addressOf(messageId, swipeId), null);
    }

    return patch;
}

/**
 * 把收藏补丁重放到消息数组上（就地修改）。
 * - 值 null → 删除该 swipe 的 star_favorite；否则写入收藏对象
 * - 消息索引越界（消息已被删除）→ 跳过
 * - 补丁键带指纹且与目标消息不符（索引漂移，原消息已被删）→ 跳过，绝不写到别的消息上
 * - swipe 槽位越界（该消息没有这个 swipe）→ 跳过，不凭空造槽位
 * @param {Array} messages - 目标聊天的消息数组
 * @param {Map<string, object|null>} patch
 * @returns {number} 实际生效的条数
 */
export function applyFavoritePatch(messages, patch) {
    if (!Array.isArray(messages) || !(patch instanceof Map)) return 0;
    let applied = 0;
    for (const [key, value] of patch) {
        const [rawMessageId, rawSwipeId, fingerprint] = String(key).split(':');
        const message = messages[parseInt(rawMessageId, 10)];
        if (!message) continue;
        // 身份校验：索引漂移后同一索引已是另一条消息，此时必须整条放弃
        if (fingerprint && messageFingerprint(message) !== fingerprint) continue;

        const swipeId = parseInt(rawSwipeId, 10);
        if (!isWritableSwipeSlot(message, swipeId)) continue;

        if (!message.swipe_info) message.swipe_info = [];
        if (value === null) {
            if (message.swipe_info[swipeId]?.star_favorite) {
                delete message.swipe_info[swipeId].star_favorite;
                applied++;
            }
        } else {
            if (!message.swipe_info[swipeId]) message.swipe_info[swipeId] = {};
            message.swipe_info[swipeId].star_favorite = value;
            applied++;
        }
    }
    return applied;
}

/**
 * 判断收藏是否为旧版格式。
 * 旧版元素：{ id, messageId, sender, role, note }（无 favoritedSwipes）；
 * 新版虚拟缓存元素含 favoritedSwipes 数组。空数组/无字段均视为非旧格式。
 */
export function isLegacyFormat(favorites) {
    return Array.isArray(favorites) && favorites.length > 0
        && !!favorites[0]
        && favorites[0].messageId !== undefined
        && !Array.isArray(favorites[0].favoritedSwipes);
}

/**
 * 把旧格式收藏注入到对应消息的 swipe_info.star_favorite（幂等）。
 * - messageId 是消息在 chat 数组中的索引；索引越界（消息已删）→ 跳过
 * - 旧版无 swipe 概念 → 注入当前激活 swipe（msg.swipe_id || 0，与 addFavorite 一致）
 * - 该 swipe 已有 star_favorite → 跳过（不重复迁移）
 * - create_date 旧数据没有，按迁移时刻生成
 * @returns {{migrated:number, skipped:number}}
 */
export function migrateLegacyFavorites(messages, legacyFavorites) {
    let migrated = 0;
    let skipped = 0;
    if (!Array.isArray(messages) || !Array.isArray(legacyFavorites)) {
        return { migrated, skipped };
    }
    for (const fav of legacyFavorites) {
        if (!fav || fav.messageId === undefined) { skipped++; continue; }
        const idx = parseInt(fav.messageId, 10);
        const msg = messages[idx];
        if (!msg) { skipped++; continue; }
        const swipeId = msg.swipe_id || 0;
        if (!msg.swipe_info) msg.swipe_info = [];
        if (!msg.swipe_info[swipeId]) msg.swipe_info[swipeId] = {};
        if (msg.swipe_info[swipeId].star_favorite) { skipped++; continue; }
        msg.swipe_info[swipeId].star_favorite = {
            id: fav.id,
            note: typeof fav.note === 'string' ? fav.note : '',
            create_date: Date.now(),
        };
        migrated++;
    }
    return { migrated, skipped };
}

/**
 * 在消息数组中按收藏 id 查找 swipe 收藏对象并就地修改（增删改的唯一入口）。
 *
 * 这里集中处理「定位」这一步，是为了让所有收藏写操作走同一条路径：
 * 收藏数据藏在 message.swipe_info[swipeId].star_favorite，写操作只改它、不改 chat 长度，
 * 因此每次写操作之后都必须重建虚拟收藏缓存（见 core.js 的 rebuildVirtualFavoritesCache），
 * 否则 UI 会出现「删除后仍显示」「改备注不刷新」。
 *
 * @param {Array} messagesArray - 目标聊天的消息数组
 * @param {string} favoriteId - 收藏 id
 * @param {(fav: object) => 'update'|'delete'} mutate - 命中后的修改动作
 * @returns {boolean} 是否命中并修改成功
 */
export function mutateSwipeFavorite(messagesArray, favoriteId, mutate) {
    if (!Array.isArray(messagesArray)) return false;
    for (let i = 0; i < messagesArray.length; i++) {
        const msg = messagesArray[i];
        if (!msg || !msg.swipe_info) continue;
        for (let sId = 0; sId < msg.swipe_info.length; sId++) {
            const info = msg.swipe_info[sId];
            if (info && info.star_favorite && info.star_favorite.id === favoriteId) {
                if (mutate(info.star_favorite) === 'delete') delete info.star_favorite;
                return true;
            }
        }
    }
    return false;
}
