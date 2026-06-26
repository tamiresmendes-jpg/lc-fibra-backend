const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);
function eid(req) { return req.usuario.empresa_id; }
function uid(req) { return req.usuario.id; }

const STATUS_VALIDOS = ['a_fazer', 'em_execucao', 'aguardando_aprovacao', 'concluido'];

// Lista as tarefas do usuário (criadas por ele OU delegadas a ele)
router.get('/', async (req, res) => {
  try {
    const tarefas = await all(
      `SELECT t.*,
              c.nome AS criador_nome,
              r.nome AS responsavel_nome
         FROM tarefas t
         LEFT JOIN usuarios c ON c.id = t.criado_por
         LEFT JOIN usuarios r ON r.id = t.responsavel_id
        WHERE t.empresa_id = ?
          AND (t.criado_por = ? OR t.responsavel_id = ?)
        ORDER BY t.created_at DESC`,
      [eid(req), uid(req), uid(req)]
    );
    res.json(tarefas);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Cria tarefa pessoal
router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, prioridade, prazo } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Título é obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO tarefas (id, empresa_id, titulo, descricao, prioridade, prazo, origem, status, criado_por, responsavel_id)
       VALUES (?,?,?,?,?,?, 'pessoal', 'a_fazer', ?, ?)`,
      [id, eid(req), titulo.trim(), descricao || null, prioridade || 'media', prazo || null, uid(req), uid(req)]
    );
    res.status(201).json(await get(
      `SELECT t.*, c.nome AS criador_nome, r.nome AS responsavel_nome
         FROM tarefas t
         LEFT JOIN usuarios c ON c.id = t.criado_por
         LEFT JOIN usuarios r ON r.id = t.responsavel_id
        WHERE t.id = ?`, [id]
    ));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Edita uma tarefa (apenas criador ou responsável)
router.put('/:id', async (req, res) => {
  try {
    const tarefa = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (tarefa.criado_por !== uid(req) && tarefa.responsavel_id !== uid(req)) {
      return res.status(403).json({ erro: 'Sem permissão para editar esta tarefa' });
    }
    const { titulo, descricao, prioridade, prazo } = req.body;
    await run(
      `UPDATE tarefas SET titulo=?, descricao=?, prioridade=?, prazo=?,
              updated_at = TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
        WHERE id=?`,
      [titulo?.trim() || tarefa.titulo, descricao ?? tarefa.descricao,
       prioridade || tarefa.prioridade, prazo ?? tarefa.prazo, req.params.id]
    );
    res.json(await get(
      `SELECT t.*, c.nome AS criador_nome, r.nome AS responsavel_nome
         FROM tarefas t
         LEFT JOIN usuarios c ON c.id = t.criado_por
         LEFT JOIN usuarios r ON r.id = t.responsavel_id
        WHERE t.id = ?`, [req.params.id]
    ));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Muda o status (drag and drop no Kanban)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const tarefa = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (tarefa.criado_por !== uid(req) && tarefa.responsavel_id !== uid(req)) {
      return res.status(403).json({ erro: 'Sem permissão' });
    }
    const concluidoEm = status === 'concluido'
      ? `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`
      : 'NULL';
    await run(
      `UPDATE tarefas SET status=?, concluido_em=${concluidoEm},
              updated_at = TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
        WHERE id=?`,
      [status, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Exclui (apenas criador)
router.delete('/:id', async (req, res) => {
  try {
    const tarefa = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (tarefa.criado_por !== uid(req)) return res.status(403).json({ erro: 'Apenas o criador pode excluir' });
    await run('DELETE FROM tarefas WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
