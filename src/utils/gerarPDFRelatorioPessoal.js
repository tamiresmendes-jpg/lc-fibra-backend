// PDF "Relatório de Pessoal por Departamento" — a usuária escolhe, na tela de
// Usuários, exatamente quem entra (seleciona as linhas e clica em "Relatório
// PDF"); aqui só agrupamos por departamento, com contagem por setor e total
// geral no rodapé. Mesmo padrão visual (Chromium headless) dos outros PDFs.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function agruparPorDepartamento(usuarios) {
  const mapa = new Map();
  for (const u of usuarios) {
    const depto = u.departamento_nome || 'Sem departamento';
    if (!mapa.has(depto)) mapa.set(depto, []);
    mapa.get(depto).push(u);
  }
  return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR'));
}

function montarHtml(usuarios, { empresaNome, nomeUsuario } = {}) {
  const grupos = agruparPorDepartamento(usuarios);
  const totalGeral = usuarios.length;
  const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const secoes = grupos.map(([depto, pessoas]) => {
    const ordenadas = [...pessoas].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    const linhas = ordenadas.map(p => `<tr><td>${esc(p.nome)}</td><td>${esc(p.cargo_nome || '—')}</td></tr>`).join('');
    const plural = pessoas.length === 1 ? 'pessoa' : 'pessoas';
    return `<section class="sec">
      <h2>${esc(depto)} <span class="qtd">${pessoas.length} ${plural}</span></h2>
      <table><thead><tr><th>Nome</th><th>Cargo</th></tr></thead><tbody>${linhas}</tbody></table>
    </section>`;
  }).join('');

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 0; font-size: 12px; line-height: 1.5; }
    .cabecalho { background: #7B55F1; color: #fff; padding: 22px 28px; }
    .cabecalho .marca { font-size: 20px; font-weight: 800; letter-spacing: .5px; }
    .cabecalho h1 { font-size: 17px; margin: 8px 0 4px; font-weight: 700; }
    .cabecalho .sub { font-size: 11px; opacity: .9; }
    .wrap { padding: 20px 28px; }
    .sec { margin: 0 0 16px; page-break-inside: avoid; }
    .sec h2 { font-size: 13px; font-weight: 700; color: #0f172a; margin: 0 0 6px; display: flex; align-items: baseline; gap: 8px; border-bottom: 2px solid #7B55F1; padding-bottom: 4px; }
    .sec h2 .qtd { font-size: 10px; font-weight: 600; color: #7B55F1; background: #ede9fe; border-radius: 10px; padding: 2px 9px; }
    table { border-collapse: collapse; width: 100%; font-size: 11px; }
    th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; }
    th { background: #f8fafc; color: #64748b; text-transform: uppercase; font-size: 9px; }
    .total-geral { margin-top: 10px; background: #f1f5f9; border-radius: 8px; padding: 12px 16px; font-size: 12.5px; font-weight: 700; color: #0f172a; text-align: right; }
  </style></head><body>
    <div class="cabecalho">
      <span class="marca">${esc(empresaNome || 'LC Virtual Net')}</span>
      <h1>Relatório de Pessoal por Departamento</h1>
      <div class="sub">Gerado em ${agora}${nomeUsuario ? ' por ' + esc(nomeUsuario) : ''}</div>
    </div>
    <div class="wrap">
      ${secoes}
      <div class="total-geral">TOTAL GERAL: ${totalGeral} colaborador${totalGeral === 1 ? '' : 'es'} em ${grupos.length} departamento${grupos.length === 1 ? '' : 's'}</div>
    </div>
  </body></html>`;
}

async function gerarPDFRelatorioPessoal(usuarios, opcoes = {}) {
  return htmlParaPdf(montarHtml(usuarios, opcoes));
}

module.exports = { gerarPDFRelatorioPessoal };
