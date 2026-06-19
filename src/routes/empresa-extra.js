const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── TELEFONES ────────────────────────────────────────────────────────────────
router.get('/telefones', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM empresa_telefones WHERE empresa_id = ? ORDER BY departamento, descricao`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar telefones' }); }
});

router.post('/telefones', autenticar, async (req, res) => {
  try {
    const { descricao, numero, ramal, whatsapp, departamento, observacao } = req.body;
    if (!descricao || !numero) return res.status(400).json({ erro: 'Descrição e número são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO empresa_telefones (id,empresa_id,descricao,numero,ramal,whatsapp,departamento,observacao) VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, descricao, numero, ramal || null, whatsapp ? 1 : 0, departamento || null, observacao || null]
    );
    res.status(201).json(await get(`SELECT * FROM empresa_telefones WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar telefone' }); }
});

router.put('/telefones/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM empresa_telefones WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { descricao, numero, ramal, whatsapp, departamento, observacao } = req.body;
    await run(
      `UPDATE empresa_telefones SET descricao=?,numero=?,ramal=?,whatsapp=?,departamento=?,observacao=? WHERE id=?`,
      [descricao, numero, ramal || null, whatsapp ? 1 : 0, departamento || null, observacao || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM empresa_telefones WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar telefone' }); }
});

router.delete('/telefones/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM empresa_telefones WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM empresa_telefones WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir telefone' }); }
});

// ── CONTATOS ─────────────────────────────────────────────────────────────────
router.get('/contatos', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM empresa_contatos WHERE empresa_id = ? ORDER BY nome`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar contatos' }); }
});

router.post('/contatos', autenticar, async (req, res) => {
  try {
    const { nome, cargo, email, telefone, whatsapp, departamento, observacao, foto, fixo } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO empresa_contatos (id,empresa_id,nome,cargo,email,telefone,whatsapp,departamento,observacao,foto,fixo) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, nome, cargo || null, email || null, telefone || null, whatsapp || null, departamento || null, observacao || null, foto || null, fixo ? 1 : 0]
    );
    res.status(201).json(await get(`SELECT * FROM empresa_contatos WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar contato' }); }
});

router.put('/contatos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM empresa_contatos WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { nome, cargo, email, telefone, whatsapp, departamento, observacao, foto, fixo } = req.body;
    await run(
      `UPDATE empresa_contatos SET nome=?,cargo=?,email=?,telefone=?,whatsapp=?,departamento=?,observacao=?,foto=?,fixo=? WHERE id=?`,
      [nome, cargo || null, email || null, telefone || null, whatsapp || null, departamento || null, observacao || null, foto !== undefined ? foto : exist.foto, fixo !== undefined ? (fixo ? 1 : 0) : exist.fixo, req.params.id]
    );
    res.json(await get(`SELECT * FROM empresa_contatos WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar contato' }); }
});

router.delete('/contatos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM empresa_contatos WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM empresa_contatos WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir contato' }); }
});

// ── HORÁRIOS ─────────────────────────────────────────────────────────────────
router.get('/horarios', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM empresa_horarios WHERE empresa_id = ? ORDER BY unidade, dia_semana`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar horários' }); }
});

router.post('/horarios', autenticar, async (req, res) => {
  try {
    const { unidade, periodo, tipo_atendimento, hora_abertura, hora_fechamento, fechado, hora_abertura2, hora_fechamento2, fechado2, observacao } = req.body;
    const id = uuidv4();
    await run(
      `INSERT INTO empresa_horarios (id,empresa_id,unidade,dia_semana,periodo,tipo_atendimento,hora_abertura,hora_fechamento,fechado,hora_abertura2,hora_fechamento2,fechado2,observacao) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, unidade || 'Sede', 0, periodo || 'seg', tipo_atendimento || 'presencial', hora_abertura || null, hora_fechamento || null, fechado ? 1 : 0, hora_abertura2 || null, hora_fechamento2 || null, fechado2 ? 1 : 0, observacao || null]
    );
    res.status(201).json(await get(`SELECT * FROM empresa_horarios WHERE id = ?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar horário' }); }
});

router.put('/horarios/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM empresa_horarios WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { unidade, periodo, tipo_atendimento, hora_abertura, hora_fechamento, fechado, hora_abertura2, hora_fechamento2, fechado2, observacao } = req.body;
    await run(
      `UPDATE empresa_horarios SET unidade=?,periodo=?,tipo_atendimento=?,hora_abertura=?,hora_fechamento=?,fechado=?,hora_abertura2=?,hora_fechamento2=?,fechado2=?,observacao=? WHERE id=?`,
      [unidade || 'Sede', periodo || 'seg', tipo_atendimento || 'presencial', hora_abertura || null, hora_fechamento || null, fechado ? 1 : 0, hora_abertura2 || null, hora_fechamento2 || null, fechado2 ? 1 : 0, observacao || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM empresa_horarios WHERE id = ?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar horário' }); }
});

router.delete('/horarios/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM empresa_horarios WHERE id = ? AND empresa_id = ?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM empresa_horarios WHERE id = ?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir horário' }); }
});

// ── LOCALIZAÇÃO ──────────────────────────────────────────────────────────────
// Usa a tabela `unidades` já existente com endereço completo
router.get('/localizacoes', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM unidades WHERE empresa_id = ? AND ativo = 1 ORDER BY nome`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar localizações' }); }
});

module.exports = router;
