import type { AccountAuth, AccountProfile, ActiveRealm, RealmAuth, RealmUser } from "../api/types";

const ACCOUNT_KEY = "monopoly.mine.account.v1";
const REALM_KEY = "monopoly.mine.realm.v1";
let account: AccountAuth | null = null;
let realm: ActiveRealm | null = null;
let initialized = false;
let generation = 0;
let storageWritable = true;

function read(key: string): unknown {
	try {
		return JSON.parse(localStorage.getItem(key) || "null");
	} catch {
		return null;
	}
}

function write(key: string, value: unknown) {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// The current tab can still use its in-memory session when storage is unavailable.
		storageWritable = false;
	}
}

/** Claims are used only to bind client state. The server verifies every request. */
export function tokenClaims(token: string): Record<string, unknown> | null {
	try {
		const segment = token.split(".")[1];
		if (!segment || segment.length > 12000) return null;
		const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
		const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), char => char.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	}
}

function validAccount(value: unknown): value is AccountAuth {
	if (!value || typeof value !== "object") return false;
	const item = value as AccountAuth;
	const claims = typeof item.token === "string" ? tokenClaims(item.token) : null;
	return claims?.tokenType === "ACCOUNT" && typeof claims.sessionId === "string"
		&& typeof item.refreshToken === "string" && item.refreshToken.length > 0
		&& Number.isFinite(item.expiresAt) && item.expiresAt > 0 && Number.isFinite(item.refreshExpiresAt)
		&& typeof item.account?.id === "string" && /^[1-9][0-9]*$/.test(item.account.id) && claims.accountId === item.account.id
		&& typeof item.account.useraccount === "string" && typeof item.account.username === "string";
}

function validRealm(value: unknown, parent: AccountAuth | null): value is ActiveRealm {
	if (!value || typeof value !== "object" || !parent) return false;
	const item = value as ActiveRealm;
	const claims = typeof item.token === "string" ? tokenClaims(item.token) : null;
	return claims?.tokenType === "REALM" && typeof claims.sessionId === "string"
		&& item.sessionId === claims.sessionId
		&& claims.accountSessionId === tokenClaims(parent.token)?.sessionId
		&& claims.accountId === item.accountId && item.accountId === parent.account.id
		&& claims.serverId === item.serverId && claims.roleId === item.roleId
		&& typeof item.serverId === "string" && /^[1-9][0-9]*$/.test(item.serverId)
		&& typeof item.roleId === "string" && /^[1-9][0-9]*$/.test(item.roleId)
		&& typeof item.nickname === "string" && Number.isFinite(item.expiresAt) && item.expiresAt > 0;
}

function initialize() {
	if (initialized) return;
	initialized = true;
	const cachedAccount = read(ACCOUNT_KEY);
	account = validAccount(cachedAccount) ? cachedAccount : null;
	const cachedRealm = read(REALM_KEY);
	realm = validRealm(cachedRealm, account) ? cachedRealm : null;
	// Old Node-server credentials and guest identities must never become online credentials.
	for (const key of ["token", "refreshToken", "encryption-key"]) {
		try { localStorage.removeItem(key); } catch { /* storage is optional */ }
	}
}

export function getAccountSession(): AccountAuth | null {
	initialize();
	return account;
}

export function getSessionGeneration(): number {
	initialize();
	return generation;
}

/** A tab waiting on the browser refresh lock must observe another tab's committed rotation. */
export function synchronizeSessionStorage() {
	initialize();
	if (!storageWritable) return;
	const cached = read(ACCOUNT_KEY);
	const latest = validAccount(cached) ? cached : null;
	if (latest?.token === account?.token && latest?.refreshToken === account?.refreshToken) return;
	account = latest;
	const cachedRealm = read(REALM_KEY);
	realm = validRealm(cachedRealm, account) ? cachedRealm : null;
	generation++;
}

export function getAccountToken(): string | null {
	return getAccountSession()?.token ?? null;
}

export function getRefreshToken(): string | null {
	return getAccountSession()?.refreshToken ?? null;
}

export function getAccountProfile(): AccountProfile | null {
	return getAccountSession()?.account ?? null;
}

/** A refreshed ACCOUNT keeps its parent session; a new login invalidates local REALM state. */
export function saveAccountSession(value: AccountAuth) {
	initialize();
	if (!validAccount(value)) throw new Error("账号服务返回了无效的登录凭据");
	const sameParent = tokenClaims(account?.token ?? "")?.sessionId === tokenClaims(value.token)?.sessionId;
	account = value;
	generation++;
	write(ACCOUNT_KEY, account);
	if (!sameParent) clearRealmSession();
}

export function updateAccountProfile(profile: AccountProfile) {
	const current = getAccountSession();
	if (!current || profile.id !== current.account.id) return;
	account = { ...current, account: profile };
	write(ACCOUNT_KEY, account);
}

export function saveRealmSession(value: RealmAuth): ActiveRealm {
	initialize();
	const candidate = { ...value, sessionId: tokenClaims(value.token)?.sessionId as string };
	if (!validRealm(candidate, account)) throw new Error("区服服务返回了无效的角色凭据");
	realm = candidate;
	write(REALM_KEY, realm);
	return candidate;
}

export function getActiveRealm(): ActiveRealm | null {
	initialize();
	return realm && realm.expiresAt > Date.now() ? realm : null;
}

/** Retains the sent session identity for comparing delayed failures, even after local expiry. */
export function getRealmSession(): ActiveRealm | null {
	initialize();
	return realm;
}

export function getRealmToken(): string | null {
	return getActiveRealm()?.token ?? null;
}

export function clearRealmSession() {
	initialize();
	realm = null;
	write(REALM_KEY, null);
}

export function clearAccountSession() {
	initialize();
	account = null;
	generation++;
	write(ACCOUNT_KEY, null);
	clearRealmSession();
}

export function getCurrentRealmUser(): RealmUser | null {
	const active = getActiveRealm();
	const profile = getAccountProfile();
	if (!active || !profile) return null;
	return {
		id: active.roleId, userId: active.roleId, useraccount: profile.useraccount,
		username: active.nickname, avatar: profile.avatarUrl ?? "", color: profile.color ?? "#4F7CFF", isReady: false,
	};
}

if (typeof window !== "undefined") {
	window.addEventListener("storage", event => {
		if (event.key !== ACCOUNT_KEY && event.key !== REALM_KEY && event.key !== null) return;
		const previousAccount = account;
		const previousRealm = realm;
		initialized = false;
		initialize();
		if (previousAccount?.token !== account?.token || previousAccount?.refreshToken !== account?.refreshToken) generation++;
		const parentChanged = tokenClaims(previousAccount?.token ?? "")?.sessionId !== tokenClaims(account?.token ?? "")?.sessionId;
		const realmChanged = previousRealm?.sessionId !== realm?.sessionId;
		window.dispatchEvent(new CustomEvent("monopoly-session-change", { detail: { parentChanged, realmChanged } }));
	});
}
