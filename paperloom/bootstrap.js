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

		// 旧版单服务商配置迁移成服务商列表（只在列表为空时执行一次）
		PaperLoom.LLM.migrateLegacy();

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
		registerReaderUI();

		for (const win of Zotero.getMainWindows()) {
			addToWindow(win);
		}

		// 诊断自检：启动后跑一次模型列表，把结果写到数据目录。
		// 目的不是功能，而是让"拉不到模型"能留下可读的证据，而不是只能靠猜。
		try {
			if (Zotero.Prefs.get("extensions.paperloom.selfTest", true) !== false) {
				setTimeout(runModelSelfTest, 5000);
			}
		}
		catch (e) { /* 偏好未定义也不影响主流程 */ }

		log("startup 完成 v" + version);
	}
	catch (e) {
		// 不让异常被静默吞掉，否则表现为"装上了但什么都没有"
		Zotero.logError(e);
		log("startup 失败: " + e + "\n" + (e.stack || ""));
	}
}

/**
 * 模型接口自检。
 * 把「用的什么地址、Key 多长、试了哪些 URL、每个 URL 的结果、最终返回什么」
 * 全部落到 <数据目录>/paperloom/selftest.json，便于在没有控制台的机器上定位。
 */
async function runModelSelfTest() {
	const out = { at: new Date().toISOString() };
	try {
		if (!PaperLoom || !PaperLoom.LLM) {
			throw new Error("领域层未加载（PaperLoom.LLM 不可用）");
		}
		out.providers = PaperLoom.LLM.getProviders().map(p => ({
			name: p.name, baseURL: p.baseURL, models: (p.models || []).length,
			keyLength: String(p.apiKey || "").length
		}));

		const cfg = PaperLoom.LLM.config();
		if (!cfg.chat) {
			throw new Error("尚未选择对话模型");
		}

		out.chat = {
			provider: cfg.chat.providerName,
			baseURL: cfg.chat.baseURL,
			model: cfg.chat.model,
			keyLength: String(cfg.chat.apiKey || "").length
		};

		const result = await PaperLoom.LLM.listModels(cfg.chat);
		out.count = result.models.length;
		out.models = result.models.slice(0, 50);
		out.url = result.url;
		out.ok = true;
	}
	catch (e) {
		out.ok = false;
		out.error = String((e && e.message) || e);
		if (e && e.tried) out.tried = e.tried;
		out.stack = e && e.stack ? String(e.stack).split("\n").slice(0, 6) : null;
	}

	try {
		await PaperLoom.Storage.writeJSON("selftest.json", out);
	}
	catch (e) {
		Zotero.debug("[PaperLoom] 自检结果写入失败: " + e);
	}
	Zotero.debug("[PaperLoom] 模型自检: " + JSON.stringify(out));
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
	installDock(win);

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
			toggleDock(doc.defaultView);
		}
		catch (e) {
			log("工具栏按钮切换右侧面板失败: " + e);
		}
	});

	// 放在弹性 spacer 之前，避免被挤到最右边
	const spacer = toolbar.querySelector('spacer[flex="1"]');
	toolbar.insertBefore(btn, spacer || null);
}

/**
 * 右侧常驻面板。
 * 挂在 #zotero-layout-switcher 的末尾（条目列表 / 分隔条 / 条目详情之后），
 * 自带一条可拖动 splitter，宽度随用户拖动变化 —— 这就是"一直待在右侧"的实现。
 */
function installDock(win) {
	const doc = win.document;
	if (!doc || doc.getElementById("paperloom-dock")) return;

	// 挂在 #browser（整个标签区的横向父容器）上，而不是某个标签页内部：
	// 这样切到 PDF 阅读器标签时，右侧面板依然在。
	const host = doc.getElementById("browser") || doc.getElementById("zotero-layout-switcher");
	if (!host) {
		log("找不到主布局容器（#browser），右侧面板不可用");
		return;
	}

	const splitter = doc.createXULElement("splitter");
	splitter.id = "paperloom-dock-splitter";
	splitter.setAttribute("orient", "horizontal");
	splitter.setAttribute("resizebefore", "closest");
	splitter.setAttribute("resizeafter", "closest");

	const dock = doc.createXULElement("vbox");
	dock.id = "paperloom-dock";
	dock.setAttribute("width", "420");
	dock.setAttribute("style", "min-width:320px;max-width:760px;");

	const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
	frame.id = "paperloom-dock-frame";
	// mode=item：默认跟随当前选中的论文；选中变化由下面的轮询投递
	frame.setAttribute("src", "chrome://paperloom/content/chat.xhtml?mode=item");
	frame.setAttribute("flex", "1");
	frame.style.cssText = "border:0;display:block;width:100%;height:100%;";

	dock.appendChild(frame);
	host.appendChild(splitter);
	host.appendChild(dock);

	// 跟随选中条目。用轮询而不是私有选择事件，跨版本更稳。
	let lastKey = null;
	dock._paperloomTimer = win.setInterval(() => {
		try {
			const pane = win.ZoteroPane;
			const items = pane && pane.getSelectedItems();
			const item = items && items.find(i => i.isRegularItem && i.isRegularItem());
			if (!item || item.key === lastKey) return;
			lastKey = item.key;
			frame.contentWindow.postMessage({
				type: "paperloom:item",
				itemKey: item.key,
				libraryID: item.libraryID
			}, "*");
		}
		catch (e) { /* 窗口关闭中 */ }
	}, 1200);
}

/**
 * 阅读器工具栏按钮。
 * 文献列表的工具栏在 PDF 标签页里不可见，所以阅读器里必须另有一个入口。
 */
function registerReaderUI() {
	if (!Zotero.Reader) return;

	const handler = (event) => {
		try {
			if (event.reader) injectReaderButton(event.reader);

			// 官方 append 通道也走一遍（不同版本只认其中一种）
			const doc = event.doc;
			if (doc && !doc.getElementById("paperloom-reader-btn") && typeof event.append === "function") {
				const btn = makeReaderButton(doc);
				if (btn) event.append(btn);
			}
		}
		catch (e) {
			log("阅读器工具栏按钮注入失败: " + e);
		}
	};

	if (typeof Zotero.Reader.registerEventListener === "function") {
		Zotero.Reader.registerEventListener("renderToolbar", handler, PLUGIN_ID);
	}

	// 已经打开的 reader 不会再触发 renderToolbar，延迟补两次
	const sweep = () => {
		try {
			for (const r of (Zotero.Reader._readers || [])) injectReaderButton(r);
		}
		catch (e) { /* ignore */ }
	};
	setTimeout(sweep, 2000);
	setTimeout(sweep, 8000);
}

function makeReaderButton(doc) {
	if (!doc || doc.getElementById("paperloom-reader-btn")) return null;

	const btn = doc.createElement("button");
	btn.id = "paperloom-reader-btn";
	btn.className = "toolbar-button";
	btn.title = "显示 / 隐藏右侧 PaperLoom 面板";
	btn.style.cssText = "width:30px;height:26px;padding:0;margin:0 4px;display:inline-flex;"
		+ "align-items:center;justify-content:center;border:1px solid #c9c9c9;border-radius:6px;"
		+ "background:#fff;cursor:pointer;";

	// 内联 SVG，避免 chrome:// 资源在 reader iframe 里加载失败露出 alt 文本
	const SVG_NS = "http://www.w3.org/2000/svg";
	const svg = doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "#2e7fe0");
	svg.setAttribute("stroke-width", "1.8");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.style.cssText = "display:block;pointer-events:none;";
	svg.innerHTML = '<circle cx="5" cy="6" r="2.2"></circle>'
		+ '<circle cx="19" cy="7" r="2.2"></circle>'
		+ '<circle cx="12" cy="13" r="2.6"></circle>'
		+ '<circle cx="6" cy="19" r="2.2"></circle>'
		+ '<circle cx="18" cy="18" r="2.2"></circle>'
		+ '<path d="M6.9 7.4 10 11.3M17 8.6 13.9 11.6M10.3 15 7.6 17.3M14 14.6l2.4 2"></path>';
	btn.appendChild(svg);

	btn.addEventListener("click", () => toggleDock(Zotero.getMainWindow()));
	return btn;
}

/** 直接往 reader 的工具栏里塞按钮（已打开的 reader 只能走这条路） */
function injectReaderButton(reader) {
	try {
		const win = reader._iframeWindow && (reader._iframeWindow.wrappedJSObject || reader._iframeWindow);
		const doc = win && win.document;
		if (!doc || doc.getElementById("paperloom-reader-btn")) return;

		const btn = makeReaderButton(doc);
		if (!btn) return;

		// 优先放进工具栏右侧的 .end 容器（AI Sidebar 也挂这里），否则附到工具栏末尾
		const end = doc.querySelector(".toolbar > .end") || doc.querySelector(".toolbar .end");
		if (end && typeof end.prepend === "function") {
			end.prepend(btn);
			return;
		}
		const toolbar = doc.querySelector(".toolbar") || doc.getElementById("toolbarContainer");
		if (toolbar) toolbar.appendChild(btn);
	}
	catch (e) {
		log("reader 按钮注入失败: " + e);
	}
}

/**
 * 把对话框挪到屏幕中央。
 * centerscreen 在部分窗口管理器/多屏环境下不生效，窗口会贴在上沿；
 * 这里在打开后再手动纠一次位置。
 */
function removeDock(win) {
	try {
		const doc = win.document;
		if (!doc) return;
		const dock = doc.getElementById("paperloom-dock");
		if (dock) {
			if (dock._paperloomTimer) win.clearInterval(dock._paperloomTimer);
			dock.remove();
		}
		const splitter = doc.getElementById("paperloom-dock-splitter");
		if (splitter) splitter.remove();
	}
	catch (e) { /* ignore */ }
}

/** 工具栏按钮：显示 / 隐藏右侧面板 */
function toggleDock(win) {
	try {
		const doc = win.document;
		let dock = doc.getElementById("paperloom-dock");
		if (!dock) {
			installDock(win);
			dock = doc.getElementById("paperloom-dock");
		}
		if (!dock) return;

		const splitter = doc.getElementById("paperloom-dock-splitter");
		const hidden = dock.hasAttribute("hidden");
		if (hidden) {
			dock.removeAttribute("hidden");
			if (splitter) splitter.removeAttribute("hidden");
		}
		else {
			dock.setAttribute("hidden", "true");
			if (splitter) splitter.setAttribute("hidden", "true");
		}
	}
	catch (e) {
		log("切换右侧面板失败: " + e);
	}
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
	removeDock(win);
}

const TAB_SPECS = {
	// itemchat 是侧栏不可用时的替代入口：面板会自己读取当前选中条目
	itemchat: { title: "PaperLoom 对话", src: "chrome://paperloom/content/chat.xhtml?mode=item" },
	graph: { title: "PaperLoom 图谱", src: "chrome://paperloom/content/graph.xhtml" },
	memory: { title: "PaperLoom 记忆", src: "chrome://paperloom/content/memory.xhtml" },
	chat: { title: "PaperLoom 全库对话", src: "chrome://paperloom/content/chat.xhtml?mode=library" },
	settings: { title: "PaperLoom 设置", src: "chrome://paperloom/content/settings.xhtml" }
};

/**
 * 独立设置窗口。
 * Zotero 10 / Firefox 140 起 window.openDialog 不一定还在：
 * 它一旦抛错，旧代码会退回成"标签页"，看起来就是永久贴在内容区上沿。
 * 这里按 openDialog → window.open → Services.ww.openWindow 依次尝试，都是真窗口。
 */
function openSettings(win) {
	const url = "chrome://paperloom/content/settings.xhtml";

	// 只走 openDialog：Zotero 自己在用这个 API，可靠。
	// 之前叠了 window.open / Services.ww.openWindow 三条回退，会额外造窗口并抢焦点。
	const features = "chrome,dialog=no,resizable,centerscreen,width=700,height=700";

	try {
		const w = win.openDialog(url, "paperloom-settings", features,
			{ Zotero: Zotero, PaperLoom: PaperLoom });
		if (w) return;
	}
	catch (e) {
		log("openDialog 打开设置失败: " + e);
	}

	openTab(win, "settings");
}

const openTabIDs = Object.create(null);

/** 自定义 Tab：Zotero_Tabs.add 是私有 API，失败则退回独立窗口 */
function openTab(win, kind) {
	const spec = TAB_SPECS[kind];
	if (!spec) return;

	// 记忆 / 图谱固定用独立窗口：不要塞进 Zotero 的标签栏
	const WINDOW_ONLY = { graph: true, memory: true };
	if (WINDOW_ONLY[kind]) {
		try {
			win.openDialog(spec.src, "paperloom-" + kind,
				"chrome,resizable,centerscreen,width=1100,height=760",
				{ Zotero: Zotero, PaperLoom: PaperLoom });
			return;
		}
		catch (e) {
			log("独立窗口打开失败，退回标签页: " + e);
		}
	}

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
			win.alert("请先在 设置 → PaperLoom 中添加模型服务商并选择模型。");
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
