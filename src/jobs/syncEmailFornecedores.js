// Rotina periódica (cron sugerido: a cada 30min): lê a caixa de e-mail de
// fornecedores (IMAP) de cada empresa com a integração ativa, extrai boletos/
// notas fiscais anexados em PDF e registra em contas_pagar_fornecedores.
// Só LEITURA na caixa de entrada — não apaga, move nem marca e-mail como lido.
//
// Uso: cd backend && node src/jobs/syncEmailFornecedores.js
require('dotenv').config();
const { sincronizarTodasEmpresas } = require('../utils/emailFornecedoresSync');

(async () => {
  console.log('[sync-email-fornecedores] início', new Date().toISOString());
  try {
    const resultados = await sincronizarTodasEmpresas();
    console.log('[sync-email-fornecedores] concluído', JSON.stringify(resultados));
  } catch (e) {
    console.error('[sync-email-fornecedores] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
