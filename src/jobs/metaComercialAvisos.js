// Avisa no Discord quando um vendedor bate a meta do mês, assim que o sync detecta.
// Cada vendedor é avisado UMA vez por mês (a marca fica em meta_batida_avisada).
const { all, run } = require('../config/database');
const { notificar: notificarDiscord, COR } = require('../utils/discord');

function mesAtualSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }).slice(0, 7);
}

async function avisarMetasBatidas(empresa_id) {
  const mes = mesAtualSP();
  try {
    await run('ALTER TABLE meta_comercial_vendedor ADD COLUMN IF NOT EXISTS meta_batida_avisada TEXT');

    // require lazy: evita ciclo entre rotas e jobs
    const gestao = require('../routes/gestao-extra');
    if (typeof gestao.montarMetaComercial !== 'function') return;

    const dados = await gestao.montarMetaComercial(empresa_id, mes, 'admin');
    const bateram = (dados.itens || []).filter(i => i.conta_meta && i.bate_meta);
    if (!bateram.length) return;

    // Quem ainda não foi avisado neste mês
    const jaAvisados = await all(
      `SELECT id FROM meta_comercial_vendedor WHERE empresa_id=$1 AND meta_batida_avisada=$2`, [empresa_id, mes]);
    const setAvisados = new Set(jaAvisados.map(v => v.id));
    const novos = bateram.filter(i => !setAvisados.has(i.id));
    if (!novos.length) return;

    for (const v of novos) {
      // Marca ANTES de enviar: se o envio falhar, não repete a cada hora
      await run('UPDATE meta_comercial_vendedor SET meta_batida_avisada=$1 WHERE id=$2 AND empresa_id=$3',
        [mes, v.id, empresa_id]);
      // Só o reconhecimento: números de meta/vendas/saldo ficam restritos ao painel
      await notificarDiscord(empresa_id, 'meta_batida', {
        title: '🎯 Meta batida!',
        description: `**${v.nome}**${v.filial ? ` (${v.filial})` : ''} bateu a meta do mês!\n\nParabéns! 👏`,
        color: COR.verde || COR.laranja,
        linkPath: '/metas',
        footer: { text: 'Kronos — Meta do Comercial' },
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      console.log(`[metaComercialAvisos] meta batida avisada: ${v.nome}`);
    }
  } catch (e) {
    console.error('[metaComercialAvisos]', e.message);
  }
}

// Avisa cada CANCELAMENTO novo de venda de vendedor cadastrado, uma única vez por contrato.
// Só PAP e Comercial interno entram — Escritório (filiais) não é avisado aqui.
// Entra SÓ a venda do mês anterior cancelada no mês atual (venda de julho cancelada
// em agosto, e assim por diante) — é ela que desconta do saldo. Cancelamento no
// mesmo mês da venda não avisa, porque essa venda nem chegou a contar.
async function avisarCancelamentos(empresa_id) {
  const mes = mesAtualSP();
  const [a, m] = mes.split('-').map(Number);
  const d = new Date(a, m - 2, 1);
  const mesAnterior = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  try {
    await run('ALTER TABLE meta_comercial_venda_sync ADD COLUMN IF NOT EXISTS cancel_avisado_em TIMESTAMP');
    await run('ALTER TABLE meta_comercial_vendedor ADD COLUMN IF NOT EXISTS discord_id TEXT');

    // Canceladas no mês atual, de vendedor de PAP/Comercial, ainda não avisadas
    const novos = await all(
      `SELECT s.id_cliente_servico, s.nome_cliente, s.cidade, s.vendedor_nome, s.data_venda,
              s.data_cadastro, s.data_cancelamento, s.motivo_cancelamento,
              v.nome AS vendedor_cadastrado, v.filial, v.discord_id,
              -- Formatadas no banco: o servidor roda em UTC e converter DATE para o
              -- fuso de SP jogava meia-noite para as 21h do dia anterior (data errada)
              TO_CHAR(COALESCE(s.data_cadastro, s.data_venda),'DD/MM/YYYY') AS cadastro_br,
              TO_CHAR(s.data_cancelamento,'DD/MM/YYYY') AS cancelamento_br
       FROM meta_comercial_venda_sync s
       JOIN meta_comercial_vendedor v
         ON v.empresa_id = s.empresa_id AND LOWER(v.hubsoft_email) = LOWER(s.vendedor_email) AND v.ativo = true
       WHERE s.empresa_id = $1
         AND s.data_cancelamento IS NOT NULL
         AND TO_CHAR(s.data_cancelamento,'YYYY-MM') = $3
         AND s.cancel_avisado_em IS NULL
         AND (LOWER(v.filial) LIKE '%pap%' OR LOWER(v.filial) LIKE '%comercial%')
         AND TO_CHAR(s.data_venda,'YYYY-MM') = $2
       ORDER BY s.data_cancelamento`,
      [empresa_id, mesAnterior, mes]);
    if (!novos.length) return;

    for (const c of novos) {
      // Marca antes de enviar para não repetir a cada sync
      await run('UPDATE meta_comercial_venda_sync SET cancel_avisado_em = NOW() WHERE empresa_id=$1 AND id_cliente_servico=$2',
        [empresa_id, c.id_cliente_servico]);
      // Marca o vendedor de verdade quando o ID do Discord dele está cadastrado;
      // sem o ID o Discord não notifica, então cai no nome em negrito.
      const nomeVend = c.vendedor_cadastrado || c.vendedor_nome || '—';
      const vendedor = c.discord_id
        ? `<@${c.discord_id}>${c.filial ? ` (${c.filial})` : ''}`
        : `**${nomeVend}**${c.filial ? ` (${c.filial})` : ''}`;
      await notificarDiscord(empresa_id, 'meta_cancelamento', {
        title: '❌ Cancelamento de venda',
        fields: [
          { name: '👤 Cliente', value: c.nome_cliente || '—', inline: true },
          { name: '🧑‍💼 Vendedor', value: vendedor, inline: false },
          { name: '📅 Cadastro', value: c.cadastro_br || '—', inline: true },
          { name: '🚫 Cancelamento', value: c.cancelamento_br || '—', inline: true },
          { name: '📝 Motivo', value: c.motivo_cancelamento || '—', inline: false },
        ],
        color: COR.vermelho || COR.laranja,
        linkPath: '/metas',
        footer: { text: 'Kronos — Meta do Comercial' },
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      console.log(`[metaComercialAvisos] cancelamento avisado: ${c.nome_cliente}`);
    }
  } catch (e) {
    console.error('[metaComercialAvisos/cancelamentos]', e.message);
  }
}

module.exports = { avisarMetasBatidas, avisarCancelamentos };
