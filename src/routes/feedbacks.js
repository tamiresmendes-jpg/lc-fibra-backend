const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const eid  = req.usuario.empresa_id;
    const uid  = req.usuario.id;
    const perf = req.usuario.perfil;

    let rows;

    if (perf === 'admin' || perf === 'gestor') {
      // admin e gestor veem todos da empresa
      rows = await all(
        `SELECT f.*, u1.nome as de_nome, u1.avatar as de_avatar,
                u2.nome as para_nome, u2.avatar as para_avatar
         FROM feedbacks f
         LEFT JOIN usuarios u1 ON u1.id = f.de_usuario_id
         LEFT JOIN usuarios u2 ON u2.id = f.para_usuario_id
         WHERE f.empresa_id = $1
         ORDER BY f.created_at DESC`,
        [eid]
      );
    } else if (perf === 'lider') {
      // líder vê apenas feedbacks onde ele é o remetente
      rows = await all(
        `SELECT f.*, u1.nome as de_nome, u1.avatar as de_avatar,
                u2.nome as para_nome, u2.avatar as para_avatar
         FROM feedbacks f
         LEFT JOIN usuarios u1 ON u1.id = f.de_usuario_id
         LEFT JOIN usuarios u2 ON u2.id = f.para_usuario_id
         WHERE f.empresa_id = $1
           AND f.de_usuario_id = $2
         ORDER BY f.created_at DESC`,
        [eid, uid]
      );
    } else {
      // colaborador vê apenas os próprios (enviados ou recebidos para ele)
      rows = await all(
        `SELECT f.*, u1.nome as de_nome, u1.avatar as de_avatar,
                u2.nome as para_nome, u2.avatar as para_avatar
         FROM feedbacks f
         LEFT JOIN usuarios u1 ON u1.id = f.de_usuario_id
         LEFT JOIN usuarios u2 ON u2.id = f.para_usuario_id
         WHERE f.empresa_id = $1
           AND (f.de_usuario_id = $2 OR f.para_usuario_id = $2)
         ORDER BY f.created_at DESC`,
        [eid, uid]
      );
    }

    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { para_usuario_id, tipo, conteudo, privado } = req.body;
    if (!para_usuario_id || !conteudo?.trim())
      return res.status(400).json({ erro: 'Destinatário e conteúdo obrigatórios' });

    const alvo = await get(
      'SELECT id FROM usuarios WHERE id = $1 AND empresa_id = $2',
      [para_usuario_id, req.usuario.empresa_id]
    );
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });

    const id = uuidv4();
    await run(
      `INSERT INTO feedbacks (id, empresa_id, de_usuario_id, para_usuario_id, tipo, conteudo, privado)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, req.usuario.empresa_id, req.usuario.id, para_usuario_id,
       tipo || 'positivo', conteudo.trim(), privado ? true : false]
    );
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    const fb = await get(
      'SELECT * FROM feedbacks WHERE id = $1 AND empresa_id = $2',
      [req.params.id, req.usuario.empresa_id]
    );
    if (!fb) return res.status(404).json({ erro: 'Feedback não encontrado' });

    const perf = req.usuario.perfil;
    const ehAdmin = perf === 'admin' || perf === 'gestor';
    if (!ehAdmin && fb.de_usuario_id !== req.usuario.id)
      return res.status(403).json({ erro: 'Sem permissão para remover este feedback' });

    await run('DELETE FROM feedbacks WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
