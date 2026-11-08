// Runs the production Electron main/preload with isolated data and hidden windows.
const { app, BrowserWindow, globalShortcut, dialog } = require('electron');
// This hidden integration fixture must never copy from the user's foreground app.
// Real UIA/SendInput are checked separately by test-text-worker.ps1 in its own input form.
const path = require('node:path');
const appRoot = path.resolve(process.env.PAIRO_QA_APP_ROOT || path.join(__dirname, '..'));
const textModule = require(path.join(appRoot, 'electron/text-automation.cjs'));
const originalTextFactory = textModule.createTextAutomation;
const nativeShortcuts = [], nativeControl = [];
textModule.createTextAutomation = options => {
  const text = originalTextFactory({ ...options,
    onShortcut(action) { nativeShortcuts.push(action); options.onShortcut(action); },
    ...(withTyping && { spawnImpl: (...args) => {
      const child = require('node:child_process').spawn(...args);
      require('node:readline').createInterface({ input: child.stdout }).on('line', line => {
        try {
          const v = JSON.parse(line);
          if (v.ready || v.configured || (v.id === 0 && v.error)) nativeControl.push(v.ready ? 'ready' : v.configured ? 'configured' : 'binding-error');
        } catch { /* Do not persist worker content. */ }
      });
      return child;
    } }),
  });
  const setBindings = text.setBindings;
  return Object.assign(text, { copySelection: async () => 'Please prepare my opening statement.',
    setBindings(value) { if (withTyping) nativeControl.push(value.enabled && value.active ? 'enable' : 'disable'); return setBindings(value); } });
};
const fs = require('node:fs/promises');
const root = appRoot, qaRoot = path.resolve(__dirname, '..', process.env.PAIRO_QA_OUTPUT || (process.env.PAIRO_QA_APP_ROOT ? 'release/architecture-qa/packaged-qa' : 'release/xp-qa'));
const fixtureDirectory = path.join(qaRoot, 'knowledge-fixture');
const openDialog = dialog.showOpenDialog;
dialog.showOpenDialog = (parent, options) => options.title === '选择要添加到知识库的目录' ? Promise.resolve({ canceled: false, filePaths: [fixtureDirectory] }) : openDialog(parent, options);
process.env.PORTABLE_EXECUTABLE_DIR = path.join(qaRoot, 'runtime');
app.getAppPath = () => root;
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
let showCount = 0, focusCount = 0, desktop, phone;
const textOnly = process.argv.includes('--text-only');
const withTyping = process.argv.includes('--typing');
BrowserWindow.prototype.show = function () { showCount++; };
BrowserWindow.prototype.focus = function () { focusCount++; };
let timeout = setTimeout(() => { console.error('Native workspace preparation timed out'); app.exit(1); }, 720000);
const wait = async (fn, label) => {
  const until = Date.now() + 20000;
  while (!await fn()) { if (Date.now() > until) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 40)); }
};
const modelRequests = [], originalFetch = globalThis.fetch;
let failOnce = true;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://pairo-fixture.invalid/')) {
    modelRequests.push(JSON.parse(options.body));
    const question = modelRequests.at(-1).messages.at(-1).content[0].text;
    if (question.includes('<资料>')) return Response.json({ choices: [{ message: { content: 'Constellation 发布由林工审批，使用快照回滚。' } }] });
    if (question === 'fixture-fail' && failOnce) { failOnce = false; return Response.json({ error: { message: 'synthetic unavailable' } }, { status: 503 }); }
    const text = ({ 'fixture-type-older': 'older answer must never type', 'fixture-type-short': '最新完整回答\nsafe answer 42',
      'fixture-type-long': 'A longer synthetic answer. '.repeat(8) })[question] || 'PC-generated meeting notes. ' + 'A useful next step. '.repeat(100);
    const encoder = new TextEncoder(); let timer;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'));
      timer = setTimeout(() => { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }, question === 'fixture-cancel' ? 1800 : 400);
    }, cancel() { clearTimeout(timer); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return originalFetch(url, options);
};
require(path.join(root, 'electron/main.cjs'));
app.whenReady().then(async () => {
  await wait(async () => {
    desktop = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('http://127.0.0.1:'));
    return desktop && await desktop.webContents.executeJavaScript(`Boolean(window.desktopBridge&&document.getElementById('app-version')?.textContent)`);
  }, 'production window');
  const evaluate = async (win, source) => { try { return await win.webContents.executeJavaScript(source); } catch (error) { console.error('Native QA step:', source.slice(0, 100)); throw error; } };
  if (!textOnly && !await evaluate(desktop, `(async()=> (await desktopBridge.speechStatus()).ready)()`)) {
    console.log('Downloading missing pinned offline speech components for isolated QA.');
    await evaluate(desktop, 'desktopBridge.installSpeech()');
  }
  clearTimeout(timeout); timeout = setTimeout(() => { console.error('Native workspace smoke timed out'); app.exit(1); }, withTyping ? 120000 : 100000);
  await evaluate(desktop, 'desktopBridge.configureShortcuts({enabled:false,active:false,save:true})');
  const baseline = { showCount, focusCount };
  if (!desktop.webContents.isAudioMuted()) throw new Error('Desktop audio is not muted');
  // OS registration really runs: reject occupied Num2 and retain disabled previous configuration.
  const occupied = globalShortcut.register('num2', () => {});
  if (!occupied) throw new Error('Cannot reserve Num2 for conflict validation');
  await evaluate(desktop, `(async()=>{let rejected=false;try{await desktopBridge.configureShortcuts({bindings:{screenshot:'num1',voice:'num2',text:'num3','scroll-up':'Up','scroll-down':'Down'},enabled:true,active:true,save:false});}catch{rejected=true;}if(!rejected||(await desktopBridge.getShortcuts()).enabled)throw new Error('Conflict did not roll back');})()`);
  globalShortcut.unregister('num2');
  const speechFixture = textOnly ? '' : (await fs.readFile(path.join(qaRoot, 'generated-speech.wav'))).toString('base64');
  const chineseFixture = !textOnly && process.env.PAIRO_QA_CHINESE_WAV ? (await fs.readFile(process.env.PAIRO_QA_CHINESE_WAV)).toString('base64') : '';
  await evaluate(desktop, `(async()=>{
    window.qaChannels=[];const qaRTC=window.RTCPeerConnection;window.RTCPeerConnection=class extends qaRTC{createDataChannel(...args){const c=super.createDataChannel(...args);qaChannels.push(c);return c;}};
    window.qaAudio=new AudioContext(); const decode=async value=>{const bytes=Uint8Array.from(atob(value),c=>c.charCodeAt(0));return bytes.length?qaAudio.decodeAudioData(bytes.buffer):null;};
    window.qaBuffer=await decode(${JSON.stringify(speechFixture)});window.qaChinese=await decode(${JSON.stringify(chineseFixture)});
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
  await evaluate(phone, `document.getElementById('mobile-tab').click();document.getElementById('mobile-signal').value=${JSON.stringify(pairing.signal)};document.getElementById('mobile-room').value=${JSON.stringify(pairing.room)};document.getElementById('mobile-connect').requestSubmit();window.fetch=async()=>{throw new Error('Phone attempted model access')};true`);
  await evaluate(desktop, `document.getElementById('llm-key').value='native-qa-fixture';document.getElementById('llm-endpoint').value='https://pairo-fixture.invalid/chat';true`);
  await wait(() => evaluate(desktop, `!document.getElementById('pairing-approval').hidden`), 'approval');
  await evaluate(desktop, `document.getElementById('allow-peer').click()`);
  await wait(() => evaluate(phone, `document.getElementById('mobile-status').textContent==='P2P 已加密直连'`), 'phone connected');
  await evaluate(desktop, `(async()=>{const result=await desktopBridge.configureShortcuts({bindings:{screenshot:'num1',voice:'num2',text:'num3','scroll-up':'Up','scroll-down':'Down'},enabled:true,active:true,save:true});if(result.registered.length!==6)throw new Error('Global bindings missing');})()`);
  const saved = JSON.parse(await fs.readFile(path.join(qaRoot, 'runtime/PAIRO-data/shortcuts.json'), 'utf8'));
  if (!saved.enabled || saved.bindings.screenshot !== 'num1' || saved.bindings['scroll-down'] !== 'Down' || 'active' in saved) throw new Error('Shortcut persistence is incomplete');
  desktop.webContents.send('desktop-shortcut', 'text');
  await wait(() => evaluate(phone, `document.querySelector('.chat-message.answer[data-status=generating]')?.textContent.includes('PC-generated')`), 'partial answer visible before completion');
  await wait(async () => modelRequests.length===1 && await evaluate(phone, `Boolean(document.querySelector('.chat-message.answer[data-status=complete]'))`), 'PC text answer synchronized');
  await evaluate(desktop, `(async()=>{await desktopBridge.saveTypingSettings({chineseCpm:75,englishWpm:110});const read=await desktopBridge.readTypingSettings();if(read.chineseCpm!==75||read.englishWpm!==110)throw new Error('Typing settings persistence failed');let rejected=false;try{await desktopBridge.saveTypingSettings({chineseCpm:0,englishWpm:900});}catch{rejected=true;}if(!rejected)throw new Error('Invalid typing settings accepted');})()`);
  const savedTyping = JSON.parse(await fs.readFile(path.join(qaRoot, 'runtime/PAIRO-data/typing-settings.json'), 'utf8'));
  if (Object.keys(savedTyping).length !== 2 || savedTyping.chineseCpm !== 75 || savedTyping.englishWpm !== 110) throw new Error('Wrong typing settings file');
  const beforeScroll = await evaluate(phone, `document.getElementById('message-list').scrollTop`);
  desktop.webContents.send('desktop-shortcut', 'scroll-up');
  await wait(() => evaluate(phone, `document.getElementById('message-list').scrollTop<${beforeScroll - 100}`), 'remote scroll up');
  const afterUp = await evaluate(phone, `document.getElementById('message-list').scrollTop`);
  desktop.webContents.send('desktop-shortcut', 'scroll-down');
  await wait(() => evaluate(phone, `document.getElementById('message-list').scrollTop>${afterUp + 100}`), 'remote scroll down');
  let sources = null, chineseVoice = false, chineseTranscript = null, toneRejected = false, overlappingTranscripts = [];
  if (!textOnly) {
  // Count independent source nodes; fixture audio goes into streams, never speakers.
  await evaluate(desktop, `window.qaSources=0;const original=AudioContext.prototype.createMediaStreamSource;AudioContext.prototype.createMediaStreamSource=function(...args){qaSources++;return original.apply(this,args);};void 0;`);
  await evaluate(desktop, `document.getElementById('speech-language').value='en';document.getElementById('speech-language').dispatchEvent(new Event('change'));`);
  await wait(() => evaluate(desktop, `(async()=> (await desktopBridge.speechStatus()).settings.language==='en'&&!document.getElementById('speech-language').disabled)()`), 'speech language saved');
  desktop.webContents.send('desktop-shortcut', 'voice');
  await wait(() => evaluate(desktop, `document.getElementById('toggle-voice').classList.contains('listening')`), 'offline voice ready');
  const callsBeforeNoise = modelRequests.length;
  await evaluate(desktop, `(async()=>{await qaAudio.resume();const noise=qaAudio.createOscillator();noise.frequency.value=100;const level=qaAudio.createGain();level.gain.value=.03;noise.connect(level);level.connect(qaSystem);noise.start();noise.stop(qaAudio.currentTime+1.05);})()`);
  await wait(() => evaluate(desktop, `document.getElementById('desktop-activity').textContent.includes('未检测到人声')`), 'native VAD rejects a generated pure tone');
  if (modelRequests.length !== callsBeforeNoise) throw new Error('A non-voice fixture triggered a question');
  toneRejected = true;
  await evaluate(desktop, `(async()=>{await qaAudio.resume();const source=qaAudio.createBufferSource();source.buffer=qaBuffer;source.connect(qaSystem);source.start();const mic=qaAudio.createBufferSource();mic.buffer=qaBuffer;const gain=qaAudio.createGain();gain.gain.value=.12;mic.connect(gain);gain.connect(qaMicrophone);mic.start();})()`);
  await wait(() => modelRequests.some(request=>/local meeting assistant/i.test(request.messages.at(-1).content[0].text)), 'real local audio transcription to PC');
  await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.prompter-entry')).some(e=>/local meeting assistant/i.test(e.firstElementChild.textContent)&&e.querySelector('[data-status=complete]')?.textContent.includes('PC-generated'))`), 'offline voice answer on phone view');
  sources = await evaluate(desktop, 'qaSources');
  if (sources !== 2) throw new Error('Microphone and system audio did not both get independent source nodes');
  desktop.webContents.send('desktop-shortcut', 'voice');
  await wait(() => evaluate(desktop, `!document.getElementById('toggle-voice').classList.contains('listening')`), 'first speech session stopped');
  if (chineseFixture) {
    await evaluate(desktop, `document.getElementById('speech-language').value='zh';document.getElementById('speech-language').dispatchEvent(new Event('change'));`);
    await wait(() => evaluate(desktop, `(async()=> (await desktopBridge.speechStatus()).settings.language==='zh'&&!document.getElementById('speech-language').disabled)()`), 'Mandarin language setting');
    desktop.webContents.send('desktop-shortcut', 'voice');
    await wait(() => evaluate(desktop, `document.getElementById('toggle-voice').classList.contains('listening')`), 'Mandarin session restarted');
    const callsBeforeChinese = modelRequests.length;
    await evaluate(desktop, `(async()=>{const source=qaAudio.createBufferSource();source.buffer=qaChinese;source.connect(qaMicrophone);source.start();})()`);
    await wait(() => {
      // Score spelling in the fixture benchmark. This smoke checks that the
      // captured sentence reaches the PC and the same raw text reaches the phone.
      chineseTranscript = modelRequests.slice(callsBeforeChinese).map(request => request.messages.at(-1).content[0].text)
        .find(text => /确认客户端能否自动重[连联]/.test(text)) ?? null;
      return chineseTranscript;
    }, 'quiet Mandarin on one active track reaches PC');
    await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.prompter-entry')).some(e=>e.firstElementChild.textContent===${JSON.stringify(chineseTranscript)}&&e.querySelector('[data-status=complete]'))`), 'same Mandarin transcript reaches phone view');
    chineseVoice = true;
    desktop.webContents.send('desktop-shortcut', 'voice');
    await wait(() => evaluate(desktop, `!document.getElementById('toggle-voice').classList.contains('listening')`), 'Mandarin speech session stopped');
    await evaluate(desktop, `document.getElementById('speech-language').value='auto';document.getElementById('speech-language').dispatchEvent(new Event('change'));`);
    await wait(() => evaluate(desktop, `(async()=> (await desktopBridge.speechStatus()).settings.language==='auto'&&!document.getElementById('speech-language').disabled)()`), 'automatic language setting');
    desktop.webContents.send('desktop-shortcut', 'voice');
    await wait(() => evaluate(desktop, `document.getElementById('toggle-voice').classList.contains('listening')`), 'dual-language session restarted');
    const beforeOverlap = modelRequests.length;
    await evaluate(desktop, `(async()=>{const start=qaAudio.currentTime+.1;for(const [buffer,target] of [[qaChinese,qaMicrophone],[qaBuffer,qaSystem]]){const source=qaAudio.createBufferSource();source.buffer=buffer;source.connect(target);source.start(start);}})()`);
    await wait(() => {
      const texts = modelRequests.slice(beforeOverlap).map(request => request.messages.at(-1).content[0].text);
      const chinese = texts.find(text => /确认客户端能否自动重[连联]/.test(text));
      const english = texts.find(text => /local meeting assistant/i.test(text));
      if (chinese && english) overlappingTranscripts = [chinese, english];
      return overlappingTranscripts.length === 2;
    }, 'simultaneous independent Mandarin and English both reach PC');
    for (const text of overlappingTranscripts) await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.prompter-entry')).some(e=>e.firstElementChild.textContent===${JSON.stringify(text)}&&e.querySelector('[data-status=complete]'))`), 'each original overlapping transcript reaches phone');
    desktop.webContents.send('desktop-shortcut', 'voice');
    await wait(() => evaluate(desktop, `!document.getElementById('toggle-voice').classList.contains('listening')`), 'dual-language speech session stopped');
    await evaluate(desktop, `document.getElementById('desktop-nav-keys').click();document.getElementById('speech-profile').scrollIntoView({block:'center'});`);
    await desktop.webContents.capturePage(); await new Promise(r => setTimeout(r, 120));
    await fs.writeFile(path.join(qaRoot, 'desktop-speech-settings.png'), (await desktop.webContents.capturePage()).toPNG());
  }
  }
  // Exercise the real production directory boundary, index, model bridge and UI with synthetic data only.
  await fs.mkdir(fixtureDirectory, { recursive: true });
  await fs.writeFile(path.join(fixtureDirectory, 'workflow.md'), '# Constellation 发布流程\nConstellation 发布由林工审批，使用快照回滚。');
  await fs.writeFile(path.join(fixtureDirectory, 'unsupported.pdf'), 'synthetic unsupported format');
  await fs.writeFile(path.join(fixtureDirectory, '.env'), 'FIXTURE_PRIVATE=must-stay-on-pc');
  const previous = await evaluate(desktop, 'desktopBridge.knowledgeList()');
  for (const d of previous.directories) await evaluate(desktop, `desktopBridge.knowledgeRemove({id:${JSON.stringify(d.id)}})`);
  await evaluate(desktop, `document.getElementById('knowledge-refresh').click()`);
  await wait(() => evaluate(desktop, `!document.getElementById('knowledge-empty').hidden&&!document.querySelector('#knowledge-list button')`), 'previous QA directory removed');
  await evaluate(desktop, `document.getElementById('desktop-nav-knowledge').click();document.getElementById('knowledge-consent').checked=true;document.getElementById('knowledge-add').click();`);
  await wait(() => evaluate(desktop, `document.querySelector('#knowledge-list button')?.textContent.includes('导入')`), 'directory added through native chooser');
  const beforeIndex = modelRequests.length;
  await evaluate(desktop, `document.querySelector('#knowledge-list button').click()`);
  await wait(() => evaluate(desktop, `document.getElementById('knowledge-status').textContent.startsWith('已完成')`), 'knowledge understanding');
  if (modelRequests.length !== beforeIndex + 1) throw new Error('Import did not make exactly one understanding request');
  if (JSON.stringify(modelRequests).includes('must-stay-on-pc')) throw new Error('An excluded fixture reached the model');
  await evaluate(desktop, `document.querySelector('#knowledge-list button').click()`);
  await wait(() => evaluate(desktop, `document.getElementById('knowledge-cancel').hidden`), 'incremental update');
  if (modelRequests.length !== beforeIndex + 1) throw new Error('Unchanged file was re-summarized');
  await evaluate(desktop, `document.getElementById('desktop-nav-knowledge').click();if(document.getElementById('desktop-knowledge-page').hidden)throw new Error('Knowledge page is hidden');true`);
  await desktop.webContents.capturePage(); await new Promise(r => setTimeout(r, 150));
  await fs.writeFile(path.join(qaRoot, 'desktop-knowledge.png'), (await desktop.webContents.capturePage()).toPNG());
  await evaluate(desktop, `Array.from(document.querySelectorAll('#knowledge-list .knowledge-file')).find(e=>e.textContent.includes('workflow.md')).open=true;document.getElementById('desktop-knowledge-page').scrollTop=10000;true`);
  await desktop.webContents.capturePage(); await new Promise(r => setTimeout(r, 150));
  await fs.writeFile(path.join(qaRoot, 'desktop-knowledge-sources.png'), (await desktop.webContents.capturePage()).toPNG());
  const ask = async question => {
    const before = modelRequests.length;
    await evaluate(desktop, `document.getElementById('question-input').value=${JSON.stringify(question)};document.getElementById('composer').requestSubmit();`);
    await wait(() => evaluate(desktop, `document.getElementById('model-queue-status').textContent.startsWith('回答已完成')`), 'PC answer complete');
    if (modelRequests.length !== before + 1) throw new Error('Question introduced an extra remote classification request');
    return modelRequests.at(-1);
  };
  const related = await ask('Constellation 的发布审批和回滚怎么做？');
  if (!related.messages.some(m => typeof m.content === 'string' && m.content.includes('原文：') && m.content.includes('林工'))) throw new Error('Retrieved original source missing');
  const followUp = await ask('那审批的具体步骤呢？');
  if (!followUp.messages.some(m => typeof m.content === 'string' && m.content.includes('原文：'))) throw new Error('Relevant follow-up lost context');
  const unrelated = await ask('那么法国的首都是什么？');
  if (unrelated.messages.some(m => typeof m.content === 'string' && m.content.includes('原文：'))) throw new Error('Unrelated question received KB context');
  await wait(() => evaluate(desktop, `document.getElementById('model-queue-status').textContent.includes('已发送 · 手机接收未确认')`), 'PC reports send without ACK');
  await wait(() => evaluate(phone, `document.querySelectorAll('.prompter-entry').length>=3`), 'knowledge answers synchronized');
  const count = await evaluate(phone, `document.querySelectorAll('.prompter-entry').length`);
  await evaluate(desktop, `qaChannels.at(-1).close();true`);
  await wait(() => evaluate(desktop, `document.getElementById('model-queue-status').textContent.endsWith('待连接手机')`), 'PC shows pending on disconnect');
  await wait(() => evaluate(phone, `document.getElementById('prompter-status').textContent.startsWith('连接中断')`), 'interrupted reading state');
  await wait(() => evaluate(phone, `document.getElementById('prompter-status').textContent.startsWith('已同步')&&document.querySelectorAll('.prompter-entry').length===${count}`), 'reconnect resumes same answers');
  // Cancel a live stream and then fail a newer request; neither may become a completed answer.
  await evaluate(desktop, `document.getElementById('question-input').value='fixture-cancel';document.getElementById('composer').requestSubmit();`);
  await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.chat-message.answer')).at(-1)?.dataset.status==='generating'`), 'live generation');
  await evaluate(desktop, `document.getElementById('cancel-model').click()`);
  await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.chat-message.answer')).at(-1)?.dataset.status==='cancelled'`), 'cancel synchronized');
  await evaluate(desktop, `document.getElementById('question-input').value='fixture-fail';document.getElementById('composer').requestSubmit();`);
  await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.chat-message.answer')).at(-1)?.dataset.status==='failed'`), 'failure synchronized');
  await evaluate(desktop, `document.getElementById('retry-model').click()`);
  await wait(() => evaluate(phone, `Array.from(document.querySelectorAll('.chat-message.answer')).at(-1)?.dataset.status==='complete'`), 'failed answer retried on PC and completed on phone');
  if (modelRequests.filter(request => request.messages.at(-1).content[0].text === 'fixture-fail').length !== 2) throw new Error('Retry did not issue exactly one new request');
  const answerTyping = withTyping ? await require('./native-answer-typing.cjs').checkAnswerTyping({ evaluate: source => evaluate(desktop, source), ask, wait, nativeShortcuts }) : null;
  await evaluate(desktop, `document.getElementById('clear-chat').click()`);
  await wait(() => evaluate(phone, `document.querySelectorAll('.prompter-entry').length===0`), 'PC clear synchronized');
  await evaluate(desktop, `desktopBridge.configureShortcuts({enabled:false,active:false,save:true})`);
  if ((await evaluate(desktop, `desktopBridge.getShortcuts()`)).registered.length) throw new Error('Global keys not released');
  await evaluate(desktop, 'desktopBridge.hideToTray()'); desktop.close();
  if (desktop.isDestroyed() || desktop.isVisible()) throw new Error('Close did not preserve quiet background session');
  if (showCount !== baseline.showCount || focusCount !== baseline.focusCount) throw new Error('Hotkeys opened or focused a window');
  if (await evaluate(desktop, `document.getElementById('desktop-answer').textContent||document.getElementById('toast').classList.contains('show')`)) throw new Error('Desktop output was visible');
  const result = { nativeIpc: true, ragImport: true, privateFileExcluded: true, incrementalCache: true, directedRetrieval: true, followUpAndSwitch: true, unrelatedSingleRequest: true, prompterReconnectRecovery: true, honestDeliveryState: true, pcClearSynchronized: true, partialBeforeComplete: true, cancelledAndFailedStates: true, retryOnPC: true, osShortcutConflictRollback: true, sixGlobalShortcuts: true, shortcutPersistence: true, typingSettingsPersistence: true, answerTyping, textAutoQuestion: true, remoteScroll: true, independentOfflineAudioSources: sources, offlineVoiceAnswerOnPhoneView: !textOnly, toneRejected, chineseVoice, chineseTranscript, overlappingTranscripts, quietBackground: true, desktopAudioMuted: true };
  await fs.writeFile(path.join(qaRoot, 'native-result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  await evaluate(desktop, `document.getElementById('stop-share').click();qaAudio.close();`);
  clearTimeout(timeout); phone.destroy(); app.quit();
}).catch(async error => {
  console.error(error.stack);
  if (withTyping) console.error('Native hook diagnostics:', { nativeShortcuts, nativeControl });
  if (desktop && !desktop.isDestroyed()) console.error('Isolated native state:', await desktop.webContents.executeJavaScript(`({activity:document.getElementById('desktop-activity').textContent,speech:document.getElementById('speech-status').textContent,voice:document.getElementById('toggle-voice').textContent,tracks:document.getElementById('local-preview').srcObject?.getAudioTracks().map(track=>track.readyState)})`).catch(() => null));
  globalShortcut.unregisterAll(); clearTimeout(timeout); app.exit(1);
});
