// index.js (Combined & Refactored Version with Theme Toggle & Performance Optimization)

// --- SillyTavern Core Imports ---
// =================================================================
//                      UPDATE CHECKER CONSTANTS & STATE
// =================================================================
const GITHUB_REPO = 'yuncengfeihou/star';
const LOCAL_VERSION = '2.0.6';
const REMOTE_CHANGELOG_PATH = 'CHANGELOG.md';
const REMOTE_MANIFEST_PATH = 'manifest.json';

let remoteVersion = '0.0.0';
let latestCommitHash = '';
let isUpdateAvailable = false;
let changelogForModal = ''; // 用于在更新后存储日志内容

// --- SillyTavern Core Imports ---
import {
    eventSource,
    event_types,
    messageFormatting,
    addOneMessage, // For rendering single messages
    reloadCurrentChat, // For restoring the chat
    chat,
    clearChat,
    openCharacterChat,
    renameChat,
    getRequestHeaders,
    saveSettingsDebounced,
    characters,
} from '../../../../script.js';

// --- Extension Helper Imports ---
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
    saveMetadataDebounced,
} from '../../../extensions.js';

// --- Utility Imports ---
import {
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
    Popup,
} from '../../../popup.js';
import { openGroupChat } from "../../../group-chats.js";
import {
    uuidv4,
    timestampToMoment,
    waitUntilCondition,
} from '../../../utils.js';

// =================================================================
//                      UI REFACTOR CONSTANTS
// =================================================================
const pluginName = 'star';
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

// =================================================================
//                      MODAL STATE & REFERENCES
// =================================================================
let favDoc = document; // Use a consistent document reference
const messageButtonHtml = `
    <div class="mes_button favorite-toggle-icon interactable" title="收藏/取消收藏 (长按编辑备注)" tabindex="0">
        <i class="fa-regular fa-star"></i>
    </div>
`;

// =================================================================
//                      UPDATE CHECKER LOGIC
// =================================================================

/**
 * 比较两个版本号 (例如 "1.2.3" vs "1.2.4")。
 * @returns {number} 1 (A > B), -1 (A < B), 0 (A === B)
 */
function compareVersions(versionA, versionB) {
    const cleanA = String(versionA).split('-')[0].split('+')[0];
    const cleanB = String(versionB).split('-')[0].split('+')[0];
    const partsA = cleanA.split('.').map(Number);
    const partsB = cleanB.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const numA = partsA[i] || 0;
        const numB = partsB[i] || 0;
        if (isNaN(numA) || isNaN(numB)) return 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

/**
 * 从 GitHub API 获取最新的 commit hash。
 */
async function getLatestCommitHash() {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/commits/main`;
    try {
        const response = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json' }, cache: 'no-store' });
        if (!response.ok) throw new Error(`GitHub API error! status: ${response.status}`);
        const data = await response.json();
        if (!data.sha) throw new Error('Invalid response from GitHub API, "sha" not found.');
        return data.sha;
    } catch (error) {
        console.error(`[${pluginName}] Failed to fetch latest commit hash:`, error);
        throw error;
    }
}

/**
 * 使用 commit hash 从 jsDelivr 获取远程文件内容。
 */
async function getRemoteFileContent(filePath, commitHash) {
    const url = `https://cdn.jsdelivr.net/gh/${GITHUB_REPO}@${commitHash}/${filePath}`;
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`jsDelivr error! status: ${response.status}`);
        return await response.text();
    } catch (error) {
        console.error(`[${pluginName}] Failed to fetch remote file ${filePath}:`, error);
        throw error;
    }
}

/**
 * 从 manifest.json 内容中解析版本号。
 */
function parseVersionFromManifest(content) {
    try {
        const manifest = JSON.parse(content);
        return manifest?.version || '0.0.0';
    } catch (error) {
        return '0.0.0';
    }
}

/**
 * 从完整的 changelog 中提取与本次更新相关的内容。
 */
function extractRelevantChangelog(changelogContent, currentVersion, latestVersion) {
    try {
        const startMarker = `## [${latestVersion}]`;
        const startIndex = changelogContent.indexOf(startMarker);
        if (startIndex === -1) return "无法找到最新版本的更新日志。";
        const endMarker = `## [${currentVersion}]`;
        let endIndex = changelogContent.indexOf(endMarker, startIndex);
        if (endIndex === -1) endIndex = changelogContent.length;
        return changelogContent.substring(startIndex, endIndex).trim();
    } catch (error) {
        console.error("Error extracting changelog:", error);
        return "解析更新日志失败。";
    }
}

/**
 * 检查是否有更新，并更新UI指示器。
 */
async function checkForUpdates() {
    try {
        latestCommitHash = await getLatestCommitHash();
        const remoteManifest = await getRemoteFileContent(REMOTE_MANIFEST_PATH, latestCommitHash);
        remoteVersion = parseVersionFromManifest(remoteManifest);
        isUpdateAvailable = compareVersions(remoteVersion, LOCAL_VERSION) > 0;

        if (isUpdateAvailable) {
            $('#favorites_update_button').show();
        }
    } catch (error) {
        console.error(`[${pluginName}] Update check failed:`, error);
        $('#favorites_update_button').hide();
    }
}

/**
 * 处理整个更新流程：显示日志 -> 确认 -> 调用API -> 刷新。
 */
async function handleUpdate() {
    let updatingToast = null;
    try {
        const changelog = await getRemoteFileContent(REMOTE_CHANGELOG_PATH, latestCommitHash);
        const relevantLog = extractRelevantChangelog(changelog, LOCAL_VERSION, remoteVersion);

        // 将日志保存到变量，以便更新后在模态框中显示
        changelogForModal = relevantLog;

        const logHtml = relevantLog.replace(/### (.*)/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

        const popupResult = await callGenericPopup(
            `<h3>发现新版本: ${remoteVersion}</h3><hr><div style="text-align:left; max-height: 300px; overflow-y: auto;">${logHtml}</div>`,
            'confirm',
            { okButton: '立即更新', cancelButton: '稍后' }
        );

        if (!popupResult) {
            toastr.info("更新已取消。");
            return;
        }

        updatingToast = toastr.info("正在请求后端更新插件，请不要关闭或刷新页面...", "正在更新", {
            timeOut: 0, extendedTimeOut: 0, tapToDismiss: false,
        });

        const response = await fetch("/api/extensions/update", {
            method: "POST",
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: pluginName, // 后端API v2 使用 'extension' 键
                global: true, // 假设这是一个全局插件
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`更新失败，服务器返回状态: ${response.status}. 详情: ${errorText}`);
        }

        const result = await response.json();

        if (result.isUpToDate) {
            toastr.warning("插件已经是最新版本。");
        } else {
            // 在刷新前，将新版本号存入设置，以便刷新后显示更新日志
            extension_settings[pluginName].lastSeenVersion = LOCAL_VERSION; // 存入旧版本号
            saveSettingsDebounced(); // 确保保存

            toastr.success(`更新成功！3秒后将自动刷新页面...`, "更新完成", { timeOut: 3000 });
            setTimeout(() => location.reload(), 3000);
        }

    } catch (error) {
        if (error.message && error.message.includes("更新失败")) {
            toastr.error(error.message, '更新出错');
        }
    } finally {
        if (updatingToast) {
            toastr.clear(updatingToast);
        }
    }
}

/**
 * 检查当前版本是否为新版本（即是否需要显示更新日志）。
 */
function shouldShowUpdateNotice() {
    // Make sure the setting exists before comparing
    if (!extension_settings[pluginName] || !extension_settings[pluginName].lastSeenVersion) {
        return false;
    }
    return compareVersions(LOCAL_VERSION, extension_settings[pluginName].lastSeenVersion) > 0;
}

/**
 * 将更新标记为已读，并隐藏通知。
 */
function markUpdateAsSeen() {
    if (shouldShowUpdateNotice()) {
        extension_settings[pluginName].lastSeenVersion = LOCAL_VERSION;
        saveSettingsDebounced();
        const noticeEl = favDoc.getElementById('favorites_update_notice');
        if (noticeEl) noticeEl.style.display = 'none';
    }
}

/**
 * 在收藏夹模态框中显示更新日志。
 */
async function displayUpdateNoticeInModal() {
    const noticeEl = favDoc.getElementById('favorites_update_notice');
    if (!noticeEl) return;

    try {
        // 如果 changelogForModal 为空（例如页面刷新后），则重新获取
        if (!changelogForModal) {
            const hash = await getLatestCommitHash();
            const fullLog = await getRemoteFileContent(REMOTE_CHANGELOG_PATH, hash);
            changelogForModal = extractRelevantChangelog(fullLog, extension_settings[pluginName].lastSeenVersion, LOCAL_VERSION);
        }

        const logHtml = changelogForModal.replace(/### (.*)/g, '<strong>$1</strong>').replace(/\n/g, '<br>');

        noticeEl.innerHTML = `
            <div style="border: 1px solid #4a9eff; background: rgba(74, 158, 255, 0.1); padding: 15px; margin: 10px; border-radius: 8px;">
                <h4 style="margin-top:0; color:#4a9eff;">Star 插件已更新至 v${LOCAL_VERSION}</h4>
                <div style="max-height: 200px; overflow-y: auto;">${logHtml}</div>
                <p style="font-size: 0.8em; color: #888; text-align: center; margin-top: 10px;">此消息仅显示一次。</p>
            </div>
        `;
        noticeEl.style.display = 'block';
    } catch (error) {
        console.error(`[${pluginName}] Failed to display update notice:`, error);
        noticeEl.style.display = 'none';
    }
}

let modalElement = null;
let modalDialogElement = null;
let modalTitleElement = null;
let modalBodyElement = null;

// =================================================================
//                      PLUGIN-SPECIFIC STATE
// =================================================================
if (!extension_settings[pluginName]) {
    extension_settings[pluginName] = {};
}
if (!extension_settings[pluginName].chatNotes) {
    extension_settings[pluginName].chatNotes = {};
}

// --- Data & Pagination State ---
let currentPage = 1;
const itemsPerPage = 5;
let currentViewingChatFile = null; // chat file name without .jsonl
let allChatsFavoritesData = [];    // Cache for all chats and their favorites
let chatListScrollTop = 0;
let isLoadingOtherChats = false; // Flag to prevent multiple background loads

// --- Preview Mode State ---
let isPreviewingContext = false;
let previewToggleElement = null;
let previewExitButtonElement = null;

// =================================================================
//                      UI STYLES (getFavoritesStyles)
// =================================================================
function getFavoritesStyles() {
    // All styles have been moved to the external style.css file.
    return ``;
}

// =================================================================
//                      THEME TOGGLE & USAGE GUIDE
// =================================================================
/**
 * Toggles the theme between light and dark, saving the choice to localStorage.
 */
function toggleTheme() {
    if (!modalDialogElement) return;

    const isDark = modalDialogElement.classList.toggle('dark-theme');
    
    const contextContainer = document.querySelector('.context-messages-container');
    if (contextContainer) {
        contextContainer.classList.toggle('dark-theme', isDark);
    }
    
    localStorage.setItem('favorites-theme', isDark ? 'dark' : 'light');
    toastr.info(isDark ? '已切换至暗色主题' : '已切换至白天主题', '', { timeOut: 1500 });
}

/**
 * Applies the saved theme from localStorage when the modal or context viewer opens.
 */
function applySavedTheme() {
    const savedTheme = localStorage.getItem('favorites-theme');
    const isDark = savedTheme === 'dark';

    if (modalDialogElement) {
        modalDialogElement.classList.toggle('dark-theme', isDark);
    }
    
    const contextContainer = document.querySelector('.context-messages-container');
    if (contextContainer) {
        contextContainer.classList.toggle('dark-theme', isDark);
    }
}

/**
 * REFACTORED: Shows the custom-built options menu using a robust, JS-centered approach.
 * This menu is dynamically created, centered with JS, and safely destroyed.
 */
function showAvatarLongPressMenu() {
    // 1. Prevent creating multiple menus
    if (document.getElementById('star-options-menu-overlay')) return;

    // 2. Dynamically create elements, just like the reference script
    const overlay = document.createElement('div');
    overlay.id = 'star-options-menu-overlay';

    const menuDialog = document.createElement('div');
    menuDialog.id = 'star-options-menu-dialog'; // Give it an ID for easier selection
    menuDialog.className = 'star-options-menu-dialog';
    
    // Apply theme from main modal
    if (modalDialogElement && modalDialogElement.classList.contains('dark-theme')) {
        menuDialog.classList.add('dark-theme');
    }

    menuDialog.innerHTML = `
        <div class="star-options-menu-header">选项</div>
        <div class="star-options-menu-body">
            <div class="star-options-menu-item" data-action="toggle-theme">
                <i class="fa-solid fa-palette"></i>
                <span>切换主题</span>
            </div>
            <div class="star-options-menu-item" data-action="usage-guide">
                <i class="fa-solid fa-book-open"></i>
                <span>使用说明</span>
            </div>
        </div>
    `;

    // 3. Append to body, making them independent siblings
    document.body.appendChild(overlay);
    document.body.appendChild(menuDialog);

    // 4. Create the JS-based centering function, copied from the reference script's pattern
    const centerMenu = () => {
        if (!menuDialog) return;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        menuDialog.style.left = `${Math.max(0, (windowWidth - menuDialog.offsetWidth) / 2)}px`;
        menuDialog.style.top = `${Math.max(0, (windowHeight - menuDialog.offsetHeight) / 2)}px`;
    };
    
    // Center it now and bind listener for window resize
    centerMenu();
    window.addEventListener('resize', centerMenu);

    // 5. Create a robust cleanup function to remove elements and listeners
    const closeMenu = () => {
        const menuToRemove = document.getElementById('star-options-menu-dialog');
        const overlayToRemove = document.getElementById('star-options-menu-overlay');
        
        if (menuToRemove) menuToRemove.remove();
        if (overlayToRemove) overlayToRemove.remove();

        // IMPORTANT: Clean up the resize listener to prevent memory leaks
        window.removeEventListener('resize', centerMenu);
        // Also remove the listeners on the parent modal
        if (modalElement) {
             modalElement.querySelector(`.${MODAL_CLOSE_X_CLASS}`).removeEventListener('click', closeMenu);
             modalElement.removeEventListener('click', checkParentOverlayClick);
        }
    };

    // 6. Bind close events
    overlay.addEventListener('click', closeMenu);

    menuDialog.addEventListener('click', (e) => {
        const item = e.target.closest('.star-options-menu-item');
        if (!item) return;

        const action = item.dataset.action;
        closeMenu(); // Close the menu AFTER an action is chosen

        if (action === 'toggle-theme') {
            toggleTheme();
        } else if (action === 'usage-guide') {
            setTimeout(showUsageGuidePopup, 100);
        }
    });

    // 7. BUG FIX: Ensure the options menu closes when the main modal is closed
    const checkParentOverlayClick = (e) => {
        if (e.target === modalElement) {
            closeMenu();
        }
    };
    modalElement.querySelector(`.${MODAL_CLOSE_X_CLASS}`).addEventListener('click', closeMenu);
    modalElement.addEventListener('click', checkParentOverlayClick);
}

/**
 * REFACTORED: Shows the usage guide popup with only a "Close" button.
 */
function showUsageGuidePopup() {
    const guideHtml = `
        <div style="text-align: left; max-height: 70vh; overflow-y: auto; padding-right: 10px;">
            <h4><i class="fa-regular fa-star"></i> 基本操作</h4>
            <ul>
				<li>如果觉得文字太繁琐可以直接滑动查看视频示例。</li>
                <li><strong>收藏/取消收藏:</strong> 单击消息右上角的 <i class="fa-regular fa-star"></i> 图标。图标变为实心 <i class="fa-solid fa-star"></i> 代表收藏成功。</li>
                <li><strong>编辑备注:</strong> 长按消息右上角的 <i class="fa-solid fa-star"></i> 图标，可以为这条收藏添加或修改备注，无需打开收藏面板。</li>
            </ul>

            <h4><i class="fa-solid fa-folder-open"></i> 收藏管理面板</h4>
            <ul>
                <li><strong>打开面板:</strong> 点击输入框下方的 "收藏" 按钮。</li>
                <li><strong>切换聊天历史:</strong> 点击左上角的头像可以打开/关闭左侧边栏。点击不同聊天可以在它们之间切换，查看各自的收藏。</li>
                <li><strong>搜索:</strong> 点击右上角的 <i class="fa-solid fa-magnifying-glass"></i> 图标可展开搜索框，输入关键词检索收藏的消息内容或备注。点击 <i class="fa-solid fa-filter"></i> 图标可切换为仅搜索备注。</li>
                <li><strong>翻页:</strong> 当收藏数量过多时，底部会出现翻页按钮。</li>
            </ul>

            <h4><i class="fa-solid fa-screwdriver-wrench"></i> 收藏项操作</h4>
            <p>在管理面板中，每条收藏的右下角都有一排操作按钮：</p>
            <ul>
                <li><i class="fa-solid fa-eye" title="预览上下文"></i> <strong>预览上下文:</strong> 在主聊天界面临时加载这条消息附近的几条对话，让你快速回顾语境。点击页面底部的“结束预览”可返回正常聊天。</li>
                <li><i class="fa-solid fa-expand" title="查看上下文"></i> <strong>查看上下文:</strong> 弹出一个小窗口，独立显示该消息的前一条、当前条和后一条消息，方便快速查看。</li>
                <li><i class="fa-solid fa-pencil" title="编辑备注"></i> <strong>编辑备注:</strong> 与长按消息图标功能相同。</li>
                <li><i class="fa-solid fa-trash" title="删除收藏"></i> <strong>删除收藏:</strong> 从收藏夹中移除此条目，不会删除原始消息。</li>
            </ul>

            <h4><i class="fa-solid fa-circle-info"></i> 其他技巧</h4>
            <ul>
                <li><strong>主题切换:</strong> 在收藏面板中，长按左上角的角色/群组头像，可以打开菜单切换亮/暗主题。</li>
                <li><strong>更新插件:</strong> 当 "收藏" 按钮旁出现红色的 "可更新" 按钮时，代表插件有新版本。点击它即可查看更新日志并更新。</li>
            </ul>
            <h4><i class="fa-solid fa-circle-info"></i> 视频示例</h4>
            <ul>
                <li><strong>主题切换:</strong> 在收藏面板中，长按左上角的角色/群组头像，可以打开菜单切换亮/暗主题。</li>
                <li><strong>问题反馈:</strong> 如果有任何问题或建议可以直接在旅程检索“聊天收藏器”进入帖子进行反馈！</li>
            </ul>
        </div>
    `;
    
    // THE FIX IS HERE: Added 'cancelButton: false'
    callGenericPopup(guideHtml, 'html', { 
        okButton: '关闭', 
        cancelButton: false 
    });
}


// =================================================================
//                      UI MODAL FUNCTIONS
// =================================================================

function ensureModalStructure() {
    if (modalElement) return;

    modalElement = favDoc.createElement('div');
    modalElement.id = MODAL_ID;
    modalElement.innerHTML = `
        <div class="${MODAL_CLASS_NAME}">
            <div class="${MODAL_HEADER_CLASS}">
                <img id="${SIDEBAR_TOGGLE_ID}" class="${SIDEBAR_TOGGLE_CLASS}" src="img/ai4.png" title="单击切换侧栏 / 长按打开选项">
                <h3 class="${MODAL_TITLE_CLASS}">收藏管理</h3>
                <div class="${SEARCH_CONTAINER_CLASS}">
                    <i class="fa-solid fa-filter ${SEARCH_FILTER_CLASS}" title="仅搜索备注"></i>
                    <input type="text" class="${SEARCH_INPUT_CLASS}" placeholder="检索收藏...">
                    <i class="fa-solid fa-magnifying-glass ${SEARCH_ICON_CLASS}"></i>
                </div>
                <button class="${MODAL_CLOSE_X_CLASS}">×</button>
            </div>
            <div id="favorites_update_notice" style="display:none;"></div>
            <div class="${MODAL_BODY_CLASS}"></div>
        </div>
    `;
    favDoc.body.appendChild(modalElement);

    modalDialogElement = modalElement.querySelector(`.${MODAL_CLASS_NAME}`);
    modalTitleElement = modalElement.querySelector(`.${MODAL_TITLE_CLASS}`);
    modalBodyElement = modalElement.querySelector(`.${MODAL_BODY_CLASS}`);

    // --- Event Listeners ---
    modalElement.querySelector(`.${MODAL_CLOSE_X_CLASS}`).addEventListener('click', closeFavoritesModal);

    // --- MODIFIED: Sidebar Toggle & Long-press Options Menu (with Touch Support) ---
    const avatarToggle = modalElement.querySelector(`.${SIDEBAR_TOGGLE_CLASS}`);
    let longPressTimer;
    let isLongPressAction = false;

    const startPress = (e) => {
        isLongPressAction = false;
        longPressTimer = setTimeout(() => {
            isLongPressAction = true;
            showAvatarLongPressMenu();
        }, 600); // 600ms for long press
    };

    const endPress = () => {
        clearTimeout(longPressTimer);
    };

    // Bind events for both mouse and touch
    avatarToggle.addEventListener('mousedown', startPress);
    avatarToggle.addEventListener('touchstart', startPress, { passive: true });

    avatarToggle.addEventListener('mouseup', endPress);
    avatarToggle.addEventListener('mouseleave', endPress);
    avatarToggle.addEventListener('touchend', endPress);
    avatarToggle.addEventListener('touchcancel', endPress);

    avatarToggle.addEventListener('click', (e) => {
        if (isLongPressAction) {
            e.preventDefault();
            e.stopPropagation();
            return; // Prevent sidebar toggle if it was a long press
        }
        modalDialogElement.classList.toggle('sidebar-closed');
    });

    const searchContainer = modalElement.querySelector(`.${SEARCH_CONTAINER_CLASS}`);
    const searchIcon = modalElement.querySelector(`.${SEARCH_ICON_CLASS}`);
    const searchFilter = modalElement.querySelector(`.${SEARCH_FILTER_CLASS}`);
    const searchInput = modalElement.querySelector(`.${SEARCH_INPUT_CLASS}`);

    searchIcon.addEventListener('click', () => {
        searchContainer.classList.add('expanded');
        searchInput.focus();
    });

    searchInput.addEventListener('blur', () => {
        if (!searchInput.value) {
            searchContainer.classList.remove('expanded');
        }
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

    modalElement.addEventListener('click', (e) => {
        if (e.target === modalElement) {
            closeFavoritesModal();
        }
    });

    modalBodyElement.addEventListener('click', handleModalClick);
}

function handleSearchInModal(query) {
    const searchFilter = modalElement.querySelector(`.${SEARCH_FILTER_CLASS}`);
    const filterByNote = searchFilter.classList.contains('active');
    
    const allItems = modalBodyElement.querySelectorAll('.favorite-item');
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

function centerModal() {
    if (!modalDialogElement) return;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const dialogWidth = modalDialogElement.offsetWidth;
    const dialogHeight = modalDialogElement.offsetHeight;
    modalDialogElement.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
    modalDialogElement.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
}

async function openFavoritesModal() {
    ensureModalStructure();

    // Check for update notice before showing modal
    if (shouldShowUpdateNotice()) {
        await displayUpdateNoticeInModal();
    }

    if (previewToggleElement) previewToggleElement.style.display = 'none';
    applySavedTheme();

    const context = getContext();
    if (!isPreviewingContext) {
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
        const avatarToggle = modalElement.querySelector(`#${SIDEBAR_TOGGLE_ID}`);
        if (avatarToggle) avatarToggle.src = avatarSrc;
    }

    modalElement.style.display = 'block';
    centerModal();
    
    if (isPreviewingContext) {
        // If in preview, we assume data is already loaded and just show the modal
        await renderFavoritesView(currentViewingChatFile);
    } else {
        // --- PERFORMANCE OPTIMIZATION ---
        // 1. Reset state and show a spinner
        currentPage = 1;
        currentViewingChatFile = null;
        allChatsFavoritesData = [];
        isLoadingOtherChats = false;
        modalBodyElement.innerHTML = '<div class="spinner"></div>';
        
        // Reset UI elements
        modalDialogElement.classList.add('sidebar-closed');
        const searchContainer = modalElement.querySelector(`.${SEARCH_CONTAINER_CLASS}`);
        const searchInput = modalElement.querySelector(`.${SEARCH_INPUT_CLASS}`);
        if(searchContainer) searchContainer.classList.remove('expanded');
        if(searchInput) searchInput.value = '';

        // 2. Immediately render the current chat's favorites using getContext()
        await renderFavoritesView();

        // 3. Silently load other chats in the background
        loadOtherChatsInBackground();
    }
    
    requestAnimationFrame(() => {
        modalDialogElement.classList.add('visible');
    });

    window.addEventListener('resize', centerModal);
    favDoc.addEventListener('keydown', handleEscKey);
}

/**
 * REFACTORED: Closes the modal instantly without any fade-out animation.
 */
function closeFavoritesModal() {
    markUpdateAsSeen(); // Mark updates as seen when closing
    
    if (modalElement) {
        // Hide the modal instantly
        modalElement.style.display = 'none';
        
        // Still remove the 'visible' class to keep the state clean for the next opening
        if (modalDialogElement) {
            modalDialogElement.classList.remove('visible');
        }
    }
    
    // Show the preview toggle button if we were in preview mode
    if (isPreviewingContext && previewToggleElement) {
        previewToggleElement.style.display = 'flex';
    }
    
    // Clean up event listeners
    window.removeEventListener('resize', centerModal);
    favDoc.removeEventListener('keydown', handleEscKey);
}

function handleEscKey(event) {
    if (event.key === 'Escape') {
        const contextFrame = document.getElementById('context-messages-frame');
        if (contextFrame && contextFrame.classList.contains('visible')) {
            closeContextFrame();
        } else {
            closeFavoritesModal();
        }
    }
}

// =================================================================
//                  UI RENDERING (OPTIMIZED)
// =================================================================

async function renderFavoritesView(selectedChatFileName = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const selectedChatFileNameNoExt = selectedChatFileName ? String(selectedChatFileName).replace('.jsonl', '') : null;

    // --- OPTIMIZATION: Initial Load Logic ---
    if (allChatsFavoritesData.length === 0) {
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
        allChatsFavoritesData.push(initialData);

        currentViewingChatFile = currentContextChatIdNoExt;
    } else if (selectedChatFileNameNoExt) {
        currentViewingChatFile = selectedChatFileNameNoExt;
    } else {
        // Fallback if something went wrong
        currentViewingChatFile = currentContextChatIdNoExt;
    }

    let viewingChatData = allChatsFavoritesData.find(chatData => String(chatData.fileName).replace('.jsonl', '') === currentViewingChatFile);
    
    // If we clicked a chat that hasn't been loaded by the background task yet
    if (!viewingChatData && !isLoadingOtherChats) {
        modalBodyElement.innerHTML = '<div class="spinner"></div>';
        const fullChatData = await getFullChatData(context.characterId, context.groupId, currentViewingChatFile, !!context.groupId);
        if(fullChatData) {
            viewingChatData = {
                fileName: currentViewingChatFile,
                displayName: currentViewingChatFile,
                ...fullChatData,
                isGroup: !!context.groupId,
                characterId: context.characterId,
                groupId: context.groupId,
            };
            allChatsFavoritesData.push(viewingChatData);
        }
    } else if (!viewingChatData) {
        modalBodyElement.innerHTML = `<div class="favorites-empty">聊天收藏正在加载中...</div>`;
        return;
    }

    const roleName = viewingChatData.isGroup
        ? (context.groups?.find(g => g.id === viewingChatData.groupId)?.name || '未命名群聊')
        : (context.characters[viewingChatData.characterId]?.name || context.name2);
    modalTitleElement.textContent = roleName || '收藏管理';

    const favoritesArray = viewingChatData.metadata?.favorites || [];
    const totalFavorites = favoritesArray.length;

    // --- Render sidebar and main content ---
    renderChatListPanel(); // Update the chat list panel separately
    renderMainPanel(viewingChatData); // Render the main favorites content
}

function renderChatListPanel() {
    let panel = modalBodyElement.querySelector('.favorites-chat-list-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'favorites-chat-list-panel';
        modalBodyElement.prepend(panel);
    }
    
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');

    const chatListItemsHtml = `
        <div class="favorites-chat-list-items">
            ${allChatsFavoritesData.map(chat => {
                const fileNameNoExt = String(chat.fileName).replace('.jsonl', '');
                const favCount = chat.favorites?.length || 0;
                // Show item if it has favorites, or if it's the current chat (even if empty)
                if (favCount === 0 && fileNameNoExt !== currentContextChatIdNoExt) return '';
                
                const isSelected = fileNameNoExt === currentViewingChatFile;
                return `
                    <div class="favorites-chat-list-item ${isSelected ? 'active' : ''}" data-chat-file="${fileNameNoExt}">
                        <div class="chat-list-item-name" title="${chat.displayName || fileNameNoExt}">
                            ${chat.displayName || fileNameNoExt}
                        </div>
                        <div class="chat-list-item-count">${favCount}</div>
                    </div>
                `;
            }).join('')}
            ${isLoadingOtherChats ? '<div class="chat-list-loader">加载中...</div>' : ''}
        </div>
    `;
    panel.innerHTML = chatListItemsHtml;
    
    const chatListElement = panel.querySelector('.favorites-chat-list-items');
    if (chatListElement) chatListElement.scrollTop = chatListScrollTop;
}

function renderMainPanel(viewingChatData) {
    let mainPanel = modalBodyElement.querySelector('.favorites-main-panel');
    if (!mainPanel) {
        mainPanel = document.createElement('div');
        mainPanel.className = 'favorites-main-panel';
        modalBodyElement.appendChild(mainPanel);
    }
    
    const favoritesArray = viewingChatData.metadata?.favorites || [];
    const totalFavorites = favoritesArray.length;
    
    const sortedFavorites = [...favoritesArray].sort((a, b) => parseInt(a.messageId) - parseInt(b.messageId));
    const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalFavorites);
    const currentPageItems = sortedFavorites.slice(startIndex, endIndex);

    let favoritesListHtml = '';
    if (totalFavorites === 0) {
        favoritesListHtml = `<div class="favorites-empty">此聊天没有收藏的消息。</div>`;
    } else {
        const originalChatMessages = viewingChatData.messages || [];
        currentPageItems.forEach((favItem, index) => {
            if (favItem) {
                const messageIndex = parseInt(favItem.messageId, 10);
                let messageForRender = null;
                if (!isNaN(messageIndex) && messageIndex >= 0 && messageIndex < originalChatMessages.length) {
                    messageForRender = originalChatMessages[messageIndex];
                }
                favoritesListHtml += renderFavoriteItem(favItem, startIndex + index, messageForRender);
            }
        });
    }

    const mainPanelHtml = `
        <div class="favorites-list">
            ${favoritesListHtml}
        </div>
        ${totalPages > 1 ? `
            <div class="favorites-pagination">
                <button class="menu_button pagination-prev" ${currentPage === 1 ? 'disabled' : ''}>上一页</button>
                <span>${currentPage} / ${totalPages}</span>
                <button class="menu_button pagination-next" ${currentPage === totalPages ? 'disabled' : ''}>下一页</button>
            </div>
        ` : ''}
    `;
    
    mainPanel.innerHTML = mainPanelHtml;

    const favoritePreviews = mainPanel.querySelectorAll('.fav-preview');
    favoritePreviews.forEach(previewElement => {
        renderIframesInElement($(previewElement));
    });
}

/**
 * NEW: Asynchronously loads favorites from all other chats in the background.
 */
async function loadOtherChatsInBackground() {
    if (isLoadingOtherChats) return;
    isLoadingOtherChats = true;
    renderChatListPanel(); // Show loader in the chat list

    const otherChatsData = await getAllChatFavoritesForCurrentContext(true); // pass true to skip current chat
    
    // Merge results. Avoid duplicates.
    const existingFileNames = new Set(allChatsFavoritesData.map(c => c.fileName));
    otherChatsData.forEach(chatData => {
        if (!existingFileNames.has(chatData.fileName)) {
            allChatsFavoritesData.push(chatData);
        }
    });

    // Sort the final list
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    allChatsFavoritesData.sort((a, b) => {
        if (a.fileName === currentContextChatIdNoExt) return -1;
        if (b.fileName === currentContextChatIdNoExt) return 1;
        return a.fileName.localeCompare(b.fileName);
    });

    isLoadingOtherChats = false;
    renderChatListPanel(); // Re-render the chat list with all items and remove loader
}


function renderFavoriteItem(favItem, index, originalMessage = null) {
    if (!favItem) return '';
    const isUserMessage = originalMessage ? originalMessage.is_user : favItem.role === 'user';
    const roleClass = isUserMessage ? 'role-user' : 'role-ai';
    let previewText = '', deletedClass = '', sendDateString = '', senderName = favItem.sender || '未知';
    if (originalMessage) {
        senderName = originalMessage.name || senderName;
        sendDateString = originalMessage.send_date ? timestampToMoment(originalMessage.send_date).format('YYYY-MM-DD HH:mm') : '[时间未知]';
        try {
            previewText = originalMessage.mes ? messageFormatting(originalMessage.mes, senderName, false, isUserMessage, null, {}, false) : '[消息内容为空]';
        } catch (e) {
            previewText = `[格式化失败] ${originalMessage.mes}`;
        }
    } else {
        previewText = '[原始消息内容不可用或已删除]';
        sendDateString = '[时间不可用]';
        deletedClass = 'deleted';
    }
    const noteHtml = favItem.note ? `<div class="fav-note-content">${favItem.note}</div>` : '<div></div>';
    return `
        <div class="favorite-item ${roleClass}" data-fav-id="${favItem.id}" data-msg-id="${favItem.messageId}">
            <div class="fav-header-info">
                ${noteHtml}
                <div class="fav-meta-cluster">
                    <span class="fav-floor-number">#${favItem.messageId}</span>
                    <div class="fav-send-date">${sendDateString}</div>
                </div>
            </div>
            <div class="fav-preview ${deletedClass}">${previewText}</div>
            <div class="fav-actions">
                <i class="fa-solid fa-eye" title="预览上下文"></i>
                <i class="fa-solid fa-expand" title="查看上下文"></i>
                <i class="fa-solid fa-camera" title="截图（即将推出）"></i>
                <i class="fa-solid fa-pencil" title="编辑备注"></i>
                <i class="fa-solid fa-trash" title="删除收藏"></i>
            </div>
        </div>
    `;
}

// =================================================================
//                   MODAL EVENT HANDLER
// =================================================================
async function handleModalClick(event) {
    const target = event.target;
    const chatListItem = target.closest('.favorites-chat-list-item');
    if (chatListItem) {
        const chatFile = String(chatListItem.dataset.chatFile).replace('.jsonl','');
        if (chatFile && chatFile !== currentViewingChatFile) {
            chatListScrollTop = chatListItem.parentElement.scrollTop;
            currentPage = 1;
            await renderFavoritesView(chatFile);
        }
        return;
    }
    const prevButton = target.closest('.pagination-prev');
    if (prevButton && !prevButton.disabled) {
        if (currentPage > 1) {
            currentPage--;
            await renderFavoritesView(currentViewingChatFile);
        }
        return;
    }
    const nextButton = target.closest('.pagination-next');
    if (nextButton && !nextButton.disabled) {
        const viewingChatData = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl','') === currentViewingChatFile);
        const totalFavorites = viewingChatData?.favorites?.length || 0;
        const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
        if (currentPage < totalPages) {
            currentPage++;
            await renderFavoritesView(currentViewingChatFile);
        }
        return;
    }
    
    const favItemEl = target.closest('.favorite-item');
    if (favItemEl) {
        const favId = favItemEl.dataset.favId;
        const msgId = favItemEl.dataset.msgId;

        if (target.classList.contains('fa-expand')) { 
            await handleViewContext(msgId, currentViewingChatFile);
        } else if (target.classList.contains('fa-pencil')) {
            await handleEditNote(favId, currentViewingChatFile);
        } else if (target.classList.contains('fa-trash')) {
            await handleDeleteFavoriteFromPopup(favId, msgId, currentViewingChatFile);
        } else if (target.classList.contains('fa-eye')) { 
            await enterPreviewMode(msgId, currentViewingChatFile);
        } else if (target.classList.contains('fa-camera')) {
            toastr.info('即将推出截图功能，尽请期待！');
        }
    }
}

// ... (The rest of the functions from renderIframesInElement onwards remain largely the same) ...
// ... I will now paste the remaining functions, with minor adjustments where necessary ...

function renderIframesInElement($container) {
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
                    console.error("Error setting up iframe resizer:", e);
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

// =================================================================
//        CORE LOGIC FUNCTIONS
// =================================================================
function ensureFavoritesArrayExists() {
    let context;
    try {
        context = getContext();
        if (!context || !context.chatMetadata) {
            console.error(`${pluginName}: ensureFavoritesArrayExists - context or context.chatMetadata is not available!`);
            return null;
        }
    } catch (e) {
        console.error(`${pluginName}: ensureFavoritesArrayExists - Error calling getContext():`, e);
        return null;
    }
    const chatMetadata = context.chatMetadata;
    if (!Array.isArray(chatMetadata.favorites)) {
        chatMetadata.favorites = [];
    }
    return chatMetadata;
}

/**
 * REFACTORED: Adds a favorite to the specified chat.
 * This function now ensures a single point of data modification to prevent duplicates.
 */
function addFavorite(messageInfo, targetChatFile = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl','') : (currentViewingChatFile || currentContextChatIdNoExt);
    if (!chatFileToModify) {
        console.error(`${pluginName}: addFavorite - Cannot determine target chat file.`);
        return null;
    }

    // Find the single source of truth: our cache.
    let chatDataInCache = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);

    // This should not happen in a normal flow, but as a fallback.
    if (!chatDataInCache) {
        console.error(`${pluginName}: addFavorite - Chat data for "${chatFileToModify}" not found in cache.`);
        toastr.error('添加收藏失败：找不到聊天缓存。');
        return null;
    }

    // Ensure the favorites array exists
    if (!Array.isArray(chatDataInCache.metadata.favorites)) {
        chatDataInCache.metadata.favorites = [];
    }
    
    // Prevent adding duplicates
    if (chatDataInCache.metadata.favorites.some(fav => String(fav.messageId) === String(messageInfo.messageId))) {
        console.warn(`${pluginName}: Attempted to add a duplicate favorite for messageId ${messageInfo.messageId}.`);
        return chatDataInCache.metadata.favorites.find(fav => String(fav.messageId) === String(messageInfo.messageId));
    }
    
    // Create the new favorite item
    const newItem = {
        id: uuidv4(),
        messageId: messageInfo.messageId,
        sender: messageInfo.sender,
        role: messageInfo.role,
        note: ''
    };
    
    // Add the item to the cache (the single point of modification)
    chatDataInCache.metadata.favorites.push(newItem);
    // Sync the secondary 'favorites' property for consistency
    chatDataInCache.favorites = chatDataInCache.metadata.favorites;

    // Now, propagate the change to other places
    if (chatFileToModify === currentContextChatIdNoExt) {
        // Sync with the live context metadata for the main chat UI
        context.chatMetadata.favorites = chatDataInCache.metadata.favorites;
        saveMetadataDebounced();
    } else {
        // Save to the specific chat file on the backend
        saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, chatDataInCache.messages);
    }
    
    // If the modal is open and viewing the affected chat, re-render it
    if (modalElement && modalElement.style.display === 'block' && currentViewingChatFile === chatFileToModify) {
        renderFavoritesView(currentViewingChatFile);
    }

    return newItem;
}

function addFavoriteLogic(messageInfo, metadata, messages, chatFile, currentContext) {
    if (!Array.isArray(metadata.favorites)) {
        metadata.favorites = [];
    }
    if (metadata.favorites.some(fav => String(fav.messageId) === String(messageInfo.messageId))) {
        console.warn(`${pluginName}: Attempted to add a duplicate favorite for messageId ${messageInfo.messageId}. Aborting.`);
        return metadata.favorites.find(fav => String(fav.messageId) === String(messageInfo.messageId));
    }
    const item = {
        id: uuidv4(),
        messageId: messageInfo.messageId,
        sender: messageInfo.sender,
        role: messageInfo.role,
        note: ''
    };
    metadata.favorites.push(item);
    const chatDataInCache = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFile);
    if (chatDataInCache) {
        if (!chatDataInCache.metadata.favorites) chatDataInCache.metadata.favorites = [];
        chatDataInCache.metadata.favorites.push(item);
        chatDataInCache.favorites = chatDataInCache.metadata.favorites;
    }

    if (chatFile === String(currentContext.chatId || '').replace('.jsonl', '')) {
        saveMetadataDebounced();
    } else {
        saveSpecificChatMetadata(chatFile, metadata, messages);
    }
    if (modalElement && modalElement.style.display === 'block') {
        if (String(currentViewingChatFile).replace('.jsonl','') === chatFile) {
             renderFavoritesView(currentViewingChatFile);
        }
    }
    return item;
}

/**
 * REFACTORED: Removes a favorite by its unique ID.
 * This function also follows the single-source-of-truth principle.
 */
function removeFavoriteById(favoriteId, targetChatFile = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl','') : (currentViewingChatFile || currentContextChatIdNoExt);
    if (!chatFileToModify) {
        console.error(`${pluginName}: removeFavoriteById - Cannot determine target chat file.`);
        return false;
    }

    // Find the single source of truth: our cache.
    let chatDataInCache = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);

    if (!chatDataInCache || !Array.isArray(chatDataInCache.metadata.favorites)) {
        console.error(`${pluginName}: removeFavoriteById - Chat data for "${chatFileToModify}" or its favorites array not found.`);
        return false;
    }

    const indexToRemove = chatDataInCache.metadata.favorites.findIndex(fav => fav.id === favoriteId);

    if (indexToRemove !== -1) {
        // Remove the item from the cache (the single point of modification)
        chatDataInCache.metadata.favorites.splice(indexToRemove, 1);
        // Sync the secondary 'favorites' property
        chatDataInCache.favorites = chatDataInCache.metadata.favorites;

        // Propagate the change
        if (chatFileToModify === currentContextChatIdNoExt) {
            // Sync with the live context metadata
            context.chatMetadata.favorites = chatDataInCache.metadata.favorites;
            saveMetadataDebounced();
        } else {
            // Save to the specific chat file on the backend
            saveSpecificChatMetadata(chatFileToModify, chatDataInCache.metadata, chatDataInCache.messages);
        }
        
        return true;
    }

    return false;
}

function updateFavoriteNote(favoriteId, note, targetChatFile = null) {
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl','') : (currentViewingChatFile || currentContextChatIdNoExt);
    if (!chatFileToModify) return;
    let metadataToUpdate;
    let messagesToUpdate = null;
    if (chatFileToModify === currentContextChatIdNoExt) {
        const globalChatMetadata = ensureFavoritesArrayExists();
        if (!globalChatMetadata) return;
        metadataToUpdate = globalChatMetadata;
        messagesToUpdate = context.chat;
    } else if (allChatsFavoritesData.length > 0) {
        const chatData = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl','') === chatFileToModify);
        if (chatData && chatData.metadata) {
            metadataToUpdate = JSON.parse(JSON.stringify(chatData.metadata));
            messagesToUpdate = chatData.messages;
        }
    }
    if (!metadataToUpdate || !Array.isArray(metadataToUpdate.favorites)) return;
    const favorite = metadataToUpdate.favorites.find(fav => fav.id === favoriteId);
    if (favorite) {
        favorite.note = note;
        const chatDataInCache = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileToModify);
        if (chatDataInCache) {
            const favInCache = chatDataInCache.metadata.favorites.find(fav => fav.id === favoriteId);
            if (favInCache) favInCache.note = note;
        }

        if (chatFileToModify === currentContextChatIdNoExt) {
            saveMetadataDebounced();
        } else {
            saveSpecificChatMetadata(chatFileToModify, metadataToUpdate, messagesToUpdate);
        }
    }
}

async function handleDeleteFavoriteFromPopup(favId, messageId, targetChatFile = null) {
    const chatFileForDeletion = targetChatFile ? String(targetChatFile).replace('.jsonl','') : currentViewingChatFile;
    try {
        const confirmResult = await callGenericPopup('确定要删除这条收藏吗？', POPUP_TYPE.CONFIRM);
        if (confirmResult === POPUP_RESULT.AFFIRMATIVE) {
            const removed = removeFavoriteById(favId, chatFileForDeletion);
            if (removed) {
                // Instead of a full reload, just re-render the view
                await renderFavoritesView(currentViewingChatFile);
                
                const context = getContext();
                if (String(chatFileForDeletion).replace('.jsonl','') === String(context.chatId || '').replace('.jsonl','')) {
                    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
                    if (messageElement.length) {
                        messageElement.find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular');
                    }
                }
                toastr.success('收藏已删除');
            } else {
                toastr.error('删除收藏失败');
            }
        }
    } catch (error) {
        console.error(`[${pluginName}] deleting favorite:`, error);
        toastr.error('删除收藏时发生错误');
    }
}

async function handleEditNote(favId, targetChatFile = null) {
    const chatFileToModify = targetChatFile ? String(targetChatFile).replace('.jsonl','') : currentViewingChatFile;
    let favorite = null;
    let currentNote = '';
    const context = getContext();
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    if (chatFileToModify === currentContextChatIdNoExt) {
        const meta = ensureFavoritesArrayExists();
        favorite = meta?.favorites?.find(fav => fav.id === favId);
    } else if (chatFileToModify && allChatsFavoritesData.length > 0) {
        const chatData = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl','') === chatFileToModify);
        favorite = chatData?.metadata?.favorites?.find(fav => fav.id === favId);
    }
    
    if (favorite) {
        currentNote = favorite.note || '';
    } else {
        toastr.error('无法找到收藏项');
        return;
    }
    
    const result = await callGenericPopup('为这条收藏添加备注:', POPUP_TYPE.INPUT, currentNote);

    if (result !== null && result !== POPUP_RESULT.CANCELLED && result !== currentNote) {
        updateFavoriteNote(favId, result, chatFileToModify);
        await renderFavoritesView(currentViewingChatFile);
    }
}

async function handleEditNoteFromChat(targetIcon) {
    const messageElement = $(targetIcon).closest('.mes');
    if (!messageElement.length) return;

    const messageIdString = messageElement.attr('mesid');
    if (!messageIdString) return;

    const context = getContext();
    const currentChatMetadata = ensureFavoritesArrayExists();
    if (!currentChatMetadata) return;

    const currentChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    let favorite = currentChatMetadata.favorites.find(fav => fav.messageId === messageIdString);
    const wasAlreadyFavorited = !!favorite;
    let favIdToEdit = favorite ? favorite.id : null;
    const iconElement = $(targetIcon).find('i');

    if (!wasAlreadyFavorited) {
        const messageIndex = parseInt(messageIdString, 10);
        const message = context.chat[messageIndex];
        if (!message) {
            toastr.error('无法找到消息以进行收藏。');
            return;
        }
        const messageInfo = { messageId: messageIdString, sender: message.name, role: message.is_user ? 'user' : 'character' };
        
        const newItem = addFavorite(messageInfo, currentChatIdNoExt);
        if (!newItem) {
            toastr.error('收藏失败，无法添加备注。');
            return;
        }
        favorite = newItem;
        favIdToEdit = newItem.id;
        
        iconElement.removeClass('fa-regular').addClass('fa-solid');
    }

    const currentNote = favorite ? favorite.note || '' : '';
    const result = await callGenericPopup('编辑收藏备注:', POPUP_TYPE.INPUT, currentNote);

    if (result !== null && result !== POPUP_RESULT.CANCELLED) {
        if (result !== currentNote) {
            updateFavoriteNote(favIdToEdit, result, currentChatIdNoExt);
        }
    } else {
        if (!wasAlreadyFavorited) {
            removeFavoriteById(favIdToEdit, currentChatIdNoExt);
            iconElement.removeClass('fa-solid').addClass('fa-regular');
        }
    }
}

function addFavoriteIconsToMessages() {
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

function refreshFavoriteIconsInView() {
    if (isPreviewingContext) return;
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites)) {
        $('#chat').find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular');
        return;
    }
    addFavoriteIconsToMessages();
    $('#chat').find('.mes').each(function() {
        const messageId = $(this).attr('mesid');
        if (messageId) {
            const isFavorited = chatMetadata.favorites.some(fav => fav.messageId === messageId);
            const iconElement = $(this).find('.favorite-toggle-icon i');
            if (iconElement.length) {
                iconElement.toggleClass('fa-solid', isFavorited).toggleClass('fa-regular', !isFavorited);
            }
        }
    });
}

async function getAllChatFavoritesForCurrentContext(skipCurrentChat = false) {
    const context = getContext();
    if (!context) return [];
    
    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl','');
    let chatListResponse, requestBody, allFavoritesData = [];

    const processChatList = async (list) => {
        for (const chatMeta of list) {
            const chatFileNameWithExt = chatMeta.file_name;
            const chatFileNameNoExt = String(chatFileNameWithExt || '').replace('.jsonl', '');
            if (!chatFileNameNoExt || (skipCurrentChat && chatFileNameNoExt === currentContextChatIdNoExt)) {
                continue;
            }
            const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId, chatMeta);
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
            }
        }
    };

    if (context.groupId) {
        requestBody = { group_id: context.groupId, query: '' };
        try {
            chatListResponse = await fetch('/api/chats/search', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
            if (!chatListResponse.ok) throw new Error(`Failed to fetch chat list for group ${context.groupId}: ${chatListResponse.status}`);
            const groupChatsMetadataList = await chatListResponse.json();
            if (Array.isArray(groupChatsMetadataList)) {
                await processChatList(groupChatsMetadataList);
            }
        } catch (error) {
            console.error(`${pluginName}: Error fetching group chats:`, error);
        }
	} else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
		const charObj = context.characters[context.characterId];
		requestBody = { avatar_url: charObj.avatar };
		try {
			chatListResponse = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
			if (!chatListResponse.ok) throw new Error(`Failed to fetch chat list for character ${context.characterId}: ${chatListResponse.status}`);
			const characterChatsArray = await chatListResponse.json();
			if (Array.isArray(characterChatsArray)) {
                await processChatList(characterChatsArray);
            }
		} catch (error) {
			console.error(`${pluginName}: Error fetching character chats:`, error);
		}
    }
    
    return allFavoritesData;
}


async function getFullChatData(characterId, groupId, chatFileNameNoExt, isGroup, providedMetadata = null) {
    const context = getContext();
    let endpoint, requestBody, finalMetadataObject = { favorites: [] }, messages = [];
    try {
        if (isGroup) {
            if (!groupId) return null;
            endpoint = '/api/chats/group/get';
            requestBody = { id: groupId, chat_id: chatFileNameNoExt };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
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
            if (groupId === context.groupId && chatFileNameNoExt === String(context.chatId || '').replace('.jsonl','')) {
                finalMetadataObject = JSON.parse(JSON.stringify(context.chatMetadata || { favorites: [] }));
            } else if (providedMetadata) {
                if (typeof providedMetadata.chat_metadata === 'object' && providedMetadata.chat_metadata !== null) {
                    finalMetadataObject = JSON.parse(JSON.stringify(providedMetadata.chat_metadata));
                } else {
                    finalMetadataObject = JSON.parse(JSON.stringify(providedMetadata));
                }
            } else {
                const cachedChat = allChatsFavoritesData.find(c => c.isGroup === true && c.groupId === groupId && String(c.fileName).replace('.jsonl','') === chatFileNameNoExt);
                if (cachedChat && cachedChat.metadata) {
                    finalMetadataObject = JSON.parse(JSON.stringify(cachedChat.metadata));
                }
            }
        } else {
            if (characterId === undefined || characterId === null || !context.characters || !context.characters[characterId]) return null;
            const charObj = context.characters[characterId];
            endpoint = '/api/chats/get';
            requestBody = { ch_name: charObj.name, file_name: chatFileNameNoExt, avatar_url: charObj.avatar };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody) });
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
            finalMetadataObject = { favorites: [] };
        } else if (!Array.isArray(finalMetadataObject.favorites)) {
            finalMetadataObject.favorites = [];
        }
        return { metadata: finalMetadataObject, messages };
    } catch (error) {
        console.error(`${pluginName}: getFullChatData error for "${chatFileNameNoExt}":`, error);
        return { metadata: { favorites: [] }, messages: [] };
    }
}

async function saveSpecificChatMetadata(chatFileNameNoExt, metadataToSave, messagesArray = null) {
    const context = getContext();
    try {
        let chatContentToSave = [];
        const isGroupChat = !!context.groupId;
        let characterName, avatarUrl;
        if (messagesArray === null) {
            const fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, isGroupChat);
            if (!fullChatData || !fullChatData.messages) {
                toastr.error(`保存收藏夹变动时错误：无法加载聊天消息。`);
                return;
            }
            messagesArray = fullChatData.messages;
        }
        const finalMetadataObjectForSave = {
            user_name: context.userAlias || context.name1 || "User",
            character_name: "Unknown",
            create_date: metadataToSave.create_date || timestampToMoment(Date.now()).format('YYYY-MM-DD HH:mm:ss'),
            chat_metadata: metadataToSave
        };
        chatContentToSave.push(finalMetadataObjectForSave);
        chatContentToSave.push(...messagesArray);
        let requestBody = { chat: chatContentToSave, file_name: chatFileNameNoExt, force: true };
        if (isGroupChat) {
            if (!context.groupId) { toastr.error("无法保存群组聊天收藏：群组ID未知。"); return; }
            requestBody.is_group = true;
            requestBody.id = context.groupId;
            const group = context.groups?.find(g => g.id === context.groupId);
            finalMetadataObjectForSave.character_name = group ? group.name : "Group Chat";
        } else {
            if (context.characterId === undefined || !context.characters || !context.characters[context.characterId]) { toastr.error("无法保存角色聊天收藏：角色信息未知。"); return; }
            const charObj = context.characters[context.characterId];
            characterName = charObj.name;
            avatarUrl = charObj.avatar;
            requestBody.ch_name = characterName;
            requestBody.avatar_url = avatarUrl;
            finalMetadataObjectForSave.character_name = characterName;
        }
        chatContentToSave[0] = finalMetadataObjectForSave;
        const response = await fetch('/api/chats/save', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), cache: 'no-cache' });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server responded with ${response.status}: ${errorText}`);
        }
        const chatDataInCache = allChatsFavoritesData.find(c => c.fileName === chatFileNameNoExt);
        if (chatDataInCache) {
            chatDataInCache.metadata = JSON.parse(JSON.stringify(metadataToSave));
            chatDataInCache.favorites = metadataToSave.favorites || [];
            chatDataInCache.messages = JSON.parse(JSON.stringify(messagesArray));
        }
    } catch (error) {
        console.error(`${pluginName}: Error in saveSpecificChatMetadata for ${chatFileNameNoExt}`, error);
        toastr.error(`保存聊天 "${chatFileNameNoExt}" 的收藏夹变动时发生错误：${error.message || '未知错误'}`);
    }
}

function handleFavoriteToggle(event) {
    const target = $(event.currentTarget);
    if (!target.length) return;
    const messageElement = target.closest('.mes');
    if (!messageElement || !messageElement.length) return;
    const messageIdString = messageElement.attr('mesid');
    if (!messageIdString) return;
    let context;
    try {
        context = getContext();
    } catch (e) {
        return;
    }
    const currentChatMetadata = ensureFavoritesArrayExists();
    if (!currentChatMetadata) return;
    const messageIndex = parseInt(messageIdString, 10);
    const message = context.chat[messageIndex];
    if (!message) return;
    const iconElement = target.find('i');
    const isCurrentlyFavorited = iconElement.hasClass('fa-solid');
    const currentChatIdNoExt = String(context.chatId || '').replace('.jsonl','');
    if (!isCurrentlyFavorited) {
        iconElement.removeClass('fa-regular').addClass('fa-solid');
        const messageInfo = { messageId: messageIdString, sender: message.name, role: message.is_user ? 'user' : 'character' };
        addFavorite(messageInfo, currentChatIdNoExt);
    } else {
        iconElement.removeClass('fa-solid').addClass('fa-regular');
        const favoriteToRemove = currentChatMetadata.favorites.find(fav => fav.messageId === messageIdString);
        if (favoriteToRemove) {
            removeFavoriteById(favoriteToRemove.id, currentChatIdNoExt);
        }
    }
}

async function handleViewContext(messageId, chatFileNoExt) {
    try {
        const context = getContext();
        let messagesArray = [];
        let chatContextForAvatar = null;

        const chatData = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileNoExt);

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
        const currentMessage = messagesArray[msgIndex];
        const prevMessage = (msgIndex > 0) ? messagesArray[msgIndex - 1] : null;
        const nextMessage = (msgIndex < messagesArray.length - 1) ? messagesArray[msgIndex + 1] : null;

        showContextMessagesFrame(prevMessage, currentMessage, nextMessage, chatContextForAvatar);

    } catch (error) {
        console.error(`${pluginName}: 查看消息上下文时出错:`, error);
        toastr.error('查看消息上下文时发生错误');
    }
}

function showContextMessagesFrame(prevMessage, currentMessage, nextMessage, chatContextForAvatar) {
    const existingFrame = document.getElementById('context-messages-frame');
    if (existingFrame) existingFrame.remove();
    
    const frameHtml = `
        <div id="context-messages-frame" class="context-messages-frame">
            <div class="context-messages-container">
                <div class="context-messages-header">
                    <div class="context-title">消息上下文</div>
                    <div class="context-close-btn"><i class="fa-solid fa-xmark"></i></div>
                </div>
                <div class="context-messages-content"></div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', frameHtml);
    
    const container = document.querySelector('#context-messages-frame .context-messages-container');
    const contentContainer = container.querySelector('.context-messages-content');
    
    const scrollbar = document.createElement('div');
    scrollbar.className = 'k-scrollerbar';
    container.prepend(scrollbar);

    if (prevMessage) contentContainer.insertAdjacentHTML('beforeend', renderContextMessage(prevMessage, false, chatContextForAvatar));
    if (currentMessage) contentContainer.insertAdjacentHTML('beforeend', renderContextMessage(currentMessage, true, chatContextForAvatar));
    if (nextMessage) contentContainer.insertAdjacentHTML('beforeend', renderContextMessage(nextMessage, false, chatContextForAvatar));
    
    applySavedTheme();
    renderIframesInElement($(contentContainer));

    let scrollTimeout;
    const handleScroll = () => {
        scrollbar.style.opacity = '1';
        const { scrollHeight, clientHeight, scrollTop } = contentContainer;
        const trackHeight = container.clientHeight;
        const totalScrollableDistance = scrollHeight - clientHeight;
        if (totalScrollableDistance <= 0) {
            scrollbar.style.height = '0px';
            return;
        }
        const scrollProgress = scrollTop / totalScrollableDistance;
        const barHeight = trackHeight * scrollProgress;
        scrollbar.style.height = `${barHeight}px`;
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            scrollbar.style.opacity = '0';
        }, 1500);
    };
    contentContainer.addEventListener('scroll', handleScroll);
    requestAnimationFrame(handleScroll);
    const frameElement = document.getElementById('context-messages-frame');
    setTimeout(() => { frameElement.classList.add('visible'); }, 10);
    frameElement.querySelector('.context-close-btn').addEventListener('click', closeContextFrame);
    frameElement.addEventListener('click', function(e) { if (e.target === this) closeContextFrame(); });
}

function closeContextFrame() {
    const frame = document.getElementById('context-messages-frame');
    if (frame) {
        frame.classList.remove('visible');
        setTimeout(() => {
            frame.remove();
        }, 300);
    }
}

function renderContextMessage(message, isHighlighted, chatContext) {
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
    
    let formattedContent = message.mes || '[空消息]';
    try {
        formattedContent = messageFormatting(formattedContent, senderName, false, isUser, null, {}, false);
    } catch (error) {
        formattedContent = `<div class="formatting-error">${message.mes || '[空消息]'}</div>`;
    }

    const messageClass = isUser ? 'user-message' : 'ai-message';
    const highlightClass = isHighlighted ? 'highlighted-message' : '';

    return `
        <div class="context-message-wrapper ${messageClass} ${highlightClass}">
            <div class="context-message-avatar"><img src="${avatarImg}" alt="${senderName}" onerror="this.src='img/ai4.png'"></div>
            <div class="context-message-bubble">
                <div class="context-message-name">${senderName}</div>
                <div class="context-message-text">${formattedContent}</div>
            </div>
        </div>`;
}

function scrollToMessage(messageId, alignment = 'start', behavior = 'auto', timeout = 150) {
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

async function enterPreviewMode(messageId, chatFileNoExt) {
    closeFavoritesModal();
    isPreviewingContext = true;

    const chatData = allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === chatFileNoExt);
    if (!chatData || !chatData.messages) {
        toastr.error('无法加载预览上下文的消息。');
        isPreviewingContext = false;
        return;
    }

    const messagesArray = chatData.messages;
    const msgIndex = parseInt(messageId, 10);
    if (isNaN(msgIndex) || msgIndex < 0 || msgIndex >= messagesArray.length) {
        toastr.error(`无效的消息索引: ${messageId}`);
        isPreviewingContext = false;
        return;
    }

    const totalMessagesToShow = Math.min(messagesArray.length, 5);
    const targetIndexInSlice = msgIndex - Math.max(0, msgIndex - 2);
    const startIndex = Math.max(0, msgIndex - targetIndexInSlice);
    const endIndex = Math.min(messagesArray.length, startIndex + totalMessagesToShow);
    const contextMessages = messagesArray.slice(startIndex, endIndex);

    $('#send_form').hide();
    if (previewToggleElement) previewToggleElement.style.display = 'flex';
	if (previewExitButtonElement) previewExitButtonElement.style.display = 'flex';
	$('#top-bar').hide();
	$('#top-settings-holder').hide();
    
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
            if ($newMessageElement.length) renderIframesInElement($newMessageElement);
        }
        scrollToMessage(messageId, 'start', 'auto', 150);
    } finally {
        context.auto_scroll = originalAutoScroll;
    }
}

async function exitPreviewMode() {
    if (!isPreviewingContext) return;
    
    if (previewToggleElement) previewToggleElement.style.display = 'none';
    if (previewExitButtonElement) previewExitButtonElement.style.display = 'none';
    
    $('#send_form').css('display', 'flex');
    $('#top-bar').css('display', 'flex');
    $('#top-settings-holder').css('display', 'flex');

    await reloadCurrentChat();
    isPreviewingContext = false;
    setTimeout(refreshFavoriteIconsInView, 200);
}

function setupPreviewModeUI() {
    if (!document.getElementById('favorites-preview-toggle')) {
        previewToggleElement = document.createElement('div');
        previewToggleElement.id = 'favorites-preview-toggle';
        previewToggleElement.innerHTML = '<i class="fa-solid fa-eye"></i>';
        previewToggleElement.title = '打开收藏面板';
        previewToggleElement.addEventListener('click', openFavoritesModal);
        document.body.appendChild(previewToggleElement);
    }
    
    if (!document.getElementById(PREVIEW_EXIT_BUTTON_ID)) {
        previewExitButtonElement = document.createElement('button');
        previewExitButtonElement.id = PREVIEW_EXIT_BUTTON_ID;
        previewExitButtonElement.className = 'menu_button';
        previewExitButtonElement.textContent = '结束预览';
        previewExitButtonElement.addEventListener('click', exitPreviewMode);
        document.body.appendChild(previewExitButtonElement);
    }
}

// =================================================================
//                      PLUGIN INITIALIZATION
// =================================================================
jQuery(async () => {
    try {
        if (!extension_settings[pluginName].lastSeenVersion) {
            extension_settings[pluginName].lastSeenVersion = '0.0.0';
        }
        
        try {
            const inputButtonHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'input_button');
            $('#data_bank_wand_container').append(inputButtonHtml);
            
            const updateButtonHtml = `<button id="favorites_update_button" class="menu_button_small danger" style="display: none; margin-left: 5px;" title="有新版本可用！">可更新</button>`;
            $('#favorites_button').append(updateButtonHtml).on('click', openFavoritesModal);
            $('#favorites_update_button').on('click', (event) => {
                event.stopPropagation();
                handleUpdate();
            });

        } catch (error) {
            console.error(`${pluginName}: Failed to load input button:`, error);
        }

        setupPreviewModeUI();

        let longPressTimeout;
        let isLongPress = false;
        $(document)
            .on('mousedown', '.favorite-toggle-icon', (event) => {
                isLongPress = false;
                longPressTimeout = setTimeout(() => {
                    isLongPress = true;
                    event.preventDefault();
                    handleEditNoteFromChat(event.currentTarget);
                }, 600);
            })
            .on('mouseup mouseleave touchend', '.favorite-toggle-icon', () => {
                clearTimeout(longPressTimeout);
            })
            .on('click', '.favorite-toggle-icon', (event) => {
                if (!isLongPress) {
                    handleFavoriteToggle(event);
                }
            });
        
        ensureFavoritesArrayExists();
        addFavoriteIconsToMessages();
        refreshFavoriteIconsInView();

        await checkForUpdates();

        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (isPreviewingContext) exitPreviewMode();
            ensureFavoritesArrayExists();
            setTimeout(() => {
                addFavoriteIconsToMessages();
                refreshFavoriteIconsInView();
            }, 150);
        });
        eventSource.on(event_types.MESSAGE_DELETED, (deletedMessageIndex) => {
            const deletedMessageId = String(deletedMessageIndex);
            const chatMetadata = ensureFavoritesArrayExists();
            if (!chatMetadata || !chatMetadata.favorites) return;
            const favIndex = chatMetadata.favorites.findIndex(fav => fav.messageId === deletedMessageId);
            if (favIndex !== -1) {
                const favId = chatMetadata.favorites[favIndex].id;
                removeFavoriteById(favId, getContext().chatId); // Use remove function to handle cache
                
                if (modalElement && modalElement.style.display === 'block') {
                    const context = getContext();
                    if (String(currentViewingChatFile).replace('.jsonl','') === String(context.chatId || '').replace('.jsonl','')) {
                        renderFavoritesView(currentViewingChatFile);
                    }
                }
                 setTimeout(refreshFavoriteIconsInView, 100);
            }
        });
        const handleNewMessage = () => setTimeout(() => { if (!isPreviewingContext) addFavoriteIconsToMessages(); }, 150);
        eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
        eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);
        
        const handleMessageUpdate = () => setTimeout(() => { if (!isPreviewingContext) refreshFavoriteIconsInView(); }, 150);
        eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
        eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdate);
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => setTimeout(() => {
            if (!isPreviewingContext) {
                addFavoriteIconsToMessages();
                refreshFavoriteIconsInView();
            }
        }, 150));
        
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            const chatObserver = new MutationObserver((mutations) => {
                if (mutations.some(m => m.addedNodes.length > 0)) {
                    if (!isPreviewingContext) {
                        requestAnimationFrame(addFavoriteIconsToMessages);
                    }
                }
            });
            chatObserver.observe(chatElement, { childList: true });
        }

        console.log(`${pluginName}: Plugin loaded successfully.`);
    } catch (error) {
        console.error(`${pluginName}: Initialization failed:`, error);
    }
});
