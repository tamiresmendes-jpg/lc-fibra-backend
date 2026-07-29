const { run, all } = require('../config/database');
const { postWebhook, garantirTabela, registrarEnvio, resolverWebhook, COR } = require('./discord');

// Data de hoje no fuso de São Paulo (YYYY-MM-DD)
function hojeSP() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  return s;
}
function horaSP() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
}

// Config por evento definida pela usuária (JSON notif_cfg): { modo, antecedencia, hora }
function evCfg(cfg, ev, horaDefault) {
  let m = {}; try { m = cfg.notif_cfg ? JSON.parse(cfg.notif_cfg) : {}; } catch {}
  const c = m[ev] || {};
  const ant = Number.isFinite(+c.antecedencia) ? Math.max(0, +c.antecedencia) : 0;
  const hora = (c.hora !== undefined && c.hora !== null && c.hora !== '') ? +c.hora : horaDefault;
  return { modo: c.modo || 'agendado', antecedencia: ant, hora };
}
// Data-alvo = hoje + antecedência (o aviso de "N dias antes" dispara hoje para eventos de daqui a N dias)
function dataAlvo(hojeStr, antecedencia) {
  const d = new Date(hojeStr + 'T12:00'); d.setDate(d.getDate() + (antecedencia || 0));
  return { mes: d.getMonth() + 1, dia: d.getDate(), ymd: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` };
}
function rotuloAntecedencia(ant) {
  if (!ant) return 'hoje';
  if (ant === 1) return 'amanhã';
  if (ant === 7) return 'em 1 semana';
  return `em ${ant} dias`;
}

async function enviarAniversariantesDoDia() {
  try {
    await garantirTabela();
    const hoje = hojeSP();

    const empresas = await all(
      `SELECT * FROM integracao_discord
       WHERE ativo = 1 AND ev_aniversario = 1 AND webhook_url IS NOT NULL
       AND (ultimo_aniv_env IS DISTINCT FROM $1)`,
      [hoje]
    );

    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'aniversario', cfg.hora_aniversario ?? cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue; // marcada como tempo real → não usa agendamento
      if (horaSP() < ec.hora) continue; // respeita a hora configurada
      await run('UPDATE integracao_discord SET ultimo_aniv_env = $1 WHERE empresa_id = $2', [hoje, cfg.empresa_id]);

      const alvo = dataAlvo(hoje, ec.antecedencia);
      const aniversariantes = await all(
        `SELECT nome FROM usuarios
         WHERE empresa_id = $1 AND ativo = 1 AND data_nascimento IS NOT NULL
         AND (COALESCE(tipo_usuario,'colaborador')='colaborador' OR COALESCE(mostrar_aniversario,0)=1)
         AND EXTRACT(MONTH FROM data_nascimento::date) = $2
         AND EXTRACT(DAY   FROM data_nascimento::date) = $3
         ORDER BY nome`,
        [cfg.empresa_id, alvo.mes, alvo.dia]
      );

      if (!aniversariantes.length) continue;

      const url = await resolverWebhook(cfg.empresa_id, cfg, 'aniversario');
      if (!url) continue;
      const quando = rotuloAntecedencia(ec.antecedencia);
      const nomes = aniversariantes.map(a => `🎂 **${a.nome}**`).join('\n');
      const ok = await postWebhook(url, {
        title: ec.antecedencia ? `🎉 Aniversariantes ${quando}!` : '🎉 Aniversariantes de hoje!',
        description: `${ec.antecedencia ? `Faz aniversário ${quando}` : 'Hoje é dia de comemorar'}:\n\n${nomes}\n\nQue todos possam celebrar com muita alegria! 🥳`,
        color: COR.laranja,
        footer: { text: 'Kronos — Aniversariantes' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'aniversario', `Aniversariantes ${quando} (${aniversariantes.length})`, ok, ok ? null : 'Falha no envio');
    }
  } catch (e) {
    console.error('[DiscordScheduler]', e.message);
  }
}

// Aniversário de EMPRESA (tempo de casa) — dia/mês da admissão
async function enviarAniversarioEmpresaDoDia() {
  try {
    await garantirTabela();
    await run(`ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ultimo_aniv_emp_env TEXT`);
    const hoje = hojeSP();

    const empresas = await all(
      `SELECT * FROM integracao_discord
       WHERE ativo = 1 AND ev_aniversario_empresa = 1 AND webhook_url IS NOT NULL
       AND (ultimo_aniv_emp_env IS DISTINCT FROM $1)`,
      [hoje]
    );

    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'aniversario_empresa', cfg.hora_aniversario_empresa ?? cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue;
      if (horaSP() < ec.hora) continue;
      await run('UPDATE integracao_discord SET ultimo_aniv_emp_env = $1 WHERE empresa_id = $2', [hoje, cfg.empresa_id]);

      const alvo = dataAlvo(hoje, ec.antecedencia);
      const lista = await all(
        `SELECT nome, ($4 - EXTRACT(YEAR FROM data_admissao::date))::int AS anos
         FROM usuarios
         WHERE empresa_id = $1 AND ativo = 1 AND data_admissao IS NOT NULL
         AND EXTRACT(MONTH FROM data_admissao::date) = $2
         AND EXTRACT(DAY   FROM data_admissao::date) = $3
         AND EXTRACT(YEAR FROM data_admissao::date) < $4
         ORDER BY nome`,
        [cfg.empresa_id, alvo.mes, alvo.dia, Number(alvo.ymd.slice(0, 4))]
      );
      if (!lista.length) continue;

      const url = await resolverWebhook(cfg.empresa_id, cfg, 'aniversario_empresa');
      if (!url) continue;
      const quando = rotuloAntecedencia(ec.antecedencia);
      const nomes = lista.map(a => `🏢 **${a.nome}** — ${a.anos} ano${a.anos !== 1 ? 's' : ''} de casa`).join('\n');
      const ok = await postWebhook(url, {
        title: ec.antecedencia ? `🎊 Aniversário de empresa ${quando}!` : '🎊 Aniversário de empresa!',
        description: `${ec.antecedencia ? `Completa tempo de casa ${quando}` : 'Hoje comemoramos o tempo de casa de'}:\n\n${nomes}\n\nObrigado por fazer parte da nossa história! 💜`,
        color: COR.roxo || COR.laranja,
        footer: { text: 'Kronos — Aniversário de empresa' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'aniversario', `Aniversário de empresa ${quando} (${lista.length})`, ok, ok ? null : 'Falha no envio');
    }
  } catch (e) {
    console.error('[DiscordScheduler/empresa]', e.message);
  }
}

// ── DAY OFF de aniversário (regra do RH portada do frontend) ──────────────
const FERIADOS_NACIONAIS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
const mmdd = d => `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const ymdD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function ehFeriado(d, fer) { return fer.recorrentes.has(mmdd(d)) || fer.fixas.has(ymdD(d)); }
function recuaDia(d, fer) { let t = 0; while ((d.getDay() === 0 || ehFeriado(d, fer)) && t < 60) { d.setDate(d.getDate() - 1); t++; } return d; }
function avancaDia(d, fer) { let t = 0; while ((d.getDay() === 0 || ehFeriado(d, fer)) && t < 60) { d.setDate(d.getDate() + 1); t++; } return d; }
function calcDayOffBk(nascStr, ano, fer, feriasUsuario) {
  const nasc = new Date(String(nascStr).slice(0, 10) + 'T12:00');
  const aniv = new Date(ano, nasc.getMonth(), nasc.getDate(), 12, 0, 0);
  if (feriasUsuario && feriasUsuario.length) {
    const anivYmd = ymdD(aniv);
    const periodo = feriasUsuario.find(p => p.ini <= anivYmd && anivYmd <= p.fim);
    if (periodo) { const ret = new Date(periodo.fim + 'T12:00'); ret.setDate(ret.getDate() + 1); return avancaDia(ret, fer); }
  }
  return recuaDia(aniv, fer);
}

async function enviarDayOffDoDia() {
  try {
    await garantirTabela();
    await run(`ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ultimo_dayoff_env TEXT`);
    const hojeStr = hojeSP();

    const empresas = await all(
      `SELECT * FROM integracao_discord
       WHERE ativo = 1 AND ev_dayoff = 1 AND webhook_url IS NOT NULL
       AND (ultimo_dayoff_env IS DISTINCT FROM $1)`,
      [hojeStr]
    );

    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'dayoff', cfg.hora_dayoff ?? cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue;
      if (horaSP() < ec.hora) continue;
      await run('UPDATE integracao_discord SET ultimo_dayoff_env = $1 WHERE empresa_id = $2', [hojeStr, cfg.empresa_id]);
      const alvoDayoff = dataAlvo(hojeStr, ec.antecedencia).ymd;

      // Feriados da empresa (+ nacionais fixos)
      const fer = { recorrentes: new Set(FERIADOS_NACIONAIS), fixas: new Set() };
      try {
        const fs = await all('SELECT data, recorrente, validacao, ativo FROM feriados WHERE empresa_id = $1', [cfg.empresa_id]);
        for (const f of fs) {
          if (f.validacao === 'rejeitado' || f.ativo === 0 || f.ativo === false) continue;
          const data = String(f.data || '').slice(0, 10); if (data.length < 10) continue;
          if (f.recorrente) fer.recorrentes.add(data.slice(5)); else fer.fixas.add(data);
        }
      } catch {}

      // Férias válidas
      const feriasMap = {};
      try {
        const fv = await all("SELECT usuario_id, status, data_inicio, data_fim FROM ferias WHERE empresa_id = $1", [cfg.empresa_id]);
        for (const f of fv) {
          if (!['aprovado', 'em_andamento', 'concluido'].includes(f.status)) continue;
          const ini = String(f.data_inicio || '').slice(0, 10), fim = String(f.data_fim || '').slice(0, 10);
          if (ini.length < 10 || fim.length < 10) continue;
          (feriasMap[f.usuario_id] = feriasMap[f.usuario_id] || []).push({ ini, fim });
        }
      } catch {}

      const colabs = await all(
        `SELECT id, nome, data_nascimento FROM usuarios
         WHERE empresa_id = $1 AND ativo = 1 AND data_nascimento IS NOT NULL
         AND (COALESCE(tipo_usuario,'colaborador')='colaborador' OR COALESCE(mostrar_aniversario,0)=1)`,
        [cfg.empresa_id]
      );

      const ano = new Date(alvoDayoff + 'T12:00').getFullYear();
      const doDia = [];
      for (const c of colabs) {
        const doff = calcDayOffBk(c.data_nascimento, ano, fer, feriasMap[c.id]);
        if (ymdD(doff) !== alvoDayoff) continue;
        // Se o aniversário cai no mesmo dia do day off, o disparo de aniversário já cobre → não duplica
        const nasc = new Date(String(c.data_nascimento).slice(0, 10) + 'T12:00');
        if (mmdd(nasc) === mmdd(new Date(alvoDayoff + 'T12:00'))) continue;
        doDia.push(c.nome);
      }
      if (!doDia.length) continue;

      const url = await resolverWebhook(cfg.empresa_id, cfg, 'dayoff');
      if (!url) continue;
      const quando = rotuloAntecedencia(ec.antecedencia);
      const nomes = doDia.map(n => `☀️ **${n}**`).join('\n');
      const ok = await postWebhook(url, {
        title: ec.antecedencia ? `☀️ Day off de aniversário ${quando}!` : '☀️ Day off de aniversário hoje!',
        description: `${ec.antecedencia ? `Day off ${quando} de` : 'Aproveite a folga! Hoje é o day off de'}:\n\n${nomes}`,
        color: COR.laranja,
        footer: { text: 'Kronos — Day off de aniversário' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'aniversario', `Day off de aniversário (${doDia.length})`, ok, ok ? null : 'Falha no envio');
    }
  } catch (e) {
    console.error('[DiscordScheduler/dayoff]', e.message);
  }
}

// Inicia verificação periódica (a cada 30 min). Em processo (PM2 mantém vivo).
function iniciar() {
  setTimeout(enviarAniversariantesDoDia, 20000); // 20s após subir
  setTimeout(enviarAniversarioEmpresaDoDia, 25000);
  setTimeout(enviarDayOffDoDia, 30000);
  setInterval(enviarAniversariantesDoDia, 30 * 60 * 1000);
  setInterval(enviarAniversarioEmpresaDoDia, 30 * 60 * 1000);
  setInterval(enviarDayOffDoDia, 30 * 60 * 1000);
}

module.exports = { iniciar, enviarAniversariantesDoDia, enviarAniversarioEmpresaDoDia, enviarDayOffDoDia };
