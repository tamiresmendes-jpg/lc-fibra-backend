const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(autenticar);

// Resumo de curtidas + comentários de um item
router.get('/:tipo/:refId', async (req, res) => {
  try {
    const { tipo, refId } = req.params;
    const eid = req.usuario.empresa_id;

    const curtidas = await get(
      `SELECT COUNT(*) as total FROM interacao_curtidas WHERE empresa_id=? AND tipo=? AND ref_id=?`,
      [eid, tipo, refId]
    );
    const minha = await get(
      `SELECT id FROM interacao_curtidas WHERE empresa_id=? AND tipo=? AND ref_id=? AND usuario_id=?`,
      [eid, tipo, refId, req.usuario.id]
    );
    const comentarios = await all(
      `SELECT c.id, c.texto, c.usuario_id, c.created_at, u.nome as usuario_nome, u.avatar
       FROM interacao_comentarios c LEFT JOIN usuarios u ON u.id = c.usuario_id
       WHERE c.empresa_id=? AND c.tipo=? AND c.ref_id=?
       ORDER BY c.created_at ASC`,
      [eid, tipo, refId]
    );

    res.json({
      total_curtidas: curtidas?.total || 0,
      eu_curti: !!minha,
      total_comentarios: comentarios.length,
      comentarios: comentarios.map(c => ({ ...c, meu: c.usuario_id === req.usuario.id })),
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Curtir / descurtir (toggle)
router.post('/:tipo/:refId/curtir', async (req, res) => {
  try {
    const { tipo, refId } = req.params;
    const eid = req.usuario.empresa_id;
    const existente = await get(
      `SELECT id FROM interacao_curtidas WHERE empresa_id=? AND tipo=? AND ref_id=? AND usuario_id=?`,
      [eid, tipo, refId, req.usuario.id]
    );
    if (existente) {
      await run(`DELETE FROM interacao_curtidas WHERE id=?`, [existente.id]);
    } else {
      await run(
        `INSERT INTO interacao_curtidas (id, empresa_id, tipo, ref_id, usuario_id) VALUES (?,?,?,?,?)`,
        [uuidv4(), eid, tipo, refId, req.usuario.id]
      );
    }
    const curtidas = await get(
      `SELECT COUNT(*) as total FROM interacao_curtidas WHERE empresa_id=? AND tipo=? AND ref_id=?`,
      [eid, tipo, refId]
    );
    res.json({ curtido: !existente, total: curtidas?.total || 0 });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Comentar
router.post('/:tipo/:refId/comentar', async (req, res) => {
  try {
    const { tipo, refId } = req.params;
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Comentário vazio' });
    const id = uuidv4();
    await run(
      `INSERT INTO interacao_comentarios (id, empresa_id, tipo, ref_id, usuario_id, texto) VALUES (?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, tipo, refId, req.usuario.id, texto.trim()]
    );
    res.status(201).json(await get(`SELECT * FROM interacao_comentarios WHERE id=?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir comentário (autor ou admin/gestor)
router.delete('/comentarios/:id', async (req, res) => {
  try {
    const c = await get(`SELECT * FROM interacao_comentarios WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!c) return res.status(404).json({ erro: 'Não encontrado' });
    const podeApagar = c.usuario_id === req.usuario.id || ['admin', 'gestor'].includes(req.usuario.perfil);
    if (!podeApagar) return res.status(403).json({ erro: 'Sem permissão' });
    await run(`DELETE FROM interacao_comentarios WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
