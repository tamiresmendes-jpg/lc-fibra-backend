const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);
function eid(req) { return req.usuario.empresa_id; }

// ─── LISTAR campanhas ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `SELECT c.*, u.nome as responsavel_nome,
      (SELECT COUNT(*) FROM campanha_participantes WHERE campanha_id=c.id) as total_participantes,
      (SELECT COUNT(*) FROM campanha_participantes WHERE campanha_id=c.id AND confirmou_leitura=1) as total_cientes
      FROM campanhas c LEFT JOIN usuarios u ON u.id=c.responsavel_id
      WHERE c.empresa_id=$1`;
    const params = [eid(req)];
    let idx = 2;
    if (status) { sql += ` AND c.status=$${idx++}`; params.push(status); }
    sql += ' ORDER BY c.created_at DESC';
    const lista = await all(sql, params);
    res.json(lista);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── DETALHE campanha ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const c = await get('SELECT c.*, u.nome as responsavel_nome FROM campanhas c LEFT JOIN usuarios u ON u.id=c.responsavel_id WHERE c.id=$1 AND c.empresa_id=$2', [req.params.id, eid(req)]);
    if (!c) return res.status(404).json({ erro: 'Campanha não encontrada' });
    const metas = await all('SELECT * FROM campanha_metas WHERE campanha_id=$1 ORDER BY ordem', [req.params.id]);
    const publico = await all('SELECT * FROM campanha_publico WHERE campanha_id=$1', [req.params.id]);
    const participantes = await all(`
      SELECT cp.*, u.nome, u.avatar, u.departamento_id, u.cargo_id,
             d.nome as departamento_nome
      FROM campanha_participantes cp
      JOIN usuarios u ON u.id=cp.usuario_id
      LEFT JOIN departamentos d ON d.id=u.departamento_id
      WHERE cp.campanha_id=$1
    `, [req.params.id]);
    res.json({ ...c, metas, publico, participantes });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── CRIAR campanha ──────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, data_inicio, data_fim, tipo_publico, tipo_bonificacao, valor_bonificacao, tipo_ranking, responsavel_id, metas, publico_ids } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO campanhas (id,empresa_id,nome,descricao,data_inicio,data_fim,tipo_publico,tipo_bonificacao,valor_bonificacao,tipo_ranking,responsavel_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id,eid(req),nome,descricao||null,data_inicio||null,data_fim||null,tipo_publico||'todos',tipo_bonificacao||'valor_fixo',valor_bonificacao||0,tipo_ranking||'individual',responsavel_id||req.usuario.id,req.usuario.id]
    );

    // Salva metas
    if (metas?.length) {
      for (const [i, m] of metas.entries()) {
        await run(
          'INSERT INTO campanha_metas (id,campanha_id,titulo,categoria,descricao,valor_meta,unidade,tipo_bonif,valor_bonif,ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [uuidv4(),id,m.titulo,m.categoria||'personalizada',m.descricao||null,m.valor_meta||0,m.unidade||'unidades',m.tipo_bonif||'fixo_ao_atingir',m.valor_bonif||0,i]
        );
      }
    }

    // Gera participantes conforme tipo de público
    let users = [];
    if (tipo_publico === 'todos') {
      users = await all('SELECT id FROM usuarios WHERE empresa_id=$1 AND ativo=1', [eid(req)]);
    } else if (tipo_publico === 'departamento' && publico_ids?.length) {
      const placeholders = publico_ids.map((_, i) => `$${i + 2}`).join(',');
      users = await all(`SELECT id FROM usuarios WHERE empresa_id=$1 AND ativo=1 AND departamento_id IN (${placeholders})`, [eid(req), ...publico_ids]);
    } else if (tipo_publico === 'cargo' && publico_ids?.length) {
      const placeholders = publico_ids.map((_, i) => `$${i + 2}`).join(',');
      users = await all(`SELECT id FROM usuarios WHERE empresa_id=$1 AND ativo=1 AND cargo_id IN (${placeholders})`, [eid(req), ...publico_ids]);
    } else if (tipo_publico === 'individual' && publico_ids?.length) {
      const placeholders = publico_ids.map((_, i) => `$${i + 2}`).join(',');
      users = await all(`SELECT id FROM usuarios WHERE empresa_id=$1 AND ativo=1 AND id IN (${placeholders})`, [eid(req), ...publico_ids]);
    }

    for (const u of users) {
      await run(
        'INSERT INTO campanha_participantes (id,campanha_id,usuario_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [uuidv4(),id,u.id]
      );
    }

    res.status(201).json({ id, nome, total_participantes: users.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── EDITAR campanha ─────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, descricao, data_inicio, data_fim, status, tipo_publico, tipo_bonificacao, valor_bonificacao, tipo_ranking, responsavel_id, metas, publico_ids } = req.body;
    await run(
      'UPDATE campanhas SET nome=$1,descricao=$2,data_inicio=$3,data_fim=$4,status=$5,tipo_publico=$6,tipo_bonificacao=$7,valor_bonificacao=$8,tipo_ranking=$9,responsavel_id=$10 WHERE id=$11 AND empresa_id=$12',
      [nome,descricao||null,data_inicio||null,data_fim||null,status||'ativa',tipo_publico||'todos',tipo_bonificacao||'valor_fixo',valor_bonificacao||0,tipo_ranking||'individual',responsavel_id||req.usuario.id,req.params.id,eid(req)]
    );

    if (metas) {
      await run('DELETE FROM campanha_metas WHERE campanha_id=$1', [req.params.id]);
      for (const [i, m] of metas.entries()) {
        await run(
          'INSERT INTO campanha_metas (id,campanha_id,titulo,categoria,descricao,valor_meta,unidade,tipo_bonif,valor_bonif,ordem) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [uuidv4(),req.params.id,m.titulo,m.categoria||'personalizada',m.descricao||null,m.valor_meta||0,m.unidade||'unidades',m.tipo_bonif||'fixo_ao_atingir',m.valor_bonif||0,i]
        );
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── DELETAR campanha ────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM campanha_resultados WHERE campanha_id=$1', [req.params.id]);
    await run('DELETE FROM campanha_participantes WHERE campanha_id=$1', [req.params.id]);
    await run('DELETE FROM campanha_metas WHERE campanha_id=$1', [req.params.id]);
    await run('DELETE FROM campanha_publico WHERE campanha_id=$1', [req.params.id]);
    await run('DELETE FROM campanhas WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── ENCERRAR campanha ───────────────────────────────────────────────────────
router.post('/:id/encerrar', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('UPDATE campanhas SET status=$1 WHERE id=$2 AND empresa_id=$3', ['encerrada',req.params.id,eid(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── ADICIONAR participante ──────────────────────────────────────────────────
router.post('/:id/participantes', async (req, res) => {
  try {
    const { usuario_id } = req.body;
    const existe = await get('SELECT id FROM campanha_participantes WHERE campanha_id=$1 AND usuario_id=$2', [req.params.id, usuario_id]);
    if (existe) return res.json({ ok: true });
    await run('INSERT INTO campanha_participantes (id,campanha_id,usuario_id) VALUES ($1,$2,$3)', [uuidv4(),req.params.id,usuario_id]);
    res.status(201).json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── CONFIRMAR LEITURA (participante) ───────────────────────────────────────
router.post('/:id/confirmar-leitura', async (req, res) => {
  try {
    await run(
      `UPDATE campanha_participantes SET confirmou_leitura=1, data_leitura=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE campanha_id=$1 AND usuario_id=$2`,
      [req.params.id, req.usuario.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── REGISTRAR / ATUALIZAR resultado ────────────────────────────────────────
router.put('/:id/resultados', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { resultados } = req.body; // [{meta_id, usuario_id, valor_realizado, observacao}]
    for (const r of resultados) {
      const existe = await get('SELECT id FROM campanha_resultados WHERE campanha_id=$1 AND meta_id=$2 AND usuario_id=$3', [req.params.id,r.meta_id,r.usuario_id]);
      if (existe) {
        await run('UPDATE campanha_resultados SET valor_realizado=$1,observacao=$2,registrado_por=$3 WHERE id=$4', [r.valor_realizado,r.observacao||null,req.usuario.id,existe.id]);
      } else {
        await run('INSERT INTO campanha_resultados (id,campanha_id,meta_id,usuario_id,valor_realizado,observacao,registrado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)', [uuidv4(),req.params.id,r.meta_id,r.usuario_id,r.valor_realizado||0,r.observacao||null,req.usuario.id]);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── RANKING da campanha ─────────────────────────────────────────────────────
router.get('/:id/ranking', async (req, res) => {
  try {
    const campanha = await get('SELECT * FROM campanhas WHERE id=$1 AND empresa_id=$2', [req.params.id,eid(req)]);
    if (!campanha) return res.status(404).json({ erro: 'Campanha não encontrada' });
    const metas = await all('SELECT * FROM campanha_metas WHERE campanha_id=$1', [req.params.id]);
    const participantes = await all(`
      SELECT cp.usuario_id, u.nome, u.avatar, d.nome as departamento
      FROM campanha_participantes cp JOIN usuarios u ON u.id=cp.usuario_id
      LEFT JOIN departamentos d ON d.id=u.departamento_id
      WHERE cp.campanha_id=$1
    `, [req.params.id]);

    const ranking = [];
    for (const p of participantes) {
      const resultados = await all('SELECT * FROM campanha_resultados WHERE campanha_id=$1 AND usuario_id=$2', [req.params.id,p.usuario_id]);
      let totalRealizado = 0, totalMeta = 0;
      metas.forEach(m => {
        const r = resultados.find(x => x.meta_id === m.id);
        totalRealizado += r ? r.valor_realizado : 0;
        totalMeta += m.valor_meta;
      });
      const pct = totalMeta > 0 ? Math.round((totalRealizado/totalMeta)*100) : 0;
      ranking.push({ ...p, total_realizado: totalRealizado, total_meta: totalMeta, percentual: pct });
    }

    ranking.sort((a,b) => b.percentual - a.percentual);
    ranking.forEach((r,i) => { r.posicao = i+1; });

    res.json(ranking);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── DASHBOARD da campanha ───────────────────────────────────────────────────
router.get('/:id/dashboard', async (req, res) => {
  try {
    const c = await get('SELECT * FROM campanhas WHERE id=$1 AND empresa_id=$2', [req.params.id,eid(req)]);
    if (!c) return res.status(404).json({ erro: 'Campanha não encontrada' });
    const rowTP = await get('SELECT COUNT(*) as t FROM campanha_participantes WHERE campanha_id=$1', [req.params.id]);
    const totalParticipantes = rowTP.t;
    const rowTC = await get('SELECT COUNT(*) as t FROM campanha_participantes WHERE campanha_id=$1 AND confirmou_leitura=1', [req.params.id]);
    const totalCientes = rowTC.t;
    const metas = await all('SELECT * FROM campanha_metas WHERE campanha_id=$1', [req.params.id]);
    const resultados = await all('SELECT * FROM campanha_resultados WHERE campanha_id=$1', [req.params.id]);
    const participantes = await all('SELECT usuario_id FROM campanha_participantes WHERE campanha_id=$1', [req.params.id]);

    let metasAtingidas = 0, totalPct = 0, count = 0;
    for (const m of metas) {
      for (const p of participantes) {
        const r = resultados.find(x => x.meta_id===m.id && x.usuario_id===p.usuario_id);
        const v = r ? r.valor_realizado : 0;
        if (m.valor_meta > 0) { totalPct += (v/m.valor_meta)*100; count++; if (v >= m.valor_meta) metasAtingidas++; }
      }
    }
    const mediaDesempenho = count > 0 ? Math.round(totalPct/count) : 0;
    const valorPremiacoes = totalParticipantes * (c.valor_bonificacao || 0);

    res.json({ totalParticipantes, totalCientes, metasAtingidas, metasPendentes: (count-metasAtingidas), mediaDesempenho, valorPremiacoes });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
