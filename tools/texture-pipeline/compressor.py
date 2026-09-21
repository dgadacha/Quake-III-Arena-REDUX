"""
Compression pour le web.

Le format voulu a l'execution est KTX2 : compresse par le materiel, il divise
la memoire video et le telechargement. Il demande l'outil toktx ou basisu, qui
n'est pas installe partout ; quand il manque, la chaine ecrit des PNG et le dit
franchement plutot que de laisser croire a une compression qui n'a pas eu lieu.

Le chargeur du jeu accepte les deux : le manifeste indique le fichier produit.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def available() -> str | None:
    """Outil de compression disponible, ou rien."""
    for tool in ('toktx', 'basisu'):
        if shutil.which(tool):
            return tool
    return None


def compress(source: Path, normal_map: bool = False) -> Path:
    """
    Compresse une image en KTX2 quand c'est possible. Rend le chemin du fichier
    a servir : le KTX2 s'il existe, l'image d'origine sinon.
    """
    tool = available()
    if not tool:
        return source

    target = source.with_suffix('.ktx2')
    if tool == 'toktx':
        command = [
            'toktx', '--t2', '--genmipmap', '--encode', 'uastc',
            '--uastc_quality', '2',
        ]
        if normal_map:
            command += ['--normal_mode']
        command += [str(target), str(source)]
    else:
        command = [
            'basisu', '-ktx2', '-mipmap', '-uastc',
            '-output_file', str(target), str(source),
        ]
        if normal_map:
            command.append('-normal_map')

    try:
        subprocess.run(command, check=True, capture_output=True)
    except (subprocess.CalledProcessError, OSError):
        return source
    return target
