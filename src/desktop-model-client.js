export async function desktopCompletion(bridge, options) {
  const { signal, onPartial, ...params } = options;
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  const remove = bridge.onModelPartial(message => { if (message.id === id && !signal?.aborted) onPartial?.(message.text); });
  const abort = () => { void bridge.cancelModel(id); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await bridge.runModel({ id, ...params, stream: Boolean(onPartial) });
    signal?.throwIfAborted();
    if (result.error) throw new Error(result.error);
    return result.text;
  } finally { remove(); signal?.removeEventListener('abort', abort); }
}
