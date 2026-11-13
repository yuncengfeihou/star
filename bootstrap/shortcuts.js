// bootstrap/shortcuts.js - 全局快捷键
//
// Alt+S：收藏 / 取消收藏当前聊天最后一条消息
// Alt+F：快速打开 / 关闭收藏面板
//
// 两条规则在所有分支上保持一致：
//   - 仅响应 Alt（不叠加 Ctrl/Meta）
//   - 预览模式下不触发（预览的是临时加载的历史上下文，非当前聊天）

import { state } from '../state.js';
import { toggleFavoriteLastMessage } from '../core.js';
import { openFavoritesModal, closeFavoritesModal, isFavoritesModalOpen } from '../ui/modal-gateway.js';
import Logger from '../Logger.js';

export function registerShortcuts() {
    $(document).on('keydown', async (e) => {
        if (!e.altKey || e.ctrlKey || e.metaKey) return;
        const key = e.key.toLowerCase();

        // Alt+F：快速打开/关闭收藏面板（不检查输入框——打开面板不修改文本，随时可用）
        if (key === 'f') {
            e.preventDefault();
            // 预览模式下不响应，避免干扰临时上下文
            if (state.isPreviewingContext) return;
            if (isFavoritesModalOpen()) {
                closeFavoritesModal();
            } else {
                // 面板模块按需加载，可能因文件缺失而失败：给出可见提示而不是静默无反应
                try {
                    await openFavoritesModal();
                } catch (error) {
                    Logger.error('Alt+F 打开收藏面板失败:', error);
                    toastr.error('收藏面板加载失败，请刷新页面或检查扩展文件是否完整');
                }
            }
            return;
        }

        // Alt+S：收藏/取消收藏最后一条消息（输入区内不触发，避免打字时误触）
        if (key !== 's') return;
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
        e.preventDefault();
        // 预览模式下不触发（预览的是临时历史上下文，非当前聊天）
        if (state.isPreviewingContext) return;
        toggleFavoriteLastMessage();
    });
}
