// Rotina diária (cron de madrugada): sincroniza o Financeiro Mensal (Contas a
// Receber) no cache, buscando no ERP HubSoft uma vez por dia — para o
// sistema não consultar o ERP a cada acesso e evitar sobrecarga.
//
// Depois, no MESMO horário, atualiza as tabelas da Análise Financeira
// (faturas e contas a pagar, janela padrão ou a agendada pela tela). Não há
// consulta ao ERP fora deste horário.
//
// Uso: cd backend && node src/jobs/syncFinanceiroMensal.js
require('dotenv').config();
const erp = require('../routes/erp');
const db = require('../config/database');
const { sincronizarNoturno } = require('../services/finSync');

(async () => {
  console.log('[sync-financeiro] início', new Date().toISOString());
  try {
    await erp.sincronizarTodasFinanceiro();
    console.log('[sync-financeiro] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-financeiro] falhou:', e.message);
  }

  try {
    console.log('[sync-analise-financeira] início', new Date().toISOString());
    const empresas = await db.all('SELECT id FROM empresas');
    for (const emp of empresas) await sincronizarNoturno(emp.id);
    console.log('[sync-analise-financeira] concluído', new Date().toISOString());
  } catch (e) {
    console.error('[sync-analise-financeira] falhou:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
