import apiClient, { MonopolyApiError } from "./index";
import { getAccountToken, tokenClaims, updateAccountProfile } from "../auth/session";
import type { AccountProfile } from "./types";
import { resolveAccountProfile } from "./resources";

export async function getAccountInfo(): Promise<AccountProfile> {
	const response = await apiClient.get<AccountProfile>("/account/me", { identity: "account" });
	if (response.config._authSessionId !== tokenClaims(getAccountToken() ?? "")?.sessionId) {
		throw new MonopolyApiError(46001, "账号会话已变更，请重新读取资料", undefined, true);
	}
	const profile = resolveAccountProfile(response.data);
	updateAccountProfile(profile);
	return profile;
}

/** Kept as a call-site alias; authorization always uses the current ACCOUNT token. */
export const getUserByToken = getAccountInfo;
