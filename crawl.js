// crawl.js — Google Realtime Trends (비공식 JSON) 안정판
import fs from 'fs/promises';
import path from 'path';

const HOURS = parseInt(process.env.HOURS || '4', 10);
const GEO_LIST = (process.env.GEO_LIST || 'KR,US,JP').split(',').map(s => s.trim());
const CATEGORY_LIST_RAW = (process.env.CATEGORY_LIST || '3').split(',').map(s => s.trim());
const TZ = String(process.env.TZ || '-540'); // KST
const HL_ENV = process.env.HL || ''; // 비워두면 GEO별 기본 HL 사용

// UI의 숫자 카테고리 → API cat 매핑(불확실하면 'all'로 폴백)
const CATEGORY_MAP = { '0':'all','all':'all','1':'all','2':'all','3':'b','4':'e','5':'m','6':'s','7':'t',
                       'b':'b','e':'e','m':'m','s':'s','t':'t' };
const mapCat = c => CATEGORY_MAP[c] || 'all';

// GEO별 “가장 안전한 HL”
const HL_BY_GEO = { KR: 'ko', US: 'en-US', JP: 'ja' };

function nowKST() {
  const kstMs = Date.now() + 9*3600*1000;
  return new Date(kstMs).toISOString().replace('Z', '+09:00');
}

function parsePublishedToMs(v) {
  if (!v) return null;
  if (typeof v === 'number') return v < 1e12 ? v*1000 : v;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = parseInt(s,10); return n < 1e12 ? n*1000 : n; }
  const now = Date.now(), low = s.toLowerCase();
  let m;
  if ((m = low.match(/(\d+)\s*(?:min|minutes)|(\d+)\s*분\s*전/))) return now - (parseInt(m[1]||m[2],10))*60*1000;
  if ((m = low.match(/(\d+)\s*(?:hour|hours)|(\d+)\s*시간\s*전/)))  return now - (parseInt(m[1]||m[2],10))*3600*1000;
  if ((m = low.match(/(\d+)\s*(?:day|days)|(\d+)\s*일\s*전/)))      return now - (parseInt(m[1]||m[2],10))*24*3600*1000;
  const t = Date.parse(s); return Number.isNaN(t) ? null : t;
}

function extractStories(json, hours, keepTop=50) {
  const stories = json?.storySummaries?.trendingStories || [];
  const cutoff = Date.now() - hours*3600*1000;

  const items = stories.map((s,i) => {
    const arts = (s.articles || []).map(a => {
      const publishedRaw = a.time ?? a.published ?? a.date ?? a.timestamp ?? a.pubDate ?? null;
      return {
        title: a.articleTitle || a.title || '',
        url: a.url || '',
        source: a.source || '',
        published: publishedRaw,
        publishedMs: parsePublishedToMs(publishedRaw)
      };
    });
    return {
      rank: i+1,
      title: s.title || (s.entityNames?.[0] || ''),
      entityNames: s.entityNames || [],
      shareUrl: s.shareUrl || '',
      image: s.image?.newsUrl || s.image?.imgUrl || '',
      articles: arts
    };
  });

  let filtered = items.filter(it => it.articles.some(a => (a.publishedMs ?? 0) >= cutoff));
  if (filtered.length === 0) {
    const fallback = items.filter(it => it.articles.length > 0 && it.articles.every(a => a.publishedMs == null));
    filtered = fallback.slice(0, keepTop);
  }
  return filtered.slice(0, keepTop);
}

async function ensureDir(p){ await fs.mkdir(p,{recursive:true}); }

// API 호출(항상 raw 저장). 실패해도 raw 저장해서 원인 파악.
async function callRealtime({geo, cat, hl, tz, tag}) {
  const qs = new URLSearchParams({ hl, tz, cat, geo, fi:'0', fs:'0', ri:'200', rs:'20', sort:'0' });
  const url = `https://trends.google.com/trends/api/realtimetrends?${qs}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
      'Accept':'*/*',
      'Referer':`https://trends.google.com/trending?geo=${geo}`,
      'Accept-Language':hl
    }
  });
  const text = await res.text().catch(()=> '');
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  await ensureDir('data/json');
  await fs.writeFile(path.join('data','json',`raw_${geo}_cat${cat}_hl${hl}_${tag}_${stamp}.txt`), text || `(empty)`, 'utf8');

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const clean = (text || '').replace(/^\)\]\}',?\n?/, '');
  return JSON.parse(clean);
}

// geo/cat 조합  →  [우선 시도, cat=all 폴백, HL 폴백] 순서로 재시도
async function fetchWithFallbacks(geo, catRaw) {
  const cat = mapCat(catRaw);
  const tries = [];

  const baseHL = HL_ENV || HL_BY_GEO[geo] || 'en-US';
  const altHL  = baseHL === 'en-US' ? 'ko' : 'en-US'; // 대체 언어

  // 1) 요청한 cat + baseHL
  tries.push({ geo, cat, hl: baseHL, tag:'base' });

  // 2) cat=all + baseHL
  if (cat !== 'all') tries.push({ geo, cat:'all', hl: baseHL, tag:'all' });

  // 3) cat 유지 + altHL
  tries.push({ geo, cat, hl: altHL, tag:'altHL' });

  // 4) cat=all + altHL
  if (cat !== 'all') tries.push({ geo, cat:'all', hl: altHL, tag:'allAlt' });

  const attempts = [];
  for (const t of tries) {
    try {
      const json = await callRealtime({ ...t, tz: TZ });
      const items = extractStories(json, HOURS);
      attempts.push({ ...t, ok: true, count: items.length });
      if (items.length > 0) return { items, debugAttempts: attempts };
      // 204/빈 응답 등도 기록
    } catch (e) {
      attempts.push({ ...t, ok: false, error: String(e) });
    }
  }
  return { items: [], debugAttempts: attempts };
}

async function main(){
  const fetchedAtKST = nowKST();

  const slot = new Date(); slot.setMinutes(0,0,0);
  const slotISO = new Date(slot.getTime()+9*3600*1000).toISOString().replace('Z','+09:00');

  const combos = [];

  for (const geo of GEO_LIST) {
    for (const catRaw of CATEGORY_LIST_RAW) {
      const { items, debugAttempts } = await fetchWithFallbacks(geo, catRaw);

      combos.push({
        geo, category: catRaw,
        apiCategoryTried: debugAttempts.map(a => `${a.cat}/${a.hl}${a.ok?`:${a.count}`:`!`} `).join('').trim(),
        itemCount: items.length,
        items
      });

      // 스냅샷(JSON)
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      await ensureDir('data/json');
      await fs.writeFile(
        path.join('data','json',`realtime_${geo}_cat${mapCat(catRaw)}_${stamp}.json`),
        JSON.stringify({ fetchedAtKST, geo, catRaw, items, debugAttempts }, null, 2),
        'utf8'
      );
    }
  }

  const latest = { slotKST: slotISO, fetchedAtKST, hours: HOURS, combos };
  await ensureDir('data');
  await fs.writeFile('data/latest.json', JSON.stringify(latest, null, 2), 'utf8');

  console.log(`[done] ${fetchedAtKST} KST ::`, combos.map(c => `${c.geo}/${c.category}=${c.itemCount} [${c.apiCategoryTried}]`).join(' | '));
}

main().catch(e => { console.error(e); process.exit(1); });