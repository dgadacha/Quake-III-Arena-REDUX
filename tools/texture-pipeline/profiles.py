"""
Reglages par nature de matiere.

Ces valeurs ne pretendent pas etre physiques : ce sont des intervalles de
travail, choisis pour que chaque matiere reponde a la lumiere comme on
l'attend. Une plaque de metal renvoie la lumiere et ne diffuse presque rien ;
une pierre diffuse et ne renvoie qu'un voile. C'est ce contraste de reponse,
plus que la resolution, qui fait la difference entre une texture agrandie et un
materiau.
"""

from __future__ import annotations

from dataclasses import dataclass

from classifier import MaterialType


@dataclass(frozen=True)
class MaterialProfile:
    """Comment une matiere se comporte face a la lumiere."""

    normal_strength: float
    """Force du relief rendu par la normale."""
    roughness: tuple[float, float]
    """Intervalle de rugosite, du plus lisse au plus mat."""
    metalness: float
    """Part metallique. Elle vient de la matiere, jamais de la luminosite."""
    detail: float
    """Part de detail fin conservee dans le relief."""
    ao: float
    """Force de l'occlusion deduite des creux."""
    neutralize: float
    """
    Part d'eclairage deja cuit dans la texture que l'on retire de la couleur.
    Les textures d'epoque portent leurs ombres et leurs reflets peints ; les
    garder en plus de la lightmap et des lumieres dynamiques donnerait une
    image inutilement contrastee.
    """


PROFILES: dict[MaterialType, MaterialProfile] = {
    MaterialType.METAL: MaterialProfile(
        normal_strength=0.55, roughness=(0.25, 0.75), metalness=0.9, detail=0.8, ao=0.7, neutralize=0.5
    ),
    MaterialType.STONE: MaterialProfile(
        normal_strength=0.8, roughness=(0.7, 0.95), metalness=0.0, detail=1.0, ao=1.0, neutralize=0.45
    ),
    MaterialType.CONCRETE: MaterialProfile(
        normal_strength=0.5, roughness=(0.65, 0.9), metalness=0.0, detail=0.7, ao=0.8, neutralize=0.45
    ),
    MaterialType.WOOD: MaterialProfile(
        normal_strength=0.6, roughness=(0.55, 0.85), metalness=0.0, detail=0.9, ao=0.7, neutralize=0.4
    ),
    MaterialType.GLASS: MaterialProfile(
        normal_strength=0.25, roughness=(0.05, 0.25), metalness=0.0, detail=0.3, ao=0.2, neutralize=0.2
    ),
    MaterialType.ORGANIC: MaterialProfile(
        normal_strength=0.7, roughness=(0.6, 0.9), metalness=0.0, detail=1.0, ao=0.9, neutralize=0.4
    ),
    MaterialType.FABRIC: MaterialProfile(
        normal_strength=0.6, roughness=(0.7, 0.95), metalness=0.0, detail=0.9, ao=0.8, neutralize=0.4
    ),
    MaterialType.LIQUID: MaterialProfile(
        normal_strength=0.35, roughness=(0.02, 0.2), metalness=0.2, detail=0.5, ao=0.2, neutralize=0.2
    ),
    MaterialType.EMISSIVE: MaterialProfile(
        normal_strength=0.3, roughness=(0.3, 0.6), metalness=0.3, detail=0.5, ao=0.3, neutralize=0.0
    ),
    MaterialType.MIXED: MaterialProfile(
        normal_strength=0.6, roughness=(0.5, 0.85), metalness=0.1, detail=0.8, ao=0.7, neutralize=0.4
    ),
}


def profile(kind: MaterialType) -> MaterialProfile:
    return PROFILES[kind]
