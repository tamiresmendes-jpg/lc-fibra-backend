const express = require('express');
const fs = require('fs');
const path = require('path');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { PASTA_ANEXOS } = require('../utils/emailFornecedoresSync');

const router = express.Router();
router.use(autenticar);

const STATUS_CALCULADO = `
  CASE WHEN c.status = 'aberto' AND c.vencimento < CURRENT_DATE THEN 'vencido' ELSE c.status END
`;

router.get('/', async (req, res) => {
  try {
    const { status, fornecedor_id, vencimento_de, vencimento_ate, busca } = req.query;
    const condicoes = ['c.empresa_id = $1'];
    const params = [req.usuario.empresa_id];

    if (status) { params.push(status); condicoes.push(`(${STATUS_CALCULADO}) = $${params.length}`); }
    if (fornecedor_id) { params.push(fornecedor_id); condicoes.push(`c.fornecedor_id = $${params.length}`); }
    if (vencimento_de) { params.push(vencimento_de); condicoes.push(`c.vencimento >= $${params.length}`); }
    if (vencimento_ate) { params.push(vencimento_ate); condicoes.push(`c.vencimento <= $${params.length}`); }
    if (busca) { params.push(`%${busca}%`); condicoes.push(`(c.numero_documento ILIKE $${params.length} OR c.descricao ILIKE $${params.length} OR f.nome ILIKE $${params.length})`); }

    const contas = await all(`
      SELECT c.*, f.nome AS fornecedor_nome,
             TO_CHAR(c.vencimento, 'DD/MM/YYYY') AS vencimento_fmt,
             TO_CHAR(c.data_pagamento, 'DD/MM/YYYY') AS data_pagamento_fmt,
             (${STATUS_CALCULADO}) AS status_calculado
      FROM contas_pagar_fornecedores c
      LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
      WHERE ${condicoes.join(' AND ')}
      ORDER BY c.vencimento ASC NULLS LAST, c.criado_em DESC
    `, params);

    const resumo = await get(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'aberto' AND vencimento >= CURRENT_DATE THEN valor END), 0) AS total_aberto,
        COALESCE(SUM(CASE WHEN status = 'aberto' AND vencimento < CURRENT_DATE THEN valor END), 0) AS total_vencido,
        COALESCE(SUM(CASE WHEN status = 'pago' AND date_trunc('month', data_pagamento) = date_trunc('month', CURRENT_DATE) THEN valor END), 0) AS total_pago_mes,
        COUNT(*) FILTER (WHERE status = 'pendente_revisao') AS total_pendente_revisao
      FROM contas_pagar_fornecedores WHERE empresa_id = $1
    `, [req.usuario.empresa_id]);

    res.json({ contas, resumo });
  } catch (e) { console.error(e); res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/:id', async (req, res) => {
  try {
    const conta = await get(`
      SELECT c.*, f.nome AS fornecedor_nome,
             TO_CHAR(c.vencimento, 'DD/MM/YYYY') AS vencimento_fmt,
             TO_CHAR(c.data_pagamento, 'DD/MM/YYYY') AS data_pagamento_fmt,
             (${STATUS_CALCULADO}) AS status_calculado
      FROM contas_pagar_fornecedores c
      LEFT JOIN fornecedores f ON f.id = c.fornecedor_id
      WHERE c.id = $1 AND c.empresa_id = $2
    `, [req.params.id, req.usuario.empresa_id]);
    if (!conta) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(conta);
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { fornecedor_id, tipo, numero_documento, descricao, valor, vencimento, status, observacoes } = req.body;
    const atual = await get('SELECT id FROM contas_pagar_fornecedores WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!atual) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`
      UPDATE contas_pagar_fornecedores SET
        fornecedor_id = $1, tipo = $2, numero_documento = $3, descricao = $4,
        valor = $5, vencimento = $6, status = $7, observacoes = $8, atualizado_em = NOW()
      WHERE id = $9 AND empresa_id = $10
    `, [
      fornecedor_id || null, tipo || 'boleto', numero_documento || null, descricao || null,
      valor || null, vencimento || null, status || 'aberto', observacoes || null,
      req.params.id, req.usuario.empresa_id,
    ]);
    res.json({ mensagem: 'Conta atualizada' });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/:id/pagar', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const dataPagamento = req.body.data_pagamento || new Date().toISOString().slice(0, 10);
    await run(
      `UPDATE contas_pagar_fornecedores SET status = 'pago', data_pagamento = $1, atualizado_em = NOW() WHERE id = $2 AND empresa_id = $3`,
      [dataPagamento, req.params.id, req.usuario.empresa_id]
    );
    res.json({ mensagem: 'Conta marcada como paga' });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.post('/:id/reabrir', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run(
      `UPDATE contas_pagar_fornecedores SET status = 'aberto', data_pagamento = NULL, atualizado_em = NOW() WHERE id = $1 AND empresa_id = $2`,
      [req.params.id, req.usuario.empresa_id]
    );
    res.json({ mensagem: 'Conta reaberta' });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.get('/:id/anexo', async (req, res) => {
  try {
    const conta = await get('SELECT arquivo_path FROM contas_pagar_fornecedores WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!conta || !conta.arquivo_path) return res.status(404).json({ erro: 'Anexo não encontrado' });
    const filePath = path.join(PASTA_ANEXOS, conta.arquivo_path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const conta = await get('SELECT arquivo_path FROM contas_pagar_fornecedores WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!conta) return res.status(404).json({ erro: 'Não encontrado' });
    if (conta.arquivo_path) {
      const filePath = path.join(PASTA_ANEXOS, conta.arquivo_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await run('DELETE FROM contas_pagar_fornecedores WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Conta excluída' });
  } catch (e) { res.status(500).json({ erro: 'Erro interno' }); }
});

module.exports = router;
