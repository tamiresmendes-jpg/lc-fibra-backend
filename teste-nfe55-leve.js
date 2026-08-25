// Teste LEVE: busca apenas NFe55 de 24/08/2026
require('dotenv').config();
const db = require('./src/config/database');
const hubsoft = require('./src/services/hubsoft');

const num = (v) => Number(v) || 0;
function notaVazia() {
  return { total: 0, cancelada: 0, valor_total: 0, icms: 0, iss: 0, pis: 0, cofins: 0, csll: 0, irrf: 0, inss: 0, fust: 0, funttel: 0 };
}
function somaImpostos(acc, n, mapa) {
  for (const [chaveAcc, chaveNota] of Object.entries(mapa)) {
    acc[chaveAcc] = (acc[chaveAcc] || 0) + num(n[chaveNota]);
  }
}

(async () => {
  console.log('[teste-nfe55] INÍCIO', new Date().toISOString());
  try {
    const dataInicio = '2026-08-24';
    const dataFim = '2026-08-24';
    console.log(`[teste-nfe55] Buscando NFe55 de ${dataInicio} a ${dataFim}`);

    const empresas = await db.all('SELECT id, nome, cnpj FROM empresas LIMIT 1');
    if (!empresas.length) {
      console.error('[teste-nfe55] Nenhuma empresa encontrada!');
      process.exit(1);
    }

    const emp = empresas[0];
    console.log(`[teste-nfe55] Processando empresa: ${emp.nome}`);

    const documento = (emp.cnpj || '').replace(/\D/g, '');
    const tipos = { nfe55: notaVazia(), nfe55_comodato: notaVazia() };
    let totalProcessado = 0;

    await hubsoft.varrerNfe55({ documento, dataInicio, dataFim }, async (lote) => {
      console.log(`[teste-nfe55] Lote recebido com ${lote.length} notas`);
      for (const n of lote) {
        totalProcessado++;

        // LOG DE DEBUG IMPORTANTE
        console.log(`[DEBUG-NFe55] Nota #${totalProcessado}: natureza_operacao="${n.natureza_operacao || 'VAZIO'}"`);

        const isComodato = String(n.natureza_operacao || '').toUpperCase().includes('COMODATO');
        const tipoNota = isComodato ? 'nfe55_comodato' : 'nfe55';

        tipos[tipoNota].total++;
        if (String(n.status || '').includes('cancel')) tipos[tipoNota].cancelada++;
        tipos[tipoNota].valor_total += num(n.valor_nota_fiscal ?? n.valor_nota ?? n.valor);
        somaImpostos(tipos[tipoNota], n, { icms: 'valor_icms', pis: 'valor_pis', cofins: 'valor_cofins' });

        if (isComodato) {
          const cnpjRemetente = String(n.emitente?.cnpj || n.remetente?.cnpj || n.cnpj_emitente || n.cnpj_remetente || n.cnpj || '').replace(/\D/g, '');
          const filial = n.emitente?.nome || n.remetente?.nome || n.nome_emitente || n.filial || n.nome_filial || 'Sem filial';
          const chaveFilial = `${filial}|${cnpjRemetente}`;
          if (!tipos[tipoNota].filiais) tipos[tipoNota].filiais = {};
          tipos[tipoNota].filiais[chaveFilial] = (tipos[tipoNota].filiais[chaveFilial] || 0) + 1;
        }
      }
    });

    console.log(`[teste-nfe55] ✅ RESULTADO:`);
    console.log(`[teste-nfe55] Total processado: ${totalProcessado}`);
    console.log(`[teste-nfe55] NFe55 (Vendas E-books): ${tipos.nfe55.total} notas | Valor: R$ ${tipos.nfe55.valor_total.toFixed(2)}`);
    console.log(`[teste-nfe55] NFe55 Comodato: ${tipos.nfe55_comodato.total} notas | Valor: R$ ${tipos.nfe55_comodato.valor_total.toFixed(2)}`);

    if (tipos.nfe55_comodato.filiais) {
      console.log(`[teste-nfe55] Filiais de comodato:`, tipos.nfe55_comodato.filiais);
    }

  } catch (e) {
    console.error('[teste-nfe55] ERRO:', e.message);
  } finally {
    setTimeout(() => process.exit(0), 500);
  }
})();
