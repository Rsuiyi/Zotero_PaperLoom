/* PaperLoom — chunker.js
 * L2 领域层：全文提取 + 分块。纯逻辑，与运行环境无关的部分单独拆出，便于 Plan B 复用。
 * 产出 Chunk：400~800 字符、带 page（从 1 开始，用于跳转）、带 section 猜测。
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

PaperLoom.Chunker = (function () {
	const S = PaperLoom.Schema;

	const SECTION_PATTERNS = [
		{ section: "intro", re: /^\s*(\d+[.、]?\s*)?(introduction|background|引言|绪论|背景)\b/i },
		{ section: "method", re: /^\s*(\d+[.、]?\s*)?(method|methods|methodology|approach|model|materials and methods|方法|模型|算法)\b/i },
		{ section: "result", re: /^\s*(\d+[.、]?\s*)?(result|results|experiment|experiments|evaluation|实验|结果|评测)\b/i },
		{ section: "discussion", re: /^\s*(\d+[.、]?\s*)?(discussion|conclusion|conclusions|limitations|future work|讨论|结论|局限)\b/i }
	];

	function guessSection(text, current) {
		const head = String(text).slice(0, 120);
		for (const p of SECTION_PATTERNS) {
			if (p.re.test(head)) return p.section;
		}
		return current || "other";
	}

	/** 按句子边界切分，中英文都兼顾 */
	function splitSentences(text) {
		const parts = String(text)
			.replace(/\r\n/g, "\n")
			.split(/(?<=[.!?。！？;；])\s+|\n{2,}/);
		return parts.filter(p => p && p.trim().length > 0);
	}

	/**
	 * 把「带页码的文本页」切成 Chunk。
	 * @param {string} paperId
	 * @param {Array<{page:number, text:string}>} pages
	 */
	function chunkPages(paperId, pages) {
		const chunks = [];
		let section = "other";
		let index = 0;

		for (const pg of pages) {
			const pageNo = typeof pg.page === "number" && pg.page >= 1 ? pg.page : 1;
			const clean = normalizeText(pg.text);
			if (!clean) continue;

			section = guessSection(clean, section);

			let buffer = "";
			const sentences = splitSentences(clean);
			for (const sentence of sentences) {
				const candidate = buffer ? buffer + " " + sentence : sentence;
				if (candidate.length >= S.LIMITS.chunkMaxChars) {
					if (buffer.length >= S.LIMITS.chunkMinChars) {
						chunks.push(S.makeChunk({
							chunkId: S.chunkId(paperId, index++),
							paperId, page: pageNo, section, text: buffer
						}));
						buffer = sentence;
					}
					else {
						// 单句超长：硬切到上限，保证块大小可控
						chunks.push(S.makeChunk({
							chunkId: S.chunkId(paperId, index++),
							paperId, page: pageNo, section,
							text: candidate.slice(0, S.LIMITS.chunkMaxChars)
						}));
						buffer = candidate.slice(S.LIMITS.chunkMaxChars);
					}
				}
				else {
					buffer = candidate;
				}
			}

			if (buffer.trim()) {
				const last = chunks[chunks.length - 1];
				// 尾块过短时并回上一块，避免产生大量碎片
				if (buffer.length < S.LIMITS.chunkMinChars && last && last.page === pageNo
					&& last.text.length + buffer.length <= S.LIMITS.chunkMaxChars + 200) {
					last.text += " " + buffer.trim();
				}
				else {
					chunks.push(S.makeChunk({
						chunkId: S.chunkId(paperId, index++),
						paperId, page: pageNo, section, text: buffer.trim()
					}));
				}
			}
		}

		return chunks;
	}

	/**
	 * 把全文按 \f 分页符切成 pages。
	 * 空页跳过但保留真实页号（page = 下标 + 1），保证引用跳转不会整体错位。
	 */
	function fillPagesFromText(result, text) {
		const parts = String(text == null ? "" : text).split("\f");
		if (parts.length > 1) {
			for (let i = 0; i < parts.length; i++) {
				if (parts[i] && parts[i].trim()) result.pages.push({ page: i + 1, text: parts[i] });
			}
		}
		else if (text && String(text).trim()) {
			result.pages.push({ page: 1, text: text });
		}
	}

	function normalizeText(text) {
		return String(text == null ? "" : text)
			.replace(/\u0000/g, "")
			.replace(/-\n(?=[a-z])/g, "")      // 行尾连字符断词还原
			.replace(/[ \t\u00a0]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	}

	/**
	 * 从 Zotero 条目提取「页 -> 文本」。
	 * 优先走 PDF 附件的 pdftotext 缓存（带页分隔符 \f），拿不到就退回全文索引表，
	 * 退回路径没有真实页码时统一记为第 1 页，并在 UI 上提示引用无法精确定位。
	 */
	async function extractPages(item) {
		const result = { pages: [], attachmentId: null, source: "none", errors: [] };

		// 附件解析：正常是"条目 → 最佳附件"；如果拿到的本身就是附件（用户在列表里选了 PDF），直接用
		let attachment = null;
		try {
			if (item.isRegularItem && item.isRegularItem()) {
				attachment = await item.getBestAttachment();
			}
			else if (item.isAttachment && item.isAttachment()) {
				attachment = item;
			}
		}
		catch (e) {
			result.errors.push("getBestAttachment: " + e);
		}

		// 兜底：getBestAttachment 失败时，自己在子条目里找 PDF
		if (!attachment && item.getAttachments) {
			try {
				const ids = item.getAttachments() || [];
				for (const id of ids) {
					const att = Zotero.Items.get(id);
					if (att && att.attachmentContentType === "application/pdf") {
						attachment = att;
						break;
					}
				}
			}
			catch (e) {
				result.errors.push("getAttachments: " + e);
			}
		}

		if (attachment) {
			result.attachmentId = attachment.id;
			// 路径 1：Zotero 的 pdftotext 缓存文件，带 \f 分页符 —— 唯一能拿到真实页码的途径
			try {
				const cachePath = Zotero.Fulltext.getItemCacheFile
					? Zotero.Fulltext.getItemCacheFile(attachment).path
					: null;
				if (cachePath && await IOUtils.exists(cachePath)) {
					const raw = await IOUtils.readUTF8(cachePath);
					const pageTexts = raw.split("\f");
					for (let i = 0; i < pageTexts.length; i++) {
						if (pageTexts[i] && pageTexts[i].trim()) {
							result.pages.push({ page: i + 1, text: pageTexts[i] });
						}
					}
					if (result.pages.length) {
						result.source = "pdftotext-cache";
						return result;
					}
				}
			}
			catch (e) { result.errors.push("cache: " + e); }

			// 路径 2：直接让 PDFWorker 抽文本。
			// 这是 7–10 都存在的接口；10 虽然删了 Fulltext.getIndexedText()，但这条不受影响。
			// 返回的 text 同样带 \f 分页符，能保留真实页码。
			try {
				if (Zotero.PDFWorker && Zotero.PDFWorker.getFullText) {
					const full = await Zotero.PDFWorker.getFullText(attachment.id);
					const text = full && full.text;
					if (text && text.trim()) {
						fillPagesFromText(result, text);
						if (result.pages.length) {
							result.source = "pdfworker";
							return result;
						}
					}
				}
			}
			catch (e) { result.errors.push("pdfworker: " + e); }

			// 路径 3：Zotero 7–9 的旧接口（10 已移除，所以用能力探测而不是版本号判断）
			try {
				const caps = PaperLoom.Compat.caps();
				if (caps.fulltextIndexedText) {
					const text = await Zotero.Fulltext.getIndexedText(attachment.id);
					if (text && String(text).trim()) {
						fillPagesFromText(result, text);
						if (result.pages.length) {
							result.source = "fulltext-indexed-text";
							return result;
						}
					}
				}
			}
			catch (e) { result.errors.push("indexedText: " + e); }

			// 路径 4：强制建一次全文索引，再读缓存文件。
			// 有些环境（PDF 转换器缺失、EPUB 等）前两条都拿不到文本，索引是最后一条兜底。
			try {
				const caps = PaperLoom.Compat.caps();
				if (caps.fulltextIndexItems && caps.fulltextCache) {
					await Zotero.Fulltext.indexItems([attachment.id], { complete: true, ignoreErrors: true });
					const cachePath = Zotero.Fulltext.getItemCacheFile(attachment).path;
					if (cachePath && await IOUtils.exists(cachePath)) {
						fillPagesFromText(result, await IOUtils.readUTF8(cachePath));
						if (result.pages.length) {
							result.source = "fulltext-indexed";
							return result;
						}
					}
				}
			}
			catch (e) { result.errors.push("indexItems: " + e); }
		}

		// 路径 5：没有附件全文，退回元数据摘要，至少让对话有上下文
		const abs = item.getField ? (item.getField("abstractNote") || "") : "";
		if (abs.trim()) {
			result.pages.push({ page: 1, text: abs });
			result.source = "abstract-only";
		}
		return result;
	}

	/** 解析一篇论文为 PaperDoc；已解析且未过期则直接读缓存 */
	async function buildPaperDoc(item, opts) {
		opts = opts || {};

		// 统一到"常规条目"：如果传进来的是 PDF 附件，用它的父条目做 paperId，
		// 否则 doc.paperId 会和调用方传入的 item.key 对不上，导致检索时找不到当前论文。
		let paperItem = item;
		try {
			if (item && item.isAttachment && item.isAttachment() && item.parentItemID) {
				paperItem = Zotero.Items.get(item.parentItemID) || item;
			}
		}
		catch (e) { /* 保持原样 */ }

		const paperId = paperItem.key;

		if (!opts.force) {
			const cached = await PaperLoom.Storage.readPaperDoc(paperId);
			if (cached && cached.version === S.SCHEMA_VERSION && cached.chunks && cached.chunks.length) {
				return cached;
			}
		}

		const extracted = await extractPages(paperItem);
		const chunks = chunkPages(paperId, extracted.pages);

		const creators = paperItem.getCreators ? paperItem.getCreators() : [];
		const doc = S.makePaperDoc({
			paperId: paperId,
			title: paperItem.getField ? paperItem.getField("title") : "",
			authors: creators.map(c => [c.firstName, c.lastName].filter(Boolean).join(" ")),
			year: paperItem.getField ? (String(paperItem.getField("date") || "").match(/\d{4}/) || [""])[0] : "",
			venue: paperItem.getField ? (paperItem.getField("publicationTitle") || paperItem.getField("proceedingsTitle") || "") : "",
			attachmentId: extracted.attachmentId,
			chunks: chunks
		});
		doc.textSource = extracted.source;
		doc.extractionErrors = extracted.errors || [];

		await PaperLoom.Storage.writePaperDoc(doc);
		return doc;
	}

	return { chunkPages, extractPages, buildPaperDoc, guessSection, normalizeText, splitSentences };
})();
