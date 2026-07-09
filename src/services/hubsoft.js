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

// ── Paginador paralelo genérico ─────────────────────────────────────────────
// Busca a 1ª página (para saber o total) e as demais em paralelo (lotes de `conc`).
class CanceladoError extends Error { constructor() { super('CANCELADO'); this.cancelado = true; } }
async function checarCancelamento(deveCancelar) {
  if (deveCancelar && await deveCancelar()) throw new CanceladoError();
}

// conc mantido baixo (3) de propósito: reduz o pico de carga no servidor do ERP.
// deveCancelar: callback async opcional; se retornar true entre lotes, aborta a busca.
async function buscarTodasPaginas(fetchPagina, { extrair, maxPaginas = 60, conc = 3, deveCancelar } = {}) {
  await checarCancelamento(deveCancelar);
  const primeira = await fetchPagina(0);
  const todos = [...extrair(primeira)];
  const ultima = Math.min(primeira.paginacao?.ultima_pagina || 0, maxPaginas);
  const restantes = [];
  for (let p = 1; p <= ultima; p++) restantes.push(p);
  for (let i = 0; i < restantes.length; i += conc) {
    await checarCancelamento(deveCancelar);
    const lote = restantes.slice(i, i + conc);
    const resultados = await Promise.all(lote.map(fetchPagina));
    for (const d of resultados) todos.push(...extrair(d));
  }
  return todos;
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
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/estoque/produto', { pagina }),
    { extrair: d => d.produtos || d.data || [], maxPaginas: 50 }
  );
}

// Lista ordens de serviço com a agenda (equipe/técnico) num intervalo de datas.
// GET /api/v1/integracao/ordem_servico/todos?relacoes=agenda_ordem_servico
async function listarOrdensServico({ dataInicio, dataFim, maxPaginas = 60 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/ordem_servico/todos', {
      pagina, itens_por_pagina: 100,
      data_inicio: dataInicio, data_fim: dataFim,
      relacoes: 'agenda_ordem_servico,tecnicos',
    }),
    { extrair: d => d.ordens_servico || d.data || [], maxPaginas }
  );
}

// Paginador genérico para endpoints /todos com data_inicio/data_fim
async function listarPaginado(caminho, { dataInicio, dataFim, relacoes, extra = {}, chaveArray, maxPaginas = 60 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet(caminho, {
      pagina, itens_por_pagina: 100,
      data_inicio: dataInicio, data_fim: dataFim,
      ...(relacoes ? { relacoes } : {}),
      ...extra,
    }),
    { extrair: d => { const key = chaveArray || Object.keys(d).find(k => Array.isArray(d[k])); return key ? d[key] : []; }, maxPaginas }
  );
}

// Faturas (financeiro) num intervalo de vencimento
async function listarFaturas({ dataInicio, dataFim } = {}) {
  return listarPaginado('/api/v1/integracao/financeiro/fatura', {
    dataInicio, dataFim, relacoes: 'cliente', chaveArray: 'faturas',
  });
}

// Atendimentos (chamados) num intervalo
async function listarAtendimentos({ dataInicio, dataFim } = {}) {
  return listarPaginado('/api/v1/integracao/atendimento/todos', {
    dataInicio, dataFim,
    relacoes: 'tipo_atendimento,atendimento_status,usuario_abertura,usuario_responsavel,cliente_servico',
    chaveArray: 'atendimentos',
  });
}

// Movimentos de estoque (entradas/saídas) num intervalo. itens_por_pagina máx 500.
// tipoVinculoDestino: filtra no servidor (ex: 'servico_cliente' = só saídas p/ cliente)
async function listarMovimentosEstoque({ dataInicio, dataFim, tipoVinculoDestino, maxPaginas = 300, deveCancelar } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/estoque/movimento_estoque', {
      pagina, itens_por_pagina: 500,
      data_inicio: dataInicio, data_fim: dataFim,
      tipo_data: 'movimento',
      ...(tipoVinculoDestino ? { tipo_vinculo_destino: tipoVinculoDestino } : {}),
    }),
    { extrair: d => d.movimentos_estoque || d.data || [], maxPaginas, deveCancelar }
  );
}

// Busca o tipo de várias OSs por ID via GraphQL (em lotes com aliases).
// Retorna um mapa { id_ordem_servico: tipoDescricao }.
async function buscarTiposOSPorId(ids = [], deveCancelar) {
  const mapa = {};
  const unicos = [...new Set(ids.filter(Boolean).map(Number))];
  if (!unicos.length) return mapa;

  const host = process.env.HUBSOFT_HOST.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const url = `https://${host}/graphql/v1`;
  const token = await getToken();

  const LOTE = 50;
  for (let i = 0; i < unicos.length; i += LOTE) {
    await checarCancelamento(deveCancelar);
    const chunk = unicos.slice(i, i + LOTE);
    const campos = chunk
      .map((id) => `os${id}: ordemServicoById(id_ordem_servico: ${id}) { id_ordem_servico data_termino_executado tipo_ordem_servico { descricao } }`)
      .join('\n');
    const query = `query { ${campos} }`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query }),
      });
      const json = await resp.json();
      const data = json.data || {};
      for (const v of Object.values(data)) {
        // Retorna { tipo, fechamento } por O.S. (fechamento = data_termino_executado)
        if (v && v.id_ordem_servico) mapa[v.id_ordem_servico] = { tipo: v.tipo_ordem_servico?.descricao || 'Sem tipo', fechamento: v.data_termino_executado || null };
      }
    } catch { /* ignora lote com erro */ }
  }
  return mapa;
}

// Clientes (com busca opcional por nome/CPF/código)
async function listarClientes({ busca } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/cliente/todos', { pagina, itens_por_pagina: 100, ...(busca ? { busca } : {}) }),
    { extrair: d => d.clientes || d.data || [], maxPaginas: 60 }
  );
}

module.exports = {
  apiGet, listarEquipamentos, listarProdutos, listarOrdensServico,
  listarFaturas, listarAtendimentos, listarClientes, listarMovimentosEstoque,
  buscarTiposOSPorId, getToken, CanceladoError,
};
