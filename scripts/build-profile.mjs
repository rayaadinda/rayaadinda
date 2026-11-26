// Builds the profile: fetches public GitHub data, draws each panel as an SVG
// in a Persona 3 Reload dark dithered style, and writes README.md to show them.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readConfig } from './check-profile.mjs';

const WIDTH = 880;
const CELL = 4; // px per dither cell; each dot is CELL - 1 wide
const OUT = 'profile';
const DAY = 86_400_000;
const WINDOW_DAYS = 120;

const DEFAULT_THEME = {
  void: '#050608',
  surface: '#0c0f15',
  rule: '#162338',
  ink: '#1269cc',
  quiet: '#4c7bb0',
  signal: '#53d8fb',
  dotDim: '#092240',
  dotMid: '#0d4a91',
};

const config = readConfig('profile.config.json');
const colour = { ...DEFAULT_THEME, ...(config.theme ?? {}) };

// Geist Mono advances 0.6 em per character. Geist is proportional; 0.56 em
// gives fitted prose enough room.
const monoWidth = size => size * 0.6;
const sansWidth = size => size * 0.56;

// ---------------------------------------------------------------- GitHub

const token = process.env.GITHUB_TOKEN;

async function github(path, init = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'profile-builder',
      ...init.headers,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers,
    });
    if (response.status === 202) {
      await new Promise(done => setTimeout(done, 2000));
      continue;
    }
    if (!response.ok) {
      throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }
  throw new Error(`GitHub ${path}: still computing after 5 attempts`);
}

async function graphql(query, variables) {
  const result = await github('/graphql', { method: 'POST', body: JSON.stringify({ query, variables }) });
  if (result.errors) throw new Error(JSON.stringify(result.errors));
  return result.data;
}

function ymd(date) {
  return [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()];
}

const shortDate = time =>
  new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function parseContributionHtml(html, perDay) {
  const idToDate = new Map();
  const tdRegex = /<td\b[^>]*>/g;
  for (const match of html.matchAll(tdRegex)) {
    const tag = match[0];
    const dateMatch = /\bdata-date="(\d{4}-\d{2}-\d{2})"/.exec(tag);
    const idMatch = /\bid="([^"]+)"/.exec(tag);
    if (dateMatch && idMatch) {
      idToDate.set(idMatch[1], dateMatch[1]);
    }
  }
  const tipRegex = /<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/g;
  for (const match of html.matchAll(tipRegex)) {
    const attrs = match[1];
    const forMatch = /\bfor="([^"]+)"/.exec(attrs);
    if (!forMatch) continue;
    const date = idToDate.get(forMatch[1]);
    if (!date) continue;
    const text = match[2].trim();
    if (/^No contributions?\b/i.test(text)) {
      perDay.set(date, 0);
    } else {
      const countMatch = /^(\d[\d,]*)\s+contributions?\b/i.exec(text);
      if (countMatch) {
        perDay.set(date, Number(countMatch[1].replace(/,/g, '')));
      }
    }
  }
}

/**
 * Contributions per week since the account was created.
 * Uses GraphQL when GITHUB_TOKEN is available, or public contribution HTML locally.
 */
async function contributionHistory(username) {
  let createdAt;
  if (token) {
    const { user } = await graphql('query($login: String!) { user(login: $login) { createdAt } }', {
      login: username,
    });
    createdAt = user.createdAt;
  } else {
    const user = await github(`/users/${username}`);
    createdAt = user.created_at;
  }

  const start = Date.UTC(...ymd(new Date(createdAt)));
  const today = Date.UTC(...ymd(new Date()));
  const years = [];
  for (let year = new Date(start).getUTCFullYear(); year <= new Date(today).getUTCFullYear(); year += 1) {
    years.push(year);
  }

  const perDay = new Map();
  if (token) {
    const query = `query($login: String!, $from: DateTime!, $to: DateTime!) { user(login: $login) {
      contributionsCollection(from: $from, to: $to) { contributionCalendar {
        weeks { contributionDays { contributionCount date } } } } } }`;
    const calendars = await Promise.all(
      years.map(year =>
        graphql(query, {
          login: username,
          from: new Date(Math.max(start, Date.UTC(year, 0, 1))).toISOString(),
          to: new Date(Math.min(today + DAY - 1, Date.UTC(year + 1, 0, 1) - 1)).toISOString(),
        })
      )
    );
    for (const data of calendars) {
      for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
        for (const day of week.contributionDays) perDay.set(day.date, day.contributionCount);
      }
    }
  } else {
    const pages = await Promise.all(
      years.map(async year => {
        const from = new Date(Math.max(start, Date.UTC(year, 0, 1))).toISOString().slice(0, 10);
        const to = new Date(Math.min(today, Date.UTC(year, 11, 31))).toISOString().slice(0, 10);
        const response = await fetch(`https://github.com/users/${username}/contributions?from=${from}&to=${to}`, {
          headers: { 'user-agent': 'profile-builder' },
        });
        if (!response.ok) {
          throw new Error(`GitHub contributions ${year}: ${response.status}`);
        }
        return response.text();
      })
    );
    for (const html of pages) {
      parseContributionHtml(html, perDay);
    }
  }

  const weeks = new Array(Math.floor((today - start) / DAY / 7) + 1).fill(0);
  let total = 0;
  let last = start;
  for (const [date, count] of perDay) {
    const time = Date.parse(`${date}T00:00:00Z`);
    if (time < start || time > today) continue;
    weeks[Math.floor((time - start) / DAY / 7)] += count;
    total += count;
    if (count > 0) last = Math.max(last, time);
  }
  return { start, today, last, weeks, total };
}

/** Commits per day on the default branch, falling back to the latest active window if quiet recently. */
async function commitsPerDay(repo, createdAt, pushedAt) {
  const createdDay = Date.UTC(...ymd(new Date(createdAt)));
  const today = Date.UTC(...ymd(new Date()));
  const pushedDay = Date.UTC(...ymd(new Date(pushedAt)));

  const fetchWindow = async (startMs, endMs) => {
    const counts = new Array(Math.round((endMs - startMs) / DAY) + 1).fill(0);
    const since = new Date(startMs).toISOString();
    const until = new Date(endMs + DAY - 1).toISOString();
    for (let page = 1; ; page += 1) {
      const commits = await github(
        `/repos/${repo}/commits?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}&per_page=100&page=${page}`
      );
      for (const commit of commits) {
        const day = Math.floor((Date.UTC(...ymd(new Date(commit.commit.committer.date))) - startMs) / DAY);
        if (day >= 0 && day < counts.length) counts[day] += 1;
      }
      if (commits.length < 100) break;
    }
    return counts;
  };

  let start = Math.max(createdDay, today - (WINDOW_DAYS - 1) * DAY);
  let end = today;
  let endsAtToday = true;
  let counts = await fetchWindow(start, end);
  let total = counts.reduce((a, b) => a + b, 0);

  if (total === 0 && pushedDay < start) {
    end = pushedDay;
    start = Math.max(createdDay, end - (WINDOW_DAYS - 1) * DAY);
    endsAtToday = false;
    counts = await fetchWindow(start, end);
  }

  return { start, end, endsAtToday, counts };
}

// ---------------------------------------------------------------- dither

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36,
  14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23,
  61, 29, 53, 21,
].map(v => (v + 0.5) / 64);
const threshold = (x, y) => BAYER[(y & 7) * 8 + (x & 7)];

function valueNoise(seed) {
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const smooth = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

function fieldAt(noise, x, y) {
  const n = 0.65 * noise(x / 26, y / 9) + 0.35 * noise(x / 7 + 40, y / 4 + 9);
  return Math.max(0, n - 0.5) * 0.9;
}

const cellHash = (c, r) => {
  let h = Math.imul(c * 73856093 ^ r * 19349663, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967295;
};

function dither({ x0, y0, cols, rows, sample, mark, layers }) {
  const groups = new Map();
  const add = (key, c, r) => {
    const x = x0 + c * CELL;
    const y = y0 + r * CELL;
    groups.set(key, (groups.get(key) ?? '') + `M${x} ${y}h${CELL - 1}v${CELL - 1}h${1 - CELL}z`);
  };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (mark?.(c, r)) {
        add('signal|', c, r);
        continue;
      }
      const { data, field } = sample(c, r);
      const t = threshold(c, r);
      let cell;
      if (data > t && data >= field) {
        cell = { kind: 'data', data, tone: data > 0.72 ? 'ink' : data > 0.42 ? 'dotMid' : 'dotDim' };
      } else if (field > t) {
        cell = { kind: 'field', data, tone: 'dotDim' };
      } else {
        continue;
      }
      add(`${cell.tone}|`, c, r);
      for (const [tone, cls] of layers?.(c, r, cell) ?? []) add(`${tone}|${cls}`, c, r);
    }
  }
  return [...groups]
    .map(([key, d]) => {
      const [tone, cls] = key.split('|');
      const overlay = cls ? ` class="${cls}" opacity="0"` : '';
      return `<path${overlay} fill="${colour[tone]}" d="${d}"/>`;
    })
    .join('');
}

function at(series, t) {
  const i = t * (series.length - 1);
  const lo = Math.floor(i);
  const hi = Math.min(series.length - 1, lo + 1);
  return series[lo] + (series[hi] - series[lo]) * (i - lo);
}

function smoothSeries(series, radius) {
  return series.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - radius; j <= i + radius; j += 1) {
      if (j >= 0 && j < series.length) {
        sum += series[j];
        n += 1;
      }
    }
    return sum / n;
  });
}

// ---------------------------------------------------------------- SVG

const font = (family, file, weight) =>
  `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(
    `fonts/${file}`
  ).toString('base64')}) format('woff2')}`;
const FONTS = {
  sans: font('Geist', 'geist.woff2', '100 900'),
  mono: font('Geist Mono', 'geist-mono.woff2', '100 900'),
  pixel: font('Geist Pixel', 'geist-pixel.woff2', 400),
};

const esc = s =>
  String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function fit(text, width, size, advance = monoWidth) {
  const max = Math.floor(width / advance(size));
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function wrap(text, width, size, lines, advance = monoWidth) {
  const max = Math.floor(width / advance(size));
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= max) {
      line = next;
    } else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = fit(`${out[lines - 1]} …`, width, size, advance);
  }
  return out.filter(Boolean);
}

const text = family => (x, y, content, { size = 13, fill = colour.ink, anchor } = {}) =>
  `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" fill="${fill}"${
    anchor ? ` text-anchor="${anchor}"` : ''
  }>${esc(content)}</text>`;
const mono = text('Geist Mono');
const sans = text('Geist');

const hline = (x1, x2, y) =>
  `<path d="M${x1} ${y + 0.5}H${x2}" stroke="${colour.rule}"/>`;
const vline = (x, y1, y2) =>
  `<path d="M${x + 0.5} ${y1}V${y2}" stroke="${colour.rule}"/>`;

const CYCLE = 11;
const BANDS = 24;
const FLICKER = [3.7, 4.9, 6.1, 7.3, 5.3, 8.9];

function headerLayers(cols) {
  return (c, r, cell) => {
    const band = Math.floor((c / cols) * BANDS);
    const out = [];
    if (cell.kind === 'data') {
      out.push(['ink', `a${band}`]);
      if (cell.data > 0.45 && cellHash(c, r) < 0.55) out.push(['signal', `b${band}`]);
    } else if (cellHash(c, r) < 0.5) {
      out.push(['dotMid', `t${Math.floor(cellHash(r, c) * FLICKER.length)}`]);
    }
    return out;
  };
}

function headerCss() {
  const rules = [
    '@keyframes sweep{0%,100%{opacity:0}2%{opacity:1}9%{opacity:1}17%{opacity:0}}',
    '@keyframes probe{0%,100%{opacity:0}2%{opacity:1}10%{opacity:1}16%{opacity:0}}',
    '@keyframes flicker{0%,100%{opacity:0}50%{opacity:1}}',
  ];
  for (let i = 0; i < BANDS; i += 1) {
    const x = i / BANDS;
    const forward = 0.2 + 3 * (x + 0.05 * Math.sin(x * Math.PI * 4));
    const back = 5.2 + 4 * (1 - x) + 0.25 * Math.sin(i * 1.7);
    rules.push(`.a${i}{animation:sweep ${CYCLE}s linear ${forward.toFixed(2)}s infinite}`);
    rules.push(`.b${i}{animation:probe ${CYCLE}s linear ${back.toFixed(2)}s infinite}`);
  }
  FLICKER.forEach((duration, i) => {
    rules.push(`.t${i}{animation:flicker ${duration}s ease-in-out ${(-i * 1.3).toFixed(1)}s infinite}`);
  });
  rules.push('@media (prefers-reduced-motion:reduce){path{animation:none!important}}');
  return rules.join('');
}

function svg(width, height, title, fonts, css, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${esc(
    title
  )}</title><style>${fonts.map(f => FONTS[f]).join('')}${css}</style><rect width="${width}" height="${height}" fill="${colour.void}"/>${body}<rect x=".5" y=".5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${colour.rule}"/></svg>`;
}

// ---------------------------------------------------------------- panels

const BAR = 36;

function header(cfg, history) {
  const { profile, username } = cfg;
  const BAND = 132;
  const INFO = 172;
  const height = BAND + INFO;
  let body = '';

  const series = smoothSeries(history.weeks, 1).map(Math.sqrt);
  const peak = Math.max(...series, 1);
  const cols = WIDTH / CELL;
  const rows = BAND / CELL;
  const centre = (rows - 1) / 2;
  const noise = valueNoise(7);
  body += dither({
    x0: 0,
    y0: 0,
    cols,
    rows,
    layers: headerLayers(cols),
    sample: (c, r) => {
      const amp = 1 + (at(series, c / (cols - 1)) / peak) * (rows / 2 - 2);
      const d = Math.abs(r - centre);
      const data = d < amp ? 0.95 - 0.55 * (d / amp) : 0.55 * Math.exp(-((d - amp) ** 2) / 2);
      return { data, field: fieldAt(noise, c, r) };
    },
  });

  const span = Math.max(history.today - history.start, DAY);
  const startYear = new Date(history.start).getUTCFullYear();
  for (let year = startYear + 1; year <= new Date(history.today).getUTCFullYear(); year += 1) {
    const x = Math.round(((Date.UTC(year, 0, 1) - history.start) / span) * WIDTH);
    body += vline(x, 0, 8);
    if (x <= WIDTH - 42) {
      body += `<rect x="${x + 3}" y="4" width="${monoWidth(10) * 4 + 4}" height="13" fill="${colour.void}"/>`;
      body += mono(x + 5, 14, String(year), { size: 10, fill: colour.quiet });
    }
  }

  const since = new Date(history.start).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const caption = `${history.total.toLocaleString('en-US')} contributions since ${since}`;
  body += `<rect x="12" y="${BAND - 26}" width="${monoWidth(11) * caption.length + 8}" height="18" fill="${colour.void}"/>`;
  body += mono(16, BAND - 13, caption, { size: 11, fill: colour.quiet });

  const status =
    history.last === history.today ? 'contributed today' : `last contribution ${shortDate(history.last).toLowerCase()}`;
  const backing = 12 * 0.7 * status.length + 34;
  body += `<rect x="${WIDTH - 12 - backing}" y="${BAND - 26}" width="${backing}" height="18" fill="${colour.void}"/>`;
  body += `<rect x="${WIDTH - 22}" y="${BAND - 20}" width="6" height="6" fill="${colour.signal}"/>`;
  body += `<text x="${WIDTH - 32}" y="${BAND - 13}" font-family="Geist Pixel" font-size="12" fill="${colour.ink}" text-anchor="end">${esc(
    status
  )}</text>`;
  body += hline(0, WIDTH, BAND);

  body += `<text x="24" y="${BAND + 64}" font-family="Geist" font-weight="460" font-size="54" letter-spacing="-0.035em" fill="${colour.ink}">${esc(
    profile.name
  )}</text>`;
  body += mono(26, BAND + 90, `@${username}`, { size: 13, fill: colour.quiet });
  body += sans(24, BAND + 122, fit(profile.intro, WIDTH - 48, 17, sansWidth), { size: 17 });
  body += sans(24, BAND + 148, fit(profile.closing, WIDTH - 48, 15, sansWidth), { size: 15, fill: colour.quiet });

  const title = `${profile.name} (@${username}). ${profile.intro}`;
  return svg(WIDTH, height, title, ['sans', 'mono', 'pixel'], headerCss(), body);
}

const repoDesc = repo => repo.description || config.descriptions?.[repo.full_name] || '';

const repoFacts = repo =>
  [repo.stargazers_count > 0 && `${repo.stargazers_count} ${repo.stargazers_count === 1 ? 'star' : 'stars'}`, `pushed ${shortDate(repo.pushed_at)}`]
    .filter(Boolean)
    .join(', ');

function card(index, repo, activity) {
  const width = WIDTH / 2;
  const FIGURE = 170;
  const FOOT = 94;
  const height = BAR + FIGURE + FOOT;
  const [owner, name] = repo.full_name.split('/');

  let body = `<rect x="0" y="0" width="${width}" height="${BAR}" fill="${colour.surface}"/>`;
  body += mono(16, 23, name);
  body += mono(width - 16, 23, owner, { size: 12, fill: colour.quiet, anchor: 'end' });
  body += hline(0, width, BAR);

  const series = smoothSeries(activity.counts, 1);
  const peak = Math.max(...series);
  const maxDay = Math.max(...activity.counts);
  const peakDay = activity.counts.indexOf(maxDay);
  const cols = width / CELL;
  const rows = FIGURE / CELL;
  const top = 9;
  const ridgeAt = c => rows - 3 - (peak > 0 ? at(series, c / (cols - 1)) / peak : 0) * (rows - 3 - top);
  const peakCol = activity.counts.length > 1 ? Math.round((peakDay / (activity.counts.length - 1)) * (cols - 1)) : 0;
  const noise = valueNoise(index + 11);
  body += dither({
    x0: 0,
    y0: BAR,
    cols,
    rows,
    sample: (c, r) => {
      const ridge = ridgeAt(c);
      const data =
        r >= ridge ? 0.95 - 0.6 * ((r - ridge) / (rows - ridge + 1)) : 0.8 * Math.exp(-((ridge - r) ** 2) / 3);
      return { data, field: fieldAt(noise, c, r) };
    },
    mark:
      peak > 0
        ? (c, r) => Math.abs(c - peakCol) <= 1 && Math.abs(r - Math.round(ridgeAt(peakCol)) + 1) <= 1
        : undefined,
  });
  const total = activity.counts.reduce((a, b) => a + b, 0);
  const rangeEnd = activity.endsAtToday ? 'today' : shortDate(activity.end);
  body += mono(16, BAR + 22, `Commits per day, ${shortDate(activity.start)} to ${rangeEnd}`, { size: 11, fill: colour.quiet });
  body += mono(width - 16, BAR + 22, `${total.toLocaleString('en-US')} total, peak ${maxDay}`, {
    size: 11,
    fill: colour.quiet,
    anchor: 'end',
  });
  body += hline(0, width, BAR + FIGURE);

  const y0 = BAR + FIGURE;
  const description = repoDesc(repo);
  wrap(description, width - 32, 14, 2, sansWidth).forEach((line, i) => {
    body += sans(16, y0 + 28 + i * 20, line, { size: 14 });
  });
  body += mono(16, y0 + 78, repo.language ?? '', { size: 11, fill: colour.quiet });
  body += mono(width - 16, y0 + 78, repoFacts(repo), { size: 11, fill: colour.quiet, anchor: 'end' });

  const title = `${repo.full_name}: ${description}`;
  return svg(width, height, title, ['sans', 'mono'], '', body);
}

function moreRepos(repos) {
  const ROW = 44;
  const height = ROW * repos.length;
  let body = '';
  repos.forEach((repo, i) => {
    const y = i * ROW;
    if (i > 0) body += hline(0, WIDTH, y);
    body += mono(16, y + 27, fit(repo.name, 150, 13));
    body += sans(180, y + 27, fit(repoDesc(repo), 440, 14, sansWidth), { size: 14, fill: colour.quiet });
    body += mono(640, y + 27, repo.language ?? '', { size: 11, fill: colour.quiet });
    body += mono(WIDTH - 16, y + 27, repoFacts(repo), { size: 11, fill: colour.quiet, anchor: 'end' });
  });
  return svg(WIDTH, height, `More repositories: ${repos.map(r => r.full_name).join(', ')}`, ['sans', 'mono'], '', body);
}

function chip(link) {
  const height = 36;
  const width = Math.ceil(16 + monoWidth(13) * link.label.length + 14 + 9 + 14);
  const ax = width - 14 - 9;
  let body = `<rect x="0" y="0" width="${width}" height="${height}" fill="${colour.surface}"/>`;
  body += mono(16, 23, link.label);
  body += `<path d="M${ax} ${27}L${ax + 9} ${18}M${ax + 2} ${18}H${ax + 9}V${25}" stroke="${colour.quiet}" fill="none" stroke-width="1.4"/>`;
  return svg(width, height, link.label, ['mono'], '', body);
}

// ---------------------------------------------------------------- build

mkdirSync(OUT, { recursive: true });

const repoData = async full => github(`/repos/${full}`);
const [history, featured, more] = await Promise.all([
  contributionHistory(config.username),
  Promise.all(
    config.featured.map(async full => {
      const repo = await repoData(full);
      return { repo, activity: await commitsPerDay(full, repo.created_at, repo.pushed_at) };
    })
  ),
  Promise.all(config.more.map(repoData)),
]);

const written = {};
const write = (file, content) => {
  writeFileSync(`${OUT}/${file}`, content);
  written[file] = createHash('sha256').update(content).digest('hex').slice(0, 10);
};

write('header.svg', header(config, history));
featured.forEach(({ repo, activity }, i) => write(`card-${i + 1}.svg`, card(i, repo, activity)));
write('repos.svg', moreRepos(more));
config.links.forEach((link, i) => write(`link-${i + 1}.svg`, chip(link)));
for (const file of readdirSync(OUT)) {
  if (file.endsWith('.svg') && !(file in written)) rmSync(`${OUT}/${file}`);
}

const img = (file, alt, size) => `<img src="./${OUT}/${file}?v=${written[file]}" ${size} alt="${esc(alt)}">`;
const cards = featured.map(
  ({ repo }, i) =>
    `<a href="${repo.html_url}">${img(`card-${i + 1}.svg`, `${repo.name}: ${repoDesc(repo)}`, 'width="50%"')}</a>`
);
const readme = [
  '<!-- Generated by scripts/build-profile.mjs from profile.config.json. Edit those, not this file. -->',
  `<p align="center"><picture>${img('header.svg', `${config.profile.name} (@${config.username}). ${config.profile.intro}`, 'width="100%"')}</picture></p>`,
  '',
  cards.slice(0, 2).join(''),
  cards.slice(2).join(''),
  '',
  `<a href="https://github.com/${config.username}?tab=repositories">${img('repos.svg', 'More repositories', 'width="100%"')}</a>`,
  '',
  `<p align="center">${config.links
    .map((link, i) => `<a href="${link.url}">${img(`link-${i + 1}.svg`, link.label, 'height="36"')}</a>`)
    .join(' ')}</p>`,
  '',
].join('\n');
writeFileSync('README.md', readme);
console.log(`Built README.md and ${Object.keys(written).length} SVGs in ${OUT}/`);
