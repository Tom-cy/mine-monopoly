const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const test = require("node:test");
const clientRoot = path.resolve(__dirname, "../../../..");
const resolve = (name) => require.resolve(name, { paths: [clientRoot] });
const ts = require(resolve("typescript"));

// 加载完整生产模块，仅替换 Worker 消息传输、脚本编译器和动画等待。
// 金钱、手牌、移动和破产清算均执行真实实现。
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
			setTimeout,
			clearTimeout,
			setInterval,
			clearInterval,
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
	...load("../../packages/types/enums/game/game.ts"),
	...load("../../packages/types/interfaces/game/game-process/money-tag.ts"),
};
const workerTypes = load("src/enums/worker.ts");
let sequence = 0;
const utils = {
	randomString: () => `test-${++sequence}`,
	compileTsToJs: (code) => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
};
const commonDependencies = {
	"@mine-monopoly/types": types,
	"@src/utils": utils,
	"../editor-lib.d.ts?raw": { default: "", __esModule: true },
	"../utils/serialize": load("src/core/worker/utils/serialize.ts"),
	"./action-system/CommandBus": load("src/core/worker/class/action-system/CommandBus.ts"),
	"./action-system/BuffManager": load("src/core/worker/class/action-system/BuffManager.ts"),
	"./action-system/ModifiersManager": load("src/core/worker/class/action-system/ModifiersManager.ts"),
	lodash: require(resolve("lodash")),
};
const gamePhase = load("src/core/worker/class/GamePhase.ts", commonDependencies);
const chanceCard = load("src/core/worker/class/ChanceCard.ts", commonDependencies);
const player = load("src/core/worker/class/Player.ts", {
	...commonDependencies,
	"./GamePhase": gamePhase,
	"./ChanceCard": chanceCard,
	"./Dice": load("src/core/worker/class/Dice.ts", commonDependencies),
});
const property = load("src/core/worker/class/Property.ts", commonDependencies);

async function fixture(effectCode, type = types.TargetSelectType.ToSelf, extraMapItems = []) {
	const messages = [];
	const { GameProcess } = load(
		"src/core/worker/GameProcessWorker.ts",
		{
			"@mine-monopoly/types": types,
			"@mine-monopoly/utils": load("../../packages/utils/game/map.ts"),
			"@src/enums/worker": workerTypes,
			"@src/utils": utils,
			"@src/utils/scene-decoration": load("src/utils/scene-decoration.ts"),
			"@src/utils/html": { generatePropertySchema: () => ({}) },
			"./editor-lib.d.ts?raw": { default: "", __esModule: true },
			"./class/OperateListener": load("src/core/worker/class/OperateListener.ts", commonDependencies),
			"./class/Player": player,
			"./class/Property": property,
			"./class/ChanceCard": chanceCard,
			"@src/core/worker/class/GamePhase": gamePhase,
			"@src/core/worker/class/GameRuntimeStack": load("src/core/worker/class/GameRuntimeStack.ts"),
			"./ButtonController": load("src/core/worker/ButtonController.ts"),
			"./runtime-enums": { allRuntimeEnums: types },
			"./ai": { aiManager: {} },
			"./security": { applyWorkerSandbox() {} },
			mitt: require(resolve("mitt")),
		},
		{ self: { addEventListener() {}, postMessage: (message) => messages.push(message) } },
	);
	const newProperty = (id) => ({
		id,
		name: id,
		buildCost: 50,
		sellCost: 100,
		costList: [200, 300, 400],
		maxLevel: 2,
	});
	const users = [
		{ userId: "source", username: "Source", roleId: "role" },
		{ userId: "owner", username: "Owner", roleId: "role" },
	];
	const map = {
		mapIndex: ["start", "toll"],
		startMapItemId: "start",
		mapItems: [
			{ id: "start", type: { id: "road", name: "Road" } },
			{ id: "toll", type: { id: "road", name: "Road" }, linkto: "toll-property" },
			{ id: "toll-property", property: newProperty("toll-property") },
			{ id: "source-property", property: newProperty("source-property") },
			...extraMapItems,
		],
		mapEvents: [],
		chanceCards: [
			{ id: "card", name: "Test card", type, effectCode },
			{ id: "spare", name: "Spare card", type: types.TargetSelectType.ToSelf, effectCode: "async () => {}" },
		],
		roles: [{ id: "role", name: "Role", initCode: "() => {}" }],
		phases: { gameOverRule: [{ id: "rule", initEventCode: "async () => false" }] },
	};
	const game = new GameProcess(map, { initMoney: { value: 100 } }, users, "source");
	game.waitForAnimationComplete = async () => {};
	await game.initPlayers();
	await game.initProperties();
	const source = game.players.get("source");
	const owner = game.players.get("owner");
	const ownedProperty = game.properties.get("source-property");
	await ownedProperty.setOwner(source);
	await ownedProperty.setLevel(2);
	await game.properties.get("toll-property").setOwner(owner);
	source.isStop = 2;
	source.stop = 2;
	const card = game.createNewChanceCard("card");
	const spare = game.createNewChanceCard("spare");
	await source.gainCard(card);
	await source.gainCard(spare);
	const lostCardIds = [];
	const loseCard = source.loseCard.bind(source);
	source.loseCard = async (id) => {
		lostCardIds.push(id);
		await loseCard(id);
	};
	messages.length = 0;
	return { game, source, owner, ownedProperty, card, spare, lostCardIds, messages };
}

function assertCallback(context, error) {
	const callbacks = context.messages.filter(
		(message) =>
			message.type === workerTypes.WorkerCommType.SendToUsers &&
			message.data.data.type === types.SocketMsgType.UseChanceCard &&
			!message.data.data.data.animationId,
	);
	assert.equal(callbacks.length, 1);
	assert.equal(callbacks[0].data.data.data.error, error);
}

function assertLiquidated(context) {
	assert.equal(context.source.money, 0);
	assert.equal(context.source.isBankrupted, true);
	assert.equal(context.source.chanceCards.length, 0);
	assert.equal(context.source.properties.length, 0);
	assert.equal(context.ownedProperty.owner, undefined);
	assert.equal(context.ownedProperty.level, 0);
	assert.equal(context.source.isStop, 0);
	assert.equal(context.source.stop, 0);
}

test("spending all cash completes the effect after liquidation removes the used card", async () => {
	const context = await fixture(`async (source, target, game) => {
		const result = await source.cost(100, "card");
		game.customData.actualCost = result.actualCost;
		game.customData.finished = true;
	}`);
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), []), true);
	assertLiquidated(context);
	assert.equal(context.game.customData.actualCost, 100);
	assert.equal(context.game.customData.finished, true);
	assert.equal(context.lostCardIds.length, 0);
	assertCallback(context, false);
});

test("moving to another player's property completes rent payment and liquidation successfully", async () => {
	const context = await fixture(
		`async (source, target, game) => {
			await source.tpToMapItem(target);
			await game.handleArriveEvent(source);
			game.customData.arrivalFinished = true;
		}`,
		types.TargetSelectType.ToMapItem,
	);
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), ["toll"]), true);
	assert.equal(context.source.positionMapItemId, "toll");
	assert.equal(context.source.positionIndex, 1);
	assert.equal(context.owner.money, 200);
	assert.equal(context.game.customData.arrivalFinished, true);
	assertLiquidated(context);
	assert.equal(context.lostCardIds.length, 0);
	assertCallback(context, false);
});

test("a normal successful effect consumes exactly its card and keeps other cards", async () => {
	const context = await fixture("async (source) => { await source.gain(25, 'card'); }");
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), []), true);
	assert.equal(context.source.money, 125);
	assert.equal(context.source.isBankrupted, false);
	assert.equal(context.source.getCardById(context.card.getId()), undefined);
	assert.equal(context.source.getCardById(context.spare.getId()), context.spare);
	assert.deepEqual(context.lostCardIds, [context.card.getId()]);
	assert.equal(context.ownedProperty.owner, context.source);
	assertCallback(context, false);
});

test("an effect exception returns failure and retains the unused card", async () => {
	const context = await fixture("async () => { throw new Error('effect failed'); }");
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), []), false);
	assert.equal(context.source.getCardById(context.card.getId()), context.card);
	assert.equal(context.source.getCardById(context.spare.getId()), context.spare);
	assert.equal(context.lostCardIds.length, 0);
	assertCallback(context, true);
	assert.ok(context.messages.some((message) => message.data?.data.msg?.content === "effect failed"));
});

test("an exception after liquidation still returns failure rather than masking the effect error", async () => {
	const context = await fixture(`async (source) => {
		await source.cost(100, "card");
		throw new Error("failure after liquidation");
	}`);
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), []), false);
	assertLiquidated(context);
	assertCallback(context, true);
	assert.ok(context.messages.some((message) => message.data?.data.msg?.content === "failure after liquidation"));
});

test("unexpected card removal without bankruptcy is still reported as a failure", async () => {
	const context = await fixture("async (source) => { source.chanceCards = []; }");
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), []), false);
	assert.equal(context.source.isBankrupted, false);
	assert.deepEqual(context.lostCardIds, [context.card.getId()]);
	assertCallback(context, true);
});

test("pure scene decorations stay outside gameplay state and chance-card targets while legacy park tiles remain", async () => {
	const context = await fixture("async (source, target, game) => { game.customData.effectRan = true; }", types.TargetSelectType.ToMapItem, [
		{ id: "palace", type: { id: "palace-type", name: "Palace", sceneDecoration: true } },
		{ id: "legacy-park", type: { id: "park-type", name: "Park" } },
	]);
	assert.equal(context.game.mapData.mapItems.some((item) => item.id === "palace"), true);
	assert.equal(context.game.getMapItemById("palace"), undefined);
	assert.equal(context.game.getMapItemById("legacy-park").id, "legacy-park");
	const targetIds = Array.from(context.game.buildTargetDecisionOptions(context.source, types.TargetSelectType.ToMapItem), (item) => item.id);
	assert.equal(targetIds.includes("palace"), false);
	assert.equal(targetIds.includes("legacy-park"), true);
	assert.equal(targetIds.includes("toll-property"), true);
	assert.equal(await context.game.handleUseChanceCard(context.source, context.card.getId(), ["palace"]), false);
	assert.equal(context.game.customData.effectRan, undefined);
	assert.equal(context.source.getCardById(context.card.getId()), context.card);
	assertCallback(context, true);
});
