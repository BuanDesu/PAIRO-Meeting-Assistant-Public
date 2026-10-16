import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DEFAULT_SHORTCUTS, validateShortcuts, shortcutForEvent } from '../src/shortcuts.js';
const { createShortcutManager } = createRequire(import.meta.url)('../electron/shortcuts.cjs');

test('numpad shortcuts do not match the digit row, modifiers and duplicates are validated', () => {
  assert.equal(shortcutForEvent({ code: 'Numpad1', key: '1' }, DEFAULT_SHORTCUTS), 'screenshot');
  assert.equal(shortcutForEvent({ code: 'Digit1', key: '1' }, DEFAULT_SHORTCUTS), null);
  assert.equal(shortcutForEvent({ code: 'ArrowUp', key: 'ArrowUp' }, DEFAULT_SHORTCUTS), 'scroll-up');
  assert.equal(shortcutForEvent({ code: 'Numpad3', key: '3', shiftKey: true }, DEFAULT_SHORTCUTS), 'type-answer');
  assert.equal(shortcutForEvent({ code: 'Digit3', key: '#', shiftKey: true }, DEFAULT_SHORTCUTS), null);
  const old = { ...DEFAULT_SHORTCUTS }; delete old['type-answer'];
  assert.deepEqual(validateShortcuts(old), DEFAULT_SHORTCUTS);
  assert.throws(() => validateShortcuts({ ...DEFAULT_SHORTCUTS, voice: 'NUM1' }), /相同/);
  assert.throws(() => validateShortcuts({ ...DEFAULT_SHORTCUTS, text: 'Control+Ctrl+T' }), /重复/);
  assert.throws(() => validateShortcuts({ ...DEFAULT_SHORTCUTS, voice: 'constructor' }), /不支持/);
});

test('disabled and idle shortcuts release keys; a conflicting update rolls back atomically', () => {
  const keys = new Map(), blocked = new Set(), invoked = [];
  const manager = createShortcutManager({ defaults: DEFAULT_SHORTCUTS, validate: validateShortcuts, dispatch: action => invoked.push(action), globalShortcut: {
    register(key, callback) { if (blocked.has(key) || keys.has(key)) return false; keys.set(key, callback); return true; },
    unregister(key) { keys.delete(key); },
  } });
  manager.update({ enabled: true, active: false }); assert.equal(keys.size, 0);
  manager.update({ active: true }); assert.equal(keys.size, 6);
  keys.get('num3')(); assert.deepEqual(invoked, ['text']);
  blocked.add('F8');
  assert.throws(() => manager.update({ bindings: { ...DEFAULT_SHORTCUTS, voice: 'F8' } }), /占用/);
  assert.equal(keys.size, 6); assert.ok(keys.has('num2'));
  assert.deepEqual(manager.snapshot().bindings, DEFAULT_SHORTCUTS);
  manager.update({ active: false }); assert.equal(keys.size, 0);
});
