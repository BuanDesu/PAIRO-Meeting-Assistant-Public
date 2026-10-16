// This visible fixture owns its generated form; it never queries or types into other windows.
const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createTextAutomation } = require('../electron/text-automation.cjs');
app.setPath('userData', path.resolve(__dirname, '../release/text-workflow-qa/browser-profile'));
app.disableHardwareAcceleration();
let window, automation;
const deadline = setTimeout(() => { automation?.dispose(); app.exit(1); }, 25000);
const wait = async predicate => {
  const until = Date.now() + 1500;
  while (!await predicate()) { if (Date.now() > until) throw new Error('Generated browser field did not receive text'); await new Promise(resolve => setTimeout(resolve, 30)); }
};
app.whenReady().then(async () => {
  automation = createTextAutomation({ globalShortcut }); await automation.initialize();
  window = new BrowserWindow({ width: 650, height: 360, title: 'PAIRO generated questionnaire input validation', show: false, webPreferences: { backgroundThrottling: false } });
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><title>PAIRO generated questionnaire input validation</title><h2>PAIRO · Generated input test</h2><p>This window closes automatically. No phone or real AI is used.</p><form><textarea id="answer" rows="5" cols="55">generated selected question</textarea><input id="other" placeholder="focus-change test"><button>Submit</button></form><script>window.submissions=0;document.querySelector("form").onsubmit=e=>{e.preventDefault();submissions++};</script>'));
  window.show(); window.focus();
  const evaluate = source => window.webContents.executeJavaScript(source);
  await evaluate('document.getElementById("answer").focus();document.getElementById("answer").select();');
  await new Promise(resolve => setTimeout(resolve, 300));
  if (!window.isFocused()) throw new Error('The generated browser fixture did not acquire foreground; input test stopped');
  const selection = await automation.copySelection();
  if (selection !== 'generated selected question') throw new Error('Browser selection did not match generated text');
  await evaluate('document.getElementById("answer").value="";document.getElementById("answer").focus();');
  let token = await automation.prepare();
  await automation.type({ token, text: '中文 abc' }, { chineseCpm: 600, englishWpm: 300 });
  await wait(() => evaluate('document.getElementById("answer").value==="中文 abc"'));
  token = await automation.prepare();
  const typing = automation.type({ token, text: 'cancelled generated text' });
  const rejected = typing.then(() => { throw new Error('Canceled typing completed unexpectedly'); }, () => true);
  setTimeout(() => automation.cancel(), 60);
  await rejected; await new Promise(resolve => setTimeout(resolve, 120));
  if (await evaluate('document.getElementById("answer").value!=="中文 abc"')) throw new Error('Canceled browser input wrote late text');
  // A normal cancel keeps the Shift+numpad worker available for the next operation.
  token = await automation.prepare(); await automation.type({ token, text: 'OK' }, { chineseCpm: 600, englishWpm: 300 });
  await wait(() => evaluate('document.getElementById("answer").value==="中文 abcOK"'));
  token = await automation.prepare();
  await evaluate('document.getElementById("other").focus();');
  let stopped = false;
  try { await automation.type({ token, text: 'must not appear' }); } catch { stopped = true; }
  if (!stopped || await evaluate('document.getElementById("other").value!==""||submissions!==0')) throw new Error('Browser target focus/submit protection failed');
  const result = { browserSelection: true, browserUnicodeTyping: true, cancellationNoLateCharacters: true, reuseAfterCancel: true, browserFocusChangeStops: true, noAutomaticSubmission: true };
  await fs.mkdir(path.resolve(__dirname, '../release/text-workflow-qa'), { recursive: true });
  await fs.writeFile(path.resolve(__dirname, '../release/text-workflow-qa/browser-input.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result)); automation.dispose(); window.destroy(); clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error.message); automation?.dispose(); window?.destroy(); clearTimeout(deadline); app.exit(1); });
