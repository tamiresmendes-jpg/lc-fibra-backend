// Análise de O.S.: tempo médio de atendimento por tipo, SLA, produtividade
// por técnico/equipe/cidade/bairro, motivo de fechamento, horário de pico,
// pontualidade, estouro do prazo agendado, quem fecha a O.S., tipo de
// atendimento, custo de material e status do serviço do cliente.
//
// Regras confirmadas com a usuária em 27/08/2026:
// - Eixo temporal: O.S. filtradas pela data de ABERTURA (data_cadastro) no período.
// - SLA = tempo entre a abertura (data_cadastro) e o horário AGENDADO
//   (data_inicio_programado) — "quanto tempo eu levo para atender o cliente"
//   (agendar a visita). Sem meta/prazo configurado, é só o tempo medido.
// - Tempo de atendimento = tempo REAL do técnico em campo: data_inicio_executado
//   até data_termino_executado.
// - "Concluída" = tem data_termino_executado preenchida.
//
// Ampliado em 01/09/2026:
// - Pontualidade = atraso entre o horário AGENDADO (data_inicio_programado) e o
//   horário que o técnico realmente começou (data_inicio_executado). Negativo
//   = chegou adiantado.
// - Estouro do prazo = tempo real de atendimento MENOS a janela que tinha sido
//   agendada (data_termino_programado - data_inicio_programado). Positivo =
//   passou do tempo previsto.
// - Custo de material por tipo de O.S. = cruza com os movimentos de estoque
//   (saída pro cliente) do mesmo período, igual à Análise de Produto.
//
// Separado em duas etapas: buscarDadosOS (busca crua no HubSoft — O.S. +
// movimentos de estoque —, cara e cacheável) e agregarAnaliseOS (cálculo em
// cima do que já foi buscado, barato e roda de novo a cada filtro de
// cidade/tipo sem bater no ERP outra vez).
const { listarOrdensServico, listarMovimentosEstoque } = require('../services/hubsoft');

function paraDataHora(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}
// Diferença em minutos entre duas datas/horas do HubSoft. Descarta pares com
// fim antes do início (dado inconsistente) em vez de afirmar um número errado.
function diffMinutos(inicioStr, fimStr) {
  const a = paraDataHora(inicioStr), b = paraDataHora(fimStr);
  if (!a || !b) return null;
  const min = (b - a) / 60000;
  return min >= 0 ? min : null;
}
// Mesma diferença, mas SEM descartar negativo — usada em pontualidade/estouro,
// onde "adiantado"/"dentro do previsto" é informação válida, não erro de dado.
function diffMinutosComSinal(inicioStr, fimStr) {
  const a = paraDataHora(inicioStr), b = paraDataHora(fimStr);
  if (!a || !b) return null;
  return (b - a) / 60000;
}
function media(nums) {
  const v = nums.filter(n => n != null);
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
}
function horas(min) { return min == null ? null : Math.round((min / 60) * 10) / 10; }
function inteiro(min) { return min == null ? null : Math.round(min); }
function ordenarPtBr(arr) { return [...arr].sort((a, b) => a.localeCompare(b, 'pt-BR')); }

function extrairEquipe(o) {
  return o.agenda_ordem_servico && !Array.isArray(o.agenda_ordem_servico)
    ? o.agenda_ordem_servico.descricao
    : (Array.isArray(o.agenda_ordem_servico) && o.agenda_ordem_servico[0]?.descricao) || null;
}
function extrairTecnicos(o) {
  return Array.isArray(o.tecnicos) ? o.tecnicos.map(t => t.name || t.display).filter(Boolean) : [];
}
function extrairTipo(o) { return o.tipo_ordem_servico?.descricao || 'Sem tipo'; }
function extrairCidade(o) { return o.dados_endereco_instalacao?.cidade || 'Sem cidade'; }
function extrairBairro(o) { return o.dados_endereco_instalacao?.bairro || 'Sem bairro'; }
function extrairMotivo(o) {
  const m = Array.isArray(o.motivo_fechamento) ? o.motivo_fechamento[0] : o.motivo_fechamento;
  return m?.descricao || null;
}
function extrairResponsavelFechamento(o) { return o.usuario_fechamento?.name || null; }
function extrairTipoAtendimento(o) { return o.atendimento?.tipo_atendimento || null; }
function extrairServicoStatus(o) { return o.dados_servico?.servico_status || null; }

// Faixas de SLA pra distribuição visual (sem meta configurada — só mostra onde
// o tempo até o agendamento se concentra).
const FAIXAS_SLA = [
  { rotulo: 'Até 4h', max: 4 * 60 },
  { rotulo: '4h a 24h', max: 24 * 60 },
  { rotulo: '1 a 2 dias', max: 48 * 60 },
  { rotulo: 'Mais de 2 dias', max: Infinity },
];
function faixaDe(minutos) {
  return FAIXAS_SLA.find(f => minutos <= f.max).rotulo;
}
const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Faixas de pontualidade (chegada real x horário agendado).
const FAIXAS_PONTUALIDADE = [
  { rotulo: 'Adiantado', testar: (m) => m < -15 },
  { rotulo: 'No horário (±15min)', testar: (m) => m >= -15 && m <= 15 },
  { rotulo: 'Até 1h atrasado', testar: (m) => m > 15 && m <= 60 },
  { rotulo: '1h a 4h atrasado', testar: (m) => m > 60 && m <= 240 },
  { rotulo: 'Mais de 4h atrasado', testar: (m) => m > 240 },
];
function faixaPontualidadeDe(minutos) {
  return FAIXAS_PONTUALIDADE.find(f => f.testar(minutos))?.rotulo || FAIXAS_PONTUALIDADE[1].rotulo;
}
const REGEX_SERVICO_INCOMUM = /suspen|cancelad/i;

// Busca crua no HubSoft — O.S. do período + movimentos de estoque (saída pro
// cliente, pra custo de material). É a parte cara (várias páginas), por isso
// é a única coisa que o job em segundo plano (syncAnaliseOS) guarda em cache.
async function buscarDadosOS({ dataInicio, dataFim }) {
  const [ordens, movimentos] = await Promise.all([
    listarOrdensServico({ dataInicio, dataFim, maxPaginas: 80, tipoData: 'data_cadastro' }),
    listarMovimentosEstoque({ dataInicio, dataFim, tipoVinculoDestino: 'servico_cliente', maxPaginas: 150 }).catch(() => []),
  ]);
  return { ordens, movimentos };
}

// Agrega os dados já buscados. cidade/tipo são filtros opcionais (comparação
// exata com o texto que vem do HubSoft) — quando informados, só entram na
// conta as O.S. daquela cidade/tipo, mas as opções do filtro (`opcoes`)
// sempre vêm da lista COMPLETA, senão o seletor encolheria a cada escolha.
function agregarAnaliseOS(todasOrdens, movimentos, { cidade, tipo } = {}) {
  const opcoesCidades = new Set();
  const opcoesTipos = new Set();
  for (const o of todasOrdens) {
    opcoesCidades.add(extrairCidade(o));
    opcoesTipos.add(extrairTipo(o));
  }

  const ordens = todasOrdens.filter(o => {
    if (cidade && extrairCidade(o) !== cidade) return false;
    if (tipo && extrairTipo(o) !== tipo) return false;
    return true;
  });

  // Custo de material por O.S. — soma o valor das saídas de estoque ligadas a
  // cada id_ordem_servico (mesma lógica da Análise de Produto).
  const custoPorOS = new Map();
  for (const m of (movimentos || [])) {
    if (!m.id_ordem_servico) continue;
    let total = custoPorOS.get(m.id_ordem_servico) || 0;
    for (const p of (m.produtos || [])) total += Number(p.valor) || 0;
    custoPorOS.set(m.id_ordem_servico, total);
  }

  const porTipo = new Map();
  const porTecnico = new Map();
  const porEquipe = new Map();
  const porCidade = new Map();
  const porBairro = new Map();
  const motivos = new Map();
  const porFechamento = new Map();
  const porTipoAtendimento = new Map();
  const porServicoStatus = new Map();
  const slaPorFaixa = new Map(FAIXAS_SLA.map(f => [f.rotulo, 0]));
  const pontualidadePorFaixa = new Map(FAIXAS_PONTUALIDADE.map(f => [f.rotulo, 0]));
  const porDiaSemana = DIAS_SEMANA.map(dia => ({ dia, total: 0 }));
  const porHora = Array.from({ length: 24 }, (_, hora) => ({ hora, total: 0 }));
  const equipesVistas = new Set();
  const tecnicosVistos = new Set();

  const slaGeral = [];
  const tempoAtendimentoGeral = [];
  const atrasoGeral = [];
  const estouroGeral = [];
  let concluidas = 0;
  let comEstouroInfo = 0;
  let estourou = 0;
  let osServicoIncomum = 0;

  for (const o of ordens) {
    const tipoOS = extrairTipo(o);
    const cidadeOS = extrairCidade(o);
    const bairro = extrairBairro(o);
    const equipe = extrairEquipe(o);
    const tecnicos = extrairTecnicos(o);
    const concluida = !!o.data_termino_executado;
    if (concluida) concluidas++;
    if (equipe) equipesVistas.add(equipe);
    tecnicos.forEach(t => tecnicosVistos.add(t));

    const sla = diffMinutos(o.data_cadastro, o.data_inicio_programado);
    const tempoAtendimento = diffMinutos(o.data_inicio_executado, o.data_termino_executado);
    if (sla != null) { slaGeral.push(sla); const f = faixaDe(sla); slaPorFaixa.set(f, (slaPorFaixa.get(f) || 0) + 1); }
    if (tempoAtendimento != null) tempoAtendimentoGeral.push(tempoAtendimento);

    // Pontualidade: agendado x início real da execução.
    const atraso = diffMinutosComSinal(o.data_inicio_programado, o.data_inicio_executado);
    if (atraso != null) {
      atrasoGeral.push(atraso);
      const f = faixaPontualidadeDe(atraso);
      pontualidadePorFaixa.set(f, (pontualidadePorFaixa.get(f) || 0) + 1);
    }

    // Estouro do prazo: tempo real de atendimento MENOS a janela agendada.
    const janelaAgendada = diffMinutosComSinal(o.data_inicio_programado, o.data_termino_programado);
    if (tempoAtendimento != null && janelaAgendada != null && janelaAgendada > 0) {
      comEstouroInfo++;
      const estouro = tempoAtendimento - janelaAgendada;
      estouroGeral.push(estouro);
      if (estouro > 0) estourou++;
    }

    // Horário de pico — pela data AGENDADA (é o que dita a escala das equipes).
    const dProg = paraDataHora(o.data_inicio_programado);
    if (dProg) { porDiaSemana[dProg.getDay()].total++; porHora[dProg.getHours()].total++; }

    // Motivo de fechamento (só existe em O.S. já encerrada)
    const motivo = extrairMotivo(o);
    if (motivo) motivos.set(motivo, (motivos.get(motivo) || 0) + 1);

    // Quem fechou a O.S. — separado de quem executou (pode ser central/escritório)
    const responsavelFechamento = extrairResponsavelFechamento(o);
    if (responsavelFechamento) porFechamento.set(responsavelFechamento, (porFechamento.get(responsavelFechamento) || 0) + 1);

    // Tipo de atendimento (telefone, presencial...)
    const tipoAtendimento = extrairTipoAtendimento(o);
    if (tipoAtendimento) porTipoAtendimento.set(tipoAtendimento, (porTipoAtendimento.get(tipoAtendimento) || 0) + 1);

    // Status do serviço do cliente
    const servicoStatus = extrairServicoStatus(o);
    if (servicoStatus) {
      porServicoStatus.set(servicoStatus, (porServicoStatus.get(servicoStatus) || 0) + 1);
      if (REGEX_SERVICO_INCOMUM.test(servicoStatus)) osServicoIncomum++;
    }

    // Custo de material desta O.S. (0 quando não há movimento ligado a ela)
    const custoMaterial = custoPorOS.get(o.id_ordem_servico) || 0;

    // Por tipo de O.S. — tempo médio de atendimento + SLA médio + custo de material
    const t = porTipo.get(tipoOS) || { tipo: tipoOS, total: 0, concluidas: 0, slaMin: [], tempoMin: [], custoMaterialTotal: 0 };
    t.total++;
    if (concluida) t.concluidas++;
    if (sla != null) t.slaMin.push(sla);
    if (tempoAtendimento != null) t.tempoMin.push(tempoAtendimento);
    t.custoMaterialTotal += custoMaterial;
    porTipo.set(tipoOS, t);

    // Produtividade por cidade
    const c = porCidade.get(cidadeOS) || { cidade: cidadeOS, total: 0, concluidas: 0, slaMin: [], tempoMin: [] };
    c.total++;
    if (concluida) c.concluidas++;
    if (sla != null) c.slaMin.push(sla);
    if (tempoAtendimento != null) c.tempoMin.push(tempoAtendimento);
    porCidade.set(cidadeOS, c);

    // Produtividade por bairro
    const b = porBairro.get(bairro) || { bairro, total: 0, concluidas: 0 };
    b.total++;
    if (concluida) b.concluidas++;
    porBairro.set(bairro, b);

    // Produtividade por equipe
    if (equipe) {
      const e = porEquipe.get(equipe) || { equipe, total: 0, concluidas: 0, slaMin: [], tempoMin: [] };
      e.total++;
      if (concluida) e.concluidas++;
      if (sla != null) e.slaMin.push(sla);
      if (tempoAtendimento != null) e.tempoMin.push(tempoAtendimento);
      porEquipe.set(equipe, e);
    }

    // Produtividade por técnico (uma O.S. com 2 técnicos conta pros dois)
    for (const nome of tecnicos) {
      const tc = porTecnico.get(nome) || { tecnico: nome, total: 0, concluidas: 0, tempoMin: [] };
      tc.total++;
      if (concluida) tc.concluidas++;
      if (tempoAtendimento != null) tc.tempoMin.push(tempoAtendimento);
      porTecnico.set(nome, tc);
    }
  }

  const tiposOrdenados = [...porTipo.values()]
    .map(t => ({
      tipo: t.tipo, total: t.total, concluidas: t.concluidas,
      sla_medio_horas: horas(media(t.slaMin)), tempo_atendimento_medio_horas: horas(media(t.tempoMin)),
      custo_material_total: Math.round(t.custoMaterialTotal * 100) / 100,
      custo_material_medio: Math.round((t.custoMaterialTotal / t.total) * 100) / 100,
    }))
    .sort((a, b) => b.total - a.total);

  const cidadesOrdenadas = [...porCidade.values()]
    .map(c => ({
      cidade: c.cidade, total: c.total, concluidas: c.concluidas,
      sla_medio_horas: horas(media(c.slaMin)), tempo_atendimento_medio_horas: horas(media(c.tempoMin)),
    }))
    .sort((a, b) => b.total - a.total);

  const bairrosOrdenados = [...porBairro.values()]
    .map(b => ({ bairro: b.bairro, total: b.total, concluidas: b.concluidas }))
    .sort((a, b) => b.total - a.total);

  const equipesOrdenadas = [...porEquipe.values()]
    .map(e => ({
      equipe: e.equipe, total: e.total, concluidas: e.concluidas,
      sla_medio_horas: horas(media(e.slaMin)), tempo_atendimento_medio_horas: horas(media(e.tempoMin)),
    }))
    .sort((a, b) => b.total - a.total);

  const tecnicosOrdenados = [...porTecnico.values()]
    .map(t => ({ tecnico: t.tecnico, total: t.total, concluidas: t.concluidas, tempo_atendimento_medio_horas: horas(media(t.tempoMin)) }))
    .sort((a, b) => b.concluidas - a.concluidas);

  const motivosOrdenados = [...motivos.entries()]
    .map(([motivo, total]) => ({ motivo, total }))
    .sort((a, b) => b.total - a.total);

  const fechamentoOrdenado = [...porFechamento.entries()]
    .map(([responsavel, total]) => ({ responsavel, total }))
    .sort((a, b) => b.total - a.total);

  const tipoAtendimentoOrdenado = [...porTipoAtendimento.entries()]
    .map(([tipo_atendimento, total]) => ({ tipo_atendimento, total }))
    .sort((a, b) => b.total - a.total);

  const servicoStatusOrdenado = [...porServicoStatus.entries()]
    .map(([status, total]) => ({ status, total }))
    .sort((a, b) => b.total - a.total);

  const slaFaixas = FAIXAS_SLA.map(f => ({ faixa: f.rotulo, total: slaPorFaixa.get(f.rotulo) || 0 }));
  const pontualidadeFaixas = FAIXAS_PONTUALIDADE.map(f => ({ faixa: f.rotulo, total: pontualidadePorFaixa.get(f.rotulo) || 0 }));
  const custoMaterialTotalGeral = tiposOrdenados.reduce((s, t) => s + t.custo_material_total, 0);

  return {
    resumo: {
      total_os: ordens.length,
      os_concluidas: concluidas,
      total_tecnicos: tecnicosVistos.size,
      total_equipes: equipesVistas.size,
      total_cidades: cidadesOrdenadas.length,
      sla_medio_horas: horas(media(slaGeral)),
      tempo_atendimento_medio_horas: horas(media(tempoAtendimentoGeral)),
      atraso_medio_minutos: inteiro(media(atrasoGeral)),
      pct_estourou_prazo: comEstouroInfo ? Math.round((estourou / comEstouroInfo) * 1000) / 10 : null,
      custo_material_total: Math.round(custoMaterialTotalGeral * 100) / 100,
      os_servico_suspenso_cancelado: osServicoIncomum,
    },
    por_tipo: tiposOrdenados,
    por_cidade: cidadesOrdenadas,
    por_bairro: bairrosOrdenados,
    por_equipe: equipesOrdenadas,
    por_tecnico: tecnicosOrdenados,
    sla_faixas: slaFaixas,
    motivos_fechamento: motivosOrdenados,
    por_dia_semana: porDiaSemana,
    por_hora: porHora,
    pontualidade: { faixas: pontualidadeFaixas, atraso_medio_minutos: inteiro(media(atrasoGeral)) },
    estouro_prazo: {
      pct_estourou: comEstouroInfo ? Math.round((estourou / comEstouroInfo) * 1000) / 10 : null,
      estouro_medio_minutos: inteiro(media(estouroGeral)),
      total_com_info: comEstouroInfo,
    },
    por_fechamento: fechamentoOrdenado,
    por_tipo_atendimento: tipoAtendimentoOrdenado,
    por_servico_status: servicoStatusOrdenado,
    opcoes: { cidades: ordenarPtBr(opcoesCidades), tipos: ordenarPtBr(opcoesTipos) },
    filtros: { cidade: cidade || null, tipo: tipo || null },
  };
}

async function montarAnaliseOS({ dataInicio, dataFim, cidade, tipo }) {
  const { ordens, movimentos } = await buscarDadosOS({ dataInicio, dataFim });
  return agregarAnaliseOS(ordens, movimentos, { cidade, tipo });
}

module.exports = { montarAnaliseOS, buscarDadosOS, agregarAnaliseOS };
