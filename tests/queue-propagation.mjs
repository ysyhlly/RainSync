// Ordinary two-member queue edits invalidate each viewer's filtered REST read.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { isolatedServer, delay } from './fixtures/server.mjs';
import { sourceMedia } from './fixtures/source-grant.mjs';

await isolatedServer('queue-propagation', async f => {
  const owner = f.client();
  await owner.login();
  await owner.request('/users', 'POST', { username: 'queue-viewer', password: f.password });
  const viewer = f.client();
  await viewer.login('queue-viewer', f.password);
  const room = await owner.request('/rooms', 'POST', { name: 'Queue propagation fixture' });
  const invite = await owner.request(`/rooms/${room.id}/invites`, 'POST');
  await viewer.request(`/rooms/${room.id}/join`, 'POST', { token: invite.token });
  const media = sourceMedia(f, { kind: 'local', root: f.root, resource: 'queue-fixture.mp4' });
  const sockets = [];
  async function connect(client) {
    const socket = new WebSocket(f.origin.replace('http', 'ws') + '/api/v1/ws', {
      headers: { Origin: f.origin, Cookie: client.cookie },
    });
    sockets.push(socket);
    const messages = [];
    socket.on('message', bytes => messages.push(JSON.parse(bytes)));
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const next = async type => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const index = messages.findIndex(value => value.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(10);
      }
      throw Error(`Missing ${type}`);
    };
    socket.send(JSON.stringify({ type: 'RESUME', room_id: room.id, revision: 0 }));
    return { socket, next, snapshot: await next('SNAPSHOT') };
  }
  try {
    const a = await connect(owner), b = await connect(viewer);
    assert.deepEqual(await viewer.request(`/rooms/${room.id}/playlist`), []);
    const added = await owner.request(`/rooms/${room.id}/playlist`, 'POST', { media_id: media });
    for (const peer of [a, b])
      assert.deepEqual(await peer.next('PLAYLIST_CHANGED'), { type: 'PLAYLIST_CHANGED' },
        'Notification contains no media IDs, titles, user aliases, or unfiltered rows');
    const visible = await viewer.request(`/rooms/${room.id}/playlist`);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, added.id);
    assert.equal(visible[0].media_id, media);
    await owner.request(`/rooms/${room.id}/playlist/${added.id}`, 'DELETE');
    for (const peer of [a, b])
      assert.deepEqual(await peer.next('PLAYLIST_CHANGED'), { type: 'PLAYLIST_CHANGED' });
    assert.deepEqual(await viewer.request(`/rooms/${room.id}/playlist`), []);
    const resumed = await connect(viewer);
    assert.deepEqual(resumed.snapshot.state, b.snapshot.state,
      'Queue edits leave media generation, playback state and control revision unchanged');
    console.log('PASS: add/remove invalidations reach both members with metadata-free payloads');
  } finally {
    for (const socket of sockets) socket.terminate();
  }
});
