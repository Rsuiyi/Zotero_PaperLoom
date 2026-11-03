/* PaperLoom — compat.js
 * 版本适配层：Zotero 7 / 8 / 9 / 10 的差异全部集中在这里。
 *
 * 原则（很重要）：
 *   1. 只探测「能力是否存在」，不判断版本号字符串 —— 版本号会骗人，API 在不在不会。
 *   2. 缺能力就降级，不抛异常：侧栏没有就退回窗口，PDFWorker 没有就退回全文索引。
 *   3. 业务代码（chat/graph/memory/pipeline）不出现任何版本分支，只调用这里的方法。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Compat = (function () {
	/** 安全地取 Zotero 上的嵌套属性，任何一段缺失都返回 undefined 而不是抛错 */
	function get(path) {
		let obj = Zotero;
		for (const part of String(path).split(".")) {
			if (!obj) return undefined;
			obj = obj[part];
		}
		return obj;
	}

	function mainWindow() {
		try {
			if (typeof Zotero.getMainWindow === "function") {
				const win = Zotero.getMainWindow();
				if (win) return win;
			}
			if (typeof Zotero.getMainWindows === "function") {
				const wins = Zotero.getMainWindows();
				if (wins && wins.length) return wins[0];
			}
		}
		catch (e) { /* 启动早期可能还没有窗口 */ }
		return null;
	}

	/** 能力表：每次调用都重新判断，不缓存 —— 插件可以在窗口就绪前后被调用 */
	function caps() {
		const win = mainWindow();
		return {
			itemPaneSections: typeof get("ItemPaneManager.registerSection") === "function",
			itemPaneUnregister: typeof get("ItemPaneManager.unregisterSection") === "function",
			preferencePanes: typeof get("PreferencePanes.register") === "function",
			preferencePaneUnregister: typeof get("PreferencePanes.unregister") === "function",
			customTabs: !!(win && win.Zotero_Tabs && typeof win.Zotero_Tabs.add === "function"),
			readerOpen: typeof get("Reader.open") === "function",
			pdfWorkerText: typeof get("PDFWorker.getFullText") === "function",
			fulltextCache: typeof get("Fulltext.getItemCacheFile") === "function",
			fulltextIndexedText: typeof get("Fulltext.getIndexedText") === "function",  // Zotero 7–9 有，10 已删
			fulltextIndexItems: typeof get("Fulltext.indexItems") === "function",
			notifier: typeof get("Notifier.registerObserver") === "function",
			progressWindow: typeof get("ProgressWindow") === "function",
			dataDir: !!(get("DataDirectory.dir"))
		};
	}

	/** 数据目录：优先 Zotero.DataDirectory.dir，极旧版本退回 profile 目录 */
	function dataDir() {
		const dir = get("DataDirectory.dir");
		if (dir) return dir;
		try {
			return Services.dirsvc.get("ProfD", Components.interfaces.nsIFile).path;
		}
		catch (e) {
			return null;
		}
	}

	/**
	 * 补全侧栏 section 的必填项。
	 * Zotero 7.0 起 header/sidenav 就必须带 icon；此处统一补齐，
	 * 调用方不必关心当前版本到底几。
	 */
	function sectionOptions(options, iconURI) {
		const out = Object.assign({}, options);
		out.header = Object.assign({}, out.header);
		out.sidenav = Object.assign({}, out.sidenav);
		if (!out.header.icon) out.header.icon = iconURI;
		if (!out.sidenav.icon) out.sidenav.icon = iconURI;
		return out;
	}

	/**
	 * 打开自定义页：优先自定义 Tab，失败退回独立窗口。
	 * 返回 { id, container } 或 null（窗口模式没有 container）。
	 */
	function openTab(win, { type, title, src, onClose }) {
		if (win && win.Zotero_Tabs && typeof win.Zotero_Tabs.add === "function") {
			try {
				const res = win.Zotero_Tabs.add({
					type: type,
					title: title,
					// Zotero 10 的标签代码会读 tab.data.icon；不传 data 会在后续操作里抛
					// "can't access property 'icon', tab.data is undefined"
					data: {},
					select: true,
					onClose: onClose
				});
				if (res && res.container) return res;
			}
			catch (e) {
				try { Zotero.debug("[PaperLoom:Compat] Zotero_Tabs.add 失败，退回窗口: " + e); } catch (e2) { /* ignore */ }
			}
		}
		try {
			win.openDialog(src, "paperloom-" + type, "chrome,resizable,centerscreen,width=1100,height=760");
		}
		catch (e) {
			try { Zotero.debug("[PaperLoom:Compat] 独立窗口也打不开: " + e); } catch (e2) { /* ignore */ }
		}
		return null;
	}

	/** 启动日志用：把能力表压成一行，真机排障时一眼看出缺什么 */
	function describe() {
		const c = caps();
		return Object.keys(c).filter(k => !c[k]).join(",") || "全部可用";
	}

	return { get, mainWindow, caps, dataDir, sectionOptions, openTab, describe };
})();
