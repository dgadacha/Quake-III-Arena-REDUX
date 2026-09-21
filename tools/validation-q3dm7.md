# q3dm7 : lave, couverture HD et performances

Validation locale du 22 septembre 2026.

## Changements

- Horloge partagee des liquides : les materiaux restent animes apres le changement de carte et l'arrivee des cartes HD.
- Lave : croute basaltique procedurale periodique, fissures emissives, couches du shader Q3 en mouvement, maillage subdivise avec plages PVS conservees et houle de 1,8 unite maximum.
- Occlusion calculee a demi-resolution par axe en qualite moyenne, trois quarts en haute et pleine resolution en ultra. Le monde et l'arme restent a leur resolution habituelle.
- Conversion sRGB fusionnee avec l'etalonnage ; liberation des ressources des passes lors de la reconstruction du pipeline.
- Couverture : 114 materiaux de surfaces, 57 images dependantes des scripts, 152 entrees uniques pour q3dm7. Le ciel est compose de ses couches HD ; le brouillard n'a pas d'image a agrandir. Aucun fichier manquant dans l'audit.
- 43 entrees ajoutees au manifeste existant. Les nouveaux assets sont agrandis depuis les sources locales, avec conservation des details et cartes de relief ; ce ne sont pas des textures natives nouvellement photographiees. Les versions Real-ESRGAN deja presentes sont conservees.
- 12 fichiers BC7 invalides repares. Les dimensions impaires des mipmaps sont maintenant arrondies comme dans WebGL ; repli PNG effectif si une version compressee est illisible.

## Mesure comparable

Navigateur integre, meme vue `shot=3`, tampon 2560 x 1440, resolution dynamique desactivee, textures HD chargees. Moyenne des images apres echauffement dans `tools/profile.html?shot=3&dpr=2` :

| Configuration | Avant | Apres |
| --- | ---: | ---: |
| Effets actifs | 55,7 FPS / 17,96 ms | 78,2 FPS / 12,79 ms |
| Sans AO | 83,3 FPS | 90,8 FPS |
| Sans bloom | 59,6 FPS | 86,8 FPS |

Gain mesure : environ 40 %. Ce resultat ne garantit pas la meme cadence dans toutes les salles, resolutions et navigateurs. Les temps GPU par passe de l'extension du navigateur ne sont pas utilises pour cette comparaison ; le HUD indique explicitement des temps d'envoi CPU.

## Reproduire

```sh
npm test
npm run build
python3 tools/texture-pipeline/test_pipeline.py
python3 tools/texture-pipeline/audit_map.py --map q3dm7 --source baseq3
```

Generation complete, depuis les archives installees :

```sh
npm run textures:generate -- --source baseq3 --map q3dm7 --complete-map
```

Avec Vite en route :

- `/tools/render-smoke.html` : conservation du canvas, 14 niveaux de resolution, absence d'image noire, noirs preserves, dimensions AO/bloom en DPR 2, aucune erreur WebGL.
- `/tools/profile.html?shot=3&dpr=2` : benchmark comparatif.
- `/?shot=4` : vue fixe de la salle de lave, meme position que la capture utilisateur. Le jeu normal reste a `/`.

Tests unitaires supplementaires : horloge apres transition, subdivision et UV de la lave, plages PVS, mipmaps impaires jusqu'a 1x1, validation des images d'animation noires.
