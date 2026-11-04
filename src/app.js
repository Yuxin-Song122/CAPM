import {
  STORAGE_KEY, COLORS, COLOR_LABELS, localDate, parseDate, validDate, uid,
  addDays, daysBetween, monthDays, projectItems, dayItems, progress,
  validateSnapshot, mergeSnapshots, removeExamples,
} from './model.js';
import { readDisk, writeDisk, isDeviceStorage } from './storage.js';
import { pwaStatus, requestPwaUpdate } from './pwa.js';

const $ = (selector, root = document) => root.querySelector(selector);
const app = $('#app');
const modal = $('#modal');
const today = localDate();
const savedLabel = () => isDeviceStorage ? '已保存到此设备' : '已保存到文件';
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
let revision;
let storagePath = '';
let saveBusy = false;
let saveStatus = 'saved';
let syncBusy = false;
let legacyPending = false;
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
function updateSaveStatus() {
  const element = $('.saved-status');
  if (!element) return;
  element.classList.toggle('save-error', saveStatus === 'error');
  element.innerHTML = `${icon(saveStatus === 'saved' ? 'checkCircle' : 'info')}${saveStatus === 'saving' ? '正在保存…' : saveStatus === 'error' ? '连接或保存失败' : savedLabel()}`;
  element.title = storagePath;
}
function applyDisk(result) {
  state = validateSnapshot(result.state);
  revision = result.revision;
  storagePath = result.storagePath;
}
async function commit(change, message) {
  if (saveBusy) return false;
  const disabled = new Map([...modal.querySelectorAll('button, input, select, textarea')].map((el) => [el, el.disabled]));
  saveBusy = true; saveStatus = 'saving';
  app.inert = true;
  disabled.forEach((value, el) => { el.disabled = true; });
  updateSaveStatus();
  try {
    const next = typeof change === 'function' ? structuredClone(state) : change;
    if (typeof change === 'function') change(next);
    applyDisk(await writeDisk(validateSnapshot(next), revision));
    saveStatus = 'saved';
    render();
    if (message) toast(message);
    return true;
  } catch (error) {
    saveStatus = 'error';
    if (error.status === 409 && error.current?.state) {
      applyDisk(error.current);
      if (modal.open) closeModal();
      render();
    }
    errorMessage(error.message);
    return false;
  } finally {
    saveBusy = false; app.inert = false;
    disabled.forEach((value, el) => { el.disabled = value; });
    updateSaveStatus();
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
  return `<aside id="project-sidebar" tabindex="-1" class="sidebar ${ui.sidebarOpen ? 'is-open' : ''}" aria-label="项目导航">
    <button class="icon-button drawer-close" data-action="close-sidebar" aria-label="关闭项目栏">${icon('close')}</button>
    <a class="brand" href="#" data-action="calendar" aria-label="序日，返回日历"><img src="./favicon.svg" alt="" width="39" height="39"><span>序日<small>日程与项目管理</small></span></a>
    <div class="workspace-label"><span class="avatar">我</span><div>我的个人空间<small>${isDeviceStorage ? '此设备本地存储' : '本机文件存储'}</small></div><span class="workspace-dot"></span></div>
    <nav class="primary-nav"><button class="nav-item ${ui.view === 'calendar' ? 'active' : ''}" data-action="calendar" ${ui.view === 'calendar' ? 'aria-current="page"' : ''}>${icon('calendar')}<span>日历计划</span><span class="nav-shortcut">日常</span></button></nav>
    <div class="sidebar-heading"><span>我的项目 <b>${projects.length}</b></span><button class="icon-button small" data-action="new-project" aria-label="新增项目" title="新增项目">${icon('plus')}</button></div>
    <nav class="project-nav" aria-label="我的项目">${projects.map((p) => {
      const stats = progress(projectItems(state, p.id));
      return `<button class="project-nav-item ${ui.view === 'project' && ui.projectId === p.id ? 'active' : ''}" data-action="open-project" data-id="${p.id}" ${ui.view === 'project' && ui.projectId === p.id ? 'aria-current="page"' : ''}><span class="project-symbol ${p.color}">${icon(p.color === 'lavender' ? 'book' : p.color === 'sage' ? 'target' : 'folder')}</span><span class="project-nav-text"><span>${esc(p.name)}</span><small>${p.deadline ? `${shortDate(p.deadline)} 截止` : '未设置截止日期'}</small></span><span class="project-count">${stats.completed}/${stats.total}</span></button>`;
    }).join('') || '<p class="sidebar-empty">暂无项目，点击 + 新增</p>'}</nav>
    <button class="new-project-link" data-action="new-project">${icon('plus')}<span>新建一个项目</span></button>
    <button class="nav-item archived-nav ${ui.view === 'archive' ? 'active' : ''}" data-action="archive-view">${icon('archive')}<span>已归档</span><span class="archive-count">${archiveCount}</span></button>
    <div class="sidebar-bottom"><button class="backup-nav" data-action="backup">${icon('laptop')}<span>数据与备份<small>${isDeviceStorage ? '保存到此设备' : '保存到本机文件'}</small></span>${icon('chevron')}</button></div>
  </aside>${ui.sidebarOpen ? '<button class="sidebar-scrim" data-action="close-sidebar" aria-label="收起项目栏"></button>' : ''}`;
}
function header() {
  const name = ui.view === 'project' ? projectFor(ui.projectId)?.name : ui.view === 'archive' ? '已归档项目' : '日历计划';
  return `<header class="topbar"><div class="breadcrumb"><button class="icon-button mobile-menu" data-action="toggle-sidebar" aria-label="打开项目栏" aria-controls="project-sidebar" aria-expanded="${ui.sidebarOpen}">${icon('menu')}</button><span>我的空间</span><span class="breadcrumb-slash">/</span><strong>${esc(name)}</strong></div><div class="topbar-actions"><span class="saved-status">${icon('checkCircle')}${savedLabel()}</span><button class="icon-button help-button" data-action="help" aria-label="使用帮助" title="使用帮助">${icon('help')}</button><span class="topbar-divider"></span><button class="button primary" data-action="new-event">${icon('plus')}<span>新建日程</span></button></div></header>`;
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
  return `<section class="page-intro calendar-intro"><div><h1 id="page-title" tabindex="-1">日历计划</h1><p class="intro-copy">${dateText(today, true)} · ${weekdays[parseDate(today).getDay()]}</p></div><div class="intro-date-info">项目任务与独立日程</div></section>
    <section class="metrics" aria-label="计划概览">${metric('calendar', '今日安排', todayStats.total, '项')}${metric('checkCircle', '今日已完成', todayStats.completed, `/ ${todayStats.total} 项`, 'clay')}${metric('folder', '进行中的项目', activeCount, '个', 'blue')}</section>
    <section class="calendar-card panel" aria-label="月历"><div class="calendar-toolbar"><div class="month-picker"><label class="sr-only" for="calendar-year">年份</label><select id="calendar-year" aria-label="年份">${years.map((year) => `<option value="${year}" ${year === ui.year ? 'selected' : ''}>${year} 年</option>`).join('')}</select><label class="sr-only" for="calendar-month">月份</label><select id="calendar-month" aria-label="月份">${Array.from({ length: 12 }, (_, i) => `<option value="${i}" ${i === ui.month ? 'selected' : ''}>${i + 1} 月</option>`).join('')}</select></div><div class="month-actions"><span class="calendar-legend"><span></span>有安排</span><div class="calendar-pager"><button class="icon-button" data-action="prev-month" aria-label="上个月" ${ui.year === 1900 && ui.month === 0 ? 'disabled' : ''}>${icon('chevron', 'rotate')}</button><button class="today-button" data-action="today">今天</button><button class="icon-button" data-action="next-month" aria-label="下个月" ${ui.year === 2100 && ui.month === 11 ? 'disabled' : ''}>${icon('chevron')}</button></div></div></div>
    <div class="weekdays" aria-hidden="true">${['一', '二', '三', '四', '五', '六', '日'].map((day) => `<span>${day}</span>`).join('')}</div>
    <div class="calendar-grid" role="group" aria-label="选择日期">${monthDays(ui.year, ui.month).map((date) => {
      const inMonth = parseDate(date).getMonth() === ui.month;
      const items = (counts.get(date) || []).sort((a, b) => a.start.localeCompare(b.start));
      const isToday = date === today;
      const isSelected = date === ui.selectedDate;
      return `<button class="calendar-day ${inMonth ? '' : 'other-month'} ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''}" data-action="select-date" data-date="${date}" aria-label="${dateText(date, true)}${isToday ? '，今天' : ''}，${items.length} 项安排" aria-pressed="${isSelected}" ${!validDate(date) ? 'disabled' : ''}><span class="day-top"><span class="day-number">${parseDate(date).getDate()}</span>${isSelected ? `<span class="selected-label">${isToday ? '今天' : '已选择'}</span>` : ''}</span><span class="day-events">${items.slice(0, 1).map((item) => `<span class="day-event ${projectFor(item.projectId)?.color || 'blue'} ${item.completed ? 'completed' : ''}"><i></i><span>${esc(item.title)}</span></span>`).join('')}${items.length > 1 ? `<span class="more-events" title="另 ${items.length - 1} 项安排">+${items.length - 1}</span>` : ''}</span></button>`;
    }).join('')}</div><div class="calendar-footnote"><span>${icon('info')}选择日期查看日程</span><span>${ui.month + 1} 月共 ${state.items.filter((item) => item.date?.startsWith(`${ui.year}-${String(ui.month + 1).padStart(2, '0')}`)).length} 项日程</span></div></section>
    <section class="schedule-section" aria-label="当天时间表"><div class="section-heading"><div><h2>${selectedLabel}${ui.selectedDate === today ? '<span class="today-tag">今天</span>' : ''}</h2></div><button class="button secondary" data-action="new-event">${icon('plus')}添加日程</button></div><div class="schedule-card panel"><div class="schedule-summary"><span><i class="small-dot"></i>这一天的时间表</span><span>${selected.length ? `${selected.length} 项安排 <span class="muted">/ 已完成 ${selectedStats.completed} 项</span>` : '暂无日程'}</span></div>${selected.length ? `<div class="timeline">${selected.map((item) => scheduleRow(item, selected)).join('')}</div><div class="schedule-finish"><span>完成进度</span><div class="progress-track"><span style="width:${selectedStats.percent}%"></span></div><b>${selectedStats.percent}%</b></div>` : emptyState('calendar', '当天暂无日程', '点击添加日程，或从项目中安排任务。', '添加第一条日程', 'new-event')}</div></section>
    ${hasExamples ? '<div class="example-note"><span>当前包含示例数据。</span><button data-action="clear-examples">清除示例</button></div>' : ''}`;
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
  return `<section class="page-intro project-intro"><div><h1 id="page-title" tabindex="-1"><span class="project-heading-icon ${p.color}">${icon(p.color === 'sage' ? 'target' : p.color === 'lavender' ? 'book' : 'folder')}</span>${esc(p.name)}${p.archived ? '<span class="neutral-tag">已归档</span>' : ''}</h1><p class="intro-copy">查看目标、截止日期与任务进度。</p></div><div class="project-header-actions"><button class="button secondary" data-action="edit-project" data-id="${p.id}">${icon('edit')}编辑项目</button><button class="icon-button" data-action="${p.archived ? 'restore-project' : 'archive-project'}" data-id="${p.id}" aria-label="${p.archived ? '恢复项目' : '归档项目'}" title="${p.archived ? '恢复项目' : '归档项目'}">${icon(p.archived ? 'restore' : 'archive')}</button></div></section>
    <section class="project-overview panel"><div class="project-goal"><h2>项目目标</h2><p>${p.goal ? esc(p.goal) : '未填写目标'}</p><div class="deadline"><span>${icon('calendar')}截止日期</span><strong>${p.deadline ? dateText(p.deadline, true) : '暂未设置'}</strong>${days !== null ? `<span class="deadline-pill ${days < 0 ? 'overdue' : ''}">${days < 0 ? `已过 ${-days} 天` : days === 0 ? '就在今天' : `还有 ${days} 天`}</span>` : ''}</div></div><div class="project-progress"><div class="progress-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="#edf0eb" stroke-width="7"/><circle cx="60" cy="60" r="50" fill="none" stroke="var(--accent)" stroke-width="7" stroke-linecap="round" stroke-dasharray="${stats.percent * Math.PI} 314.16" transform="rotate(-90 60 60)"/></svg><strong>${stats.percent}<small>%</small></strong></div><span>目标完成度</span><small>${stats.completed} / ${stats.total} 项任务已完成</small></div></section>
    <section class="metrics project-metrics" aria-label="项目进度">${metric('folder', '全部任务', stats.total, '项')}${metric('checkCircle', '已完成', stats.completed, '项', 'clay')}${metric('calendar', '已安排到日历', items.filter((item) => item.date).length, '项', 'blue')}</section>
    <section class="project-task-section"><div class="section-heading"><div><h2>任务清单</h2></div><button class="button primary" data-action="new-task" data-id="${p.id}">${icon('plus')}添加任务</button></div><div class="panel task-panel"><div class="task-tabs" role="group" aria-label="筛选任务">${[['all', '全部任务', stats.total], ['pending', '待完成', stats.total - stats.completed], ['done', '已完成', stats.completed]].map(([key, label, count]) => `<button class="task-tab ${ui.filter === key ? 'active' : ''}" data-action="filter" data-filter="${key}" aria-pressed="${ui.filter === key}">${label}<span>${count}</span></button>`).join('')}</div>${filtered.length ? `<div class="task-list">${filtered.map((item) => `<article class="task-row ${item.completed ? 'is-complete' : ''}" data-item-id="${item.id}">${completeBox(item)}<div class="item-content"><span class="item-title">${esc(item.title)}</span>${item.notes ? `<p class="task-notes">${esc(item.notes)}</p>` : ''}<div class="item-meta">${item.date ? `<button class="task-date" data-action="go-item-date" data-id="${item.id}">${icon('calendar')}${dateText(item.date)}<span>${item.start}–${item.end}</span>${icon('arrow')}</button>` : `<button class="unscheduled-button" data-action="schedule-item" data-id="${item.id}">${icon('clock')}安排时间</button>`}</div></div>${itemActions(item)}</article>`).join('')}</div>` : emptyState('leaf', items.length ? '暂无符合条件的任务' : '暂无任务', items.length ? '切换筛选，查看其他任务。' : '添加任务后可设置日期和时间。', items.length ? '' : '添加第一个任务', 'new-task')}</div><p class="section-tip">${icon('info')}安排好日期和时间的任务，会自动出现在日历中；两处修改始终同步。</p></section>`;
}
function archiveView() {
  const projects = state.projects.filter((p) => p.archived);
  return `<section class="page-intro"><div><h1 id="page-title" tabindex="-1">已归档项目</h1><p class="intro-copy">查看或恢复已归档的项目。</p></div></section><div class="archive-grid">${projects.length ? projects.map((p) => {
    const stats = progress(projectItems(state, p.id));
    return `<article class="panel archive-card"><span class="project-symbol ${p.color}">${icon('folder')}</span><h2>${esc(p.name)}</h2><p>${esc(p.goal || '未填写目标')}</p><div class="archive-progress"><span>${stats.completed} / ${stats.total} 项任务</span><b>${stats.percent}%</b></div><div class="progress-track"><span style="width:${stats.percent}%"></span></div><div class="archive-card-actions"><button class="button secondary" data-action="open-project" data-id="${p.id}">查看项目</button><button class="text-button" data-action="restore-project" data-id="${p.id}">${icon('restore')}恢复</button></div></article>`;
  }).join('') : `<div class="panel archive-empty">${emptyState('archive', '这里还没有归档的项目', '可在项目详情右上角归档项目。', '', '')}</div>`}</div>`;
}
function render() {
  const focus = document.activeElement;
  const focusId = focus?.id;
  const focusAction = focus?.dataset?.action;
  const focusDate = focus?.dataset?.date;
  const focusComplete = focus?.dataset?.complete;
  app.innerHTML = `${sidebar()}<div class="main-shell">${header()}<main id="main" class="main-content">${pwaBanner()}${legacyPending ? '<div class="migration-banner"><span>检测到旧版浏览器数据，可迁移到当前保存位置。</span><button class="text-button" data-action="migrate-legacy">迁移旧数据</button></div>' : ''}${ui.view === 'project' ? projectView() : ui.view === 'archive' ? archiveView() : calendarView()}</main><footer class="site-footer"><span>序日 <span class="footer-dot">·</span> 个人日程与项目管理</span><div class="footer-actions">${isDeviceStorage ? '<button data-action="install-pwa">安装与离线</button>' : ''}<button data-action="help">使用指南 ${icon('arrow')}</button></div></footer></div>`;
  updateSaveStatus();
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
  showModal(project ? '编辑项目' : '新建项目', '', `<form data-form="project" data-id="${project?.id || ''}"><div class="modal-body">${formError}<label class="field">项目名称 <span class="required">*</span><input name="name" required maxlength="80" placeholder="例如：六级考试、XX 项目提交" value="${esc(project?.name || '')}" autofocus></label><label class="field">项目目标<textarea name="goal" rows="3" maxlength="2000" placeholder="填写项目目标（选填）">${esc(project?.goal || '')}</textarea></label><label class="field">截止日期 <span class="field-optional">选填</span><input type="date" name="deadline" min="1900-01-01" max="2100-12-31" value="${project?.deadline || ''}"></label><fieldset class="color-field"><legend>选一个项目颜色</legend><div class="color-options">${COLORS.map((color) => `<label class="color-option ${color}" title="${COLOR_LABELS[color]}"><input type="radio" name="color" value="${color}" ${(project?.color || 'sage') === color ? 'checked' : ''} aria-label="${COLOR_LABELS[color]}"><span>${icon('check')}</span></label>`).join('')}</div></fieldset></div>${formFooter(project ? '保存修改' : '创建项目')}</form>`);
}
function itemForm(item = null, projectId = null, forceSchedule = false) {
  const association = item ? item.projectId : projectId;
  const scheduled = !!item?.date || !association || forceSchedule;
  const isTask = !!association;
  const projectOptions = state.projects.filter((p) => !p.archived || p.id === association);
  showModal(item ? '编辑任务与日程' : isTask ? '添加任务' : '添加日程', '项目任务与日历使用同一份记录，修改会自动同步。', `<form data-form="item" data-id="${item?.id || ''}"><div class="modal-body">${formError}<label class="field">${isTask ? '任务' : '日程'}名称 <span class="required">*</span><input name="title" required maxlength="120" placeholder="填写名称" value="${esc(item?.title || '')}" autofocus></label><label class="field">关联项目<select name="projectId" id="item-project"><option value="">不关联项目 · 独立日程</option>${projectOptions.map((p) => `<option value="${p.id}" ${p.id === association ? 'selected' : ''}>${esc(p.name)}${p.archived ? '（已归档）' : ''}</option>`).join('')}</select></label><div class="schedule-toggle"><label><input type="checkbox" id="item-scheduled" name="scheduled" ${scheduled ? 'checked' : ''} ${!association ? 'disabled' : ''}>${icon('calendar')}安排到日历</label><small id="schedule-hint">${association ? '也可以先存为任务，之后再安排时间。' : '独立日程需要填写日期与时间。'}</small></div><div id="schedule-fields" ${scheduled ? '' : 'hidden'}><label class="field">日期 <span class="required">*</span><input type="date" name="date" min="1900-01-01" max="2100-12-31" value="${item?.date || ui.selectedDate}" ${scheduled ? 'required' : 'disabled'}></label><div class="field-row"><label class="field">开始时间 <span class="required">*</span><input type="time" name="start" value="${item?.start || '09:00'}" ${scheduled ? 'required' : 'disabled'}></label><span class="time-separator">—</span><label class="field">结束时间 <span class="required">*</span><input type="time" name="end" value="${item?.end || '10:00'}" ${scheduled ? 'required' : 'disabled'}></label></div><p class="field-hint">仅支持当天的时间段；跨天安排请拆成两条日程。</p></div><label class="field">备注 <span class="field-optional">选填</span><textarea name="notes" rows="2" maxlength="2000" placeholder="填写备注（选填）">${esc(item?.notes || '')}</textarea></label><label class="completed-field"><input type="checkbox" name="completed" ${item?.completed ? 'checked' : ''}>这件事已经完成</label></div>${formFooter(item ? '保存修改' : isTask ? '添加任务' : '添加日程')}</form>`);
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
  showModal('数据与备份', isDeviceStorage ? '项目与日程保存在此设备，不会上传到网站。' : '数据由正在运行的本机服务读写。', `<div class="modal-body backup-body">${formError}<div class="backup-status"><span class="metric-icon sage">${icon('checkCircle')}</span><div><strong>${isDeviceStorage ? '当前保存位置' : '当前数据文件'}</strong><p class="storage-path">${esc(storagePath)}</p><p>${state.projects.length} 个项目 · ${state.items.length} 条任务与日程</p></div></div><section class="backup-block"><h3>${icon('download')}导出备份</h3><p>下载 JSON 备份，包含全部项目、任务与完成状态。iPhone 可保存到「文件」，再使用下方导入恢复。</p><button class="button secondary" data-action="export">${icon('download')}下载完整备份</button></section><section class="backup-block"><h3>${icon('upload')}导入备份</h3><p>选择之前导出的文件，检查内容后再确认导入。</p><label class="file-picker">${icon('upload')}<span>选择备份文件<small>JSON 格式，最大 5 MB</small></span><input type="file" id="import-file" accept=".json,application/json" aria-label="选择备份文件"></label><div id="import-preview" hidden></div></section><p class="storage-note">${icon('info')}${isDeviceStorage ? '数据保存在当前设备的 IndexedDB 中。清除网站数据、卸载主屏幕应用或设备存储清理可能移除数据，请定期导出到「文件」。电脑与手机不自动同步。' : '关闭浏览器不会删除数据文件。启动窗口须保持运行，文件保存在运行服务的电脑上，每次保存前保留 data.previous.json。'}</p></div><footer class="modal-footer"><button type="button" class="button primary" data-action="close-modal">知道了</button></footer>`, true);
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
function pwaBanner() {
  if (!isDeviceStorage) return '';
  const status = pwaStatus();
  let label = status.offline ? (status.ready ? '离线模式 · 数据仍保存在此设备' : '当前离线，离线资源尚未就绪') : status.ready ? '' : '正在准备离线资源，请保持联网直至完成。';
  if (status.error) label = status.error;
  return `${label ? `<div class="pwa-banner" role="status">${esc(label)}</div>` : ''}${status.updateAvailable ? '<div class="pwa-banner"><span>应用有新版本，已保存的数据会保留。</span><button class="text-button" data-action="update-pwa">更新应用</button></div>' : ''}`;
}
function installDialog() {
  const status = pwaStatus();
  showModal('安装与离线使用', '', `<div class="modal-body help-body"><h3>${status.standalone ? '已在独立应用模式中运行' : '在 iPhone 添加到主屏幕'}</h3><ol class="install-steps"><li>使用 Safari 打开本应用的 HTTPS 网址。</li><li>点击 Safari 的「分享」，选择「添加到主屏幕」。部分版本在「更多」中显示该选项；若有「作为 Web App 打开」，请保持启用。</li><li>名称保留为「序日」，点击「添加」。</li><li>从主屏幕打开，联网等待下方显示「离线已就绪」，再尝试飞行模式。</li></ol><p class="install-status" role="status">${status.ready ? '离线已就绪：可断网打开、修改项目和日程。' : status.error ? '离线未就绪，请联网后刷新重试。' : '离线资源准备中，请保持联网。'}</p><p class="storage-note">建议先安装再正式录入数据。Safari 标签页与主屏幕应用在部分 iOS 版本可能使用不同的存储空间；可通过 JSON 备份迁移。提醒通知、电脑与手机自动同步均未实现。</p></div><footer class="modal-footer"><button class="button primary" data-action="close-modal">关闭</button></footer>`, true);
}
function helpDialog() {
  showModal('使用指南', '', `<div class="modal-body help-body"><div class="help-step"><span>01</span><div><h3>项目与任务</h3><p>左侧新增项目，填写目标和截止日期。在项目详情添加任务，安排时间后显示到当天时间表。两处修改与完成状态同步；手机用左上角菜单展开项目栏。</p></div></div><div class="help-step"><span>02</span><div><h3>月历与日程</h3><p>切换年月、选择日期，下方显示时间表。日程可关联项目，也可独立存在。方框标记完成，铅笔编辑，垃圾桶删除。</p></div></div><div class="help-step"><span>03</span><div><h3>数据保存</h3><p>${isDeviceStorage ? '当前使用设备本地存储。首次联网完成离线资源准备后，断网也能打开和保存。请定期导出 JSON 备份到「文件」。清除网站数据或卸载应用可能删除记录。' : '每次修改由本机服务写入文件，请保持启动窗口运行。保存位置：' + esc(storagePath)}</p></div></div><div class="help-step"><span>04</span><div><h3>备份与设备</h3><p>「数据与备份」可导出或导入。电脑和手机的数据分别保存，尚未实现跨设备自动同步或提醒通知。iPhone 安装步骤见「安装与离线」。</p></div></div></div><footer class="modal-footer">${isDeviceStorage ? '<button class="button secondary" data-action="help-install">安装与离线</button>' : ''}<button class="button primary" data-action="close-modal">关闭</button></footer>`, true);
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled || saveBusy) return;
  event.preventDefault();
  const { action, id, date, filter } = button.dataset;
  const item = id ? state?.items.find((i) => i.id === id) : null;
  const project = id ? projectFor(id) : null;
  switch (action) {
    case 'help-install': closeModal(); installDialog(); break;
    case 'install-pwa': installDialog(); break;
    case 'update-pwa': await requestPwaUpdate(); break;
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
    case 'archive-project': if (project) confirmAction('归档这个项目？', `归档「${project.name}」后，可以在左侧「已归档」中恢复。已有任务和日历中的日程都会保留。`, '归档项目', 'confirm-archive', id); break;
    case 'confirm-archive':
      if (await commit((next) => { const p = next.projects.find((p) => p.id === id); p.archived = true; p.isDemo = false; }, '项目已归档')) { closeModal(); navigate('archive'); }
      break;
    case 'restore-project': if (await commit((next) => { const p = next.projects.find((p) => p.id === id); p.archived = false; p.isDemo = false; }, '项目已恢复')) navigate('project', id); break;
    case 'delete-item': if (item) confirmAction('删除这条计划？', `「${item.title}」会从项目任务和当天时间表中同时移除，此操作无法撤销。`, '确认删除', 'confirm-delete', id, true); break;
    case 'confirm-delete': if (await commit((next) => { next.items = next.items.filter((i) => i.id !== id); }, '这条计划已删除')) closeModal(); break;
    case 'clear-examples': confirmAction('清除未修改的示例数据？', '仅清除尚未修改的示例项目和示例任务。你自己新增或修改的记录会保留。', '清除示例', 'confirm-clear-examples', '', true); break;
    case 'confirm-clear-examples': if (await commit(removeExamples(state), '示例已清除')) closeModal(); break;
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
        if (await commit(next(), '备份已导入，所有视图已同步更新')) {
          closeModal();
          if (ui.view === 'project' && !projectFor(ui.projectId)) navigate('calendar');
        }
      } catch (error) { errorMessage(error.message); }
      break;
    }
    case 'download-recovery': download('序日-原始数据备份.txt', rawStored || '', 'text/plain'); break;
    case 'retry-load': window.location.reload(); break;
    case 'migrate-legacy':
      try {
        const incoming = validateSnapshot(JSON.parse(rawStored));
        confirmAction('合并旧版浏览器数据？', `将 ${incoming.projects.length} 个项目、${incoming.items.length} 条任务与日程合并到 ${storagePath}。同编号记录以浏览器旧数据为准。`, '确认迁移', 'confirm-migrate');
      } catch (error) { errorMessage(`旧数据无法迁移：${error.message}。可先下载原始数据备份。`); }
      break;
    case 'confirm-migrate':
      if (await commit(mergeSnapshots(state, validateSnapshot(JSON.parse(rawStored))), '旧数据已迁移')) {
        markMigrated(); closeModal(); render();
      }
      break;
  }
});
document.addEventListener('change', async (event) => {
  if (saveBusy) return;
  const target = event.target;
  if (target.dataset.complete) {
    const itemId = target.dataset.complete;
    const completed = target.checked;
    if (!await commit((next) => {
      const item = next.items.find((i) => i.id === itemId);
      item.completed = completed;
      item.isDemo = false;
      touchProject(next, item.projectId);
    }, completed ? '已标记为完成' : '已标记为未完成')) target.checked = !completed;
  } else if (target.id === 'calendar-year' || target.id === 'calendar-month') {
    ui.year = Number($('#calendar-year').value); ui.month = Number($('#calendar-month').value); render();
  } else if (target.id === 'item-project' || target.id === 'item-scheduled') updateScheduleFields();
  else if (target.id === 'import-file') readImport(target.files[0]);
});
modal.addEventListener('submit', async (event) => {
  if (saveBusy) { event.preventDefault(); return; }
  event.preventDefault();
  const form = event.target;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const id = form.dataset.id;
  if (form.dataset.form === 'project') {
    const project = { id: id || uid(), name: data.get('name').trim(), goal: data.get('goal').trim(), deadline: data.get('deadline') || null, color: data.get('color'), archived: id ? projectFor(id).archived : false, isDemo: false };
    if (await commit((next) => {
      if (id) next.projects[next.projects.findIndex((p) => p.id === id)] = project;
      else next.projects.push(project);
    }, id ? '项目已更新' : '项目已创建')) { closeModal(); navigate('project', project.id); }
  } else if (form.dataset.form === 'item') {
    const projectId = data.get('projectId') || null;
    const scheduled = !projectId || $('#item-scheduled', modal).checked;
    const item = { id: id || uid(), title: data.get('title').trim(), projectId, date: scheduled ? data.get('date') : null, start: scheduled ? data.get('start') : null, end: scheduled ? data.get('end') : null, notes: data.get('notes').trim(), completed: data.has('completed'), isDemo: false };
    if (await commit((next) => {
      if (id) { const index = next.items.findIndex((i) => i.id === id); touchProject(next, next.items[index].projectId); next.items[index] = item; }
      else next.items.push(item);
      touchProject(next, projectId);
    }, id ? '计划已更新，项目与日历已同步' : savedLabel())) {
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
function markMigrated() {
  legacyPending = false;
  try { localStorage.setItem('xuri.disk-migration.v1', storagePath); } catch { /* Only a migration preference. */ }
}
function recoveryScreen(message) {
  app.innerHTML = `<main class="recovery"><img src="./favicon.svg" alt="序日" width="52" height="52"><h1>${isDeviceStorage ? '无法读取此设备的数据' : '无法读取数据文件'}</h1><p>${esc(message)}</p><p>${isDeviceStorage ? '请确认使用普通浏览模式且允许本地存储。已有记录不会自动重置；如有备份，请先保留。' : '请检查启动窗口和数据目录，修复后重新连接。已有文件不会自动重置。'}</p><div>${rawStored ? '<button class="button secondary" data-action="download-recovery">下载浏览器旧数据</button>' : ''}<button class="button primary" data-action="retry-load">重新连接</button></div></main>`;
}
async function syncDisk() {
  if (!state || saveBusy || syncBusy || document.hidden) return;
  syncBusy = true;
  try {
    const previousRevision = revision;
    const result = await readDisk();
    if (saveBusy || previousRevision !== revision) return;
    if (!result.state) throw new Error('数据已被移除，请检查保存位置。');
    if (result.revision !== revision) {
      const editing = modal.open;
      if (editing) closeModal();
      applyDisk(result);
      saveStatus = 'saved'; render();
      if (editing) toast('其他页面更新了数据，请重新打开编辑。');
    } else { saveStatus = 'saved'; updateSaveStatus(); }
  } catch { saveStatus = 'error'; updateSaveStatus(); }
  finally { syncBusy = false; }
}
async function init() {
  app.innerHTML = '<main class="recovery"><h1>正在读取数据…</h1></main>';
  try {
    try { rawStored = localStorage.getItem(STORAGE_KEY); } catch { /* File storage works without browser storage. */ }
    let result = await readDisk();
    storagePath = result.storagePath;
    if (result.state === null) {
      const initial = rawStored === null ? { version: 1, projects: [], items: [] } : validateSnapshot(JSON.parse(rawStored));
      let migrated = false;
      try { result = await writeDisk(initial, result.revision); migrated = rawStored !== null; }
      catch (error) {
        if (error.status === 409 && error.current?.state) result = error.current;
        else throw error;
      }
      if (migrated) markMigrated();
    }
    applyDisk(result);
    try { legacyPending = rawStored !== null && localStorage.getItem('xuri.disk-migration.v1') !== storagePath; } catch { /* Optional preference. */ }
    try {
      const preference = JSON.parse(sessionStorage.getItem('xuri.view'));
      if (preference && validDate(preference.selectedDate) && ['calendar', 'project', 'archive'].includes(preference.view)
        && Number.isInteger(preference.year) && preference.year >= 1900 && preference.year <= 2100
        && Number.isInteger(preference.month) && preference.month >= 0 && preference.month <= 11) {
        ui = { ...ui, selectedDate: preference.selectedDate, year: preference.year, month: preference.month, view: preference.view, projectId: projectFor(preference.projectId)?.id || null };
        if (ui.view === 'project' && !ui.projectId) ui.view = 'calendar';
      }
    } catch { /* View preferences are optional. */ }
    render();
    setInterval(syncDisk, 2000);
    window.addEventListener('focus', syncDisk);
    document.addEventListener('visibilitychange', syncDisk);
  } catch (error) { recoveryScreen(error.message); }
}
document.addEventListener('xuri:pwa-status', () => {
  if (state && !saveBusy) render();
  if (modal.open && $('.install-status', modal)) { const status = pwaStatus(); $('.install-status', modal).textContent = status.ready ? '离线已就绪：可断网打开、修改项目和日程。' : status.error ? '离线未就绪，请联网后刷新重试。' : '离线资源准备中，请保持联网。'; }
});
init();
