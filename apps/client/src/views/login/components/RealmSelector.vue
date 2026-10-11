<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { getServers } from "@src/utils/api/realm";
import { getActiveRealm } from "@src/utils/auth";
import type { ServerInfo } from "@src/utils/api/types";

const props = defineProps<{ busy: boolean; accountName: string }>();
const emit = defineEmits<{ select: [serverId: string]; resume: []; logout: [] }>();
const servers = ref<ServerInfo[]>([]);
const page = ref(1);
const total = ref(0);
const loading = ref(false);
const failure = ref(false);
const size = 8;
let request: AbortController | null = null;
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / size)));
const active = computed(() => getActiveRealm());

async function load(targetPage = page.value) {
	request?.abort();
	const controller = new AbortController();
	request = controller;
	loading.value = true;
	failure.value = false;
	try {
		const result = await getServers(targetPage, size, controller.signal);
		if (request !== controller) return;
		servers.value = result.records;
		total.value = result.total;
		page.value = result.current;
	} catch {
		if (!controller.signal.aborted) failure.value = true;
	} finally {
		if (request === controller) loading.value = false;
	}
}

function unavailable(server: ServerInfo): string {
	if (server.status !== "OPEN") return server.status === "MAINTENANCE" ? "维护中" : "已关闭";
	if (server.roleId) return "";
	if (!server.allowNewRoles) return "暂停新角色";
	if (server.roleCount >= server.roleCapacity) return "角色名额已满";
	return "";
}

onMounted(() => { void load(); });
onBeforeUnmount(() => request?.abort());
</script>

<template>
	<section class="realm-selector" aria-label="选择区服">
		<div class="heading">
			<div><h2>选择区服</h2><p>{{ accountName }}，进入区服后使用该区服角色游玩。</p></div>
			<button :disabled="props.busy" @click="emit('logout')">退出账号</button>
		</div>
		<p v-if="active" class="notice">切换区服会退出当前在线房间。<button :disabled="busy" @click="emit('resume')">继续当前区服</button></p>
		<p v-if="loading" role="status">正在读取区服…</p>
		<div v-else-if="failure" role="alert">未能获取区服。<button @click="load()">重试</button></div>
		<p v-else-if="!servers.length">暂无可用区服，请稍后刷新。</p>
		<div v-else class="server-grid">
			<button v-for="server in servers" :key="server.id" class="server" :disabled="busy || Boolean(unavailable(server))" @click="emit('select', server.id)">
				<strong>{{ server.serverName }}</strong>
				<span>{{ server.serverCode }} · {{ unavailable(server) || '开放' }}</span>
				<span>{{ server.roleCount }} / {{ server.roleCapacity }} 个角色</span>
				<span>{{ server.nickname ? `角色：${server.nickname}` : '首次进入将创建角色' }}</span>
				<small v-if="server.announcement">{{ server.announcement }}</small>
			</button>
		</div>
		<div class="pagination">
			<button :disabled="loading || busy || page <= 1" @click="load(page - 1)">上一页</button>
			<span>{{ page }} / {{ pageCount }}</span>
			<button :disabled="loading || busy || page >= pageCount" @click="load(page + 1)">下一页</button>
			<button :disabled="loading || busy" @click="load()">刷新</button>
		</div>
		<p v-if="busy" role="status">正在进入区服…</p>
	</section>
</template>

<style scoped lang="scss">
.realm-selector {
	width: min(90%, 60rem);
	max-height: 65vh;
	overflow-y: auto;
	margin: 2rem auto;
	padding: 1.5rem;
	border-radius: 1rem;
	background: rgba(255, 255, 255, .94);
	color: #333;
}
.heading {
	display: flex;
	gap: 1rem;
	align-items: center;
	justify-content: space-between;
	h2 { margin: 0 0 .5rem; }
}
.server-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
	gap: 1rem;
}
.server {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: .5rem;
	padding: 1rem;
	text-align: left;
	border: 2px solid var(--fp-color-primary);
	border-radius: .8rem;
	background: white;
	color: #333;
	strong { font-size: 1.25rem; }
	small { white-space: pre-wrap; overflow-wrap: anywhere; }
}
button {
	padding: .5rem .8rem;
	cursor: pointer;
	&:disabled { opacity: .55; cursor: default; }
}
.pagination {
	display: flex;
	justify-content: center;
	align-items: center;
	flex-wrap: wrap;
	gap: .8rem;
	margin-top: 1rem;
}
.notice { padding: .7rem; background: #fff4cf; }
</style>
