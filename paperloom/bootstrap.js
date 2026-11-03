/* PaperLoom — bootstrap.js
 * L1 集成层：Zotero 7 生命周期钩子 + Item Pane section + 自定义 Tab + 偏好面板。
 *
 * 注册要点（M0 实测项）：
 *   - 所有注册放在 Zotero.uiReadyPromise 之后，否则 ItemPaneManager 可能尚未就绪；
 *   - pluginID 必须与 manifest.json 的 id 完全一致，否则静默丢弃；
 *   - startup 整体包 try/catch，异常被 Zotero 吞掉会表现为"重启后插件消失"。
 */

var PaperLoom;          // 领域层命名空间，由 Services.scriptloader 注入到本作用域
var chromeHandle;
var pluginRootURI;
var registeredSectionID = null;
var preferencePaneID = null;

const PLUGIN_ID = "paperloom@hackathon.local";

function log(msg) {
	Zotero.debug("[PaperLoom] " + msg);
}

/**
 * 构造领域层脚本的运行作用域。
 * bootstrap 沙箱里有 Zotero / Services / IOUtils 等，但 fetch、AbortController、
 * setTimeout 这类 window 全局在插件沙箱里不保证存在（Zotero 10 起尤其如此），
 * 统一从主窗口借一份，否则 llm.js 第一次发请求就 ReferenceError。
 * 注意：构造函数不能被 bind（会破坏 new），只有方法需要 bind。
 */
function createDomainScope() {
	const win = (Zotero.getMainWindow && Zotero.getMainWindow())
		|| Services.appShell.hiddenDOMWindow;
	const scope = { Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils };

	for (const name of ["fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "btoa", "atob"]) {
		if (win && typeof win[name] === "function") scope[name] = win[name].bind(win);
	}
	for (const name of ["AbortController", "TextDecoder", "TextEncoder", "URL", "URLSearchParams", "console", "crypto"]) {
		if (win && win[name]) scope[name] = win[name];
	}
	return scope;
}

function install() {
	log("install");
}

function uninstall() {
	log("uninstall");
}

async function startup({ id, version, rootURI }) {
	try {
		pluginRootURI = rootURI;
		await Zotero.initializationPromise;

		// ---- 载入领域层（纯 JS，与运行环境无关，Plan B 可整体搬去 Web 应用）
		// loadSubScript 的目标对象不会继承 bootstrap 作用域，必须把依赖显式放进去。
		const scripts = [
			"schema.js", "storage.js", "llm.js", "chunker.js",
			"retriever.js", "memory.js", "graphStore.js", "pipeline.js", "stubs.js"
		];
		const scope = createDomainScope();
		for (const file of scripts) {
			Services.scriptloader.loadSubScript(rootURI + "content/scripts/" + file, scope);
		}
		PaperLoom = scope.PaperLoom;
		PaperLoom.rootURI = rootURI;
		PaperLoom.version = version;
		Zotero.PaperLoom = PaperLoom;          // 暴露给面板 iframe 与调试控制台

		await PaperLoom.Storage.ensureDir();
		log("领域层就绪，数据目录 " + PaperLoom.Storage.root());

		// ---- 注册 chrome 资源，供 chrome://paperloom/content/... 使用
		const aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
			.getService(Components.interfaces.amIAddonManagerStartup);
		const manifestURI = Services.io.newURI(rootURI + "manifest.json");
		chromeHandle = aomStartup.registerChrome(manifestURI, [
			["content", "paperloom", rootURI + "content/"],
			["locale", "paperloom", "zh-CN", rootURI + "locale/zh-CN/"],
			["locale", "paperloom", "en-US", rootURI + "locale/en-US/"]
		]);

		// ---- UI 就绪后再挂界面
		await Zotero.uiReadyPromise;
		await registerPreferencePane();
		registerItemPaneSection();

		for (const win of Zotero.getMainWindows()) {
			addToWindow(win);
		}

		log("startup 完成 v" + version);
	}
	catch (e) {
		// 不让异常被静默吞掉，否则表现为"装上了但什么都没有"
		Zotero.logError(e);
		log("startup 失败: " + e + "\n" + (e.stack || ""));
	}
}

function shutdown() {
	try {
		for (const win of Zotero.getMainWindows()) {
			removeFromWindow(win);
		}
		if (registeredSectionID && Zotero.ItemPaneManager && Zotero.ItemPaneManager.unregisterSection) {
			Zotero.ItemPaneManager.unregisterSection(registeredSectionID);
		}
		// unregister 要的是 register() 返回的 pane id，不是 pluginID
		if (preferencePaneID && Zotero.PreferencePanes && Zotero.PreferencePanes.unregister) {
			Zotero.PreferencePanes.unregister(preferencePaneID);
			preferencePaneID = null;
		}
		if (chromeHandle) {
			chromeHandle.destruct();
			chromeHandle = null;
		}
		delete Zotero.PaperLoom;
		PaperLoom = undefined;
		log("shutdown 完成");
	}
	catch (e) {
		Zotero.logError(e);
	}
}

function onMainWindowLoad({ window }) {
	addToWindow(window);
}

function onMainWindowUnload({ window }) {
	removeFromWindow(window);
}

// ------------------------------------------------------------------ 偏好面板

async function registerPreferencePane() {
	try {
		// src 用相对插件根目录的路径，交给 Zotero 自己解析；
		// 传绝对 file:// URI 在 Zotero 10 上会被 resolveURI 当作外部地址处理。
		preferencePaneID = await Zotero.PreferencePanes.register({
			pluginID: PLUGIN_ID,
			src: "content/preferences.xhtml",
			label: "PaperLoom",
			image: "content/icons/paperloom.svg"
		});
		log("偏好面板已注册: " + preferencePaneID);
	}
	catch (e) {
		log("偏好面板注册失败: " + e);
	}
}

// ------------------------------------------------------------------ 侧栏 section

function registerItemPaneSection() {
	if (!Zotero.ItemPaneManager || !Zotero.ItemPaneManager.registerSection) {
		log("当前 Zotero 版本不支持 ItemPaneManager.registerSection，侧栏面板不可用");
		return;
	}

	// Zotero 7.1+ / 10：header 与 sidenav 都必须带 icon，缺了会被 _validateObject
	// 直接判无效且只写日志，表现就是"插件装上了但侧栏什么都没有"。
	const ICON = "chrome://paperloom/content/icons/paperloom.svg";

	try {
		registeredSectionID = Zotero.ItemPaneManager.registerSection({
			paneID: "paperloom-chat",
			pluginID: PLUGIN_ID,
			header: { l10nID: "paperloom-section-header", icon: ICON },
			sidenav: { l10nID: "paperloom-section-sidenav", icon: ICON },
			bodyXHTML: '<html:div class="paperloom-section-root"></html:div>',
			onInit: ({ body }) => {
				if (body) body._paperloomFrame = null;
			},
			onRender: ({ body, item }) => {
				if (!body || !item) return;

				// 只建一次 iframe：onRender 每次切换条目都会调用，重建会丢对话状态。
				// 但折叠/展开后 body 可能被 Zotero 重建，此时旧引用已脱离文档，需要补建。
				if (body._paperloomFrame && !body.contains(body._paperloomFrame)) {
					body._paperloomFrame = null;
				}
				if (!body._paperloomFrame) {
					body.innerHTML = "";
					const doc = body.ownerDocument;
					const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
					// 必须走 chrome:// 资源：file:// 的 iframe 是独立 principal，
					// 拿不到 window.top.Zotero，面板会报"领域层未加载"。
					frame.setAttribute("src", "chrome://paperloom/content/chat.xhtml?mode=item");
					frame.style.cssText = "display:block;width:100%;height:460px;border:0;";
					body.appendChild(frame);
					body._paperloomFrame = frame;
				}

				postItemToFrame(body._paperloomFrame, item);
			}
		});
		log("侧栏 section 已注册: " + registeredSectionID);
	}
	catch (e) {
		log("侧栏 section 注册失败: " + e);
	}
}

/** 把当前条目 key 投递给面板 iframe（iframe 未加载完则等 load 事件） */
function postItemToFrame(frame, item) {
	const send = () => {
		try {
			frame.contentWindow.postMessage({
				type: "paperloom:item",
				itemKey: item.key,
				libraryID: item.libraryID
			}, "*");
		}
		catch (e) { /* iframe 尚未就绪 */ }
	};

	try {
		const doc = frame.contentDocument;
		if (doc && doc.readyState === "complete") send();
		else frame.addEventListener("load", send, { once: true });
	}
	catch (e) {
		frame.addEventListener("load", send, { once: true });
	}
}

// ------------------------------------------------------------------ 菜单与 Tab

function addToWindow(win) {
	if (!win || !win.document) return;
	const doc = win.document;
	if (doc.getElementById("paperloom-menu")) return;

	const toolsPopup = doc.getElementById("menu_ToolsPopup");
	if (!toolsPopup) return;

	const menu = doc.createXULElement("menu");
	menu.id = "paperloom-menu";
	menu.setAttribute("label", "PaperLoom");

	const popup = doc.createXULElement("menupopup");
	menu.appendChild(popup);

	popup.appendChild(makeMenuItem(doc, "paperloom-menu-graph", "打开知识图谱", () => openTab(win, "graph")));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-memory", "打开记忆卡片", () => openTab(win, "memory")));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-chat", "打开全库对话", () => openTab(win, "chat")));
	popup.appendChild(doc.createXULElement("menuseparator"));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-rebuild", "重建所选论文的图谱", () => rebuildSelected(win)));

	toolsPopup.appendChild(menu);
}

function makeMenuItem(doc, id, label, handler) {
	const item = doc.createXULElement("menuitem");
	item.id = id;
	item.setAttribute("label", label);
	item.addEventListener("command", handler);
	return item;
}

function removeFromWindow(win) {
	if (!win || !win.document) return;
	const menu = win.document.getElementById("paperloom-menu");
	if (menu) menu.remove();
}

const TAB_SPECS = {
	graph: { title: "PaperLoom 图谱", src: "chrome://paperloom/content/graph.xhtml" },
	memory: { title: "PaperLoom 记忆", src: "chrome://paperloom/content/memory.xhtml" },
	chat: { title: "PaperLoom 全库对话", src: "chrome://paperloom/content/chat.xhtml?mode=library" }
};

const openTabIDs = Object.create(null);

/** 自定义 Tab：Zotero_Tabs.add 是私有 API，失败则退回独立窗口 */
function openTab(win, kind) {
	const spec = TAB_SPECS[kind];
	if (!spec) return;

	const existing = openTabIDs[kind];
	if (existing && win.Zotero_Tabs) {
		try {
			win.Zotero_Tabs.select(existing);
			return;
		}
		catch (e) { delete openTabIDs[kind]; }
	}

	try {
		const { id, container } = win.Zotero_Tabs.add({
			type: "paperloom-" + kind,
			title: spec.title,
			select: true,
			onClose: () => { delete openTabIDs[kind]; }
		});
		openTabIDs[kind] = id;

		const frame = win.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
		frame.setAttribute("src", spec.src);
		frame.style.width = "100%";
		frame.style.height = "100%";
		frame.style.border = "0";
		frame.setAttribute("flex", "1");
		container.appendChild(frame);
	}
	catch (e) {
		// fallback：私有 API 变动时仍然能用独立窗口演示
		log("Zotero_Tabs.add 失败，退回独立窗口: " + e);
		win.openDialog(spec.src, "paperloom-" + kind,
			"chrome,resizable,centerscreen,width=1100,height=760");
	}
}

async function rebuildSelected(win) {
	try {
		const items = win.ZoteroPane.getSelectedItems().filter(i => i.isRegularItem());
		if (!items.length) {
			win.alert("请先在文库中选中至少一篇论文。");
			return;
		}
		if (!PaperLoom.LLM.isConfigured()) {
			win.alert("请先在 设置 → PaperLoom 中填入 API Key。");
			return;
		}

		const progressWin = new Zotero.ProgressWindow({ closeOnClick: false });
		progressWin.changeHeadline("PaperLoom 重建图谱");
		const entry = new progressWin.ItemProgress("chrome://zotero/skin/spinner-16px.png", "准备中…");
		progressWin.show();

		// 走 JobQueue，不在 UI 线程里跑抽取
		PaperLoom.JobQueue.enqueue({
			label: "重建图谱（" + items.length + " 篇）",
			run: async (report) => {
				const summary = await PaperLoom.Pipeline.rebuildGraph(items, (stage, info) => {
					if (stage === "paper") {
						entry.setText("(" + info.index + "/" + info.total + ") " + String(info.title || "").slice(0, 40));
						entry.setProgress(Math.round((info.index - 1) / info.total * 100));
					}
					report({ stage, info });
				});
				entry.setProgress(100);
				entry.setText("完成：新增 " + summary.addedNodes + " 节点 / " + summary.addedEdges + " 边"
					+ (summary.rejected ? "，丢弃无证据边 " + summary.rejected : ""));
				progressWin.startCloseTimer(8000);

				// 图谱页若开着，通知它刷新
				for (const w of Zotero.getMainWindows()) {
					w.postMessage && w.postMessage({ type: "paperloom:graph-updated" }, "*");
				}
			}
		});
	}
	catch (e) {
		Zotero.logError(e);
		win.alert("重建失败：" + e);
	}
}
