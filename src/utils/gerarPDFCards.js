// PDF da tela "Cards" (grade visual de cartões, um por plano) — pedido da
// usuária 02/10/2026 ("trazer em pdf essa tela dos cards"). Reaproveita a
// MESMA lógica de combo/ordem/comparação do CardPlanoResumo (ComposicaoPlanos.jsx)
// pra não divergir do que ela vê na tela.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBRL = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtPct = (v) => `${(Number(v) || 0).toFixed(2)}%`;
const fmtPctItem = (v) => (v == null ? 'fora da composição' : fmtPct(v));

// Mesmas regras do card na tela (ComposicaoPlanos.jsx) — ver comentário lá
// de 29/09/2026 sobre por que o combo é identificado só pelo NOME do item.
const COMBOS = [
  { emoji: '💎', nome: 'Diamante', teste: (l, a) => a >= 2 },
  { emoji: '💠', nome: 'Safira', teste: (l, a) => a === 1 },
  { emoji: '🥇', nome: 'Ouro', teste: (l, a) => l >= 4 },
  { emoji: '🥈', nome: 'Prata', teste: (l, a) => l === 3 },
  { emoji: '🥉', nome: 'Bronze', teste: (l, a) => l === 2 },
];
function calcularComboDoPlano(itens) {
  const qtdLivro = itens.find((i) => !/audio/i.test(i.nome) && /^livro/i.test(i.nome))?.quantidade || 0;
  const qtdAudio = itens.find((i) => /audio/i.test(i.nome))?.quantidade || 0;
  return COMBOS.find((c) => c.teste(qtdLivro, qtdAudio)) || null;
}

const ORDEM_CARD_SVA = ['Watch TV', 'HBO Max', 'Telemedicina', 'ExitLag', 'IP Dedicado', 'Roteador Adicional Mesh', 'Revista'];
function ordemItemCard(nome) {
  const n = String(nome || '').trim();
  if (/^internet/i.test(n)) return -3;
  if (/audio/i.test(n)) return -2;
  if (/^livro/i.test(n)) return -1;
  const i = ORDEM_CARD_SVA.indexOf(n);
  return i === -1 ? ORDEM_CARD_SVA.length : i;
}

const ESTILO = `
  @page{margin:8mm 8mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:9.5px}
  .cabecalho{background:#4f46e5;color:#fff;padding:10px 12px;margin-bottom:10px}
  .cabecalho h1{font-size:15px}
  .cabecalho .sub{font-size:9px;opacity:.9;margin-top:3px}
  .grade{display:flex;flex-wrap:wrap;gap:10px}
  .card{width:31.5%;border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px;break-inside:avoid}
  .nome{font-size:12px;font-weight:700;display:block}
  .nome .combo{font-size:9px;color:#64748b;font-weight:400;margin-left:4px}
  .precos{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;margin-top:2px}
  .preco-bruto{font-size:14px;font-weight:700;color:#2563eb}
  .preco-desc{font-size:12px;font-weight:700;color:#16a34a}
  .sub{color:#94a3b8;font-size:8.5px}
  .itens{border-top:1px solid #e2e8f0;padding-top:5px;margin-top:5px}
  .item-linha{display:flex;justify-content:space-between;gap:8px;padding:2px 0}
  .imposto-item{margin-top:4px}
  .imposto-item strong{font-size:9px;color:#475569;display:block;margin-bottom:1px}
  table{width:100%;border-collapse:collapse}
  table.detalhe td{font-size:8.5px;color:#94a3b8;padding:1px 4px 1px 0}
  table.detalhe tr.total td{color:#475569;font-weight:700;border-top:1px solid #e2e8f0;padding-top:2px}
  table.comparacao{margin-top:4px;font-size:9px}
  table.comparacao th{color:#94a3b8;font-weight:400;text-align:right;padding:1px 4px}
  table.comparacao th.esq,table.comparacao td.esq{text-align:left}
  table.comparacao td{text-align:right;padding:1px 4px}
  table.comparacao tr.total td{font-weight:700;border-top:1px solid #e2e8f0}
  .secao{border-top:1px solid #e2e8f0;margin-top:6px;padding-top:6px}
  .secao div{margin:1px 0}
  .toggle{color:#2563eb;font-size:9px;margin:3px 0 0}
  .limite-ok{background:#f0fdf4;color:#16a34a}
  .limite-excedido{background:#fef2f2;color:#dc2626}
  .badge-limite{margin-top:5px;padding:4px 6px;border-radius:5px;font-weight:700;font-size:9px}
  .rodape{margin-top:10px;font-size:8px;color:#94a3b8;text-align:center}
`;

function montarCardHtml(plano) {
  const combo = calcularComboDoPlano(plano.itens);
  const itensOrdenados = [...plano.itens].sort((a, b) => ordemItemCard(a.nome) - ordemItemCard(b.nome));
  const comparacao = plano.modelo === 'atual' && plano.comparacao_modelos && plano.comparacao_modelos.length > 1 ? plano.comparacao_modelos : null;

  const linhasItens = itensOrdenados.map((i) => `
    <div class="item-linha">
      <span>${esc(i.nome)}${i.quantidade > 1 ? ` (x${i.quantidade})` : ''} — ${fmtPctItem(i.percentual)}</span>
      <span class="sub" style="white-space:nowrap">${fmtBRL(i.valor_item)} (imp.: ${fmtBRL(i.impostos_item)})</span>
    </div>`).join('');

  const blocosImpostos = itensOrdenados.filter((i) => (i.impostos || []).length > 0).map((i) => `
    <div class="imposto-item">
      <strong>${esc(i.nome)}</strong>
      <table class="detalhe">
        <tbody>
          ${i.impostos.map((imp) => `<tr><td>${esc(imp.nome)}</td><td style="text-align:right">${fmtPct(imp.aliquota)}</td><td style="text-align:right">${fmtBRL(imp.valor)}</td></tr>`).join('')}
          <tr class="total"><td colspan="2">Total do item</td><td style="text-align:right">${fmtBRL(i.impostos_item)}</td></tr>
        </tbody>
      </table>
    </div>`).join('');

  let tabelaComparacao = '';
  if (comparacao) {
    tabelaComparacao = `
      <div class="secao">
        <strong style="font-size:10px">Comparar com ${comparacao.filter((c) => c.titulo !== 'Modelo atual').map((c) => esc(c.titulo)).join(' / ')}</strong>
        <table class="comparacao">
          <thead><tr><th class="esq"></th>${comparacao.map((c) => `<th>${esc(c.titulo === 'Modelo atual' ? 'Atual (hoje)' : c.titulo)}</th>`).join('')}</tr></thead>
          <tbody>
            ${itensOrdenados.map((i) => `<tr><td class="esq">${esc(i.nome)}</td>${comparacao.map((c) => {
              const outro = c.itens.find((x) => x.nome === i.nome);
              return `<td>${outro ? `${fmtBRL(outro.valor_item)} (${fmtPctItem(outro.percentual)})` : '—'}</td>`;
            }).join('')}</tr>`).join('')}
            <tr class="total"><td class="esq">Total</td>${comparacao.map((c) => `<td>${fmtBRL(c.preco_venda)}</td>`).join('')}</tr>
            <tr><td class="esq sub">Impostos</td>${comparacao.map((c) => `<td class="sub">${fmtBRL(c.total_impostos)}</td>`).join('')}</tr>
            <tr><td class="esq sub">Resultado bruto</td>${comparacao.map((c) => `<td class="sub">${fmtBRL(c.resultado_bruto)}</td>`).join('')}</tr>
          </tbody>
        </table>
      </div>`;
  }

  return `
    <div class="card">
      <span class="nome">${esc(plano.nome)}${combo ? ` <span class="combo">${combo.emoji} ${esc(combo.nome)}</span>` : ''}</span>
      <div class="precos">
        <span><span class="preco-bruto">${fmtBRL(plano.preco_venda)}</span> <span class="sub">bruto</span></span>
        <span><span class="preco-desc">${fmtBRL(plano.valor_com_desconto)}</span> <span class="sub">c/ desconto (${fmtBRL(plano.desconto_pontualidade)})</span></span>
      </div>
      <div class="itens">
        ${linhasItens}
        ${blocosImpostos ? `<div style="margin-top:4px">${blocosImpostos}</div>` : ''}
      </div>
      ${tabelaComparacao}
      <div class="secao">
        <div>Valor total da composição: ${fmtBRL(plano.valor_total_composicao)} <strong style="color:${plano.total_bate_com_preco ? '#16a34a' : '#dc2626'}">${plano.total_bate_com_preco ? '✓ bate com o bruto' : '✗ não bate'}</strong></div>
        <div>Total de impostos: ${fmtBRL(plano.total_impostos)}</div>
        <div>Resultado bruto: ${fmtBRL(plano.resultado_bruto)} (${fmtPct(plano.margem_bruta_percentual)})</div>
        <div>Resultado c/ desconto: ${fmtBRL(plano.resultado_liquido)} (${fmtPct(plano.margem_liquida_percentual)})</div>
        <div class="badge-limite ${plano.regra_50.status === 'dentro_do_limite' ? 'limite-ok' : 'limite-excedido'}">
          SVA + Livro/E-book: ${fmtPct(plano.regra_50.percentual_sva_livro)} — ${plano.regra_50.status === 'dentro_do_limite' ? 'dentro do limite' : 'acima do limite'}
        </div>
      </div>
      <div class="secao">
        <div>${esc(plano.quantidade_clientes)} cliente(s)</div>
        <div>Faturamento total bruto: <strong>${fmtBRL(plano.faturamento_total_bruto)}</strong></div>
        <div>Faturamento total c/ desconto: <strong>${fmtBRL(plano.faturamento_total_liquido)}</strong></div>
        <div>Impostos totais: ${fmtBRL(plano.impostos_totais_clientes)}</div>
        <div>Resultado total bruto: <strong>${fmtBRL(plano.resultado_total_bruto)}</strong></div>
        <div>Resultado total c/ desconto: <strong>${fmtBRL(plano.resultado_total_liquido)}</strong></div>
      </div>
    </div>`;
}

function montarHtmlCards(planos, { modeloLabel, nomeUsuario } = {}) {
  const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    <div class="cabecalho">
      <h1>Kronos — Planos (Cards)${modeloLabel ? ` — ${esc(modeloLabel)}` : ''}</h1>
      <div class="sub">Gerado por ${esc(nomeUsuario || '—')} em ${esc(geradoEm)}</div>
    </div>
    <div class="grade">${planos.map(montarCardHtml).join('')}</div>
    <div class="rodape">Kronos — Análise de Composição de Planos — gerado automaticamente</div>
  </body></html>`;
}

async function gerarPDFCards(planos, opts) {
  return htmlParaPdf(montarHtmlCards(planos, opts), null, { landscape: true });
}

module.exports = { gerarPDFCards, montarHtmlCards };
