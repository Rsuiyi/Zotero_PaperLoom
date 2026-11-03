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
		// compat.js 必须第一个加载：后面所有模块都通过它判断当前 Zotero 有哪些能力
		const scripts = [
			"compat.js", "schema.js", "storage.js", "llm.js", "chunker.js",
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
		log("能力探测：" + PaperLoom.Compat.describe() + "（列出的是当前版本缺失的能力）");

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
	if (!PaperLoom.Compat.caps().preferencePanes) {
		log("当前 Zotero 不支持 PreferencePanes.register，跳过设置面板（不影响主功能）");
		return;
	}

	// src 统一用相对插件根目录的路径，由各版本自行解析；
	// 传绝对 file:// URI 在部分版本上会被当成外部地址。
	const base = {
		pluginID: PLUGIN_ID,
		// 面板里直接内嵌 settings.xhtml?embed=1，点进 PaperLoom 就是完整设置
		src: "content/preferences.xhtml",
		label: "PaperLoom"
	};

	try {
		preferencePaneID = await Zotero.PreferencePanes.register(
			Object.assign({ image: "content/icons/paperloom.svg" }, base)
		);
		log("偏好面板已注册: " + preferencePaneID);
	}
	catch (e) {
		// image 这类可选字段在旧版本可能不被接受：去掉再试一次
		try {
			preferencePaneID = await Zotero.PreferencePanes.register(base);
			log("偏好面板已注册（无图标）: " + preferencePaneID);
		}
		catch (e2) {
			log("偏好面板注册失败: " + e2);
		}
	}
}

// ------------------------------------------------------------------ 侧栏 section

function registerItemPaneSection() {
	if (!PaperLoom.Compat.caps().itemPaneSections) {
		log("当前 Zotero 不支持 ItemPaneManager.registerSection，侧栏不可用；"
			+ "已保留「工具 → PaperLoom → 打开对话面板」的窗口入口");
		return;
	}

	const ICON = "chrome://paperloom/content/icons/paperloom.svg";

	try {
		// sectionOptions 会补齐各版本对 header/sidenav 的必填项（icon 等），
		// 这里不写任何版本号判断。
		registeredSectionID = Zotero.ItemPaneManager.registerSection(PaperLoom.Compat.sectionOptions({
			paneID: "paperloom-chat",
			pluginID: PLUGIN_ID,
			header: { l10nID: "paperloom-section-header" },
			sidenav: { l10nID: "paperloom-section-sidenav" },
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
					// 给对话 + 下方记忆/图谱面板留出高度；窗口不够时由 Zotero 侧栏自己滚动
					frame.style.cssText = "display:block;width:100%;height:560px;border:0;";
					body.appendChild(frame);
					body._paperloomFrame = frame;
				}

				postItemToFrame(body._paperloomFrame, item);
			}
		}, ICON));

		if (!registeredSectionID) {
			throw new Error("registerSection 返回 false：选项未通过当前版本的校验");
		}
		log("侧栏 section 已注册: " + registeredSectionID);
	}
	catch (e) {
		log("侧栏 section 注册失败（不影响窗口入口）: " + e);
		registeredSectionID = null;
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

	// 工具菜单是 Zotero 7–10 都有的稳定入口；万一没有，退到主菜单栏
	const host = doc.getElementById("menu_ToolsPopup") || doc.getElementById("main-menubar");
	if (!host) {
		log("找不到可用菜单容器，菜单入口未挂载");
		return;
	}

	addToolbarButton(doc);

	const menu = doc.createXULElement("menu");
	menu.id = "paperloom-menu";
	menu.setAttribute("label", "PaperLoom");

	const popup = doc.createXULElement("menupopup");
	menu.appendChild(popup);

	// 侧栏不可用时，这一项就是唯一的对话入口（不依赖 ItemPaneManager）
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-itemchat", "打开对话面板（当前论文）", () => openTab(win, "itemchat")));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-graph", "打开知识图谱", () => openTab(win, "graph")));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-memory", "打开记忆卡片", () => openTab(win, "memory")));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-chat", "打开全库对话", () => openTab(win, "chat")));
	popup.appendChild(doc.createXULElement("menuseparator"));
	// 独立设置窗口：不依赖 Zotero 原生设置面板，任何版本都能配模型与 Key
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-settings", "设置…", () => openSettings(win)));
	popup.appendChild(makeMenuItem(doc, "paperloom-menu-rebuild", "重建所选论文的图谱", () => rebuildSelected(win)));

	host.appendChild(menu);
}

/**
 * 常驻顶部工具栏按钮。
 * 做法同 Zotero AI Sidebar：插进 #zotero-items-toolbar 的 flex spacer 之前，
 * 这样它一直显示，不需要先展开条目侧栏。
 */
function addToolbarButton(doc) {
	if (doc.getElementById("paperloom-toolbar-btn")) return;

	// 首选条目列表工具栏（AI Sidebar 也挂这里）；不同版本布局不同，按顺序找可用的
	const toolbar = doc.getElementById("zotero-items-toolbar")
		|| doc.getElementById("zotero-toolbar-item-tree")
		|| doc.getElementById("zotero-tabs-toolbar");
	if (!toolbar) {
		log("找不到主工具栏，顶部按钮未挂载");
		return;
	}

	const btn = doc.createXULElement("toolbarbutton");
	btn.id = "paperloom-toolbar-btn";
	btn.setAttribute("class", "zotero-tb-button");
	btn.setAttribute("tooltiptext", "PaperLoom 跨论文研究助手");

	const icon = "chrome://paperloom/content/icons/paperloom.svg";
	btn.setAttribute("image", icon);
	btn.style.listStyleImage = 'url("' + icon + '")';

	btn.addEventListener("command", () => {
		try {
			openTab(doc.defaultView, "chat");
		}
		catch (e) {
			log("工具栏按钮打开面板失败: " + e);
		}
	});

	// 放在弹性 spacer 之前，避免被挤到最右边
	const spacer = toolbar.querySelector('spacer[flex="1"]');
	toolbar.insertBefore(btn, spacer || null);
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
	const btn = win.document.getElementById("paperloom-toolbar-btn");
	if (btn) btn.remove();
}

const TAB_SPECS = {
	// itemchat 是侧栏不可用时的替代入口：面板会自己读取当前选中条目
	itemchat: { title: "PaperLoom 对话", src: "chrome://paperloom/content/chat.xhtml?mode=item" },
	graph: { title: "PaperLoom 图谱", src: "chrome://paperloom/content/graph.xhtml" },
	memory: { title: "PaperLoom 记忆", src: "chrome://paperloom/content/memory.xhtml" },
	chat: { title: "PaperLoom 全库对话", src: "chrome://paperloom/content/chat.xhtml?mode=library" },
	settings: { title: "PaperLoom 设置", src: "chrome://paperloom/content/settings.xhtml" }
};

/** 独立设置窗口：openDialog 失败时退回 Tab，保证配置入口永远存在 */
function openSettings(win) {
	const url = "chrome://paperloom/content/settings.xhtml";
	try {
		win.openDialog(url, "paperloom-settings",
			"chrome,centerscreen,resizable,width=700,height=720",
			{ Zotero: Zotero, PaperLoom: PaperLoom });
	}
	catch (e) {
		log("独立设置窗口打开失败，退回 Tab: " + e);
		openTab(win, "settings");
	}
}

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

	// Compat.openTab 内部按能力选择：自定义 Tab → 独立窗口。
	// 任何版本上都不会因为私有 API 缺失而失去入口。
	const opened = PaperLoom.Compat.openTab(win, {
		type: "paperloom-" + kind,
		title: spec.title,
		src: spec.src,
		onClose: () => { delete openTabIDs[kind]; }
	});

	if (!opened) return;   // 已退回独立窗口

	openTabIDs[kind] = opened.id;
	const frame = win.document.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
	frame.setAttribute("src", spec.src);
	frame.style.cssText = "width:100%;height:100%;border:0;";
	frame.setAttribute("flex", "1");
	opened.container.appendChild(frame);
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
