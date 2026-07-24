const express = require('express');
const router = express.Router();
const { run, get, all } = require('../config/database');
const { autenticar } = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.use(autenticar);

let pronto = false;
async function garantir() {
  if (pronto) return;
  try {
    await run(`CREATE TABLE IF NOT EXISTS atalhos (
      id TEXT PRIMARY KEY,
      empresa_id TEXT,
      nome TEXT,
      url TEXT,
      cor TEXT,
      logo TEXT,
      ordem INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    try { await run('ALTER TABLE atalhos ADD COLUMN IF NOT EXISTS logo TEXT'); } catch {}
    pronto = true;
  } catch (e) { console.error('[Atalhos]', e.message); }
}
garantir();

const PADRAO = [
  { nome: 'Discord',     url: 'https://discord.com/app',       cor: '#5865F2' },
  { nome: 'Chatmix',     url: '',                              cor: '#0ea5e9' },
  { nome: 'HubSoft',     url: '',                              cor: '#f59e0b' },
  { nome: 'UOL E-mail',  url: 'https://email.uol.com.br',      cor: '#ef4444' },
];

// Lista os atalhos da empresa (cria os padrões na 1ª vez)
router.get('/', async (req, res) => {
  try {
    await garantir();
    let rows = await all('SELECT * FROM atalhos WHERE empresa_id = $1 ORDER BY ordem ASC, created_at ASC', [req.usuario.empresa_id]);
    if (!rows.length) {
      for (let i = 0; i < PADRAO.length; i++) {
        const p = PADRAO[i];
        await run('INSERT INTO atalhos (id, empresa_id, nome, url, cor, ordem) VALUES ($1,$2,$3,$4,$5,$6)',
          [uuidv4(), req.usuario.empresa_id, p.nome, p.url || null, p.cor, i]);
      }
      rows = await all('SELECT * FROM atalhos WHERE empresa_id = $1 ORDER BY ordem ASC, created_at ASC', [req.usuario.empresa_id]);
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

function soAdminGestor(req, res) {
  if (!['admin', 'gestor'].includes(req.usuario.perfil)) { res.status(403).json({ erro: 'Sem permissão' }); return false; }
  return true;
}

router.post('/', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { nome, url, cor, logo } = req.body;
    if (!nome || !nome.trim()) return res.status(400).json({ erro: 'Informe o nome' });
    const id = uuidv4();
    const ordem = (await get('SELECT COALESCE(MAX(ordem),0)+1 AS n FROM atalhos WHERE empresa_id=$1', [req.usuario.empresa_id]))?.n || 0;
    await run('INSERT INTO atalhos (id, empresa_id, nome, url, cor, logo, ordem) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, req.usuario.empresa_id, nome.trim(), (url || '').trim() || null, cor || '#7B55F1', logo || null, ordem]);
    res.status(201).json({ id });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    const { nome, url, cor, logo } = req.body;
    await run('UPDATE atalhos SET nome=$1, url=$2, cor=$3, logo=$4 WHERE id=$5 AND empresa_id=$6',
      [(nome || '').trim(), (url || '').trim() || null, cor || '#7B55F1', logo || null, req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!soAdminGestor(req, res)) return;
    await run('DELETE FROM atalhos WHERE id=$1 AND empresa_id=$2', [req.params.id, req.usuario.empresa_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

module.exports = router;
