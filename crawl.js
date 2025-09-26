// crawl.js — 트렌드 실데이터(카드 단위) 추출 버전
import { chromium } from "playwright";
import fs from "fs/promises";
import crypto from "crypto";

const GEO_LIST = (process.env.GEO_LIST || "KR").split(",").map(s => s.trim());
const HOURS_LIST = (process.env.HOURS_LIST || "4").split(",").map(s => s.trim());
const CATEGORY_LIST = (process.env.CATEGORY_LIST || "3").split(",").map(s => s.trim());

const OUT_JSON = "data/latest.json";
const SNAPSHOT_DIR = "data/snapshots";
const HISTORY_DIR = "data/history";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha256 = (s) => "sha256:" + crypto.createHash("sha256").update(s || "").digest("hex");
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function nowKSTISO() {
  const kst = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false });
  return kst.replace(" ", "T") + "+09:00";
}

async function ensureDirs() {
  await fs.mkdir("data", { recursive: true });
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });
}

async function waitForAny(page, selectors, timeout = 8000) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout });
      return sel;
    } catch (_) {}
  }
  throw new Error("필수 셀렉터를 찾지 못했습니다(페이지 구조 변경 가능).");
}

// 카드 단위 추출(다중 후보 셀렉터)
async function extractItems(page) {
  // 페이지 구조 변화 대비: 여러 후보 컨테이너/제목 셀렉터를 순차 시도
  const containerSel = [
    "article",                     // 최우선
    "main article",
    "div[role='article']",
    "section article",
    "li[role='listitem'] article"
  ];
  await waitForAny(page, containerSel, 8000);

  const items = await page.$$eval(containerSel.join(","), (nodes) => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

    // 각 카드에서 핵심 필드 수집
    const pick = (el) => {
      // 제목 후보
      const title =
        norm(el.querySelector("h3")?.textContent) ||
        norm(el.querySelector("h2")?.textContent) ||
        norm(el.querySelector("a[aria-label]")?.getAttribute("aria-label")) ||
        "";

      // 설명 후보(너무 길면 잘라줌)
      let desc = "";
      const descCand = [
        "p", "div[role='paragraph']", "div p", "article p"
      ];
      for (const s of descCand) {
        const t = norm(el.querySelector(s)?.textContent);
        if (t && t.length >= 20) { desc = t; break; }
      }
      if (!desc) {
        const short = norm(el.textContent || "");
        desc = short.length > 160 ? short.slice(0, 160) : short;
      }

      // 트렌드 내부 탐색 링크(있을 때)
      const explore =
        el.querySelector("a[href*='/trends/']")?.href ||
        el.querySelector("a[href*='trends.google']")?.href || "";

      // 외부 관련 링크 상위 3개 (google trends 도메인은 제외)
      const links = Array.from(el.querySelectorAll("a[href^='http']"))
        .map(a => ({ title: norm(a.textContent), url: a.href, domain: host(a.href) }))
        .filter(x => x.url && x.title && !/trends\.google/i.test(x.domain))
        .slice(0, 3);

      return { term: title, desc, explore, links };
    };

    const out = [];
    for (const el of nodes) {
      const row = pick(el);
      if (row.term) out.push(row);
    }
    // 중복 제거(제목 기준)
    const seen = new Set();
    const dedup = [];
    for (const r of out) {
      const key = r.term.toLowerCase();
      if (!seen.has(key)) { seen.add(key); dedup.push(r); }
    }
    // 상위 30개까지만
    return dedup.slice(0, 30).map((r, i) => ({ rank: i + 1, ...r }));
  });

  return items;
}

async function crawlOne(ctx, { geo, hours, category }) {
  const url = `https://trends.google.co.kr/trending?geo=${encodeURIComponent(geo)}&hours=${encodeURIComponent(hours)}&category=${encodeURIComponent(category)}`;
  const page = await ctx.newPage();
  const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await sleep(1200);

  const status = resp?.status() ?? 0;

  // 실데이터 추출
  const items = await extractItems(page);

  // 디버깅용 스냅샷 저장(용량 우려 시 .gitignore 권장)
  const html = await page.content();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapFile = `${SNAPSHOT_DIR}/trending_${geo}_${hours}h_cat${category}_${stamp}.html`;
  await fs.writeFile(snapFile, html, "utf8");

  await page.close();

  // 페이지 해시(항목 기준) — 동일이면 변화 없음 판단
  const pageHash = sha256(JSON.stringify(items.map(x => x.term)));

  return {
    geo, hours, category, url, status,
    capturedAtKST: nowKSTISO(),
    pageHash,
    itemCount: items.length,
    items,
    snapshot: snapFile
  };
}

async function main() {
  await ensureDirs();

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });

  const combos = [];
  for (const geo of GEO_LIST) {
    for (const hours of HOURS_LIST) {
      for (const category of CATEGORY_LIST) {
        try {
          const rec = await crawlOne(ctx, { geo, hours, category });
          combos.push(rec);
          await sleep(800 + Math.random() * 900);
        } catch (e) {
          combos.push({ geo, hours, category, error: String(e), capturedAtKST: nowKSTISO() });
        }
      }
    }
  }

  await browser.close();

  // latest.json 저장(요약)
  const latest = {
    fetchedAtKST: nowKSTISO(),
    combos
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(latest, null, 2), "utf8");

  // history에도 저장(타임스탬프 파일)
  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
  const histFile = `${HISTORY_DIR}/latest_${ts}.json`;
  await fs.writeFile(histFile, JSON.stringify(latest), "utf8");

  console.log(`[crawl] combos=${combos.length}, saved ${OUT_JSON} & ${histFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
