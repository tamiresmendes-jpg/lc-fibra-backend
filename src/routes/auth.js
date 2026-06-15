const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { erro: 'Muitas tentativas. Tente novamente em 15 minutos.' } });

const router = express.Router();

// Login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    const usuario = await get(`
    SELECT u.*, e.nome as empresa_nome, e.cor_primaria, d.nome as departamento_nome, c.nome as cargo_nome
    FROM usuarios u
    LEFT JOIN empresas e ON e.id = u.empresa_id
    LEFT JOIN departamentos d ON d.id = u.departamento_id
    LEFT JOIN cargos c ON c.id = u.cargo_id
    WHERE u.email = ? AND u.ativo = 1
  `, [email]);

    if (!usuario || !bcrypt.compareSync(senha, usuario.senha)) {
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, perfil: usuario.perfil, empresa_id: usuario.empresa_id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    const { senha: _, ...dadosUsuario } = usuario;
    res.json({ token, usuario: dadosUsuario });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Registrar (criar empresa + admin)
router.post('/registrar', async (req, res) => {
  try {
    const { nome_empresa, nome, email, senha } = req.body;
    if (!nome_empresa || !nome || !email || !senha) {
      return res.status(400).json({ erro: 'Todos os campos são obrigatórios' });
    }

    const existe = await get('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (existe) return res.status(400).json({ erro: 'Email já cadastrado' });

    const empresaId = uuidv4();
    const usuarioId = uuidv4();
    const senhaHash = bcrypt.hashSync(senha, 10);

    await run('INSERT INTO empresas (id, nome) VALUES (?, ?)', [empresaId, nome_empresa]);
    await run(`
    INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil)
    VALUES (?, ?, ?, ?, ?, 'admin')
  `, [usuarioId, empresaId, nome, email, senhaHash]);

    const token = jwt.sign(
      { id: usuarioId, email, perfil: 'admin', empresa_id: empresaId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.status(201).json({ token, usuario: { id: usuarioId, nome, email, perfil: 'admin', empresa_id: empresaId, empresa_nome: nome_empresa } });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Perfil atual
router.get('/me', autenticar, async (req, res) => {
  try {
    const usuario = await get(`
    SELECT u.id, u.nome, u.email, u.perfil, u.avatar, u.empresa_id,
           u.permissoes_modulos,
           e.nome as empresa_nome, e.cor_primaria, e.logo,
           d.nome as departamento_nome, c.nome as cargo_nome
    FROM usuarios u
    LEFT JOIN empresas e ON e.id = u.empresa_id
    LEFT JOIN departamentos d ON d.id = u.departamento_id
    LEFT JOIN cargos c ON c.id = u.cargo_id
    WHERE u.id = ?
  `, [req.usuario.id]);

    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

    // Parse permissoes_modulos JSON
    if (usuario.permissoes_modulos) {
      try { usuario.permissoes_modulos = JSON.parse(usuario.permissoes_modulos); } catch { usuario.permissoes_modulos = null; }
    }
    res.json(usuario);
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
