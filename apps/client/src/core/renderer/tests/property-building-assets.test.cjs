const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));

// Opt-in integration: uses existing local Vite services, never installs dependencies or writes map records.
test(
	"the six published building GLBs load through the client renderer and ignore transparent picking regions",
	{
		skip: !process.env.MM_BUILDING_ASSET_ORIGIN,
		timeout: 60000,
	},
	async () => {
		const assetOrigin = process.env.MM_BUILDING_ASSET_ORIGIN;
		const clientOrigin = process.env.MM_BUILDING_CLIENT_ORIGIN || "http://localhost:5173";
		const { chromium } = require(
			require.resolve("playwright-core", {
				paths: [clientRoot, process.env.MM_PLAYWRIGHT_ROOT || path.resolve(clientRoot, "../../../game-admin")],
			}),
		);
		const sources = {};
		for (const name of ["PropertyBuildingVisual", "SceneDecoration"]) {
			sources[name] = ts.transpileModule(
				fs.readFileSync(path.resolve(clientRoot, "src/core/renderer/" + name + ".ts"), "utf8"),
				{
					compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
				},
			).outputText;
		}
		const browser = await chromium.launch({
			executablePath: process.env.MINE_EDITOR_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
			headless: true,
		});
		try {
			const page = await browser.newPage();
			const pageErrors = [];
			page.on("pageerror", (error) => pageErrors.push(error.message));
			await page.route("**/*", async (route) => {
				const url = route.request().url();
				if (/\/(?:monopoly-api|system-api|game-api)\//.test(url)) return route.abort();
				if (url === clientOrigin + "/__building-assets-test.html")
					return route.fulfill({
						contentType: "text/html",
						body: "<!doctype html><html><body>Building asset compatibility test</body></html>",
					});
				if (url.startsWith(assetOrigin + "/mine-monopoly/china24-q/")) {
					const response = await route.fetch();
					return route.fulfill({ response, headers: { ...response.headers(), "access-control-allow-origin": "*" } });
				}
				return route.continue();
			});
			await page.goto(clientOrigin + "/__building-assets-test.html");
			const result = await page.evaluate(
				async ({ sources, clientOrigin, assetOrigin }) => {
					const rendererSource = await (await fetch(clientOrigin + "/src/utils/file/game-map.ts")).text();
					const helperSource = await (
						await fetch(clientOrigin + "/src/core/renderer/PropertyBuildingVisual.ts")
					).text();
					const loaderPath = rendererSource.match(/from\s+["']([^"']*GLTFLoader[^"']*)["']/)?.[1];
					const threePath = helperSource.match(/from\s+["']([^"']*three\.js[^"']*)["']/)?.[1];
					if (!loaderPath || !threePath)
						throw new Error("Vite did not expose the client's GLTFLoader/Three module bindings");
					const loaderUrl = new URL(loaderPath, clientOrigin).href;
					const threeUrl = new URL(threePath, clientOrigin).href;
					const THREE = await import(threeUrl);
					const { GLTFLoader } = await import(loaderUrl);
					async function moduleFromSource(source) {
						const url = URL.createObjectURL(
							new Blob([source.replaceAll('from "three"', 'from "' + threeUrl + '"')], { type: "text/javascript" }),
						);
						try {
							return await import(url);
						} finally {
							URL.revokeObjectURL(url);
						}
					}
					const { preparePropertyBuildingModel, resolvePropertyBuildingModelId, usesLatestPropertySpriteGround } =
						await moduleFromSource(sources.PropertyBuildingVisual);
					const { updateSceneDecorationBillboards } = await moduleFromSource(sources.SceneDecoration);
					const manifest = await (await fetch(assetOrigin + "/mine-monopoly/china24-q/building-models.json")).json();
					if (manifest.models.length !== 6 || manifest.collection !== "china24-property-models-v1")
						throw new Error("Invalid live building model manifest");
					const loader = new GLTFLoader();
					const records = [];
					const loadedModels = new Map();
					function rayAtUv(mesh, uv) {
						const position = mesh.geometry.getAttribute("position");
						const texcoord = mesh.geometry.getAttribute("uv");
						const indices = mesh.geometry.index;
						for (let triangle = 0; triangle < (indices?.count || position.count); triangle += 3) {
							const ids = [0, 1, 2].map((offset) => (indices ? indices.getX(triangle + offset) : triangle + offset));
							const [a, b, c] = ids.map((index) => new THREE.Vector2().fromBufferAttribute(texcoord, index));
							const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
							const weights = [
								((b.y - c.y) * (uv.x - c.x) + (c.x - b.x) * (uv.y - c.y)) / denominator,
								((c.y - a.y) * (uv.x - c.x) + (a.x - c.x) * (uv.y - c.y)) / denominator,
							];
							weights.push(1 - weights[0] - weights[1]);
							if (weights.some((weight) => weight < -1e-6)) continue;
							const localPoint = new THREE.Vector3();
							ids.forEach((index, offset) =>
								localPoint.addScaledVector(new THREE.Vector3().fromBufferAttribute(position, index), weights[offset]),
							);
							const worldPoint = mesh.localToWorld(localPoint);
							const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(
								mesh.getWorldQuaternion(new THREE.Quaternion()),
							);
							return new THREE.Raycaster(worldPoint.clone().addScaledVector(normal, 10), normal.clone().negate());
						}
						throw new Error("Could not map pixel UV to live mesh geometry");
					}
					for (const asset of manifest.models) {
						const bytes = await (await fetch(assetOrigin + "/" + asset.file)).arrayBuffer();
						const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
							byte.toString(16).padStart(2, "0"),
						).join("");
						if (bytes.byteLength !== asset.bytes || digest !== asset.sha256)
							throw new Error("Live GLB integrity mismatch: " + asset.id);
						const gltf = await loader.parseAsync(bytes, assetOrigin + "/");
						loadedModels.set(asset.id, gltf.scene);
						const model = gltf.scene.clone(true);
						model.userData.isProperty = true;
						let marker;
						model.traverse((object) => {
							if (object.userData.china24PropertyBuilding === true) marker = object;
						});
						if (
							marker?.userData.collection !== manifest.collection ||
							marker.userData.visualLevel !== asset.visualLevel ||
							marker.userData.targetWidthInRouteTiles !== 0.9
						)
							throw new Error("Live GLB root metadata mismatch: " + asset.id);
						const prepared = preparePropertyBuildingModel(model);
						if (!prepared || prepared.width !== 0.9 || prepared.sprites.length !== 1)
							throw new Error("Live GLB sprite marker/width mismatch: " + asset.id);
						model.scale.setScalar(prepared.width);
						const nestedWorld = new THREE.Group();
						nestedWorld.rotation.set(0.2, 0.5, 0.1);
						nestedWorld.add(model);
						const camera = new THREE.PerspectiveCamera();
						camera.rotation.set(-0.7, -0.3, 0);
						const mesh = prepared.sprites[0];
						const pivot = mesh.localToWorld(new THREE.Vector3());
						updateSceneDecorationBillboards(prepared.sprites, camera);
						if (mesh.userData.sceneDecoration !== undefined || model.userData.sceneDecoration !== undefined)
							throw new Error("Property became a noninteractive decoration");
						if (
							mesh
								.getWorldQuaternion(new THREE.Quaternion())
								.angleTo(camera.getWorldQuaternion(new THREE.Quaternion())) > 1e-7 ||
							pivot.distanceTo(mesh.localToWorld(new THREE.Vector3())) > 1e-7
						)
							throw new Error("Live nested billboard orientation/pivot mismatch");
						const texture = mesh.material.map;
						const canvas = document.createElement("canvas");
						canvas.width = texture.image.width;
						canvas.height = texture.image.height;
						const context = canvas.getContext("2d", { willReadFrequently: true });
						context.drawImage(texture.image, 0, 0);
						const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
						let transparent, opaque;
						for (let y = 0; y < canvas.height && (!transparent || !opaque); y++)
							for (let x = 0; x < canvas.width && (!transparent || !opaque); x++) {
								const alpha = rgba[(y * canvas.width + x) * 4 + 3];
								if (!transparent && alpha === 0) transparent = [x, y];
								if (!opaque && alpha === 255) opaque = [x, y];
							}
						function pixelUv(pixel) {
							return new THREE.Vector2(
								(pixel[0] + 0.5) / canvas.width,
								texture.flipY ? 1 - (pixel[1] + 0.5) / canvas.height : (pixel[1] + 0.5) / canvas.height,
							);
						}
						const transparentRay = rayAtUv(mesh, pixelUv(transparent));
						const opaqueRay = rayAtUv(mesh, pixelUv(opaque));
						const baseline = [];
						THREE.Mesh.prototype.raycast.call(mesh, transparentRay, baseline);
						mesh.geometry.computeBoundingBox();
						const canvasWidth = mesh.geometry.boundingBox.max.x - mesh.geometry.boundingBox.min.x;
						const solidWidth =
							((canvasWidth * asset.scaleCalibration.solidWidthPx) / asset.scaleCalibration.canvasSizePx.width) *
							prepared.width;
						records.push({
							id: asset.id,
							visualLevel: asset.visualLevel,
							width: prepared.width,
							solidWidth,
							transparentBaselineHits: baseline.length,
							transparentHits: transparentRay.intersectObject(mesh).length,
							opaqueHits: opaqueRay.intersectObject(mesh).length,
							alphaTest: mesh.material.alphaTest,
							billboard: true,
						});
					}
					const modelIds = manifest.models.map((asset) => asset.id);
					const map = {
						buildingVisual: { version: 1, collection: manifest.collection, unownedModelId: modelIds[0] },
						buildingModelIdList: modelIds.slice(1),
					};
					const business = {
						id: "city",
						level: 0,
						maxLevel: 3,
						costList: [10, 20, 30, 40],
						sellCost: 1000,
						buildCost: 100,
					};
					const before = JSON.stringify(business);
					const selected = [
						resolvePropertyBuildingModelId(business, map),
						...Array.from({ length: 5 }, (_, level) =>
							resolvePropertyBuildingModelId({ ...business, owner: {}, level }, map),
						),
						resolvePropertyBuildingModelId(business, map),
					];
					const latestGround = usesLatestPropertySpriteGround(business, map, (id) => loadedModels.get(id));
					loadedModels.set("custom3d", new THREE.Group());
					const customGround = usesLatestPropertySpriteGround(
						{ ...business, buildingModelIdList: ["custom3d"] },
						map,
						(id) => loadedModels.get(id),
					);
					const legacyGround = usesLatestPropertySpriteGround(
						business,
						{ buildingModelIdList: map.buildingModelIdList },
						(id) => loadedModels.get(id),
					);
					return {
						records,
						selected,
						latestGround,
						customGround,
						legacyGround,
						businessUnchanged: before === JSON.stringify(business),
					};
				},
				{ sources, clientOrigin, assetOrigin },
			);
			assert.deepEqual(pageErrors, []);
			assert.equal(result.records.length, 6);
			for (const record of result.records) {
				assert.ok(Math.abs(record.solidWidth - 0.9) < 1e-6, record.id + " silhouette width");
				assert.ok(record.transparentBaselineHits > 0, record.id + " baseline proves geometric transparency picking");
				assert.equal(record.transparentHits, 0, record.id + " transparent pixel must be excluded");
				assert.ok(record.opaqueHits > 0, record.id + " opaque pixel remains interactive");
			}
			assert.deepEqual(result.selected, [
				result.records[0].id,
				...result.records.slice(1).map((record) => record.id),
				result.records[0].id,
			]);
			assert.equal(result.businessUnchanged, true);
			assert.equal(result.latestGround, true);
			assert.equal(result.customGround, false);
			assert.equal(result.legacyGround, false);
		} finally {
			await browser.close();
		}
	},
);
