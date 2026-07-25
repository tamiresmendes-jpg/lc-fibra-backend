const express = require('express');
const router = express.Router();
const { run, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

let pronto = false;
async function garantir() {
  if (pronto) return;
  try {
    await run(`CREATE TABLE IF NOT EXISTS integracao_chatmix (
      empresa_id TEXT PRIMARY KEY,
      base_url TEXT,
      endpoint TEXT,
      token TEXT,
      auth_tipo TEXT DEFAULT 'bearer',
      header_nome TEXT,
      param_nome TEXT,
      atualizado_em TIMESTAMP DEFAULT NOW()
    )`);
    pronto = true;
  } catch (e) { console.error('[Chatmix]', e.message); }
}
garantir();

function soAdminGestor(req, res) {
  if (!['admin', 'gestor'].includes(req.usuario.perfil)) { res.status(403).json({ erro: 'Sem permissão' }); return false; }
  return true;
}

// Monta a requisição (url + headers) conforme a configuração
function montarRequisicao(cfg, endpointOverride) {
  const base = (cfg.base_url || '').replace(/\/+$/, '');
  let caminho = endpointOverride || cfg.endpoint || '';
  if (caminho && !caminho.startsWith('/') && !/^https?:\/\//i.test(caminho)) caminho = '/' + caminho;
  let url = /^https?:\/\//i.test(caminho) ? caminho : base + caminho;
  const headers = { 'Accept': 'application/json' };
  const tipo = cfg.auth_tipo || 'bearer';
  if (cfg.token) {
    if (tipo === 'bearer') headers['Authorization'] = `Bearer ${cfg.token}`;
    else if (tipo === 'header') headers[cfg.header_nome || 'token'] = cfg.token;
    else if (tipo === 'query') {
      const sep = url.includes('?') ? '&' : '?';
      url += `${sep}${encodeURIComponent(cfg.param_nome || 'token')}=${encodeURIComponent(cfg.token)}`;
    }
  }
  return { url, headers };
}

router.get('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await get('SELECT * FROM integracao_chatmix WHERE empresa_id = $1', [req.usuario.empresa_id]) || {};
    res.json({
      base_url: cfg.base_url || 'https://srv6.chatmix.com.br',
      endpoint: cfg.endpoint || '',
      auth_tipo: cfg.auth_tipo || 'bearer',
      header_nome: cfg.header_nome || 'token',
      param_nome: cfg.param_nome || 'token',
      tem_token: !!cfg.token,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const { base_url, endpoint, token, auth_tipo, header_nome, param_nome } = req.body;
    const atual = await get('SELECT token FROM integracao_chatmix WHERE empresa_id = $1', [req.usuario.empresa_id]);
    // Só troca o token se veio um novo não vazio (mantém o existente ao editar outros campos)
    const tokenFinal = (token && token.trim()) ? token.trim() : (atual?.token || null);
    await run(
      `INSERT INTO integracao_chatmix (empresa_id, base_url, endpoint, token, auth_tipo, header_nome, param_nome, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         base_url=EXCLUDED.base_url, endpoint=EXCLUDED.endpoint, token=EXCLUDED.token,
         auth_tipo=EXCLUDED.auth_tipo, header_nome=EXCLUDED.header_nome, param_nome=EXCLUDED.param_nome, atualizado_em=NOW()`,
      [req.usuario.empresa_id, (base_url || '').trim() || null, (endpoint || '').trim() || null, tokenFinal,
       auth_tipo || 'bearer', (header_nome || '').trim() || null, (param_nome || '').trim() || null]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Testa a conexão: chama o endpoint e devolve status + amostra da resposta
router.post('/testar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await get('SELECT * FROM integracao_chatmix WHERE empresa_id = $1', [req.usuario.empresa_id]) || {};
    // Permite testar valores enviados na hora (antes de salvar)
    const merged = {
      base_url: req.body.base_url || cfg.base_url,
      endpoint: req.body.endpoint || cfg.endpoint,
      token: (req.body.token && req.body.token.trim()) ? req.body.token.trim() : cfg.token,
      auth_tipo: req.body.auth_tipo || cfg.auth_tipo,
      header_nome: req.body.header_nome || cfg.header_nome,
      param_nome: req.body.param_nome || cfg.param_nome,
    };
    if (!merged.base_url || !merged.endpoint) return res.status(400).json({ erro: 'Informe a URL base e o endpoint.' });
    const { url, headers } = montarRequisicao(merged, req.body.endpoint);
    let resp, texto;
    try {
      resp = await fetch(url, { headers, redirect: 'manual' });
      texto = await resp.text();
    } catch (e) {
      return res.json({ ok: false, erro: 'Falha de conexão: ' + e.message, url });
    }
    const ct = resp.headers.get('content-type') || '';
    const ehJson = ct.includes('json');
    const ehLogin = /login|<!doctype html/i.test(texto.slice(0, 200)) && !ehJson;
    res.json({
      ok: resp.ok && ehJson,
      status: resp.status,
      content_type: ct,
      redirecionou: resp.status >= 300 && resp.status < 400,
      location: resp.headers.get('location') || null,
      parece_login: ehLogin,
      amostra: texto.slice(0, 600),
      url,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
