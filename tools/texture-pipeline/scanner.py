"""
Recherche des textures a traiter.

Les donnees du jeu ne sont jamais copiees dans le depot : elles restent dans
les archives du joueur, et la chaine y pioche a la demande. Une archive pk3 est
une archive zip ordinaire ; on s'appuie sur zipfile, qui sait lire une entree
sans deplier le reste.

Le scanner sait aussi lire la liste des materiaux d'une carte, directement dans
son fichier bsp : c'est ainsi qu'on obtient les textures reellement employees
par la carte de la demonstration, et l'ordre de leur importance a l'ecran.
"""

from __future__ import annotations

import struct
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

# Extensions acceptees, dans l'ordre ou le jeu les cherche.
EXTENSIONS = ('.tga', '.jpg', '.jpeg', '.png')


@dataclass
class SourceTexture:
    """Une texture d'origine, prete a etre lue."""

    name: str
    """Nom sans extension, tel que la carte le designe."""
    archive: Path
    entry: str

    def read(self) -> bytes:
        with zipfile.ZipFile(self.archive) as archive:
            return archive.read(self.entry)


def archives(data_directory: Path) -> list[Path]:
    """Archives du jeu, dans l'ordre alphabetique comme le moteur les monte."""
    found: list[Path] = []
    for directory in sorted(data_directory.iterdir()):
        if not directory.is_dir():
            continue
        found.extend(sorted(directory.glob('*.pk3')))
    return found


def catalogue(data_directory: Path) -> dict[str, SourceTexture]:
    """
    Catalogue des textures presentes dans les archives. Une archive montee plus
    tard remplace la precedente, comme dans le jeu.
    """
    found: dict[str, SourceTexture] = {}
    for archive in archives(data_directory):
        try:
            with zipfile.ZipFile(archive) as handle:
                names = handle.namelist()
        except zipfile.BadZipFile:
            continue
        for entry in names:
            lowered = entry.lower()
            if not lowered.startswith(('textures/', 'models/')):
                continue
            for extension in EXTENSIONS:
                if lowered.endswith(extension):
                    name = entry[: -len(extension)]
                    found[name] = SourceTexture(name=name, archive=archive, entry=entry)
                    break
    return found


def map_materials(bsp: bytes) -> list[tuple[str, float, int]]:
    """
    Materiaux d'une carte, classes par la surface qu'ils couvrent.
    
    La surface est approchee face par face par la boite englobante de ses
    sommets : cela suffit pour savoir ce qui compte visuellement, et evite de
    trianguler la carte entiere. Rend des triplets nom, surface, nombre de
    faces.
    """
    lumps = [struct.unpack_from('<ii', bsp, 8 + index * 8) for index in range(17)]
    shader_offset, shader_length = lumps[1]
    shaders = [
        bsp[shader_offset + index * 72: shader_offset + index * 72 + 64].split(b'\0')[0].decode('latin1')
        for index in range(shader_length // 72)
    ]

    face_offset, face_length = lumps[13]
    vertex_offset, _ = lumps[10]
    area: dict[str, float] = defaultdict(float)
    faces: dict[str, int] = defaultdict(int)

    for index in range(face_length // 104):
        fields = struct.unpack_from('<26i', bsp, face_offset + index * 104)
        shader, first_vertex, vertex_count = fields[0], fields[3], fields[4]
        name = shaders[shader] if shader < len(shaders) else ''
        faces[name] += 1
        if vertex_count <= 0:
            continue
        xs: list[float] = []
        ys: list[float] = []
        zs: list[float] = []
        for vertex in range(first_vertex, first_vertex + vertex_count):
            x, y, z = struct.unpack_from('<3f', bsp, vertex_offset + vertex * 44)
            xs.append(x)
            ys.append(y)
            zs.append(z)
        extents = sorted(
            [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)], reverse=True
        )
        area[name] += extents[0] * extents[1]

    ranked = [(name, area[name], faces[name]) for name in area]
    ranked.sort(key=lambda entry: -entry[1])
    return ranked


def read_map(data_directory: Path, name: str) -> bytes | None:
    """Lit un fichier de carte dans les archives."""
    target = f'maps/{name}.bsp'
    for archive in reversed(archives(data_directory)):
        try:
            with zipfile.ZipFile(archive) as handle:
                if target in handle.namelist():
                    return handle.read(target)
        except zipfile.BadZipFile:
            continue
    return None
