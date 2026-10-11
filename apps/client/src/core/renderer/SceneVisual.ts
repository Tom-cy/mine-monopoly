import * as THREE from "three";
import type { GameMap, MapItem } from "@mine-monopoly/types";

type SceneMap = Pick<
	GameMap,
	"sceneVisual" | "mapItems" | "mapIndex" | "mapPaths" | "startMapItemId" | "pathMapItemTypeIds"
>;

/** 外观契约只负责展示；无契约的旧地图保持原相机和背景。 */
export function hasSceneVisualContract(map: Pick<GameMap, "sceneVisual">): boolean {
	const visual = map.sceneVisual;
	return (
		visual?.version === 1 &&
		visual.collection === "china24-3d-models-v1" &&
		(visual.mode === "volumetric" || visual.mode === "illustrated") &&
		Array.isArray(visual.hiddenOriginalTileIds) &&
		visual.hiddenOriginalTileIds.every((id) => typeof id === "string" && Boolean(id.trim()))
	);
}

/** 只隐藏被替代的默认空公园网格，保留完整业务项和其定位锚点。 */
export function shouldHideOriginalSceneTile(
	map: SceneMap,
	tile: MapItem,
	getModel: (id: string) => THREE.Object3D | undefined,
): boolean {
	if (!hasSceneVisualContract(map) || !map.sceneVisual?.hiddenOriginalTileIds.includes(tile.id)) return false;
	if (
		tile.type.name !== "城市中央公园" ||
		tile.x !== 5 ||
		tile.y !== 5 ||
		tile.type.size !== 1 ||
		tile.property ||
		tile.mapEventId ||
		tile.linkto ||
		tile.beLinked ||
		tile.id === map.startMapItemId ||
		map.mapIndex?.includes(tile.id) ||
		map.pathMapItemTypeIds?.includes(tile.type.id) ||
		map.mapPaths?.some((path) => path.fromMapItemId === tile.id || path.toMapItemId === tile.id) ||
		map.mapItems.some((item) => item.linkto === tile.id || item.beLinked === tile.id)
	)
		return false;
	return map.mapItems.some((item) => {
		const type = item.type as MapItem["type"] & { sceneDecoration?: unknown; sceneAssetId?: unknown };
		if (type.sceneDecoration !== true || type.sceneAssetId !== "pearl-lotus-fountain") return false;
		const model = getModel(item.type.modelId);
		let actualFountain = false;
		model?.traverse((object) => {
			if (object.userData.china24SceneModelId === "pearl-lotus-fountain") actualFountain = true;
		});
		return actualFountain;
	});
}
