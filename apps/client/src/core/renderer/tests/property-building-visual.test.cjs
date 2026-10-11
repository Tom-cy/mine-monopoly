const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const THREE = require(require.resolve("three", { paths: [clientRoot] }));

function load(file, dependencies = {}, environment = {}) {
	const module = { exports: {} };
	const source = fs.readFileSync(path.resolve(clientRoot, file), "utf8").replaceAll("import.meta.env", "({})");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	vm.runInNewContext(outputText, {
		module,
		exports: module.exports,
		console,
		...environment,
		require(name) {
			return dependencies[name] ?? {};
		},
	});
	return module.exports;
}

const { resolvePropertyBuildingModelId, preparePropertyBuildingModel } = load(
	"src/core/renderer/PropertyBuildingVisual.ts",
	{ three: THREE },
);
const { updateSceneDecorationBillboards } = load("src/core/renderer/SceneDecoration.ts", { three: THREE });
const visual = { version: 1, collection: "china24-property-models-v1", unownedModelId: "L0" };
const map = { buildingVisual: visual, buildingModelIdList: ["L1", "L2", "L3", "L4", "L5"] };

test("new maps select an independent L0 by ownership, preserve custom purchased models, and keep legacy mappings", () => {
	assert.equal(resolvePropertyBuildingModelId({ level: 0, maxLevel: 0 }, map), "L0");
	assert.equal(resolvePropertyBuildingModelId({ level: 4 }, map), "L0");
	assert.equal(resolvePropertyBuildingModelId({ level: 3, buildingModelIdList: [] }, map), "L0");
	for (let level = 0; level <= 4; level++)
		assert.equal(resolvePropertyBuildingModelId({ level, owner: {} }, map), "L" + (level + 1));
	assert.equal(resolvePropertyBuildingModelId({ level: 0, owner: {}, buildingModelIdList: ["custom"] }, map), "custom");
	assert.equal(resolvePropertyBuildingModelId({ level: 4, owner: {}, buildingModelIdList: ["custom"] }, map), "custom");
	const legacyMap = { buildingModelIdList: ["old0", "old1", "old2"] };
	assert.equal(resolvePropertyBuildingModelId({ level: 0 }, legacyMap), "old0");
	assert.equal(resolvePropertyBuildingModelId({ level: 1, owner: {} }, legacyMap), "old1");
	assert.equal(resolvePropertyBuildingModelId({ level: 8 }, legacyMap), "old2");
	assert.equal(
		resolvePropertyBuildingModelId({ level: 0 }, legacyMap, (id) => id !== "old0"),
		"old2",
	);
	assert.equal(
		resolvePropertyBuildingModelId({ level: 0 }, { ...legacyMap, buildingVisual: { ...visual, version: 2 } }),
		"old0",
	);
	assert.equal(resolvePropertyBuildingModelId({ level: 0, owner: {}, buildingModelIdList: [] }, map), undefined);
});

test("property billboards preserve shared texture, pivot and raycast through a rotated nested GLB hierarchy", () => {
	const world = new THREE.Group();
	world.rotation.y = 0.3;
	const root = new THREE.Group();
	const marker = new THREE.Group();
	marker.userData = {
		china24PropertyBuilding: true,
		collection: "china24-property-models-v1",
		targetWidthInRouteTiles: 0.9,
	};
	marker.rotation.y = -0.7;
	const mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0),
		new THREE.MeshBasicMaterial({ map: new THREE.Texture() }),
	);
	mesh.userData.china24SceneSprite = true;
	marker.add(mesh);
	root.add(marker);
	world.add(root);
	const oldRaycast = mesh.raycast;
	const texture = mesh.material.map;
	const prepared = preparePropertyBuildingModel(root);
	assert.equal(prepared.width, 0.9);
	assert.equal(prepared.sprites.length, 1);
	assert.notEqual(mesh.raycast, oldRaycast);
	assert.equal(mesh.userData.sceneDecoration, undefined);
	assert.equal(mesh.material.map, texture);
	root.scale.setScalar(prepared.width);
	const camera = new THREE.PerspectiveCamera();
	camera.rotation.set(-0.8, 0.6, 0.1);
	const pivot = mesh.localToWorld(new THREE.Vector3());
	updateSceneDecorationBillboards(prepared.sprites, camera);
	assert.ok(
		mesh.getWorldQuaternion(new THREE.Quaternion()).angleTo(camera.getWorldQuaternion(new THREE.Quaternion())) < 1e-7,
	);
	assert.ok(pivot.distanceTo(mesh.localToWorld(new THREE.Vector3())) < 1e-7);
	assert.equal(preparePropertyBuildingModel(new THREE.Group()), undefined);
});

test("alpha picking respects texture orientation, opacity and UV transforms, caches pixels and leaves legacy models unchanged", () => {
	let pixelReads = 0;
	const { preparePropertyBuildingModel: prepare } = load(
		"src/core/renderer/PropertyBuildingVisual.ts",
		{ three: THREE },
		{
			document: {
				createElement: () => ({
					getContext: () => ({
						drawImage() {},
						getImageData() {
							pixelReads++;
							return { data: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 128]) };
						},
					}),
				}),
			},
		},
	);
	const root = new THREE.Group();
	root.userData = { china24PropertyBuilding: true, collection: "china24-property-models-v1" };
	const texture = new THREE.Texture({ width: 2, height: 2 });
	const material = new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.03 });
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
	mesh.userData.china24SceneSprite = true;
	root.add(mesh);
	prepare(root);
	root.updateMatrixWorld(true);
	const hits = (x, y) =>
		new THREE.Raycaster(new THREE.Vector3(x, y, 2), new THREE.Vector3(0, 0, -1)).intersectObject(mesh).length;
	assert.ok(hits(-0.25, 0.25) > 0);
	assert.equal(hits(0.25, 0.25), 0);
	assert.equal(hits(-0.25, -0.25), 0);
	assert.ok(hits(0.25, -0.25) > 0);
	material.opacity = 0.01;
	assert.equal(hits(0.25, -0.25), 0);
	material.opacity = 1;
	texture.offset.x = 0.5;
	assert.equal(hits(-0.25, 0.25), 0);
	texture.offset.x = 0;
	texture.flipY = false;
	assert.equal(hits(-0.25, 0.25), 0);
	assert.ok(hits(-0.25, -0.25) > 0);
	assert.equal(pixelReads, 1);
	const legacy = new THREE.Group();
	const legacyMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
	legacyMesh.userData.china24SceneSprite = true;
	const originalRaycast = legacyMesh.raycast;
	legacy.add(legacyMesh);
	assert.equal(prepare(legacy), undefined);
	assert.equal(legacyMesh.raycast, originalRaycast);
	const custom3d = new THREE.Mesh(new THREE.BoxGeometry(), material);
	const customRaycast = custom3d.raycast;
	root.add(custom3d);
	prepare(root);
	assert.equal(custom3d.raycast, customRaycast);
});

test("client map reset and both load paths clear a prior visual contract when switching to a legacy map", async () => {
	const definitions = {};
	load(
		"src/store/game.ts",
		{
			pinia: {
				defineStore: (id, definition) => {
					definitions[id] = definition;
					return () => ({});
				},
			},
		},
		{ crypto: require("node:crypto").webcrypto },
	);
	const mapState = definitions["map-data"].state.call({});
	assert.equal(Object.hasOwn(mapState, "buildingVisual"), true);
	assert.equal(mapState.buildingVisual, undefined);
	const mapStore = {
		$patch(patch) {
			Object.assign(this, patch);
		},
	};
	const resourceStore = {
		recourceMap: new Map(),
		getRecourceById(id) {
			return this.recourceMap.get(id);
		},
		add(resource) {
			this.recourceMap.set(resource.id, resource);
		},
		clear() {
			for (const resource of this.recourceMap.values()) URL.revokeObjectURL(resource.url);
			this.recourceMap.clear();
		},
	};
	let selectedMap;
	const decoded = () => ({
		jsonData: JSON.stringify(selectedMap),
		modelFiles: [],
		imageFiles: [{ id: "cover", name: "cover", filetype: "png", buffer: new Uint8Array([1]) }],
	});
	const loadMap = load(
		"src/utils/file/game-map.ts",
		{
			"@mine-monopoly/utils": {
				loadFromProto: async () => decoded(),
				normalizeGameMap: load("../../packages/utils/game/map.ts").normalizeGameMap,
			},
			"@mine-monopoly/utils/crypto": { isProductFile: () => false },
			"@mine-monopoly/env": { env: () => "" },
			"@src/utils": { formatBytes: (bytes) => String(bytes) },
			"@src/store": { useLoading: () => ({ showLoading() {}, hideLoading() {} }), useRoomInfo: () => ({}) },
			"@src/store/game": { useMapData: () => mapStore, useResourceStore: () => resourceStore },
			"../api/map": {
				getFrozenRoomMap: () => null,
				getGameMapById: async () => ({ id: "map", mapUrl: "fixture://map", hash: "" }),
				resolveMapResourceUrl: (url) => url,
			},
			"./map-loading": {
				assertMapLoadActive() {},
				withMapDownloadSignal: async (signal, callback) => callback(new AbortController().signal),
			},
		},
		{
			crypto: require("node:crypto").webcrypto,
			Blob,
			URL,
			TextEncoder,
			AbortController,
			Uint8Array,
			window: {},
			__COMPATIBLE_VERSION__: "3.0",
			fetch: async () => new Response(new Uint8Array([1])),
		},
	);
	for (const read of [
		() => loadMap.loadGameMapFromFile(new ArrayBuffer(1)),
		() => loadMap.loadGameMapFromServer("map"),
	]) {
		selectedMap = {
			id: "map",
			info: { editorVersion: "3.0.0", coverImageId: "cover" },
			mapItems: [{ id: "start", type: {} }],
			mapIndex: ["start"],
			roles: [],
			buildingModelIdList: map.buildingModelIdList,
			buildingVisual: visual,
			sceneVisual: { version: 1, mode: "volumetric", collection: "china24-3d-models-v1", hiddenOriginalTileIds: [] },
		};
		await read();
		assert.equal(mapStore.buildingVisual.unownedModelId, "L0");
		assert.equal(mapStore.sceneVisual.mode, "volumetric");
		delete selectedMap.buildingVisual;
		delete selectedMap.sceneVisual;
		await read();
		assert.equal(mapStore.buildingVisual, undefined);
		assert.equal(mapStore.sceneVisual, undefined);
	}
	resourceStore.clear();
});
