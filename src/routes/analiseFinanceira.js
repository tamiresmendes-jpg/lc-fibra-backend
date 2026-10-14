// ─────────────────────────────────────────────────────────────────────────────
// Análise Financeira — lê SOMENTE das tabelas locais fin_fatura / fin_conta_pagar
// (alimentadas por services/finSync.js, só pelo job da madrugada). Nunca consulta o ERP aqui.
//
// Três visões distintas, para não confundir fatura emitida com dinheiro em conta
// nem previsão com recebimento confirmado:
//   competencia  → o que foi emitido/faturado (data de emissão da fatura)
//   movimentacao → o que efetivamente entrou/saiu (crédito, ou pagamento se sem crédito)
//   previsao     → o que ainda está previsto (em aberto, por vencimento)
//   carteira     → tudo que VENCE no período (critério da tela antiga / do relatório do painel)
//
// Montada dentro de routes/erp.js (herda autenticação e permissão
// 'erp.analise-financeira'; ver MAPA_PERMISSAO em utils/permissoes.js).
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const XLSX = require('xlsx');
const { get, all } = require('../config/database');
const { buscarPermsEfetivas, temPermissaoServer } = require('../utils/permissoes');
const { agendarSincronizacao, statusSincronizacao } = require('../services/finSync');

const router = express.Router();

const n = (v) => Number(v) || 0;
const hojeSP = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const reData = /^\d{4}-\d{2}-\d{2}$/;
const NULO = '__nulo__';

// Data usada para colocar a fatura "dentro do período", conforme o filtro.
const COL_DATA = { emissao: 'f.emissao', vencimento: 'f.vencimento', pagamento: 'COALESCE(f.credito, f.pagamento)' };

function periodo(q) {
  const hoje = hojeSP();
  const ini = reData.test(q.data_inicio || '') ? q.data_inicio : hoje.slice(0, 8) + '01';
  const fim = reData.test(q.data_fim || '') ? q.data_fim : (() => {
    const [a, m] = hoje.split('-').map(Number);
    return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
  })();
  return { ini, fim, hoje };
}

// Filtros comuns às faturas (alias f). Retorna { where, params }.
function filtrosFatura(req, q) {
  const w = ['f.empresa_id = ?', 'f.ativo = 1'];
  const p = [req.usuario.empresa_id];
  if (q.empresa_doc) { w.push('f.empresa_doc = ?'); p.push(q.empresa_doc); }
  if (q.empresa_nome) { w.push('f.empresa_nome = ?'); p.push(q.empresa_nome); }
  if (q.banco === NULO) w.push('f.banco_nome IS NULL');
  else if (q.banco) { w.push('f.banco_nome = ?'); p.push(q.banco); }
  if (q.forma === NULO) w.push('f.tipo_cobranca IS NULL');
  else if (q.forma) { w.push('f.tipo_cobranca = ?'); p.push(q.forma); }
  if (q.cliente_id) { w.push('f.cliente_id = ?'); p.push(Number(q.cliente_id) || 0); }
  if (q.cliente) {
    w.push('(f.cliente_nome ILIKE ? OR f.cliente_doc LIKE ? OR f.cliente_codigo = ?)');
    p.push(`%${q.cliente}%`, `%${String(q.cliente).replace(/\D/g, '') || '@@'}%`, String(q.cliente));
  }
  if (q.tipo_pessoa) { w.push('f.tipo_pessoa = ?'); p.push(q.tipo_pessoa); }
  return { where: w, params: p };
}

function condSituacao(situacao, hoje) {
  switch (situacao) {
    case 'paga': return 'f.pagamento IS NOT NULL';
    case 'aberta': return 'f.pagamento IS NULL';
    case 'vencida': return `f.pagamento IS NULL AND f.vencimento < '${hoje}'`;
    case 'a_vencer': return `f.pagamento IS NULL AND f.vencimento >= '${hoje}'`;
    default: return null;
  }
}

// O driver devolve NUMERIC e BIGINT/COUNT como texto: converte só as colunas
// numéricas conhecidas (CPF/CNPJ, nosso número etc. ficam como texto p/ não perder zeros).
const CAMPOS_NUMERICOS = new Set([
  'qtd', 'faturado', 'recebido', 'a_receber', 'vencido', 'a_vencer', 'descontos', 'qtd_pagas', 'qtd_abertas', 'qtd_vencidas',
  'clientes', 'clientes_inadimplentes', 'juros', 'qtd_sem_credito', 'valor_sem_credito', 'pago', 'pendente', 'valor',
  'valor_pago', 'juros_pago', 'desconto', 'desconto_pct', 'dias_atraso', 'acrescimo', 'id_fatura', 'cliente_id', 'id_conta_pagar',
]);
function numeros(o) {
  const r = {};
  for (const k of Object.keys(o)) r[k] = CAMPOS_NUMERICOS.has(k) && o[k] !== null && o[k] !== '' ? Number(o[k]) : o[k];
  return r;
}

// Bloco padrão de totais sobre um conjunto de faturas (hoje validado: AAAA-MM-DD).
const SELECT_TOTAIS = (hoje) => `
  COUNT(*) AS qtd,
  COALESCE(SUM(f.valor),0) AS faturado,
  COALESCE(SUM(f.valor_pago) FILTER (WHERE f.pagamento IS NOT NULL),0) AS recebido,
  COALESCE(SUM(f.valor) FILTER (WHERE f.pagamento IS NULL),0) AS a_receber,
  COALESCE(SUM(f.valor) FILTER (WHERE f.pagamento IS NULL AND f.vencimento < '${hoje}'),0) AS vencido,
  COALESCE(SUM(f.valor) FILTER (WHERE f.pagamento IS NULL AND f.vencimento >= '${hoje}'),0) AS a_vencer,
  COALESCE(SUM(f.desconto),0) AS descontos,
  COUNT(*) FILTER (WHERE f.pagamento IS NOT NULL) AS qtd_pagas,
  COUNT(*) FILTER (WHERE f.pagamento IS NULL) AS qtd_abertas,
  COUNT(*) FILTER (WHERE f.pagamento IS NULL AND f.vencimento < '${hoje}') AS qtd_vencidas,
  COUNT(DISTINCT f.cliente_id) AS clientes,
  COUNT(DISTINCT f.cliente_id) FILTER (WHERE f.pagamento IS NULL AND f.vencimento < '${hoje}') AS clientes_inadimplentes`;

// ── GET /resumo ─────────────────────────────────────────────────────────────
router.get('/resumo', async (req, res) => {
  try {
    const { ini, fim, hoje } = periodo(req.query);
    const { where, params } = filtrosFatura(req, req.query);
    const base = where.join(' AND ');

    const [competencia, movimentacao, previsao, carteira] = await Promise.all([
      get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(f.valor),0) AS faturado, COALESCE(SUM(f.desconto),0) AS descontos,
                  COUNT(DISTINCT f.cliente_id) AS clientes
           FROM fin_fatura f WHERE ${base} AND f.emissao BETWEEN ? AND ?`, [...params, ini, fim]),
      get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(f.valor_pago),0) AS recebido, COALESCE(SUM(f.juros_pago),0) AS juros,
                  COUNT(*) FILTER (WHERE f.credito IS NULL) AS qtd_sem_credito,
                  COALESCE(SUM(f.valor_pago) FILTER (WHERE f.credito IS NULL),0) AS valor_sem_credito
           FROM fin_fatura f WHERE ${base} AND f.pagamento IS NOT NULL AND COALESCE(f.credito, f.pagamento) BETWEEN ? AND ?`, [...params, ini, fim]),
      get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(f.valor),0) AS a_receber,
                  COALESCE(SUM(f.valor) FILTER (WHERE f.vencimento < '${hoje}'),0) AS vencido,
                  COALESCE(SUM(f.valor) FILTER (WHERE f.vencimento >= '${hoje}'),0) AS a_vencer,
                  COUNT(DISTINCT f.cliente_id) FILTER (WHERE f.vencimento < '${hoje}') AS clientes_inadimplentes
           FROM fin_fatura f WHERE ${base} AND f.pagamento IS NULL AND f.vencimento BETWEEN ? AND ?`, [...params, ini, fim]),
      get(`SELECT ${SELECT_TOTAIS(hoje)} FROM fin_fatura f WHERE ${base} AND f.vencimento BETWEEN ? AND ?`, [...params, ini, fim]),
    ]);

    // Saídas (contas a pagar) — só filtram por empresa/CNPJ.
    const wp = ['c.empresa_id = ?', 'c.ativo = 1']; const pp = [req.usuario.empresa_id];
    if (req.query.empresa_doc) { wp.push('c.empresa_doc = ?'); pp.push(req.query.empresa_doc); }
    const baseP = wp.join(' AND ');
    const [pagas, previstas] = await Promise.all([
      get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(c.valor_pago),0) AS pago
           FROM fin_conta_pagar c WHERE ${baseP} AND c.pagamento BETWEEN ? AND ?`, [...pp, ini, fim]),
      get(`SELECT COUNT(*) AS qtd, COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)),0) AS pendente,
                  COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)) FILTER (WHERE c.vencimento < '${hoje}'),0) AS vencido,
                  COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)) FILTER (WHERE c.vencimento >= '${hoje}'),0) AS a_vencer
           FROM fin_conta_pagar c WHERE ${baseP} AND c.status <> 'pago' AND c.vencimento BETWEEN ? AND ?`, [...pp, ini, fim]),
    ]);

    const entradas = n(movimentacao.recebido), saidas = n(pagas.pago);
    res.json({
      periodo: { data_inicio: ini, data_fim: fim, hoje },
      competencia: numeros(competencia),
      movimentacao: numeros(movimentacao),
      previsao: numeros(previsao),
      carteira: numeros(carteira),
      saidas: { pagas: numeros(pagas), previstas: numeros(previstas) },
      // Resultado de caixa REALIZADO no período. Não é saldo bancário: o ERP não informa saldo de conta.
      resultado_caixa: { entradas, saidas, saldo: entradas - saidas },
      origem: ORIGEM,
    });
  } catch (e) {
    console.error('Erro /analise-financeira/resumo:', e.message);
    res.status(500).json({ erro: 'Erro ao montar o resumo financeiro.' });
  }
});

const ORIGEM = {
  competencia: 'Faturas emitidas no período (data de cadastro da fatura no HubSoft). Representa receita faturada, não dinheiro recebido.',
  movimentacao: 'Faturas baixadas no período, pela data de crédito (ou pela data de pagamento quando o crédito ainda não foi informado). Valor = valor pago.',
  previsao: 'Faturas ainda em aberto com vencimento no período. Previsão — não é recebimento confirmado.',
  carteira: 'Todas as faturas com vencimento no período (mesmo critério do relatório Contas a Receber do painel).',
  saidas: 'Contas a pagar do HubSoft: pagas pela data de pagamento; pendentes pelo vencimento. Banco/conta de origem e forma de pagamento não são informados pelo ERP.',
  fonte: 'HubSoft — API de integração financeiro/fatura e financeiro/conta_pagar, copiadas para o banco local pela rotina de madrugada.',
};

// ── GET /agrupado?por=mes|dia|banco|forma|empresa|cliente ───────────────────
const DIMENSOES = {
  mes: (col) => `SUBSTR(${col},1,7)`,
  dia: (col) => `${col}`,
  banco: () => `COALESCE(f.banco_nome, 'Não informado')`,
  forma: () => `COALESCE(f.tipo_cobranca, 'Não informado')`,
  empresa: () => `COALESCE(f.empresa_nome, 'Não informado')`,
  cliente: () => `COALESCE(f.cliente_nome, 'Não informado') || ' [' || COALESCE(f.cliente_id::text,'-') || ']'`,
};

router.get('/agrupado', async (req, res) => {
  try {
    const { ini, fim, hoje } = periodo(req.query);
    const tipoData = COL_DATA[req.query.tipo_data] ? req.query.tipo_data : 'vencimento';
    const col = COL_DATA[tipoData];
    const por = DIMENSOES[req.query.por] ? req.query.por : 'mes';
    const { where, params } = filtrosFatura(req, req.query);
    const sit = condSituacao(req.query.situacao, hoje);
    if (sit) where.push(sit);
    const dim = DIMENSOES[por](col);
    const limite = por === 'cliente' ? 200 : 500;
    const ordem = (por === 'mes' || por === 'dia') ? 'chave ASC' : 'faturado DESC';
    const rows = await all(
      `SELECT ${dim} AS chave, ${SELECT_TOTAIS(hoje)}
       FROM fin_fatura f WHERE ${where.join(' AND ')} AND ${col} BETWEEN ? AND ?
       GROUP BY 1 ORDER BY ${ordem} LIMIT ${limite}`, [...params, ini, fim]);
    res.json({ periodo: { data_inicio: ini, data_fim: fim, tipo_data: tipoData }, por, linhas: rows.map(numeros) });
  } catch (e) {
    console.error('Erro /analise-financeira/agrupado:', e.message);
    res.status(500).json({ erro: 'Erro ao agrupar os dados.' });
  }
});

// ── Lista de faturas (rastreabilidade) — usada na tela e no Excel ───────────
function montarListaFaturas(req) {
  const q = req.query;
  const { ini, fim, hoje } = periodo(q);
  const tipoData = COL_DATA[q.tipo_data] ? q.tipo_data : 'vencimento';
  const col = COL_DATA[tipoData];
  const { where, params } = filtrosFatura(req, q);
  where.push(`${col} BETWEEN ? AND ?`); params.push(ini, fim);
  if (q.mes && /^\d{4}-\d{2}$/.test(q.mes)) { where.push(`SUBSTR(${col},1,7) = ?`); params.push(q.mes); }
  if (q.dia && reData.test(q.dia)) { where.push(`${col} = ?`); params.push(q.dia); }
  const sit = condSituacao(q.situacao, hoje);
  if (sit) where.push(sit);
  if (q.com_desconto === '1') where.push('f.desconto > 0');
  if (tipoData === 'pagamento') where.push('f.pagamento IS NOT NULL');
  return { where: where.join(' AND '), params, ini, fim, hoje, tipoData };
}

const SELECT_LISTA = (hoje) => `
  f.id_fatura, f.nosso_numero, f.cliente_id, f.cliente_codigo, f.cliente_nome, f.cliente_doc,
  f.emissao, f.vencimento, f.pagamento, f.credito, f.valor, f.valor_pago, f.juros_pago, f.desconto,
  CASE WHEN f.desconto > 0 AND f.valor + f.desconto > 0 THEN ROUND(f.desconto / (f.valor + f.desconto) * 100, 2) END AS desconto_pct,
  f.tipo_cobranca, f.banco_nome, f.conta, f.empresa_nome, f.empresa_doc, f.link,
  CASE WHEN f.pagamento IS NOT NULL THEN 'Paga'
       WHEN f.vencimento < '${hoje}' THEN 'Vencida' ELSE 'A vencer' END AS situacao,
  CASE WHEN f.pagamento IS NULL AND f.vencimento < '${hoje}' THEN ('${hoje}'::date - f.vencimento::date) END AS dias_atraso`;

router.get('/faturas', async (req, res) => {
  try {
    const { where, params, hoje } = montarListaFaturas(req);
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const [tot, rows] = await Promise.all([
      get(`SELECT ${SELECT_TOTAIS(hoje)} FROM fin_fatura f WHERE ${where}`, params),
      all(`SELECT ${SELECT_LISTA(hoje)} FROM fin_fatura f WHERE ${where}
           ORDER BY f.vencimento ASC, f.id_fatura ASC LIMIT ${limite} OFFSET ${offset}`, params),
    ]);
    res.json({ total: numeros(tot), limite, offset, faturas: rows.map(numeros) });
  } catch (e) {
    console.error('Erro /analise-financeira/faturas:', e.message);
    res.status(500).json({ erro: 'Erro ao listar faturas.' });
  }
});

// ── GET /exportar — Excel com as faturas que compõem o recorte ──────────────
router.get('/exportar', async (req, res) => {
  try {
    const { where, params, hoje, ini, fim, tipoData } = montarListaFaturas(req);
    const rows = await all(
      `SELECT ${SELECT_LISTA(hoje)} FROM fin_fatura f WHERE ${where}
       ORDER BY f.vencimento ASC, f.id_fatura ASC LIMIT 100000`, params);
    const dados = rows.map((r) => ({
      'Fatura': r.id_fatura, 'Nosso número': r.nosso_numero, 'Cliente': r.cliente_nome, 'Cód. cliente': r.cliente_codigo,
      'CPF/CNPJ': r.cliente_doc, 'Empresa': r.empresa_nome, 'Emissão': r.emissao, 'Vencimento': r.vencimento,
      'Pagamento': r.pagamento, 'Crédito': r.credito, 'Valor': n(r.valor), 'Valor pago': r.valor_pago == null ? null : n(r.valor_pago),
      'Juros pagos': r.juros_pago == null ? null : n(r.juros_pago), 'Desconto': n(r.desconto), 'Desconto %': r.desconto_pct == null ? null : n(r.desconto_pct),
      'Forma de cobrança': r.tipo_cobranca, 'Banco': r.banco_nome, 'Conta': r.conta, 'Situação': r.situacao, 'Dias de atraso': r.dias_atraso,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dados), 'Faturas');
    const info = [
      ['Origem', ORIGEM.fonte],
      ['Período', `${ini} a ${fim} (por ${tipoData})`],
      ['Gerado em', new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)],
      ['Registros', dados.length], [],
      ['Competência', ORIGEM.competencia], ['Movimentação', ORIGEM.movimentacao],
      ['Previsão', ORIGEM.previsao], ['Carteira', ORIGEM.carteira],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Origem');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="faturas_${ini}_${fim}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('Erro /analise-financeira/exportar:', e.message);
    res.status(500).json({ erro: 'Erro ao gerar o Excel.' });
  }
});

// ── Saídas: contas a pagar ──────────────────────────────────────────────────
// GET /pagar/agrupado?por=mes|fornecedor|categoria|status  (por vencimento, ou pagamento se tipo_data=pagamento)
router.get('/pagar/agrupado', async (req, res) => {
  try {
    const { ini, fim, hoje } = periodo(req.query);
    const col = req.query.tipo_data === 'pagamento' ? 'c.pagamento' : 'c.vencimento';
    const w = ['c.empresa_id = ?', 'c.ativo = 1', `${col} BETWEEN ? AND ?`];
    const p = [req.usuario.empresa_id, ini, fim];
    if (req.query.empresa_doc) { w.push('c.empresa_doc = ?'); p.push(req.query.empresa_doc); }
    const por = ['mes', 'fornecedor', 'categoria', 'status'].includes(req.query.por) ? req.query.por : 'mes';
    const campos = `COUNT(*) AS qtd, COALESCE(SUM(c.valor),0) AS valor,
      COALESCE(SUM(c.valor_pago),0) AS pago,
      COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)) FILTER (WHERE c.status <> 'pago'),0) AS pendente,
      COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)) FILTER (WHERE c.status <> 'pago' AND c.vencimento < '${hoje}'),0) AS vencido`;
    let sql;
    if (por === 'categoria') {
      // plano_conta vem rateado por percentual: cada conta entra em cada categoria pela parte dela.
      sql = `SELECT COALESCE(pc->>'descricao','Sem categoria') AS chave, COUNT(*) AS qtd,
               COALESCE(SUM((pc->>'valor')::numeric),0) AS valor,
               COALESCE(SUM(c.valor_pago * COALESCE((pc->>'percentual')::numeric,0)/100),0) AS pago,
               COALESCE(SUM((pc->>'valor')::numeric) FILTER (WHERE c.status <> 'pago'),0) AS pendente,
               COALESCE(SUM((pc->>'valor')::numeric) FILTER (WHERE c.status <> 'pago' AND c.vencimento < '${hoje}'),0) AS vencido
             FROM fin_conta_pagar c
             LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN c.plano_conta IS NULL OR c.plano_conta='[]' THEN '[{}]'::jsonb ELSE c.plano_conta::jsonb END) pc ON TRUE
             WHERE ${w.join(' AND ')} GROUP BY 1 ORDER BY valor DESC LIMIT 300`;
    } else {
      const dim = { mes: `SUBSTR(${col},1,7)`, fornecedor: `COALESCE(c.fornecedor_nome,'Não informado')`, status: 'c.status' }[por];
      sql = `SELECT ${dim} AS chave, ${campos} FROM fin_conta_pagar c WHERE ${w.join(' AND ')} GROUP BY 1
             ORDER BY ${por === 'mes' ? 'chave ASC' : 'valor DESC'} LIMIT 300`;
    }
    const rows = await all(sql, p);
    res.json({ periodo: { data_inicio: ini, data_fim: fim }, por, linhas: rows.map(numeros) });
  } catch (e) {
    console.error('Erro /analise-financeira/pagar/agrupado:', e.message);
    res.status(500).json({ erro: 'Erro ao agrupar contas a pagar.' });
  }
});

router.get('/pagar/lista', async (req, res) => {
  try {
    const { ini, fim, hoje } = periodo(req.query);
    const col = req.query.tipo_data === 'pagamento' ? 'c.pagamento' : 'c.vencimento';
    const w = ['c.empresa_id = ?', 'c.ativo = 1', `${col} BETWEEN ? AND ?`];
    const p = [req.usuario.empresa_id, ini, fim];
    if (req.query.empresa_doc) { w.push('c.empresa_doc = ?'); p.push(req.query.empresa_doc); }
    if (req.query.status === 'pendente') w.push(`c.status <> 'pago'`);
    if (req.query.status === 'vencida') w.push(`c.status <> 'pago' AND c.vencimento < '${hoje}'`);
    if (req.query.status === 'paga') w.push(`c.status = 'pago'`);
    const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = await all(
      `SELECT c.id_conta_pagar, c.descricao, c.status, c.vencimento, c.pagamento, c.valor, c.valor_pago, c.acrescimo, c.desconto,
              c.fornecedor_nome, c.empresa_nome, c.plano_conta
       FROM fin_conta_pagar c WHERE ${w.join(' AND ')} ORDER BY c.vencimento ASC, c.id_conta_pagar ASC LIMIT ${limite} OFFSET ${offset}`, p);
    res.json({ limite, offset, contas: rows.map((r) => ({ ...numeros(r), plano_conta: safeJson(r.plano_conta) })) });
  } catch (e) {
    console.error('Erro /analise-financeira/pagar/lista:', e.message);
    res.status(500).json({ erro: 'Erro ao listar contas a pagar.' });
  }
});

function safeJson(s) { try { return JSON.parse(s || '[]'); } catch { return []; } }

// ── Opções dos filtros (empresas, bancos, formas) vindas dos dados locais ───
router.get('/opcoes', async (req, res) => {
  try {
    const e = req.usuario.empresa_id;
    const [empresas, bancos, formas] = await Promise.all([
      all(`SELECT DISTINCT empresa_doc AS doc, empresa_nome AS nome FROM fin_fatura WHERE empresa_id=? AND empresa_doc IS NOT NULL ORDER BY 2`, [e]),
      all(`SELECT DISTINCT banco_nome AS nome FROM fin_fatura WHERE empresa_id=? AND banco_nome IS NOT NULL ORDER BY 1`, [e]),
      all(`SELECT DISTINCT tipo_cobranca AS nome FROM fin_fatura WHERE empresa_id=? AND tipo_cobranca IS NOT NULL ORDER BY 1`, [e]),
    ]);
    res.json({ empresas, bancos: bancos.map((b) => b.nome), formas: formas.map((f) => f.nome) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao carregar opções.' });
  }
});

// ── Sincronização (manual) ──────────────────────────────────────────────────
router.get('/sincronizacao', async (req, res) => {
  try {
    const e = req.usuario.empresa_id;
    const [status, f, c] = await Promise.all([
      statusSincronizacao(e),
      get(`SELECT COUNT(*) AS qtd, MIN(vencimento) AS de, MAX(vencimento) AS ate, MAX(sync_em) AS ultima FROM fin_fatura WHERE empresa_id=? AND ativo=1`, [e]),
      get(`SELECT COUNT(*) AS qtd, MIN(vencimento) AS de, MAX(vencimento) AS ate, MAX(sync_em) AS ultima FROM fin_conta_pagar WHERE empresa_id=? AND ativo=1`, [e]),
    ]);
    res.json({ status, faturas: numeros(f), contas_pagar: numeros(c) });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao consultar a sincronização.' });
  }
});

router.post('/sincronizar', express.json(), async (req, res) => {
  try {
    if (req.usuario.perfil !== 'admin') {
      let ownPerms = null;
      try {
        const u = await get('SELECT permissoes_modulos FROM usuarios WHERE id = ?', [req.usuario.id]);
        if (u?.permissoes_modulos) ownPerms = JSON.parse(u.permissoes_modulos);
      } catch { ownPerms = null; }
      const perms = await buscarPermsEfetivas(req.usuario.id, req.usuario.empresa_id, ownPerms);
      if (!temPermissaoServer(perms, 'erp.analise-financeira', 'editar')) {
        return res.status(403).json({ erro: 'Sem permissão para sincronizar com o ERP.' });
      }
    }
    const { tipo, data_inicio, data_fim } = req.body || {};
    const r = await agendarSincronizacao(req.usuario.empresa_id, tipo, data_inicio, data_fim);
    if (r.erro) return res.status(400).json(r);
    res.json({ ok: true, mensagem: 'Agendado: o HubSoft só é consultado de madrugada, no horário da rotina financeira. Os dados aparecem aqui na manhã seguinte.' });
  } catch (e) {
    console.error('Erro /analise-financeira/sincronizar:', e.message);
    res.status(500).json({ erro: 'Erro ao iniciar a sincronização.' });
  }
});

module.exports = router;
