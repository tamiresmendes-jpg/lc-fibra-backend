// Gera a IMAGEM (PNG) da tela "Análise da Cobrança" (Gestão > Metas > Cobrança
// > Análise) pra disparo no Discord — mesmo espírito do gerarImagemMeta.js
// (Relatório de Satisfação): HTML fiel renderizado via Chromium headless e
// capturado como imagem de um único card, não um PDF de várias páginas.
// Cards maiores que a tela, pra ficar legível em miniatura no Discord.
const { getBrowser } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const numBR = n => (Number(n) || 0).toLocaleString('pt-BR');
const fx = n => (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const mesBR = (mesRef) => {
  const [a, m] = mesRef.split('-').map(Number);
  return new Date(a, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
};
const emissao = () => new Date().toLocaleString('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// Barra horizontal simples — rótulo + trilho + valor. `moeda` decide se o valor
// no fim da barra sai em R$ (equipamentos) ou em número puro (contagens).
function barrasH(dados, chave, valor, cor, moeda, limite) {
  if (!dados?.length) return '<p class="vazio">Sem dados no período</p>';
  const lista = limite ? dados.slice(0, limite) : dados;
  const max = Math.max(...lista.map(d => d[valor])) || 1;
  const linhas = lista.map(d => `
    <div class="barra-linha">
      <span class="barra-rotulo" title="${esc(d[chave])}">${esc(d[chave])}</span>
      <span class="barra-trilho"><span class="barra-cheia" style="width:${(d[valor] / max) * 100}%;background:${cor}"></span></span>
      <span class="barra-valor">${moeda ? fx(d[valor]) : numBR(d[valor])}</span>
    </div>`).join('');
  const resto = limite && dados.length > limite
    ? `<p class="nota">+${dados.length - limite} outro(s) no período</p>` : '';
  return `<div class="barras">${linhas}</div>${resto}`;
}

// Barra dupla removido (verde) / não removido (cinza) — números puros (contagem de O.S.)
function barrasDuplas(dados, limite) {
  if (!dados?.length) return '<p class="vazio">Sem dados no período</p>';
  const lista = limite ? dados.slice(0, limite) : dados;
  const linhas = lista.map(t => `
    <div class="barra-linha">
      <span class="barra-rotulo" title="${esc(t.tipo)}">${esc(t.tipo)}</span>
      <span class="barra-trilho" style="display:flex">
        <span class="barra-cheia" style="width:${(t.removido / (t.total || 1)) * 100}%;background:#16a34a"></span>
        <span class="barra-cheia" style="width:${(t.nao_removido / (t.total || 1)) * 100}%;background:#cbd5e1"></span>
      </span>
      <span class="barra-valor">${numBR(t.removido)}/${numBR(t.total)}</span>
    </div>`).join('');
  return `<div class="barras">${linhas}</div>`;
}

function montarHtmlAnaliseCobranca(dados, mesRef) {
  const r = dados.resumo || {};
  const painel = (titulo, corpo) => `<div class="painel"><h3>${esc(titulo)}</h3>${corpo}</div>`;

  const somaMotivos = (dados.motivos || []).reduce((s, x) => s + x.total, 0);
  const somaCidades = (dados.por_cidade || []).reduce((s, x) => s + x.total, 0);
  const somaTipos = (dados.por_tipo || []).reduce((s, x) => s + x.total, 0);
  const somaEquip = (dados.equipamentos || []).reduce((s, x) => s + x.valor, 0);

  const cards = [
    { v: numBR(r.total_os_remocao), l: 'O.S. de remoção' },
    { v: numBR(r.pessoas_envolvidas), l: 'Pessoas envolvidas' },
    { v: numBR(r.cidades_envolvidas), l: 'Cidades envolvidas' },
    { v: numBR(r.equipamentos_removidos), l: 'Equipamentos removidos' },
    { v: fx(r.valor_recuperado), l: 'Valor recuperado', destaque: true, cor: '#4ade80' },
  ].map(c => `
    <div class="card${c.destaque ? ' destaque' : ''}">
      <span class="v" style="${c.cor ? `color:${c.cor}` : ''}">${c.v}</span>
      <span class="l">${esc(c.l)}</span>
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;background:#fff}
    #card{width:1100px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden}

    .cabecalho{background:#0b2b6b;color:#fff;padding:20px 26px}
    .cabecalho .titulo{font-size:20px;font-weight:800;letter-spacing:.3px}
    .cabecalho .sub{font-size:13px;opacity:.85;margin-top:3px}

    .cards{display:flex;gap:14px;padding:20px 26px 4px}
    .card{flex:1;background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px 10px;
      display:flex;flex-direction:column;align-items:center;gap:6px}
    .card.destaque{border-color:#4ade80}
    .card .v{font-size:26px;font-weight:800;color:#fff;white-space:nowrap}
    .card .l{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.03em;text-align:center}

    .mosaico{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:18px 26px 24px}
    .painel{border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px}
    .painel h3{font-size:13px;font-weight:800;color:#6d28d9;text-transform:uppercase;letter-spacing:.03em;margin-bottom:10px}

    .barras{display:flex;flex-direction:column;gap:7px}
    .barra-linha{display:grid;grid-template-columns:34% 1fr auto;align-items:center;gap:8px;font-size:12.5px}
    .barra-rotulo{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#334155;font-weight:600}
    .barra-trilho{background:#f1f5f9;border-radius:4px;height:11px;overflow:hidden}
    .barra-cheia{display:block;height:100%}
    .barra-valor{font-weight:700;color:#0f172a;min-width:32px;text-align:right;white-space:nowrap}

    .vazio{color:#94a3b8;font-size:12px;font-style:italic}
    .nota{color:#64748b;font-size:11px;margin-top:6px}
    .legenda{display:flex;gap:14px;font-size:11px;color:#64748b;margin-top:8px}
    .legenda i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}

    .rodape{padding:10px 26px 16px;font-size:10.5px;color:#94a3b8;border-top:1px solid #f1f5f9}
  </style></head><body>
    <div id="card">
      <div class="cabecalho">
        <div class="titulo">📊 Análise da Cobrança</div>
        <div class="sub">Referência: ${esc(mesBR(mesRef))} · Só O.S. cujo tipo contém "Remoção"</div>
      </div>
      <div class="cards">${cards}</div>
      <div class="mosaico">
        ${painel(`Motivos de fechamento (${numBR(somaMotivos)})`, barrasH(dados.motivos, 'motivo', 'total', '#6366f1', false, 8))}
        ${painel(`Por cidade (${numBR(somaCidades)})`, barrasH(dados.por_cidade, 'cidade', 'total', '#2563eb', false, 8))}
        ${painel(`Por tipo de O.S. (${numBR(somaTipos)})`,
          barrasDuplas(dados.por_tipo, 8) +
          '<div class="legenda"><span><i style="background:#16a34a"></i>Removido</span><span><i style="background:#cbd5e1"></i>Não removido</span></div>')}
        ${painel(`Equipamentos removidos (${fx(somaEquip)})`,
          barrasH((dados.equipamentos || []).map(e => ({ ...e, rotulo: `${e.produto} ×${numBR(e.quantidade)}` })), 'rotulo', 'valor', '#0ea5e9', true, 8))}
      </div>
      <div class="rodape">Kronos — Sistema de Gestão · LC Virtual Net &nbsp;·&nbsp; Emitido em ${emissao()}</div>
    </div>
  </body></html>`;
}

async function gerarImagemAnaliseCobrancaPng(dados, mesRef) {
  const html = montarHtmlAnaliseCobranca(dados, mesRef);
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setViewport({ width: 1140, height: 900, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'load' });
    const el = await page.$('#card');
    const buf = await el.screenshot({ type: 'png' });
    return Buffer.from(buf);
  } finally { await page.close(); }
}

module.exports = { gerarImagemAnaliseCobrancaPng, montarHtmlAnaliseCobranca };
