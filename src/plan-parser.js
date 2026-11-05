import { addDays, daysBetween, localDate, parseDate, validDate, validTime } from './model.js';

// This parser runs entirely on the device. It handles the recurring patterns
// described in the UI; every inferred time remains visible and editable.
const NUMBER = '(?:\\d{1,3}(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
const HOUR = '(?:\\d{1,2}|[零〇一二两三四五六七八九十]+)';
const PERIOD = '(?:凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|夜间)';
const CLOCK_END = '(?::[0-9]{1,2}|[点时](?:半|一刻|三刻|(?:[0-9]{1,2}|[零〇一二两三四五六七八九十]+)分?)?)';
const CLOCK = `${PERIOD}?\\s*${HOUR}(?:${CLOCK_END})?`;
const DURATION = `${NUMBER}个?半(?:个)?小时|半(?:个)?小时|${NUMBER}个?(?:小时|钟头)(?:\\s*${NUMBER}分钟)?|${NUMBER}分钟`;
const DAY_VALUES = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DAY_CHAR = '[一二三四五六日天1-7]';
const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const minuteText = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const unique = (values) => [...new Set(values)];
const fail = (message) => { throw new Error(message); };

function number(value) {
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value];
  if (value.includes('百')) {
    const [hundreds, rest] = value.split('百');
    return (number(hundreds || '一') * 100) + (rest ? number(rest.replace(/^零/, '')) : 0);
  }
  if (value.includes('十')) {
    const [tens, rest] = value.split('十');
    return number(tens || '一') * 10 + (rest ? number(rest) : 0);
  }
  return Number.NaN;
}

function normalize(value) {
  return value.replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10)).replaceAll('：', ':');
}

function dayNumber(value) { return DAY_VALUES[value] || Number(value); }
function extractDays(clause) {
  const range = new RegExp(`(?:每(?:个)?)?(?:周|星期|礼拜)\\s*(${DAY_CHAR})\\s*(?:至|到|[-—~～])\\s*(?:(?:周|星期|礼拜)\\s*)?(${DAY_CHAR})`).exec(clause);
  if (range) {
    const start = dayNumber(range[1]); const end = dayNumber(range[2]);
    const days = [];
    for (let day = start, i = 0; i < 7; i++, day = day % 7 + 1) { days.push(day); if (day === end) break; }
    return { days, rest: clause.replace(range[0], ''), workdays: start === 1 && end === 5 };
  }
  const workday = /(?:每(?:个)?)?工作日/.exec(clause);
  if (workday) return { days: [1, 2, 3, 4, 5], rest: clause.replace(workday[0], ''), workdays: true };
  const weekend = /(?:每(?:个)?)?周末/.exec(clause);
  if (weekend) return { days: [6, 7], rest: clause.replace(weekend[0], ''), workdays: false };
  const daily = /每(?:一)?天|每日|天天/.exec(clause);
  if (daily) return { days: [1, 2, 3, 4, 5, 6, 7], rest: clause.replace(daily[0], ''), workdays: false };
  const enumeration = new RegExp(`(?:每(?:个)?)?(?:周|星期|礼拜)\\s*(${DAY_CHAR}(?:[一二三四五六日天]|(?:\\s*(?:、|和|与|及|,|，)\\s*(?:(?:周|星期|礼拜)\\s*)?)${DAY_CHAR})*)`).exec(clause);
  if (enumeration) {
    let matched = enumeration[0];
    // In “周一三点”, 三 belongs to the clock, rather than a second weekday.
    if (/[点时:]/.test(clause.slice(enumeration.index + matched.length, enumeration.index + matched.length + 1)) && /[一二三四五六1-7]{2}$/.test(matched)) matched = matched.slice(0, -1);
    // 日语 / 日常 / 天文 belong to the activity name, not an adjacent Sunday.
    if (/[一二三四五][日天]$/.test(matched) && /[语常报记程历文气]/.test(clause.slice(enumeration.index + matched.length, enumeration.index + matched.length + 1))) matched = matched.slice(0, -1);
    const values = matched.replace(/每|个|周|星期|礼拜|\s|、|和|与|及|,|，/g, '').split('').map(dayNumber);
    return { days: unique(values).sort((a, b) => a - b), rest: clause.slice(0, enumeration.index) + clause.slice(enumeration.index + matched.length), workdays: false };
  }
  return null;
}

function readClock(raw, inheritedPeriod = '') {
  const value = raw.trim();
  const period = new RegExp(PERIOD).exec(value)?.[0] || inheritedPeriod;
  const withoutPeriod = value.replace(new RegExp(PERIOD), '').trim();
  const match = new RegExp(`^(${HOUR})(?::([0-9]{1,2})|[点时](.*))?$`).exec(withoutPeriod);
  if (!match) return null;
  let hour = number(match[1]);
  let minute = match[2] === undefined ? 0 : Number(match[2]);
  if (match[3]) {
    if (match[3] === '半') minute = 30;
    else if (match[3] === '一刻') minute = 15;
    else if (match[3] === '三刻') minute = 45;
    else minute = number(match[3].replace(/分$/, ''));
  }
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  let assumedAfternoon = false;
  if (['下午', '傍晚', '晚上', '夜间'].includes(period) && hour >= 1 && hour < 12) hour += 12;
  else if (period === '中午' && hour >= 1 && hour < 7) hour += 12;
  else if (['凌晨', '清晨', '早上'].includes(period) && hour === 12) hour = 0;
  else if (!period && !value.includes(':') && hour >= 1 && hour <= 6) { hour += 12; assumedAfternoon = true; }
  return { time: minuteText(hour * 60 + minute), period, assumedAfternoon };
}

function readDuration(raw) {
  const compact = raw.replace(/\s|个/g, '');
  if (/^半小时$/.test(compact)) return 30;
  const half = new RegExp(`^(${NUMBER})半小时$`).exec(compact);
  if (half) return number(half[1]) * 60 + 30;
  const hours = new RegExp(`^(${NUMBER})(?:小时|钟头)(?:(${NUMBER})分钟)?$`).exec(compact);
  if (hours) return number(hours[1]) * 60 + (hours[2] ? number(hours[2]) : 0);
  const minutes = new RegExp(`^(${NUMBER})分钟$`).exec(compact);
  return minutes ? number(minutes[1]) : Number.NaN;
}

function extractTime(text, defaultStart) {
  let rest = text;
  const warnings = [];
  let start, end;
  const range = new RegExp(`(${CLOCK})\\s*(?:到|至|[-—~～])\\s*(${CLOCK})`).exec(rest);
  if (range) {
    // “每天 2–3 小时” is a variable duration, not a 14:00–15:00 clock.
    if (/^\s*(?:个?小时|分钟|钟头)/.test(rest.slice(range.index + range[0].length))) return { error: '时长是一个范围，请写明固定时长或起止时间。' };
    const first = readClock(range[1]); const last = first && readClock(range[2], first.period);
    if (!first || !last) return { error: '起止时间无效。' };
    start = first.time; end = last.time;
    if (first.assumedAfternoon || last.assumedAfternoon) warnings.push('未写明上下午的 1–6 点先按下午展示，请在保存前核对。');
    rest = rest.replace(range[0], '');
  } else {
    const single = new RegExp(`(?:${PERIOD}\\s*${HOUR}(?:${CLOCK_END})?|${HOUR}${CLOCK_END})`).exec(rest);
    if (single) {
      const clock = readClock(single[0]);
      if (!clock) return { error: '开始时间无效。' };
      start = clock.time;
      if (clock.assumedAfternoon) warnings.push('未写明上下午的 1–6 点先按下午展示，请在保存前核对。');
      rest = rest.replace(single[0], '');
    }
  }
  const durationMatch = new RegExp(DURATION).exec(rest);
  const duration = durationMatch ? readDuration(durationMatch[0]) : null;
  if (durationMatch) rest = rest.replace(durationMatch[0], '');
  if (duration !== null && (!Number.isInteger(duration) || duration <= 0 || duration >= 1440)) return { error: '时长须大于 0 且少于 24 小时，并精确到分钟。' };
  if (!end) {
    if (duration === null) return { error: '缺少结束时间或固定时长，请补充后再生成。' };
    if (!start) {
      const periodOnly = new RegExp(PERIOD).exec(rest)?.[0];
      const hour = Number(defaultStart.slice(0, 2));
      const periodMatches = !periodOnly || ({ 凌晨: hour < 6, 清晨: hour < 9, 早上: hour < 12, 上午: hour < 12, 中午: hour >= 11 && hour < 15, 下午: hour >= 12 && hour < 19, 傍晚: hour >= 17 && hour < 21, 晚上: hour >= 18, 夜间: hour >= 18 || hour < 6 })[periodOnly];
      if (!periodMatches) return { error: `只写了${periodOnly}，未写明几点；默认 ${defaultStart} 与原时段不一致，请补充具体开始时间。` };
      if (periodOnly) rest = rest.replace(periodOnly, '');
      start = defaultStart;
      warnings.push(`未写明开始时间，先用 ${defaultStart} 排列，请在保存前修改或确认。`);
    }
    const ending = toMinutes(start) + duration;
    if (ending >= 1440) return { error: '这条计划跨天，请拆成当天的两个时段。' };
    end = minuteText(ending);
  } else if (duration !== null && toMinutes(end) - toMinutes(start) !== duration) warnings.push('文字中的时长与起止时间不一致，当前按起止时间展示，请核对。');
  if (!validTime(start) || !validTime(end) || start >= end) return { error: '结束时间必须晚于开始时间；跨天计划请拆开。' };
  return { start, end, rest, warnings };
}

export function parseImplementationPlan(text, { today = localDate(), defaultStart = '19:00' } = {}) {
  if (typeof text !== 'string' || text.length > 5000) fail('项目实施计划最多 5000 字。');
  if (!validDate(today)) fail('计划的起始参考日期无效。');
  if (!validTime(defaultStart)) fail('默认开始时间无效。');
  const clauses = normalize(text).split(/[，,；;。\n]+/).map((clause) => clause.trim()).filter(Boolean);
  const rules = []; const warnings = []; const unrecognized = [];
  let previousDays;
  for (const clause of clauses) {
    const frequency = extractDays(clause);
    const days = frequency?.days || previousDays;
    if (!days?.length) { unrecognized.push(clause); warnings.push(`「${clause}」缺少重复日期，请注明每天、工作日、周末或每周几。`); continue; }
    if (frequency) previousDays = frequency.days;
    else warnings.push(`「${clause}」沿用上一条的重复日期，请核对。`);
    if (frequency?.workdays) warnings.push('工作日按周一至周五生成，暂不识别法定节假日和调休。');
    const time = extractTime(frequency?.rest ?? clause, defaultStart);
    if (time.error) { unrecognized.push(clause); warnings.push(`「${clause}」${time.error}`); continue; }
    let title = time.rest.replace(/^(?:[：:\s]|安排|进行|用于|用来|花|用|抽出|预留|坚持)+/, '').replace(/[：:\s]+$/, '').trim();
    if (!title) { unrecognized.push(clause); warnings.push(`「${clause}」缺少活动名称，请补充要做的事情。`); continue; }
    if (title.length > 120) { title = title.slice(0, 120); warnings.push('日程名称已截取前 120 字，请核对。'); }
    warnings.push(...time.warnings);
    rules.push({ id: `rule-${rules.length + 1}`, days: [...days], title, start: time.start, end: time.end });
  }
  return { rules, warnings: unique(warnings), unrecognized };
}

function stablePlanKey(projectId, item) {
  const value = JSON.stringify([projectId, item.date, item.start, item.end, item.title]);
  let hash = 0xcbf29ce484222325n;
  for (const char of value) { hash ^= BigInt(char.codePointAt(0)); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `plan:${item.date}:${item.start}-${item.end}:${hash.toString(16).padStart(16, '0')}`;
}
const sameSchedule = (item) => JSON.stringify([item.projectId, item.date, item.start, item.end, item.title]);

export function generatePlanOccurrences(rules, { startDate, endDate, projectId, existingItems = [] } = {}) {
  if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) fail('请选择有效的生成开始、结束日期。');
  const dateCount = daysBetween(startDate, endDate) + 1;
  if (dateCount > 366) fail('一次最多生成 366 天的计划，请缩短日期范围。');
  if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(projectId)) fail('请先选择或建立所属项目。');
  if (!Array.isArray(rules) || !rules.length || rules.length > 50) fail('请提供 1–50 条可识别的计划规则。');
  if (!Array.isArray(existingItems)) fail('现有日程数据无效。');
  const normalizedRules = rules.map((rule) => {
    if (!rule || !Array.isArray(rule.days) || !rule.days.length || rule.days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) fail('请为每条规则选择有效的星期。');
    if (typeof rule.title !== 'string' || !rule.title.trim() || rule.title.length > 120) fail('请填写有效的日程名称（最多 120 字）。');
    if (!validTime(rule.start) || !validTime(rule.end) || rule.start >= rule.end) fail('规则的结束时间必须晚于开始时间，跨天计划请拆开。');
    return { days: unique(rule.days), title: rule.title.trim(), start: rule.start, end: rule.end };
  });
  const keys = new Set(existingItems.filter((item) => item.projectId === projectId && item.planKey).map((item) => item.planKey));
  const exact = new Set(existingItems.map(sameSchedule));
  const occupied = existingItems.filter((item) => validDate(item.date) && validTime(item.start) && validTime(item.end));
  const items = []; const skipped = []; const conflicts = [];
  let candidates = 0;
  for (let offset = 0; offset < dateCount; offset++) {
    const date = addDays(startDate, offset);
    const day = parseDate(date).getDay() || 7;
    for (const rule of normalizedRules) {
      if (!rule.days.includes(day)) continue;
      if (++candidates > 500) fail('一次最多生成 500 条日程，请缩短日期范围或减少重复规则。');
      const item = { title: rule.title, projectId, date, start: rule.start, end: rule.end, notes: '', location: '', completed: false, isDemo: false };
      item.planKey = stablePlanKey(projectId, item);
      if (keys.has(item.planKey) || exact.has(sameSchedule(item))) { skipped.push({ date, title: item.title, reason: '已有相同计划，保留现有记录。' }); continue; }
      for (const other of occupied) {
        if (other.date === date && other.start < item.end && item.start < other.end) conflicts.push({ date, title: item.title, start: item.start, end: item.end, withTitle: other.title, withId: other.id || null, withGenerated: items.includes(other) });
      }
      items.push(item); occupied.push(item); keys.add(item.planKey); exact.add(sameSchedule(item));
    }
  }
  return { items, skipped, conflicts, warnings: [] };
}
