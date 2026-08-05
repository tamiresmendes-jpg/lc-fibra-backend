// Completa as vendas já sincronizadas com o que só existe no Relatório de Serviços
// do PAINEL HubSoft: cidade e bairro reais do serviço, origem (novo/migrado),
// situação do serviço e do contrato. A API de integração não devolve nada disso.
//
// Casa pelo id_cliente_servico, que é a chave dos dois lados.
const { run, all } = require('../config/database');
const hubsoft = require('../services/hubsoft');

function ddmmaaaa(iso) {
  const [a, m, d] = iso.split('-');
  return `${d}/${m}/${a}`;
}

// Período = mês inteiro (YYYY-MM). Sem mês, usa o mês corrente em SP.
async function enriquecerMes(empresa_id, mesRef) {
  const mes = /^\d{4}-\d{2}$/.test(mesRef || '')
    ? mesRef
    : new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
  const [ano, m] = mes.split('-').map(Number);
  const ultimo = new Date(ano, m, 0).getDate();
  const di = ddmmaaaa(`${mes}-01`);
  const df = ddmmaaaa(`${mes}-${String(ultimo).padStart(2, '0')}`);

  let pagina = 1, paginas = 1, atualizados = 0, lidos = 0;
  do {
    const r = await hubsoft.relatorioServicos(empresa_id, { dataInicio: di, dataFim: df, pagina, limit: 200 });
    paginas = r.paginas || 1;
    lidos += r.registros.length;
    for (const s of r.registros) {
      const id = s.id_cliente_servico;
      if (!id) continue;
      const res = await run(
        `UPDATE meta_comercial_venda_sync
            SET cidade = COALESCE($3, cidade), bairro = $4, origem = $5,
                servico_status = $6, situacao_contrato = $7
          WHERE empresa_id = $1 AND id_cliente_servico = $2`,
        [empresa_id, id, s.cidade || null, s.bairro || null,
         (s.origem || '').toLowerCase() || null, s.servico_status || null,
         // O painel manda "-" quando não há contrato registrado
         (s.situacao_contrato && s.situacao_contrato !== '-') ? s.situacao_contrato : null]
      );
      if (res?.rowCount) atualizados += res.rowCount;
    }
    pagina++;
  } while (pagina <= paginas);

  console.log(`[enriquecerVendas] ${mes}: ${lidos} do relatório, ${atualizados} venda(s) completada(s)`);
  return { mes, lidos, atualizados, paginas };
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
