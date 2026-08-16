// ui/character-switcher.js - 跨角色收藏切换器（底部弹出抽屉）
// 设计：扫描所有角色/群组，列出「有收藏的角色」，点击即切换收藏面板至该角色的数据。

import { state, PLUGIN_NAME } from '../state.js';
import { getContext, extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import Logger from '../Logger.js';
import { scanAllCharactersForFavorites, isAbortError } from '../api.js';

const SWITCHER_ID = 'star-character-switcher';

// 扫描取消控制器（打开切换器时创建，关闭/刷新时 abort）
let scanController = null;
// 后台预加载取消控制器（收藏面板打开时启动，关闭时 abort）
let preloadController = null;

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// =================================================================
//        置顶功能：角色唯一标识 + 置顶列表读写
// =================================================================

/**
 * 角色的唯一标识：普通角色用 `c:<characterId>`（characters 数组下标），群组用 `g:<groupId>`。
 * 与 scanAllCharactersForFavorites 返回的 characterId/groupId 字段保持一致。
 */
function getCharacterKey(c) {
    return c.isGroup ? `g:${c.groupId}` : `c:${c.characterId}`;
}

/**
 * 当前聊天对应的角色标识（普通角色/群组），无则返回 null。
 */
function getCurrentCharacterKey() {
    const context = getContext();
    if (!context) return null;
    if (context.groupId !== undefined && context.groupId !== null) return `g:${context.groupId}`;
    if (context.characterId !== undefined && context.characterId !== null) return `c:${context.characterId}`;
    return null;
}

/**
 * 已置顶的角色标识列表（持久化在 extension_settings，严禁使用 localStorage）。
 */
function getPinnedKeys() {
    const list = extension_settings[PLUGIN_NAME]?.pinnedCharacters;
    return Array.isArray(list) ? list : [];
}

/**
 * 切换某角色的置顶状态并持久化。
 */
function togglePinKey(key) {
    const list = getPinnedKeys();
    const idx = list.indexOf(key);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(key);
    extension_settings[PLUGIN_NAME].pinnedCharacters = list;
    saveSettingsDebounced();
}

/**
 * 后台预加载角色收藏数据（无 UI）。
 * 收藏面板打开时调用，提前扫描角色收藏，让"切换角色"秒开。
 * 使用 AbortController 管理生命周期：关闭面板时取消。
 */
export async function preloadCharacterFavorites() {
    // 已有缓存且未过期则跳过
    if (state.charactersWithFavorites.length > 0 && !state.charactersCacheStale) return;
    // 已在扫描中则跳过
    if (state.isScanningCharacters) return;

    // 取消上一次预加载
    if (preloadController) preloadController.abort();
    const controller = new AbortController();
    preloadController = controller;
    state.isScanningCharacters = true;

    try {
        const result = await scanAllCharactersForFavorites(() => {}, { signal: controller.signal });
        if (controller.signal.aborted) return;
        state.charactersWithFavorites = result;
        state.charactersCacheStale = false;
        Logger.debug(`后台预加载完成：${result.length} 个角色有收藏`);
    } catch (error) {
        if (!isAbortError(error, controller.signal)) {
            Logger.warn('后台预加载角色收藏失败:', error);
        }
    } finally {
        if (preloadController === controller) {
            preloadController = null;
            state.isScanningCharacters = false;
        }
    }
}

/**
 * 取消后台预加载（关闭收藏面板时调用）。
 */
export function abortPreload() {
    if (preloadController) {
        preloadController.abort();
        preloadController = null;
    }
    // 仅当没有活跃的前台扫描时才清除状态（避免与 startScan 冲突）
    if (!scanController) {
        state.isScanningCharacters = false;
    }
}

/**
 * 打开角色切换器（从底部向上滑出的抽屉）。
 * 首次打开或缓存过期时自动后台扫描所有角色。
 */
export function openCharacterSwitcher() {
    // 防止重复创建
    if (document.getElementById(SWITCHER_ID)) return;

    // 取消后台预加载：避免扫描在抽屉滑出动画期间完成，占用主线程导致动画卡顿（两段式滑动）
    abortPreload();

    const frame = document.createElement('div');
    frame.id = SWITCHER_ID;
    frame.className = 'star-character-switcher';
    frame.innerHTML = `
        <div class="star-cs-backdrop"></div>
        <div class="star-cs-sheet">
            <div class="star-cs-handle"></div>
            <div class="star-cs-header">
                <div class="star-cs-title">
                    <i class="fa-solid fa-users"></i>
                    <span>切换角色</span>
                </div>
                <div class="star-cs-actions">
                    <button class="star-cs-refresh" title="重新扫描所有角色"><i class="fa-solid fa-rotate"></i></button>
                    <button class="star-cs-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
            </div>
            <div class="star-cs-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="text" class="star-cs-search-input" placeholder="搜索角色名…" spellcheck="false">
            </div>
            <div class="star-cs-status"></div>
            <div class="star-cs-list"></div>
        </div>
    `;
    document.body.appendChild(frame);

    // 应用主题（跟随收藏面板）
    applyThemeToSwitcher(frame);

    // --- 事件绑定 ---
    frame.querySelector('.star-cs-backdrop').addEventListener('click', closeCharacterSwitcher);
    frame.querySelector('.star-cs-close').addEventListener('click', closeCharacterSwitcher);
    frame.querySelector('.star-cs-refresh').addEventListener('click', () => {
        state.charactersCacheStale = true;
        renderList(frame, '');
        startScan(frame);
    });

    const searchInput = frame.querySelector('.star-cs-search-input');
    searchInput.addEventListener('input', (e) => {
        renderList(frame, e.target.value.toLowerCase().trim());
    });

    // 列表项点击（事件委托）→ 切换到该角色；置顶按钮点击 → 切换置顶状态
    frame.querySelector('.star-cs-list').addEventListener('click', async (e) => {
        // 置顶按钮优先处理，不触发角色切换
        const pinBtn = e.target.closest('.star-cs-pin-btn');
        if (pinBtn) {
            e.stopPropagation();
            const item = pinBtn.closest('.star-cs-item');
            const idx = parseInt(item?.dataset.idx, 10);
            const charEntry = state.charactersWithFavorites[idx];
            if (!charEntry) return;
            togglePinKey(getCharacterKey(charEntry));
            // 重新渲染以应用新的排序
            renderList(frame, frame.querySelector('.star-cs-search-input').value.toLowerCase().trim());
            return;
        }

        const item = e.target.closest('.star-cs-item');
        if (!item || item.classList.contains('disabled')) return;
        const idx = parseInt(item.dataset.idx, 10);
        if (isNaN(idx)) return;
        const charEntry = state.charactersWithFavorites[idx];
        if (!charEntry) return;

        // 点击后立即给视觉反馈
        item.classList.add('selected');
        closeCharacterSwitcher();

        // 动态导入 main.js 避免循环依赖
        try {
            const { switchToCharacter } = await import('./main.js');
            await switchToCharacter(charEntry);
        } catch (err) {
            Logger.error('切换角色失败:', err);
            toastr.error('切换角色时发生错误');
        }
    });

    // ESC 关闭（capture 阶段，优先于收藏面板的 ESC 处理）
    const handleEsc = (e) => {
        if (e.key === 'Escape') {
            e.stopImmediatePropagation();
            closeCharacterSwitcher();
        }
    };
    document.addEventListener('keydown', handleEsc, true);
    frame._starEscHandler = handleEsc;

    // 同步宽度 + 强制 reflow + 触发动画，同一帧内完成
    const sheet = frame.querySelector('.star-cs-sheet');
    requestAnimationFrame(() => {
        // 桌面端/平板端：宽度与收藏主弹窗保持一致
        if (window.innerWidth > 600) {
            const dialog = state.modalDialogElement;
            if (dialog) {
                const w = dialog.getBoundingClientRect().width;
                sheet.style.maxWidth = w + 'px';
                sheet.style.width = w + 'px';
                sheet.style.margin = '0 auto';
            }
        }
        sheet.offsetHeight; // 强制 reflow，避免动画起始帧卡顿
        frame.classList.add('visible');
    });

    // 缓存有数据：动画前渲染好列表，动画丝滑
    if (state.charactersWithFavorites.length > 0 && !state.charactersCacheStale) {
        renderList(frame, '');
        const totalFavs = state.charactersWithFavorites.reduce((s, c) => s + c.totalFavorites, 0);
        updateStatus(frame, `共 <b>${state.charactersWithFavorites.length}</b> 个角色，<b>${totalFavs}</b> 条收藏`);
    } else {
        // 缓存为空/过期：等动画结束后再扫描，避免动画期间 DOM 变更导致卡顿
        const onTransitionEnd = () => {
            sheet.removeEventListener('transitionend', onTransitionEnd);
            startScan(frame);
        };
        sheet.addEventListener('transitionend', onTransitionEnd);
        frame._onTransitionEnd = onTransitionEnd;
    }

    // 搜索框默认不聚焦（避免移动端自动弹出虚拟键盘）
    // 用户可手动点击搜索框聚焦
}

function applyThemeToSwitcher(frame) {
    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        frame.dataset.starTheme = 'dark';
    } else {
        frame.removeAttribute('data-star-theme');
    }
}

/**
 * 开始扫描所有角色的收藏。
 * 使用 AbortController 管理生命周期：关闭/刷新时可中断进行中的扫描。
 */
async function startScan(frame) {
    // 先取消上一次可能还在进行中的扫描，也取消后台预加载（避免双重扫描）
    if (scanController) scanController.abort();
    if (preloadController) { preloadController.abort(); preloadController = null; }
    const controller = new AbortController();
    scanController = controller;
    state.isScanningCharacters = true;

    const listEl = frame.querySelector('.star-cs-list');
    listEl.innerHTML = '';
    updateStatus(frame, '正在准备扫描…');

    try {
        const result = await scanAllCharactersForFavorites((current, total, name) => {
            updateStatus(frame, `扫描中 <b>${current}/${total}</b>${name ? ' · ' + escapeHtml(name) : ''}`);
            // 边扫边显示已发现的角色（提升感知速度）
            if (!controller.signal.aborted) renderList(frame, frame.querySelector('.star-cs-search-input').value.toLowerCase().trim());
        }, { signal: controller.signal });

        if (controller.signal.aborted) return;

        state.charactersWithFavorites = result;
        state.charactersCacheStale = false;
        state.isScanningCharacters = false;

        renderList(frame, '');
        const totalFavs = result.reduce((s, c) => s + c.totalFavorites, 0);
        updateStatus(frame, result.length > 0
            ? `扫描完成：<b>${result.length}</b> 个角色，共 <b>${totalFavs}</b> 条收藏`
            : '没有找到任何收藏');
    } catch (error) {
        if (!isAbortError(error, controller.signal)) {
            Logger.error('扫描角色收藏失败:', error);
            updateStatus(frame, '扫描失败：' + escapeHtml(error.message || '未知错误'));
        }
    } finally {
        if (scanController === controller) {
            scanController = null;
            state.isScanningCharacters = false;
        }
    }
}

function updateStatus(frame, html) {
    const el = frame.querySelector('.star-cs-status');
    if (el) el.innerHTML = html;
}

/**
 * 渲染角色列表（支持按名称过滤）。
 */
function renderList(frame, query) {
    const listEl = frame.querySelector('.star-cs-list');
    const items = state.charactersWithFavorites;

    // 扫描中且暂无数据 → 显示加载占位
    if (state.isScanningCharacters && items.length === 0) {
        listEl.innerHTML = '<div class="star-cs-empty"><i class="fa-solid fa-spinner fa-spin"></i><span>正在扫描所有角色…</span></div>';
        return;
    }

    if (items.length === 0) {
        listEl.innerHTML = '<div class="star-cs-empty"><i class="fa-regular fa-folder-open"></i><span>尚无收藏数据<br>点击右上角 <i class="fa-solid fa-rotate"></i> 重新扫描</span></div>';
        return;
    }

    // 过滤（大小写不敏感，包含匹配角色名）
    const filtered = query
        ? items.map((c, idx) => ({ c, idx })).filter(({ c }) => c.name.toLowerCase().includes(query))
        : items.map((c, idx) => ({ c, idx }));

    if (filtered.length === 0) {
        listEl.innerHTML = '<div class="star-cs-empty"><i class="fa-regular fa-face-frown"></i><span>没有匹配的角色</span></div>';
        return;
    }

    // 按置顶/当前聊天角色优先排序：当前聊天角色恒置顶（不显示置顶按钮），
    // 其次为手动置顶的角色，其余按收藏数降序。
    const currentKey = getCurrentCharacterKey();
    const pinnedKeys = getPinnedKeys();
    filtered.sort((a, b) => {
        const ka = getCharacterKey(a.c);
        const kb = getCharacterKey(b.c);
        const aIsCurrent = ka === currentKey;
        const bIsCurrent = kb === currentKey;
        if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
        const aPinned = pinnedKeys.includes(ka);
        const bPinned = pinnedKeys.includes(kb);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        return b.c.totalFavorites - a.c.totalFavorites;
    });

    listEl.innerHTML = filtered.map(({ c, idx }) => {
        const avatarSrc = c.avatar && c.avatar !== 'multichar_dummy.png'
            ? (c.isGroup ? `groups/${c.avatar}` : `characters/${c.avatar}`)
            : 'img/ai4.png';
        const groupBadge = c.isGroup ? '<span class="star-cs-group-tag">群</span>' : '';
        const key = getCharacterKey(c);
        const isCurrent = key === currentKey;
        const isPinned = !isCurrent && pinnedKeys.includes(key);
        // 当前聊天角色：不显示置顶按钮，改为“当前聊天角色”注释；其余显示置顶按钮
        const rightAction = isCurrent
            ? `<span class="star-cs-current-tag"><i class="fa-solid fa-location-dot"></i>当前聊天角色</span>`
            : `<button class="star-cs-pin-btn${isPinned ? ' pinned' : ''}" title="${isPinned ? '取消置顶' : '置顶'}"><i class="fa-solid fa-thumbtack"></i></button>`;
        return `
            <div class="star-cs-item${isCurrent ? ' star-cs-current-item' : ''}" data-idx="${idx}">
                <div class="star-cs-avatar-wrap">
                    <img class="star-cs-avatar" src="${escapeHtml(avatarSrc)}" onerror="this.src='img/ai4.png'">
                </div>
                <div class="star-cs-info">
                    <div class="star-cs-name">${groupBadge}${escapeHtml(c.name)}</div>
                    <div class="star-cs-meta">${c.chatsWithFavorites.length} 个聊天</div>
                </div>
                <div class="star-cs-badge" title="收藏总数">${c.totalFavorites}</div>
                ${rightAction}
            </div>
        `;
    }).join('');
}

/**
 * 标记角色收藏缓存为过期（增删收藏后调用）。
 */
export function invalidateCharactersCache() {
    state.charactersCacheStale = true;
}

/**
 * 关闭角色切换器并清理。
 */
export function closeCharacterSwitcher() {
    const frame = document.getElementById(SWITCHER_ID);
    if (!frame) return;
    // 取消进行中的扫描
    if (scanController) { scanController.abort(); scanController = null; }
    // 移除 ESC 监听
    if (frame._starEscHandler) {
        document.removeEventListener('keydown', frame._starEscHandler, true);
    }
    // 移除 transitionend 监听（如果动画还在进行中就关闭了）
    if (frame._onTransitionEnd) {
        frame.querySelector('.star-cs-sheet')?.removeEventListener('transitionend', frame._onTransitionEnd);
    }
    frame.classList.remove('visible');
    setTimeout(() => frame.remove(), 300);
}