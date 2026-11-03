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
		$("pl-btn-graph").addEventListener("click", () => openPanel("graph"));
		$("pl-btn-memory").addEventListener("click", () => openPanel("memory"));
		$("pl-btn-settings").addEventListener("click", () => openPanel("settings"));

		window.addEventListener("message", (ev) => {
			const msg = ev.data;
			if (!msg) return;
			if (msg.type === "paperloom:item") setItemByKey(msg.itemKey, msg.libraryID);
		});

		if (mode === "library") {
			els.label.textContent = "全库对话";
			renderIntro("全库模式：问题会在整个已解析的文献库中检索。用 @ 可以把特定论文钉进上下文。");
		}
		else {
			els.label.textContent = "当前论文";
			renderIntro("选中一篇论文开始提问。输入 @ 可引用库里的其他论文。");
			// 侧栏首次加载时可能已经有选中条目
			tryPickSelectedItem();
		}

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
		if (mode !== "library" && item) {
			els.label.textContent = String(item.getField("title") || item.key).slice(0, 60);
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

		if (mode !== "library" && !currentItem) {
			tryPickSelectedItem();
			if (!currentItem) {
				showError("请先在文库中选中一篇论文。");
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
				item: mode === "library" ? null : currentItem,
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
		const cites = result.citations || [];
		if (cites.length) {
			const list = document.createElement("div");
			list.className = "pl-msg-meta";
			list.appendChild(document.createTextNode("引用："));
			cites.forEach((c, i) => list.appendChild(makeCiteChip(c, i + 1, result.titles || {})));
			wrap.appendChild(list);
		}

		els.messages.appendChild(wrap);
		scrollToBottom();
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
		let list = null;

		const flushList = () => { list = null; };

		for (const raw of lines) {
			const line = raw.replace(/\s+$/, "");

			if (!line.trim()) { flushList(); continue; }

			// 标题
			const h = line.match(/^(#{1,4})\s+(.*)$/);
			if (h) {
				flushList();
				const el = document.createElement("div");
				el.className = "pl-md-h";
				el.style.fontSize = (14 - h[1].length) + "px";
				el.style.fontWeight = "600";
				el.style.margin = "6px 0 2px";
				renderInline(el, h[2], citations, titles);
				container.appendChild(el);
				continue;
			}

			// 列表项（有序 / 无序）
			const li = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
			if (li) {
				if (!list) {
					list = document.createElement("ul");
					list.className = "pl-md-list";
					list.style.margin = "3px 0";
					list.style.paddingLeft = "18px";
					container.appendChild(list);
				}
				const item = document.createElement("li");
				renderInline(item, li[1], citations, titles);
				list.appendChild(item);
				continue;
			}

			// 普通段落
			flushList();
			const p = document.createElement("div");
			p.style.margin = "2px 0";
			renderInline(p, line, citations, titles);
			container.appendChild(p);
		}
	}

	/** 行内：**粗体** / `代码` / [PID:xxx, p.3] 引用 chip */
	function renderInline(container, text, citations, titles) {
		// 统一的分词正则：引用 > 代码 > 粗体
		const re = /\[(?:PID:)?\s*([A-Za-z0-9_-]+)\s*,?\s*p\.?\s*(\d+)\s*\]|`([^`]+)`|\*\*([^*]+)\*\*/g;
		let last = 0;
		let m;

		while ((m = re.exec(text)) !== null) {
			if (m.index > last) {
				container.appendChild(document.createTextNode(text.slice(last, m.index)));
			}

			if (m[1] !== undefined) {
				// 引用 chip
				const paperId = m[1];
				const page = parseInt(m[2], 10);
				const matched = citations.find(c => c.paperId === paperId && Number(c.page) === page)
					|| citations.find(c => c.paperId === paperId);
				container.appendChild(makeCiteChip(
					matched || { paperId, page, valid: false, errors: ["引用未出现在 citations 中"] },
					null, titles, { inline: true, page }
				));
			}
			else if (m[3] !== undefined) {
				const code = document.createElement("code");
				code.textContent = m[3];
				code.style.fontFamily = "ui-monospace, Menlo, monospace";
				code.style.fontSize = "11px";
				code.style.padding = "0 3px";
				code.style.borderRadius = "3px";
				code.style.background = "var(--pl-accent-soft)";
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
			chip.addEventListener("click", () => jumpTo(citation.paperId, page));
		}
		return chip;
	}

	/**
	 * 跳转到原文页。
	 * 首选 Zotero.Reader.open(attachmentID, location)，失败退回 zotero://open-pdf URI
	 * （后者是官方支持的格式，比私有 API 稳）。
	 */
	async function jumpTo(paperId, page) {
		try {
			const doc = await PL.Storage.readPaperDoc(paperId);
			const attachmentId = doc && doc.attachmentId;

			if (attachmentId && Zotero.Reader && Zotero.Reader.open) {
				try {
					await Zotero.Reader.open(attachmentId, { pageIndex: Math.max(0, (page || 1) - 1) });
					return;
				}
				catch (e) { /* 私有 API 变动，走下面的 URI 路径 */ }
			}

			// fallback：官方 URI。需要附件的 itemKey
			let attachmentKey = null;
			if (attachmentId) {
				const att = await Zotero.Items.getAsync(attachmentId);
				attachmentKey = att && att.key;
			}
			if (attachmentKey) {
				Zotero.launchURL("zotero://open-pdf/library/items/" + attachmentKey + "?page=" + (page || 1));
				return;
			}

			// 再退一步：至少把条目选中
			const id = await Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, paperId);
			if (id) Zotero.getActiveZoteroPane().selectItem(id);
		}
		catch (e) {
			showError("跳转失败：" + e);
		}
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
