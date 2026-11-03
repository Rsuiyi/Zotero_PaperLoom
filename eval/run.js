/* PaperLoom 评测脚本 —— 一条命令跑完输出表格
 *
 * 运行方式（必须在 Zotero 内，因为要访问真实文献库）：
 *   Zotero → 工具 → 开发者 → Run JavaScript
 *   勾选 "Run as async function"，粘贴以下两行：
 *
 *     const { runEval } = ChromeUtils.import("resource://gre/modules/Services.jsm") && {};
 *     Services.scriptloader.loadSubScript("file:///E:/阅读实践周/Zotero_PaperLoom/eval/run.js", this);
 *     return await runEval({ apiKey: null });   // apiKey 留空则用设置里已填的
 *
 * 产出：
 *   - 控制台表格（直接截图贴 PPT）
 *   - eval/results/<时间戳>.json  原始结果
 *   - eval/results/<时间戳>.md    markdown 表格
 *
 * 评测遵守两条原则：
 *   1. dryRun —— 全程不写真实图谱/记忆，跑完库是干净的；
 *   2. A/B 对照 —— 偏好类问题分「带记忆 / 不带记忆」两组跑，否则"记忆有用"是空话。
 */

async function runEval(options) {
	options = options || {};

	const PL = Zotero.PaperLoom;
	if (!PL) throw new Error("PaperLoom 未加载，请先确认插件已启用并重启 Zotero。");
	if (!PL.LLM.isConfigured() && !options.apiKey) {
		throw new Error("未配置 API Key：设置 → PaperLoom，或给 runEval({apiKey:'sk-...'}) 传入。");
	}

	const EVAL_DIR = options.evalDir || PathUtils.join(
		PathUtils.parent(PathUtils.parent(PL.rootURI.replace(/^file:\/\/\//, "").replace(/\/$/, ""))),
		"eval"
	);
	const specPath = options.specPath || PathUtils.join(EVAL_DIR, "queries.json");

	log("读取评测集: " + specPath);
	const spec = await IOUtils.readJSON(specPath);

	// ---- 解析 paperId 占位符
	const paperMap = Object.create(null);
	for (const [alias, info] of Object.entries(spec.papers || {})) {
		if (/^REPLACE_KEY/.test(info.paperId)) {
			throw new Error("eval/queries.json 里的 " + alias + " 还是占位符 "
				+ info.paperId + "，请替换为真实条目 key（见文件里的 _howto）。");
		}
		const id = await Zotero.Items.getIDFromLibraryAndKey(
			Zotero.Libraries.userLibraryID, info.paperId);
		if (!id) throw new Error("找不到条目 " + info.paperId + "（别名 " + alias + "）");
		paperMap[alias] = await Zotero.Items.getAsync(id);
	}
	log("已解析 " + Object.keys(paperMap).length + " 篇论文");

	// ---- 逐条跑
	const results = [];
	const queries = spec.queries || [];

	for (let i = 0; i < queries.length; i++) {
		const q = queries[i];
		log("[" + (i + 1) + "/" + queries.length + "] " + q.id + " " + q.query.slice(0, 30));

		const item = paperMap[q.paper] || null;
		const refs = (q.refs || []).map(a => paperMap[a]).filter(Boolean);

		const base = {
			id: q.id, category: q.category, query: q.query,
			paper: q.paper, rubric: q.rubric
		};

		// A 组：不带记忆（基线）
		// B 组：带记忆（虚拟注入，不写真实记忆库）
		const needsAB = q.abBaseline === true;

		try {
			const runs = {};

			if (needsAB) {
				runs.withoutMemory = await askOnce(q, item, refs, { noMemory: true });
				runs.withMemory = await askOnce(q, item, refs, { memoryOverride: buildMemory(q) });
			}
			else {
				runs.main = await askOnce(q, item, refs,
					q.memory ? { memoryOverride: buildMemory(q) } : {});
			}

			results.push(Object.assign(base, { ok: true, runs: runs, metrics: scoreOne(q, runs) }));
		}
		catch (e) {
			log("  ✗ 失败: " + e);
			results.push(Object.assign(base, { ok: false, error: String(e && e.message || e) }));
		}
	}

	// ---- 汇总与落盘
	const summary = aggregate(spec, results);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const outDir = PathUtils.join(EVAL_DIR, "results");
	await IOUtils.makeDirectory(outDir, { ignoreExisting: true, createAncestors: true });

	const jsonPath = PathUtils.join(outDir, stamp + ".json");
	const mdPath = PathUtils.join(outDir, stamp + ".md");
	await IOUtils.writeJSON(jsonPath, { spec: specPath, at: stamp, summary, results });
	await IOUtils.writeUTF8(mdPath, renderMarkdown(summary, results, stamp));

	printTable(summary, results);
	log("\n结果已写入:\n  " + jsonPath + "\n  " + mdPath);

	return { summary, results, jsonPath, mdPath };

	// ================================================================ 内部

	function log(msg) {
		Zotero.debug("[PaperLoom:eval] " + msg);
		if (typeof console !== "undefined") console.log("[eval] " + msg);
	}

	function buildMemory(q) {
		return (q.memory || []).map(m => PL.Schema.makeMemoryFact(m));
	}

	async function askOnce(q, item, refs, extra) {
		const t0 = Date.now();
		const r = await PL.Pipeline.ask(Object.assign({
			query: q.query,
			item: item,
			referencedItems: refs,
			dryRun: true          // ★ 全程不写真实数据
		}, extra));
		return {
			answer: r.answer,
			answerLength: (r.answer || "").length,
			intent: r.intent,
			citations: (r.citations || []).map(c => ({
				paperId: c.paperId, page: c.page, valid: c.valid
			})),
			evidencePaperCount: r.evidencePaperCount || 0,
			memoryUsedCount: (r.memoryUsed || []).length,
			memoryUsedKeys: (r.memoryUsed || []).map(f => f.key),
			proposedEdges: ((r.proposedDelta || {}).edges || []).length,
			warnings: r.warnings || [],
			elapsedMs: Date.now() - t0
		};
	}

	/** 单题打分：全部是可自动判定的客观项，主观项留给人工填 rubric 列 */
	function scoreOne(q, runs) {
		const main = runs.main || runs.withMemory;
		const m = {};

		// 1 意图判定正确率
		if (q.expectIntent) {
			m.intentCorrect = main.intent === q.expectIntent;
		}

		// 2 引用有效率：citations 里能定位到页码的比例
		const cites = main.citations || [];
		m.citationCount = cites.length;
		m.citationValidRate = cites.length
			? cites.filter(c => c.valid).length / cites.length
			: null;

		// 3 有引用该有引用的题
		if (q.expectCitation) {
			m.hasCitation = cites.length > 0;
		}

		// 4 跨篇覆盖：是否真的引了 ≥N 篇
		if (typeof q.expectMinPapers === "number" && q.expectMinPapers > 0) {
			const distinct = new Set(cites.filter(c => c.valid).map(c => c.paperId)).size;
			m.distinctPapers = distinct;
			m.crossPaperOk = distinct >= q.expectMinPapers;
		}

		// 5 抗幻觉 / 不硬凑：陷阱题应出现"没有涉及/只有一篇"这类说明
		if (q.expectRefusal) {
			const text = String(main.answer || "");
			m.refusedProperly = /没有涉及|未提及|没有相关|未找到|只有一篇|材料里没有|无法确定|not mentioned|no relevant/i.test(text)
				|| main.warnings.some(w => /只有|没有/.test(w));
		}

		// 6 记忆遵循（A/B 对照）
		if (runs.withMemory && runs.withoutMemory) {
			const a = runs.withoutMemory.answerLength;
			const b = runs.withMemory.answerLength;
			m.lengthWithoutMemory = a;
			m.lengthWithMemory = b;
			m.lengthReduction = a ? Number(((a - b) / a).toFixed(3)) : null;
			m.memoryEffective = a > 0 && b < a * 0.75;   // 短 25% 以上算生效
		}

		// 7 记忆被用上了没
		m.memoryUsedCount = main.memoryUsedCount;
		m.memoryUsedKeys = main.memoryUsedKeys;

		// 8 延迟
		m.elapsedMs = main.elapsedMs;

		return m;
	}

	function aggregate(spec, results) {
		const ok = results.filter(r => r.ok);
		const byCat = Object.create(null);

		for (const r of ok) {
			const c = (byCat[r.category] = byCat[r.category] || {
				total: 0, intentCorrect: 0, intentTotal: 0,
				citeValidSum: 0, citeValidN: 0,
				hasCite: 0, hasCiteTotal: 0,
				crossOk: 0, crossTotal: 0,
				refusedOk: 0, refusedTotal: 0,
				elapsedSum: 0
			});
			const m = r.metrics;
			c.total++;
			c.elapsedSum += m.elapsedMs || 0;
			if (typeof m.intentCorrect === "boolean") { c.intentTotal++; if (m.intentCorrect) c.intentCorrect++; }
			if (m.citationValidRate !== null && m.citationValidRate !== undefined) {
				c.citeValidSum += m.citationValidRate; c.citeValidN++;
			}
			if (typeof m.hasCitation === "boolean") { c.hasCiteTotal++; if (m.hasCitation) c.hasCite++; }
			if (typeof m.crossPaperOk === "boolean") { c.crossTotal++; if (m.crossPaperOk) c.crossOk++; }
			if (typeof m.refusedProperly === "boolean") { c.refusedTotal++; if (m.refusedProperly) c.refusedOk++; }
		}

		const ab = ok.filter(r => r.metrics.memoryEffective !== undefined);

		return {
			totalQueries: results.length,
			succeeded: ok.length,
			failed: results.length - ok.length,
			byCategory: byCat,
			memoryAB: {
				samples: ab.length,
				effective: ab.filter(r => r.metrics.memoryEffective).length,
				avgLengthReduction: ab.length
					? Number((ab.reduce((s, r) => s + (r.metrics.lengthReduction || 0), 0) / ab.length).toFixed(3))
					: null
			},
			overall: {
				intentAccuracy: rate(ok, r => r.metrics.intentCorrect),
				citationValidRate: avg(ok.map(r => r.metrics.citationValidRate).filter(v => v != null)),
				antiHallucination: rate(ok, r => r.metrics.refusedProperly),
				avgElapsedMs: Math.round(avg(ok.map(r => r.metrics.elapsedMs || 0)) || 0)
			}
		};
	}

	function rate(list, pick) {
		const vals = list.map(pick).filter(v => typeof v === "boolean");
		if (!vals.length) return null;
		return Number((vals.filter(Boolean).length / vals.length).toFixed(3));
	}

	function avg(nums) {
		if (!nums.length) return null;
		return nums.reduce((a, b) => a + b, 0) / nums.length;
	}

	function pct(v) {
		return v == null ? "—" : (v * 100).toFixed(1) + "%";
	}

	function printTable(summary, results) {
		const rows = [];
		for (const [cat, c] of Object.entries(summary.byCategory)) {
			rows.push({
				"类别": cat,
				"题数": c.total,
				"意图正确": c.intentTotal ? pct(c.intentCorrect / c.intentTotal) : "—",
				"引用有效": c.citeValidN ? pct(c.citeValidSum / c.citeValidN) : "—",
				"该引有引": c.hasCiteTotal ? pct(c.hasCite / c.hasCiteTotal) : "—",
				"跨篇达标": c.crossTotal ? pct(c.crossOk / c.crossTotal) : "—",
				"抗幻觉": c.refusedTotal ? pct(c.refusedOk / c.refusedTotal) : "—",
				"均耗时": Math.round(c.elapsedSum / c.total) + "ms"
			});
		}
		if (typeof console !== "undefined" && console.table) console.table(rows);
		else log(JSON.stringify(rows, null, 2));

		log("\n记忆 A/B 对照：" + summary.memoryAB.effective + "/" + summary.memoryAB.samples
			+ " 条生效，平均答案缩短 " + pct(summary.memoryAB.avgLengthReduction));
	}

	function renderMarkdown(summary, results, stamp) {
		const L = [];
		L.push("# PaperLoom 评测结果");
		L.push("");
		L.push("- 时间：" + stamp);
		L.push("- 题目：" + summary.totalQueries + " 条（成功 " + summary.succeeded
			+ "，失败 " + summary.failed + "）");
		L.push("- 模型：对话 `" + PL.LLM.config().chatModel + "` / 抽取 `"
			+ PL.LLM.config().extractModel + "`");
		L.push("- 全程 `dryRun`，未写入真实图谱与记忆");
		L.push("");

		L.push("## 分类汇总");
		L.push("");
		L.push("| 类别 | 题数 | 意图正确 | 引用有效 | 该引有引 | 跨篇达标 | 抗幻觉 | 均耗时 |");
		L.push("|---|---|---|---|---|---|---|---|");
		for (const [cat, c] of Object.entries(summary.byCategory)) {
			L.push("| " + cat + " | " + c.total
				+ " | " + (c.intentTotal ? pct(c.intentCorrect / c.intentTotal) : "—")
				+ " | " + (c.citeValidN ? pct(c.citeValidSum / c.citeValidN) : "—")
				+ " | " + (c.hasCiteTotal ? pct(c.hasCite / c.hasCiteTotal) : "—")
				+ " | " + (c.crossTotal ? pct(c.crossOk / c.crossTotal) : "—")
				+ " | " + (c.refusedTotal ? pct(c.refusedOk / c.refusedTotal) : "—")
				+ " | " + Math.round(c.elapsedSum / c.total) + "ms |");
		}
		L.push("");

		L.push("## ★ 记忆有用吗（A/B 对照）");
		L.push("");
		L.push("| 指标 | 值 |");
		L.push("|---|---|");
		L.push("| 对照样本 | " + summary.memoryAB.samples + " |");
		L.push("| 记忆生效（答案缩短 >25%） | " + summary.memoryAB.effective + " |");
		L.push("| 平均答案缩短 | " + pct(summary.memoryAB.avgLengthReduction) + " |");
		L.push("");

		const abRows = results.filter(r => r.ok && r.metrics.lengthWithMemory !== undefined);
		if (abRows.length) {
			L.push("| 题号 | 无记忆字数 | 带记忆字数 | 缩短 |");
			L.push("|---|---|---|---|");
			for (const r of abRows) {
				L.push("| " + r.id + " | " + r.metrics.lengthWithoutMemory
					+ " | " + r.metrics.lengthWithMemory
					+ " | " + pct(r.metrics.lengthReduction) + " |");
			}
			L.push("");
		}

		L.push("## 逐题明细");
		L.push("");
		L.push("| 题号 | 类别 | 意图 | 引用数 | 有效率 | 涉及论文 | 用了记忆 | 人工判定 |");
		L.push("|---|---|---|---|---|---|---|---|");
		for (const r of results) {
			if (!r.ok) {
				L.push("| " + r.id + " | " + r.category + " | 失败 | — | — | — | — | " + r.error + " |");
				continue;
			}
			const m = r.metrics;
			L.push("| " + r.id + " | " + r.category
				+ " | " + (m.intentCorrect === false ? "✗ " : "") + (r.runs.main || r.runs.withMemory).intent
				+ " | " + m.citationCount
				+ " | " + pct(m.citationValidRate)
				+ " | " + (m.distinctPapers != null ? m.distinctPapers : "—")
				+ " | " + m.memoryUsedCount
				+ " |  |");
		}
		L.push("");
		L.push("> 「人工判定」列留空，按各题 rubric 人工填 ✓/✗。客观列已自动算出。");
		L.push("");

		L.push("## 各题 rubric（人工判定依据）");
		L.push("");
		for (const r of results) {
			L.push("- **" + r.id + "**（" + r.category + "）" + r.query);
			L.push("  - 判定标准：" + (r.rubric || "—"));
			if (r.ok) {
				const main = r.runs.main || r.runs.withMemory;
				L.push("  - 答案摘要：" + String(main.answer || "").replace(/\n/g, " ").slice(0, 160));
				if (main.warnings.length) L.push("  - 警告：" + main.warnings.join("；"));
			}
		}

		return L.join("\n");
	}
}

// 便于在 Run JavaScript 里直接取用
if (typeof globalThis !== "undefined") globalThis.runEval = runEval;
