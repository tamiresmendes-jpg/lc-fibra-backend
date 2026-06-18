const express = require('express');
const { all, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

router.get('/', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });

    const { modulo, acao, usuario_id, data_inicio, data_fim, limit: lim, offset: off } = req.query;
    const params = [eid(req)];
    let where = 'WHERE empresa_id = $1';

    if (modulo)      { params.push(modulo);      where += ` AND modulo = $${params.length}`; }
    if (acao)        { params.push(acao);         where += ` AND acao = $${params.length}`; }
    if (usuario_id)  { params.push(usuario_id);   where += ` AND usuario_id = $${params.length}`; }
    if (data_inicio) { params.push(data_inicio);  where += ` AND created_at >= $${params.length}`; }
    if (data_fim)    { params.push(data_fim + ' 23:59:59'); where += ` AND created_at <= $${params.length}`; }

    const limite  = Math.min(parseInt(lim)  || 100, 500);
    const offset  = parseInt(off) || 0;
    params.push(limite, offset);

    const logs = await all(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const total = await get(`SELECT COUNT(*) as t FROM audit_log ${where}`, params.slice(0, -2));

    res.json({ logs, total: parseInt(total?.t || 0) });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Usuários que fizeram alterações (para filtro)
router.get('/usuarios', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const rows = await all(
      `SELECT DISTINCT usuario_id, usuario_nome, perfil FROM audit_log WHERE empresa_id = $1 ORDER BY usuario_nome`,
      [eid(req)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
