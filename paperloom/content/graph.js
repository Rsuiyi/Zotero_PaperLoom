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
	let PL = Zotero && Zotero.PaperLoom;

	function resolveZotero() {
		const tries = [
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
	let selected = null;                    // 详情面板展示的主节点
	let selection = new Set();              // 多选集合（nodeId）
	let hover = null;
	let dragging = null;
	let panning = null;
	let box = null;                         // 框选矩形 {x0,y0,x1,y1}

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
		$("pl-graph-refresh").addEventListener("click", load);
		$("pl-graph-fit").addEventListener("click", () => { fit(); draw(); });
		$("pl-graph-add-node").addEventListener("click", addConcept);

		// Del / Backspace 删除选中节点；Esc 清空选择
		window.addEventListener("keydown", (ev) => {
			if (ev.key === "Delete" || ev.key === "Backspace") {
				if (selection.size) {
					ev.preventDefault();
					deleteSelection();
				}
			}
			else if (ev.key === "Escape") {
				selection = new Set();
				selected = null;
				draw();
			}
		});

		canvas.addEventListener("mousedown", onMouseDown);
		canvas.addEventListener("mousemove", onMouseMove);
		canvas.addEventListener("mouseup", onMouseUp);
		canvas.addEventListener("mouseleave", onMouseUp);
		canvas.addEventListener("wheel", onWheel, { passive: false });

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

	function draw() {
		const w = wrap.clientWidth || 800;
		const h = wrap.clientHeight || 600;
		ctx.clearRect(0, 0, w, h);

		const byId = Object.create(null);
		for (const n of view.nodes) byId[n.nodeId] = n;

		const highlightIds = new Set();
		if (selected) {
			highlightIds.add(selected.nodeId);
			for (const e of view.edges) {
				if (e.source === selected.nodeId) highlightIds.add(e.target);
				if (e.target === selected.nodeId) highlightIds.add(e.source);
			}
		}

		// 边
		for (const e of view.edges) {
			const a = byId[e.source], b = byId[e.target];
			if (!a || !b) continue;
			const pa = toScreen(a), pb = toScreen(b);
			const isHi = selected && (e.source === selected.nodeId || e.target === selected.nodeId);

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
		for (const n of view.nodes) {
			const p = toScreen(n);
			const r = nodeRadius(n) * camera.scale;
			const cross = n.type === "concept" && (n.paperIds || []).length >= 2;
			const color = n.type === "paper" ? COLORS.paper
				: n.type === "claim" ? COLORS.claim
					: cross ? COLORS.crossConcept : COLORS.concept;

			const dim = selected && !highlightIds.has(n.nodeId);
			ctx.globalAlpha = dim ? 0.3 : 1;

			ctx.beginPath();
			if (n.type === "paper") {
				ctx.rect(p.x - r, p.y - r * 0.78, r * 2, r * 1.56);
			}
			else {
				ctx.arc(p.x, p.y, Math.max(3, r), 0, Math.PI * 2);
			}
			ctx.fillStyle = color;
			ctx.fill();
			if (selection.has(n.nodeId)) {
				ctx.lineWidth = 2.5;
				ctx.strokeStyle = "#fff";
				ctx.stroke();
				ctx.lineWidth = 1.2;
				ctx.strokeStyle = color;
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
		const rect = canvas.getBoundingClientRect();
		const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
		const node = pick(sx, sy);

		// 中键 / Alt 拖拽 = 平移画布（左键留给框选）
		if (ev.button === 1 || ev.altKey) {
			panning = { x: sx, y: sy, cx: camera.x, cy: camera.y };
			return;
		}

		if (node) {
			if (ev.shiftKey) {
				// shift 点选：加入 / 移出多选
				if (selection.has(node.nodeId)) selection.delete(node.nodeId);
				else selection.add(node.nodeId);
				selected = node;
			}
			else {
				selection = new Set([node.nodeId]);
				selected = node;
				dragging = node;
			}
			showDetail(node);
			draw();
			return;
		}

		// 空白处按下：开始框选；不按 shift 则清空已有选择
		if (!ev.shiftKey) {
			selection = new Set();
			selected = null;
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
				if (selection.size) {
					const lastId = Array.from(selection)[selection.size - 1];
					const last = view.nodes.find(n => n.nodeId === lastId);
					if (last) { selected = last; showDetail(last); }
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
		if (!window.confirm("删除选中的 " + selection.size + " 个节点及其全部关联边？此操作不可撤销。")) return;

		try {
			await PL.GraphStore.removeNodes(Array.from(selection));
			selection = new Set();
			selected = null;
			$("pl-graph-detail").innerHTML = "";
			$("pl-graph-hint").style.display = "block";
			await load();
		}
		catch (e) {
			window.alert("删除失败：" + e);
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
			window.alert("添加概念失败：" + e);
		}
	}

	async function deleteNodeAction(node) {
		if (!window.confirm("删除概念「" + node.label + "」及其全部关联边？")) return;
		try {
			await PL.GraphStore.removeNode(node.nodeId);
			$("pl-graph-detail").innerHTML = "";
			$("pl-graph-hint").style.display = "block";
			await load();
		}
		catch (e) {
			window.alert("删除失败：" + e);
		}
	}

	async function renameNodeAction(node) {
		const next = window.prompt("新的概念名称", node.label);
		if (next == null) return;
		const label = String(next).trim();
		if (!label || label === node.label) return;
		try {
			const updated = await PL.GraphStore.renameNode(node.nodeId, label);
			await load();
			if (updated) showDetail(updated);
		}
		catch (e) {
			window.alert("改名失败：" + e);
		}
	}

	// ------------------------------------------------------------ 证据卡片

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
				if (!window.confirm("删除这条关联边？")) return;
				try {
					await PL.GraphStore.removeEdge(e.edgeId);
					await load();
					const fresh = (graph.nodes || []).find(n => n.nodeId === node.nodeId);
					if (fresh) showDetail(fresh);
				}
				catch (err) {
					window.alert("删除失败：" + err);
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
