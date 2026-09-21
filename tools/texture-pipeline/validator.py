"""
Validation.

Le risque d'une chaine comme celle-ci n'est pas de produire une image laide :
c'est de produire une belle image qui n'est plus la texture du jeu. On compare
donc systematiquement le resultat a l'original ramene a la meme taille, et on
refuse ce qui s'en ecarte trop.

Trois mesures, chacune sensible a une derive differente. La similarite
structurelle voit les formes qui bougent. La similarite des aretes voit les
joints qui se deplacent ou disparaissent. L'ecart d'histogramme voit la
couleur qui derive.
"""

from __future__ import annotations

import numpy as np

from common import gaussian_blur, luminance, resize, sobel

# Seuils de rejet. Ils sont volontairement larges : la chaine doit laisser
# passer un vrai gain de detail, et n'arreter que les derives franches.
MIN_SSIM = 0.62
MIN_EDGE = 0.55
MAX_HISTOGRAM = 0.18

# Au-dela de ces deux valeurs, la texture produite est la meme image que
# l'original : une derive de teinte y est voulue, pas accidentelle.
SURE_SSIM = 0.95
SURE_EDGE = 0.95

# Flou applique avant de juger la composition, en pixels.
#
# Un agrandissement par apprentissage reconstruit le detail fin : c'est
# precisement ce qu'on lui demande. Compare pixel par pixel, il parait donc
# toujours infidele, alors que la composition, elle, n'a pas bouge. On juge
# donc a l'echelle ou le joueur regarde : les deux images sont legerement
# floutees, le grain disparait des deux cotes, et ce qui reste est la place des
# joints, des blocs et des motifs. Une vraie derive de structure se voit
# toujours a cette echelle ; un detail invente, non.
COMPOSITION_BLUR = 1.6

# Flou applique avant de juger la couleur, en pixels.
#
# Plus large encore : une teinte qui derive resiste a ce flou, alors qu'un
# simple gain de contraste local, lui, disparait. C'est la teinte qu'on veut
# surveiller, pas la vivacite.
COLOR_BLUR = 4.0


def ssim(first: np.ndarray, second: np.ndarray) -> float:
    """
    Similarite structurelle, moyenne sur l'image. Elle compare luminosite,
    contraste et structure locale plutot que les pixels un par un.
    """
    a = luminance(first)
    b = luminance(second)
    c1 = 0.01 ** 2
    c2 = 0.03 ** 2

    mean_a = gaussian_blur(a, 1.5)
    mean_b = gaussian_blur(b, 1.5)
    var_a = gaussian_blur(a * a, 1.5) - mean_a * mean_a
    var_b = gaussian_blur(b * b, 1.5) - mean_b * mean_b
    covariance = gaussian_blur(a * b, 1.5) - mean_a * mean_b

    numerator = (2 * mean_a * mean_b + c1) * (2 * covariance + c2)
    denominator = (mean_a ** 2 + mean_b ** 2 + c1) * (var_a + var_b + c2)
    return float(np.mean(numerator / np.maximum(denominator, 1e-9)))


def edge_similarity(first: np.ndarray, second: np.ndarray) -> float:
    """Correlation des aretes : les joints doivent rester au meme endroit."""
    def edges(image: np.ndarray) -> np.ndarray:
        dx, dy = sobel(luminance(image))
        magnitude = np.hypot(dx, dy)
        peak = float(magnitude.max()) or 1e-6
        return magnitude / peak

    a = edges(first).ravel()
    b = edges(second).ravel()
    a = a - a.mean()
    b = b - b.mean()
    denominator = float(np.sqrt((a * a).sum() * (b * b).sum())) or 1e-9
    return float((a * b).sum() / denominator)


def histogram_distance(first: np.ndarray, second: np.ndarray) -> float:
    """
    Ecart de couleur, mesure canal par canal sur des histogrammes normalises.

    Les deux images sont d'abord floutees franchement. Sans cela, la mesure
    sanctionne le nettoyage et la reconstruction : retirer le grain ou raviver
    le contraste local resserre ou etale la distribution des valeurs, ce qui
    ressemble a une derive de couleur alors que la teinte n'a pas bouge. Le
    flou efface les deux des deux cotes et ne laisse que la couleur.
    """
    first = gaussian_blur(first, COLOR_BLUR)
    second = gaussian_blur(second, COLOR_BLUR)
    total = 0.0
    for channel in range(3):
        a, _ = np.histogram(first[..., channel], bins=48, range=(0, 1), density=True)
        b, _ = np.histogram(second[..., channel], bins=48, range=(0, 1), density=True)
        a = a / max(a.sum(), 1e-9)
        b = b / max(b.sum(), 1e-9)
        total += float(np.abs(a - b).sum()) / 2
    return total / 3


def validate(original: np.ndarray, produced: np.ndarray) -> dict:
    """
    Compare le resultat a l'original. Rend les mesures et le verdict.

    L'original est agrandi a la taille du resultat : on compare bien la meme
    composition, pas deux echelles differentes. Le verdict porte sur les
    mesures de composition, prises sur des images legerement floutees ; les
    mesures brutes sont gardees a titre indicatif, pour voir combien de detail
    l'agrandissement a ajoute.
    """
    reference = resize(original, (produced.shape[1], produced.shape[0]))
    raw_structural = ssim(reference, produced)
    raw_edges = edge_similarity(reference, produced)

    soft_reference = gaussian_blur(reference, COMPOSITION_BLUR)
    soft_produced = gaussian_blur(produced, COMPOSITION_BLUR)
    structural = ssim(soft_reference, soft_produced)
    edges = edge_similarity(soft_reference, soft_produced)
    histogram = histogram_distance(reference, produced)

    # La distance des histogrammes dit si la teinte a derive. Elle sert a
    # rattraper une texture que l'agrandissement a delavee ; mais quand la
    # composition et les aretes sont presque identiques a l'original, le
    # deplacement de teinte est celui que la chaine a voulu, en retirant
    # l'eclairage cuit dans la texture. Le refuser reviendrait a garder la
    # texture d'epoque pour la seule raison qu'on l'a bien nettoyee.
    faithful = structural >= SURE_SSIM and edges >= SURE_EDGE
    passed = (
        structural >= MIN_SSIM
        and edges >= MIN_EDGE
        and (histogram <= MAX_HISTOGRAM or faithful)
    )
    return {
        'ssim': round(structural, 4),
        'edges': round(edges, 4),
        'histogram': round(histogram, 4),
        'ssimBrut': round(raw_structural, 4),
        'aretesBrutes': round(raw_edges, 4),
        'passed': bool(passed),
    }
