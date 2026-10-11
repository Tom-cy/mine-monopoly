const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const ts = require(require.resolve("typescript", { paths: [clientRoot] }));

function load(file, dependencies = {}, environment = {}) {
	const module = { exports: {} };
	const { outputText } = ts.transpileModule(fs.readFileSync(path.resolve(clientRoot, file), "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
	});
	vm.runInNewContext(outputText, {
		module,
		exports: module.exports,
		console,
		crypto: webcrypto,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		...environment,
		require(name) {
			assert.ok(name in dependencies, "Unexpected dependency: " + name);
			return dependencies[name];
		},
	});
	return module.exports;
}

function fixture() {
	const messages = [];
	const executed = [];
	const types = {
		...load("../../packages/types/enums/game/base.ts"),
		...load("../../packages/types/enums/game/game-process.ts"),
		...load("../../packages/types/enums/game/game.ts"),
	};
	const workerTypes = load("src/enums/worker.ts");
	const utils = {
		randomString: () => "fixture-id",
		compileTsToJs: (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
	};
	const common = {
		"@mine-monopoly/types": types,
		"@src/utils": utils,
		"../editor-lib.d.ts?raw": { __esModule: true, default: "" },
	};
	const phaseClass = load("src/core/worker/class/GamePhase.ts", common);
	const { GameProcess } = load("src/core/worker/GameProcessWorker.ts", {
		"@mine-monopoly/types": types,
		"@mine-monopoly/utils": load("../../packages/utils/game/map.ts"),
		"@src/enums/worker": workerTypes,
		"@src/utils": utils,
		"@src/utils/html": { generatePropertySchema: () => ({}) },
		"./editor-lib.d.ts?raw": { __esModule: true, default: "" },
		"./class/OperateListener": load("src/core/worker/class/OperateListener.ts", common),
		"./class/Player": {},
		"./class/Property": {},
		"./class/ChanceCard": {},
		"@src/core/worker/class/GamePhase": phaseClass,
		"@src/core/worker/class/GameRuntimeStack": load("src/core/worker/class/GameRuntimeStack.ts"),
		"./ButtonController": load("src/core/worker/ButtonController.ts"),
		"./runtime-enums": { allRuntimeEnums: types },
		"./ai": { aiManager: {} },
		"./security": { applyWorkerSandbox() {} },
		mitt: require(require.resolve("mitt", { paths: [clientRoot] })),
	}, { self: { addEventListener() {}, postMessage: (message) => messages.push(message) } });
	const game = new GameProcess({
		mapIndex: ["start"], mapItems: [{ id: "start", type: { id: "road" } }], roles: [], chanceCards: [], mapEvents: [],
		phases: { gameOverRule: [{ id: "rule", initEventCode: "async () => false" }] },
	}, {}, [], "owner");
	const phase = (name, terminal = false) => ({
		name,
		getEventQueue() { return [{ fn: async () => { executed.push(name); if (terminal) game.gameOverRuleFunction = async () => true; } }]; },
	});
	const player = (id, phases) => ({
		id, name: id, isStop: 0, isBankrupted: false,
		commandBus: { async execute(command) { executed.push(id + ":" + command.type); } },
		getRoundPhases: () => phases,
		getPlayerInfo: () => ({ id }),
	});
	game.eventBus.on("game.round.end", () => executed.push("round-end-event"));
	return { game, phase, player, messages, executed, types, workerTypes };
}

test("game over during a round-start phase prevents remaining phases and all player turns", async () => {
	const f = fixture();
	f.game.gameRoundPhase.roundStartPhase = [f.phase("terminal", true), f.phase("after-game-over")];
	f.game.gameRoundPhase.roundEndPhase = [f.phase("round-end")];
	f.game.players.set("first", f.player("first", [f.phase("player-phase")]));
	await f.game.gameLoop();
	assert.deepEqual(f.executed, ["terminal"]);
	const settlement = f.messages.filter((message) => message.type === f.workerTypes.WorkerCommType.SendToUsers);
	assert.equal(settlement.filter((message) => message.data.data.type === f.types.SocketMsgType.GameOver).length, 1);
	const finalData = f.messages.findIndex((message) => message.data?.data?.type === f.types.SocketMsgType.GameData && message.data.data.data.isGameOver);
	const finalNotice = f.messages.findIndex((message) => message.data?.data?.type === f.types.SocketMsgType.GameOver);
	const terminateNotice = f.messages.findIndex((message) => message.type === f.workerTypes.WorkerCommType.GameOver);
	assert.ok(finalData >= 0 && finalData < finalNotice && finalNotice < terminateNotice);
});

test("game over during a player phase prevents later player phases, round-end hooks and other turns", async () => {
	const f = fixture();
	f.game.gameRoundPhase.roundEndPhase = [f.phase("round-end")];
	f.game.players.set("first", f.player("first", [f.phase("terminal", true), f.phase("later-player-phase")]));
	f.game.players.set("second", f.player("second", [f.phase("other-player-phase")]));
	await f.game.gameLoop();
	assert.deepEqual(f.executed, ["first:player.round.start", "terminal"]);
});

test("game over during round-end stops remaining round-end phases and the round-end event", async () => {
	const f = fixture();
	f.game.gameRoundPhase.roundEndPhase = [f.phase("terminal", true), f.phase("later-round-end")];
	await f.game.gameLoop();
	assert.deepEqual(f.executed, ["terminal"]);
});

test("simultaneous game-over checks issue one final ranking and one termination notice", async () => {
	const f = fixture();
	f.game.gameOverRuleFunction = async () => true;
	await Promise.all([f.game.checkGameOver(), f.game.checkGameOver()]);
	assert.equal(f.messages.filter((message) => message.type === f.workerTypes.WorkerCommType.GameOver).length, 1);
});
