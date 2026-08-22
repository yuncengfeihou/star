// ui/debug.js - 调试日志面板模块

import { state, PLUGIN_NAME } from '../state.js';
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import Logger from '../Logger.js';

const DEBUG_ICON_ID = 'star-debug-icon';
const DEBUG_MODAL_ID = 'star-debug-modal';
const DEBUG_MODAL_CONTAINER_CLASS = 'star-debug-modal-container';
const DEBUG_MODAL_HEADER_CLASS = 'star-debug-modal-header';
const DEBUG_MODEL_TITLE_CLASS = 'star-debug-modal-title';
const DEBUG_MODAL_CLOSE_CLASS = 'star-debug-modal-close';
const DEBUG_MODAL_MINIMIZE_CLASS = 'star-debug-modal-minimize';
const DEBUG_MODAL_BODY_CLASS = 'star-debug-modal-body';
const DEBUG_MODAL_DOWNLOAD_CLASS = 'star-debug-modal-download';
const DEBUG_MODAL_CLEAR_CLASS = 'star-debug-modal-clear';
const DEBUG_FILTER_CLASS = 'star-debug-filter';
const DEBUG_FILTER_SELECT_CLASS = 'star-debug-filter-select';

// 当前筛选级别，默认 'ALL'
let currentFilter = 'ALL';

// =================================================================
//                      DOM 结构创建
// =================================================================

/**
 * 确保调试面板 DOM 结构存在（bug 图标 + 日志弹窗）。
 */
export function ensureDebugPanelStructure() {
    // --- Bug 图标（左侧浮动）---
    if (!state.debugPanel.iconElement) {
        state.debugPanel.iconElement = document.createElement('div');
        state.debugPanel.iconElement.id = DEBUG_ICON_ID;
        state.debugPanel.iconElement.innerHTML = '<i class="fa-solid fa-bug"></i>';
        state.debugPanel.iconElement.title = '打开调试日志面板';
        state.debugPanel.iconElement.addEventListener('click', openDebugModal);
        document.body.appendChild(state.debugPanel.iconElement);
    }

    // --- 日志弹窗 ---
    if (!state.debugPanel.modalElement) {
        state.debugPanel.modalElement = document.createElement('div');
        state.debugPanel.modalElement.id = DEBUG_MODAL_ID;
        state.debugPanel.modalElement.innerHTML = `
            <div class="${DEBUG_MODAL_CONTAINER_CLASS}">
                <div class="${DEBUG_MODAL_HEADER_CLASS}">
                    <div class="${DEBUG_FILTER_CLASS}">
                        <select class="${DEBUG_FILTER_SELECT_CLASS}">
                            <option value="ALL">ALL</option>
                            <option value="ERROR">ERROR</option>
                            <option value="WARN">WARN</option>
                            <option value="INFO">INFO</option>
                            <option value="SUCCESS">SUCCESS</option>
                            <option value="DEBUG">DEBUG</option>
                        </select>
                    </div>
                    <h3 class="${DEBUG_MODEL_TITLE_CLASS}">调试日志</h3>
                    <div class="${DEBUG_MODAL_CLEAR_CLASS}" title="清空日志">
                        <i class="fa-solid fa-eraser"></i>
                    </div>
                    <div class="${DEBUG_MODAL_DOWNLOAD_CLASS}" title="下载日志">
                        <i class="fa-solid fa-download"></i>
                    </div>
                    <div class="${DEBUG_MODAL_MINIMIZE_CLASS}" title="最小化">
                        <i class="fa-solid fa-minus"></i>
                    </div>
                    <div class="${DEBUG_MODAL_CLOSE_CLASS}" title="关闭"><i class="fa-solid fa-xmark"></i></div>
                </div>
                <div class="${DEBUG_MODAL_BODY_CLASS}"></div>
            </div>
        `;
        document.body.appendChild(state.debugPanel.modalElement);

        state.debugPanel.modalContainer = state.debugPanel.modalElement.querySelector(`.${DEBUG_MODAL_CONTAINER_CLASS}`);
        state.debugPanel.logBodyElement = state.debugPanel.modalElement.querySelector(`.${DEBUG_MODAL_BODY_CLASS}`);

        // 筛选下拉事件
        const filterSelect = state.debugPanel.modalElement.querySelector(`.${DEBUG_FILTER_SELECT_CLASS}`);
        if (filterSelect) {
            filterSelect.addEventListener('change', (e) => {
                currentFilter = e.target.value;
                refreshLogContent();
            });
        }

        // 最小化按钮：收缩至左侧悬浮球状态（隐藏弹窗，保留 bug 图标）
        state.debugPanel.modalElement.querySelector(`.${DEBUG_MODAL_MINIMIZE_CLASS}`).addEventListener('click', minimizeDebugModal);

        // 关闭按钮：彻底关闭弹窗（关闭弹窗并禁用日志面板）
        state.debugPanel.modalElement.querySelector(`.${DEBUG_MODAL_CLOSE_CLASS}`).addEventListener('click', shutdownDebugPanel);

        // 下载按钮
        state.debugPanel.modalElement.querySelector(`.${DEBUG_MODAL_DOWNLOAD_CLASS}`).addEventListener('click', downloadLogs);

        // 清空按钮
        state.debugPanel.modalElement.querySelector(`.${DEBUG_MODAL_CLEAR_CLASS}`).addEventListener('click', clearLogs);

        // 点击遮罩关闭
        state.debugPanel.modalElement.addEventListener('click', (e) => {
            if (e.target === state.debugPanel.modalElement) {
                closeDebugModal();
            }
        });
    }
}

// =================================================================
//                      面板开关
// =================================================================

/**
 * 切换调试日志面板的启用状态。
 */
export function toggleDebugPanel() {
    ensureDebugPanelStructure();

    if (!state.debugPanel.enabled) {
        // 启用：显示 bug 图标，并将日志级别设为 FULL
        state.debugPanel.enabled = true;
        extension_settings[PLUGIN_NAME].debugPanelEnabled = true;
        saveSettingsDebounced();
        state.debugPanel.iconElement.style.display = 'flex';
        Logger.setLogLevel(3); // LogLevel.FULL = 3
        Logger.info('🔍 调试日志面板已启用');
        toastr.info('调试日志面板已启用，点击左侧 🐛 图标查看日志');
    } else {
        // 已启用：设置页面不再提供「关闭弹窗」功能，改为直接打开弹窗查看日志
        openDebugModal();
    }

    updateDebugMenuText();
}

// =================================================================
//                      弹窗操作
// =================================================================

/**
 * 打开调试日志弹窗。
 */
export function openDebugModal() {
    if (!state.debugPanel.modalElement) {
        ensureDebugPanelStructure();
    }

    // 应用保存的主题
    applyDebugTheme();

    // 刷新日志内容
    refreshLogContent();

    // 居中弹窗（先确保元素已渲染，再计算位置）
    state.debugPanel.modalElement.style.display = 'block';
    centerDebugModal();

    // 入场动画（与截图弹窗一致：RAF 后添加 visible class）
    requestAnimationFrame(() => {
        state.debugPanel.modalElement.classList.add('visible');
    });

    window.addEventListener('resize', centerDebugModal);
    document.addEventListener('keydown', handleDebugEscKey);
}

/**
 * 最小化调试日志弹窗：收缩至左侧悬浮球（bug 图标）状态。
 * 仅隐藏弹窗，保留 bug 图标与面板启用状态，可随时再次点开。
 */
export function minimizeDebugModal() {
    closeDebugModal();
}

/**
 * 彻底关闭调试日志弹窗：关闭弹窗并禁用日志面板（隐藏悬浮球、恢复默认日志级别）。
 * 关闭能力由弹窗内关闭按钮承担，设置页面不再提供「关闭弹窗」入口。
 */
export function shutdownDebugPanel() {
    closeDebugModal();
    if (state.debugPanel.enabled) {
        state.debugPanel.enabled = false;
        extension_settings[PLUGIN_NAME].debugPanelEnabled = false;
        saveSettingsDebounced();
        if (state.debugPanel.iconElement) {
            state.debugPanel.iconElement.style.display = 'none';
        }
        Logger.setLogLevel(2); // 恢复 LogLevel.RUNTIME = 2
        Logger.info('🔍 调试日志面板已关闭');
        updateDebugMenuText();
        toastr.info('调试日志面板已关闭');
    }
}

/**
 * 同步设置菜单中「日志面板」项的文字（如果菜单当前可见）。
 */
function updateDebugMenuText() {
    const menuTextEl = document.getElementById('star-debug-menu-text');
    if (menuTextEl) {
        menuTextEl.textContent = state.debugPanel.enabled ? '日志面板' : '启用日志面板';
    }
}

/**
 * 关闭调试日志弹窗。
 */
export function closeDebugModal() {
    if (state.debugPanel.modalElement) {
        state.debugPanel.modalElement.classList.remove('visible');
        // 等动画结束后隐藏
        setTimeout(() => {
            if (state.debugPanel.modalElement) {
                state.debugPanel.modalElement.style.display = 'none';
            }
        }, 300);
    }

    window.removeEventListener('resize', centerDebugModal);
    document.removeEventListener('keydown', handleDebugEscKey);
}

/**
 * 居中弹窗。
 */
function centerDebugModal() {
    if (!state.debugPanel.modalContainer) return;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const dialogWidth = state.debugPanel.modalContainer.offsetWidth;
    const dialogHeight = state.debugPanel.modalContainer.offsetHeight;
    state.debugPanel.modalContainer.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
    state.debugPanel.modalContainer.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
}

/**
 * 处理 Escape 键关闭。
 */
function handleDebugEscKey(event) {
    if (event.key === 'Escape') {
        closeDebugModal();
    }
}

// =================================================================
//                      日志内容
// =================================================================

/**
 * 刷新日志内容显示。
 */
export function refreshLogContent() {
    if (!state.debugPanel.logBodyElement) return;

    const logText = Logger.getLogText();

    if (!logText) {
        state.debugPanel.logBodyElement.innerHTML = '<div class="star-debug-log-empty">暂无日志记录</div>';
        return;
    }

    // 高亮不同日志级别，并根据筛选条件过滤
    const lines = logText.split('\n');
    const html = lines.map(line => {
        let levelClass = 'star-debug-log-info';
        let levelName = 'INFO';
        if (line.includes('[ERROR]')) { levelClass = 'star-debug-log-error'; levelName = 'ERROR'; }
        else if (line.includes('[WARN]')) { levelClass = 'star-debug-log-warn'; levelName = 'WARN'; }
        else if (line.includes('[SUCCESS]')) { levelClass = 'star-debug-log-success'; levelName = 'SUCCESS'; }
        else if (line.includes('[DEBUG]')) { levelClass = 'star-debug-log-debug'; levelName = 'DEBUG'; }

        // 根据筛选条件过滤
        if (currentFilter !== 'ALL' && levelName !== currentFilter) {
            return '';
        }

        // 转义 HTML 特殊字符
        const escaped = line
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        return `<div class="star-debug-log-line ${levelClass}">${escaped}</div>`;
    }).filter(line => line !== '').join('');

    if (!html) {
        state.debugPanel.logBodyElement.innerHTML = '<div class="star-debug-log-empty">暂无匹配的日志记录</div>';
    } else {
        state.debugPanel.logBodyElement.innerHTML = html;
    }

    // 自动滚动到底部
    state.debugPanel.logBodyElement.scrollTop = state.debugPanel.logBodyElement.scrollHeight;
}

/**
 * 清空日志。
 */
function clearLogs() {
    Logger.clearHistory();
    refreshLogContent();
    toastr.info('日志已清空');
}

/**
 * 下载日志为 txt 文件。
 */
function downloadLogs() {
    const success = Logger.exportLogs();
    if (success) {
        toastr.success('日志文件已开始下载');
    } else {
        toastr.warning('没有可下载的日志');
    }
}

// =================================================================
//                      主题
// =================================================================

/**
 * 应用保存的亮/暗主题到调试弹窗。
 */
export function applyDebugTheme() {
    if (!state.debugPanel.modalContainer) return;

    const savedTheme = extension_settings[PLUGIN_NAME]?.theme || 'light';
    const isDark = savedTheme === 'dark';

    if (isDark) {
        state.debugPanel.modalContainer.dataset.starTheme = 'dark';
    } else {
        state.debugPanel.modalContainer.removeAttribute('data-star-theme');
    }
}

// =================================================================
//                      初始化
// =================================================================

/**
 * 初始化调试面板：读取持久化状态，恢复之前的启用/禁用。
 */
export function initDebugPanel() {
    const wasEnabled = extension_settings[PLUGIN_NAME]?.debugPanelEnabled === true;

    if (wasEnabled) {
        ensureDebugPanelStructure();
        state.debugPanel.enabled = true;
        state.debugPanel.iconElement.style.display = 'flex';
        Logger.setLogLevel(3); // FULL
        Logger.info('🔍 调试日志面板已恢复（上次会话已启用）');
    }
}