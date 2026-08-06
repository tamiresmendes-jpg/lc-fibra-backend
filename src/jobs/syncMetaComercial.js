// Sync de hora em hora das vendas do HubSoft para a Meta do Comercial.
// Varre a base completa de clientes (~285 páginas, ~30s) porque os filtros de data da API
// perdem vendas — ver comentário em listarServicosVendidos. Grava em meta_comercial_venda_sync;
// a tela de Meta Comercial sempre lê do banco, nunca da API do HubSoft na hora do acesso.
const { all, run } = require('../config/database');
const { listarServicosVendidos } = require('../services/hubsoft');

async function sincronizarEmpresa(empresa_id) {
  // SEM filtro de data: data_inicio/data_fim da API filtram pela data de cadastro do CLIENTE,
  // e uma venda feita este mês para um cliente antigo ficaria de fora (janela de 24 meses
  // cobria só 38% da base). A varredura completa leva ~30s e garante 100% das vendas.
  const servicos = await listarServicosVendidos();

  let gravados = 0;
  for (const s of servicos) {
    const v = s.vendedor || {};
    // data_venda vem "DD/MM/AAAA"; as demais podem vir com hora ou em ISO — normaliza pra YYYY-MM-DD
    const paraISO = (br) => {
      if (!br) return null;
      const s = String(br);
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
    };
    await run(
      `INSERT INTO meta_comercial_venda_sync
        (empresa_id, id_cliente_servico, id_vendedor, vendedor_nome, vendedor_email, nome_cliente, nome_servico, data_venda, status_prefixo, data_cancelamento, motivo_cancelamento, data_cadastro, data_habilitacao, cidade, tipo_pessoa, valor, tecnologia, sincronizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       ON CONFLICT (empresa_id, id_cliente_servico) DO UPDATE SET
         id_vendedor=EXCLUDED.id_vendedor, vendedor_nome=EXCLUDED.vendedor_nome, vendedor_email=EXCLUDED.vendedor_email,
         nome_cliente=EXCLUDED.nome_cliente, nome_servico=EXCLUDED.nome_servico, data_venda=EXCLUDED.data_venda,
         status_prefixo=EXCLUDED.status_prefixo, data_cancelamento=EXCLUDED.data_cancelamento,
         motivo_cancelamento=EXCLUDED.motivo_cancelamento, data_cadastro=EXCLUDED.data_cadastro,
         data_habilitacao=EXCLUDED.data_habilitacao,
         -- A API de integração nunca traz cidade (é sempre nula) — sem COALESCE,
         -- esta sincronização apagava a cidade real que o enriquecimento (painel)
         -- já tinha preenchido minutos antes.
         cidade=COALESCE(EXCLUDED.cidade, meta_comercial_venda_sync.cidade),
         tipo_pessoa=EXCLUDED.tipo_pessoa, valor=EXCLUDED.valor, tecnologia=EXCLUDED.tecnologia,
         sincronizado_em=NOW()`,
      [
        empresa_id, s.id_cliente_servico, v.id_vendedor || null, v.nome || null, (v.email || '').toLowerCase() || null,
        s.cliente_nome, s.nome || null, paraISO(s.data_venda), s.status_prefixo || null,
        paraISO(s.data_cancelamento), s.motivo_cancelamento || null,
        paraISO(s.data_cadastro), paraISO(s.data_habilitacao), s.cidade || null,
        s.tipo_pessoa || null, Number(s.valor) || null, s.tecnologia || null,
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

// Trava para não rodar dois ciclos ao mesmo tempo. Necessária porque o ciclo
// ficou curto (poucos minutos) e a verificação de contrato pode demorar mais
// que isso quando tem muita venda no mês.
let _rodando = false;

async function tick() {
  if (_rodando) { console.log('[syncMetaComercial] ciclo anterior ainda rodando, pulou esta vez'); return; }
  _rodando = true;
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
        // Com os dados atualizados, avisa no Discord quem bateu a meta e os cancelamentos novos
        const avisos = require('./metaComercialAvisos');
        // Completa cidade, bairro, origem e situação com o Relatório de Serviços do painel
        await require('./enriquecerVendas').enriquecerRecentes(empresa_id).catch(() => {});
        await avisos.avisarMetasBatidas(empresa_id).catch(() => {});
        await avisos.avisarCancelamentos(empresa_id).catch(() => {});
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
  finally { _rodando = false; }
}

function iniciar() {
  setTimeout(tick, 30 * 1000); // primeira carga logo após subir
  // A cada 4 minutos — quase tempo real sem sobrecarregar o HubSoft. A trava
  // acima evita que dois ciclos se cruzem se um demorar mais que isso.
  setInterval(tick, 4 * 60 * 1000);
  console.log('[syncMetaComercial] iniciado (a cada 4 min)');
}

module.exports = { iniciar, tick, sincronizarEmpresa };
