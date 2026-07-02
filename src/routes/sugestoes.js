const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Listar sugestões — todos veem; arquivadas só admin/gestor
router.get('/', autenticar, async (req, res) => {
  try {
    const isAdmin = ['admin', 'gestor'].includes(req.usuario.perfil);
    const rows = await all(
      `SELECT id, empresa_id, categoria, texto, status, resposta, imagem, created_at
       FROM sugestoes
       WHERE empresa_id = $1
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
    const { texto, categoria, imagem } = req.body;
    if (!texto || texto.trim().length < 5) return res.status(400).json({ erro: 'Sugestão muito curta' });
    let img = null;
    if (imagem && typeof imagem === 'string' && imagem.startsWith('data:image/')) {
      if (imagem.length > 4_200_000) return res.status(400).json({ erro: 'Imagem muito grande (máx. ~3MB).' });
      img = imagem;
    }
    const id = uuidv4();
    await run(
      `INSERT INTO sugestoes (id, empresa_id, categoria, texto, status, imagem) VALUES ($1, $2, $3, $4, 'nova', $5)`,
      [id, req.usuario.empresa_id, categoria || 'geral', texto.trim(), img]
    );
    res.status(201).json({ id, mensagem: 'Sugestão enviada com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao enviar sugestão' }); }
});

// Atualizar status e resposta (admin/gestor)
router.put('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(
      'SELECT id FROM sugestoes WHERE id = $1 AND empresa_id = $2',
      [req.params.id, req.usuario.empresa_id]
    );
    if (!exist) return res.status(404).json({ erro: 'Não encontrada' });
    const { status, resposta } = req.body;
    const statusValidos = ['nova', 'em_analise', 'respondida', 'arquivada'];
    const novoStatus = statusValidos.includes(status) ? status : 'nova';
    await run(
      `UPDATE sugestoes SET status = $1, resposta = $2 WHERE id = $3 AND empresa_id = $4`,
      [novoStatus, resposta || null, req.params.id, req.usuario.empresa_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao atualizar sugestão' }); }
});

// Excluir sugestão (admin/gestor)
router.delete('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão' });
    await run(
      'DELETE FROM sugestoes WHERE id = $1 AND empresa_id = $2',
      [req.params.id, req.usuario.empresa_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao excluir sugestão' }); }
});

module.exports = router;
