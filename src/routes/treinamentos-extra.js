const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard-stats', autenticar, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const [totalTrein, concluidos, emAndamento, participantes] = await Promise.all([
      get(`SELECT COUNT(*) AS n FROM treinamentos WHERE empresa_id=? AND excluido_em IS NULL`, [eid]),
      get(`SELECT COUNT(*) AS n FROM treinamento_participantes tp JOIN treinamentos t ON t.id=tp.treinamento_id WHERE t.empresa_id=? AND tp.status='concluido'`, [eid]),
      get(`SELECT COUNT(*) AS n FROM treinamento_participantes tp JOIN treinamentos t ON t.id=tp.treinamento_id WHERE t.empresa_id=? AND tp.status='em_andamento'`, [eid]),
      get(`SELECT COUNT(DISTINCT tp.usuario_id) AS n FROM treinamento_participantes tp JOIN treinamentos t ON t.id=tp.treinamento_id WHERE t.empresa_id=?`, [eid]),
    ]);
    const recentes = await all(`SELECT t.titulo, t.status, t.created_at FROM treinamentos t WHERE t.empresa_id=? AND t.excluido_em IS NULL ORDER BY t.created_at DESC LIMIT 5`, [eid]);
    res.json({ totalTrein: totalTrein.n, concluidos: concluidos.n, emAndamento: emAndamento.n, participantes: participantes.n, recentes });
  } catch { res.status(500).json({ erro: 'Erro ao buscar stats' }); }
});

// ── CERTIFICADOS ─────────────────────────────────────────────────────────────
router.get('/certificados', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT tp.*, t.titulo AS treinamento_titulo, t.carga_horaria,
              u.nome AS colaborador_nome, d.nome AS departamento_nome
       FROM treinamento_participantes tp
       JOIN treinamentos t ON t.id = tp.treinamento_id
       JOIN usuarios u ON u.id = tp.usuario_id
       LEFT JOIN departamentos d ON d.id = u.departamento_id
       WHERE t.empresa_id = ? AND tp.status = 'concluido'
       ORDER BY tp.data_conclusao DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar certificados' }); }
});

// ── TRILHAS ──────────────────────────────────────────────────────────────────
router.get('/trilhas', autenticar, async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM trilhas_aprendizagem WHERE empresa_id=? ORDER BY created_at DESC`, [req.usuario.empresa_id]);
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar trilhas' }); }
});

router.post('/trilhas', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, nivel, departamento_id, carga_horaria } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO trilhas_aprendizagem (id,empresa_id,titulo,descricao,nivel,departamento_id,carga_horaria,criado_por) VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, nivel || 'iniciante', departamento_id || null, carga_horaria || null, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM trilhas_aprendizagem WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar trilha' }); }
});

router.put('/trilhas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM trilhas_aprendizagem WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, nivel, departamento_id, carga_horaria, status } = req.body;
    await run(
      `UPDATE trilhas_aprendizagem SET titulo=?,descricao=?,nivel=?,departamento_id=?,carga_horaria=?,status=? WHERE id=?`,
      [titulo, descricao || null, nivel || 'iniciante', departamento_id || null, carga_horaria || null, status || 'ativa', req.params.id]
    );
    res.json(await get(`SELECT * FROM trilhas_aprendizagem WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar trilha' }); }
});

router.delete('/trilhas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM trilhas_aprendizagem WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM trilhas_aprendizagem WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir trilha' }); }
});

// ── VÍDEOS ───────────────────────────────────────────────────────────────────
router.get('/videos', autenticar, async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM treinamento_videos WHERE empresa_id=? ORDER BY created_at DESC`, [req.usuario.empresa_id]);
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar vídeos' }); }
});

router.post('/videos', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, url, duracao, categoria, tags } = req.body;
    if (!titulo || !url) return res.status(400).json({ erro: 'Título e URL são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO treinamento_videos (id,empresa_id,titulo,descricao,url,duracao,categoria,tags,criado_por) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, url, duracao || null, categoria || 'geral', tags || null, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar vídeo' }); }
});

router.put('/videos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, url, duracao, categoria, tags } = req.body;
    await run(
      `UPDATE treinamento_videos SET titulo=?,descricao=?,url=?,duracao=?,categoria=?,tags=? WHERE id=?`,
      [titulo, descricao || null, url, duracao || null, categoria || 'geral', tags || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar vídeo' }); }
});

router.delete('/videos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM treinamento_videos WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir vídeo' }); }
});

// ── CURSOS EXTERNOS ──────────────────────────────────────────────────────────
router.get('/cursos-externos', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.*, u.nome AS colaborador_nome FROM cursos_externos c
       LEFT JOIN usuarios u ON u.id = c.colaborador_id
       WHERE c.empresa_id=? ORDER BY c.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar cursos' }); }
});

router.post('/cursos-externos', autenticar, async (req, res) => {
  try {
    const { colaborador_id, titulo, instituicao, carga_horaria, data_inicio, data_conclusao, certificado, status, valor, observacoes } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO cursos_externos (id,empresa_id,colaborador_id,titulo,instituicao,carga_horaria,data_inicio,data_conclusao,certificado,status,valor,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, colaborador_id || null, titulo, instituicao || null, carga_horaria || null, data_inicio || null, data_conclusao || null, certificado ? 1 : 0, status || 'em_andamento', valor || null, observacoes || null]
    );
    res.status(201).json(await get(`SELECT * FROM cursos_externos WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar curso' }); }
});

router.put('/cursos-externos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cursos_externos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { colaborador_id, titulo, instituicao, carga_horaria, data_inicio, data_conclusao, certificado, status, valor, observacoes } = req.body;
    await run(
      `UPDATE cursos_externos SET colaborador_id=?,titulo=?,instituicao=?,carga_horaria=?,data_inicio=?,data_conclusao=?,certificado=?,status=?,valor=?,observacoes=? WHERE id=?`,
      [colaborador_id || null, titulo, instituicao || null, carga_horaria || null, data_inicio || null, data_conclusao || null, certificado ? 1 : 0, status || 'em_andamento', valor || null, observacoes || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM cursos_externos WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar curso' }); }
});

router.delete('/cursos-externos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cursos_externos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM cursos_externos WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir curso' }); }
});

module.exports = router;
