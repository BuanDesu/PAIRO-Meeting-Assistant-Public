// Local lexical retrieval. No embeddings endpoint or remote classification is required.
const ignored = new Set('the a an is are was were of to in on and or for with this that it how what why please project workflow document 项目 工作 文档 如何 怎么 什么 请问 介绍 一下 我们 你们 这个 那个 可以 需要 进行 一个 的 是 在 和 与 了'.split(' '));
export function terms(text) {
  const result = [];
  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  for (const word of normalized.match(/[a-z0-9][a-z0-9_.-]{1,80}/g) || []) {
    for (const token of [word, ...word.split(/[_.-]/)]) if (token.length >= 2 && !ignored.has(token)) result.push(token);
  }
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= run.length; i++) {
      const token = run.slice(i, i + n); if (!ignored.has(token)) result.push(token);
    }
  }
  return [...new Set(result)].slice(0, 8000);
}
// A discourse marker can introduce any topic. Only an entire, topic-free request
// may inherit all prior hits; a named subtopic must match the earlier evidence.
function followUp(question) {
  const q = question.normalize('NFKC').toLowerCase().trim().replace(/[?!.。！？]+$/u, '').trim();
  if (!q || q.length > 80) return null;
  const zh = q.replace(/^(?:那么|那)[,，\s]*/, '').replace(/^请\s*/, '');
  if (/^(?:(?:这个|那个|它|上述内容|刚才说的)(?:(?:具体)?(?:是)?(?:怎么做|怎么回事|什么意思|有哪些步骤)|的(?:具体)?(?:步骤|流程|做法)(?:是什么|有哪些)?)|(?:继续|再|更)(?:具体)?(?:说说|说明|解释|展开)(?:一下)?(?:吧)?|(?:再|更)具体(?:一点|一些)?|还有(?:什么|别的)?)(?:吗|呢)?$/u.test(zh)) return { generic: true };
  const en = q.replace(/^(?:so|and)[,\s]+/, '').replace(/^please\s+/, '');
  if (/^(?:(?:can|could|would) you )?(?:(?:explain|expand on|elaborate on|tell me more about) (?:it|that|this)(?: in (?:more )?detail)?|how does (?:it|that|this) work|what about (?:it|that|this)|(?:more )?details|(?:go on|continue|elaborate|be more specific))(?: please)?$/.test(en)) return { generic: true };
  // Chinese ranking normally needs multiple overlapping ngrams. Recover a short
  // named subtopic such as “审批” only if it occurs verbatim in a prior hit.
  const subtopic = zh.match(/^(?:(?:它|这个|那个|该项目)的)?([\u3400-\u9fff]{2,8}?)(?:的?(?:具体步骤|步骤|细节|流程|做法)(?:呢|是什么|有哪些)?|(?:如何|怎么)处理(?:呢)?|呢)$/u)?.[1];
  return subtopic && !ignored.has(subtopic) ? { subtopic } : null;
}
export class KnowledgeIndex {
  constructor(documents = []) {
    this.documents = documents; this.postings = new Map();
    documents.forEach((doc, index) => {
      const tokens = terms(doc.source + '\n' + doc.summary + '\n' + doc.text);
      for (const token of tokens) {
        if (!this.postings.has(token)) this.postings.set(token, []);
        this.postings.get(token).push(index);
      }
    });
  }
  rank(question) {
    const query = terms(question).slice(0, 100), scores = new Map(), matched = new Map();
    for (const token of query) {
      const posting = this.postings.get(token); if (!posting) continue;
      const weight = Math.log(1 + (this.documents.length + 0.5) / (posting.length + 0.5));
      for (const id of posting) { scores.set(id, (scores.get(id) || 0) + weight); matched.set(id, [...(matched.get(id) || []), token]); }
    }
    return [...scores].map(([id, score]) => ({ doc: this.documents[id], score, matched: matched.get(id), coverage: matched.get(id).length / Math.max(1, query.length) }))
      .filter(hit => hit.coverage >= 0.18 && (hit.matched.length >= 2 || hit.matched.some(t => /^[a-z0-9_.-]{4,}$/.test(t))))
      .sort((a, b) => b.score - a.score).slice(0, 6);
  }
  search(question, previousQuestion = '') {
    const started = performance.now();
    const follow = followUp(question);
    let hits = follow?.generic ? [] : this.rank(question), inherited = false;
    if (previousQuestion && follow && !hits.length) {
      hits = this.rank(previousQuestion);
      if (follow.subtopic) hits = hits.filter(({ doc }) => [doc.summary, doc.text].some(s => s.normalize('NFKC').includes(follow.subtopic)));
      inherited = hits.length > 0;
    }
    const selected = []; let context = '';
    for (const hit of hits) {
      const part = `[${hit.doc.source} #${hit.doc.id}]\n要点：${hit.doc.summary}\n原文：${hit.doc.text}\n\n`;
      if (context.length + part.length > 14000) break;
      context += part; selected.push(hit);
    }
    return { context, sources: selected.map(h => `${h.doc.source} #${h.doc.id}`.slice(0, 250)),
      route: selected.length ? 'knowledge' : 'direct', inherited: selected.length > 0 && inherited, reason: selected.length ? (inherited ? '追问与上一问题的资料相关' : '问题与本地资料词语匹配') : '未找到足够相关的资料，直接回答',
      matches: selected.map(h => ({ source: h.doc.source, terms: h.matched, coverage: h.coverage })), elapsedMs: performance.now() - started };
  }
}
