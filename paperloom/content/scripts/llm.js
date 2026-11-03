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

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
		let resp;
		try {
			resp = await fetch(cfg.baseURL + "/chat/completions", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": "Bearer " + cfg.apiKey
				},
				body: JSON.stringify(payload),
				signal: controller.signal
			});
		}
		finally {
			clearTimeout(timer);
		}

		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			throw new Error("LLM HTTP " + resp.status + ": " + body.slice(0, 500));
		}

		const data = await resp.json();
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

	return { complete, completeJSON, parseJSON, config, isConfigured };
})();
