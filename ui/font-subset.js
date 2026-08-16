// ui/font-subset.js - 字体子集化模块
//
// 核心目标：关闭 modern-screenshot 库自带的 embedWebFont（它在遇到子集化字体
// CSS 如 zeoseven 的 403 个 @font-face 时会全量下载，单条消息截图耗时数秒），
// 改由本模块接管：
//   1. 解析页面字体来源（#custom-style 中的 @import 或内联 @font-face）
//   2. 建立 unicode-range → 字体文件 URL 的映射表（持久化到 IndexedDB）
//   3. 截图时按本次实际文本逐字符查表，只下载真正命中的少数子集文件
//   4. 在 onCreateForeignObjectSvg 阶段把精确子集 @font-face CSS 注入 SVG
//
// 这样既保留了 BabelStone Han / FontAwesome 等自定义字体的正确渲染，
// 又把字体下载量从数百次降到个位数，截图速度提升 10~20 倍。
//
// 缓存分三层：
//   L1 内存 Map（FONT_DATA_MEMORY_CACHE / IMAGE_DATA_MEMORY_CACHE）
//   L2 IndexedDB（持久化，跨会话复用）
//   CSS_CONTENT_MEMORY_CACHE：字体 CSS 文件原文缓存

import Logger from '../Logger.js';

// =================================================================
//                   样式属性白名单（用于 includeStyleProperties）
// =================================================================
// 借鉴 scane2，只复制影响视觉/布局的属性，跳过无用的默认属性，减少克隆开销。
// 注意：保守起见默认不启用（设为 null），仅在需要时传入 domToCanvas。
export const STYLE_WHITELIST_ARRAY = Array.from(new Set([
    'display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear',
    'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border', 'border-width', 'border-style', 'border-color', 'border-radius',
    'border-top-left-radius', 'border-top-right-radius',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'border-collapse', 'border-spacing', 'box-sizing',
    'overflow', 'overflow-x', 'overflow-y',
    'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow', 'flex-shrink', 'flex-wrap',
    'align-content', 'align-items', 'align-self',
    'justify-content', 'justify-items', 'justify-self',
    'gap', 'row-gap', 'column-gap',
    'grid', 'grid-area', 'grid-template', 'grid-template-areas',
    'grid-template-rows', 'grid-template-columns',
    'grid-row', 'grid-row-start', 'grid-row-end',
    'grid-column', 'grid-column-start', 'grid-column-end',
    'color', 'font', 'font-family', 'font-size', 'font-weight', 'font-style',
    'font-variant', 'line-height', 'letter-spacing', 'word-spacing',
    'text-align', 'text-decoration', 'text-indent', 'text-transform', 'text-shadow',
    'white-space', 'vertical-align',
    'background', 'background-color', 'background-image', 'background-repeat',
    'background-position', 'background-size', 'background-clip',
    'opacity', 'visibility', 'box-shadow', 'outline', 'outline-offset',
    'transform', 'transform-origin', 'transform-style', 'filter',
    'list-style', 'list-style-type', 'list-style-position', 'list-style-image',
]));

// =================================================================
//                   内存缓存与状态
// =================================================================
const FONT_DATA_MEMORY_CACHE = new Map();      // 字体文件 URL → dataURL
const IMAGE_DATA_MEMORY_CACHE = new Map();     // 图片 URL → dataURL
const CSS_CONTENT_MEMORY_CACHE = new Map();    // 字体 CSS 来源 URL → 原文
let ACTIVE_FONT_MAPPING = null;                // 当前生效的字体映射 { cssUrl, mapping }
let CACHED_FA_CSS = null;                      // Font Awesome 内联 CSS 缓存

// 字体系统是否已就绪（initFontSystem 完成后置 true）
let fontSystemReady = false;
let fontSystemInitPromise = null;
// #custom-style 变化监听器（避免重复绑定）
let fontObserverBound = false;

// =================================================================
//                   IndexedDB 资源缓存管理器
// =================================================================
class AssetCacheManager {
    constructor(dbName = 'StarScreenshotCache', version = 1) {
        this.db = null;
        this.dbName = dbName;
        // dbVersion 提升到 2 以预留 imageData store（沿用 scane2 结构）
        this.dbVersion = 2;
        this.stores = {
            fontMappings: 'fontMappings', // { cssUrl, mapping }
            fontData: 'fontData',         // { fontUrl, dataUrl }
            imageData: 'imageData',       // { imageUrl, dataUrl }
        };
    }

    async init() {
        if (this.db) return;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.stores.fontMappings)) {
                    db.createObjectStore(this.stores.fontMappings, { keyPath: 'cssUrl' });
                }
                if (!db.objectStoreNames.contains(this.stores.fontData)) {
                    db.createObjectStore(this.stores.fontData, { keyPath: 'fontUrl' });
                }
                if (!db.objectStoreNames.contains(this.stores.imageData)) {
                    db.createObjectStore(this.stores.imageData, { keyPath: 'imageUrl' });
                }
            };
            request.onsuccess = (event) => { this.db = event.target.result; resolve(); };
            request.onerror = (event) => {
                Logger.error('连接 IndexedDB 缓存数据库失败:', event.target.error);
                reject(event.target.error);
            };
        });
    }

    _getStore(storeName, mode = 'readonly') {
        const transaction = this.db.transaction(storeName, mode);
        return transaction.objectStore(storeName);
    }

    // —— 字体映射 ——
    async getMapping(cssUrl) {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.fontMappings);
            const request = store.get(cssUrl);
            request.onsuccess = () => resolve(request.result?.mapping);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async saveMapping(cssUrl, mapping) {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.fontMappings, 'readwrite');
            const request = store.put({ cssUrl, mapping });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // —— 字体文件 ——
    async getAllFontData() {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.fontData);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async getFontData(fontUrl) {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.fontData);
            const request = store.get(fontUrl);
            request.onsuccess = () => resolve(request.result?.dataUrl);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async saveFontData(fontUrl, dataUrl) {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.fontData, 'readwrite');
            const request = store.put({ fontUrl, dataUrl });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }

    // —— 图片 ——
    async getAllImageData() {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.imageData);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async getImageData(imageUrl) {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.imageData);
            const request = store.get(imageUrl);
            request.onsuccess = () => resolve(request.result?.dataUrl);
            request.onerror = (e) => reject(e.target.error);
        });
    }
    async saveImageData(imageUrl, dataUrl) {
        return new Promise((resolve, reject) => {
            const store = this._getStore(this.stores.imageData, 'readwrite');
            const request = store.put({ imageUrl, dataUrl });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    }
}

const assetCacheManager = new AssetCacheManager();

// =================================================================
//                   字体下载与缓存
// =================================================================

/**
 * 下载字体文件并转 dataURL（三级缓存：内存 → IndexedDB → 网络）
 */
async function getFontDataUrlAsync(fontUrl) {
    if (FONT_DATA_MEMORY_CACHE.has(fontUrl)) return FONT_DATA_MEMORY_CACHE.get(fontUrl);

    let dataUrl = await assetCacheManager.getFontData(fontUrl);
    if (dataUrl) {
        FONT_DATA_MEMORY_CACHE.set(fontUrl, dataUrl);
        return dataUrl;
    }

    Logger.debug(`下载并缓存字体文件: ${fontUrl}`);
    try {
        const fontBlob = await fetch(fontUrl).then(res =>
            res.ok ? res.blob() : Promise.reject(`HTTP ${res.status}`)
        );
        dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(fontBlob);
        });
        FONT_DATA_MEMORY_CACHE.set(fontUrl, dataUrl);
        // 后台持久化，不阻塞截图流程
        assetCacheManager.saveFontData(fontUrl, dataUrl).catch(err =>
            Logger.warn('字体持久化失败（不影响本次截图）:', fontUrl, err)
        );
        return dataUrl;
    } catch (err) {
        Logger.error('字体文件下载失败:', fontUrl, err);
        return null;
    }
}

// =================================================================
//                   字体映射构建（解析 unicode-range）
// =================================================================

/**
 * 解析 #custom-style 元素，建立字体映射表。
 * 支持：@import 外部 CSS（如 zeoseven）和内联 @font-face。
 * 映射表结构：{ [charCode]: fontFileUrl, 'default': url }
 * 结果缓存到内存（ACTIVE_FONT_MAPPING）和 IndexedDB。
 */
async function processFontFromStyleElement() {
    Logger.debug('开始解析页面字体来源...');
    const styleElement = document.querySelector('#custom-style');
    if (!styleElement) {
        Logger.warn('字体子集: 未找到 #custom-style 元素，将使用系统默认字体');
        ACTIVE_FONT_MAPPING = null;
        return;
    }

    const rawCss = styleElement.textContent || '';
    if (!rawCss.trim()) {
        Logger.warn('字体子集: #custom-style 为空');
        ACTIVE_FONT_MAPPING = null;
        return;
    }

    const importMatch = /@import\s+url\((['"]?)(.*?)\1\);/g.exec(rawCss);
    let cssContent;
    let baseUrl;
    let styleIdentifier;

    if (importMatch) {
        // 外部字体 CSS（如 zeoseven result.css）
        styleIdentifier = importMatch[2];
        baseUrl = styleIdentifier;
        Logger.debug(`字体子集: 检测到外部字体 CSS @import: ${styleIdentifier}`);
    } else if (rawCss.includes('@font-face')) {
        // 内联 @font-face
        styleIdentifier = 'inline-style:' + rawCss.trim();
        baseUrl = window.location.href;
        cssContent = rawCss;
        Logger.debug('字体子集: 检测到内联 @font-face 规则');
    } else {
        Logger.warn('字体子集: #custom-style 中无 @import 或 @font-face，使用系统默认字体');
        ACTIVE_FONT_MAPPING = null;
        return;
    }

    // 内存命中
    if (ACTIVE_FONT_MAPPING && ACTIVE_FONT_MAPPING.cssUrl === styleIdentifier) {
        Logger.debug('字体子集: 映射已在内存中，跳过');
        return;
    }

    // IndexedDB 命中
    const dbMapping = await assetCacheManager.getMapping(styleIdentifier);
    if (dbMapping) {
        ACTIVE_FONT_MAPPING = { cssUrl: styleIdentifier, mapping: dbMapping };
        Logger.success(`字体子集: 从 IndexedDB 加载映射 (${styleIdentifier.substring(0, 60)}...)`);
        return;
    }

    // 需要下载 CSS 原文并解析
    if (!cssContent) {
        try {
            Logger.debug(`字体子集: 下载外部字体 CSS: ${styleIdentifier}`);
            cssContent = await fetch(styleIdentifier).then(res => res.text());
        } catch (error) {
            Logger.error('字体子集: 下载外部字体 CSS 失败:', styleIdentifier, error);
            return;
        }
    }

    try {
        const fontFaceRegex = /@font-face\s*{([^}]*)}/g;
        const unicodeRangeRegex = /unicode-range:\s*([^;]*);/;
        const urlRegex = /url\((['"]?)(.*?)\1\)/;
        const mapping = {};
        let match;
        let rulesFound = 0;

        while ((match = fontFaceRegex.exec(cssContent)) !== null) {
            rulesFound++;
            const fontFaceBlock = match[1];
            const urlMatch = fontFaceBlock.match(urlRegex);
            if (!urlMatch) continue;

            const fontFileUrl = new URL(urlMatch[2], baseUrl).href;
            const unicodeRangeMatch = fontFaceBlock.match(unicodeRangeRegex);

            if (unicodeRangeMatch) {
                // 解析 unicode-range，展开成 charCode → url 的精细映射
                unicodeRangeMatch[1].split(',').forEach(range => {
                    range = range.trim().toUpperCase();
                    // 去掉 U+ 前缀，支持 U+XXXX-XXXX 和 U+XXXX 两种形式，
                    // 以及通配 U+XXX?（极少见，按字面处理）
                    range = range.startsWith('U+') ? range.substring(2) : range;
                    if (range.includes('-')) {
                        const [start, end] = range.split('-').map(hex => parseInt(hex, 16));
                        if (isNaN(start) || isNaN(end)) return;
                        for (let i = start; i <= end; i++) mapping[i] = fontFileUrl;
                    } else {
                        const code = parseInt(range, 16);
                        if (!isNaN(code)) mapping[code] = fontFileUrl;
                    }
                });
            } else {
                // 无 unicode-range，作为兜底字体
                mapping['default'] = fontFileUrl;
            }
        }

        Logger.debug(`字体子集: 扫描完成，共 ${rulesFound} 条 @font-face 规则`);

        if (Object.keys(mapping).length > 0) {
            await assetCacheManager.saveMapping(styleIdentifier, mapping);
            ACTIVE_FONT_MAPPING = { cssUrl: styleIdentifier, mapping };
            Logger.success(`字体子集: 映射构建成功 (${Object.keys(mapping).length} 个字符码点)`);
        } else {
            Logger.error('字体子集: 解析到 @font-face 但未能提取有效 URL');
        }
    } catch (error) {
        Logger.error('字体子集: 解析字体来源失败:', styleIdentifier, error);
    }
}

// =================================================================
//                   按文本生成精确子集 CSS
// =================================================================

/**
 * 根据本次截图的实际文本，生成精确命中的 @font-face CSS（字体已内联为 dataURL）。
 * 这是最关键的提速点：403 个子集文件 → 只下载命中的几个。
 *
 * @param {string} text 本次要渲染的全部文本
 * @returns {Promise<string>} 可直接注入 SVG defs 的 CSS 字符串
 */
async function getSubsettedFontCssAsync(text) {
    if (!ACTIVE_FONT_MAPPING) {
        Logger.debug('字体子集: 无活动映射，跳过子集生成');
        return '';
    }

    const { cssUrl, mapping } = ACTIVE_FONT_MAPPING;
    const requiredFontUrls = new Set();
    if (mapping['default']) requiredFontUrls.add(mapping['default']);

    // 逐字符查表，收集命中的字体文件
    for (const char of text) {
        const charCode = char.charCodeAt(0);
        if (mapping[charCode]) requiredFontUrls.add(mapping[charCode]);
    }

    if (requiredFontUrls.size === 0) return '';

    // 并行下载命中的字体文件（命中缓存时几乎零耗时）
    const urlToDataUrlMap = new Map();
    await Promise.all([...requiredFontUrls].map(async (url) => {
        const dataUrl = await getFontDataUrlAsync(url);
        if (dataUrl) urlToDataUrlMap.set(url, dataUrl);
    }));

    // 取字体 CSS 原文（带缓存），筛选出命中的 @font-face 规则并替换 URL
    let cssContent;
    let baseUrl;
    if (cssUrl.startsWith('inline-style:')) {
        cssContent = cssUrl.substring('inline-style:'.length);
        baseUrl = window.location.href;
    } else {
        if (CSS_CONTENT_MEMORY_CACHE.has(cssUrl)) {
            cssContent = CSS_CONTENT_MEMORY_CACHE.get(cssUrl);
        } else {
            cssContent = await fetch(cssUrl).then(res => res.text());
            CSS_CONTENT_MEMORY_CACHE.set(cssUrl, cssContent);
        }
        baseUrl = cssUrl;
    }

    const fontFaceRegex = /@font-face\s*{[^}]*}/g;
    const requiredCssRules = [];
    let match;
    while ((match = fontFaceRegex.exec(cssContent)) !== null) {
        const rule = match[0];
        const urlMatch = /url\((['"]?)(.*?)\1\)/.exec(rule);
        if (urlMatch) {
            const fontFileUrl = new URL(urlMatch[2], baseUrl).href;
            if (urlToDataUrlMap.has(fontFileUrl)) {
                requiredCssRules.push(rule.replace(urlMatch[0], `url("${urlToDataUrlMap.get(fontFileUrl)}")`));
            }
        }
    }

    Logger.debug(`字体子集: 本次命中 ${requiredFontUrls.size} 个子集文件，生成 ${requiredCssRules.length} 条 @font-face 规则`);
    return requiredCssRules.join('\n');
}

// =================================================================
//                   Font Awesome 图标处理
// =================================================================

/**
 * 收集页面中 Font Awesome 的 @font-face 规则，下载字体并内联为 dataURL。
 * 图标字体（如收藏星标、相机等）不会被遗漏，保证图标正确显示。
 */
async function getFontAwesomeCssAsync() {
    if (CACHED_FA_CSS) return CACHED_FA_CSS;

    Logger.debug('开始处理 Font Awesome 字体...');
    const fontFaceRules = [];
    for (const sheet of document.styleSheets) {
        try {
            if (!sheet.cssRules) continue;
            for (const rule of sheet.cssRules) {
                if (rule.type === CSSRule.FONT_FACE_RULE && rule.style.fontFamily.includes('Font Awesome')) {
                    fontFaceRules.push(rule);
                }
            }
        } catch (e) {
            // 跨域 stylesheet 无法访问 cssRules，跳过
            continue;
        }
    }

    if (fontFaceRules.length === 0) {
        Logger.debug('字体子集: 未找到 Font Awesome @font-face 规则');
        return '';
    }

    const fontUrlRegex = /url\((['"]?)(.+?)\1\)/g;
    const processedRules = await Promise.all(fontFaceRules.map(async (rule) => {
        let processedRule = rule.cssText;
        const matches = [...rule.cssText.matchAll(fontUrlRegex)];
        for (const m of matches) {
            const originalToken = m[0];
            const absoluteUrl = new URL(m[2], rule.parentStyleSheet?.href || window.location.href).href;
            const dataUrl = await getFontDataUrlAsync(absoluteUrl);
            if (dataUrl) processedRule = processedRule.replace(originalToken, `url("${dataUrl}")`);
        }
        return processedRule;
    }));

    CACHED_FA_CSS = processedRules.join('\n');
    Logger.debug(`字体子集: Font Awesome 处理完成，${processedRules.length} 条规则已内联`);
    return CACHED_FA_CSS;
}

// =================================================================
//                   图片资源 fetchFn（用于 domToCanvas 的跨域图片）
// =================================================================

/**
 * modern-screenshot 的 fetchFn 回调：返回 dataURL 则直接使用，返回 false 走库默认流程。
 * 三级缓存：内存 → IndexedDB → 网络。跨域图片失败时返回 false（库会用占位图）。
 */
export async function customImageFetchFn(url) {
    if (!url || typeof url !== 'string') return false;

    // 排除非法 URL（空 src 等）
    try {
        const urlObj = new URL(url, window.location.origin);
        if (urlObj.pathname === '/' && urlObj.search === '' && urlObj.hash === '') return false;
    } catch (e) {
        return false;
    }

    // data: URI 无需处理
    if (url.startsWith('data:')) return false;

    // L1 内存
    if (IMAGE_DATA_MEMORY_CACHE.has(url)) return IMAGE_DATA_MEMORY_CACHE.get(url);

    // L2 IndexedDB
    let dataUrl = await assetCacheManager.getImageData(url);
    if (dataUrl) {
        IMAGE_DATA_MEMORY_CACHE.set(url, dataUrl);
        return dataUrl;
    }

    // 网络
    try {
        const response = await fetch(url, { mode: 'cors' });
        if (!response.ok) {
            Logger.debug(`图片获取失败 (HTTP ${response.status}): ${url}`);
            return false;
        }
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.startsWith('image/')) {
            Logger.debug(`非图片类型，跳过: ${url} (${contentType})`);
            return false;
        }
        const blob = await response.blob();
        dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        IMAGE_DATA_MEMORY_CACHE.set(url, dataUrl);
        assetCacheManager.saveImageData(url, dataUrl).catch(() => {});
        return dataUrl;
    } catch (err) {
        Logger.debug(`图片获取异常（多为 CORS）: ${url}`);
        return false;
    }
}

// =================================================================
//                   SVG 字体注入（onCreateForeignObjectSvg 回调）
// =================================================================

/**
 * 计算 SVG 字体 CSS：子集字体 + Font Awesome + 必要的布局修复。
 * 在 domToCanvas 的 onCreateForeignObjectSvg 中调用。
 *
 * @param {string} text 本次截图涉及的文本
 * @returns {Promise<string>} 注入用的 CSS
 */
export async function buildSvgFontCss(text) {
    const [subsettedCss, faCss] = await Promise.all([
        getSubsettedFontCssAsync(text),
        getFontAwesomeCssAsync(),
    ]);
    // 布局修复：避免 pre 溢出、引号伪元素干扰等
    const fixCss = [
        'q::before, q::after { content: none !important; }',
        'pre { white-space: pre-wrap !important; word-break: break-all !important; overflow-wrap: break-word !important; }',
    ].join('\n');
    return [subsettedCss, faCss, fixCss].filter(Boolean).join('\n');
}

/**
 * 把字体 CSS 注入 SVG 的 defs（供 onCreateForeignObjectSvg 直接使用）
 */
export function injectFontCssIntoSvg(svg, cssText) {
    if (!cssText) return;
    const styleElement = document.createElement('style');
    styleElement.textContent = cssText;
    let defs = svg.querySelector('defs');
    if (!defs) {
        defs = document.createElement('defs');
        svg.prepend(defs);
    }
    defs.appendChild(styleElement);
}

// =================================================================
//                   缓存失效
// =================================================================

/**
 * 字体来源变化时清空相关缓存（#custom-style 被改写、切主题等）
 */
export function invalidateFontCaches() {
    CSS_CONTENT_MEMORY_CACHE.clear();
    CACHED_FA_CSS = null;
    ACTIVE_FONT_MAPPING = null;
    Logger.debug('字体子集: 缓存已失效');
}

// =================================================================
//               截图设置面板 —— 缓存查询与管理
// =================================================================

/**
 * 从 dataURL 估算实际二进制大小（字节）。
 * dataURL 格式: `data:font/woff2;base64,<payload>`
 * Base64 编码膨胀率为 4/3，即 4 字符 ≈ 3 字节。
 */
function estimateSizeFromDataUrl(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return 0;
    const commaIdx = dataUrl.indexOf(',');
    const base64 = commaIdx > -1 ? dataUrl.substring(commaIdx + 1) : dataUrl;
    // 去掉填充字符 '=' 的影响后 * 0.75
    const stripped = base64.replace(/[=]/g, '');
    return Math.round(stripped.length * 0.75);
}

/** 从 URL 提取可读的文件名 */
function extractFilename(url) {
    if (!url) return '(未知)';
    try {
        const pathname = new URL(url, window.location.origin).pathname;
        return pathname.split('/').pop() || pathname || url.substring(0, 40);
    } catch (e) {
        return url.substring(url.lastIndexOf('/') + 1) || url.substring(0, 40);
    }
}

/**
 * 获取截图缓存的完整统计信息，按字体集聚合展示。
 *
 * 分组策略：
 *   1. 从 fontMappings 表中读取所有 CSS 来源 → mapping，提取映射中引用的所有 url。
 *      这些 url 归入以该 CSS 来源命名的「字体集」；若 CSS URL 已知是 zeoseven 则标为 BabelStone Han。
 *   2. 未在映射中、但 URL 含 fa- / fontawesome 的归入 Font Awesome。
 *   3. 剩余归入「其他字型」。
 *
 * @returns {Promise<{fontSets: Array, images: Array, totals: object}>}
 */
export async function getFontCacheStats() {
    await assetCacheManager.init();

    const [fonts, mappings, images] = await Promise.all([
        assetCacheManager.getAllFontData(),
        new Promise((resolve, reject) => {
            const store = assetCacheManager._getStore('fontMappings');
            const r = store.getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = (e) => reject(e.target.error);
        }),
        assetCacheManager.getAllImageData(),
    ]);

    const estimate = (dataUrl) => {
        if (!dataUrl) return 0;
        const i = dataUrl.indexOf(',');
        const b64 = i > -1 ? dataUrl.substring(i + 1) : dataUrl;
        return Math.round(b64.replace(/[=]/g, '').length * 0.75);
    };
    const fname = (u) => {
        if (!u) return '(未知)';
        try { return new URL(u, window.location.origin).pathname.split('/').pop() || u.substring(0, 40); }
        catch { return u.substring(u.lastIndexOf('/') + 1) || u.substring(0, 40); }
    };
    const toEntry = (entry) => ({
        name: fname(entry.fontUrl || entry.imageUrl),
        url: entry.fontUrl || entry.imageUrl,
        sizeBytes: estimate(entry.dataUrl),
        inMemory: entry.fontUrl
            ? FONT_DATA_MEMORY_CACHE.has(entry.fontUrl)
            : IMAGE_DATA_MEMORY_CACHE.has(entry.imageUrl),
    });

    // ── 聚合字体集 ──
    const fontSets = [];
    const assignedUrls = new Set(); // 已归入某组的 url

    // 1. 从 fontMappings 归组（一个 mapping 内的所有 url 属同一个字体集）
    for (const m of mappings) {
        const cssUrl = m.cssUrl || '';
        const mapping = m.mapping || {};
        const urlsInMapping = new Set(Object.values(mapping));
        if (urlsInMapping.size === 0) continue;

        // 检查哪些已缓存的 url 属于此映射
        const matched = fonts.filter(f => urlsInMapping.has(f.fontUrl));
        if (matched.length === 0) continue;

        const files = matched.map(toEntry).sort((a, b) => b.sizeBytes - a.sizeBytes);
        for (const f of files) assignedUrls.add(f.url);

        // 为 CSS 来源起一个好读的名字
        let label = cssUrl;
        if (/zeoseven|fontsapi/.test(cssUrl)) label = 'BabelStone Han（泽语子集化）';
        else if (/googleapis|fonts\.google/.test(cssUrl)) label = 'Google Fonts';
        else {
            const short = cssUrl.replace(/^https?:\/\//, '').split(/[/?]/)[0];
            label = short || cssUrl.substring(0, 50);
        }

        const totalBytes = files.reduce((s, f) => s + f.sizeBytes, 0);

        fontSets.push({
            id: cssUrl,
            label,
            source: cssUrl,
            fileCount: files.length,
            totalBytes,
            files,
            isActive: ACTIVE_FONT_MAPPING && ACTIVE_FONT_MAPPING.cssUrl === cssUrl,
            mappingEntryCount: Object.keys(mapping).length,
        });
    }

    // 2. Font Awesome（URL 特征匹配）
    const faFiles = fonts
        .filter(f => !assignedUrls.has(f.fontUrl) && /fa-|fontawesome|font.*awesome/i.test(f.fontUrl))
        .map(toEntry).sort((a, b) => b.sizeBytes - a.sizeBytes);
    if (faFiles.length > 0) {
        for (const f of faFiles) assignedUrls.add(f.url);
        fontSets.push({
            id: 'font-awesome',
            label: 'Font Awesome（图标字体）',
            source: null,
            fileCount: faFiles.length,
            totalBytes: faFiles.reduce((s, f) => s + f.sizeBytes, 0),
            files: faFiles,
            isActive: false,
        });
    }

    // 3. 剩余未归类
    const others = fonts
        .filter(f => !assignedUrls.has(f.fontUrl))
        .map(toEntry).sort((a, b) => b.sizeBytes - a.sizeBytes);
    if (others.length > 0) {
        fontSets.push({
            id: 'other-fonts',
            label: '其他字型（未关联映射）',
            source: null,
            fileCount: others.length,
            totalBytes: others.reduce((s, f) => s + f.sizeBytes, 0),
            files: others,
            isActive: false,
        });
    }

    // ── 按总大小降序排列 ──
    fontSets.sort((a, b) => b.totalBytes - a.totalBytes);

    // ── 图片 ──
    const imageEntries = images.map(toEntry).sort((a, b) => b.sizeBytes - a.sizeBytes);

    return {
        fontSets,
        images: imageEntries,
        activeMapping: ACTIVE_FONT_MAPPING
            ? { cssUrl: ACTIVE_FONT_MAPPING.cssUrl, entryCount: Object.keys(ACTIVE_FONT_MAPPING.mapping).length }
            : null,
        totals: {
            fontSetCount: fontSets.length,
            fontFileCount: fontSets.reduce((s, g) => s + g.fileCount, 0),
            fontBytes: fontSets.reduce((s, g) => s + g.totalBytes, 0),
            imageCount: images.length,
            imageBytes: imageEntries.reduce((s, e) => s + e.sizeBytes, 0),
        },
    };
}

/**
 * 删除单个字体缓存条目（IndexedDB + 内存）
 */
export async function deleteFontCacheEntry(fontUrl) {
    await assetCacheManager.init();
    FONT_DATA_MEMORY_CACHE.delete(fontUrl);
    return new Promise((resolve, reject) => {
        const store = assetCacheManager._getStore('fontData', 'readwrite');
        const r = store.delete(fontUrl);
        r.onsuccess = () => { Logger.debug(`字体缓存已删除: ${extractFilename(fontUrl)}`); resolve(true); };
        r.onerror = (e) => reject(e.target.error);
    });
}

/**
 * 批量删除一组字体缓存条目。
 * @param {string[]} urls
 */
export async function deleteFontCacheEntries(urls) {
    await assetCacheManager.init();
    for (const url of urls) {
        FONT_DATA_MEMORY_CACHE.delete(url);
        await new Promise((resolve, reject) => {
            const store = assetCacheManager._getStore('fontData', 'readwrite');
            const r = store.delete(url);
            r.onsuccess = resolve;
            r.onerror = (e) => reject(e.target.error);
        });
    }
    Logger.success(`已批量删除 ${urls.length} 个字体缓存条目`);
}

/**
 * 删除单个图片缓存条目（IndexedDB + 内存）
 */
export async function deleteImageCacheEntry(imageUrl) {
    await assetCacheManager.init();
    IMAGE_DATA_MEMORY_CACHE.delete(imageUrl);
    return new Promise((resolve, reject) => {
        const store = assetCacheManager._getStore('imageData', 'readwrite');
        const request = store.delete(imageUrl);
        request.onsuccess = () => { Logger.debug(`图片缓存已删除: ${extractFilename(imageUrl)}`); resolve(true); };
        request.onerror = (e) => reject(e.target.error);
    });
}

/**
 * 清空全部字体缓存（IndexedDB + 内存）
 */
export async function clearAllFontCache() {
    await assetCacheManager.init();
    FONT_DATA_MEMORY_CACHE.clear();
    return new Promise((resolve, reject) => {
        const store = assetCacheManager._getStore('fontData', 'readwrite');
        const request = store.clear();
        request.onsuccess = () => { Logger.success('字体缓存已全部清空'); resolve(true); };
        request.onerror = (e) => reject(e.target.error);
    });
}

/**
 * 清空全部图片缓存
 */
export async function clearAllImageCache() {
    await assetCacheManager.init();
    IMAGE_DATA_MEMORY_CACHE.clear();
    return new Promise((resolve, reject) => {
        const store = assetCacheManager._getStore('imageData', 'readwrite');
        const request = store.clear();
        request.onsuccess = () => { Logger.success('图片缓存已全部清空'); resolve(true); };
        request.onerror = (e) => reject(e.target.error);
    });
}

/**
 * 获取单张图片缓存的 dataURL（先从内存读，再查 IndexedDB）。
 * @param {string} imageUrl
 * @returns {Promise<string|null>}
 */
export async function getImageDataUrl(imageUrl) {
    await assetCacheManager.init();
    if (IMAGE_DATA_MEMORY_CACHE.has(imageUrl)) {
        return IMAGE_DATA_MEMORY_CACHE.get(imageUrl);
    }
    const entry = await assetCacheManager.getImageData(imageUrl);
    if (entry && entry.dataUrl) {
        IMAGE_DATA_MEMORY_CACHE.set(imageUrl, entry.dataUrl);
        return entry.dataUrl;
    }
    return null;
}

/**
 * 监听 #custom-style 变化，自动重建字体映射。
 * 字体来源改变（如切换主题/角色卡）后无需刷新即可生效。
 */
function setupFontChangeObserver() {
    if (fontObserverBound) return;
    const styleNode = document.querySelector('#custom-style');
    if (!styleNode) return;

    fontObserverBound = true;
    const observer = new MutationObserver(() => {
        Logger.debug('#custom-style 内容变化，重建字体映射...');
        invalidateFontCaches();
        processFontFromStyleElement().catch(err =>
            Logger.error('重建字体映射失败:', err)
        );
    });
    observer.observe(styleNode, { childList: true, characterData: true, subtree: true });
}

// =================================================================
//                   初始化入口
// =================================================================

/**
 * 初始化字体子系统。
 * 应在插件启动时调用（index.js），截图前会自动等待其完成。
 *
 * 流程：
 *   1. 初始化 IndexedDB
 *   2. 把 IndexedDB 中的字体/图片预热到内存（加速首次截图）
 *   3. 构建字体映射表
 *   4. 绑定 #custom-style 变化监听
 */
export async function initFontSystem() {
    if (fontSystemReady) return;
    if (fontSystemInitPromise) return fontSystemInitPromise;

    fontSystemInitPromise = (async () => {
        try {
            Logger.info('字体子系统初始化开始...');

            // 初始化数据库
            await assetCacheManager.init();

            // 预热内存缓存：把 DB 里已有的字体/图片加载到内存
            const t0 = performance.now();
            const [fontCount, imageCount] = await Promise.all([
                assetCacheManager.getAllFontData().then(all => {
                    for (const f of all) FONT_DATA_MEMORY_CACHE.set(f.fontUrl, f.dataUrl);
                    return all.length;
                }),
                assetCacheManager.getAllImageData().then(all => {
                    for (const im of all) IMAGE_DATA_MEMORY_CACHE.set(im.imageUrl, im.dataUrl);
                    return all.length;
                }),
            ]);
            Logger.debug(`字体子系统: 预热缓存完成 (${fontCount} 字体, ${imageCount} 图片, ${Math.round(performance.now() - t0)}ms)`);

            // 构建字体映射
            await processFontFromStyleElement();

            // 绑定变化监听
            setupFontChangeObserver();

            fontSystemReady = true;
            Logger.success('字体子系统初始化完成');
        } catch (err) {
            Logger.error('字体子系统初始化失败（截图将回退到无字体嵌入模式）:', err);
            // 不阻断截图功能，fontSystemReady 保持 false
        } finally {
            fontSystemInitPromise = null;
        }
    })();

    return fontSystemInitPromise;
}

/**
 * 确保字体系统就绪。截图前调用，若尚未初始化则等待初始化完成。
 * 即使初始化失败也会 resolve（保证截图不被阻断，只是字体回退）。
 */
export async function ensureFontSystemReady() {
    if (fontSystemReady) return;
    if (fontSystemInitPromise) {
        await fontSystemInitPromise.catch(() => {});
        return;
    }
    // 未启动过初始化，立即启动并等待
    await initFontSystem().catch(() => {});
}
