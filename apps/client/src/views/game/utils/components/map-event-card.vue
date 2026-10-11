<script setup lang="ts">
import { computed, ref } from "vue";
import { MapEvent } from "@mine-monopoly/types";
import { useResourceStore } from "@src/store/game";

const props = defineProps<{ mapEvent: MapEvent | null }>();

const arrivedEvent = ref<MapEvent | null>(props.mapEvent);

// 转换 \n 为真实换行符
const formattedDescription = computed(() => {
	return String(arrivedEvent.value?.description ?? "").replace(/\\n/g, "\n");
});

function updateArrivedEvent(newArrivedEvent: MapEvent | null) {
	arrivedEvent.value = newArrivedEvent;
}

defineExpose({ updateArrivedEvent });

const iconUrl = computed(() => {
	if (!arrivedEvent.value) return "";
	return useResourceStore().getRecourceById(arrivedEvent.value.iconId)?.url || "";
});
</script>

<template>
	<div class="arrived-event-info felt-card" v-if="arrivedEvent">
		<div class="info">
			<img v-if="iconUrl" :src="iconUrl" alt="" />
			<span>{{ arrivedEvent.name }}</span>
		</div>
		<div class="description">
			{{ formattedDescription }}
		</div>
	</div>
</template>

<style scoped lang="scss">
.arrived-event-info {
	display: flex;
	max-width: 30rem;
	flex-direction: column;
	justify-content: space-around;
	align-items: center;

	.info {
		display: flex;
		justify-content: center;
		align-items: center;
		box-shadow: var(--el-box-shadow);
		font-size: 1.2rem;
		font-weight: bold;
		border-radius: 0.5rem;
		color: var(--fp-color-primary);
		margin-bottom: 0.6rem;
		text-shadow:
			#fff -0.0625rem 0 0,
			#fff 0.0625rem 0 0,
			#fff 0 0.0625rem 0,
			#fff 0 -0.0625rem 0;

		$icon_size: 1.6em;

		img {
			width: $icon_size;
			height: $icon_size;
			margin-right: 0.3rem;
		}
	}

	.description {
		color: #2b2b2b;
		text-shadow:
			#fff -0.0625rem 0 0,
			#fff 0.0625rem 0 0,
			#fff 0 0.0625rem 0,
			#fff 0 -0.0625rem 0;
		white-space: pre-wrap; /* 保留换行和空格 */
	}
}
</style>
