/* PaperLoom — preferences.js
 * 原生设置面板的脚本：由 PreferencePanes.register 的 scripts 选项加载。
 *
 * 两个坑：
 *   1. 这个脚本比面板 DOM 先执行（Zotero 先跑 scripts 再插入 fragment），
 *      所以必须轮询等按钮出现，不能依赖 DOMContentLoaded。
 *   2. XUL button 触发的是 command 事件，HTML button 触发 click —— 两个都监听。
 */
(function () {
	"use strict";

	const PREFIX = "extensions.paperloom.";

	function getPref(key, fallback) {
		try {
			const v = window.Zotero.Prefs.get(PREFIX + key, true);
			return (v === undefined || v === null || v === "") ? fallback : v;
		}
		catch (e) {
			return fallback;
		}
	}

	function openSettings() {
		const Zotero = window.Zotero;
		try {
			window.openDialog(
				"chrome://paperloom/content/settings.xhtml",
				"paperloom-settings",
				"chrome,centerscreen,resizable,width=700,height=720",
				{ Zotero: Zotero, PaperLoom: Zotero && Zotero.PaperLoom }
			);
		}
		catch (e) {
			try { Zotero.debug("[PaperLoom] 打开设置窗口失败: " + e); } catch (e2) { /* ignore */ }
		}
	}

	/** 面板里只显示一行状态，不做任何编辑——编辑统一在独立窗口 */
	function updateStatus(doc) {
		const el = doc.getElementById("paperloom-pref-status");
		if (!el) return;

		const key = getPref("apiKey", "");
		const model = getPref("chatModel", "deepseek-chat");
		const base = getPref("apiBase", "https://api.deepseek.com/v1");
		el.textContent = key
			? "已配置：" + model + " @ " + base
			: "尚未配置 API Key，点上方按钮填写后即可使用";
	}

	/** 按钮可能还没插进文档，最多重试约 5 秒 */
	function boot(tries) {
		const doc = window.document;
		const btn = doc.getElementById("paperloom-open-settings");

		if (!btn) {
			if (tries > 0) window.setTimeout(() => boot(tries - 1), 100);
			return;
		}
		if (!btn._paperloomBound) {
			btn._paperloomBound = true;
			btn.addEventListener("command", openSettings);
			btn.addEventListener("click", openSettings);
			updateStatus(doc);
		}
	}

	window.setTimeout(() => boot(50), 0);
})();
