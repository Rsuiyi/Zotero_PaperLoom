/* PaperLoom — graph.js
 * L3 表现层：知识图谱总页面。
 *
 * 自绘 canvas 力导向，不引入外部可视化库（依赖全部留在本工作区内）。
 * 布局策略按计划书：concept 层力导向，paper 层单独成环，避免纸节点把图撑散。
 * 核心交互：
 *   - 点击节点 → 右侧证据卡片（原文摘录 + 页码 + 跳转）
 *   - 「只显示跨论文概念」开关 → 图收敛成骨架
 */
(function () {
	"use strict";

	// 同 chat.js：标签页可能在插件启动前就被恢复，领域层要允许"稍后才出现"
	let Zotero = resolveZotero();
	let PL = (window.arguments && window.arguments[0] && window.arguments[0].PaperLoom)
		|| (Zotero && Zotero.PaperLoom);

	function resolveZotero() {
		const tries = [
			() => (window.arguments && window.arguments[0] && window.arguments[0].Zotero),
			() => window.Zotero,
			() => (window.top && window.top.Zotero),
			() => (window.parent && window.parent.Zotero),
			() => (window.opener && window.opener.Zotero)
		];
		for (const get of tries) {
			try {
				const z = get();
				if (z) return z;
			}
			catch (e) { /* 跨域时继续试下一条 */ }
		}
		return null;
	}

	async function waitForDomainLayer(maxMs) {
		const deadline = Date.now() + (maxMs || 20000);
		while (Date.now() < deadline) {
			Zotero = resolveZotero();
			PL = Zotero && Zotero.PaperLoom;
			if (PL) return true;
			await new Promise(r => setTimeout(r, 200));
		}
		return false;
	}

	const $ = (id) => document.getElementById(id);

	let canvas, ctx, wrap;
	let graph = { nodes: [], edges: [] };
	let view = { nodes: [], edges: [] };     // 过滤后的视图
	let sim = null;
	let camera = { x: 0, y: 0, scale: 1 };
	let selection = new Set();              // 多选集合（nodeId）
	let hover = null;
	let dragging = null;
	let panning = null;
	let box = null;                         // 框选矩形 {x0,y0,x1,y1}
	let multiSelectMode = false;            // 多选模式：不按修饰键也能连点多选

	const COLORS = {
		paper: "#2e7fe0",
		concept: "#c8792a",
		crossConcept: "#2d9c5a",
		claim: "#8a5cd6",
		edge: "rgba(130,130,140,0.45)",
		edgeHighlight: "#2e7fe0",
		contradicts: "#d0342c",
		supports: "#2d9c5a"
	};

	// 主题层调色板：按 topicId 稳定分配一种颜色，让同主题概念一眼成簇
	const TOPIC_PALETTE = ["#4A90E2", "#E67E22", "#2ECC71", "#9B59B6", "#E74C3C", "#1ABC9C", "#F39C12", "#34495E", "#16A085", "#D35400"];
	const _topicColorMap = Object.create(null);
	let _topicColorN = 0;
	function colorForTopic(topicId) {
		if (!topicId) return null;
		if (!(topicId in _topicColorMap)) { _topicColorMap[topicId] = TOPIC_PALETTE[_topicColorN % TOPIC_PALETTE.length]; _topicColorN++; }
		return _topicColorMap[topicId];
	}

	document.addEventListener("DOMContentLoaded", init);
	if (document.readyState !== "loading") init();

	let inited = false;
	async function init() {
		if (inited) return;
		inited = true;

		// 内嵌模式（对话面板下方的小图谱）：只留画布，工具栏与详情栏由 CSS 隐藏
		if (new URLSearchParams(location.search).get("embed") === "1") {
			document.body.classList.add("pl-embed");
		}

		canvas = $("pl-graph-canvas");
		wrap = $("pl-graph-canvas-wrap");
		ctx = canvas.getContext("2d");

		if (!PL) {
			$("pl-graph-hint").textContent = "PaperLoom 正在加载…";
			const ready = await waitForDomainLayer(20000);
			if (!ready) {
				$("pl-graph-hint").textContent = "PaperLoom 领域层尚未就绪，请关闭本页后重新打开。";
				return;
			}
			$("pl-graph-hint").textContent = "";
		}

		$("pl-cross-only").addEventListener("change", rebuildView);
		$("pl-show-papers").addEventListener("change", rebuildView);
		if ($("pl-topic-color")) $("pl-topic-color").addEventListener("change", () => draw());
		if ($("pl-graph-rebuild-topics")) $("pl-graph-rebuild-topics").addEventListener("click", rebuildTopicsAction);
		$("pl-graph-refresh").addEventListener("click", load);
		$("pl-graph-fit").addEventListener("click", () => { fit(); draw(); });
		$("pl-graph-add-node").addEventListener("click", addConcept);
		$("pl-graph-del").addEventListener("click", deleteSelection);

		// 多选模式：有些环境里 Shift 修饰键传不到 iframe，给一个不依赖修饰键的入口
		$("pl-graph-multi").addEventListener("click", () => {
			multiSelectMode = !multiSelectMode;
			$("pl-graph-multi").textContent = "多选：" + (multiSelectMode ? "开" : "关");
			$("pl-graph-multi").style.background = multiSelectMode ? "var(--pl-accent)" : "";
			$("pl-graph-multi").style.color = multiSelectMode ? "#fff" : "";
		});

		// 键盘删除：焦点可能停在外层窗口，所以 window 和 document 都捕获
		const onKeyDown = (ev) => {
			if (ev.key === "Delete" || ev.key === "Backspace") {
				if (selection.size) {
					ev.preventDefault();
					ev.stopPropagation();
					deleteSelection();
				}
			}
			else if (ev.key === "Escape") {
				selection = new Set();
				draw();
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("keydown", onKeyDown, true);

		// Zotero 的键盘事件有时落在顶层文档：补一层，但只在图谱 iframe 有焦点时响应
		try {
			window.top.document.addEventListener("keydown", (ev) => {
				if (!document.hasFocus()) return;
				onKeyDown(ev);
			}, true);
		}
		catch (e) { /* 跨域则忽略 */ }

		// 拖拽/框选可能移出画布：move/up 挂到 window 上
		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);

		canvas.addEventListener("mousedown", onMouseDown);
		canvas.addEventListener("mouseleave", onMouseUp);
		canvas.addEventListener("wheel", onWheel, { passive: false });
		canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

		window.addEventListener("resize", () => { resize(); draw(); });
		window.addEventListener("message", (ev) => {
			if (ev.data && ev.data.type === "paperloom:graph-updated") load();
		});

		resize();
		load();
	}

	function resize() {
		const dpr = window.devicePixelRatio || 1;
		const w = wrap.clientWidth || 800;
		const h = wrap.clientHeight || 600;
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
		canvas.style.width = w + "px";
		canvas.style.height = h + "px";
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	async function load() {
		try {
			graph = await PL.GraphStore.load();
			// 数据整体刷新后，旧的选中 id 可能已不存在
			selection = new Set();
			const stats = await PL.GraphStore.stats();
			$("pl-graph-stats").textContent =
				stats.papers + " 篇论文 · " + stats.concepts + " 个概念 · "
				+ stats.edges + " 条带证据的边 · 跨论文概念 " + stats.crossPaperConcepts + " 个";
			rebuildView();
		}
		catch (e) {
			$("pl-graph-hint").textContent = "读取图谱失败：" + e;
		}
	}

	/** 按开关过滤 + 重建布局 */
	function rebuildView() {
		const crossOnly = $("pl-cross-only").checked;
		const showPapers = $("pl-show-papers").checked;

		let nodes = graph.nodes.slice();

		if (crossOnly) {
			// ★ 只留真正连接多篇文献的概念（关联论文数 ≥ 2）
			nodes = nodes.filter(n => n.type === "concept" && (n.paperIds || []).length >= 2);
		}
		else if (!showPapers) {
			nodes = nodes.filter(n => n.type !== "paper");
		}

		const ids = new Set(nodes.map(n => n.nodeId));
		const edges = graph.edges.filter(e => ids.has(e.source) && ids.has(e.target));

		// 丢掉过滤后变成孤点的节点，让骨架更干净
		if (crossOnly) {
			const connected = new Set();
			for (const e of edges) { connected.add(e.source); connected.add(e.target); }
			if (connected.size) nodes = nodes.filter(n => connected.has(n.nodeId));
		}

		view = { nodes, edges };
		layout();
		$("pl-graph-hint").style.display = nodes.length ? "none" : "block";
		if (!nodes.length) {
			$("pl-graph-hint").textContent = crossOnly
				? "还没有跨论文概念。对 ≥2 篇论文执行「工具 → PaperLoom → 重建所选论文的图谱」。"
				: "图谱还是空的。选中论文后执行「工具 → PaperLoom → 重建所选论文的图谱」。";
			$("pl-graph-detail").innerHTML = "";
		}
		fit();
		startSim();
	}

	// ------------------------------------------------------------ 布局

	function layout() {
		const w = wrap.clientWidth || 800;
		const h = wrap.clientHeight || 600;
		const cx = w / 2, cy = h / 2;

		const papers = view.nodes.filter(n => n.type === "paper");
		const others = view.nodes.filter(n => n.type !== "paper");

		// paper 层单独成环，固定不参与力导向
		const ringR = Math.min(w, h) * 0.42;
		papers.forEach((n, i) => {
			const a = (i / Math.max(1, papers.length)) * Math.PI * 2 - Math.PI / 2;
			n._x = cx + Math.cos(a) * ringR;
			n._y = cy + Math.sin(a) * ringR;
			n._fixed = true;
			n._vx = n._vy = 0;
		});

		// concept 层：以关联论文的质心附近起步，收敛更快
		const paperById = Object.create(null);
		for (const p of papers) paperById[p.nodeId] = p;
		others.forEach((n, i) => {
			let sx = 0, sy = 0, c = 0;
			for (const pid of n.paperIds || []) {
				const p = paperById[PL.Schema.paperNodeId(pid)];
				if (p) { sx += p._x; sy += p._y; c++; }
			}
			if (c) {
				n._x = sx / c + (Math.random() - 0.5) * 80;
				n._y = sy / c + (Math.random() - 0.5) * 80;
			}
			else {
				const a = (i / Math.max(1, others.length)) * Math.PI * 2;
				n._x = cx + Math.cos(a) * ringR * 0.35 + (Math.random() - 0.5) * 40;
				n._y = cy + Math.sin(a) * ringR * 0.35 + (Math.random() - 0.5) * 40;
			}
			n._fixed = false;
			n._vx = n._vy = 0;
		});
	}

	function nodeRadius(n) {
		if (n.type === "paper") return 11;
		if (n.type === "topic") return Math.min(30, 12 + Math.sqrt(Math.max(1, n.members || 1)) * 3);
		const papers = (n.paperIds || []).length;
		return Math.min(22, 5 + Math.sqrt(Math.max(1, papers)) * 4);
	}

	function startSim() {
		if (sim) cancelAnimationFrame(sim);
		let ticks = 0;
		const maxTicks = 320;

		const step = () => {
			tick();
			draw();
			ticks++;
			if (ticks < maxTicks) sim = requestAnimationFrame(step);
			else sim = null;
		};
		sim = requestAnimationFrame(step);
	}

	function tick() {
		const nodes = view.nodes;
		const edges = view.edges;
		const n = nodes.length;
		if (!n) return;

		const w = wrap.clientWidth || 800;
		const h = wrap.clientHeight || 600;
		const repulsion = 2600;
		const springLen = 90;
		const springK = 0.012;
		const damping = 0.84;
		const centerPull = 0.0012;

		// 斥力（n 小，直接 O(n²)）
		for (let i = 0; i < n; i++) {
			const a = nodes[i];
			if (a._fixed) continue;
			let fx = 0, fy = 0;
			for (let j = 0; j < n; j++) {
				if (i === j) continue;
				const b = nodes[j];
				let dx = a._x - b._x;
				let dy = a._y - b._y;
				let d2 = dx * dx + dy * dy;
				if (d2 < 1) { d2 = 1; dx = Math.random() - 0.5; dy = Math.random() - 0.5; }
				const d = Math.sqrt(d2);
				const f = repulsion / d2;
				fx += (dx / d) * f;
				fy += (dy / d) * f;
			}
			fx += (w / 2 - a._x) * centerPull * 100;
			fy += (h / 2 - a._y) * centerPull * 100;
			a._vx = (a._vx + fx * 0.01) * damping;
			a._vy = (a._vy + fy * 0.01) * damping;
		}

		// 引力（边）
		const byId = Object.create(null);
		for (const node of nodes) byId[node.nodeId] = node;
		for (const e of edges) {
			const a = byId[e.source], b = byId[e.target];
			if (!a || !b) continue;
			const dx = b._x - a._x, dy = b._y - a._y;
			const d = Math.sqrt(dx * dx + dy * dy) || 1;
			const f = (d - springLen) * springK;
			const ux = dx / d, uy = dy / d;
			if (!a._fixed) { a._vx += ux * f; a._vy += uy * f; }
			if (!b._fixed) { b._vx -= ux * f; b._vy -= uy * f; }
		}

		for (const node of nodes) {
			if (node._fixed) continue;
			node._x += Math.max(-12, Math.min(12, node._vx));
			node._y += Math.max(-12, Math.min(12, node._vy));
		}
	}

	// ------------------------------------------------------------ 绘制

	function fit() {
		const nodes = view.nodes;
		if (!nodes.length) { camera = { x: 0, y: 0, scale: 1 }; return; }
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n._x); maxX = Math.max(maxX, n._x);
			minY = Math.min(minY, n._y); maxY = Math.max(maxY, n._y);
		}
		const w = wrap.clientWidth || 800;
		const h = wrap.clientHeight || 600;
		const pad = 70;
		const sx = (w - pad * 2) / Math.max(1, maxX - minX);
		const sy = (h - pad * 2) / Math.max(1, maxY - minY);
		camera.scale = Math.max(0.25, Math.min(1.6, Math.min(sx, sy)));
		camera.x = w / 2 - ((minX + maxX) / 2) * camera.scale;
		camera.y = h / 2 - ((minY + maxY) / 2) * camera.scale;
	}

	function toScreen(n) {
		return { x: n._x * camera.scale + camera.x, y: n._y * camera.scale + camera.y };
	}

	function toWorld(sx, sy) {
		return { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale };
	}

	/**
	 * 页内确认框。
	 * 不用原生 confirm：它会弹系统模态框，还可能把图谱窗口压到后面。
	 * @returns {Promise<boolean>}
	 */
	function confirmAction(text) {
		return new Promise((resolve) => {
			try {
				const overlay = document.createElement("div");
				overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.35);"
					+ "display:flex;align-items:center;justify-content:center;z-index:99999;";

				const box = document.createElement("div");
				box.style.cssText = "background:#fff;color:#1f2328;border-radius:10px;padding:16px 18px;"
					+ "max-width:380px;box-shadow:0 8px 30px rgba(0,0,0,0.25);font:13px/1.6 sans-serif;";

				const msg = document.createElement("div");
				msg.textContent = text;
				msg.style.marginBottom = "14px";

				const row = document.createElement("div");
				row.style.cssText = "display:flex;justify-content:flex-end;gap:8px;";

				const cancel = document.createElement("button");
				cancel.textContent = "取消";
				cancel.style.cssText = "padding:5px 14px;border:1px solid #d1d5da;border-radius:6px;background:#fff;cursor:pointer;";

				const ok = document.createElement("button");
				ok.textContent = "删除";
				ok.style.cssText = "padding:5px 14px;border:1px solid #cf222e;border-radius:6px;"
					+ "background:#cf222e;color:#fff;cursor:pointer;";

				const close = (value) => {
					try { overlay.remove(); } catch (e) { /* ignore */ }
					resolve(value);
				};

				cancel.addEventListener("click", () => close(false));
				ok.addEventListener("click", () => close(true));
				overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(false); });

				row.appendChild(cancel);
				row.appendChild(ok);
				box.appendChild(msg);
				box.appendChild(row);
				overlay.appendChild(box);
				(document.body || document.documentElement).appendChild(overlay);
				ok.focus();
			}
			catch (e) {
				resolve(true);   // 极端情况下不阻塞删除
			}
		});
	}

	function promptAction(text, def) {
		try { return window.prompt(text, def); } catch (e) { /* ignore */ }
		try { return Zotero.getMainWindow().prompt(text, def); } catch (e) { /* ignore */ }
		return null;
	}

	function alertAction(text) {
		try {
			const win = Zotero.getMainWindow && Zotero.getMainWindow();
			if (win && typeof win.alert === "function") { win.alert(text); return; }
		}
		catch (e) { /* ignore */ }
		try { window.alert(text); } catch (e) { /* ignore */ }
	}

	function draw() {
		const w = wrap.clientWidth || 800;
		const h = wrap.clientHeight || 600;
		ctx.clearRect(0, 0, w, h);

		const byId = Object.create(null);
		for (const n of view.nodes) byId[n.nodeId] = n;

		// 高亮 = 选中的点 + 这些点出边指向的点
		const highlightIds = new Set(selection);
		for (const e of view.edges) {
			if (selection.has(e.source)) highlightIds.add(e.target);
		}

		// 边
		for (const e of view.edges) {
			const a = byId[e.source], b = byId[e.target];
			if (!a || !b) continue;
			const pa = toScreen(a), pb = toScreen(b);
			const isHi = selection.has(e.source) || selection.has(e.target);

			ctx.beginPath();
			ctx.moveTo(pa.x, pa.y);
			ctx.lineTo(pb.x, pb.y);
			ctx.strokeStyle = isHi
				? (e.type === "contradicts" ? COLORS.contradicts
					: e.type === "supports" ? COLORS.supports : COLORS.edgeHighlight)
				: COLORS.edge;
			ctx.lineWidth = isHi ? 2 : Math.max(0.6, (e.confidence || 0.6) * 1.6);
			if (e.type === "contradicts") ctx.setLineDash([5, 3]);
			ctx.stroke();
			ctx.setLineDash([]);

			// 箭头（有向图）
			const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x);
			const r = nodeRadius(b) * camera.scale + 3;
			const tipX = pb.x - Math.cos(ang) * r;
			const tipY = pb.y - Math.sin(ang) * r;
			ctx.beginPath();
			ctx.moveTo(tipX, tipY);
			ctx.lineTo(tipX - Math.cos(ang - 0.4) * 7, tipY - Math.sin(ang - 0.4) * 7);
			ctx.lineTo(tipX - Math.cos(ang + 0.4) * 7, tipY - Math.sin(ang + 0.4) * 7);
			ctx.closePath();
			ctx.fillStyle = isHi ? COLORS.edgeHighlight : COLORS.edge;
			ctx.fill();
		}

		// 节点
		const topicColorOn = ($("pl-topic-color") || {}).checked;
		for (const n of view.nodes) {
			const p = toScreen(n);
			const r = nodeRadius(n) * camera.scale;
			const cross = n.type === "concept" && (n.paperIds || []).length >= 2;
			let color;
			if (n.type === "topic") {
				color = colorForTopic(n.nodeId) || "#7f8c8d";
			} else if (n.type === "paper") {
				color = COLORS.paper;
			} else if (n.type === "claim") {
				color = COLORS.claim;
			} else if (topicColorOn && n.topicId) {
				// 按主题着色：同主题概念同色；跨论文概念加白描边另行强调
				color = colorForTopic(n.topicId);
			} else {
				color = cross ? COLORS.crossConcept : COLORS.concept;
			}

			const dim = selection.size > 0 && !highlightIds.has(n.nodeId);
			ctx.globalAlpha = dim ? 0.3 : 1;

			ctx.beginPath();
			if (n.type === "paper") {
				ctx.rect(p.x - r, p.y - r * 0.78, r * 2, r * 1.56);
			}
			else if (n.type === "topic") {
				// 主题节点画成方块，与概念圆点区分，视觉上像"容器"
				ctx.rect(p.x - r, p.y - r, r * 2, r * 2);
			}
			else {
				ctx.arc(p.x, p.y, Math.max(3, r), 0, Math.PI * 2);
			}
			ctx.fillStyle = color;
			ctx.fill();
			if (selection.has(n.nodeId)) {
				// 光晕 + 双层描边，确保一眼看出被选中
				ctx.save();
				ctx.shadowColor = "rgba(46,127,224,0.95)";
				ctx.shadowBlur = 14;
				ctx.lineWidth = 3.5;
				ctx.strokeStyle = "#fff";
				ctx.stroke();
				ctx.restore();

				ctx.lineWidth = 1.8;
				ctx.strokeStyle = "#2e7fe0";
				ctx.stroke();
			}
			if (hover && hover.nodeId === n.nodeId) {
				ctx.lineWidth = 1.6;
				ctx.strokeStyle = "#fff";
				ctx.stroke();
			}

			// 标签：节点够大或被选中/悬停时才画，避免糊成一片
			if (r > 7 || highlightIds.has(n.nodeId) || (hover && hover.nodeId === n.nodeId)) {
				const label = String(n.label || "").slice(0, 18);
				ctx.font = (n.type === "paper" ? "600 " : "") + "11px sans-serif";
				ctx.textAlign = "center";
				ctx.textBaseline = "top";
				const tw = ctx.measureText(label).width;
				ctx.fillStyle = "rgba(0,0,0,0.45)";
				ctx.fillRect(p.x - tw / 2 - 3, p.y + r + 2, tw + 6, 14);
				ctx.fillStyle = "#fff";
				ctx.fillText(label, p.x, p.y + r + 4);
			}
			ctx.globalAlpha = 1;
		}

		// 框选矩形
		if (box) {
			const x = Math.min(box.x0, box.x1), y = Math.min(box.y0, box.y1);
			const bw = Math.abs(box.x1 - box.x0), bh = Math.abs(box.y1 - box.y0);
			ctx.save();
			ctx.fillStyle = "rgba(46,127,224,0.12)";
			ctx.strokeStyle = "rgba(46,127,224,0.85)";
			ctx.lineWidth = 1;
			ctx.fillRect(x, y, bw, bh);
			ctx.strokeRect(x, y, bw, bh);
			ctx.restore();
		}

		updateSelUI();
	}

	/** 同步"删除选中"按钮的文字与可用状态 */
	function updateSelUI() {
		try {
			const btn = $("pl-graph-del");
			if (!btn) return;
			const n = selection.size;
			btn.textContent = n ? ("删除选中 (" + n + ")") : "删除选中";
			btn.disabled = n === 0;

			const info = $("pl-graph-selinfo");
			if (info) info.textContent = n > 1 ? ("已选 " + n + " 个节点") : "";
		}
		catch (e) { /* ignore */ }
	}

	// ------------------------------------------------------------ 交互

	function pick(sx, sy) {
		const wpt = toWorld(sx, sy);
		let best = null, bestD = Infinity;
		for (const n of view.nodes) {
			const dx = n._x - wpt.x, dy = n._y - wpt.y;
			const d = Math.sqrt(dx * dx + dy * dy);
			const r = Math.max(6, nodeRadius(n)) + 6;
			if (d < r && d < bestD) { best = n; bestD = d; }
		}
		return best;
	}

	function onMouseDown(ev) {
		try { canvas.focus(); } catch (e) { /* ignore */ }
		const rect = canvas.getBoundingClientRect();
		const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
		const node = pick(sx, sy);

		// 中键 / Alt 拖拽 = 平移画布（左键留给框选）
		if (ev.button === 2 || ev.button === 1 || ev.altKey) {
			try { ev.preventDefault(); } catch (e) { /* ignore */ }
			panning = { x: sx, y: sy, cx: camera.x, cy: camera.y };
			return;
		}

		if (node) {
			const multi = ev.shiftKey || ev.ctrlKey || ev.metaKey || multiSelectMode;
			if (multi) {
				// shift 点选：加入 / 移出多选
				if (selection.has(node.nodeId)) selection.delete(node.nodeId);
				else selection.add(node.nodeId);
			}
			else {
				selection = new Set([node.nodeId]);
				dragging = node;
			}
			if (selection.size > 1) showSelectionSummary();
			else if (selection.size === 1) showDetail(node);
			draw();
			return;
		}

		// 空白处按下：开始框选；不按 shift 则清空已有选择
		if (!ev.shiftKey) {
			selection = new Set();
			$("pl-graph-detail").innerHTML = "";
		}
		box = { x0: sx, y0: sy, x1: sx, y1: sy };
		draw();
	}

	function onMouseMove(ev) {
		const rect = canvas.getBoundingClientRect();
		const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;

		if (dragging) {
			const wpt = toWorld(sx, sy);
			dragging._x = wpt.x;
			dragging._y = wpt.y;
			dragging._vx = dragging._vy = 0;
			draw();
			return;
		}
		if (panning) {
			camera.x = panning.cx + (sx - panning.x);
			camera.y = panning.cy + (sy - panning.y);
			draw();
			return;
		}
		if (box) {
			box.x1 = sx;
			box.y1 = sy;
			draw();
			return;
		}
		const node = pick(sx, sy);
		if ((node && node.nodeId) !== (hover && hover.nodeId)) {
			hover = node;
			canvas.style.cursor = node ? "pointer" : "grab";
			draw();
		}
	}

	function onMouseUp() {
		if (box) {
			const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
			const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);

			// 太小的矩形视为普通单击，不做框选
			if (x1 - x0 > 4 && y1 - y0 > 4) {
				for (const n of view.nodes) {
					const p = toScreen(n);
					if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) {
						selection.add(n.nodeId);
					}
				}
				if (selection.size > 1) {
						showSelectionSummary();
				}
				else if (selection.size === 1) {
					const onlyId = Array.from(selection)[0];
					const only = view.nodes.find(n => n.nodeId === onlyId);
					if (only) showDetail(only);
				}
			}
			box = null;
			draw();
		}

		dragging = null;
		panning = null;
	}

	/** Del / Backspace：删除所有选中的节点（先确认） */
	async function deleteSelection() {
		if (!selection.size) return;
		if (!(await confirmAction("删除选中的 " + selection.size + " 个节点及其全部关联边？此操作不可撤销。"))) return;

		try {
			await PL.GraphStore.removeNodes(Array.from(selection));
			selection = new Set();
			$("pl-graph-detail").innerHTML = "";
			$("pl-graph-hint").style.display = "block";
			await load();
		}
		catch (e) {
			alertAction("删除失败：" + e);
		}
	}

	function onWheel(ev) {
		ev.preventDefault();
		const rect = canvas.getBoundingClientRect();
		const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
		const before = toWorld(sx, sy);
		const factor = ev.deltaY < 0 ? 1.12 : 0.89;
		camera.scale = Math.max(0.15, Math.min(4, camera.scale * factor));
		const after = toWorld(sx, sy);
		camera.x += (after.x - before.x) * camera.scale;
		camera.y += (after.y - before.y) * camera.scale;
		draw();
	}

	// ------------------------------------------------------------ 手动编辑

	async function rebuildTopicsAction() {
		if (!PL.GraphStore.rebuildTopics) {
			alertAction("当前领域层不支持主题分层（请更新 graphStore.js）。");
			return;
		}
		const btn = $("pl-graph-rebuild-topics");
		if (btn) { btn.disabled = true; btn.textContent = "重建中…"; }
		try {
			await PL.GraphStore.rebuildTopics();
			await load();
			const st = PL.GraphStore.stats ? await PL.GraphStore.stats() : null;
			$("pl-graph-hint").style.display = "block";
			$("pl-graph-hint").textContent = "主题重建完成：共 " + (st ? st.topics : "?") + " 个主题。";
		} catch (e) {
			alertAction("重建主题失败：" + (e && e.message ? e.message : e));
		} finally {
			if (btn) { btn.disabled = false; btn.textContent = "重建主题"; }
		}
	}

	async function addConcept() {
		const input = $("pl-graph-new-label");
		const label = String(input.value || "").trim();
		if (!label) return;
		try {
			await PL.GraphStore.upsertNode({ type: "concept", label: label, paperIds: [], weight: 1 });
			input.value = "";
			await load();
		}
		catch (e) {
			alertAction("添加概念失败：" + e);
		}
	}

	async function deleteNodeAction(node) {
		if (!(await confirmAction("删除概念「" + node.label + "」及其全部关联边？"))) return;
		try {
			await PL.GraphStore.removeNode(node.nodeId);
			$("pl-graph-detail").innerHTML = "";
			$("pl-graph-hint").style.display = "block";
			await load();
		}
		catch (e) {
			alertAction("删除失败：" + e);
		}
	}

	async function renameNodeAction(node) {
		const next = promptAction("新的概念名称", node.label);
		if (next == null) return;
		const label = String(next).trim();
		if (!label || label === node.label) return;
		try {
			const updated = await PL.GraphStore.renameNode(node.nodeId, label);
			await load();
			if (updated) showDetail(updated);
		}
		catch (e) {
			alertAction("改名失败：" + e);
		}
	}

	// ------------------------------------------------------------ 证据卡片

	/** 多选时右侧显示汇总，避免看起来"只选了一个" */
	function showSelectionSummary() {
		const box = $("pl-graph-detail");
		box.innerHTML = "";
		$("pl-graph-hint").style.display = "none";

		const card = document.createElement("div");
		card.className = "pl-evidence-card";

		const h = document.createElement("h4");
		h.textContent = "已选中 " + selection.size + " 个节点";
		card.appendChild(h);

		const tip = document.createElement("div");
		tip.className = "pl-muted";
		tip.textContent = "按 Delete 或点工具栏「删除选中」删除；Esc 取消选择。";
		card.appendChild(tip);

		const list = document.createElement("div");
		list.className = "pl-muted";
		list.style.marginTop = "6px";
		list.textContent = view.nodes
			.filter(n => selection.has(n.nodeId))
			.map(n => n.label)
			.slice(0, 40)
			.join("、");
		card.appendChild(list);

		box.appendChild(card);
	}

	function showDetail(node) {
		const box = $("pl-graph-detail");
		box.innerHTML = "";
		$("pl-graph-hint").style.display = "none";

		const head = document.createElement("div");
		head.className = "pl-evidence-card";
		const title = document.createElement("h4");
		title.textContent = node.label;
		head.appendChild(title);

		const meta = document.createElement("div");
		meta.className = "pl-muted";
		meta.textContent = typeLabel(node.type)
			+ " · 关联 " + (node.paperIds || []).length + " 篇论文"
			+ ((node.paperIds || []).length >= 2 ? "（跨论文）" : "");
		head.appendChild(meta);

		// 看图即改：重命名 / 删除
		const actions = document.createElement("div");
		actions.className = "pl-graph-actions";

		const renameBtn = document.createElement("button");
		renameBtn.textContent = "重命名";
		renameBtn.addEventListener("click", () => renameNodeAction(node));

		const delBtn = document.createElement("button");
		delBtn.textContent = "删除节点";
		delBtn.addEventListener("click", () => deleteNodeAction(node));

		actions.appendChild(renameBtn);
		actions.appendChild(delBtn);
		head.appendChild(actions);

		if ((node.aliases || []).length) {
			const al = document.createElement("div");
			al.className = "pl-muted";
			al.textContent = "别名：" + node.aliases.join("、");
			head.appendChild(al);
		}
		box.appendChild(head);

		// 相关边 → 每条边一张证据卡（原文摘录 + 页码 + 跳转）
		const related = graph.edges.filter(e => e.source === node.nodeId || e.target === node.nodeId);
		const byId = Object.create(null);
		for (const n of graph.nodes) byId[n.nodeId] = n;

		if (!related.length) {
			const empty = document.createElement("div");
			empty.className = "pl-muted";
			empty.textContent = "这个节点还没有带证据的边。";
			box.appendChild(empty);
			return;
		}

		// 同一概念在多篇论文中的原文对照：按 paperId 分组
		related.sort((a, b) => String(a.evidence.paperId).localeCompare(String(b.evidence.paperId)));

		for (const e of related) {
			const other = e.source === node.nodeId ? byId[e.target] : byId[e.source];
			const dir = e.source === node.nodeId ? "→" : "←";
			const ev = e.evidence || {};

			const card = document.createElement("div");
			card.className = "pl-evidence-card";

			const h = document.createElement("h4");
			h.textContent = dir + " " + ((other && other.label) || "?");
			card.appendChild(h);

			const t = document.createElement("div");
			t.className = "pl-muted";
			t.textContent = edgeTypeLabel(e.type) + (e.label ? "：" + e.label : "")
				+ " · 置信度 " + Number(e.confidence).toFixed(2)
				+ " · 来源 " + e.origin;
			card.appendChild(t);

			if (ev.quote) {
				const q = document.createElement("div");
				q.className = "pl-evidence-quote";
				q.textContent = "“" + ev.quote + "”";
				card.appendChild(q);
			}

			const jump = document.createElement("button");
			jump.textContent = "跳转到 p." + (ev.page || 1);
			jump.addEventListener("click", () => jumpTo(ev.paperId, ev.page));
			card.appendChild(jump);

			const delEdge = document.createElement("button");
			delEdge.textContent = "删除这条边";
			delEdge.addEventListener("click", async () => {
				if (!(await confirmAction("删除这条关联边？"))) return;
				try {
					await PL.GraphStore.removeEdge(e.edgeId);
					await load();
					const fresh = (graph.nodes || []).find(n => n.nodeId === node.nodeId);
					if (fresh) showDetail(fresh);
				}
				catch (err) {
					alertAction("删除失败：" + err);
				}
			});
			card.appendChild(delEdge);

			box.appendChild(card);
		}
	}

	function typeLabel(t) {
		return { paper: "论文", concept: "概念", claim: "论断" }[t] || t;
	}

	function edgeTypeLabel(t) {
		return {
			mentions: "提及", relates: "相关", supports: "支持",
			contradicts: "矛盾", co_asked: "共同被问", cites: "引用"
		}[t] || t;
	}

	async function jumpTo(paperId, page) {
		try {
			const doc = await PL.Storage.readPaperDoc(paperId);
			const attachmentId = doc && doc.attachmentId;
			if (attachmentId && Zotero.Reader && Zotero.Reader.open) {
				try {
					await Zotero.Reader.open(attachmentId, { pageIndex: Math.max(0, (page || 1) - 1) });
					return;
				}
				catch (e) { /* 走 URI fallback */ }
			}
			if (attachmentId) {
				const att = await Zotero.Items.getAsync(attachmentId);
				if (att && att.key) {
					Zotero.launchURL("zotero://open-pdf/library/items/" + att.key + "?page=" + (page || 1));
					return;
				}
			}
			const id = await Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, paperId);
			if (id) Zotero.getActiveZoteroPane().selectItem(id);
		}
		catch (e) { /* ignore */ }
	}
})();
