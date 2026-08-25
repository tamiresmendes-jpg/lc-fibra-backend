// Vincula meta_comercial_vendedor.usuario_id casando por e-mail (hubsoft_email x
// usuarios.email) pra todo vendedor que ainda não tem cadastro vinculado. É o
// mesmo vínculo que a tela sugere um por um em "detectados sem config" — aqui só
// automatiza pros que JÁ têm registro na Meta Comercial mas sem usuario_id.
//
// Por padrão roda em modo DRY-RUN (só mostra o que faria). Pra gravar de verdade:
//   node scripts/vincular-vendedores-usuario.js --aplicar
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const { rows: semVinculo } = await pool.query(`
    SELECT id, empresa_id, nome, hubsoft_email
    FROM meta_comercial_vendedor
    WHERE usuario_id IS NULL AND hubsoft_email IS NOT NULL AND ativo = true
  `);

  if (!semVinculo.length) {
    console.log('Nenhum vendedor sem vínculo encontrado.');
    return;
  }

  let vinculados = 0;
  const semUsuario = [];

  for (const v of semVinculo) {
    const { rows: usuarios } = await pool.query(
      `SELECT id, nome FROM usuarios WHERE empresa_id = $1 AND ativo = 1 AND LOWER(email) = LOWER($2)`,
      [v.empresa_id, v.hubsoft_email]
    );
    if (usuarios.length !== 1) {
      semUsuario.push({ ...v, motivo: usuarios.length === 0 ? 'nenhum usuário com esse e-mail' : 'mais de um usuário com esse e-mail' });
      continue;
    }
    const usuario = usuarios[0];
    console.log(`${APLICAR ? 'VINCULANDO' : '[dry-run]'} ${v.nome} (${v.hubsoft_email}) -> usuário "${usuario.nome}" (${usuario.id})`);
    if (APLICAR) {
      await pool.query(`UPDATE meta_comercial_vendedor SET usuario_id = $1 WHERE id = $2`, [usuario.id, v.id]);
    }
    vinculados++;
  }

  console.log(`\n${vinculados} vendedor(es) ${APLICAR ? 'vinculado(s)' : 'seriam vinculado(s)'}.`);
  if (semUsuario.length) {
    console.log(`\n${semUsuario.length} sem vínculo possível:`);
    for (const s of semUsuario) console.log(`  - ${s.nome} (${s.hubsoft_email}): ${s.motivo}`);
  }
  if (!APLICAR && vinculados) console.log('\nRode de novo com --aplicar para gravar.');
}

main().then(() => pool.end()).catch(e => { console.error(e); pool.end(); process.exit(1); });
