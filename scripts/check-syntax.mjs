// scripts/check-syntax.mjs - 全量 JS 语法门（零依赖，直接调用 node --check）
// 用途：本扩展没有构建步骤（浏览器直接加载 ESM 源文件），因此任何语法错误只会在
// 用户刷新页面时才暴露。此脚本把「改完刷新看一眼」变成一条可自动执行的命令。
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 跳过第三方压缩副本与工具目录：lib/ 为 modern-screenshot 上游产物，
// worker.js 为同一库的 Web Worker 压缩版，二者不入语法门。
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', '.claude', '.codegraph', '.pi']);
const SKIP_FILES = new Set(['worker.js']);

const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (SKIP_DIRS.has(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith('.js') && !SKIP_FILES.has(name)) files.push(p);
    }
})(ROOT);

let failed = 0;
for (const f of files) {
    try {
        execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (error) {
        failed++;
        console.error(`✗ ${relative(ROOT, f)}`);
        console.error(String(error.stderr || error.message).trim());
    }
}

const passed = files.length - failed;
console.log(`语法检查：${passed}/${files.length} 通过${failed ? `，${failed} 个文件有语法错误` : ''}`);
process.exit(failed ? 1 : 0);
