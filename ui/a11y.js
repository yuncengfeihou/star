// ui/a11y.js - 键盘可达性补充
//
// 插件里大量「图标即按钮」的元素为了不引入原生 <button> 的默认样式，写成
// <i role="button" tabindex="0">。role + tabindex 只让它们可被 Tab 聚焦，
// **不会**让 Enter/Space 触发点击——键盘用户聚焦后按回车没有任何反应。
//
// 本模块用一次 document 级事件委托补齐这一环：插件作用域内、带 role="button"
// 的非原生按钮元素，Enter/Space 等价于点击。原生 <button> 自身已有键盘行为，跳过。

import { STAR_UI_SCOPE } from './scope.js';

/**
 * 初始化键盘激活支持（幂等），在插件初始化时调用一次。
 */
export function initA11y() {
    if (initA11y._done) return;
    initA11y._done = true;

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
        // 组合键不接管（保留浏览器/宿主快捷键）
        if (event.altKey || event.ctrlKey || event.metaKey) return;

        const target = event.target;
        if (!target || typeof target.closest !== 'function') return;

        const activator = target.closest('[role="button"][tabindex]');
        if (!activator) return;
        // 原生按钮/链接已有键盘行为，不重复触发
        if (['BUTTON', 'A', 'INPUT'].includes(activator.tagName)) return;
        if (!activator.closest(STAR_UI_SCOPE)) return;

        event.preventDefault();
        activator.click();
    });
}
