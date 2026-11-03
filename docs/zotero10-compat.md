# Zotero 7–10 兼容性说明

本插件**不按版本号写死**，而是用 `content/scripts/compat.js` 做能力探测：
有哪个 API 就用哪条路径，缺了就降级，业务代码里没有任何版本判断。

下表是迁移过程中踩到的坑与依据。结论来自本机 **Zotero 10.0.7** 的
`E:\科研工具\论文翻译器与插件\Zotero\app\omni.ja` 真实源码，不是猜的。
换大版本时，按第 3 节清单回归一遍。

## 0.1 两个借鉴自成熟插件的做法

| 问题 | 别人怎么做 | 我们怎么做 |
|---|---|---|
| 模型列表 | Zotero AI Sidebar 内置每个供应商的 `MODEL_CATALOG`，不依赖网络 | 内置 DeepSeek/OpenAI/Claude 目录打底，`GET /models` 成功时增量合并 |
| 常驻入口 | AI Sidebar 往 `#zotero-items-toolbar` 插入 `toolbarbutton`（flex spacer 之前） | 同样插 `#paperloom-toolbar-btn`，点击打开对话页；窗口卸载时移除 |

> 结论：模型下拉框不能只依赖 `GET /models`——不少 OpenAI 兼容服务不实现该接口，或返回的 ID 与对话接口不一致。

## 0. 适配策略

| 层 | 做法 |
|---|---|
| 入口 | 侧栏（`ItemPaneManager`）→ 不可用则菜单打开独立窗口，功能不丢 |
| 全文 | 缓存文件 → `PDFWorker.getFullText` → `Fulltext.getIndexedText`（7–9）→ `indexItems` 后重读缓存 → 摘要 |
| 网络 | `fetch` → `Zotero.HTTP.request` |
| 存储 | `Zotero.DataDirectory.dir` → profile 目录 |
| UI | 统一走 `chrome://paperloom/content/...`（7–10 都支持 `registerChrome`） |
| 版本区间 | `manifest` 里写 `7.0` ~ `10.99.99`，覆盖当前所有在维护的大版本 |

---

## 1. 阻断级问题（不修就完全不可用）

| # | 现象 | 根因（Zotero 10 源码位置） | 修法 |
|---|---|---|---|
| 1 | 安装时提示"与 Zotero 10 不兼容" | `manifest.json` 的 `strict_max_version` 写的是 `8.*` | 改为 `10.99.99`，`strict_min_version` 提到 `7.0` |
| 2 | 插件装上，但条目侧栏什么都没有 | `pluginAPI/itemPaneManager.js` 的 `optionTypeDefinition` 里 `header.icon` / `sidenav.icon` **为必填**；缺字段时 `_validateObject` 抛错、`registerSection` 返回 `false`，只写一行日志 | 两个都补 `icon: "chrome://paperloom/content/icons/paperloom.svg"`，并删掉不存在的 `label` 字段 |
| 3 | 启动即报 `ReferenceError: Zotero is not defined` 或 `fetch is not defined` | `loadSubScript(url, {})` 的目标对象是全新沙箱，**不继承** bootstrap 作用域；而 `fetch/AbortController/setTimeout` 在插件沙箱里不保证存在（`xpcom/plugins.js` 的 scope 构造） | `bootstrap.js` 的 `createDomainScope()` 把 `Zotero/Services/IOUtils/PathUtils` 和从主窗口借来的 `fetch/AbortController/timers` 显式塞进 scope |
| 4 | 面板显示"领域层未加载" | iframe 的 `src` 用了 `rootURI`（`file://`），与父窗口 `chrome://` 不同源，`window.top.Zotero` 直接抛 SecurityError | 所有 UI 一律走 `chrome://paperloom/content/...`；`registerChrome` 已在 startup 里注册过该映射 |
| 5 | 全文永远只有摘要 | Zotero 10 **删除了** `Zotero.Fulltext.getIndexedText()`（`xpcom/fulltext.js` 里已无此方法） | 改走 `Zotero.Fulltext.getItemCacheFile(item)` 读 `.zotero-ft-cache`；失败则 `Zotero.PDFWorker.getFullText(itemID)`；再失败 `Zotero.Fulltext.indexItems()` 后重读缓存 |

---

## 2. 非阻断但会留下脏状态

- `Zotero.PreferencePanes.unregister(id)` 收的是 `register()` **返回的 pane id**，不是 `pluginID`。传错不会报错，但面板不会被移除，重载插件后会残留重复项。
- `Zotero.PreferencePanes.register()` 是 **async**，且 `src` 推荐传**相对插件根目录**的路径（内部会走 `Zotero.Plugins.resolveURI`）；传绝对 `file://` URI 容易被当成外部地址。
- `Zotero_Tabs.add()` 在 10 里签名未变（`{id,type,data,title,index,select,onClose}` → `{id, container}`），但它仍是私有 API，保留独立窗口兜底。
- `item.getBestAttachment()` 仍然存在（`xpcom/data/item.js`），无需改为复数版本。

### 设置面板为什么改成「按钮 + 独立窗口」

原生面板由 `preferences/preferences.js` 用 `parseXULToFragment()` 解析，这意味着：

- `src` 必须是 **XUL fragment**：不能带 `<?xml?>` 声明，不能自己套 `<vbox>` 根节点；
- 面板里的 `<html:input preference="...">` 会把 `elem.value` 原样交给 `Zotero.Prefs.set()`，
  而 `maxTokens` / `timeoutMs` 在 `prefs.js` 里是 **int 型偏好**，写入字符串会直接抛类型错误；
- `scripts` 选项加载的脚本**先于** DOM 插入执行，必须轮询等元素出现。

结论：**不在 fragment 里放任何带 `preference` 属性的控件**，而是整段内嵌
`<html:iframe src="chrome://paperloom/content/settings.xhtml?embed=1">`。

这样：

- 点进 Zotero 设置里的 PaperLoom 就是完整设置，不需要再点一次按钮；
- 设置界面只有一份实现（内嵌与独立窗口共用 `settings.xhtml`）；
- 偏好读写全部走 `settings.js` 里的显式类型转换，不受各版本 `preference` 绑定差异影响；
- 内嵌页面自身 `overflow-y: auto`，内容超出时右侧出滑条，不需要拉伸窗口。

---

## 3. 换大版本时的回归清单

逐条在真机上验证，任何一条失败都先修再继续：

1. 安装 xpi，Zotero 不提示不兼容（版本区间生效）
2. 控制台 `Zotero.debug` 能看到 `领域层就绪，数据目录 …`
3. 选中一篇论文 → 侧栏出现 PaperLoom 区块且不空白
4. 面板里能显示当前论文标题（说明 `postMessage` 通路正常）
5. 设置 → PaperLoom 能看到面板，改 API Key 后重开仍在
6. 菜单 工具 → PaperLoom → 打开知识图谱（自定义 Tab 或独立窗口）
7. 提问一次，能拿到带 `[Pn, p.x]` 的回答并点击跳转
8. 重建图谱，进度窗口能跑完，节点/边数非零

---

## 4. 尚未在真机验证的部分

以下只能靠真机冒烟确认，静态分析覆盖不到：

- SVG 图标在 16×16 / 20×20 位置的显示效果
- `bodyXHTML` 里的 `<html:div>` 在条目面板中的解析结果
- `PDFWorker.getFullText()` 在无 PDF 转换器的机器上是否会卡住（已包 try/catch，但耗时未知）
- React/XUL 侧栏折叠再展开时 iframe 是否被销毁（若被销毁，需要在 `onToggle` 里重建）
