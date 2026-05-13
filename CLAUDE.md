# AOWeb HUD — Manual del proyecto

> Userscript Tampermonkey para el cliente web de **Argentum Online** ([aoweb.app](https://aoweb.app)) por Damián Catanzaro. Inyecta un overlay con **bestiario** (wiki live), **panel unificado**, **target frame**, **buff icons sobre PJ**, **sistema genérico de aprendizaje de estados**, y **auto-detect de PJ** (nombre, clase, nivel, head sprite) vía API REST del juego.

**Estado actual:** v1.6 — funcional en producción (~2200 líneas). Compartible para el clan: auto-setup sin configuración manual.

**⚠ Drift de documentación corregido (v1.6):** versiones previas de CLAUDE.md decían que existían macros (DESPAR + ATK) desde v1.0. Verificado en código v1.5: **nunca se implementaron** o se removieron. La feature queda como pendiente, no como existente.

**⚠ Tecla de ataque corregida (v1.6):** El juego usa **Space** para `attackOrTarget` (confirmado vía `/api/auth/character-settings`), NO Control como decían versiones previas. Implicación: cualquier intento futuro de macro de auto-ataque debe simular Space, no Ctrl.

---

## TL;DR — cómo correrlo

1. Tampermonkey instalado en Chrome/Firefox.
2. Pegar `src/aoweb-hud.user.js` en un nuevo userscript.
3. Recargar `aoweb.app/play`.
4. Activar pantalla completa con el botón del juego (no F11).
5. Jugar normal — el HUD aprende solo.

**Persistencia:** `localStorage`, claves:
- `aoweb-hud-durations` — duraciones de hechizos aprendidas
- `aoweb-hud-mobs` — stats acumulados de daño que pega cada mob
- `aoweb-hud-states` — estados descubiertos y sus duraciones reales
- `aoweb-hud-wiki` — cache de datos de la wiki (NPCs, hechizos, mapas) con TTL 24h
- `aoweb-hud-sessions` — historial de sesiones anteriores (últimas 20)
- `aoweb-hud-headid` — head ID del PJ (auto-detect vía API en primera carga, manual override via picker)
- `aoweb-hud-charid` — `_id` del character activo (para detectar cambio de PJ y re-aplicar head)
- `aoweb-hud-panelpos` — posición del panel del HUD
- `aoweb-hud-sound` — toggle de alertas sonoras

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

## API REST del juego (descubierto v1.6)

El cliente Next.js de aoweb tiene endpoints REST que devuelven JSON estructurado. **Descubrimiento masivo** vs el approach DOM-only previo: ahora podemos leer estado real del PJ sin parsear consola.

Endpoints confirmados (vía perf entries en `aoweb.app/play`):

| Endpoint | Devuelve | Uso |
|---|---|---|
| `/api/auth/me` | account + array de characters (cada char: name, level, className, raceName, **id_head**, id_body, id_weapon, id_shield, id_helmet, clanName, faction, map) | Auto-detect de avatar/clase/nivel de TODOS los chars del usuario |
| `/api/auth/character-settings` | `characterId` (cuál PJ está activo), `hotkeys` (todos los keybindings del juego), `macros` (array con keyCode, targetType, label, targetSlot, targetId, grhIndex) | Auto-detect del PJ activo + leer macros nativos |
| `/api/auth/session` | datos de sesión | (sin uso aún) |
| `/api/auth/game-ticket` | ticket para conectar al WS del game | (sin uso aún) |
| `/api/runtime-config` | config del cliente | (sin uso aún) |

**Hotkeys nativos confirmados** (de `/api/auth/character-settings`):
- `moveUp/Left/Down/Right`: WASD
- `attackOrTarget`: **Space** ← clave para auto-ataque
- `pickupItem`: Q
- `equipItem`: E
- `useItem`: U
- `dropItem`: T
- `toggleWorldMap`: M
- `toggleSeguro`: K
- `toggleClanSeguro`: J
- `toggleHiddenSkill`: O

**Implicación enorme:** los macros del usuario están en el server y accesibles via REST. Confirmado vía OPTIONS: `/api/auth/character-settings` acepta `GET, HEAD, OPTIONS, PUT`. Podemos modificar macros via PUT desde el userscript y que el juego los ejecute como nativos.

### ⚠ CORRECCIÓN (v1.6): synthetic KeyboardEvents SÍ funcionan

CLAUDE.md previo decía que PixiJS rechazaba eventos con `isTrusted: false`. **Verificado en producción 2026-05-12**: `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', code: 'KeyM', keyCode: 77, ... }))` abre el mapa del mundo correctamente. **El motor de aoweb acepta eventos sintéticos**. Esto significa:

- ✅ Auto-attack es viable enviando Space en loop (implementado en v1.6)
- ✅ Cualquier hotkey nativo (M, K, J, O, Q, E, U, T, WASD) puede ser disparado por código
- ✅ Cualquier macro del juego (X, F, G, V, R, 1, 2, C en el setup de Rafa) puede dispararse via su keyCode
- ❌ **NO funciona si un input/textarea tiene foco** — el handler de `dispatchGameKey()` chequea `activeElement` y se abstiene

### Inactividad del servidor

AO mata la sesión tras N minutos sin input ("Desconectado por inactividad"). El auto-attack como side-effect mantiene viva la sesión.

### ⚠ Self-buffs requieren tecla + click del mouse (v1.9.2)

**Verificado 2026-05-12 con Rafa**: en AO, lanzar un hechizo sobre vos mismo no es solo apretar la tecla del macro. **Hay que también clickear con el mouse sobre tu propio PJ** para confirmar el target. Si solo se manda la tecla, el cast queda esperando el click y nunca se completa.

Esto rompió auto-renovar buff y auto-desparalizar en v1.7-v1.9.1. **Fix v1.9.2**: nueva función `dispatchSelfBuff(keyCode)` que:
1. Dispatch keydown+keyup del macro key
2. Después de 80ms, dispatch synthetic `pointerdown` + `mousedown` + (50ms) `pointerup` + `mouseup` + `click` en el **centro del canvas** (la cámara siempre sigue al PJ, así que centro de canvas = posición del PJ en pantalla).

Esto sirve para cualquier hechizo self-target: Fuerza, Celeridad, Bendición, Inteligencia, Curar Heridas (self), Remover Parálisis (self), etc.

**Para hechizos ofensivos** (Proyectil Mágico, Tormenta de Fuego, Inmovilizar sobre enemigo) seguimos usando `dispatchGameKey` sin click — el target debe ser elegido por el usuario.

### ⚠ HP/Maná: canvas-rendered (v1.8.2)

**Verificado 2026-05-12**: en el build actual de aoweb, los números de **VIDA y MANÁ** del panel derecho **se dibujan en canvas, NO en DOM**. Búsqueda exhaustiva de "1050" o "207" en `document` retorna 0 resultados aunque están visualmente presentes.

Sí están en DOM (engañando al reader anterior):
- "3/5" (slot de escudo)
- "4/9" (slot de flechas)

`readPlayerHP()` filtra ahora `max >= 100` para evitar agarrar esos counters. Cuando no detecta HP/MP reales, los deja en `null`. Auto-curar y auto-meditar tienen guardas estrictas y NO disparan si `playerMaxHP < 100`.

**Resolverlo en el futuro requiere uno de:**
1. Reverse del WebSocket binario para leer HP/MP del server (proyecto de semanas)
2. Hook al canvas drawing para interceptar el render del texto (frágil)
3. Tracking incremental por mensajes de consola ("Te ha pegado X por N", "Te has curado N", "¡Has recuperado N de maná!"). Requiere snapshot inicial.

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
| 1.6 | **Auto-detect PJ via API + Macros tab + Auto-ataque + fix Proyectil Mágico** | (a) Fetch `/api/auth/me` + `/api/auth/character-settings` → joinea por `characterId`, autoseta head/nombre/clase/nivel. Compartible para clan: zero-config. Detecta cambio de PJ (Roda → Dimitri) y re-aplica head. (b) Nuevo tab "Macros" con botones clickables para cada hechizo/item/comando del jugador y toggle de auto-ataque (Space cada 500/800/1200ms). (c) Confirmado que synthetic KeyboardEvents SÍ funcionan en aoweb's Pixi engine. (d) Proyectil Mágico vuelve al render de emoji simple. CLAUDE.md drift corregido. |
| 1.7 | **Auto-renovar buff** | Dropdown con buffs del usuario (Celeridad, Bendición, etc) + toggle que re-castea automáticamente cuando le quedan <2s al buff. FCT (números flotantes) más prominentes con outline triple. |
| 1.8 | **Auto-curar + Auto-meditar + Auto-desparalizar** (parcialmente funcional) | Toggles con umbrales configurables. **PROBLEMA descubierto**: HP/Maná están canvas-renderizados en aoweb actual, el reader del DOM no los encuentra. Auto-curar y auto-meditar disparaban con valores falsos del inventario (3/5, 4/9 → ratios bajos). Se sacó listado redundante de macros del juego. Spell flash ahora son 3 emojis serpenteando. |
| 1.9 | **Limpieza: removidas Auto-curar y Auto-meditar** | Como HP/MP no es detectable confiablemente en el build actual, se sacan los toggles entierros. Quedan: auto-ataque (Space), auto-desparalizar (via self-states de consola), auto-renovar buff (via activeBuffs tracking). Si se resuelve HP/MP via WebSocket parse o tracking incremental por consola, se pueden reintroducir. |
| 1.9.1 | **Dropdown de buff mejorado** | Muestra TODOS los 9 self-buffs (Fuerza, Agilidad, Inteligencia, Constitución, Carisma, Celeridad, Bendición, Resistencia Mágica, Detectar Invisible) — los que no tenés macroeados aparecen deshabilitados con "(no macroeado)". Font del select cambiado a IM Fell English (Cinzel renderea all-caps). |
| 1.9.2 | **Fix crítico: self-buffs requieren mouse click** | Descubierto que en AO los hechizos sobre vos mismo necesitan tecla + click del mouse sobre el PJ. Nueva función `dispatchSelfBuff` que después de la tecla simula click en el centro del canvas (donde cámara = PJ). Aplica a auto-renovar y auto-desparalizar. Hechizos ofensivos siguen usando `dispatchGameKey` sin click. |
| 1.9.3 | **Multi-target CC tracking** | Antes, dos "Gran Águila" paralizadas compartían UN timer porque `entities` se keyea por nombre. Ahora cada cast crea su propio entry en `myCCInstances[]`. La sección "Estados activos" itera esa lista — si tenés 3 Gran Águilas paralizadas, ves 3 timers (etiquetadas #1, #2, #3 cuando el nombre se repite). Cleanup automático 10s después de expirar. Dismiss button por-instancia (`data-dismiss-cc`). |
| 1.9.4 | **Auto-detect del intervalo del arma** | Mide el gap entre golpes melee consecutivos exitosos (excluye spells). Toma min de los últimos 10 samples. Muestra "Medido: Xms (N golpes)" en el tab MACROS + botón "Usar Xms" (aplica +30ms safety margin). Botón reset para cuando cambies de arma. Resuelve la pregunta "¿cuál es la velocidad real de mi arma?" — el HUD la descubre solo. |
| 1.10 | **Limpieza grande: solo Auto-Ataque** | Removidos Auto-Renovar (self-buff con click sintético sobre PJ no funcionó en tests) y Auto-Desparalizar (untested). También removido el helper `dispatchSelfBuff`, constant `SELF_BUFFS`, funciones `findHealMacro/findMeditarMacro/findDesparaMacro/getBuffMacroOptions/getBuffRemainingS/findMacroByLabel/setAutoRenew/setAutoDespara`. Tab MACROS ahora tiene SOLO: Auto-Ataque toggle + slider continuo de velocidad (300-2000ms, step 50ms) + medición del arma con botón "Usar Xms". Pendientes para futuro: re-implementar auto-renovar cuando descubramos cómo hacer self-targeting correctamente. |

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
- Jugando: PJ "Roda" (Clérigo Elfo nivel 26, Ciudad de Lindos mapa 62, head id 115). También tiene "Dimitri" (Paladín Enano nivel 1).
- Quiere compartir el HUD con su clan — por eso v1.6 prioriza zero-config.

Cualquier decisión de UX/feature, recordar: **anti-redundancia + auto-aprendizaje + estética coherente + performance primero**.
