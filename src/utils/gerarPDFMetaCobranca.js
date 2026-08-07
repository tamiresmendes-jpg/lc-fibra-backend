// Gera o PDF do relatório de Meta de Cobrança (mesmo visual da tela), via
// Chromium headless — mesmo motor já usado nos outros PDFs de Meta.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fx = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesBR = (mesRef) => {
  const [a, m] = mesRef.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};
const emissao = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
function fmtData(v) {
  if (!v) return '—';
  const [data] = String(v).split(' ');
  const [a, m, d] = (data || '').split('-');
  return d && m && a ? `${d}/${m}/${a}` : '—';
}

function montarHtmlMetaCobranca(dados) {
  const itens = dados.itens || [];
  const linhas = itens.map(i => `
    <tr>
      <td style="font-weight:600">${esc(i.nome)}</td>
      <td style="text-align:center">${i.total_os}</td>
      <td style="text-align:center">${i.os_removido}</td>
      <td style="text-align:center">${i.os_pagamento}</td>
      <td style="text-align:center;font-weight:700;color:${i.bate_meta ? '#16a34a' : '#dc2626'}">${i.efetividade}% ${i.bate_meta ? '✓' : '✗'}</td>
      <td style="text-align:right">${fx(i.bonus_remocao)}</td>
      <td style="text-align:right;color:${i.valor_recebido_pendente ? '#b45309' : '#1e293b'}">${i.valor_recebido_pendente ? 'A confirmar' : fx(i.valor_recebido)}</td>
      <td style="text-align:right;color:${i.valor_recebido_pendente ? '#b45309' : '#1e293b'}">${i.valor_recebido_pendente ? 'A confirmar' : fx(i.bonus_recebimento)}</td>
      <td style="text-align:right;font-weight:700;color:#166534;background:#dcfce7">${fx(i.bonus_total)}</td>
    </tr>`).join('');

  const recebimentos = (dados.recebimentos || []).flatMap(f => (f.cobrancas?.length > 1 ? f.cobrancas : [null]).map((c, i) => {
    if (i > 0) return ''; // uma linha por fatura no PDF (sem expandir), pra caber na folha
    return `<tr>
      <td>${esc(f.cobrador)}</td>
      <td>${esc(f.codigo_cliente)} — ${esc(f.nome_cliente)}</td>
      <td style="text-align:right;font-weight:700;color:#166534">${fx(f.valor_total)}</td>
      <td>${esc((f.forma_pagamento || '—').replace(/_/g, ' '))}</td>
      <td>${esc(f.vendedor || '—')}</td>
      <td>${fmtData(f.data_execucao_os)}</td>
      <td>${fmtData(f.data_pagamento)}</td>
      <td>${esc(f.quem_deu_baixa || '—')}</td>
    </tr>`;
  })).join('');

  const totalRemocao = itens.reduce((s, i) => s + i.os_removido, 0);
  const totalOs = itens.reduce((s, i) => s + i.total_os, 0);
  const totalBonus = itens.reduce((s, i) => s + i.bonus_total, 0);

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b}
    h1{font-size:18px;color:#0b2b6b;margin-bottom:2px}
    h2{font-size:13px;color:#0b2b6b;margin:16px 0 6px}
    .sub{font-size:11px;color:#64748b;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:10px}
    th{background:#eef2ff;color:#0b2b6b;font-weight:800;padding:5px 6px;text-align:left;white-space:nowrap}
    td{padding:4px 6px;border-bottom:1px solid #f1f5f9;white-space:nowrap}
    tfoot td{background:#eef2ff;font-weight:800;color:#0b2b6b}
    .info{font-size:10px;color:#334155;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:6px 10px;margin-bottom:12px}
    .info b{color:#0b2b6b}
  </style></head><body>
    <h1>📊 Meta de Cobrança</h1>
    <div class="sub">Referência: <b>${esc(mesBR(dados.mes))}</b> · Emitido em ${emissao()} · Meta de efetividade: ${dados.meta_efetividade}%</div>
    <div class="info">
      Total de O.S.: <b>${totalOs}</b> &nbsp;·&nbsp; Removidas: <b>${totalRemocao}</b> &nbsp;·&nbsp;
      Bônus do mês: <b style="color:#166534">${fx(totalBonus)}</b>
    </div>
    <table>
      <thead><tr>
        <th>Colaborador</th><th style="text-align:center">Total O.S.</th><th style="text-align:center">Removidas</th>
        <th style="text-align:center">Pagamentos</th><th style="text-align:center">Efetividade</th>
        <th style="text-align:right">Bônus remoção</th><th style="text-align:right">Valor recebido</th>
        <th style="text-align:right">Bônus recebimento</th><th style="text-align:right">Total</th>
      </tr></thead>
      <tbody>${linhas || '<tr><td colspan="9" style="text-align:center;color:#94a3b8">Nenhuma O.S. fechada nesse período.</td></tr>'}</tbody>
    </table>

    <h2>Recebimentos confirmados no período (por fatura)</h2>
    <table>
      <thead><tr>
        <th>Cobrador</th><th>Cliente</th><th style="text-align:right">Valor</th><th>Forma</th>
        <th>Vendedor</th><th>Fechamento O.S.</th><th>Pagamento</th><th>Quem deu baixa</th>
      </tr></thead>
      <tbody>${recebimentos || '<tr><td colspan="8" style="text-align:center;color:#94a3b8">Nenhum recebimento confirmado nesse período.</td></tr>'}</tbody>
    </table>
  </body></html>`;
}

async function gerarPDFMetaCobranca(dados) {
  return htmlParaPdf(montarHtmlMetaCobranca(dados));
}

module.exports = { gerarPDFMetaCobranca, montarHtmlMetaCobranca };
