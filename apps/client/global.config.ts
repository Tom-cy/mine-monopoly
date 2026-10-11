/** 玩家 HTTP 接口与 PeerJS 信令分别配置，TURN 由房间准入接口提供。 */
export const __MONOPOLYSERVER__ = (import.meta.env.VITE_API_BASE_URL || "/monopoly-api").replace(/\/+$/, "");
export const __USERSERVERHOST__ = __MONOPOLYSERVER__;
export const __MONOPOLYSERVERHOST__ = __MONOPOLYSERVER__;
export const __MONOPOLY_ADMIN__ = import.meta.env.VITE_GAME_ADMIN_URL || "http://localhost:7111";

const browserOrigin = /^https?:$/.test(window.location.protocol) ? window.location.origin : "http://localhost";

export function getPeerServerOptions() {
	const peerUrl = new URL(import.meta.env.VITE_PEER_SERVER_URL || "/monopoly-mine-peer", browserOrigin);
	return {
		host: peerUrl.hostname,
		port: Number(peerUrl.port || (peerUrl.protocol === "https:" ? 443 : 80)),
		path: peerUrl.pathname.replace(/\/+$/, "") || "/monopoly-mine-peer",
		secure: peerUrl.protocol === "https:",
		key: import.meta.env.VITE_PEER_SERVER_KEY || "monopoly-mine",
	};
}

export const __PEER_OPTIONS__ = getPeerServerOptions;
const peer = getPeerServerOptions();
export const __ICE_SERVER_PATH__ = peer.path;
export const __ICE_SERVER_HOST__ = peer.host;
export const __ICE_SERVER_PORT__ = peer.port;
export const __ICE_USE_PREFIX__ = true;
export const __FATPAPER_HOST__ = peer.host;
export const __PROTOCOL__ =
	__MONOPOLYSERVER__.startsWith("https:") || window.location.protocol === "https:" ? "https" : "http";
export const __APIPORT__ = Number(
	new URL(__MONOPOLYSERVER__, browserOrigin).port || (__PROTOCOL__ === "https" ? 443 : 80),
);
