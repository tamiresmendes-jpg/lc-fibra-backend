// Rotina diária (cron às 4h45): sincroniza a Análise de Serviços (NFSe) no
// cache, buscando no ERP HubSoft uma vez por dia — a tela NUNCA consulta o
// HubSoft na hora do clique, só lê o que já está salvo em
// erp_servicos_nfse_cache.
//
// Uso: cd backend && node src/jobs/syncAnaliseServicosNfse.js
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  console.log('[sync-servicos-nfse] início', new Date().toISOString());
  try {
    await erp.sincronizarServicosNfse();
    console.log('[sync-servicos-nfse] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-servicos-nfse] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
