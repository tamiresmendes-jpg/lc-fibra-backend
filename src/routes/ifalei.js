const express = require('express');
const router = express.Router();
const { run, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const BASE_PADRAO = 'https://painelv2.ifalei.com.br/suite/api';

let pronto = false;
async function garantir() {
  if (pronto) return;
  try {
    await run(`CREATE TABLE IF NOT EXISTS integracao_ifalei (
      empresa_id TEXT PRIMARY KEY,
      base_url TEXT,
      usuario TEXT,
      token TEXT,
      atualizado_em TIMESTAMP DEFAULT NOW()
    )`);
    pronto = true;
  } catch (e) { console.error('[iFalei]', e.message); }
}
garantir();

function soAdminGestor(req, res) {
  if (!['admin', 'gestor'].includes(req.usuario.perfil)) { res.status(403).json({ erro: 'Sem permissão' }); return false; }
  return true;
}

async function carregarCfg(empresaId) {
  const cfg = await get('SELECT * FROM integracao_ifalei WHERE empresa_id = $1', [empresaId]) || {};
  return { base_url: cfg.base_url || BASE_PADRAO, usuario: cfg.usuario || '', token: cfg.token || '' };
}

// O iFalei espera datas no formato dd/mm/aaaa; o front manda ISO (aaaa-mm-dd)
function paraDataBR(v) {
  if (typeof v === 'string') {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  return v;
}

// Chama um endpoint da API do iFalei (auth via headers usuario/token)
async function chamarIfalei(cfg, endpoint, params = {}) {
  const base = (cfg.base_url || BASE_PADRAO).replace(/\/+$/, '');
  const caminho = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const val = (k === 'data_inicial' || k === 'data_final') ? paraDataBR(v) : v;
    qs.append(k, val);
  }
  const url = base + caminho + (qs.toString() ? '?' + qs.toString() : '');
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/json', 'usuario': cfg.usuario, 'token': cfg.token },
  });
  const texto = await resp.text();
  let json = null;
  try { json = JSON.parse(texto); } catch { /* pode não ser JSON */ }
  return { status: resp.status, json, texto, contentType: resp.headers.get('content-type') || '' };
}

// Converte "HH:MM:SS", "MM:SS" ou número de segundos em segundos (inteiro)
function paraSegundos(v) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number') return Math.max(0, Math.round(v));
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const partes = s.split(':').map(x => parseInt(x, 10));
  if (partes.some(isNaN)) return 0;
  let seg = 0;
  for (const p of partes) seg = seg * 60 + p;
  return seg;
}

function fmtDuracao(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const pad = n => String(n).padStart(2, '0');
  return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
}

// Um CDR conta como "atendido" quando teve conversa (status atendido ou duração real > 0)
function foiAtendida(c) {
  const st = String(c.status || '').toLowerCase();
  if (/atend/.test(st) && !/n[ãa]o/.test(st)) return true;
  if (/complet|answer/.test(st)) return true;
  return paraSegundos(c.duracao_real) > 0 && paraSegundos(c.tempo_operador_total_filas) > 0;
}

// ---------- CONFIG ----------
router.get('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await get('SELECT * FROM integracao_ifalei WHERE empresa_id = $1', [req.usuario.empresa_id]) || {};
    res.json({
      base_url: cfg.base_url || BASE_PADRAO,
      usuario: cfg.usuario || '',
      tem_token: !!cfg.token,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const { base_url, usuario, token } = req.body;
    const atual = await get('SELECT token FROM integracao_ifalei WHERE empresa_id = $1', [req.usuario.empresa_id]);
    const tokenFinal = (token && token.trim()) ? token.trim() : (atual?.token || null);
    await run(
      `INSERT INTO integracao_ifalei (empresa_id, base_url, usuario, token, atualizado_em)
       VALUES ($1,$2,$3,$4, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         base_url=EXCLUDED.base_url, usuario=EXCLUDED.usuario, token=EXCLUDED.token, atualizado_em=NOW()`,
      [req.usuario.empresa_id, (base_url || '').trim() || BASE_PADRAO, (usuario || '').trim() || null, tokenFinal]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/testar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (req.body.usuario) cfg.usuario = req.body.usuario;
    if (req.body.token && req.body.token.trim()) cfg.token = req.body.token.trim();
    if (req.body.base_url) cfg.base_url = req.body.base_url;
    if (!cfg.usuario || !cfg.token) return res.status(400).json({ erro: 'Informe o usuário e o token do iFalei.' });
    const hoje = new Date().toISOString().slice(0, 10);
    const r = await chamarIfalei(cfg, '/listar_historico_chamada', { data_inicial: hoje, data_final: hoje, quantidade: 1 });
    const ok = r.status === 200 && r.json && (r.json.http_response_code === 200 || Array.isArray(r.json.dados));
    res.json({
      ok,
      status: r.status,
      content_type: r.contentType,
      mensagem: r.json?.mensagem || null,
      total_hoje: r.json?.qtd_total_resultados ?? null,
      amostra: r.texto.slice(0, 500),
    });
  } catch (e) { res.json({ ok: false, erro: 'Falha de conexão: ' + e.message }); }
});

// Busca chamadas paginando na API (até um teto de segurança)
async function buscarChamadas(cfg, filtros, tetoRegistros = 5000) {
  const chamadas = [];
  let pos = 0;
  const passo = 1000;
  let total = null;
  while (chamadas.length < tetoRegistros) {
    const r = await chamarIfalei(cfg, '/listar_historico_chamada', {
      ...filtros, quantidade: passo, pos_registro_inicial: pos,
    });
    if (r.status !== 200 || !r.json) throw new Error(r.json?.mensagem || ('HTTP ' + r.status));
    const lote = Array.isArray(r.json.dados) ? r.json.dados : [];
    total = r.json.qtd_total_resultados ?? total;
    chamadas.push(...lote);
    if (lote.length < passo) break;
    pos += passo;
    if (total != null && chamadas.length >= total) break;
  }
  return { chamadas, total: total ?? chamadas.length };
}

// ---------- INDICADORES (dashboard) ----------
router.get('/indicadores', async (req, res) => {
  try {
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (!cfg.usuario || !cfg.token) return res.status(400).json({ erro: 'Integração do iFalei não configurada.', nao_configurado: true });
    const hoje = new Date().toISOString().slice(0, 10);
    const data_inicial = req.query.data_inicial || hoje;
    const data_final = req.query.data_final || hoje;
    const filtros = { data_inicial, data_final };
    if (req.query.operador_id) filtros.operador_id = req.query.operador_id;

    const { chamadas, total } = await buscarChamadas(cfg, filtros);

    let atendidas = 0, perdidas = 0, somaDur = 0, somaTMA = 0, somaTME = 0, comTMA = 0, comTME = 0;
    const porOperador = {};
    const porDia = {};
    const porHora = Array.from({ length: 24 }, () => ({ total: 0, atendidas: 0, perdidas: 0 }));

    for (const c of chamadas) {
      const at = foiAtendida(c);
      const dur = paraSegundos(c.duracao_real || c.duracao);
      const tma = paraSegundos(c.tempo_operador_total_filas);
      const tme = paraSegundos(c.tempo_espera_total_filas);
      if (at) { atendidas++; somaDur += dur; if (tma > 0) { somaTMA += tma; comTMA++; } }
      else perdidas++;
      if (tme > 0) { somaTME += tme; comTME++; }

      const op = (c.operador || '—').trim() || '—';
      const o = porOperador[op] || (porOperador[op] = { operador: op, total: 0, atendidas: 0, perdidas: 0, minutagem: 0, somaTMA: 0, comTMA: 0 });
      o.total++; if (at) { o.atendidas++; o.minutagem += dur; if (tma > 0) { o.somaTMA += tma; o.comTMA++; } } else o.perdidas++;

      const dt = String(c.data || '');
      const dia = dt.slice(0, 10);
      if (dia) { const d = porDia[dia] || (porDia[dia] = { dia, total: 0, atendidas: 0, perdidas: 0 }); d.total++; at ? d.atendidas++ : d.perdidas++; }
      const mh = dt.match(/\b(\d{1,2}):\d{2}/);
      if (mh) { const h = Math.min(23, parseInt(mh[1], 10)); porHora[h].total++; at ? porHora[h].atendidas++ : porHora[h].perdidas++; }
    }

    const operadores = Object.values(porOperador).map(o => ({
      operador: o.operador, total: o.total, atendidas: o.atendidas, perdidas: o.perdidas,
      minutagem_seg: o.minutagem, minutagem_fmt: fmtDuracao(o.minutagem),
      tma_seg: o.comTMA ? Math.round(o.somaTMA / o.comTMA) : 0,
      tma_fmt: fmtDuracao(o.comTMA ? o.somaTMA / o.comTMA : 0),
    })).sort((a, b) => b.total - a.total);

    res.json({
      periodo: { data_inicial, data_final },
      cards: {
        total, atendidas, perdidas,
        perc_perdidas: total ? Math.round((perdidas / total) * 1000) / 10 : 0,
        tma_seg: comTMA ? Math.round(somaTMA / comTMA) : 0,
        tma_fmt: fmtDuracao(comTMA ? somaTMA / comTMA : 0),
        tme_seg: comTME ? Math.round(somaTME / comTME) : 0,
        tme_fmt: fmtDuracao(comTME ? somaTME / comTME : 0),
        media_ligacao_seg: atendidas ? Math.round(somaDur / atendidas) : 0,
        media_ligacao_fmt: fmtDuracao(atendidas ? somaDur / atendidas : 0),
        minutagem_total_seg: somaDur,
        minutagem_total_fmt: fmtDuracao(somaDur),
      },
      operadores,
      por_dia: Object.values(porDia).sort((a, b) => a.dia.localeCompare(b.dia)),
      por_hora: porHora.map((h, i) => ({ hora: i, ...h })),
      amostra_bruta: chamadas.length ? chamadas[0] : null,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- LISTA DE CHAMADAS ----------
router.get('/chamadas', async (req, res) => {
  try {
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (!cfg.usuario || !cfg.token) return res.status(400).json({ erro: 'Integração do iFalei não configurada.', nao_configurado: true });
    const params = {
      data_inicial: req.query.data_inicial, data_final: req.query.data_final,
      hora_inicial: req.query.hora_inicial, hora_final: req.query.hora_final,
      filtro_status_chamada: req.query.status, operador_id: req.query.operador_id,
      numero_origem: req.query.numero_origem, numero_destino: req.query.numero_destino,
      quantidade: Math.min(parseInt(req.query.quantidade || '100', 10), 1000),
      pos_registro_inicial: req.query.pos || 0,
    };
    const r = await chamarIfalei(cfg, '/listar_historico_chamada', params);
    if (r.status !== 200 || !r.json) return res.status(502).json({ erro: r.json?.mensagem || ('Erro iFalei HTTP ' + r.status) });
    const chamadas = (r.json.dados || []).map(c => ({
      chamada_id: c.chamada_id, data: c.data, cliente: c.cliente_nome, origem: c.origem, destino: c.destino,
      operador: c.operador, status: c.status, atendida: foiAtendida(c),
      duracao: c.duracao, duracao_real: c.duracao_real,
      tempo_espera: c.tempo_espera_total_filas, tempo_operador: c.tempo_operador_total_filas,
      motivo_desligamento: c.motivo_deligamento, gravacao: c.link_gravacao || null,
    }));
    res.json({ total: r.json.qtd_total_resultados ?? chamadas.length, retornados: chamadas.length, chamadas });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- CHAMADAS AO VIVO ----------
router.get('/online', async (req, res) => {
  try {
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (!cfg.usuario || !cfg.token) return res.status(400).json({ erro: 'Integração do iFalei não configurada.', nao_configurado: true });
    const r = await chamarIfalei(cfg, '/listar_chamadas_online', {});
    if (r.status !== 200 || !r.json) return res.status(502).json({ erro: r.json?.mensagem || ('Erro iFalei HTTP ' + r.status) });
    res.json({ total: r.json.qtd_total_resultados ?? (r.json.dados || []).length, chamadas: r.json.dados || [] });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
