const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const router = express.Router();
router.use(autenticar);
function eid(req) { return req.usuario.empresa_id; }

;(async () => { try { await run(`ALTER TABLE checklists ADD COLUMN IF NOT EXISTS categoria_id TEXT`); } catch (_) {} })();

router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM checklists WHERE empresa_id=$1 ORDER BY created_at DESC', [eid(req)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, descricao, setor, itens, categoria_id } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      'INSERT INTO checklists (id,empresa_id,titulo,descricao,setor,itens,categoria_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, eid(req), titulo, descricao||null, setor||null, itens||null, categoria_id||null]
    );
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, descricao, setor, itens, categoria_id } = req.body;
    await run(
      'UPDATE checklists SET titulo=$1,descricao=$2,setor=$3,itens=$4,categoria_id=$5 WHERE id=$6 AND empresa_id=$7',
      [titulo, descricao||null, setor||null, itens||null, categoria_id||null, req.params.id, eid(req)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM checklists WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
