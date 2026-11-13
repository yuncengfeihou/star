// ui/migration.js - 数据迁移 UI（确认弹窗 + 右侧悬浮球 + 进度面板）
// 设计：老用户首次运行新版时弹出确认弹窗；确认后优先迁移当前聊天，
// 随后后台逐个迁移所有角色，弹窗缩为右侧中央悬浮球（可展开看进度 / 暂停 / 停止 / 继续）。

import { state, getSetting } from '../state.js';
import Logger from '../Logger.js';
import {
    migrateCurrentChat,
    startMigration,
    abortMigration,
    isMigrationRunning,
    setMigrationDone,
} from '../migration.js';
import { refreshFavoriteIconsInView } from '../core.js';
import { showConfirmModal } from './components.js';

const ORB_ID = 'star-migration-orb';
const PANEL_ID = 'star-migration-panel';

let orbElement = null;
let panelElement = null;

// =================================================================
//                  DOM 结构创建（悬浮球 + 面板）
// =================================================================

function applyTheme() {
    const isDark = getSetting('theme') === 'dark'
        || (state.modalDialogElement && state.modalDialogElement.dataset.starTheme === 'dark');
    if (orbElement) {
        if (isDark) orbElement.dataset.starTheme = 'dark';
        else orbElement.removeAttribute('data-star-theme');
    }
    if (panelElement) {
        if (isDark) panelElement.dataset.starTheme = 'dark';
        else panelElement.removeAttribute('data-star-theme');
    }
}

function ensureOrbDom() {
    if (orbElement) return;

    orbElement = document.createElement('div');
    orbElement.id = ORB_ID;
    orbElement.title = '数据迁移进行中，点击查看进度';
    orbElement.innerHTML = '<i class="fa-solid fa-database"></i><span class="star-migration-orb-badge"></span>';
    document.body.appendChild(orbElement);

    panelElement = document.createElement('div');
    panelElement.id = PANEL_ID;
    panelElement.innerHTML = `
        <div class="star-migration-panel-header">
            <span class="star-migration-panel-title"><i class="fa-solid fa-database"></i> 数据迁移</span>
            <div class="star-migration-panel-close" title="收起"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="star-migration-panel-status"></div>
        <div class="star-migration-panel-bar"><div class="star-migration-panel-bar-fill"></div></div>
        <div class="star-migration-panel-buttons">
            <button class="menu_button" id="star-migration-toggle">暂停</button>
            <button class="menu_button" id="star-migration-stop">停止</button>
        </div>
    `;
    document.body.appendChild(panelElement);

    applyTheme();

    // 悬浮球点击：展开/收起面板
    orbElement.addEventListener('click', () => {
        panelElement.classList.toggle('visible');
    });

    panelElement.querySelector('.star-migration-panel-close').addEventListener('click', () => {
        panelElement.classList.remove('visible');
    });

    // 停止：中止迁移并收起悬浮球
    panelElement.querySelector('#star-migration-stop').addEventListener('click', () => {
        abortMigration();
        toastr.info('数据迁移已停止，可随时从「设置 → 数据迁移」重新开始');
        hideMigrationOrb();
    });

    // 暂停/继续
    panelElement.querySelector('#star-migration-toggle').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        if (isMigrationRunning()) {
            abortMigration();
            btn.textContent = '继续';
            updatePanelStatus('已暂停。点击「继续」重新开始（已迁移的聊天会自动跳过）', false);
        } else {
            btn.textContent = '暂停';
            await runBackgroundMigration();
        }
    });
}

function updateOrbBadge(text) {
    const badge = orbElement?.querySelector('.star-migration-orb-badge');
    if (badge) badge.textContent = text || '';
}

function updatePanelStatus(text, isProgress) {
    const statusEl = panelElement?.querySelector('.star-migration-panel-status');
    const barFill = panelElement?.querySelector('.star-migration-panel-bar-fill');
    if (statusEl) statusEl.innerHTML = text || '';
    if (barFill) {
        if (isProgress) barFill.style.width = '100%';
        else barFill.style.width = '0%';
    }
}

/**
 * 迁移进度回调（scanAndMigrate 的 onProgress）。
 */
function onMigrationProgress(info) {
    const statusEl = panelElement?.querySelector('.star-migration-panel-status');
    const barFill = panelElement?.querySelector('.star-migration-panel-bar-fill');
    if (!statusEl) return;

    const charText = `角色 ${info.charIndex + 1}/${info.charTotal}`;
    if (info.phase === 'scan') {
        statusEl.textContent = `正在扫描${charText}：${info.charName}`;
        updateOrbBadge(`${info.charIndex + 1}/${info.charTotal}`);
        if (barFill) barFill.style.width = `${Math.round((info.charIndex / info.charTotal) * 100)}%`;
    } else {
        statusEl.textContent = `正在迁移 ${charText}：${info.chatName}（${info.chatIndex + 1}/${info.chatTotal}）`;
        updateOrbBadge(`${info.charIndex + 1}/${info.charTotal}`);
        if (barFill) barFill.style.width = `${Math.round(((info.charIndex + (info.chatIndex + 1) / info.chatTotal) / info.charTotal) * 100)}%`;
    }
}

function showOrb() {
    if (!orbElement) ensureOrbDom();
    orbElement.style.display = 'flex';
}

function hideMigrationOrb() {
    if (orbElement) orbElement.style.display = 'none';
    if (panelElement) panelElement.classList.remove('visible');
}

// =================================================================
//                      迁移主流程
// =================================================================

/**
 * 后台迁移：优先当前聊天 → 后台逐个角色扫描迁移。
 */
async function runBackgroundMigration() {
    // 1) 当前聊天优先（内存操作，立即完成）
    try {
        const cur = await migrateCurrentChat();
        if (cur.done) {
            // 刷新聊天区收藏图标（swipe_info 已写入）
            setTimeout(refreshFavoriteIconsInView, 150);
        }
    } catch (error) {
        Logger.error('迁移当前聊天失败:', error);
    }

    // 2) 后台扫描所有角色
    const result = await startMigration({ onProgress: onMigrationProgress });
    if (result.aborted) {
        updatePanelStatus('已暂停。点击「继续」重新开始（已迁移的聊天会自动跳过）', false);
        return;
    }

    // 3) 完整跑完一轮扫描即视为处理完成：
    //    有旧数据 → 已迁移；无旧数据 → 无需迁移（两者都置 done，后续不再弹窗）
    setMigrationDone();
    hideMigrationOrb();
    toastr.success(
        `数据迁移完成：${result.chats} 个聊天，共 ${result.migrated} 条收藏${result.skippedChats ? `（${result.skippedChats} 个聊天跳过/失败）` : ''}`,
        '迁移完成',
        { timeOut: 5000 }
    );
}

/**
 * 迁移确认弹窗（首次弹窗 / 设置入口共用）。
 * 文案强调旧版本用户需要迁移才能显示以前的收藏，并说明设置页入口。
 */
export async function showMigrationDialog() {
    // 正在迁移中 → 直接展开悬浮球面板
    if (isMigrationRunning()) {
        ensureOrbDom();
        panelElement.classList.add('visible');
        return;
    }

    const messageHtml = `
        <div class="star-migration-confirm-body">
            <p>检测到<b>旧版本</b>的收藏数据。</p>
            <p>旧版本用户需要<b>迁移数据</b>才能显示以前的收藏。</p>
            <p>点击「立即迁移」将<b>优先迁移当前聊天</b>，随后在后台逐个迁移所有角色的聊天数据，迁移过程中您可以随时暂停。</p>
            <p class="star-migration-confirm-hint">也可以之后在<b>左侧边栏底部的「设置」页面 →「数据迁移」</b>中进行迁移。</p>
        </div>
    `;

    const confirmed = await showConfirmModal(messageHtml, '数据迁移', {
        okButton: '立即迁移',
        cancelButton: '稍后再说',
    });

    if (!confirmed) {
        toastr.info('数据迁移已推迟，可在「设置 → 数据迁移」中随时进行');
        return;
    }

    ensureOrbDom();
    showOrb();
    await runBackgroundMigration();
}
