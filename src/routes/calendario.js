const express = require('express');
const { all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// GET /api/calendario?mes=YYYY-MM
router.get('/', async (req, res) => {
  try {
    const mes = (req.query.mes || '').slice(0, 7) || new Date().toISOString().slice(0, 7);
    const mesMM = mes.slice(5, 7); // mês "MM" para feriados recorrentes
    const eid = req.usuario.empresa_id;
    const uid = req.usuario.id;
    const safe = async (fn) => { try { return await fn(); } catch { return []; } };

    const [agenda, reunioes, eventos, coffeeBreaks, ferias, feriados, avisos] = await Promise.all([
      safe(() => all(
        `SELECT id, titulo, descricao, data_hora as data, NULL as data_fim, 'agenda' as tipo
         FROM agenda_itens
         WHERE empresa_id=? AND usuario_id=? AND status='pendente' AND substr(data_hora,1,7)=?
         ORDER BY data_hora`,
        [eid, uid, mes]
      )),
      safe(() => all(
        `SELECT id, titulo, tipo as subtipo, data_reuniao as data, NULL as data_fim, local, status, 'reuniao' as tipo
         FROM reunioes
         WHERE empresa_id=? AND status='agendada' AND substr(data_reuniao,1,7)=?
         ORDER BY data_reuniao`,
        [eid, mes]
      )),
      safe(() => all(
        `SELECT id, titulo, descricao, data_inicio as data, data_fim, local, 'evento' as tipo
         FROM cultura_eventos
         WHERE empresa_id=? AND (substr(data_inicio,1,7)=? OR substr(data_fim,1,7)=?)
         ORDER BY data_inicio`,
        [eid, mes, mes]
      )),
      safe(() => all(
        `SELECT id, titulo, unidade, cidade, data, NULL as data_fim, 'coffee' as tipo
         FROM coffee_breaks
         WHERE empresa_id=? AND ativo=1 AND substr(data,1,7)=?
         ORDER BY data`,
        [eid, mes]
      )),
      safe(() => all(
        `SELECT f.id, u.nome as titulo, f.data_inicio as data, f.data_fim, f.status as subtipo, 'ferias' as tipo
         FROM ferias f JOIN usuarios u ON u.id=f.usuario_id
         WHERE f.empresa_id=? AND (substr(f.data_inicio,1,7)=? OR substr(f.data_fim,1,7)=?)
         ORDER BY f.data_inicio`,
        [eid, mes, mes]
      )),
      safe(() => all(
        `SELECT id, nome as titulo, observacao as descricao, data, NULL as data_fim, tipo as subtipo, 'feriado' as tipo
         FROM feriados
         WHERE empresa_id=? AND ativo=1 AND (substr(data,1,7)=? OR (recorrente=1 AND substr(data,6,2)=?))
         ORDER BY data`,
        [eid, mes, mesMM]
      )),
      safe(() => all(
        `SELECT id, titulo, conteudo as descricao,
                COALESCE(data_publicacao, data_programada, data_inicio) as data,
                NULL as data_fim, tipo as subtipo, 'aviso' as tipo
         FROM comunicados
         WHERE empresa_id=? AND ativo=1
           AND substr(COALESCE(data_publicacao, data_programada, data_inicio),1,7)=?
         ORDER BY data`,
        [eid, mes]
      )),
    ]);

    res.json({ agenda, reunioes, eventos, coffeeBreaks, ferias, feriados, avisos });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
