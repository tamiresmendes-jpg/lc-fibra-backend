// ─────────────────────────────────────────────────────────────────────────────
// Análise Financeira — painel agregado (cards e gráficos), janeiro a dezembro.
// Lê SOMENTE das tabelas locais fin_fatura / fin_conta_pagar (alimentadas por
// services/finSync.js, só pelo job da madrugada). Nunca consulta o ERP aqui.
//
// SEM dado de cliente: nada de nome, CPF/CNPJ ou lista de clientes — só valores,
// quantidades e contagens de clientes distintos (por id interno).
//
// Três visões distintas, para não confundir fatura emitida com dinheiro em conta
// nem previsão com recebimento confirmado:
//   faturamento  → o que VENCE no mês (mesmo critério do relatório Contas a Receber do painel)
//   movimentacao → o que efetivamente entrou/saiu (crédito, ou pagamento se sem crédito)
//   previsao     → o que ainda está em aberto (a vencer / vencido) + projeção do fechamento
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

const ORIGEM = {
  faturamento: 'Faturas com vencimento no mês (mesmo critério do relatório Contas a Receber do painel do HubSoft). É receita faturada, não dinheiro recebido.',
  movimentacao: 'Dinheiro que efetivamente entrou: faturas baixadas no mês, pela data de crédito (ou pela data de pagamento quando o crédito ainda não foi informado). Saídas: contas a pagar pagas, pela data de pagamento.',
  previsao: 'Faturas ainda em aberto (a vencer ou vencidas) e contas a pagar pendentes. É previsão — não é recebimento nem pagamento confirmado.',
  projecao: 'Estimativa do fechamento do mês: recebido até hoje + parte do que ainda vence, na mesma proporção dos últimos 3 meses encerrados. É projeção, não valor confirmado.',
  fonte: 'HubSoft — API de integração financeiro/fatura e financeiro/conta_pagar, copiadas para o banco local pela rotina da madrugada. Sem dados pessoais de clientes.',
  limites: 'O ERP não informa saldo de conta bancária nem banco/forma de pagamento das saídas; por isso o "resultado de caixa" é entradas menos saídas pagas, não um saldo.',
};

const CAMPOS = new Set(['qtd', 'faturado', 'recebido', 'a_receber', 'vencido', 'a_vencer', 'descontos', 'clientes', 'inadimplentes', 'valor', 'pago', 'pendente', 'juros']);
function numeros(o) {
  const r = {};
  for (const k of Object.keys(o)) r[k] = CAMPOS.has(k) && o[k] !== null && o[k] !== '' ? Number(o[k]) : o[k];
  return r;
}
const mesNum = (m) => Number(m);

async function montarPainel(req) {
  const hoje = hojeSP();
  const anoAtual = Number(hoje.slice(0, 4));
  const ano = /^\d{4}$/.test(req.query.ano || '') ? Number(req.query.ano) : anoAtual;
  const e = req.usuario.empresa_id;
  const docF = req.query.empresa_doc || null;

  // Filtros comuns (alias f / c). 'ano' vai sempre como texto de 4 dígitos.
  const wf = ['f.empresa_id = ?', 'f.ativo = 1']; const pf = [e];
  const wc = ['c.empresa_id = ?', 'c.ativo = 1']; const pc = [e];
  if (docF) { wf.push('f.empresa_doc = ?'); pf.push(docF); wc.push('c.empresa_doc = ?'); pc.push(docF); }
  const BF = wf.join(' AND '), BC = wc.join(' AND ');
  const a = String(ano);

  const aberto = `f.pagamento IS NULL`;
  const vencidoF = `f.pagamento IS NULL AND f.vencimento < '${hoje}'`;
  const agrup = (dim) => `SELECT ${dim} AS chave, COUNT(*) AS qtd, COALESCE(SUM(f.valor),0) AS faturado,
      COALESCE(SUM(f.valor_pago) FILTER (WHERE f.pagamento IS NOT NULL),0) AS recebido,
      COALESCE(SUM(f.valor) FILTER (WHERE ${aberto}),0) AS a_receber,
      COALESCE(SUM(f.valor) FILTER (WHERE ${vencidoF}),0) AS vencido,
      COALESCE(SUM(f.desconto),0) AS descontos
    FROM fin_fatura f WHERE ${BF} AND SUBSTR(f.vencimento,1,4) = ? GROUP BY 1 ORDER BY faturado DESC LIMIT 12`;

  const [fat, mov, saiPagas, saiPrev, banco, forma, tipoPessoa, empresas, categorias, anoClientes, cobFat, cobCp, totFat] = await Promise.all([
    all(`SELECT SUBSTR(f.vencimento,6,2) AS m, COUNT(*) AS qtd, COALESCE(SUM(f.valor),0) AS faturado,
           COALESCE(SUM(f.valor_pago) FILTER (WHERE f.pagamento IS NOT NULL),0) AS recebido,
           COALESCE(SUM(f.valor) FILTER (WHERE ${aberto}),0) AS a_receber,
           COALESCE(SUM(f.valor) FILTER (WHERE ${vencidoF}),0) AS vencido,
           COALESCE(SUM(f.valor) FILTER (WHERE ${aberto} AND f.vencimento >= '${hoje}'),0) AS a_vencer,
           COALESCE(SUM(f.desconto),0) AS descontos, COUNT(DISTINCT f.cliente_id) AS clientes,
           COUNT(DISTINCT f.cliente_id) FILTER (WHERE ${vencidoF}) AS inadimplentes
         FROM fin_fatura f WHERE ${BF} AND SUBSTR(f.vencimento,1,4) = ? GROUP BY 1`, [...pf, a]),
    all(`SELECT SUBSTR(COALESCE(f.credito,f.pagamento),6,2) AS m, COALESCE(SUM(f.valor_pago),0) AS recebido, COUNT(*) AS qtd,
           COALESCE(SUM(f.juros_pago),0) AS juros
         FROM fin_fatura f WHERE ${BF} AND f.pagamento IS NOT NULL AND SUBSTR(COALESCE(f.credito,f.pagamento),1,4) = ? GROUP BY 1`, [...pf, a]),
    all(`SELECT SUBSTR(c.pagamento,6,2) AS m, COALESCE(SUM(c.valor_pago),0) AS pago, COUNT(*) AS qtd
         FROM fin_conta_pagar c WHERE ${BC} AND c.pagamento IS NOT NULL AND SUBSTR(c.pagamento,1,4) = ? GROUP BY 1`, [...pc, a]),
    all(`SELECT SUBSTR(c.vencimento,6,2) AS m, COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)),0) AS pendente,
           COALESCE(SUM(c.valor - COALESCE(c.valor_pago,0)) FILTER (WHERE c.vencimento < '${hoje}'),0) AS vencido
         FROM fin_conta_pagar c WHERE ${BC} AND c.status <> 'pago' AND SUBSTR(c.vencimento,1,4) = ? GROUP BY 1`, [...pc, a]),
    all(agrup(`COALESCE(f.banco_nome,'Não informado')`), [...pf, a]),
    all(agrup(`COALESCE(f.tipo_cobranca,'Não informado')`), [...pf, a]),
    all(agrup(`CASE f.tipo_pessoa WHEN 'pf' THEN 'Pessoa física' WHEN 'pj' THEN 'Pessoa jurídica' ELSE 'Não informado' END`), [...pf, a]),
    all(agrup(`COALESCE(f.empresa_nome,'Não informado')`), [...pf, a]),
    all(`SELECT COALESCE(pc->>'descricao','Sem categoria') AS chave, COALESCE(SUM((pc->>'valor')::numeric),0) AS valor,
           COALESCE(SUM((pc->>'valor')::numeric) FILTER (WHERE c.status <> 'pago'),0) AS pendente
         FROM fin_conta_pagar c
         LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN c.plano_conta IS NULL OR c.plano_conta='[]' THEN '[{}]'::jsonb ELSE c.plano_conta::jsonb END) pc ON TRUE
         WHERE ${BC} AND SUBSTR(c.vencimento,1,4) = ? GROUP BY 1 ORDER BY valor DESC LIMIT 10`, [...pc, a]),
    get(`SELECT COUNT(DISTINCT f.cliente_id) AS clientes, COUNT(DISTINCT f.cliente_id) FILTER (WHERE ${vencidoF}) AS inadimplentes
         FROM fin_fatura f WHERE ${BF} AND SUBSTR(f.vencimento,1,4) = ?`, [...pf, a]),
    all(`SELECT mes FROM fin_sync_mes WHERE empresa_id=? AND tipo='faturas' AND mes LIKE ?`, [e, `${a}-%`]),
    all(`SELECT mes FROM fin_sync_mes WHERE empresa_id=? AND tipo='contas_pagar' AND mes LIKE ?`, [e, `${a}-%`]),
    get(`SELECT COUNT(*) AS qtd FROM fin_fatura f WHERE ${BF}`, pf),
  ]);

  const idx = (rows, campo = 'm') => Object.fromEntries(rows.map((r) => [mesNum(r[campo]), numeros(r)]));
  const iFat = idx(fat), iMov = idx(mov), iPag = idx(saiPagas), iPrev = idx(saiPrev);

  const meses = [];
  for (let m = 1; m <= 12; m++) {
    const f = iFat[m] || {}, mv = iMov[m] || {}, sp = iPag[m] || {}, pr = iPrev[m] || {};
    const entradas = n(mv.recebido), saidas = n(sp.pago);
    meses.push({
      mes: m,
      faturado: n(f.faturado), qtd_faturas: n(f.qtd), recebido_vencimento: n(f.recebido), a_receber: n(f.a_receber),
      vencido: n(f.vencido), a_vencer: n(f.a_vencer), descontos: n(f.descontos),
      clientes: n(f.clientes), inadimplentes: n(f.inadimplentes),
      entradas, saidas_pagas: saidas, resultado_caixa: entradas - saidas,
      saidas_pendentes: n(pr.pendente), saidas_vencidas: n(pr.vencido),
    });
  }
  let acc = 0;
  for (const m of meses) {
    // Acumulado só até o mês corrente (meses futuros não têm caixa realizado).
    if (ano < anoAtual || (ano === anoAtual && m.mes <= Number(hoje.slice(5, 7)))) { acc += m.resultado_caixa; m.caixa_acumulado = acc; } else m.caixa_acumulado = null;
  }

  const soma = (k) => meses.reduce((s, m) => s + n(m[k]), 0);
  const totais = {
    faturado: soma('faturado'), qtd_faturas: soma('qtd_faturas'), recebido_vencimento: soma('recebido_vencimento'),
    a_receber: soma('a_receber'), vencido: soma('vencido'), a_vencer: soma('a_vencer'), descontos: soma('descontos'),
    entradas: soma('entradas'), saidas_pagas: soma('saidas_pagas'), resultado_caixa: soma('resultado_caixa'),
    saidas_pendentes: soma('saidas_pendentes'), saidas_vencidas: soma('saidas_vencidas'),
    clientes: n(anoClientes?.clientes), inadimplentes: n(anoClientes?.inadimplentes),
  };
  totais.ticket_medio = totais.clientes ? totais.faturado / totais.clientes : 0;
  totais.taxa_recebimento = totais.faturado ? totais.recebido_vencimento / totais.faturado : 0;
  totais.taxa_inadimplencia = totais.faturado ? totais.vencido / totais.faturado : 0;

  // Projeção do fechamento do mês corrente (só quando o ano é o atual).
  let projecao = null;
  if (ano === anoAtual) {
    const mAtual = Number(hoje.slice(5, 7));
    const cur = meses[mAtual - 1];
    const anteriores = meses.slice(0, mAtual - 1).filter((m) => m.faturado > 0).slice(-3);
    const taxa = anteriores.length ? anteriores.reduce((s, m) => s + m.recebido_vencimento / m.faturado, 0) / anteriores.length : null;
    const pagoMes = cur.recebido_vencimento;
    projecao = {
      mes: mAtual, faturado: cur.faturado, recebido_ate_hoje: pagoMes, a_vencer: cur.a_vencer, vencido: cur.vencido,
      taxa_historica: taxa,
      fechamento_estimado: taxa == null ? null : Math.max(pagoMes, cur.faturado * taxa),
      fechamento_maximo: pagoMes + cur.a_vencer,
      meses_base: anteriores.map((m) => m.mes),
    };
  }

  const cobertura = {
    faturas: cobFat.map((r) => Number(r.mes.slice(5, 7))).sort((x, y) => x - y),
    contas_pagar: cobCp.map((r) => Number(r.mes.slice(5, 7))).sort((x, y) => x - y),
  };

  return {
    ano, hoje, meses, totais, projecao, cobertura, tem_dados: n(totFat?.qtd) > 0,
    por_banco: banco.map(numeros), por_forma: forma.map(numeros), por_tipo_pessoa: tipoPessoa.map(numeros),
    por_empresa: empresas.map(numeros), despesas_categoria: categorias.map(numeros),
    origem: ORIGEM,
  };
}

router.get('/painel', async (req, res) => {
  try {
    res.json(await montarPainel(req));
  } catch (e) {
    console.error('Erro /analise-financeira/painel:', e.message);
    res.status(500).json({ erro: 'Erro ao montar o painel financeiro.' });
  }
});

// Excel só com números agregados (sem cliente) para conferência e fechamento mensal.
router.get('/exportar', async (req, res) => {
  try {
    const p = await montarPainel(req);
    const NOMES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(p.meses.map((m) => ({
      'Mês': `${NOMES[m.mes - 1]}/${p.ano}`, 'Faturado (vencimento)': m.faturado, 'Faturas': m.qtd_faturas,
      'Recebido das faturas do mês': m.recebido_vencimento, 'Em aberto': m.a_receber, 'Vencido': m.vencido, 'A vencer': m.a_vencer,
      'Descontos': m.descontos, 'Clientes faturados': m.clientes, 'Clientes inadimplentes': m.inadimplentes,
      'Entradas (caixa)': m.entradas, 'Saídas pagas': m.saidas_pagas, 'Resultado de caixa': m.resultado_caixa,
      'Saídas pendentes': m.saidas_pendentes, 'Saídas vencidas': m.saidas_vencidas,
    }))), 'Meses');
    const aba = (nome, linhas) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas.map((l) => ({
      'Item': l.chave, 'Faturas': l.qtd, 'Faturado': l.faturado, 'Recebido': l.recebido, 'Em aberto': l.a_receber, 'Vencido': l.vencido, 'Descontos': l.descontos,
    }))), nome);
    aba('Bancos', p.por_banco); aba('Formas de pagamento', p.por_forma); aba('PF e PJ', p.por_tipo_pessoa);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(p.despesas_categoria.map((l) => ({ 'Categoria': l.chave, 'Valor': l.valor, 'Pendente': l.pendente }))), 'Despesas');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Ano', p.ano], ['Gerado em', new Date(Date.now() - 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)], ['Fonte', ORIGEM.fonte], [],
      ['Faturamento', ORIGEM.faturamento], ['Movimentação', ORIGEM.movimentacao], ['Previsão', ORIGEM.previsao], ['Projeção', ORIGEM.projecao], ['Limites', ORIGEM.limites],
    ]), 'Origem');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="analise_financeira_${p.ano}.xlsx"`);
    res.send(buf);
  } catch (e) {
    console.error('Erro /analise-financeira/exportar:', e.message);
    res.status(500).json({ erro: 'Erro ao gerar o Excel.' });
  }
});

router.get('/opcoes', async (req, res) => {
  try {
    const empresas = await all(`SELECT DISTINCT empresa_doc AS doc, empresa_nome AS nome FROM fin_fatura WHERE empresa_id=? AND empresa_doc IS NOT NULL ORDER BY 2`, [req.usuario.empresa_id]);
    res.json({ empresas });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao carregar opções.' });
  }
});

// ── Estado da sincronização e agendamento (sempre na madrugada) ─────────────
router.get('/sincronizacao', async (req, res) => {
  try {
    const e = req.usuario.empresa_id;
    const [status, f, c] = await Promise.all([
      statusSincronizacao(e),
      get(`SELECT COUNT(*) AS qtd, MAX(sync_em) AS ultima FROM fin_fatura WHERE empresa_id=? AND ativo=1`, [e]),
      get(`SELECT COUNT(*) AS qtd, MAX(sync_em) AS ultima FROM fin_conta_pagar WHERE empresa_id=? AND ativo=1`, [e]),
    ]);
    res.json({ status, faturas: { qtd: n(f.qtd), ultima: f.ultima }, contas_pagar: { qtd: n(c.qtd), ultima: c.ultima } });
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
        return res.status(403).json({ erro: 'Sem permissão para agendar a sincronização.' });
      }
    }
    const { tipo, data_inicio, data_fim } = req.body || {};
    const r = await agendarSincronizacao(req.usuario.empresa_id, tipo, data_inicio, data_fim);
    if (r.erro) return res.status(400).json(r);
    res.json({ ok: true, mensagem: 'Agendado: o HubSoft só é consultado de madrugada, no horário da rotina financeira.' });
  } catch (e) {
    console.error('Erro /analise-financeira/sincronizar:', e.message);
    res.status(500).json({ erro: 'Erro ao agendar a sincronização.' });
  }
});

router.montarPainel = montarPainel; // exposto para teste direto das consultas
module.exports = router;
