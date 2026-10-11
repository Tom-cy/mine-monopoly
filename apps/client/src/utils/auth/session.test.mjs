import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const axios = require("axios");
const sessionPath = fileURLToPath(new URL("./session.ts", import.meta.url));
const apiPath = fileURLToPath(new URL("../api/index.ts", import.meta.url));
const authPath = fileURLToPath(new URL("../api/auth.ts", import.meta.url));

function fixture(accountId = "10", sessionId = "account-session", version = 1) {
	const token = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
	const account = {
		token: token({ tokenType: "ACCOUNT", accountId, sessionId, version }),
		refreshToken: `refresh-${accountId}-${version}`,
		expiresAt: Date.now() + 120_000,
		refreshExpiresAt: Date.now() + 3600_000,
		account: {
			id: accountId,
			useraccount: "player",
			username: "账号名",
			avatarUrl: "/avatar.png",
			color: null,
			status: "ACTIVE",
			isAdmin: false,
			isCreator: false,
		},
	};
	const realm = {
		token: token({
			tokenType: "REALM",
			accountId,
			accountSessionId: sessionId,
			sessionId: "realm-session",
			serverId: "20",
			roleId: "30",
		}),
		expiresAt: Date.now() + 60_000,
		accountId,
		serverId: "20",
		roleId: "30",
		nickname: "区服角色名",
	};
	return { account, realm };
}

function loadTypeScript(path, dependencies, globals) {
	const source = ts.transpileModule(readFileSync(path, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	}).outputText;
	const exports = {};
	vm.runInNewContext(
		source,
		{
			exports,
			require: (name) => {
				if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
				return dependencies[name];
			},
			...globals,
		},
		{ filename: path },
	);
	return exports;
}

function harness(
	adapter = async (config) => ({ data: { code: 200, data: { ok: true } }, status: 200, config }),
	refresh = async () => {
		throw new Error("Unexpected refresh");
	},
	options = {},
) {
	const values = options.values ?? new Map([["token", "old-node-token"]]);
	const navigation = [];
	const messages = [];
	const globals = {
		localStorage: {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value),
			removeItem: (key) => values.delete(key),
		},
		atob: (value) => Buffer.from(value, "base64").toString("binary"),
		TextDecoder,
		Uint8Array,
		URL,
		setTimeout: () => 1,
		clearTimeout: () => {},
		document: { addEventListener: () => {} },
	};
	if (options.origin)
		globals.window = {
			location: { origin: options.origin },
			addEventListener: () => {},
			Capacitor: options.native ? { isNativePlatform: () => true } : undefined,
		};
	if (options.navigator) globals.navigator = options.navigator;
	const session = loadTypeScript(sessionPath, {}, globals);
	const clientAxios = {
		create: (config) => axios.create({ ...config, adapter }),
		post: refresh,
		isAxiosError: axios.isAxiosError,
		isCancel: axios.isCancel,
	};
	const api = loadTypeScript(
		apiPath,
		{
			axios: { __esModule: true, default: clientAxios, AxiosError: axios.AxiosError },
			"@mine-monopoly/ui": { FPMessage: (value) => messages.push(value) },
			"@src/../global.config": { __MONOPOLYSERVER__: options.apiBase ?? "/monopoly-api" },
			"../auth/session": session,
			"./resources": { resolveAccountProfile: (profile) => profile },
			"../auth": {
				resetOnlineIdentityAndRedirect: async (realmOnly) => {
					navigation.push(realmOnly);
				},
			},
		},
		globals,
	);
	const auth = loadTypeScript(
		authPath,
		{
			"./index": api,
			"@mine-monopoly/ui": { FPMessage: (value) => messages.push(value) },
			"../auth/session": session,
			"./resources": { resolveAccountProfile: (profile) => profile },
			"./user": { getAccountInfo: async () => session.getAccountProfile() },
		},
		globals,
	);
	return { session, api, auth, values, navigation, messages };
}

test("separate bearer identities, Result unwrap, and role identity preserve precision", async () => {
	const sent = [];
	const h = harness(async (config) => {
		sent.push(config);
		return { data: { code: 200, data: { id: "9007199254740993123" } }, status: 200, config };
	});
	const { account, realm } = fixture();
	h.session.saveAccountSession(account);
	h.session.saveRealmSession(realm);
	assert.equal(h.values.has("token"), false);
	assert.equal(h.session.getCurrentRealmUser().userId, "30");
	assert.equal(h.session.getCurrentRealmUser().username, "区服角色名");
	assert.equal((await h.api.default.get("/account/me", { identity: "account" })).data.id, "9007199254740993123");
	await h.api.default.get("/rooms", { identity: "realm" });
	await h.api.default.get("/health", { identity: "none" });
	assert.equal(sent[0].headers.Authorization, `Bearer ${account.token}`);
	assert.equal(sent[1].headers.Authorization, `Bearer ${realm.token}`);
	assert.equal(sent[2].headers.Authorization, undefined);
});

test("concurrent ACCOUNT expiry rotates once, retries once with the new token, retains REALM", async () => {
	let rotations = 0;
	const old = fixture();
	const updated = fixture("10", "account-session", 2).account;
	const h = harness(
		async (config) => ({
			data:
				config.headers.Authorization === `Bearer ${old.account.token}`
					? { code: 46001, msg: "expired" }
					: { code: 200, data: "ok" },
			status: 200,
			config,
		}),
		async () => {
			rotations++;
			await new Promise((resolve) => setTimeout(resolve, 10));
			return { data: { code: 200, data: updated } };
		},
	);
	h.session.saveAccountSession(old.account);
	h.session.saveRealmSession(old.realm);
	const result = await Promise.all(Array.from({ length: 12 }, () => h.api.default.get("/account/me")));
	assert.equal(rotations, 1);
	assert.ok(result.every((item) => item.data === "ok"));
	assert.equal(h.session.getRealmToken(), old.realm.token);
});

test("repeated ACCOUNT rejection is bounded and clears credentials", async () => {
	let calls = 0;
	let rotations = 0;
	const h = harness(
		async (config) => {
			calls++;
			return { data: { code: 46001, msg: "expired" }, status: 200, config };
		},
		async () => {
			rotations++;
			return { data: { code: 200, data: fixture("10", "account-session", 2).account } };
		},
	);
	h.session.saveAccountSession(fixture().account);
	await assert.rejects(h.api.default.get("/account/me"), (error) => error.code === 46001);
	assert.equal(calls, 2);
	assert.equal(rotations, 1);
	assert.equal(h.session.getAccountToken(), null);
});

test("HTTP200 business failure rejects; REALM expiry never rotates ACCOUNT", async () => {
	let rotations = 0;
	const h = harness(
		async (config) => ({
			data: { code: config.url === "/rooms" ? 46002 : 46000, msg: "failure" },
			status: 200,
			config,
		}),
		async () => {
			rotations++;
		},
	);
	const { account, realm } = fixture();
	h.session.saveAccountSession(account);
	h.session.saveRealmSession(realm);
	await assert.rejects(h.api.default.get("/bad", { identity: "none" }), (error) => error.code === 46000);
	await assert.rejects(h.api.default.get("/rooms", { identity: "realm" }), (error) => error.code === 46002);
	assert.equal(rotations, 0);
	assert.equal(h.session.getAccountToken(), account.token);
	assert.equal(h.session.getRealmToken(), null);
});

test("in-flight refresh cannot resurrect logout or overwrite a different login", async () => {
	let resolve;
	const h = harness(
		undefined,
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	h.session.saveAccountSession(fixture().account);
	const pending = h.api.doRefresh();
	h.session.clearAccountSession();
	const replacement = fixture("99", "another-session").account;
	h.session.saveAccountSession(replacement);
	resolve({ data: { code: 200, data: fixture("10", "account-session", 2).account } });
	assert.equal(await pending, false);
	assert.equal(h.session.getAccountToken(), replacement.token);
});

test("an old ACCOUNT request is never replayed with another player's credentials", async () => {
	let release;
	let calls = 0;
	const h = harness((config) => {
		calls++;
		return new Promise((resolve) => {
			release = () => resolve({ data: { code: 46001 }, status: 200, config });
		});
	});
	h.session.saveAccountSession(fixture().account);
	const pending = h.api.default.post("/servers/20/enter");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const replacement = fixture("99", "another-session").account;
	h.session.saveAccountSession(replacement);
	release();
	await assert.rejects(pending, (error) => error.code === 46001);
	assert.equal(calls, 1);
	assert.equal(h.session.getAccountToken(), replacement.token);
});

test("REALM requires its ACCOUNT parent and uses millisecond expiry", () => {
	const h = harness();
	h.session.saveAccountSession(fixture().account);
	assert.throws(() => h.session.saveRealmSession(fixture("99", "another-session").realm));
	const { realm } = fixture();
	h.session.saveRealmSession({ ...realm, expiresAt: Date.now() - 1 });
	assert.equal(h.session.getRealmToken(), null);
	assert.equal(h.session.getCurrentRealmUser(), null);
});

test("browser refresh lock observes another tab's rotated credential instead of replaying it", async () => {
	let lock = Promise.resolve();
	let rotations = 0;
	const locks = {
		request: (_name, action) => {
			const result = lock.then(action);
			lock = result.catch(() => {});
			return result;
		},
	};
	const options = { values: new Map(), origin: "http://localhost:5173", navigator: { locks } };
	const refresh = async () => {
		rotations++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { data: { code: 200, data: fixture("10", "account-session", 2).account } };
	};
	const first = harness(undefined, refresh, options);
	first.session.saveAccountSession(fixture().account);
	first.session.saveRealmSession(fixture().realm);
	const second = harness(undefined, refresh, options);
	assert.equal(second.session.getAccountToken(), first.session.getAccountToken());
	assert.deepEqual(await Promise.all([first.api.doRefresh(), second.api.doRefresh()]), [true, true]);
	assert.equal(rotations, 1);
	assert.equal(second.session.getAccountToken(), first.session.getAccountToken());
	assert.equal(second.session.getRealmToken(), first.session.getRealmToken());
});

test("credentials require HTTPS except loopback development", () => {
	assert.doesNotThrow(() =>
		harness(undefined, undefined, { origin: "https://game.example" }).api.assertCredentialTransport(),
	);
	assert.doesNotThrow(() =>
		harness(undefined, undefined, { origin: "http://localhost:5173" }).api.assertCredentialTransport(),
	);
	assert.throws(
		() => harness(undefined, undefined, { origin: "http://game.example" }).api.assertCredentialTransport(),
		(error) => error.code === 46000,
	);
	assert.throws(
		() => harness(undefined, undefined, { origin: "null" }).api.assertCredentialTransport(),
		(error) => error.code === 46000,
	);
	assert.throws(
		() => harness(undefined, undefined, { origin: "http://localhost", native: true }).api.assertCredentialTransport(),
		(error) => error.code === 46000,
	);
	assert.doesNotThrow(() =>
		harness(undefined, undefined, {
			origin: "null",
			apiBase: "https://game.example/monopoly-api",
		}).api.assertCredentialTransport(),
	);
});

test("a request bound to an old REALM never sends or clears the current REALM", async () => {
	let calls = 0;
	const h = harness(async (config) => {
		calls++;
		return { data: { code: 200 }, status: 200, config };
	});
	const { account, realm } = fixture();
	h.session.saveAccountSession(account);
	h.session.saveRealmSession(realm);
	await assert.rejects(
		h.api.default.get("/rooms", { identity: "realm", expectedRealmSessionId: "old-realm-session" }),
		(error) => error.code === 46002 && error.staleIdentity,
	);
	assert.equal(calls, 0);
	assert.equal(h.session.getRealmToken(), realm.token);
	assert.equal(h.navigation.length, 0);
	assert.equal(h.messages.length, 0);
});

test("closing the login form cancels a delayed successful response without saving credentials", async () => {
	let release;
	const h = harness(
		(config) =>
			new Promise((resolve) => {
				release = () => resolve({ data: { code: 200, data: fixture().account }, status: 200, config });
			}),
	);
	const controller = new AbortController();
	const pending = h.auth.apiLogin("player", "test-password", controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort();
	release();
	assert.equal(await pending, null);
	assert.equal(h.session.getAccountToken(), null);
	assert.equal(h.messages.length, 0);
});

test("a delayed login cannot replace a newer login", async () => {
	let release;
	const h = harness(
		(config) =>
			new Promise((resolve) => {
				release = () => resolve({ data: { code: 200, data: fixture().account }, status: 200, config });
			}),
	);
	const pending = h.auth.apiLogin("player", "test-password");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const replacement = fixture("99", "replacement-session").account;
	h.session.saveAccountSession(replacement);
	release();
	assert.equal(await pending, null);
	assert.equal(h.session.getAccountToken(), replacement.token);
});

test("a server selection bound to an old ACCOUNT cannot send with a replacement login", async () => {
	let calls = 0;
	const h = harness(async (config) => {
		calls++;
		return { data: { code: 200 }, status: 200, config };
	});
	const replacement = fixture("99", "replacement-session").account;
	h.session.saveAccountSession(replacement);
	await assert.rejects(
		h.api.default.post("/servers/20/enter", undefined, {
			identity: "account",
			expectedAccountSessionId: "account-session",
		}),
		(error) => error.code === 46001 && error.staleIdentity,
	);
	assert.equal(calls, 0);
	assert.equal(h.session.getAccountToken(), replacement.token);
	assert.equal(h.navigation.length, 0);
});
