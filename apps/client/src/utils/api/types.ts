/** GameBackend serializes identifiers as strings and expiry dates as epoch milliseconds. */
export interface Result<T> {
	code: number;
	msg: string;
	data: T;
}

export interface Page<T> {
	records: T[];
	total: number;
	current: number;
	size: number;
}

export interface AccountProfile {
	id: string;
	useraccount: string;
	username: string;
	avatarUrl: string | null;
	color: string | null;
	status: string;
	isAdmin: boolean;
	isCreator: boolean;
}

export interface AccountAuth {
	token: string;
	refreshToken: string;
	expiresAt: number;
	refreshExpiresAt: number;
	account: AccountProfile;
}

export interface RealmAuth {
	token: string;
	expiresAt: number;
	accountId: string;
	serverId: string;
	roleId: string;
	nickname: string;
}

export interface ActiveRealm extends RealmAuth {
	sessionId: string;
}

export interface RealmUser {
	id: string;
	userId: string;
	useraccount: string;
	username: string;
	avatar: string;
	color: string;
	isReady: boolean;
}

export interface ServerInfo {
	id: string;
	serverCode: string;
	serverName: string;
	status: "OPEN" | "MAINTENANCE" | "CLOSED";
	roleCapacity: number;
	roleCount: number;
	allowNewRoles: boolean;
	sortOrder: number;
	announcement: string | null;
	roleId: string | null;
	nickname: string | null;
}
