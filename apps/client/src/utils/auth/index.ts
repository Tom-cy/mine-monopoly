import type { ActiveRealm } from "../api/types";
import {
	clearAccountSession,
	clearRealmSession,
	getActiveRealm,
	getAccountProfile,
	getAccountSession,
	getRealmToken,
	getRealmSession,
	saveRealmSession,
	tokenClaims,
} from "./session";

export {
	getAccountToken,
	getRealmToken,
	getActiveRealm,
	getAccountProfile,
	getAccountSession,
	getCurrentRealmUser,
	getRefreshToken,
	clearRealmSession,
} from "./session";
export type { ActiveRealm, RealmUser } from "../api/types";

async function resetOnlineIdentity() {
	const identity = () =>
		`${tokenClaims(getAccountSession()?.token ?? "")?.sessionId ?? ""}/${getRealmSession()?.sessionId ?? ""}`;
	const expected = identity();
	const [{ useUserInfo, useRoomInfo }, { destoryMonopolyClient }] = await Promise.all([
		import("@src/store"),
		import("@src/core/monopoly-client/MonopolyClient"),
	]);
	if (identity() !== expected) return false;
	await destoryMonopolyClient();
	if (identity() !== expected) return false;
	useUserInfo().$reset();
	useRoomInfo().$reset();
	return true;
}

export async function resetOnlineIdentityAndRedirect(realmOnly = false) {
	if (!(await resetOnlineIdentity())) return;
	const { default: router } = await import("@src/router");
	await router.replace({ name: "login", query: realmOnly && getAccountSession() ? { selectRealm: "1" } : {} });
}

export async function clearAuthAndRedirect() {
	const { stopTokenRefreshTimer } = await import("../api");
	stopTokenRefreshTimer();
	clearAccountSession();
	await resetOnlineIdentityAndRedirect();
}

/** Never enters a server automatically: doing so would revoke the existing realm and room. */
export async function ensureRealm(): Promise<ActiveRealm> {
	const current = getActiveRealm();
	if (current && getAccountProfile()) return current;
	clearRealmSession();
	await resetOnlineIdentityAndRedirect(Boolean(getAccountSession()));
	throw new Error("请选择区服后使用在线模式");
}

let selectingRealm = false;

export async function selectRealm(serverId: string): Promise<ActiveRealm> {
	if (selectingRealm) throw new Error("正在进入区服，请稍候");
	const { enterServer } = await import("../api/realm");
	const parentToken = getAccountSession()?.token;
	if (!parentToken) throw new Error("请先登录账号");
	selectingRealm = true;
	try {
		// Close the previous engine while its original REALM is still current.
		if (!(await resetOnlineIdentity())) throw new Error("会话已变化，请重新选择区服");
		const result = await enterServer(serverId, tokenClaims(parentToken)?.sessionId as string);
		// A concurrent logout/new login must not acquire this completed request's realm.
		if (
			!getAccountSession() ||
			tokenClaims(parentToken)?.sessionId !== tokenClaims(getAccountSession()!.token)?.sessionId
		)
			throw new Error("账号已退出，请重新登录");
		const active = saveRealmSession(result);
		const { useUserInfo } = await import("@src/store");
		const account = getAccountProfile();
		if (!account || getActiveRealm()?.sessionId !== active.sessionId) throw new Error("区服会话已变化，请重新选择");
		useUserInfo().setRealmIdentity(active, account);
		return active;
	} finally {
		selectingRealm = false;
	}
}

export async function logoutRealm() {
	try {
		if (getRealmToken()) {
			const { leaveRealm } = await import("../api/realm");
			await leaveRealm();
		}
	} finally {
		clearRealmSession();
		await resetOnlineIdentity();
	}
}

export async function logoutAccount() {
	try {
		const { apiLogout } = await import("../api/auth");
		await apiLogout();
	} finally {
		await resetOnlineIdentityAndRedirect();
	}
}

if (typeof window !== "undefined") {
	window.addEventListener("monopoly-session-change", (event) => {
		const detail = (event as CustomEvent<{ parentChanged: boolean; realmChanged: boolean }>).detail;
		if (detail?.parentChanged || detail?.realmChanged) {
			void resetOnlineIdentityAndRedirect(Boolean(getAccountSession())).catch(() => {});
		}
	});
}
