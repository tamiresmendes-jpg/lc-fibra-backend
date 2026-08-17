// PDF do relatório "Item LC+ Livros (E-books SVA) — CST diferente de Nenhum"
// Varre a composição de cada plano (com cliente ativo) procurando o item de
// composição "LC+ Livros" e reporta os planos onde CST ICMS, CST PIS ou CST
// COFINS desse item vieram com uma opção diferente de "Nenhum" — pedido pra
// achar cadastro fiscal fora do padrão esperado desse item específico.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const NOME_ITEM_REGEX = /LC\+?\s*Livros/i;

function descricaoCst(campo) {
  if (!campo) return 'Nenhum';
  return campo.descricao || campo.display || String(campo);
}

// "Nenhum" é uma opção normal do próprio CST (não ausência de valor) — o
// item está "fora do padrão" quando a descrição não é literalmente "Nenhum".
function foraDoPadrao(campo) {
  return descricaoCst(campo).trim().toLowerCase() !== 'nenhum';
}

function encontrarItemLivros(plano) {
  const composicao = Array.isArray(plano.servico_composicao) ? plano.servico_composicao : [];
  return composicao.find(item => NOME_ITEM_REGEX.test(item.descricao || ''));
}

// Varre os planos (já com detalhe/composição) e retorna só os que têm o item
// "LC+ Livros" com algum CST (ICMS/PIS/COFINS) diferente de "Nenhum".
function filtrarPlanosComCstForaDoPadrao(planos) {
  const encontrados = [];
  for (const plano of planos) {
    const item = encontrarItemLivros(plano);
    if (!item) continue;
    const cstIcms = item.cst_tributacao;
    const cstPis = item.cst_pis;
    const cstCofins = item.cst_cofins;
    if (!foraDoPadrao(cstIcms) && !foraDoPadrao(cstPis) && !foraDoPadrao(cstCofins)) continue;
    encontrados.push({ plano, item, cstIcms, cstPis, cstCofins });
  }
  return encontrados;
}

const ESTILO = `
    @page{margin:8mm 10mm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:10px;line-height:1.3}
    .cabecalho{background:#4f46e5;color:#fff;padding:10px 14px;margin-bottom:8px}
    .cabecalho h1{font-size:15px}
    .cabecalho .sub{font-size:9px;opacity:.9;margin-top:2px}
    table{width:100%;border-collapse:collapse;margin:0 14px}
    th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left;font-size:9px;word-break:break-word}
    th{background:#eef2ff;color:#4f46e5;text-transform:uppercase;font-size:8px}
    tr:nth-child(even) td{background:#f8fafc}
    .fora{color:#b91c1c;font-weight:700}
    .ok{color:#64748b}
    .rodape{margin:8px 14px 0;border-top:1px solid #e2e8f0;padding-top:4px;font-size:8px;color:#94a3b8;text-align:center}
    .vazio{margin:20px 14px;color:#64748b;font-style:italic}
`;

function linhaTabela({ plano, item, cstIcms, cstPis, cstCofins }) {
  const cel = campo => `<span class="${foraDoPadrao(campo) ? 'fora' : 'ok'}">${esc(descricaoCst(campo))}</span>`;
  const percentual = item.representacao_percentual != null ? `${Number(item.representacao_percentual)}%` : '—';
  return `<tr>
    <td>${esc(plano.id_servico)}</td>
    <td>${esc(plano.descricao || plano.nome_exibicao || `Plano ${plano.id_servico}`)}</td>
    <td>${esc(item.descricao)}</td>
    <td>${fmtBRL(plano.valor)}</td>
    <td>${esc(percentual)}</td>
    <td>${cel(cstIcms)}</td>
    <td>${cel(cstPis)}</td>
    <td>${cel(cstCofins)}</td>
  </tr>`;
}

// Formato leve pra tela (sem gerar PDF) — só os campos que a lista usa.
function resumirEncontrados(encontrados) {
  return encontrados.map(({ plano, item, cstIcms, cstPis, cstCofins }) => ({
    id_servico: plano.id_servico,
    descricao_plano: plano.descricao || plano.nome_exibicao || `Plano ${plano.id_servico}`,
    valor_plano: plano.valor,
    ativo: plano.ativo,
    clientes_servicos_count: plano.clientes_servicos_count,
    descricao_item: item.descricao,
    representacao_percentual: item.representacao_percentual,
    cst_icms: descricaoCst(cstIcms),
    cst_pis: descricaoCst(cstPis),
    cst_cofins: descricaoCst(cstCofins),
  }));
}

function montarHtmlRelatorioEbooksCst(encontrados) {
  const corpo = encontrados.length
    ? `<table>
        <thead><tr><th>Código</th><th>Plano</th><th>Item da Composição</th><th>Valor do Plano</th><th>% Representação</th><th>CST ICMS</th><th>CST PIS</th><th>CST COFINS</th></tr></thead>
        <tbody>${encontrados.map(linhaTabela).join('')}</tbody>
      </table>`
    : `<div class="vazio">Nenhum plano com cliente ativo tem o item "LC+ Livros" com CST ICMS, PIS ou COFINS diferente de "Nenhum".</div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    <div class="cabecalho">
      <h1>Item "LC+ Livros" (E-books SVA) — CST diferente de "Nenhum"</h1>
      <div class="sub">${encontrados.length} plano(s) encontrado(s) · Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
    </div>
    ${corpo}
    <div class="rodape">Kronos — Análise de Planos — Só planos com pelo menos 1 cliente ativo</div>
  </body></html>`;
}

async function gerarPDFRelatorioEbooksCst(planos) {
  const encontrados = filtrarPlanosComCstForaDoPadrao(planos);
  return htmlParaPdf(montarHtmlRelatorioEbooksCst(encontrados));
}

module.exports = { gerarPDFRelatorioEbooksCst, filtrarPlanosComCstForaDoPadrao, montarHtmlRelatorioEbooksCst, resumirEncontrados };
