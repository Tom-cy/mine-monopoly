import apiClient, { MonopolyApiError, startTokenRefreshTimer, stopTokenRefreshTimer } from "./index";
import { FPMessage } from "@mine-monopoly/ui";
import {
	clearAccountSession,
	getAccountToken,
	getSessionGeneration,
	saveAccountSession,
	tokenClaims,
} from "../auth/session";
import type { AccountAuth } from "./types";
import { resolveAccountProfile } from "./resources";
export { getAccountInfo as getUserInfo } from "./user";

export async function apiLogin(useraccount: string, password: string, signal?: AbortSignal): Promise<AccountAuth | null> {
	const generation = getSessionGeneration();
	try {
		const response = await apiClient.post<AccountAuth>(
			"/auth/login",
			{ useraccount, password },
			{ identity: "none", signal },
		);
		if (signal?.aborted || getSessionGeneration() !== generation) return null;
		const auth = { ...response.data, account: resolveAccountProfile(response.data.account) };
		saveAccountSession(auth);
		startTokenRefreshTimer();
		return auth;
	} catch (error) {
		if (!signal?.aborted && !(error instanceof MonopolyApiError))
			FPMessage({ type: "error", message: "登录服务返回的数据无效，请稍后再试" });
		return null;
	}
}

export async function apiRegister(formData: FormData, signal?: AbortSignal): Promise<boolean> {
	try {
		// The browser supplies the multipart boundary.
		await apiClient.post("/auth/register", formData, { identity: "none", signal });
		return true;
	} catch {
		return false;
	}
}

export async function apiLogout() {
	const sessionId = tokenClaims(getAccountToken() ?? "")?.sessionId;
	try {
		await apiClient.post("/auth/logout", undefined, { identity: "account", silent: true });
	} finally {
		if (sessionId === tokenClaims(getAccountToken() ?? "")?.sessionId) {
			stopTokenRefreshTimer();
			clearAccountSession();
		}
	}
}
