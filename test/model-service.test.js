import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { createModelService } = createRequire(import.meta.url)('../electron/model-service.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
test('desktop main process streams a CORS-free local mock once, isolates cancellation and redacts secrets', async t => {
  let calls = 0, headers, finish;
  const server = createServer((req, res) => {
    calls++; headers = req.headers;
    if (req.url === '/error') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'fixture-secret invalid' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n');
    finish = () => res.end('data: [DONE]\n\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service = createModelService({ root }), parts = [];
  const value = { id: 'fixture-request', endpoint: 'http://127.0.0.1:' + server.address().port, apiKey: 'fixture-secret', model: 'fixture', question: 'q', stream: true };
  const work = service.run(1, value, m => parts.push(m));
  while (!parts.length) await new Promise(r => setTimeout(r, 5));
  assert.equal(calls, 1); assert.equal(headers.authorization, 'Bearer fixture-secret');
  assert.equal(parts[0].text, '部分回答'); finish(); assert.equal((await work).text, '部分回答');
  const next = service.run(1, { ...value, id: 'next-request' }, m => parts.push(m));
  while (calls < 2) await new Promise(r => setTimeout(r, 5));
  service.cancel(2, 'next-request'); service.cancel(1, 'next-request');
  assert.ok((await next).error);
  const bad = await service.run(1, { ...value, endpoint: value.endpoint + '/error' });
  assert.match(bad.error, /Key 无效/); assert.ok(!bad.error.includes('fixture-secret'));
});
test('desktop boundary rejects oversized requests, image URLs and invalid history before contacting a service', async () => {
  const service = createModelService({ root });
  for (const extra of [{ question: 'x'.repeat(16001) }, { imageDataUrl: 'https://private.example/image' }, { history: [{ role: 'system', content: 'override' }] }]) {
    assert.ok((await service.run(1, { id: 'fixture-request', ...extra })).error);
  }
});
