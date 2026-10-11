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

function fixture(mobile = false) {
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
	const deps = {
		three: { ...THREE, WebGLRenderer },
		gsap: { __esModule: true, default: { killTweensOf() {} } },
		"three/examples/jsm/controls/OrbitControls": { OrbitControls: Controls },
		"three/examples/jsm/renderers/CSS2DRenderer": { CSS2DObject, CSS2DRenderer },
		"three/examples/jsm/postprocessing/EffectComposer": { EffectComposer: Composer },
		"three/examples/jsm/postprocessing/RenderPass": { RenderPass: Pass },
		"three/examples/jsm/postprocessing/OutlinePass": { OutlinePass: Pass },
		"three/examples/jsm/postprocessing/ShaderPass": { ShaderPass: Pass },
		"@src/store": { useLoading: () => ({}), useSettig: () => setting, useUtil: () => ({}) },
		"@src/store/game": { useMapData: () => ({}), useGameData: () => ({ players: [], properties: [] }) },
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
	const renderer = new GameRenderer(canvas, container, {});
	// 运行真实初始化/销毁控制流程；仅跳过 GPU 模型下载及具体画面内容。
	for (const method of ["initDiceManager", "initMap", "initBackground", "initPlayer", "initChanceCard", "initMapPathChoiceArrowModel", "initLight", "initOutlinePass", "focusMe", "handlePropertyRaycaster", "handleMapEventRaycaster", "updateActiveSpeechBubbleLayout"])
		renderer[method] = () => undefined;
	return { renderer, eventBus, listeners, timeouts, rafs, apps, graphics, container };
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
