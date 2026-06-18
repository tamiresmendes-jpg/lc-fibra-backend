const express = require('express');
const { run, get } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// GET — dados da empresa
router.get('/', async (req, res) => {
  try {
    const empresa = await get('SELECT id, nome, cnpj, logo, cor_primaria FROM empresas WHERE id = $1', [req.usuario.empresa_id]);
    res.json(empresa || {});
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT — atualiza dados da empresa (apenas admin)
router.put('/', async (req, res) => {
  try {
    if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Apenas administrador' });
    const { nome, cnpj, logo, cor_primaria } = req.body;
    await run(
      'UPDATE empresas SET nome = $1, cnpj = $2, logo = $3, cor_primaria = $4 WHERE id = $5',
      [nome || null, cnpj || null, logo || null, cor_primaria || '#7B55F1', req.usuario.empresa_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
