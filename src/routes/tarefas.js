const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);
const NOW = `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`;
function eid(req) { return req.usuario.empresa_id; }
function uid(req) { return req.usuario.id; }
function ehGestor(req) { return ['admin', 'gestor'].includes(req.usuario.perfil); }

const STATUS_VALIDOS = ['a_fazer', 'em_execucao', 'aguardando_aprovacao', 'concluido', 'reprovado', 'cancelado'];

async function logHist(tarefaId, req, acao, detalhe) {
  try {
    await run(
      `INSERT INTO tarefa_historico (id, tarefa_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), tarefaId, eid(req), uid(req), req.usuario.nome || '', acao, detalhe || null]
    );
  } catch {}
}
async function notificar(empresaId, usuarioId, titulo, texto, link) {
  if (!usuarioId) return;
  try {
    await run(
      `INSERT INTO notificacoes (id, empresa_id, usuario_id, tipo, titulo, texto, link)
       VALUES (?,?,?, 'tarefa', ?,?,?)`,
      [uuidv4(), empresaId, usuarioId, titulo, texto || null, link || '/tarefas']
    );
  } catch {}
}
const SEL = `
  SELECT t.*, c.nome AS criador_nome, r.nome AS responsavel_nome, a.titulo AS atividade_titulo
    FROM tarefas t
    LEFT JOIN usuarios c ON c.id = t.criado_por
    LEFT JOIN usuarios r ON r.id = t.responsavel_id
    LEFT JOIN atividades a ON a.id = t.atividade_id`;

// Lista as tarefas do usuário (criadas por ele OU delegadas a ele)
router.get('/', async (req, res) => {
  try {
    const tarefas = await all(
      `${SEL} WHERE t.empresa_id = ? AND (t.criado_por = ? OR t.responsavel_id = ?)
       ORDER BY t.created_at DESC`,
      [eid(req), uid(req), uid(req)]
    );
    res.json(tarefas);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Detalhe completo (tarefa + anexos + comentários + histórico)
router.get('/:id', async (req, res) => {
  try {
    const tarefa = await get(`${SEL} WHERE t.id = ? AND t.empresa_id = ?`, [req.params.id, eid(req)]);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    const anexos = await all('SELECT * FROM tarefa_anexos WHERE tarefa_id=? ORDER BY created_at', [req.params.id]);
    const podeVerPrivado = ehGestor(req) || tarefa.criado_por === uid(req);
    const comentarios = await all(
      `SELECT cm.*, u.nome AS autor_nome FROM tarefa_comentarios cm
        LEFT JOIN usuarios u ON u.id = cm.usuario_id
        WHERE cm.tarefa_id=? ${podeVerPrivado ? '' : 'AND cm.privado = 0'}
        ORDER BY cm.created_at`, [req.params.id]);
    const historico = await all('SELECT * FROM tarefa_historico WHERE tarefa_id=? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...tarefa, anexos, comentarios, historico });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Cria tarefa pessoal
router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, prioridade, prazo } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Título é obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO tarefas (id, empresa_id, titulo, descricao, prioridade, prazo, origem, status, criado_por, responsavel_id, aceito)
       VALUES (?,?,?,?,?,?, 'pessoal', 'a_fazer', ?, ?, 1)`,
      [id, eid(req), titulo.trim(), descricao || null, prioridade || 'media', prazo || null, uid(req), uid(req)]
    );
    await logHist(id, req, 'criada', 'Tarefa pessoal criada');
    res.status(201).json(await get(`${SEL} WHERE t.id = ?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Edita
router.put('/:id', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão para editar' });
    const { titulo, descricao, prioridade, prazo } = req.body;
    await run(
      `UPDATE tarefas SET titulo=?, descricao=?, prioridade=?, prazo=?, updated_at=${NOW} WHERE id=?`,
      [titulo?.trim() || t.titulo, descricao ?? t.descricao, prioridade || t.prioridade, prazo ?? t.prazo, req.params.id]
    );
    await logHist(req.params.id, req, 'editada', null);
    res.json(await get(`${SEL} WHERE t.id = ?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Muda status (drag and drop)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    const conc = status === 'concluido' ? NOW : 'NULL';
    await run(`UPDATE tarefas SET status=?, concluido_em=${conc}, updated_at=${NOW} WHERE id=?`, [status, req.params.id]);
    await logHist(req.params.id, req, 'status', status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Aceite do responsável
router.patch('/:id/aceitar', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Apenas o responsável pode aceitar' });
    await run(`UPDATE tarefas SET aceito=1, status='em_execucao', updated_at=${NOW} WHERE id=?`, [req.params.id]);
    await logHist(req.params.id, req, 'aceita', 'Responsável aceitou a tarefa');
    if (t.criado_por) await notificar(eid(req), t.criado_por, 'Tarefa aceita', `${req.usuario.nome} aceitou "${t.titulo}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Concluir (responsável) — vai para aprovação se exigida, senão concluído
router.patch('/:id/concluir', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.responsavel_id !== uid(req) && t.criado_por !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    if (t.aprovacao_obrigatoria) {
      await run(`UPDATE tarefas SET status='aguardando_aprovacao', updated_at=${NOW} WHERE id=?`, [req.params.id]);
      await logHist(req.params.id, req, 'concluida', 'Enviada para aprovação');
      if (t.criado_por) await notificar(eid(req), t.criado_por, 'Aprovação pendente', `"${t.titulo}" aguarda sua aprovação`);
    } else {
      await run(`UPDATE tarefas SET status='concluido', concluido_em=${NOW}, updated_at=${NOW} WHERE id=?`, [req.params.id]);
      await logHist(req.params.id, req, 'concluida', null);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Aprovar (gestor ou criador)
router.patch('/:id/aprovar', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (!ehGestor(req) && t.criado_por !== uid(req)) return res.status(403).json({ erro: 'Sem permissão para aprovar' });
    await run(`UPDATE tarefas SET status='concluido', concluido_em=${NOW}, aprovado_por=?, updated_at=${NOW} WHERE id=?`, [uid(req), req.params.id]);
    await logHist(req.params.id, req, 'aprovada', null);
    if (t.responsavel_id) await notificar(eid(req), t.responsavel_id, 'Tarefa aprovada', `"${t.titulo}" foi aprovada`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reprovar (volta para execução)
router.patch('/:id/reprovar', async (req, res) => {
  try {
    const { motivo } = req.body;
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (!ehGestor(req) && t.criado_por !== uid(req)) return res.status(403).json({ erro: 'Sem permissão' });
    await run(`UPDATE tarefas SET status='em_execucao', motivo_reprovacao=?, updated_at=${NOW} WHERE id=?`, [motivo || null, req.params.id]);
    await logHist(req.params.id, req, 'reprovada', motivo || null);
    if (t.responsavel_id) await notificar(eid(req), t.responsavel_id, 'Tarefa reprovada', `"${t.titulo}" foi reprovada${motivo ? ': ' + motivo : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Checklist (JSON [{texto, feito}])
router.put('/:id/checklist', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    await run(`UPDATE tarefas SET checklist=?, updated_at=${NOW} WHERE id=?`, [JSON.stringify(req.body.checklist || []), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Anexos / evidências
router.post('/:id/anexos', async (req, res) => {
  try {
    const { nome, tipo, url } = req.body;
    if (!nome || !url) return res.status(400).json({ erro: 'Nome e arquivo/link obrigatórios' });
    const id = uuidv4();
    await run(`INSERT INTO tarefa_anexos (id, tarefa_id, empresa_id, usuario_id, nome, tipo, url) VALUES (?,?,?,?,?,?,?)`,
      [id, req.params.id, eid(req), uid(req), nome, tipo || null, url]);
    await logHist(req.params.id, req, 'anexo', nome);
    res.status(201).json(await get('SELECT * FROM tarefa_anexos WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/:id/anexos/:aid', async (req, res) => {
  try {
    await run('DELETE FROM tarefa_anexos WHERE id=? AND tarefa_id=?', [req.params.aid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Comentários
router.post('/:id/comentarios', async (req, res) => {
  try {
    const { texto, privado } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Comentário vazio' });
    const priv = privado && ehGestor(req) ? 1 : 0; // só gestor cria privado
    const id = uuidv4();
    await run(`INSERT INTO tarefa_comentarios (id, tarefa_id, empresa_id, usuario_id, texto, privado) VALUES (?,?,?,?,?,?)`,
      [id, req.params.id, eid(req), uid(req), texto.trim(), priv]);
    await logHist(req.params.id, req, 'comentario', null);
    res.status(201).json(await get(
      `SELECT cm.*, u.nome AS autor_nome FROM tarefa_comentarios cm LEFT JOIN usuarios u ON u.id=cm.usuario_id WHERE cm.id=?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Exclui (criador)
router.delete('/:id', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && !ehGestor(req)) return res.status(403).json({ erro: 'Apenas o criador pode excluir' });
    await run('DELETE FROM tarefa_anexos WHERE tarefa_id=?', [req.params.id]);
    await run('DELETE FROM tarefa_comentarios WHERE tarefa_id=?', [req.params.id]);
    await run('DELETE FROM tarefa_historico WHERE tarefa_id=?', [req.params.id]);
    await run('DELETE FROM tarefas WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
