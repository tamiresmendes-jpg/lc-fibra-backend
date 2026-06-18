const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── EVENTOS ─────────────────────────────────────────────────────────────────
router.get('/eventos', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT e.*, u.nome AS criado_por_nome FROM cultura_eventos e
       LEFT JOIN usuarios u ON u.id = e.criado_por
       WHERE e.empresa_id = ? ORDER BY e.data_inicio DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar eventos' }); }
});

router.post('/eventos', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, data_inicio, data_fim, local, tipo, publico } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO cultura_eventos (id,empresa_id,titulo,descricao,data_inicio,data_fim,local,tipo,publico,criado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, data_inicio || null, data_fim || null, local || null, tipo || 'evento', publico !== false ? 1 : 0, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM cultura_eventos WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar evento' }); }
});

router.put('/eventos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_eventos WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, data_inicio, data_fim, local, tipo, publico } = req.body;
    await run(
      `UPDATE cultura_eventos SET titulo=?,descricao=?,data_inicio=?,data_fim=?,local=?,tipo=?,publico=? WHERE id=?`,
      [titulo, descricao || null, data_inicio || null, data_fim || null, local || null, tipo || 'evento', publico !== false ? 1 : 0, req.params.id]
    );
    res.json(await get(`SELECT * FROM cultura_eventos WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar evento' }); }
});

router.delete('/eventos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_eventos WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM cultura_eventos WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir evento' }); }
});

// ── ENQUETES ─────────────────────────────────────────────────────────────────
router.get('/enquetes', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT e.*, u.nome AS criado_por_nome,
        (SELECT COUNT(*) FROM cultura_enquete_respostas r WHERE r.enquete_id = e.id) AS total_respostas
       FROM cultura_enquetes e
       LEFT JOIN usuarios u ON u.id = e.criado_por
       WHERE e.empresa_id = ? ORDER BY e.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows.map(r => ({ ...r, opcoes: r.opcoes ? JSON.parse(r.opcoes) : [] })));
  } catch { res.status(500).json({ erro: 'Erro ao buscar enquetes' }); }
});

router.post('/enquetes', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, opcoes, data_fim, anonima } = req.body;
    if (!titulo || !opcoes?.length) return res.status(400).json({ erro: 'Título e opções são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO cultura_enquetes (id,empresa_id,titulo,descricao,opcoes,data_fim,anonima,ativa,criado_por)
       VALUES (?,?,?,?,?,?,?,1,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, JSON.stringify(opcoes), data_fim || null, anonima ? 1 : 0, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM cultura_enquetes WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar enquete' }); }
});

router.patch('/enquetes/:id/ativa', autenticar, async (req, res) => {
  try {
    await run(`UPDATE cultura_enquetes SET ativa=? WHERE id=? AND empresa_id=?`, [req.body.ativa ? 1 : 0, req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao atualizar' }); }
});

router.delete('/enquetes/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_enquetes WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM cultura_enquete_respostas WHERE enquete_id = ?`, [req.params.id]);
    await run(`DELETE FROM cultura_enquetes WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir enquete' }); }
});

router.post('/enquetes/:id/votar', autenticar, async (req, res) => {
  try {
    const { opcao_index } = req.body;
    const enquete = await get(`SELECT * FROM cultura_enquetes WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!enquete) return res.status(404).json({ erro: 'Não encontrado' });
    if (!enquete.ativa) return res.status(400).json({ erro: 'Enquete encerrada' });
    const jaVotou = await get(`SELECT id FROM cultura_enquete_respostas WHERE enquete_id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    if (jaVotou) return res.status(400).json({ erro: 'Você já votou nesta enquete' });
    await run(
      `INSERT INTO cultura_enquete_respostas (id,enquete_id,usuario_id,opcao_index) VALUES (?,?,?,?)`,
      [uuidv4(), req.params.id, req.usuario.id, opcao_index]
    );
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao votar' }); }
});

router.get('/enquetes/:id/resultados', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT opcao_index, COUNT(*) AS votos FROM cultura_enquete_respostas WHERE enquete_id = ? GROUP BY opcao_index`,
      [req.params.id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar resultados' }); }
});

// ── MURAL DE AVISOS ──────────────────────────────────────────────────────────
router.get('/mural', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT m.*, u.nome AS autor_nome FROM cultura_mural m
       LEFT JOIN usuarios u ON u.id = m.criado_por
       WHERE m.empresa_id = ? ORDER BY m.fixado DESC, m.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar mural' }); }
});

router.post('/mural', autenticar, async (req, res) => {
  try {
    const { titulo, conteudo, tipo, fixado, data_expiracao } = req.body;
    if (!titulo || !conteudo) return res.status(400).json({ erro: 'Título e conteúdo obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO cultura_mural (id,empresa_id,titulo,conteudo,tipo,fixado,data_expiracao,criado_por)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, conteudo, tipo || 'aviso', fixado ? 1 : 0, data_expiracao || null, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM cultura_mural WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar aviso' }); }
});

router.put('/mural/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_mural WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, conteudo, tipo, fixado, data_expiracao } = req.body;
    await run(
      `UPDATE cultura_mural SET titulo=?,conteudo=?,tipo=?,fixado=?,data_expiracao=? WHERE id=?`,
      [titulo, conteudo, tipo || 'aviso', fixado ? 1 : 0, data_expiracao || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM cultura_mural WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar aviso' }); }
});

router.delete('/mural/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_mural WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM cultura_mural WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir aviso' }); }
});

// ── CAMPANHAS INTERNAS ───────────────────────────────────────────────────────
router.get('/campanhas-internas', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.*, u.nome AS criado_por_nome FROM cultura_campanhas_internas c
       LEFT JOIN usuarios u ON u.id = c.criado_por
       WHERE c.empresa_id = ? ORDER BY c.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar campanhas' }); }
});

router.post('/campanhas-internas', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, objetivo, data_inicio, data_fim, status } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO cultura_campanhas_internas (id,empresa_id,titulo,descricao,objetivo,data_inicio,data_fim,status,criado_por)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, objetivo || null, data_inicio || null, data_fim || null, status || 'planejada', req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM cultura_campanhas_internas WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar campanha' }); }
});

router.put('/campanhas-internas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_campanhas_internas WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, objetivo, data_inicio, data_fim, status } = req.body;
    await run(
      `UPDATE cultura_campanhas_internas SET titulo=?,descricao=?,objetivo=?,data_inicio=?,data_fim=?,status=? WHERE id=?`,
      [titulo, descricao || null, objetivo || null, data_inicio || null, data_fim || null, status || 'planejada', req.params.id]
    );
    res.json(await get(`SELECT * FROM cultura_campanhas_internas WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar campanha' }); }
});

router.delete('/campanhas-internas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cultura_campanhas_internas WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM cultura_campanhas_internas WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir campanha' }); }
});

module.exports = router;
