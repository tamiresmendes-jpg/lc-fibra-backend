const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

router.get('/', async (req, res) => {
  try {
    const fornecedores = await all(
      'SELECT * FROM fornecedores WHERE empresa_id = $1 ORDER BY nome',
      [req.usuario.empresa_id]
    );
    res.json(fornecedores.map(f => ({ ...f, emails_remetentes: JSON.parse(f.emails_remetentes || '[]') })));
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, cnpj, emails_remetentes } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      'INSERT INTO fornecedores (id, empresa_id, nome, cnpj, emails_remetentes) VALUES ($1,$2,$3,$4,$5)',
      [id, req.usuario.empresa_id, nome, cnpj || null, JSON.stringify(emails_remetentes || [])]
    );
    res.status(201).json({ id, nome });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, cnpj, emails_remetentes, ativo } = req.body;
    await run(
      'UPDATE fornecedores SET nome=$1, cnpj=$2, emails_remetentes=$3, ativo=$4 WHERE id=$5 AND empresa_id=$6',
      [nome, cnpj || null, JSON.stringify(emails_remetentes || []), ativo === false ? 0 : 1, req.params.id, req.usuario.empresa_id]
    );
    res.json({ mensagem: 'Fornecedor atualizado' });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const emUso = await get('SELECT id FROM contas_pagar_fornecedores WHERE fornecedor_id = $1', [req.params.id]);
    if (emUso) return res.status(400).json({ erro: 'Fornecedor possui contas a pagar vinculadas — desative em vez de excluir.' });
    await run('DELETE FROM fornecedores WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Fornecedor excluído' });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;
