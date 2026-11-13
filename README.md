# 聊天收藏器 (Star)

SillyTavern 扩展：收藏你喜欢的聊天消息，随时回看、检索、整理。

- **版本**：见 `manifest.json`（唯一事实来源）
- **适用**：SillyTavern（第三方扩展）

## 功能概览

| 功能 | 说明 |
|---|---|
| 收藏消息 | 消息旁的星标图标一键收藏；同一条消息的不同 swipe 可分别收藏 |
| 收藏面板 | 搜索（正文与备注，命中词高亮）、标签筛选、分页、按聊天切换 |
| 备注与标签 | 长按星标或卡片按钮编辑备注；标签用于分类筛选 |
| 查看上下文 | 在主聊天界面临时预览该消息前后若干条对话（条数可配置） |
| 跨角色浏览 | 在收藏面板内切换查看其他角色/群组的收藏 |
| 截图 | 单条/多条消息截图，支持长消息完整截取（含 HTML 代码块、思维链） |
| AI 答疑 | 内置「Star 小助手」，可配置任意 OpenAI 兼容 API 解答使用问题 |
| 快捷键 | `Alt+S` 收藏/取消最后一条消息，`Alt+F` 开关收藏面板，`Esc` 逐层关闭 |
| 数据迁移 | 自动检测并把旧版（存在 `chat_metadata`）的收藏迁移到消息自身 |

## 安装

1. 将本目录放到 SillyTavern 的 `public/scripts/extensions/third-party/star/`。
2. 在 SillyTavern 的「扩展」面板中启用「聊天收藏器」。
3. 刷新页面。入口在聊天输入框上方的魔法棒（扩展菜单）里，以及页面右侧的悬浮按钮。

## 开发

扩展**无需构建**：浏览器直接加载 `index.js`（ESM）。修改 JS/CSS 后刷新页面即可生效。
但为了不在「刷新看一眼」上浪费时间，仓库提供了一套零构建的检查工具：

```bash
npm install        # 仅安装 ESLint（开发期依赖）

npm run check      # 全量语法检查 + 版本号一致性校验
npm run lint       # ESLint（宿主全局已声明，重点拦 no-undef / no-unused-vars）
npm test           # 纯函数单元测试（node --test）
npm run css:scope  # 样式作用域自动修复（给遗留通用类名加容器前缀）
npm run css:scope:check  # 样式作用域自查（未加容器前缀时以非零退出）
npm run verify     # 上面全部跑一遍
```

CI 或提交前建议至少跑 `npm run verify`。

### 版本号一致性

`manifest.json` 的 `version` 是唯一事实来源；运行时由 `index.js` 读取它覆盖 `state.js` 里的兜底值。
`npm run check` 会校验 `state.js` 兜底值、`update.html`、`CHANGELOG.md` 与之是否一致，发版前务必通过。

### 第三方库

`lib/` 下的 `modern-screenshot.js` 与根目录的 `worker.js` 是同一版本的第三方产物，
升级方式与验证清单见 [`lib/README.md`](lib/README.md)。

## 数据存放位置

收藏**直接写入消息自身的 `swipe_info[swipeId].star_favorite`**（而非聊天元数据）：

```jsonc
{
  "id": "uuid",
  "note": "备注文本",
  "tags": ["标签A", "标签B"],
  "create_date": 1730000000000
}
```

好处是 SillyTavern 删除 swipe/消息时收藏会一并清理，不会留下悬空记录。
聊天元数据里只额外保存 `favorites_count`（供列表快速筛选）、`favorites_updated_at`（缓存增量刷新信号）与 `favorites_index_version`（索引格式版本，读取侧据此判断计数是否可信）。

## 已知边界

- 收藏面板会读取聊天文件来展示正文，超大聊天（>25MB）首次加载较慢；面板二次打开有增量缓存，接近秒开。
- 截图依赖外链图片可访问；跨域失败时该图片会渲染为占位图。
- AI 答疑的 API 地址与密钥保存在本机 SillyTavern 的服务器端设置文件中（明文），请勿在共享实例中使用。

## 许可

尚未指定开源许可证。若要在 SillyTavern 扩展源发布，请先补充 `LICENSE`。
