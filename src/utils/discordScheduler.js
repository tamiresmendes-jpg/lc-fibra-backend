const { run, all } = require('../config/database');
const { postWebhook, garantirTabela, COR } = require('./discord');

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

      const nomes = aniversariantes.map(a => `🎂 **${a.nome}**`).join('\n');
      await postWebhook(cfg.webhook_url, {
        title: '🎉 Aniversariantes de hoje!',
        description: `Hoje é dia de comemorar:\n\n${nomes}\n\nQue todos possam celebrar com muita alegria! 🥳`,
        color: COR.laranja,
        footer: { text: 'Kronos — Aniversariantes' },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('[DiscordScheduler]', e.message);
  }
}

// Inicia verificação periódica (a cada 30 min). Em processo (PM2 mantém vivo).
function iniciar() {
  setTimeout(enviarAniversariantesDoDia, 20000); // 20s após subir
  setInterval(enviarAniversariantesDoDia, 30 * 60 * 1000);
}

module.exports = { iniciar, enviarAniversariantesDoDia };
