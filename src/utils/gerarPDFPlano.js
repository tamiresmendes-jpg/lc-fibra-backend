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
function kvGrid(obj, omitir) {
  const entradas = Object.entries(obj).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined && v !== '' && typeof v !== 'object' && !omitir?.has(k));
  if (!entradas.length) return '';
  return `<div class="kvgrid">${entradas.map(([k, v]) => `<div class="kv"><span class="kvk">${esc(rotulo(k))}</span><span class="kvv">${esc(fmtEscalar(k, v))}</span></div>`).join('')}</div>`;
}
// Campo-referência (ex.: tipo_servico) manda o número duas vezes: solto
// (id_tipo_servico) e de novo dentro do próprio objeto resolvido
// (tipo_servico.tipo_servico). Junta os dois num só "Nome (#id)".
function nomeResolvido(chave, obj) {
  const texto = obj?.display || obj?.descricao || obj?.nome;
  if (!texto) return null;
  const id = obj[chave] ?? obj[`id_${chave}`];
  return id != null ? `${texto} (#${id})` : texto;
}
// Inclui as variações id_<chave>/<chave> pra excluir do "Outros campos" tudo
// que já apareceu resolvido num grupo (senão o número solto reaparece lá).
function comVariantesId(chaves) {
  const s = new Set();
  for (const c of chaves) { s.add(c); s.add(`id_${c}`); s.add(c.replace(/^id_/, '')); }
  return s;
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
// Grupo com título (ex.: "IBS / CBS") — só aparece se tiver campo preenchido.
// Mesmo agrupamento das telas "Editar Composição" / "Configuração" do painel.
function grupo(titulo, obj, campos) {
  const presentes = campos.filter(([chave]) => obj[chave] !== null && obj[chave] !== undefined && obj[chave] !== '');
  if (!presentes.length) return '';
  const kv = presentes.map(([chave, rot]) => `<div class="kv"><span class="kvk">${esc(rot)}</span><span class="kvv">${esc(fmtCampoGrupo(chave, obj[chave]))}</span></div>`).join('');
  return `<div class="grupo"><span class="grupo-titulo">${esc(titulo)}</span><div class="kvgrid">${kv}</div></div>`;
}
// Texto longo (ex.: "Informação Complementar") — caixa com borda, tipo área
// de texto, em vez de kvgrid comum (que fica ruim pra parágrafo grande).
function grupoTexto(titulo, obj, chave) {
  const v = obj[chave];
  if (v === null || v === undefined || v === '') return '';
  return `<div class="grupo"><span class="grupo-titulo">${esc(titulo)}</span><div class="textocaixa">${esc(String(v))}</div></div>`;
}
function fmtCampoGrupo(chave, v) {
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'object') return nomeResolvido(chave, v) || fmtEscalar(chave, JSON.stringify(v));
  return fmtEscalar(chave, v);
}

const COMPOSICAO_CADASTRO = [
  ['descricao', 'Descrição'], ['representacao_percentual', 'Percentual (%)'],
  ['descricao_nota_fiscal', 'Descrição Nota Fiscal'], ['plano_conta', 'Plano de Contas'],
  ['empresa', 'Empresa'], ['incluir_dici_anatel', 'Incluir DICI Anatel'],
  ['tipo_servico', 'Tipo de Serviço'], ['tipo_documento_fiscal', 'Tipo de Documento Fiscal'],
  ['aplicar_partilha_icms', 'Aplicar Partilha ICMS'],
];
// "Incluir Nfcom" só existe na tela do painel quando o Tipo de Documento
// Fiscal do item NÃO é NFCom (fica redundante/escondido quando já é NFCom).
function ehDocumentoNfcom(item) {
  const doc = item?.tipo_documento_fiscal;
  return /nfcom/i.test(doc?.descricao || doc?.display || '');
}
const COMPOSICAO_ICMS = [['icms', 'ICMS (%)'], ['cst_tributacao', 'CST Tributação (ICMS)'], ['tipo_tributo', 'Tipo Tributação (ICMS)']];
const COMPOSICAO_PIS = [['pis', 'PIS (%)'], ['cst_pis', 'CST PIS'], ['tipo_bc_pis', 'Tipo BC PIS']];
const COMPOSICAO_COFINS = [['cofins', 'COFINS (%)'], ['cst_cofins', 'CST COFINS'], ['tipo_bc_cofins', 'Tipo BC COFINS']];
const COMPOSICAO_IBSCBS = [
  ['cst_tributacao_ibs_cbs', 'CST Tributação (IBS/CBS)'], ['cclass_tributacao', 'Classificação do IBS/CBS'],
  ['tipo_bc_ibs_cbs', 'Tipo BC IBS e CBS'],
];
const COMPOSICAO_IBS_UF = [
  ['percentual_ibs_uf', 'Alíquota IBS'], ['deferimento_ibs_uf', 'Deferimento IBS'],
  ['valor_tributo_ibs_devolvido_uf', 'Valor Tributo IBS Devolvido'], ['reducao_aliquota_ibs_uf', 'Redução da Alíquota IBS'],
  ['aliquota_efetiva_ibs_uf', 'Alíquota Efetiva IBS'],
];
const COMPOSICAO_IBS_MUN = [
  ['percentual_ibs_mun', 'Alíquota IBS'], ['deferimento_ibs_mun', 'Deferimento IBS'],
  ['valor_tributo_ibs_devolvido_mun', 'Valor Tributo IBS Devolvido'], ['reducao_aliquota_ibs_mun', 'Redução da Alíquota IBS'],
  ['aliquota_efetiva_ibs_mun', 'Alíquota Efetiva IBS'],
];
const COMPOSICAO_CBS = [
  ['percentual_cbs', 'Alíquota CBS'], ['deferimento_cbs', 'Deferimento CBS'],
  ['valor_tributo_cbs_devolvido', 'Valor Tributo Devolvido CBS'], ['reducao_aliquota_cbs', 'Redução da Alíquota CBS'],
  ['aliquota_efetiva_cbs', 'Alíquota Efetiva CBS'],
];
const COMPOSICAO_COMPRA_GOV = [
  ['tipo_ente_compra_governamental', 'Tipo Ente Compra Governamental'], ['aliquota_reducao_compra_governamental', 'Alíquota de Redução'],
];
const COMPOSICAO_OUTROS = [
  ['csll', 'CSLL (%)'], ['irrf', 'IRRF (%)'], ['fust', 'FUST (%)'], ['funttel', 'FUNTTEL (%)'], ['fcp', 'FCP (%)'],
  ['tipo_utilizacao', 'Tipo de Utilização'], ['cclass', 'Classificação de Item da NFCom'],
  ['codigo_beneficio_fiscal', 'Código do Benefício Fiscal'], ['codigo_servico', 'Código Serviço (IBPT)'],
  ['cnpj_operadora_longa_distancia', 'CNPJ Operadora Longa Distância'],
];
const COMPOSICAO_PRODUTO_ESTOQUE = [
  ['local_estoque', 'Local de Estoque'], ['tipo_movimento_estoque', 'Tipo de Movimento de Estoque'], ['produto', 'Produto'],
];
const COMPOSICAO_COMPLEMENTAR = [['informacao_complementar', 'Informação Complementar']];
const COMPOSICAO_GRUPOS = [
  COMPOSICAO_CADASTRO, COMPOSICAO_ICMS, COMPOSICAO_PIS, COMPOSICAO_COFINS, COMPOSICAO_IBSCBS,
  COMPOSICAO_IBS_UF, COMPOSICAO_IBS_MUN, COMPOSICAO_CBS, COMPOSICAO_COMPRA_GOV,
  COMPOSICAO_OUTROS, COMPOSICAO_PRODUTO_ESTOQUE, COMPOSICAO_COMPLEMENTAR,
];
const COMPOSICAO_CAMPOS_USADOS = comVariantesId(COMPOSICAO_GRUPOS.flat().map(([chave]) => chave));

function renderItemComposicao(item, titulo) {
  const restante = Object.fromEntries(Object.entries(item).filter(([k]) => !k.startsWith('_') && !COMPOSICAO_CAMPOS_USADOS.has(k)));
  const restanteHtml = Object.keys(restante).length
    ? `<details open class="aninhado"><summary>Outros campos deste item</summary>${kvGrid(restante)}</details>` : '';
  const temIbsCbs = [...COMPOSICAO_IBSCBS, ...COMPOSICAO_IBS_UF, ...COMPOSICAO_IBS_MUN, ...COMPOSICAO_CBS]
    .some(([chave]) => item[chave] !== null && item[chave] !== undefined && item[chave] !== '');
  const ibsCbsHtml = temIbsCbs ? `
    ${grupo('IBS / CBS', item, COMPOSICAO_IBSCBS)}
    <div class="grupolinha">${grupo('Dados IBS Estadual', item, COMPOSICAO_IBS_UF)}${grupo('Dados IBS Municipal', item, COMPOSICAO_IBS_MUN)}${grupo('Dados CBS', item, COMPOSICAO_CBS)}</div>
    ${grupo('Compra Governamental', item, COMPOSICAO_COMPRA_GOV)}
  ` : '';
  return `<div class="bloco"><b class="bloco-titulo">${esc(titulo)}</b>
    ${grupo('Dados Cadastrais / Financeiros', item, ehDocumentoNfcom(item) ? COMPOSICAO_CADASTRO : [...COMPOSICAO_CADASTRO, ['incluir_nfcom', 'Incluir Nfcom']])}
    <div class="grupolinha">${grupo('ICMS', item, COMPOSICAO_ICMS)}${grupo('PIS', item, COMPOSICAO_PIS)}${grupo('COFINS', item, COMPOSICAO_COFINS)}</div>
    ${ibsCbsHtml}
    <div class="grupolinha">${grupo('Outros Impostos', item, COMPOSICAO_OUTROS)}${grupo('Produto / Estoque', item, COMPOSICAO_PRODUTO_ESTOQUE)}</div>
    ${grupoTexto('Informação Complementar', item, 'informacao_complementar')}
    ${restanteHtml}
  </div>`;
}

const CONFIG_GERAIS = [
  ['imprime_boleto', 'Imprimir Boleto'], ['permite_franquia', 'Permite Cobrar Franquia'], ['envia_boleto', 'Enviar Boleto'],
  ['avisar_franquia_email', 'Avisar Franquia por Email'], ['imprime_carne', 'Imprimir Carnê'], ['permite_dar_desconto', 'Permite Conceder Desconto'],
  ['envia_carne', 'Enviar Carnê'], ['envia_aviso_email', 'Envia Aviso Email'], ['avisar_franquia_sms', 'Avisar Franquia por SMS'],
  ['gera_nota_fiscal', 'Gerar Nota Fiscal'], ['permite_cobrar_multa', 'Permite Cobrar Multa'], ['envia_aviso_sms', 'Envia Aviso SMS / Mensageiro'],
  ['permite_protestar_serasa', 'Permite Protestar Serasa'], ['permite_proporcional', 'Permite Proporcional'], ['permite_suspender', 'Permite Suspender'],
  ['permite_desbloqueio_confianca', 'Permite Desbloqueio Confiança'], ['permite_reajuste', 'Permite Reajuste de Valor'],
  ['permite_renovacao', 'Permite Renovação Vigência Contratual'], ['envia_aviso_ligacao', 'Envia Aviso Ligação'],
  ['permite_protestar_spc', 'Permite Protestar SPC'], ['permite_cobrar_taxa_boleto', 'Cobrar Taxa do Boleto'],
  ['envia_nota_fiscal', 'Enviar Nota Fiscal'], ['permite_reduzir_velocidade', 'Permite Reduzir Velocidade'],
  ['atualiza_coords_instalacao', 'Atualizar Coordenadas do Endereço de Instalação'], ['permite_vender_para', 'Permite Vender para'],
];
const CONFIG_FISCAIS = [
  ['cfop', 'CFOP'], ['iss_retido', 'ISS Retido'], ['imposto_federal_retido', 'Imposto Federal Retido'],
  ['retencao_pis', 'Retenção PIS'], ['retencao_cofins', 'Retenção COFINS'], ['retencao_csll', 'Retenção CSLL'],
  ['retencao_irrf', 'Retenção IRRF'], ['retencao_nfse', 'Retenção NFSe'], ['retencao_nfcom', 'Retenção NFCom'], ['retencao_modelo_0', 'Retenção Modelo 0'],
];
const CONFIG_REAJUSTE = [
  ['reajuste_automatico', 'Reajuste Automático'], ['reajustar_pacotes', 'Reajustar Pacotes'], ['renovar_contrato', 'Renovar Contrato'],
  ['indice_reajuste', 'Índice de Reajuste'], ['tipo_data_reajuste', 'Tipo de Data do Reajuste'],
];
const CONFIG_OUTROS = [
  ['boleto_separado', 'Boleto Separado'], ['agrupamento_nota', 'Agrupamento Nota'], ['agrupamento_fatura', 'Agrupamento Fatura'],
  ['forma_cobranca', 'Forma de Cobrança'],
];
const CONFIG_GRUPOS = [CONFIG_GERAIS, CONFIG_FISCAIS, CONFIG_REAJUSTE, CONFIG_OUTROS];
const CONFIG_CAMPOS_USADOS = comVariantesId(CONFIG_GRUPOS.flat().map(([chave]) => chave));

function renderConfiguracao(obj) {
  const restante = Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_') && !CONFIG_CAMPOS_USADOS.has(k)));
  const restanteHtml = Object.keys(restante).length
    ? `<details open class="aninhado"><summary>Outros campos desta seção</summary>${kvGrid(restante)}</details>` : '';
  return `<div class="bloco">
    ${grupo('Configurações Gerais', obj, CONFIG_GERAIS)}
    ${grupo('Configurações Fiscais', obj, CONFIG_FISCAIS)}
    ${grupo('Reajuste de Valor', obj, CONFIG_REAJUSTE)}
    ${grupo('Outros', obj, CONFIG_OUTROS)}
    ${restanteHtml}
  </div>`;
}

// Mesmos campos da tela "Pacotes" (catálogo geral) do painel.
const PACOTE_CADASTRO = [
  ['descricao', 'Descrição'], ['codigo', 'Código'], ['valor', 'Valor'],
  ['degustacao', 'Degustação'], ['obrigatorio', 'Obrigatório'], ['ativo', 'Ativo'],
];
const PACOTE_CONFIG = [
  ['gerenciado_api', 'Gerenciado API'], ['permite_stfc', 'Permite STFC'], ['permite_mvno', 'Permite MVNO'],
  ['permite_degustacao', 'Permite Degustação'], ['nao_cobrar_degustacao', 'Não Cobrar Degustação'],
  ['permite_proporcional', 'Permite Proporcional'], ['permite_seguranca_monitoramento', 'Permite Segurança/Monitoramento'],
];
const PACOTE_CAMPOS_USADOS = comVariantesId([...PACOTE_CADASTRO, ...PACOTE_CONFIG].map(([chave]) => chave));

function renderItemPacote(item, titulo) {
  const restante = Object.fromEntries(Object.entries(item).filter(([k]) => !k.startsWith('_') && !PACOTE_CAMPOS_USADOS.has(k)));
  const restanteHtml = Object.keys(restante).length
    ? `<details open class="aninhado"><summary>Outros campos deste pacote</summary>${kvGrid(restante)}</details>` : '';
  return `<div class="bloco"><b class="bloco-titulo">${esc(titulo)}</b>
    ${grupo('Cadastro', item, PACOTE_CADASTRO)}
    ${grupo('Configuração', item, PACOTE_CONFIG)}
    ${restanteHtml}
  </div>`;
}

function renderValor(v, chave, nivel = 0) {
  if (v === null || v === undefined || v === '') return '<span class="vazio">—</span>';
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="vazio">—</span>';
    if (typeof v[0] !== 'object') return esc(v.join(', '));
    if (chave === 'servico_composicao') {
      const lista = agruparComposicao(v);
      return `<div class="arr">${lista.map((item, i) => renderItemComposicao(item, `Item ${i + 1}${item._quantidade > 1 ? ` — ${item._quantidade}x` : ''}`)).join('')}</div>`;
    }
    if (chave === 'servico_pacote') {
      return `<div class="arr">${v.map((item, i) => renderItemPacote(item, `Pacote ${i + 1}`)).join('')}</div>`;
    }
    return `<div class="arr">${v.map((item, i) => renderObjeto(item, nivel + 1, `Item ${i + 1}`)).join('')}</div>`;
  }
  if (chave === 'configuracao' && typeof v === 'object') return renderConfiguracao(v);
  if (typeof v === 'object') return renderObjeto(v, nivel + 1, undefined, chave);
  return esc(fmtEscalar(chave, v));
}
function renderObjeto(obj, nivel, titulo, chave) {
  const resolvido = !titulo && chave ? nomeResolvido(chave, obj) : null;
  const omitir = resolvido ? new Set([chave, 'descricao', 'display']) : undefined;
  const cabecalho = titulo || resolvido || 'Detalhes';
  const complexas = Object.entries(obj).filter(([k, v]) => !k.startsWith('_') && typeof v === 'object' && v !== null && !omitir?.has(k));
  const corpo = kvGrid(obj, omitir) + complexas.map(([k, v]) => `<div class="complexa"><span class="complexa-titulo">${esc(rotulo(k))}</span>${renderValor(v, k, nivel)}</div>`).join('');
  // "open" fixo — no papel não dá pra clicar pra expandir, então já mostra tudo.
  if (nivel >= 2) return `<details open class="aninhado"><summary>${esc(cabecalho)}</summary>${corpo}</details>`;
  return `<div class="bloco">${(titulo || resolvido) ? `<b class="bloco-titulo">${esc(cabecalho)}</b>` : ''}${corpo}</div>`;
}

// PDF do plano traz só o essencial: cadastro + Composição + Pacotes (com a
// composição/config de cada pacote) — sem Contratos, Desconto, Navegação,
// Configuração etc. (informação de cadastro do próprio HubSoft, menos útil
// pra quem só quer conferir o que o cliente está pagando e por quê).
const SECOES = [
  ['servico_composicao', 'Composição'], ['servico_pacote', 'Pacotes'],
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
    .grupo{margin-top:3px;padding:3px 5px;border:1px solid #e2e8f0;border-radius:3px}
    .grupo:first-of-type{margin-top:0}
    .grupo-titulo{display:block;font-size:6.5px;font-weight:700;color:#4f46e5;text-transform:uppercase}
    .grupolinha{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:3px;margin-top:3px}
    .grupolinha:first-of-type{margin-top:0}
    .grupolinha .grupo{margin-top:0}
    .textocaixa{margin-top:2px;padding:3px 5px;border:1px solid #cbd5e1;border-radius:3px;background:#f8fafc;white-space:pre-wrap;word-break:break-word}
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
