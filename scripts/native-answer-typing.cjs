const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
const path = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function checkAnswerTyping({ evaluate, ask, wait, nativeShortcuts }) {
  const fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'answer-typing-fixture.ps1')],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const reader = createInterface({ input: fixture.stdout });
  let exited = false;
  const gone = new Promise(resolve => { fixture.once('error', resolve); fixture.once('exit', resolve); });
  void gone.then(() => { exited = true; reader.close(); });
  async function response(send) {
    if (exited) throw new Error('Foreground fixture closed');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    try {
      const event = once(reader, 'line', { signal: controller.signal });
      if (send) fixture.stdin.write(send + '\n');
      const [line] = await Promise.race([event, gone.then(() => { throw new Error('Foreground fixture closed'); })]);
      const value = JSON.parse(line);
      if (value.error) throw new Error(value.error);
      return value;
    } finally { clearTimeout(timer); controller.abort(); }
  }
  fixture.stdin.on('error', () => {});
  const actions = () => nativeShortcuts.filter(a => a === 'type-answer').length;
  const activity = () => evaluate(`document.getElementById('desktop-activity').textContent`);
  const state = () => response('state');
  const until = (fn, label) => wait(fn, 'typing fixture: ' + label);
  const reset = async () => {
    const resetState = await response('reset');
    assert.ok(resetState.foreground && resetState.focus === 'primary', 'expected foreground editable fixture control');
    return resetState;
  };
  try {
    assert.equal((await response()).ready, true);
    await until(async () => (await state()).foreground, 'foreground');
    const { numLock } = await reset();
    await evaluate(`desktopBridge.saveTypingSettings({chineseCpm:600,englishWpm:300})`);
    await ask('fixture-type-older');
    await ask('fixture-type-short');
    const before = actions();
    await response('page-down');
    await until(async () => (await state()).pageDown === 1, 'extended Page Down reached fixture');
    assert.equal(actions(), before, 'extended Page Down must not trigger typing');
    await reset();
    await response('scan');
    await until(async () => (await state()).text === '最新完整回答 safe answer 42', 'latest complete answer via scan chord');
    await until(async () => (await activity()).includes('回答已键入'), 'completion feedback');
    const typed = await state();
    assert.equal(typed.enter, 0); assert.equal(actions(), before + 1, 'one native dispatch');

    await reset();
    for (const target of ['password', 'readonly']) {
      const focused = await response(target);
      assert.equal(focused.focus, target === 'password' ? 'password' : 'primary');
      await evaluate(`document.getElementById('desktop-activity').textContent=''`);
      await delay(150); // Let the cross-process UI Automation focus settle.
      await response('scan');
      await until(async () => (await activity()).includes('密码、只读'), target + ' rejection');
      const result = await state(); assert.equal(result.text, ''); assert.equal(result.passwordLength, 0);
      await reset();
    }
    await ask('fixture-type-long');
    for (const stop of ['esc', 'scan', 'other']) {
      await reset();
      await response('scan');
      await until(async () => (await state()).text.length > 0 && (await activity()).includes('正在键入'), 'typing active before ' + stop);
      await response(stop);
      await until(async () => /停止/.test(await activity()), 'stopped by ' + stop);
      const stopped = await state(); await delay(350);
      const after = await state();
      assert.equal(after.text, stopped.text); assert.ok(after.text.length < 150);
      assert.equal(after.other, ''); assert.equal(after.enter, 0);
    }
    // VK-only injection can be translated to a different shortcut by Windows. Probe
    // separately, after all assertions, so it cannot replace the answer under test.
    await ask('fixture-type-short');
    await reset();
    const virtualBefore = actions();
    await response('virtual');
    await delay(1800);
    const virtual = { hookEvents: actions() - virtualBefore, typedLatestAnswer: (await state()).text === typed.text };
    return { scanCodeShiftNum3: true, exactLatestCompleteText: true, nativeHookDispatchOnce: true, noSubmission: true,
      extendedPageDownUnaffected: true, escStops: true, sameChordStops: true, focusChangeStops: true, passwordAndReadOnlyRejected: true,
      numLock, virtualKeyProbe: virtual, physicalKeyboardTested: false };
  } catch (error) {
    const current = await state().catch(() => null);
    console.error('Foreground fixture diagnostics:', current && { foreground: current.foreground, focus: current.focus, numLock: current.numLock,
      typedLength: current.text.length, otherLength: current.other.length, enter: current.enter, pageDown: current.pageDown });
    throw error;
  } finally {
    if (!exited) fixture.stdin.end('quit\n');
    const timer = setTimeout(() => { if (!exited) fixture.kill(); }, 1500);
    await gone; clearTimeout(timer);
  }
}
module.exports = { checkAnswerTyping };
