const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { webcrypto } = require("node:crypto");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const flush = () => new Promise((resolve) => setImmediate(resolve));
function load(file, dependencies = {}, environment = {}) {
	const source = fs.readFileSync(path.resolve(clientRoot, file), "utf8").replace(/import\.meta\.env/g, "({})");
	const result = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	const module = { exports: {} };
	vm.runInNewContext(result.outputText, {
		module, exports: module.exports, console, crypto: webcrypto, Error, ArrayBuffer, Uint8Array,
		TextEncoder, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
		window: { addEventListener() {}, removeEventListener() {} },
		...environment,
		require(name) {
			assert.ok(name in dependencies, "Unexpected dependency: " + name);
			return dependencies[name];
		},
	}, { filename: file });
	return module.exports;
}
const types = load("../../packages/types/enums/game/base.ts");
const { SocketMsgType, SocketMsgSource } = types;
function deferred() {
	let resolve, reject;
	const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
	return { promise, resolve, reject };
}
const initialMessages = [
	{ type: SocketMsgType.JoinRoom, source: SocketMsgSource.Server, data: { roomId: "local-room" } },
	{ type: SocketMsgType.RoomInfo, source: SocketMsgSource.Server, data: { roomId: "local-room", userList: [] } },
];
function fixture(options = {}) {
	const calls = { destroyed: 0, factory: 0, delivered: [], emitted: [], states: [] };
	let emitLocal;
	let session;
	const temporary = { destroy() { calls.destroyed++; }, handleClientMessage() {} };
	const { WebRtcSessionManager } = load("src/core/network/WebRtcSessionManager.ts", {
		"@mine-monopoly/types": types,
		"@src/core/monopoly-client/PeerClient": {}, "@src/core/monopoly-client/ReconnectionManager": {},
		"@src/core/monopoly-host/MonopolyHost": {}, "@src/utils/api/room-router": {},
		"@src/utils/auth/session": {}, "./peer-admission": {},
		"@src/core/local-party/LocalPartySession": {
			LocalPartySession: {
				async create(_name, onMessage) {
					calls.factory++;
					emitLocal = onMessage;
					for (const message of initialMessages) onMessage(message);
					assert.equal(calls.delivered.length, 0, "Initialization messages must stay buffered");
					if (options.setup) await options.setup.promise;
					if (options.failFactory) throw new Error("creation failed");
					options.onFactoryReady?.();
					return temporary;
				},
			},
		},
	});
	session = new WebRtcSessionManager({
		iceServer: { host: "fixture", port: 1 },
		onMessage(message) {
			calls.delivered.push(message);
			assert.equal(session.isLocalParty(), true);
			assert.equal(session.getState(), "connected");
			options.onMessage?.(message, session);
		},
		onStateChange(state) { calls.states.push(state); },
	});
	session.on("message", (message) => calls.emitted.push(message));
	return { session, calls, emitLocal: (message) => emitLocal(message) };
}
test("synchronous initial room messages see an installed connected local session", async () => {
	const { session, calls } = fixture();
	await session.createLocalParty("Player");
	assert.deepEqual(calls.delivered, initialMessages);
	assert.deepEqual(calls.emitted, initialMessages);
	assert.equal(session.isLocalParty(), true);
	assert.equal(session.getState(), "connected");
	await session.close();
});
test("live messages follow buffered messages without reordering", async () => {
	const { session, calls, emitLocal } = fixture();
	await session.createLocalParty("Player");
	const live = { type: SocketMsgType.MsgNotify, data: undefined, source: SocketMsgSource.Server };
	emitLocal(live);
	assert.deepEqual(calls.delivered, [...initialMessages, live]);
	assert.deepEqual(calls.emitted, [...initialMessages, live]);
	await session.close();
});
test("closing during initialization destroys a late temporary party without reviving the session", async () => {
	const setup = deferred();
	const { session, calls } = fixture({ setup });
	const creating = session.createLocalParty("Player");
	await flush();
	assert.equal(session.getState(), "connecting");
	await session.close();
	setup.resolve();
	await assert.rejects(creating, /创建已取消/);
	assert.equal(calls.destroyed, 1);
	assert.equal(calls.delivered.length, 0);
	assert.equal(calls.emitted.length, 0);
	assert.equal(session.getState(), "closed");
	assert.equal(session.isLocalParty(), false);
});
test("a disposed client cannot begin local creation after its initial close completes", async () => {
	const { session, calls } = fixture();
	const closing = deferred();
	session.close = () => closing.promise;
	let current = true;
	const creating = session.createLocalParty("Player", () => current);
	current = false;
	closing.resolve();
	await assert.rejects(creating, /创建已取消/);
	assert.equal(calls.factory, 0);
	assert.equal(calls.delivered.length, 0);
});
test("closing from the first buffered message drops all remaining messages", async () => {
	const { session, calls } = fixture({ onMessage(_message, current) { void current.close(); } });
	await assert.rejects(session.createLocalParty("Player"), /创建已取消/);
	assert.equal(calls.delivered.length, 1);
	assert.equal(calls.destroyed, 1);
	assert.equal(session.isLocalParty(), false);
	assert.equal(session.getState(), "closed");
});
test("messages from a cancelled local factory are ignored", async () => {
	const setup = deferred();
	const { session, calls, emitLocal } = fixture({ setup });
	const creating = session.createLocalParty("Player");
	await flush();
	await session.close();
	emitLocal(initialMessages[0]);
	setup.resolve();
	await assert.rejects(creating, /创建已取消/);
	emitLocal(initialMessages[1]);
	assert.equal(calls.delivered.length, 0);
	assert.equal(calls.emitted.length, 0);
});
test("failed initialization does not publish buffered room messages", async () => {
	const { session, calls } = fixture({ failFactory: true });
	await assert.rejects(session.createLocalParty("Player"), /creation failed/);
	assert.equal(calls.delivered.length, 0);
	assert.equal(session.isLocalParty(), false);
	assert.equal(session.getState(), "failed");
});
test("a failing buffered-message consumer destroys the installed temporary party", async () => {
	const { session, calls } = fixture({ onMessage() { throw new Error("consumer failed"); } });
	await assert.rejects(session.createLocalParty("Player"), /consumer failed/);
	assert.equal(calls.delivered.length, 1);
	assert.equal(calls.destroyed, 1);
	assert.equal(session.isLocalParty(), false);
	assert.equal(session.getState(), "failed");
});
test("the real route guard accepts local play without an account or REALM credential", async () => {
	const vueRouter = require(require.resolve("vue-router", { paths: [clientRoot] }));
	let router, navigation, currentClient;
	const local = { isActive: false };
	const room = { roomId: "", $reset() { this.roomId = ""; } };
	const reset = () => ({ $reset() {} });
	const { session } = fixture({
		onFactoryReady() { local.isActive = true; },
		onMessage(message) {
			if (message.type === SocketMsgType.JoinRoom) {
				room.roomId = message.data.roomId;
				navigation = router.replace({ name: "room" });
			}
		},
	});
	const routes = load("src/router/index.ts", {
		"vue-router": {
			...vueRouter,
			createWebHistory: vueRouter.createMemoryHistory,
			createRouter(config) {
				return vueRouter.createRouter({ ...config, routes: config.routes.map((route) => ({ ...route, component: {} })) });
			},
		},
		"@src/store": {
			useLoading: () => ({}), useRoomInfo: () => room,
			useUserInfo: () => ({ identityType: "LOCAL" }), useChat: reset, useGameLog: reset,
		},
		"@src/store/game": { useGameData: reset },
		"@src/core/monopoly-client/MonopolyClient": {
			MonopolyClient: { getInstance: () => currentClient },
			async destoryMonopolyClient() {
				if (currentClient) { await session.close(); currentClient = null; }
			},
		},
		"@src/utils/auth/session": { getAccountProfile: () => null, getActiveRealm: () => null },
		"@src/store/local-party": { useLocalParty: () => local },
		"@src/utils/platform": { getPlatformType: () => "web" },
	});
	router = routes.default;
	await router.push({ name: "room-router" });
	currentClient = { hasRoomSession: () => session.isLocalParty() && session.getState() === "connected" };
	await session.createLocalParty("Player");
	await Promise.all([navigation, router.push({ name: "room" })]);
	assert.equal(router.currentRoute.value.name, "room");
	assert.equal(session.isLocalParty(), true);
	await session.close();
});
