import { createRouter, createWebHashHistory, createWebHistory } from "vue-router";
import { useLoading, useRoomInfo, useUserInfo } from "@src/store";
import { destoryMonopolyClient } from "@src/core/monopoly-client/MonopolyClient";
import { getAccountProfile, getActiveRealm } from "@src/utils/auth/session";
import { useLocalParty } from "@src/store/local-party";

function componentLoadedInterceptor(loader: () => Promise<any>) {
	return async () => {
		const loadingStore = useLoading();
		loadingStore.text = "加载中";
		loadingStore.loading = true;
		try {
			return await loader();
		} finally {
			loadingStore.loading = false;
		}
	};
}

import { getPlatformType } from "@src/utils/platform";

const routes = [
	{ path: "/", name: "login", component: componentLoadedInterceptor(() => import("@src/views/login/login.vue")) },
	{
		path: "/room-router",
		name: "room-router",
		component: componentLoadedInterceptor(() => import("@src/views/room_router/room_router.vue")),
	},
	{ path: "/room", name: "room", component: componentLoadedInterceptor(() => import("@src/views/room/room.vue")) },
	{ path: "/game", name: "game", component: componentLoadedInterceptor(() => import("@src/views/game/game.vue")) },
];

const router = createRouter({
	// Electron 必须用 Hash (file:// 协议)，其他平台用 History
	history: getPlatformType() === "electron"
		? createWebHashHistory()
		: createWebHistory(import.meta.env.BASE_URL),
	routes,
});

router.beforeEach((to, form) => {
	switch (to.name) {
		case "room-router":
			destoryMonopolyClient();
			// The lobby also offers local play; only REALM credentials enable its online actions.
			if (useUserInfo().identityType !== "LOCAL") {
				const realm = getActiveRealm();
				const account = getAccountProfile();
				if (realm && account) useUserInfo().setRealmIdentity(realm, account);
				else if (account) useUserInfo().setAccountIdentity(account);
			}
			break;
		case "game":
		case "room":
			if (!useLocalParty().isActive && !getActiveRealm()) {
				return { name: "login", query: getAccountProfile() ? { selectRealm: "1" } : {} };
			}
			if (!useRoomInfo().roomId && !useLocalParty().isActive) {
				return { name: "room-router" };
			}
			break;
		default:
			if (!getAccountProfile() && !useLocalParty().isActive && to.name !== "login") {
				// 将用户重定向到登录页面
				return { name: "login" };
			}
			break;
	}
});

export default router;
