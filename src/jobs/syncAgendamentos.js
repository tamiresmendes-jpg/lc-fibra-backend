// Pré-busca as O.S. agendadas em segundo plano — a tela lê do cache (rápido)
// em vez de bater no HubSoft a cada abertura ou troca de filtro. Guarda a
// lista CRUA (não o resultado já agregado): o filtro por cidade/bairro/rua/
// status é recalculado na hora em cima do cache, sem precisar buscar de novo
// no ERP a cada troca.
//
// Resolução diferente por mês, pra não sobrecarregar o HubSoft: só o MÊS
// ATUAL (onde "hoje" mora — é o que decide em_execucao/atrasada em tempo
// real) atualiza a cada 5 min, igual ao syncAnaliseOS. Mês anterior e próximo
// mês mudam pouco de um ciclo pro outro (histórico já fechado / agendamentos
// futuros raramente remarcados de um dia pro outro), então só entram a cada
// 6 ciclos (30 min) — cobre o "tempo real" onde ele importa sem multiplicar
// por 3 a carga que o syncAnaliseOS já gera hoje.
const { run } = require('../config/database');
const { buscarAgendamentos } = require('./agendamentos');
const { dentroJanelaSyncNoturno } = require('../utils/janelaSyncNoturno');

function mesRef(delta) {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const d = new Date(hoje + 'T12:00');
  const m = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
}
function intervaloDoMes(ref) {
  const [ano, mes] = ref.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const iso = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { dataInicio: iso(1), dataFim: iso(ultimoDia) };
}

async function sincronizarMes(ref) {
  const { dataInicio, dataFim } = intervaloDoMes(ref);
  try {
    const ordens = await buscarAgendamentos({ dataInicio, dataFim });
    await run(
      `INSERT INTO agendamentos_cache (mes, dados, atualizado_em) VALUES ($1,$2,NOW())
       ON CONFLICT (mes) DO UPDATE SET dados=EXCLUDED.dados, atualizado_em=NOW()`,
      [ref, JSON.stringify(ordens)]
    );
    console.log(`[syncAgendamentos] ${ref}: cache atualizado (${ordens.length} O.S.)`);
  } catch (e) { console.error(`[syncAgendamentos] ${ref}: erro`, e.message); }
}

let _rodando = false;
let _ciclo = 0;
async function tick() {
  if (_rodando) { console.log('[syncAgendamentos] ciclo anterior ainda rodando, pulou esta vez'); return; }
  if (dentroJanelaSyncNoturno()) { console.log('[syncAgendamentos] dentro da janela de sync noturno, pulou este ciclo'); return; }
  _rodando = true;
  try {
    await sincronizarMes(mesRef(0)); // mês atual — sempre, é o que precisa de tempo real
    if (_ciclo % 6 === 0) { // a cada 30 min (6 x 5 min) — inclui o 1º ciclo, pra já subir com os 3 meses
      await sincronizarMes(mesRef(-1));
      await sincronizarMes(mesRef(1));
    }
    _ciclo++;
  } finally { _rodando = false; }
}

function iniciar() {
  setTimeout(tick, 30 * 1000); // primeira carga logo após subir
  setInterval(tick, 5 * 60 * 1000); // a cada 5 minutos
  console.log('[syncAgendamentos] iniciado (mês atual a cada 5 min; anterior/próximo a cada 30 min)');
}

module.exports = { iniciar, tick };
