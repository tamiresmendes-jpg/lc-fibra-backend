// Envio automático semanal do Relatório de Satisfação (Meta) no Discord,
// cada departamento no seu canal. Usa a fonte OFICIAL do painel Chatmix.
const { all, get, run } = require('../config/database');
const { getConfig, resolverWebhook, postWebhook, postWebhookImagem, registrarEnvio, COR } = require('../utils/discord');
const { gerarImagemMetaPng } = require('../utils/gerarImagemMeta');

function agoraSP() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour12: false });
  return new Date(s);
}
function horaSP() {
  // % 24: à meia-noite o Node retorna "24" em vez de "00", o que furava o portão do agendado.
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10) % 24;
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

// Fallback em texto (embed) caso a geração da imagem falhe.
function embedTexto(deptLabel, dados, di, df) {
  const linhas = (dados.itens || []).map(m =>
    `${m.bonificacao ? '⭐ ' : ''}**${m.atendente}** — 😊 ${m.satisfeitas} · 😞 ${m.insatisfeitas} · ⚪ ${m.invalidas} · satisfação ${m.perc_satisfacao != null ? m.perc_satisfacao.toFixed(1) : '—'}% · taxa ${m.taxa_resposta.toFixed(1)}%`
  ).join('\n');
  const rz = dados.resumo || {};
  return {
    title: `📊 Relatório de Satisfação — ${deptLabel}`,
    description: `Semana ${br(di)} a ${br(df)}\n\n${linhas || '_Sem dados no período._'}\n\n**Geral:** satisfação ${rz.media_satisfacao != null ? rz.media_satisfacao.toFixed(1) : '—'}% · taxa ${rz.media_taxa_resposta != null ? rz.media_taxa_resposta.toFixed(1) : '—'}% · atingiram ambas ${rz.atingiram_ambas}/${rz.atendentes_avaliados}`,
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
      // Usa a MESMA lógica do relatório da tela (fonte única) — require lazy p/ evitar ciclo.
      const { calcularMeta } = require('../routes/chatmix');

      const grupos = [
        { label: 'Financeiro', ev: 'meta_fin', deps: ['Financeiro'] },
        { label: 'Call Center', ev: 'meta_cc', deps: ['Suporte'] },
      ];
      for (const g of grupos) {
        const dados = await calcularMeta(empresa_id, di, df, 90, 55, { deps: g.deps });
        if (!dados.itens.length) continue;
        const url = await resolverWebhook(empresa_id, cfg, g.ev);
        if (!url) continue;
        let ok = false;
        try {
          const png = await gerarImagemMetaPng(g.label, di, df, dados.itens, dados.resumo, dados.metas);
          const legenda = `📊 **Relatório de Satisfação — ${g.label}**  ·  ${br(di)} a ${br(df)}`;
          ok = await postWebhookImagem(url, png, `meta-${g.ev}-${df}.png`, legenda);
        } catch (e) {
          console.error('[metaSemanal] imagem falhou, enviando texto:', e.message);
          ok = await postWebhook(url, embedTexto(g.label, dados, di, df));
        }
        registrarEnvio(empresa_id, 'meta', `Meta ${g.label} (${br(di)}-${br(df)})`, ok, ok ? null : 'Falha no envio');
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
