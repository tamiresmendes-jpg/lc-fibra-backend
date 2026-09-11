// Indicadores da LC Técnica (Gestão > Indicadores): Total O.S., Total de
// Ativações, TM O.S., TMI, SLA Suporte/Ativação e Produtividade por HC/dia.
//
// Calculados em cima do que a Análise de O.S. já busca e cacheia por mês
// (analiseOS.js/syncAnaliseOS.js) — não faz sync próprio no HubSoft. A
// separação Ativação x Suporte depende da configuração da empresa
// (lc_tecnica_config.tipos_ativacao/tipos_suporte), já que o HubSoft não tem
// um campo fixo pra isso — quem sabe quais tipos de O.S. contam como cada
// indicador é a usuária, via tela de configuração.
//
// HC (mão de obra) de cada indicador = número de técnicos DISTINTOS que
// aparecem nas O.S. daquele grupo no mês (extrairTecnicos, mesma extração da
// Análise de O.S.) — cobre equipe individual e em dupla automaticamente, sem
// precisar de cadastro de composição de equipe (não existe no sistema).

function paraDataHora(s) {
  if (!s) return null;
  const d = new Date(String(s).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}
function diffMinutos(inicioStr, fimStr) {
  const a = paraDataHora(inicioStr), b = paraDataHora(fimStr);
  if (!a || !b) return null;
  const min = (b - a) / 60000;
  return min >= 0 ? min : null;
}
function media(nums) {
  const v = nums.filter(n => n != null);
  return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null;
}
function horas(min) { return min == null ? null : Math.round((min / 60) * 10) / 10; }
function arred2(n) { return n == null ? null : Math.round(n * 100) / 100; }
function extrairTipo(o) { return o.tipo_ordem_servico?.descricao || 'Sem tipo'; }
function extrairTecnicos(o) {
  return Array.isArray(o.tecnicos) ? o.tecnicos.map(t => t.name || t.display).filter(Boolean) : [];
}

// Dias úteis (seg-sex) do mês — usado pra "Prod/HC/dia". Sem feriados (o
// sistema já tem um cadastro de feriados em /api/feriados, mas os indicadores
// de mercado citados pela usuária usam "dias úteis" no sentido simples).
// `ateData` (YYYY-MM-DD) limita a contagem até um dia específico — o job
// diário recalcula o mês corrente "até hoje" (mesmo critério do
// indicadoresHelpDesk.js), senão a produtividade ficaria subestimada no
// meio do mês (dividindo pelos dias úteis do mês INTEIRO).
function diasUteisDoMes(mesRef, ateData) {
  const [ano, mes] = mesRef.split('-').map(Number);
  const ultimoDiaMes = new Date(ano, mes, 0).getDate();
  const limite = ateData && ateData.startsWith(mesRef) ? Number(ateData.slice(8, 10)) : ultimoDiaMes;
  let total = 0;
  for (let d = 1; d <= Math.min(limite, ultimoDiaMes); d++) {
    const dow = new Date(ano, mes - 1, d).getDay();
    if (dow !== 0 && dow !== 6) total++;
  }
  return total;
}

// Tipos de O.S. distintos vistos nas ordens — alimenta o seletor da tela de
// configuração (quais tipos compõem Ativação/Suporte).
function tiposDistintos(ordens) {
  return [...new Set((ordens || []).map(extrairTipo))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function agregarIndicadoresOS(ordens, mesRef, config, ateData) {
  const tiposAtivacao = new Set(config?.tipos_ativacao || []);
  const tiposSuporte = new Set(config?.tipos_suporte || []);

  const concluidas = (ordens || []).filter(o => !!o.data_termino_executado);
  const ativacoes = concluidas.filter(o => tiposAtivacao.has(extrairTipo(o)));
  const suporte = concluidas.filter(o => tiposSuporte.has(extrairTipo(o)));

  const tempoTodas = concluidas.map(o => diffMinutos(o.data_inicio_executado, o.data_termino_executado));
  const tempoAtivacao = ativacoes.map(o => diffMinutos(o.data_inicio_executado, o.data_termino_executado));
  const slaSuporte = suporte.map(o => diffMinutos(o.data_cadastro, o.data_inicio_programado));
  const slaAtivacao = ativacoes.map(o => diffMinutos(o.data_cadastro, o.data_inicio_programado));

  const tecnicosAtivacao = new Set();
  ativacoes.forEach(o => extrairTecnicos(o).forEach(t => tecnicosAtivacao.add(t)));
  const tecnicosSuporte = new Set();
  suporte.forEach(o => extrairTecnicos(o).forEach(t => tecnicosSuporte.add(t)));

  const diasUteis = diasUteisDoMes(mesRef, ateData);

  return {
    total_os: concluidas.length,
    total_ativacoes: ativacoes.length,
    total_suporte: suporte.length,
    tm_os_horas: horas(media(tempoTodas)),
    tmi_horas: horas(media(tempoAtivacao)),
    sla_suporte_horas: horas(media(slaSuporte)),
    sla_ativacao_horas: horas(media(slaAtivacao)),
    hc_ativacao: tecnicosAtivacao.size,
    hc_suporte: tecnicosSuporte.size,
    dias_uteis: diasUteis,
    prod_hc_dia_ativacao: (diasUteis > 0 && tecnicosAtivacao.size > 0)
      ? arred2(ativacoes.length / tecnicosAtivacao.size / diasUteis) : null,
    prod_hc_dia_suporte: (diasUteis > 0 && tecnicosSuporte.size > 0)
      ? arred2(suporte.length / tecnicosSuporte.size / diasUteis) : null,
  };
}

module.exports = { agregarIndicadoresOS, tiposDistintos, diasUteisDoMes };
