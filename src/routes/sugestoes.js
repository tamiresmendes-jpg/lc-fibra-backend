const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Fórum identificado: guarda autor + curtidas + comentários
;(async () => {
  try { await run('ALTER TABLE sugestoes ADD COLUMN IF NOT EXISTS usuario_id TEXT'); } catch {}
  try { await run('ALTER TABLE sugestoes ADD COLUMN IF NOT EXISTS usuario_nome TEXT'); } catch {}
  try {
    await run(`CREATE TABLE IF NOT EXISTS sugestao_curtidas (
      sugestao_id TEXT NOT NULL,
      usuario_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (sugestao_id, usuario_id)
    )`);
  } catch {}
  try {
    await run(`CREATE TABLE IF NOT EXISTS sugestao_comentarios (
      id TEXT PRIMARY KEY,
      sugestao_id TEXT NOT NULL,
      empresa_id TEXT,
      usuario_id TEXT,
      usuario_nome TEXT,
      texto TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  } catch {}
})();

// Listar sugestões — todos veem; arquivadas só admin/gestor
router.get('/', autenticar, async (req, res) => {
  try {
    const isAdmin = ['admin', 'gestor'].includes(req.usuario.perfil);
    const rows = await all(
      `SELECT s.id, s.empresa_id, s.categoria, s.texto, s.status, s.resposta, s.imagem, s.created_at, s.usuario_id, s.usuario_nome,
              (SELECT COUNT(*)::int FROM sugestao_curtidas c WHERE c.sugestao_id = s.id) AS curtidas,
              (SELECT COUNT(*)::int FROM sugestao_curtidas c WHERE c.sugestao_id = s.id AND c.usuario_id = $2) > 0 AS eu_curti,
              (SELECT COUNT(*)::int FROM sugestao_comentarios cm WHERE cm.sugestao_id = s.id) AS n_comentarios
       FROM sugestoes s
       WHERE s.empresa_id = $1
       ${isAdmin ? '' : "AND s.status <> 'arquivada'"}
       ORDER BY s.created_at DESC`,
      [req.usuario.empresa_id, req.usuario.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar sugestões' }); }
});

// Publicar no fórum — identificado (guarda autor)
router.post('/', autenticar, async (req, res) => {
  try {
    const { texto, categoria, imagem } = req.body;
    if (!texto || texto.trim().length < 5) return res.status(400).json({ erro: 'Mensagem muito curta' });
    let img = null;
    if (imagem && typeof imagem === 'string' && imagem.startsWith('data:image/')) {
      if (imagem.length > 4_200_000) return res.status(400).json({ erro: 'Imagem muito grande (máx. ~3MB).' });
      img = imagem;
    }
    const id = uuidv4();
    await run(
      `INSERT INTO sugestoes (id, empresa_id, categoria, texto, status, imagem, usuario_id, usuario_nome) VALUES ($1, $2, $3, $4, 'nova', $5, $6, $7)`,
      [id, req.usuario.empresa_id, categoria || 'geral', texto.trim(), img, req.usuario.id, req.usuario.nome || null]
    );
    res.status(201).json({ id, mensagem: 'Publicado com sucesso' });
  } catch (e) { res.status(500).json({ erro: 'Erro ao publicar' }); }
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

// Curtir / descurtir (toggle) — qualquer usuário
router.post('/:id/curtir', autenticar, async (req, res) => {
  try {
    const s = await get('SELECT id FROM sugestoes WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!s) return res.status(404).json({ erro: 'Não encontrada' });
    const ja = await get('SELECT 1 FROM sugestao_curtidas WHERE sugestao_id = $1 AND usuario_id = $2', [req.params.id, req.usuario.id]);
    if (ja) {
      await run('DELETE FROM sugestao_curtidas WHERE sugestao_id = $1 AND usuario_id = $2', [req.params.id, req.usuario.id]);
    } else {
      await run('INSERT INTO sugestao_curtidas (sugestao_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.usuario.id]);
    }
    const c = await get('SELECT COUNT(*)::int AS n FROM sugestao_curtidas WHERE sugestao_id = $1', [req.params.id]);
    res.json({ curtidas: c.n, eu_curti: !ja });
  } catch (e) { res.status(500).json({ erro: 'Erro ao curtir' }); }
});

// Listar comentários de um post
router.get('/:id/comentarios', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT id, usuario_id, usuario_nome, texto, created_at FROM sugestao_comentarios
       WHERE sugestao_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: 'Erro ao buscar comentários' }); }
});

// Comentar (identificado) — qualquer usuário
router.post('/:id/comentarios', autenticar, async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || texto.trim().length < 1) return res.status(400).json({ erro: 'Comentário vazio' });
    const s = await get('SELECT id FROM sugestoes WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!s) return res.status(404).json({ erro: 'Não encontrada' });
    const id = uuidv4();
    await run(
      `INSERT INTO sugestao_comentarios (id, sugestao_id, empresa_id, usuario_id, usuario_nome, texto)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, req.params.id, req.usuario.empresa_id, req.usuario.id, req.usuario.nome || null, texto.trim()]
    );
    res.status(201).json({ id, usuario_id: req.usuario.id, usuario_nome: req.usuario.nome || null, texto: texto.trim(), created_at: new Date().toISOString() });
  } catch (e) { res.status(500).json({ erro: 'Erro ao comentar' }); }
});

// Excluir comentário — o próprio autor ou admin/gestor
router.delete('/comentarios/:cid', autenticar, async (req, res) => {
  try {
    const c = await get('SELECT usuario_id FROM sugestao_comentarios WHERE id = $1 AND empresa_id = $2', [req.params.cid, req.usuario.empresa_id]);
    if (!c) return res.status(404).json({ erro: 'Não encontrado' });
    const isAdmin = ['admin', 'gestor'].includes(req.usuario.perfil);
    if (c.usuario_id !== req.usuario.id && !isAdmin) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM sugestao_comentarios WHERE id = $1', [req.params.cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: 'Erro ao excluir comentário' }); }
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
