const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const VIDEOS_DIR = path.join(__dirname, '../../uploads/videos');
try { if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true }); } catch (_) {}

const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, VIDEOS_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
  // Sem limite de tamanho: vídeos de treinamento variam muito (de poucos MB a
  // vários GB). O limite real de fato é o espaço em disco do servidor.
  fileFilter: (req, file, cb) => {
    if ((file.mimetype || '').startsWith('video/')) return cb(null, true);
    cb(new Error('Apenas arquivos de vídeo são permitidos'));
  },
});

// ── DASHBOARD ────────────────────────────────────────────────────────────────
router.get('/dashboard-stats', autenticar, async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;
    const [totalTrein, concluidos, emAndamento, participantes] = await Promise.all([
      get(`SELECT COUNT(*) AS n FROM treinamentos WHERE empresa_id=? AND excluido_em IS NULL`, [eid]),
      get(`SELECT COUNT(*) AS n FROM treinamento_participantes tp JOIN treinamentos t ON t.id=tp.treinamento_id WHERE t.empresa_id=? AND tp.status='concluido'`, [eid]),
      get(`SELECT COUNT(*) AS n FROM treinamento_participantes tp JOIN treinamentos t ON t.id=tp.treinamento_id WHERE t.empresa_id=? AND tp.status='em_andamento'`, [eid]),
      get(`SELECT COUNT(DISTINCT tp.usuario_id) AS n FROM treinamento_participantes tp JOIN treinamentos t ON t.id=tp.treinamento_id WHERE t.empresa_id=?`, [eid]),
    ]);
    const recentes = await all(`SELECT t.titulo, t.status, t.created_at FROM treinamentos t WHERE t.empresa_id=? AND t.excluido_em IS NULL ORDER BY t.created_at DESC LIMIT 5`, [eid]);
    res.json({ totalTrein: totalTrein.n, concluidos: concluidos.n, emAndamento: emAndamento.n, participantes: participantes.n, recentes });
  } catch { res.status(500).json({ erro: 'Erro ao buscar stats' }); }
});

// ── CERTIFICADOS ─────────────────────────────────────────────────────────────
router.get('/certificados', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT tp.*, t.titulo AS treinamento_titulo, t.carga_horaria,
              u.nome AS colaborador_nome, d.nome AS departamento_nome
       FROM treinamento_participantes tp
       JOIN treinamentos t ON t.id = tp.treinamento_id
       JOIN usuarios u ON u.id = tp.usuario_id
       LEFT JOIN departamentos d ON d.id = u.departamento_id
       WHERE t.empresa_id = ? AND tp.status = 'concluido'
       ORDER BY tp.data_conclusao DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar certificados' }); }
});

// ── TRILHAS ──────────────────────────────────────────────────────────────────
router.get('/trilhas', autenticar, async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM trilhas_aprendizagem WHERE empresa_id=? ORDER BY created_at DESC`, [req.usuario.empresa_id]);
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar trilhas' }); }
});

router.post('/trilhas', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, nivel, departamento_id, carga_horaria } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO trilhas_aprendizagem (id,empresa_id,titulo,descricao,nivel,departamento_id,carga_horaria,criado_por) VALUES (?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, nivel || 'iniciante', departamento_id || null, carga_horaria || null, req.usuario.id]
    );
    res.status(201).json(await get(`SELECT * FROM trilhas_aprendizagem WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar trilha' }); }
});

router.put('/trilhas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM trilhas_aprendizagem WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, nivel, departamento_id, carga_horaria, status } = req.body;
    await run(
      `UPDATE trilhas_aprendizagem SET titulo=?,descricao=?,nivel=?,departamento_id=?,carga_horaria=?,status=? WHERE id=?`,
      [titulo, descricao || null, nivel || 'iniciante', departamento_id || null, carga_horaria || null, status || 'ativa', req.params.id]
    );
    res.json(await get(`SELECT * FROM trilhas_aprendizagem WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar trilha' }); }
});

router.delete('/trilhas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM trilhas_aprendizagem WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM trilhas_aprendizagem WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir trilha' }); }
});

// ── VÍDEOS ───────────────────────────────────────────────────────────────────
router.get('/videos', autenticar, async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM treinamento_videos WHERE empresa_id=? ORDER BY created_at DESC`, [req.usuario.empresa_id]);
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar vídeos' }); }
});

// ── PASTAS DE VÍDEOS ───────────────────────────────────────────────────────────
// IMPORTANTE: estas rotas fixas (/videos/pastas) precisam vir ANTES de
// /videos/:id abaixo — senão o Express casa "pastas" como se fosse um :id.
router.get('/videos/pastas', autenticar, async (req, res) => {
  try {
    const rows = await all(`
      SELECT p.*, COUNT(v.id) AS total_videos
      FROM treinamento_video_pastas p
      LEFT JOIN treinamento_videos v ON v.pasta_id = p.id
      WHERE p.empresa_id=?
      GROUP BY p.id
      ORDER BY p.nome
    `, [req.usuario.empresa_id]);
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar pastas' }); }
});

router.post('/videos/pastas', autenticar, async (req, res) => {
  try {
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    const id = uuidv4();
    await run(`INSERT INTO treinamento_video_pastas (id,empresa_id,nome,criado_por) VALUES (?,?,?,?)`, [id, req.usuario.empresa_id, nome, req.usuario.id]);
    res.status(201).json(await get(`SELECT *, 0 AS total_videos FROM treinamento_video_pastas WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar pasta' }); }
});

router.put('/videos/pastas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM treinamento_video_pastas WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { nome } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório' });
    await run(`UPDATE treinamento_video_pastas SET nome=? WHERE id=?`, [nome, req.params.id]);
    res.json(await get(`SELECT * FROM treinamento_video_pastas WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar pasta' }); }
});

// Exclui a pasta e solta os vídeos dela na raiz (não apaga os vídeos)
router.delete('/videos/pastas/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM treinamento_video_pastas WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`UPDATE treinamento_videos SET pasta_id=NULL WHERE pasta_id=?`, [req.params.id]);
    await run(`DELETE FROM treinamento_video_pastas WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir pasta' }); }
});

// Detalhe de um vídeo (página de assistir)
router.get('/videos/:id', autenticar, async (req, res) => {
  try {
    const video = await get(`SELECT * FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!video) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(video);
  } catch { res.status(500).json({ erro: 'Erro ao buscar vídeo' }); }
});

router.post('/videos', autenticar, async (req, res) => {
  try {
    const { titulo, descricao, url, duracao, categoria, tags, pasta_id } = req.body;
    if (!titulo || !url) return res.status(400).json({ erro: 'Título e URL são obrigatórios' });
    const id = uuidv4();
    await run(
      `INSERT INTO treinamento_videos (id,empresa_id,titulo,descricao,url,duracao,categoria,tags,criado_por,pasta_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, url, duracao || null, categoria || 'geral', tags || null, req.usuario.id, pasta_id || null]
    );
    res.status(201).json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar vídeo' }); }
});

router.put('/videos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { titulo, descricao, url, duracao, categoria, tags } = req.body;
    await run(
      `UPDATE treinamento_videos SET titulo=?,descricao=?,url=?,duracao=?,categoria=?,tags=? WHERE id=?`,
      [titulo, descricao || null, url, duracao || null, categoria || 'geral', tags || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar vídeo' }); }
});

// Move o vídeo para dentro de uma pasta (ou solta na raiz com pasta_id null)
router.put('/videos/:id/mover', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { pasta_id } = req.body;
    if (pasta_id) {
      const pasta = await get(`SELECT id FROM treinamento_video_pastas WHERE id=? AND empresa_id=?`, [pasta_id, req.usuario.empresa_id]);
      if (!pasta) return res.status(404).json({ erro: 'Pasta não encontrada' });
    }
    await run(`UPDATE treinamento_videos SET pasta_id=? WHERE id=?`, [pasta_id || null, req.params.id]);
    res.json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao mover vídeo' }); }
});

// Upload de arquivo de vídeo (em vez de link externo)
router.post('/videos/upload', autenticar, uploadVideo.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo de vídeo não enviado' });
    const { titulo, descricao, duracao, categoria, tags, pasta_id } = req.body;
    if (!titulo) {
      try { fs.unlinkSync(path.join(VIDEOS_DIR, req.file.filename)); } catch {}
      return res.status(400).json({ erro: 'Título é obrigatório' });
    }
    const id = uuidv4();
    await run(
      `INSERT INTO treinamento_videos (id,empresa_id,titulo,descricao,caminho,tipo,tamanho,duracao,categoria,tags,criado_por,pasta_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, titulo, descricao || null, req.file.filename, req.file.mimetype, req.file.size, duracao || null, categoria || 'geral', tags || null, req.usuario.id, pasta_id || null]
    );
    res.status(201).json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao enviar vídeo' }); }
});

// Substitui o arquivo de um vídeo já cadastrado (mantém ou troca metadados)
router.put('/videos/:id/upload', autenticar, uploadVideo.single('arquivo'), async (req, res) => {
  try {
    const exist = await get(`SELECT * FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) {
      if (req.file) { try { fs.unlinkSync(path.join(VIDEOS_DIR, req.file.filename)); } catch {} }
      return res.status(404).json({ erro: 'Não encontrado' });
    }
    const { titulo, descricao, duracao, categoria, tags } = req.body;
    const caminhoAntigo = exist.caminho;
    await run(
      `UPDATE treinamento_videos SET titulo=?,descricao=?,duracao=?,categoria=?,tags=?${req.file ? ',caminho=?,tipo=?,tamanho=?,url=NULL' : ''} WHERE id=?`,
      req.file
        ? [titulo, descricao || null, duracao || null, categoria || 'geral', tags || null, req.file.filename, req.file.mimetype, req.file.size, req.params.id]
        : [titulo, descricao || null, duracao || null, categoria || 'geral', tags || null, req.params.id]
    );
    if (req.file && caminhoAntigo) {
      try { fs.unlinkSync(path.join(VIDEOS_DIR, caminhoAntigo)); } catch {}
    }
    res.json(await get(`SELECT * FROM treinamento_videos WHERE id=?`, [req.params.id]));
  } catch (e) { res.status(500).json({ erro: e.message || 'Erro ao atualizar vídeo' }); }
});

router.delete('/videos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT * FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM treinamento_videos WHERE id=?`, [req.params.id]);
    if (exist.caminho) {
      const filePath = path.join(VIDEOS_DIR, exist.caminho);
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir vídeo' }); }
});

// Marca que o usuário abriu o vídeo (chamado ao entrar na página de assistir)
router.post('/videos/:id/iniciar', autenticar, async (req, res) => {
  try {
    const video = await get(`SELECT id FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!video) return res.status(404).json({ erro: 'Não encontrado' });
    const existente = await get(`SELECT id FROM treinamento_video_visualizacoes WHERE video_id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    const agora = `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`;
    if (existente) {
      await run(`UPDATE treinamento_video_visualizacoes SET ultima_visualizacao=${agora} WHERE id=?`, [existente.id]);
    } else {
      await run(
        `INSERT INTO treinamento_video_visualizacoes (id,video_id,usuario_id,empresa_id,iniciado_em,ultima_visualizacao) VALUES (?,?,?,?,${agora},${agora})`,
        [uuidv4(), req.params.id, req.usuario.id, req.usuario.empresa_id]
      );
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao registrar visualização' }); }
});

// Marca o vídeo como assistido até o fim (chamado no evento "ended" do player)
router.post('/videos/:id/concluir', autenticar, async (req, res) => {
  try {
    const video = await get(`SELECT id FROM treinamento_videos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!video) return res.status(404).json({ erro: 'Não encontrado' });
    const existente = await get(`SELECT id FROM treinamento_video_visualizacoes WHERE video_id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    const agora = `TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')`;
    if (existente) {
      await run(`UPDATE treinamento_video_visualizacoes SET concluido_em=${agora}, ultima_visualizacao=${agora} WHERE id=?`, [existente.id]);
    } else {
      await run(
        `INSERT INTO treinamento_video_visualizacoes (id,video_id,usuario_id,empresa_id,iniciado_em,concluido_em,ultima_visualizacao) VALUES (?,?,?,?,${agora},${agora},${agora})`,
        [uuidv4(), req.params.id, req.usuario.id, req.usuario.empresa_id]
      );
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao registrar conclusão' }); }
});

// Desfaz a marcação de concluído (a pessoa clicou errado ou quer reabrir depois)
router.post('/videos/:id/desmarcar-concluido', autenticar, async (req, res) => {
  try {
    await run(`UPDATE treinamento_video_visualizacoes SET concluido_em=NULL WHERE video_id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao desmarcar' }); }
});

// Status da própria visualização (pra refletir corretamente ao reabrir a página)
router.get('/videos/:id/minha-visualizacao', autenticar, async (req, res) => {
  try {
    const row = await get(`SELECT iniciado_em, concluido_em FROM treinamento_video_visualizacoes WHERE video_id=? AND usuario_id=?`, [req.params.id, req.usuario.id]);
    res.json(row || { iniciado_em: null, concluido_em: null });
  } catch { res.status(500).json({ erro: 'Erro ao buscar visualização' }); }
});

// Quem assistiu / não assistiu este vídeo (gestor/líder responsável pela biblioteca)
router.get('/videos/:id/visualizacoes', autenticar, async (req, res) => {
  try {
    const rows = await all(`
      SELECT u.id AS usuario_id, u.nome, u.avatar, d.nome AS departamento_nome,
             v.iniciado_em, v.concluido_em, v.ultima_visualizacao
      FROM usuarios u
      LEFT JOIN departamentos d ON d.id = u.departamento_id
      LEFT JOIN treinamento_video_visualizacoes v ON v.usuario_id = u.id AND v.video_id = ?
      WHERE u.empresa_id = ? AND u.ativo = 1
      ORDER BY (v.concluido_em IS NULL) DESC, u.nome
    `, [req.params.id, req.usuario.empresa_id]);
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar visualizações' }); }
});

// ── CURSOS EXTERNOS ──────────────────────────────────────────────────────────
router.get('/cursos-externos', autenticar, async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.*, u.nome AS colaborador_nome FROM cursos_externos c
       LEFT JOIN usuarios u ON u.id = c.colaborador_id
       WHERE c.empresa_id=? ORDER BY c.created_at DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch { res.status(500).json({ erro: 'Erro ao buscar cursos' }); }
});

router.post('/cursos-externos', autenticar, async (req, res) => {
  try {
    const { colaborador_id, titulo, instituicao, carga_horaria, data_inicio, data_conclusao, certificado, status, valor, observacoes } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(
      `INSERT INTO cursos_externos (id,empresa_id,colaborador_id,titulo,instituicao,carga_horaria,data_inicio,data_conclusao,certificado,status,valor,observacoes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.usuario.empresa_id, colaborador_id || null, titulo, instituicao || null, carga_horaria || null, data_inicio || null, data_conclusao || null, certificado ? 1 : 0, status || 'em_andamento', valor || null, observacoes || null]
    );
    res.status(201).json(await get(`SELECT * FROM cursos_externos WHERE id=?`, [id]));
  } catch { res.status(500).json({ erro: 'Erro ao criar curso' }); }
});

router.put('/cursos-externos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cursos_externos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    const { colaborador_id, titulo, instituicao, carga_horaria, data_inicio, data_conclusao, certificado, status, valor, observacoes } = req.body;
    await run(
      `UPDATE cursos_externos SET colaborador_id=?,titulo=?,instituicao=?,carga_horaria=?,data_inicio=?,data_conclusao=?,certificado=?,status=?,valor=?,observacoes=? WHERE id=?`,
      [colaborador_id || null, titulo, instituicao || null, carga_horaria || null, data_inicio || null, data_conclusao || null, certificado ? 1 : 0, status || 'em_andamento', valor || null, observacoes || null, req.params.id]
    );
    res.json(await get(`SELECT * FROM cursos_externos WHERE id=?`, [req.params.id]));
  } catch { res.status(500).json({ erro: 'Erro ao atualizar curso' }); }
});

router.delete('/cursos-externos/:id', autenticar, async (req, res) => {
  try {
    const exist = await get(`SELECT id FROM cursos_externos WHERE id=? AND empresa_id=?`, [req.params.id, req.usuario.empresa_id]);
    if (!exist) return res.status(404).json({ erro: 'Não encontrado' });
    await run(`DELETE FROM cursos_externos WHERE id=?`, [req.params.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ erro: 'Erro ao excluir curso' }); }
});

module.exports = router;
