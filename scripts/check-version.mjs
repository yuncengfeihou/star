// scripts/check-version.mjs - 版本号单一事实来源校验
// 背景：版本号曾散落在 manifest.json / state.js / update.html / CHANGELOG.md 四处，
// 漏改的后果是「更新提示永远不出现（或永远消失）」。manifest.json 为唯一事实来源，
// 其余位置由本脚本自动校验。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(new URL(rel, new URL('..', import.meta.url)), 'utf8');

const problems = [];
const notes = [];

const manifest = JSON.parse(read('manifest.json'));
const version = manifest.version;
if (!version) {
    console.error('✗ manifest.json 缺少 version 字段（它是版本号的唯一事实来源）');
    process.exit(1);
}

// 1) state.js 的兜底版本号必须与 manifest 一致
const stateSource = read('state.js');
const fallback = stateSource.match(/LOCAL_VERSION\s*=\s*'([^']+)'/);
if (!fallback) {
    problems.push('state.js 中未找到 LOCAL_VERSION 兜底值');
} else if (fallback[1] !== version) {
    problems.push(`state.js 的 LOCAL_VERSION 兜底值 (${fallback[1]}) 与 manifest.json (${version}) 不一致`);
}

// 2) update.html（面向用户的更新公告）必须声明当前版本
const updateHtml = read('update.html');
if (!updateHtml.includes(`v${version}`)) {
    problems.push(`update.html 中未出现 v${version}（更新公告需要指向当前版本）`);
}

// 3) CHANGELOG 中应存在对应版本段落
const changelog = read('CHANGELOG.md');
const headings = [...changelog.matchAll(/^##\s+\[([^\]]+)\]/gm)].map(m => m[1]);
if (!headings.includes(version)) {
    notes.push(`CHANGELOG.md 尚无 [${version}] 段落。若本次为正式发版，请把 [Unreleased] 改名为 [${version}] 并补日期。`);
}

if (problems.length) {
    console.error('✗ 版本一致性校验失败：');
    for (const p of problems) console.error(`   - ${p}`);
    process.exit(1);
}
console.log(`版本一致性校验：manifest.json v${version} 校验通过`);
for (const n of notes) console.log(`提示：${n}`);
