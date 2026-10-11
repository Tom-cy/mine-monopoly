const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { webcrypto } = require("node:crypto");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load(file, dependencies, environment = {}) {
	const result = ts.transpileModule(fs.readFileSync(path.resolve(clientRoot, file), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	const module = { exports: {} };
	vm.runInNewContext(result.outputText, {
		module,
		exports: module.exports,
		console,
		crypto: webcrypto,
		TextEncoder,
		TextDecoder,
		ArrayBuffer,
		Uint8Array,
		queueMicrotask,
		...environment,
		require(name) {
			assert.ok(name in dependencies, "Unexpected dependency: " + name);
			return dependencies[name];
		},
	});
	return module.exports;
}

function fakeClock() {
	let now = 1000;
	let nextId = 0;
	const tasks = new Map();
	return {
		tasks,
		Date: class extends Date {
			static now() {
				return now;
			}
		},
		setTimeout(fn, delay) {
			tasks.set(++nextId, { fn, due: now + delay, delay, repeat: false });
			return nextId;
		},
		clearTimeout(id) {
			tasks.delete(id);
		},
		setInterval(fn, delay) {
			tasks.set(++nextId, { fn, due: now + delay, delay, repeat: true });
			return nextId;
		},
		clearInterval(id) {
			tasks.delete(id);
		},
		async advance(duration) {
			const target = now + duration;
			while (true) {
				const next = [...tasks.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
				if (!next) break;
				const [id, task] = next;
				now = task.due;
				if (task.repeat) task.due += task.delay;
				else tasks.delete(id);
				task.fn();
				await flush();
			}
			now = target;
			await flush();
		},
		window: { addEventListener() {}, removeEventListener() {} },
	};
}

const types = load("../../packages/types/enums/game/base.ts", {});
const { SocketMsgSource, SocketMsgType } = types;
const admission = load("src/core/network/peer-admission.ts", {});

class Connection extends EventEmitter {
	constructor(open = true) {
		super();
		this.open = open;
		this.sent = [];
	}
	send(payload) {
		if (this.sendError) throw this.sendError;
		const message = JSON.parse(payload);
		this.sent.push(message);
		if (message.type === SocketMsgType.JoinRoom)
			queueMicrotask(() => this.server(SocketMsgType.JoinRoom, { roomId: "101" }));
	}
	server(type, data) {
		this.emit("data", JSON.stringify({ source: SocketMsgSource.Server, type, data }));
	}
	close() {
		if (this.closed) return;
		this.closed = true;
		this.open = false;
		this.emit("close");
	}
}

function sessionFixture() {
	const clock = fakeClock();
	const peers = [];
	const tickets = [];
	const managers = [];
	const hearts = [];
	class PeerClient {
		static async create(host, port, config, id) {
			const peer = new PeerClient();
			Object.assign(peer, { id, config, usable: true });
			peers.push(peer);
			return peer;
		}
		isUsable() {
			return this.usable && !this.destroyed;
		}
		getPeerId() {
			return this.id;
		}
		async linkToHost() {
			this.conn = new Connection();
			return { conn: this.conn };
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
			managers.push(this);
		}
		start() {}
		destroy() {}
	}
	const { WebRtcSessionManager } = load(
		"src/core/network/WebRtcSessionManager.ts",
		{
			"@mine-monopoly/types": types,
			"@src/core/monopoly-client/PeerClient": { PeerClient },
			"@src/core/monopoly-client/ReconnectionManager": { ReconnectionManager },
			"@src/core/monopoly-host/MonopolyHost": { MonopolyHost: {} },
			"@src/core/local-party/LocalPartySession": { LocalPartySession: {} },
			"@src/utils/api/room-router": {
				async issueRoomTicket(roomId, peerId) {
					tickets.push({ roomId, peerId });
					return { ticket: "test-ticket" };
				},
				async getRoomSessionStatus() {
					return { state: "active" };
				},
				async emitMemberHeart() {
					hearts.push(clock.Date.now());
				},
				async leaveRoom() {},
			},
			"@src/utils/auth/session": { getCurrentRealmUser: () => ({ userId: "42", username: "Test" }) },
			"./peer-admission": admission,
		},
		clock,
	);
	const session = new WebRtcSessionManager({
		iceServer: { host: "unused", port: 1 },
		onMessage(message) {
			if (message.type === SocketMsgType.Heart) session.handleHeartbeatReply();
		},
	});
	return { clock, peers, tickets, managers, hearts, session };
}

test("ongoing successful sends without replies cannot postpone the heartbeat deadline", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host", () => false);
	const conn = fixture.peers[0].conn;
	await fixture.clock.advance(6000);
	assert.equal(conn.sent.filter((message) => message.type === SocketMsgType.Heart).length, 2);
	assert.equal(fixture.session.getState(), "connected");
	await fixture.clock.advance(2000);
	assert.equal(fixture.session.getState(), "reconnecting");
	assert.equal(conn.closed, true);
	assert.equal(fixture.managers.length, 1);
	await fixture.session.close();
	assert.equal(fixture.clock.tasks.size, 0);
});

test("only heartbeat replies renew the timeout and stale replies cannot revive a closed connection", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host", () => false);
	const conn = fixture.peers[0].conn;
	await fixture.clock.advance(6000);
	conn.server(SocketMsgType.Heart);
	await fixture.clock.advance(4000);
	assert.equal(fixture.session.getState(), "connected");
	await fixture.clock.advance(1000);
	assert.equal(fixture.session.getState(), "reconnecting");
	const pending = fixture.clock.tasks.size;
	conn.server(SocketMsgType.Heart);
	fixture.session.handleHeartbeatReply();
	assert.equal(fixture.clock.tasks.size, pending);
	await fixture.session.close();
});

test("paused map loading keeps HTTP liveness and resume establishes a fresh P2P deadline", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host", () => false);
	await fixture.clock.advance(3000);
	fixture.session.pauseHeartbeat();
	await fixture.clock.advance(20000);
	assert.equal(fixture.session.getState(), "connected");
	assert.equal(fixture.hearts.length, 3);
	fixture.session.resumeHeartbeat();
	await fixture.clock.advance(5000);
	assert.equal(fixture.session.getState(), "reconnecting");
	await fixture.session.close();
});

test("heartbeat send errors dispose the failed transport before one reconnection starts", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host", () => false);
	const conn = fixture.peers[0].conn;
	conn.sendError = new Error("channel closed");
	await fixture.clock.advance(3000);
	assert.equal(fixture.session.getState(), "reconnecting");
	assert.equal(conn.closed, true);
	conn.emit("close");
	assert.equal(fixture.managers.length, 1);
	await fixture.session.close();
});

test("STUN-only retries keep P2P while a configured TURN server enables relay recovery", async () => {
	for (const [urls, expected] of [["stun:stun.test", "prefer-p2p"], [["stun:stun.test", "turns:turn.test"], "force-relay"]]) {
		const fixture = sessionFixture();
		fixture.session.setIceServers([{ urls }]);
		await fixture.session.connect("101", "host", () => false);
		fixture.session.debugDropP2pConnection();
		fixture.managers[0].options.onRetry(4);
		assert.equal(fixture.session.getConnectionStrategy(), expected);
		await fixture.session.close();
		assert.equal(fixture.session.getConnectionStrategy(), "prefer-p2p");
	}
});

test("a disconnected signaling Peer is replaced with a fresh ID before the next admission ticket", async () => {
	const fixture = sessionFixture();
	await fixture.session.connect("101", "host", () => false);
	fixture.peers[0].usable = false;
	await fixture.session.debugReconnectNow();
	assert.equal(fixture.peers[0].destroyed, true);
	assert.equal(fixture.peers.length, 2);
	assert.notEqual(fixture.peers[1].id, fixture.peers[0].id);
	assert.equal(fixture.tickets[1].peerId, fixture.peers[1].id);
	await fixture.session.close();
});

function peerFixture({ autoOpen = true, connectError = false } = {}) {
	const clock = fakeClock();
	const peers = [];
	const candidateEvents = [];
	const store = { connectionMode: "unknown" };
	class Peer extends EventEmitter {
		constructor(id, options) {
			super();
			this.id = typeof id === "string" ? id : "test-peer";
			this.options = options ?? id;
			this.open = false;
			this.disconnected = false;
			this.destroyed = false;
			peers.push(this);
			if (autoOpen) queueMicrotask(() => { this.open = true; this.emit("open", this.id); });
		}
		connect(host, options) {
			if (connectError) throw new Error("constructor failed");
			const conn = new Connection(false);
			conn.options = options;
			conn.peerConnection = {
				onicecandidate: (event) => candidateEvents.push(event),
				oniceconnectionstatechange: () => { if (conn.peerConnection.iceConnectionState === "failed") conn.close(); },
				iceConnectionState: "checking",
				listeners: new Map(),
				addEventListener(name, listener) {
					const listeners = this.listeners.get(name) ?? [];
					listeners.push(listener);
					this.listeners.set(name, listeners);
				},
				dispatch(name, event) {
					this["on" + name]?.(event);
					for (const listener of this.listeners.get(name) ?? []) listener(event);
				},
			};
			this.conn = conn;
			return conn;
		}
		destroy() {
			if (this.destroyed) return;
			this.destroyed = true;
			this.open = false;
			this.conn?.close();
			this.emit("close");
		}
	}
	const diagnostics = new Proxy({}, { get: () => () => undefined });
	const { PeerClient } = load("src/core/monopoly-client/PeerClient.ts", {
		"@src/store": { useUtil: () => store },
		"@src/../global.config": { __PEER_OPTIONS__: () => ({ host: "peer.test", port: 9003, path: "/peer" }) },
		peerjs: Peer,
		"@src/utils/connection-diagnostics": { connectionDiagnostics: diagnostics },
	}, clock);
	return { PeerClient, peers, clock, candidateEvents, store, create: () => PeerClient.create("unused", 1, {}, "member") };
}

test("Peer disconnection before open fails promptly and destroys the incomplete registration", async () => {
	const fixture = peerFixture({ autoOpen: false });
	const result = fixture.create();
	fixture.peers[0].emit("disconnected");
	await assert.rejects(result, /就绪前断开/);
	assert.equal(fixture.peers[0].destroyed, true);
	assert.equal(fixture.clock.tasks.size, 0);
});

test("a transport close, signaling error or signaling disconnection ends connection wait immediately", async () => {
	for (const failure of ["transport-close", "peer-error", "peer-disconnected", "peer-close", "destroy"]) {
		const fixture = peerFixture();
		const client = await fixture.create();
		const connecting = client.linkToHost("host", "test-ticket");
		const peer = fixture.peers[0];
		if (failure === "transport-close") peer.conn.close();
		else if (failure === "peer-error") peer.emit("error", new Error("peer unavailable"));
		else if (failure === "peer-disconnected") peer.emit("disconnected");
		else if (failure === "destroy") client.destory();
		else peer.emit("close");
		await assert.rejects(connecting);
		assert.equal(peer.conn.closed, true, failure);
		assert.equal(fixture.clock.tasks.size, 0, failure);
		assert.equal(peer.listenerCount("error"), 1, failure);
		assert.equal(peer.listenerCount("disconnected"), 1, failure);
		assert.equal(peer.listenerCount("close"), 1, failure);
		assert.equal(peer.conn.listenerCount("open"), 0, failure);
	}
});

test("synchronous Peer.connect failure cleans the timeout and temporary listeners", async () => {
	const fixture = peerFixture({ connectError: true });
	const client = await fixture.create();
	await assert.rejects(client.linkToHost("host", "test-ticket"), /constructor failed/);
	assert.equal(fixture.clock.tasks.size, 0);
	assert.equal(fixture.peers[0].listenerCount("error"), 1);
	client.destory();
});

test("ICE diagnostics preserve PeerJS candidate forwarding and failed-ICE cleanup", async () => {
	const fixture = peerFixture();
	const client = await fixture.create();
	const connecting = client.linkToHost("host", "test-ticket");
	const conn = fixture.peers[0].conn;
	const pc = conn.peerConnection;
	const candidate = { candidate: { candidate: "candidate:1 1 udp 1 172.27.1.8 12345 typ host" } };
	pc.dispatch("icecandidate", candidate);
	assert.equal(fixture.candidateEvents.length, 1);
	assert.equal(fixture.candidateEvents[0], candidate);
	pc.iceConnectionState = "failed";
	pc.dispatch("iceconnectionstatechange", {});
	await assert.rejects(connecting, /就绪前关闭/);
	assert.equal(conn.closed, true);
	assert.equal(fixture.clock.tasks.size, 0);
	client.destory();
});

test("successful connection removes only temporary listeners and retains ticket metadata", async () => {
	const fixture = peerFixture();
	const client = await fixture.create();
	const connecting = client.linkToHost("host", "test-ticket");
	const conn = fixture.peers[0].conn;
	conn.open = true;
	conn.emit("open");
	assert.equal((await connecting).conn, conn);
	assert.equal(conn.options.metadata.ticket, "test-ticket");
	assert.equal(fixture.clock.tasks.size, 0);
	assert.equal(fixture.peers[0].listenerCount("error"), 1);
	assert.equal(client.isUsable(), true);
	fixture.peers[0].disconnected = true;
	assert.equal(client.isUsable(), false);
	await assert.rejects(client.linkToHost("host", "new-ticket"), /已断开/);
	client.destory();
});
