// Geração de PDF FIEL à visualização, via Chromium headless (puppeteer).
// Monta um HTML com o mesmo conteúdo/estrutura da tela do POP e converte em PDF.
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { conteudoParaHtml, parseLista } = require('./gerarPDF');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Converte <img src="/uploads/..."> em data URI (para o Chromium renderizar offline)
function inlineImagens(html) {
  if (!html) return '';
  return html.replace(/<img([^>]*?)src\s*=\s*"([^"]*)"([^>]*)>/gi, (m, pre, src, pos) => {
    try {
      if (src.startsWith('data:')) return m;
      const mUp = src.match(/\/uploads\/([^?#"']+)/);
      if (mUp) {
        const fp = path.join(UPLOADS_DIR, decodeURIComponent(mUp[1]));
        if (fs.existsSync(fp)) {
          const ext = path.extname(fp).slice(1).toLowerCase() || 'png';
          const mime = ({ jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif', webp: 'webp', svg: 'svg+xml' })[ext] || 'png';
          const b64 = fs.readFileSync(fp).toString('base64');
          return `<img${pre}src="data:image/${mime};base64,${b64}"${pos}>`;
        }
      }
    } catch { /* ignora */ }
    return m; // externas: mantém (podem não carregar)
  });
}

function secaoHtml(num, titulo, conteudo) {
  const html = conteudoParaHtml(conteudo);
  let corpo;
  if (html != null) corpo = inlineImagens(html);
  else if (conteudo && String(conteudo).trim()) corpo = `<p>${esc(conteudo).replace(/\n/g, '<br>')}</p>`;
  else corpo = `<p class="vazio">(seção não preenchida)</p>`;
  return `<section class="sec"><h2><span class="n">${num}</span> ${esc(titulo)}</h2><div class="corpo">${corpo}</div></section>`;
}

// colunas: [{ label, key }] — renderiza apenas os campos indicados (evita colunas extras como "id")
function tabelaHtml(num, titulo, colunas, linhas) {
  if (!linhas || !linhas.length)
    return `<section class="sec"><h2><span class="n">${num}</span> ${esc(titulo)}</h2><div class="corpo"><p class="vazio">(seção não preenchida)</p></div></section>`;
  const head = colunas.map(c => `<th>${esc(c.label)}</th>`).join('');
  const body = linhas.map(l => `<tr>${colunas.map(c => `<td>${esc(l[c.key] || '')}</td>`).join('')}</tr>`).join('');
  return `<section class="sec"><h2><span class="n">${num}</span> ${esc(titulo)}</h2>
    <div class="corpo"><table class="tab"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div></section>`;
}

function fmtData(d) {
  if (!d) return '—';
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + 'T00:00:00').toLocaleDateString('pt-BR');
    return new Date(d).toLocaleDateString('pt-BR');
  } catch { return String(d); }
}

function montarHtmlPOP(pop) {
  const status = { ativo: 'ATIVO', rascunho: 'RASCUNHO', revisao: 'EM REVISÃO', inativo: 'INATIVO' }[pop.status] || (pop.status || '').toUpperCase();
  const ident = [
    ['Empresa', pop.empresa_nome || 'LC FIBRA'],
    ['Elaborado por', pop.criado_por_nome || '—'],
    ['Cargo', pop.cargo_nome || '—'],
    ['Versão', `v${pop.versao || '1.0'}`],
    ['Departamento(s)', pop.departamentos_nomes || pop.departamento_nome || '—'],
    ['Data', fmtData(pop.data_elaboracao || pop.created_at)],
  ];
  const identHtml = ident.map(([l, v]) => `<div class="id-cel"><span class="id-lbl">${esc(l)}</span><span class="id-val">${esc(v)}</span></div>`).join('');

  const respLinhas = parseLista(pop.responsabilidade);
  const dispLinhas = parseLista(pop.disposicao_final);

  const secoes = [
    secaoHtml(2, 'Objetivo', pop.objetivo),
    secaoHtml(3, 'Campo de Aplicação', pop.campo_aplicacao),
    respLinhas ? tabelaHtml(4, 'Responsabilidades', [{ label: 'Nome / Cargo', key: 'cargo_nome' }, { label: 'Responsabilidade', key: 'responsabilidade' }], respLinhas)
               : secaoHtml(4, 'Responsabilidades', pop.responsabilidade),
    secaoHtml(5, 'Procedimento Detalhado', pop.procedimento),
    secaoHtml(6, 'Documentos e Ferramentas', pop.documentos),
    secaoHtml(7, 'Segurança e Conduta', pop.seguranca),
    secaoHtml(8, 'Penalidades', pop.penalidade),
    dispLinhas ? tabelaHtml(9, 'Disposições Finais', [{ label: 'Item', key: 'item' }, { label: 'Destino / Ação Final', key: 'destino' }, { label: 'Responsável', key: 'responsavel' }], dispLinhas)
               : secaoHtml(9, 'Disposições Finais', pop.disposicao_final),
    pop.kpis ? secaoHtml('+', 'KPIs e Indicadores', pop.kpis) : '',
  ].join('');

  return `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #1e293b; margin: 0; font-size: 12px; line-height: 1.5; }
    .cabecalho { background: #7B55F1; color: #fff; padding: 22px 28px; }
    .cabecalho .top { display: flex; justify-content: space-between; align-items: baseline; }
    .cabecalho .marca { font-size: 20px; font-weight: 800; letter-spacing: .5px; }
    .cabecalho .cod { font-size: 12px; opacity: .9; }
    .cabecalho h1 { font-size: 17px; margin: 8px 0 6px; font-weight: 700; }
    .cabecalho .desc { font-size: 11.5px; opacity: .92; margin: 0; }
    .badge { display: inline-block; margin-top: 10px; background: rgba(255,255,255,.22); border-radius: 5px; padding: 2px 10px; font-size: 10px; font-weight: 700; }
    .wrap { padding: 20px 28px; }
    .id-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: #e2e8f0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; margin-bottom: 18px; }
    .id-cel { background: #f8fafc; padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; }
    .id-lbl { font-size: 8.5px; color: #64748b; text-transform: uppercase; let-spacing: .04em; font-weight: 700; }
    .id-val { font-size: 12px; font-weight: 600; color: #0f172a; }
    .sec { margin: 14px 0; page-break-inside: avoid; }
    .sec h2 { font-size: 13px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 8px; margin: 0 0 8px; }
    .sec h2 .n { background: #7B55F1; color: #fff; width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; flex-shrink: 0; }
    .corpo { padding-left: 28px; }
    .corpo p { margin: 0 0 8px; }
    .corpo img { max-width: 100%; border-radius: 6px; margin: 6px 0; }
    .corpo h1,.corpo h2,.corpo h3,.corpo h4 { color: #0f172a; margin: 12px 0 6px; }
    .corpo ul,.corpo ol { margin: 6px 0; padding-left: 22px; }
    .corpo li { margin: 2px 0; }
    .corpo blockquote { border-left: 3px solid #cbd5e1; margin: 8px 0; padding: 2px 0 2px 12px; color: #64748b; }
    .corpo table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 11.5px; }
    .corpo td, .corpo th { border: 1px solid #e2e8f0; padding: 6px 9px; vertical-align: top; text-align: left; }
    .corpo .vazio { color: #94a3b8; font-style: italic; }
    .corpo a { color: #7B55F1; }
    .corpo pre { background: #f1f5f9; padding: 10px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; }
    table.tab { border-collapse: collapse; width: 100%; font-size: 11.5px; }
    table.tab th { background: #f8fafc; color: #64748b; text-transform: uppercase; font-size: 9px; }
    table.tab th, table.tab td { border: 1px solid #e2e8f0; padding: 7px 10px; text-align: left; vertical-align: top; }
  </style></head><body>
    <div class="cabecalho">
      <div class="top"><span class="marca">LC FIBRA</span><span class="cod">${esc(pop.codigo || '')}</span></div>
      <h1>${esc(pop.titulo || 'Procedimento Operacional Padrão')}</h1>
      ${pop.descricao ? `<p class="desc">${esc(pop.descricao)}</p>` : ''}
      <span class="badge">${esc(status || 'RASCUNHO')}</span>
    </div>
    <div class="wrap">
      <section class="sec"><h2><span class="n">1</span> Identificação</h2></section>
      <div class="id-grid">${identHtml}</div>
      ${secoes}
    </div>
  </body></html>`;
}

let _browserPromise = null;
async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return _browserPromise;
}

async function htmlParaPdf(html, browser) {
  const b = browser || await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '0', bottom: '14mm', left: '0', right: '0' },
    });
    return Buffer.from(pdf); // puppeteer pode retornar Uint8Array
  } finally { await page.close(); }
}

// Gera o PDF fiel de um POP. Aceita um browser compartilhado (para exportar em lote).
async function gerarPDFPOPHtml(pop, browser) {
  return htmlParaPdf(montarHtmlPOP(pop), browser);
}

module.exports = { gerarPDFPOPHtml, getBrowser, htmlParaPdf, montarHtmlPOP };
