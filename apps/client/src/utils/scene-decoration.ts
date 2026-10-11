/** 显式标记的纯场景装饰不参与路径、事件及机会卡目标选择。旧地图行为保持不变。 */
export function isSceneDecoration(type: object | null | undefined): boolean {
	return (type as { sceneDecoration?: unknown } | null | undefined)?.sceneDecoration === true;
}

export function isSceneBase(type: object | null | undefined): boolean {
	return (type as { sceneBase?: unknown } | null | undefined)?.sceneBase === true;
}
