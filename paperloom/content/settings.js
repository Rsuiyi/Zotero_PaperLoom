/* PaperLoom — settings.js
 * L3 表现层：设置界面（独立窗口 / Zotero 设置面板内嵌共用）。
 *
 * 结构对齐 PDF2zh：
 *   1. 服务商是一个列表（名称 / Base URL / 模型数），可新增、编辑、删除；
 *   2. 「新增服务商」弹一个小窗口，填 Base URL + API Key，点「获取模型列表」；
 *   3. 外面用两个下拉框，分别选对话模型与图谱抽取模型，可选不同服务商。
 */
(function () {
	"use strict";

	const EMBED = new URLSearchParams(location.search).get("embed") === "1";
	const NS = "extensions.paperloom.";

	/** 安全找 Zotero：跨域访问会抛错，一条失败不能炸掉整个脚本 */
	function pickZotero() {
		const candidates = [
			() => (window.arguments && window.arguments[0] && window.arguments[0].Zotero),
			() => (window.top && window.top.Zotero),
			() => (window.parent && window.parent.Zotero),
			() => (window.opener && window.opener.Zotero),
			() => window.Zotero
		];
		for (const get of candidates) {
			try {
				const v = get();
				if (v) return v;
			}
			catch (e) { /* 换下一条 */ }
		}
		return null;
	}

	function pickPaperLoom(z) {
		const candidates = [
			() => (window.arguments && window.arguments[0] && window.arguments[0].PaperLoom),
			() => (z && z.PaperLoom)
		];
		for (const get of candidates) {
			try {
				const v = get();
				if (v) return v;
			}
			catch (e) { /* 换下一条 */ }
		}
		return null;
	}

	const Zotero = pickZotero();
	const PL = pickPaperLoom(Zotero);

	// 子窗口（新增服务商）可能是用 window.open 打开的，拿不到 arguments，
	// 于是通过 opener 上的全局引用把 Zotero / 领域层传下去。
	try {
		window.__paperloomZotero = Zotero;
		window.__paperloomPL = PL;
	}
	catch (e) { /* ignore */ }

	const $ = (id) => document.getElementById(id);

	function setStatus(text, kind) {
		const el = $("status");
		if (!el) return;
		el.textContent = text || "";
		el.className = kind || "";
	}

	function prefGet(key, fallback) {
		try {
			const v = Zotero.Prefs.get(NS + key, true);
			return (v === undefined || v === null || v === "") ? fallback : v;
		}
		catch (e) {
			return fallback;
		}
	}

	function prefSet(key, value) {
		try {
			Zotero.Prefs.set(NS + key, value, true);
		}
		catch (e) { /* 记不下来也不影响当前界面 */ }
	}

	// ------------------------------------------------------------------ 推理强度（分段按钮）

	function renderEffortSeg() {
		const seg = $("effort-seg");
		if (!seg) return;
		const current = String(prefGet("reasoningEffort", ""));

		for (const btn of seg.querySelectorAll("button[data-effort]")) {
			btn.classList.toggle("active", (btn.getAttribute("data-effort") || "") === current);
		}
		const hint = $("effort-hint");
		if (hint) hint.textContent = current ? ("当前：" + current) : "自动 = 不发送推理参数";
	}

	function bindEffortSeg() {
		const seg = $("effort-seg");
		if (!seg) return;

		// 点哪个立刻生效并落盘，不需要再点保存
		seg.addEventListener("click", (ev) => {
			const btn = ev.target.closest ? ev.target.closest("button[data-effort]") : null;
			if (!btn) return;
			const value = btn.getAttribute("data-effort") || "";
			prefSet("reasoningEffort", value);
			renderEffortSeg();
			setStatus("推理强度已设为：" + (btn.textContent || "自动"), "ok");
		});
	}

	// ------------------------------------------------------------------ 通用参数

	function loadParams() {
		$("maxTokens").value = String(prefGet("maxTokens", 4096));
		$("temperature").value = String(prefGet("temperature", "0.3"));
		$("timeoutMs").value = String(prefGet("timeoutMs", 90000));
		$("useCache").checked = prefGet("useCache", true) !== false;
		$("dataDir").value = String(prefGet("dataDir", ""));
		$("systemPrompt").value = String(prefGet("systemPrompt", ""));
		$("fontSize").value = String(prefGet("fontSize", 13));
		renderEffortSeg();

		try {
			$("resolvedDir").textContent = PL ? PL.Storage.root() : "—";
		}
		catch (e) {
			$("resolvedDir").textContent = "—";
		}
	}

	function saveParams() {
		const n = parseInt($("maxTokens").value, 10);
		if (Number.isFinite(n)) prefSet("maxTokens", n);

		prefSet("temperature", String($("temperature").value || "0.3").trim());

		const t = parseInt($("timeoutMs").value, 10);
		if (Number.isFinite(t)) prefSet("timeoutMs", t);

		prefSet("useCache", !!$("useCache").checked);
		prefSet("dataDir", String($("dataDir").value || "").trim());
		// 系统提示词保留内部换行，只去掉首尾空白
		prefSet("systemPrompt", String($("systemPrompt").value || "").trim());

		const font = parseInt($("fontSize").value, 10);
		if (Number.isFinite(font)) prefSet("fontSize", Math.max(10, Math.min(22, font)));

		setStatus("已保存", "ok");
	}

	// ------------------------------------------------------------------ 服务商列表

	function renderProviders() {
		const body = $("providers-body");
		const table = body.closest("table");
		if (!body || !PL) return;

		const providers = PL.LLM.getProviders();
		body.innerHTML = "";

		$("providers-empty").style.display = providers.length ? "none" : "block";
		if (table) table.style.display = providers.length ? "table" : "none";

		for (const p of providers) {
			const tr = document.createElement("tr");

			const name = document.createElement("td");
			name.textContent = p.name || "（未命名）";

			const url = document.createElement("td");
			url.className = "url";
			url.textContent = p.baseURL || "";

			const count = document.createElement("td");
			count.textContent = String((p.models && p.models.length) || 0);

			const ops = document.createElement("td");
			const edit = document.createElement("button");
			edit.textContent = "编辑";
			edit.addEventListener("click", () => openProviderDialog(p.id));
			const del = document.createElement("button");
			del.textContent = "删除";
			del.addEventListener("click", () => removeProvider(p.id));
			ops.appendChild(edit);
			ops.appendChild(del);

			tr.appendChild(name);
			tr.appendChild(url);
			tr.appendChild(count);
			tr.appendChild(ops);
			body.appendChild(tr);
		}
	}

	function removeProvider(id) {
		if (!PL) return;
		const p = PL.LLM.getProviders().find(x => x.id === id);
		if (!p) return;

		let ok = true;
		try {
			ok = window.confirm("删除服务商「" + (p.name || p.baseURL) + "」？依赖它的模型选择会失效。");
		}
		catch (e) { /* 某些上下文没有 confirm，直接执行 */ }

		if (!ok) return;

		PL.LLM.saveProviders(PL.LLM.getProviders().filter(x => x.id !== id));

		// 清掉指向该服务商的引用，避免留下"已失效"的死配置
		for (const key of ["chatModelRef", "extractModelRef"]) {
			const parsed = PL.LLM.parseRef(prefGet(key, ""));
			if (parsed && parsed.providerId === id) prefSet(key, "");
		}

		renderProviders();
		renderModelPickers();
		setStatus("已删除服务商", "ok");
	}

	/**
	 * 记录窗口几何。
	 * 我们看不到用户的屏幕，只能靠这份数据判断：
	 * 窗口到底在哪、屏幕可用区域多大、打开后有没有被系统移动。
	 * 结果同时写进页面顶部和 <数据目录>/paperloom/windowlog.json。
	 */
	function logWindowGeometry() {
		const snap = () => ({
			t: Date.now(),
			pos: [window.screenX, window.screenY],
			outer: [window.outerWidth, window.outerHeight],
			inner: [window.innerWidth, window.innerHeight],
			availSize: [window.screen.availWidth, window.screen.availHeight],
			availPos: [window.screen.availLeft, window.screen.availTop],
			screenSize: [window.screen.width, window.screen.height],
			dpr: window.devicePixelRatio
		});

		const samples = [];

		const paint = () => {
			const el = $("win-geo");
			if (!el) return;
			const s = samples[samples.length - 1];
			el.textContent = "窗口 " + s.pos.join(",") + " · 尺寸 " + s.outer.join("×")
				+ " · 屏幕可用 " + s.availSize.join("×")
				+ " · 缩放 " + s.dpr;
		};

		// 一打开就记：写偏好（同步、一定成功）和文件（异步）
		const record = () => {
			try {
				const s = snap();
				samples.push(s);
				try { Zotero.Prefs.set("extensions.paperloom.lastWindowGeometry", JSON.stringify(s), true); }
				catch (e) { /* ignore */ }
				if (PL && PL.Storage) {
					PL.Storage.writeJSON("windowlog.json", {
						at: new Date().toISOString(),
						samples: samples
					}).catch(() => { });
				}
				paint();
			}
			catch (e) { /* ignore */ }
		};

		record();
		window.setTimeout(record, 600);
		window.setTimeout(record, 1500);
	}

	/** 打开后再手动居中：centerscreen 在多屏/某些 WM 上不生效 */
	function centerWindow(w, sizes) {
		if (!w) return;
		const wantW = (sizes && sizes.width) || 680;
		const wantH = (sizes && sizes.height) || 700;
		let tries = 0;

		const timer = window.setInterval(() => {
			tries++;
			try {
				const sw = (w.screen && w.screen.availWidth) || 0;
				const sh = (w.screen && w.screen.availHeight) || 0;
				if (!sw || !sh) return;

				const cw = Math.min(wantW, sw - 80);
				const ch = Math.min(wantH, sh - 80);
				try { w.resizeTo(cw, ch); } catch (e) { /* ignore */ }

				if (typeof w.centerWindowOnScreen === "function") {
					w.centerWindowOnScreen();
				}
				else {
					w.moveTo(
						Math.max(0, Math.round((sw - cw) / 2)),
						Math.max(0, Math.round((sh - ch) / 2))
					);
				}
			}
			catch (e) { /* 窗口还没就绪 */ }
			if (tries > 30) window.clearInterval(timer);
		}, 100);
	}

	function openProviderDialog(providerId) {
		const url = "chrome://paperloom/content/provider.xhtml"
			+ (providerId ? ("?id=" + encodeURIComponent(providerId)) : "");

		// 与设置窗口一致：只用 openDialog，避免多开/抢焦点
		const features = "chrome,dialog=no,resizable,centerscreen,width=680,height=700";
		try {
			const w = window.openDialog(url, "paperloom-provider", features,
				{ providerId: providerId || "", Zotero: Zotero, PaperLoom: PL });
			if (w) return;
		}
		catch (e) { /* 落到下面的提示 */ }

		setStatus("打开服务商窗口失败", "err");
	}

	// ------------------------------------------------------------------ 模型下拉框

	/** 用 details 面板代替原生 select：chrome iframe 里原生下拉弹不出来 */
	function fillModelPicker(pickerId, listId, summaryId, refKey) {
		const picker = $(pickerId), list = $(listId), summary = $(summaryId);
		if (!picker || !list) return;

		const providers = PL.LLM.getProviders();
		const current = String(prefGet(refKey, ""));
		let currentLabel = "未选择";

		list.innerHTML = "";

		if (!providers.length) {
			const empty = document.createElement("div");
			empty.className = "pl-muted";
			empty.textContent = "还没有服务商，请先新增。";
			list.appendChild(empty);
		}

		for (const p of providers) {
			if (!p.models || !p.models.length) continue;

			const group = document.createElement("div");
			group.className = "pl-picker-group";
			group.textContent = p.name || p.baseURL;
			list.appendChild(group);

			for (const m of p.models) {
				const ref = PL.LLM.makeRef(p.id, m);
				const item = document.createElement("button");
				item.type = "button";
				item.className = "pl-picker-item" + (ref === current ? " active" : "");
				item.textContent = m;
				item.addEventListener("click", () => {
					prefSet(refKey, ref);
					picker.open = false;
					fillModelPicker(pickerId, listId, summaryId, refKey);
					setStatus("已选择模型：" + (p.name || p.baseURL) + " / " + m, "ok");
				});
				list.appendChild(item);
				if (ref === current) currentLabel = (p.name || p.baseURL) + " · " + m;
			}
		}

		if (current && currentLabel === "未选择") {
			const stale = document.createElement("div");
			stale.className = "pl-muted";
			stale.textContent = "当前模型引用已失效，请重新选择。";
			list.appendChild(stale);
		}

		if (summary) summary.textContent = currentLabel;
	}

	function renderModelPickers() {
		fillModelPicker("chatModelPicker", "chatModelList", "chatModelSummary", "chatModelRef");
		fillModelPicker("extractModelPicker", "extractModelList", "extractModelSummary", "extractModelRef");
	}

	// ------------------------------------------------------------------ 测试

	async function testSelected() {
		if (!PL) {
			setStatus("领域层未加载", "err");
			return;
		}
		const ref = String(prefGet("chatModelRef", ""));
		const target = PL.LLM.resolveRef(ref);
		if (!target) {
			setStatus("请先选择「对话模型」", "err");
			return;
		}

		setStatus("正在连接 " + target.providerName + " / " + target.model + " …", "busy");
		const r = await PL.LLM.testConnection(target);
		if (r.ok) {
			setStatus("连接成功 · " + r.model + " · " + r.ms + "ms", "ok");
		}
		else {
			setStatus("连接失败：" + r.error, "err");
		}
	}

	/** 设置里直接嵌入记忆 / 图谱管理页（同一份实现，支持增删改） */
	function showManageFrame(src) {
		const frame = $("pl-manage-frame");
		if (!frame) return;
		frame.src = src;
		frame.style.display = "block";
	}

	// ------------------------------------------------------------------ 内嵌高度

	/**
	 * 内嵌到 Zotero 设置面板时，让 iframe 高度贴合父窗口可用空间。
	 * 否则 iframe 固定 620px、父面板又要滚动，就会出现"里面一个滑条、外面一个滑条"。
	 * 目标：外层不滚动，只保留 iframe 内部的滚动条。
	 */
	function fitToParent() {
		if (!EMBED) return;
		try {
			const frame = window.frameElement;
			if (!frame || !window.parent) return;

			const rect = frame.getBoundingClientRect();
			// 父窗口视口高度 - iframe 顶部位置 - 底部余量（留大一点，宁可内部多点滚动）
			const available = window.parent.innerHeight - rect.top - 40;
			if (!Number.isFinite(available)) return;

			frame.style.height = Math.max(360, Math.floor(available)) + "px";
		}
		catch (e) { /* 跨域或拿不到 frameElement 时保持默认高度 */ }
	}

	// ------------------------------------------------------------------ 初始化

	function init() {
		try {
			initSafe();
		}
		catch (e) {
			setStatus("设置界面初始化失败：" + ((e && e.message) || e), "err");
		}
	}

	function initSafe() {
		if (EMBED) {
			document.body.classList.add("pl-embed");
			const close = $("btn-close");
			if (close) close.style.display = "none";

			// 布局稳定后再量高度；窗口尺寸变化时重算
			setTimeout(fitToParent, 0);
			setTimeout(fitToParent, 300);
			try {
				window.parent.addEventListener("resize", fitToParent);
			}
			catch (e) { /* 跨域时忽略 */ }
		}

		if (!Zotero) {
			setStatus("拿不到 Zotero 对象：请用「工具 → PaperLoom → 设置…」打开独立窗口", "err");
			return;
		}
		if (!PL) {
			setStatus("拿不到 PaperLoom 领域层：请重启 Zotero 后重试", "err");
			return;
		}

		loadParams();
		renderProviders();
		renderModelPickers();
		bindEffortSeg();

		$("btn-add-provider").addEventListener("click", () => openProviderDialog(""));
		$("btn-test").addEventListener("click", testSelected);

		// 全局记忆 / 图谱：嵌在设置里直接看、直接改
		$("btn-manage-memory").addEventListener("click", () => showManageFrame("chrome://paperloom/content/memory.xhtml"));
		$("btn-manage-graph").addEventListener("click", () => showManageFrame("chrome://paperloom/content/graph.xhtml"));
		$("btn-save").addEventListener("click", saveParams);
		if ($("btn-close")) $("btn-close").addEventListener("click", () => window.close());


		// 服务商弹窗关闭后回到本窗口：重新渲染列表与下拉框
		window.addEventListener("focus", () => {
			try {
				renderProviders();
				renderModelPickers();
			}
			catch (e) { /* ignore */ }
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	}
	else {
		init();
	}
})();
