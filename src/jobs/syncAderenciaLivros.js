// Rotina diária (cron às 5h): calcula a aderência de faturamento dos planos
// com "LC+ Livros" — por plano, dos últimos 3 meses fechados, quantas
// faturas venceram com o cliente bloqueado/inativo/cancelado (não recebe
// nota, mesmo já tendo o livro entregue). Roda de madrugada porque varre as
// faturas dos últimos meses inteiros (mais pesado que os outros syncs).
//
// Uso: cd backend && node src/jobs/syncAderenciaLivros.js
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  console.log('[sync-aderencia-livros] início', new Date().toISOString());
  try {
    await erp.sincronizarAderenciaLivros();
    console.log('[sync-aderencia-livros] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-aderencia-livros] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
