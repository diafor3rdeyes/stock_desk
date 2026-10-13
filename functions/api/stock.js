// GET /api/stock?symbol=005930  또는  ?symbol=NVDA — 시세·차트·기술적 지표
import { json, symbolCandidates, yahooChart, computeTech, rsiSeries } from '../_lib/util.js';

async function naverKoName(sym) {
  const m = /^(\d{6})\.(KS|KQ)$/.exec(sym);
  if (!m) return null;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`https://ac.stock.naver.com/ac?q=${m[1]}&target=stock`, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json();
    const it = j && j.items && j.items[0];
    if (!it) return null;
    if (typeof it.name === 'string') return it.name;
    if (Array.isArray(it) && Array.isArray(it[0]) && typeof it[0][0] === 'string') return it[0][0];
    if (Array.isArray(it) && typeof it[0] === 'string') return it[0];
  } catch (e) { /* 영문 이름 유지 */ }
  return null;
}

export async function onRequestGet({ request }) {
  const input = new URL(request.url).searchParams.get('symbol') || '';
  const candidates = symbolCandidates(input);
  if (!candidates.length) return json({ error: '종목 코드를 입력해 주세요.' }, 400);

  let found = null;
  let lastErr = null;
  for (const sym of candidates) {
    try {
      const d = await yahooChart(sym, '1y', '1d');
      if (d.rows.length >= 30) {
        found = { symbol: sym, ...d };
        break;
      }
      lastErr = new Error('시세 데이터가 부족합니다');
    } catch (e) {
      lastErr = e;
    }
  }
  if (!found) {
    return json({ error: `'${input}' 종목을 찾지 못했습니다. (${lastErr ? lastErr.message : '조회 실패'})` }, 404);
  }

  const { meta, rows, symbol } = found;
  const n = rows.length;
  // 일봉의 마지막 값이 어제 종가에 머물러 있을 수 있어서, Yahoo의 '현재가(regularMarketPrice)'를 우선 사용한다.
  let prev = n > 1 ? rows[n - 2].c : meta.chartPreviousClose;
  let livePrice = rows[n - 1].c;
  let asOf = rows[n - 1].t;
  const lp = meta.regularMarketPrice, lt = meta.regularMarketTime;
  if (Number.isFinite(lp) && lp > 0 && Number.isFinite(lt)) {
    const off = meta.gmtoffset || 0;
    const sameDay = Math.floor((lt + off) / 86400) === Math.floor((rows[n - 1].t + off) / 86400);
    if (sameDay) {
      rows[n - 1].c = lp;
      livePrice = lp;
      asOf = Math.max(asOf, lt);
    } else if (lt > rows[n - 1].t) {
      prev = rows[n - 1].c; // 마지막 일봉은 직전 거래일 종가
      livePrice = lp;
      asOf = lt;
    }
  }
  const tech = computeTech(rows);
  const chartRows = rows.slice(-130);
  const koName = await naverKoName(symbol);

  return json(
    {
      symbol,
      inputSymbol: input.trim().toUpperCase(),
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency,
      exchange: meta.fullExchangeName || meta.exchangeName,
      price: livePrice,
      prevClose: prev,
      change: livePrice - prev,
      changePct: (livePrice / prev - 1) * 100,
      asOf,
      koName,
      rows: chartRows,
      rsiHist: rsiSeries(rows),
      tech,
    },
    200,
    { 'cache-control': 'public, max-age=0, s-maxage=15' }
  );
}
