const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');

const router = express.Router();
router.use(autenticar);

// Normaliza data de nascimento — aceita dd/mm/aaaa, dd-mm-aaaa, aaaa-mm-dd, dd/mm
function normalizarData(raw) {
  if (!raw || !raw.toString().trim()) return null;
  const s = raw.toString().trim();
  const m1 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;
  const m2 = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m2) return `${m2[1]}-${m2[2].padStart(2,'0')}-${m2[3].padStart(2,'0')}`;
  const m3 = s.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m3) return `1900-${m3[2].padStart(2,'0')}-${m3[1].padStart(2,'0')}`;
  return null;
}

// Listar usuários da empresa
router.get('/', async (req, res) => {
  try {
    const { departamento_id, ativo } = req.query;
    let sql = `
    SELECT u.id, u.nome, u.email, u.perfil, u.avatar, u.ativo, u.created_at,
           u.departamento_id, u.cargo_id, u.gestor_id, u.setor_id, u.funcao, u.bloqueado, u.sort_order, u.cor, u.nivel,
           u.data_nascimento, u.matricula, u.permissoes_modulos,
           d.nome as departamento_nome, c.nome as cargo_nome,
           g.nome as gestor_nome, s.nome as setor_nome
    FROM usuarios u
    LEFT JOIN departamentos d ON d.id = u.departamento_id
    LEFT JOIN cargos c ON c.id = u.cargo_id
    LEFT JOIN usuarios g ON g.id = u.gestor_id
    LEFT JOIN setores s ON s.id = u.setor_id
    WHERE u.empresa_id = ?`;
    const params = [req.usuario.empresa_id];
    if (departamento_id) { sql += ' AND u.departamento_id = ?'; params.push(departamento_id); }
    if (ativo !== undefined) { sql += ' AND u.ativo = ?'; params.push(ativo === 'true' ? 1 : 0); }
    sql += ' ORDER BY u.sort_order ASC, u.nome ASC';
    res.json(await all(sql, params));
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Criar usuário
router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor'].includes(req.usuario.perfil)) {
      return res.status(403).json({ erro: 'Sem permissão para criar usuários' });
    }
    const { nome, email, senha, perfil, departamento_id, cargo_id, gestor_id, setor_id, funcao, nivel } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Nome, email e senha obrigatórios' });

    const existe = await get('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (existe) return res.status(400).json({ erro: 'Email já cadastrado' });

    const id = uuidv4();
    const senhaHash = bcrypt.hashSync(senha, 10);
    await run(`
    INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil, departamento_id, cargo_id, gestor_id, setor_id, funcao, nivel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
      id, req.usuario.empresa_id, nome, email, senhaHash,
      perfil || 'colaborador',
      departamento_id || null, cargo_id || null, gestor_id || null,
      setor_id || null, funcao || null, nivel || null
    ]);

    res.status(201).json({ id, nome, email, perfil: perfil || 'colaborador' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Buscar usuário
router.get('/:id', async (req, res) => {
  try {
    const usuario = await get(`
    SELECT u.id, u.nome, u.email, u.perfil, u.avatar, u.ativo, u.departamento_id, u.cargo_id, u.gestor_id,
           d.nome as departamento_nome, c.nome as cargo_nome
    FROM usuarios u
    LEFT JOIN departamentos d ON d.id = u.departamento_id
    LEFT JOIN cargos c ON c.id = u.cargo_id
    WHERE u.id = ? AND u.empresa_id = ?
  `, [req.params.id, req.usuario.empresa_id]);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(usuario);
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Atualizar usuário
router.put('/:id', async (req, res) => {
  try {
    const { nome, perfil, departamento_id, cargo_id, gestor_id, setor_id, funcao, nivel, ativo, bloqueado, data_nascimento, avatar, permissoes_modulos } = req.body;
    await run(`
    UPDATE usuarios SET nome=?, perfil=?, departamento_id=?, cargo_id=?, gestor_id=?,
      setor_id=?, funcao=?, nivel=?, ativo=?, bloqueado=?, data_nascimento=?, avatar=?, permissoes_modulos=?
    WHERE id=? AND empresa_id=?
  `, [
      nome, perfil,
      departamento_id || null, cargo_id || null, gestor_id || null, setor_id || null,
      funcao || null, nivel || null,
      ativo !== undefined ? ativo : 1,
      bloqueado !== undefined ? bloqueado : 0,
      data_nascimento || null, avatar || null,
      permissoes_modulos ? JSON.stringify(permissoes_modulos) : null,
      req.params.id, req.usuario.empresa_id
    ]);
    res.json({ mensagem: 'Usuário atualizado' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Atualizar hierarquia (gestor_id) e/ou cor — usado pelo organograma
router.patch('/:id/organograma', async (req, res) => {
  try {
    const { gestor_id, cor } = req.body;
    const sets = [];
    const vals = [];
    if ('gestor_id' in req.body) { sets.push('gestor_id=?'); vals.push(gestor_id || null); }
    if ('cor'      in req.body) { sets.push('cor=?');       vals.push(cor || null); }
    if (!sets.length) return res.status(400).json({ erro: 'Nada a atualizar' });
    vals.push(req.params.id, req.usuario.empresa_id);
    await run(`UPDATE usuarios SET ${sets.join(',')} WHERE id=? AND empresa_id=?`, vals);
    res.json({ ok: true });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Bloquear/desbloquear usuário
router.patch('/:id/bloquear', async (req, res) => {
  try {
    const usuario = await get('SELECT bloqueado FROM usuarios WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const novo = usuario.bloqueado ? 0 : 1;
    await run('UPDATE usuarios SET bloqueado=? WHERE id=?', [novo, req.params.id]);
    res.json({ bloqueado: novo });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Alterar senha
router.patch('/:id/senha', async (req, res) => {
  try {
    const { senha_atual, nova_senha } = req.body;
    if (!nova_senha || nova_senha.length < 8) {
      return res.status(400).json({ erro: 'Senha deve ter no mínimo 8 caracteres' });
    }

    const usuario = await get('SELECT senha FROM usuarios WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });

    // Admin pode redefinir sem senha atual; outros precisam confirmar
    const ehAdmin = req.usuario.perfil === 'admin';
    const ehOProprio = req.usuario.id === req.params.id;

    if (!ehAdmin) {
      if (!senha_atual) return res.status(400).json({ erro: 'Senha atual obrigatória' });
      if (!bcrypt.compareSync(senha_atual, usuario.senha)) return res.status(400).json({ erro: 'Senha atual incorreta' });
    }

    const novaHash = bcrypt.hashSync(nova_senha, 10);
    await run('UPDATE usuarios SET senha=? WHERE id=?', [novaHash, req.params.id]);
    res.json({ mensagem: 'Senha alterada com sucesso' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Importar usuários em lote (CSV)
router.post('/importar', async (req, res) => {
  try {
    const { usuarios } = req.body;
    if (!Array.isArray(usuarios) || usuarios.length === 0)
      return res.status(400).json({ erro: 'Nenhum usuário enviado' });

    const resultados = [];

    for (const u of usuarios) {
      // Ignora linhas sem nome real ou que parecem ser integrações/sistemas
      if (!u.nome || u.nome.trim().length < 3 || /integra[cç]/i.test(u.nome)) {
        resultados.push({ email: u.email || '?', status: 'ignorado', motivo: 'Linha ignorada (sem nome válido)' });
        continue;
      }
      if (!u.email || !u.senha) {
        // Gera e-mail automático se não tiver
        if (!u.email) {
          u.email = u.nome.trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/\s+/g, '.').replace(/[^a-z.]/g, '')
            + '@lcfibra.com.br';
        }
        if (!u.senha) u.senha = 'Mudar@123';
      }
      // Busca por email OU por nome (para arquivos sem email)
      let existe = await get('SELECT id, perfil FROM usuarios WHERE email = ? AND empresa_id = ?', [u.email.trim(), req.usuario.empresa_id]);
      if (!existe && u.nome) {
        existe = await get('SELECT id, perfil FROM usuarios WHERE empresa_id = ? AND LOWER(nome) = LOWER(?)', [req.usuario.empresa_id, u.nome.trim()]);
      }
      if (existe) {
        // Atualiza dados sem alterar perfil/nível de acesso
        const dataNorm = normalizarData(u.data_nascimento || u.aniversario);
        await run(`UPDATE usuarios SET data_nascimento = COALESCE(?, data_nascimento), matricula = COALESCE(?, matricula) WHERE id = ?`, [dataNorm || null, u.matricula || null, existe.id]);
        resultados.push({ email: u.email, status: 'atualizado', nome: u.nome, ativo: 1 });
        continue;
      }
      try {
        const id = uuidv4();
        const senhaHash = bcrypt.hashSync(u.senha.toString(), 10);

        // Resolver ou CRIAR departamento
        let departamento_id = null;
        if (u.departamento && u.departamento.trim()) {
          const nomeDepto = u.departamento.trim();
          let dept = await get('SELECT id FROM departamentos WHERE empresa_id=? AND LOWER(nome)=LOWER(?)', [req.usuario.empresa_id, nomeDepto]);
          if (!dept) {
            const novoId = uuidv4();
            await run('INSERT INTO departamentos (id, empresa_id, nome) VALUES (?, ?, ?)', [novoId, req.usuario.empresa_id, nomeDepto]);
            dept = { id: novoId };
          }
          departamento_id = dept.id;
        }

        // Resolver ou CRIAR setor
        let setor_id = null;
        if (u.setor && u.setor.trim()) {
          const nomeSetor = u.setor.trim();
          let setor = await get('SELECT id FROM setores WHERE empresa_id=? AND LOWER(nome)=LOWER(?)', [req.usuario.empresa_id, nomeSetor]);
          if (!setor) {
            const novoId = uuidv4();
            await run('INSERT INTO setores (id, empresa_id, nome, departamento_id) VALUES (?, ?, ?, ?)', [novoId, req.usuario.empresa_id, nomeSetor, departamento_id]);
            setor = { id: novoId };
          }
          setor_id = setor.id;
        }

        // Resolver ou CRIAR cargo
        let cargo_id = null;
        if (u.cargo && u.cargo.trim()) {
          const nomeCargo = u.cargo.trim();
          let cargo = await get('SELECT id FROM cargos WHERE empresa_id=? AND LOWER(nome)=LOWER(?)', [req.usuario.empresa_id, nomeCargo]);
          if (!cargo) {
            const novoId = uuidv4();
            await run('INSERT INTO cargos (id, empresa_id, nome, departamento_id) VALUES (?, ?, ?, ?)', [novoId, req.usuario.empresa_id, nomeCargo, departamento_id]);
            cargo = { id: novoId };
          }
          cargo_id = cargo.id;
        }

        // Resolver gestor por e-mail
        let gestor_id = null;
        if (u.gestor_email) {
          const gestor = await get('SELECT id FROM usuarios WHERE empresa_id=? AND email=?', [req.usuario.empresa_id, u.gestor_email.trim()]);
          if (gestor) gestor_id = gestor.id;
        }

        const perfisValidos = ['admin', 'gestor', 'colaborador'];
        const perfil = perfisValidos.includes(u.perfil) ? u.perfil : 'colaborador';

        // Ativo = tem "Número da Folha" preenchido (campo folha). Vazio = ex-funcionário (inativo)
        const ativo = (u.folha !== undefined && u.folha !== null && u.folha.toString().trim() !== '') ? 1 : 0;

        const data_nascimento = normalizarData(u.data_nascimento || u.aniversario || u.aniversário);

        await run(`
        INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil, departamento_id, cargo_id, gestor_id, setor_id, funcao, ativo, matricula, data_nascimento)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, req.usuario.empresa_id, u.nome.trim(), u.email.trim(), senhaHash, perfil,
               departamento_id, cargo_id, gestor_id, setor_id, u.funcao || null, ativo, u.matricula || null, data_nascimento]);

        resultados.push({ email: u.email, status: 'ok', nome: u.nome, ativo });
      } catch (err) {
        resultados.push({ email: u.email, status: 'erro', motivo: err.message });
      }
    }

    const importados  = resultados.filter(r => r.status === 'ok').length;
    const atualizados = resultados.filter(r => r.status === 'atualizado').length;
    const ativos      = resultados.filter(r => (r.status === 'ok' || r.status === 'atualizado') && r.ativo).length;
    const inativos    = resultados.filter(r => r.status === 'ok' && !r.ativo).length;
    const erros       = resultados.filter(r => r.status === 'erro').length;

    // Conta quantos departamentos, setores e cargos existem agora (foram criados durante import)
    const totalDeptsRow  = await get('SELECT COUNT(*) as t FROM departamentos WHERE empresa_id=?', [req.usuario.empresa_id]);
    const totalCargosRow = await get('SELECT COUNT(*) as t FROM cargos WHERE empresa_id=?', [req.usuario.empresa_id]);
    const totalSetoresRow = await get('SELECT COUNT(*) as t FROM setores WHERE empresa_id=?', [req.usuario.empresa_id]);
    const totalDepts  = totalDeptsRow.t;
    const totalCargos = totalCargosRow.t;
    const totalSetores = totalSetoresRow.t;

    res.json({ importados, atualizados, ativos, inativos, erros, resultados, totalDepts, totalCargos, totalSetores });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Importar/atualizar por nome (ex: planilha de aniversários)
router.post('/importar-por-nome', async (req, res) => {
  try {
    const { usuarios } = req.body;
    if (!Array.isArray(usuarios) || usuarios.length === 0)
      return res.status(400).json({ erro: 'Nenhum registro enviado' });

    const resultados = [];

    for (const u of usuarios) {
      if (!u.nome) { resultados.push({ nome: '?', status: 'erro', motivo: 'Nome vazio' }); continue; }

      try {
        // Resolver ou criar departamento
        let departamento_id = null;
        if (u.departamento?.trim()) {
          let dept = await get('SELECT id FROM departamentos WHERE empresa_id=? AND LOWER(nome)=LOWER(?)', [req.usuario.empresa_id, u.departamento.trim()]);
          if (!dept) {
            const nid = uuidv4();
            await run('INSERT INTO departamentos (id, empresa_id, nome) VALUES (?,?,?)', [nid, req.usuario.empresa_id, u.departamento.trim()]);
            dept = { id: nid };
          }
          departamento_id = dept.id;
        }

        // Resolver ou criar cargo
        let cargo_id = null;
        if (u.cargo?.trim()) {
          let cargo = await get('SELECT id FROM cargos WHERE empresa_id=? AND LOWER(nome)=LOWER(?)', [req.usuario.empresa_id, u.cargo.trim()]);
          if (!cargo) {
            const nid = uuidv4();
            await run('INSERT INTO cargos (id, empresa_id, nome, departamento_id) VALUES (?,?,?,?)', [nid, req.usuario.empresa_id, u.cargo.trim(), departamento_id]);
            cargo = { id: nid };
          }
          cargo_id = cargo.id;
        }

        // Buscar usuário pelo nome (normalizado)
        const nomeNorm = u.nome.trim().toLowerCase();
        const existente = await get(`
        SELECT id FROM usuarios WHERE empresa_id=? AND LOWER(nome)=?
      `, [req.usuario.empresa_id, nomeNorm]);

        if (existente) {
          const dataNorm = normalizarData(u.data_nascimento || u.aniversario || u.aniversário);
          console.log(`[import] ${u.nome} | data_nascimento recebida: "${u.data_nascimento}" | normalizada: "${dataNorm}"`);
          // Atualiza — força data_nascimento se tiver valor, mantém o resto
          if (dataNorm) {
            await run(`UPDATE usuarios SET data_nascimento=? WHERE id=?`, [dataNorm, existente.id]);
          }
          if (u.matricula) {
            await run(`UPDATE usuarios SET matricula=? WHERE id=?`, [u.matricula, existente.id]);
          }
          if (departamento_id) {
            await run(`UPDATE usuarios SET departamento_id=? WHERE id=?`, [departamento_id, existente.id]);
          }
          if (cargo_id) {
            await run(`UPDATE usuarios SET cargo_id=? WHERE id=?`, [cargo_id, existente.id]);
          }
          resultados.push({ nome: u.nome, status: 'atualizado', dataNorm });
        } else {
          // Cria novo usuário com e-mail gerado
          const emailGerado = u.nome.trim().toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/\s+/g, '.').replace(/[^a-z.]/g, '')
            + '@lcfibra.com.br';
          const id = uuidv4();
          const senhaHash = bcrypt.hashSync('Mudar@123', 10);
          const dataNasc = normalizarData(u.data_nascimento || u.aniversario || u.aniversário);
          await run(`
          INSERT INTO usuarios (id, empresa_id, nome, email, senha, perfil, departamento_id, cargo_id, data_nascimento, matricula)
          VALUES (?,?,?,?,?,'colaborador',?,?,?,?)
        `, [id, req.usuario.empresa_id, u.nome.trim(), emailGerado, senhaHash,
                 departamento_id, cargo_id, dataNasc, u.matricula || null]);
          resultados.push({ nome: u.nome, status: 'criado', email: emailGerado });
        }
      } catch (err) {
        resultados.push({ nome: u.nome, status: 'erro', motivo: err.message });
      }
    }

    const atualizados = resultados.filter(r => r.status === 'atualizado').length;
    const criados     = resultados.filter(r => r.status === 'criado').length;
    const erros       = resultados.filter(r => r.status === 'erro').length;
    res.json({ atualizados, criados, erros, resultados });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Limpar todos os colaboradores/gestores (mantém admin)
router.delete('/todos', async (req, res) => {
  try {
    if (req.usuario.perfil !== 'admin') {
      return res.status(403).json({ erro: 'Apenas administradores podem executar esta ação' });
    }
    const result = await run("DELETE FROM usuarios WHERE empresa_id=? AND perfil != 'admin'", [req.usuario.empresa_id]);
    res.json({ removidos: result.changes });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

// Deletar usuário
router.delete('/:id', async (req, res) => {
  try {
    await run('UPDATE usuarios SET ativo=0 WHERE id=? AND empresa_id=?', [req.params.id, req.usuario.empresa_id]);
    res.json({ mensagem: 'Usuário desativado' });
  } catch(err) {
    res.status(500).json({ erro: err.message });
  }
});

module.exports = router;
