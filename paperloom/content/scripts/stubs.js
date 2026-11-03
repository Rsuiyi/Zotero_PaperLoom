/* PaperLoom — stubs.js
 * 第二阶段预留接口：现在不实现，但先把入口定死，避免二期改业务代码。
 *   TipEngine.evaluate(context) → 返回空数组
 *   JobQueue                    → 第一阶段只用来跑"手动重建图谱"，可暂停、可看进度、失败可重试
 */
if (typeof PaperLoom === "undefined") {
	var PaperLoom = {};
}

/** 主动提示引擎：第一阶段永远返回空数组 */
PaperLoom.TipEngine = (function () {
	async function evaluate(_context) {
		return [];
	}
	return { evaluate };
})();

/** 后台任务队列：绝不在 UI 线程里跑重活 */
PaperLoom.JobQueue = (function () {
	const jobs = [];
	let running = false;
	let paused = false;
	let current = null;
	const listeners = [];

	function onChange(fn) {
		listeners.push(fn);
		return () => {
			const i = listeners.indexOf(fn);
			if (i >= 0) listeners.splice(i, 1);
		};
	}

	function emit() {
		const snap = status();
		for (const fn of listeners) {
			try { fn(snap); } catch (e) { /* 监听器异常不影响队列 */ }
		}
	}

	function status() {
		return {
			pending: jobs.length,
			running: running,
			paused: paused,
			current: current ? { id: current.id, label: current.label, progress: current.progress } : null
		};
	}

	/** @param {Object} job { id?, label, run: async (report) => any, retries? } */
	function enqueue(job) {
		const entry = {
			id: job.id || PaperLoom.Schema.uid("job"),
			label: job.label || "任务",
			run: job.run,
			retries: typeof job.retries === "number" ? job.retries : 1,
			attempt: 0,
			progress: null
		};
		jobs.push(entry);
		emit();
		tick();
		return entry.id;
	}

	async function tick() {
		if (running || paused) return;
		const job = jobs.shift();
		if (!job) { emit(); return; }

		running = true;
		current = job;
		emit();

		try {
			await job.run((info) => {
				job.progress = info;
				emit();
			});
		}
		catch (e) {
			job.attempt++;
			if (job.attempt <= job.retries) {
				jobs.unshift(job);   // 失败可重试
			}
			else {
				try { Zotero.debug("[PaperLoom:JobQueue] 任务失败 " + job.label + ": " + e); } catch (e2) { /* ignore */ }
			}
		}
		finally {
			running = false;
			current = null;
			emit();
			if (jobs.length) tick();
		}
	}

	function pause() { paused = true; emit(); }
	function resume() { paused = false; emit(); tick(); }
	function clear() { jobs.length = 0; emit(); }

	return { enqueue, pause, resume, clear, status, onChange };
})();
