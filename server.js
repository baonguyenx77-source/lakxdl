import fastify from "fastify";
import cors from "@fastify/cors";
import fetch from "node-fetch";

/* ══════════════════════════════════════════════════════════════════
 *  CẤU HÌNH
 * ══════════════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
const ADMIN_ID = "@cskhgiabao";

const API_URL_HU  = "https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=83991213bfd4c554dc94bcd98979bdc5";
const API_URL_MD5 = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

/* ══════════════════════════════════════════════════════════════════
 *  THUẬT TOÁN PHÂN TÍCH CẦU — BLOCK PATTERN
 * ══════════════════════════════════════════════════════════════════ */

/* ---------- Chuyển sessions → chuỗi B/T ---------- */
function toSeq(sessions) {
  return sessions.map(s => (s.result === 'TAI' ? 'B' : 'T'));
}

/* ---------- Tách chuỗi thành mảng block ---------- */
function blocksOf(pat) {
  const b = []; let c = 1;
  for (let i = 1; i < pat.length; i++) {
    if (pat[i] === pat[i - 1]) c++;
    else { b.push(c); c = 1; }
  }
  b.push(c);
  return b;
}

/* ---------- Danh sách cầu phổ biến ---------- */
const COMMON_PATTERNS = [
  // Cầu 2 nhịp
  [1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [1, 3], [2, 3], [3, 2], [3, 3],
  // Cầu 3 nhịp
  [1, 1, 2], [2, 1, 1], [1, 2, 1], [2, 1, 2], [1, 2, 2], [2, 2, 1],
  [1, 3, 1], [3, 1, 3], [2, 2, 2], [1, 1, 1],
  // Cầu bệt ngắn
  [4], [5]
];

/* ---------- Khớp chuỗi với pattern block ---------- */
function matchBlockPattern(seq, pattern) {
  const cycleLen = pattern.reduce((a, b) => a + b, 0);
  if (seq.length < cycleLen) return null;

  const tailLen = Math.min(seq.length, cycleLen * 3);
  const tail = seq.slice(-tailLen);

  let blockIdx = 0;
  let currentSide = tail[0];
  let count = 1;

  for (let i = 1; i < tail.length; i++) {
    const expectedLen = pattern[blockIdx % pattern.length];
    if (tail[i] === currentSide) {
      count++;
      if (count > expectedLen) return null;
    } else {
      if (count !== expectedLen) return null;
      blockIdx++;
      currentSide = tail[i];
      count = 1;
    }
  }

  const currentBlockLen = pattern[blockIdx % pattern.length];
  const isBlockComplete = count === currentBlockLen;
  const nextSide = isBlockComplete ? (currentSide === 'B' ? 'T' : 'B') : currentSide;

  return {
    pattern,
    name: pattern.join('-'),
    matchedBlocks: blockIdx,
    currentSide,
    currentCount: count,
    currentBlockLen,
    isComplete: isBlockComplete,
    nextSide,
    confidenceBoost: Math.min(blockIdx * 6, 24)
  };
}
/* ---------- Phân tích cầu hiện tại ---------- */
function analyzeCurrentPattern(sessions) {
  const seq = toSeq(sessions);
  const matches = [];
  for (const pattern of COMMON_PATTERNS) {
    const m = matchBlockPattern(seq, pattern);
    if (m) matches.push(m);
  }
  matches.sort((a, b) => b.matchedBlocks - a.matchedBlocks);
  return {
    seq: seq.join(''),
    tail: seq.slice(-12).join(''),
    currentBlocks: blocksOf(seq.slice(-12).join('')),
    matches,
    best: matches[0] || null
  };
}

/* ---------- Dự đoán từ cầu ---------- */
function predictByPattern(sessions) {
  const analysis = analyzeCurrentPattern(sessions);
  if (!analysis.best) {
    return { predict: 'TAI', confidence: 55, reason: 'Không khớp cầu rõ ràng', pattern: null, analysis };
  }
  const { best } = analysis;
  const predict = best.nextSide === 'B' ? 'TAI' : 'XIU';
  let confidence = 55 + best.confidenceBoost;
  if (best.isComplete) confidence += 6;
  if (best.matchedBlocks >= 3) confidence += 4;
  confidence = Math.min(confidence, 90);
  return {
    predict,
    confidence,
    reason: `Cầu ${best.name} khớp ${best.matchedBlocks} block | Block hiện tại: ${best.currentCount}/${best.currentBlockLen} (${best.currentSide === 'B' ? 'Tài' : 'Xỉu'}) | → ${predict === 'TAI' ? 'TÀI' : 'XỈU'}`,
    pattern: best,
    analysis
  };
}

/* ---------- Thống kê xác suất cầu (học từ lịch sử) ---------- */
function buildPatternStats(sessions, minSamples = 4) {
  const seq = toSeq(sessions);
  const stats = {};
  for (const pattern of COMMON_PATTERNS) {
    if (pattern.length === 1) continue;
    const cycleLen = pattern.reduce((a, b) => a + b, 0);
    if (cycleLen > 12) continue;
    let total = 0, nextB = 0, nextT = 0;
    for (let i = cycleLen * 2; i < seq.length - 1; i++) {
      const window = seq.slice(i - cycleLen, i);
      const wBlocks = blocksOf(window.join(''));
      let ok = wBlocks.length >= pattern.length;
      if (ok) {
        for (let j = 0; j < pattern.length; j++) {
          if (wBlocks[j] !== pattern[j]) { ok = false; break; }
        }
      }
      if (!ok) continue;
      total++;
      if (seq[i] === 'B') nextB++; else nextT++;
    }
    if (total >= minSamples) {
      const pB = nextB / total * 100, pT = nextT / total * 100;
      stats[pattern.join('-')] = {
        pattern, name: pattern.join('-'), total, nextB, nextT,
        pB: pB.toFixed(1), pT: pT.toFixed(1),
        predict: nextB > nextT ? 'TAI' : 'XIU',
        confidence: Math.round(Math.max(pB, pT))
      };
    }
  }
  return stats;
}

/* ---------- Dự đoán tổng hợp (cầu + stats + điểm) ---------- */
function predictAdvanced(sessions, opts = {}) {
  const W_PATTERN = opts.wPattern ?? 0.55;
  const W_STATS   = opts.wStats   ?? 0.25;
  const W_SCORE   = opts.wScore   ?? 0.20;

  if (sessions.length < 5) {
    return { predict: 'TAI', confidence: 55, reason: 'Không đủ mẫu' };
  }

  const seq = toSeq(sessions);
  const last = sessions[sessions.length - 1];
  const patternPred = predictByPattern(sessions);
  const patternStats = buildPatternStats(sessions);
  const currentTail = seq.slice(-12).join('');
  const currentBlocks = blocksOf(currentTail);

  let statsMatch = null;
  for (const len of [3, 2]) {
    if (currentBlocks.length >= len) {
      const key = currentBlocks.slice(-len).join('-');
      if (patternStats[key]) { statsMatch = patternStats[key]; break; }
    }
  }

  const scoreStats = {};
  for (let i = 0; i < sessions.length - 1; i++) {
    const k = `${sessions[i].result}_${sessions[i].score}`;
    (scoreStats[k] ??= { B: 0, T: 0 })[sessions[i + 1].result === 'TAI' ? 'B' : 'T']++;
  }
  const scoreMatch = scoreStats[`${last.result}_${last.score}`];

  let vB = 0, vT = 0, wSum = 0;
  if (patternPred.confidence >= 60 && patternPred.pattern) {
    const w = W_PATTERN * (patternPred.confidence / 100);
    patternPred.predict === 'TAI' ? (vB += w) : (vT += w);
    wSum += W_PATTERN;
  }
  if (statsMatch && statsMatch.confidence >= 60) {
    const w = W_STATS * (statsMatch.confidence / 100);
    statsMatch.predict === 'TAI' ? (vB += w) : (vT += w);
    wSum += W_STATS;
  }
  if (scoreMatch) {
    const total = scoreMatch.B + scoreMatch.T;
    if (total >= 5) {
      const pB = scoreMatch.B / total, pT = scoreMatch.T / total;
      if (Math.max(pB, pT) >= 0.58) {
        const w = W_SCORE * Math.max(pB, pT);
        pB > pT ? (vB += w) : (vT += w);
        wSum += W_SCORE;
      }
    }
  }

  if (wSum === 0) return { predict: 'TAI', confidence: 55, reason: 'Cầu loạn' };

  const predict = vB >= vT ? 'TAI' : 'XIU';
  const confidence = Math.min(92, Math.max(55, Math.round(Math.max(vB, vT) / wSum * 100)));

  return {
    predict, confidence, reason: patternPred.reason,
    details: { pattern: patternPred.pattern, stats: statsMatch, score: scoreMatch ? { B: scoreMatch.B, T: scoreMatch.T } : null }
  };
}
/* ══════════════════════════════════════════════════════════════════
 *  PARSE DỮ LIỆU TỪ API
 * ══════════════════════════════════════════════════════════════════ */
function parseLinesHu(data) {
  if (!data || !Array.isArray(data.list)) return [];
  return data.list.map(item => ({
    session: item.id,
    dice: item.dices,
    score: item.point,
    result: item.point >= 11 ? 'TAI' : 'XIU'
  })).sort((a, b) => a.session - b.session);
}

function parseLinesMd5(data) {
  if (!data || !Array.isArray(data.list)) return [];
  return data.list.map(item => ({
    session: item.id,
    dice: item.dices,
    score: item.point,
    result: item.resultTruyenThong === 'Tài' ? 'TAI' : 'XIU'
  })).sort((a, b) => a.session - b.session);
}

/* ══════════════════════════════════════════════════════════════════
 *  GLOBAL STATE
 * ══════════════════════════════════════════════════════════════════ */
let huHistory  = [];
let md5History = [];
let currentSessionIdHu  = null;
let currentSessionIdMd5 = null;
let huPredictionLog  = [];
let md5PredictionLog = [];

/* ══════════════════════════════════════════════════════════════════
 *  FETCH DATA TỪ API
 * ══════════════════════════════════════════════════════════════════ */
async function fetchHuData() {
  try {
    const res = await fetch(API_URL_HU);
    const data = await res.json();
    const newHistory = parseLinesHu(data);
    if (newHistory.length === 0) return;
    const lastSession = newHistory.at(-1);
    if (!currentSessionIdHu) {
      huHistory = newHistory.slice().reverse();
      currentSessionIdHu = lastSession.session;
      console.log(`✅ [HŨ] Đã tải ${newHistory.length} phiên`);
    } else if (lastSession.session > currentSessionIdHu) {
      const newRecords = newHistory.filter(r => r.session > currentSessionIdHu);
      for (const r of newRecords) huHistory.unshift(r);
      if (huHistory.length > 1000) huHistory = huHistory.slice(0, 800);
      currentSessionIdHu = lastSession.session;
      if (newRecords.length > 0) console.log(`🆕 [HŨ] +${newRecords.length} phiên mới`);
    }
    verifyPredictions(huPredictionLog, huHistory);
  } catch (e) {
    console.error(`❌ [HŨ] Lỗi:`, e.message);
  }
}

async function fetchMd5Data() {
  try {
    const res = await fetch(API_URL_MD5);
    const data = await res.json();
    const newHistory = parseLinesMd5(data);
    if (newHistory.length === 0) return;
    const lastSession = newHistory.at(-1);
    if (!currentSessionIdMd5) {
      md5History = newHistory.slice().reverse();
      currentSessionIdMd5 = lastSession.session;
      console.log(`✅ [MD5] Đã tải ${newHistory.length} phiên`);
    } else if (lastSession.session > currentSessionIdMd5) {
      const newRecords = newHistory.filter(r => r.session > currentSessionIdMd5);
      for (const r of newRecords) md5History.unshift(r);
      if (md5History.length > 1000) md5History = md5History.slice(0, 800);
      currentSessionIdMd5 = lastSession.session;
      if (newRecords.length > 0) console.log(`🆕 [MD5] +${newRecords.length} phiên mới`);
    }
    verifyPredictions(md5PredictionLog, md5History);
  } catch (e) {
    console.error(`❌ [MD5] Lỗi:`, e.message);
  }
}
/* ══════════════════════════════════════════════════════════════════
 *  PREDICTION LOG — ĐÚNG/SAI
 * ══════════════════════════════════════════════════════════════════ */
function recordPrediction(log, session, prediction) {
  if (log.find(p => p.session === session)) return;
  log.push({
    session,
    predict: prediction.predict,
    confidence: prediction.confidence,
    reason: prediction.reason,
    actual: null,
    correct: null
  });
  if (log.length > 200) log.splice(0, log.length - 200);
}

function verifyPredictions(log, history) {
  const map = new Map(history.map(h => [h.session, h]));
  for (const p of log) {
    if (p.actual === null && map.has(p.session)) {
      const h = map.get(p.session);
      p.actual  = h.result;
      p.correct = p.predict === p.actual;
    }
  }
}

function buildHistoryReport(log, limit = 30) {
  const finished = log.filter(p => p.actual !== null).sort((a, b) => b.session - a.session).slice(0, limit);
  const total = finished.length;
  const dung  = finished.filter(p => p.correct).length;
  const sai   = total - dung;
  const history = finished.map(p => ({
    phien:       p.session,
    du_doan_cu:  p.predict === 'TAI' ? 'tài' : 'xỉu',
    do_tin_cay:  `${p.confidence}%`,
    ly_do:       p.reason,
    ket_qua:     p.actual === 'TAI' ? 'tài' : 'xỉu',
    check:       p.correct ? 'đúng ✅' : 'sai ❌'
  }));
  return {
    history,
    thong_ke: { tong: total, dung, sai, ti_le: total > 0 ? `${(dung / total * 100).toFixed(1)}%` : '0%' }
  };
}

/* ══════════════════════════════════════════════════════════════════
 *  BUILD RESPONSE (8 TRƯỜNG)
 * ══════════════════════════════════════════════════════════════════ */
function buildResponse(history, gameName, log) {
  const chronological = [...history].reverse();
  const last = history[0];
  const result = predictAdvanced(chronological);
  recordPrediction(log, last.session + 1, result);
  return {
    id: ADMIN_ID,
    phien_truoc: last.session,
    xuc_xac: `${last.dice[0]} - ${last.dice[1]} - ${last.dice[2]}`,
    tong: last.score,
    ket_qua: last.result === 'TAI' ? 'tài' : 'xỉu',
    phien_nay: last.session + 1,
    du_doan: result.predict === 'TAI' ? 'tài' : 'xỉu',
    do_tin_cay: `${result.confidence}%`
  };
}

/* ══════════════════════════════════════════════════════════════════
 *  FASTIFY SETUP
 * ══════════════════════════════════════════════════════════════════ */
const app = fastify({ logger: false });
await app.register(cors, { origin: "*" });
/* ══════════════════════════════════════════════════════════════════
 *  ROUTE GỐC
 * ══════════════════════════════════════════════════════════════════ */
app.get("/", async () => ({
  status: "active",
  message: "API Tài Xỉu — Pattern Analyzer (cầu 1-1, 1-2, 2-2, 3-1...)",
  algorithm: "🎲 Phân tích block pattern + stats + score 🎲",
  endpoints: {
    taixiu:         `/api/taixiu/lc79`,
    md5:            `/api/md5/lc79`,
    taixiu_history: `/api/taixiu/history`,
    md5_history:    `/api/md5/history`,
    taixiu_pattern: `/api/taixiu/pattern`,
    md5_pattern:    `/api/md5/pattern`
  }
}));

/* ══════════════════════════════════════════════════════════════════
 *  DỰ ĐOÁN
 * ══════════════════════════════════════════════════════════════════ */
app.get("/api/taixiu/lc79", async (request, reply) => {
  if (huHistory.length < 5) {
    return reply.status(503).send({
      error: "Đang phân tích dữ liệu, vui lòng chờ...",
      need: "Cần ít nhất 5 phiên",
      current: huHistory.length
    });
  }
  return buildResponse(huHistory, "HŨ", huPredictionLog);
});

app.get("/api/md5/lc79", async (request, reply) => {
  if (md5History.length < 5) {
    return reply.status(503).send({
      error: "Đang phân tích dữ liệu, vui lòng chờ...",
      need: "Cần ít nhất 5 phiên",
      current: md5History.length
    });
  }
  return buildResponse(md5History, "MD5", md5PredictionLog);
});

/* ══════════════════════════════════════════════════════════════════
 *  HISTORY (ĐÚNG/SAI)
 * ══════════════════════════════════════════════════════════════════ */
app.get("/api/taixiu/history", async (request) => {
  const limit = Math.min(parseInt(request.query.limit) || 30, 200);
  return buildHistoryReport(huPredictionLog, limit);
});

app.get("/api/md5/history", async (request) => {
  const limit = Math.min(parseInt(request.query.limit) || 30, 200);
  return buildHistoryReport(md5PredictionLog, limit);
});

/* ══════════════════════════════════════════════════════════════════
 *  PATTERN DEBUG
 * ══════════════════════════════════════════════════════════════════ */
app.get("/api/taixiu/pattern", async () => {
  const chrono = [...huHistory].reverse();
  const analysis = analyzeCurrentPattern(chrono);
  const stats = buildPatternStats(chrono);
  return {
    seq: analysis.seq.slice(-30),
    tail: analysis.tail,
    current_blocks: analysis.currentBlocks,
    best_match: analysis.best,
    all_matches: analysis.matches.slice(0, 5),
    pattern_stats: Object.values(stats).sort((a, b) => b.confidence - a.confidence).slice(0, 20)
  };
});

app.get("/api/md5/pattern", async () => {
  const chrono = [...md5History].reverse();
  const analysis = analyzeCurrentPattern(chrono);
  const stats = buildPatternStats(chrono);
  return {
    seq: analysis.seq.slice(-30),
    tail: analysis.tail,
    current_blocks: analysis.currentBlocks,
    best_match: analysis.best,
    all_matches: analysis.matches.slice(0, 5),
    pattern_stats: Object.values(stats).sort((a, b) => b.confidence - a.confidence).slice(0, 20)
  };
});

/* ══════════════════════════════════════════════════════════════════
 *  START SERVER
 * ══════════════════════════════════════════════════════════════════ */
const start = async () => {
  await Promise.all([fetchHuData(), fetchMd5Data()]);
  setInterval(fetchHuData, 5000);
  setInterval(fetchMd5Data, 5000);
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    console.error("❌ Lỗi khởi động:", err.message);
    process.exit(1);
  }
  console.log("\n╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  TÀI XỈU — PATTERN ANALYZER (không cần key)                     ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  🚀 Port: ${PORT}`);
  console.log(`║  👤 Admin: ${ADMIN_ID}`);
  console.log("║                                                                  ║");
  console.log("║  🎯 ENDPOINTS:                                                  ║");
  console.log("║     GET /api/taixiu/lc79        → dự đoán bàn HŨ               ║");
  console.log("║     GET /api/md5/lc79           → dự đoán bàn MD5              ║");
  console.log("║     GET /api/taixiu/history     → lịch sử đúng/sai HŨ          ║");
  console.log("║     GET /api/md5/history        → lịch sử đúng/sai MD5         ║");
  console.log("║     GET /api/taixiu/pattern     → debug cầu HŨ                 ║");
  console.log("║     GET /api/md5/pattern        → debug cầu MD5                ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");
};

start();