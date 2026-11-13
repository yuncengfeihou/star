// bootstrap/entry-button.js - 插件入口按钮（魔法棒扩展面板内的「收藏」项 + 可更新角标）
//
// 说明：收藏面板（ui/main.js 及其依赖的预览/设置/截图/字体子集化等模块）改为按需加载，
// 因此这里的点击处理器用 dynamic import —— 用户不点开收藏面板，就不会解析那几千行 UI 代码。

import Logger from '../Logger.js';
import { handleUpdate } from '../update.js';

/**
 * 注入入口按钮并绑定事件（幂等：重复调用不会产生重复按钮）。
 */
export function ensureEntryButton() {
    if (document.getElementById('favorites_button')) return;

    try {
        const inputButtonHtml = `
            <div id="favorites_button" class="list-group-item flex-container flexGap5" title="收藏消息" role="button" tabindex="0">
                <span>
                    <i class="fa-solid fa-star" aria-hidden="true"></i>
                </span>
                <span>收藏</span>
            </div>
        `;
        $('#data_bank_wand_container').append(inputButtonHtml);

        const updateButtonHtml = `<span id="favorites_update_button" class="star-new-badge" title="检查更新...">可更新</span>`;
        $('#favorites_button')
            .append(updateButtonHtml)
            .on('click', async () => {
                // 经懒加载网关进入，保持与悬浮按钮、快捷键同一条入口路径。
                // 加载失败必须给用户可见反馈：否则点击静默无反应，只在控制台留错。
                try {
                    const { openFavoritesModal } = await import('../ui/modal-gateway.js');
                    await openFavoritesModal();
                } catch (error) {
                    Logger.error('打开收藏面板失败:', error);
                    toastr.error('收藏面板加载失败，请刷新页面或检查扩展文件是否完整');
                }
            });

        $('#favorites_update_button').on('click', (event) => {
            event.stopPropagation();
            // 关闭魔法棒扩展面板
            $('#extensionsMenuButton').click();
            handleUpdate();
        });
    } catch (error) {
        Logger.error('生成收藏按钮失败:', error);
    }
}
