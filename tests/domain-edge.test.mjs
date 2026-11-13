// tests/domain-edge.test.mjs - 收藏数据层的边界与「抗脏数据」测试
//
// 与 domain.test.mjs 的分工：那边覆盖正常路径，这边专门钉住**已经踩中或极易踩中的边界**：
//   1. 切换聊天后的补丁重放 —— 消息索引漂移时绝不能写到别的消息上，swipe 越界时不能凭空造槽位
//   2. 脏数据 —— star_favorite 非对象、create_date 缺失，都不得污染虚拟收藏的身份与顺序
//
// 这些用例描述的是「应该怎样」，修复前会失败；失败信息本身就是缺陷说明。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyFavoritePatch,
    buildFavoritePatch,
    buildVirtualFavorites,
    findFavSwipesById,
    mutateSwipeFavorite,
} from '../domain.js';

// ---------- 测试辅助 ----------

/** 构造带稳定身份（send_date）的消息，便于验证补丁的身份校验 */
function makeMessage({ name = 'AI', isUser = false, sendDate = '2023-05-12T21:32:29.224Z', swipeCount = 1, swipes, mes = 'hello' } = {}) {
    const msg = {
        name,
        is_user: isUser,
        send_date: sendDate,
        mes,
        swipe_id: 0,
        swipes: swipes ?? Array.from({ length: swipeCount }, (_, i) => `s${i}`),
        swipe_info: Array.from({ length: swipeCount }, () => ({})),
    };
    return msg;
}

/** 收藏 messages[index] 的第 swipeId 个 swipe，返回整份虚拟收藏（messageId 才会是真实下标） */
function favoriteAt(messages, index, swipeId, fav) {
    if (!messages[index].swipe_info[swipeId]) messages[index].swipe_info[swipeId] = {};
    messages[index].swipe_info[swipeId].star_favorite = fav;
    return buildVirtualFavorites(messages);
}

// =====================================================================
// 一、补丁重放的身份校验：索引漂移不得写到别的消息上
// =====================================================================

test('补丁身份：索引漂移时跳过，绝不把收藏写到另一条消息上', () => {
    // 收藏时聊天里有 3 条消息，收藏落在第 3 条（index 2）
    const original = [
        makeMessage({ sendDate: '2023-01-01T00:00:00.000Z' }),
        makeMessage({ sendDate: '2023-01-02T00:00:00.000Z' }),
        makeMessage({ sendDate: '2023-01-03T00:00:00.000Z' }),
    ];
    const fav = favoriteAt(original, 2, 0, { id: 'fav-on-3rd', note: '属于第 3 条', create_date: 1 });
    const patch = buildFavoritePatch(null, fav, original);

    // 防抖窗口内第 1 条被删除 → 重读文件后 index 2 已经是「原来第 4 条」之类的另一条消息
    const reloaded = [
        makeMessage({ sendDate: '2023-01-02T00:00:00.000Z' }),
        makeMessage({ sendDate: '2023-01-03T00:00:00.000Z' }),
        makeMessage({ sendDate: '2023-01-04T00:00:00.000Z' }),
    ];
    const applied = applyFavoritePatch(reloaded, patch);

    assert.equal(applied, 0, '身份不匹配的补丁必须整条跳过');
    for (const m of reloaded) {
        assert.equal(m.swipe_info[0].star_favorite, undefined, '任何一条消息都不应被写入');
    }
});

test('补丁身份：身份匹配时正常写入，且指纹不得混进 star_favorite', () => {
    const messages = [makeMessage({ sendDate: '2023-02-01T00:00:00.000Z' })];
    const fav = favoriteAt(messages, 0, 0, { id: 'f1', note: '备注', create_date: 7, tags: ['t'] });
    const patch = buildFavoritePatch(null, fav, messages);

    // 模拟「读回同一份文件」：内容一致，身份一致
    const reloaded = [makeMessage({ sendDate: '2023-02-01T00:00:00.000Z' })];
    assert.equal(applyFavoritePatch(reloaded, patch), 1);
    assert.deepEqual(reloaded[0].swipe_info[0].star_favorite, { id: 'f1', note: '备注', create_date: 7, tags: ['t'] });
    assert.deepEqual(Object.keys(reloaded[0].swipe_info[0].star_favorite).sort(), ['create_date', 'id', 'note', 'tags']);
});

test('补丁身份：取消收藏（null）同样受身份保护', () => {
    const messages = [
        makeMessage({ sendDate: '2023-03-01T00:00:00.000Z' }),
        makeMessage({ sendDate: '2023-03-02T00:00:00.000Z' }),
    ];
    // 取消第 2 条上的收藏 → 补丁记为删除
    const fav = favoriteAt(messages, 1, 0, { id: 'f2', note: '', create_date: 2 });
    const patch = buildFavoritePatch(fav, [], messages);
    const removal = [...patch.entries()].find(([key, value]) => key.startsWith('1:0') && value === null);
    assert.ok(removal, '删除仍然用 null 表达（对外形态不变），只是键上多了身份指纹');

    // 索引漂移：index 1 已经是另一条消息，且它自己有收藏 → 不得被误删
    const reloaded = [
        makeMessage({ sendDate: '2023-03-01T00:00:00.000Z' }),
        makeMessage({ sendDate: '2023-03-09T00:00:00.000Z' }),
    ];
    reloaded[1].swipe_info[0].star_favorite = { id: 'other', note: '', create_date: 9 };
    assert.equal(applyFavoritePatch(reloaded, patch), 0);
    assert.equal(reloaded[1].swipe_info[0].star_favorite.id, 'other', '别人的收藏不能被误删');
});

test('补丁身份：未传 messages 时保持旧行为（键与指纹无关，向后兼容）', () => {
    const favs = [{ messageId: '2', favoritedSwipes: [{ swipeId: '1', id: 'f1', note: '', create_date: 9 }] }];
    const patch = buildFavoritePatch(null, favs);
    assert.deepEqual([...patch.keys()], ['2:1'], '不传消息时键不得改变');
    assert.deepEqual(patch.get('2:1'), { id: 'f1', note: '', create_date: 9 });
});

test('补丁身份：消息缺少 send_date 时退化为旧行为（不因无法识别而丢弃收藏）', () => {
    const noDate = {
        name: 'AI', is_user: false, mes: 'x', swipe_id: 0,
        swipes: ['s0'], swipe_info: [{ star_favorite: { id: 'nd', note: '', create_date: 1 } }],
    };
    const patch = buildFavoritePatch(null, buildVirtualFavorites([noDate]), [noDate]);
    const target = {
        name: 'AI', is_user: false, mes: 'x', swipe_id: 0,
        swipes: ['s0'], swipe_info: [{}],
    };
    assert.equal(applyFavoritePatch([target], patch), 1, '没有身份信息时保持宽松策略');
    assert.equal(target.swipe_info[0].star_favorite.id, 'nd');
});

// =====================================================================
// 二、swipe 越界：不得凭空造出 swipe_info 槽位
// =====================================================================

test('swipe 越界：补丁不得为该消息不存在的 swipe 凭空创建槽位', () => {
    const messages = [makeMessage({ swipeCount: 1 })];
    const applied = applyFavoritePatch(messages, new Map([['0:5', { id: 'ghost', note: '', create_date: 1 }]]));

    assert.equal(applied, 0, '越界 swipe 必须跳过');
    assert.equal(messages[0].swipe_info.length, 1, 'swipe_info 不得被撑长');
    assert.equal(messages[0].swipe_info[5], undefined, '不得出现幽灵槽位');
});

test('swipe 越界：完全没有 swipe 的消息（用户消息）允许写入 0 号槽', () => {
    const userMessage = { name: 'User', is_user: true, send_date: '2023-04-01T00:00:00.000Z', mes: '你好', swipes: [], swipe_info: [] };
    assert.equal(applyFavoritePatch([userMessage], new Map([['0:0', { id: 'u1', note: '', create_date: 1 }]])), 1);
    assert.equal(userMessage.swipe_info[0].star_favorite.id, 'u1');
});

test('swipe 越界：swipe_info 比 swipes 长（swipe 被删但索引残留）时仍允许写入已有槽位', () => {
    const msg = makeMessage({ swipeCount: 1 });
    msg.swipe_info.push({});  // 残留的第 2 个槽位
    assert.equal(applyFavoritePatch([msg], new Map([['0:1', { id: 'legacy', note: '', create_date: 1 }]])), 1);
    assert.equal(msg.swipe_info[1].star_favorite.id, 'legacy');
});

// =====================================================================
// 三、脏数据：create_date 缺失不得插队，star_favorite 非对象不得产出幽灵收藏
// =====================================================================

test('脏数据：create_date 缺失的 swipe 不得抢占「最早收藏」，虚拟 id 应落在有时间的那个', () => {
    const messages = [makeMessage({
        swipeCount: 2,
        swipes: ['s0', 's1'],
    })];
    // swipe0 没有 create_date（老数据/手工改文件），swipe1 有
    messages[0].swipe_info[0].star_favorite = { id: 'no-date', note: 'NO-DATE' };
    messages[0].swipe_info[1].star_favorite = { id: 'has-date', note: 'HAS-DATE', create_date: 100 };

    const [fav] = buildVirtualFavorites(messages);
    assert.equal(fav.favoritedSwipes.length, 2);
    assert.equal(fav.id, 'has-date', '虚拟收藏 id 必须取「确实最早」的那条，而不是无时间戳的那条');
    assert.equal(fav.note, 'HAS-DATE');
});

test('脏数据：star_favorite 为真值非对象时忽略该条，不产出 id 为 undefined 的收藏', () => {
    const dirty = [
        { name: 'A', is_user: false, mes: 'x', swipe_id: 0, swipes: ['x'], swipe_info: [{ star_favorite: true }] },
        { name: 'B', is_user: false, mes: 'y', swipe_id: 0, swipes: ['y'], swipe_info: [{ star_favorite: [] }] },
        { name: 'C', is_user: false, mes: 'z', swipe_id: 0, swipes: ['z'], swipe_info: [{ star_favorite: 'nope' }] },
    ];
    assert.deepEqual(buildVirtualFavorites(dirty), [], '非对象脏值一律不产出虚拟收藏');

    // 与脏值混在一起时，正常收藏仍必须能被找到（且不会被 undefined id 抢走）
    const mixed = [
        { name: 'dirty', is_user: false, mes: 'x', swipe_id: 0, swipes: ['x'], swipe_info: [{ star_favorite: true }] },
        { name: 'ok', is_user: false, mes: 'y', swipe_id: 0, swipes: ['y'], swipe_info: [{ star_favorite: { id: 'good', note: '', create_date: 1 } }] },
    ];
    const favs = buildVirtualFavorites(mixed);
    assert.equal(favs.length, 1);
    assert.equal(favs[0].id, 'good');
    assert.equal(findFavSwipesById(favs, undefined), null, 'undefined 不得命中任何收藏');
});

test('脏数据：脏 star_favorite 不阻断取消收藏链路（mutateSwipeFavorite 仍能命中真实收藏）', () => {
    const mixed = [
        { name: 'dirty', is_user: false, mes: 'x', swipe_id: 0, swipes: ['x'], swipe_info: [{ star_favorite: true }] },
        { name: 'ok', is_user: false, mes: 'y', swipe_id: 0, swipes: ['y'], swipe_info: [{ star_favorite: { id: 'good', note: '', create_date: 1 } }] },
    ];
    assert.equal(mutateSwipeFavorite(mixed, 'good', () => 'delete'), true);
    assert.equal(mixed[1].swipe_info[0].star_favorite, undefined);
});
