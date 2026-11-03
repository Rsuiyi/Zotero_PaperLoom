/* PaperLoom — storage.js
 * L0 本地文件存储：把图谱 / 记忆 / 对话 / LLM 缓存落盘为 JSON。
 * 不自建数据库、不依赖云同步，默认写在 Zotero 数据目录下的 paperloom/ 子目录。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Storage = (function () {
	let _root = null;
	const _cache = Object.create(null);   // 文件名 -> 已解析对象，避免反复读盘
	const _queue = Object.create(null);   // 文件名 -> 串行写入 Promise，避免并发覆写

	function log(msg) {
		try { Zotero.debug("[PaperLoom:Storage] " + msg); } catch (e) { /* 非 Zotero 环境 */ }
	}

	/** 根目录：优先用偏好里的自定义路径，否则 <Zotero 数据目录>/paperloom */
	function root() {
		if (_root) return _root;
		let custom = "";
		try { custom = Zotero.Prefs.get("extensions.paperloom.dataDir", true) || ""; } catch (e) { /* ignore */ }
		if (custom) {
			_root = custom;
		}
		else {
			_root = PathUtils.join(Zotero.DataDirectory.dir, "paperloom");
		}
		return _root;
	}

	function pathFor(name) {
		return PathUtils.join(root(), name);
	}

	async function ensureDir() {
		await IOUtils.makeDirectory(root(), { ignoreExisting: true });
		await IOUtils.makeDirectory(PathUtils.join(root(), "cache"), { ignoreExisting: true });
		await IOUtils.makeDirectory(PathUtils.join(root(), "papers"), { ignoreExisting: true });
	}

	async function readJSON(name, fallback) {
		if (Object.prototype.hasOwnProperty.call(_cache, name)) {
			return _cache[name];
		}
		try {
			const data = await IOUtils.readJSON(pathFor(name));
			_cache[name] = data;
			return data;
		}
		catch (e) {
			_cache[name] = fallback;
			return fallback;
		}
	}

	/** 串行化写入：同一文件的写请求排队，杜绝并发 delta 互相覆盖 */
	function writeJSON(name, data) {
		_cache[name] = data;
		const prev = _queue[name] || Promise.resolve();
		const next = prev.then(async () => {
			await ensureDir();
			await IOUtils.writeJSON(pathFor(name), data, { tmpPath: pathFor(name) + ".tmp" });
		}).catch((e) => {
			log("写入失败 " + name + ": " + e);
		});
		_queue[name] = next;
		return next;
	}

	async function readCache(key) {
		try {
			return await IOUtils.readUTF8(PathUtils.join(root(), "cache", key + ".json"));
		}
		catch (e) {
			return null;
		}
	}

	async function writeCache(key, text) {
		await ensureDir();
		await IOUtils.writeUTF8(PathUtils.join(root(), "cache", key + ".json"), text);
	}

	/** 解析后的论文文档按 paperId 分文件存，避免单个大 JSON 反复重写 */
	async function readPaperDoc(paperId) {
		try {
			return await IOUtils.readJSON(PathUtils.join(root(), "papers", paperId + ".json"));
		}
		catch (e) {
			return null;
		}
	}

	async function writePaperDoc(doc) {
		await ensureDir();
		await IOUtils.writeJSON(PathUtils.join(root(), "papers", doc.paperId + ".json"), doc);
	}

	async function listPaperDocs() {
		try {
			const entries = await IOUtils.getChildren(PathUtils.join(root(), "papers"));
			const docs = [];
			for (const p of entries) {
				if (!p.endsWith(".json")) continue;
				try { docs.push(await IOUtils.readJSON(p)); } catch (e) { /* 跳过损坏文件 */ }
			}
			return docs;
		}
		catch (e) {
			return [];
		}
	}

	function invalidate(name) {
		delete _cache[name];
	}

	return {
		root, pathFor, ensureDir,
		readJSON, writeJSON,
		readCache, writeCache,
		readPaperDoc, writePaperDoc, listPaperDocs,
		invalidate
	};
})();
