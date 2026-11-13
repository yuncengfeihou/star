// ui/appearance.js - 界面风格与面板背景图（设置页入口）
//
// 职责：
//   1. 界面风格（classic / galgame）的选择入口（实际写入由 theme.js 负责）
//   2. 面板背景图：本地文件 → 压缩 → IndexedDB 持久化 → CSS 变量
//
// 背景图为什么存 IndexedDB 而不是设置项：图片 dataURL 动辄数 MB，写进
// extension_settings（settings.json，服务端明文）会让配置膨胀且随设置同步。
// 项目约定禁止 localStorage；IndexedDB 是唯一合适的持久化位置，不可用时降级为
// 「仅本次会话生效」并明确提示，而不是让功能静默失效。

import { SKINS, getSkin, setSkin } from './theme.js';
import Logger from '../Logger.js';

const OVERLAY_ID = 'star-bg-settings-overlay';
const DB_NAME = 'star-appearance';
const DB_VERSION = 1;
const STORE_NAME = 'assets';
const BACKGROUND_KEY = 'panelBackground';

// 1920px 已足够 900px 宽的面板在高分屏上显示，再大只是内存与 IndexedDB 的浪费
const MAX_BACKGROUND_EDGE = 1920;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_DATA_URL_BYTES = 6 * 1024 * 1024;

let _backgroundDataUrl = null;
let _backgroundName = '';
let _loadPromise = null;

// ==================== IndexedDB ====================

function openDatabase() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            reject(new Error('当前浏览器不支持 IndexedDB'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB 打开失败'));
    });
}

async function readBackgroundRecord() {
    const db = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
            const request = store.get(BACKGROUND_KEY);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function writeBackgroundRecord(record) {
    const db = await openDatabase();
    try {
        await new Promise((resolve, reject) => {
            const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function deleteBackgroundRecord() {
    const db = await openDatabase();
    try {
        await new Promise((resolve, reject) => {
            const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
            const request = store.delete(BACKGROUND_KEY);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

// ==================== 应用背景 ====================

function applyBackgroundToDocument(dataUrl) {
    const root = document.documentElement;
    if (dataUrl) {
        // dataURL 由 canvas.toDataURL 生成，只含 base64 字符，不会破坏 CSS url()
        root.style.setProperty('--star-user-bg', `url("${dataUrl}")`);
        root.setAttribute('data-star-bg', 'on');
    } else {
        root.style.removeProperty('--star-user-bg');
        root.removeAttribute('data-star-bg');
    }
}

/**
 * 读取并应用已保存的背景（懒加载，只读一次 IndexedDB）。
 * 在打开收藏面板时调用；失败时静默降级为「无背景」。
 */
export async function initAppearance() {
    if (!_loadPromise) {
        _loadPromise = (async () => {
            try {
                const record = await readBackgroundRecord();
                if (record && typeof record.dataUrl === 'string' && record.dataUrl) {
                    _backgroundDataUrl = record.dataUrl;
                    _backgroundName = typeof record.name === 'string' ? record.name : '';
                }
            } catch (error) {
                Logger.debug('读取面板背景图失败（按无背景处理）:', error);
            }
        })();
    }
    await _loadPromise;
    applyBackgroundToDocument(_backgroundDataUrl);
}

/** 当前背景图的原始文件名（未设置时为空串）。 */
export function getCurrentBackgroundName() {
    return _backgroundName;
}

// ==================== 图片处理 ====================

function loadImageSource(file) {
    return createImageBitmap(file).catch(() => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('无法解码这张图片'));
        };
        img.src = url;
    }));
}

async function fileToBackgroundDataUrl(file) {
    if (!file || !String(file.type || '').startsWith('image/')) {
        throw new Error('请选择图片文件');
    }
    if (file.size > MAX_SOURCE_BYTES) {
        throw new Error('图片文件过大（上限 20MB）');
    }

    const source = await loadImageSource(file);
    const sourceWidth = source.width || source.naturalWidth || 0;
    const sourceHeight = source.height || source.naturalHeight || 0;
    if (!sourceWidth || !sourceHeight) {
        source.close?.();
        throw new Error('无法读取图片尺寸');
    }

    const scale = Math.min(1, MAX_BACKGROUND_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        source.close?.();
        throw new Error('无法创建画布');
    }
    ctx.drawImage(source, 0, 0, width, height);
    source.close?.();

    // 背景图按「照片」处理：JPEG 压缩率远高于 PNG，且面板上不需要透明通道
    let dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
        dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    }
    if (dataUrl.length > MAX_DATA_URL_BYTES) {
        throw new Error('压缩后的图片仍然过大，请换一张尺寸更小的图片');
    }
    return { dataUrl, width, height };
}

async function setBackgroundImage(file) {
    const { dataUrl } = await fileToBackgroundDataUrl(file);
    _backgroundDataUrl = dataUrl;
    _backgroundName = file.name || '本地图片';
    applyBackgroundToDocument(dataUrl);

    try {
        await writeBackgroundRecord({
            id: BACKGROUND_KEY,
            dataUrl,
            name: _backgroundName,
            updatedAt: Date.now(),
        });
    } catch (error) {
        // 隐私模式/配额耗尽：本次会话仍可用，但刷新后会丢失——必须让用户知道
        Logger.warn('背景图持久化失败（仅本次会话生效）:', error);
        toastr.warning('背景已应用，但浏览器拒绝持久化（隐私模式或存储空间不足），刷新后会失效');
    }
    return { dataUrl };
}

async function clearBackgroundImage() {
    _backgroundDataUrl = null;
    _backgroundName = '';
    applyBackgroundToDocument(null);
    try {
        await deleteBackgroundRecord();
    } catch (error) {
        Logger.debug('删除背景图记录失败（已从界面移除）:', error);
    }
}

// ==================== 设置弹窗 ====================

function paintSkinButtons(dialog) {
    const active = getSkin();
    dialog.querySelectorAll('.star-bg-skin-btn[data-skin]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.skin === active);
        btn.setAttribute('aria-pressed', btn.dataset.skin === active ? 'true' : 'false');
    });
}

function paintBackgroundPreview(dialog) {
    const preview = dialog.querySelector('.star-bg-preview');
    const removeBtn = dialog.querySelector('#star-bg-remove');
    if (!preview) return;

    if (_backgroundDataUrl) {
        preview.classList.add('has-image');
        preview.innerHTML = `<img class="star-bg-preview-img" alt="面板背景预览">`;
        const img = preview.querySelector('img');
        if (img) img.src = _backgroundDataUrl;
    } else {
        preview.classList.remove('has-image');
        preview.innerHTML = '<span class="star-bg-preview-empty"><i class="fa-regular fa-image" aria-hidden="true"></i> 未设置背景图片</span>';
    }

    if (removeBtn) removeBtn.disabled = !_backgroundDataUrl;
    const nameEl = dialog.querySelector('.star-bg-current-name');
    if (nameEl) nameEl.textContent = _backgroundName || '';
}

/**
 * 关闭外观设置浮层（供 Esc/面板关闭复用）。
 */
export function closeAppearanceSettings() {
    const overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) return;
    if (typeof overlay._starClose === 'function') overlay._starClose();
}

/**
 * 打开「外观与背景」设置浮层（设置菜单入口）。
 */
export function openAppearanceSettingsPopup() {
    const existing = document.getElementById(OVERLAY_ID);
    if (existing) {
        closeAppearanceSettings();
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'star-bg-settings-overlay';
    overlay.innerHTML = `
        <div class="star-bg-settings-dialog" role="dialog" aria-modal="true" aria-label="外观与背景">
            <div class="star-bg-settings-header">
                <span class="star-bg-settings-title"><i class="fa-solid fa-palette" aria-hidden="true"></i> 外观与背景</span>
                <div class="star-bg-settings-close" role="button" tabindex="0" aria-label="关闭"><i class="fa-solid fa-xmark" aria-hidden="true"></i></div>
            </div>
            <div class="star-bg-settings-body">
                <div class="star-bg-section-title">界面风格</div>
                <div class="star-bg-skin-row">
                    <button type="button" class="star-bg-skin-btn" data-skin="${SKINS.CLASSIC}" aria-pressed="false">
                        <i class="fa-solid fa-star" aria-hidden="true"></i>
                        <span class="star-bg-skin-name">经典</span>
                        <span class="star-bg-skin-desc">淡紫 · 简洁</span>
                    </button>
                    <button type="button" class="star-bg-skin-btn" data-skin="${SKINS.GALGAME}" aria-pressed="false">
                        <i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>
                        <span class="star-bg-skin-name">Galgame</span>
                        <span class="star-bg-skin-desc">赛璐璐 · 柔光玻璃</span>
                    </button>
                </div>

                <div class="star-bg-section-title">面板背景图片</div>
                <div class="star-bg-preview"></div>
                <div class="star-bg-current-name"></div>
                <div class="star-bg-actions">
                    <button type="button" id="star-bg-choose" class="menu_button"><i class="fa-solid fa-folder-open" aria-hidden="true"></i> 选择本地图片…</button>
                    <button type="button" id="star-bg-remove" class="menu_button" disabled><i class="fa-solid fa-trash-can" aria-hidden="true"></i> 移除背景</button>
                </div>
                <input type="file" id="star-bg-file" accept="image/*" hidden>
                <p class="star-bg-hint">支持 JPG / PNG / WebP。图片只在<b>本机浏览器</b>内压缩并保存（IndexedDB），不会上传；建议使用 1920px 以内的横图。</p>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const dialog = overlay.querySelector('.star-bg-settings-dialog');
    const fileInput = overlay.querySelector('#star-bg-file');
    const chooseBtn = overlay.querySelector('#star-bg-choose');
    const removeBtn = overlay.querySelector('#star-bg-remove');

    const closeOverlay = () => {
        document.removeEventListener('keydown', handleEsc, true);
        overlay._starClose = null;
        overlay.classList.remove('visible');
        setTimeout(() => overlay.remove(), 300);
    };

    const handleEsc = (e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        closeOverlay();
    };
    overlay._starClose = closeOverlay;

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeOverlay();
    });
    overlay.querySelector('.star-bg-settings-close').addEventListener('click', closeOverlay);
    document.addEventListener('keydown', handleEsc, true);

    // 风格切换：立即生效并持久化（theme.js 负责写 <html data-star-skin>）
    dialog.querySelectorAll('.star-bg-skin-btn[data-skin]').forEach(btn => {
        btn.addEventListener('click', () => {
            const skin = btn.dataset.skin;
            setSkin(skin);
            paintSkinButtons(dialog);
            toastr.success(skin === SKINS.GALGAME ? '已切换到 Galgame 界面风格' : '已切换回经典界面风格', '', { timeOut: 1500 });
        });
    });

    chooseBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        chooseBtn.disabled = true;
        try {
            await setBackgroundImage(file);
            paintBackgroundPreview(dialog);
            toastr.success('背景图片已应用', '', { timeOut: 1500 });
        } catch (error) {
            Logger.error('应用背景图片失败:', error);
            toastr.error(`应用背景失败：${error?.message || '未知错误'}`);
        } finally {
            chooseBtn.disabled = false;
        }
    });

    removeBtn.addEventListener('click', async () => {
        removeBtn.disabled = true;
        await clearBackgroundImage();
        paintBackgroundPreview(dialog);
        toastr.info('背景图片已移除', '', { timeOut: 1500 });
    });

    paintSkinButtons(dialog);
    paintBackgroundPreview(dialog);

    requestAnimationFrame(() => {
        if (overlay.isConnected) overlay.classList.add('visible');
    });
}
