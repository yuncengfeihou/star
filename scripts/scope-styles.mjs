// scripts/scope-styles.mjs - 一次性工具：给历史遗留的通用类名选择器加上容器前缀
//
// 背景（见 CODE_REVIEW.md P2-3）：style.css 中有大量通用类名（.favorite-item / .fav-* /
// .context-* / .user-message / .chat-list-item-* 等）直接写在全局命名空间。CSS 是全局的，
// 预览模式还会把这些类名写进宿主聊天区，容易与 SillyTavern 自身或其他扩展的样式互相污染。
//
// 本脚本只做「给选择器加容器前缀」这一件事：
//   - 不改 JS 中的类名（JS 的 querySelector 依旧按类名工作）→ 零行为风险
//   - 不改声明体（属性/取值/!important 全部原样保留）
//   - 已带前缀的选择器保持原样（幂等，可重复执行）
//
// 用法：node scripts/scope-styles.mjs [--write]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS_PATH = fileURLToPath(new URL('../style.css', import.meta.url));
const BACKUP_PATH = CSS_PATH + '.bak';

// 容器锚点：这些 id 由插件自己在运行时创建，可作为作用域锚点
const MODAL = '#favoritesModal';            // 收藏面板（含侧栏、搜索、卡片、分页）
const CONTEXT = '#context-messages-frame';  // 上下文查看器 / 预览气泡
const CHAT = '#chat';                       // 宿主聊天区中被插件注入的元素

// 类名家族 → 所属容器。顺序敏感：先匹配到的生效（fav-reasoning 需在 fav- 之前）。
const SCOPES = [
    // 收藏面板与上下文查看器共用（内心独白折叠块在两处都会渲染）
    { containers: [MODAL, CONTEXT], prefixes: ['fav-reasoning'] },
    // 上下文查看器内部
    { containers: [CONTEXT], prefixes: ['context-', 'user-message', 'ai-message', 'highlighted-message', 'reasoning-arrow'] },
    // 收藏面板内部（卡片与侧栏）
    { containers: [MODAL], prefixes: ['favorites-', 'favorite-item', 'fav-', 'chat-list-item-', 'nav-counter', 'pagination-'] },
    // 宿主聊天区中的收藏图标（只存在于 #chat .mes_buttons 内）
    { containers: [CHAT], prefixes: ['favorite-toggle-icon'] },
];

const matchScope = (cls) => SCOPES.find(s => s.prefixes.some(p => cls === p || cls.startsWith(p)));

const changes = [];
const skippedAtRules = new Set();

/**
 * 给一段「规则前导文本」（{ 之前的部分，可能含多行选择器列表）加前缀。
 * 保留原有换行与缩进，只插入容器选择器。
 */
function scopePrelude(prelude) {
    const trimmed = prelude.trim();
    if (!trimmed) return prelude;
    if (trimmed.startsWith('@')) {
        skippedAtRules.add(trimmed.split(/[\s{(]/)[0]);
        return prelude;
    }

    // 注释可能与选择器同处一段前导文本（例如「/* 角色内容着色 */\n.favorite-item …」），
    // 因此先把注释整体替换为占位符，只对真正的选择器文本做替换，最后再复原注释。
    const comments = [];
    const masked = prelude.replace(/\/\*[\s\S]*?\*\//g, (m) => {
        comments.push(m);
        return `\u0000C${comments.length - 1}\u0000`;
    });

    // 逐选择器处理：以逗号或换行分隔（选择器列表中不会出现字符串逗号）。
    const scoped = masked.replace(/(^|,|\n)([ \t]*)(\.[A-Za-z][\w-]*)/g, (match, sep, ws, cls) => {
        const scope = matchScope(cls.slice(1));
        if (!scope) return match;
        // 多容器（如收藏面板与上下文查看器共用）时展开为并列选择器
        const inserted = scope.containers
            .map((c, idx) => (idx === 0 ? `${c} ${cls}` : `${c} ${ws}${cls}`))
            .join(`, `);
        return `${sep}${ws}${inserted}`;
    });

    return scoped.replace(/\u0000C(\d+)\u0000/g, (_, i) => comments[Number(i)]);
}

const text = readFileSync(CSS_PATH, 'utf8');

// 逐字符扫描，只在「规则前导」上做替换，声明体原样复制
let output = '';
let preludeStart = 0;
let depth = 0;
for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
        const prelude = text.slice(preludeStart, i);
        const scoped = scopePrelude(prelude);
        if (scoped !== prelude) changes.push([prelude.trim().split('\n')[0], scoped.trim().split('\n')[0]]);
        output += scoped + '{';
        preludeStart = i + 1;
    } else if (ch === '}') {
        output += text.slice(preludeStart, i + 1);
        preludeStart = i + 1;
    }
}
output += text.slice(preludeStart);

// 自检 1：括号配平（结构未被破坏）
const balance = (output.match(/\{/g) || []).length - (output.match(/\}/g) || []).length;
if (balance !== 0) {
    console.error(`✗ 括号不配平（差 ${balance}），已中止，未写入`);
    process.exit(1);
}
// 自检 2：规则数量不变（没有把规则拆散或吞掉）
const ruleCount = (s) => (s.match(/\{/g) || []).length;
if (ruleCount(output) !== ruleCount(text)) {
    console.error('✗ 规则数量发生变化，已中止，未写入');
    process.exit(1);
}
// 自检 3：声明体数量不变（没有误改声明块）
const declCount = (s) => (s.match(/;/g) || []).length;
if (declCount(output) !== declCount(text)) {
    console.error('✗ 声明数量发生变化，已中止，未写入');
    process.exit(1);
}

// --check：只做自查，存在未加作用域的遗留类名时以非零退出（可接入质量门禁）
if (process.argv.includes('--check')) {
    if (changes.length === 0) {
        console.log('样式作用域自查：通过（无未加作用域的遗留类名）');
        process.exit(0);
    }
    console.error(`✗ 样式作用域自查失败：${changes.length} 条规则仍在全局命名空间下`);
    for (const [before] of changes.slice(0, 20)) console.error(`   - ${before}`);
    console.error('  修复：运行 npm run css:scope 自动加容器前缀');
    process.exit(1);
}

console.log(`待处理规则：${changes.length} 条`);
for (const [before, after] of changes.slice(0, 10)) {
    console.log(`  - ${before}`);
    console.log(`    → ${after}`);
}
if (changes.length > 10) console.log(`  …（其余 ${changes.length - 10} 条同理）`);

if (process.argv.includes('--write')) {
    if (changes.length === 0) {
        console.log('\n无需修改：所有遗留类名均已在容器作用域内');
        process.exit(0);
    }
    copyFileSync(CSS_PATH, BACKUP_PATH);
    writeFileSync(CSS_PATH, output);
    console.log('\n已写入 style.css（原文件备份为 style.css.bak，确认无误后可删除）');
} else {
    console.log('\n（未写入；加 --write 生效）');
}
