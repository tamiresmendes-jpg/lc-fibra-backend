const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { gerarPDFProcesso } = require('../utils/gerarPDF');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');
try { if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_) {}
const uploadProc = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = express.Router();
router.use(autenticar);

function eid(req) { return req.usuario.empresa_id; }

// Resolve lista de IDs de departamento → { idsJson, nomes }
async function resolverDeptsProc(ids, empresaId) {
  const lista = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!lista.length) return null;
  const rows = await all('SELECT id, nome FROM departamentos WHERE empresa_id=$1', [empresaId]);
  const mapa = {}; rows.forEach(r => { mapa[r.id] = r.nome; });
  const nomes = lista.map(id => mapa[id]).filter(Boolean).join(', ');
  return { idsJson: JSON.stringify(lista), nomes: nomes || null };
}

// Garantir colunas e tabelas (idempotente)
;(async () => {
  try {
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS objetivo TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS resultado_esperado TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS pops_relacionados TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS codigo VARCHAR(20)`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS criado_por_id TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS criado_por_nome TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS setor TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS responsavel TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS categoria_id TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS departamentos_ids TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS departamentos_nomes TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS versao TEXT DEFAULT '1.0'`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS total_visualizacoes INTEGER DEFAULT 0`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMP`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS excluido_por TEXT`);
    await run(`ALTER TABLE processos ADD COLUMN IF NOT EXISTS excluido_por_nome TEXT`);
    await run(`
      CREATE TABLE IF NOT EXISTS processo_visualizacoes (
        id TEXT PRIMARY KEY, processo_id TEXT NOT NULL, empresa_id TEXT NOT NULL,
        usuario_id TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await run(`
      CREATE TABLE IF NOT EXISTS processo_anexos (
        id TEXT PRIMARY KEY, processo_id TEXT NOT NULL, empresa_id TEXT NOT NULL,
        usuario_id TEXT, nome TEXT, tipo TEXT, tamanho INTEGER, caminho TEXT, url_externa TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    await run(`
      CREATE TABLE IF NOT EXISTS processo_comentarios (
        id TEXT PRIMARY KEY, processo_id TEXT NOT NULL, empresa_id TEXT NOT NULL,
        usuario_id TEXT, texto TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      )`);
    // Limpeza única: remove entradas de histórico geradas pelo autosave (edições de conteúdo),
    // mantendo apenas marcos (status, código, versão, ativação). Igual ao POP.
    await run(`
      DELETE FROM processo_historico
      WHERE acao = 'editado'
        AND COALESCE(snapshot,'') NOT LIKE '%Status:%'
        AND COALESCE(snapshot,'') NOT LIKE '%Código gerado%'
        AND COALESCE(snapshot,'') NOT LIKE '%Vers%o:%'
        AND COALESCE(snapshot,'') NOT LIKE '%ativado%'
    `).catch(() => {});
    await run(`
      CREATE TABLE IF NOT EXISTS processo_historico (
        id TEXT PRIMARY KEY,
        processo_id TEXT NOT NULL,
        empresa_id TEXT NOT NULL,
        alterado_por_id TEXT,
        alterado_por_nome TEXT,
        acao TEXT NOT NULL,
        snapshot TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  } catch {}
})();

// Sigla a partir do nome da categoria (mesma lógica dos POPs)
function siglaCategoria(nome) {
  if (!nome) return 'GER';
  const palavras = nome.trim().split(/\s+/).filter(Boolean);
  let sigla;
  if (palavras.length >= 2) sigla = palavras.slice(0, 3).map(p => p[0].toUpperCase()).join('');
  else sigla = nome.substring(0, 3).toUpperCase().replace(/[^A-Z]/g, '');
  return sigla || 'GER';
}

// Próximo código — por categoria (PROC-FIN-001) ou geral (PROC-GER-001)
async function proximoCodigo(empresa_id, categoria_id) {
  let sigla = 'GER';
  if (categoria_id) {
    const cat = await get('SELECT nome FROM categorias_pop WHERE id=$1 AND empresa_id=$2', [categoria_id, empresa_id]);
    if (cat) sigla = siglaCategoria(cat.nome);
  }
  const prefixo = `PROC-${sigla}-`;
  const existentes = await all(
    'SELECT codigo FROM processos WHERE empresa_id=$1 AND codigo LIKE $2',
    [empresa_id, prefixo + '%']
  );
  let maior = 0;
  for (const row of existentes) {
    const num = parseInt(String(row.codigo).replace(prefixo, ''), 10);
    if (!isNaN(num) && num > maior) maior = num;
  }
  return `${prefixo}${String(maior + 1).padStart(3, '0')}`;
}

// Registrar histórico
async function registrarHistorico(processo_id, empresa_id, usuario, acao, snapshot) {
  try {
    await run(
      `INSERT INTO processo_historico (id,processo_id,empresa_id,alterado_por_id,alterado_por_nome,acao,snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv4(), processo_id, empresa_id, usuario.id, usuario.nome, acao, snapshot ? JSON.stringify(snapshot) : null]
    );
  } catch {}
}

// ── Rotas ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const rows = await all(
      `SELECT p.*, c.nome as categoria_nome, c.cor as categoria_cor
       FROM processos p
       LEFT JOIN categorias_pop c ON c.id = p.categoria_id
       WHERE p.empresa_id=$1 AND p.excluido_em IS NULL
       ORDER BY p.codigo ASC, p.created_at DESC`,
      [eid(req)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Próximo código sugerido conforme categoria (usado pelo editor)
router.get('/proximo-codigo', async (req, res) => {
  try {
    const codigo = await proximoCodigo(eid(req), req.query.categoria_id || null);
    res.json({ codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── Exportar todos (ZIP) ────────────────────────────────────────────────────
async function todosProcessos(empresa_id) {
  return all(
    `SELECT p.*, c.nome as categoria_nome, u.nome as criado_por_nome
     FROM processos p LEFT JOIN categorias_pop c ON c.id = p.categoria_id
     LEFT JOIN usuarios u ON u.id = p.criado_por_id
     WHERE p.empresa_id=$1 AND p.excluido_em IS NULL ORDER BY p.codigo`,
    [empresa_id]
  );
}
router.get('/exportar-todos/:formato', async (req, res) => {
  try {
    const procs = await todosProcessos(eid(req));
    if (!procs.length) return res.status(404).json({ erro: 'Nenhum processo encontrado' });
    const archiver = require('archiver');
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks = [];
    const isPdf = req.params.formato === 'pdf';
    await new Promise((resolve, reject) => {
      archive.on('data', c => chunks.push(c));
      archive.on('end', resolve); archive.on('error', reject);
      archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
      (async () => {
        for (const proc of procs) {
          try {
            const base = `${proc.codigo || 'PROC'}-${String(proc.titulo || 'processo').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_')}`;
            if (isPdf) archive.append(await gerarPDFProcesso(proc), { name: `${base}.pdf` });
            else archive.append(Buffer.from(gerarWordProcesso(proc), 'utf-8'), { name: `${base}.doc` });
          } catch (e) { console.error('export proc falhou', proc.codigo, e.message); }
        }
        archive.finalize();
      })().catch(reject);
    });
    const zip = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Processos-todos-${isPdf ? 'pdf' : 'word'}.zip"`);
    res.send(zip);
  } catch (e) { console.error('[processos exportar-todos]', e.message); res.status(500).json({ erro: 'Erro ao exportar' }); }
});

// ── Visualizações (quem visualizou) ─────────────────────────────────────────
router.post('/:id/visualizar', async (req, res) => {
  try {
    const proc = await get('SELECT id FROM processos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!proc) return res.status(404).json({ erro: 'Não encontrado' });
    if (req.usuario.perfil !== 'admin') {
      await run('UPDATE processos SET total_visualizacoes = COALESCE(total_visualizacoes,0) + 1 WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
      await run('INSERT INTO processo_visualizacoes (id, processo_id, empresa_id, usuario_id) VALUES ($1,$2,$3,$4)', [uuidv4(), req.params.id, eid(req), req.usuario.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.get('/:id/visualizacoes', async (req, res) => {
  try {
    const proc = await get('SELECT id FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!proc) return res.status(404).json({ erro: 'Não encontrado' });
    const porPessoa = await all(`
      SELECT COALESCE(u.nome, 'Usuário removido') as usuario_nome, COUNT(*) as total, MAX(v.created_at) as ultimo_acesso
      FROM processo_visualizacoes v LEFT JOIN usuarios u ON u.id = v.usuario_id
      WHERE v.processo_id=$1 GROUP BY u.nome ORDER BY total DESC`, [req.params.id]);
    res.json({ porPessoa });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Anexos ──────────────────────────────────────────────────────────────────
async function procDaEmpresa(id, empresa_id) { return get('SELECT id FROM processos WHERE id=$1 AND empresa_id=$2', [id, empresa_id]); }
router.get('/:id/anexos', async (req, res) => {
  try {
    const anexos = await all(`SELECT a.*, u.nome as usuario_nome FROM processo_anexos a LEFT JOIN usuarios u ON u.id=a.usuario_id WHERE a.processo_id=$1 AND a.empresa_id=$2 ORDER BY a.created_at DESC`, [req.params.id, eid(req)]);
    res.json(anexos);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.post('/:id/anexos/upload', uploadProc.single('arquivo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Arquivo não enviado' });
    if (!(await procDaEmpresa(req.params.id, eid(req)))) { try { fs.unlinkSync(path.join(UPLOADS_DIR, req.file.filename)); } catch {} return res.status(404).json({ erro: 'Processo não encontrado' }); }
    const id = uuidv4();
    await run(`INSERT INTO processo_anexos (id,processo_id,empresa_id,usuario_id,nome,tipo,tamanho,caminho) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, req.params.id, eid(req), req.usuario.id, req.file.originalname, req.file.mimetype, req.file.size, req.file.filename]);
    res.status(201).json(await get(`SELECT a.*, u.nome as usuario_nome FROM processo_anexos a LEFT JOIN usuarios u ON u.id=a.usuario_id WHERE a.id=$1`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.post('/:id/anexos/link', async (req, res) => {
  try {
    const { nome, url } = req.body;
    if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ erro: 'URL deve começar com http:// ou https://' });
    if (!(await procDaEmpresa(req.params.id, eid(req)))) return res.status(404).json({ erro: 'Processo não encontrado' });
    const id = uuidv4();
    await run(`INSERT INTO processo_anexos (id,processo_id,empresa_id,usuario_id,nome,tipo,url_externa) VALUES ($1,$2,$3,$4,$5,'link',$6)`,
      [id, req.params.id, eid(req), req.usuario.id, nome || url, url]);
    res.status(201).json(await get(`SELECT a.*, u.nome as usuario_nome FROM processo_anexos a LEFT JOIN usuarios u ON u.id=a.usuario_id WHERE a.id=$1`, [id]));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.get('/:id/anexos/:anexoId/download', (req, res, next) => {
  if (req.query.token) { try { req.usuario = require('jsonwebtoken').verify(req.query.token, process.env.JWT_SECRET); } catch { return res.status(401).json({ erro: 'Token inválido' }); } }
  next();
}, async (req, res) => {
  try {
    const anexo = await get('SELECT * FROM processo_anexos WHERE id=$1 AND empresa_id=$2', [req.params.anexoId, req.usuario.empresa_id]);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado' });
    if (anexo.url_externa) return res.redirect(anexo.url_externa);
    const fp = path.join(UPLOADS_DIR, anexo.caminho);
    if (!fs.existsSync(fp)) return res.status(404).json({ erro: 'Arquivo não encontrado' });
    res.download(fp, anexo.nome);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/:id/anexos/:anexoId', async (req, res) => {
  try {
    const anexo = await get('SELECT * FROM processo_anexos WHERE id=$1 AND empresa_id=$2', [req.params.anexoId, eid(req)]);
    if (!anexo) return res.status(404).json({ erro: 'Anexo não encontrado' });
    if (anexo.caminho) { const fp = path.join(UPLOADS_DIR, anexo.caminho); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
    await run('DELETE FROM processo_anexos WHERE id=$1', [req.params.anexoId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── Comentários do processo ─────────────────────────────────────────────────
router.get('/:id/comentarios', async (req, res) => {
  try {
    const rows = await all(`
      SELECT c.*, u.nome as usuario_nome,
             (c.usuario_id = $3) as meu
      FROM processo_comentarios c LEFT JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.processo_id=$1 AND c.empresa_id=$2 ORDER BY c.created_at DESC`,
      [req.params.id, eid(req), req.usuario.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.post('/:id/comentarios', async (req, res) => {
  try {
    const { texto } = req.body;
    if (!texto || !texto.trim()) return res.status(400).json({ erro: 'Comentário vazio' });
    if (!(await procDaEmpresa(req.params.id, eid(req)))) return res.status(404).json({ erro: 'Processo não encontrado' });
    const id = uuidv4();
    await run('INSERT INTO processo_comentarios (id, processo_id, empresa_id, usuario_id, texto) VALUES ($1,$2,$3,$4,$5)',
      [id, req.params.id, eid(req), req.usuario.id, texto.trim()]);
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});
router.delete('/:id/comentarios/:cid', async (req, res) => {
  try {
    const c = await get('SELECT * FROM processo_comentarios WHERE id=$1 AND empresa_id=$2', [req.params.cid, eid(req)]);
    if (!c) return res.status(404).json({ erro: 'Comentário não encontrado' });
    if (c.usuario_id !== req.usuario.id && !['admin', 'gestor'].includes(req.usuario.perfil)) return res.status(403).json({ erro: 'Sem permissão' });
    await run('DELETE FROM processo_comentarios WHERE id=$1', [req.params.cid]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.get('/:id/historico', async (req, res) => {
  try {
    const rows = await all(
      'SELECT * FROM processo_historico WHERE processo_id=$1 AND empresa_id=$2 ORDER BY created_at DESC',
      [req.params.id, eid(req)]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Busca o processo completo (com categoria e autor) para exportação
async function processoCompleto(id, empresa_id) {
  return get(
    `SELECT p.*, c.nome as categoria_nome, u.nome as criado_por_nome
     FROM processos p
     LEFT JOIN categorias_pop c ON c.id = p.categoria_id
     LEFT JOIN usuarios u ON u.id = p.criado_por_id
     WHERE p.id=$1 AND p.empresa_id=$2 AND p.excluido_em IS NULL`,
    [id, empresa_id]
  );
}

function parseArr(val) { try { const p = JSON.parse(val); return Array.isArray(p) ? p : []; } catch { return []; } }

function gerarWordProcesso(proc) {
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const txtHtml = t => t ? esc(t).replace(/\n/g, '<br>') : '<span class="vazio">(não preenchido)</span>';
  const pops = parseArr(proc.pops_relacionados).map(p => typeof p === 'string' ? p : [p.codigo, p.titulo].filter(Boolean).join(' – '));
  const res  = parseArr(proc.resultado_esperado).map(r => typeof r === 'string' ? r : (r.item || ''));
  const listaHtml = (arr) => arr.filter(Boolean).length
    ? `<ul>${arr.filter(Boolean).map(i => `<li>${esc(i)}</li>`).join('')}</ul>`
    : '<span class="vazio">(nenhum)</span>';
  const statusLabel = { ativo:'Ativo', rascunho:'Rascunho', revisao:'Em Revisão', inativo:'Inativo' }[proc.status] || proc.status || '';
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>${esc(proc.codigo||'PROC')} - ${esc(proc.titulo)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;color:#0f172a;margin:2cm;font-size:11pt}
.cabecalho{background:#7B55F1;color:#fff;padding:20px 24px;margin:-2cm -2cm 24px}
.cabecalho h1{margin:0 0 4px;font-size:18pt}.cabecalho .sub{font-size:10pt;opacity:.85}
.secao{margin-bottom:18px}h2{font-size:12pt;border-bottom:2px solid #7B55F1;padding-bottom:4px}
.grade{width:100%;border-collapse:collapse;margin-bottom:18px;background:#f8fafc;border:1px solid #e2e8f0}
.grade td{padding:8px 12px;border-right:1px solid #e2e8f0;font-size:10pt}
.grade .lbl{font-size:7pt;text-transform:uppercase;color:#64748b;display:block}
.vazio{color:#94a3b8;font-style:italic}ul{margin:6px 0;padding-left:20px}li{margin:3px 0}</style></head>
<body><div class="cabecalho"><h1>${esc(proc.titulo)}</h1>
<div class="sub">${esc(proc.codigo||'')} · ${esc(statusLabel)} · LC FIBRA</div></div>
<table class="grade"><tr>
<td><span class="lbl">Responsável</span>${esc(proc.responsavel||'—')}</td>
<td><span class="lbl">Setor</span>${esc(proc.setor||'—')}</td>
<td><span class="lbl">Categoria</span>${esc(proc.categoria_nome||'—')}</td>
</tr></table>
<div class="secao"><h2>Objetivo</h2><div>${txtHtml(proc.objetivo)}</div></div>
<div class="secao"><h2>Descrição do Processo</h2><div>${txtHtml(proc.descricao)}</div></div>
<div class="secao"><h2>POPs Relacionados</h2>${listaHtml(pops)}</div>
<div class="secao"><h2>Resultado Esperado</h2>${listaHtml(res)}</div>
<div style="margin-top:28px;border-top:1px solid #e2e8f0;padding-top:10px;font-size:8pt;color:#64748b;text-align:center">LC FIBRA — ${esc(proc.codigo||'')} — Gerado em ${new Date().toLocaleString('pt-BR')}</div>
</body></html>`;
}

function nomeArquivoProc(proc, ext) {
  const base = `${proc.codigo || 'PROC'}-${String(proc.titulo||'processo').replace(/[^a-zA-Z0-9\s]/g,'').trim().replace(/\s+/g,'_')}`;
  return `${base}.${ext}`;
}

router.get('/:id/exportar/:formato', async (req, res) => {
  try {
    const proc = await processoCompleto(req.params.id, eid(req));
    if (!proc) return res.status(404).json({ erro: 'Processo não encontrado' });
    if (req.params.formato === 'pdf') {
      const pdf = await gerarPDFProcesso(proc);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nomeArquivoProc(proc,'pdf'))}"`);
      return res.send(pdf);
    }
    if (req.params.formato === 'word') {
      const html = gerarWordProcesso(proc);
      res.setHeader('Content-Type', 'application/msword');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nomeArquivoProc(proc,'doc'))}"`);
      return res.send(html);
    }
    res.status(400).json({ erro: 'Formato inválido' });
  } catch(e) { console.error('[processos exportar]', e.message); res.status(500).json({ erro: 'Erro ao exportar' }); }
});

// Ativar processo (rascunho → ativo) — gera código se ainda não tiver
router.post('/:id/ativar', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão' });
    const proc = await get('SELECT * FROM processos WHERE id=$1 AND empresa_id=$2 AND excluido_em IS NULL', [req.params.id, eid(req)]);
    if (!proc) return res.status(404).json({ erro: 'Processo não encontrado' });
    if (proc.status === 'ativo') return res.status(400).json({ erro: 'Processo já está ativo' });
    let codigo = proc.codigo;
    if (!codigo) codigo = await proximoCodigo(eid(req), proc.categoria_id || null);
    await run('UPDATE processos SET status=$1, codigo=$2, updated_at=NOW() WHERE id=$3 AND empresa_id=$4',
      ['ativo', codigo, req.params.id, eid(req)]);
    await registrarHistorico(req.params.id, eid(req), req.usuario, 'editado', { mudancas: ['Processo ativado e publicado oficialmente', ...(codigo && !proc.codigo ? [`Código gerado: ${codigo}`] : [])], titulo: proc.titulo });
    res.json({ ok: true, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados, categoria_id, versao } = req.body;
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório' });
    const id     = uuidv4();
    // usa o código sugerido pelo editor; se estiver ativo e sem código, gera pela categoria
    let codigo = req.body.codigo || null;
    if (!codigo && status === 'ativo') codigo = await proximoCodigo(eid(req), categoria_id || null);
    await run(
      `INSERT INTO processos
         (id,empresa_id,codigo,titulo,objetivo,descricao,setor,responsavel,status,
          resultado_esperado,pops_relacionados,categoria_id,versao,criado_por_id,criado_por_nome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, eid(req), codigo, titulo, objetivo||null, descricao||null, setor||null,
       responsavel||null, status||'rascunho', resultado_esperado||null, pops_relacionados||null,
       categoria_id||null, versao||'1.0', req.usuario.id, req.usuario.nome]
    );
    const dep = await resolverDeptsProc(req.body.departamentos_ids, eid(req));
    if (dep) await run('UPDATE processos SET departamentos_ids=$1, departamentos_nomes=$2 WHERE id=$3', [dep.idsJson, dep.nomes, id]);
    await registrarHistorico(id, eid(req), req.usuario, 'criado', { mudancas: [status === 'ativo' ? 'Processo criado e ativado' : 'Processo criado em rascunho'], titulo, codigo, status });
    res.status(201).json({ id, titulo, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor', 'lider'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão para editar processos' });
    const { titulo, objetivo, descricao, setor, responsavel, status, resultado_esperado, pops_relacionados, categoria_id, versao } = req.body;
    const antes = await get('SELECT * FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!antes) return res.status(404).json({ erro: 'Não encontrado' });

    // código: mantém o existente; usa o sugerido pelo editor; ou gera ao ativar
    let codigo = req.body.codigo || antes.codigo;
    if (status === 'ativo' && !codigo) {
      codigo = await proximoCodigo(eid(req), categoria_id || antes.categoria_id || null);
    }

    await run(
      `UPDATE processos SET titulo=$1,objetivo=$2,descricao=$3,setor=$4,responsavel=$5,status=$6,
       resultado_esperado=$7,pops_relacionados=$8,codigo=$9,categoria_id=$10,versao=$11,updated_at=NOW()
       WHERE id=$12 AND empresa_id=$13`,
      [titulo, objetivo||null, descricao||null, setor||null, responsavel||null, status||'rascunho',
       resultado_esperado||null, pops_relacionados||null, codigo, categoria_id||null, versao||antes.versao||'1.0', req.params.id, eid(req)]
    );
    if (req.body.departamentos_ids !== undefined) {
      const dep = await resolverDeptsProc(req.body.departamentos_ids, eid(req));
      await run('UPDATE processos SET departamentos_ids=$1, departamentos_nomes=$2 WHERE id=$3 AND empresa_id=$4',
        [dep?.idsJson || null, dep?.nomes || null, req.params.id, eid(req)]);
    }
    // Histórico só para eventos relevantes do ciclo de vida (evita spam do autosave a cada 2s).
    // Edições de conteúdo (objetivo/descrição/etc.) NÃO geram entrada de histórico — igual ao POP.
    const mudancas = [];
    if (antes.status !== status)   mudancas.push(`Status: ${antes.status} → ${status}`);
    if (!antes.codigo && codigo)   mudancas.push(`Código gerado: ${codigo}`);
    if (antes.versao !== (versao||antes.versao) && versao) mudancas.push(`Versão: v${antes.versao || '1.0'} → v${versao}`);
    if (mudancas.length) await registrarHistorico(req.params.id, eid(req), req.usuario, 'editado', { mudancas, titulo });
    res.json({ ok: true, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!['admin', 'gestor'].includes(req.usuario.perfil))
      return res.status(403).json({ erro: 'Sem permissão para excluir processos' });
    const item = await get('SELECT titulo FROM processos WHERE id=$1 AND empresa_id=$2', [req.params.id, eid(req)]);
    if (!item) return res.status(404).json({ erro: 'Não encontrado' });
    await run(
      'UPDATE processos SET excluido_em=NOW(), excluido_por=$1, excluido_por_nome=$2 WHERE id=$3 AND empresa_id=$4',
      [req.usuario.id, req.usuario.nome, req.params.id, eid(req)]
    );
    await registrarHistorico(req.params.id, eid(req), req.usuario, 'excluido', { titulo: item.titulo });
    res.json({ ok: true, titulo: item.titulo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
