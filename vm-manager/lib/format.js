'use strict';

// Port de apps/web/src/lib/format.ts; `now` é explícito onde a web usa Date.now().

const pt = (n, opts) => n.toLocaleString('pt-BR', opts);
const pad = (n) => String(n).padStart(2, '0');

function uptime(seconds) {
  if (!seconds) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function gib(mib) {
  if (mib == null) return null;
  return `${pt(Math.round((mib / 1024) * 10) / 10)} GB`;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

function bytes(n) {
  if (n == null) return '';
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${pt(value, { maximumFractionDigits: digits })} ${UNITS[unit]}`;
}

function date(iso) {
  return iso ? new Date(iso).toLocaleDateString('pt-BR') : '';
}

const RELATIVE = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

function relative(iso, now) {
  if (!iso) return 'nunca';
  const minutes = Math.round((new Date(iso).getTime() - now) / 60000);
  if (Math.abs(minutes) < 5) return 'agora';
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, 'hour');
  return RELATIVE.format(Math.round(hours / 24), 'day');
}

// dd/mm/yyyy hh:mm:ss (sem a vírgula que o ICU novo põe entre data e hora)
function datetime(iso) {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function meterTone(pct) {
  if (pct >= 90) return 'red';
  if (pct >= 75) return 'yellow';
  return 'green';
}

function meterWidth(pct) {
  return Math.min(100, Math.max(2, pct));
}

const TAG_TONES = ['accent', 'green', 'yellow', 'red', 'dim'];

function tagTone(tag) {
  let hash = 0;
  for (const ch of tag) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_TONES[hash % TAG_TONES.length];
}

module.exports = { uptime, gib, bytes, date, relative, datetime, meterTone, meterWidth, tagTone };
