// update.js - 更新检查与更新弹窗（原 api.js 的更新部分）
//
// 职责：远程版本获取（24h 缓存）→ 版本比对 → 更新日志 Markdown 渲染 → 更新确认弹窗 → 调后端更新接口。
// 远程源为 GitHub raw；所有网络请求都带超时，避免断网时挂起主流程。

import { getRequestHeaders } from '../../../../script.js';
import { PLUGIN_NAME, LOCAL_VERSION, getSetting, setSetting } from './state.js';
import { compareVersions } from './utils.js';
import { renderMarkdown } from './markdown.js';
import Logger from './Logger.js';

const REPO_ROOT = 'https://raw.githubusercontent.com/uhhhh15/star/main';
const MANIFEST_URL = `${REPO_ROOT}/manifest.json`;
const CHANGELOG_URL = `${REPO_ROOT}/CHANGELOG.md`;
const UPDATE_NOTICE_URL = `${REPO_ROOT}/update.html`;

// 更新检查结果缓存有效期（24h）：避免每次启动都请求远程
const UPDATE_CHECK_INTERVAL = 86400000;

let remoteVersion = '0.0.0';
let isUpdateAvailable = false;

/**
 * 从远程获取文件内容（raw.githubusercontent.com）。
 * 带超时保护：断网/慢网时不能无限挂起（更新弹窗/检查更新依赖此函数，
 * 挂起会导致主流程（如首次打开收藏面板）卡死）。
 */
async function getRemoteFileContent(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url + `?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
    } finally {
        clearTimeout(timer);
    }
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
 * 主动检测更新。
 * 24h 内使用 extension_settings 缓存的远程版本，避免频繁请求。
 * @param {boolean} force - 是否强制忽略缓存重新请求
 */
export async function checkForUpdates(force = false) {
    const now = Date.now();
    const lastCheck = getSetting('lastUpdateCheck');

    let usedCache = false;

    // 非强制时，24h 内优先使用缓存的远程版本
    if (!force && lastCheck && (now - parseInt(lastCheck) < UPDATE_CHECK_INTERVAL)) {
        const cachedInfo = getSetting('updateInfo');
        if (cachedInfo && cachedInfo.latestVersion && cachedInfo.latestVersion !== 'Check Failed') {
            remoteVersion = cachedInfo.latestVersion;
            usedCache = true;
        }
    }

    // 未命中缓存或强制刷新时，从网络获取
    if (!usedCache) {
        const remoteVer = await getRemoteVersion();
        if (remoteVer) {
            remoteVersion = remoteVer;
            setSetting('lastUpdateCheck', now);
        }
    }

    // 实时比对版本号
    isUpdateAvailable = remoteVersion
        ? compareVersions(remoteVersion, LOCAL_VERSION) > 0
        : false;

    const checkedAt = usedCache ? parseInt(lastCheck || now) : now;

    // 更新缓存（即使用了缓存也存回去，保持数据一致）
    if (remoteVersion) {
        setSetting('updateInfo', {
            hasUpdate: isUpdateAvailable,
            latestVersion: remoteVersion,
            localVersion: LOCAL_VERSION,
            checkedAt,
        });
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
        checkedAt,
    };
}

/**
 * 通用更新弹窗（合并原 showUpdateConfirmModal 与 showUpdateNoticeDialog 的公共逻辑）。
 * 统一处理：主题、居中、ESC/遮罩/X 关闭、事件清理、入场/退场动画。
 * @param {object} options
 * @param {string} [options.overlayId] - 遮罩元素 id
 * @param {string} [options.dialogClass] - 附加到弹窗的类（如确认弹窗的 star-update-confirm-dialog）
 * @param {string} options.title - 弹窗标题
 * @param {string} options.bodyHtml - 正文 HTML（受信内容：来自本插件或本仓库远程文件）
 * @param {Array<{label: string, classes?: string, value: any}>} options.buttons - 底部按钮（点击 resolve 其 value）
 * @param {boolean} [options.centerFooter] - 底部按钮是否居中（确认弹窗用）
 * @param {(result: any) => void} [options.onClose] - 关闭后回调（result 为 null 表示取消）
 * @returns {Promise<any>} 点击按钮返回其 value，否则返回 null
 */
function showUpdateDialog(options) {
    return new Promise((resolve) => {
        const currentTheme = getSetting('theme');

        const overlay = document.createElement('div');
        overlay.className = 'star-update-overlay';
        if (options.overlayId) overlay.id = options.overlayId;
        overlay.setAttribute('data-star-theme', currentTheme);

        const dialog = document.createElement('div');
        dialog.className = `star-update-dialog${options.dialogClass ? ' ' + options.dialogClass : ''}`;
        dialog.setAttribute('data-star-theme', currentTheme);
        dialog.innerHTML = `
            <div class="star-update-dialog-header">
                <span class="star-update-dialog-title">${options.title}</span>
                <div class="star-update-dialog-close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="star-update-dialog-body">${options.bodyHtml}</div>
            <div class="star-update-dialog-footer${options.centerFooter ? ' centered-footer' : ''}">
                ${options.buttons.map((b, i) => `<button class="${b.classes || 'star-update-btn-ok'}" data-action="${i}">${b.label}</button>`).join('')}
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

        requestAnimationFrame(() => overlay.classList.add('visible'));
        window.addEventListener('resize', center);

        let settled = false;
        const onKey = (e) => {
            if (e.key === 'Escape') finish(null);
        };

        const finish = (result) => {
            if (settled) return;   // 防重复关闭（如快速双击按钮）
            settled = true;
            overlay.classList.remove('visible');
            window.removeEventListener('resize', center);
            document.removeEventListener('keydown', onKey);
            setTimeout(() => {
                overlay.remove();
                resolve(result);
                if (typeof options.onClose === 'function') options.onClose(result);
            }, 250);
        };

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(null);
        });
        dialog.querySelector('.star-update-dialog-close').addEventListener('click', () => finish(null));
        dialog.querySelectorAll('.star-update-dialog-footer button').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.action, 10);
                finish(options.buttons[idx] ? options.buttons[idx].value : null);
            });
        });
        document.addEventListener('keydown', onKey);
    });
}

/**
 * 自定义 HTML 模态框：更新确认（代替 callGenericPopup）。
 * 参考 star-update-dialog 结构，跟随插件亮/暗主题。
 * @param {string} logHtml - Markdown 渲染后的 changelog HTML
 * @param {string} remoteVer - 远程版本号
 * @returns {Promise<boolean>} true = 用户选择了立即更新
 */
function showUpdateConfirmModal(logHtml, remoteVer) {
    return showUpdateDialog({
        dialogClass: 'star-update-confirm-dialog',
        title: `发现新版本 v${remoteVer}`,
        bodyHtml: `<div class="star-changelog-container">${logHtml}</div>`,
        buttons: [{ label: '立即更新', classes: 'star-confirm-btn-ok', value: 'ok' }],
        centerFooter: true,
    }).then(result => result === 'ok');
}


/**
 * 处理整个更新流程：显示日志 -> 确认 -> 调用后端 API -> 刷新。
 */
export async function handleUpdate() {
    let updatingToast = null;
    try {
        // 显示加载提示
        const loadingToast = toastr.info('正在拉取插件【聊天收藏器】更新弹窗……', '', {
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
            setSetting('lastUpdateCheck', null);
            setSetting('updateInfo', null);
            setSetting('lastSeenVersion', LOCAL_VERSION);

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
    const lastSeen = getSetting('lastSeenVersion');
    if (!lastSeen) return false;
    return compareVersions(LOCAL_VERSION, lastSeen) > 0;
}

/**
 * 将更新标记为已读并关闭独立弹窗。
 */
export function markUpdateAsSeen() {
    if (shouldShowUpdateNotice()) {
        setSetting('lastSeenVersion', LOCAL_VERSION);
    }
    // 关闭可能残留的更新弹窗
    const overlay = document.getElementById('star-update-overlay');
    if (overlay) overlay.remove();
}

/**
 * 以独立弹窗显示更新日志。
 * 优先从远程获取 update.html，失败时给出纯文本提示（不再内联维护一份重复文案）。
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
        // 远程获取失败：只给一句提示，避免与仓库中的 update.html 双份文案各自漂移
        Logger.warn('获取远程 update.html 失败');
        contentHtml = `<div class="star-update-wrapper">
  <div class="star-update-head">
    <div class="star-update-version-line"><span class="star-update-dot"></span>v${LOCAL_VERSION}</div>
    <p class="star-update-sub">更新日志暂时获取失败（可能处于离线环境）。</p>
  </div>
  <div class="star-update-section">
    <div class="star-update-label">查看完整更新内容</div>
    <ul class="star-update-list">
      <li>请在联网后重试，或前往插件仓库查看 CHANGELOG.md</li>
    </ul>
  </div>
</div>`;
    }

    await showUpdateDialog({
        overlayId: 'star-update-overlay',
        title: 'Star 更新日志',
        bodyHtml: contentHtml,
        buttons: [{ label: '知道了', classes: 'star-update-btn-ok', value: 'ok' }],
        onClose: () => {
            markUpdateAsSeen();
            if (typeof onClose === 'function') onClose();
        },
    });
}
