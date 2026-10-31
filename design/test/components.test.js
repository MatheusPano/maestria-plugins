'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const components = require('../lib/components');

const comps = (o) => new Map(Object.entries(o));

test('expands params, closing tag form', () => {
  const c = comps({ NavItem: '<a class="{{active}}">{{label}}</a>' });
  const r = components.expand('<x-nav-item label="Conversas" active="true"></x-nav-item>', c);
  assert.strictEqual(r.html, '<a class="true">Conversas</a>');
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual([...r.uses], ['NavItem']);
});

test('self-closing, single quotes, boolean attr, missing param', () => {
  const c = comps({ NavItem: '<a class="{{active}}">{{label}}|{{none}}</a>' });
  assert.strictEqual(components.expand("<x-nav-item label='A' active />", c).html, '<a class="true">A|</a>');
  assert.strictEqual(components.expand('<x-nav-item label="B"/>', c).html, '<a class="">B|</a>');
});

test('escapes params, raw with triple braces', () => {
  const c = comps({ T: '<i>{{v}}</i><u>{{{v}}}</u>' });
  const r = components.expand('<x-t v="<b>"></x-t>', c);
  assert.strictEqual(r.html, '<i>&lt;b&gt;</i><u><b></u>');
});

test('slot receives children', () => {
  const c = comps({ Card: '<div class="card"><slot></slot></div>' });
  const r = components.expand('<x-card><p>oi</p></x-card>', c);
  assert.strictEqual(r.html, '<div class="card"><p>oi</p></div>');
});

test('nested usage reports uses and leaves no x- tags', () => {
  const c = comps({
    Sidebar: '<nav><slot></slot><x-nav-item label="Fixo"></x-nav-item></nav>',
    NavItem: '<a>{{label}}</a>',
  });
  const r = components.expand('<x-sidebar><x-nav-item label="A"/></x-sidebar>', c);
  assert.strictEqual(r.html, '<nav><a>A</a><a>Fixo</a></nav>');
  assert.deepStrictEqual(r.uses, new Set(['Sidebar', 'NavItem']));
  assert.ok(!/<\/?x-/.test(r.html));
});

test('same component nested inside itself in children', () => {
  const c = comps({ Box: '<div><slot></slot></div>' });
  const r = components.expand('<x-box>a<x-box>b</x-box>c</x-box>', c);
  assert.strictEqual(r.html, '<div>a<div>b</div>c</div>');
});

test('unknown component errors', () => {
  const r = components.expand('<x-foo>k</x-foo>', comps({}));
  assert.deepStrictEqual(r.errors, ['componente não existe: Foo']);
  assert.ok(!/<\/?x-/.test(r.html));
});

test('cycle detected', () => {
  const c = comps({ A: '<x-b></x-b>', B: '<x-a></x-a>' });
  const r = components.expand('<x-a></x-a>', c);
  assert.ok(r.errors.includes('componente em ciclo: A → B → A'), r.errors.join('|'));
  assert.ok(!/<\/?x-/.test(r.html));
});

test('dependents', () => {
  const boards = new Map([
    ['b1', new Set(['Sidebar', 'NavItem'])],
    ['b2', new Set(['Card'])],
  ]);
  assert.deepStrictEqual(components.dependents(boards, 'NavItem'), new Set(['b1']));
  assert.deepStrictEqual(components.dependents(boards, 'X'), new Set());
});

test('load reads valid names, reports invalid', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-'));
  try {
    fs.mkdirSync(path.join(d, 'components'));
    fs.writeFileSync(path.join(d, 'components', 'Card.html'), '<b/>');
    fs.writeFileSync(path.join(d, 'components', 'bad name.html'), 'x');
    fs.writeFileSync(path.join(d, 'components', 'nota.txt'), 'x');
    const m = components.load(d);
    assert.deepStrictEqual([...m.keys()], ['Card']);
    assert.strictEqual(m.errors.length, 1);
    assert.deepStrictEqual([...components.load(path.join(d, 'nope')).keys()], []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

const malformed = (name, input, re) => test('malformed: ' + name, () => {
  const c = comps({ Card: '<div><slot></slot></div>' });
  const r = components.expand(input, c);
  assert.ok(r.errors.some((e) => re.test(e)), r.errors.join('|'));
  assert.ok(!/<x-|<\/x-/.test(r.html), r.html);
});
malformed('unclosed', '<x-card>abc', /não fechada/);
malformed('stray close', 'a</x-card>b', /sem abertura/);
malformed('unterminated quote', '<x-card class="oops>x', /inválida/);
malformed('unterminated open', '<x-card', /inválida/);
malformed('bare', 'a<x-b', /inválida/);
malformed('bare dash gt', 'a<x->b', /inválida/);
test('unclosed keeps children', () => {
  const r = components.expand('<x-card>abc', comps({ Card: '<div><slot></slot></div>' }));
  assert.strictEqual(r.html, '<div>abc</div>');
});
