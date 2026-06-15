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

function secao(doc, numero, titulo, conteudo) {
  if (!conteudo) return;

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

  // Conteúdo
  doc.fillColor('#374151').font('Helvetica').fontSize(10);
  const linhas = conteudo.split('\n');
  linhas.forEach(linha => {
    if (linha.trim()) doc.text(linha.trim(), { indent: 10 });
    else doc.moveDown(0.3);
  });

  doc.moveDown(0.6);
  doc.moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .strokeColor(COR_BORDA).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

function secaoTabela(doc, numero, titulo, colunas, linhas) {
  if (!linhas || linhas.length === 0) return;

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

    // ── GRADE DE IDENTIFICAÇÃO ──
    const gridTop = 145;
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

    // ── SEÇÕES ──
    let numSecao = 1;

    if (pop.objetivo)
      secao(doc, numSecao++, 'Objetivo', pop.objetivo);

    if (pop.campo_aplicacao)
      secao(doc, numSecao++, 'Campo de Aplicação', pop.campo_aplicacao);

    const linhasResp = parseLista(pop.responsabilidade);
    if (linhasResp)
      secaoTabela(doc, numSecao++, 'Responsabilidades', ['Nome / Cargo', 'Responsabilidade'], linhasResp);
    else if (pop.responsabilidade)
      secao(doc, numSecao++, 'Responsabilidades', pop.responsabilidade);

    if (pop.procedimento)
      secao(doc, numSecao++, 'Procedimento Detalhado', pop.procedimento);

    if (pop.documentos)
      secao(doc, numSecao++, 'Documentos de Referência', pop.documentos);

    if (pop.kpis)
      secao(doc, numSecao++, 'KPIs e Indicadores', pop.kpis);

    if (pop.seguranca)
      secao(doc, numSecao++, 'Segurança', pop.seguranca);

    if (pop.penalidade)
      secao(doc, numSecao++, 'Penalidades', pop.penalidade);

    const linhasDisp = parseLista(pop.disposicao_final);
    if (linhasDisp)
      secaoTabela(doc, numSecao++, 'Disposição Final', ['Item', 'Destino / Ação Final', 'Responsável'], linhasDisp);
    else if (pop.disposicao_final)
      secao(doc, numSecao++, 'Disposição Final', pop.disposicao_final);

    // Conteúdo legado (campo genérico)
    if (pop.conteudo && numSecao === 1)
      secao(doc, numSecao++, 'Conteúdo', pop.conteudo);

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
