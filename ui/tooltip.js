// ui/tooltip.js - 全局自定义 tooltip：把插件按钮的原生 title 提示美化为圆角气泡
//
// 原生 title 属性由浏览器渲染为系统黄框，无法用 CSS 美化。
// 本模块用事件委托接管插件范围内的 [title] 元素：
//   悬停 → 立即移除原生 title（避免系统黄框）→ 悬浮满 TOOLTIP_DELAY 后才在 body 级显示圆角气泡跟随鼠标
//   离开/滚动/缩放 → 取消等待并恢复 title（不影响无障碍等场景）
// 事件委托挂载在 document 上，动态重建的 DOM（innerHTML 重渲染）无需重复绑定。

import { decodeHtmlEntities } from '../utils.js';
import { STAR_UI_SCOPE } from './scope.js';

// 插件 UI 范围白名单（与键盘激活共用，见 ui/scope.js）：只接管这些容器内的 title，
// 避免污染 SillyTavern 宿主页面的原生提示。
const TOOLTIP_OFFSET = 12;      // 气泡相对鼠标的偏移（px）
const TOOLTIP_EDGE_MARGIN = 8;  // 气泡贴边最小余量（px）
const TOOLTIP_DELAY = 1250;     // 悬浮延迟：鼠标停满该时长（ms）才显示气泡

let tipEl = null;      // 全局唯一气泡元素（挂 body，避免被容器 overflow 裁剪）
let currentEl = null;  // 当前悬停元素（用于离开时恢复 title）
let tipTimer = null;   // 延迟显示定时器（悬浮期间取消即不显示）
let mouseX = 0, mouseY = 0;

/**
 * 初始化全局 tooltip（幂等），在插件主初始化中调用一次。
 */
export function initTooltip() {
    if (tipEl) return;

    tipEl = document.createElement('div');
    tipEl.className = 'star-tooltip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);

    document.addEventListener('mouseover', handleMouseOver);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseout', handleMouseOut);
    // 滚动/缩放时隐藏，避免气泡残留在错误位置
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
}

function handleMouseOver(e) {
    // 同时匹配 [title] 与已接管中的 data-star-tip-active（title 在 showTip 时被移除，
    // 若只匹配 [title]，鼠标在元素内部移动时会因找不到 title 而误判为“不在范围内”并隐藏气泡）
    const target = e.target.closest('[title]:not([title=""]), [data-star-tip-active]');
    // 不在插件范围内 → 保持隐藏（也不接管宿主原生 title）
    if (!target || !target.closest(STAR_UI_SCOPE)) {
        hideTip();
        return;
    }
    if (target === currentEl) return;
    scheduleShowTip(target);
}

function handleMouseMove(e) {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (tipEl && tipEl.classList.contains('visible')) {
        positionTip();
    }
}

function handleMouseOut(e) {
    if (!currentEl) return;
    // 鼠标仍停留在原元素内部（移到子元素）→ 不隐藏
    const related = e.relatedTarget;
    if (related && currentEl.contains(related)) return;
    hideTip();
}

/**
 * 接管元素并启动延迟显示：立即移除原生 title（防止等待期间系统黄框先弹出），
 * 悬浮满 TOOLTIP_DELAY 后才显示气泡；期间移开/切走/滚动会被 hideTip 取消。
 */
function scheduleShowTip(el) {
    hideTip(); // 先恢复上一个元素的 title，再接管当前元素
    const rawText = el.getAttribute('title');
    if (!rawText) return;
    currentEl = el;
    // 保存并移除原生 title，防止系统黄框与自定义气泡同时出现
    el.dataset.starTitle = rawText;
    el.removeAttribute('title');
    el.dataset.starTipActive = '1'; // 接管标记：title 移除后仍能被 mouseover 委托识别

    tipTimer = setTimeout(() => {
        if (currentEl !== el) return; // 等待期间已切走/移出，放弃显示
        showTipBubble(el);
    }, TOOLTIP_DELAY);
}

function showTipBubble(el) {
    if (!tipEl) return;
    tipEl.textContent = decodeHtmlEntities(el.dataset.starTitle || '');
    // 主题跟随：取最近带 data-star-theme 的祖先容器（弹窗等），无则默认亮色
    const themed = el.closest('[data-star-theme]');
    if (themed && themed.dataset.starTheme === 'dark') {
        tipEl.dataset.starTheme = 'dark';
    } else {
        tipEl.removeAttribute('data-star-theme');
    }
    tipEl.classList.add('visible');
    positionTip();
}

function hideTip() {
    clearTimeout(tipTimer); // 取消未到时的延迟显示
    if (!tipEl) return;
    tipEl.classList.remove('visible');
    if (currentEl) {
        const saved = currentEl.dataset.starTitle;
        if (saved) {
            currentEl.setAttribute('title', saved); // 恢复 title（无障碍等场景）
            delete currentEl.dataset.starTitle;
        }
        delete currentEl.dataset.starTipActive;
        currentEl = null;
    }
}

function positionTip() {
    if (!tipEl || !tipEl.classList.contains('visible')) return;
    const w = tipEl.offsetWidth;
    const h = tipEl.offsetHeight;
    let left = mouseX + TOOLTIP_OFFSET;
    let top = mouseY + TOOLTIP_OFFSET;
    // 靠近视口右/下边缘时翻转到鼠标另一侧，避免溢出
    if (left + w > window.innerWidth - TOOLTIP_EDGE_MARGIN) left = mouseX - w - TOOLTIP_OFFSET;
    if (top + h > window.innerHeight - TOOLTIP_EDGE_MARGIN) top = mouseY - h - TOOLTIP_OFFSET;
    tipEl.style.left = `${Math.max(TOOLTIP_EDGE_MARGIN, left)}px`;
    tipEl.style.top = `${Math.max(TOOLTIP_EDGE_MARGIN, top)}px`;
}
