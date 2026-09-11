// Indicadores automáticos da área "LC Técnica" (Gestão > Indicadores): Total de
// O.S., Total de Ativações, TM O.S., TMI, SLA Suporte, SLA Ativação, Prod/HC/dia
// (Suporte e Ativação) e Nota Suporte/Reparo — recalculados uma vez ao dia sobre
// o mês corrente até hoje. Mesmo padrão do indicadoresHelpDesk.js: a pessoa não
// digita nada, só acompanha o histórico que esse job vai alimentando dia a dia.
//
// Fonte: o cache que a Análise de O.S. já mantém (analise_os_cache, atualizado
// a cada 5 min por syncAnaliseOS.js) e a pesquisa pós-O.S. do Chatmix
// (chatmix_atendimentos) — este job não faz nenhum sync próprio no
// HubSoft/Chatmix, só lê o que já está cacheado.
//
// Quais tipos de O.S. contam como Ativação/Suporte e qual pesquisa do Chatmix
// alimenta a Nota vêm de lc_tecnica_config, configurável em Gestão > Indicadores
// (GET/PUT /api/gestao/lc-tecnica/config, opções em /api/gestao/lc-tecnica/opcoes).
// Sem configuração, os indicadores dependentes ficam null até a usuária configurar.
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { agregarIndicadoresOS } = require('./lcTecnicaIndicadores');

function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }

const DEFINICOES = [
  { chave: 'total_os', nome: 'Total de O.S. - LC Técnica', unidade: 'O.S.', meta: null,
    descricao: 'Total de ordens de serviço concluídas no mês.' },
  { chave: 'total_ativacoes', nome: 'Total de Ativações - LC Técnica', unidade: 'ativações', meta: null,
    descricao: 'Total de novos serviços instalados/ativados no mês (tipos de O.S. configurados como Ativação).' },
  { chave: 'tm_os', nome: 'TM O.S. - LC Técnica', unidade: 'h', meta: null,
    descricao: 'Tempo médio de atendimento (execução real) de todas as O.S. concluídas no mês.' },
  { chave: 'tmi', nome: 'TMI - LC Técnica', unidade: 'h', meta: 0.5,
    descricao: 'Tempo médio de instalação (execução real das O.S. de Ativação). Mercado espera abaixo de 30 min.' },
  { chave: 'sla_suporte', nome: 'SLA Suporte - LC Técnica', unidade: 'h', meta: null,
    descricao: 'Tempo médio entre abertura e agendamento das O.S. de Suporte/Reparo.' },
  { chave: 'sla_ativacao', nome: 'SLA Ativação - LC Técnica', unidade: 'h', meta: 24,
    descricao: 'Tempo médio entre abertura e agendamento das O.S. de Ativação. Mercado espera abaixo de 24h.' },
  { chave: 'prod_suporte', nome: 'Prod/HC/dia Suporte - LC Técnica', unidade: 'atend./HC/dia', meta: 2,
    descricao: 'O.S. de Suporte concluídas ÷ técnicos distintos que atenderam ÷ dias úteis do mês até hoje. Mercado espera acima de 2.' },
  { chave: 'prod_ativacao', nome: 'Prod/HC/dia Ativação - LC Técnica', unidade: 'ativações/HC/dia', meta: 0.5,
    descricao: 'O.S. de Ativação concluídas ÷ técnicos distintos que atenderam ÷ dias úteis do mês até hoje. Mercado espera acima de 0,5.' },
  { chave: 'nota_suporte', nome: 'Nota Suporte/Reparo - LC Técnica', unidade: 'nota (0-5)', meta: 4.5,
    descricao: 'Nota média da pesquisa pós-O.S. do Chatmix (internet/atendimento do técnico). Configurar em Gestão > Indicadores.' },
];

async function garantirIndicador(empresaId, def) {
  const existente = await get('SELECT id FROM indicadores WHERE empresa_id=$1 AND nome=$2', [empresaId, def.nome]);
  if (existente) return existente.id;
  const id = uuidv4();
  await run(
    `INSERT INTO indicadores (id, empresa_id, nome, descricao, unidade, meta, frequencia)
     VALUES ($1,$2,$3,$4,$5,$6,'diario')`,
    [id, empresaId, def.nome, def.descricao, def.unidade, def.meta]);
  return id;
}
async function registrarValor(indicadorId, valor, dataRegistro) {
  if (valor == null || Number.isNaN(valor)) return;
  const v = r2(valor);
  const existente = await get('SELECT id FROM indicadores_historico WHERE indicador_id=$1 AND data_registro=$2', [indicadorId, dataRegistro]);
  if (existente) await run('UPDATE indicadores_historico SET valor=$1 WHERE id=$2', [v, existente.id]);
  else await run('INSERT INTO indicadores_historico (id, indicador_id, valor, data_registro) VALUES ($1,$2,$3,$4)', [uuidv4(), indicadorId, v, dataRegistro]);
  await run('UPDATE indicadores SET valor_atual=$1 WHERE id=$2', [v, indicadorId]);
}
async function ordensDoMesCacheadas(mesRef) {
  const row = await get('SELECT dados FROM analise_os_cache WHERE mes=$1', [mesRef]);
  return row?.dados || [];
}
async function lcConfig(empresaId) {
  const row = await get('SELECT * FROM lc_tecnica_config WHERE empresa_id=$1', [empresaId]);
  return row || { tipos_ativacao: [], tipos_suporte: [], chatmix_departamento: null, mapa_notas: {} };
}
async function notaSuporteReparo(empresaId, dataInicio, dataFim, config) {
  if (!config?.chatmix_departamento) return null;
  const rows = await all(
    `SELECT tag_finalizacao, nota FROM chatmix_atendimentos
     WHERE empresa_id=$1 AND departamento=$2 AND closed_at::date BETWEEN $3 AND $4`,
    [empresaId, config.chatmix_departamento, dataInicio, dataFim]
  );
  const mapa = config.mapa_notas || {};
  const notas = rows
    .map(r => (r.nota != null ? r.nota : (r.tag_finalizacao != null ? mapa[r.tag_finalizacao] : null)))
    .filter(n => n != null && !Number.isNaN(Number(n)))
    .map(Number);
  return notas.length ? notas.reduce((s, n) => s + n, 0) / notas.length : null;
}

async function rodar() {
  try {
    const hoje = hojeSP();
    const mesRef = hoje.slice(0, 7);
    const dataInicio = mesRef + '-01';
    const empresas = await all(`SELECT id AS empresa_id FROM empresas`);
    const ordens = await ordensDoMesCacheadas(mesRef);
    for (const { empresa_id } of empresas) {
      try {
        const config = await lcConfig(empresa_id);
        const ind = agregarIndicadoresOS(ordens, mesRef, config, hoje);
        const nota = await notaSuporteReparo(empresa_id, dataInicio, hoje, config);
        const ids = {};
        for (const def of DEFINICOES) ids[def.chave] = await garantirIndicador(empresa_id, def);
        await registrarValor(ids.total_os, ind.total_os, hoje);
        await registrarValor(ids.total_ativacoes, ind.total_ativacoes, hoje);
        await registrarValor(ids.tm_os, ind.tm_os_horas, hoje);
        await registrarValor(ids.tmi, ind.tmi_horas, hoje);
        await registrarValor(ids.sla_suporte, ind.sla_suporte_horas, hoje);
        await registrarValor(ids.sla_ativacao, ind.sla_ativacao_horas, hoje);
        await registrarValor(ids.prod_suporte, ind.prod_hc_dia_suporte, hoje);
        await registrarValor(ids.prod_ativacao, ind.prod_hc_dia_ativacao, hoje);
        await registrarValor(ids.nota_suporte, nota, hoje);
      } catch (e) { console.error('[syncIndicadoresLcTecnica] empresa', empresa_id, e.message); }
    }
  } catch (e) { console.error('[syncIndicadoresLcTecnica]', e.message); }
}

function iniciar() {
  setTimeout(rodar, 120 * 1000); // dá tempo do syncAnaliseOS carregar o cache primeiro
  setInterval(rodar, 24 * 60 * 60 * 1000); // uma vez por dia
  console.log('[syncIndicadoresLcTecnica] iniciado (recalcula os 9 indicadores 1x/dia)');
}

module.exports = { iniciar, rodar };
