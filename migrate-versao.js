const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'data/gestao.db'));

const migs = [
  "ALTER TABLE pops ADD COLUMN data_ativacao TEXT",
  "ALTER TABLE pop_historico ADD COLUMN tipo_alteracao TEXT DEFAULT 'criacao'",
];

for (const sql of migs) {
  try { db.exec(sql); console.log('OK:', sql.substring(0, 60)); }
  catch (e) { console.log('Já existe ou erro:', e.message.substring(0, 80)); }
}

db.close();
console.log('Concluído.');
