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

from common import gaussian_blur, guided_filter, luminance, resize, save_image

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


def upscale(image: np.ndarray, size: int, engine: str = 'lanczos') -> np.ndarray:
    """Agrandit une image carree vers le cote demande."""
    if image.shape[0] >= size:
        return resize(image, size)
    if engine == 'esrgan' and binary():
        return _esrgan(image, size)
    return _lanczos(image, size)


def _lanczos(image: np.ndarray, size: int) -> np.ndarray:
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


def _esrgan(image: np.ndarray, size: int) -> np.ndarray:
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

    source_size = image.shape[0]
    padded = np.pad(image, ((OVERLAP, OVERLAP), (OVERLAP, OVERLAP), (0, 0)), mode='wrap')

    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'in.png'
        target = Path(directory) / 'out.png'
        save_image(padded, source)

        factor = 4 if size / source_size > 2 else 2
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


def target_size(source_size: int) -> int:
    """
    Taille visee. Le cahier fixe un rapport de quatre, plafonne : toutes les
    textures n'ont pas besoin de 4K, et une plaque de 128 pixels n'a pas quatre
    fois plus de detail a raconter parce qu'on l'agrandit huit fois.
    """
    if source_size <= 64:
        return 256
    if source_size <= 128:
        return 512
    if source_size <= 256:
        return 1024
    return 2048
