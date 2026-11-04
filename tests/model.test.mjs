import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, validDate, validTime, localDate, parseDate, addDays, daysBetween,
  monthDays, projectItems, dayItems, progress, createExamples, validateSnapshot,
  mergeSnapshots, persist, removeExamples,
} from '../src/model.js';

const example = () => createExamples('2026-11-04');

test('日期校验拒绝不存在的日期，保留闰日和跨年安排', () => {
  assert.equal(validDate('2024-02-29'), true);
  for (const bad of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-00', '2026-1-01', '1899-12-31', '2101-01-01', null]) {
    assert.equal(validDate(bad), false, String(bad));
  }
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(localDate(parseDate('2026-11-04')), '2026-11-04');
  assert.equal(daysBetween('2026-12-31', '2027-01-02'), 2);
});

test('月历以周一开始，完整覆盖闰年、六周月与跨年边界', () => {
  const november = monthDays(2026, 10);
  assert.equal(november.length, 42);
  assert.equal(november[0], '2026-10-26');
  assert.equal(november.at(-1), '2026-12-06');
  assert.equal(parseDate(november[0]).getDay(), 1);
  assert.ok(monthDays(2024, 1).includes('2024-02-29'));
  assert.equal(new Set(november).size, november.length);
  assert.ok(monthDays(2026, 11).some((date) => date.startsWith('2027-01')));
});

test('时间只接受当天的有效时分', () => {
  for (const time of ['00:00', '09:30', '23:59']) assert.equal(validTime(time), true);
  for (const time of ['24:00', '09:60', '9:00', 'abc', null]) assert.equal(validTime(time), false);
});

test('同一条任务同时驱动项目进度与当天安排，修改日期不会留下副本', () => {
  const data = example();
  const item = data.items.find((item) => item.id === 'demo-design');
  assert.strictEqual(projectItems(data, 'demo-project').find((i) => i.id === item.id), dayItems(data, '2026-11-04').find((i) => i.id === item.id));
  item.completed = true;
  assert.equal(progress(projectItems(data, 'demo-project')).completed, 2);
  assert.equal(dayItems(data, '2026-11-04').find((i) => i.id === item.id).completed, true);
  item.date = '2026-11-08'; item.start = '08:00'; item.end = '09:00';
  assert.equal(dayItems(data, '2026-11-04').some((i) => i.id === item.id), false);
  assert.equal(dayItems(data, '2026-11-08').filter((i) => i.id === item.id).length, 1);
  data.items = data.items.filter((i) => i.id !== item.id);
  assert.equal(projectItems(data, 'demo-project').some((i) => i.id === item.id), false);
  assert.equal(dayItems(data, '2026-11-08').length, 0);
});

test('允许未安排时间的项目任务；独立日程必须有完整日期和时间', () => {
  const data = example();
  assert.doesNotThrow(() => validateSnapshot(data));
  const item = data.items.find((i) => i.id === 'demo-writing');
  item.projectId = null;
  assert.throws(() => validateSnapshot(data), /独立日程/);
  item.date = '2026-11-04'; item.start = '10:00'; item.end = '09:00';
  assert.throws(() => validateSnapshot(data), /结束时间/);
  item.end = '10:00';
  assert.throws(() => validateSnapshot(data), /结束时间/);
  item.end = '11:00';
  assert.doesNotThrow(() => validateSnapshot(data));
});

test('备份校验拒绝损坏的关联、重复编号、未知版本和过长内容', () => {
  const cases = [
    [(d) => { d.version = 2; }, /版本/],
    [(d) => { d.items[0].projectId = 'missing'; }, /项目不存在/],
    [(d) => { d.items.push(d.items[0]); }, /重复的任务/],
    [(d) => { d.projects.push(d.projects[0]); }, /重复的项目/],
    [(d) => { d.items[0].completed = 'true'; }, /完成状态/],
    [(d) => { d.projects[0].name = ' '; }, /项目名称/],
    [(d) => { d.items[0].title = 'a'.repeat(121); }, /日程名称/],
    [(d) => { d.projects[0].deadline = '2026-02-30'; }, /截止日期/],
    [(d) => { d.items[0].id = '<script>'; }, /编号/],
  ];
  for (const [mutate, expected] of cases) {
    const data = example(); mutate(data);
    assert.throws(() => validateSnapshot(data), expected);
  }
});

test('合并备份保留其他计划，同编号更新且不会重复导入', () => {
  const current = example();
  const incoming = example();
  incoming.items[0].completed = false;
  incoming.projects[0].archived = true;
  current.items.push({ ...current.items[0], id: 'user-item', isDemo: false });
  const merged = mergeSnapshots(current, incoming);
  assert.equal(merged.items.length, 10);
  assert.equal(merged.items.find((i) => i.id === 'user-item').id, 'user-item');
  assert.equal(merged.items[0].completed, false);
  assert.equal(merged.projects[0].archived, true);
  assert.deepEqual(mergeSnapshots(merged, incoming), merged);
});

test('存储失败或数据不合法时，不会覆盖旧数据', () => {
  let saved = 'original';
  const storage = { setItem: (key, value) => { assert.equal(key, STORAGE_KEY); saved = value; } };
  const invalid = example(); invalid.items[0].end = '00:00';
  assert.throws(() => persist(storage, invalid));
  assert.equal(saved, 'original');
  const failingStorage = { setItem() { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; } };
  assert.throws(() => persist(failingStorage, example()), /full/);
  assert.equal(saved, 'original');
  persist(storage, example());
  assert.deepEqual(validateSnapshot(JSON.parse(saved)), example());
});

test('清除示例保留自己编辑的任务及其关联项目', () => {
  const data = example();
  data.items[0].isDemo = false;
  data.projects[1].isDemo = false;
  const clean = removeExamples(data);
  assert.equal(clean.items.length, 1);
  assert.equal(clean.items[0].id, 'demo-vocabulary');
  assert.deepEqual(clean.projects.map((p) => p.id), ['demo-cet6', 'demo-project']);
  assert.deepEqual(removeExamples(clean), clean);
});

test('导入只接纳已知字段，并保持未安排任务的有效状态', () => {
  const data = example();
  data.projects[0].injected = 'ignored';
  data.items[0].unknown = { arbitrary: true };
  data.extra = 'ignored';
  const clean = validateSnapshot(JSON.parse(JSON.stringify(data)));
  assert.equal('extra' in clean, false);
  assert.equal('injected' in clean.projects[0], false);
  assert.equal('unknown' in clean.items[0], false);
  assert.equal(progress([]).percent, 0);
  assert.deepEqual(dayItems(clean, '2026-11-04').map((i) => i.start), ['08:30', '10:00', '16:00', '21:00']);
});
