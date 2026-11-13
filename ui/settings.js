// ui/settings.js - 设置与主题相关功能

import { state, getSetting, setSetting } from '../state.js';
import { formatBytes, escapeHtml } from '../utils.js';
import { getCoreHooks } from '../hooks.js';
import { showTextModal, showConfirmModal } from './components.js';
import Logger from '../Logger.js';
import { toggleDebugPanel } from './debug.js';
import { showMigrationDialog } from './migration.js';
import {
    getFontCacheStats,
    deleteFontCacheEntries,
    deleteImageCacheEntry,
    clearAllFontCache,
    clearAllImageCache,
    getImageDataUrl,
} from './font-subset.js';

// 收藏面板的 DOM 类名（面板结构定义在 ui/main.js，此处只引用其稳定类名）
const MODAL_CLOSE_X_CLASS = 'favorites-modal-close-x';

// =================================================================
//                      SETTINGS MENU & USAGE GUIDE
// =================================================================
// 注：主题的读写与切换动效已收敛到 ui/theme.js（唯一事实来源挂在 documentElement）。
// 此处不再持有主题状态，只负责设置菜单本身的呈现。

/**
 * Shows the long-press menu with options for theme, context range, items per page, and usage guide.
 */

// 设置菜单的模块级清理状态（供 closeAvatarLongPressMenu 统一恢复/移除）
let _optionsMenuResizeHandler = null;          // 居中用的 resize 处理器引用
let _optionsMenuBackdropOriginal = null;       // 打开菜单时被禁用的主遮罩 backdrop-filter 原始值
let _optionsMenuBackdropOriginalWebkit = null;

/**
 * 关闭设置小菜单并完整清理：移除 DOM、恢复主遮罩 backdrop-filter、移除 resize 监听。
 * 所有关闭路径（遮罩点击 / X 按钮 / 菜单项选择 / ESC）都应走此函数，
 * 避免直接 remove DOM 造成的样式残留与监听器泄漏。
 */
export function closeAvatarLongPressMenu() {
    const overlay = document.getElementById('star-options-menu-overlay');
    if (!overlay) return;
    overlay.remove();

    // 恢复主遮罩的 backdrop-filter（打开菜单时被置为 none）
    const mainModalOverlay = document.getElementById('favoritesModal');
    if (mainModalOverlay) {
        mainModalOverlay.style.backdropFilter = _optionsMenuBackdropOriginal || '';
        mainModalOverlay.style.webkitBackdropFilter = _optionsMenuBackdropOriginalWebkit || '';
    }

    if (_optionsMenuResizeHandler) {
        window.removeEventListener('resize', _optionsMenuResizeHandler);
        _optionsMenuResizeHandler = null;
    }
    _optionsMenuBackdropOriginal = null;
    _optionsMenuBackdropOriginalWebkit = null;
}

export function showAvatarLongPressMenu() {
    // 1. 防止重复创建
    if (document.getElementById('star-options-menu-overlay')) return;

    // 获取主收藏夹的遮罩层
    const mainModalOverlay = document.getElementById('favoritesModal');
    if (!mainModalOverlay) return;

    // --- 关键修复：暂时禁用主遮罩的 backdrop-filter，避免渲染冲突 ---
    const originalBackdropFilter = mainModalOverlay.style.backdropFilter;
    const originalWebkitBackdropFilter = mainModalOverlay.style.webkitBackdropFilter;
    mainModalOverlay.style.backdropFilter = 'none';
    mainModalOverlay.style.webkitBackdropFilter = 'none';

    // 2. 动态创建我们自己的、独立的遮罩和菜单（采用自闭合结构）
    const overlay = document.createElement('div');
    overlay.id = 'star-options-menu-overlay';

    const menuDialog = document.createElement('div');
    menuDialog.id = 'star-options-menu-dialog';
    menuDialog.className = 'star-options-menu-dialog';

    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        menuDialog.dataset.starTheme = 'dark';
    }

    // 读取当前设置值，用于菜单右侧的状态回显
    const currentContextRange = getSetting('contextViewRange');
    const currentItemsPerPage = getSetting('itemsPerPage');
    const debugEnabled = state.debugPanel.enabled;

    menuDialog.innerHTML = `
        <div class="star-options-menu-header">
            <i class="fa-solid fa-gear star-options-menu-header-icon"></i>
            <span>设置</span>
        </div>
        <div class="star-options-menu-body">
            <div class="star-options-group-label">显示</div>
            <div class="star-options-menu-item" data-action="context-range-settings">
                <i class="fa-solid fa-arrows-left-right-to-line star-options-item-icon"></i>
                <span class="star-options-item-label">上下文范围</span>
                <span class="star-options-item-value">前后各 ${currentContextRange} 条</span>
            </div>
            <div class="star-options-menu-item" data-action="items-per-page-settings">
                <i class="fa-solid fa-list-ol star-options-item-icon"></i>
                <span class="star-options-item-label">每页收藏数</span>
                <span class="star-options-item-value">${currentItemsPerPage} 条</span>
            </div>
            <div class="star-options-group-label">功能</div>
            <div class="star-options-menu-item" data-action="screenshot-settings">
                <i class="fa-solid fa-image star-options-item-icon"></i>
                <span class="star-options-item-label">截图设置</span>
                <span class="star-options-item-value star-options-menu-arrow"><i class="fa-solid fa-chevron-right"></i></span>
            </div>
            <div class="star-options-menu-item" data-action="shortcut-info">
                <i class="fa-solid fa-keyboard star-options-item-icon"></i>
                <span class="star-options-item-label">快捷键</span>
                <span class="star-options-item-value">Alt+S / Alt+F</span>
            </div>
            <div class="star-options-group-label">其他</div>
            <div class="star-options-menu-item" data-action="toggle-debug-panel">
                <i class="fa-solid fa-bug star-options-item-icon"></i>
                <span class="star-options-item-label" id="star-debug-menu-text">${debugEnabled ? '日志面板' : '启用日志面板'}</span>
                <span class="star-options-item-value">${debugEnabled ? '已启用' : '已关闭'}</span>
            </div>
            <div class="star-options-menu-item" data-action="data-migration">
                <i class="fa-solid fa-database star-options-item-icon"></i>
                <span class="star-options-item-label">数据迁移</span>
                <span class="star-options-item-value star-options-menu-arrow"><i class="fa-solid fa-chevron-right"></i></span>
            </div>
            <div class="star-options-menu-item" data-action="usage-guide">
                <i class="fa-solid fa-book-open star-options-item-icon"></i>
                <span class="star-options-item-label">使用说明</span>
                <span class="star-options-item-value star-options-menu-arrow"><i class="fa-solid fa-chevron-right"></i></span>
            </div>
        </div>
    `;

    overlay.appendChild(menuDialog);
    document.body.appendChild(overlay);

    const centerMenu = () => {
        if (!menuDialog) return;
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        menuDialog.style.left = `${Math.max(0, (windowWidth - menuDialog.offsetWidth) / 2)}px`;
        menuDialog.style.top = `${Math.max(0, (windowHeight - menuDialog.offsetHeight) / 2)}px`;
    };

    centerMenu();
    window.addEventListener('resize', centerMenu);

    // 记录居中用的 resize 处理器与主遮罩 backdrop-filter 原始值，供关闭时统一恢复
    _optionsMenuResizeHandler = centerMenu;
    _optionsMenuBackdropOriginal = originalBackdropFilter;
    _optionsMenuBackdropOriginalWebkit = originalWebkitBackdropFilter;

    // 绑定关闭事件到自身的遮罩层（统一走 closeAvatarLongPressMenu 完整清理）
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeAvatarLongPressMenu();
        }
    });

    // 绑定菜单项点击事件
    menuDialog.addEventListener('click', (e) => {
        const item = e.target.closest('.star-options-menu-item');
        if (!item) return;

        const action = item.dataset.action;
        closeAvatarLongPressMenu(); // 选择后总是关闭
        if (action === 'usage-guide') {
            setTimeout(showUsageGuidePopup, 100);
        } else if (action === 'context-range-settings') {
            setTimeout(showContextRangeSettingsPopup, 100);
        } else if (action === 'items-per-page-settings') {
            setTimeout(showItemsPerPageSettingsPopup, 100);
        } else if (action === 'toggle-debug-panel') {
            setTimeout(toggleDebugPanel, 100);
        } else if (action === 'data-migration') {
            setTimeout(showMigrationDialog, 100);
        } else if (action === 'screenshot-settings') {
            setTimeout(showScreenshotSettingsPopup, 100);
        } else if (action === 'shortcut-info') {
            setTimeout(showShortcutInfoPopup, 100);
        }
    });

    // 主窗口的X按钮也能关闭小菜单（绑定模块级函数，重复绑定会被浏览器去重，不会累积）
    state.modalElement.querySelector(`.${MODAL_CLOSE_X_CLASS}`).addEventListener('click', closeAvatarLongPressMenu);
}

/**
 * 显示用于设置上下文查看范围的弹出窗口，并正确保存设置。
 */
export async function showContextRangeSettingsPopup() {
    // 当前值（未设置过时为 schema 默认值）
    const currentValue = getSetting('contextViewRange');

    const popupHtml = `
        <div class="star-settings-description">
            <p>该设置值决定了当您点击 <i class="fa-solid fa-expand"></i> 按钮时，能够查看的上下文范围。</p>
            <p>默认为 <b>1</b>，代表查看该收藏消息前后各一条消息（共三条）。</p>
            <p>如果您设置为 <b>2</b>，则会显示前后各两条消息（共五条）。设置为 <b>0</b> 则只显示当前收藏的消息。</p>
            <hr>
            <p>您可以通过长摁收藏夹左上角的头像，选择“修改上下文范围”来再次打开此设置。</p>
        </div>
        <div class="star-settings-input-row">
            <label for="star_context_range_input">上下文范围 (前后各):</label>
            <input type="number" id="star_context_range_input" class="star-settings-number-input" min="0" step="1" value="${currentValue}">
        </div>
    `;

    showTextModal(popupHtml, '修改查看上下文范围', {
        title: '修改查看上下文范围',
        okButton: '保存',
        cancelButton: '取消',
        wide: true,
        onClosing: (popup) => {
            if (popup.result) {
                const inputElement = popup.dlg.querySelector('#star_context_range_input');
                if (!inputElement) {
                    toastr.error('发生内部错误：无法找到输入框。');
                    return true;
                }

                const newValue = parseInt(inputElement.value, 10);

                if (!isNaN(newValue) && newValue >= 0) {
                    if (newValue !== currentValue) {
                        setSetting('contextViewRange', newValue);
                        Logger.info(`Context view range updated to: ${newValue}`);
                        toastr.success(`上下文范围已成功更新为: ${newValue}`);
                    }
                } else {
                    toastr.error('请输入一个有效的非负整数。');
                    return false;
                }
            }
            return true;
        },
    });
}

/**
 * 显示用于设置每页显示消息数的弹出窗口。
 */
export async function showItemsPerPageSettingsPopup() {
    const currentValue = getSetting('itemsPerPage');

    const popupHtml = `
        <div class="star-settings-description">
            <p>该设置决定了收藏夹每个页面显示的消息数量。</p>
            <p>默认为 <b>10</b> 条。建议设置在 5 到 30 之间，过大的数值可能会影响加载性能。</p>
            <hr>
            <p>您可以通过长摁收藏夹左上角的头像，选择“修改显示消息数”来再次打开此设置。</p>
        </div>
        <div class="star-settings-input-row">
            <label for="star_items_per_page_input">每页显示数量:</label>
            <input type="number" id="star_items_per_page_input" class="star-settings-number-input" min="1" max="50" step="1" value="${currentValue}">
        </div>
    `;

    showTextModal(popupHtml, '修改每页显示消息数', {
        title: '修改每页显示消息数',
        okButton: '保存',
        cancelButton: '取消',
        wide: true,
        onClosing: async (popup) => {
            if (popup.result) {
                const inputElement = popup.dlg.querySelector('#star_items_per_page_input');
                if (!inputElement) {
                    toastr.error('发生内部错误：无法找到输入框。');
                    return true;
                }

                const parsedValue = parseInt(inputElement.value, 10);
                // 输入框的 max=50 只是浏览器提示，程序化赋值不受约束；这里强制收敛到 1–50
                const newValue = isNaN(parsedValue) ? NaN : Math.min(50, Math.max(1, parsedValue));

                if (!isNaN(newValue) && newValue > 0) {
                    if (newValue !== currentValue) {
                        setSetting('itemsPerPage', newValue);

                        // 关键：同步更新全局变量
                        state.itemsPerPage = newValue;

                        Logger.info(`Items per page updated to: ${newValue}`);
                        toastr.success(`每页显示数量已更新为: ${newValue}`);

                        // 通过 hooks 通知收藏面板刷新（面板模块已加载时钩子才存在，
                        // 这样设置模块无需反向 import 面板，避免循环依赖）
                        const refresh = getCoreHooks().refreshFavoritesView;
                        if (typeof refresh === 'function'
                            && state.modalElement && state.modalElement.classList.contains('visible')) {
                            // 重置到第一页，避免因总页数减少而导致当前页码越界
                            state.currentPage = 1;
                            await refresh(state.currentViewingChatFile);
                        }
                    }
                } else {
                    toastr.error('请输入一个有效的正整数。');
                    return false;
                }
            }
            return true;
        },
    });
}

/**
 * 显示快捷键说明弹窗（Alt+S 收藏 / Alt+F 开面板 / Esc 逐层关闭）。
 */
export function showShortcutInfoPopup() {
    const popupHtml = `
        <div class="star-settings-description">
            <p><b>Alt + S</b>：一键收藏 / 取消收藏当前聊天最后一条消息（输入框内不生效，预览模式下不触发）。</p>
            <p><b>Alt + F</b>：快速打开 / 关闭收藏面板。</p>
            <p><b>Esc</b>：逐层关闭弹窗——子弹窗（确认 / 输入 / 编辑器 / AI 答疑 / 调试 / 截图选择 / 使用指南等）优先关闭，最后才关收藏面板主窗口。</p>
        </div>
    `;
    showTextModal(popupHtml, '快捷键说明', { title: '快捷键说明', okButton: '知道了', wide: false });
}

/**
 * 显示使用说明弹窗（带左侧导航栏）。
 * 移动端默认折叠侧栏，电脑端默认展开。
 */
// =================================================================
//        使用说明内容（模块级定义，供使用说明弹窗与 AI 答疑知识库共用）
// =================================================================

/**
 * 将使用说明的 HTML 内容转换为纯文本，供 AI 答疑知识库使用。
 * 块级元素保留换行，列表项加 "- " 前缀，去掉标签和图标。
 */
function htmlToPlainText(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    let text = '';
    const walk = (node) => {
        node.childNodes.forEach((child) => {
            if (child.nodeType === Node.TEXT_NODE) {
                text += child.textContent;
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                if (tag === 'li') {
                    // 列表项整体取文本（含内联强调标签），去掉多余空白
                    text += '- ' + child.textContent.replace(/\s+/g, ' ').trim() + '\n';
                } else if (tag === 'br') {
                    text += '\n';
                } else if (tag === 'hr') {
                    text += '\n\n';
                } else if (['h1', 'h2', 'h3', 'h4', 'p', 'div', 'ul', 'ol', 'blockquote', 'pre', 'table', 'tr'].includes(tag)) {
                    walk(child);
                    text += '\n';
                } else {
                    // 内联元素（strong/em/code/i 等）递归取文本
                    walk(child);
                }
            }
        });
    };
    walk(wrap);
    // 清理行尾空格、行首缩进与连续空行
    return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/^[ \t]+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 返回使用说明的完整纯文本内容（章节标题 + 正文），供 AI 答疑知识库使用。
 * 与 showUsageGuidePopup 弹窗共用同一份数据源，保证内容始终同步。
 */
export function getUsageGuidePlainText() {
    return sections.map(s => `【${s.title}】\n${htmlToPlainText(sectionContents[s.id])}`).join('\n\n');
}

// 侧栏章节定义
const sections = [
    { id: 'welcome', icon: 'fa-hand-sparkles', title: '欢迎使用' },
    { id: 'basic', icon: 'fa-star', title: '基本操作' },
    { id: 'panel', icon: 'fa-folder-open', title: '收藏面板' },
    { id: 'search', icon: 'fa-magnifying-glass', title: '搜索与翻页' },
    { id: 'actions', icon: 'fa-screwdriver-wrench', title: '收藏项操作' },
    { id: 'preview', icon: 'fa-eye', title: '预览模式' },
    { id: 'screenshot', icon: 'fa-camera', title: '截图功能' },
    { id: 'settings', icon: 'fa-gear', title: '主题与设置' },
    { id: 'update', icon: 'fa-arrows-rotate', title: '更新插件' },
    { id: 'faq', icon: 'fa-circle-question', title: '常见问题' },
];

// 章节内容
const sectionContents = {
        welcome: `
            <h2>欢迎使用「聊天收藏器」⭐</h2>
            <p>「聊天收藏器」（Star）是一个 <strong>SillyTavern</strong> 扩展插件，帮助你在与 AI 角色/群组聊天时，<strong>收藏重要的消息</strong>，方便日后回顾、检索和管理。</p>
            <p>无论是一段精彩的剧情、一个搞笑的回复，还是一条重要的信息，你都可以一键收藏，随时回看。</p>
            <hr>
            <p><strong>核心功能一览：</strong></p>
            <ul>
                <li>⭐ <strong>一键收藏/取消收藏</strong> — 点击消息旁的星标图标</li>
                <li>📝 <strong>添加备注</strong> — 为收藏添加文字说明，方便检索</li>
                <li>📂 <strong>集中管理</strong> — 在收藏面板中浏览、搜索所有收藏</li>
                <li>👁️ <strong>预览上下文</strong> — 在主聊天界面中查看收藏消息的上下文</li>
                <li>📷 <strong>截图导出</strong> — 将消息渲染为精美截图保存</li>
                <li>🎨 <strong>主题切换</strong> — 支持亮色/暗色主题</li>
            </ul>
            <p>请通过左侧导航栏浏览各个功能的详细说明。</p>
        `,
        basic: `
            <h2>⭐ 基本操作</h2>
            <h3>收藏消息</h3>
            <p>每条消息的<strong>右上角</strong>都有一个半透明的星标图标 <i class="fa-regular fa-star"></i>：</p>
            <ol>
                <li><strong>单击</strong>该图标，星标会变为实心的黄色 <i class="fa-solid fa-star star-star-demo-icon"></i>，表示收藏成功。</li>
                <li><strong>再次单击</strong>同一图标，星标恢复为空心状态，表示取消收藏。</li>
            </ol>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>星标图标默认半透明显示，鼠标悬停时会变得更明显。已收藏的消息星标始终为实心黄色，一目了然。
            </div>

            <h3>编辑备注（快捷方式）</h3>
            <p>无需打开收藏面板，直接在聊天界面中操作：</p>
            <ol>
                <li><strong>长按</strong>（约 0.6 秒）消息右上角的星标图标。</li>
                <li>在弹出的输入框中输入备注内容。</li>
                <li>点击“确定”保存。</li>
            </ol>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>备注是<strong>按 Swipe</strong>存储的。收藏一条消息的不同 Swipe 时可以分别添加不同的备注。在收藏面板中切换 Swipe 时，备注也会跟随切换。
            </div>

            <h3>关于 Swipe</h3>
            <p>在 SillyTavern 中，每条 AI 回复可能有多个“消息”（Swipe），即同一位置的不同回复版本。你可以用左右箭头在这些版本之间切换。</p>
            <p>收藏器支持<strong>按 Swipe 收藏</strong>：如果你收藏了某个 Swipe，当你切换到另一个 Swipe 时，收藏状态会相应变化。每个 Swipe 可以有独立的备注。</p>
        `,
        panel: `
            <h2>📂 收藏管理面板</h2>
            <p>点击魔法棒🪄中的<strong>“收藏”按钮</strong>即可打开收藏管理面板。这是你查看和管理所有收藏的中央入口。</p>

            <h3>面板布局</h3>
            <ul>
                <li><strong>顶部标题栏：</strong>显示当前查看的角色/群聊名称。</li>
                <li><strong>左侧边栏：</strong>列出所有有收藏的聊天。点击可在不同聊天之间切换。</li>
                <li><strong>右侧主区域：</strong>显示当前聊天的所有收藏消息，按楼层顺序排列。</li>
                <li><strong>底部翻页栏：</strong>收藏数量较多时自动出现分页导航。</li>
            </ul>

            <h3>切换不同聊天</h3>
            <p>左侧边栏列出了所有包含收藏的聊天记录：</p>
            <ol>
                <li>点击<strong>左上角的头像</strong>可以展开/收起侧栏。</li>
                <li>点击侧栏中的<strong>聊天名称</strong>即可切换到该聊天的收藏视图。</li>
                <li>当前查看的聊天会在侧栏中高亮显示。</li>
                <li>聊天名称旁的数字表示该聊天中的收藏数量。</li>
            </ol>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>在移动端，选择聊天后侧栏会自动收起，为内容区域腾出更多空间。点击遮罩层也可以关闭侧栏。
            </div>

            <h3>打开设置菜单</h3>
            <p>有<strong>三种方式</strong>打开设置菜单：</p>
            <ul>
                <li><strong>长按</strong>左上角的头像（约 0.6 秒）。</li>
                <li><strong>右键</strong>点击左上角的头像。</li>
                <li>点击左侧边栏底部的<strong>齿轮图标</strong> <i class="fa-solid fa-gear"></i>。</li>
            </ul>
            <p>在设置菜单中，你可以修改上下文范围、调整每页收藏数、打开截图设置、查看使用说明等。</p>
        `,
        search: `
            <h2>🔍 搜索与翻页</h2>

            <h3>搜索收藏</h3>
            <p>当收藏数量较多时，搜索功能可以帮助你快速定位所需内容：</p>
            <ol>
                <li>点击右上角的<strong>放大镜图标</strong> <i class="fa-solid fa-magnifying-glass"></i>，搜索框会从右侧滑出。</li>
                <li>在搜索框中<strong>输入关键词</strong>，收藏列表会实时过滤，只显示匹配的条目。</li>
                <li>搜索基于<strong>全部收藏跨页匹配</strong>（不受当前页限制），显示结果时隐藏分页并提示匹配数量；清空关键词后恢复分页显示。</li>
                <li>清空搜索框后，所有收藏恢复显示。</li>
                <li>点击搜索框外的区域，搜索框会自动收起。</li>
            </ol>

            <h3>过滤搜索模式</h3>
            <p>搜索框展开后，左侧会出现一个<strong>过滤图标</strong> <i class="fa-solid fa-filter"></i>：</p>
            <ul>
                <li><strong>默认模式（图标未激活）：</strong>同时搜索<strong>消息内容</strong>和<strong>备注</strong>。</li>
                <li><strong>过滤模式（图标高亮激活）：</strong>仅搜索<strong>备注内容</strong>，忽略消息正文。</li>
            </ul>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>善用备注功能！给重要的收藏添加简短的标签式备注（如“神回复”、“关键剧情”、“战斗技巧”），然后使用过滤搜索快速筛选。
            </div>

            <h3>翻页导航</h3>
            <p>当收藏数量超过每页显示数量（默认 10 条）时，底部会自动出现分页导航：</p>
            <ul>
                <li>点击<strong>左右箭头</strong>（‹ / ›）可翻到上一页/下一页。</li>
                <li>点击<strong>具体页码</strong>可跳转到对应页面。</li>
                <li><strong>双击当前页码</strong>可以弹出一个输入框，直接输入数字并按回车<strong>快速跳转</strong>到指定页。</li>
                <li>当前所在页码会高亮显示。</li>
            </ul>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>每页显示数量可以在“设置 → 修改显示收藏数”中调整，建议设置在 5~30 之间。
            </div>
        `,
        actions: `
            <h2>🔧 收藏项操作</h2>
            <p>在收藏管理面板中，每条收藏消息的右下角都有一排<strong>操作按钮</strong>。以下是每个按钮的详细说明：</p>

            <h3><i class="fa-solid fa-eye"></i> 预览上下文（👁️）</h3>
            <p>在主聊天界面中<strong>临时加载</strong>该收藏消息及其前后几条消息的上下文对话：</p>
            <ul>
                <li>进入预览模式后，聊天区域会显示收藏消息附近的对话。</li>
                <li>右侧会出现一个 <i class="fa-solid fa-eye"></i> <strong>面板按钮</strong>，点击可<strong>快速打开收藏面板</strong>，在面板中点击另一条收藏的预览按钮可以<strong>快速切换</strong>预览内容。</li>
                <li>点击页面底部的<strong>“结束预览”</strong>按钮可退出预览模式，返回正常聊天。</li>
                <li>预览模式下<strong>不能发送新消息</strong>。</li>
            </ul>

            <h3><i class="fa-solid fa-expand"></i> 查看上下文</h3>
            <p>弹出一个<strong>独立窗口</strong>，显示该消息及前后若干条消息：</p>
            <ul>
                <li>默认查看范围是消息前后<strong>各 1 条</strong>（共 3 条），可在设置中调整。</li>
                <li>该窗口中<strong>不对聊天记录做任何修改</strong>，仅用于快速浏览上下文。</li>
                <li>支持两种查看模式：<strong>列表模式</strong>和<strong>单条模式</strong>，点击右上角按钮切换。</li>
            </ul>

            <h3><i class="fa-solid fa-pencil"></i> 编辑消息原文</h3>
            <p><strong>直接修改</strong>这条消息的原始内容：</p>
            <ul>
                <li>点击后会打开编辑窗口，显示当前 Swipe 的完整消息文本。</li>
                <li>如果消息包含内心独白（思维链），也会一并显示在编辑区中。</li>
                <li>点击“保存”后，<strong>修改会永久写入聊天记录</strong>，不可撤销。</li>
            </ul>
            <div class="star-guide-warning">
                <strong>⚠️ 警告：</strong>编辑消息原文会<strong>永久改变聊天记录</strong>，此操作不可撤销。请确认修改内容后再保存！
            </div>

            <h3><i class="fa-solid fa-feather-pointed"></i> 编辑备注</h3>
            <p>为当前收藏添加或修改<strong>文字备注</strong>：</p>
            <ul>
                <li>与在聊天界面中长按星标图标的效果完全相同。</li>
                <li>备注会显示在收藏消息卡片的顶部，方便快速辨识。</li>
                <li>备注支持搜索，可用作分类标签。</li>
            </ul>

            <h3><i class="fa-solid fa-trash"></i> 取消收藏</h3>
            <p>从收藏列表中<strong>移除该条目</strong>：</p>
            <ul>
                <li>不会删除原始聊天消息，仅仅是取消收藏标记。</li>
                <li>取消后该消息的星标图标恢复为空心状态。</li>
                <li>操作前会弹出确认对话框，防止误操作。</li>
            </ul>

            <h3>移动端适配</h3>
            <p>在手机等小屏设备上，部分操作按钮会自动隐藏，改为显示一个<strong>“⋯”更多按钮</strong>。点击更多按钮会弹出包含编辑原文、编辑备注、取消收藏的下拉菜单。</p>
        `,
        preview: `
            <h2>👁️ 预览模式</h2>
            <p>预览模式让你<strong>无需离开当前聊天</strong>，就能在聊天区域中查看收藏消息的上下文。这是一个非常实用的功能，尤其适合回顾剧情。</p>

            <h3>如何进入预览模式</h3>
            <ol>
                <li>打开收藏面板（点击魔法棒🪄中的“收藏”按钮）。</li>
                <li>找到你想预览的收藏消息。</li>
                <li>点击该条收藏右下角的<strong>👁️预览按钮</strong>。</li>
                <li>收藏面板会自动关闭，聊天区域变为预览模式。</li>
            </ol>

            <h3>在预览模式中操作</h3>
            <ul>
                <li>聊天区域会显示收藏消息及其附近的消息（范围取决于上下文范围设置）。</li>
                <li>右侧会出现<strong>两个浮动按钮</strong>：
                    <ul>
                        <li><i class="fa-solid fa-eye"></i> <strong>面板按钮</strong> — 点击可快速打开收藏面板，切换查看另一条收藏。</li>
                        <li><i class="fa-solid fa-camera"></i> <strong>截图按钮</strong> — 弹出消息选择器，勾选后截取消息为图片。</li>
                    </ul>
                </li>
                <li>页面底部的输入框会被替换为<strong>“结束预览”按钮</strong>。</li>
                <li>在预览模式中点击另一条收藏的预览按钮，可以<strong>无缝切换</strong>预览内容。</li>
            </ul>

            <h3>退出预览模式</h3>
            <ul>
                <li>点击底部的<strong>“结束预览”</strong>按钮。</li>
                <li><strong>切换聊天</strong>也会自动退出预览（预览模式下按 Escape 键不会退出，Escape 只用于关闭各类弹窗）。</li>
                <li>退出后，聊天区域恢复为正常的聊天状态。</li>
            </ul>

            <h3>上下文范围设置</h3>
            <p>预览模式固定加载收藏消息<strong>附近共 5 条</strong>消息。如需调整查看上下文（<i class="fa-solid fa-expand"></i>）弹窗中显示的消息条数，可通过设置修改：</p>
            <ul>
                <li>默认值为 <strong>1</strong>，代表消息前后各 1 条（共 3 条）。</li>
                <li>设为 <strong>0</strong> 则只显示收藏消息本身。</li>
                <li>可通过"设置 → 修改上下文范围"来调整。</li>
            </ul>
        `,
        screenshot: `
            <h2>📷 截图功能</h2>
            <p>截图功能可以将收藏的消息渲染为<strong>精美的图片</strong>，方便分享或保存。截图使用的是前端 Canvas 渲染技术，可以自定义字体效果。</p>

            <h3>如何使用截图功能</h3>
            <ol>
                <li>首先进入<strong>预览模式</strong>（点击收藏消息的预览按钮）。</li>
                <li>点击右侧浮动按钮中的<strong>相机图标</strong> <i class="fa-solid fa-camera"></i>。</li>
                <li>在弹出的对话框中<strong>勾选</strong>想要截取的消息。</li>
                <li>点击<strong>“截取”</strong>按钮生成图片。</li>
            </ol>

            <h3>截图设置（缓存管理）</h3>
            <p>截图功能会下载并使用<strong>中文字体子集</strong>来渲染消息，字体文件和截图中的图片都会被缓存到浏览器中：</p>
            <ul>
                <li>在“设置 → 截图设置”中可查看字体缓存和图片缓存的占用空间。</li>
                <li>可以<strong>单独删除</strong>某个字体集或某个图片缓存。</li>
                <li>可以<strong>一键清空</strong>全部字体或图片缓存。</li>
                <li>清空后下次截图会自动重新下载所需资源。</li>
            </ul>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>字体缓存可以显著加速截图的渲染速度。如果存储空间充足，建议保留缓存以提高体验。截图时当前使用的字体集会标注“当前使用”。
            </div>
        `,
        settings: `
            <h2>🎨 主题与设置</h2>

            <h3>切换主题</h3>
            <p>收藏器支持<strong>亮色</strong>和<strong>暗色</strong>两种主题：</p>
            <ol>
                <li>点击收藏面板左侧边栏底部的<strong>太阳/月亮图标</strong>（位于「切换角色」按钮下方、AI 答疑气泡图标左侧）。</li>
                <li>主题会立即切换并自动保存，下次打开时保持你的选择。</li>
            </ol>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>暗色主题在夜间使用时更护眼，且文本对比度经过专门优化。主题切换会同步应用到收藏面板和上下文查看窗口。
            </div>

            <h3>修改上下文范围</h3>
            <p>调整预览上下文和上下文查看器显示的消息数量：</p>
            <ul>
                <li>默认值：<strong>1</strong>（前后各 1 条，共 3 条消息）。</li>
                <li>最小值：<strong>0</strong>（只显示收藏消息本身）。</li>
                <li>建议设置在 0~5 之间，过大的值会加载过多消息影响性能。</li>
            </ul>
            <p>此设置<strong>仅影响</strong>上下文查看器（<i class="fa-solid fa-expand"></i>）中的消息显示范围。预览模式固定加载附近共 5 条消息。</p>

            <h3>修改每页显示收藏数</h3>
            <p>调整收藏面板中每页展示的收藏条目数量：</p>
            <ul>
                <li>默认值：<strong>10</strong> 条/页。</li>
                <li>范围：<strong>1~50</strong> 条/页。</li>
                <li>建议设置在 5~30 之间，过大的值可能影响加载性能。</li>
                <li>修改后会自动翻到第一页并刷新视图。</li>
            </ul>

            <h3>日志面板</h3>
            <p>收藏器内置了<strong>调试日志面板</strong>，用于排查问题：</p>
            <ul>
                <li>在设置菜单中点击"启用日志面板"，页面左侧会出现一个 <i class="fa-solid fa-bug"></i> 图标。</li>
                <li>点击 Bug 图标打开日志窗口，可查看运行日志。</li>
                <li>支持按日志级别筛选（INFO/SUCCESS/WARN/ERROR/DEBUG）。</li>
                <li>可下载日志文件或清空日志记录。</li>
                <li>日志窗口右上角：点击 <strong>- 最小化</strong> 可收起弹窗（保留 Bug 图标，可随时再点开）；点击 <strong>X 关闭</strong> 则彻底关闭日志面板并隐藏 Bug 图标。</li>
            </ul>
        `,
        update: `
            <h2>🔄 更新插件</h2>
            <p>当检测到插件有新版本时，“收藏”按钮旁会出现一个<strong>红色的“可更新”按钮</strong>。</p>

            <h3>更新步骤</h3>
            <ol>
                <li>点击“可更新”按钮。</li>
                <li>查看<strong>更新日志</strong>，了解新版本带来的变化。</li>
                <li>按照提示完成更新。</li>
            </ol>
            <div class="star-guide-tip">
                <strong>💡 提示：</strong>更新后建议<strong>刷新页面</strong>以确保新版本完全生效。如果更新后遇到问题，可以尝试清除浏览器缓存后刷新。
            </div>
        `,
        faq: `
            <h2>❓ 常见问题</h2>

            <h3>Q: 收藏的数据存储在哪里？</h3>
            <p>收藏数据存储在<strong>聊天文件</strong>（<code>.jsonl</code>）中每条消息的 <code>swipe_info</code> 结构里（<code>swipe_info[swipeId].star_favorite</code>），与聊天记录一同保存在 SillyTavern 服务端的 <code>chats/</code> 目录下。界面上的 <code>chatMetadata.favorites</code> 只是运行时虚拟缓存，不会写入文件。插件设置（主题、每页数量等）则保存在 <code>settings_extension</code> 中。</p>
            <p>删除聊天文件会导致该聊天的收藏数据一并丢失，请定期备份。</p>

            <h3>Q: 为什么有些消息没有星标图标？</h3>
            <p>检查以下几点：</p>
            <ul>
                <li>确保插件已正确加载（魔法棒🪄中能看到“收藏”按钮）。</li>
                <li>尝试刷新页面。</li>
                <li>如果只有部分消息缺少星标，可能是页面渲染延迟，尝试滚动聊天区域触发重新渲染。</li>
            </ul>

            <h3>Q: 收藏面板中的消息显示“原始消息内容不可用”？</h3>
            <p>这通常是因为该收藏来自<strong>其他聊天</strong>，而当前上下文中无法直接获取到该聊天的消息数据。数据会在后台异步加载，稍等片刻刷新即可。如果持续显示此提示，可能是该聊天文件已被删除。</p>

            <h3>Q: 收藏能在不同设备间同步吗？</h3>
            <p>收藏数据存储在 SillyTavern 的<strong>聊天文件</strong>中，不会自动跨设备同步。如需在多设备间共享，使用 SillyTavern 自带的<strong>下载备份</strong>功能即可：在原设备下载备份，在新设备导入备份，收藏数据会随聊天记录一并迁移。</p>

            <h3>Q: 预览模式和正常模式有什么区别？</h3>
            <p>预览模式会<strong>临时替换</strong>聊天区域的显示内容，让你查看收藏消息的上下文。在预览模式中<strong>不能发送新消息</strong>，也不会影响正常的聊天记录。退出预览后一切恢复原状。</p>

            <h3>Q: 截图功能无法正常使用怎么办？</h3>
            <p>尝试以下步骤：</p>
            <ul>
                <li>检查浏览器控制台是否有错误日志（可通过日志面板查看）。</li>
                <li>尝试在“截图设置”中清空字体缓存和图片缓存。</li>
                <li>确认网络连接正常（字体文件需要在线下载）。</li>
                <li>尝试刷新页面后重试。</li>
            </ul>

            <h3>Q: 如何反馈问题或提出建议？</h3>
            <p>如果你有任何问题、建议或发现了 Bug，可以直接在<strong>“类脑/旅程”社区</strong>中搜索<strong>“聊天收藏器”</strong>进入帖子进行反馈！</p>
        `,
    }

export function showUsageGuidePopup() {
    // 防止重复创建：必须走完整清理（摘掉 resize / Esc 监听），否则每重开一次泄漏一对
    const existing = document.getElementById('star-guide-overlay');
    if (existing) {
        if (typeof existing._starClose === 'function') existing._starClose();
        existing.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'star-guide-overlay';
    overlay.className = 'star-guide-overlay';

    // 判断是否移动端（<=768px 视为移动端）
    const isMobile = window.innerWidth <= 768;

    // 构建侧栏导航 HTML
    const sidebarNavHtml = sections.map(s => `
        <div class="star-guide-nav-item" data-section="${s.id}">
            <i class="fa-solid ${s.icon}"></i>
            <span>${s.title}</span>
        </div>
    `).join('');

    const dialog = document.createElement('div');
    // id 必须存在：ui/main.js 的 Esc 层级表与 ui/scope.js 的作用域名单都按
    // getElementById('star-guide-dialog') 查找。此前只有同名 class，导致「使用说明」
    // 打开时按一次 Esc 会直接关掉它背后的收藏面板（两层一起消失）。
    dialog.id = 'star-guide-dialog';
    dialog.className = 'star-guide-dialog';
    if (isMobile) dialog.classList.add('sidebar-closed');
    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        dialog.dataset.starTheme = 'dark';
    }
    dialog.innerHTML = `
        <div class="star-guide-header">
            <div class="star-guide-hamburger" title="${isMobile ? '展开导航' : '折叠导航'}">
                <i class="fa-solid fa-bars"></i>
            </div>
            <div class="star-guide-title">使用说明</div>
            <div class="star-guide-close-btn"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="star-guide-body">
            <div class="star-guide-sidebar">
                <div class="star-guide-sidebar-nav">
                    ${sidebarNavHtml}
                </div>
            </div>
            <div class="star-guide-sidebar-overlay"></div>
            <div class="star-guide-main">
                <div class="star-guide-content" id="star-guide-content">
                    ${sectionContents['welcome']}
                </div>
            </div>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 当前选中的章节 ID
    let currentSection = 'welcome';

    // 使用 let 声明，后续会替换为带完整清理的版本
    let closeOverlay = () => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    };

    // 切换侧栏
    const hamburger = dialog.querySelector('.star-guide-hamburger');
    const sidebarOverlayEl = dialog.querySelector('.star-guide-sidebar-overlay');

    const toggleSidebar = () => {
        dialog.classList.toggle('sidebar-closed');
    };

    hamburger.addEventListener('click', toggleSidebar);
    sidebarOverlayEl.addEventListener('click', toggleSidebar);

    // 关闭事件
    dialog.querySelector('.star-guide-close-btn').addEventListener('click', () => closeOverlay());
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
    });

    // ESC 关闭
    const handleEsc = (e) => {
        if (e.key === 'Escape') {
            closeOverlay();
        }
    };
    document.addEventListener('keydown', handleEsc);

    // 侧栏导航点击
    const navItems = dialog.querySelectorAll('.star-guide-nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const sectionId = item.dataset.section;
            if (sectionId && sectionContents[sectionId] && sectionId !== currentSection) {
                currentSection = sectionId;
                // 更新导航高亮
                navItems.forEach(n => n.classList.remove('active'));
                item.classList.add('active');
                // 更新内容
                const contentEl = dialog.querySelector('#star-guide-content');
                if (contentEl) {
                    contentEl.innerHTML = sectionContents[sectionId];
                    contentEl.scrollTop = 0;
                }
                // 移动端自动收起侧栏
                if (window.innerWidth <= 768) {
                    dialog.classList.add('sidebar-closed');
                }
                // 内容高度变化后重新居中，避免弹窗只向下伸展
                if (window.innerWidth > 768) {
                    centerGuideDialog();
                }
            }
        });
    });

    // 默认选中第一个导航项
    if (navItems.length > 0) {
        navItems[0].classList.add('active');
    }

    // 窗口大小变化时更新响应式状态 + 桌面端重新居中
    const centerGuideDialog = () => {
        // 移动端不需要 JS 定位（CSS 全屏处理）
        if (window.innerWidth <= 768) return;
        const dw = dialog.offsetWidth;
        const dh = dialog.offsetHeight;
        const ww = window.innerWidth;
        const wh = window.innerHeight;
        dialog.style.left = `${Math.max(0, (ww - dw) / 2)}px`;
        dialog.style.top = `${Math.max(0, (wh - dh) / 2)}px`;
    };

    const handleResize = () => {
        const nowMobile = window.innerWidth <= 768;
        if (nowMobile) {
            if (!dialog.classList.contains('sidebar-closed')) {
                dialog.classList.add('sidebar-closed');
            }
        } else {
            // 桌面端重新居中
            centerGuideDialog();
        }
    };
    window.addEventListener('resize', handleResize);

    // 替换 closeOverlay 为完整清理版本（此时所有局部引用已通过闭包捕获）
    closeOverlay = () => {
        window.removeEventListener('resize', handleResize);
        document.removeEventListener('keydown', handleEsc);
        overlay._starClose = null;
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    };
    // 供「重复打开」路径调用完整清理
    overlay._starClose = () => closeOverlay();

    // 显示弹窗：先确保渲染（opacity:0 防闪），测量居中后再展示
    dialog.style.opacity = '0';
    overlay.classList.add('visible');
    requestAnimationFrame(() => {
        centerGuideDialog();
        dialog.style.opacity = '';
    });
}// =================================================================
//                   截图设置弹窗
// =================================================================


export async function showScreenshotSettingsPopup() {
    const existing = document.getElementById('star-ss-settings-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'star-ss-settings-overlay';
    overlay.className = 'star-ss-settings-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'star-ss-settings-dialog';
    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        dialog.dataset.starTheme = 'dark';
    }
    dialog.innerHTML = `
        <div class="star-ss-header">
            <div class="star-ss-title">截图设置 — 缓存管理</div>
            <div class="star-ss-close-btn"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="star-ss-body" id="star-ss-body">
            <div class="star-ss-loading"><i class="fa-solid fa-spinner fa-spin"></i> 正在从缓存读取字体数据...</div>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeOverlay = () => {
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
    });
    dialog.querySelector('.star-ss-close-btn').addEventListener('click', closeOverlay);

    // 立即显示弹窗（CSS flex 自动垂直居中）
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // 异步加载数据
    await renderScreenshotCacheUI(dialog);
}

async function renderScreenshotCacheUI(dialog) {
    const bodyEl = document.getElementById('star-ss-body');
    // 浮层可能在异步读取/删除期间被关闭；此时直接放弃渲染，避免对 null 取属性抛错
    if (!bodyEl) return;

    try {
        const stats = await getFontCacheStats();

        let html = '';

        // ── 字体集列表（始终展开）──
        const fontCount = stats.totals.fontSetCount;
        const fontSizeMB = (stats.totals.fontBytes / (1024 * 1024)).toFixed(1);
        if (stats.fontSets.length === 0) {
            html += `<div class="star-ss-section">
                <div class="star-ss-section-title star-ss-section-title-row">
                    <span>🔤 字体缓存（${fontCount}个/${fontSizeMB}MB）</span>
                    <button class="star-ss-clear-all-btn menu_button" data-action="clear-fonts" title="清空所有字体缓存" disabled><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>`;
            html += '<div class="star-ss-empty">暂无字体缓存（截图时会自动下载需要的子集）</div>';
        } else {
            html += `<div class="star-ss-section">
                <div class="star-ss-section-title star-ss-section-title-row">
                    <span>🔤 字体缓存（${fontCount}个/${fontSizeMB}MB）</span>
                    <button class="star-ss-clear-all-btn menu_button" data-action="clear-fonts" title="清空所有字体缓存"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>`;

            for (const set of stats.fontSets) {
                const setId = 'star-ss-set-' + set.id.replace(/[^a-zA-Z0-9]/g, '-');
                const activeBadge = set.isActive ? ' <span class="star-ss-active-badge">当前使用</span>' : '';
                html += `
                <div class="star-ss-set-card" data-set-id="${escapeHtml(set.id)}">
                    <div class="star-ss-set-header" data-toggle="${setId}">
                        <span class="star-ss-set-label">${escapeHtml(set.label)}${activeBadge}</span>
                        <span class="star-ss-set-summary">${formatBytes(set.totalBytes)}</span>
                    </div>
                    <div class="star-ss-set-body" id="${setId}">
                        <div class="star-ss-table">
                            <div class="star-ss-table-header">
                                <span class="star-ss-col-name">文件名</span>
                                <span class="star-ss-col-size">大小</span>
                            </div>
                            ${set.files.map(f => {
                                const sizeClass = f.sizeBytes > 500 * 1024 ? 'star-ss-size-large' : f.sizeBytes > 100 * 1024 ? 'star-ss-size-medium' : '';
                                return `
                                <div class="star-ss-table-row">
                                    <span class="star-ss-col-name" title="${escapeHtml(f.url)}">${escapeHtml(f.name)}</span>
                                    <span class="star-ss-col-size ${sizeClass}">${formatBytes(f.sizeBytes)}</span>
                                </div>`;
                            }).join('')}
                        </div>
                    </div>
                </div>`;
            }
        }

        // ── 图片 ──
        const imgCount = stats.totals.imageCount;
        const imgSizeMB = (stats.totals.imageBytes / (1024 * 1024)).toFixed(1);
        html += `<div class="star-ss-section star-ss-section-spaced">
            <div class="star-ss-section-title star-ss-section-title-row">
                <span>🖼️ 图片缓存（${imgCount}个/${imgSizeMB}MB）</span>
                <button class="star-ss-clear-all-btn menu_button" data-action="clear-images" title="清空所有图片缓存"${stats.images.length === 0 ? ' disabled' : ''}><i class="fa-solid fa-trash-can"></i></button>
            </div>
        </div>`;
        if (stats.images.length > 0) {
            html += `<div class="star-ss-table">
                <div class="star-ss-table-header">
                    <span class="star-ss-col-name">文件名</span>
                    <span class="star-ss-col-size">大小</span>
                </div>
                ${stats.images.map(im => {
                    const esc = escapeHtml(im.url);
                    return `
                    <div class="star-ss-table-row star-ss-img-row" data-img-url="${esc}">
                        <span class="star-ss-col-name" title="${esc}">${escapeHtml(im.name)}</span>
                        <span class="star-ss-col-size">${formatBytes(im.sizeBytes)}</span>
                    </div>`;
                }).join('')}
            </div>`;
        }

        bodyEl.innerHTML = html;

        // ── 长按辅助函数 ──
        const setupLongPress = (element, callback, duration = 600) => {
            let timer = null;
            let isLongPress = false;

            const clear = () => {
                if (timer) { clearTimeout(timer); timer = null; }
            };

            element.addEventListener('pointerdown', (e) => {
                isLongPress = false;
                timer = setTimeout(() => {
                    isLongPress = true;
                    callback(e);
                }, duration);
            });

            element.addEventListener('pointerup', clear);
            element.addEventListener('pointerleave', clear);
            element.addEventListener('pointercancel', clear);

            // 阻止文本选择和右键菜单干扰长按
            element.addEventListener('contextmenu', (e) => {
                if (isLongPress) e.preventDefault();
            });

            // 返回用于判断是否长按（供 click 事件使用）
            return { wasLongPress: () => isLongPress };
        };

        // ── 字体集：点击展开/折叠（仅标题栏区域）──
        bodyEl.querySelectorAll('.star-ss-set-header[data-toggle]').forEach(hdr => {
            hdr.addEventListener('click', (e) => {
                // 不拦截长按
                e.stopPropagation();
                const body = document.getElementById(hdr.dataset.toggle);
                body?.classList.toggle('expanded');
            });
        });

        // ── 字体集：长按删除 ──
        bodyEl.querySelectorAll('.star-ss-set-card').forEach(card => {
            const setId = card.dataset.setId;
            const set = stats.fontSets.find(s => s.id === setId);
            if (!set) return;

            setupLongPress(card, async () => {
                const ok = await showConfirmModal(
                    `确定要删除「${set.label}」的全部 ${set.fileCount} 个缓存文件吗？<br><small>${formatBytes(set.totalBytes)} 将被释放</small>`,
                    '删除字体集',
                    { noBorder: true, okButton: '确认', zIndex: 10004 }
                );
                if (ok) {
                    try {
                        await deleteFontCacheEntries(set.files.map(f => f.url));
                        await renderScreenshotCacheUI(dialog);
                        toastr.success(`已删除字体集: ${set.label}`);
                    } catch (error) {
                        Logger.error('删除字体集失败:', error);
                        toastr.error(`删除字体集失败：${error?.message || '未知错误'}`);
                    }
                }
            });
        });

        // ── 图片行：长按删除 → 单击预览 ──
        bodyEl.querySelectorAll('.star-ss-img-row').forEach(row => {
            const imgUrl = row.dataset.imgUrl;
            if (!imgUrl) return;

            // 提取文件名
            const imgName = (() => {
                try { return new URL(imgUrl, window.location.origin).pathname.split('/').pop() || imgUrl.substring(0, 40); }
                catch { return imgUrl.substring(imgUrl.lastIndexOf('/') + 1) || imgUrl.substring(0, 40); }
            })();

            let didLongPress = false;
            let timer = null;

            const clearTimer = () => {
                if (timer) { clearTimeout(timer); timer = null; }
            };

            row.addEventListener('pointerdown', () => {
                didLongPress = false;
                clearTimer();
                timer = setTimeout(() => {
                    didLongPress = true;
                    timer = null;
                    // 长按：直接在回调中弹出删除确认弹窗
                    showConfirmModal(`确认删除「${imgName}」图片缓存吗？`, '删除图片缓存', { noBorder: true, okButton: '确认', zIndex: 10004 }).then(async (ok) => {
                        if (ok) {
                            try {
                                await deleteImageCacheEntry(imgUrl);
                                await renderScreenshotCacheUI(dialog);
                                toastr.success('已删除');
                            } catch (error) {
                                Logger.error('删除图片缓存失败:', error);
                                toastr.error(`删除图片缓存失败：${error?.message || '未知错误'}`);
                            }
                        }
                    });
                }, 600);
            });

            row.addEventListener('pointerup', clearTimer);
            row.addEventListener('pointerleave', clearTimer);
            row.addEventListener('pointercancel', clearTimer);

            // 阻止右键菜单
            row.addEventListener('contextmenu', (e) => {
                if (didLongPress) e.preventDefault();
            });

            // 单击：预览图片（仅短按触发）
            row.addEventListener('click', async () => {
                if (didLongPress) return;
                try {
                    const dataUrl = await getImageDataUrl(imgUrl);
                    if (dataUrl) {
                        showImagePreviewModal(dataUrl, imgUrl);
                    } else {
                        toastr.warning('图片缓存数据不可用');
                    }
                } catch (err) {
                    Logger.debug('加载图片缓存失败:', err);
                    toastr.error('加载图片失败');
                }
            });
        });

        // ── 清空全部按钮事件 ──
        bodyEl.querySelectorAll('.star-ss-clear-all-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                if (action === 'clear-fonts') {
                    const ok = await showConfirmModal('确定要清空所有字体缓存吗？下次截图需要重新下载字体。', '清空字体缓存', { noBorder: true, okButton: '确认', zIndex: 10004 });
                    if (ok) {
                        try {
                            await clearAllFontCache();
                            await renderScreenshotCacheUI(dialog);
                            toastr.success('字体缓存已清空');
                        } catch (error) {
                            Logger.error('清空字体缓存失败:', error);
                            toastr.error(`清空字体缓存失败：${error?.message || '未知错误'}`);
                        }
                    }
                } else if (action === 'clear-images') {
                    const ok = await showConfirmModal('确定要清空所有图片缓存吗？', '清空图片缓存', { noBorder: true, okButton: '确认', zIndex: 10004 });
                    if (ok) {
                        try {
                            await clearAllImageCache();
                            await renderScreenshotCacheUI(dialog);
                            toastr.success('图片缓存已清空');
                        } catch (error) {
                            Logger.error('清空图片缓存失败:', error);
                            toastr.error(`清空图片缓存失败：${error?.message || '未知错误'}`);
                        }
                    }
                }
            });
        });

    } catch (err) {
        if (bodyEl) {
            bodyEl.innerHTML = `<div class="star-ss-error">❌ 读取缓存失败: ${escapeHtml(err?.message || err)}</div>`;
        }
        Logger.error('截图设置: 读取缓存失败', err);
    }
}

/**
 * 显示图片预览弹窗
 * （导出供 tests/browser-regression.mjs 验证「关闭后不残留 keydown 监听」）
 */
export function showImagePreviewModal(dataUrl, imgUrl) {
    // 重复打开时走完整清理，避免上一份的 keydown 监听永久残留
    const existing = document.getElementById('star-img-preview-overlay');
    if (existing) {
        if (typeof existing._starClose === 'function') existing._starClose();
        existing.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'star-img-preview-overlay';
    overlay.className = 'star-img-preview-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'star-img-preview-dialog';
    if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
        dialog.dataset.starTheme = 'dark';
    }

    const fname = (() => {
        try { return new URL(imgUrl, window.location.origin).pathname.split('/').pop() || imgUrl.substring(0, 40); }
        catch { return imgUrl.substring(imgUrl.lastIndexOf('/') + 1) || imgUrl.substring(0, 40); }
    })();

    dialog.innerHTML = `
        <div class="star-img-preview-header">
            <div class="star-img-preview-title">📷 ${escapeHtml(fname)}</div>
            <div class="star-img-preview-close-btn"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="star-img-preview-body">
            <img src="${dataUrl}" alt="${escapeHtml(fname)}" class="star-img-preview-img" />
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const closeOverlay = () => {
        // Esc 监听必须在这里统一摘除：此前只在「按 Esc」那条分支里摘，
        // 用 X 或点遮罩关闭时监听器会永久留在 document 上（开一次泄漏一个）。
        document.removeEventListener('keydown', onEsc);
        overlay._starClose = null;
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    };
    overlay._starClose = closeOverlay;

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
    });
    dialog.querySelector('.star-img-preview-close-btn').addEventListener('click', closeOverlay);

    function onEsc(e) {
        if (e.key === 'Escape') {
            closeOverlay();
        }
    }
    document.addEventListener('keydown', onEsc);

    requestAnimationFrame(() => overlay.classList.add('visible'));
}
