// crawl.js — 동의배너 처리 + 즉시추출 + 재시도 + CSV우선 + 디버그 스샷
import { chromium } from "playwright";
import fs from "fs/promises";
import crypto from "crypto";

const GEO_LIST = (process.env.GEO_LIST || "KR").split(",").map(s => s.trim());
const HOURS_LIST = (process.env.HOURS_LIST || "4").split(",").map(s => s.trim());
const CATEGORY_LIST = (process.env.CATEGORY_LIST || "3").split(",").map(s => s.trim());

const OUT_JSON = "data/latest.json";
const SNAPSHOT_DIR = "data/snapshots";
const HISTORY_DIR = "data/history";
const SHOT_DIR = "data/screens"; // 디버그 스크린샷

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha256 = (s) => "sha256:" + crypto.createHash("sha256").update(s || "").digest("hex");
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

function nowKSTISO() {
  const kst = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul", hour12: false });
  return kst.replace(" ", "T") + "+09:00";
}
function slotStartKSTISO() {
  const now = Date.now();
  const kst = now + 9 * 3600_000;
  const floored = Math.floor(kst / 3600_000) * 3600_000;
  const d = new Date(floored);
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  return `${y}-${m}-${day}T${h}:00:00+09:00`;
}

async function ensureDirs() {
  await fs.mkdir("data", { recursive: true });
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  await fs.mkdir(SHOT_DIR, { recursive: true });
}

/* ---------- CSV 파싱 유틸 ---------- */
function splitCSVLine(line, delim = ",") {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (ch === delim && !inQ) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur); return out;
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
  const idx = (names) => {
    const re = new RegExp(names.join("|"), "i");
    let k = header.findIndex(h => re.test(h));
    if (k < 0) k = header.findIndex(h => /검색|키워드|제목/.test(h));
    return k;
  };
  const titleIdx = idx(["title","query","term","entity"]);
  const urlIdx   = idx(["url","link"]);
  const descIdx  = idx(["description","snippet","summary"]);

  const items = []; let rank = 0;
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
      if (csv && /,|;/.test(csv.split("\n")[0] || "")) return csv;
    } catch {}
  }
  return null;
}

/* ---------- DOM 폴백 추출 ---------- */
async function extractItemsFromDOM(page) {
  // 제목 후보 폭넓게 수집
  const raw = await page.$$eval(
    'h3, h2, [role="heading"], a[aria-label], article h3, section h3, li h3',
    els => els.map(e => (e.textContent || "").trim()).filter(Boolean)
  ).catch(() => []);
  if (!raw.length) return [];

  const seen = new Set(); const heads = [];
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

  const items = [];
  for (let i = 0; i < heads.length; i++) {
    const term = heads[i];
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

      let desc = "";
      const scope = root.closest("article") || root.parentElement;
      if (scope) {
        const cand = scope.querySelector("p") || scope.querySelector("div p");
        if (cand) desc = norm(cand.textContent);
      }
      if (desc.length > 160) desc = desc.slice(0, 160);

      const links = [];
      const as = (scope || document).querySelectorAll("a[href^='http']");
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

    items.push({ rank: i + 1, term, desc: info.desc || "", explore: "", links: (info.links || []).slice(0,3) });
    if (items.length >= 30) break;
  }
  return items;
}

/* ---------- 보조: 동의배너/스크롤/샷 ---------- */
async function clickConsentIfAny(page) {
  const sels = [
    'form[action*="consent"] button:has-text("동의")',
    'button:has-text("동의")',
    'button:has-text("수락")',
    'button:has-text("I agree")',
    '#introAgreeButton', '[aria-label="동의"]'
  ];
  for (const s of sels) {
    const el = await page.$(s);
    if (el) { try { await el.click({ timeout: 1000 }); await sleep(500); return true; } catch {} }
  }
  return false;
}
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0; const step = () => {
        window.scrollBy(0, 400); y += 400;
        if (y < document.body.scrollHeight) requestAnimationFrame(step);
        else resolve();
      }; step();
    });
  });
}

/* ---------- 메인 크롤 ---------- */
async function crawlOne(ctx, { geo, hours, category }) {
  const url = `https://trends.google.co.kr/trending?geo=${encodeURIComponent(geo)}&hours=${encodeURIComponent(hours)}&category=${encodeURIComponent(category)}&hl=ko&tz=-540`;
  const page = await ctx.newPage();
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

  await clickConsentIfAny(page);
  await sleep(700);

  // 1차: 즉시 추출
  let items = await extractItemsFromDOM(page);

  // 네트워크 안정화 후 2차
  if (!items.length) {
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
    await sleep(1000);
    items = await extractItemsFromDOM(page);
  }

  // 스크롤 트리거 후 3차
  if (!items.length) {
    await autoScroll(page);
    await sleep(800);
    await page.evaluate(() => window.scrollTo(0, 0));
    items = await extractItemsFromDOM(page);
  }

  // CSV 최후 시도(있으면 더 정확)
  if (!items.length) {
    try {
      const csvText = await tryDownloadCSV(page);
      if (csvText) items = parseCSVToItems(csvText);
    } catch {}
  }

  // 디버그 스크린샷 저장
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try { await page.screenshot({ path: `${SHOT_DIR}/shot_${geo}_${hours}h_cat${category}_${stamp}.png`, fullPage: true }); } catch {}

  // 스냅샷 HTML 저장(원하면 .gitignore)
  try {
    const html = await page.content();
    await fs.writeFile(`${SNAPSHOT_DIR}/trending_${geo}_${hours}h_cat${category}_${stamp}.html`, html, "utf8");
  } catch {}

  const status = resp?.status() ?? 0;
  await page.close();

  const pageHash = sha256(JSON.stringify(items.map(x => x.term)));

  return {
    geo, hours, category, url, status,
    capturedAtKST: nowKSTISO(),
    pageHash,
    itemCount: items.length,
    items
  };
}

async function main() {
  await ensureDirs();
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
    viewport: { width: 1280, height: 2200 }
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

  await ctx.close(); await browser.close();

  const latest = {
    slotKST: slotStartKSTISO(),   // 논리 정각
    fetchedAtKST: nowKSTISO(),    // 실제 저장 시각
    combos
  };
  await fs.writeFile(OUT_JSON, JSON.stringify(latest, null, 2), "utf8");

  const ts = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "");
  await fs.writeFile(`${HISTORY_DIR}/latest_${ts}.json`, JSON.stringify(latest), "utf8");

  console.log(`[crawl] combos=${combos.length}, saved ${OUT_JSON}`);
}

main().catch(err => { console.error(err); process.exit(1); });
