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
      <td style="text-align:center;font-weight:700;color:#0b2b6b">${i.nota_media != null ? i.nota_media.toFixed(2) : '—'}</td>
      <td style="text-align:center;font-weight:700">${i.taxa_resposta}% ${i.bate_taxa ? '✓' : '✗'}</td>
      <td style="text-align:right;font-weight:700;color:${i.bonus_valor > 0 ? '#166534' : '#94a3b8'};background:${i.bonus_valor > 0 ? '#dcfce7' : 'transparent'}">${fx(i.bonus_valor)}</td>
    </tr>`).join('');
  return `
    <div class="semana">
      <div class="semana-titulo">Semana de ${dataBR(periodo.di)} a ${dataBR(periodo.df)}</div>
      <table>
        <thead><tr>
          <th>Atendente</th><th>Depto.</th><th>Total</th><th>Válidas</th><th>Inválidas</th>
          <th>Satisfeitas</th><th>Insatisfeitas</th><th>Satisfação</th><th>Nota Média</th><th>Taxa Resp.</th><th>Bônus</th>
        </tr></thead>
        <tbody>${linhas || '<tr><td colspan="11" style="text-align:center;padding:12px;color:#94a3b8">Sem atendimentos avaliados nesta semana.</td></tr>'}</tbody>
      </table>
      <div class="semana-resumo">
        Média de satisfação: <b>${resumo.media_satisfacao == null ? '—' : resumo.media_satisfacao + '%'}</b>
        &nbsp;·&nbsp; Taxa de resposta média: <b>${resumo.media_taxa_resposta == null ? '—' : resumo.media_taxa_resposta + '%'}</b>
        &nbsp;·&nbsp; Bateram ambas as metas: <b>${resumo.atingiram_ambas}/${resumo.atendentes_avaliados}</b>
        &nbsp;·&nbsp; Bônus da semana: <b style="color:#166534">${fx(resumo.bonus_total)}</b>
      </div>
    </div>`;
}

function tabelaFechamento(fechamento) {
  if (!fechamento?.length) return '';
  const linhas = fechamento.map(f => `
    <tr>
      <td style="font-weight:600">${esc(f.nome)}</td>
      <td style="text-align:center">${f.semanas_bateu}/${f.semanas_total}</td>
      <td style="text-align:right;font-weight:800;color:#166534;background:#dcfce7">${fx(f.total_bonus)}</td>
    </tr>`).join('');
  const totalGeral = fechamento.reduce((s, f) => s + f.total_bonus, 0);
  return `
    <div class="fechamento">
      <div class="semana-titulo" style="background:#166534">Fechamento do mês — valor a pagar por atendente</div>
      <table>
        <thead><tr><th>Atendente</th><th>Semanas que bateu a meta</th><th>Total do mês</th></tr></thead>
        <tbody>${linhas}</tbody>
        <tfoot><tr><td colspan="2" style="text-align:right;font-weight:700">Total geral</td>
          <td style="text-align:right;font-weight:800;color:#166534">${fx(totalGeral)}</td></tr></tfoot>
      </table>
    </div>`;
}

function montarHtmlMetaAtendimento(dados) {
  const { mes, semanas = [], bonus_total_mes = 0, departamento, fechamento_mes = [] } = dados;
  const nomeDepto = departamento === 'Suporte' ? 'Call Center' : (departamento || 'Financeiro e Call Center');
  const totalAtendimentos = semanas.reduce((s, sem) => s + (sem.resumo?.total_atendimentos || 0), 0);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; margin: 8px 10px; font-size: 8px; line-height: 1.15; }
    h1 { font-size: 13px; margin: 0 0 1px; }
    .sub { color: #64748b; font-size: 8px; margin: 0 0 6px; }
    .semana { margin-bottom: 4px; }
    .semana-titulo { background: #0f172a; color: #fff; font-weight: 700; padding: 2px 6px; border-radius: 4px 4px 0 0; font-size: 8.5px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e2e8f0; padding: 1.5px 4px; font-size: 7.5px; }
    th { background: #f1f5f9; text-align: left; }
    .semana-resumo { font-size: 7.5px; color: #334155; background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; padding: 2px 6px; }
    .fechamento { margin-top: 4px; margin-bottom: 6px; }
    .total-mes { margin-top: 4px; background: #dcfce7; border: 1px solid #86efac; border-radius: 5px; padding: 4px 8px; }
    .total-mes b { font-size: 9px; color: #166534; }
    .rodape { margin-top: 4px; font-size: 6.5px; color: #94a3b8; }
  </style></head><body>
    <h1>Meta de Atendimento — ${esc(nomeDepto)}</h1>
    <div class="sub">${esc(mesBR(mes))} · ${semanas.length} semana(s) · ${totalAtendimentos} atendimento(s) avaliado(s) · Emitido em ${emissao()}</div>
    ${semanas.map(tabelaSemana).join('')}
    ${tabelaFechamento(fechamento_mes)}
    <div class="total-mes">Bônus total do mês (R$ 50,00 por atendente que bateu as duas metas em cada semana): <b>${fx(bonus_total_mes)}</b></div>
    <div class="rodape">Bônus de R$ 50,00 por atendente, por semana, quando satisfação e taxa de resposta atingem a meta configurada.</div>
  </body></html>`;
}

async function gerarPDFMetaAtendimento(dados) {
  return htmlParaPdf(montarHtmlMetaAtendimento(dados), null, { landscape: true });
}

module.exports = { gerarPDFMetaAtendimento, montarHtmlMetaAtendimento };
