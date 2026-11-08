import test from 'node:test';
import assert from 'node:assert/strict';
import { PrompterPublisher, PrompterReceiver, validSnapshot } from '../src/prompter-sync.js';
const snap = (text = '', status = 'generating') => ({ session: 'session-123', entries: [{ id: 'request-123', question: 'q', text, status, error: '', sources: [] }] });
test('reader rejects duplicates, reordered, oversized and old connection/session messages; reconnect restores partial status', () => {
  const renders = [], r = new PrompterReceiver({ render: m => renders.push(m) });
  const nonce = r.connect().nonce;
  const m = { type: 'prompter-state', nonce, revision: 2, ...snap('partial') };
  assert.equal(r.receive(m), true); assert.equal(r.receive(m), false);
  assert.equal(r.receive({ ...m, revision: 1, entries: [] }), false);
  assert.equal(r.receive({ ...m, revision: 3, ...snap('x'.repeat(24001)) }), false);
  assert.equal(r.receive({ ...m, revision: 3, session: 'session-new', entries: [] }), true);
  assert.equal(r.receive(m), false);
  r.disconnect(); assert.equal(r.receive({ ...m, revision: 99 }), false);
  const next = r.connect().nonce; assert.notEqual(next, nonce);
  assert.equal(r.receive({ ...m, revision: 999 }), false);
  assert.equal(r.receive({ ...m, nonce: next, revision: 4 }), true);
  assert.equal(renders.at(-1).entries[0].status, 'generating');
  assert.equal(validSnapshot({ ...snap(), entries: Array(9).fill(snap().entries[0]) }), false);
});
test('slow transport coalesces updates with only one in-flight bounded send', async () => {
  const messages = []; let release, state = snap();
  const p = new PrompterPublisher({ send: m => { messages.push(m); return new Promise(r => release = r); }, snapshot: () => state, delay: 1 });
  p.ready({ type: 'prompter-ready', nonce: 'connection-123' });
  await new Promise(r => setTimeout(r, 5));
  for (let i = 0; i < 100; i++) { state = snap(String(i)); p.changed(); }
  assert.equal(messages.length, 1); release(); await new Promise(r => setTimeout(r, 8));
  assert.equal(messages.length, 2); assert.equal(messages[1].entries[0].text, '99');
  assert.ok(messages[1].revision > messages[0].revision); release(); p.disconnected();
});
