const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { webcrypto } = require("node:crypto");
const test = require("node:test");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../../../../../..")] }));
const clientRoot = path.resolve(__dirname, "../../../..");

function load(file, dependencies = {}, environment = {}) {
	const source = fs.readFileSync(path.resolve(clientRoot, file), "utf8");
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
			ArrayBuffer,
			Uint8Array,
			queueMicrotask,
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
const admission = load("src/core/network/peer-admission.ts");
const { SocketMsgType, SocketMsgSource } = types;
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));
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
	const timeouts = new Map();
	const intervals = new Map();
	const events = new Map();
	return {
		timeouts,
		intervals,
		events,
		setTimeout(fn, milliseconds) {
			timeouts.set(++id, { fn, milliseconds });
			return id;
		},
		clearTimeout(key) {
			timeouts.delete(key);
		},
		setInterval(fn, milliseconds) {
			intervals.set(++id, { fn, milliseconds });
			return id;
		},
		clearInterval(key) {
			intervals.delete(key);
		},
		window: {
			addEventListener(name, fn) {
				const set = events.get(name) ?? new Set();
				set.add(fn);
				events.set(name, set);
			},
			removeEventListener(name, fn) {
				events.get(name)?.delete(fn);
			},
		},
	};
}
class Connection extends EventEmitter {
	constructor(peer = "actual-member-peer", metadata = { ticket: "fixture-ticket" }) {
		super();
		this.peer = peer;
		this.metadata = metadata;
		this.open = true;
		this.sent = [];
		this.closed = false;
	}
	send(message) {
		this.sent.push(typeof message === "string" ? JSON.parse(message) : message);
		this.onSend?.(message);
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.open = false;
		this.emit("close");
	}
	client(type, data) {
		this.emit("data", JSON.stringify({ type, data, source: SocketMsgSource.Client }));
	}
	server(type, data, msg) {
		this.emit("data", JSON.stringify({ type, data, msg, source: SocketMsgSource.Server }));
	}
}
const registration = {
	hostLeaseToken: "fixture-host-lease",
	hostEpoch: 0,
	roomSessionId: "fixture-room-session",
	hostName: "Host",
	hostId: "42",
	capacity: 6,
};
function hostFixture(overrides = {}) {
	const clock = timers();
	const calls = { consumed: [], closed: [], handled: [], peers: [], rooms: [], joined: [], left: [] };
	class Peer extends EventEmitter {
		constructor(options) {
			super();
			this.options = options;
			this.id = "host-peer";
			calls.peers.push(this);
			queueMicrotask(() => this.emit("open", this.id));
		}
		destroy() {
			this.destroyed = true;
		}
	}
	class Room {
		constructor(id, options) {
			this.id = id;
			this.options = options;
			this.users = new Map();
			this.isStarted = false;
			calls.rooms.push(this);
			overrides.constructRoom?.();
		}
		getRoomId() {
			return this.id;
		}
		isUserInRoom(id) {
			return this.users.has(id);
		}
		async join(user, conn) {
			calls.joined.push(user);
			this.users.set(user.userId, { user, conn });
			this.sendToClient(conn, SocketMsgType.JoinRoom, { roomId: this.id });
			if (overrides.joinReady) await overrides.joinReady();
			return true;
		}
		async changeMap(info) {
			if (overrides.initializeMap) await overrides.initializeMap();
			this.mapInfo = info;
		}
		async handleUserReconnect(id, conn) {
			this.users.get(id).conn = conn;
		}
		sendToClient(conn, type, data, msg) {
			conn.send(JSON.stringify({ type, data, msg, source: SocketMsgSource.Server }));
		}
		leave(id) {
			calls.left.push(id);
			this.users.delete(id);
		}
		notifyHostClosing() {}
		destory() {
			this.destroyed = true;
		}
	}
	const api = {
		async readyHostRoom() {
			return { ...registration, hostEpoch: 1, heartbeatIntervalMs: 5000 };
		},
		async deleteRoom(id, lease, keepalive) {
			calls.closed.push({ id, lease, keepalive });
		},
		async consumeRoomTicket(id, request) {
			calls.consumed.push({ id, request });
			if (overrides.consume) return overrides.consume(id, request);
			return {
				roleId: "43",
				roomSessionId: registration.roomSessionId,
				hostEpoch: 1,
				peerId: request.actualPeerId,
			};
		},
		async emitRoomHeart() {
			return { hostEpoch: 1 };
		},
		async getRoomSessionStatus() {
			return { state: "active" };
		},
		async reclaimHostRoom() {
			return { hostLeaseToken: "fixture-rotated-lease", hostEpoch: 2 };
		},
		async setRoomStarted() {},
		...overrides.api,
	};
	const { MonopolyHost } = load(
		"src/core/monopoly-host/MonopolyHost.ts",
		{
			peerjs: Peer,
			"@mine-monopoly/types": types,
			"@src/utils/api/room-router": api,
			"@mine-monopoly/ui": { FPMessage() {} },
			"@src/../global.config": {
				__PEER_OPTIONS__: () => ({
					host: "peer.test",
					port: 9003,
					path: "/monopoly-mine-peer",
					key: "monopoly-mine",
					secure: true,
				}),
			},
			"./client-message-handlers": {
				handleClientSocketMessage(conn, message, host, roleId) {
					calls.handled.push({ message, roleId });
				},
			},
			"./Room": { Room },
			"@src/utils/api/map": { getFrozenRoomMap: () => ({ id: "44" }) },
			"@src/utils/connection-diagnostics": { connectionDiagnostics: { logPeerEvent() {} } },
			"../network/peer-admission": admission,
		},
		clock,
	);
	return {
		calls,
		clock,
		api,
		create: () => MonopolyHost.create("101", "legacy-unused", 1, 5000, [{ urls: "stun:stun.test" }], registration),
	};
}

test("consumed ticket must match actual Peer, room session, epoch and numeric role", () => {
	const expected = { roomSessionId: "room", hostEpoch: 9, peerId: "actual" };
	assert.equal(admission.verifyPeerIdentity({ ...expected, roleId: "902" }, expected), "902");
	for (const altered of [
		{ peerId: "claimed" },
		{ roomSessionId: "old" },
		{ hostEpoch: 8 },
		{ roleId: "0" },
		{ roleId: "admin" },
		{ roleId: 902 },
	]) {
		assert.throws(() => admission.verifyPeerIdentity({ ...expected, roleId: "902", ...altered }, expected));
	}
});
test("profile cannot replace canonical role or inject AI, spectator and privilege flags", () => {
	const user = admission.canonicalPeerUser(
		{
			userId: "42",
			id: "42",
			roleId: "admin",
			isAI: true,
			isSpectator: true,
			username: "<b>Guest</b>",
			color: "red",
			avatar: "javascript:evil",
			isReady: true,
		},
		"43",
	);
	assert.deepEqual(plain(user), { userId: "43", username: "bGuest/b", color: "#409eff", avatar: "", isReady: true });
	for (const metadata of [
		undefined,
		{},
		{ userId: "43" },
		{ ticket: 1 },
		{ ticket: "" },
		{ ticket: "a".repeat(513) },
	])
		assert.throws(() => admission.readPeerTicket(metadata));
});
test("host queues JoinRoom until HTTP consume and uses conn.peer plus verified role for subsequent commands", async () => {
	const result = deferred();
	const fixture = hostFixture({ consume: () => result.promise });
	const host = await fixture.create();
	assert.deepEqual(plain(host.getRoom().mapInfo), { from: "server", data: "44" });
	assert.equal(host.getRoom().options.ownerId, "42");
	const conn = new Connection();
	fixture.calls.peers[0].emit("connection", conn);
	conn.client(SocketMsgType.JoinRoom, { userId: "42", username: "Guest", avatar: "", color: "#123456", isAI: true });
	assert.equal(fixture.calls.joined.length, 0);
	await flush();
	assert.equal(fixture.calls.consumed[0].request.actualPeerId, conn.peer);
	assert.equal(fixture.calls.consumed[0].request.hostEpoch, 1);
	result.resolve({ roleId: "43", roomSessionId: registration.roomSessionId, hostEpoch: 1, peerId: conn.peer });
	await flush();
	assert.equal(fixture.calls.joined[0].userId, "43");
	assert.equal(fixture.calls.joined[0].isAI, undefined);
	conn.client(SocketMsgType.GameStart, undefined);
	conn.client(SocketMsgType.KickOut, "42");
	conn.client(SocketMsgType.ChangeMap, { from: "custom", data: "evil" });
	assert.equal(fixture.calls.handled.length, 0);
	conn.client(SocketMsgType.Operation, { operateType: "anything", userId: "42" });
	assert.equal(fixture.calls.handled[0].roleId, "43");
	await host.close();
	assert.equal(fixture.calls.closed[0].lease.hostEpoch, 1);
	assert.equal(fixture.clock.intervals.size, 0);
});
test("admitted player can finish map loading while gameplay waits for Room.join completion", async () => {
	const ready = deferred();
	const fixture = hostFixture({ joinReady: () => ready.promise });
	const host = await fixture.create();
	const conn = new Connection();
	fixture.calls.peers[0].emit("connection", conn);
	conn.client(SocketMsgType.JoinRoom, {});
	await flush();
	conn.client(SocketMsgType.Operation, { operateType: types.OperateType.RollDice });
	assert.equal(fixture.calls.handled.length, 0);
	conn.client(SocketMsgType.Operation, { operateType: types.OperateType.MapResourceLoaded });
	assert.equal(fixture.calls.handled.length, 1);
	ready.resolve();
	await flush();
	assert.equal(fixture.calls.handled.length, 2);
	conn.client(SocketMsgType.Operation, { operateType: types.OperateType.RollDice });
	assert.equal(fixture.calls.handled.length, 3);
	await host.close();
});
test("host denies gameplay before validation and rejects replayed or missing tickets", async () => {
	for (const mode of ["early-operation", "replay", "missing", "wrong-peer", "wrong-session", "wrong-epoch"]) {
		const result = deferred();
		const fixture = hostFixture({ consume: () => result.promise });
		const host = await fixture.create();
		const conn = new Connection("actual", mode === "missing" ? {} : { ticket: "fixture-ticket" });
		fixture.calls.peers[0].emit("connection", conn);
		conn.client(mode === "early-operation" ? SocketMsgType.Operation : SocketMsgType.JoinRoom, { userId: "42" });
		if (mode === "replay") result.reject(new Error("already consumed"));
		else
			result.resolve({
				roleId: "43",
				roomSessionId: mode === "wrong-session" ? "old" : registration.roomSessionId,
				hostEpoch: mode === "wrong-epoch" ? 0 : 1,
				peerId: mode === "wrong-peer" ? "forged" : "actual",
			});
		await flush();
		assert.equal(conn.closed, true, mode);
		assert.equal(fixture.calls.joined.length, 0, mode);
		assert.equal(fixture.calls.handled.length, 0, mode);
		if (mode === "missing") assert.equal(fixture.calls.consumed.length, 0);
		await host.close();
	}
});
test("replacement connection cannot be removed by its stale predecessor close event", async () => {
	const fixture = hostFixture();
	const host = await fixture.create();
	const previous = new Connection();
	fixture.calls.peers[0].emit("connection", previous);
	previous.client(SocketMsgType.JoinRoom, {});
	await flush();
	const current = new Connection("new-peer");
	fixture.calls.peers[0].emit("connection", current);
	current.client(SocketMsgType.JoinRoom, {});
	await flush();
	assert.equal(previous.closed, true);
	assert.equal(host.getRoom().users.get("43").conn, current);
	assert.deepEqual(fixture.calls.left, []);
	current.client(SocketMsgType.Heart, undefined);
	assert.equal(fixture.calls.handled.at(-1).roleId, "43");
	await host.close();
});
test("late ticket response after host close cannot admit a player", async () => {
	const result = deferred();
	const fixture = hostFixture({ consume: () => result.promise });
	const host = await fixture.create();
	const conn = new Connection();
	fixture.calls.peers[0].emit("connection", conn);
	conn.client(SocketMsgType.JoinRoom, {});
	await host.close(true);
	result.resolve({ roleId: "43", roomSessionId: registration.roomSessionId, hostEpoch: 1, peerId: conn.peer });
	await flush();
	assert.equal(fixture.calls.joined.length, 0);
	assert.equal(fixture.calls.closed[0].keepalive, true);
	assert.equal(conn.closed, true);
});
test("failure after ready cleans up the incremented lease epoch", async () => {
	const fixture = hostFixture({
		constructRoom() {
			throw new Error("construction failed");
		},
	});
	await assert.rejects(fixture.create(), /construction failed/);
	assert.equal(fixture.calls.closed[0].lease.hostEpoch, 1);
	assert.equal(fixture.calls.peers[0].destroyed, true);
});
test("ready host renews its lease while map initializes and cannot admit a player early", async () => {
	const initialized = deferred();
	let hearts = 0;
	const fixture = hostFixture({
		initializeMap: () => initialized.promise,
		api: {
			emitRoomHeart: async () => {
				hearts++;
				return { hostEpoch: 1 };
			},
		},
	});
	const creating = fixture.create();
	await flush();
	const leaseHeartbeat = [...fixture.clock.intervals.values()].find((timer) => timer.milliseconds === 5000);
	assert.ok(leaseHeartbeat);
	leaseHeartbeat.fn();
	const conn = new Connection();
	fixture.calls.peers[0].emit("connection", conn);
	conn.client(SocketMsgType.JoinRoom, {});
	await flush();
	assert.equal(hearts, 1);
	assert.equal(fixture.calls.consumed.length, 0);
	assert.equal(fixture.calls.joined.length, 0);
	initialized.resolve();
	const host = await creating;
	await flush();
	assert.equal(fixture.calls.joined.length, 1);
	await host.close();
});
test("map initialization failure closes host, Room and all liveness timers", async () => {
	const fixture = hostFixture({
		initializeMap: () => {
			throw new Error("bad map");
		},
	});
	await assert.rejects(fixture.create(), /bad map/);
	assert.equal(fixture.calls.rooms[0].destroyed, true);
	assert.equal(fixture.calls.peers[0].destroyed, true);
	assert.equal(fixture.calls.closed[0].lease.hostEpoch, 1);
	assert.equal(fixture.clock.intervals.size, 0);
	assert.equal(fixture.clock.events.get("beforeunload").size, 0);
});
test("host reclaim rotates the lease token and epoch used for later ticket consumption and closing", async () => {
	const fixture = hostFixture({
		api: {
			emitRoomHeart: async () => {
				throw new Error("transient outage");
			},
			getRoomSessionStatus: async () => ({ state: "grace" }),
			consumeRoomTicket: async (id, request) => {
				fixture.calls.consumed.push({ id, request });
				return {
					roleId: "43",
					roomSessionId: registration.roomSessionId,
					hostEpoch: request.hostEpoch,
					peerId: request.actualPeerId,
				};
			},
		},
	});
	const host = await fixture.create();
	assert.deepEqual(plain(await host.debugSendHeartbeat()), { ok: true, reclaimed: true });
	const conn = new Connection();
	fixture.calls.peers[0].emit("connection", conn);
	conn.client(SocketMsgType.JoinRoom, {});
	await flush();
	assert.equal(fixture.calls.consumed[0].request.hostEpoch, 2);
	assert.equal(fixture.calls.consumed[0].request.hostLeaseToken, "fixture-rotated-lease");
	await host.close();
	assert.equal(fixture.calls.closed[0].lease.hostEpoch, 2);
});

function sessionFixture(overrides = {}) {
	const clock = timers();
	const calls = { peers: [], issued: [], links: [], hearts: [], left: [], status: [], order: [], managers: [] };
	class PeerClient {
		static async create(host, port, config, peerId) {
			const peer = new PeerClient();
			peer.id = peerId;
			peer.config = config;
			calls.peers.push(peer);
			if (overrides.create) await overrides.create();
			return peer;
		}
		getPeerId() {
			return this.id;
		}
		async linkToHost(host, ticket) {
			calls.links.push({ host, ticket });
			calls.order.push("link");
			const conn = new Connection(host);
			conn.onSend = (message) => {
				if (JSON.parse(message).type === SocketMsgType.JoinRoom && !overrides.suppressAck)
					queueMicrotask(() => conn.server(SocketMsgType.JoinRoom, { roomId: "101" }));
			};
			this.conn = conn;
			if (overrides.link) await overrides.link();
			return { conn };
		}
		destory() {
			this.destroyed = true;
			this.conn?.close();
		}
	}
	class ReconnectionManager {
		constructor(fn, options) {
			this.fn = fn;
			this.options = options;
			calls.managers.push(this);
		}
		start() {}
		destroy() {
			this.stopped = true;
		}
		cancel() {
			this.options.onCancel();
		}
	}
	const api = {
		async issueRoomTicket(id, peerId) {
			calls.issued.push({ id, peerId });
			calls.order.push("issue");
			if (overrides.issue) await overrides.issue();
			return { ticket: "fixture-ticket-" + calls.issued.length };
		},
		async emitMemberHeart(id) {
			calls.hearts.push(id);
			if (overrides.heartbeat) await overrides.heartbeat();
		},
		async leaveRoom(id, keepalive) {
			calls.left.push({ id, keepalive });
		},
		async getRoomSessionStatus(id) {
			calls.status.push(id);
			calls.order.push("status");
			if (overrides.status) return overrides.status();
			return { state: "active" };
		},
	};
	const { WebRtcSessionManager } = load(
		"src/core/network/WebRtcSessionManager.ts",
		{
			"@mine-monopoly/types": types,
			"@src/core/monopoly-client/PeerClient": { PeerClient },
			"@src/core/monopoly-client/ReconnectionManager": { ReconnectionManager },
			"@src/core/monopoly-host/MonopolyHost": { MonopolyHost: {} },
			"@src/utils/api/room-router": api,
			"@src/utils/auth/session": {
				getCurrentRealmUser: () => ({ userId: "43", username: "Canonical", avatar: "", color: "#123456" }),
			},
			"./peer-admission": admission,
			"@src/core/local-party/LocalPartySession": { LocalPartySession: {} },
		},
		clock,
	);
	const messages = [];
	const closed = [];
	const session = new WebRtcSessionManager({
		iceServer: { host: "unused", port: 1 },
		onMessage: (message) => messages.push(message),
		onHostClosed: (state) => closed.push(state),
	});
	return { session, calls, clock, messages, closed };
}
test("member prepares stable ID before ICE and only starts liveness after verified JoinRoom acknowledgement", async () => {
	const fixture = sessionFixture({ suppressAck: true });
	const id = await fixture.session.preparePeerId();
	assert.equal(await fixture.session.preparePeerId(), id);
	assert.equal(fixture.calls.peers.length, 0);
	fixture.session.setIceServers([
		{ urls: "turn:turn.test", username: "fixture-user", credential: "fixture-password" },
	]);
	const connecting = fixture.session.connect("101", "host-peer", () => false);
	await flush();
	assert.equal(fixture.calls.peers[0].id, id);
	assert.equal(fixture.calls.issued[0].peerId, id);
	assert.equal(fixture.calls.links[0].ticket, "fixture-ticket-1");
	assert.equal(fixture.calls.peers[0].config.iceServers[0].urls, "turn:turn.test");
	assert.equal(fixture.session.getState(), "connecting");
	assert.equal(fixture.calls.hearts.length, 0);
	fixture.calls.peers[0].conn.server(SocketMsgType.JoinRoom, { roomId: "101" });
	await connecting;
	assert.equal(fixture.session.getState(), "connected");
	assert.equal(fixture.calls.hearts.length, 1);
	await fixture.session.close();
	assert.equal(fixture.calls.left.length, 1);
	assert.equal(fixture.clock.intervals.size, 0);
	assert.equal(fixture.clock.events.get("beforeunload").size, 0);
});
test("reconnect checks plain room state before issuing a fresh ticket and linking", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host-peer", () => true);
	await fixture.session.debugReconnectNow();
	assert.equal(fixture.calls.issued.length, 2);
	assert.equal(fixture.calls.links[1].ticket, "fixture-ticket-2");
	assert.deepEqual(fixture.calls.order, ["issue", "link", "status", "issue", "link"]);
	await fixture.session.close();
});
test("expired room prevents reconnection and any ticket issuance", async () => {
	const fixture = sessionFixture({ status: () => ({ state: "expired" }) });
	await fixture.session.connect("101", "host-peer", () => true);
	await assert.rejects(fixture.session.debugReconnectNow(), /房间已过期/);
	assert.equal(fixture.calls.issued.length, 1);
	await fixture.session.close();
});
test("map loading pauses P2P probes while member HTTP heartbeat continues", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host-peer", () => true);
	await flush();
	fixture.session.pauseHeartbeat();
	const memberHeartbeat = [...fixture.clock.intervals.values()].find((timer) => timer.milliseconds === 10000);
	memberHeartbeat.fn();
	await flush();
	assert.equal(fixture.calls.hearts.length, 2);
	await fixture.session.close();
});
test("beforeunload close forwards keepalive to authenticated member leave", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host-peer", () => true);
	await fixture.session.close(true);
	assert.equal(fixture.calls.left[0].keepalive, true);
});
test("force relay replaces the signaling ID and binds a fresh ticket to the replacement", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host-peer", () => true);
	const firstId = fixture.calls.peers[0].id;
	fixture.session.strategy = "force-relay";
	await fixture.session.debugReconnectNow();
	assert.equal(fixture.calls.peers[0].destroyed, true);
	assert.notEqual(fixture.calls.peers[1].id, firstId);
	assert.equal(fixture.calls.peers[1].config.iceTransportPolicy, "relay");
	assert.equal(fixture.calls.issued[1].peerId, fixture.calls.peers[1].id);
	await fixture.session.close();
});
test("close while Peer creation is pending destroys late Peer and prevents transport admission", async () => {
	const result = deferred();
	const fixture = sessionFixture({ create: () => result.promise });
	const connecting = fixture.session.connect("101", "host-peer", () => true);
	await flush();
	await fixture.session.close();
	result.resolve();
	await assert.rejects(connecting, /取消/);
	assert.equal(fixture.calls.peers[0].destroyed, true);
	assert.equal(fixture.calls.issued.length, 0);
	assert.equal(fixture.calls.links.length, 0);
	assert.equal(fixture.session.getState(), "closed");
});
test("close while DataConnection opens cannot publish a stale successful connection", async () => {
	const result = deferred();
	const fixture = sessionFixture({ link: () => result.promise });
	const connecting = fixture.session.connect("101", "host-peer", () => true);
	await flush();
	await fixture.session.close();
	result.resolve();
	await assert.rejects(connecting, /取消/);
	assert.equal(fixture.calls.peers[0].conn.closed, true);
	assert.equal(fixture.calls.hearts.length, 0);
	assert.equal(fixture.session.getState(), "closed");
});
test("repeated concurrent retry attempts share one status check and one ticket", async () => {
	const result = deferred();
	const fixture = sessionFixture({ status: () => result.promise });
	await fixture.session.connect("101", "host-peer", () => true);
	const first = fixture.session.debugReconnectNow();
	const second = fixture.session.debugReconnectNow();
	assert.equal(fixture.calls.status.length, 1);
	result.resolve({ state: "grace" });
	await Promise.all([first, second]);
	assert.equal(fixture.calls.issued.length, 2);
	await fixture.session.close();
});
test("member heartbeat identity expiry closes transport and releases the membership", async () => {
	const fixture = sessionFixture({
		heartbeat: () => {
			throw { code: 46002 };
		},
	});
	await fixture.session.connect("101", "host-peer", () => false).catch(() => undefined);
	await flush();
	assert.equal(fixture.session.getState(), "closed");
	assert.equal(fixture.calls.peers[0].destroyed, true);
	assert.equal(fixture.calls.left.length, 1);
	assert.deepEqual(fixture.closed, ["closed"]);
});
test("stale identity heartbeat cleans old transport without redirecting the new realm", async () => {
	const fixture = sessionFixture({
		heartbeat: () => {
			throw { code: 46002, staleIdentity: true };
		},
	});
	await fixture.session.connect("101", "host-peer", () => false).catch(() => undefined);
	await flush();
	assert.equal(fixture.session.getState(), "closed");
	assert.equal(fixture.calls.peers[0].destroyed, true);
	assert.deepEqual(fixture.closed, []);
});

function roomFixture() {
	const clock = timers();
	clock.window.setTimeout = clock.setTimeout;
	clock.window.clearTimeout = clock.clearTimeout;
	const workers = [];
	const workerTypes = load("src/enums/worker.ts");
	const { OperateListener } = load(
		"src/core/worker/class/OperateListener.ts",
		{ "@mine-monopoly/types": types },
		clock,
	);
	class Worker {
		constructor() {
			workers.push(this);
		}
		addEventListener() {}
		postMessage() {}
		terminate() {
			this.terminated = true;
		}
	}
	const store = {
		useSettig: () => ({ aiDecisionConfig: {} }),
		useLoading: () => ({ hideLoading() {} }),
	};
	const noop = () => undefined;
	const { Room } = load(
		"src/core/monopoly-host/Room.ts",
		{
			"@mine-monopoly/types": types,
			"@src/enums/worker": workerTypes,
			"@src/store": store,
			"@src/utils": { randomString: () => "fixture" },
			"@src/utils/api/map": { getFrozenRoomMap: () => ({ id: "44" }) },
			"@src/core/ai/remote-usage-stats": { clearAIRemoteUsageStats: noop },
			"@src/core/worker/GameProcessWorker?worker": Worker,
			"@src/store/game": { useMapData: () => ({ info: {} }) },
			"@mine-monopoly/ui": { FPMessage: noop },
			"@src/utils/log": {
				__esModule: true,
				default: { info: noop, error: noop },
				ErrorCategory: { WORKER: "worker" },
			},
			"../worker/class/OperateListener": { OperateListener },
			"@mine-monopoly/utils": {},
			"@src/core/save": { SaveManager: class {} },
			"@src/core/ai/OpenAICompatibleDecisionProvider": {},
			"@src/core/ai/ai-decision-config": { normalizeAIDecisionConfig: (value) => value },
		},
		clock,
	);
	return { Room, clock, workers };
}
test("Room owner remains the registered host when a guest joins first", async () => {
	const fixture = roomFixture();
	const room = new fixture.Room("101", { ownerId: "42" });
	await room.join(
		{ userId: "43", username: "Guest", avatar: "", color: "#123456", isReady: false },
		new Connection(),
	);
	assert.equal(room.getOwnerId(), "42");
	room.destory();
});
test("Room initializes the frozen map and refuses arbitrary online map replacement", async () => {
	const fixture = roomFixture();
	const room = new fixture.Room("101", { ownerId: "42" });
	await room.changeMap({ from: "server", data: "44" });
	assert.equal(room.getMapInfo().data, "44");
	await room.changeMap({ from: "server", data: "45" });
	assert.equal(room.getMapInfo().data, "44");
	await room.changeMap({ from: "custom", data: "unverified-bytes" });
	assert.equal(room.getMapInfo().from, "server");
	room.destory();
});
test("backend start failure cannot start the game Worker", async () => {
	const fixture = roomFixture();
	const room = new fixture.Room("101", {
		ownerId: "42",
		beforeStart: async () => {
			throw new Error("lease invalid");
		},
	});
	await room.changeMap({ from: "server", data: "44" });
	await room.startGame();
	assert.equal(room.isStarted, false);
	assert.equal(fixture.workers.length, 0);
	room.destory();
});
test("closing while the backend start transaction waits cannot resurrect a Worker", async () => {
	const fixture = roomFixture();
	const result = deferred();
	const room = new fixture.Room("101", { ownerId: "42", beforeStart: () => result.promise });
	await room.changeMap({ from: "server", data: "44" });
	const starting = room.startGame();
	room.destory();
	result.resolve();
	await starting;
	assert.equal(room.isStarted, false);
	assert.equal(fixture.workers.length, 0);
});
test("concurrent starts issue one backend start and retain the existing Worker path", async () => {
	const fixture = roomFixture();
	const result = deferred();
	let marked = 0;
	const room = new fixture.Room("101", {
		ownerId: "42",
		beforeStart: () => {
			marked++;
			return result.promise;
		},
	});
	await room.changeMap({ from: "server", data: "44" });
	const starting = room.startGame();
	await room.startGame();
	assert.equal(marked, 1);
	assert.equal(fixture.workers.length, 0);
	result.resolve();
	await starting;
	assert.equal(room.isStarted, true);
	assert.equal(fixture.workers.length, 1);
	room.destory();
	assert.equal(fixture.workers[0].terminated, true);
});
test("late reconnect completion cannot mark a replaced connection online or offline", async () => {
	const fixture = roomFixture();
	const room = new fixture.Room("101", { ownerId: "42" });
	await room.join({ userId: "42", username: "Host", avatar: "", color: "#123456", isReady: false }, new Connection());
	await room.changeMap({ from: "server", data: "44" });
	room.userList.get("42").isOffLine = true;
	const obsolete = new Connection("obsolete");
	const current = new Connection("current");
	const first = room.handleUserReconnect("42", obsolete, 1);
	const second = room.handleUserReconnect("42", current, 2);
	obsolete.close();
	room.emitOperation("42", types.OperateType.MapResourceLoaded, undefined);
	await Promise.all([first, second]);
	assert.equal(room.userList.get("42").socketClient, current);
	assert.equal(room.userList.get("42").isOffLine, false);
	room.destory();
});
