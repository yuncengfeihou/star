// bootstrap/floating-buttons.js - 常驻悬浮按钮（收藏面板入口 / 截图入口 / 结束预览）
//
// 这三个按钮是插件常驻的可见入口，必须随插件启动创建；但它们点击后触发的功能
// 分别位于收藏面板（ui/main.js，较重）与截图子系统（ui/screenshot.js + font-subset.js），
// 因此处理器内使用 dynamic import：启动阶段不必解析这些模块。

import { state } from '../state.js';
import Logger from '../Logger.js';

const PREVIEW_EXIT_BUTTON_ID = 'favorites-preview-exit-button';
const PREVIEW_CONTAINER_ID = 'favorites-preview-container';

export function setupFloatingButtons() {
    // 创建按钮容器（固定在右侧）
    let container = document.getElementById(PREVIEW_CONTAINER_ID);
    if (!container) {
        container = document.createElement('div');
        container.id = PREVIEW_CONTAINER_ID;
        document.body.appendChild(container);
    }

    // 收藏面板入口
    if (!document.getElementById('favorites-preview-toggle')) {
        state.previewToggleElement = document.createElement('div');
        state.previewToggleElement.id = 'favorites-preview-toggle';
        state.previewToggleElement.innerHTML = '<i class="fa-solid fa-eye" aria-hidden="true"></i>';
        state.previewToggleElement.title = '打开收藏面板';
        state.previewToggleElement.setAttribute('role', 'button');
        state.previewToggleElement.setAttribute('aria-label', '打开收藏面板');
        state.previewToggleElement.addEventListener('click', async () => {
            // 常驻入口，加载失败必须给用户可见反馈（否则点击静默无反应）
            try {
                const { openFavoritesModal } = await import('../ui/modal-gateway.js');
                await openFavoritesModal();
            } catch (error) {
                Logger.error('打开收藏面板失败:', error);
                toastr.error('收藏面板加载失败，请刷新页面或检查扩展文件是否完整');
            }
        });
        container.appendChild(state.previewToggleElement);
    }

    // 截图按钮（位于预览按钮正下方，圆框大小一致）
    if (!document.getElementById('favorites-screenshot-toggle')) {
        state.screenshotToggleElement = document.createElement('div');
        state.screenshotToggleElement.id = 'favorites-screenshot-toggle';
        state.screenshotToggleElement.innerHTML = '<i class="fa-solid fa-camera" aria-hidden="true"></i>';
        state.screenshotToggleElement.title = '截图预览消息';
        state.screenshotToggleElement.setAttribute('role', 'button');
        state.screenshotToggleElement.setAttribute('aria-label', '截图预览消息');
        state.screenshotToggleElement.addEventListener('click', async () => {
            try {
                const { showScreenshotPopup, captureScreenshotMessages } = await import('../ui/screenshot.js');
                const result = await showScreenshotPopup();
                if (result && result.length > 0) {
                    captureScreenshotMessages(result);
                }
            } catch (error) {
                Logger.error('打开截图弹窗失败:', error);
                toastr.error('截图功能加载失败，请刷新页面或检查扩展文件是否完整');
            }
        });
        container.appendChild(state.screenshotToggleElement);
    }

    // 「结束预览」按钮：挂在输入区容器上（预览模式下替换发送区）
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
        state.previewExitButtonElement.addEventListener('click', async () => {
            try {
                const { exitPreviewMode } = await import('../ui/preview.js');
                await exitPreviewMode();
            } catch (error) {
                Logger.error('退出预览模式失败:', error);
                toastr.error('退出预览失败，请刷新页面');
            }
        });
        formSheld.appendChild(state.previewExitButtonElement);
    }
}
