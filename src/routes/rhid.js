const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

// API do ponto eletrônico RHID (https://rhid.com.br) — doc: /v2/swagger.svc
const BASE_PADRAO = 'https://rhid.com.br/v2/api.svc';

let pronto = false;
async function garantir() {
  if (pronto) return;
  try {
    await run(`CREATE TABLE IF NOT EXISTS integracao_rhid (
      empresa_id TEXT PRIMARY KEY,
      base_url TEXT,
      email TEXT,
      senha TEXT,
      atualizado_em TIMESTAMP DEFAULT NOW()
    )`);
    pronto = true;
  } catch (e) { console.error('[RHID]', e.message); }
}
garantir();

function soAdminGestor(req, res) {
  if (!['admin', 'gestor'].includes(req.usuario.perfil)) { res.status(403).json({ erro: 'Sem permissão' }); return false; }
  return true;
}

async function carregarCfg(empresaId) {
  const cfg = await get('SELECT * FROM integracao_rhid WHERE empresa_id = $1', [empresaId]) || {};
  return { base_url: cfg.base_url || BASE_PADRAO, email: cfg.email || '', senha: cfg.senha || '' };
}

// Cache de token JWT por empresa (o login expira; refazemos quando necessário)
const tokenCache = new Map(); // empresaId -> { token, exp }

function baseDe(cfg) { return (cfg.base_url || BASE_PADRAO).replace(/\/+$/, ''); }

async function fazerLogin(cfg) {
  const url = baseDe(cfg) + '/login';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.senha, system: 'rhid' }),
  });
  const texto = await resp.text();
  let json = null; try { json = JSON.parse(texto); } catch {}
  const token = json?.accessToken || json?.access_token || null;
  return { status: resp.status, token, json, texto };
}

async function tokenValido(empresaId, cfg, forcar = false) {
  const agora = Date.now();
  const c = tokenCache.get(empresaId);
  if (!forcar && c && c.exp > agora + 60000) return c.token;
  const login = await fazerLogin(cfg);
  if (!login.token) throw new Error(login.json?.message || login.json?.mensagem || ('Falha no login RHID (HTTP ' + login.status + ')'));
  // JWT costuma durar ~1h; guardamos por 50 min por segurança
  tokenCache.set(empresaId, { token: login.token, exp: agora + 50 * 60000 });
  return login.token;
}

// Chama a API autenticada; refaz login uma vez se o token expirou (401)
async function chamarRhid(empresaId, cfg, endpoint, { method = 'GET', params = {}, body = null } = {}) {
  const caminho = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.append(k, v);
  }
  const url = baseDe(cfg) + caminho + (qs.toString() ? '?' + qs.toString() : '');

  const fazer = async (token) => {
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const texto = await resp.text();
    let json = null; try { json = JSON.parse(texto); } catch {}
    return { status: resp.status, json, texto, contentType: resp.headers.get('content-type') || '' };
  };

  let token = await tokenValido(empresaId, cfg);
  let r = await fazer(token);
  if (r.status === 401) { // token expirou/inválido → tenta relogar 1x
    token = await tokenValido(empresaId, cfg, true);
    r = await fazer(token);
  }
  return r;
}

// ---------- CONFIG ----------
router.get('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await get('SELECT * FROM integracao_rhid WHERE empresa_id = $1', [req.usuario.empresa_id]) || {};
    res.json({
      base_url: cfg.base_url || BASE_PADRAO,
      email: cfg.email || '',
      tem_senha: !!cfg.senha,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/config', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const { base_url, email, senha } = req.body;
    const atual = await get('SELECT senha FROM integracao_rhid WHERE empresa_id = $1', [req.usuario.empresa_id]);
    const senhaFinal = (senha && senha.trim()) ? senha.trim() : (atual?.senha || null);
    await run(
      `INSERT INTO integracao_rhid (empresa_id, base_url, email, senha, atualizado_em)
       VALUES ($1,$2,$3,$4, NOW())
       ON CONFLICT (empresa_id) DO UPDATE SET
         base_url=EXCLUDED.base_url, email=EXCLUDED.email, senha=EXCLUDED.senha, atualizado_em=NOW()`,
      [req.usuario.empresa_id, (base_url || '').trim() || BASE_PADRAO, (email || '').trim() || null, senhaFinal]
    );
    tokenCache.delete(req.usuario.empresa_id); // credenciais mudaram → invalida token
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/testar', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await garantir();
    const cfg = await carregarCfg(req.usuario.empresa_id);
    if (req.body.email) cfg.email = req.body.email;
    if (req.body.senha && req.body.senha.trim()) cfg.senha = req.body.senha.trim();
    if (req.body.base_url) cfg.base_url = req.body.base_url;
    if (!cfg.email || !cfg.senha) return res.status(400).json({ erro: 'Informe o e-mail e a senha do RHID.' });
    const login = await fazerLogin(cfg);
    const ok = !!login.token;
    if (ok) tokenCache.set(req.usuario.empresa_id, { token: login.token, exp: Date.now() + 50 * 60000 });
    res.json({
      ok,
      status: login.status,
      mensagem: login.json?.message || login.json?.mensagem || (ok ? 'Login efetuado com sucesso.' : 'Não foi possível autenticar.'),
      senha_expirada: !!login.json?.expiredPassword,
    });
  } catch (e) { res.json({ ok: false, erro: 'Falha de conexão: ' + e.message }); }
});

async function exigirCfg(req, res) {
  await garantir();
  const cfg = await carregarCfg(req.usuario.empresa_id);
  if (!cfg.email || !cfg.senha) { res.status(400).json({ erro: 'Integração do RHID não configurada.', nao_configurado: true }); return null; }
  return cfg;
}

// Extrai a lista de registros independente do "envelope" que o RHID usar
function listaDe(json) {
  if (Array.isArray(json)) return json;
  return json?.records || json?.data || json?.aaData || json?.persons || [];
}

// A API quebra (HTTP 500) quando pedimos páginas grandes (>~100). Então buscamos
// de 100 em 100 usando start (offset) até vir uma página incompleta.
async function buscarPaginado(empresaId, cfg, endpoint, { pageSize = 100, teto = 10000 } = {}) {
  const tudo = [];
  let start = 0;
  while (tudo.length < teto) {
    const r = await chamarRhid(empresaId, cfg, endpoint, { params: { start, length: pageSize } });
    if (r.status !== 200 || !r.json) {
      if (start === 0) throw new Error(r.json?.message || ('Erro RHID HTTP ' + r.status));
      break; // já temos parte dos dados; para na primeira falha subsequente
    }
    const lote = listaDe(r.json);
    tudo.push(...lote);
    if (lote.length < pageSize) break;
    start += pageSize;
  }
  return tudo;
}

// Formata CPF/PIS que vêm como número inteiro
function fmtDoc(v, tam) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).replace(/\D/g, '').padStart(tam, '0');
  return s;
}
function fmtCpf(v) {
  const s = fmtDoc(v, 11);
  return s.length === 11 ? `${s.slice(0,3)}.${s.slice(3,6)}.${s.slice(6,9)}-${s.slice(9)}` : (v || '');
}

// Mapa idDepartamento -> nome (para exibir o nome em vez do ID)
async function mapaDepartamentos(empresaId, cfg) {
  try {
    const lista = await buscarPaginado(empresaId, cfg, '/department');
    const m = {};
    for (const d of lista) m[d.id] = d.description || d.name || d.nome || d.descricao;
    return m;
  } catch { return {}; }
}

// ---------- FUNCIONÁRIOS ----------
router.get('/funcionarios', async (req, res) => {
  try {
    const cfg = await exigirCfg(req, res); if (!cfg) return;
    const pessoas = await buscarPaginado(req.usuario.empresa_id, cfg, '/person');
    const deptos = await mapaDepartamentos(req.usuario.empresa_id, cfg);
    const funcionarios = pessoas.map(p => ({
      id: p.id,
      nome: p.name || p.nome || '',
      cpf: fmtCpf(p.cpf),
      matricula: (p.registration && p.registration !== '0') ? p.registration : '',
      pis: fmtDoc(p.pis, 11),
      departamento: deptos[p.idDepartment] || (p.idDepartment != null ? `Depto ${p.idDepartment}` : ''),
      status: p.status === 1 ? 'Ativo' : 'Inativo',
    })).sort((a, b) => a.nome.localeCompare(b.nome));
    res.json({ total: funcionarios.length, funcionarios });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- EQUIPAMENTOS (REP) ----------
router.get('/equipamentos', async (req, res) => {
  try {
    const cfg = await exigirCfg(req, res); if (!cfg) return;
    const dispositivos = await buscarPaginado(req.usuario.empresa_id, cfg, '/device');
    const equipamentos = dispositivos.map(d => ({
      id: d.id,
      descricao: d.description || d.descricao || d.name || d.alias || `Equipamento ${d.id}`,
      numeroSerie: d.serialNumber || d.numeroSerie || null,
    }));
    res.json({ total: equipamentos.length, equipamentos });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- APURAÇÃO DE PONTO (banco de horas) ----------
// Requer idPerson + período (máx 90 dias)
router.get('/apuracao', async (req, res) => {
  try {
    const cfg = await exigirCfg(req, res); if (!cfg) return;
    const { idPerson, dataIni, dataFinal } = req.query;
    if (!idPerson || !dataIni || !dataFinal) return res.status(400).json({ erro: 'Informe idPerson, dataIni e dataFinal.' });
    const r = await chamarRhid(req.usuario.empresa_id, cfg, '/apuracao_ponto', { params: { idPerson, dataIni, dataFinal } });
    if (r.status !== 200) return res.status(502).json({ erro: r.json?.message || ('Erro RHID HTTP ' + r.status), amostra: r.texto.slice(0, 500) });
    // A apuração vem como string JSON dentro do corpo (ACJEF)
    let dados = r.json;
    if (typeof r.json === 'string') { try { dados = JSON.parse(r.json); } catch {} }
    else if (typeof r.json?.data === 'string') { try { dados = JSON.parse(r.json.data); } catch { dados = r.json.data; } }
    res.json({ idPerson, periodo: { dataIni, dataFinal }, apuracao: dados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- BATIDAS (AFD - Portaria 671) ----------
// Baixa o AFD de um equipamento e extrai as marcações (registro tipo 3).
router.get('/batidas', async (req, res) => {
  try {
    const cfg = await exigirCfg(req, res); if (!cfg) return;
    const { idEquipamento, dataIni, dataFinal } = req.query;
    if (!idEquipamento) return res.status(400).json({ erro: 'Informe o idEquipamento (REP).' });
    const r = await chamarRhid(req.usuario.empresa_id, cfg, '/report/afd/download671', {
      params: { idEquipamento, dataIni, dataFinal, limit: 50000 },
    });
    if (r.status !== 200) return res.status(502).json({ erro: r.json?.message || ('Erro RHID HTTP ' + r.status), amostra: r.texto.slice(0, 300) });
    const linhas = (r.texto || '').split(/\r?\n/).filter(Boolean);
    // AFD 671: cada linha tem NSR(9) + tipo(1). Marcação = tipo '3'; contém data/hora e PIS.
    const marcacoes = [];
    for (const l of linhas) {
      const tipo = l.charAt(9);
      if (tipo !== '3') continue;
      // dataHora no formato ISO 8601 dentro da linha; PIS = 12 dígitos após a data
      const mData = l.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2})/);
      const dataHora = mData ? mData[1] : null;
      let pis = null;
      if (mData) { const resto = l.slice(l.indexOf(mData[1]) + mData[1].length); const mp = resto.match(/(\d{12})/); pis = mp ? mp[1] : null; }
      marcacoes.push({ nsr: l.slice(0, 9), dataHora, pis, raw: l });
    }
    res.json({ idEquipamento, total_linhas: linhas.length, total_marcacoes: marcacoes.length, marcacoes: marcacoes.slice(0, 2000) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------- LISTAS (para filtros do dashboard) ----------
router.get('/listas', async (req, res) => {
  try {
    const emp = req.usuario.empresa_id;
    const deps = await all(`SELECT DISTINCT departamento FROM rhid_ponto_dia WHERE empresa_id=$1 AND departamento IS NOT NULL ORDER BY departamento`, [emp]);
    const pes = await all(`SELECT DISTINCT id_person, nome FROM rhid_ponto_dia WHERE empresa_id=$1 ORDER BY nome`, [emp]);
    res.json({
      departamentos: deps.map(d => d.departamento),
      pessoas: pes.map(p => ({ id: p.id_person, nome: p.nome })),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function fmtMin(min) {
  const neg = min < 0; min = Math.abs(Math.round(min || 0));
  const h = Math.floor(min / 60), m = min % 60;
  return (neg ? '-' : '') + h + ':' + String(m).padStart(2, '0');
}

// ---------- INDICADORES (dashboard, lê do banco sincronizado) ----------
router.get('/indicadores', async (req, res) => {
  try {
    await garantir();
    const emp = req.usuario.empresa_id;
    const hoje = new Date();
    const iniMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    const dataIni = req.query.dataIni || `${iniMes.getFullYear()}-${String(iniMes.getMonth()+1).padStart(2,'0')}-01`;
    const dataFinal = req.query.dataFinal || hoje.toISOString().slice(0, 10);

    const cond = ['empresa_id=$1', 'data >= $2', 'data <= $3'];
    const params = [emp, dataIni, dataFinal];
    if (req.query.departamento) { params.push(req.query.departamento); cond.push(`departamento = $${params.length}`); }
    if (req.query.idPerson) { params.push(parseInt(req.query.idPerson, 10)); cond.push(`id_person = $${params.length}`); }

    const rows = await all(`SELECT * FROM rhid_ponto_dia WHERE ${cond.join(' AND ')}`, params);

    if (rows.length === 0) {
      const algum = await get('SELECT COUNT(*) c, MAX(atualizado_em) u FROM rhid_ponto_dia WHERE empresa_id=$1', [emp]);
      return res.json({ vazio: true, sincronizando: !algum || Number(algum.c) === 0, atualizado_em: algum?.u || null, periodo: { dataIni, dataFinal }, cards: {}, por_departamento: [], por_pessoa: [], ranking_faltas_dias: [], ranking_faltas_horas: [] });
    }

    // Agrega por pessoa
    const pessoas = {};
    let ultimaData = null;
    for (const r of rows) {
      const k = r.id_person;
      const p = pessoas[k] || (pessoas[k] = {
        id_person: k, nome: r.nome, departamento: r.departamento || 'Sem departamento',
        trabalhado: 0, extra50: 0, extra100: 0, noturno: 0, falta_min: 0, falta_dias: 0, atraso: 0,
        atestados: 0, _saldoData: null, saldo: 0,
      });
      p.trabalhado += r.trabalhado_min || 0;
      if (r.extra_cem) p.extra100 += r.extra_min || 0; else p.extra50 += r.extra_min || 0;
      p.noturno += r.noturno_min || 0;
      p.falta_min += r.falta_min || 0;
      if (r.falta_dia) p.falta_dias += 1;
      p.atraso += r.atraso_min || 0;
      if (r.atestado) p.atestados += 1;
      // saldo do banco = valor do dia mais recente (é saldo acumulado, não somar)
      const dstr = (r.data instanceof Date) ? r.data.toISOString().slice(0,10) : String(r.data).slice(0,10);
      if (!p._saldoData || dstr > p._saldoData) { p._saldoData = dstr; p.saldo = r.saldo_min || 0; }
      if (!ultimaData || dstr > ultimaData) ultimaData = dstr;
    }
    const lista = Object.values(pessoas);

    // Cards gerais
    const soma = (f) => lista.reduce((a, p) => a + p[f], 0);
    const cards = {
      funcionarios: lista.length,
      total_trabalhado_min: soma('trabalhado'), total_trabalhado_fmt: fmtMin(soma('trabalhado')),
      saldo_min: soma('saldo'), saldo_fmt: fmtMin(soma('saldo')),
      extra50_min: soma('extra50'), extra50_fmt: fmtMin(soma('extra50')),
      extra100_min: soma('extra100'), extra100_fmt: fmtMin(soma('extra100')),
      noturno_min: soma('noturno'), noturno_fmt: fmtMin(soma('noturno')),
      falta_min: soma('falta_min'), falta_fmt: fmtMin(soma('falta_min')),
      falta_dias: soma('falta_dias'),
      atestados: soma('atestados'),
    };

    // Por departamento
    const dep = {};
    for (const p of lista) {
      const d = dep[p.departamento] || (dep[p.departamento] = { departamento: p.departamento, funcionarios: 0, trabalhado: 0, extra: 0, falta_dias: 0, falta_min: 0, saldo: 0 });
      d.funcionarios++; d.trabalhado += p.trabalhado; d.extra += p.extra50 + p.extra100; d.falta_dias += p.falta_dias; d.falta_min += p.falta_min; d.saldo += p.saldo;
    }
    const por_departamento = Object.values(dep).map(d => ({
      ...d, trabalhado_fmt: fmtMin(d.trabalhado), extra_fmt: fmtMin(d.extra), falta_fmt: fmtMin(d.falta_min), saldo_fmt: fmtMin(d.saldo),
    })).sort((a, b) => b.trabalhado - a.trabalhado);

    const fmtLista = lista.map(p => ({
      ...p, trabalhado_fmt: fmtMin(p.trabalhado), extra50_fmt: fmtMin(p.extra50), extra100_fmt: fmtMin(p.extra100),
      noturno_fmt: fmtMin(p.noturno), falta_fmt: fmtMin(p.falta_min), atraso_fmt: fmtMin(p.atraso), saldo_fmt: fmtMin(p.saldo),
    }));

    res.json({
      periodo: { dataIni, dataFinal },
      atualizado_em: ultimaData,
      cards,
      por_departamento,
      por_pessoa: fmtLista.sort((a, b) => b.trabalhado - a.trabalhado),
      ranking_faltas_dias: [...fmtLista].filter(p => p.falta_dias > 0).sort((a, b) => b.falta_dias - a.falta_dias).slice(0, 15),
      ranking_faltas_horas: [...fmtLista].filter(p => p.falta_min > 0).sort((a, b) => b.falta_min - a.falta_min).slice(0, 15),
      ranking_atrasos: [...fmtLista].filter(p => p.atraso > 0).sort((a, b) => b.atraso - a.atraso).slice(0, 15),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
