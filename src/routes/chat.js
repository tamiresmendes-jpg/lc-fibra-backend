const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { PUBLIC_KEY: VAPID_PUBLIC, enviarPush } = require('../config/webpush');

router.use(autenticar);

// Migrações de startup — Fase 2
(async () => {
  try { await run(`ALTER TABLE chat_solicitacoes ADD COLUMN IF NOT EXISTS aceite_prazo TIMESTAMPTZ`); } catch {}
  try { await run(`ALTER TABLE chat_solicitacoes ADD COLUMN IF NOT EXISTS aceite_tentativas INTEGER DEFAULT 0`); } catch {}
})();

const NOW = `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`;
const eid = (req) => req.usuario.empresa_id;
const uid = (req) => req.usuario.id;
const unome = (req) => req.usuario.nome || '';
const ehGestor = (req) => ['admin', 'gestor'].includes(req.usuario.perfil);

const STATUS_VALIDOS = ['nova', 'distribuida', 'em_atendimento', 'aguardando_retorno', 'concluida', 'cancelada', 'reaberta'];
const STATUS_ABERTOS = ['nova', 'distribuida', 'em_atendimento', 'aguardando_retorno', 'reaberta'];

const SEL = `
  SELECT s.*, g.nome AS grupo_nome,
         (SELECT COUNT(*) FROM chat_mensagens m WHERE m.solicitacao_id = s.id) AS total_mensagens
    FROM chat_solicitacoes s
    LEFT JOIN chat_grupos g ON g.id = s.grupo_id`;

async function logHist(solId, req, acao, detalhe) {
  try {
    await run(
      `INSERT INTO chat_historico (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), solId, eid(req), uid(req), unome(req), acao, detalhe || null]
    );
  } catch {}
}
async function notificar(empresaId, usuarioId, titulo, texto) {
  if (!usuarioId) return;
  try {
    await run(
      `INSERT INTO notificacoes (id, empresa_id, usuario_id, tipo, titulo, texto, link)
       VALUES (?,?,?, 'chat', ?,?, '/kronos-chat')`,
      [uuidv4(), empresaId, usuarioId, titulo, texto || null]
    );
  } catch {}
}

// Próximo prazo de aceite em BRT (NOW − 3h + 2min)
const ACEITE_PRAZO_SQL = `TO_CHAR(NOW() - INTERVAL '3 hours' + INTERVAL '2 minutes', 'YYYY-MM-DD HH24:MI:SS')`;

// Distribuição automática pelo grupo; excluirId evita reatribuir à mesma pessoa
async function distribuir(empresaId, grupoId, excluirId = null) {
  if (!grupoId) return null;
  const deptos = await all(
    `SELECT departamento_id FROM chat_grupo_responsaveis WHERE grupo_id = ?`,
    [grupoId]
  );
  if (!deptos.length) return null;
  const deptoIds = deptos.map(d => d.departamento_id);
  const placeholders = deptoIds.map(() => '?').join(',');
  const candidatos = await all(
    `SELECT id, nome FROM usuarios
     WHERE empresa_id = ? AND departamento_id IN (${placeholders}) AND ativo = 1
       AND COALESCE(chat_status, 'disponivel') = 'disponivel'
       ${excluirId ? 'AND id != ?' : ''}`,
    [empresaId, ...deptoIds, ...(excluirId ? [excluirId] : [])]
  );
  if (!candidatos.length) return null;
  let melhor = null, menor = Infinity;
  for (const c of candidatos) {
    const r = await get(
      `SELECT COUNT(*) AS t FROM chat_solicitacoes
       WHERE empresa_id = ? AND responsavel_id = ? AND status NOT IN ('concluida','cancelada')`,
      [empresaId, c.id]
    );
    const carga = Number(r?.t || 0);
    if (carga < menor) { menor = carga; melhor = c; }
  }
  return melhor;
}

// ── Status do próprio colaborador ──────────────────────────────
router.get('/meu-status', async (req, res) => {
  try {
    const u = await get('SELECT chat_status FROM usuarios WHERE id = ?', [uid(req)]);
    res.json({ status: u?.chat_status || 'disponivel' });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.patch('/meu-status', async (req, res) => {
  try {
    const { status } = req.body;
    const validos = ['disponivel', 'ocupado', 'em_lanche', 'em_pausa', 'ausente'];
    if (!validos.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    await run('UPDATE usuarios SET chat_status = ? WHERE id = ?', [status, uid(req)]);
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Colaboradores disponíveis (para reatribuição manual)
router.get('/colaboradores', async (req, res) => {
  try {
    const { departamento_id } = req.query;
    let sql = `SELECT id, nome, chat_status, departamento_id FROM usuarios WHERE empresa_id = ? AND ativo = 1 AND COALESCE(perfil,'colaborador') <> 'admin'`;
    const params = [eid(req)];
    if (departamento_id) { sql += ' AND departamento_id = ?'; params.push(departamento_id); }
    sql += ' ORDER BY nome';
    res.json(await all(sql, params));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Fila de solicitações ───────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status, grupo_id, escopo } = req.query;
    let sql = `${SEL} WHERE s.empresa_id = ?`;
    const params = [eid(req)];
    if (status) { sql += ` AND s.status = ?`; params.push(status); }
    if (grupo_id) { sql += ` AND s.grupo_id = ?`; params.push(grupo_id); }
    if (escopo === 'minhas') { sql += ` AND (s.criado_por = ? OR s.responsavel_id = ?)`; params.push(uid(req), uid(req)); }
    sql += ` ORDER BY CASE WHEN s.status IN ('concluida','cancelada') THEN 1 ELSE 0 END, s.updated_at DESC`;
    res.json(await all(sql, params));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Grupos do chat (apenas admin principal) — DEVE vir antes de /:id ──

function soAdmin(req, res, next) {
  if (req.usuario.perfil !== 'admin') return res.status(403).json({ erro: 'Apenas o admin pode gerenciar grupos do chat' });
  next();
}

async function carregarGrupoCompleto(grupoId) {
  const g = await get('SELECT * FROM chat_grupos WHERE id = ?', [grupoId]);
  if (!g) return null;
  g.responsaveis = await all(
    `SELECT d.id, d.nome FROM chat_grupo_responsaveis r
       JOIN departamentos d ON d.id = r.departamento_id
      WHERE r.grupo_id = ? ORDER BY d.nome`,
    [grupoId]
  );
  g.participantes = await all(
    `SELECT d.id, d.nome FROM chat_grupo_part_deptos p
       JOIN departamentos d ON d.id = p.departamento_id
      WHERE p.grupo_id = ? ORDER BY d.nome`,
    [grupoId]
  );
  g.topicos = await all(
    `SELECT id, nome FROM chat_topicos WHERE grupo_id = ? ORDER BY nome`,
    [grupoId]
  );
  return g;
}

// Lista de departamentos para os seletores do grupo (antes de /:id)
router.get('/aux/departamentos', async (req, res) => {
  try {
    res.json(await all(
      `SELECT id, nome FROM departamentos WHERE empresa_id = ? AND excluido_em IS NULL ORDER BY nome`,
      [eid(req)]
    ));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Dashboard do Kronos Chat (antes de /:id)
router.get('/dashboard', async (req, res) => {
  try {
    const empresa = eid(req);
    const depId = req.query.departamento_id || null;
    const ABERTOS = `('nova','distribuida','em_atendimento','aguardando_retorno','reaberta')`;

    // Filtro por departamento (do responsável que atende). Prefixo = alias da tabela ('' ou 's.')
    const depClause = (p = '') => depId
      ? ` AND ${p}responsavel_id IN (SELECT id FROM usuarios WHERE empresa_id = ? AND departamento_id = ?)`
      : '';
    const depP = depId ? [empresa, depId] : [];

    const totalRow  = await get(`SELECT COUNT(*) AS t FROM chat_solicitacoes WHERE empresa_id = ?${depClause()}`, [empresa, ...depP]);
    const abertasRow = await get(`SELECT COUNT(*) AS t FROM chat_solicitacoes WHERE empresa_id = ? AND status IN ${ABERTOS}${depClause()}`, [empresa, ...depP]);
    const concRow   = await get(`SELECT COUNT(*) AS t FROM chat_solicitacoes WHERE empresa_id = ? AND status = 'concluida'${depClause()}`, [empresa, ...depP]);
    const cancRow   = await get(`SELECT COUNT(*) AS t FROM chat_solicitacoes WHERE empresa_id = ? AND status = 'cancelada'${depClause()}`, [empresa, ...depP]);

    // Tempo médio de conclusão (horas)
    const tmRow = await get(
      `SELECT AVG(EXTRACT(EPOCH FROM (concluido_em::timestamp - created_at::timestamp))) AS seg
         FROM chat_solicitacoes
        WHERE empresa_id = ? AND status = 'concluida' AND concluido_em IS NOT NULL${depClause()}`,
      [empresa, ...depP]
    );
    const tempoMedioHoras = tmRow?.seg ? Math.round((Number(tmRow.seg) / 3600) * 10) / 10 : null;

    const porStatus = await all(
      `SELECT status, COUNT(*) AS total FROM chat_solicitacoes WHERE empresa_id = ?${depClause()} GROUP BY status`,
      [empresa, ...depP]
    );
    const porPrioridade = await all(
      `SELECT prioridade, COUNT(*) AS total FROM chat_solicitacoes
        WHERE empresa_id = ? AND status IN ${ABERTOS}${depClause()} GROUP BY prioridade`,
      [empresa, ...depP]
    );
    const porGrupo = await all(
      `SELECT COALESCE(g.nome,'Sem grupo') AS nome, g.emoji AS emoji, COUNT(*) AS total
         FROM chat_solicitacoes s
         LEFT JOIN chat_grupos g ON g.id = s.grupo_id
        WHERE s.empresa_id = ?${depClause('s.')}
        GROUP BY g.nome, g.emoji ORDER BY total DESC`,
      [empresa, ...depP]
    );
    // Carga por responsável (só abertas)
    const porResponsavel = await all(
      `SELECT COALESCE(responsavel_nome,'Sem responsável') AS nome, COUNT(*) AS total
         FROM chat_solicitacoes
        WHERE empresa_id = ? AND status IN ${ABERTOS}${depClause()}
        GROUP BY responsavel_nome ORDER BY total DESC`,
      [empresa, ...depP]
    );
    // Últimos 14 dias (por dia)
    const porDia = await all(
      `SELECT TO_CHAR(created_at::timestamp, 'YYYY-MM-DD') AS dia, COUNT(*) AS total
         FROM chat_solicitacoes
        WHERE empresa_id = ? AND created_at::timestamp >= (NOW() - INTERVAL '14 days')${depClause()}
        GROUP BY dia ORDER BY dia`,
      [empresa, ...depP]
    );

    res.json({
      departamento_id: depId,
      total: Number(totalRow?.t || 0),
      abertas: Number(abertasRow?.t || 0),
      concluidas: Number(concRow?.t || 0),
      canceladas: Number(cancRow?.t || 0),
      tempoMedioHoras,
      porStatus,
      porPrioridade,
      porGrupo,
      porResponsavel,
      porDia,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Web Push ──
router.get('/push/chave', (req, res) => res.json({ chave: VAPID_PUBLIC }));
router.post('/push/inscrever', async (req, res) => {
  try {
    const sub = req.body?.subscription || req.body;
    if (!sub || !sub.endpoint) return res.status(400).json({ erro: 'Inscrição inválida' });
    await run(
      `INSERT INTO chat_push_subs (id, empresa_id, usuario_id, endpoint, sub_json)
       VALUES (?,?,?,?,?)
       ON CONFLICT (endpoint) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, sub_json = EXCLUDED.sub_json`,
      [uuidv4(), eid(req), uid(req), sub.endpoint, JSON.stringify(sub)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Enviar um push de teste para mim mesmo (verificar se o push está ativo)
router.post('/push/testar', async (req, res) => {
  try {
    const subs = await all('SELECT COUNT(*) AS t FROM chat_push_subs WHERE empresa_id = ? AND usuario_id = ?', [eid(req), uid(req)]);
    const qtd = Number(subs?.[0]?.t || 0);
    await enviarPush(eid(req), uid(req), { titulo: 'Teste do Kronos', corpo: 'Se você recebeu isto, o push está funcionando! 🎉', solId: '' });
    res.json({ ok: true, inscricoes: qtd });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Novas demandas atribuídas a mim ainda não avisadas (para o alerta/push)
router.get('/minhas-novas', async (req, res) => {
  try {
    const rows = await all(
      `SELECT s.id, s.titulo, s.prioridade, s.topico_nome, s.criado_por_nome, s.aceite_prazo, g.nome AS grupo_nome, g.emoji AS grupo_emoji
         FROM chat_solicitacoes s
         LEFT JOIN chat_grupos g ON g.id = s.grupo_id
        WHERE s.empresa_id = ? AND s.responsavel_id = ? AND s.alerta_visto = 0
          AND s.status NOT IN ('concluida','cancelada')
        ORDER BY s.updated_at DESC`,
      [eid(req), uid(req)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/grupos', async (req, res) => {
  try {
    const grupos = await all(`SELECT * FROM chat_grupos WHERE empresa_id = ? ORDER BY nome`, [eid(req)]);
    for (const g of grupos) {
      g.responsaveis = await all(
        `SELECT d.id, d.nome FROM chat_grupo_responsaveis r JOIN departamentos d ON d.id = r.departamento_id WHERE r.grupo_id = ? ORDER BY d.nome`,
        [g.id]
      );
      g.participantes = await all(
        `SELECT d.id, d.nome FROM chat_grupo_part_deptos p JOIN departamentos d ON d.id = p.departamento_id WHERE p.grupo_id = ? ORDER BY d.nome`,
        [g.id]
      );
      g.topicos = await all(
        `SELECT id, nome FROM chat_topicos WHERE grupo_id = ? ORDER BY nome`,
        [g.id]
      );
    }
    res.json(grupos);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/grupos', soAdmin, async (req, res) => {
  try {
    const { nome, descricao, cor, emoji, responsaveis, participantes } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const id = uuidv4();
    await run(`INSERT INTO chat_grupos (id, empresa_id, nome, descricao, cor, emoji) VALUES (?,?,?,?,?,?)`,
      [id, eid(req), nome.trim(), descricao || null, cor || '#7B55F1', emoji || '💬']);
    if (Array.isArray(responsaveis)) {
      for (const did of responsaveis)
        await run(`INSERT INTO chat_grupo_responsaveis (grupo_id, departamento_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [id, did]);
    }
    if (Array.isArray(participantes)) {
      for (const did of participantes)
        await run(`INSERT INTO chat_grupo_part_deptos (grupo_id, departamento_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [id, did]);
    }
    res.status(201).json(await carregarGrupoCompleto(id));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/grupos/:id', soAdmin, async (req, res) => {
  try {
    const { nome, descricao, cor, emoji } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const g = await get('SELECT id FROM chat_grupos WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!g) return res.status(404).json({ erro: 'Grupo não encontrado' });
    await run(`UPDATE chat_grupos SET nome = ?, descricao = ?, cor = ?, emoji = ? WHERE id = ?`,
      [nome.trim(), descricao || null, cor || '#7B55F1', emoji || '💬', req.params.id]);
    res.json(await carregarGrupoCompleto(req.params.id));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/grupos/:id', soAdmin, async (req, res) => {
  try {
    const g = await get('SELECT id FROM chat_grupos WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!g) return res.status(404).json({ erro: 'Grupo não encontrado' });
    await run('DELETE FROM chat_grupo_responsaveis WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM chat_grupo_participantes WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM chat_grupo_part_deptos WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM chat_topicos WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM chat_grupo_membros WHERE grupo_id = ?', [req.params.id]);
    await run('DELETE FROM chat_grupos WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/grupos/:id/responsaveis', soAdmin, async (req, res) => {
  try {
    const { departamento_id } = req.body;
    await run(`INSERT INTO chat_grupo_responsaveis (grupo_id, departamento_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [req.params.id, departamento_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/grupos/:id/responsaveis/:did', soAdmin, async (req, res) => {
  try {
    await run('DELETE FROM chat_grupo_responsaveis WHERE grupo_id = ? AND departamento_id = ?', [req.params.id, req.params.did]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/grupos/:id/participantes', soAdmin, async (req, res) => {
  try {
    const { departamento_id } = req.body;
    await run(`INSERT INTO chat_grupo_part_deptos (grupo_id, departamento_id) VALUES (?,?) ON CONFLICT DO NOTHING`, [req.params.id, departamento_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/grupos/:id/participantes/:did', soAdmin, async (req, res) => {
  try {
    await run('DELETE FROM chat_grupo_part_deptos WHERE grupo_id = ? AND departamento_id = ?', [req.params.id, req.params.did]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Tópicos (filhos) do grupo ──
router.post('/grupos/:id/topicos', soAdmin, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome do tópico é obrigatório' });
    await run(`INSERT INTO chat_topicos (id, empresa_id, grupo_id, nome) VALUES (?,?,?,?)`,
      [uuidv4(), eid(req), req.params.id, nome.trim()]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.put('/grupos/:id/topicos/:tid', soAdmin, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Nome do tópico é obrigatório' });
    await run('UPDATE chat_topicos SET nome = ? WHERE id = ? AND grupo_id = ? AND empresa_id = ?',
      [nome.trim(), req.params.tid, req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/grupos/:id/topicos/:tid', soAdmin, async (req, res) => {
  try {
    await run('DELETE FROM chat_topicos WHERE id = ? AND grupo_id = ? AND empresa_id = ?',
      [req.params.tid, req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Canais de Departamento — DEVE vir antes de /:id ──────────

// Verifica se usuário tem acesso ao canal (depto ou membro individual)
async function temAcessoCanal(req, canal) {
  if (ehGestor(req)) return true;
  if (req.usuario.departamento_id === canal.departamento_id) return true;
  const m = await get('SELECT 1 FROM chat_canal_membros WHERE canal_id = ? AND usuario_id = ?', [canal.id, uid(req)]);
  return !!m;
}

// Lista os canais acessíveis ao usuário
router.get('/canais', async (req, res) => {
  try {
    if (ehGestor(req)) {
      const canais = await all(
        `SELECT c.*, d.nome AS departamento_nome
           FROM chat_canais c
           LEFT JOIN departamentos d ON d.id = c.departamento_id
          WHERE c.empresa_id = ? ORDER BY d.nome`,
        [eid(req)]
      );
      return res.json(canais);
    }

    const deptoId = req.usuario.departamento_id;
    // Auto-cria canal do próprio depto se ainda não existe
    if (deptoId) {
      const existe = await get('SELECT id FROM chat_canais WHERE empresa_id = ? AND departamento_id = ?', [eid(req), deptoId]);
      if (!existe) {
        const depto = await get('SELECT nome FROM departamentos WHERE id = ?', [deptoId]);
        await run(
          `INSERT INTO chat_canais (id, empresa_id, departamento_id, nome, emoji) VALUES (?, ?, ?, ?, '🏢')`,
          [uuidv4(), eid(req), deptoId, depto?.nome || 'Meu Departamento']
        );
      }
    }

    // Canais do próprio depto + canais onde foi adicionado individualmente
    const canais = await all(
      `SELECT DISTINCT c.*, d.nome AS departamento_nome
         FROM chat_canais c
         LEFT JOIN departamentos d ON d.id = c.departamento_id
        WHERE c.empresa_id = ?
          AND (c.departamento_id = ? OR EXISTS (
                SELECT 1 FROM chat_canal_membros m WHERE m.canal_id = c.id AND m.usuario_id = ?
              ))
        ORDER BY d.nome`,
      [eid(req), deptoId || '', uid(req)]
    );
    res.json(canais);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar canal para um departamento (admin)
router.post('/canais', soAdmin, async (req, res) => {
  try {
    const { departamento_id, nome, emoji } = req.body;
    if (!departamento_id || !nome?.trim()) return res.status(400).json({ erro: 'departamento_id e nome são obrigatórios' });
    const depto = await get('SELECT id FROM departamentos WHERE id = ? AND empresa_id = ?', [departamento_id, eid(req)]);
    if (!depto) return res.status(404).json({ erro: 'Departamento não encontrado' });
    const id = uuidv4();
    await run(
      `INSERT INTO chat_canais (id, empresa_id, departamento_id, nome, emoji)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (empresa_id, departamento_id) DO UPDATE SET nome=EXCLUDED.nome, emoji=EXCLUDED.emoji`,
      [id, eid(req), departamento_id, nome.trim(), emoji || '🏢']
    );
    const canal = await get('SELECT * FROM chat_canais WHERE empresa_id = ? AND departamento_id = ?', [eid(req), departamento_id]);
    res.json(canal);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Membros individuais de um canal
router.get('/canais/:id/membros', soAdmin, async (req, res) => {
  try {
    const canal = await get('SELECT * FROM chat_canais WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!canal) return res.status(404).json({ erro: 'Canal não encontrado' });
    const membros = await all(
      `SELECT u.id, u.nome, u.avatar, d.nome AS departamento_nome
         FROM chat_canal_membros m
         JOIN usuarios u ON u.id = m.usuario_id
         LEFT JOIN departamentos d ON d.id = u.departamento_id
        WHERE m.canal_id = ? ORDER BY u.nome`,
      [req.params.id]
    );
    res.json(membros);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Adicionar membro individual ao canal
router.post('/canais/:id/membros', soAdmin, async (req, res) => {
  try {
    const canal = await get('SELECT * FROM chat_canais WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!canal) return res.status(404).json({ erro: 'Canal não encontrado' });
    const { usuario_id } = req.body;
    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id é obrigatório' });
    const u = await get('SELECT id FROM usuarios WHERE id = ? AND empresa_id = ?', [usuario_id, eid(req)]);
    if (!u) return res.status(404).json({ erro: 'Usuário não encontrado' });
    await run(
      `INSERT INTO chat_canal_membros (canal_id, usuario_id, adicionado_por) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      [req.params.id, usuario_id, uid(req)]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Remover membro individual do canal
router.delete('/canais/:id/membros/:uid', soAdmin, async (req, res) => {
  try {
    await run('DELETE FROM chat_canal_membros WHERE canal_id = ? AND usuario_id = ?', [req.params.id, req.params.uid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mensagens de um canal
router.get('/canais/:id/mensagens', async (req, res) => {
  try {
    const canal = await get('SELECT * FROM chat_canais WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!canal) return res.status(404).json({ erro: 'Canal não encontrado' });
    if (!await temAcessoCanal(req, canal)) return res.status(403).json({ erro: 'Sem acesso a este canal' });
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const msgs = await all(
      `SELECT * FROM chat_canal_mensagens WHERE canal_id = ? ORDER BY created_at ASC LIMIT ?`,
      [req.params.id, limite]
    );
    res.json(msgs);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Enviar mensagem no canal
router.post('/canais/:id/mensagens', async (req, res) => {
  try {
    const canal = await get('SELECT * FROM chat_canais WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!canal) return res.status(404).json({ erro: 'Canal não encontrado' });
    if (!await temAcessoCanal(req, canal)) return res.status(403).json({ erro: 'Sem acesso a este canal' });
    const { texto, anexo, anexo_nome, anexo_tipo } = req.body;
    if (!texto?.trim() && !anexo) return res.status(400).json({ erro: 'Mensagem vazia' });
    const id = uuidv4();
    await run(
      `INSERT INTO chat_canal_mensagens (id, canal_id, empresa_id, usuario_id, usuario_nome, texto, anexo, anexo_nome, anexo_tipo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.params.id, eid(req), uid(req), unome(req), texto?.trim() || null, anexo || null, anexo_nome || null, anexo_tipo || null]
    );
    const msg = await get('SELECT * FROM chat_canal_mensagens WHERE id = ?', [id]);
    res.json(msg);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Excluir canal (admin)
router.delete('/canais/:id', soAdmin, async (req, res) => {
  try {
    await run('DELETE FROM chat_canal_membros WHERE canal_id = ?', [req.params.id]);
    await run('DELETE FROM chat_canal_mensagens WHERE canal_id = ?', [req.params.id]);
    await run('DELETE FROM chat_canais WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Verificar prazos de aceite vencidos (polling) — DEVE vir antes de /:id ──
router.post('/verificar-prazos', async (req, res) => {
  try {
    const empresa = eid(req);
    // Busca tickets distribuídos com prazo vencido desta empresa
    const vencidos = await all(
      `SELECT * FROM chat_solicitacoes
        WHERE empresa_id = ? AND status = 'distribuida' AND aceite_prazo IS NOT NULL AND aceite_prazo < NOW()`,
      [empresa]
    );
    let redistribuidos = 0;
    for (const sol of vencidos) {
      const resp = await distribuir(empresa, sol.grupo_id, sol.responsavel_id);
      if (resp) {
        await run(
          `UPDATE chat_solicitacoes SET responsavel_id=?, responsavel_nome=?, status='distribuida',
           alerta_visto=0, aceite_prazo=NOW() + INTERVAL '2 minutes',
           aceite_tentativas=COALESCE(aceite_tentativas,0)+1, ultimo_lembrete=NULL, updated_at=${NOW}
           WHERE id=?`,
          [resp.id, resp.nome, sol.id]
        );
        await run(
          `INSERT INTO chat_historico (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
           VALUES (?,?,?,?,?,?,?)`,
          [uuidv4(), sol.id, empresa, resp.id, resp.nome, 'redistribuida',
           `Prazo de aceite vencido; redistribuída para ${resp.nome}`]
        );
        await notificar(empresa, resp.id, 'Nova solicitação', `"${sol.titulo}" foi atribuída a você`);
        await enviarPush(empresa, resp.id, { titulo: 'Nova demanda para você', corpo: sol.titulo, solId: sol.id });
      } else {
        await run(
          `UPDATE chat_solicitacoes SET responsavel_id=NULL, responsavel_nome=NULL, status='nova',
           aceite_prazo=NULL, aceite_tentativas=0, alerta_visto=1, updated_at=${NOW}
           WHERE id=?`,
          [sol.id]
        );
        await run(
          `INSERT INTO chat_historico (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
           VALUES (?,?,?,?,?,?,?)`,
          [uuidv4(), sol.id, empresa, null, null, 'sem_atendente',
           'Prazo vencido; nenhum atendente disponível — retornada para fila']
        );
      }
      redistribuidos++;
    }
    res.json({ ok: true, redistribuidos });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Detalhe da solicitação (deve vir depois de /grupos e /canais) ──
router.get('/:id', async (req, res) => {
  try {
    const sol = await get(`${SEL} WHERE s.id = ? AND s.empresa_id = ?`, [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    const mensagens = await all('SELECT * FROM chat_mensagens WHERE solicitacao_id = ? ORDER BY created_at ASC', [req.params.id]);
    const historico = await all('SELECT * FROM chat_historico WHERE solicitacao_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...sol, mensagens, historico });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Criar solicitação (+ distribuição automática pelo grupo)
router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, categoria, grupo_id, topico_id, topico_nome, prioridade, anexo, anexo_nome, anexo_tipo } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Título é obrigatório' });
    if (!grupo_id) return res.status(400).json({ erro: 'Selecione um grupo' });
    const id = uuidv4();

    const resp = await distribuir(eid(req), grupo_id);
    const status = resp ? 'distribuida' : 'nova';

    await run(
      `INSERT INTO chat_solicitacoes
        (id, empresa_id, titulo, descricao, categoria, grupo_id, topico_id, topico_nome, prioridade, status, criado_por, criado_por_nome, responsavel_id, responsavel_nome)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, eid(req), titulo.trim(), descricao || null, categoria || 'geral', grupo_id, topico_id || null, topico_nome || null,
       prioridade || 'media', status, uid(req), unome(req), resp?.id || null, resp?.nome || null]
    );
    await logHist(id, req, 'criada', 'Solicitação aberta');
    if (resp) {
      await run(
        `UPDATE chat_solicitacoes SET alerta_visto=0, aceite_prazo=${ACEITE_PRAZO_SQL}, aceite_tentativas=1 WHERE id=?`,
        [id]
      );
      await logHist(id, req, 'distribuida', `Distribuída automaticamente para ${resp.nome}`);
      await notificar(eid(req), resp.id, 'Nova solicitação', `"${titulo.trim()}" foi atribuída a você`);
      await enviarPush(eid(req), resp.id, { titulo: 'Nova demanda para você', corpo: titulo.trim(), solId: id });
    }
    // Mensagem inicial opcional (anexo enviado na abertura)
    const temAnexo = anexo && typeof anexo === 'string' && anexo.startsWith('data:');
    if (temAnexo) {
      if (anexo.length > 5_500_000) return res.status(400).json({ erro: 'Anexo muito grande (máx. ~4MB).' });
      await run(
        `INSERT INTO chat_mensagens (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, texto, anexo, anexo_nome, anexo_tipo)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), id, eid(req), uid(req), unome(req), null, anexo, anexo_nome || 'anexo', anexo_tipo || null]
      );
    }
    res.status(201).json(await get(`${SEL} WHERE s.id = ?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function podeAgir(sol, req) {
  return ehGestor(req) || sol.criado_por === uid(req) || sol.responsavel_id === uid(req);
}

// Enviar mensagem na tratativa
router.post('/:id/mensagens', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão nesta solicitação' });
    const { texto, anexo, anexo_nome, anexo_tipo } = req.body;
    const temAnexo = anexo && typeof anexo === 'string' && anexo.startsWith('data:');
    if (!(texto && texto.trim()) && !temAnexo) return res.status(400).json({ erro: 'Mensagem vazia' });
    if (temAnexo && anexo.length > 5_500_000) return res.status(400).json({ erro: 'Anexo muito grande (máx. ~4MB).' });
    const mid = uuidv4();
    await run(
      `INSERT INTO chat_mensagens (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, texto, anexo, anexo_nome, anexo_tipo)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [mid, req.params.id, eid(req), uid(req), unome(req), texto?.trim() || null, temAnexo ? anexo : null, temAnexo ? (anexo_nome || 'anexo') : null, temAnexo ? (anexo_tipo || null) : null]
    );
    // Status automático conforme quem respondeu (não mexe em concluída/cancelada)
    let novoStatus = sol.status;
    if (!['concluida', 'cancelada'].includes(sol.status)) {
      if (uid(req) === sol.criado_por && uid(req) !== sol.responsavel_id) {
        // Solicitante escreveu → bola com o responsável
        novoStatus = 'em_atendimento';
      } else {
        // Responsável (ou atendente) escreveu → aguardando retorno do solicitante
        novoStatus = 'aguardando_retorno';
      }
    }
    await run(`UPDATE chat_solicitacoes SET status = ?, updated_at = ${NOW} WHERE id = ?`, [novoStatus, req.params.id]);
    if (novoStatus !== sol.status) {
      const rotulo = novoStatus === 'aguardando_retorno'
        ? `Aguardando retorno de ${sol.criado_por_nome || 'solicitante'}`
        : (novoStatus === 'em_atendimento' ? 'Em atendimento' : novoStatus);
      await logHist(req.params.id, req, 'status', rotulo);
    }
    // Notifica a outra parte
    const destino = uid(req) === sol.criado_por ? sol.responsavel_id : sol.criado_por;
    if (destino && destino !== uid(req)) await notificar(eid(req), destino, 'Nova mensagem', `"${sol.titulo}" tem uma nova mensagem`);
    res.status(201).json(await get('SELECT * FROM chat_mensagens WHERE id = ?', [mid]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Mudar status
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão' });
    const conc = status === 'concluida' ? NOW : 'NULL';
    await run(`UPDATE chat_solicitacoes SET status = ?, concluido_em = ${conc}, updated_at = ${NOW} WHERE id = ?`, [status, req.params.id]);
    await logHist(req.params.id, req, 'status', status);
    if (sol.criado_por && sol.criado_por !== uid(req)) await notificar(eid(req), sol.criado_por, 'Solicitação atualizada', `"${sol.titulo}" mudou para: ${status}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reatribuir responsável (manual)
router.patch('/:id/responsavel', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão' });
    const { responsavel_id } = req.body;
    let novo = null;
    if (responsavel_id) {
      novo = await get('SELECT id, nome FROM usuarios WHERE id = ? AND empresa_id = ?', [responsavel_id, eid(req)]);
      if (!novo) return res.status(404).json({ erro: 'Colaborador não encontrado' });
    }
    const novoStatus = novo ? (sol.status === 'nova' ? 'distribuida' : sol.status) : 'nova';
    const alerta = novo && novo.id !== uid(req) ? 0 : 1;
    const prazoClause = novo && novo.id !== uid(req)
      ? `, aceite_prazo=${ACEITE_PRAZO_SQL}, aceite_tentativas=1, ultimo_lembrete=NULL`
      : `, aceite_prazo=NULL, aceite_tentativas=0`;
    await run(
      `UPDATE chat_solicitacoes SET responsavel_id=?, responsavel_nome=?, status=?, alerta_visto=?${prazoClause}, updated_at=${NOW} WHERE id=?`,
      [novo?.id || null, novo?.nome || null, novoStatus, alerta, req.params.id]
    );
    await logHist(req.params.id, req, 'reatribuida', novo ? `Atribuída a ${novo.nome}` : 'Removido responsável');
    if (novo && novo.id !== uid(req)) {
      await notificar(eid(req), novo.id, 'Solicitação atribuída', `"${sol.titulo}" foi atribuída a você`);
      await enviarPush(eid(req), novo.id, { titulo: 'Nova demanda para você', corpo: sol.titulo, solId: req.params.id });
    }
    res.json(await get(`${SEL} WHERE s.id = ?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Redistribuir automaticamente
router.post('/:id/redistribuir', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!podeAgir(sol, req)) return res.status(403).json({ erro: 'Sem permissão' });
    const resp = await distribuir(eid(req), sol.grupo_id);
    if (!resp) return res.status(400).json({ erro: 'Nenhum colaborador disponível no departamento' });
    await run(
      `UPDATE chat_solicitacoes SET responsavel_id=?, responsavel_nome=?, status='distribuida',
       alerta_visto=0, aceite_prazo=${ACEITE_PRAZO_SQL}, aceite_tentativas=1, ultimo_lembrete=NULL,
       updated_at=${NOW} WHERE id=?`,
      [resp.id, resp.nome, req.params.id]
    );
    await logHist(req.params.id, req, 'distribuida', `Redistribuída para ${resp.nome}`);
    if (resp.id !== uid(req)) {
      await notificar(eid(req), resp.id, 'Solicitação atribuída', `"${sol.titulo}" foi atribuída a você`);
      await enviarPush(eid(req), resp.id, { titulo: 'Nova demanda para você', corpo: sol.titulo, solId: req.params.id });
    }
    res.json(await get(`${SEL} WHERE s.id = ?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Excluir solicitação (criador ou gestor) ───────────────────
router.delete('/:id', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (!ehGestor(req) && sol.criado_por !== uid(req)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM chat_mensagens WHERE solicitacao_id = ?', [req.params.id]);
    await run('DELETE FROM chat_historico WHERE solicitacao_id = ?', [req.params.id]);
    await run('DELETE FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Marcar alerta de nova demanda como visto (usuário fechou o overlay sem aceitar formalmente)
router.post('/:id/visto', async (req, res) => {
  try {
    await run('UPDATE chat_solicitacoes SET alerta_visto = 1 WHERE id = ? AND empresa_id = ? AND responsavel_id = ?',
      [req.params.id, eid(req), uid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Responsável pede para o solicitante aguardar alguns minutos — envia msg e re-alerta após 5min
router.patch('/:id/aguardar', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (sol.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Você não é o responsável desta solicitação' });

    const RE_ALERT_SQL = `TO_CHAR(NOW() - INTERVAL '3 hours' + INTERVAL '5 minutes', 'YYYY-MM-DD HH24:MI:SS')`;

    // Limpa prazo de redistribuição, marca como visto, agenda re-alerta em 5 min
    await run(
      `UPDATE chat_solicitacoes SET alerta_visto=1, aceite_prazo=NULL, ultimo_lembrete=NULL,
       re_alertar_em=${RE_ALERT_SQL}, updated_at=${NOW} WHERE id=?`,
      [req.params.id]
    );

    // Mensagem automática no chat para o solicitante
    const textoMsg = 'Aguarde alguns minutos, em breve iniciarei seu atendimento.';
    await run(
      `INSERT INTO chat_mensagens (id, solicitacao_id, empresa_id, usuario_id, usuario_nome, texto)
       VALUES (?,?,?,?,?,?)`,
      [uuidv4(), req.params.id, eid(req), uid(req), unome(req), textoMsg]
    );

    await logHist(req.params.id, req, 'aguardando_inicio', 'Responsável pediu para aguardar alguns minutos');

    // Notifica o solicitante
    if (sol.criado_por && sol.criado_por !== uid(req)) {
      await notificar(eid(req), sol.criado_por, 'Atendimento em breve', `${unome(req)}: "${textoMsg}"`);
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Fase 2: aceitar / recusar ──────────────────────────────────

// POST /:id/aceitar — atendente aceita o ticket formalmente
router.post('/:id/aceitar', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (sol.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Você não é o responsável desta solicitação' });
    await run(
      `UPDATE chat_solicitacoes SET status='em_atendimento', alerta_visto=1,
       aceite_prazo=NULL, ultimo_lembrete=NULL, re_alertar_em=NULL, updated_at=${NOW} WHERE id=?`,
      [req.params.id]
    );
    await logHist(req.params.id, req, 'aceita', 'Atendente aceitou o ticket');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// POST /:id/recusar — atendente recusa; redistribui para próximo disponível
router.post('/:id/recusar', async (req, res) => {
  try {
    const sol = await get('SELECT * FROM chat_solicitacoes WHERE id = ? AND empresa_id = ?', [req.params.id, eid(req)]);
    if (!sol) return res.status(404).json({ erro: 'Solicitação não encontrada' });
    if (sol.status !== 'distribuida') return res.status(400).json({ erro: 'Apenas tickets com status "distribuida" podem ser recusados' });
    if (sol.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Você não é o responsável desta solicitação' });

    const resp = await distribuir(eid(req), sol.grupo_id, sol.responsavel_id);
    if (resp) {
      await run(
        `UPDATE chat_solicitacoes SET responsavel_id=?, responsavel_nome=?, status='distribuida',
         alerta_visto=0, aceite_prazo=NOW() + INTERVAL '2 minutes',
         aceite_tentativas=COALESCE(aceite_tentativas,0)+1, ultimo_lembrete=NULL, updated_at=${NOW}
         WHERE id=?`,
        [resp.id, resp.nome, req.params.id]
      );
      await logHist(req.params.id, req, 'redistribuida', `Recusado por ${unome(req)}; redistribuída para ${resp.nome}`);
      await notificar(eid(req), resp.id, 'Nova solicitação', `"${sol.titulo}" foi atribuída a você`);
      await enviarPush(eid(req), resp.id, { titulo: 'Nova demanda para você', corpo: sol.titulo, solId: req.params.id });
    } else {
      await run(
        `UPDATE chat_solicitacoes SET responsavel_id=NULL, responsavel_nome=NULL, status='nova',
         aceite_prazo=NULL, aceite_tentativas=0, alerta_visto=1, updated_at=${NOW}
         WHERE id=?`,
        [req.params.id]
      );
      await logHist(req.params.id, req, 'sem_atendente', `Recusado por ${unome(req)}; nenhum atendente disponível — retornada para fila`);
    }
    res.json({ ok: true, redistribuida: !!resp, novo_responsavel: resp ? resp.nome : null });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});


module.exports = router;
