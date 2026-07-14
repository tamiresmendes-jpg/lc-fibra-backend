const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

const COR_PRIMARIA = '#7B55F1';
const COR_TEXTO    = '#0f172a';
const COR_SUBTEXTO = '#64748b';
const COR_BORDA    = '#e2e8f0';
const COR_FUNDO    = '#f8fafc';

function parseLista(valor) {
  if (!valor) return null;
  try {
    const p = JSON.parse(valor);
    return Array.isArray(p) && p.length > 0 ? p : null;
  } catch { return null; }
}

// Para campos que podem conter JSON de tabela (responsabilidade/disposicao_final):
// quando não há linhas válidas, evita imprimir o texto cru "[]" — devolve vazio (placeholder).
function fallbackTexto(val) {
  if (!val) return '';
  return String(val).trim().startsWith('[') ? '' : val;
}

// Remove marcação HTML (vinda do editor rich text) e devolve texto puro com quebras de linha.
function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|h[1-6]|tr|ol|ul|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(apos|#39);/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── Renderização de HTML rico (títulos, listas, negrito, imagens, tabelas) ─────
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
    .replace(/&nbsp;/gi, ' ').replace(/&(apos|#39);/gi, "'")
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
}

// Carrega uma imagem do <img src> como Buffer (base64 ou arquivo em /uploads).
function carregarImagem(src) {
  try {
    if (!src) return null;
    if (src.startsWith('data:')) {
      const b64 = src.split(',')[1];
      return b64 ? Buffer.from(b64, 'base64') : null;
    }
    const mUp = src.match(/\/uploads\/([^?#"']+)/);
    if (mUp) {
      const fp = path.join(UPLOADS_DIR, decodeURIComponent(mUp[1]));
      if (fs.existsSync(fp)) return fs.readFileSync(fp);
    }
  } catch { /* ignora */ }
  return null; // URLs externas não são baixadas (evita dependências de rede)
}

function desenharImagem(doc, buf, indent) {
  try {
    const img = doc.openImage(buf);
    const usableW = doc.page.width - doc.page.margins.left - doc.page.margins.right - indent - 4;
    let w = img.width, h = img.height;
    const escala = Math.min(1, usableW / w);
    w *= escala; h *= escala;
    const maxH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    if (h > maxH) { const s2 = maxH / h; w *= s2; h *= s2; }
    if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    doc.image(img, doc.page.margins.left + indent, doc.y, { width: w });
    doc.y += h + 8;
  } catch { /* imagem inválida: ignora */ }
}

function parseTokens(html) {
  const tokens = [];
  const re = /<\/?([a-zA-Z0-9]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] !== undefined) tokens.push({ t: 'text', text: decodeEntities(m[4]) });
    else tokens.push({ t: m[0].startsWith('</') ? 'close' : 'open', name: m[1].toLowerCase(), attrs: m[2] || '' });
  }
  return tokens;
}

// Renderiza HTML do editor no PDF preservando estrutura, formatação e imagens.
function renderRichHtml(doc, html, baseIndent = 10) {
  const tokens = parseTokens(html);
  let runs = [];
  let bold = 0, italic = 0;
  const listas = [];      // pilha { tipo:'ul'|'ol', n }
  let heading = 0;        // nível de título atual (1-4)
  let quote = false;
  let capImg = false;     // dentro de <figcaption>
  const left = doc.page.margins.left;

  function nivelIndent() { return baseIndent + listas.length * 14; }

  function flush(prefix, opts = {}) {
    const texto = runs.map(r => r.text).join('');
    if (!texto.trim() && !prefix) { runs = []; return; }
    const indent = opts.indent != null ? opts.indent : nivelIndent();
    const size = opts.size || 10;
    const color = opts.color || '#374151';
    doc.fillColor(color);
    if (doc.y > doc.page.height - doc.page.margins.bottom - 20) doc.addPage();
    let first = true;
    const seq = runs.length ? runs : [{ text: '', bold: 0, italic: 0 }];
    seq.forEach((r, i) => {
      const b = r.bold || opts.bold, it = r.italic || opts.italic;
      const font = b && it ? 'Helvetica-BoldOblique' : b ? 'Helvetica-Bold' : it ? 'Helvetica-Oblique' : 'Helvetica';
      doc.font(font).fontSize(size);
      const isLast = i === seq.length - 1;
      const txt = (first && prefix ? prefix : '') + r.text;
      first = false;
      doc.text(txt, { continued: !isLast, indent, align: opts.align });
    });
    runs = [];
    if (opts.gap !== 0) doc.moveDown(opts.gap || 0.25);
  }

  for (const tk of tokens) {
    if (tk.t === 'text') {
      const clean = tk.text.replace(/\s+/g, ' ');
      if (capImg) { // legenda da imagem
        if (clean.trim()) doc.fillColor(COR_SUBTEXTO).font('Helvetica-Oblique').fontSize(8)
          .text(clean.trim(), { indent: baseIndent, align: 'center' });
        continue;
      }
      if (clean) runs.push({ text: clean, bold, italic });
      continue;
    }
    const n = tk.name;
    if (tk.t === 'open') {
      if (n === 'b' || n === 'strong') bold++;
      else if (n === 'i' || n === 'em') italic++;
      else if (n === 'br') runs.push({ text: '\n', bold, italic });
      else if (n === 'p') flush();
      else if (/^h[1-4]$/.test(n)) { flush(); heading = Number(n[1]); }
      else if (n === 'blockquote') { flush(); quote = true; }
      else if (n === 'ul') { flush(); listas.push({ tipo: 'ul' }); }
      else if (n === 'ol') { flush(); listas.push({ tipo: 'ol', num: 0 }); }
      else if (n === 'li') { flush(); }
      else if (n === 'hr') {
        flush();
        doc.moveDown(0.2);
        doc.moveTo(left + baseIndent, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
          .strokeColor(COR_BORDA).lineWidth(0.5).stroke();
        doc.moveDown(0.4);
      }
      else if (n === 'img') {
        flush();
        const mSrc = tk.attrs.match(/src\s*=\s*"([^"]*)"/i) || tk.attrs.match(/src\s*=\s*'([^']*)'/i);
        const buf = mSrc ? carregarImagem(mSrc[1]) : null;
        if (buf) desenharImagem(doc, buf, baseIndent);
      }
      else if (n === 'figcaption') capImg = true;
      else if (n === 'pre' || n === 'code') { /* tratado no texto */ }
    } else { // close
      if (n === 'b' || n === 'strong') bold = Math.max(0, bold - 1);
      else if (n === 'i' || n === 'em') italic = Math.max(0, italic - 1);
      else if (n === 'p') flush(null, { gap: 0.35 });
      else if (/^h[1-4]$/.test(n)) {
        const sz = { 1: 14, 2: 13, 3: 12, 4: 11 }[heading] || 12;
        flush(null, { size: sz, bold: 1, color: COR_TEXTO, gap: 0.35 });
        heading = 0;
      }
      else if (n === 'blockquote') { flush(null, { italic: 1, color: COR_SUBTEXTO, indent: baseIndent + 12, gap: 0.35 }); quote = false; }
      else if (n === 'li') {
        const lst = listas[listas.length - 1];
        let prefix = '• ';
        if (lst && lst.tipo === 'ol') { lst.num = (lst.num || 0) + 1; prefix = `${lst.num}. `; }
        flush(prefix, { indent: nivelIndent(), gap: 0.15 });
      }
      else if (n === 'ul' || n === 'ol') { flush(); listas.pop(); }
      else if (n === 'figcaption') capImg = false;
    }
  }
  flush();
}

function ehHtml(s) { return typeof s === 'string' && /<(p|h[1-4]|ul|ol|li|img|figure|table|div|br|blockquote|strong|b|em|pre)\b|<hr/i.test(s); }

// Converte blocos (novo formato JSON do editor) em HTML, espelhando o front.
function escBk(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function blocosBkParaHtml(blocks) { return (blocks || []).map(blocoBkParaHtml).join('\n'); }
function blocoBkParaHtml(b) {
  if (!b || !b.type) return '';
  const t = b.type;
  if (t === 'paragraph') return `<p>${b.content || ''}</p>`;
  if (/^heading[1-4]$/.test(t)) return `<h${t.slice(-1)}>${b.content || ''}</h${t.slice(-1)}>`;
  if (t === 'quote') return `<blockquote>${b.content || ''}</blockquote>`;
  if (t === 'divider') return '<hr/>';
  if (t === 'code') return `<pre>${escBk(b.content)}</pre>`;
  if (t === 'bullet_list') return `<ul>${(b.items || []).map(i => `<li>${i.content || ''}</li>`).join('')}</ul>`;
  if (t === 'numbered_list') return `<ol>${(b.items || []).map(i => `<li>${i.content || ''}</li>`).join('')}</ol>`;
  if (t === 'check_list') return `<ul>${(b.items || []).map(i => `<li>${i.checked ? '☑ ' : '☐ '}${i.content || ''}</li>`).join('')}</ul>`;
  if (t === 'table') return `<table>${(b.cells || []).map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
  if (t.startsWith('callout_')) return `<p>${b.content || ''}</p>`;
  if (t === 'image' && b.url) return `<figure><img src="${escBk(b.url)}"/>${b.caption ? `<figcaption>${escBk(b.caption)}</figcaption>` : ''}</figure>`;
  if (t === 'pop_link' && b.popId) return `<p><strong>→ ${escBk(b.popTitulo || 'POP')}</strong></p>`;
  if (t.startsWith('columns')) return (b.columns || []).map(col => blocosBkParaHtml(col)).join('');
  if (t === 'diagram') return `<pre>${escBk(b.code)}</pre>`;
  return b.content ? `<p>${b.content}</p>` : '';
}
// Se o conteúdo for JSON de blocos, converte para HTML; se já for HTML, retorna; senão null.
function conteudoParaHtml(conteudo) {
  if (typeof conteudo !== 'string') return null;
  const s = conteudo.trim();
  if (s.startsWith('[')) {
    try { const p = JSON.parse(s); if (Array.isArray(p) && p[0] && p[0].type) return blocosBkParaHtml(p); } catch { /* não é JSON de blocos */ }
  }
  return ehHtml(conteudo) ? conteudo : null;
}

function secao(doc, numero, titulo, conteudo) {
  doc.moveDown(0.5);

  // Cabeçalho da seção
  const circleX = doc.page.margins.left + 10;
  const circleY = doc.y + 2;
  doc.circle(circleX, circleY + 6, 10).fill(COR_PRIMARIA);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
    .text(String(numero), circleX - 4, circleY + 2, { width: 8, align: 'center' });

  doc.fillColor(COR_TEXTO).font('Helvetica-Bold').fontSize(12)
    .text(titulo, doc.page.margins.left + 26, circleY, { continued: false });

  doc.moveDown(0.4);

  // Conteúdo: JSON de blocos ou HTML rico são renderizados com formatação e imagens; texto simples mantém o fluxo antigo.
  const htmlRico = conteudoParaHtml(conteudo);
  if (htmlRico != null) {
    renderRichHtml(doc, htmlRico, 10);
  } else {
  const texto = stripHtml(conteudo);
  if (texto) {
    doc.fillColor('#374151').font('Helvetica').fontSize(10);
    texto.split('\n').forEach(linha => {
      if (linha.trim()) doc.text(linha.trim(), { indent: 10 });
      else doc.moveDown(0.3);
    });
  } else {
    doc.fillColor('#94a3b8').font('Helvetica-Oblique').fontSize(9)
      .text('(seção não preenchida)', { indent: 10 });
  }
  }

  doc.moveDown(0.6);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(COR_BORDA).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

function secaoTabela(doc, numero, titulo, colunas, linhas) {
  doc.moveDown(0.5);

  const circleX = doc.page.margins.left + 10;
  const circleY = doc.y + 2;
  doc.circle(circleX, circleY + 6, 10).fill(COR_PRIMARIA);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
    .text(String(numero), circleX - 4, circleY + 2, { width: 8, align: 'center' });

  doc.fillColor(COR_TEXTO).font('Helvetica-Bold').fontSize(12)
    .text(titulo, doc.page.margins.left + 26, circleY);

  doc.moveDown(0.6);

  const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidth = usableWidth / colunas.length;
  const tableLeft = doc.page.margins.left;
  let rowY = doc.y;
  const rowH = 22;

  // Header da tabela
  doc.rect(tableLeft, rowY, usableWidth, rowH).fill(COR_FUNDO);
  doc.rect(tableLeft, rowY, usableWidth, rowH).strokeColor(COR_BORDA).lineWidth(0.5).stroke();
  doc.fillColor(COR_SUBTEXTO).font('Helvetica-Bold').fontSize(9);
  colunas.forEach((col, i) => {
    doc.text(col.toUpperCase(), tableLeft + i * colWidth + 6, rowY + 7, { width: colWidth - 12 });
  });
  rowY += rowH;

  // Linhas da tabela
  linhas.forEach((row, ri) => {
    const values = Object.values(row).filter(v => v !== undefined);
    const cellH = rowH;
    if (ri % 2 === 0) doc.rect(tableLeft, rowY, usableWidth, cellH).fill('#ffffff');
    else doc.rect(tableLeft, rowY, usableWidth, cellH).fill('#fafafa');
    doc.rect(tableLeft, rowY, usableWidth, cellH).strokeColor(COR_BORDA).lineWidth(0.3).stroke();

    doc.fillColor(COR_TEXTO).font('Helvetica').fontSize(9);
    values.forEach((val, i) => {
      doc.text(String(val || '—'), tableLeft + i * colWidth + 6, rowY + 7, {
        width: colWidth - 12,
        ellipsis: true,
        lineBreak: false,
      });
    });
    rowY += cellH;
  });

  doc.y = rowY;
  doc.moveDown(0.8);
}

/**
 * Gera o PDF completo de um POP e retorna um Buffer.
 * @param {Object} pop - Objeto do POP com todos os campos
 * @returns {Promise<Buffer>}
 */
function gerarPDFPOP(pop) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 60, left: 50, right: 50 },
      info: {
        Title: `${pop.codigo || 'POP'} - ${pop.titulo}`,
        Author: pop.criado_por_nome || 'Sistema LC FIBRA',
        Subject: 'Procedimento Operacional Padrão',
        Creator: 'LC FIBRA - Sistema de Gestão',
      },
    });

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const marginL = doc.page.margins.left;
    const marginR = doc.page.margins.right;

    // ── CABEÇALHO ──
    // Fundo roxo
    doc.rect(0, 0, pageW, 130).fill(COR_PRIMARIA);

    // Empresa e código
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
      .text('LC FIBRA', marginL, 24, { align: 'left' });

    if (pop.codigo) {
      doc.font('Helvetica').fontSize(11)
        .text(pop.codigo, pageW - marginR - 80, 28, { width: 80, align: 'right' });
    }

    // Título do POP
    doc.font('Helvetica-Bold').fontSize(15)
      .text(pop.titulo || 'Procedimento Operacional Padrão', marginL, 55, {
        width: pageW - marginL - marginR,
      });

    if (pop.descricao) {
      doc.font('Helvetica').fontSize(10).fillColor('rgba(255,255,255,0.85)')
        .text(pop.descricao, marginL, doc.y + 4, { width: pageW - marginL - marginR });
    }

    // Status badge
    const statusLabel = {
      ativo: 'ATIVO', rascunho: 'RASCUNHO', revisao: 'EM REVISÃO', inativo: 'INATIVO'
    }[pop.status] || pop.status?.toUpperCase() || 'RASCUNHO';

    doc.roundedRect(marginL, 108, 70, 16, 4).fill('rgba(255,255,255,0.25)');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8)
      .text(statusLabel, marginL + 4, 112, { width: 62, align: 'center' });

    // ── 1. IDENTIFICAÇÃO (cabeçalho da seção) ──
    const idHeadY = 138;
    doc.circle(marginL + 10, idHeadY + 8, 10).fill(COR_PRIMARIA);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
      .text('1', marginL + 6, idHeadY + 4, { width: 8, align: 'center' });
    doc.fillColor(COR_TEXTO).font('Helvetica-Bold').fontSize(12)
      .text('Identificação', marginL + 26, idHeadY + 2);

    // ── GRADE DE IDENTIFICAÇÃO ──
    const gridTop = 162;
    const gridH = 64;
    doc.rect(marginL, gridTop, pageW - marginL - marginR, gridH)
      .fill(COR_FUNDO).strokeColor(COR_BORDA).lineWidth(0.5).stroke();

    const idCols = [
      { label: 'Empresa',        valor: pop.empresa_nome || 'LC FIBRA' },
      { label: 'Elaborado por',  valor: pop.criado_por_nome || '—' },
      { label: 'Cargo',          valor: pop.cargo_nome || '—' },
      { label: 'Versão',         valor: `v${pop.versao || '1.0'}` },
      { label: 'Departamento',   valor: pop.departamentos_nomes || pop.departamento_nome || '—' },
      { label: 'Data',           valor: pop.data_elaboracao
          ? new Date(pop.data_elaboracao + 'T00:00:00').toLocaleDateString('pt-BR')
          : new Date(pop.created_at).toLocaleDateString('pt-BR') },
    ];

    const idW = (pageW - marginL - marginR) / idCols.length;
    idCols.forEach((item, i) => {
      const x = marginL + i * idW;
      if (i > 0) {
        doc.moveTo(x, gridTop + 8).lineTo(x, gridTop + gridH - 8)
          .strokeColor(COR_BORDA).lineWidth(0.5).stroke();
      }
      doc.fillColor(COR_SUBTEXTO).font('Helvetica').fontSize(7)
        .text(item.label.toUpperCase(), x + 6, gridTop + 10, { width: idW - 12 });
      doc.fillColor(COR_TEXTO).font('Helvetica-Bold').fontSize(9.5)
        .text(item.valor, x + 6, gridTop + 24, { width: idW - 12, ellipsis: true });
    });

    doc.y = gridTop + gridH + 20;

    // ── SEÇÕES 2 a 9 — sempre exibidas, mesmo vazias (documento oficial padronizado) ──
    secao(doc, 2, 'Objetivo', pop.objetivo);
    secao(doc, 3, 'Campo de Aplicação', pop.campo_aplicacao);

    const linhasResp = parseLista(pop.responsabilidade);
    if (linhasResp)
      secaoTabela(doc, 4, 'Responsabilidades', ['Nome / Cargo', 'Responsabilidade'], linhasResp);
    else
      secao(doc, 4, 'Responsabilidades', fallbackTexto(pop.responsabilidade));

    secao(doc, 5, 'Procedimento Detalhado', pop.procedimento);
    secao(doc, 6, 'Documentos e Ferramentas', pop.documentos);
    secao(doc, 7, 'Segurança e Conduta', pop.seguranca);
    secao(doc, 8, 'Penalidades', pop.penalidade);

    const linhasDisp = parseLista(pop.disposicao_final);
    if (linhasDisp)
      secaoTabela(doc, 9, 'Disposições Finais', ['Item', 'Destino / Ação Final', 'Responsável'], linhasDisp);
    else
      secao(doc, 9, 'Disposições Finais', fallbackTexto(pop.disposicao_final));

    // Extra (campo legado): KPIs apenas quando houver conteúdo
    if (pop.kpis)
      secao(doc, '+', 'KPIs e Indicadores', pop.kpis);

    // ── RODAPÉ ──
    const rodapeY = doc.page.height - 45;
    doc.rect(0, rodapeY, pageW, 45).fill(COR_FUNDO);
    doc.moveTo(0, rodapeY).lineTo(pageW, rodapeY).strokeColor(COR_BORDA).lineWidth(0.5).stroke();

    doc.fillColor(COR_SUBTEXTO).font('Helvetica').fontSize(8)
      .text(
        `LC FIBRA — Sistema de Gestão  ·  ${pop.codigo || ''}  ·  Gerado em ${new Date().toLocaleString('pt-BR')}`,
        marginL, rodapeY + 16, { width: pageW - marginL - marginR, align: 'center' }
      );

    doc.end();
  });
}

// Converte campo que pode ser JSON (array) em texto com bullets, ou texto puro
function listaParaBullets(valor, montarLinha) {
  const arr = parseLista(valor);
  if (arr) {
    return arr.map(montarLinha).filter(Boolean).map(l => `• ${l}`).join('\n');
  }
  return valor ? String(valor) : '';
}

/**
 * Gera o PDF de um Processo e retorna um Buffer.
 * @param {Object} proc - Objeto do processo (com categoria_nome, criado_por_nome)
 * @returns {Promise<Buffer>}
 */
function gerarPDFProcesso(proc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 60, bottom: 60, left: 50, right: 50 },
      info: {
        Title: `${proc.codigo || 'PROC'} - ${proc.titulo}`,
        Author: proc.criado_por_nome || 'Sistema LC FIBRA',
        Subject: 'Processo Organizacional',
        Creator: 'LC FIBRA - Sistema de Gestão',
      },
    });

    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const marginL = doc.page.margins.left;
    const marginR = doc.page.margins.right;

    // ── CABEÇALHO ──
    doc.rect(0, 0, pageW, 130).fill(COR_PRIMARIA);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20)
      .text('LC FIBRA', marginL, 24, { align: 'left' });
    if (proc.codigo) {
      doc.font('Helvetica').fontSize(11)
        .text(proc.codigo, pageW - marginR - 100, 28, { width: 100, align: 'right' });
    }
    doc.font('Helvetica-Bold').fontSize(15)
      .text(proc.titulo || 'Processo', marginL, 55, { width: pageW - marginL - marginR });

    const statusLabel = {
      ativo: 'ATIVO', rascunho: 'RASCUNHO', revisao: 'EM REVISÃO', inativo: 'INATIVO'
    }[proc.status] || (proc.status ? String(proc.status).toUpperCase() : 'RASCUNHO');
    doc.roundedRect(marginL, 108, 78, 16, 4).fill('rgba(255,255,255,0.25)');
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8)
      .text(statusLabel, marginL + 4, 112, { width: 70, align: 'center' });

    // ── 1. IDENTIFICAÇÃO ──
    const idHeadY = 138;
    doc.circle(marginL + 10, idHeadY + 8, 10).fill(COR_PRIMARIA);
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
      .text('1', marginL + 6, idHeadY + 4, { width: 8, align: 'center' });
    doc.fillColor(COR_TEXTO).font('Helvetica-Bold').fontSize(12)
      .text('Identificação', marginL + 26, idHeadY + 2);

    const gridTop = 162, gridH = 46;
    doc.rect(marginL, gridTop, pageW - marginL - marginR, gridH)
      .fill(COR_FUNDO).strokeColor(COR_BORDA).lineWidth(0.5).stroke();
    const idCols = [
      { label: 'Responsável', valor: proc.responsavel || '—' },
      { label: 'Setor',       valor: proc.departamentos_nomes || proc.setor || '—' },
      { label: 'Categoria',   valor: proc.categoria_nome || '—' },
      { label: 'Data',        valor: proc.created_at ? new Date(proc.created_at).toLocaleDateString('pt-BR') : '—' },
    ];
    const idW = (pageW - marginL - marginR) / idCols.length;
    idCols.forEach((item, i) => {
      const x = marginL + i * idW;
      if (i > 0) doc.moveTo(x, gridTop + 6).lineTo(x, gridTop + gridH - 6).strokeColor(COR_BORDA).lineWidth(0.5).stroke();
      doc.fillColor(COR_SUBTEXTO).font('Helvetica').fontSize(7).text(item.label.toUpperCase(), x + 6, gridTop + 8, { width: idW - 12 });
      doc.fillColor(COR_TEXTO).font('Helvetica-Bold').fontSize(9.5).text(item.valor, x + 6, gridTop + 20, { width: idW - 12, ellipsis: true });
    });
    doc.y = gridTop + gridH + 20;

    // ── SEÇÕES ──
    secao(doc, 2, 'Objetivo', proc.objetivo);
    secao(doc, 3, 'Descrição do Processo', proc.descricao);

    const popsTxt = listaParaBullets(proc.pops_relacionados, p =>
      (typeof p === 'string') ? p : [p.codigo, p.titulo].filter(Boolean).join(' – '));
    secao(doc, 4, 'POPs Relacionados', popsTxt);

    const resTxt = listaParaBullets(proc.resultado_esperado, r => (typeof r === 'string' ? r : (r.item || '')));
    secao(doc, 5, 'Resultado Esperado', resTxt);

    // ── RODAPÉ ──
    const rodapeY = doc.page.height - 45;
    doc.rect(0, rodapeY, pageW, 45).fill(COR_FUNDO);
    doc.moveTo(0, rodapeY).lineTo(pageW, rodapeY).strokeColor(COR_BORDA).lineWidth(0.5).stroke();
    doc.fillColor(COR_SUBTEXTO).font('Helvetica').fontSize(8)
      .text(`LC FIBRA — Sistema de Gestão  ·  ${proc.codigo || ''}  ·  Gerado em ${new Date().toLocaleString('pt-BR')}`,
        marginL, rodapeY + 16, { width: pageW - marginL - marginR, align: 'center' });

    doc.end();
  });
}

module.exports = { gerarPDFPOP, gerarPDFProcesso };
