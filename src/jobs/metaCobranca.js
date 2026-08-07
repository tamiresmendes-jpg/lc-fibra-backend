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
const { listarOrdensServico, buscarRecebimentos, listarMovimentosEstoque } = require('../services/hubsoft');
const { all } = require('../config/database');

// O HubSoft só devolve o nome curto de quem fechou a O.S. (ex.: "Ronald Rego",
// "Jhonaldo") — troca pelo nome completo do cadastro (usuarios), casando por
// SEQUÊNCIA de palavras (mesma ideia usada no Chatmix/nome completo do atendente).
// Só troca quando acha exatamente UM colaborador ativo — ambíguo mantém o nome
// original do HubSoft, nunca afirma o nome errado.
function semAcentoNome(s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
async function resolverNomesCompletos(itens, chaveNome = 'nome') {
  const busca = new Set(itens.map(i => i[chaveNome]).filter(Boolean));
  if (!busca.size) return itens;
  const usuarios = await all('SELECT nome FROM usuarios WHERE ativo=1').catch(() => []);
  const candidatos = usuarios.map(u => ({ nome: u.nome, tokens: semAcentoNome(u.nome).split(/\s+/).filter(Boolean) }));
  const mapa = new Map();
  for (const nomeCurto of busca) {
    const tokensBusca = semAcentoNome(nomeCurto).split(/\s+/).filter(Boolean);
    const achados = candidatos.filter(c => {
      for (let i = 0; i <= c.tokens.length - tokensBusca.length; i++) {
        if (tokensBusca.every((t, j) => c.tokens[i + j] === t)) return true;
      }
      return false;
    });
    mapa.set(nomeCurto, achados.length === 1 ? achados[0].nome : nomeCurto);
  }
  return itens.map(i => ({ ...i, [chaveNome]: mapa.get(i[chaveNome]) || i[chaveNome] }));
}

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
      if (idClienteServico) osComPagamento.push({ colaboradorId: fechou.id, idClienteServico, dataExecucaoOS: o.data_termino_executado || null, idOrdemServico: o.id_ordem_servico || null });
    }
    porColaborador.set(fechou.id, atual);
  }

  // Busca TODAS as cobranças pagas no período pra cada serviço com pagamento
  // realizado (uma chamada por id_cliente_servico único, concorrência baixa) —
  // um cliente pode ter mais de uma cobrança baixada no mesmo dia, cada uma
  // com seu valor, forma de pagamento, vendedor e quem deu a baixa.
  const idsUnicos = [...new Set(osComPagamento.map(x => x.idClienteServico))];
  const recebimentosPorServico = new Map();
  await comConcorrenciaLimitada(idsUnicos, 4, async (idServico) => {
    const r = await buscarRecebimentos(idServico, { dataInicio, dataFim }).catch(() => []);
    recebimentosPorServico.set(idServico, r);
  });

  const recebimentosDetalhados = []; // pra listar embaixo da Meta: código, valor, forma, vendedor, baixa
  for (const { colaboradorId, idClienteServico, dataExecucaoOS, idOrdemServico } of osComPagamento) {
    const brutos = recebimentosPorServico.get(idClienteServico) || [];
    for (const r of brutos) {
      // Preferência: usa o valor da observação quando existe (é o registro
      // manual do cobrador). Sem observação, usa o valor REAL da baixa
      // (r.valor_pago) — já sabemos quem fechou a O.S. de pagamento, então
      // não precisa de anotação manual pra confirmar que o cliente pagou: a
      // baixa já aconteceu de verdade no sistema (buscarRecebimentos só traz
      // cobranças com data_pagamento preenchida, ou seja, já pagas).
      const extraido = extrairRecebimento(r.observacao);
      const viaObservacao = !!extraido?.valor;
      const valor = viaObservacao ? extraido.valor : (Number(r.valor_pago) || 0);
      if (!valor) continue; // nem observação nem baixa real com valor: não afirma nada
      const atual = porColaborador.get(colaboradorId);
      atual.valor_recebido += valor;
      atual.valor_recebido_confirmado = true;
      recebimentosDetalhados.push({
        colaboradorId,
        id_fatura: r.id_fatura, id_cobranca: r.id_cobranca, descricao_cobranca: r.descricao_cobranca,
        codigo_cliente: r.codigo_cliente, nome_cliente: r.nome_cliente,
        valor_pago: valor, forma_pagamento: r.forma_pagamento,
        vendedor: r.vendedor, quem_deu_baixa: r.quem_deu_baixa, via_observacao: viaObservacao,
        data_pagamento: r.data_pagamento, data_baixa: r.data_baixa,
        data_execucao_os: dataExecucaoOS, id_ordem_servico: idOrdemServico,
      });
    }
  }

  return { porColaborador, motivos, totalOs: ordens.length, recebimentosDetalhados };
}

// Monta a Meta de Cobrança de um mês: só Jhonaldo e Ronald Rego (únicos
// cobradores reais), com total, remoções, pagamentos, efetividade e bônus.
async function montarMetaCobranca({ dataInicio, dataFim, metaEfetividade = 20 }) {
  const { porColaborador, recebimentosDetalhados } = await calcularBase({ dataInicio, dataFim });

  const colaboradores = await resolverNomesCompletos([...porColaborador.values()]);
  const itens = colaboradores
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

  const idsCobradores = new Set(itens.map(i => i.id));
  const nomeDoId = new Map(itens.map(i => [i.id, i.nome]));
  const cobrancas = recebimentosDetalhados
    .filter(r => idsCobradores.has(r.colaboradorId))
    .map(r => ({ cobrador: nomeDoId.get(r.colaboradorId), ...r, colaboradorId: undefined }));

  // Uma fatura pode ter várias cobranças compostas (ex.: internet + pacotes
  // avulsos) — agrupa pra mostrar a fatura como linha principal, com as
  // cobranças de dentro dela disponíveis pra expandir.
  const porFatura = new Map();
  for (const c of cobrancas) {
    const chave = c.id_fatura || `sem-fatura-${c.id_cobranca}`;
    const f = porFatura.get(chave) || {
      id_fatura: c.id_fatura, cobrador: c.cobrador,
      codigo_cliente: c.codigo_cliente, nome_cliente: c.nome_cliente,
      forma_pagamento: c.forma_pagamento, vendedor: c.vendedor, quem_deu_baixa: c.quem_deu_baixa,
      data_pagamento: c.data_pagamento, data_baixa: c.data_baixa, data_execucao_os: c.data_execucao_os,
      id_ordem_servico: c.id_ordem_servico,
      valor_total: 0, cobrancas: [],
    };
    f.valor_total += c.valor_pago;
    f.cobrancas.push({ id_cobranca: c.id_cobranca, descricao: c.descricao_cobranca, valor_pago: c.valor_pago });
    porFatura.set(chave, f);
  }
  const recebimentos = [...porFatura.values()]
    .map(f => ({ ...f, valor_total: Math.round(f.valor_total * 100) / 100 }))
    .sort((a, b) => (b.data_pagamento || '').localeCompare(a.data_pagamento || ''));

  return {
    meta_efetividade: metaEfetividade,
    itens,
    recebimentos,
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

// Análise da Cobrança: só O.S. cujo TIPO contém "Remoção" (ex.: REMOÇÃO/COBRANÇA,
// REMOÇÃO/CANCELAMENTO, REMOÇÃO/EQUIPAMENTO ABANDONADO...) — confirmado com a
// usuária em 08/08/2026 que a Análise não deve puxar TODOS os tipos de O.S.,
// só as de remoção. Traz quem fechou, motivo, cidade e os equipamentos que
// voltaram pro estoque nessas O.S. (a "remoção" de equipamento em si).
async function montarAnaliseCobranca({ dataInicio, dataFim }) {
  const todasOrdens = await listarOrdensServico({ dataInicio, dataFim, maxPaginas: 80, tipoData: 'data_termino_executado' });
  const ordens = todasOrdens.filter(o => /remo[çc][ãa]o/i.test(o.tipo_ordem_servico?.descricao || ''));

  const porPessoa = new Map();
  const motivos = new Map();
  const porCidade = new Map();
  const porTipo = new Map(); // tipo da O.S. (REMOÇÃO/COBRANÇA, REMOÇÃO/CANCELAMENTO...)
  const idsOS = new Set();
  for (const o of ordens) {
    const fechou = o.usuario_fechamento;
    if (!fechou?.id) continue;
    idsOS.add(o.id_ordem_servico);
    const motivo = (Array.isArray(o.motivo_fechamento) ? o.motivo_fechamento[0] : o.motivo_fechamento)?.descricao || 'Sem motivo';
    motivos.set(motivo, (motivos.get(motivo) || 0) + 1);
    const cidade = o.dados_endereco_instalacao?.cidade || 'Sem cidade';
    porCidade.set(cidade, (porCidade.get(cidade) || 0) + 1);
    const tipo = o.tipo_ordem_servico?.descricao || 'Sem tipo';
    const atualTipo = porTipo.get(tipo) || { total: 0, removido: 0, nao_removido: 0 };
    atualTipo.total += 1;
    if (/^removido$/i.test(motivo)) atualTipo.removido += 1; else atualTipo.nao_removido += 1;
    porTipo.set(tipo, atualTipo);

    const atual = porPessoa.get(fechou.id) || { id: fechou.id, nome: fechou.name, cobrador: ehCobrador(fechou.name), total_os: 0, concluidas: 0 };
    atual.total_os += 1;
    if (/^removido$/i.test(motivo)) atual.concluidas += 1;
    porPessoa.set(fechou.id, atual);
  }

  // Equipamentos removidos: movimento de estoque de SAÍDA do serviço do cliente
  // de volta pro estoque (tipo_vinculo_origem = servico_cliente), ligado a uma
  // dessas O.S. de remoção pelo id_ordem_servico.
  const movimentos = await listarMovimentosEstoque({ dataInicio, dataFim, tipoVinculoOrigem: 'servico_cliente', maxPaginas: 300 }).catch(() => []);
  const equipamentos = new Map(); // produto -> { quantidade, valor }
  for (const m of movimentos) {
    if (!idsOS.has(m.id_ordem_servico)) continue;
    for (const p of (m.produtos || [])) {
      // "valor" no movimento já é o valor da linha (confirmado: bate com o
      // valor_total do movimento quando é o único produto) — não multiplica
      // pela quantidade de novo, senão dobra o valor recuperado.
      const atual = equipamentos.get(p.produto) || { quantidade: 0, valor: 0 };
      atual.quantidade += Number(p.quantidade) || 0;
      atual.valor += Number(p.valor) || 0;
      equipamentos.set(p.produto, atual);
    }
  }

  const pessoas = (await resolverNomesCompletos([...porPessoa.values()])).sort((a, b) => b.total_os - a.total_os);
  const motivosOrdenados = [...motivos.entries()].map(([motivo, total]) => ({ motivo, total })).sort((a, b) => b.total - a.total);
  const cidadesOrdenadas = [...porCidade.entries()].map(([cidade, total]) => ({ cidade, total })).sort((a, b) => b.total - a.total);
  const tiposOrdenados = [...porTipo.entries()]
    .map(([tipo, v]) => ({ tipo, total: v.total, removido: v.removido, nao_removido: v.nao_removido }))
    .sort((a, b) => b.total - a.total);
  const equipamentosOrdenados = [...equipamentos.entries()]
    .map(([produto, v]) => ({ produto, quantidade: v.quantidade, valor: Math.round(v.valor * 100) / 100 }))
    .sort((a, b) => b.valor - a.valor);
  const valorRecuperado = Math.round(equipamentosOrdenados.reduce((s, e) => s + e.valor, 0) * 100) / 100;

  return {
    resumo: {
      total_os_remocao: ordens.length,
      pessoas_envolvidas: pessoas.length,
      cidades_envolvidas: cidadesOrdenadas.length,
      equipamentos_removidos: equipamentosOrdenados.reduce((s, e) => s + e.quantidade, 0),
      valor_recuperado: valorRecuperado,
    },
    motivos: motivosOrdenados,
    por_pessoa: pessoas,
    por_cidade: cidadesOrdenadas,
    por_tipo: tiposOrdenados,
    equipamentos: equipamentosOrdenados,
  };
}

module.exports = { montarMetaCobranca, montarAnaliseCobranca, extrairRecebimento };
