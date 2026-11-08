const toSimplified = require('opencc-js/t2cn').Converter({ from: 't', to: 'cn' });
const empty = reason => ({ text: '', reason });

// The pinned VAD utility prints positions in centiseconds, despite the decimal
// formatting. Validate the summary so a broken tool cannot silently pass audio.
function vadSpans(output, samples) {
  const count = Number(output.match(/^Detected (\d+) speech segments:\s*$/m)?.[1]);
  const spans = [...output.matchAll(/^Speech segment \d+: start = (\d+(?:\.\d+)?), end = (\d+(?:\.\d+)?)\s*$/gm)]
    .map(([, start, end]) => [Math.min(samples, Math.round(Number(start) * 160)), Math.min(samples, Math.round(Number(end) * 160))]);
  if (count !== spans.length || spans.some(([start, end], i) => end <= start || (i && start < spans[i - 1][0]))) throw new Error('本机人声检测返回异常，请检查离线组件');
  return spans;
}

function trimVoice(wav, spans) {
  const source = wav.subarray(44), samples = source.length / 2;
  // Preserve the gap between speech spans; concatenating them removes real
  // intra-sentence pauses. Extra headroom protects soft first/last consonants.
  const start = Math.max(0, spans[0][0] - 1600), end = Math.min(samples, spans.at(-1)[1] + 1600);
  const result = Buffer.from(source.subarray(start * 2, end * 2));
  let energy = 0, peak = 0, count = 0;
  for (const [from, to] of spans) for (let i = from; i < to; i++) { const x = source.readInt16LE(i * 2); energy += x * x; count++; }
  for (let i = 0; i < result.length; i += 2) peak = Math.max(peak, Math.abs(result.readInt16LE(i)));
  const rms = Math.sqrt(energy / Math.max(1, count));
  const gain = Math.min(3, 820 / Math.max(1, rms), 31000 / Math.max(1, peak));
  if (gain > 1) for (let i = 0; i < result.length; i += 2) result.writeInt16LE(Math.round(result.readInt16LE(i) * gain), i);
  return result;
}

function repetitive(text) {
  const units = text.toLowerCase().match(/[\u3400-\u9fff]|[^\W_]+/gu) || [];
  // Require a sustained loop, not repeated confirmations or very short answers.
  for (let size = 1; size <= 12 && size * 4 <= units.length; size++) {
    let run = size;
    for (let i = size; i < units.length; i++) {
      run = units[i] === units[i - size] ? run + 1 : size;
      if (run >= Math.max(size * 4, 8, Math.ceil(units.length * 0.8))) return true;
    }
  }
  return false;
}

function decodeResult(json) {
  if (!Array.isArray(json?.transcription)) return empty('uncertain');
  const parts = json.transcription.filter(s => typeof s?.text === 'string' && s.text.trim());
  const text = toSimplified(parts.map(s => s.text.trim()).join(' ')).slice(0, 12000);
  // Whisper can emit only a non-spoken caption, even when the VAD and token
  // probabilities agree. Reject annotation-only output by structure, without
  // stripping words from spoken text or maintaining a caption vocabulary.
  const annotationOnly = /^(?:\s*(?:\[[^\[\]\r\n]{1,80}\]|\([^()\r\n]{1,80}\)|♪[^♪\r\n]{0,80}♪)\s*)+$/u.test(text.normalize('NFKC'));
  if (!/[\p{L}\p{N}]/u.test(text) || annotationOnly || repetitive(text)) return empty('uncertain');
  // v1.8.3 full JSON provides token p, not calibrated utterance confidence.
  // Exclude control/timestamp tokens (multilingual EOT and above) and whitespace.
  const tokens = parts.flatMap(s => Array.isArray(s.tokens) ? s.tokens : []).filter(t =>
    Number.isInteger(t?.id) && t.id >= 0 && t.id < 50257 && typeof t.text === 'string' && t.text.trim() && Number.isFinite(t.p) && t.p >= 0 && t.p <= 1);
  const score = Math.exp(tokens.reduce((n, t) => n + Math.log(Math.max(1e-5, t.p)), 0) / Math.max(1, tokens.length));
  if (!tokens.length || score < 0.20) return empty('uncertain');
  return { text, reason: 'ok' };
}
module.exports = { vadSpans, trimVoice, decodeResult, empty };
