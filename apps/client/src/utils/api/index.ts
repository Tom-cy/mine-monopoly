import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import { FPMessage } from "@mine-monopoly/ui";
import { __MONOPOLYSERVER__ } from "@src/../global.config";
import {
	clearAccountSession, clearRealmSession, getAccountSession, getAccountToken, getActiveRealm,
	getRealmToken, getRealmSession, getSessionGeneration, saveAccountSession, synchronizeSessionStorage,
	tokenClaims,
} from "../auth/session";
import type { AccountAuth, AccountProfile, Result } from "./types";
import { resolveAccountProfile } from "./resources";

declare module "axios" {
	export interface AxiosRequestConfig {
		silent?: boolean;
		identity?: "account" | "realm" | "none";
		_authRetried?: boolean;
		_authToken?: string | null;
		_authSessionId?: string;
		expectedRealmSessionId?: string;
	}
}

export const AXIOS_HANDLED_ERROR = Symbol("__axios_handled_error__");

export class MonopolyApiError extends Error {
	readonly [AXIOS_HANDLED_ERROR] = true;
	constructor(public readonly code: number, message: string, public readonly response?: AxiosResponse, public readonly staleIdentity = false) {
		super(message);
		this.name = "MonopolyApiError";
	}
}

export function getApiErrorCode(error: unknown): number | undefined {
	if (error instanceof MonopolyApiError) return error.code;
	if (axios.isAxiosError(error)) return (error.response?.data as Result<unknown> | undefined)?.code;
	return undefined;
}

const apiClient = axios.create({ baseURL: __MONOPOLYSERVER__, timeout: 15000 });
let refreshPromise: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_BEFORE_EXPIRY_MS = 60_000;

/** Player credentials use TLS; loopback HTTP is reserved for the local Vite proxy. */
export function assertCredentialTransport() {
	if (typeof window === "undefined") return;
	const origin = window.location.origin === "null" ? "http://localhost" : window.location.origin;
	const target = new URL(__MONOPOLYSERVER__, origin);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
	if (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) {
		throw new MonopolyApiError(46000, "请通过 HTTPS 访问游戏服务，本机开发可使用 localhost");
	}
}

/** Only one rotation per tab. An old in-flight refresh cannot revive a signed-out session. */
export function doRefresh(): Promise<boolean> {
	if (refreshPromise) return refreshPromise;
	const session = getAccountSession();
	if (!session || session.refreshExpiresAt <= Date.now()) return Promise.resolve(false);
	try { assertCredentialTransport(); } catch { return Promise.resolve(false); }
	const rotate = async (synchronize: boolean) => {
		if (synchronize) synchronizeSessionStorage();
		const latest = getAccountSession();
		if (!latest || tokenClaims(latest.token)?.sessionId !== tokenClaims(session.token)?.sessionId) return false;
		if (latest.refreshToken !== session.refreshToken) {
			startTokenRefreshTimer();
			return true;
		}
		const expectedGeneration = getSessionGeneration();
		const expectedRefreshToken = latest.refreshToken;
		const response = await axios.post<Result<AccountAuth>>(
			`${__MONOPOLYSERVER__.replace(/\/$/, "")}/auth/refresh`,
			{ refreshToken: expectedRefreshToken }, { timeout: 15000 },
		);
		if (response.data?.code !== 200) return false;
		if (getSessionGeneration() !== expectedGeneration || getAccountSession()?.refreshToken !== expectedRefreshToken) return false;
		const credential = response.data.data;
		saveAccountSession({ ...credential, account: resolveAccountProfile(credential.account) });
		startTokenRefreshTimer();
		return true;
	};
	// Web Locks also serialize one-use refresh credentials across tabs on supported browsers.
	const pending: Promise<boolean> = (async () => {
		if (typeof navigator !== "undefined" && navigator.locks) {
			return await navigator.locks.request("monopoly-mine-account-refresh", () => rotate(true));
		}
		return await rotate(false);
	})();
	const result = pending.catch(() => false).finally(() => { refreshPromise = null; });
	refreshPromise = result;
	return result;
}

export function stopTokenRefreshTimer() {
	if (refreshTimer !== null) clearTimeout(refreshTimer);
	refreshTimer = null;
}

export function startTokenRefreshTimer() {
	stopTokenRefreshTimer();
	const session = getAccountSession();
	if (!session) return;
	refreshTimer = setTimeout(async () => {
		refreshTimer = null;
		const generation = getSessionGeneration();
		if (await doRefresh()) return;
		if (getSessionGeneration() !== generation || !getAccountSession()) return;
		if (getAccountSession()!.refreshExpiresAt <= Date.now()) {
			clearAccountSession();
			await navigateToLogin(false);
		} else {
			// A transient network failure should not erase an otherwise usable login.
			refreshTimer = setTimeout(startTokenRefreshTimer, 60_000);
		}
	}, Math.max(1000, session.expiresAt - Date.now() - REFRESH_BEFORE_EXPIRY_MS));
}

async function navigateToLogin(realmOnly: boolean) {
	const { resetOnlineIdentityAndRedirect } = await import("../auth");
	await resetOnlineIdentityAndRedirect(realmOnly);
}

/** Validates the ACCOUNT without entering any server or silently revoking an existing REALM. */
export async function ensureValidAuth(): Promise<AccountProfile | null> {
	if (!getAccountToken()) return null;
	try {
		const { getAccountInfo } = await import("./user");
		return await getAccountInfo();
	} catch {
		return null;
	}
}

apiClient.interceptors.request.use(config => {
	const kind = config.identity ?? "account";
	if (kind === "realm" && config.expectedRealmSessionId && getActiveRealm()?.sessionId !== config.expectedRealmSessionId) {
		throw new MonopolyApiError(46002, "区服会话已变更，本次请求已取消", undefined, true);
	}
	const token = kind === "none" ? null : kind === "realm" ? getRealmToken() : getAccountToken();
	if (token || ["/auth/login", "/auth/register"].includes(config.url ?? "")) assertCredentialTransport();
	config._authToken = token;
	config._authSessionId = token ? tokenClaims(token)?.sessionId as string | undefined : undefined;
	if (token) config.headers.set("Authorization", `Bearer ${token}`);
	else config.headers.delete("Authorization");
	if (kind !== "none" && !token) {
		void navigateToLogin(kind === "realm");
		throw new MonopolyApiError(kind === "realm" ? 46002 : 46001, kind === "realm" ? "请先选择区服" : "请先登录账号");
	}
	return config;
});

async function failedRequest(error: MonopolyApiError, config?: InternalAxiosRequestConfig): Promise<AxiosResponse> {
	const kind = config?.identity ?? "account";
	const accountExpired = error.code === 46001 || (error.code === 401 && kind === "account");
	const realmExpired = error.code === 46002 || (error.code === 401 && kind === "realm");
	if (config && kind === "account" && accountExpired && !config._authRetried) {
		config._authRetried = true;
		const sameSession = () => config._authSessionId === tokenClaims(getAccountToken() ?? "")?.sessionId;
		// A sibling request may already have rotated the token that this request sent.
		if (sameSession() && ((getAccountToken() && getAccountToken() !== config._authToken) || await doRefresh()) && sameSession()) {
			return apiClient.request(config);
		}
	}
	if (kind !== "none") {
		if ((accountExpired || error.code === 46005) && config?._authToken === (kind === "realm" ? getRealmSession()?.token : getAccountToken())) {
			stopTokenRefreshTimer();
			clearAccountSession();
			void navigateToLogin(false);
		} else if (kind === "realm" && realmExpired && (!config?._authToken || config._authToken === getRealmSession()?.token)) {
			clearRealmSession();
			void navigateToLogin(true);
		}
	}
	if (!config?.silent) FPMessage({ type: "error", message: error.message });
	throw error;
}

apiClient.interceptors.response.use(
	response => {
		const result = response.data as Result<unknown>;
		if (!result || typeof result.code !== "number") {
			return failedRequest(new MonopolyApiError(0, "服务器返回了无效的数据", response), response.config);
		}
		if (result.code !== 200) return failedRequest(new MonopolyApiError(result.code, result.msg || "请求失败", response), response.config);
		response.data = result.data;
		return response;
	},
	(error: unknown) => {
		if (axios.isCancel(error)) return Promise.reject(error);
		if (error instanceof MonopolyApiError) return error.staleIdentity ? Promise.reject(error) : failedRequest(error);
		const cause = error as AxiosError<Result<unknown>>;
		const result = cause.response?.data;
		const message = result?.msg || (cause.code === "ECONNABORTED" ? "请求超时，请稍后再试" : "无法连接游戏服务，请检查网络");
		return failedRequest(new MonopolyApiError(result?.code ?? cause.response?.status ?? 0, message, cause.response), cause.config);
	},
);

if (typeof document !== "undefined") {
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && getAccountSession()) startTokenRefreshTimer();
	});
}

export default apiClient;
