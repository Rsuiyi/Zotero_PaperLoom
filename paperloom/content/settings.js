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

	/**
	 * 安全地找 Zotero 对象。
	 * 每一条候选都单独 try/catch：跨域访问会抛 SecurityError，
	 * 一条抛错不能把整个脚本炸掉（那会表现成"按钮完全没反应"）。
	 */
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

	/** 表单当前值：拉取时必须用它，而不是"上次保存的偏好" */
	function formConfig() {
		return {
			baseURL: $("apiBase").value.trim(),
			apiKey: $("apiKey").value.trim(),
			chatModel: $("chatModel").value.trim(),
			extractModel: $("extractModel").value.trim()
		};
	}

	async function pullModels(silent) {
		if (!PL || !PL.LLM) {
			if (!silent) setStatus("领域层未加载，无法拉取模型列表", "err");
			return;
		}

		const cfg = formConfig();
		if (!cfg.apiKey) {
			// 没有 Key 时仍展示内置目录，但要说清楚"这不是接口返回的"
			const cat = PL.LLM.modelSuggestions(cfg);
			fillSelect($("chatModelSel"), cat, cfg.chatModel);
			fillSelect($("extractModelSel"), cat, cfg.extractModel);
			if (!silent) {
				setStatus(cat.length
					? "请先填写 API Key；当前仅显示内置目录（" + cat.length + " 个）"
					: "请先填写 API Key 与 Base URL", "err");
			}
			return;
		}

		if (!silent) setStatus("正在向 " + cfg.baseURL + " 请求模型列表…", "busy");
		try {
			const models = await PL.LLM.listModels(cfg);
			const chat = $("chatModel").value;
			const extract = $("extractModel").value;
			fillSelect($("chatModelSel"), models || [], chat);
			fillSelect($("extractModelSel"), models || [], extract);

			if (!silent) {
				// models.source 由 llm.listModels 标记：api / api-empty / catalog / catalog-error
				const src = models && models.source;
				if (!models || !models.length) {
					setStatus("没有取到模型，请手动填写模型名", "err");
				}
				else if (src === "api") {
					setStatus("已从接口获取 " + models.length + " 个模型（含内置目录）", "ok");
				}
				else if (src === "api-empty") {
					setStatus("接口没有返回模型，已用内置目录（" + models.length + " 个）", "ok");
				}
				else if (src === "catalog-error") {
					const tried = (models.tried && models.tried[0]) || "";
					setStatus("接口请求失败：" + (models.error || "未知错误")
						+ (tried ? "（" + tried + "）" : "")
						+ "；已退回内置目录", "err");
				}
				else {
					setStatus("已载入内置目录（" + models.length + " 个）；填 Key 后可拉接口列表", "ok");
				}
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
		// 任何一步抛错都必须显示在页面上，不能让它静默变成"按钮没反应"
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

		load();

		if (!Zotero) {
			setStatus("拿不到 Zotero 对象：请把本页当作独立窗口打开（工具 → PaperLoom → 设置…）", "err");
			return;
		}

		$("btn-save").addEventListener("click", save);
		$("btn-test").addEventListener("click", test);
		// 点"拉取模型列表"时先把表单存下来：用户刚填的 Key/Base 必须被持久化，
		// 否则后续对话仍用旧配置（PDF2zh 也是这个行为）
		$("btn-models").addEventListener("click", () => {
			save();
			pullModels(false);
		});
		if ($("btn-close")) $("btn-close").addEventListener("click", () => window.close());

		$("btn-eye").addEventListener("click", () => {
			const el = $("apiKey");
			const showing = el.type === "text";
			el.type = showing ? "password" : "text";
			$("btn-eye").textContent = showing ? "显示" : "隐藏";
		});

		bindSelect("chatModelSel", "chatModel");
		bindSelect("extractModelSel", "extractModel");

		// 打开就载入模型目录（不联网也有内容）；有 Key 时会自动合并接口列表
		pullModels(true);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	}
	else {
		init();
	}
})();
