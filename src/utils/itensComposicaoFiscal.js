// Achata a composição de TODOS os planos (ativos + inativos com cliente) numa
// lista única de itens — cada linha é 1 item de composição de 1 plano, com
// todos os campos fiscais relevantes (ICMS/PIS/COFINS, IBS/CBS, tipo doc.
// fiscal, cclass/NFCom, etc.), pra alimentar a tela de filtro combinado.
function descricaoOuNenhum(campo) {
  if (!campo) return 'Nenhum';
  return campo.descricao || campo.display || String(campo);
}
function codigoDescricao(campo) {
  if (!campo) return null;
  const partes = [campo.codigo, campo.descricao || campo.display].filter(v => v != null && v !== '');
  return partes.length ? partes.join(' - ') : null;
}

function achatarItem(plano, item) {
  return {
    id_servico: plano.id_servico,
    descricao_plano: plano.descricao || plano.nome_exibicao || `Plano ${plano.id_servico}`,
    valor_plano: plano.valor,
    ativo: !!plano.ativo,
    clientes_servicos_count: plano.clientes_servicos_count ?? 0,

    descricao_item: item.descricao,
    percentual_representacao: item.representacao_percentual,
    descricao_nota_fiscal: item.descricao_nota_fiscal,

    icms: item.icms,
    cst_icms: descricaoOuNenhum(item.cst_tributacao),
    tipo_tributo_icms: descricaoOuNenhum(item.tipo_tributo),
    aplicar_partilha_icms: !!item.aplicar_partilha_icms,

    pis: item.pis,
    cst_pis: descricaoOuNenhum(item.cst_pis),
    tipo_bc_pis: descricaoOuNenhum(item.tipo_bc_pis),

    cofins: item.cofins,
    cst_cofins: descricaoOuNenhum(item.cst_cofins),
    tipo_bc_cofins: descricaoOuNenhum(item.tipo_bc_cofins),

    cst_ibs_cbs: descricaoOuNenhum(item.cst_tributacao_ibs_cbs),
    cclass_tributacao_ibs_cbs: descricaoOuNenhum(item.cclass_tributacao),
    tipo_bc_ibs_cbs: descricaoOuNenhum(item.tipo_bc_ibs_cbs),

    percentual_ibs_uf: item.percentual_ibs_uf,
    deferimento_ibs_uf: item.deferimento_ibs_uf,
    valor_tributo_ibs_devolvido_uf: item.valor_tributo_ibs_devolvido_uf,
    reducao_aliquota_ibs_uf: item.reducao_aliquota_ibs_uf,
    aliquota_efetiva_ibs_uf: item.aliquota_efetiva_ibs_uf,

    percentual_ibs_mun: item.percentual_ibs_mun,
    deferimento_ibs_mun: item.deferimento_ibs_mun,
    valor_tributo_ibs_devolvido_mun: item.valor_tributo_ibs_devolvido_mun,
    reducao_aliquota_ibs_mun: item.reducao_aliquota_ibs_mun,
    aliquota_efetiva_ibs_mun: item.aliquota_efetiva_ibs_mun,

    percentual_cbs: item.percentual_cbs,
    deferimento_cbs: item.deferimento_cbs,
    valor_tributo_cbs_devolvido: item.valor_tributo_cbs_devolvido,
    reducao_aliquota_cbs: item.reducao_aliquota_cbs,
    aliquota_efetiva_cbs: item.aliquota_efetiva_cbs,

    tipo_ente_compra_governamental: descricaoOuNenhum(item.tipo_ente_compra_governamental),
    aliquota_reducao_compra_governamental: item.aliquota_reducao_compra_governamental,

    tipo_documento_fiscal: codigoDescricao(item.tipo_documento_fiscal) || 'Nenhum',
    tipo_servico: codigoDescricao(item.tipo_servico) || 'Nenhum',
    tipo_utilizacao: codigoDescricao(item.tipo_utilizacao) || 'Nenhum',
    cclass: codigoDescricao(item.cclass) || 'Nenhum',
    codigo_servico_ibpt: item.codigo_servico ?? null,
    codigo_beneficio_fiscal: item.codigo_beneficio_fiscal ?? null,
    cnpj_operadora_longa_distancia: item.cnpj_operadora_longa_distancia ?? null,

    csll: item.csll,
    irrf: item.irrf,
    fust: item.fust,
    funttel: item.funttel,
    fcp: item.fcp,

    plano_conta: codigoDescricao(item.plano_conta) || 'Nenhum',
  };
}

// Retorna TODOS os itens de composição de TODOS os planos informados (já
// filtrados por quem chama — ativo + inativo-com-cliente).
function listarItensComposicao(planos) {
  const linhas = [];
  for (const plano of planos) {
    const composicao = Array.isArray(plano.servico_composicao) ? plano.servico_composicao : [];
    for (const item of composicao) linhas.push(achatarItem(plano, item));
  }
  return linhas;
}

module.exports = { listarItensComposicao, achatarItem };
