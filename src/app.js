import {
  STORAGE_KEY, COLORS, COLOR_LABELS, localDate, parseDate, validDate, uid,
  addDays, daysBetween, monthDays, projectItems, dayItems, progress,
  validateSnapshot, mergeSnapshots, persist, removeExamples, createExamples,
} from './model.js';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const modal = $('#modal');
const today = localDate();
const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const paths = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2m4 0h2m-8 3h2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2M12 17h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  laptop: '<rect x="5" y="3" width="14" height="12" rx="2"/><path d="m5 15-3 5h20l-3-5"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  leaf: '<path d="M20 4C7 2 1 10 6 16s16 2 14-12ZM5 20 16 9"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  restore: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l4 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  book: '<path d="M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H3Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-2h5Z"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.calendar}</svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dateText = (date, withYear = false) => {
  if (!date) return '未设置';
  const d = parseDate(date);
  return `${withYear ? `${d.getFullYear()} 年 ` : ''}${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};
const shortDate = (date) => `${parseDate(date).getMonth() + 1}月${parseDate(date).getDate()}日`;
const projectFor = (id) => state.projects.find((p) => p.id === id);
let state;
let pendingImport = null;
let importBusy = false;
let toastTimer;
let rawStored = null;
let ui = { view: 'calendar', selectedDate: today, year: parseDate(today).getFullYear(), month: parseDate(today).getMonth(), projectId: null, filter: 'all', sidebarOpen: false };

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('visible'), 3500);
}
function errorMessage(message) {
  const target = $('#form-error', modal);
  if (modal.open && target) { target.textContent = message; target.hidden = false; }
  else toast(message);
}
function commit(change, message) {
  try {
    const next = typeof change === 'function' ? structuredClone(state) : change;
    if (typeof change === 'function') change(next);
    state = persist(localStorage, next);
    render();
    if (message) toast(message);
    return true;
  } catch (error) {
    errorMessage(error.name === 'QuotaExceededError'
      ? '浏览器存储空间不足，未保存此次修改。请先导出备份，再清理不需要的数据。'
      : `未能保存：${error.message}`);
    return false;
  }
}
function touchProject(next, projectId) {
  const project = next.projects.find((p) => p.id === projectId);
  if (project) project.isDemo = false;
}
function showModal(title, subtitle, body, wide = false) {
  pendingImport = null;
  modal.className = wide ? 'modal wide' : 'modal';
  modal.innerHTML = `<header class="modal-header"><div><h2 id="modal-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button type="button" class="icon-button" data-action="close-modal" aria-label="关闭弹窗">${icon('close')}</button></header>${body}`;
  modal.showModal();
  const field = $('[autofocus]', modal);
  if (field) field.focus();
}
function closeModal() {
  modal.close();
  pendingImport = null;
}
const formError = '<p id="form-error" class="form-error" role="alert" hidden></p>';
const formFooter = (label = '保存') => `<footer class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">取消</button><button type="submit" class="button primary">${label}</button></footer>`;

function sidebar() {
  const projects = state.projects.filter((p) => !p.archived);
  const archiveCount = state.projects.filter((p) => p.archived).length;
  return `<aside class="sidebar ${ui.sidebarOpen ? 'is-open' : ''}" aria-label="项目导航">
    <a class="brand" href="#" data-action="calendar" aria-label="序日，返回日历"><img src="/favicon.svg" alt="" width="39" height="39"><span>序日<small>让日常有序，让目标更近</small></span></a>
    <div class="workspace-label"><span class="avatar">我</span><div>我的个人空间<small>一点一滴，自有回响</small></div><span class="workspace-dot"></span></div>
    <nav class="primary-nav"><button class="nav-item ${ui.view === 'calendar' ? 'active' : ''}" data-action="calendar" ${ui.view === 'calendar' ? 'aria-current="page"' : ''}>${icon('calendar')}<span>日历计划</span><span class="nav-shortcut">日常</span></button></nav>
    <div class="sidebar-heading"><span>我的项目 <b>${projects.length}</b></span><button class="icon-button small" data-action="new-project" aria-label="新增项目" title="新增项目">${icon('plus')}</button></div>
    <nav class="project-nav" aria-label="我的项目">${projects.map((p) => {
      const stats = progress(projectItems(state, p.id));
      return `<button class="project-nav-item ${ui.view === 'project' && ui.projectId === p.id ? 'active' : ''}" data-action="open-project" data-id="${p.id}" ${ui.view === 'project' && ui.projectId === p.id ? 'aria-current="page"' : ''}><span class="project-symbol ${p.color}">${icon(p.color === 'lavender' ? 'book' : p.color === 'sage' ? 'target' : 'folder')}</span><span class="project-nav-text"><span>${esc(p.name)}</span><small>${p.deadline ? `${shortDate(p.deadline)} 截止` : '按自己的节奏前进'}</small></span><span class="project-count">${stats.completed}/${stats.total}</span></button>`;
    }).join('') || '<p class="sidebar-empty">把大目标，变成小行动。<br>点击 + 创建第一个项目</p>'}</nav>
    <button class="new-project-link" data-action="new-project">${icon('plus')}<span>新建一个项目</span></button>
    <button class="nav-item archived-nav ${ui.view === 'archive' ? 'active' : ''}" data-action="archive-view">${icon('archive')}<span>已归档</span><span class="archive-count">${archiveCount}</span></button>
    <div class="sidebar-bottom"><div class="quiet-card"><svg viewBox="0 0 180 72" fill="none" aria-hidden="true"><path d="M16 62h147M40 61C40 38 57 24 80 24s40 15 40 37" stroke="#B3BA9C" stroke-width="1.2"/><path d="M53 61c0-16 11-28 27-28s28 12 28 28" stroke="#C4C9B0" stroke-width="1.2"/><path d="M67 61c0-8 5-14 13-14s14 6 14 14" stroke="#D1D5BF" stroke-width="1.2"/><circle cx="134" cy="24" r="9" fill="#E6C492"/><path d="m131 51 5-13m-5 13 12-5m-12 5-5-6" stroke="#9BAA8D" stroke-width="1.2"/></svg><p>不必赶路，先走好今天。</p><span>每一个小小的完成，都算数。</span></div>
    <button class="backup-nav" data-action="backup">${icon('laptop')}<span>数据与备份<small>安心保存在此浏览器</small></span>${icon('chevron')}</button></div>
  </aside>${ui.sidebarOpen ? '<button class="sidebar-scrim" data-action="close-sidebar" aria-label="收起项目栏"></button>' : ''}`;
}
function header() {
  const name = ui.view === 'project' ? projectFor(ui.projectId)?.name : ui.view === 'archive' ? '已归档项目' : '日历计划';
  return `<header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" data-action="toggle-sidebar" aria-label="打开项目栏">${icon('menu')}</button><span>我的空间</span><span class="breadcrumb-slash">/</span><strong>${esc(name)}</strong></div><div class="topbar-actions"><span class="saved-status">${icon('checkCircle')}已自动保存</span><button class="icon-button help-button" data-action="help" aria-label="使用帮助" title="使用帮助">${icon('help')}</button><span class="topbar-divider"></span><button class="button primary" data-action="new-event">${icon('plus')}<span>新建日程</span></button></div></header>`;
}
function metric(iconName, label, number, detail, color = 'sage') {
  return `<div class="metric"><span class="metric-icon ${color}">${icon(iconName)}</span><div><span class="metric-label">${label}</span><div class="metric-value">${number}<span>${detail}</span></div></div></div>`;
}
function calendarView() {
  const selected = dayItems(state, ui.selectedDate);
  const selectedStats = progress(selected);
  const todayStats = progress(dayItems(state, today));
  const activeCount = state.projects.filter((p) => !p.archived).length;
  const counts = new Map();
  state.items.forEach((item) => { if (item.date) { if (!counts.has(item.date)) counts.set(item.date, []); counts.get(item.date).push(item); } });
  const years = Array.from({ length: 201 }, (_, i) => 1900 + i);
  const hasExamples = state.projects.some((p) => p.isDemo) || state.items.some((item) => item.isDemo);
  const selectedLabel = `${dateText(ui.selectedDate)} · ${weekdays[parseDate(ui.selectedDate).getDay()]}`;
  return `<section class="page-intro"><div><p class="eyebrow">YOUR DAYS, YOUR PACE</p><h1 id="page-title" tabindex="-1">给每一天，留一点从容<span class="heading-dot">。</span></h1><p class="intro-copy">${dateText(today, true)}，${weekdays[parseDate(today).getDay()]}<span class="intro-separator">·</span>把想做的事，慢慢变成日常。</p></div><div class="intro-art" aria-hidden="true">${icon('leaf')}<span>一步一步<br>也能走很远</span></div></section>
    <section class="metrics" aria-label="计划概览">${metric('calendar', '今日安排', todayStats.total, '项小计划')}${metric('checkCircle', '今日已完成', todayStats.completed, `/ ${todayStats.total} 项`, 'clay')}${metric('folder', '进行中的项目', activeCount, '个目标', 'blue')}</section>
    <section class="calendar-card panel" aria-label="月历"><div class="calendar-toolbar"><div class="month-picker"><label class="sr-only" for="calendar-year">年份</label><select id="calendar-year" aria-label="年份">${years.map((year) => `<option value="${year}" ${year === ui.year ? 'selected' : ''}>${year} 年</option>`).join('')}</select><label class="sr-only" for="calendar-month">月份</label><select id="calendar-month" aria-label="月份">${Array.from({ length: 12 }, (_, i) => `<option value="${i}" ${i === ui.month ? 'selected' : ''}>${i + 1} 月</option>`).join('')}</select><span class="month-note">让计划有迹可循</span></div><div class="month-actions"><span class="calendar-legend"><span></span>有安排</span><div class="calendar-pager"><button class="icon-button" data-action="prev-month" aria-label="上个月" ${ui.year === 1900 && ui.month === 0 ? 'disabled' : ''}>${icon('chevron', 'rotate')}</button><button class="today-button" data-action="today">今天</button><button class="icon-button" data-action="next-month" aria-label="下个月" ${ui.year === 2100 && ui.month === 11 ? 'disabled' : ''}>${icon('chevron')}</button></div></div></div>
    <div class="weekdays" aria-hidden="true">${['一', '二', '三', '四', '五', '六', '日'].map((day) => `<span>${day}</span>`).join('')}</div>
    <div class="calendar-grid" role="group" aria-label="选择日期">${monthDays(ui.year, ui.month).map((date) => {
      const inMonth = parseDate(date).getMonth() === ui.month;
      const items = (counts.get(date) || []).sort((a, b) => a.start.localeCompare(b.start));
      const isToday = date === today;
      const isSelected = date === ui.selectedDate;
      return `<button class="calendar-day ${inMonth ? '' : 'other-month'} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}" data-action="select-date" data-date="${date}" aria-label="${dateText(date, true)}${isToday ? '，今天' : ''}，${items.length} 项安排" aria-pressed="${isSelected}" ${!validDate(date) ? 'disabled' : ''}><span class="day-top"><span class="day-number">${parseDate(date).getDate()}</span>${isSelected ? `<span class="selected-label">${isToday ? '今天' : '已选择'}</span>` : ''}</span><span class="day-events">${items.slice(0, 1).map((item) => `<span class="day-event ${projectFor(item.projectId)?.color || 'blue'} ${item.completed ? 'completed' : ''}"><i></i><span>${esc(item.title)}</span></span>`).join('')}${items.length > 1 ? `<span class="more-events" title="另 ${items.length - 1} 项安排">+${items.length - 1}</span>` : ''}</span></button>`;
    }).join('')}</div><div class="calendar-footnote"><span>${icon('info')}点击日期，看看这一天的安排</span><span>${ui.month + 1} 月共 ${state.items.filter((item) => item.date?.startsWith(`${ui.year}-${String(ui.month + 1).padStart(2, '0')}`)).length} 项日程</span></div></section>
    <section class="schedule-section" aria-label="当天时间表"><div class="section-heading"><div><div class="section-eyebrow">DAILY SCHEDULE</div><h2>${selectedLabel}${ui.selectedDate === today ? '<span class="today-tag">今天</span>' : ''}</h2></div><button class="button secondary" data-action="new-event">${icon('plus')}添加日程</button></div><div class="schedule-card panel"><div class="schedule-summary"><span><i class="small-dot"></i>这一天的时间表</span><span>${selected.length ? `${selected.length} 项安排 <span class="muted">/ 已完成 ${selectedStats.completed} 项</span>` : '给生活留一点空白'}</span></div>${selected.length ? `<div class="timeline">${selected.map((item) => scheduleRow(item, selected)).join('')}</div><div class="schedule-finish"><span>今日进度</span><div class="progress-track"><span style="width:${selectedStats.percent}%"></span></div><b>${selectedStats.percent}%</b><span class="finish-copy">${selectedStats.percent === 100 ? '都完成啦，记得给自己一个肯定。' : '不着急，按自己的节奏来。'}</span></div>` : emptyState('calendar', '这一天，还可以自由安排', '添一件想做的小事，让计划从这里开始。', '添加第一条日程', 'new-event')}</div></section>
    ${hasExamples ? '<div class="example-note"><span>这是为你准备的示例计划，可以直接编辑，也可以从空白开始。</span><button data-action="clear-examples">清除示例</button></div>' : ''}<p class="page-bottom-note">每一个认真度过的今天，都是未来的序章。</p>`;
}
function emptyState(iconName, title, copy, button, action) {
  return `<div class="empty-state"><span class="empty-icon">${icon(iconName)}</span><h3>${title}</h3><p>${copy}</p>${button ? `<button class="button secondary" data-action="${action}">${icon('plus')}${button}</button>` : ''}</div>`;
}
function itemActions(item) {
  return `<div class="item-actions"><button class="icon-button" data-action="edit-item" data-id="${item.id}" aria-label="编辑：${esc(item.title)}" title="编辑">${icon('edit')}</button><button class="icon-button danger-icon" data-action="delete-item" data-id="${item.id}" aria-label="删除：${esc(item.title)}" title="删除">${icon('trash')}</button></div>`;
}
function completeBox(item) {
  return `<label class="completion-control" title="${item.completed ? '标为未完成' : '标为完成'}"><input type="checkbox" data-complete="${item.id}" aria-label="完成：${esc(item.title)}" ${item.completed ? 'checked' : ''}><span>${icon('check')}</span></label>`;
}
function scheduleRow(item, allItems) {
  const p = projectFor(item.projectId);
  const conflict = !item.completed && allItems.some((other) => other.id !== item.id && !other.completed && item.start < other.end && other.start < item.end);
  return `<article class="schedule-row ${item.completed ? 'is-complete' : ''}" data-item-id="${item.id}"><div class="time-label"><strong>${item.start}</strong><span>${item.end}</span></div><div class="timeline-rail"><span class="${p?.color || 'blue'}"></span></div><div class="schedule-item ${p?.color || 'blue'}">${completeBox(item)}<div class="item-content"><span class="item-title">${esc(item.title)}</span><div class="item-meta">${p ? `<button class="project-tag ${p.color}" data-action="open-project" data-id="${p.id}"><i></i>${esc(p.name)}${p.archived ? ' · 已归档' : ''}</button>` : '<span class="independent-tag">个人日程</span>'}${item.notes ? `<span class="item-note">${esc(item.notes)}</span>` : ''}${conflict ? '<span class="conflict-tag">时间有重叠</span>' : ''}</div></div>${itemActions(item)}</div></article>`;
}
function projectView() {
  const p = projectFor(ui.projectId);
  if (!p) { ui.view = 'calendar'; return calendarView(); }
  const items = projectItems(state, p.id);
  const stats = progress(items);
  const filtered = items.filter((item) => ui.filter === 'all' || (ui.filter === 'done' ? item.completed : !item.completed));
  const days = p.deadline ? daysBetween(today, p.deadline) : null;
  return `<section class="page-intro project-intro"><div><p class="eyebrow">ONE STEP CLOSER</p><h1 id="page-title" tabindex="-1"><span class="project-heading-icon ${p.color}">${icon(p.color === 'sage' ? 'target' : p.color === 'lavender' ? 'book' : 'folder')}</span>${esc(p.name)}${p.archived ? '<span class="neutral-tag">已归档</span>' : ''}</h1><p class="intro-copy">把一个大目标，拆成每一天的小小行动。</p></div><div class="project-header-actions"><button class="button secondary" data-action="edit-project" data-id="${p.id}">${icon('edit')}编辑项目</button><button class="icon-button" data-action="${p.archived ? 'restore-project' : 'archive-project'}" data-id="${p.id}" aria-label="${p.archived ? '恢复项目' : '归档项目'}" title="${p.archived ? '恢复项目' : '归档项目'}">${icon(p.archived ? 'restore' : 'archive')}</button></div></section>
    <section class="project-overview panel"><div class="project-goal"><span class="section-eyebrow">THE BIG PICTURE</span><h2>想要抵达的地方</h2><p>${p.goal ? esc(p.goal) : '写下想实现的目标，让每一步都有方向。'}</p><div class="deadline"><span>${icon('calendar')}截止日期</span><strong>${p.deadline ? dateText(p.deadline, true) : '暂未设置'}</strong>${days !== null ? `<span class="deadline-pill ${days < 0 ? 'overdue' : ''}">${days < 0 ? `已过 ${-days} 天` : days === 0 ? '就在今天' : `还有 ${days} 天`}</span>` : ''}</div></div><div class="project-progress"><div class="progress-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="#edf0eb" stroke-width="7"/><circle cx="60" cy="60" r="50" fill="none" stroke="var(--green)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${stats.percent * Math.PI} 314.16" transform="rotate(-90 60 60)"/></svg><strong>${stats.percent}<small>%</small></strong></div><span>目标完成度</span><small>${stats.completed} / ${stats.total} 项任务已完成</small></div></section>
    <section class="metrics project-metrics" aria-label="项目进度">${metric('folder', '全部任务', stats.total, '项')}${metric('checkCircle', '已完成', stats.completed, '项', 'clay')}${metric('calendar', '已安排到日历', items.filter((item) => item.date).length, '项', 'blue')}</section>
    <section class="project-task-section"><div class="section-heading"><div><span class="section-eyebrow">SMALL STEPS, BIG CHANGES</span><h2>一步一步，完成计划</h2></div><button class="button primary" data-action="new-task" data-id="${p.id}">${icon('plus')}添加任务</button></div><div class="panel task-panel"><div class="task-tabs" role="group" aria-label="筛选任务">${[['all', '全部任务', stats.total], ['pending', '待完成', stats.total - stats.completed], ['done', '已完成', stats.completed]].map(([key, label, count]) => `<button class="task-tab ${ui.filter === key ? 'active' : ''}" data-action="filter" data-filter="${key}" aria-pressed="${ui.filter === key}">${label}<span>${count}</span></button>`).join('')}</div>${filtered.length ? `<div class="task-list">${filtered.map((item) => `<article class="task-row ${item.completed ? 'is-complete' : ''}" data-item-id="${item.id}">${completeBox(item)}<div class="item-content"><span class="item-title">${esc(item.title)}</span>${item.notes ? `<p class="task-notes">${esc(item.notes)}</p>` : ''}<div class="item-meta">${item.date ? `<button class="task-date" data-action="go-item-date" data-id="${item.id}">${icon('calendar')}${dateText(item.date)}<span>${item.start}–${item.end}</span>${icon('arrow')}</button>` : `<button class="unscheduled-button" data-action="schedule-item" data-id="${item.id}">${icon('clock')}安排时间</button>`}</div></div>${itemActions(item)}</article>`).join('')}</div>` : emptyState('leaf', items.length ? '这里的任务都处理好啦' : '每个目标，都从第一步开始', items.length ? '切换筛选，查看其他任务。' : '添加任务，再把它安排到合适的一天。', items.length ? '' : '添加第一个任务', 'new-task')}</div><p class="section-tip">${icon('info')}安排好日期和时间的任务，会自动出现在日历中；两处修改始终同步。</p></section>`;
}
function archiveView() {
  const projects = state.projects.filter((p) => p.archived);
  return `<section class="page-intro"><div><p class="eyebrow">ROOM FOR WHAT'S NEXT</p><h1 id="page-title" tabindex="-1">收好走过的每一步<span class="heading-dot">。</span></h1><p class="intro-copy">归档的项目依然留在这里，需要时随时继续。</p></div></section><div class="archive-grid">${projects.length ? projects.map((p) => {
    const stats = progress(projectItems(state, p.id));
    return `<article class="panel archive-card"><span class="project-symbol ${p.color}">${icon('folder')}</span><h2>${esc(p.name)}</h2><p>${esc(p.goal || '每一段努力，都值得被记住。')}</p><div class="archive-progress"><span>${stats.completed} / ${stats.total} 项任务</span><b>${stats.percent}%</b></div><div class="progress-track"><span style="width:${stats.percent}%"></span></div><div class="archive-card-actions"><button class="button secondary" data-action="open-project" data-id="${p.id}">查看项目</button><button class="text-button" data-action="restore-project" data-id="${p.id}">${icon('restore')}恢复</button></div></article>`;
  }).join('') : `<div class="panel archive-empty">${emptyState('archive', '这里还没有归档的项目', '在项目详情右上角归档项目，给新的目标腾点位置。', '', '')}</div>`}</div>`;
}
function render() {
  const focus = document.activeElement;
  const focusId = focus?.id;
  const focusAction = focus?.dataset?.action;
  const focusDate = focus?.dataset?.date;
  const focusComplete = focus?.dataset?.complete;
  app.innerHTML = `${sidebar()}<div class="main-shell">${header()}<main id="main" class="main-content">${ui.view === 'project' ? projectView() : ui.view === 'archive' ? archiveView() : calendarView()}</main><footer class="site-footer"><span>序日 <span class="footer-dot">·</span> 为日常留白，为目标落笔</span><button data-action="help">使用指南 ${icon('arrow')}</button></footer></div>`;
  try { sessionStorage.setItem('xuri.view', JSON.stringify({ ...ui, sidebarOpen: false })); } catch { /* View preferences are optional. */ }
  if (!modal.open) {
    let selector = focusId ? `#${CSS.escape(focusId)}` : focusComplete ? `[data-complete="${CSS.escape(focusComplete)}"]` : focusDate ? `[data-date="${focusDate}"]` : focusAction ? `[data-action="${focusAction}"]` : null;
    if (selector) $(selector, app)?.focus({ preventScroll: true });
  }
}
function navigate(view, projectId = null) {
  ui.view = view;
  ui.projectId = projectId;
  ui.filter = 'all';
  ui.sidebarOpen = false;
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  $('#page-title')?.focus({ preventScroll: true });
}
function selectDate(date, scroll = false) {
  if (!validDate(date)) return;
  ui.selectedDate = date;
  ui.year = parseDate(date).getFullYear();
  ui.month = parseDate(date).getMonth();
  ui.view = 'calendar';
  ui.sidebarOpen = false;
  render();
  if (scroll) $('.schedule-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function projectForm(project = null) {
  showModal(project ? '编辑项目' : '一个新目标，从这里开始', '把大事写下来，再拆成每一天的小行动。', `<form data-form="project" data-id="${project?.id || ''}"><div class="modal-body">${formError}<label class="field">项目名称 <span class="required">*</span><input name="name" required maxlength="80" placeholder="例如：六级考试、XX 项目提交" value="${esc(project?.name || '')}" autofocus></label><label class="field">项目目标<textarea name="goal" rows="3" maxlength="2000" placeholder="你希望实现什么？给未来的自己一点方向。">${esc(project?.goal || '')}</textarea></label><label class="field">截止日期 <span class="field-optional">选填</span><input type="date" name="deadline" min="1900-01-01" max="2100-12-31" value="${project?.deadline || ''}"></label><fieldset class="color-field"><legend>选一个项目颜色</legend><div class="color-options">${COLORS.map((color) => `<label class="color-option ${color}" title="${COLOR_LABELS[color]}"><input type="radio" name="color" value="${color}" ${(project?.color || 'sage') === color ? 'checked' : ''} aria-label="${COLOR_LABELS[color]}"><span>${icon('check')}</span></label>`).join('')}</div></fieldset></div>${formFooter(project ? '保存修改' : '创建项目')}</form>`);
}
function itemForm(item = null, projectId = null, forceSchedule = false) {
  const association = item ? item.projectId : projectId;
  const scheduled = !!item?.date || !association || forceSchedule;
  const isTask = !!association;
  const projectOptions = state.projects.filter((p) => !p.archived || p.id === association);
  showModal(item ? '编辑任务与日程' : isTask ? '把目标，拆成小小一步' : '给这一天添个小计划', '项目任务与日历使用同一份记录，修改会自动同步。', `<form data-form="item" data-id="${item?.id || ''}"><div class="modal-body">${formError}<label class="field">${isTask ? '任务' : '日程'}名称 <span class="required">*</span><input name="title" required maxlength="120" placeholder="这次想完成什么？" value="${esc(item?.title || '')}" autofocus></label><label class="field">关联项目<select name="projectId" id="item-project"><option value="">不关联项目 · 独立日程</option>${projectOptions.map((p) => `<option value="${p.id}" ${p.id === association ? 'selected' : ''}>${esc(p.name)}${p.archived ? '（已归档）' : ''}</option>`).join('')}</select></label><div class="schedule-toggle"><label><input type="checkbox" id="item-scheduled" name="scheduled" ${scheduled ? 'checked' : ''} ${!association ? 'disabled' : ''}>${icon('calendar')}安排到日历</label><small id="schedule-hint">${association ? '也可以先存为任务，之后再安排时间。' : '独立日程需要填写日期与时间。'}</small></div><div id="schedule-fields" ${scheduled ? '' : 'hidden'}><label class="field">日期 <span class="required">*</span><input type="date" name="date" min="1900-01-01" max="2100-12-31" value="${item?.date || ui.selectedDate}" ${scheduled ? 'required' : 'disabled'}></label><div class="field-row"><label class="field">开始时间 <span class="required">*</span><input type="time" name="start" value="${item?.start || '09:00'}" ${scheduled ? 'required' : 'disabled'}></label><span class="time-separator">—</span><label class="field">结束时间 <span class="required">*</span><input type="time" name="end" value="${item?.end || '10:00'}" ${scheduled ? 'required' : 'disabled'}></label></div><p class="field-hint">仅支持当天的时间段；跨天安排请拆成两条日程。</p></div><label class="field">备注 <span class="field-optional">选填</span><textarea name="notes" rows="2" maxlength="2000" placeholder="记下一些小提示……">${esc(item?.notes || '')}</textarea></label><label class="completed-field"><input type="checkbox" name="completed" ${item?.completed ? 'checked' : ''}>这件事已经完成</label></div>${formFooter(item ? '保存修改' : isTask ? '添加任务' : '添加日程')}</form>`);
}
function updateScheduleFields() {
  const project = $('#item-project', modal).value;
  const checkbox = $('#item-scheduled', modal);
  if (!project) checkbox.checked = true;
  checkbox.disabled = !project;
  $('#schedule-hint', modal).textContent = project ? '也可以先存为任务，之后再安排时间。' : '独立日程需要填写日期与时间。';
  $('#schedule-fields', modal).hidden = !checkbox.checked;
  $('#schedule-fields', modal).querySelectorAll('input').forEach((input) => { input.disabled = !checkbox.checked; input.required = checkbox.checked; });
}
function confirmAction(title, description, button, action, id = '', danger = false) {
  showModal(title, '', `<div class="modal-body confirm-body">${formError}<div class="confirm-symbol ${danger ? 'danger' : ''}">${icon(danger ? 'trash' : 'archive')}</div><p>${esc(description)}</p></div><footer class="modal-footer"><button type="button" class="button secondary" data-action="close-modal">取消</button><button type="button" class="button ${danger ? 'danger' : 'primary'}" data-action="${action}" data-id="${id}">${button}</button></footer>`);
}
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function backupDialog() {
  showModal('给每一份计划，留个备份', '数据自动保存在当前浏览器中，无需注册或登录。', `<div class="modal-body backup-body">${formError}<div class="backup-status"><span class="metric-icon sage">${icon('checkCircle')}</span><div><strong>你的计划，已在本地安放妥当</strong><p>${state.projects.length} 个项目 · ${state.items.length} 条任务与日程</p></div></div><section class="backup-block"><h3>${icon('download')}导出备份</h3><p>下载一份 JSON 文件，保留项目、任务、日程和完成状态。</p><button class="button secondary" data-action="export">${icon('download')}下载完整备份</button></section><section class="backup-block"><h3>${icon('upload')}导入备份</h3><p>选择之前导出的文件，检查内容后再确认导入。</p><label class="file-picker">${icon('upload')}<span>选择备份文件<small>JSON 格式，最大 5 MB</small></span><input type="file" id="import-file" accept=".json,application/json" aria-label="选择备份文件"></label><div id="import-preview" hidden></div></section><p class="storage-note">${icon('info')}请使用相同的浏览器和访问地址。清除浏览器网站数据、使用隐私模式或更换设备可能丢失本地记录，建议定期导出备份。导出的文件包含你的计划内容，请妥善保管。</p></div><footer class="modal-footer"><button type="button" class="button primary" data-action="close-modal">知道了</button></footer>`, true);
}
async function readImport(file) {
  pendingImport = null;
  const preview = $('#import-preview', modal);
  preview.hidden = true;
  const error = $('#form-error', modal);
  error.hidden = true;
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { errorMessage('备份文件超过 5 MB，请选择较小的序日备份。'); return; }
  importBusy = true;
  try {
    const value = await file.text();
    if (!modal.open || !preview.isConnected) return;
    pendingImport = validateSnapshot(JSON.parse(value));
    preview.innerHTML = `<div class="import-file-info">${icon('checkCircle')}<div><strong>${esc(file.name)}</strong><span>${pendingImport.projects.length} 个项目 · ${pendingImport.items.length} 条任务与日程</span></div></div><fieldset class="import-modes"><legend>导入方式</legend><label><input type="radio" name="import-mode" value="merge" checked><span>合并到当前计划<small>保留其他记录；编号相同的记录以备份为准。</small></span></label><label><input type="radio" name="import-mode" value="replace"><span>替换当前全部数据<small>覆盖现有计划。请先导出当前备份。</small></span></label></fieldset><button class="button primary" data-action="import">确认导入</button>`;
    preview.hidden = false;
  } catch (error) {
    errorMessage(error instanceof SyntaxError ? '文件不是有效的 JSON，请选择从序日导出的备份文件。' : error.message);
  } finally { importBusy = false; }
}
function helpDialog() {
  showModal('你好，欢迎来到序日', '不必一次安排好所有事。先从今天的一件小事开始。', `<div class="modal-body help-body"><div class="help-step"><span>01</span><div><h3>大事，放进项目里</h3><p>点击左侧「新建一个项目」，填写目标和截止日期。打开项目后添加任务；右上角可以编辑或归档项目。</p></div></div><div class="help-step"><span>02</span><div><h3>小事，安排到时间里</h3><p>点击月历中的一天，再点击「添加日程」。不关联项目就是独立日程；项目任务点击「安排时间」，也会自动出现在日历中。</p></div></div><div class="help-step"><span>03</span><div><h3>做完，给自己一个肯定</h3><p>勾选任务左侧的小方框，项目进度与日历会同步更新。点击铅笔编辑，点击垃圾桶删除。</p></div></div><div class="help-step"><span>04</span><div><h3>计划会留下，也记得备份</h3><p>修改后会立即自动保存，刷新或重新打开页面仍然保留。在左下角「数据与备份」中导出或导入文件。相同浏览器和访问地址才能读取同一份数据。</p></div></div><p class="help-signoff">一步一步，也能走很远。${icon('leaf')}</p></div><footer class="modal-footer"><button type="button" class="button primary" data-action="close-modal">开始我的计划 ${icon('arrow')}</button></footer>`, true);
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  event.preventDefault();
  const { action, id, date, filter } = button.dataset;
  const item = id ? state?.items.find((i) => i.id === id) : null;
  const project = id ? projectFor(id) : null;
  switch (action) {
    case 'calendar': navigate('calendar'); break;
    case 'open-project': navigate('project', id); break;
    case 'archive-view': navigate('archive'); break;
    case 'toggle-sidebar': ui.sidebarOpen = !ui.sidebarOpen; render(); break;
    case 'close-sidebar': ui.sidebarOpen = false; render(); break;
    case 'new-project': projectForm(); break;
    case 'edit-project': if (project) projectForm(project); break;
    case 'new-event': itemForm(); break;
    case 'new-task': itemForm(null, id || ui.projectId); break;
    case 'edit-item': if (item) itemForm(item); break;
    case 'schedule-item': if (item) itemForm(item, item.projectId, true); break;
    case 'filter': ui.filter = filter; render(); break;
    case 'select-date': selectDate(date); break;
    case 'go-item-date': if (item?.date) selectDate(item.date, true); break;
    case 'today': selectDate(today); break;
    case 'prev-month':
    case 'next-month': {
      const d = new Date(ui.year, ui.month + (action === 'prev-month' ? -1 : 1), 1);
      if (d.getFullYear() < 1900 || d.getFullYear() > 2100) break;
      ui.year = d.getFullYear(); ui.month = d.getMonth(); render(); break;
    }
    case 'close-modal': closeModal(); break;
    case 'archive-project': if (project) confirmAction('给这段计划，暂时画个逗号', `归档「${project.name}」后，可以在左侧「已归档」中恢复。已有任务和日历中的日程都会保留。`, '归档项目', 'confirm-archive', id); break;
    case 'confirm-archive':
      if (commit((next) => { const p = next.projects.find((p) => p.id === id); p.archived = true; p.isDemo = false; }, '项目已归档，随时可以恢复')) { closeModal(); navigate('archive'); }
      break;
    case 'restore-project': if (commit((next) => { const p = next.projects.find((p) => p.id === id); p.archived = false; p.isDemo = false; }, '项目已恢复')) navigate('project', id); break;
    case 'delete-item': if (item) confirmAction('删除这条计划？', `「${item.title}」会从项目任务和当天时间表中同时移除，此操作无法撤销。`, '确认删除', 'confirm-delete', id, true); break;
    case 'confirm-delete': if (commit((next) => { next.items = next.items.filter((i) => i.id !== id); }, '这条计划已删除')) closeModal(); break;
    case 'clear-examples': confirmAction('从一张空白日历开始？', '仅清除尚未修改的示例项目和示例任务。你自己新增或修改的记录会保留。', '清除示例', 'confirm-clear-examples', '', true); break;
    case 'confirm-clear-examples': if (commit(removeExamples(state), '示例已清除，开始自己的计划吧')) closeModal(); break;
    case 'backup': backupDialog(); break;
    case 'help': helpDialog(); break;
    case 'export': download(`序日备份-${today}.json`, JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2)); toast('备份已生成，请妥善保存下载的文件'); break;
    case 'import': {
      if (importBusy || !pendingImport) break;
      const mode = $('input[name="import-mode"]:checked', modal).value;
      const incoming = pendingImport;
      const next = mode === 'merge' ? () => mergeSnapshots(state, incoming) : () => incoming;
      // Compute and validate before writing; an invalid import never replaces existing data.
      try {
        if (commit(next(), '备份已导入，所有视图已同步更新')) {
          closeModal();
          if (ui.view === 'project' && !projectFor(ui.projectId)) navigate('calendar');
        }
      } catch (error) { errorMessage(error.message); }
      break;
    }
    case 'download-recovery': download('序日-原始数据备份.txt', rawStored || '', 'text/plain'); break;
    case 'reset-recovery':
      confirmAction('重置无法读取的本地数据？', '建议先下载原始数据备份。重置后将清空当前无法读取的记录，无法撤销。', '确认重置', 'confirm-reset-recovery', '', true); break;
    case 'confirm-reset-recovery':
      try { state = persist(localStorage, { version: 1, projects: [], items: [] }); closeModal(); render(); toast('本地数据已重置'); }
      catch (error) { errorMessage(`无法写入浏览器存储：${error.message}`); }
      break;
  }
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset.complete) {
    const itemId = target.dataset.complete;
    const completed = target.checked;
    if (!commit((next) => {
      const item = next.items.find((i) => i.id === itemId);
      item.completed = completed;
      item.isDemo = false;
      touchProject(next, item.projectId);
    }, completed ? '又完成了一件小事，真好。' : '已标记为未完成')) target.checked = !completed;
  } else if (target.id === 'calendar-year' || target.id === 'calendar-month') {
    ui.year = Number($('#calendar-year').value); ui.month = Number($('#calendar-month').value); render();
  } else if (target.id === 'item-project' || target.id === 'item-scheduled') updateScheduleFields();
  else if (target.id === 'import-file') readImport(target.files[0]);
});
modal.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const id = form.dataset.id;
  if (form.dataset.form === 'project') {
    const project = { id: id || uid(), name: data.get('name').trim(), goal: data.get('goal').trim(), deadline: data.get('deadline') || null, color: data.get('color'), archived: id ? projectFor(id).archived : false, isDemo: false };
    if (commit((next) => {
      if (id) next.projects[next.projects.findIndex((p) => p.id === id)] = project;
      else next.projects.push(project);
    }, id ? '项目已更新' : '新目标，已经记下了')) { closeModal(); navigate('project', project.id); }
  } else if (form.dataset.form === 'item') {
    const projectId = data.get('projectId') || null;
    const scheduled = !projectId || $('#item-scheduled', modal).checked;
    const item = { id: id || uid(), title: data.get('title').trim(), projectId, date: scheduled ? data.get('date') : null, start: scheduled ? data.get('start') : null, end: scheduled ? data.get('end') : null, notes: data.get('notes').trim(), completed: data.has('completed'), isDemo: false };
    if (commit((next) => {
      if (id) { const index = next.items.findIndex((i) => i.id === id); touchProject(next, next.items[index].projectId); next.items[index] = item; }
      else next.items.push(item);
      touchProject(next, projectId);
    }, id ? '计划已更新，项目与日历已同步' : '新的小计划，安排好了')) {
      closeModal();
      if (ui.view === 'calendar' && item.date) selectDate(item.date);
    }
  }
});
// Native dialogs support Escape and trap keyboard focus. Only a true backdrop click closes one.
modal.addEventListener('click', (event) => {
  if (event.target === modal) {
    const rect = modal.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal();
  }
});
modal.addEventListener('close', () => { pendingImport = null; });
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && ui.sidebarOpen && !modal.open) { ui.sidebarOpen = false; render(); }
});
window.addEventListener('storage', (event) => {
  if (event.storageArea !== localStorage || (event.key !== STORAGE_KEY && event.key !== null)) return;
  if (modal.open) closeModal();
  if (!event.newValue) {
    recoveryScreen('本地数据在另一个页面中被清除了。请重新载入页面，或重置后从备份导入。');
    return;
  }
  try {
    state = validateSnapshot(JSON.parse(event.newValue));
    if (ui.view === 'project' && !projectFor(ui.projectId)) ui.view = 'calendar';
    render(); toast('另一个页面更新了计划，已同步。若刚才正在编辑，请重新打开。');
  } catch { recoveryScreen('另一个页面写入了无法读取的数据，已停止保存以保护记录。'); }
});
function recoveryScreen(message) {
  app.innerHTML = `<main class="recovery"><img src="/favicon.svg" alt="序日" width="52" height="52"><h1>先帮你保护好原来的计划</h1><p>${esc(message)}</p><p>不会自动覆盖现有记录。你可以下载原始数据，或重置后导入之前的备份。</p><div>${rawStored ? '<button class="button secondary" data-action="download-recovery">下载原始数据</button>' : ''}<button class="button primary" data-action="reset-recovery">重置本地数据</button></div></main>`;
}
function init() {
  try {
    rawStored = localStorage.getItem(STORAGE_KEY);
    state = rawStored === null ? persist(localStorage, createExamples()) : validateSnapshot(JSON.parse(rawStored));
    try {
      const preference = JSON.parse(sessionStorage.getItem('xuri.view'));
      if (preference && validDate(preference.selectedDate) && ['calendar', 'project', 'archive'].includes(preference.view)
        && Number.isInteger(preference.year) && preference.year >= 1900 && preference.year <= 2100
        && Number.isInteger(preference.month) && preference.month >= 0 && preference.month <= 11) {
        ui = { ...ui, selectedDate: preference.selectedDate, year: preference.year, month: preference.month, view: preference.view, projectId: projectFor(preference.projectId)?.id || null };
        if (ui.view === 'project' && !ui.projectId) ui.view = 'calendar';
      }
    } catch { /* Invalid UI preferences never affect user data. */ }
    render();
  } catch (error) {
    recoveryScreen(`无法读取或保存浏览器数据：${error.message}。请确认浏览器允许此网站使用本地存储。`);
  }
}
init();
