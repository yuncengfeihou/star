// ui/modal-gateway.js - 收藏面板的懒加载网关（保持极轻，可安全被入口层静态导入）
//
// 背景：ui/main.js 及其依赖（预览/设置/截图/字体子集化）约 4000+ 行，插件启动时不应解析它们。
// 本模块提供「打开/关闭收藏面板」的稳定接口：
//   - 首次调用 open() 时动态加载 ui/main.js（main.js 加载后会把自身实现注册进来）
//   - 未加载过时 close()/isOpen() 都是空操作/返回 false（此时面板不可能处于打开状态）
// 这样入口层（index.js / bootstrap/*）不必 import 具体面板实现，避免把整条 UI 依赖链拉进启动路径。

import { state } from '../state.js';
import Logger from '../Logger.js';

let _openImpl = null;
let _closeImpl = null;

/**
 * 由 ui/main.js 在加载时调用，注册自身实现。
 */
export function registerFavoritesModal(impl = {}) {
    if (typeof impl.open === 'function') _openImpl = impl.open;
    if (typeof impl.close === 'function') _closeImpl = impl.close;
}

/**
 * 打开收藏面板（必要时先加载面板模块）。
 * 模块加载失败（部署不完整、导出名改了忘了同步……）必须给用户可见的反馈：
 * 入口分散在悬浮按钮/魔法棒面板/快捷键，静默失败时用户只会看到「点了没反应」。
 */
export async function openFavoritesModal() {
    if (!_openImpl) {
        try {
            await import('./main.js');
        } catch (error) {
            Logger.error('加载收藏面板模块失败:', error);
            toastr.error('收藏面板加载失败，请刷新页面或检查扩展文件是否完整');
            return undefined;
        }
    }
    return _openImpl?.();
}

/**
 * 关闭收藏面板。面板模块未加载时为空操作。
 */
export function closeFavoritesModal() {
    return _closeImpl?.();
}

/**
 * 收藏面板当前是否打开。
 */
export function isFavoritesModalOpen() {
    return !!(state.modalElement && state.modalElement.classList.contains('visible'));
}
