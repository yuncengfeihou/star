// tests/utils.test.mjs - 通用工具函数的单元测试
//
// utils.js 刻意不依赖 state/Logger/DOM（除 decodeHtmlEntities 外），因此可直接在 Node 中运行。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    escapeHtml,
    stripJsonlExt,
    isAbortError,
    compareVersions,
    formatBytes,
    buildHighlightRegex,
    isSafeLinkUrl,
} from '../utils.js';

// ---------- isSafeLinkUrl ----------

test('isSafeLinkUrl：只放行 http/https/mailto 与相对地址', () => {
    for (const url of ['https://example.com', 'http://a.b/c?d=1', 'mailto:a@b.com', '/chat/1', './x', '../x', '#anchor']) {
        assert.equal(isSafeLinkUrl(url), true, `应允许: ${url}`);
    }
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:msgbox(1)', 'file:///etc/passwd', '']) {
        assert.equal(isSafeLinkUrl(url), false, `应拒绝: ${url}`);
    }
});

test('isSafeLinkUrl：忽略空白/控制字符，java\\nscript: 仍按脚本协议拒绝', () => {
    assert.equal(isSafeLinkUrl('java\nscript:alert(1)'), false);
    assert.equal(isSafeLinkUrl(' \tjavascript:alert(1)'), false);
    assert.equal(isSafeLinkUrl('ht\ntps://example.com'), true);
});

// ---------- escapeHtml ----------

test('escapeHtml：转义 & < > " \'（含属性场景）', () => {
    assert.equal(escapeHtml('<img src=x onerror="alert(1)">'),
        '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(escapeHtml("it's"), 'it&#39;s');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
});

test('escapeHtml：null/undefined/数字安全处理', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
});

test('escapeHtml：与号先于其他字符替换（不会重复转义）', () => {
    // 若 & 未优先替换，'&lt;' 会被二次转义成 '&amp;lt;'
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

// ---------- stripJsonlExt ----------

test('stripJsonlExt：去掉结尾的 .jsonl 且幂等', () => {
    assert.equal(stripJsonlExt('角色-2024.jsonl'), '角色-2024');
    assert.equal(stripJsonlExt('角色-2024'), '角色-2024');
    assert.equal(stripJsonlExt('a.jsonl.jsonl'), 'a.jsonl');
});

test('stripJsonlExt：不误删文件名中间的 .jsonl（旧写法会删）', () => {
    assert.equal(stripJsonlExt('my.jsonl.bak'), 'my.jsonl.bak');
    assert.equal(stripJsonlExt('.jsonl'), '');
});

test('stripJsonlExt：null/undefined/数字安全处理', () => {
    assert.equal(stripJsonlExt(null), '');
    assert.equal(stripJsonlExt(undefined), '');
    assert.equal(stripJsonlExt(123), '123');
});

// ---------- compareVersions ----------

test('compareVersions：主次修订号比较', () => {
    assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
    assert.equal(compareVersions('1.2.4', '1.2.3'), 1);
    assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
    assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
    assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
});

test('compareVersions：缺位补 0，忽略预发布/构建后缀', () => {
    assert.equal(compareVersions('1.2', '1.2.0'), 0);
    assert.equal(compareVersions('1.2.3-beta.1', '1.2.3'), 0);
    assert.equal(compareVersions('1.2.3+build5', '1.2.3'), 0);
});

test('compareVersions：非法输入返回 0（不抛错）', () => {
    assert.equal(compareVersions('abc', '1.0.0'), 0);
    assert.equal(compareVersions('', ''), 0);
});

// ---------- isAbortError ----------

test('isAbortError：识别 AbortError 与已中止的 signal', () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    assert.equal(isAbortError(abortError), true);
    // 错误名不规范时，回退看 signal 状态
    assert.equal(isAbortError(new Error('boom'), { aborted: true }), true);
    assert.equal(isAbortError(new Error('boom'), { aborted: false }), false);
    assert.equal(isAbortError(null), false);
});

// ---------- formatBytes ----------

test('formatBytes：按 B/KB/MB/GB 换算并保留一位小数', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
});

// ---------- buildHighlightRegex ----------

test('buildHighlightRegex：转义正则元字符并全局忽略大小写', () => {
    const re = buildHighlightRegex('a.b(c)');
    assert.ok(re instanceof RegExp);
    assert.equal(re.flags.includes('i'), true);
    assert.equal(re.flags.includes('g'), true);
    assert.ok('xxA.B(C)yy'.match(re), '应把 . 与括号当字面量匹配');
});

test('buildHighlightRegex：空输入返回 null（调用方无需再判空串）', () => {
    assert.equal(buildHighlightRegex(''), null);
    assert.equal(buildHighlightRegex(null), null);
});
