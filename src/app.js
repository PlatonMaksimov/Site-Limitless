import { config, projects, faq } from './site-data.js';
import { validateLead, sendLead } from './lead.js';

const $ = (selector, root = document) => root.querySelector(selector);
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function projectPreview(project) {
  const previews = {
    forma: `<div class="mock-site forma-site"><div class="mock-nav"><b>FORMA</b><span>Проекты &nbsp; Бюро &nbsp; Контакты ↗</span></div><div class="mock-body"><p class="mock-caption">АРХИТЕКТУРА. ПРОСТРАНСТВО. ЖИЗНЬ.</p><h4>Форма следует<br>за вашей жизнью.</h4><span class="mock-tiny-link">Исследовать проекты ↗</span><div class="architecture"><div class="arch-shadow"></div><div class="arch-building"></div></div></div></div>`,
    botanica: `<div class="mock-site botanica-site"><div class="mock-nav"><b>botanica</b><span>Растения &nbsp; О нас &nbsp; Корзина (0)</span></div><div class="mock-body"><p class="mock-caption">ПРИРОДА БЛИЖЕ, ЧЕМ КАЖЕТСЯ</p><h4>Пусть дома<br>будет<br><em>живое.</em></h4><span class="mock-tiny-link">Найти своё растение ↗</span><div class="plant-illustration"><i class="plant-stem"></i><i class="leaf leaf-one"></i><i class="leaf leaf-two"></i><i class="leaf leaf-three"></i><i class="leaf leaf-four"></i><i class="plant-pot"></i></div><div class="plant-bottom-line">С заботой о растениях. И о вас.</div></div></div>`,
    vector: `<div class="mock-site vector-site"><div class="mock-nav"><b>ВЕКТОР ↗</b><span>Решения &nbsp; География &nbsp; Контакты</span></div><div class="mock-body"><p class="mock-caption">ЛОГИСТИКА ДЛЯ ВАШЕГО БИЗНЕСА</p><h4>Ваш груз.<br>Наш маршрут.</h4><span class="mock-tiny-link">Рассчитать доставку ↗</span><div class="logistics-art"><i></i><i></i><i></i></div></div></div>`,
  };
  return `<div class="project-preview preview-${escapeHTML(project.id)}" role="img" aria-label="Превью демонстрационной концепции ${escapeHTML(project.name)}"><span class="concept-chip">${escapeHTML(project.type)}</span><div aria-hidden="true" style="display:contents">${previews[project.id] || ''}</div></div>`;
}

function renderProjects() {
  $('#project-grid').innerHTML = projects.map((project) => `<article class="project-card">${projectPreview(project)}<p class="project-meta">${escapeHTML(project.category)}</p><div class="project-title-row"><h3>${escapeHTML(project.title)}</h3><button type="button" class="project-open" data-project="${escapeHTML(project.id)}" aria-label="Подробнее о концепции ${escapeHTML(project.name)}">↗</button></div><p class="project-summary"><b>Задача.</b> ${escapeHTML(project.task)}</p><p class="project-summary"><b>Решение.</b> ${escapeHTML(project.solution)}</p></article>`).join('');
  const dialog = $('#project-dialog');
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-project]');
    if (!trigger) return;
    const project = projects.find((item) => item.id === trigger.dataset.project);
    if (!project) return;
    $('#dialog-content').innerHTML = `${projectPreview(project)}<p class="project-meta">${escapeHTML(project.category)}</p><h2 id="dialog-title">${escapeHTML(project.title)}</h2><p class="project-summary"><b>Задача.</b> ${escapeHTML(project.task)}</p><p class="project-summary"><b>Решение.</b> ${escapeHTML(project.solution)}</p><p class="project-summary">Демонстрационная концепция. Не является реальным клиентским кейсом.</p>`;
    $('#dialog-cta').dataset.service = project.id === 'vector' ? 'both' : 'website';
    dialog.showModal();
    document.body.classList.add('dialog-open');
  });
  $('.dialog-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => document.body.classList.remove('dialog-open'));
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}

function setupMenu() {
  const toggle = $('.menu-toggle');
  const menu = $('#mobile-menu');
  function closeMenu(returnFocus = false) {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Открыть меню');
    if (returnFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => {
    const isOpen = toggle.getAttribute('aria-expanded') === 'true';
    if (isOpen) closeMenu();
    else {
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Закрыть меню');
    }
  });
  menu.addEventListener('click', (event) => { if (event.target.closest('a')) closeMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) closeMenu(true);
  });
  document.addEventListener('click', (event) => {
    if (!menu.hidden && !event.target.closest('.header')) closeMenu();
  });
  document.addEventListener('focusin', (event) => {
    if (!menu.hidden && !event.target.closest('.header')) closeMenu();
  });
  matchMedia('(min-width: 900px)').addEventListener('change', (event) => { if (event.matches) closeMenu(); });
}

function setupContent() {
  document.querySelectorAll('[data-brand]').forEach((element) => { element.textContent = config.name; });
  $('.header .brand').setAttribute('aria-label', `${config.name} — на главную`);
  document.title = `${config.name} — разработка сайтов и интернет-реклама`;
  $('#year').textContent = new Date().getFullYear();
  $('#faq-list').innerHTML = faq.map(([question, answer]) => `<details><summary>${escapeHTML(question)}</summary><p>${escapeHTML(answer)}</p></details>`).join('');
  const contacts = [];
  if (config.email) contacts.push(`<a href="mailto:${escapeHTML(config.email)}">${escapeHTML(config.email)}</a>`);
  if (config.phone) contacts.push(`<a href="tel:${escapeHTML(config.phone.replace(/[^\d+]/g, ''))}">${escapeHTML(config.phone)}</a>`);
  if (config.telegramUrl && /^https:\/\/t\.me\/[a-zA-Z0-9_]+$/.test(config.telegramUrl)) contacts.push(`<a href="${escapeHTML(config.telegramUrl)}">Написать в Telegram ↗</a>`);
  $('#direct-contact').innerHTML = contacts.join('');
  const privacyUrl = safeDocumentUrl(config.privacyUrl);
  if (privacyUrl) {
    const link = `<a href="${escapeHTML(privacyUrl)}" target="_blank" rel="noopener">документом об обработке персональных данных</a>`;
    $('#footer-legal').innerHTML = `<a href="${escapeHTML(privacyUrl)}" target="_blank" rel="noopener">Обработка персональных данных ↗</a>`;
    if (config.form.endpoint) {
      $('#consent-text').innerHTML = `Согласен(на) на обработку персональных данных в соответствии с ${link}.`;
      $('#privacy-note').textContent = 'Обязательные поля отмечены звёздочкой.';
    }
  }
}

function safeDocumentUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value, location.origin);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function setupForm() {
  const form = $('#lead-form');
  const status = $('#form-status');
  const submit = $('.form-submit');
  const submitLabel = $('#submit-label');
  const isDemo = !config.form.endpoint;
  const configured = !isDemo && config.available !== false && Boolean(safeDocumentUrl(config.privacyUrl));
  let pending = false;
  let revision = 0;
  let lastAttempt = null;
  if (configured) {
    $('#demo-notice').hidden = true;
    submitLabel.textContent = 'Отправить заявку';
  } else if (!isDemo) {
    $('#demo-notice').textContent = config.unavailableReason === 'https'
      ? 'Приём заявок пока закрыт: настраиваем защищённое соединение. Не вводите персональные данные.'
      : !config.privacyUrl
        ? 'Приём заявок пока недоступен: необходимо добавить документ об обработке персональных данных.'
        : 'Приём заявок временно недоступен. Пожалуйста, зайдите немного позже.';
    submitLabel.textContent = 'Отправка недоступна';
    submit.disabled = true;
    form.querySelectorAll('input, select, textarea').forEach((field) => { field.disabled = true; });
  }
  function clearError(name) {
    const input = form.elements.namedItem(name);
    input?.removeAttribute('aria-invalid');
    const message = $(`#${name}-error`);
    if (message) message.textContent = '';
  }
  function clearStatus() {
    status.textContent = '';
    status.removeAttribute('data-state');
  }
  function resetSubmitLabel() {
    submitLabel.textContent = isDemo ? 'Проверить заполнение' : 'Отправить заявку';
  }
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-service]');
    if (!trigger || pending) return;
    $('#service').value = trigger.dataset.service;
    clearError('service');
    clearStatus();
    revision++;
    const dialog = $('#project-dialog');
    if (dialog.open) dialog.close();
  });
  form.addEventListener('input', (event) => {
    if (event.target.name) clearError(event.target.name);
    if (!pending) clearStatus();
    revision++;
  });
  form.addEventListener('change', (event) => {
    if (event.target.name) clearError(event.target.name);
    if (!pending) clearStatus();
    revision++;
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending || (!isDemo && !configured)) return;
    clearStatus();
    const data = new FormData(form);
    const values = {
      name: String(data.get('name') || '').trim(),
      contact: String(data.get('contact') || '').trim(),
      service: String(data.get('service') || ''),
      message: String(data.get('message') || '').trim(),
      consent: data.get('consent') === 'on',
    };
    ['name', 'contact', 'service', 'message', 'consent'].forEach(clearError);
    const errors = validateLead(values);
    if (Object.keys(errors).length) {
      Object.entries(errors).forEach(([name, message]) => {
        form.elements.namedItem(name).setAttribute('aria-invalid', 'true');
        $(`#${name}-error`).textContent = message;
      });
      status.dataset.state = 'error';
      status.textContent = 'Проверьте отмеченные поля.';
      form.elements.namedItem(Object.keys(errors)[0]).focus();
      return;
    }
    pending = true;
    const sentRevision = revision;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    submitLabel.textContent = isDemo ? 'Проверяем…' : 'Отправляем…';
    try {
      const serialized = JSON.stringify(values);
      if (!isDemo && lastAttempt?.serialized !== serialized) {
        lastAttempt = { serialized, idempotencyKey: crypto.randomUUID() };
      }
      const result = await sendLead(values, config, fetch, lastAttempt || {});
      status.dataset.state = result.demo ? 'demo' : 'success';
      status.textContent = result.demo
        ? 'Всё заполнено верно. Это деморежим: заявка не отправлена, данные никуда не переданы.'
        : 'Заявка принята. Спасибо! Вернёмся к вам по указанному контакту.';
      if (!result.demo) lastAttempt = null;
      if (!result.demo && sentRevision === revision) form.reset();
    } catch (error) {
      status.dataset.state = 'error';
      status.textContent = error.message || 'Не удалось отправить заявку. Попробуйте позже.';
    } finally {
      pending = false;
      submit.disabled = false;
      form.removeAttribute('aria-busy');
      resetSubmitLabel();
    }
  });
}

setupContent();
renderProjects();
setupMenu();
setupForm();
