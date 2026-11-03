/* PaperLoom — settings.js
 * L3 表现层：设置界面（独立窗口 / Zotero 设置面板内嵌共用同一份）。
 *
 * 设计要点：
 *   1. 只有这一份实现，?embed=1 表示嵌在 Zotero 设置面板里；
 *   2. 模型下拉框通过 GET /models 实时拉取，取不到就保留手动输入；
 *   3. 所有偏好写入都做类型转换（int 型偏好不能写字符串）。
 */
(function () {
	"use strict";

	const EMBED = new URLSearchParams(location.search).get("embed") === "1";

	// 三种打开方式都要能拿到 Zotero：
	//   1. openDialog 传参（独立窗口）
	//   2. 主窗口 iframe（设置面板内嵌 / Tab 兜底）
	//   3. opener（同源 chrome 窗口）
	const arg = (window.arguments && window.arguments[0]) || {};
	const Zotero = arg.Zotero
		|| (window.top && window.top.Zotero)
		|| (window.parent && window.parent.Zotero)
		|| (window.opener && window.opener.Zotero);
	const PL = arg.PaperLoom || (Zotero && Zotero.PaperLoom);

	// 偏好键统一带前缀，和 prefs.js 保持一致
	const PREFIX = "extensions.paperloom.";
	const FIELDS = [
		{ id: "apiBase", key: "apiBase", type: "string" },
		{ id: "apiKey", key: "apiKey", type: "string" },
		{ id: "chatModel", key: "chatModel", type: "string" },
		{ id: "extractModel", key: "extractModel", type: "string" },
		{ id: "maxTokens", key: "maxTokens", type: "int" },
		{ id: "temperature", key: "temperature", type: "string" },
		{ id: "timeoutMs", key: "timeoutMs", type: "int" },
		{ id: "useCache", key: "useCache", type: "bool" },
		{ id: "dataDir", key: "dataDir", type: "string" }
	];

	const $ = (id) => document.getElementById(id);

	function setStatus(text, kind) {
		const el = $("status");
		if (!el) return;
		el.textContent = text || "";
		el.className = kind || "";
	}

	/** 读取一个偏好，带默认值兜底 */
	function readPref(key, type) {
		let v;
		try {
			v = Zotero.Prefs.get(PREFIX + key, true);
		}
		catch (e) {
			v = undefined;
		}
		if (v === undefined || v === null) {
			return type === "bool" ? true : "";
		}
		return v;
	}

	function load() {
		if (!Zotero) {
			setStatus("拿不到 Zotero 对象，设置无法读写", "err");
			return;
		}
		for (const f of FIELDS) {
			const el = $(f.id);
			if (!el) continue;
			const v = readPref(f.key, f.type);
			if (f.type === "bool") el.checked = v !== false;
			else el.value = v === undefined ? "" : String(v);
		}
		try {
			$("resolvedDir").textContent = PL ? PL.Storage.root() : "—";
		}
		catch (e) {
			$("resolvedDir").textContent = "—";
		}
	}

	function save() {
		if (!Zotero) return false;
		try {
			for (const f of FIELDS) {
				const el = $(f.id);
				if (!el) continue;
				if (f.type === "bool") {
					Zotero.Prefs.set(PREFIX + f.key, !!el.checked, true);
				}
				else if (f.type === "int") {
					const n = parseInt(el.value, 10);
					// 非法输入不写，避免把偏好污染成 NaN
					if (Number.isFinite(n)) Zotero.Prefs.set(PREFIX + f.key, n, true);
				}
				else {
					Zotero.Prefs.set(PREFIX + f.key, String(el.value || "").trim(), true);
				}
			}
			setStatus("已保存", "ok");
			return true;
		}
		catch (e) {
			setStatus("保存失败：" + e, "err");
			return false;
		}
	}

	/**
	 * 用接口返回的模型列表填充两个下拉框。
	 * 当前值不在列表里时也保留一项，避免"配置看起来丢了"。
	 */
	function fillSelect(sel, models, current) {
		if (!sel) return;
		const keep = sel.value;
		sel.innerHTML = "";

		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = models.length ? "选择模型…" : "（拉取失败，可手动填写）";
		sel.appendChild(placeholder);

		const values = models.slice();
		for (const extra of [current, keep]) {
			if (extra && !values.includes(extra)) values.unshift(extra);
		}

		for (const id of values) {
			if (!id) continue;
			const opt = document.createElement("option");
			opt.value = id;
			opt.textContent = id;
			sel.appendChild(opt);
		}

		sel.value = current && values.includes(current) ? current : "";
	}

	async function pullModels(silent) {
		if (!PL || !PL.LLM) {
			if (!silent) setStatus("领域层未加载，无法拉取模型列表", "err");
			return;
		}
		if (!silent) setStatus("正在拉取模型列表…", "busy");
		try {
			const models = await PL.LLM.listModels();
			const chat = $("chatModel").value;
			const extract = $("extractModel").value;
			fillSelect($("chatModelSel"), models || [], chat);
			fillSelect($("extractModelSel"), models || [], extract);
			if (!silent) {
				setStatus(models && models.length ? "已获取 " + models.length + " 个模型" : "接口没有返回模型", models && models.length ? "ok" : "err");
			}
		}
		catch (e) {
			fillSelect($("chatModelSel"), [], $("chatModel").value);
			fillSelect($("extractModelSel"), [], $("extractModel").value);
			if (!silent) setStatus("拉取失败：" + (e && e.message || e) + "（仍可手动填写）", "err");
		}
	}

	async function test() {
		if (!PL || !PL.LLM) {
			setStatus("领域层未加载，无法测试", "err");
			return;
		}
		// 先保存，否则测的是旧配置
		save();
		setStatus("正在连接…", "busy");
		const r = await PL.LLM.testConnection();
		if (r.ok) {
			setStatus("连接成功 · " + r.model + " · " + r.ms + "ms", "ok");
		}
		else {
			setStatus("连接失败：" + r.error, "err");
		}
	}

	function bindSelect(selId, inputId) {
		const sel = $(selId);
		const input = $(inputId);
		if (!sel || !input) return;
		sel.addEventListener("change", () => {
			if (sel.value) {
				input.value = sel.value;
				setStatus("已选择 " + sel.value + "，记得保存", "ok");
			}
		});
	}

	function init() {
		if (EMBED) {
			document.body.classList.add("pl-embed");
			const close = $("btn-close");
			if (close) close.style.display = "none";
		}

		load();

		$("btn-save").addEventListener("click", save);
		$("btn-test").addEventListener("click", test);
		$("btn-models").addEventListener("click", () => pullModels(false));
		if ($("btn-close")) $("btn-close").addEventListener("click", () => window.close());

		$("btn-eye").addEventListener("click", () => {
			const el = $("apiKey");
			const showing = el.type === "text";
			el.type = showing ? "password" : "text";
			$("btn-eye").textContent = showing ? "显示" : "隐藏";
		});

		bindSelect("chatModelSel", "chatModel");
		bindSelect("extractModelSel", "extractModel");

		// 已经有 Key 时静默拉一次模型列表，省掉一次点击；失败不影响使用
		if (readPref("apiKey", "string")) {
			pullModels(true);
		}
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	}
	else {
		init();
	}
})();
