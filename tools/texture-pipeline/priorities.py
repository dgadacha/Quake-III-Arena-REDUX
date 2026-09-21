"""
Surfaces prioritaires de la demonstration.

Toutes les textures d'une carte ne meritent pas le meme soin. Le sol de la
grande salle occupe a lui seul la moitie de l'image des qu'on regarde devant
soi ; un trim de deux faces, jamais. Cette table dit donc, surface par surface,
la resolution a viser et ce que la matiere doit faire, la ou le classement
automatique reste trop general.

Elle ne remplace pas la chaine : elle la precise pour une poignee de surfaces.
Tout ce qui n'y figure pas garde le traitement par defaut.
"""

from __future__ import annotations

from dataclasses import dataclass

from classifier import MaterialType


@dataclass(frozen=True)
class Priority:
    """Ce qu'une surface prioritaire demande de plus que le traitement courant."""

    base: int | None = None
    """Resolution de la couleur. Rien : la chaine decide d'apres la source."""
    maps: int | None = None
    """
    Resolution des cartes de surface. Elle peut depasser celle de la couleur :
    le relief, la rugosite et l'occlusion sont calcules, pas agrandis, et ils
    gagnent a etre fins meme quand l'image d'origine est petite.
    """
    kind: MaterialType | None = None
    """Matiere imposee, quand le nom de la texture trompe le classement."""
    roughness: tuple[float, float] | None = None
    """Intervalle de rugosite impose."""
    variation: float = 0.0
    """
    Part de variation spatiale de la rugosite. C'est ce qui fait qu'un sol
    n'est pas mat partout : quelques dalles renvoient la lumiere des lampes.
    """
    detail: float | None = None
    """Part de detail fin dans le relief. Bas pour un sol : on veut les joints."""
    neutralize: float | None = None
    """
    Part d'eclairage cuit retiree de la couleur. Certaines textures, comme une
    rouille faite de mouchetures, ne supportent pas d'etre aplanies : leur
    teinte derive et la validation ne les reconnait plus.
    """
    engine: str | None = None
    """
    Moteur d'agrandissement impose. L'agrandissement par apprentissage
    reconstruit du detail : c'est un gain sur une plaque ou une pierre usee,
    une derive sur une brique dont il redessine les joints. Le choix se fait
    donc surface par surface, et la validation tranche.
    """
    clean: float = 1.0
    """
    Force du nettoyage, en facteur de celle que le bruit mesure impose. Au-dela
    de un, la texture est debruitee plus franchement : c'est ce qu'il faut pour
    les grandes surfaces, ou le grain de compression se voit sur toute l'image.
    """
    metal_mask: bool = False
    """
    Part metallique tiree d'un masque plutot que d'une constante : le metal nu
    n'apparait que la ou la surface est usee, pas sous la rouille ni sous la
    peinture.
    """


PRIORITIES: dict[str, Priority] = {
    **{
        f'textures/gothic_floor/q1metal7_99{suffix}': Priority(
            engine='lanczos', base=1024, maps=1024, kind=MaterialType.METAL,
            roughness=(0.32, 0.76), variation=0.22, detail=0.4,
            neutralize=0.08, clean=0.5, metal_mask=True,
        )
        for suffix in ('stair', 'stair2', 'stair3')
    },
    # Panneau dominant de la carte : trois mille faces, presque tous les murs
    # de la grande salle. Metal peint et rouille, donc peu metallique dans
    # l'ensemble, avec le metal nu qui affleure sur les parties usees.
    'textures/gothic_trim/pitted_rust3': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.38, 0.86),
        variation=0.18,
        detail=0.4,
        # Nettoyage modere : cette rouille est faite de mouchetures claires, et
        # les retirer toutes deplace sa teinte au point que la validation, a
        # juste titre, ne reconnait plus la texture.
        clean=0.6,
        neutralize=0.3,
        metal_mask=True,
    ),
    # Brique de rue : pierre seche, joints marques, aucun reflet metallique.
    'textures/gothic_wall/streetbricks10': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.STONE,
        roughness=(0.62, 0.92),
        variation=0.14,
        detail=0.45,
        clean=1.5,
    ),
    'textures/gothic_wall/streetbricks11': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.STONE,
        roughness=(0.62, 0.92),
        variation=0.14,
        detail=0.45,
        clean=1.5,
    ),
    # Grands blocs de pierre : meme matiere, relief plus large.
    'textures/gothic_block/blocks15': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.STONE,
        roughness=(0.6, 0.9),
        variation=0.16,
        detail=0.35,
        clean=1.5,
    ),
    'textures/gothic_block/blocks17g': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.STONE,
        roughness=(0.6, 0.9),
        variation=0.16,
        detail=0.35,
        clean=1.4,
    ),
    'textures/gothic_block/blocks18c': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.STONE,
        roughness=(0.6, 0.9),
        variation=0.16,
        detail=0.35,
        clean=1.4,
    ),
    'textures/gothic_ceiling/stucco7top': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.CONCRETE,
        roughness=(0.66, 0.9),
        variation=0.12,
        detail=0.4,
        clean=1.4,
    ),
    # Sol de la salle de reference de q3dm7. Plaque ancienne, rouillee par
    # endroits, humide par endroits : la rugosite doit varier franchement, et
    # le metal nu n'affleurer que sur les parties usees.
    'textures/gothic_floor/q1metal7_99': Priority(
        engine='esrgan',
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.28, 0.82),
        variation=0.26,
        detail=0.5,
        metal_mask=True,
    ),
    # Panneaux et portes de fer de la salle : c'est le metal le plus visible de
    # la carte. Plaque peinte et usee, donc metal nu par masque, rugosite basse
    # sur les parties polies pour que les lanternes s'y voient.
    'textures/gothic_wall/iron01_e': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.22, 0.62),
        variation=0.2,
        detail=0.5,
        clean=1.2,
        metal_mask=True,
    ),
    'textures/gothic_wall/iron01_m': Priority(
        engine='esrgan',
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.24, 0.64),
        variation=0.2,
        detail=0.5,
        clean=1.2,
        metal_mask=True,
    ),
    'textures/gothic_wall/iron01_b': Priority(
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.26, 0.66),
        variation=0.18,
        detail=0.5,
        clean=1.2,
        metal_mask=True,
    ),
    'textures/gothic_wall/iron01_ndark': Priority(
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.3, 0.7),
        variation=0.18,
        detail=0.5,
        clean=1.2,
        metal_mask=True,
    ),
    # Trims et plinthes : metal ancien, plus mat, mais il doit rester du metal.
    'textures/gothic_trim/baseboard09': Priority(
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.34, 0.74),
        variation=0.16,
        detail=0.45,
        clean=1.2,
        metal_mask=True,
    ),
    'textures/gothic_trim/baseboard09_g3': Priority(
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.34, 0.74),
        variation=0.16,
        detail=0.45,
        clean=1.2,
        metal_mask=True,
    ),
    'textures/gothic_trim/q1metal7': Priority(
        engine='lanczos',
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.3, 0.72),
        variation=0.18,
        detail=0.45,
        clean=0.6,
        neutralize=0.3,
        metal_mask=True,
    ),
    # Colonne de la salle : structure, vue de pres tout le temps.
    'textures/gothic_trim/column2c_trans': Priority(
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.3, 0.72),
        variation=0.16,
        detail=0.45,
        clean=1.2,
        metal_mask=True,
    ),
    'textures/gothic_floor/goopq1metal7_98e': Priority(
        base=1024,
        maps=1024,
        kind=MaterialType.METAL,
        roughness=(0.26, 0.74),
        variation=0.24,
        detail=0.5,
        metal_mask=True,
    ),
}


def priority(name: str) -> Priority:
    return PRIORITIES.get(name, Priority())
