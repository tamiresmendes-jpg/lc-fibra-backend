const express = require('express');
const { all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// ─── Day off helpers (replica a lógica de frontend/src/utils/dayoff.js) ───────
const FERIADOS_NACIONAIS_MMDD = ['01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25'];
const FERIAS_VALIDAS_BD = ['aprovado','em_andamento','concluido'];

function ymdStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function isFeriadoLocal(dateStr, feriadosList) {
  const mmdd = dateStr.slice(5);
  if (FERIADOS_NACIONAIS_MMDD.includes(mmdd)) return true;
  return (feriadosList || []).some(f => {
    if (!f.data) return false;
    const fd = String(f.data).slice(0, 10);
    return f.recorrente ? fd.slice(5) === mmdd : fd === dateStr;
  });
}

function recuaLocal(d, feriadosList) {
  let t = 0;
  while ((d.getDay() === 0 || isFeriadoLocal(ymdStr(d), feriadosList)) && t < 60) {
    d.setDate(d.getDate() - 1); t++;
  }
  return d;
}

function avancaLocal(d, feriadosList) {
  let t = 0;
  while ((d.getDay() === 0 || isFeriadoLocal(ymdStr(d), feriadosList)) && t < 60) {
    d.setDate(d.getDate() + 1); t++;
  }
  return d;
}

function calcDayOffLocal(nascStr, ano, feriadosList, feriasPeriodos) {
  if (!nascStr) return null;
  const nasc = new Date(String(nascStr).slice(0, 10) + 'T12:00:00');
  const aniv = new Date(ano, nasc.getMonth(), nasc.getDate(), 12, 0, 0);
  const anivYmd = ymdStr(aniv);

  if (feriasPeriodos && feriasPeriodos.length) {
    const periodo = feriasPeriodos.find(p => p.ini <= anivYmd && anivYmd <= p.fim);
    if (periodo) {
      const retorno = new Date(periodo.fim + 'T12:00:00');
      retorno.setDate(retorno.getDate() + 1);
      return avancaLocal(retorno, feriadosList);
    }
  }

  return recuaLocal(new Date(ano, nasc.getMonth(), nasc.getDate(), 12, 0, 0), feriadosList);
}

// ─── GET /api/calendario?mes=YYYY-MM ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const mes    = (req.query.mes || '').slice(0, 7) || new Date().toISOString().slice(0, 7);
    const mesMM  = mes.slice(5, 7);
    const anoInt = parseInt(mes.slice(0, 4));
    const eid    = req.usuario.empresa_id;
    const uid    = req.usuario.id;
    const safe   = async (fn) => { try { return await fn(); } catch { return []; } };

    // Meses adjacentes para capturar day offs que "vazam" de mês (ex: nasc 01/jul domingo → day off 30/jun)
    const mesInt  = parseInt(mesMM);
    const prevMes = String(mesInt === 1  ? 12 : mesInt - 1).padStart(2, '0');
    const nextMes = String(mesInt === 12 ?  1 : mesInt + 1).padStart(2, '0');

    const [
      agenda, reunioes, eventos, coffeeBreaks, ferias, feriados, avisos,
      feriadosTodos, aniversariantesRaw, feriasValidas,
    ] = await Promise.all([
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
         WHERE empresa_id=? AND COALESCE(validacao,'confirmado') != 'rejeitado'
           AND (substr(data,1,7)=? OR (recorrente=1 AND substr(data,6,2)=?))
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
      // Todos os feriados da empresa (para calcular day offs corretamente)
      safe(() => all(
        `SELECT data, recorrente FROM feriados
         WHERE empresa_id=? AND COALESCE(validacao,'confirmado') != 'rejeitado'`,
        [eid]
      )),
      // Aniversariantes dos meses adjacentes + atual (para capturar day offs que "vazam")
      safe(() => all(
        `SELECT u.id, u.nome, u.data_nascimento
         FROM usuarios u
         WHERE u.empresa_id=? AND u.ativo=1 AND u.data_nascimento IS NOT NULL
           AND (COALESCE(u.tipo_usuario,'colaborador') = 'colaborador' OR COALESCE(u.mostrar_aniversario,0)=1)
           AND substr(u.data_nascimento,6,2) IN (?,?,?)`,
        [eid, prevMes, mesMM, nextMes]
      )),
      // Férias válidas para calcular day off durante férias
      safe(() => all(
        `SELECT usuario_id, data_inicio as ini, data_fim as fim
         FROM ferias WHERE empresa_id=? AND status IN ('aprovado','em_andamento','concluido')`,
        [eid]
      )),
    ]);

    // Mapa usuario_id → períodos de férias
    const feriasMap = {};
    (feriasValidas || []).forEach(f => {
      (feriasMap[f.usuario_id] = feriasMap[f.usuario_id] || []).push({ ini: f.ini, fim: f.fim });
    });

    // Calcula aniversários e day offs
    const aniversarios       = [];
    const dayoffsAniversario = [];

    for (const u of (aniversariantesRaw || [])) {
      const nascStr  = String(u.data_nascimento).slice(0, 10);
      const nascDate = new Date(nascStr + 'T12:00:00');
      const anivDate = new Date(anoInt, nascDate.getMonth(), nascDate.getDate(), 12, 0, 0);
      const anivStr  = ymdStr(anivDate);

      // Evento de aniversário (só se cai neste mês)
      if (anivStr.slice(0, 7) === mes) {
        aniversarios.push({ id: u.id, titulo: u.nome, data: anivStr, data_fim: null });
      }

      // Evento de day off (aparece no mês em que cai, independente do mês do aniversário)
      const dayoffDate = calcDayOffLocal(nascStr, anoInt, feriadosTodos || [], feriasMap[u.id] || []);
      if (dayoffDate) {
        const dayoffStr = ymdStr(dayoffDate);
        if (dayoffStr.slice(0, 7) === mes) {
          dayoffsAniversario.push({ id: u.id, titulo: u.nome, data: dayoffStr, data_fim: null });
        }
      }
    }

    res.json({ agenda, reunioes, eventos, coffeeBreaks, ferias, feriados, avisos, aniversarios, dayoffsAniversario });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
