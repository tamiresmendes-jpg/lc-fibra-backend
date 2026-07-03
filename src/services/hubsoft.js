// ─────────────────────────────────────────────────────────────────────────────
// Conector da API do HubSoft (ERP)
//
// Faz login via OAuth2 (grant_type=password), guarda o access_token em memória
// e o renova automaticamente quando expira. Expõe funções de consulta usadas
// pelo assistente de IA (/api/ia/consultar).
//
// Credenciais ficam no .env — NUNCA no código:
//   HUBSOFT_HOST=api.suaempresa.hubsoft.com.br   (sem https://)
//   HUBSOFT_CLIENT_ID=...
//   HUBSOFT_CLIENT_SECRET=...
//   HUBSOFT_USER=api@suaempresa.com.br
//   HUBSOFT_PASSWORD=...
// ─────────────────────────────────────────────────────────────────────────────

function baseUrl() {
  const host = process.env.HUBSOFT_HOST;
  if (!host) throw new Error('HUBSOFT_HOST não configurado no .env');
  return `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
}

// ── Cache do token em memória ──────────────────────────────────────────────
let _token = null;        // access_token atual
let _expiraEm = 0;        // timestamp (ms) em que o token expira
let _loginEmAndamento = null; // promessa compartilhada p/ evitar logins simultâneos

async function autenticar() {
  const body = {
    grant_type: 'password',
    client_id: process.env.HUBSOFT_CLIENT_ID,
    client_secret: process.env.HUBSOFT_CLIENT_SECRET,
    username: process.env.HUBSOFT_USER,
    password: process.env.HUBSOFT_PASSWORD,
  };
  for (const [k, v] of Object.entries(body)) {
    if (!v) throw new Error(`HUBSOFT: variável ${k} ausente no .env`);
  }

  const resp = await fetch(`${baseUrl()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HUBSOFT: falha na autenticação (${resp.status}) ${txt.slice(0, 200)}`);
  }

  const dados = await resp.json();
  _token = dados.access_token;
  // renova com 5 min de folga antes do vencimento real
  const validadeSeg = Number(dados.expires_in) || 3600;
  _expiraEm = Date.now() + Math.max(0, validadeSeg - 300) * 1000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _expiraEm) return _token;
  // se já há um login rolando, aguarda ele em vez de disparar outro
  if (!_loginEmAndamento) {
    _loginEmAndamento = autenticar().finally(() => { _loginEmAndamento = null; });
  }
  return _loginEmAndamento;
}

// ── Requisição autenticada genérica (GET) ──────────────────────────────────
// Refaz o login uma vez se receber 401 (token revogado / sistema atualizado).
async function apiGet(caminho, params = {}) {
  const url = new URL(baseUrl() + caminho);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }

  const fazer = async (token) =>
    fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

  let resp = await fazer(await getToken());
  if (resp.status === 401) {
    _token = null; _expiraEm = 0;
    resp = await fazer(await getToken());
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`HUBSOFT ${caminho}: ${resp.status} ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

// ── Consultas de negócio ────────────────────────────────────────────────────

// Lista equipamentos de rede (roteadores, access points, ONUs, etc.)
// GET /api/v1/integracao/rede/equipamento
async function listarEquipamentos() {
  const dados = await apiGet('/api/v1/integracao/rede/equipamento');
  // a API costuma devolver { status, equipamentos: [...] } — normalizamos
  return dados.equipamentos || dados.data || dados || [];
}

// Lista produtos do estoque (catálogo). Varre todas as páginas.
// GET /api/v1/integracao/estoque/produto?pagina=N
async function listarProdutos() {
  const todos = [];
  let pagina = 1;
  let ultima = 1;
  do {
    const d = await apiGet('/api/v1/integracao/estoque/produto', { pagina });
    const arr = d.produtos || d.data || [];
    todos.push(...arr);
    ultima = d.paginacao?.ultima_pagina || pagina;
    pagina++;
  } while (pagina <= ultima && pagina <= 50); // trava de segurança
  return todos;
}

// Lista ordens de serviço com a agenda (equipe/técnico) num intervalo de datas.
// GET /api/v1/integracao/ordem_servico/todos?relacoes=agenda_ordem_servico
async function listarOrdensServico({ dataInicio, dataFim, maxPaginas = 40 } = {}) {
  const todas = [];
  let pagina = 1;
  let ultima = 1;
  do {
    const d = await apiGet('/api/v1/integracao/ordem_servico/todos', {
      pagina,
      itens_por_pagina: 100,
      data_inicio: dataInicio,
      data_fim: dataFim,
      relacoes: 'agenda_ordem_servico',
    });
    const arr = d.ordens_servico || d.data || [];
    todas.push(...arr);
    ultima = d.paginacao?.ultima_pagina || pagina;
    pagina++;
  } while (pagina <= ultima && pagina <= maxPaginas);
  return todas;
}

module.exports = { apiGet, listarEquipamentos, listarProdutos, listarOrdensServico, getToken };
