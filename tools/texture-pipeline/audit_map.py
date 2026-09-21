"""Audit reproductible des surfaces et dependances HD d'un BSP local."""
import argparse
import json
from pathlib import Path
import scanner
import shaders

ROOT = Path(__file__).resolve().parents[2]

def audit(name='q3dm7', source='baseq3'):
    data = ROOT / 'public/data' / source
    scripts = shaders.catalogue(data)
    images = scanner.catalogue(data)
    entries = json.loads((ROOT / 'public/generated/materials/manifest.json').read_text())
    bsp = scanner.read_map(data, name)
    if bsp is None:
        raise ValueError(f'Map missing: {name}')
    surfaces, dependencies, procedural, missing = [], set(), [], []
    for raw, _, _ in scanner.map_materials(bsp):
        key = raw.lower()
        script = scripts.get(key)
        if script:
            dependencies.update(path for path in script.dependencies if path in images)
        # Le brouillard n'a pas d'image et le ciel est compose de ses couches.
        if key == 'textures/sfx/fog_intel' or key.startswith('textures/skies/'):
            procedural.append(key)
            continue
        surfaces.append(key)
        if key not in entries:
            missing.append(key)
    missing.extend(path for path in dependencies if path not in entries)
    paths = set(surfaces) | dependencies
    invalid = []
    sizes = {}
    for key in sorted(paths):
        entry = entries.get(key)
        if not entry:
            continue
        sizes[key] = entry.get('size', entry['resolution'])
        if not entry['validation']['passed']:
            invalid.append(key + ': validation')
        for path in [*entry['maps'].values(), *entry.get('compressed', {}).values()]:
            if not (ROOT / 'public' / path).is_file():
                invalid.append(path)
    return dict(map=name, source=source, surfaces=len(surfaces), dependencies=len(dependencies),
                uniqueMaterials=len(paths), procedural=procedural, missing=sorted(set(missing)),
                invalid=invalid, sizes=sizes)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--map', default='q3dm7')
    parser.add_argument('--source', default='baseq3')
    args = parser.parse_args()
    report = audit(args.map, args.source)
    print(json.dumps(report, indent=2))
    raise SystemExit(bool(report['missing'] or report['invalid']))
