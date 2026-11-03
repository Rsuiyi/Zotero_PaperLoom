/* PaperLoom — memory.js
 * L2 领域层：记忆系统（第一阶段的灵魂）。
 *
 * 写入三条路径：explicit（用户明说/面板编辑）、inferred（对话抽取）、behavior（行为信号）。
 * 读取路径：query + 当前论文 → key 匹配 + 关键词 → top-6 / ≤400 token → <memory> 区块。
 * 冲突规则（必须实现，否则演示时记错就解释不清）：
 *   同 key 新证据覆盖旧值，旧值进 history；
 *   用户手动编辑的 confidence = 1.0 且 origin=explicit，此后不被推断覆盖。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Memory = (function () {
	const S = PaperLoom.Schema;
	const FILE = "memory.json";

	// 偏好类 key 做成白名单提示给抽取器，避免 key 爆炸
	const KNOWN_KEYS = [
		"style.length",        // short | medium | long
		"style.formula",       // avoid | ok
		"style.language",      // zh | en
		"style.tone",
		"familiarity.*",       // familiarity.<paperKey> = unread | skimmed | read
		"interest.*",          // interest.<concept> = high | low
		"background.field",
		"background.level"
	];

	async function load() {
		const data = await PaperLoom.Storage.readJSON(FILE, null);
		if (data && Array.isArray(data.facts)) return data;
		return { version: S.SCHEMA_VERSION, facts: [] };
	}

	async function save(store) {
		await PaperLoom.Storage.writeJSON(FILE, store);
	}

	async function all() {
		return (await load()).facts;
	}

	function findByKey(facts, key) {
		return facts.find(f => f.key === key) || null;
	}

	/**
	 * 写入一条事实，返回 { action, fact }。
	 * action: created | updated | rejected-locked | rejected-invalid | unchanged
	 */
	async function upsert(input) {
		const store = await load();
		const candidate = S.makeMemoryFact(input);

		const check = S.validateMemoryFact(candidate);
		if (!check.ok) {
			return { action: "rejected-invalid", errors: check.errors, fact: null };
		}

		const existing = findByKey(store.facts, candidate.key);
		if (!existing) {
			store.facts.push(candidate);
			await save(store);
			return { action: "created", fact: candidate };
		}

		// ★ 冲突规则：explicit 记忆（用户亲手确认，confidence=1.0）不被推断覆盖
		const incomingExplicit = candidate.origin === "explicit";
		if (existing.origin === "explicit" && existing.confidence >= 1 && !incomingExplicit) {
			return { action: "rejected-locked", fact: existing };
		}

		if (String(existing.value) === String(candidate.value) && !incomingExplicit) {
			// 同值重复命中：只抬置信度与时间，不写 history
			existing.confidence = S.clampConfidence(Math.max(existing.confidence, candidate.confidence), existing.confidence);
			existing.updatedAt = S.nowISO();
			existing.evidence = (existing.evidence || []).concat(candidate.evidence || []).slice(-8);
			await save(store);
			return { action: "unchanged", fact: existing };
		}

		// 新证据覆盖旧值，旧值进 history
		existing.history = existing.history || [];
		existing.history.push({
			value: existing.value,
			confidence: existing.confidence,
			origin: existing.origin,
			evidence: existing.evidence,
			replacedAt: S.nowISO()
		});
		existing.value = candidate.value;
		existing.confidence = incomingExplicit ? 1.0 : candidate.confidence;
		existing.origin = candidate.origin;
		existing.evidence = candidate.evidence;
		existing.updatedAt = S.nowISO();

		await save(store);
		return { action: "updated", fact: existing };
	}

	/** 用户在记忆面板手动编辑 → 锁定为 explicit / confidence 1.0 */
	async function setExplicit(key, value, text) {
		return upsert({
			key: key,
			value: value,
			confidence: 1.0,
			origin: "explicit",
			evidence: [{ type: "explicit", text: text || "用户在记忆面板中确认", turnId: null }]
		});
	}

	async function remove(factId) {
		const store = await load();
		const before = store.facts.length;
		store.facts = store.facts.filter(f => f.factId !== factId);
		if (store.facts.length !== before) await save(store);
		return before !== store.facts.length;
	}

	/** 行为信号写入：阅读停留、tip 采纳/忽略、追问 */
	async function recordBehavior(signal) {
		const map = {
			"tip.ignored": { key: "tip.threshold", value: "higher", confidence: 0.5 },
			"tip.accepted": { key: "tip.threshold", value: "lower", confidence: 0.6 },
			"asked.definition": { key: "style.length", value: "medium", confidence: 0.45 }
		};
		const spec = map[signal && signal.type];
		if (!spec) return { action: "ignored", fact: null };
		return upsert({
			key: spec.key,
			value: spec.value,
			confidence: spec.confidence,
			origin: "inferred",
			evidence: [{ type: "behavior", signal: signal.type, turnId: signal.turnId || null }]
		});
	}

	function approxTokens(text) {
		// 粗估：中文 1 字 ≈ 1 token，英文 4 字符 ≈ 1 token
		const s = String(text || "");
		const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
		return cjk + Math.ceil((s.length - cjk) / 4);
	}

	/**
	 * 读取路径：key 匹配 + 关键词 → top-k，总 token ≤ 400。
	 * @returns {Array<MemoryFact>} 已排序、已裁剪
	 */
	async function retrieve(query, opts) {
		opts = opts || {};
		const facts = await all();
		if (!facts.length) return [];

		const topK = opts.topK || S.LIMITS.memoryTopK;
		const budget = opts.tokenBudget || S.LIMITS.memoryTokenBudget;
		const queryTokens = new Set(PaperLoom.Retriever.tokenize(query));
		const paperId = opts.paperId;

		const scored = facts.map((fact) => {
			let s = fact.confidence || 0.5;

			// 偏好类记忆总是相关（它决定回答风格）
			if (/^style\./.test(fact.key)) s += 1.2;
			// 当前论文的熟悉度直接命中
			if (paperId && fact.key === "familiarity." + paperId) s += 2.0;
			else if (/^familiarity\./.test(fact.key)) s += 0.1;
			// 关键词与 key/value 的交集
			const bag = PaperLoom.Retriever.tokenize(fact.key.replace(/[.*]/g, " ") + " " + fact.value);
			for (const t of bag) {
				if (queryTokens.has(t)) s += 0.5;
			}
			// 用户亲手确认的优先
			if (fact.origin === "explicit") s += 0.4;

			return { fact: fact, score: s };
		});

		scored.sort((a, b) => b.score - a.score);

		const picked = [];
		let tokens = 0;
		for (const item of scored) {
			if (picked.length >= topK) break;
			const cost = approxTokens(renderFactLine(item.fact));
			if (tokens + cost > budget) continue;
			tokens += cost;
			picked.push(item.fact);
		}
		return picked;
	}

	function renderFactLine(fact) {
		return "- " + fact.key + " = " + fact.value
			+ " (confidence " + Number(fact.confidence).toFixed(2) + ", " + fact.origin + ")";
	}

	/** 渲染进 system prompt 的 <memory> 区块 */
	function renderBlock(facts) {
		if (!facts || !facts.length) return "";
		return "<memory>\n" + facts.map(renderFactLine).join("\n") + "\n</memory>";
	}

	/**
	 * 推断路径：从最近若干轮对话抽取 MemoryFact（异步、不阻塞回答）。
	 * memory_delta 也可以由主回答的 JSON 直接给出，这里是兜底的独立抽取器。
	 */
	async function inferFromTurns(turns) {
		if (!turns || !turns.length) return [];
		if (!PaperLoom.LLM.isConfigured()) return [];

		const transcript = turns.slice(-6).map(t =>
			"用户: " + t.query + "\n助手: " + String(t.answer || "").slice(0, 400)
		).join("\n---\n");

		const system = "你是一个用户画像抽取器。从对话中抽取关于【用户本人】的稳定偏好或状态，"
			+ "不要抽取论文内容。只输出 JSON。\n"
			+ "可用 key（* 表示可替换为具体标识）：\n" + KNOWN_KEYS.join("\n") + "\n"
			+ '输出格式：{"facts":[{"key":"style.length","value":"short","confidence":0.6,'
			+ '"evidence":{"type":"inferred","text":"用户说讲简单点"}}]}\n'
			+ "没有可抽取的内容就返回 {\"facts\":[]}。confidence 为 0~1，拿不准就给低分。";

		let parsed;
		try {
			parsed = await PaperLoom.LLM.completeJSON({
				model: "extract",
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: transcript }
				]
			});
		}
		catch (e) {
			try { Zotero.debug("[PaperLoom:Memory] 推断失败: " + e); } catch (e2) { /* ignore */ }
			return [];
		}

		const results = [];
		for (const raw of (parsed && parsed.facts) || []) {
			if (!raw || !raw.key) continue;
			const ev = raw.evidence
				? [Object.assign({ type: "inferred", turnId: turns[turns.length - 1].turnId }, raw.evidence)]
				: [{ type: "inferred", text: "由对话推断", turnId: turns[turns.length - 1].turnId }];
			const r = await upsert({
				key: String(raw.key),
				value: raw.value,
				confidence: S.clampConfidence(raw.confidence, 0.55),
				origin: "inferred",
				evidence: ev
			});
			if (r.fact && r.action !== "rejected-invalid" && r.action !== "rejected-locked") {
				results.push({ action: r.action, fact: r.fact });
			}
		}
		return results;
	}

	/** 应用主回答返回的 memory_delta */
	async function applyDelta(delta, turnId) {
		const applied = [];
		for (const raw of (delta && delta.facts) || []) {
			if (!raw || !raw.key) continue;
			const explicit = raw.origin === "explicit";
			const r = await upsert({
				key: String(raw.key),
				value: raw.value,
				confidence: S.clampConfidence(raw.confidence, explicit ? 1.0 : 0.6),
				origin: explicit ? "explicit" : "inferred",
				evidence: [{
					type: explicit ? "explicit" : "inferred",
					text: raw.reason || raw.text || "由本轮对话得出",
					turnId: turnId || null
				}]
			});
			applied.push(r);
		}
		return applied;
	}

	return {
		KNOWN_KEYS, load, save, all, upsert, setExplicit, remove,
		recordBehavior, retrieve, renderBlock, renderFactLine,
		inferFromTurns, applyDelta, approxTokens
	};
})();
