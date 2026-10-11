import { DataConnection } from "peerjs";
import {
	AIDecisionConfig,
	ClientSocketMessage,
	RoomMapInfo,
	ServerSocketMessage,
	SocketMessage,
	SocketMsgSource,
	SocketMsgType,
} from "@mine-monopoly/types";
import { PeerClient } from "@src/core/monopoly-client/PeerClient";
import { ReconnectionManager } from "@src/core/monopoly-client/ReconnectionManager";
import { MonopolyHost } from "@src/core/monopoly-host/MonopolyHost";
import { emitMemberHeart, getRoomSessionStatus, issueRoomTicket, leaveRoom } from "@src/utils/api/room-router";
import { getCurrentRealmUser } from "@src/utils/auth/session";
import { backendErrorCode, isStaleBackendIdentity } from "./peer-admission";
import { LocalPartySession } from "@src/core/local-party/LocalPartySession";

export type WebRtcSessionState =
	| "idle"
	| "hosting"
	| "connecting"
	| "connected"
	| "reconnecting"
	| "closing"
	| "closed"
	| "failed";
export type ConnectionStrategy = "prefer-p2p" | "force-relay";
export type SessionSendResult =
	| { ok: true; generation: number }
	| { ok: false; reason: "not-connected" | "send-failed"; error?: unknown };
export interface HostSessionRegistration {
	hostLeaseToken: string;
	hostEpoch: number;
	roomSessionId: string;
	capacity: number;
	/** 在创建主机时冻结身份信息，供服务端重启后的租约 reclaim 使用。 */
	hostName: string;
	hostId: string;
}
export interface WebRtcSessionManagerOptions {
	iceServer: { host: string; port: number };
	onMessage: (message: ServerSocketMessage) => void;
	onStateChange?: (state: WebRtcSessionState, detail?: string) => void;
	onHeartbeat?: (ping: number) => void;
	onReconnectAttempt?: (attempt: number, strategy: ConnectionStrategy) => void;
	onHostClosed?: (status: "closed" | "expired") => void;
	onReconnectCancelled?: () => void;
}

/** 地图分块二进制包类型标记（与主机端 Room.ts 保持一致） */
const MAP_CHUNK_BIN_TYPE = 1;

/**
 * 解析地图分块二进制包。
 * 新格式: [type][session 长度][session UTF-8][chunkIndex][数据]；旧格式: [type][chunkIndex][数据]。
 * 返回 null 表示不是合法的地图分块包。
 */
function parseMapChunkBinaryPacket(bytes: Uint8Array): SocketMessage<SocketMsgType.MapChunk, SocketMsgSource.Server> | null {
	if (bytes.length < 5 || bytes[0] !== MAP_CHUNK_BIN_TYPE) return null;

	const sessionLength = bytes[1];
	const indexOffset = 2 + sessionLength;
	const dataOffset = indexOffset + 4;
	const sessionCandidate =
		sessionLength > 0 && bytes.length >= dataOffset ? new TextDecoder().decode(bytes.slice(2, indexOffset)) : "";
	const isNewProtocolPacket = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionCandidate);

	if (isNewProtocolPacket) {
		const chunkIndex =
			(((bytes[indexOffset] << 24) | (bytes[indexOffset + 1] << 16) | (bytes[indexOffset + 2] << 8) | bytes[indexOffset + 3]) >>> 0);
		return {
			type: SocketMsgType.MapChunk,
			source: SocketMsgSource.Server,
			data: { mapLoadSessionId: sessionCandidate, chunkIndex, data: bytes.slice(dataOffset) },
		};
	}

	const chunkIndex = (((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0);
	return {
		type: SocketMsgType.MapChunk,
		source: SocketMsgSource.Server,
		data: { chunkIndex, data: bytes.slice(5) },
	};
}

type ReconnectContext = { roomId: string; hostPeerId: string; isReady: () => boolean };
export type WebRtcSessionEvent = "state" | "message" | "heartbeat" | "reconnect-attempt" | "host-closed";
class HostRoomClosedError extends Error {
	public constructor(public readonly status: "closed" | "expired") {
		super(status === "closed" ? "房主已退出，房间已关闭" : "房间已过期");
	}
}
class RoomIdentityExpiredError extends Error {
	public constructor(public readonly staleIdentity = false) { super("区服身份或房间成员席位已失效，请重新入房"); }
}

type JoinAcknowledgement = {
	connection: DataConnection;
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

export class WebRtcSessionManager {
	private peerClient: PeerClient | null = null;
	private connection: DataConnection | null = null;
	private host: MonopolyHost | null = null;
	private localPartySession: LocalPartySession | null = null;
	private state: WebRtcSessionState = "idle";
	private connectionGeneration = 0;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
	private lastHeartbeatSentAt = 0;
	private heartbeatPaused = false;
	private reconnectManager: ReconnectionManager | null = null;
	private reconnectContext: ReconnectContext | null = null;
	private iceServers: RTCIceServer[] = [];
	private strategy: ConnectionStrategy = "prefer-p2p";
	private peerStrategy: ConnectionStrategy | null = null;
	private explicitClose = false;
	private lifecycleGeneration = 0;
	private memberPeerId: string | null = null;
	private memberHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private memberHeartbeatRequest: Promise<void> | null = null;
	private connectionAttempt: { generation: number; request: Promise<void> } | null = null;
	private pendingJoin: JoinAcknowledgement | null = null;
	private closeRequest: Promise<void> | null = null;
	private readonly unload = () => {
		if (this.reconnectContext && !this.host) void leaveRoom(this.reconnectContext.roomId, true).catch(() => undefined);
	};
	private listeners = new Map<WebRtcSessionEvent, Set<(payload: unknown) => void>>();

	public constructor(private readonly options: WebRtcSessionManagerOptions) {}
	public on(event: WebRtcSessionEvent, listener: (payload: unknown) => void): () => void {
		const listeners = this.listeners.get(event) || new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}

	public getState(): WebRtcSessionState {
		return this.state;
	}
	public getConnectionGeneration(): number {
		return this.connectionGeneration;
	}
	public getConnectionStrategy(): ConnectionStrategy {
		return this.strategy;
	}
	/** 当前页面是否为本地派对会话。 */
	public isLocalParty(): boolean {
		return this.localPartySession !== null;
	}
	public async createLocalParty(defaultName: string): Promise<void> {
		await this.close();
		this.explicitClose = false;
		this.localPartySession = await LocalPartySession.create(defaultName, (message) => {
			this.options.onMessage(message);
			this.emit("message", message);
		});
		this.transition("connected", "本地派对");
	}
	public addLocalPartyPlayer() {
		return this.localPartySession?.addHuman() ?? Promise.resolve({ success: false, error: "本地派对未创建" });
	}
	public updateLocalPartyPlayerName(userId: string, username: string) {
		return this.localPartySession?.updateHumanName(userId, username) ?? { success: false, error: "本地派对未创建" };
	}
	public removeLocalPartyPlayer(userId: string) {
		return this.localPartySession?.removeHuman(userId) ?? { success: false, error: "本地派对未创建" };
	}

	public hasLocalHost(): boolean {
		return this.host !== null;
	}

	/** 仅供开发环境 window.__MM_TEST__ 调用：立即发送一次房主租约心跳。 */
	public async debugSendHostHeartbeat(): Promise<{ ok: boolean; reclaimed: boolean; error?: string }> {
		if (!this.host) throw new Error("当前页面未持有 P2P 主机实例");
		return this.host.debugSendHeartbeat();
	}

	/** 仅供开发环境 window.__MM_TEST__ 调用：关闭当前 P2P 连接，以触发正常重连流程。 */
	public debugDropP2pConnection(): void {
		if (!this.connection) throw new Error("当前没有可关闭的 P2P 连接");
		this.connection.close();
	}

	/** 仅供开发环境 window.__MM_TEST__ 调用：立即执行一次重连流程。 */
	public async debugReconnectNow(): Promise<void> {
		await this.reconnectNow();
	}
	public setIceServers(iceServers: RTCIceServer[]): void {
		this.iceServers = iceServers;
	}
	/** Reserve the ID before HTTP admission; create Peer only after obtaining this room's ICE configuration. */
	public async preparePeerId(): Promise<string> {
		return this.memberPeerId ?? (this.memberPeerId = crypto.randomUUID());
	}

	public async createHost(
		roomId: string,
		deleteIntervalMs: number,
		registration: HostSessionRegistration,
	): Promise<string> {
		if (this.closeRequest) await this.closeRequest;
		this.transition("hosting");
		this.explicitClose = false;
		const generation = this.lifecycleGeneration;
		const host = await MonopolyHost.create(
			roomId,
			this.options.iceServer.host,
			this.options.iceServer.port,
			deleteIntervalMs,
			this.iceServers,
			registration,
		);
		if (this.explicitClose || generation !== this.lifecycleGeneration) {
			await host.close();
			throw new Error("房主创建已取消");
		}
		this.host = host;
		host.addDestoryListener(() => {
			if (this.host === host) this.host = null;
		});
		return host.getPeerId();
	}

	public async connect(roomId: string, hostPeerId: string, isReady: () => boolean, peerId?: string): Promise<void> {
		if (this.closeRequest) await this.closeRequest;
		this.stopReconnection();
		this.explicitClose = false;
		if (peerId) this.memberPeerId = peerId;
		const generation = ++this.lifecycleGeneration;
		this.reconnectContext = { roomId, hostPeerId, isReady };
		window.addEventListener("beforeunload", this.unload);
		this.transition("connecting");
		await this.establishConnection(this.reconnectContext, generation);
		this.assertLifecycle(generation);
		this.transition("connected");
	}

	public send(message: ClientSocketMessage): SessionSendResult {
		if (this.localPartySession) {
			this.localPartySession.handleClientMessage(message);
			return { ok: true, generation: this.connectionGeneration };
		}
		if (!this.connection?.open || this.state === "closing" || this.state === "closed")
			return { ok: false, reason: "not-connected" };
		try {
			this.connection.send(
				JSON.stringify(message, (_key, value) =>
					value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value,
				),
			);
			return { ok: true, generation: this.connectionGeneration };
		} catch (error) {
			return { ok: false, reason: "send-failed", error };
		}
	}

	public pauseHeartbeat(): void {
		this.heartbeatPaused = true;
		this.clearHeartbeatTimeout();
	}
	public resumeHeartbeat(): void {
		this.heartbeatPaused = false;
		this.scheduleHeartbeatTimeout();
	}
	public handleHeartbeatReply(): void {
		if (this.lastHeartbeatSentAt) {
			const ping = Math.round((Date.now() - this.lastHeartbeatSentAt) / 2);
			this.options.onHeartbeat?.(ping);
			this.emit("heartbeat", ping);
		}
		this.scheduleHeartbeatTimeout();
	}
	public cancelReconnection(): void {
		this.reconnectManager?.cancel();
		this.reconnectManager = null;
	}
	public isReconnecting(): boolean {
		return this.state === "reconnecting";
	}

	public requestSave(): void {
		if (this.localPartySession) {
			this.localPartySession.requestSave();
			return;
		}
		this.host?.getRoom().requestSave();
	}
	public loadSave(record: any, usePrevious: boolean): Promise<{ success: boolean; error?: string }> {
		return (
			this.localPartySession?.loadSave(record, usePrevious) ?? this.host?.getRoom().loadSave(record, usePrevious) ?? Promise.resolve({ success: false, error: "未连接到主机" })
		);
	}
	public changeColorForUser(userId: string, color: string) {
		return this.localPartySession?.changeColorForUser(userId, color) ?? this.host?.getRoom().changeColor(userId, color) ?? { success: false, error: "只有房主可以执行此操作" };
	}
	public addAIPlayer() {
		return this.localPartySession?.addAIPlayer() ?? this.host?.getRoom().addAiPlayer() ?? { success: false, error: "只有房主可以添加 AI" };
	}
	public randomizeAIRoles(): boolean {
		return this.localPartySession?.randomizeAIRoles() ?? this.host?.getRoom().randomizeAiRoles() ?? false;
	}
	public setSpectatorMode(enabled: boolean) {
		return this.host?.getRoom().setOwnerSpectatorMode(enabled) ?? { success: false, error: "只有房主可以切换旁观模式" };
	}
	public changeRoleForUser(userId: string, roleId: string) {
		return this.localPartySession?.changeRoleForUser(userId, roleId) ?? this.host?.getRoom().changeRole(userId, roleId) ?? { success: false, error: "只有房主可以修改角色" };
	}
	public updateAIPlayerName(userId: string, username: string) {
		return (
			this.localPartySession?.updateAIPlayerName(userId, username) ?? this.host?.getRoom().updateAIPlayerName(userId, username) ?? { success: false, error: "只有房主可以修改 AI 名称" }
		);
	}
	public updateAIDecisionConfig(config: AIDecisionConfig): void {
		if (this.localPartySession) {
			this.localPartySession.updateAIDecisionConfig(config);
			return;
		}
		this.host?.getRoom().updateAIDecisionConfig(config);
	}
	public isAiPlayer(userId: string): boolean {
		return this.localPartySession?.isAiPlayer(userId) ?? this.host?.getRoom().isAiPlayer(userId) ?? false;
	}
	public removeAIPlayer(userId: string): boolean {
		return this.localPartySession?.removeAIPlayer(userId) ?? this.host?.getRoom().removeAiPlayer(userId) ?? false;
	}
	public changeLocalPartyMap(mapInfo: RoomMapInfo): Promise<{ success: boolean; error?: string }> {
		return this.localPartySession?.changeGameMap(mapInfo)
			?? Promise.resolve({ success: false, error: "本地派对未创建" });
	}
	public changeGameMap(mapInfo: RoomMapInfo): boolean {
		if (this.localPartySession || !this.host) return false;
		void this.host.getRoom().changeMap(mapInfo);
		return true;
	}

	public async close(): Promise<void> {
		if (this.closeRequest) return this.closeRequest;
		if (this.state === "closed" && !this.connection && !this.peerClient && !this.host && !this.localPartySession && !this.reconnectContext) return;
		this.explicitClose = true;
		++this.lifecycleGeneration;
		this.transition("closing");
		this.stopReconnection();
		this.stopHeartbeat();
		this.stopMemberHeartbeat();
		window.removeEventListener("beforeunload", this.unload);
		this.disposeConnection();
		this.peerClient?.destory();
		this.peerClient = null;
		this.peerStrategy = null;
		this.memberPeerId = null;
		const host = this.host;
		const roomId = this.reconnectContext?.roomId;
		this.localPartySession?.destroy();
		this.localPartySession = null;
		this.host = null;
		this.reconnectContext = null;
		this.closeRequest = (async () => {
			if (host) await host.close();
			else if (roomId) await leaveRoom(roomId).catch(() => undefined);
			this.transition("closed");
		})().finally(() => { this.closeRequest = null; });
		return this.closeRequest;
	}

	private async reconnectNow(): Promise<void> {
		const context = this.reconnectContext;
		if (!context) throw new Error("缺少重连上下文");
		const generation = this.lifecycleGeneration;
		if (this.connectionAttempt?.generation === generation) return this.connectionAttempt.request;
		const request = (async () => {
			await this.assertRoomStillActive(context.roomId);
			this.assertLifecycle(generation);
			await this.establishConnection(context, generation);
		})().catch((error: unknown) => {
			this.throwLifecycleError(error);
		}).finally(() => {
			if (this.connectionAttempt?.request === request) this.connectionAttempt = null;
		});
		this.connectionAttempt = { generation, request };
		return request;
	}

	private async establishConnection(context: ReconnectContext, generation: number): Promise<void> {
		await this.openConnection(context.roomId, context.hostPeerId, generation);
		this.assertLifecycle(generation);
		const connection = this.connection!;
		const acknowledged = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => this.rejectPendingJoin(new Error("房主成员校验超时")), 15000);
			this.pendingJoin = { connection, resolve, reject, timer };
		});
		if (!this.sendJoinRoom(context.isReady()).ok) this.rejectPendingJoin(new Error("加入房间消息发送失败"));
		await acknowledged;
		this.assertLifecycle(generation);
		this.startMemberHeartbeat(context.roomId, generation);
	}

	private assertLifecycle(generation: number): void {
		if (this.explicitClose || generation !== this.lifecycleGeneration) throw new Error("房间连接已取消");
	}

	private throwLifecycleError(error: unknown): never {
		const code = backendErrorCode(error);
		if (code === 46022) throw new HostRoomClosedError("expired");
		if (code !== undefined && [46001, 46002, 46003, 46004, 46005, 46010].includes(code)) throw new RoomIdentityExpiredError(isStaleBackendIdentity(error));
		throw error;
	}

	private rejectPendingJoin(error: Error): void {
		const pending = this.pendingJoin;
		if (!pending) return;
		this.pendingJoin = null;
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	private async openConnection(roomId: string, hostPeerId: string, generation: number): Promise<void> {
		this.disposeConnection();
		await this.ensurePeerClient(generation);
		this.assertLifecycle(generation);
		const peer = this.peerClient!;
		const ticket = await issueRoomTicket(roomId, peer.getPeerId());
		this.assertLifecycle(generation);
		const { conn } = await peer.linkToHost(hostPeerId, ticket.ticket);
		if (this.explicitClose || generation !== this.lifecycleGeneration || this.peerClient !== peer) {
			conn.close();
			throw new Error("房间连接已取消");
		}
		this.bindConnection(conn);
	}

	private async ensurePeerClient(generation: number): Promise<void> {
		if (this.peerClient && this.peerStrategy === this.strategy) return;
		if (this.peerClient) {
			this.peerClient.destory();
			this.peerClient = null;
			// The new transport receives a fresh ticket, so a new ID avoids a stale signaling registration.
			this.memberPeerId = crypto.randomUUID();
		}
		const strategy = this.strategy;
		const peer = await PeerClient.create(
			this.options.iceServer.host,
			this.options.iceServer.port,
			this.buildRtcConfig(),
			await this.preparePeerId(),
		);
		if (this.explicitClose || generation !== this.lifecycleGeneration) {
			peer.destory();
			throw new Error("信令连接已取消");
		}
		this.peerClient = peer;
		this.peerStrategy = strategy;
	}
	private buildRtcConfig(): RTCConfiguration {
		return { iceServers: this.iceServers, ...(this.strategy === "force-relay" ? { iceTransportPolicy: "relay" } : {}) };
	}

	private bindConnection(connection: DataConnection): void {
		this.connection = connection;
		const generation = ++this.connectionGeneration;
		this.startHeartbeat();
		connection.on("data", (payload: unknown) => {
			if (!this.isCurrentConnection(connection, generation)) return;
			try {
				// 二进制通道：地图分块包（主机端直传 Uint8Array，接收端为 ArrayBuffer）
				if (payload instanceof ArrayBuffer || payload instanceof Uint8Array) {
					const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
					const mapChunkMsg = parseMapChunkBinaryPacket(bytes);
					if (mapChunkMsg) {
						this.options.onMessage(mapChunkMsg);
						this.emit("message", mapChunkMsg);
					}
					return;
				}
				const message = JSON.parse(String(payload), (_key, value) =>
					value === "Infinity" ? Infinity : value === "-Infinity" ? -Infinity : value,
				) as ServerSocketMessage;
				if (!message || message.source !== SocketMsgSource.Server) return;
				if (message.type === SocketMsgType.JoinRoom && this.pendingJoin?.connection === connection) {
					const pending = this.pendingJoin;
					this.pendingJoin = null;
					clearTimeout(pending.timer);
					if (message.msg?.type === "error") pending.reject(new Error(message.msg.content));
					else pending.resolve();
				}
				this.options.onMessage(message);
				this.emit("message", message);
			} catch {
				// Invalid transport payloads cannot alter the established room identity.
			}
		});
		connection.on("close", () => this.handleConnectionLoss(connection, generation, "连接已关闭"));
		connection.on("error", (error) =>
			this.handleConnectionLoss(connection, generation, "连接异常: " + (error.message || error)),
		);
	}

	private handleConnectionLoss(connection: DataConnection, generation: number, detail: string): void {
		if (!this.isCurrentConnection(connection, generation) || this.explicitClose) return;
		this.rejectPendingJoin(new Error(detail));
		this.connection = null;
		this.stopHeartbeat();
		this.startReconnection(detail);
	}
	private startMemberHeartbeat(roomId: string, generation: number): void {
		this.stopMemberHeartbeat();
		const renew = () => {
			if (this.explicitClose || generation !== this.lifecycleGeneration || this.memberHeartbeatRequest) return;
			const request = emitMemberHeart(roomId).catch((error: unknown) => {
				if (this.explicitClose || generation !== this.lifecycleGeneration) return;
				const code = backendErrorCode(error);
				if (code === undefined || ![46001, 46002, 46003, 46004, 46005, 46010, 46022].includes(code)) return;
				const closingGeneration = this.lifecycleGeneration + 1;
				void this.close().then(() => {
					if (this.lifecycleGeneration !== closingGeneration || !this.explicitClose || isStaleBackendIdentity(error)) return;
					this.options.onHostClosed?.(code === 46022 ? "expired" : "closed");
					this.emit("host-closed", code === 46022 ? "expired" : "closed");
				});
			}).finally(() => { if (this.memberHeartbeatRequest === request) this.memberHeartbeatRequest = null; });
			this.memberHeartbeatRequest = request;
		};
		// HTTP liveness continues during map loading and transport recovery.
		renew();
		this.memberHeartbeatTimer = setInterval(renew, 10000);
	}
	private stopMemberHeartbeat(): void {
		if (this.memberHeartbeatTimer) clearInterval(this.memberHeartbeatTimer);
		this.memberHeartbeatTimer = null;
		this.memberHeartbeatRequest = null;
	}
	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (this.heartbeatPaused || this.state !== "connected") return;
			this.lastHeartbeatSentAt = Date.now();
			if (this.send({ type: SocketMsgType.Heart, source: SocketMsgSource.Client, data: undefined }).ok)
				this.scheduleHeartbeatTimeout();
		}, 3000);
	}
	private scheduleHeartbeatTimeout(): void {
		this.clearHeartbeatTimeout();
		if (this.heartbeatPaused || this.state !== "connected") return;
		this.heartbeatTimeout = setTimeout(() => {
			if (this.state === "connected") this.startReconnection("心跳超时");
		}, 5000);
	}
	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
		this.clearHeartbeatTimeout();
	}
	private clearHeartbeatTimeout(): void {
		if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
		this.heartbeatTimeout = null;
	}

	private startReconnection(detail: string): void {
		if (!this.reconnectContext || this.state === "reconnecting" || this.explicitClose) return;
		this.transition("reconnecting", detail);
		this.reconnectManager = new ReconnectionManager(async () => this.reconnectNow(), {
			retryInterval: 3000,
			maxRetries: Number.POSITIVE_INFINITY,
			showCountdown: true,
			getDisplayState: (attempt) => ({
				title: "正在恢复连接",
				message: "正在第 " + attempt + " 次恢复房间连接",
				actionLabel: "离开房间",
			}),
			onRetry: (attempt) => {
				if (attempt >= 4) this.strategy = "force-relay";
				this.options.onReconnectAttempt?.(attempt, this.strategy);
				this.emit("reconnect-attempt", { attempt, strategy: this.strategy });
			},
			onSuccess: () => { if (!this.explicitClose) this.transition("connected"); },
			onFail: (error) => {
				if (this.explicitClose) return;
				this.reconnectManager = null;
				if (error instanceof HostRoomClosedError) {
					void this.close();
					this.options.onHostClosed?.(error.status);
					this.emit("host-closed", error.status);
					return;
				}
				if (error instanceof RoomIdentityExpiredError) {
					void this.close();
					if (error.staleIdentity) return;
					this.options.onHostClosed?.("closed");
					this.emit("host-closed", "closed");
					return;
				}
				this.transition("failed", error.message);
			},
			onCancel: () => {
				void this.close();
				this.options.onReconnectCancelled?.();
			},
			shouldRetry: (error) => !(error instanceof HostRoomClosedError) && !(error instanceof RoomIdentityExpiredError),
		});
		this.reconnectManager.start();
	}
	private stopReconnection(): void {
		this.reconnectManager?.destroy();
		this.reconnectManager = null;
	}
	private async assertRoomStillActive(roomId: string): Promise<void> {
		const status = (await getRoomSessionStatus(roomId)).state;
		if (status === "closed" || status === "expired") throw new HostRoomClosedError(status);
		// grace(宽限期)与 active 均视为可重连
		if (status !== "active" && status !== "grace") throw new Error("房间会话不可用");
	}
	private sendJoinRoom(isReady: boolean): SessionSendResult {
		const user = getCurrentRealmUser();
		if (!user) return { ok: false, reason: "not-connected" };
		return this.send({
			type: SocketMsgType.JoinRoom,
			source: SocketMsgSource.Client,
			data: { userId: user.userId, username: user.username, color: user.color, avatar: user.avatar, isReady },
		});
	}
	private disposeConnection(): void {
		this.rejectPendingJoin(new Error("连接已替换或关闭"));
		if (!this.connection) return;
		this.connectionGeneration++;
		this.connection.removeAllListeners();
		this.connection.close();
		this.connection = null;
	}
	private isCurrentConnection(connection: DataConnection, generation: number): boolean {
		return this.connection === connection && this.connectionGeneration === generation;
	}
	private emit(event: WebRtcSessionEvent, payload: unknown): void {
		this.listeners.get(event)?.forEach((listener) => listener(payload));
	}
	private transition(state: WebRtcSessionState, detail?: string): void {
		this.state = state;
		this.options.onStateChange?.(state, detail);
		this.emit("state", { state, detail });
	}
}
