/* PaperLoom — content/memory.js（记忆卡片面板的视图层）
 *
 * 把"它记住了我什么"可视化成卡片，可手动编辑 / 删除。
 * 记忆是隐形的，评委看不见就等于没有 —— 把记忆做成能被看见、能被反驳的东西。
 *
 * 注意：领域层的记忆逻辑在 content/scripts/memory.js（PaperLoom.Memory），本文件只负责渲染。
 */
(function () {
	"use strict";

	// 同 chat.js：标签页可能在插件启动前被恢复，领域层允许稍后才就绪
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

	document.addEventListener("DOMContentLoaded", init);
	if (document.readyState !== "loading") init();

	let inited = false;
	async function init() {
		if (inited) return;
		inited = true;

		if (!PL) {
			$("pl-mem-empty").style.display = "block";
			$("pl-mem-empty").textContent = "PaperLoom 正在加载…";
			const ready = await waitForDomainLayer(20000);
			if (!ready) {
				$("pl-mem-empty").textContent = "PaperLoom 领域层尚未就绪，请关闭本页后重新打开。";
				return;
			}
			$("pl-mem-empty").textContent = "";
		}

		$("pl-mem-refresh").addEventListener("click", render);
		$("pl-mem-add").addEventListener("click", onAdd);
		$("pl-mem-value").addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") onAdd();
		});

		render();
	}

	async function onAdd() {
		const key = $("pl-mem-key").value.trim();
		const value = $("pl-mem-value").value.trim();
		if (!key || !value) {
			window.alert("key 和 value 都不能为空。");
			return;
		}
		await PL.Memory.setExplicit(key, value, "用户在记忆面板中手动添加");
		$("pl-mem-key").value = "";
		$("pl-mem-value").value = "";
		render();
	}

	/** 记忆分层：按 key 命名空间归档，让"它记住了我什么"结构可见 */
	const LAYERS = [
		{ id: "style", label: "表达偏好", desc: "怎么跟你说话（长度、公式、语言）", match: /^style\./ },
		{ id: "familiarity", label: "文献熟悉度", desc: "你读过哪些、读到什么程度", match: /^familiarity\./ },
		{ id: "interest", label: "关注点", desc: "你对哪些概念感兴趣", match: /^interest\./ },
		{ id: "background", label: "背景", desc: "你的领域与水平", match: /^background\./ },
		{ id: "other", label: "其他", desc: "尚未归类的事实", match: /./ }
	];

	function layerOf(key) {
		for (const l of LAYERS) {
			if (l.id !== "other" && l.match.test(key)) return l;
		}
		return LAYERS[LAYERS.length - 1];
	}

	async function render() {
		const list = $("pl-mem-list");
		list.innerHTML = "";

		let facts = [];
		try {
			facts = await PL.Memory.all();
		}
		catch (e) {
			$("pl-mem-empty").style.display = "block";
			$("pl-mem-empty").textContent = "读取记忆失败：" + e;
			return;
		}

		const explicitCount = facts.filter(f => f.origin === "explicit").length;
		$("pl-mem-stats").textContent = facts.length + " 条记忆（"
			+ explicitCount + " 条已锁定，" + (facts.length - explicitCount) + " 条由推断得出）";

		$("pl-mem-empty").style.display = facts.length ? "none" : "block";

		// 已锁定的排前面，其次按置信度
		facts.sort((a, b) => {
			const la = a.origin === "explicit" ? 1 : 0;
			const lb = b.origin === "explicit" ? 1 : 0;
			return (lb - la) || (b.confidence - a.confidence) || a.key.localeCompare(b.key);
		});

		// 按层分组渲染
		for (const layer of LAYERS) {
			const inLayer = facts.filter(f => layerOf(f.key).id === layer.id);
			if (!inLayer.length) continue;

			const head = document.createElement("div");
			head.className = "pl-layer-head";
			const h = document.createElement("strong");
			h.textContent = layer.label + "（" + inLayer.length + "）";
			head.appendChild(h);
			const d = document.createElement("span");
			d.className = "pl-muted";
			d.textContent = " " + layer.desc;
			head.appendChild(d);
			list.appendChild(head);

			const grid = document.createElement("div");
			grid.className = "pl-memory-grid";
			for (const fact of inLayer) grid.appendChild(makeCard(fact));
			list.appendChild(grid);
		}
	}

	function makeCard(fact) {
		const locked = fact.origin === "explicit" && fact.confidence >= 1;

		const card = document.createElement("div");
		card.className = "pl-memory-card" + (locked ? " pl-locked" : "");

		const key = document.createElement("div");
		key.className = "pl-memory-key";
		key.textContent = fact.key;
		card.appendChild(key);

		const value = document.createElement("div");
		value.className = "pl-memory-value";
		value.textContent = String(fact.value);
		card.appendChild(value);

		// 置信度条 —— 让"可被反驳"变得直观
		const bar = document.createElement("div");
		bar.className = "pl-confidence-bar";
		const fill = document.createElement("div");
		fill.style.width = Math.round((fact.confidence || 0) * 100) + "%";
		if (locked) fill.style.background = "var(--pl-green)";
		bar.appendChild(fill);
		card.appendChild(bar);

		const row = document.createElement("div");
		row.className = "pl-row";
		const badge = document.createElement("span");
		badge.className = "pl-badge " + (locked ? "pl-explicit" : "pl-inferred");
		badge.textContent = locked ? "已锁定 · 不被推断覆盖" : fact.origin;
		row.appendChild(badge);
		const conf = document.createElement("span");
		conf.className = "pl-muted";
		conf.textContent = "confidence " + Number(fact.confidence).toFixed(2);
		row.appendChild(conf);
		card.appendChild(row);

		// 证据：这条记忆凭什么被记下来
		if ((fact.evidence || []).length) {
			const ul = document.createElement("ul");
			ul.className = "pl-evidence-list";
			for (const ev of fact.evidence.slice(-3)) {
				const li = document.createElement("li");
				li.textContent = "[" + (ev.type || "?") + "] " + (ev.text || ev.signal || "");
				ul.appendChild(li);
			}
			card.appendChild(ul);
		}

		// 历史：被覆盖掉的旧值，演示"记错了也能解释清楚"
		if ((fact.history || []).length) {
			const details = document.createElement("details");
			const summary = document.createElement("summary");
			summary.className = "pl-muted";
			summary.textContent = "历史值 " + fact.history.length + " 条";
			details.appendChild(summary);
			const ul = document.createElement("ul");
			ul.className = "pl-evidence-list";
			for (const h of fact.history.slice(-5)) {
				const li = document.createElement("li");
				li.textContent = String(h.value) + "（" + Number(h.confidence).toFixed(2)
					+ "，" + h.origin + "，于 " + String(h.replacedAt || "").slice(0, 19) + " 被覆盖）";
				ul.appendChild(li);
			}
			details.appendChild(ul);
			card.appendChild(details);
		}

		// 操作
		const actions = document.createElement("div");
		actions.className = "pl-memory-actions";

		const editBtn = document.createElement("button");
		editBtn.textContent = "改正";
		editBtn.title = "修改后会锁定为 explicit / confidence 1.00";
		editBtn.addEventListener("click", async () => {
			const next = window.prompt("修改「" + fact.key + "」的值（修改后将锁定，不再被推断覆盖）：", String(fact.value));
			if (next === null || !next.trim()) return;
			await PL.Memory.setExplicit(fact.key, next.trim(), "用户在记忆面板中改正");
			render();
		});
		actions.appendChild(editBtn);

		if (!locked) {
			const lockBtn = document.createElement("button");
			lockBtn.textContent = "锁定";
			lockBtn.title = "确认这条记忆正确，此后不被推断覆盖";
			lockBtn.addEventListener("click", async () => {
				await PL.Memory.setExplicit(fact.key, fact.value, "用户确认该推断正确");
				render();
			});
			actions.appendChild(lockBtn);
		}

		const delBtn = document.createElement("button");
		delBtn.textContent = "删除";
		delBtn.addEventListener("click", async () => {
			if (!window.confirm("删除记忆「" + fact.key + " = " + fact.value + "」？")) return;
			await PL.Memory.remove(fact.factId);
			render();
		});
		actions.appendChild(delBtn);

		card.appendChild(actions);

		const time = document.createElement("div");
		time.className = "pl-muted";
		time.style.fontSize = "10px";
		time.style.marginTop = "5px";
		time.textContent = "更新于 " + String(fact.updatedAt || "").slice(0, 19).replace("T", " ");
		card.appendChild(time);

		return card;
	}
})();
