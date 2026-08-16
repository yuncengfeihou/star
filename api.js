// api.js - 后端交互与数据获取/保存模块

import { getContext, extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../script.js';
import { timestampToMoment } from '../../../utils.js';
import { state, PLUGIN_NAME, LOCAL_VERSION } from './state.js';
import Logger from './Logger.js';
import { buildVirtualFavorites } from './core.js';

/**
 * 判断错误是否由 AbortController 取消请求导致。
 * 取消属于预期内的流程中断，调用方应静默处理，不应弹错误提示或写入脏数据。
 */
export function isAbortError(error, signal = null) {
    if (!error) return false;
    if (error.name === 'AbortError') return true;
    // 兜底：部分环境下错误名不规范，结合 signal 实际状态判断
    if (signal && signal.aborted) return true;
    return false;
}

const REPO_ROOT = 'https://raw.githubusercontent.com/uhhhh15/star/main';
const MANIFEST_URL = `${REPO_ROOT}/manifest.json`;
const CHANGELOG_URL = `${REPO_ROOT}/CHANGELOG.md`;
const UPDATE_NOTICE_URL = `${REPO_ROOT}/update.html`;

const KEY_LAST_CHECK = `${PLUGIN_NAME}_last_update_check`;
const KEY_UPDATE_INFO = `${PLUGIN_NAME}_update_info`;

let remoteVersion = '0.0.0';
let isUpdateAvailable = false;

// ==================== 更新检查相关函数 ====================

/**
 * 比较两个版本号 (例如 "1.2.3" vs "1.2.4")。
 * @returns {number} 1 (A > B), -1 (A < B), 0 (A === B)
 */
export function compareVersions(versionA, versionB) {
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
 * 从 raw.githubusercontent.com 获取远程文件内容。
 */
async function getRemoteFileContent(url) {
    const response = await fetch(url + `?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
}

/**
 * 获取远程 manifest.json 中的版本号。
 */
async function getRemoteVersion() {
    try {
        const content = await getRemoteFileContent(MANIFEST_URL);
        const manifest = JSON.parse(content);
        return manifest?.version || null;
    } catch (error) {
        Logger.warn('获取远程版本失败:', error);
        return null;
    }
}

/**
 * 主动检测更新（参考 QR 助手的实现）。
 * 24h 内使用 localStorage 缓存的远程版本，避免频繁请求。
 * @param {boolean} force - 是否强制忽略缓存重新请求
 */
export async function checkForUpdates(force = false) {
    const now = Date.now();
    const lastCheck = localStorage.getItem(KEY_LAST_CHECK);

    let usedCache = false;

    // 非强制时，24h 内优先使用缓存的远程版本
    if (!force && lastCheck && (now - parseInt(lastCheck) < 86400000)) {
        const cachedStr = localStorage.getItem(KEY_UPDATE_INFO);
        if (cachedStr) {
            try {
                const cachedObj = JSON.parse(cachedStr);
                if (cachedObj && cachedObj.latestVersion && cachedObj.latestVersion !== 'Check Failed') {
                    remoteVersion = cachedObj.latestVersion;
                    usedCache = true;
                }
            } catch (e) {
                // JSON 解析失败，忽略缓存
            }
        }
    }

    // 未命中缓存或强制刷新时，从网络获取
    if (!usedCache) {
        const remoteVer = await getRemoteVersion();
        if (remoteVer) {
            remoteVersion = remoteVer;
            localStorage.setItem(KEY_LAST_CHECK, now.toString());
        }
    }

    // 实时比对版本号
    isUpdateAvailable = remoteVersion
        ? compareVersions(remoteVersion, LOCAL_VERSION) > 0
        : false;

    // 更新缓存（即使用了缓存也存回去，保持数据一致）
    if (remoteVersion) {
        localStorage.setItem(KEY_UPDATE_INFO, JSON.stringify({
            hasUpdate: isUpdateAvailable,
            latestVersion: remoteVersion,
            localVersion: LOCAL_VERSION,
            checkedAt: usedCache ? parseInt(lastCheck || now) : now,
        }));
    }

    // 更新 UI 指示器
    const btn = document.getElementById('favorites_update_button');
    if (btn) {
        if (isUpdateAvailable) {
            btn.title = `发现新版本: v${remoteVersion}`;
            btn.classList.add('visible');
        } else {
            btn.classList.remove('visible');
        }
    }

    return {
        hasUpdate: isUpdateAvailable,
        latestVersion: remoteVersion || 'Check Failed',
        localVersion: LOCAL_VERSION,
        checkedAt: usedCache ? parseInt(lastCheck || now) : now,
    };
}

/**
 * 自定义 HTML 模态框：更新确认（代替 callGenericPopup）。
 * 参考 star-update-dialog 结构，跟随插件亮/暗主题。
 * @param {string} logHtml - Markdown 渲染后的 changelog HTML
 * @param {string} remoteVer - 远程版本号
 * @returns {Promise<boolean>} true = 用户选择了立即更新
 */
function showUpdateConfirmModal(logHtml, remoteVer) {
    return new Promise((resolve) => {
        const currentTheme = extension_settings[PLUGIN_NAME]?.theme || 'light';

        // 遮罩层
        const overlay = document.createElement('div');
        overlay.className = 'star-update-overlay star-update-confirm-overlay';
        overlay.setAttribute('data-star-theme', currentTheme);

        // 弹窗
        const dialog = document.createElement('div');
        dialog.className = 'star-update-dialog star-update-confirm-dialog';
        dialog.setAttribute('data-star-theme', currentTheme);
        dialog.innerHTML = `
            <div class="star-update-dialog-header">
                <span class="star-update-dialog-title">发现新版本 v${remoteVer}</span>
                <div class="star-update-dialog-close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="star-update-dialog-body">
                <div class="star-changelog-container">${logHtml}</div>
            </div>
            <div class="star-update-dialog-footer" style="justify-content: center;">
                <button class="star-confirm-btn-ok">立即更新</button>
            </div>
        `;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        // 居中
        const center = () => {
            const ww = window.innerWidth, wh = window.innerHeight;
            const dw = dialog.offsetWidth, dh = dialog.offsetHeight;
            dialog.style.left = `${Math.max(0, (ww - dw) / 2)}px`;
            dialog.style.top = `${Math.max(0, (wh - dh) / 2)}px`;
        };
        center();

        // 显示
        requestAnimationFrame(() => overlay.classList.add('visible'));

        const onResize = () => center();
        window.addEventListener('resize', onResize);

        // 清理
        const cleanup = () => {
            overlay.classList.remove('visible');
            window.removeEventListener('resize', onResize);
            setTimeout(() => overlay.remove(), 250);
        };

        // 关闭事件
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { cleanup(); resolve(false); }
        });
        dialog.querySelector('.star-update-dialog-close').addEventListener('click', () => {
            cleanup(); resolve(false);
        });
        dialog.querySelector('.star-confirm-btn-ok').addEventListener('click', () => {
            cleanup(); resolve(true);
        });

        // ESC 关闭
        const onKey = (e) => {
            if (e.key === 'Escape') {
                cleanup(); resolve(false);
                document.removeEventListener('keydown', onKey);
            }
        };
        document.addEventListener('keydown', onKey);
    });
}

/**
 * 简易 Markdown 转 HTML 渲染器。
 * 支持：标题、粗体、斜体、无序列表、行内代码、代码块、链接、水平线。
 * @param {string} md - Markdown 原始文本
 * @returns {string} HTML
 */
function renderMarkdown(md) {
    if (!md) return '';
    let html = md;

    // 保护行内代码和代码块，避免被后续规则干扰
    const codeBlocks = [];
    const inlineCodes = [];

    // 代码块 ```...```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const escaped = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
        return `\u0000CODEBLOCK${idx}\u0000`;
    });

    // 行内代码 `...`
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        const idx = inlineCodes.length;
        const escaped = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        inlineCodes.push(`<code>${escaped}</code>`);
        return `\u0000INLINECODE${idx}\u0000`;
    });

    // HTML 转义（排除占位符）
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // 粗体 **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 斜体 *text*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 链接 [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 标题（按行处理）
    const lines = html.split('\n');
    const result = [];
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // 标题
        const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (hMatch) {
            if (inList) { result.push('</ul>'); inList = false; }
            const level = hMatch[1].length;
            result.push(`<h${level}>${hMatch[2]}</h${level}>`);
            continue;
        }

        // 水平线
        if (/^[-*_]{3,}\s*$/.test(line.trim())) {
            if (inList) { result.push('</ul>'); inList = false; }
            result.push('<hr>');
            continue;
        }

        // 无序列表
        const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
        if (ulMatch) {
            if (!inList) { result.push('<ul>'); inList = true; }
            result.push(`<li>${ulMatch[2]}</li>`);
            continue;
        }

        // 普通行：如果之前有列表，先关闭
        if (inList && line.trim() === '') {
            // 空行不关闭列表（markdown 中列表项之间的空行是允许的）
            continue;
        }
        if (inList && line.trim() !== '') {
            result.push('</ul>');
            inList = false;
        }

        if (line.trim() === '') {
            result.push('<br>');
        } else {
            result.push(line);
        }
    }
    if (inList) result.push('</ul>');

    html = result.join('\n');

    // 恢复行内代码
    html = html.replace(/\u0000INLINECODE(\d+)\u0000/g, (_, idx) => inlineCodes[parseInt(idx)]);
    // 恢复代码块
    html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, idx) => codeBlocks[parseInt(idx)]);

    return html;
}

/**
 * 处理整个更新流程：显示日志 -> 确认 -> 调用后端 API -> 刷新。
 */
export async function handleUpdate() {
    let updatingToast = null;
    try {
        // 显示加载提示
        const loadingToast = toastr.info('正在拉取插件【聊天生成器】更新弹窗……', '', {
            timeOut: 3000, extendedTimeOut: 0, tapToDismiss: false,
        });

        // 先确保获取到远程版本号
        if (!remoteVersion || remoteVersion === '0.0.0') {
            const result = await checkForUpdates(true);
            if (!result.hasUpdate) {
                toastr.clear(loadingToast);
                toastr.info('当前已是最新版本。');
                return;
            }
        }

        // 获取更新日志
        let changelogText = '无法获取更新日志。';
        try {
            changelogText = await getRemoteFileContent(CHANGELOG_URL);
        } catch (e) {
            Logger.warn('获取更新日志失败:', e);
        }

        // 使用 Markdown 渲染更新日志
        const logHtml = renderMarkdown(changelogText);

        // 清除加载提示，显示更新弹窗
        toastr.clear(loadingToast);

        // 自定义 HTML 模态框（跟随主题）
        const confirmed = await showUpdateConfirmModal(logHtml, remoteVersion);

        if (!confirmed) {
            toastr.info('更新已取消。');
            return;
        }

        updatingToast = toastr.info('正在请求后端更新插件，请不要关闭或刷新页面...', '正在更新', {
            timeOut: 0, extendedTimeOut: 0, tapToDismiss: false,
        });

        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: PLUGIN_NAME,
                global: true,
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`更新失败，服务器返回状态: ${response.status}. 详情: ${errorText}`);
        }

        const result = await response.json();

        if (result.isUpToDate) {
            toastr.warning('插件已经是最新版本。');
        } else {
            // 更新成功后清除缓存
            localStorage.removeItem(KEY_LAST_CHECK);
            localStorage.removeItem(KEY_UPDATE_INFO);

            extension_settings[PLUGIN_NAME].lastSeenVersion = LOCAL_VERSION;
            saveSettingsDebounced();

            toastr.success('更新成功！3秒后将自动刷新页面...', '更新完成', { timeOut: 3000 });
            setTimeout(() => location.reload(), 3000);
        }

    } catch (error) {
        Logger.error('更新失败:', error);
        if (error.message && error.message.includes('更新失败')) {
            toastr.error(error.message, '更新出错');
        } else {
            toastr.error('更新请求发生错误，请查看控制台日志。', '更新出错');
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
export function shouldShowUpdateNotice() {
    if (!extension_settings[PLUGIN_NAME] || !extension_settings[PLUGIN_NAME].lastSeenVersion) {
        return false;
    }
    return compareVersions(LOCAL_VERSION, extension_settings[PLUGIN_NAME].lastSeenVersion) > 0;
}

/**
 * 将更新标记为已读并关闭独立弹窗。
 */
export function markUpdateAsSeen() {
    if (shouldShowUpdateNotice()) {
        extension_settings[PLUGIN_NAME].lastSeenVersion = LOCAL_VERSION;
        saveSettingsDebounced();
    }
    // 关闭可能残留的更新弹窗
    const overlay = document.getElementById('star-update-overlay');
    if (overlay) overlay.remove();
}

/**
 * 以独立弹窗显示更新日志。
 * 优先从远程获取 update.html，失败时使用内联 fallback。
 * @param {function} onClose - 弹窗关闭后的回调（用户点击关闭或遮罩）
 */
export async function showUpdateNoticeDialog(onClose) {
    // 如果已有弹窗则先移除
    const existing = document.getElementById('star-update-overlay');
    if (existing) existing.remove();

    let contentHtml = '';
    try {
        contentHtml = await getRemoteFileContent(UPDATE_NOTICE_URL);
    } catch (e) {
        // 远程获取失败，使用内联 fallback（与 update.html 保持一致）
        Logger.warn('获取远程 update.html 失败，使用内置更新日志');
        contentHtml = `<div class="star-update-wrapper">
  <div class="star-update-head">
    <div class="star-update-version-line"><span class="star-update-dot"></span>v2.2.0</div>
    <p class="star-update-sub">收藏插件最近更新了以下内容：</p>
  </div>
  <div class="star-update-section">
    <div class="star-update-label">体验优化</div>
    <ul class="star-update-list">
      <li>分页组件重做，<b>双击页码可输入跳转</b></li>
      <li>每页收藏数默认改为 10 条，可在设置里调整</li>
      <li>暗色主题下，上下文查看的用户气泡改成紫色，更好分辨</li>
      <li>缓存逻辑修了，不再偶尔弹「该收藏不存在」</li>
      <li>预览模式的图标在暗色主题下不会滚没了</li>
    </ul>
  </div>
  <div class="star-update-section">
    <div class="star-update-label">修了俩 bug</div>
    <ul class="star-update-list">
      <li>设置里的「上下文数量」改了不生效，现在好了</li>
      <li>设置页开着的时候按 Esc 会把整个收藏面板关了，现在只关设置页</li>
    </ul>
  </div>
</div>`;
    }

    // 创建遮罩层
    const overlay = document.createElement('div');
    overlay.id = 'star-update-overlay';
    overlay.className = 'star-update-overlay';

    // 读取当前主题并应用到弹窗
    const currentTheme = extension_settings[PLUGIN_NAME]?.theme || 'light';

    // 创建弹窗容器
    const dialog = document.createElement('div');
    dialog.className = 'star-update-dialog';
    dialog.setAttribute('data-star-theme', currentTheme);
    dialog.innerHTML = `
        <div class="star-update-dialog-header">
            <span class="star-update-dialog-title">Star 更新日志</span>
            <div class="star-update-dialog-close"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="star-update-dialog-body">${contentHtml}</div>
        <div class="star-update-dialog-footer">
            <button class="star-update-btn-ok">知道了</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // 居中
    centerUpdateDialog(dialog);

    // 显示
    requestAnimationFrame(() => overlay.classList.add('visible'));

    // 关闭逻辑
    const close = () => {
        overlay.classList.remove('visible');
        // 动画结束后移除 DOM 并回调
        setTimeout(() => {
            overlay.remove();
            window.removeEventListener('resize', onResize);
            markUpdateAsSeen();
            if (typeof onClose === 'function') onClose();
        }, 250);
    };

    const onResize = () => centerUpdateDialog(dialog);
    window.addEventListener('resize', onResize);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    dialog.querySelector('.star-update-dialog-close').addEventListener('click', close);
    dialog.querySelector('.star-update-btn-ok').addEventListener('click', close);

    // ESC 关闭
    const onKey = (e) => {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    // 清理 keydown 监听
    const origClose = close;
    const closeWrapper = () => { document.removeEventListener('keydown', onKey); origClose(); };
    // 替换 overlay click handler 中的 close
    overlay.onclick = (e) => { if (e.target === overlay) closeWrapper(); };
}

/** 弹窗居中 */
function centerUpdateDialog(dialog) {
    const ww = window.innerWidth;
    const wh = window.innerHeight;
    const dw = dialog.offsetWidth;
    const dh = dialog.offsetHeight;
    dialog.style.left = `${Math.max(0, (ww - dw) / 2)}px`;
    dialog.style.top = `${Math.max(0, (wh - dh) / 2)}px`;
}

// ==================== 数据交互函数 ====================

/**
 * 获取所有聊天的收藏数据。
 */
export async function getAllChatFavoritesForCurrentContext(skipCurrentChat = false, options = {}) {
    const context = getContext();
    if (!context) return [];

    const currentContextChatIdNoExt = String(context.chatId || '').replace('.jsonl', '');
    let chatListResponse, requestBody, allFavoritesData = [];

    const processChatList = async (list) => {
        for (const chatMeta of list) {
            // 每轮开始前检查是否已被取消，避免无意义的网络请求继续
            if (options.signal?.aborted) break;
            const chatFileNameWithExt = chatMeta.file_name;
            const chatFileNameNoExt = String(chatFileNameWithExt || '').replace('.jsonl', '');
            if (!chatFileNameNoExt || (skipCurrentChat && chatFileNameNoExt === currentContextChatIdNoExt)) {
                continue;
            }
            let fullChatData;
            try {
                fullChatData = await getFullChatData(context.characterId, context.groupId, chatFileNameNoExt, !!context.groupId, chatMeta, { signal: options.signal });
            } catch (e) {
                // 被取消则中断整个循环；单个聊天加载失败则跳过继续下一个
                if (isAbortError(e, options.signal)) break;
                continue;
            }
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
            chatListResponse = await fetch('/api/chats/search', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
            if (!chatListResponse.ok) throw new Error(`Failed to fetch chat list for group ${context.groupId}: ${chatListResponse.status}`);
            const groupChatsMetadataList = await chatListResponse.json();
            if (Array.isArray(groupChatsMetadataList)) {
                await processChatList(groupChatsMetadataList);
            }
        } catch (error) {
            // 取消属于正常中断，不打错误日志
            if (!isAbortError(error, options.signal)) Logger.error(`Error fetching group chats:`, error);
        }
    } else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) {
        const charObj = context.characters[context.characterId];
        requestBody = { avatar_url: charObj.avatar };
        try {
            chatListResponse = await fetch('/api/characters/chats', { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
            if (!chatListResponse.ok) throw new Error(`Failed to fetch chat list for character ${context.characterId}: ${chatListResponse.status}`);
            const characterChatsArray = await chatListResponse.json();
            if (Array.isArray(characterChatsArray)) {
                await processChatList(characterChatsArray);
            }
        } catch (error) {
            if (!isAbortError(error, options.signal)) Logger.error(`Error fetching character chats:`, error);
        }
    }

    return allFavoritesData;
}

/**
 * 获取完整聊天数据。
 */
export async function getFullChatData(characterId, groupId, chatFileNameNoExt, isGroup, providedMetadata = null, options = {}) {
    Logger.debug(`getFullChatData: chat=${chatFileNameNoExt}, isGroup=${isGroup}`);
    const context = getContext();
    let endpoint, requestBody, finalMetadataObject = { favorites: [] }, messages = [];
    try {
        if (isGroup) {
            if (!groupId) return null;
            endpoint = '/api/chats/group/get';
            requestBody = { id: groupId, chat_id: chatFileNameNoExt };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
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
            if (groupId === context.groupId && chatFileNameNoExt === String(context.chatId || '').replace('.jsonl', '')) {
                finalMetadataObject = JSON.parse(JSON.stringify(context.chatMetadata || { favorites: [] }));
            } else if (providedMetadata) {
                if (typeof providedMetadata.chat_metadata === 'object' && providedMetadata.chat_metadata !== null) {
                    finalMetadataObject = JSON.parse(JSON.stringify(providedMetadata.chat_metadata));
                } else {
                    finalMetadataObject = JSON.parse(JSON.stringify(providedMetadata));
                }
            } else {
                const cachedChat = state.allChatsFavoritesData.find(c => c.isGroup === true && c.groupId === groupId && String(c.fileName).replace('.jsonl', '') === chatFileNameNoExt);
                if (cachedChat && cachedChat.metadata) {
                    finalMetadataObject = JSON.parse(JSON.stringify(cachedChat.metadata));
                }
            }
        } else {
            if (characterId === undefined || characterId === null || !context.characters || !context.characters[characterId]) return null;
            const charObj = context.characters[characterId];
            endpoint = '/api/chats/get';
            requestBody = { ch_name: charObj.name, file_name: chatFileNameNoExt, avatar_url: charObj.avatar };
            const response = await fetch(endpoint, { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(requestBody), signal: options.signal });
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
            finalMetadataObject = {};
        }
        finalMetadataObject.favorites = buildVirtualFavorites(messages);
        return { metadata: finalMetadataObject, messages };
    } catch (error) {
        // 请求被取消时向上抛出，让批量加载的循环能及时中断，而非静默返回空数据继续下一轮
        if (isAbortError(error, options.signal)) throw error;
        Logger.error(`getFullChatData error for "${chatFileNameNoExt}":`, error);
        return { metadata: { favorites: [] }, messages: [] };
    }
}

/**
 * 保存特定聊天的元数据。
 */
export async function saveSpecificChatMetadata(chatFileNameNoExt, metadataToSave, messagesArray = null) {
    Logger.debug(`saveSpecificChatMetadata: chat=${chatFileNameNoExt}`);
    const context = getContext();
    try {
        let chatContentToSave = [];
        // 从缓存查找该聊天所属的角色/群组信息（支持跨角色保存：当前 context 可能并非该收藏所属角色）
        const cachedChat = state.allChatsFavoritesData.find(c => String(c.fileName).replace('.jsonl', '') === String(chatFileNameNoExt).replace('.jsonl', ''));
        const isGroupChat = cachedChat ? !!cachedChat.isGroup : !!context.groupId;
        const targetCharacterId = (cachedChat && cachedChat.characterId !== undefined && cachedChat.characterId !== null) ? cachedChat.characterId : context.characterId;
        const targetGroupId = (cachedChat && cachedChat.groupId !== undefined && cachedChat.groupId !== null) ? cachedChat.groupId : context.groupId;
        let characterName, avatarUrl;
        if (messagesArray === null) {
            const fullChatData = await getFullChatData(targetCharacterId, targetGroupId, chatFileNameNoExt, isGroupChat);
            if (!fullChatData || !fullChatData.messages) {
                toastr.error(`保存收藏夹变动时错误：无法加载聊天消息。`);
                return;
            }
            messagesArray = fullChatData.messages;
        }
        // 剥离虚拟的 favorites 数组，防止其被真实写入 JSONL 导致文件臃肿
        // 同时注入 favorites_count，供 /api/characters/chats 返回聊天元数据时直接筛选
        const metadataClone = JSON.parse(JSON.stringify(metadataToSave));
        const favoritesCount = Array.isArray(metadataToSave.favorites) ? metadataToSave.favorites.length : 0;
        delete metadataClone.favorites;
        metadataClone.favorites_count = favoritesCount;

        const finalMetadataObjectForSave = {
            user_name: context.userAlias || context.name1 || "User",
            character_name: "Unknown",
            create_date: metadataToSave.create_date || timestampToMoment(Date.now()).format('YYYY-MM-DD HH:mm:ss'),
            chat_metadata: metadataClone
        };
        chatContentToSave.push(finalMetadataObjectForSave);
        chatContentToSave.push(...messagesArray);
        let requestBody = { chat: chatContentToSave, file_name: chatFileNameNoExt, force: true };
        if (isGroupChat) {
            if (targetGroupId === undefined || targetGroupId === null) { toastr.error("无法保存群组聊天收藏：群组ID未知。"); return; }
            requestBody.is_group = true;
            requestBody.id = targetGroupId;
            const group = context.groups?.find(g => g.id === targetGroupId);
            finalMetadataObjectForSave.character_name = group ? group.name : "Group Chat";
        } else {
            if (targetCharacterId === undefined || targetCharacterId === null || !context.characters || !context.characters[targetCharacterId]) { toastr.error("无法保存角色聊天收藏：角色信息未知。"); return; }
            const charObj = context.characters[targetCharacterId];
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
        const chatDataInCache = state.allChatsFavoritesData.find(c => c.fileName === chatFileNameNoExt);
        if (chatDataInCache) {
            chatDataInCache.metadata = JSON.parse(JSON.stringify(metadataToSave));
            chatDataInCache.favorites = metadataToSave.favorites || [];
            chatDataInCache.messages = JSON.parse(JSON.stringify(messagesArray));
        }
        // 标记角色收藏缓存过期，下次打开切换器时自动刷新
        state.charactersCacheStale = true;
    } catch (error) {
        Logger.error(`Error in saveSpecificChatMetadata for ${chatFileNameNoExt}`, error);
        toastr.error(`保存聊天 "${chatFileNameNoExt}" 的收藏夹变动时发生错误：${error.message || '未知错误'}`);
    }
}

// ==================== 跨角色全局扫描 ====================

/**
 * 扫描所有角色（含群组），找出含收藏的角色及其收藏数。
 * 用于角色切换器：建立「有收藏的角色」索引，切换时可即时加载。
 * 扫描时一并缓存完整聊天数据（messages + favorites），避免切换时重复请求。
 * @param {function} onProgress - 进度回调 (current, total, charName)
 * @param {object} options - { signal: AbortSignal }
 * @returns {Promise<Array>} [{characterId, name, avatar, isGroup, totalFavorites, chatsWithFavorites}]
 */
export async function scanAllCharactersForFavorites(onProgress, options = {}) {
    const context = getContext();
    if (!context || !context.characters) return [];

    const characters = context.characters;
    const groups = context.groups || [];
    const result = [];

    // --- 角色扫描 ---
    for (let i = 0; i < characters.length; i++) {
        if (options.signal?.aborted) break;
        const ch = characters[i];
        if (!ch || !ch.avatar) {
            onProgress?.(i + 1, characters.length + groups.length, ch?.name || '');
            continue;
        }
        onProgress?.(i + 1, characters.length + groups.length, ch.name);

        // 1) 取该角色的聊天文件列表（轻量，只返回元数据）
        let chatList = [];
        try {
            const resp = await fetch('/api/characters/chats', {
                method: 'POST', headers: getRequestHeaders(),
                body: JSON.stringify({ avatar_url: ch.avatar, metadata: true }),
                signal: options.signal,
            });
            if (resp.ok) {
                const data = await resp.json();
                chatList = Array.isArray(data) ? data : [];
            }
        } catch (e) {
            if (isAbortError(e, options.signal)) break;
            continue;
        }
        if (chatList.length === 0) continue;

        // 2) 根据聊天元数据中的 favorites_count 预过滤：
        //    - count > 0  → 确定有收藏，需加载完整数据缓存
        //    - count === undefined → 旧数据未标记，需回退到逐个检查
        //    - count === 0 → 确定无收藏，跳过（省去一次 /api/chats/get 请求）
        const chatsToCheck = chatList.filter(meta => meta.chat_metadata?.favorites_count !== 0);
        if (chatsToCheck.length === 0) continue;

        const chatsWithFavorites = [];
        await Promise.all(chatsToCheck.map(async (chatMeta) => {
            if (options.signal?.aborted) return;
            const chatFileNameNoExt = String(chatMeta.file_name || '').replace('.jsonl', '');
            if (!chatFileNameNoExt) return;
            try {
                const fullChatData = await getFullChatData(i, null, chatFileNameNoExt, false, chatMeta, { signal: options.signal });
                // 自动修正：元数据 favorites_count 与实际不符（如 ST bug 导致消息无声消失），静默修复
                const metaCount = chatMeta.chat_metadata?.favorites_count;
                const actualCount = fullChatData?.metadata?.favorites?.length || 0;
                if (metaCount !== undefined && metaCount !== actualCount) {
                    Logger.debug(`[auto-fix] favorites_count 不一致: ${chatFileNameNoExt} 元数据=${metaCount} 实际=${actualCount}，已修正`);
                    // 修正内存中的计数，下次保存时自动写入 JSONL
                    if (fullChatData.metadata) fullChatData.metadata.favorites_count = actualCount;
                }
                if (fullChatData && fullChatData.metadata?.favorites?.length > 0) {
                    chatsWithFavorites.push({
                        fileName: chatFileNameNoExt,
                        displayName: chatFileNameNoExt,
                        favoritesCount: fullChatData.metadata.favorites.length,
                        metadata: fullChatData.metadata,
                        messages: fullChatData.messages,
                        favorites: fullChatData.metadata.favorites,
                        last_mes: chatMeta.last_mes || '',
                    });
                }
            } catch (e) {
                if (isAbortError(e, options.signal)) return;
            }
        }));

        if (chatsWithFavorites.length > 0) {
            chatsWithFavorites.sort((a, b) => b.favoritesCount - a.favoritesCount);
            const totalFavorites = chatsWithFavorites.reduce((s, c) => s + c.favoritesCount, 0);
            result.push({
                characterId: i, name: ch.name, avatar: ch.avatar, isGroup: false,
                totalFavorites, chatsWithFavorites,
            });
        }
    }

    // --- 群组扫描 ---
    for (let g = 0; g < groups.length; g++) {
        if (options.signal?.aborted) break;
        const grp = groups[g];
        if (!grp || !grp.id) {
            onProgress?.(characters.length + g + 1, characters.length + groups.length, '');
            continue;
        }
        onProgress?.(characters.length + g + 1, characters.length + groups.length, grp.name || '群聊');

        const fileList = Array.isArray(grp.chats) ? grp.chats : [];
        if (fileList.length === 0) continue;

        const chatsWithFavorites = [];
        await Promise.all(fileList.map(async (rawName) => {
            if (options.signal?.aborted) return;
            const chatFileNameNoExt = String(rawName).replace(/\.jsonl$/, '');
            if (!chatFileNameNoExt) return;
            try {
                const fullChatData = await getFullChatData(null, grp.id, chatFileNameNoExt, true, null, { signal: options.signal });
                if (fullChatData && fullChatData.metadata?.favorites?.length > 0) {
                    chatsWithFavorites.push({
                        fileName: chatFileNameNoExt,
                        displayName: chatFileNameNoExt,
                        favoritesCount: fullChatData.metadata.favorites.length,
                        metadata: fullChatData.metadata,
                        messages: fullChatData.messages,
                        favorites: fullChatData.metadata.favorites,
                    });
                }
            } catch (e) {
                if (isAbortError(e, options.signal)) return;
            }
        }));

        if (chatsWithFavorites.length > 0) {
            chatsWithFavorites.sort((a, b) => b.favoritesCount - a.favoritesCount);
            const totalFavorites = chatsWithFavorites.reduce((s, c) => s + c.favoritesCount, 0);
            result.push({
                characterId: null, name: grp.name || '未命名群聊', avatar: grp.avatar || '', groupId: grp.id, isGroup: true,
                totalFavorites, chatsWithFavorites,
            });
        }
    }

    return result;
}
