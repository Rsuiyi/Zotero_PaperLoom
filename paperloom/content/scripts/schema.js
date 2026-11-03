/* PaperLoom — schema.js
 * ★ 数据契约唯一来源：只定义类型、常量与校验函数，不写业务逻辑。
 * 所有模块（抽取 / 检索 / 图谱 / 记忆 / UI）都必须 import 本文件的常量与校验器。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Schema = (function () {
	const SCHEMA_VERSION = 1;

	const SECTIONS = ["intro", "method", "result", "discussion", "other"];
	const NODE_TYPES = ["paper", "concept", "claim"];
	const EDGE_TYPES = ["mentions", "relates", "supports", "contradicts", "co_asked", "cites"];
	const EDGE_ORIGINS = ["extract", "interaction", "manual"];
	const MEMORY_EVIDENCE_TYPES = ["explicit", "inferred", "behavior"];
	const INTENTS = ["single_fact", "cross_paper", "concept", "meta"];

	// 规模与粒度约束（计划书硬性数值）
	const LIMITS = {
		chunkMinChars: 400,
		chunkMaxChars: 800,
		conceptsPerPaper: 15,
		maxNodesPerLibrary: 800,
		memoryTopK: 6,
		memoryTokenBudget: 400,
		llmMinMaxTokens: 4096
	};

	function nowISO() {
		return new Date().toISOString();
	}

	/** 稳定的短 hash（FNV-1a），用于 LLM 缓存键与 id 派生，不依赖任何 Zotero 私有 API */
	function hash(str) {
		let h = 0x811c9dc5;
		const s = String(str == null ? "" : str);
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return ("00000000" + h.toString(16)).slice(-8);
	}

	function uid(prefix) {
		return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
	}

	function isNonEmptyString(v) {
		return typeof v === "string" && v.trim().length > 0;
	}

	function clampConfidence(v, fallback) {
		const n = typeof v === "number" ? v : parseFloat(v);
		if (!isFinite(n)) return typeof fallback === "number" ? fallback : 0.5;
		return Math.min(1, Math.max(0, n));
	}

	/** 概念标签归一化：大小写 / 空白 / 连字符统一，用于别名合并的第一道 */
	function normalizeLabel(label) {
		return String(label == null ? "" : label)
			.toLowerCase()
			.replace(/[\s\u3000]+/g, " ")
			.replace(/[-_/]+/g, " ")
			.replace(/[.,;:!?()[\]{}"'`]+/g, "")
			.trim();
	}

	function conceptNodeId(label) {
		return "C-" + hash(normalizeLabel(label));
	}

	function paperNodeId(paperId) {
		return "P-" + String(paperId);
	}

	function chunkId(paperId, index) {
		return "P" + String(paperId) + "-c" + String(index).padStart(3, "0");
	}

	// ---------------------------------------------------------------- 工厂

	function makePaperDoc(o) {
		return {
			paperId: String(o.paperId),
			title: o.title || "",
			authors: Array.isArray(o.authors) ? o.authors : [],
			year: o.year || "",
			venue: o.venue || "",
			attachmentId: o.attachmentId == null ? null : o.attachmentId,
			chunks: Array.isArray(o.chunks) ? o.chunks : [],
			processedAt: o.processedAt || nowISO(),
			version: SCHEMA_VERSION
		};
	}

	function makeChunk(o) {
		return {
			chunkId: o.chunkId,
			paperId: String(o.paperId),
			page: typeof o.page === "number" && o.page >= 1 ? o.page : 1,
			section: SECTIONS.indexOf(o.section) >= 0 ? o.section : "other",
			text: o.text || "",
			concepts: Array.isArray(o.concepts) ? o.concepts : []
		};
	}

	function makeNode(o) {
		const type = NODE_TYPES.indexOf(o.type) >= 0 ? o.type : "concept";
		const label = o.label || "";
		return {
			nodeId: o.nodeId || (type === "paper" ? paperNodeId(o.paperId || label) : conceptNodeId(label)),
			type: type,
			label: label,
			aliases: Array.isArray(o.aliases) ? o.aliases : [],
			paperIds: Array.isArray(o.paperIds) ? o.paperIds.map(String) : [],
			weight: typeof o.weight === "number" ? o.weight : 1
		};
	}

	function makeEvidence(o) {
		if (!o) return null;
		return {
			paperId: o.paperId == null ? "" : String(o.paperId),
			chunkId: o.chunkId || "",
			page: typeof o.page === "number" ? o.page : parseInt(o.page, 10) || null,
			quote: o.quote || ""
		};
	}

	function makeEdge(o) {
		const evidence = makeEvidence(o.evidence);
		return {
			edgeId: o.edgeId || "E-" + hash([o.source, o.target, o.type, evidence && evidence.quote].join("|")),
			source: o.source,
			target: o.target,
			type: EDGE_TYPES.indexOf(o.type) >= 0 ? o.type : "relates",
			label: o.label || "",
			evidence: evidence,
			confidence: clampConfidence(o.confidence, 0.6),
			origin: EDGE_ORIGINS.indexOf(o.origin) >= 0 ? o.origin : "extract"
		};
	}

	function makeMemoryFact(o) {
		return {
			factId: o.factId || uid("m"),
			key: o.key,
			value: o.value,
			confidence: clampConfidence(o.confidence, 0.6),
			evidence: Array.isArray(o.evidence) ? o.evidence : [],
			origin: o.origin === "explicit" ? "explicit" : (o.origin || "inferred"),
			createdAt: o.createdAt || nowISO(),
			updatedAt: o.updatedAt || nowISO(),
			history: Array.isArray(o.history) ? o.history : []
		};
	}

	function makeTurn(o) {
		return {
			turnId: o.turnId || uid("t"),
			paperId: o.paperId == null ? null : String(o.paperId),
			query: o.query || "",
			answer: o.answer || "",
			citations: Array.isArray(o.citations) ? o.citations : [],
			memoryUsed: Array.isArray(o.memoryUsed) ? o.memoryUsed : [],
			graphTouched: Array.isArray(o.graphTouched) ? o.graphTouched : [],
			createdAt: o.createdAt || nowISO()
		};
	}

	// ---------------------------------------------------------------- 校验
	// 硬约束 1：没有 evidence 的边不许进图谱。
	// 硬约束 2：答案里的 citations 必须能定位到 paperId + page。

	function validateNode(node) {
		const errors = [];
		if (!node || !isNonEmptyString(node.nodeId)) errors.push("nodeId 缺失");
		if (!node || NODE_TYPES.indexOf(node.type) < 0) errors.push("type 非法");
		if (!node || !isNonEmptyString(node.label)) errors.push("label 缺失");
		return { ok: errors.length === 0, errors: errors };
	}

	function validateEdge(edge) {
		const errors = [];
		if (!edge) return { ok: false, errors: ["edge 为空"] };
		if (!isNonEmptyString(edge.source)) errors.push("source 缺失");
		if (!isNonEmptyString(edge.target)) errors.push("target 缺失");
		if (edge.source === edge.target) errors.push("自环边");
		if (EDGE_TYPES.indexOf(edge.type) < 0) errors.push("type 非法: " + edge.type);
		const ev = edge.evidence;
		if (!ev) {
			errors.push("缺少 evidence —— 无证据的边不许进图谱");
		}
		else {
			if (!isNonEmptyString(ev.paperId)) errors.push("evidence.paperId 缺失");
			if (!isNonEmptyString(ev.quote)) errors.push("evidence.quote 缺失");
		}
		return { ok: errors.length === 0, errors: errors };
	}

	function validateMemoryFact(fact) {
		const errors = [];
		if (!fact || !isNonEmptyString(fact.key)) errors.push("key 缺失");
		if (!fact || fact.value === undefined || fact.value === null || fact.value === "") errors.push("value 缺失");
		if (fact && fact.evidence && !Array.isArray(fact.evidence)) errors.push("evidence 必须是数组");
		return { ok: errors.length === 0, errors: errors };
	}

	/** 引用定位：能定位到页码才算通过，失败的引用在 UI 上标红而不是静默丢弃 */
	function validateCitation(citation) {
		const errors = [];
		if (!citation || !isNonEmptyString(String(citation.paperId || ""))) errors.push("paperId 缺失");
		const page = typeof citation.page === "number" ? citation.page : parseInt(citation.page, 10);
		if (!isFinite(page) || page < 1) errors.push("page 无法定位");
		return { ok: errors.length === 0, errors: errors, page: isFinite(page) ? page : null };
	}

	return {
		SCHEMA_VERSION, SECTIONS, NODE_TYPES, EDGE_TYPES, EDGE_ORIGINS,
		MEMORY_EVIDENCE_TYPES, INTENTS, LIMITS,
		nowISO, hash, uid, isNonEmptyString, clampConfidence, normalizeLabel,
		conceptNodeId, paperNodeId, chunkId,
		makePaperDoc, makeChunk, makeNode, makeEdge, makeEvidence, makeMemoryFact, makeTurn,
		validateNode, validateEdge, validateMemoryFact, validateCitation
	};
})();
