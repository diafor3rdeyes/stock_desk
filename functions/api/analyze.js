// POST /api/analyze — Claude(웹 검색 포함)로 종목 분석
// body: { part: 'company'|'news'|'outlook'|'conclusion', symbol, name, currency, ... }
//
// 환경변수
//   ANTHROPIC_API_KEY  (필수)
//   ACCESS_CODE        (권장) 설정하면 같은 코드를 보낸 요청만 허용 → API 비용 보호
//   ANTHROPIC_MODEL    (선택) 기본 claude-sonnet-5-5
//   WEB_SEARCH_TOOL    (선택) 기본 web_search_20250305
import { json, checkAccess } from '../_lib/util.js';

const TTL = { company: 43200, news: 1800, outlook: 1800, conclusion: 0 };

const SYSTEM = (today) =>
  `당신은 개인 투자자를 돕는 리서치 애널리스트입니다. 오늘 날짜는 ${today}(KST)입니다.
- 반드시 한국어로 씁니다. 조사를 마치면 최종 결과를 submit_report 도구의 입력으로 제출합니다. 입력의 최상위 키는 요청에 적힌 JSON 형식의 키와 같아야 하고, 결과를 글로 출력하지 않습니다.
- 웹 검색으로 최신 공시·실적·뉴스·애널리스트 의견을 확인한 뒤 작성합니다. 검색으로 확인하지 못한 수치는 지어내지 말고 null로 두고 note에 이유를 적습니다.
- 수치에는 기준 기간(예: FY2025, 2026년 2분기)과 통화 단위를 함께 적습니다.
- 투자 권유가 아니라 참고용 분석입니다. 근거가 약하면 확신도를 낮게 표시합니다.`;

function prompts(part, b) {
  const who = `${b.name || b.symbol} (종목코드 ${b.symbol}${b.currency ? ', 통화 ' + b.currency : ''})`;
  if (part === 'company') {
    return {
      searches: 4,
      maxTokens: 3500,
      user: `${who}의 기업 요약을 조사해 아래 JSON으로 답하세요.
{
 "name": "회사명",
 "oneLine": "한 줄 정의(30자 안팎)",
 "summary": "어떤 일을 하는 회사인지 3~5문장. 주요 제품·서비스와 고객, 돈 버는 방식",
 "segments": [
   {"name":"사업 부문명","revenue":"최근 회계연도 부문 매출(통화 포함)","revenueShare":"전체 매출 대비 비중(%)","operatingIncome":"부문 영업이익(없으면 공시 가능한 이익 지표)","profitShare":"전체 영업이익 대비 비중(%) 또는 null"}
 ],
 "topRevenueSegment": "매출이 가장 큰 부문명",
 "topProfitSegment": "영업이익이 가장 큰 부문명",
 "segmentComment": "매출은 큰데 이익은 작은 부문 등 부문 구조에서 눈여겨볼 점 2~3문장",
 "financial": {"period":"기준 기간","revenue":"매출","operatingIncome":"영업이익","operatingMargin":"영업이익률","note":"추이 한 줄"},
 "note": "확인하지 못한 항목이 있으면 설명, 없으면 null"
}
부문 공시가 없는 회사는 제품군·지역별 구분으로 대체하고 note에 밝히세요. 부문은 최대 6개.`,
    };
  }
  if (part === 'news') {
    return {
      searches: 7,
      maxTokens: 5000,
      user: `${who}의 최근 한 달 안팎 뉴스를 가능한 한 폭넓게 검색해 중요한 순서대로 최대 10건 정리하고, 각 뉴스가 앞으로 주가에 줄 영향을 판단하세요.
{
 "items": [
   {"title":"기사 제목","source":"언론사","date":"YYYY-MM-DD","url":"기사 주소","summary":"2문장 요약","impact":"호재|악재|중립","horizon":"단기(2주 이내)|중기(1~3개월)|장기","magnitude":1~5 정수,"reasoning":"왜 그렇게 판단했는지 1~2문장"}
 ],
 "overall": {"sentiment":"긍정|부정|혼조|중립","netImpact2w":"앞으로 2주 주가에 미칠 순영향 한 줄","summary":"뉴스 흐름 종합 3~4문장","keyThemes":["핵심 테마 2~4개"]},
 "note": "검색에서 확인하지 못한 점이 있으면 설명, 없으면 null"
}
같은 사건을 다룬 기사는 하나로 합치고, 주가와 무관한 기사는 제외하세요. url은 검색 결과에서 확인한 실제 주소만 쓰세요.`,
    };
  }
  if (part === 'outlook') {
    const t = JSON.stringify(b.tech || {});
    return {
      searches: 5,
      maxTokens: 5000,
      user: `${who}의 향후 2주(영업일 10일) 주가 흐름을 전망하세요. 현재가는 ${b.price}입니다.
아래는 서버가 계산한 차트 지표입니다. 가격 수준은 이 지표(이동평균, 지지·저항 후보, ATR, 변동성 범위)에서 크게 벗어나지 않게 정하고, 웹 검색으로 애널리스트 목표주가·투자의견·최근 실적/이벤트 일정을 확인하세요.
차트 지표: ${t}

{
 "forecast": {
   "direction": "상승|횡보|하락",
   "confidence": "낮음|중간|높음",
   "expectedRange": {"low": 숫자, "high": 숫자},
   "scenarios": {
     "bull": {"price": 숫자, "probabilityPct": 숫자, "narrative": "조건과 근거 1~2문장"},
     "base": {"price": 숫자, "probabilityPct": 숫자, "narrative": "..."},
     "bear": {"price": 숫자, "probabilityPct": 숫자, "narrative": "..."}
   },
   "rationale": "차트 흐름(추세·모멘텀·거래량)을 근거로 한 판단 3~4문장"
 },
 "levels": {
   "resistances": [{"price": 숫자, "reason": "왜 저항인지"}],
   "supports": [{"price": 숫자, "reason": "..."}],
   "sellPlan": {
     "target1": {"price": 숫자, "action": "예: 보유분의 1/3 분할 매도"},
     "target2": {"price": 숫자, "action": "..."},
     "stopLoss": {"price": 숫자, "action": "..."},
     "timing": "매도·비중 축소를 고려할 시점과 신호(예: 저항선 돌파 실패, RSI 70 이탈, 실적 발표 전) 2~3문장"
   }
 },
 "analysts": {
   "consensus": "매수|중립|매도 중 컨센서스와 한 줄 설명",
   "targetAvg": 숫자 또는 null, "targetHigh": 숫자 또는 null, "targetLow": 숫자 또는 null,
   "analystCount": 숫자 또는 null, "upsidePct": 현재가 대비 평균 목표가 괴리율(%) 또는 null,
   "recent": [{"firm":"증권사","action":"상향|하향|유지|신규","rating":"의견","target":숫자 또는 null,"date":"YYYY-MM-DD"}],
   "comment": "애널리스트 시각 요약 2문장"
 },
 "events": [{"date":"YYYY-MM-DD","event":"2주 안의 실적 발표·FOMC·배당락·제품 발표 등","relevance":"왜 중요한지"}],
 "note": "확인하지 못한 점이 있으면 설명, 없으면 null"
}
확률 합계는 100으로 맞추세요. 저항선·지지선은 각 2~3개, 가까운 순서로 쓰세요. 현재가가 52주 신고가권이면 저항선은 심리적 가격대나 피보나치 확장 수준으로 보완하고 reason에 밝히세요.`,
    };
  }
  if (part === 'conclusion') {
    return {
      searches: 0,
      maxTokens: 2500,
      user: `${who}에 대해 아래 조사 결과를 종합해 최종 결론을 쓰세요. 검색은 하지 말고, 주어진 자료 안에서 서로 충돌하는 점이 있으면 그대로 드러내세요.
자료: ${JSON.stringify(b.digest || {})}

{
 "stance": "매수 우위|분할 매수 관심|관망|비중 축소 고려|매도 우위 중 하나",
 "score": -5~5 정수(양수일수록 우호적),
 "oneLine": "결론 한 문장",
 "summary": "기업·뉴스·차트·애널리스트를 묶은 종합 의견 5~7문장",
 "bullets": ["핵심 판단 근거 3~5개"],
 "risks": ["주요 위험 요인 2~4개"],
 "catalysts": ["향후 2주 주가를 움직일 변수 2~4개"],
 "actionPlan": "신규 진입자와 보유자 각각이 2주 동안 확인할 가격·신호 3~4문장"
}`,
    };
  }
  return null;
}

const SUBMIT_TOOL = {
  name: 'submit_report',
  description:
    '조사를 마친 뒤 최종 결과를 이 도구의 입력으로 제출합니다. 입력의 최상위 키는 요청에 적힌 JSON 형식의 키와 같아야 합니다.',
  input_schema: { type: 'object', additionalProperties: true },
};

function extractJson(text) {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('분석 결과를 해석하지 못했습니다.');
  const raw = text.slice(a, b + 1);
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 흔한 오류(끝 쉼표, 따옴표 모양)만 고쳐 한 번 더 시도
    const fixed = raw
      .replace(/[“”]/g, '"')
      .replace(/,\s*([}\]])/g, '$1');
    return JSON.parse(fixed);
  }
}

// 결과는 submit_report 도구 입력(API가 JSON 문법을 보장)으로 받는다. 안 쓰면 본문에서 JSON을 찾고, 그것도 안 되면 제출을 강제한다.
async function callClaude(env, { user, searches, maxTokens }, today) {
  const messages = [{ role: 'user', content: user }];
  const tools = [];
  if (searches) tools.push({ type: env.WEB_SEARCH_TOOL || 'web_search_20250305', name: 'web_search', max_uses: searches });
  tools.push(SUBMIT_TOOL);
  let force = !searches; // 검색이 없는 결론 단계는 처음부터 제출을 강제
  for (let turn = 0; turn < 5; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: maxTokens,
        system: SYSTEM(today),
        messages,
        tools,
        ...(force ? { tool_choice: { type: 'tool', name: 'submit_report' } } : {}),
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Claude API ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const blocks = data.content || [];

    const sub = blocks.find((b) => b.type === 'tool_use' && b.name === 'submit_report');
    if (sub && sub.input && typeof sub.input === 'object') return sub.input;

    if (data.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }

    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return extractJson(text);
    } catch (e) {
      messages.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(검색 완료)' }] });
      messages.push({ role: 'user', content: '조사한 내용을 요청한 형식 그대로 submit_report 도구로 제출해 주세요.' });
      force = true;
    }
  }
  throw new Error('분석 결과를 받지 못했습니다. 다시 시도해 주세요.');
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  if (!env.ANTHROPIC_API_KEY) return json({ ok: false, error: '서버에 ANTHROPIC_API_KEY가 설정되지 않았습니다.' }, 500);
  if (!checkAccess(request, env)) return json({ ok: false, error: '접근 코드가 올바르지 않습니다.' }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: '잘못된 요청입니다.' }, 400);
  }
  const part = body.part;
  const symbol = String(body.symbol || '').trim().toUpperCase();
  if (!symbol || !/^[A-Z0-9.\-^]{1,16}$/.test(symbol)) return json({ ok: false, error: '종목 코드가 올바르지 않습니다.' }, 400);
  const spec = prompts(part, { ...body, symbol });
  if (!spec) return json({ ok: false, error: '알 수 없는 분석 항목입니다.' }, 400);

  const ttl = TTL[part];
  const cacheKey = new Request(`https://cache.stock-desk.internal/analyze/${part}/${encodeURIComponent(symbol)}`);
  if (ttl) {
    const hit = await caches.default.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'x-cache': 'HIT' } });
  }

  // 검색이 길어질 때 연결이 끊기지 않도록 공백을 주기적으로 흘려보낸 뒤 JSON을 마지막에 보낸다.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const work = (async () => {
    const beat = setInterval(() => writer.write(enc.encode(' ')).catch(() => {}), 8000);
    let out;
    try {
      const data = await callClaude(env, spec, today);
      out = JSON.stringify({ ok: true, data, generatedAt: Date.now() });
      if (ttl) {
        waitUntil(
          caches.default.put(
            cacheKey,
            new Response(out, {
              headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${ttl}` },
            })
          )
        );
      }
    } catch (e) {
      out = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    } finally {
      clearInterval(beat);
    }
    await writer.write(enc.encode(out));
    await writer.close();
  })();
  waitUntil(work);

  return new Response(readable, {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'MISS' },
  });
}
