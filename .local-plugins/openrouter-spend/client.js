window.__ModuleLoader__.load({
  id: 'dsh-openrouter-spend',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** Dictionary namespace declared on the registrations, so `t` reaches the components. */
    const NS = 'openrouter-spend';

    /** Preferences are viewing choices: a browser-local store, not host state. */
    const PREF_KEY_ID = 'ors.keyId';
    const PREF_INTERVAL = 'ors.intervalSeconds';
    const PREF_CURRENCY = 'ors.currency';
    const PREFS_CHANGED = 'ors:prefs';

    const CSS = `
.ors-root { position: relative; display: inline-flex; }
.ors-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 10px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
.ors-chip:hover { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover)); }
.ors-chip[aria-expanded="true"] { color: var(--dsw-alias-label-primary); }
.ors-chip-amount { color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.ors-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-business-primary); }
.ors-chip-dot[data-state="stale"] { background: var(--dsw-alias-state-warn-primary, #c08b00); }
.ors-chip-dot[data-state="loading"] { background: var(--dsw-alias-label-tertiary); }
.ors-chip-dot[data-state="error"], .ors-chip-dot[data-state="no-credential"] { background: var(--dsw-alias-state-error-primary); }
.ors-panel {
  position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 40; width: 340px;
  padding: 12px; border-radius: 12px; text-align: left;
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  border: 0.5px solid var(--dsw-alias-border-l2);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13, 13px/1.45 system-ui);
}
.ors-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ors-label { color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
.ors-figure { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ors-sub { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
.ors-range, .ors-keyrow { display: flex; flex-wrap: wrap; gap: 4px; margin: 10px 0 8px; }
.ors-range button, .ors-key {
  padding: 3px 8px; border-radius: 6px; cursor: pointer; border: 0;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-secondary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
.ors-range button[aria-pressed="true"], .ors-key[aria-pressed="true"] {
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover));
  color: var(--dsw-alias-label-primary);
}
.ors-table { width: 100%; border-collapse: collapse; }
.ors-table th {
  padding: 4px 0; text-align: left; color: var(--dsw-alias-label-tertiary);
  font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); font-weight: 400;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.ors-table th:last-child, .ors-table td:last-child { text-align: right; }
.ors-table td { padding: 4px 0; border-bottom: 0.5px solid var(--dsw-alias-separator-primary); vertical-align: top; }
.ors-table td:first-child { padding-right: 8px; word-break: break-word; }
.ors-num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.ors-bars { display: flex; align-items: flex-end; gap: 1px; height: 34px; margin-top: 10px; }
.ors-bar { flex: 1 1 0; min-height: 1px; border-radius: 1px; background: var(--dsw-alias-state-business-primary); opacity: 0.65; }
.ors-bar[data-today="true"] { opacity: 1; }
.ors-note { margin-top: 8px; color: var(--dsw-alias-state-warn-primary, #c08b00); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui); }
.ors-settings { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
.ors-field { display: flex; flex-direction: column; gap: 4px; }
.ors-field input, .ors-field select {
  padding: 6px 8px; border-radius: 8px;
  border: 0.5px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-xs-13, 13px/1.45 system-ui);
}
.ors-actions { display: flex; gap: 6px; align-items: center; }
.ors-actions button {
  padding: 5px 10px; border-radius: 8px; cursor: pointer; border: 0;
  background: var(--dsw-alias-interactive-bg-hover, transparent);
  color: var(--dsw-alias-label-primary); font: var(--dsw-font-xxs-12, 12px/1.4 system-ui);
}
`;

    /**
     * Money with the precision a sub-cent figure needs, and none it does not.
     * USD prints as an invoice writes it (`$1.23`), RUB as a receipt does
     * (`1.23 ₽`).
     */
    function fmtMoney(value, currency) {
      const amount = Number(value) || 0;
      const magnitude = Math.abs(amount);
      const digits = magnitude === 0 ? 2 : magnitude < 0.01 ? 4 : magnitude < 1 ? 3 : 2;
      return currency === 'RUB' ? `${amount.toFixed(digits)} ₽` : `$${amount.toFixed(digits)}`;
    }

    /**
     * The display money for one currency choice. OpenRouter bills USD and the
     * wire stays USD; RUB is that figure at the cbr.ru rate. Without a rate the
     * USD presentation is kept — the caller adds the "check cbr.ru" note — so a
     * dead cbr.ru costs the conversion, never the numbers.
     */
    function makeMoney(currency, perUsd) {
      const rate = Number(perUsd);
      const rub = currency === 'RUB' && Number.isFinite(rate) && rate > 0;
      return {
        rub,
        perUsd: rub ? rate : undefined,
        symbol: rub ? '₽' : '$',
        fmt: value => fmtMoney(rub ? (Number(value) || 0) * rate : value, rub ? 'RUB' : 'USD'),
      };
    }

    const fmtInt = value => Number(value || 0).toLocaleString('en-US');

    /** A stable color per API key, so one key keeps its hue across reloads. */
    function keyTint(id) {
      let hash = 0;
      for (const char of String(id)) hash = (hash * 31 + char.codePointAt(0)) % 360;
      return `hsl(${hash} 62% 55%)`;
    }

    /** Read one viewing preference; private mode reads as the default. */
    function readPref(name, fallback) {
      try {
        const stored = window.localStorage.getItem(name);
        return stored === null ? fallback : stored;
      } catch {
        return fallback;
      }
    }

    /** The display currency preference; anything else in storage reads as USD. */
    function readCurrency() {
      return readPref(PREF_CURRENCY, 'USD') === 'RUB' ? 'RUB' : 'USD';
    }

    /** Store one viewing preference and tell the other component about it. */
    function writePref(name, value) {
      try {
        window.localStorage.setItem(name, value);
      } catch {
        // Private mode keeps the session usable; the choice simply does not persist.
      }
      window.dispatchEvent(new CustomEvent(PREFS_CHANGED));
    }

    /** One shared fetch of the host summary. */
    function fetchSummary() {
      return fetch('/openrouter-spend/summary', {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      }).then(response => (response.ok ? response.json() : undefined)).catch(() => undefined);
    }

    function Pill(props) {
      const { t } = props;
      const [data, setData] = useState(null);
      const [open, setOpen] = useState(false);
      const [range, setRange] = useState('today');
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [intervalSeconds, setIntervalSeconds] = useState(() => Number(readPref(PREF_INTERVAL, '0')));
      const [currency, setCurrency] = useState(readCurrency);
      const rootRef = useRef(null);

      useEffect(() => { void fetchSummary().then(reply => { if (reply !== undefined) setData(reply); }); }, []);

      const seconds = intervalSeconds > 0 ? intervalSeconds : Number(data?.refreshSeconds) || 60;
      useEffect(() => {
        const timer = setInterval(() => {
          void fetchSummary().then(reply => { if (reply !== undefined) setData(reply); });
        }, seconds * 1000);
        return () => clearInterval(timer);
      }, [seconds]);

      // The Settings section writes the same preferences; follow it live.
      useEffect(() => {
        const sync = () => {
          setKeyId(readPref(PREF_KEY_ID, ''));
          setIntervalSeconds(Number(readPref(PREF_INTERVAL, '0')));
          setCurrency(readCurrency());
        };
        window.addEventListener(PREFS_CHANGED, sync);
        return () => window.removeEventListener(PREFS_CHANGED, sync);
      }, []);

      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = event => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKeyDown = event => { if (event.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('mousedown', onPointerDown);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const chooseKey = useCallback(id => {
        setKeyId(id);
        writePref(PREF_KEY_ID, id);
      }, []);

      const keys = data?.byKey ?? [];
      const selected = keys.find(entry => entry.id === keyId);

      const view = useMemo(() => {
        if (selected !== undefined) {
          if (range === 'today') return { usd: selected.todayUsd, requests: selected.todayRequests };
          if (range === 'last7') return selected.last7;
          return selected.last30;
        }
        if (range === 'today') return data?.todaySpend ?? { usd: 0, requests: 0 };
        if (range === 'last7') return data?.last7 ?? { usd: 0, requests: 0 };
        return data?.last30 ?? { usd: 0, requests: 0 };
      }, [data, selected, range]);

      const rows = selected !== undefined ? selected.todayModels : (data?.byModel ?? []);
      const bars = data?.byDay ?? [];
      const peak = bars.reduce((max, entry) => Math.max(max, entry.usd), 0);
      const balance = data?.credits ? data.credits.totalCredits - data.credits.totalUsage : undefined;
      const rangeLabel = range === 'today' ? t('today') : range === 'last7' ? t('last7') : t('last30');
      const money = makeMoney(currency, data?.rate?.perUsd);
      // RUB was chosen but cbr.ru answered no rate: figures stay in USD and say so.
      const rubUnavailable = currency === 'RUB' && data !== null && !money.rub;

      if (data !== null && data.status === 'no-credential') {
        return h('span', { className: 'ors-root' },
          h('style', null, CSS),
          h('span', { className: 'ors-chip', title: t('noCredential') },
            h('span', { className: 'ors-chip-dot', 'data-state': 'no-credential' }),
            t('noCredential')));
      }

      return h('div', { className: 'ors-root', ref: rootRef },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'ors-chip',
          'aria-expanded': open,
          'aria-label': t('open'),
          title: t('open'),
          onClick: () => setOpen(value => !value),
        },
        h('span', { className: 'ors-chip-dot', 'data-state': data?.status ?? 'loading' }),
        h('span', { className: 'ors-chip-amount' }, data === null ? t('loading') : money.fmt(view.usd))),
        open && h('div', { className: 'ors-panel' },
          h('div', { className: 'ors-head' },
            h('span', { className: 'ors-label' }, rangeLabel),
            h('span', { className: 'ors-figure' }, money.fmt(view.usd))),
          h('div', { className: 'ors-sub' },
            `${fmtInt(view.requests)} ${t('requests')}`
            + (data?.refreshedAt === undefined
              ? ''
              : ` · ${t('updated')} ${new Date(data.refreshedAt).toLocaleTimeString()}`)),
          money.rub && h('div', { className: 'ors-sub' },
            `${t('cbrRate')}: 1 USD = ${money.perUsd.toFixed(2)} ₽`),
          rubUnavailable && h('div', { className: 'ors-note' }, t('rubFallback')),
          rubUnavailable && data?.rateError !== undefined
            ? h('div', { className: 'ors-sub' }, data.rateError)
            : null,
          h('div', { className: 'ors-range' },
            ['today', 'last7', 'last30'].map(id => h('button', {
              key: id,
              type: 'button',
              'aria-pressed': range === id,
              onClick: () => setRange(id),
            }, id === 'today' ? t('today') : id === 'last7' ? t('last7') : t('last30')))),
          balance === undefined ? null : h('div', { className: 'ors-sub' },
            `${t('balance')}: ${money.fmt(balance)} · ${t('lifetime')}: ${money.fmt(data.credits.totalUsage)}`),
          keys.length > 0 && h('div', null,
            h('div', { className: 'ors-sub' }, t('byKey')),
            h('div', { className: 'ors-keyrow' },
              [null, ...keys.map(entry => entry.id)].map(id => h('button', {
                key: id ?? '__all__',
                type: 'button',
                className: 'ors-key',
                'aria-pressed': keyId === (id ?? ''),
                style: id === null ? undefined : { color: keyTint(id) },
                onClick: () => chooseKey(id ?? ''),
              }, id === null ? t('allKeys') : id))),
            h('div', { className: 'ors-sub' }, t('byModel'))),
          h('table', { className: 'ors-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('byModel')),
              h('th', null, money.symbol),
              h('th', null, t('requests')))),
            h('tbody', null, rows.length === 0
              ? h('tr', null, h('td', { colSpan: 3, className: 'ors-label' }, '—'))
              : rows.map(entry => h('tr', { key: entry.id },
                h('td', null, entry.id),
                h('td', { className: 'ors-num' }, money.fmt(entry.usd)),
                h('td', { className: 'ors-num' }, fmtInt(entry.requests)))))),
          bars.length > 0 && peak > 0 && h('div', { className: 'ors-bars' },
            bars.map(entry => h('div', {
              key: entry.date,
              className: 'ors-bar',
              'data-today': entry.date === data.today,
              style: { height: `${Math.max(2, Math.round((entry.usd / peak) * 34))}px` },
              title: `${entry.date} · ${money.fmt(entry.usd)}`,
            }))),
          data?.error === undefined ? null : h('div', { className: 'ors-note' }, data.error)));
    }

    function Settings(props) {
      const { t } = props;
      const [data, setData] = useState(null);
      const [keyId, setKeyId] = useState(() => readPref(PREF_KEY_ID, ''));
      const [intervalSeconds, setIntervalSeconds] = useState(() => readPref(PREF_INTERVAL, '0'));
      const [currency, setCurrency] = useState(readCurrency);
      const [draft, setDraft] = useState('');
      const [notice, setNotice] = useState(null);

      const reload = useCallback(async () => {
        const reply = await fetchSummary();
        if (reply !== undefined) setData(reply);
      }, []);

      useEffect(() => { void reload(); }, [reload]);

      const submit = useCallback(async body => {
        setNotice(null);
        try {
          const response = await fetch('/openrouter-spend/credential', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const reply = await response.json();
          if (!response.ok) {
            setNotice(reply?.error ?? `${response.status}`);
            return;
          }
          setData(reply);
          setDraft('');
          setNotice(t('saved'));
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
        }
      }, [t]);

      const credential = data?.credential;
      const keys = data?.byKey ?? [];
      const money = makeMoney(currency, data?.rate?.perUsd);
      // RUB was chosen but cbr.ru answered no rate: figures stay in USD and say so.
      const rubUnavailable = currency === 'RUB' && data !== null && !money.rub;
      const selectKey = value => {
        setKeyId(value);
        writePref(PREF_KEY_ID, value);
      };
      const selectInterval = value => {
        setIntervalSeconds(value);
        writePref(PREF_INTERVAL, value);
      };
      const selectCurrency = value => {
        setCurrency(value);
        writePref(PREF_CURRENCY, value);
      };

      return h('div', { className: 'ors-settings' },
        h('style', null, CSS),
        h('div', null,
          h('div', { className: 'ors-head' },
            h('span', { className: 'ors-label' }, t('today')),
            h('span', { className: 'ors-figure' },
              money.fmt(data?.todaySpend?.usd ?? 0))),
          h('div', { className: 'ors-sub' },
            `${fmtInt(data?.todaySpend?.requests ?? 0)} ${t('requests')}`
            + (data?.credits === undefined
              ? ''
              : ` · ${t('balance')}: ${money.fmt(data.credits.totalCredits - data.credits.totalUsage)}`)),
          data?.error === undefined ? null : h('div', { className: 'ors-note' }, data.error)),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('currency')),
          h('select', { value: currency, onChange: event => selectCurrency(event.target.value) },
            h('option', { value: 'USD' }, t('currencyUsd')),
            h('option', { value: 'RUB' }, t('currencyRub'))),
          money.rub
            ? h('div', { className: 'ors-sub' }, `${t('cbrRate')}: 1 USD = ${money.perUsd.toFixed(2)} ₽`)
            : null,
          rubUnavailable ? h('div', { className: 'ors-note' }, t('rubFallback')) : null,
          rubUnavailable && data?.rateError !== undefined
            ? h('div', { className: 'ors-sub' }, data.rateError)
            : null),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('countByKey')),
          h('select', { value: keyId, onChange: event => selectKey(event.target.value) },
            h('option', { value: '' }, t('allKeys')),
            keys.map(entry => h('option', { key: entry.id, value: entry.id },
              `${entry.id} · ${money.fmt(entry.todayUsd)} ${t('today')}`)),
            keyId !== '' && keys.every(entry => entry.id !== keyId)
              ? h('option', { value: keyId }, `${keyId} · ${t('unknownKey')}`)
              : null)),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('refreshEvery')),
          h('select', { value: intervalSeconds, onChange: event => selectInterval(event.target.value) },
            h('option', { value: '0' }, `${t('serverDefault')} (${data?.refreshSeconds ?? 60}s)`),
            ['30', '60', '300', '900'].map(value => h('option', { key: value, value }, `${value}s`)))),
        h('div', { className: 'ors-field' },
          h('label', { className: 'ors-sub' }, t('managementKey')),
          h('input', {
            type: 'password',
            value: draft,
            placeholder: credential?.configured === true ? '••••••••' : '',
            autoComplete: 'off',
            spellCheck: false,
            onChange: event => setDraft(event.target.value),
          }),
          credential?.configured === true
            ? h('div', { className: 'ors-sub' },
              `${t('keyStored')} (${credential.ref}${credential.source === undefined ? '' : ` · ${credential.source}`})`)
            : h('div', { className: 'ors-sub' }, t('keyHint')),
          h('div', { className: 'ors-actions' },
            h('button', {
              type: 'button',
              disabled: draft.length === 0,
              onClick: () => { void submit({ value: draft }); },
            }, t('save')),
            credential?.configured === true && h('button', {
              type: 'button',
              onClick: () => { void submit({ clear: true }); },
            }, t('clear')),
            h('button', { type: 'button', onClick: () => { void reload(); } }, t('reload'))),
          credential?.writable === false
            ? h('div', { className: 'ors-note' }, t('keyReadOnly'))
            : null,
          notice === null ? null : h('div', { className: 'ors-sub' }, notice)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The nav label is read through a thunk so it follows the active locale.
        let tr = key => key;
        ctx.effect(() => {
          const dispose = ctx.locale.register(NS, {
          en: {
            today: 'Today',
            last7: '7 days',
            last30: '30 days',
            requests: 'requests',
            balance: 'Balance',
            lifetime: 'Lifetime',
            byModel: 'Model',
            byKey: 'API key',
            allKeys: 'All keys',
            unknownKey: 'not seen today',
            noCredential: 'No management key',
            loading: 'Loading…',
            updated: 'Updated',
            open: 'OpenRouter spend',
            countByKey: 'Count only this API key',
            refreshEvery: 'Refresh every',
            serverDefault: 'Plugin default',
            currency: 'Display currency',
            currencyUsd: 'USD (billed by OpenRouter)',
            currencyRub: 'RUB (converted at the CBR rate)',
            cbrRate: 'CBR rate',
            rubFallback: 'RUB is unavailable: the rate could not be fetched from cbr.ru. Amounts are shown in USD — check that cbr.ru is reachable.',
            managementKey: 'Management API key',
            keyStored: 'Stored as',
            keyHint: 'Needs an OpenRouter management key: Settings → API keys → Management.',
            keyReadOnly: 'A read-only source shadows this reference, so Settings cannot store it.',
            save: 'Save',
            clear: 'Clear',
            reload: 'Reload',
            saved: 'Saved',
          },
          zh: {
            today: '今天',
            last7: '7 天',
            last30: '30 天',
            requests: '请求',
            balance: '余额',
            lifetime: '累计',
            byModel: '模型',
            byKey: 'API 密钥',
            allKeys: '全部密钥',
            unknownKey: '今天未出现',
            noCredential: '未配置管理密钥',
            loading: '读取中…',
            updated: '更新于',
            open: 'OpenRouter 花费',
            countByKey: '只统计这个 API 密钥',
            refreshEvery: '刷新间隔',
            serverDefault: '插件默认',
            currency: '显示货币',
            currencyUsd: 'USD（OpenRouter 计费货币）',
            currencyRub: 'RUB（按俄罗斯央行汇率换算）',
            cbrRate: '央行汇率',
            rubFallback: 'RUB 不可用：无法从 cbr.ru 获取汇率。金额以 USD 显示——请检查到 cbr.ru 的连接。',
            managementKey: '管理密钥',
            keyStored: '已保存为',
            keyHint: '需要 OpenRouter 管理密钥：Settings → API keys → Management。',
            keyReadOnly: '该引用被只读来源遮蔽，无法在设置中保存。',
            save: '保存',
            clear: '清除',
            reload: '刷新',
            saved: '已保存',
          },
          ru: {
            today: 'Сегодня',
            last7: '7 дней',
            last30: '30 дней',
            requests: 'запросов',
            balance: 'Баланс',
            lifetime: 'Всего',
            byModel: 'Модель',
            byKey: 'API-ключ',
            allKeys: 'Все ключи',
            unknownKey: 'сегодня не было',
            noCredential: 'Ключ не настроен',
            loading: 'Загрузка…',
            updated: 'Обновлено',
            open: 'Расходы OpenRouter',
            countByKey: 'Учитывать только этот API-ключ',
            refreshEvery: 'Обновлять каждые',
            serverDefault: 'По умолчанию',
            currency: 'Валюта',
            currencyUsd: 'USD (как списывает OpenRouter)',
            currencyRub: 'RUB (по курсу ЦБ РФ)',
            cbrRate: 'Курс ЦБ',
            rubFallback: 'RUB недоступен: не удалось получить курс с cbr.ru. Суммы показаны в USD — проверьте подключение к cbr.ru.',
            managementKey: 'Управляющий API-ключ',
            keyStored: 'Сохранён как',
            keyHint: 'Нужен управляющий ключ OpenRouter: Settings → API keys → Management.',
            keyReadOnly: 'Эта ссылка перекрыта источником только для чтения, настройки не могут её сохранить.',
            save: 'Сохранить',
            clear: 'Очистить',
            reload: 'Обновить',
            saved: 'Сохранено',
          },
        });
          tr = ctx.locale.bind(NS);
          return dispose;
        });
        const section = { id: 'openrouter-spend', order: 30, label: () => tr('open'), locale: NS };
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'openrouter-spend', order: 2, label: section.label, locale: NS,
        }, Pill));
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', ...section,
        }, Settings));
      },
    };
  },
});