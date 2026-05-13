# Prompts para generar sprites de hechizos con GPT

> Indicaciones para generar spritesheets animados de efectos de hechizos para el AOWeb HUD.
> Cada sprite es un PNG de **320x64px** (5 frames de 64x64 en fila horizontal).
> Los archivos generados van en `src/sprites/`.

---

## Specs generales (pegar al inicio de cada prompt)

```
Specs tecnicas obligatorias:
- Imagen PNG, fondo 100% negro (#000000), SIN transparencia
- Tamano exacto: 320x64 pixeles (5 frames de 64x64 cada uno, en fila horizontal)
- NO dejar espacio entre frames — cada uno empieza exacto donde termina el anterior
- Cada frame es una etapa de la animacion del efecto magico (de inicio a final)
- Frame 1: el efecto comienza (particulas apareciendo)
- Frame 2: el efecto crece (energia acumulandose)
- Frame 3: el efecto en su punto maximo (explosion/brillo maximo)
- Frame 4: el efecto se disipa (desvaneciendose)
- Frame 5: residuo final (ultimas particulas desapareciendo)
- Estilo: efectos magicos brillantes tipo RPG 2D, destellos, particulas y glow
- Sin personajes, sin suelo, sin texto, sin marcos
- Los efectos deben tener buen contraste sobre fondo negro
- Vista cenital levemente isometrica
```

---

## 1. Proyectil Magico → `spell_proyectil.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: PROYECTIL MAGICO
Efecto: una esfera de energia electrica azul que se forma, crece, explota en particulas y se desvanece.

Frame 1: Pequeño punto de luz azul electrico con 2-3 chispas minusculas formandose
Frame 2: La esfera crece, ahora del tamano de un puno, con anillo de energia orbitando alrededor
Frame 3: EXPLOSION — la esfera estalla en fragmentos de luz azul-blanca, rayos cortos salen del centro en 8 direcciones
Frame 4: Los fragmentos se dispersan y se atenuan, quedan estelas de luz
Frame 5: Ultimas chispas azules tenues desapareciendo, casi vacio

Paleta de colores: azul electrico (#4488ff), cyan claro (#88ccff), blanco puro para los brillos maximos. Ningun otro color.
```

---

## 2. Misil Magico → `spell_misil.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: MISIL MAGICO
Efecto: anillos concentricos de energia purpura que se expanden con una explosion de luz violeta en el centro.

Frame 1: Un punto de luz violeta con un primer anillo tenue formandose
Frame 2: Dos anillos concentricos purpura, el centro brilla mas intenso
Frame 3: EXPLOSION — tres anillos purpura expandiendose, el centro explota en luz blanca-violeta, particulas salen disparadas
Frame 4: Los anillos se desvanecen hacia afuera, el centro se apaga
Frame 5: Residuos tenues de luz purpura, anillos casi invisibles

Paleta de colores: purpura intenso (#9933ff), violeta claro (#cc66ff), blanco para el flash central. Este efecto es el mas "magico" y misterioso.
```

---

## 3. Dardo Magico → `spell_dardo.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: DARDO MAGICO
Efecto: una flecha/dardo de energia cristalina violeta que se materializa, vuela y se desintegra.

Frame 1: Particulas violeta se juntan formando la punta de una flecha de cristal
Frame 2: El dardo esta formado — flecha cristalina brillante con estela de particulas atras
Frame 3: El dardo en movimiento, estela larga de luz violeta, el brillo es maximo
Frame 4: El dardo impacta y se fragmenta en esquirlas cristalinas
Frame 5: Las esquirlas se desvanecen, quedan puntos tenues de luz

Paleta de colores: violeta (#aa55ff), lavanda claro (#cc99ff), blanco para los bordes del cristal. Aspecto cristalino y geometrico.
```

---

## 4. Tormenta de Fuego → `spell_fuego.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: TORMENTA DE FUEGO
Efecto: un remolino de llamas que crece en espiral, explota y se consume.

Frame 1: Dos o tres lenguas de fuego pequenas brotando del centro
Frame 2: Las llamas crecen en espiral, formando un vortice de fuego
Frame 3: INFERNO MAXIMO — espiral completa de fuego naranja-rojo, chispas volando en todas direcciones, brillo intenso
Frame 4: Las llamas se reducen, quedan brasas flotantes y humo naranja tenue
Frame 5: Ultimas brasas apagandose, puntos naranjas tenues

Paleta de colores: naranja fuego (#ff8800), rojo (#ff3300), amarillo (#ffcc00) para las puntas de las llamas. Sensacion de calor intenso.
```

---

## 5. Descarga Electrica → `spell_rayo.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: DESCARGA ELECTRICA
Efecto: rayos electricos que se forman, descargan con flash blanco y se disipan en chispas.

Frame 1: Chispas electricas pequenas apareciendo en puntos aleatorios
Frame 2: Los rayos se forman — lineas quebradas de electricidad amarilla conectando los puntos
Frame 3: DESCARGA — flash blanco central con rayos gruesos en zig-zag extendiendose a los bordes, maximo brillo
Frame 4: Los rayos se fragmentan en segmentos mas cortos, chispas saltando
Frame 5: Ultimas chispas tenues, arcos electricos residuales minusculos

Paleta de colores: amarillo electrico (#ffdd00), blanco puro (#ffffff), cyan palido (#88ffff) para los arcos secundarios.
```

---

## 6. Apocalipsis → `spell_apocalipsis.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: APOCALIPSIS
Efecto: un meteoro infernal que cae, impacta con explosion masiva y deja craater de fuego.

Frame 1: Un punto rojo brillante arriba con estela de fuego bajando
Frame 2: El meteoro se agranda, estela larga naranja-roja, particulas de ceniza
Frame 3: IMPACTO — explosion circular roja-blanca masiva, onda expansiva visible, fragmentos de roca/fuego volando
Frame 4: La explosion se contrae, quedan llamas residuales y humo
Frame 5: Brasas y puntos de luz roja dispersos, casi vacio

Paleta de colores: rojo infernal (#cc0000), naranja (#ff6600), blanco para el flash del impacto. El efecto mas destructivo y dramatico.
```

---

## 7. Curar Heridas Graves → `spell_curar.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: CURAR HERIDAS GRAVES
Efecto: destellos de sanacion dorados y verdes con cruces de luz que aparecen y se elevan.

Frame 1: Puntos de luz dorada y verde aparecen desde abajo
Frame 2: Los puntos se multiplican, una cruz de luz se forma en el centro
Frame 3: SANACION MAXIMA — multiples cruces de luz brillando, aureola dorada-verde, particulas ascendentes
Frame 4: Las cruces se elevan y se desvanecen, quedan puntos de luz subiendo
Frame 5: Ultimos destellos dorados tenues elevandose y desapareciendo

Paleta de colores: verde esperanza (#44dd88), dorado (#ffcc44), blanco para el brillo de las cruces. Sensacion de alivio y renovacion.
```

---

## 8. Llamado Nigromante → `spell_nigromante.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: LLAMADO NIGROMANTE
Efecto: un portal oscuro en el suelo del que emergen manos/garras de no-muertos con energia necrotica.

Frame 1: Grietas purpura-oscuro aparecen en el suelo, luz verde tenue sale de ellas
Frame 2: Se forma un circulo de invocacion, runas brillan en verde enfermizo
Frame 3: INVOCACION — el portal se abre completamente, manos esqueLeticas/garras emergen, energia purpura-verde intensa
Frame 4: Las manos se retraen, el portal se cierra, quedan particulas de energia oscura
Frame 5: Ultimas particulas purpuras y verdes desvaneciendose, el suelo queda "limpio"

Paleta de colores: purpura oscuro (#6622aa), verde enfermizo (#66ff44), negro profundo para las sombras. Atmosfera siniestra y oscura.
```

---

## 9. Toxina → `spell_toxina.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: TOXINA
Efecto: una nube de veneno verde que se expande con burbujas toxicas y se disipa.

Frame 1: Gotitas verdes y vapor tenue brotando del centro
Frame 2: La nube crece, burbujas toxicas suben, el verde se intensifica
Frame 3: NUBE MAXIMA — nube de gas verde denso con burbujas explotando, particulas de veneno en todas direcciones
Frame 4: La nube se dispersa y se aclara, quedan burbujas sueltas
Frame 5: Ultimas particulas de vapor verde tenue desapareciendo

Paleta de colores: verde toxico (#44ff00), verde oscuro (#228800), amarillo-verde (#ccff00) para las burbujas. Aspecto viscoso y peligroso.
```

---

## 10. Inmovilizar → `spell_inmovilizar.png`

```
[PEGAR SPECS GENERALES ARRIBA]

Hechizo: INMOVILIZAR
Efecto: cadenas/grilletes de hielo cristalino que se forman alrededor del objetivo y se solidifican.

Frame 1: Cristales de hielo pequenos aparecen formando un circulo
Frame 2: Los cristales crecen, cadenas de hielo comienzan a conectarlos
Frame 3: CONGELACION — las cadenas se cierran completamente formando grilletes, explosion de cristales de hielo, brillo maximo
Frame 4: Los grilletes se solidifican, menos brillo, aspecto solido y frio
Frame 5: Los cristales se agrietan levemente, particulas de escarcha flotan

Paleta de colores: azul hielo (#88ccff), blanco glacial (#eeffff), cyan brillante (#00ddff) para los cristales. Sensacion de frio y prision.
```

---

## Prompt alternativo: spritesheet estatico (10 iconos en 1 imagen)

Para una version simplificada sin animacion, se puede generar un solo PNG con los 10 iconos:

```
Generame un spritesheet PNG con fondo transparente de 640x64 pixeles (10 iconos de 64x64 cada uno, en fila horizontal).

Cada icono es un efecto magico de hechizo para un juego medieval RPG 2D (Argentum Online). Estilo: efecto de particulas brillante sobre fondo transparente, vista cenital/isometrica, con glow y destellos. NO incluir personajes ni suelo.

Los 10 hechizos en orden de izquierda a derecha:
1. Proyectil Magico — esfera azul-violeta con estela de luz
2. Misil Magico — anillos purpura concentricos con explosion de energia
3. Dardo Magico — flecha de energia cristalina azul
4. Tormenta de Fuego — espiral de llamas naranjas y rojas
5. Descarga Electrica — rayo amarillo electrico con chispas
6. Apocalipsis — meteoro rojo-naranja cayendo con estela
7. Curar Heridas Graves — destellos dorados/verdes de sanacion con cruces de luz
8. Llamado Nigromante — portal oscuro purpura con manos de zombies emergiendo
9. Toxina — nube verde venenosa con burbujas
10. Inmovilizar — cadenas/grilletes de hielo azul cristalino

Requisitos tecnicos:
- Exactamente 640x64 pixeles totales
- Cada icono ocupa exactamente 64x64 pixeles
- Fondo 100% transparente (PNG-32 con canal alfa)
- Estilo: pixel art detallado con glow, particulas y destellos
- Paleta vibrante con buen contraste sobre fondos oscuros
- Sin bordes, sin marcos, sin texto
```

---

## Archivos esperados en `src/sprites/`

| Archivo | Hechizo | Tamano |
|---|---|---|
| `spell_proyectil.png` | Proyectil Magico | 320x64 |
| `spell_misil.png` | Misil Magico | 320x64 |
| `spell_dardo.png` | Dardo Magico | 320x64 |
| `spell_fuego.png` | Tormenta de Fuego | 320x64 |
| `spell_rayo.png` | Descarga Electrica | 320x64 |
| `spell_apocalipsis.png` | Apocalipsis | 320x64 |
| `spell_curar.png` | Curar Heridas Graves | 320x64 |
| `spell_nigromante.png` | Llamado Nigromante | 320x64 |
| `spell_toxina.png` | Toxina | 320x64 |
| `spell_inmovilizar.png` | Inmovilizar | 320x64 |

## Notas de implementacion

- Fondo negro (#000000) en las animaciones — el HUD usa `mix-blend-mode: screen` o similar para que el negro sea transparente al renderear.
- 5 frames a ~200ms cada uno = 1 segundo de animacion por cast.
- Se reproducen una vez al castear el hechizo (no loopeados).
