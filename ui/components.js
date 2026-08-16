// ui/components.js - 通用弹窗组件

import { state } from '../state.js';

/**
 * HTML 转义（标签名等用户可控文本插入 HTML 前必须转义）。
 */
function escapeHtmlForTags(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// =================================================================
//                      通用弹窗函数
// =================================================================

/**
 * 显示确认对话框
 * @param {string} message - 确认消息
 * @param {string} title - 对话框标题
 * @param {Object} options - 选项 {hideHeader: false, noBorder: false, okButton: '确定', cancelButton: '取消'}
 * @returns {Promise<boolean>} - 用户是否确认
 */
export function showConfirmModal(message, title = '确认', options = {}) {
    return new Promise((resolve) => {
        const existingModal = document.getElementById('star-confirm-modal');
        if (existingModal) existingModal.remove();

        const hideHeader = options.hideHeader || false;
        const noBorder = options.noBorder || false;
        const okButtonText = options.okButton || '确定';
        const cancelButtonText = options.cancelButton || '取消';
        const zIndex = options.zIndex || null;

        const containerClass = `star-confirm-container${noBorder ? ' delete-container' : ''}`;
        const headerClass = `star-confirm-header${hideHeader ? ' hidden-header' : ''}`;
        const bodyClass = `star-confirm-body${(noBorder || hideHeader) ? ' delete-body' : ''}`;
        const footerClass = `star-confirm-footer${(noBorder || hideHeader) ? ' delete-footer' : ''}`;

        const modalHtml = `
            <div id="star-confirm-modal" class="star-confirm-modal">
                <div class="${containerClass}">
                    <div class="${headerClass}">
                        <div class="star-confirm-title">${title}</div>
                        <div class="star-confirm-close-btn"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="${bodyClass}">
                        <div class="star-confirm-message">${message}</div>
                    </div>
                    <div class="${footerClass}">
                        <button id="star-confirm-cancel" class="menu_button">${cancelButtonText}</button>
                        <button id="star-confirm-ok" class="menu_button primary_button">${okButtonText}</button>
                    </div>
                </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('star-confirm-modal');
        const container = modal.querySelector('.star-confirm-container');
        const okBtn = modal.querySelector('#star-confirm-ok');
        const cancelBtn = modal.querySelector('#star-confirm-cancel');
        const closeBtn = modal.querySelector('.star-confirm-close-btn');

        // 设置 z-index（覆盖 CSS 默认值）
        if (zIndex) {
            modal.style.zIndex = zIndex;
        }

        // 应用主题
        if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
            container.dataset.starTheme = 'dark';
        }

        const closeModal = (result) => {
            modal.classList.remove('visible');
            // 移除 ESC 监听，防止在 document 上累积（与 showInputModal/showTextModal 保持一致）
            document.removeEventListener('keydown', handleEsc);
            setTimeout(() => {
                modal.remove();
                resolve(result);
            }, 300);
        };

        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                closeModal(false);
            }
        };

        okBtn.addEventListener('click', () => closeModal(true));
        cancelBtn.addEventListener('click', () => closeModal(false));
        closeBtn.addEventListener('click', () => closeModal(false));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(false);
            }
        });
        document.addEventListener('keydown', handleEsc);

        setTimeout(() => {
            modal.classList.add('visible');
        }, 10);
    });
}

/**
 * 显示输入对话框
 * @param {string} message - 提示消息
 * @param {string} title - 对话框标题
 * @param {string} initialValue - 初始值
 * @param {Object} options - 选项 {okButton: '确定', cancelButton: '取消', isNoteMode: false}
 * @returns {Promise<string|null>} - 用户输入的值，取消则返回 null
 */
export function showInputModal(message, title = '输入', initialValue = '', options = {}) {
    return new Promise((resolve) => {
        const existingModal = document.getElementById('star-input-modal');
        if (existingModal) existingModal.remove();

        const okButtonText = options.okButton || '确定';
        const isNoteMode = options.isNoteMode || false;
        // 备注模式下始终显示取消按钮
        const cancelButtonText = isNoteMode ? (options.cancelButton || '取消') : (options.cancelButton !== false ? (options.cancelButton || '取消') : null);

        const containerClass = `star-input-container${isNoteMode ? ' note-container' : ''}`;
        const headerClass = `star-input-header${isNoteMode ? ' hidden-header' : ''}`;
        const bodyClass = `star-input-body${isNoteMode ? ' note-body' : ''}`;
        const footerClass = `star-input-footer${isNoteMode ? ' note-footer' : ''}`;
        const textareaClass = `text_pole star-input-textarea${isNoteMode ? ' note-textarea' : ''}`;

        const modalHtml = `
            <div id="star-input-modal" class="star-input-modal">
                <div class="${containerClass}">
                    <div class="${headerClass}">
                        <div class="star-input-title">${title}</div>
                        <div class="star-input-close-btn"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="${bodyClass}">
                        ${message ? `<div class="star-input-message">${message}</div>` : ''}
                        <textarea id="star-input-textarea" class="${textareaClass}" spellcheck="false" placeholder="${options.placeholder !== undefined ? options.placeholder : (isNoteMode ? '输入备注内容...' : '')}"></textarea>
                    </div>
                    <div class="${footerClass}">
                        ${cancelButtonText !== null ? `<button id="star-input-cancel" class="menu_button">${cancelButtonText}</button>` : ''}
                        <button id="star-input-ok" class="menu_button primary_button">${okButtonText}</button>
                    </div>
                </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('star-input-modal');
        const container = modal.querySelector('.star-input-container');
        const textarea = modal.querySelector('#star-input-textarea');
        const okBtn = modal.querySelector('#star-input-ok');
        const cancelBtn = modal.querySelector('#star-input-cancel');
        const closeBtn = modal.querySelector('.star-input-close-btn');

        textarea.value = initialValue;

        // 应用主题
        if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
            container.dataset.starTheme = 'dark';
        }

        const closeModal = (result) => {
            modal.classList.remove('visible');
            document.removeEventListener('keydown', handleEsc);
            setTimeout(() => {
                modal.remove();
                resolve(result);
            }, 300);
        };

        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                closeModal(null);
            }
        };

        okBtn.addEventListener('click', () => closeModal(textarea.value));
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => closeModal(null));
        }
        closeBtn.addEventListener('click', () => closeModal(null));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(null);
            }
        });
        document.addEventListener('keydown', handleEsc);

        setTimeout(() => {
            modal.classList.add('visible');
        }, 10);
    });
}

/**
 * 显示文本内容弹窗
 * @param {string} content - HTML 内容
 * @param {string} title - 弹窗标题
 * @param {Object} options - 选项 {okButton: '关闭', cancelButton: false, wide: false, onClosing: null}
 * @returns {Promise<boolean>} - 用户是否确认
 */
export function showTextModal(content, title = '信息', options = {}) {
    return new Promise((resolve) => {
        const existingModal = document.getElementById('star-text-modal');
        if (existingModal) existingModal.remove();

        const okButtonText = options.okButton || '关闭';
        const cancelButtonText = options.cancelButton;
        const isWide = options.wide ? 'wide' : '';
        const onClosing = options.onClosing;

        const modalHtml = `
            <div id="star-text-modal" class="star-text-modal">
                <div class="star-text-container ${isWide}">
                    <div class="star-text-header">
                        <div class="star-text-title">${title}</div>
                        <div class="star-text-close-btn"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="star-text-body">
                        <div class="star-text-content">${content}</div>
                    </div>
                    <div class="star-text-footer${cancelButtonText === false ? ' guide-footer' : ''}">
                        ${cancelButtonText ? `<button id="star-text-cancel" class="menu_button">${cancelButtonText}</button>` : ''}
                        <button id="star-text-ok" class="menu_button primary_button">${okButtonText}</button>
                    </div>
                </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('star-text-modal');
        const container = modal.querySelector('.star-text-container');
        const okBtn = modal.querySelector('#star-text-ok');
        const cancelBtn = modal.querySelector('#star-text-cancel');
        const closeBtn = modal.querySelector('.star-text-close-btn');

        // 应用主题
        if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
            container.dataset.starTheme = 'dark';
        }

        let popupResult = false;
        let dlg = modal;

        const closeModal = async (isOk) => {
            popupResult = isOk;

            // 如果有 onClosing 回调，先调用它
            if (onClosing) {
                const shouldClose = await onClosing({ result: isOk, dlg: dlg });
                if (shouldClose === false) {
                    // 阻止关闭
                    return;
                }
            }

            modal.classList.remove('visible');
            document.removeEventListener('keydown', handleEsc);
            setTimeout(() => {
                modal.remove();
                resolve(isOk);
            }, 300);
        };

        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                closeModal(cancelButtonText ? false : true);
            }
        };

        okBtn.addEventListener('click', () => closeModal(true));
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => closeModal(false));
        }
        closeBtn.addEventListener('click', () => closeModal(cancelButtonText ? false : true));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(cancelButtonText ? false : true);
            }
        });
        document.addEventListener('keydown', handleEsc);

        setTimeout(() => {
            modal.classList.add('visible');
        }, 10);
    });
}

/**
 * Centers the editor modal in the viewport (mirrors main dialog centering).
 */
function centerEditorModal(container) {
    if (!container) return;
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const dialogWidth = container.offsetWidth;
    const dialogHeight = container.offsetHeight;
    container.style.left = `${Math.max(0, (windowWidth - dialogWidth) / 2)}px`;
    container.style.top = `${Math.max(0, (windowHeight - dialogHeight) / 2)}px`;
}

/**
 * Displays a custom, theme-aware modal for editing text content.
 * @param {string} title - 弹窗标题
 * @param {string} initialContent - 消息正文初始内容
 * @param {Object} [options] - 可选配置
 * @param {string} [options.reasoningContent] - 内心独白初始内容（传入则显示推理编辑区）
 * @returns {Promise<string|{content:string, reasoning:string}|null>}
 */
export function showEditorModal(title, initialContent, options = {}) {
    return new Promise((resolve) => {
        // Remove any existing editor frame to prevent duplicates
        const existingFrame = document.getElementById('star-editor-frame');
        if (existingFrame) existingFrame.remove();

        const hasReasoning = options.reasoningContent !== undefined;

        const reasoningSectionHtml = hasReasoning ? `
            <div class="star-editor-reasoning-section">
                <div class="star-editor-section-label">💭 内心独白</div>
                <textarea id="star-editor-reasoning-textarea" class="text_pole star-editor-textarea star-editor-reasoning-textarea" spellcheck="false"></textarea>
            </div>
            <div class="star-editor-section-divider"></div>
            <div class="star-editor-section-label">💬 消息正文</div>
        ` : '';

        const frameHtml = `
            <div id="star-editor-frame" class="star-editor-frame">
                <div class="star-editor-container ${hasReasoning ? 'has-reasoning' : ''}">
                    <div class="star-editor-header">
                        <div class="star-editor-title">${title}</div>
                        <div class="star-editor-close-btn"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="star-editor-body">
                        ${reasoningSectionHtml}
                        <textarea id="star-editor-textarea" class="text_pole star-editor-textarea" spellcheck="false"></textarea>
                    </div>
                    <div class="star-editor-footer">
                        <button id="star-editor-cancel" class="menu_button">取消</button>
                        <button id="star-editor-save" class="menu_button primary_button">保存</button>
                    </div>
                </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', frameHtml);

        const frame = document.getElementById('star-editor-frame');
        const container = frame.querySelector('.star-editor-container');
        const textarea = frame.querySelector('#star-editor-textarea');
        const reasoningTextarea = frame.querySelector('#star-editor-reasoning-textarea');
        const saveBtn = frame.querySelector('#star-editor-save');
        const cancelBtn = frame.querySelector('#star-editor-cancel');
        const closeBtn = frame.querySelector('.star-editor-close-btn');

        textarea.value = initialContent;
        if (reasoningTextarea && hasReasoning) {
            reasoningTextarea.value = options.reasoningContent || '';
        }

        // Apply theme based on the main favorites modal
        if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
            container.dataset.starTheme = 'dark';
        }

        const closeModal = (result) => {
            window.removeEventListener('resize', centerOnResize);
            document.removeEventListener('keydown', handleEsc);
            frame.classList.remove('visible');
            container.classList.remove('visible');
            frame.remove();
            resolve(result);
        };

        const handleEsc = (event) => {
            if (event.key === 'Escape') {
                closeModal(null);
            }
        };

        const centerOnResize = () => centerEditorModal(container);

        saveBtn.addEventListener('click', () => {
            if (hasReasoning) {
                closeModal({
                    content: textarea.value,
                    reasoning: reasoningTextarea ? reasoningTextarea.value : ''
                });
            } else {
                closeModal(textarea.value);
            }
        });
        cancelBtn.addEventListener('click', () => closeModal(null));
        closeBtn.addEventListener('click', () => closeModal(null));
        frame.addEventListener('click', (e) => {
            if (e.target === frame) {
                closeModal(null);
            }
        });
        document.addEventListener('keydown', handleEsc);

        // 显示弹窗（使用 visibility 代替 display:none，无需回流/rAF 黑科技即可平滑渐显）
        centerEditorModal(container);
        window.addEventListener('resize', centerOnResize);
        frame.classList.add('visible');
        container.classList.add('visible');
    });
}

/**
 * 标签编辑弹窗（chips 交互）。
 * 输入框支持「回车 / 逗号 / 顿号」分隔添加多个标签；已添加的标签以 chip 展示，可点击 × 删除。
 * 标签与备注并存（tags 数组字段），老数据无 tags 字段时自动视为空。
 * @param {string[]} currentTags - 当前标签列表
 * @param {string} title - 弹窗标题
 * @returns {Promise<string[]|null>} 保存返回清洗后的标签数组，取消返回 null
 */
export function showTagsModal(currentTags = [], title = '编辑标签') {
    return new Promise((resolve) => {
        const existingModal = document.getElementById('star-tags-modal');
        if (existingModal) existingModal.remove();

        // 布局参考备注编辑弹窗（showInputModal 的 note 模式）：隐藏标题栏、紧凑内边距、底部按钮居中无边框。
        // 输入框不用 ST 的 text_pole class，避免其全局样式覆盖（自定义 CSS 全属性显式定义）。
        const modalHtml = `
            <div id="star-tags-modal" class="star-tags-modal">
                <div class="star-tags-container">
                    <div class="star-tags-header hidden-header">
                        <div class="star-tags-title">${title}</div>
                        <div class="star-tags-close-btn"><i class="fa-solid fa-xmark"></i></div>
                    </div>
                    <div class="star-tags-body note-body">
                        <div class="star-tags-desc">回车或逗号添加标签，用于右上角分类筛选</div>
                        <div class="star-tags-chips" id="star-tags-chips"></div>
                        <input type="text" id="star-tags-input" class="star-tags-input" placeholder="输入标签，回车或逗号添加..." spellcheck="false">
                    </div>
                    <div class="star-tags-footer note-footer">
                        <button id="star-tags-cancel" class="menu_button">取消</button>
                        <button id="star-tags-ok" class="menu_button primary_button">保存</button>
                    </div>
                </div>
            </div>`;

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const modal = document.getElementById('star-tags-modal');
        const container = modal.querySelector('.star-tags-container');
        const chipsEl = modal.querySelector('#star-tags-chips');
        const input = modal.querySelector('#star-tags-input');
        const okBtn = modal.querySelector('#star-tags-ok');
        const cancelBtn = modal.querySelector('#star-tags-cancel');
        const closeBtn = modal.querySelector('.star-tags-close-btn');

        // 应用主题（跟随收藏面板）
        if (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark') {
            container.dataset.starTheme = 'dark';
        }

        // 初始标签去重清洗
        let tags = [...new Set((currentTags || []).map(t => String(t).trim()).filter(Boolean))];

        const renderChips = () => {
            chipsEl.innerHTML = tags.map((t, i) => `
                <span class="star-tag-chip">${escapeHtmlForTags(t)}<i class="fa-solid fa-xmark star-tag-chip-remove" data-idx="${i}"></i></span>
            `).join('');
            chipsEl.querySelectorAll('.star-tag-chip-remove').forEach(x => {
                x.addEventListener('click', () => {
                    tags.splice(parseInt(x.dataset.idx, 10), 1);
                    renderChips();
                });
            });
        };

        // 把输入框当前内容按分隔符拆成标签加入（回车/保存/输入到逗号时调用）
        const flushInput = () => {
            const val = input.value;
            if (!val.trim()) return;
            val.split(/[,，、]+/).forEach(part => {
                const p = part.trim();
                if (p && !tags.includes(p)) tags.push(p);
            });
            input.value = '';
            renderChips();
        };

        // 输入到逗号/顿号时：分隔符前的完整词先入列，保留最后一个未完成词继续输入
        input.addEventListener('input', () => {
            const v = input.value;
            if (/[,，、]/.test(v)) {
                const parts = v.split(/[,，、]+/);
                const head = parts.slice(0, -1);
                head.forEach(p => {
                    const t = p.trim();
                    if (t && !tags.includes(t)) tags.push(t);
                });
                renderChips();
                input.value = parts[parts.length - 1];
            }
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                flushInput();
            }
        });

        renderChips();

        const closeModal = (result) => {
            modal.classList.remove('visible');
            document.removeEventListener('keydown', handleEsc);
            setTimeout(() => {
                modal.remove();
                resolve(result);
            }, 300);
        };
        const handleEsc = (e) => {
            if (e.key === 'Escape') closeModal(null);
        };

        okBtn.addEventListener('click', () => {
            flushInput();
            closeModal(tags);
        });
        cancelBtn.addEventListener('click', () => closeModal(null));
        closeBtn.addEventListener('click', () => closeModal(null));
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal(null);
        });
        document.addEventListener('keydown', handleEsc);

        setTimeout(() => {
            modal.classList.add('visible');
            input.focus();
        }, 10);
    });
}
