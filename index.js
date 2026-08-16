// index.js - Star 插件主入口文件

import {
    eventSource,
    event_types,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { state, PLUGIN_NAME, LOCAL_VERSION, initSettings } from './state.js';
import Logger, { LogLevel } from './Logger.js';
import { checkForUpdates, handleUpdate } from './api.js';
import {
    ensureFavoritesArrayExists,
    ensureCurrentChatIsCached,
    addFavoriteIconsToMessages,
    refreshFavoriteIconsInView,
    removeFavoriteById,
    handleEditNoteFromChat,
} from './core.js';
import {
    setupPreviewModeUI,
    openFavoritesModal,
    renderFavoritesView,
    exitPreviewMode,
    initDebugPanel,
    abortBackgroundLoad,
    ensureQAStructure,
} from './ui/index.js';
import { initFontSystem } from './ui/font-subset.js';

// 初始化日志级别
Logger.setLogLevel(LogLevel.RUNTIME);

// 主初始化函数
jQuery(async () => {
    try {
        Logger.info('插件开始初始化...');

        // 初始化设置
        initSettings();

        // 设置初始状态
        $('#form_sheld').removeClass('star-preview-active');
        if (!extension_settings[PLUGIN_NAME].lastSeenVersion) {
            extension_settings[PLUGIN_NAME].lastSeenVersion = '0.0.0';
        }

        // ==========================================
        // 内联 HTML 模板（收藏按钮入口）
        // ==========================================
        try {
            const inputButtonHtml = `
                <div id="favorites_button" class="list-group-item flex-container flexGap5" title="收藏消息">
                    <span>
                        <i class="fa-solid fa-star"></i>
                    </span>
                    <span>收藏</span>
                </div>
            `;
            $('#data_bank_wand_container').append(inputButtonHtml);

            const updateButtonHtml = `<span id="favorites_update_button" class="star-new-badge" title="检查更新...">可更新</span>`;
            $('#favorites_button').append(updateButtonHtml).on('click', openFavoritesModal);
            $('#favorites_update_button').on('click', (event) => {
                event.stopPropagation();
                // 关闭魔法棒扩展面板
                $('#extensionsMenuButton').click();
                handleUpdate();
            });

        } catch (error) {
            Logger.error('生成收藏按钮失败:', error);
        }

        // ==========================================
        // 初始化 UI 和状态
        // ==========================================
        setupPreviewModeUI();
        ensureFavoritesArrayExists();
        ensureCurrentChatIsCached();
        addFavoriteIconsToMessages();
        refreshFavoriteIconsInView();

        // 异步检查更新
        await checkForUpdates();

        // ==========================================
        // 输出版本号信息
        // ==========================================
        Logger.info(`Star 插件版本: v${LOCAL_VERSION}`);

        // 获取 SillyTavern 版本
        try {
            const versionResponse = await fetch('/version');
            const versionData = await versionResponse.json();
            Logger.info(`SillyTavern 版本: v${versionData.pkgVersion}`);
        } catch (err) {
            Logger.warn('获取 SillyTavern 版本失败:', err);
        }

        // 获取 TavernHelper（酒馆助手）版本
        try {
            const thManifestUrl = '/scripts/extensions/third-party/JS-Slash-Runner/manifest.json';
            const thResponse = await fetch(thManifestUrl);
            if (thResponse.ok) {
                const thData = await thResponse.json();
                Logger.info(`TavernHelper 版本: v${thData.version}`);
            } else {
                Logger.debug('TavernHelper 未安装');
            }
        } catch (err) {
            Logger.debug('获取 TavernHelper 版本失败（可能未安装）:', err);
        }

        // 初始化截图字体子系统（字体映射构建 + IndexedDB 缓存预热）
        // 不 await：即使失败也不阻断插件主流程，截图会回退到系统字体
        initFontSystem().catch(err => {
            Logger.warn('截图字体子系统初始化失败（不影响其他功能）:', err);
        });

        // ==========================================
        // 收藏图标长按编辑备注事件
        // ==========================================
        let longPressTimeout;
        let isLongPress = false;
        $(document)
            .on('mousedown touchstart', '.favorite-toggle-icon', function(event) {
                if (event.type === 'touchstart') {
                    event.preventDefault();
                }

                const self = this;
                isLongPress = false;
                longPressTimeout = setTimeout(() => {
                    isLongPress = true;
                    handleEditNoteFromChat(self);
                }, 600);
            })
            .on('mouseup mouseleave touchend touchcancel', '.favorite-toggle-icon', () => {
                clearTimeout(longPressTimeout);
            })
            .on('click', '.favorite-toggle-icon', function(event) {
                // 重置长按标志，防止上一次的状态影响本次点击
                isLongPress = false;
                // 直接传递 jQuery 对象和原始事件
                import('./ui/index.js').then(m => m.handleFavoriteToggle($(this), event));
            });

        // ==========================================
        // 全局快捷键：Alt+S 收藏/取消收藏最后一条消息
        // ==========================================
        $(document).on('keydown', async (e) => {
            // 仅响应 Alt（不叠加 Ctrl/Meta），键为 S
            if (!e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key.toLowerCase() !== 's') return;
            // 输入区（聊天输入框等）内不触发，避免打字时误触
            const tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
            e.preventDefault();
            // 预览模式下不触发（预览的是临时历史上下文，非当前聊天）
            if (state.isPreviewingContext) return;
            const { toggleFavoriteLastMessage } = await import('./core.js');
            toggleFavoriteLastMessage();
        });

        // ==========================================
        // SillyTavern 核心事件监听器
        // ==========================================
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (state.isPreviewingContext) exitPreviewMode();

            // 切换聊天/角色时取消进行中的后台收藏加载，避免旧数据污染新上下文
            abortBackgroundLoad();

            ensureFavoritesArrayExists();
            ensureCurrentChatIsCached();

            setTimeout(() => {
                addFavoriteIconsToMessages();
                refreshFavoriteIconsInView();
            }, 150);
        });

        eventSource.on(event_types.MESSAGE_DELETED, (deletedMessageIndex) => {
            Logger.debug(`监听到消息删除: ${deletedMessageIndex}`);
            const deletedMessageId = String(deletedMessageIndex);
            const chatMetadata = ensureFavoritesArrayExists();
            if (!chatMetadata || !chatMetadata.favorites) return;
            const favIndex = chatMetadata.favorites.findIndex(fav => fav.messageId === deletedMessageId);
            if (favIndex !== -1) {
                const favId = chatMetadata.favorites[favIndex].id;
                const context = getContext();
                removeFavoriteById(favId, context.chatId);

                if (state.modalElement && state.modalElement.classList.contains('visible')) {
                    if (String(state.currentViewingChatFile).replace('.jsonl', '') === String(context.chatId || '').replace('.jsonl', '')) {
                        renderFavoritesView(state.currentViewingChatFile);
                    }
                }
                setTimeout(refreshFavoriteIconsInView, 100);
            }
        });

        const handleNewMessage = () => setTimeout(() => {
            if (!state.isPreviewingContext) addFavoriteIconsToMessages();
        }, 150);
        eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
        eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);

        const handleMessageUpdate = (messageId) => setTimeout(() => {
            // 定向刷新当前 swipe 的消息图标，避免全量遍历 #chat（消息多时卡顿）
            if (!state.isPreviewingContext) refreshFavoriteIconsInView(String(messageId));
        }, 150);
        eventSource.on(event_types.MESSAGE_SWIPED, handleMessageUpdate);
        eventSource.on(event_types.MESSAGE_UPDATED, handleMessageUpdate);

        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => setTimeout(() => {
            if (!state.isPreviewingContext) {
                addFavoriteIconsToMessages();
                refreshFavoriteIconsInView();
            }
        }, 150));

        // 监听聊天区域 DOM 变化
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            const chatObserver = new MutationObserver((mutations) => {
                if (mutations.some(m => m.addedNodes.length > 0)) {
                    if (!state.isPreviewingContext) {
                        requestAnimationFrame(addFavoriteIconsToMessages);
                    }
                }
            });
            chatObserver.observe(chatElement, { childList: true });
        }

        Logger.success('插件加载成功！');

        // 初始化调试日志面板（恢复之前启用的状态）
        initDebugPanel();

        // 初始化 AI 答疑面板（创建浮动按钮和聊天界面）
        ensureQAStructure();

    } catch (error) {
        Logger.error('初始化失败:', error);
    }
});
