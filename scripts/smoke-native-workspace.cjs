// Runs the production Electron main/preload with isolated data and hidden windows.
const { app, BrowserWindow, globalShortcut } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const root = path.resolve(__dirname, '..'), qaRoot = path.join(root, 'release/xp-qa');
process.env.PORTABLE_EXECUTABLE_DIR = path.join(qaRoot, 'runtime');
app.getAppPath = () => root;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
let showCount = 0, focusCount = 0, desktop, phone;
BrowserWindow.prototype.show = function () { showCount++; };
BrowserWindow.prototype.focus = function () { focusCount++; };
let timeout = setTimeout(() => { console.error('Native workspace preparation timed out'); app.exit(1); }, 720000);
const wait = async (fn, label) => {
  const until = Date.now() + 20000;
  while (!await fn()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 40)); }
};
require('../electron/main.cjs');
app.whenReady().then(async () => {
  await wait(async () => {
    desktop = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'));
    return desktop && await desktop.webContents.executeJavaScript(`Boolean(window.desktopBridge&&document.getElementById('app-version')?.textContent)`);
  }, 'production window');
  const evaluate = async (win, source) => { try { return await win.webContents.executeJavaScript(source); } catch (error) { console.error('Native QA step:', source.slice(0, 100)); throw error; } };
  if (!await evaluate(desktop, `(async()=> (await desktopBridge.speechStatus()).ready)()`)) {
    console.log('Downloading pinned offline speech components for isolated QA (about 80 MB).');
    await evaluate(desktop, 'desktopBridge.installSpeech()');
  }
  clearTimeout(timeout); timeout = setTimeout(() => { console.error('Native workspace smoke timed out'); app.exit(1); }, 60000);
  await evaluate(desktop, 'desktopBridge.configureShortcuts({enabled:false,active:false,save:true})');
  const baseline = { showCount, focusCount };
  if (!desktop.webContents.isAudioMuted()) throw new Error('Desktop audio is not muted');
  // OS registration really runs: reject occupied Num2 and retain disabled previous configuration.
  const occupied = globalShortcut.register('num2', () => {});
  if (!occupied) throw new Error('Cannot reserve Num2 for conflict validation');
  await evaluate(desktop, `(async()=>{let rejected=false;try{await desktopBridge.configureShortcuts({bindings:{screenshot:'num1',voice:'num2',text:'num3','scroll-up':'Up','scroll-down':'Down'},enabled:true,active:true,save:false});}catch{rejected=true;}if(!rejected||(await desktopBridge.getShortcuts()).enabled)throw new Error('Conflict did not roll back');})()`);
  globalShortcut.unregister('num2');
  const speechFixture = (await fs.readFile(path.join(qaRoot, 'generated-speech.wav'))).toString('base64');
  await evaluate(desktop, `(async()=>{
    window.qaAudio=new AudioContext(); const bytes=Uint8Array.from(atob(${JSON.stringify(speechFixture)}),c=>c.charCodeAt(0));window.qaBuffer=await qaAudio.decodeAudioData(bytes.buffer);
    window.qaSystem=qaAudio.createMediaStreamDestination();window.qaMicrophone=qaAudio.createMediaStreamDestination();
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;canvas.getContext('2d').fillRect(0,0,640,360);
    navigator.mediaDevices.getDisplayMedia=async()=>new MediaStream([...canvas.captureStream(5).getTracks(),...qaSystem.stream.getTracks()]);
    navigator.mediaDevices.getUserMedia=async()=>qaMicrophone.stream;
    document.getElementById('capture-mic').checked=true;document.getElementById('start-share').click();
  })()`);
  await wait(() => evaluate(desktop, `document.getElementById('room-code').textContent.length===8`), 'room');
  const pairing = await evaluate(desktop, `({signal:document.getElementById('desktop-signal').value,room:document.getElementById('room-code').textContent})`);
  phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { backgroundThrottling: false, partition: 'native-qa-phone' } });
  await phone.loadURL(desktop.webContents.getURL());
  await evaluate(phone, `document.getElementById('mobile-tab').click();document.getElementById('mobile-signal').value=${JSON.stringify(pairing.signal)};document.getElementById('mobile-room').value=${JSON.stringify(pairing.room)};document.getElementById('mobile-connect').requestSubmit();window.qaRequests=[];window.fetch=async(_url,options)=>{qaRequests.push(JSON.parse(options.body));return new Response(JSON.stringify({choices:[{message:{content:'Phone-only meeting notes. '+('A useful next step. '.repeat(100))}}]}),{headers:{'Content-Type':'application/json'}});};document.getElementById('llm-key').value='native-qa-fixture';document.getElementById('auto-answer').checked=false;`);
  await wait(() => evaluate(desktop, `!document.getElementById('pairing-approval').hidden`), 'approval');
  await evaluate(desktop, `document.getElementById('allow-peer').click()`);
  await wait(() => evaluate(phone, `document.getElementById('mobile-status').textContent==='P2P 已加密直连'`), 'phone connected');
  await evaluate(desktop, `(async()=>{const result=await desktopBridge.configureShortcuts({bindings:{screenshot:'num1',voice:'num2',text:'num3','scroll-up':'Up','scroll-down':'Down'},enabled:true,active:true,save:true});if(result.registered.length!==5)throw new Error('Global bindings missing');})()`);
  const saved = JSON.parse(await fs.readFile(path.join(qaRoot, 'runtime/PAIRO-data/shortcuts.json'), 'utf8'));
  if (!saved.enabled || saved.bindings.screenshot !== 'num1' || saved.bindings['scroll-down'] !== 'Down' || 'active' in saved) throw new Error('Shortcut persistence is incomplete');
  desktop.webContents.send('desktop-shortcut', 'text');
  await wait(() => evaluate(desktop, `!document.getElementById('desktop-input-panel').hidden`), 'text composer');
  await evaluate(desktop, `document.getElementById('desktop-text').value='Please prepare my opening statement.';document.getElementById('desktop-composer').requestSubmit();`);
  await wait(() => evaluate(phone, `qaRequests.length===1&&Boolean(document.querySelector('.chat-message.answer'))`), 'text auto question');
  const beforeScroll = await evaluate(phone, `document.getElementById('message-list').scrollTop`);
  desktop.webContents.send('desktop-shortcut', 'scroll-up');
  await wait(() => evaluate(phone, `document.getElementById('message-list').scrollTop<${beforeScroll - 100}`), 'remote scroll up');
  const afterUp = await evaluate(phone, `document.getElementById('message-list').scrollTop`);
  desktop.webContents.send('desktop-shortcut', 'scroll-down');
  await wait(() => evaluate(phone, `document.getElementById('message-list').scrollTop>${afterUp + 100}`), 'remote scroll down');
  // Count actual source nodes in the production mixer; audio is routed into streams, never speakers.
  await evaluate(desktop, `window.qaSources=0;const original=AudioContext.prototype.createMediaStreamSource;AudioContext.prototype.createMediaStreamSource=function(...args){qaSources++;return original.apply(this,args);};void 0;`);
  desktop.webContents.send('desktop-shortcut', 'voice');
  await wait(() => evaluate(desktop, `document.getElementById('toggle-voice').classList.contains('listening')`), 'offline voice ready');
  await evaluate(desktop, `(async()=>{await qaAudio.resume();const source=qaAudio.createBufferSource();source.buffer=qaBuffer;source.connect(qaSystem);source.start();const mic=qaAudio.createBufferSource();mic.buffer=qaBuffer;const gain=qaAudio.createGain();gain.gain.value=.12;mic.connect(gain);gain.connect(qaMicrophone);mic.start();})()`);
  await wait(() => evaluate(phone, `qaRequests.some(request=>/local meeting assistant/i.test(request.messages.at(-1).content[0].text))`), 'real local audio transcription to phone');
  const sources = await evaluate(desktop, 'qaSources');
  if (sources !== 2) throw new Error('Microphone and system audio were not both mixed');
  desktop.webContents.send('desktop-shortcut', 'voice');
  await evaluate(desktop, `desktopBridge.configureShortcuts({enabled:false,active:false,save:true})`);
  if ((await evaluate(desktop, `desktopBridge.getShortcuts()`)).registered.length) throw new Error('Global keys not released');
  await evaluate(desktop, 'desktopBridge.hideToTray()'); desktop.close();
  if (desktop.isDestroyed() || desktop.isVisible()) throw new Error('Close did not preserve quiet background session');
  if (showCount !== baseline.showCount || focusCount !== baseline.focusCount) throw new Error('Hotkeys opened or focused a window');
  if (await evaluate(desktop, `document.getElementById('desktop-answer').textContent||document.getElementById('toast').classList.contains('show')`)) throw new Error('Desktop output was visible');
  const result = { nativeIpc: true, osShortcutConflictRollback: true, fiveGlobalShortcuts: true, shortcutPersistence: true, textAutoQuestion: true, remoteScroll: true, realOfflineMixedAudio: true, mixerSources: sources, quietBackground: true, desktopAudioMuted: true };
  await fs.writeFile(path.join(qaRoot, 'native-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await evaluate(desktop, `document.getElementById('stop-share').click();qaAudio.close();`);
  clearTimeout(timeout); phone.destroy(); app.quit();
}).catch(async error => {
  console.error(error.stack);
  if (desktop && !desktop.isDestroyed()) console.error('Isolated native state:', await desktop.webContents.executeJavaScript(`({activity:document.getElementById('desktop-activity').textContent,speech:document.getElementById('speech-status').textContent,voice:document.getElementById('toggle-voice').textContent,tracks:document.getElementById('local-preview').srcObject?.getAudioTracks().map(track=>track.readyState)})`).catch(() => null));
  globalShortcut.unregisterAll(); clearTimeout(timeout); app.exit(1);
});
