const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

router.use(autenticar);

function empId(req) { return req.usuario.empresa_id; }

// ─── HELPER ───────────────────────────────────────────────────────────────────
async function adicionarPontos(empresaId, usuarioId, acao, pontos, descricao) {
  try {
    await run(
      'INSERT INTO cultura_pontos (id,empresa_id,usuario_id,acao,pontos,descricao) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), empresaId, usuarioId, acao, pontos, descricao]
    );
  } catch {}
}

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const eid = empId(req);

    // Comunicados recentes
    const comunicados = await all(`
      SELECT c.*, u.nome as autor_nome
      FROM comunicados c LEFT JOIN usuarios u ON c.publicado_por = u.id
      WHERE c.empresa_id = $1 AND c.ativo = 1
      ORDER BY c.fixado DESC, c.created_at DESC LIMIT 5
    `, [eid]);

    // Reconhecimentos recentes
    const reconhecimentos = await all(`
      SELECT r.*, u1.nome as de_nome, u2.nome as para_nome
      FROM cultura_reconhecimentos r
      JOIN usuarios u1 ON r.de_usuario_id = u1.id
      JOIN usuarios u2 ON r.para_usuario_id = u2.id
      WHERE r.empresa_id = $1 AND r.publico = 1
      ORDER BY r.created_at DESC LIMIT 5
    `, [eid]);

    // Aniversariantes do mês
    const aniversariantes = await all(`
      SELECT id, nome, avatar, data_nascimento, departamento_id
      FROM usuarios WHERE empresa_id = $1 AND ativo = 1
      AND data_nascimento IS NOT NULL
      AND EXTRACT(MONTH FROM data_nascimento::date) = EXTRACT(MONTH FROM NOW() - INTERVAL '3 hours')
      ORDER BY EXTRACT(DAY FROM data_nascimento::date)
    `, [eid]);

    // Pesquisas ativas pendentes
    const pesquisas = await all(`
      SELECT p.*, COUNT(r.id) as total_respostas
      FROM cultura_pesquisas p
      LEFT JOIN cultura_pesquisa_respostas r ON r.pesquisa_id = p.id
      WHERE p.empresa_id = $1 AND p.ativa = 1
      GROUP BY p.id ORDER BY p.created_at DESC LIMIT 3
    `, [eid]);

    // Ranking gamificação top 5
    const ranking = await all(`
      SELECT u.id, u.nome, u.avatar, COALESCE(SUM(p.pontos),0) as total_pontos
      FROM usuarios u
      LEFT JOIN cultura_pontos p ON p.usuario_id = u.id AND p.empresa_id = $1
      WHERE u.empresa_id = $2 AND u.ativo = 1
      GROUP BY u.id, u.nome, u.avatar ORDER BY total_pontos DESC LIMIT 5
    `, [eid, eid]);

    // Valores da empresa (institucional tipo valores)
    const valores = await get(`
      SELECT * FROM cultura_institucional
      WHERE empresa_id = $1 AND tipo = 'valores' AND ativo = 1
      LIMIT 1
    `, [eid]);

    res.json({ comunicados, reconhecimentos, aniversariantes, pesquisas, ranking, valores });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── INSTITUCIONAL ────────────────────────────────────────────────────────────
router.get('/institucional', async (req, res) => {
  try {
    const rows = await all('SELECT * FROM cultura_institucional WHERE empresa_id = $1 AND ativo = 1 ORDER BY tipo', [empId(req)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/institucional/:tipo', async (req, res) => {
  try {
    const row = await get('SELECT * FROM cultura_institucional WHERE empresa_id = $1 AND tipo = $2 AND ativo = 1', [empId(req), req.params.tipo]);
    res.json(row || null);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/institucional/:tipo', async (req, res) => {
  try {
    const eid = empId(req);
    const { titulo, conteudo, versao } = req.body;
    const existing = await get('SELECT id FROM cultura_institucional WHERE empresa_id = $1 AND tipo = $2', [eid, req.params.tipo]);
    if (existing) {
      await run(
        `UPDATE cultura_institucional SET titulo=$1, conteudo=$2, versao=$3, publicado_por=$4, updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$5`,
        [titulo, conteudo, versao || '1.0', req.usuario.id, existing.id]
      );
      res.json({ id: existing.id });
    } else {
      const id = uuidv4();
      await run(
        'INSERT INTO cultura_institucional (id,empresa_id,tipo,titulo,conteudo,versao,publicado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, eid, req.params.tipo, titulo, conteudo, versao || '1.0', req.usuario.id]
      );
      res.json({ id });
    }
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/institucional/:id/aceitar', async (req, res) => {
  try {
    const id = uuidv4();
    await run(
      'INSERT INTO cultura_institucional_aceites (id,institucional_id,usuario_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [id, req.params.id, req.usuario.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/institucional/:id/aceites', async (req, res) => {
  try {
    const rows = await all(`
      SELECT a.*, u.nome FROM cultura_institucional_aceites a
      JOIN usuarios u ON a.usuario_id = u.id WHERE a.institucional_id = $1
    `, [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── RECONHECIMENTOS ──────────────────────────────────────────────────────────
router.get('/reconhecimentos', async (req, res) => {
  try {
    const rows = await all(`
      SELECT r.*, u1.nome as de_nome, u1.avatar as de_avatar,
             u2.nome as para_nome, u2.avatar as para_avatar
      FROM cultura_reconhecimentos r
      JOIN usuarios u1 ON r.de_usuario_id = u1.id
      JOIN usuarios u2 ON r.para_usuario_id = u2.id
      WHERE r.empresa_id = $1 ORDER BY r.created_at DESC
    `, [empId(req)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/reconhecimentos', async (req, res) => {
  try {
    const { tipo, para_usuario_id, valor, descricao, publico } = req.body;
    const id = uuidv4();
    await run(
      'INSERT INTO cultura_reconhecimentos (id,empresa_id,tipo,de_usuario_id,para_usuario_id,valor,descricao,publico) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, empId(req), tipo||'elogio', req.usuario.id, para_usuario_id, valor||null, descricao, publico!==false?1:0]
    );
    // Conceder pontos ao reconhecido
    await adicionarPontos(empId(req), para_usuario_id, 'reconhecimento_recebido', 15, `Reconhecimento: ${tipo||'elogio'}`);
    res.json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/reconhecimentos/:id', async (req, res) => {
  try {
    await run('DELETE FROM cultura_reconhecimentos WHERE id=$1 AND empresa_id=$2', [req.params.id, empId(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── RANKINGS ─────────────────────────────────────────────────────────────────
router.get('/rankings', async (req, res) => {
  try {
    const rankings = await all('SELECT * FROM cultura_rankings WHERE empresa_id=$1 AND ativo=1 ORDER BY created_at DESC', [empId(req)]);
    const result = [];
    for (const r of rankings) {
      const posicoes = await all(`
        SELECT p.*, u.nome as usuario_nome, u.avatar as usuario_avatar
        FROM cultura_ranking_posicoes p
        LEFT JOIN usuarios u ON p.usuario_id = u.id
        WHERE p.ranking_id = $1 ORDER BY p.posicao ASC
      `, [r.id]);
      result.push({ ...r, posicoes });
    }
    res.json(result);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/rankings', async (req, res) => {
  try {
    const { titulo, descricao, periodo, departamento_id, posicoes, tipo_ranking, tipo_ranking_outro } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      'INSERT INTO cultura_rankings (id,empresa_id,titulo,descricao,periodo,departamento_id,tipo_ranking,tipo_ranking_outro) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id, empId(req), titulo, descricao||null, periodo||null, departamento_id||null, tipo_ranking||null, tipo_ranking_outro||null]
    );
    if (posicoes?.length) {
      for (const p of posicoes) {
        await run(
          'INSERT INTO cultura_ranking_posicoes (id,ranking_id,posicao,usuario_id,nome_externo,pontuacao,descricao) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [uuidv4(), id, p.posicao, p.usuario_id||null, p.nome_externo||null, p.pontuacao||null, p.descricao||null]
        );
      }
    }
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/rankings/:id', async (req, res) => {
  try {
    const { titulo, descricao, periodo, departamento_id, posicoes, tipo_ranking, tipo_ranking_outro } = req.body;
    await run(
      'UPDATE cultura_rankings SET titulo=$1,descricao=$2,periodo=$3,departamento_id=$4,tipo_ranking=$5,tipo_ranking_outro=$6 WHERE id=$7 AND empresa_id=$8',
      [titulo, descricao||null, periodo||null, departamento_id||null, tipo_ranking||null, tipo_ranking_outro||null, req.params.id, empId(req)]
    );
    await run('DELETE FROM cultura_ranking_posicoes WHERE ranking_id=$1', [req.params.id]);
    if (posicoes?.length) {
      for (const p of posicoes) {
        await run(
          'INSERT INTO cultura_ranking_posicoes (id,ranking_id,posicao,usuario_id,nome_externo,pontuacao,descricao) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [uuidv4(), req.params.id, p.posicao, p.usuario_id||null, p.nome_externo||null, p.pontuacao||null, p.descricao||null]
        );
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/rankings/:id', async (req, res) => {
  try {
    await run('UPDATE cultura_rankings SET ativo=0 WHERE id=$1 AND empresa_id=$2', [req.params.id, empId(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── PDI ──────────────────────────────────────────────────────────────────────
router.get('/pdis', async (req, res) => {
  try {
    const u = req.usuario;
    const isAdmin = u.perfil === 'admin' || u.perfil === 'gestor';
    const rows = isAdmin
      ? await all('SELECT p.*,uc.nome as colaborador_nome,ug.nome as gestor_nome FROM cultura_pdis p JOIN usuarios uc ON p.colaborador_id=uc.id JOIN usuarios ug ON p.gestor_id=ug.id WHERE p.empresa_id=$1 ORDER BY p.created_at DESC', [empId(req)])
      : await all('SELECT p.*,uc.nome as colaborador_nome,ug.nome as gestor_nome FROM cultura_pdis p JOIN usuarios uc ON p.colaborador_id=uc.id JOIN usuarios ug ON p.gestor_id=ug.id WHERE p.empresa_id=$1 AND (p.colaborador_id=$2 OR p.gestor_id=$3) ORDER BY p.created_at DESC', [empId(req), u.id, u.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/pdis', async (req, res) => {
  try {
    const { colaborador_id, titulo, objetivo, competencias, acoes, data_inicio, data_fim } = req.body;
    const id = uuidv4();
    await run(
      'INSERT INTO cultura_pdis (id,empresa_id,colaborador_id,gestor_id,titulo,objetivo,competencias,acoes,data_inicio,data_fim) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, empId(req), colaborador_id, req.usuario.id, titulo, objetivo||null, JSON.stringify(competencias||[]), JSON.stringify(acoes||[]), data_inicio||null, data_fim||null]
    );
    res.json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/pdis/:id', async (req, res) => {
  try {
    const { titulo, objetivo, competencias, acoes, status, data_inicio, data_fim } = req.body;
    await run(
      `UPDATE cultura_pdis SET titulo=$1,objetivo=$2,competencias=$3,acoes=$4,status=$5,data_inicio=$6,data_fim=$7,updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$8 AND empresa_id=$9`,
      [titulo, objetivo||null, JSON.stringify(competencias||[]), JSON.stringify(acoes||[]), status||'ativo', data_inicio||null, data_fim||null, req.params.id, empId(req)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/pdis/:id', async (req, res) => {
  try {
    await run('DELETE FROM cultura_pdis WHERE id=$1 AND empresa_id=$2', [req.params.id, empId(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── PESQUISAS DE CLIMA ───────────────────────────────────────────────────────
router.get('/pesquisas', async (req, res) => {
  try {
    const rows = await all(`
      SELECT p.*, u.nome as criador_nome, COUNT(r.id) as total_respostas
      FROM cultura_pesquisas p LEFT JOIN usuarios u ON p.criado_por=u.id
      LEFT JOIN cultura_pesquisa_respostas r ON r.pesquisa_id=p.id
      WHERE p.empresa_id=$1 GROUP BY p.id, u.nome ORDER BY p.created_at DESC
    `, [empId(req)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/pesquisas', async (req, res) => {
  try {
    const { titulo, tipo, descricao, perguntas, anonima, data_inicio, data_fim } = req.body;
    const id = uuidv4();
    await run(
      'INSERT INTO cultura_pesquisas (id,empresa_id,titulo,tipo,descricao,perguntas,anonima,criado_por,data_inicio,data_fim) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, empId(req), titulo, tipo||'clima', descricao||null, JSON.stringify(perguntas||[]), anonima!==false?1:0, req.usuario.id, data_inicio||null, data_fim||null]
    );
    res.json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/pesquisas/:id', async (req, res) => {
  try {
    const { titulo, tipo, descricao, perguntas, anonima, ativa, data_inicio, data_fim } = req.body;
    await run(
      'UPDATE cultura_pesquisas SET titulo=$1,tipo=$2,descricao=$3,perguntas=$4,anonima=$5,ativa=$6,data_inicio=$7,data_fim=$8 WHERE id=$9 AND empresa_id=$10',
      [titulo, tipo||'clima', descricao||null, JSON.stringify(perguntas||[]), anonima!==false?1:0, ativa!==false?1:0, data_inicio||null, data_fim||null, req.params.id, empId(req)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/pesquisas/:id', async (req, res) => {
  try {
    await run('DELETE FROM cultura_pesquisas WHERE id=$1 AND empresa_id=$2', [req.params.id, empId(req)]);
    await run('DELETE FROM cultura_pesquisa_respostas WHERE pesquisa_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/pesquisas/:id/responder', async (req, res) => {
  try {
    const { respostas } = req.body;
    const pesquisa = await get('SELECT * FROM cultura_pesquisas WHERE id=$1', [req.params.id]);
    if (!pesquisa) return res.status(404).json({ erro: 'Pesquisa não encontrada' });
    const id = uuidv4();
    const usuarioId = pesquisa.anonima ? null : req.usuario.id;
    await run(
      'INSERT INTO cultura_pesquisa_respostas (id,pesquisa_id,usuario_id,respostas) VALUES ($1,$2,$3,$4)',
      [id, req.params.id, usuarioId, JSON.stringify(respostas)]
    );
    await adicionarPontos(empId(req), req.usuario.id, 'pesquisa_respondida', 5, 'Pesquisa respondida');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/pesquisas/:id/resultados', async (req, res) => {
  try {
    const pesquisa = await get('SELECT * FROM cultura_pesquisas WHERE id=$1', [req.params.id]);
    if (!pesquisa) return res.status(404).json({ erro: 'Pesquisa não encontrada' });
    const respostas = await all('SELECT * FROM cultura_pesquisa_respostas WHERE pesquisa_id=$1', [req.params.id]);
    res.json({ pesquisa, respostas: respostas.map(r => ({ ...r, respostas: JSON.parse(r.respostas||'[]') })) });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── BIBLIOTECA ───────────────────────────────────────────────────────────────
router.get('/biblioteca', async (req, res) => {
  try {
    const { categoria, busca } = req.query;
    let sql = 'SELECT b.*, u.nome as criador_nome FROM cultura_biblioteca b LEFT JOIN usuarios u ON b.criado_por=u.id WHERE b.empresa_id=$1';
    const params = [empId(req)];
    let idx = 2;
    if (categoria) { sql += ` AND b.categoria=$${idx++}`; params.push(categoria); }
    if (busca) { sql += ` AND (b.titulo LIKE $${idx++} OR b.descricao LIKE $${idx++})`; params.push(`%${busca}%`,`%${busca}%`); }
    sql += ' ORDER BY b.created_at DESC';
    res.json(await all(sql, params));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/biblioteca', async (req, res) => {
  try {
    const { titulo, descricao, categoria, url, tags, publico } = req.body;
    const id = uuidv4();
    await run(
      'INSERT INTO cultura_biblioteca (id,empresa_id,titulo,descricao,categoria,url,tags,publico,criado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, empId(req), titulo, descricao||null, categoria||'documento', url||null, tags||null, publico!==false?1:0, req.usuario.id]
    );
    res.json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/biblioteca/:id', async (req, res) => {
  try {
    const { titulo, descricao, categoria, url, tags, publico } = req.body;
    await run(
      'UPDATE cultura_biblioteca SET titulo=$1,descricao=$2,categoria=$3,url=$4,tags=$5,publico=$6 WHERE id=$7 AND empresa_id=$8',
      [titulo, descricao||null, categoria||'documento', url||null, tags||null, publico!==false?1:0, req.params.id, empId(req)]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/biblioteca/:id', async (req, res) => {
  try {
    await run('DELETE FROM cultura_biblioteca WHERE id=$1 AND empresa_id=$2', [req.params.id, empId(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── GAMIFICAÇÃO ──────────────────────────────────────────────────────────────
router.get('/gamificacao', async (req, res) => {
  try {
    const eid = empId(req);
    const ranking = await all(`
      SELECT u.id, u.nome, u.avatar, u.departamento_id,
             COALESCE(SUM(p.pontos),0) as total_pontos,
             COUNT(DISTINCT m.id) as total_medalhas
      FROM usuarios u
      LEFT JOIN cultura_pontos p ON p.usuario_id=u.id AND p.empresa_id=$1
      LEFT JOIN cultura_medalhas m ON m.usuario_id=u.id AND m.empresa_id=$2
      WHERE u.empresa_id=$3 AND u.ativo=1
      GROUP BY u.id, u.nome, u.avatar, u.departamento_id ORDER BY total_pontos DESC
    `, [eid, eid, eid]);

    const meusPontos = await all('SELECT * FROM cultura_pontos WHERE empresa_id=$1 AND usuario_id=$2 ORDER BY created_at DESC LIMIT 20', [eid, req.usuario.id]);
    const minhasMedalhas = await all('SELECT * FROM cultura_medalhas WHERE empresa_id=$1 AND usuario_id=$2 ORDER BY created_at DESC', [eid, req.usuario.id]);

    res.json({ ranking, meusPontos, minhasMedalhas });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ─── COMUNICAÇÃO INTERNA (extensão de comunicados) ───────────────────────────
router.get('/comunicados', async (req, res) => {
  try {
    const { categoria } = req.query;
    const eid = empId(req);
    let sql = `SELECT c.*, u.nome as autor_nome,
      (SELECT COUNT(*) FROM comunicado_leituras WHERE comunicado_id=c.id) as total_leituras,
      (SELECT COUNT(*) FROM comunicado_reacoes WHERE comunicado_id=c.id) as total_reacoes,
      (SELECT COUNT(*) FROM comunicado_comentarios WHERE comunicado_id=c.id) as total_comentarios,
      (SELECT COUNT(*) FROM comunicado_leituras WHERE comunicado_id=c.id AND usuario_id=$1) as eu_li,
      (SELECT COUNT(*) FROM comunicado_reacoes WHERE comunicado_id=c.id AND usuario_id=$2) as eu_curti
      FROM comunicados c LEFT JOIN usuarios u ON c.publicado_por=u.id
      WHERE c.empresa_id=$3 AND c.ativo=1`;
    const params = [req.usuario.id, req.usuario.id, eid];
    let idx = 4;
    if (categoria) { sql += ` AND c.categoria=$${idx++}`; params.push(categoria); }
    sql += ' ORDER BY c.fixado DESC, c.created_at DESC';
    res.json(await all(sql, params));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/comunicados/:id/curtir', async (req, res) => {
  try {
    const existing = await get('SELECT id FROM comunicado_reacoes WHERE comunicado_id=$1 AND usuario_id=$2', [req.params.id, req.usuario.id]);
    if (existing) {
      await run('DELETE FROM comunicado_reacoes WHERE id=$1', [existing.id]);
      res.json({ curtido: false });
    } else {
      await run('INSERT INTO comunicado_reacoes (id,comunicado_id,usuario_id) VALUES ($1,$2,$3)', [uuidv4(), req.params.id, req.usuario.id]);
      res.json({ curtido: true });
    }
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/comunicados/:id/confirmar-leitura', async (req, res) => {
  try {
    await run(
      'INSERT INTO comunicado_leituras (id,comunicado_id,usuario_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [uuidv4(), req.params.id, req.usuario.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.get('/comunicados/:id/comentarios', async (req, res) => {
  try {
    const rows = await all('SELECT c.*, u.nome as autor_nome FROM comunicado_comentarios c JOIN usuarios u ON c.usuario_id=u.id WHERE c.comunicado_id=$1 ORDER BY c.created_at ASC', [req.params.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/comunicados/:id/comentarios', async (req, res) => {
  try {
    const { texto } = req.body;
    const id = uuidv4();
    await run(
      'INSERT INTO comunicado_comentarios (id,comunicado_id,usuario_id,empresa_id,texto) VALUES ($1,$2,$3,$4,$5)',
      [id, req.params.id, req.usuario.id, empId(req), texto]
    );
    res.json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
