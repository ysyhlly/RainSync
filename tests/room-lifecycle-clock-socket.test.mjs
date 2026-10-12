import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Execute the actual fixture function, with no network or database.
const source = readFileSync(new URL('./room-lifecycle-authority-native.mjs', import.meta.url), 'utf8');
const start = source.indexOf('  async function clockSocket(');
const end = source.indexOf('  async function holder(', start);
assert.ok(start >= 0 && end > start);
const make = new Function('WebSocket', 'f', 'signal', 'bounded', 'cleanupBound', 'randomUUID', 'assert', 'privateFile', `${source.slice(start, end)};return clockSocket;`);

function fixture({ malformedSetup = false, malformedDuringClose = false, cleanupFailure = null } = {}) {
  let socket;
  class MockSocket extends EventEmitter {
    constructor() { super(); socket = this; this.closeCalls = 0; queueMicrotask(() => this.emit('open')); }
    send(raw) {
      const value = JSON.parse(raw);
      if (value.type === 'JOIN') this.emit('message', malformedSetup ? '{' : JSON.stringify({ type: 'SNAPSHOT', state: { clock_epoch: 7 } }));
      if (value.type === 'CLOCK_SYNC') this.emit('message', JSON.stringify({ type: 'CLOCK_SYNC_REPLY', t1: value.t1, t3: 100, clock_epoch: 7 }));
    }
    close(code) {
      this.closeCalls++;
      const finish = () => { if (malformedDuringClose) this.emit('message', '{'); this.emit('close', code, Buffer.from('owned close')); };
      if (malformedDuringClose) queueMicrotask(finish); else finish();
    }
  }
  const clockSocket = make(MockSocket, { origin: 'http://fixture.invalid' }, new AbortController().signal,
    promise => promise,
    async promise => { const value = await promise; if (cleanupFailure) throw cleanupFailure; return value; },
    () => 'fixed-synthetic-id', assert, async () => ({ private: true }));
  return { open: () => clockSocket({ room: { id: 'room' }, owner: { live: { cookie: 'synthetic' } } }, 'test'), socket: () => socket };
}

test('valid clock samples retain their epoch and positively observed close', async () => {
  const f = fixture(); const clock = await f.open();
  assert.equal((await clock.sample('sample')).reply.clock_epoch, 7);
  assert.equal((await clock.close()).close_observed, true);
  assert.equal(f.socket().closeCalls, 1);
});

test('malformed setup frame rejects through async cleanup rather than escaping the listener', async () => {
  const f = fixture({ malformedSetup: true });
  await assert.rejects(f.open(), error => error instanceof AggregateError && error.errors.every(x => x instanceof SyntaxError));
  assert.equal(f.socket().closeCalls, 1);
});

test('malformed frame cannot throw synchronously from an event callback or hide behind a queued valid frame', async () => {
  const f = fixture(); const clock = await f.open();
  assert.doesNotThrow(() => f.socket().emit('message', '{'));
  await assert.rejects(clock.sample('after-malformed'), SyntaxError);
  await assert.rejects(clock.close(), SyntaxError);
  assert.equal(f.socket().closeCalls, 1);
});

test('malformed final frame fails close even when no later sample is requested', async () => {
  const f = fixture(); const clock = await f.open(); await clock.sample('last');
  f.socket().emit('message', '{');
  await assert.rejects(clock.close(), SyntaxError);
  assert.equal(f.socket().closeCalls, 1);
});

test('first transport error is preserved and close is still positively observed', async () => {
  const f = fixture(); const clock = await f.open(); const first = Error('transport');
  f.socket().emit('error', first); f.socket().emit('message', '{');
  await assert.rejects(clock.close(), error => error === first);
  assert.equal(f.socket().closeCalls, 1);
});

test('transport and cleanup failures are both retained', async () => {
  const cleanup = Error('cleanup'); const f = fixture({ cleanupFailure: cleanup }); const clock = await f.open(); const first = Error('transport');
  f.socket().emit('error', first);
  await assert.rejects(clock.close(), error => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === cleanup);
  assert.equal(f.socket().closeCalls, 1);
});

test('malformed frame arriving during close wait fails after positive close observation', async () => {
  const f = fixture({ malformedDuringClose: true }); const clock = await f.open();
  await assert.rejects(clock.close(), SyntaxError);
  assert.equal(f.socket().closeCalls, 1);
});
