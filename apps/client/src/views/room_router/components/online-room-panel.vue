<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import FpPopover from "@src/components/utils/fp-popover/fp-popover.vue";
import { FontAwesomeIcon } from "@fortawesome/vue-fontawesome";
import { useMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";
import { useLoading, useUserInfo } from "@src/store";
import { FPMessage } from "@mine-monopoly/ui";
import { __FATPAPER_HOST__, __ICE_SERVER_PORT__ } from "@src/../global.config";
import { getGameMapList } from "@src/utils/api/map";
import { getActiveRealm } from "@src/utils/auth";
import type { GameMapInDb } from "@mine-monopoly/types";
import router from "@src/router";

const panelElement = ref<HTMLElement | null>(null);
const roomCode = ref("");
const busy = ref(false);
const mapsLoading = ref(false);
const mapsError = ref("");
const maps = ref<GameMapInDb[]>([]);
const selectedMapId = ref("");
const privateRoom = ref(true);
const page = ref(1);
const total = ref(0);
const size = 8;
const realm = computed(() => (useUserInfo().hasOnlineIdentity() ? getActiveRealm() : null));
defineExpose({ panelElement });

async function loadMaps(nextPage = 1) {
	if (!realm.value || mapsLoading.value) return;
	mapsLoading.value = true;
	mapsError.value = "";
	try {
		const result = await getGameMapList(nextPage, size);
		maps.value = result.gameMapList;
		total.value = result.total;
		page.value = result.current;
		if (!selectedMapId.value && maps.value.length) selectedMapId.value = maps.value[0].id;
	} catch (error: any) {
		mapsError.value = error?.message || "地图目录加载失败";
	} finally {
		mapsLoading.value = false;
	}
}
onMounted(() => {
	if (realm.value) void loadMaps();
});

async function perform(match: boolean) {
	if (busy.value) return;
	if (!realm.value) {
		await router.push({ name: "login", query: { selectRealm: "1" } });
		return;
	}
	if (!match && !/^[A-Za-z0-9_-]{1,12}$/.test(roomCode.value.trim())) {
		FPMessage({ type: "error", message: "房间号为 1–12 位字母、数字、下划线或短横线" });
		return;
	}
	busy.value = true;
	try {
		const client = await useMonopolyClient({ iceServer: { host: __FATPAPER_HOST__, port: __ICE_SERVER_PORT__ } });
		useLoading().showLoading(match ? "正在匹配当前区服..." : "正在加入房间...");
		if (match) await client.matchRoom();
		else
			await client.joinRoom(roomCode.value.trim(), {
				mapId: selectedMapId.value || undefined,
				capacity: 6,
				privateRoom: privateRoom.value,
			});
	} catch (error: any) {
		FPMessage({ type: "error", message: error?.message || "入房失败" });
	} finally {
		busy.value = false;
		useLoading().hideLoading();
	}
}
</script>

<template>
	<section ref="panelElement" class="mode-page join-room">
		<div class="title">联机房间</div>
		<template v-if="realm">
			<div class="describe">
				·当前区服：{{ realm.serverId }}，角色：{{ realm.nickname }}<br />
				·输入房间号加入；新建时固定所选地图版本。公开房间可通过匹配加入。
			</div>
			<button
				type="button"
				class="realm-switch"
				:disabled="busy"
				@click="router.push({ name: 'login', query: { selectRealm: '1' } })"
			>
				切换区服
			</button>
			<div class="map-choice">
				<label
					>新建地图
					<select v-model="selectedMapId" :disabled="busy || mapsLoading">
						<option v-if="!maps.length" value="">暂无可用地图（仍可加入已有房间）</option>
						<option v-for="map in maps" :key="map.id" :value="map.id">{{ map.name }} · {{ map.pendingVersion }}</option>
					</select>
				</label>
				<label><input v-model="privateRoom" type="checkbox" :disabled="busy" /> 新建为私密房间</label>
				<div v-if="mapsLoading" role="status">读取地图目录中…</div>
				<div v-else-if="mapsError" role="alert">
					{{ mapsError }} <button type="button" @click="loadMaps(page)">重试</button>
				</div>
				<div v-if="total > size" class="map-pagination">
					<button type="button" :disabled="page <= 1 || mapsLoading || busy" @click="loadMaps(page - 1)">上一页</button>
					<span>{{ page }} / {{ Math.ceil(total / size) }}</span>
					<button type="button" :disabled="page * size >= total || mapsLoading || busy" @click="loadMaps(page + 1)">
						下一页
					</button>
				</div>
			</div>
			<form @submit.prevent="perform(false)">
				<input v-model="roomCode" :disabled="busy" maxlength="12" type="text" placeholder="房间号(1-12位)" />
				<button type="submit" :disabled="busy">加入/创建房间</button>
				<FpPopover placement="bottom">
					<template #default>
						<button type="button" class="random-room-button" :disabled="busy" @click="perform(true)">
							<FontAwesomeIcon :icon="busy ? 'hourglass-half' : 'shuffle'" />
						</button>
					</template>
					<template #content><div class="tips">匹配当前区服的公开房间</div></template>
				</FpPopover>
			</form>
		</template>
		<div v-else class="describe">
			游客可使用本地派对模式。联机需要登录账号并选择区服。
			<button type="button" @click="router.push({ name: 'login' })">登录并选择区服</button>
		</div>
	</section>
</template>

<style lang="scss" scoped>
@use "@src/assets/variables" as *;
.join-room {
	@include felt-patch(#ffedb7);
	padding: 1.8rem;
	border-radius: 2rem;
	.title {
		display: inline-block;
		font-size: 1.6rem;
		color: var(--fp-color-primary);
		margin-bottom: 0.7rem;
		background: rgba(255, 255, 255, 0.45);
		padding: 0.4rem 0.8rem;
		border-radius: 1rem;
	}
	.describe {
		font-size: 0.9rem;
		color: #393939;
		margin-bottom: 0.8rem;
	}
	form {
		display: flex;
		gap: 0.5rem;
	}
	form input {
		height: 3rem;
		flex: 1;
		min-width: 0;
	}
	button {
		border-radius: 0.7rem;
		padding: 0.4rem 0.7rem;
	}
	form button {
		height: 3rem;
	}
	.random-room-button {
		width: 3rem;
	}
	.map-choice {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		margin: 0.8rem 0;
	}
	.map-choice label {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	select {
		max-width: 22rem;
		min-height: 2rem;
		border-radius: 0.5rem;
	}
	.map-pagination {
		display: flex;
		gap: 0.6rem;
		align-items: center;
	}
	.realm-switch {
		font-size: 0.8rem;
	}
}
</style>
