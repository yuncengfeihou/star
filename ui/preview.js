// ui/preview.js - 上下文查看与预览模式

import { getContext, extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, reloadCurrentChat, addOneMessage, messageFormatting } from '../../../../../script.js';
import { timestampToMoment } from '../../../../utils.js';
import { state, PLUGIN_NAME } from '../state.js';
import { getFullChatData } from '../api.js';
import { addFavoriteIconsToMessages, refreshFavoriteIconsInView } from '../core.js';
import { openFavoritesModal, renderIframesInElement, applySavedTheme } from './main.js';
import { showContextRangeSettingsPopup } from './settings.js';
import { showScreenshotPopup, captureScreenshotMessages, captureElementScreenshot } from './screenshot.js';
import Logger from '../Logger.js';

// Constants from main.js
const SEARCH_FILTER_CLASS = 'favorites-search-filter';
const SEARCH_INPUT_CLASS = 'favorites-search-input';
const SEARCH_CONTAINER_CLASS = 'favorites-search-container';
const PREVIEW_EXIT_BUTTON_ID = 'favorites-preview-exit-button';
const MODAL_CLASS_NAME = 'favorites-modal-dialog';
// =================================================================
//           AUTO-HIDE PREVIEW TOGGLE ON SCROLL/LONG-PRESS
// =================================================================

let _previewAutoHideTimer = null;

function _hidePreviewToggle() {
    const container = document.getElementById('favorites-preview-container');
    if (container) {
        container.style.opacity = '0';
        container.style.pointerEvents = 'none';
    }
}

function _showPreviewToggle() {
    const container = document.getElementById('favorites-preview-container');
    if (container && state.isPreviewingContext) {
        container.style.opacity = '1';
        container.style.pointerEvents = 'auto';
    }
}

function _setupPreviewAutoHide() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    // 滚动时隐藏
    const handleScroll = () => {
        if (!state.isPreviewingContext) return;
        _hidePreviewToggle();
        clearTimeout(_previewAutoHideTimer);
        _previewAutoHideTimer = setTimeout(_showPreviewToggle, 600);
    };

    // contextmenu: 桌面端=右键，移动端=长按，是最可靠的跨平台钩子
    const handleContextMenu = () => {
        if (!state.isPreviewingContext) return;
        _hidePreviewToggle();
        clearTimeout(_previewAutoHideTimer);
        _previewAutoHideTimer = setTimeout(_showPreviewToggle, 800);
    };

    chatEl.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('contextmenu', handleContextMenu);

    state._previewAutoHideHandlers = { handleScroll, handleContextMenu };
}

function _teardownPreviewAutoHide() {
    const chatEl = document.getElementById('chat');
    const handlers = state._previewAutoHideHandlers;
    if (chatEl && handlers) {
        chatEl.removeEventListener('scroll', handlers.handleScroll);
    }
    if (handlers) {
        document.removeEventListener('contextmenu', handlers.handleContextMenu);
    }
    clearTimeout(_previewAutoHideTimer);
    _previewAutoHideTimer = null;
    state._previewAutoHideHandlers = null;
}

// =================================================================
//                      CONTEXT VIEW & PREVIEW
// =================================================================

/**
 * Shows the context messages frame with the specified messages.
 * 支持两种显示模式：'single'（单消息居中显示，默认）与 'context'（上下文列表）。
 * favoritedSwipeIds: 该消息所有被收藏的 swipe id（用于单消息模式左右切换）。
 */
export function showContextMessagesFrame(messages, highlightedIndex, chatContextForAvatar, targetSwipeId = null, favoritedSwipeIds = []) {
    const existingFrame = document.getElementById('context-messages-frame');
    if (existingFrame) existingFrame.remove();

    // 单消息显示为默认模式，记忆用户切换偏好
    let currentMode = extension_settings[PLUGIN_NAME]?.contextViewMode || 'single';
    if (currentMode !== 'single' && currentMode !== 'context') currentMode = 'single';

    // 当前查看的 swipe 在收藏 swipe 列表中的索引
    let currentSwipeIndex = 0;
    if (favoritedSwipeIds.length > 0 && targetSwipeId !== null) {
        const idx = favoritedSwipeIds.indexOf(String(targetSwipeId));
        currentSwipeIndex = idx >= 0 ? idx : 0;
    }

    const frameHtml = `
        <div id="context-messages-frame" class="context-messages-frame" data-mode="${currentMode}">
            <div class="context-messages-container">
                <div class="context-messages-header">
                    <div class="context-title">消息上下文</div>
                    <div class="context-header-actions">
                        <div class="context-swipe-control" style="display:none">
                            <div class="context-swipe-nav context-swipe-nav-left" title="上一个收藏的Swipe"><i class="fa-solid fa-chevron-left"></i></div>
                            <span class="context-swipe-counter">1 / 1</span>
                            <div class="context-swipe-nav context-swipe-nav-right" title="下一个收藏的Swipe"><i class="fa-solid fa-chevron-right"></i></div>
                        </div>
                        <div class="context-camera-btn" title="截图当前消息"><i class="fa-solid fa-camera"></i></div>
                        <div class="context-mode-toggle" title="切换显示模式"><i class="fa-solid fa-arrows-rotate"></i></div>
                        <div class="context-close-btn"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                </div>
                <div class="context-messages-body">
                    <div class="context-single-view"></div>
                    <div class="context-messages-content"></div>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', frameHtml);

    const frameElement = document.getElementById('context-messages-frame');
    const container = frameElement.querySelector('.context-messages-container');
    const singleView = frameElement.querySelector('.context-single-view');
    const contentContainer = frameElement.querySelector('.context-messages-content');
    const highlightedMsgData = messages[highlightedIndex];

    const titleElement = container.querySelector('.context-title');
    if (titleElement) {
        titleElement.style.cursor = 'pointer';
        titleElement.title = '点击修改上下文范围';
        // **直接调用设置弹窗，不再关闭当前上下文面板**
        titleElement.addEventListener('click', async () => {
            await showContextRangeSettingsPopup();
            // 设置更新后，关闭当前窗口以便用户重新打开查看新的范围
            closeContextFrame();
            toastr.info('请重新点击查看上下文以应用新的范围设置', '', { timeOut: 2000 });
        });
    }

    // 自定义滚动条：上下文列表模式与单消息模式各一条（同一位置，按 data-mode 显隐）
    const contextScrollbar = document.createElement('div');
    contextScrollbar.className = 'k-scrollerbar k-scrollerbar-context';
    container.prepend(contextScrollbar);
    const singleScrollbar = document.createElement('div');
    singleScrollbar.className = 'k-scrollerbar k-scrollerbar-single';
    container.prepend(singleScrollbar);

    // 生成滚动条处理器：滚动时显示进度条（随进度增高），停止滚动 1.5s 后淡出
    function makeScrollbarHandler(scrollEl, barEl) {
        let timeout = null;
        const handler = () => {
            barEl.style.opacity = '1';
            const { scrollHeight, clientHeight, scrollTop } = scrollEl;
            const trackHeight = container.clientHeight;
            const totalScrollableDistance = scrollHeight - clientHeight;
            if (totalScrollableDistance <= 0) {
                barEl.style.height = '0px';
                return;
            }
            const scrollProgress = scrollTop / totalScrollableDistance;
            barEl.style.height = `${trackHeight * scrollProgress}px`;
            clearTimeout(timeout);
            timeout = setTimeout(() => { barEl.style.opacity = '0'; }, 1500);
        };
        return { handler, clear: () => { if (timeout) { clearTimeout(timeout); timeout = null; } } };
    }

    // 上下文列表模式滚动条：固定绑定到内容区
    const contextBar = makeScrollbarHandler(contentContainer, contextScrollbar);
    contentContainer.addEventListener('scroll', contextBar.handler);

    // 单消息模式滚动条：.context-single-scroll 每次 renderSingle 都会重建，需在重建后重新绑定
    let singleBar = null;
    let singleScrollEl = null;
    const bindSingleScrollbar = () => {
        const scrollEl = singleView.querySelector('.context-single-scroll');
        if (!scrollEl) return;
        if (scrollEl === singleScrollEl) {
            singleBar?.handler();
            return;
        }
        if (singleBar) singleBar.clear();
        singleScrollEl = scrollEl;
        singleBar = makeScrollbarHandler(scrollEl, singleScrollbar);
        scrollEl.addEventListener('scroll', singleBar.handler);
        singleBar.handler();
    };

    // --- 渲染：上下文列表模式（原有逻辑） ---
    messages.forEach((msgData, index) => {
        if (msgData && msgData.message) {
            const isHighlighted = (index === highlightedIndex);
            contentContainer.insertAdjacentHTML('beforeend', renderContextMessage(msgData, isHighlighted, chatContextForAvatar, isHighlighted ? targetSwipeId : null));
        }
    });
    renderIframesInElement($(contentContainer));

    // --- 渲染：单消息居中模式 ---
    // 记忆内心独白的展开状态，切换 swipe 后恢复，避免被打断
    let reasoningWasOpen = false;
    function renderSingle() {
        if (!highlightedMsgData) return;
        const prevDetails = singleView.querySelector('.fav-reasoning-details');
        if (prevDetails) reasoningWasOpen = prevDetails.hasAttribute('open');

        const activeSwipeId = favoritedSwipeIds.length > 0 ? favoritedSwipeIds[currentSwipeIndex] : targetSwipeId;
        singleView.innerHTML = renderSingleContextMessage(highlightedMsgData, chatContextForAvatar, activeSwipeId, favoritedSwipeIds, currentSwipeIndex);
        renderIframesInElement($(singleView));

        if (reasoningWasOpen) {
            const newDetails = singleView.querySelector('.fav-reasoning-details');
            if (newDetails) newDetails.setAttribute('open', '');
        }

        // 同步右上角 swipe 控制器的显隐与计数
        updateSwipeControl();

        // 滚动容器已重建，重新绑定单消息模式的滚动条
        bindSingleScrollbar();
    }
    renderSingle();

    // 右上角 swipe 控制器：仅在收藏了多个 swipe 时显示
    function updateSwipeControl() {
        const swipeControl = frameElement.querySelector('.context-swipe-control');
        if (!swipeControl) return;
        const hasMultiSwipe = favoritedSwipeIds && favoritedSwipeIds.length > 1;
        swipeControl.style.display = hasMultiSwipe ? 'flex' : 'none';
        if (hasMultiSwipe) {
            const counter = swipeControl.querySelector('.context-swipe-counter');
            if (counter) counter.textContent = `${currentSwipeIndex + 1} / ${favoritedSwipeIds.length}`;
        }
    }

    // 绑定右上角 swipe 左右切换（事件挂在 header，不会因 singleView 重渲染而丢失）
    const swipeNavLeft = frameElement.querySelector('.context-swipe-nav-left');
    const swipeNavRight = frameElement.querySelector('.context-swipe-nav-right');
    if (swipeNavLeft) {
        swipeNavLeft.addEventListener('click', () => {
            if (!favoritedSwipeIds.length) return;
            currentSwipeIndex = (currentSwipeIndex - 1 + favoritedSwipeIds.length) % favoritedSwipeIds.length;
            renderSingle();
        });
    }
    if (swipeNavRight) {
        swipeNavRight.addEventListener('click', () => {
            if (!favoritedSwipeIds.length) return;
            currentSwipeIndex = (currentSwipeIndex + 1) % favoritedSwipeIds.length;
            renderSingle();
        });
    }

    // 相机按钮：根据当前显示模式截取对应内容（single=单条消息，context=整个上下文列表）
    const cameraBtn = frameElement.querySelector('.context-camera-btn');
    if (cameraBtn) {
        cameraBtn.addEventListener('click', async () => {
            const isSingle = frameElement.getAttribute('data-mode') === 'single';
            const target = isSingle
                ? frameElement.querySelector('.context-single-content')
                : frameElement.querySelector('.context-messages-content');
            if (!target) {
                toastr.warning('没有可截图的内容');
                return;
            }
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const filename = isSingle
                ? `context_message_${timestamp}.png`
                : `context_messages_${timestamp}.png`;
            await captureElementScreenshot(target, filename);
        });
    }

    applySavedTheme();

    // 初始计算两条滚动条位置（列表模式直接绑定，单消息模式经 bindSingleScrollbar 绑定）
    requestAnimationFrame(() => {
        contextBar.handler();
        bindSingleScrollbar();
    });

    // 应用显示模式（控制显隐 + 图标提示）
    function applyMode() {
        frameElement.setAttribute('data-mode', currentMode);
        const toggleEl = frameElement.querySelector('.context-mode-toggle');
        const toggleIcon = toggleEl.querySelector('i');
        if (currentMode === 'single') {
            toggleIcon.className = 'fa-solid fa-table-cells-large';
            toggleEl.title = '切换为上下文列表模式';
        } else {
            toggleIcon.className = 'fa-solid fa-message';
            toggleEl.title = '切换为单消息显示模式';
        }
        // 同步相机按钮提示文案
        const cameraEl = frameElement.querySelector('.context-camera-btn');
        if (cameraEl) {
            cameraEl.title = currentMode === 'single' ? '截图当前消息' : '截图上下文列表';
        }
        // 模式切换后重新计算对应滚动条位置
        requestAnimationFrame(() => {
            contextBar.handler();
            bindSingleScrollbar();
        });
    }
    applyMode();

    frameElement.querySelector('.context-mode-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        currentMode = currentMode === 'single' ? 'context' : 'single';
        extension_settings[PLUGIN_NAME].contextViewMode = currentMode;
        saveSettingsDebounced();
        applyMode();
    });

    setTimeout(() => { frameElement.classList.add('visible'); }, 10);
    frameElement.querySelector('.context-close-btn').addEventListener('click', closeContextFrame);
    frameElement.addEventListener('click', function(e) { if (e.target === this) closeContextFrame(); });
}

/**
 * Closes the context frame.
 */
export function closeContextFrame() {
    const frame = document.getElementById('context-messages-frame');
    if (frame) {
        frame.classList.remove('visible');
        setTimeout(() => {
            frame.remove();
        }, 300);
    }
}

/**
 * Renders a single context message.
 */
export function renderContextMessage(msgData, isHighlighted, chatContext, targetSwipeId = null) {
    const { message, originalIndex } = msgData;
    if (!message) return '';
    const isUser = message.is_user;
    const senderName = message.name || (isUser ? '用户' : '角色');
    const { characters, groups, userAvatar } = getContext();

    let avatarImg = 'img/ai4.png';
    if (isUser) {
        avatarImg = `user_avatars/${userAvatar}`;
    } else {
        if (chatContext && chatContext.isGroup && chatContext.groupId) {
            const group = groups.find(g => g.id === chatContext.groupId);
            if (group && group.avatar && group.avatar !== 'multichar_dummy.png') {
                avatarImg = `groups/${group.avatar}`;
            }
        } else if (chatContext && !chatContext.isGroup && chatContext.characterId !== undefined) {
             const char = characters[chatContext.characterId];
             if (char && char.avatar && char.avatar !== 'multichar_dummy.png') {
                 avatarImg = `characters/${char.avatar}`;
             }
        } else if (message.avatar && message.avatar !== 'multichar_dummy.png') {
             avatarImg = `characters/${message.avatar}`;
        }
    }

    let rawContent = message.mes || '[空消息]';
    if (targetSwipeId !== null && message.swipes && message.swipes[targetSwipeId] !== undefined) {
        rawContent = message.swipes[targetSwipeId];
    }

    let formattedContent = rawContent;
    try {
        formattedContent = messageFormatting(formattedContent, senderName, false, isUser, originalIndex, {}, false);
    } catch (error) {
        formattedContent = `<div class="formatting-error">${rawContent}</div>`;
    }

    const messageClass = isUser ? 'user-message' : 'ai-message';
    const highlightClass = isHighlighted ? 'highlighted-message' : '';

    // 直接检查并生成推理内容的HTML
    let reasoningHtml = '';
    if (message && message.extra && message.extra.reasoning) {
        // 使用SillyTavern核心的 messageFormatting 函数来正确渲染Markdown
        const reasoningContent = messageFormatting(message.extra.reasoning, null, false, false, null, {}, false);

        reasoningHtml = `
            <details class="fav-reasoning-details">
                <summary class="fav-reasoning-summary">
                    <span>内心独白</span>
                    <i class="fa-solid fa-chevron-down reasoning-arrow"></i>
                </summary>
                <div class="fav-reasoning-content">${reasoningContent}</div>
            </details>
        `;
    }

    return `
            <div class="context-message-wrapper ${messageClass} ${highlightClass}" mesid="${originalIndex}">
                <div class="context-message-avatar"><img src="${avatarImg}" alt="${senderName}" onerror="this.src='img/ai4.png'"></div>
                <div class="context-message-bubble">
                    <div class="context-message-name">${senderName}</div>

                    ${reasoningHtml} <!-- 在这里插入推理内容 -->

                    <div class="context-message-text">${formattedContent}</div>
                </div>
            </div>`;
}

/**
 * Renders a single context message in the "single message" centered layout.
 * 布局：头像(第一行居中) → 名称(第二行居中) → 内心独白(第三行左对齐) → 正文(第四行) → 时间(底部斜体灰色)。
 * 多个被收藏的 swipe 时附带左右切换箭头。
 */
export function renderSingleContextMessage(msgData, chatContext, swipeId, favoritedSwipeIds = [], currentSwipeIndex = 0) {
    const { message, originalIndex } = msgData;
    if (!message) return '';
    const isUser = message.is_user;
    const senderName = message.name || (isUser ? '用户' : '角色');
    const { characters, groups, userAvatar } = getContext();

    // 头像计算（与 renderContextMessage 保持一致）
    let avatarImg = 'img/ai4.png';
    if (isUser) {
        avatarImg = `user_avatars/${userAvatar}`;
    } else {
        if (chatContext && chatContext.isGroup && chatContext.groupId) {
            const group = groups.find(g => g.id === chatContext.groupId);
            if (group && group.avatar && group.avatar !== 'multichar_dummy.png') {
                avatarImg = `groups/${group.avatar}`;
            }
        } else if (chatContext && !chatContext.isGroup && chatContext.characterId !== undefined) {
            const char = characters[chatContext.characterId];
            if (char && char.avatar && char.avatar !== 'multichar_dummy.png') {
                avatarImg = `characters/${char.avatar}`;
            }
        } else if (message.avatar && message.avatar !== 'multichar_dummy.png') {
            avatarImg = `characters/${message.avatar}`;
        }
    }

    // 正文（支持指定 swipe）
    let rawContent = message.mes || '[空消息]';
    if (swipeId !== null && swipeId !== undefined && message.swipes && message.swipes[swipeId] !== undefined) {
        rawContent = message.swipes[swipeId];
    }
    let formattedContent = rawContent;
    try {
        formattedContent = messageFormatting(formattedContent, senderName, false, isUser, originalIndex, {}, false);
    } catch (error) {
        formattedContent = `<div class="formatting-error">${rawContent}</div>`;
    }

    // 内心独白（左对齐，可折叠）
    let reasoningHtml = '';
    if (message && message.extra && message.extra.reasoning) {
        const reasoningContent = messageFormatting(message.extra.reasoning, null, false, false, null, {}, false);
        reasoningHtml = `
            <details class="fav-reasoning-details">
                <summary class="fav-reasoning-summary">
                    <span>内心独白</span>
                    <i class="fa-solid fa-chevron-down reasoning-arrow"></i>
                </summary>
                <div class="fav-reasoning-content">${reasoningContent}</div>
            </details>
        `;
    }

    // 时间（底部，斜体灰色）
    let timeString = '';
    if (message.send_date) {
        try {
            timeString = timestampToMoment(message.send_date).format('YYYY-MM-DD HH:mm');
        } catch (e) {
            timeString = '';
        }
    }

    // 正文内时间行（跟随滚动，左右带浅灰横线）；无时间则不渲染
    const timeRowHtml = timeString
        ? `<div class="context-single-time-row">
                <span class="context-time-line"></span>
                <span class="context-single-time">${timeString}</span>
                <span class="context-time-line"></span>
           </div>`
        : '';

    return `
        <div class="context-single-content">
            <div class="context-single-scroll">
                <div class="context-single-avatar"><img src="${avatarImg}" alt="${senderName}" onerror="this.src='img/ai4.png'"></div>
                <div class="context-single-name">${senderName}</div>
                ${reasoningHtml}
                <div class="context-single-text">${formattedContent}</div>
                ${timeRowHtml}
            </div>
        </div>
    `;
}

/**
 * Scrolls to a specific message in the chat.
 */
export function scrollToMessage(messageId, alignment = 'start', behavior = 'auto', timeout = 150) {
    setTimeout(() => {
        const chatEl = document.getElementById('chat');
        const targetEl = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!chatEl || !targetEl) return;
        if (chatEl.scrollHeight <= chatEl.clientHeight) return;
        const chatRect = chatEl.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        let targetScrollTop;
        const currentScrollTop = chatEl.scrollTop;
        const relativeOffset = targetRect.top - chatRect.top;
        if (alignment === 'start') targetScrollTop = currentScrollTop + relativeOffset;
        else if (alignment === 'center') targetScrollTop = currentScrollTop + relativeOffset - (chatEl.clientHeight - targetEl.offsetHeight) / 2;
        else targetScrollTop = currentScrollTop + relativeOffset - (chatEl.clientHeight - targetEl.offsetHeight);
        targetScrollTop = Math.max(0, Math.min(targetScrollTop, chatEl.scrollHeight - chatEl.clientHeight));
        if (Math.abs(chatEl.scrollTop - targetScrollTop) < 2) return;
        chatEl.scrollTo({ top: targetScrollTop, behavior: behavior });
    }, timeout);
}

/**
 * Enters preview mode for a specific message.
 */
export async function enterPreviewMode(messageId, chatFileNoExt) {
    Logger.info(`进入预览模式: msgId=${messageId}, chatFile=${chatFileNoExt}`);
    const { closeFavoritesModal } = await import('./main.js');
    closeFavoritesModal();
    state.isPreviewingContext = true;

    const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileNoExt);
    if (!chatData || !chatData.messages) {
        Logger.error('进入预览模式失败: 无法加载聊天数据');
        toastr.error('无法加载预览上下文的消息。');
        state.isPreviewingContext = false;
        return;
    }

    const messagesArray = chatData.messages;
    const msgIndex = parseInt(messageId, 10);
    if (isNaN(msgIndex) || msgIndex < 0 || msgIndex >= messagesArray.length) {
        toastr.error(`无效的消息索引: ${messageId}`);
        state.isPreviewingContext = false;
        return;
    }

    const totalMessagesToShow = Math.min(messagesArray.length, 5);
    const targetIndexInSlice = msgIndex - Math.max(0, msgIndex - 2);
    const startIndex = Math.max(0, msgIndex - targetIndexInSlice);
    const endIndex = Math.min(messagesArray.length, startIndex + totalMessagesToShow);
    const contextMessages = messagesArray.slice(startIndex, endIndex);

    // --- MODIFIED LOGIC: Use a class to control the state ---
    $('#form_sheld').addClass('star-preview-active');

    const container = document.getElementById('favorites-preview-container');
    if (container) {
        container.style.display = 'flex';
        container.style.opacity = '1';
        container.style.pointerEvents = 'auto';
    }

    $('#top-bar').hide();
    $('#top-settings-holder').hide();

    _setupPreviewAutoHide();

    const context = getContext();
    const originalAutoScroll = context.auto_scroll;
    context.auto_scroll = false;

    try {
        $('#chat').empty();
        for (let i = 0; i < contextMessages.length; i++) {
            const message = contextMessages[i];
            if (!message.swipes) message.swipes = [];
            const originalIndexInSourceChat = startIndex + i;
            addOneMessage(message, { forceId: originalIndexInSourceChat });
            const $newMessageElement = $(`#chat .mes[mesid="${originalIndexInSourceChat}"]`);
            if ($newMessageElement.length) {
                const { renderIframesInElement: _renderIframes } = await import('./main.js');
                _renderIframes($newMessageElement);
            }
        }

        // 在预览模式下也添加收藏图标
        addFavoriteIconsToMessages();

        // 更新收藏图标状态，使用预览的聊天数据
        if (chatData && chatData.metadata && Array.isArray(chatData.metadata.favorites)) {
            $('#chat').find('.mes').each(function() {
                const messageId = $(this).attr('mesid');
                if (messageId) {
                    const isFavorited = chatData.metadata.favorites.some(fav => fav.messageId === messageId);
                    const toggleIcon = $(this).find('.favorite-toggle-icon');
                    if (toggleIcon.length) {
                        toggleIcon.toggleClass('favorited', isFavorited);
                    }
                }
            });
        }

        scrollToMessage(messageId, 'start', 'auto', 150);
    } finally {
        context.auto_scroll = originalAutoScroll;
    }
}

/**
 * Exits preview mode and restores the chat.
 */
export async function exitPreviewMode() {
    if (!state.isPreviewingContext) return;

    Logger.info('退出预览模式');
    _teardownPreviewAutoHide();

    const container = document.getElementById('favorites-preview-container');
    if (container) container.style.display = 'none';

    // 退出预览模式时清除截图选择状态
    state.screenshotSelection = null;

    // --- MODIFIED LOGIC: Just remove the class, CSS will do the rest ---
    $('#form_sheld').removeClass('star-preview-active');

    $('#top-bar').css('display', 'flex');
    $('#top-settings-holder').css('display', 'flex');

    await reloadCurrentChat();
    state.isPreviewingContext = false;
    setTimeout(refreshFavoriteIconsInView, 200);
}

/**
 * Sets up the preview mode UI elements.
 */
export function setupPreviewModeUI() {
    // 创建按钮容器（固定在右侧）
    let container = document.getElementById('favorites-preview-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'favorites-preview-container';
        document.body.appendChild(container);
    }

    if (!document.getElementById('favorites-preview-toggle')) {
        state.previewToggleElement = document.createElement('div');
        state.previewToggleElement.id = 'favorites-preview-toggle';
        state.previewToggleElement.innerHTML = '<i class="fa-solid fa-eye"></i>';
        state.previewToggleElement.title = '打开收藏面板';
        state.previewToggleElement.addEventListener('click', () => openFavoritesModal());
        container.appendChild(state.previewToggleElement);
    }

    // 创建截图按钮（位于预览按钮正下方，圆框大小一致）
    if (!document.getElementById('favorites-screenshot-toggle')) {
        state.screenshotToggleElement = document.createElement('div');
        state.screenshotToggleElement.id = 'favorites-screenshot-toggle';
        state.screenshotToggleElement.innerHTML = '<i class="fa-solid fa-camera"></i>';
        state.screenshotToggleElement.title = '截图预览消息';
        state.screenshotToggleElement.addEventListener('click', async () => {
            const result = await showScreenshotPopup();
            if (result && result.length > 0) {
                captureScreenshotMessages(result);
            }
        });
        container.appendChild(state.screenshotToggleElement);
    }

    // --- MODIFIED LOGIC ---
    // 寻找正确的挂载点
    const formSheld = document.getElementById('form_sheld');
    if (!formSheld) {
        Logger.error('#form_sheld not found! Cannot attach exit preview button.');
        return;
    }

    if (!document.getElementById(PREVIEW_EXIT_BUTTON_ID)) {
        state.previewExitButtonElement = document.createElement('button');
        state.previewExitButtonElement.id = PREVIEW_EXIT_BUTTON_ID;
        state.previewExitButtonElement.className = 'menu_button';
        state.previewExitButtonElement.textContent = '结束预览';
        state.previewExitButtonElement.addEventListener('click', exitPreviewMode);

        // **将按钮添加到 #form_sheld 而不是 body**
        formSheld.appendChild(state.previewExitButtonElement);
    }

}

/**
 * 构建某条消息所有被收藏的 swipe id 列表。
 * 优先复用已缓存的虚拟收藏（保证顺序与收藏列表一致），否则回退到从底层 swipe_info 重建。
 */
function buildFavoritedSwipeIds(messagesArray, msgIndex, chatFileNoExt) {
    // 优先复用已构建的虚拟收藏，顺序与收藏面板导航完全一致
    const cachedChatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileNoExt);
    if (cachedChatData && Array.isArray(cachedChatData.favorites)) {
        const favItem = cachedChatData.favorites.find(f => String(f.messageId) === String(msgIndex));
        if (favItem && Array.isArray(favItem.favoritedSwipes) && favItem.favoritedSwipes.length > 0) {
            return favItem.favoritedSwipes.map(s => String(s.swipeId));
        }
    }
    // 回退：从底层 swipe_info 重建
    const result = [];
    const message = messagesArray[msgIndex];
    if (message && message.swipe_info) {
        for (let sId = 0; sId < message.swipe_info.length; sId++) {
            if (message.swipe_info[sId] && message.swipe_info[sId].star_favorite) {
                result.push(String(sId));
            }
        }
    }
    return result;
}

/**
 * Handles viewing the context of a message.
 */
export async function handleViewContext(messageId, chatFileNoExt, targetSwipeId = null) {
    Logger.debug(`查看上下文: msgId=${messageId}, chatFile=${chatFileNoExt}, swipeId=${targetSwipeId}`);
    try {
        const context = getContext();
        let messagesArray = [];
        let chatContextForAvatar = null;

        const chatData = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileNoExt);

        if (chatData) {
            messagesArray = chatData.messages || [];
            chatContextForAvatar = {
                isGroup: chatData.isGroup,
                characterId: chatData.characterId,
                groupId: chatData.groupId,
            };
        } else {
            const isCurrentChat = String(context.chatId || '').replace('.jsonl', '') === chatFileNoExt;
            if (isCurrentChat) {
                messagesArray = context.chat || [];
                chatContextForAvatar = { isGroup: !!context.groupId, characterId: context.characterId, groupId: context.groupId };
            } else {
                 const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNoExt, !!context.groupId);
                if (fullChatData && Array.isArray(fullChatData.messages)) {
                    messagesArray = fullChatData.messages;
                    chatContextForAvatar = { isGroup: !!context.groupId, characterId: context.characterId, groupId: context.groupId };
                } else {
                    toastr.error('无法获取消息上下文');
                    return;
                }
            }
        }

        const msgIndex = parseInt(messageId, 10);
        if (isNaN(msgIndex) || msgIndex < 0 || msgIndex >= messagesArray.length) {
            toastr.error(`消息索引无效: ${messageId}`);
            return;
        }

        // --- NEW LOGIC: Get context based on settings ---
        // 确保设置存在
        if (!extension_settings[PLUGIN_NAME]) {
            extension_settings[PLUGIN_NAME] = {};
        }
        const range = extension_settings[PLUGIN_NAME].contextViewRange ?? 1;
        const contextMessages = [];

        // 1. Get previous messages
        for (let i = range; i >= 1; i--) {
            const prevIndex = msgIndex - i;
            if (prevIndex >= 0) {
                contextMessages.push({ message: messagesArray[prevIndex], originalIndex: prevIndex });
            }
        }

        // 2. Add the highlighted message and record its index in the new array
        const highlightedIndex = contextMessages.length;
        contextMessages.push({ message: messagesArray[msgIndex], originalIndex: msgIndex });

        // 3. Get next messages
        for (let i = 1; i <= range; i++) {
            const nextIndex = msgIndex + i;
            if (nextIndex < messagesArray.length) {
                contextMessages.push({ message: messagesArray[nextIndex], originalIndex: nextIndex });
            }
        }
        // --- END NEW LOGIC ---

        showContextMessagesFrame(contextMessages, highlightedIndex, chatContextForAvatar, targetSwipeId, buildFavoritedSwipeIds(messagesArray, msgIndex, chatFileNoExt));

    } catch (error) {
        Logger.error('查看消息上下文时出错:', error);
        toastr.error('查看消息上下文时发生错误');
    }
}
