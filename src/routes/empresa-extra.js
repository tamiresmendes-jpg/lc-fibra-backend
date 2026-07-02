const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// ── TELEFONES ────────────────────────────────────────────────────────────────
router.get('/telefones', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM empresa_telefones WHERE empresa_id = $1 ORDER BY departamento, descricao`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar telefones' }); }
});

router.post('/telefones', autenticar, async (req, res) => {
  if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
  try {
    const { descricao, numero, ramal, whatsapp, departamento, observacao } = req.body;
    if (!descricao || !numero) return res.status(400).json({ erro: 'Descrição e número são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO empresa_telefones (id,empresa_id,descricao,numero,ramal,whatsapp,departamento,observacao) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.usuario.empresa_id, descricao, numero, ramal || null, whatsapp ? true : false, departamento || null, observacao || null]
    );
    res.status(201).json(await get(`SELECT * FROM empresa_telefones WHERE id = $1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar telefone' }); }
});

router.put('/telefones/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM empresa_telefones WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { descricao, numero, ramal, whatsapp, departamento, observacao } = req.body;
    await run(
      `UPDATE empresa_telefones SET descricao=$1,numero=$2,ramal=$3,whatsapp=$4,departamento=$5,observacao=$6 WHERE id=$7`,
      [descricao, numero, ramal || null, whatsapp ? true : false, departamento || null, observacao || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM empresa_telefones WHERE id = $1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar telefone' }); }
});

router.delete('/telefones/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM empresa_telefones WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM empresa_telefones WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir telefone' }); }
});

// ── CONTATOS ─────────────────────────────────────────────────────────────────
router.get('/contatos', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM empresa_contatos WHERE empresa_id = $1 ORDER BY nome`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar contatos' }); }
});

router.post('/contatos', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, cargo, email, telefone, whatsapp, departamento, observacao, foto, fixo } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO empresa_contatos (id,empresa_id,nome,cargo,email,telefone,whatsapp,departamento,observacao,foto,fixo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, req.usuario.empresa_id, nome, cargo || null, email || null, telefone || null, whatsapp || null, departamento || null, observacao || null, foto || null, fixo ? true : false]
    );
    res.status(201).json(await get(`SELECT * FROM empresa_contatos WHERE id = $1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar contato' }); }
});

router.put('/contatos/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM empresa_contatos WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { nome, cargo, email, telefone, whatsapp, departamento, observacao, foto, fixo } = req.body;
    await run(
      `UPDATE empresa_contatos SET nome=$1,cargo=$2,email=$3,telefone=$4,whatsapp=$5,departamento=$6,observacao=$7,foto=$8,fixo=$9 WHERE id=$10`,
      [nome, cargo || null, email || null, telefone || null, whatsapp || null, departamento || null, observacao || null, foto !== undefined ? foto : exist.foto, fixo !== undefined ? (fixo ? true : false) : exist.fixo, req.params.id]
    );
    res.json(await get(`SELECT * FROM empresa_contatos WHERE id = $1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar contato' }); }
});

router.delete('/contatos/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM empresa_contatos WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM empresa_contatos WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir contato' }); }
});

// ── HORÁRIOS ─────────────────────────────────────────────────────────────────
router.get('/horarios', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM empresa_horarios WHERE empresa_id = $1 ORDER BY unidade, dia_semana`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar horários' }); }
});

router.post('/horarios', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { unidade, periodo, tipo_atendimento, hora_abertura, hora_fechamento, fechado, hora_abertura2, hora_fechamento2, fechado2, observacao } = req.body;
    const id = uuidv4();
    await run(
      `INSERT INTO empresa_horarios (id,empresa_id,unidade,dia_semana,periodo,tipo_atendimento,hora_abertura,hora_fechamento,fechado,hora_abertura2,hora_fechamento2,fechado2,observacao) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, req.usuario.empresa_id, unidade || 'Sede', 0, periodo || 'seg', tipo_atendimento || 'presencial', hora_abertura || null, hora_fechamento || null, fechado ? true : false, hora_abertura2 || null, hora_fechamento2 || null, fechado2 ? true : false, observacao || null]
    );
    res.status(201).json(await get(`SELECT * FROM empresa_horarios WHERE id = $1`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar horário' }); }
});

router.put('/horarios/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM empresa_horarios WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { unidade, periodo, tipo_atendimento, hora_abertura, hora_fechamento, fechado, hora_abertura2, hora_fechamento2, fechado2, observacao } = req.body;
    await run(
      `UPDATE empresa_horarios SET unidade=$1,periodo=$2,tipo_atendimento=$3,hora_abertura=$4,hora_fechamento=$5,fechado=$6,hora_abertura2=$7,hora_fechamento2=$8,fechado2=$9,observacao=$10 WHERE id=$11`,
      [unidade || 'Sede', periodo || 'seg', tipo_atendimento || 'presencial', hora_abertura || null, hora_fechamento || null, fechado ? true : false, hora_abertura2 || null, hora_fechamento2 || null, fechado2 ? true : false, observacao || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM empresa_horarios WHERE id = $1`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar horário' }); }
});

router.delete('/horarios/:id', autenticar, async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const exist = await get(`SELECT id FROM empresa_horarios WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM empresa_horarios WHERE id = $1 AND empresa_id = $2`, [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir horário' }); }
});

// ── LOCALIZAÇÃO ──────────────────────────────────────────────────────────────
// Usa a tabela `unidades` já existente com endereço completo
router.get('/localizacoes', autenticar, async (req, res) => {
  try {
    res.json(await all(`SELECT * FROM unidades WHERE empresa_id = $1 AND ativo = true ORDER BY nome`, [req.usuario.empresa_id]));
  } catch { res.status(500).json({ erro: 'Erro ao buscar localizações' }); }
});

module.exports = router;
