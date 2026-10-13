const grid = document.getElementById('sources'), status = document.getElementById('status');
const cancel = () => window.capturePicker.choose(null);
document.getElementById('cancel').addEventListener('click', cancel);
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
window.capturePicker.list().then(sources => {
  status.textContent = '点击预览以共享；关闭此窗口也会取消。';
  for (const source of sources) {
    const button = document.createElement('button'); button.className = 'source'; button.type = 'button';
    const image = document.createElement('img'); image.src = source.thumbnail; image.alt = source.name + '预览';
    const name = document.createElement('strong'); name.textContent = source.name;
    const kind = document.createElement('span'); kind.textContent = source.kind === 'screen' ? '整个屏幕' : '单个窗口';
    button.append(image, name, kind);
    button.addEventListener('click', async () => {
      grid.querySelectorAll('button').forEach(node => { node.disabled = true; });
      try { await window.capturePicker.choose(source.id); }
      catch { status.textContent = '此画面已不可用，请取消后重新选择。'; document.getElementById('cancel').disabled = false; }
    });
    grid.append(button);
  }
}).catch(() => { status.textContent = '无法加载预览，请取消后重新选择。'; });
