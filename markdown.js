// markdown.js - 极简 Markdown → HTML 渲染器（更新日志、答疑回复等场景复用）
//
// 为什么独立成模块：它是纯函数、直接决定往弹窗里注入什么 HTML，是最需要也最容易做单测的代码
// （见 tests/markdown.test.mjs）。独立后 update.js / ui/qa.js 都从这里导入，不再各存一份。
//
// 安全约定：先转义 HTML，再拼接受控标签；因此对注入内容安全。支持的语法：
//   标题、粗体、斜体、无序列表、行内代码、代码块、链接、水平线。

import { isSafeLinkUrl } from './utils.js';

/**
 * 将 Markdown 文本渲染为 HTML。
 * @param {string} md - Markdown 原始文本
 * @returns {string} HTML
 */
export function renderMarkdown(md) {
    if (!md) return '';
    let html = md;

    // 保护行内代码和代码块，避免被后续规则干扰
    const codeBlocks = [];
    const inlineCodes = [];

    // 代码块 ```...```
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const escaped = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
        return `\u0000CODEBLOCK${idx}\u0000`;
    });

    // 行内代码 `...`
    html = html.replace(/`([^`]+)`/g, (_, code) => {
        const idx = inlineCodes.length;
        const escaped = code
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        inlineCodes.push(`<code>${escaped}</code>`);
        return `\u0000INLINECODE${idx}\u0000`;
    });

    // HTML 转义（排除占位符）。引号也必须转义：链接 URL 会被拼进 href 属性，
    // 不转义 `"` 就能提前闭合属性并注入 onmouseover 等事件处理器。
    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    // 粗体 **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // 斜体 *text*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // 链接 [text](url)：协议白名单（拒绝 javascript:/data: 等），不安全的链接降级为纯文本
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
        const decoded = url.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        if (!isSafeLinkUrl(decoded)) return text;
        return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    // 标题（按行处理）
    const lines = html.split('\n');
    const result = [];
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 标题
        const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (hMatch) {
            if (inList) { result.push('</ul>'); inList = false; }
            const level = hMatch[1].length;
            result.push(`<h${level}>${hMatch[2]}</h${level}>`);
            continue;
        }

        // 水平线
        if (/^[-*_]{3,}\s*$/.test(line.trim())) {
            if (inList) { result.push('</ul>'); inList = false; }
            result.push('<hr>');
            continue;
        }

        // 无序列表
        const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
        if (ulMatch) {
            if (!inList) { result.push('<ul>'); inList = true; }
            result.push(`<li>${ulMatch[2]}</li>`);
            continue;
        }

        // 普通行：如果之前有列表，先关闭
        if (inList && line.trim() === '') {
            // 空行不关闭列表（markdown 中列表项之间的空行是允许的）
            continue;
        }
        if (inList && line.trim() !== '') {
            result.push('</ul>');
            inList = false;
        }

        if (line.trim() === '') {
            result.push('<br>');
        } else {
            result.push(line);
        }
    }
    if (inList) result.push('</ul>');

    html = result.join('\n');

    // 恢复行内代码
    html = html.replace(/\u0000INLINECODE(\d+)\u0000/g, (_, idx) => inlineCodes[parseInt(idx)]);
    // 恢复代码块
    html = html.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, idx) => codeBlocks[parseInt(idx)]);

    return html;
}
