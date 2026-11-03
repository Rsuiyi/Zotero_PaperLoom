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
	 * 按能力选路径，不判断版本：fetch（7–10 主窗口都有）→ Zotero.HTTP（免 CORS 兜底）。
	 * @returns {Promise<Object>} 已解析的响应体
	 */
	async function postJSON(url, headers, payload, timeoutMs) {
		if (typeof fetch === "function" && typeof AbortController === "function") {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			let resp;
			try {
				resp = await fetch(url, {
					method: "POST",
					headers: headers,
					body: JSON.stringify(payload),
					signal: controller.signal
				});
			}
			finally {
				clearTimeout(timer);
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

		if (Zotero.HTTP && Zotero.HTTP.request) {
			const xhr = await Zotero.HTTP.request("POST", url, {
				headers: headers,
				body: JSON.stringify(payload),
				responseType: "json",
				timeout: timeoutMs,
				successCodes: false
			});
			if (xhr.status < 200 || xhr.status >= 300) {
				throw new Error("LLM HTTP " + xhr.status);
			}
			return xhr.response;
		}

		throw new Error("当前运行环境既没有 fetch 也没有 Zotero.HTTP，无法请求 LLM");
	}

	/** 统一的 GET JSON（目前只用于拉模型列表），传输层与 postJSON 一致 */
	async function getJSON(url, headers, timeoutMs) {
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

		if (Zotero.HTTP && Zotero.HTTP.request) {
			const xhr = await Zotero.HTTP.request("GET", url, {
				headers: headers,
				responseType: "json",
				timeout: timeoutMs,
				successCodes: false
			});
			if (xhr.status < 200 || xhr.status >= 300) {
				throw new Error("HTTP " + xhr.status);
			}
			return xhr.response;
		}

		throw new Error("当前运行环境无法发起 HTTP 请求");
	}

	/**
	 * 拉取服务商可用模型列表（OpenAI 兼容的 GET /models）。
	 * 各家未必都实现该接口，调用方必须能接受失败并允许手动填写。
	 */
	async function listModels() {
		const cfg = config();
		if (!cfg.apiKey) {
			throw new Error("尚未填写 API Key");
		}
		const data = await getJSON(cfg.baseURL + "/models", {
			"Authorization": "Bearer " + cfg.apiKey
		}, Math.min(cfg.timeoutMs, 30000));

		const arr = (data && (data.data || data.models)) || [];
		const ids = arr
			.map(m => (typeof m === "string" ? m : (m && m.id)))
			.filter(Boolean);
		// 去重并稳定排序，避免每次刷新下拉框顺序都变
		return Array.from(new Set(ids)).sort();
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

	return { complete, completeJSON, parseJSON, config, isConfigured, testConnection, listModels, postJSON };
})();
