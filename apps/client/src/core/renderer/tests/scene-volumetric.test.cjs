const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const THREE = require(require.resolve("three", { paths: [clientRoot] }));

function load(name) {
	const module = { exports: {} };
	const { outputText } = ts.transpileModule(
		fs.readFileSync(path.resolve(clientRoot, "src/core/renderer/" + name + ".ts"), "utf8"),
		{
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		},
	);
	vm.runInNewContext(outputText, { module, exports: module.exports, require: () => THREE });
	return module.exports;
}

const { WaterSurfaceEffect } = load("WaterSurface");
const { hasSceneVisualContract, shouldHideOriginalSceneTile } = load("SceneVisual");
const { prepareSceneDecoration, updateSceneDecorationBillboards } = load("SceneDecoration");
const { preparePropertyBuildingModel, resolvePropertyBuildingModelId } = load("PropertyBuildingVisual");

function volumeFixture(marker) {
	const root = new THREE.Group();
	const node = new THREE.Group();
	node.userData = { china24Volumetric: true, ...marker };
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshStandardMaterial());
	node.add(mesh);
	root.add(node);
	return { root, mesh };
}

test("volume decorations retain rotation and lit depth through camera orbit while remaining outside business picking", () => {
	const { root, mesh } = volumeFixture({ china24SceneModelId: "dragon-palace" });
	root.position.set(-2, -0.12, 13);
	root.rotation.y = Math.PI / 2;
	const sprites = prepareSceneDecoration(root, 3.4, true);
	const quaternion = mesh.getWorldQuaternion(new THREE.Quaternion());
	const camera = new THREE.PerspectiveCamera();
	for (let yaw = 0; yaw < Math.PI * 2; yaw += Math.PI / 4) {
		camera.rotation.set(-0.6, yaw, 0);
		updateSceneDecorationBillboards(sprites, camera);
		assert.ok(mesh.getWorldQuaternion(new THREE.Quaternion()).angleTo(quaternion) < 1e-7);
	}
	assert.equal(sprites.length, 0);
	assert.equal(root.rotation.y, Math.PI / 2);
	assert.deepEqual(root.position.toArray(), [-2, -0.12, 13]);
	assert.equal(mesh.castShadow, true);
	assert.equal(mesh.receiveShadow, true);
	root.updateMatrixWorld(true);
	assert.equal(
		new THREE.Raycaster(new THREE.Vector3(-2, 1, 20), new THREE.Vector3(0, 0, -1)).intersectObject(root, true).length,
		0,
	);
	prepareSceneDecoration(root, 3.4, false);
	assert.equal(mesh.castShadow, false);
});

test("L0 to L5 real meshes preserve business levels, ownership selection and property raycasting", () => {
	const map = {
		buildingVisual: { version: 1, collection: "china24-property-models-v1", unownedModelId: "L0" },
		buildingModelIdList: ["L1", "L2", "L3", "L4", "L5"],
	};
	const property = { level: 0, maxLevel: 3, costList: [100, 200, 400, 800] };
	const before = JSON.stringify({ map, property });
	assert.equal(resolvePropertyBuildingModelId(property, map), "L0");
	for (let level = 0; level <= 4; level++) {
		assert.equal(resolvePropertyBuildingModelId({ ...property, level, owner: {} }, map), "L" + (level + 1));
		const { root, mesh } = volumeFixture({
			china24PropertyBuilding: true,
			collection: "china24-property-models-v1",
			targetWidthInRouteTiles: 0.9,
		});
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		const prepared = preparePropertyBuildingModel(root);
		assert.equal(prepared.width, 0.9);
		assert.equal(prepared.sprites.length, 0);
		assert.equal(mesh.userData.sceneDecoration, undefined);
		assert.equal(mesh.userData.china24PropertyBuildingModel, true);
		assert.equal(mesh.castShadow, true);
		root.scale.setScalar(prepared.width);
		root.updateMatrixWorld(true);
		assert.ok(
			new THREE.Raycaster(new THREE.Vector3(0, 0.4, 3), new THREE.Vector3(0, 0, -1)).intersectObject(root, true)
				.length > 0,
		);
	}
	assert.equal(JSON.stringify({ map, property }), before);
});

test("only marked water receives a disposable animated material without changing shared source geometry or other water", () => {
	const original = new THREE.MeshStandardMaterial({ color: "#33ffff" });
	const source = new THREE.Group();
	const water = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), original);
	water.rotation.x = -Math.PI / 2;
	water.userData.china24WaterSurface = true;
	water.castShadow = true;
	source.add(water);
	const instance = source.clone(true);
	const ordinary = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), original);
	instance.add(ordinary);
	const effect = new WaterSurfaceEffect();
	effect.prepare(instance);
	const prepared = instance.children[0];
	assert.equal(water.material, original);
	assert.equal(prepared.geometry, water.geometry);
	assert.equal(ordinary.material, original);
	assert.equal(prepared.material.isShaderMaterial, true);
	assert.equal(prepared.material.transparent, true);
	assert.equal(prepared.material.depthWrite, false);
	assert.equal(prepared.castShadow, false);
	assert.equal(prepared.receiveShadow, false);
	assert.ok(Math.abs(prepared.rotation.x + Math.PI / 2) < 1e-7);
	assert.match(prepared.material.fragmentShader, /smoothstep/);
	const material = prepared.material;
	effect.prepare(instance);
	assert.equal(prepared.material, material);
	effect.update(0.25);
	effect.update(Infinity);
	effect.update(-1);
	assert.equal(material.uniforms.uTime.value, 0.25);
	let disposed = 0;
	material.addEventListener("dispose", () => disposed++);
	effect.dispose();
	effect.dispose();
	assert.equal(disposed, 1);
	assert.equal(original.color.getHexString(), "33ffff");
});

function parkFixture(mode = "volumetric") {
	const park = {
		id: "park",
		x: 5,
		y: 5,
		rotation: 0,
		type: { id: "park-type", name: "城市中央公园", size: 1, modelId: "old-park" },
	};
	const fountain = {
		id: "fountain",
		x: 5,
		y: 5,
		type: {
			modelId: "new-fountain",
			sceneDecoration: true,
			sceneAssetId: "pearl-lotus-fountain",
			sceneCollection: "china24-scene-models-v1",
		},
	};
	const map = {
		sceneVisual: {
			version: 1,
			mode,
			collection: "china24-3d-models-v1",
			hiddenOriginalTileIds: ["park"],
			hiddenOriginalModels: { park: { modelId: "old-park", sha256: "a".repeat(64) } },
		},
		mapItems: [park, fountain],
		mapIndex: ["route"],
		mapPaths: [],
	};
	const { root } = volumeFixture({
		china24SceneModelId: "pearl-lotus-fountain",
		collection: "china24-scene-models-v1",
	});
	return {
		park,
		map,
		getModel: (id) => (id === "new-fountain" ? root : undefined),
		getHash: (id) => (id === "old-park" ? "a".repeat(64) : undefined),
	};
}

test("visual replacement applies to either explicit mode only after a real fountain loads, without mutating source map", () => {
	for (const mode of ["volumetric", "illustrated"]) {
		const { park, map, getModel, getHash } = parkFixture(mode);
		const before = JSON.stringify(map);
		assert.equal(shouldHideOriginalSceneTile(map, park, getModel, getHash), true);
		assert.equal(
			shouldHideOriginalSceneTile(map, park, () => undefined, getHash),
			false,
		);
		assert.equal(
			shouldHideOriginalSceneTile(map, park, () => new THREE.Group(), getHash),
			false,
		);
		assert.equal(JSON.stringify(map), before);
	}
	for (const sceneVisual of [
		undefined,
		null,
		{},
		{ version: 1, mode: "volumetric", collection: "custom", hiddenOriginalTileIds: ["park"] },
		{ version: 1, mode: "bad", collection: "china24-3d-models-v1", hiddenOriginalTileIds: [] },
	]) {
		const { park, map, getModel } = parkFixture();
		map.sceneVisual = sceneVisual;
		assert.equal(hasSceneVisualContract(map), false);
		assert.equal(shouldHideOriginalSceneTile(map, park, getModel), false);
	}
});

test("custom park business, movement, event and link targets always keep their original meshes", () => {
	const variants = [
		({ park }) => {
			park.property = {};
		},
		({ park }) => {
			park.mapEventId = "event";
		},
		({ park }) => {
			park.linkto = "other";
		},
		({ park }) => {
			park.beLinked = "other";
		},
		({ park }) => {
			park.x = 6;
		},
		({ park }) => {
			park.rotation = 1;
		},
		({ park }) => {
			park.rotation = 2;
		},
		({ park }) => {
			park.rotation = 3;
		},
		({ park }) => {
			park.type.name = "自定义公园";
		},
		({ map }) => {
			map.startMapItemId = "park";
		},
		({ map }) => {
			map.mapIndex.push("park");
		},
		({ map }) => {
			map.pathMapItemTypeIds = ["park-type"];
		},
		({ map }) => {
			map.mapPaths.push({ fromMapItemId: "park", toMapItemId: "route" });
		},
		({ map }) => {
			map.mapPaths.push({ fromMapItemId: "route", toMapItemId: "park" });
		},
		({ map }) => {
			map.mapItems.push({ id: "custom", linkto: "park" });
		},
		({ map }) => {
			map.mapItems.push({ id: "custom", beLinked: "park" });
		},
	];
	for (const change of variants) {
		const fixture = parkFixture();
		change(fixture);
		assert.equal(shouldHideOriginalSceneTile(fixture.map, fixture.park, fixture.getModel, fixture.getHash), false);
	}
});

test("replacing a hidden park model ID or bytes restores its mesh, and missing or invalid fingerprints fail safely", () => {
	const { map, park, getModel, getHash } = parkFixture();
	assert.equal(shouldHideOriginalSceneTile(map, park, getModel, getHash), true);
	assert.equal(
		shouldHideOriginalSceneTile(map, park, getModel, () => "b".repeat(64)),
		false,
	);
	assert.equal(
		shouldHideOriginalSceneTile(map, park, getModel, () => undefined),
		false,
	);
	park.type.modelId = "custom-park";
	assert.equal(
		shouldHideOriginalSceneTile(map, park, getModel, () => "a".repeat(64)),
		false,
	);
	park.type.modelId = "old-park";
	for (const fingerprint of [
		undefined,
		null,
		{},
		{ modelId: "old-park", sha256: "bad" },
		{ modelId: "custom-park", sha256: "a".repeat(64) },
	]) {
		map.sceneVisual.hiddenOriginalModels = fingerprint ? { park: fingerprint } : undefined;
		assert.equal(shouldHideOriginalSceneTile(map, park, getModel, getHash), false);
	}
});

test("only the expected fountain tile and GLB collections replace the original park", () => {
	const { map, park, getModel, getHash } = parkFixture();
	assert.equal(shouldHideOriginalSceneTile(map, park, getModel, getHash), true);
	map.mapItems[1].type.sceneCollection = "custom-scene";
	assert.equal(shouldHideOriginalSceneTile(map, park, getModel, getHash), false);
	map.mapItems[1].type.sceneCollection = "china24-scene-models-v1";
	const fountain = getModel("new-fountain");
	fountain.traverse((object) => {
		if (object.userData.china24SceneModelId === "pearl-lotus-fountain") object.userData.collection = "custom-scene";
	});
	assert.equal(shouldHideOriginalSceneTile(map, park, getModel, getHash), false);
});

test(
	"the client water shader compiles on real WebGL, animates and fades its large square canvas corners",
	{
		skip: !process.env.MM_VOLUMETRIC_CLIENT_ORIGIN,
		timeout: 60000,
	},
	async () => {
		const clientOrigin = process.env.MM_VOLUMETRIC_CLIENT_ORIGIN;
		const { chromium } = require(
			require.resolve("playwright-core", { paths: [clientRoot, path.resolve(clientRoot, "../../../game-admin")] }),
		);
		const browser = await chromium.launch({
			executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
			headless: true,
		});
		try {
			const page = await browser.newPage();
			const errors = [];
			page.on("pageerror", (error) => errors.push(error.message));
			page.on("console", (message) => {
				if (message.type() === "error") errors.push(message.text());
			});
			await page.route("**/*", (route) => {
				const url = route.request().url();
				if (/\/(?:monopoly-api|system-api|game-api)\//.test(url)) return route.abort();
				if (url === clientOrigin + "/__volumetric-water-test.html")
					return route.fulfill({
						contentType: "text/html",
						body: "<!doctype html><html><body><canvas width='256' height='256'></canvas></body></html>",
					});
				return route.continue();
			});
			await page.goto(clientOrigin + "/__volumetric-water-test.html");
			const result = await page.evaluate(async (origin) => {
				const source = await (await fetch(origin + "/src/core/renderer/WaterSurface.ts")).text();
				const threePath = source.match(/from\s+["']([^"']*three\.js[^"']*)["']/)?.[1];
				if (!threePath) throw new Error("Missing Three Vite module path");
				const THREE = await import(new URL(threePath, origin).href);
				const { WaterSurfaceEffect } = await import(origin + "/src/core/renderer/WaterSurface.ts");
				const renderer = new THREE.WebGLRenderer({
					canvas: document.querySelector("canvas"),
					alpha: true,
					antialias: false,
				});
				renderer.setClearColor(0, 0);
				const scene = new THREE.Scene();
				const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 50);
				camera.position.set(0, 20, 0);
				camera.up.set(0, 0, -1);
				camera.lookAt(0, 0, 0);
				const water = new THREE.Mesh(new THREE.PlaneGeometry(17.5, 17.5), new THREE.MeshBasicMaterial());
				water.rotation.x = -Math.PI / 2;
				water.userData.china24WaterSurface = true;
				scene.add(water);
				const effect = new WaterSurfaceEffect();
				effect.prepare(water);
				const target = new THREE.WebGLRenderTarget(256, 256);
				renderer.setRenderTarget(target);
				renderer.render(scene, camera);
				const before = new Uint8Array(256 * 256 * 4);
				renderer.readRenderTargetPixels(target, 0, 0, 256, 256, before);
				effect.update(0.6);
				renderer.render(scene, camera);
				const after = new Uint8Array(before.length);
				renderer.readRenderTargetPixels(target, 0, 0, 256, 256, after);
				let changed = 0;
				let visible = 0;
				let transparent = 0;
				for (let i = 0; i < before.length; i += 4) {
					if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changed++;
					if (before[i + 3] > 200) visible++;
					if (before[i + 3] === 0) transparent++;
				}
				const center = Array.from(before.slice((128 * 256 + 128) * 4, (128 * 256 + 128) * 4 + 4));
				const cornerAlpha = before[(22 * 256 + 22) * 4 + 3];
				camera.position.set(12, 14, 12);
				camera.lookAt(0, 0, 0);
				renderer.render(scene, camera);
				const glError = renderer.getContext().getError();
				effect.dispose();
				target.dispose();
				water.geometry.dispose();
				renderer.dispose();
				return { center, changed, visible, transparent, cornerAlpha, glError };
			}, clientOrigin);
			assert.equal(errors.length, 0, errors.join("\n"));
			assert.equal(result.glError, 0);
			assert.ok(result.center[3] > 200);
			assert.ok(result.center[2] > result.center[0]);
			assert.ok(result.visible > 30000);
			assert.ok(result.transparent > 10000);
			assert.ok(result.changed > 5000);
			assert.equal(result.cornerAlpha, 0);
		} finally {
			await browser.close();
		}
	},
);

test(
	"all nineteen self-contained 3D GLBs load in the client with real geometry, fixed orbit and correct picking and shadows",
	{
		skip: !process.env.MM_VOLUMETRIC_ASSET_ORIGIN,
		timeout: 60000,
	},
	async () => {
		const assetOrigin = process.env.MM_VOLUMETRIC_ASSET_ORIGIN;
		const clientOrigin = process.env.MM_VOLUMETRIC_CLIENT_ORIGIN || "http://localhost:5173";
		const { chromium } = require(
			require.resolve("playwright-core", { paths: [clientRoot, path.resolve(clientRoot, "../../../game-admin")] }),
		);
		const browser = await chromium.launch({
			executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
			headless: true,
		});
		try {
			const page = await browser.newPage();
			const errors = [];
			const foreign = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.route("**/*", async (route) => {
				const url = route.request().url();
				if (/\/(?:monopoly-api|system-api|game-api)\//.test(url)) return route.abort();
				if (url === clientOrigin + "/__volumetric-assets-test.html")
					return route.fulfill({
						contentType: "text/html",
						body: "<!doctype html><html><body>Volume assets client test</body></html>",
					});
				if (url.startsWith(assetOrigin + "/mine-monopoly/china24-q/")) {
					const response = await route.fetch();
					return route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
				}
				if (/^https?:/.test(url) && !url.startsWith(clientOrigin + "/")) {
					foreign.push(url);
					return route.abort();
				}
				return route.continue();
			});
			await page.goto(clientOrigin + "/__volumetric-assets-test.html");
			const result = await page.evaluate(
				async ({ clientOrigin, assetOrigin }) => {
					const helperSource = await (
						await fetch(clientOrigin + "/src/core/renderer/PropertyBuildingVisual.ts")
					).text();
					const loaderSource = await (await fetch(clientOrigin + "/src/utils/file/game-map.ts")).text();
					const threePath = helperSource.match(/from\s+["']([^"']*three\.js[^"']*)["']/)?.[1];
					const loaderPath = loaderSource.match(/from\s+["']([^"']*GLTFLoader[^"']*)["']/)?.[1];
					if (!threePath || !loaderPath) throw new Error("Missing client Three and GLTFLoader module paths");
					const THREE = await import(new URL(threePath, clientOrigin).href);
					const { GLTFLoader } = await import(new URL(loaderPath, clientOrigin).href);
					const { preparePropertyBuildingModel } = await import(
						clientOrigin + "/src/core/renderer/PropertyBuildingVisual.ts"
					);
					const { prepareSceneDecoration, updateSceneDecorationBillboards } = await import(
						clientOrigin + "/src/core/renderer/SceneDecoration.ts"
					);
					const { WaterSurfaceEffect } = await import(clientOrigin + "/src/core/renderer/WaterSurface.ts");
					const loader = new GLTFLoader();
					const rows = [];
					for (const kind of ["building", "scene"]) {
						const manifest = await (
							await fetch(assetOrigin + "/mine-monopoly/china24-q/" + kind + "-models-3d.json")
						).json();
						for (const descriptor of manifest.models) {
							const response = await fetch(new URL(descriptor.file, assetOrigin + "/"));
							if (!response.ok) throw new Error(descriptor.id + " asset HTTP " + response.status);
							const buffer = await response.arrayBuffer();
							const gltf = await loader.parseAsync(buffer, "");
							const model = gltf.scene;
							const water = descriptor.id === "sea-water-base";
							let meshes = 0;
							let spriteMarkers = 0;
							let volumeMarkers = 0;
							let firstMesh;
							model.traverse((object) => {
								if (object.isMesh) {
									meshes++;
									firstMesh ??= object;
								}
								if (object.userData.china24SceneSprite === true) spriteMarkers++;
								if (object.userData.china24Volumetric === true) volumeMarkers++;
							});
							const sprites =
								kind === "building"
									? preparePropertyBuildingModel(model).sprites
									: prepareSceneDecoration(model, descriptor.widthInRouteTiles, true);
							const before = firstMesh.getWorldQuaternion(new THREE.Quaternion());
							const camera = new THREE.PerspectiveCamera();
							camera.rotation.set(-0.6, 1.7, 0);
							updateSceneDecorationBillboards(sprites, camera);
							const orbitDifference = before.angleTo(firstMesh.getWorldQuaternion(new THREE.Quaternion()));
							const box = new THREE.Box3().setFromObject(model);
							const size = box.getSize(new THREE.Vector3());
							const target = new THREE.Box3().setFromObject(firstMesh).getCenter(new THREE.Vector3());
							const raycaster = new THREE.Raycaster(
								target.clone().add(new THREE.Vector3(0, 0, 10)),
								new THREE.Vector3(0, 0, -1),
							);
							const hits = raycaster.intersectObject(model, true).length;
							let shaderWater = false;
							if (water) {
								const effect = new WaterSurfaceEffect();
								effect.prepare(model);
								model.traverse((object) => {
									if (object.isMesh && object.userData.china24WaterSurface === true)
										shaderWater = object.material.isShaderMaterial;
								});
								effect.dispose();
							}
							rows.push({
								id: descriptor.id,
								kind,
								water,
								meshes,
								spriteMarkers,
								volumeMarkers,
								spriteCount: sprites.length,
								orbitDifference,
								size: size.toArray(),
								hits,
								castShadow: firstMesh.castShadow,
								receiveShadow: firstMesh.receiveShadow,
								shaderWater,
							});
						}
					}
					return rows;
				},
				{ clientOrigin, assetOrigin },
			);
			assert.equal(errors.length, 0, errors.join("\n"));
			assert.deepEqual(foreign, []);
			assert.equal(result.length, 19);
			for (const row of result) {
				assert.ok(row.meshes > 0, row.id);
				assert.ok(row.volumeMarkers > 0, row.id);
				assert.equal(row.spriteMarkers, 0, row.id);
				assert.equal(row.spriteCount, 0, row.id);
				assert.ok(row.orbitDifference < 1e-7, row.id);
				assert.ok(row.size[0] > 0.05 && row.size[2] > 0.05, row.id);
				if (row.kind === "building") assert.ok(row.hits > 0, row.id + " must remain interactive");
				else {
					assert.equal(row.hits, 0, row.id);
					assert.equal(row.castShadow, !row.water, row.id);
					assert.equal(row.receiveShadow, !row.water, row.id);
				}
				if (row.water) assert.equal(row.shaderWater, true);
				else assert.ok(row.size[1] > 0.04, row.id);
			}
		} finally {
			await browser.close();
		}
	},
);
