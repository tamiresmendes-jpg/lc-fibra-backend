const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const TIPOS_PERMITIDOS = [
  'application/pdf','text/plain','text/csv',
  'image/jpeg','image/png','image/gif','image/webp',
  'video/mp4','video/mpeg',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip','application/x-rar-compressed',
];

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (TIPOS_PERMITIDOS.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Tipo de arquivo não permitido'));
  },
});

// Listar anexos de um POP
router.get('/:popId/anexos', async (req, res) => {
  try {
    const anexos = await all(`
      SELECT a.*, u.nome as usuario_nome
      FROM pop_anexos a
      LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.pop_id = $1 AND a.empresa_id = $2
      ORDER BY a.created_at DESC
    `, [req.params.popId, req.usuario.empresa_id]);
    res.json(anexos);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Upload de arquivo
router.post('/:popId/anexos/upload', upload.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' });
    const id = uuidv4();
    await run(`
      INSERT INTO pop_anexos (id, pop_id, empresa_id, usuario_id, nome, tipo, tamanho, caminho)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      id, req.params.popId, req.usuario.empresa_id, req.usuario.id,
      req.file.originalname, req.file.mimetype, req.file.size, req.file.filename
    ]);
    const anexo = await get(`
      SELECT a.*, u.nome as usuario_nome
      FROM pop_anexos a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.id = $1
    `, [id]);
    res.status(201).json(anexo);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Adicionar link externo
router.post('/:popId/anexos/link', async (req, res) => {
  try {
    const { nome, url } = req.body;
    if (!url) return res.status(400).json({ erro: 'URL obrigatória' });
    const id = uuidv4();
    await run(`
      INSERT INTO pop_anexos (id, pop_id, empresa_id, usuario_id, nome, tipo, url_externa)
      VALUES ($1,$2,$3,$4,$5,'link',$6)
    `, [id, req.params.popId, req.usuario.empresa_id, req.usuario.id, nome || url, url]);
    const anexo = await get(`
      SELECT a.*, u.nome as usuario_nome
      FROM pop_anexos a LEFT JOIN usuarios u ON u.id = a.usuario_id
      WHERE a.id = $1
    `, [id]);
    res.status(201).json(anexo);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Download de arquivo (aceita token via query param para links diretos)
router.get('/:popId/anexos/:id/download', (req, res, next) => {
  if (req.query.token) {
    const jwt = require('jsonwebtoken');
    try {
      req.usuario = jwt.verify(req.query.token, process.env.JWT_SECRET);
    } catch { return res.status(401).json({ erro: 'Token inválido' }); }
    return next();
  }
  next();
}, async (req, res) => {
  try {
    const anexo = await get('SELECT * FROM pop_anexos WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado' });
    if (anexo.url_externa) return res.redirect(anexo.url_externa);
    const filePath = path.join(UPLOADS_DIR, anexo.caminho);
    if (!fs.existsSync(filePath)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
    res.download(filePath, anexo.nome);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Excluir anexo
router.delete('/:popId/anexos/:id', async (req, res) => {
  try {
    const anexo = await get('SELECT * FROM pop_anexos WHERE id = $1 AND empresa_id = $2', [req.params.id, req.usuario.empresa_id]);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado' });
    if (anexo.caminho) {
      const filePath = path.join(UPLOADS_DIR, anexo.caminho);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await run('DELETE FROM pop_anexos WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
