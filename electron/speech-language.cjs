// Evidence is local to one capture source and one listening session. Only long
// accepted results establish a hint. Longer and mixed utterances still use auto.
function createLanguageHints(now = Date.now) {
  const hints = new Map();
  return {
    clear() { hints.clear(); },
    select(source, requested, seconds) {
      const hint = hints.get(source);
      return requested === 'auto' && seconds <= 1.2 && hint?.count >= 2 && now() - hint.at < 90000 ? hint.language : requested;
    },
    observe(source, json, decoded, seconds) {
      if (!decoded.text || seconds < 2) return;
      const text = decoded.text;
      const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
      const letters = (text.match(/[a-z]/gi) || []).length;
      const language = json.result?.language;
      if (!(language === 'zh' && han >= 8 || language === 'en' && han === 0 && letters >= 20)) { hints.delete(source); return; }
      const previous = hints.get(source);
      const count = previous?.language === language && now() - previous.at < 90000 ? previous.count + 1 : 1;
      hints.set(source, { language, count, at: now() });
    },
  };
}
module.exports = { createLanguageHints };
