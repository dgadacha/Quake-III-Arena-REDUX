"""
Agrandissement.

Deux moteurs, choisis a la ligne de commande.

« esrgan » appelle Real-ESRGAN, quand le binaire realesrgan-ncnn-vulkan est
present sur la machine : c'est le meilleur resultat, et c'est ce que le cahier
demande a terme.

« lanczos » n'a besoin de rien et sert de reference : un rechantillonnage
Lanczos, puis une restitution de detail guidee par l'image d'origine. Ce n'est
pas un rehaussement d'arete aveugle : le detail rendu est celui que l'image
contient deja, remis a l'echelle et borne, de sorte que les joints restent nets
sans halo.

Le reste de la chaine ne sait pas quel moteur a travaille : elle recoit une
image, et la suite est identique.
"""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from PIL import Image

from common import Size, dimensions, gaussian_blur, guided_filter, luminance, resize, save_image

ENGINES = ('lanczos', 'esrgan')


# Binaire livre avec le projet, ou trouve sur la machine.
BINARY = Path(__file__).resolve().parents[1] / 'bin' / 'realesrgan-ncnn-vulkan'
MODELS = BINARY.parent / 'models'

# Modele photographique : celui pour l'animation lisse trop les matieres.
MODEL = 'realesrgan-x4plus'

# Debordement enroule autour de l'image avant agrandissement, en pixels.
OVERLAP = 16


def binary() -> str | None:
    """Chemin du binaire d'agrandissement, dans le projet ou sur la machine."""
    if BINARY.exists():
        return str(BINARY)
    return shutil.which('realesrgan-ncnn-vulkan')


def available_engines() -> list[str]:
    """Moteurs reellement utilisables sur cette machine."""
    engines = ['lanczos']
    if binary():
        engines.append('esrgan')
    return engines


def upscale(image: np.ndarray, size: Size, engine: str = 'lanczos') -> np.ndarray:
    """Agrandit une image vers la taille demandee, carree ou non."""
    width, height = dimensions(size)
    if image.shape[1] >= width and image.shape[0] >= height:
        return resize(image, (width, height))
    if engine == 'esrgan' and binary():
        return _esrgan(image, (width, height))
    return _lanczos(image, (width, height))


def _lanczos(image: np.ndarray, size: Size) -> np.ndarray:
    """
    Rechantillonnage Lanczos, puis restitution du detail.

    Le detail est la difference entre l'image d'origine et sa version floue,
    remise a l'echelle. Elle est reappliquee a travers un filtre guide, ce qui
    la cantonne aux zones ou l'image d'origine avait vraiment de la structure :
    une plage lisse reste lisse, un joint redevient franc.
    """
    base = resize(image, size)

    detail_source = luminance(image)
    detail = detail_source - gaussian_blur(detail_source, 1.0)
    detail_large = resize(detail + 0.5, size) - 0.5

    guide = luminance(base)
    shaped = guided_filter(detail_large, guide, radius=2, epsilon=0.0004)
    # Borne : le detail rendu ne peut pas depasser ce que l'image portait.
    limit = float(np.percentile(np.abs(detail), 99)) or 1e-3
    shaped = np.clip(shaped, -limit, limit)

    return np.clip(base + shaped[..., None] * 0.75, 0.0, 1.0)


def _esrgan(image: np.ndarray, size: Size) -> np.ndarray:
    """
    Passe par Real-ESRGAN, puis ramene a la taille demandee.

    L'image est d'abord entouree d'un debordement pris de l'autre cote
    d'elle-meme. Le reseau ne sait pas qu'une texture se repete : sans ce
    debordement, il invente des bords differents a gauche et a droite, et la
    texture ne se raccorde plus sur un mur. Le debordement est retire apres
    l'agrandissement.
    """
    tool = binary()
    if not tool:
        return _lanczos(image, size)

    width, height = dimensions(size)
    # Le facteur est choisi sur l'axe qui grandit le plus : un seul passage du
    # reseau quand deux suffisent, deux quand la texture doit quadrupler.
    growth = max(width / image.shape[1], height / image.shape[0])
    padded = np.pad(image, ((OVERLAP, OVERLAP), (OVERLAP, OVERLAP), (0, 0)), mode='wrap')

    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'in.png'
        target = Path(directory) / 'out.png'
        save_image(padded, source)

        factor = 4 if growth > 2 else 2
        try:
            subprocess.run(
                [
                    tool,
                    '-i', str(source),
                    '-o', str(target),
                    '-s', str(factor),
                    '-n', MODEL,
                    '-m', str(MODELS),
                ],
                check=True,
                capture_output=True,
            )
        except (subprocess.CalledProcessError, OSError):
            return _lanczos(image, size)

        with Image.open(target) as handle:
            enlarged = np.asarray(handle.convert('RGB'), dtype=np.float32) / 255.0

    # Retrait du debordement, a l'echelle de l'agrandissement.
    margin = OVERLAP * factor
    enlarged = enlarged[margin:-margin, margin:-margin]
    return resize(enlarged, size)


def target_size(width: int, height: int) -> tuple[int, int]:
    """
    Taille visee, dans le rapport de la texture d'origine.

    La carte plaque ses textures a deux texels par unite du monde : un facteur
    de quatre porte donc une surface a huit texels par unite, de quoi rester
    nette a quelques metres. De plus pres il en faut le double, et les petites
    textures l'obtiennent pour presque rien : un trim de 64 par 256 agrandi
    huit fois tient dans un million de pixels, la ou une plaque de 256 carres
    en demanderait quatre.

    Le plafond est sur le cote le plus long. Une texture deja grande n'est pas
    agrandie au-dela : elle n'a pas huit fois plus de detail a raconter parce
    qu'on l'etire.
    """
    factor = 8 if width * height <= SMALL_SOURCE else 4
    target_width, target_height = width * factor, height * factor
    limit = min(1.0, CEILING / max(target_width, target_height))
    return max(1, int(target_width * limit)), max(1, int(target_height * limit))


# Au-dela de cette surface, une texture n'est plus agrandie que quatre fois :
# le detail gagne ne paierait pas la memoire qu'il coute.
SMALL_SOURCE = 128 * 128

# Cote le plus long accepte pour une carte.
CEILING = 2048
