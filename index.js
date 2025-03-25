// index.js 简化调试版
import { extension_settings, getContext, renderExtensionTemplateAsync } from "../../../extensions.js";

const extensionName = "favorites";

async function loadUI() {
    try {
        // 1. 加载设置面板
        const settingsTarget = $('#extensions_settings');
        if (settingsTarget.length) {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'index');
            settingsTarget.append(settingsHtml);
            console.log('Settings panel loaded');
        }
        
        // 2. 加载消息按钮
        const buttonsTarget = $('.extraMesButtons');
        if (buttonsTarget.length) {
            const buttonHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'buttons');
            buttonsTarget.append(buttonHtml);
            console.log('Message buttons loaded');
        }
        
        // 3. 加载数据银行按钮
        const wandTarget = $('#data_bank_wand_container');
        if (wandTarget.length) {
            const wandHtml = await renderExtensionTemplateAsync(`third-party/${extensionName}`, 'wand_ui');
            wandTarget.append(wandHtml);
            console.log('Wand button loaded');
        }
    } catch (error) {
        console.error('UI loading failed:', error);
    }
}

jQuery(async () => {
    console.log('Favorites plugin initializing...');
    
    // 确保核心对象存在
    if (!window.$ || !window.jQuery) {
        console.error('jQuery not found!');
        return;
    }
    
    if (!window.getContext) {
        console.error('SillyTavern API not available!');
        return;
    }
    
    // 延迟加载确保DOM就绪
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 加载UI
    await loadUI();
    
    console.log('Favorites plugin initialized');
});
