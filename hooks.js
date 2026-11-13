// hooks.js - 跨层钩子与「可取消任务」注册中心（零依赖，故可被数据层与懒加载 UI 模块共用）
//
// 为什么需要它：
//   收藏面板 / 预览模式 / 角色切换器等重 UI 模块改为按需加载（dynamic import）后，
//   入口层不再静态持有它们，但仍需要在特定时机与它们协作：
//     1. 收藏写操作落库前，需要中断会占用聊天文件的后台预加载扫描（数据层 → UI）
//     2. 切换聊天时，需要取消进行中的后台加载/预加载（入口 → UI，且 UI 可能尚未加载）
//   用钩子/注册中心替代互相 import，避免 core ↔ ui 的循环依赖。

const _coreHooks = {
    /** @type {null | (() => Promise<void>|void)} 保存当前聊天前调用（中断后台预加载扫描） */
    beforeSave: null,
    /** @type {null | ((chatFile?: string|null) => Promise<void>|void)} 收藏数据变化后刷新收藏面板 */
    refreshFavoritesView: null,
};

/**
 * 由收藏面板模块（ui/main.js）在加载时注入。
 */
export function setCoreHooks(hooks = {}) {
    Object.assign(_coreHooks, hooks);
}

export function getCoreHooks() {
    return _coreHooks;
}

// --- 可取消后台任务的注册中心 ---
// 懒加载的 UI 模块在初始化时注册自己的「取消」函数；入口层在 CHAT_CHANGED 时统一调用。
// 未加载过的模块没有注册任何东西，调用即为空操作，不会反向把它加载进来。
const _cancellers = new Set();

/**
 * 注册一个「取消后台任务」的函数。
 * @param {(reason?: string) => void} fn
 * @returns {() => void} 注销函数
 */
export function registerCanceller(fn) {
    _cancellers.add(fn);
    return () => _cancellers.delete(fn);
}

/**
 * 取消所有已注册的后台任务（单个失败不影响其他）。
 */
export function runCancellers(reason = '') {
    for (const fn of _cancellers) {
        try {
            fn(reason);
        } catch (error) {
            // 取消路径不应影响主流程（切换聊天等），仅在控制台留痕
            console.warn('[收藏器] 取消后台任务时出错:', error);
        }
    }
}

/** 测试辅助：清空注册状态 */
export function resetHooks() {
    _coreHooks.beforeSave = null;
    _coreHooks.refreshFavoritesView = null;
    _cancellers.clear();
}
