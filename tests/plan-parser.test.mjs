import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImplementationPlan, generatePlanOccurrences } from '../src/plan-parser.js';

const options = { today: '2026-11-05' };
const parse = (text, extra = {}) => parseImplementationPlan(text, { ...options, ...extra });
const daily = { id: 'rule-1', days: [1, 2, 3, 4, 5, 6, 7], title: '复习', start: '19:00', end: '20:00' };
const generate = (rules, extra = {}) => generatePlanOccurrences(rules, { startDate: '2026-11-05', endDate: '2026-11-11', projectId: 'project-a', ...extra });

test('用户示例识别工作日两小时和周末真题，并明确默认时段假设', () => {
  const result = parse('每个工作日安排两个小时学习，周末三点到五点做真题');
  assert.deepEqual(result.rules, [
    { id: 'rule-1', days: [1, 2, 3, 4, 5], title: '学习', start: '19:00', end: '21:00' },
    { id: 'rule-2', days: [6, 7], title: '做真题', start: '15:00', end: '17:00' },
  ]);
  assert.deepEqual(result.unrecognized, []);
  assert.ok(result.warnings.some((text) => text.includes('19:00')));
  assert.ok(result.warnings.some((text) => text.includes('下午')));
  assert.ok(result.warnings.some((text) => text.includes('调休')));
});

test('24小时、中文早晚时段和列举星期保持准确，不把钟点当星期', () => {
  assert.deepEqual(parse('每周一、三、五 20:00-21:30 复习').rules[0], { id: 'rule-1', days: [1, 3, 5], title: '复习', start: '20:00', end: '21:30' });
  assert.deepEqual(parse('每周二和周四晚上七点到九点练听力').rules[0], { id: 'rule-1', days: [2, 4], title: '练听力', start: '19:00', end: '21:00' });
  assert.deepEqual(parse('每周一三五上午九点到十一点学习').rules[0].days, [1, 3, 5]);
  assert.equal(parse('周三 19:00-20:00 复习').rules[0].start, '19:00');
  assert.deepEqual(parse('周一三点到五点学习').rules[0].days, [1]);
  assert.equal(parse('每天 03:00-05:00 备考').rules[0].start, '03:00');
  assert.deepEqual(parse('每周六和周日 15:00-17:00 做真题').rules[0].days, [6, 7]);
  assert.deepEqual(parse('周一至周五 08:00-09:00 学习').rules[0].days, [1, 2, 3, 4, 5]);
  assert.deepEqual(parse('周一日语学习两小时').rules[0].days, [1]);
  assert.equal(parse('周一日语学习两小时').rules[0].title, '日语学习');
});

test('半小时、一个半小时和小时分钟组合正确换算，显式起点优先', () => {
  for (const [text, end] of [['每天19点学习半小时', '19:30'], ['每天19点学习一个半小时', '20:30'], ['每天19点学习1.5小时', '20:30'], ['每天19点学习两小时三十分钟', '21:30']]) {
    const result = parse(text);
    assert.equal(result.rules[0]?.end, end, text);
    assert.equal(result.rules[0]?.title, '学习', text);
  }
  const result = parse('每天学习半小时', { defaultStart: '08:00' });
  assert.equal(result.rules[0].start, '08:00');
  assert.equal(result.rules[0].end, '08:30');
  assert.equal(parse('每天上午学习两小时').rules.length, 0, '不能把明确的上午默认安排到晚上');
  assert.equal(parse('每天晚上学习两小时').rules[0].title, '学习');
});

test('不能确定日期或时长时保留未识别文字，跨天和可变时长不生成', () => {
  for (const text of ['有空看看书', '每天学习', '周末下午三点做真题', '每天晚上十一点到一点学习', '每天23:00学习两个小时', '每天2-3小时学习']) {
    const result = parse(text);
    assert.equal(result.rules.length, 0, text);
    assert.deepEqual(result.unrecognized, [text]);
    assert.ok(result.warnings.length, text);
  }
  assert.throws(() => parse('每天学习两小时', { defaultStart: '24:00' }), /开始时间/);
});

test('生成日期含首尾，跨月闰年正确，并按实际星期选择', () => {
  const rules = parse('工作日19:00-20:00学习，周末15:00-17:00做真题').rules;
  const result = generate(rules, { startDate: '2024-02-28', endDate: '2024-03-03' });
  assert.deepEqual(result.items.map(({ date, title }) => [date, title]), [['2024-02-28', '学习'], ['2024-02-29', '学习'], ['2024-03-01', '学习'], ['2024-03-02', '做真题'], ['2024-03-03', '做真题']]);
  assert.ok(result.items.every((item) => !Object.hasOwn(item, 'id') && item.projectId === 'project-a' && !item.completed && item.location === '' && item.planKey.length <= 200));
});

test('重复生成跳过旧条目和已编辑的计划记录，不覆盖完成状态或备注', () => {
  const first = generate([daily]);
  const existing = first.items.map((item, index) => ({ ...item, id: `old-${index}`, completed: true, notes: '必须保留' }));
  existing[0].title = '用户修改的标题'; existing[0].start = '18:00';
  const before = structuredClone(existing);
  const again = generate([daily], { existingItems: existing });
  assert.equal(again.items.length, 0);
  assert.equal(again.skipped.length, 7);
  assert.deepEqual(existing, before);
  // An independently entered identical task also counts as existing without a planKey.
  const manual = { ...first.items[0] }; delete manual.planKey;
  assert.equal(generate([daily], { endDate: '2026-11-05', existingItems: [manual] }).items.length, 0);
  assert.deepEqual(generate([daily]).items.map((item) => item.planKey), first.items.map((item) => item.planKey));
});

test('冲突逐项报告且不悄悄移动日程，相邻时段不冲突', () => {
  const other = { id: 'occupied', projectId: null, date: '2026-11-05', title: '原日程', start: '19:30', end: '20:30', completed: false };
  const result = generate([daily], { endDate: '2026-11-05', existingItems: [other] });
  assert.equal(result.items[0].start, '19:00');
  assert.deepEqual(result.conflicts[0], { date: '2026-11-05', title: '复习', start: '19:00', end: '20:00', withTitle: '原日程', withId: 'occupied', withGenerated: false });
  assert.equal(generate([daily], { endDate: '2026-11-05', existingItems: [{ ...other, start: '20:00' }] }).conflicts.length, 0);
  assert.equal(generate([daily, { ...daily, title: '真题', start: '19:30', end: '20:30' }], { endDate: '2026-11-05' }).conflicts[0].withGenerated, true);
});

test('日期、规则和数量上限明确拒绝，不产生无限重复安排', () => {
  assert.throws(() => generate([daily], { endDate: '2026-11-04' }), /日期/);
  assert.throws(() => generate([daily], { startDate: '2026-01-01', endDate: '2027-01-02' }), /366/);
  assert.equal(generate([daily], { startDate: '2024-01-01', endDate: '2024-12-31' }).items.length, 366);
  assert.throws(() => generate([daily, { ...daily, title: '真题' }], { startDate: '2024-01-01', endDate: '2024-12-31' }), /500/);
  assert.throws(() => generate([{ ...daily, days: [0] }]), /星期/);
  assert.throws(() => generate([{ ...daily, end: '18:00' }]), /结束时间/);
  assert.throws(() => generate([daily], { projectId: '' }), /项目/);
});
