import apiClient from "./index";
import { updateAccountProfile } from "../auth/session";
import type { AccountProfile } from "./types";
import { resolveAccountProfile } from "./resources";

export async function getAccountInfo(): Promise<AccountProfile> {
	const response = await apiClient.get<AccountProfile>("/account/me", { identity: "account" });
	const profile = resolveAccountProfile(response.data);
	updateAccountProfile(profile);
	return profile;
}

/** Kept as a call-site alias; authorization always uses the current ACCOUNT token. */
export const getUserByToken = getAccountInfo;
