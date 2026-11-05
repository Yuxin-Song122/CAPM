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

test('旧数据不补新字段，项目和原备注内容及完整快照保持相同', () => {
  const old = example();
  old.items[0].notes = '以前录入的备注\n仍然保留在原字段';
  const original = JSON.stringify(old);
  const clean = validateSnapshot(JSON.parse(original));
  assert.equal(JSON.stringify(clean), original);
  assert.equal(JSON.stringify(old), original, '校验不能改写输入对象');
  for (const project of clean.projects) {
    for (const name of ['implementationPlan', 'implementationSettings', 'noticeText', 'location', 'deadlineTime']) assert.equal(Object.hasOwn(project, name), false);
  }
  for (const item of clean.items) {
    assert.equal(Object.hasOwn(item, 'location'), false);
    assert.equal(Object.hasOwn(item, 'planKey'), false);
  }
});

test('地点、实施计划、通知原文和精确截止时间在保存与备份往返中保留', () => {
  const data = example();
  Object.assign(data.projects[0], {
    implementationPlan: '每个工作日学习两小时，周末15:00到17:00做真题',
    noticeText: '请于2026年12月13日18:00前在教学楼301提交报名表。',
    location: '教学楼301',
    deadlineTime: '18:00',
  });
  Object.assign(data.items[0], { location: '图书馆二楼', notes: '原有笔记，不应变成地点', planKey: 'plan:demo-cet6:2026-11-04:0830' });
  data.items[1].location = '';
  const normalized = validateSnapshot(data);
  let saved;
  const persisted = persist({ setItem(key, value) { assert.equal(key, STORAGE_KEY); saved = value; } }, data);
  assert.deepEqual(persisted, normalized);
  assert.deepEqual(validateSnapshot(JSON.parse(saved)), normalized);
  assert.equal(normalized.items[0].notes, '原有笔记，不应变成地点');
  assert.equal(normalized.items[0].location, '图书馆二楼');
  assert.equal(normalized.items[1].location, '');
  assert.equal(normalized.projects[0].noticeText, data.projects[0].noticeText);
});

test('可选扩展字段拒绝非法类型、长度以及无日期的截止时间', () => {
  const cases = [
    [(d) => { d.projects[0].implementationPlan = 'x'.repeat(5001); }, /实施计划/],
    [(d) => { d.projects[0].noticeText = 'x'.repeat(10001); }, /通知原文/],
    [(d) => { d.projects[0].location = 'x'.repeat(501); }, /项目地点/],
    [(d) => { d.projects[0].implementationPlan = null; }, /实施计划/],
    [(d) => { d.projects[0].deadlineTime = '24:00'; }, /截止时间/],
    [(d) => { d.projects[0].deadlineTime = null; }, /截止时间/],
    [(d) => { d.projects[0].deadlineTime = ' '; }, /截止时间/],
    [(d) => { d.projects[0].deadline = null; d.projects[0].deadlineTime = '12:00'; }, /截止日期/],
    [(d) => { d.items[0].location = 'x'.repeat(501); }, /日程地点/],
    [(d) => { d.items[0].location = undefined; }, /日程地点/],
    [(d) => { d.items[0].planKey = 'x'.repeat(201); }, /计划日程标记/],
    [(d) => { d.items[0].planKey = false; }, /计划日程标记/],
  ];
  for (const [mutate, expected] of cases) {
    const data = example(); mutate(data);
    assert.throws(() => validateSnapshot(data), expected);
  }
  const empty = example();
  Object.assign(empty.projects[0], { deadline: null, deadlineTime: '', implementationPlan: '', noticeText: '', location: '' });
  Object.assign(empty.items[0], { location: '', planKey: '' });
  assert.doesNotThrow(() => validateSnapshot(empty));
});

test('合并及重复导入保留扩展字段和其他旧记录', () => {
  const current = example();
  const incoming = { version: 1, projects: [{ ...current.projects[0], implementationPlan: '周末做真题', deadlineTime: '18:30', location: '图书馆', noticeText: '原始通知内容' }], items: [{ ...current.items[0], location: '自习室', planKey: 'study-weekend-1', completed: false }] };
  current.items.push({ ...current.items[1], id: 'old-user-item', notes: '保留原备注', isDemo: false });
  const merged = mergeSnapshots(current, incoming);
  assert.equal(merged.projects.length, current.projects.length);
  assert.equal(merged.items.length, current.items.length);
  assert.deepEqual(merged.projects[0], incoming.projects[0]);
  assert.deepEqual(merged.items[0], incoming.items[0]);
  assert.equal(merged.items.find((item) => item.id === 'old-user-item').notes, '保留原备注');
  assert.equal(Object.hasOwn(merged.items.find((item) => item.id === 'old-user-item'), 'location'), false);
  assert.deepEqual(mergeSnapshots(merged, incoming), merged);
});

const implementationSettings = () => ({
  text: '每个工作日学习两小时，周末做真题',
  defaultStart: '19:00', startDate: '2026-11-05', endDate: '2026-12-05',
  rules: [
    { id: 'rule-1', title: '学习', days: [1, 2, 3, 4, 5], start: '19:30', end: '21:30' },
    { id: 'rule-2', title: '做真题', days: [6, 7], start: '15:00', end: '17:00' },
  ],
});

test('手调后的实施计划规则与日期范围在保存、备份及合并后保持相同', () => {
  const data = example();
  data.projects[0].implementationSettings = implementationSettings();
  let saved;
  const clean = persist({ setItem(key, value) { assert.equal(key, STORAGE_KEY); saved = value; } }, data);
  const imported = validateSnapshot(JSON.parse(saved));
  assert.deepEqual(imported, clean);
  assert.deepEqual(imported.projects[0].implementationSettings, implementationSettings());
  const merged = mergeSnapshots(example(), imported);
  assert.deepEqual(merged.projects[0].implementationSettings, implementationSettings());
  assert.equal(Object.hasOwn(merged.projects[1], 'implementationSettings'), false);

  const withExtras = structuredClone(data);
  withExtras.projects[0].implementationSettings.unrecognized = 'ignored';
  withExtras.projects[0].implementationSettings.rules[0].unrecognized = 'ignored';
  withExtras.projects[0].implementationSettings.rules[0].days.unrecognized = 'ignored';
  const allowed = validateSnapshot(withExtras).projects[0].implementationSettings;
  assert.deepEqual(allowed, implementationSettings(), '仅保留计划设置、规则及星期数组的已知字段');
  assert.notStrictEqual(allowed.rules, withExtras.projects[0].implementationSettings.rules);
  assert.notStrictEqual(allowed.rules[0].days, withExtras.projects[0].implementationSettings.rules[0].days);
});

test('实施计划设置校验星期、时段、规则数量和最多366天的生成范围', () => {
  const cases = [
    [(s) => { s.defaultStart = '24:00'; }, /默认开始时间/],
    [(s) => { s.text = 'x'.repeat(5001); }, /实施计划/],
    [(s) => { s.startDate = '2026-02-30'; }, /日期范围/],
    [(s) => { s.endDate = '2026-11-04'; }, /日期范围/],
    [(s) => { s.startDate = '2024-01-01'; s.endDate = '2025-01-01'; }, /日期范围/],
    [(s) => { s.rules = []; }, /规则/],
    [(s) => { s.rules = Array.from({ length: 51 }, () => s.rules[0]); }, /规则/],
    [(s) => { s.rules[0].id = ''; }, /规则编号/],
    [(s) => { s.rules[0].title = ' '; }, /日程名称/],
    [(s) => { s.rules[0].days = []; }, /星期/],
    [(s) => { s.rules[0].days = [0, 1]; }, /星期/],
    [(s) => { s.rules[0].days = [8]; }, /星期/],
    [(s) => { s.rules[0].days = [1, 1]; }, /星期/],
    [(s) => { s.rules[0].days = ['1']; }, /星期/],
    [(s) => { s.rules[0].days = Array(1); }, /星期/],
    [(s) => { s.rules[0].start = '7:00'; }, /规则时间/],
    [(s) => { s.rules[0].end = '19:30'; }, /规则时间/],
    [(s) => { s.rules[0].end = '18:00'; }, /规则时间/],
  ];
  for (const [mutate, expected] of cases) {
    const data = example(); const settings = implementationSettings(); mutate(settings);
    data.projects[0].implementationSettings = settings;
    assert.throws(() => validateSnapshot(data), expected);
  }
  for (const invalid of [null, [], 'text', undefined]) {
    const data = example(); data.projects[0].implementationSettings = invalid;
    assert.throws(() => validateSnapshot(data), /实施计划设置/);
  }
  const boundary = example();
  boundary.projects[0].implementationSettings = { ...implementationSettings(), startDate: '2024-01-01', endDate: '2024-12-31' };
  assert.doesNotThrow(() => validateSnapshot(boundary), '允许包含首尾日期共366天的计划');
});
