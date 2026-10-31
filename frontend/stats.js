/**
 * 统计聚合模块 —— 武汉红中赖子杠（**驱动无关 · 零 DOM**）
 *
 * 四种统计维度共用同一份数据源 `result.perSeat`（引擎在每一把结算时算出，
 * 网络版经 `table:handSettled` 下发、单机版由 main.js 直接从 view.result 取）。本模块
 * 只负责把「每一把的 perSeat」累积成「整场的战绩」+「每把的明细」，不做任何渲染。
 *
 * 消费方：
 *   · frontend/render.js   —— 牌桌战绩面板（维度1）、单局结算明细（维度2）、分析报表（维度3）
 *   · frontend/main.js      —— 单机版：每把结束 addHand，开新场 reset
 *   · frontend/net-lobby.js   —— 网络版（3D 入口 net3d-main.js）：每把 handSettled addHand，开新场（handNo===1）reset
 *
 * 维度4（跨场历史战绩）走后端 SQLite（server/db.js 的 player_stats 表 +
 * GET /api/clubs/:id/stats），与这里的「单场累积」是两回事，不混在一起。
 */

/**
 * 创建一份「单场战绩」聚合器。
 * @returns {{
 *   reset: () => void,
 *   addHand: (perSeat: Array<{seat:number,name:string,isWinner:boolean,delta:number,fan:number,gangs:number,huType:string|null}>, handNo:number, type?:string) => void,
 *   getMatchStats: () => { hands:number, players: Array<object> },
 *   getDetailRows: () => Array<object>,
 *   hasData: () => boolean
 * }}
 */
export function createMatchStats() {
  /** 已打的把数（荒庄也算一把） */
  let hands = 0;
  /** seat → 累积战绩 */
  const agg = new Map();
  /** 每把明细（按顺序），每项 { handNo, type, rows:[{seat,name,delta,fan,gangs,huType}] } */
  const detail = [];

  /** 取/建某座位的累积对象（名字以最后一次出现为准） */
  const ensure = (seat, name) => {
    let a = agg.get(seat);
    if (!a) {
      a = {
        seat,
        name,
        net: 0,       // 累计净分（赢家收分 - 输家付分）
        wins: 0,      // 胡牌次数（含屁胡/大胡/金顶）
        draws: 0,     // 荒庄次数
        gangs: 0,     // 杠次数（任意六种杠）
        maxFan: 0,    // 历史最高番
        huSmall: 0,   // 屁胡次数
        huBig: 0,     // 大胡次数
        huGold: 0,    // 金顶次数
      };
      agg.set(seat, a);
    }
    a.name = name;
    return a;
  };

  return {
    /** 开新场：清空所有累积（单机版「再来一局」/ 网络版「handNo===1」时调用） */
    reset() {
      hands = 0;
      agg.clear();
      detail.length = 0;
    },

    /**
     * 把一把的 perSeat 累加进战绩。
     * @param {Array} perSeat 引擎产出的「本把每家战绩」
     * @param {number} handNo 第几把（单机版本地计数 / 网络版服务端 handNo）
     * @param {string} [type='win'] 'win' | 'draw'
     */
    addHand(perSeat, handNo, type = 'win') {
      if (!Array.isArray(perSeat) || perSeat.length === 0) return;
      hands += 1;
      const rows = [];
      for (const p of perSeat) {
        const a = ensure(p.seat, p.name);
        a.net += p.delta | 0;
        a.gangs += p.gangs | 0;
        const fan = p.fan | 0;
        if (fan > a.maxFan) a.maxFan = fan;
        if (p.isWinner) {
          a.wins += 1;
          if (p.huType === 'gold') a.huGold += 1;
          else if (p.huType === 'big') a.huBig += 1;
          else a.huSmall += 1;
        }
        if (type === 'draw') a.draws += 1;
        rows.push({
          seat: p.seat,
          name: p.name,
          delta: p.delta | 0,
          fan,
          gangs: p.gangs | 0,
          huType: p.huType || null,
        });
      }
      detail.push({ handNo, type: type === 'draw' ? 'draw' : 'win', rows });
    },

    /** 整场战绩快照（按净分降序、净分相同按胡数降序） */
    getMatchStats() {
      const players = [...agg.values()].map((a) => ({
        ...a,
        played: hands,
        winRate: hands ? Math.round((a.wins / hands) * 100) : 0,
      }));
      players.sort((x, y) => y.net - x.net || y.wins - x.wins || x.seat - y.seat);
      return { hands, players };
    },

    /** 每把明细的深拷贝（防止外部改动内部数组） */
    getDetailRows() {
      return detail.map((d) => ({ handNo: d.handNo, type: d.type, rows: d.rows.slice() }));
    },

    /** 是否已有至少一把数据（决定战绩按钮是否可用） */
    hasData() {
      return hands > 0;
    },
  };
}
