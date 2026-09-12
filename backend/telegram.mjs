import { normalizeAdminId } from './store.mjs';

function safeError(statusCode, retryAfter) {
  const error = new Error('Telegram request failed.');
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) error.statusCode = statusCode;
  if (Number.isSafeInteger(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
  return error;
}

/** Never propagate Telegram descriptions, fetch errors, request URLs or causes. */
export function createTelegramClient(token, { fetcher = fetch } = {}) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token) || typeof fetcher !== 'function') {
    throw new TypeError('Invalid Telegram client configuration.');
  }
  return {
    async call(method, params = {}, timeoutMs = 10_000) {
      if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
        throw safeError();
      }
      const controller = new AbortController();
      let timer;
      let statusCode;
      let retryAfter;
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(safeError());
          }, timeoutMs);
        });
        const request = (async () => {
          const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            redirect: 'error',
            signal: controller.signal,
            body: JSON.stringify(params),
          });
          if (response.status >= 400 && response.status <= 599) statusCode = response.status;
          const data = await response.json();
          if (!statusCode) statusCode = data?.error_code;
          retryAfter = data?.parameters?.retry_after;
          if (response.ok !== true || data?.ok !== true || !Object.hasOwn(data, 'result')) throw safeError();
          return data.result;
        })();
        return await Promise.race([request, timeout]);
      } catch {
        throw safeError(statusCode, retryAfter);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function truncate(value, maximum) {
  const text = String(value ?? '');
  if (text.length <= maximum) return text;
  let shortened = text.slice(0, Math.max(0, maximum - 1));
  if (/[\uD800-\uDBFF]$/.test(shortened)) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

// Plain text deliberately has no parse_mode. Keep the complete validated contact
// in the header; only message text is shortened to fit Telegram's 4096 limit.
export function formatLead(lead) {
  const header = `Заявка ${lead.id}\nДата: ${new Date(lead.createdAt).toISOString()}\n`
    + `Имя: ${truncate(lead.name, 80)}\nКонтакт: ${lead.contact}\n`
    + `Услуга: ${truncate(lead.service, 80)}\n\nСообщение:\n`;
  return header + truncate(lead.message || '—', 4096 - header.length);
}

export function notificationParams(chatId, text, replyMarkup) {
  return {
    chat_id: chatId,
    text,
    link_preview_options: { is_disabled: true },
    protect_content: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
}

function keyboard(admin) {
  return { inline_keyboard: [
    [{ text: 'Статус', callback_data: 'admin:status' }],
    [{ text: 'Последние заявки', callback_data: 'admin:recent' }],
    [{
      text: admin.notifications ? 'Уведомления: вкл → выключить' : 'Уведомления: выкл → включить',
      callback_data: admin.notifications ? 'admin:notifications:off' : 'admin:notifications:on',
    }],
  ] };
}

function privateUser(from, chat) {
  return from?.is_bot === false && Number.isSafeInteger(from.id) && from.id > 0
    && chat?.type === 'private' && chat.id === from.id ? from.id : null;
}

function freshAccessCommand(message) {
  const now = Math.floor(Date.now() / 1000);
  return Number.isSafeInteger(message.date) && message.date >= now - 300 && message.date <= now + 60;
}

function statusText(store) {
  const stats = store.stats();
  return `Статус Limitless\nЗаявок: ${stats.totalLeads}\nВ очереди: ${stats.pendingDeliveries}`
    + `\nДоставлено: ${stats.deliveredDeliveries}\nАдминистраторов: ${stats.admins}`
    + `\nС уведомлениями: ${stats.notificationsEnabled}`;
}

function recentText(store) {
  const leads = store.recentLeads(5).slice(0, 5);
  if (!leads.length) return 'Заявок пока нет.';
  return 'Последние заявки\n\n' + leads.map((lead, index) =>
    `${index + 1}. ${truncate(lead.name, 60)} — ${truncate(lead.service, 40)}\n`
      + `${new Date(lead.createdAt).toISOString()}\nКонтакт: ${lead.contact}\n/lead ${lead.id}`).join('\n\n');
}

/**
 * Does not provision an owner or persist /start users.
 * ownerId must also have the persisted owner role for owner-only commands.
 * A missing ownerId allows only public ID commands, even with persisted admins.
 * Access mutations require a Telegram message.date no more than five minutes old.
 */
export function createUpdateHandler({ store, telegram, ownerId }) {
  ownerId = ownerId == null ? null : normalizeAdminId(ownerId);
  const adminFor = id => ownerId === null ? null : store.getAdmin(id);
  const isOwner = id => id === ownerId && adminFor(id)?.role === 'owner';

  async function send(id, text, markup) {
    try {
      await telegram.call('sendMessage', notificationParams(id, text, markup));
    } catch (error) {
      if (error?.statusCode !== 403) throw error;
      if (ownerId !== null) store.setNotifications(id, false);
    }
  }

  async function adminSend(id, buildText, withKeyboard = false) {
    const admin = adminFor(id);
    if (!admin) return send(id, 'Нет доступа.');
    return send(id, buildText(), withKeyboard ? keyboard(admin) : undefined);
  }

  async function answer(callback, text) {
    try {
      await telegram.call('answerCallbackQuery', { callback_query_id: callback.id, ...(text ? { text } : {}) });
    } catch (error) {
      // Expired callback acknowledgement must not poison the polling offset.
      if (error?.statusCode !== 400 && error?.statusCode !== 403) throw error;
    }
  }

  return async function handleUpdate(update) {
    if (!update || typeof update !== 'object') return;
    if (update.callback_query) {
      const callback = update.callback_query;
      const id = privateUser(callback.from, callback.message?.chat);
      if (!id || typeof callback.id !== 'string' || !callback.id || callback.id.length > 256) return;
      if (!adminFor(id)) return answer(callback, 'Нет доступа.');
      const actions = ['admin:status', 'admin:recent', 'admin:notifications:on', 'admin:notifications:off'];
      if (!actions.includes(callback.data)) return answer(callback, 'Неизвестная команда.');
      await answer(callback);
      // A revoke may have completed while answerCallbackQuery was in flight.
      if (!adminFor(id)) return;
      if (callback.data === 'admin:status') return adminSend(id, () => statusText(store), true);
      if (callback.data === 'admin:recent') return adminSend(id, () => recentText(store), true);
      const enabled = callback.data === 'admin:notifications:on';
      store.setNotifications(id, enabled);
      return adminSend(id, () => enabled ? 'Уведомления включены.' : 'Уведомления выключены. Очередь приостановлена.', true);
    }

    const message = update.message;
    const id = privateUser(message?.from, message?.chat);
    if (!id || message.sender_chat || typeof message.text !== 'string' || message.text.length > 4096) return;
    const match = /^\/([a-z_]+)(?:@[a-zA-Z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(message.text.trim());
    if (!match) return;
    const [, command, rawArgument = ''] = match;
    const argument = rawArgument.trim();
    if (command === 'start' || command === 'id') return send(id, String(id));
    if (!['admin', 'lead', 'test', 'add_admin', 'remove_admin', 'admins'].includes(command)) return;
    if (!adminFor(id)) return send(id, 'Нет доступа.');

    if (['add_admin', 'remove_admin', 'admins'].includes(command)) {
      if (!isOwner(id)) return send(id, 'Только владелец может выполнить эту команду.');
      if (command === 'admins') {
        const lines = store.activeAdmins().map(admin => {
          const enabled = store.getAdmin(admin.id)?.notifications;
          return `${admin.id} — ${admin.role}; уведомления ${enabled ? 'вкл' : 'выкл'}`;
        });
        let page = 'Администраторы';
        for (const line of lines) {
          if (page.length + line.length + 1 > 4096) {
            if (!isOwner(id)) return;
            await send(id, page);
            page = 'Администраторы (продолжение)';
          }
          page += `\n${line}`;
        }
        if (isOwner(id)) return send(id, page);
        return;
      }
      if (!freshAccessCommand(message)) {
        return send(id, 'Команда управления доступом устарела или не содержит корректную дату. Отправьте её заново (срок — 5 минут).');
      }
      let target;
      try { target = normalizeAdminId(argument); } catch { return send(id, `Формат: /${command} ID`); }
      if (command === 'add_admin') {
        store.addAdmin(target);
        return send(id, `Администратор ${target} добавлен. Он должен сам открыть бота и отправить /start; эта команда не выдаёт доступ.`);
      }
      if (store.getAdmin(target)?.role === 'owner') return send(id, 'Владельца нельзя удалить.');
      store.revokeAdmin(target);
      return send(id, `Доступ администратора ${target} отозван.`);
    }
    if (command === 'admin') return adminSend(id, () => 'Панель администратора Limitless', true);
    if (command === 'test') {
      return adminSend(id, () => 'Тестовое уведомление Limitless. Это проверка бота, не заявка. Данные формы не используются.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(argument)) {
      return adminSend(id, () => 'Формат: /lead UUID');
    }
    return adminSend(id, () => {
      const lead = store.getLead(argument.toLowerCase());
      return lead ? formatLead(lead) : 'Заявка не найдена или удалена по сроку хранения.';
    });
  };
}
