import apiClient from "./index";
import type { Page, RealmAuth, ServerInfo } from "./types";

export async function getServers(page = 1, size = 8, signal?: AbortSignal): Promise<Page<ServerInfo>> {
	return (await apiClient.get<Page<ServerInfo>>("/servers", { params: { page, size }, identity: "account", signal })).data;
}

export async function enterServer(serverId: string): Promise<RealmAuth> {
	return (await apiClient.post<RealmAuth>(`/servers/${encodeURIComponent(serverId)}/enter`, undefined, { identity: "account" })).data;
}

export async function leaveRealm() {
	await apiClient.post("/realm/logout", undefined, { identity: "realm", silent: true });
}
