// Pré-calcula a Meta de Cobrança em segundo plano e guarda em cache — a tela
// buscava tudo em tempo real no HubSoft a cada abertura (O.S. do mês inteiro +
// 2 chamadas por cliente com pagamento), o que é lento. As outras metas
// (Comercial, Financeiro, Call Center) já leem de tabela sincronizada; esta
// job faz o mesmo pra Cobrança, pra abrir na hora igual às outras.
const { run } = require('../config/database');
const { montarMetaCobranca, montarAnaliseCobranca } = require('./metaCobranca');

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
  if (_rodando) { console.log('[syncMetaCobranca] ciclo anterior ainda rodando, pulou esta vez'); return; }
  _rodando = true;
  try {
    // Só o mês atual e o anterior — são os únicos que a tela normalmente abre.
    // Meses mais antigos continuam calculando em tempo real (mais raro de abrir).
    for (const mesRef of mesAtualEAnterior()) {
      const { dataInicio, dataFim } = intervaloDoMes(mesRef);
      try {
        const dados = await montarMetaCobranca({ dataInicio, dataFim });
        await run(
          `INSERT INTO meta_cobranca_cache (mes, dados, atualizado_em) VALUES ($1,$2,NOW())
           ON CONFLICT (mes) DO UPDATE SET dados=EXCLUDED.dados, atualizado_em=NOW()`,
          [mesRef, JSON.stringify(dados)]
        );
        const analise = await montarAnaliseCobranca({ dataInicio, dataFim });
        await run(
          `INSERT INTO meta_cobranca_analise_cache (mes, dados, atualizado_em) VALUES ($1,$2,NOW())
           ON CONFLICT (mes) DO UPDATE SET dados=EXCLUDED.dados, atualizado_em=NOW()`,
          [mesRef, JSON.stringify(analise)]
        );
        console.log(`[syncMetaCobranca] ${mesRef}: cache atualizado`);
      } catch (e) { console.error(`[syncMetaCobranca] ${mesRef}: erro`, e.message); }
    }
  } finally { _rodando = false; }
}

function iniciar() {
  setTimeout(tick, 20 * 1000); // primeira carga logo após subir
  setInterval(tick, 4 * 60 * 1000); // a cada 4 minutos, igual ao Comercial
  console.log('[syncMetaCobranca] iniciado (a cada 4 min)');
}

module.exports = { iniciar, tick };
