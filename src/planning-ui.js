import { addDays, localDate, uid, validateSnapshot } from './model.js';
import { parseNotice } from './notice-parser.js';
import { parseImplementationPlan, generatePlanOccurrences } from './plan-parser.js';

// This dialog is separate from the ordinary item editor: cancelling a preview
// leaves the user's underlying schedule form and unsaved text untouched.
let services;
let dialog;
let context;
let generation = 0;
const $ = (selector, root = dialog) => root?.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const noticeForm = 'form[data-plan-form="notice"]';
const implementationForm = 'form[data-plan-form="implementation"]';

export function initPlanningUI(options) {
  services = options;
  ensureDialog();
}

function ensureDialog() {
  if (!services?.getState || !services?.commit) throw new Error('计划功能尚未准备完成，请稍后重试。');
  if (dialog) return;
  dialog = document.createElement('dialog');
  dialog.id = 'planning-modal';
  dialog.className = 'modal wide planning-modal';
  dialog.setAttribute('aria-labelledby', 'planning-title');
  document.body.append(dialog);
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('submit', onSubmit);
  dialog.addEventListener('input', onInput);
  dialog.addEventListener('change', onInput);
  dialog.addEventListener('cancel', (event) => {
    if (context?.busy) event.preventDefault();
    event.stopPropagation();
  });
  dialog.addEventListener('close', () => {
    // A native close event is queued. A notice save can already have opened the
    // next plan preview by the time that earlier event arrives.
    if (!dialog.open) { generation++; context = null; }
  });
}

function header(title, subtitle) {
  return `<header class="modal-header"><div><h2 id="planning-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button type="button" class="icon-button" data-plan-action="close" aria-label="关闭规划窗口">×</button></header>`;
}
const errorBox = '<p id="planning-error" class="form-error" role="alert" hidden></p>';
function warningsMarkup(warnings = []) {
  return warnings.length ? `<ul class="planning-warnings">${warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : '';
}
function show(content, nextContext) {
  ensureDialog();
  generation++;
  context = { ...nextContext, generation, busy: false };
  dialog.innerHTML = content;
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
}
function current(active) {
  return context === active && generation === active.generation && dialog.open;
}
function showError(message) {
  const target = $('#planning-error');
  if (target) { target.textContent = message; target.hidden = false; target.scrollIntoView({ block: 'nearest' }); }
}
function clearError() {
  const target = $('#planning-error');
  if (target) { target.hidden = true; target.textContent = ''; }
}
function lock(active) {
  active.busy = true;
  const controls = [...dialog.querySelectorAll('button,input,select,textarea')].map((element) => [element, element.disabled]);
  controls.forEach(([element]) => { element.disabled = true; });
  return () => { active.busy = false; controls.forEach(([element, disabled]) => { element.disabled = disabled; }); };
}

export function openNoticeProject(text, { onCreated } = {}) {
  ensureDialog();
  const result = parseNotice(text, { today: localDate() });
  const warnings = [...result.warnings];
  if (services.getState().projects.some((project) => project.name === result.name)) warnings.push('已存在同名项目，请核对是否为重复通知；取消不会改动原项目。');
  show(`${header('从通知建立项目', '按常见文字格式在本机解析。请核对并修改，确认后才会保存项目。')}
    <form data-plan-form="notice"><div class="modal-body">${errorBox}${warningsMarkup(warnings)}
      <label class="field">项目名称 <span class="required">*</span><input name="name" maxlength="80" required value="${esc(result.name)}"></label>
      <label class="field">项目目标<textarea name="goal" maxlength="2000" rows="4">${esc(result.goal)}</textarea></label>
      <div class="planning-date-fields"><label class="field">截止日期<input type="date" name="deadline" min="1900-01-01" max="2100-12-31" value="${esc(result.deadline || '')}"></label><label class="field">截止时刻 <span class="field-optional">选填</span><input type="time" name="deadlineTime" value="${esc(result.deadlineTime || '')}"></label></div>
      <label class="field">地点 <span class="field-optional">选填</span><input name="location" maxlength="500" value="${esc(result.location)}" placeholder="未识别时可手动填写"></label>
      <label class="field">项目实施计划 <span class="field-optional">选填</span><textarea name="implementationPlan" maxlength="5000" rows="3" placeholder="例如：每个工作日安排两个小时学习，周末下午三点到五点做真题"></textarea></label>
      <p class="field-hint">填写实施计划后，项目保存成功会继续显示排程预览，确认后才新增日程。</p>
      <details class="planning-source"><summary>查看通知原文</summary><p>${esc(result.noticeText)}</p></details>
    </div><footer class="modal-footer"><button type="button" class="button secondary" data-plan-action="close">取消</button><button type="submit" class="button primary">确认建立项目</button></footer></form>`, { type: 'notice', result, onCreated });
}

function ruleMarkup(rule, index) {
  return `<fieldset class="plan-rule" data-rule-id="${esc(rule.id || `manual-${index + 1}`)}"><legend>规则 ${index + 1}</legend>
    <label class="field">日程名称<input name="rule-title" required maxlength="120" value="${esc(rule.title)}"></label>
    <div class="plan-rule-days" role="group" aria-label="规则 ${index + 1} 的重复星期">${weekdays.map((label, day) => `<label><input type="checkbox" name="rule-days" value="${day + 1}" ${(rule.days || []).includes(day + 1) ? 'checked' : ''}>${label}</label>`).join('')}</div>
    <div class="planning-date-fields"><label class="field">开始时间<input type="time" name="rule-start" required value="${esc(rule.start)}"></label><label class="field">结束时间<input type="time" name="rule-end" required value="${esc(rule.end)}"></label></div>
    <button type="button" class="text-button" data-plan-action="remove-rule">删除这条规则</button></fieldset>`;
}
function collectRules() {
  return [...dialog.querySelectorAll('.plan-rule')].map((element, index) => ({
    id: element.dataset.ruleId || `manual-${index + 1}`,
    title: $('[name="rule-title"]', element).value.trim(),
    days: [...element.querySelectorAll('[name="rule-days"]:checked')].map((input) => Number(input.value)),
    start: $('[name="rule-start"]', element).value,
    end: $('[name="rule-end"]', element).value,
  }));
}
function renderRules(rules) {
  $('#plan-rules').innerHTML = rules.map(ruleMarkup).join('') || '<p class="field-hint">尚无可用规则。请完善计划文字后重新解析，或手动添加规则。</p>';
}

export function openPlanBuilder(project) {
  ensureDialog();
  const today = localDate();
  const savedSettings = project.implementationSettings;
  const restoreSettings = savedSettings && savedSettings.text === project.implementationPlan && Array.isArray(savedSettings.rules);
  const startDate = restoreSettings ? savedSettings.startDate : today;
  const endDate = restoreSettings ? savedSettings.endDate : project.deadline || addDays(today, 27);
  const defaultStart = restoreSettings ? savedSettings.defaultStart : '19:00';
  const manualCounter = restoreSettings ? savedSettings.rules.reduce((maximum, rule) => Math.max(maximum, Number(rule.id?.match(/^manual-(\d+)$/)?.[1]) || 0), 0) : 0;
  show(`${header('项目实施计划与日程', '先核对重复规则和日期范围，再预览、选择要加入日历的日程。')}
    <form data-plan-form="implementation"><div class="modal-body">${errorBox}
      <p class="planning-project-name">${esc(project.name)}</p>
      <label class="field">项目实施计划<textarea name="implementationPlan" maxlength="5000" rows="4" placeholder="每个工作日安排两个小时学习，周末下午三点到五点做真题">${esc(project.implementationPlan || '')}</textarea></label>
      <div class="planning-date-fields"><label class="field">生成开始日期<input type="date" name="startDate" required min="1900-01-01" max="2100-12-31" value="${esc(startDate)}"></label><label class="field">生成结束日期<input type="date" name="endDate" required min="1900-01-01" max="2100-12-31" value="${esc(endDate)}"></label></div>
      <label class="field">未写明时刻时的默认开始时间<input type="time" name="defaultStart" required value="${esc(defaultStart)}"></label>
      <p class="field-hint">无项目截止日期时默认预览 28 天，可自行修改。每次最多 366 天、500 条日程；工作日按周一至周五，不包含节假日或调休判断。</p>
      <button type="button" class="button secondary" data-plan-action="parse-rules">解析实施计划</button>
      <div id="plan-rule-warnings" class="planning-rule-warnings"></div>
      <p class="field-hint">修改计划文字或默认时刻后请重新解析；下面的名称、星期和起止时间也可以直接修改。</p>
      <div id="plan-rules" class="plan-rules"></div><button type="button" class="text-button" data-plan-action="add-rule">手动添加规则</button>
      <div class="planning-preview-actions"><button type="button" class="button secondary" data-plan-action="preview-plan">预览日程</button></div>
      <section id="plan-preview" class="plan-preview" aria-live="polite" hidden></section>
    </div><footer class="modal-footer"><button type="button" class="button secondary" data-plan-action="close">取消</button><button type="submit" class="button primary" id="plan-confirm" disabled>确认生成日程</button></footer></form>`, { type: 'implementation', projectId: project.id, preview: null, parsedInput: null, manualCounter });
  if (restoreSettings) {
    context.parsedInput = inputSignature();
    renderRules(savedSettings.rules);
    $('#plan-rule-warnings').innerHTML = '<p class="field-hint">已恢复上次确认的规则、日期范围和默认时刻。重新预览会跳过已有的相同日程。</p>';
  } else parseRules();
}

function inputSignature() {
  const form = $(implementationForm);
  return { text: $('[name="implementationPlan"]', form).value.trim(), defaultStart: $('[name="defaultStart"]', form).value };
}
function invalidatePreview(active = context) {
  if (!active || active.type !== 'implementation' || !current(active)) return;
  active.preview = null;
  const preview = $('#plan-preview');
  preview.hidden = true;
  preview.innerHTML = '';
  updateConfirm();
}
function parseRules() {
  clearError();
  const active = context;
  invalidatePreview(active);
  try {
    const input = inputSignature();
    const parsed = parseImplementationPlan(input.text, { today: localDate(), defaultStart: input.defaultStart });
    active.parsedInput = input;
    renderRules(parsed.rules);
    $('#plan-rule-warnings').innerHTML = warningsMarkup([...parsed.warnings, ...parsed.unrecognized.map((text) => `未识别：「${text}」。可修改文字，或在下面手动添加规则。`)]);
  } catch (error) { showError(error.message); }
}
const itemKey = (item) => JSON.stringify([item.date, item.start, item.end, item.title]);
function previewPlan() {
  clearError();
  const active = context;
  invalidatePreview(active);
  try {
    const form = $(implementationForm);
    if (!form.reportValidity()) return;
    const input = inputSignature();
    if (!active.parsedInput || input.text !== active.parsedInput.text || input.defaultStart !== active.parsedInput.defaultStart) throw new Error('计划文字或默认时刻已改变，请先点击「解析实施计划」更新规则。');
    const project = services.getState().projects.find((record) => record.id === active.projectId);
    if (!project || project.archived) throw new Error('项目已移除或归档，请先恢复项目后再安排日程。');
    const options = { startDate: $('[name="startDate"]', form).value, endDate: $('[name="endDate"]', form).value, projectId: project.id, existingItems: services.getState().items };
    const rules = collectRules();
    const result = generatePlanOccurrences(rules, options);
    result.items = result.items.map((item) => ({ ...item, location: project.location || '' }));
    const conflicts = new Set(result.conflicts.map(itemKey));
    active.preview = { result, rules, options: { startDate: options.startDate, endDate: options.endDate }, text: input.text, defaultStart: input.defaultStart };
    const target = $('#plan-preview');
    target.innerHTML = `<h3>日程预览</h3><p class="field-hint">新增候选 ${result.items.length} 条，已有相同计划跳过 ${result.skipped.length} 条。${conflicts.size ? `${conflicts.size} 条存在时间重叠，默认不选中；可核对后自行勾选。` : '未发现与现有日程重叠。'}确认只会添加选中的日程，不会修改原有安排。</p>${warningsMarkup(result.warnings)}
      <div class="plan-occurrences">${result.items.map((item) => {
        const overlap = result.conflicts.filter((conflict) => itemKey(conflict) === itemKey(item));
        return `<label class="plan-occurrence ${overlap.length ? 'has-conflict' : ''}"><input type="checkbox" name="occurrence" value="${esc(item.planKey)}" ${overlap.length ? '' : 'checked'}><span><strong>${item.date} ${item.start}–${item.end}</strong><span>${esc(item.title)}</span>${item.location ? `<small>地点：${esc(item.location)}</small>` : ''}${overlap.length ? `<small class="planning-conflict">时间重叠：${esc([...new Set(overlap.map((conflict) => conflict.withTitle))].join('、'))}</small>` : ''}</span></label>`;
      }).join('') || '<p class="field-hint">没有需要新增的日程。可以保存计划文字，已有安排会保留。</p>'}</div>`;
    target.hidden = false;
    updateConfirm();
  } catch (error) { showError(error.message); }
}
function selectedKeys() {
  return new Set([...dialog.querySelectorAll('[name="occurrence"]:checked')].map((element) => element.value));
}
function updateConfirm() {
  const button = $('#plan-confirm');
  if (!button) return;
  button.disabled = !context?.preview || context.busy;
  const count = selectedKeys().size;
  button.textContent = context?.preview ? count ? `确认生成 ${count} 条日程` : '保存计划文字，不新增日程' : '确认生成日程';
}

async function saveNotice() {
  const active = context;
  if (active?.busy || active?.type !== 'notice') return;
  clearError();
  const form = $(noticeForm);
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const project = {
    id: uid(), name: data.get('name').trim(), goal: data.get('goal').trim(),
    deadline: data.get('deadline') || null, deadlineTime: data.get('deadlineTime') || '',
    location: data.get('location').trim(), implementationPlan: data.get('implementationPlan').trim(),
    noticeText: active.result.noticeText, color: 'sage', archived: false, isDemo: false,
  };
  let unlock;
  try {
    validateSnapshot({ ...services.getState(), projects: [...services.getState().projects, project] });
    unlock = lock(active);
    const saved = await services.commit((next) => { next.projects.push(project); }, '已从通知建立项目');
    if (!current(active)) return;
    if (!saved) { showError('项目保存未完成，请检查保存状态后重试。'); return; }
    const callback = active.onCreated || services.onProjectCreated;
    dialog.close();
    callback?.(project);
    if (project.implementationPlan) openPlanBuilder(project);
  } catch (error) { if (current(active)) showError(error.message); }
  finally { unlock?.(); }
}

async function saveImplementation() {
  const active = context;
  if (active?.busy || active?.type !== 'implementation' || !active.preview) return;
  clearError();
  const keys = selectedKeys();
  const preview = active.preview;
  let unlock;
  try {
    const currentState = services.getState();
    const project = currentState.projects.find((record) => record.id === active.projectId);
    if (!project || project.archived) throw new Error('项目已移除或归档，请先恢复项目后再生成。');
    // Recompute from fresh records: another tab may have completed, edited or
    // added an arrangement while this preview was open. Never replace it.
    const fresh = generatePlanOccurrences(preview.rules, { ...preview.options, projectId: project.id, existingItems: currentState.items });
    const chosen = fresh.items.filter((item) => keys.has(item.planKey));
    const oldConflicts = new Set(preview.result.conflicts.map((item) => JSON.stringify([itemKey(item), item.withId, item.withTitle])));
    const newlyConflicting = fresh.conflicts.some((item) => chosen.some((candidate) => itemKey(candidate) === itemKey(item)) && !oldConflicts.has(JSON.stringify([itemKey(item), item.withId, item.withTitle])));
    if (newlyConflicting) throw new Error('现有日程刚刚发生变化，出现新的时间重叠。请重新预览后确认。');
    const items = chosen.map((item) => ({ ...item, id: uid(), location: project.location || '' }));
    const implementationSettings = { text: preview.text, defaultStart: preview.defaultStart, ...preview.options, rules: preview.rules.map((rule) => ({ ...rule, days: [...rule.days] })) };
    const candidate = { ...currentState, projects: currentState.projects.map((record) => record.id === project.id ? { ...record, implementationPlan: preview.text, implementationSettings, isDemo: false } : record), items: [...currentState.items, ...items] };
    validateSnapshot(candidate);
    unlock = lock(active);
    const saved = await services.commit((next) => {
      const record = next.projects.find((entry) => entry.id === project.id);
      if (!record) throw new Error('项目已不存在，请重新打开预览。');
      record.implementationPlan = preview.text;
      record.implementationSettings = implementationSettings;
      record.isDemo = false;
      next.items.push(...items);
    }, items.length ? `已生成 ${items.length} 条日程` : '已保存计划，原日程保持不变');
    if (!current(active)) return;
    if (!saved) { invalidatePreview(active); showError('保存未完成，请重新预览后重试。'); return; }
    dialog.close();
  } catch (error) { if (current(active)) { invalidatePreview(active); showError(error.message); } }
  finally { unlock?.(); if (current(active)) updateConfirm(); }
}

async function onSubmit(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.target.matches(noticeForm)) await saveNotice();
  else if (event.target.matches(implementationForm)) await saveImplementation();
}
function onInput(event) {
  event.stopPropagation();
  if (context?.type !== 'implementation' || context.busy) return;
  if (event.target.name === 'occurrence') { updateConfirm(); return; }
  invalidatePreview();
}
function onClick(event) {
  event.stopPropagation();
  const button = event.target.closest('[data-plan-action]');
  if (!button || button.disabled || context?.busy) return;
  event.preventDefault();
  switch (button.dataset.planAction) {
    case 'close': dialog.close(); break;
    case 'parse-rules': parseRules(); break;
    case 'preview-plan': previewPlan(); break;
    case 'add-rule': {
      const rules = collectRules();
      rules.push({ id: `manual-${++context.manualCounter}`, title: '', days: [1, 2, 3, 4, 5], start: $('[name="defaultStart"]').value || '19:00', end: '21:00' });
      invalidatePreview();
      renderRules(rules);
      break;
    }
    case 'remove-rule': button.closest('.plan-rule').remove(); invalidatePreview(); break;
  }
}
