export function validateLead(values) {
  const errors = {};
  if (!values.name || values.name.trim().length < 2) errors.name = 'Укажите имя: не менее двух символов.';
  else if (values.name.trim().length > 80) errors.name = 'Имя должно быть не длиннее 80 символов.';
  const contact = (values.contact || '').trim();
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const phone = /^\+?[\d\s()-]+$/;
  const digits = contact.replace(/\D/g, '');
  if (contact.length > 160 || !(email.test(contact) || (phone.test(contact) && digits.length >= 10 && digits.length <= 15))) {
    errors.contact = 'Укажите email или телефон с кодом страны, например +7 900 000-00-00.';
  }
  if (!['website', 'ads', 'both', 'unsure'].includes(values.service)) errors.service = 'Выберите услугу.';
  if ((values.message || '').length > 3000) errors.message = 'Описание должно быть не длиннее 3000 символов.';
  if (!values.consent) errors.consent = 'Необходимо ваше согласие.';
  return errors;
}

export async function sendLead(values, settings, fetcher = fetch, options = {}) {
  if (!settings.form.endpoint) return { demo: true };
  if (!settings.privacyUrl) throw new Error('Отправка пока недоступна: документ об обработке данных ещё не добавлен.');
  const endpoint = new URL(settings.form.endpoint, globalThis.location?.origin || 'http://localhost');
  const origin = globalThis.location?.origin || 'http://localhost';
  if (endpoint.origin !== origin) throw new Error('Для формы требуется адрес обработчика на этом же сайте.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.form.timeoutMs || 12000);
  try {
    const response = await fetcher(endpoint.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Idempotency-Key': options.idempotencyKey || crypto.randomUUID() },
      credentials: 'same-origin',
      redirect: 'error',
      signal: controller.signal,
      body: JSON.stringify(values),
    });
    if (response.status === 429) throw new Error('Слишком много попыток. Подождите 10 минут и попробуйте снова.');
    if (response.status === 503) throw new Error('Приём заявок временно недоступен. Попробуйте немного позже.');
    if (response.status === 409) throw new Error('Данные заявки изменились. Обновите страницу перед новой отправкой.');
    if (!response.ok) throw new Error('Не удалось отправить заявку. Попробуйте ещё раз немного позже.');
    let result;
    try { result = await response.json(); } catch { throw new Error('Сервер не подтвердил приём заявки. Попробуйте позже.'); }
    if (result.ok !== true) throw new Error('Сервер не подтвердил приём заявки. Попробуйте позже.');
    return { demo: false };
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Сервер не ответил вовремя. Попробуйте ещё раз.');
    if (error instanceof TypeError) throw new Error('Нет соединения с сервером. Проверьте интернет и повторите попытку.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
