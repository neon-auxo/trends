// crawl.js — CSV 우선 + DOM 폴백, 실데이터 추출 안정화
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

/* ---------------- CSV 경로 ---------------- */

// 단순 CSV 파서(따옴표/콤마/세미콜론 대응)
function splitCSVLine(line, delim = ",") {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
function detectDelim(headerLine) {
  const c = (headerLine.match(/,/g) || []).length;
  const s = (headerLine.match(/;/g) || []).length;
  return s > c ? ";" : ",";
}
function parseCSVToItems(csvText) {
  const lines = csvText.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const delim = detectDelim(lines[0]);
  const header = splitCSVLine(lines[0], delim).map(h => h.trim().toLowerCase());

  // 컬럼 인덱스 추정
  const idx = (names) => {
    const re = new RegExp(names.join("|"), "i");
    let k = header.findIndex(h => re.test(h));
    if (k < 0) {
      // 한글 헤더 대응
      k = header.findIndex(h => /검색|키워드|제목/.test(h));
    }
    return k;
  };
  const titleIdx = idx(["title", "query", "term", "entity"]);
  const urlIdx   = idx(["url", "link"]);
  const descIdx  = idx(["description", "snippet", "summary"]);

  const items = [];
  let rank = 0;
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i], delim);
    if (!cols.length) continue;
    const term = norm(cols[titleIdx] || "");
    if (!term) continue;
    const url = norm(cols[urlIdx] || "");
    const desc = norm(cols[descIdx] || "");
    items.push({
      rank: ++rank,
      term,
      desc,
      explore: "",
      links: url ? [{ title: term, url, domain: host(url) }] : []
    });
    if (items.length >= 30) break;
  }
  return items;
}

async function tryDownloadCSV(page) {
  const selectors = [
    'a[download$=".csv"]',
    'a:has-text("CSV")',
    'button:has-text("CSV")',
    'text=/CSV|내보내기|다운로드/i'
  ];
  for (const sel of selectors) {
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 4500 }),
        page.click(sel, { timeout: 3000 })
      ]);
      const stream = await download.createReadStream();
      if (!stream) continue;
      const chunks = [];
      for await (const ch of stream) chunks.push(ch);
      const csv = Buffer.concat(chunks).toString("utf8");
      if (csv && /,|;/.test(csv.split("\n")[0] || "")) {
        return csv;
      }
    } catch (_) { /* 다음 후보 시도 */ }
  }
  return null;
}

/* ---------------- DOM 폴백 경로 ---------------- */

async function extractItemsFromDOM(page) {
  // 강제 셀렉터 대기 제거 → 광범위 탐색 + 휴리스틱
  // 1) 후보 헤딩 텍스트 수집
  const raw = await page.$$eval(
    'h3, h2, [role="heading"], a[aria-label], article h3, section h3, li h3',
    (els) => els.map(e => (e.textContent || "").trim()).filter(Boolean)
  ).catch(() => []);
  if (!raw.length) return [];

  // 2) 정제 + 중복 제거
  const seen = new Set();
  const heads = [];
  for (const t of raw) {
    const s = t.replace(/\s+/g, " ").trim();
    if (!s) continue;
    if (s.length < 2 || s.length > 120) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    heads.push(s);
    if (heads.length >= 40) break;
  }

  // 3) 각 제목 주변에서 설명/링크 보강(느슨한 규칙)
  const items = [];
  for (let i = 0; i < heads.length; i++) {
    const term = heads[i];
    // 해당 텍스트를 포함하는 첫 노드의 주변 문단/링크 추출
    // (Playwright evaluate로 개별 탐색)
    const info = await page.evaluate((needle) => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

      function findNodeByText(txt) {
        const xp = document.evaluate(`//*[contains(normalize-space(.), "${txt.replace(/"/g, '\\"')}")]`, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        if (xp.snapshotLength > 0) return xp.snapshotItem(0);
        return null;
      }

      const root = findNodeByText(needle);
      if (!root) return { desc: "", links: [] };

      // 근처 p/소제목에서 설명 후보
      let desc = "";
      const p = root.closest("article") || root.parentElement;
      if (p) {
        const cand = p.querySelector("p") || p.querySelector("div p");
        if (cand) desc = norm(cand.textContent);
      }
      if (desc.length > 160) desc = desc.slice(0, 160);

      // 근처 외부 링크 2~3개
      const links = [];
      const as = (p || document).querySelectorAll("a[href^='http']");
      for (const a of as) {
        const url = a.getAttribute("href") || "";
        if (!url) continue;
        if (/trends\.google/i.test(url)) continue;
        const title = norm(a.textContent);
        if (!title) continue;
        links.push({ title, url, domain: host(url) });
        if (links.length >= 3) break;
      }
      return { desc, links };
    }, term).catch(() => ({ desc: "", links: [] }));

    items.push({
      rank: i + 1,
      term,
      desc: info.desc || "",
      explore: "",
      links: (info.links || []).slice(0, 3)
    });

    if (items.length >= 30) break;
  }

  return items;
}

/* ---------------- 메인 크롤 ---------------- */

async function crawlOne(ctx, { geo, hours, category }) {
  const url = `https://trends.google.co.kr/trending?geo=${encodeURIComponent(geo)}&hours=${encodeURIComponent(hours)}&category=${encodeURIComponent(category)}`;
  const page = await ctx.newPage();

  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  // 클라이언트 렌더 지연 대비
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await sleep(1500);

  const status = resp?.status() ?? 0;

  // 1) CSV 우선 시도
  let csvText = null;
  let items = [];
  try {
    csvText = await tryDownloadCSV(page);
    if (csvText) items = parseCSVToItems(csvText);
  } catch (_) {}

  // 2) CSV 실패 → DOM 폴백
  if (!items.length) {
    items = await extractItemsFromDOM(page);
  }

  // 스냅샷 저장(디버깅용)
  const html = await page.content();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapFile = `${SNAPSHOT_DIR}/trending_${geo}_${hours}h_cat${category}_${stamp}.html`;
  await fs.writeFile(snapFile, html, "utf8");

  await page.close();

  const pageHash = sha256(JSON.stringify(items.map(x => x.term)));

  return {
    geo, hours, category, url, status,
    capturedAtKST: nowKSTISO(),
    pageHash,
    itemCount: items.length,
    items,
    snapshot: snapFile,
    usedCSV: Boolean(csvText)
  };
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

  const latest = { fetchedAtKST: nowKSTISO(), combos };
  await fs.writeFile(OUT_JSON, JSON.stringify(latest, null, 2), "utf8");

  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
  const histFile = `${HISTORY_DIR}/latest_${ts}.json`;
  await fs.writeFile(histFile, JSON.stringify(latest), "utf8");

  console.log(`[crawl] combos=${combos.length}, saved ${OUT_JSON} & ${histFile}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
