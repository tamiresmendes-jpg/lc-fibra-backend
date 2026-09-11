require('dotenv').config();
const { all, pool } = require('./src/config/database');

async function main() {
  const empresa = (await all(`SELECT id, nome FROM empresas WHERE nome ILIKE '%LC Virtual Net%'`))[0];
  const pastas = await all(`SELECT id, nome, departamento_id FROM treinamento_trilhas_principais WHERE empresa_id=$1`, [empresa.id]);
  console.log('Pastas (Trilha Principal) da LC Virtual Net:');
  for (const p of pastas) {
    const colabs = await all(
      `SELECT DISTINCT u.nome FROM treinamentos t JOIN usuarios u ON u.id=t.colaborador_id
       WHERE t.trilha_principal_id=$1 AND t.eh_modelo=0 AND t.excluido_em IS NULL`,
      [p.id]
    );
    console.log(`- ${p.nome} (id=${p.id}) — colaboradores vinculados: ${colabs.map(c => c.nome).join(', ') || '(nenhum)'}`);
  }
  if (pastas.length === 0) console.log('(nenhuma pasta cadastrada)');
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
