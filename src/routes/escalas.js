const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { notificar: notificarDiscord, COR: DISCORD_COR } = require('../utils/discord');

router.use(autenticar);
function eid(req) { return req.usuario.empresa_id; }

const MESES_ESC = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

async function logHist(escalaId, req, acao, detalhe) {
  try {
    await run(
      `INSERT INTO escala_historico (id, escala_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), escalaId, eid(req), req.usuario.id, req.usuario.nome || '', acao, detalhe || null]
    );
  } catch {}
}

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
    sql += ' ORDER BY e.ano DESC, e.mes DESC, e.created_at DESC';
    res.json(await all(sql, params));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Buscar escala com slots, feriados, historico e hora_extra
router.get('/:id', async (req, res) => {
  try {
    const escala = await get(
      `SELECT e.*, d.nome as departamento_nome, u.nome as criador_nome
       FROM escalas e
       LEFT JOIN departamentos d ON d.id = e.departamento_id
       LEFT JOIN usuarios u ON u.id = e.criado_por
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
    const historico = await all(
      `SELECT * FROM escala_historico WHERE escala_id = ? ORDER BY created_at DESC LIMIT 60`,
      [req.params.id]
    );
    const horaExtra = await all(
      `SELECT h.*, u.nome as criador_nome
       FROM hora_extra h LEFT JOIN usuarios u ON u.id = h.criado_por
       WHERE h.escala_id = ? ORDER BY h.data ASC, h.created_at ASC`,
      [req.params.id]
    );
    const sobreaviso = await all(
      `SELECT se.*,
        t1.nome as tecnico1_nome, t2.nome as tecnico2_nome
       FROM sobreaviso_entradas se
       LEFT JOIN usuarios t1 ON t1.id = se.tecnico1_id
       LEFT JOIN usuarios t2 ON t2.id = se.tecnico2_id
       WHERE se.escala_id = ? ORDER BY se.data ASC`,
      [req.params.id]
    );
    res.json({ ...escala, slots, feriados, historico, hora_extra: horaExtra, sobreaviso });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar ou recuperar escala existente
router.post('/', async (req, res) => {
  try {
    const { departamento_id, mes, ano, colaboradores, tipo, nome, subtipo } = req.body;
    const tipoVal = tipo || 'plantao';
    const existente = await get(
      `SELECT * FROM escalas WHERE empresa_id=? AND departamento_id=? AND mes=? AND ano=?`,
      [eid(req), departamento_id || null, Number(mes), Number(ano)]
    );
    if (existente) return res.json(existente);

    const id = uuidv4();
    await run(
      `INSERT INTO escalas (id, empresa_id, departamento_id, mes, ano, tipo, subtipo, nome, criado_por, colaboradores)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, eid(req), departamento_id || null, Number(mes), Number(ano),
       tipoVal, subtipo || null, nome || null, req.usuario.id,
       colaboradores ? JSON.stringify(colaboradores) : null]
    );
    const criada = await get(
      `SELECT e.*, d.nome as departamento_nome FROM escalas e
       LEFT JOIN departamentos d ON d.id = e.departamento_id WHERE e.id = ?`,
      [id]
    );
    await logHist(id, req, 'criada', `${tipoVal === 'hora_extra' ? 'Hora Extra' : tipoVal === 'sobreaviso' ? 'Sobreaviso' : 'Escala'} — ${criada.departamento_nome || ''} ${Number(mes)}/${Number(ano)}${nome ? ` — ${nome}` : ''}`);
    res.status(201).json(criada);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar escala (colaboradores, publicação, observação, tipo, nome)
router.patch('/:id', async (req, res) => {
  try {
    const { colaboradores, publicada, observacao, tipo, nome } = req.body;
    const sets = [], params = [];
    if (colaboradores !== undefined) {
      sets.push('colaboradores=?');
      params.push(colaboradores ? JSON.stringify(colaboradores) : null);
    }
    if (publicada !== undefined) { sets.push('publicada=?'); params.push(publicada ? 1 : 0); }
    if (observacao !== undefined) { sets.push('observacao=?'); params.push(observacao || null); }
    if (tipo !== undefined) { sets.push('tipo=?'); params.push(tipo); }
    if (nome !== undefined) { sets.push('nome=?'); params.push(nome || null); }
    if (!sets.length) return res.json({ ok: true });
    params.push(req.params.id, eid(req));
    await run(`UPDATE escalas SET ${sets.join(',')} WHERE id=? AND empresa_id=?`, params);
    if (publicada === true)  await logHist(req.params.id, req, 'publicada', null);
    if (publicada === false) await logHist(req.params.id, req, 'ocultada', null);
    if (observacao !== undefined && observacao) await logHist(req.params.id, req, 'observacao', null);
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

    let nomeAtendente = null;
    if (usuario_id) {
      const u = await get('SELECT nome FROM usuarios WHERE id=?', [usuario_id]);
      nomeAtendente = u?.nome || null;
    }

    if (existing) {
      if (usuario_id) {
        await run('UPDATE escala_slots SET usuario_id=? WHERE id=?', [usuario_id, existing.id]);
        await logHist(req.params.id, req, 'slot', nomeAtendente ? `Atribuído: ${nomeAtendente}` : null);
      } else {
        await run('DELETE FROM escala_slots WHERE id=?', [existing.id]);
        await logHist(req.params.id, req, 'slot_removido', null);
      }
    } else if (usuario_id) {
      await run(
        `INSERT INTO escala_slots (id,escala_id,secao,dia,turno,posicao,usuario_id) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), req.params.id, secao, dia, turnoVal, posicao, usuario_id]
      );
      await logHist(req.params.id, req, 'slot', nomeAtendente ? `Atribuído: ${nomeAtendente}` : null);
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
    await logHist(req.params.id, req, 'feriado', `${nome} — dia ${dia}`);
    res.status(201).json({ id, escala_id: req.params.id, dia: parseInt(dia), nome });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Remover feriado
router.delete('/:id/feriados/:fid', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    await run('DELETE FROM escala_feriados_def WHERE id=? AND escala_id=?', [req.params.fid, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Personalizar turnos de almoço / sábado
router.patch('/:id/turnos', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const sets = [], params = [];
    if ('turnos_almoco' in req.body) {
      sets.push('turnos_almoco=?');
      params.push(req.body.turnos_almoco === null ? null : JSON.stringify(req.body.turnos_almoco));
    }
    if ('turnos_sabado' in req.body) {
      sets.push('turnos_sabado=?');
      params.push(req.body.turnos_sabado === null ? null : JSON.stringify(req.body.turnos_sabado));
    }
    if ('lanches' in req.body) {
      sets.push('lanches=?');
      params.push(req.body.lanches === null ? null : JSON.stringify(req.body.lanches));
    }
    if (sets.length) {
      params.push(req.params.id);
      await run(`UPDATE escalas SET ${sets.join(',')} WHERE id=?`, params);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Sobreaviso ───────────────────────────────────────────────────────────────

// Criar entrada de sobreaviso
router.post('/:id/sobreaviso', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const { data, feriado_nome, tecnico1_id, tecnico2_id, observacao } = req.body;
    if (!data) return res.status(400).json({ erro: 'Data obrigatória' });
    const id = uuidv4();
    await run(
      `INSERT INTO sobreaviso_entradas (id,escala_id,empresa_id,data,feriado_nome,tecnico1_id,tecnico2_id,observacao)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.params.id, eid(req), data, feriado_nome || null,
       tecnico1_id || null, tecnico2_id || null, observacao || null]
    );
    const criada = await get(
      `SELECT se.*, t1.nome as tecnico1_nome, t2.nome as tecnico2_nome
       FROM sobreaviso_entradas se
       LEFT JOIN usuarios t1 ON t1.id = se.tecnico1_id
       LEFT JOIN usuarios t2 ON t2.id = se.tecnico2_id
       WHERE se.id=?`, [id]
    );
    res.status(201).json(criada);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar entrada de sobreaviso
router.put('/:id/sobreaviso/:sid', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const { data, feriado_nome, tecnico1_id, tecnico2_id, observacao } = req.body;
    await run(
      `UPDATE sobreaviso_entradas
       SET data=?, feriado_nome=?, tecnico1_id=?, tecnico2_id=?, observacao=?
       WHERE id=? AND escala_id=? AND empresa_id=?`,
      [data, feriado_nome || null, tecnico1_id || null, tecnico2_id || null,
       observacao || null, req.params.sid, req.params.id, eid(req)]
    );
    const atualizada = await get(
      `SELECT se.*, t1.nome as tecnico1_nome, t2.nome as tecnico2_nome
       FROM sobreaviso_entradas se
       LEFT JOIN usuarios t1 ON t1.id = se.tecnico1_id
       LEFT JOIN usuarios t2 ON t2.id = se.tecnico2_id
       WHERE se.id=? AND se.empresa_id=?`, [req.params.sid, eid(req)]
    );
    res.json(atualizada);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Remover entrada de sobreaviso
router.delete('/:id/sobreaviso/:sid', async (req, res) => {
  try {
    await run('DELETE FROM sobreaviso_entradas WHERE id=? AND escala_id=? AND empresa_id=?',
      [req.params.sid, req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Hora Extra ────────────────────────────────────────────────────────────────

// Criar entrada de hora extra
router.post('/:id/hora-extra', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const { data, tecnicos, cidade, horario_saida_previsto, horario_saida_real, motivo, observacao } = req.body;
    if (!data) return res.status(400).json({ erro: 'Data obrigatória' });
    const id = uuidv4();
    await run(
      `INSERT INTO hora_extra (id,escala_id,empresa_id,data,tecnicos,cidade,horario_saida_previsto,horario_saida_real,motivo,observacao,criado_por,criado_por_nome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.params.id, eid(req), data,
       tecnicos ? JSON.stringify(tecnicos) : null,
       cidade || null, horario_saida_previsto || null, horario_saida_real || null,
       motivo || null, observacao || null,
       req.usuario.id, req.usuario.nome || null]
    );
    await logHist(req.params.id, req, 'hora_extra', `${data}${cidade ? ` — ${cidade}` : ''}`);
    const criada = await get('SELECT * FROM hora_extra WHERE id=?', [id]);
    res.status(201).json(criada);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar entrada de hora extra
router.put('/:id/hora-extra/:hid', async (req, res) => {
  try {
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const { data, tecnicos, cidade, horario_saida_previsto, horario_saida_real, motivo, observacao } = req.body;
    await run(
      `UPDATE hora_extra SET data=?,tecnicos=?,cidade=?,horario_saida_previsto=?,horario_saida_real=?,motivo=?,observacao=?
       WHERE id=? AND escala_id=? AND empresa_id=?`,
      [data, tecnicos ? JSON.stringify(tecnicos) : null, cidade || null,
       horario_saida_previsto || null, horario_saida_real || null,
       motivo || null, observacao || null,
       req.params.hid, req.params.id, eid(req)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Remover entrada de hora extra
router.delete('/:id/hora-extra/:hid', async (req, res) => {
  try {
    await run('DELETE FROM hora_extra WHERE id=? AND escala_id=? AND empresa_id=?',
      [req.params.hid, req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir escala
router.delete('/:id', async (req, res) => {
  try {
    // Valida que a escala é da empresa ANTES de apagar sub-registros (evita destruição cross-tenant)
    const escala = await get('SELECT id FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    await run('DELETE FROM escala_slots WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM escala_feriados_def WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM hora_extra WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM sobreaviso_entradas WHERE escala_id=?', [req.params.id]);
    await run('DELETE FROM escalas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Notificar a escala/plantão no Discord (avisar a equipe que está pronta)
router.post('/:id/notificar-discord', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const escala = await get(
      `SELECT e.*, d.nome as departamento_nome FROM escalas e
       LEFT JOIN departamentos d ON d.id = e.departamento_id
       WHERE e.id = ? AND e.empresa_id = ?`,
      [req.params.id, eid(req)]
    );
    if (!escala) return res.status(404).json({ erro: 'Escala não encontrada' });
    const titulo = escala.nome || `Plantão ${MESES_ESC[(escala.mes || 1) - 1]} ${escala.ano || ''}`.trim();
    const ok = await notificarDiscord(eid(req), 'comunicado', {
      title: `📅 ${titulo}`,
      description: `A escala de **${escala.departamento_nome || 'plantão'}** referente a **${MESES_ESC[(escala.mes || 1) - 1]} ${escala.ano || ''}** está disponível. Confira sua escala!`,
      color: DISCORD_COR.roxo,
      fields: [
        { name: 'Notificado por', value: req.usuario.nome || '—', inline: true },
      ],
      linkPath: `/escala/ver/${req.params.id}`,
      footer: { text: 'Kronos — Escala' },
      timestamp: new Date().toISOString(),
    });
    if (!ok) return res.status(400).json({ erro: 'Discord não configurado/ativo. Configure em Configurações → Integração com o Discord.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
