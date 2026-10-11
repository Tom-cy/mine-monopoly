/** 大地图下载最多等待五分钟，另为解密、解压与资源装配预留两分钟。 */
export const MAP_DOWNLOAD_TIMEOUT_MS = 300_000;
export const MAP_RESOURCE_TIMEOUT_MS = 120_000;
export const MAP_LOAD_TIMEOUT_MS = MAP_DOWNLOAD_TIMEOUT_MS + MAP_RESOURCE_TIMEOUT_MS;

export interface MapLoadOptions {
	signal?: AbortSignal;
}

export function assertMapLoadActive(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("地图加载已取消");
}

/** 离房或换图会同步取消 HTTP 请求；即使没有调用方，也不会无限等待下载。 */
export async function withMapDownloadSignal<T>(
	signal: AbortSignal | undefined,
	load: (signal: AbortSignal) => Promise<T>,
	timeoutMs = MAP_DOWNLOAD_TIMEOUT_MS,
): Promise<T> {
	assertMapLoadActive(signal);
	const controller = new AbortController();
	const cancel = () => controller.abort(signal?.reason || new Error("地图加载已取消"));
	signal?.addEventListener("abort", cancel, { once: true });
	const timeout = setTimeout(() => controller.abort(new Error("地图文件下载超时，请检查网络后重新入房")), timeoutMs);
	try {
		return await load(controller.signal);
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", cancel);
	}
}
