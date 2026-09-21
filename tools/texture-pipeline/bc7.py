"""
Compression BC7, mode 6.

Une texture non compressee occupe quatre octets par pixel en memoire video, et
la carte en demande trois : couleur, relief, et la carte de surface. A pleine
couverture, q3dm7 depassait ainsi le gigaoctet et demi, ce qui se voyait sur la
cadence. Compressee par le materiel, la meme texture occupe un octet par pixel,
et le decodage ne coute rien : la carte graphique lit les blocs tels quels.

BC7 decoupe l'image en blocs de quatre par quatre et decrit chacun par deux
couleurs et seize poids. Le format en prevoit huit facons ; celle-ci, le mode
six, n'en emploie qu'une seule paire de couleurs par bloc, avec huit bits par
canal et seize degres entre les deux. C'est le mode le plus simple a ecrire, et
sur des textures de jeu, dont un bloc de seize pixels est presque toujours une
variation le long d'une seule direction, il perd tres peu.

Ce qui est ecrit ici est la disposition exacte du format : sept bits de mode,
les deux bornes canal par canal sur sept bits, les deux bits de poids faible
partages, puis les seize index. Le premier index n'en porte que trois : son bit
de tete est implicite, et c'est ce qui impose de retourner le bloc quand il
depasse la moitie de l'echelle.
"""

from __future__ import annotations

import numpy as np

# Poids des seize degres, sur soixante-quatre. Ils ne sont pas tout a fait
# reguliers : c'est la table du format.
WEIGHTS = np.array([0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64], dtype=np.int32)

# Blocs traites d'un coup. La recherche du meilleur index compare seize pixels
# a seize candidats sur quatre canaux : au-dela, le tableau intermediaire ne
# tient plus en memoire.
CHUNK = 16384


def encode(image: np.ndarray) -> bytes:
    """
    Compresse une image en blocs BC7. L'image est flottante zero-un, en trois
    ou quatre canaux ; le quatrieme, quand il manque, est mis a un.
    """
    pixels = _prepare(image)
    height, width = pixels.shape[:2]
    padded = _pad(pixels, width, height)
    blocks = _split(padded)

    out = np.empty((blocks.shape[0], 16), dtype=np.uint8)
    for start in range(0, blocks.shape[0], CHUNK):
        piece = blocks[start:start + CHUNK].astype(np.float32)
        out[start:start + CHUNK] = _encode_blocks(piece)
    return out.tobytes()


def _prepare(image: np.ndarray) -> np.ndarray:
    """Image en quatre canaux, octets, opaque par defaut."""
    data = np.clip(image, 0.0, 1.0)
    if data.ndim == 2:
        data = np.repeat(data[..., None], 3, axis=2)
    if data.shape[2] == 3:
        data = np.concatenate([data, np.ones_like(data[..., :1])], axis=2)
    return (data * 255.0 + 0.5).astype(np.uint8)


def _pad(pixels: np.ndarray, width: int, height: int) -> np.ndarray:
    """
    Complete l'image jusqu'au multiple de quatre. Le debordement est pris de
    l'autre cote : une texture se repete, ses bords se touchent.
    """
    extra_x = (-width) % 4
    extra_y = (-height) % 4
    if not extra_x and not extra_y:
        return pixels
    return np.pad(pixels, ((0, extra_y), (0, extra_x), (0, 0)), mode='wrap')


def _split(pixels: np.ndarray) -> np.ndarray:
    """Decoupe en blocs de quatre par quatre, un bloc par ligne."""
    height, width = pixels.shape[:2]
    rows, columns = height // 4, width // 4
    grid = pixels.reshape(rows, 4, columns, 4, pixels.shape[2])
    return grid.transpose(0, 2, 1, 3, 4).reshape(rows * columns, 16, pixels.shape[2])


def _encode_blocks(blocks: np.ndarray) -> np.ndarray:
    """Un paquet de blocs, de la couleur aux seize octets."""
    count = blocks.shape[0]

    # Direction principale du bloc : c'est le long de cette droite que les deux
    # bornes sont posees. Un bloc uni donne une direction quelconque et deux
    # bornes confondues, ce qui est exactement ce qu'il faut.
    mean = blocks.mean(axis=1)
    centered = blocks - mean[:, None, :]
    covariance = np.einsum('nic,nid->ncd', centered, centered) / 16.0
    _, vectors = np.linalg.eigh(covariance)
    axis = vectors[..., -1]

    projection = np.einsum('nic,nc->ni', centered, axis)
    low = mean + axis * projection.min(axis=1)[:, None]
    high = mean + axis * projection.max(axis=1)[:, None]

    quantized_low, bit_low = _quantize(low)
    quantized_high, bit_high = _quantize(high)
    exact_low = quantized_low * 2 + bit_low[:, None]
    exact_high = quantized_high * 2 + bit_high[:, None]

    # Les seize couleurs que le bloc pourra prendre, puis, pour chaque pixel,
    # celle qui en est la plus proche.
    weights = WEIGHTS[None, :, None]
    candidates = (
        exact_low[:, None, :] * (64 - weights) + exact_high[:, None, :] * weights + 32
    ) >> 6
    difference = blocks[:, :, None, :] - candidates[:, None, :, :].astype(np.float32)
    indices = np.einsum('nijc,nijc->nij', difference, difference).argmin(axis=2).astype(np.int32)

    # Le bit de tete du premier index est implicite : quand il passerait a un,
    # le bloc est retourne, bornes comprises.
    flip = indices[:, 0] > 7
    if flip.any():
        quantized_low[flip], quantized_high[flip] = quantized_high[flip].copy(), quantized_low[flip].copy()
        bit_low[flip], bit_high[flip] = bit_high[flip].copy(), bit_low[flip].copy()
        indices[flip] = 15 - indices[flip]

    return _pack(count, quantized_low, bit_low, quantized_high, bit_high, indices)


def _quantize(endpoint: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    Sept bits par canal, plus un bit de poids faible commun aux quatre canaux
    d'une meme borne. Le bit retenu est celui qui rapproche le plus.
    """
    endpoint = np.clip(endpoint, 0.0, 255.0)
    best_values = None
    best_bit = None
    best_error = None
    for bit in (0, 1):
        values = np.clip(np.rint((endpoint - bit) / 2.0), 0, 127)
        error = ((endpoint - (values * 2 + bit)) ** 2).sum(axis=1)
        if best_error is None:
            best_values, best_bit, best_error = values, np.full(endpoint.shape[0], bit), error
            continue
        better = error < best_error
        best_values = np.where(better[:, None], values, best_values)
        best_bit = np.where(better, bit, best_bit)
        best_error = np.minimum(error, best_error)
    return best_values.astype(np.int32), best_bit.astype(np.int32)


def _pack(
    count: int,
    low: np.ndarray,
    bit_low: np.ndarray,
    high: np.ndarray,
    bit_high: np.ndarray,
    indices: np.ndarray,
) -> np.ndarray:
    """Ecrit les cent vingt-huit bits de chaque bloc, poids faible en tete."""
    bits = np.zeros((count, 128), dtype=np.uint8)
    bits[:, 6] = 1  # mode six : six zeros puis un

    position = 7
    for channel in range(4):
        for values in (low, high):
            field = values[:, channel]
            for offset in range(7):
                bits[:, position + offset] = (field >> offset) & 1
            position += 7
    bits[:, position] = bit_low
    bits[:, position + 1] = bit_high
    position += 2

    for pixel in range(16):
        width = 3 if pixel == 0 else 4
        field = indices[:, pixel]
        for offset in range(width):
            bits[:, position + offset] = (field >> offset) & 1
        position += width

    assert position == 128, position
    return np.packbits(bits, axis=1, bitorder='little')


def decode(data: bytes, width: int, height: int) -> np.ndarray:
    """
    Decompresse, pour verifier l'encodage sans carte graphique. Ce n'est pas le
    chemin du jeu : c'est le controle qui dit combien la compression a coute.
    """
    rows, columns = (height + 3) // 4, (width + 3) // 4
    blocks = np.frombuffer(data, dtype=np.uint8).reshape(rows * columns, 16)
    bits = np.unpackbits(blocks, axis=1, bitorder='little')

    position = 7
    fields = []
    for _ in range(8):
        value = np.zeros(bits.shape[0], dtype=np.int32)
        for offset in range(7):
            value |= bits[:, position + offset].astype(np.int32) << offset
        fields.append(value)
        position += 7
    bit_low = bits[:, position].astype(np.int32)
    bit_high = bits[:, position + 1].astype(np.int32)
    position += 2

    low = np.stack([fields[0], fields[2], fields[4], fields[6]], axis=1) * 2 + bit_low[:, None]
    high = np.stack([fields[1], fields[3], fields[5], fields[7]], axis=1) * 2 + bit_high[:, None]

    indices = np.zeros((bits.shape[0], 16), dtype=np.int32)
    for pixel in range(16):
        span = 3 if pixel == 0 else 4
        for offset in range(span):
            indices[:, pixel] |= bits[:, position + offset].astype(np.int32) << offset
        position += span

    weights = WEIGHTS[indices]
    colors = (
        low[:, None, :] * (64 - weights[..., None]) + high[:, None, :] * weights[..., None] + 32
    ) >> 6

    grid = colors.reshape(rows, columns, 4, 4, 4).transpose(0, 2, 1, 3, 4)
    image = grid.reshape(rows * 4, columns * 4, 4)
    return image[:height, :width].astype(np.float32) / 255.0
