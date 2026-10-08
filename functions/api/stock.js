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
  const tech = computeTech(rows);
  const n = rows.length;
  const prev = n > 1 ? rows[n - 2].c : meta.chartPreviousClose;
  const chartRows = rows.slice(-130);
  const koName = await naverKoName(symbol);

  return json(
    {
      symbol,
      inputSymbol: input.trim().toUpperCase(),
      name: meta.longName || meta.shortName || symbol,
      currency: meta.currency,
      exchange: meta.fullExchangeName || meta.exchangeName,
      price: rows[n - 1].c,
      prevClose: prev,
      change: rows[n - 1].c - prev,
      changePct: (rows[n - 1].c / prev - 1) * 100,
      asOf: rows[n - 1].t,
      koName,
      rows: chartRows,
      rsiHist: rsiSeries(rows),
      tech,
    },
    200,
    { 'cache-control': 'public, max-age=60, s-maxage=300' }
  );
}
