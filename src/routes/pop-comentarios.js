const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

async function comReacoes(rows, uid) {
  return Promise.all(rows.map(async c => {
    const reacoes = await all(`
      SELECT tipo, COUNT(*) as total FROM pop_comentario_reacoes
      WHERE comentario_id = ? GROUP BY tipo
    `, [c.id]);
    const minha = await get(`
      SELECT tipo FROM pop_comentario_reacoes WHERE comentario_id = ? AND usuario_id = ?
    `, [c.id, uid]);
    return {
      ...c,
      likes:    reacoes.find(r => r.tipo === 'like')?.total    || 0,
      dislikes: reacoes.find(r => r.tipo === 'dislike')?.total || 0,
      minha_reacao: minha?.tipo || null,
    };
  }));
}

// GET /pop-comentarios/:popId
router.get('/:popId', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const rows = await all(`
      SELECT c.*, u.nome as autor_nome, u.avatar as autor_avatar
      FROM pop_comentarios c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.pop_id = ? AND c.empresa_id = ?
      ORDER BY c.created_at ASC
    `, [req.params.popId, eid]);
    res.json(await comReacoes(rows, req.usuario.id));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// POST /pop-comentarios
router.post('/', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const uid = req.usuario.id;
    const { pop_id, texto, tipo, trecho } = req.body;
    if (!pop_id || !texto?.trim()) return res.status(400).json({ erro: 'pop_id e texto são obrigatórios' });

    const pop = await get('SELECT id FROM pops WHERE id = ? AND empresa_id = ?', [pop_id, eid]);
    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });

    const id = uuidv4();
    await run(`
      INSERT INTO pop_comentarios (id, pop_id, empresa_id, usuario_id, texto, tipo, trecho)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, pop_id, eid, uid, texto.trim(), tipo || 'comentario', trecho || null]);

    const row = await get(`
      SELECT c.*, u.nome as autor_nome, u.avatar as autor_avatar
      FROM pop_comentarios c
      LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.id = ?
    `, [id]);
    res.status(201).json({ ...row, likes: 0, dislikes: 0, minha_reacao: null });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// POST /pop-comentarios/:id/reagir  { tipo: 'like'|'dislike' }
router.post('/:id/reagir', async (req, res) => {
  try {
    const uid = req.usuario.id;
    const cid = req.params.id;
    const { tipo } = req.body; // 'like' ou 'dislike'
    if (!['like', 'dislike'].includes(tipo)) return res.status(400).json({ erro: 'Tipo inválido' });

    const coment = await get('SELECT id FROM pop_comentarios WHERE id = ? AND empresa_id = ?', [cid, req.usuario.empresa_id]);
    if (!coment) return res.status(404).json({ erro: 'Comentário não encontrado' });

    const existente = await get(
      'SELECT tipo FROM pop_comentario_reacoes WHERE comentario_id = ? AND usuario_id = ?',
      [cid, uid]
    );

    if (existente) {
      if (existente.tipo === tipo) {
        // mesmo tipo → remove (toggle off)
        await run('DELETE FROM pop_comentario_reacoes WHERE comentario_id = ? AND usuario_id = ?', [cid, uid]);
      } else {
        // tipo diferente → troca
        await run('UPDATE pop_comentario_reacoes SET tipo = ? WHERE comentario_id = ? AND usuario_id = ?', [tipo, cid, uid]);
      }
    } else {
      await run('INSERT INTO pop_comentario_reacoes (id, comentario_id, usuario_id, tipo) VALUES (?,?,?,?)', [uuidv4(), cid, uid, tipo]);
    }

    const reacoes = await all('SELECT tipo, COUNT(*) as total FROM pop_comentario_reacoes WHERE comentario_id = ? GROUP BY tipo', [cid]);
    const minha   = await get('SELECT tipo FROM pop_comentario_reacoes WHERE comentario_id = ? AND usuario_id = ?', [cid, uid]);
    res.json({
      likes:    reacoes.find(r => r.tipo === 'like')?.total    || 0,
      dislikes: reacoes.find(r => r.tipo === 'dislike')?.total || 0,
      minha_reacao: minha?.tipo || null,
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// PATCH /pop-comentarios/:id/resolver
router.patch('/:id/resolver', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    await run(`UPDATE pop_comentarios SET resolvido = 1 WHERE id = ? AND empresa_id = ?`, [req.params.id, eid]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /pop-comentarios/:id
router.delete('/:id', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    await run(`DELETE FROM pop_comentarios WHERE id = ? AND empresa_id = ? AND usuario_id = ?`, [req.params.id, eid, req.usuario.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
