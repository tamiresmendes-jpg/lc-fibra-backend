const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard-stats', autenticar, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const [acoes, metas, okrs, indicadores] = await Promise.all([
      all(`SELECT status, COUNT(*) AS n FROM acoes WHERE empresa_id=$1 AND excluido_em IS NULL GROUP BY status`, [eid]),
      all(`SELECT status, COUNT(*) AS n FROM metas WHERE empresa_id=$1 GROUP BY status`, [eid]),
      all(`SELECT status, COUNT(*) AS n FROM okrs WHERE empresa_id=$1 GROUP BY status`, [eid]),
      get(`SELECT COUNT(*) AS n FROM indicadores WHERE empresa_id=$1 AND status='ativo'`, [eid]),
    ]);
    res.json({ acoes, metas, okrs, indicadores: indicadores.n });
  } catch { res.status(500).json({ erro: 'Erro ao buscar stats' }); }
});

// ── METAS ────────────────────────────────────────────────────────────────────
router.get('/metas', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT m.*, d.nome AS departamento_nome, u.nome AS responsavel_nome
       FROM metas m
       LEFT JOIN departamentos d ON d.id = m.departamento_id
       LEFT JOIN usuarios u ON u.id = m.responsavel_id
       WHERE m.empresa_id=$1 ORDER BY m.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar metas' }); }
});

router.post('/metas', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { titulo, descricao, valor_meta, valor_atual, unidade, departamento_id, responsavel_id, data_inicio, data_fim, status } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO metas (id,empresa_id,titulo,descricao,valor_meta,valor_atual,unidade,departamento_id,responsavel_id,data_inicio,data_fim,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, valor_meta || 0, valor_atual || 0, unidade || '%', departamento_id || null, responsavel_id || null, data_inicio || null, data_fim || null, status || 'ativa']
    );
    res.status(201).json(await get(`SELECT * FROM metas WHERE id=$1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar meta' }); }
});

router.put('/metas/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM metas WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, valor_meta, valor_atual, unidade, departamento_id, responsavel_id, data_inicio, data_fim, status } = req.body;
    await run(
      `UPDATE metas SET titulo=$1,descricao=$2,valor_meta=$3,valor_atual=$4,unidade=$5,departamento_id=$6,responsavel_id=$7,data_inicio=$8,data_fim=$9,status=$10 WHERE id=$11 AND empresa_id=$12`,
      [titulo, descricao || null, valor_meta || 0, valor_atual || 0, unidade || '%', departamento_id || null, responsavel_id || null, data_inicio || null, data_fim || null, status || 'ativa', req.params.id, req.usuario.empresa_id]
    );
    res.json(await get(`SELECT * FROM metas WHERE id=$1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar meta' }); }
});

router.delete('/metas', autenticar, async (req, res) => {
  res.status(405).json({ erro: 'Método não permitido neste endpoint' });
});

router.delete('/metas/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM metas WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM metas WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir meta' }); }
});

// ── OKRs ─────────────────────────────────────────────────────────────────────
router.get('/okrs', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT o.*, u.nome AS responsavel_nome FROM okrs o
       LEFT JOIN usuarios u ON u.id = o.responsavel_id
       WHERE o.empresa_id=$1 ORDER BY o.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows.map(o => ({ ...o, resultados_chave: o.resultados_chave ? JSON.parse(o.resultados_chave) : [] })));
  } catch { res.status(500).json({ erro: 'Erro ao buscar OKRs' }); }
});

router.post('/okrs', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { objetivo, resultados_chave, responsavel_id, data_inicio, data_fim, ciclo } = req.body;
    if (!objetivo) return res.status(400).json({ erro: 'Objetivo obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO okrs (id,empresa_id,objetivo,resultados_chave,responsavel_id,data_inicio,data_fim,ciclo,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ativo')`,
      [id, req.usuario.empresa_id, objetivo, JSON.stringify(resultados_chave || []), responsavel_id || null, data_inicio || null, data_fim || null, ciclo || null]
    );
    res.status(201).json(await get(`SELECT * FROM okrs WHERE id=$1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar OKR' }); }
});

router.put('/okrs/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM okrs WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { objetivo, resultados_chave, responsavel_id, data_inicio, data_fim, ciclo, status } = req.body;
    await run(
      `UPDATE okrs SET objetivo=$1,resultados_chave=$2,responsavel_id=$3,data_inicio=$4,data_fim=$5,ciclo=$6,status=$7 WHERE id=$8 AND empresa_id=$9`,
      [objetivo, JSON.stringify(resultados_chave || []), responsavel_id || null, data_inicio || null, data_fim || null, ciclo || null, status || 'ativo', req.params.id, req.usuario.empresa_id]
    );
    res.json(await get(`SELECT * FROM okrs WHERE id=$1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar OKR' }); }
});

router.delete('/okrs/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM okrs WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM okrs WHERE id=$1 AND empresa_id=$2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir OKR' }); }
});

// ── RANKING DE INDICADORES ────────────────────────────────────────────────────
router.get('/ranking-indicadores', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT i.*, d.nome AS departamento_nome,
        CASE WHEN i.meta > 0 THEN ROUND((i.valor_atual / i.meta) * 100, 1) ELSE 0 END AS percentual
       FROM indicadores i
       LEFT JOIN departamentos d ON d.id = i.departamento_id
       WHERE i.empresa_id=$1 AND i.status='ativo'
       ORDER BY percentual DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar ranking' }); }
});

module.exports = router;
