import 'reflect-metadata';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {ObjectId} from 'mongodb';
import {Server} from 'socket.io';
import {io as connect, Socket} from 'socket.io-client';
import {MongoDatabase} from '#shared/database/providers/mongo/MongoDatabase.js';
import {WhiteboardGateway} from '../WhiteboardGateway.js';
import {WhiteboardRepository} from '../WhiteboardRepository.js';
import {WhiteboardService} from '../WhiteboardService.js';
import {VoiceSignaling} from '../VoiceSignaling.js';
import {VoiceRegistry} from '../VoiceRegistry.js';
import {computeAccess} from '../access.js';
import type {SessionDocument} from '../types.js';

/**
 * End-to-end over a real Socket.IO server, the real gateway/service/
 * repository and the in-memory Mongo replica set (test/globalSetup.ts).
 * Only token verification is stubbed: tokens map to fixed users.
 */
const id = () => new ObjectId().toHexString();
const OWNER = id();
const BOB = id();
const CAROL = id();
const DAVE = id();
const USERS: Record<string, {_id: string; firstName: string}> = {
  owner: {_id: OWNER, firstName: 'Olivia'},
  bob: {_id: BOB, firstName: 'Bob'},
  carol: {_id: CAROL, firstName: 'Carol'},
  dave: {_id: DAVE, firstName: 'Dave'},
};
const auth = {
  getCurrentUserFromToken: async (token: string) => {
    if (!USERS[token]) throw new Error('bad token');
    return USERS[token];
  },
} as any;

let db: MongoDatabase;
let service: WhiteboardService;
let server: http.Server;
let ioServer: Server;
let voice: VoiceSignaling;
let url: string;
let room: string;
const clients: Socket[] = [];

beforeAll(async () => {
  db = new MongoDatabase(process.env.DB_URL!, 'whiteboard_moderation_test');
  await db.connect();
  service = new WhiteboardService(new WhiteboardRepository(db));
});
afterAll(async () => {
  await db.disconnect();
});

beforeEach(async () => {
  server = http.createServer();
  ioServer = new Server(server);
  voice = new VoiceSignaling(ioServer);
  new WhiteboardGateway(ioServer, auth, service, [voice]);
  await new Promise<void>(resolve => server.listen(0, resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
  room = (await service.create(OWNER, 'Physics')).roomCode;
});

afterEach(async () => {
  clients.splice(0).forEach(c => c.disconnect());
  await new Promise<void>(resolve => ioServer.close(() => resolve()));
});

// ---------- helpers ----------

const once = <T = any>(socket: Socket, event: string, ms = 2000) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${event}`)), ms);
    socket.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
/** First `event` payload satisfying `predicate` — stale earlier broadcasts can't satisfy a later assertion. */
const until = <T = any>(
  socket: Socket,
  event: string,
  predicate: (value: T) => boolean,
  ms = 2000,
) =>
  new Promise<T>((resolve, reject) => {
    const handler = (value: T) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(value);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout: ${event}`));
    }, ms);
    socket.on(event, handler);
  });
const voiceList = (socket: Socket, predicate: (list: any[]) => boolean) =>
  until<any[]>(socket, 'voice:participants', predicate);
const byUser = (list: any[], userId: string) =>
  list.find(p => p.userId === userId);
// Mirrors the real client: no payload argument at all when none is given.
const ack = <T = any>(socket: Socket, event: string, ...payload: unknown[]) =>
  socket.timeout(2000).emitWithAck(event, ...payload) as Promise<T>;
const nothing = (socket: Socket, event: string, ms = 250) =>
  new Promise<void>((resolve, reject) => {
    const handler = () => reject(new Error(`unexpected ${event}`));
    socket.once(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });

async function client(token: string, roomCode: string | null = room) {
  const socket = connect(url, {
    auth: {token},
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });
  clients.push(socket);
  await once(socket, 'connect');
  if (roomCode) {
    const joined = once(socket, 'room:joined');
    expect(await ack(socket, 'join-room', {roomCode})).toEqual({ok: true});
    await joined;
  }
  return socket;
}
/** Owner + Bob (editor) + Carol (viewer), all connected. */
async function classroom() {
  const owner = await client('owner');
  const bob = await client('bob');
  const carol = await client('carol');
  expect(
    await ack(owner, 'participant:setRole', {userId: CAROL, role: 'viewer'}),
  ).toEqual({ok: true});
  return {owner, bob, carol};
}
const stroke = (objectId: string) => ({
  id: objectId,
  type: 'stroke',
  style: {color: '#111111', strokeWidth: 4},
  points: [{x: 1, y: 1}],
});

// ---------- pure units ----------

describe('VoiceRegistry', () => {
  it('keeps one voice session per user, tracks forced mute, cleans up', () => {
    const registry = new VoiceRegistry();
    registry.join('r', {socketId: 's1', userId: 'u1', name: 'A'});
    const {evicted} = registry.join('r', {socketId: 's2', userId: 'u1', name: 'A'});
    expect(evicted).toBe('s1');
    registry.setForced('s2', true);
    expect(registry.get('s2')).toMatchObject({muted: true, forced: true});
    registry.setForced('s2', false);
    expect(registry.get('s2')).toMatchObject({muted: true, forced: false});
    expect(registry.leave('s2')).toBe('r');
    expect(registry.list('r')).toEqual([]);
  });
});

describe('computeAccess', () => {
  const session = (over: Partial<SessionDocument> = {}): SessionDocument => ({
    createdBy: new ObjectId(OWNER),
    roomCode: 'x',
    name: 'x',
    accessMode: 'anyone-with-link',
    defaultRole: 'editor',
    participants: [
      {userId: new ObjectId(BOB), role: 'editor', joinedAt: new Date()},
      {userId: new ObjectId(CAROL), role: 'viewer', joinedAt: new Date()},
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  it('gives the owner everything regardless of room settings', () => {
    const locked = session({
      boardLocked: true,
      voicePolicy: {enabled: false, joinMuted: true, speakByDefault: false},
    });
    expect(computeAccess(locked, OWNER)).toMatchObject({
      role: 'owner',
      canEdit: true,
      canJoinVoice: true,
      canSpeak: true,
      joinMuted: false,
    });
  });

  it('derives editor/viewer, board lock and voice policy + overrides', () => {
    expect(computeAccess(session(), BOB).canEdit).toBe(true);
    expect(computeAccess(session(), CAROL).canEdit).toBe(false);
    expect(computeAccess(session({boardLocked: true}), BOB).canEdit).toBe(false);
    const quiet = session({
      voicePolicy: {enabled: true, joinMuted: true, speakByDefault: false},
    });
    expect(computeAccess(quiet, BOB)).toMatchObject({canSpeak: false, joinMuted: true});
    quiet.participants[0].voice = {canSpeak: true, canJoin: false};
    expect(computeAccess(quiet, BOB)).toMatchObject({canSpeak: true, canJoinVoice: false});
  });
});

// ---------- authentication & whiteboard enforcement ----------

describe('room access', () => {
  it('rejects unauthenticated sockets', async () => {
    const socket = connect(url, {auth: {token: 'nope'}, transports: ['websocket'], forceNew: true, reconnection: false});
    clients.push(socket);
    const error = await once<Error>(socket, 'connect_error');
    expect(error.message).toBe('Unauthorized');
  });

  it('tells each member their own server-computed access; owner-only data goes to the owner only', async () => {
    const owner = await client('owner');
    const bob = await client('bob', null);
    const bobState = until<any>(bob, 'room:state', s => !!s.access);
    const ownerState = until<any>(owner, 'room:state', s => s.access.isOwner);
    await ack(bob, 'join-room', {roomCode: room});
    expect((await bobState).access).toMatchObject({role: 'editor', isOwner: false, canEdit: true});
    expect((await bobState).session.removed).toBeUndefined();
    expect((await ownerState).session.removed).toEqual([]);
  });

  it('lets editors draw and blocks viewers server-side, including live previews', async () => {
    const {owner, bob, carol} = await classroom();
    expect(await ack(bob, 'object:create', stroke('stroke-bob-1'))).toMatchObject({ok: true});

    const rejected = await ack<any>(carol, 'object:create', stroke('stroke-carol-1'));
    expect(rejected).toMatchObject({ok: false, error: 'You have view-only access'});
    expect(await ack(carol, 'object:update', {id: 'stroke-bob-1', patch: {style: {color: '#ff0000', strokeWidth: 2}}})).toMatchObject({ok: false});
    expect(await ack(carol, 'object:delete', {id: 'stroke-bob-1'})).toMatchObject({ok: false});

    // Ephemeral relays are gated too: a viewer's live stroke never reaches others.
    const noGhost = nothing(owner, 'stroke:live');
    carol.emit('stroke:live', stroke('ghost'));
    await noGhost;
    const live = once(owner, 'stroke:live');
    bob.emit('stroke:live', stroke('real'));
    expect(await live).toMatchObject({id: 'real', userId: BOB});
  });

  it('accepts simultaneous drawing from several editors (no activity-log races)', async () => {
    const owner = await client('owner');
    const bob = await client('bob');
    const results = await Promise.all(
      Array.from({length: 60}, (_, i) =>
        ack<any>(i % 2 ? bob : owner, 'object:create', stroke(`burst-object-${i}`)),
      ),
    );
    expect(results.filter(r => !r.ok)).toEqual([]);
    const activity = await service.activity(room, OWNER, 0, 500);
    expect(new Set(activity.map(a => a.seq)).size).toBe(activity.length);
  });

  it('continues the activity sequence for boards created before the seq counter', async () => {
    const owner = await client('owner');
    await ack(owner, 'object:create', stroke('legacy-seed-1'));
    await ack(owner, 'object:create', stroke('legacy-seed-2'));
    // Simulate a pre-counter board: drop the counter, keep its existing log.
    const sessions = await db.getCollection<SessionDocument>('whiteboard_sessions');
    await sessions.updateOne({roomCode: room}, {$unset: {activitySeq: ''}});
    const results = await Promise.all(
      Array.from({length: 10}, (_, i) =>
        ack<any>(owner, 'object:create', stroke(`legacy-next-${i}`)),
      ),
    );
    expect(results.filter(r => !r.ok)).toEqual([]);
    const seqs = (await service.activity(room, OWNER, 0, 500)).map(a => a.seq);
    expect(seqs).toEqual(Array.from({length: 12}, (_, i) => i + 1));
  });

  it('applies role changes live and persists them across a reconnect', async () => {
    const {owner, bob} = await classroom();
    const demoted = until<any>(bob, 'room:state', s => s.access.role === 'viewer');
    expect(await ack(owner, 'participant:setRole', {userId: BOB, role: 'viewer'})).toEqual({ok: true});
    expect((await demoted).access.canEdit).toBe(false);
    expect(await ack(bob, 'object:create', stroke('after-demote'))).toMatchObject({ok: false});

    bob.disconnect();
    const again = await client('bob');
    expect(await ack(again, 'object:create', stroke('after-reconnect'))).toMatchObject({ok: false});
  });

  it('locks the whiteboard for everyone but the owner and restores roles on unlock', async () => {
    const {owner, bob} = await classroom();
    const locked = until<any>(bob, 'room:state', s => s.session.boardLocked);
    expect(await ack(owner, 'room:setSettings', {boardLocked: true})).toEqual({ok: true});
    expect((await locked).access).toMatchObject({role: 'editor', canEdit: false});
    expect(await ack<any>(bob, 'object:create', stroke('locked'))).toMatchObject({
      ok: false,
      error: 'The whiteboard is locked by the room owner',
    });
    expect(await ack(owner, 'object:create', stroke('owner-while-locked'))).toMatchObject({ok: true});
    await ack(owner, 'room:setSettings', {boardLocked: false});
    expect(await ack(bob, 'object:create', stroke('unlocked'))).toMatchObject({ok: true});
  });
});

// ---------- moderation authorization ----------

describe('moderation authorization', () => {
  it('rejects every privileged event from non-owners, including self-promotion', async () => {
    const {bob, carol} = await classroom();
    const attempts: Array<[string, object]> = [
      ['participant:setRole', {userId: CAROL, role: 'editor'}], // viewer promoting themselves
      ['participant:setRole', {userId: OWNER, role: 'viewer'}],
      ['participant:setVoice', {userId: BOB, canSpeak: false}],
      ['participant:remove', {userId: BOB}],
      ['participant:readmit', {userId: BOB}],
      ['room:setSettings', {boardLocked: true}],
      ['room:setDefaultRole', {role: 'viewer'}],
      ['voice:muteAll', {}],
      ['voice:unmuteAll', {}],
    ];
    for (const [event, payload] of attempts) {
      expect(await ack<any>(carol, event, payload), event).toMatchObject({
        ok: false,
        error: 'Only the room owner can do that',
      });
    }
    // Client-claimed roles are ignored entirely.
    expect(await ack<any>(bob, 'participant:setRole', {userId: CAROL, role: 'editor', asRole: 'owner'})).toMatchObject({ok: false});
    expect(await ack<any>(carol, 'participant:setRole', {userId: CAROL, role: 'owner'})).toMatchObject({ok: false});
  });

  it('never lets the owner remove, demote or mute themselves', async () => {
    const {owner} = await classroom();
    for (const [event, payload] of [
      ['participant:remove', {userId: OWNER}],
      ['participant:setRole', {userId: OWNER, role: 'viewer'}],
      ['participant:setVoice', {userId: OWNER, canJoin: false}],
    ] as const) {
      expect(await ack<any>(owner, event, payload), event).toMatchObject({
        ok: false,
        error: 'The room owner cannot be changed',
      });
    }
  });

  it('does not let a room owner moderate a different room', async () => {
    const other = (await service.create(BOB, 'Bob room')).roomCode;
    const bob = await client('bob', other);
    await client('carol', other);
    const owner = await client('owner', other); // owner of `room`, guest here
    expect(await ack<any>(owner, 'participant:setRole', {userId: CAROL, role: 'viewer'})).toMatchObject({ok: false});
    expect(await ack(bob, 'participant:setRole', {userId: CAROL, role: 'viewer'})).toEqual({ok: true});
  });
});

// ---------- removal ----------

describe('removing a participant', () => {
  it('evicts them immediately, cleans up voice, and blocks rejoining until re-admitted', async () => {
    const {owner, bob} = await classroom();
    await ack(bob, 'voice:join');
    await ack(owner, 'voice:join');

    const removedMsg = once<any>(bob, 'room:removed');
    const voiceGone = voiceList(owner, l => !byUser(l, BOB));
    expect(await ack(owner, 'participant:remove', {userId: BOB})).toEqual({ok: true});
    expect((await removedMsg).message).toBe(
      'You were removed from this collaboration room by the room owner.',
    );
    await voiceGone;

    // No further room events reach the removed socket.
    const silent = nothing(bob, 'cursor:move');
    owner.emit('cursor:move', {x: 1, y: 1});
    await silent;

    expect(await ack<any>(bob, 'join-room', {roomCode: room})).toEqual({
      ok: false,
      error: 'You were removed from this collaboration room by the room owner.',
    });
    expect(await ack<any>(bob, 'voice:join')).toMatchObject({ok: false});

    expect(await ack(owner, 'participant:readmit', {userId: BOB})).toEqual({ok: true});
    expect(await ack(bob, 'join-room', {roomCode: room})).toEqual({ok: true});
  });
});

// ---------- voice moderation ----------

describe('voice moderation', () => {
  it('blocks voice for a participant and revokes it live without leaving the board', async () => {
    const {owner, bob} = await classroom();
    await ack(bob, 'voice:join');

    const revoked = once<any>(bob, 'voice:revoked');
    const gone = voiceList(owner, l => !byUser(l, BOB));
    expect(await ack(owner, 'participant:setVoice', {userId: BOB, canJoin: false})).toEqual({ok: true});
    expect((await revoked).message).toBe('The room owner turned off voice for you.');
    await gone;
    expect(await ack<any>(bob, 'voice:join')).toMatchObject({
      ok: false,
      error: 'The room owner has not allowed you to use voice.',
    });
    // Still in the whiteboard room.
    const cursor = once(bob, 'cursor:move');
    owner.emit('cursor:move', {x: 3, y: 4});
    await cursor;

    await ack(owner, 'participant:setVoice', {userId: BOB, canJoin: null});
    expect(await ack<any>(bob, 'voice:join')).toMatchObject({ok: true});
  });

  it('force-mutes a participant who cannot override it until the owner allows them', async () => {
    const {owner, bob} = await classroom();
    await ack(bob, 'voice:join');
    bob.emit('voice:state', {muted: false});

    const forced = voiceList(owner, l => byUser(l, BOB)?.forced === true);
    await ack(owner, 'participant:setVoice', {userId: BOB, canSpeak: false});
    expect(byUser(await forced, BOB)).toMatchObject({muted: true, forced: true});

    // Self-unmute is refused and the authoritative state is re-sent.
    const corrected = voiceList(bob, l => byUser(l, BOB)?.muted === true);
    bob.emit('voice:state', {muted: false});
    await corrected;
    expect(voice.registry.list(room).find(p => p.userId === BOB)?.muted).toBe(true);

    const released = voiceList(owner, l => byUser(l, BOB)?.forced === false);
    await ack(owner, 'participant:setVoice', {userId: BOB, canSpeak: true});
    await released;
    const unmuted = voiceList(owner, l => byUser(l, BOB)?.muted === false);
    bob.emit('voice:state', {muted: false});
    await unmuted;
  });

  it('keeps a forced mute across a reconnect (it is persisted)', async () => {
    const {owner, bob} = await classroom();
    await ack(owner, 'participant:setVoice', {userId: BOB, canSpeak: false});
    bob.disconnect();
    const again = await client('bob');
    expect(await ack<any>(again, 'voice:join')).toMatchObject({ok: true, muted: true, forced: true});
  });

  it('mutes everyone now (not the owner), then lets one student speak, then unmutes everyone', async () => {
    const {owner, bob, carol} = await classroom();
    await ack(owner, 'voice:join');
    await ack(bob, 'voice:join');
    await ack(carol, 'voice:join');

    const allMuted = voiceList(owner, l =>
      [BOB, CAROL].every(u => byUser(l, u)?.forced),
    );
    expect(await ack(owner, 'voice:muteAll')).toEqual({ok: true});
    const list = await allMuted;
    expect(byUser(list, OWNER)).toMatchObject({forced: false});

    const bobMayTalk = voiceList(owner, l => byUser(l, BOB)?.forced === false);
    await ack(owner, 'participant:setVoice', {userId: BOB, canSpeak: true});
    expect(byUser(await bobMayTalk, CAROL).forced).toBe(true);

    const everyone = voiceList(owner, l => l.every(p => !p.forced));
    expect(await ack(owner, 'voice:unmuteAll')).toEqual({ok: true});
    await everyone;
  });

  it('lets participants unmute themselves again after "Unmute everyone" (regression)', async () => {
    const {owner, bob, carol} = await classroom();
    await ack(bob, 'voice:join');
    await ack(carol, 'voice:join');
    // Carol is explicitly allowed to speak in a speak-when-allowed room.
    await ack(owner, 'room:setSettings', {voicePolicy: {speakByDefault: false}});
    await ack(owner, 'participant:setVoice', {userId: CAROL, canSpeak: true});
    await ack(owner, 'room:setSettings', {voicePolicy: {speakByDefault: true}});

    await ack(owner, 'voice:muteAll');
    // Turning a room policy on/off does not lift a mute-all (mutes are per participant)…
    await ack(owner, 'room:setSettings', {voicePolicy: {speakByDefault: false}});
    await ack(owner, 'room:setSettings', {voicePolicy: {speakByDefault: true}});
    expect(byUser(voice.registry.list(room), BOB).forced).toBe(true);

    // …"Unmute everyone" does, and the participant can then unmute themselves.
    const lifted = voiceList(bob, l => byUser(l, BOB)?.forced === false);
    expect(await ack(owner, 'voice:unmuteAll')).toEqual({ok: true});
    await lifted;
    const unmuted = voiceList(owner, l => byUser(l, BOB)?.muted === false);
    bob.emit('voice:state', {muted: false});
    await unmuted;

    // Mute-all overwrote Carol's explicit allow, so she is simply back to the room default now.
    const session = await service.roomState(room);
    expect(session!.participants.every(p => p.voice?.canSpeak !== false)).toBe(true);
  });

  it('"Unmute everyone" keeps explicit allows when the room is speak-when-allowed', async () => {
    const {owner, bob} = await classroom();
    await ack(owner, 'room:setSettings', {voicePolicy: {speakByDefault: false}});
    await ack(owner, 'participant:setVoice', {userId: BOB, canSpeak: true});
    await ack(owner, 'participant:setVoice', {userId: CAROL, canSpeak: false});
    await ack(owner, 'voice:unmuteAll');
    const session = await service.roomState(room);
    expect(session!.participants.find(p => p.userId.toString() === BOB)?.voice?.canSpeak).toBe(true);
    expect(session!.participants.find(p => p.userId.toString() === CAROL)?.voice?.canSpeak).toBeUndefined();
  });

  it('applies the join policy to new voice participants', async () => {
    const {owner, bob, carol} = await classroom();
    await ack(owner, 'room:setSettings', {voicePolicy: {joinMuted: true}});
    expect(await ack<any>(bob, 'voice:join')).toMatchObject({ok: true, muted: true, forced: false});

    await ack(owner, 'room:setSettings', {voicePolicy: {joinMuted: false, speakByDefault: false}});
    expect(await ack<any>(carol, 'voice:join')).toMatchObject({ok: true, muted: true, forced: true});
    expect(await ack<any>(owner, 'voice:join')).toMatchObject({ok: true, muted: false, forced: false});

    // Turning voice off for the room evicts non-owners but never the owner.
    const onlyOwner = voiceList(owner, l => l.length === 1 && !!byUser(l, OWNER));
    await ack(owner, 'room:setSettings', {voicePolicy: {enabled: false}});
    await onlyOwner;
    expect(await ack<any>(bob, 'room:setSettings', {voicePolicy: {enabled: true}})).toMatchObject({ok: false});
  });
});

// ---------- signaling ----------

describe('voice signaling', () => {
  it('rejects voice before the socket is authorized for a room', async () => {
    const a = await client('bob', null);
    expect(await ack(a, 'voice:join')).toMatchObject({ok: false});
  });

  it('relays offer/answer/ICE only between voice members of the same room', async () => {
    const {owner, bob, carol} = await classroom();
    const other = (await service.create(DAVE, 'Elsewhere')).roomCode;
    const dave = await client('dave', other);
    await ack(owner, 'voice:join');
    await ack(bob, 'voice:join');
    await ack(dave, 'voice:join');

    const offer = once(owner, 'voice:offer');
    bob.emit('voice:offer', {to: owner.id, sdp: {type: 'offer', sdp: 'v=0'}});
    expect(await offer).toEqual({from: bob.id, sdp: {type: 'offer', sdp: 'v=0'}});
    const answer = once(bob, 'voice:answer');
    owner.emit('voice:answer', {to: bob.id, sdp: {type: 'answer', sdp: 'v=0'}});
    expect(await answer).toEqual({from: owner.id, sdp: {type: 'answer', sdp: 'v=0'}});
    const ice = once(owner, 'voice:ice-candidate');
    bob.emit('voice:ice-candidate', {to: owner.id, candidate: {candidate: 'c'}});
    expect(await ice).toEqual({from: bob.id, candidate: {candidate: 'c'}});

    const crossRoom = nothing(dave, 'voice:offer');
    bob.emit('voice:offer', {to: dave.id, sdp: {type: 'offer', sdp: 'v=0'}});
    await crossRoom;
    const notInVoice = nothing(carol, 'voice:offer');
    bob.emit('voice:offer', {to: carol.id, sdp: {type: 'offer', sdp: 'v=0'}});
    await notInVoice;
    const malformed = nothing(owner, 'voice:offer');
    bob.emit('voice:offer', {to: owner.id, sdp: {type: 'bogus', sdp: 1}});
    await malformed;
  });

  it('tells a late arrival who is already in voice, and cleans up on leave/disconnect', async () => {
    const owner = await client('owner');
    await ack(owner, 'voice:join');
    const bob = await client('bob');
    const list = voiceList(bob, l => !!byUser(l, OWNER));
    bob.emit('voice:sync');
    await list;

    await ack(bob, 'voice:join');
    const afterDisconnect = voiceList(owner, l => !byUser(l, BOB));
    bob.disconnect();
    await afterDisconnect;
    owner.emit('leave-room');
    await new Promise(r => setTimeout(r, 100));
    expect(voice.registry.list(room)).toEqual([]);
  });

  it('replaces an older voice session of the same user', async () => {
    const first = await client('bob');
    const second = await client('bob');
    await ack(first, 'voice:join');
    const replaced = once(first, 'voice:replaced');
    await ack(second, 'voice:join');
    await replaced;
    expect(voice.registry.list(room).map(p => p.socketId)).toEqual([second.id]);
  });
});
