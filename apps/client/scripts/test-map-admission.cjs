const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { webcrypto } = require("node:crypto");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../../..")] }));
const clientRoot = path.resolve(__dirname, "..");
function load(file, dependencies = {}, environment = {}) {
	const source = fs.readFileSync(path.join(clientRoot, file), "utf8").replace(/import\.meta\.env/g, "({})");
	const result = ts.transpileModule(source, {
		reportDiagnostics: true,
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	assert.equal(result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
	const module = { exports: {} };
	vm.runInNewContext(
		result.outputText,
		{
			module,
			exports: module.exports,
			crypto: webcrypto,
			console,
			TextEncoder,
			TextDecoder,
			AbortController,
			ArrayBuffer,
			Uint8Array,
			Blob,
			Error,
			setTimeout,
			clearTimeout,
			__COMPATIBLE_VERSION__: "1.3",
			...environment,
			require(name) {
				if (!(name in dependencies)) throw new Error("Unexpected dependency: " + name);
				return dependencies[name];
			},
		},
		{ filename: file },
	);
	return module.exports;
}
const types = {
	...load("../../packages/types/enums/game/base.ts"),
	...load("../../packages/types/enums/game/game-process.ts"),
};
const { SocketMsgType, SocketMsgSource, OperateType } = types;
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() > deadline) assert.fail("Async map operation did not settle within one second");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
function deferred() {
	let resolve, reject;
	const promise = new Promise((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}
function timers() {
	let id = 0;
	const pending = new Map();
	return {
		pending,
		setTimeout(fn, ms) {
			pending.set(++id, { fn, ms });
			return id;
		},
		clearTimeout(key) {
			pending.delete(key);
		},
		fire(ms) {
			for (const [key, item] of [...pending])
				if (item.ms === ms) {
					pending.delete(key);
					item.fn();
				}
		},
	};
}
function roomFixture(mapInfo = { from: "server", data: "map-1" }) {
	const clock = timers();
	const { OperateListener } = load(
		"src/core/worker/class/OperateListener.ts",
		{ "@mine-monopoly/types": types },
		clock,
	);
	const waits = load("src/core/monopoly-host/admission-wait.ts", {}, clock);
	const dependencies = {
		"@mine-monopoly/types": types,
		"@src/enums/worker": { WorkerState: { Uninitialized: "uninitialized" } },
		"@src/store": { useSettig: () => ({ aiDecisionConfig: {} }) },
		"@src/utils": {},
		"@src/utils/api/map": {},
		"@src/core/ai/remote-usage-stats": {},
		"@src/core/worker/GameProcessWorker?worker": class {},
		"@src/utils/file/game-map": {},
		"@src/utils/file/map-loading": { MAP_LOAD_TIMEOUT_MS: 420_000 },
		"./admission-wait": waits,
		"@src/store/game": {},
		"@mine-monopoly/ui": {},
		"@src/utils/log": {},
		"../worker/class/OperateListener": { OperateListener },
		"@mine-monopoly/utils": { base64ToArrayBuffer: () => new ArrayBuffer(0) },
		"@src/core/save": { SaveManager: class {} },
		"@src/core/ai/OpenAICompatibleDecisionProvider": {},
		"@src/core/ai/ai-decision-config": { normalizeAIDecisionConfig: (value) => value },
	};
	const { Room } = load("src/core/monopoly-host/Room.ts", dependencies, { ...clock, window: clock });
	const room = new Room("room-1", { ownerId: "user-1" });
	room.mapInfo = mapInfo;
	room.roomBroadcast = () => {};
	room.roomInfoBroadcast = () => {};
	room.messages = [];
	room.sendToClient = (conn, type, data, msg) => {
		room.messages.push({ type, data, msg });
		conn.receive?.(type, data, msg);
	};
	const user = { userId: "user-1", username: "Player" };
	const conn = { open: true, send() {} };
	return { room, user, conn, clock };
}
test("join listens before publishing a map even with a synchronous response", async () => {
	const { room, user, conn, clock } = roomFixture();
	conn.receive = (type) => {
		if (type === SocketMsgType.ChangeMap) room.handleMapResourceLoaded(user.userId);
	};
	assert.equal(await room.join(user, conn), true);
	assert.equal(clock.pending.size, 0);
	assert.equal(room.operationListener.hasListener(user.userId, OperateType.MapResourceLoaded), false);
});
test("a failed map response cannot finish admission and releases the host seat", async () => {
	const { room, user, conn, clock } = roomFixture();
	conn.receive = (type) => {
		if (type === SocketMsgType.ChangeMap)
			room.handleMapResourceLoaded(user.userId, undefined, { initStatus: "failed", reason: "bad map" });
	};
	assert.equal(await room.join(user, conn), false);
	assert.equal(room.getUserList().length, 0);
	assert.equal(room.messages.find((message) => message.type === SocketMsgType.LeaveRoom).msg.content, "bad map");
	assert.equal(clock.pending.size, 0);
});
test("leaving during loading settles admission without a hanging listener", async () => {
	const { room, user, conn, clock } = roomFixture();
	const admission = room.join(user, conn);
	room.leave(user.userId);
	assert.equal(await admission, false);
	assert.equal(room.pendingAdmissions.size, 0);
	assert.equal(clock.pending.size, 0);
});
test("admission timeout removes only its own listener and seat", async () => {
	const { room, user, conn, clock } = roomFixture();
	const admission = room.join(user, conn);
	clock.fire(420_000);
	assert.equal(await admission, false);
	assert.equal(room.getUserList().length, 0);
	assert.equal(room.operationListener.hasListener(user.userId, OperateType.MapResourceLoaded), false);
});
test("room destruction cancels pending admission immediately", async () => {
	const { room, user, conn, clock } = roomFixture();
	const admission = room.join(user, conn);
	room.destory();
	assert.equal(await admission, false);
	assert.equal(clock.pending.size, 0);
});
test("custom-map confirmation is registered before its synchronous answer", async () => {
	const { room, user, conn, clock } = roomFixture({ from: "custom", data: new Uint8Array([1]) });
	conn.receive = (type) => {
		if (type === SocketMsgType.ConfirmDialog)
			room.emitOperation(user.userId, OperateType.ConfirmDialogResult, { confirm: true });
		if (type === SocketMsgType.MapChunkEnd) room.handleMapResourceLoaded(user.userId);
	};
	assert.equal(await room.join(user, conn), true);
	assert.equal(clock.pending.size, 0);
});
test("a custom-map refusal leaves without publishing map bytes", async () => {
	const { room, user, conn } = roomFixture({ from: "custom", data: new Uint8Array([1]) });
	conn.receive = (type) => {
		if (type === SocketMsgType.ConfirmDialog)
			room.emitOperation(user.userId, OperateType.ConfirmDialogResult, { confirm: false });
	};
	assert.equal(await room.join(user, conn), false);
	assert.equal(
		room.messages.some((message) => message.type === SocketMsgType.MapChunkStart),
		false,
	);
});
test("failed reconnection does not reactivate an offline participant", async () => {
	const { room, user, conn } = roomFixture();
	room.userList.set(user.userId, { ...user, socketClient: conn, isOffLine: true });
	room.isStarted = true;
	conn.receive = (type) => {
		if (type === SocketMsgType.ChangeMap)
			room.handleMapResourceLoaded(user.userId, undefined, { initStatus: "failed", reason: "bad map" });
	};
	assert.equal(await room.handleUserReconnect(user.userId, conn, 2), false);
	assert.equal(room.getUserList()[0].isOffLine, true);
});
test("a replaced admission cannot remove or wake the new connection", async () => {
	const { room, user, conn } = roomFixture();
	const oldAdmission = room.join(user, conn);
	const next = {
		open: true,
		receive(type) {
			if (type === SocketMsgType.ChangeMap) room.handleMapResourceLoaded(user.userId);
		},
	};
	assert.equal(await room.handleUserReconnect(user.userId, next, 2), true);
	assert.equal(await oldAdmission, false);
	assert.equal(room.getUserList()[0].socketClient, next);
});
test("obsolete custom-map sessions and failed status cannot consume a ready wait", async () => {
	const descriptor = { mapLoadSessionId: "current-map" };
	const { room, user, conn } = roomFixture({ from: "custom", data: new Uint8Array([1]), descriptor });
	conn.receive = (type) => {
		if (type === SocketMsgType.ConfirmDialog)
			room.emitOperation(user.userId, OperateType.ConfirmDialogResult, { confirm: true });
		if (type === SocketMsgType.CustomMapDescriptor) {
			assert.equal(room.handleMapResourceLoaded(user.userId, "old-map"), false);
			assert.equal(
				room.handleMapResourceLoaded(user.userId, "current-map", { initStatus: "failed", reason: "bad map" }),
				false,
			);
		}
	};
	assert.equal(await room.join(user, conn), false);
});

function handlersFixture(options = {}) {
	const clock = timers();
	const calls = { sent: [], routes: [], toasts: [], closed: 0, resumed: 0, fileLoads: 0 };
	const resetStore = () => ({
		$reset() {
			this.resetCount = (this.resetCount || 0) + 1;
		},
	});
	const room = { ...resetStore(), roomId: "room-1", gameSetting: {}, amIRoomOwner: false };
	const resource = { ...resetStore(), clear() {}, getRecourceById: () => ({ url: "blob:fixture" }) };
	const client = {
		async sendMsg(message) {
			calls.sent.push(message);
			return { ok: true };
		},
		async destory() {
			calls.closed++;
		},
		resumeHeartBeat() {
			calls.resumed++;
		},
		changeRole() {},
		randomizeAIRoles() {},
		changeGameSetting() {},
	};
	const stores = {
		useRoomInfo: () => room,
		useChat: resetStore,
		useGameLog: resetStore,
		useLoading: () => ({ showLoading() {}, hideLoading() {}, updateProgress() {} }),
	};
	const success = {
		gameMap: { info: { editorVersion: "1.3.0" }, roles: [], gameSettingForm: [] },
		mapInfo: { id: "map-1", name: "Map", version: 1 },
	};
	const dependencies = {
		"./MonopolyClient": { useMonopolyClient: () => client },
		"@mine-monopoly/types": types,
		"@src/store": stores,
		"@src/utils": { debounce: (fn) => fn, formatBytes: String },
		"@mine-monopoly/ui": { FPMessage: (value) => calls.toasts.push(value) },
		"@src/components/utils/fp-message-box": {},
		"@src/router": { replace: async (route) => calls.routes.push(route) },
		"@src/utils/event-bus": {},
		vue: {},
		"@src/components/common/property-card.vue": {},
		"@src/store/game": { useMapData: resetStore, useGameData: resetStore, useResourceStore: () => resource },
		"@src/store/local-party": { useLocalParty: () => ({ isActive: !!options.local }) },
		"@src/utils/file/game-map": {
			loadGameMapFromServer:
				options.loadServer ||
				(async () => {
					throw new Error("wrong map key");
				}),
			loadGameMapFromFile: async (...args) => {
				calls.fileLoads++;
				return options.loadFile ? options.loadFile(...args) : success;
			},
		},
		"@src/utils/file/map-loading": load("src/utils/file/map-loading.ts", {}, clock),
		"@mine-monopoly/utils": { base64ToArrayBuffer: () => new ArrayBuffer(1) },
		"@src/components/common/target-seletor": {},
		"@src/components/utils/item-selector": {},
		"../../components/utils/fp-message-card/index": {},
		"@src/utils/log/error-helpers": { logErrorWithOptions() {} },
		"@src/utils/log/index": { ErrorCategory: {} },
		"@src/utils/audio/AudioManager": {},
		"@src/utils/audio/types": {},
	};
	const handlers = load("src/core/monopoly-client/host-message-handlers.ts", dependencies, {
		...clock,
		window: { ...clock, platformAPI: options.platform },
	});
	const receive = (type, data) =>
		handlers.handleServerSocketMessage({ type, data, source: SocketMsgSource.Server }, client);
	return { ...handlers, receive, client, calls, clock, success, room };
}
test("server-map failure reports failed status and closes online membership", async () => {
	const fixture = handlersFixture();
	fixture.receive(SocketMsgType.ChangeMap, { from: "server", data: "map-1" });
	await flush();
	assert.equal(fixture.calls.sent[0].extra.initStatus, "failed");
	assert.equal(fixture.calls.closed, 1);
	assert.equal(fixture.calls.routes[0].name, "room-router");
	assert.equal(fixture.calls.resumed, 0);
	assert.equal(fixture.clock.pending.size, 0);
});
test("local-map failure reports failure while keeping the local party available", async () => {
	const fixture = handlersFixture({ local: true });
	fixture.receive(SocketMsgType.ChangeMap, { from: "server", data: "map-1" });
	await flush();
	assert.equal(fixture.calls.sent[0].extra.initStatus, "failed");
	assert.equal(fixture.calls.closed, 0);
	assert.equal(fixture.calls.routes.length, 0);
});
test("cancelling a delayed map never acknowledges or alters room UI", async () => {
	const download = deferred();
	const fixture = handlersFixture({ loadServer: () => download.promise });
	fixture.receive(SocketMsgType.ChangeMap, { from: "server", data: "map-1" });
	fixture.cancelClientMapLoad(fixture.client);
	download.resolve(fixture.success);
	await flush();
	assert.equal(fixture.calls.sent.length, 0);
	assert.equal(fixture.calls.closed, 0);
	assert.equal(fixture.room.mapInfo, undefined);
});
test("a newer map load discards the preceding late completion", async () => {
	const previous = deferred();
	let loads = 0;
	const fixture = handlersFixture({
		loadServer: () => (++loads === 1 ? previous.promise : Promise.resolve(fixture.success)),
	});
	fixture.receive(SocketMsgType.ChangeMap, { from: "server", data: "old-map" });
	fixture.receive(SocketMsgType.ChangeMap, { from: "server", data: "map-1" });
	await flush();
	previous.resolve({ ...fixture.success, mapInfo: { id: "old-map", name: "Old", version: 0 } });
	await flush();
	assert.equal(fixture.room.mapInfo.id, "map-1");
	assert.equal(fixture.calls.sent.length, 1);
	fixture.cancelClientMapLoad();
});
test("a corrupt local cache falls back to the host before final failure", async () => {
	const bytes = new Uint8Array([1, 2, 3]);
	const digest = await webcrypto.subtle.digest("SHA-256", bytes);
	const sha = "sha256:" + Buffer.from(digest).toString("hex");
	let reads = 0;
	const fixture = handlersFixture({
		loadFile: async () => {
			if (++reads === 1) throw new Error("local cache broken");
			return fixture.success;
		},
		platform: { findLocalMapByHash: async () => ({ found: true, data: bytes.buffer, verifiedSha256: sha }) },
	});
	fixture.receive(SocketMsgType.CustomMapDescriptor, {
		mapLoadSessionId: "map-load-1",
		fileSha256: sha,
		fileSize: 3,
	});
	await flush();
	assert.equal(fixture.calls.closed, 0);
	assert.equal(
		fixture.calls.sent.some((message) => message.extra?.initStatus === "failed"),
		false,
	);
	assert.equal(
		fixture.calls.sent.some((message) => message.type === SocketMsgType.MapTransferRequest),
		true,
	);
	fixture.receive(SocketMsgType.MapChunkStart, { mapLoadSessionId: "map-load-1", totalChunks: 1, totalBytes: 3 });
	fixture.receive(SocketMsgType.MapChunk, { mapLoadSessionId: "map-load-1", chunkIndex: 0, data: bytes });
	fixture.receive(SocketMsgType.MapChunkEnd, { mapLoadSessionId: "map-load-1", success: true });
	await until(() => fixture.calls.sent.some((message) => message.type === SocketMsgType.Operation));
	assert.equal(fixture.calls.fileLoads, 2);
	assert.equal(fixture.calls.closed, 0);
	assert.equal(fixture.calls.sent.filter((message) => message.type === SocketMsgType.Operation).length, 1);
	fixture.cancelClientMapLoad();
});
test("a stalled custom transfer fails and releases online membership", async () => {
	const fixture = handlersFixture();
	fixture.receive(SocketMsgType.MapChunkStart, { totalChunks: 2, totalBytes: 6 });
	fixture.clock.fire(20_000);
	await flush();
	assert.equal(fixture.calls.closed, 1);
	assert.equal(fixture.calls.sent[0].extra.initStatus, "failed");
	assert.equal(fixture.clock.pending.size, 0);
});
test("a custom-file checksum failure does not acknowledge success", async () => {
	const fixture = handlersFixture();
	fixture.receive(SocketMsgType.CustomMapDescriptor, {
		mapLoadSessionId: "map-load-1",
		fileSha256: "sha256:" + "a".repeat(64),
		fileSize: 1,
	});
	fixture.receive(SocketMsgType.MapChunkStart, { mapLoadSessionId: "map-load-1", totalChunks: 1, totalBytes: 1 });
	fixture.receive(SocketMsgType.MapChunk, {
		mapLoadSessionId: "map-load-1",
		chunkIndex: 0,
		data: new Uint8Array([1]),
	});
	fixture.receive(SocketMsgType.MapChunkEnd, { mapLoadSessionId: "map-load-1", success: true });
	await until(() => fixture.calls.closed === 1);
	assert.equal(fixture.calls.closed, 1);
	assert.equal(fixture.calls.fileLoads, 0);
	assert.equal(
		fixture.calls.sent.find((message) => message.type === SocketMsgType.Operation).extra.initStatus,
		"failed",
	);
});
test("download cancellation and timeout abort the underlying fetch signal", async () => {
	const clock = timers();
	const helpers = load("src/utils/file/map-loading.ts", {}, clock);
	const parent = new AbortController();
	const wait = (signal) =>
		new Promise((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
		);
	const download = helpers.withMapDownloadSignal(parent.signal, wait);
	parent.abort(new Error("left room"));
	await assert.rejects(download, /left room/);
	assert.equal(clock.pending.size, 0);
	const timeout = helpers.withMapDownloadSignal(undefined, wait, 5);
	clock.fire(5);
	await assert.rejects(timeout, /下载超时/);
	assert.equal(clock.pending.size, 0);
	let started = false;
	await assert.rejects(
		helpers.withMapDownloadSignal(parent.signal, () => {
			started = true;
		}),
		/left room/,
	);
	assert.equal(started, false);
});

function mapFileFixture(options = {}) {
	const calls = { patched: 0, cleared: 0, revoked: [], created: 0 };
	const resourceMap = new Map([["previous", { id: "previous", url: "blob:previous" }]]);
	const gameMap = {
		id: "map-1",
		info: { name: "Map", editorVersion: "1.3.0", coverImageId: "cover" },
		startMapItemId: "start",
		mapItems: [{ id: "start", type: { id: "tile" } }],
		mapPaths: [],
		roles: [{ id: "role", name: "Player", imageId: "role-image" }],
		gameSettingForm: [],
		...options.map,
	};
	const data = {
		id: "map-1",
		jsonData: JSON.stringify(gameMap),
		modelFiles: [],
		imageFiles: ["cover", "role-image"].map((id) => ({
			id,
			name: id,
			filetype: "png",
			buffer: new Uint8Array([1]),
		})),
		...options.data,
	};
	const helpers = load("src/utils/file/map-loading.ts");
	const dependency = {
		"@mine-monopoly/utils": {
			normalizeGameMap: (value) => value,
			loadFromProto: options.read || (async () => data),
		},
		"@mine-monopoly/utils/crypto": { isProductFile: () => false },
		"@mine-monopoly/env": { env: () => "" },
		"@src/store": { useLoading: () => ({ showLoading() {}, hideLoading() {} }) },
		"../api/map": {},
		"@src/store/game": {
			useMapData: () => ({
				$patch() {
					calls.patched++;
				},
			}),
			useResourceStore: () => ({
				clear() {
					calls.cleared++;
					resourceMap.clear();
				},
				add(resource) {
					resourceMap.set(resource.id, resource);
				},
				getRecourceById(id) {
					return resourceMap.get(id);
				},
			}),
		},
		"@src/utils": {},
		"three/examples/jsm/loaders/GLTFLoader": {},
		"../draco/draco": {},
		"./map-loading": helpers,
	};
	const source = load("src/utils/file/game-map.ts", dependency, {
		URL: {
			createObjectURL() {
				calls.created++;
				if (options.failBlob === calls.created) throw new Error("blob creation failed");
				return "blob:created-" + calls.created;
			},
			revokeObjectURL(url) {
				calls.revoked.push(url);
			},
		},
	});
	return { ...source, calls, data, resourceMap };
}
test("incompatible maps are rejected before overwriting previous map resources", async () => {
	const fixture = mapFileFixture({ map: { info: { editorVersion: "9.0.0" } } });
	await assert.rejects(fixture.loadGameMapFromFile(new ArrayBuffer(1)), /版本不匹配/);
	assert.equal(fixture.calls.patched, 0);
	assert.equal(fixture.calls.cleared, 0);
	assert.equal(fixture.resourceMap.has("previous"), true);
});
test("missing role images are rejected before committing a local map", async () => {
	const fixture = mapFileFixture({ map: { roles: [{ id: "role", name: "Player", imageId: "missing" }] } });
	await assert.rejects(fixture.loadGameMapFromFile(new ArrayBuffer(1)), /缺少图片资源/);
	assert.equal(fixture.calls.patched, 0);
	assert.equal(fixture.calls.cleared, 0);
});
test("blob preparation failure preserves previous resources and revokes partial allocations", async () => {
	const fixture = mapFileFixture({ failBlob: 2 });
	await assert.rejects(fixture.loadGameMapFromFile(new ArrayBuffer(1)), /blob creation failed/);
	assert.equal(fixture.calls.patched, 0);
	assert.equal(fixture.calls.cleared, 0);
	assert.deepEqual(fixture.calls.revoked, ["blob:created-1"]);
	assert.equal(fixture.resourceMap.has("previous"), true);
});
test("cancelled protobuf parsing never commits its late result", async () => {
	const parsing = deferred();
	const fixture = mapFileFixture({ read: () => parsing.promise });
	const controller = new AbortController();
	const loadMap = fixture.loadGameMapFromFile(new ArrayBuffer(1), { signal: controller.signal });
	controller.abort(new Error("left room"));
	parsing.resolve(fixture.data);
	await assert.rejects(loadMap, /left room/);
	assert.equal(fixture.calls.patched, 0);
	assert.equal(fixture.calls.cleared, 0);
});
test("a valid legacy custom map commits resources once with its original IDs", async () => {
	const fixture = mapFileFixture();
	const result = await fixture.loadGameMapFromFile(new ArrayBuffer(1));
	assert.equal(result.mapInfo.id, "map-1");
	assert.equal(result.gameMap.roles[0].id, "role");
	assert.equal(fixture.calls.patched, 1);
	assert.equal(fixture.calls.cleared, 1);
	assert.equal(fixture.resourceMap.has("role-image"), true);
});

function localPartyFixture(options = {}) {
	const clock = timers();
	const calls = { randomized: 0, acknowledged: 0 };
	let session;
	class Room {
		async changeMap() {
			if (options.throwChange) throw new Error("map preparation failed");
			session.handleOperation("player", {
				data: { operateType: OperateType.MapResourceLoaded },
				extra: options.failed ? { initStatus: "failed", reason: "invalid local map" } : {},
			});
		}
		randomizeRolesForAllPlayers() {
			calls.randomized++;
		}
		handleMapResourceLoaded() {
			calls.acknowledged++;
		}
	}
	const { LocalPartySession } = load(
		"src/core/local-party/LocalPartySession.ts",
		{
			"@mine-monopoly/types": types,
			"@src/core/monopoly-host/Room": { Room },
			"@src/store/local-party": { useLocalParty: () => ({ $subscribe: () => () => {} }) },
			"@src/store": {},
			"@src/store/game": {},
			"@src/utils/file/map-loading": { MAP_LOAD_TIMEOUT_MS: 420_000 },
		},
		{ ...clock, window: clock },
	);
	session = new LocalPartySession("local-room", () => {});
	session.players.set("player", { userId: "player" });
	return { session, clock, calls };
}
test("local-party failed loading returns failure and never randomizes roles", async () => {
	const fixture = localPartyFixture({ failed: true });
	const result = await fixture.session.changeGameMap({ from: "custom", data: new Uint8Array([1]) });
	assert.equal(result.success, false);
	assert.equal(result.error, "invalid local map");
	assert.equal(fixture.calls.randomized, 0);
	assert.equal(fixture.calls.acknowledged, 0);
	assert.equal(fixture.clock.pending.size, 0);
});
test("local-party valid loading still completes and randomizes participant roles", async () => {
	const fixture = localPartyFixture();
	assert.equal((await fixture.session.changeGameMap({ from: "custom", data: new Uint8Array([1]) })).success, true);
	assert.equal(fixture.calls.randomized, 1);
	assert.equal(fixture.calls.acknowledged, 1);
	assert.equal(fixture.clock.pending.size, 0);
});
test("local-party preparation failure cancels its pending promise without an unhandled rejection", async () => {
	const fixture = localPartyFixture({ throwChange: true });
	const result = await fixture.session.changeGameMap({ from: "custom", data: new Uint8Array([1]) });
	await flush();
	assert.equal(result.success, false);
	assert.equal(fixture.calls.randomized, 0);
	assert.equal(fixture.clock.pending.size, 0);
});
