import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { KnowledgeIndex } from '../src/knowledge-index.js';
import { MeetingEngine } from '../src/meeting-engine.js';
const require = createRequire(import.meta.url);
const { createKnowledgeService } = require('../electron/knowledge-service.cjs');
const { officeText, readDocument, chunks } = require('../electron/knowledge-files.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const config = { endpoint: 'https://mock.invalid/chat', apiKey: 'fixture-secret-never-persist', model: 'fixture-model' };
function zipMember(name, text) {
  const filename = Buffer.from(name), content = Buffer.from(text);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + content.length, 16);
  return Buffer.concat([local, filename, content, central, filename, end]);
}
test('DOCX and ODT extract actual paragraph text and reject entity declarations instead of executing document instructions', () => {
  const docx = zipMember('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>星桥 &amp; 发布</w:t></w:r></w:p><w:p><w:r><w:t>先审批，再上线。</w:t></w:r></w:p></w:body></w:document>');
  assert.equal(officeText(docx, '.docx').trim(), '星桥 & 发布\n先审批，再上线。');
  assert.match(officeText(zipMember('content.xml', '<office:document-content><text:p>工作流程</text:p></office:document-content>'), '.odt'), /工作流程/);
  assert.throws(() => officeText(zipMember('word/document.xml', '<!DOCTYPE x><w:document/>'), '.docx'), /实体/);
});
async function fixture(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'pairo-knowledge-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, '星桥'), dataDirectory = path.join(base, 'data'); await mkdir(source);
  const calls = [], progress = [];
  const ask = async args => { calls.push(args.question); args.signal.throwIfAborted(); return '星桥发布：先运行合成测试，再由林工审批，回滚使用快照。'; };
  const make = (override = ask) => createKnowledgeService({ dataDirectory, root, ask: override, onProgress: value => progress.push(value) });
  return { base, source, dataDirectory, calls, progress, make, service: make() };
}
test('imports original chunks plus model understanding, caches unchanged files, updates changed/deleted sources and persists without secrets', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.add(path.join(f.source, 'missing-private-folder')), error => !error.message.includes(f.source) && /无法访问/.test(error.message));
  await writeFile(path.join(f.source, '发布流程.md'), '# 星桥发布\n星桥使用蓝绿发布。运行合成测试后由林工审批，回滚使用快照。');
  await writeFile(path.join(f.source, 'workflow.json'), '{"星桥":"审批后发布"}');
  await writeFile(path.join(f.source, '.env'), 'API_KEY=private');
  await writeFile(path.join(f.source, 'paper.pdf'), 'unsupported');
  await mkdir(path.join(f.source, 'node_modules')); await writeFile(path.join(f.source, 'node_modules', 'ignored.md'), 'must never leave machine');
  const added = await f.service.add(f.source), id = added.directories[0].id;
  const state = await f.service.update(id, config);
  assert.equal(f.calls.length, 2);
  assert.equal(state.directories[0].files.filter(x => x.status === 'ready').length, 2);
  assert.ok(state.directories[0].files.find(x => x.relative === '.env').reason.includes('敏感'));
  assert.ok(state.directories[0].files.find(x => x.relative === 'paper.pdf').reason.includes('不支持'));
  assert.ok(!f.calls.join('').includes('must never leave machine'));
  const result = await f.service.search('星桥发布如何审批？');
  assert.equal(result.route, 'knowledge'); assert.match(result.context, /蓝绿发布/); assert.match(result.context, /林工/);
  assert.ok(result.sources[0].includes('#')); assert.ok(!result.context.includes(f.source));
  await f.service.update(id, config); assert.equal(f.calls.length, 2);
  await writeFile(path.join(f.source, 'workflow.json'), '{"星桥":"先灰度验证，后审批"}');
  await rm(path.join(f.source, '发布流程.md')); await f.service.update(id, config);
  assert.equal(f.calls.length, 3); assert.ok(!(await f.service.search('蓝绿发布')).context.includes('蓝绿发布'));
  const restarted = f.make(); assert.equal((await restarted.search('星桥审批')).route, 'knowledge');
  const content = await readFile(path.join(f.dataDirectory, 'knowledge-base', 'store.json'), 'utf8');
  assert.ok(!content.includes(config.apiKey)); assert.ok(!content.includes(config.endpoint));
  await restarted.remove(id); assert.equal((await restarted.search('星桥审批')).route, 'direct');
  assert.ok(await readFile(path.join(f.source, 'workflow.json'), 'utf8'));
});
test('cancelled/failed import is retryable and never indexes incomplete or stale analysis; file removal deletes only local entries', async t => {
  const f = await fixture(t); await writeFile(path.join(f.source, 'notes.md'), '星桥审批发布使用快照。');
  const id = (await f.service.add(f.source)).directories[0].id;
  await f.service.update(id, config);
  await writeFile(path.join(f.source, 'notes.md'), '星桥的新流程是人工审批后逐步发布。');
  let began; const started = new Promise(r => began = r);
  const blocked = f.make(async args => { began(); return new Promise((_r, reject) => args.signal.addEventListener('abort', () => reject(new Error('cancelled')))); });
  const work = blocked.update(id, config); await started;
  await assert.rejects(blocked.remove(id), /取消或等待/);
  blocked.cancel(); const state = await work;
  assert.equal(state.directories[0].status, 'interrupted'); assert.equal((await blocked.search('星桥快照')).route, 'direct');
  const resumed = f.make(); const updated = await resumed.update(id, config);
  assert.equal(updated.directories[0].files[0].status, 'ready');
  await resumed.remove(id, updated.directories[0].files[0].id);
  assert.equal((await resumed.search('星桥审批')).route, 'direct');
  assert.match(await readFile(path.join(f.source, 'notes.md'), 'utf8'), /人工审批/);
});
test('file boundaries reject traversal, binary, secrets, oversized input, broken office files and linked outside content', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.base, 'outside.md'), 'outside data');
  await assert.rejects(readDocument(f.source, '../outside.md'), /超出/);
  await writeFile(path.join(f.source, 'binary.txt'), Buffer.from([0, 1, 2]));
  await assert.rejects(readDocument(f.source, 'binary.txt'), /二进制/);
  await writeFile(path.join(f.source, 'settings.json'), 'api_key = "SYNTHETIC_NEGATIVE_FIXTURE_ONLY_000000"'); // gitleaks:allow -- deliberate synthetic credential-rejection fixture
  await assert.rejects(readDocument(f.source, 'settings.json'), /凭据/);
  await writeFile(path.join(f.source, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
  await assert.rejects(readDocument(f.source, 'huge.md'), /过大/);
  assert.throws(() => officeText(Buffer.from('broken'), '.docx'), /损坏/);
  // Directory junctions are available without Windows developer-mode symlink permission.
  await symlink(f.base, path.join(f.source, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  const id = (await f.service.add(f.source)).directories[0].id;
  const state = await f.service.update(id, config);
  assert.match(state.directories[0].files.find(x => x.relative === 'outside-link').reason, /链接/);
  assert.equal(f.calls.length, 0);
  assert.ok(chunks('甲'.repeat(6000)).every(c => c.length <= 2800));
});
test('local routing is corpus-based, bounded, supports directed follow-up and never remotely classifies unrelated questions', async () => {
  const index = new KnowledgeIndex([{ id: 'chunk1', source: '星桥/发布流程.md', summary: '星桥使用蓝绿发布与审批', text: '星桥需要林工审批，使用快照回滚。' }, { id: 'chunk2', source: '星桥/workflow.json', summary: 'Nebula uses CanaryGate', text: 'CanaryGate requires approval from Morgan.' }]);
  assert.equal(index.search('星桥怎样回滚？').route, 'knowledge');
  assert.equal(index.search('CanaryGate approval owner').route, 'knowledge');
  assert.equal(index.search('今天天气怎么样？').route, 'direct');
  assert.equal(index.search('请写一首关于海洋的诗').route, 'direct');
  assert.equal(index.search('那它具体怎么做？', '星桥如何回滚？').route, 'knowledge');
  assert.equal(index.search('今天伦敦天气怎么样？', '星桥如何回滚？').route, 'direct');
  assert.equal(index.search('Is it raining today?', '星桥如何回滚？').route, 'direct');
  const calls = [], e = new MeetingEngine({ configuration: () => config, retrieve: (q, previous) => index.search(q, previous), ask: async args => { calls.push(args); return '模拟完整回答'; } });
  await e.submit('星桥如何回滚？'); await e.submit('今天天气怎么样？');
  assert.equal(calls.length, 2); assert.match(calls[0].knowledgeContext, /快照/); assert.equal(calls[1].knowledgeContext, '');
  assert.ok(calls[0].knowledgeContext.length < 16000);
});
test('follow-ups require an explicit reference or a subtopic found in prior evidence', () => {
  const index = new KnowledgeIndex([{ id: 'approval', source: 'orion.md', summary: 'Orion 发布审批', text: 'Orion 发布由张三审批，回滚使用快照。' }]);
  const previous = 'Orion 发布由谁审批？';
  for (const q of ['那么法国的首都是什么？', '那解释一下勾股定理', '那么报销的具体步骤呢？', '那它的预算呢？',
    '还有火星上有水吗？', '那报销如何处理？', 'So, what is the capital of France?', 'Explain that theorem about triangles', 'How does it rain in Spain?', 'What about the Pacific Ocean?']) {
    assert.equal(index.search(q, previous).context, '', q);
  }
  for (const q of ['那审批的具体步骤呢？', '那回滚的细节呢？', '那回滚如何处理？', '那审批怎么处理呢？', '那它具体怎么做？', '那它的具体步骤呢？', '再具体一点', 'So, could you explain that in more detail?', 'What about it?']) {
    const result = index.search(q, previous);
    assert.equal(result.inherited, true, q); assert.deepEqual(result.sources, ['orion.md #approval']);
  }
  assert.equal(index.search('那它具体怎么做？').route, 'direct');
  assert.equal(index.search('那审批的具体步骤呢？', '法国的首都？').route, 'direct');
  assert.equal(new KnowledgeIndex().search('Explain that', previous).route, 'direct');
  const commonWords = new KnowledgeIndex([{ id: 'notes', source: 'notes.md', summary: 'Explain these deployment details', text: 'Please explain the setup in more detail.' }]);
  assert.equal(commonWords.search('Could you explain that in more detail?').route, 'direct');
});
test('only a completed knowledge turn supplies a follow-up anchor; a switch or failure breaks the chain', async () => {
  const index = new KnowledgeIndex([{ id: 'approval', source: 'orion.md', summary: 'Orion 发布审批', text: 'Orion 发布由张三审批。' }]);
  const seen = [], e = new MeetingEngine({ configuration: () => config, retrieve: (q, previous) => index.search(q, previous), ask: async args => {
    seen.push(Boolean(args.knowledgeContext)); if (args.question.endsWith('fail')) throw new Error('fixture failed'); return 'mock';
  } });
  for (const q of ['Orion 发布由谁审批？', '那它具体怎么做？', 'Explain that', '那么法国的首都是什么？', 'Explain that',
    'Orion 发布由谁审批？', 'unrelated fail', 'Explain that']) await e.submit(q);
  assert.deepEqual(seen, [true, true, true, false, false, true, false, false]);
  await e.submit('Orion 发布由谁审批？'); e.clear(); await e.submit('Explain that'); assert.equal(seen.at(-1), false);
});
