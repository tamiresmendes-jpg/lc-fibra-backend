// PDF/Excel da aba "Comparação" (Análise fiscal comparativa + Combos LC+
// Livros por modelo + Comparativo entre modelos) — pedido da usuária
// 02/10/2026: essa aba não tinha nenhuma opção de download, só a tela.
// Reaproveita EXATAMENTE a mesma lógica dos componentes React
// (AnaliseComparativaFiscal/TabelaCombosPorModelo/ComparativoModelos em
// ComposicaoPlanos.jsx) pra nunca divergir do que ela vê na tela.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => `${(Number(v) || 0).toFixed(2)}%`;

const COMBOS_DEF = [
  { nome: 'Bronze', livros: 2, audio: 0 },
  { nome: 'Prata', livros: 3, audio: 0 },
  { nome: 'Ouro', livros: 4, audio: 0 },
  { nome: 'Safira', livros: 4, audio: 1 },
  { nome: 'Diamante', livros: 4, audio: 2 },
];

function montarModelos(modelosPersonalizados) {
  const idBase50 = modelosPersonalizados.find((m) => m.nome === 'Base 50%')?.id;
  // Base 55% tirado da comparação a pedido da usuária 02/10/2026.
  return [
    { titulo: 'Modelo atual', id: 'atual' },
    idBase50 && { titulo: 'Base 50%', id: idBase50 },
  ].filter(Boolean);
}

function categoriaDoItem(nomeBruto) {
  const nome = String(nomeBruto || '').trim();
  if (/^internet/i.test(nome)) return 'scm';
  if (/^livro/i.test(nome) || /audio/i.test(nome)) return 'la';
  return 'sva';
}

function resumoDoModelo(planos, modeloId) {
  const planosModelo = planos.filter((p) => (p.modelo || 'novo') === modeloId);
  const faturamento = { scm: 0, la: 0, sva: 0 };
  const impostos = { scm: 0, la: 0, sva: 0 };
  for (const p of planosModelo) {
    const clientes = p.quantidade_clientes || 0;
    for (const item of p.itens) {
      const cat = categoriaDoItem(item.nome);
      faturamento[cat] += (item.valor_item || 0) * clientes;
      impostos[cat] += (item.impostos_item || 0) * clientes;
    }
  }
  const faturamentoTotal = faturamento.scm + faturamento.la + faturamento.sva;
  const impostosTotal = impostos.scm + impostos.la + impostos.sva;
  return {
    faturamento, impostos, faturamentoTotal, impostosTotal,
    resultadoLiquido: faturamentoTotal - impostosTotal,
    pctImposto: faturamentoTotal > 0 ? (impostosTotal / faturamentoTotal) * 100 : 0,
  };
}

function valorComboNoModelo(planosDoModelo, combo) {
  for (const p of planosDoModelo) {
    const livro = p.itens.find((i) => !/audio/i.test(i.nome) && /^livro/i.test(String(i.nome || '').trim()));
    const audio = p.itens.find((i) => /audio/i.test(i.nome));
    const qtdLivro = livro?.quantidade || 0;
    const qtdAudio = audio?.quantidade || 0;
    if (qtdLivro === combo.livros && qtdAudio === combo.audio) {
      const unitLivro = Number(livro?.valor_unitario) || 0;
      const unitAudio = combo.audio > 0 ? Number(audio?.valor_unitario) || 0 : null;
      const total = unitLivro * combo.livros + (unitAudio || 0) * combo.audio;
      return { unitLivro, unitAudio, total };
    }
  }
  return null;
}

function partesDoPlano(p) {
  if (!p) return null;
  const internet = p.itens.find((i) => i.percentual_fixo != null || /^internet/i.test(String(i.nome || '').trim()));
  const livroAudio = p.itens
    .filter((i) => /^livro/i.test(String(i.nome || '').trim()) || /audio/i.test(i.nome))
    .reduce((s, i) => s + i.valor_item, 0);
  const valorInternet = internet?.valor_item || 0;
  const sva = Math.max(0, (Number(p.valor_total_composicao) || 0) - valorInternet - livroAudio);
  return { total: p.preco_venda, internet: valorInternet, livroAudio, sva };
}

function temAudio(planos, modeloId) {
  return planos.some((p) => p.modelo === modeloId && p.itens.some((i) => /audio/i.test(i.nome)));
}

function modelosComparadosParaComparativo(planos, modelosPersonalizados) {
  const idBase50 = modelosPersonalizados.find((m) => m.nome === 'Base 50%')?.id;
  // Base 55% tirado da comparação a pedido da usuária 02/10/2026.
  const planosAtual = planos.filter((p) => (p.modelo || 'novo') === 'atual');
  if (!idBase50 || planosAtual.length === 0) return null;
  const achar = (nome, modeloId) => (modeloId ? planos.find((p) => p.modelo === modeloId && p.nome === nome) : null);
  const modelosComparados = [
    { titulo: 'Modelo atual', achar: (nome) => achar(nome, 'atual'), temAudio: temAudio(planos, 'atual') },
    idBase50 && { titulo: 'Base 50%', achar: (nome) => achar(nome, idBase50), temAudio: temAudio(planos, idBase50) },
  ].filter(Boolean);
  return { planosAtual, modelosComparados };
}

const CATEGORIAS = [
  { chave: 'scm', titulo: 'SCM (Internet)' },
  { chave: 'la', titulo: 'LC+ Livros' },
  { chave: 'sva', titulo: 'SVA' },
];

const ESTILO = `
  @page{margin:8mm 8mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:9px}
  .cabecalho{background:#4f46e5;color:#fff;padding:10px 12px;margin-bottom:10px}
  .cabecalho h1{font-size:15px}
  .cabecalho .sub{font-size:9px;opacity:.9;margin-top:3px}
  h2{font-size:12px;margin:14px 0 4px}
  .legenda{font-size:8.5px;color:#64748b;margin-bottom:8px;max-width:640px}
  table{width:100%;border-collapse:collapse;margin-bottom:6px}
  th,td{border:1px solid #cbd5e1;padding:3px 5px;text-align:right;white-space:nowrap}
  th{background:#eef2ff;color:#4f46e5;text-transform:uppercase;font-size:7px}
  td.esq,th.esq{text-align:left;white-space:normal}
  .sep{border-left:2px solid #94a3b8}
  tr.total td{font-weight:700;background:#f8fafc}
  .sub{color:#94a3b8;font-size:7.5px}
  .cartoes{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
  .cartao{border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;min-width:160px;font-size:9px}
  .cartao strong{font-size:10px}
  .cartao div{margin:2px 0}
  .neg{color:#dc2626}
  .pos{color:#16a34a}
  .delta{font-size:8.5px;padding:3px 5px;border-radius:4px;font-weight:700;margin-top:4px;display:inline-block}
  .delta.ruim{background:#fef2f2;color:#dc2626}
  .delta.bom{background:#f0fdf4;color:#16a34a}
  .rodape{margin-top:10px;font-size:8px;color:#94a3b8;text-align:center}
`;

// Reaproveitada também no relatório geral (planos-composicao.pdf) — pedido
// da usuária 02/10/2026 ("incluir os combos dos livros em cada modelo").
function montarHtmlSecaoCombos(planos, modelosPersonalizados) {
  const modelos = montarModelos(modelosPersonalizados);
  if (modelos.length === 0) return '';
  const planosPorModelo = modelos.map((m) => ({ ...m, planos: planos.filter((p) => (p.modelo || 'novo') === m.id) }));
  const linhasCombo = COMBOS_DEF.map((combo) => `<tr><td class="esq">${esc(combo.nome)} <span class="sub">(${combo.livros} livro${combo.livros > 1 ? 's' : ''}${combo.audio > 0 ? ` + ${combo.audio} audio` : ''})</span></td>${planosPorModelo.map((m) => {
    const v = valorComboNoModelo(m.planos, combo);
    return `<td class="sep">${v == null ? '—' : `${fmtBRL(v.unitLivro)}×${combo.livros}${v.unitAudio != null ? ` + ${fmtBRL(v.unitAudio)}×${combo.audio}` : ''} = <strong>${fmtBRL(v.total)}</strong>`}</td>`;
  }).join('')}</tr>`).join('');
  return `
    <h2>Combos LC+ Livros por modelo</h2>
    <table>
      <thead><tr><th class="esq">Combo</th>${planosPorModelo.map((m) => `<th class="sep">${esc(m.titulo)}</th>`).join('')}</tr></thead>
      <tbody>${linhasCombo}</tbody>
    </table>`;
}

function montarHtmlComparacao(planos, modelosPersonalizados, { nomeUsuario } = {}) {
  const modelos = montarModelos(modelosPersonalizados);
  const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const cabecalho = `<div class="cabecalho"><h1>Kronos — Comparação entre Modelos</h1><div class="sub">Gerado por ${esc(nomeUsuario || '—')} em ${esc(geradoEm)}</div></div>`;

  if (modelos.length === 0) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>${cabecalho}<p>Nenhum modelo cadastrado ainda.</p></body></html>`;
  }

  // ── Análise fiscal comparativa ──
  const resumos = modelos.map((m) => ({ ...m, r: resumoDoModelo(planos, m.id) }));
  const base = resumos[0];
  const cartoes = resumos.map((m, idx) => {
    const deltaImpostos = idx === 0 ? null : m.r.impostosTotal - base.r.impostosTotal;
    const deltaPct = idx === 0 || !base.r.impostosTotal ? null : (deltaImpostos / base.r.impostosTotal) * 100;
    return `<div class="cartao">
      <strong>${esc(m.titulo)}</strong>
      <div>Faturamento: <strong>${fmtBRL(m.r.faturamentoTotal)}</strong></div>
      <div>Impostos: <strong class="neg">${fmtBRL(m.r.impostosTotal)}</strong> <span class="sub">(${fmtPct(m.r.pctImposto)} do faturamento)</span></div>
      <div>Resultado líquido: <strong class="pos">${fmtBRL(m.r.resultadoLiquido)}</strong></div>
      ${idx === 0
        ? `<div class="sub">Referência</div>`
        : `<div class="delta ${deltaImpostos > 0 ? 'ruim' : 'bom'}">${deltaImpostos > 0 ? '▲' : '▼'} ${fmtBRL(Math.abs(deltaImpostos))} de imposto (${deltaPct > 0 ? '+' : ''}${fmtPct(deltaPct)}) vs ${esc(base.titulo)}</div>`}
    </div>`;
  }).join('');

  const linhasCategoria = CATEGORIAS.map(({ chave, titulo }) => `<tr><td class="esq">${titulo}</td>${resumos.map((m) => {
    const fat = m.r.faturamento[chave];
    const imp = m.r.impostos[chave];
    const pct = fat > 0 ? (imp / fat) * 100 : 0;
    return `<td class="sep">${fmtBRL(fat)}</td><td>${fmtBRL(imp)}</td><td>${fmtPct(pct)}</td>`;
  }).join('')}</tr>`).join('');
  const linhaTotalFiscal = `<tr class="total"><td class="esq">Total Geral</td>${resumos.map((m) => `<td class="sep">${fmtBRL(m.r.faturamentoTotal)}</td><td>${fmtBRL(m.r.impostosTotal)}</td><td>${fmtPct(m.r.pctImposto)}</td>`).join('')}</tr>`;

  const secaoFiscal = `
    <h2>Análise fiscal comparativa</h2>
    <p class="legenda">Quanto mais valor concentrado em SCM (Internet, carga tributária alta) em vez de LC+ Livros (sem imposto), maior o imposto total pago. As diferenças usam "${esc(base.titulo)}" como referência.</p>
    <div class="cartoes">${cartoes}</div>
    <table>
      <thead>
        <tr><th class="esq">Categoria</th>${resumos.map((m) => `<th colspan="3" class="sep">${esc(m.titulo)}</th>`).join('')}</tr>
        <tr>${resumos.map(() => `<th class="sep">Faturamento</th><th>Impostos</th><th>% efetivo</th>`).join('')}</tr>
      </thead>
      <tbody>${linhasCategoria}${linhaTotalFiscal}</tbody>
    </table>`;

  // ── Combos LC+ Livros por modelo ──
  const secaoCombos = montarHtmlSecaoCombos(planos, modelosPersonalizados);

  // ── Comparativo entre modelos ──
  const dadosComparativo = modelosComparadosParaComparativo(planos, modelosPersonalizados);
  let secaoComparativo = '';
  if (dadosComparativo) {
    const { planosAtual, modelosComparados } = dadosComparativo;
    const linhasComp = planosAtual.map((pAtual) => `<tr><td class="esq">${esc(pAtual.nome)}</td>${modelosComparados.map((m) => {
      const partes = partesDoPlano(m.achar(pAtual.nome));
      return `<td class="sep">${partes ? fmtBRL(partes.total) : '—'}</td><td>${partes ? fmtBRL(partes.internet) : '—'}</td><td>${partes ? fmtBRL(partes.livroAudio) : '—'}</td><td>${partes ? fmtBRL(partes.sva) : '—'}</td>`;
    }).join('')}</tr>`).join('');
    secaoComparativo = `
      <h2>Comparativo entre modelos</h2>
      <table>
        <thead>
          <tr><th class="esq">Plano</th>${modelosComparados.map((m) => `<th colspan="4" class="sep">${esc(m.titulo)}</th>`).join('')}</tr>
          <tr>${modelosComparados.map((m) => `<th class="sep">Total</th><th>Internet</th><th>${m.temAudio ? 'Livro+Audio' : 'Livro'}</th><th>SVA</th>`).join('')}</tr>
        </thead>
        <tbody>${linhasComp}</tbody>
      </table>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    ${cabecalho}
    ${secaoFiscal}
    ${secaoCombos}
    ${secaoComparativo}
    <div class="rodape">Kronos — Análise de Composição de Planos — gerado automaticamente</div>
  </body></html>`;
}

async function gerarPDFComparacao(planos, modelosPersonalizados, opts) {
  return htmlParaPdf(montarHtmlComparacao(planos, modelosPersonalizados, opts), null, { landscape: true });
}

// ── Excel: uma aba por seção, mesmos números do PDF/tela ──────────────────

function montarLinhasAnaliseFiscalXlsx(planos, modelosPersonalizados) {
  const modelos = montarModelos(modelosPersonalizados);
  if (modelos.length === 0) return [];
  const resumos = modelos.map((m) => ({ ...m, r: resumoDoModelo(planos, m.id) }));
  const linhas = CATEGORIAS.map(({ chave, titulo }) => {
    const linha = { Categoria: titulo };
    for (const m of resumos) {
      const fat = m.r.faturamento[chave];
      const imp = m.r.impostos[chave];
      linha[`${m.titulo} - Faturamento`] = fat;
      linha[`${m.titulo} - Impostos`] = imp;
      linha[`${m.titulo} - % efetivo`] = Number((fat > 0 ? (imp / fat) * 100 : 0).toFixed(2));
    }
    return linha;
  });
  const totalLinha = { Categoria: 'Total Geral' };
  for (const m of resumos) {
    totalLinha[`${m.titulo} - Faturamento`] = m.r.faturamentoTotal;
    totalLinha[`${m.titulo} - Impostos`] = m.r.impostosTotal;
    totalLinha[`${m.titulo} - % efetivo`] = Number(m.r.pctImposto.toFixed(2));
  }
  linhas.push(totalLinha, {});
  for (const m of resumos) {
    linhas.push({
      Categoria: `Resultado líquido — ${m.titulo}`,
      'Faturamento Total': m.r.faturamentoTotal,
      'Impostos Total': m.r.impostosTotal,
      'Resultado líquido': m.r.resultadoLiquido,
    });
  }
  return linhas;
}

function montarLinhasCombosXlsx(planos, modelosPersonalizados) {
  const modelos = montarModelos(modelosPersonalizados);
  if (modelos.length === 0) return [];
  const planosPorModelo = modelos.map((m) => ({ ...m, planos: planos.filter((p) => (p.modelo || 'novo') === m.id) }));
  return COMBOS_DEF.map((combo) => {
    const linha = { Combo: `${combo.nome} (${combo.livros} livro${combo.livros > 1 ? 's' : ''}${combo.audio > 0 ? ` + ${combo.audio} audio` : ''})` };
    for (const m of planosPorModelo) {
      const v = valorComboNoModelo(m.planos, combo);
      linha[m.titulo] = v == null ? '—' : v.total;
    }
    return linha;
  });
}

function montarLinhasComparativoXlsx(planos, modelosPersonalizados) {
  const dados = modelosComparadosParaComparativo(planos, modelosPersonalizados);
  if (!dados) return [];
  const { planosAtual, modelosComparados } = dados;
  return planosAtual.map((pAtual) => {
    const linha = { Plano: pAtual.nome };
    for (const m of modelosComparados) {
      const partes = partesDoPlano(m.achar(pAtual.nome));
      linha[`${m.titulo} - Total`] = partes ? partes.total : '—';
      linha[`${m.titulo} - Internet`] = partes ? partes.internet : '—';
      linha[`${m.titulo} - ${m.temAudio ? 'Livro+Audio' : 'Livro'}`] = partes ? partes.livroAudio : '—';
      linha[`${m.titulo} - SVA`] = partes ? partes.sva : '—';
    }
    return linha;
  });
}

module.exports = {
  gerarPDFComparacao,
  montarHtmlComparacao,
  montarHtmlSecaoCombos,
  montarLinhasAnaliseFiscalXlsx,
  montarLinhasCombosXlsx,
  montarLinhasComparativoXlsx,
};
