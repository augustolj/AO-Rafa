# AOWeb HUD

HUD overlay para [aoweb.app](https://aoweb.app) — bestiario, target frame, macros, buff tracker y más.

## Instalación

1. Instalá [Tampermonkey](https://www.tampermonkey.net/) en Chrome o Firefox
2. Abrí esta URL en el navegador:
   ```
   https://raw.githubusercontent.com/augustolj/AO-Rafa/main/src/aoweb-hud.user.js
   ```
3. Tampermonkey intercepta el archivo y te ofrece instalarlo — confirmá
4. Entrá a `aoweb.app/play` y jugá normal

## Actualizaciones

Tampermonkey chequea updates automáticamente cada 24hs. Para forzar una actualización: panel de Tampermonkey → AOWeb HUD → **Check for updates**.

## Desarrollo

El archivo de producción es `src/aoweb-hud.user.js`. Para testear sin afectar a los usuarios:

1. Trabajá sobre `src/aoweb-hud.dev.user.js`
2. Instalalo en Tampermonkey manualmente (arrastrá el archivo al navegador o usá "Install from file")
3. Cuando el cambio esté listo, copialo a `aoweb-hud.user.js`, bumpea el `@version` y hacé push

Tampermonkey detecta la nueva versión por el bump de `@version` en el header.
