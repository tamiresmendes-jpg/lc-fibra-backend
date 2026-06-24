const PDFDocument = require('pdfkit');

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

  // Conteúdo (sempre exibido — seções vazias mostram um marcador discreto)
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
      { label: 'Departamento',   valor: pop.departamento_nome || '—' },
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

module.exports = { gerarPDFPOP };
