import { useUtil } from "@src/store";
import { __PEER_OPTIONS__ } from "@src/../global.config";
import Peer, { DataConnection } from "peerjs";
import { connectionDiagnostics } from "@src/utils/connection-diagnostics";

export class PeerClient {
	private peer: Peer;
	private conn: DataConnection | null = null;
	private rtcConfig: RTCConfiguration;

	private constructor(peer: Peer, rtcConfig: RTCConfiguration) {
		this.peer = peer;
		this.rtcConfig = rtcConfig;
	}

	public getPeerId(): string {
		return this.peer.id;
	}

	/** 已断开的信令连接不能再创建 DataConnection，应由会话管理器重新注册。 */
	public isUsable(): boolean {
		return this.peer.open && !this.peer.destroyed && !this.peer.disconnected;
	}

	public async linkToHost(hostId: string, ticket: string) {
		if (!hostId) throw new Error("无效的主机ID");
		if (!ticket) throw new Error("缺少入房票据");
		if (!this.isUsable()) throw new Error("Peer 信令连接已断开，请重新连接");
		if (this.conn) {
			this.conn.close();
			this.conn = null;
		}

		connectionDiagnostics.stageStart("DataConnection");

		const conn = await new Promise<DataConnection>((resolve, reject) => {
			let pending: DataConnection | null = null;
			let settled = false;
			const cleanup = () => {
				clearTimeout(timeOutId);
				this.peer.off("error", onPeerError);
				this.peer.off("disconnected", onDisconnected);
				this.peer.off("close", onPeerClose);
				pending?.off("open", onOpen);
				pending?.off("error", onError);
				pending?.off("close", onClose);
			};
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				connectionDiagnostics.stageFail("DataConnection", error.message, {
					hostId,
					peerId: this.peer.id,
					iceConnectionState: this.getIceConnectionState(),
				});
				if (this.conn === pending) this.conn = null;
				pending?.close();
				reject(error);
			};
			const onError = (error: Error) => fail(error);
			const onPeerError = (error: Error) => fail(error);
			const onDisconnected = () => fail(new Error("Peer 信令连接已断开"));
			const onPeerClose = () => fail(new Error("Peer 信令连接已关闭"));
			const onClose = () => fail(new Error("主机连接在就绪前关闭"));
			const onOpen = () => {
				if (settled || !pending) return;
				settled = true;
				cleanup();
				connectionDiagnostics.stageEnd("DataConnection", {
					hostId,
					peerId: this.peer.id,
					connectionId: pending.connectionId,
				});
				if (useUtil().connectionMode === "unknown") {
					useUtil().connectionMode = this.rtcConfig.iceTransportPolicy === "relay" ? "relay" : "p2p";
				}
				resolve(pending);
			};
			const timeOutId = setTimeout(() => {
				connectionDiagnostics.checkRelayCandidates();
				fail(new Error("连接主机超时 (10s)"));
			}, 10000);
			this.peer.on("error", onPeerError);
			this.peer.on("disconnected", onDisconnected);
			this.peer.on("close", onPeerClose);
			try {
				pending = this.peer.connect(hostId, { reliable: true, metadata: { ticket } });
				if (!pending) {
					fail(new Error("Peer 信令连接不可用"));
					return;
				}
				if (settled) {
					pending.close();
					return;
				}
				this.conn = pending;
				pending.on("open", onOpen);
				pending.on("error", onError);
				pending.on("close", onClose);
				this.patchDataConnectionForIceLogging(pending);
				if (pending.open) onOpen();
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		return { conn, peer: this.peer };
	}

	public static async create(host: string, port: number, rtcConfig: RTCConfiguration, peerId?: string) {
		connectionDiagnostics.stageStart("SignalingConnect");
		connectionDiagnostics.setIceServers(rtcConfig.iceServers || []);
		const peerOptions = { ...__PEER_OPTIONS__(), debug: 0, config: rtcConfig };
		connectionDiagnostics.setSignalingInfo(`${peerOptions.host}:${peerOptions.port}${peerOptions.path}`, true);
		connectionDiagnostics.captureNetworkInfo();
		// 检测本地网络接口（不阻塞主流程）
		connectionDiagnostics.detectLocalInterfaces();

		// 向 PeerJS 信令服务器获取自己的 peerId
		const peer = await new Promise<Peer>((resolve, reject) => {
			connectionDiagnostics.logPeerEvent(
				"Peer.constructor",
				JSON.stringify({
					host: peerOptions.host,
					path: peerOptions.path,
					port: peerOptions.port,
					iceTransportPolicy: rtcConfig.iceTransportPolicy || "all",
				}),
			);

			const peer = peerId ? new Peer(peerId, peerOptions) : new Peer(peerOptions);
			let opened = false;
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(signalingTimeout);
				peer.destroy();
				reject(error);
			};
			const signalingTimeout = setTimeout(() => fail(new Error("连接 Peer 信令服务超时，请稍后重试")), 15000);

			// 注册 PeerJS 生命周期事件
			peer.on("open", (id) => {
				if (settled) return;
				settled = true;
				clearTimeout(signalingTimeout);
				opened = true;
				connectionDiagnostics.logPeerEvent("Peer.open", `peerId=${id}`);
				connectionDiagnostics.stageEnd("SignalingConnect", { peerId: id });
				resolve(peer);
			});

			peer.on("error", (e) => {
				connectionDiagnostics.logPeerEvent("Peer.error", `type=${e.type} message=${e.message}`);
				connectionDiagnostics.stageFail("SignalingConnect", `Peer错误: ${e.type} - ${e.message}`);
				if (!opened) fail(e);
			});

			peer.on("disconnected", () => {
				connectionDiagnostics.logPeerEvent("Peer.disconnected", "信令服务器断开连接");
				connectionDiagnostics.warn("PeerJS 信令服务器断开连接 (disconnected)");
				if (!opened) fail(new Error("Peer 信令连接在就绪前断开"));
			});

			peer.on("close", () => {
				connectionDiagnostics.logPeerEvent("Peer.close", "Peer 连接关闭");
				if (!opened) fail(new Error("Peer 信令连接在就绪前关闭"));
			});
		});

		return new PeerClient(peer, rtcConfig);
	}

	private static logExistingIceCandidates(pc: RTCPeerConnection) {
		try {
			let hasRelayCandidate = false;
			// 诊断只旁听事件，保留 PeerJS 自己的候选传输和 ICE 失败清理。
			pc.addEventListener("icecandidate", (event) => {
				if (!event.candidate) return;
				if (/\btyp relay\b/.test(event.candidate.candidate)) hasRelayCandidate = true;
				connectionDiagnostics.logIceCandidate(event.candidate);
			});
			pc.addEventListener("iceconnectionstatechange", () => {
				connectionDiagnostics.logPeerEvent("ICE.connectionStateChange", pc.iceConnectionState);
				if (pc.iceConnectionState === "failed") {
					connectionDiagnostics.error("ICE 连接失败 — 可能 TURN/STUN 不可达或 NAT 过于严格");
				}
				if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
					// 用 getStats 查询实际选中的候选对类型
					PeerClient.detectActualConnectionMode(pc, hasRelayCandidate);
				}
			});
			pc.addEventListener("icegatheringstatechange", () => {
				connectionDiagnostics.logPeerEvent("ICE.gatheringState", pc.iceGatheringState);
			});
			pc.addEventListener("icecandidateerror", (event) => {
				connectionDiagnostics.error(`ICE candidate error: ${event.errorText} (code: ${event.errorCode})`);
			});
		} catch (e) {
			// 静默失败
		}
	}

	/**
	 * 为 DataConnection 打补丁以记录 ICE 日志
	 */
	private patchDataConnectionForIceLogging(conn: DataConnection) {
		try {
			if (conn.peerConnection) PeerClient.logExistingIceCandidates(conn.peerConnection);
		} catch (e) {
			// 静默失败
		}
	}

	/**
	 * 通过 getStats 查询实际选中的候选对类型，确定真实连接模式
	 */
	private static async detectActualConnectionMode(pc: RTCPeerConnection, hasRelayCandidate: boolean) {
		try {
			const stats = await pc.getStats();
			let localCandidateType = "";

			for (const report of stats.values()) {
				if (report.type === "candidate-pair" && report.state === "succeeded") {
					const localCandidate = stats.get(report.localCandidateId);
					if (localCandidate && localCandidate.candidateType) {
						localCandidateType = localCandidate.candidateType;
					}
					break;
				}
			}

			const mode = localCandidateType === "relay" ? "relay" : "p2p";
			useUtil().connectionMode = mode;
		} catch (e) {
			// getStats 失败时回退到 hasRelayCandidate 判断
			const mode = hasRelayCandidate ? "relay" : "p2p";
			useUtil().connectionMode = mode;
		}
	}

	/**
	 * 获取当前 ICE 连接状态
	 */
	private getIceConnectionState(): string {
		return this.conn?.peerConnection?.iceConnectionState ?? "unknown";
	}

	public destory() {
		connectionDiagnostics.logPeerEvent("PeerClient.destory", "PeerClient 销毁");
		useUtil().connectionMode = "unknown";
		this.peer.destroy();
		this.conn = null;
	}
}
