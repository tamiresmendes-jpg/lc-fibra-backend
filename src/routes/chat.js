const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

const NOW = `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`;
const eid = (req) => req.usuario.empresa_id;
const uid = (req) => req.usuario.id;
const unome = (req) => req.usuario.nome || '';
const ehGestor = (req) => ['admin', 'gestor'].includes(req.usuario.perfil);

const STATUS_VALIDOS = ['nova', 'distribuida', 'em_atendimento', 'aguardando_retorno', 'concluida', 'cancelada', 'reaberta'];
const STATUS_ABERTOS = ['nova', 'distribuida', 'em_atendimento', 'aguardando_retorno', 'reaberta'];

const SEL = `
  SELECT s.*, d.nome AS departamento_nome,
         (SELECT COUNT(*) FROM chat_mensagens m WHERE m.solicitacao_id = s.id) AS total_mensagens
    FROM chat_solicitacoes s
    LEFT JOIN departamentos d ON d.id = s.departamento_id`;

async function logHist(solId, req, acao, detalhe) {
  try {
    await run(
      `INSERT INTO chat_historico (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), solId, eid(req), uid(req), unome(req), acao, detalhe || null]
    );
  } catch {}
}
async function notificar(empresaId, usuarioId, titulo, texto) {
  if (!usuarioId) return;
  try {
    await run(
      `INSERT INTO notificacoes (id, empresa_id, usuario_id, tipo, titulo, texto, link)
       VALUES (?,?,?, 'chat', ?,?, '/kronos-chat')`,
      [uuidv4(), empresaId, usuarioId, titulo, texto || null]
    );
  } catch {}
}

// Distribuição automática: colaborador DISPONÍVEL do departamento com menor carga ativa
async function distribuir(empresaId, departamentoId) {
  if (!departamentoId) return null;
  const candidatos = await all(
    `SELECT id, nome FROM usuarios
     WHERE empresa_id = ? AND departamento_id = ? AND ativo = 1
       AND COALESCE(chat_status, 'disponivel') = 'disponivel'`,
    [empresaId, departamentoId]
  );
  if (!candidatos.length) return null;
  let melhor = null, menor = Infinity;
  for (const c of candidatos) {
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

// ── Status do próprio colaborador ──────────────────────────────
router.get('/meu-status', async (req, res) => {
  try {
    const u = await get('SELECT chat_status FROM usuarios WHERE id = ?', [uid(req)]);
    res.json({ status: u?.chat_status || 'disponivel' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.patch('/meu-status', async (req, res) => {
  try {
    const { status } = req.body;
    const validos = ['disponivel', 'ocupado', 'em_lanche', 'em_pausa', 'ausente'];
    if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    await run('UPDATE usuarios SET chat_status = ? WHERE id = ?', [status, uid(req)]);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Colaboradores disponíveis (para reatribuição manual)
router.get('/colaboradores', async (req, res) => {
  try {
    const { departamento_id } = req.query;
    let sql = `SELECT id, nome, chat_status, departamento_id FROM usuarios WHERE empresa_id = ? AND ativo = 1 AND COALESCE(perfil,'colaborador') <> 'admin'`;
    const params = [eid(req)];
    if (departamento_id) { sql += ' AND departamento_id = ?'; params.push(departamento_id); }
    sql += ' ORDER BY nome';
    res.json(await all(sql, params));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Fila de solicitações ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, departamento_id, escopo } = req.query;
    let sql = `${SEL} WHERE s.empresa_id = ?`;
    const params = [eid(req)];
    if (status) { sql += ` AND s.status = ?`; params.push(status); }
    if (departamento_id) { sql += ` AND s.departamento_id = ?`; params.push(departamento_id); }
    if (escopo === 'minhas') { sql += ` AND (s.criado_por = ? OR s.responsavel_id = ?)`; params.push(uid(req), uid(req)); }
    // Abertas primeiro, depois mais recentes
    sql += ` ORDER BY CASE WHEN s.status IN ('concluida','cancelada') THEN 1 ELSE 0 END, s.updated_at DESC`;
    res.json(await all(sql, params));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Detalhe (solicitação + mensagens + histórico)
router.get('/:id', async (req, res) => {
  try {
    const sol = await get(`${SEL} WHERE s.id = ? AND s.empresa_id = ?`, [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    const mensagens = await all('SELECT * FROM chat_mensagens WHERE solicitacao_id = ? ORDER BY created_at ASC', [req.params.id]);
    const historico = await all('SELECT * FROM chat_historico WHERE solicitacao_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...sol, mensagens, historico });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar solicitação (+ distribuição automática)
router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, categoria, departamento_id, prioridade, anexo, anexo_nome, anexo_tipo } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Título é obrigatório' });
    const id = uuidv4();

    const resp = await distribuir(eid(req), departamento_id);
    const status = resp ? 'distribuida' : 'nova';

    await run(
      `INSERT INTO chat_solicitacoes
        (id, empresa_id, titulo, descricao, categoria, departamento_id, prioridade, status, criado_por, criado_por_nome, responsavel_id, responsavel_nome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, eid(req), titulo.trim(), descricao || null, categoria || 'geral', departamento_id || null,
       prioridade || 'media', status, uid(req), unome(req), resp?.id || null, resp?.nome || null]
    );
    await logHist(id, req, 'criada', 'Solicitação aberta');
    if (resp) {
      await logHist(id, req, 'distribuida', `Distribuída automaticamente para ${resp.nome}`);
      await notificar(eid(req), resp.id, 'Nova solicitação', `"${titulo.trim()}" foi atribuída a você`);
    }
    // Mensagem inicial opcional (anexo enviado na abertura)
    const temAnexo = anexo && typeof anexo === 'string' && anexo.startsWith('data:');
    if (temAnexo) {
      if (anexo.length > 5_500_000) return res.status(400).json({ erro: 'Anexo muito grande (máx. ~4MB).' });
      await run(
        `INSERT INTO chat_mensagens (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, texto, anexo, anexo_nome, anexo_tipo)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), id, eid(req), uid(req), unome(req), null, anexo, anexo_nome || 'anexo', anexo_tipo || null]
      );
    }
    res.status(201).json(await get(`${SEL} WHERE s.id = ?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function podeAgir(sol, req) {
  return ehGestor(req) || sol.criado_por === uid(req) || sol.responsavel_id === uid(req);
}

// Enviar mensagem na tratativa
router.post('/:id/mensagens', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão nesta solicitação' });
    const { texto, anexo, anexo_nome, anexo_tipo } = req.body;
    const temAnexo = anexo && typeof anexo === 'string' && anexo.startsWith('data:');
    if (!(texto && texto.trim()) && !temAnexo) return res.status(400).json({ erro: 'Mensagem vazia' });
    if (temAnexo && anexo.length > 5_500_000) return res.status(400).json({ erro: 'Anexo muito grande (máx. ~4MB).' });
    const mid = uuidv4();
    await run(
      `INSERT INTO chat_mensagens (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, texto, anexo, anexo_nome, anexo_tipo)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [mid, req.params.id, eid(req), uid(req), unome(req), texto?.trim() || null, temAnexo ? anexo : null, temAnexo ? (anexo_nome || 'anexo') : null, temAnexo ? (anexo_tipo || null) : null]
    );
    // Responsável respondeu numa solicitação distribuída → entra em atendimento
    let novoStatus = sol.status;
    if (sol.status === 'distribuida' && sol.responsavel_id === uid(req)) novoStatus = 'em_atendimento';
    await run(`UPDATE chat_solicitacoes SET status = ?, updated_at = ${NOW} WHERE id = ?`, [novoStatus, req.params.id]);
    if (novoStatus !== sol.status) await logHist(req.params.id, req, 'status', 'Em atendimento');
    // Notifica a outra parte
    const destino = uid(req) === sol.criado_por ? sol.responsavel_id : sol.criado_por;
    if (destino && destino !== uid(req)) await notificar(eid(req), destino, 'Nova mensagem', `"${sol.titulo}" tem uma nova mensagem`);
    res.status(201).json(await get('SELECT * FROM chat_mensagens WHERE id = ?', [mid]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mudar status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão' });
    const conc = status === 'concluida' ? NOW : 'NULL';
    await run(`UPDATE chat_solicitacoes SET status = ?, concluido_em = ${conc}, updated_at = ${NOW} WHERE id = ?`, [status, req.params.id]);
    await logHist(req.params.id, req, 'status', status);
    if (sol.criado_por && sol.criado_por !== uid(req)) await notificar(eid(req), sol.criado_por, 'Solicitação atualizada', `"${sol.titulo}" mudou para: ${status}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reatribuir responsável (manual)
router.patch('/:id/responsavel', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão' });
    const { responsavel_id } = req.body;
    let novo = null;
    if (responsavel_id) {
      novo = await get('SELECT id, nome FROM usuarios WHERE id = ? AND empresa_id = ?', [responsavel_id, eid(req)]);
      if (!novo) return res.status(404).json({ erro: 'Colaborador não encontrado' });
    }
    const novoStatus = novo ? (sol.status === 'nova' ? 'distribuida' : sol.status) : 'nova';
    await run(
      `UPDATE chat_solicitacoes SET responsavel_id = ?, responsavel_nome = ?, status = ?, updated_at = ${NOW} WHERE id = ?`,
      [novo?.id || null, novo?.nome || null, novoStatus, req.params.id]
    );
    await logHist(req.params.id, req, 'reatribuida', novo ? `Atribuída a ${novo.nome}` : 'Removido responsável');
    if (novo && novo.id !== uid(req)) await notificar(eid(req), novo.id, 'Solicitação atribuída', `"${sol.titulo}" foi atribuída a você`);
    res.json(await get(`${SEL} WHERE s.id = ?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Redistribuir automaticamente
router.post('/:id/redistribuir', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão' });
    const resp = await distribuir(eid(req), sol.departamento_id);
    if (!resp) return res.status(400).json({ erro: 'Nenhum colaborador disponível no departamento' });
    await run(
      `UPDATE chat_solicitacoes SET responsavel_id = ?, responsavel_nome = ?, status = 'distribuida', updated_at = ${NOW} WHERE id = ?`,
      [resp.id, resp.nome, req.params.id]
    );
    await logHist(req.params.id, req, 'distribuida', `Redistribuída para ${resp.nome}`);
    if (resp.id !== uid(req)) await notificar(eid(req), resp.id, 'Solicitação atribuída', `"${sol.titulo}" foi atribuída a você`);
    res.json(await get(`${SEL} WHERE s.id = ?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir (criador ou gestor)
router.delete('/:id', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!ehGestor(req) && sol.criado_por !== uid(req)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM chat_mensagens WHERE solicitacao_id = ?', [req.params.id]);
    await run('DELETE FROM chat_historico WHERE solicitacao_id = ?', [req.params.id]);
    await run('DELETE FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
