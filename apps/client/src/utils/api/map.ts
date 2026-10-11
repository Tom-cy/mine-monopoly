import apiClient from "./index";
import type { GameMapChangelogEntry, GameMapInDb } from "@mine-monopoly/types";
import { __MONOPOLYSERVER__ } from "@src/../global.config";

interface PublishedMap {
	id: string;
	name: string;
	author: string;
	description: string | null;
	creatorId: string | null;
	creatorName: string | null;
	official: boolean;
	status: string;
	publishCount: number;
	contentVersion: string | null;
	hash: string | null;
	mapUrl: string | null;
	sourceUrl: string | null;
	coverUrl: string | null;
	changelog: Array<{
		version?: number;
		publishCount?: number;
		contentVersion?: string;
		semver?: string;
		content?: string;
		createdAt?: number | string;
	}> | null;
}
export function resolveMapResourceUrl(value: string | null | undefined): string {
	if (!value) return "";
	const origin =
		typeof location !== "undefined" && /^https?:\/\//.test(location.origin) ? location.origin : "http://localhost";
	const apiBase = new URL(__MONOPOLYSERVER__.replace(/\/$/, "") + "/", origin);
	const apiPath = apiBase.pathname.replace(/\/$/, "");
	const apiSuffix = apiPath.lastIndexOf("/monopoly-api");
	const gatewayPrefix = apiSuffix < 0 ? "" : apiPath.slice(0, apiSuffix);
	const resourcePath = value.startsWith("/monopoly-api/") ? gatewayPrefix + value : value;
	const url = new URL(resourcePath, value.startsWith("/") ? apiBase.origin : apiBase);
	if (!/^https?:$/.test(url.protocol)) throw new Error("地图资源地址无效");
	return url.href;
}
export function adaptPublishedMap(map: PublishedMap): GameMapInDb {
	const changelog: GameMapChangelogEntry[] = (map.changelog || []).map((entry) => ({
		version: entry.publishCount ?? entry.version ?? 0,
		semver: entry.contentVersion ?? entry.semver ?? null,
		content: entry.content || "",
		createdAt: typeof entry.createdAt === "number" ? new Date(entry.createdAt).toISOString() : entry.createdAt || "",
	}));
	return {
		id: String(map.id),
		name: map.name,
		author: map.author,
		description: map.description || "",
		version: map.publishCount,
		hash: map.hash || "",
		pendingVersion: map.contentVersion,
		mapUrl: resolveMapResourceUrl(map.mapUrl),
		sourceUrl: resolveMapResourceUrl(map.sourceUrl) || null,
		coverUrl: resolveMapResourceUrl(map.coverUrl),
		inuse: true,
		creatorId: map.creatorId,
		creatorName: map.creatorName,
		isOfficial: map.official,
		status: "published",
		rejectReason: null,
		pendingChangelog: null,
		pendingHash: null,
		pendingUrl: null,
		pendingSourceUrl: null,
		changelog,
	};
}
export async function getGameMapList(
	page: number,
	size: number,
): Promise<{ total: number; gameMapList: GameMapInDb[]; current: number }> {
	const response = await apiClient.get<{ total: number; records: PublishedMap[]; current: number }>("/maps", {
		params: { page, size: Math.min(100, Math.max(1, size)) },
		identity: "realm",
	});
	return {
		total: response.data.total,
		current: response.data.current,
		gameMapList: response.data.records.map(adaptPublishedMap),
	};
}
export async function getGameMapById(mapId: string): Promise<GameMapInDb> {
	const response = await apiClient.get<PublishedMap>("/maps/" + encodeURIComponent(mapId), { identity: "realm" });
	return adaptPublishedMap(response.data);
}
const frozenMaps = new Map<string, GameMapInDb>();
export function rememberFrozenRoomMap(room: {
	id: string;
	mapId: string;
	mapName: string;
	mapVersion: string;
	mapUrl: string | null;
	mapHash: string | null;
}): void {
	if (!room.mapUrl || !room.mapHash) throw new Error("服务器缺少房间冻结地图资源，请更新服务后重试");
	frozenMaps.set(room.id, {
		id: room.mapId,
		name: room.mapName,
		author: "",
		description: "",
		version: 0,
		pendingVersion: room.mapVersion,
		hash: room.mapHash,
		mapUrl: resolveMapResourceUrl(room.mapUrl),
		coverUrl: "",
		inuse: true,
		creatorId: null,
		status: "published",
		rejectReason: null,
		sourceUrl: null,
		pendingChangelog: null,
		changelog: [],
		pendingHash: null,
		pendingUrl: null,
		pendingSourceUrl: null,
	});
}
export function getFrozenRoomMap(roomId: string): GameMapInDb | null {
	return frozenMaps.get(roomId) || null;
}
export function forgetFrozenRoomMap(roomId: string): void {
	frozenMaps.delete(roomId);
}
