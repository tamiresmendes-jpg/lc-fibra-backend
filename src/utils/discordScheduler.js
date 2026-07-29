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

async function enviarAniversariantesDoDia() {
  try {
    await garantirTabela();
    const hoje = hojeSP();
    if (horaSP() < 8) return; // só a partir das 8h

    const empresas = await all(
      `SELECT * FROM integracao_discord
       WHERE ativo = 1 AND ev_aniversario = 1 AND webhook_url IS NOT NULL
       AND (ultimo_aniv_env IS DISTINCT FROM $1)`,
      [hoje]
    );

    for (const cfg of empresas) {
      // Marca já como enviado (evita duplicar se demorar)
      await run('UPDATE integracao_discord SET ultimo_aniv_env = $1 WHERE empresa_id = $2', [hoje, cfg.empresa_id]);

      const aniversariantes = await all(
        `SELECT nome FROM usuarios
         WHERE empresa_id = $1 AND ativo = 1 AND data_nascimento IS NOT NULL
         AND (COALESCE(tipo_usuario,'colaborador')='colaborador' OR COALESCE(mostrar_aniversario,0)=1)
         AND EXTRACT(MONTH FROM data_nascimento::date) = EXTRACT(MONTH FROM (NOW() - INTERVAL '3 hours'))
         AND EXTRACT(DAY   FROM data_nascimento::date) = EXTRACT(DAY   FROM (NOW() - INTERVAL '3 hours'))
         ORDER BY nome`,
        [cfg.empresa_id]
      );

      if (!aniversariantes.length) continue;

      // Usa o canal configurado para o evento de aniversário (não o webhook antigo)
      const url = await resolverWebhook(cfg.empresa_id, cfg, 'aniversario');
      if (!url) continue;
      const nomes = aniversariantes.map(a => `🎂 **${a.nome}**`).join('\n');
      const ok = await postWebhook(url, {
        title: '🎉 Aniversariantes de hoje!',
        description: `Hoje é dia de comemorar:\n\n${nomes}\n\nQue todos possam celebrar com muita alegria! 🥳`,
        color: COR.laranja,
        footer: { text: 'Kronos — Aniversariantes' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'aniversario', `Aniversariantes de hoje (${aniversariantes.length})`, ok, ok ? null : 'Falha no envio');
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
    if (horaSP() < 8) return; // só a partir das 8h

    const empresas = await all(
      `SELECT * FROM integracao_discord
       WHERE ativo = 1 AND ev_aniversario = 1 AND webhook_url IS NOT NULL
       AND (ultimo_aniv_emp_env IS DISTINCT FROM $1)`,
      [hoje]
    );

    for (const cfg of empresas) {
      await run('UPDATE integracao_discord SET ultimo_aniv_emp_env = $1 WHERE empresa_id = $2', [hoje, cfg.empresa_id]);

      const lista = await all(
        `SELECT nome,
                (EXTRACT(YEAR FROM (NOW() - INTERVAL '3 hours')) - EXTRACT(YEAR FROM data_admissao::date))::int AS anos
         FROM usuarios
         WHERE empresa_id = $1 AND ativo = 1 AND data_admissao IS NOT NULL
         AND EXTRACT(MONTH FROM data_admissao::date) = EXTRACT(MONTH FROM (NOW() - INTERVAL '3 hours'))
         AND EXTRACT(DAY   FROM data_admissao::date) = EXTRACT(DAY   FROM (NOW() - INTERVAL '3 hours'))
         AND EXTRACT(YEAR FROM data_admissao::date) < EXTRACT(YEAR FROM (NOW() - INTERVAL '3 hours'))
         ORDER BY nome`,
        [cfg.empresa_id]
      );
      if (!lista.length) continue;

      const url = await resolverWebhook(cfg.empresa_id, cfg, 'aniversario');
      if (!url) continue;
      const nomes = lista.map(a => `🏢 **${a.nome}** — ${a.anos} ano${a.anos !== 1 ? 's' : ''} de casa`).join('\n');
      const ok = await postWebhook(url, {
        title: '🎊 Aniversário de empresa!',
        description: `Hoje comemoramos o tempo de casa de:\n\n${nomes}\n\nObrigado por fazer parte da nossa história! 💜`,
        color: COR.roxo || COR.laranja,
        footer: { text: 'Kronos — Aniversário de empresa' },
        timestamp: new Date().toISOString(),
      });
      registrarEnvio(cfg.empresa_id, 'aniversario', `Aniversário de empresa (${lista.length})`, ok, ok ? null : 'Falha no envio');
    }
  } catch (e) {
    console.error('[DiscordScheduler/empresa]', e.message);
  }
}

// Inicia verificação periódica (a cada 30 min). Em processo (PM2 mantém vivo).
function iniciar() {
  setTimeout(enviarAniversariantesDoDia, 20000); // 20s após subir
  setTimeout(enviarAniversarioEmpresaDoDia, 25000);
  setInterval(enviarAniversariantesDoDia, 30 * 60 * 1000);
  setInterval(enviarAniversarioEmpresaDoDia, 30 * 60 * 1000);
}

module.exports = { iniciar, enviarAniversariantesDoDia, enviarAniversarioEmpresaDoDia };
