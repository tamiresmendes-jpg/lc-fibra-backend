// Meta de Cobrança: efetividade e bônus de quem trabalha remoção/recebimento.
//
// Regra (confirmada com a usuária em 07/08/2026):
// - Conta-se TODA O.S. fechada pelo colaborador no mês (qualquer tipo) como o
//   total de atendimentos dele — é o denominador da efetividade.
// - É "bem-sucedida" quando o MOTIVO DE FECHAMENTO da O.S. é:
//     "REMOVIDO"            → remoção de equipamento (bônus R$ 5,00 fixo cada)
//     "PAGAMENTO REALIZADO" → cliente pagou (bônus 5% do valor recebido)
// - Efetividade = bem-sucedidas / total das O.S. do colaborador. Meta: 20%.
// - O valor do "PAGAMENTO REALIZADO" vem da observação da cobrança mais recente
//   do serviço do cliente, no formato "Cobrança recebida pelo cobrador <NOME>
//   no valor de R$ <VALOR>" — confirmado em teste real em 07/08/2026 (endpoint
//   /api/v1/cliente/financeiro/cobranca/{id_cobranca}, campo `observacao`).
//   Se a observação não existir ou não bater no formato, o valor fica "a confirmar".
const { listarOrdensServico, buscarObservacaoRecebimento } = require('../services/hubsoft');

const REGEX_RECEBIMENTO = /cobran[çc]a recebida pelo cobrador\s+(.+?)\s+no valor de\s+r\$\s*([\d.,]+)/i;

function paraNumeroBR(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Tenta achar a observação de recebimento numa fatura/baixa. Aceita qualquer
// formato de objeto que tenha um campo de texto (observacao, obs, nota, historico...).
// PENDENTE de validar contra dado real — ver comentário no topo do arquivo.
function extrairRecebimento(observacaoTexto) {
  const m = REGEX_RECEBIMENTO.exec(observacaoTexto || '');
  if (!m) return null;
  return { cobrador: m[1].trim(), valor: paraNumeroBR(m[2]) };
}

// Roda `tarefa` sobre os itens com concorrência limitada (não sobrecarrega o ERP).
async function comConcorrenciaLimitada(itens, limite, tarefa) {
  const fila = [...itens];
  const trabalhador = async () => {
    let item;
    while ((item = fila.shift()) !== undefined) await tarefa(item);
  };
  await Promise.all(Array.from({ length: limite }, trabalhador));
}

// Monta a Meta de Cobrança de um mês: uma linha por colaborador (quem fechou
// as O.S.), com total, remoções, pagamentos, efetividade e bônus.
async function montarMetaCobranca({ dataInicio, dataFim, metaEfetividade = 20 }) {
  // tipo_data=data_termino_executado: o que importa aqui é quando a O.S. foi
  // FECHADA (e por qual motivo), não a data em que foi agendada.
  const ordens = await listarOrdensServico({ dataInicio, dataFim, maxPaginas: 80, tipoData: 'data_termino_executado' });

  const porColaborador = new Map();
  const osComPagamento = []; // { colaboradorId, idClienteServico }
  for (const o of ordens) {
    const fechou = o.usuario_fechamento;
    if (!fechou?.id) continue; // O.S. ainda aberta, sem responsável definido
    const motivo = (Array.isArray(o.motivo_fechamento) ? o.motivo_fechamento[0] : o.motivo_fechamento)?.descricao || '';

    const atual = porColaborador.get(fechou.id) || {
      id: fechou.id, nome: fechou.name, total_os: 0, os_removido: 0, os_pagamento: 0,
      valor_recebido: 0, valor_recebido_confirmado: false, os: [],
    };
    atual.total_os += 1;
    if (/^removido$/i.test(motivo)) atual.os_removido += 1;
    if (/^pagamento realizado$/i.test(motivo)) {
      atual.os_pagamento += 1;
      const idClienteServico = o.dados_servico?.id_cliente_servico;
      if (idClienteServico) osComPagamento.push({ colaboradorId: fechou.id, idClienteServico });
    }
    porColaborador.set(fechou.id, atual);
  }

  // Busca a observação da cobrança mais recente de cada serviço com pagamento
  // realizado (uma chamada por id_cliente_servico único, concorrência baixa).
  const idsUnicos = [...new Set(osComPagamento.map(x => x.idClienteServico))];
  const observacaoPorServico = new Map();
  await comConcorrenciaLimitada(idsUnicos, 4, async (idServico) => {
    const obs = await buscarObservacaoRecebimento(idServico).catch(() => null);
    observacaoPorServico.set(idServico, obs);
  });
  for (const { colaboradorId, idClienteServico } of osComPagamento) {
    const recebimento = extrairRecebimento(observacaoPorServico.get(idClienteServico));
    if (!recebimento?.valor) continue; // sem observação no formato esperado: fica "a confirmar"
    const atual = porColaborador.get(colaboradorId);
    atual.valor_recebido += recebimento.valor;
    atual.valor_recebido_confirmado = true;
  }

  const itens = [...porColaborador.values()].map(c => {
    const bemSucedidas = c.os_removido + c.os_pagamento;
    const efetividade = c.total_os > 0 ? Math.round((bemSucedidas / c.total_os) * 1000) / 10 : 0;
    const bonusRemocao = c.os_removido * 5;
    const bateuMeta = efetividade >= metaEfetividade;
    return {
      id: c.id, nome: c.nome,
      total_os: c.total_os, os_removido: c.os_removido, os_pagamento: c.os_pagamento,
      bem_sucedidas: bemSucedidas, efetividade, bate_meta: bateuMeta,
      valor_recebido: Math.round(c.valor_recebido * 100) / 100,
      valor_recebido_pendente: c.os_pagamento > 0 && !c.valor_recebido_confirmado, // tem pagamento mas nenhuma observação achada nesse formato
      bonus_remocao: bonusRemocao,
      bonus_recebimento: Math.round(c.valor_recebido * 0.05 * 100) / 100,
      bonus_total: Math.round((bonusRemocao + c.valor_recebido * 0.05) * 100) / 100,
    };
  }).sort((a, b) => b.bonus_total - a.bonus_total);

  return {
    meta_efetividade: metaEfetividade,
    itens,
    resumo: {
      colaboradores: itens.length,
      total_os: itens.reduce((s, i) => s + i.total_os, 0),
      total_removidas: itens.reduce((s, i) => s + i.os_removido, 0),
      total_pagamentos: itens.reduce((s, i) => s + i.os_pagamento, 0),
      bonus_total: itens.reduce((s, i) => s + i.bonus_total, 0),
      valor_pendente_confirmar: itens.some(i => i.valor_recebido_pendente),
    },
  };
}

module.exports = { montarMetaCobranca, extrairRecebimento };
