const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { gerarPDFPOP } = require('../utils/gerarPDF');
const { gerarPDFPOPHtml, getBrowser } = require('../utils/gerarPDFHtml');
// Gera PDF fiel (HTML/Chromium); em caso de falha, cai no gerador simples (pdfkit).
async function gerarPDFfiel(pop, browser) {
  try { return await gerarPDFPOPHtml(pop, browser); }
  catch (e) { console.error('PDF fiel falhou, usando fallback:', e.message); return gerarPDFPOP(pop); }
}
const { enviarEmailPOP } = require('../utils/email');

const router = express.Router();
router.use(autenticar);

// Suporte a múltiplos departamentos por POP (idempotente)
;(async () => {
  try {
    await run(`ALTER TABLE pops ADD COLUMN IF NOT EXISTS departamentos_ids TEXT`);
    await run(`ALTER TABLE pops ADD COLUMN IF NOT EXISTS departamentos_nomes TEXT`);
  } catch (_) {}
})();

// Resolve uma lista de IDs de departamento → { idsJson, nomes, primeiro }
async function resolverDepts(ids, empresaId) {
  const lista = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!lista.length) return null;
  const rows = await all('SELECT id, nome FROM departamentos WHERE empresa_id=$1', [empresaId]);
  const mapa = {}; rows.forEach(r => { mapa[r.id] = r.nome; });
  const nomes = lista.map(id => mapa[id]).filter(Boolean).join(', ');
  return { idsJson: JSON.stringify(lista), nomes: nomes || null, primeiro: lista[0] || null };
}

// Dashboard de POPs
router.get('/dashboard', async (req, res) => {
  try {
    const eid = req.usuario.empresa_id;

    const rowTotal = await get("SELECT COUNT(*) as total FROM pops WHERE empresa_id=$1 AND excluido_em IS NULL", [eid]);
    const totalPops = rowTotal.total;
    const rowCat = await get("SELECT COUNT(*) as total FROM categorias_pop WHERE empresa_id=$1", [eid]);
    const totalCategorias = rowCat.total;
    const rowViz = await get("SELECT COALESCE(SUM(total_visualizacoes),0) as total FROM pops WHERE empresa_id=$1 AND excluido_em IS NULL", [eid]);
    const totalVisualizacoes = rowViz.total;
    const porStatus = await all("SELECT status, COUNT(*) as total FROM pops WHERE empresa_id=$1 AND excluido_em IS NULL GROUP BY status", [eid]);
    const porCategoria = await all(`
      SELECT c.nome, c.cor, COUNT(p.id) as total
      FROM categorias_pop c
      LEFT JOIN pops p ON p.categoria_id = c.id AND p.empresa_id = c.empresa_id AND p.excluido_em IS NULL
      WHERE c.empresa_id = $1
      GROUP BY c.id, c.nome, c.cor ORDER BY total DESC
    `, [eid]);
    const maisAcessados = await all(`
      SELECT p.id, p.titulo, p.total_visualizacoes, p.versao, c.nome as categoria_nome, c.cor as categoria_cor
      FROM pops p
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      WHERE p.empresa_id = $1 AND p.excluido_em IS NULL
      ORDER BY p.total_visualizacoes DESC LIMIT 10
    `, [eid]);
    const historicoRecente = await all(`
      SELECT h.*, p.titulo as pop_titulo, u.nome as usuario_nome
      FROM pop_historico h
      JOIN pops p ON p.id = h.pop_id
      JOIN usuarios u ON u.id = h.usuario_id
      WHERE p.empresa_id = $1
        AND p.excluido_em IS NULL
      ORDER BY h.created_at DESC LIMIT 15
    `, [eid]);

    res.json({ totalPops, totalCategorias, totalVisualizacoes, porStatus, porCategoria, maisAcessados, historicoRecente });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Próximo código automático baseado na categoria
router.get('/proximo-codigo', async (req, res) => {
  try {
    const { categoria_id } = req.query;

    let sigla = 'GER';
    if (categoria_id) {
      const cat = await get('SELECT nome FROM categorias_pop WHERE id=$1 AND empresa_id=$2', [categoria_id, req.usuario.empresa_id]);
      if (cat) {
        const palavras = cat.nome.trim().split(/\s+/).filter(Boolean);
        if (palavras.length >= 2) {
          sigla = palavras.slice(0, 3).map(p => p[0].toUpperCase()).join('');
        } else {
          sigla = cat.nome.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, '');
        }
        if (!sigla) sigla = 'GER';
      }
    }

    const prefixo = `POP-${sigla}-`;
    const existentes = await all(
      "SELECT codigo FROM pops WHERE empresa_id=$1 AND codigo LIKE $2",
      [req.usuario.empresa_id, prefixo + '%']
    );

    let maior = 0;
    for (const row of existentes) {
      const num = parseInt(row.codigo.replace(prefixo, ''), 10);
      if (!isNaN(num) && num > maior) maior = num;
    }

    const proximo = String(maior + 1).padStart(3, '0');
    res.json({ codigo: `${prefixo}${proximo}`, sigla });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar POPs
router.get('/', async (req, res) => {
  try {
    const { status, departamento_id, categoria_id } = req.query;
    let sql = `
      SELECT p.*, d.nome as departamento_nome, u.nome as criado_por_nome,
             c.nome as categoria_nome, c.cor as categoria_cor
      FROM pops p
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      WHERE p.empresa_id = $1 AND p.excluido_em IS NULL
    `;
    const params = [req.usuario.empresa_id];
    let idx = 2;
    if (status) { sql += ` AND p.status = $${idx++}`; params.push(status); }
    if (departamento_id) { sql += ` AND p.departamento_id = $${idx++}`; params.push(departamento_id); }
    if (categoria_id) { sql += ` AND p.categoria_id = $${idx++}`; params.push(categoria_id); }
    sql += ' ORDER BY p.updated_at DESC';
    res.json(await all(sql, params));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar POP
router.post('/', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const {
      titulo, descricao, conteudo, departamento_id, categoria_id, versao,
      codigo, objetivo, campo_aplicacao, responsabilidade, procedimento,
      documentos, kpis, seguranca, penalidade, disposicao_final, data_elaboracao,
      checklist, fluxograma, tipo_pop, dono_processo, sipoc_dados, dados_inspecao, criterio_aceite
    } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id = uuidv4();
    await run(`
      INSERT INTO pops (
        id, empresa_id, titulo, descricao, conteudo, departamento_id, categoria_id, versao, criado_por,
        codigo, elaborado_por, objetivo, campo_aplicacao, responsabilidade, procedimento,
        documentos, kpis, seguranca, penalidade, disposicao_final, data_elaboracao,
        checklist, fluxograma, tipo_pop, dono_processo, sipoc_dados, dados_inspecao, criterio_aceite
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
    `, [
      id, req.usuario.empresa_id, titulo, descricao || null, conteudo || null,
      departamento_id || null, categoria_id || null, versao || '1.0', req.usuario.id,
      codigo || null, req.usuario.id,
      objetivo || null, campo_aplicacao || null, responsabilidade || null, procedimento || null,
      documentos || null, kpis || null, seguranca || null, penalidade || null,
      disposicao_final || null, data_elaboracao || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0],
      checklist || null, fluxograma || null, tipo_pop || 'pop',
      dono_processo || null, sipoc_dados || null, dados_inspecao || null, criterio_aceite || null
    ]);

    await run(`
      INSERT INTO pop_historico (id, pop_id, usuario_id, versao_anterior, versao_nova, resumo_alteracao, tipo_alteracao)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [uuidv4(), id, req.usuario.id, null, versao || '1.0', 'POP criado em rascunho', 'criacao']);

    // Múltiplos departamentos (também sincroniza departamento_id = primeiro, p/ compatibilidade)
    const dep = await resolverDepts(req.body.departamentos_ids, req.usuario.empresa_id);
    if (dep) await run('UPDATE pops SET departamentos_ids=$1, departamentos_nomes=$2, departamento_id=$3 WHERE id=$4',
      [dep.idsJson, dep.nomes, dep.primeiro, id]);

    res.status(201).json({ id, titulo, codigo });

    // Gera PDF e envia e-mail em background (não bloqueia a resposta)
    setImmediate(async () => {
      try {
        const popCompleto = await get(`
          SELECT p.*, u.nome as criado_por_nome, d.nome as departamento_nome,
                 cg.nome as cargo_nome, e.nome as empresa_nome
          FROM pops p
          LEFT JOIN usuarios u ON u.id = p.criado_por
          LEFT JOIN departamentos d ON d.id = p.departamento_id
          LEFT JOIN cargos cg ON cg.id = u.cargo_id
          LEFT JOIN empresas e ON e.id = p.empresa_id
          WHERE p.id = $1
        `, [id]);

        if (!popCompleto) return;
        const pdf = await gerarPDFPOP(popCompleto);
        await enviarEmailPOP(popCompleto, pdf);
      } catch (err) {
        console.error('Erro ao gerar/enviar PDF do POP:', err.message);
      }
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Buscar POP + registrar visualização
router.get('/:id', async (req, res) => {
  try {
    const item = await get(`
      SELECT p.*, d.nome as departamento_nome, d.sigla as departamento_sigla,
             u.nome as criado_por_nome, uc.nome as cargo_nome,
             c.nome as categoria_nome, c.cor as categoria_cor,
             e.nome as empresa_nome
      FROM pops p
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN cargos uc ON uc.id = u.cargo_id
      LEFT JOIN categorias_pop c ON c.id = p.categoria_id
      LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.id = $1 AND p.empresa_id = $2
    `, [req.params.id, req.usuario.empresa_id]);
    if (!item) return res.status(404).json({ erro: 'POP não encontrado' });

    // Não contabiliza visualização do admin (acesso master)
    if (req.usuario.perfil !== 'admin') {
      await run('UPDATE pops SET total_visualizacoes = total_visualizacoes + 1 WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
      await run('INSERT INTO pop_visualizacoes (id, pop_id, usuario_id) VALUES ($1,$2,$3)', [uuidv4(), req.params.id, req.usuario.id]);
    }

    const historico = await all(`
      SELECT h.*, u.nome as usuario_nome
      FROM pop_historico h
      JOIN usuarios u ON u.id = h.usuario_id
      WHERE h.pop_id = $1
      ORDER BY h.created_at DESC
    `, [req.params.id]);

    res.json({ ...item, historico });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Histórico de visualizações de um POP (quem acessou + quando)
router.get('/:id/visualizacoes', async (req, res) => {
  try {
    const pop = await get('SELECT id FROM pops WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });

    const acessos = await all(`
      SELECT v.created_at, COALESCE(u.nome, 'Usuário removido') as usuario_nome
      FROM pop_visualizacoes v
      LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.pop_id = $1
      ORDER BY v.created_at DESC
      LIMIT 300
    `, [req.params.id]);

    const porPessoa = await all(`
      SELECT COALESCE(u.nome, 'Usuário removido') as usuario_nome,
             COUNT(*) as total, MAX(v.created_at) as ultimo_acesso
      FROM pop_visualizacoes v
      LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.pop_id = $1
      GROUP BY u.nome
      ORDER BY total DESC
    `, [req.params.id]);

    res.json({ acessos, porPessoa });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Ativar POP (rascunho → ativo)
router.post('/:id/ativar', async (req, res) => {
  try {
    const popAtual = await get('SELECT id, versao, status FROM pops WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!popAtual) return res.status(404).json({ erro: 'POP não encontrado' });
    if (popAtual.status === 'ativo') return res.status(400).json({ erro: 'POP já está ativo' });

    await run(`
      UPDATE pops SET status='ativo', data_ativacao=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS'), updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id=$1 AND empresa_id=$2
    `, [req.params.id, req.usuario.empresa_id]);

    await run(`
      INSERT INTO pop_historico (id, pop_id, usuario_id, versao_anterior, versao_nova, resumo_alteracao, tipo_alteracao)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [uuidv4(), req.params.id, req.usuario.id, null, popAtual.versao, 'POP ativado e publicado oficialmente', 'ativacao']);

    res.json({ mensagem: 'POP ativado com sucesso' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Converter POP Importado → POP Padrão (apenas habilita as demais seções; não altera conteúdo)
router.post('/:id/converter-padrao', async (req, res) => {
  try {
    const pop = await get('SELECT id, tipo_pop, versao FROM pops WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [req.params.id, req.usuario.empresa_id]);
    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });
    if (pop.tipo_pop !== 'importado') return res.status(400).json({ erro: 'Apenas POPs importados podem ser convertidos' });

    await run(
      `UPDATE pops SET tipo_pop='pop', updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS') WHERE id=$1 AND empresa_id=$2`,
      [req.params.id, req.usuario.empresa_id]
    );

    await run(`
      INSERT INTO pop_historico (id, pop_id, usuario_id, versao_anterior, versao_nova, resumo_alteracao, tipo_alteracao)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [uuidv4(), req.params.id, req.usuario.id, null, pop.versao, 'Convertido de Importado para POP Padrão', 'correcao']);

    res.json({ mensagem: 'POP convertido para padrão', tipo_pop: 'pop' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Atualizar POP
router.put('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const {
      titulo, descricao, conteudo, departamento_id, categoria_id, versao, status, resumo_alteracao,
      tipo_alteracao,
      codigo, objetivo, campo_aplicacao, responsabilidade, procedimento,
      documentos, kpis, seguranca, penalidade, disposicao_final, data_elaboracao,
      checklist, fluxograma, tipo_pop, dono_processo, sipoc_dados, dados_inspecao, criterio_aceite
    } = req.body;

    const popAtual = await get('SELECT versao, status FROM pops WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    if (!popAtual) return res.status(404).json({ erro: 'POP não encontrado' });

    const novaVersao = tipo_alteracao === 'nova_versao' ? (versao || '1.0') : popAtual.versao;

    const novoStatus = (status === 'ativo' && popAtual.status !== 'ativo')
      ? popAtual.status
      : (status || popAtual.status);

    await run(`
      UPDATE pops SET
        titulo=$1, descricao=$2, conteudo=$3, departamento_id=$4, categoria_id=$5, versao=$6, status=$7,
        codigo=$8, objetivo=$9, campo_aplicacao=$10, responsabilidade=$11, procedimento=$12,
        documentos=$13, kpis=$14, seguranca=$15, penalidade=$16, disposicao_final=$17, data_elaboracao=$18,
        checklist=$19, fluxograma=$20, tipo_pop=$21,
        dono_processo=$22, sipoc_dados=$23, dados_inspecao=$24, criterio_aceite=$25,
        updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id=$26 AND empresa_id=$27
    `, [
      titulo, descricao || null, conteudo || null, departamento_id || null, categoria_id || null,
      novaVersao, novoStatus,
      codigo || null, objetivo || null, campo_aplicacao || null, responsabilidade || null, procedimento || null,
      documentos || null, kpis || null, seguranca || null, penalidade || null,
      disposicao_final || null, data_elaboracao || null,
      checklist || null, fluxograma || null, tipo_pop || 'pop',
      dono_processo || null, sipoc_dados || null, dados_inspecao || null, criterio_aceite || null,
      req.params.id, req.usuario.empresa_id
    ]);

    // Múltiplos departamentos
    if (req.body.departamentos_ids !== undefined) {
      const dep = await resolverDepts(req.body.departamentos_ids, req.usuario.empresa_id);
      await run('UPDATE pops SET departamentos_ids=$1, departamentos_nomes=$2, departamento_id=$3 WHERE id=$4 AND empresa_id=$5',
        [dep?.idsJson || null, dep?.nomes || null, dep?.primeiro || (departamento_id || null), req.params.id, req.usuario.empresa_id]);
    }

    const registraHistorico = popAtual.status === 'ativo' && tipo_alteracao !== 'ajuste_livre';
    if (registraHistorico) {
      let resumo = resumo_alteracao;
      if (!resumo) {
        if (tipo_alteracao === 'nova_versao') resumo = `Nova versão v${novaVersao} publicada`;
        else resumo = 'Correção / ajuste operacional';
      }
      await run(`
        INSERT INTO pop_historico (id, pop_id, usuario_id, versao_anterior, versao_nova, resumo_alteracao, tipo_alteracao)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
      `, [
        uuidv4(), req.params.id, req.usuario.id,
        popAtual.versao, novaVersao,
        resumo, tipo_alteracao || 'correcao'
      ]);
    }

    res.json({ mensagem: 'POP atualizado' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Excluir POP (soft delete → vai para lixeira)
router.delete('/:id', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const pop = await get('SELECT titulo FROM pops WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [req.params.id, req.usuario.empresa_id]);
    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });
    await run(
      `UPDATE pops SET excluido_em=NOW(), excluido_por=$1, excluido_por_nome=$2 WHERE id=$3 AND empresa_id=$4`,
      [req.usuario.id, req.usuario.nome, req.params.id, req.usuario.empresa_id]
    );
    res.json({ mensagem: 'Removido', titulo: pop.titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── EXPORTAR TODOS — PDF (ZIP) ────────────────────────────────────────────────
router.get('/exportar-todos/pdf', async (req, res) => {
  try {
    const popsAll = await all(`
      SELECT p.*, d.nome as departamento_nome, u.nome as criado_por_nome,
             uc.nome as cargo_nome, e.nome as empresa_nome
      FROM pops p
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN cargos uc ON uc.id = u.cargo_id
      LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.empresa_id = $1 AND p.excluido_em IS NULL
      ORDER BY p.codigo
    `, [req.usuario.empresa_id]);

    if (popsAll.length === 0) return res.status(404).json({ erro: 'Nenhum POP encontrado' });

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];

    await new Promise((resolve, reject) => {
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', resolve);
      archive.on('error', reject);
      archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
      (async () => {
        const browser = await getBrowser().catch(() => null);
        for (const pop of popsAll) {
          try {
            const buf = await gerarPDFfiel(pop, browser);
            const nome = `${pop.codigo || 'POP'}-${pop.titulo.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_')}.pdf`;
            archive.append(buf, { name: nome });
          } catch (e) { console.error('PDF falhou para', pop.codigo, e.message); }
        }
        archive.finalize();
      })().catch(reject);
    });

    const zipBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="POPs-todos.zip"');
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    console.error('Erro ao gerar ZIP:', err.message);
    res.status(500).json({ erro: err.message || 'Erro ao gerar arquivo' });
  }
});

// ── EXPORTAR TODOS — WORD (ZIP) ───────────────────────────────────────────────
router.get('/exportar-todos/word', async (req, res) => {
  try {
    const popsAll = await all(`
      SELECT p.*, d.nome as departamento_nome, u.nome as criado_por_nome,
             uc.nome as cargo_nome, e.nome as empresa_nome
      FROM pops p
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN cargos uc ON uc.id = u.cargo_id
      LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.empresa_id = $1 AND p.excluido_em IS NULL
      ORDER BY p.codigo
    `, [req.usuario.empresa_id]);

    if (popsAll.length === 0) return res.status(404).json({ erro: 'Nenhum POP encontrado' });

    function parseLista(val) {
      if (!val) return null;
      try { const p = JSON.parse(val); return Array.isArray(p) && p.length ? p : null; } catch { return null; }
    }
    function secaoWord(num, titulo, conteudo) {
      const texto = (conteudo || '').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
      const corpo = texto
        ? texto.split('\n').map(l => l.trim() ? `<p>${l.trim()}</p>` : '').join('')
        : `<p class="vazio">(seção não preenchida)</p>`;
      return `<div class="secao"><h2><span class="num">${num}</span> ${titulo}</h2><div class="conteudo">${corpo}</div></div>`;
    }
    function gerarWordPop(pop) {
      const fmtData = (s) => s ? new Date(s).toLocaleDateString('pt-BR') : '—';
      const resp = parseLista(pop.responsabilidade);
      const disp = parseLista(pop.disposicao_final);
      const ident = `<div class="secao"><h2><span class="num">1</span> Identificação</h2><div class="conteudo">
        <p><strong>Empresa:</strong> ${pop.empresa_nome||'LC FIBRA'} &nbsp;|&nbsp; <strong>Elaborado por:</strong> ${pop.criado_por_nome||'—'} &nbsp;|&nbsp; <strong>Cargo:</strong> ${pop.cargo_nome||'—'}</p>
        <p><strong>Versão:</strong> v${pop.versao||'1.0'} &nbsp;|&nbsp; <strong>Departamento:</strong> ${pop.departamento_nome||'—'} &nbsp;|&nbsp; <strong>Data:</strong> ${fmtData(pop.data_elaboracao||pop.created_at)}</p>
      </div></div>`;
      // Documento oficial: seções 2 a 9 sempre presentes, mesmo vazias
      let secoes = '';
      secoes += secaoWord(2, 'Objetivo', pop.objetivo);
      secoes += secaoWord(3, 'Campo de Aplicação', pop.campo_aplicacao);
      if (resp) {
        const rows = resp.filter(r => r.cargo_nome || r.responsabilidade).map(r => `<tr><td>${r.cargo_nome||'—'}</td><td>${r.responsabilidade||'—'}</td></tr>`).join('');
        secoes += `<div class="secao"><h2><span class="num">4</span> Responsabilidades</h2><table><thead><tr><th>Cargo</th><th>Responsabilidade</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      } else secoes += secaoWord(4, 'Responsabilidades', (pop.responsabilidade || '').trim().startsWith('[') ? '' : pop.responsabilidade);
      secoes += secaoWord(5, 'Procedimento Detalhado', pop.procedimento);
      secoes += secaoWord(6, 'Documentos e Ferramentas', pop.documentos);
      secoes += secaoWord(7, 'Segurança e Conduta', pop.seguranca);
      secoes += secaoWord(8, 'Penalidades', pop.penalidade);
      if (disp) {
        const rows = disp.filter(r => r.item).map(r => `<tr><td>${r.item}</td><td>${r.destino||'—'}</td><td>${r.responsavel||'—'}</td></tr>`).join('');
        secoes += `<div class="secao"><h2><span class="num">9</span> Disposições Finais</h2><table><thead><tr><th>Item</th><th>Destino</th><th>Responsável</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      } else secoes += secaoWord(9, 'Disposições Finais', (pop.disposicao_final || '').trim().startsWith('[') ? '' : pop.disposicao_final);
      if (pop.kpis) secoes += secaoWord('+', 'KPIs e Indicadores', pop.kpis);
      return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${pop.codigo||'POP'} - ${pop.titulo}</title>
<style>body{font-family:Calibri,Arial,sans-serif;color:#0f172a;margin:2cm;font-size:11pt}
.cabecalho{background:#7B55F1;color:white;padding:20px 24px;margin:-2cm -2cm 24px}
.cabecalho h1{margin:0 0 4px;font-size:18pt}.cabecalho .sub{font-size:10pt;opacity:.85}
.secao{margin-bottom:20px}h2{font-size:12pt;color:#0f172a;border-bottom:2px solid #7B55F1;padding-bottom:4px}
.num{background:#7B55F1;color:white;border-radius:50%;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;font-size:9pt}
.conteudo p{margin:4px 0;line-height:1.6}.conteudo p.vazio{color:#94a3b8;font-style:italic}table{width:100%;border-collapse:collapse;margin-top:8px}
th{background:#7B55F1;color:white;padding:7px 10px;font-size:9pt}td{padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:10pt}</style></head>
<body><div class="cabecalho"><h1>${pop.titulo}</h1><div class="sub">${pop.codigo||''} · v${pop.versao||'1.0'} · ${pop.empresa_nome||'LC FIBRA'}</div></div>
${ident}${secoes}<div style="margin-top:32px;border-top:1px solid #e2e8f0;padding-top:10px;font-size:8pt;color:#64748b;text-align:center">LC FIBRA — ${pop.codigo||''} — Gerado em ${new Date().toLocaleString('pt-BR')}</div></body></html>`;
    }

    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];

    await new Promise((resolve, reject) => {
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', resolve);
      archive.on('error', reject);
      archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
      for (const pop of popsAll) {
        const html = gerarWordPop(pop);
        const nome = `${pop.codigo || 'POP'}-${pop.titulo.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_')}.doc`;
        archive.append(Buffer.from(html, 'utf-8'), { name: nome });
      }
      archive.finalize();
    });

    const zipBuffer = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="POPs-todos-word.zip"');
    res.setHeader('Content-Length', zipBuffer.length);
    res.send(zipBuffer);
  } catch (err) {
    console.error('Erro ao gerar ZIP Word:', err.message);
    res.status(500).json({ erro: err.message || 'Erro ao gerar arquivo' });
  }
});

// ── EXPORTAR PDF ──────────────────────────────────────────────────────────────
router.get('/:id/exportar/pdf', async (req, res) => {
  try {
    const pop = await get(`
      SELECT p.*, d.nome as departamento_nome, u.nome as criado_por_nome,
             uc.nome as cargo_nome, e.nome as empresa_nome
      FROM pops p
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN cargos uc ON uc.id = u.cargo_id
      LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.id = $1 AND p.empresa_id = $2 AND p.excluido_em IS NULL
    `, [req.params.id, req.usuario.empresa_id]);

    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });

    const pdfBuffer = await gerarPDFfiel(pop);
    const nomeArquivo = `${pop.codigo || 'POP'}-${pop.titulo.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_')}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nomeArquivo)}"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Erro ao gerar PDF:', err.message);
    res.status(500).json({ erro: 'Erro ao gerar PDF' });
  }
});

// ── EXPORTAR WORD (HTML compatível com Word) ──────────────────────────────────
router.get('/:id/exportar/word', async (req, res) => {
  try {
    const pop = await get(`
      SELECT p.*, d.nome as departamento_nome, u.nome as criado_por_nome,
             uc.nome as cargo_nome, e.nome as empresa_nome
      FROM pops p
      LEFT JOIN departamentos d ON d.id = p.departamento_id
      LEFT JOIN usuarios u ON u.id = p.criado_por
      LEFT JOIN cargos uc ON uc.id = u.cargo_id
      LEFT JOIN empresas e ON e.id = p.empresa_id
      WHERE p.id = $1 AND p.empresa_id = $2 AND p.excluido_em IS NULL
    `, [req.params.id, req.usuario.empresa_id]);

    if (!pop) return res.status(404).json({ erro: 'POP não encontrado' });

    function parseLista(val) {
      if (!val) return null;
      try { const p = JSON.parse(val); return Array.isArray(p) && p.length ? p : null; } catch { return null; }
    }

    function secaoWord(num, titulo, conteudo) {
      const texto = (conteudo || '').replace(/<li[^>]*>/gi, '\n• ').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim();
      const corpo = texto
        ? texto.split('\n').map(l => l.trim() ? `<p>${l.trim()}</p>` : '').join('')
        : `<p class="vazio">(seção não preenchida)</p>`;
      return `
        <div class="secao">
          <h2><span class="num">${num}</span> ${titulo}</h2>
          <div class="conteudo">${corpo}</div>
        </div>`;
    }

    const resp = parseLista(pop.responsabilidade);
    const disp = parseLista(pop.disposicao_final);
    const fmtData = (s) => s ? new Date(s).toLocaleDateString('pt-BR') : '—';

    // Documento oficial: seções 2 a 9 sempre presentes, mesmo vazias
    let secoes = '';
    secoes += secaoWord(2, 'Objetivo', pop.objetivo);
    secoes += secaoWord(3, 'Campo de Aplicação', pop.campo_aplicacao);
    if (resp) {
      const rows = resp.filter(r => r.cargo_nome || r.responsabilidade)
        .map(r => `<tr><td>${r.cargo_nome || '—'}</td><td>${r.responsabilidade || '—'}</td></tr>`).join('');
      secoes += `<div class="secao"><h2><span class="num">4</span> Responsabilidades</h2>
        <table><thead><tr><th>Cargo / Nome</th><th>Responsabilidade</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else secoes += secaoWord(4, 'Responsabilidades', (pop.responsabilidade || '').trim().startsWith('[') ? '' : pop.responsabilidade);
    secoes += secaoWord(5, 'Procedimento Detalhado', pop.procedimento);
    secoes += secaoWord(6, 'Documentos e Ferramentas', pop.documentos);
    secoes += secaoWord(7, 'Segurança e Conduta', pop.seguranca);
    secoes += secaoWord(8, 'Penalidades', pop.penalidade);
    if (disp) {
      const rows = disp.filter(r => r.item).map(r => `<tr><td>${r.item}</td><td>${r.destino || '—'}</td><td>${r.responsavel || '—'}</td></tr>`).join('');
      secoes += `<div class="secao"><h2><span class="num">9</span> Disposições Finais</h2>
        <table><thead><tr><th>Item</th><th>Destino / Ação</th><th>Responsável</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else secoes += secaoWord(9, 'Disposições Finais', (pop.disposicao_final || '').trim().startsWith('[') ? '' : pop.disposicao_final);
    if (pop.kpis) secoes += secaoWord('+', 'KPIs e Indicadores', pop.kpis);

    // Fluxograma — representação textual sequencial
    let fluxogramaHtml = '';
    if (pop.procedimento) {
      const texto = pop.procedimento.replace(/<li[^>]*>/gi, '\n').replace(/<[^>]+>/g, '').trim();
      const passos = texto.split('\n').map(l => l.replace(/^[\d\.\)\-•*]\s*/, '').trim()).filter(l => l.length > 3);
      if (passos.length > 0) {
        fluxogramaHtml = `<div class="secao fluxograma-secao">
          <h2><span class="num">⬡</span> Fluxograma do Processo</h2>
          <div class="fluxograma-lista">
            ${passos.map((p, i) => `<div class="flx-item"><span class="flx-n">${i + 1}</span><span class="flx-txt">${p}</span>${i < passos.length - 1 ? '<div class="flx-seta">↓</div>' : ''}</div>`).join('')}
          </div>
        </div>`;
      }
    }

    const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>${pop.codigo || 'POP'} - ${pop.titulo}</title>
  <style>
    body { font-family: Calibri, Arial, sans-serif; color: #0f172a; margin: 2cm; font-size: 11pt; }
    .cabecalho { background: #7B55F1; color: white; padding: 20px 24px; margin: -2cm -2cm 24px; }
    .cabecalho h1 { margin: 0 0 4px; font-size: 18pt; }
    .cabecalho .sub { font-size: 10pt; opacity: 0.85; }
    .grade-id { display: table; width: 100%; border-collapse: collapse; margin-bottom: 24px; background: #f8fafc; border: 1px solid #e2e8f0; }
    .grade-id .cel { display: table-cell; padding: 8px 12px; border-right: 1px solid #e2e8f0; width: 16%; }
    .grade-id .cel:last-child { border-right: none; }
    .grade-id .label { font-size: 7pt; text-transform: uppercase; color: #64748b; }
    .grade-id .valor { font-weight: bold; font-size: 9pt; }
    .secao { margin-bottom: 20px; page-break-inside: avoid; }
    h2 { font-size: 12pt; color: #0f172a; border-bottom: 2px solid #7B55F1; padding-bottom: 4px; display: flex; align-items: center; gap: 8px; }
    .num { background: #7B55F1; color: white; border-radius: 50%; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; font-size: 9pt; flex-shrink: 0; }
    .conteudo p { margin: 4px 0; line-height: 1.6; }
    .conteudo p.vazio { color: #94a3b8; font-style: italic; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th { background: #7B55F1; color: white; padding: 7px 10px; font-size: 9pt; text-align: left; }
    td { padding: 6px 10px; border-bottom: 1px solid #e2e8f0; font-size: 10pt; }
    tr:nth-child(even) td { background: #f8fafc; }
    .fluxograma-secao { background: #f0f4ff; border: 1px solid #c7d2fe; padding: 16px; border-radius: 6px; }
    .fluxograma-lista { padding: 8px 0; }
    .flx-item { display: flex; flex-direction: column; align-items: flex-start; margin-bottom: 4px; }
    .flx-n { background: #7B55F1; color: white; border-radius: 4px; padding: 2px 8px; font-size: 9pt; font-weight: bold; margin-bottom: 4px; }
    .flx-txt { background: white; border: 1px solid #c7d2fe; border-radius: 4px; padding: 6px 12px; font-size: 10pt; min-width: 200px; }
    .flx-seta { color: #7B55F1; font-size: 16pt; margin: 2px 0 2px 8px; }
    .rodape { margin-top: 32px; border-top: 1px solid #e2e8f0; padding-top: 10px; font-size: 8pt; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="cabecalho">
    <h1>${pop.titulo}</h1>
    <div class="sub">${pop.codigo || ''} &nbsp;·&nbsp; Versão ${pop.versao || '1.0'} &nbsp;·&nbsp; ${pop.empresa_nome || 'LC FIBRA'}</div>
  </div>
  <div class="secao"><h2><span class="num">1</span> Identificação</h2></div>
  <div class="grade-id">
    <div class="cel"><div class="label">Empresa</div><div class="valor">${pop.empresa_nome || 'LC FIBRA'}</div></div>
    <div class="cel"><div class="label">Elaborado por</div><div class="valor">${pop.criado_por_nome || '—'}</div></div>
    <div class="cel"><div class="label">Cargo</div><div class="valor">${pop.cargo_nome || '—'}</div></div>
    <div class="cel"><div class="label">Versão</div><div class="valor">v${pop.versao || '1.0'}</div></div>
    <div class="cel"><div class="label">Departamento</div><div class="valor">${pop.departamento_nome || '—'}</div></div>
    <div class="cel"><div class="label">Data</div><div class="valor">${fmtData(pop.data_elaboracao || pop.created_at)}</div></div>
  </div>
  ${secoes}
  ${fluxogramaHtml}
  <div class="rodape">LC FIBRA — Sistema de Gestão &nbsp;·&nbsp; ${pop.codigo || ''} &nbsp;·&nbsp; Gerado em ${new Date().toLocaleString('pt-BR')}</div>
</body>
</html>`;

    const nomeArquivo = `${pop.codigo || 'POP'}-${pop.titulo.replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_')}.doc`;
    res.setHeader('Content-Type', 'application/msword');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nomeArquivo)}"`);
    res.send(html);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── Ações em massa ────────────────────────────────────────────────────────────
// Ativar vários POPs de uma vez
router.post('/bulk/ativar', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ erro: 'Nenhum POP selecionado' });
    let n = 0;
    for (const id of ids) {
      const r = await run(
        `UPDATE pops SET status='ativo', updated_at=TO_CHAR(NOW() - INTERVAL '3 hours', 'YYYY-MM-DD HH24:MI:SS')
         WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL`,
        [id, req.usuario.empresa_id]
      );
      n++;
    }
    res.json({ ok: true, total: n });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Definir departamentos de vários POPs de uma vez
router.post('/bulk/departamentos', async (req, res) => {
  try {
    if (!['admin','gestor','lider'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ erro: 'Nenhum POP selecionado' });
    const dep = await resolverDepts(req.body.departamentos_ids, req.usuario.empresa_id);
    for (const id of ids) {
      await run('UPDATE pops SET departamentos_ids=$1, departamentos_nomes=$2, departamento_id=$3 WHERE id=$4 AND empresa_id=$5',
        [dep?.idsJson || null, dep?.nomes || null, dep?.primeiro || null, id, req.usuario.empresa_id]);
    }
    res.json({ ok: true, total: ids.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
