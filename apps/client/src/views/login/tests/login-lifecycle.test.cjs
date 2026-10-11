const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));

function deferred() {
	let resolve;
	const promise = new Promise((done) => { resolve = done; });
	return { promise, resolve };
}

function auth(token = "session-1:1") {
	return {
		token, refreshToken: "refresh", expiresAt: Date.now() + 120_000, refreshExpiresAt: Date.now() + 3600_000,
		account: { id: "10", useraccount: "player", username: "新登录账号", avatarUrl: null, color: null, status: "ACTIVE", isAdmin: false, isCreator: false },
	};
}

function runComponent(file, dependencies, exposed, globals = {}) {
	const source = fs.readFileSync(path.join(clientRoot, file), "utf8");
	const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
	const compiled = ts.transpileModule(script + "\nexports.state = { " + exposed + " };", {
		reportDiagnostics: true,
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	assert.equal(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
	const exports = {};
	vm.runInNewContext(compiled.outputText, {
		exports, AbortController, console,
		require(name) {
			if (name in dependencies) return dependencies[name];
			if (name.endsWith(".vue") || name === "@fortawesome/vue-fontawesome" || name === "@src/components/hero-title") return {};
			throw new Error("Unexpected dependency: " + name);
		},
		...globals,
	}, { filename: file });
	return exports.state;
}

// Execute the production page script; mock HTTP, stores, renderer and route boundaries only.
function pageFixture(ensure = async () => auth().account) {
	let current = null;
	const hooks = {};
	const listeners = new Map();
	const calls = { me: 0, identity: [], refresh: 0, routes: [] };
	const router = { currentRoute: { value: { query: {} } }, replace(value) { calls.routes.push(value); return Promise.resolve(); } };
	const state = runComponent("src/views/login/login.vue", {
		vue: {
			ref: (value) => ({ value }), reactive: (value) => value, nextTick: async () => {},
			onBeforeUnmount(fn) { hooks.unmount = fn; }, onMounted(fn) { hooks.mount = fn; }, watch() {},
		},
		"@src/router": router,
		"@src/utils": { randomString: () => "local", setTimeOutAsync: async () => {} },
		"@src/utils/api": {
			async ensureValidAuth() { calls.me++; return ensure(); },
			startTokenRefreshTimer() { calls.refresh++; },
		},
		"@src/utils/auth/session": { tokenClaims(token) { return token ? { sessionId: token.split(":")[0] } : null; } },
		"@src/utils/auth": {
			getAccountToken: () => current?.token ?? null, getAccountProfile: () => current?.account ?? null,
			getActiveRealm: () => null, getCurrentRealmUser: () => null, clearRealmSession() {}, selectRealm: async () => {}, logoutAccount: async () => {},
		},
		"@mine-monopoly/ui": { FPMessage() {} },
		"@src/store": { useUserInfo: () => ({ setAccountIdentity(value) { calls.identity.push(value); }, setLocalIdentity() {}, setRealmIdentity() {} }) },
		"@src/core/three/LoginDiceRenderer": { LoginDiceRenderer: class {} },
		"@src/directives": {},
	}, "handleFirstClick, handleLoginSuccess, loadAccount, showServers, showLoginMode, showUserLogin, accountName", {
		window: { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } },
		document: { getElementById: () => null }, localStorage: { setItem() {} },
	});
	return { state, calls, hooks, setAuth(value) { current = value; }, sessionChanged() { listeners.get("monopoly-session-change")?.({ detail: { parentChanged: true } }); } };
}

test("a fresh successful login uses its verified response and skips the redundant account/me request", async () => {
	const f = pageFixture();
	const login = auth();
	f.setAuth(login);
	await f.state.handleLoginSuccess(login);
	assert.equal(f.calls.me, 0);
	assert.deepEqual(f.calls.identity, [login.account]);
	assert.equal(f.state.accountName.value, login.account.username);
	assert.equal(f.state.showServers.value, true);
	assert.equal(f.calls.refresh, 1);
});

test("restoring cached credentials still validates account/me before showing servers", async () => {
	const verified = { ...auth().account, username: "服务端最新名字" };
	const f = pageFixture(async () => verified);
	f.setAuth(auth());
	await f.state.handleFirstClick();
	assert.equal(f.calls.me, 1);
	assert.deepEqual(f.calls.identity, [verified]);
	assert.equal(f.state.accountName.value, verified.username);
});

test("rejected cached credentials show login choices rather than trusting the old profile", async () => {
	const f = pageFixture(async () => null);
	f.setAuth(auth());
	await f.state.handleFirstClick();
	assert.equal(f.calls.me, 1);
	assert.equal(f.calls.identity.length, 0);
	assert.equal(f.state.showServers.value, false);
	assert.equal(f.state.showLoginMode.value, true);
});

test("a replaced login response cannot change the current account or close its login form", async () => {
	const f = pageFixture();
	f.setAuth(auth("replacement-session:1"));
	f.state.showUserLogin.value = true;
	await f.state.handleLoginSuccess(auth());
	assert.equal(f.calls.me, 0);
	assert.equal(f.calls.identity.length, 0);
	assert.equal(f.state.showUserLogin.value, true);
});

test("a delayed restored profile cannot overwrite a fresh login that skipped account/me", async () => {
	const me = deferred();
	const f = pageFixture(() => me.promise);
	f.setAuth(auth("old-session:1"));
	const restoring = f.state.handleFirstClick();
	const login = auth("new-session:1");
	f.setAuth(login);
	await f.state.handleLoginSuccess(login);
	me.resolve({ ...login.account, username: "旧请求的名字" });
	await restoring;
	assert.equal(f.calls.me, 1);
	assert.deepEqual(f.calls.identity, [login.account]);
	assert.equal(f.state.accountName.value, login.account.username);
});

test("a delayed profile is ignored when another tab changes the parent session before its event", async () => {
	const me = deferred();
	const f = pageFixture(() => me.promise);
	f.setAuth(auth());
	const restoring = f.state.handleFirstClick();
	f.setAuth(auth("replacement-session:1"));
	me.resolve(auth().account);
	await restoring;
	assert.equal(f.calls.identity.length, 0);
});

test("refreshing the same parent session during account/me still allows valid restoration", async () => {
	const me = deferred();
	const f = pageFixture(() => me.promise);
	f.setAuth(auth());
	const restoring = f.state.handleFirstClick();
	f.setAuth(auth("session-1:2"));
	me.resolve(auth().account);
	await restoring;
	assert.equal(f.calls.identity.length, 1);
	assert.equal(f.state.showServers.value, true);
});

test("unmount ignores both fresh login and delayed restored profile responses", async () => {
	const me = deferred();
	const f = pageFixture(() => me.promise);
	const login = auth();
	f.setAuth(login);
	const restoring = f.state.handleFirstClick();
	f.hooks.unmount();
	await f.state.handleLoginSuccess(login);
	me.resolve(login.account);
	await restoring;
	assert.equal(f.calls.identity.length, 0);
	assert.equal(f.calls.refresh, 0);
});

function formFixture(login) {
	const unmount = [];
	const events = [];
	const state = runComponent("src/views/login/components/login-form.vue", {
		vue: { ref: (value) => ({ value }), reactive: (value) => value, onBeforeUnmount(fn) { unmount.push(fn); } },
		"@src/utils/api/auth": { apiLogin: login, apiRegister: async () => true },
		"@mine-monopoly/ui": { FPMessage() {} },
	}, "handleLogin, loginForm, isLoading", {
		defineEmits: () => (...args) => events.push(args), URL: { revokeObjectURL() {} },
	});
	state.loginForm.useraccount = "player";
	state.loginForm.password = "test-password";
	return { state, events, unmount() { unmount.forEach((fn) => fn()); } };
}

test("the login form passes the fresh account response to the page and clears the password", async () => {
	const login = auth();
	const f = formFixture(async () => login);
	await f.state.handleLogin();
	assert.deepEqual(f.events, [["success", login]]);
	assert.equal(f.state.loginForm.password, "");
	assert.equal(f.state.isLoading.value, false);
});

test("an unmounted form cannot emit a late successful login even when its HTTP boundary ignores abort", async () => {
	const pending = deferred();
	let signal;
	const f = formFixture((_account, _password, value) => { signal = value; return pending.promise; });
	const login = f.state.handleLogin();
	f.unmount();
	assert.equal(signal.aborted, true);
	pending.resolve(auth());
	await login;
	assert.equal(f.events.length, 0);
	assert.equal(f.state.isLoading.value, false);
});
