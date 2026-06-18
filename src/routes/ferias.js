const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const BASE_SELECT = `
  SELECT f.*, u.nome AS colaborador_nome, d.nome AS departamento_nome, a.nome AS aprovador_nome
  FROM ferias f
  JOIN usuarios u ON u.id = f.usuario_id
  LEFT JOIN departamentos d ON d.id = u.departamento_id
  LEFT JOIN usuarios a ON a.id = f.aprovado_por
`;

function calcDias(d1, d2) {
  return Math.ceil((new Date(d2) - new Date(d1)) / 86400000) + 1;
}

router.get('/', autenticar, async (req, res) => {
  try {
    const { ano, usuario_id, departamento_id, status } = req.query;
    let sql = BASE_SELECT + ` WHERE f.empresa_id = ?`;
    const params = [req.usuario.empresa_id];

    if (ano) {
      sql += ` AND (substr(f.data_inicio,1,4) = ? OR substr(f.data_fim,1,4) = ?)`;
      params.push(ano, ano);
    }
    if (usuario_id) { sql += ` AND f.usuario_id = ?`; params.push(usuario_id); }
    if (departamento_id) { sql += ` AND u.departamento_id = ?`; params.push(departamento_id); }
    if (status) { sql += ` AND f.status = ?`; params.push(status); }

    sql += ` ORDER BY f.data_inicio DESC`;
    res.json(await all(sql, params));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao buscar férias' });
  }
});

router.post('/', autenticar, async (req, res) => {
  try {
    const { usuario_id, data_inicio, data_fim, tipo, observacoes } = req.body;
    if (!usuario_id || !data_inicio || !data_fim)
      return res.status(400).json({ erro: 'Colaborador, data início e data fim são obrigatórios' });

    const id = uuidv4();
    const dias = calcDias(data_inicio, data_fim);
    await run(
      `INSERT INTO ferias (id,empresa_id,usuario_id,data_inicio,data_fim,dias,tipo,status,observacoes,created_by)
       VALUES (?,?,?,?,?,?,?,'solicitado',?,?)`,
      [id, req.usuario.empresa_id, usuario_id, data_inicio, data_fim, dias, tipo || 'ferias', observacoes || null, req.usuario.id]
    );
    const nova = await get(BASE_SELECT + ` WHERE f.id = ?`, [id]);
    res.status(201).json(nova);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao criar férias' });
  }
});

router.put('/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM ferias WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });

    const { usuario_id, data_inicio, data_fim, tipo, status, observacoes } = req.body;
    const dias = calcDias(data_inicio, data_fim);
    await run(
      `UPDATE ferias SET usuario_id=?,data_inicio=?,data_fim=?,dias=?,tipo=?,status=?,observacoes=? WHERE id=?`,
      [usuario_id, data_inicio, data_fim, dias, tipo || 'ferias', status || 'solicitado', observacoes || null, req.params.id]
    );
    res.json(await get(BASE_SELECT + ` WHERE f.id = ?`, [req.params.id]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao atualizar férias' });
  }
});

router.patch('/:id/status', autenticar, async (req, res) => {
  try {
    const { status } = req.body;
    const exist = await get(`SELECT id FROM ferias WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });

    const aprovadoPor = ['aprovado', 'rejeitado'].includes(status) ? req.usuario.id : null;
    await run(`UPDATE ferias SET status=?, aprovado_por=? WHERE id=?`, [status, aprovadoPor, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao atualizar status' });
  }
});

router.delete('/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM ferias WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM ferias WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: 'Erro ao excluir férias' });
  }
});

module.exports = router;
