// Sync de hora em hora das vendas do HubSoft para a Meta do Comercial.
// Busca só o período recente (mês atual + mês anterior) — nunca varre a base inteira de
// clientes (16k+), o que sobrecarregaria o ERP. Grava em meta_comercial_venda_sync; a tela
// de Meta Comercial sempre lê do banco, nunca da API do HubSoft na hora do acesso.
const { all, run } = require('../config/database');
const { listarServicosVendidos } = require('../services/hubsoft');

function hojeSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
}
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

async function sincronizarEmpresa(empresa_id) {
  const hoje = new Date(hojeSP() + 'T12:00');
  const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const dataInicio = ymd(inicioMesAnterior);
  const dataFim = hojeSP();

  const servicos = await listarServicosVendidos({ dataInicio, dataFim });

  let gravados = 0;
  for (const s of servicos) {
    const v = s.vendedor || {};
    // data_venda vem "DD/MM/AAAA"; data_cancelamento pode vir com hora — normaliza pra YYYY-MM-DD
    const paraISO = (br) => {
      if (!br) return null;
      const m = String(br).match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };
    await run(
      `INSERT INTO meta_comercial_venda_sync
        (empresa_id, id_cliente_servico, id_vendedor, vendedor_nome, vendedor_email, nome_cliente, nome_servico, data_venda, status_prefixo, data_cancelamento, motivo_cancelamento, sincronizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (empresa_id, id_cliente_servico) DO UPDATE SET
         id_vendedor=EXCLUDED.id_vendedor, vendedor_nome=EXCLUDED.vendedor_nome, vendedor_email=EXCLUDED.vendedor_email,
         nome_cliente=EXCLUDED.nome_cliente, nome_servico=EXCLUDED.nome_servico, data_venda=EXCLUDED.data_venda,
         status_prefixo=EXCLUDED.status_prefixo, data_cancelamento=EXCLUDED.data_cancelamento,
         motivo_cancelamento=EXCLUDED.motivo_cancelamento, sincronizado_em=NOW()`,
      [
        empresa_id, s.id_cliente_servico, v.id_vendedor || null, v.nome || null, (v.email || '').toLowerCase() || null,
        s.cliente_nome, s.nome || null, paraISO(s.data_venda), s.status_prefixo || null,
        paraISO(s.data_cancelamento), s.motivo_cancelamento || null,
      ]
    );
    gravados++;
  }

  await run(
    `INSERT INTO meta_comercial_sync_status (empresa_id, ultima_sync, ultimo_status, ultimo_erro)
     VALUES ($1, NOW(), 'ok', NULL)
     ON CONFLICT (empresa_id) DO UPDATE SET ultima_sync=NOW(), ultimo_status='ok', ultimo_erro=NULL`,
    [empresa_id]
  );
  return gravados;
}

async function tick() {
  try {
    // Empresas com o módulo "ativado" (já tem vendedor cadastrado OU já sincronizou alguma vez).
    // Mantém o sync rodando mesmo com a lista de vendedores zerada, para a lista de
    // "detectados no HubSoft" continuar atualizada até ela cadastrar o primeiro vendedor.
    const empresas = await all(`
      SELECT empresa_id FROM meta_comercial_vendedor
      UNION
      SELECT empresa_id FROM meta_comercial_sync_status
    `);
    for (const { empresa_id } of empresas) {
      try {
        const n = await sincronizarEmpresa(empresa_id);
        console.log(`[syncMetaComercial] ${empresa_id}: ${n} serviços sincronizados`);
      } catch (e) {
        console.error(`[syncMetaComercial] ${empresa_id}: erro`, e.message);
        await run(
          `INSERT INTO meta_comercial_sync_status (empresa_id, ultima_sync, ultimo_status, ultimo_erro)
           VALUES ($1, NOW(), 'erro', $2)
           ON CONFLICT (empresa_id) DO UPDATE SET ultima_sync=NOW(), ultimo_status='erro', ultimo_erro=$2`,
          [empresa_id, String(e.message).slice(0, 300)]
        );
      }
    }
  } catch (e) { console.error('[syncMetaComercial]', e.message); }
}

function iniciar() {
  setTimeout(tick, 30 * 1000); // primeira carga logo após subir
  // De hora em hora — vendas "recentes" sem sobrecarregar o ERP (janela filtrada por data,
  // não varre a base inteira de clientes; ~476 clientes no teste, bem leve).
  setInterval(tick, 60 * 60 * 1000);
  console.log('[syncMetaComercial] iniciado (a cada 1h)');
}

module.exports = { iniciar, tick, sincronizarEmpresa };
