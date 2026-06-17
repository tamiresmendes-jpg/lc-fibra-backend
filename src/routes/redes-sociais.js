const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// GET / — lista redes ativas da empresa
router.get('/', autenticar, async (req, res) => {
  try {
    const redes = await all(
      `SELECT * FROM redes_sociais WHERE empresa_id = ? AND ativo = 1 ORDER BY plataforma, nome`,
      [req.usuario.empresa_id]
    );
    res.json(redes);
  } catch (err) {
    console.error('[redes-sociais GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar redes sociais' });
  }
});

// POST / — cria nova rede social
router.post('/', autenticar, async (req, res) => {
  try {
    const { plataforma, nome, url, descricao } = req.body;
    if (!plataforma) {
      return res.status(400).json({ erro: 'Plataforma é obrigatória' });
    }
    const id = uuidv4();
    await run(
      `INSERT INTO redes_sociais (id, empresa_id, plataforma, nome, url, descricao) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, plataforma, nome || null, url || null, descricao || null]
    );
    const nova = await get(`SELECT * FROM redes_sociais WHERE id = ?`, [id]);
    res.status(201).json(nova);
  } catch (err) {
    console.error('[redes-sociais POST]', err.message);
    res.status(500).json({ erro: 'Erro ao criar rede social' });
  }
});

// PUT /:id — atualiza rede social
router.put('/:id', autenticar, async (req, res) => {
  try {
    const { plataforma, nome, url, descricao } = req.body;
    const existente = await get(
      `SELECT id FROM redes_sociais WHERE id = ? AND empresa_id = ?`,
      [req.params.id, req.usuario.empresa_id]
    );
    if (!existente) {
      return res.status(404).json({ erro: 'Rede social não encontrada' });
    }
    await run(
      `UPDATE redes_sociais SET plataforma = ?, nome = ?, url = ?, descricao = ? WHERE id = ?`,
      [plataforma, nome || null, url || null, descricao || null, req.params.id]
    );
    const atualizada = await get(`SELECT * FROM redes_sociais WHERE id = ?`, [req.params.id]);
    res.json(atualizada);
  } catch (err) {
    console.error('[redes-sociais PUT]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar rede social' });
  }
});

// DELETE /:id — soft delete
router.delete('/:id', autenticar, async (req, res) => {
  try {
    const existente = await get(
      `SELECT id FROM redes_sociais WHERE id = ? AND empresa_id = ?`,
      [req.params.id, req.usuario.empresa_id]
    );
    if (!existente) {
      return res.status(404).json({ erro: 'Rede social não encontrada' });
    }
    await run(
      `UPDATE redes_sociais SET ativo = 0 WHERE id = ?`,
      [req.params.id]
    );
    res.json({ mensagem: 'Rede social removida com sucesso' });
  } catch (err) {
    console.error('[redes-sociais DELETE]', err.message);
    res.status(500).json({ erro: 'Erro ao remover rede social' });
  }
});

module.exports = router;
