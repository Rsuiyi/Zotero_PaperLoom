/* PaperLoom — graphStore.js
 * L2 领域层：带证据的知识图谱存储。
 *
 * 所有图变更统一走 applyGraphDelta(delta)，返回 diff 供 UI 动画 —— 第二阶段的预处理
 * 只是另一个 delta 生产者，不需要改这里。
 * 硬约束：没有 evidence 的边一律丢弃，宁缺毋滥。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.GraphStore = (function () {
	const S = PaperLoom.Schema;
	const FILE = "graph.json";

	async function load() {
		const data = await PaperLoom.Storage.readJSON(FILE, null);
		if (data && Array.isArray(data.nodes) && Array.isArray(data.edges)) return data;
		return { version: S.SCHEMA_VERSION, nodes: [], edges: [] };
	}

	async function save(graph) {
		await PaperLoom.Storage.writeJSON(FILE, graph);
	}

	function indexNodes(graph) {
		const byId = Object.create(null);
		const byNormLabel = Object.create(null);
		for (const n of graph.nodes) {
			byId[n.nodeId] = n;
			byNormLabel[S.normalizeLabel(n.label)] = n;
			for (const a of n.aliases || []) {
				byNormLabel[S.normalizeLabel(a)] = n;
			}
		}
		return { byId, byNormLabel };
	}

	/**
	 * 概念对齐：先归一化字符串 / 别名表命中，再做字符级相似度判定。
	 * 返回已存在的节点或 null（由调用方决定新建）。
	 */
	function alignConcept(graph, label, idx) {
		idx = idx || indexNodes(graph);
		const norm = S.normalizeLabel(label);
		if (!norm) return null;
		if (idx.byNormLabel[norm]) return idx.byNormLabel[norm];

		// 相似度兜底：短标签要求更严，避免把不同概念合并
		let best = null;
		let bestSim = 0;
		for (const n of graph.nodes) {
			if (n.type !== "concept") continue;
			const sim = similarity(norm, S.normalizeLabel(n.label));
			if (sim > bestSim) { bestSim = sim; best = n; }
		}
		const threshold = norm.length <= 6 ? 0.92 : 0.86;
		return bestSim >= threshold ? best : null;
	}

	/** 归一化编辑距离相似度 */
	function similarity(a, b) {
		if (a === b) return 1;
		if (!a || !b) return 0;
		const m = a.length, n = b.length;
		if (Math.abs(m - n) / Math.max(m, n) > 0.4) return 0;
		let prev = new Array(n + 1);
		let cur = new Array(n + 1);
		for (let j = 0; j <= n; j++) prev[j] = j;
		for (let i = 1; i <= m; i++) {
			cur[0] = i;
			for (let j = 1; j <= n; j++) {
				cur[j] = Math.min(
					prev[j] + 1,
					cur[j - 1] + 1,
					prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
				);
			}
			const t = prev; prev = cur; cur = t;
		}
		return 1 - prev[n] / Math.max(m, n);
	}

	/**
	 * ★ 唯一的图变更入口。
	 * @param {Object} delta { nodes: [...], edges: [...] }
	 * @returns {Promise<Object>} diff { addedNodes, updatedNodes, addedEdges, rejected, pruned }
	 */
	async function applyGraphDelta(delta) {
		const graph = await load();
		const diff = { addedNodes: [], updatedNodes: [], addedEdges: [], rejected: [], pruned: [] };
		let idx = indexNodes(graph);

		// ---- 节点
		for (const raw of (delta && delta.nodes) || []) {
			if (!raw || !raw.label) continue;
			const type = raw.type || "concept";

			let node = null;
			if (type === "paper") {
				const pid = S.paperNodeId(raw.paperId || raw.nodeId || raw.label);
				node = idx.byId[pid] || null;
				if (!node) {
					node = S.makeNode({
						nodeId: pid, type: "paper", label: raw.label,
						paperIds: [String(raw.paperId || raw.label)], weight: 1
					});
					const v = S.validateNode(node);
					if (!v.ok) { diff.rejected.push({ kind: "node", label: raw.label, errors: v.errors }); continue; }
					graph.nodes.push(node);
					diff.addedNodes.push(node);
					idx = indexNodes(graph);
				}
				else if (raw.label && node.label !== raw.label) {
					node.label = raw.label;
					diff.updatedNodes.push(node);
				}
			}
			else {
				// 模型回传了已有 nodeId 就直接复用，否则走标签对齐
				node = (raw.nodeId && idx.byId[raw.nodeId]) || alignConcept(graph, raw.label, idx);
				if (node) {
					// 合并到已有概念：记别名、累加论文集合与权重
					const norm = S.normalizeLabel(raw.label);
					if (S.normalizeLabel(node.label) !== norm
						&& !(node.aliases || []).some(a => S.normalizeLabel(a) === norm)) {
						node.aliases = (node.aliases || []).concat([raw.label]);
					}
					let changed = false;
					for (const pid of (raw.paperIds || []).map(String)) {
						if (node.paperIds.indexOf(pid) < 0) { node.paperIds.push(pid); changed = true; }
					}
					node.weight = node.paperIds.length || (node.weight + 1);
					if (changed) diff.updatedNodes.push(node);
				}
				else {
					node = S.makeNode({
						type: type, label: raw.label,
						aliases: raw.aliases || [],
						paperIds: (raw.paperIds || []).map(String),
						weight: Math.max(1, (raw.paperIds || []).length)
					});
					const v = S.validateNode(node);
					if (!v.ok) { diff.rejected.push({ kind: "node", label: raw.label, errors: v.errors }); continue; }
					graph.nodes.push(node);
					diff.addedNodes.push(node);
					idx = indexNodes(graph);
				}
			}
		}

		// ---- 边（每条必须带证据）
		const existingEdgeKeys = new Set(graph.edges.map(e => [e.source, e.target, e.type, S.hash(e.evidence && e.evidence.quote)].join("|")));

		for (const raw of (delta && delta.edges) || []) {
			if (!raw) continue;

			const source = resolveNodeRef(graph, idx, raw.source, raw.sourceLabel);
			const target = resolveNodeRef(graph, idx, raw.target, raw.targetLabel);
			if (!source || !target) {
				diff.rejected.push({ kind: "edge", raw: raw, errors: ["端点无法解析为已有 nodeId"] });
				continue;
			}

			const edge = S.makeEdge({
				source: source.nodeId,
				target: target.nodeId,
				type: raw.type,
				label: raw.label,
				evidence: raw.evidence,
				confidence: raw.confidence,
				origin: raw.origin || "extract"
			});

			const check = S.validateEdge(edge);
			if (!check.ok) {
				// ★ 无证据的边在这里被丢弃，而不是悄悄进图
				diff.rejected.push({ kind: "edge", raw: raw, errors: check.errors });
				continue;
			}

			const key = [edge.source, edge.target, edge.type, S.hash(edge.evidence.quote)].join("|");
			if (existingEdgeKeys.has(key)) continue;
			existingEdgeKeys.add(key);

			graph.edges.push(edge);
			diff.addedEdges.push(edge);

			// 边两端的 concept 节点吸收论文归属，供"只显示跨论文概念"过滤使用
			for (const node of [source, target]) {
				if (node.type !== "concept") continue;
				const pid = edge.evidence.paperId;
				if (pid && node.paperIds.indexOf(pid) < 0) {
					node.paperIds.push(pid);
					node.weight = node.paperIds.length;
				}
			}
		}

		// ---- 规模控制：超过上限就剪掉最弱的孤立概念节点
		if (graph.nodes.length > S.LIMITS.maxNodesPerLibrary) {
			const degree = Object.create(null);
			for (const e of graph.edges) {
				degree[e.source] = (degree[e.source] || 0) + 1;
				degree[e.target] = (degree[e.target] || 0) + 1;
			}
			const prunable = graph.nodes
				.filter(n => n.type === "concept")
				.sort((a, b) => ((degree[a.nodeId] || 0) - (degree[b.nodeId] || 0))
					|| (a.paperIds.length - b.paperIds.length));
			const overflow = graph.nodes.length - S.LIMITS.maxNodesPerLibrary;
			const doomed = new Set(prunable.slice(0, overflow).map(n => n.nodeId));
			if (doomed.size) {
				graph.nodes = graph.nodes.filter(n => !doomed.has(n.nodeId));
				graph.edges = graph.edges.filter(e => !doomed.has(e.source) && !doomed.has(e.target));
				diff.pruned = Array.from(doomed);
			}
		}

		await save(graph);
		return diff;
	}

	function resolveNodeRef(graph, idx, nodeId, label) {
		if (nodeId && idx.byId[nodeId]) return idx.byId[nodeId];
		const ref = label || nodeId;
		if (!ref) return null;
		// 论文引用形式：paper:<key> 或直接是 P-<key>
		const pm = String(ref).match(/^(?:paper:)?(?:P-)?([A-Z0-9]{8})$/i);
		if (pm && idx.byId[S.paperNodeId(pm[1])]) return idx.byId[S.paperNodeId(pm[1])];
		return alignConcept(graph, ref, idx);
	}

	/** 取节点的 1~2 跳邻居（只走带证据的边） */
	async function neighbors(nodeIds, hops) {
		const graph = await load();
		hops = hops || 1;
		const frontier = new Set(nodeIds);
		const visited = new Set(nodeIds);
		const edges = [];

		for (let h = 0; h < hops; h++) {
			const next = new Set();
			for (const e of graph.edges) {
				if (!e.evidence) continue;
				if (frontier.has(e.source) && !visited.has(e.target)) { next.add(e.target); edges.push(e); }
				else if (frontier.has(e.target) && !visited.has(e.source)) { next.add(e.source); edges.push(e); }
				else if (frontier.has(e.source) && frontier.has(e.target)) { edges.push(e); }
			}
			for (const id of next) visited.add(id);
			if (!next.size) break;
			frontier.clear();
			for (const id of next) frontier.add(id);
		}

		const idx = indexNodes(graph);
		return {
			nodes: Array.from(visited).map(id => idx.byId[id]).filter(Boolean),
			edges: dedupeEdges(edges)
		};
	}

	function dedupeEdges(edges) {
		const seen = new Set();
		const out = [];
		for (const e of edges) {
			if (seen.has(e.edgeId)) continue;
			seen.add(e.edgeId);
			out.push(e);
		}
		return out;
	}

	/** 按概念标签找节点，供检索阶段把 query 概念接到图上 */
	async function findConceptsByQuery(query) {
		const graph = await load();
		const tokens = new Set(PaperLoom.Retriever.tokenize(query));
		const hits = [];
		for (const n of graph.nodes) {
			if (n.type !== "concept") continue;
			const bag = PaperLoom.Retriever.tokenize([n.label].concat(n.aliases || []).join(" "));
			let overlap = 0;
			for (const t of bag) if (tokens.has(t)) overlap++;
			if (overlap > 0) hits.push({ node: n, overlap: overlap });
		}
		hits.sort((a, b) => b.overlap - a.overlap || b.node.paperIds.length - a.node.paperIds.length);
		return hits.slice(0, 5).map(h => h.node);
	}

	/** 跨论文概念 = 关联论文数 ≥ 2，demo 里最有说服力的一键过滤 */
	async function stats() {
		const graph = await load();
		const crossPaper = graph.nodes.filter(n => n.type === "concept" && n.paperIds.length >= 2);
		return {
			nodes: graph.nodes.length,
			edges: graph.edges.length,
			papers: graph.nodes.filter(n => n.type === "paper").length,
			concepts: graph.nodes.filter(n => n.type === "concept").length,
			crossPaperConcepts: crossPaper.length
		};
	}

	async function clear() {
		await save({ version: S.SCHEMA_VERSION, nodes: [], edges: [] });
	}

	return {
		load, save, applyGraphDelta, neighbors, findConceptsByQuery,
		alignConcept, similarity, indexNodes, stats, clear
	};
})();
