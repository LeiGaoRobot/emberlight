# Changelog

## v2.5 — 2026-09-09 · 会话 A:可靠性与兼容(PLAN_v3)

- A1 触屏:`100dvh`、`touch-action: none`、iOS 在 touchend 也解锁音频;手机横屏(≤520 高)和竖屏(≤520 宽)各一套 HUD 精简布局;触屏圆钮自身显示冷却(变暗)/ 铁匠铺可用(高亮)。模拟 375×812 与 740×360 验证:摇杆推动 → 屏幕上移 175 px,新星钮触发。**未在真机验证**
- A2 WebGL 兜底:启动前探测 WebGL2,缺失显示说明;渲染器创建 try/catch;`webglcontextlost` → "上下文丢失,请重载"。用 `WEBGL_lose_context` 触发验证
- A3 离线单文件:`build_dist.py` 把 three(jsDelivr +esm 自包含包)和 9 个 addon 打包进 import map 的 `data:` URL,`dist/index.html` 3.8 MB 零外部脚本(网络面板无 jsDelivr 请求);20 s 未启动显示 CDN 提示。坑:`build/three.module.js` 会 `import './three.core.js'`,data: URL 解析不了相对路径,必须用 `+esm` 包
- A4 存档版本化:`emberlight.settings/meta` 带 `v`,读取时逐字段校验迁移(坏值丢弃、未知解锁键丢弃、runs 只留合法项),写失败进日志。用坏 JSON 验证
- A5 弱机:开局 2–12 s 内 fps < 40 自动切低画质并提示;低画质关 AO、关敌人描边、剔除半径 44、草丛 30%;240 敌人 + BOSS 时 **85 draw call / 29.1 万三角面**(高画质 266 / 154 万,含阴影和后期 pass)。`renderer.info.autoReset=false` 才能统计整条后期链
- A6 手柄:左摇杆移动、右摇杆瞄准并自动攻击、A 冲刺 / B 重击 / X 新星 / Y 换武器 / LB 铁匠铺 / RB 天气 / Start 暂停 / 十字键选天赋;HUD 按键标签随设备切换;标题/暂停/结算页 A 键确认。用假 `navigator.getGamepads` 验证方向投影:左摇杆上 → (0, −11),右摇杆右 → 朝向 (137, 0)
- A7 错误上报:`window.onerror`/`unhandledrejection` 进 20 条环形日志,角落提示;暂停菜单"复制诊断信息"(版本、UA、GPU、fps、draw call、当前局状态、日志)
- 顺带:主角/BOSS 骨架每个动画节点合并成 1 个顶点色 mesh + 1 个发光 mesh(主角 9 个 mesh,原 17),高画质 draw call 356 → 266
