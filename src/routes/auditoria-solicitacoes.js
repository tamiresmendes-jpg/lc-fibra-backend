const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Listar solicitações
router.get('/', async (req, res) => {
  try {
    const itens = await all(`
      SELECT s.*,
             p.titulo as pop_titulo, p.versao as pop_versao, p.conteudo as pop_conteudo,
             p.status as pop_status,
             c.nome as pop_categoria,
             u.nome as solicitante_nome, u.email as solicitante_email,
             d.nome as solicitante_departamento
      FROM auditoria_solicitacoes s
      JOIN pops p ON p.id = s.pop_id
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      JOIN usuarios u ON u.id = s.solicitante_id
      LEFT JOIN departamentos d ON d.id = u.departamento_id
      WHERE s.empresa_id = $1 AND p.excluido_em IS NULL
      ORDER BY s.created_at DESC
    `, [req.usuario.empresa_id]);
    res.json(itens);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar solicitação (chamada a partir do POP)
router.post('/', async (req, res) => {
  try {
    const { pop_id, tipo, descricao } = req.body;
    if (!pop_id || !tipo) return res.status(400).json({ erro: 'POP e tipo são obrigatórios' });

    const pop = await get('SELECT id FROM pops WHERE id=$1 AND empresa_id=$2', [pop_id, req.usuario.empresa_id]);
    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });

    const id = uuidv4();
    await run(`
      INSERT INTO auditoria_solicitacoes (id, empresa_id, pop_id, solicitante_id, tipo, descricao)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, req.usuario.empresa_id, pop_id, req.usuario.id, tipo, descricao || null]);

    res.status(201).json({ id, mensagem: 'Solicitação enviada com sucesso' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Detalhes de uma solicitação
router.get('/:id', async (req, res) => {
  try {
    const item = await get(`
      SELECT s.*,
             p.titulo as pop_titulo, p.versao as pop_versao, p.conteudo as pop_conteudo,
             p.status as pop_status, p.descricao as pop_descricao,
             c.nome as pop_categoria, c.cor as pop_categoria_cor,
             u.nome as solicitante_nome, u.email as solicitante_email,
             d.nome as solicitante_departamento,
             cr.nome as pop_criado_por_nome
      FROM auditoria_solicitacoes s
      JOIN pops p ON p.id = s.pop_id
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      JOIN usuarios u ON u.id = s.solicitante_id
      LEFT JOIN departamentos d ON d.id = u.departamento_id
      LEFT JOIN usuarios cr ON cr.id = p.criado_por
      WHERE s.id = $1 AND s.empresa_id = $2
    `, [req.params.id, req.usuario.empresa_id]);
    if (!item) return res.status(404).json({ erro: 'Solicitação não encontrada' });

    // Histórico do POP
    const historico = await all(`
      SELECT h.*, u.nome as usuario_nome
      FROM pop_historico h
      JOIN usuarios u ON u.id = h.usuario_id
      WHERE h.pop_id = $1
      ORDER BY h.created_at DESC
    `, [item.pop_id]);

    res.json({ ...item, pop_historico: historico });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Iniciar auditoria a partir de solicitação
router.post('/:id/iniciar', async (req, res) => {
  try {
    const { pendencias, resultado, score } = req.body;

    const solicitacao = await get('SELECT * FROM auditoria_solicitacoes WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!solicitacao) return res.status(404).json({ erro: 'Solicitação não encontrada' });

    const scoreNum = score != null ? Math.min(100, Math.max(0, Number(score))) : null;

    const pop = await get('SELECT titulo FROM pops WHERE id=$1 AND empresa_id=$2', [solicitacao.pop_id, req.usuario.empresa_id]);
    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });

    // Criar auditoria
    const auditoriaId = uuidv4();
    const statusAuditoria = scoreNum != null ? (scoreNum >= 70 ? 'aprovada' : 'rejeitada') : 'pendente';

    await run(`
      INSERT INTO auditorias (id, empresa_id, tipo, titulo, auditor_id, pop_id, solicitacao_id, score, status, resultado, pendencias, data_auditoria)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'))
    `, [auditoriaId, req.usuario.empresa_id, solicitacao.tipo, `Auditoria: ${pop.titulo}`, req.usuario.id, solicitacao.pop_id, solicitacao.id, scoreNum, statusAuditoria, resultado || null, pendencias || null]);

    // Atualizar solicitação
    await run('UPDATE auditoria_solicitacoes SET status=$1, auditoria_id=$2 WHERE id=$3', ['concluida', auditoriaId, req.params.id]);

    res.json({ auditoria_id: auditoriaId, status: statusAuditoria, mensagem: 'Auditoria realizada com sucesso' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar status da solicitação
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const solicitacao = await get('SELECT id FROM auditoria_solicitacoes WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!solicitacao) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    await run('UPDATE auditoria_solicitacoes SET status=$1 WHERE id=$2 AND empresa_id=$3', [status, req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Status atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
