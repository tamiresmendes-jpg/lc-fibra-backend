// Excel (xlsx) da Análise de Planos — uma planilha por seção do plano
// (Cadastro, Composição, Desconto, Contratos, etc.) quando é 1 plano só, ou
// uma planilha única com o resumo de todos, quando é a lista inteira.
const XLSX = require('xlsx');

const CAMPOS_PERCENTUAL = /percentual|garantia_banda|^(icms|pis|cofins|fust|funttel|irrf|csll|fcp)$/i;
const CAMPOS_DINHEIRO = /^valor(_|$)|_valor$/i;
function fmtEscalar(k, v) {
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (v === null || v === undefined) return '';
  const num = Number(v);
  if (!Number.isNaN(num) && v !== '') {
    if (CAMPOS_PERCENTUAL.test(k)) return `${num}%`;
    if (CAMPOS_DINHEIRO.test(k)) return num; // valor numérico puro — Excel formata como número, não texto
  }
  return v;
}
function rotulo(k) {
  return String(k || '').replace(/^id_/, '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}
// Achata um objeto (só campos simples — objeto/array aninhado vira 1 célula
// com JSON, pra não perder a informação mesmo sem estrutura de planilha).
function achatar(obj) {
  const linha = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined || v === '') continue;
    linha[rotulo(k)] = (v && typeof v === 'object') ? JSON.stringify(v) : fmtEscalar(k, v);
  }
  return linha;
}

const SECOES = [
  ['servico_composicao', 'Composicao'], ['servico_desconto', 'Desconto'], ['servico_contrato', 'Contratos'],
  ['servico_taxa_instalacao', 'Taxa Instalacao'], ['servico_navegacao', 'Navegacao'], ['servico_pacote', 'Pacotes'],
  ['acao_evento_sistema', 'Acoes Eventos'], ['configuracao', 'Configuracao'], ['servico_atributo_extra', 'Atributo Extra'],
  ['parametros', 'Parametros'], ['perfil_migracao_servico', 'Migracao SAC'], ['servico_integracao_rede_neutra', 'Redes Neutras'],
];

function gerarExcelPlano(plano) {
  const wb = XLSX.utils.book_new();

  const basico = {
    descricao: plano.descricao, nome_exibicao: plano.nome_exibicao, valor: plano.valor,
    tipo_pagamento: plano.tipo_pagamento, tipo_cobranca: plano.tipo_cobranca, validade: plano.validade,
    garantia_banda_download: plano.garantia_banda_download, garantia_banda_upload: plano.garantia_banda_upload,
    carne: plano.carne, emite_contrato: plano.emite_contrato, ativo: plano.ativo, data_cadastro: plano.data_cadastro,
  };
  const linhasCadastro = Object.entries(basico)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ({ Campo: rotulo(k), Valor: fmtEscalar(k, v) }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhasCadastro), 'Cadastro');

  for (const [chave, nomeAba] of SECOES) {
    const v = plano[chave];
    if (!v) continue;
    const linhas = Array.isArray(v) ? v.map(achatar) : [achatar(v)];
    if (!linhas.length) continue;
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), nomeAba.slice(0, 31)); // nome de aba tem limite de 31 caracteres
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Uma linha por plano — resumo (mesmos campos da tabela da tela).
function gerarExcelListaPlanos(planos) {
  const linhas = planos.map(p => ({
    Plano: p.descricao || p.nome_exibicao,
    'Nome de exibição': p.nome_exibicao || '',
    Status: p.ativo ? 'Ativo' : 'Inativo',
    Tecnologia: p.servico_tecnologia?.descricao || '',
    Valor: p.valor ?? '',
    'Valor dos pacotes': p.valor_pacotes ?? '',
    'Total c/ pacotes': p.valor_com_pacote ?? '',
    Vigência: p.validade ?? '',
    'Clientes ativos': p.clientes_servicos_count ?? 0,
  }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(linhas), 'Planos');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { gerarExcelPlano, gerarExcelListaPlanos };
