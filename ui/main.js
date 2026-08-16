// ui/main.js - 核心面板渲染与主逻辑

import { getContext, extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, chat, messageFormatting } from '../../../../../script.js';
import { timestampToMoment } from '../../../../utils.js';
import { state, PLUGIN_NAME } from '../state.js';
import { getAllChatFavoritesForCurrentContext, getFullChatData, isAbortError } from '../api.js';
import { ensureFavoritesArrayExists, ensureCurrentChatIsCached } from '../core.js';
import { applySavedTheme, showAvatarLongPressMenu } from './settings.js';
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
                <div class="favorites-qa-btn" title="AI答疑助手"><i class="fa-solid fa-circle-question"></i></div>
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

    // AI答疑按钮
    const qaBtn = state.modalElement.querySelector('.favorites-qa-btn');
    if (qaBtn) {
        qaBtn.addEventListener('click', () => {
            import('./qa.js').then(m => m.openQAPanel());
        });
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

    // 阻止点击过滤按钮时搜索框失去焦点（避免因blur事件导致搜索框收起）
    searchFilter.addEventListener('mousedown', (e) => {
        e.preventDefault();
    });

    searchFilter.addEventListener('click', (e) => {
        e.currentTarget.classList.toggle('active');
        const query = searchInput.value.toLowerCase();
        handleSearchInModal(query);
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        handleSearchInModal(query);
    });

    state.modalElement.addEventListener('click', (e) => {
        if (e.target === state.modalElement) {
            closeFavoritesModal();
        }
    });

    state.modalBodyElement.addEventListener('click', handleModalClick);
}

/**
 * Handles search functionality in the modal.
 */
export function handleSearchInModal(query) {
    const searchFilter = state.modalElement.querySelector(`.${SEARCH_FILTER_CLASS}`);
    const filterByNote = searchFilter.classList.contains('active');

    const allItems = state.modalBodyElement.querySelectorAll('.favorite-item');
    allItems.forEach(item => {
        let content = '';
        if (filterByNote) {
            const noteEl = item.querySelector('.fav-note-content');
            content = noteEl ? noteEl.textContent.toLowerCase() : '';
        } else {
            const previewEl = item.querySelector('.fav-preview');
            const noteEl = item.querySelector('.fav-note-content');
            const previewText = previewEl ? previewEl.textContent.toLowerCase() : '';
            const noteText = noteEl ? noteEl.textContent.toLowerCase() : '';
            content = previewText + ' ' + noteText;
        }

        if (content.includes(query)) {
            item.style.display = 'flex';
        } else {
            item.style.display = 'none';
        }
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
    favDoc.addEventListener('keydown', handleEscKey);

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

    // Clean up event listeners
    window.removeEventListener('resize', centerModal);
    favDoc.removeEventListener('keydown', handleEscKey);
}

/**
 * Handles the Escape key for closing various modals.
 */
export async function handleEscKey(event) {
    if (event.key !== 'Escape') {
        return; // 如果不是Escape键，直接退出
    }

    // 角色切换器打开时，ESC 仅关闭切换器（由切换器自身的 capture 监听处理），不连带关闭收藏面板
    if (document.getElementById('star-character-switcher')) {
        return;
    }

    // --- 优先级 1: 关闭最顶层的"设置"小菜单 ---
    // 这个菜单是覆盖在所有东西之上的，所以最先检查它。
    const optionsMenuOverlay = document.getElementById('star-options-menu-overlay');
    if (optionsMenuOverlay) {
        // 这个菜单没有独立的关闭函数，最直接的方式是移除其DOM元素。
        // 由于它是在 showAvatarLongPressMenu 中动态创建的，移除是安全的。
        optionsMenuOverlay.remove();
        return; // 处理完毕，停止后续检查
    }

    // --- 优先级 2: 关闭消息编辑器 ---
    // 它的层级与上下文查看器相同，但我们先检查它。
    const editorFrame = document.getElementById('star-editor-frame');
    if (editorFrame && editorFrame.classList.contains('visible')) {
        // 最健壮的关闭方式是触发它自己的关闭按钮的点击事件。
        // 这样可以确保所有在 `closeModal` 函数中定义的清理逻辑（如动画、事件监听器移除）都能正确执行。
        const closeBtn = editorFrame.querySelector('.star-editor-close-btn');
        if (closeBtn) {
            closeBtn.click();
        } else {
            // 如果找不到按钮，提供一个备用方案，直接移除元素。
            editorFrame.remove();
        }
        return; // 处理完毕，停止后续检查
    }

    // --- 优先级 3: 关闭上下文查看器 ---
    const contextFrame = document.getElementById('context-messages-frame');
    if (contextFrame && contextFrame.classList.contains('visible')) {
        // 这个弹窗有专门的关闭函数，直接调用即可。
        closeContextFrame();
        return; // 处理完毕，停止后续检查
    }

    // --- 优先级 4: 关闭收藏夹主窗口 ---
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
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const selectedChatFileNameNoExt = selectedChatFileName ? String(selectedChatFileName).replace('.jsonl', '') : null;

    // --- OPTIMIZATION: Initial Load Logic ---
    if (state.allChatsFavoritesData.length === 0) {
        // This block now only runs on the very first, "instant" render.
        // It uses getContext() for speed, avoiding API calls.
        const currentChatMetadata = ensureFavoritesArrayExists() || { favorites: [] };
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
            <div class="favorites-sidebar-settings-btn" title="打开设置">
                <i class="fa-solid fa-gear"></i>
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

    const favoritesArray = viewingChatData.metadata?.favorites || [];
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
export async function switchToCharacter(charEntry) {
    Logger.info(`切换到角色收藏: ${charEntry.name}（${charEntry.totalFavorites} 条）`);

    if (!charEntry.chatsWithFavorites || charEntry.chatsWithFavorites.length === 0) {
        if (state.modalBodyElement) state.modalBodyElement.innerHTML = '<div class="favorites-empty">该角色没有收藏。</div>';
        return;
    }

    // 深拷贝：metadata / favorites / messages 都需独立副本，防止编辑后写回污染扫描缓存
    state.allChatsFavoritesData = charEntry.chatsWithFavorites.map(c => {
        const metadataCopy = JSON.parse(JSON.stringify(c.metadata));
        const messagesCopy = JSON.parse(JSON.stringify(c.messages));
        return {
            fileName: c.fileName,
            displayName: c.displayName || c.fileName,
            metadata: metadataCopy,
            favorites: metadataCopy.favorites || [],
            messages: messagesCopy,
            isGroup: !!charEntry.isGroup,
            characterId: charEntry.characterId !== undefined ? charEntry.characterId : null,
            groupId: charEntry.groupId !== undefined ? charEntry.groupId : null,
        };
    });

    // 切换到收藏最多的那个聊天
    state.currentViewingChatFile = state.allChatsFavoritesData[0].fileName;
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

    toastr.info(`已切换到「${charEntry.name}」的收藏`, '', { timeOut: 1500 });
}

/**
 * Renders a single favorite item.
 */
export async function renderFavoriteItem(favItem, index, originalMessage = null) {
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

    const noteHtml = note ? `<div class="fav-note-content">${note}</div>` : '<div class="fav-note-content"></div>';

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
		const { handleEditNote, handleDeleteFavoriteFromPopup, handleEditMessageContent } = await import('../core.js');
		// 动态导入preview.js中的函数
		const { enterPreviewMode } = await import('./preview.js');

		if (target.classList.contains('fa-expand')) {
			await handleViewContext(msgId, state.currentViewingChatFile, activeSwipeId);
		} else if (target.classList.contains('fa-feather-pointed')) {
			await handleEditNote(favId, state.currentViewingChatFile);
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

    // 渲染内部HTML
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