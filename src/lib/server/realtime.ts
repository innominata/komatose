import { hasSeriesAccess } from './access';
import { getEpisode } from './queries';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { PublicUser, WsEvent } from '../types';
import { getUserBySession, parseCookies, SESSION_COOKIE } from './auth';

type Client = {
	ws: WebSocket;
	user: PublicUser;
	episodeId: string;
	seriesId: string;
	sessionId: string;
};

const RECHECK_MS = 30_000;

const g = globalThis as typeof globalThis & { __scanRooms?: Map<string, Set<Client>> };
if (!g.__scanRooms) g.__scanRooms = new Map();
const rooms = g.__scanRooms;

function room(episodeId: string): Set<Client> {
	let set = rooms.get(episodeId);
	if (!set) {
		set = new Set();
		rooms.set(episodeId, set);
	}
	return set;
}

function dropClient(client: Client, code = 4003, reason = 'revoked') {
	room(client.episodeId).delete(client);
	if (client.ws.readyState === 1 || client.ws.readyState === 0) {
		client.ws.close(code, reason);
	}
}

function everyClient(): Client[] {
	const out: Client[] = [];
	for (const set of rooms.values()) out.push(...set);
	return out;
}

export function closeSocketsForSession(sessionId: string) {
	if (!sessionId) return 0;
	let n = 0;
	for (const client of everyClient()) {
		if (client.sessionId === sessionId) {
			dropClient(client, 4001, 'session-ended');
			n += 1;
		}
	}
	return n;
}

export function closeSocketsForUser(userId: string) {
	if (!userId) return 0;
	let n = 0;
	for (const client of everyClient()) {
		if (client.user.id === userId) {
			dropClient(client, 4001, 'session-ended');
			n += 1;
		}
	}
	return n;
}

export function closeSocketsForSeriesUser(seriesId: string, userId: string) {
	if (!seriesId || !userId) return 0;
	let n = 0;
	for (const client of everyClient()) {
		if (client.seriesId === seriesId && client.user.id === userId) {
			dropClient(client, 4003, 'access-revoked');
			n += 1;
		}
	}
	return n;
}

async function clientStillAllowed(client: Client): Promise<boolean> {
	const user = await getUserBySession(client.sessionId);
	if (!user || user.id !== client.user.id) return false;
	return hasSeriesAccess(user, client.seriesId);
}

let deferredBroadcasts: [string, WsEvent, WebSocket | undefined][] | undefined;

/** Publish a synchronous batch only after its database transaction succeeds. */
export function withDeferredBroadcasts<T>(action: () => T): T {
	const parent = deferredBroadcasts;
	const pending: [string, WsEvent, WebSocket | undefined][] = [];
	deferredBroadcasts = pending;
	let result: T;
	try {
		result = action();
	} finally {
		deferredBroadcasts = parent;
	}
	if (parent) parent.push(...pending);
	else for (const [episodeId, event, except] of pending) broadcast(episodeId, event, except);
	return result;
}

export function broadcast(episodeId: string, event: WsEvent, except?: WebSocket) {
	if (deferredBroadcasts) {
		deferredBroadcasts.push([episodeId, event, except]);
		return;
	}
	const clients = room(episodeId);
	if (
		(event.type === 'image:upsert' ||
			event.type === 'image:delete' ||
			event.type === 'image:reorder' ||
			event.type === 'page:describe') &&
		clients.size === 0
	) {
		console.warn(`[ws] ${event.type} dropped — no listeners for ${episodeId}`);
	}
	const payload = JSON.stringify(event);
	for (const client of clients) {
		if (client.ws === except) continue;
		if (client.ws.readyState === 1) client.ws.send(payload);
	}
}

export function presenceUsers(episodeId: string): PublicUser[] {
	const seen = new Map<string, PublicUser>();
	for (const c of room(episodeId)) seen.set(c.user.id, c.user);
	return [...seen.values()];
}

function emitPresence(episodeId: string) {
	broadcast(episodeId, { type: 'presence', users: presenceUsers(episodeId) });
}

function episodeIdFromUrl(url: string | undefined): string | null {
	if (!url) return null;
	try {
		const u = new URL(url, 'http://localhost');
		return u.searchParams.get('episodeId');
	} catch {
		return null;
	}
}

type UpgradeServer = {
	on(
		event: 'upgrade',
		listener: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
	): unknown;
};

export function attachWss(server: UpgradeServer) {
	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket, head) => {
		const url = req.url || '';
		if (!url.startsWith('/ws')) return;
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req);
		});
	});

	wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
		const episodeId = episodeIdFromUrl(req.url);
		const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
		const user = await getUserBySession(sessionId);
		if (!episodeId || !user || !sessionId) {
			ws.close(4001, 'unauthorized');
			return;
		}
		const episode = await getEpisode(episodeId);
		if (!episode || !(await hasSeriesAccess(user, episode.seriesId))) {
			ws.close(4003, 'forbidden');
			return;
		}
		const client: Client = { ws, user, episodeId, seriesId: episode.seriesId, sessionId };
		room(episodeId).add(client);
		ws.send(JSON.stringify({ type: 'presence', users: presenceUsers(episodeId) } satisfies WsEvent));
		emitPresence(episodeId);

		const recheck = setInterval(() => {
			void clientStillAllowed(client).then((ok) => {
				if (!ok) dropClient(client, 4003, 'revoked');
			});
		}, RECHECK_MS);
		ws.on('close', () => {
			clearInterval(recheck);
			room(episodeId).delete(client);
			emitPresence(episodeId);
		});
		ws.on('error', () => {
			clearInterval(recheck);
			room(episodeId).delete(client);
		});
	});

	return wss;
}
