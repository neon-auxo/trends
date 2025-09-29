# -*- coding: utf-8 -*-
import os, json, time, random, pathlib, datetime as dt
import pandas as pd
from pytrends.request import TrendReq

# 환경변수로 국가 목록 제어(기본 KR,US,JP)
PNS = [s.strip() for s in os.getenv("PN_LIST", "KR,US,JP").split(",") if s.strip()]
HL  = os.getenv("HL", "ko")         # 호스트 언어
TZ  = int(os.getenv("TZ", "540"))   # 분 단위(예: KST=+9h => 540분). pytrends는 양수 표기.  [oai_citation:2‡GitHub](https://github.com/GeneralMills/pytrends)

out_dir = pathlib.Path("data/pytrends")
out_dir.mkdir(parents=True, exist_ok=True)

kst = dt.timezone(dt.timedelta(hours=9))
now = dt.datetime.now(kst)
stamp = now.strftime("%Y-%m-%dT%H-%M-%S%z")

pytrends = TrendReq(
    hl=HL, tz=TZ,
    timeout=(10, 25),
    retries=int(os.getenv("RETRIES","3")),
    backoff_factor=float(os.getenv("BACKOFF","0.3")),
)

result = {
    "fetchedAtKST": now.isoformat(),
    "pns": PNS,
    "hl": HL,
    "tz": TZ,
    "combos": []
}

for pn in PNS:
    # 레이트리밋 완화: 소량 지터
    time.sleep(1 + random.random())

    entry = {"pn": pn, "count": 0, "ok": False, "error": None, "csv": None, "sample": None}
    try:
        df = pytrends.realtime_trending_searches(pn=pn)  # 실시간 트렌드 DF 반환  [oai_citation:3‡GitHub](https://github.com/GeneralMills/pytrends)
        entry["count"] = len(df)
        if len(df):
            csv_path = out_dir / f"realtime_{pn}_{stamp}.csv"
            df.to_csv(csv_path, index=False)
            entry["csv"] = str(csv_path)
            # 로그·검증용으로 상위 5개만 JSON에 샘플 포함
            entry["sample"] = df.head(5).to_dict(orient="records")
        entry["ok"] = True
    except Exception as e:
        entry["error"] = str(e)

    result["combos"].append(entry)

# latest.json 갱신
latest_path = out_dir / "latest.json"
with open(latest_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(json.dumps(
    {k: (v if k != "combos" else [{ "pn": c["pn"], "count": c["count"], "ok": c["ok"], "err": c["error"] } for c in result["combos"]]) for k, v in result.items()}
    , ensure_ascii=False, indent=2))