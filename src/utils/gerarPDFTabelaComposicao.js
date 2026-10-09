// PDF da "Tabela" de Composição de Planos (planos nas linhas, itens do
// catálogo nas colunas) — pedido da usuária 29/09/2026: a mesma grade
// compacta que ela vê na tela, pra baixar/imprimir/enviar. Reaproveita a
// MESMA lógica de colunas/combo do front-end (ComposicaoPlanos.jsx) pra não
// divergir da tela — ver comentário de 29/09/2026 lá sobre por que
// Livro/E-book é identificado só pelo NOME (Audio-book e Revista dividem o
// mesmo tipo de catálogo, então a flag absorve_restante sozinha não separa).
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => (v == null ? '—' : `${Number(v).toFixed(1)}%`);
// Alíquota de imposto precisa de 2 casas (ex.: PIS 0.65%) — com 1 casa
// arredondava pra "0.7%", parecendo uma alíquota diferente da configurada
// (achado 02/10/2026, mesma precisão já usada no relatório por plano).
const fmtPctImposto = (v) => (v == null ? '—' : `${Number(v).toFixed(2)}%`);

// Ordem pedida pela usuária 29/09/2026: Internet primeiro, Livro/E-book e
// Audio-book logo depois (bloco de livros), só então os SVA de verdade.
const ORDEM_COLUNAS = ['Watch TV', 'HBO Max', 'Telemedicina', 'ExitLag', 'IP Dedicado', 'Roteador Adicional Mesh', 'Revista'];
function indiceOrdemColuna(coluna) {
  if (coluna.papel === 0) return -3;
  if (coluna.ehAudio) return -2;
  if (coluna.ehLivro) return -1;
  const i = ORDEM_COLUNAS.indexOf(String(coluna.nome || '').trim());
  return i === -1 ? ORDEM_COLUNAS.length : i;
}

function montarColunas(itensCatalogo) {
  return itensCatalogo
    .map((i) => {
      const ehAudio = /audio/i.test(i.nome);
      const ehLivro = !ehAudio && /^livro/i.test(i.nome);
      return {
        nome: i.nome, itemId: i.id,
        papel: i.percentual_fixo != null ? 0 : ehLivro ? 2 : 1,
        ehLivro, ehAudio, usaQtdValor: ehLivro || ehAudio,
      };
    })
    .sort((a, b) => indiceOrdemColuna(a) - indiceOrdemColuna(b));
}

function acharItemDoPlano(itens, coluna) {
  return itens.find((i) => (i.item_id && coluna.itemId && i.item_id === coluna.itemId) || (!i.item_id && i.nome === coluna.nome));
}

// Combos Bronze/Prata/Ouro/Safira/Diamante do modelo sendo exportado — pedido
// da usuária 02/10/2026 ("trazer os combos pra tabela de cada modelo"). Mesma
// lógica da aba Comparação (gerarPDFComparacao.js/ComposicaoPlanos.jsx), só
// que aqui é 1 modelo só (o da aba filtrada), não os 3 lado a lado.
const COMBOS_DEF = [
  { nome: 'Bronze', livros: 2, audio: 0 },
  { nome: 'Prata', livros: 3, audio: 0 },
  { nome: 'Ouro', livros: 4, audio: 0 },
  { nome: 'Safira', livros: 4, audio: 1 },
  { nome: 'Diamante', livros: 4, audio: 2 },
];
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
function rotuloCombo(combo) {
  return `${combo.nome} (${combo.livros} livro${combo.livros > 1 ? 's' : ''}${combo.audio > 0 ? ` + ${combo.audio} audio` : ''})`;
}

function celulaItem(plano, coluna) {
  const item = acharItemDoPlano(plano.itens, coluna);
  if (!item || (!item.quantidade && !item.valor_unitario)) return '—';
  if (coluna.usaQtdValor) return `${fmtBRL(item.valor_unitario)} <span class="qtd">×${item.quantidade}</span>`;
  return fmtBRL(item.valor_unitario);
}

const ESTILO = `
  @page{margin:8mm 8mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:9px}
  .cabecalho{background:#4f46e5;color:#fff;padding:10px 12px;margin-bottom:6px}
  .cabecalho h1{font-size:15px}
  .cabecalho .sub{font-size:9px;opacity:.9;margin-top:3px}
  table{width:100%;border-collapse:collapse}
  th,td{border:1px solid #cbd5e1;padding:3px 4px;text-align:right;white-space:nowrap}
  th{background:#eef2ff;color:#4f46e5;text-transform:uppercase;font-size:7px}
  td.esq,th.esq{text-align:left}
  td.centro{text-align:center}
  .sep{border-left:2px solid #94a3b8}
  tr.total td{font-weight:700;background:#f8fafc}
  .qtd{color:#94a3b8;font-size:7.5px}
  .rodape{margin-top:10px;font-size:8px;color:#94a3b8;text-align:center}
`;

function montarHtmlTabelaComposicao(planos, itensCatalogo, { modeloLabel, nomeUsuario } = {}) {
  const colunas = montarColunas(itensCatalogo);
  const colunaLivro = colunas.find((c) => c.ehLivro);
  const colunaAudio = colunas.find((c) => /audio/i.test(c.nome));
  const colunaInternet = colunas.find((c) => c.papel === 0);
  const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

  const totalPorCliente = (coluna) => !coluna ? 0 : planos.reduce((s, p) => {
    const item = acharItemDoPlano(p.itens, coluna);
    return s + (item?.quantidade || 0) * (p.quantidade_clientes || 0);
  }, 0);

  const linhas = planos.map((p, idx) => {
    const internet = colunaInternet ? acharItemDoPlano(p.itens, colunaInternet) : null;
    const livroItem = colunaLivro ? acharItemDoPlano(p.itens, colunaLivro) : null;
    const audioItem = colunaAudio ? acharItemDoPlano(p.itens, colunaAudio) : null;
    const valorLA = (livroItem?.valor_item || 0) + (audioItem?.valor_item || 0);
    const valorSva = Math.max(0, (Number(p.valor_total_composicao) || 0) - (internet?.valor_item || 0) - valorLA);
    // Modelo atual: SVA fica fora da composição — %SCM/%LC+Livros somam
    // 100% só entre si (base = SCM+Livros). Outros modelos: % sobre o Total.
    const ehAtual = p.modelo === 'atual';
    const baseComposicao = ehAtual ? (internet?.valor_item || 0) + valorLA : (Number(p.preco_venda) || 0);
    const pctInternet = baseComposicao > 0 ? (internet?.valor_item || 0) / baseComposicao * 100 : null;
    const pctLA = baseComposicao > 0 ? valorLA / baseComposicao * 100 : null;
    const pctSva = ehAtual ? null : (p.preco_venda > 0 ? valorSva / p.preco_venda * 100 : null);
    return `<tr>
    <td class="centro">${idx + 1}</td>
    <td class="esq">${esc(p.nome)}</td>
    <td>${esc(p.quantidade_clientes)}</td>
    <td>${esc(p.id_erp || '—')}</td>
    <td>${fmtBRL(p.preco_venda)}</td>
    <td>${fmtPct(pctInternet)}</td>
    <td>${fmtPct(pctLA)}</td>
    <td>${fmtPct(pctSva)}</td>
    <td>${fmtBRL(internet?.valor_item || 0)}</td>
    <td>${fmtBRL(valorLA)}</td>
    <td>${fmtBRL(valorSva)}</td>
    ${colunas.map((c) => `<td>${celulaItem(p, c)}</td>`).join('')}
    <td style="color:${p.total_bate_com_preco ? '#16a34a' : '#dc2626'}">${fmtBRL(p.valor_total_composicao)}</td>
    <td>${fmtBRL(p.total_impostos)}</td>
  </tr>`;
  }).join('');

  const linhaTotalClientes = (colunaLivro || colunaAudio) ? `<tr class="total">
    <td colspan="11" class="esq">Total (× clientes) →</td>
    ${colunas.map((c) => `<td>${c === colunaLivro ? totalPorCliente(colunaLivro) : c === colunaAudio ? totalPorCliente(colunaAudio) : ''}</td>`).join('')}
    <td></td>
    <td></td>
  </tr>` : '';

  // Faturamento total (× clientes) por categoria — SCM=Internet, LC+ Livros=
  // Livro/E-book+Audio-book, SVA=todo o resto.
  const faturamento = planos.reduce((acc, p) => {
    const internet = colunaInternet ? acharItemDoPlano(p.itens, colunaInternet) : null;
    const livroItem = colunaLivro ? acharItemDoPlano(p.itens, colunaLivro) : null;
    const audioItem = colunaAudio ? acharItemDoPlano(p.itens, colunaAudio) : null;
    const valorScm = internet?.valor_item || 0;
    const valorLA = (livroItem?.valor_item || 0) + (audioItem?.valor_item || 0);
    const valorSva = Math.max(0, (Number(p.valor_total_composicao) || 0) - valorScm - valorLA);
    const clientes = p.quantidade_clientes || 0;
    acc.scm += valorScm * clientes;
    acc.la += valorLA * clientes;
    acc.sva += valorSva * clientes;
    return acc;
  }, { scm: 0, la: 0, sva: 0 });
  const faturamentoTotalGeral = faturamento.scm + faturamento.la + faturamento.sva;

  // Impostos totais (× clientes) por categoria — mesma quebra do faturamento.
  const impostos = planos.reduce((acc, p) => {
    const internet = colunaInternet ? acharItemDoPlano(p.itens, colunaInternet) : null;
    const livroItem = colunaLivro ? acharItemDoPlano(p.itens, colunaLivro) : null;
    const audioItem = colunaAudio ? acharItemDoPlano(p.itens, colunaAudio) : null;
    const impostosScm = internet?.impostos_item || 0;
    const impostosLA = (livroItem?.impostos_item || 0) + (audioItem?.impostos_item || 0);
    const impostosSva = Math.max(0, (Number(p.total_impostos) || 0) - impostosScm - impostosLA);
    const clientes = p.quantidade_clientes || 0;
    acc.scm += impostosScm * clientes;
    acc.la += impostosLA * clientes;
    acc.sva += impostosSva * clientes;
    return acc;
  }, { scm: 0, la: 0, sva: 0 });
  const impostosTotalGeral = impostos.scm + impostos.la + impostos.sva;

  // Detalhamento de impostos por NOME (ICMS, PIS, COFINS...) dentro de cada categoria.
  function detalharImpostos(itensPorPlano) {
    const porNome = new Map();
    for (const p of planos) {
      const clientes = p.quantidade_clientes || 0;
      for (const item of itensPorPlano(p)) {
        for (const imp of item?.impostos || []) {
          const atual = porNome.get(imp.nome) || { nome: imp.nome, aliquota: imp.aliquota, valor: 0 };
          atual.valor += (imp.valor || 0) * clientes;
          porNome.set(imp.nome, atual);
        }
      }
    }
    return [...porNome.values()].filter((i) => i.valor > 0.004).sort((a, b) => b.valor - a.valor);
  }
  const impostosScmDetalhe = detalharImpostos((p) => [colunaInternet && acharItemDoPlano(p.itens, colunaInternet)].filter(Boolean));
  const impostosLADetalhe = detalharImpostos((p) => [colunaLivro && acharItemDoPlano(p.itens, colunaLivro), colunaAudio && acharItemDoPlano(p.itens, colunaAudio)].filter(Boolean));
  const impostosSvaDetalhe = detalharImpostos((p) => {
    const internet = colunaInternet && acharItemDoPlano(p.itens, colunaInternet);
    const livroItem = colunaLivro && acharItemDoPlano(p.itens, colunaLivro);
    const audioItem = colunaAudio && acharItemDoPlano(p.itens, colunaAudio);
    return p.itens.filter((i) => i !== internet && i !== livroItem && i !== audioItem);
  });
  // Impostos por item de SVA, na horizontal (1 linha por item, 1 coluna por
  // imposto) — pedido da usuária 02/10/2026, mesmo formato já usado no
  // resumo de faturamento dos Cards e trazido também pra Tabela.
  const svaPorItemMap = new Map();
  for (const p of planos) {
    const internet = colunaInternet && acharItemDoPlano(p.itens, colunaInternet);
    const livroItem = colunaLivro && acharItemDoPlano(p.itens, colunaLivro);
    const audioItem = colunaAudio && acharItemDoPlano(p.itens, colunaAudio);
    for (const item of p.itens) {
      if (item === internet || item === livroItem || item === audioItem) continue;
      const registro = svaPorItemMap.get(item.nome) || { nome: item.nome, impostos: new Map() };
      // Valor UNITÁRIO do imposto (não soma × clientes) — pedido da usuária
      // 02/10/2026: esse imposto é sempre o mesmo pra todo plano que tem o
      // item (vem do catálogo), não faz sentido virar total.
      for (const imp of item.impostos || []) registro.impostos.set(imp.nome, { nome: imp.nome, aliquota: imp.aliquota, valor: imp.valor });
      svaPorItemMap.set(item.nome, registro);
    }
  }
  const svaPorItemDetalhe = [...svaPorItemMap.values()];
  const nomesImpostosSvaItem = [...new Set(svaPorItemDetalhe.flatMap((item) => [...item.impostos.values()].filter((i) => i.valor > 0.004).map((i) => i.nome)))];
  const secaoImpostosPorItem = svaPorItemDetalhe.length === 0 ? '' : `<div style="margin:2px 16px 8px">
    <strong style="font-size:9px;color:#475569">Impostos por item de SVA</strong>
    <table style="margin-top:2px;max-width:420px">
      <thead><tr><th class="esq">Item</th>${nomesImpostosSvaItem.map((nome) => `<th>${esc(nome)}</th>`).join('')}</tr></thead>
      <tbody>${svaPorItemDetalhe.map((item) => `<tr><td class="esq">${esc(item.nome)}</td>${nomesImpostosSvaItem.map((nome) => {
        const imp = item.impostos.get(nome);
        return `<td>${imp && imp.valor > 0.004 ? `${fmtPctImposto(imp.aliquota)}: ${fmtBRL(imp.valor)}` : '—'}</td>`;
      }).join('')}</tr>`).join('')}</tbody>
    </table>
  </div>`;

  const linhaDetalheImpostos = (titulo, lista) => lista.length === 0 ? '' : `<div>
    <strong>${esc(titulo)}</strong>
    ${lista.map((i) => `<div>${esc(i.nome)} ${fmtPctImposto(i.aliquota)}: ${fmtBRL(i.valor)}</div>`).join('')}
  </div>`;

  const linhasCombo = COMBOS_DEF.map((combo) => {
    const v = valorComboNoModelo(planos, combo);
    const valorTexto = v == null ? '—' : `${fmtBRL(v.unitLivro)}×${combo.livros}${v.unitAudio != null ? ` + ${fmtBRL(v.unitAudio)}×${combo.audio}` : ''} = <strong>${fmtBRL(v.total)}</strong>`;
    return `<tr><td class="esq">${esc(rotuloCombo(combo))}</td><td class="sep">${valorTexto}</td></tr>`;
  }).join('');
  const secaoCombos = `<div style="margin:2px 16px 8px">
    <strong style="font-size:9px;color:#475569">Combos LC+ Livros${modeloLabel ? ` — ${esc(modeloLabel)}` : ''}</strong>
    <table style="margin-top:2px;max-width:320px">
      <thead><tr><th class="esq">Combo</th><th class="sep">${esc(modeloLabel || 'Este modelo')}</th></tr></thead>
      <tbody>${linhasCombo}</tbody>
    </table>
  </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    <div class="cabecalho">
      <h1>Kronos — Tabela de Composição de Planos${modeloLabel ? ` — ${esc(modeloLabel)}` : ''}</h1>
      <div class="sub">Gerado por ${esc(nomeUsuario || '—')} em ${esc(geradoEm)}</div>
    </div>
    <table>
      <thead><tr>
        <th>#</th><th class="esq">Plano</th><th>Cli.</th><th>ID</th><th>Total</th><th>SCM %</th><th>LC+ LIVROS %</th><th>SVA %</th><th>SCM R$</th><th>LC+ LIVROS R$</th><th>SVA R$</th>
        ${colunas.map((c) => `<th>${esc(c.nome)}</th>`).join('')}
        <th>Soma</th><th>Impostos</th>
      </tr></thead>
      <tbody>${linhas}${linhaTotalClientes}</tbody>
    </table>
    <div style="margin:8px 16px;font-size:9px;color:#475569;display:flex;gap:16px;flex-wrap:wrap">
      <span>Soma total de SCM: <strong>${fmtBRL(faturamento.scm)}</strong></span>
      <span>Soma total de LC+ Livros: <strong>${fmtBRL(faturamento.la)}</strong></span>
      <span>Soma total de SVA: <strong>${fmtBRL(faturamento.sva)}</strong></span>
      <span>Total Geral: <strong>${fmtBRL(faturamentoTotalGeral)}</strong></span>
    </div>
    <div style="margin:2px 16px 8px;font-size:9px;color:#94a3b8;display:flex;gap:16px;flex-wrap:wrap">
      <span>Impostos de SCM: <strong>${fmtBRL(impostos.scm)}</strong></span>
      <span>Impostos de LC+ Livros: <strong>${fmtBRL(impostos.la)}</strong></span>
      <span>Impostos de SVA: <strong>${fmtBRL(impostos.sva)}</strong></span>
      <span>Impostos Total Geral: <strong>${fmtBRL(impostosTotalGeral)}</strong></span>
    </div>
    <div style="margin:0 16px 8px;font-size:8.5px;color:#64748b;display:flex;gap:24px;flex-wrap:wrap">
      ${linhaDetalheImpostos('SCM', impostosScmDetalhe)}
      ${linhaDetalheImpostos('LC+ Livros', impostosLADetalhe)}
      ${linhaDetalheImpostos('SVA', impostosSvaDetalhe)}
    </div>
    ${secaoImpostosPorItem}
    ${secaoCombos}
    <div class="rodape">Kronos — Análise de Composição de Planos — gerado automaticamente</div>
  </body></html>`;
}

async function gerarPDFTabelaComposicao(planos, itensCatalogo, opts) {
  return htmlParaPdf(montarHtmlTabelaComposicao(planos, itensCatalogo, opts), null, { landscape: true });
}

// Mesma grade da tela/PDF em formato de planilha — pedido da usuária
// 01/10/2026 ("tem excel pra baixar a tabela?"). Reaproveita montarColunas/
// acharItemDoPlano pra nunca divergir da ordem/identificação de item usada
// no PDF e na tela.
function montarLinhasTabelaXlsx(planos, itensCatalogo) {
  const colunas = montarColunas(itensCatalogo);
  const colunaLivro = colunas.find((c) => c.ehLivro);
  const colunaAudio = colunas.find((c) => /audio/i.test(c.nome));
  const colunaInternet = colunas.find((c) => c.papel === 0);

  const linhas = planos.map((p, idx) => {
    const internet = colunaInternet ? acharItemDoPlano(p.itens, colunaInternet) : null;
    const livroItem = colunaLivro ? acharItemDoPlano(p.itens, colunaLivro) : null;
    const audioItem = colunaAudio ? acharItemDoPlano(p.itens, colunaAudio) : null;
    const valorLA = (livroItem?.valor_item || 0) + (audioItem?.valor_item || 0);
    const valorSva = Math.max(0, (Number(p.valor_total_composicao) || 0) - (internet?.valor_item || 0) - valorLA);
    const ehAtual = p.modelo === 'atual';
    const baseComposicao = ehAtual ? (internet?.valor_item || 0) + valorLA : (Number(p.preco_venda) || 0);
    const pctInternet = baseComposicao > 0 ? (internet?.valor_item || 0) / baseComposicao * 100 : null;
    const pctLA = baseComposicao > 0 ? valorLA / baseComposicao * 100 : null;
    const pctSva = ehAtual ? null : (p.preco_venda > 0 ? valorSva / p.preco_venda * 100 : null);
    const linha = {
      '#': idx + 1, Plano: p.nome, 'Cli.': p.quantidade_clientes, ID: p.id_erp || '—',
      Total: p.preco_venda,
      'SCM %': pctInternet == null ? '—' : Number(pctInternet.toFixed(2)),
      'LC+ LIVROS %': pctLA == null ? '—' : Number(pctLA.toFixed(2)),
      'SVA %': pctSva == null ? '—' : Number(pctSva.toFixed(2)),
      'SCM R$': internet?.valor_item || 0,
      'LC+ LIVROS R$': valorLA,
      'SVA R$': valorSva,
    };
    for (const c of colunas) {
      const item = acharItemDoPlano(p.itens, c);
      if (c.usaQtdValor) {
        linha[`${c.nome} (Qtd)`] = item?.quantidade || 0;
        linha[`${c.nome} (Un.)`] = item?.valor_unitario || 0;
      } else {
        linha[c.nome] = item?.valor_unitario || 0;
      }
    }
    linha.Soma = p.valor_total_composicao;
    linha.Impostos = p.total_impostos;
    return linha;
  });

  // Mesmos totais de faturamento/impostos por categoria que já saem no PDF e
  // na tela — colados no fim da mesma planilha pra não perder essa parte.
  const totalPorCliente = (coluna) => !coluna ? 0 : planos.reduce((s, p) => {
    const item = acharItemDoPlano(p.itens, coluna);
    return s + (item?.quantidade || 0) * (p.quantidade_clientes || 0);
  }, 0);
  if (colunaLivro || colunaAudio) {
    const linhaTotal = { Plano: 'Total (x clientes) ->' };
    if (colunaLivro) linhaTotal[`${colunaLivro.nome} (Qtd)`] = totalPorCliente(colunaLivro);
    if (colunaAudio) linhaTotal[`${colunaAudio.nome} (Qtd)`] = totalPorCliente(colunaAudio);
    linhas.push(linhaTotal);
  }

  const faturamento = planos.reduce((acc, p) => {
    const internet = colunaInternet ? acharItemDoPlano(p.itens, colunaInternet) : null;
    const livroItem = colunaLivro ? acharItemDoPlano(p.itens, colunaLivro) : null;
    const audioItem = colunaAudio ? acharItemDoPlano(p.itens, colunaAudio) : null;
    const valorScm = internet?.valor_item || 0;
    const valorLA = (livroItem?.valor_item || 0) + (audioItem?.valor_item || 0);
    const valorSva = Math.max(0, (Number(p.valor_total_composicao) || 0) - valorScm - valorLA);
    const clientes = p.quantidade_clientes || 0;
    acc.scm += valorScm * clientes;
    acc.la += valorLA * clientes;
    acc.sva += valorSva * clientes;
    return acc;
  }, { scm: 0, la: 0, sva: 0 });

  const impostos = planos.reduce((acc, p) => {
    const internet = colunaInternet ? acharItemDoPlano(p.itens, colunaInternet) : null;
    const livroItem = colunaLivro ? acharItemDoPlano(p.itens, colunaLivro) : null;
    const audioItem = colunaAudio ? acharItemDoPlano(p.itens, colunaAudio) : null;
    const impostosScm = internet?.impostos_item || 0;
    const impostosLA = (livroItem?.impostos_item || 0) + (audioItem?.impostos_item || 0);
    const impostosSva = Math.max(0, (Number(p.total_impostos) || 0) - impostosScm - impostosLA);
    const clientes = p.quantidade_clientes || 0;
    acc.scm += impostosScm * clientes;
    acc.la += impostosLA * clientes;
    acc.sva += impostosSva * clientes;
    return acc;
  }, { scm: 0, la: 0, sva: 0 });

  linhas.push({});
  linhas.push({ Plano: 'Soma total de SCM', Total: faturamento.scm });
  linhas.push({ Plano: 'Soma total de LC+ Livros', Total: faturamento.la });
  linhas.push({ Plano: 'Soma total de SVA', Total: faturamento.sva });
  linhas.push({ Plano: 'Total Geral', Total: faturamento.scm + faturamento.la + faturamento.sva });
  linhas.push({ Plano: 'Impostos de SCM', Total: impostos.scm });
  linhas.push({ Plano: 'Impostos de LC+ Livros', Total: impostos.la });
  linhas.push({ Plano: 'Impostos de SVA', Total: impostos.sva });
  linhas.push({ Plano: 'Impostos Total Geral', Total: impostos.scm + impostos.la + impostos.sva });

  // Impostos por item de SVA — pedido da usuária 02/10/2026, mesmo formato
  // trazido pro PDF e pra tela.
  const svaPorItemMap = new Map();
  for (const p of planos) {
    const internet = colunaInternet && acharItemDoPlano(p.itens, colunaInternet);
    const livroItem = colunaLivro && acharItemDoPlano(p.itens, colunaLivro);
    const audioItem = colunaAudio && acharItemDoPlano(p.itens, colunaAudio);
    for (const item of p.itens) {
      if (item === internet || item === livroItem || item === audioItem) continue;
      const registro = svaPorItemMap.get(item.nome) || { nome: item.nome, impostos: new Map() };
      // Valor UNITÁRIO do imposto (não soma × clientes) — pedido da usuária
      // 02/10/2026: esse imposto é sempre o mesmo pra todo plano que tem o
      // item (vem do catálogo), não faz sentido virar total.
      for (const imp of item.impostos || []) registro.impostos.set(imp.nome, { nome: imp.nome, aliquota: imp.aliquota, valor: imp.valor });
      svaPorItemMap.set(item.nome, registro);
    }
  }
  const svaPorItemDetalhe = [...svaPorItemMap.values()];
  if (svaPorItemDetalhe.length > 0) {
    linhas.push({});
    linhas.push({ Plano: 'Impostos por item de SVA' });
    for (const item of svaPorItemDetalhe) {
      const linha = { Plano: item.nome };
      for (const imp of item.impostos.values()) {
        if (imp.valor > 0.004) linha[imp.nome] = `${imp.aliquota.toFixed(2)}%: ${fmtBRL(imp.valor)}`;
      }
      linhas.push(linha);
    }
  }

  linhas.push({});
  linhas.push({ Plano: 'Combos LC+ Livros' });
  for (const combo of COMBOS_DEF) {
    const v = valorComboNoModelo(planos, combo);
    linhas.push({ Plano: rotuloCombo(combo), Total: v == null ? '—' : v.total });
  }

  return linhas;
}

module.exports = { gerarPDFTabelaComposicao, montarHtmlTabelaComposicao, montarLinhasTabelaXlsx };
