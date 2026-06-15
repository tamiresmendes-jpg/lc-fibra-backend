const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const { status, responsavel_id } = req.query;
    let sql = `
      SELECT a.*, u.nome as responsavel_nome
      FROM acoes a LEFT JOIN usuarios u ON u.id = a.responsavel_id
      WHERE a.empresa_id = $1
    `;
    const params = [req.usuario.empresa_id];
    if (status) { sql += ` AND a.status = $${params.length + 1}`; params.push(status); }
    if (responsavel_id) { sql += ` AND a.responsavel_id = $${params.length + 1}`; params.push(responsavel_id); }
    sql += ' ORDER BY a.created_at DESC';
    res.json(await all(sql, params));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, what, why, where_field, when_field, who, how, how_much, responsavel_id, prioridade, data_prazo } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(`
      INSERT INTO acoes (id, empresa_id, titulo, what, why, where_field, when_field, who, how, how_much, responsavel_id, prioridade, data_prazo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, [id, req.usuario.empresa_id, titulo, what||null, why||null, where_field||null, when_field||null, who||null, how||null, how_much||null, responsavel_id||null, prioridade||'media', data_prazo||null]);
    res.status(201).json({ id, titulo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, what, why, where_field, when_field, who, how, how_much, responsavel_id, prioridade, status, data_prazo, data_conclusao } = req.body;
    await run(`
      UPDATE acoes SET titulo=$1, what=$2, why=$3, where_field=$4, when_field=$5, who=$6, how=$7, how_much=$8, responsavel_id=$9, prioridade=$10, status=$11, data_prazo=$12, data_conclusao=$13
      WHERE id=$14 AND empresa_id=$15
    `, [titulo, what||null, why||null, where_field||null, when_field||null, who||null, how||null, how_much||null, responsavel_id||null, prioridade||'media', status||'aberta', data_prazo||null, data_conclusao||null, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM acoes WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
