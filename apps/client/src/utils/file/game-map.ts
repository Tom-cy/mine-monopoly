import { GameMap, GameMapInDb, MapPath, ResourcesType, Role } from "@mine-monopoly/types";
import { loadFromProto, ProtoFileType, decodeProductMap, gzipDecompress, normalizeGameMap } from "@mine-monopoly/utils";
import { isProductFile, decrypt } from "@mine-monopoly/utils/crypto";
import { env } from "@mine-monopoly/env";
import { useLoading, useSettig, useRoomInfo } from "@src/store";
import { getGameMapById, getFrozenRoomMap, resolveMapResourceUrl } from "../api/map";
import { useMapData, useResourceStore } from "@src/store/game";
import { formatBytes } from "@src/utils";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
import { getDracoLoader } from "../draco/draco";
import { assertMapLoadActive, MapLoadOptions, withMapDownloadSignal } from "./map-loading";

// blob URL 的内容在创建后不可变；按当前 URL 查验，切换资源或地图不会复用旧指纹。
const modelResourceHashes = new Map<string, string>();

export function getModelResourceSha256(modelId: string): string | undefined {
	const resource = useResourceStore().getRecourceById(modelId);
	return resource?.type === "model" ? modelResourceHashes.get(resource.url) : undefined;
}

/**
 * 地图在写入客户端 store / Worker 前必须满足的 MapPath 运行时前置条件。
 */
export function validateGameMapForRuntime(map: GameMap): string[] {
	const errors: string[] = [];
	const mapItems = Array.isArray(map.mapItems) ? map.mapItems : [];
	const mapItemById = new Map(mapItems.map((item) => [item.id, item]));

	if (!Array.isArray(map.mapItems)) {
		errors.push("地图缺少 mapItems 数组");
	}

	const startMapItemId = map.startMapItemId;
	if (!startMapItemId || !mapItemById.has(startMapItemId)) {
		errors.push(`起点 startMapItemId \"${startMapItemId ?? "<missing>"}\" 不存在于 mapItems`);
	}

	const pathNodes = new Set<string>();
	const paths = Array.isArray(map.mapPaths) ? map.mapPaths : [];
	for (const [index, path] of paths.entries()) {
		const candidate = path as Partial<MapPath>;
		const pathId = typeof candidate.id === "string" && candidate.id ? candidate.id : `<missing-id@${index}>`;
		const fromMapItemId = candidate.fromMapItemId;
		const toMapItemId = candidate.toMapItemId;

		if (!fromMapItemId || !mapItemById.has(fromMapItemId)) {
			errors.push(`路径 \"${pathId}\" 的 fromMapItemId \"${fromMapItemId ?? "<missing>"}\" 不存在于 mapItems`);
		} else {
			pathNodes.add(fromMapItemId);
		}
		if (!toMapItemId || !mapItemById.has(toMapItemId)) {
			errors.push(`路径 \"${pathId}\" 的 toMapItemId \"${toMapItemId ?? "<missing>"}\" 不存在于 mapItems`);
		} else {
			pathNodes.add(toMapItemId);
		}
	}

	// pathMapItemTypeIds 是新地图的显式路径节点声明；旧地图未配置该字段时不做此项收紧。
	const hasPathMapItemTypeIds = Object.prototype.hasOwnProperty.call(map, "pathMapItemTypeIds");
	if (!hasPathMapItemTypeIds) return errors;
	if (!Array.isArray(map.pathMapItemTypeIds)) {
		errors.push("pathMapItemTypeIds 必须是数组");
		return errors;
	}
	// 空数组表示编辑器尚未显式选择路径节点类型，继续按旧地图规则推断。
	if (map.pathMapItemTypeIds.length === 0) return errors;

	const declaredTypeIds = new Set(map.pathMapItemTypeIds);
	const knownTypeIds = new Set((Array.isArray(map.mapItemTypes) ? map.mapItemTypes : []).map((type) => type.id));
	for (const typeId of declaredTypeIds) {
		if (!knownTypeIds.has(typeId)) {
			errors.push(`pathMapItemTypeIds 声明了不存在的地图项类型 \"${typeId}\"`);
		}
	}

	for (const [index, path] of paths.entries()) {
		const candidate = path as Partial<MapPath>;
		const pathId = typeof candidate.id === "string" && candidate.id ? candidate.id : `<missing-id@${index}>`;
		for (const [endpointName, mapItemId] of [
			["fromMapItemId", candidate.fromMapItemId],
			["toMapItemId", candidate.toMapItemId],
		] as const) {
			if (!mapItemId) continue;
			const mapItem = mapItemById.get(mapItemId);
			if (mapItem && !declaredTypeIds.has(mapItem.type?.id)) {
				errors.push(
					`路径 \"${pathId}\" 的 ${endpointName} \"${mapItemId}\" 类型 \"${mapItem.type?.id ?? "<missing>"}\" 未包含在 pathMapItemTypeIds`,
				);
			}
		}
	}

	for (const mapItem of mapItems) {
		if (declaredTypeIds.has(mapItem.type?.id) && !pathNodes.has(mapItem.id)) {
			errors.push(`路径节点类型 \"${mapItem.type.id}\" 的地图项 \"${mapItem.id}\" 未被任何路径端点引用`);
		}
	}

	return errors;
}

/**
 * 统一客户端地图入口：先补齐旧地图 MapPath 数据，再拒绝无法安全运行的路径图。
 */
export function normalizeAndValidateGameMap(map: GameMap): GameMap {
	const normalizedMap = normalizeGameMap(map);
	const errors = validateGameMapForRuntime(normalizedMap);
	if (errors.length > 0) {
		throw new Error(`地图路径校验失败：\n- ${errors.join("\n- ")}`);
	}
	return normalizedMap;
}

/**
 * 规范化已解码的地图载荷，使直接使用 getGameMap() 的宿主创建链路也不会绕过校验。
 */
function normalizeLoadedGameMapData<T extends { jsonData: string }>(mapData: T): T {
	const gameMap = normalizeAndValidateGameMap(JSON.parse(mapData.jsonData) as GameMap);
	return { ...mapData, jsonData: JSON.stringify(gameMap) };
}

function validateMapBeforeCommit(map: GameMap, imageFiles: ProtoFileType[], requireCover = false): void {
	const editorVersion = map.info?.editorVersion;
	if (!editorVersion) throw new Error("地图数据缺少版本信息");
	const version = editorVersion.split(".").slice(0, 2).join(".");
	if (version !== __COMPATIBLE_VERSION__) {
		throw new Error(`版本不匹配！地图编辑器版本: ${version}, 客户端版本: ${__COMPATIBLE_VERSION__}`);
	}
	const imageIds = new Set(imageFiles.map((resource) => resource.id));
	for (const role of map.roles) {
		if (!imageIds.has(role.imageId)) throw new Error(`角色“${role.name || role.id}”缺少图片资源`);
	}
	if (requireCover && !imageIds.has(map.info.coverImageId)) throw new Error("读取封面失败");
}

/**
 * 流式下载地图文件并显示进度（已下载/总大小）
 * 通过 Content-Length 获取总大小；服务器未返回时仅显示已下载大小
 */
async function downloadMapFile(url: string, options: MapLoadOptions): Promise<ArrayBuffer> {
	return withMapDownloadSignal(options.signal, async (signal) => {
		const response = await fetch(resolveMapResourceUrl(url), { signal });
		if (!response.ok) {
			throw new Error(`地图文件下载失败 (HTTP ${response.status})`);
		}
		const total = Number(response.headers.get("content-length") || 0);
		if (!response.body) return response.arrayBuffer();
		const reader = response.body.getReader();
		const chunks: BlobPart[] = [];
		let received = 0;
		try {
			while (true) {
				assertMapLoadActive(signal);
				const { done, value } = await reader.read();
				if (done) break;
				if (value) {
					// 转为独立 ArrayBuffer 视图，满足 BlobPart 的 Uint8Array<ArrayBuffer> 类型要求
					chunks.push(new Uint8Array(value));
					received += value.byteLength;
					const text =
						total > 0
							? `正在读取地图... ${formatBytes(received)} / ${formatBytes(total)} (${((received / total) * 100).toFixed(0)}%)`
							: `正在读取地图... ${formatBytes(received)}`;
					useLoading().showLoading(text, total > 0 ? (received / total) * 100 : 0);
				}
			}
		} finally {
			reader.releaseLock();
		}
		assertMapLoadActive(signal);
		return new Blob(chunks).arrayBuffer();
	});
}

async function loadFromProductFile(
	data: Uint8Array,
	key: string,
): Promise<{
	id: string;
	jsonData: string;
	modelFiles: ProtoFileType[];
	imageFiles: ProtoFileType[];
}> {
	if (new TextEncoder().encode(key).length !== 16) throw new Error("产品地图需要配置 16 字节的地图格式密钥");
	// Decrypt the data
	const decrypted = await decrypt(data, key);

	// 尝试解压，如果失败则直接解析（向后兼容）
	let productData: Uint8Array;
	try {
		productData = await gzipDecompress(decrypted);
	} catch {
		// 解压失败，说明是旧格式，直接使用解密后的数据
		console.warn("解压失败，使用未压缩格式");
		productData = decrypted;
	}

	// Parse the product protobuf
	const productMap = decodeProductMap(productData);

	// Convert ProductResourceItem[] to ProtoFileType[]
	const modelFiles: ProtoFileType[] = [];
	const imageFiles: ProtoFileType[] = [];

	for (const resource of productMap.resources) {
		const protoFile: ProtoFileType = {
			id: resource.rid,
			name: resource.label,
			filetype: resource.ext,
			buffer: new Uint8Array(resource.blob),
		};

		// Model files are .glb or .gltf
		if (resource.ext === "glb" || resource.ext === "gltf") {
			modelFiles.push(protoFile);
		} else {
			imageFiles.push(protoFile);
		}
	}

	const mapData = JSON.parse(productMap.payload) as GameMap;
	mapData.serverMapId = productMap.serverMapId || mapData.serverMapId || "";

	return {
		id: productMap.mapId,
		jsonData: JSON.stringify(mapData),
		modelFiles,
		imageFiles,
	};
}

export async function verifyMapFileHash(buffer: ArrayBuffer, expectedHash: string): Promise<void> {
	if (!/^[a-f0-9]{64}$/i.test(expectedHash)) return;
	if (!crypto.subtle) throw new Error("地图校验需要 HTTPS 或 localhost 安全环境");
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	const actual = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	if (actual !== expectedHash.toLowerCase()) throw new Error("地图文件 SHA-256 与房间冻结版本不符");
}

function mapFormatKey(): string {
	return import.meta.env.VITE_MAP_FORMAT_KEY || env("MAP_ENCRYPT_KEY", "");
}

export async function getGameMap(gameMapInfo: GameMapInDb, options: MapLoadOptions = {}) {
	assertMapLoadActive(options.signal);
	const encryptKey = mapFormatKey();
	const platform = window.platformAPI;

	let arrayBuffer: ArrayBuffer;
	if (platform?.loadMapCache && platform?.saveMapCache && gameMapInfo.hash) {
		// Electron 平台：优先命中本地缓存；未命中则下载并写回缓存
		// （hash 为空时跳过缓存，避免不同版本地图串用）
		const cached = await platform.loadMapCache(gameMapInfo.id, gameMapInfo.hash);
		if (cached) {
			try {
				await verifyMapFileHash(cached, gameMapInfo.hash);
				arrayBuffer = cached;
			} catch {
				arrayBuffer = await downloadMapFile(gameMapInfo.mapUrl, options);
			}
		} else {
			arrayBuffer = await downloadMapFile(gameMapInfo.mapUrl, options);
			await verifyMapFileHash(arrayBuffer, gameMapInfo.hash);
			// 读取用户设置的最大缓存（幂等：从 localStorage 同步最新值）
			useSettig().initMapCacheMaxSize();
			const maxSizeBytes = useSettig().mapCacheMaxSizeMB * 1024 * 1024;
			await platform.saveMapCache(gameMapInfo.id, gameMapInfo.hash, arrayBuffer, maxSizeBytes);
		}
	} else {
		arrayBuffer = await downloadMapFile(gameMapInfo.mapUrl, options);
	}
	assertMapLoadActive(options.signal);
	await verifyMapFileHash(arrayBuffer, gameMapInfo.hash);

	const bytes = new Uint8Array(arrayBuffer);
	// Detect format: .mmmap (encrypted product file) or .fpmap (legacy)
	const mapData = isProductFile(bytes) ? await loadFromProductFile(bytes, encryptKey) : await loadFromProto(bytes);
	assertMapLoadActive(options.signal);
	return normalizeLoadedGameMapData(mapData);
}

export async function loadGameMapFromServer(mapId: string, options: MapLoadOptions = {}) {
	assertMapLoadActive(options.signal);
	useLoading().showLoading("正在向服务器获取地图信息...");
	const room = useRoomInfo();
	const frozenMap = getFrozenRoomMap(room.roomId);
	if (room.roomSessionId && !frozenMap) throw new Error("房间冻结地图资料已丢失，请重新入房");
	if (frozenMap && frozenMap.id !== mapId) throw new Error("在线房间的地图版本已冻结，请重新创建房间选择其他地图");
	const mapInfo = frozenMap || (await getGameMapById(mapId));
	if (mapInfo) {
		useLoading().showLoading("正在读取地图...");
		const mapData = await getGameMap(mapInfo, options);
		const gameMap = normalizeAndValidateGameMap(JSON.parse(mapData.jsonData) as GameMap);
		validateMapBeforeCommit(gameMap, mapData.imageFiles);
		assertMapLoadActive(options.signal);
		await loadMapDataToResourceStore(mapData, options, () => {
			useMapData().$patch({ ...gameMap, buildingVisual: gameMap.buildingVisual, sceneVisual: gameMap.sceneVisual });
		});
		useLoading().hideLoading();
		const cover = useResourceStore().getRecourceById(gameMap.info.coverImageId);
		return {
			gameMap,
			mapInfo: {
				...mapInfo,
				author: mapInfo.author || gameMap.info.author,
				description: mapInfo.description || gameMap.info.description,
				coverUrl: mapInfo.coverUrl || cover?.url || "",
			},
		};
	} else {
		useLoading().hideLoading();
		throw Error("向服务器获取地图信息失败");
	}
}

export async function loadGameMapFromFile(file: ArrayBuffer, options: MapLoadOptions = {}) {
	assertMapLoadActive(options.signal);
	useLoading().showLoading("正在读取地图...");
	const bytes = new Uint8Array(file);
	const encryptKey = mapFormatKey();

	// Detect format: .mmmap (encrypted product file) or .fpmap (legacy)
	let mapData;
	if (isProductFile(bytes)) {
		mapData = await loadFromProductFile(bytes, encryptKey);
	} else {
		mapData = await loadFromProto(bytes);
	}

	const gameMap = normalizeAndValidateGameMap(JSON.parse(mapData.jsonData) as GameMap);
	validateMapBeforeCommit(gameMap, mapData.imageFiles, true);
	assertMapLoadActive(options.signal);
	await loadMapDataToResourceStore(mapData, options, () => {
		useMapData().$patch({ ...gameMap, buildingVisual: gameMap.buildingVisual, sceneVisual: gameMap.sceneVisual });
	});
	const coverResource = useResourceStore().getRecourceById(gameMap.info.coverImageId);
	if (!coverResource) throw Error("读取封面失败");
	const mapInfo: GameMapInDb = {
		id: gameMap.id,
		name: gameMap.info.name,
		author: gameMap.info.author,
		version: 0,
		description: gameMap.info.description,
		pendingChangelog: gameMap.info.pendingChangelog ?? "",
		changelog: gameMap.info.changelog ?? [],
		hash: "",
		coverUrl: coverResource.url,
		mapUrl: "",
		inuse: true,
		creatorId: null,
		status: "published",
		rejectReason: null,
		pendingUrl: null,
		pendingSourceUrl: null,
		sourceUrl: null,
		pendingHash: null,
		pendingVersion: gameMap.info.version,
	};
	useLoading().hideLoading();
	return { gameMap, mapInfo };
}

async function loadMapDataToResourceStore(
	mapData: {
		id: string;
		jsonData: string;
		modelFiles: ProtoFileType[];
		imageFiles: ProtoFileType[];
	},
	options: MapLoadOptions,
	commitMap: () => void,
) {
	const resourceStore = useResourceStore();
	const prepared: ResourcesType[] = [];
	const modelHashTasks: Array<Promise<readonly [string, string] | undefined>> = [];
	let hashes: Array<readonly [string, string] | undefined> = [];
	try {
		for (const imageResource of mapData.imageFiles) {
			const blob = new Blob([imageResource.buffer as BlobPart], { type: `image/${imageResource.filetype}` });
			const imageUrl = URL.createObjectURL(blob);
			//添加图片到资源仓库
			prepared.push({
				id: imageResource.id,
				name: imageResource.name,
				fileType: imageResource.filetype,
				url: imageUrl,
				type: "image",
			});
		}
		for (const modelResource of mapData.modelFiles) {
			const blob = new Blob([modelResource.buffer as BlobPart], { type: `application/octet-stream` });
			const modelUrl = URL.createObjectURL(blob);
			modelHashTasks.push(
				(async () => {
					// 非安全环境无法取得 SubtleCrypto 时保留原网格，不放宽隐藏条件。
					if (!globalThis.crypto?.subtle) return undefined;
					try {
						const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(modelResource.buffer));
						const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
						return [modelUrl, sha256] as const;
					} catch {
						return undefined;
					}
				})(),
			);
			//添加模型到资源仓库
			prepared.push({
				id: modelResource.id,
				name: modelResource.name,
				fileType: modelResource.filetype,
				url: modelUrl,
				type: "model",
			});
		}
		hashes = await Promise.all(modelHashTasks);
		assertMapLoadActive(options.signal);
	} catch (error) {
		for (const resource of prepared) URL.revokeObjectURL(resource.url);
		throw error;
	}
	// 全部资源准备成功后统一替换，失败的自定义地图不会清空上一张地图。
	resourceStore.clear();
	modelResourceHashes.clear();
	for (const hash of hashes) if (hash) modelResourceHashes.set(hash[0], hash[1]);
	for (const resource of prepared) resourceStore.add(resource);
	// 与资源、指纹在同一同步段提交地图，避免摘要等待后出现新资源配旧地图。
	commitMap();
}

export async function getModelById(modelId: string) {
	const loader = new GLTFLoader();
	const modelInfo = useResourceStore().getRecourceById(modelId);
	if (!modelInfo) throw Error(`找不到id为 ${modelId} 的模型资源`);
	loader.setDRACOLoader(getDracoLoader());
	return await loader.loadAsync(modelInfo.url);
}
