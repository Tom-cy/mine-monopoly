const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const THREE = require(require.resolve("three", { paths: [clientRoot] }));

function load(source, dependencies, environment) {
	const module = { exports: {} };
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	vm.runInNewContext(outputText, {
		module,
		exports: module.exports,
		console: { log() {}, warn() {}, error: console.error },
		performance,
		...environment,
		require(name) { return dependencies[name] ?? {}; },
	});
	return module.exports;
}

function fixture(mobile = false, mapData = {}) {
	const listeners = new Map();
	const timeouts = new Map();
	const rafs = new Map();
	const apps = [];
	const graphics = { disposed: 0, renders: 0, watchStopped: 0 };
	let sequence = 0;
	const window = {
		devicePixelRatio: 1,
		addEventListener(name, listener) {
			const group = listeners.get(name) ?? new Set();
			group.add(listener);
			listeners.set(name, group);
		},
		removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
	};
	const timerEnvironment = {
		setTimeout(fn) { timeouts.set(++sequence, fn); return sequence; },
		clearTimeout(id) { timeouts.delete(id); },
	};
	const eventBusModule = load(fs.readFileSync(path.resolve(clientRoot, "src/utils/event-bus/index.ts"), "utf8"), {}, {});
	const eventBus = eventBusModule.default();
	class Element {}
	class DOMNode extends Element {
		constructor() { super(); this.style = {}; this.children = []; }
		appendChild(node) { node.parentElement = this; this.children.push(node); }
		removeChild(node) { node.parentElement = null; this.children.splice(this.children.indexOf(node), 1); }
	}
	class WebGLRenderer {
		constructor() { this.shadowMap = {}; this.renderLists = { dispose() {} }; }
		setClearAlpha() {}
		setPixelRatio() {}
		setSize() {}
		clear() {}
		clearDepth() {}
		render() { graphics.renders++; }
		dispose() { graphics.disposed++; }
	}
	class Pass { setSize() {} }
	class Composer {
		constructor() { this.passes = []; this.renderTarget1 = this.renderTarget2 = { dispose() {} }; }
		addPass(pass) { this.passes.push(pass); }
		setSize() {}
		render() { graphics.renders++; }
	}
	class CSS2DObject extends THREE.Object3D { constructor(element) { super(); this.element = element; } }
	class CSS2DRenderer {
		constructor() { this.domElement = new DOMNode(); }
		setSize() {}
		render() {}
	}
	class Controls {
		constructor(camera) { this.object = camera; this.target = new THREE.Vector3(); }
		update() {}
		dispose() {}
	}
	const setting = { graphicQuality: "low", getPixelRatio: () => 1, initGraphicQuality() {} };
	const mapStore = { mapItems: [], buildingModelIdList: [], getMapItemByPropertyId(id) { return this.mapItems.find((item) => item.property?.id === id); } };
	const gameStore = { players: [], properties: [], currentMultiplier: 1 };
	const modelHashes = new Map();
	const gsap = {
		killTweensOf() {},
		to(target, options) {
			for (const key of ["x", "y", "z"]) if (key in options) target[key] = options[key];
			options.onComplete?.();
			return Promise.resolve();
		},
	};
	const deps = {
		three: { ...THREE, WebGLRenderer },
		"./SceneDecoration": load(fs.readFileSync(path.resolve(clientRoot, "src/core/renderer/SceneDecoration.ts"), "utf8"), { three: THREE }, {}),
		"./SceneVisual": load(fs.readFileSync(path.resolve(clientRoot, "src/core/renderer/SceneVisual.ts"), "utf8"), { three: THREE }, {}),
		"./WaterSurface": load(fs.readFileSync(path.resolve(clientRoot, "src/core/renderer/WaterSurface.ts"), "utf8"), { three: THREE }, {}),
		"./PropertyBuildingVisual": load(fs.readFileSync(path.resolve(clientRoot, "src/core/renderer/PropertyBuildingVisual.ts"), "utf8"), { three: THREE }, {}),
		"@src/utils/scene-decoration": load(fs.readFileSync(path.resolve(clientRoot, "src/utils/scene-decoration.ts"), "utf8"), {}, {}),
		"@src/utils/file/game-map": { getModelResourceSha256: (id) => modelHashes.get(id) },
		gsap: { __esModule: true, default: gsap },
		"three/examples/jsm/controls/OrbitControls": { OrbitControls: Controls },
		"three/examples/jsm/renderers/CSS2DRenderer": { CSS2DObject, CSS2DRenderer },
		"three/examples/jsm/postprocessing/EffectComposer": { EffectComposer: Composer },
		"three/examples/jsm/postprocessing/RenderPass": { RenderPass: Pass },
		"three/examples/jsm/postprocessing/OutlinePass": { OutlinePass: Pass },
		"three/examples/jsm/postprocessing/ShaderPass": { ShaderPass: Pass },
		"@src/store": { useLoading: () => ({}), useSettig: () => setting, useUtil: () => ({}) },
		"@src/store/game": { useMapData: () => mapStore, useGameData: () => gameStore, useResourceStore: () => ({ getRecourceById: () => undefined }) },
		"@src/utils/event-bus": eventBusModule,
		"vue": {
			createApp() {
				const app = { unmountCount: 0, mount: () => ({}), unmount() { this.unmountCount++; } };
				apps.push(app);
				return app;
			},
			watch() { return () => graphics.watchStopped++; },
		},
		"@mine-monopoly/utils": { AnimationManager: class { update() {} dispose() {} } },
		"@src/utils/game-init-diagnostics": { wrapGameInitError: (stage, error) => error },
		"@src/utils": {
			isMobileDevice: () => mobile,
			debounce(callback, delay, needCancel) {
				let timer;
				const fn = () => {
					timerEnvironment.clearTimeout(timer);
					timer = timerEnvironment.setTimeout(callback);
				};
				return needCancel ? { fn, cancel: () => timerEnvironment.clearTimeout(timer) } : fn;
			},
		},
		"./MapPathChoiceSceneController": { MapPathChoiceSceneController: class {
			update() {}
			setRequest() {}
			dispose() {}
		} },
	};
	const sourcePath = process.env.MM_RENDERER_TEST_SOURCE || path.resolve(clientRoot, "src/core/renderer/GameRenderer.ts");
	const { GameRenderer } = load(fs.readFileSync(sourcePath, "utf8"), deps, {
		window,
		Element,
		document: { createElement: () => new DOMNode() },
		...timerEnvironment,
		requestAnimationFrame(fn) { rafs.set(++sequence, fn); return sequence; },
		cancelAnimationFrame(id) { rafs.delete(id); },
	});
	const canvas = new DOMNode();
	Object.assign(canvas, { width: 800, height: 600, clientWidth: 800, clientHeight: 600 });
	const container = new DOMNode();
	Object.assign(container, { clientWidth: 800, clientHeight: 600 });
	const renderer = new GameRenderer(canvas, container, mapData);
	// 运行真实初始化/销毁控制流程；仅跳过 GPU 模型下载及具体画面内容。
	for (const method of ["initDiceManager", "initMap", "initBackground", "initPlayer", "initChanceCard", "initMapPathChoiceArrowModel", "initLight", "initOutlinePass", "focusMe", "handlePropertyRaycaster", "handleMapEventRaycaster", "updateActiveSpeechBubbleLayout"])
		renderer[method] = () => undefined;
	return { renderer, GameRenderer, eventBus, listeners, timeouts, rafs, apps, graphics, container, gsap, mapStore, gameStore, modelHashes };
}

test("destroy removes its window listeners and pending resize, unmounts its overlays, and is idempotent", async () => {
	for (const mobile of [false, true]) {
		const f = fixture(mobile);
		await f.renderer.init();
		const pointerEvent = mobile ? "touchmove" : "pointermove";
		assert.equal(f.listeners.get("resize").size, 1);
		assert.equal(f.listeners.get(pointerEvent).size, 1);
		[...f.listeners.get("resize")][0]();
		assert.equal(f.timeouts.size, 1);
		f.renderer.destroy();
		f.renderer.destroy();
		assert.equal(f.listeners.get("resize").size, 0);
		assert.equal(f.listeners.get(pointerEvent).size, 0);
		assert.equal(f.timeouts.size, 0);
		assert.equal(f.rafs.size, 0);
		assert.ok(f.apps.every((app) => app.unmountCount === 1));
		assert.equal(f.graphics.disposed, 1);
		assert.equal(f.container.children.length, 0);
	}
});

test("destroy keeps page reinitialization and other components' shared-bus subscriptions", async () => {
	const f = fixture();
	let reinitializations = 0;
	let buttonEvents = 0;
	f.eventBus.on("game:init", () => reinitializations++);
	f.eventBus.on("game-currentPlayerIdInRound", () => buttonEvents++);
	await f.renderer.init();
	assert.equal(f.eventBus.getListeners("game-currentPlayerIdInRound"), 2);
	f.renderer.destroy();
	assert.equal(f.eventBus.getListeners("game-currentPlayerIdInRound"), 1);
	f.eventBus.emit("game:init");
	f.eventBus.emit("game-currentPlayerIdInRound", "player");
	assert.equal(reinitializations, 1);
	assert.equal(buttonEvents, 1);
});

test("closing during asynchronous initialization cannot mount later stages or restart RAF", async () => {
	const f = fixture();
	let completeDice;
	let mapsLoaded = 0;
	f.renderer.initDiceManager = () => new Promise((resolve) => { completeDice = resolve; });
	f.renderer.initMap = () => mapsLoaded++;
	const initializing = f.renderer.init();
	f.renderer.destroy();
	completeDice();
	await assert.rejects(initializing, /已关闭/);
	assert.equal(mapsLoaded, 0);
	assert.equal(f.rafs.size, 0);
	assert.equal(f.eventBus.getListeners("game-currentPlayerIdInRound"), 0);
});

test("map models mount even when a map has no background resource", () => {
	const f = fixture();
	f.renderer.mapData = { info: { backgroundImageId: "" } };
	f.GameRenderer.prototype.initBackground.call(f.renderer);
	assert.equal(f.renderer.mapContainer.parent, f.renderer.scene);
	f.renderer.destroy();
});

test("explicit scene modes use compatible camera limits and a neutral volume background while preserving old maps", () => {
	const sceneVisual = { version: 1, mode: "volumetric", collection: "china24-3d-models-v1", hiddenOriginalTileIds: [] };
	const f = fixture(false, { sceneVisual, info: { backgroundImageId: "original-art" } });
	assert.ok(Math.abs(f.renderer.controls.minPolarAngle - Math.PI / 6) < 1e-7);
	assert.ok(Math.abs(f.renderer.controls.maxPolarAngle - THREE.MathUtils.degToRad(70)) < 1e-7);
	f.GameRenderer.prototype.initBackground.call(f.renderer);
	assert.equal(f.renderer.scene.background.getHexString(), "e8f5fa");
	assert.equal(f.renderer.scene.fog.near, 55);
	assert.equal(f.renderer.mapData.info.backgroundImageId, "original-art");
	f.renderer.destroy();
	const illustration = fixture(false, { sceneVisual: { ...sceneVisual, mode: "illustrated" } });
	assert.equal(illustration.renderer.controls.enableRotate, false);
	illustration.renderer.destroy();
	const legacy = fixture();
	assert.equal(legacy.renderer.controls.maxPolarAngle, Math.PI / 2);
	assert.notEqual(legacy.renderer.controls.enableRotate, false);
	legacy.renderer.destroy();
});

test("volume scene models sit in water with lit shadows and safely replace only an empty original park anchor", async () => {
	const f = fixture();
	const fountain = new THREE.Group();
	fountain.userData = { china24Volumetric: true, china24SceneModelId: "pearl-lotus-fountain", collection: "china24-scene-models-v1" };
	fountain.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
	const water = new THREE.Group();
	water.userData.china24Volumetric = true;
	const waterMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
	waterMesh.rotation.x = -Math.PI / 2;
	waterMesh.userData.china24WaterSurface = true;
	water.add(waterMesh);
	const park = new THREE.Group();
	park.add(new THREE.Mesh(new THREE.BoxGeometry(8, 2, 8), new THREE.MeshStandardMaterial()));
	f.renderer.mapModules.set("fountain-model", { scene: fountain, hasAnimations: false });
	f.renderer.mapModules.set("water-model", { scene: water, hasAnimations: false });
	f.renderer.mapModules.set("park-model", { scene: park, hasAnimations: false });
	f.renderer.mapData = {
		sceneVisual: {
			version: 1, mode: "volumetric", collection: "china24-3d-models-v1", hiddenOriginalTileIds: ["park"],
			hiddenOriginalModels: { park: { modelId: "park-model", sha256: "a".repeat(64) } },
		},
		mapItems: [
			{ id: "park", x: 5, y: 5, rotation: 0, type: { id: "park-type", name: "城市中央公园", size: 1, modelId: "park-model" } },
			{ id: "fountain", x: 5, y: 5, rotation: 1, type: { modelId: "fountain-model", size: 3.4, sceneDecoration: true, sceneAssetId: "pearl-lotus-fountain", sceneCollection: "china24-scene-models-v1" } },
			{ id: "water", x: 5, y: 5, rotation: 0, type: { modelId: "water-model", size: 17.5, sceneDecoration: true, sceneBase: true } },
		],
		mapIndex: [], mapPaths: [],
	};
	f.modelHashes.set("park-model", "a".repeat(64));
	const before = JSON.stringify(f.renderer.mapData);
	await f.renderer.initMapItems();
	const anchor = f.renderer.mapItemsInScene.get("park");
	const decoration = f.renderer.mapItemsInScene.get("fountain");
	const lake = f.renderer.mapItemsInScene.get("water");
	assert.equal(anchor.children.length, 0);
	assert.equal(anchor.userData.replacedSceneGround, true);
	assert.equal(anchor.userData.isMapItem, true);
	assert.equal(f.renderer.getMapItemSurfaceHeight(anchor), 0);
	assert.equal(decoration.position.y, -0.12);
	assert.equal(decoration.rotation.y, Math.PI / 2);
	assert.equal(lake.position.y, -0.18);
	assert.equal(lake.children[0].material.isShaderMaterial, true);
	assert.equal(f.renderer.sceneDecorationSprites.length, 0);
	f.renderer.scene.add(f.renderer.mapContainer);
	f.renderer.applyShadowSetting(true);
	assert.equal(decoration.children[0].castShadow, true);
	assert.equal(decoration.children[0].receiveShadow, true);
	assert.equal(lake.children[0].castShadow, false);
	assert.equal(lake.children[0].receiveShadow, false);
	f.renderer.applyShadowSetting(false);
	assert.equal(decoration.children[0].castShadow, false);
	assert.equal(JSON.stringify(f.renderer.mapData), before);
	assert.deepEqual(Array.from(f.renderer.getTargetPositions("ToMapItem", ["park", "fountain"]), (position) => position.toArray()), [[5.5, 0, 5.5]]);
	f.renderer.destroy();
});

test("scene decorations load beside normal tiles without events, shadows or chance-card targeting", async () => {
	const f = fixture();
	const spriteModel = new THREE.Group();
	const spriteNode = new THREE.Group();
	spriteNode.userData.china24SceneSprite = true;
	const spriteMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
	spriteMesh.geometry.translate(0, 0.5, 0);
	spriteNode.add(spriteMesh);
	spriteModel.add(spriteNode);
	const groundModel = new THREE.Group();
	groundModel.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()));
	f.renderer.mapModules.set("sprite", { scene: spriteModel, hasAnimations: false });
	f.renderer.mapModules.set("ground", { scene: groundModel, hasAnimations: false });
	f.renderer.mapData = {
		mapItems: [
			{ id: "road", x: 0, y: 0, rotation: 1, type: { modelId: "ground", size: 2 } },
			{ id: "palace", x: -2, y: 12, rotation: 3, mapEventId: "ignored", type: { modelId: "sprite", size: 3, sceneDecoration: true } },
			{ id: "water", x: 5, y: 5, rotation: 0, type: { modelId: "ground", size: 18, sceneDecoration: true, sceneBase: true } },
		],
	};
	await f.renderer.initMapItems();
	const palace = f.renderer.mapItemsInScene.get("palace");
	const road = f.renderer.mapItemsInScene.get("road");
	const water = f.renderer.mapItemsInScene.get("water");
	assert.deepEqual(palace.position.toArray(), [-1.5, 0.07, 12.5]);
	assert.deepEqual(palace.scale.toArray(), [3, 3, 3]);
	assert.equal(palace.rotation.y, 0);
	assert.equal(palace.userData.isMapItem, false);
	assert.equal(palace.userData.mapEvent, undefined);
	assert.deepEqual(road.scale.toArray(), [1, 1, 1]);
	assert.equal(road.rotation.y, Math.PI / 2);
	assert.equal(water.position.y, -0.18);
	assert.deepEqual(water.scale.toArray(), [18, 18, 18]);
	assert.equal(f.renderer.sceneDecorationSprites.length, 1);
	assert.equal(f.renderer.arrivedEventIcons.size, 0);
	f.renderer.scene.add(f.renderer.mapContainer);
	f.renderer.applyShadowSetting(true);
	assert.equal(f.renderer.sceneDecorationSprites[0].castShadow, false);
	assert.equal(f.renderer.sceneDecorationSprites[0].receiveShadow, false);
	assert.deepEqual(Array.from(f.renderer.getTargetPositions("ToMapItem", ["road", "palace", "water"]), (position) => position.toArray()), [[0.5, 0, 0.5]]);
	await f.renderer.addEventIcon("palace", { id: "event", iconId: "icon" });
	f.renderer.setMapItemEventUserData("palace", { id: "event", name: "Event", description: "" });
	assert.equal(palace.userData.mapEvent, undefined);
	assert.equal(f.renderer.arrivedEventIcons.size, 0);
	f.renderer.destroy();
});

test("invalid decoration coordinates and missing models fail initialization explicitly", async () => {
	const f = fixture();
	f.renderer.mapData = { mapItems: [{ id: "bad", x: Infinity, y: 0, type: { sceneDecoration: true } }] };
	await assert.rejects(f.renderer.initMapItems(), /坐标必须是有限数值/);
	f.renderer.mapData.mapItems[0].x = 1;
	await assert.rejects(f.renderer.initMapItems(), /找不到模型/);
	f.renderer.destroy();
});

function buildingFixture() {
	const f = fixture();
	const property = { id: "city", name: "北京", level: 0, maxLevel: 4, sellCost: 1000, buildCost: 100, costList: [10, 20, 30, 40, 50] };
	f.mapStore.buildingVisual = { version: 1, collection: "china24-property-models-v1", unownedModelId: "L0" };
	f.mapStore.buildingModelIdList = ["L1", "L2", "L3", "L4", "L5"];
	f.mapStore.mapItems = [{ id: "city-tile", x: 4, y: 1, property }];
	const target = new THREE.Group();
	target.position.set(4.5, 0, 1.5);
	target.add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1), new THREE.MeshBasicMaterial()));
	f.renderer.mapItemsInScene.set("city-tile", target);
	for (let level = 0; level <= 5; level++) {
		const root = new THREE.Group();
		root.userData = { china24PropertyBuilding: true, collection: "china24-property-models-v1", visualLevel: level, targetWidthInRouteTiles: 0.9 };
		const nested = new THREE.Group();
		const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial());
		mesh.userData.china24SceneSprite = true;
		nested.add(mesh);
		root.add(nested);
		f.renderer.mapModules.set("L" + level, { scene: root, hasAnimations: false });
	}
	const label = new THREE.Sprite(new THREE.SpriteMaterial());
	const textSprite = { updateText() {}, getSprite: () => label };
	f.renderer.housesItems.set(property.id, { group: new THREE.Group(), textSprite });
	return { ...f, property };
}

test("new property visuals show L0 before buying and L1 through L5 by business level with interactive billboards", async () => {
	const f = buildingFixture();
	await f.renderer.updateBuilding(f.property);
	assert.equal(f.renderer.housesItems.get("city").group.userData.visualLevel, 0);
	const owner = { userId: "owner", color: "#0099ff" };
	for (let level = 0; level <= 4; level++) {
		await f.renderer.updateBuilding({ ...f.property, level, owner });
		const building = f.renderer.housesItems.get("city").group;
		assert.equal(building.userData.visualLevel, level + 1);
		assert.deepEqual(building.scale.toArray(), [0.9, 0.9, 0.9]);
		assert.equal(building.position.x, 4.5);
		assert.ok(Math.abs(building.position.y - 0.1) < 1e-7);
		assert.equal(building.position.z, 1.5);
		assert.equal(building.userData.isProperty, true);
		assert.equal(f.renderer.propertyBuildingSprites.size, 1);
		const sprite = f.renderer.propertyBuildingSprites.get("city")[0];
		assert.equal(sprite.userData.sceneDecoration, undefined);
		assert.equal(sprite.userData.china24PropertyBuildingSprite, true);
		building.updateMatrixWorld(true);
		const raycaster = new THREE.Raycaster(new THREE.Vector3(4.5, 0.5, 4), new THREE.Vector3(0, 0, -1));
		raycaster.camera = f.renderer.camera;
		const hits = raycaster.intersectObject(building, true);
		assert.ok(hits.some((hit) => hit.object === sprite));
		let picked;
		f.renderer.propertyInfoLabelInstance.updateProperty = (value) => { picked = value; };
		f.GameRenderer.prototype.handlePropertyRaycaster.call(f.renderer, { setFromCamera() {}, intersectObjects: () => [{ object: sprite }] }, new THREE.Vector2());
		assert.equal(picked.id, "city");
	}
	await f.renderer.updateBuilding(f.property);
	assert.equal(f.renderer.housesItems.get("city").group.userData.visualLevel, 0);
	f.renderer.scene.add(f.renderer.mapContainer);
	f.renderer.applyShadowSetting(true);
	assert.equal(f.renderer.propertyBuildingSprites.get("city")[0].castShadow, false);
	assert.equal(f.property.level, 0);
	assert.equal(f.property.maxLevel, 4);
	assert.deepEqual(f.property.costList, [10, 20, 30, 40, 50]);
	f.renderer.destroy();
	assert.equal(f.renderer.propertyBuildingSprites.size, 0);
});

test("real property buildings stay upright beside raised routes, place labels above their roof and preserve shared mesh data on reload", async () => {
	const f = buildingFixture();
	const root = new THREE.Group();
	root.userData = { china24PropertyBuilding: true, china24Volumetric: true, collection: "china24-property-models-v1", targetWidthInRouteTiles: 0.9 };
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1).translate(0, 1, 0), new THREE.MeshStandardMaterial());
	root.add(mesh);
	f.renderer.mapModules.set("L1", { scene: root, hasAnimations: false });
	const route = new THREE.Group();
	route.position.set(4.5, 0, 2.5);
	route.add(new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshStandardMaterial()));
	f.renderer.mapItemsInScene.set("raised-road", route);
	f.mapStore.mapItems.push({ id: "raised-road", linkto: "city-tile" });
	await f.renderer.updateBuilding({ ...f.property, owner: { userId: "owner", color: "#0099ff" } });
	const building = f.renderer.housesItems.get("city").group;
	assert.ok(new THREE.Vector3(0, 1, 0).applyQuaternion(building.quaternion).distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-7);
	assert.equal(f.renderer.propertyBuildingSprites.get("city").length, 0);
	const label = building.children.find((object) => object.isSprite);
	assert.ok(label.position.y > 2);
	let geometryDisposed = 0;
	let materialDisposed = 0;
	mesh.geometry.addEventListener("dispose", () => geometryDisposed++);
	mesh.material.addEventListener("dispose", () => materialDisposed++);
	f.renderer.initProperties = () => undefined;
	await f.renderer.reloadScene();
	assert.equal(geometryDisposed, 0);
	assert.equal(materialDisposed, 0);
	assert.equal(f.property.maxLevel, 4);
	assert.deepEqual(f.property.costList, [10, 20, 30, 40, 50]);
	f.renderer.destroy();
});

test("a newer ownership update wins over a delayed older model animation and closing prevents late remounts", async () => {
	const f = buildingFixture();
	const pending = [];
	f.gsap.to = (target, options) => {
		if (options.onComplete) { options.onComplete(); return Promise.resolve(); }
		return new Promise((resolve) => pending.push(resolve));
	};
	const older = f.renderer.updateBuilding(f.property);
	const newer = f.renderer.updateBuilding({ ...f.property, owner: { userId: "owner", color: "#0099ff" }, level: 4 });
	pending[1]();
	await newer;
	pending[0]();
	await older;
	assert.equal(f.renderer.housesItems.get("city").group.userData.visualLevel, 5);
	assert.equal(f.renderer.mapContainer.children.filter((object) => object.userData.isProperty).length, 1);
	const closing = f.renderer.updateBuilding(f.property);
	f.renderer.destroy();
	pending[2]();
	await closing;
	assert.equal(f.renderer.propertyBuildingSprites.size, 0);
	assert.equal(f.renderer.mapContainer.children.filter((object) => object.userData.visualLevel === 0).length, 0);
});

test("latest property sprites replace the old street geometry at surface 0.13 without changing targeting or custom 3D bases", async () => {
	const f = buildingFixture();
	const street = new THREE.Group();
	street.add(new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshBasicMaterial()));
	f.renderer.mapModules.set("old-street", { scene: street, hasAnimations: false });
	const item = { id: "city-tile", x: 4, y: 1, rotation: 1, type: { modelId: "old-street", size: 1 }, property: f.property };
	f.renderer.mapData = { mapItems: [item] };
	f.renderer.mapItemsInScene.clear();
	await f.renderer.initMapItems();
	const latestGround = f.renderer.mapItemsInScene.get("city-tile");
	assert.equal(latestGround.children.length, 0);
	assert.equal(latestGround.userData.latestPropertyGround, true);
	assert.equal(latestGround.userData.id, "city-tile");
	assert.equal(latestGround.userData.isMapItem, true);
	assert.deepEqual(latestGround.position.toArray(), [4.5, 0.13, 1.5]);
	assert.equal(f.renderer.getMapItemSurfaceHeight(latestGround), 0.13);
	assert.deepEqual(Array.from(f.renderer.getTargetPositions("ToMapItem", ["city-tile"]), (position) => position.toArray()), [[4.5, 0.13, 1.5]]);
	await f.renderer.updateBuilding(f.property);
	const building = f.renderer.housesItems.get("city").group;
	assert.equal(building.position.y, 0.13);
	const sprite = f.renderer.propertyBuildingSprites.get("city")[0];
	let picked;
	f.renderer.propertyInfoLabelInstance.updateProperty = (value) => { picked = value; };
	f.GameRenderer.prototype.handlePropertyRaycaster.call(f.renderer, { setFromCamera() {}, intersectObjects: () => [{ object: sprite }] }, new THREE.Vector2());
	assert.equal(picked.id, f.property.id);
	const customModel = new THREE.Group();
	customModel.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
	f.renderer.mapModules.set("custom3d", { scene: customModel, hasAnimations: false });
	item.property = { ...f.property, buildingModelIdList: ["custom3d"] };
	await f.renderer.initMapItems();
	const customGround = f.renderer.mapItemsInScene.get("city-tile");
	assert.equal(customGround.children.length, 1);
	assert.equal(customGround.userData.latestPropertyGround, undefined);
	assert.equal(customGround.position.y, 0);
	assert.equal(f.renderer.getMapItemSurfaceHeight(customGround), 2);
	item.property = f.property;
	delete f.mapStore.buildingVisual;
	await f.renderer.initMapItems();
	const legacyGround = f.renderer.mapItemsInScene.get("city-tile");
	assert.equal(legacyGround.children.length, 1);
	assert.equal(legacyGround.userData.latestPropertyGround, undefined);
	assert.equal(legacyGround.position.y, 0);
	assert.deepEqual(f.property.costList, [10, 20, 30, 40, 50]);
	f.renderer.destroy();
});
