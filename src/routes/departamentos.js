const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const itens = await all(`
    SELECT d.*, COUNT(u.id) as total_colaboradores
    FROM departamentos d
    LEFT JOIN usuarios u ON u.departamento_id = d.id AND u.ativo = 1 AND COALESCE(u.tipo_usuario,'colaborador')='colaborador'
    WHERE d.empresa_id = ? AND d.excluido_em IS NULL
    GROUP BY d.id ORDER BY d.nome
  `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, sigla } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    const siglaGerada = sigla || nome.substring(0, 3).toUpperCase();
    await run('INSERT INTO departamentos (id, empresa_id, nome, descricao, sigla) VALUES (?, ?, ?, ?, ?)', [id, req.usuario.empresa_id, nome, descricao || null, siglaGerada]);
    res.status(201).json({ id, nome, descricao, sigla: siglaGerada });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, sigla } = req.body;
    await run('UPDATE departamentos SET nome=?, descricao=?, sigla=? WHERE id=? AND empresa_id=?', [nome, descricao || null, sigla || null, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Atualizado' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const item = await get('SELECT nome FROM departamentos WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    if (!item) return res.status(404).json({ erro: 'Não encontrado' });
    await run(
      'UPDATE departamentos SET excluido_em=NOW(), excluido_por=?, excluido_por_nome=? WHERE id=? AND empresa_id=?',
      [req.usuario.id, req.usuario.nome, req.params.id, req.usuario.empresa_id]
    );
    res.json({ mensagem: 'Movido para lixeira', nome: item.nome });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
