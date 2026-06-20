const express = require('express');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
router.use(autenticar);

// Listar todos os itens do usuário logado
router.get('/', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM agenda_itens WHERE empresa_id=? AND usuario_id=? ORDER BY data_hora ASC`,
      [req.usuario.empresa_id, req.usuario.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Itens que já chegaram a hora (ou estão atrasados) e ainda não foram resolvidos —
// usado pelo notificador. Continuam aparecendo até o usuário marcar feito ou reagendar.
router.get('/proximos', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM agenda_itens
       WHERE empresa_id=? AND usuario_id=? AND status='pendente'
         AND data_hora <= TO_CHAR(NOW() - INTERVAL '3 hours' + INTERVAL '1 minute', 'YYYY-MM-DD HH24:MI:SS')
       ORDER BY data_hora ASC`,
      [req.usuario.empresa_id, req.usuario.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar
router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, data_hora } = req.body;
    if (!titulo?.trim() || !data_hora) return res.status(400).json({ erro: 'Título e data/hora são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO agenda_itens (id, empresa_id, usuario_id, titulo, descricao, data_hora)
       VALUES (?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, req.usuario.id, titulo.trim(), descricao || null, data_hora]
    );
    res.status(201).json(await get(`SELECT * FROM agenda_itens WHERE id=?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar
router.put('/:id', async (req, res) => {
  try {
    const existe = await get(`SELECT id FROM agenda_itens WHERE id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    if (!existe) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, data_hora, status } = req.body;
    await run(
      `UPDATE agenda_itens SET titulo=?, descricao=?, data_hora=?, status=? WHERE id=?`,
      [titulo, descricao || null, data_hora, status || 'pendente', req.params.id]
    );
    res.json(await get(`SELECT * FROM agenda_itens WHERE id=?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Concluir
router.post('/:id/concluir', async (req, res) => {
  try {
    await run(`UPDATE agenda_itens SET status='concluido' WHERE id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Adiar / reagendar — aceita uma nova data/hora absoluta (data_hora) OU X minutos
router.post('/:id/adiar', async (req, res) => {
  try {
    const existe = await get(`SELECT id FROM agenda_itens WHERE id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    if (!existe) return res.status(404).json({ erro: 'Não encontrado' });

    const { data_hora, minutos } = req.body;

    if (data_hora) {
      // Reagendar para uma data/hora específica escolhida pelo usuário
      if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(data_hora)) {
        return res.status(400).json({ erro: 'Data/hora inválida' });
      }
      const dh = data_hora.replace('T', ' ').slice(0, 19);
      await run(`UPDATE agenda_itens SET status='pendente', data_hora=? WHERE id=?`, [dh, req.params.id]);
      return res.json(await get(`SELECT * FROM agenda_itens WHERE id=?`, [req.params.id]));
    }

    const mins = parseInt(minutos, 10);
    if (!mins || mins < 1 || mins > 10080) return res.status(400).json({ erro: 'Informe a nova data/hora ou os minutos para adiar' });
    await run(
      `UPDATE agenda_itens SET status='pendente',
         data_hora=TO_CHAR(data_hora::timestamp + (? || ' minutes')::INTERVAL, 'YYYY-MM-DD HH24:MI:SS')
       WHERE id=?`,
      [String(mins), req.params.id]
    );
    res.json(await get(`SELECT * FROM agenda_itens WHERE id=?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir
router.delete('/:id', async (req, res) => {
  try {
    await run(`DELETE FROM agenda_itens WHERE id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
