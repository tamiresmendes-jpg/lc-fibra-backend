const express = require('express');
const bcrypt = require('bcryptjs');
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

// POST /empresa/verificar-chave — verifica a chave de proteção do nome do sistema
router.post('/verificar-chave', async (req, res) => {
  try {
    if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Apenas administrador' });
    const { chave } = req.body;
    if (!chave) return res.status(400).json({ erro: 'Informe a chave' });
    const empresa = await get('SELECT chave_sistema FROM empresas WHERE id = ?', [req.usuario.empresa_id]);
    if (!empresa?.chave_sistema) {
      // Primeira vez — chave ainda não configurada, libera acesso para definição
      return res.json({ ok: true, primeira_vez: true });
    }
    const ok = bcrypt.compareSync(chave, empresa.chave_sistema);
    if (!ok) return res.status(401).json({ erro: 'Chave incorreta' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// PUT /empresa/chave — define ou altera a chave de proteção
router.put('/chave', async (req, res) => {
  try {
    if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Apenas administrador' });
    const { chave_atual, nova_chave } = req.body;
    if (!nova_chave || nova_chave.length < 6) return res.status(400).json({ erro: 'A chave deve ter ao menos 6 caracteres' });
    const empresa = await get('SELECT chave_sistema FROM empresas WHERE id = ?', [req.usuario.empresa_id]);
    if (empresa?.chave_sistema) {
      if (!chave_atual || !bcrypt.compareSync(chave_atual, empresa.chave_sistema))
        return res.status(401).json({ erro: 'Chave atual incorreta' });
    }
    const hash = bcrypt.hashSync(nova_chave, 10);
    await run('UPDATE empresas SET chave_sistema = ? WHERE id = ?', [hash, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
