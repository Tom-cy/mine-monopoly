import apiClient from "./index";
import { __MONOPOLYSERVER__ } from "@src/../global.config";
import { getActiveRealm, getRealmToken } from "@src/utils/auth/session";
import { rememberFrozenRoomMap, forgetFrozenRoomMap } from "./map";

export interface RoomVO {
	id: string;
	serverId: string;
	roomCode: string;
	roomSessionId: string;
	hostRoleId: string;
	hostName: string;
	hostEpoch: number;
	state: "active" | "grace" | "closed" | "expired";
	hostReady: boolean;
	privateRoom: boolean;
	started: boolean;
	capacity: number;
	occupiedSeats: number;
	mapId: string;
	mapName: string;
	mapVersion: string;
	mapUrl: string;
	mapHash: string;
	createdTime: number;
	leaseExpiresAt: number;
	heartbeatIntervalMs: number;
}
export interface HostLease {
	hostLeaseToken?: string;
	hostEpoch: number;
	roomSessionId: string;
	state: RoomVO["state"];
	leaseExpiresAt: number;
	heartbeatIntervalMs: number;
}
export interface HostLeaseRequest {
	hostLeaseToken: string;
	hostEpoch: number;
}
export interface HostReadyRequest extends HostLeaseRequest {
	hostPeerId: string;
}
export interface RoomTicket {
	ticket: string;
	expiresAt: number;
	roomSessionId: string;
	hostEpoch: number;
	roleId: string;
	peerId: string;
}
export interface ConsumedRoomTicket {
	roleId: string;
	roomSessionId: string;
	hostEpoch: number;
	peerId: string;
	consumedAt: number;
}
export interface RoomAdmission {
	matched: boolean;
	needCreate: boolean;
	room?: RoomVO;
	hostPeerId?: string;
	hostLeaseToken?: string;
	peerTicket?: RoomTicket;
	iceServers: RTCIceServer[];
}
export interface RoomJoinRequest {
	roomCode: string;
	requestId: string;
	mapId?: string;
	capacity?: number;
	privateRoom?: boolean;
	peerId: string;
}
const rooms = new Map<string, { room: RoomVO; realmSessionId: string; lease?: HostLeaseRequest }>();
interface RealmRequestContext {
	realmSessionId: string;
	token: string;
}
function realmIdentityError(): Error & { code: number; staleIdentity: boolean } {
	return Object.assign(new Error("区服身份已变更，请重新入房"), {
		code: 46002,
		staleIdentity: getActiveRealm() !== null,
	});
}
function captureRealm(roomId?: string): RealmRequestContext {
	if (roomId) requireRoomRealm(roomId);
	const realm = getActiveRealm();
	const token = getRealmToken();
	if (!realm || !token) throw realmIdentityError();
	return { realmSessionId: realm.sessionId, token };
}
function assertCurrentRealm(context: RealmRequestContext): void {
	if (getActiveRealm()?.sessionId !== context.realmSessionId) throw realmIdentityError();
}
function realmConfig(context: RealmRequestContext) {
	return { identity: "realm" as const, silent: true, expectedRealmSessionId: context.realmSessionId };
}

export function rememberRoomAdmission(admission: RoomAdmission, expectedRealmSessionId?: string): void {
	if (!admission.room) return;
	const realm = getActiveRealm();
	if (expectedRealmSessionId && realm?.sessionId !== expectedRealmSessionId) {
		throw realmIdentityError();
	}
	if (!realm || realm.serverId !== admission.room.serverId) throw new Error("房间不属于当前区服");
	rememberFrozenRoomMap(admission.room);
	const previous = rooms.get(admission.room.id);
	rooms.set(admission.room.id, {
		room: admission.room,
		realmSessionId: realm.sessionId,
		lease: admission.hostLeaseToken
			? { hostLeaseToken: admission.hostLeaseToken, hostEpoch: admission.room.hostEpoch }
			: previous?.realmSessionId === realm.sessionId && previous.room.roomSessionId === admission.room.roomSessionId
				? previous.lease
				: undefined,
	});
}
export function getRegisteredRoom(roomId: string): RoomVO | undefined {
	const context = rooms.get(roomId);
	return context?.realmSessionId === getActiveRealm()?.sessionId ? context?.room : undefined;
}
function requireRoomRealm(roomId: string): void {
	const context = rooms.get(roomId);
	const realm = getActiveRealm();
	if (!realm || (context && context.realmSessionId !== realm.sessionId)) throw realmIdentityError();
}
function currentLease(roomId: string, lease?: HostLeaseRequest): HostLeaseRequest {
	requireRoomRealm(roomId);
	const credentials = lease || rooms.get(roomId)?.lease;
	if (!credentials) throw new Error("当前会话没有房主租约");
	return credentials;
}
function rememberLease(
	roomId: string,
	request: HostLeaseRequest,
	result: HostLease,
	realmContext: RealmRequestContext,
): HostLease {
	assertCurrentRealm(realmContext);
	const context = rooms.get(roomId);
	if (context) {
		if (context.room.roomSessionId !== result.roomSessionId) throw new Error("房间会话已经变化");
		context.room = {
			...context.room,
			hostEpoch: result.hostEpoch,
			state: result.state,
			leaseExpiresAt: result.leaseExpiresAt,
		};
		context.lease = { hostLeaseToken: result.hostLeaseToken || request.hostLeaseToken, hostEpoch: result.hostEpoch };
	}
	return result;
}
function path(roomId: string, action: string): string {
	if (!/^[1-9][0-9]*$/.test(roomId)) throw new Error("无效的房间资源 ID");
	return "/rooms/" + encodeURIComponent(roomId) + "/" + action;
}
export async function joinRoomApi(request: RoomJoinRequest): Promise<RoomAdmission> {
	const context = captureRealm();
	const response = await apiClient.post<RoomAdmission>("/rooms/join", request, realmConfig(context));
	return acceptAdmission(response.data, context);
}
export async function matchRoomApi(request: { requestId: string; peerId: string }): Promise<RoomAdmission> {
	const context = captureRealm();
	const response = await apiClient.post<RoomAdmission>("/rooms/match", request, realmConfig(context));
	return acceptAdmission(response.data, context);
}
async function acceptAdmission(admission: RoomAdmission, context: RealmRequestContext): Promise<RoomAdmission> {
	try {
		assertCurrentRealm(context);
		rememberRoomAdmission(admission, context.realmSessionId);
		return admission;
	} catch (error) {
		// A successful admission reserves a server seat even if the response cannot be used locally.
		if (admission.room) {
			try {
				const lease =
					admission.needCreate && admission.hostLeaseToken
						? { hostLeaseToken: admission.hostLeaseToken, hostEpoch: admission.room.hostEpoch }
						: undefined;
				await sendCapturedExit(admission.room.id, lease ? "close" : "leave", lease, context, false);
			} catch {
				// The server expiry path remains the fallback when compensation cannot reach the service.
			}
		}
		throw error;
	}
}
export async function readyHostRoom(roomId: string, request: HostReadyRequest): Promise<HostLease> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<HostLease>(path(roomId, "host/ready"), request, realmConfig(context));
	return rememberLease(roomId, request, response.data, context);
}
export async function emitRoomHeart(roomId: string, request: HostLeaseRequest): Promise<HostLease> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<HostLease>(path(roomId, "heartbeats"), request, realmConfig(context));
	return rememberLease(roomId, request, response.data, context);
}
export async function reclaimHostRoom(roomId: string, request: HostReadyRequest): Promise<HostLease> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<HostLease>(path(roomId, "host/reclaim"), request, realmConfig(context));
	return rememberLease(roomId, request, response.data, context);
}
async function sendCapturedExit(
	roomId: string,
	action: "close" | "leave",
	body: HostLeaseRequest | undefined,
	context: RealmRequestContext,
	keepalive: boolean,
): Promise<void> {
	const response = await fetch(__MONOPOLYSERVER__.replace(/\/$/, "") + path(roomId, action), {
		method: "POST",
		keepalive,
		headers: { Authorization: "Bearer " + context.token, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!response.ok) throw new Error("离房请求失败 (" + response.status + ")");
	const result = (await response.json()) as { code: number; msg?: string };
	if (result.code !== 200) throw new Error(result.msg || "离房请求失败");
}
async function exitRequest(
	roomId: string,
	action: "close" | "leave",
	body: HostLeaseRequest | undefined,
	keepalive: boolean,
): Promise<void> {
	const context = captureRealm(roomId);
	const resourcePath = path(roomId, action);
	if (keepalive) {
		await sendCapturedExit(roomId, action, body, context, true);
	} else await apiClient.post(resourcePath, body, realmConfig(context));
	if (rooms.get(roomId)?.realmSessionId === context.realmSessionId) {
		rooms.delete(roomId);
		forgetFrozenRoomMap(roomId);
	}
}
export function deleteRoom(roomId: string, lease?: HostLeaseRequest, keepalive = false): Promise<void> {
	return exitRequest(roomId, "close", currentLease(roomId, lease), keepalive);
}
export function leaveRoom(roomId: string, keepalive = false): Promise<void> {
	return exitRequest(roomId, "leave", undefined, keepalive);
}
export async function getRoomSessionStatus(roomId: string): Promise<RoomVO> {
	const context = captureRealm(roomId);
	const response = await apiClient.get<RoomVO>(path(roomId, "status"), realmConfig(context));
	assertCurrentRealm(context);
	return response.data;
}
export async function setRoomPrivate(roomId: string, privateRoom: boolean, lease?: HostLeaseRequest): Promise<RoomVO> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<RoomVO>(
		path(roomId, "privacy"),
		{ ...currentLease(roomId, lease), privateRoom },
		realmConfig(context),
	);
	assertCurrentRealm(context);
	return response.data;
}
export async function setRoomStarted(roomId: string, started: boolean, lease?: HostLeaseRequest): Promise<RoomVO> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<RoomVO>(
		path(roomId, "started"),
		{ ...currentLease(roomId, lease), started },
		realmConfig(context),
	);
	assertCurrentRealm(context);
	return response.data;
}
export async function issueRoomTicket(roomId: string, peerId: string): Promise<RoomTicket> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<RoomTicket>(path(roomId, "tickets"), { peerId }, realmConfig(context));
	assertCurrentRealm(context);
	return response.data;
}
export async function consumeRoomTicket(
	roomId: string,
	request: HostLeaseRequest & { ticket: string; actualPeerId: string },
): Promise<ConsumedRoomTicket> {
	const context = captureRealm(roomId);
	const response = await apiClient.post<ConsumedRoomTicket>(
		path(roomId, "tickets/consume"),
		request,
		realmConfig(context),
	);
	assertCurrentRealm(context);
	return response.data;
}
export async function emitMemberHeart(roomId: string): Promise<void> {
	const context = captureRealm(roomId);
	await apiClient.post(path(roomId, "members/heartbeat"), undefined, realmConfig(context));
	assertCurrentRealm(context);
}
