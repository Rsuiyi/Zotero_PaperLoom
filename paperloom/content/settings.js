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

	// ------------------------------------------------------------------ 通用参数

	function loadParams() {
		$("maxTokens").value = String(prefGet("maxTokens", 4096));
		$("temperature").value = String(prefGet("temperature", "0.3"));
		$("timeoutMs").value = String(prefGet("timeoutMs", 90000));
		$("useCache").checked = prefGet("useCache", true) !== false;
		$("dataDir").value = String(prefGet("dataDir", ""));

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
		renderModelSelects();
		setStatus("已删除服务商", "ok");
	}

	function openProviderDialog(providerId) {
		const url = "chrome://paperloom/content/provider.xhtml";
		try {
			window.openDialog(url, "paperloom-provider",
				"chrome,centerscreen,resizable,width=680,height=700",
				{ providerId: providerId || "", Zotero: Zotero, PaperLoom: PL });
		}
		catch (e) {
			setStatus("打开服务商窗口失败：" + e, "err");
		}
	}

	// ------------------------------------------------------------------ 模型下拉框

	function fillModelSelect(sel, refKey) {
		if (!sel || !PL) return;

		const providers = PL.LLM.getProviders();
		const current = String(prefGet(refKey, ""));
		let found = false;

		sel.innerHTML = "";

		const ph = document.createElement("option");
		ph.value = "";
		ph.textContent = providers.length ? "请选择模型…" : "（还没有服务商，请先新增）";
		sel.appendChild(ph);

		for (const p of providers) {
			if (!p.models || !p.models.length) continue;

			const group = document.createElement("optgroup");
			group.label = p.name || p.baseURL;

			for (const m of p.models) {
				const ref = PL.LLM.makeRef(p.id, m);
				const opt = document.createElement("option");
				opt.value = ref;
				opt.textContent = m;
				if (ref === current) {
					opt.selected = true;
					found = true;
				}
				group.appendChild(opt);
			}
			sel.appendChild(group);
		}

		// 当前引用已失效（服务商被删/模型被改名）时保留一项提示，而不是悄悄清空
		if (current && !found) {
			const stale = document.createElement("option");
			stale.value = current;
			stale.textContent = "（已失效：需要重新选择）";
			stale.selected = true;
			sel.appendChild(stale);
		}
	}

	function renderModelSelects() {
		fillModelSelect($("chatModelSel"), "chatModelRef");
		fillModelSelect($("extractModelSel"), "extractModelRef");
	}

	// ------------------------------------------------------------------ 测试

	async function testSelected() {
		if (!PL) {
			setStatus("领域层未加载", "err");
			return;
		}
		const ref = $("chatModelSel").value;
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
		renderModelSelects();

		$("btn-add-provider").addEventListener("click", () => openProviderDialog(""));
		$("btn-test").addEventListener("click", testSelected);
		$("btn-save").addEventListener("click", saveParams);
		if ($("btn-close")) $("btn-close").addEventListener("click", () => window.close());

		$("chatModelSel").addEventListener("change", (ev) => {
			prefSet("chatModelRef", ev.target.value);
			setStatus(ev.target.value ? "对话模型已更新" : "已清空对话模型", "ok");
		});
		$("extractModelSel").addEventListener("change", (ev) => {
			prefSet("extractModelRef", ev.target.value);
			setStatus(ev.target.value ? "抽取模型已更新" : "已清空抽取模型", "ok");
		});

		// 服务商弹窗关闭后回到本窗口：重新渲染列表与下拉框
		window.addEventListener("focus", () => {
			try {
				renderProviders();
				renderModelSelects();
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
