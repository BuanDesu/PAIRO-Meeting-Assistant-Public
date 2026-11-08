// Upstream release/model revisions and LFS SHA-256, all MIT. Keep older assets
// by filename so changing quality never removes a working offline model.
const ENGINE = Object.freeze({ url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip', size: 3968674, sha256: 'd824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d' });
const MODEL_REVISION = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/';
function asset(file, size, sha256, source = MODEL_REVISION) { return Object.freeze({ file, size, sha256, url: source + file }); }
const VAD = asset('ggml-silero-v6.2.0.bin', 885098, '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/');
const MODELS = Object.freeze({
  quality: asset('ggml-small-q5_1.bin', 190085487, 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'),
  balanced: asset('ggml-base-q5_1.bin', 59707625, '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'),
  light: asset('ggml-tiny.bin', 77691713, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'),
});
const DEFAULT_SPEECH = Object.freeze({ profile: 'balanced', language: 'auto' });
function validateSpeech(value) {
  if (!value || !Object.hasOwn(MODELS, value.profile) || !['auto', 'zh', 'en'].includes(value.language)) throw new Error('离线语音设置不正确');
  return { profile: value.profile, language: value.language };
}
module.exports = { ENGINE, VAD, MODELS, DEFAULT_SPEECH, validateSpeech };
