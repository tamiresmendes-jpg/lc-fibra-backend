// Completa as vendas já sincronizadas com o que só existe no PAINEL HubSoft:
// cidade e bairro reais do serviço, origem (novo/migrado) e situação do serviço,
// vindos do Relatório de Serviços; e a situação REAL do contrato (assinado ou
// não), vinda de um endpoint próprio — o relatório sempre devolve "-" nesse
// campo, então não serve. A API de integração não devolve nada disso.
//
// Casa pelo id_cliente_servico, que é a chave dos dois lados.
const { run, all } = require('../config/database');
const hubsoft = require('../services/hubsoft');

// Contrato é uma chamada POR SERVIÇO — roda algumas em paralelo (não 1 a 1,
// nem todas de uma vez) para não demorar demais nem sobrecarregar o HubSoft.
async function comConcorrenciaLimitada(itens, limite, tarefa) {
  const fila = [...itens];
  const trabalhador = async () => {
    let item;
    while ((item = fila.shift()) !== undefined) await tarefa(item);
  };
  await Promise.all(Array.from({ length: limite }, trabalhador));
}

// ATENÇÃO: o Relatório de Serviços lê data no formato AMERICANO (mm/dd/aaaa).
// Enviar 01/08/2026 achando que é 1º de agosto traz 8 de janeiro.
function ddmmaaaa(iso) {
  const [a, m, d] = iso.split('-');
  return `${m}/${d}/${a}`;
}

// "R$ 10,00" -> 10 (o relatório manda o valor já formatado em texto)
function paraNumero(brl) {
  if (brl == null) return null;
  const limpo = String(brl).replace(/[^\d,-]/g, '').replace(',', '.');
  const n = parseFloat(limpo);
  return Number.isFinite(n) ? n : null;
}

// Período = mês inteiro (YYYY-MM). Sem mês, usa o mês corrente em SP.
async function enriquecerMes(empresa_id, mesRef) {
  const mes = /^\d{4}-\d{2}$/.test(mesRef || '')
    ? mesRef
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  const [ano, m] = mes.split('-').map(Number);
  const ultimo = new Date(ano, m, 0).getDate();
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  // O relatório recusa data futura: no mês corrente, o fim é hoje
  const fimIso = mes === hoje.slice(0, 7) ? hoje : `${mes}-${String(ultimo).padStart(2, '0')}`;
  const di = ddmmaaaa(`${mes}-01`);
  const df = ddmmaaaa(fimIso);

  let pagina = 1, paginas = 1, atualizados = 0, lidos = 0;
  const idsParaContrato = [];
  do {
    const r = await hubsoft.relatorioServicos(empresa_id, { dataInicio: di, dataFim: df, pagina, limit: 200 });
    paginas = r.paginas || 1;
    lidos += r.registros.length;
    for (const s of r.registros) {
      const id = s.id_cliente_servico;
      if (!id) continue;
      const res = await run(
        `UPDATE meta_comercial_venda_sync
            SET cidade = COALESCE($3, cidade), bairro = $4, origem = $5, servico_status = $6,
                pacotes = $7, valor_pacotes = $8, genero = $9, vencimento = $10
          WHERE empresa_id = $1 AND id_cliente_servico = $2`,
        [empresa_id, id, s.cidade || null, s.bairro || null,
         (s.origem || '').toLowerCase() || null, s.servico_status || null,
         s.pacotes || null, paraNumero(s.valor_pacotes), s.genero || null,
         s.vencimento != null ? String(s.vencimento) : null]
      );
      if (res?.rowCount) atualizados += res.rowCount;
      idsParaContrato.push(id);
    }
    pagina++;
  } while (pagina <= paginas);

  // Situação do contrato: uma chamada por serviço, num endpoint próprio — o campo
  // do relatório acima ("-" sempre) não é confiável para isso.
  const ROTULOS = { assinado: 'Assinado', nao_assinado: 'Não assinado', sem_contrato: 'Sem contrato' };
  let contratosAtualizados = 0;
  await comConcorrenciaLimitada(idsParaContrato, 5, async (id) => {
    const situacao = await hubsoft.statusContrato(empresa_id, id).catch(() => null);
    if (!situacao) return; // chamada falhou: não afirma nada, mantém o que já tinha
    await run(
      `UPDATE meta_comercial_venda_sync SET situacao_contrato = $3
        WHERE empresa_id = $1 AND id_cliente_servico = $2`,
      [empresa_id, id, ROTULOS[situacao] || null]
    );
    contratosAtualizados++;
  });

  console.log(`[enriquecerVendas] ${mes}: ${lidos} do relatório, ${atualizados} venda(s) completada(s), ${contratosAtualizados} contrato(s) verificado(s)`);
  return { mes, lidos, atualizados, contratosAtualizados, paginas };
}

// Roda para o mês atual e o anterior (o anterior importa por causa dos cancelamentos)
async function enriquecerRecentes(empresa_id) {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const d = new Date(hoje + 'T12:00');
  const atual = hoje.slice(0, 7);
  const ant = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const anterior = `${ant.getFullYear()}-${String(ant.getMonth() + 1).padStart(2, '0')}`;
  const r1 = await enriquecerMes(empresa_id, atual).catch(e => ({ erro: e.message }));
  const r2 = await enriquecerMes(empresa_id, anterior).catch(e => ({ erro: e.message }));
  return { atual: r1, anterior: r2 };
}

async function paraTodasEmpresas() {
  try {
    const emps = await all('SELECT DISTINCT empresa_id FROM integracao_hubsoft_painel WHERE usuario IS NOT NULL');
    for (const { empresa_id } of emps) {
      await enriquecerRecentes(empresa_id).catch(e => console.error('[enriquecerVendas]', e.message));
    }
  } catch (e) { console.error('[enriquecerVendas]', e.message); }
}

module.exports = { enriquecerMes, enriquecerRecentes, paraTodasEmpresas };
