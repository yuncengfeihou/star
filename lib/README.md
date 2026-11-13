# lib/ — 第三方库说明

本目录存放**运行时使用的第三方库副本**。扩展本身没有构建步骤，浏览器直接加载这些文件，
因此这里必须记录来源与升级方式，否则半年后没人知道本地副本是从哪个版本抄来的。

---

## modern-screenshot.js

| 项 | 值 |
|---|---|
| 用途 | 截图子系统：把 DOM 节点渲染为 Canvas/图片 |
| 上游 | `modern-screenshot`（npm 包，作者 qq15725） |
| 版本 | **4.7.0** |
| 本地文件 | `lib/modern-screenshot.js`（上游 `dist/index.js` 的 UMD 产物，压缩版） |
| 获取方式 | `https://unpkg.com/modern-screenshot@4.7.0/dist/index.js` |
| 备选来源 | 若本地文件加载失败，`ui/screenshot.js` 会回退到同一 CDN 地址 |
| 许可证 | MIT（见上游仓库） |

### 与之绑定的其它文件

- `worker.js`（仓库根目录）：该库的 Web Worker（同样来自 4.7.0 的 dist，压缩版），
  用于并行下载字体/图片资源，避免阻塞主线程。
- `ui/font-subset.js`：接管该库的字体嵌入（关闭 `font: false`），
  依赖其 **`onCreateForeignObjectSvg`** 回调签名注入子集字体 CSS。

> **这三个文件必须同源同版本。** 只升级其中一个会导致截图功能静默失效（字形缺失或图片空白）。

### 升级步骤（属高风险变更）

1. 从上游取得新版本 `dist/index.js` 与对应的 worker 产物，更新 `lib/modern-screenshot.js` 与 `worker.js`。
2. 确认 `ui/screenshot.js` 中的 `CDN_LIB_URL` 版本号同步更新。
3. 检查 `modernScreenshot.domToCanvas` / `domToImage` 等被调用 API 是否仍存在。
4. 检查 `onCreateForeignObjectSvg`、`fetchFn`（图片自定义请求）回调参数是否变化。
5. 验证清单（在真实聊天中执行）：
   - 单条消息截图（含外链图片）
   - 多消息截图拼接
   - 含 HTML 代码块消息的截图
   - 子集化字体（如 BabelStone Han 类字体）是否正常显示
   - 清理字体/图片缓存后首次截图仍正常（设置 → 截图设置 → 缓存管理）

### 关于该库的完整源码

`lib/` 下**只保留运行时需要的 `modern-screenshot.js`**（见上表）。

上游的完整源码树（约 150 个文件、4 MB，含 `.ts` / 示例 / 图标）曾作为开发参考放在
`lib/modern-screenshot-4.7.0/`，已删除——它只用于通读实现细节，运行与升级都不需要；
`.gitignore` 仍保留该路径规则，日后若需要再取一份放在那里也不会污染仓库。

需要查看源码时按版本号取：

```bash
npm pack modern-screenshot@4.7.0 && tar -xzf modern-screenshot-4.7.0.tgz
```
