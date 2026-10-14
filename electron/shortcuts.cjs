// Transactional global binding: a conflict never silently disables a previous setup.
function createShortcutManager({ globalShortcut, dispatch, defaults, validate }) {
  let bindings = { ...defaults }, enabled = false, active = false, registered = [];
  function bind(next) {
    const accepted = [];
    try {
      for (const [action, accelerator] of Object.entries(next)) {
        if (!globalShortcut.register(accelerator, () => dispatch(action))) throw new Error('快捷键被占用：' + accelerator);
        accepted.push(accelerator);
      }
      registered = accepted;
    } catch (error) { accepted.forEach(key => globalShortcut.unregister(key)); throw error; }
  }
  function clear() { registered.forEach(key => globalShortcut.unregister(key)); registered = []; }
  function update(value) {
    const next = validate(value.bindings ?? bindings);
    const nextEnabled = value.enabled ?? enabled, nextActive = value.active ?? active;
    if (typeof nextEnabled !== 'boolean' || typeof nextActive !== 'boolean') throw new Error('快捷键状态不正确');
    const previous = { bindings, enabled, active };
    clear();
    try { if (nextEnabled && nextActive) bind(next); }
    catch (error) {
      try { if (previous.enabled && previous.active) bind(previous.bindings); }
      catch { enabled = false; throw new Error(error.message + '；旧绑定也无法恢复，请重新启用'); }
      throw error;
    }
    bindings = next; enabled = nextEnabled; active = nextActive;
    return { bindings: { ...bindings }, enabled, active, registered: [...registered] };
  }
  return { update, clear, snapshot: () => ({ bindings: { ...bindings }, enabled, active, registered: [...registered] }) };
}
module.exports = { createShortcutManager };
