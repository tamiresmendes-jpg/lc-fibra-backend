// Rotina diária (cron às 4h15): sincroniza a Análise Fiscal no cache,
// buscando no ERP HubSoft uma vez por dia — para o sistema não consultar
// o ERP a cada acesso e evitar sobrecarga.
//
// Uso: cd backend && node src/jobs/syncAnaliseFiscal.js
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  console.log('[sync-fiscal] início', new Date().toISOString());
  try {
    await erp.sincronizarTodasFiscal();
    console.log('[sync-fiscal] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-fiscal] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
