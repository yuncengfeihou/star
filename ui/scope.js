// ui/scope.js - 插件 UI 作用域白名单（共享常量）
//
// 插件往 body / 宿主页面里挂了若干浮层（收藏面板、各类弹窗、菜单、悬浮球……），
// 需要被插件自身的交互逻辑接管（自定义 tooltip、键盘激活等），同时**不能**污染
// SillyTavern 宿主页面里其他元素的原生行为。
//
// 此前这份名单只在 ui/tooltip.js 内部维护；新增键盘激活后出现第二处使用者，
// 因此抽到这里共用，避免两份名单各自漂移。

export const STAR_UI_SCOPE = [
    '#favorites_button',          // ST 魔法棒面板内的收藏入口按钮
    '#favoritesModal',            // 主收藏面板（搜索、侧栏、收藏项操作按钮等）
    '#context-messages-frame',    // 预览/上下文查看器
    '#star-qa-modal',             // AI 答疑面板
    '#star-qa-settings-overlay',  // AI 答疑设置弹窗
    '#star-qa-restore-btn',       // AI 答疑最小化后的恢复按钮
    '#star-debug-modal',          // 调试日志面板
    '#star-ss-settings-overlay',  // 截图设置弹窗
    '#star-bg-settings-overlay',  // 外观与背景设置弹窗
    '#star-character-switcher',   // 角色切换器
    '#star-guide-dialog',         // 使用指南
    '#star-screenshot-popup',     // 截图选择弹窗
    '#star-confirm-modal',        // 通用确认弹窗
    '#star-input-modal',          // 通用输入弹窗
    '#star-text-modal',           // 通用文本弹窗
    '#star-tags-modal',           // 标签编辑弹窗
    '#star-editor-frame',         // 备注编辑器
    '#star-options-menu-overlay', // 设置小菜单（头像长按/右键）
    '#star-mobile-actions-menu',  // 移动端卡片操作菜单
    '#star-update-overlay',       // 更新公告/确认弹窗
    '#star-migration-orb',        // 数据迁移悬浮球
    '#star-migration-panel',      // 数据迁移进度面板
    '.star-tag-filter-menu',      // 标签筛选菜单（挂载于 body）
    '.favorite-toggle-icon',      // 消息区收藏图标（位于 #chat，单独列出）
].join(',');

/**
 * 判断元素是否位于插件自身的 UI 范围内。
 */
export function isInStarScope(el) {
    return !!(el && typeof el.closest === 'function' && el.closest(STAR_UI_SCOPE));
}
