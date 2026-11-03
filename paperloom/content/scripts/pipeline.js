/* PaperLoom — pipeline.js
 * L2 领域层：对话主流程 = 闭环的中枢。
 *
 * query
 *   → 意图判定
 *   → 并行检索（当前论文 chunks / 全库 chunks / 图谱邻居 / 记忆事实）
 *   → prompt 组装（证据按来源分组，带 PID/PAGE 标记）
 *   → LLM（JSON：answer + citations + graph_delta + memory_delta）
 *   → 校验引用 → 异步落盘图谱/记忆增量
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Pipeline = (function () {
	const S = PaperLoom.Schema;
	const TURNS_FILE = "turns.json";

	// -------------------------------------------------------------- 论文解析

	async function ensurePaperDocs(items, opts) {
		const docs = [];
		for (const item of items) {
			try {
				docs.push(await PaperLoom.Chunker.buildPaperDoc(item, opts));
			}
			catch (e) {
				try { Zotero.debug("[PaperLoom] 解析失败 " + item.key + ": " + e); } catch (e2) { /* ignore */ }
			}
		}
		return docs;
	}

	/** 全库检索的语料：已解析过的论文（不触发全库重新解析，避免卡 UI） */
	async function libraryChunks(excludePaperId) {
		const docs = await PaperLoom.Storage.listPaperDocs();
		const chunks = [];
		const titles = Object.create(null);
		for (const doc of docs) {
			titles[doc.paperId] = doc.title;
			if (excludePaperId && doc.paperId === excludePaperId) continue;
			for (const c of doc.chunks || []) chunks.push(c);
		}
		return { chunks, titles };
	}

	// -------------------------------------------------------------- prompt

	function renderEvidenceGroup(title, hits, titles) {
		if (!hits.length) return "";
		const lines = hits.map((h) => {
			const c = h.chunk;
			const paperTitle = (titles && titles[c.paperId]) || c.paperId;
			return "[PID:" + c.paperId + " PAGE:" + c.page + " CHUNK:" + c.chunkId + " SECTION:" + c.section + "]"
				+ "《" + String(paperTitle).slice(0, 80) + "》\n" + c.text.trim();
		});
		return "## " + title + "\n" + lines.join("\n\n");
	}

	function renderGraphContext(graphCtx) {
		if (!graphCtx || !graphCtx.edges || !graphCtx.edges.length) return "";
		const nodeLabel = Object.create(null);
		for (const n of graphCtx.nodes || []) nodeLabel[n.nodeId] = n.label;
		const lines = graphCtx.edges.slice(0, 12).map((e) => {
			const ev = e.evidence || {};
			return "- (" + (nodeLabel[e.source] || e.source) + ") --" + e.type
				+ (e.label ? "[" + e.label + "]" : "") + "--> (" + (nodeLabel[e.target] || e.target) + ")"
				+ " | 证据 PID:" + ev.paperId + " PAGE:" + ev.page + " \"" + String(ev.quote || "").slice(0, 120) + "\"";
		});
		return "## 已有知识图谱中的相关关系（均带证据）\n" + lines.join("\n");
	}

	/** 已有概念节点表 —— 喂给模型要求优先复用，跨论文连接就是在这里形成的 */
	function renderExistingNodes(nodes) {
		if (!nodes || !nodes.length) return "";
		const brief = nodes.map(n => ({ nodeId: n.nodeId, label: n.label }));
		return "## 已有概念节点（生成 graph_delta 时【优先复用】这里的 nodeId，只有确实是新概念才新建）\n"
			+ JSON.stringify(brief);
	}

	const ANSWER_CONTRACT = `你是 PaperLoom，一个嵌在 Zotero 里的文献研究助手。

严格要求：
1. 只依据下面提供的「论文证据」回答。证据里没有的内容，明确说"提供的材料里没有涉及"，不要编造。
2. 答案里每个关键结论都必须挂引用，行内标记格式为 [PID:<paperId>, p.<页码>]，并在 citations 字段里列出同样的条目。
3. citations 的 paperId 和 page 必须来自证据块的 PID/PAGE 标记，不许自己推算页码。
4. 如果意图是跨篇比较，必须引用 ≥2 篇论文；若证据只来自一篇，就明确说"当前库里只有一篇相关文献"，不要硬凑。
5. graph_delta 里的每条边必须带 evidence（paperId、chunkId、page、quote 四项齐全），quote 必须是证据块中的原文片段。抽不出来就不要给这条边。
6. graph_delta 的节点【优先复用】下面「已有概念节点」里的 nodeId（在 nodes 里填 nodeId 字段，edges 里用 source/target 填 nodeId）；只有确实是新概念才用 label 新建。概念总数不要超过 15 个。
7. memory_delta 只记录关于【用户本人】的稳定偏好或状态，不记录论文内容。
8. 遵守 <memory> 区块里的用户偏好（例如回答长度、是否用公式）。

只输出一个 JSON 对象：
{
  "answer": "markdown 正文，含行内 [PID:xxx, p.3] 标记",
  "citations": [{"paperId":"ABCD1234","page":3,"chunkId":"PABCD1234-c005","quote":"原文片段"}],
  "graph_delta": {
    "nodes": [{"type":"concept","nodeId":"（复用已有节点时填这个）","label":"概念名","paperIds":["ABCD1234"]}],
    "edges": [{"source":"（已有 nodeId，优先）","sourceLabel":"概念A","target":"","targetLabel":"概念B",
               "type":"supports","label":"以…为前提","confidence":0.7,
               "evidence":{"paperId":"ABCD1234","chunkId":"PABCD1234-c005","page":3,"quote":"原文片段"}}]
  },
  "memory_delta": {"facts":[{"key":"style.length","value":"short","confidence":0.6,"reason":"用户说讲简单点"}]}
}
没有可写的增量时给空数组/空对象。`;

	function buildMessages(ctx) {
		const memoryBlock = PaperLoom.Memory.renderBlock(ctx.memoryFacts);

		const sections = [
			memoryBlock,
			"## 本轮意图判定\n" + ctx.intent,
			ctx.currentPaperTitle
				? "## 当前论文\nPID:" + ctx.currentPaperId + "《" + ctx.currentPaperTitle + "》"
				: "",
			renderEvidenceGroup("论文证据 · 当前论文", ctx.currentHits, ctx.titles),
			renderEvidenceGroup("论文证据 · 库内其他论文", ctx.libraryHits, ctx.titles),
			renderGraphContext(ctx.graphContext),
			renderExistingNodes(ctx.existingNodes)
		].filter(Boolean);

		return [
			{ role: "system", content: ANSWER_CONTRACT },
			{ role: "user", content: sections.join("\n\n") + "\n\n## 用户问题\n" + ctx.query }
		];
	}

	// -------------------------------------------------------------- 摘要兜底

	/** "讲讲这篇论文大概内容"这类问题：没有关键词，必须用开头的摘要/引言 */
	function isSummaryQuery(q) {
		return /(总结|概括|概述|大概内容|讲了什么|讲什么|主要讲|简单介绍|简单说明|简介|摘要|全文|主要内容|这篇论文|这篇文章|summar|overview|abstract|what.*paper.*about)/i
			.test(String(q || ""));
	}

	/** 取论文开头作为证据：引言段优先，再按原文顺序补齐到 n 块 */
	function leadingChunks(chunks, n) {
		const limit = n || 6;
		const out = [];
		const seen = new Set();

		const push = (c) => {
			if (!c || seen.has(c.chunkId) || out.length >= limit) return;
			seen.add(c.chunkId);
			out.push(c);
		};

		for (const c of chunks) {
			if (c.section === "intro") push(c);
		}
		for (const c of chunks) push(c);

		return out;
	}

	// -------------------------------------------------------------- 主入口

	/**
	 * 回答一个问题。
	 * @param {Object} opts
	 *   query          用户问题
	 *   item           当前 Zotero 条目（可空 = 全库模式）
	 *   referencedItems @ 引用的其他条目
	 *   onProgress     (stage, info) => void
	 * @returns {Promise<Object>} { turn, answer, citations, memoryUsed, diff, warnings }
	 */
	async function ask(opts) {
		const progress = opts.onProgress || function () { };
		const query = String(opts.query || "").trim();
		if (!query) throw new Error("问题为空");

		const referenced = opts.referencedItems || [];
		const warnings = [];

		// ---- 1 当前论文与 @ 引用论文解析
		progress("parsing", "解析论文全文…");
		const focusItems = [];
		if (opts.item) focusItems.push(opts.item);
		for (const it of referenced) {
			if (!opts.item || it.key !== opts.item.key) focusItems.push(it);
		}
		const focusDocs = await ensurePaperDocs(focusItems);

		const titles = Object.create(null);
		for (const d of focusDocs) titles[d.paperId] = d.title;

		const currentDoc = opts.item ? focusDocs.find(d => d.paperId === opts.item.key) : null;
		if (opts.item && currentDoc && !(currentDoc.chunks || []).length) {
			const errs = (currentDoc.extractionErrors || []).join("；");
			warnings.push("当前论文没有可用全文（缺附件或未建索引）"
				+ (errs ? "，提取过程报错：" + errs : "")
				+ "。回答只能依赖库内其他论文与元数据。");
		}
		if (currentDoc && currentDoc.textSource && currentDoc.textSource !== "pdftotext-cache") {
			warnings.push("当前论文的页码来源是「" + currentDoc.textSource + "」，引用页码可能不精确。");
		}

		// ---- 2 意图判定
		const intent = PaperLoom.Retriever.classifyIntent(query, {
			referencedPaperCount: focusDocs.length
		});
		progress("intent", intent);

		// ---- 3 并行检索
		progress("retrieving", "检索证据…");
		const crossPaper = intent === "cross_paper";

		const focusChunks = [];
		for (const d of focusDocs) for (const c of d.chunks || []) focusChunks.push(c);

		const lib = await libraryChunks(opts.item ? opts.item.key : null);
		Object.assign(titles, lib.titles);

		const [currentHitsRaw, libraryHitsRaw, graphSeeds, memoryFactsRaw] = await Promise.all([
			Promise.resolve(focusChunks.length
				? PaperLoom.Retriever.search(PaperLoom.Retriever.buildIndex(focusChunks), query, {
					topK: crossPaper ? 4 : 6,
					perPaperLimit: focusDocs.length > 1 ? 3 : 0
				})
				: []),
			Promise.resolve(lib.chunks.length
				? PaperLoom.Retriever.search(PaperLoom.Retriever.buildIndex(lib.chunks), query, {
					topK: crossPaper ? 6 : 3,
					perPaperLimit: 2        // ★ 论文多样性约束
				})
				: []),
			PaperLoom.GraphStore.findConceptsByQuery(query),
			PaperLoom.Memory.retrieve(query, { paperId: opts.item ? opts.item.key : null })
		]);

		// ★ 语言不一致兜底：
		// 中文提问 + 英文正文时 BM25 往往 0 命中；总结类问题（"讲了什么"）本身也没有关键词。
		// 这类情况直接用论文开头的摘要/引言当证据，而不是让模型说"没拿到材料"。
		let currentHits = currentHitsRaw;
		if (focusChunks.length) {
			const wantSummary = isSummaryQuery(query);
			if (!currentHits.length || wantSummary) {
				const lead = leadingChunks(focusChunks, wantSummary ? 8 : 6);
				const seen = new Set(currentHits.map(h => h.chunk.chunkId));
				const extras = lead
					.filter(c => !seen.has(c.chunkId))
					.map(c => ({ chunk: c, score: 0 }));

				if (extras.length) {
					currentHits = currentHits.concat(extras);
					if (!wantSummary) {
						warnings.push("检索与正文语言可能不一致（0 命中），已改用论文开头的摘要/引言作为证据。");
					}
				}
			}
		}

		let libraryHits = libraryHitsRaw;

		// 评测开关：noMemory 关掉记忆注入（A/B 对照的 A 组），
		// memoryOverride 用虚拟记忆替代真实记忆（不污染用户数据）。
		let memoryFacts = memoryFactsRaw;
		if (opts.noMemory) memoryFacts = [];
		else if (opts.memoryOverride) memoryFacts = opts.memoryOverride;

		// ★ 跨篇约束：检索阶段强制从 ≥2 篇取证据
		let paperIdsInEvidence = new Set(
			currentHits.concat(libraryHits).map(h => h.chunk.paperId)
		);

		// 不足 2 篇时先放宽一次检索（扩大候选、每篇只取 1 条、排除已命中的论文），
		// 真的捞不到才如实说明——不足则明确回答，不许硬凑。
		if (crossPaper && paperIdsInEvidence.size < 2 && lib.chunks.length) {
			const spare = lib.chunks.filter(c => !paperIdsInEvidence.has(c.paperId));
			if (spare.length) {
				const extra = PaperLoom.Retriever.search(
					PaperLoom.Retriever.buildIndex(spare), query,
					{ topK: 3, perPaperLimit: 1 }
				);
				if (extra.length) {
					libraryHits = libraryHits.concat(extra);
					paperIdsInEvidence = new Set(
						currentHits.concat(libraryHits).map(h => h.chunk.paperId)
					);
					warnings.push("跨篇问题的首轮检索只命中 1 篇，已放宽检索补充了 "
						+ extra.length + " 条其他论文的证据。");
				}
			}
		}

		if (crossPaper && paperIdsInEvidence.size < 2) {
			warnings.push("这是一个跨篇问题，但当前库里只检索到 "
				+ paperIdsInEvidence.size + " 篇相关文献的证据，回答不会跨篇硬凑。");
		}

		const graphContext = graphSeeds.length
			? await PaperLoom.GraphStore.neighbors(graphSeeds.map(n => n.nodeId), 2)
			: { nodes: [], edges: [] };

		// 已有概念节点表：要求模型复用 nodeId，这是跨论文连接真正形成的地方
		const graphNow = await PaperLoom.GraphStore.load();
		const existingNodes = graphNow.nodes
			.filter(n => n.type === "concept")
			.sort((a, b) => b.weight - a.weight)
			.slice(0, 80);

		// ---- 4 组装 prompt 并调用 LLM
		const ctx = {
			query, intent, memoryFacts, titles,
			currentHits, libraryHits, graphContext, existingNodes,
			currentPaperId: currentDoc ? currentDoc.paperId : null,
			currentPaperTitle: currentDoc ? currentDoc.title : null
		};

		if (!PaperLoom.LLM.isConfigured()) {
			// 降级：没配 Key 也要能看到检索结果，不至于整个面板不可用
			const turn = await recordTurn({
				paperId: opts.item ? opts.item.key : null,
				query: query,
				answer: "**尚未选择模型**，以下是本地 BM25 检索到的证据，可直接点击引用跳转原文。请到 设置 → PaperLoom 添加服务商并选择模型。",
				citations: currentHits.concat(libraryHits).map(h => ({
					paperId: h.chunk.paperId, page: h.chunk.page,
					chunkId: h.chunk.chunkId, quote: h.chunk.text.slice(0, 160)
				})),
				memoryUsed: memoryFacts.map(f => f.factId),
				graphTouched: []
			});
			warnings.push("未配置 API Key：仅返回本地检索结果。请在 设置 → PaperLoom 中填入 API Key。");
			return {
				turn, intent, warnings, titles,
				answer: turn.answer, citations: turn.citations,
				memoryUsed: memoryFacts, diff: null, degraded: true
			};
		}

		progress("thinking", "模型生成中…");
		const parsed = await PaperLoom.LLM.completeJSON({ messages: buildMessages(ctx) });

		// ---- 5 引用校验（定位失败的引用标红，不静默通过）
		const evidenceIndex = Object.create(null);
		for (const h of currentHits.concat(libraryHits)) {
			evidenceIndex[h.chunk.chunkId] = h.chunk;
		}

		const citations = [];
		for (const raw of (parsed.citations || [])) {
			const v = S.validateCitation(raw);
			const chunk = raw.chunkId ? evidenceIndex[raw.chunkId] : null;
			const citation = {
				paperId: raw.paperId ? String(raw.paperId) : (chunk ? chunk.paperId : ""),
				page: v.page != null ? v.page : (chunk ? chunk.page : null),
				chunkId: raw.chunkId || (chunk ? chunk.chunkId : null),
				quote: raw.quote || (chunk ? chunk.text.slice(0, 160) : ""),
				title: titles[raw.paperId] || "",
				valid: v.ok,
				errors: v.errors
			};
			// 证据块里没有这个 chunk，或页码对不上 → 标为不可定位
			if (citation.chunkId && !evidenceIndex[citation.chunkId]) {
				citation.valid = false;
				citation.errors = (citation.errors || []).concat(["引用的 chunk 不在本轮证据中"]);
			}
			if (citation.valid && chunk && citation.page !== chunk.page) {
				citation.page = chunk.page;   // 以证据块的真实页码为准
			}
			citations.push(citation);
		}
		const invalidCount = citations.filter(c => !c.valid).length;
		if (invalidCount) {
			warnings.push("有 " + invalidCount + " 条引用无法定位到页码，已在答案中标红。");
		}

		// ---- 6 落盘增量（图谱 + 记忆），对话已可渲染，这步不阻塞 UI
		const turn = await recordTurn({
			paperId: opts.item ? opts.item.key : null,
			query: query,
			answer: parsed.answer || "",
			citations: citations,
			memoryUsed: memoryFacts.map(f => f.factId),
			graphTouched: []
		});

		const delta = normalizeGraphDelta(parsed.graph_delta, { focusDocs, titles });

		// ★ co_asked：同一轮里被一起引用的论文，说明它们在用户的问题下被放到了一起。
		// 这是「交互」而非「抽取」产生的边，origin=interaction，证据就是这一轮的问答本身。
		const citedPapers = Array.from(new Set(
			citations.filter(c => c.valid && c.paperId).map(c => c.paperId)
		));
		if (citedPapers.length >= 2) {
			for (let a = 0; a < citedPapers.length; a++) {
				for (let b = a + 1; b < citedPapers.length; b++) {
					const ca = citations.find(c => c.paperId === citedPapers[a] && c.valid);
					delta.nodes.push({ type: "paper", paperId: citedPapers[a], label: titles[citedPapers[a]] || citedPapers[a] });
					delta.nodes.push({ type: "paper", paperId: citedPapers[b], label: titles[citedPapers[b]] || citedPapers[b] });
					delta.edges.push({
						source: S.paperNodeId(citedPapers[a]),
						target: S.paperNodeId(citedPapers[b]),
						type: "co_asked",
						label: "同一问题下被一起引用",
						confidence: 0.5,
						origin: "interaction",
						evidence: {
							paperId: citedPapers[a],
							chunkId: ca ? ca.chunkId : null,
							page: ca ? ca.page : null,
							quote: "用户提问：" + query.slice(0, 120)
						}
					});
				}
			}
		}

		let diff = null;
		// dryRun：评测模式下只算不写，避免评测把真实图谱/记忆撑坏
		if (delta && (delta.nodes.length || delta.edges.length) && !opts.dryRun) {
			progress("graph", "写入图谱增量…");
			diff = await PaperLoom.GraphStore.applyGraphDelta(delta);
			turn.graphTouched = (diff.addedNodes || []).map(n => n.nodeId);
			if (diff.rejected && diff.rejected.length) {
				warnings.push("有 " + diff.rejected.length + " 条图谱增量因缺少证据被丢弃（宁缺毋滥）。");
			}
		}

		let memoryApplied = [];
		if (parsed.memory_delta && !opts.dryRun) {
			progress("memory", "更新记忆…");
			memoryApplied = await PaperLoom.Memory.applyDelta(parsed.memory_delta, turn.turnId);
		}

		if (!opts.dryRun) await saveTurn(turn);

		return {
			turn, intent, warnings, titles,
			answer: parsed.answer || "",
			citations: citations,
			memoryUsed: memoryFacts,
			memoryApplied: memoryApplied,
			diff: diff,
			proposedDelta: opts.dryRun ? delta : null,
			evidencePaperCount: paperIdsInEvidence.size,
			degraded: false
		};
	}

	/**
	 * 规范化 LLM 的 graph_delta：
	 * 补上论文节点、把 @引用的论文接进图、剥掉没有证据的边。
	 */
	function normalizeGraphDelta(raw, ctx) {
		const nodes = [];
		const edges = [];

		for (const doc of ctx.focusDocs || []) {
			nodes.push({ type: "paper", paperId: doc.paperId, label: doc.title || doc.paperId });
		}
		for (const n of (raw && raw.nodes) || []) {
			if (!n || (!n.label && !n.nodeId)) continue;
			nodes.push({
				type: n.type === "paper" ? "paper" : (n.type === "claim" ? "claim" : "concept"),
				nodeId: n.nodeId,                       // 模型复用已有节点时带回来
				label: String(n.label || n.nodeId).slice(0, 80),
				aliases: n.aliases || [],
				paperIds: n.paperIds || []
			});
		}
		for (const e of (raw && raw.edges) || []) {
			if (!e) continue;
			edges.push({
				source: e.source, sourceLabel: e.sourceLabel || e.source,
				target: e.target, targetLabel: e.targetLabel || e.target,
				type: e.type, label: e.label,
				confidence: e.confidence,
				evidence: e.evidence,
				origin: e.origin || "extract"           // 保留 interaction / manual
			});
		}
		return { nodes, edges };
	}

	// -------------------------------------------------------------- 对话历史

	async function recordTurn(data) {
		return S.makeTurn(data);
	}

	async function saveTurn(turn) {
		const store = await PaperLoom.Storage.readJSON(TURNS_FILE, null) || { version: S.SCHEMA_VERSION, turns: [] };
		const idx = store.turns.findIndex(t => t.turnId === turn.turnId);
		if (idx >= 0) store.turns[idx] = turn;
		else store.turns.push(turn);
		if (store.turns.length > 500) store.turns = store.turns.slice(-500);
		await PaperLoom.Storage.writeJSON(TURNS_FILE, store);

		// 每 4 轮异步跑一次记忆抽取器，不阻塞当前回答
		if (store.turns.length % 4 === 0) {
			PaperLoom.Memory.inferFromTurns(store.turns).catch(() => { });
		}
		return turn;
	}

	async function recentTurns(paperId, limit) {
		const store = await PaperLoom.Storage.readJSON(TURNS_FILE, null) || { turns: [] };
		let turns = store.turns;
		if (paperId) turns = turns.filter(t => t.paperId === paperId);
		return turns.slice(-(limit || 20));
	}

	/**
	 * 手动重建图谱：对选中的论文跑概念 + 关系抽取。
	 * 关键工程细节：必须把已有节点列表喂给模型，要求优先复用现有 nodeId，
	 * 跨论文连接就是在这里真正形成的。
	 */
	async function rebuildGraph(items, onProgress) {
		const progress = onProgress || function () { };
		if (!PaperLoom.LLM.isConfigured()) {
			throw new Error("尚未选择模型，无法抽取概念与关系。请到 设置 → PaperLoom 添加服务商并选择模型");
		}

		const summary = { papers: 0, addedNodes: 0, addedEdges: 0, rejected: 0, failed: [] };

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			progress("paper", { index: i + 1, total: items.length, title: item.getField("title") });

			let doc;
			try {
				doc = await PaperLoom.Chunker.buildPaperDoc(item);
			}
			catch (e) {
				summary.failed.push({ key: item.key, error: String(e) });
				continue;
			}
			if (!doc.chunks || !doc.chunks.length) {
				summary.failed.push({ key: item.key, error: "无可用全文" });
				continue;
			}

			// 已有概念节点表（按权重取前 120 个，控制 prompt 体积）
			const graph = await PaperLoom.GraphStore.load();
			const existing = graph.nodes
				.filter(n => n.type === "concept")
				.sort((a, b) => b.weight - a.weight)
				.slice(0, 120)
				.map(n => ({ nodeId: n.nodeId, label: n.label }));

			// 取代表性 chunk，覆盖各 section，控制 token
			const picked = pickRepresentativeChunks(doc.chunks, 10);
			const evidenceText = picked.map(c =>
				"[PID:" + c.paperId + " PAGE:" + c.page + " CHUNK:" + c.chunkId + "]\n" + c.text
			).join("\n\n");

			const system = `从论文证据中抽取知识图谱增量。

规则：
1. 概念数量 ≤ ${S.LIMITS.conceptsPerPaper} 个，必须做归一化（同义词合并为一个）。
2. 【优先复用】下面「已有概念节点」里的 nodeId；只有确实是新概念才新建。这是跨论文连接形成的关键。
3. 每条边必须带 evidence：paperId、chunkId、page、quote 四项齐全，quote 必须是证据原文片段。抽不出证据的关系直接丢弃。
4. 边 type 只能是 mentions / relates / supports / contradicts / cites。relates 时在 label 里写人话关系，如"以…为前提"。

已有概念节点（优先复用 nodeId）：
${JSON.stringify(existing)}

只输出 JSON：
{"nodes":[{"type":"concept","label":"...","aliases":[],"paperIds":["${doc.paperId}"]}],
 "edges":[{"sourceLabel":"...","targetLabel":"...","type":"relates","label":"...","confidence":0.7,
           "evidence":{"paperId":"${doc.paperId}","chunkId":"...","page":1,"quote":"..."}}]}`;

			let parsed;
			try {
				parsed = await PaperLoom.LLM.completeJSON({
					model: "extract",
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: "论文：《" + doc.title + "》\n\n" + evidenceText }
					]
				});
			}
			catch (e) {
				summary.failed.push({ key: item.key, error: String(e) });
				continue;
			}

			const delta = normalizeGraphDelta(parsed, { focusDocs: [doc], titles: {} });
			// 概念节点默认归属本篇，供跨论文过滤统计
			for (const n of delta.nodes) {
				if (n.type === "concept" && !(n.paperIds || []).length) n.paperIds = [doc.paperId];
			}
			const diff = await PaperLoom.GraphStore.applyGraphDelta(delta);

			summary.papers++;
			summary.addedNodes += (diff.addedNodes || []).length;
			summary.addedEdges += (diff.addedEdges || []).length;
			summary.rejected += (diff.rejected || []).length;

			progress("done", { index: i + 1, total: items.length, diff: diff });
		}

		return summary;
	}

	function pickRepresentativeChunks(chunks, n) {
		const bySection = Object.create(null);
		for (const c of chunks) {
			(bySection[c.section] = bySection[c.section] || []).push(c);
		}
		const order = ["intro", "method", "result", "discussion", "other"];
		const picked = [];
		let round = 0;
		while (picked.length < n) {
			let advanced = false;
			for (const sec of order) {
				const list = bySection[sec];
				if (list && list[round]) {
					picked.push(list[round]);
					advanced = true;
					if (picked.length >= n) break;
				}
			}
			if (!advanced) break;
			round++;
		}
		return picked.length ? picked : chunks.slice(0, n);
	}

	return {
		ask, rebuildGraph, recentTurns, saveTurn, ensurePaperDocs,
		libraryChunks, buildMessages, normalizeGraphDelta, pickRepresentativeChunks
	};
})();
