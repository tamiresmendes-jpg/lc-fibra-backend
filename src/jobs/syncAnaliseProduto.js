// Rotina diária (cron às 4h): sincroniza a Análise de Produto no cache,
// buscando no ERP HubSoft uma vez por dia — para o sistema não consultar
// o ERP a cada acesso e evitar sobrecarga.
//
// Uso: cd backend && node src/jobs/syncAnaliseProduto.js
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  console.log('[sync-analise] início', new Date().toISOString());
  try {
    await erp.sincronizarTodas();
    console.log('[sync-analise] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-analise] falhou:', e.message);
  } finally {
    // encerra o processo (fecha conexões pendentes do pool)
    setTimeout(() => process.exit(0), 500);
  }
})();
