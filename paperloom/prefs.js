// PaperLoom 默认偏好
// 键名统一加 extensions.paperloom. 前缀，避免与其他插件撞键。

// ---- 模型服务商注册表
// JSON 数组，每条：{ id, name, baseURL, apiKey, models: [], fetchedAt }
// 模型只来自服务商接口实际返回的列表，不再有"内置目录"。
pref("extensions.paperloom.providers", "[]");
// 模型引用格式 "providerId|model"；回答与抽取可以来自不同服务商
pref("extensions.paperloom.chatModelRef", "");
pref("extensions.paperloom.extractModelRef", "");

// ---- 旧版单服务商配置（仅用于升级迁移，新代码不再读取）
pref("extensions.paperloom.apiBase", "https://api.deepseek.com");
pref("extensions.paperloom.apiKey", "");
pref("extensions.paperloom.chatModel", "");
pref("extensions.paperloom.extractModel", "");

// ⚠ 必须 ≥ 4096：推理模型的 reasoning token 计入 completion，给小了会出现 content 为空。
pref("extensions.paperloom.maxTokens", 4096);
pref("extensions.paperloom.temperature", "0.3");
pref("extensions.paperloom.timeoutMs", 90000);
// 所有 LLM 结果按 hash(prompt) 落盘缓存，开发期反复调试不烧钱
pref("extensions.paperloom.useCache", true);

// ---- 诊断：启动后自动跑一次模型列表请求，结果写入 <数据目录>/paperloom/selftest.json
pref("extensions.paperloom.selfTest", true);

// ---- 存储：留空则使用 <Zotero 数据目录>/paperloom
pref("extensions.paperloom.dataDir", "");

// ---- 图谱视图
pref("extensions.paperloom.crossPaperOnly", false);
