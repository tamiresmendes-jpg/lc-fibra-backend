const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const setores = await all(`
      SELECT s.*, d.nome as departamento_nome, u.nome as responsavel_nome,
             (SELECT COUNT(*) FROM usuarios WHERE setor_id = s.id AND ativo = 1 AND COALESCE(tipo_usuario,'colaborador')='colaborador') as total_membros
      FROM setores s
      LEFT JOIN departamentos d ON d.id = s.departamento_id
      LEFT JOIN usuarios u ON u.id = s.responsavel_id
      WHERE s.empresa_id = $1
      ORDER BY d.nome, s.nome
    `, [req.usuario.empresa_id]);
    res.json(setores);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, departamento_id, responsavel_id } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(`
      INSERT INTO setores (id, empresa_id, departamento_id, nome, descricao, responsavel_id)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, req.usuario.empresa_id, departamento_id || null, nome, descricao || null, responsavel_id || null]);
    res.status(201).json({ id, nome });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, departamento_id, responsavel_id } = req.body;
    await run(`
      UPDATE setores SET nome=$1, descricao=$2, departamento_id=$3, responsavel_id=$4
      WHERE id=$5 AND empresa_id=$6
    `, [nome, descricao || null, departamento_id || null, responsavel_id || null, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Setor atualizado' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM setores WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Setor excluído' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro interno' });
  }
});

module.exports = router;
