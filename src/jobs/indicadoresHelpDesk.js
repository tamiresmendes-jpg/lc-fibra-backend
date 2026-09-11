// Indicadores automáticos da área "LC Help Desk" (Gestão > Indicadores): Contact Rate,
// Nota de Atendimento, Taxa de Resolutividade e TME — todos calculados a partir do
// Suporte do Chatmix, uma vez ao dia, sobre o mês corrente até hoje. A pessoa não
// digita nada — só acompanha o histórico que esse job vai alimentando dia a dia.
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');

function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function inicioMes(hoje) { return hoje.slice(0, 7) + '-01'; }
function paraSeg(t) {
  const p = String(t || '0:0:0').split(':').map(n => parseInt(n, 10) || 0);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}
function r2(n) { return n == null ? null : Math.round(n * 100) / 100; }

const DEFINICOES = [
  { chave: 'contact_rate', nome: 'Contact Rate - Help Desk', unidade: '%', meta: null,
    descricao: 'Percentual de atendimentos do Suporte avaliados como "insatisfeito" sobre o total avaliado no mês.' },
  { chave: 'nota', nome: 'Nota de Atendimento - Help Desk', unidade: 'nota (0-5)', meta: 4,
    descricao: 'Nota média das avaliações do Suporte no Chatmix, escala de 0 a 5. Mercado espera acima de 4,0.' },
  { chave: 'resolutividade', nome: 'Taxa de Resolutividade - Help Desk', unidade: '%', meta: 80,
    descricao: 'Percentual de atendimentos do Suporte encerrados com tag classificada como "resolvido sem técnico" sobre o total de tags classificadas. Configurar tags em Gestão > Indicadores.' },
  { chave: 'tme', nome: 'TME - Help Desk', unidade: 'min', meta: 3,
    descricao: 'Tempo médio de espera do Suporte no Chatmix, em minutos. Mercado espera abaixo de 3 minutos.' },
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

// Contact Rate + Nota: agregado dos atendentes do Suporte na fonte oficial de satisfação.
async function calcularContactRateENota(chatmix, empresaId, di, df) {
  const sat = await chatmix.satisfacaoOficial(empresaId, di, df);
  if (!sat) return { contactRate: null, nota: null };
  let s = 0, i = 0, somaMedia = 0, nAtend = 0;
  for (const [nome, v] of Object.entries(sat)) {
    if (chatmix.deptDeNome(nome) !== 'Suporte') continue;
    s += v.sat || 0; i += v.insat || 0;
    if (v.media != null) { somaMedia += Number(v.media) * (v.total || 1); nAtend += (v.total || 1); }
  }
  const validas = s + i;
  return {
    contactRate: validas ? (i / validas) * 100 : null,
    nota: nAtend ? somaMedia / nAtend : null,
  };
}

// TME: departamentos oficiais do Chatmix cujo nome mapeia pro canônico "Suporte",
// em média ponderada pelo total de atendimentos (pode haver mais de um "Suporte X").
async function calcularTme(chatmix, empresaId, di, df) {
  const dep = await chatmix.departamentosOficial(empresaId, di, df);
  if (!dep?.data) return null;
  let segSoma = 0, total = 0;
  for (const d of dep.data) {
    if (chatmix.deptDeNome(d.name) !== 'Suporte') continue;
    total += (d.total || 1);
    segSoma += paraSeg(d.tme) * (d.total || 1);
  }
  return total ? (segSoma / total) / 60 : null;
}

// Taxa de Resolutividade: só conta atendimentos cuja tag de encerramento foi
// classificada manualmente (ver GET/PUT /chatmix/helpdesk/tags).
async function calcularResolutividade(DEPT_SQL, empresaId, di, df) {
  const rows = await all(
    `SELECT ctc.categoria, COUNT(*)::int AS qtd
     FROM chatmix_atendimentos ca
     LEFT JOIN chatmix_tag_categoria ctc ON ctc.empresa_id = ca.empresa_id AND ctc.tag = ca.tag_finalizacao
     WHERE ca.empresa_id = $1 AND ca.closed_at::date BETWEEN $2 AND $3
       AND (${DEPT_SQL}) = 'Suporte' AND ca.atendente_nome IS NOT NULL
     GROUP BY ctc.categoria`, [empresaId, di, df]);
  const resolvido = rows.find(r => r.categoria === 'resolvido')?.qtd || 0;
  const tecnico = rows.find(r => r.categoria === 'tecnico')?.qtd || 0;
  if (resolvido + tecnico === 0) return null;
  return (resolvido / (resolvido + tecnico)) * 100;
}

async function rodar() {
  try {
    // Lazy require: chatmix.js é uma rota que não depende de jobs, mas evita
    // qualquer ciclo de carregamento, mesmo padrão usado em metaSemanal.js.
    const chatmix = require('../routes/chatmix');
    const empresas = await all(`SELECT empresa_id FROM integracao_chatmix WHERE token IS NOT NULL AND token <> ''`);
    const hoje = hojeSP();
    const di = inicioMes(hoje);
    for (const { empresa_id } of empresas) {
      try {
        const ids = {};
        for (const def of DEFINICOES) ids[def.chave] = await garantirIndicador(empresa_id, def);
        const [{ contactRate, nota }, tme, resolutividade] = await Promise.all([
          calcularContactRateENota(chatmix, empresa_id, di, hoje),
          calcularTme(chatmix, empresa_id, di, hoje),
          calcularResolutividade(chatmix.DEPT_SQL, empresa_id, di, hoje),
        ]);
        await registrarValor(ids.contact_rate, contactRate, hoje);
        await registrarValor(ids.nota, nota, hoje);
        await registrarValor(ids.tme, tme, hoje);
        await registrarValor(ids.resolutividade, resolutividade, hoje);
      } catch (e) { console.error('[indicadoresHelpDesk] empresa', empresa_id, e.message); }
    }
  } catch (e) { console.error('[indicadoresHelpDesk]', e.message); }
}

function iniciar() {
  setTimeout(rodar, 90 * 1000);
  setInterval(rodar, 24 * 60 * 60 * 1000); // uma vez por dia
  console.log('[indicadoresHelpDesk] iniciado (recalcula os 4 indicadores 1x/dia)');
}

module.exports = { iniciar, rodar };
