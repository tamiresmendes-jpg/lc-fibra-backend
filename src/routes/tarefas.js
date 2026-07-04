const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
try { if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}
const uploadAtiv = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// Migrações idempotentes das melhorias de delegação
;(async () => {
  try {
    await run(`ALTER TABLE atividades ADD COLUMN IF NOT EXISTS obs_devolucao TEXT`);
    await run(`CREATE TABLE IF NOT EXISTS atividade_comentarios (
      id TEXT PRIMARY KEY, atividade_id TEXT NOT NULL, empresa_id TEXT NOT NULL,
      usuario_id TEXT, texto TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await run(`CREATE TABLE IF NOT EXISTS atividade_anexos (
      id TEXT PRIMARY KEY, atividade_id TEXT NOT NULL, empresa_id TEXT NOT NULL,
      usuario_id TEXT, nome TEXT, tipo TEXT, tamanho INTEGER, caminho TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  } catch {}
})();

router.use(autenticar);
const NOW = `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`;
function eid(req) { return req.usuario.empresa_id; }
function uid(req) { return req.usuario.id; }
function ehGestor(req) { return ['admin', 'gestor'].includes(req.usuario.perfil); }

const STATUS_VALIDOS = ['a_fazer', 'em_execucao', 'aguardando_aprovacao', 'concluido', 'reprovado', 'cancelado'];

async function logHist(tarefaId, req, acao, detalhe) {
  try {
    await run(
      `INSERT INTO tarefa_historico (id, tarefa_id, empresa_id, usuario_id, usuario_nome, acao, detalhe)
       VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(), tarefaId, eid(req), uid(req), req.usuario.nome || '', acao, detalhe || null]
    );
  } catch {}
}
async function notificar(empresaId, usuarioId, titulo, texto, link) {
  if (!usuarioId) return;
  try {
    await run(
      `INSERT INTO notificacoes (id, empresa_id, usuario_id, tipo, titulo, texto, link)
       VALUES (?,?,?, 'tarefa', ?,?,?)`,
      [uuidv4(), empresaId, usuarioId, titulo, texto || null, link || '/tarefas']
    );
  } catch {}
}
const SEL = `
  SELECT t.*, c.nome AS criador_nome, r.nome AS responsavel_nome, a.titulo AS atividade_titulo
    FROM tarefas t
    LEFT JOIN usuarios c ON c.id = t.criado_por
    LEFT JOIN usuarios r ON r.id = t.responsavel_id
    LEFT JOIN atividades a ON a.id = t.atividade_id`;

// ─── ATIVIDADES — rotas específicas ANTES de /:id para evitar shadowing ───────

const SEL_AT = `
  SELECT a.*,
         cp.nome AS criador_nome,
         rp.nome AS responsavel_nome,
         d.nome  AS departamento_nome
    FROM atividades a
    LEFT JOIN usuarios cp ON cp.id = a.criado_por_id
    LEFT JOIN usuarios rp ON rp.id = a.responsavel_id
    LEFT JOIN departamentos d ON d.id = a.departamento_id`;

router.get('/atividades', async (req, res) => {
  try {
    let rows;
    if (ehGestor(req)) {
      rows = await all(`${SEL_AT} WHERE a.empresa_id = ? AND a.excluido_em IS NULL ORDER BY a.created_at DESC`, [eid(req)]);
    } else {
      rows = await all(`${SEL_AT} WHERE a.empresa_id = ? AND a.excluido_em IS NULL AND a.responsavel_id = ? ORDER BY a.created_at DESC`, [eid(req), uid(req)]);
    }
    // inclui etapas em cada atividade
    for (const a of rows) {
      a.etapas = await all('SELECT * FROM atividade_etapas WHERE atividade_id = ? ORDER BY ordem', [a.id]);
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.post('/atividades', async (req, res) => {
  try {
    if (!ehGestor(req)) return res.status(403).json({ erro: 'Apenas gestores podem criar atividades' });
    const { titulo, descricao, responsavel_id, departamento_id, data_prazo, etapas } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Título é obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO atividades (id, empresa_id, titulo, descricao, criado_por_id, responsavel_id, departamento_id, data_prazo)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, eid(req), titulo.trim(), descricao || null, uid(req), responsavel_id || null, departamento_id || null, data_prazo || null]
    );
    if (Array.isArray(etapas)) {
      for (let i = 0; i < etapas.length; i++) {
        const e = etapas[i];
        if (!e.titulo || !e.titulo.trim()) continue;
        await run(
          `INSERT INTO atividade_etapas (id, atividade_id, titulo, descricao, responsavel_id, ordem, data_prazo) VALUES (?,?,?,?,?,?,?)`,
          [uuidv4(), id, e.titulo.trim(), e.descricao || null, e.responsavel_id || null, i, e.data_prazo || null]
        );
      }
    }
    if (responsavel_id && responsavel_id !== uid(req)) {
      await notificar(eid(req), responsavel_id, 'Nova atividade delegada', `${req.usuario.nome} delegou "${titulo.trim()}" para você`);
    }
    const atividade = await get(`${SEL_AT} WHERE a.id = ?`, [id]);
    atividade.etapas = await all('SELECT * FROM atividade_etapas WHERE atividade_id = ? ORDER BY ordem', [id]);
    res.status(201).json(atividade);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Relatório por colaborador (antes de /:id para não dar shadowing)
router.get('/atividades/relatorio', async (req, res) => {
  try {
    if (!ehGestor(req)) return res.status(403).json({ erro: 'Sem permissão' });
    const rows = await all(`
      SELECT u.id, u.nome,
        COUNT(a.id) AS total,
        COUNT(*) FILTER (WHERE a.status = 'concluida') AS concluidas,
        COUNT(*) FILTER (WHERE a.status <> 'concluida') AS pendentes,
        COUNT(*) FILTER (WHERE a.status <> 'concluida' AND a.data_prazo IS NOT NULL AND a.data_prazo < TO_CHAR(NOW() - INTERVAL '3 hours','YYYY-MM-DD')) AS atrasadas
      FROM usuarios u
      JOIN atividades a ON a.responsavel_id = u.id AND a.empresa_id = $1 AND a.excluido_em IS NULL
      WHERE u.empresa_id = $1
      GROUP BY u.id, u.nome
      ORDER BY total DESC, u.nome`, [eid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/atividades/:id', async (req, res) => {
  try {
    const a = await get(`${SEL_AT} WHERE a.id = ? AND a.empresa_id = ? AND a.excluido_em IS NULL`, [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    if (!ehGestor(req) && a.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Sem permissão' });
    a.etapas = await all('SELECT * FROM atividade_etapas WHERE atividade_id = ? ORDER BY ordem', [req.params.id]);
    res.json(a);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/atividades/:id', async (req, res) => {
  try {
    if (!ehGestor(req)) return res.status(403).json({ erro: 'Apenas gestores podem editar atividades' });
    const a = await get('SELECT * FROM atividades WHERE id = ? AND empresa_id = ? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    const { titulo, descricao, responsavel_id, departamento_id, status, data_prazo } = req.body;
    await run(
      `UPDATE atividades SET titulo=?, descricao=?, responsavel_id=?, departamento_id=?, status=?, data_prazo=?, updated_at=NOW() WHERE id=?`,
      [titulo?.trim() || a.titulo, descricao !== undefined ? descricao : a.descricao, responsavel_id !== undefined ? responsavel_id : a.responsavel_id, departamento_id !== undefined ? departamento_id : a.departamento_id, status || a.status, data_prazo !== undefined ? data_prazo : a.data_prazo, req.params.id]
    );
    const updated = await get(`${SEL_AT} WHERE a.id = ?`, [req.params.id]);
    updated.etapas = await all('SELECT * FROM atividade_etapas WHERE atividade_id = ? ORDER BY ordem', [req.params.id]);
    res.json(updated);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/atividades/:id', async (req, res) => {
  try {
    if (!ehGestor(req)) return res.status(403).json({ erro: 'Apenas gestores podem excluir atividades' });
    const a = await get('SELECT id FROM atividades WHERE id = ? AND empresa_id = ? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    await run('UPDATE atividades SET excluido_em = NOW(), updated_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/atividades/:id/etapas/:etapa_id', async (req, res) => {
  try {
    const a = await get('SELECT * FROM atividades WHERE id = ? AND empresa_id = ? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    if (!ehGestor(req) && a.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Sem permissão' });
    const etapa = await get('SELECT * FROM atividade_etapas WHERE id = ? AND atividade_id = ?', [req.params.etapa_id, req.params.id]);
    if (!etapa) return res.status(404).json({ erro: 'Etapa não encontrada' });
    const { titulo, descricao, responsavel_id, ordem, status, data_prazo } = req.body;
    await run(
      `UPDATE atividade_etapas SET titulo=?, descricao=?, responsavel_id=?, ordem=?, status=?, data_prazo=? WHERE id=?`,
      [titulo?.trim() || etapa.titulo, descricao !== undefined ? descricao : etapa.descricao, responsavel_id !== undefined ? responsavel_id : etapa.responsavel_id, ordem !== undefined ? ordem : etapa.ordem, status || etapa.status, data_prazo !== undefined ? data_prazo : etapa.data_prazo, req.params.etapa_id]
    );
    const todasEtapas = await all('SELECT status FROM atividade_etapas WHERE atividade_id = ?', [req.params.id]);
    if (todasEtapas.length > 0) {
      const todas = todasEtapas.map(e => e.status);
      let novoStatus = 'em_andamento';
      if (todas.every(s => s === 'concluida')) novoStatus = 'concluida';
      else if (todas.every(s => s === 'pendente')) novoStatus = 'pendente';
      await run('UPDATE atividades SET status = ?, updated_at = NOW() WHERE id = ?', [novoStatus, req.params.id]);
    }
    res.json(await get('SELECT * FROM atividade_etapas WHERE id = ?', [req.params.etapa_id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reatribuir (gestor troca o responsável)
router.patch('/atividades/:id/reatribuir', async (req, res) => {
  try {
    if (!ehGestor(req)) return res.status(403).json({ erro: 'Apenas gestores podem reatribuir' });
    const a = await get('SELECT * FROM atividades WHERE id=? AND empresa_id=? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    const { responsavel_id } = req.body;
    if (!responsavel_id) return res.status(400).json({ erro: 'Responsável obrigatório' });
    await run(`UPDATE atividades SET responsavel_id=?, obs_devolucao=NULL, updated_at=NOW() WHERE id=?`, [responsavel_id, req.params.id]);
    if (responsavel_id !== uid(req)) await notificar(eid(req), responsavel_id, 'Atividade atribuída a você', `${req.usuario.nome} atribuiu "${a.titulo}" para você`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Devolver (responsável devolve ao gestor com motivo)
router.patch('/atividades/:id/devolver', async (req, res) => {
  try {
    const a = await get('SELECT * FROM atividades WHERE id=? AND empresa_id=? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    if (a.responsavel_id !== uid(req) && !ehGestor(req)) return res.status(403).json({ erro: 'Apenas o responsável pode devolver' });
    const { motivo } = req.body;
    await run(`UPDATE atividades SET status='devolvida', obs_devolucao=?, updated_at=NOW() WHERE id=?`, [motivo || null, req.params.id]);
    if (a.criado_por_id) await notificar(eid(req), a.criado_por_id, 'Atividade devolvida', `${req.usuario.nome} devolveu "${a.titulo}"${motivo ? ': ' + motivo : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Comentários da atividade
router.get('/atividades/:id/comentarios', async (req, res) => {
  try {
    const rows = await all(`SELECT c.*, u.nome AS usuario_nome, (c.usuario_id=$3) AS meu
      FROM atividade_comentarios c LEFT JOIN usuarios u ON u.id=c.usuario_id
      WHERE c.atividade_id=$1 AND c.empresa_id=$2 ORDER BY c.created_at DESC`, [req.params.id, eid(req), uid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.post('/atividades/:id/comentarios', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Comentário vazio' });
    const a = await get('SELECT id FROM atividades WHERE id=? AND empresa_id=? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) return res.status(404).json({ erro: 'Atividade não encontrada' });
    const id = uuidv4();
    await run('INSERT INTO atividade_comentarios (id, atividade_id, empresa_id, usuario_id, texto) VALUES (?,?,?,?,?)', [id, req.params.id, eid(req), uid(req), texto.trim()]);
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/atividades/:id/comentarios/:cid', async (req, res) => {
  try {
    const c = await get('SELECT * FROM atividade_comentarios WHERE id=? AND empresa_id=?', [req.params.cid, eid(req)]);
    if (!c) return res.status(404).json({ erro: 'Comentário não encontrado' });
    if (c.usuario_id !== uid(req) && !ehGestor(req)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM atividade_comentarios WHERE id=?', [req.params.cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Anexos da atividade
router.get('/atividades/:id/anexos', async (req, res) => {
  try {
    const rows = await all(`SELECT a.*, u.nome AS usuario_nome FROM atividade_anexos a LEFT JOIN usuarios u ON u.id=a.usuario_id WHERE a.atividade_id=? AND a.empresa_id=? ORDER BY a.created_at DESC`, [req.params.id, eid(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.post('/atividades/:id/anexos/upload', uploadAtiv.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' });
    const a = await get('SELECT id FROM atividades WHERE id=? AND empresa_id=? AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!a) { try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {} return res.status(404).json({ erro: 'Atividade não encontrada' }); }
    const id = uuidv4();
    await run('INSERT INTO atividade_anexos (id, atividade_id, empresa_id, usuario_id, nome, tipo, tamanho, caminho) VALUES (?,?,?,?,?,?,?,?)',
      [id, req.params.id, eid(req), uid(req), req.file.originalname, req.file.mimetype, req.file.size, req.file.filename]);
    res.status(201).json(await get(`SELECT a.*, u.nome AS usuario_nome FROM atividade_anexos a LEFT JOIN usuarios u ON u.id=a.usuario_id WHERE a.id=?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.get('/atividades/:id/anexos/:aid/download', (req, res, next) => {
  if (req.query.token) { try { req.usuario = require('jsonwebtoken').verify(req.query.token, process.env.JWT_SECRET); } catch { return res.status(401).json({ erro: 'Token inválido' }); } }
  next();
}, async (req, res) => {
  try {
    const anexo = await get('SELECT * FROM atividade_anexos WHERE id=? AND empresa_id=?', [req.params.aid, req.usuario.empresa_id]);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado' });
    const fp = path.join(UPLOADS_DIR, anexo.caminho);
    if (!fs.existsSync(fp)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
    res.download(fp, anexo.nome);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/atividades/:id/anexos/:aid', async (req, res) => {
  try {
    const anexo = await get('SELECT * FROM atividade_anexos WHERE id=? AND empresa_id=?', [req.params.aid, eid(req)]);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado' });
    if (anexo.usuario_id !== uid(req) && !ehGestor(req)) return res.status(403).json({ erro: 'Sem permissão' });
    if (anexo.caminho) { const fp = path.join(UPLOADS_DIR, anexo.caminho); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await run('DELETE FROM atividade_anexos WHERE id=?', [req.params.aid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────

// Lista as tarefas do usuário (criadas por ele OU delegadas a ele)
router.get('/', async (req, res) => {
  try {
    const tarefas = await all(
      `${SEL} WHERE t.empresa_id = ? AND (t.criado_por = ? OR t.responsavel_id = ?)
       ORDER BY t.created_at DESC`,
      [eid(req), uid(req), uid(req)]
    );
    res.json(tarefas);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Detalhe completo (tarefa + anexos + comentários + histórico)
router.get('/:id', async (req, res) => {
  try {
    const tarefa = await get(`${SEL} WHERE t.id = ? AND t.empresa_id = ?`, [req.params.id, eid(req)]);
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    const anexos = await all('SELECT * FROM tarefa_anexos WHERE tarefa_id=? ORDER BY created_at', [req.params.id]);
    const podeVerPrivado = ehGestor(req) || tarefa.criado_por === uid(req);
    const comentarios = await all(
      `SELECT cm.*, u.nome AS autor_nome FROM tarefa_comentarios cm
        LEFT JOIN usuarios u ON u.id = cm.usuario_id
        WHERE cm.tarefa_id=? ${podeVerPrivado ? '' : 'AND cm.privado = 0'}
        ORDER BY cm.created_at`, [req.params.id]);
    const historico = await all('SELECT * FROM tarefa_historico WHERE tarefa_id=? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...tarefa, anexos, comentarios, historico });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Cria tarefa pessoal
router.post('/', async (req, res) => {
  try {
    const { titulo, descricao, prioridade, prazo } = req.body;
    if (!titulo || !titulo.trim()) return res.status(400).json({ erro: 'Título é obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO tarefas (id, empresa_id, titulo, descricao, prioridade, prazo, origem, status, criado_por, responsavel_id, aceito)
       VALUES (?,?,?,?,?,?, 'pessoal', 'a_fazer', ?, ?, 1)`,
      [id, eid(req), titulo.trim(), descricao || null, prioridade || 'media', prazo || null, uid(req), uid(req)]
    );
    await logHist(id, req, 'criada', 'Tarefa pessoal criada');
    res.status(201).json(await get(`${SEL} WHERE t.id = ?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Edita
router.put('/:id', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão para editar' });
    const { titulo, descricao, prioridade, prazo } = req.body;
    await run(
      `UPDATE tarefas SET titulo=?, descricao=?, prioridade=?, prazo=?, updated_at=${NOW} WHERE id=?`,
      [titulo?.trim() || t.titulo, descricao ?? t.descricao, prioridade || t.prioridade, prazo ?? t.prazo, req.params.id]
    );
    await logHist(req.params.id, req, 'editada', null);
    res.json(await get(`${SEL} WHERE t.id = ?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Muda status (drag and drop)
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUS_VALIDOS.includes(status)) return res.status(400).json({ erro: 'Status inválido' });
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    const conc = status === 'concluido' ? NOW : 'NULL';
    await run(`UPDATE tarefas SET status=?, concluido_em=${conc}, updated_at=${NOW} WHERE id=?`, [status, req.params.id]);
    await logHist(req.params.id, req, 'status', status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Aceite do responsável
router.patch('/:id/aceitar', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.responsavel_id !== uid(req)) return res.status(403).json({ erro: 'Apenas o responsável pode aceitar' });
    await run(`UPDATE tarefas SET aceito=1, status='em_execucao', updated_at=${NOW} WHERE id=?`, [req.params.id]);
    await logHist(req.params.id, req, 'aceita', 'Responsável aceitou a tarefa');
    if (t.criado_por) await notificar(eid(req), t.criado_por, 'Tarefa aceita', `${req.usuario.nome} aceitou "${t.titulo}"`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Concluir (responsável) — vai para aprovação se exigida, senão concluído
router.patch('/:id/concluir', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.responsavel_id !== uid(req) && t.criado_por !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    if (t.aprovacao_obrigatoria) {
      await run(`UPDATE tarefas SET status='aguardando_aprovacao', updated_at=${NOW} WHERE id=?`, [req.params.id]);
      await logHist(req.params.id, req, 'concluida', 'Enviada para aprovação');
      if (t.criado_por) await notificar(eid(req), t.criado_por, 'Aprovação pendente', `"${t.titulo}" aguarda sua aprovação`);
    } else {
      await run(`UPDATE tarefas SET status='concluido', concluido_em=${NOW}, updated_at=${NOW} WHERE id=?`, [req.params.id]);
      await logHist(req.params.id, req, 'concluida', null);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Aprovar (gestor ou criador)
router.patch('/:id/aprovar', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (!ehGestor(req) && t.criado_por !== uid(req)) return res.status(403).json({ erro: 'Sem permissão para aprovar' });
    await run(`UPDATE tarefas SET status='concluido', concluido_em=${NOW}, aprovado_por=?, updated_at=${NOW} WHERE id=?`, [uid(req), req.params.id]);
    await logHist(req.params.id, req, 'aprovada', null);
    if (t.responsavel_id) await notificar(eid(req), t.responsavel_id, 'Tarefa aprovada', `"${t.titulo}" foi aprovada`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Reprovar (volta para execução)
router.patch('/:id/reprovar', async (req, res) => {
  try {
    const { motivo } = req.body;
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (!ehGestor(req) && t.criado_por !== uid(req)) return res.status(403).json({ erro: 'Sem permissão' });
    await run(`UPDATE tarefas SET status='em_execucao', motivo_reprovacao=?, updated_at=${NOW} WHERE id=?`, [motivo || null, req.params.id]);
    await logHist(req.params.id, req, 'reprovada', motivo || null);
    if (t.responsavel_id) await notificar(eid(req), t.responsavel_id, 'Tarefa reprovada', `"${t.titulo}" foi reprovada${motivo ? ': ' + motivo : ''}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Checklist (JSON [{texto, feito}])
router.put('/:id/checklist', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    await run(`UPDATE tarefas SET checklist=?, updated_at=${NOW} WHERE id=?`, [JSON.stringify(req.body.checklist || []), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Anexos / evidências
router.post('/:id/anexos', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    const { nome, tipo, url } = req.body;
    if (!nome || !url) return res.status(400).json({ erro: 'Nome e arquivo/link obrigatórios' });
    const id = uuidv4();
    await run(`INSERT INTO tarefa_anexos (id, tarefa_id, empresa_id, usuario_id, nome, tipo, url) VALUES (?,?,?,?,?,?,?)`,
      [id, req.params.id, eid(req), uid(req), nome, tipo || null, url]);
    await logHist(req.params.id, req, 'anexo', nome);
    res.status(201).json(await get('SELECT * FROM tarefa_anexos WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/:id/anexos/:aid', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM tarefa_anexos WHERE id=? AND tarefa_id=? AND empresa_id=?', [req.params.aid, req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Comentários
router.post('/:id/comentarios', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && t.responsavel_id !== uid(req) && !ehGestor(req))
      return res.status(403).json({ erro: 'Sem permissão' });
    const { texto, privado } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Comentário vazio' });
    const priv = privado && ehGestor(req) ? 1 : 0; // só gestor cria privado
    const id = uuidv4();
    await run(`INSERT INTO tarefa_comentarios (id, tarefa_id, empresa_id, usuario_id, texto, privado) VALUES (?,?,?,?,?,?)`,
      [id, req.params.id, eid(req), uid(req), texto.trim(), priv]);
    await logHist(req.params.id, req, 'comentario', null);
    res.status(201).json(await get(
      `SELECT cm.*, u.nome AS autor_nome FROM tarefa_comentarios cm LEFT JOIN usuarios u ON u.id=cm.usuario_id WHERE cm.id=?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Exclui (criador)
router.delete('/:id', async (req, res) => {
  try {
    const t = await get('SELECT * FROM tarefas WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    if (!t) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (t.criado_por !== uid(req) && !ehGestor(req)) return res.status(403).json({ erro: 'Apenas o criador pode excluir' });
    await run('DELETE FROM tarefa_anexos WHERE tarefa_id=?', [req.params.id]);
    await run('DELETE FROM tarefa_comentarios WHERE tarefa_id=?', [req.params.id]);
    await run('DELETE FROM tarefa_historico WHERE tarefa_id=?', [req.params.id]);
    await run('DELETE FROM tarefas WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
