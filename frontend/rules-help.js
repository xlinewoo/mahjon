/**
 * 规则速查弹窗（2026-11-20）：把 README 的规则口径排成手机可读的速查页。
 * 入口：大厅 lb-head 的「规则」链接 + 牌桌右上菜单的「规则」项（net3d-main 接线）。
 * 只读 DOM + localStorage，不依赖牌局状态 —— 大厅/牌桌/回放都能开。
 */
import { $ } from './ui-utils.js';

const SECTIONS = [
  ['用牌与特殊牌', [
    '136 张：万 / 条 / 筒 1–9 + 东南西北中发白，各 4 张。',
    '红中：只能单独杠（+1 番），不能吃、碰、胡；手里有红中本局不能胡。',
    '癞子（赖子）：每局翻底牌确定，是万能牌，能顶任意牌凑顺子/刻子/将；但不算面子、不算开口、不能暗杠。',
    '皮子：癞子往回数 2 张，再加红中共 3 种；同样不能胡、不吃不碰、可单独杠。',
  ]],
  ['胡牌', [
    '小胡：需 2 / 5 / 8 作将；手里癞子不超过 1 张。',
    '大胡（牌型）：碰碰胡 / 清一色 / 将一色 / 风一色 / 全求人。',
    '大胡（情境）：杠上开花 / 海底捞（尾墩第 7 墩）/ 抢杠胡，每种 +3 番底，可累计。',
    '武汉麻将无七对、无门前清。可胡可过：自摸 / 点炮 / 抢杠都可以选择「过」。',
  ]],
  ['番数与计分', [
    '起胡门槛：小胡 6 番 / 大胡 3 番（三家都够才许胡）。',
    '附加番：庄 / 自摸 / 放冲 / 硬胡 各 +1；吃碰每口 +1；冲杠·蓄杠·暗杠·癞子杠 每口 +2；红中杠·皮子杠 每口 +1。',
    '分段计分表（非 2ⁿ 相乘）；金顶 = 三家全封顶或风一色，每家付封顶分。',
    '大胡不算庄家番；原赖 / 风赖 不加番，改为该家应付分 ×2。',
  ]],
  ['成就与包牌', [
    '七皮：杠出的红中 + 皮子合计 7 张，从其余三家各收 10 分 × 番倍率；牌局继续。',
    '十杠：加权杠口累计 10 口（蓄杠·暗杠·癞子杠各 2 口），奖金同七皮。',
    '抢杠胡：蓄杠可被抢（明杠不可），被抢者承包独付。',
    '包牌：抢杠包 / 全求人点炮包（放炮者全手将时免）/ 清将一色第三句包。',
    '基本两口：非赢家须杠出 2 张皮 / 红中，否则有人胡牌时包胡（确实凑不出不包）。',
    '乱将 / 乱风：全手牌（含副露）全 2/5/8 → 将一色；全字牌 → 风一色（直接金顶）。',
  ]],
];

/** 打开规则速查（幂等：复用同一个弹窗节点） */
export function openRules() {
  let box = document.getElementById('rules-modal');
  if (!box) {
    box = document.createElement('div');
    box.id = 'rules-modal';
    box.className = 'modal';
    box.hidden = true;
    const card = document.createElement('div');
    card.className = 'modal-card rules-card';
    box.appendChild(card);
    box.addEventListener('click', (e) => { if (e.target === box) box.hidden = true; });
    document.body.appendChild(box);
  }
  const card = box.querySelector('.rules-card');
  card.innerHTML = '';

  const h = document.createElement('h3');
  h.textContent = '武汉红中赖子杠 · 规则速查';
  card.appendChild(h);

  for (const [sec, lines] of SECTIONS) {
    const sh = document.createElement('div');
    sh.className = 'rules-sec';
    sh.textContent = sec;
    card.appendChild(sh);
    for (const line of lines) {
      const row = document.createElement('div');
      row.className = 'rules-line';
      row.textContent = line;
      card.appendChild(row);
    }
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tp-close rules-close';
  close.textContent = '知道了';
  close.addEventListener('click', () => { box.hidden = true; });
  card.appendChild(close);

  box.hidden = false;
}
