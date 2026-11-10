/* global window */
'use strict';
// Shared by the provider form and detector; presets describe real supported protocols.
(function (root) {
  const compatible = { probeMode: 'chat', modelsPath: '/v1/models', authType: 'bearer',
    probePath: '', probeBody: '', capabilityModes: [], assertType: 'none', assertValue: '',
    measureStreaming: false, probePolicy: 'strict' };
  const templates = [
    { id: 'compatible', name: 'OpenAI 兼容接口', hint: '填写服务根地址或带 /v1 的地址。', url: '', config: { ...compatible } },
    { id: 'openai', name: 'OpenAI', hint: '官方 API，使用 Bearer API Key。', url: 'https://api.openai.com', config: { ...compatible } },
    { id: 'vllm', name: 'vLLM', hint: '本地 OpenAI 兼容服务；如配置了密钥请填写。', url: 'http://localhost:8000', config: { ...compatible } },
    { id: 'lmstudio', name: 'LM Studio', hint: '先在 LM Studio 启动本地 API 服务。', url: 'http://localhost:1234', config: { ...compatible } },
    { id: 'ollama', name: 'Ollama（原生 API）', hint: '使用 /api/tags 和 /api/chat，自动关闭流式请求。', url: 'http://localhost:11434',
      config: { ...compatible, authType: 'none', modelsPath: '/api/tags', probeMode: 'custom', probePath: '/api/chat',
        probeBody: '{"model":"{{model}}","messages":[{"role":"user","content":"ping"}],"stream":false,"options":{"num_predict":1}}',
        assertType: 'jsonPath', assertValue: 'message.content' } },
    { id: 'custom', name: '自定义服务', hint: '在高级表单配置端点、鉴权和响应断言。', url: '', config: { ...compatible, probeMode: 'custom' } }
  ];
  function normalizeBase(value) {
    const raw = String(value || '').trim();
    return raw && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? `https://${raw}` : raw;
  }
  function endpoint(base, path) {
    const url = new URL(normalizeBase(base));
    const part = new URL(`http://endpoint.invalid/${String(path || '').replace(/^\/+/, '')}`);
    let prefix = url.pathname.replace(/\/+$/, '');
    const first = part.pathname.split('/')[1];
    if (first && prefix.endsWith(`/${first}`)) prefix = prefix.slice(0, -first.length - 1);
    url.pathname = prefix + part.pathname;
    for (const [key, value] of part.searchParams) url.searchParams.set(key, value);
    url.hash = '';
    return url.toString();
  }
  const api = { templates, normalizeBase, endpoint };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.providerTemplates = api;
})(typeof window === 'object' ? window : globalThis);
