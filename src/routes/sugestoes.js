const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Listar sugestões (admin vê todas; colaborador vê o resumo público)
router.get('/', autenticar, async (req, res) => {
  try {
    const isAdmin = ['admin', 'gestor'].includes(req.usuario.perfil);
    // Admin vê todas; colaboradores vêm apenas as não-arquivadas
    const rows = await all(
      `SELECT id, empresa_id, categoria, texto, status, resposta, created_at
       FROM sugestoes
       WHERE empresa_id = ?
       ${isAdmin ? '' : "AND status <> 'arquivada'"}
       ORDER BY created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar sugestões' }); }
});

// Enviar sugestão anônima — NÃO armazena usuario_id
router.post('/', autenticar, async (req, res) => {
  try {
    const { texto, categoria } = req.body;
    if (!texto || texto.trim().length < 5) return res.status(400).json({ erro: 'Sugestão muito curta' });
    const id = uuidv4();
    await run(
      `INSERT INTO sugestoes (id, empresa_id, categoria, texto, status) VALUES (?, ?, ?, ?, 'nova')`,
      [id, req.usuario.empresa_id, categoria || 'geral', texto.trim()]
    );
    res.status(201).json({ id, mensagem: 'Sugestão enviada com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao enviar sugestão' }); }
});

// Atualizar status e resposta (admin)
router.put('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil)) {
      return res.status(403).json({ erro: 'Sem permissão' });
    }
    const exist = await get('SELECT id FROM sugestoes WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrada' });
    const { status, resposta } = req.body;
    const statusValidos = ['nova', 'em_analise', 'respondida', 'arquivada'];
    const novoStatus = statusValidos.includes(status) ? status : 'nova';
    await run(
      `UPDATE sugestoes SET status = ?, resposta = ? WHERE id = ? AND empresa_id = ?`,
      [novoStatus, resposta || null, req.params.id, req.usuario.empresa_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar sugestão' }); }
});

// Excluir sugestão (admin)
router.delete('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil)) {
      return res.status(403).json({ erro: 'Sem permissão' });
    }
    await run('DELETE FROM sugestoes WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao excluir sugestão' }); }
});

module.exports = router;
