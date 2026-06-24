const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);
function eid(req) { return req.usuario.empresa_id; }

// Listar escalas
router.get('/', async (req, res) => {
  try {
    const { mes, ano, departamento_id } = req.query;
    let sql = `SELECT e.*, d.nome as departamento_nome
               FROM escalas e
               LEFT JOIN departamentos d ON d.id = e.departamento_id
               WHERE e.empresa_id = ?`;
    const params = [eid(req)];
    if (mes) { sql += ' AND e.mes = ?'; params.push(Number(mes)); }
    if (ano) { sql += ' AND e.ano = ?'; params.push(Number(ano)); }
    if (departamento_id) { sql += ' AND e.departamento_id = ?'; params.push(departamento_id); }
    sql += ' ORDER BY e.ano DESC, e.mes DESC';
    res.json(await all(sql, params));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Buscar escala com slots e feriados
router.get('/:id', async (req, res) => {
  try {
    const escala = await get(
      `SELECT e.*, d.nome as departamento_nome
       FROM escalas e LEFT JOIN departamentos d ON d.id = e.departamento_id
       WHERE e.id = ? AND e.empresa_id = ?`,
      [req.params.id, eid(req)]
    );
    if (!escala) return res.status(404).json({ erro: 'Não encontrada' });

    const slots = await all(
      `SELECT s.*, u.nome as usuario_nome
       FROM escala_slots s LEFT JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.escala_id = ?`,
      [req.params.id]
    );
    const feriados = await all(
      `SELECT * FROM escala_feriados_def WHERE escala_id = ? ORDER BY dia`,
      [req.params.id]
    );
    res.json({ ...escala, slots, feriados });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar ou recuperar escala existente
router.post('/', async (req, res) => {
  try {
    const { departamento_id, mes, ano, colaboradores } = req.body;
    const existente = await get(
      `SELECT * FROM escalas WHERE empresa_id=? AND departamento_id=? AND mes=? AND ano=?`,
      [eid(req), departamento_id || null, Number(mes), Number(ano)]
    );
    if (existente) return res.json(existente);

    const id = uuidv4();
    await run(
      `INSERT INTO escalas (id, empresa_id, departamento_id, mes, ano, criado_por, colaboradores)
       VALUES (?,?,?,?,?,?,?)`,
      [id, eid(req), departamento_id || null, Number(mes), Number(ano),
       req.usuario.id, colaboradores ? JSON.stringify(colaboradores) : null]
    );
    res.status(201).json(await get(
      `SELECT e.*, d.nome as departamento_nome FROM escalas e
       LEFT JOIN departamentos d ON d.id = e.departamento_id WHERE e.id = ?`,
      [id]
    ));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar lista de colaboradores
router.patch('/:id', async (req, res) => {
  try {
    const { colaboradores } = req.body;
    await run(
      `UPDATE escalas SET colaboradores = ? WHERE id = ? AND empresa_id = ?`,
      [colaboradores ? JSON.stringify(colaboradores) : null, req.params.id, eid(req)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Salvar slot (upsert)
router.put('/:id/slot', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });

    const { secao, dia, turno, posicao, usuario_id } = req.body;
    const turnoVal = turno || null;

    const existing = await get(
      `SELECT id FROM escala_slots
       WHERE escala_id=? AND secao=? AND dia=? AND COALESCE(turno,'')=COALESCE(?,'') AND posicao=?`,
      [req.params.id, secao, dia, turnoVal, posicao]
    );

    if (existing) {
      if (usuario_id) {
        await run('UPDATE escala_slots SET usuario_id=? WHERE id=?', [usuario_id, existing.id]);
      } else {
        await run('DELETE FROM escala_slots WHERE id=?', [existing.id]);
      }
    } else if (usuario_id) {
      await run(
        `INSERT INTO escala_slots (id,escala_id,secao,dia,turno,posicao,usuario_id) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), req.params.id, secao, dia, turnoVal, posicao, usuario_id]
      );
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Adicionar feriado
router.post('/:id/feriados', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const { dia, nome } = req.body;
    if (!dia || !nome) return res.status(400).json({ erro: 'Dia e nome obrigatórios' });
    const id = uuidv4();
    await run('INSERT INTO escala_feriados_def (id,escala_id,dia,nome) VALUES (?,?,?,?)',
      [id, req.params.id, parseInt(dia), nome]);
    res.status(201).json({ id, escala_id: req.params.id, dia: parseInt(dia), nome });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Remover feriado
router.delete('/:id/feriados/:fid', async (req, res) => {
  try {
    await run('DELETE FROM escala_feriados_def WHERE id=? AND escala_id=?', [req.params.fid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir escala
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM escala_slots WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM escala_feriados_def WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
