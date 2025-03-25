import { extension_settings, getContext, loadExtensionSettings, registerSlashCommand } from "../../../extensions.js";
import { eventSource, event_types, saveSettingsDebounced } from "../../../../script.js";
import { renderExtensionTemplateAsync, getDeviceInfo } from "../../../extensions.js";
import { power_user } from "../../../../power-user.js";
import { callPopup, substituteParams, checkItemInSearch } from "../../../../scripts/extensions.js";
import { chat_metadata } from "../../../../script.js";

// 插件基本信息
const extensionName = "favorites";
const defaultSettings = {
  indexFile: {
    chats: []
  },
  currentPage: 1,
  itemsPerPage: 10
};

// 检查并创建文件夹
async function ensureDirectoryExists(directory) {
  try {
    const response = await fetch('/api/fs/directory', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ directory })
    });
    
    if (!response.ok) {
      console.error(`Failed to create directory: ${directory}`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`Error creating directory: ${error}`);
    return false;
  }
}

// 读取文件
async function readFile(filePath) {
  try {
    const response = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error reading file ${filePath}: ${error}`);
    return null;
  }
}

// 写入文件
async function writeFile(filePath, data) {
  try {
    const response = await fetch('/api/fs/write', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        path: filePath,
        content: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      })
    });
    
    if (!response.ok) {
      console.error(`Failed to write to file: ${filePath}`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`Error writing to file ${filePath}: ${error}`);
    return false;
  }
}

// 初始化插件设置
async function loadSettings() {
  // 确保插件设置存在
  extension_settings[extensionName] = extension_settings[extensionName] || {};
  
  // 如果设置为空，使用默认设置
  if (Object.keys(extension_settings[extensionName]).length === 0) {
    Object.assign(extension_settings[extensionName], defaultSettings);
  }

  // 确保文件夹存在
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const collectionsDirectory = `${pluginDirectory}/collections`;
  await ensureDirectoryExists(collectionsDirectory);

  // 尝试读取索引文件
  const indexFilePath = `${pluginDirectory}/index.json`;
  const indexData = await readFile(indexFilePath);

  if (indexData) {
    extension_settings[extensionName].indexFile = indexData;
  } else {
    // 创建一个新的索引文件
    await writeFile(indexFilePath, extension_settings[extensionName].indexFile);
  }

  // 更新UI
  updateFavoritesDirectory();
}

// 保存设置
function saveSettings() {
  saveSettingsDebounced();
}

// 获取当前聊天信息
function getCurrentChatInfo() {
  const context = getContext();
  const chat = context.chat;
  const chatId = context.chatId;
  
  // 检查是私聊还是群聊
  let isGroup = false;
  let characterId = null;
  let groupId = null;
  let chatName = "";

  if (typeof chatId === 'number') {
    // 私聊
    characterId = chatId;
    const character = context.characters.find(char => char.avatar === context.characters[context.characterId].avatar);
    chatName = character?.name || "未知角色";
  } else {
    // 群聊
    isGroup = true;
    groupId = chatId;
    const group = context.groups.find(g => g.id === chatId);
    chatName = group?.name || "未知群组";
  }

  return {
    chatId,
    isGroup,
    characterId,
    groupId,
    chatName,
    chat
  };
}

// 检查消息是否已收藏
async function isMessageFavorited(messageId) {
  const { chatId } = getCurrentChatInfo();
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const chatFilePath = `${pluginDirectory}/collections/${chatId}.json`;
  
  const chatData = await readFile(chatFilePath);
  if (!chatData || !Array.isArray(chatData)) {
    return false;
  }
  
  return chatData.some(favorite => favorite.messageId === messageId);
}

// 更新消息的收藏状态（UI）
async function updateMessageFavoriteStatus(messageId, isFavorited) {
  const messageElement = $(`.mes[mesid="${messageId}"]`);
  const favoriteButton = messageElement.find('.favorite_button');
  
  if (isFavorited) {
    favoriteButton.addClass('active');
  } else {
    favoriteButton.removeClass('active');
  }
}

// 更新所有消息的收藏状态
async function updateAllMessagesFavoriteStatus() {
  $('.mes').each(async function() {
    const messageId = parseInt($(this).attr('mesid'));
    const isFavorited = await isMessageFavorited(messageId);
    await updateMessageFavoriteStatus(messageId, isFavorited);
  });
}

// 添加收藏
async function addFavorite(messageId) {
  const context = getContext();
  const chatInfo = getCurrentChatInfo();
  const chat = chatInfo.chat;
  
  // 查找消息
  const message = chat.find(msg => msg.index === messageId);
  if (!message) {
    console.error(`无法找到ID为${messageId}的消息`);
    return false;
  }
  
  // 生成唯一ID
  const uniqueId = Date.now().toString() + Math.random().toString(36).substring(2, 9);
  
  // 创建收藏对象
  const favorite = {
    id: uniqueId,
    chatId: chatInfo.chatId,
    messageId: messageId,
    chatname: chatInfo.chatName,
    sender: message.name,
    role: message.is_user ? "user" : (message.is_system ? "system" : "assistant"),
    timestamp: Date.now(),
    content: message.mes,
    summary: message.mes.substring(0, 40) + (message.mes.length > 40 ? "..." : "")
  };
  
  // 添加私聊或群聊特定信息
  if (chatInfo.isGroup) {
    favorite.group = {
      id: chatInfo.groupId,
      name: chatInfo.chatName
    };
  } else {
    favorite.character = {
      id: chatInfo.characterId,
      name: chatInfo.chatName
    };
  }
  
  // 存储收藏数据
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const collectionsDirectory = `${pluginDirectory}/collections`;
  const chatFilePath = `${collectionsDirectory}/${chatInfo.chatId}.json`;
  
  // 读取现有收藏数据
  let chatData = await readFile(chatFilePath);
  if (!chatData) {
    chatData = [];
  }
  
  // 添加新收藏
  chatData.push(favorite);
  
  // 写回文件
  await writeFile(chatFilePath, chatData);
  
  // 更新索引文件
  const indexFilePath = `${pluginDirectory}/index.json`;
  const indexData = extension_settings[extensionName].indexFile;
  
  // 检查聊天是否已在索引中
  const chatIndex = indexData.chats.findIndex(chat => chat.chatId === chatInfo.chatId);
  
  if (chatIndex !== -1) {
    // 更新现有记录
    indexData.chats[chatIndex].count += 1;
  } else {
    // 添加新记录
    indexData.chats.push({
      chatId: chatInfo.chatId,
      type: chatInfo.isGroup ? "group" : "private",
      characterId: chatInfo.characterId,
      groupId: chatInfo.groupId,
      name: chatInfo.chatName,
      count: 1
    });
  }
  
  // 写回索引文件
  await writeFile(indexFilePath, indexData);
  
  // 更新UI
  await updateMessageFavoriteStatus(messageId, true);
  updateFavoritesDirectory();
  
  return true;
}

// 删除收藏
async function removeFavorite(favoriteId, chatId) {
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const chatFilePath = `${pluginDirectory}/collections/${chatId}.json`;
  
  // 读取文件
  let chatData = await readFile(chatFilePath);
  if (!chatData || !Array.isArray(chatData)) {
    console.error(`无法读取聊天收藏数据：${chatId}`);
    return false;
  }
  
  // 查找并移除收藏
  const favoriteIndex = chatData.findIndex(fav => fav.id === favoriteId);
  if (favoriteIndex === -1) {
    console.error(`未找到ID为${favoriteId}的收藏`);
    return false;
  }
  
  const removedFavorite = chatData[favoriteIndex];
  chatData.splice(favoriteIndex, 1);
  
  // 写回文件
  await writeFile(chatFilePath, chatData);
  
  // 更新索引文件
  const indexFilePath = `${pluginDirectory}/index.json`;
  const indexData = extension_settings[extensionName].indexFile;
  
  // 查找并更新索引中的聊天记录
  const chatIndex = indexData.chats.findIndex(chat => chat.chatId === chatId);
  if (chatIndex !== -1) {
    indexData.chats[chatIndex].count -= 1;
    
    // 如果计数为0，可以选择删除该条目
    if (indexData.chats[chatIndex].count <= 0) {
      indexData.chats.splice(chatIndex, 1);
    }
  }
  
  // 写回索引文件
  await writeFile(indexFilePath, indexData);
  
  // 更新UI
  const currentContext = getContext();
  if (removedFavorite.chatId === currentContext.chatId) {
    await updateMessageFavoriteStatus(removedFavorite.messageId, false);
  }
  
  updateFavoritesDirectory();
  
  return true;
}

// 更新收藏列表UI
async function updateFavoritesList(chatId, page = 1) {
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const chatFilePath = `${pluginDirectory}/collections/${chatId}.json`;
  
  // 读取聊天收藏数据
  const chatData = await readFile(chatFilePath);
  const $favoritesList = $('#favorites_list');
  const itemsPerPage = extension_settings[extensionName].itemsPerPage;
  
  // 清空列表
  $favoritesList.empty();
  
  // 如果没有收藏，显示提示信息
  if (!chatData || chatData.length === 0) {
    $favoritesList.append('<div class="no_favorites">未收藏任何消息，现在立刻开始收藏！☺️</div>');
    $('#favorites_pagination').hide();
    return;
  }
  
  // 按收藏时间正序排序
  const sortedFavorites = [...chatData].sort((a, b) => a.timestamp - b.timestamp);
  
  // 计算分页
  const totalPages = Math.ceil(sortedFavorites.length / itemsPerPage);
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, sortedFavorites.length);
  const pageItems = sortedFavorites.slice(startIndex, endIndex);
  
  // 添加收藏项
  for (const favorite of pageItems) {
    // 使用自定义名称或默认名称
    const displayName = favorite.customName || `${favorite.messageId} ${favorite.role} ${new Date(favorite.timestamp).toLocaleString()}`;
    
    const $item = $(`
      <div class="favorite_item" data-id="${favorite.id}" data-chat-id="${favorite.chatId}">
        <div class="favorite_item_header">
          <div class="favorite_item_name">${displayName}</div>
          <div class="favorite_item_actions">
            <div class="favorite_item_action favorite_rename" title="重命名">
              <i class="fa-solid fa-pencil"></i>
            </div>
          </div>
        </div>
        <div class="favorite_item_preview">${favorite.summary}</div>
      </div>
    `);
    
    $favoritesList.append($item);
  }
  
  // 更新分页控件
  const $pagination = $('#favorites_pagination');
  $pagination.empty();
  
  if (totalPages > 1) {
    const $prevButton = $(`<div class="pagination_button ${page === 1 ? 'disabled' : ''}" id="prev_page"><i class="fa-solid fa-chevron-left"></i></div>`);
    const $pageInfo = $(`<div class="pagination_info">${page} / ${totalPages}</div>`);
    const $nextButton = $(`<div class="pagination_button ${page === totalPages ? 'disabled' : ''}" id="next_page"><i class="fa-solid fa-chevron-right"></i></div>`);
    
    $pagination.append($prevButton, $pageInfo, $nextButton);
    $pagination.show();
    
    // 绑定分页事件
    $prevButton.on('click', function() {
      if (page > 1) {
        updateFavoritesList(chatId, page - 1);
      }
    });
    
    $nextButton.on('click', function() {
      if (page < totalPages) {
        updateFavoritesList(chatId, page + 1);
      }
    });
  } else {
    $pagination.hide();
  }
}

// 更新收藏目录UI
function updateFavoritesDirectory(page = 1) {
  const indexData = extension_settings[extensionName].indexFile;
  const $directoryContent = $('#favorites_directory_content');
  const itemsPerPage = extension_settings[extensionName].itemsPerPage;
  
  // 清空内容
  $directoryContent.empty();
  
  // 如果没有收藏，显示提示信息
  if (!indexData.chats || indexData.chats.length === 0) {
    $directoryContent.append('<div class="no_favorites">暂无收藏内容</div>');
    $('#favorites_directory_pagination').hide();
    return;
  }
  
  // 按类型分组
  const privateChats = {};
  const groupChats = {};
  
  for (const chat of indexData.chats) {
    if (chat.type === "private") {
      // 按角色ID分组
      if (!privateChats[chat.characterId]) {
        privateChats[chat.characterId] = {
          name: chat.name,
          chats: []
        };
      }
      privateChats[chat.characterId].chats.push(chat);
    } else {
      // 按群组ID分组
      if (!groupChats[chat.groupId]) {
        groupChats[chat.groupId] = {
          name: chat.name,
          chats: []
        };
      }
      groupChats[chat.groupId].chats.push(chat);
    }
  }
  
  // 计算分页
  const allGroups = [];
  
  // 添加私聊分组
  for (const characterId in privateChats) {
    allGroups.push({
      type: "private",
      name: privateChats[characterId].name,
      chats: privateChats[characterId].chats
    });
  }
  
  // 添加群聊分组
  for (const groupId in groupChats) {
    allGroups.push({
      type: "group",
      name: groupChats[groupId].name,
      chats: groupChats[groupId].chats
    });
  }
  
  const totalPages = Math.ceil(allGroups.length / itemsPerPage);
  const startIndex = (page - 1) * itemsPerPage;
  const endIndex = Math.min(startIndex + itemsPerPage, allGroups.length);
  const pageGroups = allGroups.slice(startIndex, endIndex);
  
  // 渲染分组
  for (const group of pageGroups) {
    const $group = $(`
      <div class="favorites_group">
        <div class="favorites_group_name">${group.name}</div>
        <div class="favorites_chat_list"></div>
      </div>
    `);
    
    const $chatList = $group.find('.favorites_chat_list');
    
    // 添加聊天项
    for (const chat of group.chats) {
      const $chatItem = $(`
        <div class="favorites_chat_item" data-chat-id="${chat.chatId}">
          ${chat.chatId} (${chat.count})
        </div>
      `);
      
      $chatList.append($chatItem);
    }
    
    $directoryContent.append($group);
  }
  
  // 更新分页控件
  const $pagination = $('#favorites_directory_pagination');
  $pagination.empty();
  
  if (totalPages > 1) {
    const $prevButton = $(`<div class="pagination_button ${page === 1 ? 'disabled' : ''}" id="directory_prev_page"><i class="fa-solid fa-chevron-left"></i></div>`);
    const $pageInfo = $(`<div class="pagination_info">${page} / ${totalPages}</div>`);
    const $nextButton = $(`<div class="pagination_button ${page === totalPages ? 'disabled' : ''}" id="directory_next_page"><i class="fa-solid fa-chevron-right"></i></div>`);
    
    $pagination.append($prevButton, $pageInfo, $nextButton);
    $pagination.show();
    
    // 绑定分页事件
    $prevButton.on('click', function() {
      if (page > 1) {
        updateFavoritesDirectory(page - 1);
      }
    });
    
    $nextButton.on('click', function() {
      if (page < totalPages) {
        updateFavoritesDirectory(page + 1);
      }
    });
  } else {
    $pagination.hide();
  }
  
  // 保存当前页码
  extension_settings[extensionName].currentPage = page;
}

// 显示收藏夹UI
async function showFavoritesPopup(chatId) {
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const chatFilePath = `${pluginDirectory}/collections/${chatId}.json`;
  
  // 读取聊天收藏数据
  const chatData = await readFile(chatFilePath);
  
  // 从索引中获取聊天信息
  const indexData = extension_settings[extensionName].indexFile;
  const chatInfo = indexData.chats.find(chat => chat.chatId === chatId);
  
  if (!chatInfo) {
    console.error(`未找到聊天信息: ${chatId}`);
    return;
  }
  
  // 创建弹窗HTML
  const popupHtml = `
    <div class="favorites_backdrop"></div>
    <div class="favorite_detail_popup">
      <div class="favorites_header">
        <div class="favorites_title">${chatInfo.name} ${chatId} (${chatInfo.count})</div>
      </div>
      <div class="favorites_divider"></div>
      <div id="favorites_list" class="favorites_list">
        <!-- 收藏列表将在函数中动态填充 -->
      </div>
      <div id="favorites_pagination" class="favorites_pagination">
        <!-- 分页控件将在函数中动态填充 -->
      </div>
      <div class="favorite_detail_actions">
        <div class="favorite_popup_button" id="close_favorites">关闭</div>
      </div>
    </div>
  `;
  
  // 添加弹窗到页面
  $('body').append(popupHtml);
  
  // 更新收藏列表
  await updateFavoritesList(chatId);
  
  // 绑定关闭按钮事件
  $('#close_favorites').on('click', function() {
    $('.favorites_backdrop, .favorite_detail_popup').remove();
  });
  
  // 绑定点击背景关闭弹窗
  $('.favorites_backdrop').on('click', function() {
    $('.favorites_backdrop, .favorite_detail_popup').remove();
  });
}

// 显示消息详情弹窗
async function showMessageDetailPopup(favoriteId, chatId) {
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const chatFilePath = `${pluginDirectory}/collections/${chatId}.json`;
  
  // 读取聊天收藏数据
  const chatData = await readFile(chatFilePath);
  if (!chatData || !Array.isArray(chatData)) {
    console.error(`无法读取聊天收藏数据：${chatId}`);
    return;
  }
  
  // 查找收藏
  const favorite = chatData.find(fav => fav.id === favoriteId);
  if (!favorite) {
    console.error(`未找到ID为${favoriteId}的收藏`);
    return;
  }
  
  // 创建弹窗HTML
  const popupHtml = `
    <div class="favorites_backdrop"></div>
    <div class="favorite_detail_popup">
      <div class="favorite_detail_header">
        ${favorite.messageId} ${favorite.role} ${new Date(favorite.timestamp).toLocaleString()}
      </div>
      <div class="favorite_detail_content">
        ${favorite.content}
      </div>
      <div class="favorite_detail_actions">
        <div class="favorite_popup_button delete" id="delete_favorite">删除</div>
        <div class="favorite_popup_button" id="close_detail">关闭</div>
      </div>
    </div>
  `;
  
  // 添加弹窗到页面
  $('body').append(popupHtml);
  
  // 绑定关闭按钮事件
  $('#close_detail').on('click', function() {
    $('.favorites_backdrop, .favorite_detail_popup').remove();
  });
  
  // 绑定删除按钮事件
  $('#delete_favorite').on('click', async function() {
    if (confirm('确定要删除此收藏吗？')) {
      // 删除收藏
      await removeFavorite(favoriteId, chatId);
      
      // 关闭详情弹窗
      $('.favorites_backdrop, .favorite_detail_popup').remove();
      
      // 更新收藏列表
      if ($('#favorites_list').length) {
        await updateFavoritesList(chatId);
      }
    }
  });
  
  // 绑定点击背景关闭弹窗
  $('.favorites_backdrop').on('click', function() {
    $('.favorites_backdrop, .favorite_detail_popup').remove();
  });
}

// 显示重命名弹窗
function showRenamePopup(element, favoriteId, chatId) {
  // 移除已存在的重命名弹窗
  $('.rename_popup').remove();
  
  // 创建弹窗HTML
  const popupHtml = `
    <div class="rename_popup">
      <input type="text" class="rename_input" placeholder="输入新名称">
      <div class="rename_actions">
        <div class="favorite_popup_button" id="cancel_rename">取消</div>
        <div class="favorite_popup_button" id="confirm_rename">确认</div>
      </div>
    </div>
  `;
  
  // 添加弹窗到元素
  const $element = $(element);
  $element.css('position', 'relative');
  $element.append(popupHtml);
  
  // 聚焦输入框
  $('.rename_input').focus();
  
  // 绑定取消按钮事件
  $('#cancel_rename').on('click', function() {
    $('.rename_popup').remove();
  });
  
  // 绑定确认按钮事件
  $('#confirm_rename').on('click', async function() {
    const newName = $('.rename_input').val().trim();
    
    if (newName) {
      // 更新收藏名称
      await renameFavorite(favoriteId, chatId, newName);
    }
    
    // 关闭弹窗
    $('.rename_popup').remove();
  });
  
  // 点击弹窗外部关闭弹窗
  $(document).on('click', function(e) {
    if (!$(e.target).closest('.rename_popup, .favorite_rename').length) {
      $('.rename_popup').remove();
    }
  });
}

// 重命名收藏
async function renameFavorite(favoriteId, chatId, newName) {
  const pluginDirectory = `./extensions/third-party/${extensionName}`;
  const chatFilePath = `${pluginDirectory}/collections/${chatId}.json`;
  
  // 读取聊天收藏数据
  const chatData = await readFile(chatFilePath);
  if (!chatData || !Array.isArray(chatData)) {
    console.error(`无法读取聊天收藏数据：${chatId}`);
    return false;
  }
  
  // 查找收藏
  const favoriteIndex = chatData.findIndex(fav => fav.id === favoriteId);
  if (favoriteIndex === -1) {
    console.error(`未找到ID为${favoriteId}的收藏`);
    return false;
  }
  
  // 更新名称
  chatData[favoriteIndex].customName = newName;
  
  // 写回文件
  await writeFile(chatFilePath, chatData);
  
  // 更新UI
  await updateFavoritesList(chatId);
  
  return true;
}

// 清空所有收藏
async function clearAllFavorites() {
  // 显示确认对话框
  if (confirm('确定要清空所有收藏吗？此操作不可撤销。')) {
    const pluginDirectory = `./extensions/third-party/${extensionName}`;
    const collectionsDirectory = `${pluginDirectory}/collections`;
    
    // 重置索引文件
    extension_settings[extensionName].indexFile = { chats: [] };
    await writeFile(`${pluginDirectory}/index.json`, extension_settings[extensionName].indexFile);
    
    // 更新UI
    updateFavoritesDirectory();
    updateAllMessagesFavoriteStatus();
    
    return true;
  }
  
  return false;
}

// 跳转到收藏的消息所在的聊天
async function gotoFavorite(chatId, messageId) {
  const context = getContext();
  
  // 如果不在同一个聊天，先切换聊天
  if (chatId !== context.chatId) {
    // 获取聊天信息
    const indexData = extension_settings[extensionName].indexFile;
    const chatInfo = indexData.chats.find(chat => chat.chatId === chatId);
    
    if (!chatInfo) {
      console.error(`未找到聊天信息: ${chatId}`);
      return false;
    }
    
    // 根据聊天类型切换
    if (chatInfo.type === "private") {
      // 角色聊天
      await context.openCharacterChat(chatInfo.characterId);
    } else {
      // 群组聊天
      await context.openGroupChat(chatInfo.groupId);
    }
  }
  
  // 等待聊天加载完成
  setTimeout(() => {
    // 找到消息元素并滚动到该位置
    const messageElement = $(`.mes[mesid="${messageId}"]`);
    if (messageElement.length > 0) {
      messageElement[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      // 高亮显示消息
      messageElement.addClass('highlight');
      setTimeout(() => {
        messageElement.removeClass('highlight');
      }, 2000);
    } else {
      console.error(`无法找到ID为${messageId}的消息元素`);
    }
  }, 500);
  
  return true;
}

// 插件入口函数
jQuery(async () => {
  // 加载插件设置页面
  const settingsHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'index');
  $('#extensions_settings').append(settingsHtml);
  
  // 加载消息操作栏按钮
  const buttonHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'buttons');
  $('.extraMesButtons').append(buttonHtml);
  
  // 加载魔杖按钮
  const wandButtonHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'wand_ui');
  $('#data_bank_wand_container').append(wandButtonHtml);
  
  // 初始化设置
  await loadSettings();
  
  // 绑定收藏按钮点击事件
  $(document).on('click', '.favorite_button', async function() {
    const messageElement = $(this).closest('.mes');
    const messageId = parseInt(messageElement.attr('mesid'));
    
    // 检查消息是否已收藏
    if (await isMessageFavorited(messageId)) {
      // 获取当前聊天ID
      const { chatId } = getCurrentChatInfo();
      
      // 找到对应的收藏并删除
      const chatFilePath = `./extensions/third-party/${extensionName}/collections/${chatId}.json`;
      const chatData = await readFile(chatFilePath);
      
      if (chatData && Array.isArray(chatData)) {
        const favorite = chatData.find(fav => fav.messageId === messageId);
        if (favorite) {
          await removeFavorite(favorite.id, chatId);
        }
      }
    } else {
      // 添加收藏
      await addFavorite(messageId);
    }
  });
  
  // 绑定魔杖按钮点击事件
  $(document).on('click', '#open_favorites_button', function() {
    const { chatId } = getCurrentChatInfo();
    showFavoritesPopup(chatId);
  });
  
  // 绑定收藏列表中的项目点击事件（查看详情）
  $(document).on('click', '.favorite_item', function(e) {
    // 如果点击的是重命名按钮，不触发详情
    if ($(e.target).closest('.favorite_rename').length) {
      return;
    }
    
    const favoriteId = $(this).attr('data-id');
    const chatId = $(this).attr('data-chat-id');
    showMessageDetailPopup(favoriteId, chatId);
  });
  
  // 绑定收藏列表中的重命名按钮事件
  $(document).on('click', '.favorite_rename', function(e) {
    e.stopPropagation();
    const favoriteItem = $(this).closest('.favorite_item');
    const favoriteId = favoriteItem.attr('data-id');
    const chatId = favoriteItem.attr('data-chat-id');
    showRenamePopup(favoriteItem, favoriteId, chatId);
  });
  
  // 绑定插件页面中的聊天项点击事件
  $(document).on('click', '.favorites_chat_item', function() {
    const chatId = $(this).attr('data-chat-id');
    showFavoritesPopup(chatId);
  });
  
  // 绑定清空所有收藏按钮事件
  $(document).on('click', '#favorites_clear_all', function() {
    clearAllFavorites();
  });
  
  // 监听聊天变化事件，更新收藏按钮状态
  const context = getContext();
  eventSource.on(event_types.CHAT_CHANGED, async () => {
    // 延迟执行，确保聊天消息已加载
    setTimeout(async () => {
      // 更新所有消息的收藏状态
      await updateAllMessagesFavoriteStatus();
    }, 300);
  });
  
  // 监听新消息事件，为新消息添加收藏按钮状态
  eventSource.on(event_types.MESSAGE_RECEIVED, async () => {
    // 延迟执行，确保消息已渲染
    setTimeout(async () => {
      const lastMessage = $('.mes').last();
      const messageId = parseInt(lastMessage.attr('mesid'));
      const isFavorited = await isMessageFavorited(messageId);
      await updateMessageFavoriteStatus(messageId, isFavorited);
    }, 100);
  });
  
  // 监听消息删除事件，更新收藏状态
  eventSource.on(event_types.MESSAGE_DELETED, async (messageId) => {
    // 获取当前聊天ID
    const { chatId } = getCurrentChatInfo();
    
    // 检查该消息是否被收藏
    const chatFilePath = `./extensions/third-party/${extensionName}/collections/${chatId}.json`;
    const chatData = await readFile(chatFilePath);
    
    if (chatData && Array.isArray(chatData)) {
      const favorite = chatData.find(fav => fav.messageId === messageId);
      if (favorite) {
        // 删除收藏
        await removeFavorite(favorite.id, chatId);
      }
    }
  });
  
  // 注册斜杠命令
  registerSlashCommand('favorite', async (args) => {
    const context = getContext();
    const lastMessage = context.chat[context.chat.length - 1];
    
    if (!lastMessage) {
      toastr.warning('没有可收藏的消息');
      return;
    }
    
    const messageId = lastMessage.index;
    
    // 检查消息是否已收藏
    if (await isMessageFavorited(messageId)) {
      toastr.info('该消息已被收藏');
    } else {
      // 添加收藏
      await addFavorite(messageId);
      toastr.success('消息已收藏');
    }
  }, '收藏最新消息', false, true);
});
