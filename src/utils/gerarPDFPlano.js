// PDF de UM plano (Análise de Planos) — mesma estrutura mostrada na tela:
// cadastro básico + cada seção (Composição, Contrato, Desconto, Taxa de
// Instalação, Navegação, Pacotes, etc.) já vem numa chave do próprio JSON do
// plano, então basta listar quais mostrar (igual ao frontend).
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const CAMPOS_PERCENTUAL = /percentual|garantia_banda|^(icms|pis|cofins|fust|funttel|irrf|csll|fcp)$/i;
const CAMPOS_DINHEIRO = /^valor(_|$)|_valor$/i;

function rotulo(k) {
  return String(k || '').replace(/^id_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
function fmtEscalar(k, v) {
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  const num = Number(v);
  if (!Number.isNaN(num) && v !== '') {
    if (CAMPOS_PERCENTUAL.test(k)) return `${num}%`;
    if (CAMPOS_DINHEIRO.test(k)) return fmtBRL(num);
  }
  return String(v);
}
function kvGrid(obj) {
  const entradas = Object.entries(obj).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '' && typeof v !== 'object');
  if (!entradas.length) return '';
  return `<div class="kvgrid">${entradas.map(([k, v]) => `<div class="kv"><span class="kvk">${esc(rotulo(k))}</span><span class="kvv">${esc(fmtEscalar(k, v))}</span></div>`).join('')}</div>`;
}
// Mesma regra da tela: itens repetidos só agrupam num "×N" se TODA a
// configuração (menos id/pivot, que sempre variam) for idêntica.
function agruparComposicao(itens) {
  const grupos = [];
  for (const item of itens) {
    const { id_composicao, pivot, ...resto } = item;
    const sig = JSON.stringify(resto);
    const existente = grupos.find(g => g.sig === sig);
    if (existente) existente.qtd += 1;
    else grupos.push({ sig, qtd: 1, item });
  }
  return grupos.map(g => ({ ...g.item, _quantidade: g.qtd }));
}
function renderValor(v, chave, nivel = 0) {
  if (v === null || v === undefined || v === '') return '<span class="vazio">—</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="vazio">—</span>';
    if (typeof v[0] !== 'object') return esc(v.join(', '));
    const lista = chave === 'servico_composicao' ? agruparComposicao(v) : v;
    return `<div class="arr">${lista.map((item, i) => renderObjeto(item, nivel + 1, `Item ${i + 1}${item._quantidade > 1 ? ` — ${item._quantidade}x` : ''}`)).join('')}</div>`;
  }
  if (typeof v === 'object') return renderObjeto(v, nivel + 1);
  return esc(fmtEscalar(chave, v));
}
function renderObjeto(obj, nivel, titulo) {
  const complexas = Object.entries(obj).filter(([k, v]) => !k.startsWith('_') && typeof v === 'object' && v !== null);
  const corpo = kvGrid(obj) + complexas.map(([k, v]) => `<div class="complexa"><span class="complexa-titulo">${esc(rotulo(k))}</span>${renderValor(v, k, nivel)}</div>`).join('');
  // "open" fixo — no papel não dá pra clicar pra expandir, então já mostra tudo.
  if (nivel >= 2) return `<details open class="aninhado"><summary>${esc(titulo || 'Detalhes')}</summary>${corpo}</details>`;
  return `<div class="bloco">${titulo ? `<b class="bloco-titulo">${esc(titulo)}</b>` : ''}${corpo}</div>`;
}

const SECOES = [
  ['servico_composicao', 'Composição'], ['servico_desconto', 'Desconto'], ['servico_contrato', 'Contratos'],
  ['servico_taxa_instalacao', 'Taxa de Instalação'], ['servico_navegacao', 'Navegação'], ['servico_pacote', 'Pacotes'],
  ['acao_evento_sistema', 'Ações para Eventos'], ['configuracao', 'Configuração'], ['servico_atributo_extra', 'Atributo Extra'],
  ['servico_mensalidade_progressiva', 'Mensalidade Progressiva'], ['parametros', 'Parâmetros'], ['parametros_estaticos', 'Parâmetros Estáticos'],
  ['perfil_migracao_servico', 'Migração (SAC)'], ['servico_integracao_rede_neutra', 'Redes Neutras'], ['horarios_acesso', 'Horários de Acesso'],
];

function corpoPlano(plano) {
  const basico = {
    descricao: plano.descricao, nome_exibicao: plano.nome_exibicao, valor: plano.valor,
    tipo_pagamento: plano.tipo_pagamento, tipo_cobranca: plano.tipo_cobranca, validade: plano.validade,
    garantia_banda_download: plano.garantia_banda_download, garantia_banda_upload: plano.garantia_banda_upload,
    carne: plano.carne, emite_contrato: plano.emite_contrato, permite_associar: plano.permite_associar,
    permite_prospecto: plano.permite_prospecto, permite_degustacao: plano.permite_degustacao,
    data_cadastro: plano.data_cadastro,
  };
  const secoes = SECOES
    .filter(([chave]) => { const v = plano[chave]; return Array.isArray(v) ? v.length > 0 : !!v; })
    .map(([chave, titulo]) => `<div class="secao"><h4>${esc(titulo)}</h4>${renderValor(plano[chave], chave)}</div>`)
    .join('');
  return `<div class="cadastro">${kvGrid(basico)}</div>${secoes}`;
}

const ESTILO_PLANO = `
    @page{margin:8mm 10mm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:9px;line-height:1.25}
    .cabecalho{background:#4f46e5;color:#fff;padding:10px 14px;margin-bottom:8px}
    .cabecalho h1{font-size:14px}
    .cabecalho .sub{font-size:9px;opacity:.9;margin-top:2px}
    .plano-bloco{page-break-before:always}
    .plano-bloco:first-of-type{page-break-before:auto}
    .plano-titulo{background:#eef2ff;color:#4f46e5;padding:4px 14px;margin-bottom:5px;font-size:11px;font-weight:700}
    .plano-titulo .status{font-size:8px;font-weight:400;margin-left:6px;text-transform:uppercase;color:#64748b}
    .cadastro{border:1px solid #cbd5e1;border-radius:5px;padding:5px 7px;margin:0 14px 6px}
    .secao{margin:0 14px 6px}
    .secao h4{font-size:9.5px;color:#4f46e5;border-bottom:1px solid #cbd5e1;padding-bottom:2px;margin-bottom:3px;text-transform:uppercase;page-break-after:avoid}
    .kvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:1px 10px}
    .kv{display:flex;flex-direction:column;padding:0 0 1px;border-bottom:1px solid #f1f5f9;overflow:hidden}
    .kvk{font-size:6.5px;color:#94a3b8;text-transform:uppercase}
    .kvv{font-size:8.5px;word-break:break-word;overflow-wrap:anywhere}
    .arr{display:flex;flex-direction:column;gap:2px}
    .bloco{border:1px solid #e2e8f0;border-radius:4px;padding:2px 5px}
    .bloco-titulo{display:block;font-size:7px;color:#4f46e5;margin-bottom:1px;text-transform:uppercase}
    .complexa{margin-top:2px}
    .complexa-titulo{display:block;font-size:7px;font-weight:700;color:#4f46e5;text-transform:uppercase;margin-bottom:1px}
    .aninhado{margin:1px 0;border:1px dashed #cbd5e1;border-radius:3px;padding:1px 4px}
    .aninhado summary{font-size:7px;color:#64748b;padding:1px 0;word-break:break-word;overflow-wrap:anywhere}
    .vazio{color:#94a3b8;font-style:italic}
    .rodape{margin:10px 14px 0;border-top:1px solid #e2e8f0;padding-top:4px;font-size:7px;color:#94a3b8;text-align:center}
`;

function montarHtmlPlano(plano) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO_PLANO}</style></head><body>
    <div class="cabecalho"><h1>${esc(plano.descricao || plano.nome_exibicao || 'Plano')}</h1></div>
    ${corpoPlano(plano)}
    <div class="rodape">Kronos — Análise de Planos — Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
  </body></html>`;
}

async function gerarPDFPlano(plano) {
  return htmlParaPdf(montarHtmlPlano(plano));
}

// PDF de VÁRIOS planos, com o detalhe COMPLETO de cada um (mesmas seções do
// PDF de 1 plano só) — usado pra "baixar todos", já filtrado só pra quem tem
// cliente ativo (filtro é feito na rota, antes de chamar isso aqui).
function montarHtmlListaPlanos(planos) {
  const blocos = planos.map(p => `
    <div class="plano-bloco">
      <div class="plano-titulo">${esc(p.descricao || p.nome_exibicao || `Plano ${p.id_servico}`)}<span class="status">${p.ativo ? 'Ativo' : 'Inativo'} · ${p.clientes_servicos_count ?? 0} cliente(s)</span></div>
      ${corpoPlano(p)}
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO_PLANO}</style></head><body>
    <div class="cabecalho">
      <h1>Análise de Planos — Todos os planos com cliente ativo</h1>
      <div class="sub">${planos.length} plano(s) · Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
    </div>
    ${blocos}
    <div class="rodape">Kronos — Análise de Planos — Cadastro/configuração completa de cada plano</div>
  </body></html>`;
}

async function gerarPDFListaPlanos(planos) {
  return htmlParaPdf(montarHtmlListaPlanos(planos));
}

module.exports = { gerarPDFPlano, montarHtmlPlano, gerarPDFListaPlanos, montarHtmlListaPlanos };
