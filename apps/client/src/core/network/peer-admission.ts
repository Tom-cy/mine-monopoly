import type { User } from "@mine-monopoly/types";

export interface PeerIdentity {
	roleId: string;
	roomSessionId: string;
	hostEpoch: number;
	peerId: string;
}

/** The Peer connection and the consumed server ticket jointly identify a player. */
export function verifyPeerIdentity(identity: PeerIdentity, expected: Omit<PeerIdentity, "roleId">): string {
	if (
		typeof identity.roleId !== "string" ||
		!/^[1-9]\d*$/.test(identity.roleId) ||
		identity.peerId !== expected.peerId ||
		identity.roomSessionId !== expected.roomSessionId ||
		identity.hostEpoch !== expected.hostEpoch
	) {
		throw new Error("成员票据与当前房间连接不符");
	}
	return identity.roleId;
}

/** Profile fields are cosmetic; client-supplied IDs, roles and privilege flags are discarded. */
export function canonicalPeerUser(profile: Record<string, unknown>, roleId: string): User {
	const username =
		typeof profile.username === "string" ? profile.username.replace(/[<>]/g, "").trim().slice(0, 20) : "";
	const avatar =
		typeof profile.avatar === "string" &&
		profile.avatar.length <= 2048 &&
		/^(https?:\/\/|\/)/i.test(profile.avatar) &&
		!profile.avatar.startsWith("//")
			? profile.avatar
			: "";
	return {
		userId: roleId,
		username: username || `玩家${roleId}`,
		avatar,
		color: typeof profile.color === "string" && /^#[a-f\d]{6}$/i.test(profile.color) ? profile.color : "#409eff",
		isReady: profile.isReady === true,
	};
}

export function readPeerTicket(metadata: unknown): string {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("ticket" in metadata) ||
		typeof metadata.ticket !== "string" ||
		!metadata.ticket ||
		metadata.ticket.length > 512
	) {
		throw new Error("连接缺少成员票据");
	}
	return metadata.ticket;
}

export function backendErrorCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	if ("code" in error && typeof error.code === "number") return error.code;
	if ("response" in error && error.response && typeof error.response === "object" && "data" in error.response) {
		const data = error.response.data;
		if (data && typeof data === "object" && "code" in data && typeof data.code === "number") return data.code;
	}
	return undefined;
}

export function isStaleBackendIdentity(error: unknown): boolean {
	return !!error && typeof error === "object" && "staleIdentity" in error && error.staleIdentity === true;
}
