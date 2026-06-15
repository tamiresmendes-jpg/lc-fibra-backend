const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const db = new DatabaseSync(path.join(__dirname, 'data/gestao.db'));
const r = db.prepare("UPDATE pops SET tipo_pop='pop' WHERE tipo_pop IN ('hierarquia','hierarquico','fluxograma','sipoc','checklist','padrao')").run();
console.log('POPs antigos migrados para tipo_pop=pop:', r.changes);
db.close();
