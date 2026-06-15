const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// 1:1
router.get('/1a1', async (req, res) => {
  try {
    const itens = await all(`
      SELECT r.*, ul.nome as lider_nome, ld.nome as liderado_nome
      FROM reunioes_1_1 r
      JOIN usuarios ul ON ul.id = r.lider_id
      JOIN usuarios ld ON ld.id = r.liderado_id
      WHERE r.empresa_id = $1 AND (r.lider_id = $2 OR r.liderado_id = $3)
      ORDER BY r.data_reuniao DESC
    `, [req.usuario.empresa_id, req.usuario.id, req.usuario.id]);
    res.json(itens);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/1a1', async (req, res) => {
  try {
    const { liderado_id, data_reuniao, pauta } = req.body;
    if (!liderado_id) return res.status(400).json({ erro: 'Liderado obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO reunioes_1_1 (id, empresa_id, lider_id, liderado_id, data_reuniao, pauta) VALUES ($1, $2, $3, $4, $5, $6)', [id, req.usuario.empresa_id, req.usuario.id, liderado_id, data_reuniao||null, pauta||null]);
    res.status(201).json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/1a1/:id', async (req, res) => {
  try {
    const { data_reuniao, pauta, anotacoes, proximos_passos, status } = req.body;
    await run('UPDATE reunioes_1_1 SET data_reuniao=$1, pauta=$2, anotacoes=$3, proximos_passos=$4, status=$5 WHERE id=$6 AND empresa_id=$7', [data_reuniao||null, pauta||null, anotacoes||null, proximos_passos||null, status||'agendada', req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Reuniões gerais
router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT r.*, u.nome as criado_por_nome
      FROM reunioes r LEFT JOIN usuarios u ON u.id = r.criado_por
      WHERE r.empresa_id = $1
      ORDER BY r.data_reuniao DESC
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, tipo, data_reuniao, local, pauta } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO reunioes (id, empresa_id, titulo, tipo, data_reuniao, local, pauta, criado_por) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, req.usuario.empresa_id, titulo, tipo||'geral', data_reuniao||null, local||null, pauta||null, req.usuario.id]);
    res.status(201).json({ id, titulo });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { titulo, tipo, data_reuniao, local, pauta, ata, status } = req.body;
    await run('UPDATE reunioes SET titulo=$1, tipo=$2, data_reuniao=$3, local=$4, pauta=$5, ata=$6, status=$7 WHERE id=$8 AND empresa_id=$9', [titulo, tipo||'geral', data_reuniao||null, local||null, pauta||null, ata||null, status||'agendada', req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM reunioes WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
