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
    let sql = `SELECT e.*, d.nome as departamento_nome, u.nome as criador_nome
               FROM escalas e
               LEFT JOIN departamentos d ON d.id = e.departamento_id
               LEFT JOIN usuarios u ON u.id = e.criado_por
               WHERE e.empresa_id = ?`;
    const params = [eid(req)];
    if (mes) { sql += ' AND e.mes = ?'; params.push(Number(mes)); }
    if (ano) { sql += ' AND e.ano = ?'; params.push(Number(ano)); }
    if (departamento_id) { sql += ' AND e.departamento_id = ?'; params.push(departamento_id); }
    sql += ' ORDER BY e.ano DESC, e.mes DESC';
    res.json(await all(sql, params));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Buscar escala com dias
router.get('/:id', async (req, res) => {
  try {
    const escala = await get('SELECT * FROM escalas WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Não encontrada' });
    const dias = await all('SELECT * FROM escala_dias WHERE escala_id = ?', [req.params.id]);
    res.json({ ...escala, dias });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar ou buscar escala do mês/depto
router.post('/', async (req, res) => {
  try {
    const { mes, ano, departamento_id, titulo } = req.body;
    // Verifica se já existe
    const existente = await get('SELECT * FROM escalas WHERE empresa_id=? AND departamento_id=? AND mes=? AND ano=?',
      [eid(req), departamento_id || null, Number(mes), Number(ano)]);
    if (existente) return res.json(existente);
    const id = uuidv4();
    await run('INSERT INTO escalas (id,empresa_id,departamento_id,mes,ano,titulo,criado_por) VALUES (?,?,?,?,?,?,?)',
      [id, eid(req), departamento_id || null, Number(mes), Number(ano), titulo || null, req.usuario.id]);
    res.json({ id, mes, ano, departamento_id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Salvar dia de um colaborador
router.put('/:id/dias', async (req, res) => {
  try {
    const { usuario_id, dia, tipo, turno, observacao } = req.body;
    // Verifica se a escala pertence à empresa
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const existing = await get('SELECT id FROM escala_dias WHERE escala_id=? AND usuario_id=? AND dia=?',
      [req.params.id, usuario_id, dia]);
    if (existing) {
      await run('UPDATE escala_dias SET tipo=?,turno=?,observacao=? WHERE id=?',
        [tipo, turno||'dia', observacao||null, existing.id]);
    } else {
      await run('INSERT INTO escala_dias (id,escala_id,usuario_id,dia,tipo,turno,observacao) VALUES (?,?,?,?,?,?,?)',
        [uuidv4(), req.params.id, usuario_id, dia, tipo||'trabalho', turno||'dia', observacao||null]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Salvar múltiplos dias de uma vez (lote)
router.put('/:id/dias/lote', async (req, res) => {
  try {
    const { entradas } = req.body; // [{ usuario_id, dia, tipo, turno }]
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    for (const e of entradas) {
      const existing = await get('SELECT id FROM escala_dias WHERE escala_id=? AND usuario_id=? AND dia=?',
        [req.params.id, e.usuario_id, e.dia]);
      if (existing) {
        await run('UPDATE escala_dias SET tipo=?,turno=? WHERE id=?', [e.tipo||'trabalho', e.turno||'dia', existing.id]);
      } else {
        await run('INSERT INTO escala_dias (id,escala_id,usuario_id,dia,tipo,turno) VALUES (?,?,?,?,?,?)',
          [uuidv4(), req.params.id, e.usuario_id, e.dia, e.tipo||'trabalho', e.turno||'dia']);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Deletar escala
router.delete('/:id', async (req, res) => {
  try {
    await run('DELETE FROM escala_dias WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
