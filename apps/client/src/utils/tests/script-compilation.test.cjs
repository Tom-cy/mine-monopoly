const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const clientRoot = path.resolve(__dirname, "../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));
const editorTypes = fs.readFileSync(path.join(clientRoot, "src/core/worker/editor-lib.d.ts"), "utf8");

function load(relative, dependencies) {
	const module = { exports: {} };
	const { outputText } = ts.transpileModule(fs.readFileSync(path.join(clientRoot, relative), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	vm.runInNewContext(outputText, {
		module,
		exports: module.exports,
		require(name) {
			assert.ok(name in dependencies, "Unexpected dependency: " + name);
			return dependencies[name];
		},
	});
	return module.exports;
}

const { compileTsToJs } = load("src/utils/index.ts", {
	lodash: require(require.resolve("lodash", { paths: [clientRoot] })),
	three: require(require.resolve("three", { paths: [clientRoot] })),
	typescript: ts,
});
const { allRuntimeEnums } = load("src/core/worker/runtime-enums.ts", {
	"./editor-lib.d.ts?raw": { __esModule: true, default: editorTypes },
});

test("real editor declarations and ambient creator bindings are erased instead of becoming invalid JavaScript", () => {
	const types = `${editorTypes}\n
declare const creatorExtension: string;
declare function creatorHelper(value: number): number;
declare class CreatorExtension { readonly name: string; }
declare namespace CreatorNamespace { const value: number; }
`;
	const compiled = compileTsToJs("return async (player: IPlayer) => player;", types);
	assert.doesNotThrow(() => new Function(compiled));
	assert.doesNotMatch(compiled, /creatorExtension|creatorHelper|CreatorNamespace|class CreatorExtension/);
});

test("real Worker runtime enums remain available to compiled map scripts without local redeclarations", () => {
	const entries = Object.entries(allRuntimeEnums).map(([name, members]) => [name, Object.entries(members)[0]]);
	assert.ok(entries.length >= 9, "use the complete real runtime-enums module");
	const code = `return [${entries.map(([name, [member]]) => `${name}.${member}`).join(",")}];`;
	const compiled = compileTsToJs(code, editorTypes);
	const globals = Object.fromEntries(Object.entries(allRuntimeEnums).map(([name, members]) => [name, Object.freeze({ ...members })]));
	const result = vm.runInNewContext("new Function(code)()", { code: compiled, ...globals });
	assert.deepEqual(Array.from(result), entries.map(([, [, value]]) => value));
	for (const [name] of entries) assert.doesNotMatch(compiled, new RegExp(`(?:var|let|const) ${name}\\b`));
});

test("extraLib executable helpers and namespaces are preserved together with ambient types", () => {
	const types = `${editorTypes}\n
declare const creatorExtension: string;
function declaredBonus(value: number): number { return value + 7; }
namespace CreatorTools {
	export const label = "declare const stays in a string";
	export function reward(value: number): number { return declaredBonus(value) * 2; }
}
`;
	const compiled = compileTsToJs("return [CreatorTools.reward(5), CreatorTools.label];", types);
	assert.deepEqual(new Function(compiled)(), [24, "declare const stays in a string"]);
});

test("script strings and names containing declare are not rewritten", () => {
	const compiled = compileTsToJs('return declaredName;', 'const declaredName = "declare is data";');
	assert.equal(new Function(compiled)(), "declare is data");
});

test("all scripts from the real editor fpmap fixture create valid Functions with its extraLibs", () => {
	const fixtureRoot = path.resolve(clientRoot, "../../../game-admin/src/views/mineMonopoly/editor/tests/fixtures");
	const protobuf = require(require.resolve("protobufjs", { paths: [clientRoot] }));
	const schema = protobuf.parse(fs.readFileSync(path.join(fixtureRoot, "game-map.proto"), "utf8")).root.lookupType("GameMap");
	const decoded = schema.decode(fs.readFileSync(path.join(fixtureRoot, "editor-sample.fpmap")));
	const map = JSON.parse(decoded.jsonData);
	assert.equal(map.extraLibs, "declare const creatorExtension: string;");
	const scripts = [];
	function collect(value, location = "map") {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			const currentPath = `${location}.${key}`;
			if (key.endsWith("Code") && typeof child === "string" && child.trim()) scripts.push([currentPath, child]);
			else if (typeof child === "object") collect(child, currentPath);
		}
	}
	collect(map);
	assert.ok(scripts.some(([location]) => location.includes("roles")), "fixture must include role initialization");
	assert.ok(scripts.some(([location]) => location.includes("phases")), "fixture must include real game phases");
	assert.ok(scripts.some(([location]) => location.includes("chanceCards")), "fixture must include chance cards");
	assert.ok(scripts.some(([location]) => location.includes("mapEvents")), "fixture must include map events");
	assert.ok(scripts.some(([location]) => location.includes("property")), "fixture must include property effects");
	for (const [location, source] of scripts) {
		const compiled = compileTsToJs(source, `${editorTypes}\n${map.extraLibs}`);
		assert.doesNotThrow(() => new Function(compiled), location);
		assert.doesNotMatch(compiled, /const creatorExtension\b/, location);
	}
});
