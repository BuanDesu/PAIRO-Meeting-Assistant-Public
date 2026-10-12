const { app, BrowserWindow, session } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const { isTrustedUiUrl, mediaPermissionKind } = require('../electron/security.cjs');
let win, ui, signaling;
const timeout = setTimeout(() => { console.error('Desktop smoke timed out'); app.exit(1); }, 25000);
app.disableHardwareAcceleration();
// Deterministic same-machine test: avoid dependence on multicast DNS resolution.
// The production application retains Chromium's normal candidate privacy behavior.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
app.commandLine.appendSwitch('allow-loopback-in-peer-connection');

app.whenReady().then(async () => {
  ui = createServer(async (request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<html><body>PAIRO smoke</body></html>'); return; }
    if (!['/src/peer-session.js', '/src/data-channel.js'].includes(request.url)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', 'text/javascript');
    response.end(await fs.readFile(path.join(root, request.url.slice(1))));
  });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + ui.address().port;
  win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadURL(origin);
  const source = await fs.readFile(path.join(root, 'electron/main.cjs'), 'utf8');
  let displayHandlerCalls = 0;
  // Run the production permission handler; display source enumeration is stubbed
  // to return nothing, so this test never captures a real screen or microphone.
  const fragment = source.slice(source.indexOf('function configureMediaPermissions()'), source.indexOf('function registerShortcuts()'));
  vm.runInNewContext(fragment + '\nconfigureMediaPermissions(); configureDisplayCapture();', {
    session: { defaultSession: {
      setPermissionRequestHandler: handler => session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        return handler(contents, permission, callback, details);
      }),
      setDisplayMediaRequestHandler: (handler, options) => session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        displayHandlerCalls++; return handler(request, callback);
      }, options),
    } },
    mainWindow: win, mediaPermissionKind, console,
    trustedContents: (contents, details = {}) => contents === win.webContents && details.isMainFrame !== false
      && isTrustedUiUrl(details.requestingUrl || details.securityOrigin || contents.getURL(), origin),
    isTrustedUiUrl, uiOrigin: () => origin,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    desktopCapturer: { getSources: async () => [] },
  });
  const captureResult = await win.webContents.executeJavaScript("navigator.mediaDevices.getDisplayMedia({video:true,audio:false}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'unexpected capture';}).catch(e=>e.name)", true);
  console.log('Display permission reached picker:', displayHandlerCalls === 1);
  if (displayHandlerCalls !== 1 || captureResult === 'unexpected capture') throw new Error('Display permission gate did not reach the source picker: ' + captureResult);
  if (process.argv.includes('--permissions-only')) {
    clearTimeout(timeout);
    win.destroy(); ui.close(); app.exit(0);
    return;
  }

  // Compare with the native API without any application signaling or transport.
  // A failed reference connection makes an environment issue distinguishable
  // from regressions in PeerSession; it never turns a failed test into a pass.
  const reference = await win.webContents.executeJavaScript(`(async () => {
    const a = new RTCPeerConnection({iceServers:[]}), b = new RTCPeerConnection({iceServers:[]});
    const pendingA = [], pendingB = [];
    a.onicecandidate = e => { if(e.candidate) { if(b.remoteDescription) b.addIceCandidate(e.candidate); else pendingB.push(e.candidate); } };
    b.onicecandidate = e => { if(e.candidate) { if(a.remoteDescription) a.addIceCandidate(e.candidate); else pendingA.push(e.candidate); } };
    const channel = a.createDataChannel('reference');
    try {
      await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
      for(const candidate of pendingB) await b.addIceCandidate(candidate);
      await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
      for(const candidate of pendingA) await a.addIceCandidate(candidate);
      const until = Date.now()+6000;
      while(channel.readyState!=='open' && Date.now()<until) await new Promise(resolve=>setTimeout(resolve,20));
      return {connected:channel.readyState==='open',iceA:a.iceConnectionState,iceB:b.iceConnectionState};
    } finally {a.close();b.close();}
  })()`);
  console.log('Native RTC reference:', JSON.stringify(reference));

  const { createSignalingServer } = await import(pathToFileURL(path.join(root, 'server/signaling.js')).href);
  signaling = createSignalingServer({ allowedOrigins: origin, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  await new Promise(resolve => signaling.server.listen(0, '127.0.0.1', resolve));
  const signalBase = 'http://127.0.0.1:' + signaling.server.address().port;
  const result = await win.webContents.executeJavaScript(`(async () => {
    const { PeerSession } = await import('/src/peer-session.js');
    const received = [], statuses = [];
    const desktop = new PeerSession({role:'desktop',onStatus:value=>statuses.push(value)});
    const phone = new PeerSession({role:'mobile',onMessage:value=>received.push(value),onStatus:value=>statuses.push(value)});
    const wait = async predicate => {
      const until=Date.now()+12000;
      while(!predicate()) { if(Date.now()>until) {
        const summarize = async peer => {
          const stats = peer.pc ? [...(await peer.pc.getStats()).values()] : [];
          return {ice:peer.pc?.iceConnectionState,dtls:peer.pc?.sctp?.transport?.state,
            candidates:stats.filter(s=>s.type==='local-candidate'||s.type==='remote-candidate').map(s=>({type:s.type,address:s.address,port:s.port,protocol:s.protocol})),
            pairs:stats.filter(s=>s.type==='candidate-pair').map(s=>({state:s.state,nominated:s.nominated,requestsSent:s.requestsSent,responsesReceived:s.responsesReceived}))};
        };
        throw new Error('RTC timeout: '+JSON.stringify({desktop:await summarize(desktop),phone:await summarize(phone),offerMatches:desktop.pc?.localDescription?.sdp===phone.pc?.remoteDescription?.sdp,answerMatches:phone.pc?.localDescription?.sdp===desktop.pc?.remoteDescription?.sdp,statuses}));
      } await new Promise(resolve=>setTimeout(resolve,20)); }
    };
    try {
      desktop.setLocalStream(new MediaStream());
      await desktop.connect(${JSON.stringify(signalBase)},'SMOKE234');
      await phone.connect(${JSON.stringify(signalBase)},'SMOKE234');
      await wait(()=>desktop.channel?.readyState==='open'&&phone.channel?.readyState==='open');
      const image='data:image/jpeg;base64,'+'A'.repeat(900000);
      await desktop.send({type:'screenshot',image});
      await wait(()=>received.length===1);
      if(received[0].image!==image) throw new Error('Screenshot content mismatch');
      const maximum=desktop.pc.sctp.maxMessageSize;
      desktop.disconnect();
      await wait(()=>phone.pc===null);
      return {negotiatedMaxMessageSize:maximum,screenshotBytes:image.length,peerDepartureCleaned:true};
    } finally {desktop.disconnect();phone.disconnect();}
  })()`, true);
  console.log(JSON.stringify({ electron: process.versions.electron, displayPermissionReachedPicker: true, ...result }));
  clearTimeout(timeout);
  win.destroy();
  signaling.wss.close(); signaling.server.close(); ui.close();
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
