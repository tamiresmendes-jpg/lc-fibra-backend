const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT i.*, d.nome as departamento_nome,
             (SELECT valor FROM indicadores_historico WHERE indicador_id=i.id ORDER BY data_registro DESC LIMIT 1) as ultimo_valor,
             (SELECT data_registro FROM indicadores_historico WHERE indicador_id=i.id ORDER BY data_registro DESC LIMIT 1) as ultima_data
      FROM indicadores i
      LEFT JOIN departamentos d ON d.id = i.departamento_id
      WHERE i.empresa_id = $1
      ORDER BY i.nome
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, unidade, meta, frequencia, departamento_id } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO indicadores (id, empresa_id, nome, descricao, unidade, meta, frequencia, departamento_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [id, req.usuario.empresa_id, nome, descricao||null, unidade||null, meta||null, frequencia||'mensal', departamento_id||null]);
    res.status(201).json({ id, nome });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

// Registrar valor
router.post('/:id/registrar', async (req, res) => {
  try {
    const { valor, data_registro, observacao } = req.body;
    if (valor === undefined) return res.status(400).json({ erro: 'Valor obrigatório' });
    const ind = await get('SELECT id FROM indicadores WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!ind) return res.status(404).json({ erro: 'Indicador não encontrado' });
    const hId = uuidv4();
    await run('INSERT INTO indicadores_historico (id, indicador_id, valor, data_registro, observacao) VALUES ($1, $2, $3, $4, $5)', [hId, req.params.id, valor, data_registro || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0], observacao||null]);
    await run('UPDATE indicadores SET valor_atual=$1 WHERE id=$2 AND empresa_id=$3', [valor, req.params.id, req.usuario.empresa_id]);
    res.status(201).json({ mensagem: 'Valor registrado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.get('/:id/historico', async (req, res) => {
  try {
    const ind = await get('SELECT id FROM indicadores WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!ind) return res.status(404).json({ erro: 'Indicador não encontrado' });
    const historico = await all('SELECT * FROM indicadores_historico WHERE indicador_id=$1 ORDER BY data_registro ASC', [req.params.id]);
    res.json(historico);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, unidade, meta, frequencia, departamento_id, status } = req.body;
    await run('UPDATE indicadores SET nome=$1, descricao=$2, unidade=$3, meta=$4, frequencia=$5, departamento_id=$6, status=$7 WHERE id=$8 AND empresa_id=$9', [nome, descricao||null, unidade||null, meta||null, frequencia||'mensal', departamento_id||null, status||'ativo', req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const ind = await get('SELECT id FROM indicadores WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!ind) return res.status(404).json({ erro: 'Não encontrado' });
    await run('DELETE FROM indicadores_historico WHERE indicador_id=$1', [req.params.id]);
    await run('DELETE FROM indicadores WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
