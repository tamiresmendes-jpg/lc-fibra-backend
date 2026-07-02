const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Lista plana com total_pops — usada no modal de seleção
router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT c.*, COUNT(p.id) as total_pops
      FROM categorias_pop c
      LEFT JOIN pops p ON p.categoria_id = c.id
      WHERE c.empresa_id = ?
      GROUP BY c.id ORDER BY c.nome
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Lista em árvore — usada na página de categorias
router.get('/arvore', async (req, res) => {
  try {
    const todas = await all(`
      SELECT c.*, COUNT(p.id) as total_pops
      FROM categorias_pop c
      LEFT JOIN pops p ON p.categoria_id = c.id
      WHERE c.empresa_id = ?
      GROUP BY c.id ORDER BY c.nome
    `, [req.usuario.empresa_id]);

    const pais = todas.filter(c => !c.parent_id);
    const arvore = pais.map(pai => ({
      ...pai,
      filhos: todas.filter(c => c.parent_id === pai.id)
    }));
    res.json(arvore);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, cor, parent_id } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run('INSERT INTO categorias_pop (id, empresa_id, nome, descricao, cor, parent_id) VALUES (?, ?, ?, ?, ?, ?)', [
      id, req.usuario.empresa_id, nome, descricao || null, cor || '#7B55F1', parent_id || null
    ]);
    res.status(201).json({ id, nome });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, cor, parent_id } = req.body;
    await run('UPDATE categorias_pop SET nome=?, descricao=?, cor=?, parent_id=? WHERE id=? AND empresa_id=?', [
      nome, descricao || null, cor || '#7B55F1', parent_id || null, req.params.id, req.usuario.empresa_id
    ]);
    res.json({ mensagem: 'Atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const item = await get('SELECT id FROM categorias_pop WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    if (!item) return res.status(404).json({ erro: 'Não encontrada' });
    // Remove subcategorias junto
    await run('UPDATE pops SET categoria_id=NULL WHERE categoria_id IN (SELECT id FROM categorias_pop WHERE parent_id=? AND empresa_id=?) AND empresa_id=?', [req.params.id, req.usuario.empresa_id, req.usuario.empresa_id]);
    await run('DELETE FROM categorias_pop WHERE parent_id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    await run('UPDATE pops SET categoria_id=NULL WHERE categoria_id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    await run('DELETE FROM categorias_pop WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
