import { addDays, localDate, parseDate, validDate, validTime } from './model.js';

const DAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DATE = /(?<!\d)(?:(\d{4})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日|号)?|(\d{1,2})\s*(?:月|\/)\s*(\d{1,2})\s*(?:日|号)?|(今天|今日|明天|明日|后天|后日)|((?:下周|下星期|本周|本星期|这周|周|星期)[一二三四五六日天1-7]))/g;
const NUMBER = '[零〇一二两三四五六七八九十\\d]{1,3}';
const TIME = new RegExp(`(凌晨|早上|上午|中午|下午|傍晚|晚上|晚间|夜间)?\\s*(${NUMBER})\\s*(?::\\s*(\\d{1,2})|[点时](?:\\s*(半|一刻|三刻|${NUMBER}分?))?)`);
const DEADLINE = /报名截止|提交截止|截止(?:时间|日期)?|截至|最迟|最后期限|不晚于|到期/g;
const pad = (value) => String(value).padStart(2, '0');
const asDate = (year, month, day) => `${year}-${pad(month)}-${pad(day)}`;

function number(value) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [tens, units] = value.split('十');
    return (tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0);
  }
  return digits[value];
}

function dates(text, today) {
  const year = Number(today.slice(0, 4));
  return [...text.matchAll(DATE)].map((match) => {
    let date, assumedYear = false, crossedYear = false;
    if (match[1]) date = asDate(Number(match[1]), Number(match[2]), Number(match[3]));
    else if (match[4]) {
      assumedYear = true;
      const month = Number(match[4]);
      date = asDate(year, month, Number(match[5]));
      // A late-year notice about the first months of the year is normally for
      // the coming year. Keep the assumption visible instead of hiding it.
      if (validDate(date) && date < today && Number(today.slice(5, 7)) >= 10 && month <= 3) {
        date = asDate(year + 1, month, Number(match[5])); crossedYear = true;
      }
    } else if (match[6]) {
      date = addDays(today, /后/.test(match[6]) ? 2 : /明/.test(match[6]) ? 1 : 0);
    } else {
      const weekday = DAY[match[7].at(-1)] || Number(match[7].at(-1));
      const current = parseDate(today).getDay() || 7;
      const nextWeek = /下/.test(match[7]);
      const thisWeek = /本|这/.test(match[7]);
      let offset = weekday - current + (nextWeek ? 7 : 0);
      if (!nextWeek && !thisWeek && offset < 0) offset += 7;
      date = addDays(today, offset);
    }
    return { index: match.index, end: match.index + match[0].length, raw: match[0], date, valid: validDate(date), assumedYear, crossedYear };
  });
}

function timeAfter(text, token, all) {
  const next = all.find((candidate) => candidate.index > token.index);
  const tail = text.slice(token.end, Math.min(next?.index ?? text.length, token.end + 60)).split(/[。；;\n]/)[0];
  const match = tail.match(TIME);
  if (!match) return { time: '', warning: '' };
  let hour = number(match[2]);
  let minute = match[3] === undefined ? 0 : Number(match[3]);
  if (match[4]) minute = match[4] === '半' ? 30 : match[4] === '一刻' ? 15 : match[4] === '三刻' ? 45 : number(match[4].replace(/分$/, ''));
  const period = match[1];
  if (period && /下午|傍晚|晚上|晚间|夜间/.test(period) && hour >= 1 && hour < 12) hour += 12;
  if (period === '中午' && hour >= 1 && hour < 11) hour += 12;
  if (period === '凌晨' && hour === 12) hour = 0;
  const result = `${pad(hour)}:${pad(minute)}`;
  if (!validTime(result)) return { time: '', warning: '通知中的时刻无效，请手动填写截止时间。' };
  const ambiguous = !period && /[点时]/.test(match[0]) && hour >= 1 && hour <= 12;
  return { time: result, warning: ambiguous ? '通知时刻未注明上午或下午，请核对截止时间。' : '' };
}

function deadlineCandidates(text, all) {
  const candidates = new Set();
  let hasMarker = false;
  for (const marker of text.matchAll(DEADLINE)) {
    if (/(?:无|暂无|未设|不设|没有)\s*$/.test(text.slice(Math.max(0, marker.index - 5), marker.index))) continue;
    hasMarker = true;
    const end = marker.index + marker[0].length;
    const after = all.find((date) => date.index >= end);
    const previous = all.filter((date) => date.end <= marker.index).at(-1);
    const forward = after ? text.slice(end, after.index) : '';
    if (after && after.index - end <= 35 && /^[\s:为是于在到至暂定请应报名提交申请缴费日期时间]*$/u.test(forward)) candidates.add(after);
    else if (previous && marker.index - previous.end <= 35 && !/[。；;\n！？!?]/.test(text.slice(previous.end, marker.index))) candidates.add(previous);
  }
  for (const date of all) {
    const next = all.find((candidate) => candidate.index > date.index);
    const after = text.slice(date.end, Math.min(next?.index ?? text.length, date.end + 45));
    if (/^[^。；;\n，,]{0,28}?(?:之前|以前|前)(?=\s|[，。；;！!]|提交|报名|完成|发送|交|上报|截止|$)/.test(after)) candidates.add(date);
  }
  for (const date of [...candidates]) {
    const next = all.find((candidate) => candidate.index > date.index);
    if (next && /^\s*(?:至|到|[-—~～])\s*$/.test(text.slice(date.end, next.index))) candidates.add(next);
  }
  return { candidates: [...candidates], hasMarker };
}

function locationFrom(text, warnings) {
  const locations = [...text.matchAll(/(?:会议地点|活动地点|考试地点|报到地点|提交地点|地点|地址|会场)\s*[:：]\s*([^\n。；;]+)/g)]
    .map((match) => match[1].split(/[，,](?=\s*(?:请|截止|报名|时间|联系人|活动时间))/)[0].trim());
  if (!locations.length) {
    const match = text.match(/(?:到|至|前往)\s*([^，。；;\n]{2,80}?)\s*(?:提交|交纸质|交报名|报到|办理)/)
      || text.match(/在\s*([^，。；;\n]{2,80}?)\s*(?:举行|召开|举办|开展|集合)/);
    if (match && !/\d{1,2}月\d|[日号]前/.test(match[1])) locations.push(match[1].trim());
  }
  const unique = [...new Set(locations.filter(Boolean))];
  if (unique.length > 1) { warnings.push('通知中有多个地点，请手动选择项目地点。'); return ''; }
  if (!unique.length) { warnings.push('未识别到明确地点，请按需要补充。'); return ''; }
  if (unique[0].length > 500) warnings.push('地点较长，预览仅保留前 500 字，完整内容仍保存在通知原文中。');
  return unique[0].slice(0, 500);
}

function titleAndGoal(text, warnings) {
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const meaningful = lines.filter((line) => !/^(?:各位|亲爱的)?(?:同学们?|老师们?|同事们?|各部门|各位师生)[：:，,！!]?$/u.test(line));
  const first = meaningful[0] || lines[0] || '';
  const bracket = first.match(/^【([^】]+)】\s*(.*)$/);
  let name = bracket ? (bracket[1] === '通知' ? bracket[2] : bracket[1] + (bracket[2] ? ` ${bracket[2]}` : '')) : first;
  name = name.replace(/^(?:通知|公告)\s*[:：]\s*/, '').replace(/^关于\s*/, '').replace(/的通知\s*$/, '').trim();
  if (!name || /^(?:通知|公告)$/.test(name)) name = meaningful[1] || first || '待完善的通知项目';
  name = name.split(/[。；;\n]/)[0].trim();
  if (name.length > 80) { warnings.push('项目名称已缩短为前 80 字，请确认名称。'); name = name.slice(0, 80); }
  const hasHeading = /^【|^关于|^(?:通知|公告)\s*[:：]|(?:通知|公告)$/.test(first);
  let body = meaningful.length > 1 && hasHeading ? meaningful.slice(1) : meaningful;
  // A standalone date at the end is a signature date, not a project deadline.
  body = body.filter((line, index) => !(index === body.length - 1 && /^(?:\d{4}年\d{1,2}月\d{1,2}[日号]?|\d{4}[-/.]\d{1,2}[-/.]\d{1,2})$/.test(line)));
  const goal = body.join('\n') || text;
  if (goal.length > 2000) warnings.push('主要内容较长，预览仅保留前 2000 字，完整通知原文会保留。');
  return { name, goal: goal.slice(0, 2000) };
}

export function parseNotice(input, { today = localDate() } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('请先粘贴通知文字或识别通知图片。');
  if (input.length > 10000) throw new Error('通知最多支持 10000 字，请分段处理。');
  if (!validDate(today)) throw new Error('解析参考日期无效。');
  const text = input.replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(/：/g, ':').replace(/\r\n?/g, '\n').trim();
  const warnings = [];
  const all = dates(text, today);
  const { candidates, hasMarker } = deadlineCandidates(text, all);
  let selected = candidates.filter((date) => date.valid);
  if (candidates.some((date) => !date.valid)) {
    warnings.push('通知中的截止日期无效，请手动核对；不会自动修正日期。');
    selected = [];
  }
  let usedActivity = false;
  if (!candidates.length && !hasMarker) {
    const activities = all.filter((date) => {
      if (!date.valid) return false;
      const start = Math.max(text.lastIndexOf('\n', date.index), text.lastIndexOf('。', date.index), text.lastIndexOf('；', date.index)) + 1;
      const end = text.slice(date.end).search(/[\n。；;]/);
      const clause = text.slice(start, end < 0 ? text.length : date.end + end);
      return /活动|会议|考试|讲座|培训|报到|面试|比赛|汇报|召开|举行|举办|定于|时间\s*[:：]/.test(clause);
    });
    if (activities.length) { selected = activities; usedActivity = true; }
  }
  const unique = [...new Map(selected.map((date) => [`${date.date} ${timeAfter(text, date, all).time}`, date])).values()];
  let deadline = null, deadlineTime = '';
  if (unique.length > 1) warnings.push('通知中有多个不同的截止或活动时间，请手动选择项目期限。');
  else if (unique.length === 1) {
    const date = unique[0];
    const time = timeAfter(text, date, all);
    deadline = date.date; deadlineTime = time.time;
    if (time.warning) warnings.push(time.warning);
    if (date.crossedYear) warnings.push(`通知未写年份，暂按跨年后的 ${deadline.slice(0, 4)} 年处理，请核对。`);
    else if (date.assumedYear) warnings.push(`通知未写年份，暂按 ${deadline.slice(0, 4)} 年处理，请核对。`);
    if (deadline < today) warnings.push('识别的期限早于今天，请确认是否为过期通知。');
    if (usedActivity) warnings.push('未发现明确截止要求，暂用活动日期作为项目期限，请确认。');
    if (!deadlineTime) warnings.push('未识别到精确截止时刻；目前只填写日期，请按需要补充时间。');
  } else warnings.push('未识别到可确认的截止日期，请手动填写。');
  const { name, goal } = titleAndGoal(text, warnings);
  const location = locationFrom(text, warnings);
  return { name, goal, deadline, deadlineTime, location, warnings: [...new Set(warnings)], noticeText: input };
}
