// Envio automático semanal do Relatório de Satisfação (Meta) no Discord,
// cada departamento no seu canal. Usa a fonte OFICIAL do painel Chatmix.
const { all, get, run } = require('../config/database');
const { getConfig, resolverWebhook, postWebhook, registrarEnvio, COR } = require('../utils/discord');

function agoraSP() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour12: false });
  return new Date(s);
}
function horaSP() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
}
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function br(iso) { return iso.split('-').reverse().join('/'); }

// Semana ATUAL acumulada (domingo passado → hoje) — para acompanhamento diário
function semanaAtualAcum() {
  const h = agoraSP();
  const dom = new Date(h); dom.setDate(h.getDate() - h.getDay());
  return { di: ymd(dom), df: ymd(h) };
}

function deptDeNome(nome) {
  const n = (nome || '').toLowerCase();
  if (n.includes('financeiro')) return 'Financeiro';
  if (n.includes('suporte')) return 'Suporte';
  return 'Outros';
}

async function satisfacaoOficial(empresaId, di, df) {
  const cfg = await get('SELECT painel_token, survey_id FROM integracao_chatmix WHERE empresa_id=$1', [empresaId]);
  if (!cfg?.painel_token || !cfg?.survey_id) return null;
  const url = `https://srv6.chatmix.com.br/api_v2/api/v1/reports/replySatisfactionSurvey/attendants?satisfaction=${cfg.survey_id}&datestart=${di}%2000:00:00&dateend=${df}%2023:59:59`;
  const r = await fetch(url, { headers: { Accept: 'application/json', Authorization: 'Bearer ' + cfg.painel_token, 'User-Agent': 'Mozilla/5.0' } });
  if (r.status !== 200) return null;
  const j = await r.json().catch(() => null);
  return (j?.data?.first || []).map(a => ({
    nome: ((a.user_all?.first_name || '') + ' ' + (a.user_all?.last_name || '')).trim(),
    sat: a.reply_5 || 0, insat: a.reply_1 || 0, inval: a.reply_0 || 0, total: a.total || 0, media: a.average,
  }));
}

function montarEmbed(deptLabel, lista, di, df, metas) {
  const linhas = lista.map(a => {
    const validas = a.sat + a.insat;
    const pct = validas ? Math.round((a.sat / validas) * 1000) / 10 : 0;
    return `**${a.nome}** — 😊 ${a.sat} · 😞 ${a.insat} · ⚪ ${a.inval} · satisfação ${pct}% (média ${a.media})`;
  }).join('\n');
  const tSat = lista.reduce((s, a) => s + a.sat, 0);
  const tIns = lista.reduce((s, a) => s + a.insat, 0);
  const tVal = tSat + tIns;
  const pctGeral = tVal ? Math.round((tSat / tVal) * 1000) / 10 : 0;
  return {
    title: `📊 Relatório de Satisfação — ${deptLabel}`,
    description: `Semana ${br(di)} a ${br(df)}\n\n${linhas || '_Sem dados no período._'}\n\n**Geral:** 😊 ${tSat} · 😞 ${tIns} · satisfação ${pctGeral}%`,
    color: COR.roxo || COR.azul,
    footer: { text: 'Kronos — Meta de Satisfação (semanal)' },
    timestamp: new Date().toISOString(),
  };
}

async function enviarMetaSemanal() {
  try {
    const { di, df } = semanaAtualAcum();
    const chave = df; // dedup por dia (envia uma vez ao dia)

    const empresas = await all(
      `SELECT empresa_id, notif_cfg FROM integracao_discord
       WHERE ativo = 1 AND ev_meta = 1 AND meta_auto = 1
       AND (ultimo_meta_env IS DISTINCT FROM $1)`, [chave]);

    for (const emp of empresas) {
      const empresa_id = emp.empresa_id;
      // Respeita a config do evento "meta": agendado espera a hora; tempo real envia no ciclo.
      let ncfg = {}; try { ncfg = emp.notif_cfg ? JSON.parse(emp.notif_cfg) : {}; } catch { /* */ }
      const mc = ncfg.meta || {};
      const modo = mc.modo || 'agendado';
      const hora = (mc.hora !== undefined && mc.hora !== null && mc.hora !== '') ? +mc.hora : 8;
      if (modo !== 'realtime' && horaSP() < hora) continue;
      await run('UPDATE integracao_discord SET ultimo_meta_env = $1 WHERE empresa_id = $2', [chave, empresa_id]);
      const cfg = await getConfig(empresa_id);
      const oficial = await satisfacaoOficial(empresa_id, di, df);
      if (!oficial) { console.warn(`[metaSemanal] ${empresa_id}: sem token/dados oficiais`); continue; }

      const grupos = [
        { label: 'Financeiro', ev: 'meta_fin', lista: oficial.filter(a => deptDeNome(a.nome) === 'Financeiro') },
        { label: 'Call Center', ev: 'meta_cc', lista: oficial.filter(a => deptDeNome(a.nome) === 'Suporte') },
      ];
      for (const g of grupos) {
        if (!g.lista.length) continue;
        const url = await resolverWebhook(empresa_id, cfg, g.ev);
        if (!url) continue;
        const ok = await postWebhook(url, montarEmbed(g.label, g.lista.sort((a, b) => b.sat - a.sat), di, df));
        registrarEnvio(empresa_id, 'meta', `Meta semanal ${g.label} (${br(di)}-${br(df)})`, ok, ok ? null : 'Falha no envio');
      }
    }
  } catch (e) { console.error('[metaSemanal]', e.message); }
}

function iniciar() {
  setTimeout(enviarMetaSemanal, 45 * 1000);
  setInterval(enviarMetaSemanal, 10 * 60 * 1000);
  console.log('[metaSemanal] iniciado (segunda 8h, por departamento)');
}

module.exports = { iniciar, enviarMetaSemanal };
