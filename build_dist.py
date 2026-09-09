"""Bundle site/ into single-file builds.

  python build_dist.py

Outputs:
  dist/index.html     - complete standalone page (import map + inline modules + kit.glb as data URI).
                        Drop it on any static host (GitHub Pages, itch.io HTML, S3, ...).
  dist/artifact.html  - body-only variant for claude.ai Artifacts (no <html>/<head>/<body>, no import map:
                        three + addons come from jsDelivr's +esm bundles so bare specifiers are not needed).
"""
import base64, os, re, json

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, 'site')
DIST = os.path.join(ROOT, 'dist')
os.makedirs(DIST, exist_ok=True)

THREE = 'https://cdn.jsdelivr.net/npm/three@0.184.0'
ESM = {
    'three': THREE + '/+esm',
    'gltf': THREE + '/examples/jsm/loaders/GLTFLoader.js/+esm',
    'bgu': THREE + '/examples/jsm/utils/BufferGeometryUtils.js/+esm',
}
IMPORTMAP = {
    'three': THREE + '/build/three.module.js',
    'gltf': 'three/addons/loaders/GLTFLoader.js',
    'bgu': 'three/addons/utils/BufferGeometryUtils.js',
}

def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()

html = read(os.path.join(SITE, 'index.html'))
world = read(os.path.join(SITE, 'world.js'))
audio = read(os.path.join(SITE, 'audio.js'))
main = read(os.path.join(SITE, 'main.js'))
glb = open(os.path.join(SITE, 'assets', 'kit.glb'), 'rb').read()
glb_uri = 'data:model/gltf-binary;base64,' + base64.b64encode(glb).decode('ascii')

def strip_imports(src):
    return re.sub(r"^import .*?;\s*$", '', src, flags=re.M)

def exported_names(src):
    names = re.findall(r"^export (?:const|let|function|class) (\w+)", src, flags=re.M)
    return names

def as_iife(src, label):
    names = exported_names(src)
    body = strip_imports(src)
    body = re.sub(r"^export (?=(?:const|let|function|class) )", '', body, flags=re.M)
    return f"// ---------------- {label} ----------------\nconst {{ {', '.join(names)} }} = (() => {{\n{body}\nreturn {{ {', '.join(names)} }};\n}})();\n"

ADDON_IMPORTS = re.findall(r"^import (.+?) from 'three/addons/(.+?)';", main, flags=re.M)

def bundle(esm):
    lines = []
    if esm:
        lines.append(f"import * as THREE from '{THREE}/+esm';")
        for what, path in ADDON_IMPORTS:
            lines.append(f"import {what} from '{THREE}/examples/jsm/{path}/+esm';")
        # world.js imports (GLTFLoader, BufferGeometryUtils) unless main.js already pulled them in
        if not any(p == 'loaders/GLTFLoader.js' for _, p in ADDON_IMPORTS): lines.append(f"import {{ GLTFLoader }} from '{THREE}/examples/jsm/loaders/GLTFLoader.js/+esm';")
        if not any(p == 'utils/BufferGeometryUtils.js' for _, p in ADDON_IMPORTS): lines.append(f"import * as BufferGeometryUtils from '{THREE}/examples/jsm/utils/BufferGeometryUtils.js/+esm';")
    else:
        lines.append("import * as THREE from 'three';")
        for what, path in ADDON_IMPORTS:
            lines.append(f"import {what} from 'three/addons/{path}';")
        if not any(p == 'loaders/GLTFLoader.js' for _, p in ADDON_IMPORTS): lines.append("import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';")
        if not any(p == 'utils/BufferGeometryUtils.js' for _, p in ADDON_IMPORTS): lines.append("import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';")
    head = '\n'.join(lines) + f"\nconst KIT_URL = '{glb_uri}';\n"
    audio_names = exported_names(audio)
    audio_iife = "// ---------------- audio.js ----------------\nconst AUDIO = (() => {\n" + re.sub(r"^export (?=(?:const|let|function|class) )", '', strip_imports(audio), flags=re.M) + \
                 "\nreturn { " + ', '.join(audio_names) + " };\n})();\n"
    world_iife = as_iife(world, 'world.js')
    main_body = strip_imports(main).replace("'./assets/kit.glb?v=5'", 'KIT_URL')
    return head + audio_iife + world_iife + "// ---------------- main.js ----------------\n" + main_body

# ---- vendor three + addons so dist/index.html has no network dependency at all
import urllib.request
VENDOR = os.path.join(ROOT, 'vendor')
os.makedirs(VENDOR, exist_ok=True)
def fetch(url, name):
    path = os.path.join(VENDOR, name)
    if not os.path.exists(path):
        print('fetching', url)
        data = urllib.request.urlopen(url, timeout=60).read()
        with open(path, 'wb') as f:
            f.write(data)
    return read(path)
def data_url(js):
    return 'data:text/javascript;base64,' + base64.b64encode(js.encode('utf-8')).decode('ascii')
ADDON_PATHS = list(dict.fromkeys([path for _, path in ADDON_IMPORTS] + ['loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js']))
three_src = fetch(THREE + '/+esm', 'three.esm.js')   # the +esm bundle is self-contained; build/three.module.js imports ./three.core.js which a data: URL cannot resolve
assert not re.search(r"from\s*[\"']/npm/", three_src)
imports = { 'three': data_url(three_src) }
for path in ADDON_PATHS:
    src = fetch(THREE + '/examples/jsm/' + path + '/+esm', path.replace('/', '__') + '.esm.js')
    # jsDelivr's bundle imports three by absolute path; point it back at the bare specifier so the import map serves it inline
    src = src.replace('"/npm/three@0.184.0/+esm"', '"three"').replace("'/npm/three@0.184.0/+esm'", "'three'")
    assert not re.search(r"from\s*[\"']/npm/", src), 'unexpected external import in ' + path
    imports['three/addons/' + path] = data_url(src)
inline_importmap = '<script type="importmap">\n' + json.dumps({ 'imports': imports }) + '\n</script>\n'

# ---- full standalone page (inline import map → works offline)
im_block = re.search(r'<script type="importmap">.*?</script>\s*', html, flags=re.S).group(0)
full = html.replace(im_block, inline_importmap)
full = full.replace('<script type="module" src="./main.js"></script>', '<script type="module">\n' + bundle(False) + '\n</script>')
with open(os.path.join(DIST, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(full)

# ---- artifact page: body-only, +esm bundles, no import map
body = re.search(r'<body>(.*)</body>', html, flags=re.S).group(1)
body = body.replace(im_block, '')
body = body.replace('<script type="module" src="./main.js"></script>', '<script type="module">\n' + bundle(True) + '\n</script>')
head_bits = re.search(r'<head>(.*)</head>', html, flags=re.S).group(1)
title = re.search(r'<title>.*?</title>', head_bits).group(0)
style = re.search(r'<style>.*?</style>', head_bits, flags=re.S).group(0)
fonts = '\n'.join(re.findall(r'<link rel="preconnect"[^>]*>|<link href="https://fonts.googleapis.com[^>]*>', head_bits))
# the artifact host paints its own ground; make sure the page owns its colours and the canvas fills the viewport
style = style.replace('html, body { margin: 0; height: 100%;', 'html, body { margin: 0; height: 100%; min-height: 100vh;')
artifact = f"{title}\n{fonts}\n{style}\n{body}"
with open(os.path.join(DIST, 'artifact.html'), 'w', encoding='utf-8') as f:
    f.write(artifact)

print('dist/index.html   %.2f MB' % (os.path.getsize(os.path.join(DIST, 'index.html')) / 1e6))
print('dist/artifact.html %.2f MB' % (os.path.getsize(os.path.join(DIST, 'artifact.html')) / 1e6))
