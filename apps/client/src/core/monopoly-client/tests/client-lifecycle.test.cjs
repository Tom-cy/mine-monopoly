const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { webcrypto } = require("node:crypto");

function deferred() {
	let resolve;
	const promise = new Promise((complete) => { resolve = complete; });
	return { promise, resolve };
}

function fixture(options = {}) {
	const calls = { admissions: 0, connected: 0, closed: 0, cancelledMaps: 0, released: 0, animations: 0, cancelledAnimations: 0, resets: 0, routes: [], notices: [] };
	const store = { gamePaused: false, roomId: "101", roomSessionId: "room-session", $reset() { calls.resets++; }, startAnimation() { calls.animations++; }, cancelAnimation() { calls.cancelledAnimations++; } };
	let session;
	class Session {
		constructor(callbacks) { this.callbacks = callbacks; this.state = "connected"; session = this; }
		getState() { return this.state; }
		async preparePeerId() { return "test-peer"; }
		setIceServers() {}
		async connect() { calls.connected++; }
		send() { if (options.sendError) throw new Error("closed channel"); return options.sendSuccess ? { ok: true } : { ok: false, reason: "not-connected" }; }
		async close() { calls.closed++; await options.closing?.promise; this.state = "closed"; }
	}
	const admission = { matched: true, needCreate: false, room: { id: "101", roomSessionId: "room-session" }, hostPeerId: "host", iceServers: [] };
	const request = async (_data, isCurrent) => {
		calls.admissions++;
		await options.admission?.promise;
		if (!options.acceptBeforeCancel && !isCurrent()) throw Object.assign(new Error("入房已取消"), { staleIdentity: true });
		return admission;
	};
	const dependencies = {
		"@mine-monopoly/ui": { FPMessage: (notice) => calls.notices.push(notice) },
		"@src/store": Object.fromEntries(["useChat", "useGameLog", "useLoading", "useRoomInfo", "useUserInfo", "useUtil"].map((name) => [name, () => store])),
		"@src/store/game": { useGameData: () => store },
		"@src/utils/api/room-router": { joinRoomApi: request, matchRoomApi: request, getRegisteredRoom: () => admission.room, releaseCancelledAdmission: async () => { calls.released++; await options.compensation?.promise; } },
		"@src/utils/auth": { ensureRealm: async () => options.realm?.promise, getActiveRealm: () => ({ sessionId: "realm" }), getCurrentRealmUser: () => ({ id: "42" }) },
		"@src/core/network/WebRtcSessionManager": { WebRtcSessionManager: Session },
		"@mine-monopoly/types": { SocketMsgType: { LeaveRoom: "leave", Operation: "operation" }, OperateType: { RollDice: "roll", UseChanceCard: "card" }, SocketMsgSource: { Client: "client" } },
		"./host-message-handlers": { cancelClientMapLoad() { calls.cancelledMaps++; } },
		"@src/router": { replace: async (route) => { calls.routes.push(route.name); } },
		"@src/utils/connection-diagnostics": { connectionDiagnostics: { reset() {}, stageStart() {}, stageEnd() {}, stageFail() {} } },
	};
	const source = fs.readFileSync(path.resolve(__dirname, "../MonopolyClient.ts"), "utf8").replace(/import\.meta\.env/g, "({ DEV: false })");
	const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
	const module = { exports: {} };
	vm.runInNewContext(code, { module, exports: module.exports, crypto: webcrypto, console: { warn() {} }, window: { addEventListener() {}, removeEventListener() {} }, require(name) {
		if (!(name in dependencies)) throw new Error("Unexpected dependency: " + name);
		return dependencies[name];
	} });
	return { ...module.exports, calls, get session() { return session; } };
}

test("leaving with a failed P2P send waits for HTTP cleanup before resetting and routing", async () => {
	const closing = deferred();
	const f = fixture({ closing });
	const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	const leaving = client.leaveRoom();
	await new Promise(setImmediate);
	assert.equal(f.calls.closed, 1);
	assert.equal(f.calls.resets, 0);
	assert.deepEqual(f.calls.routes, []);
	closing.resolve();
	await leaving;
	assert.equal(f.calls.resets, 4);
	assert.deepEqual(f.calls.routes, ["room-router"]);
	assert.equal(client.hasRoomSession(), false);
});

test("a cancelled HTTP admission cannot open a Peer connection and cleanup awaits compensation", async () => {
	const admission = deferred();
	const f = fixture({ admission });
	const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	const joining = client.joinRoom("JOIN");
	await new Promise(setImmediate);
	assert.equal(f.calls.admissions, 1);
	let completed = false;
	const closing = f.destoryMonopolyClient().then(() => { completed = true; });
	await new Promise(setImmediate);
	assert.equal(completed, false);
	admission.resolve();
	assert.equal(await joining, false);
	await closing;
	assert.equal(completed, true);
	assert.equal(f.calls.connected, 0);
	assert.equal(f.calls.notices.length, 0);
});

for (const operation of ["joinRoom", "matchRoom"]) {
	test(operation + " cancelled during identity validation never sends admission", async () => {
		const realm = deferred();
		const f = fixture({ realm });
		const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
		const joining = client[operation]("JOIN");
		await f.destoryMonopolyClient();
		realm.resolve();
		assert.equal(await joining, false);
		assert.equal(f.calls.admissions, 0);
	});
}

test("late closed-room callbacks cannot reset or route a replacement client", async () => {
	const f = fixture();
	await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	const oldSession = f.session;
	await f.destoryMonopolyClient();
	const replacement = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	oldSession.callbacks.onHostClosed("expired");
	assert.equal(f.calls.resets, 0);
	assert.deepEqual(f.calls.routes, []);
	assert.equal(replacement.hasRoomSession(), true);
});

test("destroy between API acceptance and client continuation awaits the final seat compensation", async () => {
	const admission = deferred(), compensation = deferred();
	const f = fixture({ admission, compensation, acceptBeforeCancel: true });
	const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	const joining = client.joinRoom("JOIN");
	await new Promise(setImmediate);
	let completed = false;
	const closing = f.destoryMonopolyClient().then(() => { completed = true; });
	admission.resolve();
	await new Promise(setImmediate);
	assert.equal(f.calls.released, 1);
	assert.equal(completed, false);
	compensation.resolve();
	assert.equal(await joining, false);
	await closing;
	assert.equal(f.calls.connected, 0);
});

for (const sendError of [false, true]) {
	test("failed dice and chance-card sends restore the local controls" + (sendError ? " on exception" : ""), async () => {
		const f = fixture({ sendError });
		const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
		await client.rollDice();
		await client.useChanceCard("card", ["42"]);
		assert.equal(f.calls.animations, 2);
		assert.equal(f.calls.cancelledAnimations, 2);
		assert.equal(f.calls.notices.length, 2);
	});
}

test("successful sends remain locked until the host confirms the resulting game state", async () => {
	const f = fixture({ sendSuccess: true });
	const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	await client.rollDice();
	assert.equal(f.calls.animations, 1);
	assert.equal(f.calls.cancelledAnimations, 0);
});

test("an ongoing online admission prevents concurrent matchmaking and local-mode replacement", async () => {
	const admission = deferred();
	const f = fixture({ admission });
	const client = await f.useMonopolyClient({ iceServer: { host: "localhost", port: 9003 } });
	const joining = client.joinRoom("JOIN");
	await new Promise(setImmediate);
	assert.equal(await client.matchRoom(), false);
	await assert.rejects(client.createLocalParty("local"), /正在加入房间/);
	assert.equal(f.calls.admissions, 1);
	const closing = f.destoryMonopolyClient();
	admission.resolve();
	assert.equal(await joining, false);
	await closing;
	assert.equal(f.calls.connected, 0);
});
