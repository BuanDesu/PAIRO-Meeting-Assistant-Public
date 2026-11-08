const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const extensions = new Set('.txt .md .mdx .rst .csv .tsv .json .jsonc .yaml .yml .toml .ini .xml .html .htm .css .scss .js .mjs .cjs .ts .tsx .jsx .vue .svelte .py .java .kt .c .h .cpp .cs .go .rs .rb .php .sql .sh .ps1 .bat .mermaid .feature .docx .odt'.split(' '));
const excluded = new Set('.git node_modules vendor dist build release target bin obj coverage .next .nuxt .venv venv __pycache__ .cache .idea .vscode .aws .ssh .codex .agents PAIRO-data'.toLowerCase().split(' '));
const sensitive = name => /^(\.env(?:\..*)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc)$/i.test(name) || /(?:credential|secret|private.?key|access.?token|api.?key|auth\.json)/i.test(name) || /\.(pem|key|p12|pfx|jks|keystore|log|sqlite|db)$/i.test(name);
const within = (root, target) => { const relative = path.relative(root, target); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const decodeXml = text => text.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<\/(?:w:p|text:p|text:h)>/g, '\n').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[entity]));
function officeText(buffer, extension) {
  // Read a single ZIP member in memory. Never materialize archive paths or run macros.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('文档损坏或不是有效的 Office 文件');
  const count = buffer.readUInt16LE(end + 10); let offset = buffer.readUInt32LE(end + 16);
  if (count > 5000) throw new Error('压缩文档条目过多');
  const wanted = extension === '.docx' ? 'word/document.xml' : 'content.xml';
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('压缩文档目录损坏');
    const flags = buffer.readUInt16LE(offset + 8), method = buffer.readUInt16LE(offset + 10), compressed = buffer.readUInt32LE(offset + 20), size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28), extra = buffer.readUInt16LE(offset + 30), comment = buffer.readUInt16LE(offset + 32), local = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extra + comment;
    if (name !== wanted) continue;
    if (flags & 1 || ![0, 8].includes(method) || size > 4 * 1024 * 1024 || size > Math.max(1, compressed) * 200) throw new Error('加密或过大的压缩文档不支持');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('压缩文档内容损坏');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) throw new Error('压缩文档内容不完整');
    const data = buffer.subarray(start, start + compressed);
    const xml = (method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 }) : data).toString('utf8');
    if (/<!(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('不支持含外部实体的文档');
    if (!(extension === '.docx' ? /<w:document\b/.test(xml) : /<office:document-content\b/.test(xml))) throw new Error('文档正文损坏或格式不受支持');
    return decodeXml(xml);
  }
  throw new Error('文档中没有可读取的正文');
}
async function readDocument(root, relative) {
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error('文件超出已选择目录');
  const real = await fs.realpath(target), stat = await fs.lstat(target);
  if (!within(root, real) || stat.isSymbolicLink() || !stat.isFile()) throw new Error('已跳过链接或越界文件');
  const extension = path.extname(relative).toLowerCase();
  if (!extensions.has(extension)) throw new Error('暂不支持此格式，请导出为 TXT、Markdown 或 DOCX');
  if (stat.size > (['.docx', '.odt'].includes(extension) ? 4 : 1) * 1024 * 1024) throw new Error('文件过大（文本上限 1 MB，DOCX/ODT 上限 4 MB）');
  const handle = await fs.open(real, 'r'); let bytes;
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.size !== stat.size) throw new Error('文件发生变化，请重试');
    // Bounded read even if a file grows after stat.
    bytes = Buffer.alloc(stat.size + 1); const result = await handle.read(bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, result.bytesRead);
    if (bytes.length !== stat.size || !within(root, await fs.realpath(target))) throw new Error('文件发生变化，请重试');
  } finally { await handle.close(); }
  let text;
  if (['.docx', '.odt'].includes(extension)) text = officeText(bytes, extension);
  else {
    if (bytes.includes(0)) throw new Error('二进制或 UTF-16 文件，请另存为 UTF-8');
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('无法读取编码，请另存为 UTF-8'); }
    if (['.html', '.htm', '.xml'].includes(extension)) text = decodeXml(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ''));
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('没有可读取的文字');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*["'][a-zA-Z0-9_\/-]{16,}/i.test(text)) throw new Error('疑似包含凭据，已跳过；请移除敏感内容后再导入');
  if (text.length > 120000) throw new Error('文字超过 12 万字，请拆分文件后导入');
  return { text, hash: hash(bytes), size: stat.size, modified: stat.mtimeMs };
}
async function scan(root, signal) {
  const files = []; let visited = 0;
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (++visited > 12000 || files.length >= 600) throw new Error('目录内容过多，请选择更具体的子目录（最多 600 个文件）');
      const target = path.join(directory, entry.name), relative = path.relative(root, target);
      if (entry.isSymbolicLink()) { files.push({ relative, skip: '链接文件或目录不导入' }); continue; }
      if (sensitive(entry.name)) { files.push({ relative, skip: '凭据或敏感文件不导入' }); continue; }
      if (entry.isDirectory()) { if (!excluded.has(entry.name.toLowerCase()) && within(root, await fs.realpath(target))) await walk(target); }
      else if (entry.isFile()) files.push({ relative, ...(!extensions.has(path.extname(entry.name).toLowerCase()) ? { skip: '暂不支持此格式，请导出为 TXT、Markdown 或 DOCX' } : {}) });
    }
  }
  await walk(root); return files;
}
function chunks(text, size = 2800, overlap = 250) {
  const result = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) { const line = text.lastIndexOf('\n', end); if (line > start + size / 2) end = line; }
    result.push(text.slice(start, end)); if (end === text.length) break; start = end - overlap;
  }
  return result;
}
module.exports = { scan, readDocument, chunks, hash, within, officeText };
