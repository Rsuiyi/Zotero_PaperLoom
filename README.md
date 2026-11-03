# PaperLoom（文脉）

> 会记得你、也会记得你整个文献库的 Zotero 研究助手 —— 第一阶段核心实现

现有 Zotero 插件本质是「把当前论文塞进 prompt，问一句答一句」：无状态、单文档、不主动。
PaperLoom 做的是一个闭环：

```
对话 ──抽取──▶ 记忆 / 图谱
  ▲                  │
  └────注入 / 提示────┘
```

对话和论文是入口，记忆和图谱是它的副产物，也是它下一轮更聪明的燃料。

---

## 本次交付范围

**已实现（第一阶段核心）**

| 模块 | 文件 | 状态 |
|---|---|---|
| 数据契约（唯一来源） | `content/scripts/schema.js` | ✅ |
| 本地 JSON 存储 | `content/scripts/storage.js` | ✅ |
| LLM 统一入口 + 落盘缓存 | `content/scripts/llm.js` | ✅ |
| 全文提取与分块 | `content/scripts/chunker.js` | ✅ |
| BM25 检索 + 意图判定 | `content/scripts/retriever.js` | ✅ |
| 记忆系统（三条写入路径 + 冲突规则） | `content/scripts/memory.js` | ✅ |
| 带证据的图谱 + `applyGraphDelta` | `content/scripts/graphStore.js` | ✅ |
| 对话主流程 | `content/scripts/pipeline.js` | ✅ |
| 论文侧栏对话面板 | `content/chat.*` | ✅ |
| 全库对话面板（与侧栏同构） | `content/chat.xhtml?mode=library` | ✅ |
| 知识图谱总页面 | `content/graph.*` | ✅ |
| 记忆卡片面板 | `content/memory.*` | ✅ |
| 第二阶段接口预留 | `content/scripts/stubs.js` | ✅ 空实现 |

**本次明确未做**：预处理管线、阅读器 tip 气泡（仅留 `TipEngine.evaluate` 接口）、
流式输出、图谱 diff 动画、云同步、多人协作、引文格式转换。

**评测脚手架**（`eval/`）已补齐：24 条四类问题 + 一键评测脚本 + A/B 对照。
详见 [`docs/usage-and-eval.md`](docs/usage-and-eval.md)。

---

## 安装

1. `node build.js` 生成 `paperloom.xpi`（或直接用仓库里已打包好的）。
2. Zotero → 工具 → 插件 → 齿轮 → **Install Plugin From File…** → 选择 `paperloom.xpi`。
3. 重启 Zotero。
4. 设置 → **PaperLoom** → 填入 API Base URL 与 API Key。

开发期也可用源码直装：在 Zotero profile 的 `extensions/` 下建一个名为
`paperloom@hackathon.local` 的文本文件，内容写 `paperloom/` 目录的绝对路径，
然后删掉 `prefs.js` 里的 `extensions.lastAppBuildId` / `extensions.lastAppVersion` 两行再启动。

---

## ⚠ 必踩的坑：`max_tokens` 不能给小

DeepSeek 系推理模型的 **reasoning token 计入 completion**。如果 `max_tokens` 给小了，
模型把额度全花在思考上，返回的 `content` 会是**空字符串**，而 `finish_reason` 是 `length`。

插件已做两道防护：

- `prefs.js` 默认 `max_tokens = 4096`，`llm.js` 里强制 `Math.max(4096, 配置值)`，调小也会被钳制回来；
- 真遇到 `content` 为空且 `finish_reason === "length"` 时，直接抛出带排查提示的错误，不让它伪装成"模型没话说"。

其他已处理的坑：

- `pluginID` 必须与 `manifest.json` 的 `id` **完全一致**，否则 `registerSection` 被静默丢弃，表现为"装了但没反应"。
- 所有 UI 注册放在 `Zotero.uiReadyPromise` 之后；`startup` 整体包 `try/catch` 并 `Zotero.logError`，
  否则异常被吞掉会表现为"重启后插件消失"。
- `onRender` 每次切换条目都会触发，必须纯、快、无副作用 —— 这里只在 `onInit` 建一次 iframe，
  `onRender` 只 `postMessage` 投递 itemKey。
- `Zotero_Tabs.add` 与 `Zotero.Reader.open(id, {pageIndex})` 都是私有 API，
  已各自准备 fallback（独立窗口 / `zotero://open-pdf/library/items/<key>?page=N`）。

---

## 两条硬约束（已在代码与自检中强制）

**1. 没有 `evidence` 的边不许进图谱。**
`schema.validateEdge()` 要求 `evidence` 的 `paperId` 与 `quote` 齐全，
`graphStore.applyGraphDelta()` 把不合格的边丢进 `diff.rejected` 并在 UI 上告知数量。抽取不出来就丢弃，宁缺毋滥。

**2. 答案里每个结论必须挂 citations，且必须能定位到页码。**
`pipeline.ask()` 会把模型给的每条引用与本轮真实证据块比对：
chunk 不在证据里、页码缺失或对不上的，`valid = false`，
在对话面板中渲染为**红色删除线 chip**（`.pl-cite-invalid`），鼠标悬停显示失败原因。不允许静默通过。

---

## 数据与隐私

全部落在本地，不做云同步。默认目录 `<Zotero 数据目录>/paperloom/`：

```
paperloom/
├── graph.json          图谱（nodes + edges，边均带证据）
├── memory.json         记忆事实
├── turns.json          对话回合
├── papers/<key>.json   解析后的 PaperDoc（chunks 带页码）
└── cache/<hash>.json   LLM 结果缓存（按 hash(prompt)）
```

可在设置里改 `数据目录`。关掉 `useCache` 即不落 LLM 缓存。

---

## 使用

- **侧栏对话**：选中论文 → 条目面板里的 **PaperLoom 对话**。输入 `@` 可引用库里其他论文。
- **全库对话 / 图谱 / 记忆**：工具 → PaperLoom → 对应菜单项。
- **重建图谱**：选中若干论文 → 工具 → PaperLoom → **重建所选论文的图谱**。
  走 `JobQueue`，不在 UI 线程跑；进度在右下角进度窗显示。
- **只显示跨论文概念**：图谱页右上角开关，图会立刻收敛成只剩真正连接多篇文献的骨架。
- **记忆改正**：记忆面板里「改正 / 锁定」会把该条标记为 `explicit` 且 `confidence = 1.00`，
  此后不再被对话推断覆盖；被覆盖的旧值都留在卡片的「历史值」里。

每轮回答下方的 **「本次使用了 N 条记忆」** 徽标可点开，列出具体用了哪些事实 ——
记忆是隐形的，这个徽标是整个项目可信度的来源。

---

## 未配置 API Key 时

不会整个面板不可用：`pipeline.ask()` 会降级为**只返回本地 BM25 检索结果**，
引用照样可点击跳转，方便先验证检索与跳转链路（M0 冒烟）。

---

## 自检

```bash
node tests/selfcheck.js        # 领域层 57 项
node tests/eval-selfcheck.js   # 评测集与评分器 37 项
node build.js                  # 重新打包 xpi
```

用内存 stub 替代 `IOUtils` / `Zotero`，覆盖 schema 硬约束、分块、BM25 与多样性约束、
意图判定、记忆冲突规则、图谱 delta 与概念对齐、预留接口、LLM 容错解析、prompt 组装，
以及评测集结构与评分口径，**当前 94 项全部通过**。

## 评测

改 `eval/queries.json` 里的 4 个 paperId，然后在 Zotero 的 Run JavaScript 里跑：

```js
Services.scriptloader.loadSubScript(
  "file:///E:/阅读实践周/Zotero_PaperLoom/eval/run.js", this);
return await runEval({});
```

产出 `eval/results/<时间戳>.md`（可直接贴 PPT）。全程 `dryRun`，不污染真实图谱与记忆。
完整说明见 [`docs/usage-and-eval.md`](docs/usage-and-eval.md)。

---

## 架构分层

```
L3 表现层  chat.js / graph.js / memory.js
L2 领域层  chunker · retriever · memory · graphStore · pipeline · schema
L1 集成层  bootstrap（ItemPane / Tabs / Prefs / 菜单）
L0 外部    LLM API（OpenAI 兼容） · 本地 JSON 文件
```

L2 是**与运行环境无关的纯 JS**（只依赖 `IOUtils`/`PathUtils` 这层薄封装），
这正是为 Plan B 留的退路：若插件路线卡死，改成本地 Web 应用 + Zotero 本地 API
（`http://localhost:23119/api/`）读条目，L2 可整体搬过去，产品叙事不变。

**第二阶段不堵死的四个口子**：
`applyGraphDelta()` 是唯一图变更入口（预处理只是另一个 delta 生产者）、
`llm.complete()` 是唯一 LLM 入口、`TipEngine.evaluate()` 已定义且返回空数组、
`JobQueue` 已可用（支持暂停 / 进度 / 失败重试），第一阶段只用来跑手动重建。
