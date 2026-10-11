import { __MONOPOLYSERVER__ } from "@src/../global.config";
import type { AccountProfile } from "./types";

/** Local file URLs follow the API host and optional reverse-proxy path prefix. */
export function resolvePlayerResourceUrl(value: string | null | undefined): string {
	if (!value) return "";
	try {
		const origin =
			typeof location !== "undefined" && /^https?:\/\//.test(location.origin) ? location.origin : "http://localhost";
		const base = new URL(__MONOPOLYSERVER__ + "/", origin);
		const apiPath = base.pathname.replace(/\/$/, "");
		const apiSuffix = apiPath.lastIndexOf("/monopoly-api");
		const prefix = apiSuffix < 0 ? "" : apiPath.slice(0, apiSuffix);
		const path = value.startsWith("/monopoly-api/") ? prefix + value : value;
		const url = new URL(path, value.startsWith("/") ? base.origin : base);
		return /^https?:$/.test(url.protocol) ? url.href : "";
	} catch {
		return "";
	}
}

export function resolveAccountProfile(profile: AccountProfile): AccountProfile {
	return { ...profile, avatarUrl: resolvePlayerResourceUrl(profile.avatarUrl) || null };
}
