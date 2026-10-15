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

// 네이버에서 현재가를 받는다. (국내: m.stock.naver.com / 해외: api.stock.naver.com, 종목코드 뒤 .O=나스닥 .N=뉴욕 .K=아카 .A=아멕스)
// 야후는 시세가 늦거나 어제 값에 머무는 경우가 있어 네이버를 우선 사용하고, 실패하거나 값이 이상하면 야후 값을 쓴다.
async function fetchNaverBasic(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 2500);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', Accept: 'application/json' },
      cf: { cacheTtl: 10, cacheEverything: true },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

function parseNaverBasic(j) {
  if (!j || typeof j !== 'object') return null;
  const num = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  const price = num(j.closePrice);
  const ratio = num(j.fluctuationsRatio);
  const absChg = Math.abs(num(j.compareToPreviousClosePrice));
  if (!(price > 0) || !Number.isFinite(ratio) || !Number.isFinite(absChg)) return null;
  const prev = price - (ratio < 0 ? -absChg : absChg);
  if (!(prev > 0)) return null;
  const t = j.localTradedAt ? Date.parse(j.localTradedAt) / 1000 : NaN;
  return { price, prev, asOf: Number.isFinite(t) ? t : Math.floor(Date.now() / 1000) };
}

async function naverQuote(sym, meta) {
  const kr = /^(\d{6})\.(KS|KQ)$/.exec(sym);
  if (kr) return parseNaverBasic(await fetchNaverBasic(`https://m.stock.naver.com/api/stock/${kr[1]}/basic`));
  if (!/^[A-Z]{1,5}([.\-][A-Z])?$/.test(sym) || (meta && meta.currency && meta.currency !== 'USD')) return null;
  const tk = sym.replace('-', '.');
  const ex = String((meta && (meta.fullExchangeName || meta.exchangeName)) || '').toLowerCase();
  let order = ['O', 'N', 'K', 'A'];
  if (ex.includes('nasdaq') || ex.startsWith('nm') || ex.startsWith('nc')) order = ['O', 'N', 'K', 'A'];
  else if (ex.includes('arca') || ex === 'pcx') order = ['K', 'N', 'O', 'A'];
  else if (ex.includes('american') || ex === 'ase') order = ['A', 'N', 'K', 'O'];
  else if (ex.includes('nyse') || ex === 'nyq') order = ['N', 'K', 'A', 'O'];
  const results = await Promise.all(order.map((sfx) => fetchNaverBasic(`https://api.stock.naver.com/stock/${tk}.${sfx}/basic`)));
  for (const j of results) {
    if (!j) continue;
    const code = String(j.reutersCode || j.symbolCode || '').toUpperCase();
    if (code && !(code === tk || code.startsWith(tk + '.'))) continue; // 다른 종목이면 건너뜀
    const q = parseNaverBasic(j);
    if (q) return q;
  }
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
  let source = 'yahoo';
  const nq = await naverQuote(symbol, meta);
  // 야후 값과 20% 넘게 다르면 잘못 잡힌 것으로 보고 무시한다
  if (nq && Math.abs(nq.price / livePrice - 1) < 0.2) {
    source = 'naver';
    livePrice = nq.price;
    prev = nq.prev;
    asOf = nq.asOf;
    const off = /\.(KS|KQ)$/.test(symbol) ? 9 * 3600 : meta.gmtoffset || 0;
    const dayOf = (t) => Math.floor((t + off) / 86400);
    if (dayOf(rows[n - 1].t) === dayOf(nq.asOf)) rows[n - 1].c = nq.price; // 오늘 일봉이 이미 있으면 현재가로 맞춘다
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
      source,
      koName,
      rows: chartRows,
      rsiHist: rsiSeries(rows),
      tech,
    },
    200,
    { 'cache-control': 'public, max-age=0, s-maxage=15' }
  );
}
