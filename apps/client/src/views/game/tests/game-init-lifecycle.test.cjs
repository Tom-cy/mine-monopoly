const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const source = fs.readFileSync(path.join(clientRoot, "src/views/game/game.vue"), "utf8");
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
const compiled = ts.transpileModule(script, {
	reportDiagnostics: true,
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
});
assert.equal(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
	let resolve, reject;
	const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
	return { promise, resolve, reject };
}

// 执行游戏页的完整生产脚本；仅替换渲染器、Pinia、路由和弹窗边界，控制异步完成顺序。
function fixture({ spectator = false, local = false } = {}) {
	const rendering = deferred();
	const hooks = {};
	const calls = { ready: [], failed: [], loading: [], logs: [], errors: [], dialogs: [], routes: [], sounds: [], renderer: [], resume: 0, pause: 0, destroyedClient: 0, destroyedRenderer: 0 };
	const room = { roomId: "room-1", roomSessionId: "room-session-1", amISpectator: spectator };
	const localParty = { isActive: local };
	const map = { $state: { id: "map-1" }, info: { name: "测试地图" }, mapItems: [{ id: "tile", mapEventId: "event" }], getUITempolateById() {} };
	const route = { value: { name: "game" } };
	const listeners = new Map();
	const eventBus = {
		on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); },
		remove(name, fn) { listeners.get(name)?.delete(fn); },
		emit(name, ...args) { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); },
	};
	const client = {
		initSessionId: "init-1",
		getGameInitSessionId() { return this.initSessionId; },
		sendLoadingStarted() {},
		pauseHeartBeat() { calls.pause++; },
		resumeHeartBeat() { calls.resume++; },
		gameInitFinished() { calls.ready.push(this.initSessionId); return Promise.resolve(); },
		gameInitFailed(reason) { calls.failed.push({ session: this.initSessionId, reason }); fixtureState.onFailed?.(); return Promise.resolve(); },
	};
	let activeClient = client;
	let unmounted = false;
	const fixtureState = {
		calls, rendering, client, room, localParty, eventBus, listeners, route,
		setClient(value) { activeClient = value; },
		getClient() { return activeClient; },
		mount() { return hooks.mounted(); },
		navigate(name) {
			route.value.name = name;
			if (name !== "game" && !unmounted) { unmounted = true; hooks.unmount(); }
		},
	};
	const dependencies = {
		vue: {
			onMounted(fn) { hooks.mounted = fn; }, onBeforeUnmount(fn) { hooks.unmount = fn; },
			computed(input) { return { get value() { return typeof input === "function" ? input() : input.get(); } }; },
			ref(value) { return { value }; }, h(tag, props, children) { return { tag, props, children }; },
		},
		"@src/store": {
			useRoomInfo: () => room, useUtil: () => ({}),
			useLoading: () => ({ showLoading(text) { calls.loading.push(text); }, hideLoading() { calls.loading.push("hide"); } }),
		},
		"@src/store/game": { useMapData: () => map, useGameData: () => ({ $state: {} }) },
		"@src/store/local-party": { useLocalParty: () => localParty, getCurrentClientPlayerId: () => "player-1" },
		"@src/router/index": {
			currentRoute: route,
			replace({ name }) { calls.routes.push(name); fixtureState.navigate(name); return Promise.resolve(); },
		},
		"@src/core/monopoly-client/MonopolyClient": {
			MonopolyClient: { getInstance: () => activeClient }, useMonopolyClient: () => activeClient,
			destoryMonopolyClient() { calls.destroyedClient++; activeClient = null; return Promise.resolve(); },
		},
		"@src/core/renderer/GameRenderer": {
			GameRenderer: class {
				init() { return rendering.promise; }
				destroy() { calls.destroyedRenderer++; }
				addEventIcon(...args) { calls.renderer.push(["add", ...args]); }
				setMapItemEventUserData(...args) { calls.renderer.push(["data", ...args]); }
				removeEventIcon(...args) { calls.renderer.push(["remove", ...args]); }
			},
		},
		"@src/utils/event-bus": () => eventBus,
		"@src/utils/audio/AudioManager": { useAudioManager: () => ({ playSound(name) { calls.sounds.push(name); } }) },
		"@src/utils/audio/types": { SoundName: { GAIN_MONEY: "gain", LOSE_MONEY: "lose" } },
		"@src/components/utils/fp-message-box": {
			FPMessageBox(options) { const dialog = deferred(); calls.dialogs.push({ options, ...dialog }); return dialog.promise; },
		},
		"@src/utils/game-init-diagnostics": {
			buildGameInitDiagnostics(error) { return { errorCode: "GI-MAP-DATA", rawMessage: error.message, logMessage: error.message, lines: [error.message] }; },
			wrapGameInitError(stage, error) { return error; },
		},
		"@src/utils/log": { ErrorCategory: { UI_RENDER: "UI_RENDER" }, logErrorWithOptions(value) { calls.logs.push(value); } },
	};
	vm.runInNewContext(compiled.outputText, {
		exports: {},
		console: { error(...args) { calls.errors.push(args); } },
		window: { location: { pathname: "/game" } },
		document: { getElementById: () => ({}), getElementsByClassName: () => [{}] },
		require(name) {
			if (name in dependencies) return dependencies[name];
			if (name.endsWith(".vue") || name === "@fortawesome/vue-fontawesome" || name === "@src/components/collapsible-panel") return {};
			throw new Error("Unexpected dependency: " + name);
		},
	}, { filename: "src/views/game/game.vue" });
	return fixtureState;
}

test("初始化成功及已完成渲染后的重连分别确认当前会话，页面监听只注册一次", async () => {
	const f = fixture();
	const mounting = f.mount();
	f.rendering.resolve();
	await mounting;
	assert.deepEqual(f.calls.ready, ["init-1"]);
	assert.equal(f.calls.resume, 1);
	assert.equal(f.calls.failed.length, 0);
	f.client.initSessionId = "init-2";
	f.eventBus.emit("game:init", "init-2");
	await flush();
	assert.deepEqual(f.calls.ready, ["init-1", "init-2"]);
	assert.equal(f.listeners.get("player-money").size, 1);
	f.eventBus.emit("player-money", "player-1", 100, 200);
	f.eventBus.emit("map-event-changed", { action: "link", mapItemId: "tile", mapEvent: { id: "event" } });
	assert.deepEqual(f.calls.sounds, ["gain"]);
	assert.equal(f.calls.renderer.length, 2);
	f.navigate("room");
	assert.equal(f.calls.destroyedClient, 0);
	assert.equal(f.getClient(), f.client);
	assert.equal(f.listeners.get("game:init").size, 0);
	assert.equal(f.listeners.get("player-money").size, 0);
	f.eventBus.emit("game:init", "init-3");
	await flush();
	assert.deepEqual(f.calls.ready, ["init-1", "init-2"]);
});

test("旁观者渲染成功及重连均不进入玩家初始化屏障", async () => {
	const f = fixture({ spectator: true });
	const mounting = f.mount();
	f.rendering.resolve();
	await mounting;
	f.client.initSessionId = "init-2";
	f.eventBus.emit("game:init", "init-2");
	await flush();
	assert.deepEqual(f.calls.ready, []);
	assert.deepEqual(f.calls.failed, []);
	assert.equal(f.calls.loading.at(-1), "hide");
});

test("渲染失败保留原始诊断，确认后返回有效房间并保留客户端", async () => {
	const f = fixture({ local: true });
	const mounting = f.mount();
	f.rendering.reject(new Error("模型解析失败"));
	await flush();
	assert.deepEqual(f.calls.failed, [{ session: "init-1", reason: "模型解析失败" }]);
	assert.equal(f.calls.logs[0].message, "模型解析失败");
	assert.equal(f.calls.errors[0][0], "[GameInitFailure]");
	assert.equal(f.calls.dialogs[0].options.confirmText, "返回房间");
	assert.deepEqual(f.calls.routes, []);
	f.calls.dialogs[0].resolve();
	await mounting;
	assert.deepEqual(f.calls.routes, ["room"]);
	assert.equal(f.calls.destroyedClient, 0);
	assert.equal(f.getClient(), f.client);
});

for (const outcome of ["resolve", "reject"]) {
	test(`主机已中止返回房间时，迟到渲染 ${outcome} 不再发送结果或导航，并恢复心跳`, async () => {
		const f = fixture();
		const mounting = f.mount();
		f.navigate("room");
		if (outcome === "resolve") f.rendering.resolve(); else f.rendering.reject(new Error("迟到模型错误"));
		await mounting;
		assert.deepEqual(f.calls.ready, []);
		assert.deepEqual(f.calls.failed, []);
		assert.deepEqual(f.calls.routes, []);
		assert.equal(f.calls.dialogs.length, 0);
		assert.equal(f.calls.resume, 1);
		assert.equal(f.calls.destroyedRenderer, 1);
		assert.equal(f.calls.destroyedClient, 0);
	});
}

test("发送失败后主机先返回房间，关闭旧诊断弹窗不会跳回大厅", async () => {
	const f = fixture();
	f.onFailed = () => f.navigate("room");
	const mounting = f.mount();
	f.rendering.reject(new Error("纹理读取失败"));
	await flush();
	f.calls.dialogs[0].resolve();
	await mounting;
	assert.equal(f.route.value.name, "room");
	assert.deepEqual(f.calls.routes, []);
	assert.equal(f.calls.logs[0].message, "纹理读取失败");
	assert.equal(f.calls.destroyedClient, 0);
});

test("渲染尚未结束时收到新初始化，仅向最新会话确认一次", async () => {
	const f = fixture();
	const mounting = f.mount();
	f.client.initSessionId = "init-2";
	f.eventBus.emit("game:init", "init-2");
	f.rendering.resolve();
	await mounting;
	await flush();
	assert.deepEqual(f.calls.ready, ["init-2"]);
	assert.equal(f.listeners.get("player-money").size, 1);
});

test("新初始化期间关闭旧失败弹窗不能导航，新会话仍保留", async () => {
	const f = fixture();
	const mounting = f.mount();
	f.rendering.reject(new Error("旧初始化失败"));
	await flush();
	f.client.initSessionId = "init-2";
	f.calls.dialogs[0].resolve();
	await mounting;
	assert.deepEqual(f.calls.routes, []);
	assert.equal(f.route.value.name, "game");
	assert.equal(f.calls.failed.length, 1);
});

for (const invalidation of ["client", "room", "session", "local-mode", "init-session"]) {
	test(`${invalidation} 已变化时旧渲染完成不操作当前会话`, async () => {
		const f = fixture();
		const mounting = f.mount();
		if (invalidation === "client") f.setClient({ id: "replacement" });
		if (invalidation === "room") f.room.roomId = "";
		if (invalidation === "session") f.room.roomSessionId = "room-session-2";
		if (invalidation === "local-mode") f.localParty.isActive = true;
		if (invalidation === "init-session") f.client.initSessionId = "init-2";
		f.rendering.resolve();
		await mounting;
		assert.deepEqual(f.calls.ready, []);
		assert.deepEqual(f.calls.failed, []);
		assert.deepEqual(f.calls.routes, []);
		assert.equal(f.calls.dialogs.length, 0);
		assert.equal(f.calls.resume, 0);
	});
}

test("离开页面不会销毁已经替换的客户端", async () => {
	const f = fixture();
	const mounting = f.mount();
	const replacement = { id: "replacement" };
	f.setClient(replacement);
	f.navigate("room-router");
	f.rendering.reject(new Error("迟到失败"));
	await mounting;
	assert.equal(f.calls.destroyedClient, 0);
	assert.equal(f.calls.resume, 0);
	assert.equal(f.getClient(), replacement);
	assert.deepEqual(f.calls.failed, []);
});
