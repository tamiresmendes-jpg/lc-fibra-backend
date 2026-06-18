/**
 * Migra os dados do SQLite antigo (data/gestao.db) para o PostgreSQL do Railway.
 *
 * Uso:
 *   PG_URL="postgresql://...public..." node migrar-dados.js
 *
 * - Copia todas as tabelas que existem em ambos os bancos.
 * - Só copia colunas presentes nos dois schemas (à prova de diferenças).
 * - Limpa (TRUNCATE) cada tabela do PG antes de inserir, para não duplicar.
 */
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const PG_URL = process.env.PG_URL;
if (!PG_URL) {
  console.error('❌ Defina PG_URL com a connection string pública do Postgres do Railway.');
  process.exit(1);
}

const sqlite = new DatabaseSync('./data/gestao.db');
const pool = new Pool({ connectionString: PG_URL, ssl: { rejectUnauthorized: false } });

async function colunasPG(client, tabela) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
    [tabela]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

async function migrar() {
  const client = await pool.connect();
  try {
    // Tabelas do SQLite que têm pelo menos 1 linha
    const tabelas = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((t) => t.name);

    const resumo = [];

    for (const tabela of tabelas) {
      const linhas = sqlite.prepare(`SELECT * FROM ${tabela}`).all();
      if (linhas.length === 0) continue;

      const colsPG = await colunasPG(client, tabela);
      if (colsPG.size === 0) {
        console.log(`⏭️  Tabela "${tabela}" não existe no PostgreSQL — pulando.`);
        continue;
      }

      // Só colunas que existem nos dois lados
      const colsSQLite = Object.keys(linhas[0]);
      const cols = colsSQLite.filter((c) => colsPG.has(c));
      if (cols.length === 0) continue;

      // Limpa a tabela no PG
      await client.query(`TRUNCATE TABLE ${tabela} CASCADE`);

      // Insere linha a linha
      const colLista = cols.map((c) => `"${c}"`).join(', ');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      const sql = `INSERT INTO ${tabela} (${colLista}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      let inseridas = 0;
      for (const linha of linhas) {
        const valores = cols.map((c) => (linha[c] === undefined ? null : linha[c]));
        try {
          await client.query(sql, valores);
          inseridas++;
        } catch (e) {
          console.error(`   ⚠️  Erro em ${tabela} (id=${linha.id}): ${e.message}`);
        }
      }
      resumo.push({ tabela, total: linhas.length, inseridas });
      console.log(`✅ ${tabela}: ${inseridas}/${linhas.length}`);
    }

    console.log('\n========== RESUMO ==========');
    let totalGeral = 0;
    for (const r of resumo) {
      totalGeral += r.inseridas;
      console.log(`  ${r.tabela.padEnd(32)} ${r.inseridas}/${r.total}`);
    }
    console.log(`  ${'TOTAL'.padEnd(32)} ${totalGeral} registros migrados`);
    console.log('============================');
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

migrar().catch((e) => {
  console.error('❌ Falha na migração:', e);
  process.exit(1);
});
