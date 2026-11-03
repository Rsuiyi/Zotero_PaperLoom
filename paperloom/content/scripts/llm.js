/* PaperLoom — llm.js
 * L0 外部：所有 LLM 调用统一走 complete()，换供应商 / 接本地模型不改业务代码。
 * 三条硬规则：
 *   1. OpenAI 兼容协议，base URL / model 全部可配；
 *   2. max_tokens 不低于 4096 —— DeepSeek 系推理模型的 reasoning token 计入 completion，
 *      给小了会出现 content 为空；
 *   3. 结果按 hash(prompt) 落盘缓存，开发期反复调试不烧钱。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.LLM = (function () {
	const S = PaperLoom.Schema;

	function pref(key, fallback) {
		try {
			const v = Zotero.Prefs.get("extensions.paperloom." + key, true);
			return (v === undefined || v === null || v === "") ? fallback : v;
		}
		catch (e) {
			return fallback;
		}
	}

	function config() {
		const base = String(pref("apiBase", "https://api.deepseek.com/v1")).replace(/\/+$/, "");
		return {
			baseURL: base,
			apiKey: String(pref("apiKey", "")),
			chatModel: String(pref("chatModel", "deepseek-chat")),
			extractModel: String(pref("extractModel", "deepseek-chat")),
			maxTokens: Math.max(S.LIMITS.llmMinMaxTokens, parseInt(pref("maxTokens", 4096), 10) || 4096),
			temperature: parseFloat(pref("temperature", 0.3)),
			timeoutMs: parseInt(pref("timeoutMs", 90000), 10) || 90000,
			useCache: pref("useCache", true) !== false
		};
	}

	function isConfigured() {
		return !!config().apiKey;
	}

	function log(msg) {
		try { Zotero.debug("[PaperLoom:LLM] " + msg); } catch (e) { /* ignore */ }
	}

	/**
	 * 统一的 POST JSON 传输层。
	 * 按能力选路径，不判断版本：Zotero.HTTP（特权通道，优先）→ fetch（兜底）。
	 * @returns {Promise<Object>} 已解析的响应体
	 */
	async function postJSON(url, headers, payload, timeoutMs) {
		const body = JSON.stringify(payload);

		// 优先 Zotero.HTTP：特权通道，不受 CORS 与插件沙箱 fetch 能力影响。
		// PDF2zh / AI Sidebar 的请求都走这条路，实测比裸 fetch 稳。
		if (Zotero.HTTP && Zotero.HTTP.request) {
			const xhr = await Zotero.HTTP.request("POST", url, {
				headers: headers,
				body: body,
				responseType: "json",
				timeout: timeoutMs,
				successCodes: false
			});
			if (xhr.status < 200 || xhr.status >= 300) {
				const text = String(xhr.responseText || "").slice(0, 500);
				throw new Error("LLM HTTP " + xhr.status + (text ? ": " + text : ""));
			}
			if (xhr.response && typeof xhr.response === "object") {
				return xhr.response;
			}
			const raw = xhr.responseText || xhr.response || "";
			return (typeof raw === "string" && raw) ? JSON.parse(raw) : null;
		}

		if (typeof fetch === "function") {
			const init = { method: "POST", headers: headers, body: body };
			let timer = null;
			if (typeof AbortController === "function") {
				const controller = new AbortController();
				init.signal = controller.signal;
				timer = setTimeout(() => controller.abort(), timeoutMs);
			}
			let resp;
			try {
				resp = await fetch(url, init);
			}
			finally {
				if (timer) clearTimeout(timer);
			}

			const text = await resp.text().catch(() => "");
			if (!resp.ok) {
				throw new Error("LLM HTTP " + resp.status + ": " + text.slice(0, 500));
			}
			try {
				return text ? JSON.parse(text) : null;
			}
			catch (e) {
				throw new Error("LLM 返回的不是 JSON：" + text.slice(0, 200));
			}
		}

		throw new Error("当前运行环境既没有 fetch 也没有 Zotero.HTTP，无法请求 LLM");
	}

	/** 统一的 GET JSON（目前只用于拉模型列表） */
	async function getJSON(url, headers, timeoutMs) {
		// 优先 Zotero.HTTP：特权通道，不受 CORS 与沙箱 fetch 能力影响。
		// 这是 PDF2zh / AI Sidebar 都在用的路径，实测比 fetch 稳。
		if (Zotero.HTTP && Zotero.HTTP.request) {
			const xhr = await Zotero.HTTP.request("GET", url, {
				headers: headers,
				responseType: "json",
				timeout: timeoutMs
			});
			if (xhr.status < 200 || xhr.status >= 300) {
				throw new Error("HTTP " + xhr.status);
			}
			if (xhr.response && typeof xhr.response === "object") {
				return xhr.response;
			}
			const raw = xhr.responseText || xhr.response || "";
			return typeof raw === "string" ? JSON.parse(raw) : raw;
		}

		if (typeof fetch === "function" && typeof AbortController === "function") {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let resp;
			try {
				resp = await fetch(url, { method: "GET", headers: headers, signal: controller.signal });
			}
			finally {
				clearTimeout(timer);
			}
			const text = await resp.text().catch(() => "");
			if (!resp.ok) {
				throw new Error("HTTP " + resp.status + ": " + text.slice(0, 300));
			}
			try {
				return text ? JSON.parse(text) : null;
			}
			catch (e) {
				throw new Error("返回的不是 JSON：" + text.slice(0, 200));
			}
		}

		throw new Error("当前运行环境无法发起 HTTP 请求");
	}

	/**
	 * 内置模型目录。
	 *
	 * 为什么需要它：GET /models 并不是所有 OpenAI 兼容服务都实现（有的返回空、
	 * 有的 ID 与对话接口不一致）。主流插件的做法是内置一份供应商目录，
	 * 再用接口结果做增量补充 —— 这里采用同样的策略。
	 */
	const MODEL_CATALOG = {
		deepseek: ["deepseek-v4-pro", "deepseek-v4-flash"],
		openai: [
			"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
			"gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"
		],
		claude: [
			"claude-opus-4-7", "claude-opus-4-6",
			"claude-sonnet-4-6", "claude-haiku-4-5-20251001"
		]
	};

	/** 从 base URL 猜供应商；猜不出就返回空目录，让用户手动填 */
	function detectProvider(baseURL) {
		const u = String(baseURL || "").toLowerCase();
		if (u.includes("deepseek")) return "deepseek";
		if (u.includes("anthropic") || u.includes("claude")) return "claude";
		if (u.includes("openai")) return "openai";
		return "";
	}

	/** 当前 base URL 对应的内置模型（不联网，随叫随到） */
	function modelSuggestions() {
		return (MODEL_CATALOG[detectProvider(config().baseURL)] || []).slice();
	}

	/** base URL 归一化：去掉尾部斜杠 */
	function normalizeBaseURL(value) {
		return String(value || "").trim().replace(/\/+$/, "");
	}

	/**
	 * 模型列表端点候选（按顺序尝试）。
	 *
	 * PDF2zh 的实现说明了一件事：DeepSeek 的模型列表在
	 * https://api.deepseek.com/models —— **不带 /v1**。
	 * 所以这里先试这个，再退回通用的 {base}/models 与去掉 /v1 的写法，
	 * 兼容官方地址和第三方代理。
	 */
	function modelURLs(baseURL) {
		const base = normalizeBaseURL(baseURL);
		const provider = detectProvider(base);
		const urls = [];

		if (provider === "deepseek") {
			urls.push("https://api.deepseek.com/models");
		}
		if (base) {
			urls.push(base.endsWith("/models") ? base : base + "/models");
			if (/\/v1$/i.test(base)) {
				urls.push(base.replace(/\/v1$/i, "") + "/models");
			}
		}
		return Array.from(new Set(urls));
	}

	/** 从各家五花八门的返回里抠出模型 id（data / models / result / 纯数组） */
	function extractModelIds(payload) {
		let list = [];
		if (Array.isArray(payload)) list = payload;
		else if (payload && Array.isArray(payload.data)) list = payload.data;
		else if (payload && Array.isArray(payload.models)) list = payload.models;
		else if (payload && payload.result && Array.isArray(payload.result.data)) list = payload.result.data;
		else if (payload && Array.isArray(payload.result)) list = payload.result;

		const ids = list
			.map((item) => {
				if (typeof item === "string") return item;
				return (item && (item.id || item.name || item.model || item.model_name)) || "";
			})
			.map((value) => {
				const s = String(value);
				// Gemini 风格会带 models/ 前缀，去掉才能直接用于对话
				return s.startsWith("models/") ? s.slice("models/".length) : s;
			})
			.filter(Boolean);

		return Array.from(new Set(ids));
	}

	/**
	 * 拉取模型列表：内置目录打底，再尝试服务商的模型接口增量合并。
	 * 没有 Key 或接口失败时返回内置目录而不是抛错 —— 下拉框永远有东西可选。
	 */
	/** 给返回数组挂一个 source 标记，UI 能区分"真的拉到了"还是"只是内置目录" */
	function tagged(list, source) {
		list.source = source;
		return list;
	}

	async function listModels() {
		const cfg = config();
		const suggested = modelSuggestions();

		if (!cfg.apiKey) {
			return tagged(suggested, "catalog");
		}

		const urls = modelURLs(cfg.baseURL);
		if (!urls.length) return tagged(suggested, "catalog");

		let lastError = null;
		for (const url of urls) {
			try {
				const data = await getJSON(url, {
					"Authorization": "Bearer " + cfg.apiKey
				}, Math.min(cfg.timeoutMs, 20000));

				const ids = extractModelIds(data);
				if (!ids.length) {
					lastError = new Error(url + " 返回成功但没有模型列表");
					continue;
				}

				// 内置目录在前（顺序稳定），接口返回的后置，整体去重
				return tagged(Array.from(new Set(suggested.concat(ids))), "api");
			}
			catch (e) {
				lastError = e;
				log("模型列表请求失败（" + url + "）：" + e);
			}
		}

		if (suggested.length) return tagged(suggested, "catalog-error");
		throw lastError || new Error("模型列表接口不可用");
	}

	/**
	 * 连通性自检：只验证「接口通、鉴权对、模型名有效」，不关心模型说什么。
	 * 故意用 max_tokens=16，避免为一次测试烧掉一整轮对话的额度。
	 */
	async function testConnection() {
		const cfg = config();
		if (!cfg.apiKey) {
			return { ok: false, error: "尚未填写 API Key" };
		}
		const started = Date.now();
		try {
			const data = await postJSON(cfg.baseURL + "/chat/completions", {
				"Content-Type": "application/json",
				"Authorization": "Bearer " + cfg.apiKey
			}, {
				model: cfg.chatModel,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 16,
				stream: false
			}, Math.min(cfg.timeoutMs, 30000));

			const finish = data && data.choices && data.choices[0] && data.choices[0].finish_reason;
			return {
				ok: true,
				ms: Date.now() - started,
				model: (data && data.model) || cfg.chatModel,
				finish: finish || ""
			};
		}
		catch (e) {
			return { ok: false, ms: Date.now() - started, error: String((e && e.message) || e) };
		}
	}

	/**
	 * 统一补全入口。
	 * @param {Object} opts
	 *   messages  [{role, content}]
	 *   model     可选，默认 chatModel；传 "extract" 走便宜模型
	 *   json      true 时要求返回 JSON 对象
	 *   maxTokens 可选覆盖
	 * @returns {Promise<string>} 模型返回的 content 文本
	 */
	async function complete(opts) {
		const cfg = config();
		if (!cfg.apiKey) {
			const err = new Error("PaperLoom: 尚未配置 API Key（设置 → PaperLoom）");
			err.code = "NO_API_KEY";
			throw err;
		}

		const model = opts.model === "extract" ? cfg.extractModel : (opts.model || cfg.chatModel);
		const maxTokens = Math.max(S.LIMITS.llmMinMaxTokens, opts.maxTokens || cfg.maxTokens);

		const payload = {
			model: model,
			messages: opts.messages,
			max_tokens: maxTokens,
			temperature: typeof opts.temperature === "number" ? opts.temperature : cfg.temperature,
			stream: false
		};
		if (opts.json) {
			payload.response_format = { type: "json_object" };
		}

		const cacheKey = S.hash(cfg.baseURL + "|" + model + "|" + JSON.stringify(payload.messages) + "|" + maxTokens + "|" + (opts.json ? "json" : "text"));

		if (cfg.useCache) {
			const cached = await PaperLoom.Storage.readCache(cacheKey);
			if (cached !== null) {
				try {
					const parsed = JSON.parse(cached);
					log("cache hit " + cacheKey);
					return parsed.content;
				}
				catch (e) { /* 缓存损坏则忽略，继续请求 */ }
			}
		}

		const data = await postJSON(
			cfg.baseURL + "/chat/completions",
			{
				"Content-Type": "application/json",
				"Authorization": "Bearer " + cfg.apiKey
			},
			payload,
			cfg.timeoutMs
		);

		const choice = data && data.choices && data.choices[0];
		let content = choice && choice.message && choice.message.content;

		// 必踩的坑：推理模型把 reasoning token 计入 completion，token 不够时 content 为空。
		if (!content || !String(content).trim()) {
			const reason = choice && choice.finish_reason;
			if (reason === "length") {
				throw new Error("LLM 返回 content 为空且 finish_reason=length：max_tokens 太小，"
					+ "推理模型的 reasoning token 计入 completion，请在设置里调大 max_tokens（建议 ≥ 4096）。");
			}
			throw new Error("LLM 返回空 content（finish_reason=" + reason + "）");
		}

		if (cfg.useCache) {
			try {
				await PaperLoom.Storage.writeCache(cacheKey, JSON.stringify({ content: content, model: model, at: S.nowISO() }));
			}
			catch (e) { log("缓存写入失败: " + e); }
		}

		return content;
	}

	/** 容错 JSON 解析：模型常常给 ```json 包裹或前后带废话 */
	function parseJSON(text) {
		if (!text) return null;
		let s = String(text).trim();
		const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
		if (fence) s = fence[1].trim();
		try {
			return JSON.parse(s);
		}
		catch (e) { /* 继续尝试截取最外层括号 */ }
		const start = s.indexOf("{");
		const end = s.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { /* ignore */ }
		}
		return null;
	}

	/** 要求 JSON 输出的便捷封装，失败自动重试一次并显式提醒只输出 JSON */
	async function completeJSON(opts) {
		const text = await complete(Object.assign({}, opts, { json: true }));
		let parsed = parseJSON(text);
		if (parsed) return parsed;

		const retryMessages = opts.messages.concat([
			{ role: "assistant", content: String(text).slice(0, 2000) },
			{ role: "user", content: "上一次回复不是合法 JSON。请只输出一个 JSON 对象，不要任何解释、前后缀或 markdown 代码块。" }
		]);
		const retry = await complete(Object.assign({}, opts, { messages: retryMessages, json: true }));
		parsed = parseJSON(retry);
		if (!parsed) throw new Error("LLM 两次均未返回合法 JSON");
		return parsed;
	}

	return {
		complete, completeJSON, parseJSON, config, isConfigured,
		testConnection, listModels, modelSuggestions, detectProvider, postJSON
	};
})();
