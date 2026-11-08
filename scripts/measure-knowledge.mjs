// Deterministic local mock measurement, not a claim about real model performance.
import { createServer } from 'node:http';
import { writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { KnowledgeIndex } from '../src/knowledge-index.js';
import { askModel } from '../src/llm.js';
const index = new KnowledgeIndex(Array.from({ length: 1000 }, (_, i) => ({ id: 'chunk-' + i, source: `project${i}/workflow.md`, summary: `Orion${i} rollout approvals`, text: `Orion${i} uses CanaryGate${i}. Morgan${i} approves rollout. Snapshot${i} restores the service.` })));
const { values: { output } } = parseArgs({ options: { output: { type: 'string' } } });
const measurementRoot = resolve('release/knowledge-measurements');
if (!output) await mkdir(measurementRoot, { recursive: true });
const outputFile = output ? resolve(output) : join(await mkdtemp(join(measurementRoot, 'run-')), 'latency.json');
let calls = 0;
const server = createServer((_req, res) => {
  calls++; res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  setTimeout(() => { res.write('data: {"choices":[{"delta":{"content":"模拟首段"}}]}\n\n'); setTimeout(() => res.end('data: [DONE]\n\n'), 5); }, 15);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const anchor = 'Who approves Orion321 rollout?';
const cases = [
  ['related', anchor, '', true],
  ['unrelated', 'What is the capital of France?', '', false],
  ['explicitFollowUp', 'So, could you explain that in more detail?', anchor, true],
  ['topicSwitch', '那么法国的首都是什么？', anchor, false],
];
const samples = Object.fromEntries(cases.map(([kind]) => [kind, []]));
const warmupRounds = 1, rounds = 21;
try {
  for (let round = 0; round < rounds; round++) for (const [kind, q, previous, expected] of cases) {
    const start = performance.now(), result = index.search(q, previous), routed = performance.now(); let first;
    if (expected !== Boolean(result.context) || (expected && !result.sources[0]?.startsWith('project321/'))) throw new Error('Unexpected benchmark routing: ' + kind);
    await askModel({ endpoint: 'http://127.0.0.1:' + server.address().port, apiKey: 'synthetic-benchmark', model: 'mock', question: q, knowledgeContext: result.context, onPartial: () => { first ??= performance.now(); } });
    if (round >= warmupRounds) samples[kind].push({ retrievalMs: routed - start, firstTextMs: first - start });
  }
} finally { server.closeAllConnections(); server.close(); }
const percentile = (values, ratio) => values.sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * ratio))];
const summary = Object.fromEntries(Object.entries(samples).map(([key, rows]) => [key, {
  count: rows.length, retrievalMedianMs: percentile(rows.map(r => r.retrievalMs), 0.5), retrievalP95Ms: percentile(rows.map(r => r.retrievalMs), 0.95),
  firstTextMedianMs: percentile(rows.map(r => r.firstTextMs), 0.5), firstTextP95Ms: percentile(rows.map(r => r.firstTextMs), 0.95),
}]));
const questions = rounds * cases.length;
if (calls !== questions) throw new Error('Each question must make exactly one model request');
const report = { node: process.version, chunks: 1000, mockFirstChunkDelayMs: 15, warmupQuestions: warmupRounds * cases.length, calls, questions, remoteClassifierCalls: 0, excludes: 'real provider, internet, UI paint, P2P snapshot coalescing (70 ms)', ...summary };
await mkdir(dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log('Measurement:', outputFile);
console.log(JSON.stringify(report));
