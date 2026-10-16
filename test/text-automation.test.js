import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
const { DEFAULT_TYPING, validateTyping, createTextAutomation } = createRequire(import.meta.url)('../electron/text-automation.cjs');

function fixture() {
  const keys = new Map(), commands = [], statuses = [], workers = [], shortcuts = [];
  let finishTyping;
  const automation = createTextAutomation({ platform: 'win32',
    globalShortcut: { register(key, callback) { if (keys.has(key)) return false; keys.set(key, callback); return true; }, unregister(key) { keys.delete(key); } },
    onStatus: value => statuses.push(value),
    onShortcut: action => shortcuts.push(action),
    spawnImpl(exe, args, options) {
      assert.equal(options.windowsHide, true); assert.equal(options.shell, undefined);
      assert.ok(!args.some(value => value.includes('private answer')));
      const worker = new EventEmitter(); workers.push(worker);
      worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
      worker.kill = () => { worker.killed = true; worker.emit('exit', 0); };
      worker.stdin = new Writable({ write(chunk, _encoding, callback) {
        const command = JSON.parse(chunk);
        if (command.action === 'bindings' || command.action === 'cancel') { callback(); return; }
        commands.push(command);
        const finish = value => worker.stdout.write(JSON.stringify({ id: command.id, ...value }) + '\n');
        if (command.action === 'arm') finish({ token: 'a'.repeat(32) });
        else if (command.action === 'copy') finish({ text: 'selected question' });
        else if (command.action === 'type') finishTyping = () => finish({ count: 14 });
        callback();
      } });
      queueMicrotask(() => worker.stdout.write('{"ready":true}\n'));
      return worker;
    },
  });
  return { automation, keys, commands, statuses, workers, shortcuts, finish: () => finishTyping() };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('typing rates have explicit defaults, integer bounds, and reject malformed values', () => {
  assert.deepEqual(DEFAULT_TYPING, { chineseCpm: 60, englishWpm: 90 });
  assert.deepEqual(validateTyping({ chineseCpm: 100, englishWpm: 120, apiKey: 'not persisted' }), { chineseCpm: 100, englishWpm: 120 });
  for (const chineseCpm of [0, 601, 60.5, '60', Infinity]) assert.throws(() => validateTyping({ chineseCpm, englishWpm: 90 }));
  for (const englishWpm of [0, 301, 90.5, '90', NaN]) assert.throws(() => validateTyping({ chineseCpm: 60, englishWpm }));
});

test('native numpad events are accepted only for the currently enabled background bindings', async () => {
  const fx = fixture(); await fx.automation.initialize();
  fx.automation.setBindings({ enabled: true, active: true, bindings: { 'type-answer': 'Shift+num3', screenshot: 'num1' } });
  fx.workers[0].stdout.write('{"shortcut":"type-answer"}\n');
  fx.workers[0].stdout.write('{"shortcut":"screenshot"}\n');
  assert.deepEqual(fx.shortcuts, ['type-answer']);
  fx.automation.setBindings({ enabled: false });
  fx.workers[0].stdout.write('{"shortcut":"type-answer"}\n');
  assert.deepEqual(fx.shortcuts, ['type-answer']); fx.automation.dispose();
});

test('copy is explicit; answer input requires arming, uses stdin, releases temporary Escape after completion', async () => {
  const fx = fixture();
  await fx.automation.initialize(); assert.equal(fx.commands.length, 0);
  assert.equal(await fx.automation.copySelection(), 'selected question');
  await assert.rejects(fx.automation.type({ token: 'a'.repeat(32), text: 'private answer' }), /快捷键/);
  const token = await fx.automation.prepare(); assert.equal(fx.keys.size, 1);
  const typing = fx.automation.type({ token, text: 'private answer' }); await tick();
  assert.equal(fx.commands.at(-1).chineseCpm, 60); assert.equal(fx.commands.at(-1).englishWpm, 90);
  assert.ok(!JSON.stringify(fx.statuses).includes('private answer'));
  fx.finish(); await typing; assert.equal(fx.keys.size, 0); assert.equal(fx.automation.active, false);
  fx.automation.dispose();
});

test('Escape cancels input without removing native hotkeys; late native results cannot resume it', async () => {
  const fx = fixture(); const token = await fx.automation.prepare();
  const typing = fx.automation.type({ token, text: 'private answer' }); await tick();
  const rejected = assert.rejects(typing, /停止/);
  fx.keys.get('Escape')(); fx.finish(); await rejected;
  assert.notEqual(fx.workers[0].killed, true); assert.equal(fx.keys.size, 0); assert.equal(fx.automation.active, false);
  assert.equal(await fx.automation.copySelection(), 'selected question'); assert.equal(fx.workers.length, 1);
  fx.automation.dispose();
});

test('Escape conflict prevents arming and oversized or invalid answers never reach native typing', async () => {
  const fx = fixture(); fx.keys.set('Escape', () => {});
  await assert.rejects(fx.automation.prepare(), /占用/); assert.equal(fx.commands.length, 0);
  fx.keys.delete('Escape'); const token = await fx.automation.prepare();
  await assert.rejects(fx.automation.type({ token, text: 'x'.repeat(24001) }), /过长/);
  assert.ok(!fx.commands.some(value => value.action === 'type')); assert.equal(fx.keys.size, 0);
  fx.automation.dispose();
});
