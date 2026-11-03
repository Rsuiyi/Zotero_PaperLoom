/* PaperLoom — llm.js
 * L0 外部：服务商注册表 + 统一调用入口。
 *
 * 模型不再靠 base URL 猜，而是显式绑定到「用户新增的服务商」：
 *   providers[]     每个服务商 = { id, name, baseURL, apiKey, models[] }
 *   chatModelRef    "providerId|model"    回答问题时用
 *   extractModelRef "providerId|model"    建图谱 / 抽记忆时用
 * 两个引用互相独立，可以来自不同站点。
 *
 * 三条硬规则：
 *   1. OpenAI 兼容协议；
 *   2. max_tokens 不低于 4096 —— 推理模型的 reasoning token 计入 completion；
 *   3. 结果按 hash(prompt) 落盘缓存，开发期反复调试不烧钱。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.LLM = (function () {
	const S = PaperLoom.Schema;
	const NS = "extensions.paperloom.";

	function getPref(key, fallback) {
		try {
			const v = Zotero.Prefs.get(NS + key, true);
			return (v === undefined || v === null || v === "") ? fallback : v;
		}
		catch (e) {
			return fallback;
		}
	}

	function setPref(key, value) {
		try {
			Zotero.Prefs.set(NS + key, value, true);
			return true;
		}
		catch (e) {
			return false;
		}
	}

	function log(msg) {
		try { Zotero.debug("[PaperLoom:LLM] " + msg); } catch (e) { /* ignore */ }
	}

	// ------------------------------------------------------------------ 用量统计

	/**
	 * 从各家 usage 结构里提取输入 / 输出 / 缓存命中。
	 * 覆盖三种常见写法（照 Zotero AI Sidebar 的做法）：
	 *   - OpenAI：prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
	 *   - DeepSeek：prompt_cache_hit_tokens + prompt_cache_miss_tokens
	 *   - Anthropic：input_tokens / output_tokens / input_tokens_details.cached_tokens
	 */
	function extractUsage(data) {
		const u = data && data.usage;
		if (!u) return null;

		const details = u.prompt_tokens_details || u.input_tokens_details || {};
		const deepseekInput = (u.prompt_cache_hit_tokens || 0) + (u.prompt_cache_miss_tokens || 0);

		const input = (typeof u.prompt_tokens === "number") ? u.prompt_tokens
			: (typeof u.input_tokens === "number") ? u.input_tokens
				: deepseekInput;
		const output = (typeof u.completion_tokens === "number") ? u.completion_tokens
			: (typeof u.output_tokens === "number") ? u.output_tokens
				: 0;
		const cached = (typeof u.prompt_cache_hit_tokens === "number") ? u.prompt_cache_hit_tokens
			: (typeof details.cached_tokens === "number") ? details.cached_tokens
				: (typeof u.cache_read_input_tokens === "number") ? u.cache_read_input_tokens
					: 0;

		return {
			input: input || 0,
			output: output || 0,
			cached: cached || 0,
			total: typeof u.total_tokens === "number" ? u.total_tokens : ((input || 0) + (output || 0))
		};
	}

	let _lastUsage = null;

	/** 最近一次请求的用量（没拿到 usage 时为 null） */
	function lastUsage() {
		return _lastUsage;
	}

	// ------------------------------------------------------------------ 服务商注册表

	/** 读取服务商列表（JSON 存在偏好里，内容很小，读写都同步） */
	function getProviders() {
		const raw = getPref("providers", "");
		if (!raw) return [];
		try {
			const arr = JSON.parse(raw);
			return Array.isArray(arr) ? arr : [];
		}
		catch (e) {
			log("providers 解析失败: " + e);
			return [];
		}
	}

	function saveProviders(list) {
		const clean = (Array.isArray(list) ? list : []).map(p => ({
			id: String(p.id || newProviderID()),
			name: String(p.name || "未命名服务商"),
			baseURL: String(p.baseURL || "").trim().replace(/\/+$/, ""),
			apiKey: String(p.apiKey || "").trim(),
			models: Array.isArray(p.models) ? p.models.map(String) : [],
			fetchedAt: p.fetchedAt || null
		}));
		setPref("providers", JSON.stringify(clean));
		return clean;
	}

	function newProviderID() {
		return "p_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
	}

	/** 旧版本只有一个 apiBase/apiKey，升级时自动迁移成一条服务商记录 */
	function migrateLegacy() {
		if (getProviders().length) return;
		const key = String(getPref("apiKey", "") || "").trim();
		const base = String(getPref("apiBase", "") || "").trim();
		if (!key && !base) return;

		const p = {
			id: newProviderID(),
			name: "默认服务商",
			baseURL: base || "https://api.deepseek.com",
			apiKey: key,
			models: [],
			fetchedAt: null
		};
		saveProviders([p]);

		const legacyChat = String(getPref("chatModel", "") || "");
		const legacyExtract = String(getPref("extractModel", "") || "");
		if (legacyChat && !getPref("chatModelRef", "")) {
			setPref("chatModelRef", p.id + "|" + legacyChat);
			p.models.push(legacyChat);
		}
		if (legacyExtract && !getPref("extractModelRef", "")) {
			setPref("extractModelRef", p.id + "|" + legacyExtract);
			if (!p.models.includes(legacyExtract)) p.models.push(legacyExtract);
		}
		saveProviders([p]);
	}

	/** "providerId|model" → { providerId, model } */
	function parseRef(ref) {
		const s = String(ref || "");
		const i = s.indexOf("|");
		if (i <= 0 || i >= s.length - 1) return null;
		return { providerId: s.slice(0, i), model: s.slice(i + 1) };
	}

	function makeRef(providerId, model) {
		return providerId + "|" + model;
	}

	/** 把引用解析成可直接请求的目标；找不到服务商时返回 null */
	function resolveRef(ref) {
		const parsed = parseRef(ref);
		if (!parsed) return null;
		const provider = getProviders().find(p => p.id === parsed.providerId);
		if (!provider || !provider.baseURL) return null;
		return {
			providerId: provider.id,
			providerName: provider.name,
			baseURL: provider.baseURL,
			apiKey: provider.apiKey,
			model: parsed.model
		};
	}

	// ------------------------------------------------------------------ 运行配置

	function config() {
		return {
			chat: resolveRef(getPref("chatModelRef", "")),
			extract: resolveRef(getPref("extractModelRef", "")),
			maxTokens: Math.max(S.LIMITS.llmMinMaxTokens, parseInt(getPref("maxTokens", 4096), 10) || 4096),
			temperature: parseFloat(getPref("temperature", 0.3)),
			timeoutMs: parseInt(getPref("timeoutMs", 90000), 10) || 90000,
			useCache: getPref("useCache", true) !== false
		};
	}

	function isConfigured() {
		return !!config().chat;
	}

	// ------------------------------------------------------------------ 传输层

	/**
	 * POST JSON。
	 * 按能力选路径：Zotero.HTTP（特权通道，优先）→ fetch（兜底）。
	 */
	async function postJSON(url, headers, payload, timeoutMs) {
		const body = JSON.stringify(payload);

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
				const err = new Error("HTTP " + xhr.status + (text ? ": " + text : ""));
				err.status = xhr.status;
				throw err;
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
				const err = new Error("HTTP " + resp.status + ": " + text.slice(0, 500));
				err.status = resp.status;
				throw err;
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

	/** GET JSON：同样 HTTP 优先 */
	async function getJSON(url, headers, timeoutMs) {
		if (Zotero.HTTP && Zotero.HTTP.request) {
			const xhr = await Zotero.HTTP.request("GET", url, {
				headers: headers,
				responseType: "json",
				timeout: timeoutMs,
				successCodes: false
			});
			if (xhr.status < 200 || xhr.status >= 300) {
				const err = new Error("HTTP " + xhr.status);
				err.status = xhr.status;
				throw err;
			}
			if (xhr.response && typeof xhr.response === "object") {
				return xhr.response;
			}
			const raw = xhr.responseText || xhr.response || "";
			return (typeof raw === "string" && raw) ? JSON.parse(raw) : null;
		}

		if (typeof fetch === "function") {
			const resp = await fetch(url, { method: "GET", headers: headers });
			const text = await resp.text().catch(() => "");
			if (!resp.ok) {
				const err = new Error("HTTP " + resp.status + ": " + text.slice(0, 300));
				err.status = resp.status;
				throw err;
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

	// ------------------------------------------------------------------ 模型列表

	/** base URL 归一化：去掉尾部斜杠 */
	function normalizeBaseURL(value) {
		return String(value || "").trim().replace(/\/+$/, "");
	}

	/**
	 * 模型列表端点候选。
	 * 不同中转站路径不统一：有的在 {base}/models，有的把 /v1 也算在 base 里，
	 * 所以两种写法都试，谁先成功用谁。
	 */
	function modelURLs(baseURL) {
		const base = normalizeBaseURL(baseURL);
		if (!base) return [];
		const urls = [base.endsWith("/models") ? base : base + "/models"];
		if (/\/v1$/i.test(base)) {
			urls.push(base.replace(/\/v1$/i, "") + "/models");
		}
		return Array.from(new Set(urls));
	}

	/** 从各家返回里抠出模型 id（data / models / result / 纯数组，去掉 models/ 前缀） */
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
				return s.startsWith("models/") ? s.slice("models/".length) : s;
			})
			.filter(Boolean);

		return Array.from(new Set(ids));
	}

	/**
	 * 查询某个服务商实际提供的模型。
	 * 只返回接口真实返回的内容 —— 不再用内置目录"假装"有模型。
	 * @param {{baseURL:string, apiKey:string}} provider
	 * @returns {Promise<{models:string[], url:string}>}
	 */
	async function listModels(provider) {
		provider = provider || {};
		const base = normalizeBaseURL(provider.baseURL);
		const key = String(provider.apiKey || "").trim();

		if (!base) throw new Error("请先填写 Base URL");
		if (!key) throw new Error("请先填写 API Key");

		const urls = modelURLs(base);
		let lastError = null;

		for (const url of urls) {
			try {
				const data = await getJSON(url, { "Authorization": "Bearer " + key }, 20000);
				const models = extractModelIds(data);
				if (!models.length) {
					lastError = new Error(url + " 返回成功，但没有识别到模型列表");
					continue;
				}
				return { models: models, url: url };
			}
			catch (e) {
				lastError = e;
				log("模型列表请求失败（" + url + "）：" + e);
			}
		}

		const err = new Error(String((lastError && lastError.message) || lastError || "模型列表接口不可用"));
		err.tried = urls;
		throw err;
	}

	// ------------------------------------------------------------------ 补全

	/**
	 * 统一补全入口。
	 * @param {Object} opts
	 *   messages  [{role, content}]
	 *   model     "extract" 走抽取模型，缺省走对话模型
	 *   json      true 时要求返回 JSON 对象
	 *   maxTokens 可选覆盖
	 * @returns {Promise<string>} 模型返回的 content 文本
	 */
	async function complete(opts) {
		const cfg = config();
		const target = opts.model === "extract" ? cfg.extract : cfg.chat;

		if (!target) {
			const err = new Error(opts.model === "extract"
				? "尚未选择「图谱抽取模型」：设置 → 模型服务商里添加服务商并选择模型"
				: "尚未选择「对话模型」：设置 → 模型服务商里添加服务商并选择模型");
			err.code = "NO_MODEL";
			throw err;
		}
		if (!target.apiKey) {
			const err = new Error("服务商「" + target.providerName + "」没有填写 API Key");
			err.code = "NO_API_KEY";
			throw err;
		}

		const model = target.model;
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

		const cacheKey = S.hash(target.baseURL + "|" + model + "|" + JSON.stringify(payload.messages) + "|" + maxTokens + "|" + (opts.json ? "json" : "text"));

		if (cfg.useCache) {
			const cached = await PaperLoom.Storage.readCache(cacheKey);
			if (cached !== null) {
				try {
					// 本地缓存命中：没有真实 token 消耗，用 localCache 标记区分
					_lastUsage = { input: 0, output: 0, cached: 0, total: 0, localCache: true };
					return JSON.parse(cached).content;
				}
				catch (e) { /* 缓存损坏则忽略 */ }
			}
		}

		const data = await postJSON(
			target.baseURL + "/chat/completions",
			{
				"Content-Type": "application/json",
				"Authorization": "Bearer " + target.apiKey
			},
			payload,
			cfg.timeoutMs
		);

		_lastUsage = extractUsage(data);

		const choice = data && data.choices && data.choices[0];
		let content = choice && choice.message && choice.message.content;

		// 推理模型把 reasoning token 计入 completion，token 不够时 content 为空
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
				await PaperLoom.Storage.writeCache(cacheKey, JSON.stringify({
					content: content, model: model, provider: target.providerName, at: S.nowISO()
				}));
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

	/** 要求 JSON 输出的便捷封装，失败自动重试一次 */
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

	/**
	 * 连通性自检：只验证「接口通、鉴权对、模型名有效」，不关心模型说什么。
	 * @param {{baseURL:string, apiKey:string, model:string}} target
	 */
	async function testConnection(target) {
		const t = target || config().chat;
		if (!t) return { ok: false, error: "尚未选择模型" };
		if (!t.apiKey) return { ok: false, error: "该服务商没有填写 API Key" };

		const started = Date.now();
		try {
			const data = await postJSON(t.baseURL + "/chat/completions", {
				"Content-Type": "application/json",
				"Authorization": "Bearer " + t.apiKey
			}, {
				model: t.model,
				messages: [{ role: "user", content: "ping" }],
				max_tokens: 16,
				stream: false
			}, Math.min(parseInt(getPref("timeoutMs", 90000), 10) || 90000, 30000));

			const finish = data && data.choices && data.choices[0] && data.choices[0].finish_reason;
			return {
				ok: true,
				ms: Date.now() - started,
				model: (data && data.model) || t.model,
				finish: finish || ""
			};
		}
		catch (e) {
			return { ok: false, ms: Date.now() - started, error: String((e && e.message) || e) };
		}
	}

	return {
		// 服务商
		getProviders, saveProviders, newProviderID, migrateLegacy,
		makeRef, parseRef, resolveRef,
		// 配置与调用
		config, isConfigured,
		complete, completeJSON, parseJSON, testConnection, lastUsage, extractUsage,
		// 模型查询
		listModels, extractModelIds, modelURLs,
		// 兼容旧调用
		log
	};
})();
