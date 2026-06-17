const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// GET / — lista feriados ativos da empresa com data_exibicao calculada
router.get('/', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM feriados WHERE empresa_id = ? AND ativo = 1`,
      [req.usuario.empresa_id]
    );

    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    rows.forEach(f => {
      if (f.recorrente) {
        const [_ano, mes, dia] = f.data.split('-');
        let dataEsteAno = new Date(`${anoAtual}-${mes}-${dia}`);
        if (dataEsteAno < hoje) dataEsteAno = new Date(`${anoAtual + 1}-${mes}-${dia}`);
        f.data_exibicao = dataEsteAno.toISOString().slice(0, 10);
      } else {
        f.data_exibicao = f.data;
      }
    });
    rows.sort((a, b) => a.data_exibicao.localeCompare(b.data_exibicao));

    res.json(rows);
  } catch (err) {
    console.error('[feriados GET]', err.message);
    res.status(500).json({ erro: 'Erro ao buscar feriados' });
  }
});

// POST / — cria feriado
router.post('/', autenticar, async (req, res) => {
  try {
    const { nome, data, tipo, recorrente, observacao } = req.body;
    if (!nome || !data) {
      return res.status(400).json({ erro: 'Nome e data são obrigatórios' });
    }
    const id = uuidv4();
    await run(
      `INSERT INTO feriados (id, empresa_id, nome, data, tipo, recorrente, observacao) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.usuario.empresa_id,
        nome,
        data,
        tipo || 'nacional',
        recorrente !== undefined ? (recorrente ? 1 : 0) : 1,
        observacao || null,
      ]
    );
    const novo = await get(`SELECT * FROM feriados WHERE id = ?`, [id]);
    res.status(201).json(novo);
  } catch (err) {
    console.error('[feriados POST]', err.message);
    res.status(500).json({ erro: 'Erro ao criar feriado' });
  }
});

// PUT /:id — atualiza feriado
router.put('/:id', autenticar, async (req, res) => {
  try {
    const existente = await get(
      `SELECT id FROM feriados WHERE id = ? AND empresa_id = ?`,
      [req.params.id, req.usuario.empresa_id]
    );
    if (!existente) {
      return res.status(404).json({ erro: 'Feriado não encontrado' });
    }
    const { nome, data, tipo, recorrente, observacao } = req.body;
    await run(
      `UPDATE feriados SET nome = ?, data = ?, tipo = ?, recorrente = ?, observacao = ? WHERE id = ?`,
      [
        nome,
        data,
        tipo || 'nacional',
        recorrente !== undefined ? (recorrente ? 1 : 0) : 1,
        observacao || null,
        req.params.id,
      ]
    );
    const atualizado = await get(`SELECT * FROM feriados WHERE id = ?`, [req.params.id]);
    res.json(atualizado);
  } catch (err) {
    console.error('[feriados PUT]', err.message);
    res.status(500).json({ erro: 'Erro ao atualizar feriado' });
  }
});

// DELETE /:id — soft delete
router.delete('/:id', autenticar, async (req, res) => {
  try {
    const existente = await get(
      `SELECT id FROM feriados WHERE id = ? AND empresa_id = ?`,
      [req.params.id, req.usuario.empresa_id]
    );
    if (!existente) {
      return res.status(404).json({ erro: 'Feriado não encontrado' });
    }
    await run(`UPDATE feriados SET ativo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ mensagem: 'Feriado removido com sucesso' });
  } catch (err) {
    console.error('[feriados DELETE]', err.message);
    res.status(500).json({ erro: 'Erro ao remover feriado' });
  }
});

module.exports = router;
