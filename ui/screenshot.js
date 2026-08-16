// ui/screenshot.js - 截图功能模块

import { state } from '../state.js';
import Logger from '../Logger.js';
import {
    ensureFontSystemReady,
    buildSvgFontCss,
    injectFontCssIntoSvg,
    customImageFetchFn,
} from './font-subset.js';

// 本地 lib 路径（相对于 SillyTavern 根页面）
const LOCAL_LIB_PATH = 'scripts/extensions/third-party/star/lib/modern-screenshot.js';
// CDN 兜底地址
const CDN_LIB_URL = 'https://unpkg.com/modern-screenshot@4.7.0/dist/index.js';
// Web Worker 路径（用于并行下载图片/字体资源，避免阻塞主线程）
const WORKER_PATH = 'scripts/extensions/third-party/star/worker.js';
// Canvas 安全尺寸上限（留余量避免浏览器崩溃）
const MAX_CANVAS_DIMENSION = 14000;
// 截图格式与质量
const SCREENSHOT_TYPE = 'image/jpeg';
const SCREENSHOT_QUALITY = 0.92;

let modernScreenshotLib = null;
let isLoadingLibrary = false;
let loadLibraryPromise = null;

// =================================================================
//                   库加载
// =================================================================

/**
 * 加载 modern-screenshot 库：优先本地文件，失败则回退 CDN。
 */
async function loadModernScreenshot() {
    if (modernScreenshotLib) return modernScreenshotLib;

    // 1. 全局已存在（如 ST 其他插件预加载）
    if (typeof modernScreenshot !== 'undefined' && typeof modernScreenshot.domToCanvas === 'function') {
        modernScreenshotLib = modernScreenshot;
        return modernScreenshotLib;
    }

    // 2. 正在加载中，复用同一个 Promise
    if (isLoadingLibrary && loadLibraryPromise) {
        return loadLibraryPromise;
    }

    isLoadingLibrary = true;
    loadLibraryPromise = _doLoad();
    return loadLibraryPromise;
}

async function _doLoad() {
    Logger.debug('开始加载 modern-screenshot 库...');
    // 优先加载本地文件
    try {
        Logger.debug(`尝试从本地加载: ${LOCAL_LIB_PATH}`);
        await _injectScript(LOCAL_LIB_PATH);
        if (typeof modernScreenshot !== 'undefined' && typeof modernScreenshot.domToCanvas === 'function') {
            modernScreenshotLib = modernScreenshot;
            isLoadingLibrary = false;
            Logger.success('modern-screenshot 从本地加载成功');
            return modernScreenshotLib;
        }
    } catch (e) {
        Logger.warn('本地 modern-screenshot 加载失败，尝试 CDN:', e.message || e);
    }

    // 回退 CDN
    try {
        Logger.debug(`尝试从 CDN 加载: ${CDN_LIB_URL}`);
        await _injectScript(CDN_LIB_URL);
        if (typeof modernScreenshot !== 'undefined' && typeof modernScreenshot.domToCanvas === 'function') {
            modernScreenshotLib = modernScreenshot;
            isLoadingLibrary = false;
            Logger.success('modern-screenshot 从 CDN 加载成功');
            return modernScreenshotLib;
        }
        throw new Error('CDN 加载后未暴露预期 API');
    } catch (e) {
        isLoadingLibrary = false;
        loadLibraryPromise = null;
        Logger.error('截图库加载完全失败:', e.message || e);
        throw new Error(`无法加载截图库: ${e.message}`);
    }
}

/**
 * 注入 script 标签加载 JS 文件
 */
function _injectScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`加载脚本失败: ${src}`));
        document.head.appendChild(script);
    });
}

// =================================================================
//                   截图选项构建（字体子集核心）
// =================================================================

/**
 * 默认的消息过滤函数：隐藏操作按钮与收藏图标，避免出现在截图中。
 */
function defaultMessageFilter(node) {
    if (!node || !node.classList) return true;
    if (node.classList.contains('mes_button')) return false;
    if (node.classList.contains('favorite-toggle-icon')) return false;
    return true;
}

/**
 * 提取一个元素及其后代中的全部可见文本。
 * 用于字体子集化：按实际文本下载命中的字体子集文件。
 */
function extractText(element) {
    // 优先用 innerText（受布局影响，与实际渲染一致），回退到 textContent
    return (element.innerText || element.textContent || '').trim();
}

/**
 * 构建 domToCanvas 的 options。
 *
 * 关键优化（借鉴 scane2）：
 *   - font: false  关闭库的全量字体嵌入（这是耗时瓶颈所在）
 *   - onCreateForeignObjectSvg：在 SVG 序列化前注入「按本次文本精确子集化」的字体 CSS
 *   - fetchFn：图片资源走三级缓存（内存→IndexedDB→网络），跨域失败回退占位图
 *   - workerUrl：资源下载放到 Web Worker，不阻塞主线程
 *
 * @param {object} extra 额外覆盖项（backgroundColor / filter 等）
 * @param {HTMLElement} element 待截图元素（用于提取文本）
 */
async function buildCaptureOptions(element, extra = {}) {
    // 确保字体系统已就绪（首次截图时触发映射构建，后续直接命中缓存）
    await ensureFontSystemReady();

    const text = extractText(element);

    return {
        scale: 2,
        maximumCanvasSize: MAX_CANVAS_DIMENSION,
        // 关闭库自带字体嵌入，改由下面的回调精确注入子集字体
        font: false,
        // 图片资源缓存
        fetchFn: customImageFetchFn,
        // 并行下载
        workerUrl: WORKER_PATH,
        workerNumber: 2,
        // SVG 序列化前注入字体 CSS（子集字体 + FontAwesome + 布局修复）
        onCreateForeignObjectSvg: async (svg) => {
            try {
                const cssText = await buildSvgFontCss(text);
                injectFontCssIntoSvg(svg, cssText);
            } catch (err) {
                Logger.warn('字体 CSS 注入失败，截图将回退到系统字体:', err);
            }
        },
        ...extra,
    };
}

// =================================================================
//                   截图弹窗 UI
// =================================================================

/**
 * HTML 转义
 */
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

/**
 * 显示截图消息选择弹窗。
 * 读取 #chat 中所有带 mesid 的消息元素，展示为可选列表。
 * 仅允许连续勾选。
 *
 * @returns {Promise<number[]|null>} 选中的消息 ID 数组（已排序），取消则为 null
 */
export function showScreenshotPopup() {
    Logger.debug('打开截图选择弹窗...');
    return new Promise((resolve) => {
        // 移除已有弹窗
        const existing = document.getElementById('star-screenshot-popup');
        if (existing) existing.remove();

        // 读取当前预览中的所有消息
        const messageElements = document.querySelectorAll('#chat .mes[mesid]');
        Logger.debug(`截图弹窗: 在 #chat 中找到 ${messageElements.length} 条消息`);
        const availableMessages = [];
        messageElements.forEach(el => {
            const msgId = parseInt(el.getAttribute('mesid'), 10);
            if (isNaN(msgId)) return;

            // 正确获取角色：使用 is_user 属性和 ch_name 属性
            const isUser = el.getAttribute('is_user') === 'true';
            const chName = el.getAttribute('ch_name') || '';
            const sender = isUser ? '用户' : (chName || '角色');

            // 获取消息前20个字符
            const mesTextEl = el.querySelector('.mes_text');
            let msgPreview = '';
            if (mesTextEl) {
                const rawText = mesTextEl.textContent || '';
                msgPreview = rawText.replace(/\s+/g, ' ').trim().substring(0, 20);
                if (rawText.replace(/\s+/g, ' ').trim().length > 20) {
                    msgPreview += '…';
                }
            }

            availableMessages.push({ id: msgId, sender, msgPreview });
        });

        if (availableMessages.length === 0) {
            toastr.warning('预览区域没有可截图的消息');
            resolve(null);
            return;
        }

        // 按楼层号排序
        availableMessages.sort((a, b) => a.id - b.id);

        // ---------- 选中状态（持久化：关闭弹窗后再打开保持之前的选择）----------
        let minSelected = null;
        let maxSelected = null;

        // 恢复之前保存的选择状态（除非已退出预览模式）
        if (state.screenshotSelection) {
            const saved = state.screenshotSelection;
            // 验证保存的消息 ID 在 availableMessages 中是连续的
            const savedIds = availableMessages.filter(m => m.id >= saved.min && m.id <= saved.max).map(m => m.id);
            if (savedIds.length > 0) {
                minSelected = saved.min;
                maxSelected = saved.max;
            }
        }

        // ---------- 构建 HTML ----------
        const itemsHtml = availableMessages.map(msg => `
            <label class="star-screenshot-item" data-msg-id="${msg.id}">
                <input type="checkbox" class="star-screenshot-checkbox" value="${msg.id}">
                <span class="star-screenshot-floor">#${msg.id}</span>
                <span class="star-screenshot-sender">${escapeHtml(msg.sender)}</span>
                ${msg.msgPreview ? `<span class="star-screenshot-preview">${escapeHtml(msg.msgPreview)}</span>` : ''}
            </label>
        `).join('');

        const popupHtml = `
            <div id="star-screenshot-popup" class="star-screenshot-popup-overlay">
                <div class="star-screenshot-popup-dialog">
                    <div class="star-screenshot-popup-header">
                        <div class="star-screenshot-popup-title">📷 选择截图范围</div>
                        <div class="star-screenshot-popup-close"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="star-screenshot-popup-body">
                        <div class="star-screenshot-popup-hint">
                            勾选要截取的消息楼层 — 自动保持连续选择
                        </div>
                        <div class="star-screenshot-popup-list">
                            ${itemsHtml}
                        </div>
                    </div>
                    <div class="star-screenshot-popup-footer">
                        <span class="star-screenshot-popup-range">未选择</span>
                        <div class="star-screenshot-popup-buttons">
                            <button class="star-screenshot-btn-cancel menu_button">取消</button>
                            <button class="star-screenshot-btn-capture menu_button primary_button" disabled>截取</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.insertAdjacentHTML('beforeend', popupHtml);

        const overlay = document.getElementById('star-screenshot-popup');
        const dialog = overlay.querySelector('.star-screenshot-popup-dialog');
        const rangeEl = overlay.querySelector('.star-screenshot-popup-range');
        const captureBtn = overlay.querySelector('.star-screenshot-btn-capture');
        const checkboxes = overlay.querySelectorAll('.star-screenshot-checkbox');


        // 应用主题
        if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
            dialog.dataset.starTheme = 'dark';
        }

        // ---------- UI 更新 ----------
        function refreshCheckboxes() {
            checkboxes.forEach(cb => {
                const id = parseInt(cb.value, 10);
                cb.checked = minSelected !== null && id >= minSelected && id <= maxSelected;
            });

            if (minSelected !== null && maxSelected !== null) {
                const count = maxSelected - minSelected + 1;
                rangeEl.textContent = `已选范围: #${minSelected} — #${maxSelected}（${count} 条）`;
                captureBtn.disabled = false;
            } else {
                rangeEl.textContent = '未选择';
                captureBtn.disabled = true;
            }
        }

        // ---------- 连续勾选逻辑 ----------
        function handleCheckboxChange(clickedId, targetCheckbox) {
            if (minSelected === null) {
                // 首次选择
                minSelected = clickedId;
                maxSelected = clickedId;
            } else if (clickedId < minSelected) {
                // 向左扩展 — 自动勾选中间所有项
                minSelected = clickedId;
            } else if (clickedId > maxSelected) {
                // 向右扩展 — 自动勾选中间所有项
                maxSelected = clickedId;
            } else {
                // 点击范围内 — 从较近的边缘收缩
                const distToMin = clickedId - minSelected;
                const distToMax = maxSelected - clickedId;

                if (distToMin <= distToMax) {
                    // 靠近左边缘 → 从左边缘收缩到 clickedId+1
                    if (clickedId === minSelected) {
                        minSelected = clickedId + 1;
                    } else {
                        minSelected = clickedId + 1;
                    }
                } else {
                    // 靠近右边缘 → 从右边缘收缩到 clickedId-1
                    if (clickedId === maxSelected) {
                        maxSelected = clickedId - 1;
                    } else {
                        maxSelected = clickedId - 1;
                    }
                }

                // 如果收缩后范围非法，清空选择
                if (minSelected !== null && minSelected > maxSelected) {
                    minSelected = null;
                    maxSelected = null;
                }
            }

            refreshCheckboxes();
        }

        // ---------- 事件绑定 ----------
        checkboxes.forEach(cb => {
            cb.addEventListener('change', function () {
                const id = parseInt(this.value, 10);
                handleCheckboxChange(id, this);
            });
        });

        // 关闭按钮
        overlay.querySelector('.star-screenshot-popup-close').addEventListener('click', () => closePopup(null));

        // 点击遮罩关闭
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closePopup(null);
        });

        // 取消按钮
        overlay.querySelector('.star-screenshot-btn-cancel').addEventListener('click', () => closePopup(null));

        // 截取按钮
        captureBtn.addEventListener('click', () => {
            if (minSelected !== null && maxSelected !== null) {
                const ids = [];
                for (let i = minSelected; i <= maxSelected; i++) {
                    ids.push(i);
                }
                closePopup(ids);
            }
        });

        // Escape 键关闭
        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                closePopup(null);
            }
        };
        document.addEventListener('keydown', handleEsc);

        function closePopup(result) {
            // 保存选择状态（仅在预览模式下保存）
            if (state.isPreviewingContext && minSelected !== null && maxSelected !== null) {
                state.screenshotSelection = { min: minSelected, max: maxSelected };
            } else if (!state.isPreviewingContext) {
                state.screenshotSelection = null;
            }
            document.removeEventListener('keydown', handleEsc);
            // 立即移除弹窗 overlay，确保 backdrop-filter 不会影响后续截图渲染
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            // 使用 requestAnimationFrame 确保浏览器完成合成后再 resolve
            requestAnimationFrame(() => resolve(result));
        }

        // 居中弹窗
        const centerDialog = () => {
            if (!dialog) return;
            const ww = window.innerWidth;
            const wh = window.innerHeight;
            dialog.style.left = `${Math.max(10, (ww - dialog.offsetWidth) / 2)}px`;
            dialog.style.top = `${Math.max(10, (wh - dialog.offsetHeight) / 2)}px`;
        };
        centerDialog();

        // 入场动画
        requestAnimationFrame(() => {
            overlay.classList.add('visible');
        });

        refreshCheckboxes();
    });
}

// =================================================================
//                   截图核心逻辑
// =================================================================

/**
 * 截取指定消息 ID 对应的消息，拼接为一张图片并下载。
 *
 * @param {number[]} messageIds - 要截取的消息 ID 数组
 */
export async function captureScreenshotMessages(messageIds) {
    if (!messageIds || messageIds.length === 0) {
        Logger.warn('截图: 未选择任何消息');
        toastr.warning('未选择任何消息');
        return;
    }

    Logger.info(`开始截图，选中 ${messageIds.length} 条消息: [${messageIds.join(', ')}]`);

    const loadingToast = toastr.info('正在加载截图库...', '', { timeOut: 0 });

    let lib;
    try {
        lib = await loadModernScreenshot();
        toastr.clear(loadingToast);
    } catch (err) {
        toastr.clear(loadingToast);
        Logger.error('截图: 加载截图库失败:', err);
        toastr.error('截图库加载失败，请检查网络连接');
        return;
    }

    const progressToast = toastr.info('正在截图...', '', { timeOut: 0 });
    const sortedIds = [...messageIds].sort((a, b) => a - b);

    try {
        // 找到所有选中的消息 DOM 元素
        const msgElements = [];
        for (const msgId of sortedIds) {
            const el = document.querySelector(`#chat .mes[mesid="${msgId}"]`);
            if (el) {
                msgElements.push(el);
            } else {
                Logger.warn(`截图跳过: 找不到消息 #${msgId}`);
            }
        }

        if (msgElements.length === 0) {
            toastr.clear(progressToast);
            toastr.error('没有可截图的消息');
            return;
        }

        // 单条消息：直接对元素截图
        if (msgElements.length === 1) {
            Logger.debug('截图: 单条消息模式，直接对元素截图');
            const canvas = await captureSingle(lib, msgElements[0]);
            toastr.clear(progressToast);
            if (canvas) {
                const filename = `chat_#${sortedIds[0]}_${Date.now()}.png`;
                Logger.success(`截图: 单条消息截图成功，准备下载: ${filename}`);
                downloadCanvas(canvas, filename);
            } else {
                Logger.error('截图: 单条消息 Canvas 生成失败');
                toastr.error('截图生成失败');
            }
            return;
        }

        // 多条消息：逐条截图，然后用 Canvas 垂直拼接
        Logger.debug(`截图: 多条消息模式，逐条截图拼接 (${msgElements.length} 条消息)`);

        // 读取 #chat 消息之间的实际垂直间距
        const chatArea = document.getElementById('chat');
        const chatWidth = chatArea ? chatArea.clientWidth : 800;
        const bgColor = chatArea
            ? getComputedStyle(chatArea).backgroundColor || '#1e1e1e'
            : '#1e1e1e';

        // 计算消息之间的间距（取第一条和第二条消息的 top 差值）
        let msgGap = 20; // 默认间距
        if (msgElements.length >= 2) {
            const rect1 = msgElements[0].getBoundingClientRect();
            const rect2 = msgElements[1].getBoundingClientRect();
            msgGap = Math.round(rect2.top - rect1.bottom);
        }

        // 逐条截图（直接对原 DOM 元素，保留完整样式上下文）
        // 字体子集化：每条消息按各自文本精确命中字体文件，避免全量下载
        const canvases = [];
        for (const el of msgElements) {
            const canvas = await captureSingle(lib, el);
            if (canvas) canvases.push(canvas);
        }

        // 垂直拼接所有 canvas
        const totalWidth = Math.max(...canvases.map(c => c.width));
        const totalHeight = canvases.reduce((sum, c, i) => sum + c.height + (i < canvases.length - 1 ? msgGap * 2 : 0), 0);
        const merged = document.createElement('canvas');
        merged.width = totalWidth;
        merged.height = totalHeight;
        const ctx = merged.getContext('2d');
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, totalWidth, totalHeight);

        let yOffset = 0;
        for (let i = 0; i < canvases.length; i++) {
            // 居中绘制（某些消息宽度可能不同）
            const xOffset = Math.floor((totalWidth - canvases[i].width) / 2);
            ctx.drawImage(canvases[i], xOffset, yOffset);
            yOffset += canvases[i].height + msgGap * 2;
        }
        toastr.clear(progressToast);

        const filename = `chat_#${sortedIds[0]}-#${sortedIds[sortedIds.length - 1]}_${Date.now()}.png`;
        Logger.success(`截图: 多条消息逐条拼接成功 (${canvases.length} 条), 准备下载: ${filename}`);
        downloadCanvas(merged, filename);

    } catch (err) {
        toastr.clear(progressToast);
        // 清理可能的离屏容器
        const w = document.getElementById('star-screenshot-wrapper');
        if (w) w.remove();
        Logger.error('截图过程出错:', err);
        toastr.error(`截图失败: ${err.message || '未知错误'}`);
    }
}

/**
 * 对任意 DOM 元素截图并下载。
 * 用于"消息上下文"弹窗的相机按钮：截取当前消息内容区域（不含顶部菜单栏）。
 *
 * 优化策略：直接对原始元素临时解除滚动/高度限制后截图，
 * 避免手动克隆导致的 CSS 上下文丢失（字体、布局错位等问题），
 * 同时减少离屏克隆的双重布局开销。
 *
 * @param {HTMLElement} element 要截取的元素
 * @param {string} filename 下载文件名（建议带 .png 后缀，导出时会转为 .jpg）
 */
export async function captureElementScreenshot(element, filename) {
    if (!element) {
        Logger.warn('元素截图: 目标元素为空');
        toastr.warning('截图目标不存在');
        return;
    }

    Logger.info('元素截图: 开始截取元素');

    const loadingToast = toastr.info('正在加载截图库...', '', { timeOut: 0 });
    let lib;
    try {
        lib = await loadModernScreenshot();
        toastr.clear(loadingToast);
    } catch (err) {
        toastr.clear(loadingToast);
        Logger.error('元素截图: 加载截图库失败:', err);
        toastr.error('截图库加载失败，请检查网络连接');
        return;
    }

    const progressToast = toastr.info('正在截图...', '', { timeOut: 0 });

    // 记录需要恢复的样式修改，用于截图后回滚
    const styleRestoreList = [];

    try {
        // 解析背景色：元素自身透明时回退到弹窗容器背景，再回退到白色
        const resolveBg = (el) => {
            const bg = el ? getComputedStyle(el).backgroundColor : '';
            return (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ? bg : '';
        };
        let bgColor = resolveBg(element);
        if (!bgColor) bgColor = resolveBg(element.closest('.context-messages-container'));
        if (!bgColor) bgColor = '#ffffff';

        // ---- 核心优化：直接在原始元素上解除滚动/高度限制 ----
        // 同时处理目标元素、其后代、以及所有祖先容器中的限制
        const unlockElement = (el) => {
            const cs = getComputedStyle(el);
            // 处理 overflow: auto/scroll/hidden — 只要会裁剪内容就解锁
            // 但跳过头像等需要圆形裁剪的元素（通过检查是否为 IMG 或包含 avatar 类名）
            const isAvatar = el.tagName === 'IMG' || (el.classList && (el.classList.contains('context-message-avatar') || el.classList.contains('context-single-avatar')));
            if (isAvatar) return;

            const ovf = cs.overflow;
            const ovfY = cs.overflowY;
            const needsOverflowUnlock = (ovf === 'auto' || ovf === 'scroll' || ovf === 'hidden' || ovfY === 'auto' || ovfY === 'scroll' || ovfY === 'hidden');
            if (needsOverflowUnlock) {
                const origOverflow = el.style.overflow;
                const origOverflowY = el.style.overflowY;
                el.style.overflow = 'visible';
                el.style.overflowY = 'visible';
                styleRestoreList.push({ el, key: 'overflow', value: origOverflow });
                styleRestoreList.push({ el, key: 'overflowY', value: origOverflowY });
            }
            // 解除显式 max-height 限制（如内心独白内容区的 250px）
            if (cs.maxHeight && cs.maxHeight !== 'none') {
                const origMaxHeight = el.style.maxHeight;
                el.style.maxHeight = 'none';
                styleRestoreList.push({ el, key: 'maxHeight', value: origMaxHeight });
            }
            // 解除固定高度限制（如 context-messages-container 的 height:85vh），
            // 让元素高度由内容自动撑开
            if (cs.height && cs.height !== 'auto' && cs.height !== '0px') {
                const origHeight = el.style.height;
                el.style.height = 'auto';
                styleRestoreList.push({ el, key: 'height', value: origHeight });
            }
        };

        // 1. 解锁从目标元素向上到最外层框架容器的所有祖先
        //    这一步解决祖先 overflow:hidden / height 固定导致的截断
        const frame = element.closest('.context-messages-frame') || element.closest('.context-messages-container');
        const stopAt = frame || document.body;
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== stopAt && ancestor !== document.body) {
            unlockElement(ancestor);
            ancestor = ancestor.parentElement;
        }
        // 也对框架容器本身解锁（context-messages-container）
        if (frame) unlockElement(frame);

        // 2. 解锁目标元素及其所有后代
        unlockElement(element);
        element.querySelectorAll('*').forEach(unlockElement);

        // 等待浏览器完成布局（一次 rAF 足够，因为只改了 overflow/max-height）
        await new Promise(r => requestAnimationFrame(r));

        Logger.debug('元素截图: 直接对原始元素截图（保留完整 CSS 上下文）');
        const options = await buildCaptureOptions(element, {
            backgroundColor: bgColor,
        });
        const canvas = await lib.domToCanvas(element, options);

        // ---- 恢复所有临时样式修改 ----
        for (const item of styleRestoreList) {
            item.el.style[item.key] = item.value;
        }
        styleRestoreList.length = 0;

        toastr.clear(progressToast);

        const finalName = filename || 'screenshot';
        Logger.success('元素截图: 截图成功，准备下载');
        downloadCanvas(canvas, finalName);
    } catch (err) {
        toastr.clear(progressToast);
        // 出错时也恢复样式
        for (const item of styleRestoreList) {
            item.el.style[item.key] = item.value;
        }
        Logger.error('元素截图失败:', err);
        toastr.error(`截图失败: ${err.message || '未知错误'}`);
    }
}

/**
 * 单条消息截图（直接对元素调用，保留原上下文）。
 * 临时解除目标消息及其祖先容器的 overflow / 高度限制，
 * 确保 modern-screenshot 能捕获完整内容（不被 #chat 等容器裁剪）。
 */
async function captureSingle(lib, element) {
    const chatArea = document.getElementById('chat');
    const bgColor = chatArea
        ? getComputedStyle(chatArea).backgroundColor || '#1e1e1e'
        : '#1e1e1e';

    // 临时解锁祖先与后代的 overflow / 高度限制，截图后恢复
    const restoreList = [];
    try {
        // 向上解锁祖先容器（如 #chat）
        let ancestor = element.parentElement;
        while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
            const cs = getComputedStyle(ancestor);
            if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') {
                restoreList.push({ el: ancestor, overflow: ancestor.style.overflow, overflowY: ancestor.style.overflowY });
                ancestor.style.overflow = 'visible';
                ancestor.style.overflowY = 'visible';
            }
            if (cs.maxHeight && cs.maxHeight !== 'none') {
                restoreList.push({ el: ancestor, key: 'maxHeight', value: ancestor.style.maxHeight });
                ancestor.style.maxHeight = 'none';
            }
            if (cs.height && cs.height !== 'auto' && cs.height !== '0px' && ancestor.id !== 'chat') {
                restoreList.push({ el: ancestor, key: 'height', value: ancestor.style.height });
                ancestor.style.height = 'auto';
            }
            ancestor = ancestor.parentElement;
        }

        // 解锁目标元素自身（保留头像裁剪）
        const elCs = getComputedStyle(element);
        if (elCs.overflow !== 'visible' || elCs.overflowY !== 'visible') {
            restoreList.push({ el: element, overflow: element.style.overflow, overflowY: element.style.overflowY });
            element.style.overflow = 'visible';
            element.style.overflowY = 'visible';
        }
        if (elCs.maxHeight && elCs.maxHeight !== 'none') {
            restoreList.push({ el: element, key: 'maxHeight', value: element.style.maxHeight });
            element.style.maxHeight = 'none';
        }

        // 解锁后代（跳过 avatar 图片保留圆形裁剪）
        element.querySelectorAll('*').forEach(child => {
            if (child.tagName === 'IMG') return;
            if (child.classList && (child.classList.contains('context-message-avatar') || child.classList.contains('context-single-avatar'))) return;
            const cs = getComputedStyle(child);
            if (cs.overflow !== 'visible' || cs.overflowY !== 'visible') {
                restoreList.push({ el: child, overflow: child.style.overflow, overflowY: child.style.overflowY });
                child.style.overflow = 'visible';
                child.style.overflowY = 'visible';
            }
            if (cs.maxHeight && cs.maxHeight !== 'none') {
                restoreList.push({ el: child, key: 'maxHeight', value: child.style.maxHeight });
                child.style.maxHeight = 'none';
            }
        });

        await new Promise(r => requestAnimationFrame(r));

        const options = await buildCaptureOptions(element, {
            backgroundColor: bgColor,
            filter: defaultMessageFilter,
        });
        return lib.domToCanvas(element, options);
    } finally {
        // 恢复所有临时修改
        for (const item of restoreList) {
            if (item.key) {
                item.el.style[item.key] = item.value;
            } else {
                item.el.style.overflow = item.overflow || '';
                item.el.style.overflowY = item.overflowY || '';
            }
        }
    }
}

/**
 * 下载 Canvas 为图片文件（默认 JPEG，速度更快、体积更小）
 */
function downloadCanvas(canvas, filename) {
    Logger.debug(`截图: 开始导出 Canvas 为 Blob (类型: ${SCREENSHOT_TYPE}, 质量: ${SCREENSHOT_QUALITY})`);
    canvas.toBlob(blob => {
        if (!blob) {
            Logger.error('截图: Canvas.toBlob 返回空');
            toastr.error('生成图片失败');
            return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.replace(/\.png$/i, '.jpg');
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        Logger.success(`截图已下载: ${a.download} (${(blob.size / 1024).toFixed(1)} KB)`);
        toastr.success(`截图已保存: ${a.download} (${(blob.size / 1024).toFixed(1)} KB)`);
    }, SCREENSHOT_TYPE, SCREENSHOT_QUALITY);
}
