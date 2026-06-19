const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

// ── APROVAÇÕES ───────────────────────────────────────────────────────────────
router.get('/aprovacoes', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT p.id, p.titulo, p.codigo, p.versao, p.status, p.departamento_id,
              p.elaborado_por, p.criado_por, p.created_at,
              u.nome AS criado_por_nome, d.nome AS departamento_nome
       FROM pops p
       LEFT JOIN usuarios u ON u.id = p.criado_por
       LEFT JOIN departamentos d ON d.id = p.departamento_id
       WHERE p.empresa_id = ? AND p.excluido_em IS NULL
         AND p.status IN ('aguardando_aprovacao','em_revisao')
       ORDER BY p.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar aprovações' });
  }
});

router.patch('/aprovacoes/:id/aprovar', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM pops WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'POP não encontrado' });
    await run(`UPDATE pops SET status='ativo', aprovado_por=? WHERE id=?`, [req.usuario.id, req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao aprovar' }); }
});

router.patch('/aprovacoes/:id/rejeitar', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM pops WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'POP não encontrado' });
    const { motivo } = req.body;
    await run(`UPDATE pops SET status='rascunho' WHERE id=?`, [req.params.id]);
    if (motivo) {
      const { v4: uuidv4 } = require('uuid');
      await run(
        `INSERT INTO pop_comentarios (id,pop_id,empresa_id,usuario_id,texto,tipo) VALUES (?,?,?,?,?,'rejeicao')`,
        [uuidv4(), req.params.id, req.usuario.empresa_id, req.usuario.id, motivo]
      );
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao rejeitar' }); }
});

// ── CONTROLE DE VERSÕES ──────────────────────────────────────────────────────
router.get('/versoes', autenticar, async (req, res) => {
  try {
    const { pop_id } = req.query;
    let sql = `
      SELECT h.*, p.titulo AS pop_titulo, p.codigo AS pop_codigo,
             u.nome AS usuario_nome
      FROM pop_historico h
      JOIN pops p ON p.id = h.pop_id
      LEFT JOIN usuarios u ON u.id = h.usuario_id
      WHERE p.empresa_id = ?
    `;
    const params = [req.usuario.empresa_id];
    if (pop_id) { sql += ` AND h.pop_id = ?`; params.push(pop_id); }
    sql += ` ORDER BY h.created_at DESC LIMIT 200`;
    res.json(await all(sql, params));
  } catch { res.status(500).json({ erro: 'Erro ao buscar versões' }); }
});

// ── HISTÓRICO DE ALTERAÇÕES ──────────────────────────────────────────────────
router.get('/historico-pops', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT h.*, p.titulo AS pop_titulo, p.codigo AS pop_codigo, u.nome AS usuario_nome
       FROM pop_historico h
       JOIN pops p ON p.id = h.pop_id
       LEFT JOIN usuarios u ON u.id = h.usuario_id
       WHERE p.empresa_id = ?
       ORDER BY h.created_at DESC LIMIT 300`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar histórico' }); }
});

module.exports = router;
