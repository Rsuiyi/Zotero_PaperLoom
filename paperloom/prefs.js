// PaperLoom 默认偏好
// 键名统一加 extensions.paperloom. 前缀，避免与其他插件撞键。

// ---- LLM（OpenAI 兼容协议，base URL 与模型名全部可配）
pref("extensions.paperloom.apiBase", "https://api.deepseek.com/v1");
pref("extensions.paperloom.apiKey", "");
// 对话用强模型
pref("extensions.paperloom.chatModel", "deepseek-chat");
// 抽取 / 建图用便宜模型
pref("extensions.paperloom.extractModel", "deepseek-chat");
// ⚠ 必须 ≥ 4096：DeepSeek 系推理模型的 reasoning token 计入 completion，
//   给小了会出现 content 为空。
pref("extensions.paperloom.maxTokens", 4096);
pref("extensions.paperloom.temperature", "0.3");
pref("extensions.paperloom.timeoutMs", 90000);
// 所有 LLM 结果按 hash(prompt) 落盘缓存，开发期反复调试不烧钱
pref("extensions.paperloom.useCache", true);

// ---- 存储：留空则使用 <Zotero 数据目录>/paperloom
pref("extensions.paperloom.dataDir", "");

// ---- 图谱视图
pref("extensions.paperloom.crossPaperOnly", false);
