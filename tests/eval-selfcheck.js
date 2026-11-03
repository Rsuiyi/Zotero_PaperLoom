/* 评测集与评分器自检（Node，不需要 Zotero）
 * 验证：queries.json 结构合法、四类齐全、评分逻辑对构造数据给出正确判定。
 * 运行：node tests/eval-selfcheck.js
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function check(name, cond, extra) {
	if (cond) { pass++; console.log("  ✓ " + name); }
	else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function section(t) { console.log("\n" + t); }

const specPath = path.join(__dirname, "..", "eval", "queries.json");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));

section("1. 评测集结构");
{
	const qs = spec.queries || [];
	check("题目数量在 20~30 条区间", qs.length >= 20 && qs.length <= 30, "实际 " + qs.length);

	const cats = {};
	for (const q of qs) cats[q.category] = (cats[q.category] || 0) + 1;
	check("四类齐全", ["single_fact", "cross_paper", "concept", "preference"]
		.every(c => cats[c] > 0), JSON.stringify(cats));
	check("每类至少 5 条", Object.values(cats).every(n => n >= 5), JSON.stringify(cats));

	check("id 唯一", new Set(qs.map(q => q.id)).size === qs.length);
	check("每题有 query", qs.every(q => q.query && q.query.trim()));
	check("每题有 rubric（人工判定依据）", qs.every(q => q.rubric && q.rubric.trim()));
	check("每题的 paper 别名在 papers 中有定义",
		qs.every(q => !q.paper || spec.papers[q.paper]),
		qs.filter(q => q.paper && !spec.papers[q.paper]).map(q => q.id).join(","));
	check("refs 里的别名也有定义",
		qs.every(q => (q.refs || []).every(r => spec.papers[r])));

	const intents = new Set(["single_fact", "cross_paper", "concept", "meta"]);
	check("expectIntent 取值合法",
		qs.every(q => !q.expectIntent || intents.has(q.expectIntent)),
		qs.filter(q => q.expectIntent && !intents.has(q.expectIntent)).map(q => q.id).join(","));

	check("含抗幻觉陷阱题", qs.filter(q => q.expectRefusal).length >= 2,
		String(qs.filter(q => q.expectRefusal).length));
	check("含 A/B 对照题", qs.some(q => q.abBaseline === true));
	check("含记忆写入检查题", qs.some(q => (q.expectMemoryWrite || []).length));
	check("跨篇题带 expectMinPapers",
		qs.filter(q => q.category === "cross_paper")
			.every(q => typeof q.expectMinPapers === "number"));
}

section("2. 评分器逻辑（用构造数据）");
{
	// 复刻 run.js 里的 scoreOne / rate / avg，确保判定口径一致
	const src = fs.readFileSync(path.join(__dirname, "..", "eval", "run.js"), "utf8");
	check("run.js 含 dryRun 调用（不污染真实数据）", /dryRun:\s*true/.test(src));
	check("run.js 做 A/B 双跑", /noMemory:\s*true/.test(src) && /memoryOverride/.test(src));
	check("run.js 输出 markdown 表格", /renderMarkdown/.test(src));
	check("run.js 统计引用有效率", /citationValidRate/.test(src));
	check("run.js 统计抗幻觉", /refusedProperly/.test(src));

	// 把 scoreOne 抠出来单独验证
	const m = src.match(/function scoreOne\(q, runs\) \{[\s\S]*?\n\t\treturn m;\n\t\}/);
	check("能提取 scoreOne 函数体", !!m);
	if (m) {
		const scoreOne = new Function("q", "runs", m[0].replace(/^\s*function scoreOne\(q, runs\) \{/, "").replace(/\}\s*$/, ""));

		// 用例 A：意图正确 + 引用全有效 + 跨篇达标
		let r = scoreOne(
			{ expectIntent: "cross_paper", expectCitation: true, expectMinPapers: 2 },
			{ main: {
				answer: "甲和乙的结论不同。", intent: "cross_paper", elapsedMs: 1200,
				memoryUsedCount: 2, memoryUsedKeys: ["style.length"], warnings: [],
				citations: [
					{ paperId: "A", page: 3, valid: true },
					{ paperId: "B", page: 5, valid: true }
				]
			} }
		);
		check("意图正确被判定为 true", r.intentCorrect === true);
		check("引用有效率 = 1", r.citationValidRate === 1);
		check("跨篇达标（2 篇）", r.crossPaperOk === true && r.distinctPapers === 2);

		// 用例 B：有一条引用定位失败
		r = scoreOne(
			{ expectIntent: "single_fact", expectCitation: true },
			{ main: {
				answer: "x", intent: "single_fact", elapsedMs: 900,
				memoryUsedCount: 0, memoryUsedKeys: [], warnings: [],
				citations: [
					{ paperId: "A", page: 3, valid: true },
					{ paperId: "A", page: null, valid: false }
				]
			} }
		);
		check("引用有效率 = 0.5", r.citationValidRate === 0.5, String(r.citationValidRate));

		// 用例 C：跨篇题只引了一篇 → 不达标
		r = scoreOne(
			{ expectIntent: "cross_paper", expectMinPapers: 2 },
			{ main: {
				answer: "只有一篇相关。", intent: "cross_paper", elapsedMs: 800,
				memoryUsedCount: 0, memoryUsedKeys: [], warnings: [],
				citations: [{ paperId: "A", page: 1, valid: true }]
			} }
		);
		check("跨篇只引一篇被判不达标", r.crossPaperOk === false);

		// 用例 D：抗幻觉陷阱题正确拒答
		r = scoreOne(
			{ expectRefusal: true },
			{ main: {
				answer: "提供的材料里没有涉及量子退火求解器。", intent: "single_fact",
				elapsedMs: 700, memoryUsedCount: 0, memoryUsedKeys: [], warnings: [],
				citations: []
			} }
		);
		check("正确拒答被识别", r.refusedProperly === true);

		// 用例 E：陷阱题编造了答案
		r = scoreOne(
			{ expectRefusal: true },
			{ main: {
				answer: "他们用的是 D-Wave Advantage 系统。", intent: "single_fact",
				elapsedMs: 700, memoryUsedCount: 0, memoryUsedKeys: [], warnings: [],
				citations: [{ paperId: "A", page: 9, valid: true }]
			} }
		);
		check("★ 编造答案被判定为未拒答", r.refusedProperly === false);

		// 用例 F：A/B 对照，带记忆后明显变短
		r = scoreOne(
			{ expectIntent: "single_fact", abBaseline: true },
			{
				withoutMemory: {
					answer: "x".repeat(1000), answerLength: 1000, intent: "single_fact",
					elapsedMs: 2000, memoryUsedCount: 0, memoryUsedKeys: [], warnings: [], citations: []
				},
				withMemory: {
					answer: "y".repeat(300), answerLength: 300, intent: "single_fact",
					elapsedMs: 1500, memoryUsedCount: 1, memoryUsedKeys: ["style.length"],
					warnings: [], citations: []
				}
			}
		);
		check("A/B 缩短比例算对", r.lengthReduction === 0.7, String(r.lengthReduction));
		check("★ 记忆生效被判定为 true", r.memoryEffective === true);

		// 用例 G：A/B 对照，带记忆后没变短 → 记忆未生效
		r = scoreOne(
			{ abBaseline: true },
			{
				withoutMemory: { answer: "x".repeat(1000), answerLength: 1000, intent: "single_fact",
					elapsedMs: 1, memoryUsedCount: 0, memoryUsedKeys: [], warnings: [], citations: [] },
				withMemory: { answer: "y".repeat(980), answerLength: 980, intent: "single_fact",
					elapsedMs: 1, memoryUsedCount: 1, memoryUsedKeys: [], warnings: [], citations: [] }
			}
		);
		check("★ 记忆未生效能被如实判定", r.memoryEffective === false,
			String(r.memoryEffective) + " / 缩短 " + r.lengthReduction);
	}
}

section("3. pipeline 评测开关");
{
	const p = fs.readFileSync(path.join(__dirname, "..", "paperloom",
		"content", "scripts", "pipeline.js"), "utf8");
	check("支持 opts.dryRun", /opts\.dryRun/.test(p));
	check("dryRun 下不写图谱", /&& !opts\.dryRun\) \{[\s\S]{0,200}applyGraphDelta/.test(p)
		|| /!opts\.dryRun[\s\S]{0,300}applyGraphDelta/.test(p));
	check("dryRun 下不写记忆", /memory_delta && !opts\.dryRun/.test(p));
	check("dryRun 下不写对话历史", /if \(!opts\.dryRun\) await saveTurn/.test(p));
	check("支持 opts.noMemory", /opts\.noMemory/.test(p));
	check("支持 opts.memoryOverride", /opts\.memoryOverride/.test(p));
	check("返回 evidencePaperCount 供跨篇统计", /evidencePaperCount/.test(p));
	check("dryRun 返回 proposedDelta 供检查", /proposedDelta/.test(p));
}

section("4. UI 层 review 修补（静态检查）");
{
	const chat = fs.readFileSync(path.join(__dirname, "..", "paperloom", "content", "chat.js"), "utf8");
	const mem = fs.readFileSync(path.join(__dirname, "..", "paperloom", "content", "memory.js"), "utf8");

	check("对话面板接了行为记忆写入路径", /recordBehavior\(/.test(chat));
	check("行为信号带 turnId", /turnId:\s*result\.turn/.test(chat));
	check("答案渲染支持 markdown 块级", /renderInline/.test(chat) && /pl-md-list/.test(chat));
	check("markdown 用 DOM 构造而非 innerHTML",
		!/innerHTML\s*=\s*[^"']*answer/i.test(chat));
	check("行内渲染覆盖 粗体/代码/引用",
		chat.includes("`([^`]+)`") && chat.includes("m[3] !== undefined") && chat.includes("m[4] !== undefined"));
	check("记忆面板按层分组", /LAYERS/.test(mem) && /layerOf/.test(mem));
	check("记忆分层覆盖四个命名空间",
		["style", "familiarity", "interest", "background"].every(k => mem.includes('"' + k + '"')));

	const css = fs.readFileSync(path.join(__dirname, "..", "paperloom",
		"content", "styles", "paperloom.css"), "utf8");
	check("分层标题有样式", /\.pl-layer-head/.test(css));
	check("助手消息不再整体 pre-wrap（避免与块级冲突）",
		/\.pl-msg\.pl-user,\s*\n\.pl-msg\.pl-error \{\s*\n\twhite-space: pre-wrap;/.test(css));

	const xhtml = fs.readFileSync(path.join(__dirname, "..", "paperloom",
		"content", "memory.xhtml"), "utf8");
	check("记忆容器交由 JS 分组渲染", /id="pl-mem-list"><\/div>/.test(xhtml));
}

console.log("\n" + "=".repeat(50));
console.log("通过 " + pass + " 项，失败 " + fail + " 项");
console.log("=".repeat(50));
process.exit(fail ? 1 : 0);
