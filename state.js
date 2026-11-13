// state.js - 全局状态与设置管理模块
//
// 职责：
//   1. state          —— 运行时全局状态（UI 引用、缓存、分页等）
//   2. SETTINGS       —— 插件设置项的**唯一 schema**（键名 + 默认值）
//   3. getSetting/setSetting —— 设置读写的唯一入口（内部统一 saveSettingsDebounced）
//   4. findChatData   —— 收藏数据缓存的统一查找入口（按文件名）
//   5. LOCAL_VERSION  —— 版本号唯一事实来源为 manifest.json，启动时读取覆盖此兜底值

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { stripJsonlExt } from './utils.js';
import Logger from './Logger.js';

export const PLUGIN_NAME = 'star';

// 版本号兜底值（必须与 manifest.json 的 version 一致，由 scripts/check-version.mjs 校验）。
// 运行时由 loadLocalVersion() 用 manifest.json 的值覆盖，避免「四处手工同步版本号」。
export let LOCAL_VERSION = '2.4.0';

// ==================== 设置项 schema ====================
// 新增/重命名设置项只需改这里 + getSetting/setSetting 的调用点。
// default 为函数时按需生成（避免多个实例共享同一对象引用）。
export const SETTINGS = {
    // 外观
    theme: { default: 'light' },    // 收藏面板
    themeSkin: { default: 'classic' },  // 界面风格：classic（经典）| galgame（赛璐璐玻璃）
    itemsPerPage: { default: 10 },
    // 上下文查看
    contextViewRange: { default: 1 },
    contextViewMode: { default: 'single' },
    // 备注（按聊天文件名归档的独立备注，非收藏备注）
    chatNotes: { default: () => ({}) },
    // 调试
    debugPanelEnabled: { default: false },
    // AI 答疑
    qaApiEndpoint: { default: '' },
    qaApiKey: { default: '' },
    qaModel: { default: 'gpt-3.5-turbo' },
    // 角色切换器
    pinnedCharacters: { default: () => [] },
    // 更新检查（内部缓存，非用户设置）
    lastSeenVersion: { default: '0.0.0' },
    lastUpdateCheck: { default: null },
    updateInfo: { default: null },
    // 注意：dataMigration 刻意不在此列。它由 initMigrationFlag() 在 initSettings() 之前写入，
    // 值 'pending'/'done' 是「是否已处理过首次迁移提示」的唯一闸门，一旦补默认值就会让老用户检测失效。
};

// 全局状态对象
export const state = {
    // 分页状态
    currentPage: 1,
    itemsPerPage: 10,
    currentViewingChatFile: null,

    // 数据缓存
    allChatsFavoritesData: [],
    chatListScrollTop: 0,
    isLoadingOtherChats: false,

    // 角色切换器（跨角色浏览收藏）
    charactersWithFavorites: [],   // 全局扫描结果缓存：[{characterId, name, avatar, totalFavorites, chatsWithFavorites}]
    isScanningCharacters: false,   // 是否正在后台扫描所有角色
    charactersCacheStale: false,   // TTL 内是否有收藏变更（仅作 UI 提示，不触发刷新；是否重扫由 TTL 时间驱动）
    charactersCacheTimestamp: 0,   // 上次扫描完成时间戳（0 = 从未扫描，TTL 判定依据）

    // 预览模式
    isPreviewingContext: false,
    // 正在被预览的聊天文件名（带不带 .jsonl 均可）。预览期间聊天区的收藏操作必须以它为目标：
    // currentViewingChatFile 是**收藏面板**正在浏览的聊天，预览时用户仍可在面板里切到别的角色，
    // 按它定位就会把收藏写进另一个聊天文件（见 ui/favorite-icon.js resolveFavoriteTargetChatFile）。
    previewingChatFile: null,
    previewToggleElement: null,
    screenshotToggleElement: null,
    previewExitButtonElement: null,
    _previewAutoHideHandlers: null,  // 预览模式滚动/长按自动隐藏的事件处理器引用（供退出时精确解绑）

    // 模态框 DOM 引用
    modalElement: null,
    modalDialogElement: null,
    modalTitleElement: null,
    modalBodyElement: null,

    // 调试日志面板
    debugPanel: {
        enabled: false,
        iconElement: null,
        modalElement: null,
        modalContainer: null,
        logBodyElement: null
    },

    // 截图选择状态（预览模式内持久化，退出预览时清除）
    screenshotSelection: null,

    // 标签筛选：当前激活的标签名（null = 全部），配合右上角标签图标使用
    activeTagFilter: null
};

// ==================== 设置读写 ====================

/**
 * 读取设置项。未写入过时返回 schema 中的默认值（不会写回）。
 */
export function getSetting(key) {
    const store = extension_settings[PLUGIN_NAME];
    if (store && store[key] !== undefined) return store[key];
    const fallback = SETTINGS[key]?.default;
    return typeof fallback === 'function' ? fallback() : fallback;
}

/**
 * 写入设置项并持久化。
 * 所有设置写入都应走这里，避免「改了忘记 saveSettingsDebounced」。
 * @param {string} key
 * @param {*} value
 * @param {{save?: boolean}} [options] - save=false 时只写入内存（批量写场景，末尾自行保存）
 */
export function setSetting(key, value, options = {}) {
    const { save = true } = options;
    if (!extension_settings[PLUGIN_NAME]) extension_settings[PLUGIN_NAME] = {};
    extension_settings[PLUGIN_NAME][key] = value;
    if (save) saveSettingsDebounced();
}

/**
 * 初始化设置：把 schema 中尚未存在的键补上默认值。
 * 调用时机要求：必须在 initMigrationFlag() 之后（迁移标记依赖「此刻配置仍为空 = 新用户」的判断）。
 */
export function initSettings() {
    if (!extension_settings[PLUGIN_NAME]) {
        extension_settings[PLUGIN_NAME] = {};
    }

    let settingsModified = false;
    for (const [key, schema] of Object.entries(SETTINGS)) {
        if (schema.noDefault) continue;
        if (extension_settings[PLUGIN_NAME][key] === undefined) {
            extension_settings[PLUGIN_NAME][key] = typeof schema.default === 'function' ? schema.default() : schema.default;
            settingsModified = true;
        }
    }

    if (settingsModified) {
        saveSettingsDebounced();
        Logger.info('初始化插件默认设置完成');
    }

    state.itemsPerPage = extension_settings[PLUGIN_NAME].itemsPerPage;
    Logger.debug('加载的设置:', extension_settings[PLUGIN_NAME]);
}

// ==================== 数据缓存查找 ====================

/**
 * 解析「聊天区」（含预览模式）收藏操作的写目标聊天。
 *
 * 为什么需要单独一个函数：收藏面板与聊天区是**两个不同的上下文**——
 *   - 面板里的操作（编辑备注/标签、取消收藏）目标是 state.currentViewingChatFile，
 *     调用点已经显式传入，不受本函数影响；
 *   - 聊天区（#chat 里的星标、长按编辑备注、Alt+S）的目标是「用户此刻看着的那个聊天」。
 *     非预览时就是 ST 的当前聊天；**预览时是被预览的聊天**（state.previewingChatFile）。
 *
 * 曾经这里用了 state.currentViewingChatFile：预览期间用户仍可打开面板并切到别的角色
 * （switchToCharacter 不会退出预览），而 #chat 里显示的还是被预览聊天的内容，
 * 于是星标点击会把 star_favorite 写进另一个角色的聊天文件（实测可复现的跨档写入）。
 * @returns {string|null} 归一化后的聊天文件名；无法确定时返回 null
 */
export function resolveChatAreaTargetChatFile() {
    if (state.isPreviewingContext) {
        // 兜底 currentViewingChatFile：预览状态由更早代码路径置位时该字段可能为空
        return state.previewingChatFile || state.currentViewingChatFile;
    }
    try {
        return stripJsonlExt(getContext().chatId || '');
    } catch (e) {
        return null;
    }
}

/**
 * 按聊天文件名（带不带 .jsonl 均可）在收藏数据缓存中查找条目。
 * 此前该查找以 15+ 处内联表达式散落在各模块，统一到此处后：
 *   - 文件名比较一律经 stripJsonlExt 归一（旧写法只替换首个 .jsonl）
 *   - 未命中统一返回 null（旧写法混用 undefined / null）
 * @returns {object|null}
 */
export function findChatData(fileName) {
    const key = stripJsonlExt(fileName);
    if (!key) return null;
    return state.allChatsFavoritesData.find(c => stripJsonlExt(c.fileName) === key) || null;
}

// ==================== 版本号 ====================

/**
 * 从扩展自身的 manifest.json 读取版本号（唯一事实来源），覆盖 LOCAL_VERSION 兜底值。
 * 使用 import.meta.url 定位，因此扩展目录改名/迁移位置都不会失效。
 * 失败时静默保留兜底值——版本号不是功能依赖，不应影响插件加载。
 */
export async function loadLocalVersion() {
    try {
        const response = await fetch(new URL('manifest.json', import.meta.url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const manifest = await response.json();
        if (manifest?.version) {
            LOCAL_VERSION = manifest.version;
            Logger.debug(`版本号已从 manifest.json 同步: v${LOCAL_VERSION}`);
        }
    } catch (error) {
        Logger.debug('读取 manifest.json 版本号失败，使用内置兜底值:', error);
    }
    return LOCAL_VERSION;
}
