const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Garante que a pasta uploads existe
const UPLOAD_DIR = path.join(__dirname, '../../uploads');
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    const nome = `${Date.now()}_${base}${ext}`;
    cb(null, nome);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const mime = file.mimetype || '';
    // Qualquer imagem (jpeg, png, webp, gif, heic/heif de iPhone, bmp, svg…) e vídeo
    if (mime.startsWith('image/') || mime.startsWith('video/')) return cb(null, true);
    const outrosPermitidos = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint',
      'text/plain', 'text/csv',
    ];
    if (outrosPermitidos.includes(mime)) return cb(null, true);
    cb(new Error('Tipo de arquivo não permitido'), false);
  },
});

const uploadSingle = upload.single('arquivo');
router.post('/', (req, res) => {
  uploadSingle(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Arquivo muito grande (máximo 100MB).'
        : (err.message || 'Falha ao enviar o arquivo.');
      return res.status(400).json({ erro: msg });
    }
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    res.json({
      nome:     req.file.originalname,
      arquivo:  req.file.filename,
      url:      `/uploads/${req.file.filename}`,
      tamanho:  req.file.size,
      tipo:     req.file.mimetype,
    });
  });
});

module.exports = router;
