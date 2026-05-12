const fs = require('fs');
const html = fs.readFileSync('C:\\Users\\rafae\\Projects\\AO\\data\\wiki-spells.html', 'utf8');

const parts = html.split(/<p class="font-medium text-white">/);
parts.shift();

const spells = [];
for (const part of parts) {
  const nameM = part.match(/^(.+?)<\/p>/);
  if (!nameM) continue;
  const name = nameM[1].trim();
  
  // Description is in the next <p>
  const descM = part.match(/<p class="mt-1[^"]*">(.+?)<\/p>/);
  const desc = descM ? descM[1].replace(/<[^>]+>/g, '').trim() : '';
  
  // Find the ID (it's in a <span> before the name div in the original row)
  // After </div>, spans: Skill, Mana, Poder(?), Palabras, Vende, Drop
  const afterDiv = part.substring(part.indexOf('</div>') + 6);
  const spans = [...afterDiv.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  
  if (spans.length < 3) continue;
  
  const skill = parseInt(spans[0]) || 0;
  const mana = parseInt(spans[1]) || 0;
  const words = spans[2] || '-';
  const vendor = spans[3] || '-';
  const drop = spans[4] || '-';
  
  spells.push({ name, desc: desc.substring(0, 100), skill, mana, words, vendor, drop });
}

console.log(`Parsed ${spells.length} spells`);
console.log(JSON.stringify(spells.slice(0, 5), null, 2));
fs.writeFileSync('C:\\Users\\rafae\\Projects\\AO\\data\\wiki-spells.json', JSON.stringify(spells, null, 2));
