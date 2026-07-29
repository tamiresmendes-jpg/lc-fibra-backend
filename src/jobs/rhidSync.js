// Sincronizador do Ponto (RHID) — baixa a apuração de todos os colaboradores em
// segundo plano e guarda no Kronos, para o Dashboard ler rápido do banco local.
const { run, get, all } = require('../config/database');

const BASE_PADRAO = 'https://rhid.com.br/v2/api.svc';
const INTERVALO_MS = 30 * 60 * 1000; // roda o ciclo completo a cada 30 min
const CONC = 3;                       // colaboradores em paralelo (evita HTTP 500/limite)
const PAGE = 100;                     // /person quebra em páginas grandes

let pronto = false;
async function garantir() {
  if (pronto) return;
  await run(`CREATE TABLE IF NOT EXISTS rhid_ponto_dia (
    empresa_id TEXT,
    id_person INTEGER,
    nome TEXT,
    id_department INTEGER,
    departamento TEXT,
    data DATE,
    trabalhado_min INTEGER DEFAULT 0,
    extra_min INTEGER DEFAULT 0,
    extra_cem BOOLEAN DEFAULT false,
    noturno_min INTEGER DEFAULT 0,
    falta_min INTEGER DEFAULT 0,
    falta_dia BOOLEAN DEFAULT false,
    atraso_min INTEGER DEFAULT 0,
    saldo_min INTEGER DEFAULT 0,
    abono_min INTEGER DEFAULT 0,
    atestado BOOLEAN DEFAULT false,
    ativo BOOLEAN DEFAULT true,
    atualizado_em TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (empresa_id, id_person, data)
  )`);
  await run(`ALTER TABLE rhid_ponto_dia ADD COLUMN IF NOT EXISTS ativo BOOLEAN DEFAULT true`);
  await run(`ALTER TABLE rhid_ponto_dia ADD COLUMN IF NOT EXISTS extra50_min INTEGER DEFAULT 0`);
  await run(`ALTER TABLE rhid_ponto_dia ADD COLUMN IF NOT EXISTS extra100_min INTEGER DEFAULT 0`);
  await run(`ALTER TABLE rhid_ponto_dia ADD COLUMN IF NOT EXISTS sobreaviso_min INTEGER DEFAULT 0`);
  pronto = true;
}

// Split de horas extras por percentual (50% x 100%) usando os campos do RHID.
// percentuaisExtra = [50,100,...]; horaExtraDeCadaPercentual = minutos de cada um.
function splitExtras(dia) {
  let e50 = 0, e100 = 0;
  const perc = Array.isArray(dia.percentuaisExtra) ? dia.percentuaisExtra : [];
  const horas = Array.isArray(dia.horaExtraDeCadaPercentual) ? dia.horaExtraDeCadaPercentual : [];
  if (perc.length && horas.length) {
    perc.forEach((p, i) => {
      const min = Math.round(horas[i] || 0);
      if (Number(p) >= 100) e100 += min; else e50 += min;
    });
  } else {
    // fallback: usa a regra domingo/feriado/folga
    const tot = Math.round(dia.horasExtrasCalculadas || 0);
    if (ehCem(dia)) e100 += tot; else e50 += tot;
  }
  return { e50, e100 };
}

function baseDe(cfg) { return (cfg.base_url || BASE_PADRAO).replace(/\/+$/, ''); }

async function login(cfg) {
  const r = await fetch(baseDe(cfg) + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.senha, system: 'rhid' }),
  });
  const j = await r.json().catch(() => ({}));
  return j.accessToken || null;
}

async function apiGet(cfg, token, caminho, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') qs.append(k, v);
  const url = baseDe(cfg) + caminho + (qs.toString() ? '?' + qs.toString() : '');
  const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j, texto: t };
}

function listaDe(j) { return Array.isArray(j) ? j : (j?.records || j?.data || []); }

async function paginar(cfg, token, caminho) {
  const tudo = []; let start = 0;
  while (tudo.length < 10000) {
    const r = await apiGet(cfg, token, caminho, { start, length: PAGE });
    if (r.status !== 200 || !r.json) break;
    const lote = listaDe(r.json);
    tudo.push(...lote);
    if (lote.length < PAGE) break;
    start += PAGE;
  }
  return tudo;
}

// A apuração vem como string JSON (às vezes dupla) contendo um array de dias
function parseApuracao(texto, json) {
  let d = json;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch {} }
  if (d == null && texto) { try { d = JSON.parse(texto); if (typeof d === 'string') d = JSON.parse(d); } catch {} }
  return Array.isArray(d) ? d : [];
}

function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

// Um dia é "100%" (domingo/feriado/folga) — extras valem 100%; senão 50%
function ehCem(dia) {
  const dow = new Date(dia.date).getDay();
  return !!(dia.isHoliday || dia.folga || dow === 0);
}

function temAtestado(dia) {
  const marc = dia.listAfdtManutencao || [];
  return marc.some(m => /atest/i.test(m.abreviationJustification || '') || /atest/i.test(m.reason || ''));
}

async function sincronizarEmpresa(empresa_id, cfg) {
  const token = await login(cfg);
  if (!token) { console.warn(`[rhidSync] ${empresa_id}: login falhou`); return; }

  // mapa de departamentos
  const deptos = {};
  for (const d of await paginar(cfg, token, '/department')) deptos[d.id] = d.description || d.name || d.nome;

  const pessoas = await paginar(cfg, token, '/person');
  // janela: início do mês passado até hoje
  const hoje = new Date();
  const ini = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
  const dataIni = ymd(ini), dataFinal = ymd(hoje);

  let ok = 0, falhas = 0;
  for (let i = 0; i < pessoas.length; i += CONC) {
    const lote = pessoas.slice(i, i + CONC);
    await Promise.all(lote.map(async (p) => {
      try {
        const r = await apiGet(cfg, token, '/apuracao_ponto', { idPerson: p.id, dataIni, dataFinal });
        if (r.status !== 200) { falhas++; return; }
        const dias = parseApuracao(r.texto, r.json);
        for (const dia of dias) {
          const data = ymd(new Date(dia.date));
          const { e50, e100 } = splitExtras(dia);
          await run(
            `INSERT INTO rhid_ponto_dia
              (empresa_id,id_person,nome,id_department,departamento,data,trabalhado_min,extra_min,extra_cem,extra50_min,extra100_min,sobreaviso_min,noturno_min,falta_min,falta_dia,atraso_min,saldo_min,abono_min,atestado,ativo,atualizado_em)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW())
             ON CONFLICT (empresa_id,id_person,data) DO UPDATE SET
               nome=EXCLUDED.nome, id_department=EXCLUDED.id_department, departamento=EXCLUDED.departamento,
               trabalhado_min=EXCLUDED.trabalhado_min, extra_min=EXCLUDED.extra_min, extra_cem=EXCLUDED.extra_cem,
               extra50_min=EXCLUDED.extra50_min, extra100_min=EXCLUDED.extra100_min, sobreaviso_min=EXCLUDED.sobreaviso_min,
               noturno_min=EXCLUDED.noturno_min, falta_min=EXCLUDED.falta_min, falta_dia=EXCLUDED.falta_dia,
               atraso_min=EXCLUDED.atraso_min, saldo_min=EXCLUDED.saldo_min, abono_min=EXCLUDED.abono_min,
               atestado=EXCLUDED.atestado, ativo=EXCLUDED.ativo, atualizado_em=NOW()`,
            [
              empresa_id, p.id, p.name || '', p.idDepartment ?? null, deptos[p.idDepartment] || null, data,
              Math.round(dia.totalHorasTrabalhadas || 0),
              Math.round(dia.horasExtrasCalculadas || 0),
              ehCem(dia),
              e50, e100,
              Math.round(dia.sobreavisoTrabalhado || 0),
              Math.round(dia.horasTotalNoturno || 0),
              Math.round((dia.horasApenasFalta || 0) + (dia.horasFaltaAtraso || 0)),
              !!dia.faltaDiaInteiro,
              Math.round((dia.atrasoEntrada || 0) + (dia.saidaAntecipada || 0)),
              Math.round(dia.saldoBancoFinalDia || 0),
              Math.round(dia.minutosAbono || 0),
              temAtestado(dia),
              p.status === 1,
            ]
          );
        }
        ok++;
      } catch (e) { falhas++; }
    }));
  }
  console.log(`[rhidSync] ${empresa_id}: apurados ${ok} colaboradores (${falhas} falhas) — ${dataIni}..${dataFinal}`);
}

async function tick() {
  try {
    await garantir();
    const empresas = await all('SELECT empresa_id, base_url, email, senha FROM integracao_rhid WHERE email IS NOT NULL AND senha IS NOT NULL');
    for (const cfg of empresas) {
      await sincronizarEmpresa(cfg.empresa_id, { base_url: cfg.base_url, email: cfg.email, senha: cfg.senha });
    }
  } catch (e) { console.error('[rhidSync]', e.message); }
}

let timer = null;
async function iniciar() {
  try {
    await garantir();
    setTimeout(tick, 20 * 1000); // primeira carga 20s após subir
    timer = setInterval(tick, INTERVALO_MS);
    console.log(`[rhidSync] iniciado (ciclo a cada ${INTERVALO_MS / 60000} min)`);
  } catch (e) { console.error('[rhidSync] falha ao iniciar:', e.message); }
}

module.exports = { iniciar, tick, garantir };
