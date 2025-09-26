import { chromium } from "playwright";
import fs from "fs/promises";

const GEO_LIST = (process.env.GEO_LIST || "KR").split(",").map(s => s.trim());
const HOURS_LIST = (process.env.HOURS_LIST || "4").split(",").map(s => s.trim());
const CATEGORY_LIST = (process.env.CATEGORY_LIST || "3").split(",").map(s => s.trim());

const OUT_JSON = "data/latest.json";
const SNAPSHOT_DIR = "data/snapshots";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ensureDirs() {
  await fs.mkdir("data", { recursive: true });
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
}

function nowKSTISO() {
  const kst = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false });
  // "2025-09-26 12:34:56" → ISO 비슷하게 변환
  return kst.replace(" ", "T") + "+09:00";
}

async function extractTitles(page) {
  // DOM 변동에 대비한 "후보 셀렉터" 다중 시도
  const selCandidates = [
    'article h3',               // 카드 헤드라인
    'article a[aria-label]',    // 링크에 라벨이 있을 경우
    'div[role="article"] h3',
    'div.card h3',
    'li h3',
    'h3'
  ];
  let texts = [];
  for (const sel of selCandidates) {
    const found = await page.$$eval(sel, els =>
      els.map(e => (e.textContent || "").trim()).filter(Boolean)
    ).catch(() => []);
    texts = (found || []).filter(x => x.length > 0);
    if (texts.length >= 5) break; // 충분히 모였으면 중단
  }
  // 중복 제거 및 상위 30개 제한
  const seen = new Set();
  const dedup = [];
  for (const t of texts) {
    const key = t.replace(/\s+/g, " ").toLowerCase();
    if (!seen.has(key)) { seen.add(key); dedup.push(t); }
    if (dedup.length >= 30) break;
  }
  return dedup;
}

async function crawlOne(ctx, { geo, hours, category }) {
  const url = `https://trends.google.co.kr/trending?geo=${encodeURIComponent(geo)}&hours=${encodeURIComponent(hours)}&category=${encodeURIComponent(category)}`;
  const page = await ctx.newPage();
  const res = await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  await sleep(1200);

  const status = res?.status() ?? 0;
  const html = await page.content();
  const titles = await extractTitles(page);

  // 스냅샷(디버깅용) 저장
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapFile = `${SNAPSHOT_DIR}/trending_${geo}_${hours}h_cat${category}_${stamp}.html`;
  await fs.writeFile(snapFile, html, "utf8");

  await page.close();
  return { url, status, titles, snapshot: snapFile };
}

async function main() {
  await ensureDirs();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  });

  const combos = [];
  for (const geo of GEO_LIST) {
    for (const hours of HOURS_LIST) {
      for (const category of CATEGORY_LIST) {
        try {
          const r = await crawlOne(ctx, { geo, hours, category });
          combos.push({
            geo, hours, category,
            url: r.url, status: r.status,
            count: r.titles.length,
            titles: r.titles
          });
          await sleep(1000 + Math.random() * 1000);
        } catch (e) {
          combos.push({ geo, hours, category, error: String(e) });
        }
      }
    }
  }

  await browser.close();

  const out = {
    fetchedAtKST: nowKSTISO(),
    combos
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(out, null, 2), "utf8");
  console.log(`[crawl] saved ${OUT_JSON}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
