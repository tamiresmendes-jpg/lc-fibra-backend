const { run, all } = require('../config/database');
const { postWebhook, garantirTabela, registrarEnvio, resolverWebhook, COR } = require('./discord');

// Data de hoje no fuso de São Paulo (YYYY-MM-DD)
function hojeSP() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
  return s;
}
function horaSP() {
  // % 24 corrige o quirk do Node: à meia-noite o toLocaleString retorna "24" (não "00"),
  // o que furava o portão dos agendados (24 >= qualquer hora) e disparava tudo às 00h.
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10) % 24;
}
// Minutos desde a meia-noite em Brasília — permite agendar com minutos (ex.: 08:30)
function minutosSP() {
  const m = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', minute: '2-digit' }), 10) || 0;
  return horaSP() * 60 + m;
}

// Nome canônico/limpo do setor (junta variações do RHID, ex.: "SUPORTE TÉCNICO FIBRA" → "Suporte")
function setorCanonico(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('suporte')) return 'Suporte';
  if (n.includes('financ')) return 'Financeiro';
  if (n.includes('comercial')) return 'Comercial';
  if (n.includes('noc')) return 'NOC';
  if (n.includes('recep')) return 'Recepção';
  if (n.includes('cobran') || n.includes('remo')) return 'Cobrança/Remoção';
  if (n.includes('agenda')) return 'Agendamento';
  if (n.includes('cancel')) return 'Cancelamentos';
  if (n.includes('contrat')) return 'Contratação';
  // fallback: primeira letra de cada palavra em maiúscula
  return (nome || 'Outros').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// Emoji por setor para o lembrete de pendências de ponto
function emojiSetor(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('suporte')) return '🛠️';
  if (n.includes('financ')) return '💰';
  if (n.includes('comercial')) return '📞';
  if (n.includes('noc')) return '🌐';
  if (n.includes('recep')) return '🎧';
  if (n.includes('cobran') || n.includes('remo')) return '💳';
  if (n.includes('agenda')) return '📅';
  if (n.includes('cancel')) return '❌';
  if (n.includes('contrat')) return '📝';
  return '📌';
}

// Config por evento definida pela usuária (JSON notif_cfg): { modo, antecedencia, hora, minuto }
// `minuto` é opcional (padrão 0), permitindo agendar em horários quebrados (ex.: 08:30).
function evCfg(cfg, ev, horaDefault) {
  let m = {}; try { m = cfg.notif_cfg ? JSON.parse(cfg.notif_cfg) : {}; } catch {}
  const c = m[ev] || {};
  const ant = Number.isFinite(+c.antecedencia) ? Math.max(0, +c.antecedencia) : 0;
  const hora = (c.hora !== undefined && c.hora !== null && c.hora !== '') ? +c.hora : horaDefault;
  const minuto = Number.isFinite(+c.minuto) ? Math.min(59, Math.max(0, +c.minuto)) : 0;
  return { modo: c.modo || 'agendado', antecedencia: ant, hora, minuto, emMinutos: (hora * 60) + minuto };
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
       WHERE ativo = 1 AND ev_aniversario = 1       AND (ultimo_aniv_env IS DISTINCT FROM $1)`,
      [hoje]
    );

    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'aniversario', cfg.hora_aniversario ?? cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue; // marcada como tempo real → não usa agendamento
      if (minutosSP() < ec.emMinutos) continue; // respeita hora:minuto configurados
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
       WHERE ativo = 1 AND ev_aniversario_empresa = 1       AND (ultimo_aniv_emp_env IS DISTINCT FROM $1)`,
      [hoje]
    );

    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'aniversario_empresa', cfg.hora_aniversario_empresa ?? cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue;
      if (minutosSP() < ec.emMinutos) continue;
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
       WHERE ativo = 1 AND ev_dayoff = 1       AND (ultimo_dayoff_env IS DISTINCT FROM $1)`,
      [hojeStr]
    );

    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'dayoff', cfg.hora_dayoff ?? cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue;
      if (minutosSP() < ec.emMinutos) continue;
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
        // Só evita duplicar quando os DOIS avisos sairiam no MESMO DIA (antecedência 0 e o
        // day off caindo no aniversário). Com antecedência (ex.: avisar 1 dia antes), o aviso
        // de day off sai num dia e o de aniversário no outro — são mensagens distintas.
        if (ec.antecedencia === 0) {
          const nasc = new Date(String(c.data_nascimento).slice(0, 10) + 'T12:00');
          if (mmdd(nasc) === mmdd(new Date(alvoDayoff + 'T12:00'))) continue;
        }
        doDia.push(c.nome);
      }
      if (!doDia.length) continue;

      const url = await resolverWebhook(cfg.empresa_id, cfg, 'dayoff');
      if (!url) continue;
      const quando = rotuloAntecedencia(ec.antecedencia);
      const nomes = doDia.map(n => `🌴 **${n}**, seu day off será ${quando} — aproveite sua folga! 🎉`).join('\n');
      const ok = await postWebhook(url, {
        title: `☀️ Day off de aniversário ${quando}!`,
        description: nomes,
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

// ── FERIADO ───────────────────────────────────────────────────────────────
const FER_NAC_NOMES = {
  '01-01': 'Confraternização Universal', '04-21': 'Tiradentes', '05-01': 'Dia do Trabalho',
  '09-07': 'Independência do Brasil', '10-12': 'Nossa Senhora Aparecida', '11-02': 'Finados',
  '11-15': 'Proclamação da República', '11-20': 'Consciência Negra', '12-25': 'Natal',
};
async function enviarFeriadoDoDia() {
  try {
    await garantirTabela();
    await run(`ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ultimo_feriado_env TEXT`);
    const hojeStr = hojeSP();
    const empresas = await all(
      `SELECT * FROM integracao_discord WHERE ativo = 1 AND ev_feriado = 1       AND (ultimo_feriado_env IS DISTINCT FROM $1)`, [hojeStr]);
    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'feriado', cfg.hora_disparo ?? 8);
      if (ec.modo === 'realtime') continue;
      if (minutosSP() < ec.emMinutos) continue;
      await run('UPDATE integracao_discord SET ultimo_feriado_env = $1 WHERE empresa_id = $2', [hojeStr, cfg.empresa_id]);
      const alvo = dataAlvo(hojeStr, ec.antecedencia);
      const alvoMMDD = `${String(alvo.mes).padStart(2,'0')}-${String(alvo.dia).padStart(2,'0')}`;
      // procura feriado cadastrado (empresa) na data-alvo
      let nome = null, tipo = null;
      try {
        const fs = await all('SELECT nome, tipo, data, recorrente, validacao, ativo FROM feriados WHERE empresa_id = $1', [cfg.empresa_id]);
        for (const f of fs) {
          if (f.validacao === 'rejeitado' || f.ativo === 0 || f.ativo === false) continue;
          const data = String(f.data || '').slice(0, 10); if (data.length < 10) continue;
          if (f.recorrente ? (data.slice(5) === alvoMMDD) : (data === alvo.ymd)) { nome = f.nome; tipo = f.tipo; break; }
        }
      } catch {}
      if (!nome && FER_NAC_NOMES[alvoMMDD]) { nome = FER_NAC_NOMES[alvoMMDD]; tipo = 'nacional'; }
      if (!nome) continue;
      const url = await resolverWebhook(cfg.empresa_id, cfg, 'feriado');
      if (!url) continue;
      const quando = rotuloAntecedencia(ec.antecedencia);
      const dataFmt = `${String(alvo.dia).padStart(2,'0')}/${String(alvo.mes).padStart(2,'0')}`;
      const ok = await postWebhook(url, {
        title: '🚩 Feriado',
        description: `${quando === 'hoje' ? 'Hoje' : `${quando.charAt(0).toUpperCase()+quando.slice(1)} (${dataFmt})`} é feriado: **${nome}**${tipo ? ` _(${tipo})_` : ''}.`,
        color: COR.laranja,
        footer: { text: 'Kronos — Feriados' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'feriado', `Feriado ${quando}: ${nome}`, ok, ok ? null : 'Falha no envio');
    }
  } catch (e) { console.error('[DiscordScheduler/feriado]', e.message); }
}

// ── RHID: resumo de faltas do dia anterior ─────────────────────────────────
async function enviarRhidResumoDoDia() {
  try {
    await garantirTabela();
    await run(`ALTER TABLE integracao_discord ADD COLUMN IF NOT EXISTS ultimo_rhid_env TEXT`);
    const hojeStr = hojeSP();
    const empresas = await all(
      `SELECT * FROM integracao_discord WHERE ativo = 1 AND ev_rhid = 1       AND (ultimo_rhid_env IS DISTINCT FROM $1)`, [hojeStr]);
    for (const cfg of empresas) {
      const ec = evCfg(cfg, 'rhid', cfg.hora_disparo ?? 8);
      // Faltas é um resumo diário (não há gatilho ao vivo). No modo "agendado" espera o horário;
      // no modo "tempo real" envia assim que o sync roda (sem esperar horário). Nunca fica sem enviar.
      if (ec.modo !== 'realtime' && minutosSP() < ec.emMinutos) continue;
      await run('UPDATE integracao_discord SET ultimo_rhid_env = $1 WHERE empresa_id = $2', [hojeStr, cfg.empresa_id]);
      // faltas do dia anterior
      const ontem = new Date(hojeStr + 'T12:00'); ontem.setDate(ontem.getDate() - 1);
      const ontemStr = ymdD(ontem);
      // Pendências agrupadas por SETOR (apenas quantidade, SEM nomes — respeita a LGPD).
      let setores = [];
      try {
        setores = await all(
          `SELECT COALESCE(NULLIF(TRIM(departamento), ''), 'Sem setor') AS setor, COUNT(*)::int AS n
           FROM rhid_ponto_dia p
           WHERE empresa_id = $1 AND data = $2 AND falta_dia = true AND ativo = true
             AND NOT EXISTS (SELECT 1 FROM rhid_ponto_excluir e WHERE e.empresa_id = p.empresa_id AND e.id_person = p.id_person)
           GROUP BY 1 ORDER BY n DESC, setor`,
          [cfg.empresa_id, ontemStr]);
      } catch { continue; }
      if (!setores.length) continue;
      const url = await resolverWebhook(cfg.empresa_id, cfg, 'rhid');
      if (!url) continue;
      const dataFmt = `${String(ontem.getDate()).padStart(2, '0')}/${String(ontem.getMonth() + 1).padStart(2, '0')}/${ontem.getFullYear()}`;
      // Só os SETORES com pendência (sem quantidade, sem nomes) — nomes canônicos e sem repetição.
      const setoresUnicos = [...new Set(setores.map(x => setorCanonico(x.setor)))].sort();
      const linhas = setoresUnicos.map(s => `${emojiSetor(s)} ${s}`).join('\n');
      const ok = await postWebhook(url, {
        title: `🔔 Lembrete de Pendências de Ponto – ${dataFmt}`,
        description: `Foram identificadas pendências de registro de ponto referentes ao dia anterior.\n\n**Setores com pendências:**\n${linhas}\n\nSolicitamos que os colaboradores desses setores acessem o sistema para verificar e, se necessário, regularizar suas marcações de ponto.`,
        color: COR.laranja,
        footer: { text: 'Kronos — Ponto (RHID)' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'rhid', `Pendências de ponto ${dataFmt}`, ok, ok ? null : 'Falha no envio');
    }
  } catch (e) { console.error('[DiscordScheduler/rhid]', e.message); }
}

// Inicia verificação periódica (a cada 30 min). Em processo (PM2 mantém vivo).
function iniciar() {
  setTimeout(enviarAniversariantesDoDia, 20000); // 20s após subir
  setTimeout(enviarAniversarioEmpresaDoDia, 25000);
  setTimeout(enviarDayOffDoDia, 30000);
  setTimeout(enviarFeriadoDoDia, 35000);
  setTimeout(enviarRhidResumoDoDia, 40000);
  setInterval(enviarAniversariantesDoDia, 10 * 60 * 1000);
  setInterval(enviarAniversarioEmpresaDoDia, 10 * 60 * 1000);
  setInterval(enviarDayOffDoDia, 10 * 60 * 1000);
  setInterval(enviarFeriadoDoDia, 10 * 60 * 1000);
  setInterval(enviarRhidResumoDoDia, 10 * 60 * 1000);
}

module.exports = { iniciar, enviarAniversariantesDoDia, enviarAniversarioEmpresaDoDia, enviarDayOffDoDia, enviarFeriadoDoDia, enviarRhidResumoDoDia };
