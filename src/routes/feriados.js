const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// Tipos que entram automaticamente confirmados
const TIPOS_AUTO_CONFIRMADOS = ['nacional', 'estadual'];

router.get('/', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM feriados WHERE empresa_id = ? AND ativo = 1`,
      [req.usuario.empresa_id]
    );

    const hoje = new Date();
    const anoAtual = hoje.getFullYear();
    rows.forEach(f => {
      if (f.recorrente) {
        const [_ano, mes, dia] = f.data.split('-');
        let dataEsteAno = new Date(`${anoAtual}-${mes}-${dia}`);
        if (dataEsteAno < hoje) dataEsteAno = new Date(`${anoAtual + 1}-${mes}-${dia}`);
        f.data_exibicao = dataEsteAno.toISOString().slice(0, 10);
      } else {
        f.data_exibicao = f.data;
      }
    });
    rows.sort((a, b) => a.data_exibicao.localeCompare(b.data_exibicao));

    res.json(rows);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao buscar feriados' });
  }
});

router.post('/', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, data, tipo, recorrente, observacao } = req.body;
    if (!nome || !data) return res.status(400).json({ erro: 'Nome e data são obrigatórios' });

    const tipoFinal = tipo || 'nacional';
    const validacao = TIPOS_AUTO_CONFIRMADOS.includes(tipoFinal) ? 'confirmado' : 'pendente';

    const id = uuidv4();
    await run(
      `INSERT INTO feriados (id, empresa_id, nome, data, tipo, recorrente, observacao, validacao) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.usuario.empresa_id, nome, data, tipoFinal, recorrente !== undefined ? (recorrente ? 1 : 0) : 1, observacao || null, validacao]
    );
    const novo = await get(`SELECT * FROM feriados WHERE id = ?`, [id]);
    res.status(201).json(novo);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao criar feriado' });
  }
});

router.put('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const existente = await get(`SELECT id FROM feriados WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Feriado não encontrado' });

    const { nome, data, tipo, recorrente, observacao } = req.body;
    const tipoFinal = tipo || 'nacional';

    // Se mudou para tipo auto-confirmado, atualiza validação automaticamente
    const validacaoAuto = TIPOS_AUTO_CONFIRMADOS.includes(tipoFinal) ? 'confirmado' : null;

    if (validacaoAuto) {
      await run(
        `UPDATE feriados SET nome = ?, data = ?, tipo = ?, recorrente = ?, observacao = ?, validacao = ? WHERE id = ?`,
        [nome, data, tipoFinal, recorrente !== undefined ? (recorrente ? 1 : 0) : 1, observacao || null, validacaoAuto, req.params.id]
      );
    } else {
      await run(
        `UPDATE feriados SET nome = ?, data = ?, tipo = ?, recorrente = ?, observacao = ? WHERE id = ?`,
        [nome, data, tipoFinal, recorrente !== undefined ? (recorrente ? 1 : 0) : 1, observacao || null, req.params.id]
      );
    }

    const atualizado = await get(`SELECT * FROM feriados WHERE id = ?`, [req.params.id]);
    res.json(atualizado);
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao atualizar feriado' });
  }
});

// PATCH /:id/validar — confirma ou rejeita o feriado
router.patch('/:id/validar', autenticar, async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { validacao } = req.body; // 'confirmado' ou 'rejeitado'
    if (!['confirmado', 'rejeitado'].includes(validacao)) return res.status(400).json({ erro: 'Validação inválida' });

    const existente = await get(`SELECT id FROM feriados WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Feriado não encontrado' });

    await run(`UPDATE feriados SET validacao = ? WHERE id = ?`, [validacao, req.params.id]);
    res.json({ ok: true, validacao });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao validar feriado' });
  }
});

router.delete('/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const existente = await get(`SELECT id FROM feriados WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!existente) return res.status(404).json({ erro: 'Feriado não encontrado' });
    await run(`UPDATE feriados SET ativo = 0 WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Feriado removido com sucesso' });
  } catch (err) {
    res.status(500).json({ erro: 'Erro ao remover feriado' });
  }
});

module.exports = router;
