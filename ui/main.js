// ui/main.js - 核心面板渲染与主逻辑

import { getContext, extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, chat, messageFormatting } from '../../../../../script.js';
import { timestampToMoment } from '../../../../utils.js';
import { state, PLUGIN_NAME } from '../state.js';
import { getAllChatFavoritesForCurrentContext, getFullChatData, isAbortError } from '../api.js';
import { ensureFavoritesArrayExists, ensureCurrentChatIsCached } from '../core.js';
import { applySavedTheme, showAvatarLongPressMenu, closeAvatarLongPressMenu, toggleTheme } from './settings.js';
import { openCharacterSwitcher, closeCharacterSwitcher, preloadCharacterFavorites, abortPreload } from './character-switcher.js';
import { handleViewContext, closeContextFrame } from './preview.js';
import { toggleDebugPanel } from './debug.js';
import Logger from '../Logger.js';
import { shouldShowUpdateNotice, showUpdateNoticeDialog } from '../api.js';

// =================================================================
//                         CONSTANTS
// =================================================================

const MODAL_ID = 'favoritesModal';
const MODAL_CLASS_NAME = 'favorites-modal-dialog';
const MODAL_HEADER_CLASS = 'favorites-modal-header';
const MODAL_TITLE_CLASS = 'favorites-modal-title';
const MODAL_CLOSE_X_CLASS = 'favorites-modal-close-x';
const MODAL_BODY_CLASS = 'favorites-modal-body';
const SIDEBAR_TOGGLE_CLASS = 'favorites-sidebar-toggle';
const SIDEBAR_TOGGLE_ID = 'favorites-avatar-toggle';
const SEARCH_CONTAINER_CLASS = 'favorites-search-container';
const SEARCH_ICON_CLASS = 'favorites-search-icon';
const SEARCH_INPUT_CLASS = 'favorites-search-input';
const SEARCH_FILTER_CLASS = 'favorites-search-filter';
const PREVIEW_EXIT_BUTTON_ID = 'favorites-preview-exit-button';

const favDoc = document;

/**
 * HTML 转义：用户可控文本（备注、发送者名等）插入 HTML 前必须转义，防止自 XSS。
 */
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// 后台批量加载收藏数据的取消控制器（切换聊天/重开面板时用来中断进行中的请求）
let backgroundLoadController = null;

// =================================================================
//                      UI MODAL FUNCTIONS
// =================================================================

/**
 * Ensures the modal structure exists in the DOM.
 */
export function ensureModalStructure() {
    if (state.modalElement) return;

    state.modalElement = favDoc.createElement('div');
    state.modalElement.id = MODAL_ID;
    state.modalElement.innerHTML = `
        <div class="${MODAL_CLASS_NAME}">
            <div class="${MODAL_HEADER_CLASS}">
                <img id="${SIDEBAR_TOGGLE_ID}" class="${SIDEBAR_TOGGLE_CLASS}" src="img/ai4.png" title="单击切换侧栏 / 长按打开选项">
                <h3 class="${MODAL_TITLE_CLASS}">收藏管理</h3>
                <div class="${SEARCH_CONTAINER_CLASS}">
                    <i class="fa-solid fa-filter ${SEARCH_FILTER_CLASS}" title="仅搜索备注"></i>
                    <input type="text" class="${SEARCH_INPUT_CLASS}" placeholder="检索收藏...">
                    <i class="fa-solid fa-magnifying-glass ${SEARCH_ICON_CLASS}"></i>
                </div>
                <div class="favorites-tag-btn" title="按标签筛选"><i class="fa-solid fa-tags"></i></div>
                <div class="${MODAL_CLOSE_X_CLASS}"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div id="favorites_update_notice"></div>
            <div class="${MODAL_BODY_CLASS}"></div>
        </div>
    `;
    favDoc.body.appendChild(state.modalElement);

    state.modalDialogElement = state.modalElement.querySelector(`.${MODAL_CLASS_NAME}`);
    state.modalTitleElement = state.modalElement.querySelector(`.${MODAL_TITLE_CLASS}`);
    state.modalBodyElement = state.modalElement.querySelector(`.${MODAL_BODY_CLASS}`);

    // --- Event Listeners ---
    state.modalElement.querySelector(`.${MODAL_CLOSE_X_CLASS}`).addEventListener('click', closeFavoritesModal);

    // 右上角标签筛选按钮（点击展开标签下拉菜单）
    const tagBtn = state.modalElement.querySelector('.favorites-tag-btn');
    if (tagBtn) {
        tagBtn.addEventListener('click', toggleTagFilterMenu);
    }

	// --- MODIFIED: Sidebar Toggle & Long-press Options Menu (with Touch Support) ---
	const avatarToggle = state.modalElement.querySelector(`.${SIDEBAR_TOGGLE_CLASS}`);
	let longPressTimer;
	let isLongPressAction = false;

	// 启动长按计时器 (不阻止默认事件)
	const startPress = (e) => {
		isLongPressAction = false;
		longPressTimer = setTimeout(() => {
			isLongPressAction = true; // 标记为长按已触发
			showAvatarLongPressMenu();
		}, 600); // 600ms for long press
	};

	// 清除长按计时器
	const endPress = () => {
		clearTimeout(longPressTimer);
	};

	// 1. 绑定启动事件 (鼠标按下 或 手指触摸)
	avatarToggle.addEventListener('mousedown', startPress);
	avatarToggle.addEventListener('touchstart', startPress);

	// 2. 绑定结束/取消事件 (鼠标抬起、移开 或 手指离开、取消)
	avatarToggle.addEventListener('mouseup', endPress);
	avatarToggle.addEventListener('mouseleave', endPress);
	avatarToggle.addEventListener('touchend', endPress);
	avatarToggle.addEventListener('touchcancel', endPress);

	// 3. 绑定单击事件，并在这里做最终判断
	avatarToggle.addEventListener('click', (e) => {
		// 如果是长按动作触发的，则阻止单击行为
		if (isLongPressAction) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		// 否则，执行单击行为：切换侧边栏
		state.modalDialogElement.classList.toggle('sidebar-closed');
	});
	// 2. 为"长按"或"右键单击"设置监听器 (用于弹出选项菜单)
	avatarToggle.addEventListener('contextmenu', (e) => {
		// 阻止浏览器的默认上下文菜单 (如 "保存图片...")
		e.preventDefault();

		// 显示我们自定义的选项菜单
		showAvatarLongPressMenu();
	});

    const searchContainer = state.modalElement.querySelector(`.${SEARCH_CONTAINER_CLASS}`);
    const searchIcon = state.modalElement.querySelector(`.${SEARCH_ICON_CLASS}`);
    const searchFilter = state.modalElement.querySelector(`.${SEARCH_FILTER_CLASS}`);
    const searchInput = state.modalElement.querySelector(`.${SEARCH_INPUT_CLASS}`);

    searchIcon.addEventListener('click', () => {
        searchContainer.classList.add('expanded');
        searchInput.focus();
    });

    searchInput.addEventListener('blur', () => {
        if (!searchInput.value) {
            searchContainer.classList.remove('expanded');
        }
    });

    // 搜索输入防抖计时器（跨页全量匹配渲染成本较高，避免每次按键都重建列表）
    let searchDebounceTimer = null;

    // 阻止点击过滤按钮时搜索框失去焦点（避免因blur事件导致搜索框收起）
    searchFilter.addEventListener('mousedown', (e) => {
        e.preventDefault();
    });

    searchFilter.addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('active');
        clearTimeout(searchDebounceTimer);
        const query = searchInput.value.toLowerCase();
        handleSearchInModal(query);
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => handleSearchInModal(query), 150);
    });

    state.modalElement.addEventListener('click', (e) => {
        if (e.target === state.modalElement) {
            closeFavoritesModal();
        }
    });

    state.modalBodyElement.addEventListener('click', handleModalClick);
}

/**
 * 在 HTML 文本中高亮搜索关键词（保护标签结构，只高亮文本节点）。
 * 搜索结果渲染时调用：正文是 messageFormatting 后的 HTML，备注是纯文本，二者都能安全处理。
 */
function highlightInHtml(html, query) {
    if (!query) return html;
    const escapedQuery = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escapedQuery) return html;

    // 先把 HTML 标签整体占位，避免高亮正则误伤标签名/属性中的文本
    const tagStack = [];
    const protectedHtml = html.replace(/<[^>]*>/g, (m) => {
        tagStack.push(m);
        return `\u0000T${tagStack.length - 1}\u0000`;
    });
    const highlighted = protectedHtml.replace(new RegExp(`(${escapedQuery})`, 'gi'), '<mark class="star-search-mark">$1</mark>');
    return highlighted.replace(/\u0000T(\d+)\u0000/g, (_, i) => tagStack[parseInt(i, 10)]);
}

// =================================================================
//                      标签筛选（右上角图标 + 卡片徽章）
// =================================================================

/**
 * 收集当前聊天全部收藏用到的标签及其计数（供下拉菜单展示，按使用次数降序）。
 */
function collectTags(chatData) {
    const map = new Map();
    (chatData?.favorites || []).forEach(fav => {
        (fav.favoritedSwipes || []).forEach(s => {
            (Array.isArray(s.tags) ? s.tags : []).forEach(t => {
                const k = String(t).trim();
                if (k) map.set(k, (map.get(k) || 0) + 1);
            });
        });
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * 获取经过标签筛选后的收藏列表（无激活标签时返回全部）。
 * 供正常渲染（renderMainPanel）与搜索（handleSearchInModal）共用，保证两处筛选一致。
 */
function getFilteredFavorites(chatData) {
    let list = chatData?.favorites || [];
    if (state.activeTagFilter) {
        list = list.filter(fav => (fav.favoritedSwipes || []).some(s => Array.isArray(s.tags) && s.tags.includes(state.activeTagFilter)));
    }
    return list;
}

/**
 * 同步右上角标签图标的激活态（有激活标签时高亮）。
 */
function updateTagBtnState() {
    const tagBtn = state.modalElement?.querySelector('.favorites-tag-btn');
    if (tagBtn) tagBtn.classList.toggle('active', !!state.activeTagFilter);
}

// 标签下拉菜单的点击外部关闭处理器（模块级，供 closeTagFilterMenu 移除）
let _tagMenuOutsideHandler = null;

/**
 * 关闭标签筛选下拉菜单并清理事件监听。
 */
function closeTagFilterMenu() {
    const menu = document.getElementById('star-tag-filter-menu');
    if (menu) menu.remove();
    if (_tagMenuOutsideHandler) {
        document.removeEventListener('mousedown', _tagMenuOutsideHandler);
        _tagMenuOutsideHandler = null;
    }
}

/**
 * 切换标签筛选下拉菜单（展开/收起）。
 * 菜单列出「全部收藏」+ 当前聊天所有标签（含计数）；选择后按标签过滤并重新渲染。
 */
function toggleTagFilterMenu() {
    // 已展开则收起
    if (document.getElementById('star-tag-filter-menu')) {
        closeTagFilterMenu();
        return;
    }

    const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === String(state.currentViewingChatFile || '').replace('.jsonl', ''));
    const tagBtn = state.modalElement?.querySelector('.favorites-tag-btn');
    if (!tagBtn) return;
    const tags = collectTags(chatData);

    const menu = document.createElement('div');
    menu.id = 'star-tag-filter-menu';
    menu.className = 'star-tag-filter-menu';
    if (state.modalDialogElement?.dataset.starTheme === 'dark') menu.dataset.starTheme = 'dark';

    const tagItemsHtml = tags.length === 0
        ? '<div class="star-tag-filter-empty">还没有标签<br>在收藏卡片上点 <i class="fa-solid fa-tags"></i> 添加</div>'
        : tags.map(([tag, count]) => `
            <div class="star-tag-filter-item${state.activeTagFilter === tag ? ' active' : ''}" data-tag="${escapeHtml(tag)}">
                <span class="star-tag-filter-name">${escapeHtml(tag)}</span>
                <span class="star-tag-filter-count">${count}</span>
            </div>`).join('');

    menu.innerHTML = `
        <div class="star-tag-filter-head">按标签筛选</div>
        <div class="star-tag-filter-list">
            <div class="star-tag-filter-item${state.activeTagFilter ? '' : ' active'}" data-tag="__all__">
                <span class="star-tag-filter-name">全部收藏</span>
                <span class="star-tag-filter-count">${chatData?.favorites?.length || 0}</span>
            </div>
            ${tagItemsHtml}
        </div>
    `;
    document.body.appendChild(menu);

    // 定位：锚定右上角标签按钮下方，右缘对齐
    const rect = tagBtn.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;

    menu.querySelector('.star-tag-filter-list').addEventListener('click', async (e) => {
        const item = e.target.closest('.star-tag-filter-item');
        if (!item) return;
        state.activeTagFilter = item.dataset.tag === '__all__' ? null : item.dataset.tag;
        closeTagFilterMenu();
        updateTagBtnState();
        state.currentPage = 1;
        await renderFavoritesView(state.currentViewingChatFile);
    });

    // 点击菜单外部（非菜单、非按钮）时关闭
    _tagMenuOutsideHandler = (e) => {
        if (!e.target.closest('#star-tag-filter-menu') && !e.target.closest('.favorites-tag-btn')) {
            closeTagFilterMenu();
        }
    };
    setTimeout(() => document.addEventListener('mousedown', _tagMenuOutsideHandler), 0);
}

/**
 * Handles search functionality in the modal.
 * 搜索基于缓存的全量收藏数据跨页匹配，而非仅过滤当前页 DOM；
 * 输入关键词时显示全部匹配结果（隐藏分页），清空后恢复当前页分页渲染。
 * 标签筛选与搜索叠加：先按激活标签过滤，再按关键词匹配。
 */
export async function handleSearchInModal(query) {
    const searchFilter = state.modalElement.querySelector(`.${SEARCH_FILTER_CLASS}`);
    const filterByNote = searchFilter.classList.contains('active');

    // 搜索词为空：退出搜索模式，恢复当前页正常渲染（含分页）
    if (!query) {
        await renderFavoritesView(state.currentViewingChatFile);
        return;
    }

    // 从缓存的全量收藏数据中跨页匹配（先应用标签筛选，再按关键词过滤）
    const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === String(state.currentViewingChatFile || '').replace('.jsonl', ''));
    const allFavorites = getFilteredFavorites(chatData);
    const messages = chatData?.messages || [];

    const results = allFavorites.filter(fav => {
        const noteText = (fav.favoritedSwipes || []).map(s => s.note || '').join(' ').toLowerCase();
        if (filterByNote) {
            return noteText.includes(query);
        }
        // 匹配备注 + 当前收藏 swipe 的正文
        const msg = messages[parseInt(fav.messageId, 10)];
        const activeSwipe = fav.favoritedSwipes?.[0];
        let msgText = '';
        if (msg) {
            msgText = (activeSwipe && msg.swipes && msg.swipes[activeSwipe.swipeId] !== undefined) ? msg.swipes[activeSwipe.swipeId] : (msg.mes || '');
        }
        return noteText.includes(query) || msgText.toLowerCase().includes(query);
    });

    // 传原始大小写的关键词用于高亮显示
    const rawQuery = state.modalElement.querySelector(`.${SEARCH_INPUT_CLASS}`)?.value || query;
    await renderSearchResults(results, chatData, rawQuery);
}

/**
 * 渲染跨页搜索结果列表（隐藏分页，顶部显示匹配数量）。
 * @param {string} [highlightQuery] - 高亮关键词（保留原始大小写）
 */
async function renderSearchResults(results, chatData, highlightQuery = '') {
    let mainPanel = state.modalBodyElement.querySelector('.favorites-main-panel');
    if (!mainPanel) {
        mainPanel = document.createElement('div');
        mainPanel.className = 'favorites-main-panel';
        state.modalBodyElement.appendChild(mainPanel);
    }

    let listHtml = '';
    if (results.length === 0) {
        listHtml = `<div class="favorites-empty">没有匹配的收藏。</div>`;
    } else {
        const messages = chatData?.messages || [];
        for (let i = 0; i < results.length; i++) {
            const fav = results[i];
            const msg = messages[parseInt(fav.messageId, 10)] || null;
            listHtml += await renderFavoriteItem(fav, i, msg, highlightQuery);
        }
    }

    mainPanel.innerHTML = `
        <div class="favorites-search-info">共找到 ${results.length} 条匹配收藏</div>
        <div class="favorites-list">${listHtml}</div>
        <div class="favorites-pagination"></div>
    `;

    const favoritePreviews = mainPanel.querySelectorAll('.fav-preview');
    favoritePreviews.forEach(previewElement => {
        renderIframesInElement($(previewElement));
    });
}

/**
 * Centers the modal in the viewport.
 */
export function centerModal() {
    if (!state.modalDialogElement) return;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const dialogWidth = state.modalDialogElement.offsetWidth;
    const dialogHeight = state.modalDialogElement.offsetHeight;
    state.modalDialogElement.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
    state.modalDialogElement.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
}

/**
 * Opens the favorites modal.
 */
export async function openFavoritesModal() {
    Logger.info('打开收藏面板');
    ensureModalStructure();

    // 新版本首次打开：先弹出独立更新日志弹窗
    if (shouldShowUpdateNotice()) {
        await new Promise(resolve => showUpdateNoticeDialog(resolve));
    }

    const previewContainer = document.getElementById('favorites-preview-container');
    if (previewContainer) previewContainer.style.display = 'none';
    applySavedTheme();

    const context = getContext();
    if (!state.isPreviewingContext) {
        let avatarSrc = 'img/ai4.png';
        if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
            const characterAvatar = context.characters[context.characterId].avatar;
            if (characterAvatar && characterAvatar !== 'multichar_dummy.png') {
                avatarSrc = `characters/${characterAvatar}`;
            }
        } else if (context.groupId) {
             const group = context.groups.find(g => g.id === context.groupId);
             if (group && group.avatar && group.avatar !== 'multichar_dummy.png') {
                 avatarSrc = `groups/${group.avatar}`;
             }
        }
        const avatarToggle = state.modalElement.querySelector(`#${SIDEBAR_TOGGLE_ID}`);
        if (avatarToggle) avatarToggle.src = avatarSrc;
    }

    if (state.isPreviewingContext) {
        // If in preview, we assume data is already loaded and just show the modal
        await renderFavoritesView(state.currentViewingChatFile);
    } else {
        // --- PERFORMANCE OPTIMIZATION ---
        // 1. Reset state and show a spinner
        // 先取消上一次后台加载，防止其 resolve 后把旧角色的收藏写入已重置的数组
        abortBackgroundLoad();
        state.currentPage = 1;
        state.currentViewingChatFile = null;
        state.allChatsFavoritesData = [];
        state.isLoadingOtherChats = false;
        state.activeTagFilter = null;
        state.modalBodyElement.innerHTML = '<div class="spinner"></div>';

        // Reset UI elements
        state.modalDialogElement.classList.add('sidebar-closed');
        const searchContainer = state.modalElement.querySelector(`.${SEARCH_CONTAINER_CLASS}`);
        const searchInput = state.modalElement.querySelector(`.${SEARCH_INPUT_CLASS}`);
        if(searchContainer) searchContainer.classList.remove('expanded');
        if(searchInput) searchInput.value = '';

        // 2. Immediately render the current chat's favorites using getContext()
        await renderFavoritesView();

        // 3. Silently load other chats in the background
        loadOtherChatsInBackground();
    }

    // 数据就绪后居中并显示（使用 visibility 代替 display:none，无需回流/rAF 黑科技即可平滑渐显）
    centerModal();
    state.modalElement.classList.add('visible');
    state.modalDialogElement.classList.add('visible');

    window.addEventListener('resize', centerModal);
    // capture 阶段监听：子弹窗（如 AI 答疑，其 Esc 监听在插件初始化时注册，早于本监听）
    // 会先于本处理器把自己关闭；若在冒泡阶段判断，会因弹窗已不可见而误关主面板。
    favDoc.addEventListener('keydown', handleEscKey, true);

    // 后台静默预加载角色收藏数据，让「切换角色」秒开
    preloadCharacterFavorites().catch(() => {});
}

/**
 * Closes the modal instantly without any fade-out animation.
 */
export function closeFavoritesModal() {
    Logger.info('关闭收藏面板');

    // 若调试日志面板已启用，随主弹窗一并关闭整个日志面板（隐藏图标、关闭弹窗、恢复日志级别）
    if (state.debugPanel?.enabled) {
        toggleDebugPanel();
    }

    // 若 AI 答疑处于最小化状态（存在浮动恢复按钮），随主弹窗一并彻底关闭（中止流式、移除恢复按钮）
    if (document.getElementById('star-qa-restore-btn')) {
        import('./qa.js').then(m => m.closeQAPanel());
    }

    if (state.modalElement) {
        state.modalElement.classList.remove('visible');
        if (state.modalDialogElement) {
            state.modalDialogElement.classList.remove('visible');
        }
    }

    // Show the preview toggle button container if we were in preview mode
    if (state.isPreviewingContext) {
        const container = document.getElementById('favorites-preview-container');
        if (container) {
            container.style.display = 'flex';
            container.style.opacity = '1';
            container.style.pointerEvents = 'auto';
        }
    }

    // 取消后台角色收藏预加载
    abortPreload();

    // 关闭可能残留的标签筛选下拉菜单
    closeTagFilterMenu();

    // Clean up event listeners
    window.removeEventListener('resize', centerModal);
    favDoc.removeEventListener('keydown', handleEscKey, true);
}

/**
 * Handles the Escape key for closing various modals.
 */
export async function handleEscKey(event) {
    if (event.key !== 'Escape') {
        return; // 如果不是Escape键，直接退出
    }

    // --- 优先级 0: 自带 Esc 处理器的子级弹窗 ---
    // 这些弹窗打开时，Esc 由它们自身的处理器关闭（主面板不介入），
    // 避免“主弹窗 + 子弹窗”同时打开时一次 Esc 关掉两层。
    // 注意：QA 答疑 / 调试面板 / 编辑器初始化时即创建、DOM 常驻（display/visible 控制显隐），
    // 必须额外判断可见性，否则“存在即打开”会让主面板的 Esc 永远失效。
    const TEMP_MODALS = [
        'star-confirm-modal',        // 确认弹窗（临时创建）
        'star-input-modal',          // 输入弹窗（临时创建）
        'star-text-modal',           // 文本弹窗（临时创建）
        'star-tags-modal',           // 标签编辑弹窗（临时创建）
        'star-screenshot-popup',     // 截图选择弹窗（临时创建）
        'star-guide-dialog',         // 使用指南（临时创建）
        'star-character-switcher',   // 角色切换器（临时创建，自身 capture 监听处理）
    ];
    const persistentCheck = [
        ['star-qa-modal', el => el.style.display !== 'none'],
        ['star-debug-modal', el => el.classList.contains('visible')],
        ['star-editor-frame', el => el.classList.contains('visible')],
    ];
    const subModalOpen = TEMP_MODALS.some(id => document.getElementById(id))
        || persistentCheck.some(([id, check]) => { const el = document.getElementById(id); return el && check(el); });
    if (subModalOpen) {
        return;
    }

    // --- 优先级 1: 关闭标签筛选下拉菜单 ---
    // 必须走 closeTagFilterMenu() 完整清理。
    if (document.getElementById('star-tag-filter-menu')) {
        closeTagFilterMenu();
        return; // 处理完毕，停止后续检查
    }

    // --- 优先级 2: 关闭最顶层的"设置"小菜单 ---
    // 必须走 closeAvatarLongPressMenu() 完整清理：恢复主遮罩 backdrop-filter、
    // 移除 resize 监听。直接 remove DOM 会残留样式与监听器。
    if (document.getElementById('star-options-menu-overlay')) {
        closeAvatarLongPressMenu();
        return; // 处理完毕，停止后续检查
    }

    // --- 优先级 3: 关闭截图设置弹窗（无独立 Esc 处理器，触发其关闭按钮） ---
    const ssOverlay = document.getElementById('star-ss-settings-overlay');
    if (ssOverlay) {
        const closeBtn = ssOverlay.querySelector('.star-ss-close-btn');
        if (closeBtn) {
            closeBtn.click();
        } else {
            ssOverlay.remove();
        }
        return;
    }

    // --- 优先级 4: 关闭上下文查看器 ---
    const contextFrame = document.getElementById('context-messages-frame');
    if (contextFrame && contextFrame.classList.contains('visible')) {
        // 这个弹窗有专门的关闭函数，直接调用即可。
        closeContextFrame();
        return; // 处理完毕，停止后续检查
    }

    // --- 优先级 5: 关闭收藏夹主窗口 ---
    // 如果以上所有弹窗都不存在，最后才关闭收藏夹主窗口。
    if (state.modalElement && state.modalElement.classList.contains('visible')) {
        closeFavoritesModal();
    }
}

// =================================================================
//                  UI RENDERING (OPTIMIZED)
// =================================================================

/**
 * Renders the favorites view with the specified chat's favorites.
 */
export async function renderFavoritesView(selectedChatFileName = null) {
    // 切换聊天/角色时若标签筛选菜单还开着，一并关闭（防止残留遮住新内容）
    closeTagFilterMenu();

    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const selectedChatFileNameNoExt = selectedChatFileName ? String(selectedChatFileName).replace('.jsonl', '') : null;

    // --- OPTIMIZATION: Initial Load Logic ---
    if (state.allChatsFavoritesData.length === 0) {
        // This block now only runs on the very first, "instant" render.
        // It uses getContext() for speed, avoiding API calls.
        // forceRebuild=true：面板首次打开是收藏数据的关键展示点，即使此前存在
        // 脏缓存（内容已变但数组引用/长度未变的竞态）也强制重建，保证显示正确。
        const currentChatMetadata = ensureFavoritesArrayExists(true) || { favorites: [] };
        const currentChatMessages = context.chat || [];

        const initialData = {
            fileName: currentContextChatIdNoExt,
            displayName: currentContextChatIdNoExt,
            metadata: currentChatMetadata,
            favorites: currentChatMetadata.favorites || [],
            messages: currentChatMessages,
            isGroup: !!context.groupId,
            characterId: context.characterId,
            groupId: context.groupId,
        };
        state.allChatsFavoritesData.push(initialData);

        state.currentViewingChatFile = currentContextChatIdNoExt;
    } else if (selectedChatFileNameNoExt) {
        state.currentViewingChatFile = selectedChatFileNameNoExt;
    } else {
        // Fallback if something went wrong
        state.currentViewingChatFile = currentContextChatIdNoExt;
    }

    let viewingChatData = state.allChatsFavoritesData.find(chatData => String(chatData.fileName).replace('.jsonl', '') === state.currentViewingChatFile);

    // If we clicked a chat that hasn't been loaded by the background task yet
    if (!viewingChatData && !state.isLoadingOtherChats) {
        state.modalBodyElement.innerHTML = '<div class="spinner"></div>';
        const fullChatData = await getFullChatData(context.characterId, context.groupId, state.currentViewingChatFile, !!context.groupId);
        if(fullChatData) {
            viewingChatData = {
                fileName: state.currentViewingChatFile,
                displayName: state.currentViewingChatFile,
                ...fullChatData,
                isGroup: !!context.groupId,
                characterId: context.characterId,
                groupId: context.groupId,
            };
            state.allChatsFavoritesData.push(viewingChatData);
        }
    } else if (!viewingChatData) {
        state.modalBodyElement.innerHTML = `<div class="favorites-empty">聊天收藏正在加载中...</div>`;
        return;
    }

    const roleName = viewingChatData.isGroup
        ? (context.groups?.find(g => g.id === viewingChatData.groupId)?.name || '未命名群聊')
        : (context.characters[viewingChatData.characterId]?.name || context.name2);
    state.modalTitleElement.textContent = roleName || '收藏管理';

    const favoritesArray = viewingChatData.metadata?.favorites || [];
    const totalFavorites = favoritesArray.length;

    // 清理加载指示器：openFavoritesModal / 「聊天未缓存」分支 / switchToCharacter 设置的 spinner，
    // 渲染完成前必须移除，否则会残留为空占位块挤占布局
    const staleSpinner = state.modalBodyElement.querySelector('.spinner');
    if (staleSpinner) staleSpinner.remove();

    // --- Render sidebar and main content ---
    renderChatListPanel(); // Update the chat list panel separately
    await renderMainPanel(viewingChatData); // Render the main favorites content
}

/**
 * Renders the chat list panel in the sidebar.
 */
export function renderChatListPanel() {
    let overlay = state.modalBodyElement.querySelector('.favorites-sidebar-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'favorites-sidebar-overlay';
        overlay.addEventListener('click', () => {
            if (state.modalDialogElement) {
                state.modalDialogElement.classList.add('sidebar-closed');
            }
        });
        state.modalBodyElement.prepend(overlay);
    }

    let panel = state.modalBodyElement.querySelector('.favorites-chat-list-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'favorites-chat-list-panel';
        state.modalBodyElement.prepend(panel);
    }

    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    // 侧栏底部主题图标：暗色主题显示月亮，亮色主题显示太阳
    const savedTheme = extension_settings[PLUGIN_NAME]?.theme || 'light';
    const themeIcon = savedTheme === 'dark' ? 'fa-moon' : 'fa-sun';

    const chatListItemsHtml = `
        <div class="favorites-chat-list-items">
            ${state.allChatsFavoritesData.map(chat => {
                const fileNameNoExt = String(chat.fileName).replace('.jsonl', '');
                const favCount = chat.favorites?.length || 0;
                // Show item if it has favorites, or if it's the current chat (even if empty)
                if (favCount === 0 && fileNameNoExt !== currentContextChatIdNoExt) return '';

                const isSelected = fileNameNoExt === state.currentViewingChatFile;
                return `
                    <div class="favorites-chat-list-item ${isSelected ? 'active' : ''}" data-chat-file="${fileNameNoExt}">
                        <div class="chat-list-item-name" title="${chat.displayName || fileNameNoExt}">
                            ${chat.displayName || fileNameNoExt}
                        </div>
                        <div class="chat-list-item-count">${favCount}</div>
                    </div>
                `;
            }).join('')}
            ${state.isLoadingOtherChats ? '<div class="chat-list-loader">加载中...</div>' : ''}
        </div>
        <div class="favorites-sidebar-bottom">
            <div class="favorites-sidebar-char-switch-btn" title="切换角色（跨角色浏览收藏）">
                <i class="fa-solid fa-users"></i>
                <span>切换角色</span>
            </div>
            <div class="favorites-sidebar-icon-row">
                <div class="favorites-sidebar-theme-btn" title="切换主题">
                    <i class="fa-solid ${themeIcon}"></i>
                </div>
                <div class="favorites-sidebar-qa-btn" title="AI答疑助手">
                    <i class="fa-solid fa-comment-dots"></i>
                </div>
                <div class="favorites-sidebar-settings-btn" title="打开设置">
                    <i class="fa-solid fa-gear"></i>
                </div>
            </div>
        </div>
    `;
    panel.innerHTML = chatListItemsHtml;

    // 绑定角色切换按钮（跨角色浏览收藏）
    const charSwitchBtn = panel.querySelector('.favorites-sidebar-char-switch-btn');
    if (charSwitchBtn) {
        charSwitchBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openCharacterSwitcher();
        });
    }

    // 绑定侧栏底部主题切换按钮（太阳/月亮图标，随主题切换）
    const themeBtn = panel.querySelector('.favorites-sidebar-theme-btn');
    if (themeBtn) {
        themeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleTheme();
            renderChatListPanel(); // 重新渲染以切换太阳/月亮图标
        });
    }

    // 绑定侧栏底部 AI 答疑按钮（打开答疑面板）
    const qaBtn = panel.querySelector('.favorites-sidebar-qa-btn');
    if (qaBtn) {
        qaBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            import('./qa.js').then(m => m.openQAPanel());
        });
    }

    // 绑定侧栏底部设置按钮点击事件
    const settingsBtn = panel.querySelector('.favorites-sidebar-settings-btn');
    if (settingsBtn) {
        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showAvatarLongPressMenu();
        });
    }

    const chatListElement = panel.querySelector('.favorites-chat-list-items');
    if (chatListElement) chatListElement.scrollTop = state.chatListScrollTop;
}

/**
 * Renders the main panel with favorite items.
 */
export async function renderMainPanel(viewingChatData) {
    let mainPanel = state.modalBodyElement.querySelector('.favorites-main-panel');
    if (!mainPanel) {
        mainPanel = document.createElement('div');
        mainPanel.className = 'favorites-main-panel';
        state.modalBodyElement.appendChild(mainPanel);
    }

    // 应用标签筛选（右上角标签图标激活时只显示该标签的收藏）
    const favoritesArray = getFilteredFavorites(viewingChatData);
    const totalFavorites = favoritesArray.length;

    const sortedFavorites = [...favoritesArray].sort((a, b) => parseInt(a.messageId) - parseInt(b.messageId));
    const totalPages = Math.max(1, Math.ceil(totalFavorites / state.itemsPerPage));
    if (state.currentPage > totalPages) state.currentPage = totalPages;
    const startIndex = (state.currentPage - 1) * state.itemsPerPage;
    const endIndex = Math.min(startIndex + state.itemsPerPage, totalFavorites);
    const currentPageItems = sortedFavorites.slice(startIndex, endIndex);

    let favoritesListHtml = '';
    if (totalFavorites === 0) {
        favoritesListHtml = `<div class="favorites-empty">此聊天没有收藏的消息。</div>`;
    } else {
        const originalChatMessages = viewingChatData.messages || [];
        for (const [index, favItem] of currentPageItems.entries()) {
            if (favItem) {
                const messageIndex = parseInt(favItem.messageId, 10);
                let messageForRender = null;
                if (!isNaN(messageIndex) && messageIndex >= 0 && messageIndex < originalChatMessages.length) {
                    messageForRender = originalChatMessages[messageIndex];
                }
                favoritesListHtml += await renderFavoriteItem(favItem, startIndex + index, messageForRender);
            }
        }
    }

    const mainPanelHtml = `
        <div class="favorites-list">
            ${favoritesListHtml}
        </div>
        <div class="favorites-pagination"></div>
    `;

    mainPanel.innerHTML = mainPanelHtml;

    // Call the new pagination renderer
    if (totalFavorites > state.itemsPerPage) {
        renderPagination(state.currentPage, totalPages);
    }

    const favoritePreviews = mainPanel.querySelectorAll('.fav-preview');
    favoritePreviews.forEach(previewElement => {
        renderIframesInElement($(previewElement));
    });
}

/**
 * 取消进行中的后台收藏加载。
 * 切换聊天/角色或重新打开收藏面板时调用，避免旧请求 resolve 后把脏数据写入 state。
 */
export function abortBackgroundLoad() {
    if (backgroundLoadController) {
        backgroundLoadController.abort();
        backgroundLoadController = null;
    }
}

/**
 * Asynchronously loads favorites from all other chats in the background.
 * 使用 AbortController 管理生命周期：可被 abortBackgroundLoad() 取消，防止数据污染。
 */
export async function loadOtherChatsInBackground() {
    // 先取消上一次可能还在进行中的加载
    abortBackgroundLoad();
    state.isLoadingOtherChats = false;

    const controller = new AbortController();
    backgroundLoadController = controller;
    state.isLoadingOtherChats = true;
    Logger.debug('开始后台加载其他聊天的收藏数据...');
    renderChatListPanel(); // Show loader in the chat list

    try {
        const otherChatsData = await getAllChatFavoritesForCurrentContext(true, { signal: controller.signal });

        // 若加载过程中已被取消，丢弃结果，防止脏数据写入
        if (controller.signal.aborted) {
            Logger.debug('后台加载已被取消，丢弃结果');
            return;
        }

        Logger.debug(`后台加载完成，获取到 ${otherChatsData.length} 个聊天数据`);

        // Merge results. Avoid duplicates.
        const existingFileNames = new Set(state.allChatsFavoritesData.map(c => c.fileName));
        otherChatsData.forEach(chatData => {
            if (!existingFileNames.has(chatData.fileName)) {
                state.allChatsFavoritesData.push(chatData);
            }
        });

        // Sort the final list
        const context = getContext();
        const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
        state.allChatsFavoritesData.sort((a, b) => {
            if (a.fileName === currentContextChatIdNoExt) return -1;
            if (b.fileName === currentContextChatIdNoExt) return 1;
            return a.fileName.localeCompare(b.fileName);
        });

        renderChatListPanel(); // Re-render the chat list with all items and remove loader
    } catch (error) {
        if (!isAbortError(error, controller.signal)) {
            Logger.error('后台加载其他聊天收藏失败:', error);
        } else {
            Logger.debug('后台加载已被取消');
        }
    } finally {
        // 仅当本次 controller 仍是当前活跃的那个时才清理加载状态
        if (backgroundLoadController === controller) {
            backgroundLoadController = null;
            state.isLoadingOtherChats = false;
            renderChatListPanel();
        }
    }
}

/**
 * 切换收藏面板至指定角色的收藏数据（跨角色浏览，不改变 ST 当前聊天）。
 * 用深拷贝填充 allChatsFavoritesData，避免后续编辑/增删操作污染全局扫描缓存。
 * @param {object} charEntry - 来自 scanAllCharactersForFavorites 的角色条目
 */
/**
 * 按需加载单个聊天数据（供 switchToCharacter 使用）。
 * @returns {object|null} 该聊天的完整数据（含 metadata/favorites/messages），无收藏返回 null
 */
async function loadSingleChatData(chat, charEntry, signal) {
    // characterId 可能因会话内角色增删导致下标漂移，回退用角色名重新定位
    let characterId = charEntry.characterId !== undefined ? charEntry.characterId : null;
    if (!charEntry.isGroup && characterId !== null) {
        const context = getContext();
        if (!context.characters || !context.characters[characterId]) {
            const byName = (context.characters || []).findIndex(ch => ch && ch.name === charEntry.name);
            if (byName >= 0) characterId = byName;
        }
    }

    const fullChatData = await getFullChatData(
        characterId,
        charEntry.groupId !== undefined ? charEntry.groupId : null,
        chat.fileName,
        !!charEntry.isGroup,
        null,
        { signal }
    );
    if (fullChatData && (fullChatData.metadata?.favorites?.length > 0)) {
        return {
            fileName: chat.fileName,
            displayName: chat.displayName || chat.fileName,
            metadata: fullChatData.metadata,
            favorites: fullChatData.metadata.favorites || [],
            messages: fullChatData.messages || [],
            isGroup: !!charEntry.isGroup,
            characterId,
            groupId: charEntry.groupId !== undefined ? charEntry.groupId : null,
        };
    }
    return null;
}

/**
 * 后台并行加载该角色「第一个聊天之外」的有收藏聊天，加载完成后并入侧栏列表。
 * 复用 switchToCharacter 传入的 AbortController，完成或取消时自行清理 backgroundLoadController。
 */
async function loadRestChatsInBackground(restChats, charEntry, controller) {
    try {
        const loaded = await Promise.all(restChats.map(async (chat) => {
            if (controller.signal.aborted) return null;
            return loadSingleChatData(chat, charEntry, controller.signal);
        }));
        if (controller.signal.aborted) return;
        const valid = loaded.filter(Boolean);
        if (valid.length > 0) {
            // 去重合并（首个聊天已在 allChatsFavoritesData）
            const existing = new Set(state.allChatsFavoritesData.map(c => c.fileName));
            valid.forEach(data => {
                if (!existing.has(data.fileName)) state.allChatsFavoritesData.push(data);
            });
        }
    } catch (error) {
        if (!isAbortError(error, controller.signal)) {
            Logger.error('后台加载该角色其余聊天失败:', error);
        }
    } finally {
        if (backgroundLoadController === controller) {
            backgroundLoadController = null;
        }
        state.isLoadingOtherChats = false;
        renderChatListPanel();
    }
}

export async function switchToCharacter(charEntry) {
    Logger.info(`切换到角色收藏: ${charEntry.name}（${charEntry.totalFavorites} 条）`);

    if (!charEntry.chatsWithFavorites || charEntry.chatsWithFavorites.length === 0) {
        if (state.modalBodyElement) state.modalBodyElement.innerHTML = '<div class="favorites-empty">该角色没有收藏。</div>';
        return;
    }

    // 扫描索引是轻量的（只含「有收藏的聊天」列表，不含完整消息/收藏数据）。
    // 优化：先加载收藏最多的第一个聊天立即渲染（秒开），其余聊天后台并行加载。
    abortBackgroundLoad();
    if (state.modalBodyElement) state.modalBodyElement.innerHTML = '<div class="spinner"></div>';
    const controller = new AbortController();
    backgroundLoadController = controller;

    const chatList = charEntry.chatsWithFavorites;   // 扫描时已按收藏数降序，首个为收藏最多
    const [firstChat, ...restChats] = chatList;

    try {
        // 1. 先加载第一个聊天并立即渲染（秒开）
        const firstFull = await loadSingleChatData(firstChat, charEntry, controller.signal);
        if (controller.signal.aborted) {
            if (backgroundLoadController === controller) backgroundLoadController = null;
            return;
        }
        if (!firstFull) {
            if (backgroundLoadController === controller) backgroundLoadController = null;
            if (state.modalBodyElement) state.modalBodyElement.innerHTML = '<div class="favorites-empty">该角色没有收藏。</div>';
            return;
        }
        state.allChatsFavoritesData = [firstFull];
        state.currentViewingChatFile = firstFull.fileName;
        state.currentPage = 1;

        // 重置搜索状态（避免切换后搜索框仍展开导致布局错位）
        if (state.modalElement) {
            const searchContainer = state.modalElement.querySelector('.favorites-search-container');
            const searchInput = state.modalElement.querySelector('.favorites-search-input');
            if (searchContainer) searchContainer.classList.remove('expanded');
            if (searchInput) searchInput.value = '';
        }

        // 标题先置为角色名（renderFavoritesView 内部也会按 characterId 重设标题，结果一致）
        if (state.modalTitleElement) state.modalTitleElement.textContent = charEntry.name;

        await renderFavoritesView(state.currentViewingChatFile);

        // 2. 其余聊天后台加载（不阻塞已渲染内容）
        if (restChats.length > 0) {
            state.isLoadingOtherChats = true;
            renderChatListPanel(); // 侧栏显示加载占位
            loadRestChatsInBackground(restChats, charEntry, controller);
        } else {
            // 仅一个聊天，无需后台加载，直接清理 controller
            if (backgroundLoadController === controller) {
                backgroundLoadController = null;
            }
        }

        toastr.info(`已切换到「${charEntry.name}」的收藏`, '', { timeOut: 1500 });
    } catch (error) {
        if (!isAbortError(error, controller.signal)) {
            Logger.error('切换角色加载收藏失败:', error);
            toastr.error('加载该角色的收藏失败');
        }
        if (backgroundLoadController === controller) {
            backgroundLoadController = null;
        }
    }
}

/**
 * Renders a single favorite item.
 * @param {string} [highlightQuery] - 搜索高亮关键词（传入时对备注与正文做 mark 高亮）
 */
export async function renderFavoriteItem(favItem, index, originalMessage = null, highlightQuery = '') {
    if (!favItem || !favItem.favoritedSwipes || favItem.favoritedSwipes.length === 0) return '';
    const isUserMessage = originalMessage ? originalMessage.is_user : favItem.role === 'user';
    const roleClass = isUserMessage ? 'role-user' : 'role-ai';

    const activeSwipe = favItem.favoritedSwipes[favItem.currentSwipeViewIndex];
    const activeSwipeId = activeSwipe.swipeId;
    const favId = activeSwipe.id;
    const note = activeSwipe.note || '';

    let previewText = '', deletedClass = '', sendDateString = '', senderName = favItem.sender || '未知';

    if (originalMessage) {
        senderName = originalMessage.name || senderName;
        sendDateString = originalMessage.send_date ? timestampToMoment(originalMessage.send_date).format('YYYY-MM-DD HH:mm') : '[时间未知]';
        try {
            let textToFormat = originalMessage.mes;
            if (originalMessage.swipes && originalMessage.swipes[activeSwipeId] !== undefined) {
                textToFormat = originalMessage.swipes[activeSwipeId];
            }
            previewText = textToFormat ? messageFormatting(textToFormat, senderName, false, isUserMessage, null, {}, false) : '[消息内容为空]';
        } catch (e) {
            previewText = `[格式化失败] ${originalMessage.mes}`;
        }
    } else {
        previewText = '[原始消息内容不可用或已删除]';
        sendDateString = '[时间不可用]';
        deletedClass = 'deleted';
    }

    // 搜索高亮：备注（纯文本）与正文（格式化 HTML）都做关键词高亮
    let noteContentHtml = escapeHtml(note);
    if (highlightQuery) {
        noteContentHtml = highlightInHtml(noteContentHtml, highlightQuery);
        previewText = highlightInHtml(previewText, highlightQuery);
    }
    const noteHtml = note ? `<div class="fav-note-content">${noteContentHtml}</div>` : '<div class="fav-note-content"></div>';

    // 标签不显示在卡片上（卡片头部位置留给备注），仅作为右上角筛选的凭证

    let reasoningHtml = '';
    if (originalMessage && originalMessage.extra && originalMessage.extra.reasoning) {
        const reasoningContent = messageFormatting(originalMessage.extra.reasoning, null, false, false, null, {}, false);
        reasoningHtml = `
            <details class="fav-reasoning-details">
                <summary class="fav-reasoning-summary">
                    <span>内心独白</span>
                </summary>
                <div class="fav-reasoning-content">${reasoningContent}</div>
            </details>
        `;
    }

    let navHtml = '';
    if (favItem.favoritedSwipes.length > 1) {
        navHtml = `
            <div class="fav-swipe-nav">
                <i class="fa-solid fa-chevron-left nav-left" title="上一个收藏的Swipe"></i>
                <span class="nav-counter">${favItem.currentSwipeViewIndex + 1}/${favItem.favoritedSwipes.length}</span>
                <i class="fa-solid fa-chevron-right nav-right" title="下一个收藏的Swipe"></i>
            </div>`;
    }

    return `
                <div class="favorite-item ${roleClass}" data-fav-id="${favId}" data-msg-id="${favItem.messageId}" data-swipe-id="${activeSwipeId}" mesid="${favItem.messageId}">
                    <div class="fav-header-info">
                        ${noteHtml}
                        <div class="fav-meta-cluster">
                            <span class="fav-floor-number">#${favItem.messageId}</span>
                            <div class="fav-send-date">${sendDateString}</div>
                        </div>
                    </div>

                    ${reasoningHtml}

                    <div class="fav-preview ${deletedClass}">${previewText}</div>

                    <div class="fav-actions">
                        ${navHtml}
                        <i class="fa-solid fa-eye" title="预览上下文"></i>
                        <i class="fa-solid fa-expand" title="查看上下文"></i>
                        <i class="fa-solid fa-pencil" title="编辑原文"></i>
                        <i class="fa-solid fa-feather-pointed" title="编辑备注"></i>
                        <i class="fa-solid fa-tags" title="编辑标签"></i>
                        <i class="fa-solid fa-trash" title="取消收藏"></i>
                        <i class="fa-solid fa-ellipsis-vertical fav-action-more" title="更多操作"></i>
                    </div>
                </div>
            `;
}

/**
 * Renders the pagination component.
 */
export function renderPagination(currentPage, totalPages) {
    const paginationContainer = state.modalBodyElement.querySelector('.favorites-pagination');
    if (!paginationContainer) return;

    const getPageItem = (page, text = null, classes = []) => {
        if (page === currentPage) classes.push('active');
        if (!page) classes.push('disabled');
        const textContent = text || page;
        return `<div class="pagination-item ${classes.join(' ')}" data-page="${page}">${textContent}</div>`;
    };

    let html = '';

    // Previous button
    html += getPageItem(currentPage > 1 ? currentPage - 1 : null, '‹');

    const pageNumbers = [];
    // Always show page 1
    pageNumbers.push(1);

    // Ellipsis after page 1
    if (currentPage > 4) {
        pageNumbers.push('...');
    }

    // Pages around current page
    for (let i = currentPage - 2; i <= currentPage + 2; i++) {
        if (i > 1 && i < totalPages) {
            pageNumbers.push(i);
        }
    }

    // Ellipsis before last page
    if (currentPage < totalPages - 3) {
        pageNumbers.push('...');
    }

    // Always show last page if total > 1
    if (totalPages > 1) {
        pageNumbers.push(totalPages);
    }

    // Remove duplicates and render page numbers
    [...new Set(pageNumbers)].forEach(num => {
        if (num === '...') {
            html += '<div class="pagination-item ellipsis">...</div>';
        } else {
            html += getPageItem(num, null, []);
        }
    });

    // Next button
    html += getPageItem(currentPage < totalPages ? currentPage + 1 : null, '›');

    paginationContainer.innerHTML = html;
}

/**
 * Handles clicks within the modal.
 */
export async function handleModalClick(event) {
    const target = event.target;
    const chatListItem = target.closest('.favorites-chat-list-item');
    if (chatListItem) {
        const chatFile = String(chatListItem.dataset.chatFile).replace('.jsonl','');
        if (chatFile && chatFile !== state.currentViewingChatFile) {
            state.chatListScrollTop = chatListItem.parentElement.scrollTop;
            state.currentPage = 1;
            await renderFavoritesView(chatFile);
        }
        if (state.modalDialogElement) {
            state.modalDialogElement.classList.add('sidebar-closed');
        }
        return;
    }
    const paginationItem = target.closest('.pagination-item');
    if (paginationItem) {
        // 双击当前页码弹出跳转弹窗
        if (paginationItem.classList.contains('active')) {
            const totalPages = Math.ceil((state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === state.currentViewingChatFile)?.favorites.length || 0) / state.itemsPerPage);
            const { showInputModal } = await import('./components.js');
            const result = await showInputModal(
                `请输入要跳转的页码 (1-${totalPages})`,
                '跳转页码',
                String(state.currentPage),
                { isNoteMode: true, okButton: '跳转', cancelButton: '取消', placeholder: '' }
            );
            if (result !== null && result.trim() !== '') {
                const newPage = parseInt(result.trim(), 10);
                if (!isNaN(newPage) && newPage >= 1 && newPage <= totalPages && newPage !== state.currentPage) {
                    state.currentPage = newPage;
                    await renderFavoritesView(state.currentViewingChatFile);
                } else if (!isNaN(newPage) && newPage === state.currentPage) {
                    // 输入的就是当前页，无需跳转
                } else {
                    toastr.warning(`请输入有效的页码 (1-${totalPages})`);
                }
            }
            return;
        }

        // Handle clicks on other page items
        if (!paginationItem.classList.contains('disabled') && !paginationItem.classList.contains('ellipsis')) {
            const page = parseInt(paginationItem.dataset.page, 10);
            if (!isNaN(page) && page !== state.currentPage) {
                state.currentPage = page;
                await renderFavoritesView(state.currentViewingChatFile);
            }
        }
        return;
    }

    const favItemEl = target.closest('.favorite-item');

	if (favItemEl) {
		const favId = favItemEl.dataset.favId;
		const msgId = favItemEl.dataset.msgId;
		const activeSwipeId = favItemEl.dataset.swipeId;

		// 多Swipe导航点击事件
		if (target.classList.contains('nav-left') || target.classList.contains('nav-right')) {
			const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === state.currentViewingChatFile);
			if (chatData && chatData.favorites) {
				const favData = chatData.favorites.find(f => f.messageId === msgId);
				if (favData) {
					if (target.classList.contains('nav-left')) {
						favData.currentSwipeViewIndex = (favData.currentSwipeViewIndex - 1 + favData.favoritedSwipes.length) % favData.favoritedSwipes.length;
					} else {
						favData.currentSwipeViewIndex = (favData.currentSwipeViewIndex + 1) % favData.favoritedSwipes.length;
					}
					renderFavoritesView(state.currentViewingChatFile);
				}
			}
			return;
		}

		// 动态导入core.js中的函数以避免循环依赖
		const { handleEditNote, handleDeleteFavoriteFromPopup, handleEditMessageContent, handleEditTags } = await import('../core.js');
		// 动态导入preview.js中的函数
		const { enterPreviewMode } = await import('./preview.js');

		if (target.classList.contains('fa-expand')) {
			await handleViewContext(msgId, state.currentViewingChatFile, activeSwipeId);
		} else if (target.classList.contains('fa-feather-pointed')) {
			await handleEditNote(favId, state.currentViewingChatFile);
		} else if (target.classList.contains('fa-tags')) {
			await handleEditTags(favId, state.currentViewingChatFile);
		} else if (target.classList.contains('fa-trash')) {
			await handleDeleteFavoriteFromPopup(favId, msgId, state.currentViewingChatFile);
		} else if (target.classList.contains('fa-eye')) {
			await enterPreviewMode(msgId, state.currentViewingChatFile);
		} else if (target.classList.contains('fa-pencil')) {
			await handleEditMessageContent(favId, msgId, state.currentViewingChatFile, activeSwipeId);
		} else if (target.classList.contains('fav-action-more')) {
            showMobileActionsMenu(target, favId, msgId, activeSwipeId);
        }
	}
}

/**
 * Renders iframes in the specified element.
 */
export function renderIframesInElement($container) {
    if (!$container || !$container.length) return;

    $container.find('pre').each(function() {
        const $pre = $(this);
        let codeContent = $pre.text();

        if (codeContent.includes('<body') && codeContent.includes('</body>')) {
            const bridgeScript = `
            <script>
                (function() {
                    try {
                        const functionsToBridge = [
                            'getChatMessages', 'setChatMessages', 'createChatMessages', 'deleteChatMessages',
                            'getContext', 'toastr', 'log', 'jQuery', '$', '_'
                        ];
                        functionsToBridge.forEach(function(funcName) {
                            if (window.parent && typeof window.parent[funcName] !== 'undefined') {
                                window[funcName] = window.parent[funcName];
                            }
                        });
                    } catch (e) {
                        console.error('Tavern Star Plugin Bridge Script Error:', e);
                    }
                })();
            <\/script>`;

            const headTagMatch = codeContent.match(/<head\s*>/i);
            if (headTagMatch) {
                const injectionPoint = headTagMatch.index + headTagMatch[0].length;
                codeContent = codeContent.slice(0, injectionPoint) + bridgeScript + codeContent.slice(injectionPoint);
            } else {
                codeContent = bridgeScript + codeContent;
            }

            const $iframe = $('<iframe>');
            $iframe.css({ 'width': '100%', 'border': 'none', 'margin': '5px 0', 'display': 'block', 'overflow': 'hidden' });
            $iframe.attr('srcdoc', codeContent);
            $iframe.on('load', function() {
                const iframe = this;
                try {
                    const contentWindow = iframe.contentWindow;
                    if (!contentWindow) return;
                    const style = contentWindow.document.createElement('style');
                    style.innerHTML = 'body { margin: 0; overflow: hidden; }';
                    if (contentWindow.document.head) contentWindow.document.head.appendChild(style);
                    const body = contentWindow.document.body;
                    if (!body) return;
                    const updateHeight = () => { $(iframe).css('height', body.scrollHeight + 'px'); };
                    const observer = new ResizeObserver(updateHeight);
                    observer.observe(body);
                    updateHeight();
                } catch (e) {
                    Logger.error("Error setting up iframe resizer:", e);
                    setTimeout(() => {
                        if (iframe.contentWindow && iframe.contentWindow.document.body) {
                            $(iframe).css('height', iframe.contentWindow.document.body.scrollHeight + 'px');
                        }
                    }, 200);
                }
            });
            $pre.replaceWith($iframe);
        }
    });
}

/**
 * Handles the favorite toggle event.
 */
export async function handleFavoriteToggle($target, event) {
    Logger.debug('触发收藏切换');
    ensureCurrentChatIsCached();
    // $target 是传入的 jQuery 对象，指向 .favorite-toggle-icon 元素
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

    // 在预览模式下，使用当前查看的聊天文件
    const targetChatFile = state.isPreviewingContext ? state.currentViewingChatFile : String(context.chatId || '').replace('.jsonl','');

    // 获取正确的聊天数据
    let chatData, currentChatMetadata;
    if (state.isPreviewingContext) {
        chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl','') === targetChatFile);
        if (!chatData) {
            toastr.error('无法在预览模式下切换收藏状态');
            return;
        }
        currentChatMetadata = chatData.metadata;
    } else {
        currentChatMetadata = ensureFavoritesArrayExists();
    }

    if (!currentChatMetadata) return;

    const messageIndex = parseInt(messageIdString, 10);
    const messages = state.isPreviewingContext ? chatData.messages : context.chat;
    const message = messages[messageIndex];
    if (!message) return;

    // 动态导入core函数以避免循环依赖
    const { addFavorite, removeFavoriteById } = await import('../core.js');

    const swipeId = message.swipe_id || 0;
    let isCurrentlyFavorited = false;
    if (message.swipe_info && message.swipe_info[swipeId] && message.swipe_info[swipeId].star_favorite) {
        isCurrentlyFavorited = true;
    }

    const iconElement = $target.find('i');

    if (!isCurrentlyFavorited) {
        $target.addClass('favorited');
        const messageInfo = { messageId: messageIdString, sender: message.name, role: message.is_user ? 'user' : 'character' };
        addFavorite(messageInfo, targetChatFile);
    } else {
        $target.removeClass('favorited');
        const favId = message.swipe_info[swipeId].star_favorite.id;
        removeFavoriteById(favId, targetChatFile);
    }
}

/**
 * Shows the mobile actions menu for a specific favorite item.
 */
export function showMobileActionsMenu(targetIcon, favId, msgId, activeSwipeId) {
    let menu = document.getElementById('star-mobile-actions-menu');

    // 如果菜单已可见，则关闭它（切换行为）
    if (menu && menu.classList.contains('visible')) {
        menu.classList.remove('visible');
        return;
    }

    if (!menu) {
        menu = document.createElement('div');
        menu.id = 'star-mobile-actions-menu';
        menu.className = 'star-mobile-actions-menu';
        document.body.appendChild(menu);

            // 点击外部空白区域或非展开按钮时自动关闭菜单
        document.addEventListener('click', (e) => {
            const currentMenu = document.getElementById('star-mobile-actions-menu');
            if (currentMenu && currentMenu.classList.contains('visible') && !e.target.closest('#star-mobile-actions-menu') && !e.target.closest('.fav-action-more')) {
                currentMenu.classList.remove('visible');
            }
        });
    }

    // 适配主题
    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        menu.dataset.starTheme = 'dark';
    } else {
        menu.removeAttribute('data-star-theme');
    }

    // 渲染内部HTML（标签功能暂为测试功能，未列入移动端菜单）
    menu.innerHTML = `
        <div class="star-mobile-actions-item" data-action="pencil">
            <i class="fa-solid fa-pencil"></i> 编辑原文
        </div>
        <div class="star-mobile-actions-item" data-action="feather">
            <i class="fa-solid fa-feather-pointed"></i> 编辑备注
        </div>
        <div class="star-mobile-actions-item" data-action="trash" style="color: var(--star-text-deleted);">
            <i class="fa-solid fa-trash" style="color: var(--star-text-deleted);"></i> 取消收藏
        </div>
    `;

    // 动态定位逻辑
    const rect = targetIcon.getBoundingClientRect();
    const menuHeight = 135;
    const menuWidth = 140;

    let top = rect.top - menuHeight - 8;
    if (top < 10) { // 如果上方空间不足，则将菜单显示在下方
        top = rect.bottom + 8;
    }

    let left = rect.right - menuWidth + 10; // 与图标右侧大体对齐
    if (left < 10) left = 10;

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    menu.classList.add('visible');

    // 绑定点击操作
    menu.onclick = async (e) => {
        const item = e.target.closest('.star-mobile-actions-item');
        if (!item) return;

        menu.classList.remove('visible');
        const action = item.dataset.action;
        const { handleEditNote, handleDeleteFavoriteFromPopup, handleEditMessageContent } = await import('../core.js');

        if (action === 'pencil') {
            await handleEditMessageContent(favId, msgId, state.currentViewingChatFile, activeSwipeId);
        } else if (action === 'feather') {
            await handleEditNote(favId, state.currentViewingChatFile);
        } else if (action === 'trash') {
            await handleDeleteFavoriteFromPopup(favId, msgId, state.currentViewingChatFile);
        }
    };
}

// Export applySavedTheme from settings.js for preview.js to use
export { applySavedTheme };