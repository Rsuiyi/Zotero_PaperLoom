/* PaperLoom — provider.js
 * 新增 / 编辑模型服务商的小窗口。
 *
 * 流程与 PDF2zh 的「新增翻译服务」一致：
 *   填 Base URL + API Key → 获取模型列表 → 勾选要保留的模型 → 保存。
 * 保存后由设置窗口在重新获得焦点时刷新表格与下拉框。
 */
(function () {
	"use strict";

	const NS = "extensions.paperloom.";

	const ARG = (window.arguments && window.arguments[0]) || {};

	function pickZotero() {
		const candidates = [
			() => ARG.Zotero,
			() => (window.opener && window.opener.__paperloomZotero),
			() => (window.opener && window.opener.Zotero),
			() => (window.top && window.top.Zotero),
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
			() => ARG.PaperLoom,
			() => (window.opener && window.opener.__paperloomPL),
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

	/** 正在编辑的服务商 id；空字符串表示新增。窗口不支持传参时从 query 里读 */
	const providerId = String(
		ARG.providerId
		|| (new URLSearchParams(location.search).get("id") || "")
	);

	/** 当前列表里勾选的模型（从 DOM 读，保证与界面一致） */
	function checkedModels() {
		const box = $("models-box");
		return Array.from(box.querySelectorAll('input[type="checkbox"]'))
			.filter(el => el.checked)
			.map(el => el.value);
	}

	function setStatus(text, kind) {
		const el = $("status");
		el.textContent = text || "";
		el.className = kind || "";
	}

	function renderModels(models, checked) {
		const box = $("models-box");
		box.innerHTML = "";

		if (!models || !models.length) {
			const empty = document.createElement("div");
			empty.className = "empty";
			empty.textContent = "没有模型。请检查接口是否提供 /models。";
			box.appendChild(empty);
			return;
		}

		const checkedSet = new Set(checked || []);
		for (const id of models) {
			const label = document.createElement("label");
			const cb = document.createElement("input");
			cb.type = "checkbox";
			cb.value = id;
			cb.checked = checkedSet.has(id);
			const text = document.createElement("span");
			text.textContent = id;
			label.appendChild(cb);
			label.appendChild(text);
			box.appendChild(label);
		}
	}

	function loadExisting() {
		if (!providerId || !PL) return;
		const p = PL.LLM.getProviders().find(x => x.id === providerId);
		if (!p) return;

		$("title").textContent = "编辑模型服务商";
		$("name").value = p.name || "";
		$("baseURL").value = p.baseURL || "";
		$("apiKey").value = p.apiKey || "";
		renderModels(p.models || [], p.models || []);
	}

	async function fetchModels() {
		if (!PL) {
			setStatus("领域层未加载", "err");
			return;
		}
		const baseURL = $("baseURL").value.trim();
		const apiKey = $("apiKey").value.trim();

		if (!baseURL) {
			setStatus("请先填写 Base URL", "err");
			return;
		}
		if (!apiKey) {
			setStatus("请先填写 API Key", "err");
			return;
		}

		setStatus("正在请求 " + baseURL + " …", "busy");
		try {
			// 用表单当前值请求，不依赖是否已保存（与 PDF2zh 行为一致）
			const result = await PL.LLM.listModels({ baseURL: baseURL, apiKey: apiKey });
			// 默认全选：多数人就是要用这个站点提供的全部模型
			renderModels(result.models, result.models);
			setStatus("已获取 " + result.models.length + " 个模型（来自 " + result.url + "）", "ok");
		}
		catch (e) {
			renderModels([], []);
			const tried = (e && e.tried && e.tried.length) ? "（尝试过 " + e.tried.join("、") + "）" : "";
			setStatus("获取失败：" + ((e && e.message) || e) + tried, "err");
		}
	}

	function save() {
		if (!PL) {
			setStatus("领域层未加载", "err");
			return;
		}

		const baseURL = $("baseURL").value.trim().replace(/\/+$/, "");
		const apiKey = $("apiKey").value.trim();
		if (!baseURL) {
			setStatus("请填写 Base URL", "err");
			return;
		}

		let name = $("name").value.trim();
		if (!name) {
			try {
				name = new URL(baseURL).hostname;
			}
			catch (e) {
				name = baseURL;
			}
		}

		const models = checkedModels();
		if (!models.length) {
			setStatus("请至少勾选一个模型（可先点「获取模型列表」）", "err");
			return;
		}

		const list = PL.LLM.getProviders();
		const existing = providerId ? list.find(x => x.id === providerId) : null;
		const record = {
			id: existing ? existing.id : PL.LLM.newProviderID(),
			name: name,
			baseURL: baseURL,
			apiKey: apiKey,
			models: models,
			fetchedAt: new Date().toISOString()
		};

		const next = existing
			? list.map(x => (x.id === existing.id ? record : x))
			: list.concat([record]);

		PL.LLM.saveProviders(next);

		// 首次添加服务商时，顺手把两个模型选择指向它，省掉两步点击
		if (!existing) {
			const first = models[0];
			if (!String(Zotero.Prefs.get(NS + "chatModelRef", true) || "")) {
				Zotero.Prefs.set(NS + "chatModelRef", PL.LLM.makeRef(record.id, first), true);
			}
			if (!String(Zotero.Prefs.get(NS + "extractModelRef", true) || "")) {
				Zotero.Prefs.set(NS + "extractModelRef", PL.LLM.makeRef(record.id, first), true);
			}
		}

		window.close();
	}

	function init() {
		if (!Zotero || !PL) {
			setStatus("无法访问 Zotero/PaperLoom，请从设置窗口重新打开", "err");
			return;
		}

		loadExisting();

		$("btn-fetch").addEventListener("click", fetchModels);
		$("btn-save").addEventListener("click", save);
		$("btn-cancel").addEventListener("click", () => window.close());
		$("btn-eye").addEventListener("click", () => {
			const el = $("apiKey");
			const showing = el.type === "text";
			el.type = showing ? "password" : "text";
			$("btn-eye").textContent = showing ? "显示" : "隐藏";
		});
		$("btn-all").addEventListener("click", () => {
			for (const el of $("models-box").querySelectorAll('input[type="checkbox"]')) el.checked = true;
		});
		$("btn-none").addEventListener("click", () => {
			for (const el of $("models-box").querySelectorAll('input[type="checkbox"]')) el.checked = false;
		});
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	}
	else {
		init();
	}
})();
