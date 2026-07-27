const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
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
// Nome do atendente (user tem first_name/last_name; bot/automação vem null)
function nomeAtendente(a) {
  if (!a.user) return 'Automação/Bot';
  return [a.user.first_name, a.user.last_name].filter(Boolean).join(' ').trim() || 'Automação/Bot';
}
function nomeDepartamento(a) {
  return a.department?.title || a.department?.name || null;
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

// Busca atendimentos finalizados paginando. IMPORTANTE: a rota /closed permite só
// 2 requisições por minuto (limite do Chatmix). Por isso puxamos no máximo 2 páginas
// (~100 atendimentos recentes) como amostra. O total EXATO vem do meta.total.
async function buscarFechados(cfg, di, df, maxPaginas = 2) {
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

// ---------- INDICADORES ---------- (lê do histórico sincronizado, sem amostra)
router.get('/indicadores', async (req, res) => {
  try {
    await garantir();
    const emp = req.usuario.empresa_id;
    const cfg = await carregarCfg(emp);
    if (!cfg.token) return res.status(400).json({ erro: 'Integração do Chatmix não configurada.', nao_configurado: true });
    const { di, df } = periodo(req);

    // "Ao vivo" continua vindo da API (rápido, limite 25/min); se falhar, ignora
    const count = await chamar(cfg, '/attendances/count').then(r => r.json?.attendances || null).catch(() => null);

    // Filtros (canal/departamento) reaproveitados
    const params = [emp, di, df];
    const flt = filtros(req, params);
    const base = `FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3${flt}`;

    const [cardRow, porCanal, porAtend, porDep, porDia, canaisAll, depsAll] = await Promise.all([
      get(`SELECT COUNT(*)::int total,
             AVG(EXTRACT(EPOCH FROM (closed_at-created_at))) FILTER (WHERE closed_at IS NOT NULL AND created_at IS NOT NULL) tma,
             COUNT(*) FILTER (WHERE nota IS NOT NULL)::int resp,
             AVG(nota) FILTER (WHERE nota IS NOT NULL) media,
             COUNT(*) FILTER (WHERE nota=5)::int satisfeitas,
             COUNT(*) FILTER (WHERE nota=1)::int insatisfeitas ${base}`, params),
      all(`SELECT COALESCE(canal,'—') nome, COUNT(*)::int qtd ${base} GROUP BY 1 ORDER BY qtd DESC`, params),
      all(`SELECT COALESCE(atendente_nome,'Automação/Bot') nome, COUNT(*)::int qtd ${base} GROUP BY 1 ORDER BY qtd DESC`, params),
      all(`SELECT COALESCE(departamento,'Sem departamento') nome, COUNT(*)::int qtd ${base} GROUP BY 1 ORDER BY qtd DESC`, params),
      all(`SELECT closed_at::date::text dia, COUNT(*)::int qtd ${base} GROUP BY 1 ORDER BY 1`, params),
      all(`SELECT DISTINCT canal AS n FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3 AND canal IS NOT NULL ORDER BY 1`, [emp, di, df]),
      all(`SELECT DISTINCT departamento AS n FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3 AND departamento IS NOT NULL ORDER BY 1`, [emp, di, df]),
    ]);

    // Cobertura da sincronização: o período já foi todo baixado?
    const estado = await get('SELECT MIN(closed_at)::date AS min FROM chatmix_atendimentos WHERE empresa_id=$1', [emp]);
    const minCoberto = estado?.min ? String(estado.min).slice(0, 10) : null;
    const sincronizando = !minCoberto || di < minCoberto; // pediu período mais antigo do que já foi baixado

    const media = cardRow?.media != null ? Math.round(cardRow.media * 100) / 100 : null;
    res.json({
      periodo: { data_inicial: di, data_final: df },
      canais: canaisAll.map(c => c.n),
      departamentos: depsAll.map(d => d.n),
      sincronizando, min_coberto: minCoberto,
      cards: {
        total: cardRow?.total || 0,
        tma_seg: Math.round(cardRow?.tma || 0), tma_fmt: fmtDuracao(cardRow?.tma || 0),
        satisfacao_media: media, satisfacao_respostas: cardRow?.resp || 0,
        ao_vivo_aguardando: count?.waiting ?? null,
        ao_vivo_automacao: count?.automation ?? null,
        ao_vivo_atendimento: count?.progress ?? null,
      },
      satisfacao: {
        media, respostas: cardRow?.resp || 0,
        distribuicao: [
          { nota: 5, qtd: cardRow?.satisfeitas || 0 },
          { nota: 1, qtd: cardRow?.insatisfeitas || 0 },
        ].filter(d => d.qtd > 0),
        comentarios: [],
      },
      por_departamento: porDep,
      por_canal: porCanal,
      por_atendente: porAtend,
      por_dia: porDia,
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
    // A busca por protocolo/telefone é feita no servidor (a API aceita esses filtros)
    const buscaBruta = (req.query.busca || '').trim();
    const params = {
      date_start: req.query.data_inicial || hoje,
      date_end: req.query.data_final || hoje,
      per_page: Math.min(parseInt(req.query.per_page || '30', 10), 50),
      page: req.query.page || 1,
    };
    if (buscaBruta) {
      if (/^\d{6,}$/.test(buscaBruta.replace(/\D/g, '')) && buscaBruta.replace(/\D/g, '').length >= 8) params.phone = buscaBruta.replace(/\D/g, '');
      else if (/^\w+$/.test(buscaBruta)) params.protocol = buscaBruta;
    }
    const r = await chamar(cfg, '/attendances/closed', params);
    if (r.status !== 200 || !r.json) return res.status(502).json({ erro: r.json?.error || ('Erro Chatmix HTTP ' + r.status) });
    const busca = (req.query.busca || '').toLowerCase().trim();
    let dados = (r.json.data || []).map(a => ({
      id: a.id, protocolo: a.protocol, abertura: a.created_at, fechamento: a.closed_at,
      duracao: fmtDuracao(segundosEntre(a.created_at, a.closed_at)),
      canal: a.channel?.name || '—', tipo_canal: a.channel?.type || '',
      cliente: a.client?.name || '—', contato: a.client?.user || '',
      atendente: nomeAtendente(a), departamento: nomeDepartamento(a) || '—',
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

// ===================== STATUS AO VIVO =====================
async function listaAoVivo(cfg, caminho) {
  const itens = [];
  for (let page = 1; page <= 3; page++) {
    const r = await chamar(cfg, caminho, { per_page: 100, page });
    if (r.status !== 200 || !r.json) break;
    const dados = Array.isArray(r.json.data) ? r.json.data : [];
    itens.push(...dados);
    const last = r.json.meta?.last_page || 1;
    if (page >= last) break;
  }
  return itens;
}

// Segundos desde um horário do Chatmix (string em BRT, -3)
function segDesde(str) {
  if (!str) return null;
  const t = Date.parse(String(str).replace(' ', 'T') + '-03:00');
  if (isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}
function fmtEspera(seg) {
  if (seg == null) return '—';
  const d = Math.floor(seg / 86400), h = Math.floor((seg % 86400) / 3600), m = Math.floor((seg % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}min`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m} min`;
}

router.get('/status', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id;
    const cfg = await carregarCfg(emp);
    if (!cfg.token) return res.status(400).json({ erro: 'Integração do Chatmix não configurada.', nao_configurado: true });

    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // hoje em BRT
    const [count, andamento0, aguardando0, automacao0, mapaDeps] = await Promise.all([
      chamar(cfg, '/attendances/count').then(r => r.json?.attendances || null).catch(() => null),
      listaAoVivo(cfg, '/attendances/in-progress').catch(() => []),
      listaAoVivo(cfg, '/attendances/waiting').catch(() => []),
      listaAoVivo(cfg, '/attendances/automation').catch(() => []),
      all('SELECT dep_id, nome FROM chatmix_departamentos WHERE empresa_id=$1', [emp]),
    ]);
    const depNome = {}, depId = {};
    mapaDeps.forEach(d => { depNome[d.dep_id] = d.nome; depId[String(d.nome).toLowerCase()] = String(d.dep_id); });
    const nomeDep = id => depNome[id] || (id ? 'Depto ' + id : 'Sem departamento');
    const nomeAt = u => u ? [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || 'Sem nome' : '—';

    // Filtro por departamento (nome -> id)
    const depFiltro = (req.query.departamento || '').trim();
    const depFiltroId = depFiltro ? depId[depFiltro.toLowerCase()] : null;
    const passa = a => !depFiltro || String(a.departament_id) === depFiltroId;
    const andamento = andamento0.filter(passa);
    const aguardando = aguardando0.filter(passa);
    const automacao = automacao0.filter(passa);

    // Encerrados hoje e tempo médio por atendente (do banco) — respeitando o filtro
    const paramsDb = [emp, hoje];
    let fltDb = '';
    if (depFiltro) { paramsDb.push(depFiltro); fltDb = ` AND COALESCE(departamento,'Sem departamento') = $${paramsDb.length}`; }
    const [encHojeRows, iniHoje, encHojeTot] = await Promise.all([
      all(`SELECT COALESCE(atendente_nome,'Automação/Bot') nome, COUNT(*)::int enc,
             AVG(EXTRACT(EPOCH FROM (closed_at-created_at))) tma
           FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date=$2${fltDb} GROUP BY 1`, paramsDb),
      get(`SELECT COUNT(*)::int n FROM chatmix_atendimentos WHERE empresa_id=$1 AND created_at::date=$2${fltDb}`, paramsDb),
      get(`SELECT COUNT(*)::int n FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date=$2${fltDb}`, paramsDb),
    ]);
    const encPorAt = {}; encHojeRows.forEach(r => { encPorAt[r.nome] = { enc: r.enc, tma: r.tma }; });

    // Por atendente: em andamento (ao vivo) + encerrados hoje + tempo médio (banco)
    const porAtend = {};
    andamento.forEach(a => {
      const nome = nomeAt(a.user);
      const o = porAtend[nome] || (porAtend[nome] = { atendente: nome, departamento: nomeDep(a.departament_id), em_andamento: 0, em_espera: 0, encerrados_hoje: 0, tempo_medio: '—' });
      o.em_andamento++;
    });
    // adiciona quem encerrou hoje mas não está em atendimento agora
    Object.entries(encPorAt).forEach(([nome, v]) => {
      const o = porAtend[nome] || (porAtend[nome] = { atendente: nome, departamento: '—', em_andamento: 0, em_espera: 0, encerrados_hoje: 0, tempo_medio: '—' });
      o.encerrados_hoje = v.enc; o.tempo_medio = fmtDuracao(v.tma || 0);
    });

    // Por departamento
    const porDep = {};
    const bump = (id, campo) => { const n = nomeDep(id); const o = porDep[n] || (porDep[n] = { departamento: n, em_andamento: 0, aguardando: 0, automacao: 0 }); o[campo]++; };
    andamento.forEach(a => bump(a.departament_id, 'em_andamento'));
    aguardando.forEach(a => bump(a.departament_id, 'aguardando'));
    automacao.forEach(a => bump(a.departament_id, 'automacao'));

    // Métricas de espera (fila) e maior espera (fila + andamento)
    const esperas = aguardando.map(a => segDesde(a.created_at)).filter(x => x != null);
    const esperaMedia = esperas.length ? Math.round(esperas.reduce((s, x) => s + x, 0) / esperas.length) : 0;
    const todasEsperas = [...esperas, ...andamento.map(a => segDesde(a.created_at)).filter(x => x != null)];
    const maiorEspera = todasEsperas.length ? Math.max(...todasEsperas) : 0;

    const emAnd = depFiltro ? andamento.length : (count?.progress ?? andamento.length);
    const emEsp = depFiltro ? aguardando.length : (count?.waiting ?? aguardando.length);
    const emAuto = depFiltro ? automacao.length : (count?.automation ?? automacao.length);
    const encHoje = encHojeTot?.n || 0;
    const ini = iniHoje?.n || 0;

    res.json({
      atualizado_em: new Date().toISOString(),
      departamentos: mapaDeps.map(d => d.nome).sort(),
      departamento_selecionado: depFiltro || null,
      totais: {
        em_andamento: emAnd, aguardando: emEsp, automacao: emAuto, finalizados_hoje: encHoje,
      },
      metricas: {
        espera_media_fmt: fmtEspera(esperaMedia),
        maior_espera_fmt: fmtEspera(maiorEspera),
        iniciados_hoje: ini,
        resolucao_dia: ini ? Math.round((encHoje / ini) * 1000) / 10 : 0,
      },
      por_atendente: Object.values(porAtend).sort((a, b) => (b.em_andamento - a.em_andamento) || (b.encerrados_hoje - a.encerrados_hoje)),
      por_departamento: Object.values(porDep).sort((a, b) => (b.em_andamento + b.aguardando + b.automacao) - (a.em_andamento + a.aguardando + a.automacao)),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ===================== RELATÓRIOS (lêem do banco sincronizado) =====================
// Os relatórios abaixo usam a data de ENCERRAMENTO (closed_at), como no painel do Chatmix.

function periodo(req) {
  const hoje = new Date().toISOString().slice(0, 10);
  return { di: req.query.data_inicial || hoje, df: req.query.data_final || hoje };
}
function diasEntre(di, df) {
  const a = Date.parse(di), b = Date.parse(df);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}
function fmt(seg) { // reaproveita fmtDuracao já definido acima
  return fmtDuracao(seg);
}

// Monta cláusulas de filtro (departamento/atendente) reaproveitando params posicionais.
// Aceita múltiplos valores separados por vírgula (ex.: atendente=Ana,Bruna).
function listaParam(v) { return String(v || '').split(',').map(s => s.trim()).filter(Boolean); }
function filtros(req, params) {
  let sql = '';
  const deps = listaParam(req.query.departamento);
  const ats = listaParam(req.query.atendente);
  if (deps.length) { params.push(deps); sql += ` AND COALESCE(departamento,'Sem departamento') = ANY($${params.length})`; }
  if (ats.length) { params.push(ats); sql += ` AND COALESCE(atendente_nome,'Automação/Bot') = ANY($${params.length})`; }
  return sql;
}

// Listas para os seletores (departamentos e atendentes sincronizados no período)
router.get('/listas', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const deps = await all(`SELECT DISTINCT departamento AS nome FROM chatmix_atendimentos
      WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3 AND departamento IS NOT NULL ORDER BY 1`, [emp, di, df]);
    const ats = await all(`SELECT DISTINCT atendente_nome AS nome FROM chatmix_atendimentos
      WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3 AND atendente_nome IS NOT NULL ORDER BY 1`, [emp, di, df]);
    res.json({ departamentos: deps.map(d => d.nome), atendentes: ats.map(a => a.nome) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Status da sincronização (para a UI saber a cobertura dos dados)
router.get('/sync/status', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id;
    const est = await get('SELECT * FROM chatmix_sync_estado WHERE empresa_id = $1', [emp]) || {};
    const ext = await get(`SELECT COUNT(*)::int AS total, MIN(closed_at) AS mais_antigo, MAX(closed_at) AS mais_recente,
      MAX(atualizado_em) AS ultima_atualizacao FROM chatmix_atendimentos WHERE empresa_id = $1`, [emp]);
    res.json({
      total_registros: ext?.total || 0,
      periodo_coberto: { de: ext?.mais_antigo || null, ate: ext?.mais_recente || null },
      ultima_atualizacao: ext?.ultima_atualizacao || null,
      pagina_atual: est.page || null, ultima_pagina: est.last_page || null, ciclos_completos: est.ciclo || 0,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atendimentos por Departamento (Total, Média/dia, T.M.A) — T.M.E/T.M.R não vêm na API
router.get('/por-departamento', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const dias = diasEntre(di, df);
    const params = [emp, di, df];
    const rows = await all(
      `SELECT COALESCE(departamento, 'Sem departamento') AS nome,
        COUNT(*)::int AS total,
        AVG(EXTRACT(EPOCH FROM (closed_at - created_at))) FILTER (WHERE closed_at IS NOT NULL AND created_at IS NOT NULL) AS tma_seg
       FROM chatmix_atendimentos
       WHERE empresa_id = $1 AND closed_at::date BETWEEN $2 AND $3${filtros(req, params)}
       GROUP BY 1 ORDER BY total DESC`, params);
    const totalGeral = rows.reduce((s, r) => s + r.total, 0) || 1;
    res.json({
      periodo: { di, df, dias },
      itens: rows.map(r => ({
        departamento: r.nome, total: r.total,
        media_dia: Math.round((r.total / dias) * 100) / 100,
        participacao: Math.round((r.total / totalGeral) * 1000) / 10,
        tma_seg: Math.round(r.tma_seg || 0), tma_fmt: fmt(r.tma_seg || 0),
      })),
      total_geral: totalGeral,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Visão geral por Atendente (%, T.M.A, Média/dia, Total)
router.get('/por-atendente', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const dias = diasEntre(di, df);
    const params = [emp, di, df];
    const rows = await all(
      `SELECT COALESCE(atendente_nome, 'Automação/Bot') AS nome,
        COUNT(*)::int AS total,
        AVG(EXTRACT(EPOCH FROM (closed_at - created_at))) FILTER (WHERE closed_at IS NOT NULL AND created_at IS NOT NULL) AS tma_seg
       FROM chatmix_atendimentos
       WHERE empresa_id = $1 AND closed_at::date BETWEEN $2 AND $3${filtros(req, params)}
       GROUP BY 1 ORDER BY total DESC`, params);
    const totalGeral = rows.reduce((s, r) => s + r.total, 0) || 1;
    res.json({
      periodo: { di, df, dias },
      itens: rows.map(r => ({
        atendente: r.nome, total: r.total,
        media_dia: Math.round((r.total / dias) * 100) / 100,
        participacao: Math.round((r.total / totalGeral) * 1000) / 10,
        tma_seg: Math.round(r.tma_seg || 0), tma_fmt: fmt(r.tma_seg || 0),
      })),
      total_geral: totalGeral,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Gera o texto da coluna "Situação" no estilo do relatório do setor
function situacaoTexto(percSat, taxaResp, bateSat, bateTaxa, metaTaxa) {
  if (bateSat && bateTaxa) return 'Atingiu ambas as metas.';
  const sat = percSat >= 98 ? 'Excelente satisfação' : percSat >= 93 ? 'Boa satisfação' : bateSat ? 'Atingiu a satisfação' : 'Satisfação abaixo da meta';
  if (bateSat && !bateTaxa) {
    const falta = metaTaxa - taxaResp;
    const resp = taxaResp >= metaTaxa * 0.9 ? 'próxima da meta de resposta'
      : taxaResp < metaTaxa * 0.75 ? 'baixa taxa de resposta'
        : falta <= 12 ? 'abaixo da meta de resposta' : 'precisa aumentar a taxa de resposta';
    return `${sat}, ${resp}.`;
  }
  if (!bateSat && bateTaxa) return `${sat}, boa taxa de resposta.`;
  return `${sat} e taxa de resposta abaixo da meta.`;
}

// Meta por Atendente (satisfação e taxa de resposta) — no formato do Relatório de Satisfação
router.get('/meta', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const metaSatisfacao = Number(req.query.meta_satisfacao || 90);
    const metaTaxa = Number(req.query.meta_taxa || 55);
    const params = [emp, di, df];
    // Satisfação vem da dedução pelas mensagens (satisfacao_msg): satisfeito|insatisfeito|invalida.
    // Só conta conversas com mensagens já processadas (msgs_sync_em não nulo).
    const rows = await all(
      `SELECT COALESCE(atendente_nome, 'Automação/Bot') AS nome,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE msgs_sync_em IS NOT NULL)::int AS processadas,
        COUNT(*) FILTER (WHERE satisfacao_msg = 'satisfeito')::int AS satisfeitas,
        COUNT(*) FILTER (WHERE satisfacao_msg = 'insatisfeito')::int AS insatisfeitas,
        COUNT(*) FILTER (WHERE satisfacao_msg = 'invalida')::int AS invalidas
       FROM chatmix_atendimentos
       WHERE empresa_id = $1 AND closed_at::date BETWEEN $2 AND $3 AND atendente_nome IS NOT NULL${filtros(req, params)}
       GROUP BY 1 ORDER BY total DESC`, params);
    const itens = rows.map(r => {
      const validas = r.satisfeitas + r.insatisfeitas;           // válidas = satisfeitas + insatisfeitas
      const percSat = validas ? Math.round((r.satisfeitas / validas) * 10000) / 100 : null; // satisfeitas / válidas
      const taxaResp = r.total ? Math.round((validas / r.total) * 10000) / 100 : 0;          // válidas / total
      const bateSat = percSat != null && percSat >= metaSatisfacao;
      const bateTaxa = taxaResp >= metaTaxa;
      return {
        atendente: r.nome, total: r.total, processadas: r.processadas,
        validas, invalidas: r.invalidas, satisfeitas: r.satisfeitas, insatisfeitas: r.insatisfeitas,
        perc_satisfacao: percSat, taxa_resposta: taxaResp,
        bate_satisfacao: bateSat, bate_taxa: bateTaxa,
        bonificacao: bateSat && bateTaxa,
        situacao: percSat == null ? 'Sem pesquisas processadas ainda.' : situacaoTexto(percSat, taxaResp, bateSat, bateTaxa, metaTaxa),
      };
    });
    // Resumo do setor
    const totAtend = itens.reduce((s, i) => s + i.total, 0);
    const totProc = itens.reduce((s, i) => s + i.processadas, 0);
    const totValidas = itens.reduce((s, i) => s + i.validas, 0);
    const totSatisf = itens.reduce((s, i) => s + i.satisfeitas, 0);
    const ambas = itens.filter(i => i.bonificacao);
    const resumo = {
      total_atendimentos: totAtend,
      conversas_processadas: totProc,
      atendentes_avaliados: itens.length,
      media_satisfacao: totValidas ? Math.round((totSatisf / totValidas) * 10000) / 100 : null,
      media_taxa_resposta: totAtend ? Math.round((totValidas / totAtend) * 10000) / 100 : null,
      atingiram_ambas: ambas.length,
      perc_atingiram: itens.length ? Math.round((ambas.length / itens.length) * 1000) / 10 : 0,
      destaques: ambas.map(i => i.atendente),
    };
    res.json({ periodo: { di, df }, metas: { satisfacao: metaSatisfacao, taxa: metaTaxa }, itens, resumo });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ===================== MENSAGENS & CUSTO =====================
// Postgres devolve DATE como objeto Date do JS; formata como YYYY-MM-DD sem virar "Mon Jul 27"
function fmtData(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Config de cobrança (preço por mensagem entregue e data de início da contagem)
async function garantirMsgConfig(emp) {
  let c = await get('SELECT * FROM chatmix_config WHERE empresa_id=$1', [emp]);
  if (!c) {
    const hoje = new Date().toISOString().slice(0, 10);
    await run('INSERT INTO chatmix_config (empresa_id, preco_msg, mensagens_desde) VALUES ($1, 0.0350, $2) ON CONFLICT (empresa_id) DO NOTHING', [emp, hoje]);
    c = await get('SELECT * FROM chatmix_config WHERE empresa_id=$1', [emp]);
  }
  return c;
}

router.get('/msg-config', async (req, res) => {
  try {
    const c = await garantirMsgConfig(req.usuario.empresa_id);
    res.json({ preco_msg: Number(c.preco_msg), mensagens_desde: fmtData(c.mensagens_desde) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/msg-config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantirMsgConfig(req.usuario.empresa_id);
    const preco = req.body.preco_msg != null ? Number(req.body.preco_msg) : undefined;
    const desde = (req.body.mensagens_desde || '').trim() || undefined;
    if (preco != null && !isNaN(preco)) await run('UPDATE chatmix_config SET preco_msg=$2 WHERE empresa_id=$1', [req.usuario.empresa_id, preco]);
    if (desde) await run('UPDATE chatmix_config SET mensagens_desde=$2 WHERE empresa_id=$1', [req.usuario.empresa_id, desde]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mensagens & custo por período (lê do que já foi contado; cobrável = enviadas entregues não-internas)
router.get('/mensagens', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const cfg = await garantirMsgConfig(emp);
    const preco = Number(cfg.preco_msg) || 0.035;

    const params = [emp, di, df];
    const flt = filtros(req, params);
    const base = `FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3${flt}`;

    const [tot, agg, porAtend, porDep, porCanal] = await Promise.all([
      get(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE msgs_sync_em IS NOT NULL)::int contadas ${base}`, params),
      get(`SELECT COALESCE(SUM(msgs_enviadas),0)::int env, COALESCE(SUM(msgs_recebidas),0)::int rec, COALESCE(SUM(msgs_internas),0)::int intn ${base} AND msgs_sync_em IS NOT NULL`, params),
      all(`SELECT COALESCE(atendente_nome,'Automação/Bot') nome, COALESCE(SUM(msgs_enviadas),0)::int env, COALESCE(SUM(msgs_recebidas),0)::int rec, COUNT(*) FILTER (WHERE msgs_sync_em IS NOT NULL)::int conversas ${base} AND msgs_sync_em IS NOT NULL GROUP BY 1 ORDER BY env DESC`, params),
      all(`SELECT COALESCE(departamento,'Sem departamento') nome, COALESCE(SUM(msgs_enviadas),0)::int env, COALESCE(SUM(msgs_recebidas),0)::int rec ${base} AND msgs_sync_em IS NOT NULL GROUP BY 1 ORDER BY env DESC`, params),
      all(`SELECT COALESCE(canal,'—') nome, COALESCE(SUM(msgs_enviadas),0)::int env, COALESCE(SUM(msgs_recebidas),0)::int rec ${base} AND msgs_sync_em IS NOT NULL GROUP BY 1 ORDER BY env DESC`, params),
    ]);
    const custo = e => Math.round((e || 0) * preco * 100) / 100;
    res.json({
      periodo: { di, df }, preco_msg: preco,
      mensagens_desde: fmtData(cfg.mensagens_desde),
      cobertura: { total_conversas: tot?.total || 0, conversas_contadas: tot?.contadas || 0 },
      totais: {
        enviadas: agg?.env || 0, recebidas: agg?.rec || 0, internas: agg?.intn || 0,
        trocadas: (agg?.env || 0) + (agg?.rec || 0),
        custo: custo(agg?.env),
      },
      por_atendente: porAtend.map(r => ({ nome: r.nome, enviadas: r.env, recebidas: r.rec, conversas: r.conversas, custo: custo(r.env) })),
      por_departamento: porDep.map(r => ({ nome: r.nome, enviadas: r.env, recebidas: r.rec, custo: custo(r.env) })),
      por_canal: porCanal.map(r => ({ nome: r.nome, enviadas: r.env, recebidas: r.rec, custo: custo(r.env) })),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Média de conversas por dia / semana / mês
router.get('/medias', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const dias = diasEntre(di, df);
    const params = [emp, di, df];
    const flt = filtros(req, params);
    const base = `FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3${flt}`;
    const tot = await get(`SELECT COUNT(*)::int total, COUNT(DISTINCT closed_at::date)::int dias_com_dados ${base}`, params);
    const total = tot?.total || 0;
    const porDep = await all(`SELECT COALESCE(departamento,'Sem departamento') nome, COUNT(*)::int total ${base} GROUP BY 1 ORDER BY total DESC`, params);
    const r1 = n => Math.round(n * 10) / 10;
    res.json({
      periodo: { di, df, dias },
      total_conversas: total,
      media_dia: r1(total / dias),
      media_semana: r1(total / (dias / 7)),
      media_mes: r1(total / (dias / 30)),
      por_departamento: porDep.map(d => ({ nome: d.nome, total: d.total, media_dia: r1(d.total / dias) })),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
