// world.js — kit loading / baking, terrain, map generation, instancing, spatial grids.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

export const ISLAND_R = 108;      // shoreline
export const PLAY_R = 102;        // invisible wall
export const PLAZA_R = 10.5;
export const ROAD_W = 3.4;

// ---------------------------------------------------------------- seeded rng
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(ix, iy) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) & 0xffff) / 65535;
}
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
export function fbm(x, y) {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.03 + 7.1, y * 2.03 + 3.7) * 0.3 + vnoise(x * 4.1 + 13.3, y * 4.1 + 5.9) * 0.15;
}

// ---------------------------------------------------------------- districts
export const DISTRICTS = [
  { key: 'hearth', name: 'THE HEARTH', title: 'The Hearth', cx: 0, cz: 0,
    intro: 'Collect embers. Find the forge. Survive 10 minutes.', ground: [0x6f9c4e, 0x8aa35a], snowTint: 1 },
  { key: 'wildwood', name: 'THE WILDWOOD', title: 'The Wildwood', cx: -50, cz: -50,
    intro: 'Old oaks and older things. Wisps hunt in packs.', ground: [0x4d8a48, 0x3e7a44] },
  { key: 'mossfall', name: 'MOSSFALL RUINS', title: 'Mossfall Ruins', cx: 50, cz: -50,
    intro: 'Stone remembers. Spitters nest in the arches.', ground: [0x6f9a72, 0x7e8f78] },
  { key: 'cinder', name: 'CINDER BARROW', title: 'Cinder Barrow', cx: 50, cz: 50,
    intro: 'The ground still smoulders. The Ash Warden sleeps here.', ground: [0x5a4d48, 0x3f3634] },
  { key: 'silvermere', name: 'SILVERMERE SHORE', title: 'Silvermere Shore', cx: -50, cz: 50,
    intro: 'Reeds and mist. Crawlers move beneath the water.', ground: [0x7ba873, 0x9bb58a] },
];
export function districtAt(x, z) {
  if (x * x + z * z < 24 * 24) return DISTRICTS[0];
  if (z < 0) return x < 0 ? DISTRICTS[1] : DISTRICTS[2];
  return x < 0 ? DISTRICTS[4] : DISTRICTS[3];
}

// ---------------------------------------------------------------- roads (polylines from plaza to each outer district)
export const ROADS = [];
(function buildRoads() {
  for (let d = 1; d < 5; d++) {
    const D = DISTRICTS[d];
    const ang = Math.atan2(D.cz, D.cx);
    const pts = [];
    const n = 14;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const r = PLAZA_R - 1 + t * (Math.hypot(D.cx, D.cz) - PLAZA_R - 6);
      const wig = Math.sin(t * 5.3 + d) * 4.5 * Math.sin(t * Math.PI);
      const a = ang + wig / Math.max(r, 1);
      pts.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    ROADS.push(pts);
  }
  // short ring road around the plaza
  const ring = [];
  for (let i = 0; i <= 28; i++) { const a = i / 28 * Math.PI * 2; ring.push([Math.cos(a) * 9.4, Math.sin(a) * 9.4]); }
  ROADS.push(ring);
})();
function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return Math.sqrt(cx * cx + cz * cz);
}
export function roadDist(x, z) {
  let best = 1e9;
  for (const pts of ROADS) {
    // cheap reject: bounding radius per road
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = segDist(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------- spatial grid
export class Grid {
  constructor(cell = 6) { this.cell = cell; this.map = new Map(); }
  key(ix, iz) { return ix * 73856 + iz; }
  clear() { this.map.clear(); }
  insert(o) {
    const ix = Math.floor(o.x / this.cell), iz = Math.floor(o.z / this.cell);
    const k = this.key(ix, iz);
    let b = this.map.get(k);
    if (!b) { b = []; this.map.set(k, b); }
    b.push(o);
  }
  query(x, z, r, out) {
    out.length = 0;
    const c = this.cell;
    const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
    const z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const b = this.map.get(this.key(ix, iz));
      if (b) for (let i = 0; i < b.length; i++) out.push(b[i]);
    }
    return out;
  }
}

// ---------------------------------------------------------------- kit loading + baking
const GLOW_MATS = new Set(['WindowGlass', 'Fire', 'Lantern', 'EnemyEye', 'EmberCore', 'HotMetal', 'Crystal', 'ShardCrystal', 'PlayerLamp']);
const _m = new THREE.Matrix4();

function bakeGeo(mesh, inv, useEmissive) {
  const g = mesh.geometry.clone();
  g.applyMatrix4(_m.multiplyMatrices(inv, mesh.matrixWorld));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const c0 = useEmissive ? (mesh.material.emissive || mesh.material.color) : mesh.material.color;
  // body colours: pull saturation back a little and warm them, the raw kit colours read harsh under direct light
  let c = c0;
  if (!useEmissive) { const l = 0.2126 * c0.r + 0.7152 * c0.g + 0.0722 * c0.b; c = { r: (l + (c0.r - l) * 0.94) * 1.02, g: (l + (c0.g - l) * 0.94) * 1.0, b: (l + (c0.b - l) * 0.94) * 0.97 }; }
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g.index ? g.toNonIndexed() : g;
}
function mergeOrNull(list) {
  if (!list.length) return null;
  const g = BufferGeometryUtils.mergeGeometries(list, false);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export class Kit {
  constructor() { this.items = {}; this.rigs = {}; }
  async load(url, onProgress) {
    const loader = new GLTFLoader();
    let gltf;
    if (url.startsWith('data:')) {   // single-file builds: decode inline base64 ourselves, no fetch involved
      const b64 = url.slice(url.indexOf(',') + 1);
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      if (onProgress) onProgress({ loaded: 1, total: 1 });
      gltf = await loader.parseAsync(buf.buffer, '');
    } else gltf = await loader.loadAsync(url, onProgress);
    const root = gltf.scene;
    root.updateMatrixWorld(true);
    this.clips = gltf.animations || [];
    for (const node of root.children) {
      if (!node.name.startsWith('Kit_')) continue;
      const name = node.name.slice(4);
      const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
      const body = [], snow = [], glow = {};
      node.traverse((m) => {
        if (!m.isMesh) return;
        if (/^LPCage/.test(m.name)) return;   // the iron cage fully enclosed the lantern glow
        const mn = m.material.name || '';
        const isGlow = GLOW_MATS.has(mn) || /^(EmberCore|EnemyEye|Crystal|HotMetal|Fire|PlayerLamp)_/.test(m.name);
        if (isGlow) { (glow[mn] = glow[mn] || []).push(bakeGeo(m, inv, true)); }
        else if (m.name.startsWith('Snow_')) snow.push(bakeGeo(m, inv, false));
        else body.push(bakeGeo(m, inv, false));
      });
      const item = { name, body: mergeOrNull(body), snow: mergeOrNull(snow), glow: {} };
      for (const k of Object.keys(glow)) item.glow[k] = mergeOrNull(glow[k]);
      const bb = new THREE.Box3();
      if (item.body) bb.union(item.body.boundingBox);
      for (const k of Object.keys(item.glow)) bb.union(item.glow[k].boundingBox);
      item.bbox = bb;
      item.radius = Math.max(bb.max.x, -bb.min.x, bb.max.z, -bb.min.z) || 0.5;
      item.height = bb.max.y;
      this.items[name] = item;
      if (name === 'Player' || name === 'Warden') {
        // keep the hierarchy as a rig template
        node.position.set(0, 0, 0);
        node.updateMatrixWorld(true);
        this.rigs[name] = node;
      }
    }
    return this;
  }
}

// ---------------------------------------------------------------- shared materials
export const MATS = {
  body: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.0, envMapIntensity: 0.5 }),
  snow: new THREE.MeshStandardMaterial({ color: 0xf4f7ff, roughness: 0.95, transparent: true, opacity: 0, depthWrite: true }),
  glow: {},
};
// trees: canopy dithers away around the player so the hero never vanishes under a crown
export const treeUniforms = { uPlayer: { value: new THREE.Vector3() } };
MATS.tree = MATS.body.clone();
MATS.tree.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, treeUniforms);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vWpT;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWpT = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nuniform vec3 uPlayer; varying vec3 vWpT;')
    .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
{
  float d = distance(vWpT.xz, uPlayer.xz);
  float f = smoothstep(2.2, 4.8, d);
  f = mix(1.0, f, smoothstep(0.9, 1.6, vWpT.y - uPlayer.y));
  vec2 px = floor(gl_FragCoord.xy);
  float dith = fract(dot(px, vec2(0.1716, 0.3819)) + fract(px.x * 0.25) * 0.5 + fract(px.y * 0.5) * 0.25);
  if (dith > f) discard;
}`);
};
MATS.tree.customProgramCacheKey = () => 'tree-fade';
export function glowMat(name) {
  if (!MATS.glow[name]) {
    MATS.glow[name] = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
    MATS.glow[name].baseIntensity = 1;
  }
  return MATS.glow[name];
}
export function setGlow(name, k) {
  const m = glowMat(name);
  m.color.setScalar(k);
}

// ---------------------------------------------------------------- static instancing
export class InstanceSet {
  /** one kit item, N static transforms; only the ones near the camera focus are uploaded (see rebuild) */
  constructor(kit, name, transforms, scene, opts = {}) {
    const item = kit.items[name];
    if (!item) throw new Error('kit item missing: ' + name);
    this.meshes = [];
    this.all = transforms;
    this.tinted = !!opts.tint;
    this.visible = 0;
    const n = transforms.length;
    if (!n) return;
    const mk = (geo, mat, cast, recv, tint) => {
      const im = new THREE.InstancedMesh(geo, mat, n);
      im.castShadow = cast; im.receiveShadow = recv;
      im.frustumCulled = false;
      if (tint) im.setColorAt(0, WHITE);   // allocates instanceColor
      im.count = 0;
      im.name = 'IS_' + name;
      scene.add(im);
      this.meshes.push(im);
      return im;
    };
    if (item.body) mk(item.body, opts.material || MATS.body, opts.cast !== false, true, opts.tint);
    if (item.snow) { const s = mk(item.snow, MATS.snow, false, true, false); s.isSnow = true; }
    for (const k of Object.keys(item.glow)) mk(item.glow[k], glowMat(k), false, false, false);
    this.rebuild(0, 0, 1e9);
  }
  rebuild(cx, cz, R) {
    const r2 = R * R;
    let n = 0;
    const all = this.all;
    for (let i = 0; i < all.length; i++) {
      const t = all[i];
      const dx = t.x - cx, dz = t.z - cz;
      if (dx * dx + dz * dz > r2) continue;
      for (const im of this.meshes) { im.setMatrixAt(n, t.m); if (im.instanceColor) im.setColorAt(n, t.tint || WHITE); }
      n++;
    }
    this.visible = n;
    for (const im of this.meshes) { im.count = n; im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true; }
  }
}
const WHITE = new THREE.Color(1, 1, 1);

// ---------------------------------------------------------------- dynamic instancing (enemies, pickups, projectiles)
const _om = new THREE.Matrix4();
export class DynSet {
  constructor(kit, name, max, scene, opts = {}) {
    const item = kit.items[name];
    this.max = max; this.count = 0;
    this.meshes = [];
    const mk = (geo, mat, cast) => {
      const im = new THREE.InstancedMesh(geo, mat, max);
      im.castShadow = cast; im.receiveShadow = false; im.frustumCulled = false;
      im.count = 0;
      scene.add(im);
      this.meshes.push(im);
      return im;
    };
    this.body = item.body ? mk(item.body, opts.bodyMat || MATS.body.clone(), opts.cast !== false) : null;
    if (this.body) { this.body.material.vertexColors = true; }
    this.outline = null;
    if (this.body && opts.outline) {
      this.outline = mk(item.body, new THREE.MeshBasicMaterial({ color: 0x0b0810, side: THREE.BackSide, toneMapped: false }), false);
      const c = item.body.boundingBox.getCenter(new THREE.Vector3());
      const k = opts.outline;
      this.outlineLocal = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
    }
    const glows = Object.keys(item.glow).map((k) => item.glow[k]);
    this.glow = glows.length ? mk(mergeOrNull(glows), opts.glowMat || glowMat(opts.glowKey || name), false) : null;
    this.item = item;
  }
  begin() { this.count = 0; }
  push(m, color, glowColor) {
    if (this.count >= this.max) return;
    const i = this.count++;
    if (this.body) { this.body.setMatrixAt(i, m); if (color) this.body.setColorAt(i, color); }
    if (this.outline) { _om.multiplyMatrices(m, this.outlineLocal); this.outline.setMatrixAt(i, _om); }
    if (this.glow) { this.glow.setMatrixAt(i, m); if (glowColor) this.glow.setColorAt(i, glowColor); }
  }
  end() {
    if (this.body) { this.body.count = this.count; this.body.instanceMatrix.needsUpdate = true; if (this.body.instanceColor) this.body.instanceColor.needsUpdate = true; }
    if (this.outline) { this.outline.count = this.count; this.outline.instanceMatrix.needsUpdate = true; }
    if (this.glow) { this.glow.count = this.count; this.glow.instanceMatrix.needsUpdate = true; if (this.glow.instanceColor) this.glow.instanceColor.needsUpdate = true; }
  }
}

// ---------------------------------------------------------------- ground
export function groundColor(x, z, out) {
  const r = Math.hypot(x, z);
  const n = fbm(x * 0.06 + 3, z * 0.06 + 9);
  const n2 = vnoise(x * 0.35, z * 0.35);
  if (r > ISLAND_R + 1.5) { // water
    const deep = Math.min(1, (r - ISLAND_R) / 18);
    out.setHex(0x3f7d9c).lerp(new THREE.Color(0x244a66), deep);
    out.offsetHSL(0, 0, (n2 - 0.5) * 0.04);
    return 'water';
  }
  if (r > ISLAND_R - 2.5) { out.setHex(0xb9a98a).offsetHSL(0, 0, (n2 - 0.5) * 0.1); return 'shore'; }
  // district blend (soft between quadrants)
  const D = districtAt(x, z);
  const a = new THREE.Color(D.ground[0]), b = new THREE.Color(D.ground[1]);
  out.copy(a).lerp(b, n);
  // soften quadrant borders
  const edge = Math.min(Math.abs(x), Math.abs(z));
  if (r > 24 && edge < 8) {
    const other = x < 0 && z < 0 ? DISTRICTS[1] : (x >= 0 && z < 0 ? DISTRICTS[2] : (x >= 0 ? DISTRICTS[3] : DISTRICTS[4]));
    const nb = districtAt(Math.abs(x) < Math.abs(z) ? -x : x, Math.abs(x) < Math.abs(z) ? z : -z);
    const c2 = new THREE.Color(nb.ground[0]).lerp(new THREE.Color(nb.ground[1]), n);
    out.lerp(c2, 0.5 * (1 - edge / 8));
    void other;
  }
  if (r < 30) { // village ring blends into hearth colours
    const t = Math.max(0, Math.min(1, (r - 22) / 8));
    out.lerp(new THREE.Color(0x7a9d52).lerp(new THREE.Color(0x98a05c), n), 1 - t);
  }
  out.offsetHSL(0, 0, (n2 - 0.5) * 0.08);
  const rd = roadDist(x, z);
  const plaza = r < PLAZA_R;
  if (plaza || rd < ROAD_W * 0.5) {
    const stone = new THREE.Color(0x9a8f86).offsetHSL(0, 0, (n2 - 0.5) * 0.14);
    const k = plaza ? Math.min(1, (PLAZA_R - r) / 1.2 + 0.5) : Math.min(1, (ROAD_W * 0.5 - rd) / 0.9 + 0.5);
    out.lerp(stone, Math.max(0, Math.min(1, k)));
    return 'road';
  }
  if (rd < ROAD_W * 0.5 + 1.2) { out.lerp(new THREE.Color(0x8a7d58), 0.5 * (1 - (rd - ROAD_W * 0.5) / 1.2)); }
  return D.key;
}

export function buildGround(scene) {
  const SIZE = 300, SEG = 200;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const snowMask = new Float32Array(pos.count);
  const roadMask = new Float32Array(pos.count);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const kind = groundColor(x, z, c);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    const r = Math.hypot(x, z);
    let y = 0;
    if (r > ISLAND_R) y = -1.2 - Math.min(1, (r - ISLAND_R) / 6) * 0.8;
    else if (r > ISLAND_R - 2.5) y = -((r - (ISLAND_R - 2.5)) / 2.5) * 1.2;
    else y = (fbm(x * 0.05, z * 0.05) - 0.5) * 0.0; // flat playfield
    pos.setY(i, y);
    snowMask[i] = kind === 'water' ? 0 : (kind === 'road' ? 0.55 : 1);
    roadMask[i] = kind === 'road' ? 1 : 0;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('snowMask', new THREE.BufferAttribute(snowMask, 1));
  geo.setAttribute('roadMask', new THREE.BufferAttribute(roadMask, 1));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  const uniforms = { uTime: { value: 0 }, uSnow: { value: 0 }, uCloud: { value: 0.35 }, uWet: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float snowMask;\nattribute float roadMask;\nvarying float vSnowMask;\nvarying float vRoad;\nvarying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSnowMask = snowMask;\nvRoad = roadMask;\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uTime; uniform float uSnow; uniform float uCloud; uniform float uWet;
varying float vSnowMask; varying float vRoad; varying vec3 vWp;
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 h22(vec2 p){ return vec2(h2(p), h2(p + 19.7)); }
// flagstones: distance to nearest voronoi edge (F2 - F1) + per-cell shade
vec2 stones(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  float d1 = 9.0, d2 = 9.0; float shade = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 o = h22(i + g) * 0.8 + 0.1;
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; shade = h2(i + g + 3.1); } else if (d < d2) { d2 = d; }
  }
  return vec2(d2 - d1, shade);
}
float vn(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec2 p = vWp.xz * 0.045 + vec2(uTime * 0.012, uTime * 0.007);
  float n = vn(p) * 0.6 + vn(p * 2.3 + 4.0) * 0.4;
  float cs = 1.0 - uCloud * smoothstep(0.42, 0.72, n);
  float sn = uSnow * vSnowMask * smoothstep(0.25, 0.7, vn(vWp.xz * 0.5) * 0.5 + 0.5 * uSnow);
  vec3 snowCol = vec3(0.93, 0.95, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, sn);
  diffuseColor.rgb *= cs;
  diffuseColor.rgb *= 0.9 + 0.2 * vn(vWp.xz * 1.9) * (1.0 - sn * 0.6);
  // mottled dirt / grass patches
  float mot = vn(vWp.xz * 0.6 + 40.0);
  diffuseColor.rgb *= 1.0 - 0.14 * smoothstep(0.55, 0.85, mot) * (1.0 - vRoad) * (1.0 - sn);
  // flagstones on roads and the plaza
  if (vRoad > 0.02) {
    vec2 st = stones(vWp.xz * 1.9);
    float grout = smoothstep(0.03, 0.16, st.x);
    vec3 stoneCol = diffuseColor.rgb * (0.86 + 0.22 * st.y);
    stoneCol *= mix(0.72, 1.0, grout);
    diffuseColor.rgb = mix(diffuseColor.rgb, stoneCol, vRoad * (1.0 - sn * 0.7));
  }
  diffuseColor.rgb *= 1.0 - uWet * 0.25;
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.35, uWet);');
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'Ground';
  scene.add(mesh);
  return { mesh, uniforms };
}

// ---------------------------------------------------------------- map generation
const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
export function makeTransform(x, z, rotY = 0, scale = 1, y = 0) {
  _p.set(x, y, z); _q.setFromAxisAngle(_up, rotY); _s.setScalar(scale);
  return { m: new THREE.Matrix4().compose(_p, _q, _s), x, z, rotY, scale };
}
export function faceToward(x, z, tx, tz) { return Math.atan2(tx - x, tz - z); }

export function generateMap(kit, scene, seed = 7) {
  const rng = mulberry32(seed);
  const placements = {};       // kitName -> transforms[]
  const obstacles = new Grid(6);
  const landmarks = [];        // for the minimap
  const add = (name, x, z, rotY = 0, scale = 1, opts = {}) => {
    (placements[name] = placements[name] || []).push(Object.assign(makeTransform(x, z, rotY, scale), { tint: opts.tint }));
    const item = kit.items[name];
    if (opts.solid !== false) {
      const r = (opts.r != null ? opts.r : item.radius * 0.85) * scale;
      if (opts.rect) { // buildings: approximate with several circles along the long axis
        const { w, d } = opts.rect;
        const n = Math.max(1, Math.round(Math.max(w, d) / Math.min(w, d)));
        const step = (Math.max(w, d) - Math.min(w, d)) / Math.max(1, n - 1);
        for (let i = 0; i < n; i++) {
          const off = -(Math.max(w, d) - Math.min(w, d)) / 2 + i * step;
          const lx = w >= d ? off : 0, lz = w >= d ? 0 : off;
          const wx = x + lx * Math.cos(rotY) + lz * Math.sin(rotY);
          const wz = z - lx * Math.sin(rotY) + lz * Math.cos(rotY);
          obstacles.insert({ x: wx, z: wz, r: Math.min(w, d) / 2 * scale + 0.2 });
        }
      } else obstacles.insert({ x, z, r });
    }
    if (opts.mark) landmarks.push({ x, z, kind: opts.mark });
  };
  const rad = (deg) => deg * Math.PI / 180;

  // ---- village
  add('Well', 0, 0, 0, 1, { r: 1.1, mark: 'well' });
  const forgePos = { x: -8.5, z: -6.5 };
  add('Forge', forgePos.x, forgePos.z, faceToward(forgePos.x, forgePos.z, 0, 0), 1, { rect: { w: 4.2, d: 3.2 }, mark: 'forge' });
  add('House_A', 10.5, -8.5, faceToward(10.5, -8.5, 0, 0), 1, { rect: { w: 3.6, d: 3.0 }, mark: 'house' });
  add('House_B', -1.5, -14.5, faceToward(-1.5, -14.5, 0, 0), 1, { rect: { w: 3.2, d: 3.2 }, mark: 'house' });
  add('House_C', 13.5, 5.5, faceToward(13.5, 5.5, 0, 0), 1, { rect: { w: 5.8, d: 2.8 }, mark: 'house' });
  add('Tower', -14.5, 3.5, faceToward(-14.5, 3.5, 0, 0), 1, { r: 1.5, mark: 'tower' });
  add('House_A', 3.5, 14.5, faceToward(3.5, 14.5, 0, 0), 1, { rect: { w: 3.6, d: 3.0 }, mark: 'house' });
  add('House_B', -11.5, 12.5, faceToward(-11.5, 12.5, 0, 0), 1, { rect: { w: 3.2, d: 3.2 }, mark: 'house' });
  add('House_C', 14.5, -16, faceToward(14.5, -16, 0, 0), 1, { rect: { w: 5.8, d: 2.8 }, mark: 'house' });
  for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.3; add('LanternPost', Math.cos(a) * 8.6, Math.sin(a) * 8.6, -a, 1, { r: 0.25 }); }
  add('Campfire', 5.5, 3.5, 0, 1, { r: 0.7 });
  add('Cart', 7.5, -3.5, 0.6, 1, { r: 0.9 });
  add('Crate', 12.5, -6.2, 0.2); add('Crate', 13.1, -5.6, 0.9); add('Barrel', 11.9, -5.4, 0);
  add('Barrel', -10.8, -4.2, 0); add('Barrel', -11.4, -3.6, 0); add('Logpile', -6.2, -9.2, 0.3);
  add('Hay', 15.5, 8.5, 0.3, 1, { r: 0.6 }); add('Crate', -13.5, 14.5, 0.4); add('Barrel', -12.8, 15.1, 0);
  add('Signpost', 7.0, 7.0, rad(30), 1, { r: 0.2 }); add('Signpost', -7.0, -7.4, rad(-140), 1, { r: 0.2 });
  // fences around the plaza gaps
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2 + 0.1;
    if (Math.abs(((a * 4 / Math.PI) + 8.5) % 2 - 1) < 0.4) continue;   // leave gaps for the four diagonal roads
    const r = 17.5;
    add('Fence', Math.cos(a) * r, Math.sin(a) * r, -a + Math.PI / 2, 1, { solid: false });
  }
  for (let i = 0; i < 14; i++) { const a = rng() * Math.PI * 2, r = 5 + rng() * 15; if (roadDist(Math.cos(a) * r, Math.sin(a) * r) > 1.8) add('Tuft', Math.cos(a) * r, Math.sin(a) * r, rng() * 6, 0.9 + rng() * 0.4, { solid: false }); }

  // ---- district landmarks
  const shrine = (D) => { add('Shrine', D.cx, D.cz, 0, 1, { r: 1.2, mark: 'shrine' }); };
  // Wildwood: ring of big oaks + campfire clearing
  { const D = DISTRICTS[1]; shrine(D);
    for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; add(i % 3 ? 'Oak' : 'Pine', D.cx + Math.cos(a) * 8, D.cz + Math.sin(a) * 8, rng() * 6, 1.3 + rng() * 0.3, { r: 0.7 }); }
    add('Campfire', D.cx + 3, D.cz - 2, 0, 1, { r: 0.7 }); add('Logpile', D.cx - 3, D.cz + 2.5, 0.4); add('Stump', D.cx + 4, D.cz + 3, 0.2); }
  // Mossfall: arches & columns
  { const D = DISTRICTS[2]; shrine(D);
    add('RuinArch', D.cx - 7, D.cz, rad(20), 1.2, { rect: { w: 3.2, d: 0.8 } });
    add('RuinArch', D.cx + 7, D.cz + 2, rad(-30), 1.1, { rect: { w: 3.2, d: 0.8 } });
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; add(i % 2 ? 'Column' : 'BrokenColumn', D.cx + Math.cos(a) * 5.5, D.cz + Math.sin(a) * 5.5, a, 1, { r: 0.6 }); }
    add('RuinWall', D.cx, D.cz - 9, rad(10), 1.2, { rect: { w: 3.6, d: 0.6 } }); add('RuinWall', D.cx + 4, D.cz + 9, rad(-50), 1, { rect: { w: 3.0, d: 0.5 } }); }
  // Cinder Barrow: dead trees + ember rocks, boss lair
  { const D = DISTRICTS[3]; shrine(D);
    for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; add('DeadTree', D.cx + Math.cos(a) * 9, D.cz + Math.sin(a) * 9, rng() * 6, 1.2 + rng() * 0.5, { r: 0.4 }); }
    for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 + 0.5; add('EmberRock', D.cx + Math.cos(a) * 4.5, D.cz + Math.sin(a) * 4.5, rng() * 6, 1.3, { r: 0.7 }); }
    add('Boulder', D.cx - 12, D.cz + 6, 0.4, 1.1, { r: 1.9 }); add('Boulder', D.cx + 11, D.cz - 8, 2.4, 0.9, { r: 1.6 }); }
  // Silvermere: reeds, boulders, a broken jetty of fence
  { const D = DISTRICTS[4]; shrine(D);
    for (let i = 0; i < 14; i++) { const a = rng() * Math.PI * 2, r = 4 + rng() * 8; add('Reed', D.cx + Math.cos(a) * r, D.cz + Math.sin(a) * r, rng() * 6, 1 + rng() * 0.4, { solid: false }); }
    add('Boulder', D.cx + 8, D.cz - 5, 1.1, 1.2, { r: 2 }); add('Rock_L', D.cx - 7, D.cz + 6, 0.5, 1.3, { r: 1.2 });
    for (let i = 0; i < 4; i++) add('Fence', D.cx - 12 + i * 2.3, D.cz + 11, 0, 1, { solid: false }); }

  // ---- scatter
  const tables = {
    hearth: [['Oak', 3], ['Oak2', 3], ['Bush', 5], ['Tuft', 14], ['Rock_S', 3], ['Mushroom', 1], ['Pine', 1]],
    wildwood: [['Oak', 9], ['Oak2', 6], ['Pine', 8], ['Bush', 5], ['Tuft', 10], ['Rock_S', 2], ['Mushroom', 3], ['Stump', 1], ['Rock_L', 1]],
    mossfall: [['Oak2', 3], ['Column', 1], ['BrokenColumn', 2], ['RuinWall', 1], ['Rock_S', 4], ['Rock_L', 2], ['Boulder', 1], ['Bush', 4], ['Tuft', 8], ['Mushroom', 3], ['Pine', 2]],
    cinder: [['DeadTree', 8], ['EmberRock', 4], ['Rock_S', 5], ['Rock_L', 3], ['Boulder', 1], ['Tuft', 3], ['Stump', 2], ['Pine', 1]],
    silvermere: [['Reed', 9], ['Oak2', 3], ['Oak', 2], ['Rock_S', 4], ['Rock_L', 2], ['Bush', 3], ['Tuft', 8], ['Mushroom', 2], ['Pine', 2]],
  };
  const density = { hearth: 0.5, wildwood: 1.35, mossfall: 0.85, cinder: 0.95, silvermere: 0.95 };
  const solidKinds = new Set(['Oak', 'Oak2', 'Pine', 'DeadTree', 'Rock_L', 'Boulder', 'Column', 'BrokenColumn', 'RuinWall', 'EmberRock', 'Stump', 'Rock_S']);
  const tints = { wildwood: null, hearth: null, mossfall: new THREE.Color(0.85, 1.0, 0.9), cinder: new THREE.Color(0.75, 0.68, 0.7), silvermere: new THREE.Color(0.9, 1.0, 1.05) };
  const pick = (tab) => { let s = 0; for (const t of tab) s += t[1]; let r = rng() * s; for (const t of tab) { r -= t[1]; if (r <= 0) return t[0]; } return tab[0][0]; };
  const tmp = [];
  let placed = 0;
  for (let i = 0; i < 26000 && placed < 9000; i++) {
    const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * (ISLAND_R - 3);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (r < PLAZA_R + 1.5) continue;
    const D = districtAt(x, z);
    if (rng() > density[D.key] * 0.75) continue;
    const rd = roadDist(x, z);
    const name = pick(tables[D.key]);
    const solid = solidKinds.has(name);
    if (rd < ROAD_W * 0.5 + (solid ? 1.4 : 0.3)) continue;
    // keep away from placed obstacles
    obstacles.query(x, z, 4, tmp);
    let ok = true;
    const myR = kit.items[name].radius;
    for (const o of tmp) { const d = Math.hypot(o.x - x, o.z - z); if (d < o.r + (solid ? myR * 0.8 : 0.3) + 0.4) { ok = false; break; } }
    if (!ok) continue;
    if (r < 20 && solid && rng() < 0.7) continue;      // keep the village open
    const sc = 0.8 + rng() * 0.5;
    add(name, x, z, rng() * Math.PI * 2, sc, { solid, r: solid ? myR * 0.7 : 0, tint: tints[D.key] });
    placed++;
  }

  // ---- upload instanced meshes
  const sets = {};
  const TREES = new Set(['Oak', 'Oak2', 'Pine', 'DeadTree']);
  for (const name of Object.keys(placements)) sets[name] = new InstanceSet(kit, name, placements[name], scene, { tint: true, cast: !['Tuft', 'Reed'].includes(name), material: TREES.has(name) ? MATS.tree : null });
  return { placements, obstacles, landmarks, sets, forgePos, placedCount: placed };
}

// resolve a circle against static obstacles (in place)
const _near = [];
export function collideStatic(obj, obstacles, radius) {
  obstacles.query(obj.x, obj.z, radius + 3, _near);
  for (let i = 0; i < _near.length; i++) {
    const o = _near[i];
    const dx = obj.x - o.x, dz = obj.z - o.z;
    const d2 = dx * dx + dz * dz;
    const rr = o.r + radius;
    if (d2 < rr * rr && d2 > 1e-6) {
      const d = Math.sqrt(d2);
      const push = (rr - d) / d;
      obj.x += dx * push; obj.z += dz * push;
    }
  }
  const r = Math.hypot(obj.x, obj.z);
  if (r > PLAY_R) { obj.x *= PLAY_R / r; obj.z *= PLAY_R / r; }
}
