// Gera a IMAGEM (PNG) do Relatório de Satisfação (Meta) no servidor, via Chromium headless,
// com o mesmo visual do relatório da tela. Usada no envio automático da Meta no Discord.
const { getBrowser } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const badge = ok => ok
  ? '<span style="color:#16a34a;font-weight:800">✓</span>'
  : '<span style="color:#dc2626;font-weight:800">✗</span>';
const perBR = d => String(d || '').split('-').reverse().join('/');
const fx = n => (n != null ? Number(n).toFixed(2) : null);

function montarHtmlMeta(deptLabel, di, df, itens, resumo, metas) {
  const linhas = (itens || []).map(m => `
    <tr style="${m.bonificacao ? 'background:#f0fdf4' : ''}">
      <td style="font-weight:600">${m.bonificacao ? '⭐ ' : ''}${esc(m.atendente)}</td>
      <td style="text-align:center;font-weight:700">${m.total}</td>
      <td style="text-align:center">${m.validas}</td>
      <td style="text-align:center">${m.invalidas}</td>
      <td style="text-align:center;color:#16a34a;font-weight:600">${m.satisfeitas}</td>
      <td style="text-align:center;color:${m.insatisfeitas ? '#dc2626' : '#334155'};font-weight:600">${m.insatisfeitas}</td>
      <td style="text-align:center;color:${m.bate_satisfacao ? '#16a34a' : '#dc2626'};font-weight:700;white-space:nowrap">${m.perc_satisfacao != null ? fx(m.perc_satisfacao) + '%' : '—'} ${m.perc_satisfacao != null ? badge(m.bate_satisfacao) : ''}</td>
      <td style="text-align:center;color:${m.bate_taxa ? '#16a34a' : '#dc2626'};font-weight:700;white-space:nowrap">${fx(m.taxa_resposta)}% ${badge(m.bate_taxa)}</td>
      <td style="font-size:12px;color:${m.bonificacao ? '#16a34a' : '#64748b'};font-weight:${m.bonificacao ? 700 : 400}">${esc(m.situacao)}</td>
    </tr>`).join('');

  const cards = [
    { l: 'Total de Atendimentos', v: resumo.total_atendimentos },
    { l: 'Atendentes Avaliados', v: resumo.atendentes_avaliados },
    { l: 'Média de Satisfação', v: resumo.media_satisfacao != null ? fx(resumo.media_satisfacao) + '%' : '—', cor: '#16a34a' },
    { l: 'Média Taxa de Resposta', v: resumo.media_taxa_resposta != null ? fx(resumo.media_taxa_resposta) + '%' : '—', cor: (resumo.media_taxa_resposta >= metas.taxa) ? '#16a34a' : '#dc2626' },
    { l: 'Atingiram ambas as metas', v: `${resumo.atingiram_ambas} de ${resumo.atendentes_avaliados}`, sub: `${resumo.perc_atingiram}%` },
  ].map(c => `<div style="text-align:center">
      <div style="font-size:11.5px;color:#64748b;font-weight:600">${c.l}</div>
      <div style="font-size:20px;font-weight:800;color:${c.cor || '#0b2b6b'}">${c.v}</div>
      ${c.sub ? `<div style="font-size:12px;color:#94a3b8">${c.sub}</div>` : ''}
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;background:#fff;padding:12px}
    #card{width:1000px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
    table{width:100%;border-collapse:collapse}
    th,td{padding:8px 10px;border-bottom:1px solid #eef2f6;font-size:13px;text-align:left;vertical-align:middle}
    thead tr{background:#eef2ff}
    th{font-weight:700;color:#334155}
  </style></head><body>
    <div id="card">
      <div style="background:#0b2b6b;color:#fff;padding:14px 18px;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:18px;font-weight:800;letter-spacing:.5px">RELATÓRIO DE SATISFAÇÃO — ${esc(deptLabel)}</div>
          <div style="font-size:12px;opacity:.85">Período: ${perBR(di)} a ${perBR(df)}</div>
        </div>
        <div style="display:flex;gap:18px;align-items:center">
          <div style="font-size:12px;text-align:center">Meta Satisfação<br><b>&ge; ${metas.satisfacao}%</b></div>
          <div style="font-size:12px;text-align:center">Meta Taxa Resposta<br><b>&ge; ${metas.taxa}%</b></div>
          <div style="font-size:12px;text-align:center">Atendentes<br><b style="font-size:18px">${resumo.atendentes_avaliados}</b></div>
        </div>
      </div>
      <table>
        <thead><tr>
          <th>Atendente</th>
          <th style="text-align:center">Total</th>
          <th style="text-align:center">Válidas</th>
          <th style="text-align:center">Inválidas</th>
          <th style="text-align:center;color:#16a34a">Satisfeitas</th>
          <th style="text-align:center;color:#dc2626">Insatisfeitas</th>
          <th style="text-align:center">Satisfação</th>
          <th style="text-align:center">Taxa Resposta</th>
          <th>Situação</th>
        </tr></thead>
        <tbody>${linhas || '<tr><td colspan="9" style="text-align:center;padding:20px;color:#94a3b8">Sem dados no período.</td></tr>'}</tbody>
      </table>
      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px;display:flex;gap:14px;justify-content:space-around;flex-wrap:wrap">${cards}</div>
    </div>
  </body></html>`;
}

async function gerarImagemMetaPng(deptLabel, di, df, itens, resumo, metas) {
  const html = montarHtmlMeta(deptLabel, di, df, itens, resumo, metas);
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1040, height: 900, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    const el = await page.$('#card');
    const buf = await el.screenshot({ type: 'png' });
    return Buffer.from(buf);
  } finally { await page.close(); }
}

module.exports = { gerarImagemMetaPng, montarHtmlMeta };
