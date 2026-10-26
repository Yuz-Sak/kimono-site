(() => {
  'use strict';

  const EXPENSE_CATEGORIES = ['梱包材', '撮影・小物', 'クリーニング・補修', '通信費', '消耗品', 'その他'];
  const SET_STATUSES = ['出品前', '出品中', '売却済み'];
  const DATA_KEYS = ['masters', 'purchases', 'items', 'sets', 'sales', 'expenses', 'photos', 'supply_purchases', 'settings'];
  const STORE_NAMES = [...DATA_KEYS, 'photo_files'];
  const STORE_OPTIONS = {
    masters: { keyPath: 'id' },
    purchases: { keyPath: 'id' },
    items: { keyPath: 'id' },
    sets: { keyPath: 'id' },
    sales: { keyPath: 'id' },
    expenses: { keyPath: 'id' },
    photos: { keyPath: 'id' },
    photo_files: {},
    supply_purchases: { keyPath: 'id' },
    settings: { keyPath: 'key' },
    outbox: { keyPath: ['store', 'id'] },
  };
  const SUPPLY_KINDS = [
    { kind: 'obiage', name: '帯揚げ' },
    { kind: 'obijime', name: '帯締め' },
  ];
  const DEFAULT_PACKAGING_COST = 150;
  const SEEDS = [
    { kind: 'category', name: 'きもの', fee_rate: 0 },
    { kind: 'category', name: '帯', fee_rate: 0 },
    { kind: 'category', name: 'その他', fee_rate: 0 },
    { kind: 'supplier', name: 'ヤフオク', fee_rate: 0 },
    { kind: 'supplier', name: '直接', fee_rate: 0 },
    { kind: 'channel', name: 'メルカリ', fee_rate: 10 },
    { kind: 'channel', name: '直接', fee_rate: 0 },
  ];
  const DB_NAME = 'kimono_site';
  const DB_VERSION = 4;
  const BACKUP_VERSION = 3;
  // Pending sync changes: one entry per record, and the latest change replaces earlier ones.
  const OUTBOX = 'outbox';
  const SYNC_KEY = 'kimono_sync';
  const SYNC_BATCH = 200;
  const PULL_PAGE = 500;
  const AUTO_SYNC_DELAY = 1200;
  const AUTO_SYNC_COOLDOWN = 15000;
  const MAX_PHOTO_SIZE = 1600;
  // Stores whose record ids are UUIDs, the reference fields that point at them, and the stores rewritten on id migration.
  const ID_STORES = ['masters', 'purchases', 'items', 'sets', 'sales', 'expenses', 'supply_purchases'];
  const REKEY_STORES = [...ID_STORES, 'photos'];
  const ID_REFS = {
    items: { purchase_id: 'purchases', set_id: 'sets' },
    sets: { cover_item_id: 'items' },
    sales: { set_id: 'sets' },
    photos: { item_id: 'items', set_id: 'sets' },
  };

  const main = document.getElementById('app');
  const pendingEl = document.getElementById('pending');
  const syncStatusEl = document.getElementById('sync-status');
  const syncButton = document.getElementById('sync-button');
  const objectUrls = [];
  const pendingPhotoDownloads = new Map();
  let dbPromise = null;
  let renderSeq = 0;
  let toastTimer = null;
  let accessToken = null;
  let accessExpiresAt = 0;
  let syncRunning = false;
  let syncQueued = false;
  let remoteWaiting = false;
  let autoSyncTimer = null;
  let lastAutoSyncAt = 0;

  class FormError extends Error {}

  class SyncError extends Error {
    constructor(message, needsLogin = false) {
      super(message);
      this.needsLogin = needsLogin;
    }
  }

  // Record ids are UUID strings. seq is the creation order used for sorting in place of the old numeric ids.
  const newId = () => (crypto.randomUUID
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  let lastSeq = 0;
  const nextSeq = () => {
    lastSeq = Math.max(Date.now(), lastSeq + 1);
    return lastSeq;
  };

  /* ---------- IndexedDB ---------- */

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = req.result;
          const tx = req.transaction;
          // Upgrades keep existing records: only missing stores are created.
          Object.entries(STORE_OPTIONS).forEach(([name, options]) => {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
          });
          const sales = tx.objectStore('sales');
          if (!sales.indexNames.contains('set_id')) sales.createIndex('set_id', 'set_id', { unique: true });
          if (event.oldVersion === 0) {
            const masters = tx.objectStore('masters');
            SEEDS.forEach((seed, i) => masters.add({ ...seed, id: newId(), seq: i + 1 }));
          } else if (event.oldVersion < 3) {
            retireRibbonCategory(tx);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  // 帯紐 is retired: its master entry is removed and its items move to その他.
  function retireRibbonCategory(tx) {
    const masters = tx.objectStore('masters');
    masters.getAll().onsuccess = (e) => {
      e.target.result
        .filter((m) => m.kind === 'category' && m.name === '帯紐')
        .forEach((m) => masters.delete(m.id));
    };
    const items = tx.objectStore('items');
    items.getAll().onsuccess = (e) => {
      e.target.result
        .filter((i) => i.category === '帯紐')
        .forEach((i) => items.put({ ...i, category: 'その他' }));
    };
  }

  // Writes to synced stores are queued in the outbox inside the same transaction.
  function dbTx(names, mode, build) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const writing = mode === 'readwrite';
      const txNames = writing ? [...new Set([...names, OUTBOX])] : names;
      const tx = db.transaction(txNames, mode);
      const stores = {};
      txNames.forEach((name) => { stores[name] = tx.objectStore(name); });
      if (writing) {
        names.filter((name) => DATA_KEYS.includes(name)).forEach((name) => {
          stores[name] = trackedStore(stores[name], stores[OUTBOX]);
        });
      }
      const requests = (build && build(stores)) || {};
      tx.oncomplete = () => resolve(Object.fromEntries(
        Object.entries(requests).map(([key, req]) => [key, req.result]),
      ));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  }

  // clear() is deliberately not queued. Callers queue the removals they need.
  function trackedStore(store, outbox) {
    const queue = (id, deleted) => queueChange(outbox, store.name, id, deleted);
    return {
      put: (value) => { const req = store.put(value); queue(value[store.keyPath], false); return req; },
      add: (value) => { const req = store.add(value); queue(value[store.keyPath], false); return req; },
      delete: (id) => { const req = store.delete(id); queue(id, true); return req; },
      clear: () => store.clear(),
    };
  }

  function queueChange(outbox, store, id, deleted) {
    outbox.put({ store, id, deleted, seq: nextSeq() });
    scheduleAutoSync();
  }

  function scheduleAutoSync() {
    if (!loadSync().refreshToken || !navigator.onLine) return;
    clearTimeout(autoSyncTimer);
    const cooldown = AUTO_SYNC_COOLDOWN - (Date.now() - lastAutoSyncAt);
    autoSyncTimer = setTimeout(() => requestAutoSync(), Math.max(AUTO_SYNC_DELAY, cooldown));
  }

  function pendingCount() {
    return dbTx([OUTBOX], 'readonly', (s) => ({ count: s.outbox.count() })).then((r) => r.count);
  }

  function loadState() {
    return dbTx(DATA_KEYS, 'readonly', (s) => (
      Object.fromEntries(DATA_KEYS.map((k) => [k, s[k].getAll()]))
    ));
  }

  function deletePhotos(ids) {
    if (!ids.length) return Promise.resolve();
    return dbTx(['photos', 'photo_files'], 'readwrite', (s) => {
      ids.forEach((id) => {
        s.photos.delete(id);
        s.photo_files.delete(id);
      });
    });
  }

  async function shrinkImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('画像の変換に失敗しました'))),
        'image/jpeg',
        0.85,
      );
    });
  }

  async function addPhotos(files, owner) {
    let skipped = 0;
    for (const file of Array.from(files || [])) {
      try {
        const blob = await shrinkImage(file);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await dbTx(['photos', 'photo_files'], 'readwrite', (s) => {
          s.photos.add({ id, ...owner, created: Date.now() });
          s.photo_files.put(blob, id);
        });
      } catch (err) {
        console.error(err);
        skipped += 1;
      }
    }
    if (skipped) alert(`${skipped}件は画像として読み込めなかったため追加されませんでした。`);
  }

  async function photoUrls(ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    const map = new Map();
    if (!unique.length) return map;
    const files = await dbTx(['photo_files'], 'readonly', (s) => (
      Object.fromEntries(unique.map((id) => [id, s.photo_files.get(id)]))
    ));
    const missing = unique.filter((id) => !files[id]);
    if (missing.length && isSyncConfigured() && loadSync().refreshToken) {
      await Promise.all(missing.map(async (id) => {
        try {
          files[id] = await downloadPhotoFile(id);
        } catch (err) {
          console.error(err);
          setSyncState(err instanceof SyncError ? err.message : '写真を取得できませんでした', true);
        }
      }));
    }
    Object.entries(files).forEach(([id, blob]) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      map.set(id, url);
    });
    return map;
  }

  function revokeUrls() {
    objectUrls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /* ---------- Derived data ---------- */

  const sum = (list) => list.reduce((acc, v) => acc + v, 0);
  const itemCost = (i) => i.price + i.shipping;
  const rateOf = (profit, income) => (income > 0 ? profit / income : null);
  const newestFirst = (key) => (a, b) => {
    if (a[key] !== b[key]) return a[key] < b[key] ? 1 : -1;
    return b.seq - a.seq;
  };
  const byDateThenSeq = (key) => (a, b) => {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    return a.seq - b.seq;
  };
  const masterList = (st, kind) => st.masters
    .filter((m) => m.kind === kind)
    .sort((a, b) => a.seq - b.seq);
  const namesOf = (st, kind) => masterList(st, kind).map((m) => m.name);
  const allowed = (names, ...extra) => [...names, ...extra.filter((v) => v && !names.includes(v))];
  // Sort comparator that puts the cover item first; other items keep their order.
  const coverFirst = (coverId) => (a, b) => (b.id === coverId) - (a.id === coverId);
  const packagingCostOf = (st) => st.settings.find((x) => x.key === 'packaging_cost')?.value ?? DEFAULT_PACKAGING_COST;

  function groupBy(list, keyOf) {
    const map = new Map();
    list.forEach((item) => {
      const key = keyOf(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    });
    return map;
  }

  function derive(st) {
    const setById = new Map(st.sets.map((s) => [s.id, s]));
    const saleBySet = new Map(st.sales.map((s) => [s.set_id, s]));
    const membersBySet = groupBy(st.items.filter((i) => i.set_id != null), (i) => i.set_id);
    const photos = [...st.photos].sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
    const setPhotos = groupBy(photos.filter((p) => p.set_id != null), (p) => p.set_id);
    const itemPhotos = groupBy(photos.filter((p) => p.item_id != null), (p) => p.item_id);

    const itemRows = st.items.map((i) => ({
      ...i,
      cost: itemCost(i),
      set_name: setById.get(i.set_id)?.name ?? null,
      thumb: itemPhotos.get(i.id)?.[0]?.id ?? null,
    })).sort(newestFirst('purchased_on'));

    // Display order: photos added to the set (newest first), then member photos with the cover item first.
    const setRows = st.sets.map((s) => {
      const sale = saleBySet.get(s.id) || null;
      const members = membersBySet.get(s.id) || [];
      const supplies = s.supplies || [];
      const cost = sum(members.map(itemCost)) + sum(supplies.map((x) => x.unit_cost * x.qty));
      const sold = sale !== null;
      const revenue = sold ? sale.sale_price : 0;
      const fees = sold ? sale.platform_fee + sale.shipping_cost : 0;
      const gallery = [
        ...[...(setPhotos.get(s.id) || [])].reverse(),
        ...[...members].sort(coverFirst(s.cover_item_id)).flatMap((i) => itemPhotos.get(i.id) || []),
      ];
      return {
        ...s,
        sale,
        sold,
        members,
        supplies,
        cost,
        revenue,
        fees,
        profit: sold ? revenue - fees - cost : null,
        item_count: members.length,
        item_names: members.map((i) => i.code).join(' / '),
        display_status: sold ? '売却済み' : s.status,
        gallery,
        thumb: gallery[0]?.id ?? null,
      };
    }).sort((a, b) => b.seq - a.seq);

    const unsoldSets = setRows.filter((s) => !s.sold);
    const unassignedItems = itemRows.filter((i) => i.set_id == null);

    // 備品 stock = purchased count - count used by sets. Unit cost is the cumulative average.
    const supplyStock = Object.fromEntries(SUPPLY_KINDS.map(({ kind, name }) => {
      const bought = st.supply_purchases.filter((p) => p.kind === kind);
      const count = sum(bought.map((p) => p.count));
      const total = sum(bought.map((p) => p.total));
      const used = sum(st.sets.flatMap((s) => s.supplies || []).filter((x) => x.kind === kind).map((x) => x.qty));
      const unit = count ? Math.round(total / count) : 0;
      const left = count - used;
      return [kind, { kind, name, count, total, unit, left, value: left * unit }];
    }));

    return {
      setById,
      saleBySet,
      setPhotos,
      itemPhotos,
      setRows,
      itemRows,
      unsoldSets,
      unassignedItems,
      supplyStock,
      stockCost: sum(unsoldSets.map((s) => s.cost))
        + sum(unassignedItems.map((i) => i.cost))
        + sum(Object.values(supplyStock).map((s) => s.value)),
      listedValue: sum(unsoldSets.filter((s) => s.status === '出品中').map((s) => s.list_price)),
    };
  }

  // Cash-basis ledger: sales by 販売日, purchases by 仕入れ日, expenses by 支出日.
  function ledger(st, match) {
    const sales = st.sales.filter((s) => match(s.sold_on));
    const income = sum(sales.map((s) => s.sale_price));
    const sales_cost = sum(sales.map((s) => s.platform_fee + s.shipping_cost));
    const purchase = sum(st.items.filter((i) => match(i.purchased_on)).map(itemCost))
      + sum(st.supply_purchases.filter((p) => match(p.purchased_on)).map((p) => p.total));
    const expense = sum(st.expenses.filter((e) => match(e.spent_on)).map((e) => e.amount));
    const profit = income - sales_cost - purchase - expense;
    return {
      income,
      sales_cost,
      purchase,
      expense,
      profit,
      count: sales.length,
      rate: rateOf(profit, income),
    };
  }

  function monthlyRows(st, year) {
    const inYear = (date) => year == null || date.startsWith(`${year}-`);
    const months = new Map();
    const month = (ym) => {
      if (!months.has(ym)) {
        months.set(ym, { ym, income: 0, sales_cost: 0, purchase: 0, expense: 0, count: 0 });
      }
      return months.get(ym);
    };
    st.sales.filter((s) => inYear(s.sold_on)).forEach((s) => {
      const m = month(s.sold_on.slice(0, 7));
      m.income += s.sale_price;
      m.sales_cost += s.platform_fee + s.shipping_cost;
      m.count += 1;
    });
    st.items.filter((i) => inYear(i.purchased_on)).forEach((i) => {
      month(i.purchased_on.slice(0, 7)).purchase += itemCost(i);
    });
    st.supply_purchases.filter((p) => inYear(p.purchased_on)).forEach((p) => {
      month(p.purchased_on.slice(0, 7)).purchase += p.total;
    });
    st.expenses.filter((e) => inYear(e.spent_on)).forEach((e) => {
      month(e.spent_on.slice(0, 7)).expense += e.amount;
    });
    return [...months.values()]
      .map((m) => {
        const profit = m.income - m.sales_cost - m.purchase - m.expense;
        return { ...m, profit, rate: rateOf(profit, m.income) };
      })
      .sort((a, b) => (a.ym < b.ym ? 1 : -1));
  }

  function totals(rows) {
    const t = rows.reduce((acc, r) => ({
      income: acc.income + r.income,
      sales_cost: acc.sales_cost + r.sales_cost,
      purchase: acc.purchase + r.purchase,
      expense: acc.expense + r.expense,
      profit: acc.profit + r.profit,
      count: acc.count + r.count,
    }), { income: 0, sales_cost: 0, purchase: 0, expense: 0, profit: 0, count: 0 });
    return { ...t, rate: rateOf(t.profit, t.income) };
  }

  function yearsList(st) {
    const years = new Set([new Date().getFullYear()]);
    st.sales.forEach((s) => years.add(Number(s.sold_on.slice(0, 4))));
    st.items.forEach((i) => years.add(Number(i.purchased_on.slice(0, 4))));
    st.supply_purchases.forEach((p) => years.add(Number(p.purchased_on.slice(0, 4))));
    st.expenses.forEach((e) => years.add(Number(e.spent_on.slice(0, 4))));
    return [...years].sort((a, b) => b - a);
  }

  /* ---------- Helpers ---------- */

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const yen = (v) => `${Math.trunc(Number(v) || 0).toLocaleString('ja-JP')}円`;
  const pct = (rate) => (rate == null ? '-' : `${(rate * 100).toFixed(1)}%`);
  const signClass = (v) => (v >= 0 ? 'plus' : 'minus');
  const pad2 = (n) => String(n).padStart(2, '0');
  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const selectOptions = (list, selected) => list.map((n) => opt(n, n, n === selected)).join('');
  const kpi = (label, value, cls = '') => `<div class="card kpi"><div class="muted">${label}</div><div class="value ${cls}">${value}</div></div>`;
  const tabLink = (href, label, active) => `<a class="tab${active ? ' active' : ''}" href="${href}">${esc(label)}</a>`;

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function notify(message, kind = 'ok') {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `toast show${kind === 'error' ? ' error' : ''}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  function badgeClass(set) {
    if (set.sold) return 'sold';
    return set.status === '出品中' ? 'listed' : 'stock';
  }

  function parseHash() {
    const [path, qs = ''] = (location.hash.replace(/^#/, '') || '/').split('?');
    return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs) };
  }

  function route(parts) {
    const [head, arg, sub] = parts;
    if (head === undefined) return { view: viewHome };
    if (head === 'items') {
      if (arg === undefined) return { view: viewItems };
      if (arg === 'new') return { view: viewPurchaseForm };
      return { view: viewItemForm, id: arg };
    }
    if (head === 'stock') return { view: viewStock };
    if (head === 'supplies') return { view: viewSupplies };
    if (head === 'sets') {
      if (arg === undefined) return { view: viewSets };
      if (arg === 'new') return { view: viewSetForm, id: null };
      if (sub === 'edit') return { view: viewSetForm, id: arg };
      return { view: viewSetDetail, id: arg };
    }
    if (head === 'expenses') {
      if (arg === undefined) return { view: viewExpenses };
      if (arg === 'new') return { view: viewExpenseForm, id: null };
      return { view: viewExpenseForm, id: arg };
    }
    if (head === 'report') return { view: viewReport };
    if (head === 'settings') return { view: viewSettings };
    if (head === 'export') return { view: viewExport };
    return { view: notFound };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function parseYen(raw) {
    const s = String(raw ?? '').replace(/,/g, '').trim();
    if (!s) return 0;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) throw new FormError('金額は0以上の整数で入力してください');
    return n;
  }

  const numberOf = (raw) => Number(String(raw ?? '').replace(/,/g, '')) || 0;

  function fieldText(form, name) {
    return (form.elements[name]?.value ?? '').trim();
  }

  function fieldInt(form, name) {
    return parseYen(form.elements[name]?.value);
  }

  function fieldDate(form, name) {
    const raw = fieldText(form, name) || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new FormError('日付の形式が正しくありません');
    return raw;
  }

  function fieldChoice(form, name, choices) {
    const value = form.elements[name]?.value ?? '';
    if (!choices.includes(value)) throw new FormError('選択値が正しくありません');
    return value;
  }

  function photoGrid(photos, urls, editable) {
    const figures = photos
      .filter((p) => urls.has(p.id))
      .map((p) => `
        <figure>
          <a href="${urls.get(p.id)}" target="_blank" rel="noopener"><img src="${urls.get(p.id)}" alt=""></a>
          ${editable ? `<button class="btn danger small" type="button" data-action="delete-photo" data-id="${p.id}" data-confirm="この写真を削除しますか？">削除</button>` : ''}
        </figure>`)
      .join('');
    return `
      <h2>写真</h2>
      <div class="card"><div class="photos">${figures || '<p class="muted">写真はまだありません</p>'}</div></div>`;
  }

  function channelOptions(st, selected) {
    const list = masterList(st, 'channel');
    const names = list.map((m) => m.name);
    const rows = list.map((m) => `<option value="${esc(m.name)}" data-rate="${m.fee_rate}"${m.name === selected ? ' selected' : ''}>${esc(m.name)}（${m.fee_rate}%）</option>`);
    if (selected && !names.includes(selected)) rows.push(`<option value="${esc(selected)}" selected>${esc(selected)}</option>`);
    return rows.join('');
  }

  function channelRate(st, name) {
    return masterList(st, 'channel').find((m) => m.name === name)?.fee_rate ?? 0;
  }

  function notFound() {
    return {
      title: '見つかりません',
      html: '<h1>見つかりません</h1><p><a href="#/">ホームへ戻る</a></p>',
    };
  }

  /* ---------- Views ---------- */

  function viewHome({ st, d }) {
    const now = new Date();
    const thisMonth = today().slice(0, 7);
    const month = ledger(st, (date) => date.startsWith(thisMonth));
    const soldThisMonth = d.setRows.filter((s) => s.sold && s.sale.sold_on.startsWith(thisMonth));
    const monthProfit = sum(soldThisMonth.map((s) => s.profit));
    const perSet = soldThisMonth.length ? Math.round(monthProfit / soldThisMonth.length) : 0;
    const soldSets = d.setRows
      .filter((s) => s.sold)
      .sort((a, b) => b.sale.sold_on.localeCompare(a.sale.sold_on) || b.sale.seq - a.sale.seq)
      .slice(0, 5);
    const createdSets = d.setRows.slice(0, 5);
    const recentItems = d.itemRows.slice(0, 5);
    return {
      title: 'ホーム',
      html: `
        <h1>${now.getFullYear()}年${now.getMonth() + 1}月のまとめ</h1>
        <div class="kpis">
          ${kpi('今月の売上', yen(month.income))}
          ${kpi('今月の支出', yen(month.purchase + month.expense + month.sales_cost))}
          ${kpi('今月の収支', yen(month.profit), signClass(month.profit))}
          ${kpi('今月の利益の総額', yen(monthProfit), signClass(monthProfit))}
          ${kpi(`1つ当たりの平均利益（${soldThisMonth.length}件）`, yen(perSet), signClass(perSet))}
          ${kpi('在庫のセット', `${d.unsoldSets.length}件`)}
          ${kpi('在庫の原価', yen(d.stockCost))}
        </div>
        <div class="actions">
          <a class="btn" href="#/items/new">+ 仕入れを登録</a>
          <a class="btn sub" href="#/sets/new">+ 販売セットを作る</a>
          <a class="btn sub" href="#/expenses/new">+ 経費を入力</a>
        </div>
        <h2>最近の販売済みセット</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>販売日</th><th>セット</th><th class="num">販売価格</th><th class="nowrap">発送済み</th></tr>
            ${soldSets.map((s) => `
              <tr>
                <td>${esc(s.sale.sold_on)}</td>
                <td><a href="#/sets/${s.id}">${esc(s.name)}</a></td>
                <td class="num">${yen(s.sale.sale_price)}</td>
                <td><input type="checkbox" data-shipped-id="${s.sale.id}" aria-label="発送済み"${s.sale.shipped ? ' checked' : ''}></td>
              </tr>`).join('') || '<tr><td colspan="4" class="muted">販売済みのセットはまだありません</td></tr>'}
          </table>
        </div>
        <h2>最近作成したセット</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>セット名</th><th>状態</th><th class="num">原価</th></tr>
            ${createdSets.map((s) => `
              <tr>
                <td><a href="#/sets/${s.id}">${esc(s.name)}</a></td>
                <td><span class="badge ${badgeClass(s)}">${esc(s.display_status)}</span></td>
                <td class="num">${yen(s.cost)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="muted">販売セットはまだありません</td></tr>'}
          </table>
        </div>
        <h2>最近の仕入れ</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>仕入れ日</th><th>分類</th><th>品番</th><th class="num">原価</th></tr>
            ${recentItems.map((i) => `
              <tr>
                <td>${esc(i.purchased_on)}</td>
                <td>${esc(i.category)}</td>
                <td><a href="#/items/${i.id}">${esc(i.code)}</a></td>
                <td class="num">${yen(i.cost)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="muted">仕入れ品はまだありません</td></tr>'}
          </table>
        </div>`,
    };
  }

  function viewStock({ d }) {
    const sets = d.unsoldSets;
    const planned = sets.filter((s) => s.status === '出品前').length;
    const listed = sets.length - planned;
    const setRows = sets.map((s) => `
      <tr>
        <td><a href="#/sets/${s.id}">${esc(s.name)}</a></td>
        <td><span class="badge ${badgeClass(s)}">${esc(s.status)}</span></td>
        <td>${esc(s.list_channel) || '<span class="muted">-</span>'}</td>
        <td class="num">${yen(s.cost)}</td>
        <td class="num">${s.status === '出品中' ? yen(s.list_price) : '<span class="muted">未設定</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">在庫のセットはありません</td></tr>';
    const loose = d.unassignedItems.map((i) => `
      <tr>
        <td><a href="#/items/${i.id}">${esc(i.code)}</a></td>
        <td>${esc(i.category)}</td>
        <td>${esc(i.supplier)}</td>
        <td>${esc(i.purchased_on)}</td>
        <td class="num">${yen(i.cost)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">未所属の仕入れ品はありません</td></tr>';
    return {
      title: '在庫',
      html: `
        <h1>在庫</h1>
        <div class="kpis">
          ${kpi('出品前のセット', `${planned}件`)}
          ${kpi('出品中のセット', `${listed}件`)}
          ${kpi('在庫の原価', yen(d.stockCost))}
          ${kpi('見込み売上（出品価格の合計）', yen(d.listedValue))}
        </div>
        <h2>販売セット</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>セット名</th><th>状態</th><th>出品先</th><th class="num">原価</th><th class="num">出品価格（見込み）</th></tr>
            ${setRows}
            ${sets.length ? `<tr><th colspan="3">合計</th><th class="num">${yen(sum(sets.map((s) => s.cost)))}</th><th class="num">${yen(d.listedValue)}</th></tr>` : ''}
          </table>
        </div>
        <h2>未所属の仕入れ品</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>品番</th><th>分類</th><th>仕入れ先</th><th>仕入れ日</th><th class="num">原価</th></tr>
            ${loose}
            ${d.unassignedItems.length ? `<tr><th colspan="4">合計</th><th class="num">${yen(sum(d.unassignedItems.map((i) => i.cost)))}</th></tr>` : ''}
          </table>
        </div>`,
    };
  }

  async function viewItems({ st, d, query }) {
    const category = query.get('category') || '';
    const supplier = query.get('supplier') || '';
    const unset = query.get('unset') === '1';
    let rows = d.itemRows;
    if (category) rows = rows.filter((r) => r.category === category);
    if (supplier) rows = rows.filter((r) => r.supplier === supplier);
    if (unset) rows = rows.filter((r) => r.set_id == null);
    const urls = await photoUrls(rows.map((r) => r.thumb));
    const total = sum(rows.map((r) => r.cost));
    const all = !category && !supplier && !unset;
    return {
      title: '仕入れ品',
      html: `
        <div class="actions">
          <h1>仕入れ品</h1>
          <a class="btn" href="#/items/new">+ 仕入れを登録</a>
        </div>
        <div class="tabs">
          ${tabLink('#/items', 'すべて', all)}
          ${namesOf(st, 'category').map((c) => tabLink(`#/items?category=${encodeURIComponent(c)}`, c, category === c)).join('')}
        </div>
        <div class="tabs">
          ${namesOf(st, 'supplier').map((s) => tabLink(`#/items?supplier=${encodeURIComponent(s)}`, s, supplier === s)).join('')}
          ${tabLink('#/items?unset=1', 'セット未所属のみ', unset)}
        </div>
        <p class="muted">${rows.length}件 ／ 原価合計 ${yen(total)}</p>
        <div class="card table-wrap">
          <table>
            <tr><th>写真</th><th>品番</th><th>分類</th><th>仕入れ先</th><th>仕入れ日</th><th class="num">原価</th><th>セット</th><th>受取</th></tr>
            ${rows.map((r) => `
              <tr>
                <td>${urls.has(r.thumb) ? `<img class="thumb" src="${urls.get(r.thumb)}" alt="">` : ''}</td>
                <td><a href="#/items/${r.id}">${esc(r.code)}</a></td>
                <td>${esc(r.category)}</td>
                <td>${esc(r.supplier)}</td>
                <td>${esc(r.purchased_on)}</td>
                <td class="num">${yen(r.cost)}</td>
                <td>${r.set_id != null ? `<a href="#/sets/${r.set_id}">${esc(r.set_name)}</a>` : '<span class="muted">未所属</span>'}</td>
                <td><input type="checkbox" data-received-id="${r.id}" aria-label="受取済み"${r.received ? ' checked' : ''}></td>
              </tr>`).join('') || '<tr><td colspan="8" class="muted">該当する仕入れ品はありません</td></tr>'}
          </table>
        </div>`,
    };
  }

  function purchaseRowHtml(categories) {
    return `
      <tr data-row>
        <td><input name="code" placeholder="例：KJ-001"></td>
        <td><select name="category">${selectOptions(categories, '')}</select></td>
        <td><input class="num-input" type="number" name="price" min="0" inputmode="numeric" value="0"></td>
        <td><input class="num-input" type="number" name="shipping" min="0" inputmode="numeric" value="0" data-role="shipping" data-manual="0"></td>
        <td><input name="memo"></td>
        <td class="nowrap">
          <button class="btn sub small" type="button" data-action="reset-shipping">送料を平均に戻す</button>
          <button class="btn danger small" type="button" data-action="remove-row">行を削除</button>
        </td>
      </tr>`;
  }

  function viewPurchaseForm({ st }) {
    const categories = namesOf(st, 'category');
    const suppliers = namesOf(st, 'supplier');
    return {
      title: '仕入れを登録',
      html: `
        <h1>仕入れを登録</h1>
        <form class="card" data-form="purchase">
          <div class="grid">
            <label>仕入れ日
              <input type="date" name="purchased_on" value="${today()}">
            </label>
            <label>仕入れ先
              <select name="supplier">${selectOptions(suppliers, '')}</select>
            </label>
            <label>送料合計（伝票全体・円）
              <input type="number" name="shipping_total" min="0" inputmode="numeric" value="0">
            </label>
            <label>メモ
              <input name="memo">
            </label>
          </div>
          <h2>仕入れ品</h2>
          <p class="muted">送料は合計を品数で割った平均が入ります。品ごとに変更すると、変更していない品の送料が差額を調整します。</p>
          <div class="table-wrap">
            <table class="rows">
              <thead>
                <tr><th>品番</th><th>分類</th><th class="num">本体価格（円）</th><th class="num">送料（円）</th><th>メモ</th><th></th></tr>
              </thead>
              <tbody data-role="rows-body" data-categories="${esc(JSON.stringify(categories))}">
                ${purchaseRowHtml(categories)}
              </tbody>
            </table>
          </div>
          <div class="actions">
            <button class="btn sub small" type="button" data-action="add-row">+ 行を追加</button>
            <span class="muted" data-role="ship-sum"></span>
          </div>
          <div class="actions">
            <button class="btn" type="submit">仕入れを保存</button>
            <a class="btn sub" href="#/items">一覧へ戻る</a>
          </div>
        </form>`,
    };
  }

  async function viewItemForm({ st, d, id }) {
    const item = d.itemRows.find((r) => r.id === id);
    if (!item) return notFound();
    const photos = d.itemPhotos.get(item.id) || [];
    const urls = await photoUrls(photos.map((p) => p.id));
    const purchase = st.purchases.find((p) => p.id === item.purchase_id);
    const lotCount = purchase ? st.items.filter((i) => i.purchase_id === purchase.id).length : 0;
    const lotNote = purchase
      ? `<p class="muted">同じ伝票：${lotCount}点 ／ 伝票の送料合計 ${yen(purchase.shipping_total)}</p>`
      : '';
    const setNote = item.set_id != null
      ? `<p>販売セット：<a href="#/sets/${item.set_id}">${esc(item.set_name)}</a></p>`
      : '<p class="muted">販売セットには未所属です。</p>';
    return {
      title: '仕入れ品の編集',
      html: `
        <h1>仕入れ品の編集</h1>
        ${lotNote}
        ${setNote}
        <form class="card grid" data-form="item" data-id="${item.id}">
          <label>品番
            <input name="code" required value="${esc(item.code)}" placeholder="例：KJ-001">
          </label>
          <label>分類
            <select name="category">${selectOptions(allowed(namesOf(st, 'category'), item.category), item.category)}</select>
          </label>
          <label>仕入れ先
            <select name="supplier">${selectOptions(allowed(namesOf(st, 'supplier'), item.supplier), item.supplier)}</select>
          </label>
          <label>仕入れ日
            <input type="date" name="purchased_on" value="${esc(item.purchased_on)}">
          </label>
          <label>本体価格（円）
            <input type="number" name="price" min="0" inputmode="numeric" value="${item.price}">
          </label>
          <label>送料（円）
            <input type="number" name="shipping" min="0" inputmode="numeric" value="${item.shipping}">
          </label>
          <label class="wide">メモ
            <textarea name="memo">${esc(item.memo)}</textarea>
          </label>
          <label class="wide">写真を追加（複数選択可・スマホではカメラでの撮影も可）
            <input type="file" name="photos" accept="image/*" multiple>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">保存</button>
            <a class="btn sub" href="#/items">一覧へ戻る</a>
          </div>
        </form>
        ${photoGrid(photos, urls, true)}
        <button class="btn danger" type="button" data-action="delete-item" data-id="${item.id}" data-confirm="この仕入れ品を削除しますか？写真も削除されます。">この仕入れ品を削除</button>`,
    };
  }

  async function viewSets({ d, query }) {
    const status = query.get('status') || '';
    const rows = status ? d.setRows.filter((s) => s.display_status === status) : d.setRows;
    const urls = await photoUrls(rows.map((s) => s.thumb));
    const cards = rows.map((s) => {
      let line = '<div class="muted">出品前</div>';
      if (s.sold) line = `<div>利益 <b class="${signClass(s.profit)}">${yen(s.profit)}</b></div>`;
      else if (s.status === '出品中') line = `<div class="muted">出品価格 ${yen(s.list_price)}</div>`;
      return `
        <a class="card set-card" href="#/sets/${s.id}">
          ${urls.has(s.thumb) ? `<img class="cover" src="${urls.get(s.thumb)}" alt="">` : '<div class="cover">写真なし</div>'}
          <div class="name">${esc(s.name)}</div>
          <span class="badge ${badgeClass(s)}">${esc(s.display_status)}</span>
          <div class="muted">構成 ${s.item_count}点 ／ 原価 ${yen(s.cost)}</div>
          ${line}
        </a>`;
    }).join('');
    return {
      title: '販売セット',
      html: `
        <div class="actions">
          <h1>販売セット</h1>
          <a class="btn" href="#/sets/new">+ 販売セットを作る</a>
        </div>
        <div class="tabs">
          ${tabLink('#/sets', 'すべて', !status)}
          ${SET_STATUSES.map((s) => tabLink(`#/sets?status=${encodeURIComponent(s)}`, s, status === s)).join('')}
        </div>
        <div class="cards">
          ${cards || '<p class="muted">該当する販売セットはありません</p>'}
        </div>`,
    };
  }

  async function viewSetForm({ st, d, id }) {
    const set = id == null ? null : d.setRows.find((s) => s.id === id);
    if (id != null && !set) return notFound();
    if (set && set.sold) {
      return {
        title: '編集できません',
        html: `<h1>販売済みのセットは編集できません</h1><p><a href="#/sets/${set.id}">セットへ戻る</a></p>`,
      };
    }
    const photos = set ? d.setPhotos.get(set.id) || [] : [];
    const available = d.itemRows.filter((i) => i.set_id == null || (set && i.set_id === set.id));
    const urls = await photoUrls([...photos.map((p) => p.id), ...available.map((i) => i.thumb)]);
    const members = new Set(set ? set.members.map((i) => i.id) : []);
    const orderIds = set ? [...set.members].sort(coverFirst(set.cover_item_id)).map((i) => i.id) : [];
    const picks = available.map((i) => `
        <label class="pick">
          <input type="checkbox" name="item_ids" value="${i.id}"${members.has(i.id) ? ' checked' : ''}>
          ${urls.has(i.thumb) ? `<img src="${urls.get(i.thumb)}" alt="">` : '<span class="pick-none">写真なし</span>'}
          <b>${esc(i.code)}</b>
          <span class="muted">${esc(i.category)}・${yen(i.cost)}</span>
        </label>`).join('') || '<p class="muted">選べる仕入れ品がありません。先に仕入れを登録してください。</p>';
    const used = (kind) => set?.supplies.find((x) => x.kind === kind);
    const supplyChecks = [
      `<label class="check"><input type="checkbox" name="supply" value="packaging"${set ? (used('packaging') ? ' checked' : '') : ' checked'}> 梱包材（一律 ${yen(packagingCostOf(st))}）</label>`,
      ...SUPPLY_KINDS.map(({ kind, name }) => {
        const stock = d.supplyStock[kind];
        const canUse = Boolean(used(kind)) || stock.left >= 1;
        const checked = Boolean(used(kind)) || !set;
        const disabled = set && !canUse;
        return `<label class="check"><input type="checkbox" name="supply" value="${kind}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}> ${name}（平均 ${yen(stock.unit)} × 1本・在庫 ${stock.left}本${canUse ? '' : ' ／ 在庫なし'}）</label>`;
      }),
    ].join('');
    const title = set ? '販売セットの編集' : '販売セットの作成';
    return {
      title,
      html: `
        <h1>${title}</h1>
        <form class="card grid" data-form="set"${set ? ` data-id="${set.id}"` : ''}>
          <label class="wide">セット名
            <input name="name" required value="${esc(set?.name ?? '')}" placeholder="例：紺大島・名古屋帯・帯締めセット">
          </label>
          <label class="wide">説明・コーディネートのメモ
            <textarea name="description">${esc(set?.description ?? '')}</textarea>
          </label>
          <div class="wide">
            <h2>構成品</h2>
            <p class="muted">写真をタップして選びます。最初に選んだ品の写真がセットの表示写真になります。</p>
            <div class="picks">${picks}</div>
          </div>
          <input type="hidden" name="item_order" value="${orderIds.join(',')}">
          <div class="wide">
            <h2>備品</h2>
            <div class="card checks">${supplyChecks}</div>
          </div>
          <label class="wide">写真を追加（複数選択可・追加した写真は一番前に表示されます）
            <input type="file" name="photos" accept="image/*" multiple>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">保存</button>
            <a class="btn sub" href="${set ? `#/sets/${set.id}` : '#/sets'}">戻る</a>
          </div>
        </form>
        ${set ? photoGrid([...photos].reverse(), urls, true) : ''}`,
    };
  }

  async function viewSetDetail({ st, d, id }) {
    const set = d.setRows.find((s) => s.id === id);
    if (!set) return notFound();
    const photos = set.gallery;
    const urls = await photoUrls(photos.map((p) => p.id));
    const sale = set.sale;
    const listed = set.status === '出品中';
    const salePrice = sale ? sale.sale_price : set.list_price;
    const channel = sale?.channel ?? set.list_channel ?? '';
    const fee = sale ? sale.platform_fee : Math.round((salePrice * channelRate(st, channel)) / 100);

    const suppliesHtml = set.supplies.map((x) => `
      <tr>
        <td>備品</td>
        <td>${esc(x.name)}</td>
        <td colspan="4" class="muted">${x.kind === 'packaging' ? `一律 ${yen(x.unit_cost)}` : `平均単価 ${yen(x.unit_cost)} × ${x.qty}本`}</td>
        <td class="num">${yen(x.unit_cost * x.qty)}</td>
      </tr>`).join('');

    const itemsHtml = set.members.map((i) => `
      <tr>
        <td>${esc(i.category)}</td>
        <td><a href="#/items/${i.id}">${esc(i.code)}</a></td>
        <td>${esc(i.supplier)}</td>
        <td>${esc(i.purchased_on)}</td>
        <td class="num">${yen(i.price)}</td>
        <td class="num">${yen(i.shipping)}</td>
        <td class="num">${yen(itemCost(i))}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">構成品がありません</td></tr>';

    const listingHtml = set.sold
      ? `<div class="card">出品先：${esc(set.list_channel) || '-'} ／ 出品価格：${yen(set.list_price)} ／ 出品日：${esc(set.listed_on) || '-'}</div>`
      : `
        <form class="card grid" data-form="listing" data-id="${set.id}">
          <label>出品先
            <select name="list_channel">${channelOptions(st, set.list_channel)}</select>
          </label>
          <label>出品価格（円）
            <input type="number" name="list_price" min="1" inputmode="numeric" value="${set.list_price || ''}">
          </label>
          <label>出品日
            <input type="date" name="listed_on" value="${esc(set.listed_on || today())}">
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">${listed ? '出品内容を更新' : '出品する'}</button>
            ${listed ? `<button class="btn danger small" type="button" data-action="unlist" data-id="${set.id}" data-confirm="出品を取り消しますか？">出品を取り消す</button>` : ''}
          </div>
        </form>`;

    const saleHtml = listed || set.sold
      ? `
        <form class="card grid" data-form="sale" data-id="${set.id}">
          <label>販売日
            <input type="date" name="sold_on" value="${esc(sale?.sold_on ?? today())}">
          </label>
          <label>販売先
            <select name="channel">${channelOptions(st, channel)}</select>
          </label>
          <label>販売価格（円）
            <input type="number" name="sale_price" data-role="sale-price" min="0" inputmode="numeric" value="${salePrice}">
          </label>
          <label>販売手数料（円）
            <input type="number" name="platform_fee" data-role="fee" data-manual="${sale ? '1' : '0'}" min="0" inputmode="numeric" value="${fee}">
          </label>
          <label>発送料・実費（円）
            <input type="number" name="shipping_cost" min="0" inputmode="numeric" value="${sale ? sale.shipping_cost : 0}">
          </label>
          <label class="check wide">
            <input type="checkbox" name="shipped"${sale?.shipped ? ' checked' : ''}> 発送済み
          </label>
          <label class="wide">メモ
            <textarea name="memo">${esc(sale?.memo ?? '')}</textarea>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">${set.sold ? '販売内容を更新' : '売却済みにする'}</button>
            ${set.sold ? `<button class="btn danger small" type="button" data-action="cancel-sale" data-id="${sale.id}" data-confirm="販売記録を取り消しますか？セットは出品中に戻ります。">販売記録を取り消す</button>` : ''}
          </div>
        </form>`
      : '<p class="muted">出品すると販売記録を入力できます。</p>';

    const profitHtml = set.sold ? `
      <table>
        <tr><td>販売価格</td><td class="num">${yen(set.revenue)}</td></tr>
        <tr><td>原価（本体＋送料＋備品）</td><td class="num">${Number(set.cost) ? '-' : ''}${yen(set.cost)}</td></tr>
        <tr><td>販売手数料・発送料</td><td class="num">${Number(set.fees) ? '-' : ''}${yen(set.fees)}</td></tr>
        <tr><th>利益</th><th class="num ${signClass(set.profit)}">${yen(set.profit)}</th></tr>
        <tr><td>利益率</td><td class="num">${pct(rateOf(set.profit, set.revenue))}</td></tr>
      </table>` : '<p class="muted">販売記録を入力すると利益が表示されます。</p>';

    let deleteHtml = '';
    if (set.sold) deleteHtml = '<p class="muted">販売済みのセットは削除できません。</p>';
    else if (listed) deleteHtml = '<p class="muted">出品中のセットは、出品を取り消すと削除できます。</p>';
    else deleteHtml = `<button class="btn danger" type="button" data-action="delete-set" data-id="${set.id}" data-confirm="このセットを削除しますか？構成品は未所属に戻ります。">このセットを削除</button>`;

    return {
      title: set.name,
      html: `
        <div class="actions">
          <h1>${esc(set.name)}</h1>
          <span class="badge ${badgeClass(set)}">${esc(set.display_status)}</span>
          ${set.sold ? '' : `<a class="btn sub small" href="#/sets/${set.id}/edit">構成品・名前を編集</a>`}
        </div>
        ${set.description ? `<div class="card pre">${esc(set.description)}</div>` : ''}
        ${photoGrid(photos, urls, false)}
        <h2>構成品</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>分類</th><th>品番</th><th>仕入れ先</th><th>仕入れ日</th><th class="num">本体</th><th class="num">送料</th><th class="num">原価</th></tr>
            ${itemsHtml}${suppliesHtml}
            <tr><th colspan="6">原価合計</th><th class="num">${yen(set.cost)}</th></tr>
          </table>
        </div>
        <h2>出品</h2>
        ${listingHtml}
        <h2>販売記録</h2>
        ${saleHtml}
        <h2>利益</h2>
        <div class="card table-wrap">${profitHtml}</div>
        ${deleteHtml}`,
    };
  }

  function viewSupplies({ st, d }) {
    const stockRows = SUPPLY_KINDS.map(({ kind }) => {
      const s = d.supplyStock[kind];
      return `
        <tr>
          <td>${esc(s.name)}</td>
          <td class="num">${s.count}本</td>
          <td class="num">${s.count - s.left}本</td>
          <td class="num">${s.left}本</td>
          <td class="num">${yen(s.unit)}</td>
          <td class="num">${yen(s.value)}</td>
        </tr>`;
    }).join('');
    const history = [...st.supply_purchases].sort(newestFirst('purchased_on')).map((p) => {
      const kindName = SUPPLY_KINDS.find((k) => k.kind === p.kind)?.name ?? p.kind;
      return `
        <tr>
          <td>${esc(p.purchased_on)}</td>
          <td>${esc(kindName)}</td>
          <td class="num">${p.count}本</td>
          <td class="num">${yen(p.total)}</td>
          <td class="num">${yen(Math.round(p.total / p.count))}</td>
          <td>${esc(p.memo)}</td>
          <td><button class="btn danger small" type="button" data-action="delete-supply" data-id="${p.id}" data-confirm="この購入記録を削除しますか？">削除</button></td>
        </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">購入記録はまだありません</td></tr>';
    return {
      title: '備品',
      html: `
        <h1>備品</h1>
        <p class="muted">帯締め・帯揚げは数と総額で登録し、平均単価でセットの原価に入れます。梱包材は設定の単価を、セットごとに原価に入れます。</p>
        <div class="card table-wrap">
          <table>
            <tr><th>備品</th><th class="num">購入数</th><th class="num">使用数</th><th class="num">在庫数</th><th class="num">平均単価</th><th class="num">在庫の金額</th></tr>
            ${stockRows}
          </table>
        </div>
        <h2>購入を登録</h2>
        <form class="card grid" data-form="supply">
          <label>備品
            <select name="kind">${SUPPLY_KINDS.map((k) => opt(k.kind, k.name, false)).join('')}</select>
          </label>
          <label>購入日
            <input type="date" name="purchased_on" value="${today()}">
          </label>
          <label>数
            <input type="number" name="count" required min="1" inputmode="numeric">
          </label>
          <label>総額（円）
            <input type="number" name="total" required min="0" inputmode="numeric">
          </label>
          <label class="wide">メモ
            <textarea name="memo"></textarea>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">登録する</button>
          </div>
        </form>
        <h2>購入の履歴</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>購入日</th><th>備品</th><th class="num">数</th><th class="num">総額</th><th class="num">平均単価</th><th>メモ</th><th></th></tr>
            ${history}
          </table>
        </div>`,
    };
  }

  function viewExpenses({ st, query }) {
    const year = Number(query.get('year')) || new Date().getFullYear();
    const rows = st.expenses
      .filter((e) => e.spent_on.startsWith(`${year}-`))
      .sort(newestFirst('spent_on'));
    const total = sum(rows.map((e) => e.amount));
    return {
      title: '経費',
      html: `
        <div class="actions">
          <h1>経費</h1>
          <a class="btn" href="#/expenses/new">+ 経費を登録</a>
        </div>
        <div class="actions">
          <select data-nav="#/expenses?year=">
            ${yearsList(st).map((y) => opt(String(y), `${y}年`, y === year)).join('')}
          </select>
          <span class="muted">${year}年の経費合計：${yen(total)}</span>
        </div>
        <div class="card table-wrap">
          <table>
            <tr><th>日付</th><th>分類</th><th class="num">金額</th><th>メモ</th><th></th></tr>
            ${rows.map((e) => `
              <tr>
                <td>${esc(e.spent_on)}</td>
                <td>${esc(e.category)}</td>
                <td class="num">${yen(e.amount)}</td>
                <td>${esc(e.memo)}</td>
                <td class="nowrap">
                  <a class="btn sub small" href="#/expenses/${e.id}">編集</a>
                  <button class="btn danger small" type="button" data-action="delete-expense" data-id="${e.id}" data-confirm="この経費を削除しますか？">削除</button>
                </td>
              </tr>`).join('') || '<tr><td colspan="5" class="muted">この年の経費はまだありません</td></tr>'}
          </table>
        </div>`,
    };
  }

  function viewExpenseForm({ st, id }) {
    const e = id == null ? null : st.expenses.find((x) => x.id === id);
    if (id != null && !e) return notFound();
    const title = e ? '経費の編集' : '経費の登録';
    return {
      title,
      html: `
        <h1>${title}</h1>
        <form class="card grid" data-form="expense"${e ? ` data-id="${e.id}"` : ''}>
          <label>日付
            <input type="date" name="spent_on" value="${e ? esc(e.spent_on) : today()}">
          </label>
          <label>分類
            <select name="category">${selectOptions(EXPENSE_CATEGORIES, e?.category)}</select>
          </label>
          <label>金額（円）
            <input type="number" name="amount" min="0" inputmode="numeric" value="${e ? e.amount : 0}">
          </label>
          <label class="wide">メモ
            <textarea name="memo">${esc(e?.memo ?? '')}</textarea>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">保存</button>
            <a class="btn sub" href="#/expenses">一覧へ戻る</a>
          </div>
        </form>`,
    };
  }

  const PIE_COLORS = { '利益': '#2e7d4f', '仕入れ': '#8c2f39', '経費': '#c9a227', '手数料・発送料': '#7a6e66' };

  // Monthly profit as bars around a zero line. rows are newest first.
  function profitBars(rows) {
    const list = [...rows].reverse();
    if (!list.length) return '<p class="muted">データがありません</p>';
    const W = 640;
    const H = 240;
    const pad = 24;
    const top = 14;
    const bottom = 34;
    const max = Math.max(1, ...list.map((m) => Math.abs(m.profit)));
    const half = (H - top - bottom) / 2;
    const y0 = top + half;
    const slot = (W - pad * 2) / list.length;
    const barW = Math.max(4, Math.min(36, slot * 0.6));
    const bars = list.map((m, k) => {
      const x = pad + slot * k + (slot - barW) / 2;
      const h = (Math.abs(m.profit) / max) * half;
      const y = m.profit >= 0 ? y0 - h : y0;
      return `
        <rect class="bar ${m.profit >= 0 ? 'plus' : 'minus'}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${esc(m.ym)} 収支 ${yen(m.profit)}</title></rect>
        <text class="axis" x="${(x + barW / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle">${esc(m.ym.slice(2).replace('-', '/'))}</text>`;
    }).join('');
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="月別の収支">
          <line class="axis" x1="${pad}" x2="${W - pad}" y1="${y0}" y2="${y0}"></line>
          ${bars}
        </svg>
      </div>`;
  }

  // Breakdown of sales: profit, purchases, expenses, fees and shipping. Negative profit is shown as 0.
  function incomePie(period) {
    const parts = [
      ['利益', Math.max(0, period.profit)],
      ['仕入れ', period.purchase],
      ['経費', period.expense],
      ['手数料・発送料', period.sales_cost],
    ].filter(([, v]) => v > 0);
    const total = sum(parts.map(([, v]) => v));
    if (!total) return '<p class="muted">この期間の売上・支出データがありません</p>';
    const cx = 100;
    const cy = 100;
    const r = 90;
    let angle = -Math.PI / 2;
    const slices = parts.map(([label, v]) => {
      const frac = v / total;
      const color = PIE_COLORS[label];
      if (frac >= 1) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"><title>${label} ${yen(v)}</title></circle>`;
      const next = angle + frac * 2 * Math.PI;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(next);
      const y2 = cy + r * Math.sin(next);
      const large = frac > 0.5 ? 1 : 0;
      angle = next;
      return `<path d="M${cx} ${cy} L${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${color}"><title>${label} ${yen(v)}</title></path>`;
    }).join('');
    const legend = parts.map(([label, v]) => `
        <li><span class="swatch" style="background:${PIE_COLORS[label]}"></span>${label}　${yen(v)}（${pct(v / total)}）</li>`).join('');
    return `
      <div class="pie">
        <svg class="pie-svg" viewBox="0 0 200 200" role="img" aria-label="売上の内訳">${slices}</svg>
        <ul class="legend">${legend}</ul>
      </div>
      ${period.profit < 0 ? '<p class="muted">赤字の期間は利益を0円として表示しています。</p>' : ''}`;
  }

  function viewReport({ st, query }) {
    const currentYear = new Date().getFullYear();
    const yearRaw = query.get('year') ?? String(currentYear);
    const year = yearRaw === 'all' ? null : Number(yearRaw) || currentYear;
    const monthRaw = query.get('month') ?? String(new Date().getMonth() + 1);
    const month = year === null ? 0 : Math.min(12, Math.max(0, Number(monthRaw) || 0));
    let prefix = '';
    if (year !== null) prefix = month ? `${year}-${pad2(month)}` : `${year}-`;
    const period = ledger(st, (date) => date.startsWith(prefix));
    let label = '全期間';
    if (year !== null) label = month ? `${year}年${month}月` : `${year}年（年間）`;
    const rows = monthlyRows(st, year);
    const total = totals(rows);
    const yearSelect = `<select data-nav="#/report?year=">${yearsList(st).map((y) => opt(String(y), `${y}年`, y === year)).join('')}${opt('all', '全期間', year === null)}</select>`;
    const monthSelect = year === null
      ? ''
      : `<select data-nav="#/report?year=${year}&amp;month=">${opt('0', '年間', month === 0)}${Array.from({ length: 12 }, (_, k) => opt(String(k + 1), `${k + 1}月`, month === k + 1)).join('')}</select>`;
    return {
      title: '収支表',
      html: `
        <div class="actions">
          <h1>収支表</h1>
          ${yearSelect}
          ${monthSelect}
          <button class="btn sub small" type="button" data-action="csv" data-kind="monthly">CSVで書き出し</button>
        </div>
        <h2>${label}</h2>
        <div class="kpis">
          ${kpi('売上', yen(period.income))}
          ${kpi('利益', yen(period.profit), signClass(period.profit))}
          ${kpi('利益率', pct(period.rate), period.rate == null ? '' : signClass(period.rate))}
          ${kpi('販売件数', `${period.count}件`)}
          ${kpi('仕入れ', yen(period.purchase))}
          ${kpi('経費', yen(period.expense))}
          ${kpi('手数料・発送料', yen(period.sales_cost))}
        </div>
        <h2>月別の内訳</h2>
        <p class="muted">売上は販売日、仕入れは仕入れ日、経費は支出日で集計しています。利益率は利益÷売上です。</p>
        <div class="card table-wrap">
          <table>
            <tr>
              <th>年月</th><th class="num">売上</th><th class="num">手数料・発送料</th>
              <th class="num">仕入れ</th><th class="num">経費</th><th class="num">収支</th><th class="num">利益率</th>
            </tr>
            ${rows.map((m) => `
              <tr>
                <td>${esc(m.ym)}</td>
                <td class="num">${yen(m.income)}</td>
                <td class="num">${yen(m.sales_cost)}</td>
                <td class="num">${yen(m.purchase)}</td>
                <td class="num">${yen(m.expense)}</td>
                <td class="num ${signClass(m.profit)}">${yen(m.profit)}</td>
                <td class="num">${pct(m.rate)}</td>
              </tr>`).join('') || '<tr><td colspan="7" class="muted">データがありません</td></tr>'}
            ${rows.length ? `
              <tr>
                <th>合計</th>
                <th class="num">${yen(total.income)}</th>
                <th class="num">${yen(total.sales_cost)}</th>
                <th class="num">${yen(total.purchase)}</th>
                <th class="num">${yen(total.expense)}</th>
                <th class="num ${signClass(total.profit)}">${yen(total.profit)}</th>
                <th class="num">${pct(total.rate)}</th>
              </tr>` : ''}
          </table>
        </div>
        <h2>ダッシュボード</h2>
        <div class="dash">
          <div class="card">
            <h3>月別の利益推移</h3>
            ${profitBars(rows)}
          </div>
          <div class="card">
            <h3>${label}の売上の内訳</h3>
            ${incomePie(period)}
          </div>
        </div>`,
    };
  }

  function masterSection(st, kind, title) {
    const isChannel = kind === 'channel';
    const feeField = (value) => `<span class="fee"><input type="number" name="fee_rate" min="0" max="100" inputmode="numeric" value="${value}" aria-label="手数料（%）">%</span>`;
    const rows = masterList(st, kind).map((m) => `
      <form class="master-row" data-form="master" data-id="${m.id}">
        <input name="name" value="${esc(m.name)}" aria-label="${esc(title)}">
        ${isChannel ? feeField(m.fee_rate) : ''}
        <button class="btn small" type="submit">保存</button>
        <button class="btn danger small" type="button" data-action="delete-master" data-id="${m.id}" data-confirm="「${esc(m.name)}」を一覧から削除しますか？既存の記録の名前は残ります。">削除</button>
      </form>`).join('');
    return `
      <h2>${title}</h2>
      <div class="card">
        ${rows || '<p class="muted">まだ登録がありません</p>'}
        <form class="master-row" data-form="master-new" data-kind="${kind}">
          <input name="name" placeholder="新しく追加する名前">
          ${isChannel ? feeField(0) : ''}
          <button class="btn sub small" type="submit">追加</button>
        </form>
      </div>`;
  }

  function packagingSection(st) {
    return `
      <h2>備品</h2>
      <div class="card">
        <form class="grid" data-form="packaging">
          <label>梱包材の単価（円・1セットごと）
            <input type="number" name="packaging_cost" min="0" inputmode="numeric" value="${packagingCostOf(st)}">
          </label>
          <div class="wide actions">
            <button class="btn small" type="submit">保存</button>
          </div>
        </form>
        <p class="muted">新しく作るセットの原価に入ります。作済みのセットの原価は変わりません。</p>
      </div>`;
  }

  function viewSettings({ st }) {
    return {
      title: '設定',
      html: `
        <h1>設定</h1>
        <p class="muted">分類・仕入れ先・販売先の選択肢を変更します。名前を変えても既存の記録の名前は変わりません。販売先の手数料は販売記録の入力時に自動で入ります。</p>
        ${masterSection(st, 'category', '分類')}
        ${masterSection(st, 'supplier', '仕入れ先')}
        ${masterSection(st, 'channel', '販売先（手数料）')}
        ${packagingSection(st)}
        ${syncSection()}`,
    };
  }

  function viewExport() {
    const links = [
      ['items', '仕入れ品一覧（items.csv）'],
      ['sets', '販売セット・利益（sets.csv）'],
      ['sales', '売上記録（sales.csv）'],
      ['expenses', '経費（expenses.csv）'],
      ['monthly', '月別収支（monthly.csv）'],
    ];
    return {
      title: '書き出し',
      html: `
        <h1>データの書き出し</h1>
        <p class="muted">CSVはExcelで開けます（文字コードはUTF-8・BOM付き）。</p>
        <div class="card">
          <ul>
            ${links.map(([kind, label]) => `<li><a href="#/export" data-action="csv" data-kind="${kind}">${label}</a></li>`).join('')}
          </ul>
        </div>
        <h2>バックアップ</h2>
        <div class="card">
          <p>すべてのデータと写真をまとめたJSONファイルです。定期的に保存しておくと安心です。別の端末へ移すときにも使えます。</p>
          <button class="btn" type="button" data-action="backup">バックアップを保存</button>
        </div>
        <h2>復元</h2>
        <div class="card">
          <p class="muted">復元すると、現在のデータはすべて置き換えられます。v2・v3（備品を含む）で作成したバックアップを復元できます。</p>
          <form class="grid" data-form="restore">
            <label class="wide">バックアップファイル（.json）
              <input type="file" name="file" accept=".json,application/json">
            </label>
            <div class="wide actions">
              <button class="btn danger" type="submit">このファイルで復元</button>
            </div>
          </form>
        </div>`,
    };
  }

  /* ---------- Purchase row allocation ---------- */

  // Splits the purchase-level shipping total across rows. Rows edited by hand keep their value.
  function allocateShipping(form) {
    const total = numberOf(form.elements.shipping_total?.value);
    const inputs = [...form.querySelectorAll('[data-role="shipping"]')];
    const manual = inputs.filter((el) => el.dataset.manual === '1');
    const auto = inputs.filter((el) => el.dataset.manual !== '1');
    const left = Math.max(0, total - sum(manual.map((el) => numberOf(el.value))));
    const base = auto.length ? Math.floor(left / auto.length) : 0;
    const extra = auto.length ? left - base * auto.length : 0;
    auto.forEach((el, index) => { el.value = base + (index < extra ? 1 : 0); });
    const shown = sum(inputs.map((el) => numberOf(el.value)));
    const label = form.querySelector('[data-role="ship-sum"]');
    if (label) label.textContent = `送料の内訳合計 ${yen(shown)}（送料合計 ${yen(total)}）`;
  }

  function updateSaleFee(form) {
    const fee = form.elements.platform_fee;
    if (!fee || fee.dataset.manual === '1') return;
    const rate = Number(form.elements.channel.selectedOptions[0]?.dataset.rate) || 0;
    fee.value = Math.round((numberOf(form.elements.sale_price.value) * rate) / 100);
  }

  /* ---------- Save / delete ---------- */

  async function savePurchase(form) {
    const st = await loadState();
    const purchasedOn = fieldDate(form, 'purchased_on');
    const supplier = fieldChoice(form, 'supplier', namesOf(st, 'supplier'));
    const shippingTotal = fieldInt(form, 'shipping_total');
    const memo = fieldText(form, 'memo');
    const rows = Array.from(form.querySelectorAll('[data-row]'), (row) => ({
      code: row.querySelector('[name="code"]').value.trim(),
      category: row.querySelector('[name="category"]').value,
      price: parseYen(row.querySelector('[name="price"]').value),
      shipping: parseYen(row.querySelector('[name="shipping"]').value),
      memo: row.querySelector('[name="memo"]').value.trim(),
    })).filter((r) => r.code || r.price || r.shipping || r.memo);
    if (!rows.length) throw new FormError('仕入れ品を1点以上入力してください');
    if (rows.some((r) => !r.code)) throw new FormError('品番を入力してください');
    if (sum(rows.map((r) => r.shipping)) !== shippingTotal) {
      throw new FormError('送料の内訳合計が送料合計と一致しません。送料を確認してください');
    }

    const purchaseId = newId();
    await dbTx(['purchases'], 'readwrite', (s) => {
      s.purchases.add({ id: purchaseId, seq: nextSeq(), purchased_on: purchasedOn, supplier, shipping_total: shippingTotal, memo });
    });
    await dbTx(['items'], 'readwrite', (s) => {
      rows.forEach((r) => {
        s.items.add({
          id: newId(),
          seq: nextSeq(),
          purchase_id: purchaseId,
          code: r.code,
          category: r.category,
          supplier,
          purchased_on: purchasedOn,
          price: r.price,
          shipping: r.shipping,
          memo: r.memo,
          set_id: null,
          received: false,
        });
      });
    });
    notify(`仕入れを登録しました（${rows.length}点）`);
    go('#/items');
  }

  async function saveItem(form) {
    const id = form.dataset.id;
    const st = await loadState();
    const existing = st.items.find((i) => i.id === id);
    if (!existing) throw new FormError('仕入れ品が見つかりません');
    const code = fieldText(form, 'code');
    if (!code) throw new FormError('品番を入力してください');
    const data = {
      ...existing,
      code,
      category: fieldChoice(form, 'category', allowed(namesOf(st, 'category'), existing.category)),
      supplier: fieldChoice(form, 'supplier', allowed(namesOf(st, 'supplier'), existing.supplier)),
      purchased_on: fieldDate(form, 'purchased_on'),
      price: fieldInt(form, 'price'),
      shipping: fieldInt(form, 'shipping'),
      memo: fieldText(form, 'memo'),
    };
    await dbTx(['items'], 'readwrite', (s) => { s.items.put(data); });
    await addPhotos(form.elements.photos.files, { item_id: id, set_id: null });
    notify('保存しました');
    go('#/items');
  }

  async function assignItems(setId, selected) {
    const st = await loadState();
    const changed = st.items
      .filter((i) => (selected.has(i.id) ? i.set_id !== setId : i.set_id === setId))
      .map((i) => ({ ...i, set_id: selected.has(i.id) ? setId : null }));
    if (!changed.length) return;
    await dbTx(['items'], 'readwrite', (s) => {
      changed.forEach((item) => { s.items.put(item); });
    });
  }

  // Click order of 構成品 in the picker. The first item becomes the cover photo.
  function updateItemOrder(form, el) {
    const field = form.elements.item_order;
    const order = field.value ? field.value.split(',') : [];
    const id = el.value;
    const next = el.checked
      ? (order.includes(id) ? order : [...order, id])
      : order.filter((x) => x !== id);
    field.value = next.join(',');
  }

  // Selected 備品 for a set. Unit cost is snapshotted when the 備品 is first added to the set.
  function supplySelection(form, st, d, existing) {
    const picked = new Set(Array.from(form.querySelectorAll('input[name="supply"]:checked'), (el) => el.value));
    const kept = existing?.supplies || [];
    const result = [];
    if (picked.has('packaging')) {
      const old = kept.find((x) => x.kind === 'packaging');
      result.push({ kind: 'packaging', name: '梱包材', qty: 1, unit_cost: old ? old.unit_cost : packagingCostOf(st) });
    }
    SUPPLY_KINDS.forEach(({ kind, name }) => {
      if (!picked.has(kind)) return;
      const old = kept.find((x) => x.kind === kind);
      if (!old && d.supplyStock[kind].left < 1) throw new FormError(`${name}の在庫がありません`);
      result.push({ kind, name, qty: 1, unit_cost: old ? old.unit_cost : d.supplyStock[kind].unit });
    });
    return result;
  }

  async function saveSet(form) {
    const id = form.dataset.id || null;
    const name = fieldText(form, 'name');
    if (!name) throw new FormError('セット名を入力してください');
    const selected = new Set(
      Array.from(form.querySelectorAll('input[name="item_ids"]:checked'), (el) => el.value),
    );
    const st = await loadState();
    const d = derive(st);
    const existing = id == null ? null : st.sets.find((s) => s.id === id);
    if (id != null && !existing) throw new FormError('セットが見つかりません');
    if (existing && st.sales.some((s) => s.set_id === id)) throw new FormError('販売済みのセットは編集できません');
    const order = fieldText(form, 'item_order').split(',').filter((x) => selected.has(x));
    const coverId = [...order, ...selected].find((x) => selected.has(x)) ?? null;
    const setId = existing?.id ?? newId();
    const data = {
      id: setId,
      seq: existing?.seq ?? nextSeq(),
      status: '出品前',
      list_price: 0,
      list_channel: '',
      listed_on: '',
      ...existing,
      name,
      description: fieldText(form, 'description'),
      cover_item_id: coverId,
      supplies: supplySelection(form, st, d, existing),
    };
    await dbTx(['sets'], 'readwrite', (s) => { s.sets.put(data); });
    await assignItems(setId, selected);
    await addPhotos(form.elements.photos.files, { item_id: null, set_id: setId });
    notify(existing ? '保存しました' : '販売セットを作成しました');
    go(`#/sets/${setId}`);
  }

  async function saveListing(form) {
    const setId = form.dataset.id;
    const st = await loadState();
    const set = st.sets.find((s) => s.id === setId);
    if (!set) throw new FormError('セットが見つかりません');
    if (st.sales.some((s) => s.set_id === setId)) throw new FormError('販売記録があるため出品内容は変更できません');
    if (!st.items.some((i) => i.set_id === setId)) throw new FormError('構成品を選んでから出品してください');
    const listPrice = fieldInt(form, 'list_price');
    if (listPrice <= 0) throw new FormError('出品価格を入力してください');
    const data = {
      ...set,
      status: '出品中',
      list_channel: fieldChoice(form, 'list_channel', allowed(namesOf(st, 'channel'), set.list_channel)),
      list_price: listPrice,
      listed_on: fieldDate(form, 'listed_on'),
    };
    await dbTx(['sets'], 'readwrite', (s) => { s.sets.put(data); });
    notify(set.status === '出品中' ? '出品内容を更新しました' : '出品しました');
    render();
  }

  async function unlistSet(id) {
    const st = await loadState();
    const set = st.sets.find((s) => s.id === id);
    if (!set) return render();
    if (st.sales.some((s) => s.set_id === id)) throw new FormError('販売記録があるため出品を取り消せません');
    await dbTx(['sets'], 'readwrite', (s) => { s.sets.put({ ...set, status: '出品前' }); });
    notify('出品を取り消しました');
    return render();
  }

  async function saveSale(form) {
    const setId = form.dataset.id;
    const st = await loadState();
    const set = st.sets.find((s) => s.id === setId);
    if (!set) throw new FormError('セットが見つかりません');
    if (set.status !== '出品中') throw new FormError('出品中のセットだけ販売記録を入力できます');
    const existing = st.sales.find((s) => s.set_id === setId);
    const values = {
      sold_on: fieldDate(form, 'sold_on'),
      channel: fieldChoice(form, 'channel', allowed(namesOf(st, 'channel'), set.list_channel, existing?.channel)),
      sale_price: fieldInt(form, 'sale_price'),
      platform_fee: fieldInt(form, 'platform_fee'),
      shipping_cost: fieldInt(form, 'shipping_cost'),
      shipped: form.elements.shipped?.checked === true,
      memo: fieldText(form, 'memo'),
    };
    const data = { id: existing?.id ?? newId(), seq: existing?.seq ?? nextSeq(), ...values, set_id: setId };
    await dbTx(['sales'], 'readwrite', (s) => { s.sales.put(data); });
    notify(existing ? '売却内容を更新しました' : '売却済みにしました');
    render();
  }

  async function setShipped(saleId, shipped) {
    const st = await loadState();
    const sale = st.sales.find((s) => s.id === saleId);
    if (!sale) return render();
    await dbTx(['sales'], 'readwrite', (s) => { s.sales.put({ ...sale, shipped }); });
    notify(shipped ? '発送済みにしました' : '発送済みを取り消しました');
    render();
  }

  async function setReceived(itemId, received) {
    const st = await loadState();
    const item = st.items.find((i) => i.id === itemId);
    if (!item) return render();
    await dbTx(['items'], 'readwrite', (s) => { s.items.put({ ...item, received }); });
    notify(received ? '受取済みにしました' : '受取済みを取り消しました');
    render();
  }

  async function saveExpense(form) {
    const id = form.dataset.id || null;
    const st = await loadState();
    const existing = id == null ? null : st.expenses.find((e) => e.id === id);
    const data = {
      id: id ?? newId(),
      seq: existing?.seq ?? nextSeq(),
      spent_on: fieldDate(form, 'spent_on'),
      category: fieldChoice(form, 'category', EXPENSE_CATEGORIES),
      amount: fieldInt(form, 'amount'),
      memo: fieldText(form, 'memo'),
    };
    await dbTx(['expenses'], 'readwrite', (s) => { s.expenses.put(data); });
    notify(id ? '保存しました' : '経費を登録しました');
    go('#/expenses');
  }

  async function uniqueMasterName(form, kind, excludeId) {
    const name = fieldText(form, 'name');
    if (!name) throw new FormError('名前を入力してください');
    const st = await loadState();
    if (st.masters.some((m) => m.kind === kind && m.name === name && m.id !== excludeId)) {
      throw new FormError('同じ名前の項目があります');
    }
    return name;
  }

  function feeFrom(form, kind) {
    if (kind !== 'channel') return 0;
    const fee = fieldInt(form, 'fee_rate');
    if (fee > 100) throw new FormError('手数料は0から100の範囲で入力してください');
    return fee;
  }

  async function saveMaster(form) {
    const id = form.dataset.id;
    const st = await loadState();
    const current = st.masters.find((m) => m.id === id);
    if (!current) throw new FormError('項目が見つかりません');
    const data = {
      ...current,
      name: await uniqueMasterName(form, current.kind, id),
      fee_rate: feeFrom(form, current.kind),
    };
    await dbTx(['masters'], 'readwrite', (s) => { s.masters.put(data); });
    notify('保存しました');
    render();
  }

  async function addMaster(form) {
    const kind = form.dataset.kind;
    const data = {
      id: newId(),
      seq: nextSeq(),
      kind,
      name: await uniqueMasterName(form, kind, null),
      fee_rate: feeFrom(form, kind),
    };
    await dbTx(['masters'], 'readwrite', (s) => { s.masters.add(data); });
    notify('追加しました');
    render();
  }

  async function deleteMaster(id) {
    await dbTx(['masters'], 'readwrite', (s) => { s.masters.delete(id); });
    notify('削除しました');
    render();
  }

  async function deleteItem(id) {
    const st = await loadState();
    const item = st.items.find((i) => i.id === id);
    if (item && st.sales.some((s) => s.set_id === item.set_id)) {
      throw new FormError('販売済みセットの構成品は削除できません');
    }
    const photoIds = st.photos.filter((p) => p.item_id === id).map((p) => p.id);
    await dbTx(['items', 'photos', 'photo_files'], 'readwrite', (s) => {
      s.items.delete(id);
      photoIds.forEach((pid) => {
        s.photos.delete(pid);
        s.photo_files.delete(pid);
      });
    });
    notify('仕入れ品を削除しました');
    go('#/items');
  }

  async function deleteSet(id) {
    const st = await loadState();
    const set = st.sets.find((s) => s.id === id);
    if (!set) return render();
    if (st.sales.some((s) => s.set_id === id)) throw new FormError('販売記録があるため削除できません');
    if (set.status === '出品中') throw new FormError('出品中のセットは、出品を取り消してから削除してください');
    const photoIds = st.photos.filter((p) => p.set_id === id).map((p) => p.id);
    const released = st.items.filter((i) => i.set_id === id).map((i) => ({ ...i, set_id: null }));
    await dbTx(['sets', 'items', 'photos', 'photo_files'], 'readwrite', (s) => {
      released.forEach((item) => { s.items.put(item); });
      photoIds.forEach((pid) => {
        s.photos.delete(pid);
        s.photo_files.delete(pid);
      });
      s.sets.delete(id);
    });
    notify('セットを削除しました。構成品は未所属に戻りました');
    go('#/sets');
  }

  async function cancelSale(saleId) {
    await dbTx(['sales'], 'readwrite', (s) => { s.sales.delete(saleId); });
    notify('販売記録を取り消しました。セットは出品中に戻ります');
    return render();
  }

  async function deleteExpense(id) {
    await dbTx(['expenses'], 'readwrite', (s) => { s.expenses.delete(id); });
    notify('経費を削除しました');
    return render();
  }

  /* ---------- 備品 / settings ---------- */

  async function saveSupply(form) {
    const kind = fieldChoice(form, 'kind', SUPPLY_KINDS.map((k) => k.kind));
    const count = fieldInt(form, 'count');
    if (count <= 0) throw new FormError('数は1以上で入力してください');
    const data = {
      id: newId(),
      seq: nextSeq(),
      kind,
      purchased_on: fieldDate(form, 'purchased_on'),
      count,
      total: fieldInt(form, 'total'),
      memo: fieldText(form, 'memo'),
    };
    await dbTx(['supply_purchases'], 'readwrite', (s) => { s.supply_purchases.add(data); });
    notify('備品を登録しました');
    render();
  }

  async function deleteSupply(id) {
    const st = await loadState();
    const purchase = st.supply_purchases.find((p) => p.id === id);
    if (!purchase) return render();
    const rest = { ...st, supply_purchases: st.supply_purchases.filter((p) => p.id !== id) };
    if (derive(rest).supplyStock[purchase.kind].left < 0) {
      throw new FormError('この購入分はセットで使用中のため削除できません');
    }
    await dbTx(['supply_purchases'], 'readwrite', (s) => { s.supply_purchases.delete(id); });
    notify('削除しました');
    render();
  }

  async function savePackaging(form) {
    const data = { key: 'packaging_cost', value: fieldInt(form, 'packaging_cost') };
    await dbTx(['settings'], 'readwrite', (s) => { s.settings.put(data); });
    notify('梱包材の単価を保存しました');
    render();
  }

  /* ---------- CSV / backup ---------- */

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toCsv(headers, rows) {
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers, ...rows].map((r) => r.map(cell).join(','));
    return `\uFEFF${lines.join('\r\n')}\r\n`;
  }

  const CSV_BUILDERS = {
    items: (st, d) => [
      ['ID', '品番', '分類', '仕入れ先', '仕入れ日', '本体価格', '送料', '原価', 'セット', 'メモ'],
      [...d.itemRows].sort(byDateThenSeq('purchased_on')).map((i) => [
        i.id, i.code, i.category, i.supplier, i.purchased_on, i.price, i.shipping, i.cost, i.set_name, i.memo,
      ]),
    ],
    sets: (st, d) => [
      ['ID', 'セット名', '状態', '出品先', '出品価格', '出品日', '構成品', '備品', '原価', '販売日', '販売先', '販売価格', '手数料', '発送料', '利益'],
      d.setRows.map((s) => [
        s.id, s.name, s.display_status, s.list_channel, s.list_price, s.listed_on, s.item_names,
        s.supplies.map((x) => `${x.name}×${x.qty}`).join(' / '), s.cost,
        s.sale?.sold_on, s.sale?.channel, s.sale?.sale_price,
        s.sale?.platform_fee, s.sale?.shipping_cost, s.profit,
      ]),
    ],
    sales: (st, d) => [
      ['ID', '販売日', 'セット名', '販売先', '販売価格', '手数料', '発送料', '発送済み', 'メモ'],
      [...st.sales].sort(byDateThenSeq('sold_on')).map((s) => [
        s.id, s.sold_on, d.setById.get(s.set_id)?.name, s.channel, s.sale_price,
        s.platform_fee, s.shipping_cost, s.shipped ? '済' : '未', s.memo,
      ]),
    ],
    expenses: (st) => [
      ['ID', '日付', '分類', '金額', 'メモ'],
      [...st.expenses].sort(byDateThenSeq('spent_on')).map((e) => [e.id, e.spent_on, e.category, e.amount, e.memo]),
    ],
    monthly: (st) => [
      ['年月', '売上', '手数料・発送料', '仕入れ', '経費', '収支', '利益率'],
      monthlyRows(st, null).reverse().map((m) => [
        m.ym, m.income, m.sales_cost, m.purchase, m.expense, m.profit, pct(m.rate),
      ]),
    ],
  };

  async function exportCsv(kind) {
    const build = CSV_BUILDERS[kind];
    if (!build) return;
    const st = await loadState();
    const [headers, rows] = build(st, derive(st));
    download(new Blob([toCsv(headers, rows)], { type: 'text/csv' }), `${kind}.csv`);
  }

  async function downloadBackup() {
    const raw = await dbTx(STORE_NAMES, 'readonly', (s) => ({
      ...Object.fromEntries(DATA_KEYS.map((k) => [k, s[k].getAll()])),
      fileKeys: s.photo_files.getAllKeys(),
      fileBlobs: s.photo_files.getAll(),
    }));
    const photoFiles = await Promise.all(raw.fileKeys.map(async (id, i) => ({
      id,
      data: await blobToDataUrl(raw.fileBlobs[i]),
    })));
    const data = Object.fromEntries(DATA_KEYS.map((k) => [k, raw[k]]));
    const backup = {
      app: 'kimono_site',
      version: BACKUP_VERSION,
      exported_at: new Date().toISOString(),
      data: { ...data, photo_files: photoFiles },
    };
    download(
      new Blob([JSON.stringify(backup)], { type: 'application/json' }),
      `kimono_backup_${today().replace(/-/g, '')}.json`,
    );
  }

  async function restoreBackup(form) {
    const file = form.elements.file.files[0];
    if (!file) throw new FormError('復元するファイルを選んでください');
    let backup;
    try {
      backup = JSON.parse(await file.text());
    } catch (err) {
      throw new FormError('JSONの形式が正しくありません');
    }
    if (backup?.app !== 'kimono_site') throw new FormError('着物販売管理のバックアップファイルではありません');
    if (![2, BACKUP_VERSION].includes(backup.version)) throw new FormError('このバージョンには対応していないバックアップです');
    const data = backup.data;
    const valid = data && ['masters', 'purchases', 'items', 'sets', 'sales', 'expenses', 'photos', 'photo_files']
      .every((k) => Array.isArray(data[k]));
    if (!valid) throw new FormError('バックアップの内容が正しくありません');
    // v2 backups predate 備品 and settings, and still contain the retired 帯紐 category.
    DATA_KEYS.forEach((k) => { if (!Array.isArray(data[k])) data[k] = []; });
    if (backup.version === 2) {
      data.masters = data.masters.filter((m) => !(m.kind === 'category' && m.name === '帯紐'));
      data.items = data.items.map((i) => (i.category === '帯紐' ? { ...i, category: 'その他' } : i));
    }
    if (!confirm('現在のデータはすべて置き換えられます。よろしいですか？')) return;
    const before = await loadState();
    const rows = rekeyData(data);
    const blobs = await Promise.all(data.photo_files.map(async (f) => ({
      id: f.id,
      blob: await (await fetch(f.data)).blob(),
    })));
    await dbTx(STORE_NAMES, 'readwrite', (s) => {
      STORE_NAMES.forEach((name) => { s[name].clear(); });
      DATA_KEYS.forEach((k) => {
        const key = STORE_OPTIONS[k].keyPath;
        const kept = new Set(rows[k].map((r) => r[key]));
        before[k].filter((r) => !kept.has(r[key])).forEach((r) => { queueChange(s.outbox, k, r[key], true); });
        rows[k].forEach((r) => { s[k].put(r); });
      });
      blobs.forEach((b) => { s.photo_files.put(b.blob, b.id); });
    });
    notify('復元しました');
    go('#/');
  }

  /* ---------- ID migration ---------- */

  // Converts numeric ids to UUIDs. Every reference is rewritten with the same mapping.
  // The old numeric id is kept as seq so the existing order is preserved.
  function rekeyData(data) {
    const keyMaps = Object.fromEntries(ID_STORES.map((name) => [
      name,
      new Map(data[name].filter((r) => typeof r.id === 'number').map((r) => [r.id, newId()])),
    ]));
    const rekeyRecord = (name, r) => {
      const out = { ...r };
      if (typeof r.id === 'number') {
        out.id = keyMaps[name].get(r.id);
        out.seq = r.seq ?? r.id;
      }
      Object.entries(ID_REFS[name] || {}).forEach(([field, target]) => {
        if (typeof r[field] === 'number') out[field] = keyMaps[target].get(r[field]) ?? null;
      });
      return out;
    };
    return {
      ...data,
      ...Object.fromEntries(REKEY_STORES.map((name) => [name, data[name].map((r) => rekeyRecord(name, r))])),
    };
  }

  // Runs at startup. Does nothing unless numeric ids are found in the saved data.
  async function migrateNumericIds() {
    const st = await loadState();
    if (!REKEY_STORES.some((name) => st[name].some((r) => typeof r.id === 'number'))) return;
    if (!confirm('データを新しい形式（UUID）に変換します。変換前のバックアップ（JSON）を保存します。よろしいですか？')) return;
    await downloadBackup();
    const rows = rekeyData(st);
    await dbTx(REKEY_STORES, 'readwrite', (s) => {
      REKEY_STORES.forEach((name) => {
        s[name].clear();
        rows[name].forEach((r) => { s[name].put(r); });
      });
    });
    notify('データを変換しました');
  }

  /* ---------- Sync (Supabase) ---------- */

  // Connection settings are kept per browser. They are not part of the synced data or backups.
  function loadSync() {
    try {
      return JSON.parse(localStorage.getItem(SYNC_KEY)) || {};
    } catch (err) {
      return {};
    }
  }

  function saveSync(patch) {
    localStorage.setItem(SYNC_KEY, JSON.stringify({ ...loadSync(), ...patch }));
  }

  function isSyncConfigured() {
    const cfg = loadSync();
    return Boolean(cfg.url && cfg.key);
  }

  // Plain http is allowed only for localhost, for local testing.
  function isAllowedUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname));
    } catch (err) {
      return false;
    }
  }

  function setSyncState(text, isError = false) {
    syncStatusEl.textContent = text;
    syncStatusEl.classList.toggle('error', isError);
  }

  async function refreshPending() {
    pendingEl.textContent = `未送信 ${await pendingCount()}件`;
  }

  function setSession(data) {
    accessToken = data.access_token;
    accessExpiresAt = Date.now() + data.expires_in * 1000;
    saveSync({ refreshToken: data.refresh_token });
  }

  function forgetSession() {
    accessToken = null;
    accessExpiresAt = 0;
  }

  async function authRequest(grant, body) {
    const cfg = loadSync();
    let res;
    try {
      res = await fetch(`${cfg.url}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: { apikey: cfg.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new SyncError('通信できませんでした。ネットワークを確認してください');
    }
    if (res.ok) return res.json();
    const rejected = [400, 401, 403].includes(res.status);
    if (grant === 'password') {
      throw new SyncError(rejected ? 'メールアドレスかパスワードが正しくありません' : '認証サーバーに接続できませんでした');
    }
    if (rejected) throw new SyncError('ログインの期限が切れました。もう一度ログインしてください', true);
    throw new SyncError('認証サーバーに接続できませんでした');
  }

  async function getAccessToken() {
    if (accessToken && Date.now() < accessExpiresAt - 60000) return accessToken;
    const { refreshToken } = loadSync();
    if (!refreshToken) throw new SyncError('ログインしてください', true);
    try {
      setSession(await authRequest('refresh_token', { refresh_token: refreshToken }));
    } catch (err) {
      if (err.needsLogin) saveSync({ refreshToken: null });
      throw err;
    }
    return accessToken;
  }

  // Calls the records table through PostgREST. A 401 is retried once with a fresh token.
  async function restRequest(path, { method = 'GET', body, prefer, retry = true } = {}) {
    const cfg = loadSync();
    const token = await getAccessToken();
    const headers = { apikey: cfg.key, Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry) {
      forgetSession();
      return restRequest(path, { method, body, prefer, retry: false });
    }
    if (!res.ok) throw new SyncError(`サーバーとの同期に失敗しました（${res.status}）`);
    return method === 'GET' ? res.json() : null;
  }

  async function storageRequest(path, { method = 'GET', body, retry = true, allowNotFound = false } = {}) {
    const cfg = loadSync();
    const token = await getAccessToken();
    const headers = { apikey: cfg.key, Authorization: `Bearer ${token}` };
    let requestBody;
    if (body instanceof Blob) {
      headers['Content-Type'] = body.type || 'application/octet-stream';
      headers['x-upsert'] = 'true';
      requestBody = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`${cfg.url}/storage/v1/${path}`, { method, headers, body: requestBody });
    } catch (err) {
      throw new SyncError('写真サーバーに接続できませんでした');
    }
    if (res.status === 401 && retry) {
      forgetSession();
      return storageRequest(path, { method, body, retry: false, allowNotFound });
    }
    if (allowNotFound && res.status === 404) return null;
    if (!res.ok) throw new SyncError(`写真の同期に失敗しました（${res.status}）`);
    return method === 'GET' ? res.blob() : null;
  }

  async function downloadPhotoFile(id) {
    if (pendingPhotoDownloads.has(id)) return pendingPhotoDownloads.get(id);
    const download = (async () => {
      const blob = await storageRequest(`object/photos/${encodeURIComponent(id)}`, { allowNotFound: true });
      if (blob) await dbTx(['photo_files'], 'readwrite', (s) => s.photo_files.put(blob, id));
      return blob;
    })();
    pendingPhotoDownloads.set(id, download);
    try {
      return await download;
    } finally {
      pendingPhotoDownloads.delete(id);
    }
  }

  function readOutbox() {
    return dbTx([OUTBOX], 'readonly', (s) => ({ entries: s.outbox.getAll() })).then((r) => r.entries);
  }

  // Removes sent entries. An entry changed again during the request is kept.
  function clearSent(sent) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX, 'readwrite');
      const outbox = tx.objectStore(OUTBOX);
      sent.forEach((entry) => {
        outbox.get([entry.store, entry.id]).onsuccess = (e) => {
          const current = e.target.result;
          if (current && current.seq === entry.seq) outbox.delete([entry.store, entry.id]);
        };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  }

  // Queues every synced record so the first push uploads all data on this device.
  function enqueueAll() {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction([...DATA_KEYS, OUTBOX], 'readwrite');
      const outbox = tx.objectStore(OUTBOX);
      DATA_KEYS.forEach((name) => {
        const store = tx.objectStore(name);
        store.getAll().onsuccess = (e) => {
          e.target.result.forEach((row) => queueChange(outbox, name, row[store.keyPath], false));
        };
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  }

  async function enqueuePhotoBackfill() {
    const cfg = loadSync();
    if (cfg.role !== 'owner' || cfg.photoBackfillDone) return;
    const files = await dbTx(['photos', 'photo_files'], 'readonly', (s) => ({
      photos: s.photos.getAll(),
      fileKeys: s.photo_files.getAllKeys(),
    }));
    const localFiles = new Set(files.fileKeys);
    const ids = files.photos.filter((photo) => localFiles.has(photo.id)).map((photo) => photo.id);
    await dbTx([OUTBOX], 'readwrite', (s) => {
      ids.forEach((id) => s.outbox.put({ store: 'photos', id, deleted: false, seq: nextSeq() }));
    });
    saveSync({ photoBackfillDone: true });
  }

  // jsonb reorders keys on the server, so keys are sorted before comparing.
  function sortKeys(value) {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
    }
    return value;
  }

  function sameRecord(local, remote) {
    if (local === undefined) return false;
    const normalized = JSON.parse(JSON.stringify(local));
    return JSON.stringify(sortKeys(normalized)) === JSON.stringify(sortKeys(remote));
  }

  // Writes server rows without queuing them. A record with an unsent local change is left alone.
  function applyRows(rows) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction([...DATA_KEYS, 'photo_files', OUTBOX], 'readwrite');
      const outbox = tx.objectStore(OUTBOX);
      let changed = 0;
      rows.filter((row) => DATA_KEYS.includes(row.store)).forEach((row) => {
        outbox.get([row.store, row.id]).onsuccess = (e) => {
          if (e.target.result) return;
          const store = tx.objectStore(row.store);
          store.get(row.id).onsuccess = (ev) => {
            const local = ev.target.result;
            if (row.deleted) {
              if (local === undefined) return;
              store.delete(row.id);
              if (row.store === 'photos') tx.objectStore('photo_files').delete(row.id);
            } else {
              if (sameRecord(local, row.data)) return;
              store.put(row.data);
            }
            changed += 1;
          };
        };
      });
      tx.oncomplete = () => resolve(changed > 0);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  }

  // A put sends the current value. A value that no longer exists is sent as a tombstone.
  async function outboxRows(batch) {
    const live = batch.filter((e) => !e.deleted);
    const values = live.length
      ? await dbTx([...new Set(live.map((e) => e.store))], 'readonly', (s) => (
        Object.fromEntries(live.map((e, i) => [i, s[e.store].get(e.id)]))
      ))
      : {};
    let n = 0;
    return batch.map((e) => {
      if (e.deleted) return { store: e.store, id: e.id, data: {}, deleted: true };
      const value = values[n];
      n += 1;
      return value
        ? { store: e.store, id: e.id, data: value, deleted: false }
        : { store: e.store, id: e.id, data: {}, deleted: true };
    });
  }

  async function pushPending() {
    const entries = await readOutbox();
    for (let i = 0; i < entries.length; i += SYNC_BATCH) {
      const batch = entries.slice(i, i + SYNC_BATCH);
      for (const entry of batch.filter((e) => e.store === 'photos' && !e.deleted)) {
        const result = await dbTx(['photo_files'], 'readonly', (s) => ({ blob: s.photo_files.get(entry.id) }));
        if (!result.blob) throw new SyncError('同期する写真ファイルがこの端末にありません');
        await storageRequest(`object/photos/${encodeURIComponent(entry.id)}`, { method: 'POST', body: result.blob });
      }
      await restRequest('records?on_conflict=store,id', {
        method: 'POST',
        body: await outboxRows(batch),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
      for (const entry of batch.filter((e) => e.store === 'photos' && e.deleted)) {
        await storageRequest('object/photos', {
          method: 'DELETE',
          body: { prefixes: [entry.id] },
          allowNotFound: true,
        });
      }
      await clearSent(batch);
    }
  }

  // Reads from the last seen updated_at. The last row is read again and skipped by sameRecord.
  async function pullChanges() {
    let cursor = loadSync().cursor;
    for (;;) {
      const since = cursor ? `&updated_at=gte.${encodeURIComponent(cursor)}` : '';
      const rows = await restRequest(`records?select=store,id,data,deleted,updated_at&order=updated_at.asc&limit=${PULL_PAGE}${since}`);
      if (!rows.length) return;
      if (await applyRows(rows)) remoteWaiting = true;
      const last = rows[rows.length - 1].updated_at;
      if (rows.length === PULL_PAGE && last === cursor) throw new SyncError('同じ時刻の変更が多すぎるため、受信できません');
      cursor = last;
      saveSync({ cursor });
      if (rows.length < PULL_PAGE) return;
    }
  }

  // Owner: uploads this device's data when the server is empty.
  // Worker: replaces this device's data with the server data. The seed masters are discarded.
  async function initialSync() {
    const { role } = loadSync();
    const remote = await restRequest('records?select=store&limit=1');
    if (role === 'worker') {
      if (!remote.length) throw new SyncError('サーバーにデータがありません。先にオーナーの端末で同期してください');
      if ((await readOutbox()).length) throw new SyncError('未送信の変更があるため、この端末のデータを置き換えられません');
      await dbTx(STORE_NAMES, 'readwrite', (s) => {
        STORE_NAMES.forEach((name) => { s[name].clear(); });
      });
      saveSync({ cursor: null, initialDone: true });
      return;
    }
    if (remote.length) throw new SyncError('サーバーにデータがあります。作業者として接続するか、サーバーの内容を確認してください');
    await enqueueAll();
    saveSync({ initialDone: true });
  }

  async function runSync() {
    setSyncState('同期中…');
    try {
      if (!loadSync().initialDone) await initialSync();
      await enqueuePhotoBackfill();
      await pushPending();
      await pullChanges();
      setSyncState(`同期済み ${new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (err) {
      console.error(err);
      setSyncState(err instanceof SyncError ? err.message : '通信できませんでした。あとでもう一度お試しください', true);
    }
    if (remoteWaiting && !formIsDirty()) {
      render();
      return;
    }
    refreshPending();
    if (remoteWaiting) setSyncState('他の端末の更新があります（入力中のため未反映）');
  }

  function requestSync() {
    const cfg = loadSync();
    if (!cfg.url || !cfg.key) {
      setSyncState('');
      return;
    }
    if (!cfg.refreshToken) {
      setSyncState('未ログイン（設定画面でログインしてください）', true);
      return;
    }
    if (syncRunning) {
      syncQueued = true;
      return;
    }
    syncRunning = true;
    runSync().finally(() => {
      syncRunning = false;
      if (syncQueued) {
        syncQueued = false;
        requestSync();
      }
    });
  }

  function requestAutoSync() {
    if (!loadSync().refreshToken || !navigator.onLine) return;
    if (Date.now() - lastAutoSyncAt < AUTO_SYNC_COOLDOWN) return;
    lastAutoSyncAt = Date.now();
    requestSync();
  }

  // True when the user has typed into a form, so the screen is not redrawn over the input.
  function formIsDirty() {
    return Array.from(main.querySelectorAll('form input, form textarea, form select')).some((el) => {
      if (el.type === 'file') return el.files.length > 0;
      if (el.type === 'checkbox' || el.type === 'radio') return el.checked !== el.defaultChecked;
      if (el.tagName === 'SELECT') return Array.from(el.options).some((o) => o.selected !== o.defaultSelected);
      return el.value !== el.defaultValue;
    });
  }

  function syncSection() {
    const cfg = loadSync();
    const role = cfg.role === 'worker' ? 'worker' : 'owner';
    const login = cfg.refreshToken
      ? `<p>ログイン中：${esc(cfg.email || '')}</p>
         <div class="actions"><button class="btn sub small" type="button" data-action="sync-logout">ログアウト</button></div>`
      : `<form class="grid" data-form="sync-login">
           <label>メールアドレス
             <input type="email" name="email" autocomplete="username">
           </label>
           <label>パスワード
             <input type="password" name="password" autocomplete="current-password">
           </label>
           <div class="wide actions"><button class="btn small" type="submit">ログイン</button></div>
         </form>`;
    return `
      <h2>同期</h2>
      <div class="card">
        <form class="grid" data-form="sync-config">
          <label class="wide">Project URL
            <input name="url" value="${esc(cfg.url || '')}" placeholder="https://xxxx.supabase.co" autocomplete="off">
          </label>
          <label class="wide">公開キー
            <input name="key" value="${esc(cfg.key || '')}" autocomplete="off">
          </label>
          <label>この端末の役割
            <select name="role">${opt('owner', 'オーナー', role === 'owner')}${opt('worker', '作業者', role === 'worker')}</select>
          </label>
          <div class="wide actions"><button class="btn small" type="submit">接続情報を保存</button></div>
        </form>
        <p class="muted">オーナーは、この端末のデータを最初にすべてサーバーへ送ります。作業者は、初回にこの端末のデータをサーバーの内容で置き換えます。接続情報はこの端末だけに保存され、バックアップには含まれません。</p>
      </div>
      <div class="card">${login}</div>`;
  }

  async function saveSyncConfig(form) {
    const url = fieldText(form, 'url').replace(/\/+$/, '');
    const key = fieldText(form, 'key');
    const role = fieldChoice(form, 'role', ['owner', 'worker']);
    if (!isAllowedUrl(url)) throw new FormError('Project URL は https:// で始まるアドレスを入力してください');
    if (!key) throw new FormError('公開キーを入力してください');
    const old = loadSync();
    if (old.url === url && old.key === key) {
      saveSync({ role });
    } else {
      forgetSession();
      saveSync({ url, key, role, refreshToken: null, email: null, cursor: null, initialDone: false });
    }
    notify('接続情報を保存しました');
    requestSync();
    render();
  }

  async function loginSync(form) {
    const email = fieldText(form, 'email');
    const password = form.elements.password.value;
    if (!isSyncConfigured()) throw new FormError('先に接続情報を保存してください');
    if (!email || !password) throw new FormError('メールアドレスとパスワードを入力してください');
    setSession(await authRequest('password', { email, password }));
    saveSync({ email });
    notify('ログインしました');
    requestSync();
    render();
  }

  function logoutSync() {
    forgetSession();
    saveSync({ refreshToken: null, email: null });
    notify('ログアウトしました');
    requestSync();
    return render();
  }

  /* ---------- Dispatch ---------- */

  const formHandlers = {
    purchase: savePurchase,
    item: saveItem,
    set: saveSet,
    listing: saveListing,
    sale: saveSale,
    expense: saveExpense,
    supply: saveSupply,
    packaging: savePackaging,
    master: saveMaster,
    'master-new': addMaster,
    restore: restoreBackup,
    'sync-config': saveSyncConfig,
    'sync-login': loginSync,
  };

  const rowActions = {
    'add-row': (el) => {
      const form = el.closest('form');
      const body = form.querySelector('[data-role="rows-body"]');
      body.insertAdjacentHTML('beforeend', purchaseRowHtml(JSON.parse(body.dataset.categories)));
      allocateShipping(form);
    },
    'remove-row': (el) => {
      const form = el.closest('form');
      el.closest('tr').remove();
      allocateShipping(form);
    },
    'reset-shipping': (el) => {
      const row = el.closest('tr');
      row.querySelector('[data-role="shipping"]').dataset.manual = '0';
      allocateShipping(el.closest('form'));
    },
  };

  async function runAction(action, data) {
    switch (action) {
      case 'delete-item': return deleteItem(data.id);
      case 'delete-set': return deleteSet(data.id);
      case 'unlist': return unlistSet(data.id);
      case 'cancel-sale': return cancelSale(data.id);
      case 'delete-expense': return deleteExpense(data.id);
      case 'delete-supply': return deleteSupply(data.id);
      case 'delete-master': return deleteMaster(data.id);
      case 'delete-photo':
        await deletePhotos([data.id]);
        return render();
      case 'csv': return exportCsv(data.kind);
      case 'backup': return downloadBackup();
      case 'sync-logout': return logoutSync();
      default: return undefined;
    }
  }

  function reportError(err) {
    if (err instanceof FormError || err instanceof SyncError) {
      alert(err.message);
      return;
    }
    console.error(err);
    alert('処理に失敗しました。もう一度お試しください。');
  }

  async function render() {
    const seq = ++renderSeq;
    revokeUrls();
    try {
      const { parts, query } = parseHash();
      const { view, id = null } = route(parts);
      const [st, pending] = await Promise.all([loadState(), pendingCount()]);
      const page = await view({ st, d: derive(st), id, query });
      if (seq !== renderSeq) return;
      document.title = `${page.title} | 着物販売管理`;
      main.innerHTML = page.html;
      remoteWaiting = false;
      pendingEl.textContent = `未送信 ${pending}件`;
    } catch (err) {
      console.error(err);
      if (seq === renderSeq) {
        main.innerHTML = '<p class="flash">データを読み込めませんでした。ブラウザでこのページのデータ保存が許可されているか確認してください。</p>';
      }
    }
  }

  main.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    e.preventDefault();
    const rowAction = rowActions[el.dataset.action];
    if (rowAction) {
      rowAction(el);
      return;
    }
    if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
    try {
      await runAction(el.dataset.action, el.dataset);
    } catch (err) {
      reportError(err);
    }
  });

  main.addEventListener('input', (e) => {
    const el = e.target;
    const form = el.form;
    if (!form) return;
    if (form.dataset.form === 'purchase' && (el.dataset.role === 'shipping' || el.name === 'shipping_total')) {
      if (el.dataset.role === 'shipping') el.dataset.manual = '1';
      allocateShipping(form);
    }
    if (form.dataset.form === 'sale') {
      if (el.dataset.role === 'fee') el.dataset.manual = '1';
      if (el.dataset.role === 'sale-price') updateSaleFee(form);
    }
  });

  main.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset?.nav) {
      go(el.dataset.nav + encodeURIComponent(el.value));
      return;
    }
    if (el.dataset?.shippedId) {
      setShipped(el.dataset.shippedId, el.checked);
      return;
    }
    if (el.dataset?.receivedId) {
      setReceived(el.dataset.receivedId, el.checked);
      return;
    }
    if (el.name === 'item_ids' && el.form?.dataset.form === 'set') updateItemOrder(el.form, el);
    if (el.form?.dataset.form === 'sale' && el.name === 'channel') updateSaleFee(el.form);
  });

  main.addEventListener('submit', async (e) => {
    const form = e.target;
    const handler = formHandlers[form.dataset.form];
    if (!handler) return;
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    const button = form.querySelector('[type="submit"]');
    if (button) button.disabled = true;
    try {
      await handler(form);
    } catch (err) {
      reportError(err);
    } finally {
      delete form.dataset.busy;
      if (button) button.disabled = false;
    }
  });

  window.addEventListener('hashchange', () => {
    render();
    requestAutoSync();
  });
  window.addEventListener('online', () => {
    lastAutoSyncAt = 0;
    requestAutoSync();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestAutoSync();
  });
  syncButton.addEventListener('click', () => {
    if (!isSyncConfigured()) {
      notify('設定画面で接続情報を入力してください', 'error');
      return;
    }
    requestSync();
  });
  migrateNumericIds()
    .catch((err) => {
      console.error(err);
      alert('データの変換に失敗しました。データは変更されていません。');
    })
    .finally(() => {
      render();
      requestAutoSync();
    });
})();
