#!/usr/bin/env python3
"""Packs data/global-menu into a GResource.

Writes an index from window identifier to application, so the shell finds the
menu of a window without reading the mappings, plus one minified file per
application. Everything is checked here so the shell does not have to.
"""

import json
import os
import subprocess
import sys
import tempfile


def check_items(items, where):
    for item in items:
        if item.get('separator'):
            continue
        if not item.get('label'):
            sys.exit(f'{where}: item without label')
        if 'items' in item:
            check_items(item['items'], where)
        elif not isinstance(item.get('target', 0), int):
            sys.exit(f'{where}: target of {item["label"]} must be an integer')


def dump(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


def main(source_dir, compiler, output, depfile):
    index_file = os.path.join(source_dir, 'index.json')
    with open(index_file, encoding='utf-8') as f:
        names = json.load(f)['apps']

    apps, ids, deps = [], {}, [index_file]
    with tempfile.TemporaryDirectory() as tmp:
        os.mkdir(os.path.join(tmp, 'apps'))
        for pos, name in enumerate(names):
            path = os.path.join(source_dir, 'apps', name)
            deps.append(path)
            with open(path, encoding='utf-8') as f:
                raw = json.load(f)
            if raw['format'] != 1 or raw['app'] + '.json' != name:
                sys.exit(f'{path}: bad format or app')
            for menu in raw['menus']:
                check_items(menu['items'], path)

            apps.append(raw['app'])
            for identifier in raw['identifiers']:
                ids.setdefault(identifier.lower(), pos)
            with open(os.path.join(tmp, 'apps', name), 'w', encoding='utf-8') as f:
                f.write(dump({
                    'app': raw['app'],
                    'blank': raw.get('blank', False),
                    'menus': raw['menus'],
                }))

        with open(os.path.join(tmp, 'index.json'), 'w', encoding='utf-8') as f:
            f.write(dump({'apps': apps, 'ids': ids}))

        xml = os.path.join(tmp, 'resource.xml')
        with open(xml, 'w', encoding='utf-8') as f:
            f.write('<gresources><gresource prefix="/org/gnome/shell/global-menu">\n')
            f.write('<file>index.json</file>\n')
            for name in names:
                f.write(f'<file>apps/{name}</file>\n')
            f.write('</gresource></gresources>\n')

        subprocess.run([compiler, f'--sourcedir={tmp}', f'--target={output}', xml],
                       check=True)

    with open(depfile, 'w', encoding='utf-8') as f:
        f.write(f'{output}: {" ".join(d.replace(" ", chr(92) + " ") for d in deps)}\n')


if __name__ == '__main__':
    main(*sys.argv[1:])
