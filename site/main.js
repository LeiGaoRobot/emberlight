// main.js — Emberlight: a survivors-like in a valley with its own weather.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import { Kit, DynSet, buildGround, generateMap, districtAt, DISTRICTS, ROADS, ISLAND_R, PLAY_R, collideStatic, Grid, setGlow, glowMat, MATS, treeUniforms, mulberry32, vnoise } from './world.js?v=32';
import * as AUDIO from './audio.js?v=32';

const $ = (s) => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const pad2 = (n) => String(n).padStart(2, '0');
const RUN_LENGTH = 600;      // 10 minutes
const DIFFS = {
  calm:     { name: 'Calm',     zh: '静谧', dmg: 0.7,  spawn: 0.8,  hp: 0.9,  speed: 0.95, elite: 1.3, bossAt: 480, phase2: false, desc: 'Enemies hit 30% softer, the Warden never rages.', zhDesc: '敌人伤害 −30%,守卫没有二阶段。' },
  standard: { name: 'Standard', zh: '标准', dmg: 1.0,  spawn: 1.0,  hp: 1.0,  speed: 1.0,  elite: 1.0, bossAt: 480, phase2: true,  desc: 'The valley as intended. Warden at eight minutes.', zhDesc: '标准体验,守卫八分钟登场。' },
  ash:      { name: 'Ash',      zh: '灰烬', dmg: 1.6,  spawn: 2.1,  hp: 1.35, speed: 1.2,  elite: 0.55, bossAt: 360, phase2: true,  desc: 'Twice the creatures, faster, 60% harder hits, Warden at six.', zhDesc: '刷怪翻倍、更快、伤害 +60%,守卫六分钟登场。' },
};
const DIFF = () => DIFFS[SET.difficulty] || DIFFS.standard;
const BOSS_AT_FN = () => DIFF().bossAt;

// =====================================================================
// renderer / scene / camera
// =====================================================================
window.__emberBooted = true;
const canvas = $('#c');
if (window.__emberNoWebGL) throw new Error('WebGL2 unavailable');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }); }
catch (err) { window.__emberFatal('Could not start the renderer', 'WebGL refused to start: ' + err.message + '. Close other GPU-heavy tabs and reload.'); throw err; }
canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); window.__emberLog('gpu', 'context lost'); window.__emberFatal('The graphics context was lost', 'The browser dropped the WebGL context (usually a driver reset or memory pressure). Reload to continue. / 显卡上下文丢失(通常是驱动重置或显存不足),请重载。'); });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.info.autoReset = false;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc9d6e2, 40, 120);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.35;

// ---- post-processing: render → GTAO (high quality only) → bloom → grade/vignette → output
let composer = null, gtaoPass = null, bloomPass = null, gradePass = null;
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uVignette: { value: 0.32 }, uSat: { value: 1.0 }, uTint: { value: new THREE.Vector3(1.03, 1.0, 0.96) }, uLift: { value: 0.004 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uTime, uVignette, uSat, uLift; uniform vec3 uTint; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSat) * uTint + uLift;
      col = max(vec3(0.0), (col - 0.18) * 1.07 + 0.18);
      float d = distance(vUv, vec2(0.5, 0.5));
      col *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      col += (h(vUv * 1400.0 + fract(uTime)) - 0.5) * 0.012;
      gl_FragColor = vec4(col, c.a);
    }`,
};
function buildComposer() {
  const w = window.innerWidth, h = window.innerHeight;
  const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  gtaoPass = new GTAOPass(scene, camera, w, h);
  gtaoPass.output = GTAOPass.OUTPUT.Default;
  gtaoPass.blendIntensity = 0.85;
  gtaoPass.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.2, thickness: 1.2, scale: 1.1, samples: 12, distanceFallOff: 1.0, screenSpaceRadius: false });
  gtaoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, radiusExponent: 1, rings: 2, samples: 16 });
  composer.addPass(gtaoPass);
  bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 0.42, 0.55, 0.95);
  composer.addPass(bloomPass);
  gradePass = new ShaderPass(GradeShader);
  composer.addPass(gradePass);
  composer.addPass(new OutputPass());
}
function resizeComposer() { if (composer) { composer.setSize(window.innerWidth, window.innerHeight); } }
const camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.5, 260);
const CAM_DIR = new THREE.Vector3(0.22, 1.18, 0.72).normalize();
let camDist = 31;
const camShake = { t: 0, amp: 0 };

const hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 0.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { near: 5, far: 120, left: -30, right: 30, top: 30, bottom: -30 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
sun.shadow.radius = 3;
scene.add(sun); scene.add(sun.target);
const lampLight = new THREE.PointLight(0xffc27a, 0, 12, 1.6);
scene.add(lampLight);
const forgeLight = new THREE.PointLight(0xff7a2a, 0, 14, 1.5);
scene.add(forgeLight);
const novaLight = new THREE.PointLight(0xffb060, 0, 30, 1.2);
scene.add(novaLight);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizeComposer();
});

// =====================================================================
// game data
// =====================================================================
const WEAPONS = [
  { key: 'crescent', name: 'EMBER CRESCENT', rate: 0.55, dmg: 15, range: 3.0, arc: 2.3, type: 'melee' },
  { key: 'bolt', name: 'CINDER BOLT', rate: 0.34, dmg: 8, range: 17, type: 'ranged', speed: 24, pierce: 1 },
  { key: 'lantern', name: 'ASH LANTERNS', rate: 0.5, dmg: 9, radius: 2.7, type: 'orbit', count: 2 },
  { key: 'bow', name: 'ASH LONGBOW', rate: 0.95, dmg: 26, range: 24, type: 'ranged', speed: 34, pierce: 3, heavyBolt: true },
  { key: 'chain', name: 'EMBER CHAIN', rate: 0.2, dmg: 6.5, range: 2.1, arc: 1.25, type: 'melee' },
];
const ETYPES = {
  wisp:    { hp: 14,  dmg: 4,  speed: 6.0, r: 0.35, xp: 1, kit: 'Wisp',    shards: 0.12, mass: 0.6 },
  cinder:  { hp: 34,  dmg: 7, speed: 3.3, r: 0.5,  xp: 2, kit: 'Cinder',  shards: 0.3,  mass: 1.0 },
  crawler: { hp: 26,  dmg: 6,  speed: 4.4, r: 0.5,  xp: 2, kit: 'Crawler', shards: 0.25, mass: 0.8, lunge: true },
  spitter: { hp: 46,  dmg: 6,  speed: 2.6, r: 0.55, xp: 3, kit: 'Spitter', shards: 0.5,  mass: 1.2, ranged: true },
  brute:   { hp: 300, dmg: 16, speed: 2.5, r: 0.95, xp: 12, kit: 'Brute',  shards: 5,    mass: 4.0, elite: true },
};
const TALENTS = [
  { key: 'still', name: 'Still burning', max: 4, desc: 'Gain 20 max health. Recover 35 health.', apply: (p) => { p.maxHp += 20; p.hp = Math.min(p.maxHp, p.hp + 35); } },
  { key: 'soles', name: 'Wildfire soles', max: 1, desc: 'Dashing leaves a trail of burning embers.', apply: (p) => { p.fireTrail = true; } },
  { key: 'wide', name: 'Wide awake', max: 4, desc: 'Increase attack and nova radius by 15%.', apply: (p) => { p.areaMult *= 1.15; } },
  { key: 'keen', name: 'Keen edge', max: 5, desc: 'Increase damage by 12%.', apply: (p) => { p.dmgTalent *= 1.12; } },
  { key: 'quick', name: 'Quick hands', max: 4, desc: 'Attack 12% faster.', apply: (p) => { p.speedTalent *= 1.12; } },
  { key: 'magnet', name: 'Ember magnet', max: 3, desc: 'Pick up embers from 35% further away.', apply: (p) => { p.pickupMult *= 1.35; } },
  { key: 'wind', name: 'Second wind', max: 3, desc: 'Regenerate 1 health per second.', apply: (p) => { p.regen += 1; } },
  { key: 'hide', name: 'Thick hide', max: 4, desc: 'Gain 6% armour.', apply: (p) => { p.armourTalent += 0.06; } },
  { key: 'twin', name: 'Twin spark', max: 2, desc: 'Cinder bolt fires one more bolt.', apply: (p) => { p.extraBolts += 1; } },
  { key: 'echo', name: 'Nova echo', max: 3, desc: 'Ember nova recharges 25% faster.', apply: (p) => { p.novaCdMult *= 0.75; } },
  { key: 'fleet', name: 'Fleet foot', max: 3, desc: 'Move 10% faster.', apply: (p) => { p.speedMult *= 1.1; } },
  { key: 'lucky', name: 'Lucky spark', max: 3, desc: 'Enemies drop 40% more forge shards.', apply: (p) => { p.luck *= 1.4; } },
  { key: 'bearer', name: 'Lantern bearer', max: 2, desc: 'One more orbiting ash lantern.', apply: (p) => { p.extraOrbs += 1; } },
  { key: 'spite', name: 'Spite', max: 3, desc: 'Heavy strikes deal 30% more and stun longer.', apply: (p) => { p.heavyMult *= 1.3; } },
  { key: 'steady', name: 'Steady hand', max: 3, rare: true, desc: 'Critical chance +8%.', apply: (p) => { p.critBonus = (p.critBonus || 0) + 0.08; } },
  { key: 'shell', name: 'Ember shell', max: 2, rare: true, desc: 'Taking a hit scorches everything within 3 for 10 damage.', apply: (p) => { p.shell = (p.shell || 0) + 1; } },
  { key: 'kindling', name: 'Kindling', max: 3, desc: 'Kills have a 12% chance to drop an extra ember.', apply: (p) => { p.kindling = (p.kindling || 0) + 0.12; } },
  { key: 'stride', name: 'Long stride', max: 2, desc: 'Dash carries you 30% further.', apply: (p) => { p.dashLen = (p.dashLen || 1) * 1.3; } },
  { key: 'will', name: 'Iron will', max: 2, desc: 'Invulnerability after a hit lasts 0.2 s longer.', apply: (p) => { p.invBonus = (p.invBonus || 0) + 0.2; } },
  { key: 'scavenger', name: 'Scavenger', max: 2, desc: 'Hearts drop twice as often.', apply: (p) => { p.heartMult = (p.heartMult || 1) * 2; } },
  { key: 'overcharge', name: 'Overcharge', max: 3, desc: 'Heavy strike recovers 20% faster.', apply: (p) => { p.heavyCdMult = (p.heavyCdMult || 1) * 0.8; } },
  { key: 'tongue', name: 'Cinder tongue', max: 3, desc: 'Cinder bolts deal 20% more.', apply: (p) => { p.boltMult = (p.boltMult || 1) * 1.2; } },
  { key: 'pyre', name: 'Pyre', max: 2, rare: true, desc: 'Burning ground deals double and lasts 50% longer.', apply: (p) => { p.burnMult = (p.burnMult || 1) * 2; p.burnDur = (p.burnDur || 1) * 1.5; } },
  { key: 'mask', name: 'Ash mask', max: 2, desc: 'Brutes and the Warden hurt you 25% less.', apply: (p) => { p.eliteRes = Math.min(0.6, (p.eliteRes || 0) + 0.25); } },
  // keystones: one per run
  { key: 'glass', name: 'Glass cannon', max: 1, keystone: true, desc: 'Damage +60%. Max health −40%.', apply: (p) => { p.keystone = 'glass'; p.dmgTalent *= 1.6; p.maxHp = Math.max(30, Math.round(p.maxHp * 0.6)); p.hp = Math.min(p.hp, p.maxHp); } },
  { key: 'wardenk', name: 'Lantern warden', max: 1, keystone: true, desc: 'Two ash lanterns always orbit you, whatever you wield. Damage −10%.', apply: (p) => { p.keystone = 'wardenk'; p.orbAlways = true; p.dmgTalent *= 0.9; } },
  { key: 'leech', name: 'Ash leech', max: 1, keystone: true, desc: 'Heal 5% of all damage dealt. Regeneration stops; hearts heal half.', apply: (p) => { p.keystone = 'leech'; p.leech = 0.05; p.noRegen = true; } },
];
const LEVEL_NAMES = ['A brighter spark.', 'The wick catches.', 'Warmth returns.', 'Steady flame.', 'The dark recedes.', 'Ember heart.', 'Wildfire.', 'Beacon.', 'Sunrise in your hands.', 'Unquenchable.'];
const WEAPON_UPGRADES = {
  crescent: { costs: [12, 24, 40], ranks: ['Wider arc (+25%)', 'Return swing: a second, reversed cut', 'Every hit restores 1 health'] },
  bolt:     { costs: [12, 24, 40], ranks: ['Pierce one more enemy', 'Fire one more bolt', 'Bolts burst on impact'] },
  lantern:  { costs: [12, 24, 40], ranks: ['One more lantern', 'Orbit radius +30%', 'Lanterns scorch the ground'] },
  bow:      { costs: [12, 24, 40], ranks: ['Pierce two more enemies', 'Arrows split into three', 'Arrows scorch where they land'] },
  chain:    { costs: [12, 24, 40], ranks: ['Every third hit strikes for 2.5×', 'Reach +40%', 'Hits drag enemies toward you'] },
};
const FORGE = [
  { key: 'edge', name: 'EDGE', desc: 'Damage <b>+20%</b> per rank', costs: [10, 20, 35] },
  { key: 'mail', name: 'MAIL', desc: 'Armour <b>+8%</b> per rank', costs: [8, 16, 28] },
  { key: 'charm', name: 'CHARM', desc: 'Pickup radius <b>+25%</b>, XP <b>+10%</b> per rank', costs: [8, 16, 28] },
];

// =====================================================================
// state
// =====================================================================
const S = {
  phase: 'loading',          // loading | title | run | dead | won
  paused: false, modal: null,
  t: 0, endless: false, seed: 7,
  keys: {}, mouse: { x: 0, y: 0, down: false, rdown: false }, aim: new THREE.Vector3(),
  enemies: [], pickups: [], projectiles: [], eprojectiles: [], burns: [], slashes: [], timers: [],
  spawnBudget: 0, eliteTimer: 40, hitStop: 0, bossIntro: 0, slowMo: 0, minis: [], miniDone: {}, miniCorpses: [], bossSpawned: false, boss: null,
  discovered: new Set(), district: DISTRICTS[0], lastDistrict: null, bannerT: 0,
  stats: { kills: 0, elites: 0, dmgDealt: 0 }, dmgLog: {},
  best: (() => { try { return JSON.parse(localStorage.getItem('emberlight.best') || '{"time":0,"kills":0}'); } catch (e) { return { time: 0, kills: 0 }; } })(),
  hideUI: false, fpsAcc: 0, fpsN: 0,
};
function newPlayer() {
  return {
    x: 0, z: 5, vx: 0, vz: 0, r: 0.45, facing: 0, moving: 0, bob: 0,
    hp: 100, maxHp: 100, level: 1, xp: 0, xpNext: 12, shards: 0,
    weapon: 0, weaponRank: { crescent: 0, bolt: 0, lantern: 0, bow: 0, chain: 0 }, attackT: 0, combo: 0, heavyCd: 0, dashCd: 0, dashT: 0, dashDx: 0, dashDz: 0, novaCd: 0, invuln: 0, swing: 0,
    speedMult: 1, dmgTalent: 1, speedTalent: 1, areaMult: 1, pickupMult: 1, regen: 0, armourTalent: 0, extraBolts: 0, novaCdMult: 1, luck: 1, extraOrbs: 0, heavyMult: 1, fireTrail: false,
    talents: {}, forge: { edge: 0, mail: 0, charm: 0 }, orbitA: 0, orbHits: new WeakMap(), auto: true, trailT: 0, hitFlash: 0,
  };
}
let P = newPlayer();

// =====================================================================
// settings (persisted) + translations
// =====================================================================
const SET_V = 1, META_V = 1;
const SET = Object.assign({ v: SET_V, quality: 'high', shake: true, numbers: true, music: 0.28, sfx: 0.55, lang: 'en', difficulty: 'standard', startWeapon: 0, cues: false }, (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('emberlight.settings') || '{}');
    if (typeof raw !== 'object' || raw === null) return {};
    // migrations by version: v0 (no field) → v1: clamp volumes, drop unknown keys
    const out = {};
    for (const k of ['quality', 'shake', 'numbers', 'music', 'sfx', 'lang', 'difficulty', 'startWeapon', 'cues']) if (k in raw) out[k] = raw[k];
    out.cues = !!out.cues;
    if (!['calm', 'standard', 'ash'].includes(out.difficulty)) delete out.difficulty;
    if (!Number.isInteger(out.startWeapon)) delete out.startWeapon;
    if (typeof out.music === 'number') out.music = Math.min(0.5, Math.max(0, out.music)); else delete out.music;
    if (typeof out.sfx === 'number') out.sfx = Math.min(0.8, Math.max(0, out.sfx)); else delete out.sfx;
    if (out.quality !== 'high' && out.quality !== 'low') delete out.quality;
    if (out.lang !== 'en' && out.lang !== 'zh') delete out.lang;
    return out;
  } catch (e) { window.__emberLog('save', 'settings unreadable, reset'); return {}; }
})());
function saveSettings() { try { localStorage.setItem('emberlight.settings', JSON.stringify(SET)); } catch (e) { window.__emberLog('save', 'settings write failed: ' + e.message); } }
const ZH = {
  // hud
  'Auto attack ON': '自动攻击 开', 'Auto attack OFF': '自动攻击 关', 'Level': '等级', 'XP': '经验', 'forge shards': '锻造币', 'forge shard': '锻造币',
  'Edge': '锋刃', 'Mail': '甲胄', 'Charm': '护符', 'Damage': '伤害', 'Armour': '护甲', 'Best': '最佳', 'kills': '击杀', 'Threat': '威胁', 'enemies': '敌人',
  'Dash ready': '冲刺就绪', 'Dash': '冲刺', 'Ember nova ready': '灰烬新星就绪', 'Ember nova': '灰烬新星', 'defeated': '击败', 'elites': '精英',
  'Switch weapon': '切换武器', 'Enter forge': '进入铁匠铺', 'Sound': '声音', 'Sound off': '声音 关', 'Pause': '暂停',
  'Day': '白天', 'Dusk': '黄昏', 'Night': '夜晚', 'Clear': '晴', 'Rain': '雨', 'Storm': '暴风', 'Snow': '雪', 'Auto': '自动', 'Manual': '手动',
  'THE ASH WARDEN': '灰烬守卫', 'THE ASH WARDEN · BURNING': '灰烬守卫 · 燃烧', 'Attack': '攻击', 'Heavy': '重击', 'Passive': '被动', 'Orbits': '环绕',
  // weapons
  'EMBER CRESCENT': '灰烬弯月', 'CINDER BOLT': '余烬弹', 'ASH LANTERNS': '灰烬提灯', 'CRESCENT': '弯月', 'BOLT': '余烬弹', 'LANTERNS': '提灯',
  // districts
  'THE HEARTH': '炉火镇', 'THE WILDWOOD': '荒野林', 'MOSSFALL RUINS': '苔落废墟', 'CINDER BARROW': '余烬冢', 'SILVERMERE SHORE': '银泽岸',
  'The Hearth': '炉火镇', 'The Wildwood': '荒野林', 'Mossfall Ruins': '苔落废墟', 'Cinder Barrow': '余烬冢', 'Silvermere Shore': '银泽岸',
  'Collect embers. Find the forge. Survive 10 minutes.': '收集余烬。找到铁匠铺。活过十分钟。',
  'Old oaks and older things. Wisps hunt in packs.': '老橡树,和更老的东西。鬼火成群狩猎。',
  'Stone remembers. Spitters nest in the arches.': '石头记得一切。吐火者在拱门里筑巢。',
  'The ground still smoulders. The Ash Warden sleeps here.': '大地仍在阴燃。灰烬守卫沉睡于此。',
  'Reeds and mist. Crawlers move beneath the water.': '芦苇与雾。爬行者在水下移动。',
  // banners
  'AN ASH BRUTE PROWLS NEARBY': '灰烬蛮兽在附近徘徊', 'THE ASH WARDEN STIRS': '灰烬守卫苏醒了', 'THE WARDEN CALLS ITS KIN': '守卫召唤同族',
  'THE WARDEN BURNS BRIGHTER': '守卫燃烧得更旺', 'THE ASH WARDEN FALLS  ·  The valley breathes again.': '灰烬守卫倒下  ·  山谷重新呼吸。',
  'ENDLESS  ·  The wildwood does not end. Neither do you.': '无尽  ·  荒野没有尽头,你也没有。',
  // modals
  'Choose a talent. Your run is paused.': '选一个天赋。游戏已暂停。', 'Forge': '锻造', 'Maxed': '已满级', 'shards': '锻造币', 'Next:': '下一级:',
  'Weapons — the smith reworks each blade in three stages.': '武器 —— 铁匠分三段重锻每件兵器。',
  'Dawn breaks over the wildwood.': '黎明降临荒野。', 'The light went out.': '灯火熄灭了。',
  'Ten minutes, and the valley is still here. Keep going — it only gets wilder.': '十分钟过去,山谷还在。继续吧 —— 只会更狂野。',
  'You kept the light for': '你守住灯火', 'Go endless  →': '进入无尽  →', 'Try again': '再来一局', 'Back to title': '返回标题',
  'Time survived': '存活时间', 'Defeated': '击败', 'Elites': '精英', 'Damage dealt': '造成伤害', 'Forge shards': '锻造币',
  'Rested': '休整完毕', 'Unlocked': '解锁', 'Shrines lit': '点亮神龛', ' shrines': ' 座神龛', 'dawns': '次通关',
  'Hold the shrine for 45 seconds.': '守住神龛 45 秒。', 'THE SHRINE GUTTERS OUT  ·  You strayed too far.': '神龛熄灭了  ·  你走得太远。', 'WARD GAINED': '获得守护', 'SHRINE': '神龛', '· too far!': '· 太远了!',
  'Wolfsbane': '狼毒', 'Wisps no longer hunt in packs and hit for half.': '鬼火不再成群,伤害减半。', 'Stonewatch': '石守', 'Your attacks shatter spitter bolts; the rest sting 30% less.': '你的攻击能击碎吐火弹,余下伤害 −30%。',
  'Ashwalker': '踏灰者', 'Burning ground cannot hurt you; +25% damage to cinders and brutes.': '燃烧地面对你无害;对灰烬与蛮兽伤害 +25%。', 'Tidewalker': '踏潮者', 'Move 12% faster and dash recovers 25% sooner.': '移速 +12%,冲刺冷却 −25%。',
  'Light the shrine': '点亮神龛', 'Difficulty': '难度', 'Starting weapon': '起手武器',
  'THE WOLF KING': '狼王', 'THE STONE SENTINEL': '石像哨卫', 'THE CINDER SALAMANDER': '余烬火蜥', 'THE SILVERMERE MAW': '银泽巨口', 'wakes': '苏醒', 'falls': '倒下', 'FIRST KILL': '首次击杀', 'Bestiary': '图鉴', 'Elites felled': '击杀精英',
  'ASH LONGBOW': '灰烬长弓', 'EMBER CHAIN': '余烬链', 'LONGBOW': '长弓', 'CHAIN': '余烬链',
  'Pierce two more enemies': '多穿透两个敌人', 'Arrows split into three': '箭分三支', 'Arrows scorch where they land': '落点灼烧地面',
  'Every third hit strikes for 2.5×': '每第三击造成 2.5 倍伤害', 'Reach +40%': '攻击距离 +40%', 'Hits drag enemies toward you': '命中把敌人拖向你',
  'Keystone': '钥石', 'Rare': '稀有',
  'Steady hand': '稳手', 'Critical chance +8%.': '暴击率 +8%。', 'Ember shell': '余烬甲壳', 'Taking a hit scorches everything within 3 for 10 damage.': '受击时灼烧周围 3 格内所有敌人 10 点。',
  'Kindling': '引火物', 'Kills have a 12% chance to drop an extra ember.': '击杀有 12% 几率额外掉一枚余烬。', 'Long stride': '大步', 'Dash carries you 30% further.': '冲刺距离 +30%。',
  'Iron will': '铁意志', 'Invulnerability after a hit lasts 0.2 s longer.': '受击后无敌延长 0.2 秒。', 'Scavenger': '拾荒者', 'Hearts drop twice as often.': '红心掉率翻倍。',
  'Overcharge': '过载', 'Heavy strike recovers 20% faster.': '重击冷却 −20%。', 'Cinder tongue': '余烬之舌', 'Cinder bolts deal 20% more.': '余烬弹伤害 +20%。',
  'Pyre': '柴堆', 'Burning ground deals double and lasts 50% longer.': '燃烧地面伤害翻倍、持续 +50%。', 'Ash mask': '灰烬面具', 'Brutes and the Warden hurt you 25% less.': '蛮兽与守卫对你的伤害 −25%。',
  'Glass cannon': '玻璃大炮', 'Damage +60%. Max health −40%.': '伤害 +60%,最大生命 −40%。', 'Lantern warden': '提灯守护', 'Two ash lanterns always orbit you, whatever you wield. Damage −10%.': '无论持何武器,两盏提灯常驻环绕。伤害 −10%。',
  'Ash leech': '灰烬吸血', 'Heal 5% of all damage dealt. Regeneration stops; hearts heal half.': '造成伤害的 5% 转为生命。再生失效,红心回复减半。',
  // level names
  'A brighter spark.': '更亮的火星。', 'The wick catches.': '灯芯点燃。', 'Warmth returns.': '暖意回归。', 'Steady flame.': '稳定的火焰。', 'The dark recedes.': '黑暗退去。',
  'Ember heart.': '余烬之心。', 'Wildfire.': '野火。', 'Beacon.': '灯塔。', 'Sunrise in your hands.': '手中的日出。', 'Unquenchable.': '不灭。',
  // talents
  'Still burning': '仍在燃烧', 'Gain 20 max health. Recover 35 health.': '最大生命 +20,回复 35 生命。',
  'Wildfire soles': '野火之靴', 'Dashing leaves a trail of burning embers.': '冲刺留下一道燃烧的余烬。',
  'Wide awake': '大梦初醒', 'Increase attack and nova radius by 15%.': '攻击与新星范围 +15%。',
  'Keen edge': '锋锐', 'Increase damage by 12%.': '伤害 +12%。', 'Quick hands': '快手', 'Attack 12% faster.': '攻速 +12%。',
  'Ember magnet': '余烬磁石', 'Pick up embers from 35% further away.': '拾取范围 +35%。', 'Second wind': '再生', 'Regenerate 1 health per second.': '每秒回复 1 生命。',
  'Thick hide': '厚皮', 'Gain 6% armour.': '护甲 +6%。', 'Twin spark': '双生火花', 'Cinder bolt fires one more bolt.': '余烬弹多发一枚。',
  'Nova echo': '新星回响', 'Ember nova recharges 25% faster.': '灰烬新星冷却 -25%。', 'Fleet foot': '疾足', 'Move 10% faster.': '移速 +10%。',
  'Lucky spark': '幸运火星', 'Enemies drop 40% more forge shards.': '敌人多掉 40% 锻造币。', 'Lantern bearer': '提灯人', 'One more orbiting ash lantern.': '多一盏环绕提灯。',
  'Spite': '怨怒', 'Heavy strikes deal 30% more and stun longer.': '重击伤害 +30%,眩晕更久。',
  // forge
  'Damage <b>+20%</b> per rank': '每级伤害 <b>+20%</b>', 'Armour <b>+8%</b> per rank': '每级护甲 <b>+8%</b>', 'Pickup radius <b>+25%</b>, XP <b>+10%</b> per rank': '每级拾取范围 <b>+25%</b>、经验 <b>+10%</b>',
  'EDGE': '锋刃', 'MAIL': '甲胄', 'CHARM': '护符',
  'Wider arc (+25%)': '弧度更宽(+25%)', 'Return swing: a second, reversed cut': '回斩:反向补一刀', 'Every hit restores 1 health': '每次命中回 1 生命',
  'Pierce one more enemy': '多穿透一个敌人', 'Fire one more bolt': '多发一枚', 'Bolts burst on impact': '命中时爆裂',
  'One more lantern': '多一盏提灯', 'Orbit radius +30%': '环绕半径 +30%', 'Lanterns scorch the ground': '提灯灼烧地面',
  // unlocks / archive
  'Wide horizon': '开阔视野', 'Survive 5 minutes in one run': '单局活过 5 分钟', 'Level-ups offer four talents instead of three': '升级时四选一而非三选一',
  "Smith's tithe": '铁匠的什一税', 'Defeat the Ash Warden': '击败灰烬守卫', 'Every run starts with 10 forge shards': '每局开局 10 锻造币',
  'Cinder in the hand': '掌中余烬', 'Defeat 3000 creatures in total': '累计击败 3000 只', 'Runs start with the Cinder Bolt, already forged once': '开局持有锻造过一次的余烬弹',
  'Locked': '未解锁', 'longest run': '最长存活', 'creatures defeated': '累计击败', 'wardens felled': '击杀守卫', 'runs': '局数', 'Best runs': '最佳战绩', 'No runs yet.': '还没有记录。',
  'Dawn': '黎明', 'Warden slain': '守卫已斩', 'What the valley remembers of you. Kept on this device.': '山谷对你的记忆。只存在本机。',
};
const tr = (t) => (SET.lang === 'zh' && ZH[t]) || t;
// static HTML swapped as whole blocks
const HTML_ZH = {
  '#title .kicker': '小小世界。勇敢的心。',
  '#title .lead': '没有尽头的荒野。<br>一盏值得守护的灯。',
  '#title .desc': '探索五个区域。收集余烬。<br>锻造你的流派。直面灰烬守卫。<br>活过十分钟 —— 然后进入无尽。',
  '#startBtn': '进入荒野 &nbsp;→',
  '#title .controls': '<b>WASD</b> 移动 <span class="dot">•</span> <b>鼠标</b> 瞄准 <span class="dot">•</span> <b>自动攻击默认开</b> <span class="dot">•</span> <b>右键 / K</b> 重击<br><b>空格</b> 冲刺 <span class="dot">•</span> <b>E</b> 灰烬新星 <span class="dot">•</span> <b>Q</b> 换武器<br><b>F</b> 铁匠铺 <span class="dot">•</span> <b>Tab</b> 自动 / 手动 <span class="dot">•</span> <b>Esc</b> 暂停<br><b>滚轮</b> 缩放 <span class="dot">•</span> <b>F4</b> 隐藏界面',
  '#title .tiny:not(#titleBest)': '生存 / 升级 / 打造流派',
  '#archiveBtn': '余烬档案', '#aboutBtn': '关于', '#archiveClose': '返回', '#aboutClose': '返回',
  '#archive h2': '余烬档案', '#archive .modal > .sub': '山谷对你的记忆。只存在本机。',
  '#forge h2': '铁匠铺', '#forgeClose': '离开 &nbsp;(F / Esc)', '#forgeRest': '在炉边休整 —— 回满生命(5 锻造币)',
  '#pause h2': '已暂停', '#pause .modal > .sub': '荒野在等你。', '#resumeBtn': '继续 &nbsp;(Esc)', '#quitBtn': '返回标题', '#diagBtn': '复制诊断信息',
  '#endSecondary': '返回标题',
  '#weather .label': '活着的山谷', '#swapBtn': '<b>Q</b> 切换武器', '#forgeHint': '<b>F</b> 进入铁匠铺', '#pauseBtn': '暂停',
  '#dashText b': '空格', '#settingsTitle': '设置', '#diffLabel': '难度', '#weaponLabel': '起手武器', '#shrineHint': '<b>F</b> 点亮神龛', '#setQuality .k': '画质', '#setShake .k': '屏幕抖动', '#setNumbers .k': '伤害数字', '#setMusic .k': '音乐', '#setSfx .k': '音效', '#setLang .k': '语言 / Language', '#setCues .k': '色弱辅助(形状与色差)', '#deathReviewLabel': '复盘',
  '#about h2': '关于 Emberlight',
};
const HTML_EN = {};
function applyLang() {
  document.documentElement.lang = SET.lang === 'zh' ? 'zh-CN' : 'en';
  document.body.classList.toggle('zh', SET.lang === 'zh');
  for (const sel of Object.keys(HTML_ZH)) {
    const el = document.querySelector(sel); if (!el) continue;
    if (!(sel in HTML_EN)) HTML_EN[sel] = el.innerHTML;
    el.innerHTML = SET.lang === 'zh' ? HTML_ZH[sel] : HTML_EN[sel];
  }
  refreshWeatherButtons(); refreshAutoBtn(); refreshWeaponCard(); refreshTitleBest(); renderSettings(); renderDiffPick();
  $('#soundBtn').textContent = AUDIO.audioEnabled() ? tr('Sound') : tr('Sound off');
  if (S.modal === 'forge') renderForge();
  if ($('#archive').classList.contains('show')) renderArchive();
}
function renderSettings() {
  const q = $('#setQuality'); if (!q) return;
  q.querySelector('.v').textContent = SET.quality === 'high' ? (SET.lang === 'zh' ? '高' : 'High') : (SET.lang === 'zh' ? '低' : 'Low');
  $('#setShake .v').textContent = SET.shake ? (SET.lang === 'zh' ? '开' : 'On') : (SET.lang === 'zh' ? '关' : 'Off');
  $('#setNumbers .v').textContent = SET.numbers ? (SET.lang === 'zh' ? '开' : 'On') : (SET.lang === 'zh' ? '关' : 'Off');
  $('#setMusic input').value = Math.round(SET.music / 0.5 * 100);
  $('#setSfx input').value = Math.round(SET.sfx / 0.8 * 100);
  $('#setLang .v').textContent = SET.lang === 'zh' ? '中文' : 'English';
  $('#setCues .v').textContent = SET.cues ? (SET.lang === 'zh' ? '开' : 'On') : (SET.lang === 'zh' ? '关' : 'Off');
}
function applyCues() {
  const on = !!SET.cues;
  const set = (name, hex) => { const m = glowMat(name); m.vertexColors = !on; if (on) m.color.setHex(hex); else m.color.setScalar(1); m.needsUpdate = true; };
  set('Crystal', 0xffffff); set('ShardCrystal', 0xffe066); set('HeartGlow', 0xff5ad6); set('EnemyGlow', 0xffffff);
  if (!on) { setGlow('Crystal', 1.4); setGlow('ShardCrystal', 1.5); setGlow('HeartGlow', 1.5); setGlow('EnemyGlow', 2.2); }
  S.cues = on;
}
function applyQuality() {
  const low = SET.quality === 'low';
  sun.castShadow = !low;
  renderer.setPixelRatio(low ? Math.min(window.devicePixelRatio, 1.0) : Math.min(window.devicePixelRatio, 1.5));
  if (gtaoPass) gtaoPass.enabled = !low;
  for (const k in enemySets) if (enemySets[k].outline) enemySets[k].outline.visible = !low;
  if (bloomPass) bloomPass.enabled = true;
  resizeComposer();
  if (world) for (const name of ['Tuft', 'Reed', 'Mushroom']) { const set = world.sets[name]; if (!set) continue; for (const m of set.meshes) { m.count = low ? Math.floor(set.visible * 0.3) : set.visible; } }
  S.qualityLow = low; S.cullX = null;   // force a rebuild with the new radius
}

// =====================================================================
// the Ember Archive: persistent stats + unlocks
// =====================================================================
// first-run guide: four cards, each dismissed by doing the thing (or after 25 s)
const GUIDE = [
  { key: 'move', text: 'Move with WASD', zh: '用 WASD 移动', touch: 'Drag the left half of the screen to move', touchZh: '拖动屏幕左半边移动', pad: 'Move with the left stick', padZh: '左摇杆移动', done: () => (S.guideMoved || 0) > 4 },
  { key: 'attack', text: 'Your blade swings on its own. Keep enemies in front of you.', zh: '刀会自己挥。把敌人放在身前。', done: () => S.stats.kills >= 3 },
  { key: 'ember', text: 'Cyan embers are experience. Walk over them to level up.', zh: '青色余烬是经验,走过去拾取升级。', done: () => (P.xpTotal || 0) >= 5 },
  { key: 'forge', text: 'The forge in the village reworks your weapons. Press F beside it.', zh: '村里的铁匠铺能重锻武器,走到旁边按 F。', touch: 'The forge in the village reworks your weapons. Tap Forge beside it.', touchZh: '村里的铁匠铺能重锻武器,走到旁边点"锻造"。', pad: 'The forge in the village reworks your weapons. Press LB beside it.', padZh: '村里的铁匠铺能重锻武器,走到旁边按 LB。', done: () => S.forgeOpened || P.shards >= 8 },
];
function guideText(g) {
  const zh = SET.lang === 'zh';
  if (S.touch) return zh ? (g.touchZh || g.zh) : (g.touch || g.text);
  if (PAD.on) return zh ? (g.padZh || g.zh) : (g.pad || g.text);
  return zh ? g.zh : g.text;
}
function updateGuide(dt) {
  const G = S.guide; if (!G) return;
  const el = $('#guide');
  if (G.step >= GUIDE.length) { el.classList.remove('show'); META.guided = true; saveMeta(); S.guide = null; return; }
  const g = GUIDE[G.step];
  G.t += dt;
  if (!G.shown) { el.textContent = guideText(g); el.classList.add('show'); G.shown = true; G.t = 0; }
  if ((G.t > 1.5 && g.done()) || G.t > 25) { G.step++; G.shown = false; el.classList.remove('show'); G.gap = 0.8; }
  if (G.gap > 0) { G.gap -= dt; if (G.gap > 0) return; }
}
const UNLOCKS = [
  { key: 'fourth', name: 'Wide horizon', how: 'Survive 5 minutes in one run', gives: 'Level-ups offer four talents instead of three', test: (m, run) => run && run.time >= 300 },
  { key: 'tithe', name: "Smith's tithe", how: 'Defeat the Ash Warden', gives: 'Every run starts with 10 forge shards', test: (m, run) => m.bossKills > 0 },
  { key: 'boltstart', name: 'Cinder in the hand', how: 'Defeat 3000 creatures in total', gives: 'Runs start with the Cinder Bolt, already forged once', test: (m) => m.totalKills >= 3000 },
];
function loadMeta() {
  const fresh = { v: META_V, totalKills: 0, bossKills: 0, runsPlayed: 0, bestTime: 0, runs: [], unlocks: {}, byDiff: {}, bestiary: {} };
  try {
    const m = JSON.parse(localStorage.getItem('emberlight.meta') || 'null');
    if (!m || typeof m !== 'object') return fresh;
    // migrate: fill missing fields, coerce types, keep only well-formed runs, unknown unlock keys dropped
    const out = Object.assign({}, fresh);
    for (const k of ['totalKills', 'bossKills', 'runsPlayed', 'bestTime']) out[k] = Number.isFinite(m[k]) ? Math.max(0, Math.floor(m[k])) : 0;
    out.runs = Array.isArray(m.runs) ? m.runs.filter((r) => r && Number.isFinite(r.time)).map((r) => ({ time: Math.floor(r.time), kills: r.kills | 0, level: r.level | 0, won: !!r.won, boss: !!r.boss, date: String(r.date || ''), diff: ['calm', 'standard', 'ash'].includes(r.diff) ? r.diff : 'standard', shrines: r.shrines | 0 })).slice(0, 5) : [];
    out.bestiary = {}; if (m.bestiary && typeof m.bestiary === 'object') for (const k of ['wolfking', 'sentinel', 'salamander', 'maw']) if (m.bestiary[k]) out.bestiary[k] = String(m.bestiary[k]);
    out.byDiff = {}; if (m.byDiff && typeof m.byDiff === 'object') for (const k of ['calm', 'standard', 'ash']) if (m.byDiff[k]) out.byDiff[k] = { best: m.byDiff[k].best | 0, wins: m.byDiff[k].wins | 0, runs: m.byDiff[k].runs | 0 };
    out.guided = !!m.guided;
    out.unlocks = {};
    if (m.unlocks && typeof m.unlocks === 'object') for (const u of UNLOCKS) if (m.unlocks[u.key]) out.unlocks[u.key] = m.unlocks[u.key];
    out.v = META_V;
    if (m.v !== META_V) window.__emberLog('save', 'meta migrated from v' + (m.v || 0));
    return out;
  } catch (e) { window.__emberLog('save', 'meta unreadable, reset'); return fresh; }
}
const META = loadMeta();
function saveMeta() { try { localStorage.setItem('emberlight.meta', JSON.stringify(META)); } catch (e) { window.__emberLog('save', 'meta write failed: ' + e.message); } }
const unlocked = (k) => !!META.unlocks[k];
function recordRun(won) {
  const run = { time: Math.floor(S.t), kills: S.stats.kills, level: P.level, won, boss: !!S.bossKilled, date: new Date().toISOString().slice(0, 10), diff: SET.difficulty, shrines: S.shrines ? Object.values(S.shrines).filter((x) => x.state === 'done').length : 0 };
  META.byDiff = META.byDiff || {}; const bd = META.byDiff[SET.difficulty] || (META.byDiff[SET.difficulty] = { best: 0, wins: 0, runs: 0 });
  bd.runs++; bd.best = Math.max(bd.best, run.time); if (won) bd.wins++;
  META.totalKills += S.stats.kills; META.runsPlayed++; if (S.bossKilled) META.bossKills++;
  META.bestTime = Math.max(META.bestTime, run.time);
  META.runs.push(run); META.runs.sort((a, b) => b.time - a.time || b.kills - a.kills); META.runs = META.runs.slice(0, 5);
  const fresh = [];
  for (const u of UNLOCKS) if (!META.unlocks[u.key] && u.test(META, run)) { META.unlocks[u.key] = run.date; fresh.push(u); }
  saveMeta();
  return fresh;
}
function renderArchive() {
  const box = $('#archiveBody'); if (!box) return;
  const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  let h = `<div class="statrow">${stat(fmtTime(META.bestTime), tr('longest run'))}${stat(META.totalKills, tr('creatures defeated'))}${stat(META.bossKills, tr('wardens felled'))}${stat(META.runsPlayed, tr('runs'))}</div>`;
  h += '<div class="achgrid">' + UNLOCKS.map((u) => `<div class="ach ${unlocked(u.key) ? 'on' : ''}"><div class="t">${tr(u.name)}</div><div class="d">${tr(u.how)}</div><div class="g">${unlocked(u.key) ? tr(u.gives) : tr('Locked')}</div></div>`).join('') + '</div>';
  const best = META.bestiary || {};
  h += `<div class="sub" style="margin:16px 0 6px">${tr('Bestiary')}</div><div class="bestiary">` + Object.keys(MINIS).map((k) => { const d = MINIS[k]; const on = !!best[d.key]; return `<span class="bb ${on ? 'on' : ''}">${on ? tr(d.name) : '???'}</span>`; }).join('') + `<span class="bb ${META.bossKills ? 'on' : ''}">${META.bossKills ? tr('THE ASH WARDEN') : '???'}</span></div>`;
  h += `<div class="sub" style="margin:16px 0 6px">${tr('Best runs')}</div>`;
  h += META.runs.length ? '<table class="runs">' + META.runs.map((r) => `<tr><td>${fmtTime(r.time)}</td><td>${SET.lang === 'zh' ? DIFFS[r.diff || 'standard'].zh : DIFFS[r.diff || 'standard'].name}</td><td>${r.kills} ${tr('defeated')}</td><td>${tr('Level')} ${r.level}</td><td>${r.won ? tr('Dawn') : (r.boss ? tr('Warden slain') : '—')}${r.shrines ? ` · ${r.shrines}${tr(' shrines')}` : ''}</td><td>${r.date}</td></tr>`).join('') + '</table>' : `<div class="sub">${tr('No runs yet.')}</div>`;
  const bdRows = ['calm', 'standard', 'ash'].map((k) => { const b = (META.byDiff || {})[k]; return b ? `<span class="dbadge"><b>${SET.lang === 'zh' ? DIFFS[k].zh : DIFFS[k].name}</b> ${fmtTime(b.best)} · ${b.wins}/${b.runs} ${tr('dawns')}</span>` : ''; }).join('');
  if (bdRows) h += `<div class="dbadges">${bdRows}</div>`;
  box.innerHTML = h;
}
const dmgMult = () => P.dmgTalent * (1 + 0.2 * P.forge.edge);
const armour = () => Math.min(0.75, P.armourTalent + 0.08 * P.forge.mail);
const pickupR = () => 3.2 * P.pickupMult * (1 + 0.25 * P.forge.charm);
const moveSpeed = () => 7.2 * P.speedMult;
const minute = () => S.t / 60;
const threat = () => Math.floor(minute()) + 1;

// =====================================================================
// load kit, build world
// =====================================================================
const kit = new Kit();
let world, ground, playerRig, wardenRig, enemySets = {}, pickupSets = {}, boltSet, spitSet;
const loadBar = $('#loadBar'), loadText = $('#loadText');
kit.load('./assets/kit.glb?v=5', (e) => { if (e.total) loadBar.style.transform = `scaleX(${(e.loaded / e.total) * 0.6})`; }).then(() => {
  loadText.textContent = 'Planting the wildwood…';
  setTimeout(() => { const t0 = performance.now(); buildWorld(); console.log('world built in', Math.round(performance.now() - t0), 'ms'); }, 30);
}).catch((err) => { loadText.textContent = 'Failed to load kit: ' + err.message; console.error(err); });

function buildWorld() {
  ground = buildGround(scene);
  loadBar.style.transform = 'scaleX(0.75)';
  world = generateMap(kit, scene, S.seed);
  loadBar.style.transform = 'scaleX(0.9)';
  MATS.snow.opacity = 0;
  // rigs
  playerRig = mergeRig(kit.rigs.Player.clone(true));
  scene.add(playerRig);
  wardenRig = mergeRig(kit.rigs.Warden.clone(true));
  wardenRig.visible = false;
  scene.add(wardenRig);
  ANIM.p = makeRigAnimator(playerRig, 'P_');
  buildMiniRigs();
  ANIM.w = makeRigAnimator(wardenRig, 'W_');
  // dynamic sets
  for (const k of Object.keys(ETYPES)) enemySets[k] = new DynSet(kit, ETYPES[k].kit, k === 'brute' ? 40 : 320, scene, { glowKey: 'EnemyGlow', outline: 1.07 });
  pickupSets.ember = new DynSet(kit, 'Ember', 600, scene, { cast: false, glowKey: 'Crystal' });
  pickupSets.shard = new DynSet(kit, 'Shard', 200, scene, { cast: false, glowKey: 'ShardCrystal' });
  pickupSets.heart = new DynSet(kit, 'Heart', 40, scene, { cast: false, glowKey: 'HeartGlow' });
  boltSet = new DynSet(kit, 'Ember', 200, scene, { cast: false, glowKey: 'Bolt', glowMat: new THREE.MeshBasicMaterial({ color: 0xffb060, toneMapped: false }) });
  spitSet = new DynSet(kit, 'Ember', 120, scene, { cast: false, glowKey: 'Spit', glowMat: new THREE.MeshBasicMaterial({ color: 0xff5a2a, toneMapped: false }) });
  setGlow('EnemyGlow', 2.2);
  buildEffects();
  buildComposer();
  buildMinimapBg();
  forgeLight.position.set(world.forgePos.x, 1.4, world.forgePos.z);
  loadBar.style.transform = 'scaleX(1)';
  setTimeout(() => { $('#loading').style.display = 'none'; }, 250);
  S.phase = 'title';
  document.body.classList.add('title');
  applyQuality(); applyCues(); applyLang();
  refreshTitleBest();
  setupTouch();
  applyWeatherInstant();
  requestAnimationFrame(loop);
}
// Blender-authored clips: idle/walk are the base layer (weights cross-fade), the rest are additive one-shots
const ANIM = {};
function makeRigAnimator(root, prefix) {
  const mixer = new THREE.AnimationMixer(root);
  const actions = {};
  for (const clip of kit.clips) {
    if (!clip.name.startsWith(prefix)) continue;
    const key = clip.name.slice(prefix.length);
    const base = key === 'idle' || key === 'walk';
    let c = clip;
    if (!base) { c = clip.clone(); THREE.AnimationUtils.makeClipAdditive(c); }
    const a = mixer.clipAction(c);
    if (!base) a.blendMode = THREE.AdditiveAnimationBlendMode;
    if (!base && key !== 'charge') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = key === 'death'; }
    else { a.play(); a.setEffectiveWeight(key === 'idle' ? 1 : 0); }
    actions[key] = a;
  }
  return { mixer, actions, root, base: 0 };
}
function playOnce(anim, key, timeScale = 1) {
  const a = anim.actions[key]; if (!a) return;
  a.reset(); a.setEffectiveWeight(1); a.setEffectiveTimeScale(timeScale); a.play();
}
function setBase(anim, walkW, walkSpeed = 1) {
  anim.actions.walk.setEffectiveWeight(walkW); anim.actions.idle.setEffectiveWeight(1 - walkW);
  anim.actions.walk.setEffectiveTimeScale(walkSpeed);
}
// each animated Empty keeps one vertex-coloured body mesh and one glow mesh instead of a dozen tiny meshes
const GLOW_RE = /EnemyEye|EmberCore|HotMetal|PlayerLamp/;
function mergeRig(root) {
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, envMapIntensity: 0.5 });
  const glowMatR = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  const empties = [];
  root.traverse((o) => { if (!o.isMesh && o !== root) empties.push(o); });
  for (const e of empties) {
    const meshes = e.children.filter((c) => c.isMesh);
    if (!meshes.length) continue;
    const body = [], glow = [];
    for (const m of meshes) {
      m.updateMatrix();
      const g = m.geometry.clone().applyMatrix4(m.matrix);
      for (const k of Object.keys(g.attributes)) if (!['position', 'normal'].includes(k)) g.deleteAttribute(k);
      const isGlow = GLOW_RE.test(m.material.name || '');
      const c = isGlow ? (m.material.emissive && m.material.emissive.getHex() ? m.material.emissive.clone().multiplyScalar(1.6) : m.material.color) : m.material.color;
      const n = g.attributes.position.count, col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      (isGlow ? glow : body).push(g.index ? g.toNonIndexed() : g);
      e.remove(m);
    }
    if (body.length) { const mm = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(body, false), bodyMat); mm.castShadow = true; mm.name = e.name + '_body'; e.add(mm); }
    if (glow.length) { const mm = new THREE.Mesh(BufferGeometryUtils.mergeGeometries(glow, false), glowMatR); mm.name = e.name + '_glow'; e.add(mm); }
  }
  return root;
}
function rigMaterial(m) {
  const name = m.name || '';
  if (/EnemyEye|EmberCore|HotMetal|PlayerLamp/.test(name)) {
    const b = new THREE.MeshBasicMaterial({ color: m.emissive && m.emissive.getHex() ? m.emissive : m.color, toneMapped: false });
    b.color.multiplyScalar(1.6);
    return b;
  }
  const s = new THREE.MeshStandardMaterial({ color: m.color, roughness: 0.8, envMapIntensity: 0.5 });
  return s;
}

// =====================================================================
// effects: particles, slashes, rings, rain, snow
// =====================================================================
const FX = {};
function softDisc(size = 64) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,.8)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function buildEffects() {
  // particle pool
  const MAXP = 2500;
  const geo = new THREE.BufferGeometry();
  FX.pPos = new Float32Array(MAXP * 3); FX.pCol = new Float32Array(MAXP * 3); FX.pSize = new Float32Array(MAXP);
  FX.pVel = new Float32Array(MAXP * 3); FX.pLife = new Float32Array(MAXP); FX.pMax = new Float32Array(MAXP); FX.pGrav = new Float32Array(MAXP);
  geo.setAttribute('position', new THREE.BufferAttribute(FX.pPos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(FX.pCol, 3));
  geo.setAttribute('size', new THREE.BufferAttribute(FX.pSize, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: softDisc() }, uScale: { value: window.innerHeight } },
    vertexShader: `attribute float size; varying vec3 vC; varying float vA; uniform float uScale;
      void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * uScale / max(1.0, -mv.z); gl_Position = projectionMatrix * mv; vA = size > 0.001 ? 1.0 : 0.0; }`,
    fragmentShader: `uniform sampler2D map; varying vec3 vC; varying float vA; void main(){ vec4 t = texture2D(map, gl_PointCoord); gl_FragColor = vec4(vC, t.a * vA); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true,
  });
  FX.points = new THREE.Points(geo, mat); FX.points.frustumCulled = false; scene.add(FX.points);
  FX.pN = MAXP; FX.pHead = 0;
  // slash / ring meshes pool
  FX.slashGeo = new THREE.RingGeometry(0.6, 1, 24, 1, 0, 1).rotateX(-Math.PI / 2);
  FX.ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
  FX.discGeo = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  // player ring (like the original: small circle under the player)
  FX.playerRing = new THREE.Mesh(new THREE.RingGeometry(0.62, 0.7, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8ff0dc, transparent: true, opacity: 0.55, toneMapped: false }));
  FX.playerRing.position.y = 0.03; scene.add(FX.playerRing);
  FX.forgeRing = new THREE.Mesh(new THREE.RingGeometry(3.6, 3.75, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8ff0dc, transparent: true, opacity: 0.35, toneMapped: false }));
  FX.forgeRing.position.set(world.forgePos.x, 0.03, world.forgePos.z); scene.add(FX.forgeRing);
  // rain: line segments
  const RN = 1400;
  const rg = new THREE.BufferGeometry();
  FX.rainPos = new Float32Array(RN * 6);
  rg.setAttribute('position', new THREE.BufferAttribute(FX.rainPos, 3));
  FX.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xbcd0e6, transparent: true, opacity: 0.0, toneMapped: false }));
  FX.rain.frustumCulled = false; scene.add(FX.rain);
  FX.rainSeed = new Float32Array(RN * 3);
  for (let i = 0; i < RN * 3; i++) FX.rainSeed[i] = Math.random();
  FX.rainN = RN;
  // snow: points
  const SN = 1600;
  const sg = new THREE.BufferGeometry();
  FX.snowPos = new Float32Array(SN * 3);
  sg.setAttribute('position', new THREE.BufferAttribute(FX.snowPos, 3));
  FX.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, map: softDisc(32), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }));
  FX.snow.frustumCulled = false; scene.add(FX.snow);
  FX.snowSeed = new Float32Array(SN * 3);
  for (let i = 0; i < SN * 3; i++) FX.snowSeed[i] = Math.random();
  FX.snowN = SN;
  // boss telegraph ring
  FX.tele = new THREE.Mesh(FX.discGeo, new THREE.MeshBasicMaterial({ color: 0xff4a2a, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
  FX.tele.position.y = 0.04; scene.add(FX.tele);
  FX.teleRing = new THREE.Mesh(FX.ringGeo, new THREE.MeshBasicMaterial({ color: 0xff7a4a, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }));
  FX.teleRing.position.y = 0.05; scene.add(FX.teleRing);
  // orbiting lanterns (player weapon 3)
  FX.orbs = [];
  for (let i = 0; i < 4; i++) {
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), new THREE.MeshBasicMaterial({ color: 0xffb35a, toneMapped: false }));
    const cage = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.42, 0.34), new THREE.MeshStandardMaterial({ color: 0x3a3d46, roughness: 0.5, wireframe: true }));
    g.add(core); g.add(cage);
    const l = new THREE.PointLight(0xffa050, 0, 5, 2); g.add(l);
    g.visible = false; scene.add(g);
    FX.orbs.push(g);
  }
  // fire sparks at the forge & campfires are spawned from the particle system each frame
  FX.emberSources = [];
  for (const t of (world.placements.Campfire || [])) FX.emberSources.push({ x: t.x, z: t.z, y: 0.5, rate: 6 });
  FX.emberSources.push({ x: world.forgePos.x - 0.9 * Math.cos(0), z: world.forgePos.z, y: 1.0, rate: 8 });
}
function spawnParticle(x, y, z, vx, vy, vz, r, g, b, size, life, grav = 0) {
  const i = FX.pHead; FX.pHead = (FX.pHead + 1) % FX.pN;
  FX.pPos[i * 3] = x; FX.pPos[i * 3 + 1] = y; FX.pPos[i * 3 + 2] = z;
  FX.pVel[i * 3] = vx; FX.pVel[i * 3 + 1] = vy; FX.pVel[i * 3 + 2] = vz;
  FX.pCol[i * 3] = r; FX.pCol[i * 3 + 1] = g; FX.pCol[i * 3 + 2] = b;
  FX.pSize[i] = size; FX.pLife[i] = life; FX.pMax[i] = life; FX.pGrav[i] = grav;
}
function burstParticles(x, y, z, n, col, speed, size, life, grav = -6) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.8);
    spawnParticle(x, y + Math.random() * 0.4, z, Math.cos(a) * s, speed * (0.4 + Math.random() * 0.9), Math.sin(a) * s, col[0], col[1], col[2], size * (0.6 + Math.random() * 0.7), life * (0.6 + Math.random() * 0.6), grav);
  }
}
function updateParticles(dt) {
  const pos = FX.pPos, vel = FX.pVel;
  for (let i = 0; i < FX.pN; i++) {
    if (FX.pLife[i] <= 0) { FX.pSize[i] = 0; continue; }
    FX.pLife[i] -= dt;
    vel[i * 3 + 1] += FX.pGrav[i] * dt;
    pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
    if (pos[i * 3 + 1] < 0.02) { pos[i * 3 + 1] = 0.02; vel[i * 3 + 1] *= -0.3; vel[i * 3] *= 0.7; vel[i * 3 + 2] *= 0.7; }
    const k = FX.pLife[i] / FX.pMax[i];
    if (k < 0.35) FX.pSize[i] *= (1 - dt * 3);
    if (FX.pLife[i] <= 0) FX.pSize[i] = 0;
  }
  FX.points.geometry.attributes.position.needsUpdate = true;
  FX.points.geometry.attributes.size.needsUpdate = true;
  FX.points.geometry.attributes.color.needsUpdate = true;
  FX.points.material.uniforms.uScale.value = window.innerHeight * 0.9;
}
function spawnSlash(x, z, ang, radius, arc, color = 0xffb060, life = 0.22, heavy = false) {
  const m = new THREE.Mesh(FX.slashGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, toneMapped: false, depthWrite: false, side: THREE.DoubleSide }));
  m.position.set(x, 0.35, z);
  // RingGeometry sector starts at +X and sweeps counter-clockwise (looking down -Y after rotateX). Our facing angle: dir = (sin a, cos a).
  m.rotation.y = ang - Math.PI / 2 - arc / 2;   // sector spans [0, arc] locally; its centre must land on the facing angle
  m.scale.set(radius, 1, radius);
  m.userData = { t: 0, life, arc, heavy };
  m.geometry = new THREE.RingGeometry(heavy ? 0.35 : 0.55, 1, 28, 1, 0, arc).rotateX(-Math.PI / 2);
  scene.add(m);
  S.slashes.push(m);
}
function spawnRing(x, z, radius, color, life = 0.5, width = 0.12) {
  const m = new THREE.Mesh(new THREE.RingGeometry(1 - width, 1, 56).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false }));
  m.position.set(x, 0.06, z); m.scale.setScalar(0.3);
  m.userData = { t: 0, life, ring: true, radius };
  scene.add(m); S.slashes.push(m);
}
function updateSlashes(dt) {
  for (let i = S.slashes.length - 1; i >= 0; i--) {
    const m = S.slashes[i]; const u = m.userData; u.t += dt;
    const k = u.t / u.life;
    if (u.ring) { const s = lerp(0.3, u.radius, 1 - Math.pow(1 - k, 3)); m.scale.set(s, 1, s); m.material.opacity = 0.9 * (1 - k); }
    else { m.material.opacity = 0.85 * (1 - k * k); m.scale.multiplyScalar(1 + dt * 1.2); }
    if (k >= 1) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); S.slashes.splice(i, 1); }
  }
}

// =====================================================================
// floating damage numbers (DOM pool)
// =====================================================================
const dmgLayer = $('#dmgLayer');
const DMG_POOL = [];
for (let i = 0; i < 48; i++) { const d = document.createElement('div'); d.className = 'dmg'; dmgLayer.appendChild(d); DMG_POOL.push({ el: d, t: 1, x: 0, y: 0, z: 0 }); }
let dmgHead = 0;
function showNumber(x, y, z, text, cls = '') {
  if (!SET.numbers && cls !== 'player' && cls !== 'heal') return;
  const d = DMG_POOL[dmgHead]; dmgHead = (dmgHead + 1) % DMG_POOL.length;
  d.el.textContent = text; d.el.className = 'dmg ' + cls; d.el.style.display = 'block';
  d.t = 0; d.x = x + (Math.random() - 0.5) * 0.6; d.y = y; d.z = z;
}
const _v = new THREE.Vector3(), _lampV = new THREE.Vector3();
function updateNumbers(dt) {
  for (const d of DMG_POOL) {
    if (d.t >= 1) { if (d.el.style.display !== 'none') d.el.style.display = 'none'; continue; }
    d.t += dt * 1.25;
    _v.set(d.x, d.y + d.t * 1.4, d.z).project(camera);
    const sx = (_v.x * 0.5 + 0.5) * window.innerWidth, sy = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    d.el.style.transform = `translate(${sx}px, ${sy}px) translate(-50%,-50%) scale(${1 + (1 - d.t) * 0.3})`;
    d.el.style.opacity = String(1 - d.t * d.t);
  }
}

// =====================================================================
// weather / time of day
// =====================================================================
const TODS = ['day', 'dusk', 'night'];
const WXS = ['clear', 'rain', 'storm', 'snow'];
const W = { tod: 'day', wx: 'clear', auto: true, wxTimer: 70, lightning: 0, thunderT: 0,
  cur: {}, tgt: {} };
const C = (h) => new THREE.Color(h);
const TOD_PRESET = {
  day:   { sky: C('#cfd9e4'), fog: C('#c9d3df'), hemiSky: C('#dfe9ff'), hemiGround: C('#6d6a4e'), hemiI: 0.7, sunC: C('#fff1d8'), sunI: 2.0, sunDir: new THREE.Vector3(0.55, 1.0, 0.35), exposure: 0.95, glowWin: 0.25, glowLamp: 0.15, lamp: 0.0, ambientLift: 0.0 },
  dusk:  { sky: C('#7a5f7e'), fog: C('#8a6a80'), hemiSky: C('#f3b48c'), hemiGround: C('#4a3a4a'), hemiI: 0.38, sunC: C('#ffb072'), sunI: 1.5, sunDir: new THREE.Vector3(-0.9, 0.45, 0.4), exposure: 0.95, glowWin: 1.4, glowLamp: 1.6, lamp: 2.2, ambientLift: 0.0 },
  night: { sky: C('#15132a'), fog: C('#1a1834'), hemiSky: C('#4a5298'), hemiGround: C('#12121f'), hemiI: 0.26, sunC: C('#8fa4ff'), sunI: 0.32, sunDir: new THREE.Vector3(-0.4, 1.0, -0.5), exposure: 0.82, glowWin: 2.8, glowLamp: 3.6, lamp: 5.5, ambientLift: 0.0 },
};
const WX_PRESET = {
  clear: { rain: 0, snow: 0, cloud: 0.3, wet: 0, fogMul: 1.0, sunMul: 1.0, skyDark: 0.0, wind: 0.15 },
  rain:  { rain: 0.7, snow: 0, cloud: 0.6, wet: 0.8, fogMul: 0.7, sunMul: 0.55, skyDark: 0.25, wind: 0.4 },
  storm: { rain: 1.0, snow: 0, cloud: 0.8, wet: 1.0, fogMul: 0.5, sunMul: 0.35, skyDark: 0.45, wind: 0.9 },
  snow:  { rain: 0, snow: 1, cloud: 0.35, wet: 0, fogMul: 0.6, sunMul: 0.8, skyDark: 0.1, wind: 0.35 },
};
function weatherTarget() {
  const T = TOD_PRESET[W.tod], X = WX_PRESET[W.wx];
  const dark = new THREE.Color(0x2a2a38);
  return {
    sky: T.sky.clone().lerp(dark, X.skyDark), fog: T.fog.clone().lerp(dark, X.skyDark),
    hemiSky: T.hemiSky.clone(), hemiGround: T.hemiGround.clone(), hemiI: T.hemiI * (1 - X.skyDark * 0.4) + (W.wx === 'snow' ? 0.15 : 0),
    sunC: T.sunC.clone(), sunI: T.sunI * X.sunMul, sunDir: T.sunDir.clone(), exposure: T.exposure,
    glowWin: T.glowWin + X.skyDark * 0.8, glowLamp: T.glowLamp + X.skyDark * 0.8, lamp: T.lamp + X.skyDark * 1.5,
    rain: X.rain, snow: X.snow, cloud: X.cloud, wet: X.wet, fogNear: 45 * X.fogMul, fogFar: 130 * X.fogMul, wind: X.wind,
  };
}
function applyWeatherInstant() { W.tgt = weatherTarget(); W.cur = weatherTarget(); applyWeather(); }
function lerpColor(a, b, t) { a.lerp(b, t); }
function updateWeather(dt) {
  if (W.auto && S.phase === 'run') {
    const m = minute();
    const tod = m < 2.5 ? 'day' : m < 4.5 ? 'dusk' : m < 8.6 ? 'night' : (S.endless && m > 12 ? (m % 8 < 3 ? 'day' : m % 8 < 4.5 ? 'dusk' : 'night') : 'day');
    if (tod !== W.tod) { W.tod = tod; refreshWeatherButtons(); }
    W.wxTimer -= dt;
    if (W.wxTimer <= 0) {
      W.wxTimer = 55 + Math.random() * 50;
      const pool = W.wx === 'clear' ? ['rain', 'snow', 'clear', 'rain', 'storm'] : ['clear', 'clear', W.wx === 'rain' ? 'storm' : 'rain', 'snow'];
      W.wx = pool[Math.floor(Math.random() * pool.length)];
      refreshWeatherButtons();
    }
  }
  W.tgt = weatherTarget();
  const k = 1 - Math.pow(0.001, dt / 3);   // ~3 s to converge
  const c = W.cur, t = W.tgt;
  for (const key of ['sky', 'fog', 'hemiSky', 'hemiGround', 'sunC']) lerpColor(c[key], t[key], k);
  for (const key of ['hemiI', 'sunI', 'exposure', 'glowWin', 'glowLamp', 'lamp', 'rain', 'snow', 'cloud', 'wet', 'fogNear', 'fogFar', 'wind']) c[key] = lerp(c[key], t[key], k);
  c.sunDir.lerp(t.sunDir, k);
  // lightning
  if (W.wx === 'storm' && c.rain > 0.8) {
    W.thunderT -= dt;
    if (W.thunderT <= 0) { W.thunderT = 4 + Math.random() * 9; W.lightning = 1; AUDIO.sfx('thunder'); }
  }
  W.lightning = Math.max(0, W.lightning - dt * 3.5);
  applyWeather();
  AUDIO.setAmbience(c.rain, c.wind);
}
function applyWeather() {
  const c = W.cur;
  renderer.setClearColor(c.sky);
  scene.fog.color.copy(c.fog); scene.fog.near = c.fogNear; scene.fog.far = c.fogFar;
  hemi.color.copy(c.hemiSky); hemi.groundColor.copy(c.hemiGround); hemi.intensity = c.hemiI + W.lightning * 2.5;
  sun.color.copy(c.sunC); sun.intensity = c.sunI + W.lightning * 4;
  renderer.toneMappingExposure = c.exposure;
  setGlow('WindowGlass', 0.35 + c.glowWin); setGlow('Lantern', 0.4 + c.glowLamp); setGlow('Fire', 1.6); setGlow('HotMetal', 1.4);
  setGlow('EmberCore', 1.5); setGlow('PlayerLamp', 1.2 + c.lamp * 0.3); if (!S.cues) { setGlow('Crystal', 1.4); setGlow('ShardCrystal', 1.5); setGlow('HeartGlow', 1.5); }
  MATS.snow.opacity = c.snow;
  if ((c.snow > 0.01) !== S.snowVisible) { S.snowVisible = c.snow > 0.01; for (const k in world.sets) for (const m of world.sets[k].meshes) if (m.isSnow) m.visible = S.snowVisible; }
  ground.uniforms.uSnow.value = c.snow; ground.uniforms.uCloud.value = c.cloud; ground.uniforms.uWet.value = c.wet;
  // snow tints the vegetation
  MATS.body.color.setRGB(1 - c.snow * 0.08, 1 - c.snow * 0.05, 1 + c.snow * 0.06); MATS.tree.color.copy(MATS.body.color);
  scene.environmentIntensity = 0.06 + 0.34 * clamp(c.sunI / 2, 0, 1);
  lampLight.intensity = c.lamp * 2.2;
  S.nightK = clamp(c.lamp / 4.5, 0, 1);
  forgeLight.intensity = 2.5 + c.lamp;
  FX.rain.material.opacity = c.rain * 0.55;
  FX.snow.material.opacity = c.snow * 0.9;
  S.novaFlash = Math.max(0, (S.novaFlash || 0) - 0.02);
  $('#flash').style.opacity = String(Math.max(W.lightning * 0.5, S.novaFlash));
}
function updatePrecip(dt) {
  const c = W.cur;
  const cx = P.x, cz = P.z;
  const wind = c.wind;
  if (c.rain > 0.01) {
    const p = FX.rainPos, s = FX.rainSeed, n = FX.rainN;
    const speed = 26 + wind * 10;
    for (let i = 0; i < n; i++) {
      const life = (S.wall * speed * (0.8 + s[i * 3 + 2] * 0.4) + s[i * 3 + 1] * 40) % 40;
      const y = 40 - life;
      const x = cx - 22 + s[i * 3] * 44 + wind * 6 * (life / 40) + Math.sin(i) * 0.3, z = cz - 24 + s[i * 3 + 1] * 44;
      const len = 0.8 + wind * 0.6;
      p[i * 6] = x; p[i * 6 + 1] = y; p[i * 6 + 2] = z;
      p[i * 6 + 3] = x + wind * 0.25; p[i * 6 + 4] = y + len; p[i * 6 + 5] = z;
    }
    FX.rain.geometry.attributes.position.needsUpdate = true;
    FX.rain.geometry.setDrawRange(0, Math.floor(n * 2 * clamp(c.rain, 0, 1)));
    // splashes on the ground
    if (Math.random() < c.rain * 0.9) spawnParticle(cx + (Math.random() - 0.5) * 30, 0.05, cz + (Math.random() - 0.5) * 24, 0, 1.2, 0, 0.7, 0.8, 0.95, 0.5, 0.25, -4);
  }
  if (c.snow > 0.01) {
    const p = FX.snowPos, s = FX.snowSeed, n = FX.snowN;
    for (let i = 0; i < n; i++) {
      const t = (S.wall * (2.2 + s[i * 3 + 2] * 1.5) + s[i * 3 + 1] * 30) % 30;
      p[i * 3] = cx - 22 + s[i * 3] * 44 + Math.sin(S.wall * 0.8 + i) * 0.8 + wind * 4 * (t / 30);
      p[i * 3 + 1] = 30 - t;
      p[i * 3 + 2] = cz - 24 + s[i * 3 + 1] * 44 + Math.cos(S.wall * 0.6 + i * 0.7) * 0.6;
    }
    FX.snow.geometry.attributes.position.needsUpdate = true;
    FX.snow.geometry.setDrawRange(0, Math.floor(n * clamp(c.snow, 0, 1)));
  }
}
function refreshWeatherButtons() {
  $('#todBtn span').textContent = tr(W.tod[0].toUpperCase() + W.tod.slice(1));
  $('#wxBtn span').textContent = tr(W.wx[0].toUpperCase() + W.wx.slice(1));
  $('#autoWxBtn span').textContent = tr(W.auto ? 'Auto' : 'Manual');
}
function cycleTod() { W.tod = TODS[(TODS.indexOf(W.tod) + 1) % TODS.length]; W.auto = false; refreshWeatherButtons(); }
function cycleWx() { W.wx = WXS[(WXS.indexOf(W.wx) + 1) % WXS.length]; W.auto = false; refreshWeatherButtons(); }
function toggleAutoWx() { W.auto = !W.auto; W.wxTimer = 30; refreshWeatherButtons(); }

// =====================================================================
// input
// =====================================================================
const KEYMAP = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Space: 'dash', KeyE: 'nova', KeyQ: 'swap', KeyF: 'forge', KeyJ: 'attack', KeyK: 'heavy', Tab: 'auto', Escape: 'pause', KeyT: 'tod', KeyR: 'wx', KeyY: 'autowx', F4: 'hideui', Digit1: 'c1', Digit2: 'c2', Digit3: 'c3', Digit4: 'c4', KeyM: 'mute' };
const KEYMAP2 = { w: 'up', s: 'down', a: 'left', d: 'right', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', ' ': 'dash', e: 'nova', q: 'swap', f: 'forge', j: 'attack', k: 'heavy', tab: 'auto', escape: 'pause', t: 'tod', r: 'wx', y: 'autowx', f4: 'hideui', 1: 'c1', 2: 'c2', 3: 'c3', 4: 'c4', m: 'mute' };
window.addEventListener('keydown', (e) => {
  const a = KEYMAP[e.code] || KEYMAP2[String(e.key).toLowerCase()];
  if (!a) return;
  if (['auto', 'dash', 'hideui', 'tod', 'wx', 'autowx'].includes(a)) e.preventDefault();
  if (S.keys[a]) return;
  S.keys[a] = true;
  onAction(a);
});
window.addEventListener('keyup', (e) => { const a = KEYMAP[e.code] || KEYMAP2[String(e.key).toLowerCase()]; if (a) S.keys[a] = false; });
window.addEventListener('blur', () => { S.keys = {}; S.mouse.down = S.mouse.rdown = false; });
document.addEventListener('visibilitychange', () => { if (document.hidden && S.phase === 'run' && !S.modal) togglePause(); });
canvas.addEventListener('mousemove', (e) => { S.mouse.x = e.clientX; S.mouse.y = e.clientY; });
canvas.addEventListener('mousedown', (e) => { AUDIO.ensureAudio(); AUDIO.resume(); if (e.button === 0) S.mouse.down = true; if (e.button === 2) { S.mouse.rdown = true; onAction('heavy'); } });
window.addEventListener('mouseup', (e) => { if (e.button === 0) S.mouse.down = false; if (e.button === 2) S.mouse.rdown = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => { if (S.modal) return; camDist = clamp(camDist + Math.sign(e.deltaY) * 2.2, 15, 44); }, { passive: true });
function onAction(a) {
  AUDIO.ensureAudio();
  if (a === 'hideui') { S.hideUI = !S.hideUI; document.body.classList.toggle('hide-ui', S.hideUI); return; }
  if (a === 'mute') { toggleSound(); return; }
  if (S.modal === 'levelup') { if (/^c[1-4]$/.test(a)) pickTalent(Number(a[1]) - 1); return; }
  if (S.modal === 'forge') { if (a === 'forge' || a === 'pause') closeForge(); if (a === 'c1' || a === 'c2' || a === 'c3') { const bs = [...document.querySelectorAll('#forgeTracks .btn:not([disabled])')]; if (bs[Number(a[1]) - 1]) bs[Number(a[1]) - 1].click(); } return; }
  if (S.modal === 'pause') { if (a === 'pause' || a === 'dash') togglePause(); return; }
  if (S.modal === 'end') { if (a === 'dash') $('#endPrimary').click(); if (a === 'heavy') $('#endSecondary').click(); return; }
  if (S.phase === 'title') { if (a === 'dash') $('#startBtn').click(); return; }
  if (S.phase !== 'run' || S.modal) return;
  switch (a) {
    case 'dash': tryDash(); break;
    case 'nova': tryNova(); break;
    case 'swap': P.weapon = (P.weapon + 1) % WEAPONS.length; P.attackT = Math.min(P.attackT, 0.2); refreshWeaponCard(); AUDIO.sfx('ui'); break;
    case 'forge': if (nearForge()) openForge(); else lightShrine(nearShrine()); break;
    case 'heavy': tryHeavy(); break;
    case 'auto': P.auto = !P.auto; refreshAutoBtn(); AUDIO.sfx('ui'); break;
    case 'pause': togglePause(); break;
    case 'tod': cycleTod(); break;
    case 'wx': cycleWx(); break;
    case 'autowx': toggleAutoWx(); break;
  }
}
// touch: left-half virtual stick, right-side action buttons (only shown on coarse pointers)
function setupTouch() {
  if (S.touch || !window.matchMedia('(pointer: coarse)').matches) return;
  S.touch = { active: false, dx: 0, dy: 0, id: null, ox: 0, oy: 0 };
  document.body.classList.add('touch');
  const stick = $('#stick'), knob = $('#stickKnob');
  const R = 46;
  const start = (e) => {
    for (const t of e.changedTouches) { if (t.clientX < window.innerWidth * 0.5 && S.touch.id === null) { S.touch.id = t.identifier; S.touch.ox = t.clientX; S.touch.oy = t.clientY; S.touch.active = true; stick.style.display = 'block'; stick.style.left = (t.clientX - 60) + 'px'; stick.style.top = (t.clientY - 60) + 'px'; } }
  };
  const move = (e) => {
    for (const t of e.changedTouches) if (t.identifier === S.touch.id) {
      let dx = t.clientX - S.touch.ox, dy = t.clientY - S.touch.oy; const d = Math.hypot(dx, dy); if (d > R) { dx *= R / d; dy *= R / d; }
      S.touch.dx = dx / R; S.touch.dy = dy / R; knob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    e.preventDefault();
  };
  const end = (e) => { for (const t of e.changedTouches) if (t.identifier === S.touch.id) { S.touch.id = null; S.touch.active = false; S.touch.dx = S.touch.dy = 0; stick.style.display = 'none'; knob.style.transform = ''; } };
  canvas.addEventListener('touchstart', (e) => { AUDIO.ensureAudio(); AUDIO.resume(); start(e); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchend', () => { AUDIO.ensureAudio(); AUDIO.resume(); }, { passive: true });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end); canvas.addEventListener('touchcancel', end);
  for (const [id, act] of [['tDash', 'dash'], ['tNova', 'nova'], ['tHeavy', 'heavy'], ['tSwap', 'swap'], ['tForge', 'forge']]) {
    $('#' + id).addEventListener('touchstart', (e) => { e.preventDefault(); onAction(act); }, { passive: false });
  }
}
// gamepad: left stick moves, right stick aims (manual attack while pushed), buttons map onto the same actions
const PAD = { on: false, mx: 0, mz: 0, ax: 0, az: 0, prev: {}, aiming: false };
const PAD_BUTTONS = { 0: 'dash', 1: 'heavy', 2: 'nova', 3: 'swap', 4: 'forge', 5: 'wx', 6: 'attack', 7: 'attack', 8: 'auto', 9: 'pause', 10: 'auto', 12: 'c1', 13: 'c3', 14: 'c2', 15: 'c4' };
function pollGamepad() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  let gp = null;
  for (const p of pads) if (p && p.connected) { gp = p; break; }
  if (!gp) { if (PAD.on) { PAD.on = false; document.body.classList.remove('pad'); S.keys.attack = false; refreshPadLabels(); } PAD.mx = PAD.mz = 0; PAD.aiming = false; return; }
  if (!PAD.on) { PAD.on = true; document.body.classList.add('pad'); AUDIO.ensureAudio(); refreshPadLabels(); }
  const dz = (v) => Math.abs(v) < 0.18 ? 0 : (v - Math.sign(v) * 0.18) / 0.82;
  PAD.mx = dz(gp.axes[0] || 0); PAD.mz = dz(gp.axes[1] || 0);
  PAD.ax = dz(gp.axes[2] || 0); PAD.az = dz(gp.axes[3] || 0);
  PAD.aiming = Math.hypot(PAD.ax, PAD.az) > 0.3;
  for (const i of Object.keys(PAD_BUTTONS)) {
    const b = gp.buttons[i]; const down = !!(b && (b.pressed || b.value > 0.5));
    const a = PAD_BUTTONS[i];
    if (down && !PAD.prev[i]) { if (a === 'attack') S.keys.attack = true; else onAction(a); }
    if (!down && PAD.prev[i] && a === 'attack') S.keys.attack = false;
    PAD.prev[i] = down;
  }
}
// mouse → ground plane (y = 0)
const _ray = new THREE.Vector3(), _ndc = new THREE.Vector2();
function updateAim() {
  if (PAD.on && PAD.aiming) {
    const fwd = new THREE.Vector3(-CAM_DIR.x, 0, -CAM_DIR.z).normalize(); const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    S.aim.set(P.x + (fwd.x * -PAD.az + right.x * PAD.ax) * 6, 0, P.z + (fwd.z * -PAD.az + right.z * PAD.ax) * 6);
    return;
  }
  _ndc.set((S.mouse.x / window.innerWidth) * 2 - 1, -(S.mouse.y / window.innerHeight) * 2 + 1);
  _ray.set(_ndc.x, _ndc.y, 0.5).unproject(camera).sub(camera.position).normalize();
  const t = -camera.position.y / _ray.y;
  if (t > 0) S.aim.copy(camera.position).addScaledVector(_ray, t);
}

// =====================================================================
// UI wiring
// =====================================================================
$('#startBtn').addEventListener('click', () => { AUDIO.ensureAudio(); AUDIO.resume(); startRun(); });
for (const b of document.querySelectorAll('#diffPick .dp')) b.addEventListener('click', () => { SET.difficulty = b.dataset.d; saveSettings(); renderDiffPick(); AUDIO.sfx('ui'); });
function renderDiffPick() {
  for (const b of document.querySelectorAll('#diffPick .dp')) { const d = DIFFS[b.dataset.d]; b.classList.toggle('on', SET.difficulty === b.dataset.d); b.querySelector('.n').textContent = SET.lang === 'zh' ? d.zh : d.name; }
  const d = DIFF(); $('#diffDesc').textContent = SET.lang === 'zh' ? d.zhDesc : d.desc;
  renderWeaponPick();
}
function renderWeaponPick() {
  const box = $('#weaponPick'); if (!box) return;
  const unlockedAll = unlocked('boltstart');
  box.style.display = unlockedAll ? 'flex' : 'none'; const row = $('#weaponRow'); if (row) row.style.display = unlockedAll ? 'flex' : 'none';
  box.innerHTML = '';
  WEAPONS.forEach((w, i) => { const b = document.createElement('button'); b.className = 'dp' + (SET.startWeapon === i ? ' on' : ''); b.innerHTML = `<span class="n">${tr(w.name)}</span>`; b.addEventListener('click', () => { SET.startWeapon = i; saveSettings(); renderWeaponPick(); AUDIO.sfx('ui'); }); box.appendChild(b); });
}
$('#aboutBtn').addEventListener('click', () => { $('#about').classList.add('show'); });
$('#aboutClose').addEventListener('click', () => { $('#about').classList.remove('show'); });
$('#archiveBtn').addEventListener('click', () => { renderArchive(); $('#archive').classList.add('show'); });
$('#archiveClose').addEventListener('click', () => { $('#archive').classList.remove('show'); });
$('#autoBtn').addEventListener('click', () => onAction('auto'));
$('#swapBtn').addEventListener('click', () => onAction('swap'));
$('#todBtn').addEventListener('click', () => onAction('tod'));
$('#wxBtn').addEventListener('click', () => onAction('wx'));
$('#autoWxBtn').addEventListener('click', () => onAction('autowx'));
$('#forgeHint').addEventListener('click', () => onAction('forge'));
$('#pauseBtn').addEventListener('click', () => { if (S.phase === 'run' && (!S.modal || S.modal === 'pause')) togglePause(); });
$('#resumeBtn').addEventListener('click', () => togglePause());
$('#quitBtn').addEventListener('click', () => backToTitle());
$('#diagBtn').addEventListener('click', async () => {
  const gl = renderer.getContext(); const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const lines = [
    'Emberlight ' + (window.__emberVersion || 'dev') + ' · ' + new Date().toISOString(),
    'UA: ' + navigator.userAgent,
    'GPU: ' + (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a') + ' · ' + window.innerWidth + 'x' + window.innerHeight + ' @' + renderer.getPixelRatio(),
    'Quality ' + SET.quality + ' · fps ' + (S.fps || 0).toFixed(0) + ' · draw ' + renderer.info.render.calls + ' · tris ' + renderer.info.render.triangles,
    'Run: t=' + Math.round(S.t) + ' level=' + P.level + ' enemies=' + S.enemies.length + ' district=' + S.district.key + ' phase=' + S.phase,
    '--- last logs ---', ...(window.__emberLogs.length ? window.__emberLogs : ['(none)']),
  ];
  const text = lines.join('\n');
  try { await navigator.clipboard.writeText(text); $('#diagBtn').textContent = SET.lang === 'zh' ? '已复制' : 'Copied'; }
  catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); $('#diagBtn').textContent = 'Copied'; } catch (e2) { $('#diagBtn').textContent = 'Copy failed'; } ta.remove(); }
  setTimeout(() => { $('#diagBtn').textContent = SET.lang === 'zh' ? '复制诊断信息' : 'Copy diagnostics'; }, 2500);
});
$('#soundBtn').addEventListener('click', () => toggleSound());
$('#forgeClose').addEventListener('click', () => closeForge());
$('#forgeRest').addEventListener('click', () => forgeRest());
$('#endPrimary').addEventListener('click', () => { if (S.phase === 'won') goEndless(); else startRun(); });
$('#endSecondary').addEventListener('click', () => backToTitle());
for (const [id, key] of [['setQuality', 'quality'], ['setShake', 'shake'], ['setNumbers', 'numbers'], ['setLang', 'lang'], ['setCues', 'cues']]) {
  $('#' + id + ' .btn').addEventListener('click', () => {
    if (key === 'quality') SET.quality = SET.quality === 'high' ? 'low' : 'high';
    else if (key === 'lang') SET.lang = SET.lang === 'zh' ? 'en' : 'zh';
    else SET[key] = !SET[key];
    saveSettings(); AUDIO.sfx('ui');
    if (key === 'quality') applyQuality();
    if (key === 'cues') applyCues();
    if (key === 'lang') applyLang(); else renderSettings();
  });
}
$('#setMusic input').addEventListener('input', (e) => { SET.music = Number(e.target.value) / 100 * 0.5; AUDIO.ensureAudio(); AUDIO.musicVolume(SET.music); saveSettings(); });
$('#setSfx input').addEventListener('input', (e) => { SET.sfx = Number(e.target.value) / 100 * 0.8; AUDIO.ensureAudio(); AUDIO.sfxVolume(SET.sfx); saveSettings(); });
function toggleSound() {
  AUDIO.ensureAudio();
  AUDIO.setEnabled(!AUDIO.audioEnabled());
  $('#soundBtn').textContent = AUDIO.audioEnabled() ? tr('Sound') : tr('Sound off');
}
function refreshPadLabels() {
  const pad = PAD.on, zh = SET.lang === 'zh';
  $('#dashText b').textContent = pad ? 'A' : (zh ? '空格' : 'SPACE');
  $('#novaText b').textContent = pad ? 'X' : 'E';
  $('#swapBtn').innerHTML = `<b>${pad ? 'Y' : 'Q'}</b> ${tr('Switch weapon')}`;
  $('#autoBtn').querySelector('b').textContent = pad ? 'LS' : 'Tab';
  $('#forgeHint').innerHTML = `<b>${pad ? 'LB' : 'F'}</b> ${tr('Enter forge')}`;
  $('#padHint').textContent = zh ? '🎮 已连接手柄 · 左摇杆移动 右摇杆瞄准 A 冲刺 B 重击 X 新星 Y 换武器' : '🎮 Gamepad · left stick move · right stick aim · A dash · B heavy · X nova · Y swap';
}
function refreshAutoBtn() { const b = $('#autoBtn'); b.innerHTML = `<b>Tab</b> ${tr(P.auto ? 'Auto attack ON' : 'Auto attack OFF')}`; b.classList.toggle('on', P.auto); }
function refreshWeaponCard() {
  const w = WEAPONS[P.weapon];
  $('#wName').textContent = tr(w.name) + (P.weaponRank[w.key] ? '  ' + '★'.repeat(P.weaponRank[w.key]) : '');
  const zh = SET.lang === 'zh';
  $('#wcard .keys').innerHTML = w.type === 'orbit' ? `<b>${tr('Passive')}</b> ${tr('Orbits')} &nbsp; <b>${zh ? '右键' : 'RMB'} / K</b> ${tr('Heavy')}` : `<b>${zh ? '左键' : 'LMB'} / J</b> ${tr('Attack')} &nbsp; <b>${zh ? '右键' : 'RMB'} / K</b> ${tr('Heavy')}`;
}
function togglePause() {
  if (S.phase !== 'run') return;
  if (S.modal === 'pause') { S.modal = null; S.paused = false; $('#pause').classList.remove('show'); }
  else if (!S.modal) {
    S.modal = 'pause'; S.paused = true; $('#pause').classList.add('show');
    $('#pauseStats').innerHTML = statRows();
  }
}
function statRows() {
  return `<div>${tr('Time survived')} <b>${fmtTime(S.t)}</b></div><div>${tr('Level')} <b>${P.level}</b></div><div>${tr('Defeated')} <b>${S.stats.kills}</b></div><div>${tr('Elites')} <b>${S.stats.elites}</b></div><div>${tr('Damage dealt')} <b>${Math.round(S.stats.dmgDealt)}</b></div><div>${tr('Forge shards')} <b>${P.shards}</b></div><div>${tr('Shrines lit')} <b>${S.stats.shrines || 0} / 4</b></div><div>${tr('Elites felled')} <b>${S.stats.minis || 0} / 4</b></div>`;
}
function showBanner(text, secs = 4) { const b = $('#banner'); b.textContent = tr(text); b.classList.add('show'); S.bannerT = secs; }

// =====================================================================
// run lifecycle
// =====================================================================
function startRun() {
  P = newPlayer();
  S.phase = 'run'; S.paused = false; S.modal = null; S.t = 0; S.endless = false;
  S.recorded = false;
  S.enemies.length = 0; S.pickups.length = 0; S.projectiles.length = 0; S.eprojectiles.length = 0; S.burns.length = 0; S.timers.length = 0;
  for (const m of S.slashes) scene.remove(m); S.slashes.length = 0;
  S.spawnBudget = 0; S.eliteTimer = 45; S.bossSpawned = false; S.boss = null; wardenRig.visible = false; S.bossIntro = 0; S.slowMo = 0; S.hitStop = 0;
  S.minis = []; S.miniDone = {}; S.miniCorpses = []; S.miniWake = 0; for (const k in MINI_RIGS) MINI_RIGS[k].rig.visible = false; $('#mini').classList.remove('show');
  S.discovered = new Set(); S.lastDistrict = null;
  S.stats = { kills: 0, elites: 0, dmgDealt: 0, shrines: 0 }; S.dmgLog = {};
  initShrines(); $('#shrine').classList.remove('show'); $('#shrineHint').classList.remove('show');
  W.tod = 'day'; W.wx = 'clear'; W.auto = true; W.wxTimer = 60 + Math.random() * 30; applyWeatherInstant();
  S.bossKilled = false;
  S.guide = META.guided ? null : { step: 0, t: 0, shown: false, gap: 0 }; S.guideMoved = 0; S.forgeOpened = false; $('#guide').classList.remove('show');
  S.hpHist = []; S.lastHits = [];
  if (ANIM.p) { for (const k in ANIM.p.actions) if (!['idle', 'walk'].includes(k)) ANIM.p.actions[k].stop(); }
  if (ANIM.w) { for (const k in ANIM.w.actions) if (!['idle', 'walk', 'charge'].includes(k)) ANIM.w.actions[k].stop(); }
  S.bossCorpse = null;
  if (unlocked('tithe')) P.shards = 10;
  if (unlocked('boltstart')) { P.weapon = Math.min(WEAPONS.length - 1, SET.startWeapon | 0); P.weaponRank.bolt = 1; }
  refreshWeatherButtons(); refreshAutoBtn(); refreshWeaponCard();
  $('#title').classList.remove('show'); $('#end').classList.remove('show'); $('#pause').classList.remove('show');
  document.body.classList.remove('title');
  $('#boss').classList.remove('show');
  AUDIO.setTension(0); AUDIO.musicVolume(SET.music); AUDIO.sfxVolume(SET.sfx);
  showBanner(`${tr('THE HEARTH')}  ·  ${tr('Collect embers. Find the forge. Survive 10 minutes.')}`, 6);
  S.discovered.add('hearth');
}
function backToTitle() {
  S.phase = 'title'; S.paused = false; S.modal = null; S.t = 0; S.endless = false; S.bannerT = 0;
  $('#banner').classList.remove('show'); $('#boss').classList.remove('show'); $('#forgeHint').classList.remove('show');
  S.stats = { kills: 0, elites: 0, dmgDealt: 0 }; S.district = DISTRICTS[0];
  document.body.classList.add('title');
  for (const id of ['end', 'pause', 'forge', 'levelup', 'archive']) $('#' + id).classList.remove('show');
  $('#title').classList.add('show');
  refreshTitleBest();
  S.enemies.length = 0; S.pickups.length = 0; S.projectiles.length = 0; S.eprojectiles.length = 0; wardenRig.visible = false; S.boss = null;
  P = newPlayer();
}
function endRun(won) {
  S.phase = won ? 'won' : 'dead';
  S.paused = true; S.modal = 'end';
  if (ANIM.p) playOnce(ANIM.p, won ? 'cheer' : 'death', 1);
  playerRig.visible = true;
  saveBest();
  const fresh = S.endless && S.recorded ? [] : recordRun(won);
  S.recorded = true;
  const ul = $('#endUnlocks'); ul.innerHTML = fresh.map((u) => `<div class="unlock"><b>${tr('Unlocked')} · ${tr(u.name)}</b><span>${tr(u.gives)}</span></div>`).join('');
  $('#endTitle').textContent = tr(won ? 'Dawn breaks over the wildwood.' : 'The light went out.');
  $('#endSub').textContent = won ? tr('Ten minutes, and the valley is still here. Keep going — it only gets wilder.') : `${tr('You kept the light for')} ${fmtTime(S.t)}.`;
  $('#endStats').innerHTML = statRows();
  renderDeathReview(won);
  $('#endPrimary').textContent = tr(won ? 'Go endless  →' : 'Try again');
  $('#end').classList.add('show');
  AUDIO.sfx(won ? 'win' : 'lose');
  AUDIO.setTension(0);
}
function goEndless() { S.endless = true; S.phase = 'run'; S.paused = false; S.modal = null; $('#end').classList.remove('show'); showBanner('ENDLESS  ·  The wildwood does not end. Neither do you.', 5); }
function refreshTitleBest() { const el = $('#titleBest'); if (el) el.textContent = S.best.time > 0 ? (SET.lang === 'zh' ? `最佳战绩 ${fmtTime(S.best.time)} · 击败 ${S.best.kills}` : `Best run ${fmtTime(S.best.time)} · ${S.best.kills} defeated`) : (SET.lang === 'zh' ? '还没有记录。山谷在等你。' : 'No run yet. The valley is waiting.'); }
const SRC_NAMES = { wisp: 'an ash wisp', cinder: 'a cinder', crawler: 'a crawler', spitter: 'a spitter', spit: "a spitter's bolt", brute: 'an ash brute', boss: 'the Ash Warden', bossSlam: "the Ash Warden's slam", bossCharge: "the Ash Warden's charge", burn: 'burning ground', mini: 'a district elite', other: 'the dark' };
const SRC_ZH = { wisp: '灰烬鬼火', cinder: '灰烬', crawler: '爬行者', spitter: '吐火者', spit: '吐火者的火弹', brute: '灰烬蛮兽', boss: '灰烬守卫', bossSlam: '灰烬守卫的砸地', bossCharge: '灰烬守卫的冲锋', burn: '燃烧的地面', mini: '区域精英', other: '黑暗' };
function renderDeathReview(won) {
  const box = $('#deathReview'); box.style.display = won ? 'none' : 'block';
  if (won) return;
  const zh = SET.lang === 'zh';
  const last = S.lastHits[S.lastHits.length - 1];
  let line = '';
  if (last) {
    const nth = Math.max(1, S.lastHits.filter((h) => h.src === last.src && S.t - h.t < 10).length);
    const who = zh ? SRC_ZH[last.src] || SRC_ZH.other : SRC_NAMES[last.src] || SRC_NAMES.other;
    line = zh ? `你死于${who}的第 ${nth} 次攻击(${last.dmg} 伤害)。` : `You died to ${who} — its ${nth}${nth === 1 ? 'st' : nth === 2 ? 'nd' : nth === 3 ? 'rd' : 'th'} hit in ten seconds (${last.dmg} damage).`;
  }
  const tot = {}; for (const h of S.lastHits) if (S.t - h.t < 10) tot[h.src] = (tot[h.src] || 0) + h.dmg;
  const top = Object.entries(tot).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${zh ? SRC_ZH[k] || k : SRC_NAMES[k] || k} ${v}`).join(' · ');
  $('#deathLine').textContent = line;
  $('#deathTop').textContent = top ? (zh ? '最后十秒伤害来源:' : 'Damage in the last ten seconds: ') + top : '';
  // curve: hp over the last 12 s with hit markers
  const cv = $('#deathCurve'); const g = cv.getContext('2d'); const W2 = cv.width, H2 = cv.height;
  g.clearRect(0, 0, W2, H2);
  const hist = S.hpHist; if (!hist.length) return;
  const t1 = S.t, t0 = t1 - 12; const mx = Math.max(P.maxHp, 1);
  g.strokeStyle = 'rgba(255,255,255,.08)'; g.lineWidth = 1; for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(0, H2 * i / 4); g.lineTo(W2, H2 * i / 4); g.stroke(); }
  g.beginPath(); g.strokeStyle = '#f7c39a'; g.lineWidth = 2;
  let first = true;
  for (const [t, hp] of hist) { if (t < t0) continue; const x = (t - t0) / 12 * W2, y = H2 - clamp(hp / mx, 0, 1) * (H2 - 4) - 2; if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); }
  g.lineTo(W2, H2 - 2); g.stroke();
  g.fillStyle = 'rgba(255,90,70,.9)';
  for (const h of S.lastHits) { if (h.t < t0) continue; const x = (h.t - t0) / 12 * W2; g.fillRect(x - 1, 0, 2, H2); }
  g.fillStyle = 'rgba(243,236,223,.55)'; g.font = '10px "Source Sans 3", system-ui, sans-serif'; g.fillText(zh ? '−12 s' : '−12 s', 2, 10); g.fillText(zh ? '死亡' : 'death', W2 - 32, 10);
}
function saveBest() {
  if (S.t > S.best.time || (S.t === S.best.time && S.stats.kills > S.best.kills)) {
    S.best = { time: Math.floor(S.t), kills: S.stats.kills };
    try { localStorage.setItem('emberlight.best', JSON.stringify(S.best)); } catch (e) { /* ignore */ }
  }
}

// =====================================================================
// player actions
// =====================================================================
function nearForge() { return Math.hypot(P.x - world.forgePos.x, P.z - world.forgePos.z) < 3.8; }
// shrines: one per outer district. Light it (F) → hold the ground for 45 s at doubled spawns → district ward + shards.
const WARDS = {
  wildwood:   { key: 'wolfsbane',  name: 'Wolfsbane',  desc: 'Wisps no longer hunt in packs and hit for half.' },
  mossfall:   { key: 'stonewatch', name: 'Stonewatch', desc: 'Your attacks shatter spitter bolts; the rest sting 30% less.' },
  cinder:     { key: 'ashwalker',  name: 'Ashwalker',  desc: 'Burning ground cannot hurt you; +25% damage to cinders and brutes.' },
  silvermere: { key: 'tidewalker', name: 'Tidewalker', desc: 'Move 12% faster and dash recovers 25% sooner.' },
};
const SHRINE_HOLD = 45, SHRINE_LEASH = 18;
function initShrines() {
  S.shrines = {};
  for (const D of DISTRICTS) if (D.key !== 'hearth') S.shrines[D.key] = { key: D.key, x: D.cx, z: D.cz, state: 'idle', t: 0, cd: 0 };
  S.shrineActive = null;
}
function nearShrine() { if (!S.shrines) return null; for (const k in S.shrines) { const sh = S.shrines[k]; if (Math.hypot(P.x - sh.x, P.z - sh.z) < 3.6) return sh; } return null; }
function lightShrine(sh) {
  if (!sh || sh.state !== 'idle' || sh.cd > 0 || S.shrineActive) return;
  sh.state = 'active'; sh.t = SHRINE_HOLD; S.shrineActive = sh;
  showBanner(`${tr(DISTRICTS.find((d) => d.key === sh.key).name)}  ·  ${tr('Hold the shrine for 45 seconds.')}`, 4);
  AUDIO.sfx('district'); spawnRing(sh.x, sh.z, 6, 0xffd08a, 0.8, 0.08); burstParticles(sh.x, 2, sh.z, 40, [1, 0.7, 0.3], 4, 0.5, 0.9, -1);
  $('#shrine').classList.add('show');
}
function updateShrines(dt) {
  if (!S.shrines) return;
  for (const k in S.shrines) { const sh = S.shrines[k]; if (sh.cd > 0) sh.cd -= dt; }
  const sh = S.shrineActive;
  if (sh) {
    sh.t -= dt;
    const d = Math.hypot(P.x - sh.x, P.z - sh.z);
    if (d > SHRINE_LEASH) { sh.state = 'idle'; sh.cd = 20; S.shrineActive = null; $('#shrine').classList.remove('show'); showBanner('THE SHRINE GUTTERS OUT  ·  You strayed too far.', 3); AUDIO.sfx('lose'); }
    else if (sh.t <= 0) {
      sh.state = 'done'; S.shrineActive = null; $('#shrine').classList.remove('show');
      const w = WARDS[sh.key]; P.wards = P.wards || {}; P.wards[w.key] = true; applyWard(w.key);
      P.shards += 20;
      showBanner(`${tr('WARD GAINED')} · ${tr(w.name)}  ·  ${tr(w.desc)}`, 6);
      AUDIO.sfx('win'); spawnRing(sh.x, sh.z, 10, 0x8ff0dc, 1.0, 0.06); burstParticles(sh.x, 2, sh.z, 120, [0.55, 0.95, 0.85], 7, 0.5, 1.2, -1);
      for (let i = 0; i < 6; i++) dropPickup('ember', sh.x, sh.z, 4);
      S.stats.shrines = (S.stats.shrines || 0) + 1;
    } else {
      $('#shrineBar > i').style.transform = `scaleX(${clamp(sh.t / SHRINE_HOLD, 0, 1)})`;
      $('#shrine .name').textContent = `${tr('SHRINE')} · ${Math.ceil(sh.t)}s${d > SHRINE_LEASH - 4 ? '  ' + tr('· too far!') : ''}`;
      if (Math.random() < 0.6) spawnParticle(sh.x + (Math.random() - 0.5) * 2, 3.2, sh.z + (Math.random() - 0.5) * 2, 0, 1.2 + Math.random(), 0, 1, 0.6, 0.25, 0.4, 1.0, 0.3);
    }
  }
  const ns = nearShrine();
  $('#shrineHint').classList.toggle('show', !!ns && ns.state === 'idle' && ns.cd <= 0 && !S.shrineActive);
}
function applyWard(key) {
  if (key === 'tidewalker') { P.speedMult *= 1.12; P.dashCdMult = (P.dashCdMult || 1) * 0.75; }
}
function tryDash() {
  if (P.dashCd > 0 || P.dashT > 0) return;
  let dx = 0, dz = 0;
  const mv = moveVector();
  if (mv.len > 0.1) { dx = mv.x; dz = mv.z; } else { dx = Math.sin(P.facing); dz = Math.cos(P.facing); }
  P.dashDx = dx; P.dashDz = dz; P.dashT = 0.22 * (P.dashLen || 1); P.dashCd = 1.6 * (P.dashCdMult || 1); P.invuln = Math.max(P.invuln, 0.4 * (P.dashLen || 1));
  AUDIO.sfx('dash');
  burstParticles(P.x, 0.3, P.z, 10, [0.6, 0.95, 0.9], 3, 0.35, 0.35, -2);
}
function tryNova() {
  if (P.novaCd > 0) return;
  P.novaCd = 12 * P.novaCdMult; P.animOnce = 'nova';
  const R = 6.5 * P.areaMult;
  const dmg = 45 * dmgMult();
  let hitCount = 0;
  for (const e of S.enemies) {
    if (e.dying) continue;
    const d = Math.hypot(e.x - P.x, e.z - P.z);
    if (d < R + e.r) { hitCount++; hurtEnemy(e, dmg, true); const k = 14 / Math.max(0.5, d); e.kx += (e.x - P.x) * k / e.t.mass; e.kz += (e.z - P.z) * k / e.t.mass; e.stun = Math.max(e.stun, 0.8); }
  }
  for (const b of bigs()) if (Math.hypot(b.x - P.x, b.z - P.z) < R + b.r) hurtBig(b, dmg);
  for (const pr of S.eprojectiles) pr.dead = true;
  spawnRing(P.x, P.z, R, 0xffb060, 0.6, 0.08);
  spawnRing(P.x, P.z, R * 0.7, 0xfff0c0, 0.4, 0.2);
  burstParticles(P.x, 0.5, P.z, 90, [1.0, 0.7, 0.3], 9, 0.5, 0.8, -3);
  novaLight.position.set(P.x, 2, P.z); novaLight.intensity = 40; S.novaFlash = 0.35;
  if (hitCount >= 3) S.hitStop = 0.08;
  camShake.amp = Math.max(camShake.amp, 0.5); camShake.t = 0.4;
  AUDIO.sfx('nova');
}
function tryHeavy() {
  if (P.heavyCd > 0 || P.dashT > 0) return;
  P.heavyCd = 2.4 / P.speedTalent * (P.heavyCdMult || 1);
  P.swing = 0.35; P.animOnce = 'heavy';
  const R = 3.8 * P.areaMult;
  const dmg = 34 * dmgMult() * P.heavyMult;
  let hitCount = 0;
  for (const e of S.enemies) {
    if (e.dying) continue;
    const d = Math.hypot(e.x - P.x, e.z - P.z);
    if (d < R + e.r) { hitCount++; hurtEnemy(e, dmg, Math.random() < 0.25); const k = 9 / Math.max(0.5, d); e.kx += (e.x - P.x) * k / e.t.mass; e.kz += (e.z - P.z) * k / e.t.mass; e.stun = Math.max(e.stun, 0.6 * P.heavyMult); }
  }
  for (const b of bigs()) if (Math.hypot(b.x - P.x, b.z - P.z) < R + b.r) hurtBig(b, dmg);
  spawnSlash(P.x, P.z, P.facing, R, Math.PI * 2, 0xffd08a, 0.3, true);
  camShake.amp = Math.max(camShake.amp, 0.25); camShake.t = 0.2;
  if (hitCount >= 3) S.hitStop = 0.06;
  AUDIO.sfx('heavy');
}
function moveVector() {
  // camera-relative WASD: screen-up = away from camera (projected on ground)
  const fwd = new THREE.Vector3(-CAM_DIR.x, 0, -CAM_DIR.z).normalize();
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  let x = 0, z = 0;
  if (S.keys.up) { x += fwd.x; z += fwd.z; }
  if (S.keys.down) { x -= fwd.x; z -= fwd.z; }
  if (S.keys.right) { x += right.x; z += right.z; }
  if (S.keys.left) { x -= right.x; z -= right.z; }
  if (S.touch && S.touch.active) { x += fwd.x * -S.touch.dy + right.x * S.touch.dx; z += fwd.z * -S.touch.dy + right.z * S.touch.dx; }
  if (PAD.on && (PAD.mx || PAD.mz)) { x += fwd.x * -PAD.mz + right.x * PAD.mx; z += fwd.z * -PAD.mz + right.z * PAD.mx; }
  const len = Math.hypot(x, z);
  if (len > 0) { x /= len; z /= len; }
  return { x, z, len: Math.min(1, len) };
}
function nearestEnemy(range) {
  let best = null, bd = range * range;
  for (const e of S.enemies) { if (e.dying) continue; const d2 = (e.x - P.x) ** 2 + (e.z - P.z) ** 2; if (d2 < bd) { bd = d2; best = e; } }
  for (const b of bigs()) { if (b.burrowed) continue; const d2 = (b.x - P.x) ** 2 + (b.z - P.z) ** 2; if (d2 < bd) { bd = d2; best = b; } }
  return best;
}
function fireWeapon(dt) {
  const w = WEAPONS[P.weapon];
  const rate = w.rate / P.speedTalent;
  P.attackT -= dt;
  if (w.type === 'orbit') {
    // orbiting lanterns handle their own damage in updateOrbs
    return;
  }
  const manual = S.mouse.down || S.keys.attack || (PAD.on && PAD.aiming);
  let target = null;
  if (P.auto) target = nearestEnemy(w.type === 'melee' ? w.range * P.areaMult + 1.5 : w.range);
  if (!manual && !target) return;
  if (P.attackT > 0) return;
  P.attackT = rate;
  let ang = P.facing;
  if (target && !manual) ang = Math.atan2(target.x - P.x, target.z - P.z);
  else ang = Math.atan2(S.aim.x - P.x, S.aim.z - P.z);
  P.facing = ang;
  P.swing = 0.22;
  if (w.type === 'melee') {
    meleeSwing(w, ang, 1, true);
    if (w.key === 'crescent' && P.weaponRank.crescent >= 2) S.timers.push({ t: 0.16, fn: () => { if (S.phase === 'run') { P.swing = 0.18; meleeSwing(w, ang + Math.PI * 0.35, 0.65, false); } } });
  } else {
    const wr = P.weaponRank[w.key] || 0;
    const n = w.key === 'bolt' ? 1 + P.extraBolts + (wr >= 2 ? 1 : 0) : (wr >= 2 ? 3 : 1);
    for (let i = 0; i < n; i++) {
      const spread = n > 1 ? (i - (n - 1) / 2) * (w.key === 'bow' ? 0.22 : 0.16) : 0;
      const a = ang + spread;
      const pierce = w.pierce + (w.key === 'bolt' ? (wr >= 1 ? 1 : 0) : (wr >= 1 ? 2 : 0));
      S.projectiles.push({ x: P.x + Math.sin(a) * 0.6, z: P.z + Math.cos(a) * 0.6, y: 0.9, vx: Math.sin(a) * w.speed, vz: Math.cos(a) * w.speed, life: w.range / w.speed, dmg: w.dmg * dmgMult() * (w.key === 'bolt' ? (P.boltMult || 1) : 1), pierce, burst: w.key === 'bolt' && wr >= 3, scorch: w.key === 'bow' && wr >= 3, heavy: !!w.heavyBolt, hit: new Set() });
    }
    AUDIO.sfx('swing', 0.05);
    spawnParticle(P.x + Math.sin(ang) * 0.7, 0.9, P.z + Math.cos(ang) * 0.7, 0, 0.5, 0, 1, 0.7, 0.3, 0.6, 0.15, 0);
  }
}
function meleeSwing(w, ang, dmgScale, primary) {
  {
    const wr = P.weaponRank[w.key] || 0;
    const R = w.range * P.areaMult * (w.key === 'chain' && wr >= 2 ? 1.4 : 1), arc = w.arc * Math.sqrt(P.areaMult) * (w.key === 'crescent' && wr >= 1 ? 1.25 : 1);
    let dmg = w.dmg * dmgMult() * dmgScale;
    let comboHit = false;
    if (w.key === 'chain' && wr >= 1) { P.combo = (P.combo + 1) % 3; if (P.combo === 0) { dmg *= 2.5; comboHit = true; } }
    let hits = 0;
    const test = (e, isBoss) => {
      if (e.dying) return;
      const dx = e.x - P.x, dz = e.z - P.z, d = Math.hypot(dx, dz);
      if (d > R + e.r) return;
      let da = Math.atan2(dx, dz) - ang; da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > arc / 2 + Math.atan2(e.r, Math.max(d, 0.1))) return;
      const crit = comboHit || Math.random() < 0.12 + (P.critBonus || 0);
      if (isBoss) hurtBig(e, dmg * (crit ? 1.8 : 1), crit); else { hurtEnemy(e, dmg * (crit ? 1.8 : 1), crit); const pull = w.key === 'chain' && wr >= 3; const k = (pull ? -2.5 : 3.5) / Math.max(0.5, d); e.kx += dx * k / e.t.mass; e.kz += dz * k / e.t.mass; }
      hits++;
    };
    for (const e of S.enemies) test(e, false);
    for (const b of bigs()) test(b, true);
    if (P.wards && P.wards.stonewatch) for (const pr of S.eprojectiles) { const dx = pr.x - P.x, dz = pr.z - P.z; if (Math.hypot(dx, dz) < R + 0.4) { let da = Math.atan2(dx, dz) - ang; da = Math.atan2(Math.sin(da), Math.cos(da)); if (Math.abs(da) < arc / 2 + 0.3) pr.dead = true; } }
    spawnSlash(P.x, P.z, ang, R, arc, primary ? 0xffb060 : 0xffd9a0, primary ? 0.22 : 0.18);
    if (hits && w.key === 'crescent' && wr >= 3) { P.hp = Math.min(P.maxHp, P.hp + Math.min(hits, 3)); }
    AUDIO.sfx(hits ? 'hit' : 'swing', 0.05);
  }
}
function updateOrbs(dt) {
  const w = WEAPONS[2];
  const active = P.weapon === 2;
  const count = active ? w.count + P.extraOrbs + (P.weaponRank.lantern >= 1 ? 1 : 0) : (P.orbAlways ? 2 : 0);
  P.orbitA += dt * 2.6 * P.speedTalent;
  const R = w.radius * P.areaMult * (P.weaponRank.lantern >= 2 ? 1.3 : 1);
  P.scorchT = (P.scorchT || 0) - dt;
  for (let i = 0; i < FX.orbs.length; i++) {
    const g = FX.orbs[i];
    if (i >= count) { g.visible = false; continue; }
    g.visible = true;
    const a = P.orbitA + i * Math.PI * 2 / count;
    g.position.set(P.x + Math.sin(a) * R, 0.9 + Math.sin(S.wall * 3 + i) * 0.15, P.z + Math.cos(a) * R);
    g.rotation.y = a * 2;
    g.children[2].intensity = 1.5 + W.cur.lamp * 0.5;
    if (P.weaponRank.lantern >= 3 && P.scorchT <= 0 && i === 0) { P.scorchT = 0.35; S.burns.push({ x: g.position.x, z: g.position.z, t: 1.4 }); if (S.burns.length > 60) S.burns.shift(); }
    if (Math.random() < 0.5) spawnParticle(g.position.x, g.position.y, g.position.z, (Math.random() - 0.5), 0.8, (Math.random() - 0.5), 1, 0.6, 0.25, 0.25, 0.35, -1);
    // contact damage
    const dmg = w.dmg * dmgMult();
    for (const e of S.enemies) {
      if (e.dying) continue;
      const d = Math.hypot(e.x - g.position.x, e.z - g.position.z);
      if (d < e.r + 0.45) {
        const last = P.orbHits.get(e) || -9;
        if (S.t - last > w.rate / P.speedTalent) { P.orbHits.set(e, S.t); hurtEnemy(e, dmg, false); const k = 2 / Math.max(0.5, d); e.kx += (e.x - P.x) * k / e.t.mass; e.kz += (e.z - P.z) * k / e.t.mass; AUDIO.sfx('hit', 0.08); }
      }
    }
    for (const b of bigs()) {
      const d = Math.hypot(b.x - g.position.x, b.z - g.position.z);
      if (d < b.r + 0.45) { const last = P.orbHits.get(b) || -9; if (S.t - last > w.rate / P.speedTalent) { P.orbHits.set(b, S.t); hurtBig(b, dmg); } }
    }
  }
}
function updateProjectiles(dt) {
  for (let i = S.projectiles.length - 1; i >= 0; i--) {
    const p = S.projectiles[i];
    p.x += p.vx * dt; p.z += p.vz * dt; p.life -= dt;
    if (Math.random() < 0.7) spawnParticle(p.x, p.y, p.z, 0, 0.3, 0, 1, 0.65, 0.3, 0.3, 0.25, 0);
    let dead = p.life <= 0;
    if (!dead) {
      for (const e of S.enemies) {
        if (p.hit.has(e) || e.dying) continue;
        if ((e.x - p.x) ** 2 + (e.z - p.z) ** 2 < (e.r + 0.35) ** 2) {
          p.hit.add(e);
          const crit = Math.random() < 0.1 + (P.critBonus || 0);
          hurtEnemy(e, p.dmg * (crit ? 1.8 : 1), crit);
          const k = 2.5; e.kx += p.vx / 24 * k / e.t.mass; e.kz += p.vz / 24 * k / e.t.mass;
          AUDIO.sfx('hit', 0.05);
          if (p.burst) { burstParticles(p.x, p.y, p.z, 10, [1, 0.55, 0.2], 3, 0.35, 0.35); for (const o of S.enemies) { if (o === e || p.hit.has(o)) continue; if ((o.x - p.x) ** 2 + (o.z - p.z) ** 2 < 1.8 * 1.8) hurtEnemy(o, p.dmg * 0.5, false, true); } }
          if (p.scorch && !p.scorched) { p.scorched = true; S.burns.push({ x: p.x, z: p.z, t: 2.0 * (P.burnDur || 1) }); if (S.burns.length > 60) S.burns.shift(); }
          if (p.hit.size > p.pierce) { dead = true; break; }
        }
      }
      if (!dead) for (const b of bigs()) { if (p.hit.has(b) || b.burrowed) continue; if ((b.x - p.x) ** 2 + (b.z - p.z) ** 2 < (b.r + 0.35) ** 2) { p.hit.add(b); hurtBig(b, p.dmg); dead = true; break; } }
    }
    if (dead) { burstParticles(p.x, p.y, p.z, 4, [1, 0.6, 0.2], 2, 0.3, 0.3); S.projectiles.splice(i, 1); }
  }
  for (let i = S.eprojectiles.length - 1; i >= 0; i--) {
    const p = S.eprojectiles[i];
    p.x += p.vx * dt; p.z += p.vz * dt; p.life -= dt;
    if (Math.random() < 0.5) spawnParticle(p.x, 0.8, p.z, 0, 0.2, 0, 1, 0.35, 0.15, 0.3, 0.25, 0);
    if (!p.dead && (P.x - p.x) ** 2 + (P.z - p.z) ** 2 < (P.r + 0.35) ** 2) { hurtPlayer(p.dmg, 'spit'); p.dead = true; }
    if (p.dead || p.life <= 0) { burstParticles(p.x, 0.8, p.z, 5, [1, 0.35, 0.15], 2, 0.3, 0.3); S.eprojectiles.splice(i, 1); }
  }
}
function hurtPlayer(raw, src = 'other') {
  if (P.invuln > 0 || P.dashT > 0 || S.phase !== 'run') return;
  let scaled = raw * DIFF().dmg;
  if (P.wards && P.wards.wolfsbane && src === 'wisp') scaled *= 0.5;
  if (P.wards && P.wards.stonewatch && src === 'spit') scaled *= 0.7;
  if (P.eliteRes && (src === 'brute' || src.startsWith('boss'))) scaled *= 1 - P.eliteRes;
  const dmg = Math.max(1, Math.round(scaled * (1 - armour())));
  S.lastHits.push({ src, dmg, t: S.t }); if (S.lastHits.length > 12) S.lastHits.shift();
  S.dmgLog[src] = (S.dmgLog[src] || 0) + dmg;
  P.hp -= dmg; P.invuln = 0.6 + (P.invBonus || 0); P.hitFlash = 0.2; if (!P.animOnce) P.animOnce = 'hurt';
  if (P.shell) { const sd = 10 * P.shell * dmgMult(); for (const e of S.enemies) { if (!e.dying && (e.x - P.x) ** 2 + (e.z - P.z) ** 2 < 9) { hurtEnemy(e, sd, false, true); const d = Math.hypot(e.x - P.x, e.z - P.z) || 0.5; e.kx += (e.x - P.x) / d * 4 / e.t.mass; e.kz += (e.z - P.z) / d * 4 / e.t.mass; } } spawnRing(P.x, P.z, 3, 0xff8a4a, 0.35, 0.15); }
  showNumber(P.x, 1.6, P.z, '-' + dmg, 'player');
  $('#hurt').style.opacity = '1'; setTimeout(() => { $('#hurt').style.opacity = '0'; }, 120);
  camShake.amp = Math.max(camShake.amp, 0.3); camShake.t = 0.25;
  AUDIO.sfx('hurt', 0.1);
  burstParticles(P.x, 0.8, P.z, 8, [1, 0.4, 0.3], 3, 0.3, 0.4);
  if (P.hp <= 0) { P.hp = 0; endRun(false); }
}
function gainXp(n) {
  P.xp += n * (1 + 0.1 * P.forge.charm);
  while (P.xp >= P.xpNext && !S.modal && S.phase === 'run') {
    P.xp -= P.xpNext; P.level++;
    P.xpNext = Math.round(12 + (P.level - 1) * 7 + Math.pow(P.level - 1, 1.6) * 1.4);
    openLevelUp();
    break;   // one modal at a time; leftover xp is kept
  }
}

// =====================================================================
// level-up modal
// =====================================================================
let luOptions = [];
function rollTalents() {
  const avail = TALENTS.filter((t) => (P.talents[t.key] || 0) < t.max
    && !(t.key === 'twin' && P.weapon !== 1 && Math.random() < 0.5)
    && !(t.key === 'tongue' && P.weapon !== 1 && Math.random() < 0.6)
    && !(t.key === 'wind' && P.noRegen)
    && !(t.keystone && (P.keystone || P.level < 3)));
  const nOpt = unlocked('fourth') ? 4 : 3;
  const out = [];
  // weighted draw: commons 1, rares 0.55, keystones 0.35 (and at most one keystone per roll)
  const pool = avail.map((t) => ({ t, w: t.keystone ? 0.35 : (t.rare ? 0.55 : 1) }));
  while (out.length < nOpt && pool.length) {
    let sum = 0; for (const p of pool) sum += p.w;
    let r = Math.random() * sum, idx = 0;
    for (let i = 0; i < pool.length; i++) { r -= pool[i].w; if (r <= 0) { idx = i; break; } }
    const pick = pool.splice(idx, 1)[0].t;
    out.push(pick);
    if (pick.keystone) for (let i = pool.length - 1; i >= 0; i--) if (pool[i].t.keystone) pool.splice(i, 1);
  }
  return out;
}
function openLevelUp() {
  S.modal = 'levelup'; S.paused = true;
  luOptions = rollTalents();
  $('#luSub').textContent = `${tr('Choose a talent. Your run is paused.')}  [ ${luOptions.map((_, i) => i + 1).join(' / ')} ]`;
  $('#luTitle').textContent = `${tr('Level')} ${pad2(P.level)}. ${tr(LEVEL_NAMES[Math.min(LEVEL_NAMES.length - 1, P.level - 2)])}`;
  const box = $('#luChoices'); box.innerHTML = '';
  luOptions.forEach((t, i) => {
    const b = document.createElement('button'); b.className = 'choice' + (t.keystone ? ' keystone' : (t.rare ? ' rare' : ''));
    const tag = t.keystone ? `<em>${tr('Keystone')}</em>` : (t.rare ? `<em>${tr('Rare')}</em>` : '');
    b.innerHTML = `<div class="t">${i + 1} &nbsp;${tr(t.name)}<small>${(P.talents[t.key] || 0) + 1}/${t.max}</small>${tag}</div><div class="d">${tr(t.desc)}</div>`;
    b.addEventListener('click', () => pickTalent(i));
    box.appendChild(b);
  });
  $('#levelup').classList.add('show');
  AUDIO.sfx('levelup');
  if (S.autoTalent) { pickTalent(Math.floor(Math.random() * luOptions.length)); return; }
  spawnRing(P.x, P.z, 4, 0x8ff0dc, 0.8, 0.1);
}
function pickTalent(i) {
  const t = luOptions[i]; if (!t) return;
  P.talents[t.key] = (P.talents[t.key] || 0) + 1;
  t.apply(P); P.animOnce = 'cheer';
  $('#levelup').classList.remove('show'); S.modal = null; S.paused = false;
  AUDIO.sfx('ui');
  burstParticles(P.x, 0.8, P.z, 30, [0.55, 0.95, 0.85], 4, 0.4, 0.6, -2);
  if (P.xp >= P.xpNext) S.timers.push({ t: 0.3, fn: () => gainXp(0) });
}

// =====================================================================
// forge modal
// =====================================================================
function openForge() {
  S.modal = 'forge'; S.paused = true; S.forgeOpened = true;
  renderForge();
  $('#forge').classList.add('show');
  AUDIO.sfx('ui');
}
function closeForge() { $('#forge').classList.remove('show'); S.modal = null; S.paused = false; }
function renderForge() {
  $('#forgeShards').textContent = `${P.shards} ${tr('shards')}`;
  $('#forge .modal > .sub').firstChild.textContent = SET.lang === 'zh' ? '用锻造币换永久强化。 ' : 'Spend forge shards on permanent upgrades. ';
  const box = $('#forgeTracks'); box.innerHTML = '';
  for (const f of FORGE) {
    const rank = P.forge[f.key];
    const cost = f.costs[rank];
    const row = document.createElement('div'); row.className = 'track';
    const pips = [0, 1, 2].map((i) => `<i class="${i < rank ? 'on' : ''}"></i>`).join('');
    row.innerHTML = `<div class="k">${tr(f.name)}<span class="pips">${pips}</span></div><div class="d">${tr(f.desc)}</div>`;
    const b = document.createElement('button'); b.className = 'btn';
    if (rank >= 3) { b.textContent = tr('Maxed'); b.disabled = true; }
    else { b.textContent = `${tr('Forge')} · ${cost}`; b.disabled = P.shards < cost; b.addEventListener('click', () => { if (P.shards >= cost) { P.shards -= cost; P.forge[f.key]++; AUDIO.sfx('forge'); renderForge(); burstParticles(P.x, 1, P.z, 20, [1, 0.6, 0.2], 3, 0.35, 0.5); } }); }
    row.appendChild(b); box.appendChild(row);
  }
  const hdr = document.createElement('div'); hdr.className = 'sub'; hdr.style.margin = '18px 0 4px'; hdr.textContent = tr('Weapons — the smith reworks each blade in three stages.'); box.appendChild(hdr);
  for (const w of WEAPONS) {
    const up = WEAPON_UPGRADES[w.key];
    const rank = P.weaponRank[w.key];
    const cost = up.costs[rank];
    const row = document.createElement('div'); row.className = 'track';
    const pips = [0, 1, 2].map((i) => `<i class="${i < rank ? 'on' : ''}"></i>`).join('');
    const next = rank < 3 ? `${tr('Next:')} <b>${tr(up.ranks[rank])}</b>` : `<b>${tr(up.ranks[2])}</b>`;
    row.innerHTML = `<div class="k">${tr(w.name.split(' ')[1] || w.name)}<span class="pips">${pips}</span></div><div class="d">${next}</div>`;
    const b = document.createElement('button'); b.className = 'btn';
    if (rank >= 3) { b.textContent = tr('Maxed'); b.disabled = true; }
    else { b.textContent = `${tr('Forge')} · ${cost}`; b.disabled = P.shards < cost; b.addEventListener('click', () => { if (P.shards >= cost) { P.shards -= cost; P.weaponRank[w.key]++; AUDIO.sfx('forge'); renderForge(); refreshWeaponCard(); burstParticles(P.x, 1, P.z, 20, [1, 0.6, 0.2], 3, 0.35, 0.5); } }); }
    row.appendChild(b); box.appendChild(row);
  }
  $('#forgeRest').disabled = P.shards < 5 || P.hp >= P.maxHp;
  $('#forgeRest').style.opacity = $('#forgeRest').disabled ? '.45' : '1';
}
function forgeRest() { if (P.shards >= 5 && P.hp < P.maxHp) { P.shards -= 5; P.hp = P.maxHp; AUDIO.sfx('heart'); showNumber(P.x, 1.6, P.z, tr('Rested'), 'heal'); renderForge(); } }

// =====================================================================
// enemies
// =====================================================================
const enemyGrid = new Grid(4);
const _near = [];
function spawnEnemy(type, x, z, opts = {}) {
  const t = ETYPES[type];
  const hpScale = (1 + 0.16 * minute()) * (opts.hpMul || 1) * (S.endless ? 1.35 : 1) * DIFF().hp;
  const e = { type, t, x, z, hp: t.hp * hpScale, maxHp: t.hp * hpScale, r: t.r, kx: 0, kz: 0, stun: 0, atkCd: 0.6 + Math.random() * 0.5, flash: 0, face: 0, bob: Math.random() * 6, shootCd: 1 + Math.random() * 2, lungeCd: 2, lungeT: 0, scale: opts.scale || (t.elite ? 1.1 : 1.0 + Math.random() * 0.3), dead: false, spawnT: 0.4 };
  S.enemies.push(e);
  return e;
}
function spawnAround(type, opts) {
  for (let k = 0; k < 8; k++) {
    const a = Math.random() * Math.PI * 2, d = 26 + Math.random() * 8;
    let x = P.x + Math.cos(a) * d, z = P.z + Math.sin(a) * d;
    const r = Math.hypot(x, z);
    if (r > PLAY_R - 3) { x *= (PLAY_R - 3) / r; z *= (PLAY_R - 3) / r; }
    if (Math.hypot(x - P.x, z - P.z) < 14) continue;
    const e = spawnEnemy(type, x, z, opts);
    collideStatic(e, world.obstacles, e.r);
    return e;
  }
  return null;
}
function mixFor() {
  const m = minute();
  const D = S.district.key;
  const w = { wisp: 6, cinder: m > 0.6 ? 4 + m : 0, crawler: m > 1.5 ? 2 + m * 0.5 : 0, spitter: m > 2.5 ? 1 + m * 0.2 : 0 };
  if (D === 'wildwood') w.wisp *= 1.6;
  if (D === 'mossfall') w.spitter *= 2.2;
  if (D === 'silvermere') w.crawler *= 2.2;
  if (D === 'cinder') { w.cinder *= 1.8; w.wisp *= 0.6; }
  if (D === 'hearth') w.wisp *= 1.2;
  return w;
}
function pickType(w) { let s = 0; for (const k in w) s += w[k]; let r = Math.random() * s; for (const k in w) { r -= w[k]; if (r <= 0) return k; } return 'wisp'; }
function updateSpawner(dt) {
  const m = minute();
  const shrineActive = S.shrineActive;
  const rate = (0.55 + m * 0.3 + (S.endless ? 0.8 : 0)) * DIFF().spawn * (S.district.key === 'hearth' ? 0.8 : 1) * (S.district.key === 'cinder' ? 1.2 : 1) * (shrineActive ? 2.0 : 1);
  const cap = Math.min(260, 28 + m * 14 + (S.endless ? 50 : 0));
  S.spawnBudget += rate * dt;
  const w = mixFor();
  while (S.spawnBudget >= 1 && S.enemies.length < cap) {
    S.spawnBudget -= 1;
    const type = pickType(w);
    // packs
    const n = type === 'wisp' && !(P.wards && P.wards.wolfsbane) ? 2 + Math.floor(Math.random() * 2) : 1;
    const e = spawnAround(type, { hpMul: S.district.key === 'cinder' ? 1.2 : 1 });
    if (e && n > 1) for (let i = 1; i < n; i++) { const a = Math.random() * 6.28; spawnEnemy(type, e.x + Math.cos(a) * 1.5, e.z + Math.sin(a) * 1.5); }
  }
  S.eliteTimer -= dt;
  if (S.eliteTimer <= 0 && m > 1.8) {
    S.eliteTimer = Math.max(22, 50 - m * 2.5) * DIFF().elite;
    const e = spawnAround('brute', { hpMul: 1 });
    if (e) { showBanner('AN ASH BRUTE PROWLS NEARBY', 3); AUDIO.sfx('roar'); }
  }
  if (!S.bossSpawned && S.t >= BOSS_AT_FN() && !S.endless) spawnBoss();
  if (S.endless && !S.boss && S.t > BOSS_AT_FN() && (S.t - BOSS_AT_FN()) % 240 < dt) spawnBoss();
}
function updateEnemies(dt) {
  enemyGrid.clear();
  for (const e of S.enemies) if (!e.dying) enemyGrid.insert(e);
  const px = P.x, pz = P.z;
  for (let i = S.enemies.length - 1; i >= 0; i--) {
    const e = S.enemies[i];
    if (e.dead) { S.enemies.splice(i, 1); continue; }
    if (e.dying) { e.dying -= dt; if (e.dying <= 0) { e.dead = true; S.enemies.splice(i, 1); } continue; }
    e.spawnT = Math.max(0, e.spawnT - dt);
    e.flash = Math.max(0, e.flash - dt * 6);
    e.stun = Math.max(0, e.stun - dt);
    e.atkCd -= dt; e.bob += dt * 6;
    const dx = px - e.x, dz = pz - e.z;
    const d = Math.hypot(dx, dz) || 0.001;
    const nx = dx / d, nz = dz / d;
    let sp = e.t.speed * (0.9 + 0.1 * Math.sin(e.bob)) * (1 + minute() * 0.02) * DIFF().speed;
    let mx = nx, mz = nz;
    if (e.t.ranged) {
      if (d < 7) { mx = -nx; mz = -nz; sp *= 0.8; } else if (d < 10) { mx = nz; mz = -nx; sp *= 0.5; }
      e.shootCd -= dt;
      if (e.shootCd <= 0 && d < 12) { e.shootCd = 3.0 + Math.random() * 1.2; const v = 9; S.eprojectiles.push({ x: e.x + nx * 0.6, z: e.z + nz * 0.6, vx: nx * v, vz: nz * v, life: 1.9, dmg: e.t.dmg }); AUDIO.sfx('spit', 0.15); }
    }
    if (e.type === 'brute' && d < 9) { const st = Math.sin(e.bob * 0.6); if (st > 0.98 && !e.stomped) { e.stomped = true; camShake.amp = Math.max(camShake.amp, 0.12); camShake.t = 0.12; burstParticles(e.x, 0.1, e.z, 6, [0.5, 0.45, 0.4], 2, 0.3, 0.4); } else if (st < 0.9) e.stomped = false; }
    if (e.t.lunge) {
      e.lungeCd -= dt;
      if (e.lungeT > 0) { e.lungeT -= dt; sp *= 2.6; }
      else if (e.lungeWarn > 0) { e.lungeWarn -= dt; sp *= 0.15; if (e.lungeWarn <= 0) e.lungeT = 0.45; }
      else if (e.lungeCd <= 0 && d < 6 && d > 2) { e.lungeCd = 3.2; e.lungeWarn = 0.3; }
    }
    if (e.stun > 0) sp *= 0.1;
    if (e.windup > 0) sp *= 0.2;
    if (e.lungeWarn > 0 && !e.t.lunge) e.lungeWarn -= dt;
    // separation
    enemyGrid.query(e.x, e.z, 2.5, _near);
    let sx = 0, sz = 0;
    for (const o of _near) { if (o === e) continue; const ox = e.x - o.x, oz = e.z - o.z; const od2 = ox * ox + oz * oz; const rr = e.r + o.r; if (od2 < rr * rr && od2 > 1e-4) { const od = Math.sqrt(od2); const f = (rr - od) / od; sx += ox * f; sz += oz * f; } }
    e.x += (mx * sp + sx * 4) * dt + e.kx * dt; e.z += (mz * sp + sz * 4) * dt + e.kz * dt;
    e.kx *= Math.pow(0.02, dt); e.kz *= Math.pow(0.02, dt);
    collideStatic(e, world.obstacles, e.r * 0.8);
    e.face = Math.atan2(mx, mz);
    // contact damage
    if (e.type === 'brute') {
      if (e.windup > 0) { e.windup -= dt; if (e.windup <= 0) { if (d < e.r + P.r + 0.9) hurtPlayer(e.t.dmg * (S.endless ? 1.25 : 1), e.type); e.atkCd = 1.4; } }
      else if (d < e.r + P.r + 0.3 && e.atkCd <= 0 && e.stun <= 0) { e.windup = 0.35; e.lungeWarn = 0.35; }
    }
    else if (d < e.r + P.r + 0.15 && e.atkCd <= 0 && e.stun <= 0) { e.atkCd = 1.0; hurtPlayer(e.t.dmg * (S.endless ? 1.25 : 1), e.type); }
    // burning ground
    if (S.burns.length) for (const b of S.burns) { if ((e.x - b.x) ** 2 + (e.z - b.z) ** 2 < 1.2) { e.burnT = (e.burnT || 0) + dt; if (e.burnT > 0.25) { e.burnT = 0; hurtEnemy(e, 5 * dmgMult() * (P.burnMult || 1), false, true); } } }
  }
}
function hurtEnemy(e, dmg, crit = false, quiet = false) {
  if (e.dead || e.dying) return;
  if (P.wards && P.wards.ashwalker && (e.type === 'cinder' || e.type === 'brute')) dmg *= 1.25;
  e.hp -= dmg; e.flash = 1;
  if (P.leech) P.hp = Math.min(P.maxHp, P.hp + dmg * P.leech);
  S.stats.dmgDealt += dmg;
  if (!quiet) showNumber(e.x, 1.2 * e.scale, e.z, String(Math.round(dmg)), crit ? 'crit' : '');
  if (crit && !quiet) AUDIO.sfx('crit', 0.1);
  burstParticles(e.x, 0.6, e.z, crit ? 10 : 4, [1, 0.55, 0.2], 2.5, 0.3, 0.35);
  if (e.hp <= 0) killEnemy(e);
}
function killEnemy(e) {
  e.dying = 0.18; e.hp = 0;
  S.stats.kills++;
  if (e.t.elite) { S.stats.elites++; camShake.amp = Math.max(camShake.amp, 0.35); camShake.t = 0.3; }
  AUDIO.sfx('kill', 0.06);
  burstParticles(e.x, 0.5, e.z, e.t.elite ? 60 : 14, [0.25, 0.2, 0.28], e.t.elite ? 6 : 3.5, 0.5, 0.7);
  burstParticles(e.x, 0.6, e.z, e.t.elite ? 30 : 6, [1, 0.5, 0.15], 3, 0.35, 0.5);
  // drops
  const n = e.t.elite ? 6 : (Math.random() < 0.25 ? 2 : 1);
  for (let i = 0; i < n; i++) dropPickup('ember', e.x, e.z, e.t.xp);
  const shardChance = e.t.elite ? 1 : e.t.shards * P.luck * 0.9;
  if (e.t.elite) { for (let i = 0; i < Math.round(e.t.shards * P.luck); i++) dropPickup('shard', e.x, e.z, 1); }
  else if (Math.random() < shardChance) dropPickup('shard', e.x, e.z, 1);
  if (e.t.elite || Math.random() < 0.04 * (P.heartMult || 1)) dropPickup('heart', e.x, e.z, 25);
  if (P.kindling && Math.random() < P.kindling) dropPickup('ember', e.x, e.z, e.t.xp);
}
function dropPickup(kind, x, z, value) {
  const a = Math.random() * Math.PI * 2, r = 0.3 + Math.random() * 1.2;
  S.pickups.push({ kind, x: x + Math.cos(a) * r, z: z + Math.sin(a) * r, value, t: 0, y: 0.6, vy: 3 + Math.random() * 2, magnet: false, spin: Math.random() * 6 });
  if (S.pickups.length > 700) S.pickups.splice(0, S.pickups.length - 700);
}
function updatePickups(dt) {
  const pr = pickupR();
  for (let i = S.pickups.length - 1; i >= 0; i--) {
    const p = S.pickups[i];
    p.t += dt; p.spin += dt * 3;
    if (p.y > 0 || p.vy > 0) { p.vy -= 12 * dt; p.y += p.vy * dt; if (p.y <= 0) { p.y = 0; p.vy = 0; } }
    const dx = P.x - p.x, dz = P.z - p.z; const d = Math.hypot(dx, dz);
    if (d < pr || p.magnet) { p.magnet = true; const sp = 14 + (pr - d) * 2; p.x += dx / d * sp * dt; p.z += dz / d * sp * dt; }
    if (d < 0.7) {
      S.pickups.splice(i, 1);
      if (p.kind === 'ember') { gainXp(p.value); P.xpTotal = (P.xpTotal || 0) + p.value; AUDIO.sfx('ember', 0.04); spawnParticle(p.x, 0.6, p.z, 0, 2, 0, 0.5, 0.95, 0.85, 0.5, 0.3, 0); }
      else if (p.kind === 'shard') { P.shards += p.value; AUDIO.sfx('shard', 0.05); spawnParticle(p.x, 0.6, p.z, 0, 2, 0, 1, 0.7, 0.3, 0.6, 0.35, 0); }
      else { const heal = P.leech ? Math.round(p.value / 2) : p.value; P.hp = Math.min(P.maxHp, P.hp + heal); showNumber(P.x, 1.6, P.z, '+' + heal, 'heal'); AUDIO.sfx('heart'); burstParticles(P.x, 0.8, P.z, 12, [0.6, 1, 0.75], 2, 0.35, 0.5, -1); }
    }
  }
}
function updateBurns(dt) {
  for (let i = S.burns.length - 1; i >= 0; i--) { const b = S.burns[i]; b.t -= dt;
    if (b.hostile && !(P.wards && P.wards.ashwalker) && (P.x - b.x) ** 2 + (P.z - b.z) ** 2 < 1.4) { P.burnT = (P.burnT || 0) + dt; if (P.burnT > 0.5) { P.burnT = 0; hurtPlayer(6, 'burn'); } } if (Math.random() < 0.4) spawnParticle(b.x + (Math.random() - 0.5), 0.1, b.z + (Math.random() - 0.5), 0, 1.5, 0, 1, 0.5, 0.15, 0.4, 0.5, 0); if (b.t <= 0) S.burns.splice(i, 1); }
}

// =====================================================================
// boss: the Ash Warden
// =====================================================================
function spawnBoss() {
  S.bossSpawned = true; S.bossCorpse = null;
  if (ANIM.w) ANIM.w.actions.death.stop();
  const a = Math.random() * Math.PI * 2;
  let x = P.x + Math.cos(a) * 22, z = P.z + Math.sin(a) * 22;
  const r = Math.hypot(x, z); if (r > PLAY_R - 4) { x *= (PLAY_R - 4) / r; z *= (PLAY_R - 4) / r; }
  const hp = (2600 + minute() * 180) * (S.endless ? 1.5 : 1);
  S.boss = { boss: true, x, z, r: 1.4, hp, maxHp: hp, phase: 'intro', pt: 1.7, phase2: false, secondCharge: false, flash: 0, face: 0, kx: 0, kz: 0, dashDx: 0, dashDz: 0, atkCd: 1, summoned: [false, false], t: { mass: 30, dmg: 24 }, dead: false, bob: 0 };
  wardenRig.visible = true;
  $('#boss').classList.add('show'); $('#boss .name').textContent = tr('THE ASH WARDEN');
  S.bossIntro = 1.7; P.invuln = Math.max(P.invuln, 2.2);
  showBanner('THE ASH WARDEN STIRS', 5);
  spawnRing(x, z, 5, 0x3a2a22, 1.6, 0.35);
  for (let i = 0; i < 4; i++) S.timers.push({ t: 0.25 * i, fn: () => spawnRing(x, z, 3 + i * 2.5, 0xff6a3d, 0.7, 0.08) });
  AUDIO.sfx('roar'); AUDIO.setTension(1);
  camShake.amp = 0.6; camShake.t = 0.8;
  burstParticles(x, 1, z, 120, [1, 0.45, 0.15], 8, 0.6, 1.2);
  spawnRing(x, z, 8, 0xff6a3d, 0.9, 0.06);
}
const bigs = () => (S.boss ? [S.boss] : []).concat(S.minis || []);
function hurtBig(b, dmg, crit = false) { if (b === S.boss) hurtBoss(dmg, crit); else hurtMini(b, dmg, crit); }
function hurtBoss(dmg, crit = false) {
  const b = S.boss; if (!b || b.dead) return;
  b.hp -= dmg; b.flash = 1; S.stats.dmgDealt += dmg;
  if (dmg >= 60 && !b.animOnce && S.t - (b.hurtAt || -9) > 1.6 && b.phase !== 'intro') { b.animOnce = 'hurt'; b.hurtAt = S.t; }
  showNumber(b.x, 3.6, b.z, String(Math.round(dmg)), crit ? 'crit' : '');
  burstParticles(b.x, 1.6, b.z, 5, [1, 0.5, 0.2], 3, 0.35, 0.4);
  if (b.hp <= 0) {
    b.dead = true; S.boss = null; S.stats.elites++; S.stats.kills++; S.bossKilled = true;
    S.bossCorpse = { t: 3.2 }; if (ANIM.w) { setBase(ANIM.w, 0); ANIM.w.actions.charge.setEffectiveWeight(0); playOnce(ANIM.w, 'death', 1); }
    $('#boss').classList.remove('show');
    burstParticles(b.x, 1.5, b.z, 260, [1, 0.5, 0.15], 10, 0.7, 1.5);
    burstParticles(b.x, 1.5, b.z, 120, [0.3, 0.25, 0.35], 7, 0.6, 1.2);
    spawnRing(b.x, b.z, 12, 0xffd08a, 1.2, 0.05);
    for (let i = 0; i < 14; i++) dropPickup('ember', b.x, b.z, 6);
    for (let i = 0; i < 14; i++) dropPickup('shard', b.x, b.z, 1);
    dropPickup('heart', b.x, b.z, 60);
    showBanner('THE ASH WARDEN FALLS  ·  The valley breathes again.', 6);
    camShake.amp = 0.9; camShake.t = 0.9; S.slowMo = 2.5;
    for (let i = 1; i <= 6; i++) S.timers.push({ t: i * 0.12, fn: () => { burstParticles(b.x, 1 + i * 0.4, b.z, 40, [1, 0.6 + i * 0.05, 0.2], 5 + i, 0.5, 1.0); spawnRing(b.x, b.z, 4 + i * 2, 0xffd08a, 0.6, 0.05); } });
    AUDIO.sfx('slam'); AUDIO.setTension(0.3);
  }
}
// district elites: one per outer district, wakes ~8 s after you first arrive (from 1:15 on), two signature moves each
const MINIS = {
  wildwood:   { key: 'wolfking',   kit: 'WolfKing',   pre: 'M1_', name: 'THE WOLF KING',         hp: 900,  dmg: 18, speed: 5.0, r: 1.1, scale: 1.05, moves: ['pounce', 'howl'] },
  mossfall:   { key: 'sentinel',   kit: 'Sentinel',   pre: 'M2_', name: 'THE STONE SENTINEL',    hp: 1500, dmg: 24, speed: 2.4, r: 1.25, scale: 1.0, moves: ['slam', 'shards'] },
  cinder:     { key: 'salamander', kit: 'Salamander', pre: 'M3_', name: 'THE CINDER SALAMANDER', hp: 1100, dmg: 16, speed: 4.4, r: 1.1, scale: 1.05, moves: ['flame', 'spit'] },
  silvermere: { key: 'maw',        kit: 'Maw',        pre: 'M4_', name: 'THE SILVERMERE MAW',    hp: 1350, dmg: 22, speed: 2.9, r: 1.3, scale: 1.0, moves: ['engulf', 'burrow'] },
};
const MINI_RIGS = {};
function buildMiniRigs() {
  for (const k in MINIS) { const d = MINIS[k]; const rig = mergeRig(kit.rigs[d.kit].clone(true)); rig.visible = false; scene.add(rig); MINI_RIGS[k] = { rig, anim: makeRigAnimator(rig, d.pre) }; }
}
function spawnMini(distKey) {
  const d = MINIS[distKey]; if (!d) return null;
  if (S.minis.some((m) => m.key === d.key) || (S.miniDone && S.miniDone[d.key])) return null;
  const a = Math.random() * Math.PI * 2;
  let x = P.x + Math.cos(a) * 18, z = P.z + Math.sin(a) * 18;
  const r = Math.hypot(x, z); if (r > PLAY_R - 4) { x *= (PLAY_R - 4) / r; z *= (PLAY_R - 4) / r; }
  const hp = (d.hp + minute() * 90) * DIFF().hp * (S.endless ? 1.4 : 1);
  const m = { mini: true, key: d.key, def: d, x, z, r: d.r, hp, maxHp: hp, face: 0, flash: 0, kx: 0, kz: 0, t: { mass: 12, dmg: d.dmg }, atkCd: 1, moveCd: 3.5, moveIdx: 0, phase: 'chase', pt: 0, burrowed: false, speedMul: 1, buffT: 0, dead: false, animOnce: 'special', bob: 0 };
  S.minis.push(m);
  const R = MINI_RIGS[distKey]; R.rig.visible = true; R.rig.position.set(x, 0, z); R.rig.scale.setScalar(d.scale);
  for (const k in R.anim.actions) if (!['idle', 'walk'].includes(k)) R.anim.actions[k].stop();
  setBase(R.anim, 0);
  m.rigKey = distKey;
  showBanner(tr(d.name) + '  ·  ' + tr('wakes'), 4); AUDIO.sfx('roar');
  spawnRing(x, z, 6, 0xc48aff, 0.9, 0.08); burstParticles(x, 1, z, 60, [0.75, 0.5, 1], 6, 0.5, 1.0);
  $('#mini').classList.add('show'); $('#mini .name').textContent = tr(d.name);
  return m;
}
function hurtMini(m, dmg, crit = false) {
  if (!m || m.dead || m.burrowed) return;
  m.hp -= dmg; m.flash = 1; S.stats.dmgDealt += dmg;
  if (P.leech) P.hp = Math.min(P.maxHp, P.hp + dmg * P.leech);
  showNumber(m.x, 2.4, m.z, String(Math.round(dmg)), crit ? 'crit' : '');
  burstParticles(m.x, 1.2, m.z, 4, [0.8, 0.5, 1], 3, 0.3, 0.4);
  if (m.hp <= 0) killMini(m);
}
function killMini(m) {
  m.dead = true; S.minis.splice(S.minis.indexOf(m), 1);
  S.miniDone = S.miniDone || {}; S.miniDone[m.key] = true;
  S.stats.elites++; S.stats.kills++; S.stats.minis = (S.stats.minis || 0) + 1;
  META.bestiary = META.bestiary || {}; if (!META.bestiary[m.key]) { META.bestiary[m.key] = new Date().toISOString().slice(0, 10); saveMeta(); showBanner(tr('FIRST KILL') + ' · ' + tr(m.def.name), 5); }
  else showBanner(tr(m.def.name) + '  ·  ' + tr('falls'), 4);
  const R = MINI_RIGS[m.rigKey]; setBase(R.anim, 0); playOnce(R.anim, 'death', 1); m.corpseT = 3;
  S.miniCorpses = S.miniCorpses || []; S.miniCorpses.push(m);
  for (let i = 0; i < 10; i++) dropPickup('ember', m.x, m.z, 4);
  for (let i = 0; i < 8; i++) dropPickup('shard', m.x, m.z, 1);
  dropPickup('heart', m.x, m.z, 40);
  burstParticles(m.x, 1.2, m.z, 150, [0.8, 0.5, 1], 8, 0.6, 1.3); spawnRing(m.x, m.z, 9, 0xc48aff, 0.9, 0.06);
  camShake.amp = 0.6; camShake.t = 0.6; AUDIO.sfx('slam');
  if (!S.minis.length) $('#mini').classList.remove('show');
}
function updateMinis(dt) {
  if (S.miniCorpses) for (let i = S.miniCorpses.length - 1; i >= 0; i--) { const m = S.miniCorpses[i]; m.corpseT -= S.dtRaw; MINI_RIGS[m.rigKey].anim.mixer.update(S.dtRaw); if (m.corpseT <= 0) { MINI_RIGS[m.rigKey].rig.visible = false; S.miniCorpses.splice(i, 1); } }
  // wake the district elite a few seconds after arrival
  if (S.t > 75 && S.district.key !== 'hearth' && !S.minis.length && !(S.miniDone && S.miniDone[MINIS[S.district.key].key])) {
    S.miniWake = (S.miniWake || 0) + dt; if (S.miniWake > 8) { S.miniWake = 0; spawnMini(S.district.key); }
  } else S.miniWake = 0;
  for (const m of S.minis) {
    const d0 = m.def; const R = MINI_RIGS[m.rigKey]; const A = R.anim;
    m.flash = Math.max(0, m.flash - dt * 6); m.bob += dt; m.atkCd -= dt; m.moveCd -= dt; m.buffT -= dt;
    const dx = P.x - m.x, dz = P.z - m.z, d = Math.hypot(dx, dz) || 0.001, nx = dx / d, nz = dz / d;
    let walking = false;
    const sp = d0.speed * DIFF().speed * (m.buffT > 0 ? 1.35 : 1);
    if (m.phase === 'chase') {
      if (d > m.r + P.r + 0.2) { m.x += nx * sp * dt; m.z += nz * sp * dt; walking = true; }
      m.face = Math.atan2(nx, nz);
      if (d < m.r + P.r + 0.4 && m.atkCd <= 0) { m.atkCd = 1.3; hurtPlayer(d0.dmg, 'mini'); m.animOnce = 'attack'; }
      if (m.moveCd <= 0 && d < 22) { const mv = d0.moves[m.moveIdx % 2]; m.moveIdx++; m.moveCd = 5.5; startMiniMove(m, mv, nx, nz); }
    } else if (m.phase === 'tele') {
      m.pt -= dt; m.face = Math.atan2(nx, nz);
      if (m.pt <= 0) resolveMiniMove(m, nx, nz, d);
    } else if (m.phase === 'dash') {
      m.pt -= dt; m.x += m.dx * m.dashSp * dt; m.z += m.dz * m.dashSp * dt; walking = true;
      if (m.move === 'flame' && Math.random() < 0.8) { S.burns.push({ x: m.x, z: m.z, t: 3 * (P.burnDur || 1), hostile: true }); if (S.burns.length > 70) S.burns.shift(); }
      if (d < m.r + P.r + 0.6 && m.atkCd <= 0) { m.atkCd = 1.0; hurtPlayer(m.move === 'pounce' ? 28 : 14, 'mini'); }
      if (m.pt <= 0) { m.phase = 'chase'; }
    } else if (m.phase === 'engulf') {
      m.pt -= dt; if (d < 9 && d > m.r + 0.5) { P.x -= nx * 6 * dt; P.z -= nz * 6 * dt; }
      if (m.pt <= 0) { m.phase = 'chase'; if (d < m.r + 1.6) { hurtPlayer(30, 'mini'); m.animOnce = 'attack'; } }
    } else if (m.phase === 'burrow') {
      m.pt -= dt; m.burrowed = true; R.rig.visible = false;
      if (m.pt <= 0) { m.phase = 'chase'; m.burrowed = false; const a = Math.random() * Math.PI * 2; m.x = P.x + Math.cos(a) * 4; m.z = P.z + Math.sin(a) * 4; R.rig.visible = true; spawnRing(m.x, m.z, 4, 0x8fd0a0, 0.6, 0.1); burstParticles(m.x, 0.5, m.z, 40, [0.5, 0.6, 0.4], 5, 0.5, 0.8); m.atkCd = 0.4; }
    }
    if (m.phase !== 'burrow') collideStatic(m, world.obstacles, m.r * 0.8);
    const rr = Math.hypot(m.x, m.z); if (rr > PLAY_R - 2) { m.x *= (PLAY_R - 2) / rr; m.z *= (PLAY_R - 2) / rr; }
    // rig
    R.rig.position.set(m.x, 0, m.z); R.rig.rotation.y = m.face;
    setBase(A, walking ? 1 : 0, 1.2 * (m.buffT > 0 ? 1.4 : 1));
    if (m.animOnce) { playOnce(A, m.animOnce, m.animOnce === 'attack' ? 1.4 : 1); m.animOnce = null; }
    A.mixer.update(dt);
    R.rig.traverse((o) => { if (o.isMesh && o.material.emissive) o.material.emissive.setRGB(m.flash * 0.7, m.flash * 0.4, m.flash * 0.9); });
  }
  if (S.minis.length) { const m = S.minis[0]; $('#minibar > i').style.transform = `scaleX(${clamp(m.hp / m.maxHp, 0, 1)})`; }
}
function startMiniMove(m, mv, nx, nz) {
  m.move = mv; m.animOnce = 'special';
  if (mv === 'pounce' || mv === 'flame') { m.phase = 'tele'; m.pt = mv === 'pounce' ? 0.5 : 0.4; m.dx = nx; m.dz = nz; spawnRing(m.x, m.z, 3, 0xff8a4a, 0.5, 0.15); }
  else if (mv === 'howl') { m.phase = 'tele'; m.pt = 0.8; }
  else if (mv === 'slam') { m.phase = 'tele'; m.pt = 0.9; spawnRing(m.x, m.z, 4.5, 0xff4a2a, 0.9, 0.35); }
  else if (mv === 'shards' || mv === 'spit') { m.phase = 'tele'; m.pt = 0.5; }
  else if (mv === 'engulf') { m.phase = 'engulf'; m.pt = 1.3; spawnRing(m.x, m.z, 9, 0x8fd0a0, 1.3, 0.05); }
  else if (mv === 'burrow') { m.phase = 'burrow'; m.pt = 1.6; burstParticles(m.x, 0.5, m.z, 40, [0.5, 0.6, 0.4], 5, 0.5, 0.8); }
}
function resolveMiniMove(m, nx, nz, d) {
  const mv = m.move; m.phase = 'chase';
  if (mv === 'pounce') { m.phase = 'dash'; m.pt = 0.45; m.dashSp = 22; m.dx = nx; m.dz = nz; AUDIO.sfx('dash'); }
  else if (mv === 'flame') { m.phase = 'dash'; m.pt = 0.75; m.dashSp = 13; m.dx = nx; m.dz = nz; AUDIO.sfx('dash'); }
  else if (mv === 'howl') { for (let k = 0; k < 4; k++) { const a = k / 4 * Math.PI * 2; spawnEnemy('wisp', m.x + Math.cos(a) * 2.5, m.z + Math.sin(a) * 2.5); } m.buffT = 6; AUDIO.sfx('roar'); spawnRing(m.x, m.z, 7, 0xffd08a, 0.6, 0.08); }
  else if (mv === 'slam') { if (d < 4.5 + P.r) hurtPlayer(30, 'mini'); for (const e of S.enemies) { const ed = Math.hypot(e.x - m.x, e.z - m.z); if (ed < 4.5) { e.kx += (e.x - m.x) / ed * 8; e.kz += (e.z - m.z) / ed * 8; } } spawnRing(m.x, m.z, 4.5, 0xff6a3d, 0.5, 0.1); burstParticles(m.x, 0.5, m.z, 60, [0.6, 0.6, 0.55], 7, 0.5, 0.8); camShake.amp = 0.5; camShake.t = 0.4; AUDIO.sfx('slam'); }
  else if (mv === 'shards') { for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; S.eprojectiles.push({ x: m.x + Math.sin(a) * 1.2, z: m.z + Math.cos(a) * 1.2, vx: Math.sin(a) * 9, vz: Math.cos(a) * 9, life: 1.8, dmg: 10 }); } AUDIO.sfx('spit'); }
  else if (mv === 'spit') { for (let k = -1; k <= 1; k++) { const a = Math.atan2(nx, nz) + k * 0.28; S.eprojectiles.push({ x: m.x + Math.sin(a) * 1.2, z: m.z + Math.cos(a) * 1.2, vx: Math.sin(a) * 10, vz: Math.cos(a) * 10, life: 1.8, dmg: 12 }); } AUDIO.sfx('spit'); }
}
function updateBoss(dt) {
  if (S.bossCorpse) { S.bossCorpse.t -= S.dtRaw; ANIM.w.mixer.update(S.dtRaw); if (S.bossCorpse.t <= 0) { S.bossCorpse = null; wardenRig.visible = false; } }
  const b = S.boss; if (!b) return;
  b.flash = Math.max(0, b.flash - dt * 6); b.bob += dt;
  const dx = P.x - b.x, dz = P.z - b.z, d = Math.hypot(dx, dz) || 0.001, nx = dx / d, nz = dz / d;
  b.pt -= dt;
  FX.tele.material.opacity = 0; FX.teleRing.material.opacity = 0;
  switch (b.phase) {
    case 'intro': {
      b.face = Math.atan2(nx, nz);
      if (Math.random() < 0.6) burstParticles(b.x, 1.5, b.z, 3, [1, 0.5, 0.15], 4, 0.45, 0.8);
      if (b.pt <= 0) { b.phase = 'chase'; b.pt = 2.5; }
      break;
    }
    case 'chase': {
      const sp = (3.4 + minute() * 0.08) * (b.phase2 ? 1.3 : 1);
      b.x += nx * sp * dt; b.z += nz * sp * dt; b.face = Math.atan2(nx, nz);
      if (d < b.r + P.r + 0.3 && b.atkCd <= 0) { b.atkCd = 1.2; hurtPlayer(b.t.dmg, 'boss'); }
      b.atkCd -= dt;
      if (b.pt <= 0) { b.phase = d < 7 ? 'slamTele' : 'chargeTele'; b.pt = b.phase === 'slamTele' ? 0.9 : 0.75; b.dashDx = nx; b.dashDz = nz; }
      break;
    }
    case 'slamTele': {
      const R = 6;
      FX.tele.position.set(b.x, 0.04, b.z); FX.tele.scale.setScalar(R); FX.tele.material.opacity = 0.18 + 0.12 * Math.sin(S.wall * 20);
      FX.teleRing.position.set(b.x, 0.05, b.z); FX.teleRing.scale.setScalar(R * (1 - b.pt / 0.9)); FX.teleRing.material.opacity = 0.7;
      if (b.pt <= 0) {
        b.phase = 'recover'; b.pt = 1.1;
        if (d < R + P.r) hurtPlayer(30, 'bossSlam');
        spawnRing(b.x, b.z, R, 0xff6a3d, 0.5, 0.1); burstParticles(b.x, 0.5, b.z, 80, [1, 0.45, 0.15], 8, 0.5, 0.8);
        if (b.phase2) for (let i = 0; i < 3; i++) { const a = b.face + (i - 1) * 1.1; S.burns.push({ x: b.x + Math.sin(a) * 3.2, z: b.z + Math.cos(a) * 3.2, t: 4, hostile: true }); }
        for (const e of S.enemies) { const ed = Math.hypot(e.x - b.x, e.z - b.z); if (ed < R) { e.kx += (e.x - b.x) / ed * 10; e.kz += (e.z - b.z) / ed * 10; } }
        camShake.amp = 0.7; camShake.t = 0.5; AUDIO.sfx('slam');
      }
      break;
    }
    case 'chargeTele': {
      b.face = Math.atan2(b.dashDx, b.dashDz);
      const L = 16;
      FX.tele.position.set(b.x + b.dashDx * L / 2, 0.04, b.z + b.dashDz * L / 2); FX.tele.scale.set(2.2, 1, L / 2); FX.tele.rotation.y = b.face; FX.tele.material.opacity = 0.2;
      if (b.pt <= 0) { b.phase = 'charge'; b.pt = 0.55; AUDIO.sfx('roar'); }
      break;
    }
    case 'charge': {
      const sp = 26;
      b.x += b.dashDx * sp * dt; b.z += b.dashDz * sp * dt;
      const r = Math.hypot(b.x, b.z); if (r > PLAY_R - 2) { b.x *= (PLAY_R - 2) / r; b.z *= (PLAY_R - 2) / r; b.pt = 0; }
      if (Math.random() < 0.8) burstParticles(b.x, 0.4, b.z, 3, [1, 0.5, 0.2], 2, 0.4, 0.4);
      if (d < b.r + P.r + 0.5) hurtPlayer(25, 'bossCharge');
      if (b.pt <= 0) {
        if (b.phase2 && !b.secondCharge) { b.secondCharge = true; b.dashDx = nx; b.dashDz = nz; b.phase = 'chargeTele'; b.pt = 0.45; }
        else { b.secondCharge = false; b.phase = 'recover'; b.pt = 0.8; }
      }
      break;
    }
    case 'recover': {
      if (b.pt <= 0) { b.phase = 'chase'; b.pt = 2.5 + Math.random() * 2; }
      break;
    }
  }
  // summon at 60% / 30%
  const frac = b.hp / b.maxHp;
  if (!b.phase2 && frac < 0.3 && b.phase !== 'intro' && DIFF().phase2) {
    b.phase2 = true; b.r = 1.6; b.animOnce = 'rage';
    $('#boss .name').textContent = tr('THE ASH WARDEN · BURNING');
    showBanner('THE WARDEN BURNS BRIGHTER', 4); AUDIO.sfx('roar');
    burstParticles(b.x, 1.5, b.z, 120, [1, 0.5, 0.15], 8, 0.6, 1.2); spawnRing(b.x, b.z, 9, 0xffb060, 0.8, 0.06);
    camShake.amp = 0.6; camShake.t = 0.5; S.hitStop = 0.12;
  }
  for (let i = 0; i < 2; i++) {
    const th = i === 0 ? 0.6 : 0.3;
    if (frac < th && !b.summoned[i]) { b.summoned[i] = true; for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; spawnEnemy(k % 2 ? 'wisp' : 'cinder', b.x + Math.cos(a) * 3, b.z + Math.sin(a) * 3); } showBanner('THE WARDEN CALLS ITS KIN', 3); AUDIO.sfx('roar'); b.animOnce = 'summon'; }
  }
  collideStatic(b, world.obstacles, 1.0);
  // rig pose
  wardenRig.position.set(b.x, 0, b.z);
  wardenRig.rotation.y = b.face;
  const body = wardenRig.getObjectByName('W_Body'), armR = wardenRig.getObjectByName('W_ArmR'), armL = wardenRig.getObjectByName('W_ArmL'), head = wardenRig.getObjectByName('W_Head');
  const s = 1.15 * (b.phase2 ? 1.15 : 1);
  wardenRig.scale.setScalar(s);
  if (b.phase2 && Math.random() < 0.5) spawnParticle(b.x + (Math.random() - 0.5) * 1.5, 1 + Math.random() * 2, b.z + (Math.random() - 0.5) * 1.5, 0, 1.5, 0, 1, 0.5, 0.15, 0.4, 0.6, 0.5);
  void body; void armR; void armL; void head;
  const A = ANIM.w;
  const ph = b.phase;
  setBase(A, ph === 'chase' ? 1 : 0, 1.1 * (b.phase2 ? 1.3 : 1));
  const chargeW = (ph === 'charge' || ph === 'chargeTele') ? 1 : 0;
  A.actions.charge.setEffectiveWeight(lerp(A.actions.charge.getEffectiveWeight(), chargeW, 1 - Math.pow(0.001, dt * 5)));
  if (b.animOnce) { playOnce(A, b.animOnce, b.animOnce === 'hurt' ? 1.3 : 1); b.animOnce = null; }
  if (ph !== b.animPhase) {
    b.animPhase = ph;
    if (ph === 'intro') playOnce(A, 'roar', 1.67 / 1.7);
    else if (ph === 'slamTele') playOnce(A, 'slam', 0.79 / 0.9);   // arms come down exactly when the telegraph ends
  }
  A.mixer.update(S.bossIntro > 0 ? S.dtRaw : dt);
  wardenRig.traverse((o) => { if (o.isMesh && o.material.emissive) o.material.emissive.setRGB(b.flash * 0.9, b.flash * 0.5, b.flash * 0.3); });
  $('#bossbar > i').style.transform = `scaleX(${clamp(b.hp / b.maxHp, 0, 1)})`;
}

// =====================================================================
// player update
// =====================================================================
function updatePlayer(dt) {
  if (P.xp >= P.xpNext && !S.modal) gainXp(0);
  P.invuln = Math.max(0, P.invuln - dt); P.hitFlash = Math.max(0, P.hitFlash - dt);
  P.dashCd = Math.max(0, P.dashCd - dt); P.heavyCd = Math.max(0, P.heavyCd - dt); P.novaCd = Math.max(0, P.novaCd - dt);
  P.swing = Math.max(0, P.swing - dt);
  if (P.regen > 0 && !P.noRegen) P.hp = Math.min(P.maxHp, P.hp + P.regen * dt);
  const mv = moveVector();
  let sp = moveSpeed();
  let dx = mv.x, dz = mv.z;
  if (P.dashT > 0) {
    P.dashT -= dt; dx = P.dashDx; dz = P.dashDz; sp = moveSpeed() * 3.6;
    if (P.fireTrail) { P.trailT -= dt; if (P.trailT <= 0) { P.trailT = 0.06; S.burns.push({ x: P.x, z: P.z, t: 2.5 * (P.burnDur || 1) }); } }
    burstParticles(P.x, 0.4, P.z, 2, [0.55, 0.95, 0.85], 1.5, 0.3, 0.3, -1);
  }
  P.x += dx * sp * dt; P.z += dz * sp * dt;
  if (S.guide) S.guideMoved = (S.guideMoved || 0) + Math.hypot(dx, dz) * sp * dt;
  P.moving = lerp(P.moving, mv.len > 0 || P.dashT > 0 ? 1 : 0, 1 - Math.pow(0.001, dt));
  collideStatic(P, world.obstacles, P.r);
  // facing: toward aim when idle / manual, toward movement when auto & moving and no target
  updateAim();
  if (S.mouse.down || S.keys.attack || !P.auto || (PAD.on && PAD.aiming)) P.facing = Math.atan2(S.aim.x - P.x, S.aim.z - P.z);
  else if (mv.len > 0 && P.attackT > 0.1) P.facing = Math.atan2(dx, dz);
  fireWeapon(dt);
  updateOrbs(dt);
  // district discovery
  const D = districtAt(P.x, P.z);
  if (D !== S.district) {
    S.district = D;
    if (!S.discovered.has(D.key)) { S.discovered.add(D.key); showBanner(`${tr(D.name)}  ·  ${tr(D.intro)}`, 5); AUDIO.sfx('district'); }
  }
  // rig pose
  playerRig.position.set(P.x, 0, P.z);
  playerRig.rotation.y = P.facing;
  P.bob += dt * (8 + P.moving * 6);
  const body = playerRig.getObjectByName('P_Body'), armL = playerRig.getObjectByName('P_ArmL'), armR = playerRig.getObjectByName('P_ArmR'), head = playerRig.getObjectByName('P_Head'), lan = playerRig.getObjectByName('P_Lantern');
  void body; void armL; void armR; void head;
  const A = ANIM.p;
  setBase(A, clamp(P.moving, 0, 1), (0.9 + 0.35 * P.speedMult) * (P.dashT > 0 ? 2.2 : 1));
  const ONCE_SPEED = { heavy: 1.15, nova: 1.0, hurt: 1.25, cheer: 1.0, look: 1.0 };
  if (P.animOnce) { playOnce(A, P.animOnce, ONCE_SPEED[P.animOnce] || 1); P.animOnce = null; }
  else if (P.swing > (P.swingPrev || 0) + 0.02) { const rate = WEAPONS[P.weapon].rate / P.speedTalent; playOnce(A, 'attack', 0.583 / Math.max(0.3, Math.min(0.7, rate))); }
  if (P.dashT > (P.dashPrev || 0) + 0.05) playOnce(A, 'dash', 0.5 / 0.3);
  P.swingPrev = P.swing; P.dashPrev = P.dashT;
  // idle curiosity: glance at the lantern now and then
  if (P.moving < 0.05 && S.enemies.length < 6) { P.lookT = (P.lookT == null ? 4 : P.lookT) - dt; if (P.lookT <= 0) { P.lookT = 7 + Math.random() * 7; if (!A.actions.attack.isRunning()) playOnce(A, 'look', 1); } }
  else P.lookT = Math.max(P.lookT || 0, 2.5);
  A.mixer.update(dt);
  lan.rotation.x = Math.sin(P.bob * 0.7) * 0.25 * (0.3 + P.moving);
  playerRig.traverse((o) => { if (o.isMesh && o.material.emissive) o.material.emissive.setRGB(P.hitFlash * 3, P.hitFlash * 1.2, P.hitFlash * 1.2); });
  playerRig.visible = !(P.invuln > 0 && Math.floor(S.wall * 20) % 2 === 0 && P.dashT <= 0);
  lan.getWorldPosition(_lampV); lampLight.position.lerp(_lampV, 1 - Math.pow(0.001, dt * 6)); lampLight.position.y = Math.max(0.6, lampLight.position.y);
  FX.playerRing.position.set(P.x, 0.03, P.z);
  FX.playerRing.material.opacity = 0.35 + 0.25 * Math.sin(S.wall * 4);
  // forge hint
  $('#forgeHint').classList.toggle('show', nearForge());
  FX.forgeRing.material.opacity = nearForge() ? 0.6 : 0.25;
}

// =====================================================================
// render dynamic instanced sets
// =====================================================================
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s3 = new THREE.Vector3(), _p3 = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _col = new THREE.Color();
const _qx = new THREE.Quaternion(), _ax = new THREE.Vector3(1, 0, 0), _az = new THREE.Vector3(0, 0, 1), _gcol = new THREE.Color();
const _qL = new THREE.Quaternion(), _mL = new THREE.Matrix4(), _mR = new THREE.Matrix4(), _zero = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
function renderEnemies() {
  for (const k in enemySets) enemySets[k].begin();
  for (const e of S.enemies) {
    const set = enemySets[e.type];
    const sc = e.scale * (e.spawnT > 0 ? 1 - e.spawnT / 0.4 : 1) * (1 + e.flash * 0.15);
    let hop = e.t.lunge ? 0 : Math.abs(Math.sin(e.bob)) * 0.12;
    let sy = 1, sxz = 1;
    if (e.dying) { const k = 1 - e.dying / 0.18; sy = 1 - k * 0.9; sxz = 1 + k * 0.8; hop = 0; }
    else if (e.lungeWarn > 0) { sy = 1.15; sxz = 0.85; }
    else if (e.type === 'brute') { const st = Math.sin(e.bob * 0.6); sy = 1 + Math.max(0, st) * 0.09; sxz = 1 - Math.max(0, st) * 0.04; hop = Math.max(0, st) * 0.18; }
    else if (e.type === 'spitter' && e.shootCd < 0.5 && e.shootCd > 0) { const k = 1 - e.shootCd / 0.5; sy = 1 - k * 0.18; sxz = 1 + k * 0.22; }
    _p3.set(e.x, hop, e.z);
    _q.setFromAxisAngle(_up, e.face);
    if (e.type === 'wisp') { _qx.setFromAxisAngle(_ax, 0.25); _q.multiply(_qx); _p3.y = 0.25 + Math.sin(e.bob * 1.3) * 0.15; }
    else { _qx.setFromAxisAngle(_az, Math.sin(e.bob) * 0.08); _q.multiply(_qx); }
    _s3.set(sc * (1 - hop * 0.5) * sxz, sc * (1 + hop) * sy, sc * (1 - hop * 0.5) * sxz);
    _m4.compose(_p3, _q, _s3);
    _col.setRGB(1 + e.flash * 4, 1 + e.flash * 3, 1 + e.flash * 3);
    if (e.type === 'crawler') {
      // legs scuttle: left and right groups swing opposite ways around the body axis, faster while lunging
      const rate = e.lungeT > 0 ? 3.2 : 1.0, amp = e.stun > 0 ? 0.05 : 0.32;
      const a = Math.sin(e.bob * 2.2 * rate) * amp;
      _qL.setFromAxisAngle(_up, a); _mL.compose(_zero, _qL, _one); _mL.premultiply(_m4);
      _qL.setFromAxisAngle(_up, -a); _mR.compose(_zero, _qL, _one); _mR.premultiply(_m4);
      set.push(_m4, _col, _gcol, _mL, _mR);
      continue;
    }
    let eye = e.lungeWarn > 0 ? 2.5 : (e.dying ? 0.2 : 1);
    if (S.nightK > 0.2) { const dl = Math.hypot(e.x - P.x, e.z - P.z); if (dl < 7) eye *= 1 + S.nightK * 0.9 * (1 - dl / 7); }
    _gcol.setRGB(eye, eye, eye);
    set.push(_m4, _col, _gcol);
  }
  for (const k in enemySets) enemySets[k].end();
}
function renderPickups() {
  for (const k in pickupSets) pickupSets[k].begin();
  for (const p of S.pickups) {
    _p3.set(p.x, p.y + Math.sin(p.spin) * 0.08 + 0.05, p.z);
    _q.setFromAxisAngle(_up, p.spin);
    const sc = (p.kind === 'ember' ? 0.75 : 0.9) * (S.cues && p.kind === 'heart' ? 1.25 + Math.sin(p.spin * 2) * 0.15 : 1);
    _s3.setScalar(sc); _m4.compose(_p3, _q, _s3);
    pickupSets[p.kind].push(_m4);
  }
  for (const k in pickupSets) pickupSets[k].end();
  boltSet.begin();
  for (const p of S.projectiles) { _p3.set(p.x, p.y, p.z); _q.setFromAxisAngle(_up, Math.atan2(p.vx, p.vz)); _qx.setFromAxisAngle(_ax, Math.PI / 2); _q.multiply(_qx); if (p.heavy) _s3.set(0.5, 0.5, 2.6); else _s3.set(0.6, 0.6, 1.4); _m4.compose(_p3, _q, _s3); boltSet.push(_m4); }
  boltSet.end();
  spitSet.begin();
  for (const p of S.eprojectiles) { _p3.set(p.x, 0.8, p.z); _q.setFromAxisAngle(_up, S.wall * 5); _s3.setScalar(0.7); _m4.compose(_p3, _q, _s3); spitSet.push(_m4); }
  spitSet.end();
}

// =====================================================================
// minimap
// =====================================================================
const mm = $('#minimap'), mmCtx = mm.getContext('2d');
let mmBg = null;
function buildMinimapBg() {
  mmBg = document.createElement('canvas'); mmBg.width = mmBg.height = 300;
  const g = mmBg.getContext('2d');
  const R = 300 / 2, sc = (R - 14) / ISLAND_R;
  g.fillStyle = 'rgba(20,14,30,1)'; g.fillRect(0, 0, 300, 300);
  // water
  g.fillStyle = '#2e5b78'; g.beginPath(); g.arc(R, R, ISLAND_R * sc + 8, 0, Math.PI * 2); g.fill();
  // island districts
  const cols = { hearth: '#7f9f58', wildwood: '#4f8a4a', mossfall: '#7b9d7c', cinder: '#5c4f4b', silvermere: '#8fae86' };
  for (let y = 0; y < 300; y += 2) for (let x = 0; x < 300; x += 2) {
    const wx = (x - R) / sc, wz = (y - R) / sc;
    const r = Math.hypot(wx, wz);
    if (r > ISLAND_R) continue;
    const D = districtAt(wx, wz);
    g.fillStyle = cols[D.key];
    if (vnoise(wx * 0.3, wz * 0.3) > 0.62) g.fillStyle = shade(cols[D.key], -12);
    g.fillRect(x, y, 2, 2);
  }
  // roads
  g.strokeStyle = 'rgba(230,214,190,.75)'; g.lineWidth = 2.5; g.lineCap = 'round';
  for (const pts of ROADS) { g.beginPath(); pts.forEach((p, i) => { const x = R + p[0] * sc, y = R + p[1] * sc; if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); }
  // landmarks
  for (const l of world.landmarks) {
    const x = R + l.x * sc, y = R + l.z * sc;
    if (l.kind === 'house' || l.kind === 'tower') { g.fillStyle = '#f0dcc0'; g.fillRect(x - 2, y - 2, 4, 4); }
    else if (l.kind === 'shrine') { /* drawn live in drawMinimap */ }
  }
  mm.width = mm.height = 300;
}
function shade(hex, d) { const n = parseInt(hex.slice(1), 16); const r = clamp((n >> 16) + d, 0, 255), gg = clamp(((n >> 8) & 255) + d, 0, 255), b = clamp((n & 255) + d, 0, 255); return `rgb(${r},${gg},${b})`; }
function drawMinimap() {
  if (!mmBg) return;
  const R = 150, sc = (R - 14) / ISLAND_R;
  mmCtx.clearRect(0, 0, 300, 300);
  mmCtx.drawImage(mmBg, 0, 0);
  // enemies
  mmCtx.fillStyle = 'rgba(255,120,80,.9)';
  for (const e of S.enemies) { mmCtx.fillRect(R + e.x * sc - 1, R + e.z * sc - 1, 2, 2); }
  if (S.boss) { mmCtx.fillStyle = '#ff4a2a'; mmCtx.beginPath(); mmCtx.arc(R + S.boss.x * sc, R + S.boss.z * sc, 5 + Math.sin(S.wall * 8) * 1.5, 0, Math.PI * 2); mmCtx.fill(); mmCtx.strokeStyle = 'rgba(255,120,80,.6)'; mmCtx.beginPath(); mmCtx.arc(R + S.boss.x * sc, R + S.boss.z * sc, 9 + Math.sin(S.wall * 4) * 3, 0, Math.PI * 2); mmCtx.stroke(); }
  // shrines: blinking until lit, pulsing while active, solid teal when done
  if (S.shrines) for (const k in S.shrines) { const sh = S.shrines[k]; const x = R + sh.x * sc, y = R + sh.z * sc;
    if (sh.state === 'done') { mmCtx.fillStyle = '#8ff0dc'; mmCtx.beginPath(); mmCtx.arc(x, y, 3.5, 0, Math.PI * 2); mmCtx.fill(); }
    else if (sh.state === 'active') { mmCtx.strokeStyle = '#ffd08a'; mmCtx.lineWidth = 2; mmCtx.beginPath(); mmCtx.arc(x, y, 5 + Math.sin(S.wall * 6) * 2, 0, Math.PI * 2); mmCtx.stroke(); }
    else if (Math.sin(S.wall * 3) > -0.2) { mmCtx.fillStyle = '#ffb347'; mmCtx.beginPath(); mmCtx.arc(x, y, 3.5, 0, Math.PI * 2); mmCtx.fill(); } }
  for (const m of (S.minis || [])) { if (m.burrowed) continue; mmCtx.fillStyle = '#c48aff'; mmCtx.beginPath(); mmCtx.arc(R + m.x * sc, R + m.z * sc, 4 + Math.sin(S.wall * 6) * 1.2, 0, Math.PI * 2); mmCtx.fill(); }
  // forge marker
  mmCtx.fillStyle = '#ffd08a'; mmCtx.beginPath(); mmCtx.arc(R + world.forgePos.x * sc, R + world.forgePos.z * sc, 3.5, 0, Math.PI * 2); mmCtx.fill();
  // player
  mmCtx.fillStyle = '#8ff0dc'; mmCtx.beginPath(); mmCtx.arc(R + P.x * sc, R + P.z * sc, 4.5, 0, Math.PI * 2); mmCtx.fill();
  mmCtx.strokeStyle = 'rgba(143,240,220,.6)'; mmCtx.lineWidth = 1.5; mmCtx.beginPath(); mmCtx.arc(R + P.x * sc, R + P.z * sc, 8 + Math.sin(S.wall * 4) * 1.5, 0, Math.PI * 2); mmCtx.stroke();
}

// =====================================================================
// HUD
// =====================================================================
function updateHUD() {
  $('#hpText').textContent = `${Math.ceil(P.hp)} / ${P.maxHp}`;
  $('#hpbar > i').style.transform = `scaleX(${clamp(P.hp / P.maxHp, 0, 1)})`;
  $('#xpbar > i').style.transform = `scaleX(${clamp(P.xp / P.xpNext, 0, 1)})`;
  const zh = SET.lang === 'zh';
  $('#lvlText').textContent = `${tr('Level')} ${pad2(P.level)}`;
  $('#xpText').textContent = `${Math.floor(P.xp)} / ${P.xpNext} ${tr('XP')}`;
  $('#shardText').textContent = zh ? `${P.shards} 锻造币` : `${P.shards} forge shard${P.shards === 1 ? '' : 's'}`;
  $('#forgeText').textContent = `${tr('Edge')} ${P.forge.edge} / 3 · ${tr('Mail')} ${P.forge.mail} / 3 · ${tr('Charm')} ${P.forge.charm} / 3`;
  $('#statText').textContent = `${tr('Damage')} ×${dmgMult().toFixed(2)} · ${tr('Armour')} ${Math.round(armour() * 100)}%`;
  $('#bestText').textContent = `${tr('Best')} ${fmtTime(S.best.time)} · ${S.best.kills} ${tr('kills')}`;
  $('#timer').textContent = S.endless ? `${fmtTime(S.t)} / ∞` : `${fmtTime(S.t)} / 10:00`;
  $('#sub').textContent = `${tr(S.district.title)} · ${tr('Threat')} ${pad2(threat())} · ${S.enemies.length + (S.boss ? 1 : 0)} ${tr('enemies')}`;
  const dash = $('#dashText span'), nova = $('#novaText span');
  dash.textContent = P.dashCd > 0 ? `${tr('Dash')} ${P.dashCd.toFixed(1)}s` : tr('Dash ready'); dash.className = P.dashCd > 0 ? 'cd' : 'ready';
  nova.textContent = P.novaCd > 0 ? `${tr('Ember nova')} ${Math.ceil(P.novaCd)}s` : tr('Ember nova ready'); nova.className = P.novaCd > 0 ? 'cd' : 'ready';
  $('#killText').textContent = zh ? `击败 ${S.stats.kills} · 精英 ${S.stats.elites}` : `${S.stats.kills} defeated · ${S.stats.elites} elites`;
  if (S.touch) { $('#tDash').classList.toggle('cd', P.dashCd > 0); $('#tNova').classList.toggle('cd', P.novaCd > 0); $('#tHeavy').classList.toggle('cd', P.heavyCd > 0); $('#tForge').classList.toggle('hot', nearForge()); }
}

// =====================================================================
// main loop
// =====================================================================
let last = performance.now();
S.wall = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  tick(dt);
}
function tick(dt) {
  S.wall += dt; S.dtRaw = dt;
  if (!S.stepping || S.padStub) pollGamepad();
  if (S.hitStop > 0) { S.hitStop -= dt; dt *= 0.08; }
  if (S.bossIntro > 0) { S.bossIntro -= dt; dt *= 0.2; }
  if (S.slowMo > 0) { S.slowMo -= dt; dt *= 0.35; }
  if (S.autopilot) autopilot(dt);
  if (S.timers.length && S.phase === 'run' && !S.paused) { for (let i = S.timers.length - 1; i >= 0; i--) { const tm = S.timers[i]; tm.t -= dt; if (tm.t <= 0) { S.timers.splice(i, 1); tm.fn(); } } }
  const running = S.phase === 'run' && !S.paused;
  if (running) {
    S.t += dt;
    updateSpawner(dt);
    updatePlayer(dt);
    updateEnemies(dt);
    updateBoss(dt);
    updateMinis(dt);
    updateProjectiles(dt);
    updatePickups(dt);
    updateBurns(dt);
    updateShrines(dt);
    updateGuide(dt);
    // death review data: hp at 10 Hz for the last 12 s
    S.hpAcc = (S.hpAcc || 0) + dt; if (S.hpAcc >= 0.1) { S.hpAcc = 0; S.hpHist.push([S.t, P.hp]); if (S.hpHist.length > 120) S.hpHist.shift(); }
    if (!S.endless && S.t >= RUN_LENGTH && S.phase === 'run') endRun(true);
    AUDIO.setTension(S.boss ? 1 : (P.hp / P.maxHp < 0.35 ? 0.7 : (threat() >= 5 ? 0.5 : 0)));
  } else if (S.phase === 'dead' && ANIM.p) {
    ANIM.p.mixer.update(dt);
  } else if (S.phase === 'title') {
    // slow camera drift around the village on the title screen
    P.x = Math.sin(S.wall * 0.08) * 6; P.z = 4 + Math.cos(S.wall * 0.08) * 4;
    playerRig.position.set(-2.5, 0, 4.5); playerRig.rotation.y = 0.6; FX.playerRing.position.set(-2.5, 0.03, 4.5);
    if (ANIM.p) { setBase(ANIM.p, 0); ANIM.p.mixer.update(dt); }
    lampLight.position.set(-2.5, 1, 5);
    $('#forgeHint').classList.remove('show');
  }
  if (S.bannerT > 0) { S.bannerT -= dt; if (S.bannerT <= 0) $('#banner').classList.remove('show'); }
  updateWeather(dt);
  updatePrecip(dt);
  updateParticles(running || S.phase === 'title' ? dt : 0);
  updateSlashes(dt);
  updateNumbers(dt);
  // ambient sparks
  if (running || S.phase === 'title') for (const src of FX.emberSources) { if (Math.hypot(src.x - P.x, src.z - P.z) < 40 && Math.random() < src.rate * dt) spawnParticle(src.x + (Math.random() - 0.5) * 0.4, src.y, src.z + (Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.6, 1.5 + Math.random(), (Math.random() - 0.5) * 0.6, 1, 0.55, 0.15, 0.35, 1.2, 0.4); }
  novaLight.intensity *= Math.pow(0.001, dt);
  renderEnemies();
  renderPickups();
  // camera
  const targetDist = S.phase === 'title' ? 38 : camDist;
  camShake.t = Math.max(0, camShake.t - dt);
  const shake = camShake.t > 0 && SET.shake ? camShake.amp * camShake.t : 0;
  let fx = P.x, fz = P.z, fd = targetDist;
  if (S.boss && S.bossIntro > 0) { const k = Math.sin((1 - S.bossIntro / 1.7) * Math.PI); fx = lerp(P.x, S.boss.x, k * 0.85); fz = lerp(P.z, S.boss.z, k * 0.85); fd = lerp(targetDist, 20, k); }
  S.camFx = lerp(S.camFx == null ? fx : S.camFx, fx, 1 - Math.pow(0.001, dt * 2)); S.camFz = lerp(S.camFz == null ? fz : S.camFz, fz, 1 - Math.pow(0.001, dt * 2));
  camera.position.set(S.camFx, 0, S.camFz).addScaledVector(CAM_DIR, fd);
  camera.position.x += (Math.random() - 0.5) * shake; camera.position.y += (Math.random() - 0.5) * shake;
  camera.lookAt(S.camFx, 0.8, S.camFz);
  sun.position.set(P.x, 0, P.z).addScaledVector(W.cur.sunDir.clone().normalize(), 50);
  sun.target.position.set(P.x, 0, P.z);
  ground.uniforms.uTime.value = S.wall;
  treeUniforms.uPlayer.value.set(P.x, 0, P.z);
  // static instancing: only upload what is near the camera focus (rebuilt when the focus moves ~6 units)
  if (S.cullX == null || Math.hypot(S.camFx - S.cullX, S.camFz - S.cullZ) > 6) { S.cullX = S.camFx; S.cullZ = S.camFz; for (const k in world.sets) world.sets[k].rebuild(S.camFx, S.camFz, (S.qualityLow ? 44 : 58) + camDist * 0.6); if (S.qualityLow) applyQuality(); }
  // shadows: tighter, sharper frustum when zoomed in
  const shadowSpan = clamp(camDist * 0.95, 16, 36);
  if (Math.abs(shadowSpan - (S.shadowSpan || 0)) > 1.5) {
    S.shadowSpan = shadowSpan;
    Object.assign(sun.shadow.camera, { left: -shadowSpan, right: shadowSpan, top: shadowSpan, bottom: -shadowSpan });
    sun.shadow.camera.updateProjectionMatrix();
    const size = camDist < 20 ? 4096 : camDist > 34 ? 1024 : 2048;
    if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.set(size, size); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } }
  }
  updateHUD();
  if ((S.frame = (S.frame || 0) + 1) % 3 === 0) drawMinimap();
  if (gradePass) { gradePass.uniforms.uTime.value = S.wall; const night = 1 - clamp((W.cur.sunI - 0.5) / 1.5, 0, 1); gradePass.uniforms.uVignette.value = 0.28 + night * 0.12; }
  renderer.info.reset();   // autoReset is off so the whole post chain is counted, not just the last pass
  if (composer) composer.render(); else renderer.render(scene, camera);
  S.fpsAcc += dt; S.fpsN++;
  if (S.fpsAcc > 1) {
    S.fps = S.fpsN / S.fpsAcc; S.fpsAcc = 0; S.fpsN = 0;
    // weak machine: if the first seconds of play cannot hold 40 fps on High, drop to Low once and say so
    if (running && !S.stepping && SET.quality === 'high' && !S.autoLowDone && S.t > 2 && S.t < 12 && S.fps < 40) {
      S.autoLowDone = true; SET.quality = 'low'; saveSettings(); applyQuality(); renderSettings();
      const t = $('#lowToast'); t.textContent = SET.lang === 'zh' ? '检测到帧率偏低,已切换到低画质(暂停菜单可改回)' : 'Low frame rate detected — switched to Low quality (change it in the pause menu)'; t.style.display = 'block'; setTimeout(() => { t.style.display = 'none'; }, 6000);
      window.__emberLog('perf', 'auto low quality at ' + S.fps.toFixed(0) + ' fps');
    }
    // adaptive resolution: step the pixel ratio down when the GPU cannot keep up, back up when it can
    if (running && !S.stepping) {
      const pr = renderer.getPixelRatio();
      if (S.fps < 42 && gtaoPass && gtaoPass.enabled) { gtaoPass.enabled = false; S.lowFpsSince = S.wall; }
      else if (S.fps < 42 && pr > 0.7) { renderer.setPixelRatio(Math.max(0.7, pr - 0.25)); resizeComposer(); S.lowFpsSince = S.wall; }
      else if (S.fps > 57 && pr < Math.min(window.devicePixelRatio, 1.5) && S.wall - (S.lowFpsSince || 0) > 12) renderer.setPixelRatio(Math.min(Math.min(window.devicePixelRatio, 1.5), pr + 0.25));
    }
  }
}

// =====================================================================
// autopilot (balance testing): kite away from the crowd, use skills when it makes sense
function autopilot(dt) {
  if (S.phase !== 'run' || S.paused) return;
  const A = S.ap || (S.ap = { side: 1, flipT: 0, lastX: P.x, lastZ: P.z, stuckT: 0, randT: 0, rx: 0, rz: 0 });
  let fx = 0, fz = 0, near5 = 0, near3 = 0, nearest = 1e9;
  for (const e of S.enemies) {
    const dx = P.x - e.x, dz = P.z - e.z, d2 = dx * dx + dz * dz;
    if (d2 < 196) { const d = Math.sqrt(d2) + 0.2; fx += dx / (d2 + 1); fz += dz / (d2 + 1); if (d < 5) near5++; if (d < 3) near3++; if (d < nearest) nearest = d; }
  }
  for (const b of bigs()) { const dx = P.x - b.x, dz = P.z - b.z, d2 = dx * dx + dz * dz; if (d2 < 400) { fx += dx / (d2 + 1) * 8; fz += dz / (d2 + 1) * 8; } }
  let len = Math.hypot(fx, fz);
  let mx = 0, mz = 0;
  A.flipT -= dt; if (A.flipT <= 0) { A.flipT = 4 + Math.random() * 4; A.side = -A.side; }
  if (len > 1e-4) {
    fx /= len; fz /= len;
    const flee = near3 >= 4 || P.hp < P.maxHp * 0.35 || bigs().some((b) => Math.hypot(P.x - b.x, P.z - b.z) < 7);
    if (flee) { mx = fx; mz = fz; }
    else { mx = fx * 0.35 + (-fz) * A.side; mz = fz * 0.35 + fx * A.side; }   // strafe around the crowd
  } else {
    let tx = 0, tz = 0, best = 1e9;
    for (const p of S.pickups) { const d = Math.hypot(p.x - P.x, p.z - P.z); if (d < best) { best = d; tx = p.x; tz = p.z; } }
    mx = tx - P.x; mz = tz - P.z;
  }
  const r = Math.hypot(P.x, P.z); if (r > 75) { mx -= P.x / r * (r - 75) * 0.25; mz -= P.z / r * (r - 75) * 0.25; }
  // shrines: go light the nearest idle one when things are calm; stay inside the leash while it burns
  if (S.shrines) {
    const act = S.shrineActive;
    if (act) { const d = Math.hypot(P.x - act.x, P.z - act.z); if (d > 11) { mx = (act.x - P.x) / d; mz = (act.z - P.z) / d; A.randT = 0; } else if (d > 7) { const k = (d - 7) * 0.6; mx += (act.x - P.x) / d * k; mz += (act.z - P.z) / d * k; } }
    else if (S.t > 20 && P.hp > P.maxHp * 0.5 && near5 < 3) {
      let best = null, bd = 1e9;
      for (const k in S.shrines) { const sh = S.shrines[k]; if (sh.state !== 'idle' || sh.cd > 0) continue; const d = Math.hypot(P.x - sh.x, P.z - sh.z); if (d < bd) { bd = d; best = sh; } }
      if (best) { if (bd < 3.2) lightShrine(best); else { mx += (best.x - P.x) / bd * 1.2; mz += (best.z - P.z) / bd * 1.2; } }
    }
  }
  // unstick
  A.stuckT += dt; A.randT -= dt;
  if (A.stuckT > 1) { if (Math.hypot(P.x - A.lastX, P.z - A.lastZ) < 1.5) { A.randT = 1.2; const a = Math.random() * 6.28; A.rx = Math.cos(a); A.rz = Math.sin(a); } A.lastX = P.x; A.lastZ = P.z; A.stuckT = 0; }
  if (A.randT > 0) { mx = A.rx; mz = A.rz; }
  const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
  const fwd = new THREE.Vector3(-CAM_DIR.x, 0, -CAM_DIR.z).normalize(); const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const a = mx * fwd.x + mz * fwd.z, b = mx * right.x + mz * right.z;
  S.keys.up = a > 0.3; S.keys.down = a < -0.3; S.keys.right = b > 0.3; S.keys.left = b < -0.3;
  if (near5 >= 6 && P.novaCd <= 0) tryNova();
  if (near3 >= 3 && P.heavyCd <= 0) tryHeavy();
  if ((nearest < 1.4 || (S.boss && S.boss.phase === 'charge')) && P.dashCd <= 0) tryDash();
  if (S.district.key === 'hearth' && nearForge() && P.shards >= 8 && !S.modal && S.wall - (S.lastForge || 0) > 5) { S.lastForge = S.wall; openForge(); const b = document.querySelector('#forgeTracks .btn:not([disabled])'); if (b) b.click(); closeForge(); }
}

// =====================================================================
// debug / capture hooks (used by the verification script)
// =====================================================================
window.__emberlight = {
  S, P: () => P, W, world: () => world, startRun, endRun, spawnBoss, spawnEnemy, spawnAround, setWeather: (tod, wx) => { W.tod = tod; W.wx = wx; W.auto = false; refreshWeatherButtons(); },
  cheat: (o) => Object.assign(P, o), META, recordRun, SET, applyLang, applyQuality, applyCues, gainXp, AUDIO, camDist: (v) => { camDist = v; }, PAD, pollGamepad, lightShrine, nearShrine, shrines: () => S.shrines, DIFFS, rollTalents, TALENTS, WEAPONS, spawnMini, MINIS, minis: () => S.minis, hurtMini, killMini, GUIDE, ANIM, clips: () => kit.clips.map((c) => c.name + ':' + c.duration.toFixed(2)), post: () => ({ ao: gtaoPass && gtaoPass.enabled, bloom: bloomPass && bloomPass.enabled, passes: composer && composer.passes.length }),
  project: (x, y, z) => { const v = new THREE.Vector3(x, y, z).project(camera); return { sx: (v.x * 0.5 + 0.5) * window.innerWidth, sy: (-v.y * 0.5 + 0.5) * window.innerHeight }; },
  slashes: () => S.slashes.map((m) => ({ ry: m.rotation.y, arc: m.userData.arc })), giveShards: (n) => { P.shards += n; }, teleport: (x, z) => { P.x = x; P.z = z; },
  capture: async (url) => {
    if (composer) composer.render(); else renderer.render(scene, camera);
    const data = canvas.toDataURL('image/jpeg', 0.85);
    const name = 'shot_' + Date.now() + '.jpg';
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ name, data }) });
    return name + ':' + r.status;
  },
  step: (n, dt = 1 / 60) => { S.stepping = true; for (let i = 0; i < n; i++) tick(dt); S.stepping = false; },
  keys: (k, v) => { S.keys[k] = v; },
  simRun: (seconds, dt = 1 / 30) => { S.autopilot = true; S.autoTalent = true; S.stepping = true; const log = []; const n = Math.round(seconds / dt); for (let i = 0; i < n && S.phase === 'run'; i++) { tick(dt); if (i % Math.round(30 / dt) === 0) log.push([Math.round(S.t), Math.round(P.hp), P.level, S.enemies.length, S.stats.kills, Math.round(P.x), Math.round(P.z)]); } S.autopilot = false; S.stepping = false; return { phase: S.phase, t: Math.round(S.t), level: P.level, kills: S.stats.kills, hp: Math.round(P.hp), dmg: S.dmgLog, talents: P.talents, log }; },
  info: () => ({ fps: S.fps, enemies: S.enemies.length, pickups: S.pickups.length, drawCalls: renderer.info.render.calls, tris: renderer.info.render.triangles, phase: S.phase, t: S.t, hp: P.hp, level: P.level, shards: P.shards, district: S.district.key, placed: world && world.placedCount }),
};
