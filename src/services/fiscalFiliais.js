// Sincroniza as NF-e 55 das FILIAIS (não a matriz) para fiscal_notas/fiscal_itens.
// Só roda sob demanda (botão na Análise Fiscal) — nunca por agendamento — e com
// pausa entre filiais, para não repetir o 429/queda do ERP.
const db = require('../config/database');
const hubsoft = require('./hubsoft');

const MATRIZ = '08407644000100';
const CFOPS_COMODATO = ['5908', '5909', '6908', '6909', '1908', '1909', '2908', '2909'];
const num = (v) => Number(v) || 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Venda de mercadoria de terceiros (5102/6102) = venda de e-book, só na matriz.
const CFOPS_VENDA = ['5102', '6102'];

// Categoria da nota (NF-e 55) e alerta quando natureza e CFOP não combinam.
function classificar(natureza, tipo, cfops) {
  const nat = String(natureza || '').toUpperCase();
  const naturezaComodato = nat.includes('COMODATO');
  const naturezaVenda = nat.includes('VENDA');
  const cfopComodato = cfops.some(c => CFOPS_COMODATO.includes(c));
  const cfopVenda = cfops.some(c => CFOPS_VENDA.includes(c));
  let categoria = 'Outras naturezas';
  if (naturezaComodato || (!naturezaVenda && cfopComodato)) categoria = tipo === 'Entrada' ? 'Comodato — retorno' : 'Comodato — saída';
  else if (naturezaVenda || cfopVenda) categoria = 'Venda — e-book';
  let alerta = null;
  if (cfopComodato && cfopVenda) {
    alerta = `Nota mista: itens de venda e de comodato na mesma nota (${cfops.join('/')})`;
  } else if (naturezaComodato !== cfopComodato && !(naturezaVenda && cfopVenda)) {
    alerta = naturezaComodato
      ? 'Natureza de comodato, mas CFOP de outra operação'
      : `Natureza "${natureza}" com CFOP de comodato (${cfops.join('/')})`;
  }
  return { categoria, alerta };
}

// Categoria de uma nota como vem da API (CFOPs lidos dos itens).
function classificarNota(n) {
  const produtos = Array.isArray(n.produtos) ? n.produtos : [];
  const cfops = [...new Set(produtos.map(p => String(p.cfop || '')).filter(Boolean))];
  return classificar(n.natureza_operacao, n.tipo_nota?.descricao || null, cfops);
}

// Filiais (CNPJ raiz da matriz, exceto a própria) — ficam em fiscal_empresas.
function listarFiliais() {
  return db.all(`SELECT cnpj, nome, cidade FROM fiscal_empresas WHERE cnpj LIKE '08407644%' AND cnpj <> $1 ORDER BY ordem`, [MATRIZ]);
}

async function gravarNota(cnpj, n) {
  const idOrigem = String(n.id_nfe);
  const id = `55:${cnpj}:${idOrigem}`;
  const produtos = Array.isArray(n.produtos) ? n.produtos : [];
  const cfops = [...new Set(produtos.map(p => String(p.cfop || '')).filter(Boolean))];
  const tipo = n.tipo_nota?.descricao || null;
  const { categoria, alerta } = classificar(n.natureza_operacao, tipo, cfops);

  await db.run(
    `INSERT INTO fiscal_notas (id, cnpj, modelo, id_origem, numero, serie, chave, data_emissao, natureza, tipo_operacao, status, valor, cfops, categoria, alerta, sincronizado_em)
     VALUES ($1,$2,'55',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))
     ON CONFLICT (id) DO UPDATE SET numero=EXCLUDED.numero, serie=EXCLUDED.serie, chave=EXCLUDED.chave,
       data_emissao=EXCLUDED.data_emissao, natureza=EXCLUDED.natureza, tipo_operacao=EXCLUDED.tipo_operacao,
       status=EXCLUDED.status, valor=EXCLUDED.valor, cfops=EXCLUDED.cfops, categoria=EXCLUDED.categoria,
       alerta=EXCLUDED.alerta, sincronizado_em=EXCLUDED.sincronizado_em`,
    [id, cnpj, idOrigem, n.numero_nf || null, n.serie || null, n.chave || null,
      n.data_emissao || null, n.natureza_operacao || null, tipo, n.status || null,
      num(n.valor ?? n.valor_nota_fiscal ?? n.valor_nota), cfops.join(','), categoria, alerta]
  );

  await db.run('DELETE FROM fiscal_itens WHERE nota_id = $1', [id]);
  for (let i = 0; i < produtos.length; i++) {
    const p = produtos[i];
    await db.run(
      `INSERT INTO fiscal_itens (id, nota_id, produto, codigo, ncm, cfop, unidade, quantidade, valor_unitario, valor, tributacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [`${id}#${i}`, id, p.produto || null, p.c_prod || null, p.ncm || null, p.cfop || null, p.u_com || null,
        num(p.q_com), num(p.v_un_com), num(p.v_prod), p.tributacao ? JSON.stringify(p.tributacao) : null]
    );
  }
}

// Sincroniza as filiais no período. `cnpjs` opcional restringe a algumas filiais.
async function sincronizarFiliais(dataInicio, dataFim, cnpjs) {
  const filiais = (await db.all(
    `SELECT cnpj, nome FROM fiscal_empresas WHERE cnpj LIKE '08407644%' AND cnpj <> $1 ORDER BY ordem`, [MATRIZ]
  )).filter(f => !cnpjs || cnpjs.includes(f.cnpj));

  const resultado = [];
  for (let i = 0; i < filiais.length; i++) {
    const f = filiais[i];
    let lidas = 0, erro = null;
    try {
      await hubsoft.varrerNfe55({ documento: f.cnpj, dataInicio, dataFim }, async (lote) => {
        for (const n of lote) { await gravarNota(f.cnpj, n); lidas++; }
      });
    } catch (e) { erro = e.message; }
    resultado.push({ cnpj: f.cnpj, nome: f.nome, notas: lidas, erro });
    console.log(`[fiscal-filiais] ${f.nome}: ${lidas} notas${erro ? ' — ERRO ' + erro : ''}`);
    if (i < filiais.length - 1) await sleep(3000);
  }
  return resultado;
}

module.exports = { sincronizarFiliais, classificarNota, listarFiliais, MATRIZ };
