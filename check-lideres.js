require('dotenv').config();
const { all, pool } = require('./src/config/database');

async function main() {
  const empresa = (await all(`SELECT id, nome FROM empresas WHERE nome ILIKE '%LC Virtual Net%'`))[0];
  const deptos = await all(`SELECT id, nome FROM departamentos WHERE empresa_id=$1 ORDER BY nome`, [empresa.id]);
  console.log('Departamentos:');
  deptos.forEach(d => console.log(`- ${d.nome} (id=${d.id})`));

  const usuarios = await all(
    `SELECT u.id, u.nome, u.funcao, u.perfil, d.nome AS departamento
     FROM usuarios u LEFT JOIN departamentos d ON d.id = u.departamento_id
     WHERE u.empresa_id=$1 AND u.ativo=1
     ORDER BY d.nome, u.nome`,
    [empresa.id]
  );
  console.log('\nUsuários com perfil líder ou gestor (candidatos naturais à trilha de Liderança):');
  usuarios.filter(u => ['lider', 'gestor', 'admin'].includes((u.perfil || '').toLowerCase()))
    .forEach(u => console.log(`- ${u.nome} — ${u.funcao || '(sem função)'} — perfil: ${u.perfil} — depto: ${u.departamento || '(sem depto)'}`));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
