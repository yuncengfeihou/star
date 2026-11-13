// index.js - Star 插件主入口（编排启动顺序）
//
// 本文件只做「按顺序编排」，具体职责分派给各模块：
//   - bootstrap/entry-button.js     魔法棒面板内的入口按钮
//   - bootstrap/floating-buttons.js 常驻悬浮按钮（收藏面板/截图/结束预览）
//   - bootstrap/shortcuts.js        全局快捷键（Alt+S / Alt+F）
//   - bootstrap/chat-events.js      ST 事件 + 聊天区 DOM 监听 + 收藏图标交互
//   - ui/tooltip.js、ui/debug.js    轻量 UI 增强（随启动初始化）
//
// 启动路径刻意保持轻量：收藏面板 / 预览 / 设置 / 截图 / 字体子集化 / AI 答疑
// 这些重模块都在对应交互发生时按需加载（见 ui/modal-gateway.js 等），启动时只解析必需模块。

import { state, LOCAL_VERSION, initSettings, loadLocalVersion } from './state.js';
import Logger, { LogLevel } from './Logger.js';
import { checkForUpdates } from './update.js';
import { initMigrationFlag } from './migration.js';
import {
    ensureFavoritesArrayExists,
    ensureCurrentChatIsCached,
    addFavoriteIconsToMessages,
    refreshFavoriteIconsInView,
} from './core.js';
import { initDebugPanel } from './ui/debug.js';
import { initTooltip } from './ui/tooltip.js';
import { initA11y } from './ui/a11y.js';
import { applySavedTheme } from './ui/theme.js';
import { ensureEntryButton } from './bootstrap/entry-button.js';
import { setupFloatingButtons } from './bootstrap/floating-buttons.js';
import { registerShortcuts } from './bootstrap/shortcuts.js';
import { registerChatEvents } from './bootstrap/chat-events.js';

// 初始化日志级别
Logger.setLogLevel(LogLevel.RUNTIME);

/**
 * 记录宿主环境版本（SillyTavern / 酒馆助手），仅用于排查问题，失败不影响启动。
 */
async function logHostVersions() {
    try {
        const versionResponse = await fetch('/version');
        const versionData = await versionResponse.json();
        Logger.info(`SillyTavern 版本: v${versionData.pkgVersion}`);
    } catch (err) {
        Logger.warn('获取 SillyTavern 版本失败:', err);
    }

    try {
        const thResponse = await fetch('/scripts/extensions/third-party/JS-Slash-Runner/manifest.json');
        if (thResponse.ok) {
            const thData = await thResponse.json();
            Logger.info(`TavernHelper 版本: v${thData.version}`);
        } else {
            Logger.debug('TavernHelper 未安装');
        }
    } catch (err) {
        Logger.debug('获取 TavernHelper 版本失败（可能未安装）:', err);
    }
}

/**
 * 初始化截图字体子系统（字体映射构建 + IndexedDB 缓存预热）。
 * 按需加载且不 await：即使失败也不阻断插件主流程，截图会回退到系统字体。
 */
function initFontSubsystem() {
    import('./ui/font-subset.js')
        .then(m => m.initFontSystem())
        .catch(err => Logger.warn('截图字体子系统初始化失败（不影响其他功能）:', err));
}

// 主初始化函数
jQuery(async () => {
    try {
        Logger.info('插件开始初始化...');

        // 1) 迁移标记检测必须先于 initSettings()：此刻配置尚未被补默认键，
        //    若已有任何数据只可能来自旧版插件，据此区分新旧用户；flag 已存在则短路不检测。
        const needMigrationDialog = initMigrationFlag();

        // 2) 初始化设置（补默认值）与版本号（manifest.json 为唯一事实来源）
        initSettings();
        await loadLocalVersion();

        // 启动即应用已保存的主题与界面风格：主题令牌只声明在 <html> 上，
        // 独立弹窗（更新公告/迁移）在收藏面板打开前出现时也应拿到正确配色。
        applySavedTheme();

        // 3) 轻量 UI 增强
        initTooltip();
        initDebugPanel();
        initA11y();   // 让 role="button" 的图标支持 Enter/Space 激活

        // 4) 初始状态与常驻入口（lastSeenVersion 等默认值已由 initSettings 按 schema 补齐）
        $('#form_sheld').removeClass('star-preview-active');
        ensureEntryButton();
        setupFloatingButtons();

        // 5) 当前聊天的收藏缓存与图标
        ensureFavoritesArrayExists();
        ensureCurrentChatIsCached();
        addFavoriteIconsToMessages();
        refreshFavoriteIconsInView();

        // 6) 事件监听与快捷键
        registerChatEvents();
        registerShortcuts();

        // 7) 异步任务：更新检查、宿主版本记录、截图字体子系统
        checkForUpdates().catch(err => Logger.warn('检查更新失败:', err));
        logHostVersions();
        initFontSubsystem();

        Logger.info(`Star 插件版本: v${LOCAL_VERSION}`);
        Logger.success('插件加载成功！');

        // 8) 老用户首次运行新版：延迟弹出数据迁移确认（不打断初始化流程）
        if (needMigrationDialog) {
            setTimeout(() => {
                import('./ui/migration.js')
                    .then(m => m.showMigrationDialog())
                    .catch(err => Logger.error('打开迁移对话框失败:', err));
            }, 1500);
        }

    } catch (error) {
        Logger.error('初始化失败:', error);
    }
});

// 预览模式等场景需要的全局状态引用（供控制台排查使用）
window.__starState = state;
