import * as THREE from "three";
import type { GameMap, PropertyInfo } from "@mine-monopoly/types";

type BuildingMap = Pick<GameMap, "buildingModelIdList" | "buildingVisual">;
type BuildingProperty = Pick<PropertyInfo, "level" | "owner" | "buildingModelIdList">;

type AlphaMask = { width: number; height: number; alpha: Uint8Array };
const alphaMasks = new WeakMap<THREE.Texture, AlphaMask | null>();
const alphaFilteredMeshes = new WeakSet<THREE.Mesh>();

function findPropertyBuildingMarker(model: THREE.Object3D): THREE.Object3D | undefined {
	let marker: THREE.Object3D | undefined;
	model.traverse((object) => {
		if (
			!marker &&
			object.userData.china24PropertyBuilding === true &&
			object.userData.collection === "china24-property-models-v1"
		)
			marker = object;
	});
	return marker;
}

function hasBuildingVisualContract(map: BuildingMap): boolean {
	const visual = map.buildingVisual;
	return (
		visual?.version === 1 &&
		visual.collection === "china24-property-models-v1" &&
		typeof visual.unownedModelId === "string" &&
		Boolean(visual.unownedModelId.trim())
	);
}

function readTextureAlpha(texture: THREE.Texture): AlphaMask | null {
	const cached = alphaMasks.get(texture);
	if (cached !== undefined) return cached;
	try {
		const image = texture.image;
		const width = image?.width;
		const height = image?.height;
		if (
			typeof document === "undefined" ||
			!Number.isInteger(width) ||
			!Number.isInteger(height) ||
			width <= 0 ||
			height <= 0 ||
			width * height > 16_777_216
		)
			return null;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return null;
		context.drawImage(image as CanvasImageSource, 0, 0);
		const pixels = context.getImageData(0, 0, width, height).data;
		const alpha = new Uint8Array(width * height);
		for (let pixel = 0; pixel < alpha.length; pixel++) alpha[pixel] = pixels[pixel * 4 + 3];
		const mask = { width, height, alpha };
		alphaMasks.set(texture, mask);
		return mask;
	} catch {
		// 不可读取的纹理保留原射线行为；不影响旧模型、自定义材质或跨域图片。
		alphaMasks.set(texture, null);
		return null;
	}
}

function hitsVisiblePixel(mesh: THREE.Mesh, hit: THREE.Intersection): boolean {
	const material = Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material;
	const texture = (material as THREE.Material & { map?: THREE.Texture | null })?.map;
	if (!texture || !hit.uv) return true;
	const mask = readTextureAlpha(texture);
	if (!mask) return true;
	const uv = hit.uv.clone();
	if (texture.matrixAutoUpdate) texture.updateMatrix();
	texture.transformUv(uv);
	if (!Number.isFinite(uv.x) || !Number.isFinite(uv.y)) return true;
	const x = Math.min(mask.width - 1, Math.max(0, Math.floor(uv.x * mask.width)));
	const y = Math.min(mask.height - 1, Math.max(0, Math.floor(uv.y * mask.height)));
	const alpha = mask.alpha[y * mask.width + x] / 255;
	return alpha > 0 && alpha * material.opacity >= material.alphaTest;
}

/** 只安装到新地产贴片；透明画布不再遮挡其它地产的选取。 */
function enablePropertyAlphaRaycast(mesh: THREE.Mesh): void {
	if (alphaFilteredMeshes.has(mesh)) return;
	const originalRaycast = mesh.raycast;
	mesh.raycast = function (raycaster, intersections) {
		const candidates: THREE.Intersection[] = [];
		originalRaycast.call(this, raycaster, candidates);
		for (const hit of candidates) if (hitsVisiblePixel(this, hit)) intersections.push(hit);
	};
	alphaFilteredMeshes.add(mesh);
}

/** 仅显式启用的新地图区分未购买 L0；旧地图仍按原业务等级索引。 */
export function resolvePropertyBuildingModelId(
	property: BuildingProperty,
	map: BuildingMap,
	hasModel: (id: string) => boolean = () => true,
): string | undefined {
	const visual = map.buildingVisual;
	if (!property.owner && visual && hasBuildingVisualContract(map)) {
		return visual.unownedModelId;
	}
	const modelIds = property.buildingModelIdList ?? map.buildingModelIdList;
	const selected = modelIds?.[property.level];
	if (selected && hasModel(selected)) return selected;
	const fallback = modelIds?.[modelIds.length - 1];
	return fallback && hasModel(fallback) ? fallback : undefined;
}

/** 新产权模型已带底座，不再叠加旧街区；混用自定义模型时保留其原地形。 */
export function usesLatestPropertySpriteGround(
	property: BuildingProperty,
	map: BuildingMap,
	getModel: (id: string) => THREE.Object3D | undefined,
): boolean {
	if (!hasBuildingVisualContract(map)) return false;
	const selectedId = resolvePropertyBuildingModelId(property, map, (id) => Boolean(getModel(id)));
	const selected = selectedId ? getModel(selectedId) : undefined;
	if (!selected || !findPropertyBuildingMarker(selected)) return false;
	const modelIds = property.buildingModelIdList ?? map.buildingModelIdList;
	return (
		Array.isArray(modelIds) &&
		modelIds.length > 0 &&
		modelIds.every((id) => {
			const model = getModel(id);
			return Boolean(model && findPropertyBuildingMarker(model));
		})
	);
}

/** 地产模型保持射线交互，只有插画才朝向镜头并过滤透明画布。 */
export function preparePropertyBuildingModel(model: THREE.Group): { width: number; sprites: THREE.Mesh[] } | undefined {
	const marker = findPropertyBuildingMarker(model);
	if (!marker) return undefined;
	const configuredWidth = marker.userData.targetWidthInRouteTiles;
	const width =
		typeof configuredWidth === "number" &&
		Number.isFinite(configuredWidth) &&
		configuredWidth > 0 &&
		configuredWidth <= 20
			? configuredWidth
			: 0.9;
	const sprites: THREE.Mesh[] = [];
	model.traverse((object) => {
		if (!(object instanceof THREE.Mesh)) return;
		object.userData.china24PropertyBuildingModel = true;
		let ancestor: THREE.Object3D | null = object;
		while (ancestor && ancestor !== model.parent) {
			if (ancestor.userData.china24SceneSprite === true) {
				object.userData.china24PropertyBuildingSprite = true;
				object.castShadow = false;
				object.receiveShadow = false;
				enablePropertyAlphaRaycast(object);
				sprites.push(object);
				break;
			}
			ancestor = ancestor.parent;
		}
	});
	return { width, sprites };
}
