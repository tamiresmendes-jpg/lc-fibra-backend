// Janela em que os syncs pesados de madrugada rodam no cron (Financeiro 3h,
// Aderência Livros 3h30, Produto 4h, Fiscal 4h15, Pacotes 4h30, Serviços
// NFSe 4h45) — usada pelos jobs de 5 em 5 min (Análise de O.S., Agendamentos)
// pra não bater no HubSoft nesse horário e competir pelo limite de 30
// requisições/60s por IP, o que vinha derrubando os syncs de madrugada com
// 429 (rate_limit_exceeded) desde 18/09/2026.
function dentroJanelaSyncNoturno() {
  const hhmmss = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Sao_Paulo', hour12: false });
  const [h, m] = hhmmss.split(':').map(Number);
  const minutos = h * 60 + m;
  return minutos >= 2 * 60 + 55 && minutos <= 5 * 60 + 15; // 02:55–05:15
}

module.exports = { dentroJanelaSyncNoturno };
