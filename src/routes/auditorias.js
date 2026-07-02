const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Dashboard de auditorias
router.get('/dashboard', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const total = (await get("SELECT COUNT(*) as total FROM auditorias WHERE empresa_id=$1", [eid])).total;
    const aprovadas = (await get("SELECT COUNT(*) as total FROM auditorias WHERE empresa_id=$1 AND status='aprovada'", [eid])).total;
    const rejeitadas = (await get("SELECT COUNT(*) as total FROM auditorias WHERE empresa_id=$1 AND status='rejeitada'", [eid])).total;
    const pendentes = (await get("SELECT COUNT(*) as total FROM auditorias WHERE empresa_id=$1 AND status='pendente'", [eid])).total;
    const solicitacoesPendentes = (await get("SELECT COUNT(*) as total FROM auditoria_solicitacoes WHERE empresa_id=$1 AND status='pendente'", [eid])).total;
    const mediaScore = (await get("SELECT AVG(score) as media FROM auditorias WHERE empresa_id=$1 AND score IS NOT NULL", [eid])).media;
    const porTipo = await all("SELECT tipo, COUNT(*) as total FROM auditorias WHERE empresa_id=$1 GROUP BY tipo", [eid]);
    res.json({ total, aprovadas, rejeitadas, pendentes, solicitacoesPendentes, mediaScore: mediaScore ? Math.round(mediaScore * 10) / 10 : null, porTipo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT a.*,
             ua.nome as auditado_nome, ub.nome as auditor_nome,
             p.titulo as pop_titulo
      FROM auditorias a
      LEFT JOIN usuarios ua ON ua.id = a.auditado_id
      LEFT JOIN usuarios ub ON ub.id = a.auditor_id
      LEFT JOIN pops p ON p.id = a.pop_id
      WHERE a.empresa_id = $1
      ORDER BY a.created_at DESC
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, tipo, descricao, auditado_id, pop_id, data_auditoria, itens } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();

    await run(`
      INSERT INTO auditorias (id, empresa_id, titulo, tipo, descricao, auditado_id, auditor_id, pop_id, data_auditoria)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [id, req.usuario.empresa_id, titulo, tipo || 'pop', descricao || null, auditado_id || null, req.usuario.id, pop_id || null, data_auditoria || null]);

    if (itens && itens.length > 0) {
      for (const item of itens) {
        await run('INSERT INTO auditoria_itens (id, auditoria_id, pergunta, peso) VALUES ($1, $2, $3, $4)', [uuidv4(), id, item.pergunta, item.peso || 1]);
      }
    }

    res.status(201).json({ id, titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const auditoria = await get(`
      SELECT a.*, ua.nome as auditado_nome, ub.nome as auditor_nome
      FROM auditorias a
      LEFT JOIN usuarios ua ON ua.id = a.auditado_id
      LEFT JOIN usuarios ub ON ub.id = a.auditor_id
      WHERE a.id = $1 AND a.empresa_id = $2
    `, [req.params.id, req.usuario.empresa_id]);
    if (!auditoria) return res.status(404).json({ erro: 'Auditoria não encontrada' });

    const itens = await all('SELECT * FROM auditoria_itens WHERE auditoria_id = $1', [req.params.id]);
    res.json({ ...auditoria, itens });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const auditoria = await get('SELECT id FROM auditorias WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!auditoria) return res.status(404).json({ erro: 'Auditoria não encontrada' });
    const { titulo, tipo, descricao, auditado_id, pop_id, data_auditoria, status } = req.body;
    await run(
      `UPDATE auditorias SET titulo=$1, tipo=$2, descricao=$3, auditado_id=$4, pop_id=$5, data_auditoria=$6, status=$7 WHERE id=$8`,
      [titulo, tipo || 'pop', descricao || null, auditado_id || null, pop_id || null, data_auditoria || null, status || 'pendente', req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id/responder', async (req, res) => {
  try {
    const auditoria = await get('SELECT id FROM auditorias WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!auditoria) return res.status(404).json({ erro: 'Auditoria não encontrada' });

    const { respostas } = req.body; // [{ item_id, resposta, conformidade, observacao }]

    for (const r of respostas) {
      await run('UPDATE auditoria_itens SET resposta=$1, conformidade=$2, observacao=$3 WHERE id=$4 AND auditoria_id=$5', [r.resposta, r.conformidade, r.observacao || null, r.item_id, req.params.id]);
    }

    // Calcular score
    const itens = await all('SELECT * FROM auditoria_itens WHERE auditoria_id = $1', [req.params.id]);
    const total = itens.reduce((s, i) => s + i.peso, 0);
    const conformes = itens.filter(i => i.conformidade === 'conforme').reduce((s, i) => s + i.peso, 0);
    const score = total > 0 ? (conformes / total) * 100 : 0;

    await run('UPDATE auditorias SET score=$1, status=$2 WHERE id=$3 AND empresa_id=$4', [score, 'concluida', req.params.id, req.usuario.empresa_id]);
    res.json({ score, mensagem: 'Auditoria concluída' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const auditoria = await get('SELECT id FROM auditorias WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!auditoria) return res.status(404).json({ erro: 'Auditoria não encontrada' });
    await run('DELETE FROM auditoria_itens WHERE auditoria_id=$1', [req.params.id]);
    await run('DELETE FROM auditorias WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Removido' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
