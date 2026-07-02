const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar, autorizar } = require('../middleware/auth');
const soAdmin = autorizar('admin'); // grupos de permissão: escrita restrita a admin

const router = express.Router();

// Registra uma entrada no histórico do grupo
async function logGrupoHist(grupoId, req, acao, detalhe) {
  try {
    await run(
      'INSERT INTO grupo_historico (id, grupo_id, empresa_id, usuario_id, usuario_nome, acao, detalhe) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), grupoId, req.usuario.empresa_id, req.usuario.id, req.usuario.nome || '', acao, detalhe || null]
    );
  } catch {}
}

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

// Histórico de um grupo específico
router.get('/:id/historico', autenticar, async (req, res) => {
  try {
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    const hist = await all('SELECT * FROM grupo_historico WHERE grupo_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json(hist);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Criar grupo
router.post('/', autenticar, soAdmin, async (req, res) => {
  try {
    const { nome, descricao, permissoes_modulos } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      'INSERT INTO grupos_permissao (id, empresa_id, nome, descricao, permissoes_modulos) VALUES (?, ?, ?, ?, ?)',
      [id, req.usuario.empresa_id, nome, descricao || null, permissoes_modulos ? JSON.stringify(permissoes_modulos) : null]
    );
    await logGrupoHist(id, req, 'criada', 'Grupo criado');
    res.status(201).json({ id, nome, descricao, permissoes_modulos });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Atualizar grupo
router.put('/:id', autenticar, soAdmin, async (req, res) => {
  try {
    const { nome, descricao, permissoes_modulos } = req.body;
    const grupo = await get('SELECT * FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    const permDepois = permissoes_modulos ? JSON.stringify(permissoes_modulos) : null;
    await run(
      'UPDATE grupos_permissao SET nome = ?, descricao = ?, permissoes_modulos = ? WHERE id = ?',
      [nome, descricao || null, permDepois, req.params.id]
    );
    // Registra apenas o que mudou
    if ((grupo.permissoes_modulos || null) !== permDepois)
      await logGrupoHist(req.params.id, req, 'permissoes', 'Permissões atualizadas');
    if ((grupo.nome || '') !== (nome || '') || (grupo.descricao || '') !== (descricao || ''))
      await logGrupoHist(req.params.id, req, 'editada', 'Nome/descrição atualizados');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Excluir grupo
router.delete('/:id', autenticar, soAdmin, async (req, res) => {
  try {
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    await run('DELETE FROM grupo_membros WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM grupo_departamentos WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM grupo_historico WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Adicionar membro (usuário)
router.post('/:id/membros', autenticar, soAdmin, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, eid]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    const { usuario_id } = req.body;
    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id obrigatório' });
    const usuario = await get('SELECT id, nome FROM usuarios WHERE id = ? AND empresa_id = ?', [usuario_id, eid]);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    await run('INSERT INTO grupo_membros (grupo_id, usuario_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.params.id, usuario_id]);
    await logGrupoHist(req.params.id, req, 'membro_add', `Adicionou ${usuario.nome}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Remover membro (usuário)
router.delete('/:id/membros/:userId', autenticar, soAdmin, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, eid]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    const usuario = await get('SELECT nome FROM usuarios WHERE id = ?', [req.params.userId]);
    await run('DELETE FROM grupo_membros WHERE grupo_id = ? AND usuario_id = ?', [req.params.id, req.params.userId]);
    await logGrupoHist(req.params.id, req, 'membro_rem', `Removeu ${usuario?.nome || 'usuário'}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Adicionar departamento
router.post('/:id/departamentos', autenticar, soAdmin, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, eid]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    const { departamento_id } = req.body;
    if (!departamento_id) return res.status(400).json({ erro: 'departamento_id obrigatório' });
    const dept = await get('SELECT id, nome FROM departamentos WHERE id = ? AND empresa_id = ?', [departamento_id, eid]);
    if (!dept) return res.status(404).json({ erro: 'Departamento não encontrado' });
    await run('INSERT INTO grupo_departamentos (grupo_id, departamento_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [req.params.id, departamento_id]);
    await logGrupoHist(req.params.id, req, 'dept_add', `Adicionou departamento ${dept.nome}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Remover departamento
router.delete('/:id/departamentos/:deptId', autenticar, soAdmin, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const grupo = await get('SELECT id FROM grupos_permissao WHERE id = ? AND empresa_id = ?', [req.params.id, eid]);
    if (!grupo) return res.status(404).json({ erro: 'Grupo não encontrado' });
    const dept = await get('SELECT nome FROM departamentos WHERE id = ?', [req.params.deptId]);
    await run('DELETE FROM grupo_departamentos WHERE grupo_id = ? AND departamento_id = ?', [req.params.id, req.params.deptId]);
    await logGrupoHist(req.params.id, req, 'dept_rem', `Removeu departamento ${dept?.nome || ''}`);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
