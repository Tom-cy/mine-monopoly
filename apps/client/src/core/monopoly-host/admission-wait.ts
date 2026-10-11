export interface AdmissionWait<T> {
	promise: Promise<T>;
	cancel: (reason: Error) => void;
}

/** 注册必须发生在发消息前；所有结束路径都会移除监听并清理计时器。 */
export function createAdmissionWait<T>(options: {
	subscribe: (listener: (value: T) => void) => void;
	unsubscribe: (listener: (value: T) => void) => void;
	timeoutMs: number;
	timeoutMessage: string;
}): AdmissionWait<T> {
	let settled = false;
	let rejectWait!: (error: Error) => void;
	let listener!: (value: T) => void;
	let timeout: ReturnType<typeof setTimeout>;
	const cleanup = () => {
		clearTimeout(timeout);
		options.unsubscribe(listener);
	};
	const promise = new Promise<T>((resolve, reject) => {
		rejectWait = reject;
		listener = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(options.timeoutMessage));
		}, options.timeoutMs);
		options.subscribe(listener);
	});
	// 调用方先注册再发包，发包同步失败时取消也不会产生未处理的 rejection。
	void promise.catch(() => undefined);
	return {
		promise,
		cancel(reason) {
			if (settled) return;
			settled = true;
			cleanup();
			rejectWait(reason);
		},
	};
}
