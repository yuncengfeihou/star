// scripts/check-tokens.mjs - 设计令牌「无裸值」校验
//
// 背景：style.css 曾散落 13 种圆角、7 种过渡时长、被复制 10 次的回弹曲线、
// 24 个互不相同的裸 z-index。收敛完成后，若没有门禁，下一次随手写 `border-radius: 6px`
// 就会让这套系统悄悄腐化——而且这类退化在浏览器里「看起来没坏」，很难靠肉眼发现。
//
// 判定原则：
//   * 圆角 / 过渡时长 / z-index / 缓动曲线 一律走令牌，规则内不得出现字面量。
//   * 两处刻意的例外（不算退化，故放行）：
//       1) :root 令牌块本身 —— 令牌的定义处；
//       2) prefers-reduced-motion 块 —— 那里的 0.01ms/0ms 是「关闭动效」的语义值，不是动效设计值；
//       3) 循环动画的周期与 animation-delay 相位偏移 —— 它们是组件专属数值
//          （如等待点 1.4s 循环 + 三个 0.2s 相位），不属于设计语言，作为提示列出而不判失败。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(new URL(rel, new URL('..', import.meta.url)), 'utf8');
const css = read('style.css');

// 去注释但保留换行，保证行号可回溯
const stripComments = (s) => {
    let out = '';
    let i = 0;
    while (i < s.length) {
        if (s.startsWith('/*', i)) {
            const end = s.indexOf('*/', i + 2);
            const stop = end === -1 ? s.length : end + 2;
            out += s.slice(i, stop).replace(/[^\n]/g, ' ');
            i = stop;
        } else {
            out += s[i];
            i += 1;
        }
    }
    return out;
};

const clean = stripComments(css);

// --- 解析出「声明 + 所属选择器 + at-rule 上下文 + 行号」 ---
const lineAt = (pos) => clean.slice(0, pos).split('\n').length;
const decls = [];
const stack = [];
let buf = 0;
for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '{') {
        const prelude = clean.slice(buf, i).trim();
        stack.push({ kind: prelude.startsWith('@') ? 'at' : 'rule', prelude });
        buf = i + 1;
    } else if (ch === '}') {
        buf = i + 1;
        stack.pop();
    } else if (ch === ';') {
        const chunk = clean.slice(buf, i);
        const top = stack[stack.length - 1];
        if (top && top.kind === 'rule' && chunk.includes(':')) {
            const idx = chunk.indexOf(':');
            decls.push({
                line: lineAt(buf),
                prop: chunk.slice(0, idx).trim(),
                value: chunk.slice(idx + 1).trim(),
                sel: top.prelude,
                atRules: stack.filter(s => s.kind === 'at').map(s => s.prelude),
            });
        }
        buf = i + 1;
    }
}

const problems = [];
const loops = [];
const RADIUS_LITERAL = /(?:^|[\s(])\d*\.?\d+(?:px|em|rem|%)/;
const TIME_LITERAL = /(?<![\w.-])\d*\.?\d+(?:s|ms)\b/;

for (const d of decls) {
    const inTokens = d.sel === ':root' || d.sel.startsWith(':root');
    const inReduce = d.atRules.some(a => a.includes('prefers-reduced-motion'));
    const where = `L${d.line} [${d.sel.slice(0, 46)}]`;

    if (inTokens) continue;

    if (d.prop === 'border-radius') {
        // 逐分量检查：允许 令牌 / 50% / 0
        const comps = d.value.replace(/!important/g, '').trim().split(/\s+/);
        for (const c of comps) {
            if (c === '0' || c === '50%' || c.startsWith('var(--star-radius-')) continue;
            problems.push(`${where} border-radius 出现裸值「${c}」，请改用 --star-radius-* 令牌`);
        }
    }

    if (d.prop === 'z-index') {
        const v = d.value.replace(/!important/g, '').trim();
        if (v !== 'auto' && !v.startsWith('var(--star-z-')) {
            problems.push(`${where} z-index 出现裸值「${v}」，请改用 --star-z-* 令牌（层级阶梯见令牌段）`);
        }
    }

    if (d.prop === 'transition' || d.prop === 'transition-duration') {
        if (inReduce) continue;
        const hits = d.value.match(new RegExp(TIME_LITERAL.source, 'g'));
        if (hits) {
            problems.push(`${where} ${d.prop} 出现裸时长「${hits.join(', ')}」，请改用 --star-dur-* 令牌`);
        }
    }

    if (d.prop === 'animation' || d.prop === 'animation-duration') {
        if (inReduce) continue;
        const hits = d.value.match(new RegExp(TIME_LITERAL.source, 'g'));
        if (hits) {
            if (/\binfinite\b/.test(d.value)) {
                loops.push(`${where} 循环周期 ${hits.join(', ')}（infinite，允许保留字面量）`);
            } else {
                problems.push(`${where} ${d.prop} 出现裸时长「${hits.join(', ')}」，请改用 --star-dur-* 令牌`);
            }
        }
    }

    if (d.prop === 'transition' || d.prop === 'animation' ||
        d.prop === 'transition-timing-function' || d.prop === 'animation-timing-function') {
        if (!inReduce && d.value.includes('cubic-bezier(')) {
            problems.push(`${where} ${d.prop} 出现裸缓动曲线，请改用 --star-ease-out / -in-out / -spring`);
        }
    }
}

if (problems.length) {
    console.error('✗ 设计令牌校验失败（规则内出现了裸值）：');
    for (const p of problems) console.error(`   - ${p}`);
    console.error('   令牌定义见 style.css 顶部「0. DESIGN TOKENS」段。');
    process.exit(1);
}

console.log(`设计令牌校验：通过（圆角 / 过渡时长 / z-index / 缓动曲线均无裸值）`);
for (const l of loops) console.log(`提示：${l}`);
