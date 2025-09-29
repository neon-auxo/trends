# scripts/selenium_batchexecute.py
# python 3.11+, selenium 4.24.0

import json, time, pathlib, datetime as dt, os
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

def run_one(geo="KR", hl="ko", category="3", hours="4", tz="-540", headless=True, wait_sec=35):
    out_dir = pathlib.Path("data/selenium"); out_dir.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")

    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    # 언어/UA
    lang = {"KR":"ko-KR,ko;q=0.9,en;q=0.8,ja;q=0.7",
            "US":"en-US,en;q=0.9,ko;q=0.6",
            "JP":"ja-JP,ja;q=0.9,en;q=0.6,ko;q=0.5"}.get(geo, "en-US,en;q=0.9")
    opts.add_argument(f"--lang={lang}")
    opts.add_argument("--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0 Safari/537.36")

    # 네트워크 로그
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    driver = webdriver.Chrome(options=opts)
    driver.set_page_load_timeout(45)
    driver.execute_cdp_cmd("Network.enable", {})
    driver.execute_cdp_cmd("Page.enable", {})
    driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument",
        {"source":"Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"})

    url = f"https://trends.google.com/trending?geo={geo}&hl={hl}&hours={hours}&category={category}&tz={tz}"
    body_chosen, chosen_url = None, None
    try:
        driver.get(url)

        deadline = time.time() + wait_sec
        cand_bodies = []   # [(url, status, body_text)]
        while time.time() < deadline:
            # 내부 요청 유도용 스크롤 (가끔 필요)
            try:
                driver.execute_script("window.scrollBy(0, 300)")
            except Exception:
                pass
            # 수집
            logs = driver.get_log("performance")
            for e in logs:
                m = json.loads(e["message"]).get("message", {})
                if m.get("method") != "Network.responseReceived":
                    continue
                resp = m["params"]["response"]
                u = resp.get("url", "")
                if "/_/TrendsUi/data/batchexecute" not in u:
                    continue
                st = resp.get("status")
                if st != 200:
                    continue
                req_id = m["params"]["requestId"]
                data = driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": req_id})
                body = data.get("body", "")
                if body:
                    cand_bodies.append((u, st, body))
            # 충분히 모였거나 타임아웃
            if len(cand_bodies) >= 3:
                break
            time.sleep(0.7)

        if not cand_bodies:
            # 그래도 파일 하나 남기자(빈 본문)
            empty_name = out_dir / f"batchexecute_{geo}_{ts}_3.txt"
            empty_name.write_text("(empty)", encoding="utf-8")
            print(f"[warn] {geo}: no batchexecute 200 responses; saved empty {empty_name.name}")
            return

        # 1순위: 본문에 'trendingStories' 들어있는 응답
        idx = next((i for i, (_, _, b) in enumerate(cand_bodies) if "trendingStories" in b or "storySummaries" in b), None)
        # 2순위: 3번째 수집분(0-based 2)
        if idx is None:
            idx = 2 if len(cand_bodies) >= 3 else len(cand_bodies)-1

        chosen_url, _, body_chosen = cand_bodies[idx]

        # 선택본만 *_3.txt 로 저장
        out_path = out_dir / f"batchexecute_{geo}_{ts}_3.txt"
        out_path.write_text(body_chosen, encoding="utf-8")

        # 요약 로그(콘솔)
        print(json.dumps({
            "geo": geo, "countCollected": len(cand_bodies),
            "chosenIndex": idx+1, "hasTrendingStories": ("trendingStories" in body_chosen),
            "saved": out_path.name,
        }, ensure_ascii=False))

    finally:
        driver.quit()

def main():
    geos = os.getenv("GEO_LIST", "KR,US,JP").split(",")
    category = os.getenv("CATEGORY", "3")
    hours = os.getenv("HOURS", "4")
    tz = os.getenv("TZ", "-540")   # KST
    # geo별 기본 hl
    HL_BY = {"KR":"ko","US":"en","JP":"ja"}

    headless = os.getenv("HEADED","0") != "1"
    for g in [x.strip() for x in geos if x.strip()]:
        hl = HL_BY.get(g, "en")
        run_one(geo=g, hl=hl, category=category, hours=hours, tz=tz, headless=headless, wait_sec=35)

if __name__ == "__main__":
    main()