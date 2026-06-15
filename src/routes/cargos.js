const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const itens = await all(`
    SELECT c.*, d.nome as departamento_nome
    FROM cargos c
    LEFT JOIN departamentos d ON d.id = c.departamento_id
    WHERE c.empresa_id = ?
    ORDER BY c.nivel, c.nome
  `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const { nome, departamento_id, nivel } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO cargos (id, empresa_id, nome, departamento_id, nivel) VALUES (?, ?, ?, ?, ?)', [id, req.usuario.empresa_id, nome, departamento_id || null, nivel || 1]);
    res.status(201).json({ id, nome });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { nome, departamento_id, nivel } = req.body;
    await run('UPDATE cargos SET nome=?, departamento_id=?, nivel=? WHERE id=? AND empresa_id=?', [nome, departamento_id || null, nivel || 1, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM cargos WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
