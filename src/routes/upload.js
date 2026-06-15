const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Garante que a pasta uploads existe
const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
    const mimePermitidos = [
      'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/webm',
      'image/jpeg', 'image/png',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ];
    if (mimePermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido'), false);
    }
  },
});

router.post('/', upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
  res.json({
    nome:     req.file.originalname,
    arquivo:  req.file.filename,
    url:      `/uploads/${req.file.filename}`,
    tamanho:  req.file.size,
    tipo:     req.file.mimetype,
  });
});

module.exports = router;
