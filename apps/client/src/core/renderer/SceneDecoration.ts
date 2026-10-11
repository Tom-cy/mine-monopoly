import * as THREE from "three";

export function isSceneDecorationObject(object: THREE.Object3D): boolean {
	return object.userData.sceneDecoration === true;
}

export function isVolumetricSceneModel(model: THREE.Object3D): boolean {
	let result = false;
	model.traverse((object) => {
		if (object.userData.china24Volumetric === true) result = true;
	});
	return result;
}

/** 装饰仍不参与游戏选取；真实网格保留旋转与阴影，插画贴片朝向镜头。 */
export function prepareSceneDecoration(model: THREE.Group, size: number, enableShadow = false): THREE.Mesh[] {
	if (!Number.isFinite(size) || size <= 0) throw new Error("场景装饰的显示宽度必须是大于 0 的有限数值");
	model.scale.setScalar(size);
	const volumetric = isVolumetricSceneModel(model);
	if (!volumetric) model.rotation.set(0, 0, 0);
	const sprites: THREE.Mesh[] = [];
	model.traverse((object) => {
		object.userData.sceneDecoration = true;
		if (!(object instanceof THREE.Mesh)) return;
		object.raycast = () => undefined;
		let ancestor: THREE.Object3D | null = object;
		let isSprite = false;
		while (ancestor && ancestor !== model.parent) {
			if (ancestor.userData.china24SceneSprite === true) {
				isSprite = true;
				sprites.push(object);
				break;
			}
			ancestor = ancestor.parent;
		}
		object.userData.china24VolumetricDecoration = volumetric && !isSprite;
		const hasShadow = enableShadow && volumetric && !isSprite && object.userData.china24WaterSurface !== true;
		object.castShadow = hasShadow;
		object.receiveShadow = hasShadow;
	});
	return sprites;
}

const cameraQuaternion = new THREE.Quaternion();
const parentQuaternion = new THREE.Quaternion();

/** 保留底边 pivot 及位置，只更新方向；父节点旋转须从世界镜头方向中抵消。 */
export function updateSceneDecorationBillboards(sprites: readonly THREE.Mesh[], camera: THREE.Camera): void {
	if (!sprites.length) return;
	camera.getWorldQuaternion(cameraQuaternion);
	for (const sprite of sprites) {
		if (sprite.parent) sprite.parent.getWorldQuaternion(parentQuaternion);
		else parentQuaternion.identity();
		sprite.quaternion.copy(parentQuaternion.invert().multiply(cameraQuaternion));
	}
}
