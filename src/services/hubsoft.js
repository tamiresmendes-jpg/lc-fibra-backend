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

// ── Conta de PAINEL (usuário real) ─────────────────────────────────────────
// A conta de integração não enxerga os relatórios (403 em /api/v1/relatorio/*).
// Para o Relatório de Serviços — única fonte de cidade, bairro e novo/migrado —
// usamos o login de um usuário do painel, guardado cifrado em integracao_hubsoft_painel.
// O client_id/secret são os mesmos da aplicação (ficam no .env).
let _tokenPainel = null, _expiraPainel = 0, _loginPainelEmAndamento = null;

async function credenciaisPainel(empresaId) {
  const { get } = require('../config/database');
  const { decifrar } = require('../utils/segredos');
  const c = await get('SELECT usuario, senha, client_id, client_secret FROM integracao_hubsoft_painel WHERE empresa_id = $1', [empresaId]);
  if (!c?.usuario || !c?.senha) return null;
  return {
    usuario: c.usuario,
    senha: decifrar(c.senha),
    // Sem client próprio, cai no da integração — que gera identidade sem acesso a relatórios
    clientId: c.client_id || process.env.HUBSOFT_CLIENT_ID,
    clientSecret: c.client_secret ? decifrar(c.client_secret) : process.env.HUBSOFT_CLIENT_SECRET,
  };
}

async function autenticarPainel(empresaId) {
  const cred = await credenciaisPainel(empresaId);
  if (!cred) throw new Error('Cadastre o usuário e a senha do painel HubSoft em Configurações → Integrações.');
  const resp = await fetch(`${baseUrl()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: cred.clientId,
      client_secret: cred.clientSecret,
      username: cred.usuario,
      password: cred.senha,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`HubSoft painel: login recusado (${resp.status}) ${t.slice(0, 160)}`);
  }
  const d = await resp.json();
  _tokenPainel = d.access_token;
  _expiraPainel = Date.now() + Math.max(0, (Number(d.expires_in) || 3600) - 300) * 1000;
  return _tokenPainel;
}

async function getTokenPainel(empresaId) {
  if (_tokenPainel && Date.now() < _expiraPainel) return _tokenPainel;
  if (!_loginPainelEmAndamento) {
    _loginPainelEmAndamento = autenticarPainel(empresaId).finally(() => { _loginPainelEmAndamento = null; });
  }
  return _loginPainelEmAndamento;
}

// Relatório de Serviços do painel — a fonte com cidade, bairro, origem e status.
// ATENÇÃO ao formato: tipo_data/order_by/order_by_key/origem são STRING;
// tipo_endereco e tipo_pessoa são OBJETO {descricao, valor}. Misturar dá erro de validação.
// Os registros vêm em paginador.data (15 por página por padrão).
async function relatorioServicos(empresaId, { dataInicio, dataFim, pagina = 1, limit = 200, origem = 'todos' } = {}) {
  const corpo = {
    data_inicio: dataInicio, data_fim: dataFim,          // dd/mm/aaaa
    tipo_data: 'data_venda', order_by: 'data_venda', order_by_key: 'ASC',
    tipo_endereco: { descricao: 'Instalação', valor: 'instalacao' },
    tipo_pessoa: { descricao: 'Todos', valor: 'todos' },
    // A paginação do relatório é pelo parâmetro `page` (Laravel). `pagina` sozinho
    // devolve sempre a primeira página, o que fazia o enriquecimento repetir 15 registros.
    origem, limit, pagina, page: pagina, per_page: limit, itens_por_pagina: limit,
  };
  const chamar = async (token) => fetch(`${baseUrl()}/api/v1/relatorio/cliente_servico`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify(corpo),
  });
  let resp = await chamar(await getTokenPainel(empresaId));
  if (resp.status === 401) { _tokenPainel = null; _expiraPainel = 0; resp = await chamar(await getTokenPainel(empresaId)); }
  const j = await resp.json().catch(() => null);
  if (!j || j.status !== 'success') {
    throw new Error(`HubSoft relatório: ${(j?.errors || []).join(' | ') || j?.msg || 'falha'}`);
  }
  const pg = j.paginador || {};
  return { registros: pg.data || [], pagina: pg.current_page || pagina, paginas: pg.last_page || 1, total: pg.total || 0 };
}

// Situação REAL do contrato de um serviço. O Relatório de Serviços devolve "-"
// para todo mundo nesse campo (não é confiável); este endpoint devolve o campo
// `aceito` (true/false) direto, sem ambiguidade. Sem contrato = array vazio.
async function statusContrato(empresaId, idClienteServico) {
  const chamar = async (token) => fetch(`${baseUrl()}/api/v1/cliente/servico/contrato/${idClienteServico}?status=true`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  let resp = await chamar(await getTokenPainel(empresaId));
  if (resp.status === 401) { _tokenPainel = null; _expiraPainel = 0; resp = await chamar(await getTokenPainel(empresaId)); }
  const j = await resp.json().catch(() => null);
  if (!j || j.status !== 'success') return null; // não afirma nada se a chamada falhar
  const contratos = j.contratos || [];
  if (!contratos.length) return 'sem_contrato';
  // Mais de um contrato no serviço: se algum foi aceito, considera assinado
  return contratos.some(c => c.aceito) ? 'assinado' : 'nao_assinado';
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
// tipoData: por padrão a API filtra por data_inicio_programado (agendamento), que
// NÃO é o que a Meta de Cobrança quer — ela precisa de quem fechou HOJE e por qual
// motivo, então passa tipo_data: 'data_termino_executado' (conferido em 07/08/2026:
// os dois filtros trazem conjuntos bem diferentes de O.S. no mesmo dia).
async function listarOrdensServico({ dataInicio, dataFim, maxPaginas = 60, tipoData } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/ordem_servico/todos', {
      pagina, itens_por_pagina: 100,
      data_inicio: dataInicio, data_fim: dataFim,
      ...(tipoData ? { tipo_data: tipoData } : {}),
      relacoes: 'agenda_ordem_servico,tecnicos',
    }),
    { extrair: d => d.ordens_servico || d.data || [], maxPaginas }
  );
}

// Dados que só existem na ORDEM DE SERVIÇO, indexados por id_cliente_servico:
// cidade real da instalação, status do serviço e o tipo da OS (que diz se foi
// instalação nova ou transferência). O cadastro do cliente não traz endereço.
async function dadosDeInstalacaoPorServico({ dataInicio, dataFim, maxPaginas = 80 } = {}) {
  const ordens = await buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/ordem_servico/todos', {
      pagina, itens_por_pagina: 100, data_inicio: dataInicio, data_fim: dataFim,
    }),
    { extrair: d => d.ordens_servico || d.data || [], maxPaginas }
  );
  const porServico = new Map();
  for (const o of ordens) {
    const id = o.dados_servico?.id_cliente_servico;
    if (!id) continue;
    const tipo = (o.tipo_ordem_servico?.descricao || '').trim();
    const anterior = porServico.get(id) || {};
    porServico.set(id, {
      cidade: o.dados_endereco_instalacao?.cidade || anterior.cidade || null,
      bairro: o.dados_endereco_instalacao?.bairro || anterior.bairro || null,
      servico_status: o.dados_servico?.servico_status || anterior.servico_status || null,
      // "INSTALAÇÃO" manda: se o serviço teve OS de instalação, é venda nova.
      tipo_os: anterior.tipo_os === 'INSTALAÇÃO' ? anterior.tipo_os : (tipo || anterior.tipo_os || null),
    });
  }
  return porServico;
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
// tipoVinculoOrigem: filtra pelo vínculo de ORIGEM (ex: 'servico_cliente' = o
// equipamento SAIU do serviço do cliente de volta pro estoque — é a remoção).
async function listarMovimentosEstoque({ dataInicio, dataFim, tipoVinculoDestino, tipoVinculoOrigem, maxPaginas = 300, deveCancelar } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/estoque/movimento_estoque', {
      pagina, itens_por_pagina: 500,
      data_inicio: dataInicio, data_fim: dataFim,
      tipo_data: 'movimento',
      ...(tipoVinculoDestino ? { tipo_vinculo_destino: tipoVinculoDestino } : {}),
      ...(tipoVinculoOrigem ? { tipo_vinculo_origem: tipoVinculoOrigem } : {}),
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

// Meta de Cobrança: acha TODAS as cobranças de um serviço pagas dentro do
// período e lê a observação de baixa de cada uma (formato "Cobrança recebida
// pelo cobrador X no valor de R$Y"). Um cliente pode ter várias cobranças
// baixadas no mesmo dia (ex.: internet + pacotes avulsos cobrados juntos) —
// pegar só a "mais recente" perdia as outras (confirmado em 07/08/2026: cliente
// com 4 cobranças pagas no mesmo dia, cada uma com sua observação e valor).
// Dois passos porque são IDs em namespaces diferentes: primeiro acha o id_cobranca
// dentro do detalhamento da fatura, depois consulta a cobrança em si (só ali
// existe o campo `observacao` — a fatura e o financeiro/cliente não têm esse campo).
// Nomes dos vendedores cadastrados no HubSoft (id -> nome). Cacheado — é uma
// lista de cadastro que quase nunca muda, não precisa buscar em toda chamada.
let _vendedoresCache = null, _vendedoresExpira = 0;
async function mapaVendedores() {
  if (_vendedoresCache && Date.now() < _vendedoresExpira) return _vendedoresCache;
  const v = await apiGet('/api/v1/integracao/configuracao/vendedor').catch(() => null);
  const mapa = new Map((v?.vendedores || []).map(x => [x.id, x.name]));
  _vendedoresCache = mapa; _vendedoresExpira = Date.now() + 30 * 60 * 1000; // 30min
  return mapa;
}

// "Quem deu baixa": no histórico da cobrança, a entrada de fato do recebimento
// tem o texto "recebida no caixa ..." (automática, via boleto/PIX/webhook) ou
// "recebida MANUALMENTE no caixa ..." (alguém deu baixa na mão) — a palavra
// "manualmente" no meio fazia a busca antiga não reconhecer a baixa manual
// (confirmado com caso real: cliente Maria da Conceição Ramos Rabelo, baixa
// manual no CAIXA STONE). As demais entradas do histórico são criação da
// cobrança ou edição da observação, não a baixa em si.
function quemDeuBaixa(historico) {
  const entrada = (historico || []).find(h => /recebida\s+(manualmente\s+)?no caixa/i.test(h.historico || ''));
  return { nome: entrada?.usuario?.name || null, data: entrada?.data_cadastro || null };
}

// Busca TODAS as cobranças de um serviço pagas dentro do período, com os dados
// completos pra Meta de Cobrança: observação (extrai valor/cobrador), valor
// pago, forma de pagamento, vendedor do serviço e quem deu a baixa no sistema.
// Um cliente pode ter várias cobranças baixadas no mesmo dia (ex.: internet +
// pacotes avulsos cobrados juntos) — por isso retorna todas, não só a última.
async function buscarRecebimentos(idClienteServico, { dataInicio, dataFim } = {}) {
  const fin = await apiGet('/api/v1/integracao/cliente/financeiro', {
    busca: 'id_cliente_servico', termo_busca: idClienteServico,
    apenas_pendente: 'nao', cobrancas_agrupadas: 'sim', retornar_composicao_cobranca: 'sim',
    order_by: 'data_vencimento', order_type: 'desc', limit: 30,
  }).catch(() => null);
  const faturas = fin?.faturas || [];
  const codigoCliente = fin?.faturas?.[0]?.cliente?.codigo_cliente || null;
  const nomeCliente = fin?.faturas?.[0]?.cliente?.nome_razaosocial || null;

  const pagas = [];
  for (const f of faturas) {
    for (const c of (f.detalhamento || [])) {
      if (!c.data_pagamento) continue;
      const dia = String(c.data_pagamento).slice(0, 10);
      if ((dataInicio && dia < dataInicio) || (dataFim && dia > dataFim)) continue;
      pagas.push({ ...c, tipo_cobranca_fatura: f.tipo_cobranca, id_fatura: f.id_fatura });
    }
  }
  if (!pagas.length) return [];

  const vendedores = await mapaVendedores();
  const resultados = [];
  for (const c of pagas) {
    const det = await apiGet(`/api/v1/cliente/financeiro/cobranca/${c.id_cobranca}`).catch(() => null);
    const cob = det?.cobranca;
    if (!cob) continue;
    const idVendedor = cob.cliente_servico?.id_usuario_vendedor;
    const baixa = quemDeuBaixa(cob.cobranca_historico);
    resultados.push({
      id_fatura: c.id_fatura, id_cobranca: c.id_cobranca, descricao_cobranca: cob.descricao || null,
      codigo_cliente: codigoCliente, nome_cliente: nomeCliente,
      valor_pago: Number(cob.valor_pago ?? c.valor_pago ?? 0) || 0,
      forma_pagamento: c.tipo_cobranca_fatura || null,
      vendedor: idVendedor ? (vendedores.get(idVendedor) || null) : null,
      quem_deu_baixa: baixa.nome,
      data_baixa: baixa.data,
      observacao: cob.observacao || null,
      data_pagamento: cob.data_pagamento,
    });
  }
  return resultados;
}

// Clientes (com busca opcional por nome/CPF/código)
async function listarClientes({ busca } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/cliente/todos', { pagina, itens_por_pagina: 100, ...(busca ? { busca } : {}) }),
    { extrair: d => d.clientes || d.data || [], maxPaginas: 60 }
  );
}

// Serviços (contratos) vendidos, com vendedor — para a Meta do Comercial.
// O HubSoft não tem endpoint direto de "venda"; o contrato vem aninhado em
// cliente/todos?relacoes=servicos. Filtrar por data_inicio/data_fim reduz MUITO
// o volume (testado: 16403 clientes → 476 num intervalo de ~1 mês), então NUNCA
// varrer todos os clientes sem esse filtro (ficaria pesado para o ERP).
// IMPORTANTE: o parâmetro `cancelado` tem padrão "nao" na API — sem passar "sim"
// explicitamente, todo contrato cancelado fica INVISÍVEL (nunca aparece, mesmo
// buscando todas as páginas). Documentado em docs/source/clientes/consulta.rst.
// Retorna a lista achatada de serviços (não de clientes), cada um com { cliente, ...servico }.
// ATENÇÃO 2: usar data_inicio/data_fim aqui PERDE VENDAS. Esses filtros são pela data de
// cadastro do CLIENTE, então uma venda feita em julho para um cliente cadastrado há anos não
// aparece (medido: janela de 24 meses retorna 10.768 dos 28.416 clientes = 38% da base).
// Por isso varremos a base completa; leva ~30s e garante 100% das vendas.
async function listarServicosVendidos({ dataInicio, dataFim, maxPaginas = 500 } = {}) {
  const clientes = await buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/cliente/todos', {
      pagina, itens_por_pagina: 100, relacoes: 'servicos', cancelado: 'sim',
      ...(dataInicio ? { data_inicio: dataInicio } : {}),
      ...(dataFim ? { data_fim: dataFim } : {}),
    }),
    { extrair: d => d.clientes || d.data || [], maxPaginas }
  );
  const servicos = [];
  for (const c of clientes) {
    for (const s of (c.servicos || [])) {
      // Cidade: a API de integração NÃO devolve endereço em nenhuma relação nem no
      // detalhe do cliente (conferido em ago/2026), então fica nulo aqui — quem
      // precisa de cidade usa a filial do vendedor.
      const cidade = s.endereco_instalacao?.cidade || s.endereco_cadastral?.cidade
        || c.endereco_instalacao?.cidade || c.endereco_cadastral?.cidade || null;
      servicos.push({
        ...s,
        cliente_nome: c.nome_razaosocial || c.nome_fantasia || null,
        cidade,
        tipo_pessoa: c.tipo_pessoa || null,   // 'pf' | 'pj' — usado na análise da meta
      });
    }
  }
  return servicos;
}

// ── Notas fiscais ────────────────────────────────────────────────────────────
// Todos os endpoints de nota fiscal exigem `documento` (CNPJ da empresa
// emissora, só dígitos) e usam o token de INTEGRAÇÃO normal (getToken), não o
// de painel. itens_por_pagina máx 500 (menos p/ nota_entrada, máx 50).
// Volume pode ser grande (dezenas de milhares no ano) — por isso quem chama
// estas funções deve sempre restringir o período (nunca "geral sem data").

// NFS-e (Modelo Serviços — ISS/Prefeitura)
async function listarNfse({ documento, dataInicio, dataFim, tipoData = 'data_emissao', status = 'todas', maxPaginas = 120 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/nota_fiscal/nfse', {
      documento: soDigitos(documento), tipo_data: tipoData,
      data_inicio: dataInicio, data_fim: dataFim, status,
      pagina, itens_por_pagina: 500,
    }),
    { extrair: d => d.nfses || [], maxPaginas }
  );
}

// NFCOM (Modelo 62 — telecom atual, substituiu o 21/22)
async function listarNfcom({ documento, dataInicio, dataFim, tipoData = 'data_emissao', status = 'todos', maxPaginas = 120 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/nota_fiscal/nfcom', {
      documento: soDigitos(documento), tipo_data: tipoData,
      data_inicio: dataInicio, data_fim: dataFim, status,
      pagina, itens_por_pagina: 500,
    }),
    { extrair: d => d.nfcoms || [], maxPaginas }
  );
}

// Telecom antigo (Modelo 21/22 — hoje substituído pela NFCOM na maioria dos casos)
async function listarNotaTelecom({ documento, dataInicio, dataFim, modelo, tipoData = 'data_emissao', status = 'todas', maxPaginas = 120 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/nota_fiscal/telecom', {
      documento: soDigitos(documento), tipo_data: tipoData,
      data_inicio: dataInicio, data_fim: dataFim, modelo, status,
      pagina, itens_por_pagina: 500,
    }),
    { extrair: d => d.notas_fiscais || d.notas || [], maxPaginas }
  );
}

// NF-e (Modelo 55 — produto)
async function listarNfe55({ documento, dataInicio, dataFim, tipoData = 'data_emissao', status, maxPaginas = 120 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/nota_fiscal/nfe', {
      documento: soDigitos(documento), tipo_data: tipoData,
      data_inicio: dataInicio, data_fim: dataFim, ...(status ? { status } : {}),
      pagina, itens_por_pagina: 500,
    }),
    { extrair: d => d.nfes || [], maxPaginas }
  );
}

// Notas de entrada (compras recebidas de fornecedor) — itens_por_pagina máx 50
async function listarNotaEntrada({ dataInicio, dataFim, maxPaginas = 40 } = {}) {
  return buscarTodasPaginas(
    (pagina) => apiGet('/api/v1/integracao/nota_fiscal/nota_entrada', {
      data_inicio: dataInicio, data_fim: dataFim,
      pagina, itens_por_pagina: 50,
    }),
    { extrair: d => d.notas_entrada || d.notas || [], maxPaginas }
  );
}

function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }

module.exports = {
  apiGet, listarEquipamentos, listarProdutos, listarOrdensServico, dadosDeInstalacaoPorServico,
  relatorioServicos, autenticarPainel, statusContrato,
  listarFaturas, listarAtendimentos, listarClientes, listarMovimentosEstoque,
  listarServicosVendidos, buscarTiposOSPorId, getToken, CanceladoError,
  buscarRecebimentos,
  listarNfse, listarNfcom, listarNotaTelecom, listarNfe55, listarNotaEntrada,
};
