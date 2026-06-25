const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function uid(req) { return req.usuario.id; }
function eid(req) { return req.usuario.empresa_id; }

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM anotacoes WHERE empresa_id=$1 AND usuario_id=$2 ORDER BY fixada DESC, updated_at DESC`,
      [eid(req), uid(req)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, conteudo, cor } = req.body;
    if (!titulo?.trim()) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO anotacoes (id, empresa_id, usuario_id, titulo, conteudo, cor) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, eid(req), uid(req), titulo, conteudo || '', cor || '#fef9c3']
    );
    res.status(201).json(await get('SELECT * FROM anotacoes WHERE id=$1', [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, conteudo, cor, fixada } = req.body;
    await run(
      `UPDATE anotacoes SET titulo=$1, conteudo=$2, cor=$3, fixada=$4,
       updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id=$5 AND empresa_id=$6 AND usuario_id=$7`,
      [titulo, conteudo || '', cor || '#fef9c3', fixada ? 1 : 0, req.params.id, eid(req), uid(req)]
    );
    res.json(await get('SELECT * FROM anotacoes WHERE id=$1', [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM anotacoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3',
      [req.params.id, eid(req), uid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
