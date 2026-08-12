// Rotina diária (cron às 4h30): sincroniza o Financeiro Mensal (Contas a
// Receber) no cache, buscando no ERP HubSoft uma vez por dia — para o
// sistema não consultar o ERP a cada acesso e evitar sobrecarga.
//
// Uso: cd backend && node src/jobs/syncFinanceiroMensal.js
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  console.log('[sync-financeiro] início', new Date().toISOString());
  try {
    await erp.sincronizarTodasFinanceiro();
    console.log('[sync-financeiro] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-financeiro] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
