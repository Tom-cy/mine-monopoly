import Peer, { DataConnection } from "peerjs";
import { ClientSocketMessage, OperateType, SocketMsgSource, SocketMsgType } from "@mine-monopoly/types";
import {
	consumeRoomTicket, deleteRoom, emitRoomHeart, getRoomSessionStatus, readyHostRoom,
	reclaimHostRoom, setRoomStarted,
} from "@src/utils/api/room-router";
import { FPMessage } from "@mine-monopoly/ui";
import { __PEER_OPTIONS__ } from "@src/../global.config";
import { handleClientSocketMessage } from "./client-message-handlers";
import { Room } from "./Room";
import { connectionDiagnostics } from "@src/utils/connection-diagnostics";
import { backendErrorCode, canonicalPeerUser, isStaleBackendIdentity, readPeerTicket, verifyPeerIdentity } from "../network/peer-admission";
import type { HostSessionRegistration } from "../network/WebRtcSessionManager";
import { getFrozenRoomMap } from "@src/utils/api/map";

const OWNER_COMMANDS = new Set<SocketMsgType>([
	SocketMsgType.KickOut, SocketMsgType.ChangeMap, SocketMsgType.ChangeGameSetting, SocketMsgType.GameStart,
]);
const ADMISSION_OPERATIONS = new Set<OperateType>([
	OperateType.LoadingStarted, OperateType.MapResourceLoaded, OperateType.GameInitFinished, OperateType.ConfirmDialogResult,
]);
function isAdmissionControl(message: ClientSocketMessage): boolean {
	return message.type === SocketMsgType.Heart || message.type === SocketMsgType.MapLocalCheck ||
		message.type === SocketMsgType.MapTransferRequest ||
		(message.type === SocketMsgType.Operation && !!message.data && ADMISSION_OPERATIONS.has(message.data.operateType));
}

type HeartbeatResult = { ok: boolean; reclaimed: boolean; error?: string };

export class MonopolyHost {
	private readonly clientList = new Map<string, DataConnection>();
	private readonly connections = new Set<DataConnection>();
	private readonly connectionVersionMap = new Map<string, number>();
	private readonly clientHeartCheckFns = new Map<string, { clear: () => void; reset: () => void }>();
	private readonly heartbeatTimeoutMap = new Map<string, ReturnType<typeof setTimeout>>();
	private heartbeatTimer: ReturnType<typeof setInterval>;
	private heartbeatRequest: Promise<HeartbeatResult> | null = null;
	private heartbeatFailures = 0;
	private closeRequest: Promise<void> | null = null;
	private destroyed = false;
	private destoryHandler: (() => void) | undefined;
	private hostLeaseToken: string;
	private hostEpoch: number;
	private readonly unload = () => { void this.close(true); };

	private constructor(
		private readonly peer: Peer,
		private readonly room: Room,
		heartbeatIntervalMs: number,
		private readonly registration: HostSessionRegistration,
	) {
		this.hostLeaseToken = registration.hostLeaseToken;
		this.hostEpoch = registration.hostEpoch;
		this.peer.on("connection", (conn) => this.acceptConnection(conn));
		this.heartbeatTimer = setInterval(() => { void this.sendHeartbeat(); }, Math.max(1000, heartbeatIntervalMs));
		window.addEventListener("beforeunload", this.unload);
	}

	private lease() {
		return { hostLeaseToken: this.hostLeaseToken, hostEpoch: this.hostEpoch };
	}

	private acceptConnection(conn: DataConnection): void {
		if (this.destroyed) { conn.close(); return; }
		this.connections.add(conn);
		let identity: string | null = null;
		let pendingJoin: ClientSocketMessage | null = null;
		let joined = false;
		let readyForCommands = false;
		const queuedMessages: ClientSocketMessage[] = [];
		let closed = false;
		let version = 0;
		let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
		const lease = this.lease();
		const validationDeadline = setTimeout(() => { conn.close(); disconnect(); }, 10000);
		const isCurrent = () => !closed && !this.destroyed && identity !== null &&
			this.connectionVersionMap.get(identity) === version && this.clientList.get(identity) === conn;
		const clearHeartbeat = () => {
			if (heartbeatTimeout !== null) clearTimeout(heartbeatTimeout);
			if (identity && this.heartbeatTimeoutMap.get(identity) === heartbeatTimeout) this.heartbeatTimeoutMap.delete(identity);
			heartbeatTimeout = null;
		};
		const resetHeartbeat = () => {
			clearHeartbeat();
			if (!isCurrent()) return;
			heartbeatTimeout = setTimeout(() => { conn.close(); disconnect(); }, 10000);
			this.heartbeatTimeoutMap.set(identity!, heartbeatTimeout);
		};
		const disconnect = () => {
			const current = isCurrent();
			closed = true;
			clearTimeout(validationDeadline);
			clearHeartbeat();
			this.connections.delete(conn);
			if (current && identity) {
				this.clientHeartCheckFns.delete(identity);
				this.clientList.delete(identity);
				this.room.leave(identity);
			}
		};
		const reject = (message: string) => {
			if (conn.open) this.room.sendToClient(conn, SocketMsgType.MsgNotify, undefined, { type: "error", content: message });
			conn.close();
			disconnect();
		};
		const handleGameMessage = (message: ClientSocketMessage) => {
			if (!isCurrent() || message.type === SocketMsgType.JoinRoom) return;
			if (OWNER_COMMANDS.has(message.type) && identity !== this.registration.hostId) {
				this.room.sendToClient(conn, SocketMsgType.MsgNotify, undefined, { type: "error", content: "只有房主可以执行此操作" });
				return;
			}
			if (!readyForCommands && !isAdmissionControl(message)) {
				// Map loading sends the selected role and owner defaults before MapResourceLoaded.
				// Preserve that ordering without executing gameplay before Room.join completes.
				if (queuedMessages.length >= 16) { reject("地图加载期间消息过多"); return; }
				queuedMessages.push(message);
				return;
			}
			if (message.type === SocketMsgType.Heart) resetHeartbeat();
			try { handleClientSocketMessage(conn, message, this, identity!); }
			catch { reject("游戏消息处理失败"); }
		};
		const finishJoin = () => {
			if (!isCurrent()) return;
			readyForCommands = true;
			for (const message of queuedMessages.splice(0)) handleGameMessage(message);
		};
		const join = (message: ClientSocketMessage) => {
			if (joined || closed || !identity || this.destroyed) return;
			if (message.type !== SocketMsgType.JoinRoom || !message.data || typeof message.data !== "object") {
				reject("首条消息必须为加入房间"); return;
			}
			if (this.room.isStarted && !this.room.isUserInRoom(identity)) { reject("房间已经开始游戏"); return; }
			const previous = this.clientList.get(identity);
			joined = true;
			version = (this.connectionVersionMap.get(identity) || 0) + 1;
			this.connectionVersionMap.set(identity, version);
			this.clientList.set(identity, conn);
			previous?.close();
			this.clientHeartCheckFns.set(identity, { clear: clearHeartbeat, reset: resetHeartbeat });
			resetHeartbeat();
			clearTimeout(validationDeadline);
			const roleId = identity;
			if (this.room.isUserInRoom(roleId)) {
				this.room.sendToClient(conn, SocketMsgType.JoinRoom, { roomId: this.room.getRoomId() });
				void this.room.handleUserReconnect(roleId, conn, version).then(() => {
					finishJoin();
				}).catch(() => reject("恢复游戏连接失败"));
			} else {
				const user = canonicalPeerUser(message.data as unknown as Record<string, unknown>, roleId);
				void this.room.join(user, conn).then((accepted) => {
					if (!accepted && isCurrent()) reject("加入房间失败");
					else finishJoin();
				}).catch(() => reject("加入房间失败"));
			}
		};
		conn.on("data", (payload: unknown) => {
			if (closed || this.destroyed || typeof payload !== "string") return;
			let message: ClientSocketMessage;
			try {
				message = JSON.parse(payload, (_key, value) => value === "Infinity" ? Infinity : value === "-Infinity" ? -Infinity : value);
				if (!message || message.source !== SocketMsgSource.Client) throw new Error("invalid message");
			} catch { reject("消息格式无效"); return; }
			if (!joined) {
				if (message.type !== SocketMsgType.JoinRoom || pendingJoin) { reject("连接尚未完成成员校验"); return; }
				pendingJoin = message;
				if (identity) join(message);
				return;
			}
			handleGameMessage(message);
		});
		conn.on("close", disconnect);
		conn.on("error", () => { conn.close(); disconnect(); });
		void (async () => {
			try {
				const ticket = readPeerTicket(conn.metadata);
				const consumed = await consumeRoomTicket(this.room.getRoomId(), { ...lease, ticket, actualPeerId: conn.peer });
				if (closed || this.destroyed || this.hostEpoch !== lease.hostEpoch) { conn.close(); return; }
				identity = verifyPeerIdentity(consumed, {
					roomSessionId: this.registration.roomSessionId, hostEpoch: lease.hostEpoch, peerId: conn.peer,
				});
				if (pendingJoin) join(pendingJoin);
			} catch { reject("成员票据无效，请重新连接"); }
		})();
	}

	public static async create(
		roomId: string, _host: string, _port: number, heartbeatIntervalMs: number,
		iceServers: RTCIceServer[], registration: HostSessionRegistration,
	): Promise<MonopolyHost> {
		let peer: Peer | undefined;
		let cleanupLease = { hostLeaseToken: registration.hostLeaseToken, hostEpoch: registration.hostEpoch };
		try {
			peer = await new Promise<Peer>((resolve, reject) => {
				const candidate = new Peer({ ...__PEER_OPTIONS__(), config: { iceServers }, debug: 0 });
				const timeout = setTimeout(() => { candidate.destroy(); reject(new Error("房主信令连接超时")); }, 15000);
				candidate.once("open", () => { clearTimeout(timeout); resolve(candidate); });
				candidate.once("error", (error) => { clearTimeout(timeout); candidate.destroy(); reject(error); });
			});
			const ready = await readyHostRoom(roomId, {
				hostLeaseToken: registration.hostLeaseToken, hostEpoch: registration.hostEpoch, hostPeerId: peer.id,
			});
			cleanupLease = { hostLeaseToken: ready.hostLeaseToken || registration.hostLeaseToken, hostEpoch: ready.hostEpoch };
			let host: MonopolyHost;
			const room = new Room(roomId, {
				ownerId: registration.hostId,
				beforeStart: async () => { await setRoomStarted(roomId, true, host.lease()); },
			});
			const frozenMap = getFrozenRoomMap(roomId);
			if (!frozenMap) throw new Error("房间冻结地图资源尚未就绪");
			await room.changeMap({ from: "server", data: frozenMap.id });
			host = new MonopolyHost(peer, room, ready.heartbeatIntervalMs || heartbeatIntervalMs, {
				...registration, roomSessionId: ready.roomSessionId, hostEpoch: ready.hostEpoch,
				hostLeaseToken: ready.hostLeaseToken || registration.hostLeaseToken,
			});
			connectionDiagnostics.logPeerEvent("Host.ready", "房主 Peer 和租约已绑定");
			return host;
		} catch (error) {
			peer?.destroy();
			await Promise.resolve().then(() => deleteRoom(roomId, cleanupLease)).catch(() => undefined);
			throw error;
		}
	}

	public broadcast(message: string): void { for (const conn of this.clientList.values()) if (conn.open) conn.send(message); }
	public getPeerId(): string { return this.peer.id; }
	public getRoom(): Room { return this.room; }
	public deleteClient(id: string): void { this.clientList.get(id)?.close(); this.clientList.delete(id); }
	public addDestoryListener(listener: () => void): void { this.destoryHandler = listener; }
	public pauseClientHeartCheck(id: string): void { this.clientHeartCheckFns.get(id)?.clear(); }
	public resumeClientHeartCheck(id: string): void { this.clientHeartCheckFns.get(id)?.reset(); }

	private sendHeartbeat(): Promise<HeartbeatResult> {
		if (this.destroyed) return Promise.resolve({ ok: false, reclaimed: false, error: "房间已关闭" });
		if (this.heartbeatRequest) return this.heartbeatRequest;
		this.heartbeatRequest = this.renewLease().finally(() => { this.heartbeatRequest = null; });
		return this.heartbeatRequest;
	}

	private async renewLease(): Promise<HeartbeatResult> {
		try {
			const renewed = await emitRoomHeart(this.room.getRoomId(), this.lease());
			if (!this.destroyed) { this.hostEpoch = renewed.hostEpoch; this.heartbeatFailures = 0; }
			return { ok: true, reclaimed: false };
		} catch (error) {
			if (this.destroyed) return { ok: false, reclaimed: false };
			this.heartbeatFailures++;
			if ([46001, 46002, 46003, 46004, 46005, 46010, 46021, 46022].includes(backendErrorCode(error) || 0)) {
				if (!isStaleBackendIdentity(error)) FPMessage({ type: "warning", message: "房间成员身份已失效，请重新进入区服" });
				void this.close();
				return { ok: false, reclaimed: false, error: "房间成员身份已失效" };
			}
			try {
				const state = await getRoomSessionStatus(this.room.getRoomId());
				if (state.state === "closed" || state.state === "expired") { void this.close(); return { ok: false, reclaimed: false }; }
				if (state.state === "grace") {
					const renewed = await reclaimHostRoom(this.room.getRoomId(), { ...this.lease(), hostPeerId: this.peer.id });
					if (!renewed.hostLeaseToken) throw new Error("房主租约恢复未返回凭据");
					if (!this.destroyed) {
						this.hostLeaseToken = renewed.hostLeaseToken;
						this.hostEpoch = renewed.hostEpoch;
						this.heartbeatFailures = 0;
					}
					return { ok: true, reclaimed: true };
				}
			} catch { /* The next heartbeat retries a transient outage without disclosing credentials. */ }
			if (this.heartbeatFailures === 3) FPMessage({ type: "warning", message: "房间服务暂时不可达，正在恢复连接" });
			return { ok: false, reclaimed: false, error: "房主租约续期失败" };
		}
	}

	public debugSendHeartbeat(): Promise<HeartbeatResult> { return this.sendHeartbeat(); }

	public close(keepalive = false): Promise<void> {
		if (this.closeRequest) return this.closeRequest;
		if (this.destroyed) return Promise.resolve();
		this.destroyed = true;
		clearInterval(this.heartbeatTimer);
		window.removeEventListener("beforeunload", this.unload);
		this.room.notifyHostClosing();
		for (const conn of this.connections) conn.close();
		this.connections.clear();
		for (const timeout of this.heartbeatTimeoutMap.values()) clearTimeout(timeout);
		this.heartbeatTimeoutMap.clear();
		this.clientHeartCheckFns.clear();
		this.clientList.clear();
		this.room.destory();
		this.peer.destroy();
		this.destoryHandler?.();
		this.closeRequest = Promise.resolve().then(() => deleteRoom(this.room.getRoomId(), this.lease(), keepalive)).catch(() => undefined);
		return this.closeRequest;
	}

	public destory(): void { void this.close(); }
}
