// Gera o PDF do relatório de Meta do Comercial (mesmo visual da tela), via Chromium
// headless (reaproveita o motor de gerarPDFHtml.js já usado nos POPs).
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fx = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesBR = (mesRef) => {
  const [a, m] = mesRef.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};

function montarHtmlMetaComercial(dados) {
  const linhas = (dados.itens || []).map(i => `
    <tr>
      <td style="font-weight:600">${esc(i.nome)}</td>
      <td>${esc(i.filial || '—')}</td>
      <td style="text-align:center;font-weight:700">${i.conta_meta ? i.meta : '—'}</td>
      <td style="text-align:center;background:#f8fafc">${i.qtd_vendas}</td>
      <td style="text-align:center;background:#f8fafc">${i.cancelamento || 0}</td>
      <td style="text-align:center;font-weight:700">${i.saldo}</td>
      <td style="text-align:center">${i.bate_meta == null ? '—' : (i.bate_meta ? '✓' : '✗')}</td>
      <td style="text-align:center;color:${i.gap >= 0 ? '#16a34a' : '#dc2626'};font-weight:700">${i.conta_meta ? i.gap : '—'}</td>
      <td style="text-align:right">${fx(i.bonus_meta_valor)}</td>
      <td style="text-align:right">${fx(i.bonus_gap_valor)}</td>
      <td style="text-align:right;font-weight:700;color:#166534;background:#dcfce7">${fx(i.total_bonus)}</td>
    </tr>`).join('');

  const itens = dados.itens || [];
  const totalVendas = itens.reduce((s, i) => s + i.qtd_vendas, 0);
  const totalCancel = itens.reduce((s, i) => s + i.cancelamento, 0);
  const totalSaldo = itens.reduce((s, i) => s + i.saldo, 0);
  const totalMeta = itens.reduce((s, i) => s + (i.conta_meta ? (i.meta || 0) : 0), 0);
  const totalGap = itens.reduce((s, i) => s + (i.conta_meta ? i.gap : 0), 0);
  const totalBonusMeta = itens.reduce((s, i) => s + (i.bonus_meta_valor || 0), 0);
  const totalBonusGap = itens.reduce((s, i) => s + (i.bonus_gap_valor || 0), 0);
  const totalBonus = itens.reduce((s, i) => s + i.total_bonus, 0);
  const sup = dados.supervisor || {};

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b}
    h1{font-size:18px;color:#0b2b6b;margin-bottom:2px}
    .sub{font-size:11px;color:#64748b;margin-bottom:14px}
    table{width:100%;border-collapse:collapse;font-size:10.5px}
    th{background:#fde047;color:#0b2b6b;font-weight:800;padding:5px 6px;text-align:left;white-space:nowrap}
    td{padding:4px 6px;border-bottom:1px solid #f1f5f9}
    tfoot td{background:#fde047;font-weight:800;color:#0b2b6b}
    .sup{margin-top:18px;border:1px solid #e2e8f0;border-radius:8px;padding:12px;font-size:11.5px;max-width:320px}
    .sup b{color:#0b2b6b}
    .premio{font-size:14px;color:#16a34a;font-weight:800;margin-top:6px}
  </style></head><body>
    <h1>📊 Meta do Comercial</h1>
    <div class="sub">Período: ${mesBR(dados.mes)} · Total geral de vendas no mês (todos os setores): ${dados.total_geral_vendas_mes ?? '—'}</div>
    <table>
      <thead><tr>
        <th>Vendedor</th><th>Filial</th><th>Meta</th><th>Vendas</th><th>Cancel.</th><th>Saldo</th>
        <th>OK</th><th>Gap</th><th>Bônus Meta</th><th>Bônus Gap</th><th>Total</th>
      </tr></thead>
      <tbody>${linhas || '<tr><td colspan="11" style="text-align:center;padding:14px;color:#94a3b8">Sem vendedores cadastrados.</td></tr>'}</tbody>
      <tfoot><tr>
        <td colspan="2">Total</td>
        <td style="text-align:center">${totalMeta}</td>
        <td style="text-align:center">${totalVendas}</td>
        <td style="text-align:center">${totalCancel}</td>
        <td style="text-align:center">${totalSaldo}</td>
        <td></td>
        <td style="text-align:center">${totalGap}</td>
        <td style="text-align:right">${fx(totalBonusMeta)}</td>
        <td style="text-align:right">${fx(totalBonusGap)}</td>
        <td style="text-align:right;background:#dcfce7;color:#166534">${fx(totalBonus)}</td>
      </tr></tfoot>
    </table>
    <div class="sup">
      <div><b>Supervisor:</b> ${esc(sup.nome || '—')}</div>
      <div>Total de Meta: <b>${sup.total_meta ?? '—'}</b> · Saldo do Mês: <b>${sup.total_saldo ?? '—'}</b> · Gap: <b>${sup.gap_meta ?? '—'}</b></div>
      <div>% Atingido: <b>${sup.percentual_atingido ?? '—'}%</b> · Faixa ${sup.faixa1_pct}% (${sup.alvo_faixa1} vendas): <b>${sup.bate_faixa1 ? 'SIM' : 'NÃO'}</b> · Faixa ${sup.faixa2_pct}% (${sup.alvo_faixa2} vendas): <b>${sup.bate_faixa2 ? 'SIM' : 'NÃO'}</b></div>
      <div class="premio">Valor Premiação: ${fx(sup.valor_premiacao)}${sup.pct_premio > 0 ? ` <span style="font-size:10px;color:#64748b;font-weight:400">(${sup.pct_premio}% de ${fx(sup.salario)})</span>` : ''}</div>
    </div>
  </body></html>`;
}

async function gerarPDFMetaComercial(dados) {
  return htmlParaPdf(montarHtmlMetaComercial(dados));
}

module.exports = { gerarPDFMetaComercial, montarHtmlMetaComercial };
