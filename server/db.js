// SQLite 初始化 + 表结构（用户 / 俱乐部 / 成员 / 牌桌）
// 使用 Node 22 内置 node:sqlite（DatabaseSync），避免原生 addon 在受管 node 下的兼容问题。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录：可用 DATA_DIR 覆盖（Docker / NAS 挂载卷用），默认 server/data。
// Docker 内建议 DATA_DIR=/data 并挂载卷，保证容器重建后账号/头像不丢。
const dataDir = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(__dirname, 'data');
try {
  mkdirSync(dataDir, { recursive: true });
} catch (e) {
  // 受管/沙箱环境下 broker 可能偶发拒绝 mkdir（CODEBUDDY_BROKER_DENY）。
  // 数据目录已存在时无害（数据库文件照常打开）；目录真的不存在时下面 DatabaseSync 会明确报错。
  if (e && e.code !== 'CODEBUDDY_BROKER_DENY') throw e;
}

const db = new DatabaseSync(resolve(dataDir, 'mahjon.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// 事务重入深度（inTransaction 用；声明必须在启动回填之前 —— 回填会真的开事务）
let txDepth = 0;

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_type   TEXT NOT NULL DEFAULT 'preset',
  avatar_value  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS clubs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  owner_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS club_members (
  club_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role    TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY(club_id, user_id),
  FOREIGN KEY(club_id) REFERENCES clubs(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

/* 入会申请（老吴 2026-10-30：「进入俱乐部需要俱乐部创建人同意」）。
   旧实现是**自助加入**——POST /clubs/:id/join 直接插 club_members，谁点谁进。
   俱乐部是私人小圈子，必须由主席/管理员点头，所以拆成「申请 → 审批」两步：
     · status='pending'  等待审批（唯一会被主席看到的态）
     · status='approved' 已同意（成员行已写入 club_members，这行留作审计）
     · status='rejected' 已拒绝（允许再次申请，重新置回 pending）
   主键 (club_id,user_id) 保证一个人对一个俱乐部只有一条申请记录，重复申请就是改这条。 */
CREATE TABLE IF NOT EXISTS club_applications (
  club_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  note       TEXT NOT NULL DEFAULT '',            /* 申请留言（可选，≤60 字） */
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  decided_at INTEGER,
  decided_by INTEGER,
  PRIMARY KEY(club_id, user_id),
  FOREIGN KEY(club_id) REFERENCES clubs(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_club_apps_status ON club_applications(club_id, status);

CREATE TABLE IF NOT EXISTS tables (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  owner_id     INTEGER NOT NULL,
  rule_json    TEXT NOT NULL DEFAULT '{}',
  circle_count INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'idle',
  created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(club_id) REFERENCES clubs(id),
  FOREIGN KEY(owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS player_stats (
  club_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  username    TEXT NOT NULL DEFAULT '',
  hands       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  gold_tops   INTEGER NOT NULL DEFAULT 0,
  total_score INTEGER NOT NULL DEFAULT 0,
  total_gangs INTEGER NOT NULL DEFAULT 0,
  max_fan     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  PRIMARY KEY(club_id, user_id),
  FOREIGN KEY(club_id) REFERENCES clubs(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

/* 逐把流水（个人「当日 / 当月 / 当年」时段统计的数据源）。
   player_stats 只是**累计计数器**，答不了「这个月赢了多少」——
   时段维度必须保留每一把的落点，所以这里按把追加一行明细。 */
CREATE TABLE IF NOT EXISTS hand_records (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id  INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  ts       INTEGER NOT NULL,                   /* 结算时刻（unix 秒） */
  hand_no  INTEGER NOT NULL DEFAULT 0,
  delta    INTEGER NOT NULL DEFAULT 0,        /* 本把净分（收 − 付） */
  is_win   INTEGER NOT NULL DEFAULT 0,
  fan      INTEGER NOT NULL DEFAULT 0,
  gangs    INTEGER NOT NULL DEFAULT 0,
  hu_type  TEXT NOT NULL DEFAULT '',           /* small | big | gold | '' */
  FOREIGN KEY(club_id) REFERENCES clubs(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_hand_records_user ON hand_records(club_id, user_id, ts);
/* 跨俱乐部个人统计走这条索引（不带 club_id 前缀）——老吴 2026-10-03 定：
   胜率/大胡率/金顶率/总成绩/总平均分 一律按**个人总成绩**算，不按俱乐部切分。 */
CREATE INDEX IF NOT EXISTS idx_hand_records_user_ts ON hand_records(user_id, ts);

/* 完整牌局回放：每把落一条，含发牌配置 + 全量动作日志。
   hand_records 只是按用户拆分的统计流水，无法还原牌局；回放必须保留
   seed / ruleset / 庄家 / 上一把癞子 / 四家名字，才能用 createGame 确定性复算。 */
CREATE TABLE IF NOT EXISTS hand_replays (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  club_id        INTEGER NOT NULL,
  table_id       INTEGER NOT NULL,
  table_name     TEXT NOT NULL DEFAULT '',
  hand_no        INTEGER NOT NULL DEFAULT 0,
  seed           INTEGER NOT NULL,
  dealer         INTEGER NOT NULL DEFAULT 0,
  prev_wild_tile INTEGER,
  prev_winner    INTEGER,
  names_json     TEXT NOT NULL DEFAULT '[]',
  ruleset_json   TEXT NOT NULL DEFAULT '{}',
  actions_json   TEXT NOT NULL DEFAULT '[]',
  result_json    TEXT NOT NULL DEFAULT '{}',
  players_json   TEXT NOT NULL DEFAULT '[]',
  ts             INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(club_id) REFERENCES clubs(id),
  FOREIGN KEY(table_id) REFERENCES tables(id)
);
CREATE INDEX IF NOT EXISTS idx_hand_replays_club_ts ON hand_replays(club_id, ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_hand_replays_table ON hand_replays(table_id, ts DESC);

/* 回放参与者索引：个人「跨俱乐部全部牌局」查询走这里，避免解析 players_json。
   机器人 uid 是字符串（bot:...），不写本表，避免撞 users 外键。 */
CREATE TABLE IF NOT EXISTS hand_replay_players (
  replay_id INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  seat      INTEGER NOT NULL,
  username  TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(replay_id, user_id),
  FOREIGN KEY(replay_id) REFERENCES hand_replays(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_hand_replay_players_user ON hand_replay_players(user_id, replay_id);
/* 2026-10-24 连金/反金：回放需记录上一局赢家才能确定性复算。老库补列（已存在则忽略）。 */

/* 个人**跨俱乐部**生涯累计（老吴 2026-10-03）。
   player_stats 是「俱乐部 × 玩家」维度的，答不了「我在所有俱乐部一共赢了多少」。
   这张表只按 user_id 聚合，是「全部」口径的唯一数据源。 */
CREATE TABLE IF NOT EXISTS user_career_stats (
  user_id     INTEGER PRIMARY KEY,
  username    TEXT NOT NULL DEFAULT '',
  hands       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  small_hus   INTEGER NOT NULL DEFAULT 0,
  big_hus     INTEGER NOT NULL DEFAULT 0,
  gold_tops   INTEGER NOT NULL DEFAULT 0,
  net         INTEGER NOT NULL DEFAULT 0,        /* 总成绩 = 累计净分（收 − 付） */
  sum_fan     INTEGER NOT NULL DEFAULT 0,        /* 番数累计（算平均番用；0 番不计入 avgFan） */
  fan_hands   INTEGER NOT NULL DEFAULT 0,        /* 有番的局数（avgFan 的分母） */
  total_gangs INTEGER NOT NULL DEFAULT 0,
  max_fan     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

/* 一次性回填标记（避免重复回填导致重复计数）。 */
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// 2026-10-24 连金/反金：回放要记录「上一局赢家」才能确定性复算；老库补列（已存在则忽略）。
try {
  db.exec('ALTER TABLE hand_replays ADD COLUMN prev_winner INTEGER');
} catch {
  /* 列已存在（本语句仅老库触发一次） */
}

// 2026-10-29 令牌可撤销（P1 安全项）：users 加 token_version。
// JWT 里带 tv，校验时与库里的值比对 —— 改密 / 登出时 +1 即可让**已签发的所有令牌立即失效**
// （此前 JWT 7 天有效期，一旦泄露在有效期内无法踢下线）。
try {
  db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
} catch {
  /* 列已存在 */
}

// 2026-10-29 数据卫生：进程重启后内存里的房间表清空了，但库里可能还留着上次的
// status='playing'（僵尸状态，前端会显示「进行中」却没人）。启动时一律归零。
// ⚠️ 前提是单实例部署（本项目即如此）；多实例共享同一库时不能这么做。
try {
  const stale = db.prepare("UPDATE tables SET status = 'idle' WHERE status = 'playing'").run();
  if (stale.changes) console.log(`[启动] 清理僵尸牌桌状态：${stale.changes} 张 playing → idle`);
} catch {
  /* 表尚未就绪时忽略 */
}

// 2026-10-29 文件权限（P2 安全项）：库里是 953 条密码哈希 + 全部回放，
// 同机其他用户不该能读。数据目录 700、库文件 600（WAL/SHM 一并收紧）。
try {
  chmodSync(dataDir, 0o700);
  for (const f of ['mahjon.db', 'mahjon.db-wal', 'mahjon.db-shm']) {
    try { chmodSync(resolve(dataDir, f), 0o600); } catch { /* 文件可能还不存在 */ }
  }
} catch {
  /* 受管环境可能禁止 chmod，不影响功能 */
}


/**
 * 一次性回填：把 user_career_stats 从既有的 player_stats 累计值补齐。
 *
 * 为什么需要：`player_stats` 早于个人时段统计上线，含**本功能上线前**的历史；
 * 不回填的话「全部」口径会从零开始，跟「跨场战绩榜」对不上。
 *
 * 取数口径（**刻意不重复计数**）：
 * - hands / wins / net / gold_tops / gangs / max_fan → 直接 SUM(player_stats)，那是权威累计值；
 * - small_hus / big_hus → 只能从 hand_records 的 hu_type 统计（player_stats 没存这两项），
 *   这是**纯计数**而非增量，与上面的 SUM 不重叠，安全。
 */
function backfillCareerStats() {
  const done = db.prepare(`SELECT value FROM app_meta WHERE key = 'career_backfill_v1'`).get();
  if (done) return;
  try {
    inTransaction(() => {
      db.exec(`
        INSERT INTO user_career_stats
          (user_id, username, hands, wins, gold_tops, net, total_gangs, max_fan, updated_at)
        SELECT user_id, MAX(username), SUM(hands), SUM(wins), SUM(gold_tops),
               SUM(total_score), SUM(total_gangs), MAX(max_fan), strftime('%s','now')
          FROM player_stats
         GROUP BY user_id
         ON CONFLICT(user_id) DO UPDATE SET
           username    = excluded.username,
           hands       = user_career_stats.hands       + excluded.hands,
           wins        = user_career_stats.wins        + excluded.wins,
           gold_tops   = user_career_stats.gold_tops   + excluded.gold_tops,
           net         = user_career_stats.net         + excluded.net,
           total_gangs = user_career_stats.total_gangs + excluded.total_gangs,
           max_fan     = MAX(user_career_stats.max_fan, excluded.max_fan),
           updated_at  = excluded.updated_at
      `);
      // 大胡/小胡次数：只从流水统计，纯计数不与上面的 SUM 重叠
      db.exec(`
        UPDATE user_career_stats
           SET small_hus = small_hus + (SELECT COUNT(*) FROM hand_records h
                                         WHERE h.user_id = user_career_stats.user_id AND h.hu_type = 'small'),
               big_hus   = big_hus   + (SELECT COUNT(*) FROM hand_records h
                                         WHERE h.user_id = user_career_stats.user_id AND h.hu_type = 'big'),
               sum_fan   = sum_fan   + COALESCE((SELECT SUM(h.fan) FROM hand_records h
                                         WHERE h.user_id = user_career_stats.user_id), 0),
               fan_hands = fan_hands + (SELECT COUNT(*) FROM hand_records h
                                         WHERE h.user_id = user_career_stats.user_id AND h.fan > 0)
      `);
      // 流水里有、但 player_stats 还没有的用户（例如中途才建号）也补一条
      db.exec(`
        INSERT INTO user_career_stats
          (user_id, username, hands, wins, small_hus, big_hus, gold_tops, net,
           sum_fan, fan_hands, total_gangs, max_fan, updated_at)
        SELECT h.user_id, MAX(h.username), COUNT(*),
               SUM(CASE WHEN h.is_win = 1 THEN 1 ELSE 0 END),
               SUM(CASE WHEN h.hu_type = 'small' THEN 1 ELSE 0 END),
               SUM(CASE WHEN h.hu_type = 'big' THEN 1 ELSE 0 END),
               SUM(CASE WHEN h.hu_type = 'gold' THEN 1 ELSE 0 END),
               SUM(h.delta),
               COALESCE(SUM(h.fan), 0),
               SUM(CASE WHEN h.fan > 0 THEN 1 ELSE 0 END),
               SUM(h.gangs), COALESCE(MAX(h.fan), 0), strftime('%s','now')
          FROM hand_records h
         WHERE NOT EXISTS (SELECT 1 FROM user_career_stats c WHERE c.user_id = h.user_id)
         GROUP BY h.user_id
      `);
      db.prepare(`INSERT OR REPLACE INTO app_meta(key, value) VALUES ('career_backfill_v1', 'done')`).run();
    });
  } catch (e) {
    if (e && e.code !== 'CODEBUDDY_BROKER_DENY') throw e;
  }
}
backfillCareerStats();

/**
 * 在一个事务里跑 fn（附加账本写入用）。
 * ❗`node:sqlite` 的 DatabaseSync **没有** `.transaction()`（那是 better-sqlite3 的 API），
 *   所以这里手写 BEGIN / COMMIT / ROLLBACK。fn 抛错必须回滚，否则事务会一直挂着。
 */
/**
 * 在一个事务里跑 fn（附加账本写入用）。
 * ❗`node:sqlite` 的 DatabaseSync **没有** `.transaction()`（那是 better-sqlite3 的 API），
 *   所以这里手写 BEGIN / COMMIT / ROLLBACK。fn 抛错必须回滚，否则事务会一直挂着。
 *
 * 2026-10-24 起支持**可重入**：结算合并事务（ws 层 recordReplay + recordStats 一个事务）
 * 会嵌套调用各 record* —— 它们自带的本函数在嵌套层直接执行，由最外层统一提交/回滚
 * （node:sqlite 不支持嵌套 BEGIN，会抛「cannot start a transaction within a transaction」）。
 * 内层抛错 → 外层 ROLLBACK 整个事务，账本原子性由最外层保证。
 */
export function inTransaction(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 已自动回滚 */ }
    throw e;
  } finally {
    txDepth--;
  }
}

/**
 * 每把结算后增量更新俱乐部战绩榜（附加账本，失败不影响牌局）。
 * @param {number} clubId
 * @param {Array<{uid:number,username:string,delta:number,fan:number,gangs:number,isWinner:boolean,huType:string|null}>} rows
 */
export function recordHandStats(clubId, rows) {
  const stmt = db.prepare(`
    INSERT INTO player_stats (club_id, user_id, username, hands, wins, gold_tops, total_score, total_gangs, max_fan, updated_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(club_id, user_id) DO UPDATE SET
      hands = hands + 1,
      wins = wins + excluded.wins,
      gold_tops = gold_tops + excluded.gold_tops,
      total_score = total_score + excluded.total_score,
      total_gangs = total_gangs + excluded.total_gangs,
      max_fan = MAX(max_fan, excluded.max_fan),
      username = excluded.username,
      updated_at = strftime('%s','now')
  `);
  try {
    inTransaction(() => {
      for (const r of rows) {
        if (!r || r.uid == null) continue;
        stmt.run(
          clubId, r.uid, r.username || '',
          r.isWinner ? 1 : 0,
          r.huType === 'gold' ? 1 : 0,
          r.delta | 0, r.gangs | 0, r.fan | 0,
        );
      }
    });
  } catch (e) {
    // 受管/沙箱 broker 偶发拒绝写入（CODEBUDDY_BROKER_DENY）时静默跳过：
    // 战绩是附加账本，不能因它抛错影响牌局；production 不受影响。
    if (e && e.code !== 'CODEBUDDY_BROKER_DENY') throw e;
  }
}

/**
 * 每把结算后追加一条**逐把流水**（个人 日/月/年 时段统计的数据源）。
 * 与 recordHandStats 同样是附加账本：失败不影响牌局。
 * @param {number} clubId
 * @param {number} handNo
 * @param {Array<{uid:number,username:string,delta:number,fan:number,gangs:number,isWinner:boolean,huType:string|null}>} rows
 */
export function recordHandRows(clubId, handNo, rows) {
  const stmt = db.prepare(`
    INSERT INTO hand_records (club_id, user_id, username, ts, hand_no, delta, is_win, fan, gangs, hu_type)
    VALUES (?, ?, ?, strftime('%s','now'), ?, ?, ?, ?, ?, ?)
  `);
  try {
    inTransaction(() => {
      for (const r of rows) {
        if (!r || r.uid == null) continue;
        stmt.run(
          clubId, r.uid, r.username || '', handNo | 0,
          r.delta | 0, r.isWinner ? 1 : 0, r.fan | 0, r.gangs | 0, r.huType || '',
        );
      }
    });
  } catch (e) {
    if (e && e.code !== 'CODEBUDDY_BROKER_DENY') throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 牌局回放                                                            */
/* ------------------------------------------------------------------ */

const parseJson = (text, fallback) => {
  try {
    const v = JSON.parse(text);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
};

function hydrateReplay(row, { withActions = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    clubId: row.club_id,
    clubName: row.club_name || '',
    tableId: row.table_id,
    tableName: row.table_name || '',
    handNo: row.hand_no,
    seed: row.seed,
    dealer: row.dealer,
    prevWildTile: row.prev_wild_tile,
    prevWinnerSeat: row.prev_winner == null ? null : row.prev_winner,
    names: parseJson(row.names_json, []),
    ruleset: parseJson(row.ruleset_json, {}),
    result: parseJson(row.result_json, {}),
    players: parseJson(row.players_json, []),
    ts: row.ts,
  };
  if (withActions) out.actions = parseJson(row.actions_json, []);
  return out;
}

const REPLAY_LIST_COLS = `
  r.id, r.club_id, c.name AS club_name, r.table_id, r.table_name, r.hand_no,
  r.seed, r.dealer, r.prev_wild_tile, r.names_json, r.ruleset_json,
  r.result_json, r.players_json, r.ts
`;

/**
 * 保存一把完整回放。动作日志与发牌配置缺一不可：
 * 只存 seed 无法知道玩家实际怎么打；只存动作无法重建起手牌。
 *
 * @param {{clubId:number,tableId:number,tableName?:string,handNo?:number,seed:number,
 *          dealer?:number,prevWildTile?:number|null,prevWinnerSeat?:number|null,names?:string[],ruleset?:object,
 *          actions?:Array<{seat:number,action:object}>,result?:object,
 *          players?:Array<{seat:number,uid:number|string|null,username:string,bot?:boolean}>,
 *          ts?:number}} r
 * @returns {number} replay id
 */
export function saveHandReplay(r) {
  if (!r || !Number.isInteger(r.clubId) || !Number.isInteger(r.tableId) || !Number.isInteger(r.seed)) {
    throw new Error('回放数据缺少 clubId / tableId / seed');
  }
  return inTransaction(() => {
    const info = db.prepare(`
      INSERT INTO hand_replays
        (club_id, table_id, table_name, hand_no, seed, dealer, prev_wild_tile, prev_winner,
         names_json, ruleset_json, actions_json, result_json, players_json, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      r.clubId,
      r.tableId,
      r.tableName || '',
      r.handNo | 0,
      r.seed | 0,
      r.dealer | 0,
      r.prevWildTile == null ? null : r.prevWildTile | 0,
      r.prevWinnerSeat == null ? null : r.prevWinnerSeat | 0,
      JSON.stringify(r.names || []),
      JSON.stringify(r.ruleset || {}),
      JSON.stringify(r.actions || []),
      JSON.stringify(r.result || {}),
      JSON.stringify(r.players || []),
      r.ts || Math.floor(Date.now() / 1000),
    );
    const replayId = Number(info.lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO hand_replay_players (replay_id, user_id, seat, username)
      VALUES (?, ?, ?, ?)
    `);
    for (const p of r.players || []) {
      // 只有真人才进个人回放索引；bot uid 是字符串，不能写 users 外键
      if (!p || !Number.isInteger(p.uid)) continue;
      ins.run(replayId, p.uid, p.seat | 0, p.username || '');
    }
    return replayId;
  });
}

/** 个人维度：该用户在所有俱乐部打过的全部牌局（最新在前）。 */
export function listHandReplaysForUser(userId, limit = 50, offset = 0) {
  const rows = db.prepare(`
    SELECT ${REPLAY_LIST_COLS}
      FROM hand_replays r
      JOIN hand_replay_players p ON p.replay_id = r.id
      JOIN clubs c ON c.id = r.club_id
     WHERE p.user_id = ?
     ORDER BY r.ts DESC, r.id DESC
     LIMIT ? OFFSET ?
  `).all(userId, limit, offset);
  return rows.map((row) => hydrateReplay(row));
}

/** 俱乐部维度：该俱乐部所有牌桌的全部牌局（最新在前）。 */
/**
 * 俱乐部维度的回放列表。
 *
 * 2026-10-29（P1 安全项）：新增 `onlyUserId` —— 非管理者的普通成员**只列自己参与过的牌局**。
 * 旧口径「是俱乐部成员就能看全俱乐部每一把的动作日志」意味着：任何人只要记住一个弱密码
 * 登录进来、点一下「加入」任意俱乐部，就能读走该俱乐部全部历史牌局的四家底牌。
 * 权限与 `/api/replays/:id` 共用同一个判定（当事人 ∪ owner/admin），避免两边口径漂移。
 */
export function listHandReplaysForClub(clubId, limit = 50, offset = 0, onlyUserId = null) {
  if (onlyUserId == null) {
    const rows = db.prepare(`
      SELECT ${REPLAY_LIST_COLS}
        FROM hand_replays r
        JOIN clubs c ON c.id = r.club_id
       WHERE r.club_id = ?
       ORDER BY r.ts DESC, r.id DESC
       LIMIT ? OFFSET ?
    `).all(clubId, limit, offset);
    return rows.map((row) => hydrateReplay(row));
  }
  const rows = db.prepare(`
    SELECT ${REPLAY_LIST_COLS}
      FROM hand_replays r
      JOIN clubs c ON c.id = r.club_id
     WHERE r.club_id = ?
       AND EXISTS(SELECT 1 FROM hand_replay_players p
                   WHERE p.replay_id = r.id AND p.user_id = ?)
     ORDER BY r.ts DESC, r.id DESC
     LIMIT ? OFFSET ?
  `).all(clubId, onlyUserId, limit, offset);
  return rows.map((row) => hydrateReplay(row));
}

/* ------------------------------------------------------------------ */
/* 回放「场次」聚合                                                      */
/* ------------------------------------------------------------------ */

/**
 * 把按时间排好的一把把回放聚成「一场」。
 *
 * 数据库里没有 match_id（历史数据更不能补），所以用**同一张桌 + hand_no 递增**识别：
 *   · 新一场的第一把 hand_no = 1；
 *   · 同一场里 hand_no 必须比上一把大；一旦 <= 上一把（重开新场又从 1 开始）就切场。
 * 调用方必须保证 rows 按 `table_id, ts, id` 升序传入。
 */
function scoreBySeat(result) {
  const out = [0, 0, 0, 0];
  if (!result) return out;
  // 新回放都带 perSeat.delta（已含胡牌输赢 + 七皮/十杠附加账本）。
  // 必须优先用它：只按 payments 累加会漏掉成就奖，场次总分就会比牌桌少一截。
  if (Array.isArray(result.perSeat) && result.perSeat.length) {
    for (const p of result.perSeat) {
      const seat = Number(p && p.seat);
      if (Number.isInteger(seat) && seat >= 0 && seat < 4) out[seat] += Number(p.delta) || 0;
    }
    return out;
  }
  if (result.type !== 'win') return out;
  const payments = Array.isArray(result.payments) ? result.payments : [];
  const win = Number.isInteger(result.winnerSeat) ? result.winnerSeat : -1;
  let totalWin = Number(result.totalWin);
  if (!Number.isFinite(totalWin)) {
    totalWin = payments.reduce((a, x) => a + (Number(x && x.pay) || 0), 0);
  }
  if (win >= 0 && win < 4) out[win] += totalWin;
  for (const x of payments) {
    const seat = x && Number(x.seat);
    if (Number.isInteger(seat) && seat >= 0 && seat < 4) out[seat] -= Number(x.pay) || 0;
  }
  return out;
}

function handResultText(result, names) {
  if (!result || !result.type) return '结果未知';
  if (result.type !== 'win') return '荒庄';
  const win = Number.isInteger(result.winnerSeat) ? result.winnerSeat : -1;
  const name = (win >= 0 && names[win]) || result.winnerName || `座位${win + 1}`;
  return `${name} 胡${Number.isFinite(Number(result.totalWin)) ? ` · ${Number(result.totalWin)} 分` : ''}`;
}

function buildReplaySessions(rows) {
  const groups = [];
  let cur = null;
  let prevTable = null;
  let prevHand = null;
  for (const r of rows) {
    const reset = !cur || r.table_id !== prevTable || r.hand_no <= prevHand;
    if (reset) {
      cur = {
        tableId: r.table_id,
        clubId: r.club_id,
        clubName: r.club_name || '',
        tableName: r.table_name || `牌桌 #${r.table_id}`,
        firstId: r.id,
        startTs: r.ts,
        endTs: r.ts,
        rows: [],
      };
      groups.push(cur);
      prevTable = r.table_id;
    }
    cur.rows.push(r);
    cur.endTs = Math.max(cur.endTs, r.ts);
    cur.startTs = Math.min(cur.startTs, r.ts);
    prevHand = r.hand_no;
  }

  return groups.map((g) => {
    const names = playerNamesOf(g.rows);
    const players = [0, 1, 2, 3].map((seat) => ({
      seat,
      uid: null,
      username: names[seat],
      bot: false,
      score: 0,
    }));
    const hands = g.rows
      .slice()
      .sort((a, b) => a.ts - b.ts || a.id - b.id)
      .map((r) => {
        const result = parseJson(r.result_json, {});
        const scores = scoreBySeat(result);
        for (let seat = 0; seat < 4; seat++) players[seat].score += scores[seat];
        for (const p of parseJson(r.players_json, [])) {
          const seat = Number(p && p.seat);
          if (!Number.isInteger(seat) || seat < 0 || seat >= 4) continue;
          const target = players[seat];
          if (p.uid != null) target.uid = p.uid;
          if (p.username) target.username = p.username;
          target.bot = !!p.bot;
        }
        return {
          id: r.id,
          handNo: r.hand_no,
          ts: r.ts,
          text: handResultText(result, names),
          scores: [0, 1, 2, 3].map((seat) => ({
            seat,
            username: names[seat],
            score: scores[seat],
          })),
        };
      });

    return {
      key: `${g.tableId}:${g.firstId}`,
      clubId: g.clubId,
      clubName: g.clubName,
      tableId: g.tableId,
      tableName: g.tableName,
      startTs: g.startTs,
      endTs: g.endTs,
      handCount: hands.length,
      players,
      hands,
    };
  }).sort((a, b) => b.endTs - a.endTs || b.startTs - a.startTs || (b.hands[0]?.id || 0) - (a.hands[0]?.id || 0));
}

function playerNamesOf(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const names = parseJson(rows[i].names_json, []);
    if (Array.isArray(names) && names.length) {
      return [0, 1, 2, 3].map((seat) => names[seat] || `座位${seat + 1}`);
    }
    const players = parseJson(rows[i].players_json, []);
    if (Array.isArray(players) && players.length) {
      return [0, 1, 2, 3].map((seat) => {
        const p = players.find((x) => x && x.seat === seat);
        return (p && p.username) || `座位${seat + 1}`;
      });
    }
  }
  return ['座位1', '座位2', '座位3', '座位4'];
}

/** 个人维度：该用户参与过的每一场（跨俱乐部，最新在前）。 */
export function listReplaySessionsForUser(userId) {
  const rows = db.prepare(`
    SELECT ${REPLAY_LIST_COLS}
      FROM hand_replays r
      JOIN hand_replay_players p ON p.replay_id = r.id
      JOIN clubs c ON c.id = r.club_id
     WHERE p.user_id = ?
     ORDER BY r.table_id ASC, r.ts ASC, r.id ASC
  `).all(userId);
  return buildReplaySessions(rows);
}

/** 俱乐部维度：该俱乐部所有牌桌的每一场（不管个人是否参战，最新在前）。 */
export function listReplaySessionsForClub(clubId, onlyUserId = null) {
  // onlyUserId 同 listHandReplaysForClub：普通成员只看自己参与过的场次
  const rows = onlyUserId == null
    ? db.prepare(`
        SELECT ${REPLAY_LIST_COLS}
          FROM hand_replays r
          JOIN clubs c ON c.id = r.club_id
         WHERE r.club_id = ?
         ORDER BY r.table_id ASC, r.ts ASC, r.id ASC
      `).all(clubId)
    : db.prepare(`
        SELECT ${REPLAY_LIST_COLS}
          FROM hand_replays r
          JOIN clubs c ON c.id = r.club_id
         WHERE r.club_id = ?
           AND EXISTS(SELECT 1 FROM hand_replay_players p
                       WHERE p.replay_id = r.id AND p.user_id = ?)
         ORDER BY r.table_id ASC, r.ts ASC, r.id ASC
      `).all(clubId, onlyUserId);
  return buildReplaySessions(rows);
}

/** 回放详情（含完整动作日志）。调用方必须先做权限校验。 */
export function getHandReplay(replayId) {
  const row = db.prepare(`
    SELECT ${REPLAY_LIST_COLS}, r.actions_json
      FROM hand_replays r
      JOIN clubs c ON c.id = r.club_id
     WHERE r.id = ?
  `).get(replayId);
  return hydrateReplay(row, { withActions: true });
}

/**
 * 回放访问权限（2026-10-29 收紧，P1 安全项）：
 *   · participant —— 本人参与过该把 ⇒ 允许（自己的牌局当然能复盘）
 *   · manager     —— 该俱乐部 owner / admin ⇒ 允许（处理争议、复核成绩需要看全量）
 *   · 其他普通成员 ⇒ 拒绝
 *
 * 旧口径是「只要是俱乐部成员就允许」，等于把「加入俱乐部」变成「拿到全俱乐部历史底牌」。
 * 回放列表侧用同一个判定（见 listHandReplaysForClub 的 onlyUserId），两边口径必须一致。
 */
export function replayAccess(replayId, userId) {
  const row = db.prepare('SELECT club_id FROM hand_replays WHERE id = ?').get(replayId);
  if (!row) return null;
  const participant = !!db.prepare(
    'SELECT 1 AS x FROM hand_replay_players WHERE replay_id = ? AND user_id = ?',
  ).get(replayId, userId);
  const role = db.prepare(
    'SELECT role FROM club_members WHERE club_id = ? AND user_id = ?',
  ).get(row.club_id, userId);
  const member = !!role;
  const manager = !!role && (role.role === 'owner' || role.role === 'admin');
  return { clubId: row.club_id, participant, member, manager, allowed: participant || manager };
}

/**
 * 每把结算后增量更新**个人跨俱乐部生涯累计**（老吴 2026-10-03）。
 * 与上面两个写入并列执行；同样是附加账本，失败不影响牌局。
 * @param {Array<{uid:number,username:string,delta:number,fan:number,gangs:number,isWinner:boolean,huType:string|null}>} rows
 */
export function recordCareerStats(rows) {
  const stmt = db.prepare(`
    INSERT INTO user_career_stats
      (user_id, username, hands, wins, small_hus, big_hus, gold_tops, net,
       sum_fan, fan_hands, total_gangs, max_fan, updated_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id) DO UPDATE SET
      hands       = hands + 1,
      wins        = wins + excluded.wins,
      small_hus   = small_hus + excluded.small_hus,
      big_hus     = big_hus + excluded.big_hus,
      gold_tops   = gold_tops + excluded.gold_tops,
      net         = net + excluded.net,
      sum_fan     = sum_fan + excluded.sum_fan,
      fan_hands   = fan_hands + excluded.fan_hands,
      total_gangs = total_gangs + excluded.total_gangs,
      max_fan     = MAX(max_fan, excluded.max_fan),
      username    = excluded.username,
      updated_at  = strftime('%s','now')
  `);
  try {
    inTransaction(() => {
      for (const r of rows) {
        if (!r || r.uid == null) continue;
        const fan = r.fan | 0;
        stmt.run(
          r.uid, r.username || '',
          r.isWinner ? 1 : 0,
          r.huType === 'small' ? 1 : 0,
          r.huType === 'big' ? 1 : 0,
          r.huType === 'gold' ? 1 : 0,
          r.delta | 0,
          fan, fan > 0 ? 1 : 0, r.gangs | 0, fan,
        );
      }
    });
  } catch (e) {
    if (e && e.code !== 'CODEBUDDY_BROKER_DENY') throw e;
  }
}

/**
 * 时段区间（**服务器本地时区**，与 NAS 上 `date` 一致）。
 * 返回 [fromTs, toTs) 半开区间；period=all 时返回 null（不限制）。
 */
function periodRange(period, nowSec) {
  // 手动按本地时区切，避免 SQLite strftime('now','localtime') 在部分构建上不可用
  const d = new Date(nowSec * 1000);
  const y = d.getFullYear();
  const mo = d.getMonth();      // 0-11
  const da = d.getDate();
  const midnight = (yy, mm, dd) => new Date(yy, mm, dd, 0, 0, 0, 0).getTime() / 1000;
  if (period === 'day') return [midnight(y, mo, da), midnight(y, mo, da + 1)];
  if (period === 'month') return [midnight(y, mo, 1), midnight(y, mo + 1, 1)];
  if (period === 'year') return [midnight(y, 0, 1), midnight(y + 1, 0, 1)];
  return null; // all
}

/**
 * 由一行聚合结果算出派生比率。
 *
 * ⚠️ 分母口径（老吴 2026-10-03 确认，三个率一律除「总局数」保持同一把尺子，好横向比较）：
 *   胜率   = 胡牌局数 / 总局数
 *   大胡率 = 大胡局数 / 总局数
 *   金顶率 = 金顶局数 / 总局数
 * 荒庄（`is_win=0` 且 `delta=0`）照样计入总局数 —— 荒庄也是一手牌，藏掉会让胜率虚高。
 * 平均番的分母另算：只取 `fan > 0` 的局（0 番局拉低均值没有信息量）。
 */
function deriveRates(r) {
  const hands = r.hands | 0;
  const wins = r.wins | 0;
  const bigHus = r.bigHus | 0;
  const goldTops = r.goldTops | 0;
  const net = r.net | 0;
  const fanHands = r.fanHands | 0;
  const sumFan = r.sumFan | 0;
  const pct = (n) => (hands ? Math.round((n / hands) * 1000) / 10 : 0);
  return {
    hands,
    wins,
    net,
    winRate: pct(wins),
    bigHuRate: pct(bigHus),
    goldRate: pct(goldTops),
    bigHus,
    goldTops,
    maxFan: r.maxFan | 0,
    totalGangs: r.totalGangs | 0,
    // 总平均分 = 每局平均净分（正就是赢，负就是输）
    avgScore: hands ? Math.round((net / hands) * 100) / 100 : 0,
    avgFan: fanHands ? Math.round((sumFan / fanHands) * 10) / 10 : 0,
  };
}

/**
 * 个人**跨俱乐部**战绩（老吴 2026-10-03 起不再按俱乐部切分）。
 *
 * - `period === 'all'`：走 `user_career_stats` 累计表（含个人时段统计上线前的历史）；
 * - 其余时段：走 `hand_records` 流水表（**不带 club_id 过滤** → 跨俱乐部汇总）。
 * @param {number} userId
 * @param {'day'|'month'|'year'|'all'} period
 */
export function personalStats(userId, period = 'all', nowSec = Math.floor(Date.now() / 1000)) {
  const range = periodRange(period, nowSec);

  if (period === 'all') {
    const row = db.prepare(`
      SELECT hands, wins, big_hus AS bigHus, gold_tops AS goldTops, net,
             sum_fan AS sumFan, fan_hands AS fanHands, total_gangs AS totalGangs, max_fan AS maxFan
        FROM user_career_stats WHERE user_id = ?
    `).get(userId) || {};
    return { period, from: null, to: null, ...deriveRates(row) };
  }

  const row = db.prepare(`
    SELECT COUNT(*) AS hands,
           COALESCE(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(CASE WHEN hu_type = 'big' THEN 1 ELSE 0 END), 0) AS bigHus,
           COALESCE(SUM(CASE WHEN hu_type = 'gold' THEN 1 ELSE 0 END), 0) AS goldTops,
           COALESCE(SUM(delta), 0) AS net,
           COALESCE(SUM(fan), 0) AS sumFan,
           COALESCE(SUM(CASE WHEN fan > 0 THEN 1 ELSE 0 END), 0) AS fanHands,
           COALESCE(MAX(fan), 0) AS maxFan,
           COALESCE(SUM(gangs), 0) AS totalGangs
      FROM hand_records
     WHERE user_id = ? AND ts >= ? AND ts < ?
  `).get(userId, range[0], range[1]) || {};
  return { period, from: range[0], to: range[1], ...deriveRates(row) };
}

/**
 * 俱乐部某时段的排行榜（维度4 的时段过滤版）。
 * @param {'day'|'month'|'year'|'all'} period
 */
export function clubStatsByPeriod(clubId, period = 'all', nowSec = Math.floor(Date.now() / 1000)) {
  const range = periodRange(period, nowSec);
  let sql = `
    SELECT user_id AS uid,
           MAX(username) AS username,
           COUNT(*) AS hands,
           COALESCE(SUM(CASE WHEN is_win = 1 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(delta), 0) AS net,
           COALESCE(MAX(fan), 0) AS maxFan,
           COALESCE(SUM(CASE WHEN hu_type = 'gold' THEN 1 ELSE 0 END), 0) AS goldTops,
           COALESCE(SUM(gangs), 0) AS totalGangs
      FROM hand_records
     WHERE club_id = ?`;
  const args = [clubId];
  if (range) {
    sql += ' AND ts >= ? AND ts < ?';
    args.push(range[0], range[1]);
  }
  sql += ' GROUP BY user_id ORDER BY net DESC, wins DESC, user_id';
  return db.prepare(sql).all(...args).map((r) => ({
    uid: r.uid,
    username: r.username,
    hands: r.hands | 0,
    wins: r.wins | 0,
    net: r.net | 0,
    maxFan: r.maxFan | 0,
    goldTops: r.goldTops | 0,
    totalGangs: r.totalGangs | 0,
    winRate: r.hands ? Math.round((r.wins / r.hands) * 100) : 0,
  }));
}

export default db;
