# Organización de la interfaz en la versión 0.5 (antes de la reorganización de la 0.51)

Referencia para volver atrás si hace falta. La build completa de la versión 0.5 es `track-spline-generator-v0.5.zip`.

## Encabezado (de izquierda a derecha)

Ejemplos… (selector) · Nuevo · Abrir · Guardar · Ajustes · Ref. 3D… · | · Deshacer · Anclar ventanas · | · Blender .py · 3ds Max .ms · JSON · OBJ · Escena .glb · Escena .fbx

## Barra del mapa 2D

Navegar · Editar puntos · Dibujar · Extender · Dibujar atajo · Sección socavada · Helix · Rizo · Suavizar · Recta · Meta · Referencia · Pintar cerros · Pintar subdivisión · Esculpir relieve · Ríos y cascadas · Peralte (abría su sección) · Zona plana · | · Generar terreno · Generar árboles · | · + Charcos · + Turbo pads · + Nitro strips · | · Encuadrar · Trazo crudo

Opciones que aparecían en la barra: pincel (pinturas), fuerza (esculpir), cerros, **Sección socavada** (paredes, densidad y «Socavar selección»), Helix, Suavizar, Recta, Rizo, Ríos.

## Sub-barra de Editar puntos

Vértice · Segmento · | · Mover · Rotar · Escalar (+ valor) · escala en Z (modo directo) · Radio · Bifurcar · Tramo · Abrir

## Barra 3D

Vista 3D · Exagerar Z · Reencuadrar · Wireframe (color, opacidad) · Cámara de juego · gizmo (Libre, Plano XY, Solo Z, Solo este punto)

## Barra del perfil

Encuadrar · Aplanar · Perfil de tramo · Editar solo este punto

## Barra lateral (orden, sin grupos)

1. Entrada
2. Imagen de referencia
3. Modelo de referencia 3D
4. Trazado
5. Spline (Más/Menos puntos, curva de radio fijo, bifurcar)
6. Tramos (pista / puente)
7. Elevación
8. Cruces
9. Rutas alternativas
10. Peralte
11. Textura de la pista (con la textura de tramos cubiertos: túneles y bajo cruces)
12. Geometría de la pista
13. Bordes de la pista
14. Terreno (general, tipo, densidad, subdivisión pintada, faldones, relieve esculpido con su curva, textura)
15. Cerros y túneles
16. Elementos de pista
17. Pórtico de salida
18. Secciones socavadas (lista, texturas de paredes y repetición)
19. Ríos y cascadas
20. Árboles y hierba
21. Planos de sombra
22. Decoración
23. Cielo (cámara de juego)
24. Exportación

Ajustes (ventana): tamaño del texto y atajos de teclado.

## Qué se movió en la 0.51

| Antes (0.5) | Ahora (0.51) |
|---|---|
| Selector de ejemplos (encabezado) | Sección *Entrada* |
| Ref. 3D… (encabezado) | Solo en *Modelo de referencia 3D* |
| Anclar ventanas (encabezado) | *Ajustes* → Ventanas |
| 6 botones de exportación (encabezado) | Menú **Exportar ▾** |
| Sección socavada (barra 2D + sección propia) | Tipo de tramo **Socavado** en *Tramos*; texturas de paredes al final de *Tramos* |
| Helix, Rizo, Suavizar, Recta (barra 2D) | Sub-barra de Editar (grupos *Forma* y *Crear*) |
| Meta (barra 2D) | Botón «Mover la meta…» en *Meta y pórtico de salida* |
| Peralte (barra 2D) | Quitado (la sección *Peralte* sigue en *Alturas*) |
| Zona plana (barra 2D) | Barra del perfil |
| Generar terreno / Generar árboles (barra 2D) | Barra 3D |
| + Charcos / + Turbo pads / + Nitro strips (barra 2D) | Quitados (siguen los «+ Nuevo grupo» en *Elementos de pista*) |
| Reencuadrar (barra 3D) | Encuadrar |
| Terreno (una sección) | *Terreno* + *Relieve y subdivisión* |
| Textura de tramos cubiertos (en Textura de la pista) | *Cerros y túneles* |
| Pórtico de salida | *Meta y pórtico de salida* |
