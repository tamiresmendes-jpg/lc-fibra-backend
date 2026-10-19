// Execução pontual: recalcula SÓ a NF-e 55 (matriz + filiais, com quebra por
// natureza) de um período já salvo na Análise Fiscal, sem refazer NFSe/NFCOM/
// Telecom. Ritmo lento (1 página por vez, 3s de pausa). Rodar só com
// autorização — o normal é a rotina das 4h15 manter isso atualizado.
//
// Uso: cd backend && node src/jobs/atualizarNfe55Cache.js 2026-10-01 2026-10-17
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  const [dataInicio, dataFim] = process.argv.slice(2);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim || '')) {
    console.error('Uso: node src/jobs/atualizarNfe55Cache.js AAAA-MM-DD AAAA-MM-DD');
    process.exit(1);
  }
  console.log('[nfe55-cache] início', dataInicio, dataFim, new Date().toISOString());
  try {
    const r = await erp.atualizarNfe55NoCache(dataInicio, dataFim);
    console.log('[nfe55-cache] concluído —', r.caches, 'cache(s) atualizado(s)', new Date().toISOString());
  } catch (e) {
    console.error('[nfe55-cache] falhou (nada foi gravado):', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
