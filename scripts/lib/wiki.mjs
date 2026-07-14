/**
 * Utilitários de acesso e parsing da Wikipédia (en).
 * Sem dependências externas — usa apenas fetch nativo do Node.
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const UA = 'SM2026/1.0 (simulador educacional de futebol; https://localhost)';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const wikiAPI = (params) =>
  'https://en.wikipedia.org/w/api.php?' +
  new URLSearchParams({ format: 'json', formatversion: '2', ...params });

export async function getJSON(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries) await sleep(500 * i * i);
    }
  }
  throw lastErr;
}

/**
 * Baixa um arquivo, pulando se já existir em cache.
 * O Wikimedia limita rajadas (429/503) e recusa em silêncio, então baixamos em ritmo
 * controlado e com backoff — sem isso, boa parte das 211 bandeiras vem faltando.
 */
export async function download(url, dest, tries = 3) {
  if (existsSync(dest)) return true;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) return false; // 404: não adianta insistir
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.from(await res.arrayBuffer()));
      await sleep(80);
      return true;
    } catch {
      if (i === tries) return false;
      await sleep(800 * i * i);
    }
  }
  return false;
}

/** Cache em disco do wikitexto: a coleta inteira é reexecutável sem martelar a Wikipédia. */
export async function wikitext(page, cacheDir) {
  const key = page.replace(/[^\w\-]+/g, '_').slice(0, 120);
  const file = cacheDir && path.join(cacheDir, `${key}.wiki`);
  if (file && existsSync(file)) return readFile(file, 'utf8');

  const d = await getJSON(wikiAPI({ action: 'parse', page, prop: 'wikitext', redirects: '1' }));
  if (d.error) throw new Error(`${page}: ${d.error.code}`);
  const text = d.parse.wikitext;
  if (file) {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(file, text);
  }
  return text;
}

/** Resolve redirecionamentos e existência de páginas em lote (limite de 50 títulos por chamada). */
export async function resolveTitles(titles) {
  const result = new Map(); // título pedido -> título final (ou null se não existe)
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const d = await getJSON(
      wikiAPI({ action: 'query', titles: batch.join('|'), redirects: '1' }),
    );
    const q = d.query || {};
    const norm = new Map((q.normalized || []).map((n) => [n.from, n.to]));
    const redir = new Map((q.redirects || []).map((r) => [r.from, r.to]));
    const exists = new Map((q.pages || []).map((p) => [p.title, !p.missing]));
    for (const t of batch) {
      const step1 = norm.get(t) || t;
      const step2 = redir.get(step1) || step1;
      result.set(t, exists.get(step2) ? step2 : null);
    }
    await sleep(120);
  }
  return result;
}

/** URL de um arquivo do Wikimedia (thumb quando possível), em lote. */
export async function resolveFiles(fileTitles, width = 320) {
  const out = new Map();
  for (let i = 0; i < fileTitles.length; i += 50) {
    const batch = fileTitles.slice(i, i + 50);
    const d = await getJSON(
      wikiAPI({
        action: 'query',
        prop: 'imageinfo',
        iiprop: 'url',
        iiurlwidth: String(width),
        titles: batch.join('|'),
        redirects: '1',
      }),
    );
    const q = d.query || {};
    const norm = new Map((q.normalized || []).map((n) => [n.from, n.to]));
    const byTitle = new Map();
    for (const p of q.pages || []) {
      const ii = (p.imageinfo || [])[0];
      byTitle.set(p.title, ii?.thumburl || ii?.url || null);
    }
    for (const t of batch) out.set(t, byTitle.get(norm.get(t) || t) ?? null);
    await sleep(120);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Parsing de wikitexto
 * ------------------------------------------------------------------ */

/** Todos os templates `{{nome|…}}` de nível superior, retornando o corpo já balanceado. */
export function findTemplates(wt, name) {
  const out = [];
  const needle = `{{${name}`;
  let i = 0;
  while ((i = wt.indexOf(needle, i)) !== -1) {
    // o próximo caractere deve fechar o nome — impede que "nat fs player" case dentro de "nat fs r player"
    const next = wt[i + needle.length];
    if (next !== '|' && next !== '}') {
      i += needle.length;
      continue;
    }
    let depth = 0;
    let j = i;
    for (; j < wt.length; j++) {
      if (wt.startsWith('{{', j)) { depth++; j++; }
      else if (wt.startsWith('}}', j)) { depth--; j++; if (depth === 0) { j++; break; } }
    }
    out.push(wt.slice(i + 2, j - 2));
    i = j;
  }
  return out;
}

/** Divide parâmetros de template respeitando `{{}}` e `[[]]` aninhados. */
export function splitParams(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith('{{', i) || body.startsWith('[[', i)) { depth++; cur += body.slice(i, i + 2); i++; continue; }
    if (body.startsWith('}}', i) || body.startsWith(']]', i)) { depth--; cur += body.slice(i, i + 2); i++; continue; }
    if (body[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  parts.push(cur);
  return parts;
}

export function parseTemplate(body) {
  const params = {};
  for (const p of splitParams(body).slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return params;
}

/**
 * `[[Alisson Becker|Alisson]]` → `Alisson`; remove refs, HTML, itálicos e templates residuais.
 *
 * Vários artigos escrevem o nome com `{{sortname|Daniel|Naumov}}` em vez de wikilink; sem
 * expandir isso antes de descartar templates, o jogador sairia sem nome (e seria perdido).
 */
export function cleanText(v) {
  if (!v) return '';
  return v
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{\s*(?:sortname|nowrap|ill|interlanguage link)\s*\|([^{}]*)\}\}/gi, (_, args) => {
      const positional = args.split('|').map((s) => s.trim()).filter((s) => s && !s.includes('='));
      // sortname: 1º e 2º parâmetros são nome e sobrenome; o 3º é só chave de ordenação/link
      return positional.slice(0, 2).join(' ');
    })
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `{{bda|df=y|1992|10|2}}` ou `{{birth date and age2|2026|6|11|1992|10|2}}` → `1992-10-02`. */
export function parseBirthDate(v) {
  if (!v) return null;
  const inner = v.match(/\{\{([\s\S]*)\}\}/);
  if (!inner) return v.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;

  const parts = splitParams(inner[1]);
  const tpl = parts[0].trim().toLowerCase();
  const nums = parts
    .slice(1)
    .filter((p) => !p.includes('='))
    .map((p) => parseInt(p.trim(), 10))
    .filter(Number.isFinite);

  // `birth date and age2` recebe a data de referência antes da data de nascimento
  const useLast = tpl.includes('2') && nums.length >= 6;
  const [y, m, d] = useLast ? nums.slice(-3) : nums.slice(0, 3);
  if (!y || !m || !d || y < 1955 || y > 2015 || m > 12 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
