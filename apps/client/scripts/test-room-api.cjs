const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../../..")] }));
const clientRoot = path.resolve(__dirname, "..");
let realm = { sessionId: "realm-session-1", serverId: "11", roleId: "22" };
let realmToken = "fixture-realm-token";
const calls = [];
let nextResult;
let deferredPost;
const api = {
	async get(url, config) {
		calls.push({ method: "GET", url, config });
		return { data: nextResult };
	},
	async post(url, body, config) {
		calls.push({ method: "POST", url, body, config });
		if (deferredPost) {
			const pending = deferredPost;
			deferredPost = undefined;
			return pending;
		}
		return { data: nextResult };
	},
};
const globalConfig = { __MONOPOLYSERVER__: "/monopoly-api" };
const context = {
	console,
	URL,
	TextDecoder,
	TextEncoder,
	crypto: webcrypto,
	location: { origin: "https://client.example.test" },
};
function load(relative, dependencies, extras = {}) {
	const source = fs.readFileSync(path.join(clientRoot, relative), "utf8").replace(/import\.meta\.env/g, "({})");
	const code = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		code,
		{
			...context,
			...extras,
			module,
			exports: module.exports,
			require(name) {
				if (!(name in dependencies)) throw new Error("Unexpected dependency: " + name);
				return dependencies[name];
			},
		},
		{ filename: relative },
	);
	return module.exports;
}
const maps = load("src/utils/api/map.ts", { "./index": api, "@src/../global.config": globalConfig });
let exitCall;
const rooms = load(
	"src/utils/api/room-router.ts",
	{
		"./index": api,
		"@src/../global.config": globalConfig,
		"./map": maps,
		"@src/utils/auth/session": { getActiveRealm: () => realm, getRealmToken: () => realmToken },
	},
	{
		fetch: async (url, options) => {
			exitCall = { url, options };
			return { ok: true, json: async () => ({ code: 200 }) };
		},
	},
);
const room = {
	id: "101",
	serverId: "11",
	roomCode: "ABC123",
	roomSessionId: "room-session-1",
	hostRoleId: "22",
	hostName: "Host",
	hostEpoch: 0,
	state: "active",
	hostReady: false,
	privateRoom: true,
	started: false,
	capacity: 6,
	occupiedSeats: 1,
	mapId: "44",
	mapName: "Frozen",
	mapVersion: "1.0.0",
	mapUrl: "/monopoly-api/files/monopoly-mine/maps/old.fpmap",
	mapHash: "a".repeat(64),
	createdTime: 1,
	leaseExpiresAt: 30001,
	heartbeatIntervalMs: 5000,
};
const tests = [];
function test(name, fn) {
	tests.push([name, fn]);
}
test("REALM join and match use POST and per-operation request identity", async () => {
	const request = {
		roomCode: "ABC123",
		requestId: "request-0000001",
		peerId: "player-peer-1",
		mapId: "44",
		capacity: 6,
		privateRoom: true,
	};
	nextResult = { matched: true, needCreate: true, room, hostLeaseToken: "fixture-host-lease-token", iceServers: [] };
	assert.equal((await rooms.joinRoomApi(request)).room.id, "101");
	const call = calls.at(-1);
	assert.equal(call.method, "POST");
	assert.equal(call.url, "/rooms/join");
	assert.equal(call.config.identity, "realm");
	assert.equal(call.config.expectedRealmSessionId, "realm-session-1");
	assert.equal(call.body.requestId, request.requestId);
	assert.equal("serverId" in call.body, false);
	nextResult = { matched: false, needCreate: false, iceServers: [] };
	assert.equal((await rooms.matchRoomApi({ requestId: "request-0000002", peerId: "player-peer-1" })).matched, false);
	assert.equal(calls.at(-1).url, "/rooms/match");
});
test("ready and rotated leases update epoch without discarding an omitted lease token", async () => {
	nextResult = {
		roomSessionId: room.roomSessionId,
		hostEpoch: 1,
		state: "active",
		leaseExpiresAt: 40000,
		heartbeatIntervalMs: 5000,
	};
	await rooms.readyHostRoom("101", {
		hostPeerId: "host-peer-1",
		hostEpoch: 0,
		hostLeaseToken: "fixture-host-lease-token",
	});
	nextResult = { ...room, hostEpoch: 1, privateRoom: false };
	await rooms.setRoomPrivate("101", false);
	const call = calls.at(-1);
	assert.equal(call.url, "/rooms/101/privacy");
	assert.equal(call.body.hostEpoch, 1);
	assert.equal(call.body.hostLeaseToken, "fixture-host-lease-token");
	assert.equal(call.body.privateRoom, false);
	assert.equal(call.config.silent, true);
});
test("member tickets bind actual Peer identity and consume with the host lease", async () => {
	nextResult = {
		ticket: "fixture-single-use-ticket",
		roleId: "22",
		roomSessionId: room.roomSessionId,
		hostEpoch: 1,
		peerId: "player-peer-1",
		expiresAt: 50000,
	};
	await rooms.issueRoomTicket("101", "player-peer-1");
	assert.equal(calls.at(-1).url, "/rooms/101/tickets");
	assert.equal(calls.at(-1).body.peerId, "player-peer-1");
	await rooms.consumeRoomTicket("101", {
		hostLeaseToken: "fixture-host-lease-token",
		hostEpoch: 1,
		ticket: "fixture-single-use-ticket",
		actualPeerId: "player-peer-1",
	});
	assert.equal(calls.at(-1).url, "/rooms/101/tickets/consume");
	assert.equal(calls.at(-1).body.actualPeerId, "player-peer-1");
	assert.equal(calls.at(-1).config.identity, "realm");
});
test("published map adapters isolate candidates, normalize URLs and cap page size", async () => {
	const row = {
		id: "44",
		name: "Current",
		author: "A",
		publishCount: 2,
		contentVersion: "2.0.0",
		hash: "b".repeat(64),
		mapUrl: "/monopoly-api/files/monopoly-mine/maps/new.fpmap",
		coverUrl: "/monopoly-api/files/monopoly-mine/covers/a.png",
		sourceUrl: null,
		official: true,
		creatorId: null,
		creatorName: null,
		description: null,
		changelog: [{ publishCount: 2, contentVersion: "2.0.0", content: "Updated", createdAt: 1 }],
		candidate: { mapUrl: "/private-candidate" },
	};
	nextResult = { total: 1, current: 1, records: [row] };
	const list = await maps.getGameMapList(1, 1000);
	assert.equal(calls.at(-1).config.params.size, 100);
	assert.equal(calls.at(-1).config.identity, "realm");
	assert.equal(
		list.gameMapList[0].mapUrl,
		"https://client.example.test/monopoly-api/files/monopoly-mine/maps/new.fpmap",
	);
	assert.equal(list.gameMapList[0].pendingUrl, null);
	assert.equal(list.gameMapList[0].version, 2);
	assert.equal(list.gameMapList[0].changelog[0].semver, "2.0.0");
	assert.equal(
		maps.getFrozenRoomMap("101").mapUrl,
		"https://client.example.test/monopoly-api/files/monopoly-mine/maps/old.fpmap",
	);
	assert.equal(maps.getFrozenRoomMap("101").hash, "a".repeat(64));
	assert.throws(() => maps.resolveMapResourceUrl("javascript:alert(1)"));
});
test("resource URLs retain the deployment API gateway prefix", async () => {
	globalConfig.__MONOPOLYSERVER__ = "https://api.example.test/backend/monopoly-api";
	assert.equal(
		maps.resolveMapResourceUrl("/monopoly-api/files/monopoly-mine/maps/a.fpmap"),
		"https://api.example.test/backend/monopoly-api/files/monopoly-mine/maps/a.fpmap",
	);
	assert.equal(
		maps.resolveMapResourceUrl("https://cos.example.test/maps/a.fpmap"),
		"https://cos.example.test/maps/a.fpmap",
	);
	globalConfig.__MONOPOLYSERVER__ = "/monopoly-api";
});
test("Electron file origin resolves resources against the explicitly configured API", async () => {
	context.location.origin = "null";
	globalConfig.__MONOPOLYSERVER__ = "https://api.example.test/backend/monopoly-api";
	assert.equal(
		maps.resolveMapResourceUrl("/monopoly-api/files/monopoly-mine/maps/a.fpmap"),
		"https://api.example.test/backend/monopoly-api/files/monopoly-mine/maps/a.fpmap",
	);
	context.location.origin = "https://client.example.test";
	globalConfig.__MONOPOLYSERVER__ = "/monopoly-api";
});
test("a switched REALM cannot send room commands", async () => {
	const before = calls.length;
	realm = { ...realm, sessionId: "realm-session-2" };
	assert.equal(rooms.getRegisteredRoom("101"), undefined);
	await assert.rejects(rooms.emitMemberHeart("101"), /区服身份已变更/);
	assert.equal(calls.length, before);
	realm = { ...realm, sessionId: "realm-session-1" };
});
test("keepalive close carries Bearer and lease in headers/body without token queries", async () => {
	await rooms.deleteRoom("101", { hostEpoch: 1, hostLeaseToken: "fixture-host-lease-token" }, true);
	assert.equal(exitCall.url, "/monopoly-api/rooms/101/close");
	assert.equal(exitCall.options.keepalive, true);
	assert.equal(exitCall.options.headers.Authorization, "Bearer fixture-realm-token");
	assert.equal(JSON.parse(exitCall.options.body).hostEpoch, 1);
	assert.equal(exitCall.url.includes("?"), false);
	assert.equal(maps.getFrozenRoomMap("101"), null);
});
test("delayed admission from an old REALM cannot enter the new session and closes its reserved room", async () => {
	let resolve;
	deferredPost = new Promise((complete) => {
		resolve = complete;
	});
	const pending = rooms.joinRoomApi({ roomCode: "ABC124", requestId: "request-delayed", peerId: "player-peer-1" });
	realm = { ...realm, sessionId: "realm-session-2" };
	realmToken = "fixture-new-realm-token";
	resolve({
		data: {
			matched: true,
			needCreate: true,
			room: { ...room, id: "102" },
			hostLeaseToken: "fixture-old-host-lease",
			iceServers: [],
		},
	});
	await assert.rejects(pending, /区服身份已变更/);
	assert.equal(exitCall.url, "/monopoly-api/rooms/102/close");
	assert.equal(exitCall.options.headers.Authorization, "Bearer fixture-realm-token");
	assert.equal(JSON.parse(exitCall.options.body).hostLeaseToken, "fixture-old-host-lease");
	assert.equal(rooms.getRegisteredRoom("102"), undefined);
	assert.equal(maps.getFrozenRoomMap("102"), null);
	realm = { ...realm, sessionId: "realm-session-1" };
	realmToken = "fixture-realm-token";
});
test("an unusable frozen map releases the admitted member instead of caching a partial room", async () => {
	nextResult = {
		matched: true,
		needCreate: false,
		room: { ...room, id: "103", mapHash: "" },
		hostPeerId: "host-peer",
		iceServers: [],
	};
	await assert.rejects(
		rooms.joinRoomApi({ roomCode: "ABC125", requestId: "request-missing-map", peerId: "player-peer-1" }),
		/冻结地图资源/,
	);
	assert.equal(exitCall.url, "/monopoly-api/rooms/103/leave");
	assert.equal(exitCall.options.body, undefined);
	assert.equal(rooms.getRegisteredRoom("103"), undefined);
	assert.equal(maps.getFrozenRoomMap("103"), null);
});
test("re-entering the same room under another REALM never inherits an old host lease", async () => {
	rooms.rememberRoomAdmission({
		matched: true,
		needCreate: true,
		room: { ...room, id: "104" },
		hostLeaseToken: "fixture-prior-lease",
		iceServers: [],
	});
	realm = { ...realm, sessionId: "realm-session-2" };
	rooms.rememberRoomAdmission({ matched: true, needCreate: false, room: { ...room, id: "104" }, iceServers: [] });
	const before = calls.length;
	await assert.rejects(rooms.setRoomPrivate("104", true), /没有房主租约/);
	assert.equal(calls.length, before);
	nextResult = undefined;
	await rooms.leaveRoom("104");
	realm = { ...realm, sessionId: "realm-session-1" };
});
const gameFile = load("src/utils/file/game-map.ts", {
	"@mine-monopoly/types": {},
	"@mine-monopoly/utils": {},
	"@mine-monopoly/utils/crypto": {},
	"@mine-monopoly/env": { env: () => "" },
	"@src/store": {},
	"../api/map": maps,
	"@src/store/game": {},
	"@src/utils": {},
	"three/examples/jsm/loaders/GLTFLoader": {},
	"../draco/draco": {},
});
test("frozen object SHA-256 rejects modified bytes", async () => {
	const bytes = new TextEncoder().encode("immutable frozen map").buffer;
	const digest = await webcrypto.subtle.digest("SHA-256", bytes);
	const expected = Buffer.from(digest).toString("hex");
	await gameFile.verifyMapFileHash(bytes, expected);
	await assert.rejects(gameFile.verifyMapFileHash(bytes, "0".repeat(64)), /SHA-256/);
});
(async () => {
	for (const [name, run] of tests) {
		await run();
		console.log("PASS " + name);
	}
	console.log(tests.length + " protocol checks passed");
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
