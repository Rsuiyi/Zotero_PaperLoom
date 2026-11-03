/* PaperLoom 分层逻辑自检（Node，纯逻辑，不依赖 Zotero/浏览器）
 * 运行：node tests/topic-layer-selfcheck.js
 * 把 schema.js + graphStore.js 作为全局 IIFE 载入，mock Storage 为内存 JSON。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "paperloom", "content", "scripts");
const sandbox = { console };
sandbox.global = sandbox;
vm.createContext(sandbox);

// 内存 Storage mock
let MEM = {};
vm.runInContext(`
var PaperLoom = {};
PaperLoom.Storage = {
  readJSON: async function (f, dflt) { return (f in __MEM__) ? JSON.parse(JSON.stringify(__MEM__[f])) : dflt; },
  writeJSON: async function (f, o) { __MEM__[f] = JSON.parse(JSON.stringify(o)); }
};
`, sandbox);
sandbox.__MEM__ = MEM;

// 载入 schema + graphStore
for (const f of ["schema.js", "graphStore.js"]) {
  const code = fs.readFileSync(path.join(ROOT, f), "utf8");
  vm.runInContext(code, sandbox, { filename: f });
}

const GS = sandbox.PaperLoom.GraphStore;
const S = sandbox.PaperLoom.Schema;

function ev(paperId, quote) { return { paperId, chunkId: paperId + "-c001", page: 1, quote }; }

(async function main() {
  const checks = [];
  const ok = (name, cond) => checks.push({ name, pass: !!cond });

  // 构造：两个主题簇
  // 簇1 NLP: Transformer - 多头注意力 - BERT（supports/relates 边相连）
  // 簇2 RAG: GraphRAG - KnowledgeGraph - Retrieval（相连），两簇间无边
  await GS.applyGraphDelta({
    nodes: [
      { type: "paper", paperId: "AAAA1111", label: "Attention Paper" },
      { type: "paper", paperId: "BBBB2222", label: "BERT Paper" },
      { type: "paper", paperId: "CCCC3333", label: "GraphRAG Paper" },
      { type: "concept", label: "Transformer", paperIds: ["AAAA1111", "BBBB2222"] },
      { type: "concept", label: "多头注意力", paperIds: ["AAAA1111"] },
      { type: "concept", label: "双向预训练", paperIds: ["BBBB2222"] },
      { type: "concept", label: "图增强检索", paperIds: ["CCCC3333"] },
      { type: "concept", label: "知识图谱", paperIds: ["CCCC3333"] },
      { type: "concept", label: "稠密检索", paperIds: ["CCCC3333"] }
    ],
    edges: [
      { sourceLabel: "Transformer", targetLabel: "多头注意力", type: "relates", evidence: ev("AAAA1111", "transformer uses multi-head attention") },
      { sourceLabel: "双向预训练", targetLabel: "Transformer", type: "supports", evidence: ev("BBBB2222", "bidirectional pretraining is based on transformer") },
      { sourceLabel: "图增强检索", targetLabel: "知识图谱", type: "relates", evidence: ev("CCCC3333", "graphrag uses kg") },
      { sourceLabel: "图增强检索", targetLabel: "稠密检索", type: "relates", evidence: ev("CCCC3333", "graphrag does retrieval") }
    ]
  });

  let g = await GS.load();
  ok("建图：6 概念 + 3 论文", g.nodes.filter(n => n.type === "concept").length === 6 && g.nodes.filter(n => n.type === "paper").length === 3);

  // 跑分层
  const diff = await GS.rebuildTopics();
  g = await GS.load();
  const topics = g.nodes.filter(n => n.type === "topic");
  ok("分层：生成 2 个主题（两连通分量）", topics.length === 2);

  // 每个 concept 恰好一条 belongs_to（单属）
  const concepts = g.nodes.filter(n => n.type === "concept");
  const belongs = g.edges.filter(e => e.type === "belongs_to");
  const perConcept = concepts.every(c => belongs.filter(e => e.source === c.nodeId).length === 1);
  ok("单属：每个概念恰好 1 条 belongs_to", perConcept && belongs.length === concepts.length);

  // 同簇概念 topicId 相同，跨簇不同
  const tid = (label) => concepts.find(c => c.label === label).topicId;
  ok("同簇 Transformer/双向预训练 同主题", tid("Transformer") === tid("双向预训练"));
  ok("跨簇 Transformer/图增强检索 不同主题", tid("Transformer") !== tid("图增强检索"));

  // belongs_to 无 evidence 也能进图（结构边放行）
  ok("belongs_to 结构边无证据可进图", belongs.length > 0 && belongs.every(e => !e.evidence));

  // 论断边证据约束未被破坏：构造一条无证据的 relates 应被拒
  const d2 = await GS.applyGraphDelta({
    nodes: [], edges: [{ sourceLabel: "Transformer", targetLabel: "双向预训练", type: "relates" }]
  });
  ok("论断边无证据仍被拒（证据约束未破坏）", d2.rejected.length >= 1);

  // pinned 保护：手动把 双向预训练 归到 图增强检索 主题并 pin，再重建不应改回
  const graphRagTopic = tid("图增强检索");
  await GS.assignConceptTopic(concepts.find(c => c.label === "双向预训练").nodeId, graphRagTopic);
  await GS.rebuildTopics();
  g = await GS.load();
  const bert = g.nodes.find(n => n.label === "双向预训练");
  ok("pinned：手动归属重建后保留", bert.topicId === graphRagTopic && bert.pinned === true);

  // 800 上限：topic 不计入、不被剪（构造 >800 概念）
  const many = [];
  for (let i = 0; i < 810; i++) many.push({ type: "concept", label: "C" + i, paperIds: ["ZZZZ9999"] });
  await GS.applyGraphDelta({ nodes: many, edges: [] });
  await GS.rebuildTopics();
  g = await GS.load();
  ok("800 上限：非 topic 概念被剪到上限内", g.nodes.filter(n => n.type !== "topic").length <= S.LIMITS.maxNodesPerLibrary);
  ok("800 上限：topic 节点未被误剪", g.nodes.filter(n => n.type === "topic").length > 0);

  // 报告
  console.log("\n=== PaperLoom 分层自检 ===");
  let all = true;
  for (const c of checks) { console.log((c.pass ? "[PASS] " : "[FAIL] ") + c.name); if (!c.pass) all = false; }
  console.log("\n" + (all ? "全部通过" : "存在失败"));
  process.exit(all ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
