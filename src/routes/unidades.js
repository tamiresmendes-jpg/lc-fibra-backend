const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// GET / — lista unidades da empresa, matriz primeiro depois por nome
router.get('/', async (req, res) => {
  try {
    const unidades = await all(`
      SELECT * FROM unidades
      WHERE empresa_id = $1 AND ativo = 1
      ORDER BY CASE WHEN tipo = 'matriz' THEN 0 ELSE 1 END, nome
    `, [req.usuario.empresa_id]);
    res.json(unidades);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// POST / — cria nova unidade
router.post('/', async (req, res) => {
  try {
    const { nome, tipo, cep, logradouro, numero, complemento, bairro, cidade, estado, telefone, responsavel } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(`
      INSERT INTO unidades (id, empresa_id, nome, tipo, cep, logradouro, numero, complemento, bairro, cidade, estado, telefone, responsavel)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [
      id,
      req.usuario.empresa_id,
      nome,
      tipo || 'filial',
      cep || null,
      logradouro || null,
      numero || null,
      complemento || null,
      bairro || null,
      cidade || null,
      estado || 'PA',
      telefone || null,
      responsavel || null,
    ]);
    res.status(201).json({ id, nome });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// PUT /:id — atualiza unidade
router.put('/:id', async (req, res) => {
  try {
    const { nome, tipo, cep, logradouro, numero, complemento, bairro, cidade, estado, telefone, responsavel } = req.body;
    await run(`
      UPDATE unidades
      SET nome=$1, tipo=$2, cep=$3, logradouro=$4, numero=$5, complemento=$6,
          bairro=$7, cidade=$8, estado=$9, telefone=$10, responsavel=$11
      WHERE id=$12 AND empresa_id=$13
    `, [
      nome,
      tipo || 'filial',
      cep || null,
      logradouro || null,
      numero || null,
      complemento || null,
      bairro || null,
      cidade || null,
      estado || 'PA',
      telefone || null,
      responsavel || null,
      req.params.id,
      req.usuario.empresa_id,
    ]);
    res.json({ mensagem: 'Unidade atualizada' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// DELETE /:id — soft delete
router.delete('/:id', async (req, res) => {
  try {
    await run(`
      UPDATE unidades SET ativo = 0 WHERE id=$1 AND empresa_id=$2
    `, [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Unidade removida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
