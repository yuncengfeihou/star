// tests/markdown.test.mjs - 更新日志 Markdown 渲染器（markdown.js）的单元测试
//
// renderMarkdown 直接决定往更新弹窗里注入什么 HTML，因此「先转义、再拼接受控标签」这条
// 安全约定必须有测试守门 —— 这正是历史上最容易写漏的地方。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../markdown.js';

test('renderMarkdown：先转义再拼接受控标签（脚本注入不会穿透）', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    assert.equal(html.includes('<script>'), false, '原始 <script> 标签必须被转义');
    assert.ok(html.includes('&lt;script&gt;'));
});

test('renderMarkdown：标题、粗体、斜体、列表、水平线', () => {
    assert.ok(renderMarkdown('## 版本 2.3.0').includes('<h2>版本 2.3.0</h2>'));
    assert.ok(renderMarkdown('**重点**').includes('<strong>重点</strong>'));
    assert.ok(renderMarkdown('*斜体*').includes('<em>斜体</em>'));
    const list = renderMarkdown('- 第一项\n- 第二项');
    assert.ok(list.includes('<ul>'));
    assert.equal((list.match(/<li>/g) || []).length, 2);
    assert.ok(renderMarkdown('---').includes('<hr>'));
});

test('renderMarkdown：链接带 target/rel（避免 window.opener 泄漏）', () => {
    const html = renderMarkdown('[仓库](https://example.com)');
    assert.ok(html.includes('href="https://example.com"'));
    assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('renderMarkdown：链接不允许属性注入与脚本协议', () => {
    // 引号被转义后无法提前闭合 href 属性（事件处理器不会成为真实属性）
    const injected = renderMarkdown('[点我](x" onmouseover="alert(1))');
    assert.equal(/\sonmouseover\s*=\s*["']/.test(injected), false);
    assert.ok(injected.includes('&quot;'));

    // 脚本/数据协议降级为纯文本，不生成 <a>
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html;base64,xxx', 'vbscript:msgbox(1)']) {
        const html = renderMarkdown(`[点我](${url})`);
        assert.equal(html.includes('<a '), false, `不应生成链接: ${url}`);
    }

    // 相对地址与 mailto 允许
    assert.ok(renderMarkdown('[首页](/index.html)').includes('<a '));
    assert.ok(renderMarkdown('[邮件](mailto:a@b.com)').includes('<a '));
});

test('renderMarkdown：行内代码与代码块的 HTML 被转义，且不被其他规则改写', () => {
    const inline = renderMarkdown('用 `**不要加粗**` 包裹');
    assert.ok(inline.includes('<code>**不要加粗**</code>'), '行内代码内的 * 不应被当作斜体');

    const block = renderMarkdown('```js\nconst a = 1 < 2;\n```');
    assert.ok(block.includes('<pre><code>'));
    assert.ok(block.includes('1 &lt; 2'));
});

test('renderMarkdown：空输入返回空串', () => {
    assert.equal(renderMarkdown(''), '');
    assert.equal(renderMarkdown(null), '');
});
