// PDF "Volumetria de E-books" — documento pronto pra encaminhar ao
// financeiro: só o resumo por faixa (bruto e estimado pela aderência), com
// nome do sistema, quem gerou e data/hora já no cabeçalho.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));

const ESTILO = `
  @page{margin:10mm 12mm}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:11px;line-height:1.35}
  .cabecalho{background:#4f46e5;color:#fff;padding:14px 16px;margin-bottom:4px}
  .cabecalho h1{font-size:17px}
  .cabecalho .sub{font-size:10px;opacity:.9;margin-top:4px}
  .meta{margin:10px 16px;font-size:10px;color:#64748b}
  h2{font-size:13px;margin:16px 16px 6px}
  table{width:100%;border-collapse:collapse;margin:0 16px;width:calc(100% - 32px)}
  th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left;font-size:10px}
  th{background:#eef2ff;color:#4f46e5;text-transform:uppercase;font-size:9px}
  td.num{text-align:right}
  tr.total td{font-weight:700;background:#f8fafc}
  .rodape{margin:16px 16px 0;border-top:1px solid #e2e8f0;padding-top:6px;font-size:9px;color:#94a3b8;text-align:center}
`;

function linhaResumo(r) {
  return `<tr>
    <td>${esc(r.faixa)}</td>
    <td class="num">${esc(r.quantidade_livros_por_cliente)}</td>
    <td class="num">${fmtNum(r.clientes)}</td>
    <td class="num">${fmtNum(r.total_livros)}</td>
    <td class="num">${fmtNum(r.clientes_estimado)}</td>
    <td class="num">${fmtNum(r.total_livros_estimado)}</td>
  </tr>`;
}

function montarHtmlRelatorioLivrosSva(relatorio, { nomeUsuario } = {}) {
  const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const temEstimativa = relatorio.total_geral_estimado != null;
  const janela = (relatorio.aderencia_janela_meses || []).join(', ');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    <div class="cabecalho">
      <h1>Kronos — Volumetria de E-books (SVA "LC+ Livros")</h1>
      <div class="sub">Gerado por ${esc(nomeUsuario || '—')} em ${esc(geradoEm)}</div>
    </div>
    <div class="meta">
      ${relatorio.aderencia_manual_por_plano
        ? 'Coluna "estimado" usa percentuais manuais definidos por faixa na hora da exportação (não é a aderência real calculada pelo sistema).'
        : relatorio.aderencia_manual_pct != null
          ? `Coluna "estimado" usa o percentual manual de ${relatorio.aderencia_manual_pct.toFixed(0)}% definido na hora da exportação (não é a aderência real calculada pelo sistema).`
          : temEstimativa
            ? `Coluna "estimado" considera a aderência real de faturamento (últimos meses fechados: ${esc(janela)}) — desconta clientes que venceram bloqueados, inativos ou cancelados e não recebem nota naquele ciclo.`
            : 'Aderência ainda não calculada para esta empresa (roda de madrugada) — os números abaixo são o total de clientes ativos, sem desconto por bloqueio/inadimplência.'}
    </div>

    <h2>Resumo por faixa</h2>
    <table>
      <thead><tr>
        <th>Plano</th><th>Livros/cliente</th><th>Clientes ativos</th><th>Total (bruto)</th>
        <th>Clientes estimados</th><th>Total estimado</th>
      </tr></thead>
      <tbody>
        ${(relatorio.resumo || []).map(linhaResumo).join('')}
        <tr class="total">
          <td colspan="3">Total geral</td>
          <td class="num">${fmtNum((relatorio.resumo || []).reduce((s, r) => s + (r.total_livros || 0), 0))}</td>
          <td class="num">${fmtNum((relatorio.resumo || []).reduce((s, r) => s + (r.clientes_estimado || 0), 0))}</td>
          <td class="num">${fmtNum(relatorio.total_geral_estimado)}</td>
        </tr>
      </tbody>
    </table>

    <div class="rodape">Kronos — Análise de E-books — gerado automaticamente, não é documento fiscal</div>
  </body></html>`;
}

async function gerarPDFLivrosSva(relatorio, opts) {
  return htmlParaPdf(montarHtmlRelatorioLivrosSva(relatorio, opts));
}

module.exports = { gerarPDFLivrosSva, montarHtmlRelatorioLivrosSva };
