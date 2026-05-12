# AOWeb HUD — Manual del proyecto

> Userscript Tampermonkey para el cliente web de **Argentum Online** ([aoweb.app](https://aoweb.app)) por Damián Catanzaro. Inyecta un overlay con **bestiario de 131 criaturas** (datos del servidor), **panel unificado**, **target frame**, **macros** (auto-desparalizar, auto-ataque), **buff icons sobre PJ**, y **sistema genérico de aprendizaje de estados**.

**Estado actual:** v1.5 — funcional en producción (~1880 líneas).

---

## TL;DR — cómo correrlo

1. Tampermonkey instalado en Chrome/Firefox.
2. Pegar `src/aoweb-hud.user.js` en un nuevo userscript.
3. Recargar `aoweb.app/play`.
4. Activar pantalla completa con el botón del juego (no F11).
5. Jugar normal — el HUD aprende solo.

**Persistencia:** `localStorage`, cuatro claves:
- `aoweb-hud-durations` — duraciones de hechizos aprendidas
- `aoweb-hud-mobs` — stats acumulados de daño que pega cada mob
- `aoweb-hud-states` — estados descubiertos y sus duraciones reales
- `aoweb-hud-macros` — configuración de macros (teclas, intervalos)
- `aoweb-hud-wiki` — cache de datos de la wiki (NPCs, hechizos, mapas) con TTL 24h
- `aoweb-hud-sessions` — historial de sesiones anteriores (últimas 20)

**No build step. No npm install. Vanilla JS.**

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Userscript (Tampermonkey) corriendo en page context |
| Lenguaje | Vanilla JS (ES2020+) |
| UI | DOM puro inyectado con `document.createElement` + `<style>` inline |
| Tipografías | Google Fonts: `Cinzel`, `Press Start 2P`, `IM Fell English` (inyectadas vía `<link>` en `<head>`) |
| Persistencia | `localStorage` |
| Captura de eventos | `MutationObserver` sobre la consola del juego, `MutationObserver` global pasivo para autodetect, lectura periódica del DOM (1s polling para timers de buffs) |
| Wiki live data | `fetch()` a `aoweb.app/wiki/npcs` y `/wiki/spells` al iniciar, parse HTML SSR, cache en localStorage 24h |
| Hook de WebSocket | Override de `window.WebSocket` que captura tráfico IN/OUT para debug (no se parsea — protocolo binario propietario) |
| Hook de Fullscreen API | Monkey-patch de `HTMLElement.prototype.requestFullscreen` para redirigir el fullscreen del canvas al `documentElement` |

---

## El juego — lo que sabemos

- **aoweb.app** es la versión web actual del Argentum Online de **Damián Catanzaro** (el de los 2000s, ahora rehecho).
- Cliente **PixiJS**, encapsulado — **NO expone motor ni state en `window`**. Verificado: `window.PIXI`, `window.game`, etc. no existen.
- **WebSocket binario propietario** — los paquetes no son JSON. Reversar el protocolo es un proyecto separado de días/semanas. Lo capturamos solo para debug.
- **Repo de GitHub (`dcatanzaro/argentumonlineweb-cliente`)** es de 2015, versión vieja, **NO es el cliente actual**. No sirve para leer código.
- Sí tenemos: la **consola del juego en el DOM**. Mensajes en texto plano. Esa es nuestra mina de oro.
- **El panel derecho del juego** también es DOM — muestra HP/MP/Buffs activos del PJ con timer real (`(53s)`). Podemos leerlo.

---

## Arquitectura del HUD

```
┌─── HUD overlay (todos los elementos en position:fixed) ───┐
│                                                            │
│  ┌─── Panel Unificado ──┐    ┌── Game canvas (Pixi) ──┐   │
│  │ [Avatar] Roda  K·XP·G│    │                         │   │
│  │ Tabs: Manual|Sesión  │    │     💪 🐇 (buffs)       │   │
│  │ [🔍 Buscar criatura] │    │         🧑 Roda         │   │
│  │ ┌── Target Card ──┐  │    │                         │   │
│  │ │ Avatar + HP     │  │    │     (juego corre acá)   │   │
│  │ │ Estados activos │  │    │                         │   │
│  │ │ Wiki: XP/drops  │  │    │                         │   │
│  │ └─────────────────┘  │    └─────────────────────────┘   │
│  │ Estados Activos (all)│                                  │
│  │ Combatidos (apren.)  │    ┌── Macros ──┐                │
│  │ Bestiary (wiki live) │    │ [⏱ DESPAR] │                │
│  └──────────────────────┘    │ [⚔ ATK]    │                │
│                              └────────────┘                │
│           ┌── Toasts (top center) ──┐                      │
│           │ "Wiki sincronizada"     │                      │
│           └─────────────────────────┘                      │
└────────────────────────────────────────────────────────────┘
```

### Componentes (`#aohud-*`)

| ID | Función | Posición |
|---|---|---|
| `#aohud-panel` | Panel unificado: player header + tabs + target + bestiary + estados | top-left, fixed |
| `#aohud-self-buffs` | Iconos translúcidos (💪🐇) sobre Roda | centro canvas, calculado |
| `#aohud-toasts` | Notificaciones de descubrimiento/aprendizaje/wiki sync | top-center, fixed |
| `#aohud-macros` | Botones toggle: auto-desparalizar + auto-ataque | bottom-left, fixed |

### Estado en memoria (módulo IIFE)

```js
entities          // Map<name, { kind, hp, maxHp, lastSeen, count, states, stateTimers }>
activeBuffs       // Map<spell, { castAt, duration, realRemain? }>  // sobre el PJ
mobStats          // Map<name, { hitsReceived: [...] }>             // daño recibido por mob
currentTarget     // { name, kind, hp, maxHp } o null
session           // { startedAt, kills, totalXP, totalGold, killsByMob, damageReceived, damageDealt }
learnedDurations  // {} en memoria + localStorage
learnedMobStats   // {} en memoria + localStorage
learnedStates     // { [state]: { firstSeenAt, sightings, knownDuration } } + localStorage
BESTIARY_DB       // {} NPC data from wiki (name → { hp, exp, gold, maps, drops })
SPELLS_DB         // {} spell data from wiki (name → { desc, skill, mana })
macroConfig       // {} macro settings + localStorage
```

---

## Patrones de mensajes del juego (CONFIRMADOS)

Todos vienen como text nodes en la consola del juego. Los capturamos con `MutationObserver` y los parseamos con regex.

### NPCs
```
Ves a Gran Águila [NPC] [Vida: 40/40]
Ves a Gran Águila [NPC] [Vida: 40/40] [Paralizado]   ← con estado activo
Ves a Gran Águila [NPC] [Vida: 40/40] [Paralizado] [Envenenado]  ← múltiples estados (no confirmado pero asumido)
```

Regex actual:
```js
const NPC_RX = /^Ves a (.+?) \[([^\]]+)\] \[Vida:\s*(\d+)\/(\d+)\]\s*(.*)$/;
```
El último grupo captura todo el sufijo de estados, que después se parsea con `parseStates()`.

### PJs
```
Ves a Roda - Clérigo, nivel 25 - Ciudadano
Ves a Memuzka <Clan> - Mago, nivel 42 - Republicano Soldado
```

```js
const PJ_RX = /^Ves a (.+?)(?:\s<([^>]+)>)?\s-\s([^,]+),\s*nivel\s+(\d+)(?:\s-\s+(.+?))?\s*(\[.*)?$/;
```

### Hechizos lanzados
```
Has lanzado Fuerza sobre ti.
Has lanzado Paralizar sobre Gran Águila
```

```js
const CAST_RX = /^(?:Has lanzado|Lanzaste)(?:\s+el hechizo)?\s+(.+?)\s+sobre\s+(.+?)\.?$/;
```

### Combate
```
Le has pegado a Gran Águila por 12.
Le has quitado 93 puntos de vida a Gallo.
Has impactado a X por N.

Te ha pegado Gran Águila por 8.
Gran Águila te ha quitado 8 puntos de vida.
```

### Eventos
```
Has matado a Gran Águila!
Has ganado 15 puntos de experiencia!
Has ganado 24 monedas de oro.
Has subido al nivel N!
Conectado como Roda
Te has curado N puntos de vida
Has muerto.
```

### Fin de buffs (auto-aprendizaje legacy)
```
Has dejado de estar afectado por Fuerza.
Ya no estás afectado por Celeridad.
El efecto de Bendición ha terminado.
```

### IMPORTANTE: los estados de mobs (v0.9)
- El juego avisa cuando aparece el estado (sufijo `[Paralizado]` en el mensaje "Ves a X")
- El juego **NO** avisa cuando termina el estado — el mob simplemente reaparece sin el sufijo
- Por eso v0.9 hace **diff entre observaciones consecutivas** para detectar el "ya no tiene este estado"
- Si el mob sale de rango y nunca vuelve a aparecer, el estado queda "stuck" hasta que el ticker lo expire por duración aprendida (a los 1.2× del tiempo aprendido)

---

## Las 3 fuentes de información

### 1. Consola del juego (principal)
- `MutationObserver` pasivo sobre el contenedor de chat
- Autodetección inicial: `MutationObserver` global busca text que matchee `CONSOLE_DETECT` regex, encuentra el contenedor, se attachea ahí y se desconecta
- Esto evita polling — costo CPU ~0

### 2. DOM del juego (para HP/MP/Buffs nativos)
- Lectura periódica cada 1s buscando textos tipo `(53s)` que son timers de buffs nativos del juego
- **Frágil** (heurística): puede agarrar otros números con paréntesis si los hubiera
- Solo se ejecuta si hay `activeBuffs.size > 0` (no quemamos CPU al pedo)
- Mapeo orden-por-orden: primer timer encontrado → buff más reciente

### 3. Wiki de AOWeb (`aoweb.app/wiki/*`) — v1.1+
- `fetch()` de `/wiki/npcs`, `/wiki/spells` y `/wiki/maps` al iniciar
- La wiki es una app Next.js con SSR — los datos están en el HTML como grid divs
- Parse con regex: `<p class="font-medium text-white">` para nombres, `<span>` para stats
- Cache en localStorage con TTL de 24h
- Fuentes integradas:
  - `/wiki/npcs` — **INTEGRADO**: 106 NPCs con HP, XP, oro, mapas, drops
  - `/wiki/spells` — **INTEGRADO**: 32 hechizos con desc, skill, maná
  - `/wiki/maps` — **INTEGRADO v1.5**: mapas con niveles, NPCs presentes
  - `/wiki/equipment` — PENDIENTE: items con stats
  - `/wiki/factions` — PENDIENTE: facciones

### 4. WebSocket binario
- Solo capturado, no parseado
- Útil para export/debug y eventual reverse engineering

---

## Features v1.1 — qué tiene cada componente

### Panel Unificado (top-left, `#aohud-panel`)

**Player Header** (compacto, 40px avatar):
- Avatar circular dorado con inicial + badge de nivel
- Nombre en Cinzel + clase en cursiva
- Mini-stats inline: **Kills · XP/h · Oro**

**Tab Manual** — bestiary completo:
- Buscador de criaturas (filtra en tiempo real)
- Sección "Combatidos": mobs peleados con daño real aprendido + datos wiki
- Sección "Bestiary": todos los NPCs de la wiki (HP, XP, oro, drops, mapas)
- Click sobre cualquiera → lo enfoca como target

**Tab Sesión** — stats vivos:
- Tiempo jugado · Kills · XP total · XP/h · Oro · Oro/h · Daño recibido · Mob más cazado

**Target Card** (encima del contenido del tab):
- Avatar (emoji) + nombre + daño aprendido O stats de wiki
- Barra HP animada
- Info de drops y mapa (desde wiki)
- Lista de **todos los estados activos** del mob con timer en vivo
- Estados con border-left colored, urgencia roja <5s, pulsing si duración desconocida

**Estados Activos** (panel multi-enemy debajo del target):
- Mini-cards de todos los mobs con cualquier estado activo
- Ordenados por urgencia (menos tiempo restante primero)
- Latido rojo cuando <5s, highlight dorado si es el target actual
- Click → enfocar ese mob

### Macros (`#aohud-macros`, bottom-left)
- **DESPAR** — auto-desparalizar: detecta `[Paralizado]`/`[Inmovilizado]` sobre el PJ y simula tecla configurada (default: `r`)
- **ATK** — auto-ataque: simula `Control` al canvas cada N ms (default: 800ms)
- Botones estilo hotbar del juego, glow dorado cuando activos
- Config persistida en `aoweb-hud-macros`

### Buffs sobre Roda (`#aohud-self-buffs`, centro canvas)
- Iconos translúcidos (opacity 0.7): 💪 Fuerza, 🐇 Celeridad, 🏃 Agilidad
- Timer leído del DOM nativo del juego (segundos)
- Pulso rojo cuando <10s
- Posición: `centerX, centerY - 40px`, fila horizontal

### Toasts (top-center)
- Tono dorado: nuevo descubrimiento de estado
- Tono verde: aprendizaje completado + wiki sincronizada
- Cinzel uppercase para title, regular para detail
- Auto-fade en 4.5s

### Wiki Live Data
- Fetch de `aoweb.app/wiki/npcs` y `/wiki/spells` al iniciar
- Parse del HTML SSR (Next.js) con regex
- Cache en localStorage con TTL de 24 horas
- NPCs: nombre, HP, XP, oro, mapas, drops
- Hechizos: nombre, descripción, skill requerido, maná
- Toast de confirmación al sincronizar

---

## Sistema de aprendizaje

### Tres tipos de aprendizaje persistido en localStorage

**1. Duraciones de buffs propios** (`aoweb-hud-durations`)
- Cuando un buff sobre vos termina, comparo duración real vs estimada
- Si difieren >5s, guardo la real
- Solo funciona para buffs sobre Roda (no sobre mobs)

**2. Stats de daño de mobs** (`aoweb-hud-mobs`)
- Cada `Te ha pegado X por N` → push a `hitsReceived[]` del mob X
- Máximo 50 samples por mob (rolling)
- Se muestra como `pega ~avg · máx max` en target card y Monster Manual

**3. Estados descubiertos** (`aoweb-hud-states`) — el sistema groso de v0.9
- Schema:
  ```js
  { [stateName]: { firstSeenAt: ms, sightings: N, knownDuration: seconds|null } }
  ```
- Flow:
  1. Primer avistamiento de `[Estado]` nuevo → toast dorado "Descubriste: [Estado]"
  2. Mob aparece sin el estado → calculo duración → toast verde "Aprendido: dura ~Ns"
  3. Próxima vez, ya sé la duración → countdown exacto desde el primer avistamiento
- Es **genérico**: sirve para cualquier estado que el juego use ahora o agregue después

---

## Decisiones de diseño explicadas

### Fullscreen workaround (v0.4.1) — CRÍTICO
**Problema:** el juego llama `canvas.requestFullscreen()`. La Fullscreen API hace que solo el canvas se renderee — todos nuestros overlays desaparecen.

**Solución:**
```js
HTMLElement.prototype.requestFullscreen = function(opts) {
  if (this.tagName === 'CANVAS') {
    return origRF.call(document.documentElement, opts);
  }
  return origRF.call(this, opts);
};
```
Mas listener de `fullscreenchange` que re-parenta los overlays al `fullscreenElement` si cambia.

### Target sticky (v0.8)
**Problema:** versiones previas hacían `setCurrentTarget(name)` cada vez que aparecía `Ves a X` en consola. Con múltiples mobs cerca, el target saltaba caóticamente.

**Decisión:** el target solo cambia con **acción explícita**:
- Pegar al mob
- Lanzar hechizo sobre el mob
- Click en una entrada del Manual

`Ves a X` sigue agregando el mob al map (para HP) pero NO cambia el target.

### Anti-redundancia con la UX nativa del juego
- HP/MP del PJ — el panel derecho del juego ya los muestra → NO los mostramos
- Buffs nativos del PJ — el panel derecho ya los muestra con timer → solo agregamos un **visual cue chiquito** (iconos pixel art sobre Roda), no info repetida
- Pero: el HUD lee el timer nativo para sincronizar

### Estética: medieval/épico con tres tipografías
- **Cinzel** (serif épica) — títulos y nombres
- **Press Start 2P** (pixel) — timers y números
- **IM Fell English** (serif cursiva medieval) — empties y subs en cursiva

**Paleta:**
- Fondos: `#0b1122` navy → `#1c160e` brown navy gradient
- Dorado: `#d4a857` border, `#f4d97a` highlight, `#8a6a2a` shadow
- Cream: `#e8e8d0` text
- HP/dañ: `#a01818` rojo, `#6dd58a` verde
- MP: `#2a5aa0` azul

**Borders triple-layer:**
```css
border: 2px solid #8a6a2a;
box-shadow:
  0 0 0 1px #d4a857 inset,        /* inner gold line */
  0 0 0 3px rgba(15,12,8,0.6) inset, /* dark depth */
  0 4px 20px rgba(0,0,0,0.7);     /* drop */
```

### Multi-enemy: panel Estados Activos en lugar de target switching
- WoW-style approach: mostrar mini-cards de TODOS los mobs con estado activo
- Cada uno con timer en vivo + click para enfocar
- Resuelve "tengo 3 mobs inmovilizados y no sé a cuál renovar primero"

---

## Convenciones del código

### Naming
- Todos los IDs y clases del HUD prefijo `aohud-` (evita colisiones con el juego)
- Funciones de render: `renderManual()`, `renderPlayerFrame()`, `renderSelfBuffs()`, `renderTarget()` (alias de renderManual)
- Handlers: `handle<EventType>Msg(text)` — handleEntityMsg, handleCastMsg, handleHitDone, handleHitRecv, handleKill, handleXPGain, handleGoldGain, handleBuffEnd
- Estado: `learnedX` para datos persistidos, `sessionX` para data de sesión actual

### Persistencia (localStorage keys)
- `aoweb-hud-durations` — `{ [spell]: durationInSeconds }`
- `aoweb-hud-mobs` — `{ [mobName]: { hitsReceived: number[] } }`
- `aoweb-hud-states` — `{ [stateName]: { firstSeenAt, sightings, knownDuration } }`
- `aoweb-hud-macros` — `{ antiParalysisKey: string, attackInterval: number }`
- `aoweb-hud-wiki` — `{ ts: number, npcs: {}, spells: {}, maps: {} }` (cache 24h de wiki data)
- `aoweb-hud-sessions` — `[{ date, duration, kills, xp, gold, dmgDealt, dmgRecv, topMob, map, drops }]` (últimas 20)

### Performance
- **Cero `requestAnimationFrame` loop**. Solo se usa para `scheduleReposition` debounced.
- MutationObserver global pasivo SOLO hasta autodetectar la consola, después se desconecta.
- Polling de timers nativos del juego SOLO si `activeBuffs.size > 0`.
- Ticker general corre a 500ms, se autoapaga si no hay buffs ni estados activos.

### Anti-patterns que NO usamos
- ❌ Polling agresivo de DOM (rompimos el juego en v1.1 — lección aprendida)
- ❌ `querySelectorAll('*')` cada N ms (igual de pesado)
- ❌ Frameworks (React/Vue) — es un userscript, no necesita
- ❌ Emojis modernos en interfaz épica (sí están permitidos como avatares de mobs)
- ❌ Acceso a `window.PIXI` o internals del juego (encapsulado, no funciona)

---

## Gotchas técnicos

| Cosa | Detalle |
|---|---|
| Fullscreen | El juego hace fullscreen sobre el canvas. Sin el monkey-patch, todo el HUD desaparece. Ver `v0.4.1`. |
| Fonts | Google Fonts via `<link>` injection. Tarda ~200KB primera vez, después cache. Fallback a fontFamily declarado mientras carga. |
| Heurística de timer del juego | Busca texts que matcheen `^\((\d+)s\)$`. Si el juego usa otro formato (`30 segundos`, `30s` sin paréntesis, etc.), falla. |
| State `Paralizado` confirmado | Otros estados aún no confirmados (Envenenado, Bendecido, Maldito...) — el sistema los aprende solo cuando aparezcan. |
| Mob fuera de rango con estado activo | Si el mob deja de aparecer mientras el estado está activo, no sabemos cuándo termina. El ticker lo auto-expira a los 1.2× de la duración aprendida (si la conocemos). |
| Avatar emoji de mob | Si el mob no matchea ninguna key de `MOB_EMOJIS`, se usa `⚔` default. Agregar más emojis a la tabla a medida que aparezcan tipos nuevos. |
| WebSocket binario | NO se parsea. Si en algún momento se reversa el protocolo, el HUD puede pasar de DOM-based a WS-based con muchísima más precisión y velocidad. Proyecto separado. |

---

## Historial de versiones

| v | Tema | Decisión clave |
|---|---|---|
| 0.1 | Bestiario lateral inicial | MutationObserver sobre consola |
| 0.2 | Buffs sobre PJ con timer | Auto-learn de duraciones |
| 0.3 | Estética navy/dorado/cream + overlays sobre canvas | Empezó el styling épico |
| 0.4 | Player Frame circular + buffs chicos + target hover + mini-ficha daño | Tracking daño recibido por mob |
| 0.4.1 | Fix fullscreen | Monkey-patch requestFullscreen |
| 0.5 | Redesign medieval/épico + emojis de mobs | Cinzel + Press Start 2P + IM Fell English |
| 0.6 | Buffs solo iconos transparentes vertical, pulse en <10s | Bestiario unificado estéticamente |
| 0.7 | Manual + Sesión tabs, target integrado | Sacar HP/MP del PJ (redundante) |
| 0.8 | Target sticky + panel Inmovilizados Activos | "Ves a X" deja de auto-targetear |
| 0.9 | **Aprendizaje genérico de estados** + iconos pixel sobre PJ + timer real | Sistema universal de `[Estado]` aprendido |
| 1.0 | **Panel unificado** + macros + buff icons + state card UX fix | Sacar panel Player separado, agregar DESPAR/ATK, reactivar buffs translúcidos |
| 1.1 | **Wiki live data** — bestiary de ~106 NPCs + hechizos desde aoweb.app/wiki | Reemplazar data estática del repo por fetch live con cache 24h + buscador |
| 1.2-1.4 | CC tracker, low HP alert, DPS, buff fixes | Count-up CC tracker, sound alerts, duration learning con median, buff lifecycle fix |
| 1.5 | **Batch features** — wiki maps, mana/drops/heal tracking, session history, re-buff alerts | Parseo de 8 tipos de mensajes nuevos, tab Sesión con secciones, historial persistido, toast de buff expirando |

---

## Roadmap / Pendientes

### En cocción (orden de prioridad sugerido)
1. **Validar lectura del timer del juego en vivo** — la heurística `\((\d+)s\)` puede ser frágil. Confirmar en prod.
2. **Integrar wiki de mapas** (`/wiki/maps`) — mostrar nombre del mapa + NPCs presentes + nivel requerido.
3. **Integrar wiki de equipamiento** (`/wiki/equipment`) — mostrar drops como items con stats.
4. **Confirmar otros estados que aparezcan**: Envenenado, Bendecido, Maldito, Quemado, Congelado, Invisible. El sistema los aprende solo, pero validar.
5. **Verificar macro key delivery** — test si synthetic `KeyboardEvent` llega al motor PixiJS (puede checkear `isTrusted`).
6. **Notas personales por mob** — campo de texto libre que se guarda en localStorage.
7. **Sprite sheet pixel art** real en lugar de emojis para avatares de mobs.

### Ideas válidas pero descartadas (con razón)
- **Reverse del WebSocket binario** — proyecto separado de días/semanas. No vale el ROI vs el approach DOM actual.
- **Acceso al Pixi engine para barras de HP pegadas a cada sprite** — el motor está encapsulado. Se intentó. No es accesible desde el page context.
- **Sugerencias contextuales del Clérigo** ("usá curar ahora") — requiere conocimiento experto del meta del juego que no tenemos en código. Lo dejamos a Rafa que es el experto.
- **Data estática del repo GitHub** — reemplazada por wiki live data. El repo `dcatanzaro/argentumonlineweb-servidor` tiene datos de 2019, la wiki tiene los actuales.

---

## Filosofía del proyecto

Estas son convicciones que Rafa expresó múltiples veces durante el desarrollo. Respetarlas:

1. **Anti-redundancia**: si el juego ya muestra algo, no lo duplicamos. Reemplazamos info repetida por valor agregado nuevo.
2. **Auto-aprendizaje > hardcoded**: el HUD se enriquece solo con la jugabilidad. Cada feature que se pueda aprender, se aprende.
3. **Estética coherente**: medieval/épico/pixel. Sin emojis modernos en UI (solo en avatares de mobs).
4. **Performance > features**: ningún feature vale si rompe el juego o causa lag. Probado: polling DOM agresivo rompió todo en v1.1.
5. **Vanilla JS, sin frameworks**: es un userscript, no necesita build step.
6. **Toast notifications como recompensa**: descubrir cosas debe sentirse bien, como un logro.
7. **Honestidad técnica**: si una feature es redundante o el approach es problemático, sacarla — no acumular cosas que aportan poco.

---

## Cómo arrancar a desarrollar

```bash
# El proyecto no necesita build, pero podés estructurarlo así para versionar:
aoweb-hud/
├── CLAUDE.md                  # este archivo
├── README.md                  # quick start para usuarios
├── HANDOFF-PROMPT.md          # prompt de transferencia
├── src/
│   └── aoweb-hud.user.js     # script actual (v1.1, ~1370 líneas)
└── docs/
    ├── protocol.md            # patrones de mensajes (extraídos de este CLAUDE.md)
    └── changelog.md           # historial completo (extraído de este CLAUDE.md)
```

Para probar cambios:
1. Editar `src/aoweb-hud.user.js`
2. Abrir Tampermonkey → "AOWeb HUD" → reemplazar contenido → Ctrl+S
3. F5 en `aoweb.app/play`
4. Abrir DevTools (F12) si hay error
5. Verificar el log inicial: `[AOWeb HUD v1.1] wiki live · macros · panel unificado`

Para debuggear sin saturar el chat del juego, todo se loguea con prefijo `[AOWeb HUD]` en `console.log`. Buscalo en la consola de DevTools.

Para exportar data capturada (para análisis offline o reverse engineering futuro): click en botón **Export** en el panel Manual → descarga JSON con `entitiesObserved`, `learnedDurations`, `learnedMobStats`, `learnedStates`, `consoleLog`, `wsTraffic`.

---

## Contexto del autor

**Rafa** — co-owner Achalay Marketing Digital BA, creative lead.
- Stack preference para tooling propio: vanilla JS para userscripts, Next.js + Supabase + Tailwind para apps.
- Estilo de comunicación: vos register argentino, directo, técnico, sin paja.
- Workflow: prefiere ejecución autónoma sobre approval loops. Espera challenges estratégicos cuando algo no cierra.
- Jugando: PJ "Roda" (Clérigo nivel 25, Ciudadano, en Ciudad de Lindos).

Cualquier decisión de UX/feature, recordar: **anti-redundancia + auto-aprendizaje + estética coherente + performance primero**.
