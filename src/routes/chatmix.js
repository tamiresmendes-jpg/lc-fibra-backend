const express = require('express');
const router = express.Router();
const { run, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const BASE_PADRAO = 'https://srv6.chatmix.com.br';
const API = '/api-v2/public-api';

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

async function carregarCfg(empresaId) {
  const cfg = await get('SELECT * FROM integracao_chatmix WHERE empresa_id = $1', [empresaId]) || {};
  return { base_url: cfg.base_url || BASE_PADRAO, token: cfg.token || '' };
}

const espera = ms => new Promise(r => setTimeout(r, ms));

// Chama a API pública do Chatmix (auth via header X-auth).
// A API tem rate limit agressivo (429/403 via Cloudflare) — tenta de novo com backoff.
async function chamar(cfg, caminho, params = {}, tentativas = 3) {
  const base = (cfg.base_url || BASE_PADRAO).replace(/\/+$/, '');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, v);
  }
  const url = base + API + caminho + (qs.toString() ? '?' + qs.toString() : '');
  const headers = {
    'Accept': 'application/json', 'X-auth': cfg.token,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Kronos',
  };
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    const resp = await fetch(url, { headers });
    const texto = await resp.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* */ }
    ultimo = { status: resp.status, json, texto, contentType: resp.headers.get('content-type') || '' };
    if (resp.status !== 429 && resp.status !== 403) return ultimo;
    await espera(600 * (i + 1)); // backoff progressivo
  }
  return ultimo;
}

function segundosEntre(inicio, fim) {
  if (!inicio || !fim) return null;
  const a = Date.parse(inicio.replace(' ', 'T'));
  const b = Date.parse(fim.replace(' ', 'T'));
  if (isNaN(a) || isNaN(b) || b < a) return null;
  return Math.round((b - a) / 1000);
}
function fmtDuracao(seg) {
  if (seg == null) return '—';
  seg = Math.max(0, Math.round(seg));
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  const pad = n => String(n).padStart(2, '0');
  return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
}

// ---------- CONFIG ----------
router.get('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await get('SELECT * FROM integracao_chatmix WHERE empresa_id = $1', [req.usuario.empresa_id]) || {};
    res.json({ base_url: cfg.base_url || BASE_PADRAO, tem_token: !!cfg.token });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const { base_url, token } = req.body;
    const atual = await get('SELECT token FROM integracao_chatmix WHERE empresa_id = $1', [req.usuario.empresa_id]);
    const tokenFinal = (token && token.trim()) ? token.trim() : (atual?.token || null);
    await run(
      `INSERT INTO integracao_chatmix (empresa_id, base_url, token, auth_tipo, header_nome, atualizado_em)
       VALUES ($1,$2,$3,'header','X-auth', NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET base_url=EXCLUDED.base_url, token=EXCLUDED.token,
         auth_tipo='header', header_nome='X-auth', atualizado_em=NOW()`,
      [req.usuario.empresa_id, (base_url || '').trim() || BASE_PADRAO, tokenFinal]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/testar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (req.body.token && req.body.token.trim()) cfg.token = req.body.token.trim();
    if (req.body.base_url) cfg.base_url = req.body.base_url;
    if (!cfg.token) return res.status(400).json({ erro: 'Informe o token do Chatmix.' });
    const r = await chamar(cfg, '/attendances/count');
    const ok = r.status === 200 && r.json && r.json.status === 'success';
    res.json({ ok, status: r.status, content_type: r.contentType, ao_vivo: r.json?.attendances || null, amostra: r.texto.slice(0, 400) });
  } catch (e) { res.json({ ok: false, erro: 'Falha de conexão: ' + e.message }); }
});

// Busca atendimentos finalizados paginando. A API limita per_page e tem rate limit,
// então usamos per_page=50, uma pausa entre páginas e um teto de páginas (amostra).
// O total EXATO vem do meta.total (não precisa baixar tudo).
async function buscarFechados(cfg, di, df, maxPaginas = 20) {
  const itens = [];
  let page = 1, last = 1, total = 0;
  const per = 50;
  do {
    const r = await chamar(cfg, '/attendances/closed', { date_start: di, date_end: df, per_page: per, page });
    if (r.status !== 200 || !r.json) {
      if (page === 1) throw new Error(r.json?.error || ('Chatmix HTTP ' + r.status));
      break; // já temos alguma amostra; para em erro de página seguinte
    }
    const dados = Array.isArray(r.json.data) ? r.json.data : [];
    itens.push(...dados);
    const meta = r.json.meta || {};
    last = meta.last_page || 1; total = meta.total || itens.length;
    page++;
    if (page <= last && page <= maxPaginas) await espera(350);
  } while (page <= last && page <= maxPaginas);
  return { itens, total, amostrado: total > itens.length };
}

// ---------- INDICADORES ----------
router.get('/indicadores', async (req, res) => {
  try {
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (!cfg.token) return res.status(400).json({ erro: 'Integração do Chatmix não configurada.', nao_configurado: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const di = req.query.data_inicial || hoje;
    const df = req.query.data_final || hoje;

    const [{ itens, total, amostrado }, count] = await Promise.all([
      buscarFechados(cfg, di, df),
      chamar(cfg, '/attendances/count').then(r => r.json?.attendances || null).catch(() => null),
    ]);

    let somaDur = 0, comDur = 0;
    let somaNota = 0, qtdNota = 0;
    const distNotas = {}; // nota -> quantidade
    const comentarios = [];
    const porCanal = {}, porDia = {}, porAtendente = {}, porClassificacao = {};
    for (const a of itens) {
      const dur = segundosEntre(a.created_at, a.closed_at);
      if (dur != null) { somaDur += dur; comDur++; }
      const canal = a.channel?.name || '—';
      porCanal[canal] = (porCanal[canal] || 0) + 1;
      const dia = (a.created_at || '').slice(0, 10);
      if (dia) porDia[dia] = (porDia[dia] || 0) + 1;
      const at = a.user?.name || 'Automação/Bot';
      porAtendente[at] = (porAtendente[at] || 0) + 1;
      (a.classifications || []).forEach(c => { const n = c.name || '—'; porClassificacao[n] = (porClassificacao[n] || 0) + 1; });
      (a.satisfaction_surveys || []).forEach(s => {
        const nota = Number(s.satisfaction);
        if (!isNaN(nota) && s.satisfaction != null) { somaNota += nota; qtdNota++; distNotas[nota] = (distNotas[nota] || 0) + 1; }
        const txt = s.comments || s.content;
        if (txt && comentarios.length < 20) comentarios.push({ nota: s.satisfaction, texto: txt, cliente: a.client?.name || '—' });
      });
    }
    const ordenar = obj => Object.entries(obj).map(([nome, qtd]) => ({ nome, qtd })).sort((a, b) => b.qtd - a.qtd);

    res.json({
      periodo: { data_inicial: di, data_final: df },
      amostrado, // true quando o total é maior que a amostra baixada (rankings são da amostra)
      amostra_qtd: itens.length,
      cards: {
        total,
        tma_seg: comDur ? Math.round(somaDur / comDur) : 0,
        tma_fmt: fmtDuracao(comDur ? somaDur / comDur : 0),
        satisfacao_media: qtdNota ? Math.round((somaNota / qtdNota) * 100) / 100 : null,
        satisfacao_respostas: qtdNota,
        ao_vivo_aguardando: count?.waiting ?? null,
        ao_vivo_automacao: count?.automation ?? null,
        ao_vivo_atendimento: count?.progress ?? null,
      },
      satisfacao: {
        media: qtdNota ? Math.round((somaNota / qtdNota) * 100) / 100 : null,
        respostas: qtdNota,
        distribuicao: Object.entries(distNotas).map(([nota, qtd]) => ({ nota: Number(nota), qtd })).sort((a, b) => b.nota - a.nota),
        comentarios,
      },
      por_canal: ordenar(porCanal),
      por_atendente: ordenar(porAtendente),
      por_classificacao: ordenar(porClassificacao),
      por_dia: Object.entries(porDia).map(([dia, qtd]) => ({ dia, qtd })).sort((a, b) => a.dia.localeCompare(b.dia)),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- LISTA / BUSCA ----------
router.get('/atendimentos', async (req, res) => {
  try {
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (!cfg.token) return res.status(400).json({ erro: 'Integração do Chatmix não configurada.', nao_configurado: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const r = await chamar(cfg, '/attendances/closed', {
      date_start: req.query.data_inicial || hoje,
      date_end: req.query.data_final || hoje,
      per_page: Math.min(parseInt(req.query.per_page || '30', 10), 50),
      page: req.query.page || 1,
    });
    if (r.status !== 200 || !r.json) return res.status(502).json({ erro: r.json?.error || ('Erro Chatmix HTTP ' + r.status) });
    const busca = (req.query.busca || '').toLowerCase().trim();
    let dados = (r.json.data || []).map(a => ({
      id: a.id, protocolo: a.protocol, abertura: a.created_at, fechamento: a.closed_at,
      duracao: fmtDuracao(segundosEntre(a.created_at, a.closed_at)),
      canal: a.channel?.name || '—', tipo_canal: a.channel?.type || '',
      cliente: a.client?.name || '—', contato: a.client?.user || '',
      atendente: a.user?.name || 'Automação/Bot',
      classificacoes: (a.classifications || []).map(c => c.name),
    }));
    if (busca) dados = dados.filter(a =>
      (a.cliente || '').toLowerCase().includes(busca) || (a.protocolo || '').toLowerCase().includes(busca) ||
      (a.contato || '').toLowerCase().includes(busca));
    res.json({ meta: r.json.meta || {}, atendimentos: dados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- AO VIVO ----------
router.get('/ao-vivo', async (req, res) => {
  try {
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (!cfg.token) return res.status(400).json({ erro: 'Integração do Chatmix não configurada.', nao_configurado: true });
    const [count, waiting] = await Promise.all([
      chamar(cfg, '/attendances/count').then(r => r.json?.attendances || null),
      chamar(cfg, '/attendances/waiting', { per_page: 50 }).then(r => r.json?.data || []),
    ]);
    res.json({
      contadores: count,
      fila: (waiting || []).map(a => ({
        id: a.id, protocolo: a.protocol, canal: a.channel?.name || '—',
        cliente: a.client?.name || a.client?.user || '—',
        departamento_id: a.departament_id, nao_lidas: a.unread_messages,
        classificacoes: (a.classifications || []).map(c => c.name),
      })),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
