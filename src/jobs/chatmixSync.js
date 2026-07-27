// Sincronizador do Chatmix.
// A rota /attendances/closed do Chatmix só permite 2 requisições/minuto por empresa,
// então NÃO dá para puxar tudo em tempo real. Este job puxa 1 página a cada ~35s
// (≈1,7 req/min, seguro) e guarda os atendimentos no banco do Kronos. As telas de
// relatório (departamento, atendente, meta) leem do banco — rápido e completo.

const { run, get, all } = require('../config/database');
const { notificar } = require('../utils/discord');
const FILA_SEG = 30;        // alerta: cliente na fila há mais de 30 segundos
const RESP_SEG = 8 * 60;    // alerta: cliente esperando resposta da atendente há mais de 8 min
const JANELA_ALERTA_H = 23; // alerta: janela de 24h prestes a fechar (avisa a partir de 23h)

const BASE = 'https://srv6.chatmix.com.br';
const API = '/api-v2/public-api';
const PER_PAGE = 50;
// A API limita page<=100 e per_page<=50 => teto de 5.000 registros por janela de datas.
// Com ~1.000 atendimentos/dia, usamos janelas de 3 dias (≈3 mil) para não estourar.
const JANELA_SPAN = 2;           // 3 dias inclusivos por janela
const MAX_PAGE = 100;            // teto de página da API
const FLOOR_DATE = '2026-01-01'; // backfill de atendimentos vai até aqui (janeiro/2026)
const INTERVALO_MS = 32 * 1000;  // ~1,87 req/min (limite é 2/min por empresa)

const espera = ms => new Promise(r => setTimeout(r, ms));
function addDias(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

// Classificação da pesquisa de satisfação por tags configuradas no Chatmix.
// (best-effort: reproduz o mapeamento do painel; enviar lista completa aumenta a precisão)
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const TAGS_INSATISFEITO = ['ruim', 'pessimo', 'horrivel', 'terrivel', 'fraco', 'insatisfatorio', 'insatisfeito', 'muito insatisfeito', 'nao gostei', 'nao resolveu', 'nao funcionou', 'nao deu certo', 'nada resolvido', 'nao adiantou', 'nao ajudou', 'nao prestou', 'piorou', 'lento', 'demorado', 'atendimento demorado', 'atendimento ruim', 'atendimento pessimo', 'atendimento horrivel', 'atendimento fraco', 'atendente grosso', 'falta de atencao', 'falta de respeito', 'falta de compromisso', 'decepcionado', 'chateado', 'incomodada', 'problema continua', 'internet ruim', 'continua ruim', 'bosta'].map(norm);
const TAGS_SATISFEITO = ['obrigado', 'obrigada', 'muito obrigado', 'muito obrigada', 'agradeco', 'agradeco muito', 'valeu', 'ok', 'obgd', 'obg', 'amem', 'ah sim', 'certo', 'ficou tudo certo', 'igualmente', 'ja foi resolvido', 'muito bom', 'muito obg', 'muito obrigado pelo atendimento', 'muito obrigada pelo atendimento', 'nao obrigada', 'nao obrigado', 'nao obgd', 'nota 10', 'otimo', 'para nos', 'pra vc tambem', 'pra voce tambem', 'satisfeita', 'satisfeito', 'satisfeito obrigado', 'satisfeita obrigada', 'ta bem', 'ta bom', 'ta ok', 'ta otimo', 'vc tambem', 'vc tambem', 'foi bom', 'foi otimo', 'foi excelente', 'foi top', 'top'].map(norm);
const NUM_INSATISFEITO = ['0', '1'];
const NUM_SATISFEITO = ['5', '10', '100', '1000'];
function bateTag(texto, tags, nums) {
  const n = norm(texto);
  if (!n) return false;
  if (nums.includes(n)) return true;                          // resposta numérica exata
  return tags.some(t => t.length >= 4 ? n.includes(t) : n === t);
}
// Retorna 'satisfeito' | 'insatisfeito' | null para o texto de UMA resposta do cliente
function classificaResposta(texto) {
  if (bateTag(texto, TAGS_INSATISFEITO, NUM_INSATISFEITO)) return 'insatisfeito';
  if (bateTag(texto, TAGS_SATISFEITO, NUM_SATISFEITO)) return 'satisfeito';
  return null;
}

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
  // Colunas de mensagens (cobrança por mensagem entregue da empresa)
  await run(`ALTER TABLE chatmix_atendimentos ADD COLUMN IF NOT EXISTS msgs_enviadas INTEGER`);   // sent, entregues, não-internas (cobráveis)
  await run(`ALTER TABLE chatmix_atendimentos ADD COLUMN IF NOT EXISTS msgs_recebidas INTEGER`);  // do cliente (grátis)
  await run(`ALTER TABLE chatmix_atendimentos ADD COLUMN IF NOT EXISTS msgs_internas INTEGER`);   // notas internas (não cobram)
  await run(`ALTER TABLE chatmix_atendimentos ADD COLUMN IF NOT EXISTS msgs_sync_em TIMESTAMP`);  // null = mensagens ainda não contadas
  await run(`ALTER TABLE chatmix_atendimentos ADD COLUMN IF NOT EXISTS satisfacao_msg TEXT`);    // satisfeito|insatisfeito|invalida|null (deduzido das mensagens)
  await run(`CREATE INDEX IF NOT EXISTS idx_cxatend_msgsync ON chatmix_atendimentos (empresa_id, closed_at) WHERE msgs_sync_em IS NULL`);
  await run(`CREATE TABLE IF NOT EXISTS chatmix_departamentos (
    empresa_id TEXT NOT NULL, dep_id BIGINT NOT NULL, nome TEXT,
    PRIMARY KEY (empresa_id, dep_id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS chatmix_alertas (
    empresa_id TEXT NOT NULL, atendimento_id BIGINT NOT NULL, tipo TEXT NOT NULL,
    alertado_em TIMESTAMP DEFAULT NOW(), PRIMARY KEY (empresa_id, atendimento_id, tipo)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS chatmix_config (
    empresa_id TEXT PRIMARY KEY,
    preco_msg NUMERIC DEFAULT 0.0350,
    mensagens_desde DATE
  )`);
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

// Chatmix trabalha em horário de Brasília (BRT, -3). "Hoje" tem que ser o dia em BRT.
function hojeISO() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function isoMenosDias(dias) { return new Date(Date.now() - 3 * 3600 * 1000 - dias * 86400000).toISOString().slice(0, 10); }

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
  // Mantém o mapa de departamentos (id -> nome) para a tela de status ao vivo
  if (a.department?.id && a.department?.title) {
    run(`INSERT INTO chatmix_departamentos (empresa_id, dep_id, nome) VALUES ($1,$2,$3)
         ON CONFLICT (empresa_id, dep_id) DO UPDATE SET nome=EXCLUDED.nome`,
      [empresaId, a.department.id, a.department.title]).catch(() => {});
  }
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
  const hoje = hojeISO();
  const janelaRecente = () => ({ ds: addDias(hoje, -JANELA_SPAN), de: hoje });
  let estado = await get('SELECT * FROM chatmix_sync_estado WHERE empresa_id = $1', [empresaId]);
  if (!estado) {
    const jr = janelaRecente();
    await run('INSERT INTO chatmix_sync_estado (empresa_id, page, date_start, date_end) VALUES ($1,1,$2,$3)',
      [empresaId, jr.ds, jr.de]);
    estado = await get('SELECT * FROM chatmix_sync_estado WHERE empresa_id = $1', [empresaId]);
  }
  const page = estado.page || 1;
  const ds = estado.date_start || janelaRecente().ds;
  const de = estado.date_end || hoje;

  const r = await chamar(token, '/attendances/closed', { date_start: ds, date_end: de, per_page: PER_PAGE, page });
  if (r.status !== 200 || !r.json) return { ok: false, status: r.status };

  const dados = Array.isArray(r.json.data) ? r.json.data : [];
  for (const a of dados) await salvarAtendimento(empresaId, a);
  const janelaTotal = r.json.meta?.total || 0;
  // A API não deixa passar da página 100; se a janela tiver mais, paramos em 100
  // (com janelas de 3 dias isso praticamente nunca acontece).
  const lastPage = Math.min(r.json.meta?.last_page || 1, MAX_PAGE);
  if ((r.json.meta?.last_page || 1) > MAX_PAGE) console.warn(`[chatmixSync] janela ${ds}..${de} tem ${janelaTotal} registros (>5000); alguns mais antigos podem faltar`);

  const total = await get('SELECT COUNT(*)::int AS n FROM chatmix_atendimentos WHERE empresa_id = $1', [empresaId]);

  let novaPage = page + 1, novoDs = ds, novoDe = de, ciclo = estado.ciclo || 0;
  let fimCiclo = false, fase = 'backfill';
  if (novaPage > lastPage) {
    // Terminou de varrer esta janela de 30 dias.
    if (janelaTotal > 0 && ds > FLOOR_DATE) {
      // Havia dados → volta 30 dias no tempo (backfill do histórico)
      novoDe = addDias(ds, -1);
      novoDs = addDias(novoDe, -JANELA_SPAN);
      novaPage = 1;
    } else {
      // Janela vazia (chegou no começo do histórico) ou atingiu o limite →
      // recomeça da janela recente para manter tudo atualizado.
      const jr = janelaRecente();
      novoDs = jr.ds; novoDe = jr.de; novaPage = 1; ciclo += 1; fimCiclo = true; fase = 'refresh';
    }
  }
  await run(
    `UPDATE chatmix_sync_estado SET page=$2, last_page=$3, date_start=$4, date_end=$5, ciclo=$6,
       total_registros=$7, ultima_pagina_em=NOW()${fimCiclo ? ', ultimo_ciclo_em=NOW()' : ''}
     WHERE empresa_id=$1`,
    [empresaId, novaPage, lastPage, novoDs, novoDe, ciclo, total?.n || 0]
  );
  return { ok: true, page, lastPage, janela: `${ds}..${de}`, recebidos: dados.length, total: total?.n || 0, fase };
}

// Conta mensagens de UM atendimento (o mais recente ainda não contado, a partir de mensagens_desde).
// Cobrável = type 'sent' + origin != 'internal' + ack >= 2 (entregue). Recebidas do cliente = grátis.
async function passoMensagem(empresaId, token, desde) {
  const alvo = await get(
    `SELECT atendimento_id FROM chatmix_atendimentos
     WHERE empresa_id=$1 AND msgs_sync_em IS NULL AND closed_at::date >= $2
     ORDER BY closed_at DESC LIMIT 1`, [empresaId, desde]);
  if (!alvo) return { fez: false };
  const id = alvo.atendimento_id;
  const r = await chamar(token, `/attendances/${id}/messages`, { limit: 500 });
  if (r.status !== 200) return { fez: true, erro: 'HTTP ' + r.status };
  const j = r.json;
  const msgs = Array.isArray(j) ? j : (j?.data || (j ? Object.values(j).filter(v => v && typeof v === 'object' && v.type) : []));
  const conteudo = c => { if (!c) return ''; if (typeof c === 'string') return c; return c.content || c.text || c.title || ''; };
  let env = 0, rec = 0, intn = 0;
  let surveyTs = null;
  const respostas = []; // respostas do cliente (para classificar após achar a pesquisa)
  for (const m of msgs) {
    if (m.type === 'sent') {
      if (m.origin === 'internal') { intn++; }
      else if (Number(m.ack) >= 2) env++; // entregue/lido = cobrável
      if (m.origin === 'survey') surveyTs = Number(m.timestamp) || surveyTs; // pergunta da pesquisa enviada
    } else if (m.type === 'received') {
      rec++;
      respostas.push({ ts: Number(m.timestamp) || 0, txt: conteudo(m.content) });
    }
  }
  // Classifica a satisfação: pesquisa enviada + resposta(s) do cliente depois dela,
  // batendo nas tags configuradas (satisfeito/insatisfeito). Se respondeu e não bate → inválida.
  let satisfacao = null;
  if (surveyTs) {
    const posSurvey = respostas.filter(r => r.ts >= surveyTs - 5); // margem de 5s
    for (const r of posSurvey) {
      const c = classificaResposta(r.txt);
      if (c === 'insatisfeito') { satisfacao = 'insatisfeito'; break; }
      if (c === 'satisfeito' && satisfacao !== 'insatisfeito') satisfacao = 'satisfeito';
    }
    if (!satisfacao && posSurvey.length) satisfacao = 'invalida'; // respondeu, mas não bateu tag
  }
  await run(`UPDATE chatmix_atendimentos SET msgs_enviadas=$3, msgs_recebidas=$4, msgs_internas=$5, satisfacao_msg=$6, msgs_sync_em=NOW()
             WHERE empresa_id=$1 AND atendimento_id=$2`, [empresaId, id, env, rec, intn, satisfacao]);
  return { fez: true, id, env, rec, intn, satisfacao };
}

// Mantém o DIA ATUAL sempre completo (tempo real): escaneia a janela de hoje,
// 1 página por tick (os encerrados mais novos aparecem na página 1).
let refreshPage = 1;
async function refreshHojePasso(empresaId, token) {
  const hoje = hojeISO();
  const antes = await get('SELECT COUNT(*)::int n FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date=$2', [empresaId, hoje]);
  const r = await chamar(token, '/attendances/closed', { date_start: hoje, date_end: hoje, per_page: PER_PAGE, page: refreshPage });
  if (r.status !== 200 || !r.json) { refreshPage = 1; return { fez: true, erro: 'HTTP ' + r.status }; }
  const dados = Array.isArray(r.json.data) ? r.json.data : [];
  for (const a of dados) await salvarAtendimento(empresaId, a);
  const depois = await get('SELECT COUNT(*)::int n FROM chatmix_atendimentos WHERE empresa_id=$1 AND closed_at::date=$2', [empresaId, hoje]);
  const novos = (depois?.n || 0) - (antes?.n || 0);
  const last = Math.min(r.json.meta?.last_page || 1, MAX_PAGE);
  // Se achou novos, vai mais fundo pra pegar o resto; senão volta pra página 1 (catch dos próximos).
  refreshPage = (novos > 0 && refreshPage < last) ? refreshPage + 1 : 1;
  return { fez: true, page: r.json.meta?.current_page || refreshPage, novos, total_hoje: depois?.n || 0 };
}

let rodando = false;
let contadorTick = 0;
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

    contadorTick++;
    const cfg = await get('SELECT mensagens_desde FROM chatmix_config WHERE empresa_id=$1', [empresa_id]);
    const hojeD = hojeISO();

    // 1) DIA ATUAL EM TEMPO REAL — atendimentos: a cada ~2 ticks, atualiza a janela de hoje.
    if (contadorTick % 2 === 1) {
      const rh = await refreshHojePasso(empresa_id, token);
      if (rh.fez && !rh.erro && (rh.novos > 0 || rh.page > 1)) {
        console.log(`[chatmixSync] hoje: pág ${rh.page} +${rh.novos} (total hoje ${rh.total_hoje})`);
        return;
      }
      if (rh.erro) return;
    }

    // 2) DIA ATUAL EM TEMPO REAL — mensagens: conversa de hoje sem mensagens → processa já.
    if (cfg?.mensagens_desde) {
      const pendHoje = await get(
        `SELECT COUNT(*)::int n FROM chatmix_atendimentos
         WHERE empresa_id=$1 AND msgs_sync_em IS NULL AND closed_at::date = $2`, [empresa_id, hojeD]);
      const desde = cfg.mensagens_desde;
      // Dias anteriores (mensagens) em segundo plano: entram em parte dos ticks.
      const fazerMsg = (pendHoje?.n > 0) || (contadorTick % 4 === 0);
      if (fazerMsg) {
        const m = await passoMensagem(empresa_id, token, desde);
        if (m.fez) {
          if (m.erro) console.warn(`[chatmixSync] msgs ${empresa_id} at.${m.id}: ${m.erro}`);
          else console.log(`[chatmixSync] msgs at.${m.id}: env=${m.env} rec=${m.rec} sat=${m.satisfacao || '-'}`);
          return;
        }
      }
    }

    // 3) SEGUNDO PLANO — backfill do histórico de atendimentos (rumo a janeiro/2026).
    const res = await passo(empresa_id, token);
    if (res.ok) console.log(`[chatmixSync] ${empresa_id}: janela ${res.janela} pág ${res.page}/${res.lastPage} (+${res.recebidos}) total ${res.total} [${res.fase}]`);
    else console.warn(`[chatmixSync] empresa ${empresa_id}: falha HTTP ${res.status}`);
  } catch (e) {
    console.error('[chatmixSync]', e.message);
  } finally {
    rodando = false;
  }
}

// ── Alertas ao vivo (Discord): fila parada e cliente esperando resposta ──
function segDesdeBRT(str) {
  if (!str) return null;
  const t = Date.parse(String(str).replace(' ', 'T') + '-03:00');
  return isNaN(t) ? null : Math.round((Date.now() - t) / 1000);
}
function fmtMin(seg) { const m = Math.floor((seg || 0) / 60); const h = Math.floor(m / 60); return h > 0 ? `${h}h${m % 60}min` : `${m} min`; }

async function jaAlertou(emp, id, tipo) {
  const r = await get('SELECT 1 FROM chatmix_alertas WHERE empresa_id=$1 AND atendimento_id=$2 AND tipo=$3', [emp, id, tipo]);
  return !!r;
}
async function marcarAlerta(emp, id, tipo) {
  await run('INSERT INTO chatmix_alertas (empresa_id, atendimento_id, tipo) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [emp, id, tipo]);
}

async function verificarAlertas(empresaId, token) {
  const [wq, ip, deps] = await Promise.all([
    chamar(token, '/attendances/waiting', { per_page: 100 }).then(r => r.json?.data || []).catch(() => []),
    chamar(token, '/attendances/in-progress', { per_page: 100 }).then(r => r.json?.data || []).catch(() => []),
    all('SELECT dep_id, nome FROM chatmix_departamentos WHERE empresa_id=$1', [empresaId]),
  ]);
  const depNome = {}; deps.forEach(d => { depNome[d.dep_id] = d.nome; });
  const nd = id => depNome[id] || (id ? 'Depto ' + id : '—');
  const nomeCli = a => a.client?.name || a.client?.user || 'Cliente';
  const prot = a => String(a.protocol || '—');
  const nomeAt = a => a.user ? [a.user.first_name, a.user.last_name].filter(Boolean).join(' ').trim() : 'Sem atendente';

  // 1) Fila > 30 segundos → cliente, protocolo, departamento
  // Usa last_activity (entrada na fila / último evento), não created_at (1ª mensagem).
  for (const a of wq) {
    const seg = segDesdeBRT(a.last_activity || a.created_at);
    if (seg != null && seg >= FILA_SEG && !(await jaAlertou(empresaId, a.id, 'fila'))) {
      await notificar(empresaId, 'chatmix', {
        title: '⏳ Cliente aguardando na fila',
        description: `**${nomeCli(a)}** está há **${fmtMin(seg)}** na fila.`,
        color: 0xf59e0b,
        fields: [
          { name: 'Departamento', value: nd(a.departament_id), inline: true },
          { name: 'Protocolo', value: prot(a), inline: true },
        ],
      });
      await marcarAlerta(empresaId, a.id, 'fila');
    }
  }
  // 2) Cliente esperando resposta (última interação foi do cliente) > 8 min → cliente, protocolo, depto, atendente
  for (const a of ip) {
    if (a.last_interaction === 'client') {
      const seg = segDesdeBRT(a.last_activity || a.created_at);
      if (seg != null && seg >= RESP_SEG && !(await jaAlertou(empresaId, a.id, 'sem_resposta'))) {
        await notificar(empresaId, 'chatmix', {
          title: '🔔 Cliente esperando resposta da atendente',
          description: `**${nomeCli(a)}** está há **${fmtMin(seg)}** sem resposta.`,
          color: 0xef4444,
          fields: [
            { name: 'Atendente', value: nomeAt(a), inline: true },
            { name: 'Departamento', value: nd(a.departament_id), inline: true },
            { name: 'Protocolo', value: prot(a), inline: true },
          ],
        });
        await marcarAlerta(empresaId, a.id, 'sem_resposta');
      }
    }
    // 3) Janela de 24h prestes a fechar (a partir de 23h desde a última atividade) → avisa pra mandar mensagem
    const segAtiv = segDesdeBRT(a.last_activity || a.created_at);
    if (segAtiv != null && segAtiv >= JANELA_ALERTA_H * 3600 && segAtiv < 24 * 3600 && !(await jaAlertou(empresaId, a.id, 'janela24h'))) {
      const faltaMin = Math.max(0, Math.round((24 * 3600 - segAtiv) / 60));
      await notificar(empresaId, 'chatmix', {
        title: '⚠️ Janela de 24h vai fechar!',
        description: `A janela de atendimento de **${nomeCli(a)}** fecha em ~**${faltaMin} min**. Envie uma mensagem ao cliente para **manter a comunicação aberta** (senão perde a janela gratuita e a meta).`,
        color: 0xdc2626,
        fields: [
          { name: 'Departamento', value: nd(a.departament_id), inline: true },
          { name: 'Atendente', value: nomeAt(a), inline: true },
        ],
      });
      await marcarAlerta(empresaId, a.id, 'janela24h');
    }
  }
}

let timerAlerta = null;
async function tickAlertas() {
  try {
    const emps = await all(`SELECT c.empresa_id, c.token FROM integracao_chatmix c WHERE c.token IS NOT NULL AND c.token <> ''`);
    for (const e of emps) await verificarAlertas(e.empresa_id, e.token).catch(err => console.error('[chatmixAlertas]', err.message));
  } catch (e) { console.error('[chatmixAlertas]', e.message); }
}

let timer = null;
async function iniciar() {
  try {
    await garantirTabelas();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, INTERVALO_MS);
    if (timerAlerta) clearInterval(timerAlerta);
    timerAlerta = setInterval(tickAlertas, 60 * 1000); // alertas ao vivo a cada 60s (endpoints 25/min)
    console.log(`[chatmixSync] iniciado (1 página a cada ${INTERVALO_MS / 1000}s + alertas 60s)`);
    setTimeout(tick, 5000); // primeiro passo logo após subir
    setTimeout(tickAlertas, 15000);
  } catch (e) { console.error('[chatmixSync] falha ao iniciar:', e.message); }
}

module.exports = { iniciar, tick, garantirTabelas };
