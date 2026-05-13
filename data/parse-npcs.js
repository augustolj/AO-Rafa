const fs = require('fs');
const html = fs.readFileSync('C:\\Users\\rafae\\Projects\\AO\\data\\wiki-npcs.html', 'utf8');

// Split by NPC rows - each starts with <p class="font-medium text-white">
const parts = html.split(/<p class="font-medium text-white">/);
parts.shift(); // discard before first match

const npcs = [];
for (const part of parts) {
  const nameM = part.match(/^(.+?)<\/p>/);
  if (!nameM) continue;
  const name = nameM[1].trim();
  
  // After </p></div>, we have 4 <span> for HP, EXP, Gold, then 2 longer spans for Maps and Drops
  const afterName = part.substring(nameM[0].length);
  const spans = [...afterName.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  
  if (spans.length < 4) continue;
  
  const hp = parseInt(spans[0]) || 0;
  const exp = parseInt(spans[1]) || 0;
  const gold = parseInt(spans[2]) || 0;
  const mapsText = spans[3] || '';
  const dropsText = spans[4] || '';
  
  const maps = [...mapsText.matchAll(/Mapa:\s*(\d+)/g)].map(x => +x[1]);
  const drops = dropsText === '-' ? [] : dropsText.split('|').map(s => s.trim()).filter(Boolean);
  
  npcs.push({ name, hp, exp, gold, maps, drops });
}

console.log(`Parsed ${npcs.length} NPCs`);
console.log(`Sample: ${JSON.stringify(npcs.find(n => n.name === 'Lobo'))}`);
console.log(`Sample: ${JSON.stringify(npcs.find(n => n.name === 'Medusa'))}`);
fs.writeFileSync('C:\\Users\\rafae\\Projects\\AO\\data\\wiki-npcs.json', JSON.stringify(npcs, null, 2));
