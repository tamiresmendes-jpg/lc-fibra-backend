const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

// Mescla permissões de módulos: retorna a união de perms do usuário + grupos
// Nível mais alto vence: editar > visualizar > false
function mesclarPermissoes(userPerms, grupoPermsList) {
  if (!grupoPermsList || grupoPermsList.length === 0) return userPerms;
  if (!userPerms && grupoPermsList.every(g => !g)) return null; // todos nulos = sem restrição
  // Começa com as permissões do usuário ou cria um objeto vazio para mescla
  const base = userPerms ? JSON.parse(JSON.stringify(userPerms)) : {};
  for (const gPerms of grupoPermsList) {
    if (!gPerms) return null; // grupo sem restrição → acesso total
    for (const [modulo, valor] of Object.entries(gPerms)) {
      if (!base[modulo] || base[modulo] === false) {
        base[modulo] = valor;
      } else if (valor && valor !== false) {
        if (base[modulo] === true || base[modulo] === 'editar') continue; // já no máximo
        if (valor === true || valor === 'editar') { base[modulo] = valor; continue; }
        if (typeof base[modulo] === 'object' && typeof valor === 'object') {
          base[modulo] = { enabled: true, itens: { ...(base[modulo].itens || {}) } };
          for (const [item, nivelGrupo] of Object.entries(valor.itens || {})) {
            const nivelAtual = base[modulo].itens[item];
            if (!nivelAtual || nivelAtual === false) base[modulo].itens[item] = nivelGrupo;
            else if (nivelAtual === 'visualizar' && (nivelGrupo === 'editar' || nivelGrupo === true)) base[modulo].itens[item] = nivelGrupo;
          }
        }
      }
    }
  }
  return base;
}

async function buscarPermsEfetivas(usuarioId, empresaId, permModulos) {
  try {
    // Grupos por usuário direto
    const gruposDiretos = await all(
      'SELECT g.permissoes_modulos FROM grupos_permissao g JOIN grupo_membros gm ON gm.grupo_id = g.id WHERE gm.usuario_id = ? AND g.empresa_id = ?',
      [usuarioId, empresaId]
    );
    // Grupos por departamento
    const usuario = await get('SELECT departamento_id FROM usuarios WHERE id = ?', [usuarioId]);
    let gruposDept = [];
    if (usuario?.departamento_id) {
      gruposDept = await all(
        'SELECT g.permissoes_modulos FROM grupos_permissao g JOIN grupo_departamentos gd ON gd.grupo_id = g.id WHERE gd.departamento_id = ? AND g.empresa_id = ?',
        [usuario.departamento_id, empresaId]
      );
    }
    const todasPerms = [...gruposDiretos, ...gruposDept]
      .map(g => { try { return g.permissoes_modulos ? JSON.parse(g.permissoes_modulos) : null; } catch { return null; } });
    return mesclarPermissoes(permModulos, todasPerms);
  } catch { return permModulos; }
}

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
