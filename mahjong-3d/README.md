# mahjong-3d — 3D 麻将（Three.js）交接说明

> 最后更新：2026-10-19 01:15 · 开发机：Windows + Edge（playwright-core 无头回归）
> 状态：标准配牌流程已按最终规则实现并全量回归通过

## 1. 这是什么

Three.js（r180，vendor/ 本地拷贝）实现的 3D 麻将桌：136 张标准麻将
（筒条万 108 + 东南西北中发白 28），掷骰定起手 → 三轮两墩 → 庄家跳牌 →
补单张，完成配牌；支持摸牌、点击出牌、对家模拟出牌、副露（吃碰杠）渲染。

## 2. 文件清单

| 文件 | 说明 |
|---|---|
| `index.html` | 开发版主文件（~55KB，所有逻辑内联）。改这个 |
| `mahjong-standalone.html` | 单文件交付版（745KB，esbuild IIFE 打包，**双击即开，无需服务器**） |
| `build_standalone.py` | 由 index.html 重建 standalone：`python build_standalone.py` |
| `index.html.bak2..bak12` | 历史备份（按修改时点） |
| `vendor/` | three.module.js 等本地依赖（esbuild 打包用） |
| `_verify.js` | 桌面回归：40 条断言（骰子映射/环序/墩距层距/配牌结构/守恒/交互全链路） |
| `_verify_portrait.js` | 竖屏横显回归（含点击出牌） |
| `_verify_mobile.js` | 移动 UA 回归 |
| `_verify_file.js` | standalone 的 file:// 回归（无需服务器） |
| `_probe_tiao.js` | 配牌结构探针：强制骰子 4+4=8，逐墩核验跳牌/补单张（17 断言 + 截图） |
| `_shot_final.js` | 拍交付截图（掷骰态 + 配牌完成态） |
| `_shot_final_dice.png` / `_shot_final_deal.png` / `_shot_final_corner.png` | 交付截图 |

## 3. 配牌规则（最终版，用户审定）

1. **掷骰定起手**：两骰点数和 n；`diceSeat(n)`：n%4 → 1=庄(S)、2=下(E)、3=对(N)、0=上(W)。
   即 5,9=庄；2,6,10=下；3,7,11=对；4,8,12=上。
2. **数墩起发**：从起手家**右手边**数到第 n 墩。环序推导：S/N 段右手在 d=16，
   W/E 段右手在 d=0（由座位面朝方向推出，见 index.html 6a 注释）。
3. **三轮两墩**：庄家先拿两墩，然后依「牌山顺时针、座位逆时针」（S→E→N→W）
   各拿两墩，共 3 轮 → 每家 12 张，24 墩摸光。
4. **庄家跳牌**（= 庄家多摸一张）：取 **start+24 墩上方** + **start+26 墩上方**
   （中间 start+25 被跳过）。
5. **补单张**：**下家从庄家摸的第一张牌下面那张开始摸**，即
   - 下家 = start+24 墩底
   - 对家 = start+25 上方（被跳过墩）
   - 上家 = start+25 墩底
   - → 中间被跳过的 25 墩必须摸光，**不留摸不走的牌**；start+26 剩墩底 1 张，
     紧邻摸牌指针，下一张摸牌即摸走。
6. **结果**：庄 14 / 闲 13×3 = 53 张；墙剩 83；`drawPtr = start+26`。

配牌后牌墙形态（以 n=8、start=24 为例）：W 侧 10 墩 + N 侧 16 墩摸光，
N 墙东端 d2(=24 墩)摸光、d1(=25 墩)摸光、d0(=26 墩)半截墩；drawPtr 指向该半截墩。

## 4. 核心实现位置（index.html）

- `6a` 牌墙环模型：`RING_SEATS=['S','W','N','E']`、`RING_BASE`、`wallRing[]`（68 墩，
  每墩 `{seat,d,tiles:[底,上],meshes:[m0,m1]}`）、`wallSlotPos`、`takeWallTile(ring,layer)`、
  `takeStack`、`drawNext`
- `6b` 副露渲染
- `6c` 配牌：`diceSeat/diceStartRing/ringIndexOf/dealPlan/runDeal/startGame`
- 骰子：`rollDice()`（Math.random 取 1..6）、`diceRestRot(v)`（四元数使面值朝上，
  材质序 [+x,-x,+y,-y,+z,-z] → 面值 [3,4,1,6,2,5]，对面和 7）
- 取景：`frameContent()` 投影式迭代取景（内容 8 角+手牌前沿投 NDC）
- 测试出口：`window.__mj`（wallRing/dealLog/dealPlan/drawPtr/wallLeft/diceResult 等）

## 5. 在新机器上怎么跑

**直接看**：双击 `mahjong-standalone.html`（file:// 可用，已回归验证）。

**开发版**（需本地服务器）：
```bash
cd mahjong-3d
python -m http.server 8789 --bind 127.0.0.1
# 浏览器开 http://127.0.0.1:8789/index.html
```

**改完 index.html 后重建 standalone**：
```bash
python build_standalone.py        # 用受管 python 3.13.12
```

**回归**（playwright-core 在受管 node workspace，需 NODE_PATH；Edge 无头）：
```bash
export NODE_PATH="/c/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules"
node _verify.js                    # 桌面 40 断言（需 8789 服务器在跑）
node _verify_portrait.js           # 竖屏
node _verify_mobile.js             # 移动 UA
node _verify_file.js mahjong-standalone.html   # file://，无需服务器
node _probe_tiao.js                # 结构探针（内部强制骰子 4+4=8）
```
Edge 路径硬编码在各脚本 `EDGE` 常量（`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`），
换机器时改这里。

## 6. 探针技巧（口控骰子）

页面加载前 `page.addInitScript(() => { Math.random = () => 0.55; })` →
`rollDice()` 里 `1+floor(0.55*6)=4`，两骰均 4 → n=8 → 上家起、start=24。
想换点数改返回值：v = 1+floor(r*6)。

## 7. 回归基线（2026-10-19 01:10 全绿）

| 场景 | 结果 |
|---|---|
| 桌面 40 断言 | 40/40 PASS，零错误 |
| 竖屏横显 | ALL PASS |
| 移动 UA | 零错误，hand=14 / opp=[13,13,13] / wall=83 |
| standalone file:// | hasMj=true、dealDone=true、wallLeft=83 |
| 结构探针（n=8） | 17/17 PASS：跳牌 24上/26上、补单张 24底/25上/25底、25 摸光、26 剩墩底、drawPtr=start+26、墙 83 |
| 编码 | NUL=0、UTF-8 OK、无 BOM、单闭合 script 标签 |

## 8. 下一步待办

- 牌局内对话式流程未做：摸牌→出牌→吃碰杠听牌→和牌判定引擎（当前只有渲染层）
- 副露只渲染自己家（6b 注释）；对家副露未渲染
- 音效/动画细化（可选）
- 已知小项：`_verify_mobile.js` 的 TARGET 变量指向 index.html，需要 8789 在线
