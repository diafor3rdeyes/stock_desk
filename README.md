# 종목 분석 데스크

종목 코드를 넣으면 기업 요약, 최근 뉴스 판단, 차트와 2주 전망, 애널리스트 의견, 최종 결론을 한 화면에 보여주는 사이트입니다. 맨 위에는 공포탐욕지수와 SPY·나스닥100·다우·코스피 현황(RSI 포함)이 항상 나옵니다.

## 구성

```
public/index.html          화면 (차트는 SVG로 직접 그림)
functions/api/market.js    공포탐욕지수(CNN) + 지수 4개 시세·RSI(Yahoo Finance)
functions/api/stock.js     종목 시세·일봉·기술적 지표·지지/저항·2주 변동폭
functions/api/analyze.js   Claude + 웹 검색: 기업요약 / 뉴스 / 전망·애널리스트 / 결론
functions/_lib/util.js     공용 함수
wrangler.toml              Cloudflare Pages 설정
```

## 배포 (클라우드플레어 Pages)

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Cloudflare 대시보드 → Workers & Pages → Create → Pages → Connect to Git 에서 저장소를 고릅니다.
3. 빌드 설정: Framework preset `None`, Build command 비움, Build output directory `public`
4. Settings → Variables and Secrets 에 아래 값을 추가합니다.

| 이름 | 필수 | 설명 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 필수 | console.anthropic.com 에서 발급한 API 키 (Secret으로 저장) |
| `ACCESS_CODE` | 강력 권장 | 아무 문자열. 설정하면 AI 분석 호출에 이 코드가 필요해 남이 내 API 비용을 쓰지 못합니다. 화면 오른쪽 위 "접근 코드"에 같은 값을 입력하세요. |
| `ANTHROPIC_MODEL` | 선택 | 기본값 `claude-sonnet-5-5` |
| `WEB_SEARCH_TOOL` | 선택 | 기본값 `web_search_20250305`. 계정에서 다른 버전을 쓰라는 오류가 나면 이 값을 바꿉니다. |

5. 변수를 저장한 뒤 다시 배포(Retry deployment)합니다.

로컬 테스트: `npx wrangler pages dev public` (같은 변수는 `.dev.vars` 파일에 `KEY=value` 로 적습니다.)

## 사용법

- 미국 종목은 티커(`NVDA`, `AAPL`, `BRK.B`), 한국 종목은 6자리 코드(`005930`, `000660`)를 입력합니다. 코스피를 먼저, 없으면 코스닥으로 찾습니다.
- 시세·차트·지표는 바로 나오고, AI 분석 3개(기업 / 뉴스 / 전망)는 동시에 검색하느라 보통 30~70초 걸립니다. 끝나는 대로 차례로 채워지고, 마지막에 종합 결론이 나옵니다.
- 같은 종목은 서버에 임시 저장해 재사용합니다 (기업 요약 12시간, 뉴스·전망 30분). 그래서 다시 열면 빠르고 API 비용도 줄어듭니다.

## 알아둘 점

- 차트의 2주 "통계적 변동폭"은 최근 60일 변동성으로 계산한 범위이고, 방향 예측이 아닙니다. 방향과 시나리오는 AI가 지표와 뉴스를 보고 판단한 값입니다.
- 지수·시세는 Yahoo Finance 공개 데이터라 장중에는 지연될 수 있습니다. 공포탐욕지수는 CNN이 공개한 값을 그대로 가져옵니다. 두 서비스 모두 공식 API가 아니어서 형식이 바뀌면 `market.js`, `util.js`를 고쳐야 할 수 있습니다.
- 종목 한 번 분석에 웹 검색이 포함된 Claude 호출이 4번 일어납니다. 사용량은 Anthropic 콘솔에서 확인하세요.
- 투자 권유가 아닌 참고 자료입니다.
