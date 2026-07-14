#!/usr/bin/env node
/**
 * Coleta os dados públicos que alimentam o SM2026.
 *
 * Fontes (todas públicas):
 *  - Wikipédia (en)
 *      · "List of men's national association football teams" → as 211 federações da FIFA, por confederação
 *      · "List of FIFA country codes"                        → código FIFA de 3 letras
 *      · "Module:SportsRankings/data/FIFA World Rankings"    → Ranking FIFA (posição e pontos)
 *      · "<País> national football team"                     → elenco atual, convocados recentes e técnico
 *      · "Template:Country data <País>"                      → arquivo da bandeira oficial
 *  - Wikimedia Commons → bandeiras e logos das confederações
 *  - TheSportsDB       → escudo da federação nacional
 *
 * Saída: data/dataset.json + imagens em public/assets/
 * O wikitexto é cacheado em data/cache/, então reexecutar é barato.
 *
 * Uso: node scripts/fetch-data.mjs
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UA, sleep, getJSON, download, wikitext, resolveTitles, wikiAPI,
  findTemplates, parseTemplate, cleanText, parseBirthDate,
} from './lib/wiki.mjs';
import { CONFEDERATIONS, NAME_PT, RANKING_ALIASES } from './lib/meta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'data', 'cache');
const PUBLIC = path.join(ROOT, 'public');
const SKIP_ASSETS = process.env.SKIP_ASSETS === '1';

const log = (...a) => console.log(...a);
const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/* ------------------------------------------------------------------ *
 * 1. As 211 federações, por confederação
 * ------------------------------------------------------------------ */
async function fetchMembers() {
  const wt = await wikitext("List of men's national association football teams", CACHE);
  const members = [];
  const codes = new Set(CONFEDERATIONS.map((c) => c.code));

  // Corta em QUALQUER cabeçalho seguinte: as seções de times não filiados vêm logo após a UEFA
  const heads = [...wt.matchAll(/^(==+)\s*(.+?)\s*=+$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const conf = heads[i][2].match(/^([A-Z]+)\s*\(/)?.[1];
    if (!conf || !codes.has(conf)) continue;
    const body = wt.slice(heads[i].index, heads[i + 1]?.index ?? wt.length);
    for (const line of body.split('\n')) {
      // aceita `{{fb|País}}` e `{{fb|País|name=…}}`; itálico = filiado à confederação mas não à FIFA
      const m = line.match(/^\*\s*('')?\s*\{\{fb\|([^}|]+?)(?:\|[^}]*)?\}\}/);
      if (!m || m[1]) continue;
      members.push({ wiki_name: m[2].trim(), confederation: conf });
    }
  }
  return members;
}

/* ------------------------------------------------------------------ *
 * 2. Código FIFA de 3 letras (via redirecionamentos Template:Country data XXX)
 * ------------------------------------------------------------------ */
async function fetchFifaCodes(members) {
  const wt = await wikitext('List of FIFA country codes', CACHE);
  const codes = [...new Set([...wt.matchAll(/\{\{Fba\|([A-Z]{3})\}\}/gi)].map((m) => m[1].toUpperCase()))];
  log(`  · ${codes.length} códigos FIFA na lista`);

  // O nome usado na lista de membros nem sempre é o do template do código
  // (ex.: "Congo" → Template:Country data Republic of the Congo ← CGO).
  // Os dois lados são resolvidos até o template canônico e unidos por ele.
  const byCanon = new Map(); // template canônico → código FIFA
  const fromCodes = await resolveTitles(codes.map((c) => `Template:Country data ${c}`));
  for (const c of codes) {
    const target = fromCodes.get(`Template:Country data ${c}`);
    if (target) byCanon.set(target, c);
  }

  const fromNames = await resolveTitles(members.map((m) => `Template:Country data ${m.wiki_name}`));
  const byName = new Map(); // nome do membro → código FIFA
  for (const m of members) {
    const canon = fromNames.get(`Template:Country data ${m.wiki_name}`);
    const code = (canon && byCanon.get(canon)) || byCanon.get(`Template:Country data ${m.wiki_name}`);
    if (code) byName.set(m.wiki_name, code);

    // A lista de membros cita o Timor-Leste pelo código ({{fb|TLS}}); o template canônico
    // devolve o nome de verdade, necessário para achar o artigo da seleção.
    if (canon && /^[A-Z]{3}$/.test(m.wiki_name)) {
      const real = canon.replace(/^Template:Country data /, '').trim();
      if (real && real !== m.wiki_name) {
        byName.set(real, code ?? m.wiki_name);
        m.wiki_name = real;
      }
    }
  }

  const missing = members.filter((m) => !byName.has(m.wiki_name));
  if (missing.length) log(`  ⚠ sem código FIFA: ${missing.map((m) => m.wiki_name).join(', ')}`);
  return byName;
}

/* ------------------------------------------------------------------ *
 * 3. Ranking FIFA (módulo Lua da Wikipédia)
 * ------------------------------------------------------------------ */
async function fetchRanking() {
  const file = path.join(CACHE, 'fifa_ranking.lua');
  let lua;
  if (existsSync(file)) {
    lua = await readFile(file, 'utf8');
  } else {
    const res = await fetch(
      'https://en.wikipedia.org/wiki/Module:SportsRankings/data/FIFA_World_Rankings?action=raw',
      { headers: { 'User-Agent': UA } },
    );
    lua = await res.text();
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, lua);
  }
  const ranking = new Map(); // nome → { rank, points }
  for (const m of lua.matchAll(/\{\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(-?\d+)\s*,\s*([\d.]+)\s*\}/g)) {
    ranking.set(m[1].trim(), { rank: +m[2], points: +m[4] });
  }
  const updated = lua.match(/data\.updated\s*=\s*\{\s*day\s*=\s*(\d+),\s*month\s*=\s*'([^']+)',\s*year\s*=\s*(\d+)/);
  return { ranking, updatedAt: updated ? `${updated[1]} ${updated[2]} ${updated[3]}` : 'desconhecido' };
}

/* ------------------------------------------------------------------ *
 * 4. Bandeiras (arquivo oficial usado pela Wikipédia)
 * ------------------------------------------------------------------ */
async function fetchFlagFiles(members) {
  const titles = members.map((m) => `Template:Country data ${m.wiki_name}`);
  const flagFileByName = new Map();

  for (let i = 0; i < titles.length; i += 40) {
    const batch = titles.slice(i, i + 40);
    const d = await getJSON(
      wikiAPI({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', titles: batch.join('|'), redirects: '1' }),
    );
    const norm = new Map((d.query?.normalized || []).map((n) => [n.from, n.to]));
    const redir = new Map((d.query?.redirects || []).map((r) => [r.from, r.to]));
    const content = new Map(
      (d.query?.pages || []).map((p) => [p.title, p.revisions?.[0]?.slots?.main?.content || '']),
    );
    for (const t of batch) {
      const final = redir.get(norm.get(t) || t) || norm.get(t) || t;
      const flag = content
        .get(final)
        ?.match(/\|\s*flag alias\s*=\s*([^\n|}]+)/i)?.[1]
        // o nome do arquivo às vezes vem colado a comentários (Bélgica) ou a <noinclude> (Malawi)
        .replace(/<!--[\s\S]*?-->/g, '')
        .split('<')[0]
        .trim();
      if (flag) flagFileByName.set(t.replace(/^Template:Country data /, ''), `File:${flag}`);
    }
    await sleep(120);
  }
  return flagFileByName;
}

/* ------------------------------------------------------------------ *
 * 5. Elenco: artigo da seleção
 * ------------------------------------------------------------------ */
const TEAM_TITLE_PATTERNS = [
  (n) => `${n} national football team`,
  (n) => `${n} men's national soccer team`,
  (n) => `${n} national soccer team`,
  (n) => `${n} men's national football team`,
];

/**
 * Devolve, por seleção, os títulos existentes em ordem de preferência.
 * Não basta a página existir: "Australia national football team" cai numa desambiguação e
 * "United States national football team" cai no futebol americano. A escolha final é feita
 * pelo conteúdo (precisa ter o infobox de seleção), já com o wikitexto em mãos.
 */
async function resolveTeamArticles(members) {
  const candidates = new Map(members.map((m) => [m.wiki_name, []]));
  for (const pattern of TEAM_TITLE_PATTERNS) {
    const titles = members.map((m) => pattern(m.wiki_name));
    const res = await resolveTitles(titles);
    members.forEach((m, i) => {
      const target = res.get(titles[i]);
      const list = candidates.get(m.wiki_name);
      if (target && !list.includes(target)) list.push(target);
    });
  }
  return candidates;
}

const POSITIONS = new Set(['GK', 'DF', 'MF', 'FW']);

/** A Wikipédia escreve "Unattached"/"Free agent" para quem está sem clube. */
function normalizeClub(club) {
  if (!club || /^(unattached|free agent)$/i.test(club)) return null;
  return club;
}

function playersFrom(wt, template, source) {
  const out = [];
  for (const body of findTemplates(wt, template)) {
    const p = parseTemplate(body);
    const name = cleanText(p.name);
    const pos = cleanText(p.pos).toUpperCase().slice(0, 2);
    if (!name || !POSITIONS.has(pos)) continue;
    out.push({
      name,
      position: pos,
      shirt: parseInt(cleanText(p.no), 10) || null,
      birth_date: parseBirthDate(p.age),
      caps: parseInt(cleanText(p.caps), 10) || 0,
      goals: parseInt(cleanText(p.goals), 10) || 0,
      club: normalizeClub(cleanText(p.club)),
      club_country: cleanText(p.clubnat).toUpperCase().slice(0, 3) || null,
      source,
    });
  }
  return out;
}

function extractSquad(wt) {
  const current = [
    ...playersFrom(wt, 'nat fs g player', 'squad'),
    ...playersFrom(wt, 'nat fs player', 'squad'),
  ];
  const recent = playersFrom(wt, 'nat fs r player', 'recent');
  const seen = new Set();
  const pool = [];
  for (const p of [...current, ...recent]) {
    const key = `${p.name}|${p.position}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push(p);
  }
  return pool;
}

function extractCoach(wt) {
  const infobox = findTemplates(wt, 'Infobox national football team')[0];
  if (!infobox) return null;
  const p = parseTemplate(infobox);
  return cleanText(p.coach || p.manager || '') || null;
}

/* ------------------------------------------------------------------ *
 * 6. Escudo da federação (TheSportsDB)
 * ------------------------------------------------------------------ */
async function fetchBadge(name) {
  const cacheFile = path.join(CACHE, 'sdb', `${slug(name)}.json`);
  let data;
  if (existsSync(cacheFile)) {
    data = JSON.parse(await readFile(cacheFile, 'utf8'));
  } else {
    data = await getJSON(
      `https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=${encodeURIComponent(name)}`,
    ).catch(() => ({ teams: null }));
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(data));
    await sleep(250);
  }
  const teams = (data?.teams || []).filter((t) => t.strSport === 'Soccer');
  const exact = teams.filter((t) => t.strTeam?.toLowerCase() === name.toLowerCase());
  const best =
    exact.find((t) => /FIFA|National/i.test(t.strLeague || '')) ||
    exact[0] ||
    teams.find((t) => /FIFA|National/i.test(t.strLeague || ''));
  return best?.strBadge || null;
}

/* ------------------------------------------------------------------ *
 * Execução
 * ------------------------------------------------------------------ */
async function main() {
  await mkdir(CACHE, { recursive: true });

  log('› Federações filiadas à FIFA…');
  const members = await fetchMembers();
  const byConf = {};
  for (const m of members) byConf[m.confederation] = (byConf[m.confederation] || 0) + 1;
  log(`  ${members.length} seleções — ${Object.entries(byConf).map(([k, v]) => `${k}:${v}`).join('  ')}`);

  log('\n› Códigos FIFA…');
  const fifaCodes = await fetchFifaCodes(members);

  log('\n› Ranking FIFA…');
  const { ranking, updatedAt } = await fetchRanking();
  log(`  ${ranking.size} seleções ranqueadas (atualizado em ${updatedAt})`);

  log('\n› Bandeiras…');
  const flagFiles = await fetchFlagFiles(members);
  log(`  ${flagFiles.size}/${members.length} arquivos de bandeira localizados`);

  log('\n› Artigos das seleções…');
  const articles = await resolveTeamArticles(members);
  log(`  ${articles.size}/${members.length} artigos localizados`);

  log('\n› Logos das confederações…');
  const confederations = [];
  const confFiles = [];
  for (const c of CONFEDERATIONS) {
    const wt = await wikitext(c.wiki, CACHE);
    const file = wt.match(/\|\s*(?:logo|image)\s*=\s*(?:\[\[)?(?:File:|Image:)?\s*([^|\]\n]+\.(?:svg|png|jpg|jpeg))/i)?.[1]?.trim();
    confFiles.push(file ? `File:${file}` : null);
    confederations.push({ ...c });
  }

  // Resolve as URLs de todos os arquivos (bandeiras + logos) de uma vez
  const allFiles = [...new Set([...flagFiles.values(), ...confFiles.filter(Boolean)])];
  const fileURLs = new Map();
  for (let i = 0; i < allFiles.length; i += 50) {
    const batch = allFiles.slice(i, i + 50);
    const d = await getJSON(
      wikiAPI({ action: 'query', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '512', titles: batch.join('|'), redirects: '1' }),
    );
    const norm = new Map((d.query?.normalized || []).map((n) => [n.from, n.to]));
    const byTitle = new Map();
    for (const p of d.query?.pages || []) {
      const ii = (p.imageinfo || [])[0];
      if (ii) byTitle.set(p.title, { url: ii.url, thumburl: ii.thumburl });
    }
    for (const t of batch) fileURLs.set(t, byTitle.get(norm.get(t) || t) ?? null);
    await sleep(120);
  }

  for (let i = 0; i < confederations.length; i++) {
    const c = confederations[i];
    const info = confFiles[i] && fileURLs.get(confFiles[i]);
    const url = info?.thumburl || info?.url;
    c.logo = null;
    if (url && !SKIP_ASSETS) {
      const rel = `assets/confederations/${c.code.toLowerCase()}${path.extname(new URL(url).pathname) || '.png'}`;
      if (await download(url, path.join(PUBLIC, rel))) c.logo = rel;
    }
    log(`  ${c.logo ? '✓' : '✗'} ${c.code}`);
  }

  log('\n› Elencos, bandeiras e escudos (211 seleções)…');
  const countries = [];
  const players = [];
  const warnings = [];

  for (const m of members) {
    const name = m.wiki_name;
    const code = fifaCodes.get(name) || slug(name).slice(0, 3).toUpperCase();

    let pool = [];
    let coach = null;
    let article = null;
    for (const candidate of articles.get(name) || []) {
      try {
        const wt = await wikitext(candidate, CACHE);
        // rejeita desambiguações e redirecionamentos para outro esporte (futebol americano nos EUA)
        if (!/\{\{Infobox national football team/i.test(wt)) continue;
        article = candidate;
        pool = extractSquad(wt);
        coach = extractCoach(wt);
        break;
      } catch (err) {
        warnings.push(`${name}: falha ao ler ${candidate} (${err.message})`);
      }
    }
    if (!article) warnings.push(`${name}: nenhum artigo de seleção encontrado`);

    // bandeira
    let flag = null;
    const flagInfo = flagFiles.get(name) && fileURLs.get(flagFiles.get(name));
    const flagURL = flagInfo?.url?.endsWith('.svg') ? flagInfo.url : flagInfo?.thumburl || flagInfo?.url;
    if (flagURL && !SKIP_ASSETS) {
      const rel = `assets/flags/${code}${path.extname(new URL(flagURL).pathname) || '.svg'}`;
      if (await download(flagURL, path.join(PUBLIC, rel))) flag = rel;
    }

    // escudo da federação
    let badge = null;
    const badgeURL = await fetchBadge(name).catch(() => null);
    if (badgeURL && !SKIP_ASSETS) {
      const rel = `assets/federations/${code}.png`;
      if (await download(badgeURL, path.join(PUBLIC, rel))) badge = rel;
    }

    const rk = ranking.get(RANKING_ALIASES[name] || name);
    if (!rk) warnings.push(`${name}: sem ranking FIFA`);

    countries.push({
      code,
      name: NAME_PT[name] || name,
      en_name: name,
      confederation: m.confederation,
      fifa_rank: rk?.rank ?? null,
      fifa_points: rk?.points ?? null,
      coach,
      flag,
      badge,
      wiki: article || null,
    });
    for (const p of pool) players.push({ ...p, country_code: code });

    const flagMark = flag || SKIP_ASSETS ? '' : ' [sem bandeira]';
    log(
      `  ${pool.length >= 18 ? '✓' : pool.length ? '~' : '✗'} ${code} ${name.padEnd(26).slice(0, 26)} ` +
      `rank ${String(rk?.rank ?? '—').padStart(3)} · ${String(pool.length).padStart(2)} jogadores${flagMark}`,
    );
  }

  const dataset = {
    generated_at: new Date().toISOString(),
    ranking_updated_at: updatedAt,
    sources: {
      members: 'https://en.wikipedia.org/wiki/List_of_men%27s_national_association_football_teams',
      ranking: 'https://en.wikipedia.org/wiki/Module:SportsRankings/data/FIFA_World_Rankings',
      squads: 'https://en.wikipedia.org/wiki/<seleção>_national_football_team',
      flags: 'https://commons.wikimedia.org',
      badges: 'https://www.thesportsdb.com',
    },
    confederations,
    countries,
    players,
  };
  await writeFile(path.join(ROOT, 'data', 'dataset.json'), JSON.stringify(dataset, null, 2));

  const noSquad = countries.filter((c) => !players.some((p) => p.country_code === c.code));
  const thin = countries.filter((c) => {
    const n = players.filter((p) => p.country_code === c.code).length;
    return n > 0 && n < 18;
  });

  log('\n────────────────────────────────────────────');
  log(`✔ ${countries.length} seleções · ${players.length} jogadores → data/dataset.json`);
  log(`  bandeiras: ${countries.filter((c) => c.flag).length} · escudos: ${countries.filter((c) => c.badge).length} · ranking: ${countries.filter((c) => c.fifa_rank).length}`);
  if (thin.length) log(`  ⚠ ${thin.length} com elenco curto (<18): ${thin.map((c) => c.code).join(' ')}`);
  if (noSquad.length) log(`  ⚠ ${noSquad.length} sem elenco: ${noSquad.map((c) => c.code).join(' ')}`);
  if (warnings.length) log(`  ⚠ ${warnings.length} avisos (primeiros 5): \n    ${warnings.slice(0, 5).join('\n    ')}`);
}

main().catch((e) => {
  console.error('\nFalha na coleta:', e);
  process.exit(1);
});
