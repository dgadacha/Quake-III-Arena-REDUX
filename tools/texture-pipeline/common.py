"""
Briques communes de la chaine de textures : lecture, ecriture, et les quelques
operations d'image dont tout le reste depend.

Tout passe par numpy en virgule flottante, dans l'intervalle zero-un. Les
couleurs sont lues en sRGB et converties en lumiere lineaire quand un calcul
demande de la lumiere ; le relief et la rugosite, eux, se calculent sur la
luminance percue, plus proche de ce que l'oeil lit d'une surface.

Aucune dependance en dehors de PIL et numpy : la chaine doit pouvoir tourner
sur une machine ou rien n'est installe.
"""

from __future__ import annotations

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def load_image(path) -> np.ndarray:
    """Charge une image en RGB flottant, zero-un."""
    with Image.open(path) as handle:
        image = handle.convert('RGB')
        return np.asarray(image, dtype=np.float32) / 255.0


def load_alpha(path) -> np.ndarray | None:
    """Canal alpha d'une image, ou rien si elle n'en a pas."""
    with Image.open(path) as handle:
        if handle.mode not in ('RGBA', 'LA', 'PA'):
            return None
        return np.asarray(handle.convert('RGBA'), dtype=np.float32)[..., 3] / 255.0


def save_image(array: np.ndarray, path) -> None:
    """Ecrit une image flottante zero-un. Un seul canal donne une image grise."""
    data = np.clip(array, 0.0, 1.0)
    data = (data * 255.0 + 0.5).astype(np.uint8)
    mode = 'L' if data.ndim == 2 else 'RGB'
    Image.fromarray(data, mode=mode).save(path, optimize=True)


def resize(array: np.ndarray, size: int, filter=Image.LANCZOS) -> np.ndarray:
    """Rechantillonne une image flottante vers un carre de cote demande."""
    single = array.ndim == 2
    data = np.clip(array, 0.0, 1.0)
    data = (data * 255.0 + 0.5).astype(np.uint8)
    image = Image.fromarray(data, mode='L' if single else 'RGB')
    return np.asarray(image.resize((size, size), filter), dtype=np.float32) / 255.0


def luminance(rgb: np.ndarray) -> np.ndarray:
    """Luminance percue : c'est elle qui porte la lecture d'une surface."""
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def to_linear(srgb: np.ndarray) -> np.ndarray:
    """sRGB vers lumiere lineaire."""
    low = srgb / 12.92
    high = ((srgb + 0.055) / 1.055) ** 2.4
    return np.where(srgb <= 0.04045, low, high)


def to_srgb(linear: np.ndarray) -> np.ndarray:
    """Lumiere lineaire vers sRGB."""
    low = linear * 12.92
    high = 1.055 * np.clip(linear, 0, None) ** (1 / 2.4) - 0.055
    return np.where(linear <= 0.0031308, low, high)


def box_blur(array: np.ndarray, radius: int) -> np.ndarray:
    """
    Moyenne sur une fenetre carree, calculee par image integrale : le cout ne
    depend pas du rayon. Les bords sont enroules, comme une texture repetee.

    La somme cumulee est calculee en double precision. En simple precision, la
    somme d'un million de pixels atteint des valeurs ou les dernieres decimales
    disparaissent : les differences rendaient alors des variances legerement
    negatives, et le filtre guide produisait des divisions par zero.
    """
    if radius < 1:
        return array
    single = array.ndim == 2
    data = array[..., None] if single else array
    padded = np.pad(data, ((radius + 1, radius), (radius + 1, radius), (0, 0)), mode='wrap')
    integral = padded.astype(np.float64).cumsum(axis=0).cumsum(axis=1)
    size = 2 * radius + 1
    height, width = data.shape[:2]
    total = (
        integral[size:size + height, size:size + width]
        - integral[0:height, size:size + width]
        - integral[size:size + height, 0:width]
        + integral[0:height, 0:width]
    )
    result = (total / (size * size)).astype(np.float32)
    return result[..., 0] if single else result


def gaussian_blur(array: np.ndarray, sigma: float) -> np.ndarray:
    """
    Flou gaussien separable, applique en enroulant les bords : les textures
    sont repetees, leurs bords se touchent donc vraiment.
    """
    if sigma <= 0:
        return array
    radius = max(1, int(sigma * 3))
    positions = np.arange(-radius, radius + 1, dtype=np.float32)
    kernel = np.exp(-(positions ** 2) / (2 * sigma * sigma))
    kernel /= kernel.sum()

    single = array.ndim == 2
    data = array[..., None] if single else array
    out = np.empty_like(data)
    for channel in range(data.shape[2]):
        plane = data[..., channel]
        wide = np.pad(plane, ((0, 0), (radius, radius)), mode='wrap')
        rows = np.apply_along_axis(lambda row: np.convolve(row, kernel, mode='valid'), 1, wide)
        tall = np.pad(rows, ((radius, radius), (0, 0)), mode='wrap')
        out[..., channel] = np.apply_along_axis(
            lambda column: np.convolve(column, kernel, mode='valid'), 0, tall
        )
    return out[..., 0] if single else out


def guided_filter(source: np.ndarray, guide: np.ndarray, radius: int, epsilon: float) -> np.ndarray:
    """
    Filtre guide : il lisse une image sans traverser les aretes de son guide.
    C'est ce qui permet de retirer le bruit d'une texture d'epoque tout en
    gardant les joints, les rivets et les bordures, la ou un flou les
    effacerait.
    """
    mean_guide = box_blur(guide, radius)
    mean_source = box_blur(source, radius)
    correlation = box_blur(guide * source, radius)
    # La variance est positive par construction ; l'arithmetique, elle, peut
    # rendre un tres petit negatif, et le denominateur s'annulerait.
    variance = np.maximum(box_blur(guide * guide, radius) - mean_guide * mean_guide, 0.0)
    covariance = correlation - mean_guide * mean_source

    slope = covariance / (variance + max(epsilon, 1e-6))
    offset = mean_source - slope * mean_guide
    return box_blur(slope, radius) * guide + box_blur(offset, radius)


def sobel(plane: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Derivees horizontale et verticale, bords enroules."""
    padded = np.pad(plane, 1, mode='wrap')
    kernel_x = np.array([[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]], dtype=np.float32) / 8.0
    kernel_y = kernel_x.T
    dx = np.zeros_like(plane)
    dy = np.zeros_like(plane)
    for row in range(3):
        for column in range(3):
            window = padded[row:row + plane.shape[0], column:column + plane.shape[1]]
            dx += window * kernel_x[row, column]
            dy += window * kernel_y[row, column]
    return dx, dy


def normalize01(plane: np.ndarray, low: float = 0.5, high: float = 99.5) -> np.ndarray:
    """
    Etale une image sur zero-un en ignorant les extremes : un seul pixel noir
    ou blanc ne doit pas decider de l'echelle de toute la carte.
    """
    minimum = np.percentile(plane, low)
    maximum = np.percentile(plane, high)
    if maximum - minimum < 1e-6:
        return np.zeros_like(plane)
    return np.clip((plane - minimum) / (maximum - minimum), 0.0, 1.0)


def value_noise(size: int, cells: int, octaves: int = 3, seed: int = 1) -> np.ndarray:
    """
    Bruit doux et repetable, entre zero et un.

    Il est construit sur une grille grossiere tiree au hasard, puis interpole
    avec une courbe lissee et somme sur plusieurs octaves. La grille est
    refermee sur elle-meme : le bruit se repete sans couture, comme la texture
    qu'il accompagne.

    Il sert a decrire ce qu'une texture d'epoque ne dit pas : qu'une dalle est
    plus usee qu'une autre, qu'un coin de sol est humide et renvoie la lumiere
    la ou le reste est mat.
    """
    generator = np.random.default_rng(seed)
    total = np.zeros((size, size), dtype=np.float32)
    amplitude = 1.0
    weight = 0.0

    for octave in range(octaves):
        count = max(2, cells * (2 ** octave))
        grid = generator.random((count, count)).astype(np.float32)
        # Repetition : la derniere ligne et la derniere colonne rejoignent les premieres.
        grid = np.pad(grid, ((0, 1), (0, 1)), mode='wrap')

        positions = np.linspace(0, count, size, endpoint=False, dtype=np.float32)
        low = np.floor(positions).astype(np.int32)
        fraction = positions - low
        # Courbe lissee : la derivee s'annule aux bords des cellules.
        smooth = fraction * fraction * (3 - 2 * fraction)

        rows = grid[low][:, low] * (1 - smooth)[None, :] + grid[low][:, low + 1] * smooth[None, :]
        rows_next = (
            grid[low + 1][:, low] * (1 - smooth)[None, :]
            + grid[low + 1][:, low + 1] * smooth[None, :]
        )
        octave_noise = rows * (1 - smooth)[:, None] + rows_next * smooth[:, None]

        total += octave_noise * amplitude
        weight += amplitude
        amplitude *= 0.5

    return total / max(weight, 1e-6)


def remap(plane: np.ndarray, low: float, high: float) -> np.ndarray:
    """Ramene une image zero-un dans l'intervalle demande."""
    return low + np.clip(plane, 0.0, 1.0) * (high - low)
