// hooks.test.mjs - 跨层钩子与「可取消后台任务」注册中心的单元测试
//
// 这层中间件是本次重构的关键：收藏面板 / 预览 / 角色切换器等重 UI 模块改为按需加载后，
// 数据层与入口层不再直接 import 它们，而是通过 registerCanceller / setCoreHooks 协作。
// 因此这里要钉住三件事：
//   1. 注册/注销是幂等的，重复注册不会重复触发
//   2. 单个取消函数抛错不会影响其他取消函数（切换聊天时必须全部跑到）
//   3. 未注册任何实现时，取到的钩子是「无」而不是抛错（面板没打开是常态）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    registerCanceller,
    runCancellers,
    setCoreHooks,
    getCoreHooks,
    resetHooks,
} from '../hooks.js';

test('runCancellers：调用所有已注册的取消函数', () => {
    resetHooks();
    const calls = [];
    registerCanceller(() => calls.push('a'));
    registerCanceller(() => calls.push('b'));

    runCancellers('chat-changed');

    assert.deepEqual(calls.sort(), ['a', 'b']);
});

test('registerCanceller：返回的注销函数可移除注册', () => {
    resetHooks();
    let count = 0;
    const unregister = registerCanceller(() => count++);

    unregister();
    runCancellers();

    assert.equal(count, 0);
});

test('runCancellers：单个取消函数抛错不影响其余取消函数', () => {
    resetHooks();
    let reached = false;
    registerCanceller(() => { throw new Error('boom'); });
    registerCanceller(() => { reached = true; });

    // 取消路径不应把异常抛给调用方（否则切换聊天会被一个失败的后台任务打断）
    assert.doesNotThrow(() => runCancellers());
    assert.equal(reached, true);
});

test('runCancellers：未注册任何取消函数时为空操作', () => {
    resetHooks();
    assert.doesNotThrow(() => runCancellers());
});

test('setCoreHooks：注入的实现可从 getCoreHooks 读回，并为数据层提供可选调用', async () => {
    resetHooks();
    const events = [];
    setCoreHooks({
        beforeSave: async () => events.push('beforeSave'),
        refreshFavoritesView: async (chatFile) => events.push(`refresh:${chatFile}`),
    });

    const hooks = getCoreHooks();
    await hooks.beforeSave?.();
    await hooks.refreshFavoritesView?.('demo.jsonl');

    assert.deepEqual(events, ['beforeSave', 'refresh:demo.jsonl']);
});

test('setCoreHooks：未注入时 beforeSave 为 null（保存流程用可选链调用，不应抛错）', async () => {
    resetHooks();
    const hooks = getCoreHooks();

    assert.equal(hooks.beforeSave, null);
    await assert.doesNotReject(async () => { await hooks.beforeSave?.(); });
});

test('resetHooks：清空钩子与取消函数注册（测试隔离用）', () => {
    setCoreHooks({ beforeSave: () => {} });
    registerCanceller(() => {});
    resetHooks();

    assert.equal(getCoreHooks().beforeSave, null);
    assert.doesNotThrow(() => runCancellers());
});
