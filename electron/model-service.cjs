const path = require('node:path');
const { pathToFileURL } = require('node:url');
function createModelService({ root, fetchImpl = globalThis.fetch } = {}) {
  const jobs = new Map();
  return {
    async run(owner, value, partial = () => {}) {
      let controller;
      try {
        if (!value || !/^[a-zA-Z0-9-]{8,64}$/.test(value.id) || jobs.has(value.id) || jobs.size >= 3) throw new Error('模型服务繁忙，请稍后重试');
        for (const [key, max] of [['endpoint', 2000], ['apiKey', 4000], ['model', 200], ['question', 16000], ['knowledgeContext', 16000]]) {
          if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > max)) throw new Error('模型请求内容超出限制');
        }
        if (value.imageDataUrl && (typeof value.imageDataUrl !== 'string' || value.imageDataUrl.length > 3 * 1024 * 1024 || !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(value.imageDataUrl))) throw new Error('截图格式不正确');
        const history = value.history || [];
        if (!Array.isArray(history) || history.length > 8 || history.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 24000)) throw new Error('会话内容超出限制');
        controller = new AbortController(); jobs.set(value.id, { owner, controller });
        const { askModel } = await import(pathToFileURL(path.join(root, 'src/llm.js')).href);
        const text = await askModel({ endpoint: value.endpoint, apiKey: value.apiKey, model: value.model,
          question: value.question, imageDataUrl: value.imageDataUrl, history, knowledgeContext: value.knowledgeContext,
          signal: controller.signal, onPartial: value.stream ? text => partial({ id: value.id, text }) : undefined,
          // The main-process fetch has no renderer CORS restrictions. Redirects never forward credentials.
          fetchImpl });
        return { text };
      } catch (error) {
        const secret = typeof value?.apiKey === 'string' ? value.apiKey : '';
        const message = String(error.message || '模型请求失败');
        return { error: (secret ? message.split(secret).join('[已隐藏]') : message).slice(0, 1000) };
      } finally { if (controller) jobs.delete(value.id); }
    },
    cancel(owner, id) { const job = jobs.get(id); if (job?.owner === owner) job.controller.abort(); },
    dispose(owner) { for (const job of jobs.values()) if (!owner || job.owner === owner) job.controller.abort(); },
  };
}
module.exports = { createModelService };
