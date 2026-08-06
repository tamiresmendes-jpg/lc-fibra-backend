// Gera o PDF da Meta de Atendimento (Financeiro/Call Center): uma tabela por
// semana cheia (domingo→sábado) do mês, com o total de bônus (R$50 por atendente
// que bateu satisfação E taxa de resposta na semana) — mesmo motor via Chromium
// headless já usado na Meta do Comercial e nos POPs.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fx = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = iso => {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
};
const mesBR = (mesRef) => {
  const [a, m] = mesRef.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};
const emissao = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

function tabelaSemana(semana) {
  const { periodo, itens = [], resumo = {} } = semana;
  const linhas = itens.map(i => `
    <tr>
      <td style="font-weight:600">${esc(i.nome_completo || i.atendente)}</td>
      <td>${esc(i.departamento)}</td>
      <td style="text-align:center">${i.total}</td>
      <td style="text-align:center;background:#f8fafc">${i.validas}</td>
      <td style="text-align:center;background:#f8fafc">${i.invalidas}</td>
      <td style="text-align:center;color:#16a34a">${i.satisfeitas}</td>
      <td style="text-align:center;color:#dc2626">${i.insatisfeitas}</td>
      <td style="text-align:center;font-weight:700">${i.perc_satisfacao == null ? '—' : i.perc_satisfacao + '%'} ${i.bate_satisfacao ? '✓' : (i.perc_satisfacao == null ? '' : '✗')}</td>
      <td style="text-align:center;font-weight:700">${i.taxa_resposta}% ${i.bate_taxa ? '✓' : '✗'}</td>
      <td style="text-align:right;font-weight:700;color:${i.bonus_valor > 0 ? '#166534' : '#94a3b8'};background:${i.bonus_valor > 0 ? '#dcfce7' : 'transparent'}">${fx(i.bonus_valor)}</td>
    </tr>`).join('');
  return `
    <div class="semana">
      <div class="semana-titulo">Semana de ${dataBR(periodo.di)} a ${dataBR(periodo.df)}</div>
      <table>
        <thead><tr>
          <th>Atendente</th><th>Depto.</th><th>Total</th><th>Válidas</th><th>Inválidas</th>
          <th>Satisfeitas</th><th>Insatisfeitas</th><th>Satisfação</th><th>Taxa Resp.</th><th>Bônus</th>
        </tr></thead>
        <tbody>${linhas || '<tr><td colspan="10" style="text-align:center;padding:12px;color:#94a3b8">Sem atendimentos avaliados nesta semana.</td></tr>'}</tbody>
      </table>
      <div class="semana-resumo">
        Média de satisfação: <b>${resumo.media_satisfacao == null ? '—' : resumo.media_satisfacao + '%'}</b>
        &nbsp;·&nbsp; Taxa de resposta média: <b>${resumo.media_taxa_resposta == null ? '—' : resumo.media_taxa_resposta + '%'}</b>
        &nbsp;·&nbsp; Bateram ambas as metas: <b>${resumo.atingiram_ambas}/${resumo.atendentes_avaliados}</b>
        &nbsp;·&nbsp; Bônus da semana: <b style="color:#166534">${fx(resumo.bonus_total)}</b>
      </div>
    </div>`;
}

function montarHtmlMetaAtendimento(dados) {
  const { mes, semanas = [], bonus_total_mes = 0 } = dados;
  const totalAtendimentos = semanas.reduce((s, sem) => s + (sem.resumo?.total_atendimentos || 0), 0);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; margin: 24px; font-size: 12px; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .sub { color: #64748b; font-size: 11px; margin: 0 0 18px; }
    .semana { margin-bottom: 18px; page-break-inside: avoid; }
    .semana-titulo { background: #0f172a; color: #fff; font-weight: 700; padding: 6px 10px; border-radius: 6px 6px 0 0; font-size: 12.5px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e2e8f0; padding: 5px 7px; font-size: 11px; }
    th { background: #f1f5f9; text-align: left; }
    .semana-resumo { font-size: 11px; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; padding: 6px 10px; }
    .total-mes { margin-top: 10px; background: #dcfce7; border: 1px solid #86efac; border-radius: 8px; padding: 12px 16px; }
    .total-mes b { font-size: 15px; color: #166534; }
    .rodape { margin-top: 20px; font-size: 10px; color: #94a3b8; }
  </style></head><body>
    <h1>Meta de Atendimento — Financeiro e Call Center</h1>
    <div class="sub">${esc(mesBR(mes))} · ${semanas.length} semana(s) · ${totalAtendimentos} atendimento(s) avaliado(s) · Emitido em ${emissao()}</div>
    ${semanas.map(tabelaSemana).join('')}
    <div class="total-mes">Bônus total do mês (R$ 50,00 por atendente que bateu as duas metas em cada semana): <b>${fx(bonus_total_mes)}</b></div>
    <div class="rodape">Bônus de R$ 50,00 por atendente, por semana, quando satisfação e taxa de resposta atingem a meta configurada.</div>
  </body></html>`;
}

async function gerarPDFMetaAtendimento(dados) {
  return htmlParaPdf(montarHtmlMetaAtendimento(dados));
}

module.exports = { gerarPDFMetaAtendimento, montarHtmlMetaAtendimento };
