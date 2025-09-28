// crawl.js — Google Trends 실시간(비공식) JSON 수집 버전
// Node.js v20 기준 (fetch 내장)

// 환경변수 예:
// GEO_LIST="KR,US,JP" CATEGORY_LIST="3" HOURS="4" HL="ko" TZ="-540"

import fs from 'fs/promises';
import path from 'path';

const HL = process.env.HL || 'ko';
const TZ = parseInt(process.env.TZ || '-540', 10);
const GEO_LIST = (process.env.GEO_LIST || 'KR,US,JP').split(',').map(s => s.trim());
const CATEGORY_LIST_RAW = (process.env.CATEGORY_LIST || '3').split(',').map(s => s.trim());
const HOURS = parseInt(process.env.HOURS || '4', 10);

// UI의 숫자 카테고리 → API용 코드 매핑(자주 쓰는 것 위주)
const CATEGORY_MAP = {
  // UI category= (예: 0 전체, 3 비즈니스/금융) → API cat=
  '0': 'all',
  'all': 'all',
  '3': 'b',          // Business
  'b': 'b', 'business': 'b',
  'e': 'e',          // Entertainment
  'm': 'm',          // Health
  's': 's',          // Science/Tech
  't': 't'           // Sports
};

function mapCat(c) { return CATEGORY_MAP[c] || 'all'; }
function nowKST() {
  const kst = new Date(Date.now() + (9 * 60 * 60 * 1000));
  return new Date(kst.getTime() - (kst.getTimezoneOffset() * 60 * 1000)).toISOString().replace('Z', '+09:00');
}

// 비공식 엔드포인트: /trends/api/realtimetrends (XSSI 프리픽스 제거 필요)
async function fetchRealtime({ geo, cat }) {
  const params = new URLSearchParams({
    hl: HL, tz: String(TZ), cat, geo,
    fi: '0', fs: '0', ri: '200', rs: '20', sort: '0'
  });
  const url = `https://trends.google.com/trends/api/realtimetrends?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36',
      'Accept': '*/*',
      'Referer': `https://trends.google.com/trending?geo=${geo}`,
      'Accept-Language': HL
    }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

  // 디버그: 원문 저장
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fs.mkdir(path.join('data', 'json'), { recursive: true });
  await fs.writeFile(path.join('data', 'json', `raw_${geo}_cat${cat}_${stamp}.txt`), text, 'utf8');

  const clean = text.replace(/^\)\]\}',?\n?/, '');
  return JSON.parse(clean);
}

function toEpochMsMaybe(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function parsePublishedToMs(v) {
  if (!v) return null;

  // 숫자형/숫자문자: epoch
  if (typeof v === 'number') {
    const n = v < 1e12 ? v * 1000 : v; // 초→ms 보정
    return n;
  }
  const s = String(v).trim();

  // 순수 숫자문자
  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return n < 1e12 ? n * 1000 : n;
  }

  // 상대표현: "2 hours ago", "3시간 전", "45분 전", "1 day ago"
  const rel = s.toLowerCase();
  const now = Date.now();
  let m = null;
  if ((m = rel.match(/(\d+)\s*min|(\d+)\s*분\s*전/))) {
    const n = parseInt(m[1] || m[2], 10);
    return now - n * 60 * 1000;
  }
  if ((m = rel.match(/(\d+)\s*hour|(\d+)\s*시간\s*전/))) {
    const n = parseInt(m[1] || m[2], 10);
    return now - n * 3600 * 1000;
  }
  if ((m = rel.match(/(\d+)\s*day|(\d+)\s*일\s*전/))) {
    const n = parseInt(m[1] || m[2], 10);
    return now - n * 24 * 3600 * 1000;
  }

  // 일반 날짜 문자열(ISO 등)
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;

  return null; // 끝까지 못읽으면 null
}

function extractStories(json, hours, keepTop = 50) {
  const stories = json?.storySummaries?.trendingStories || [];
  const cutoff = Date.now() - hours * 3600_000;

  const items = stories.map((s, i) => {
    const arts = (s.articles || []).map(a => {
      const publishedRaw = a.time ?? a.published ?? a.date ?? a.timestamp ?? a.pubDate ?? null;
      const publishedMs = parsePublishedToMs(publishedRaw);
      return {
        title: a.articleTitle || a.title || '',
        url: a.url || '',
        source: a.source || '',
        published: publishedRaw,
        publishedMs
      };
    });

    return {
      rank: i + 1,
      title: s.title || (s.entityNames?.[0] || ''),
      entityNames: s.entityNames || [],
      shareUrl: s.shareUrl || '',
      image: s.image?.newsUrl || s.image?.imgUrl || '',
      articles: arts
    };
  });

  // 1차: 시간 필터 (읽힌 기사 시간 중 하나라도 cutoff 이후면 통과)
  let filtered = items.filter(it => it.articles.some(a => (a.publishedMs ?? 0) >= cutoff));

  // 2차: 너무 엄격해서 다 날아가면 — 시각을 하나도 읽지 못한 스토리는 "후보"로 복구
  if (filtered.length === 0) {
    const fallback = items.filter(it => it.articles.length > 0 && it.articles.every(a => a.publishedMs == null));
    // 최상위 일부만 살림
    filtered = fallback.slice(0, keepTop);
  }

  // 상위 N개로 제한
  return filtered.slice(0, keepTop);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function main() {
  const fetchedAtKST = nowKST();
  const slotKST = new Date();
  slotKST.setMinutes(0, 0, 0); // 정각 기준 슬롯
  const slotISO = new Date(slotKST.getTime() + 9 * 3600_000).toISOString().replace('Z', '+09:00');

  const combos = [];
  for (const geo of GEO_LIST) {
    for (const catRaw of CATEGORY_LIST_RAW) {
      const cat = mapCat(catRaw);
      const urlUi = `https://trends.google.co.kr/trending?geo=${geo}&category=${catRaw}&status=active&hours=${HOURS}&hl=${HL}&tz=${TZ}`;

      let json, items = [];
      try {
        json = await fetchRealtime({ geo, cat });
        items = extractStories(json, HOURS);
      } catch (e) {
        // 실패 시 items 빈 배열로 유지
        console.error(`[ERR] ${geo}/${catRaw}:`, e.message);
      }

      combos.push({
        geo, category: catRaw, apiCategory: cat, url: urlUi,
        itemCount: items.length, items
      });

      // 개별 스냅샷 저장
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = path.join('data', 'json');
      await ensureDir(dir);
      await fs.writeFile(
        path.join(dir, `realtime_${geo}_cat${cat}_${stamp}.json`),
        JSON.stringify({ fetchedAtKST, geo, catRaw, catApi: cat, items }, null, 2),
        'utf8'
      );
    }
  }

  // latest.json 갱신
  const latest = { slotKST: slotISO, fetchedAtKST, hours: HOURS, combos };
  await ensureDir('data');
  await fs.writeFile('data/latest.json', JSON.stringify(latest, null, 2), 'utf8');

  // 로그에 요약 출력
  console.log(`[done] ${fetchedAtKST} KST ::`, combos.map(c => `${c.geo}/${c.category}(${c.apiCategory})=${c.itemCount}`).join(', '));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
