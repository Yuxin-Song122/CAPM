import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNotice } from '../src/notice-parser.js';

const options = { today: '2026-11-05' };

test('通知标题、主要事项、精确截止和地点可解析，保留原文', () => {
  const text = '关于课程项目提交的通知\n各位同学：\n请完成设计报告并提交纸质材料。\n提交截止：2026年11月12日下午三点半\n地点：教学楼 A302\n教务处\n2026年11月5日';
  const result = parseNotice(text, options);
  assert.equal(result.name, '课程项目提交');
  assert.match(result.goal, /完成设计报告/);
  assert.equal(result.deadline, '2026-11-12');
  assert.equal(result.deadlineTime, '15:30');
  assert.equal(result.location, '教学楼 A302');
  assert.equal(result.noticeText, text);
});

test('活动日期和报名截止同时存在时优先截止，不把落款当期限', () => {
  const result = parseNotice('【学术讲座】\n活动时间：11月8日15:00，报名截止11月7日18:00。\n地点：图书馆报告厅\n2026年11月5日', options);
  assert.equal(result.deadline, '2026-11-07');
  assert.equal(result.deadlineTime, '18:00');
  assert.equal(result.location, '图书馆报告厅');
  const signed = parseNotice('志愿者招募通知\n请有意向的同学联系负责人，时间另行通知。\n学生会\n2026年11月5日', options);
  assert.equal(signed.deadline, null);
  assert.equal(parseNotice('关于报名截止安排的通知\n请积极参加\n2026年11月5日', options).deadline, null);
});

test('支持今天、明天、后天及本周下周的中文时刻', () => {
  assert.equal(parseNotice('请明天18:00前提交资料，地点：办公室。', options).deadline, '2026-11-06');
  assert.equal(parseNotice('最迟后天晚上八点交材料。', options).deadlineTime, '20:00');
  const friday = parseNotice('截止时间：本周五下午三点。', options);
  assert.equal(friday.deadline, '2026-11-06');
  assert.equal(friday.deadlineTime, '15:00');
  assert.equal(parseNotice('报名截止下周二中午12:00。', options).deadline, '2026-11-10');
});

test('支持斜线、连字符和全角数字，跨年假设明确提示', () => {
  assert.equal(parseNotice('截止：2026-11-12 17:05。', options).deadlineTime, '17:05');
  assert.equal(parseNotice('报名截止：１１月１２日１７：００。', options).deadline, '2026-11-12');
  const result = parseNotice('最迟1/2下午三点提交。', { today: '2026-12-30' });
  assert.equal(result.deadline, '2027-01-02');
  assert.equal(result.deadlineTime, '15:00');
  assert.ok(result.warnings.some((warning) => warning.includes('跨年')));
});

test('多个不同截止日期或时间不自动选取', () => {
  const result = parseNotice('报名截止11月7日18:00。缴费截止11月9日12:00。', options);
  assert.equal(result.deadline, null);
  assert.equal(result.deadlineTime, '');
  assert.ok(result.warnings.some((warning) => warning.includes('多个')));
  assert.equal(parseNotice('报名截止11月7日12:00，缴费截止11月7日15:00。', options).deadline, null);
  assert.equal(parseNotice('提交截止日期：11月6日至11月8日。', options).deadline, null);
});

test('活动日期仅作带提示的候选，纯落款及缺信息不会编造', () => {
  const activity = parseNotice('讲座通知\n活动时间：11月8日晚上八点。\n地点：图书馆。', options);
  assert.equal(activity.deadline, '2026-11-08');
  assert.equal(activity.deadlineTime, '20:00');
  assert.ok(activity.warnings.some((warning) => warning.includes('活动日期')));
  const minimal = parseNotice('请准备学习资料', options);
  assert.equal(minimal.deadline, null);
  assert.equal(minimal.location, '');
  assert.ok(minimal.warnings.length >= 2);
  assert.match(parseNotice('请于明天18:00前提交课程报告。\n地点：教务办公室', options).goal, /提交课程报告/);
});

test('非法日期和时刻不自动修正，明确上下午及地点抽取保守', () => {
  const invalid = parseNotice('提交截止：2026年2月30日17:00。', options);
  assert.equal(invalid.deadline, null);
  assert.ok(invalid.warnings.some((warning) => warning.includes('无效')));
  const time = parseNotice('截止2026年11月12日25:00。', options);
  assert.equal(time.deadline, '2026-11-12');
  assert.equal(time.deadlineTime, '');
  assert.equal(parseNotice('请于明天18:00前到教务处302提交材料。', options).location, '教务处302');
  assert.equal(parseNotice('开会通知\n定于明天下午3点在图书馆报告厅召开会议。', options).location, '图书馆报告厅');
});

test('不改原文，限制输入并提示截断及地点歧义', () => {
  assert.throws(() => parseNotice('', options), /通知文字/);
  assert.throws(() => parseNotice('字'.repeat(10001), options), /10000/);
  assert.throws(() => parseNotice('通知', { today: '2026-02-30' }), /参考日期/);
  const text = '【课程通知】\r\n正文内容\r\n地点：教学楼\r\n活动地点：体育馆';
  const result = parseNotice(text, options);
  assert.equal(result.noticeText, text);
  assert.equal(result.location, '');
  assert.ok(result.warnings.some((warning) => warning.includes('多个地点')));
  assert.equal(parseNotice('字'.repeat(2500), options).goal.length, 2000);
});
