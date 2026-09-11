// Agendamentos: OS agendadas por cidade/bairro/rua/dia/semana/mês, com status
// operacional (aguardando atendimento / em execução / concluída / atrasada).
//
// Diferente de analiseOS.js: o eixo temporal aqui é a data AGENDADA
// (data_inicio_programado), não a data de abertura — por isso listarOrdensServico
// é chamado SEM tipo_data (o default da API do HubSoft já filtra por
// data_inicio_programado, ver comentário em services/hubsoft.js).
//
// Mesma separação em duas etapas de analiseOS.js: buscarAgendamentos (busca
// crua no HubSoft, cara e cacheável) e agregarAgendamentos (cálculo em cima
// do que já foi buscado, barato e roda de novo a cada filtro sem bater no ERP).
const { listarOrdensServico } = require('../services/hubsoft');

function paraDataHora(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}
function ordenarPtBr(arr) { return [...arr].sort((a, b) => a.localeCompare(b, 'pt-BR')); }

function extrairTipo(o) { return o.tipo_ordem_servico?.descricao || o.tipo || 'Sem tipo'; }
function extrairCidade(o) { return o.dados_endereco_instalacao?.cidade || 'Sem cidade'; }
function extrairBairro(o) { return o.dados_endereco_instalacao?.bairro || 'Sem bairro'; }
// Confirmado contra dado real em produção (27/08/2026): dentro de
// dados_endereco_instalacao o nome da rua vem no campo "endereco" (não "rua"
// nem "logradouro" — esses não existem no retorno do HubSoft).
function extrairRua(o) {
  const end = o.dados_endereco_instalacao || {};
  return end.endereco || null;
}
function extrairEquipe(o) {
  return o.agenda_ordem_servico && !Array.isArray(o.agenda_ordem_servico)
    ? o.agenda_ordem_servico.descricao
    : (Array.isArray(o.agenda_ordem_servico) && o.agenda_ordem_servico[0]?.descricao) || null;
}
function extrairTecnicos(o) {
  return Array.isArray(o.tecnicos) ? o.tecnicos.map(t => t.name || t.display).filter(Boolean) : [];
}
function extrairMotivo(o) {
  const m = Array.isArray(o.motivo_fechamento) ? o.motivo_fechamento[0] : o.motivo_fechamento;
  return m?.descricao || null;
}

const LABEL_STATUS = {
  aguardando: 'Aguardando atendimento',
  em_execucao: 'Em execução',
  concluida: 'Realizada',
  atrasada: 'Atrasada',
};

// Deriva o status operacional a partir das datas da OS. `agora` é passado como
// parâmetro (calculado uma única vez por chamada de agregarAgendamentos) pra
// não deixar OS na borda mudarem de status no meio de uma mesma agregação, e
// pra permitir teste determinístico com data fixa.
function statusOperacional(o, agora) {
  if (o.data_termino_executado) return 'concluida';
  if (o.data_inicio_executado) return 'em_execucao';

  const progFim = paraDataHora(o.data_termino_programado);
  const progInicio = paraDataHora(o.data_inicio_programado);
  // Atrasada = já passou da data/hora prevista (fim programado se existir —
  // a janela de atendimento tem fim —, senão início programado) sem execução
  // iniciada.
  // TODO: se a regra for sempre usar só o início programado, trocar para:
  // const limite = progInicio;
  const limite = progFim || progInicio;
  if (limite && limite < agora) return 'atrasada';

  return 'aguardando';
}

function chaveDia(d) {
  return d ? d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) : null;
}
function chaveMes(dia) { return dia ? dia.slice(0, 7) : null; }
// Semana ISO-8601 (YYYY-Www): a semana pertence ao ano da sua quinta-feira.
function chaveSemanaISO(d) {
  if (!d) return null;
  const alvo = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const diaSemana = alvo.getUTCDay() || 7; // domingo vira 7
  alvo.setUTCDate(alvo.getUTCDate() + 4 - diaSemana); // vai pra quinta da mesma semana
  const inicioAno = new Date(Date.UTC(alvo.getUTCFullYear(), 0, 1));
  const numSemana = Math.ceil((((alvo - inicioAno) / 86400000) + 1) / 7);
  return `${alvo.getUTCFullYear()}-W${String(numSemana).padStart(2, '0')}`;
}

// Mesmo mapeamento plano usado em GET /erp/agenda, com o status operacional
// derivado e o endereço completo adicionados. Coordenadas no mesmo campo que
// rotaTecnica.js já confirmou contra dado real (dados_endereco_instalacao.coordenadas,
// presente em ~99,5% das O.S.) — reaproveitado aqui pra dar mapa também em Agendamentos.
function paraPlano(o, agora) {
  const tecnicos = extrairTecnicos(o);
  const equipe = extrairEquipe(o);
  const tel = o.dados_cliente?.telefones || {};
  const end = o.dados_endereco_instalacao || {};
  const coord = end.coordenadas || {};
  const lat = typeof coord.latitude === 'number' ? coord.latitude : null;
  const lng = typeof coord.longitude === 'number' ? coord.longitude : null;
  return {
    id: o.id_ordem_servico,
    numero: o.numero,
    tipo: extrairTipo(o),
    cliente: o.dados_cliente?.nome_razaosocial || o.cliente,
    endereco: o.endereco_instalacao,
    cidade: extrairCidade(o),
    bairro: extrairBairro(o),
    rua: extrairRua(o) || 'Sem rua',
    numero_endereco: end.numero || null,
    complemento: end.complemento || null,
    referencia: end.referencia || null,
    cep: end.cep || null,
    lat, lng,
    tecnico: tecnicos.join(', ') || equipe || 'Sem técnico',
    equipe: equipe || null,
    programado_inicio: o.data_inicio_programado,
    programado_fim: o.data_termino_programado,
    status_operacional: statusOperacional(o, agora),
    telefone: tel.telefone_primario,
    motivo_fechamento: extrairMotivo(o),
    descricao_abertura: o.descricao_abertura || null,
    descricao_servico: o.descricao_servico || null,
    descricao_fechamento: o.descricao_fechamento || null,
  };
}

// Busca crua no HubSoft — é a parte cara (várias páginas), por isso é a única
// coisa que o job em segundo plano (syncAgendamentos) guarda em cache por mês.
// SEM tipo_data: o default da API já filtra por data_inicio_programado (agendamento).
async function buscarAgendamentos({ dataInicio, dataFim }) {
  return listarOrdensServico({ dataInicio, dataFim, maxPaginas: 80 });
}

// Agrega as O.S. já buscadas. cidade/bairro/rua/tecnico/equipe/tipo/status são
// filtros opcionais (comparação exata) — quando informados, só entram na conta
// as O.S. daquele filtro, mas as opções do filtro (`opcoes`) sempre vêm da
// lista COMPLETA, senão o seletor encolheria a cada escolha (mesmo padrão de
// agregarAnaliseOS).
function agregarAgendamentos(todasOrdens, { cidade, bairro, rua, tecnico, equipe, tipo, status } = {}) {
  const agora = new Date();

  const opcoesCidades = new Set();
  const opcoesBairros = new Set();
  const opcoesRuas = new Set();
  const opcoesTecnicos = new Set();
  const opcoesEquipes = new Set();
  const opcoesTipos = new Set();
  let semRua = 0;
  for (const o of todasOrdens) {
    opcoesCidades.add(extrairCidade(o));
    opcoesBairros.add(extrairBairro(o));
    const ruaO = extrairRua(o);
    if (ruaO) opcoesRuas.add(ruaO); else semRua++;
    extrairTecnicos(o).forEach(t => opcoesTecnicos.add(t));
    const eq = extrairEquipe(o);
    if (eq) opcoesEquipes.add(eq);
    opcoesTipos.add(extrairTipo(o));
  }
  if (todasOrdens.length > 5 && semRua / todasOrdens.length > 0.5) {
    console.warn(`[agendamentos] campo de rua não encontrado em ${Math.round((semRua / todasOrdens.length) * 100)}% das O.S. — confirmar nome do campo em dados_endereco_instalacao (extrairRua em jobs/agendamentos.js)`);
  }

  const ordens = todasOrdens.filter(o => {
    if (cidade && extrairCidade(o) !== cidade) return false;
    if (bairro && extrairBairro(o) !== bairro) return false;
    if (rua && (extrairRua(o) || 'Sem rua') !== rua) return false;
    if (tecnico && !extrairTecnicos(o).includes(tecnico)) return false;
    if (equipe && extrairEquipe(o) !== equipe) return false;
    if (tipo && extrairTipo(o) !== tipo) return false;
    if (status && statusOperacional(o, agora) !== status) return false;
    return true;
  });

  const resumo = { total: 0, aguardando: 0, em_execucao: 0, concluida: 0, atrasada: 0 };
  const porCidade = new Map();
  const porBairro = new Map();
  const porRua = new Map();
  const porTecnico = new Map();
  const porEquipe = new Map();
  const porTipo = new Map();
  const motivos = new Map();
  const porDia = new Map();
  const porSemana = new Map();
  const porMes = new Map();
  const atrasadas = [];
  const pontosMapa = [];

  const novoContador = () => ({ total: 0, aguardando: 0, em_execucao: 0, concluida: 0, atrasada: 0 });
  const somar = (mapa, chave, statusOS) => {
    const c = mapa.get(chave) || novoContador();
    c.total++; c[statusOS]++;
    mapa.set(chave, c);
  };

  for (const o of ordens) {
    const statusOS = statusOperacional(o, agora);
    resumo.total++; resumo[statusOS]++;

    somar(porCidade, extrairCidade(o), statusOS);
    somar(porBairro, extrairBairro(o), statusOS);
    somar(porRua, extrairRua(o) || 'Sem rua', statusOS);
    extrairTecnicos(o).forEach(t => somar(porTecnico, t, statusOS));
    const eq = extrairEquipe(o);
    if (eq) somar(porEquipe, eq, statusOS);
    somar(porTipo, extrairTipo(o), statusOS);

    const motivo = extrairMotivo(o);
    if (motivo) motivos.set(motivo, (motivos.get(motivo) || 0) + 1);

    const plano = paraPlano(o, agora);
    if (plano.lat != null && plano.lng != null) pontosMapa.push(plano);

    const dProg = paraDataHora(o.data_inicio_programado);
    const dia = chaveDia(dProg);
    if (dia) {
      const bucket = porDia.get(dia) || { ...novoContador(), dia, ordens: [] };
      bucket.total++; bucket[statusOS]++;
      bucket.ordens.push(plano);
      porDia.set(dia, bucket);

      const semana = chaveSemanaISO(dProg);
      somar(porSemana, semana, statusOS);

      const mes = chaveMes(dia);
      somar(porMes, mes, statusOS);
    }

    if (statusOS === 'atrasada') atrasadas.push(plano);
  }

  const porTotalDesc = (a, b) => b.total - a.total;
  const paraLista = (mapa, campoChave) =>
    [...mapa.entries()].map(([chave, v]) => ({ [campoChave]: chave, ...v })).sort(porTotalDesc);

  atrasadas.sort((a, b) => new Date((a.programado_fim || a.programado_inicio || '').replace(' ', 'T')) - new Date((b.programado_fim || b.programado_inicio || '').replace(' ', 'T')));

  const motivosOrdenados = [...motivos.entries()]
    .map(([motivo, total]) => ({ motivo, total }))
    .sort((a, b) => b.total - a.total);

  return {
    resumo,
    atrasadas,
    pontos_mapa: pontosMapa,
    por_cidade: paraLista(porCidade, 'cidade'),
    por_bairro: paraLista(porBairro, 'bairro'),
    por_rua: paraLista(porRua, 'rua'),
    por_tecnico: paraLista(porTecnico, 'tecnico'),
    por_equipe: paraLista(porEquipe, 'equipe'),
    por_tipo: paraLista(porTipo, 'tipo'),
    motivos_fechamento: motivosOrdenados,
    por_dia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    por_semana: [...porSemana.entries()].map(([semana, v]) => ({ semana, ...v })).sort((a, b) => a.semana.localeCompare(b.semana)),
    por_mes: [...porMes.entries()].map(([mes, v]) => ({ mes, ...v })).sort((a, b) => a.mes.localeCompare(b.mes)),
    opcoes: {
      cidades: ordenarPtBr(opcoesCidades),
      bairros: ordenarPtBr(opcoesBairros),
      ruas: ordenarPtBr(opcoesRuas),
      tecnicos: ordenarPtBr(opcoesTecnicos),
      equipes: ordenarPtBr(opcoesEquipes),
      tipos: ordenarPtBr(opcoesTipos),
      status: Object.entries(LABEL_STATUS).map(([valor, label]) => ({ valor, label })),
    },
    filtros: {
      cidade: cidade || null, bairro: bairro || null, rua: rua || null,
      tecnico: tecnico || null, equipe: equipe || null, tipo: tipo || null, status: status || null,
    },
  };
}

module.exports = { buscarAgendamentos, agregarAgendamentos, statusOperacional };
