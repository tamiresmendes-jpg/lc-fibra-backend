const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

// Verifica se usuario tem acesso ao modulo
function usuarioTemAcessoModulo(usuario, modulo) {
  if (usuario.perfil === 'admin') return true;
  if (!usuario.permissoes_modulos) return true;
  let perms = usuario.permissoes_modulos;
  if (typeof perms === 'string') { try { perms = JSON.parse(perms); } catch { return true; } }
  const chave = modulo.toLowerCase().replace(/\s+/g, '_');
  const v = perms[chave];
  if (!v || v === false) return false;
  return true;
}

// Lista alteracoes (admin vê todas, colaborador vê as do seu acesso)
router.get('/', async (req, res) => {
  try {
    const { modulo, nivel, pendentes } = req.query;
    let sql = `
      SELECT a.*, u.nome as criador_nome
      FROM alteracoes a
      LEFT JOIN usuarios u ON u.id = a.criado_por
      WHERE a.empresa_id = ? AND a.ativo = 1`;
    const params = [eid(req)];
    if (modulo) { sql += ' AND a.modulo = ?'; params.push(modulo); }
    if (nivel)  { sql += ' AND a.nivel = ?';  params.push(nivel);  }
    sql += ' ORDER BY a.created_at DESC';
    let lista = await all(sql, params);

    // Para cada alteracao, verifica se usuario ja leu
    lista = await Promise.all(lista.map(async a => {
      const ciencia = await get('SELECT id, created_at FROM alteracao_ciencias WHERE alteracao_id=? AND usuario_id=?', [a.id, req.usuario.id]);
      return { ...a, eu_li: !!ciencia, data_ciencia: ciencia?.created_at };
    }));

    if (pendentes === 'true') lista = lista.filter(a => !a.eu_li);

    res.json(lista);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Pendentes do usuario logado
router.get('/pendentes', async (req, res) => {
  try {
    const usuario = await get('SELECT * FROM usuarios WHERE id=?', [req.usuario.id]);
    const lista = await all(`
      SELECT a.*, u.nome as criador_nome
      FROM alteracoes a
      LEFT JOIN usuarios u ON u.id = a.criado_por
      WHERE a.empresa_id = ? AND a.ativo = 1
      AND NOT EXISTS (SELECT 1 FROM alteracao_ciencias c WHERE c.alteracao_id=a.id AND c.usuario_id=?)
      ORDER BY a.created_at DESC
    `, [eid(req), req.usuario.id]);

    // Filtra por permissao de modulo
    const filtrados = lista.filter(a => usuarioTemAcessoModulo(usuario, a.modulo));
    res.json(filtrados);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Contador de pendentes (para o bell)
router.get('/contador', async (req, res) => {
  try {
    const usuario = await get('SELECT * FROM usuarios WHERE id=?', [req.usuario.id]);
    const lista = await all(`
      SELECT a.modulo FROM alteracoes a
      WHERE a.empresa_id = ? AND a.ativo = 1
      AND NOT EXISTS (SELECT 1 FROM alteracao_ciencias c WHERE c.alteracao_id=a.id AND c.usuario_id=?)
    `, [eid(req), req.usuario.id]);
    const filtrados = lista.filter(a => usuarioTemAcessoModulo(usuario, a.modulo));
    res.json({ total: filtrados.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar alteracao (admin/gestor)
router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { modulo, titulo, tipo_acao, nivel, descricao, versao_anterior, versao_atual } = req.body;
    if (!modulo || !titulo || !tipo_acao) return res.status(400).json({ erro: 'Campos obrigatórios: modulo, titulo, tipo_acao' });
    const id = uuidv4();
    await run(`INSERT INTO alteracoes (id,empresa_id,modulo,titulo,tipo_acao,nivel,descricao,versao_anterior,versao_atual,criado_por)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, eid(req), modulo, titulo, tipo_acao, nivel||'informativa', descricao||null, versao_anterior||null, versao_atual||null, req.usuario.id]);
    res.status(201).json({ id });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Editar
router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const { modulo, titulo, tipo_acao, nivel, descricao, versao_anterior, versao_atual } = req.body;
    await run(`UPDATE alteracoes SET modulo=?,titulo=?,tipo_acao=?,nivel=?,descricao=?,versao_anterior=?,versao_atual=? WHERE id=? AND empresa_id=?`,
      [modulo, titulo, tipo_acao, nivel||'informativa', descricao||null, versao_anterior||null, versao_atual||null, req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Excluir (soft delete)
router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('UPDATE alteracoes SET ativo=0 WHERE id=? AND empresa_id=?', [req.params.id, eid(req)]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Confirmar ciencia
router.post('/:id/ciente', async (req, res) => {
  try {
    const existe = await get('SELECT id FROM alteracao_ciencias WHERE alteracao_id=? AND usuario_id=?', [req.params.id, req.usuario.id]);
    if (existe) return res.json({ ok: true, ja_confirmado: true });
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    await run('INSERT INTO alteracao_ciencias (id,alteracao_id,usuario_id,ip) VALUES (?,?,?,?)', [uuidv4(), req.params.id, req.usuario.id, ip]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Dashboard gerencial
router.get('/dashboard', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const totalAlteracoes = (await get('SELECT COUNT(*) as t FROM alteracoes WHERE empresa_id=? AND ativo=1', [eid(req)])).t;
    const totalCiencias   = (await get('SELECT COUNT(DISTINCT usuario_id) as t FROM alteracao_ciencias ac JOIN alteracoes a ON a.id=ac.alteracao_id WHERE a.empresa_id=?', [eid(req)])).t;
    const totalUsuarios   = (await get('SELECT COUNT(*) as t FROM usuarios WHERE empresa_id=? AND ativo=1', [eid(req)])).t;

    const porModulo = await all(`
      SELECT a.modulo,
        COUNT(DISTINCT a.id) as total_alteracoes,
        COUNT(DISTINCT ac.usuario_id) as total_cientes
      FROM alteracoes a
      LEFT JOIN alteracao_ciencias ac ON ac.alteracao_id = a.id
      WHERE a.empresa_id=? AND a.ativo=1
      GROUP BY a.modulo ORDER BY total_alteracoes DESC
    `, [eid(req)]);

    const porNivel = await all('SELECT nivel, COUNT(*) as total FROM alteracoes WHERE empresa_id=? AND ativo=1 GROUP BY nivel', [eid(req)]);

    const recentes = await all(`
      SELECT a.*, u.nome as criador_nome,
        COUNT(DISTINCT ac.usuario_id) as total_cientes
      FROM alteracoes a
      LEFT JOIN usuarios u ON u.id = a.criado_por
      LEFT JOIN alteracao_ciencias ac ON ac.alteracao_id = a.id
      WHERE a.empresa_id=? AND a.ativo=1
      GROUP BY a.id ORDER BY a.created_at DESC LIMIT 10
    `, [eid(req)]);

    // Usuarios pendentes por alteracao critica
    const criticas = await all(`
      SELECT a.id, a.titulo, a.modulo,
        (SELECT COUNT(*) FROM usuarios WHERE empresa_id=? AND ativo=1) -
        (SELECT COUNT(*) FROM alteracao_ciencias WHERE alteracao_id=a.id) as pendentes
      FROM alteracoes a
      WHERE a.empresa_id=? AND a.ativo=1 AND a.nivel='critica'
      ORDER BY pendentes DESC LIMIT 5
    `, [eid(req), eid(req)]);

    res.json({ totalAlteracoes, totalCiencias, totalUsuarios, porModulo, porNivel, recentes, criticas });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
