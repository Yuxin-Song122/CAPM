export const STORAGE_KEY = 'xuri.planner.v1';
export const COLORS = ['sage', 'clay', 'blue', 'lavender', 'gold'];
export const COLOR_LABELS = { sage: '松绿', clay: '陶橙', blue: '雾蓝', lavender: '浅紫', gold: '麦黄' };

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function parseDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return value >= '1900-01-01' && value <= '2100-12-31' && localDate(parseDate(value)) === value;
}
export const validTime = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const uid = () => globalThis.crypto.randomUUID();
export function addDays(value, days) {
  const date = parseDate(value);
  date.setDate(date.getDate() + days);
  return localDate(date);
}
export function daysBetween(a, b) {
  const toUTC = (v) => { const [y, m, d] = v.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((toUTC(b) - toUTC(a)) / 86400000);
}
export function monthDays(year, month) {
  const first = `${year}-${String(month + 1).padStart(2, '0')}-01`;
  const offset = (parseDate(first).getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: Math.ceil((offset + count) / 7) * 7 }, (_, i) => addDays(first, i - offset));
}
export const projectItems = (state, id) => state.items.filter((item) => item.projectId === id);
export const dayItems = (state, date) => state.items.filter((item) => item.date === date).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'zh-CN'));
export function progress(items) {
  const completed = items.filter((item) => item.completed).length;
  return { total: items.length, completed, percent: items.length ? Math.round(completed / items.length * 100) : 0 };
}

const fail = (message) => { throw new Error(message); };
function text(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(`${label}格式不正确（最多 ${max} 字）。`);
  return value.trim();
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) fail('记录编号格式不正确。');
  return value;
}
export function validateSnapshot(input) {
  if (!input || typeof input !== 'object' || input.version !== 1) fail('不是序日支持的备份文件（需要版本 1）。');
  if (!Array.isArray(input.projects) || !Array.isArray(input.items)) fail('备份缺少项目或任务数据。');
  if (input.projects.length > 500 || input.items.length > 10000) fail('最多支持 500 个项目和 10000 条任务 / 日程。');
  const projectIds = new Set();
  const projects = input.projects.map((p) => {
    if (!p || typeof p !== 'object') fail('项目数据格式不正确。');
    const projectId = id(p.id);
    if (projectIds.has(projectId)) fail('备份中存在重复的项目编号。');
    projectIds.add(projectId);
    if (p.deadline !== null && !validDate(p.deadline)) fail('项目截止日期无效。');
    if (!COLORS.includes(p.color) || typeof p.archived !== 'boolean') fail('项目颜色或归档状态无效。');
    return { id: projectId, name: text(p.name, '项目名称', 80, true), goal: text(p.goal, '项目目标', 2000), deadline: p.deadline, color: p.color, archived: p.archived, isDemo: p.isDemo === true };
  });
  const itemIds = new Set();
  const items = input.items.map((item) => {
    if (!item || typeof item !== 'object') fail('任务数据格式不正确。');
    const itemId = id(item.id);
    if (itemIds.has(itemId)) fail('备份中存在重复的任务编号。');
    itemIds.add(itemId);
    if (item.projectId !== null && !projectIds.has(item.projectId)) fail('任务关联的项目不存在。');
    if (typeof item.completed !== 'boolean') fail('任务完成状态无效。');
    if (item.date === null) {
      if (item.projectId === null || item.start !== null || item.end !== null) fail('独立日程必须设置日期和起止时间。');
    } else if (!validDate(item.date) || !validTime(item.start) || !validTime(item.end) || item.start >= item.end) {
      fail('日程日期或时间无效；结束时间必须晚于开始时间，跨天安排请拆成两条。');
    }
    return { id: itemId, title: text(item.title, '任务 / 日程名称', 120, true), notes: text(item.notes ?? '', '备注', 2000), projectId: item.projectId, date: item.date, start: item.start, end: item.end, completed: item.completed, isDemo: item.isDemo === true };
  });
  return { version: 1, projects, items };
}
export function mergeSnapshots(current, incoming) {
  const merge = (a, b) => [...new Map([...a, ...b].map((record) => [record.id, record])).values()];
  return validateSnapshot({ version: 1, projects: merge(current.projects, incoming.projects), items: merge(current.items, incoming.items) });
}
export function persist(storage, next) {
  const validated = validateSnapshot(next);
  storage.setItem(STORAGE_KEY, JSON.stringify(validated));
  return validated;
}
export function removeExamples(state) {
  const items = state.items.filter((item) => !item.isDemo);
  const usedProjects = new Set(items.map((item) => item.projectId));
  const projects = state.projects.filter((p) => !p.isDemo || usedProjects.has(p.id));
  return validateSnapshot({ version: 1, projects, items });
}
export function createExamples(today = localDate()) {
  const projects = [
    { id: 'demo-cet6', name: '六级考试', goal: '每天前进一点点，让英语成为自己的底气。\n目标：六级 550 分，坚持词汇积累与真题练习。', deadline: addDays(today, 39), color: 'sage', archived: false, isDemo: true },
    { id: 'demo-project', name: 'XX 项目提交', goal: '把想法变成作品。完成需求梳理、设计与开发，按时提交一个自己满意的项目。', deadline: addDays(today, 16), color: 'clay', archived: false, isDemo: true },
    { id: 'demo-reading', name: '读完一本好书', goal: '留一些时间给阅读。读完《小王子》，记录触动自己的句子。', deadline: addDays(today, 26), color: 'lavender', archived: false, isDemo: true },
  ];
  const item = (id, title, projectId, date, start, end, completed = false) => ({ id, title, projectId, date, start, end, completed, notes: '', isDemo: true });
  const items = [
    item('demo-vocabulary', '晨间单词 · 30 个新朋友', 'demo-cet6', today, '08:30', '09:00', true),
    item('demo-design', '整理项目思路与需求', 'demo-project', today, '10:00', '11:30'),
    item('demo-walk', '出门走走，给自己充个电', null, today, '16:00', '16:30'),
    item('demo-read', '睡前阅读 20 分钟', 'demo-reading', today, '21:00', '21:20'),
    item('demo-listening', '完成一套听力真题', 'demo-cet6', addDays(today, 2), '09:00', '10:00'),
    item('demo-writing', '整理写作常用表达', 'demo-cet6', null, null, null),
    item('demo-outline', '完成项目初稿', 'demo-project', addDays(today, 5), '14:00', '16:00'),
    item('demo-plan', '列出功能清单', 'demo-project', addDays(today, -1), '10:00', '11:00', true),
    item('demo-notes', '写一份阅读小记', 'demo-reading', null, null, null),
  ];
  return validateSnapshot({ version: 1, projects, items });
}
