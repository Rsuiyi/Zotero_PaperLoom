/* PaperLoom — retriever.js
 * L2 领域层：BM25 检索（不自建向量库）。
 * 三件事：意图判定、当前论文检索、全库检索（带论文多样性约束）。
 * 纯 JS、无外部依赖 —— Plan B 切 Web 应用时可整体复用。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Retriever = (function () {
	const S = PaperLoom.Schema;

	const K1 = 1.5;
	const B = 0.75;

	const STOPWORDS = new Set((
		"the a an and or of to in on for with that this these those is are was were be been being as by at from it its " +
		"we our they their he she you i not no but if then than so such which who whom what when where how why can could " +
		"will would should may might do does did done have has had very more most much many also only just about into " +
		"的 了 和 是 在 有 我 你 他 她 它 们 这 那 之 与 及 或 для 也 就 都 而 被 把 对 从 到 上 下 中 个 并 等 以 其 一个 可以 如果 因为 所以 但是 " +
		"研究 方法 结果 本文 我们 一种 进行 通过 表明 提出"
	).split(/\s+/).filter(Boolean));

	/** 分词：英文按词、中文按字（bigram 由调用方按需拼），统一小写去停用词 */
	function tokenize(text) {
		const raw = String(text == null ? "" : text).toLowerCase();
		const tokens = [];
		const re = /[a-z0-9]+(?:[-_'][a-z0-9]+)*|[\u4e00-\u9fa5]/g;
		let m;
		const cjk = [];
		while ((m = re.exec(raw)) !== null) {
			const t = m[0];
			if (/^[\u4e00-\u9fa5]$/.test(t)) {
				cjk.push(t);
				tokens.push(t);
			}
			else {
				if (t.length < 2) continue;
				if (STOPWORDS.has(t)) continue;
				tokens.push(t);
			}
		}
		// 中文补 bigram，弥补单字检索区分度不足
		for (let i = 0; i + 1 < cjk.length; i++) {
			tokens.push(cjk[i] + cjk[i + 1]);
		}
		return tokens.filter(t => !STOPWORDS.has(t));
	}

	/** 对一组 chunk 建 BM25 索引 */
	function buildIndex(chunks) {
		const docs = [];
		const df = Object.create(null);
		let totalLen = 0;

		for (const chunk of chunks) {
			const tokens = tokenize(chunk.text);
			const tf = Object.create(null);
			for (const t of tokens) tf[t] = (tf[t] || 0) + 1;
			for (const t of Object.keys(tf)) df[t] = (df[t] || 0) + 1;
			docs.push({ chunk: chunk, tf: tf, len: tokens.length });
			totalLen += tokens.length;
		}

		return {
			docs: docs,
			df: df,
			N: docs.length,
			avgdl: docs.length ? totalLen / docs.length : 0
		};
	}

	function score(index, queryTokens, doc) {
		let s = 0;
		for (const t of queryTokens) {
			const f = doc.tf[t];
			if (!f) continue;
			const n = index.df[t] || 0;
			const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
			const denom = f + K1 * (1 - B + B * (index.avgdl ? doc.len / index.avgdl : 1));
			s += idf * (f * (K1 + 1)) / denom;
		}
		return s;
	}

	/**
	 * 检索。
	 * @param {Object} index buildIndex 的产物
	 * @param {string} query
	 * @param {Object} opts { topK, perPaperLimit, minScore }
	 */
	function search(index, query, opts) {
		opts = opts || {};
		const topK = opts.topK || 6;
		const perPaperLimit = opts.perPaperLimit || 0;   // 0 = 不限制
		const queryTokens = Array.from(new Set(tokenize(query)));
		if (!queryTokens.length || !index.N) return [];

		const scored = [];
		for (const doc of index.docs) {
			const s = score(index, queryTokens, doc);
			if (s > (opts.minScore || 0)) scored.push({ chunk: doc.chunk, score: s });
		}
		scored.sort((a, b) => b.score - a.score);

		if (!perPaperLimit) return scored.slice(0, topK);

		// 论文多样性约束：每篇最多取 perPaperLimit 条，先铺广度再补深度
		const perPaper = Object.create(null);
		const picked = [];
		const overflow = [];
		for (const hit of scored) {
			const pid = hit.chunk.paperId;
			const used = perPaper[pid] || 0;
			if (used < perPaperLimit) {
				perPaper[pid] = used + 1;
				picked.push(hit);
				if (picked.length >= topK) break;
			}
			else {
				overflow.push(hit);
			}
		}
		for (const hit of overflow) {
			if (picked.length >= topK) break;
			picked.push(hit);
		}
		return picked;
	}

	/**
	 * 意图判定：先用廉价规则，模棱两可时才值得花 LLM。
	 * 返回 single_fact | cross_paper | concept | meta
	 */
	function classifyIntent(query, context) {
		const q = String(query || "");
		const lower = q.toLowerCase();

		// 元问题：问"你记得我什么"这类关于助手自身状态的问题
		if (/(你记得|记住了什么|我的偏好|你知道我|记忆卡片|记忆面板|remember about me|what do you know about me)/i.test(q)) {
			return "meta";
		}
		// 跨篇：显式比较词，或 @ 引用了多篇
		const refCount = (context && context.referencedPaperCount) || 0;
		if (refCount > 1
			|| /(对比|比较|异同|区别|差异|谁对|哪个更|矛盾|冲突|一致吗|这[两三四五几]篇|各篇|跨论文|其他论文|别的论文)/.test(q)
			|| /\b(compare|contrast|versus|vs\.?|differ|disagree|contradict|across papers|other papers)\b/.test(lower)) {
			return "cross_paper";
		}
		// 概念解释
		if (/(是什么|什么是|定义|解释一下|怎么理解|原理是|为什么叫)/.test(q)
			|| /\b(what is|what are|define|definition of|explain)\b/.test(lower)) {
			return "concept";
		}
		return "single_fact";
	}

	return { tokenize, buildIndex, search, classifyIntent, STOPWORDS };
})();
