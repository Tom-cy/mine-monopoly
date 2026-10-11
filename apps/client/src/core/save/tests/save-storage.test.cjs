const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function load(file, dependencies = {}, environment = {}) {
	const module = { exports: {} };
	const { outputText } = ts.transpileModule(fs.readFileSync(path.resolve(clientRoot, file), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	vm.runInNewContext(outputText, {
		module,
		exports: module.exports,
		console,
		Date,
		...environment,
		require(name) {
			assert.ok(name in dependencies, "Unexpected dependency: " + name);
			return dependencies[name];
		},
	});
	return module.exports;
}

test("previousSnapshot comes from saveTime rather than random IndexedDB primary key order", async () => {
	const older = { currentRound: 3 };
	const newest = { currentRound: 7 };
	const { SaveManager } = load("src/core/save/SaveManager.ts", {
		"@src/utils/file/game-map": { normalizeAndValidateGameMap: (map) => map },
		"./IndexedDBSaveStorage": { IndexedDBSaveStorage: class {} },
		"@src/utils": { randomString: () => "fresh-save" },
	});
	const written = [];
	const manager = new SaveManager({
		async listByMap() { return [{ saveTime: 700, snapshot: newest }, { saveTime: 300, snapshot: older }]; },
		async save(record) { written.push(record); },
	});
	const result = await manager.save({ currentRound: 9, playerSnapshots: { "42": {} } }, "map", "1", "Map", ["Player"]);
	assert.equal(result.previousSnapshot, newest);
	assert.equal(written[0], result);
});

function storageFixture() {
	const transactions = [];
	const indexedDB = {
		open() {
			const request = { result: {
				transaction(name, mode) {
					const operation = { result: undefined };
					const store = Object.fromEntries(["put", "delete", "get", "getAll"].map((key) => [key, () => operation]));
					store.index = () => store;
					const tx = { mode, operation, objectStore: () => store };
					transactions.push(tx);
					return tx;
				},
			} };
			queueMicrotask(() => request.onsuccess());
			return request;
		},
	};
	const { IndexedDBSaveStorage } = load("src/core/save/IndexedDBSaveStorage.ts", {}, { indexedDB });
	return { storage: new IndexedDBSaveStorage(), transactions };
}

test("a successful save request is not reported complete before its transaction commits", async () => {
	const fixture = storageFixture();
	let completed = false;
	const saving = fixture.storage.save({ id: "record" }).then(() => { completed = true; });
	await flush();
	const tx = fixture.transactions[0];
	tx.operation.onsuccess?.();
	await flush();
	assert.equal(completed, false);
	tx.oncomplete();
	await saving;
	assert.equal(completed, true);
});

test("late transaction abort after a successful write rejects both saving and deletion", async () => {
	for (const method of ["save", "delete"]) {
		const fixture = storageFixture();
		let status = "pending";
		const operation = fixture.storage[method](method === "save" ? { id: "record" } : "record");
		operation.then(() => { status = "fulfilled"; }, () => { status = "rejected"; });
		await flush();
		const tx = fixture.transactions[0];
		tx.operation.onsuccess?.();
		await flush();
		assert.equal(status, "pending", method);
		tx.error = new Error("quota or disk failure");
		tx.onabort();
		await assert.rejects(operation, /quota or disk failure/);
		assert.equal(status, "rejected");
	}
});
