const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM beneficios WHERE empresa_id=$1 AND ativo=1 ORDER BY ordem ASC, created_at ASC`,
      [eid(req)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { nome, descricao, icone, imagem, ordem } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO beneficios (id, empresa_id, nome, descricao, icone, imagem, ordem)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, eid(req), nome, descricao || '', icone || '', imagem || '', ordem || 0]
    );
    res.status(201).json(await get('SELECT * FROM beneficios WHERE id=$1', [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { nome, descricao, icone, imagem, ordem } = req.body;
    await run(
      `UPDATE beneficios SET nome=$1, descricao=$2, icone=$3, imagem=$4, ordem=$5,
       updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
       WHERE id=$6 AND empresa_id=$7`,
      [nome, descricao || '', icone || '', imagem || '', ordem || 0, req.params.id, eid(req)]
    );
    res.json(await get('SELECT * FROM beneficios WHERE id=$1', [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('UPDATE beneficios SET ativo=0 WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
