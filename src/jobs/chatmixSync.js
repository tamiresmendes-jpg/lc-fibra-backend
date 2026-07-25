// Sincronizador do Chatmix.
// A rota /attendances/closed do Chatmix só permite 2 requisições/minuto por empresa,
// então NÃO dá para puxar tudo em tempo real. Este job puxa 1 página a cada ~35s
// (≈1,7 req/min, seguro) e guarda os atendimentos no banco do Kronos. As telas de
// relatório (departamento, atendente, meta) leem do banco — rápido e completo.

const { run, get, all } = require('../config/database');

const BASE = 'https://srv6.chatmix.com.br';
const API = '/api-v2/public-api';
const PER_PAGE = 50;
const JANELA_DIAS = 30;          // janela móvel sincronizada (máx. 30 dias pela API)
const INTERVALO_MS = 35 * 1000;  // ~1,7 req/min (limite é 2/min)

const espera = ms => new Promise(r => setTimeout(r, ms));

async function garantirTabelas() {
  await run(`CREATE TABLE IF NOT EXISTS chatmix_atendimentos (
    empresa_id TEXT NOT NULL,
    atendimento_id BIGINT NOT NULL,
    protocol TEXT,
    created_at TIMESTAMP,
    closed_at TIMESTAMP,
    atendente_id BIGINT,
    atendente_nome TEXT,
    departamento TEXT,
    canal TEXT,
    nota INTEGER,
    respondida BOOLEAN DEFAULT FALSE,
    atualizado_em TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (empresa_id, atendimento_id)
  )`);
  await run(`CREATE INDEX IF NOT EXISTS idx_cxatend_periodo ON chatmix_atendimentos (empresa_id, created_at)`);
  await run(`CREATE TABLE IF NOT EXISTS chatmix_sync_estado (
    empresa_id TEXT PRIMARY KEY,
    page INTEGER DEFAULT 1,
    last_page INTEGER DEFAULT 1,
    date_start TEXT,
    date_end TEXT,
    ciclo INTEGER DEFAULT 0,
    total_registros INTEGER DEFAULT 0,
    ultima_pagina_em TIMESTAMP,
    ultimo_ciclo_em TIMESTAMP
  )`);
}

function hojeISO() { return new Date().toISOString().slice(0, 10); }
function isoMenosDias(dias) { const d = new Date(); d.setDate(d.getDate() - dias); return d.toISOString().slice(0, 10); }

async function chamar(token, caminho, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.append(k, v);
  const url = BASE + API + caminho + (qs.toString() ? '?' + qs.toString() : '');
  const headers = { 'Accept': 'application/json', 'X-auth': token, 'User-Agent': 'Mozilla/5.0 Kronos-Sync' };
  for (let i = 0; i < 3; i++) {
    const resp = await fetch(url, { headers });
    const texto = await resp.text();
    if (resp.status === 429 || resp.status === 403) { await espera(2000 * (i + 1)); continue; }
    let json = null; try { json = JSON.parse(texto); } catch { /* */ }
    return { status: resp.status, json };
  }
  return { status: 429, json: null };
}

function normalizaData(s) { return s ? String(s).replace(' ', 'T') : null; }

async function salvarAtendimento(empresaId, a) {
  const atendenteNome = a.user ? [a.user.first_name, a.user.last_name].filter(Boolean).join(' ').trim() : null;
  const surveys = a.satisfaction_surveys || [];
  const survey = surveys.find(s => s.satisfaction != null);
  const nota = survey ? Number(survey.satisfaction) : null;
  await run(
    `INSERT INTO chatmix_atendimentos
      (empresa_id, atendimento_id, protocol, created_at, closed_at, atendente_id, atendente_nome, departamento, canal, nota, respondida, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (empresa_id, atendimento_id) DO UPDATE SET
       protocol=EXCLUDED.protocol, created_at=EXCLUDED.created_at, closed_at=EXCLUDED.closed_at,
       atendente_id=EXCLUDED.atendente_id, atendente_nome=EXCLUDED.atendente_nome,
       departamento=EXCLUDED.departamento, canal=EXCLUDED.canal, nota=EXCLUDED.nota,
       respondida=EXCLUDED.respondida, atualizado_em=NOW()`,
    [empresaId, a.id, a.protocol || null, normalizaData(a.created_at), normalizaData(a.closed_at),
     a.user?.id || null, atendenteNome, a.department?.title || a.department?.name || null,
     a.channel?.name || null, nota, !!nota]
  );
}

// Executa UM passo (uma página) para uma empresa
async function passo(empresaId, token) {
  let estado = await get('SELECT * FROM chatmix_sync_estado WHERE empresa_id = $1', [empresaId]);
  if (!estado) {
    await run('INSERT INTO chatmix_sync_estado (empresa_id, page, date_start, date_end) VALUES ($1,1,$2,$3)',
      [empresaId, isoMenosDias(JANELA_DIAS), hojeISO()]);
    estado = await get('SELECT * FROM chatmix_sync_estado WHERE empresa_id = $1', [empresaId]);
  }
  const page = estado.page || 1;
  const ds = estado.date_start || isoMenosDias(JANELA_DIAS);
  const de = estado.date_end || hojeISO();

  const r = await chamar(token, '/attendances/closed', { date_start: ds, date_end: de, per_page: PER_PAGE, page });
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status };

  const dados = Array.isArray(r.json.data) ? r.json.data : [];
  for (const a of dados) await salvarAtendimento(empresaId, a);
  const lastPage = r.json.meta?.last_page || 1;

  const total = await get('SELECT COUNT(*)::int AS n FROM chatmix_atendimentos WHERE empresa_id = $1', [empresaId]);

  let novaPage = page + 1, novoDs = ds, novoDe = de, ciclo = estado.ciclo || 0;
  let fimCiclo = false;
  if (novaPage > lastPage) {
    // Terminou de varrer a janela → recomeça do início com a janela atualizada
    novaPage = 1; novoDs = isoMenosDias(JANELA_DIAS); novoDe = hojeISO(); ciclo += 1; fimCiclo = true;
  }
  await run(
    `UPDATE chatmix_sync_estado SET page=$2, last_page=$3, date_start=$4, date_end=$5, ciclo=$6,
       total_registros=$7, ultima_pagina_em=NOW()${fimCiclo ? ', ultimo_ciclo_em=NOW()' : ''}
     WHERE empresa_id=$1`,
    [empresaId, novaPage, lastPage, novoDs, novoDe, ciclo, total?.n || 0]
  );
  return { ok: true, page, lastPage, recebidos: dados.length, total: total?.n || 0 };
}

let rodando = false;
async function tick() {
  if (rodando) return;
  rodando = true;
  try {
    // Empresas com token do Chatmix configurado, priorizando a menos recente
    const empresas = await all(`SELECT c.empresa_id, c.token,
        COALESCE(e.ultima_pagina_em, '1970-01-01') AS ult
      FROM integracao_chatmix c
      LEFT JOIN chatmix_sync_estado e ON e.empresa_id = c.empresa_id
      WHERE c.token IS NOT NULL AND c.token <> ''
      ORDER BY ult ASC LIMIT 1`);
    if (!empresas.length) return;
    const { empresa_id, token } = empresas[0];
    const res = await passo(empresa_id, token);
    if (res.ok) console.log(`[chatmixSync] empresa ${empresa_id}: pág ${res.page}/${res.lastPage}, +${res.recebidos}, total ${res.total}`);
    else console.warn(`[chatmixSync] empresa ${empresa_id}: falha HTTP ${res.status}`);
  } catch (e) {
    console.error('[chatmixSync]', e.message);
  } finally {
    rodando = false;
  }
}

let timer = null;
async function iniciar() {
  try {
    await garantirTabelas();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, INTERVALO_MS);
    console.log(`[chatmixSync] iniciado (1 página a cada ${INTERVALO_MS / 1000}s)`);
    setTimeout(tick, 5000); // primeiro passo logo após subir
  } catch (e) { console.error('[chatmixSync] falha ao iniciar:', e.message); }
}

module.exports = { iniciar, tick, garantirTabelas };
