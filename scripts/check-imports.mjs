// scripts/check-imports.mjs - 静态导入/导出一致性校验（零依赖）
//
// 解决的问题：本扩展没有打包器，模块引用错误（文件不存在、导入了未导出的名字）
// 只会在浏览器运行到那一行时才暴露。本脚本对全仓 ESM 做一次静态核对：
//   1. import / 动态 import('...') 的目标文件是否存在
//   2. 命名导入是否能在目标文件中找到对应导出（含 export { a, b }、export function a、export const/let/class/async function）
// 不处理：宿主路径（../../../../script.js 等）与第三方库，它们在 SillyTavern 运行时才存在。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', '.claude', '.codegraph', '.pi', 'tests']);
const SKIP_FILES = new Set(['worker.js']);

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js')) files.push(p);
    }
})(ROOT);

/** 目标文件导出的名字集合 */
function exportedNames(source) {
    const names = new Set();
    // export function/const/let/class/async function name
    for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        names.add(m[1]);
    }
    // export { a, b as c }
    for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
        for (const part of m[1].split(',')) {
            const seg = part.trim();
            if (!seg) continue;
            const alias = seg.split(/\s+as\s+/);
            names.add((alias[1] || alias[0]).trim());
        }
    }
    // export * from '...'
    const starFrom = [...source.matchAll(/^export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    return { names, starFrom };
}

const problems = [];
const checked = [];

for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const dir = dirname(file);

    // 收集导入：静态 import ... from 'spec' 与动态 import('spec')
    const specs = new Map(); // spec -> Set<imported names>（'*' 表示默认/命名空间）
    const addSpec = (spec, names) => {
        if (!specs.has(spec)) specs.set(spec, new Set());
        for (const n of names) specs.get(spec).add(n);
    };

    for (const m of source.matchAll(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm)) {
        const clause = m[1];
        const spec = m[2];
        const names = new Set(['default']);
        const braced = clause.match(/\{([\s\S]*)\}/);
        if (braced) {
            for (const part of braced[1].split(',')) {
                const seg = part.trim();
                if (!seg) continue;
                const alias = seg.split(/\s+as\s+/);
                names.add((alias[0] || '').trim());
            }
        }
        if (/^\s*\*\s+as\s/.test(clause) || clause.includes('* as')) names.add('*');
        addSpec(spec, names);
    }
    for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        addSpec(m[1], ['*']);
    }

    for (const [spec, names] of specs) {
        // 只校验相对路径（宿主与第三方路径不在本仓）
        if (!spec.startsWith('.')) continue;
        const target = resolve(dir, spec);
        // 解析到仓库之外的一律视为宿主 / 第三方路径（SillyTavern 运行时才存在），只校验仓库内的相对引用
        if (!target.startsWith(ROOT)) continue;
        if (!existsSync(target)) {
            problems.push(`${rel}: 导入的文件不存在 → ${spec}`);
            continue;
        }
        checked.push(`${rel} → ${spec}`);
        const targetSource = readFileSync(target, 'utf8');
        const { names: exported, starFrom } = exportedNames(targetSource);
        for (const name of names) {
            if (name === 'default' || name === '*') continue;
            if (exported.has(name)) continue;
            // 目标有 export * from（barrel）时不做深度校验
            if (starFrom.length > 0) continue;
            problems.push(`${rel}: 从 ${spec} 导入了未导出的名字 "${name}"`);
        }
    }
}

console.log(`导入检查：${checked.length} 条相对导入，${files.length} 个文件`);
if (problems.length) {
    console.error('✗ 发现问题：');
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
}
console.log('导入一致性校验：通过');
