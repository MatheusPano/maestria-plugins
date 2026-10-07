'use strict';

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => (Array.isArray(v) ? !v.length : isMap(v) ? !Object.keys(v).length : false);

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[]';
  if (isMap(v)) return '{}';
  if (typeof v !== 'string') return String(v);
  if (v === '' || /^\s|\s$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|on|off|~)$|^[-+.\d]/i.test(v) || v.includes('\n')) {
    return JSON.stringify(v);
  }
  return v;
}

function lines(v, ind) {
  const out = [];
  if (Array.isArray(v)) {
    for (const item of v) {
      if ((isMap(item) || Array.isArray(item)) && !isEmpty(item)) {
        const sub = lines(item, ind + '  ');
        sub[0] = `${ind}- ${sub[0].slice(ind.length + 2)}`;
        out.push(...sub);
      } else out.push(`${ind}- ${scalar(item)}`);
    }
    return out;
  }
  for (const [k, val] of Object.entries(v)) {
    const key = scalar(k);
    if ((isMap(val) || Array.isArray(val)) && !isEmpty(val)) {
      out.push(`${ind}${key}:`);
      out.push(...lines(val, ind + '  '));
    } else if (typeof val === 'string' && val.includes('\n')) {
      out.push(`${ind}${key}: |`);
      for (const l of val.replace(/\n$/, '').split('\n')) out.push(`${ind}  ${l}`);
    } else out.push(`${ind}${key}: ${scalar(val)}`);
  }
  return out;
}

function dump(v) {
  return isMap(v) || Array.isArray(v) ? lines(v, '').join('\n') : scalar(v);
}

module.exports = { dump };
