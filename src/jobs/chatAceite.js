const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { enviarPush } = require('../config/webpush');

const MAX_TENTATIVAS = 3;
const PRAZO_MIN = 2; // minutos para aceitar

// Retorna BRT agora como string "YYYY-MM-DD HH24:MI:SS"
function brtAgora() {
  const d = new Date(Date.now() - 3 * 3600000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// Próximo prazo de aceite (BRT + 2 minutos)
function proximoPrazo() {
  const d = new Date(Date.now() - 3 * 3600000 + PRAZO_MIN * 60000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// Candidatos ao atendimento excluindo um usuário específico
async function candidatos(empresaId, grupoId, excluirId) {
  const deptos = await all(
    `SELECT departamento_id FROM chat_grupo_responsaveis WHERE grupo_id = ?`,
    [grupoId]
  );
  if (!deptos.length) return null;
  const deptoIds = deptos.map(d => d.departamento_id);
  const ph = deptoIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT id, nome FROM usuarios
     WHERE empresa_id = ? AND departamento_id IN (${ph}) AND ativo = 1
       AND COALESCE(chat_status, 'disponivel') = 'disponivel'
       ${excluirId ? 'AND id != ?' : ''}`,
    [empresaId, ...deptoIds, ...(excluirId ? [excluirId] : [])]
  );
  if (!rows.length) return null;
  let melhor = null, menor = Infinity;
  for (const c of rows) {
    const r = await get(
      `SELECT COUNT(*) AS t FROM chat_solicitacoes
       WHERE empresa_id = ? AND responsavel_id = ? AND status NOT IN ('concluida','cancelada')`,
      [empresaId, c.id]
    );
    const carga = Number(r?.t || 0);
    if (carga < menor) { menor = carga; melhor = c; }
  }
  return melhor;
}

async function logHist(solId, empresaId, acao, detalhe) {
  try {
    await run(
      `INSERT INTO chat_historico (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), solId, empresaId, null, 'Sistema', acao, detalhe || null]
    );
  } catch {}
}

async function ticketAceiteJob() {
  try {
    const agora = brtAgora();

    // Re-alerta responsável que pediu para aguardar
    const reAlertar = await all(
      `SELECT * FROM chat_solicitacoes
       WHERE re_alertar_em IS NOT NULL AND re_alertar_em <= ? AND status = 'distribuida'`,
      [agora]
    );
    for (const sol of reAlertar) {
      await run(
        `UPDATE chat_solicitacoes SET alerta_visto=0, re_alertar_em=NULL WHERE id=?`,
        [sol.id]
      );
      await logHist(sol.id, sol.empresa_id, 'lembrete', 'Lembrete: demanda ainda aguarda início do atendimento');
      await enviarPush(sol.empresa_id, sol.responsavel_id, {
        titulo: '🔔 Demanda aguardando você',
        corpo: `"${sol.titulo}" — ainda não foi iniciada`,
        solId: sol.id,
      });
    }

    // Busca todos os tickets com prazo de aceite em aberto
    const pendentes = await all(
      `SELECT * FROM chat_solicitacoes
       WHERE aceite_prazo IS NOT NULL AND status = 'distribuida'`,
      []
    );

    for (const sol of pendentes) {
      const venceu = sol.aceite_prazo <= agora;

      if (venceu) {
        // Prazo esgotado — redistribuir ou desistir
        const tentativas = (sol.aceite_tentativas || 0) + 1;

        if (tentativas > MAX_TENTATIVAS) {
          // Excedeu tentativas — volta para fila sem responsável
          await run(
            `UPDATE chat_solicitacoes
             SET status='nova', responsavel_id=NULL, responsavel_nome=NULL,
                 aceite_prazo=NULL, aceite_tentativas=0, ultimo_lembrete=NULL
             WHERE id=?`,
            [sol.id]
          );
          await logHist(sol.id, sol.empresa_id, 'status', 'Sem responsável disponível — aguardando na fila');
          continue;
        }

        const novo = await candidatos(sol.empresa_id, sol.grupo_id, sol.responsavel_id);

        if (!novo) {
          // Nenhum candidato — volta para fila
          await run(
            `UPDATE chat_solicitacoes
             SET status='nova', responsavel_id=NULL, responsavel_nome=NULL,
                 aceite_prazo=NULL, aceite_tentativas=0, ultimo_lembrete=NULL
             WHERE id=?`,
            [sol.id]
          );
          await logHist(sol.id, sol.empresa_id, 'status', 'Nenhum colaborador disponível — na fila');
          continue;
        }

        // Redistribuir para o próximo
        const prazo = proximoPrazo();
        await run(
          `UPDATE chat_solicitacoes
           SET responsavel_id=?, responsavel_nome=?, status='distribuida',
               alerta_visto=0, aceite_prazo=?, aceite_tentativas=?, ultimo_lembrete=NULL
           WHERE id=?`,
          [novo.id, novo.nome, prazo, tentativas, sol.id]
        );
        await logHist(sol.id, sol.empresa_id, 'distribuida',
          `Redistribuída para ${novo.nome} (tentativa ${tentativas}/${MAX_TENTATIVAS})`);

        try {
          await run(
            `INSERT INTO notificacoes (id, empresa_id, usuario_id, tipo, titulo, texto, link)
             VALUES (?,?,?, 'chat', ?,?, '/kronos-chat')`,
            [uuidv4(), sol.empresa_id, novo.id, 'Nova solicitação', `"${sol.titulo}" foi atribuída a você`]
          );
        } catch {}
        await enviarPush(sol.empresa_id, novo.id, {
          titulo: 'Nova demanda para você',
          corpo: sol.titulo,
          solId: sol.id,
        });

      } else {
        // Prazo ainda não venceu — enviar lembrete se necessário
        if (sol.alerta_visto) continue; // já marcou como visto, não incomodar mais

        const agd = agora; // BRT agora
        const deveEnviar = !sol.ultimo_lembrete
          || (new Date(agd.replace(' ', 'T') + 'Z') - new Date(sol.ultimo_lembrete.replace(' ', 'T') + 'Z')) >= 25000;

        if (!deveEnviar) continue;

        const prazoDate = new Date(sol.aceite_prazo.replace(' ', 'T') + 'Z');
        const agoraDate = new Date(agd.replace(' ', 'T') + 'Z');
        const restanteSeg = Math.max(0, Math.round((prazoDate - agoraDate) / 1000));
        const min = Math.floor(restanteSeg / 60);
        const seg = restanteSeg % 60;
        const restanteStr = `${min}m ${String(seg).padStart(2, '0')}s`;

        await enviarPush(sol.empresa_id, sol.responsavel_id, {
          titulo: '⏳ Demanda aguardando aceite',
          corpo: `"${sol.titulo}" — ${restanteStr} para aceitar`,
          solId: sol.id,
        });

        await run(
          `UPDATE chat_solicitacoes SET ultimo_lembrete=? WHERE id=?`,
          [agora, sol.id]
        );
      }
    }
  } catch (e) {
    console.error('[chatAceiteJob]', e.message);
  }
}

function iniciarJob() {
  // Primeira execução após 15s (DB já conectado)
  setTimeout(ticketAceiteJob, 15000);
  setInterval(ticketAceiteJob, 30000);
  console.log('[chatAceiteJob] Job de aceite iniciado (intervalo: 30s)');
}

module.exports = { iniciarJob };
