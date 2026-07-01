const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

// Garantir colunas novas (idempotente)
;(async () => {
  try {
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS objetivo TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS resultado_esperado TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS pops_relacionados TEXT`);
  } catch {}
})();

router.get('/', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM processos WHERE empresa_id=$1 AND excluido_em IS NULL ORDER BY created_at DESC', [eid(req)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO processos (id,empresa_id,titulo,objetivo,descricao,setor,responsavel,status,resultado_esperado,pops_relacionados)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, eid(req), titulo, objetivo||null, descricao||null, setor||null, responsavel||null, status||'ativo',
       resultado_esperado||null, pops_relacionados||null]
    );
    res.status(201).json({ id, titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados } = req.body;
    await run(
      `UPDATE processos SET titulo=$1,objetivo=$2,descricao=$3,setor=$4,responsavel=$5,status=$6,
       resultado_esperado=$7,pops_relacionados=$8 WHERE id=$9 AND empresa_id=$10`,
      [titulo, objetivo||null, descricao||null, setor||null, responsavel||null, status||'ativo',
       resultado_esperado||null, pops_relacionados||null, req.params.id, eid(req)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await get('SELECT titulo FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!item) return res.status(404).json({ erro: 'Não encontrado' });
    await run(
      'UPDATE processos SET excluido_em=NOW(), excluido_por=$1, excluido_por_nome=$2 WHERE id=$3 AND empresa_id=$4',
      [req.usuario.id, req.usuario.nome, req.params.id, eid(req)]
    );
    res.json({ ok: true, titulo: item.titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
