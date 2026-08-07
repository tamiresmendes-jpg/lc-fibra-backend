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
// - O BÔNUS só vale para quem de fato é cobrador (confirmado 07/08/2026): os
//   demais nomes que aparecem fechando O.S. de remoção são TÉCNICOS de campo,
//   não recebem bônus de cobrança — mas entram na Análise (todo mundo que
//   participa da remoção/recebimento), só não na tabela de bônus.
const { listarOrdensServico, buscarObservacoesRecebimento } = require('../services/hubsoft');

const REGEX_RECEBIMENTO = /cobran[çc]a recebida pelo cobrador\s+(.+?)\s+no valor de\s+r\$\s*([\d.,]+)/i;

// Únicos dois cobradores reais. Comparação por "começa com" o nome curto que o
// HubSoft devolve no usuario_fechamento (ex.: "Ronald Rego"), tolerando o nome
// completo também (ex.: "Ronald Rego De Sousa").
const COBRADORES = ['jhonaldo', 'ronald rego'];
function ehCobrador(nome) {
  const n = (nome || '').trim().toLowerCase();
  return COBRADORES.some(c => n.startsWith(c));
}

function paraNumeroBR(s) {
  if (!s) return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Tenta achar a observação de recebimento numa fatura/baixa.
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

// Base comum: busca as O.S. do período e agrupa por quem fechou, com a
// observação de recebimento já resolvida. Usada tanto pela Meta (só os 2
// cobradores, com bônus) quanto pela Análise (todo mundo, sem bônus).
async function calcularBase({ dataInicio, dataFim }) {
  // tipo_data=data_termino_executado: o que importa aqui é quando a O.S. foi
  // FECHADA (e por qual motivo), não a data em que foi agendada.
  const ordens = await listarOrdensServico({ dataInicio, dataFim, maxPaginas: 80, tipoData: 'data_termino_executado' });

  const porColaborador = new Map();
  const motivos = new Map(); // descrição do motivo -> contagem (todas as O.S., qualquer motivo)
  const osComPagamento = []; // { colaboradorId, idClienteServico }
  for (const o of ordens) {
    const fechou = o.usuario_fechamento;
    if (!fechou?.id) continue; // O.S. ainda aberta, sem responsável definido
    const motivo = (Array.isArray(o.motivo_fechamento) ? o.motivo_fechamento[0] : o.motivo_fechamento)?.descricao || 'Sem motivo';
    motivos.set(motivo, (motivos.get(motivo) || 0) + 1);

    const atual = porColaborador.get(fechou.id) || {
      id: fechou.id, nome: fechou.name, total_os: 0, os_removido: 0, os_pagamento: 0,
      valor_recebido: 0, valor_recebido_confirmado: false,
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

  // Busca as observações de TODAS as cobranças pagas no período pra cada
  // serviço com pagamento realizado (uma chamada por id_cliente_servico único,
  // concorrência baixa) — um cliente pode ter mais de uma cobrança baixada no
  // mesmo dia, cada uma com seu valor.
  const idsUnicos = [...new Set(osComPagamento.map(x => x.idClienteServico))];
  const observacoesPorServico = new Map();
  await comConcorrenciaLimitada(idsUnicos, 4, async (idServico) => {
    const obs = await buscarObservacoesRecebimento(idServico, { dataInicio, dataFim }).catch(() => []);
    observacoesPorServico.set(idServico, obs);
  });
  for (const { colaboradorId, idClienteServico } of osComPagamento) {
    const observacoes = observacoesPorServico.get(idClienteServico) || [];
    const recebimentos = observacoes.map(extrairRecebimento).filter(r => r?.valor);
    if (!recebimentos.length) continue; // sem observação no formato esperado: fica "a confirmar"
    const atual = porColaborador.get(colaboradorId);
    atual.valor_recebido += recebimentos.reduce((s, r) => s + r.valor, 0);
    atual.valor_recebido_confirmado = true;
  }

  return { porColaborador, motivos, totalOs: ordens.length };
}

// Monta a Meta de Cobrança de um mês: só Jhonaldo e Ronald Rego (únicos
// cobradores reais), com total, remoções, pagamentos, efetividade e bônus.
async function montarMetaCobranca({ dataInicio, dataFim, metaEfetividade = 20 }) {
  const { porColaborador } = await calcularBase({ dataInicio, dataFim });

  const itens = [...porColaborador.values()]
    .filter(c => ehCobrador(c.nome))
    .map(c => {
      const bemSucedidas = c.os_removido + c.os_pagamento;
      const efetividade = c.total_os > 0 ? Math.round((bemSucedidas / c.total_os) * 1000) / 10 : 0;
      const bonusRemocao = c.os_removido * 5;
      const bateuMeta = efetividade >= metaEfetividade;
      return {
        id: c.id, nome: c.nome,
        total_os: c.total_os, os_removido: c.os_removido, os_pagamento: c.os_pagamento,
        bem_sucedidas: bemSucedidas, efetividade, bate_meta: bateuMeta,
        valor_recebido: Math.round(c.valor_recebido * 100) / 100,
        valor_recebido_pendente: c.os_pagamento > 0 && !c.valor_recebido_confirmado,
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

// Análise da Cobrança: visão ampla do período, com TODOS os técnicos/cobradores
// que fecharam O.S. de remoção ou pagamento (sem bônus — isso é só do painel de
// Meta), o motivo de fechamento de toda O.S. do período, e o total recebido.
async function montarAnaliseCobranca({ dataInicio, dataFim }) {
  const { porColaborador, motivos, totalOs } = await calcularBase({ dataInicio, dataFim });

  const porPessoa = [...porColaborador.values()]
    .filter(c => c.os_removido > 0 || c.os_pagamento > 0) // só quem participou de remoção/recebimento
    .map(c => ({
      id: c.id, nome: c.nome, cobrador: ehCobrador(c.nome),
      total_os: c.total_os, os_removido: c.os_removido, os_pagamento: c.os_pagamento,
      valor_recebido: Math.round(c.valor_recebido * 100) / 100,
      valor_recebido_pendente: c.os_pagamento > 0 && !c.valor_recebido_confirmado,
    }))
    .sort((a, b) => (b.os_removido + b.os_pagamento) - (a.os_removido + a.os_pagamento));

  const motivosOrdenados = [...motivos.entries()]
    .map(([motivo, total]) => ({ motivo, total }))
    .sort((a, b) => b.total - a.total);

  return {
    resumo: {
      total_os: totalOs,
      total_removidas: porPessoa.reduce((s, p) => s + p.os_removido, 0),
      total_pagamentos: porPessoa.reduce((s, p) => s + p.os_pagamento, 0),
      valor_recebido_total: Math.round(porPessoa.reduce((s, p) => s + p.valor_recebido, 0) * 100) / 100,
      pessoas_envolvidas: porPessoa.length,
      valor_pendente_confirmar: porPessoa.some(p => p.valor_recebido_pendente),
    },
    motivos: motivosOrdenados,
    por_pessoa: porPessoa,
  };
}

module.exports = { montarMetaCobranca, montarAnaliseCobranca, extrairRecebimento };
