export const DEFAULT_SHORTCUTS = Object.freeze({ screenshot: 'num1', voice: 'num2', text: 'num3', 'scroll-up': 'Up', 'scroll-down': 'Down' });

export function validateShortcuts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('快捷键配置格式不正确');
  const result = {}, seen = new Set();
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
    const accelerator = String(value[action] || '').trim();
    // Deliberately narrow the supported grammar; never pass arbitrary IPC strings to native APIs.
    if (!/^(?:(?:Control|Ctrl|Alt|Shift|Super|CommandOrControl)\+)*(?:num[0-9]|[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Space|Home|End|PageUp|PageDown)$/i.test(accelerator) || accelerator.length > 80) throw new Error('不支持的快捷键：' + accelerator.slice(0, 80));
    const parts = accelerator.toLowerCase().replace(/commandorcontrol|ctrl/g, 'control').split('+');
    const key = parts.pop(), modifiers = [...new Set(parts)].sort();
    if (parts.length !== modifiers.length) throw new Error('快捷键不能重复修饰键');
    const identity = [...modifiers, key].join('+');
    if (seen.has(identity)) throw new Error('多个功能不能使用相同的快捷键');
    seen.add(identity); result[action] = accelerator;
  }
  return result;
}

export function shortcutForEvent(event, bindings) {
  const key = /^Numpad\d$/.test(event.code) ? 'num' + event.code.slice(-1)
    : ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', ' ': 'space' }[event.key] || event.key?.toLowerCase());
  for (const [action, accelerator] of Object.entries(bindings)) {
    const parts = accelerator.toLowerCase().replace(/commandorcontrol|ctrl/g, 'control').split('+');
    if (parts.pop() === key && Boolean(event.ctrlKey) === parts.includes('control') && Boolean(event.altKey) === parts.includes('alt') && Boolean(event.shiftKey) === parts.includes('shift') && Boolean(event.metaKey) === parts.includes('super')) return action;
  }
  return null;
}
