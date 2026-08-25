// Gera o PDF da aba "Acompanhamento e Análise" da Meta Comercial — reproduz o
// MESMO visual da tela (cards escuros, painéis lado a lado, gráfico de linha de
// verdade em SVG), não é um relatório à parte. Paisagem, pra caber o mosaico.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fx = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesBR = (mesRef) => {
  const [a, m] = mesRef.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};
const dataBR = (iso) => {
  const [a, m, d] = iso.split('-').map(Number);
  return new Date(a, m - 1, d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
const emissao = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
function corPct(pct) {
  if (pct == null) return '#94a3b8';
  if (pct >= 100) return '#4ade80';
  if (pct >= 70) return '#fbbf24';
  return '#f87171';
}

// Cards escuros do topo — mesmo conteúdo/ordem da tela (GestaoMetaAnalise.jsx)
function cardsHtml(r, temData) {
  const cor = corPct(r.pct);
  const cards = [
    { v: r.meta, l: 'Meta de vendas' },
    { v: r.vendas, l: 'Vendas no mês' },
    { v: r.cancelamentos, l: 'Cancelamentos' },
    { v: r.pct == null ? '—' : `${r.pct}%`, l: `da meta (saldo ${r.saldo})`, destaque: true, cor },
    { v: r.gap > 0 ? `+${r.gap}` : (r.gap ?? '—'), l: 'gap da meta', cor: (r.gap ?? 0) >= 0 ? '#4ade80' : '#f87171' },
    { v: `${r.bateram}/${r.vendedores}`, l: 'bateram a meta' },
    { v: fx(r.receita), l: `receita · ticket ${fx(r.ticket_medio)}`, pequeno: true },
  ];
  if (!temData) cards.push({ v: Math.round(r.meta_por_dia || 0), l: 'meta por dia útil' });
  if (r.meta_esperada_ate_hoje != null) {
    const corRitmo = corPct(r.meta_esperada_ate_hoje ? Math.round((r.saldo / r.meta_esperada_ate_hoje) * 100) : null);
    cards.push({ v: `${r.saldo}/${r.meta_esperada_ate_hoje}`, l: 'ritmo esperado até hoje', destaque: true, cor: corRitmo });
  }
  return `<div class="cards">${cards.map(c => `
    <div class="card${c.destaque ? ' destaque' : ''}" ${c.destaque ? `style="border-color:${c.cor}"` : ''}>
      <span class="v${c.pequeno ? ' pequeno' : ''}" ${c.cor ? `style="color:${c.cor}"` : ''}>${esc(c.v)}</span>
      <span class="l">${esc(c.l)}</span>
    </div>`).join('')}</div>`;
}

// limite (opcional): corta pros N maiores — o PDF é estático, não rola como a
// tela, então uma lista longa (ex.: bairro sem limite nenhum) estourava a página.
function barrasH(titulo, dados, chave, valor, vazio, cor = '#2563eb', limite) {
  if (!dados?.length) return `<h4>${esc(titulo)}</h4><p class="vazio">${esc(vazio || 'Sem dados no período')}</p>`;
  const lista = limite ? dados.slice(0, limite) : dados;
  const max = Math.max(...lista.map(d => d[valor])) || 1;
  const linhas = lista.map(d => `
    <div class="barra-linha">
      <span class="barra-rotulo">${esc(d[chave])}</span>
      <span class="barra-trilho-valor">
        <span class="barra-trilho"><span class="barra-cheia" style="width:${(d[valor] / max) * 100}%;background:${cor}"></span></span>
        <span class="barra-valor">${d[valor]}</span>
      </span>
    </div>`).join('');
  const resto = limite && dados.length > limite ? `<p class="nota">+${dados.length - limite} outro(s) no sistema</p>` : '';
  return `<h4>${esc(titulo)}</h4><div class="barras">${linhas}</div>${resto}`;
}

// Mesmo gráfico SVG de 3 linhas da tela (GestaoMetaAnalise.jsx → LinhaPorDia),
// reproduzido em Node pra sair IGUAL no PDF, não como tabela.
function svgPorDia(dados) {
  if (!dados?.length) return '<p class="vazio">Sem vendas no período</p>';
  const L = 34, R = 12, T = 22, B = 22, W = 620, H = 190;
  const maxDia = Math.max(...dados.map(d => d.dia));
  const maxQtd = Math.max(1, ...dados.map(d => d.acumulado), ...dados.map(d => d.meta_acumulada || 0));
  const px = (dia) => L + ((dia - 1) / Math.max(1, maxDia - 1)) * (W - L - R);
  const py = (q) => T + (1 - q / maxQtd) * (H - T - B);
  const pontosAcum = dados.map(d => `${px(d.dia)},${py(d.acumulado)}`).join(' ');
  const pontosMeta = dados.map(d => `${px(d.dia)},${py(d.meta_acumulada || 0)}`).join(' ');
  const pontosDia = dados.map(d => `${px(d.dia)},${py(d.qtd)}`).join(' ');
  const area = `${L},${py(0)} ${pontosAcum} ${px(dados[dados.length - 1].dia)},${py(0)}`;
  const ticksY = [0, Math.ceil(maxQtd / 2), maxQtd].filter((v, i, a) => a.indexOf(v) === i);
  const passoX = Math.ceil(dados.length / 10);

  const pontos = dados.map(d => `
    <circle cx="${px(d.dia)}" cy="${py(d.meta_acumulada || 0)}" r="2" fill="#94a3b8" />
    <text x="${px(d.dia)}" y="${py(d.meta_acumulada || 0) - 6}" text-anchor="middle" style="font-size:7px;font-weight:700" fill="#94a3b8">${d.meta_acumulada}</text>
    <circle cx="${px(d.dia)}" cy="${py(d.acumulado)}" r="3" fill="#2563eb" />
    <text x="${px(d.dia)}" y="${py(d.acumulado) - 6}" text-anchor="middle" style="font-size:7px;font-weight:700" fill="#2563eb">${d.acumulado}</text>
    <circle cx="${px(d.dia)}" cy="${py(d.qtd)}" r="2" fill="#16a34a" />
    ${d.qtd > 0 ? `<text x="${px(d.dia)}" y="${py(d.qtd) + 10}" text-anchor="middle" style="font-size:7px;font-weight:700" fill="#16a34a">${d.qtd}</text>` : ''}
  `).join('');
  const eixoX = dados.filter((_, i) => i % passoX === 0)
    .map(d => `<text x="${px(d.dia)}" y="${H - 4}" text-anchor="middle" style="font-size:8px;fill:#94a3b8">${d.dia}</text>`).join('');
  const eixoY = ticksY.map(t => `
    <line x1="${L}" x2="${W - R}" y1="${py(t)}" y2="${py(t)}" stroke="#000" stroke-opacity="0.08" />
    <text x="${L - 5}" y="${py(t) + 3}" text-anchor="end" style="font-size:8px;fill:#94a3b8">${t}</text>`).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
      ${eixoY}
      <polygon points="${area}" fill="#2563eb" fill-opacity="0.12" />
      <polyline points="${pontosMeta}" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="5 4" stroke-linejoin="round" stroke-linecap="round" />
      <polyline points="${pontosAcum}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <polyline points="${pontosDia}" fill="none" stroke="#16a34a" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
      ${pontos}
      ${eixoX}
    </svg>
    <div class="legenda">
      <span><i style="background:#2563eb"></i>Acumulado real</span>
      <span><i class="tracejada"></i>Meta acumulada</span>
      <span><i style="background:#16a34a"></i>Vendas do dia</span>
    </div>`;
}

function montarHtmlAnaliseMetaComercial(dados, opcoes = {}) {
  const r = dados.resumo || {};
  const vendedorSel = dados.vendedor_selecionado
    ? (dados.vendedores || []).find(v => String(v.id) === String(dados.vendedor_selecionado))
    : null;
  const periodo = dados.data ? `Dia ${dataBR(dados.data)}` : mesBR(dados.mes);
  const setorLabel = { todos: 'Geral', comercial: 'Comercial', pap: 'PAP', escritorio: 'Escritórios' }[dados.setor] || dados.setor;

  const linhasFilial = (dados.por_filial || []).map(f => `
    <tr>
      <td style="font-weight:600">${esc(f.vendedor)}</td>
      <td>${esc(f.filial || '—')}</td>
      <td style="text-align:center;font-weight:700">${f.meta ?? '—'}</td>
      <td style="text-align:center;background:#f8fafc">${f.vendas}</td>
      <td style="text-align:center;font-weight:700">${f.saldo}</td>
      <td style="text-align:right;font-weight:700;color:${(f.pct ?? 0) >= 100 ? '#166534' : '#334155'}">${f.pct == null ? '—' : `${f.pct}%`}</td>
    </tr>`).join('');

  const painel = (titulo, corpo, span) => `<div class="painel" style="grid-column:span ${span}"><h3>${esc(titulo)}</h3>${corpo}</div>`;

  // Lista de clientes — mesma tabela da tela (GestaoMetaAnalise.jsx). Só mostra a
  // coluna Vendedor quando o relatório tem mais de um (senão é redundante: o PDF
  // já é daquele vendedor só). O relatório GERAL do supervisor não leva essa lista
  // (opcoes.semClientes) — só o PDF individual de cada vendedor leva os próprios nomes.
  const clientes = opcoes.semClientes ? [] : (dados.clientes || []);
  const multiVendedor = new Set(clientes.map(c => c.vendedor_nome)).size > 1;
  const linhasClientes = clientes.map(c => `
    <tr>
      <td style="font-weight:600">${esc(c.nome_cliente || '—')}</td>
      ${multiVendedor ? `<td>${esc(c.vendedor_nome || '—')}</td>` : ''}
      <td>${esc((c.nome_servico || '—').slice(0, 38))}</td>
      <td>${esc(c.pacotes ? c.pacotes.slice(0, 30) : '—')}</td>
      <td>${esc(c.cidade || '—')}</td>
      <td>${esc(c.bairro || '—')}</td>
      <td style="text-align:center">${esc(c.tipo)}</td>
      <td style="text-transform:capitalize">${esc(c.origem || '—')}</td>
      <td>${esc(c.servico_status || '—')}</td>
      <td style="white-space:nowrap">${esc(c.data_venda)}</td>
    </tr>`).join('');
  const clientesHtml = !clientes.length
    ? '<p class="vazio">Sem vendas no período</p>'
    : `<table class="tabela-clientes">
        <thead><tr>
          <th>Cliente</th>${multiVendedor ? '<th>Vendedor</th>' : ''}<th>Plano</th><th>Pacotes</th>
          <th>Cidade</th><th>Bairro</th><th>Tipo</th><th>Origem</th><th>Situação</th><th>Venda</th>
        </tr></thead>
        <tbody>${linhasClientes}</tbody>
      </table>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:10px;background:#fff}
    h1{font-size:15px;color:#0b2b6b;margin-bottom:1px}
    .sub{font-size:9.5px;color:#64748b;margin-bottom:8px}
    .info{font-size:9px;color:#334155;background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:4px 8px;margin-bottom:10px}
    .info b{color:#0b2b6b}

    .cards{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
    .card{flex:1 1 90px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:2px}
    .card.destaque{border-width:2px}
    .card .v{font-size:15px;font-weight:800;color:#fff}
    .card .v.pequeno{font-size:11px}
    .card .l{font-size:7px;color:#94a3b8;text-transform:uppercase;text-align:center}

    table{width:100%;border-collapse:collapse;font-size:9px}
    th{background:#fde047;color:#0b2b6b;font-weight:800;padding:3px 5px;text-align:left;white-space:nowrap}
    td{padding:3px 5px;border-bottom:1px solid #f1f5f9}

    .mosaico{display:grid;grid-template-columns:repeat(12,1fr);gap:8px}
    .painel{border:1px solid #e2e8f0;border-radius:8px;padding:7px 9px;page-break-inside:avoid;min-width:0}
    .painel h3{font-size:9.5px;font-weight:800;color:#6d28d9;text-transform:uppercase;letter-spacing:.03em;margin-bottom:5px}
    .painel h4{display:none}

    .barras{display:flex;flex-direction:column;gap:3px}
    .barra-linha{display:flex;align-items:center;gap:5px;font-size:8px}
    .barra-rotulo{width:34%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#334155}
    .barra-trilho-valor{flex:1;display:flex;align-items:center;gap:4px}
    .barra-trilho{flex:1;background:#f1f5f9;border-radius:3px;height:7px;overflow:hidden}
    .barra-cheia{display:block;height:100%}
    .barra-valor{font-weight:700;min-width:16px;text-align:right}

    .vazio{color:#94a3b8;font-size:8.5px;font-style:italic}
    .nota{color:#64748b;font-size:8px;margin-top:3px}
    .legenda{display:flex;gap:10px;font-size:7.5px;color:#64748b;margin-top:2px}
    .legenda i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;vertical-align:middle}
    .legenda i.tracejada{height:2px;background:#94a3b8}
    .tabela-clientes thead{display:table-header-group}
    .tabela-clientes tr{page-break-inside:avoid}
  </style></head><body>
    <h1>📊 Análise — Meta do Comercial${vendedorSel ? ` · ${esc(vendedorSel.nome)}` : ''}</h1>
    <div class="sub">Período: ${esc(periodo)} &nbsp;·&nbsp; Setor: ${esc(setorLabel)}</div>
    <div class="info">
      <b>Sistema:</b> Kronos — LC Virtual Net &nbsp;·&nbsp;
      <b>Emissão:</b> ${emissao()} &nbsp;·&nbsp;
      <b>Vendedores no filtro:</b> ${r.vendedores ?? '—'}
    </div>
    ${cardsHtml(r, !!dados.data)}
    <div class="mosaico">
      ${painel('Venda × Meta por vendedor', `<table>
          <thead><tr><th>Vendedor</th><th>Filial</th><th>Meta</th><th>Vendas</th><th>Saldo</th><th>% da meta</th></tr></thead>
          <tbody>${linhasFilial || '<tr><td colspan="6" style="text-align:center;padding:10px;color:#94a3b8">Sem vendedores no filtro.</td></tr>'}</tbody>
        </table>`, 12)}
      ${painel('Vendas por bairro', barrasH(null, dados.por_bairro, 'bairro', 'qtd', 'Chega no próximo sincronismo com o painel', '#1d4ed8', 15), 4)}
      ${painel('Vendas por dia', svgPorDia(dados.por_dia), 8)}
      ${painel('Vendas por cidade', barrasH(null, dados.por_cidade, 'cidade', 'qtd'), 6)}
      ${painel('Vendas por plano', barrasH(null, dados.por_servico, 'servico', 'qtd', null, '#7c3aed'), 6)}
      ${painel('Vencimento', barrasH(null, dados.por_vencimento, 'vencimento', 'qtd', null, '#059669'), 4)}
      ${painel('Situação do serviço', barrasH(null, dados.por_status, 'status', 'qtd', null, '#0ea5e9'), 4)}
      ${painel('Pacotes vendidos', barrasH(null, dados.por_pacote, 'pacote', 'qtd', 'Nenhum pacote adicional no período', '#c026d3')
          + (dados.pacotes_resumo?.vendas_com_pacote > 0 ? `<p class="nota">${dados.pacotes_resumo.vendas_com_pacote} venda(s) · receita adicional ${fx(dados.pacotes_resumo.receita)}</p>` : ''), 4)}
      ${painel('Situação do contrato', barrasH(null, dados.por_contrato, 'contrato', 'qtd', null, '#65a30d'), 3)}
      ${painel('Gênero', barrasH(null, dados.por_genero, 'genero', 'qtd', null, '#db2777'), 3)}
      ${painel('Vendas por origem', barrasH(null, dados.por_origem, 'origem', 'qtd', 'Chega no próximo sincronismo com o painel', '#ea580c'), 3)}
      ${painel('Tipo de cliente', barrasH(null, dados.por_tipo, 'tipo', 'qtd', null, '#0891b2'), 3)}
    </div>
    ${opcoes.semClientes ? '' : `
    <div class="painel" style="margin-top:8px;page-break-inside:auto">
      <h3>Clientes (${clientes.length}${clientes.length >= 1000 ? '+' : ''})</h3>
      ${clientesHtml}
    </div>`}
  </body></html>`;
}

async function gerarPDFMetaComercialAnalise(dados, opcoes = {}) {
  // Só força caber numa folha quando é a análise de UM vendedor específico E a
  // lista de clientes é curta o bastante pra não precisar encolher demais (o
  // modo "uma página" ESCONDE (overflow:hidden) o que não couber — com muitos
  // clientes na lista é melhor deixar fluir em várias páginas do que cortar gente).
  const poucosClientes = opcoes.semClientes || (dados.clientes || []).length <= 15;
  return htmlParaPdf(montarHtmlAnaliseMetaComercial(dados, opcoes), null,
    { landscape: true, umaPagina: !!dados.vendedor_selecionado && poucosClientes });
}

module.exports = { gerarPDFMetaComercialAnalise, montarHtmlAnaliseMetaComercial };
