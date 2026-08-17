// PDF da Análise de Serviços (NFSe) — todos os serviços já salvos no cache
// (erp_servicos_nfse_cache), sem nenhuma chamada nova ao HubSoft. Mesmo
// padrão visual dos PDFs de Planos/Pacotes.
const { htmlParaPdf } = require('./gerarPDFHtml');

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtEscalar(chave, v) {
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (/^aliquota_/i.test(chave)) return `${Number(v)}%`;
  return String(v);
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

// Mesmos rótulos e agrupamento da tela AnaliseServicosNfse.jsx (espelhando a
// tela "Editar Serviço de NFSE" do painel HubSoft).
const INFO_SERVICO = [
  ['descricao', 'Descrição'], ['descricao_interna', 'Descrição Interna'],
  ['codigo', 'Código'], ['codigo_tributacao', 'Código Tributação Município'],
  ['codigo_tributacao_nacional', 'Código Tributação Nacional'],
  ['codigo_obra', 'Código Obra'], ['codigo_nbs', 'Código NBS'],
  ['codigo_indicador_operacao_consumo', 'Código Indicador das Operações de Consumo'],
  ['id_tipo_tributacao_nfse', 'Tipo de Tributação NFSe'], ['id_exigibilidade_nfse', 'Exigibilidade da NFSe'],
  ['cnae', 'CNAE do ISS'], ['consumidor_final', 'Consumidor Final'], ['ativo', 'Ativo'],
];
const TRIBUTACAO_IMPOSTOS = [
  ['aliquota_iss', 'Alíquota ISS'], ['aliquota_pis', 'Alíquota PIS'], ['aliquota_cofins', 'Alíquota COFINS'],
  ['aliquota_csll', 'Alíquota CSLL'], ['aliquota_inss', 'Alíquota INSS'], ['aliquota_irrf', 'Alíquota IRRF'],
  ['cst_pis', 'CST PIS'], ['cst_cofins', 'CST COFINS'], ['cst_pis_cofins', 'CST PIS/COFINS (Unificado)'],
];
const VALORES_MINIMOS_DESTACAR = [
  ['valor_minimo_destacar_pis', 'Mín. destacar PIS'], ['valor_minimo_destacar_cofins', 'Mín. destacar COFINS'],
  ['valor_minimo_destacar_csll', 'Mín. destacar CSLL'], ['valor_minimo_destacar_irrf', 'Mín. destacar IRRF'],
  ['valor_minimo_destacar_inss', 'Mín. destacar INSS'],
];
const VALORES_MINIMOS_RETER = [
  ['valor_minimo_retencao_pis', 'Mín. reter PIS'], ['valor_minimo_retencao_cofins', 'Mín. reter COFINS'],
  ['valor_minimo_retencao_csll', 'Mín. reter CSLL'], ['valor_minimo_retencao_irrf', 'Mín. reter IRRF'],
];
const DESTACAR_PF = [
  ['destacar_iss_pf', 'ISS (PF)'], ['destacar_pis_pf', 'PIS (PF)'], ['destacar_cofins_pf', 'COFINS (PF)'],
  ['destacar_csll_pf', 'CSLL (PF)'], ['destacar_irrf_pf', 'IRRF (PF)'], ['destacar_inss_pf', 'INSS (PF)'],
];
const DESTACAR_PJ = [
  ['destacar_iss_pj', 'ISS (PJ)'], ['destacar_pis_pj', 'PIS (PJ)'], ['destacar_cofins_pj', 'COFINS (PJ)'],
  ['destacar_csll_pj', 'CSLL (PJ)'], ['destacar_irrf_pj', 'IRRF (PJ)'], ['destacar_inss_pj', 'INSS (PJ)'],
];
const IBS_CBS = [
  ['cst_ibs_cbs', 'CST Tributação (IBS/CBS)'], ['cclass_tributacao', 'Classificação do IBS/CBS'],
  ['aliquota_ibs_uf', 'Alíquota IBS Estadual'], ['aliquota_ibs_mun', 'Alíquota IBS Municipal'], ['aliquota_cbs', 'Alíquota CBS'],
];
const DESTACAR = [...DESTACAR_PF, ...DESTACAR_PJ];

function corpoServico(s) {
  return `
    ${grupo('Informações do Serviço', s, INFO_SERVICO)}
    <div class="grupolinha">${grupo('Impostos', s, TRIBUTACAO_IMPOSTOS)}${grupo('IBS / CBS', s, IBS_CBS)}</div>
    <div class="grupolinha">${grupo('Valores Mínimos para Destacar', s, VALORES_MINIMOS_DESTACAR)}${grupo('Valores Mínimos para Reter', s, VALORES_MINIMOS_RETER)}</div>
    ${grupo('Destacar Impostos (PF/PJ)', s, DESTACAR)}
  `;
}

const ESTILO = `
    @page{margin:6mm 10mm}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;color:#1e293b;font-size:9px;line-height:1.2}
    .cabecalho{background:#4f46e5;color:#fff;padding:8px 14px;margin-bottom:6px}
    .cabecalho h1{font-size:14px}
    .cabecalho .sub{font-size:9px;opacity:.9;margin-top:2px}
    .servico-bloco{page-break-inside:avoid;margin:0 14px 8px;padding-bottom:6px;border-bottom:1px solid #e2e8f0}
    .servico-bloco:last-of-type{border-bottom:none}
    .servico-titulo{background:#eef2ff;color:#4f46e5;padding:3px 8px;margin-bottom:3px;font-size:11px;font-weight:700;border-radius:3px}
    .servico-titulo .status{font-size:8px;font-weight:400;margin-left:6px;text-transform:uppercase;color:#64748b}
    .kvgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(75px,1fr));gap:1px 8px}
    .kv{display:flex;flex-direction:column;padding:0 0 1px;border-bottom:1px solid #f1f5f9;overflow:hidden;page-break-inside:avoid}
    .kvk{font-size:6.5px;color:#94a3b8;text-transform:uppercase}
    .kvv{font-size:8.5px;word-break:break-word;overflow-wrap:anywhere}
    .grupo{margin-top:2px;padding:2px 5px;border:1px solid #e2e8f0;border-radius:3px}
    .grupo:first-of-type{margin-top:0}
    .grupo-titulo{display:block;font-size:6.5px;font-weight:700;color:#4f46e5;text-transform:uppercase}
    .grupolinha{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:2px;margin-top:2px}
    .grupolinha:first-of-type{margin-top:0}
    .grupolinha .grupo{margin-top:0}
    .rodape{margin:6px 14px 0;border-top:1px solid #e2e8f0;padding-top:3px;font-size:7px;color:#94a3b8;text-align:center}
`;

function montarHtmlListaServicos(servicos) {
  const blocos = servicos.map(s => `
    <div class="servico-bloco">
      <div class="servico-titulo">${esc(s.descricao || s.display || `Serviço ${s.id_servico_nfse}`)}<span class="status">${s.ativo ? 'Ativo' : 'Inativo'}</span></div>
      ${corpoServico(s)}
    </div>`).join('');

  return `<!doctype html><html><head><meta charset="utf-8"><style>${ESTILO}</style></head><body>
    <div class="cabecalho">
      <h1>Análise de Serviços (NFSe) — Catálogo completo</h1>
      <div class="sub">${servicos.length} serviço(s) · Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</div>
    </div>
    ${blocos}
    <div class="rodape">Kronos — Análise de Serviços (NFSe) — Cadastro e tributação de cada serviço</div>
  </body></html>`;
}

async function gerarPDFListaServicosNfse(servicos) {
  return htmlParaPdf(montarHtmlListaServicos(servicos));
}

module.exports = { gerarPDFListaServicosNfse, montarHtmlListaServicos };
