#!/usr/bin/env node

/**
 * LUEUR Magazine RSS Crawler + Static Site Generator
 *
 * K-Beauty & K-Fashion magazine with W Magazine inspired pure white aesthetic.
 * English language. Crawls RSS feeds from K-pop/K-culture news sites,
 * extracts article data, generates self-contained static HTML pages.
 *
 * Usage: node crawl.mjs
 * No dependencies — pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news (English) ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/lueur-placeholder/800/450';

const log = (msg) => console.log(`[LUEUR Crawler] ${msg}`);
const warn = (msg) => console.warn(`[LUEUR Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting — English: "March 22, 2026"
// ============================================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

// ============================================================
// REWRITE ENGINE — Fashion/beauty editorial English titles
// ============================================================

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Ros\u00e9', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier ----

const TOPIC_KEYWORDS = {
  comeback:      ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  fashion:       ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle', 'wardrobe', 'couture', 'designer'],
  release:       ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:       ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  award:         ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon', 'red carpet'],
  variety:       ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest', 'off-duty', 'behind'],
  sns:           ['selfie', 'instagram', 'sns', 'twitter', 'tiktok', 'viral', 'trending', 'post', 'social media', 'selca'],
  collaboration: ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'campaign', 'deal', 'endorsement', 'luxury'],
  debut:         ['debut', 'launch', 'pre-debut', 'trainee', 'survival', 'newcomer', 'fresh face'],
  chart:         ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
};

// ---- Title templates per topic — Fashion/beauty editorial English ----

const TITLE_TEMPLATES = {
  comeback: [
    `{artist}'s New Visual Era Redefines K-Pop Beauty Standards`,
    `The Aesthetic Evolution of {artist}: A Comeback Study`,
    `Return in Style: {artist}'s Comeback Wardrobe Decoded`,
    `{artist} Returns With a Bold New Look That Changes Everything`,
    `Inside {artist}'s Comeback Transformation: Beauty Meets Vision`,
  ],
  fashion: [
    `Inside {artist}'s Wardrobe: The Looks That Define a Generation`,
    `How {artist} Became Fashion's Most Wanted Muse`,
    `{artist} x Haute Couture: A Perfect Union`,
    `The Style File: {artist}'s Most Defining Fashion Moments`,
    `{artist}'s Fashion Influence Is Bigger Than You Think`,
    `Decoding {artist}'s Signature Style: A Visual Analysis`,
  ],
  release: [
    `Sound and Style: The Visual Language of {artist}'s New Release`,
    `{artist}'s New Era \u2014 Music Meets Fashion`,
    `The Aesthetics of {artist}'s Latest Drop: More Than Just Music`,
    `{artist} Sets the Tone With a Visually Stunning New Release`,
  ],
  concert: [
    `Tour Style: {artist}'s Stage Wardrobe Under the Spotlight`,
    `The Costume Design Behind {artist}'s Sold-Out Tour`,
    `{artist} on Stage: Where Performance Meets High Fashion`,
    `Behind the Looks: {artist}'s Tour Wardrobe Revealed`,
  ],
  award: [
    `Red Carpet Report: {artist}'s Best Award Show Moments`,
    `{artist}'s Award Night Look Breaks the Internet`,
    `Every Stunning Detail of {artist}'s Red Carpet Appearance`,
    `{artist} Steals the Show \u2014 A Red Carpet Retrospective`,
  ],
  variety: [
    `Off-Duty Beauty: {artist}'s Most Effortless Moments`,
    `Behind the Glam: {artist} Goes Unfiltered`,
    `{artist} Without the Spotlight: A Study in Casual Elegance`,
    `The Unscripted Side of {artist}: Style Edition`,
  ],
  sns: [
    `{artist}'s Most Iconic Beauty Moments on Social Media`,
    `Get the Look: Recreating {artist}'s Viral Style Posts`,
    `{artist}'s Social Feed Is a Masterclass in Personal Style`,
    `Why {artist}'s Latest Posts Are Breaking the Internet`,
  ],
  collaboration: [
    `{artist} Joins Forces With Luxury Brand in Landmark Deal`,
    `The Campaign: {artist}'s Collaboration Changes the Game`,
    `{artist} x High Fashion: Inside the Most Talked-About Partnership`,
    `Why Brands Are Lining Up for {artist}: A Collaboration Deep Dive`,
  ],
  debut: [
    `Fresh Face: Newcomer {artist}'s Style Profile`,
    `Meet {artist}: K-Pop's Next Fashion Darling`,
    `{artist} Arrives: First Impressions of a Rising Style Icon`,
    `The Debut That Turned Heads: {artist}'s Visual Introduction`,
  ],
  chart: [
    `{artist}'s Rise Parallels Their Fashion Influence`,
    `From Charts to Catwalks: {artist}'s Dual Dominance`,
    `{artist}'s Record-Breaking Moment \u2014 And the Style Behind It`,
  ],
  general: [
    `The Beauty Story Everyone Is Talking About`,
    `This Week in K-Beauty and K-Fashion`,
    `LUEUR's Essential Style Roundup`,
    `What to Know in K-Beauty This Week`,
    `The LUEUR Edit: Style Moments That Defined the Week`,
    `K-Beauty's Biggest Moments \u2014 A LUEUR Curated Selection`,
  ],
};

const NO_ARTIST_TEMPLATES = [
  `The Beauty Story Everyone Is Talking About`,
  `This Week in K-Beauty and K-Fashion`,
  `LUEUR's Essential Style Roundup`,
  `What to Know in K-Beauty This Week`,
  `The LUEUR Edit: Style Moments That Defined the Week`,
  `K-Beauty's Biggest Moments, Curated by LUEUR`,
  `Inside This Week's Most Talked-About Beauty Trends`,
  `The Fashion Dispatch: K-Style Updates You Need to See`,
  `From Seoul With Style: This Week's Highlights`,
  `Beauty, Fashion, Culture \u2014 A LUEUR Weekly Brief`,
];

// ---- Helpers ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', "don't", "doesn't", "didn't", "won't", "can't",
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) return name;
  }

  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) return name;
    }
  }

  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) return candidate;
  }

  return null;
}

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return topic;
    }
  }
  return 'general';
}

function rewriteTitle(originalTitle) {
  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  return pickRandom(NO_ARTIST_TEMPLATES);
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// Display categories — LUEUR style
// ============================================================

function displayCategory(category) {
  const lower = (category || '').toLowerCase();
  if (lower.includes('fashion') || lower.includes('style') || lower.includes('outfit')) return 'FASHION';
  if (lower.includes('beauty') || lower.includes('makeup') || lower.includes('skincare')) return 'BEAUTY';
  if (lower.includes('music') || lower.includes('k-pop') || lower.includes('kpop')) return 'CULTURE';
  if (lower.includes('interview') || lower.includes('profile')) return 'PEOPLE';
  if (lower.includes('photo') || lower.includes('pictorial')) return 'EDITORIAL';
  if (lower.includes('sns') || lower.includes('social') || lower.includes('viral')) return 'SOCIAL';
  if (lower.includes('collab') || lower.includes('brand') || lower.includes('ambassador')) return 'COLLAB';
  if (lower.includes('debut') || lower.includes('newcomer')) return 'DEBUT';
  if (lower.includes('chart') || lower.includes('record') || lower.includes('billboard')) return 'CHARTS';
  if (lower.includes('drama') || lower.includes('tv') || lower.includes('film')) return 'CULTURE';
  return 'COVER';
}

function displayCategoryFromTopic(topic) {
  const map = {
    comeback: 'COVER',
    fashion: 'FASHION',
    release: 'CULTURE',
    concert: 'CULTURE',
    award: 'EDITORIAL',
    variety: 'PEOPLE',
    sns: 'SOCIAL',
    collaboration: 'COLLAB',
    debut: 'DEBUT',
    chart: 'CHARTS',
    general: 'BEAUTY',
  };
  return map[topic] || 'BEAUTY';
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) image = extractImageFromContent(contentEncoded);
    if (!image) image = extractImageFromContent(description);

    if (!title || !link) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }

  if (!bodyHtml) bodyHtml = cleaned;

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    return extractArticleContent(html);
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body generation — fashion/beauty editorial English
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      `{artist} has returned with a visual identity so striking it demands attention. The comeback marks not just a new musical chapter, but a complete aesthetic reinvention that redefines what we expect from K-pop's most visually compelling artists.`,
      `There is a particular electricity that surrounds a {artist} comeback. This time, the anticipation is matched by a visual direction so bold it has already sent ripples through fashion and beauty circles worldwide.`,
      `When {artist} steps back into the spotlight, the world pays attention. This comeback is no exception \u2014 a carefully orchestrated visual statement that blurs the line between music and high fashion.`,
    ],
    analysis: [
      `The styling direction for this comeback represents a departure from {artist}'s previous aesthetic. The creative team has embraced a more architectural approach to fashion, with structured silhouettes and unexpected fabric combinations that speak to a maturing artistic vision. Each look has been meticulously crafted to serve the larger narrative of the comeback.`,
      `Industry insiders note that {artist}'s visual transformation goes beyond surface-level changes. The color palette, the makeup direction, even the way light interacts with the wardrobe choices \u2014 everything has been considered with the precision of a couture atelier. This level of detail is what separates a comeback from a cultural moment.`,
      `What makes {artist}'s approach particularly noteworthy is the seamless integration of Korean beauty traditions with contemporary high fashion. The result is something entirely new \u2014 a visual language that speaks to global audiences while remaining rooted in the cultural specificity that makes K-pop so compelling.`,
    ],
    closing: [
      `As {artist} embarks on this new chapter, LUEUR will continue to document the beauty and fashion moments that make this comeback essential viewing. The best is likely still to come.`,
      `The full impact of {artist}'s comeback will unfold over the coming weeks. LUEUR remains committed to capturing every visual detail of this evolving story.`,
    ],
  },
  fashion: {
    opening: [
      `{artist} has long been recognized as one of K-pop's most influential style voices. But recent appearances suggest something more interesting is happening \u2014 a deliberate evolution toward a wardrobe philosophy that prioritizes personal expression over trend compliance.`,
      `In the world of K-pop fashion, {artist} occupies a rare position: genuinely admired by industry professionals and fans alike. The latest looks confirm that this reputation is not just deserved, but actively evolving.`,
      `Fashion moves fast, but {artist} has demonstrated a remarkable ability to stay ahead of the curve without appearing to try. The effortlessness is, of course, the product of careful curation \u2014 and that paradox is precisely what makes the style so compelling.`,
    ],
    analysis: [
      `A closer examination of {artist}'s recent wardrobe reveals several emerging themes. There is a growing preference for natural fabrics and muted tones, punctuated by unexpected accessories that add personality without overwhelming the silhouette. This restraint is itself a statement in an industry that often rewards excess.`,
      `Fashion editors have taken note. {artist}'s approach to personal style reflects a broader shift in luxury fashion toward individuality over logomania. The pieces worn are rarely the most expensive or the most recognizable \u2014 instead, they are the most interesting, chosen for their texture, proportion, and the way they move.`,
      `The beauty component of {artist}'s style is equally considered. Skin-forward makeup with strategic color placement, paired with hair that appears touchably natural yet somehow perfect. It is the kind of beauty that photographs well from every angle \u2014 a professional necessity that {artist} has elevated to an art form.`,
    ],
    closing: [
      `{artist}'s fashion evolution shows no signs of slowing. LUEUR will continue to analyze and celebrate the style choices that make this artist a genuine force in global fashion.`,
      `For the latest in {artist}'s style journey, LUEUR remains your definitive source. The wardrobe evolution continues, and we are watching.`,
    ],
  },
  release: {
    opening: [
      `The visual identity of {artist}'s latest release speaks volumes before a single note plays. In K-pop, where aesthetics and sound are inseparable, the art direction here sets a new standard for what a release can look like.`,
      `{artist}'s new project arrives wrapped in a visual concept so cohesive it deserves its own analysis. From album artwork to promotional imagery, every element has been designed to create a specific atmosphere \u2014 and it works.`,
    ],
    analysis: [
      `The styling for the promotional period reveals a deliberate narrative arc. Opening looks favor dark, minimal palettes that gradually give way to brighter, more expressive choices as the release unfolds. This kind of visual storytelling through fashion is what elevates a music release into a complete aesthetic experience.`,
      `Makeup direction for this era draws from both editorial beauty and the artistic boldness that K-pop uniquely enables. The looks push boundaries while remaining wearable enough to inspire fans \u2014 a balance that requires considerable skill from the creative team behind {artist}.`,
    ],
    closing: [
      `The visual story of {artist}'s latest release continues to develop. LUEUR will be tracking every look, every beauty moment, every style choice that defines this era.`,
    ],
  },
  concert: {
    opening: [
      `When {artist} takes the stage, the wardrobe becomes as much a part of the performance as the choreography. The tour costumes represent not just fashion choices, but a visual narrative designed to be read from the back row of an arena.`,
      `Stage fashion exists in its own category \u2014 where garments must photograph well under thousands of lights while surviving hours of movement. {artist}'s tour wardrobe manages this technical challenge while still looking like it belongs on a runway.`,
    ],
    analysis: [
      `The costume design for {artist}'s tour demonstrates remarkable attention to both aesthetics and function. Custom pieces that allow full range of motion while maintaining sharp lines, fabrics selected for the way they catch stage lighting, color choices calibrated for camera as much as for the live audience.`,
      `Behind these looks is a team of designers and stylists who understand that concert fashion must communicate at scale. Each outfit change during the show serves the emotional arc of the setlist, creating a visual journey that complements the musical one.`,
    ],
    closing: [
      `Tour fashion remains one of K-pop's most underappreciated art forms. LUEUR will continue to spotlight the costume design and style choices that make {artist}'s live performances visually unforgettable.`,
    ],
  },
  award: {
    opening: [
      `Red carpet moments in K-pop carry enormous weight \u2014 they are the intersection of personal style, brand relationships, and public perception. {artist}'s recent award show appearance delivered on every count, producing one of the night's most discussed looks.`,
      `In the history of K-pop red carpet fashion, certain moments become reference points. {artist}'s latest award show appearance has the makings of one such moment \u2014 a look that will be remembered long after the trophies are shelved.`,
    ],
    analysis: [
      `The look in question demonstrated {artist}'s growing confidence in making unconventional choices at high-stakes events. Rather than opting for safe glamour, the styling leaned into architectural tailoring and unexpected proportions. It was a choice that divided opinion in the best possible way \u2014 which is always a sign that something interesting is happening.`,
      `Beauty styling for the event complemented the fashion direction perfectly. A focus on skin luminosity over heavy coverage, with accent color placed strategically to draw attention exactly where it was intended. This is the kind of editorial approach to event beauty that elevates a red carpet moment into something genuinely memorable.`,
    ],
    closing: [
      `The full gallery of {artist}'s award show looks is available in LUEUR's red carpet archive. We will continue to bring you the most significant style moments from K-pop's biggest nights.`,
    ],
  },
  variety: {
    opening: [
      `Off-duty style reveals more about an artist than any styled shoot. {artist}'s casual moments \u2014 captured between schedules, at airports, during variety appearances \u2014 offer a window into a genuine personal aesthetic that no stylist can manufacture.`,
      `There is a growing appetite for seeing K-pop artists as they are, unpolished and real. {artist}'s off-duty beauty and fashion choices satisfy that curiosity while simultaneously proving that great style does not require a full glam team.`,
    ],
    analysis: [
      `{artist}'s casual style gravitates toward a specific mood: considered but not contrived. Clean lines, quality basics elevated by one or two interesting pieces. The beauty approach mirrors this philosophy \u2014 minimal but intentional, with the kind of healthy skin glow that suggests a serious skincare commitment.`,
      `What fans and fashion observers respond to is the consistency. Whether at an airport or a casual fan event, {artist} maintains an aesthetic coherence that speaks to genuine personal taste rather than wardrobe-by-committee. This authenticity is increasingly rare and increasingly valued.`,
    ],
    closing: [
      `For the most comprehensive coverage of {artist}'s off-duty style evolution, follow LUEUR's ongoing analysis. Real style tells real stories.`,
    ],
  },
  sns: {
    opening: [
      `In the age of social media, an artist's feed is as curated as any editorial spread. {artist} understands this implicitly, using platforms not just for communication but for visual storytelling that extends their aesthetic universe.`,
      `{artist}'s social media presence has become a reference point for beauty and style enthusiasts worldwide. Each post is studied, screenshotted, and dissected \u2014 not just by fans, but by industry professionals looking to understand the next wave of beauty trends.`,
    ],
    analysis: [
      `Scrolling through {artist}'s recent posts reveals a coherent visual identity: a specific color temperature, consistent lighting preferences, and a beauty presentation that favors natural textures over heavy filter application. This approach builds trust with audiences who can sense authenticity even through a screen.`,
      `The engagement metrics tell their own story. {artist}'s beauty and fashion posts consistently outperform their other content, suggesting that the audience is not just passively consuming \u2014 they are actively seeking style inspiration. This positions {artist} as one of K-pop's most influential digital style voices.`,
    ],
    closing: [
      `The intersection of social media and beauty culture continues to evolve, and {artist} remains at its center. LUEUR will continue tracking the digital style moments that matter.`,
    ],
  },
  collaboration: {
    opening: [
      `The partnership between {artist} and a major luxury house represents more than a business arrangement. It is a mutual recognition of value \u2014 the brand gains cultural relevance, while the artist gains a platform for their evolving aesthetic sensibility.`,
      `When fashion's establishment invites K-pop to the table, the result can be transformative for both parties. {artist}'s latest collaboration demonstrates exactly how this exchange of influence works when both sides are genuinely committed.`,
    ],
    analysis: [
      `The campaign imagery reveals a creative direction that honors both {artist}'s identity and the brand's heritage. This is not the generic celebrity endorsement of a previous era \u2014 it is a genuine creative partnership where {artist}'s input has visibly shaped the final product. The styling, the poses, the overall mood all feel authentically {artist}.`,
      `Market analysts have noted the commercial impact of {artist}'s brand affiliations. Sales spikes, social media engagement surges, and an influx of new consumers introduced to luxury through K-pop \u2014 the numbers support what the industry has been saying: K-pop partnerships are no longer experimental. They are essential.`,
    ],
    closing: [
      `LUEUR will continue to track the evolving landscape of K-pop and luxury fashion partnerships. {artist}'s collaboration story is far from over.`,
    ],
  },
  debut: {
    opening: [
      `Every so often, a debut arrives that immediately shifts the visual conversation. {artist}'s entry into the K-pop landscape is one such moment \u2014 a fully formed aesthetic that belies the newness of the project.`,
      `The pressure of a debut is immense: first impressions are permanent in an industry with a short attention span. {artist} has navigated this challenge with a visual identity so confident it commands immediate respect.`,
    ],
    analysis: [
      `The debut styling establishes several key aesthetic elements: a preference for clean silhouettes, an unexpectedly sophisticated color palette, and a beauty direction that prioritizes individual character over group uniformity. These choices suggest a creative team with a clear long-term vision.`,
      `What sets {artist}'s debut apart visually is the quality of execution. Every detail, from the fabric selection to the accessory placement to the specific shade of lip color, has been considered with a thoroughness that usually develops over multiple comebacks. Starting at this level is remarkable.`,
    ],
    closing: [
      `LUEUR will be following {artist}'s visual evolution from this debut forward. The foundations laid here suggest an artist with much more to show.`,
    ],
  },
  chart: {
    opening: [
      `Commercial success in K-pop has always been intertwined with visual impact. {artist}'s chart performance reflects not just musical quality, but the cumulative power of an aesthetic presentation that converts casual listeners into devoted followers.`,
      `Numbers alone cannot explain {artist}'s chart trajectory. Behind the streaming figures is a visual and beauty strategy so effective it has fundamentally changed how fans engage with new releases.`,
    ],
    analysis: [
      `The correlation between {artist}'s fashion moments and streaming spikes is difficult to ignore. Each major style reveal generates media coverage that drives new listeners to the music \u2014 a feedback loop that the most successful K-pop acts have learned to leverage deliberately.`,
      `Brand partnerships further amplify this effect. {artist}'s association with fashion houses provides a secondary media cycle that keeps the artist in public consciousness between releases. This sustained visibility is a key factor in the chart longevity that sets {artist} apart from peers.`,
    ],
    closing: [
      `The relationship between style influence and commercial performance is one of K-pop's most fascinating dynamics. LUEUR will continue to examine this intersection through {artist}'s ongoing career.`,
    ],
  },
  general: {
    opening: [
      `The K-beauty and K-fashion landscape continues to evolve at a pace that rewards close attention. This week brings several developments worth examining through LUEUR's lens of style, substance, and cultural significance.`,
      `In a moment defined by rapid cultural exchange, K-beauty and K-fashion remain at the vanguard. LUEUR curates the stories that matter most for those who take style seriously.`,
      `From Seoul's runway shows to the airport terminals that serve as impromptu fashion catwalks, K-pop's style influence is impossible to ignore. Here is what caught LUEUR's attention this week.`,
    ],
    analysis: [
      `The broader trend in K-beauty continues to move toward what industry insiders call "skin intelligence" \u2014 a philosophy that values understanding your skin over accumulating products. This shift is reflected in the increasingly minimal beauty routines of top K-pop artists, who are proving that less, done well, genuinely is more.`,
      `On the fashion front, Korean designers are gaining unprecedented international attention. The aesthetics pioneered on K-pop stages are now appearing in global fashion weeks, completing a circle of influence that has been building for years. This is no longer a niche interest \u2014 it is a mainstream conversation.`,
      `The rise of K-beauty standards as a global benchmark continues unabated. International beauty brands are reformulating products to align with Korean beauty principles, while K-pop idols' skincare routines have become the most-searched beauty content online.`,
    ],
    closing: [
      `LUEUR remains committed to bringing you the most insightful coverage of K-beauty and K-fashion. Stay with us for the stories that define the intersection of music, beauty, and style.`,
      `For the latest in K-beauty, K-fashion, and the artists who shape both, LUEUR is your essential guide. Continue exploring our editorial selections.`,
    ],
  },
};

const NO_ARTIST_BODY = {
  opening: [
    `The world of K-beauty and K-fashion never stands still. This week brings a fresh collection of stories that reveal the cultural forces shaping how Asia influences global style.`,
    `Beauty trends emerge, fashion moments crystallize, and the conversation around K-pop style continues to deepen. LUEUR curates the essential narratives for the style-conscious reader.`,
    `In the ever-evolving landscape of K-beauty and Korean fashion, certain moments demand attention. This is one of them \u2014 a story that speaks to the larger shifts happening at the intersection of music and style.`,
  ],
  analysis: [
    `The significance of this development extends beyond its immediate context. In a global beauty market increasingly influenced by Korean innovation, every trend that emerges from Seoul carries potential implications for the wider industry. Brands, retailers, and consumers alike are paying attention.`,
    `Industry observers note a recurring pattern: what begins as a K-pop style choice frequently becomes a mainstream fashion reference within eighteen months. This cycle of influence has accelerated as social media compresses the distance between Seoul and every other fashion capital.`,
    `The beauty dimension of this story is equally compelling. K-beauty's emphasis on skin health over coverage, on prevention over correction, has fundamentally altered how a generation thinks about personal care. Each new trend that emerges from this ecosystem carries that philosophical foundation.`,
  ],
  closing: [
    `LUEUR will continue to track the stories that define the global influence of K-beauty and K-fashion. For insight beyond the surface, stay with us.`,
    `The conversation between Korean beauty culture and the global fashion world deepens with each passing week. LUEUR remains your guide to the most significant moments.`,
  ],
};

const SHARED_PARAGRAPHS = {
  background: [
    `{artist}'s trajectory from debut to present represents one of K-pop's most compelling style evolution stories. Each era has brought a distinct visual identity, building a portfolio of looks that ranges from avant-garde editorial to accessible street style. This versatility is what makes {artist} a perennial favorite among fashion editors and beauty brands alike.`,
    `The global appetite for K-beauty and K-fashion content shows no signs of diminishing. If anything, the sophistication of the audience has increased \u2014 viewers are no longer satisfied with surface-level coverage. They want to understand the creative decisions, the brand strategies, and the personal philosophies that shape what {artist} and their peers choose to wear and how they present themselves.`,
    `Within the K-pop industry, {artist} occupies a distinctive position at the intersection of music and fashion. While many artists have brand deals, few have cultivated the kind of genuine style credibility that influences purchasing decisions and trend directions. This credibility has been earned through consistent aesthetic choices that prioritize personal expression over commercial obligation.`,
    `The beauty industry's relationship with K-pop has matured considerably in recent years. Early partnerships were often transactional \u2014 a famous face for a product launch. The current generation of collaborations, exemplified by {artist}'s approach, involves genuine creative input and long-term aesthetic alignment. The results are more authentic and more commercially successful.`,
    `Korean fashion's influence on global style can be traced through specific moments and specific artists. {artist} represents one of the most significant threads in this narrative \u2014 an artist whose personal style has directly influenced retail trends, beauty product development, and the way an entire generation approaches personal presentation.`,
  ],
  detail: [
    `Behind the public-facing style choices lies a dedicated creative team that understands the intersection of fashion, photography, and cultural timing. {artist}'s stylists have spoken in past interviews about the collaborative nature of the creative process \u2014 ideas flow in both directions, with the artist's instincts often guiding final decisions in ways that surprise even experienced professionals.`,
    `The social media response to {artist}'s recent style moments has been quantifiably extraordinary. Engagement rates that far exceed industry averages, product sell-outs within hours of identification, and a cascade of content creation from fans and fashion commentators alike. These metrics represent real cultural influence, not manufactured buzz.`,
    `What distinguishes {artist}'s approach to beauty and fashion from many peers is a willingness to take risks at moments when the safe choice would be easier. An unexpected silhouette, an unconventional color, a beauty look that challenges rather than comforts \u2014 these choices generate conversation precisely because they require confidence and vision.`,
    `The economic impact of K-pop fashion influence continues to grow. Industry reports estimate that artist-driven fashion and beauty trends contribute billions annually to the global beauty economy. {artist}'s personal contribution to this figure, while difficult to isolate, is by all accounts substantial and growing.`,
  ],
  reaction: [
    `Fashion critics have responded to {artist}'s recent choices with the kind of attention usually reserved for established fashion icons. Multiple international publications have featured analysis of the looks, a development that would have been unthinkable in the K-pop space even five years ago. The boundary between music and fashion has never been more permeable.`,
    `Fan communities have embraced these style moments with characteristic thoroughness, creating detailed breakdowns of every garment, accessory, and beauty product identified. This level of engagement transforms each appearance into a cultural event with its own extended lifecycle of discussion and interpretation.`,
    `The industry response has been equally notable. Several designers have publicly acknowledged {artist}'s influence on their collections, while beauty brands have cited {artist}'s looks as direct inspiration for product development. This kind of documented influence trail is rare and speaks to genuine cultural impact.`,
  ],
  impact: [
    `The broader implications of {artist}'s style influence extend well beyond the immediate K-pop ecosystem. When a K-pop artist can drive global beauty trends, redirect fashion week conversations, and influence luxury brand strategy, we are witnessing a fundamental shift in how cultural authority operates in the twenty-first century.`,
    `Looking forward, {artist}'s evolving aesthetic will continue to provide a lens through which to understand larger movements in fashion and beauty. The choices made now will be studied by future trend forecasters as data points in the ongoing story of Korean cultural influence on global style.`,
    `The conversation that {artist} helps advance \u2014 about beauty standards, about fashion inclusivity, about the right of artists to be taken seriously as style voices \u2014 is ultimately more important than any single outfit or makeup look. It is a conversation that LUEUR is committed to supporting with depth, nuance, and genuine expertise.`,
  ],
  noArtist: {
    background: [
      `The K-beauty industry has undergone a remarkable transformation over the past decade. What began as a niche interest for skincare enthusiasts has become one of the most influential forces in global beauty, with Korean innovations routinely setting standards that international brands rush to follow.`,
      `Fashion's center of gravity continues its eastward shift. Seoul Fashion Week now attracts international press coverage comparable to its European counterparts, while Korean street style has become a primary source of trend intelligence for forecasting agencies worldwide. This is no longer an emerging market \u2014 it is an established creative force.`,
      `The intersection of K-pop and fashion has produced a new model of cultural influence. Unlike traditional celebrity endorsement, K-pop's relationship with fashion is bidirectional and deeply integrated into the content that artists create. The result is a form of influence that feels organic precisely because it often is.`,
    ],
    detail: [
      `Data from global beauty retailers confirms what industry observers have long suspected: products associated with K-beauty trends and K-pop artists consistently outperform comparable items without these associations. The premium that Korean aesthetic credibility commands is substantial and growing.`,
      `The creative infrastructure behind K-pop's fashion output deserves more recognition than it typically receives. Stylists, makeup artists, hair directors, and photographers work in concert to create visual identities that can sustain multiple years of public scrutiny. This is world-class creative work by any standard.`,
    ],
    reaction: [
      `Global audiences have demonstrated remarkable sophistication in their engagement with K-beauty and K-fashion content. Comment sections and fan forums contain analysis that would be at home in professional fashion criticism, suggesting that K-pop has effectively democratized fashion literacy for an entire generation.`,
      `The response from the traditional fashion establishment has evolved from curiosity to genuine respect. Major fashion publications now maintain dedicated K-pop style coverage, a development that reflects both audience demand and editorial recognition of the creative merit involved.`,
    ],
    impact: [
      `The cultural exchange between Korean and global fashion continues to accelerate. As K-beauty principles become mainstream and K-pop aesthetics influence everything from street style to haute couture, we are witnessing the early stages of what will likely be a decades-long transformation in global beauty and fashion standards.`,
      `What makes this moment particularly significant is its sustainability. Unlike many cultural trends that burn bright and fade quickly, K-beauty and K-fashion influence has demonstrated remarkable staying power, suggesting that we are witnessing not a trend but a permanent shift in the global style conversation.`,
    ],
  },
};

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  const inlineImages = (articleContent?.images || []).slice(1, 4);

  const paragraphs = [];

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickRandom(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPick(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPick(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPick(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPick(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickRandom(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickRandom(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickRandom(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPick(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickRandom(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickRandom(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Image tag helpers
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Card generators — LUEUR style
// ============================================================

function generateEditorialLarge(article) {
  if (!article) return '';
  const cat = displayCategoryFromTopic(classifyTopic(article.originalTitle || article.title));
  return `<a href="${escapeHtml(article.localUrl)}" class="editorial-large">
        ${imgTag(article, 640, 854, 'eager')}
        <div class="ed-content">
          <div class="ed-cat">${cat}</div>
          <div class="ed-title">${escapeHtml(article.title)}</div>
          <div class="ed-date">${escapeHtml(article.formattedDate)}</div>
        </div>
      </a>`;
}

function generateEditorialSmall(article) {
  if (!article) return '';
  const cat = displayCategoryFromTopic(classifyTopic(article.originalTitle || article.title));
  return `<a href="${escapeHtml(article.localUrl)}" class="editorial-small">
          ${imgTag(article, 300, 300)}
          <div class="ed-content">
            <div class="ed-cat">${cat}</div>
            <div class="ed-title">${escapeHtml(article.title)}</div>
            <div class="ed-date">${escapeHtml(article.formattedDate)}</div>
          </div>
        </a>`;
}

function generateBeautyCard(article) {
  if (!article) return '';
  const cat = displayCategoryFromTopic(classifyTopic(article.originalTitle || article.title));
  return `<a href="${escapeHtml(article.localUrl)}" class="beauty-card">
        ${imgTag(article, 580, 362)}
        <div class="beauty-cat">${cat}</div>
        <div class="beauty-title">${escapeHtml(article.title)}</div>
        <div class="beauty-date">${escapeHtml(article.formattedDate)}</div>
      </a>`;
}

function generateFashionBlock(article, idx) {
  if (!article) return '';
  const cat = displayCategoryFromTopic(classifyTopic(article.originalTitle || article.title));
  // Generate a short excerpt from the title
  const excerpt = `A closer look at ${escapeHtml(article.title).toLowerCase().includes('fashion') ? 'the fashion moments' : 'the style choices'} that are shaping the conversation this season.`;
  return `<a href="${escapeHtml(article.localUrl)}" class="fashion-block">
        <div class="fashion-img">
          ${imgTag(article, 640, 500)}
        </div>
        <div class="fashion-text">
          <div class="fashion-cat">${cat}</div>
          <div class="fashion-title">${escapeHtml(article.title)}</div>
          <div class="fashion-excerpt">${excerpt}</div>
          <div class="fashion-date">${escapeHtml(article.formattedDate)}</div>
        </div>
      </a>`;
}

function generatePeopleCard(article) {
  if (!article) return '';
  const artist = extractArtist(article.originalTitle || article.title);
  const role = artist ? 'Style Icon' : 'Featured';
  return `<a href="${escapeHtml(article.localUrl)}" class="people-card">
        ${imgTag(article, 300, 400)}
        <div class="people-name">${escapeHtml(article.title.length > 60 ? article.title.slice(0, 57) + '...' : article.title)}</div>
        <div class="people-role">${role}</div>
      </a>`;
}

// ============================================================
// Backdate articles — Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const range = endDate.getTime() - startDate.getTime();

  for (let i = 0; i < articles.length; i++) {
    // Distribute articles across the date range, most recent first
    const ratio = i / Math.max(articles.length - 1, 1);
    const timestamp = endDate.getTime() - (ratio * range);
    const d = new Date(timestamp);
    // Add some randomness (within a day)
    d.setHours(Math.floor(Math.random() * 24));
    d.setMinutes(Math.floor(Math.random() * 60));

    articles[i].pubDate = d;
    articles[i].formattedDate = `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  log(`  Backdated ${articles.length} articles (Jan 1 - Mar 22, 2026)`);
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) heroImgSrc = '../' + heroImgSrc;
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) relImgSrc = '../' + relImgSrc;
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      const cat = displayCategoryFromTopic(classifyTopic(rel.originalTitle || rel.title));
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-category">${cat}</div>
            <h3>${escapeHtml(rel.title)}</h3>
            <span class="date">${escapeHtml(rel.formattedDate)}</span>
          </a>`;
    }

    const sourceAttribution = `<div class="source-attribution">
          Source: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">Read original article &rarr;</a>
        </div>`;

    const photoCredit = `Photo: &copy; ${escapeHtml(article.source)}`;

    const cat = displayCategoryFromTopic(classifyTopic(article.originalTitle || article.title));

    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', cat)
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 5;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/lueur-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  // Section assignment per spec: hero: 1, editorial: 3, beauty: 4, fashion: 4, people: 4
  const heroCandidates = withRealImages.length >= 1 ? withRealImages : articles;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const editorial = take(withRealImages.length >= 4 ? withRealImages : articles, 3);
  const beauty = take(articles, 4);
  const fashion = take(articles, 4);
  const people = take(articles, 4);

  return {
    hero: hero[0] || null,
    editorial,
    beauty,
    fashion,
    people,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  // HERO
  if (sections.hero) {
    const h = sections.hero;
    const heroImgSrc = h.image || PLACEHOLDER_IMAGE;
    const fallback = `https://picsum.photos/seed/${encodeURIComponent(h.title.slice(0, 20))}/1600/900`;
    const heroImage = `<img class="cover-image" src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(h.title)}" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
    const cat = displayCategoryFromTopic(classifyTopic(h.originalTitle || h.title));

    template = template
      .replace('{{HERO_IMAGE}}', heroImage)
      .replace('{{HERO_TITLE}}', escapeHtml(h.title))
      .replace('{{HERO_CATEGORY}}', cat)
      .replace('{{HERO_DATE}}', escapeHtml(h.formattedDate))
      .replace('{{HERO_SOURCE}}', escapeHtml(h.source));

    // Wrap the cover section in a link
    template = template.replace(
      '<section class="cover-section">',
      `<a href="${escapeHtml(h.localUrl)}" style="display:block;color:inherit;text-decoration:none"><section class="cover-section">`
    );
    template = template.replace('</section>', '</section></a>');
  } else {
    template = template
      .replace('{{HERO_IMAGE}}', '')
      .replace('{{HERO_TITLE}}', 'LUEUR')
      .replace('{{HERO_CATEGORY}}', 'EDITORIAL')
      .replace('{{HERO_DATE}}', '')
      .replace('{{HERO_SOURCE}}', '');
  }

  // EDITORIAL PICKS — 1 large + 2 small stacked
  let editorialHtml = '';
  if (sections.editorial.length > 0) {
    editorialHtml += generateEditorialLarge(sections.editorial[0]);
    editorialHtml += `<div class="editorial-stack">`;
    for (let i = 1; i < sections.editorial.length; i++) {
      editorialHtml += generateEditorialSmall(sections.editorial[i]);
    }
    editorialHtml += `</div>`;
  }
  template = template.replace('{{EDITORIAL_PICKS}}', editorialHtml);

  // BEAUTY
  template = template.replace(
    '{{BEAUTY_ARTICLES}}',
    sections.beauty.map(a => generateBeautyCard(a)).join('\n      ')
  );

  // FASHION
  template = template.replace(
    '{{FASHION_ARTICLES}}',
    sections.fashion.map((a, i) => generateFashionBlock(a, i)).join('\n      ')
  );

  // PEOPLE
  template = template.replace(
    '{{PEOPLE_ARTICLES}}',
    sections.people.map(a => generatePeopleCard(a)).join('\n      ')
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting LUEUR Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to fashion/beauty editorial English
  log('Rewriting titles to LUEUR editorial style...');
  let rewritten = 0;
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    article.title = rewriteTitle(original);
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles`);
  log('');

  // 4. Backdate articles to Jan 1 - Mar 22, 2026
  backdateArticles(articles);
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.editorial);
  addUsed(sections.beauty);
  addUsed(sections.fashion);
  addUsed(sections.people);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML
  const html = await generateHtml(sections);

  // 10. Write index
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.editorial.length +
    sections.beauty.length +
    sections.fashion.length +
    sections.people.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[LUEUR Crawler] Fatal error:', err);
  process.exit(1);
});
