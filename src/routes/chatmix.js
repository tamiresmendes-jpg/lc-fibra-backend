const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { getConfig, resolverWebhook, postWebhookImagem } = require('../utils/discord');
const { cifrar, decifrar } = require('../utils/segredos');
const { buscarPermsEfetivas, temPermissaoServer } = require('../utils/permissoes');

router.use(autenticar);

// A Meta de Atendimento mostra satisfação e bônus por pessoa — cada departamento só
// pode ser visto por quem tem a permissão DAQUELE departamento, ou "meta-geral"
// (concedida à mão para quem deve ver todos). Sem isso, ANY usuário logado
// conseguia ver a meta de qualquer setor, inclusive de colegas de outro departamento.
async function podeVerMetaAtendimento(req, departamento) {
  if (req.usuario.perfil === 'admin') return true;
  let ownPerms = null;
  try {
    const row = await get('SELECT permissoes_modulos FROM usuarios WHERE id=$1', [req.usuario.id]);
    if (row?.permissoes_modulos) ownPerms = JSON.parse(row.permissoes_modulos);
  } catch { /* usa só os grupos */ }
  const perms = await buscarPermsEfetivas(req.usuario.id, req.usuario.empresa_id, ownPerms);
  if (temPermissaoServer(perms, 'atendimentos.meta-geral', 'visualizar')) return true;
  const chave = departamento === 'Suporte' ? 'atendimentos.meta-callcenter'
    : departamento === 'Financeiro' ? 'atendimentos.meta-financeiro' : null;
  return chave ? temPermissaoServer(perms, chave, 'visualizar') : false;
}
function exigirVerMetaAtendimento(origemDepto) {
  return async (req, res, next) => {
    try {
      const dep = (origemDepto(req) || '').trim();
      // Sem departamento = visão combinada (Financeiro + Call Center juntos):
      // só quem tem acesso geral pode ver — nunca dá pra "adivinhar" um departamento aqui.
      if (!dep) {
        if (req.usuario.perfil === 'admin' || await podeVerMetaAtendimento(req, '__geral__')) return next();
        return res.status(403).json({ erro: 'Você não tem permissão para ver a meta combinada. Escolha um departamento.' });
      }
      if (await podeVerMetaAtendimento(req, dep)) return next();
      return res.status(403).json({ erro: 'Você não tem permissão para ver a meta deste departamento.' });
    } catch { return res.status(500).json({ erro: 'Erro ao verificar permissão.' }); }
  };
}
const depDaQuery = req => req.query.departamento;
const depDoBody = req => req.body.departamento;

// Mesma regra da Meta de Atendimento, mas pra tudo que é monitoramento em tempo
// real (Status ao Vivo, Por Atendente, Por Departamento, Dashboard, Mensagens):
// cada setor só pode pedir dado do PRÓPRIO departamento — nunca de outro, mesmo
// trocando o filtro na tela — e quem tem "meta-geral" (líder/gestor) vê qualquer
// um, inclusive a visão combinada (sem filtro).
async function departamentosPermitidosAoVivo(req) {
  if (req.usuario.perfil === 'admin') return { geral: true };
  let ownPerms = null;
  try {
    const row = await get('SELECT permissoes_modulos FROM usuarios WHERE id=$1', [req.usuario.id]);
    if (row?.permissoes_modulos) ownPerms = JSON.parse(row.permissoes_modulos);
  } catch { /* usa só os grupos */ }
  const perms = await buscarPermsEfetivas(req.usuario.id, req.usuario.empresa_id, ownPerms);
  if (temPermissaoServer(perms, 'atendimentos.meta-geral', 'visualizar')) return { geral: true };
  const deps = [];
  if (temPermissaoServer(perms, 'atendimentos.meta-financeiro', 'visualizar')) deps.push('Financeiro');
  if (temPermissaoServer(perms, 'atendimentos.meta-callcenter', 'visualizar')) deps.push('Suporte');
  return { geral: false, deps };
}
function exigirEFiltrarDepartamentoAoVivo(campo = 'departamento') {
  return async (req, res, next) => {
    try {
      const perm = await departamentosPermitidosAoVivo(req);
      if (perm.geral) return next(); // vê qualquer departamento, inclusive "todos" (filtro vazio)
      if (!perm.deps.length) return res.status(403).json({ erro: 'Você não tem permissão para ver os dados de atendimento.' });
      const pedido = (req.query[campo] || '').trim();
      // Pediu um departamento que não é o dele (ou nenhum = "todos" combinado):
      // troca à força pelo departamento que ele realmente pode ver, sem 403 —
      // a tela simplesmente mostra o próprio setor em vez do que foi pedido.
      req.query[campo] = perm.deps.includes(pedido) ? pedido : perm.deps[0];
      req.deptosPermitidos = perm; // rotas que sempre trazem TODOS os deptos numa lista (ex.: /tempos-departamento) usam isso pra filtrar a resposta
      next();
    } catch { res.status(500).json({ erro: 'Erro ao verificar permissão.' }); }
  };
}

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
    // Credenciais do PAINEL (usuário dedicado de integração): permitem renovar sozinho o
    // painel_token, que expira de tempos em tempos. A senha é guardada criptografada.
    await run(`ALTER TABLE integracao_chatmix ADD COLUMN IF NOT EXISTS painel_email TEXT`);
    await run(`ALTER TABLE integracao_chatmix ADD COLUMN IF NOT EXISTS painel_senha TEXT`);
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
    res.json({
      base_url: cfg.base_url || BASE_PADRAO, tem_token: !!cfg.token,
      tem_painel_token: !!cfg.painel_token, survey_id: cfg.survey_id || null,
      painel_email: cfg.painel_email || '', tem_painel_senha: !!cfg.painel_senha,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Testa o login automático no painel (usuário de integração) e já renova o token.
router.post('/painel/testar-login', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const token = await loginPainel(req.usuario.empresa_id);
    if (!token) return res.json({ ok: false, erro: 'Não foi possível entrar no painel. Confira o e-mail e a senha do usuário de integração.' });
    res.json({ ok: true, mensagem: 'Login OK — token do painel renovado automaticamente.' });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const { base_url, token, painel_token, survey_id, painel_email, painel_senha } = req.body;
    const atual = await get('SELECT token, painel_token, survey_id, painel_email, painel_senha FROM integracao_chatmix WHERE empresa_id = $1', [req.usuario.empresa_id]);
    const tokenFinal = (token && token.trim()) ? token.trim() : (atual?.token || null);
    // painel_token/survey_id: só sobrescreve se vier preenchido (deixa em branco pra manter)
    let pt = (painel_token && painel_token.trim()) ? painel_token.trim() : (atual?.painel_token || null);
    if (pt) pt = pt.replace(/^Bearer\s+/i, '').trim(); // aceita colar com ou sem "Bearer "
    const sid = (survey_id !== undefined && survey_id !== null && String(survey_id).trim() !== '') ? parseInt(survey_id, 10) : (atual?.survey_id || null);
    // Credenciais do usuário de integração (renovam o token sozinhas). Senha vai criptografada.
    const pEmail = (painel_email !== undefined && painel_email !== null && String(painel_email).trim() !== '')
      ? String(painel_email).trim() : (atual?.painel_email || null);
    const pSenha = (painel_senha && String(painel_senha).trim())
      ? cifrar(String(painel_senha).trim()) : (atual?.painel_senha || null);
    await run(
      `INSERT INTO integracao_chatmix (empresa_id, base_url, token, painel_token, survey_id, painel_email, painel_senha, auth_tipo, header_nome, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'header','X-auth', NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET base_url=EXCLUDED.base_url, token=EXCLUDED.token,
         painel_token=EXCLUDED.painel_token, survey_id=EXCLUDED.survey_id,
         painel_email=EXCLUDED.painel_email, painel_senha=EXCLUDED.painel_senha,
         auth_tipo='header', header_nome='X-auth', atualizado_em=NOW()`,
      [req.usuario.empresa_id, (base_url || '').trim() || BASE_PADRAO, tokenFinal, pt, sid, pEmail, pSenha]
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
router.get('/indicadores', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
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

    // Satisfação OFICIAL do painel. NÃO usar AVG(nota) do banco: no Chatmix "nota 5" só quer
    // dizer que o cliente RESPONDEU a pesquisa (todas as notas locais são 5), o que dava
    // sempre média 5 e escondia os insatisfeitos.
    const jsat = await satisfacaoOficial(emp, di, df);
    let media = null, respostas = 0, satisfeitas = 0, insatisfeitas = 0, invalidas = 0, pctSat = null;
    if (jsat) {
      let somaMedia = 0, peso = 0;
      for (const v of Object.values(jsat)) {
        satisfeitas += v.sat || 0; insatisfeitas += v.insat || 0; invalidas += v.inval || 0;
        if (v.media != null) { somaMedia += Number(v.media) * (v.total || 1); peso += (v.total || 1); }
      }
      respostas = satisfeitas + insatisfeitas + invalidas;
      media = peso ? Math.round((somaMedia / peso) * 100) / 100 : null;
      const validas = satisfeitas + insatisfeitas;
      pctSat = validas ? Math.round((satisfeitas / validas) * 1000) / 10 : null;
    }

    res.json({
      periodo: { data_inicial: di, data_final: df },
      canais: canaisAll.map(c => c.n),
      departamentos: depsAll.map(d => d.n),
      sincronizando, min_coberto: minCoberto,
      painel: statusPainel(emp),
      cards: {
        total: cardRow?.total || 0,
        tma_seg: Math.round(cardRow?.tma || 0), tma_fmt: fmtDuracao(cardRow?.tma || 0),
        satisfacao_media: media, satisfacao_respostas: respostas,
        satisfacao_pct: pctSat,
        ao_vivo_aguardando: count?.waiting ?? null,
        ao_vivo_automacao: count?.automation ?? null,
        ao_vivo_atendimento: count?.progress ?? null,
      },
      satisfacao: {
        media, respostas, pct_satisfacao: pctSat,
        satisfeitas, insatisfeitas, invalidas,
        fonte: jsat ? 'oficial' : 'indisponivel',
        distribuicao: [
          { nota: 'Satisfeito', qtd: satisfeitas },
          { nota: 'Insatisfeito', qtd: insatisfeitas },
          { nota: 'Inválida', qtd: invalidas },
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

router.get('/status', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
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

    // Métricas de espera (fila) e maior espera — considera SOMENTE quem está na fila (aguardando),
    // usando last_activity (entrada na fila). Atendimentos em andamento NÃO entram aqui — senão um
    // chat aberto há dias infla o "maior espera" (ex.: 161d) e não muda ao filtrar o departamento.
    const esperas = aguardando.map(a => segDesde(a.last_activity || a.created_at)).filter(x => x != null);
    const esperaMedia = esperas.length ? Math.round(esperas.reduce((s, x) => s + x, 0) / esperas.length) : 0;
    const maiorEspera = esperas.length ? Math.max(...esperas) : 0;

    const emAnd = depFiltro ? andamento.length : (count?.progress ?? andamento.length);
    const emEsp = depFiltro ? aguardando.length : (count?.waiting ?? aguardando.length);
    const emAuto = depFiltro ? automacao.length : (count?.automation ?? automacao.length);
    const encHoje = encHojeTot?.n || 0;
    const ini = iniHoje?.n || 0;

      // Sem permissão geral, o próprio dropdown de departamento na tela só mostra
      // o(s) setor(es) que a pessoa realmente pode escolher (nada de listar todos
      // e o servidor ignorar o que foi selecionado por baixo dos panos).
      const listaDeps = (req.deptosPermitidos && !req.deptosPermitidos.geral)
        ? req.deptosPermitidos.deps
        : mapaDeps.map(d => d.nome).sort();
    res.json({
      atualizado_em: new Date().toISOString(),
      departamentos: listaDeps,
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
      // Ao filtrar um departamento, mostra só o TIME do setor (pelo nome do atendente).
      // O Chatmix distribui tickets entre times, então sem esse filtro apareceria gente de
      // outro setor que pegou um ticket do departamento selecionado.
      por_atendente: Object.values(porAtend)
        .filter(a => !depFiltro || deptDeNome(a.atendente) === deptDeNome(depFiltro))
        .map(a => (!a.departamento || a.departamento === '—' || String(a.departamento).startsWith('Depto') || a.departamento === 'Sem departamento')
          ? { ...a, departamento: deptDeNome(a.atendente) } : a)
        .sort((a, b) => (b.em_andamento - a.em_andamento) || (b.encerrados_hoje - a.encerrados_hoje)),
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
// Semana da Meta: começa no DOMINGO e termina no SÁBADO (padrão da empresa)
function semanaAtual() {
  const h = new Date();
  const dow = h.getDay();                 // 0=domingo
  const dom = new Date(h); dom.setDate(h.getDate() - dow);
  const sab = new Date(dom); sab.setDate(dom.getDate() + 6);
  const iso = d => d.toISOString().slice(0, 10);
  return { di: iso(dom), df: iso(sab) };
}
// Período da Meta: usa o que veio na query; senão, a semana atual (domingo→sábado)
function periodoMeta(req) {
  if (req.query.data_inicial || req.query.data_final) return periodo(req);
  return semanaAtual();
}
// Nome completo do atendente, buscado no cadastro real (usuarios) — o Chatmix só
// manda "Clara Suporte", sem sobrenome. Muita gente aqui tem nome composto que
// começa com "Ana" (Ana Clara, Ana Maiza, Ana Cleiza...), então casar só pela
// PRIMEIRA palavra perdia esses casos. Em vez disso, procura o nome do Chatmix
// (sem o departamento) como SEQUÊNCIA DE PALAVRAS dentro do nome completo —
// "Eduarda Reis" só bate com "Maria EDUARDA REIS Ramos", não com outra Eduarda.
// Se mais de um colaborador ativo bater, fica ambíguo e mantém o nome do Chatmix,
// para nunca atribuir o nome de uma pessoa a outra por engano.
const semAcentoAt = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const SUFIXOS_DEPTO_AT = ['financeiro', 'suporte', 'comercial', 'noc', 'recepcao', 'remocao', 'cobranca'];
function nomeChatmixSemDepto(atendenteNome) {
  const tokens = semAcentoAt(atendenteNome).split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && SUFIXOS_DEPTO_AT.includes(tokens[tokens.length - 1])) tokens.pop();
  return tokens;
}
function contemSequencia(tokensNomeCompleto, tokensBusca) {
  for (let i = 0; i <= tokensNomeCompleto.length - tokensBusca.length; i++) {
    if (tokensBusca.every((t, j) => tokensNomeCompleto[i + j] === t)) return true;
  }
  return false;
}
async function candidatosDeNomes(empresa_id) {
  const us = await all('SELECT nome, email FROM usuarios WHERE empresa_id=$1 AND ativo=1', [empresa_id]);
  return us.map(u => ({ nome: u.nome, email: u.email, tokens: semAcentoAt(u.nome).split(/\s+/).filter(Boolean) }));
}
function nomeCompletoDe(candidatos, atendenteNome) {
  const busca = nomeChatmixSemDepto(atendenteNome);
  if (!busca.length) return atendenteNome;
  const achados = candidatos.filter(c => contemSequencia(c.tokens, busca));
  return achados.length === 1 ? achados[0].nome : atendenteNome;
}
// E-mail do usuário do sistema casado com o nome do atendente (mesma resolução
// do nome completo) — usado pra filtrar "só a própria linha" na Meta.
function emailDoAtendente(candidatos, atendenteNome) {
  const busca = nomeChatmixSemDepto(atendenteNome);
  if (!busca.length) return null;
  const achados = candidatos.filter(c => contemSequencia(c.tokens, busca));
  return achados.length === 1 ? achados[0].email : null;
}

// Departamento derivado do NOME do atendente (ex.: "Maiza Suporte" → Suporte)
const DEPT_SQL = `CASE
  WHEN atendente_nome ILIKE '%financeiro%' THEN 'Financeiro'
  WHEN atendente_nome ILIKE '%suporte%' THEN 'Suporte'
  WHEN atendente_nome ILIKE '%recep%' OR atendente_nome ILIKE '%cancel%' THEN 'Recepção'
  WHEN atendente_nome ILIKE '%noc%' THEN 'NOC'
  WHEN atendente_nome ILIKE '%comercial%' THEN 'Comercial'
  WHEN atendente_nome ILIKE '%remo%' OR atendente_nome ILIKE '%cobran%' THEN 'Cobrança/Remoção'
  ELSE 'Outros' END`;
// Estado do token do painel por empresa, para a tela avisar quando ele expira
// (o token do painel do Chatmix vence e aí os relatórios oficiais param de vir).
const _painelStatus = new Map();
function marcarPainel(empresaId, ok, motivo) { _painelStatus.set(empresaId, { ok, motivo }); }
function statusPainel(empresaId) {
  return _painelStatus.get(empresaId) || null; // null = ainda não consultado nesta execução
}

// Faz login no painel do Chatmix com o usuário de integração e guarda o token novo.
// Retorna o token ou null. Evita logins simultâneos (uma promessa compartilhada por empresa).
const _loginEmAndamento = new Map();
async function loginPainel(empresaId) {
  if (_loginEmAndamento.has(empresaId)) return _loginEmAndamento.get(empresaId);
  const p = (async () => {
    const cfg = await get('SELECT painel_email, painel_senha FROM integracao_chatmix WHERE empresa_id=$1', [empresaId]);
    const email = cfg?.painel_email;
    const senha = decifrar(cfg?.painel_senha);
    if (!email || !senha) return null;
    try {
      const r = await fetch('https://srv6.chatmix.com.br/api_v2/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        body: JSON.stringify({ email, password: senha }),
      });
      if (r.status !== 200) { console.warn('[Chatmix] login do painel falhou:', r.status); return null; }
      const j = await r.json().catch(() => null);
      // O formato exato pode variar entre versões — procura o token nos campos usuais.
      const token = j?.token || j?.access_token || j?.data?.token || j?.data?.access_token
        || j?.data?.user?.token || (typeof j?.data === 'string' ? j.data : null);
      if (!token) { console.warn('[Chatmix] login OK mas token não encontrado na resposta'); return null; }
      const limpo = String(token).replace(/^Bearer\s+/i, '');
      await run('UPDATE integracao_chatmix SET painel_token=$1 WHERE empresa_id=$2', [limpo, empresaId]);
      console.log('[Chatmix] token do painel renovado automaticamente');
      return limpo;
    } catch (e) { console.warn('[Chatmix] erro no login do painel:', e.message); return null; }
  })().finally(() => _loginEmAndamento.delete(empresaId));
  _loginEmAndamento.set(empresaId, p);
  return p;
}

// Chamada autenticada ao painel do Chatmix. Se o token expirou (401/403) e existem credenciais
// do usuário de integração, faz login e repete a chamada uma vez — sem intervenção manual.
async function chamarPainel(empresaId, url, jaTentouLogin = false) {
  const cfg = await get('SELECT painel_token FROM integracao_chatmix WHERE empresa_id=$1', [empresaId]);
  let token = cfg?.painel_token;
  if (!token) {
    token = await loginPainel(empresaId);
    if (!token) { marcarPainel(empresaId, false, 'nao_configurado'); return null; }
    jaTentouLogin = true;
  }
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, 'User-Agent': 'Mozilla/5.0' } });
    if (r.status === 401 || r.status === 403) {
      if (!jaTentouLogin && await loginPainel(empresaId)) return chamarPainel(empresaId, url, true);
      marcarPainel(empresaId, false, 'token_invalido');
      return null;
    }
    if (r.status !== 200) { marcarPainel(empresaId, false, 'erro_' + r.status); return null; }
    const j = await r.json().catch(() => null);
    marcarPainel(empresaId, true, null);
    return j;
  } catch { marcarPainel(empresaId, false, 'falha_conexao'); return null; }
}

// Overview OFICIAL de atendentes (TMA/TME/TMR/TMR média/Total/Média) do painel Chatmix.
async function overviewOficial(empresaId, di, df) {
  return chamarPainel(empresaId,
    `https://srv6.chatmix.com.br/api-v2/reports/attendants/overview/v2?page=1&with=closed&datestart=${di}%2000:00:00&dateend=${df}%2023:59:59`);
}

// Relatório OFICIAL por departamento (total/média/TMA/TME) do painel Chatmix.
async function departamentosOficial(empresaId, di, df) {
  return chamarPainel(empresaId,
    `https://srv6.chatmix.com.br/api-v2/reports/attendance/department?datestart=${di}%2000:00:00&dateend=${df}%2023:59:59`);
}

// Busca a satisfação OFICIAL do painel Chatmix (endpoint interno de relatório).
// Retorna mapa { nomeMinusculo: { sat, insat, inval, total, media } } ou null se não configurado/falhar.
async function satisfacaoOficial(empresaId, di, df) {
  const cfg = await get('SELECT survey_id FROM integracao_chatmix WHERE empresa_id=$1', [empresaId]);
  if (!cfg?.survey_id) { marcarPainel(empresaId, false, 'sem_survey_id'); return null; }
  const j = await chamarPainel(empresaId,
    `https://srv6.chatmix.com.br/api_v2/api/v1/reports/replySatisfactionSurvey/attendants?satisfaction=${cfg.survey_id}&datestart=${di}%2000:00:00&dateend=${df}%2023:59:59`);
  if (!j) return null;
  const arr = j?.data?.first || [];
  const mapa = {};
  for (const a of arr) {
    const nome = ((a.user_all?.first_name || '') + ' ' + (a.user_all?.last_name || '')).trim().toLowerCase();
    mapa[nome] = { sat: a.reply_5 || 0, insat: a.reply_1 || 0, inval: a.reply_0 || 0, total: a.total || 0, media: a.average };
  }
  return mapa;
}
function deptDeNome(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('financeiro')) return 'Financeiro';
  if (n.includes('suporte')) return 'Suporte';
  if (n.includes('recep') || n.includes('cancel')) return 'Recepção';
  if (n.includes('noc')) return 'NOC';
  if (n.includes('comercial')) return 'Comercial';
  if (n.includes('remo') || n.includes('cobran')) return 'Cobrança/Remoção';
  return 'Outros';
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
  if (deps.length) { params.push(deps); sql += ` AND (${DEPT_SQL}) = ANY($${params.length})`; }
  if (ats.length) { params.push(ats); sql += ` AND COALESCE(atendente_nome,'Automação/Bot') = ANY($${params.length})`; }
  return sql;
}

// Listas para os seletores (departamentos e atendentes sincronizados no período)
router.get('/listas', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const deps = await all(`SELECT DISTINCT (${DEPT_SQL}) AS nome FROM chatmix_atendimentos
      WHERE empresa_id=$1 AND closed_at::date BETWEEN $2 AND $3 AND atendente_nome IS NOT NULL ORDER BY 1`, [emp, di, df]);
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
      `SELECT (${DEPT_SQL}) AS nome,
        COUNT(*)::int AS total,
        AVG(EXTRACT(EPOCH FROM (closed_at - created_at))) FILTER (WHERE closed_at IS NOT NULL AND created_at IS NOT NULL) AS tma_seg
       FROM chatmix_atendimentos
       WHERE empresa_id = $1 AND closed_at::date BETWEEN $2 AND $3 AND atendente_nome IS NOT NULL${filtros(req, params)}
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

// TEMPOS por DEPARTAMENTO (Total/Média-dia/TMA/TME) — fonte OFICIAL do painel Chatmix
router.get('/tempos-departamento', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const [j, jsat] = await Promise.all([departamentosOficial(emp, di, df), satisfacaoOficial(emp, di, df)]);
    if (!j) return res.json({ periodo: { di, df }, geral: null, departamentos: [], painel: statusPainel(emp) });

    // Satisfação por departamento: o painel só entrega por ATENDENTE, então agregamos pelo
    // setor deduzido do nome dele (ver deptDeNome). Fiel em setores "fechados" (Suporte,
    // Financeiro, Comercial); aproximado onde a pessoa atende tickets de outro setor.
    const satPorDept = {};
    if (jsat) {
      for (const [nome, v] of Object.entries(jsat)) {
        const d = deptDeNome(nome);
        const o = satPorDept[d] || (satPorDept[d] = { sat: 0, insat: 0, inval: 0, somaMedia: 0, nAtend: 0 });
        o.sat += v.sat || 0; o.insat += v.insat || 0; o.inval += v.inval || 0;
        if (v.media != null) { o.somaMedia += Number(v.media) * (v.total || 1); o.nAtend += (v.total || 1); }
      }
    }
    const satDe = (nomeDept) => {
      const o = satPorDept[deptDeNome(nomeDept)];
      if (!o) return { satisfeito: null, insatisfeito: null, invalida: null, media_nota: null, pct_satisfacao: null };
      const validas = o.sat + o.insat;
      return {
        satisfeito: o.sat, insatisfeito: o.insat, invalida: o.inval,
        media_nota: o.nAtend ? Math.round((o.somaMedia / o.nAtend) * 100) / 100 : null,
        pct_satisfacao: validas ? Math.round((o.sat / validas) * 1000) / 10 : null,
      };
    };

    let departamentos = (j.data || []).map(d => ({
      departamento: d.name, total: d.total || 0, media_dia: d.daily_average ?? 0,
      tma: d.tma || '00:00:00', tme: d.tme || '00:00:00',
      ...satDe(d.name),
    })).sort((a, b) => b.total - a.total);
    // Essa rota sempre trouxe TODOS os departamentos numa lista só — sem geral,
    // corta pra só o(s) que a pessoa tem permissão de ver.
    if (req.deptosPermitidos && !req.deptosPermitidos.geral) {
      departamentos = departamentos.filter(d => req.deptosPermitidos.deps.includes(d.departamento));
    }

    // Geral: soma de todos os atendentes (não só dos departamentos listados)
    let gSat = 0, gIns = 0, gInv = 0, gSoma = 0, gN = 0;
    if (jsat) for (const v of Object.values(jsat)) {
      gSat += v.sat || 0; gIns += v.insat || 0; gInv += v.inval || 0;
      if (v.media != null) { gSoma += Number(v.media) * (v.total || 1); gN += (v.total || 1); }
    }
    const gValidas = gSat + gIns;
    const g = j.overview || {};
    // "Geral" é a soma de TODOS os departamentos — sem permissão geral, não faz sentido
    // mostrar (misturaria dado de setor que a pessoa não pode ver com o que ela vê).
    const podeVerGeral = !req.deptosPermitidos || req.deptosPermitidos.geral;
    res.json({
      periodo: { di, df },
      geral: podeVerGeral ? {
        total: g.total || 0, media_dia: g.average ?? 0, tma: g.tma || '00:00:00', tme: g.tme || '00:00:00',
        satisfeito: jsat ? gSat : null, insatisfeito: jsat ? gIns : null, invalida: jsat ? gInv : null,
        media_nota: gN ? Math.round((gSoma / gN) * 100) / 100 : null,
        pct_satisfacao: gValidas ? Math.round((gSat / gValidas) * 1000) / 10 : null,
      } : null,
      departamentos, painel: statusPainel(emp),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// TEMPOS por atendente (TMA/TME/TMR/TMR média/Total/Média-dia) — fonte OFICIAL do painel Chatmix
router.get('/tempos', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const [j, jsat] = await Promise.all([overviewOficial(emp, di, df), satisfacaoOficial(emp, di, df)]);
    if (!j) return res.json({ periodo: { di, df }, geral: null, atendentes: [], painel: statusPainel(emp) });
    const dep = (req.query.departamento || '').trim();
    const ats = listaParam(req.query.atendente);
    let arr = (j.data || []).map(a => {
      const nome = ((a.user?.first_name || '') + ' ' + (a.user?.last_name || '')).trim();
      // Satisfação OFICIAL do atendente: nota média (número) e % de satisfação (satisfeitos ÷ válidas)
      const s = jsat ? jsat[nome.toLowerCase()] : null;
      const validas = s ? (s.sat + s.insat) : 0;
      return {
        atendente: nome, departamento: deptDeNome(nome),
        total: a.total || 0, media_dia: a.avg ?? 0,
        tma: a.tma || '00:00:00', tme: a.tme || '00:00:00', tmr: a.tmr || '00:00:00', tmr_avg: a.tmr_avg || '00:00:00',
        percentual: a.percentage != null ? Math.round(a.percentage * 1000) / 10 : null,
        satisfeito: s ? s.sat : null, insatisfeito: s ? s.insat : null, invalida: s ? s.inval : null,
        media_nota: s && s.media != null ? Math.round(Number(s.media) * 100) / 100 : null,
        pct_satisfacao: validas ? Math.round((s.sat / validas) * 1000) / 10 : null,
      };
    });
    if (dep) arr = arr.filter(a => a.departamento === dep);
    if (ats.length) arr = arr.filter(a => ats.includes(a.atendente));
    arr.sort((x, y) => y.total - x.total);

    // GERAL: se houver filtro, recalcula a partir dos atendentes filtrados (média ponderada
    // pelo total de atendimentos). Sem filtro, usa o overview oficial do painel.
    const paraSeg = (t) => { const p = String(t || '0:0:0').split(':').map(n => parseInt(n, 10) || 0); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); };
    const segFmt = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; const p = n => String(n).padStart(2, '0'); return `${p(h)}:${p(m)}:${p(x)}`; };
    let geral;
    if (dep || ats.length) {
      const tot = arr.reduce((s, a) => s + a.total, 0);
      const wavg = campo => tot ? arr.reduce((s, a) => s + paraSeg(a[campo]) * a.total, 0) / tot : 0;
      const dias = diasEntre(di, df);
      geral = { total: tot, media_dia: dias ? Math.round((tot / dias) * 10) / 10 : tot, tma: segFmt(wavg('tma')), tme: segFmt(wavg('tme')), tmr: segFmt(wavg('tmr')), tmr_avg: segFmt(wavg('tmr_avg')) };
    } else {
      const g = j.overview || {};
      geral = { total: g.total || 0, media_dia: g.avg ?? 0, tma: g.tma || '00:00:00', tme: g.tme || '00:00:00', tmr: g.tmr || '00:00:00', tmr_avg: g.tmr_avg || '00:00:00' };
    }
    // Satisfação do conjunto exibido (respeita os filtros de departamento/atendente)
    const gSat = arr.reduce((s, a) => s + (a.satisfeito || 0), 0);
    const gIns = arr.reduce((s, a) => s + (a.insatisfeito || 0), 0);
    const gInv = arr.reduce((s, a) => s + (a.invalida || 0), 0);
    const gValidas = gSat + gIns;
    const pesoNota = arr.reduce((s, a) => s + (a.media_nota != null ? a.media_nota * a.total : 0), 0);
    const pesoTot = arr.reduce((s, a) => s + (a.media_nota != null ? a.total : 0), 0);
    geral.satisfeito = jsat ? gSat : null;
    geral.insatisfeito = jsat ? gIns : null;
    geral.invalida = jsat ? gInv : null;
    geral.media_nota = pesoTot ? Math.round((pesoNota / pesoTot) * 100) / 100 : null;
    geral.pct_satisfacao = gValidas ? Math.round((gSat / gValidas) * 1000) / 10 : null;

    res.json({ periodo: { di, df }, geral, atendentes: arr, painel: statusPainel(emp) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// TEMPOS para o card do STATUS AO VIVO.
// Os cards (geral) usam o relatório OFICIAL por DEPARTAMENTO (medida dos atendimentos: Financeiro TMA 00:43:14).
// TMR / TMR média não existem no relatório por departamento — vêm do relatório por atendente.
// A lista "atendentes" traz TMA/TME/TMR de cada atendente (para a tabela Por atendente do Status).
router.get('/tempos-status', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodo(req);
    const dep = (req.query.departamento || '').trim();
    const [jd, jo, jsat] = await Promise.all([departamentosOficial(emp, di, df), overviewOficial(emp, di, df), satisfacaoOficial(emp, di, df)]);
    // Sem resposta do painel (token expirado/não configurado): devolve 200 com os campos
    // vazios + o motivo, para a tela mostrar "—" nos cards E o aviso do que aconteceu.
    if (!jd && !jo) {
      return res.json({ periodo: { di, df }, geral: null, satisfacao: null, atendentes: [], painel: statusPainel(emp) });
    }

    const paraSeg = (t) => { const p = String(t || '0:0:0').split(':').map(n => parseInt(n, 10) || 0); return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0); };
    const segFmt = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; const p = n => String(n).padStart(2, '0'); return `${p(h)}:${p(m)}:${p(x)}`; };

    // Cards TMA/TME/Total/Média — relatório por DEPARTAMENTO (medida oficial dos atendimentos)
    let tma = '00:00:00', tme = '00:00:00', total = 0, media_dia = 0;
    if (jd) {
      if (dep) {
        const row = (jd.data || []).find(d => d.name === dep) || (jd.data || []).find(d => deptDeNome(d.name) === deptDeNome(dep));
        if (row) { tma = row.tma || tma; tme = row.tme || tme; total = row.total || 0; media_dia = row.daily_average ?? 0; }
      } else {
        const g = jd.overview || {};
        tma = g.tma || tma; tme = g.tme || tme; total = g.total || 0; media_dia = g.average ?? 0;
      }
    }
    media_dia = Math.round((Number(media_dia) || 0) * 10) / 10; // evita 1388.8888888…

    // Lista por atendente (TMA/TME/TMR de cada um) — relatório por atendente.
    // NÃO filtra pelo sufixo do nome: quem aparece na tabela do Status é controlado pela lista
    // AO VIVO (departamento real do atendimento). Aqui devolvemos TODOS para o cruzamento por nome.
    let atendentes = [];
    let tmr = '00:00:00', tmr_avg = '00:00:00';
    if (jo) {
      atendentes = (jo.data || []).map(a => {
        const nome = ((a.user?.first_name || '') + ' ' + (a.user?.last_name || '')).trim();
        const s = (jsat && jsat[nome.toLowerCase()]) || null;
        return {
          atendente: nome, departamento: deptDeNome(nome),
          tma: a.tma || '00:00:00', tme: a.tme || '00:00:00', tmr: a.tmr || '00:00:00', tmr_avg: a.tmr_avg || '00:00:00', total: a.total || 0,
          satisfeito: s ? s.sat : null, insatisfeito: s ? s.insat : null, invalida: s ? s.inval : null,
        };
      }).sort((x, y) => y.total - x.total);
      // TMR/TMR média dos cards: geral = overview do painel; com filtro = média ponderada dos atendentes do setor
      if (dep) {
        const doSetor = atendentes.filter(a => a.departamento === deptDeNome(dep));
        const tot = doSetor.reduce((s, a) => s + a.total, 0);
        const wavg = campo => tot ? doSetor.reduce((s, a) => s + paraSeg(a[campo]) * a.total, 0) / tot : 0;
        tmr = segFmt(wavg('tmr')); tmr_avg = segFmt(wavg('tmr_avg'));
      } else {
        const g = jo.overview || {};
        tmr = g.tmr || tmr; tmr_avg = g.tmr_avg || tmr_avg;
      }
    }

    // Satisfação OFICIAL (satisfeito/insatisfeito/inválida) + % sobre o total de atendimentos do período.
    // Numerador vem do relatório de satisfação por atendente (agrupado pelo setor do nome);
    // denominador é o Total do período (relatório por departamento) — mesmo número do card "Total".
    let satisfacao = null;
    if (jsat) {
      let sat = 0, insat = 0, inval = 0;
      for (const [nome, v] of Object.entries(jsat)) {
        if (dep && deptDeNome(nome) !== deptDeNome(dep)) continue;
        sat += v.sat || 0; insat += v.insat || 0; inval += v.inval || 0;
      }
      const respostas = sat + insat + inval;
      const base = total || 0;
      const pct = n => base ? Math.round((n / base) * 1000) / 10 : 0;
      satisfacao = {
        satisfeito: sat, insatisfeito: insat, invalida: inval, respostas,
        total_atend: base,
        pct_satisfeito: pct(sat), pct_insatisfeito: pct(insat), pct_respondido: pct(respostas),
        // satisfação relativa (satisfeitos entre os que responderam válido)
        pct_satisfacao: (sat + insat) ? Math.round((sat / (sat + insat)) * 1000) / 10 : 0,
      };
    }

    res.json({ periodo: { di, df }, geral: { tma, tme, tmr, tmr_avg, total, media_dia }, satisfacao, atendentes, painel: statusPainel(emp) });
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
// Cálculo do Relatório de Satisfação (Meta) — reutilizado pela rota e pelo envio automático (metaSemanal).
// deps/ats: filtros opcionais por departamento canônico (ex.: ['Financeiro'] ou ['Suporte']) e atendentes.
async function calcularMeta(emp, di, df, metaSatisfacao = 90, metaTaxa = 55, { deps = [], ats = [] } = {}) {
  const params = [emp, di, df];
  let extra = '';
  if (deps.length) { params.push(deps); extra += ` AND (${DEPT_SQL}) = ANY($${params.length})`; }
  if (ats.length) { params.push(ats); extra += ` AND COALESCE(atendente_nome,'Automação/Bot') = ANY($${params.length})`; }
  // IMPORTANTE: nota=5 na API do Chatmix significa "RESPONDEU a pesquisa" (não "satisfeito").
  // A classificação real vem da resposta lida nas mensagens (satisfacao_msg); e a fonte OFICIAL,
  // quando disponível, substitui a dedução por mensagem.
  const rows = await all(
    `SELECT COALESCE(atendente_nome, 'Automação/Bot') AS nome,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE nota IS NOT NULL OR satisfacao_msg IS NOT NULL)::int AS respondidas,
      COUNT(*) FILTER (WHERE satisfacao_msg = 'satisfeito')::int AS satisfeitas,
      COUNT(*) FILTER (WHERE satisfacao_msg = 'insatisfeito')::int AS insatisfeitas,
      COUNT(*) FILTER (WHERE satisfacao_msg = 'invalida')::int AS invalidas,
      COUNT(*) FILTER (WHERE (nota IS NOT NULL) AND satisfacao_msg IS NULL)::int AS pendentes
     FROM chatmix_atendimentos
     WHERE empresa_id = $1 AND closed_at::date BETWEEN $2 AND $3 AND atendente_nome IS NOT NULL
       AND (${DEPT_SQL}) IN ('Financeiro','Suporte')${extra}
     GROUP BY 1 ORDER BY total DESC`, params);
    // Meta considera apenas Financeiro e Call Center (=Suporte)
    const rotuloDept = nome => deptDeNome(nome) === 'Suporte' ? 'Call Center' : deptDeNome(nome);
    // Fonte OFICIAL do painel Chatmix (exata). Se disponível, substitui a dedução por mensagem.
    const oficial = await satisfacaoOficial(emp, di, df);
    const candidatosNomes = await candidatosDeNomes(emp).catch(() => []);
    const itens = rows.map(r => {
      const o = oficial ? oficial[(r.nome || '').toLowerCase()] : null;
      const satisfeitas = o ? o.sat : r.satisfeitas;
      const insatisfeitas = o ? o.insat : r.insatisfeitas;
      const invalidas = o ? o.inval : r.invalidas;
      const validas = satisfeitas + insatisfeitas;               // válidas = satisfeitas + insatisfeitas
      const percSat = validas ? Math.round((satisfeitas / validas) * 10000) / 100 : null; // satisfeitas / válidas
      const taxaResp = r.total ? Math.round((validas / r.total) * 10000) / 100 : 0;        // válidas / total (atendimentos)
      const bateSat = percSat != null && percSat >= metaSatisfacao;
      const bateTaxa = taxaResp >= metaTaxa;
      // Nota média (1 a 5) do painel oficial do Chatmix — número puro, além do %
      const notaMedia = (o && o.media != null && Number.isFinite(Number(o.media)))
        ? Math.round(Number(o.media) * 100) / 100 : null;
      return {
        atendente: r.nome, nome_completo: nomeCompletoDe(candidatosNomes, r.nome),
        _email: emailDoAtendente(candidatosNomes, r.nome),
        departamento: rotuloDept(r.nome), total: r.total,
        respondidas: o ? (o.sat + o.insat + o.inval) : r.respondidas, pendentes: o ? 0 : r.pendentes,
        validas, invalidas, satisfeitas, insatisfeitas,
        perc_satisfacao: percSat, nota_media: notaMedia, taxa_resposta: taxaResp,
        bate_satisfacao: bateSat, bate_taxa: bateTaxa,
        bonificacao: bateSat && bateTaxa,
        bonus_valor: (bateSat && bateTaxa) ? 50 : 0, // R$50 por bater as duas metas na semana
        situacao: percSat == null ? (r.pendentes > 0 ? `${r.pendentes} pesquisa(s) ainda sendo lida(s)…` : 'Sem pesquisas no período.') : situacaoTexto(percSat, taxaResp, bateSat, bateTaxa, metaTaxa),
      };
    });
    const fonteSatisfacao = oficial ? 'oficial' : 'mensagens';
    const departamentos = montarDepartamentos(itens);
    const resumo = montarResumoMeta(itens);
    return { fonte: fonteSatisfacao, painel: statusPainel(emp), metas: { satisfacao: metaSatisfacao, taxa: metaTaxa }, departamentos, itens, resumo };
}

// Agrupa por departamento (Financeiro e Call Center) — separado da função
// principal pra poder ser recalculado depois de restringir "só a própria linha".
function montarDepartamentos(itens) {
  const porDept = {};
  for (const i of itens) {
    const d = porDept[i.departamento] || (porDept[i.departamento] = { departamento: i.departamento, total: 0, satisfeitas: 0, validas: 0, atendentes: 0 });
    d.total += i.total; d.satisfeitas += i.satisfeitas; d.validas += i.validas; d.atendentes++;
  }
  return Object.values(porDept).map(d => ({
    ...d,
    perc_satisfacao: d.validas ? Math.round((d.satisfeitas / d.validas) * 10000) / 100 : null,
    taxa_resposta: d.total ? Math.round((d.validas / d.total) * 10000) / 100 : 0,
  }));
}
// Resumo do setor (ou da própria linha, quando os itens já vieram filtrados) —
// separado pra poder recalcular depois de restringirProprio, senão o resumo
// continuava mostrando o total do setor inteiro pro colaborador comum.
function montarResumoMeta(itens) {
    const totAtend = itens.reduce((s, i) => s + i.total, 0);
    const totPend = itens.reduce((s, i) => s + (i.pendentes || 0), 0);
    const totValidas = itens.reduce((s, i) => s + i.validas, 0);
    const totSatisf = itens.reduce((s, i) => s + i.satisfeitas, 0);
    const ambas = itens.filter(i => i.bonificacao);
    const comNota = itens.filter(i => i.nota_media != null);
    return {
      total_atendimentos: totAtend,
      pesquisas_pendentes: totPend,
      atendentes_avaliados: itens.length,
      media_satisfacao: totValidas ? Math.round((totSatisf / totValidas) * 10000) / 100 : null,
      media_nota: comNota.length ? Math.round((comNota.reduce((s, i) => s + i.nota_media, 0) / comNota.length) * 100) / 100 : null,
      media_taxa_resposta: totAtend ? Math.round((totValidas / totAtend) * 10000) / 100 : null,
      atingiram_ambas: ambas.length,
      perc_atingiram: itens.length ? Math.round((ambas.length / itens.length) * 1000) / 10 : 0,
      destaques: ambas.map(i => i.nome_completo || i.atendente),
      bonus_total: ambas.length * 50,
    };
}

// Restringe à PRÓPRIA linha quando o usuário não tem "vê tudo" naquele
// departamento (líder/admin/gestor/lista extra) — casado pelo e-mail resolvido
// junto com o nome completo. Sem bater com nenhuma linha, não afirma nada (a
// pessoa simplesmente não aparece na meta desse período).
async function restringirProprio(req, departamentoChave, itens) {
  const { podeVerTudoNaMeta, mesmoEmail } = require('../utils/visibilidadeMeta');
  if (await podeVerTudoNaMeta(req.usuario, departamentoChave)) return itens;
  return itens.filter(i => mesmoEmail(i._email, req.usuario.email));
}

router.get('/meta', exigirVerMetaAtendimento(depDaQuery), async (req, res) => {
  try {
    const emp = req.usuario.empresa_id; const { di, df } = periodoMeta(req);
    const metaSatisfacao = Number(req.query.meta_satisfacao || 90);
    const metaTaxa = Number(req.query.meta_taxa || 55);
    const deps = listaParam(req.query.departamento);
    const ats = listaParam(req.query.atendente);
    const data = await calcularMeta(emp, di, df, metaSatisfacao, metaTaxa, { deps, ats });
    const depChave = deps[0] === 'Suporte' ? 'callcenter' : deps[0] === 'Financeiro' ? 'financeiro' : null;
    if (depChave) {
      data.itens = await restringirProprio(req, depChave, data.itens);
      // Recalcula o resumo com base só nos itens já restritos, senão continuava
      // mostrando o total do setor inteiro pro colaborador comum.
      data.departamentos = montarDepartamentos(data.itens);
      data.resumo = montarResumoMeta(data.itens);
    }
    res.json({ periodo: { di, df }, semana: true, ...data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Semanas cheias (domingo→sábado) de um mês, até a semana de hoje — não lista
// semana futura. A semana que contém o dia 1º só entra se o domingo dela cair
// dentro do próprio mês (senão pertence ao mês anterior).
// Fechamento do mês: total de cada atendente somando TODAS as semanas do mês —
// é o valor a pagar. Junta pelo nome completo (ou o nome do Chatmix quando o
// cadastro não resolveu). Cada departamento fecha separado, pois `semanas` já
// vem filtrado por um só (deps=[departamento]) na chamada de quem usa isto.
function fechamentoDoMes(semanas) {
  const porAtendente = new Map();
  for (const semana of semanas) {
    for (const item of (semana.itens || [])) {
      const chave = item.nome_completo || item.atendente;
      const atual = porAtendente.get(chave) || {
        nome: chave, departamento: item.departamento, total_bonus: 0, semanas_bateu: 0, semanas_total: 0,
      };
      atual.total_bonus += item.bonus_valor || 0;
      atual.semanas_total += 1;
      if (item.bonificacao) atual.semanas_bateu += 1;
      porAtendente.set(chave, atual);
    }
  }
  return [...porAtendente.values()].sort((a, b) => b.total_bonus - a.total_bonus);
}

function semanasDoMes(mesRef) {
  const [ano, mes] = (mesRef || '').match(/^\d{4}-\d{2}$/) ? mesRef.split('-').map(Number) : (() => {
    const h = new Date(); return [h.getFullYear(), h.getMonth() + 1];
  })();
  const primeiroDia = new Date(ano, mes - 1, 1);
  const ultimoDia = new Date(ano, mes, 0);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const iso = d => d.toISOString().slice(0, 10);
  const semanas = [];
  // Acha o primeiro domingo dentro (ou depois) do início do mês
  let dom = new Date(primeiroDia);
  dom.setDate(dom.getDate() - dom.getDay());
  if (dom < primeiroDia) dom.setDate(dom.getDate() + 7);
  while (dom <= ultimoDia && dom <= hoje) {
    const sab = new Date(dom); sab.setDate(dom.getDate() + 6);
    semanas.push({ di: iso(dom), df: iso(sab) });
    dom = new Date(dom); dom.setDate(dom.getDate() + 7);
  }
  return semanas;
}

// Lista as semanas do mês já calculadas, para a tabela e para montar o PDF
router.get('/meta/semanas', exigirVerMetaAtendimento(depDaQuery), async (req, res) => {
  try {
    const emp = req.usuario.empresa_id;
    const metaSatisfacao = Number(req.query.meta_satisfacao || 90);
    const metaTaxa = Number(req.query.meta_taxa || 55);
    const deps = listaParam(req.query.departamento);
    const ats = listaParam(req.query.atendente);
    const semanas = semanasDoMes(req.query.mes);
    const depChave = deps[0] === 'Suporte' ? 'callcenter' : deps[0] === 'Financeiro' ? 'financeiro' : null;
    const resultado = [];
    for (const s of semanas) {
      const data = await calcularMeta(emp, s.di, s.df, metaSatisfacao, metaTaxa, { deps, ats });
      if (depChave) {
        data.itens = await restringirProprio(req, depChave, data.itens);
        data.departamentos = montarDepartamentos(data.itens);
        data.resumo = montarResumoMeta(data.itens);
      }
      resultado.push({ periodo: s, ...data });
    }
    const bonusMes = resultado.reduce((t, s) => t + (s.resumo.bonus_total || 0), 0);
    res.json({
      mes: req.query.mes || new Date().toISOString().slice(0, 7),
      semanas: resultado, bonus_total_mes: bonusMes, fechamento_mes: fechamentoDoMes(resultado),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meta/pdf', exigirVerMetaAtendimento(depDaQuery), async (req, res) => {
  try {
    const emp = req.usuario.empresa_id;
    const metaSatisfacao = Number(req.query.meta_satisfacao || 90);
    const metaTaxa = Number(req.query.meta_taxa || 55);
    const deps = listaParam(req.query.departamento);       // ex.: ['Financeiro'] ou ['Suporte']
    const mesRef = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : new Date().toISOString().slice(0, 7);
    const semanas = semanasDoMes(mesRef);
    const depChave = deps[0] === 'Suporte' ? 'callcenter' : deps[0] === 'Financeiro' ? 'financeiro' : null;
    const resultado = [];
    for (const s of semanas) {
      const data = await calcularMeta(emp, s.di, s.df, metaSatisfacao, metaTaxa, { deps });
      if (depChave) data.itens = await restringirProprio(req, depChave, data.itens);
      resultado.push({ periodo: s, ...data });
    }
    const bonusMes = resultado.reduce((t, s) => t + (s.resumo.bonus_total || 0), 0);

    const { gerarPDFMetaAtendimento } = require('../utils/gerarPDFMetaAtendimento');
    const pdfBuffer = await gerarPDFMetaAtendimento({
      mes: mesRef, semanas: resultado, bonus_total_mes: bonusMes, departamento: deps[0] || null,
      fechamento_mes: fechamentoDoMes(resultado),
    });

    try {
      const fs = require('fs'); const path = require('path');
      const dir = path.join(__dirname, '../../uploads/meta-atendimento');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const nome = `meta-atendimento-${mesRef}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(dir, nome), pdfBuffer);
      const { v4: uuidv4 } = require('uuid');
      await run(
        `INSERT INTO meta_atendimento_pdf (id, empresa_id, mes, arquivo, gerado_por, gerado_por_nome, total_semanas, total_bonus, departamento)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidv4(), emp, mesRef, `/uploads/meta-atendimento/${nome}`, req.usuario.id, req.usuario.nome || null, resultado.length, bonusMes, deps[0] || null]
      );
    } catch (e) { console.error('[meta/pdf] histórico:', e.message); }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Meta-Atendimento-${mesRef}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Meta de satisfação/taxa LEMBRADA por departamento — Financeiro e Call Center
// guardam seu próprio valor, sem se misturar.
const PODE_EDITAR_META_ATENDIMENTO = ['admin', 'gestor', 'lider'];
router.get('/meta/config', exigirVerMetaAtendimento(depDaQuery), async (req, res) => {
  try {
    const dep = (req.query.departamento || '').trim();
    if (!dep) return res.status(400).json({ erro: 'Informe o departamento.' });
    const row = await get(
      'SELECT meta_satisfacao, meta_taxa FROM meta_atendimento_config WHERE empresa_id=$1 AND departamento=$2',
      [req.usuario.empresa_id, dep]);
    res.json({ meta_satisfacao: row?.meta_satisfacao ?? 90, meta_taxa: row?.meta_taxa ?? 55 });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/meta/config', exigirVerMetaAtendimento(depDoBody), async (req, res) => {
  try {
    if (!PODE_EDITAR_META_ATENDIMENTO.includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const dep = (req.body.departamento || '').trim();
    const sat = parseInt(req.body.meta_satisfacao, 10);
    const taxa = parseInt(req.body.meta_taxa, 10);
    if (!dep || !Number.isFinite(sat) || !Number.isFinite(taxa)) return res.status(400).json({ erro: 'Dados inválidos.' });
    await run(
      `INSERT INTO meta_atendimento_config (empresa_id, departamento, meta_satisfacao, meta_taxa, atualizado_em)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (empresa_id, departamento) DO UPDATE SET meta_satisfacao=EXCLUDED.meta_satisfacao, meta_taxa=EXCLUDED.meta_taxa, atualizado_em=NOW()`,
      [req.usuario.empresa_id, dep, sat, taxa]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/meta/pdfs', exigirVerMetaAtendimento(depDaQuery), async (req, res) => {
  try {
    const dep = (req.query.departamento || '').trim();
    const params = [req.usuario.empresa_id];
    let filtroDep = '';
    if (dep) { params.push(dep); filtroDep = ` AND departamento=$${params.length}`; }
    const rows = await all(
      `SELECT id, mes, arquivo, gerado_por_nome, total_semanas, total_bonus, departamento, created_at
       FROM meta_atendimento_pdf WHERE empresa_id=$1${filtroDep} ORDER BY created_at DESC LIMIT 100`,
      params);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Envia a TABELA da Meta (imagem PNG capturada na tela) para o Discord
router.post('/meta/discord', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { imagem, titulo, descricao, canal_id } = req.body;
    if (!imagem) return res.status(400).json({ erro: 'Imagem não recebida.' });
    const m = String(imagem).match(/^data:image\/\w+;base64,(.+)$/);
    const buffer = Buffer.from(m ? m[1] : imagem, 'base64');
    if (!buffer.length) return res.status(400).json({ erro: 'Imagem inválida.' });
    const cfg = await getConfig(req.usuario.empresa_id);
    if (!cfg || !cfg.ativo) return res.status(400).json({ erro: 'A integração do Discord não está ativa.' });
    const url = await resolverWebhook(req.usuario.empresa_id, cfg, 'meta', canal_id);
    if (!url) return res.status(400).json({ erro: 'Cadastre um canal do Discord primeiro.' });
    const conteudo = `**${titulo || 'Relatório de Satisfação'}**${descricao ? `\n${descricao}` : ''}`;
    const ok = await postWebhookImagem(url, buffer, 'meta-satisfacao.png', conteudo);
    if (!ok) return res.status(502).json({ erro: 'Falha ao enviar ao Discord.' });
    res.json({ ok: true });
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
router.get('/mensagens', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
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
router.get('/medias', exigirEFiltrarDepartamentoAoVivo(), async (req, res) => {
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

router.calcularMeta = calcularMeta;
module.exports = router;
