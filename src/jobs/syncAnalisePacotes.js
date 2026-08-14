// Rotina diária (cron às 4h30): sincroniza a Análise de Pacotes no cache,
// buscando no ERP HubSoft uma vez por dia — a tela NUNCA consulta o HubSoft
// na hora do clique, só lê o que já está salvo em erp_pacotes_cache.
//
// Uso: cd backend && node src/jobs/syncAnalisePacotes.js
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  console.log('[sync-pacotes] início', new Date().toISOString());
  try {
    await erp.sincronizarPacotes();
    console.log('[sync-pacotes] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-pacotes] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
