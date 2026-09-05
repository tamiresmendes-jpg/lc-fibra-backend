// Relatório "Volumetria de Livros (SVA)" — quantos e-books (item de composição
// "LC+ Livros") o mês precisa, por plano e por faixa (Bronze/Prata/Ouro/...).
// A quantidade de livros de um plano é quantas vezes o item "LC+ Livros"
// se repete na composição dele (mesmo mecanismo de agrupamento "×N" já usado
// na tela/PDF de Análise de Planos — ver agruparComposicao).
const { agruparComposicao } = require('./gerarPDFPlano');
const hubsoft = require('../services/hubsoft');

const NOME_ITEM_REGEX = /LC\+?\s*Livros/i;

// Fatura vence com o cliente num desses status = não recebe nota (mesmo já
// tendo o livro entregue) — "ficou de fora" daquele ciclo de faturamento.
const STATUS_SEM_NOTA_REGEX = /cancelad|bloque|inativ/i;

// Nomes de faixa conhecidos hoje — quantidade que não bater com nenhum aqui
// aparece como "N livros" mesmo, pra não inventar rótulo.
const NOME_FAIXA = { 2: 'Bronze', 3: 'Prata', 4: 'Ouro' };

// Soma TODOS os grupos que batem com "LC+ Livros", não só o primeiro — linhas
// idênticas na composição (mesma descrição/percentual) agrupam certinho, mas
// se alguma linha tiver um campo diferente das outras (ex.: valor calculado
// com centavos diferentes), ela vira um grupo à parte em vez de somar no
// mesmo — pegar só o primeiro grupo (find) sub-contava esses casos.
function quantidadeLivros(plano) {
  const composicao = Array.isArray(plano.servico_composicao) ? plano.servico_composicao : [];
  const grupos = agruparComposicao(composicao);
  return grupos
    .filter(g => NOME_ITEM_REGEX.test(g.descricao || ''))
    .reduce((soma, g) => soma + (g._quantidade || 0), 0);
}

// planos: já vem de planosComClienteDetalhados (ativo/inativo-com-cliente,
// já com clientes_servicos_count e servico_composicao completos).
function montarRelatorioLivros(planos) {
  const linhas = [];
  for (const plano of planos) {
    const clientes = plano.clientes_servicos_count ?? 0;
    if (!clientes) continue;
    const qtdLivros = quantidadeLivros(plano);
    if (!qtdLivros) continue; // plano sem o item "LC+ Livros" na composição — não entra na volumetria
    linhas.push({
      id_servico: plano.id_servico,
      descricao_plano: plano.descricao || plano.nome_exibicao || `Plano ${plano.id_servico}`,
      ativo: !!plano.ativo,
      clientes_servicos_count: clientes,
      quantidade_livros_por_cliente: qtdLivros,
      total_livros: clientes * qtdLivros,
      faixa: NOME_FAIXA[qtdLivros] || `${qtdLivros} livros`,
    });
  }

  const porFaixa = new Map();
  for (const l of linhas) {
    const acc = porFaixa.get(l.faixa) || { faixa: l.faixa, quantidade_livros_por_cliente: l.quantidade_livros_por_cliente, clientes: 0, total_livros: 0 };
    acc.clientes += l.clientes_servicos_count;
    acc.total_livros += l.total_livros;
    porFaixa.set(l.faixa, acc);
  }
  const resumo = [...porFaixa.values()].sort((a, b) => a.quantidade_livros_por_cliente - b.quantidade_livros_por_cliente);
  const totalGeral = resumo.reduce((s, r) => s + r.total_livros, 0);

  return {
    planos: linhas.sort((a, b) => a.quantidade_livros_por_cliente - b.quantidade_livros_por_cliente),
    resumo,
    total_geral: totalGeral,
  };
}

const normalizarNomePlano = (s) => String(s || '').trim().toUpperCase();

// Últimos N meses FECHADOS (não inclui o mês atual, que ainda não fechou).
function ultimosMesesFechados(qtd) {
  const hoje = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const meses = [];
  for (let i = 1; i <= qtd; i++) {
    const ini = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    const fim = new Date(hoje.getFullYear(), hoje.getMonth() - i + 1, 0);
    meses.push({
      chave: `${ini.getFullYear()}-${String(ini.getMonth() + 1).padStart(2, '0')}`,
      dataInicio: iso(ini),
      dataFim: iso(fim),
    });
  }
  return meses;
}

// Varre as faturas (contas a receber) por vencimento dos últimos meses
// fechados e soma, por plano, quantas venceram com o cliente FORA (status
// bloqueado/inativo/cancelado — não recebe nota, mesmo já tendo o livro) x
// DENTRO (recebeu nota normal). Taxa de aderência = dentro / total —
// aplicada sobre os clientes ativos de HOJE dá uma estimativa mais realista
// do que "todo cliente ativo recebe nota".
// planosComLivros: [{ descricao_plano, faixa, quantidade_livros_por_cliente }]
async function calcularAderenciaLivros(empresaId, planosComLivros, { meses = 3 } = {}) {
  const porNome = new Map();
  for (const p of planosComLivros) {
    porNome.set(normalizarNomePlano(p.descricao_plano), {
      descricao_plano: p.descricao_plano,
      faixa: p.faixa,
      total: 0, dentro: 0, fora: 0,
    });
  }
  const janelas = ultimosMesesFechados(meses);
  for (const janela of janelas) {
    await hubsoft.varrerContaReceber(
      { empresaId, dataInicio: `${janela.dataInicio}T00:00:00.000Z`, dataFim: `${janela.dataFim}T23:59:59.999Z`, tipoData: 'data_vencimento' },
      async (lote) => {
        for (const f of lote) {
          const acc = porNome.get(normalizarNomePlano(f.servico));
          if (!acc) continue;
          acc.total++;
          if (STATUS_SEM_NOTA_REGEX.test(f.status_servico || '')) acc.fora++;
          else acc.dentro++;
        }
      }
    );
  }
  const planos = [...porNome.values()].map((acc) => ({
    ...acc,
    taxa_aderencia: acc.total > 0 ? acc.dentro / acc.total : null,
  }));
  return { calculado_em: new Date().toISOString(), janela_meses: janelas.map((j) => j.chave), planos };
}

module.exports = { montarRelatorioLivros, quantidadeLivros, calcularAderenciaLivros };
