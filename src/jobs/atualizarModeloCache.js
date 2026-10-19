// Execução pontual: recalcula SÓ UM modelo de nota (nfe55 ou nfcom) de um
// período já salvo na Análise Fiscal, com a quebra por natureza/serviço, sem
// refazer os outros modelos. Ritmo lento (1 página por vez, 3s de pausa).
// Rodar só com autorização — o normal é a rotina das 4h15 manter isso atualizado.
//
// Uso: cd backend && node src/jobs/atualizarModeloCache.js nfcom 2026-10-01 2026-10-17
//      (modelos: nfe55, nfcom, nfse, telecom0; "nfcom-grupos" só reagrupa sem consultar o ERP)
require('dotenv').config();
const erp = require('../routes/erp');

(async () => {
  const [modelo, dataInicio, dataFim] = process.argv.slice(2);
  if (!modelo || !/^\d{4}-\d{2}-\d{2}$/.test(dataInicio || '') || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim || '')) {
    console.error('Uso: node src/jobs/atualizarModeloCache.js MODELO AAAA-MM-DD AAAA-MM-DD');
    process.exit(1);
  }
  console.log(`[${modelo}-cache] início`, dataInicio, dataFim, new Date().toISOString());
  try {
    // nfcom-grupos: só reorganiza os grupos da NFCOM já salvos (não consulta o ERP)
    const r = modelo === 'nfcom-grupos'
      ? await erp.reagruparNfcomNoCache(dataInicio, dataFim)
      : await erp.atualizarModeloNoCache(modelo, dataInicio, dataFim);
    console.log(`[${modelo}-cache] concluído —`, r.caches, 'cache(s) atualizado(s)', new Date().toISOString());
  } catch (e) {
    console.error(`[${modelo}-cache] falhou (nada foi gravado):`, e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
