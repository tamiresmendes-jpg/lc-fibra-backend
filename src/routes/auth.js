const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { buscarPermsEfetivas } = require('../utils/permissoes');

const rateLimit = require('express-rate-limit');
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { erro: 'Muitas tentativas. Tente novamente em 15 minutos.' } });

const router = express.Router();

// Login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email) return res.status(400).json({ erro: 'Email obrigatório' });

    const usuario = await get(`
    SELECT u.*, e.nome as empresa_nome, e.cor_primaria, d.nome as departamento_nome, c.nome as cargo_nome
    FROM usuarios u
    LEFT JOIN empresas e ON e.id = u.empresa_id
    LEFT JOIN departamentos d ON d.id = u.departamento_id
    LEFT JOIN cargos c ON c.id = u.cargo_id
    WHERE u.email = ? AND u.ativo = 1
  `, [email]);

    if (!usuario) return res.status(401).json({ erro: 'Email ou senha incorretos' });

    if (usuario.primeiro_acesso === 1) {
      return res.status(200).json({ primeiro_acesso: true });
    }

    if (!senha) return res.status(400).json({ erro: 'Email e senha obrigatórios' });

    if (!bcrypt.compareSync(senha, usuario.senha)) {
      return res.status(401).json({ erro: 'Email ou senha incorretos' });
    }

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, perfil: usuario.perfil, empresa_id: usuario.empresa_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const { senha: _, ...dadosUsuario } = usuario;
    // Parse + merge group permissions
    let permModulos = null;
    if (dadosUsuario.permissoes_modulos) {
      try { permModulos = JSON.parse(dadosUsuario.permissoes_modulos); } catch { permModulos = null; }
    }
    if (dadosUsuario.perfil !== 'admin') {
      permModulos = await buscarPermsEfetivas(dadosUsuario.id, dadosUsuario.empresa_id, permModulos);
    }
    dadosUsuario.permissoes_modulos = permModulos;
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
      { expiresIn: '30d' }
    );

    res.status(201).json({ token, usuario: { id: usuarioId, nome, email, perfil: 'admin', empresa_id: empresaId, empresa_nome: nome_empresa } });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Definir senha no primeiro acesso (sem token, verificado por primeiro_acesso=1)
router.post('/definir-senha', async (req, res) => {
  try {
    const { email, nova_senha } = req.body;
    if (!email || !nova_senha) return res.status(400).json({ erro: 'Email e nova senha obrigatórios' });
    if (nova_senha.length < 6) return res.status(400).json({ erro: 'Senha deve ter no mínimo 6 caracteres' });

    const usuario = await get(`
      SELECT u.*, e.nome as empresa_nome, e.cor_primaria, d.nome as departamento_nome, c.nome as cargo_nome
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.empresa_id
      LEFT JOIN departamentos d ON d.id = u.departamento_id
      LEFT JOIN cargos c ON c.id = u.cargo_id
      WHERE u.email = ? AND u.ativo = 1
    `, [email]);

    if (!usuario || usuario.primeiro_acesso !== 1) {
      return res.status(403).json({ erro: 'Operação não permitida' });
    }

    const senhaHash = bcrypt.hashSync(nova_senha, 10);
    await run('UPDATE usuarios SET senha=?, primeiro_acesso=0 WHERE id=?', [senhaHash, usuario.id]);

    const token = jwt.sign(
      { id: usuario.id, email: usuario.email, perfil: usuario.perfil, empresa_id: usuario.empresa_id },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const { senha: _, ...dadosUsuario } = usuario;
    let permModulos = null;
    if (dadosUsuario.permissoes_modulos) {
      try { permModulos = JSON.parse(dadosUsuario.permissoes_modulos); } catch { permModulos = null; }
    }
    if (dadosUsuario.perfil !== 'admin') {
      permModulos = await buscarPermsEfetivas(dadosUsuario.id, dadosUsuario.empresa_id, permModulos);
    }
    dadosUsuario.permissoes_modulos = permModulos;
    res.json({ token, usuario: dadosUsuario });
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

    // Parse permissoes_modulos JSON + merge group permissions
    let permModulos = null;
    if (usuario.permissoes_modulos) {
      try { permModulos = JSON.parse(usuario.permissoes_modulos); } catch { permModulos = null; }
    }
    if (usuario.perfil !== 'admin') {
      permModulos = await buscarPermsEfetivas(usuario.id, usuario.empresa_id, permModulos);
    }
    usuario.permissoes_modulos = permModulos;
    res.json(usuario);
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
