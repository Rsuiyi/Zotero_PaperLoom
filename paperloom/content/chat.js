/* PaperLoom — chat.js
 * L3 表现层：论文侧栏对话面板 / 全库对话面板（二者同构，由 ?mode= 区分）。
 *
 * 面板的三个不可省要素：
 *   1. 引用渲染为可点击 chip，点击跳到原文对应页；定位失败的标红。
 *   2.「本次使用了 N 条记忆」徽标 —— 没有它，记忆功能在答辩时是看不见的。
 *   3. 跨篇不足、页码不精确等情况必须显式警告，不静默通过。
 */
(function () {
	"use strict";

	// 领域层可能比 iframe 晚就绪：Zotero 启动时会恢复上次的标签页，
	// 恢复的 iframe 可能早于插件 startup 完成。所以这两个是可变引用，拿到后要能刷新。
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

	function sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/** 最多等 maxMs，期间每 200ms 重新解析一次 Zotero 与 PaperLoom */
	async function waitForDomainLayer(maxMs) {
		const deadline = Date.now() + (maxMs || 20000);
		while (Date.now() < deadline) {
			Zotero = resolveZotero();
			PL = Zotero && Zotero.PaperLoom;
			if (PL) return true;
			await sleep(200);
		}
		return false;
	}

	const mode = new URLSearchParams(location.search).get("mode") || "item";

	const $ = (id) => document.getElementById(id);
	const els = {};
	let currentItem = null;
	let referenced = [];     // @ 引用的条目
	let busy = false;

	document.addEventListener("DOMContentLoaded", init);
	if (document.readyState !== "loading") init();

	let inited = false;
	async function init() {
		if (inited) return;
		inited = true;

		els.messages = $("pl-messages");
		els.input = $("pl-input");
		els.send = $("pl-btn-send");
		els.status = $("pl-status");
		els.label = $("pl-context-label");
		els.stats = $("pl-stats");
		els.refChips = $("pl-ref-chips");

		// 先等一会儿：刚启动就开始恢复的标签页会早于插件初始化
		if (!PL) {
			showError("PaperLoom 正在加载…");
			const ready = await waitForDomainLayer(20000);
			if (!ready) {
				showError("PaperLoom 领域层尚未就绪（Zotero.PaperLoom 不可用）。"
					+ "请关闭本页后再点一次工具栏按钮；如果仍然如此，再重启 Zotero。");
				return;
			}
			// 清掉"正在加载"的提示
			els.messages.innerHTML = "";
		}

		els.send.addEventListener("click", onSend);
		els.input.addEventListener("keydown", onKeyDown);
		els.input.addEventListener("input", onInput);
		$("pl-btn-clear").addEventListener("click", () => { els.messages.innerHTML = ""; });
		$("pl-btn-clear-history").addEventListener("click", clearHistory);
		$("pl-btn-graph").addEventListener("click", () => openPanel("graph"));
		$("pl-btn-memory").addEventListener("click", () => openPanel("memory"));
		$("pl-btn-settings").addEventListener("click", () => openPanel("settings"));
		$("pl-btn-font-down").addEventListener("click", () => applyFont(currentFont() - 1));
		$("pl-btn-font-up").addEventListener("click", () => applyFont(currentFont() + 1));
		initEffort();

		window.addEventListener("message", (ev) => {
			const msg = ev.data;
			if (!msg) return;
			if (msg.type === "paperloom:item") setItemByKey(msg.itemKey, msg.libraryID);
		});

		if (mode === "library") {
			els.label.textContent = "全库对话";
			renderIntro("全库模式：问题会在整个已解析的文献库中检索。用 @ 可以把特定论文钉进上下文。");
			restoreHistory();
		}
		else {
			els.label.textContent = "当前论文";
			renderIntro("选中一篇论文开始提问。输入 @ 可引用库里的其他论文。");
			// 侧栏首次加载时可能已经有选中条目
			tryPickSelectedItem();
		}

		applyFont(currentFont());
		refreshStats();
	}

	function tryPickSelectedItem() {
		try {
			const pane = Zotero.getActiveZoteroPane();
			const items = pane && pane.getSelectedItems();
			if (items && items.length && items[0].isRegularItem()) {
				setItem(items[0]);
			}
		}
		catch (e) { /* 侧栏会通过 postMessage 再投递一次 */ }
	}

	async function setItemByKey(key, libraryID) {
		try {
			const id = await Zotero.Items.getIDFromLibraryAndKey(
				libraryID || Zotero.Libraries.userLibraryID, key);
			if (!id) return;
			setItem(await Zotero.Items.getAsync(id));
		}
		catch (e) { /* ignore */ }
	}

	/**
	 * 正在阅读的论文：如果当前标签页是一个打开的 PDF，就用它的父条目。
	 * 这样"打开论文 PDF 后再问 AI"会以正在看的那篇为准，而不是列表里碰巧选中的条目。
	 */
	function activePaperItem() {
		try {
			const win = Zotero.getMainWindow ? Zotero.getMainWindow() : null;
			const tabs = win && win.Zotero_Tabs;
			let reader = null;

			if (tabs && tabs.selectedID && Zotero.Reader && Zotero.Reader.getByTabID) {
				reader = Zotero.Reader.getByTabID(tabs.selectedID);
			}

			if (!reader) {
				const readers = (Zotero.Reader && Zotero.Reader._readers) || [];
				reader = readers[readers.length - 1] || null;
			}
			if (!reader || !reader.itemID) return null;

			const att = Zotero.Items.get(reader.itemID);
			if (!att) return null;
			if (att.parentItemID) return Zotero.Items.get(att.parentItemID) || null;
			return (att.isRegularItem && att.isRegularItem()) ? att : null;
		}
		catch (e) {
			return null;
		}
	}

	/** 用户可能在列表里选中的是 PDF 附件：统一换成它的父条目 */
	function normalizeItem(item) {
		try {
			if (item && item.isAttachment && item.isAttachment() && item.parentItemID) {
				return Zotero.Items.get(item.parentItemID) || item;
			}
		}
		catch (e) { /* 保持原样 */ }
		return item;
	}

	function setItem(item) {
		item = normalizeItem(item);
		if (currentItem && item && currentItem.key === item.key) return;
		currentItem = item;
		restoreHistory();
		if (mode !== "library" && item) {
			els.label.textContent = String(item.getField("title") || item.key).slice(0, 60);
		}
	}

	// ------------------------------------------------------------ 历史恢复

	let historyKey = null;

	/**
	 * 从 turns.json 里恢复这段对话。
	 * Zotero 重启后 iframe 是新的，DOM 不会保留；但每一轮都已经落盘了，
	 * 所以这里按"当前论文"重新渲染出来。
	 */
	async function restoreHistory() {
		if (!PL || !PL.Pipeline || !PL.Pipeline.recentTurns) return;

		const key = currentItem ? currentItem.key : "__library__";
		if (historyKey === key) return;
		historyKey = key;

		try {
			const turns = await PL.Pipeline.recentTurns(currentItem ? currentItem.key : null, 20);
			els.messages.innerHTML = "";
			if (!turns || !turns.length) return;

			for (const t of turns) {
				renderUserMessage(t.query || "");
				renderAnswer({
					answer: t.answer || "",
					citations: t.citations || [],
					titles: {},
					intent: "single_fact",
					memoryUsed: [],
					usage: t.usage || null,
					turn: t,
					warnings: [],
					sources: []
				});
			}
			scrollToBottom();
		}
		catch (e) {
			/* 历史读不出来不影响新对话 */
		}
	}

	/** 真正删除落盘的历史（清屏只是清显示） */
	async function clearHistory() {
		const label = currentItem ? "当前论文" : "全库";
		let ok = true;
		try { ok = window.confirm("删除" + label + "的全部对话历史？此操作不可撤销。"); }
		catch (e) { /* 无 confirm 上下文时直接执行 */ }
		if (!ok) return;

		try {
			const removed = await PL.Pipeline.clearTurns(currentItem ? currentItem.key : null);
			els.messages.innerHTML = "";
			historyKey = null;
			renderIntro("历史已删除（" + removed + " 轮）。");
		}
		catch (e) {
			showError("删除历史失败：" + e);
		}
	}

	// ------------------------------------------------------------ 发送

	function onKeyDown(ev) {
		if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
			ev.preventDefault();
			onSend();
			return;
		}
		if (autocomplete.visible) autocomplete.onKeyDown(ev);
	}

	async function onSend() {
		if (busy) return;
		const query = els.input.value.trim();
		if (!query) return;

		let askItem = mode === "library" ? null : (activePaperItem() || currentItem);

		if (mode !== "library" && !askItem) {
			tryPickSelectedItem();
			askItem = activePaperItem() || currentItem;
			if (!askItem) {
				showError("请先在文库中选中一篇论文，或打开它的 PDF。");
				return;
			}
		}

		busy = true;
		els.send.disabled = true;
		els.input.value = "";
		renderUserMessage(query);

		const pending = renderPending();

		try {
			const result = await PL.Pipeline.ask({
				query: stripRefMarkers(query),
				item: askItem,
				referencedItems: referenced.slice(),
				onProgress: (stage, info) => {
					pending.textContent = stageLabel(stage, info);
				}
			});
			pending.remove();
			renderAnswer(result);

			// 行为写入路径：追问"X 是什么"这类定义性问题，是"需要更基础解释"的信号
			if (result.intent === "concept" && PL.Memory.recordBehavior) {
				PL.Memory.recordBehavior({
					type: "asked.definition",
					turnId: result.turn && result.turn.turnId
				}).catch(() => { });
			}

			clearReferences();
			refreshStats();
		}
		catch (e) {
			pending.remove();
			showError(String(e && e.message || e));
		}
		finally {
			busy = false;
			els.send.disabled = false;
			els.input.focus();
		}
	}

	function stageLabel(stage, info) {
		const map = {
			parsing: "解析论文全文…",
			intent: "意图判定：" + info,
			retrieving: "检索证据（当前论文 / 全库 / 图谱 / 记忆）…",
			thinking: "模型生成中…",
			graph: "写入图谱增量…",
			memory: "更新记忆…"
		};
		return map[stage] || "处理中…";
	}

	// ------------------------------------------------------------ 渲染

	function renderIntro(text) {
		const div = document.createElement("div");
		div.className = "pl-empty";
		div.textContent = text;
		els.messages.appendChild(div);
	}

	function renderUserMessage(text) {
		const div = document.createElement("div");
		div.className = "pl-msg pl-user";
		div.textContent = text;
		els.messages.appendChild(div);
		scrollToBottom();
	}

	function renderPending() {
		const div = document.createElement("div");
		div.className = "pl-msg pl-muted";
		div.textContent = "处理中…";
		els.messages.appendChild(div);
		scrollToBottom();
		return div;
	}

	function showError(text) {
		const div = document.createElement("div");
		div.className = "pl-msg pl-error";
		div.textContent = text;
		els.messages.appendChild(div);
		scrollToBottom();
	}

	function renderAnswer(result) {
		const wrap = document.createElement("div");
		wrap.className = "pl-msg";

		// 正文：把 [PID:xxx, p.3] 渲染成可点击 chip
		const body = document.createElement("div");
		renderAnswerBody(body, result.answer || "", result.citations || [], result.titles || {});
		wrap.appendChild(body);

		// 警告（跨篇不足 / 页码不精确 / 引用定位失败…）
		for (const w of result.warnings || []) {
			const warn = document.createElement("div");
			warn.className = "pl-warning";
			warn.textContent = "⚠ " + w;
			wrap.appendChild(warn);
		}

		// 元信息行
		const meta = document.createElement("div");
		meta.className = "pl-msg-meta";

		const intent = document.createElement("span");
		intent.className = "pl-intent-badge";
		intent.textContent = intentLabel(result.intent);
		meta.appendChild(intent);

		// ★ token 用量：输入（缓存命中 / 命中率）· 输出
		const u = result.usage || (result.turn && result.turn.usage) || null;
		if (u) {
			const usage = document.createElement("span");
			usage.className = "pl-intent-badge";
			if (u.localCache) {
				usage.textContent = "本地缓存命中 · 未消耗 token";
			}
			else {
				const rate = u.input > 0 ? Math.round((u.cached / u.input) * 1000) / 10 : 0;
				usage.textContent = "输入 " + fmtTokens(u.input)
					+ (u.cached ? "（缓存 " + fmtTokens(u.cached) + " · " + rate + "%）" : "")
					+ " · 输出 " + fmtTokens(u.output);
			}
			usage.title = "total_tokens " + fmtTokens(u.total || 0)
				+ (u.cached ? "\n缓存命中的输入 token 不计费或按更低价格计费（取决于服务商）" : "");
			meta.appendChild(usage);
		}

		// ★「本次使用了 N 条记忆」
		const memCount = (result.memoryUsed || []).length;
		const badge = document.createElement("span");
		badge.className = "pl-memory-badge";
		badge.textContent = "本次使用了 " + memCount + " 条记忆";
		badge.title = "点击查看具体用了哪些记忆";
		meta.appendChild(badge);

		const detail = document.createElement("div");
		detail.className = "pl-memory-detail";
		detail.style.display = "none";
		if (memCount) {
			detail.textContent = (result.memoryUsed || [])
				.map(f => f.key + " = " + f.value + "（" + Number(f.confidence).toFixed(2) + "，" + f.origin + "）")
				.join("\n");
		}
		else {
			detail.textContent = "还没有记住关于你的任何事。多聊几轮，或在记忆面板里手动添加。";
		}
		badge.addEventListener("click", () => {
			detail.style.display = detail.style.display === "none" ? "block" : "none";
		});

		// 新写入的记忆
		const applied = (result.memoryApplied || []).filter(r => r.action === "created" || r.action === "updated");
		if (applied.length) {
			const note = document.createElement("span");
			note.className = "pl-memory-badge";
			note.style.background = "rgba(45,156,90,0.14)";
			note.style.color = "var(--pl-green)";
			note.textContent = "已记住：" + applied.map(r => r.fact.key + "=" + r.fact.value).join("，");
			meta.appendChild(note);
		}

		// 图谱增量
		if (result.diff) {
			const g = document.createElement("span");
			g.className = "pl-intent-badge";
			g.textContent = "图谱 +" + (result.diff.addedNodes || []).length + " 节点 / +"
				+ (result.diff.addedEdges || []).length + " 边";
			meta.appendChild(g);
		}

		wrap.appendChild(meta);
		wrap.appendChild(detail);

		// 引用清单
		// 引用已按段落生成脚注（见 renderAnswerBody）；
		// 只有模型完全没给引用时，才退回"本轮证据"列表。
		const cites = result.citations || [];
		if (!cites.length) {
			const sources = result.sources || [];
			if (sources.length) {
				const head = document.createElement("div");
				head.className = "pl-msg-meta";
				head.textContent = "来源（本轮提供的原文证据）";
				wrap.appendChild(head);

				const box = document.createElement("div");
				box.className = "pl-footnotes";
				for (const s of sources) {
					const line = document.createElement("div");
					line.className = "pl-footnote";
					line.textContent = "p." + (s.page || "?") + " · "
						+ (s.title || s.paperId) + " — “" + String(s.quote || "").slice(0, 120) + "”";
					line.title = "点击打开原文并高亮这句话";
					line.addEventListener("click", () => jumpTo(s.paperId, s.page, s.quote));
					box.appendChild(line);
				}
				wrap.appendChild(box);
			}
		}

		els.messages.appendChild(wrap);
		scrollToBottom();
	}

	/** 千分位，避免 12345 这种数字难读 */
	function fmtTokens(n) {
		return Number(n || 0).toLocaleString("en-US");
	}

	// ------------------------------------------------------------ 字号

	const FONT_PREF = "extensions.paperloom.fontSize";

	function currentFont() {
		try {
			const v = parseInt(Zotero.Prefs.get(FONT_PREF, true), 10);
			if (Number.isFinite(v)) return v;
		}
		catch (e) { /* ignore */ }
		return 13;
	}

	// ------------------------------------------------------------ 推理强度

	const EFFORT_PREF = "extensions.paperloom.reasoningEffort";

	// 不用原生 select：chrome iframe 里弹层经常点不开，改成点击循环切换
	const EFFORT_LEVELS = [
		{ value: "", label: "自动" },
		{ value: "low", label: "低" },
		{ value: "high", label: "高" },
		{ value: "max", label: "最大" }
	];

	function readEffort() {
		try { return String(Zotero.Prefs.get(EFFORT_PREF, true) || ""); }
		catch (e) { return ""; }
	}

	function initEffort() {
		const btn = $("pl-effort");
		if (!btn) return;

		const render = () => {
			const cur = readEffort();
			const item = EFFORT_LEVELS.find(x => x.value === cur) || EFFORT_LEVELS[0];
			btn.textContent = "强度：" + item.label;
		};

		render();
		btn.addEventListener("click", () => {
			const cur = readEffort();
			const idx = Math.max(0, EFFORT_LEVELS.findIndex(x => x.value === cur));
			const next = EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length];
			try { Zotero.Prefs.set(EFFORT_PREF, next.value, true); } catch (e) { /* ignore */ }
			render();
			if (els.status) els.status.textContent = "推理强度：" + next.label;
		});
	}

	/** 用 zoom 整体缩放对话区：比逐个改 CSS 字号稳，滚动条也会一起收放 */
	function applyFont(size) {
		const px = Math.max(10, Math.min(22, size));
		document.body.style.zoom = String(px / 13);
		try { Zotero.Prefs.set(FONT_PREF, px, true); } catch (e) { /* ignore */ }
	}

	function intentLabel(intent) {
		return {
			single_fact: "单篇事实",
			cross_paper: "跨篇比较",
			concept: "概念解释",
			meta: "元问题"
		}[intent] || String(intent || "");
	}

	/**
	 * 渲染答案正文：轻量 markdown + 引用 chip。
	 * 全程用 DOM 构造，不拼 innerHTML —— 模型输出属于不可信内容，
	 * 这样等价于 marked + DOMPurify 的效果，但不引入外部库。
	 */
	function renderAnswerBody(container, text, citations, titles) {
		const lines = String(text || "").split("\n");
		const citeIndex = new Map();   // key -> { num, citation }
		let number = 0;
		let list = null;

		const keyOf = (c) => (c.chunkId || "") + "|" + c.paperId + "|" + c.page;

		const registerCitation = (matched, paperId, page) => {
			const c = matched || {
				paperId: paperId, page: page, valid: false,
				errors: ["引用未出现在 citations 中"]
			};
			const key = keyOf(c);
			if (!citeIndex.has(key)) {
				number += 1;
				citeIndex.set(key, { num: number, citation: c });
			}
			return citeIndex.get(key);
		};

		// 报告式脚注：引用不塞在句子里，而是在这一段下面单独一行
		const appendFootnotes = (usedKeys) => {
			if (!usedKeys.length) return;
			const box = document.createElement("div");
			box.className = "pl-footnotes";

			for (const key of usedKeys) {
				const entry = citeIndex.get(key);
				if (!entry) continue;
				const c = entry.citation;

				const line = document.createElement("div");
				line.className = "pl-footnote";
				line.textContent = "[" + entry.num + "]"
					+ (c.page ? " p." + c.page : "")
					+ " · " + (c.title || (titles && titles[c.paperId]) || c.paperId)
					+ (c.quote ? " — “" + String(c.quote).slice(0, 120) + "”" : "");
				line.title = "点击打开原文并高亮这句话";
				line.addEventListener("click", () => jumpTo(c.paperId, c.page, c.quote));
				box.appendChild(line);
			}
			container.appendChild(box);
		};

		for (const raw of lines) {
			const line = raw.replace(/\s+$/, "");
			if (!line.trim()) { list = null; continue; }

			const used = [];

			// 标题
			const h = line.match(/^(#{1,4})\s+(.*)$/);
			if (h) {
				list = null;
				const el = document.createElement("div");
				el.className = "pl-md-h pl-md-h" + h[1].length;
				renderInline(el, h[2], citations, titles, used, registerCitation, keyOf);
				container.appendChild(el);
				appendFootnotes(used);
				continue;
			}

			// 引用块
			const quote = line.match(/^>\s?(.*)$/);
			if (quote) {
				list = null;
				const el = document.createElement("blockquote");
				el.className = "pl-md-quote";
				renderInline(el, quote[1], citations, titles, used, registerCitation, keyOf);
				container.appendChild(el);
				appendFootnotes(used);
				continue;
			}

			// 列表项
			const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
			if (li) {
				if (!list) {
					list = document.createElement("ul");
					list.className = "pl-md-list";
					container.appendChild(list);
				}
				const item = document.createElement("li");
				renderInline(item, li[1], citations, titles, used, registerCitation, keyOf);
				list.appendChild(item);
				appendFootnotes(used);
				continue;
			}

			// 普通段落
			list = null;
			const p = document.createElement("div");
			p.className = "pl-md-p";
			renderInline(p, line, citations, titles, used, registerCitation, keyOf);
			container.appendChild(p);
			appendFootnotes(used);
		}
	}

	/**
	 * 行内：**粗体** / `代码` / [PID, p.3] 引用。
	 * 引用渲染成上标编号，并把对应脚注记到 used 里，由调用方在该段落后输出。
	 */
	function renderInline(container, text, citations, titles, used, registerCitation, keyOf) {
		const re = /\[(?:PID:)?\s*([A-Za-z0-9_-]+)\s*,?\s*p\.?\s*(\d+)\s*\]|`([^`]+)`|\*\*([^*]+)\*\*/g;
		let last = 0;
		let m;

		while ((m = re.exec(text)) !== null) {
			if (m.index > last) {
				container.appendChild(document.createTextNode(text.slice(last, m.index)));
			}

			if (m[1] !== undefined) {
				const paperId = m[1];
				const page = parseInt(m[2], 10);
				const matched = citations.find(c => c.paperId === paperId && Number(c.page) === page)
					|| citations.find(c => c.paperId === paperId);

				const entry = registerCitation(matched, paperId, page);
				used.push(keyOf(entry.citation));

				const sup = document.createElement("sup");
				sup.className = "pl-cite-mark" + (entry.citation.valid === false ? " pl-cite-invalid" : "");
				sup.textContent = "[" + entry.num + "]";
				sup.title = "点击打开原文并高亮这句话";
				sup.addEventListener("click", () => jumpTo(
					entry.citation.paperId, entry.citation.page, entry.citation.quote
				));
				container.appendChild(sup);
			}
			else if (m[3] !== undefined) {
				const code = document.createElement("code");
				code.textContent = m[3];
				container.appendChild(code);
			}
			else if (m[4] !== undefined) {
				const b = document.createElement("strong");
				b.textContent = m[4];
				container.appendChild(b);
			}

			last = re.lastIndex;
		}

		if (last < text.length) {
			container.appendChild(document.createTextNode(text.slice(last)));
		}
	}

	function makeCiteChip(citation, index, titles, opts) {
		opts = opts || {};
		const chip = document.createElement("span");
		chip.className = "pl-cite" + (citation.valid === false ? " pl-cite-invalid" : "");

		const page = opts.page || citation.page;
		const title = citation.title || titles[citation.paperId] || citation.paperId;
		chip.textContent = (index ? "[" + index + "] " : "")
			+ String(title).slice(0, 24) + (page ? ", p." + page : "");

		if (citation.valid === false) {
			chip.title = "引用无法定位：" + ((citation.errors || []).join("；") || "未知原因");
		}
		else {
			chip.title = (citation.quote ? "“" + String(citation.quote).slice(0, 160) + "”\n\n" : "")
				+ "点击跳转到原文第 " + page + " 页";
			chip.addEventListener("click", () => jumpTo(citation.paperId, page, citation.quote));
		}
		return chip;
	}

	/**
	 * 跳转到原文页。
	 * 首选 Zotero.Reader.open(attachmentID, location)，失败退回 zotero://open-pdf URI
	 * （后者是官方支持的格式，比私有 API 稳）。
	 */
	/**
	 * 决定"跳到哪一份 PDF"。
	 * 同一篇论文可能同时有原版和翻译版，必须优先用用户当前实际打开的/选中的那份，
	 * 否则点引用会莫名跳到原版。
	 */
	/**
	 * 列出这篇论文所有可打开的 PDF 候选，按优先级排序：
	 *   1. 当前已经打开的 reader（用户正在看的，可能是翻译版）
	 *   2. 文献列表里当前选中的附件
	 *   3. 解析记录里的默认附件
	 *   4. 该条目下所有 PDF 附件
	 * 任何一步出错都只是跳过，不影响后面的候选。
	 */
	async function candidateAttachments(paperId) {
		const out = [];
		const push = (id) => {
			if (id && !out.includes(id)) out.push(id);
		};

		try {
			const readers = (Zotero.Reader && Zotero.Reader._readers) || [];
			for (const r of readers) {
				if (!r.itemID) continue;
				const att = Zotero.Items.get(r.itemID);
				if (!att || !att.parentItemID) continue;
				const parent = Zotero.Items.get(att.parentItemID);
				if (parent && parent.key === paperId) push(r.itemID);
			}
		}
		catch (e) { /* 跳过 */ }

		try {
			const pane = Zotero.getActiveZoteroPane();
			for (const it of (pane && pane.getSelectedItems()) || []) {
				if (it.isAttachment && it.isAttachment() && it.parentItemID) {
					const parent = Zotero.Items.get(it.parentItemID);
					if (parent && parent.key === paperId) push(it.id);
				}
			}
		}
		catch (e) { /* 跳过 */ }

		try {
			const doc = await PL.Storage.readPaperDoc(paperId);
			push(doc && doc.attachmentId);
		}
		catch (e) { /* 跳过 */ }

		try {
			const id = await Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, paperId);
			const item = id ? Zotero.Items.get(id) : null;
			if (item && item.getAttachments) {
				for (const aid of item.getAttachments() || []) {
					const att = Zotero.Items.get(aid);
					if (att && att.attachmentContentType === "application/pdf") push(att.id);
				}
			}
		}
		catch (e) { /* 跳过 */ }

		return out;
	}

	async function jumpTo(paperId, page, quote) {
		try {
			const candidates = await candidateAttachments(paperId);
			if (!candidates.length) {
				const id = await Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, paperId);
				if (id) Zotero.getActiveZoteroPane().selectItem(id);
				showError("这篇论文找不到可打开的 PDF 附件。");
				return;
			}

			// 只打开第一份：多候选循环会把原版和翻译版各开一个标签页
			const attachmentId = candidates[0];
			const pageIndex = Math.max(0, (page || 1) - 1);

			try {
				await Zotero.Reader.open(attachmentId, { pageIndex: pageIndex });
				if (quote) highlightWithRetry(attachmentId, page, quote);
				return;
			}
			catch (e) {
				// 不用 zotero:// URI：它会弹 "Open the Zotero link with Zotero?" 确认框
				const att = await Zotero.Items.getAsync(attachmentId);
				if (att && att.parentItemID) Zotero.getActiveZoteroPane().selectItem(att.parentItemID);
				showError("打开 PDF 失败：" + e);
			}
		}
		catch (e) {
			showError("跳转失败：" + e);
		}
	}

	// ------------------------------------------------------------ 原文高亮

	/**
	 * 在阅读器里高亮引用的那一句（而不是整页）。
	 * 只在文本层 DOM 上加临时背景色，不写入 Zotero 标注库。
	 */
	/** 把目标元素滚到阅读器视口的垂直中间（阅读器导航后会再校正一次，所以多压几次） */
	function centerElement(doc, el) {
		try {
			const container = doc.getElementById("viewerContainer")
				|| doc.querySelector(".viewer-container")
				|| doc.scrollingElement;
			if (!container) return;

			const r = el.getBoundingClientRect();
			const c = container.getBoundingClientRect
				? container.getBoundingClientRect()
				: { top: 0, height: container.clientHeight || 0 };

			const delta = (r.top + r.height / 2) - (c.top + c.height / 2);
			if (Math.abs(delta) > 4) container.scrollTop = (container.scrollTop || 0) + delta;
		}
		catch (e) {
			try { el.scrollIntoView({ block: "center" }); } catch (e2) { /* ignore */ }
		}
	}

	// 每次点击递增；旧的等待循环发现序号变了就退出，避免两个引用互相跳页
	let highlightSeq = 0;

	async function highlightInReader(attachmentId, page, quote) {
		const readers = (Zotero.Reader && Zotero.Reader._readers) || [];
		const reader = readers.find(r => r.itemID === attachmentId);
		if (!reader) return false;

		let win = null;
		try {
			win = reader._iframeWindow && (reader._iframeWindow.wrappedJSObject || reader._iframeWindow);
		}
		catch (e) {
			return false;
		}
		if (!win || !win.document) return false;

		const docs = [win.document];
		try {
			for (let i = 0; i < win.frames.length; i++) docs.push(win.frames[i].document);
		}
		catch (e) { /* 跨域 frame 跳过 */ }

		// 只保留字母/数字/汉字，大小写归一：绕开连字符、引号、软连字符等排版差异
		const squash = (v) => String(v || "")
			.toLowerCase()
			.replace(/[\s ]+/g, "")
			.replace(/[^\p{L}\p{N}]+/gu, "");

		const key = squash(quote);
		if (!key) return false;

		for (const doc of docs) {
			const layers = Array.from(doc.querySelectorAll(".textLayer"));
			if (!layers.length) continue;

			// 目标页优先，其次全文档
			const targetPage = layers.find((l) => {
				const p = l.closest("[data-page-number]");
				return p && Number(p.getAttribute("data-page-number")) === Number(page);
			});
			const ordered = targetPage
				? [targetPage].concat(layers.filter(l => l !== targetPage))
				: layers;

			for (const layer of ordered) {
				const spans = Array.from(layer.querySelectorAll("span"));
				if (!spans.length) continue;

				let full = "";
				const ranges = [];
				for (const sp of spans) {
					const t = squash(sp.textContent);
					if (!t) continue;
					ranges.push({ span: sp, start: full.length, end: full.length + t.length });
					full += t;
				}
				if (!full) continue;

				// 从长到短试前缀，排版差异越大越可能只能靠短片段命中
				let from = -1;
				for (const size of [40, 30, 20, 12]) {
					if (key.length < size) continue;
					const idx = full.indexOf(key.slice(0, size));
					if (idx >= 0) { from = idx; break; }
				}
				if (from < 0) continue;

				for (const el of doc.querySelectorAll(".paperloom-hl")) el.classList.remove("paperloom-hl");

				if (!doc.getElementById("paperloom-hl-style")) {
					const style = doc.createElement("style");
					style.id = "paperloom-hl-style";
					style.textContent = ".paperloom-hl{background:rgba(255,214,0,.6)!important;border-radius:2px;box-shadow:0 0 0 2px rgba(255,214,0,.35);}";
					(doc.head || doc.documentElement).appendChild(style);
				}

				const to = from + Math.min(key.length, 80);
				let first = null;
				for (const r of ranges) {
					if (r.end <= from || r.start >= to) continue;
					r.span.classList.add("paperloom-hl");
					if (!first) first = r.span;
				}

				if (first) {
					const seqAtMatch = highlightSeq;
					const recenter = () => {
						if (seqAtMatch !== highlightSeq) return;   // 已有新的点击
						centerElement(doc, first);
					};
					recenter();
					setTimeout(recenter, 250);
					setTimeout(recenter, 700);
					setTimeout(recenter, 1400);
					try { Zotero.debug("[PaperLoom] 高亮命中 p." + page + "（span " + ranges.length + "）"); } catch (e2) { }
					return true;
				}
			}
		}

		try {
			let layers = 0;
			let spans = 0;
			for (const d of docs) {
				layers += d.querySelectorAll(".textLayer").length;
				spans += d.querySelectorAll(".textLayer span").length;
			}
			Zotero.debug("[PaperLoom] 高亮未命中 p." + page + "，文本层 " + layers + "，span " + spans);
		}
		catch (e) { /* ignore */ }

		return false;
	}

	/** 打开后等页面渲染；有新的点击就放弃旧循环，避免互相跳页 */
	async function highlightWithRetry(attachmentId, page, quote) {
		const seq = ++highlightSeq;

		// 只在开始时导航一次
		try {
			const readers = (Zotero.Reader && Zotero.Reader._readers) || [];
			const reader = readers.find(r => r.itemID === attachmentId);
			if (reader && reader.navigate) {
				await reader.navigate({ pageIndex: Math.max(0, (page || 1) - 1) });
			}
		}
		catch (e) { /* ignore */ }

		for (let i = 0; i < 20; i++) {
			await new Promise(r => setTimeout(r, 400));
			if (seq !== highlightSeq) return false;      // 已被更新的点击取代
			try {
				if (await highlightInReader(attachmentId, page, quote)) return true;
			}
			catch (e) { /* 重试 */ }
		}
		return false;
	}

	function openPanel(kind) {
		try {
			const win = Zotero.getMainWindow();
			const menu = win.document.getElementById("paperloom-menu-" + kind);
			if (menu) menu.doCommand();
		}
		catch (e) { /* ignore */ }
	}

	function scrollToBottom() {
		els.messages.scrollTop = els.messages.scrollHeight;
	}

	async function refreshStats() {
		try {
			const [stats, facts] = await Promise.all([PL.GraphStore.stats(), PL.Memory.all()]);
			els.stats.textContent = "图谱 " + stats.nodes + " 节点 / " + stats.edges + " 边 · 记忆 " + facts.length + " 条";
		}
		catch (e) { /* ignore */ }
	}

	// ------------------------------------------------------------ @ 引用

	const autocomplete = {
		visible: false,
		box: null,
		items: [],
		active: 0,

		show(candidates, anchorRect) {
			this.hide();
			if (!candidates.length) return;
			const box = document.createElement("div");
			box.className = "pl-autocomplete";
			candidates.forEach((item, i) => {
				const row = document.createElement("div");
				const year = (String(item.getField("date") || "").match(/\d{4}/) || [""])[0];
				row.textContent = (item.getField("title") || item.key) + (year ? " (" + year + ")" : "");
				if (i === 0) row.className = "pl-active";
				row.addEventListener("mousedown", (ev) => {
					ev.preventDefault();
					autocomplete.pick(i);
				});
				box.appendChild(row);
			});
			box.style.left = (anchorRect.left) + "px";
			box.style.bottom = (window.innerHeight - anchorRect.top + 4) + "px";
			document.body.appendChild(box);
			this.box = box;
			this.items = candidates;
			this.active = 0;
			this.visible = true;
		},

		hide() {
			if (this.box) this.box.remove();
			this.box = null;
			this.visible = false;
			this.items = [];
		},

		onKeyDown(ev) {
			if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
				ev.preventDefault();
				const delta = ev.key === "ArrowDown" ? 1 : -1;
				this.active = (this.active + delta + this.items.length) % this.items.length;
				Array.from(this.box.children).forEach((c, i) => {
					c.className = i === this.active ? "pl-active" : "";
				});
			}
			else if (ev.key === "Enter" || ev.key === "Tab") {
				ev.preventDefault();
				this.pick(this.active);
			}
			else if (ev.key === "Escape") {
				this.hide();
			}
		},

		pick(i) {
			const item = this.items[i];
			this.hide();
			if (!item) return;
			addReference(item);
			// 删掉输入框里的 @query
			const v = els.input.value;
			els.input.value = v.replace(/@[^\s@]*$/, "");
			els.input.focus();
		}
	};

	let acTimer = null;
	function onInput() {
		if (acTimer) clearTimeout(acTimer);
		const v = els.input.value;
		const m = v.match(/@([^\s@]*)$/);
		if (!m) { autocomplete.hide(); return; }
		acTimer = setTimeout(() => searchItems(m[1]), 160);
	}

	async function searchItems(term) {
		try {
			const search = new Zotero.Search();
			search.libraryID = Zotero.Libraries.userLibraryID;
			if (term) search.addCondition("quicksearch-titleCreatorYear", "contains", term);
			search.addCondition("itemType", "isNot", "attachment");
			const ids = await search.search();
			const items = (await Zotero.Items.getAsync(ids.slice(0, 80)))
				.filter(it => it.isRegularItem())
				.slice(0, 8);
			if (!items.length) { autocomplete.hide(); return; }
			autocomplete.show(items, els.input.getBoundingClientRect());
		}
		catch (e) {
			autocomplete.hide();
		}
	}

	function addReference(item) {
		if (referenced.some(r => r.key === item.key)) return;
		referenced.push(item);
		renderReferences();
	}

	function clearReferences() {
		referenced = [];
		renderReferences();
	}

	function renderReferences() {
		els.refChips.innerHTML = "";
		for (const item of referenced) {
			const chip = document.createElement("span");
			chip.className = "pl-ref-chip";
			chip.textContent = "@" + String(item.getField("title") || item.key).slice(0, 26);
			const close = document.createElement("button");
			close.textContent = "×";
			close.addEventListener("click", () => {
				referenced = referenced.filter(r => r.key !== item.key);
				renderReferences();
			});
			chip.appendChild(close);
			els.refChips.appendChild(chip);
		}
	}

	function stripRefMarkers(q) {
		return q.replace(/@[^\s@]*$/, "").trim() || q;
	}
})();
