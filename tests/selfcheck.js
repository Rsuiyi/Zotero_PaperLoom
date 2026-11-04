/* PaperLoom 领域层自检
 * 在 Node 里用内存 stub 替代 IOUtils / Zotero，验证纯逻辑部分。
 * 运行：node tests/selfcheck.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "paperloom", "content", "scripts");

// ---- stub 运行环境
const files = Object.create(null);
const dirs = new Set();

const IOUtils = {
	async makeDirectory(p) { dirs.add(p); },
	async exists(p) { return Object.prototype.hasOwnProperty.call(files, p); },
	async readJSON(p) {
		if (!(p in files)) throw new Error("ENOENT " + p);
		return JSON.parse(files[p]);
	},
	async writeJSON(p, data) { files[p] = JSON.stringify(data); },
	async readUTF8(p) {
		if (!(p in files)) throw new Error("ENOENT " + p);
		return files[p];
	},
	async writeUTF8(p, s) { files[p] = s; },
	async getChildren(p) {
		return Object.keys(files).filter(f => path.dirname(f) === p);
	}
};

const PathUtils = { join: (...a) => path.join(...a) };

// 迷你偏好存储：服务商注册表测试需要读写
const prefStore = new Map();

const Zotero = {
	debug() { },
	DataDirectory: { dir: path.join("/tmp", "zotero-test") },
	Prefs: {
		get(key) { return prefStore.has(key) ? prefStore.get(key) : undefined; },
		set(key, value) { prefStore.set(key, value); }
	}
};

const sandbox = { IOUtils, PathUtils, Zotero, console, fetch: async () => { throw new Error("no network"); },
	AbortController, setTimeout, clearTimeout, Math, Date, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// 与 bootstrap.js 的加载顺序保持一致：compat.js 必须最先
for (const f of ["compat.js", "schema.js", "storage.js", "llm.js", "chunker.js", "retriever.js",
	"memory.js", "graphStore.js", "pipeline.js", "stubs.js"]) {
	vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}

const PL = sandbox.PaperLoom;

// ---- 迷你测试框架
let pass = 0, fail = 0;
function check(name, cond, extra) {
	if (cond) { pass++; console.log("  ✓ " + name); }
	else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function section(t) { console.log("\n" + t); }

(async function run() {

	section("1. schema 硬约束");
	{
		const noEv = PL.Schema.makeEdge({ source: "A", target: "B", type: "supports" });
		check("无 evidence 的边校验失败", PL.Schema.validateEdge(noEv).ok === false);

		const good = PL.Schema.makeEdge({
			source: "A", target: "B", type: "supports",
			evidence: { paperId: "ABCD1234", chunkId: "PABCD1234-c001", page: 3, quote: "原文片段" }
		});
		check("带完整 evidence 的边通过", PL.Schema.validateEdge(good).ok === true,
			JSON.stringify(PL.Schema.validateEdge(good).errors));

		const noQuote = PL.Schema.makeEdge({
			source: "A", target: "B", type: "supports",
			evidence: { paperId: "ABCD1234", page: 3 }
		});
		check("evidence 缺 quote 被拒", PL.Schema.validateEdge(noQuote).ok === false);

		check("引用缺页码被拒", PL.Schema.validateCitation({ paperId: "X" }).ok === false);
		check("引用含页码通过", PL.Schema.validateCitation({ paperId: "X", page: 7 }).ok === true);
		check("自环边被拒", PL.Schema.validateEdge(PL.Schema.makeEdge({
			source: "A", target: "A", type: "relates",
			evidence: { paperId: "P", chunkId: "c", page: 1, quote: "q" }
		})).ok === false);
	}

	section("2. 分块：400~800 字符 + 页码保留");
	{
		const para = "This is a sentence about retrieval augmented generation and knowledge graphs. ";
		const pages = [
			{ page: 1, text: "1 Introduction\n" + para.repeat(30) },
			{ page: 2, text: "3 Method\n" + para.repeat(30) },
			{ page: 7, text: "4 Results\n" + para.repeat(20) }
		];
		const chunks = PL.Chunker.chunkPages("ABCD1234", pages);
		check("产生了多个 chunk", chunks.length >= 5, "实际 " + chunks.length);
		const oversize = chunks.filter(c => c.text.length > 1000);
		check("无超长 chunk", oversize.length === 0, oversize.length + " 个超长");
		check("页码被保留（含第 7 页）", chunks.some(c => c.page === 7));
		check("section 被识别为 method", chunks.some(c => c.section === "method"));
		check("section 被识别为 result", chunks.some(c => c.section === "result"));
		check("chunkId 格式正确", /^PABCD1234-c\d{3}$/.test(chunks[0].chunkId), chunks[0].chunkId);
	}

	section("3. BM25 检索 + 论文多样性约束");
	{
		const mk = (pid, i, text, page) => PL.Schema.makeChunk({
			chunkId: PL.Schema.chunkId(pid, i), paperId: pid, page: page || 1, section: "other", text
		});
		const corpus = [
			mk("PAPER001", 0, "Transformer attention mechanism scales quadratically with sequence length.", 2),
			mk("PAPER001", 1, "We propose a sparse attention variant reducing memory cost.", 3),
			mk("PAPER001", 2, "Sparse attention achieves linear complexity in our experiments.", 4),
			mk("PAPER002", 0, "Attention mechanism in recurrent networks differs from transformer attention.", 1),
			mk("PAPER002", 1, "We argue sparse attention degrades long range dependency modeling.", 5),
			mk("PAPER003", 0, "Graph neural networks aggregate neighbor features via message passing.", 1)
		];
		const index = PL.Retriever.buildIndex(corpus);
		const hits = PL.Retriever.search(index, "sparse attention complexity", { topK: 4 });
		check("检索命中结果", hits.length > 0, "命中 " + hits.length);
		check("最相关的是 sparse attention 块", /sparse attention/i.test(hits[0].chunk.text), hits[0].chunk.text);

		const diverse = PL.Retriever.search(index, "attention mechanism", { topK: 4, perPaperLimit: 1 });
		const papers = new Set(diverse.slice(0, 2).map(h => h.chunk.paperId));
		check("多样性约束生效：前 2 条来自不同论文", papers.size === 2, Array.from(papers).join(","));

		check("中文可分词", PL.Retriever.tokenize("稀疏注意力机制的计算复杂度").length > 0);
	}

	section("4. 意图判定");
	{
		const c = (q, ctx) => PL.Retriever.classifyIntent(q, ctx);
		check("跨篇比较", c("这两篇在稀疏注意力上到底谁对？") === "cross_paper");
		check("跨篇（英文 compare）", c("compare the two methods") === "cross_paper");
		check("跨篇（@ 多篇触发）", c("它们的结论一致吗", { referencedPaperCount: 2 }) === "cross_paper");
		check("概念解释", c("什么是稀疏注意力？") === "concept");
		check("元问题", c("你记得我什么偏好？") === "meta");
		check("单篇事实", c("这篇论文用的数据集规模是多少") === "single_fact");
	}

	section("5. 记忆：冲突与纠错规则");
	{
		let r = await PL.Memory.upsert({
			key: "style.length", value: "short", confidence: 0.6, origin: "inferred",
			evidence: [{ type: "inferred", text: "用户说讲简单点" }]
		});
		check("首次写入 created", r.action === "created", r.action);

		r = await PL.Memory.upsert({
			key: "style.length", value: "long", confidence: 0.7, origin: "inferred",
			evidence: [{ type: "inferred", text: "用户要求详细" }]
		});
		check("新证据覆盖旧值", r.action === "updated" && r.fact.value === "long", r.action + "/" + r.fact.value);
		check("旧值进入 history", r.fact.history.length === 1 && r.fact.history[0].value === "short");

		r = await PL.Memory.setExplicit("style.length", "short", "用户面板改正");
		check("手动编辑锁定 confidence=1.0", r.fact.confidence === 1 && r.fact.origin === "explicit");

		r = await PL.Memory.upsert({
			key: "style.length", value: "long", confidence: 0.95, origin: "inferred",
			evidence: [{ type: "inferred", text: "又推断成 long" }]
		});
		check("★ explicit 记忆不被推断覆盖", r.action === "rejected-locked" && r.fact.value === "short",
			r.action + "/" + r.fact.value);

		r = await PL.Memory.upsert({ key: "", value: "x" });
		check("非法事实被拒", r.action === "rejected-invalid");

		await PL.Memory.upsert({
			key: "familiarity.PAPER004", value: "unread", confidence: 0.7, origin: "inferred",
			evidence: [{ type: "explicit", text: "这篇我没读过" }]
		});
		const got = await PL.Memory.retrieve("讲讲这篇的方法", { paperId: "PAPER004" });
		check("读取路径命中当前论文熟悉度", got.some(f => f.key === "familiarity.PAPER004"),
			got.map(f => f.key).join(","));
		check("偏好类记忆总被带上", got.some(f => f.key === "style.length"));
		check("top-k 不超过 6", got.length <= 6, "实际 " + got.length);

		const tokens = got.reduce((s, f) => s + PL.Memory.approxTokens(PL.Memory.renderFactLine(f)), 0);
		check("记忆 token 预算 ≤ 400", tokens <= 400, "实际约 " + tokens);
		check("<memory> 区块可渲染", PL.Memory.renderBlock(got).startsWith("<memory>"));

		const del = await PL.Memory.remove(got[0].factId);
		check("可删除记忆", del === true);
	}

	section("6. 图谱：applyGraphDelta 与跨论文概念");
	{
		await PL.GraphStore.clear();

		const diff1 = await PL.GraphStore.applyGraphDelta({
			nodes: [
				{ type: "paper", paperId: "PAPER001", label: "Sparse Attention 论文" },
				{ type: "concept", label: "Sparse Attention", paperIds: ["PAPER001"] },
				{ type: "concept", label: "Quadratic Complexity", paperIds: ["PAPER001"] }
			],
			edges: [
				{
					sourceLabel: "Sparse Attention", targetLabel: "Quadratic Complexity",
					type: "relates", label: "用于缓解", confidence: 0.8,
					evidence: { paperId: "PAPER001", chunkId: "PPAPER001-c001", page: 3, quote: "sparse attention reduces quadratic cost" }
				},
				{
					// ★ 这条没有 evidence，必须被丢弃
					sourceLabel: "Sparse Attention", targetLabel: "Quadratic Complexity",
					type: "supports", confidence: 0.9
				}
			]
		});
		check("节点写入成功", diff1.addedNodes.length === 3, "实际 " + diff1.addedNodes.length);
		check("带证据的边写入成功", diff1.addedEdges.length === 1, "实际 " + diff1.addedEdges.length);
		check("★ 无证据的边被丢弃", diff1.rejected.length === 1, JSON.stringify(diff1.rejected));

		// 第二篇论文复用同一概念（大小写 + 连字符不同）
		const diff2 = await PL.GraphStore.applyGraphDelta({
			nodes: [
				{ type: "paper", paperId: "PAPER002", label: "反方论文" },
				{ type: "concept", label: "sparse-attention", paperIds: ["PAPER002"] }
			],
			edges: [{
				sourceLabel: "sparse-attention", targetLabel: "Quadratic Complexity",
				type: "contradicts", label: "认为无效", confidence: 0.7,
				evidence: { paperId: "PAPER002", chunkId: "PPAPER002-c001", page: 5, quote: "sparse attention degrades modeling" }
			}]
		});
		const newConcepts = diff2.addedNodes.filter(n => n.type === "concept");
		check("★ 概念对齐：同义写法未新建节点", newConcepts.length === 0,
			newConcepts.map(n => n.label).join(","));

		const stats = await PL.GraphStore.stats();
		check("跨论文概念被识别", stats.crossPaperConcepts >= 1, "实际 " + stats.crossPaperConcepts);
		check("论文节点数正确", stats.papers === 2, "实际 " + stats.papers);

		const g = await PL.GraphStore.load();
		check("所有入图的边都带 evidence", g.edges.every(e => e.evidence && e.evidence.quote));

		const saId = PL.Schema.conceptNodeId("Sparse Attention");
		const nb = await PL.GraphStore.neighbors([saId], 1);
		check("邻居查询可用", nb.nodes.length >= 2 && nb.edges.length >= 1,
			nb.nodes.length + " 节点 / " + nb.edges.length + " 边");

		const found = await PL.GraphStore.findConceptsByQuery("sparse attention 的复杂度");
		check("按 query 找到概念节点", found.length >= 1, found.map(n => n.label).join(","));
	}

	section("7. 预留接口（第二阶段不堵死）");
	{
		check("TipEngine.evaluate 返回空数组", (await PL.TipEngine.evaluate({})).length === 0);
		check("JobQueue 有完整接口",
			typeof PL.JobQueue.enqueue === "function"
			&& typeof PL.JobQueue.pause === "function"
			&& typeof PL.JobQueue.resume === "function"
			&& typeof PL.JobQueue.status === "function");

		let ran = false;
		await new Promise((resolve) => {
			PL.JobQueue.enqueue({
				label: "test", run: async (report) => { report({ p: 50 }); ran = true; resolve(); }
			});
		});
		check("JobQueue 能跑任务", ran === true);
	}

	section("8. LLM 层");
	{
		check("未配置服务商时 isConfigured=false", PL.LLM.isConfigured() === false);
		check("max_tokens 下限被钳制到 4096", PL.LLM.config().maxTokens >= 4096,
			String(PL.LLM.config().maxTokens));
		check("容错解析 ```json 包裹", PL.LLM.parseJSON('```json\n{"a":1}\n```').a === 1);
		check("容错解析前后带废话", PL.LLM.parseJSON('好的：{"a":2} 以上').a === 2);

		// 没有选模型时应该明确报 NO_MODEL，而不是发一个空请求
		try {
			await PL.LLM.complete({ messages: [] });
			check("未选模型时抛 NO_MODEL", false);
		}
		catch (e) {
			check("未选模型时抛 NO_MODEL", e.code === "NO_MODEL", e.message);
		}

		// 选了模型但服务商没填 Key → NO_API_KEY
		PL.LLM.saveProviders([{ id: "p_test", name: "测试站", baseURL: "https://example.com/v1", apiKey: "", models: ["m1"] }]);
		Zotero.Prefs.set("extensions.paperloom.chatModelRef", "p_test|m1");
		try {
			await PL.LLM.complete({ messages: [] });
			check("服务商无 Key 时抛 NO_API_KEY", false);
		}
		catch (e) {
			check("服务商无 Key 时抛 NO_API_KEY", e.code === "NO_API_KEY", e.message);
		}
	}

	section("9. pipeline 组装");
	{
		const msgs = PL.Pipeline.buildMessages({
			query: "这两篇谁对？", intent: "cross_paper",
			memoryFacts: [PL.Schema.makeMemoryFact({ key: "style.length", value: "short", confidence: 1, origin: "explicit" })],
			titles: { PAPER001: "甲论文", PAPER002: "乙论文" },
			currentHits: [{ chunk: PL.Schema.makeChunk({ chunkId: "PPAPER001-c001", paperId: "PAPER001", page: 3, section: "result", text: "甲的结论" }) }],
			libraryHits: [{ chunk: PL.Schema.makeChunk({ chunkId: "PPAPER002-c001", paperId: "PAPER002", page: 5, section: "result", text: "乙的结论" }) }],
			graphContext: { nodes: [], edges: [] },
			currentPaperId: "PAPER001", currentPaperTitle: "甲论文"
		});
		const user = msgs[1].content;
		check("prompt 含 <memory> 区块", user.includes("<memory>"));
		check("prompt 含 PID/PAGE 标记", user.includes("PID:PAPER001") && user.includes("PAGE:3"));
		check("prompt 按来源分组", user.includes("当前论文") && user.includes("库内其他论文"));
		check("system 要求 JSON 输出", msgs[0].content.includes("citations") && msgs[0].content.includes("graph_delta"));
		check("system 写明跨篇不硬凑", msgs[0].content.includes("只有一篇相关文献"));

		// 多轮：历史问答必须作为真实消息进入 messages
		const withHistory = PL.Pipeline.buildMessages({
			query: "再具体说说方法", intent: "single_fact", memoryFacts: [], titles: {},
			currentHits: [], libraryHits: [], graphContext: {}, existingNodes: [],
			history: [{ query: "这篇讲了什么", answer: "它提出了 AdaGReS" }]
		});
		check("★ 历史问答进入 messages",
			withHistory.some(m => m.role === "assistant" && m.content.includes("AdaGReS")),
			JSON.stringify(withHistory.map(m => m.role)));

		const delta = PL.Pipeline.normalizeGraphDelta(
			{ nodes: [{ type: "concept", label: "注意力" }], edges: [{ sourceLabel: "a", targetLabel: "b", type: "relates" }] },
			{ focusDocs: [{ paperId: "PAPER001", title: "甲论文" }], titles: {} }
		);
		check("normalizeGraphDelta 自动补论文节点", delta.nodes.some(n => n.type === "paper"));
	}

	section("10. review 修补项");
	{
		// 修补 1：对话主流程也要把已有节点表喂给模型（跨论文连接形成的关键）
		const msgs = PL.Pipeline.buildMessages({
			query: "q", intent: "single_fact", memoryFacts: [], titles: {},
			currentHits: [], libraryHits: [], graphContext: { nodes: [], edges: [] },
			existingNodes: [
				PL.Schema.makeNode({ type: "concept", label: "Sparse Attention", paperIds: ["P1"] })
			],
			currentPaperId: "P1", currentPaperTitle: "甲"
		});
		const u = msgs[1].content;
		check("ask 的 prompt 含已有概念节点表", u.includes("已有概念节点"), u.slice(0, 120));
		check("节点表带 nodeId 供复用", /C-[0-9a-f]{8}/.test(u));
		check("契约要求优先复用 nodeId", msgs[0].content.includes("优先复用"));
		check("契约约束概念总数 ≤15", msgs[0].content.includes("15"));

		// 修补 2：normalizeGraphDelta 保留 nodeId 与 origin
		const d = PL.Pipeline.normalizeGraphDelta({
			nodes: [{ type: "concept", nodeId: "C-deadbeef", label: "X" }],
			edges: [{ source: "C-deadbeef", target: "C-00000000", type: "co_asked", origin: "interaction" }]
		}, { focusDocs: [], titles: {} });
		check("保留模型回传的 nodeId", d.nodes[0].nodeId === "C-deadbeef");
		check("保留 origin=interaction", d.edges[0].origin === "interaction");

		// 修补 3：applyGraphDelta 能按 nodeId 复用已有概念
		await PL.GraphStore.clear();
		await PL.GraphStore.applyGraphDelta({
			nodes: [{ type: "concept", label: "Retrieval Augmentation", paperIds: ["P1"] }],
			edges: []
		});
		const existingId = PL.Schema.conceptNodeId("Retrieval Augmentation");
		const reuse = await PL.GraphStore.applyGraphDelta({
			// 标签完全不同，只给 nodeId —— 只有按 nodeId 复用才不会新建
			nodes: [{ type: "concept", nodeId: existingId, label: "完全不同的写法", paperIds: ["P2"] }],
			edges: []
		});
		check("★ 按 nodeId 复用已有概念，不新建节点",
			reuse.addedNodes.filter(n => n.type === "concept").length === 0,
			reuse.addedNodes.map(n => n.label).join(","));
		const g2 = await PL.GraphStore.load();
		const reused = g2.nodes.find(n => n.nodeId === existingId);
		check("复用后论文归属累加", reused && reused.paperIds.length === 2,
			reused ? reused.paperIds.join(",") : "null");

		// 修补 4：co_asked 边可被接受（origin=interaction + 带证据）
		await PL.GraphStore.clear();
		const co = await PL.GraphStore.applyGraphDelta({
			nodes: [
				{ type: "paper", paperId: "P1", label: "甲" },
				{ type: "paper", paperId: "P2", label: "乙" }
			],
			edges: [{
				source: PL.Schema.paperNodeId("P1"), target: PL.Schema.paperNodeId("P2"),
				type: "co_asked", label: "同一问题下被一起引用",
				confidence: 0.5, origin: "interaction",
				evidence: { paperId: "P1", chunkId: "PP1-c001", page: 2, quote: "用户提问：这两篇谁对" }
			}]
		});
		check("★ co_asked 交互边可入图", co.addedEdges.length === 1, JSON.stringify(co.rejected));
		check("co_asked 边 origin 落为 interaction",
			co.addedEdges[0] && co.addedEdges[0].origin === "interaction",
			co.addedEdges[0] && co.addedEdges[0].origin);

		// 修补 5：行为写入路径可用
		// 注意：第 5 节已把 style.length 锁为 explicit，这里用未锁定的 tip.threshold 验证
		const beh = await PL.Memory.recordBehavior({ type: "tip.ignored", turnId: "t1" });
		check("★ 行为记忆写入路径可用", beh.fact && beh.fact.key === "tip.threshold",
			JSON.stringify(beh));
		const behEv = beh.fact.evidence.some(e => e.type === "behavior");
		check("行为记忆带 behavior 类证据", behEv, JSON.stringify(beh.fact.evidence));

		// 行为信号撞上已锁定的 explicit 记忆时必须被拒（锁定规则优先于行为路径）
		const blocked = await PL.Memory.recordBehavior({ type: "asked.definition", turnId: "t2" });
		check("★ 行为写入不能覆盖已锁定的 explicit 记忆",
			blocked.action === "rejected-locked", blocked.action);

		const ignored = await PL.Memory.recordBehavior({ type: "unknown.signal" });
		check("未知行为信号被忽略", ignored.action === "ignored");
	}

	section("11. compat 能力探测（7/8/9/10 差异收口点）");
	{
		const c = PL.Compat.caps();
		check("能取到数据目录（DataDirectory.dir）", c.dataDir === true, JSON.stringify(c));
		check("缺失的 API 被如实报告为 false",
			c.itemPaneSections === false && c.preferencePanes === false, JSON.stringify(c));
		check("dataDir() 解析出目录", typeof PL.Compat.dataDir() === "string" && PL.Compat.dataDir().length > 0,
			PL.Compat.dataDir());

		// sectionOptions 必须自动补齐 header/sidenav 的 icon（7.1+/10 的必填项）
		const opts = PL.Compat.sectionOptions({
			paneID: "x",
			header: { l10nID: "h" },
			sidenav: { l10nID: "s" }
		}, "chrome://paperloom/content/icons/paperloom.svg");
		check("★ sectionOptions 自动补 header.icon", !!opts.header.icon, JSON.stringify(opts.header));
		check("★ sectionOptions 自动补 sidenav.icon", !!opts.sidenav.icon, JSON.stringify(opts.sidenav));
		check("sectionOptions 不丢原有字段", opts.header.l10nID === "h" && opts.paneID === "x");

		check("describe() 输出缺失能力清单", typeof PL.Compat.describe() === "string",
			PL.Compat.describe());
	}

	section("12. 服务商注册表（模型只来自接口，不编造）");
	{
		const providers = PL.LLM.getProviders();
		check("能读回已保存的服务商", providers.length === 1 && providers[0].id === "p_test",
			JSON.stringify(providers));

		const ref = PL.LLM.makeRef("p_test", "m1");
		check("makeRef/parseRef 往返一致", PL.LLM.parseRef(ref).providerId === "p_test"
			&& PL.LLM.parseRef(ref).model === "m1", ref);

		const target = PL.LLM.resolveRef(ref);
		check("★ 引用能解析出服务商的 baseURL 与模型",
			!!target && target.baseURL === "https://example.com/v1" && target.model === "m1",
			JSON.stringify(target));

		check("未知服务商的引用解析为 null", PL.LLM.resolveRef("nope|m1") === null);
		check("没有内置模型目录（不再凭空出现模型）",
			typeof PL.LLM.modelSuggestions === "undefined");

		// 响应解析：OpenAI / 纯数组 / result 包装 / Gemini 的 models/ 前缀
		check("解析 data 数组", PL.LLM.extractModelIds({ data: [{ id: "a" }, { id: "b" }] }).join(",") === "a,b");
		check("解析纯数组", PL.LLM.extractModelIds(["c", "d"]).join(",") === "c,d");
		check("解析 result.data", PL.LLM.extractModelIds({ result: { data: [{ id: "e" }] } }).join(",") === "e");
		check("去掉 models/ 前缀", PL.LLM.extractModelIds({ data: [{ id: "models/f" }] }).join(",") === "f");

		// 端点候选：带 /v1 的 base 要额外尝试去掉 /v1 的写法
		const urls = PL.LLM.modelURLs("https://api.example.com/v1");
		check("★ 模型端点同时尝试带/不带 /v1",
			urls.includes("https://api.example.com/v1/models")
			&& urls.includes("https://api.example.com/models"), JSON.stringify(urls));
	}

	section("13. 图谱手动编辑");
	{
		await PL.GraphStore.upsertNode({ type: "concept", label: "测试概念" });
		let g = await PL.GraphStore.load();
		const node = g.nodes.find(n => n.label === "测试概念");
		check("新增概念成功", !!node, JSON.stringify(g.nodes));

		const renamed = await PL.GraphStore.renameNode(node.nodeId, "改名后概念");
		g = await PL.GraphStore.load();
		check("★ 重命名同步更新 nodeId", !!renamed && g.nodes.some(n => n.label === "改名后概念"),
			JSON.stringify(g.nodes));

		await PL.GraphStore.removeNode(renamed.nodeId);
		g = await PL.GraphStore.load();
		check("删除节点生效", !g.nodes.some(n => n.label === "改名后概念"));

		// 批量删除（框选后用）
		await PL.GraphStore.upsertNode({ type: "concept", label: "批量甲" });
		await PL.GraphStore.upsertNode({ type: "concept", label: "批量乙" });
		g = await PL.GraphStore.load();
		const batch = g.nodes.filter(n => /^批量[甲乙]$/.test(n.label)).map(n => n.nodeId);
		await PL.GraphStore.removeNodes(batch);
		g = await PL.GraphStore.load();
		check("★ 批量删除节点生效", !g.nodes.some(n => /^批量[甲乙]$/.test(n.label)));
	}

	section("14. 用量统计与系统提示词");
	{
		const u1 = PL.LLM.extractUsage({
			usage: {
				prompt_tokens: 1000, completion_tokens: 120, total_tokens: 1120,
				prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200
			}
		});
		check("★ 解析 DeepSeek 缓存命中字段",
			u1 && u1.input === 1000 && u1.output === 120 && u1.cached === 800,
			JSON.stringify(u1));

		const u2 = PL.LLM.extractUsage({
			usage: { input_tokens: 500, output_tokens: 60, input_tokens_details: { cached_tokens: 400 } }
		});
		check("解析 Anthropic 风格 usage",
			u2 && u2.input === 500 && u2.output === 60 && u2.cached === 400,
			JSON.stringify(u2));

		check("无 usage 时返回 null", PL.LLM.extractUsage({}) === null);

		// 自定义系统提示词必须出现在 system 消息里
		Zotero.Prefs.set("extensions.paperloom.systemPrompt", "回答用中文，先给结论");
		const msgs = PL.Pipeline.buildMessages({
			query: "这篇讲了什么", intent: "single_fact", memoryFacts: [],
			titles: {}, currentHits: [], libraryHits: [], graphContext: {}, existingNodes: []
		});
		check("★ 自定义系统提示词注入 system 消息",
			msgs[0].role === "system" && msgs[0].content.includes("回答用中文，先给结论"),
			msgs[0].content.slice(-80));
		Zotero.Prefs.set("extensions.paperloom.systemPrompt", "");
	}

	section("15. 推理强度参数与请求体");
	{
		PL.LLM.saveProviders([{ id: "p_eff", name: "测试", baseURL: "https://example.com/v1", apiKey: "sk-x", models: ["m"] }]);
		Zotero.Prefs.set("extensions.paperloom.chatModelRef", "p_eff|m");
		Zotero.Prefs.set("extensions.paperloom.useCache", false);
		Zotero.Prefs.set("extensions.paperloom.reasoningEffort", "high");

		let captured = null;
		sandbox.fetch = async (url, init) => {
			captured = JSON.parse(init.body);
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({
					choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
				})
			};
		};

		const content = await PL.LLM.complete({ messages: [{ role: "user", content: "hi" }] });
		check("请求体带上 reasoning_effort", captured && captured.reasoning_effort === "high",
			JSON.stringify(captured));
		check("请求成功后记录 usage", PL.LLM.lastUsage() && PL.LLM.lastUsage().input === 10,
			JSON.stringify(PL.LLM.lastUsage()));
		check("正常返回 content", content === "ok");

		Zotero.Prefs.set("extensions.paperloom.reasoningEffort", "");

		// DeepSeek 推理模型必须同时带 thinking，否则 effort 不生效
		const deep = PL.LLM.reasoningParam("high", "deepseek-v4-pro");
		check("★ DeepSeek 同时发送 thinking",
			deep.thinking && deep.thinking.type === "enabled" && deep.reasoning_effort === "high",
			JSON.stringify(deep));

		const other = PL.LLM.reasoningParam("high", "gpt-5.5");
		check("非 DeepSeek 只发 reasoning_effort",
			other.reasoning_effort === "high" && !other.thinking, JSON.stringify(other));

		check("自动时不发送任何 reasoning 参数",
			Object.keys(PL.LLM.reasoningParam("", "deepseek-v4-pro")).length === 0);

		// 服务商拒绝该参数（400）时要自动去掉并重试，不能把对话搞挂
		Zotero.Prefs.set("extensions.paperloom.reasoningEffort", "high");
		const calls = [];
		sandbox.fetch = async (url, init) => {
			const body = JSON.parse(init.body);
			calls.push(body);
			if (calls.length === 1) {
				return { ok: false, status: 400, text: async () => "reasoning_effort unsupported" };
			}
			return {
				ok: true,
				status: 200,
				text: async () => JSON.stringify({
					choices: [{ message: { content: "ok" } }],
					usage: { prompt_tokens: 1, completion_tokens: 1 }
				})
			};
		};

		const retried = await PL.LLM.complete({ messages: [{ role: "user", content: "hi" }] });
		check("★ 400 时自动去掉 reasoning 参数重试",
			calls.length === 2 && !("reasoning_effort" in calls[1]) && retried === "ok",
			JSON.stringify(calls.map(c => Object.keys(c))));
		check("降级会给出提示", typeof PL.LLM.lastWarning() === "string" && PL.LLM.lastWarning().length > 0,
			PL.LLM.lastWarning());

		Zotero.Prefs.set("extensions.paperloom.reasoningEffort", "");
	}

	console.log("\n" + "=".repeat(50));
	console.log("通过 " + pass + " 项，失败 " + fail + " 项");
	console.log("=".repeat(50));
	process.exit(fail ? 1 : 0);
})().catch((e) => {
	console.error("自检脚本异常：", e);
	process.exit(1);
});
