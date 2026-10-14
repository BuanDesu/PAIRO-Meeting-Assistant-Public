const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), dist = path.join(root, 'dist'), output = path.join(root, 'release/xp-qa');
const deadline = setTimeout(() => { console.error('Workspace smoke timed out'); app.exit(1); }, 60000);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
const wait = async (predicate, label) => {
  const end = Date.now() + 12000;
  while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 40)); }
};
app.whenReady().then(async () => {
  await fs.mkdir(output, { recursive: true });
  const { createSignalingServer } = await import(pathToFileURL(path.join(root, 'server/signaling.js')).href);
  const signaling = createSignalingServer({ allowedOrigins: '' });
  await new Promise(resolve => signaling.server.listen(0, '127.0.0.1', resolve));
  const signalBase = 'http://127.0.0.1:' + signaling.server.address().port;
  const ui = createServer(async (req, res) => {
    try {
      const target = path.resolve(dist, '.' + (req.url === '/' ? '/index.html' : new URL(req.url, 'http://localhost').pathname));
      if (!target.startsWith(dist + path.sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' }[path.extname(target)] || 'application/octet-stream');
      res.end(await fs.readFile(target));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + ui.address().port;
  ipcMain.handle('ui-smoke-signal', () => ({ signalBase, lanAddresses: [{ interface: 'Wi-Fi', ip: '192.168.1.20', url: 'http://192.168.1.20:8787' }] }));
  ipcMain.handle('ui-smoke-open-releases', () => {});
  const desktop = new BrowserWindow({ width: 1120, height: 900, show: false, webPreferences: { backgroundThrottling: false, preload: path.join(__dirname, 'ui-smoke-preload.cjs'), partition: 'xp-desktop-qa' } });
  const phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { backgroundThrottling: false, partition: 'xp-mobile-qa' } });
  const errors = [];
  for (const win of [desktop, phone]) win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error('Isolated renderer:', event.message); } });
  await desktop.loadURL(origin); await phone.loadURL(origin);
  const evaluate = async (win, source) => {
    try { return await win.webContents.executeJavaScript(source); }
    catch (error) { console.error('Failed QA operation:', source.slice(0, 150)); throw error; }
  };
  async function snapshot(win, name) {
    if (win === phone) await wait(() => evaluate(phone, `!document.getElementById('toast').classList.contains('show')`), 'transient phone hint cleared');
    await win.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 100));
    await fs.writeFile(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await evaluate(desktop, `document.getElementById('desktop-nav-source').click();
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#2765c5';ctx.fillRect(0,0,640,360);ctx.fillStyle='#fff';ctx.font='28px sans-serif';ctx.fillText('PAIRO · XP WORKSPACE',50,180);
    window.qaCapture=canvas.captureStream(5);navigator.mediaDevices.getDisplayMedia=async()=>qaCapture;
    navigator.mediaDevices.getUserMedia=async()=>{throw new Error('Microphone must not be requested in one-to-one mode');};
    document.getElementById('meeting-mode').value='one-to-one';document.getElementById('meeting-mode').dispatchEvent(new Event('change'));
    document.getElementById('start-share').click();`);
  await wait(() => evaluate(desktop, `document.getElementById('room-code').textContent.length===8`), 'room creation');
  const room = await evaluate(desktop, `document.getElementById('room-code').textContent`);
  await evaluate(phone, `document.getElementById('mobile-tab').click();document.getElementById('mobile-signal').value=${JSON.stringify(signalBase)};document.getElementById('mobile-room').value=${JSON.stringify(room)};document.getElementById('mobile-connect').requestSubmit();`);
  await wait(() => evaluate(desktop, `!document.getElementById('pairing-approval').hidden`), 'approval');
  await evaluate(desktop, `document.getElementById('allow-peer').click()`);
  await wait(() => evaluate(phone, `document.getElementById('mobile-status').textContent==='P2P 已加密直连'`), 'connected');
  // All AI calls are intercepted in this isolated page; no external Key or provider is involved.
  await evaluate(phone, `window.qaQuestions=[];window.fetch=async(url,options)=>{const body=JSON.parse(options.body);qaQuestions.push(body);return new Response(JSON.stringify({choices:[{message:{content:'建议先说明目标，再给出两项具体行动。\\n\\n第一，集中讨论最重要的问题。第二，明确负责人和下一步时间。'}}]}),{headers:{'Content-Type':'application/json'}});};document.getElementById('llm-key').value='isolated-fixture-key';document.getElementById('auto-answer').checked=false;`);
  await evaluate(desktop, `document.getElementById('screenshot-question').value='请回答图中的问题。';document.getElementById('take-shot').click();`);
  await wait(() => evaluate(phone, `document.querySelectorAll('.chat-message.answer').length===1`), 'automatic screenshot question');
  const checks = await evaluate(phone, `(()=>{const request=qaQuestions[0],content=request.messages.at(-1).content;if(content[0].text!=='请回答图中的问题。'||content[1].type!=='image_url')throw new Error('Question and screenshot were not paired');if(document.getElementById('mobile-chat-page').hidden)throw new Error('Phone did not open assistant');return {screenshotAutoQuestion:true,phoneOnlyAnswer:true};})()`);
  await evaluate(desktop, `if(document.getElementById('desktop-answer').textContent)throw new Error('Answer reached desktop');if(document.getElementById('toast').classList.contains('show'))throw new Error('Desktop toast surfaced');`);
  for (const page of ['pair', 'source', 'keys']) {
    await evaluate(desktop, `document.getElementById('desktop-nav-${page}').click();if(document.getElementById('room-code').textContent!==${JSON.stringify(room)})throw new Error('Navigation replaced room');`);
    await snapshot(desktop, 'desktop-' + page);
  }
  for (const page of ['pair', 'api', 'chat']) {
    await evaluate(phone, `document.getElementById('mobile-nav-${page}').click();`);
    const fit = await evaluate(phone, `(()=>{if(document.documentElement.scrollWidth>innerWidth)throw new Error('Portrait page overflows');const nav=document.querySelector('#mobile-view .bottom-nav').getBoundingClientRect();if(nav.bottom>innerHeight+1)throw new Error('Navigation is below viewport: '+JSON.stringify({bottom:nav.bottom,viewport:innerHeight}));return true;})()`);
    if (!fit) throw new Error('Phone layout did not fit');
    await snapshot(phone, 'mobile-' + page);
  }
  const layout = await evaluate(phone, `(()=>{const list=document.getElementById('message-list').getBoundingClientRect(),composer=document.getElementById('composer').getBoundingClientRect();if(list.height<innerHeight*.50||composer.height>60)throw new Error('Chat does not prioritize reading: '+JSON.stringify({list:list.height,composer:composer.height,viewport:innerHeight}));return {chatHeight:Math.round(list.height),composerHeight:Math.round(composer.height),viewportHeight:innerHeight};})()`);
  // Loading the production worklet is part of the check; this catches build URL/CSP failures.
  const worklet = await evaluate(desktop, `(async()=>{const ctx=new AudioContext({sampleRate:16000});const source=await fetch('/').then(r=>r.text());const entry=source.match(/src="([^\"]+assets[^\"]+\.js)"/)[1];const bundle=await fetch(entry).then(r=>r.text());const uri=bundle.match(new RegExp('data:(?:text|application)/javascript;base64,[A-Za-z0-9+/=]+'))?.[0];if(!uri)throw new Error('Production worklet missing');await ctx.audioWorklet.addModule(uri);const processor=new AudioWorkletNode(ctx,'pairo-voice-chunks');processor.disconnect();await ctx.close();return true;})()`);
  console.log(JSON.stringify({ ...checks, navigationKeepsRoom: true, portraitFits: true, desktopSilent: true, productionWorklet: worklet, ...layout, consoleErrors: errors }));
  await fs.writeFile(path.join(output, 'workspace-result.json'), JSON.stringify({ ...checks, layout, errors }, null, 2));
  clearTimeout(deadline); desktop.destroy(); phone.destroy();
  for (const socket of signaling.wss.clients) socket.terminate();
  signaling.wss.close(); signaling.server.close(); ui.close(); app.exit(errors.length ? 1 : 0);
}).catch(error => { console.error(error.stack); clearTimeout(deadline); app.exit(1); });
