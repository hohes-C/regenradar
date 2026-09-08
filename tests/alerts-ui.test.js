import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hhmm } from '../src/text.js';
import { levelLabel } from '../src/alerts.js';

class Element {
  children = [];
  textContent = '';
  attributes = {};
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
  get text() { return this.textContent + this.children.map(c => typeof c === 'string' ? c : c.text).join(' '); }
}
function render(state, groups = []) {
  const elements = new Map(['alerts-scroll', 'alerts-place'].map(id => [id, new Element()]));
  const context = vm.createContext({
    hhmm, levelLabel,
    document: {
      getElementById: id => elements.get(id),
      createElement: () => new Element(),
      createTextNode: text => text,
    },
  });
  const source = readFileSync(new URL('../src/ui.js', import.meta.url), 'utf8')
    .replace(/^import\s[^\n]+\n/gm, '')
    .replaceAll('export function ', 'function ')
    .replace(/^export \{[^\n]+\n/gm, '');
  vm.runInContext(source, context);
  context.renderAlerts({ state, alerts: { groups, fetchedAt: new Date(), count: groups.length } });
  return elements.get('alerts-scroll');
}

for (const state of ['error', 'offline']) {
  test(`${state}: alte leere Warnungsliste zeigt keine Entwarnung`, () => {
    const box = render(state);
    assert.match(box.text, /Warnstatus unbekannt/);
    assert.match(box.text, /möglicherweise veraltet/);
    assert.doesNotMatch(box.text, /Entwarnung/);
    assert.ok(box.children.some(c => c.attributes?.role === 'alert'));
  });
}
test('alte Warnungen bleiben mit deutlichem Fehlerhinweis lesbar', () => {
  const box = render('error', [{ event: 'STURM', level: 3, alerts: [{ level: 3, description: 'Schwere Sturmböen' }] }]);
  assert.match(box.text, /Schwere Sturmböen/);
  assert.match(box.text, /Aktualisierung fehlgeschlagen/);
});
test('erfolgreicher leerer Abruf darf Entwarnung anzeigen', () => {
  const box = render('ok');
  assert.match(box.text, /Entwarnung/);
  assert.doesNotMatch(box.text, /veraltet|unbekannt/);
});
