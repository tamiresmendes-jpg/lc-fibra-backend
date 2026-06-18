const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();

// Listar grupos
router.get('/', autenticar, async (req, res) => {
  try {
    const grupos = await all(
      'SELECT g.*, (SELECT COUNT(*) FROM grupo_membros WHERE grupo_id = g.id) as total_usuarios, (SELECT COUNT(*) FROM grupo_departamentos WHERE grupo_id = g.id) as total_depts FROM grupos_permissao g WHERE g.empresa_id = ? ORDER BY g.nome',
      [req.usuario.empresa_id]
    );
    for (const g of grupos) {
      if (g.permissoes_modulos) {
        try { g.permissoes_modulos = JSON.parse(g.permissoes_modulos); } catch { g.permissoes_modulos = null; }
      }
      g.total_usuarios = Number(g.total_usuarios) || 0;
      g.total_depts = Number(g.total_depts) || 0;
      g.membros = await all(
        'SELECT u.id, u.nome, u.email, u.avatar FROM usuarios u JOIN grupo_membros gm ON gm.usuario_id = u.id WHERE gm.grupo_id = ? ORDER BY u.nome',
        [g.id]
      );
      g.departamentos = await all(
        'SELECT d.id, d.nome FROM departamentos d JOIN grupo_departamentos gd ON gd.departamento_id = d.id WHERE gd.grupo_id = ? ORDER BY d.nome',
        [g.id]
      );
    }
    res.json(grupos);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Criar grupo
router.post('/', autenticar, async (req, res) => {
  try {
    const { nome, descricao, permissoes_modulos } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      'INSERT INTO grupos_permissao (id, empresa_id, nome, descricao, permissoes_modulos) VALUES (?, ?, ?, ?, ?)',
      [id, req.usuario.empresa_id, nome, descricao || null, permissoes_modulos ? JSON.stringify(permissoes_modulos) : null]
    );
    res.status(201).json({ id, nome, descricao, permissoes_modulos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Atualizar grupo
router.put('/:id', autenticar, async (req, res) => {
  try {
    const { nome, descricao, permissoes_modulos } = req.body;
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    await run(
      'UPDATE grupos_permissao SET nome = ?, descricao = ?, permissoes_modulos = ? WHERE id = ?',
      [nome, descricao || null, permissoes_modulos ? JSON.stringify(permissoes_modulos) : null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Excluir grupo
router.delete('/:id', autenticar, async (req, res) => {
  try {
    await run('DELETE FROM grupo_membros WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM grupo_departamentos WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Adicionar membro (usuário)
router.post('/:id/membros', autenticar, async (req, res) => {
  try {
    const { usuario_id } = req.body;
    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatório' });
    await run('INSERT INTO grupo_membros (grupo_id, usuario_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.params.id, usuario_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Remover membro (usuário)
router.delete('/:id/membros/:userId', autenticar, async (req, res) => {
  try {
    await run('DELETE FROM grupo_membros WHERE grupo_id = ? AND usuario_id = ?', [req.params.id, req.params.userId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Adicionar departamento
router.post('/:id/departamentos', autenticar, async (req, res) => {
  try {
    const { departamento_id } = req.body;
    if (!departamento_id) return res.status(400).json({ erro: 'departamento_id obrigatório' });
    await run('INSERT INTO grupo_departamentos (grupo_id, departamento_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.params.id, departamento_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Remover departamento
router.delete('/:id/departamentos/:deptId', autenticar, async (req, res) => {
  try {
    await run('DELETE FROM grupo_departamentos WHERE grupo_id = ? AND departamento_id = ?', [req.params.id, req.params.deptId]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
