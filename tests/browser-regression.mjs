// tests/browser-regression.mjs - 浏览器端回归套件（跨模块 + 宿主交互）
//
// 为什么需要它：`npm test` 只能覆盖 domain.js / utils.js 这类纯函数。本插件最危险的那些缺陷
// 都发生在「插件 ↔ 宿主 ST」的接缝上（保存负载、预览态写目标、Esc 层级、监听器生命周期），
// 纯函数测不到。此文件在真实 ST 页面里运行，直接检查这些不变量。
//
// 用法（在 ST 页面里，或由自动化驱动）：
//   const { runStarRegressionSuite } = await import('/scripts/extensions/third-party/star/tests/browser-regression.mjs');
//   console.table(await runStarRegressionSuite());
//
// 安全约定：
//   - R2 会临时拦截 fetch('/api/chats/save')，用假的 200 响应捕获**保存负载**，不写盘；
//   - 所有会被改动的状态（收藏、chat_metadata 临时键、currentViewingChatFile）都在 finally 里还原；
//   - 套件本身不应在你的聊天文件里留下任何痕迹。

import { state, resolveChatAreaTargetChatFile } from '../state.js';
import { getContext } from '../../../../extensions.js';
import { stripJsonlExt } from '../utils.js';

const TMP_META_KEY = 'STAR_REGRESSION_TMP';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 运行全部回归项。
 * @returns {Promise<Array<{name: string, pass: boolean, detail: object}>>}
 */
export async function runStarRegressionSuite() {
    const results = [];
    const cases = [
        ['R1 虚拟 favorites 不进入宿主保存负载', testVirtualFavoritesNotEnumerable],
        ['R2 收藏保存必须带实时 chat_metadata', testSaveUsesLiveMetadata],
        ['R3 预览态写目标锁定被预览的聊天', testPreviewTargetLock],
        ['R4 使用说明有 id 且 Esc 只关它一层', testGuideEscLayer],
        ['R5 图片预览关闭后不残留 keydown 监听', testImagePreviewEscLeak],
    ];
    for (const [name, fn] of cases) {
        try {
            const detail = await fn();
            results.push({ name, pass: !!detail.pass, detail });
        } catch (error) {
            results.push({ name, pass: false, detail: { error: String(error && error.stack || error) } });
        }
        await wait(150);
    }
    return results;
}

// =====================================================================
// R1：宿主 saveChat 是 `{...chat_metadata}` 浅拷贝，虚拟 favorites 一旦可枚举就会被写进 JSONL
// =====================================================================
async function testVirtualFavoritesNotEnumerable() {
    const core = await import('../core.js');
    const ctx = getContext();
    core.ensureFavoritesArrayExists();

    const readable = Array.isArray(ctx.chatMetadata.favorites);
    const cloned = { ...ctx.chatMetadata };
    const inClone = Object.prototype.hasOwnProperty.call(cloned, 'favorites');
    const serialized = JSON.stringify(ctx.chatMetadata);
    const inJson = serialized.includes('"favorites"');

    return {
        pass: readable && !inClone && !inJson,
        readableByPlugin: readable,
        copiedByHostShallowClone: inClone,
        persistedByHostJson: inJson,
    };
}

// =====================================================================
// R2：当前聊天的收藏保存若用缓存里的元数据深拷贝，会把别的扩展/宿主刚写的字段回滚
// =====================================================================
async function testSaveUsesLiveMetadata() {
    const core = await import('../core.js');
    const ctx = getContext();
    const chatFile = stripJsonlExt(ctx.chatId || '');
    if (!chatFile || !Array.isArray(ctx.chat) || ctx.chat.length === 0) {
        return { pass: true, skipped: '当前没有聊天，跳过' };
    }

    // 选一条可收藏的消息，并记下它的原始收藏状态以便还原
    const msgIndex = ctx.chat.length - 1;
    const swipeId = ctx.chat[msgIndex].swipe_id || 0;
    if (!ctx.chat[msgIndex].swipe_info) ctx.chat[msgIndex].swipe_info = [];
    const originalFav = ctx.chat[msgIndex].swipe_info[swipeId]?.star_favorite ?? null;

    const hadKey = Object.prototype.hasOwnProperty.call(ctx.chatMetadata, TMP_META_KEY);
    const originalValue = ctx.chatMetadata[TMP_META_KEY];

    // 拦截保存请求，只捕获负载、不写盘
    const realFetch = window.fetch;
    const captured = [];
    window.fetch = (url, options) => {
        if (String(url).includes('/api/chats/save')) {
            captured.push(JSON.parse(options.body));
            return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return realFetch(url, options);
    };

    let payloadWithStaleMarker = null;
    let payloadWithLiveMarker = null;
    try {
        // 第 1 次保存：让 chat-data.js 把缓存元数据换成深拷贝（这正是缺陷的触发条件）
        ctx.updateChatMetadata({ [TMP_META_KEY]: 'first' }, false);
        if (!originalFav) core.addFavorite({ messageId: String(msgIndex) }, chatFile);
        else core.updateFavoriteNote(originalFav.id, originalFav.note || '', chatFile);
        await core.flushPendingFavoriteSave();
        payloadWithStaleMarker = captured.at(-1) || null;

        // 保存之后，别的扩展/宿主再改元数据
        ctx.updateChatMetadata({ [TMP_META_KEY]: 'second' }, false);

        // 第 2 次保存：必须带上 second，而不是缓存副本里的 first
        if (!originalFav) core.updateFavoriteNote(ctx.chat[msgIndex].swipe_info[swipeId].star_favorite.id, '', chatFile);
        else core.updateFavoriteNote(originalFav.id, (originalFav.note || '') + ' ', chatFile);
        await core.flushPendingFavoriteSave();
        payloadWithLiveMarker = captured.at(-1) || null;
    } finally {
        window.fetch = realFetch;
        // 还原收藏与临时元数据键。
        // 注意：updateChatMetadata() 是**整体换对象**，所以必须重新取实时对象来清理，
        // 对早先捕获的 ctx.chatMetadata 写 delete 是无效的。
        if (originalFav) ctx.chat[msgIndex].swipe_info[swipeId].star_favorite = originalFav;
        else if (ctx.chat[msgIndex].swipe_info[swipeId]) delete ctx.chat[msgIndex].swipe_info[swipeId].star_favorite;
        for (const target of [ctx.chatMetadata, getContext().chatMetadata]) {
            if (!target) continue;
            if (hadKey) target[TMP_META_KEY] = originalValue;
            else delete target[TMP_META_KEY];
        }
        await core.flushPendingFavoriteSave().catch(() => {});
    }

    // 保存负载形态：{ chat: [{ chat_metadata, user_name, character_name }, ...messages], file_name, ... }
    const markerOf = (payload) => payload?.chat?.[0]?.chat_metadata?.[TMP_META_KEY] ?? null;
    const secondSaveMarker = markerOf(payloadWithLiveMarker);
    return {
        pass: captured.length >= 2 && secondSaveMarker === 'second',
        savesCaptured: captured.length,
        firstSaveMarker: markerOf(payloadWithStaleMarker),
        secondSaveMarker,
        expectedSecondSaveMarker: 'second',
    };
}

// =====================================================================
// R3：预览模式必须记住「预览的是哪个聊天」，不能被面板切换聊天带偏
// =====================================================================
async function testPreviewTargetLock() {
    const { enterPreviewMode, exitPreviewMode } = await import('../ui/preview.js');
    const core = await import('../core.js');
    const ctx = getContext();
    const chatFile = stripJsonlExt(ctx.chatId || '');
    if (!chatFile || !Array.isArray(ctx.chat) || ctx.chat.length === 0) {
        return { pass: true, skipped: '当前没有聊天，跳过' };
    }

    core.ensureCurrentChatIsCached();
    const savedViewing = state.currentViewingChatFile;
    let lockedBefore = null;
    let lockedAfterPanelSwitch = null;
    try {
        await enterPreviewMode('0', chatFile);
        lockedBefore = resolveChatAreaTargetChatFile();

        // 模拟「预览中打开面板 → 切到别的聊天」：写目标必须仍然是被预览的聊天
        state.currentViewingChatFile = '__some_other_chat_file__';
        lockedAfterPanelSwitch = resolveChatAreaTargetChatFile();
    } finally {
        state.currentViewingChatFile = savedViewing;
        if (state.isPreviewingContext) await exitPreviewMode();
    }

    return {
        pass: lockedBefore === chatFile && lockedAfterPanelSwitch === chatFile,
        previewedChat: chatFile,
        targetAtPreviewStart: lockedBefore,
        targetAfterPanelSwitchedChat: lockedAfterPanelSwitch,
    };
}

// =====================================================================
// R4：使用说明弹窗必须有 id（Esc 层级表按 id 查），且 Esc 只关它自己
// =====================================================================
async function testGuideEscLayer() {
    const settings = await import('../ui/settings.js');
    const gateway = await import('../ui/modal-gateway.js');

    await gateway.openFavoritesModal();
    await wait(400);
    settings.showUsageGuidePopup();
    await wait(400);

    const dialogHasId = !!document.getElementById('star-guide-dialog');
    const guideWasOpen = !!document.getElementById('star-guide-overlay');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(600);

    const guideClosed = !document.getElementById('star-guide-overlay');
    const panelStillOpen = !!document.getElementById('favoritesModal')?.classList.contains('visible');

    if (!guideClosed) document.querySelector('#star-guide-overlay')?.remove();
    await gateway.closeFavoritesModal();
    await wait(300);

    return {
        pass: dialogHasId && guideWasOpen && guideClosed && panelStillOpen,
        dialogHasId,
        guideClosedByEsc: guideClosed,
        panelSurvivedEsc: panelStillOpen,
    };
}

// =====================================================================
// R5：图片预览弹窗无论用哪种方式关闭，都必须摘掉 document 上的 keydown 监听
// =====================================================================
async function testImagePreviewEscLeak() {
    const settings = await import('../ui/settings.js');
    if (typeof settings.showImagePreviewModal !== 'function') {
        return { pass: false, error: 'showImagePreviewModal 未导出，无法验证' };
    }

    let added = 0;
    let removed = 0;
    const origAdd = document.addEventListener;
    const origRemove = document.removeEventListener;
    document.addEventListener = function (type, ...rest) {
        if (type === 'keydown') added++;
        return origAdd.call(document, type, ...rest);
    };
    document.removeEventListener = function (type, ...rest) {
        if (type === 'keydown') removed++;
        return origRemove.call(document, type, ...rest);
    };

    try {
        const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        settings.showImagePreviewModal(pixel, '/img/star-regression.png');
        await wait(300);
        document.querySelector('#star-img-preview-overlay .star-img-preview-close-btn')?.click();
        await wait(500);
    } finally {
        document.addEventListener = origAdd;
        document.removeEventListener = origRemove;
        document.getElementById('star-img-preview-overlay')?.remove();
    }

    return {
        pass: added > 0 && added === removed,
        keydownListenersAdded: added,
        keydownListenersRemoved: removed,
    };
}
