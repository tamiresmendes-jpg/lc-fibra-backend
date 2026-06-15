/**
 * Configura gestor_id de todos os usuários conforme o organograma da empresa.
 * Execute: node scripts/configurar-hierarquia.js
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(path.join(__dirname, '../data/gestao.db'));

function buscarPorNome(nome) {
  const r = db.prepare("SELECT id, nome FROM usuarios WHERE nome LIKE ? LIMIT 1").get(`%${nome}%`);
  if (!r) console.warn(`  ⚠️  Não encontrado: "${nome}"`);
  return r;
}

function setGestor(nomeColaborador, nomeGestor) {
  const colab = buscarPorNome(nomeColaborador);
  const gestor = nomeGestor ? buscarPorNome(nomeGestor) : null;
  if (!colab) return;
  const gestorId = gestor ? gestor.id : null;
  db.prepare("UPDATE usuarios SET gestor_id = ? WHERE id = ?").run(gestorId, colab.id);
  console.log(`  ✅ ${colab.nome} → ${gestor ? gestor.nome : 'ROOT (sem gestor)'}`);
}

console.log('\n🔧 Configurando hierarquia...\n');

// ── RAIZ: Diretor sem gestor ──────────────────────────────
console.log('[ DIRETORIA ]');
setGestor('Nelson Rangel', null);

// ── SUPERVISÃO: reportam ao Nelson ───────────────────────
console.log('\n[ SUPERVISÃO → Nelson Rangel ]');
setGestor('Elielson Lopes',      'Nelson Rangel');
setGestor('Luana Crispim',       'Nelson Rangel');
setGestor('Maria Alrileia',      'Nelson Rangel');
setGestor('Paula Rhuanna',       'Nelson Rangel');

// ── SUPORTE TÉCNICO → Paula Rhuanna ──────────────────────
console.log('\n[ SUPORTE TÉCNICO → Paula Rhuanna ]');
const suporteTecnico = [
  'Allan da Silva Araujo',
  'Antonio Fagner Pinheiro Lisboa',
  'Antonio Fagner Prestes Andrade',
  'Cleiton Sousa da Silva',
  'Felipe Silva Mota',
  'Girlison Cruz Pinheiro',
  'Jackson Reis Barbosa',
  'Joao Paulo da Silva',
  'José Marcos Soares Menezes',
  'Jualeson Santana da Costa',
  'Luan Jeova da Silva Campelo',
  'Lucas Araujo Neves',
  'Lucas Eduardo Lemos da Silva',
  'Luiz Augusto da Conceição Hongo',
  'Madson Magalhães Castro',
  'Mauricio Mendonça Cardoso',
  'Maycon Felipe dos Santos Ferreira',
  'Merison Gomes Reis',
  'Rodrigo Campos dos Santos',
  'Rodrigo Dantas Barral',
  'Wanderson Gonçalves Galo',
  'Marcos Gabriel Pereira Cruz',
  'Mateus Alencar Batista',
];
suporteTecnico.forEach(n => setGestor(n, 'Paula Rhuanna'));

// ── NOC → Elielson Lopes ─────────────────────────────────
console.log('\n[ NOC → Elielson Lopes ]');
const noc = [
  'Mateus Pereira Ribeiro',
  'Paulo Henrique Silva de Oliveira',
  'Francisco Eduardo Lima Barbosa',
  'Thiago Augusto da Silva Costa',
  'Wisley Santana dos Santos',
];
noc.forEach(n => setGestor(n, 'Elielson Lopes'));

// ── CALL CENTER / HELP DESK → Maria Alrileia ─────────────
console.log('\n[ HELP DESK → Maria Alrileia ]');
const helpDesk = [
  'Ana Clara Melo de Menezes',
  'Ana Cleiza Dias Silva',
  'Ana Maiza Rodrigues de Sousa',
  'Kamila Vitoria Santos Gomes',
  'Laelen Mirian Lima dos Santos',
  'Maria Eduarda Reis Ramos',
  'Soffia de Jesus Pereira Silva',
];
helpDesk.forEach(n => setGestor(n, 'Maria Alrileia'));

// ── RECEPÇÃO → Luana Crispim ─────────────────────────────
console.log('\n[ RECEPÇÃO → Luana Crispim ]');
const recepcao = [
  'Ana Beatriz Oliveira Cardoso',
  'Ana Paula de Souza da Silva',
  'Anna Carla Silva Santana',
  'Evellem da Silva Santos',
  'Grasiele Sousa de Moura',
  'Kerolly Nayla Batista Almeida',
  'Kiara de Oliveira da Silva',
  'Mileny da Silva Cirilo',
  'Sara dos Santos Teles',
  'Talita Sousa Ferreira',
  'Vanessa Piedade da Silva',
];
recepcao.forEach(n => setGestor(n, 'Luana Crispim'));

// ── COBRANÇA / FINANCEIRO / ADMINISTRATIVO → Nelson ──────
console.log('\n[ COBRANÇA / FINANCEIRO / ADM / ALMOX / S.GERAIS → Nelson Rangel ]');
const nelsonDireto = [
  'Isabel Paixão Moreira',
  'Ronald Rego de Sousa',
  'Sander Murilo Lima Verde Alves',
  'Ana Carolina Pereira Andrade',
  'Rakezia Marinho da Costa',
  'Ruth da Silva Oliveira Carvalho',
  'Olinda Silva Costa Maia',
  'Tamires Mendes Silva',
  'Lucas Nunes dos Santos',
  'Ronaldo dos Santos Hortas',
  'Roliane Aires de Carvalho',
];
nelsonDireto.forEach(n => setGestor(n, 'Nelson Rangel'));

console.log('\n✅ Hierarquia configurada com sucesso!\n');
db.close();
