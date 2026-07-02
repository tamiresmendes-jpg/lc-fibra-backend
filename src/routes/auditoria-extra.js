const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── NÃO CONFORMIDADES ────────────────────────────────────────────────────────
router.get('/nao-conformidades', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT n.*, a.titulo AS auditoria_titulo, u.nome AS responsavel_nome
       FROM auditoria_nao_conformidades n
       LEFT JOIN auditorias a ON a.id = n.auditoria_id
       LEFT JOIN usuarios u ON u.id = n.responsavel_id
       WHERE n.empresa_id=? ORDER BY n.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar não conformidades' }); }
});

router.post('/nao-conformidades', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, descricao, auditoria_id, responsavel_id, prazo, gravidade, status } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO auditoria_nao_conformidades (id,empresa_id,titulo,descricao,auditoria_id,responsavel_id,prazo,gravidade,status) VALUES (?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, auditoria_id || null, responsavel_id || null, prazo || null, gravidade || 'media', status || 'aberta']
    );
    res.status(201).json(await get(`SELECT * FROM auditoria_nao_conformidades WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar não conformidade' }); }
});

router.put('/nao-conformidades/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM auditoria_nao_conformidades WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, auditoria_id, responsavel_id, prazo, gravidade, status } = req.body;
    await run(
      `UPDATE auditoria_nao_conformidades SET titulo=?,descricao=?,auditoria_id=?,responsavel_id=?,prazo=?,gravidade=?,status=? WHERE id=?`,
      [titulo, descricao || null, auditoria_id || null, responsavel_id || null, prazo || null, gravidade || 'media', status || 'aberta', req.params.id]
    );
    res.json(await get(`SELECT * FROM auditoria_nao_conformidades WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar' }); }
});

router.delete('/nao-conformidades/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM auditoria_nao_conformidades WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM auditoria_nao_conformidades WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir' }); }
});

// ── PLANO DE AÇÃO (das auditorias) ───────────────────────────────────────────
router.get('/plano-acao-auditoria', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT a.*, u.nome AS responsavel_nome FROM acoes a
       LEFT JOIN usuarios u ON u.id = a.responsavel_id
       WHERE a.empresa_id=? AND a.excluido_em IS NULL
       ORDER BY a.data_prazo ASC NULLS LAST, a.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar plano de ação' }); }
});

// ── EVIDÊNCIAS ───────────────────────────────────────────────────────────────
router.get('/evidencias', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT e.*, a.titulo AS auditoria_titulo, u.nome AS usuario_nome
       FROM auditoria_evidencias e
       LEFT JOIN auditorias a ON a.id = e.auditoria_id
       LEFT JOIN usuarios u ON u.id = e.usuario_id
       WHERE e.empresa_id=? ORDER BY e.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar evidências' }); }
});

router.post('/evidencias', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, descricao, auditoria_id, tipo, url } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO auditoria_evidencias (id,empresa_id,titulo,descricao,auditoria_id,tipo,url,usuario_id) VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, auditoria_id || null, tipo || 'documento', url || null, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM auditoria_evidencias WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar evidência' }); }
});

router.delete('/evidencias/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM auditoria_evidencias WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM auditoria_evidencias WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir evidência' }); }
});

// ── HISTÓRICO DAS AUDITORIAS ─────────────────────────────────────────────────
router.get('/historico-auditorias', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT a.*, ua.nome AS auditado_nome, uc.nome AS auditor_nome
       FROM auditorias a
       LEFT JOIN usuarios ua ON ua.id = a.auditado_id
       LEFT JOIN usuarios uc ON uc.id = a.auditor_id
       WHERE a.empresa_id=? AND a.status IN ('concluida','aprovada','reprovada')
       ORDER BY a.data_auditoria DESC NULLS LAST, a.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar histórico' }); }
});

module.exports = router;
