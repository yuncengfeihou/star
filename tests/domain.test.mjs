// tests/domain.test.mjs - 收藏领域纯逻辑的单元测试
//
// 这些函数（domain.js）不依赖 DOM 与扩展设置，因此可以用 node --test 直接跑：
//   npm test
//
// 覆盖重点放在历史上真正出过问题的地方：
//   - 虚拟收藏的构建顺序与 id 取值（多 swipe 场景的「误读第一条」bug）
//   - 旧格式迁移的幂等性与越界保护
//   - swipe 定位的增删改分发（写了但没删掉 = UI 与数据不同步）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    applyFavoritePatch,
    buildFavoritePatch,
    buildVirtualFavorites,
    findFavSwipesById,
    flattenFavoriteSwipes,
    isBlankMessage,
    isLegacyFormat,
    migrateLegacyFavorites,
    mutateSwipeFavorite,
    preserveSwipeViewIndexes,
} from '../domain.js';

// ---------- preserveSwipeViewIndexes ----------

test('preserveSwipeViewIndexes：写操作重建后保留多 swipe 卡片的查看位置', () => {
    const previous = [
        { messageId: '3', favoritedSwipes: [{ id: 'a' }, { id: 'b' }], currentSwipeViewIndex: 1 },
        { messageId: '5', favoritedSwipes: [{ id: 'c' }], currentSwipeViewIndex: 0 },
    ];
    const next = [
        { messageId: '3', favoritedSwipes: [{ id: 'a' }, { id: 'b' }], currentSwipeViewIndex: 0 },
        { messageId: '5', favoritedSwipes: [{ id: 'c' }], currentSwipeViewIndex: 0 },
    ];
    preserveSwipeViewIndexes(next, previous);
    assert.equal(next[0].currentSwipeViewIndex, 1, '2/2 应被保留');
    assert.equal(next[1].currentSwipeViewIndex, 0, '单 swipe 不受影响');
});

test('preserveSwipeViewIndexes：索引越界/消息已消失时回落到 0，不产生越界读取', () => {
    const next = [
        { messageId: '3', favoritedSwipes: [{ id: 'a' }], currentSwipeViewIndex: 0 },
        { messageId: '7', favoritedSwipes: [{ id: 'b' }], currentSwipeViewIndex: 0 },
    ];
    const previous = [
        { messageId: '3', favoritedSwipes: [{ id: 'a' }, { id: 'b' }], currentSwipeViewIndex: 1 },
        { messageId: '9', favoritedSwipes: [{ id: 'x' }], currentSwipeViewIndex: 1 },
    ];
    preserveSwipeViewIndexes(next, previous);
    assert.equal(next[0].currentSwipeViewIndex, 0, 'swipe 被移除后不能指向不存在的下标');
    assert.equal(next[1].currentSwipeViewIndex, 0, '旧消息不存在时保持默认值');
});

test('preserveSwipeViewIndexes：宽容处理空/非法输入', () => {
    assert.deepEqual(preserveSwipeViewIndexes([], null), []);
    const favs = [{ messageId: '1', favoritedSwipes: [{ id: 'a' }], currentSwipeViewIndex: 0 }];
    assert.equal(preserveSwipeViewIndexes(favs, undefined), favs);
});

// ---------- 测试辅助 ----------

/** 构造一条消息：favoritedSwipes 为 {swipeId: {id, note, create_date, tags?}} */
function makeMessage({ name = 'AI', isUser = false, swipes = [], mes = 'hello', extra = undefined } = {}) {
    const swipeCount = swipes.length || 1;
    const msg = {
        name,
        is_user: isUser,
        mes,
        swipes: swipes.map(s => s.text ?? 'text'),
        swipe_id: 0,
        swipe_info: Array.from({ length: swipeCount }, (_, i) => {
            const fav = swipes[i]?.favorite;
            return fav ? { star_favorite: fav } : {};
        }),
    };
    if (extra !== undefined) msg.extra = extra;
    return msg;
}

// ---------- buildVirtualFavorites ----------

test('buildVirtualFavorites：无收藏时返回空数组', () => {
    const messages = [makeMessage(), makeMessage()];
    assert.deepEqual(buildVirtualFavorites(messages), []);
    assert.deepEqual(buildVirtualFavorites([]), []);
    assert.deepEqual(buildVirtualFavorites(null), []);
});

test('buildVirtualFavorites：同一消息的多个 swipe 合并为一项，按收藏时间升序排列', () => {
    const messages = [makeMessage({
        swipes: [
            { favorite: { id: 'b', note: '晚', create_date: 200 } },
            { favorite: { id: 'a', note: '早', create_date: 100 } },
            { text: '未收藏' },
        ],
    })];

    const result = buildVirtualFavorites(messages);
    assert.equal(result.length, 1, '同一消息只应产出一个虚拟收藏项');
    assert.equal(result[0].favoritedSwipes.length, 2);
    // 排序后第一项应是较早收藏的 swipe，虚拟收藏的 id 取它
    assert.equal(result[0].id, 'a');
    assert.equal(result[0].note, '早');
    assert.deepEqual(result[0].favoritedSwipes.map(s => s.swipeId), ['1', '0']);
});

test('buildVirtualFavorites：messageId 为消息在数组中的索引（字符串），并标记发送者角色', () => {
    const messages = [
        makeMessage({ name: '用户', isUser: true }),
        makeMessage({ swipes: [{ favorite: { id: 'x', note: '', create_date: 1 } }] }),
    ];
    const result = buildVirtualFavorites(messages);
    assert.equal(result.length, 1);
    assert.equal(result[0].messageId, '1');
    assert.equal(result[0].sender, 'AI');
    assert.equal(result[0].role, 'character');
    assert.equal(result[0].currentSwipeViewIndex, 0);
});

test('buildVirtualFavorites：容忍缺失 swipe_info / 空元素的消息', () => {
    const messages = [{ mes: 'no swipe_info' }, null, { swipe_info: [null, {}] }];
    assert.doesNotThrow(() => buildVirtualFavorites(messages));
    assert.deepEqual(buildVirtualFavorites(messages), []);
});

// ---------- findFavSwipesById ----------

test('findFavSwipesById：多 swipe 时按「包含该 id」查找，而不是只看首个 id', () => {
    const favorites = buildVirtualFavorites([makeMessage({
        swipes: [
            { favorite: { id: 'first', note: '第一条', create_date: 1 } },
            { favorite: { id: 'second', note: '第二条', create_date: 2 } },
        ],
    })]);

    // 非首个 swipe 也必须能命中（历史 bug：命中失败并误读第一条数据）
    const hit = findFavSwipesById(favorites, 'second');
    assert.ok(hit, '非首个 swipe 应能查到');
    assert.equal(hit.find(s => s.id === 'second').note, '第二条');
    assert.equal(findFavSwipesById(favorites, 'not-exist'), null);
    assert.equal(findFavSwipesById(null, 'first'), null);
});

// ---------- isBlankMessage ----------

test('isBlankMessage：有正文/思维链/任意 swipe 文本都算非空', () => {
    assert.equal(isBlankMessage(null), true);
    assert.equal(isBlankMessage({ mes: '   ' }), true);
    assert.equal(isBlankMessage({ mes: '内容' }), false);
    // AI 生成中：正文为空但思维链已有内容，不能被当作空占位跳过（Alt+S 会选错消息）
    assert.equal(isBlankMessage({ mes: '', extra: { reasoning: '思考中' } }), false);
    assert.equal(isBlankMessage({ mes: '', swipes: ['', '备选文本'] }), false);
    assert.equal(isBlankMessage({ mes: '', swipes: ['', '  '] }), true);
});

// ---------- isLegacyFormat ----------

test('isLegacyFormat：旧格式识别（有 messageId 且无 favoritedSwipes）', () => {
    assert.equal(isLegacyFormat([{ id: '1', messageId: '3', note: '' }]), true);
    assert.equal(isLegacyFormat([{ id: '1', messageId: '3', favoritedSwipes: [] }]), false);
    assert.equal(isLegacyFormat([]), false);
    assert.equal(isLegacyFormat(null), false);
});

// ---------- migrateLegacyFavorites ----------

test('migrateLegacyFavorites：注入当前激活 swipe，跳过越界索引，且幂等', () => {
    const messages = [
        { mes: 'a', swipe_id: 1, swipes: ['a0', 'a1'] },
        { mes: 'b', swipe_id: 0 },
    ];
    const legacy = [
        { id: 'fav-1', messageId: '0', note: '旧备注' },
        { id: 'fav-2', messageId: '99', note: '消息已删' },
        { id: 'fav-3', messageId: '1', note: '' },
    ];

    const first = migrateLegacyFavorites(messages, legacy);
    assert.deepEqual(first, { migrated: 2, skipped: 1 });
    // 写入的是当前激活的 swipe（swipe_id=1），不是 0
    assert.equal(messages[0].swipe_info[1].star_favorite.id, 'fav-1');
    assert.equal(messages[0].swipe_info[0], undefined);
    assert.equal(messages[0].swipe_info[1].star_favorite.note, '旧备注');
    assert.equal(messages[1].swipe_info[0].star_favorite.id, 'fav-3');

    // 幂等：再跑一次全部跳过，不覆盖已有收藏
    const second = migrateLegacyFavorites(messages, legacy);
    assert.deepEqual(second, { migrated: 0, skipped: 3 });
    assert.equal(messages[0].swipe_info[1].star_favorite.note, '旧备注');
});

test('migrateLegacyFavorites：非法输入不抛异常', () => {
    assert.deepEqual(migrateLegacyFavorites(null, []), { migrated: 0, skipped: 0 });
    assert.deepEqual(migrateLegacyFavorites([], null), { migrated: 0, skipped: 0 });
    assert.deepEqual(migrateLegacyFavorites([{}], [null, {}]), { migrated: 0, skipped: 2 });
});

test('migrateLegacyFavorites 的结果可被 buildVirtualFavorites 读取（迁移链路闭环）', () => {
    const messages = [{ mes: 'a', swipe_id: 0 }];
    migrateLegacyFavorites(messages, [{ id: 'fav-1', messageId: '0', note: '备注' }]);
    const virtual = buildVirtualFavorites(messages);
    assert.equal(virtual.length, 1);
    assert.equal(virtual[0].id, 'fav-1');
    assert.equal(virtual[0].note, '备注');
});

// ---------- mutateSwipeFavorite ----------

test('mutateSwipeFavorite：更新命中项并返回 true', () => {
    const messages = [makeMessage({ swipes: [{ favorite: { id: 'f1', note: '', create_date: 1 } }] })];
    const ok = mutateSwipeFavorite(messages, 'f1', (fav) => {
        fav.note = '新备注';
        return 'update';
    });
    assert.equal(ok, true);
    assert.equal(messages[0].swipe_info[0].star_favorite.note, '新备注');
});

test('mutateSwipeFavorite：返回 delete 时物理移除收藏（取消收藏链路）', () => {
    const messages = [makeMessage({ swipes: [{ favorite: { id: 'f1', note: '', create_date: 1 } }] })];
    const ok = mutateSwipeFavorite(messages, 'f1', () => 'delete');
    assert.equal(ok, true);
    assert.equal(messages[0].swipe_info[0].star_favorite, undefined);
    // 删除后虚拟收藏应同步为空（否则会出现「删了还显示」）
    assert.deepEqual(buildVirtualFavorites(messages), []);
});

test('mutateSwipeFavorite：未命中返回 false 且不改动数据', () => {
    const messages = [makeMessage({ swipes: [{ favorite: { id: 'f1', note: '原', create_date: 1 } }] })];
    assert.equal(mutateSwipeFavorite(messages, 'other', () => 'delete'), false);
    assert.equal(messages[0].swipe_info[0].star_favorite.note, '原');
    assert.equal(mutateSwipeFavorite(null, 'f1', () => 'delete'), false);
});

// ---------- 收藏补丁（切换聊天后的兜底落库） ----------
//
// 背景：当前聊天的收藏保存有 800ms 防抖，而 ST 切换聊天时会直接丢掉内存里的 chat 数组
// 且不保存。「收藏后立刻切换聊天」曾因此永久丢失收藏，补丁就是为此准备的幂等快照。

test('flattenFavoriteSwipes：按「消息索引:swipe 索引」摊平，容忍空输入', () => {
    const favorites = buildVirtualFavorites([makeMessage({
        swipes: [
            { favorite: { id: 'a', note: '', create_date: 1 } },
            { favorite: { id: 'b', note: '', create_date: 2 } },
        ],
    })]);
    const map = flattenFavoriteSwipes(favorites);
    assert.deepEqual([...map.keys()].sort(), ['0:0', '0:1']);
    assert.equal(map.get('0:1').id, 'b');
    assert.equal(flattenFavoriteSwipes(null).size, 0);
    assert.equal(flattenFavoriteSwipes([]).size, 0);
});

test('buildFavoritePatch：新增写入收藏对象、取消收藏写 null、swipeId 不写回数据', () => {
    const before = buildVirtualFavorites([makeMessage({
        swipes: [{ favorite: { id: 'old', note: '旧', create_date: 1 } }],
    })]);
    const after = buildVirtualFavorites([makeMessage({
        swipes: [{ favorite: { id: 'new', note: '新', create_date: 2, tags: ['x'] } }],
    })]);

    const patch = buildFavoritePatch(before, after);
    assert.deepEqual(patch.get('0:0'), { id: 'new', note: '新', create_date: 2, tags: ['x'] });
    assert.equal('swipeId' in patch.get('0:0'), false);
});

test('buildFavoritePatch：新状态里消失的 swipe 记为删除（null）', () => {
    const before = buildVirtualFavorites([makeMessage({
        swipes: [{ favorite: { id: 'a', note: '', create_date: 1 } }, { favorite: { id: 'b', note: '', create_date: 2 } }],
    })]);
    const after = buildVirtualFavorites([makeMessage({
        swipes: [{ favorite: { id: 'a', note: '', create_date: 1 } }],
    })]);

    const patch = buildFavoritePatch(before, after);
    assert.equal(patch.get('0:0').id, 'a');
    assert.equal(patch.get('0:1'), null, '被取消的 swipe 必须显式删除');
});

test('buildFavoritePatch：note/tags 缺失时补默认值，补丁是幂等完整快照', () => {
    const after = [{ messageId: '2', favoritedSwipes: [{ swipeId: '1', id: 'f1', create_date: 9 }] }];
    const patch = buildFavoritePatch(null, after);
    assert.deepEqual(patch.get('2:1'), { id: 'f1', note: '', create_date: 9 });
    // 同一份新状态再算一次，结果一致（切换聊天后重放不会重复或漂移）
    assert.deepEqual(buildFavoritePatch(after, after), patch);
});

test('applyFavoritePatch：写入/删除只落在指定 swipe 上，并返回生效条数', () => {
    const messages = [
        makeMessage({ swipes: [{ favorite: { id: 'a', note: '', create_date: 1 } }, { favorite: { id: 'b', note: '', create_date: 2 } }] }),
        makeMessage(),
    ];
    const patch = new Map([
        ['0:0', null],                                             // 取消收藏
        ['0:1', { id: 'b', note: '改', create_date: 2 }],           // 覆盖已有收藏
        ['1:0', { id: 'c', note: '', create_date: 3 }],             // 新增收藏
    ]);

    assert.equal(applyFavoritePatch(messages, patch), 3);
    assert.equal(messages[0].swipe_info[0].star_favorite, undefined);
    assert.equal(messages[0].swipe_info[1].star_favorite.note, '改');
    assert.equal(messages[1].swipe_info[0].star_favorite.id, 'c');
    // 重放后虚拟收藏与补丁描述一致
    assert.deepEqual(buildVirtualFavorites(messages).map(f => f.id).sort(), ['b', 'c']);
});

test('applyFavoritePatch：消息索引越界/非法输入一律跳过，绝不写到别的消息上', () => {
    const messages = [makeMessage()];
    const patch = new Map([['99:0', { id: 'x', note: '', create_date: 1 }]]);
    assert.equal(applyFavoritePatch(messages, patch), 0);
    assert.equal(messages[0].swipe_info[0].star_favorite, undefined);
    assert.equal(applyFavoritePatch(null, patch), 0);
    assert.equal(applyFavoritePatch(messages, null), 0);
    assert.equal(applyFavoritePatch(messages, {}), 0);
});
