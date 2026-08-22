// state.js - 全局状态与设置管理模块

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import Logger from './Logger.js';

export const PLUGIN_NAME = 'star';
export const LOCAL_VERSION = '2.2.0';

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
    previewToggleElement: null,
    screenshotToggleElement: null,
    previewExitButtonElement: null,

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

// 初始化设置
export function initSettings() {
    if (!extension_settings[PLUGIN_NAME]) {
        extension_settings[PLUGIN_NAME] = {};
    }

    const defaultSettings = {
        contextViewRange: 1,
        itemsPerPage: 10,
        chatNotes: {},
        lastSeenVersion: '0.0.0',
        theme: 'light',
        debugPanelEnabled: false,
        contextViewMode: 'single',
        qaApiEndpoint: '',
        qaApiKey: '',
        qaModel: 'gpt-3.5-turbo'
    };

    let settingsModified = false;
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[PLUGIN_NAME][key] === undefined) {
            extension_settings[PLUGIN_NAME][key] = value;
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