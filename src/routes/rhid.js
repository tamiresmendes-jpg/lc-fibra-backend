const express = require('express');
const router = express.Router();
const { run, get } = require('../config/database');
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
    const r = await chamarRhid(empresaId, cfg, '/department', { params: { start: 0, length: 1000 } });
    const m = {};
    for (const d of listaDe(r.json)) m[d.id] = d.description || d.name || d.nome || d.descricao;
    return m;
  } catch { return {}; }
}

// ---------- FUNCIONÁRIOS ----------
router.get('/funcionarios', async (req, res) => {
  try {
    const cfg = await exigirCfg(req, res); if (!cfg) return;
    const r = await chamarRhid(req.usuario.empresa_id, cfg, '/person', { params: { start: 0, length: 2000 } });
    if (r.status !== 200 || !r.json) return res.status(502).json({ erro: r.json?.message || ('Erro RHID HTTP ' + r.status) });
    const deptos = await mapaDepartamentos(req.usuario.empresa_id, cfg);
    const funcionarios = listaDe(r.json).map(p => ({
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
    const r = await chamarRhid(req.usuario.empresa_id, cfg, '/device', { params: { start: 0, length: 500 } });
    if (r.status !== 200 || !r.json) return res.status(502).json({ erro: r.json?.message || ('Erro RHID HTTP ' + r.status) });
    const equipamentos = listaDe(r.json).map(d => ({
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

module.exports = router;
