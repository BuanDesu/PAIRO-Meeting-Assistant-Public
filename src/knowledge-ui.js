export function setupKnowledge({ bridge, configuration, notify, document = globalThis.document }) {
  const $ = id => document.getElementById(id);
  let busy = false;
  const statusNames = { pending: '待导入', processing: '处理中', ready: '已就绪', partial: '部分完成', failed: '失败，可重试', interrupted: '已中断，可继续', skipped: '已跳过' };
  function progress(value) {
    busy = value.busy;
    $('knowledge-status').textContent = value.message;
    $('knowledge-progress').value = value.total ? Math.round(value.done / value.total * 100) : 0;
    $('knowledge-progress-text').textContent = value.total ? `${value.done} / ${value.total} 个文件` : '';
    $('knowledge-cancel').hidden = !busy;
    for (const button of $('knowledge-list').querySelectorAll('button')) button.disabled = busy;
    $('knowledge-add').disabled = busy || !bridge?.knowledgeChoose;
  }
  async function operation(fn) {
    try { const result = await fn(); if (result) render(result); }
    catch (error) { $('knowledge-status').textContent = error.message || '操作未完成，请重试'; notify(error.message || '知识库操作未完成'); }
  }
  function button(text, action, className = 'button') {
    const element = document.createElement('button'); element.type = 'button'; element.className = className;
    element.textContent = text; element.addEventListener('click', () => { if (!busy) void operation(action); }); return element;
  }
  function render(value) {
    $('knowledge-list').replaceChildren();
    for (const directory of value.directories) {
      const panel = document.createElement('section'); panel.className = 'panel';
      const header = document.createElement('div'); header.className = 'panel-heading';
      const title = document.createElement('h2'); title.textContent = directory.label;
      const badge = document.createElement('span'); badge.className = 'status-pill'; badge.textContent = statusNames[directory.status] || '待更新';
      header.append(title, badge); panel.append(header);
      const source = document.createElement('p'); source.className = 'hint knowledge-path'; source.textContent = directory.path; panel.append(source);
      const actions = document.createElement('div'); actions.className = 'pairing-actions';
      actions.append(button('导入 / 更新 / 重试', () => {
        if (!$('knowledge-consent').checked) throw new Error('请先勾选文档内容发送说明');
        return bridge.knowledgeUpdate({ id: directory.id, config: configuration() });
      }, 'button button-primary'), button('移除目录索引', () => bridge.knowledgeRemove({ id: directory.id })));
      panel.append(actions);
      const counts = document.createElement('p'); counts.className = 'hint';
      counts.textContent = `${directory.files.filter(f => f.status === 'ready').length} 个文件已完成，共 ${directory.files.length} 个；移除仅删除本地索引，原文件保持不变。`; panel.append(counts);
      for (const file of directory.files) {
        const details = document.createElement('details'); details.className = 'knowledge-file';
        const summary = document.createElement('summary'); summary.textContent = `${file.relative} · ${statusNames[file.status] || '待更新'}${file.chunks ? ` · ${file.chunks} 个片段` : ''}`; details.append(summary);
        const reason = document.createElement('p'); reason.className = 'hint'; reason.textContent = file.reason; details.append(reason);
        for (const chunk of file.summaries) {
          const title = document.createElement('p'); title.className = 'micro-label'; title.textContent = '来源块 #' + chunk.id; details.append(title);
          const text = document.createElement('p'); text.className = 'knowledge-summary'; text.textContent = chunk.summary; details.append(text);
          const excerpt = document.createElement('blockquote'); excerpt.textContent = chunk.excerpt; details.append(excerpt);
        }
        details.append(button('移除此文件索引', () => bridge.knowledgeRemove({ id: directory.id, fileId: file.id }), 'text-button'));
        panel.append(details);
      }
      $('knowledge-list').append(panel);
    }
    progress(value.progress);
    if (!value.directories.length) $('knowledge-empty').hidden = false; else $('knowledge-empty').hidden = true;
  }
  $('knowledge-add').addEventListener('click', () => {
    if (!$('knowledge-consent').checked) return notify('请先勾选文档内容发送说明');
    if (!busy && bridge?.knowledgeChoose) void operation(() => bridge.knowledgeChoose());
  });
  $('knowledge-refresh').addEventListener('click', () => { if (bridge?.knowledgeList) void operation(() => bridge.knowledgeList()); });
  $('knowledge-cancel').addEventListener('click', () => { void bridge?.knowledgeCancel(); });
  bridge?.onKnowledgeProgress?.(progress);
  if (bridge?.knowledgeList) void operation(() => bridge.knowledgeList());
  else { $('knowledge-status').textContent = '请使用 Windows 桌面程序添加本地知识库'; $('knowledge-add').disabled = true; }
}
