'use strict';
/** Small helpers that reproduce Python semantics the original code relied on. */

function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === 'object') {
    if (typeof v.val === 'string' && v.constructor && v.constructor.name === 'SafeString') return v.val.length > 0;
    if (v instanceof String) return v.length > 0;
    if (v.constructor && v.constructor.name === 'MultiDict') return v.keys().length > 0;
    if (v.constructor === Object || Object.getPrototypeOf(v) === null) return Object.keys(v).length > 0;
    return true;
  }
  return true;
}

/** Python 3 round() - banker's rounding at .5 (as far as binary floats allow). */
function round(x, n = 0) {
  x = Number(x);
  if (!Number.isFinite(x)) return x;
  const m = Math.pow(10, n);
  const y = x * m;
  const r = Math.round(y);
  let out;
  if (Math.abs(y % 1) === 0.5) out = (r % 2 === 0 ? r : r - 1) / m; // round half to even
  else out = Math.round(Number((y).toPrecision(15))) / m;
  return n === 0 ? out : Number(out.toFixed(n));
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

/** Python-style strftime for a JS Date (local time). */
function strftime(d, fmt) {
  return fmt.replace(/%([-#]?)([a-zA-Z%])/g, (_m, flag, c) => {
    const np = flag === '-' || flag === '#';
    const p = (v, w = 2) => (np ? String(v) : pad(v, w));
    switch (c) {
      case 'Y': return String(d.getFullYear());
      case 'y': return pad(d.getFullYear() % 100);
      case 'm': return p(d.getMonth() + 1);
      case 'd': return p(d.getDate());
      case 'H': return p(d.getHours());
      case 'I': return p(((d.getHours() + 11) % 12) + 1);
      case 'M': return p(d.getMinutes());
      case 'S': return p(d.getSeconds());
      case 'f': return pad(d.getMilliseconds() * 1000, 6);
      case 'p': return d.getHours() < 12 ? 'AM' : 'PM';
      case 'b': return MONTHS[d.getMonth()].slice(0, 3);
      case 'B': return MONTHS[d.getMonth()];
      case 'a': return DAYS[d.getDay()].slice(0, 3);
      case 'A': return DAYS[d.getDay()];
      case 'j': {
        const start = new Date(d.getFullYear(), 0, 1);
        return pad(Math.floor((d - start) / 86400000) + 1, 3);
      }
      case '%': return '%';
      default: return '%' + c;
    }
  });
}

/** Parse "YYYY-MM-DD" or "YYYY-MM-DD HH:MM[:SS]" / ISO "T" form as LOCAL time
 *  (Python's naive datetime). Returns null if unparseable. */
function parseDate(s) {
  if (s instanceof Date) return new Date(s.getTime());
  if (s === null || s === undefined) return null;
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0),
    m[7] ? Math.floor(+('0.' + m[7]) * 1000) : 0);
  if (d.getMonth() !== +m[2] - 1) return null; // e.g. 2024-02-31
  return d;
}

/** Strict parse matching datetime.strptime(s, "%Y-%m-%d") - throws on bad input. */
function strptimeDate(s) {
  const t = String(s == null ? '' : s).trim();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(t)) throw new Error(`time data '${s}' does not match format '%Y-%m-%d'`);
  const [y, mo, da] = t.split('-').map(Number);
  const d = new Date(y, mo - 1, da);
  if (d.getMonth() !== mo - 1 || d.getDate() !== da) throw new Error(`invalid date '${s}'`);
  return d;
}

function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoDateTime(d, sep = ' ') {
  return `${isoDate(d)}${sep}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function todayIso() { return isoDate(new Date()); }
function nowStr() { return isoDateTime(new Date()); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function addSeconds(d, n) { return new Date(d.getTime() + n * 1000); }
function daysBetween(a, b) {
  // (a - b).days for date objects
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ua - ub) / 86400000);
}

/**
 * Python %-formatting: supports %s %d %i %f %.Nf %e %g %x %o %r %% plus
 * flags/width (e.g. "%05.2f", "%-10s", "%,d" is not Python but ignored).
 */
function percentFormat(fmt, args) {
  if (!Array.isArray(args)) args = [args];
  let i = 0;
  return String(fmt).replace(/%(\(\w+\))?([-+ 0#]*)(\d+|\*)?(?:\.(\d+))?([sdifeEgGxXorc%])/g,
    (_m, key, flags, width, prec, conv) => {
      if (conv === '%') return '%';
      let v;
      if (key) v = (args[0] || {})[key.slice(1, -1)];
      else v = args[i++];
      let s;
      switch (conv) {
        case 'd': case 'i': {
          const n = Math.trunc(Number(v));
          s = String(Math.abs(n));
          if (n < 0) s = '-' + s; else if (flags.includes('+')) s = '+' + s;
          break;
        }
        case 'f': {
          const n = Number(v);
          s = round(Math.abs(n), prec === undefined ? 6 : +prec).toFixed(prec === undefined ? 6 : +prec);
          if (n < 0 && Number(s) !== 0) s = '-' + s; else if (flags.includes('+')) s = '+' + s;
          break;
        }
        case 'e': case 'E': s = Number(v).toExponential(prec === undefined ? 6 : +prec); if (conv === 'E') s = s.toUpperCase(); break;
        case 'g': case 'G': s = String(Number(Number(v).toPrecision(prec === undefined ? 6 : (+prec || 1)))); break;
        case 'x': s = Math.trunc(Number(v)).toString(16); break;
        case 'X': s = Math.trunc(Number(v)).toString(16).toUpperCase(); break;
        case 'o': s = Math.trunc(Number(v)).toString(8); break;
        case 'c': s = typeof v === 'number' ? String.fromCharCode(v) : String(v); break;
        case 'r': s = typeof v === 'string' ? `'${v}'` : str(v); break;
        default: s = str(v); if (prec !== undefined) s = s.slice(0, +prec);
      }
      if (width) {
        const w = +width;
        if (s.length < w) {
          if (flags.includes('-')) s = s.padEnd(w);
          else if (flags.includes('0') && conv !== 's') {
            const neg = s[0] === '-' || s[0] === '+';
            s = neg ? s[0] + s.slice(1).padStart(w - 1, '0') : s.padStart(w, '0');
          } else s = s.padStart(w);
        }
      }
      return s;
    });
}

/** Python str() for printing. */
function str(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** Python str.title() */
function title(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/(^|[^a-zA-Z])([a-z])/g, (_m, a, b) => a + b.toUpperCase());
}

/** Python "{:,.2f}".format(n) */
function commaFixed(n, digits = 2) {
  const s = round(Number(n), digits).toFixed(digits);
  const [i, f] = s.split('.');
  const sign = i.startsWith('-') ? '-' : '';
  const body = (sign ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return sign + body + (f !== undefined ? '.' + f : '');
}

/** Python float(x or 0) style coercion that never throws. */
function num(v, dflt = 0) {
  if (v === null || v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isNaN(n) ? dflt : n;
}

function isdigit(s) { return /^\d+$/.test(String(s)); }

/** Python zip() - stops at the shortest input. */
function zip(...arrays) {
  const n = arrays.length ? Math.min(...arrays.map((a) => a.length)) : 0;
  const out = [];
  for (let i = 0; i < n; i++) out.push(arrays.map((a) => a[i]));
  return out;
}

module.exports = {
  truthy, round, strftime, parseDate, strptimeDate, isoDate, isoDateTime, today, todayIso, nowStr,
  addDays, addSeconds, daysBetween, percentFormat, str, title, commaFixed, num, isdigit, pad, zip,
};
