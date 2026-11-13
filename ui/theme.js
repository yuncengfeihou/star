// ui/theme.js - 主题唯一事实来源与切换动效
//
// 为什么主题挂在 documentElement 上：
//   1. --star-* 变量已命名空间隔离，写在根元素不会污染宿主 SillyTavern；
//   2. 所有插件组件（面板/预览/上下文查看器/答题/截图/调试/迁移/角色切换器/tooltip）
//      都直接继承，新增组件无需再记得「补一处主题同步」——
//      历史上需要在 8 个容器上分别打标，漏一处就是一块颜色不对的补丁；
//   3. 涟漪动效要求整屏在同一帧内完成主题切换，逐容器同步做不到这一点。

import { getSetting, setSetting, state } from '../state.js';
import Logger from '../Logger.js';

const THEME_ATTR = 'data-star-theme';
const SKIN_ATTR = 'data-star-skin';

/** 可选界面风格。classic = 原淡紫主题；galgame = 赛璐璐 × 柔光玻璃（珊瑚暖纸 / 暗夜玻璃）。 */
export const SKINS = {
    CLASSIC: 'classic',
    GALGAME: 'galgame',
};

export function normalizeSkin(skin) {
    return skin === SKINS.GALGAME ? SKINS.GALGAME : SKINS.CLASSIC;
}

/**
 * 当前界面风格（以 DOM 属性为准；未应用过时回落到设置项）。
 */
export function getSkin() {
    const fromDom = document.documentElement.getAttribute(SKIN_ATTR);
    return normalizeSkin(fromDom || getSetting('themeSkin'));
}

/**
 * 应用界面风格（单源写入，与主题共用 THEME_CHANGED_EVENT）。
 * 只改 <html data-star-skin>：所有插件容器的 --star-* 变量都继承自根元素。
 */
export function applySkin(skin, { persist = true } = {}) {
    const normalized = normalizeSkin(skin);
    document.documentElement.setAttribute(SKIN_ATTR, normalized);
    if (persist) setSetting('themeSkin', normalized);
    document.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, {
        detail: { isDark: isDarkTheme(), skin: normalized },
    }));
    return normalized;
}

/**
 * 切换界面风格并持久化（供设置页调用）。
 */
export function setSkin(skin) {
    return applySkin(skin, { persist: true });
}

/** 切换动效进行中挂在 <html> 上的标记：用于冻结面板内的微过渡，避免「同一段动画跑两遍」 */
export const THEME_SWITCHING_CLASS = 'star-theme-switching';

/**
 * 主题变更事件名。切换是异步的（要等快照就绪才真正应用主题），
 * 因此依赖「当前主题」的 UI（如侧栏太阳/月亮图标）不能在调用处同步更新，
 * 必须订阅此事件。
 */
export const THEME_CHANGED_EVENT = 'star:theme-changed';

/** 涟漪时长固定：半径只影响观感强弱，「迅速蔓延」靠缓动（起步快、收尾缓）表达 */
const RIPPLE_DURATION_MS = 520;
const RIPPLE_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * 当前是否暗色主题。
 * 以 DOM 属性为准而非读设置项：DOM 才是 CSS 实际读取的值，
 * 且切换过程中设置项的落盘时机晚于视觉呈现。
 */
export function isDarkTheme() {
    return document.documentElement.getAttribute(THEME_ATTR) === 'dark';
}

/**
 * 应用主题（单源写入）。所有主题变更都必须经由此函数。
 * @param {boolean} isDark - 是否暗色
 * @param {{persist?: boolean}} [options] - persist=false 用于「按已保存设置回填」的场景
 */
export function applyTheme(isDark, { persist = true } = {}) {
    const root = document.documentElement;
    // 亮色也显式写 'light' 而不是删属性：让 :root 与 [data-star-theme="light"] 的
    // 取值路径唯一，避免「属性缺失」与「显式亮色」两种状态在样式上分叉
    root.setAttribute(THEME_ATTR, isDark ? 'dark' : 'light');

    // 兼容镜像：存量代码通过 dataset.starTheme 读取当前主题（设置菜单、侧栏图标等）。
    // 这里只是把同一份状态投影到面板元素上，不构成第二个事实来源。
    if (state.modalDialogElement) {
        if (isDark) {
            state.modalDialogElement.setAttribute(THEME_ATTR, 'dark');
        } else {
            state.modalDialogElement.removeAttribute(THEME_ATTR);
        }
    }

    if (persist) {
        setSetting('theme', isDark ? 'dark' : 'light');
    }

    // 通知订阅者（侧栏图标等）。放在 startViewTransition 的更新回调里触发时，
    // 这些 DOM 变更会被一并计入「新」快照，因此涟漪揭示的画面与最终状态一致。
    document.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, {
        detail: { isDark, skin: getSkin() },
    }));
}

/**
 * 按已保存的设置回填主题与界面风格（打开面板/进入预览时调用）。
 * 不播放动效、不写回设置，避免与用户此刻的选择互相覆盖。
 */
export function applySavedTheme() {
    // 先写 skin 再写 theme：applyTheme 会派发 THEME_CHANGED_EVENT，
    // 订阅者读到的应已经是本次要应用的风格。
    applySkin(getSetting('themeSkin'), { persist: false });
    applyTheme(getSetting('theme') === 'dark', { persist: false });
}

/**
 * 是否应播放切换动效：浏览器支持 View Transitions 且用户未要求减少动态效果。
 * 不支持时静默降级为瞬时切换——主题功能本身不能因此失效。
 */
function shouldAnimateThemeSwitch() {
    if (typeof document.startViewTransition !== 'function') return false;
    try {
        return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return true; // matchMedia 异常时不因此禁用动效
    }
}

/**
 * 计算涟漪圆心：被点击元素的「底边中点」。
 * 主题按钮位于侧栏左下角，因此扩散天然呈现为「自左下角铺满整个界面」。
 * @returns {{x: number, y: number}}
 */
function resolveRippleOrigin(originEl) {
    if (!originEl || typeof originEl.getBoundingClientRect !== 'function') {
        return { x: 0, y: window.innerHeight };
    }
    const rect = originEl.getBoundingClientRect();
    if (!rect.width && !rect.height) {
        // 元素不可见（display:none 等）时退回视口左下角
        return { x: 0, y: window.innerHeight };
    }
    return { x: rect.left + rect.width / 2, y: rect.bottom };
}

/**
 * 切换主题（带动效）。
 * 实现依赖 View Transitions API：浏览器对切换前后各生成一张完整快照，
 * 涟漪揭示的是「完整的新界面」。若改用纯 CSS 蒙版方案，未覆盖区域会出现
 * 新主题文字压在旧主题背景上的错配，无法做到每一帧都自洽。
 * @param {Element|null} [originEl] - 动效扩散起点（主题按钮本身）
 */
export async function toggleThemeAnimated(originEl = null) {
    const isDark = !isDarkTheme();

    if (!shouldAnimateThemeSwitch()) {
        applyTheme(isDark);
        return;
    }

    const { x, y } = resolveRippleOrigin(originEl);
    // 半径取「圆心到最远角」的距离，保证涟漪在任意窗口比例下都能铺满
    const radius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
    );

    const root = document.documentElement;
    // 先加冻结标记再启动过渡：startViewTransition 会同步抓取「旧」快照，
    // 此刻冻结才能保证旧快照里也不含微过渡
    root.classList.add(THEME_SWITCHING_CLASS);

    let transition;
    try {
        transition = document.startViewTransition(() => applyTheme(isDark));
    } catch (e) {
        // 已有过渡在进行中等异常：降级为瞬时切换，不让主题切换失败
        root.classList.remove(THEME_SWITCHING_CLASS);
        Logger.debug('View Transition 启动失败，降级为瞬时切换:', e);
        applyTheme(isDark);
        return;
    }

    try {
        await transition.ready;
        root.animate(
            {
                clipPath: [
                    `circle(0px at ${x}px ${y}px)`,
                    `circle(${radius}px at ${x}px ${y}px)`,
                ],
            },
            {
                duration: RIPPLE_DURATION_MS,
                easing: RIPPLE_EASING,
                pseudoElement: '::view-transition-new(root)',
            },
        );
        await transition.finished;
    } catch (e) {
        // 过渡被中断（用户连点等）属正常路径：主题本身已在回调中切换完成
        Logger.debug('主题切换动效被中断:', e);
    } finally {
        root.classList.remove(THEME_SWITCHING_CLASS);
    }
}

/**
 * 无起点的切换入口（快捷键等拿不到按钮元素时使用）。
 * 起点退回视口左下角，观感与点击主题按钮一致。
 */
export function toggleTheme() {
    return toggleThemeAnimated(null);
}
