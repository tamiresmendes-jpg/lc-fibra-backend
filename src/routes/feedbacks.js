const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const uid = req.usuario.id;
    const perfil = req.usuario.perfil;
    const ehAdmin = perfil === 'admin' || perfil === 'gestor';

    // Admin/gestor vê todos; colaborador vê apenas os enviados ou recebidos para ele (exceto privados de outros)
    let rows;
    if (ehAdmin) {
      rows = await all(
        `SELECT f.*, u1.nome as de_nome, u1.avatar as de_avatar, u2.nome as para_nome, u2.avatar as para_avatar
         FROM feedbacks f
         LEFT JOIN usuarios u1 ON u1.id = f.de_usuario_id
         LEFT JOIN usuarios u2 ON u2.id = f.para_usuario_id
         WHERE f.empresa_id = ?
         ORDER BY f.created_at DESC`,
        [eid]
      );
    } else {
      rows = await all(
        `SELECT f.*, u1.nome as de_nome, u1.avatar as de_avatar, u2.nome as para_nome, u2.avatar as para_avatar
         FROM feedbacks f
         LEFT JOIN usuarios u1 ON u1.id = f.de_usuario_id
         LEFT JOIN usuarios u2 ON u2.id = f.para_usuario_id
         WHERE f.empresa_id = ? AND (f.de_usuario_id = ? OR f.para_usuario_id = ? OR f.privado = 0)
         ORDER BY f.created_at DESC`,
        [eid, uid, uid]
      );
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { para_usuario_id, tipo, conteudo, privado } = req.body;
    if (!para_usuario_id || !conteudo?.trim()) return res.status(400).json({ erro: 'Destinatário e conteúdo obrigatórios' });

    // Confirma que o destinatário pertence à mesma empresa
    const alvo = await get('SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?', [para_usuario_id, req.usuario.empresa_id]);
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const id = uuidv4();
    await run(
      `INSERT INTO feedbacks (id, empresa_id, de_usuario_id, para_usuario_id, tipo, conteudo, privado)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, req.usuario.id, para_usuario_id, tipo || 'positivo', conteudo.trim(), privado ? 1 : 0]
    );
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const fb = await get('SELECT * FROM feedbacks WHERE id = ? AND empresa_id = ?', [req.params.id, req.usuario.empresa_id]);
    if (!fb) return res.status(404).json({ erro: 'Feedback não encontrado' });

    const ehAdmin = req.usuario.perfil === 'admin' || req.usuario.perfil === 'gestor';
    if (!ehAdmin && fb.de_usuario_id !== req.usuario.id) {
      return res.status(403).json({ erro: 'Sem permissão para remover este feedback' });
    }

    await run('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
