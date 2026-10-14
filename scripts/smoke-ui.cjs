const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const { showCapturePicker } = require('../electron/capture-picker.cjs');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
let win, phone, ui, signaling;
const timeout = setTimeout(() => { console.error('UI smoke timed out'); app.exit(1); }, 60000);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');
async function captureRendered() {
  // The first snapshot wakes the compositor for a hidden BrowserWindow.
  await win.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 150));
  return (await win.webContents.capturePage()).toPNG();
}

app.whenReady().then(async () => {
  const { createSignalingServer } = await import(pathToFileURL(path.join(root, 'server/signaling.js')).href);
  signaling = createSignalingServer({ allowedOrigins: '' });
  await new Promise(resolve => signaling.server.listen(0, '127.0.0.1', resolve));
  const signalBase = 'http://127.0.0.1:' + signaling.server.address().port;
  let releasesOpened = 0;
  ipcMain.handle('ui-smoke-open-releases', () => { releasesOpened++; });
  ipcMain.handle('ui-smoke-signal', () => ({ signalBase, lanAddresses: [
    { interface: 'Wi-Fi', ip: '192.168.1.20', url: 'http://192.168.1.20:8787' },
    { interface: 'VPN', ip: '10.0.0.1', url: 'http://10.0.0.1:8787' },
  ] }));
  ui = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/bootstrap') { response.end('<html><body></body></html>'); return; }
      const target = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
      response.end(await fs.readFile(target));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + ui.address().port;
  win = new BrowserWindow({ width: 1120, height: 900, show: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'ui-smoke-preload.cjs') } });
  ipcMain.handle('ui-smoke-snapshot', async (_event, name) => {
    if (name !== 'region') throw new Error('Unknown QA snapshot');
    await fs.writeFile(path.join(root, 'release', 'ui-qa', 'region.png'), await captureRendered());
  });
  await win.loadURL(origin + '/bootstrap');
  await win.webContents.executeJavaScript("localStorage.setItem('pairo.preferences.v1','null')");
  await win.loadURL(origin);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const el = id => document.getElementById(id);
    const wait = async predicate => {
      const until = Date.now() + 5000;
      while (!predicate()) { if (Date.now() > until) throw new Error('UI did not reach expected state'); await new Promise(r => setTimeout(r, 20)); }
    };
    await wait(() => el('desktop-lan-select').options.length === 2);
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (!url.startsWith('https://api.github.com/')) return originalFetch(url, options);
      if (options.credentials !== 'omit' || options.headers.Authorization) throw new Error('Update query includes credentials');
      return new Response('', { status: 404 });
    };
    try {
      el('show-updates').click();
      if (!el('updates-dialog').open || !el('app-version').textContent.startsWith('版本 ')) throw new Error('Update dialog missing version');
      el('check-updates').click();
      await wait(() => !el('check-updates').disabled);
      if (!el('update-status').textContent.includes('登录')) throw new Error('Private release query misreported as current');
      el('open-releases').click();
      el('close-updates').click();
      if (el('updates-dialog').open) throw new Error('Update dialog cannot close');
    } finally { window.fetch = originalFetch; }
    el('desktop-lan-select').value = 'http://10.0.0.1:8787';
    el('desktop-lan-select').dispatchEvent(new Event('change'));
    if (el('desktop-lan-addresses').textContent !== 'http://10.0.0.1:8787') throw new Error('Address selection is ignored');
    el('desktop-lan-select').value = 'http://192.168.1.20:8787';
    el('desktop-lan-select').dispatchEvent(new Event('change'));
    const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
    canvas.getContext('2d').fillStyle='#ee2222'; canvas.getContext('2d').fillRect(0,0,640,360);
    canvas.getContext('2d').fillStyle='#22ee22'; canvas.getContext('2d').fillRect(320,0,320,360);
    const capture = canvas.captureStream(5);
    const track = capture.getVideoTracks()[0];
    navigator.mediaDevices.getDisplayMedia = async () => capture;
    el('capture-mic').checked = false;
    el('start-share').click();
    await wait(() => !el('pairing-qr').hidden && el('pairing-qr-image').complete && el('pairing-qr-image').naturalWidth > 0);
    await wait(() => el('desktop-feed-status').textContent === '等待手机配对');
    el('pairing-qr').scrollIntoView({ block: 'center' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.uiSmokeTrack = track;
    return {invalidPreferencesRecovered:true,addressSelection:true,qrRendered:true,roomCode:el('room-code').textContent};
  })()`);
  if (releasesOpened !== 1) throw new Error('Desktop release link did not reach the native bridge');
  await fs.mkdir(path.join(root, 'release', 'ui-qa'), { recursive: true });
  await fs.writeFile(path.join(root, 'release', 'ui-qa', 'desktop.png'), await captureRendered());
  phone = new BrowserWindow({ width: 390, height: 844, show: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await phone.loadURL(origin);
  await phone.webContents.executeJavaScript(`document.getElementById('mobile-tab').click(); document.getElementById('mobile-signal').value=${JSON.stringify(signalBase)}; document.getElementById('mobile-room').value=${JSON.stringify(result.roomCode)}; document.getElementById('mobile-connect').requestSubmit();`);
  const receipt = await win.webContents.executeJavaScript(`(async () => {
    const el=id=>document.getElementById(id);
    const wait=async p=>{const until=Date.now()+15000;while(!p()){if(Date.now()>until)throw new Error('Screenshot UI state timed out: '+el('desktop-status').textContent);await new Promise(r=>setTimeout(r,20));}};
    await wait(()=>!el('pairing-approval').hidden); el('allow-peer').click();
    await wait(()=>el('desktop-status').textContent==='P2P 已加密直连'&&el('local-preview').videoWidth===640);
    el('take-region-shot').click(); await wait(()=>el('region-dialog').open);
    if(!el('region-send').disabled)throw new Error('Region can be sent before selection');
    for(const [id,value] of [['region-x',50],['region-y',0],['region-width',50],['region-height',100]])el(id).value=value;
    el('region-width').dispatchEvent(new Event('input'));
    if(el('region-send').disabled)throw new Error('Valid region is disabled');
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    await window.desktopBridge.saveQaSnapshot('region');
    el('region-send').click();
    await wait(()=>el('shot-progress-text').textContent==='手机已确认收到截图');
    if(el('region-preview').width!==0||el('region-dialog').open)throw new Error('Frozen full frame was retained');
    return {regionConfirmed:true,localSnapshotCleared:true};
  })()`);
  const pixels = await phone.webContents.executeJavaScript(`(async()=>{
    const image=document.getElementById('attachment-thumb'); await image.decode();
    if(image.naturalWidth!==320||image.naturalHeight!==360)throw new Error('Crop dimensions are wrong');
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=360;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    for(const [x,y] of [[2,2],[317,2],[2,357],[317,357],[160,180]]){const p=ctx.getImageData(x,y,1,1).data;if(p[1]<150||p[0]>90)throw new Error('Outside red pixels were transmitted');}
    return {onlySelectedPixels:true,cropWidth:320,cropHeight:360};
  })()`);
  const beforeRejected = await phone.webContents.executeJavaScript("document.querySelectorAll('.chat-message').length");
  await win.webContents.executeJavaScript(`(async()=>{
    const original=HTMLCanvasElement.prototype.toDataURL;
    try{
      HTMLCanvasElement.prototype.toDataURL=()=> 'data:image/jpeg;base64,BROKEN';
      document.getElementById('take-shot').click();
      const until=Date.now()+8000;
      while(!document.getElementById('shot-progress-text').textContent.includes('无法显示')){if(Date.now()>until)throw new Error('Bad image was not rejected');await new Promise(r=>setTimeout(r,20));}
    }finally{HTMLCanvasElement.prototype.toDataURL=original;}
  })()`);
  if(await phone.webContents.executeJavaScript("document.querySelectorAll('.chat-message').length")!==beforeRejected)throw new Error('Bad image reached the conversation');
  const sourceSwitch = await win.webContents.executeJavaScript(`(async()=>{
    const el=id=>document.getElementById(id),room=el('room-code').textContent,old=window.uiSmokeTrack,original=navigator.mediaDevices.getDisplayMedia;
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#2244ee';ctx.fillRect(0,0,640,360);
    const replacement=canvas.captureStream(5),track=replacement.getVideoTracks()[0];
    navigator.mediaDevices.getDisplayMedia=async()=>replacement;
    try{
      el('change-share').click();const until=Date.now()+5000;
      while(el('change-share').disabled){if(Date.now()>until)throw new Error('Capture replacement timed out');await new Promise(r=>setTimeout(r,20));}
      if(el('local-preview').srcObject!==replacement||old.readyState!=='ended'||el('room-code').textContent!==room||el('desktop-status').textContent!=='P2P 已加密直连')throw new Error('Switch lost source or room');
      window.uiSmokeTrack=track;
      navigator.mediaDevices.getDisplayMedia=async()=>{throw new DOMException('cancelled','NotAllowedError');};
      el('change-share').click();await new Promise(r=>setTimeout(r,100));
      if(track.readyState!=='live'||el('room-code').textContent!==room||el('change-share').disabled)throw new Error('Cancelled picker ended the session');
      return {sameRoomCaptureSwitch:true,cancelKeepsSharing:true};
    }finally{navigator.mediaDevices.getDisplayMedia=original;}
  })()`);
  await phone.webContents.executeJavaScript(`(async()=>{
    const video=document.getElementById('remote-preview'),until=Date.now()+5000,canvas=document.createElement('canvas');canvas.width=canvas.height=1;
    while(true){canvas.getContext('2d').drawImage(video,0,0,1,1);const p=canvas.getContext('2d').getImageData(0,0,1,1).data;if(p[2]>150&&p[0]<90)break;if(Date.now()>until)throw new Error('Phone did not receive replacement source');await new Promise(r=>setTimeout(r,50));}
    if(document.getElementById('attachment-strip').hidden||document.getElementById('mobile-status').textContent!=='P2P 已加密直连')throw new Error('Switch cleared attachment or disconnected phone');
  })()`);
  await win.webContents.executeJavaScript(`(async()=>{
    const el=id=>document.getElementById(id);el('take-region-shot').click();
    await new Promise(r=>setTimeout(r,50));
    const preview=el('region-preview'),bounds=preview.getBoundingClientRect(),original=preview.setPointerCapture;
    try{
      preview.setPointerCapture=()=>{};
      const input=(name,x,y)=>preview.dispatchEvent(new PointerEvent(name,{clientX:bounds.left+bounds.width*x,clientY:bounds.top+bounds.height*y,button:0,pointerId:1,bubbles:true}));
      input('pointerdown',1,1);input('pointermove',.5,0);input('pointerup',.5,0);
      if(el('region-send').disabled||Math.abs(Number(el('region-width').value)-50)>1)throw new Error('Reverse dragging did not select the right half');
      input('pointerdown',.2,.2);input('pointercancel',.2,.2);
      if(!el('region-send').disabled||!el('region-box').hidden)throw new Error('Cancelled pointer kept an old selection');
    }finally{preview.setPointerCapture=original;}
    el('region-cancel').click();
    await new Promise(r=>setTimeout(r,50));
    if(el('region-dialog').open||el('region-preview').width!==0||el('take-region-shot').disabled)throw new Error('Cancel did not clean up the snapshot');
  })()`);
  const source = { id: 'window:fixture:0', name: '测试窗口 <本地>', thumbnail: nativeImage.createFromBuffer(await captureRendered()) };
  const diagnostic = await win.webContents.executeJavaScript(`(()=>{
    const el=id=>document.getElementById(id);el('llm-key').value='qa-private-api-key';
    const endpoint=el('llm-endpoint').value;el('llm-endpoint').value='https://qa-private-endpoint.example';
    el('show-diagnostics').click();const text=el('diagnostics-text').value,report=JSON.parse(text);
    if(text.includes('qa-private')||text.includes(el('room-code').textContent)||report.localMedia.video!==1||report.phase!=='connected'||report.version!=='${require('../package.json').version}')throw new Error('Diagnostics content is wrong or leaks context');
    el('llm-key').value='';el('llm-endpoint').value=endpoint;el('close-diagnostics').click();
    return {diagnosticsRedacted:true,versionEmbedded:true};
  })()`);
  const selection = showCapturePicker({ parent: win, sources: [source], BrowserWindow, ipcMain, visible: false });
  const picker = BrowserWindow.getAllWindows().find(item => item !== win && item !== phone);
  await new Promise(resolve => picker.webContents.once('did-finish-load', resolve));
  await picker.webContents.executeJavaScript(`(async()=>{const until=Date.now()+5000;while(!document.querySelector('.source img')?.naturalWidth){if(Date.now()>until)throw new Error('Picker thumbnail did not load');await new Promise(r=>setTimeout(r,20));}if(document.querySelector('.source strong').textContent!=='测试窗口 <本地>')throw new Error('Picker name differs');})()`);
  await picker.webContents.capturePage(); await new Promise(resolve => setTimeout(resolve, 150));
  await fs.writeFile(path.join(root, 'release', 'ui-qa', 'capture-picker.png'), (await picker.webContents.capturePage()).toPNG());
  // The click resolves IPC in the main process; the picker then closes itself.
  void picker.webContents.executeJavaScript("document.querySelector('.source').click()").catch(() => {});
  if (await selection !== source) throw new Error('Picker selection did not reach the main process');
  await win.setContentSize(390, 844);
  const mobile = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('take-region-shot').click();
    const until=Date.now()+2000;while(!document.getElementById('region-dialog').open){if(Date.now()>until)throw new Error('Region dialog did not reopen');await new Promise(r=>setTimeout(r,20));}
    document.getElementById('mobile-tab').click();
    window.scrollTo(0,0);
    if (window.uiSmokeTrack.readyState !== 'ended') throw new Error('Role switch kept capture running');
    if (!document.getElementById('pairing-qr').hidden) throw new Error('Stale QR code remained visible');
    if(document.getElementById('region-dialog').open||document.getElementById('region-preview').width!==0)throw new Error('Role switch kept the crop snapshot');
    if (document.getElementById('mobile-view').hidden) throw new Error('Phone view did not open');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (document.documentElement.scrollWidth>window.innerWidth) throw new Error('Phone layout overflows');
    return {captureStopped:true,phoneLayoutFits:true,regionCancelledOnRoleChange:true};
  })()`);
  await fs.writeFile(path.join(root, 'release', 'ui-qa', 'mobile.png'), await captureRendered());
  console.log(JSON.stringify({ ...result, ...receipt, ...pixels, ...diagnostic, ...sourceSwitch, thumbnailPicker:true, regionCancel:true,invalidImageRejected:true, ...mobile }));
  clearTimeout(timeout); phone.destroy(); win.destroy();
  for (const socket of signaling.wss.clients) socket.terminate();
  signaling.wss.close(); signaling.server.close(); ui.close(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
