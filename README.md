# Emberlight — 类吸血鬼幸存者 (bpy 无头建模 + three.js)

复刻 x.com/op7418/status/2096949703829295484(GPT-6 Astra + Blender + Godot 的 "Emberlight")。
本机链路:`build_kit.py` 用 Blender 5.2 无头把全部资产从原语拼成一个 1.8 MB 的 kit GLB,
`site/` 里的 three.js r184(无打包器,import map 走 jsdelivr)在运行时生成大地图、实例化、
战斗、天气和 UI。

## 启动

```
D:/AI/tools/Blender/blender.exe -b -P build_kit.py -- --out D:/AI/emberlight   # 重建资产(约 20 s)
```

网页:`.claude/launch.json` 里的 `emberlight`(python http.server 8200,目录 `site/`),或
`python -m http.server 8200 --directory site` 后开 http://localhost:8200 。

## 发布版

- **在线玩(GitHub Pages)**:https://leigaorobot.github.io/emberlight/ (源:`docs/index.html`,与 `dist/index.html` 同步;改代码后 `python build_dist.py && cp dist/index.html docs/index.html` 再 push)
- 仓库:https://github.com/LeiGaoRobot/emberlight

- `python build_dist.py` → `dist/index.html`(单文件,import map + 内联三个模块 + kit.glb 转 base64,2.5 MB,任意静态托管可用)
  和 `dist/artifact.html`(claude.ai Artifact 用的 body-only 版,three/addons 走 jsDelivr `+esm` 打包避免 import map)。
  单文件版 GLB 不走 fetch,直接 atob 解码后 `GLTFLoader.parseAsync`,所以在禁 fetch 的沙箱里也能加载
- 本地预览 dist:`.claude/launch.json` 的 `emberlight-dist`(8202)
- 已发布 Artifact(v2):https://claude.ai/code/artifact/df4d9e48-8d53-43d2-93a9-04e26c6ccd02
- 触屏:粗指针设备自动显示左半屏虚拟摇杆 + 右侧 Heavy/Dash/Nova/Swap/Forge 圆钮;自动攻击默认开,所以不需要鼠标瞄准
- 帧率自适应:连续低于 42 fps 时 pixelRatio 逐档降到 0.7,回到 57 fps 以上 12 s 后逐档升回;切到后台自动暂停

## 难度曲线(autopilot 实测)

`__emberlight.simRun(秒)` 用内置 AI(绕人群走位、血量低于 35% 或被 4 只贴身时逃跑、按条件放新星/重击/冲刺、路过铁匠铺就升级)跑整局:
刷怪率 `0.55 + 0.3·分钟` 只/秒(鬼火 2–3 只一组),上限 `28 + 14·分钟`;敌人血量 `×(1 + 0.16·分钟)`。
调整后 AI 能打满 10 分钟(HP 在 7–9 分钟探底到 32,靠红心回升),伤害来源约为吐火者 35% / 爬行者 22% / 灰烬 22%;
BOSS 血量 `2600 + 180·分钟`。调前的版本 AI 在 3 分钟被 130 只围死,已改。

## v2 内容(2026-09-08,按 PLAN.md 三小时计划做完)

- **铁匠铺升级武器**:三把武器各 3 级(弯月:弧度+25% / 反向回斩 / 命中回血;余烬弹:穿透 / 多发 / 爆裂;提灯:+1 盏 / 半径+30% / 灼地),12/24/40 币,武器卡片显示 ★
- **打击感与辨识度**:敌人 body 桶叠一层 BackSide 放大 7% 的黑描边 InstancedMesh(每种 +1 draw call);死亡 0.18 s 压扁再消失(`e.dying`,期间不参与索敌);重击/新星命中 ≥3 只时 60–80 ms 命中停顿;爬行者扑击前 0.3 s 后缩且眼睛变亮
- **BOSS 战**:登场 1.7 s 镜头推向守卫(玩家无敌)+ 裂纹环;30% 血进二阶段(体型 ×1.15、双连冲锋、砸地留 3 处燃烧地面、横幅 THE WARDEN BURNS BRIGHTER);击杀后 2.5 s 慢镜 + 掉落雨;小地图图标脉动
- **余烬档案**(`localStorage emberlight.meta`):累计击杀/最长存活/守卫击杀/局数、最佳 5 局;三项解锁:活过 5 分钟 → 升级四选一;击杀守卫 → 开局 10 币;累计 3000 击杀 → 开局余烬弹 ★。结算页列出本局新解锁,标题页"Ember archive"可查
- **设置**(暂停菜单,`emberlight.settings`):画质高/低(低 = 关阴影、pixelRatio 1.0、草丛/芦苇/蘑菇实例减半,三角面 −14%)、屏幕抖动、伤害数字、音乐/音效滑杆、**中文/English 切换**(所有 HUD、弹窗、天赋、铁匠铺、横幅、档案都有译文,`ZH` 表按英文原文查)
- **音乐分层**:威胁 ≥5 或血量 <35% 叠低音脉冲,BOSS 期间叠琶音;进新区域有三音提示
- **性能**:静态实例只上传镜头焦点 58+0.6·camDist 单位内的(移动 6 单位重建一次,8.7k 实例扫描 <1 ms),村庄三角面 759k → 434k,draw call 不变;阴影相机随缩放收紧,贴图 4096/2048/1024 三档
- 修了两个真 bug:**A/D 左右反了、挥砍刀光偏了约 130°**(右向量符号、扇形旋转符号,已用屏幕投影数值验证:D → 屏幕 (+128, 0),W → (2, −109),鼠标在右侧时朝向/刀光/弹道投影均为 (+109, ~0));暂停时恰好升级会让天赋弹窗盖住暂停弹窗,"继续"失效 —— 现在有弹窗时升级会排队到弹窗关闭后

## Blender 动画(2026-09-08)

- `build_kit.py` 末尾给主角/BOSS 的骨架 Empty(P_Body/P_Head/P_ArmL/P_ArmR、W_Body/W_Head/W_ArmL/W_ArmR)打关键帧:
  `clip(name, rig, frames, keys, loop)` 每个物体一条独立 Action(Blender 5 的 slotted action 没有 `fcurves`,别去调插值),推进同名 NLA 轨道,
  导出用 `export_animation_mode="NLA_TRACKS"` —— 同名轨道跨物体合并成一个 glTF 动画。9 条:P_idle/walk/attack/dash、W_idle/walk/slam/charge/roar
- 所有剪辑第 0 帧 = 静止姿势,网页端 `makeRigAnimator`:idle/walk 是基础层(权重随移动量交叉淡入),
  其余用 `AnimationUtils.makeClipAdditive` 转成叠加层一次性播放(攻击按攻速缩放时长,砸地按 0.9 s 预警对齐落臂时刻,BOSS 登场慢镜用未缩放的 dt 播咆哮)
- 提灯摆动仍是程序化;`kit.glb` 的 URL 加了 `?v=2`,否则浏览器会用没有动画的旧缓存

## 画面打磨(2026-09-08 第二轮,用户反馈"太糙")

- **后期链** `EffectComposer`:RenderPass → `GTAOPass`(环境光遮蔽,高画质才开;帧率低于 42 先关它再降分辨率)→ `UnrealBloomPass`(0.42/0.55/阈值 0.95,只让窗灯/路灯/余烬发光)→ 自写调色 pass(轻对比、暖偏、暗角、极淡颗粒,夜晚暗角更重)→ `OutputPass`(ACES + sRGB)。渲染目标 HalfFloat + `samples: 4` 保住 MSAA
- **光照**:`RoomEnvironment` PMREM 环境贴图(强度随太阳 0.06–0.4),阴影 PCFSoft;夜晚预设压暗(hemi 0.26 / sun 0.32 / 曝光 0.82),路灯灯罩原来把发光体整个包住导致夜里不亮,烘焙时把 `LPCage` 丢掉
- **地面 shader**:道路/广场按 `roadMask` 顶点属性画 Voronoi 石板(F2−F1 做缝、逐格随机明暗),草地叠低频泥斑;烘焙时顶点色饱和度收到 0.94 并微暖
- **树冠淡出**:树用 `MATS.tree`(body 材质克隆 + onBeforeCompile),片元按到主角 xz 距离(2.2–4.8)和高度差(>0.9)做 dither discard,主角永远不被树冠盖住,不加 draw call
- 验证截图在 `shots/`(白天广场、夜晚、雨天荒野、树冠淡出)。**截图前要 `resize_window` 给面板显式尺寸**,否则画布 0×0、`toDataURL` 得到空文件

## 玩法(与原推一致)

- WASD 移动(相对屏幕),鼠标瞄准;Tab 切自动/手动攻击;LMB/J 攻击,RMB/K 重击(2.4 s CD,全周击退)
- Space 冲刺(无敌帧),E 灰烬新星(12 s CD,大范围击退+清弹),Q 换武器(灰烬弯月 / 余烬弹 / 灰烬提灯环绕)
- 五个区域:The Hearth(村庄,铁匠铺在这里)、The Wildwood(NW,鬼火成群)、Mossfall Ruins(NE,吐火者)、
  Cinder Barrow(SE,敌人血量 +20%)、Silvermere Shore(SW,爬行者)。进区域首次弹横幅
- 拾取:青色 ember = XP,橙色 shard = 锻造币,红心回血。升级弹 3 选 1 天赋(14 种,带叠层上限,1/2/3 选)
- 铁匠铺:走进村里铁匠铺的青色圈按 F,EDGE(伤害 +20%)/ MAIL(护甲 +8%)/ CHARM(拾取半径 +25%、XP +10%)各 3 级,
  另可花 5 币回满血
- 敌人:wisp / cinder / crawler(扑击)/ spitter(远程)/ brute(精英,2 分钟后每 22–50 s 一只),威胁随分钟数涨;
  8:00 出 BOSS 灰烬守卫(追击 / 砸地红圈预警 / 直线冲锋预警 / 60%、30% 血召唤),10:00 存活即胜利,可转无尽
- 天气:T 昼/黄昏/夜,R 晴/雨/暴风(闪电+雷声)/雪(地面变白、`Snow_` 件显形、植被偏冷),Y 自动(跟时间走 + 随机换天气)
- Esc 暂停,F4 藏界面,滚轮缩放,M 静音。最佳成绩存 localStorage

## 资产契约(build_kit.py ↔ site/world.js)

- 每个物件是名为 `Kit_<Name>` 的 Empty,子物体在局部坐标建(Z up,正面 -Y → three 里 +Z)。网页端把 Empty 摘出来当模板,
  几何按材质烘成顶点色后合并:普通材质进 `body` 桶(一个共享 MeshStandardMaterial),`Snow_` 前缀进 `snow` 桶
  (透明度 = 雪量),发光材质(WindowGlass/Fire/Lantern/EnemyEye/EmberCore/HotMetal/Crystal/ShardCrystal/PlayerLamp)
  各自进 `glow` 桶(MeshBasicMaterial,`setGlow(name, k)` 统一调亮度做昼夜)
- 静态物件 = 每种一个 InstancedMesh(带 instanceColor 做区域色调),共 8.7k 实例、约 100 次 draw call、106 万三角面
- 敌人 / 拾取物 / 弹丸 = `DynSet`(每帧重填矩阵的 InstancedMesh,受击闪白走 instanceColor)。
  主角 `Kit_Player`、BOSS `Kit_Warden` 保留层级当骨架:`P_Body/P_Head/P_ArmL/P_ArmR/P_Lantern/P_Blade`、`W_Body/W_Head/W_ArmL/W_ArmR/W_Blade`
- 地面是 300×300 的顶点色平面:区域配色 + 噪声 + 道路/广场石板(`roadDist`),shader 里注入云影(滚动噪声)、积雪、湿地
- 碰撞用圆(建筑按长边拆成几个圆)放进 6 格空间哈希;敌人分离用另一张 4 格哈希

## 调试钩子(面板后台时 rAF 不跑,模拟靠它推)

`window.__emberlight`:`startRun()`、`step(n, dt)` 手动推 n 帧、`keys('up', true)` 模拟按键、`teleport(x,z)`、
`setWeather('night','rain')`、`spawnBoss()`、`cheat({hp:9999})`、`giveShards(n)`、`info()`(fps/敌人数/draw call/三角面)、
`S.autoTalent = true` 让升级自动选。`capture(url)` 把当前帧 JPEG POST 到 `shot_server.py`(`python shot_server.py <目录>`,8201)。

实测:8 分钟 240 个敌人时模拟 2 ms/帧,107 次 draw call;世界生成 340 ms。

## 已知差距 / 可改

- 原作用 Godot,本版是 three.js;没有 Blender 动画,主角/BOSS 动作全靠网页端摆姿势
- 敌人在白天是深色团,靠橙色眼睛辨认(与原作一致);远处树下不太醒目
- 音效/音乐全部 WebAudio 合成,没有采样
