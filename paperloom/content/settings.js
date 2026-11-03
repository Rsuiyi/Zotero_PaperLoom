/* PaperLoom — settings.js
 * L3 表现层：独立设置窗口。
 *
 * 为什么不只用 Zotero 原生设置面板：
 *   PreferencePanes 的加载方式在大版本之间变过（XUL / XHTML、resolveURI、defaultXUL），
 *   一旦注册失败，用户就完全没法配模型。这个窗口不依赖那套机制，
 *   只要能打开 chrome://paperloom/content/settings.xhtml 就能配置。
 */
(function () {
	"use strict";

	// 三种打开方式都要能拿到 Zotero：
	//   1. openDialog 传参（独立窗口）
	//   2. 主窗口 iframe（Tab 兜底）
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
		el.textContent = text || "";
		el.className = kind || "";
	}

	/** 读取一个偏好，带默认值兜底（未注册预定义的极旧版本也能用） */
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
		// 显示实际生效的数据目录，省得用户猜文件落在哪
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

	function init() {
		load();

		$("btn-save").addEventListener("click", save);
		$("btn-test").addEventListener("click", test);
		$("btn-close").addEventListener("click", () => window.close());

		// 密码框的显示/隐藏，方便确认 Key 有没有粘错
		$("btn-eye").addEventListener("click", () => {
			const el = $("apiKey");
			const showing = el.type === "text";
			el.type = showing ? "password" : "text";
			$("btn-eye").textContent = showing ? "显示" : "隐藏";
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	}
	else {
		init();
	}
})();
