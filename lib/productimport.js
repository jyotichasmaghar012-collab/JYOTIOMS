'use strict';
/**
 * "Fill from product link" for the Frame form.
 *
 * Reads a public product page (a brand / distributor site) and pulls out the
 * details the Frame form needs. Two sources, tried in order:
 *   1. Shopify stores: the product's own JSON (<origin>/products/<handle>.js),
 *      which has title, vendor, tags, colour variants, price and every photo.
 *   2. Any other site: schema.org Product data (JSON-LD) and og:/product: meta
 *      tags in the page's HTML.
 * Many sites rate-limit or block automated requests - callers get a clear
 * error and the staff member fills the form by hand instead.
 *
 * Every outbound request goes through safeFetch(), which only allows public
 * http(s) addresses (no localhost / private network / cloud metadata IPs),
 * re-checks every redirect, and caps time and size.
 */
const dns = require('node:dns').promises;
const net = require('node:net');

const USER_AGENT = 'Mozilla/5.0 (compatible; OpticalShopOMS/1.0; product-import)';
const PAGE_TIMEOUT_MS = 8000;
const PAGE_MAX_BYTES = 6 * 1024 * 1024; // some storefronts (e.g. Fynd) ship ~3 MB pages
const MAX_REDIRECTS = 4;
const MAX_IMAGES = 10;

class ImportError extends Error {}

/* ---------------- safe outbound fetch ---------------- */
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

async function assertPublicUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ImportError('Only http(s) links are supported.');
  if (u.username || u.password) throw new ImportError('Links with a username/password are not supported.');
  if (u.port && !['80', '443'].includes(u.port)) throw new ImportError('This link uses an unusual port and was not opened.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else {
    try { addrs = await dns.lookup(host, { all: true }); } catch (_) { throw new ImportError('Website not found - check the link.'); }
  }
  if (!addrs.length || addrs.some((a) => isPrivateIP(a.address))) throw new ImportError('This link points to a private address and was not opened.');
}

/** GET a public URL. Returns { buf, contentType, url } or throws ImportError. */
async function safeFetch(rawUrl, { accept = '*/*', maxBytes = PAGE_MAX_BYTES, timeoutMs = PAGE_TIMEOUT_MS } = {}) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch (_) { throw new ImportError('That does not look like a valid link.'); }
  const deadline = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: deadline, headers: { 'User-Agent': USER_AGENT, Accept: accept } });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new ImportError('The website took too long to answer.');
      throw new ImportError('Could not connect to the website.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), url);
      continue;
    }
    if (res.status === 429 || res.status === 403) throw new ImportError('The website blocked the request (too many requests / access denied).');
    if (res.status === 404) throw new ImportError('Product page not found (404) - check the link.');
    if (!res.ok) throw new ImportError(`The website answered with an error (${res.status}).`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new ImportError('The page is too large to read.');
    const chunks = []; let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { reader.cancel().catch(() => {}); throw new ImportError('The page is too large to read.'); }
      chunks.push(value);
    }
    return { buf: Buffer.concat(chunks.map((c) => Buffer.from(c))), contentType: res.headers.get('content-type') || '', url: url.href };
  }
  throw new ImportError('Too many redirects.');
}

/* ---------------- text helpers ---------------- */
const decodeEntities = (s) => String(s || '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&#x27;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

const absUrl = (u, base) => {
  if (!u) return null;
  try { return new URL(String(u).startsWith('//') ? `https:${u}` : String(u), base).href; } catch (_) { return null; }
};

/* ---------------- attribute guessing ---------------- */
// Canonical names match the default Frame Shapes list (db.js).
const SHAPES = [
  ['Cat-eye', /\bcat[\s-]?eye\b/], ['Aviator', /\baviator|\bpilot\b|\bteardrop\b/], ['Wayfarer', /\bwayfarer/],
  ['Butterfly', /\bbutterfly/], ['Hexagonal', /\bhexagon/], ['Pentagon', /\bpentagon/],
  ['Traveller', /\btravell?er\b|\bclubmaster\b|\bbrowline\b/], ['Sporty', /\bsport(y|s)?\b|\bwrap\b|\bshield\b/],
  ['Triangular', /\btriang/], ['Rectangle', /\brectang/], ['Square', /\bsquare/], ['Oval', /\boval\b/], ['Round', /\bround\b|\bcircle\b|\bcircular\b/],
];
const MATERIALS = [
  ['Titanium', /\btitanium\b/], ['Stainless Steel', /\bstainless[\s-]?steel\b/], ['TR90', /\btr[\s-]?90\b/],
  ['Acetate', /\bacetate\b/], ['Metal', /\bmetal\b/], ['Polycarbonate', /\bpolycarbonate\b/], ['Wood', /\bwood(en)?\b/],
  ['Plastic', /\bplastic\b|\binjection\b/],
];
const FRAME_TYPES = [['Rimless', /\brimless\b/], ['Half Rim', /\bhalf[\s-]?rim|\bsemi[\s-]?rim/], ['Full Rim', /\bfull[\s-]?rim/]];

const firstMatch = (list, text) => { for (const [name, re] of list) if (re.test(text)) return name; return null; };

function guessGender(text) {
  if (/\b(kids?|children|child|junior|boys?|girls?)\b/.test(text)) return 'Kids';
  const women = /\b(women|womens|women's|ladies|female|her)\b/.test(text);
  const men = /\b(men|mens|men's|male|gents|him)\b/.test(text);
  if (/\bunisex\b/.test(text) || (men && women)) return 'Unisex';
  if (women) return 'Women';
  if (men) return 'Men';
  return null;
}

function guessCategory(text) {
  if (/\bsun[\s-]?glass|\bshades\b|\bpolari[sz]ed\b|\buv ?400\b/.test(text)) return 'Sunglasses';
  if (/\beye[\s-]?glass|\bspectacle|\boptical\b|\bprescription\b|\bcomputer glass|\bblue[\s-]?(light|cut)\b/.test(text)) return 'Eyeglasses';
  return null;
}

/** "IRUS 1486S Black" -> model "1486S" when the title starts with the brand. */
function splitModel(title, brand) {
  let rest = String(title || '').trim();
  if (brand && rest.toLowerCase().startsWith(brand.toLowerCase())) rest = rest.slice(brand.length).replace(/^[\s\-–|:]+/, '');
  const code = rest.match(/\b[A-Z]{0,4}[-\s]?\d{2,}[A-Z0-9-]*\b/i);
  const model = code ? code[0].replace(/\s+/g, '') : '';
  let model_name = rest || String(title || '').trim();
  // "IRUS 1486S" has no separate name - don't repeat the code as the name.
  if (model && model_name.replace(/\s+/g, '').toLowerCase() === model.toLowerCase()) model_name = '';
  return { model, model_name };
}

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

/* ---------------- source 1: Shopify ---------------- */
async function fromShopify(pageUrl) {
  const m = pageUrl.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  let res;
  try {
    res = await safeFetch(`${pageUrl.origin}/products/${m[1]}.js`, { accept: 'application/json' });
  } catch (e) {
    if (e instanceof ImportError && /blocked/.test(e.message)) throw e; // no point trying the HTML too
    return null;
  }
  let p;
  try { p = JSON.parse(res.buf.toString('utf8')); } catch (_) { return null; }
  if (!p || !p.title || !Array.isArray(p.variants)) return null;

  const variantId = pageUrl.searchParams.get('variant');
  const variant = p.variants.find((v) => String(v.id) === variantId) || p.variants.find((v) => v.available) || p.variants[0] || {};
  const optNames = (p.options || []).map((o) => (typeof o === 'string' ? o : o.name) || '');
  const optVal = (re) => { const i = optNames.findIndex((n) => re.test(n.toLowerCase())); return i >= 0 ? variant[`option${i + 1}`] || null : null; };
  const images = [];
  if (variant.featured_image && variant.featured_image.src) images.push(variant.featured_image.src);
  for (const img of p.images || []) images.push(typeof img === 'string' ? img : img && img.src);
  return {
    source: 'shopify',
    title: p.title,
    brand: p.vendor || null,
    type: p.type || p.product_type || '',
    tags: Array.isArray(p.tags) ? p.tags.join(' ') : String(p.tags || ''),
    colour: optVal(/colou?r|shade|lens/),
    size: optVal(/size/),
    price: typeof variant.price === 'number' ? variant.price / 100 : (variant.price ? Number(variant.price) : null),
    currency: null, // Shopify's product JSON has no currency; read from the page below
    sku: variant.sku || null,
    barcode: variant.barcode || null,
    description: htmlToText(p.description || p.body_html || ''),
    images: images.map((u) => absUrl(u, pageUrl)).filter(Boolean),
  };
}

/* ---------------- source 2: JSON-LD / meta tags ---------------- */
function findProductLd(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findProductLd(n); if (r) return r; } return null; }
  const t = node['@type'];
  if (t === 'Product' || (Array.isArray(t) && t.includes('Product')) || t === 'ProductGroup') return node;
  return findProductLd(node['@graph'] || null);
}

function metaContent(html, key) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key.replace(/[:.]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : null;
}

/** schema.org microdata: <meta itemprop="sku" content="..."> or <span itemprop="name">...</span>. */
function itemprop(html, name) {
  const re = new RegExp(`itemprop=["']${name}["'][^>]*?(?:content=["']([^"']*)["'][^>]*>|>([^<]*)<)`, 'i');
  const m = html.match(re);
  const v = m ? decodeEntities(m[1] ?? m[2] ?? '').trim() : '';
  return v || null;
}

function microdataBrand(html) {
  const i = html.search(/itemprop=["']brand["']/i);
  if (i < 0) return null;
  const chunk = html.slice(i, i + 600);
  const own = chunk.match(/^itemprop=["']brand["'][^>]*?content=["']([^"']*)["']/i);
  if (own) return decodeEntities(own[1]).trim() || null;
  const inner = chunk.match(/itemprop=["']name["'][^>]*?(?:content=["']([^"']*)["']|>([^<]*)<)/i);
  return inner ? decodeEntities(inner[1] ?? inner[2] ?? '').trim() || null : null;
}

/** "Specifications" tables: Magento's <td data-th="Frame Color">Gunmetal</td>
 *  and plain <th>Frame Color</th><td>Gunmetal</td> rows. Keys are lowercased. */
function specTable(html) {
  const out = {};
  const lines = [];
  const put = (k, v) => {
    const label = decodeEntities(htmlToText(k)).replace(/[:\s]+$/, '').replace(/\s+/g, ' ').trim();
    k = label.toLowerCase();
    v = htmlToText(v).replace(/\s+/g, ' ').trim();
    if (k && k.length <= 40 && v && v.length < 120 && !(k in out)) { out[k] = v; lines.push(`${label}: ${v}`); }
  };
  for (const m of html.matchAll(/data-th=["']([^"']{1,60})["'][^>]*>([\s\S]{0,300}?)<\/td>/gi)) put(m[1], m[2]);
  for (const m of html.matchAll(/<th[^>]*>([\s\S]{1,80}?)<\/th>\s*<td[^>]*>([\s\S]{0,300}?)<\/td>/gi)) put(m[1], m[2]);
  // "<li><strong>Shape</strong> Pilot</li>" style spec lists
  for (const m of html.matchAll(/<li[^>]*>\s*<(?:strong|b)[^>]*>([^<]{1,40})<\/(?:strong|b)>([^<]{1,120})<\/li>/gi)) put(m[1], m[2]);
  Object.defineProperty(out, 'lines', { value: lines });
  return out;
}
const specGet = (spec, re) => { for (const k of Object.keys(spec)) if (re.test(k)) return spec[k]; return null; };

/** Magento product gallery JSON ("full" image URLs, JSON-escaped). */
function galleryImages(html) {
  const urls = [];
  for (const m of html.matchAll(/"full"\s*:\s*"(https?:[^"]+?\.(?:jpe?g|png|webp|avif)[^"]*)"/gi)) urls.push(m[1].replace(/\\\//g, '/'));
  return urls;
}

/** Magento size swatch labels like "59-L" -> "59" (only when there is one size). */
function swatchSize(html) {
  const i = html.indexOf('jsonSwatchConfig');
  if (i < 0) return null;
  const labels = new Set();
  for (const m of html.slice(i, i + 20000).matchAll(/"label"\s*:\s*"(\d{2})(?:-[A-Z]{1,3})?"/g)) labels.add(m[1]);
  return labels.size === 1 ? [...labels][0] : null;
}

function fromHtml(html, pageUrl) {
  let ld = null;
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { ld = findProductLd(JSON.parse(m[1].trim())); } catch (_) { ld = null; }
    if (ld) break;
  }
  if (ld && ld['@type'] === 'ProductGroup' && Array.isArray(ld.hasVariant) && ld.hasVariant[0]) ld = { ...ld.hasVariant[0], ...ld, offers: ld.offers || ld.hasVariant[0].offers };
  const offers = ld && (Array.isArray(ld.offers) ? ld.offers[0] : ld.offers);
  const ldImages = ld ? [].concat(ld.image || []).map((i) => (typeof i === 'string' ? i : i && (i.url || i.contentUrl))) : [];
  const brand = ld && (typeof ld.brand === 'string' ? ld.brand : ld.brand && ld.brand.name);
  const priceRaw = (offers && (offers.price ?? offers.lowPrice)) ?? metaContent(html, 'product:price:amount') ?? metaContent(html, 'og:price:amount');
  const title = (ld && ld.name) || metaContent(html, 'og:title') || itemprop(html, 'name') || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  const spec = specTable(html);
  return {
    source: ld ? 'jsonld' : 'meta',
    descIsSpec: !htmlToText((ld && ld.description) || metaContent(html, 'og:description') || metaContent(html, 'description') || ''),
    title: decodeEntities(title).trim(),
    brand: brand || metaContent(html, 'product:brand') || metaContent(html, 'og:brand') || microdataBrand(html) || specGet(spec, /^brand$/) || null,
    type: (ld && (ld.category || '')) || '',
    tags: '',
    colour: (ld && ld.color) || metaContent(html, 'product:color') || specGet(spec, /^(frame )?colou?r$/) || null,
    material: (ld && ld.material) || specGet(spec, /^(frame )?material$/) || null,
    gender: specGet(spec, /^gender$/),
    shape: specGet(spec, /shape/),
    size: specGet(spec, /^(frame |eye |lens )?(size|width)$/) || swatchSize(html),
    price: priceRaw !== null && priceRaw !== undefined && priceRaw !== '' ? Number(String(priceRaw).replace(/[^\d.]/g, '')) : null,
    currency: (offers && offers.priceCurrency) || metaContent(html, 'product:price:currency') || metaContent(html, 'og:price:currency') || null,
    sku: (ld && ld.sku) || itemprop(html, 'sku') || null,
    barcode: (ld && (ld.gtin13 || ld.gtin12 || ld.gtin14 || ld.gtin8 || ld.gtin)) || null,
    description: htmlToText((ld && ld.description) || metaContent(html, 'og:description') || metaContent(html, 'description') || '') || spec.lines.join('\n'),
    images: [...galleryImages(html), ...ldImages, metaContent(html, 'og:image'), itemprop(html, 'image')].map((u) => absUrl(u, pageUrl)).filter(Boolean),
  };
}

/* ---------------- source 3: Fynd storefronts (window.APP_DATA) ---------------- */
/** Return the JSON object literal that starts at html[start] ('{'), or null. */
function sliceJsonObject(html, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  return null;
}

function fromFynd(html, pageUrl) {
  const at = html.search(/window\.APP_DATA\s*=\s*\{/);
  if (at < 0) return null;
  const raw = sliceJsonObject(html, html.indexOf('{', at));
  let product;
  // It's a JS literal, not strict JSON: turn bare `undefined` values into null.
  try { product = JSON.parse(String(raw).replace(/([:,[])undefined(?=[,}\]])/g, '$1null')).reduxData.product; } catch (_) { return null; }
  const pd = product && product.product_details;
  if (!pd || !pd.name) return null;
  const a = pd.attributes || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
  const sizeInfo = pd.sizes || product.product_meta || product.product_sizes || {};
  const sd = (sizeInfo.size_details || [])[0] || {};
  const priceObj = sizeInfo.price && (sizeInfo.price.effective || sizeInfo.price.marked);
  return {
    source: 'fynd',
    title: pd.name,
    brand: (pd.brand && pd.brand.name) || a.brand_name || a.brand || null,
    type: [].concat(a.l3_category_names || []).join(' '),
    tags: a.short_description || '',
    shortCode: a.short_description || '',
    colour: a.frame_colour || a.primary_color || pd.color || null,
    material: a.frame_material || null,
    gender: first(a.gender),
    shape: a['frame-shape'] || a.frame_shape || null,
    frameType: a.frame_type || null,
    size: first(a.sizes) || sd.value || null,
    price: priceObj ? Number(priceObj.min ?? priceObj.max) : (a.min_price_effective ? Number(a.min_price_effective) : null),
    currency: (priceObj && priceObj.currency_code) || null,
    sku: pd.item_code || a.item_code || null,
    barcode: first(sd.seller_identifiers),
    description: htmlToText(a.product_details || pd.description || ''),
    images: (pd.media || []).filter((m) => !m.type || m.type === 'image').map((m) => absUrl(m.url, pageUrl)).filter(Boolean),
  };
}

/* ---------------- main ---------------- */
/** Read a product link. Resolves to the fields for the Frame form, or throws
 *  ImportError with a message that can be shown to the staff member. */
/** All page-HTML readers combined (JSON-LD / meta / microdata / spec tables,
 *  then Fynd's APP_DATA on top). */
function parsePage(html, pageUrl) {
  let page = fromHtml(html, pageUrl);
  // Fynd storefronts keep the real product data in window.APP_DATA; it wins
  // over the page's thin meta tags (which carry the site logo, not photos).
  const fynd = fromFynd(html, pageUrl);
  if (fynd) page = { ...page, ...Object.fromEntries(Object.entries(fynd).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length))), descIsSpec: false };
  return page;
}

async function importProduct(rawUrl) {
  let pageUrl;
  try { pageUrl = new URL(String(rawUrl || '').trim()); } catch (_) { throw new ImportError('Paste the full product link, starting with https://'); }

  let shop = await fromShopify(pageUrl);
  let page = null;
  try {
    const res = await safeFetch(pageUrl.href, { accept: 'text/html,application/xhtml+xml' });
    page = parsePage(res.buf.toString('utf8'), new URL(res.url));
  } catch (e) {
    if (!shop) throw e;
  }
  return finalize(shop, page, pageUrl);
}

/** Same as importProduct, but for page source the staff member copied from
 *  their own browser (Ctrl+U) - for sites that block automated requests.
 *  rawUrl is optional; without it the page's canonical / og:url is used. */
function importFromHtml(html, rawUrl) {
  html = String(html || '');
  if (html.length < 200 || !/<(html|head|meta|script)\b/i.test(html)) throw new ImportError('That does not look like page source. Open the product page, press Ctrl+U, then Ctrl+A and Ctrl+C, and paste here.');
  let pageUrl = null;
  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1];
  const candidates = [rawUrl, canonical, metaContent(html, 'og:url')];
  let homeUrl = null;
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(decodeEntities(String(c)).trim());
      if (!/^https?:$/.test(u.protocol)) continue;
      // Some sites put the home page in og:url - only use it as a last resort.
      if (u.pathname === '/' && !u.search) { homeUrl = homeUrl || u; continue; }
      pageUrl = u; break;
    } catch (_) { /* try next */ }
  }
  if (!pageUrl && homeUrl) pageUrl = homeUrl;
  if (!pageUrl) pageUrl = new URL('https://unknown.invalid/');
  const p = finalize(null, parsePage(html, pageUrl), pageUrl);
  p.source = `paste:${p.source}`;
  p.images = p.images.filter((u) => !u.includes('unknown.invalid')); // relative paths we cannot resolve
  if (pageUrl.hostname === 'unknown.invalid' || pageUrl === homeUrl) p.source_url = null;
  return p;
}

function finalize(shop, page, pageUrl) {
  if (!shop && !page) throw new ImportError('No product details were found on that page.');
  // Shopify data wins; the page fills what it lacks (e.g. currency).
  const d = shop ? { ...page, ...Object.fromEntries(Object.entries(shop).filter(([, v]) => v !== null && v !== '')) } : page;
  if (shop && page && page.currency) d.currency = page.currency;
  if (!d.title) throw new ImportError('No product details were found on that page.');

  const text = `${d.title} ${d.type} ${d.tags} ${d.shape || ''} ${d.gender || ''} ${d.description} ${pageUrl.pathname.replace(/[-_/]/g, ' ')}`.toLowerCase();
  // "Guess Global" -> "Guess"; "... Sunglasses - Guess Global" -> "... Sunglasses".
  if (d.brand) {
    const fullBrand = String(d.brand).trim();
    d.title = d.title.replace(new RegExp(`\\s*[-|–]\\s*${fullBrand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
    d.brand = fullBrand.replace(/\s+(global|india|official|store|eyewear india)$/i, '').trim() || fullBrand;
  }
  let { model, model_name } = splitModel(d.title, d.brand);
  // Fynd "short_description" like "GUESS WOMEN S00246 81B 53 SUNGLASSES" holds the model code.
  if (!model && d.shortCode) model = splitModel(String(d.shortCode).replace(new RegExp(`^\\s*${String(d.brand || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').replace(/^(wo)?men\s+|^unisex\s+|^kids\s+/i, ''), '').model;
  // Luxottica-style SKUs (Ray-Ban, Oakley, Vogue...): "0RB37910042Q" -> model "RB3791".
  const skuModel = d.sku && String(d.sku).trim().match(/^0?([A-Z]{2,3}\d{4}[A-Z]?)(?=\d{3}|$)/i);
  if (!model && skuModel) model = skuModel[1].toUpperCase();
  // Same photo at different sizes (e.g. Magento /cache/<hash>/ copies) counts once.
  const seen = new Set();
  const images = d.images.filter((u) => {
    const key = u.replace(/\/cache\/[0-9a-f]{16,}\//i, '/').replace(/[?#].*$/, '');
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, MAX_IMAGES);
  const brand = d.brand ? String(d.brand).trim() : null;
  const description = d.description ? d.description.slice(0, 1500) : '';
  // Only treat the price as rupees when the page says INR, or (currency not
  // given) the shop is on a .in domain - a USD/EUR price must not be copied
  // into the form as if it were rupees.
  const isInr = d.currency ? /^(inr|rs\.?|₹)$/i.test(String(d.currency).trim()) : /\.in$/i.test(pageUrl.hostname);
  const price = d.price && Number.isFinite(d.price) && d.price > 0 ? Math.round(d.price * 100) / 100 : null;
  const seoBase = [brand, model || model_name, d.colour].filter(Boolean).join(' ');
  const material = (d.material && String(d.material).trim()) || firstMatch(MATERIALS, text);
  // A value the page states outright beats guessing from free text (a site
  // slogan like "for Her and Him" must not turn a Women's frame into Unisex).
  const gender = (d.gender && guessGender(String(d.gender).toLowerCase())) || guessGender(text);
  const frameShape = (d.shape && firstMatch(SHAPES, String(d.shape).toLowerCase())) || firstMatch(SHAPES, text);
  const frameType = (d.frameType && firstMatch(FRAME_TYPES, String(d.frameType).toLowerCase())) || firstMatch(FRAME_TYPES, text);
  const category = guessCategory(text);
  // When the page had no real description (only a spec list), write a short
  // readable SEO line instead of cutting the spec list at 160 characters.
  const specMeta = () => {
    const extra = [material && `${material} frame`, gender].filter(Boolean).join(', ');
    return ([seoBase, category].filter(Boolean).join(' ') + (extra ? ` - ${extra}.` : '')).slice(0, 160) || null;
  };

  return {
    source: d.source,
    source_url: pageUrl.href,
    title: d.title,
    brand,
    model,
    model_name,
    colour: d.colour ? String(d.colour).trim() : null,
    size: d.size ? String(d.size).trim() : null,
    material,
    frame_shape: frameShape,
    frame_type: frameType,
    gender,
    category,
    price,
    currency: d.currency || null,
    price_is_inr: isInr,
    sku: d.sku ? String(d.sku).trim() : null,
    barcode: d.barcode ? String(d.barcode).trim() : null,
    description,
    meta_title: seoBase.slice(0, 70) || null,
    meta_description: (d.descIsSpec && !shop)
      ? specMeta()
      : (description ? description.replace(/\s+/g, ' ').slice(0, 160) : null),
    slug: slugify(seoBase) || null,
    images,
  };
}

module.exports = { importProduct, importFromHtml, safeFetch, ImportError, isPrivateIP };
