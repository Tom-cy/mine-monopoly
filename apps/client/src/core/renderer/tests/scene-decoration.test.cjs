const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const THREE = require(require.resolve("three", { paths: [clientRoot] }));

function load(file) {
	const module = { exports: {} };
	const source = fs.readFileSync(path.resolve(clientRoot, file), "utf8");
	const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
	vm.runInNewContext(outputText, { module, exports: module.exports, require: () => THREE });
	return module.exports;
}

const { isSceneDecoration } = load("src/utils/scene-decoration.ts");
const { prepareSceneDecoration, updateSceneDecorationBillboards } = load("src/core/renderer/SceneDecoration.ts");

function spriteFixture() {
	const root = new THREE.Group();
	const node = new THREE.Group();
	node.userData.china24SceneSprite = true;
	const texture = new THREE.Texture();
	const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.03 }));
	node.add(mesh);
	root.add(node);
	return { root, node, mesh, texture };
}

test("only a boolean sceneDecoration flag changes legacy tile behavior", () => {
	for (const type of [undefined, null, {}, { sceneDecoration: false }, { sceneDecoration: "true" }, { sceneDecoration: 1 }]) {
		assert.equal(isSceneDecoration(type), false);
	}
	assert.equal(isSceneDecoration({ sceneDecoration: true }), true);
});

test("billboard faces the world camera through rotated parents without moving its bottom pivot", () => {
	const { root, node, mesh } = spriteFixture();
	root.position.set(-3, 0.07, 12);
	root.rotation.y = Math.PI;
	const sprites = prepareSceneDecoration(root, 4);
	node.rotation.set(0.2, 0.3, 0.1);
	const world = new THREE.Group();
	world.rotation.set(0.3, -0.4, 0.2);
	world.add(root);
	const cameraParent = new THREE.Group();
	const camera = new THREE.PerspectiveCamera();
	cameraParent.rotation.y = 0.6;
	camera.rotation.set(-0.7, 0.9, 0.1);
	cameraParent.add(camera);
	const bottomBefore = mesh.localToWorld(new THREE.Vector3(0, 0, 0));
	updateSceneDecorationBillboards(sprites, camera);
	const actual = mesh.getWorldQuaternion(new THREE.Quaternion());
	const expected = camera.getWorldQuaternion(new THREE.Quaternion());
	assert.ok(actual.angleTo(expected) < 1e-7);
	assert.ok(bottomBefore.distanceTo(mesh.localToWorld(new THREE.Vector3(0, 0, 0))) < 1e-7);
	assert.deepEqual(root.position.toArray(), [-3, 0.07, 12]);
	assert.deepEqual(root.scale.toArray(), [4, 4, 4]);
	camera.rotation.set(-1.3, -0.6, 0);
	updateSceneDecorationBillboards(sprites, camera);
	assert.ok(mesh.getWorldQuaternion(new THREE.Quaternion()).angleTo(camera.getWorldQuaternion(new THREE.Quaternion())) < 1e-7);
});

test("decoration instances share their existing texture and never intercept raycasts or cast shadows", () => {
	const { root, mesh, texture } = spriteFixture();
	const clone = root.clone(true);
	const sprites = prepareSceneDecoration(clone, 3);
	assert.equal(sprites[0].material.map, texture);
	assert.equal(sprites[0].castShadow, false);
	assert.equal(sprites[0].receiveShadow, false);
	const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 1, 5), new THREE.Vector3(0, 0, -1));
	clone.updateMatrixWorld(true);
	assert.equal(raycaster.intersectObject(clone, true).length, 0);
	assert.notEqual(mesh.raycast, sprites[0].raycast);
});

test("a plain sea base scales without becoming a billboard, and invalid sizes are rejected", () => {
	const root = new THREE.Group();
	const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
	water.rotation.x = -Math.PI / 2;
	root.add(water);
	root.position.y = -0.18;
	const sprites = prepareSceneDecoration(root, 18);
	assert.equal(sprites.length, 0);
	updateSceneDecorationBillboards(sprites, new THREE.PerspectiveCamera());
	assert.equal(water.rotation.x, -Math.PI / 2);
	assert.equal(root.position.y, -0.18);
	for (const size of [0, -1, NaN, Infinity]) assert.throws(() => prepareSceneDecoration(new THREE.Group(), size), /显示宽度/);
});

test("target minimap bounds and cells ignore decorations while preserving ordinary non-path tiles", () => {
	const source = fs.readFileSync(path.resolve(clientRoot, "src/components/common/target-seletor/components/mini-map.vue"), "utf8");
	const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
	const map = {
		mapIndex: ["road"],
		mapItems: [
			{ id: "road", x: 0, y: 0, type: {} },
			{ id: "legacy-park", x: 5, y: 5, type: {} },
			{ id: "palace", x: -20, y: 40, type: { sceneDecoration: true } },
		],
	};
	const module = { exports: {} };
	const { outputText } = ts.transpileModule(script + "\nmodule.exports = { mapBounds, processedMapItems };", {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	vm.runInNewContext(outputText, {
		module, exports: module.exports,
		defineProps: () => ({ highLightList: ["road"], selectedId: "" }), defineEmits: () => () => {},
		require(name) {
			if (name === "vue") return { computed: (fn) => ({ get value() { return fn(); } }), toRaw: (value) => value };
			if (name === "@src/store/game") return { useMapData: () => map, useGameData: () => ({ properties: [], players: [] }) };
			if (name === "@src/utils/scene-decoration") return { isSceneDecoration };
			throw new Error("Unexpected dependency " + name);
		},
	});
	assert.equal(module.exports.mapBounds.value.width, 6);
	assert.equal(module.exports.mapBounds.value.height, 6);
	assert.deepEqual(Array.from(module.exports.processedMapItems.value, (item) => item.id), ["road", "legacy-park"]);
});
