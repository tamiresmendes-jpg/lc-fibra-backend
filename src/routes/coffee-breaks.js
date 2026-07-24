const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { notificar: notificarDiscord, COR: DISCORD_COR } = require('../utils/discord');

function fmtDataBR(d) { try { return new Date(d + 'T12:00').toLocaleDateString('pt-BR'); } catch { return d; } }

router.get('/', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM coffee_breaks WHERE empresa_id = ? AND ativo = 1 ORDER BY data ASC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar coffee breaks' }); }
});

router.post('/', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { unidade, cidade, data, horario, titulo, observacao, imagem } = req.body;
    if (!unidade || !data) return res.status(400).json({ erro: 'Unidade e data são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO coffee_breaks (id, empresa_id, unidade, cidade, data, horario, titulo, observacao, imagem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, unidade, cidade || null, data, horario || null, titulo || null, observacao || null, imagem || null]
    );
    res.status(201).json(await get(`SELECT * FROM coffee_breaks WHERE id = ?`, [id]));
    notificarDiscord(req.usuario.empresa_id, 'coffee', {
      title: `☕ Coffee Break${titulo ? ': ' + titulo : ''}`,
      description: `📍 ${unidade}${cidade ? ' — ' + cidade : ''}\n🗓️ ${fmtDataBR(data)}${horario ? ' às ' + horario : ''}${observacao ? '\n\n' + observacao : ''}`,
      color: DISCORD_COR.laranja,
      linkPath: '/coffee-breaks',
      footer: { text: 'Kronos — Coffee Break' },
      timestamp: new Date().toISOString(),
    }).catch(() => {});
  } catch { res.status(500).json({ erro: 'Erro ao criar coffee break' }); }
});

router.put('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const existente = await get(`SELECT id FROM coffee_breaks WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Não encontrado' });
    const { unidade, cidade, data, horario, titulo, observacao, imagem } = req.body;
    await run(
      `UPDATE coffee_breaks SET unidade = ?, cidade = ?, data = ?, horario = ?, titulo = ?, observacao = ?, imagem = ? WHERE id = ?`,
      [unidade, cidade || null, data, horario || null, titulo || null, observacao || null, imagem || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM coffee_breaks WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar coffee break' }); }
});

router.delete('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const existente = await get(`SELECT id FROM coffee_breaks WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`UPDATE coffee_breaks SET ativo = 0 WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao remover coffee break' }); }
});

module.exports = router;
