// utils.js - 跨模块通用纯函数工具
//
// 设计约束：本文件**不导入任何其他模块**（不依赖 state / Logger / DOM API），
// 因此可以被 Node 直接导入做单元测试（见 tests/）。需要状态的查找函数放在 state.js。
//
// 背景：这些工具此前在 7 个 UI 模块中各有副本（escapeHtml）、或写成 40+ 处内联表达式
// （.replace('.jsonl','')），改一处约定要动十几个文件，故统一到此处。

/**
 * HTML 转义：用户可控文本（备注、角色名、文件名、标签等）插入 HTML 前必须转义，防止自 XSS。
 * 同时转义引号，因此可安全用于属性值（title="..."）。
 */
export function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 去掉聊天文件名的 .jsonl 后缀（幂等）。
 * 统一锚定结尾：旧写法 replace('.jsonl','') 会误删文件名中间的该子串。
 */
export function stripJsonlExt(id) {
    return String(id == null ? '' : id).replace(/\.jsonl$/i, '');
}

/**
 * 判断错误是否由 AbortController 取消请求导致。
 * 取消属于预期内的流程中断，调用方应静默处理，不应弹错误提示或写入脏数据。
 */
export function isAbortError(error, signal = null) {
    if (!error) return false;
    if (error.name === 'AbortError') return true;
    // 兜底：部分环境下错误名不规范，结合 signal 实际状态判断
    if (signal && signal.aborted) return true;
    return false;
}

/**
 * 比较两个版本号（例如 "1.2.3" vs "1.2.4"），忽略 -pre / +build 后缀。
 * @returns {number} 1 (A > B), -1 (A < B), 0 (A === B)
 */
export function compareVersions(versionA, versionB) {
    const cleanA = String(versionA).split('-')[0].split('+')[0];
    const cleanB = String(versionB).split('-')[0].split('+')[0];
    const partsA = cleanA.split('.').map(Number);
    const partsB = cleanB.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const numA = partsA[i] === undefined ? 0 : Number(partsA[i]);
        const numB = partsB[i] === undefined ? 0 : Number(partsB[i]);
        // 非法版本号（如 'abc'）一律视为相等：宁可漏提示更新，也不要渲染成「发现新版本」
        if (Number.isNaN(numA) || Number.isNaN(numB)) return 0;
        if (numA > numB) return 1;
        if (numA < numB) return -1;
    }
    return 0;
}

/**
 * 字节数格式化（缓存面板展示用）。
 */
export function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) {
        value /= 1024;
        i++;
    }
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * 转义正则元字符后构造全局匹配正则（搜索高亮用）。
 * @returns {RegExp|null} 输入为空时返回 null
 */
export function buildHighlightRegex(text) {
    const escaped = String(text == null ? '' : text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!escaped) return null;
    return new RegExp(`(${escaped})`, 'gi');
}

/**
 * 链接安全校验：只允许 http/https/mailto 与相对地址。
 *
 * 供 Markdown 渲染器（markdown.js / ui/qa.js）使用：答疑内容来自可被提示注入的模型输出，
 * 旧的链接规则会把 `javascript:` 与可拼接属性的 URL 原样写进 href。
 * 判定前先去掉空白与控制字符——浏览器解析 URL 时会忽略它们，`java\nscript:` 仍是脚本协议。
 * @returns {boolean} 是否允许作为 href
 */
export function isSafeLinkUrl(url) {
    const compact = String(url == null ? '' : url).replace(/[\u0000-\u0020\u007f]/g, '');
    if (!compact) return false;
    const scheme = compact.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    if (!scheme) return true;
    const name = scheme[1].toLowerCase();
    return name === 'http' || name === 'https' || name === 'mailto';
}

/**
 * 解码 HTML 实体（title 属性里可能含 &quot; 等，需还原为原始字符展示）。
 * 使用 textarea 解码：只解析文本，不执行脚本，安全。
 * 注意：这是本文件唯一依赖 DOM 的函数（需要浏览器环境）。
 */
export function decodeHtmlEntities(str) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = str;
    return textarea.value;
}
