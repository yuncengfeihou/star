import { extension_settings, getContext, loadExtensionSettings, renderExtensionTemplateAsync } from "../../../extensions.js";
import { saveSettingsDebounced } from "../../../../script.js";
import { eventSource, event_types } from "../../../../script.js";

// 插件基本信息
const extensionName = "favorites";
const defaultSettings = {
    favorites: [],
    index: {}
};

// 初始化插件设置
async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], defaultSettings);
    }
    
    if (!Array.isArray(extension_settings[extensionName].favorites)) {
        extension_settings[extensionName].favorites = [];
    }
    
    if (!extension_settings[extensionName].index) {
        extension_settings[extensionName].index = {};
    }
    
    updateIndex();
}

// 保存设置
function saveSettings() {
    saveSettingsDebounced();
}

// 更新索引
function updateIndex() {
    const favorites = extension_settings[extensionName].favorites;
    const index = {};
    
    favorites.forEach(favorite => {
        if (!index[favorite.chatId]) {
            index[favorite.chatId] = {
                type: favorite.character ? "private" : "group",
                name: favorite.chatname,
                count: 0,
                character: favorite.character,
                group: favorite.group
            };
        }
        index[favorite.chatId].count++;
    });
    
    extension_settings[extensionName].index = index;
}

// 添加收藏
function addFavorite(messageId) {
    const context = getContext();
    const chat = context.chat;
    
    const message = chat.find(msg => msg.index === messageId);
    if (!message) {
        console.error(`无法找到ID为${messageId}的消息`);
        return false;
    }
    
    // 检查是否已收藏
    if (isMessageFavorited(messageId)) {
        return false;
    }
    
    // 创建收藏对象
    const favorite = {
        id: Date.now(),
        messageId: messageId,
        chatId: context.chatId,
        chatname: context.name2 || context.name,
        sender: message.name,
        role: message.role,
        timestamp: Date.now(),
        content: message.mes,
        summary: message.mes.substring(0, 40),
        is_user: message.is_user,
        is_system: message.is_system
    };
    
    // 区分私聊和群聊
    if (context.characterId) {
        favorite.character = {
            id: context.characterId,
            name2: context.name2
        };
    } else if (context.groupId) {
        favorite.group = {
            id: context.groupId,
            name: context.name
        };
    }
    
    extension_settings[extensionName].favorites.push(favorite);
    updateIndex();
    saveSettings();
    
    updateFavoritesList();
    updateMessageFavoriteStatus(messageId, true);
    
    return true;
}

// 删除收藏
function removeFavorite(favoriteId) {
    const favorites = extension_settings[extensionName].favorites;
    const index = favorites.findIndex(fav => fav.id === favoriteId);
    
    if (index !== -1) {
        const favorite = favorites[index];
        favorites.splice(index, 1);
        updateIndex();
        saveSettings();
        
        updateFavoritesList();
        
        const context = getContext();
        if (favorite.chatId === context.chatId) {
            updateMessageFavoriteStatus(favorite.messageId, false);
        }
        
        return true;
    }
    
    return false;
}

// 检查消息是否已收藏
function isMessageFavorited(messageId) {
    const context = getContext();
    const favorites = extension_settings[extensionName].favorites;
    return favorites.some(fav => fav.messageId === messageId && fav.chatId === context.chatId);
}

// 更新消息的收藏状态
function updateMessageFavoriteStatus(messageId, isFavorited) {
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    const favoriteButton = messageElement.find('.favorite_button');
    
    if (isFavorited) {
        favoriteButton.addClass('active');
    } else {
        favoriteButton.removeClass('active');
    }
}

// 更新收藏列表UI
function updateFavoritesList() {
    const favorites = extension_settings[extensionName].favorites;
    const $favoritesList = $('#favorites_list');
    
    $favoritesList.empty();
    
    if (favorites.length === 0) {
        $favoritesList.append('<div class="no_favorites">暂无收藏内容</div>');
        return;
    }
    
    const sortedFavorites = [...favorites].sort((a, b) => b.timestamp - a.timestamp);
    
    for (const favorite of sortedFavorites) {
        const $item = $(`
            <div class="favorite_item" data-id="${favorite.id}">
                <div class="favorite_item_header">
                    <div class="favorite_item_name">${favorite.sender} (${new Date(favorite.timestamp).toLocaleString()}) <i class="fa-solid fa-pencil favorite_rename" title="重命名"></i></div>
                    <div class="favorite_item_actions">
                        <div class="favorite_item_action favorite_goto" title="跳转到此消息">
                            <i class="fa-solid fa-arrow-up-right-from-square"></i>
                        </div>
                        <div class="favorite_item_action favorite_remove" title="删除收藏">
                            <i class="fa-solid fa-trash"></i>
                        </div>
                    </div>
                </div>
                <div class="favorite_item_content">${favorite.summary}</div>
            </div>
        `);
        
        $favoritesList.append($item);
    }
}

// 更新索引列表UI
function updateIndexList() {
    const index = extension_settings[extensionName].index;
    const $indexList = $('#favorites_index_list');
    
    $indexList.empty();
    
    if (Object.keys(index).length === 0) {
        $indexList.append('<div class="no_favorites">暂无收藏内容</div>');
        return;
    }
    
    // 按类型分组
    const privateChats = [];
    const groupChats = [];
    
    for (const chatId in index) {
        const item = index[chatId];
        if (item.type === "private") {
            privateChats.push({ chatId, ...item });
        } else {
            groupChats.push({ chatId, ...item });
        }
    }
    
    // 显示私聊分组
    if (privateChats.length > 0) {
        const $group = $(`<div class="favorites_index_group"></div>`);
        $group.append(`<div class="favorites_index_group_header">私聊</div>`);
        
        privateChats.forEach(chat => {
            const $item = $(`
                <div class="favorites_index_item" data-chatid="${chat.chatId}">
                    ${chat.character.name2}
                    <br>
                    ${chat.chatId} (${chat.count})
                </div>
            `);
            $group.append($item);
        });
        
        $indexList.append($group);
    }
    
    // 显示群聊分组
    if (groupChats.length > 0) {
        const $group = $(`<div class="favorites_index_group"></div>`);
        $group.append(`<div class="favorites_index_group_header">群聊</div>`);
        
        groupChats.forEach(chat => {
            const $item = $(`
                <div class="favorites_index_item" data-chatid="${chat.chatId}">
                    ${chat.group.name}
                    <br>
                    ${chat.chatId} (${chat.count})
                </div>
            `);
            $group.append($item);
        });
        
        $indexList.append($group);
    }
}

// 跳转到收藏的消息
async function gotoFavorite(favoriteId) {
    const favorites = extension_settings[extensionName].favorites;
    const favorite = favorites.find(fav => fav.id === favoriteId);
    
    if (!favorite) {
        console.error(`无法找到ID为${favoriteId}的收藏`);
        return false;
    }
    
    const context = getContext();
    
    // 如果不在同一个聊天，先切换聊天
    if (favorite.chatId !== context.chatId) {
        if (favorite.character) {
            await context.openCharacterChat(favorite.character.id);
        } else if (favorite.group) {
            const group = context.groups.find(g => g.chat_id === favorite.group.id);
            if (group) {
                await context.openGroupChat(group.id);
            } else {
                console.error(`无法找到群组ID为${favorite.group.id}的群组`);
                return false;
            }
        }
    }
    
    // 等待聊天加载完成
    setTimeout(() => {
        const messageElement = $(`.mes[mesid="${favorite.messageId}"]`);
        if (messageElement.length > 0) {
            messageElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            messageElement.addClass('highlight');
            setTimeout(() => {
                messageElement.removeClass('highlight');
            }, 2000);
        } else {
            console.error(`无法找到ID为${favorite.messageId}的消息元素`);
        }
    }, 500);
    
    return true;
}

// 显示收藏夹模态框
function showFavoritesModal(chatId = null) {
    // 创建模态框
    const $modal = $(`
        <div class="favorites_modal">
            <div class="favorites_modal_header">
                <div class="favorites_modal_title">${chatId ? '当前聊天收藏' : '收藏夹'}</div>
                <div class="favorites_modal_close"><i class="fa-solid fa-xmark"></i></div>
            </div>
            <div class="favorites_modal_content" id="favorites_modal_content">
                <!-- 内容将在这里动态生成 -->
            </div>
            <div class="favorites_modal_footer">
                <button class="menu_button favorites_modal_close_btn">关闭</button>
            </div>
        </div>
    `);
    
    // 添加到DOM
    $('body').append($modal);
    
    // 填充内容
    const $content = $('#favorites_modal_content');
    if (chatId) {
        // 显示特定聊天的收藏
        const favorites = extension_settings[extensionName].favorites
            .filter(fav => fav.chatId === chatId)
            .sort((a, b) => a.timestamp - b.timestamp); // 按时间正序排列
        
        if (favorites.length === 0) {
            $content.append('<div class="no_favorites">未收藏任何消息，现在立刻开始收藏！☺️</div>');
        } else {
            // 分页显示
            const itemsPerPage = 10;
            let currentPage = 1;
            const totalPages = Math.ceil(favorites.length / itemsPerPage);
            
            function showPage(page) {
                $content.empty();
                const start = (page - 1) * itemsPerPage;
                const end = start + itemsPerPage;
                const pageItems = favorites.slice(start, end);
                
                pageItems.forEach(favorite => {
                    const $item = $(`
                        <div class="favorite_modal_item" data-id="${favorite.id}">
                            <div class="favorite_modal_item_header">
                                ${favorite.sender} (${new Date(favorite.timestamp).toLocaleString()}) <i class="fa-solid fa-pencil favorite_rename" title="重命名"></i>
                            </div>
                            <div class="favorite_modal_item_content">
                                ${favorite.content.split('\n').slice(0, 2).join('\n')}
                            </div>
                        </div>
                    `);
                    $content.append($item);
                });
                
                // 添加分页控件
                if (totalPages > 1) {
                    const $pagination = $(`
                        <div class="favorites_modal_pagination">
                            <button class="menu_button favorites_modal_prev" ${page === 1 ? 'disabled' : ''}><</button>
                            <span>${page}/${totalPages}</span>
                            <button class="menu_button favorites_modal_next" ${page === totalPages ? 'disabled' : ''}>></button>
                        </div>
                    `);
                    $content.append($pagination);
                    
                    $content.find('.favorites_modal_prev').on('click', () => {
                        if (currentPage > 1) {
                            currentPage--;
                            showPage(currentPage);
                        }
                    });
                    
                    $content.find('.favorites_modal_next').on('click', () => {
                        if (currentPage < totalPages) {
                            currentPage++;
                            showPage(currentPage);
                        }
                    });
                }
            }
            
            showPage(currentPage);
        }
    } else {
        // 显示所有收藏（按聊天分组）
        updateIndexList();
    }
    
    // 绑定关闭事件
    $modal.find('.favorites_modal_close, .favorites_modal_close_btn').on('click', () => {
        $modal.remove();
    });
    
    // 绑定项目点击事件（显示详情）
    $modal.on('click', '.favorite_modal_item', function() {
        const favoriteId = $(this).data('id');
        showFavoriteDetail(favoriteId);
    });
    
    // 绑定重命名事件
    $modal.on('click', '.favorite_rename', function(e) {
        e.stopPropagation();
        const favoriteId = $(this).closest('.favorite_modal_item').data('id');
        renameFavorite(favoriteId);
    });
}

// 显示收藏详情模态框
function showFavoriteDetail(favoriteId) {
    const favorite = extension_settings[extensionName].favorites.find(fav => fav.id === favoriteId);
    if (!favorite) return;
    
    const $modal = $(`
        <div class="favorites_detail_modal">
            <div class="favorites_detail_header">
                ${favorite.messageId} ${favorite.role} ${new Date(favorite.timestamp).toLocaleString()}
            </div>
            <div class="favorites_detail_content">
                ${favorite.content}
            </div>
            <div class="favorites_detail_footer">
                <button class="menu_button favorites_detail_delete">删除</button>
                <button class="menu_button favorites_detail_close">关闭</button>
            </div>
        </div>
    `);
    
    $('body').append($modal);
    
    // 绑定关闭事件
    $modal.find('.favorites_detail_close').on('click', () => {
        $modal.remove();
    });
    
    // 绑定删除事件
    $modal.find('.favorites_detail_delete').on('click', () => {
        if (confirm('确定要删除这条收藏吗？')) {
            removeFavorite(favoriteId);
            $modal.remove();
            // 刷新所有相关UI
            updateFavoritesList();
            updateIndexList();
            // 关闭所有可能打开的模态框
            $('.favorites_modal').remove();
            // 重新打开收藏夹
            showFavoritesModal();
        }
    });
}

// 重命名收藏
function renameFavorite(favoriteId) {
    const favorite = extension_settings[extensionName].favorites.find(fav => fav.id === favoriteId);
    if (!favorite) return;
    
    const currentName = favorite.sender;
    
    const $modal = $(`
        <div class="favorites_rename_modal">
            <div class="favorites_rename_header">
                重命名收藏
            </div>
            <div class="favorites_rename_content">
                <input type="text" id="favorites_rename_input" value="${currentName}" class="text_pole">
            </div>
            <div class="favorites_rename_footer">
                <button class="menu_button favorites_rename_cancel">取消</button>
                <button class="menu_button favorites_rename_confirm">确认</button>
            </div>
        </div>
    `);
    
    $('body').append($modal);
    
    // 绑定取消事件
    $modal.find('.favorites_rename_cancel').on('click', () => {
        $modal.remove();
    });
    
    // 绑定确认事件
    $modal.find('.favorites_rename_confirm').on('click', () => {
        const newName = $('#favorites_rename_input').val();
        if (newName && newName !== currentName) {
            favorite.sender = newName;
            saveSettings();
            updateFavoritesList();
            updateIndexList();
        }
        $modal.remove();
    });
}

// 插件入口函数
jQuery(async () => {
    // 加载插件设置页面
    const settingsHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'index');
    $('#extensions_settings').append(settingsHtml);
    
    // 加载消息操作栏按钮
    const buttonHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'buttons');
    $('.extraMesButtons').append(buttonHtml);
    
    // 加载数据银行区域按钮
    const wandHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'wand_ui');
    $('#data_bank_wand_container').append(wandHtml);
    
    // 初始化设置
    await loadSettings();
    
    // 绑定收藏按钮点击事件
    $(document).on('click', '.favorite_button', function() {
        const messageElement = $(this).closest('.mes');
        const messageId = parseInt(messageElement.attr('mesid'));
        
        if (isMessageFavorited(messageId)) {
            // 找到对应的收藏并删除
            const favorite = extension_settings[extensionName].favorites.find(
                fav => fav.messageId === messageId && fav.chatId === getContext().chatId
            );
            if (favorite) {
                removeFavorite(favorite.id);
            }
        } else {
            // 添加收藏
            addFavorite(messageId);
        }
    });
    
    // 绑定数据银行区域按钮点击事件
    $(document).on('click', '#favorites_wand_button', function() {
        const context = getContext();
        showFavoritesModal(context.chatId);
    });
    
    // 绑定索引列表项点击事件
    $(document).on('click', '.favorites_index_item', function() {
        const chatId = $(this).data('chatid');
        showFavoritesModal(chatId);
    });
    
    // 监听聊天变化事件，更新收藏按钮状态
    const context = getContext();
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        setTimeout(() => {
            $('.mes').each(function() {
                const messageId = parseInt($(this).attr('mesid'));
                updateMessageFavoriteStatus(messageId, isMessageFavorited(messageId));
            });
        }, 100);
    });
    
    // 监听新消息事件，为新消息添加收藏按钮状态
    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
        setTimeout(() => {
            const lastMessage = $('.mes').last();
            const messageId = parseInt(lastMessage.attr('mesid'));
            updateMessageFavoriteStatus(messageId, isMessageFavorited(messageId));
        }, 100);
    });
    
    // 初始化UI
    updateIndexList();
});
