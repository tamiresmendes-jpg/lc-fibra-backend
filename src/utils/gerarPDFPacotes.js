// PDF da Análise de Pacotes — todos os pacotes do catálogo já salvos no
// cache (erp_pacotes_cache), sem nenhuma chamada nova ao HubSoft. Mesmo
// padrão visual do PDF de Planos (gerarPDFPlano.js): cadastro básico +
// composição de cada pacote com os grupos Cadastro/ICMS/PIS/COFINS.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtBRL = v => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function fmtEscalar(chave, v) {
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (chave === 'valor') return fmtBRL(v);
  if (/percentual|^(icms|pis|cofins)$/i.test(chave)) return `${Number(v)}%`;
  return String(v);
}
function kvGrid(obj) {
  const entradas = Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && v !== '' && typeof v !== 'object');
  if (!entradas.length) return '';
  return `<div class="kvgrid">${entradas.map(([k, v]) => `<div class="kv"><span class="kvk">${esc(rotulo(k))}</span><span class="kvv">${esc(fmtEscalar(k, v))}</span></div>`).join('')}</div>`;
}
function rotulo(k) {
  return String(k || '').replace(/^id_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
function grupo(titulo, obj, campos) {
  const presentes = campos.filter(([chave]) => obj[chave] !== null && obj[chave] !== undefined && obj[chave] !== '');
  if (!presentes.length) return '';
  const kv = presentes.map(([chave, rot]) => {
    const v = obj[chave];
    const texto = typeof v === 'object'
      ? (v.codigo != null ? (v.descricao ? `${v.codigo} - ${v.descricao}` : String(v.codigo)) : (v.descricao || '—'))
      : fmtEscalar(chave, v);
    return `<div class="kv"><span class="kvk">${esc(rot)}</span><span class="kvv">${esc(texto)}</span></div>`;
  }).join('');
  return `<div class="grupo"><span class="grupo-titulo">${esc(titulo)}</span><div class="kvgrid">${kv}</div></div>`;
}

const COMPOSICAO_CADASTRO = [
  ['descricao', 'Descrição'], ['representacao_percentual', 'Percentual (%)'],
  ['descricao_nota_fiscal', 'Descrição Nota Fiscal'], ['plano_conta', 'Plano de Contas'],
  ['tipo_servico', 'Tipo de Serviço'], ['tipo_documento_fiscal', 'Tipo de Documento Fiscal'],
  ['incluir_dici_anatel', 'Incluir DICI Anatel'], ['incluir_nfcom', 'Incluir Nfcom'],
  ['aplicar_partilha_icms', 'Aplicar Partilha ICMS'],
];
const COMPOSICAO_ICMS = [['icms', 'ICMS (%)'], ['cst_tributacao', 'CST Tributação (ICMS)'], ['tipo_tributo', 'Tipo Tributação (ICMS)']];
const COMPOSICAO_PIS = [['pis', 'PIS (%)'], ['cst_pis', 'CST PIS'], ['tipo_bc_pis', 'Tipo BC PIS']];
const COMPOSICAO_COFINS = [['cofins', 'COFINS (%)'], ['cst_cofins', 'CST COFINS'], ['tipo_bc_cofins', 'Tipo BC COFINS']];
const COMPOSICAO_OUTROS = [
  ['tipo_utilizacao', 'Tipo de Utilização'],
  ['classificacao_item_doc_fiscal', 'Classificação Item Doc. Fiscal'],
  ['cclass', 'Classificação de Item da NFCom'],
];

function renderComposicao(item, titulo) {
  return `<div class="bloco"><b class="bloco-titulo">${esc(titulo)}</b>
    ${grupo('Dados Cadastrais / Financeiros', item, COMPOSICAO_CADASTRO)}
    <div class="grupolinha">${grupo('ICMS', item, COMPOSICAO_ICMS)}${grupo('PIS', item, COMPOSICAO_PIS)}${grupo('COFINS', item, COMPOSICAO_COFINS)}</div>
    ${grupo('Outros Impostos', item, COMPOSICAO_OUTROS)}
  </div>`;
}

function corpoPacote(p) {
  const basico = { descricao: p.descricao, codigo: p.codigo, valor: p.valor, ativo: p.ativo };
  const composicao = Array.isArray(p.composicao) ? p.composicao : [];
  const composicaoHtml = composicao.length
    ? `<div class="secao"><h4>Composição</h4><div class="arr">${composicao.map((item, i) => renderComposicao(item, `Item ${i + 1}`)).join('')}</div></div>`
    : '';
  return `<div class="cadastro">${kvGrid(basico)}</div>${composicaoHtml}`;
}

const ESTILO = `
    @page{margin:6mm 10mm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:9px;line-height:1.2}
    .cabecalho{background:#4f46e5;color:#fff;padding:8px 14px;margin-bottom:6px}
    .cabecalho h1{font-size:14px}
    .cabecalho .sub{font-size:9px;opacity:.9;margin-top:2px}
    .pacote-bloco{page-break-inside:avoid;margin:0 14px 5px}
    .pacote-titulo{background:#eef2ff;color:#4f46e5;padding:3px 8px;margin-bottom:3px;font-size:11px;font-weight:700;border-radius:3px}
    .pacote-titulo .status{font-size:8px;font-weight:400;margin-left:6px;text-transform:uppercase;color:#64748b}
    .cadastro{border:1px solid #cbd5e1;border-radius:5px;padding:3px 7px;margin:0 0 3px}
    .secao{margin:0 0 3px}
    .secao h4{font-size:9.5px;color:#4f46e5;border-bottom:1px solid #cbd5e1;padding-bottom:1px;margin-bottom:2px;text-transform:uppercase;page-break-after:avoid}
    .kvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(105px,1fr));gap:1px 10px}
    .kv{display:flex;flex-direction:column;padding:0 0 1px;border-bottom:1px solid #f1f5f9;overflow:hidden;page-break-inside:avoid}
    .kvk{font-size:6.5px;color:#94a3b8;text-transform:uppercase}
    .kvv{font-size:8.5px;word-break:break-word;overflow-wrap:anywhere}
    .arr{display:flex;flex-direction:column;gap:1px}
    .bloco{border:1px solid #e2e8f0;border-radius:4px;padding:2px 5px}
    .bloco-titulo{display:block;font-size:7px;color:#4f46e5;margin-bottom:1px;text-transform:uppercase}
    .grupo{margin-top:2px;padding:2px 5px;border:1px solid #e2e8f0;border-radius:3px}
    .grupo:first-of-type{margin-top:0}
    .grupo-titulo{display:block;font-size:6.5px;font-weight:700;color:#4f46e5;text-transform:uppercase}
    .grupolinha{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:2px;margin-top:2px}
    .grupolinha:first-of-type{margin-top:0}
    .grupolinha .grupo{margin-top:0}
    .vazio{color:#94a3b8;font-style:italic}
    .rodape{margin:6px 14px 0;border-top:1px solid #e2e8f0;padding-top:3px;font-size:7px;color:#94a3b8;text-align:center}
`;

function montarHtmlListaPacotes(pacotes) {
  const blocos = pacotes.map(p => `
    <div class="pacote-bloco">
      <div class="pacote-titulo">${esc(p.descricao || p.display || `Pacote ${p.id_pacote}`)}<span class="status">${p.ativo ? 'Ativo' : 'Inativo'}</span></div>
      ${corpoPacote(p)}
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    <div class="cabecalho">
      <h1>Análise de Pacotes — Catálogo completo</h1>
      <div class="sub">${pacotes.length} pacote(s) · Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
    </div>
    ${blocos}
    <div class="rodape">Kronos — Análise de Pacotes — Cadastro e composição de cada pacote</div>
  </body></html>`;
}

async function gerarPDFListaPacotes(pacotes) {
  return htmlParaPdf(montarHtmlListaPacotes(pacotes));
}

module.exports = { gerarPDFListaPacotes, montarHtmlListaPacotes };
