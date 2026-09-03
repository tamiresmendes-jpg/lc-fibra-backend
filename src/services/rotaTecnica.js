// Rota Técnica: sequência de O.S. atendidas/agendadas por um técnico num dia,
// com endereço + coordenadas (dados_endereco_instalacao.coordenadas, testado
// ao vivo em 27/08/2026 — presente em ~99,5% das O.S.).
//
// Não existe campo de "sequência de visita" no HubSoft: a ordem é reconstruída
// pela hora real de execução (data_inicio_executado) quando já atendida, ou
// pela hora agendada (data_inicio_programado) enquanto pendente.
//
// As distâncias calculadas aqui são estimativas em LINHA RETA entre pontos
// (Haversine) — não é rota de rua real. Servem como indicativo de eficiência
// (zigue-zague vs. trajeto mais direto), não como medição exata percorrida.
const { listarOrdensServico } = require('./hubsoft');

function ordenarPtBr(arr) { return [...arr].sort((a, b) => a.localeCompare(b, 'pt-BR')); }
function km(n) { return n == null ? null : Math.round(n * 10) / 10; }

async function buscarOSDoDia({ data }) {
  return listarOrdensServico({ dataInicio: data, dataFim: data, tipoData: 'data_inicio_programado', maxPaginas: 10 });
}

function extrairTecnicos(o) {
  return Array.isArray(o.tecnicos) ? o.tecnicos.map(t => t.name || t.display).filter(Boolean) : [];
}

// O texto de "status" do HubSoft já carrega o estado real da O.S. (é o mesmo
// texto/cor que aparece no painel: roxo=pendente, vermelho=reservada — técnico
// a caminho, azul=em execução, verde=finalizado). Não existe um campo separado
// com a HORA em que a O.S. foi reservada — só dá pra saber que está reservada,
// não desde quando (checado ao vivo em 01/09/2026).
function classificarEstado(o) {
  const s = (o.status || '').toLowerCase();
  if (s.includes('finalizad')) return 'concluida';
  if (s.includes('execução') || s.includes('execucao')) return 'executando';
  if (s.includes('reservad')) return 'reservada';
  return 'pendente';
}

function extrairPonto(o) {
  const e = o.dados_endereco_instalacao || {};
  const c = e.coordenadas || {};
  const lat = typeof c.latitude === 'number' ? c.latitude : null;
  const lng = typeof c.longitude === 'number' ? c.longitude : null;
  return {
    id_ordem_servico: o.id_ordem_servico,
    numero: o.numero,
    tipo: o.tipo_ordem_servico?.descricao || 'Sem tipo',
    status: o.status || null,
    estado: classificarEstado(o),
    nome_cliente: o.dados_cliente?.nome_razaosocial || null,
    hora_programada: o.data_inicio_programado || null,
    hora_executada: o.data_inicio_executado || null,
    hora_termino: o.data_termino_executado || null,
    concluida: !!o.data_termino_executado,
    endereco: e.endereco || null,
    numero_endereco: e.numero || null,
    complemento: e.complemento || null,
    bairro: e.bairro || null,
    cidade: e.cidade || null,
    cep: e.cep || null,
    lat, lng,
  };
}

function listarTecnicosDoDia(ordens) {
  const nomes = new Set();
  for (const o of ordens) extrairTecnicos(o).forEach(n => nomes.add(n));
  return ordenarPtBr([...nomes]);
}

function cidadeDe(o) { return o.dados_endereco_instalacao?.cidade || null; }

function listarCidadesDoDia(ordens) {
  const cidades = new Set();
  for (const o of ordens) { const c = cidadeDe(o); if (c) cidades.add(c); }
  return ordenarPtBr([...cidades]);
}

// Filtra as O.S. do dia por cidade — usado só pra achar QUAIS técnicos
// trabalharam ali; depois de escolhido o técnico, a rota mostra o dia
// inteiro dele (não corta pontos fora da cidade no meio da sequência).
function filtrarPorCidade(ordens, cidade) {
  if (!cidade) return ordens;
  return ordens.filter(o => cidadeDe(o) === cidade);
}

// Haversine — distância em km entre dois pontos {lat,lng}.
function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function somaDistancia(pontos) {
  let total = 0;
  for (let i = 1; i < pontos.length; i++) total += haversineKm(pontos[i - 1], pontos[i]);
  return total;
}

// Heurística do vizinho mais próximo — começa no mesmo primeiro ponto da rota
// real (é onde o técnico já estava) e sempre vai pro ponto não visitado mais
// próximo. Não é o ótimo global (isso é NP-difícil), mas dá uma estimativa
// razoável de "quanto daria pra economizar organizando melhor a sequência".
function distanciaOtimizadaKm(pontos) {
  if (pontos.length < 2) return 0;
  const restantes = pontos.slice(1);
  const ordemOtimizada = [pontos[0]];
  let atual = pontos[0];
  while (restantes.length) {
    let iMaisProximo = 0;
    let menorDist = Infinity;
    for (let i = 0; i < restantes.length; i++) {
      const d = haversineKm(atual, restantes[i]);
      if (d < menorDist) { menorDist = d; iMaisProximo = i; }
    }
    atual = restantes.splice(iMaisProximo, 1)[0];
    ordemOtimizada.push(atual);
  }
  return somaDistancia(ordemOtimizada);
}

function montarRotaTecnico(ordens, tecnico) {
  const doTecnico = ordens.filter(o => extrairTecnicos(o).includes(tecnico));
  const pontos = doTecnico
    .map(extrairPonto)
    .sort((a, b) => new Date((a.hora_executada || a.hora_programada || '').replace(' ', 'T')) -
                     new Date((b.hora_executada || b.hora_programada || '').replace(' ', 'T')))
    .map((p, i) => ({ ordem: i + 1, ...p }));

  const comCoordenada = pontos.filter(p => p.lat != null && p.lng != null);
  const semCoordenadas = pontos.length - comCoordenada.length;
  const concluidas = pontos.filter(p => p.concluida).length;

  let distanciaReal = null, distanciaOtimizada = null, economiaKm = null, economiaPercentual = null;
  if (comCoordenada.length >= 2) {
    distanciaReal = somaDistancia(comCoordenada);
    distanciaOtimizada = distanciaOtimizadaKm(comCoordenada);
    economiaKm = Math.max(0, distanciaReal - distanciaOtimizada);
    economiaPercentual = distanciaReal > 0 ? (economiaKm / distanciaReal) * 100 : 0;
  }

  return {
    tecnico,
    pontos,
    resumo: {
      total: pontos.length,
      concluidas,
      pendentes: pontos.length - concluidas,
      sem_coordenadas: semCoordenadas,
      distancia_real_km: km(distanciaReal),
      distancia_otimizada_km: km(distanciaOtimizada),
      economia_km: km(economiaKm),
      economia_percentual: economiaPercentual == null ? null : Math.round(economiaPercentual),
    },
  };
}

module.exports = {
  buscarOSDoDia, listarTecnicosDoDia, montarRotaTecnico, haversineKm,
  listarCidadesDoDia, filtrarPorCidade,
};
