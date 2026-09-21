// Pré-busca as O.S. e os movimentos de estoque do mês em segundo plano — a
// tela lê do cache (rápido) em vez de bater no HubSoft a cada abertura ou
// troca de filtro. Guarda os dados CRUS (não o resultado já agregado): o
// filtro por cidade/tipo e o custo de material são recalculados na hora em
// cima do cache, sem precisar buscar de novo no ERP a cada troca.
const { run } = require('../config/database');
const { buscarDadosOS } = require('./analiseOS');
const { dentroJanelaSyncNoturno } = require('../utils/janelaSyncNoturno');

function mesAtualEAnterior() {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const d = new Date(hoje + 'T12:00');
  const atual = hoje.slice(0, 7);
  const ant = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const anterior = `${ant.getFullYear()}-${String(ant.getMonth() + 1).padStart(2, '0')}`;
  return [atual, anterior];
}
function intervaloDoMes(mesRef) {
  const [ano, mes] = mesRef.split('-').map(Number);
  const ultimoDia = new Date(ano, mes, 0).getDate();
  const iso = (d) => `${ano}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { dataInicio: iso(1), dataFim: iso(ultimoDia) };
}

let _rodando = false;
async function tick() {
  if (_rodando) { console.log('[syncAnaliseOS] ciclo anterior ainda rodando, pulou esta vez'); return; }
  if (dentroJanelaSyncNoturno()) { console.log('[syncAnaliseOS] dentro da janela de sync noturno, pulou este ciclo'); return; }
  _rodando = true;
  try {
    // Só o mês atual e o anterior — são os únicos que a tela normalmente abre.
    for (const mesRef of mesAtualEAnterior()) {
      const { dataInicio, dataFim } = intervaloDoMes(mesRef);
      try {
        const dados = await buscarDadosOS({ dataInicio, dataFim });
        await run(
          `INSERT INTO analise_os_cache (mes, dados, atualizado_em) VALUES ($1,$2,NOW())
           ON CONFLICT (mes) DO UPDATE SET dados=EXCLUDED.dados, atualizado_em=NOW()`,
          [mesRef, JSON.stringify(dados)]
        );
        console.log(`[syncAnaliseOS] ${mesRef}: cache atualizado (${dados.ordens.length} O.S., ${dados.movimentos.length} movimentos)`);
      } catch (e) { console.error(`[syncAnaliseOS] ${mesRef}: erro`, e.message); }
    }
  } finally { _rodando = false; }
}

function iniciar() {
  setTimeout(tick, 30 * 1000); // primeira carga logo após subir
  setInterval(tick, 5 * 60 * 1000); // a cada 5 minutos
  console.log('[syncAnaliseOS] iniciado (a cada 5 min)');
}

module.exports = { iniciar, tick };
