# Prompt de handoff — copiar y pegar al iniciar Claude Code

```
Estoy continuando el desarrollo de AOWeb HUD — un userscript Tampermonkey
para aoweb.app (Argentum Online web por Damián Catanzaro).

Vengo de una sesión larga en claude.ai donde construimos hasta v0.9.
Antes de hacer cualquier cosa, leé estos archivos en orden:

1. CLAUDE.md — contexto completo, decisiones, protocolo del juego, features,
   gotchas, roadmap y filosofía del proyecto.
2. src/aoweb-hud.user.js — el script actual funcionando (~1163 líneas).

Stack: vanilla JS, sin frameworks, sin build step. Tipografías Cinzel +
Press Start 2P + IM Fell English inyectadas vía link de Google Fonts.
Persistencia en localStorage con claves aoweb-hud-durations,
aoweb-hud-mobs y aoweb-hud-states.

Cuando termines de leer, decime:

1. ¿Qué entendiste del estado actual del proyecto?
2. ¿Qué parte del roadmap querés que abordemos primero?
3. ¿Hay algo del código actual que te parezca que conviene refactorear
   antes de seguir agregando features? (sé honesto, no me importa romper
   cosas si vale la pena.)

Convenciones que respeto siempre:
- Anti-redundancia: si el juego ya muestra algo, no lo duplico
- Auto-aprendizaje > valores hardcoded
- Estética medieval/épica coherente (sin emojis modernos en UI)
- Performance > features (cero polling agresivo de DOM)
- IDs y clases con prefijo aohud-*

Vos register argentino, directo. No me hagas approval loops para cosas
chicas; ejecutá y mostrame. Si ves algo dudoso, challengeame con argumento.
```
