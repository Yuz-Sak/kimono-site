(() => {
  'use strict';

  const EXPENSE_CATEGORIES = ['梱包材', '撮影・小物', 'クリーニング・補修', '通信費', '消耗品', 'その他'];
  const SET_STATUSES = ['出品前', '出品中', '販売済み'];
  const DATA_KEYS = ['masters', 'purchases', 'items', 'sets', 'sales', 'expenses', 'photos'];
  const STORE_NAMES = [...DATA_KEYS, 'photo_files'];
  const SEEDS = [
    { kind: 'category', name: 'きもの', fee_rate: 0 },
    { kind: 'category', name: '帯', fee_rate: 0 },
    { kind: 'category', name: '帯紐', fee_rate: 0 },
    { kind: 'category', name: 'その他', fee_rate: 0 },
    { kind: 'supplier', name: 'ヤフオク', fee_rate: 0 },
    { kind: 'supplier', name: '直接', fee_rate: 0 },
    { kind: 'channel', name: 'メルカリ', fee_rate: 10 },
    { kind: 'channel', name: '直接', fee_rate: 0 },
  ];
  const DB_NAME = 'kimono_site';
  const DB_VERSION = 2;
  const BACKUP_VERSION = 2;
  const MAX_PHOTO_SIZE = 1600;

  const main = document.getElementById('app');
  const objectUrls = [];
  let dbPromise = null;
  let renderSeq = 0;
  let toastTimer = null;

  class FormError extends Error {}

  /* ---------- IndexedDB ---------- */

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          Array.from(db.objectStoreNames).forEach((name) => db.deleteObjectStore(name));
          db.createObjectStore('masters', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('purchases', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('sales', { keyPath: 'id', autoIncrement: true })
            .createIndex('set_id', 'set_id', { unique: true });
          db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('photos', { keyPath: 'id' });
          db.createObjectStore('photo_files');
          const masters = req.transaction.objectStore('masters');
          SEEDS.forEach((seed) => masters.add(seed));
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function dbTx(names, mode, build) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode);
      const stores = {};
      names.forEach((name) => { stores[name] = tx.objectStore(name); });
      const requests = (build && build(stores)) || {};
      tx.oncomplete = () => resolve(Object.fromEntries(
        Object.entries(requests).map(([key, req]) => [key, req.result]),
      ));
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
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
    return b.id - a.id;
  };
  const byDateThenId = (key) => (a, b) => {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    return a.id - b.id;
  };
  const masterList = (st, kind) => st.masters
    .filter((m) => m.kind === kind)
    .sort((a, b) => a.id - b.id);
  const namesOf = (st, kind) => masterList(st, kind).map((m) => m.name);
  const allowed = (names, ...extra) => [...names, ...extra.filter((v) => v && !names.includes(v))];

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

    const setRows = st.sets.map((s) => {
      const sale = saleBySet.get(s.id) || null;
      const members = membersBySet.get(s.id) || [];
      const cost = sum(members.map(itemCost));
      const sold = sale !== null;
      const revenue = sold ? sale.sale_price + sale.shipping_charged : 0;
      const fees = sold ? sale.platform_fee + sale.shipping_cost : 0;
      return {
        ...s,
        sale,
        sold,
        members,
        cost,
        revenue,
        fees,
        profit: sold ? revenue - fees - cost : null,
        item_count: members.length,
        item_names: members.map((i) => i.code).join(' / '),
        display_status: sold ? '販売済み' : s.status,
        thumb: setPhotos.get(s.id)?.[0]?.id ?? null,
      };
    }).sort((a, b) => b.id - a.id);

    const unsoldSets = setRows.filter((s) => !s.sold);
    const unassignedItems = itemRows.filter((i) => i.set_id == null);

    return {
      setById,
      saleBySet,
      setPhotos,
      itemPhotos,
      setRows,
      itemRows,
      unsoldSets,
      unassignedItems,
      stockCost: sum(unsoldSets.map((s) => s.cost)) + sum(unassignedItems.map((i) => i.cost)),
      listedValue: sum(unsoldSets.filter((s) => s.status === '出品中').map((s) => s.list_price)),
    };
  }

  // Cash-basis ledger: sales by 販売日, purchases by 仕入れ日, expenses by 支出日.
  function ledger(st, match) {
    const sales = st.sales.filter((s) => match(s.sold_on));
    const income = sum(sales.map((s) => s.sale_price + s.shipping_charged));
    const sales_cost = sum(sales.map((s) => s.platform_fee + s.shipping_cost));
    const purchase = sum(st.items.filter((i) => match(i.purchased_on)).map(itemCost));
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
      m.income += s.sale_price + s.shipping_charged;
      m.sales_cost += s.platform_fee + s.shipping_cost;
      m.count += 1;
    });
    st.items.filter((i) => inYear(i.purchased_on)).forEach((i) => {
      month(i.purchased_on.slice(0, 7)).purchase += itemCost(i);
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
      return { view: viewItemForm, id: Number(arg) };
    }
    if (head === 'stock') return { view: viewStock };
    if (head === 'sets') {
      if (arg === undefined) return { view: viewSets };
      if (arg === 'new') return { view: viewSetForm, id: null };
      if (sub === 'edit') return { view: viewSetForm, id: Number(arg) };
      return { view: viewSetDetail, id: Number(arg) };
    }
    if (head === 'expenses') {
      if (arg === undefined) return { view: viewExpenses };
      if (arg === 'new') return { view: viewExpenseForm, id: null };
      return { view: viewExpenseForm, id: Number(arg) };
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
    const year = ledger(st, (date) => date.startsWith(`${now.getFullYear()}-`));
    const recentSales = [...st.sales].sort(newestFirst('sold_on')).slice(0, 5);
    const recentItems = d.itemRows.slice(0, 5);
    return {
      title: 'ホーム',
      html: `
        <h1>${now.getFullYear()}年${now.getMonth() + 1}月のまとめ</h1>
        <div class="kpis">
          ${kpi('今月の売上', yen(month.income))}
          ${kpi('今月の支出', yen(month.purchase + month.expense + month.sales_cost))}
          ${kpi('今月の収支', yen(month.profit), signClass(month.profit))}
          ${kpi('今年の収支', yen(year.profit), signClass(year.profit))}
          ${kpi('在庫のセット', `${d.unsoldSets.length}件`)}
          ${kpi('在庫の原価', yen(d.stockCost))}
        </div>
        <div class="actions">
          <a class="btn" href="#/items/new">+ 仕入れを登録</a>
          <a class="btn sub" href="#/sets/new">+ 販売セットを作る</a>
          <a class="btn sub" href="#/expenses/new">+ 経費を入力</a>
        </div>
        <h2>最近の販売</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>販売日</th><th>セット</th><th class="num">販売価格＋送料</th></tr>
            ${recentSales.map((s) => `
              <tr>
                <td>${esc(s.sold_on)}</td>
                <td><a href="#/sets/${s.set_id}">${esc(d.setById.get(s.set_id)?.name)}</a></td>
                <td class="num">${yen(s.sale_price + s.shipping_charged)}</td>
              </tr>`).join('') || '<tr><td colspan="3" class="muted">販売記録はまだありません</td></tr>'}
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
            <tr><th>写真</th><th>品番</th><th>分類</th><th>仕入れ先</th><th>仕入れ日</th><th class="num">原価</th><th>セット</th></tr>
            ${rows.map((r) => `
              <tr>
                <td>${urls.has(r.thumb) ? `<img class="thumb" src="${urls.get(r.thumb)}" alt="">` : ''}</td>
                <td><a href="#/items/${r.id}">${esc(r.code)}</a></td>
                <td>${esc(r.category)}</td>
                <td>${esc(r.supplier)}</td>
                <td>${esc(r.purchased_on)}</td>
                <td class="num">${yen(r.cost)}</td>
                <td>${r.set_id != null ? `<a href="#/sets/${r.set_id}">${esc(r.set_name)}</a>` : '<span class="muted">未所属</span>'}</td>
              </tr>`).join('') || '<tr><td colspan="7" class="muted">該当する仕入れ品はありません</td></tr>'}
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
    const urls = await photoUrls(photos.map((p) => p.id));
    const available = st.items
      .filter((i) => i.set_id == null || (set && i.set_id === set.id))
      .sort(newestFirst('purchased_on'));
    const checks = available.map((i) => `
        <label>
          <input type="checkbox" name="item_ids" value="${i.id}"${set && i.set_id === set.id ? ' checked' : ''}>
          ${esc(i.code)}（${esc(i.category)}・${yen(itemCost(i))}）
        </label>`).join('') || '<p class="muted">選べる仕入れ品がありません。先に仕入れを登録してください。</p>';
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
            <h2>構成品（未所属の仕入れ品から選択）</h2>
            <div class="card checks">${checks}</div>
          </div>
          <label class="wide">写真を追加（複数選択可）
            <input type="file" name="photos" accept="image/*" multiple>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">保存</button>
            <a class="btn sub" href="${set ? `#/sets/${set.id}` : '#/sets'}">戻る</a>
          </div>
        </form>
        ${set ? photoGrid(photos, urls, true) : ''}`,
    };
  }

  async function viewSetDetail({ st, d, id }) {
    const set = d.setRows.find((s) => s.id === id);
    if (!set) return notFound();
    const photos = d.setPhotos.get(set.id) || [];
    const urls = await photoUrls(photos.map((p) => p.id));
    const sale = set.sale;
    const listed = set.status === '出品中';
    const salePrice = sale ? sale.sale_price : set.list_price;
    const channel = sale?.channel ?? set.list_channel ?? '';
    const fee = sale ? sale.platform_fee : Math.round((salePrice * channelRate(st, channel)) / 100);

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
          <label>送料受取（円）
            <input type="number" name="shipping_charged" min="0" inputmode="numeric" value="${sale ? sale.shipping_charged : 0}">
          </label>
          <label>販売手数料（円）
            <input type="number" name="platform_fee" data-role="fee" data-manual="${sale ? '1' : '0'}" min="0" inputmode="numeric" value="${fee}">
          </label>
          <label>発送料・実費（円）
            <input type="number" name="shipping_cost" min="0" inputmode="numeric" value="${sale ? sale.shipping_cost : 0}">
          </label>
          <label class="wide">メモ
            <textarea name="memo">${esc(sale?.memo ?? '')}</textarea>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">${set.sold ? '販売内容を更新' : '販売を記録する'}</button>
            ${set.sold ? `<button class="btn danger small" type="button" data-action="cancel-sale" data-id="${sale.id}" data-confirm="販売記録を取り消しますか？セットは出品中に戻ります。">販売記録を取り消す</button>` : ''}
          </div>
        </form>`
      : '<p class="muted">出品すると販売記録を入力できます。</p>';

    const profitHtml = set.sold ? `
      <table>
        <tr><td>販売価格＋送料受取</td><td class="num">${yen(set.revenue)}</td></tr>
        <tr><td>原価（本体＋送料）</td><td class="num">${Number(set.cost) ? '-' : ''}${yen(set.cost)}</td></tr>
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
            ${itemsHtml}
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

  function viewSettings({ st }) {
    return {
      title: '設定',
      html: `
        <h1>設定</h1>
        <p class="muted">分類・仕入れ先・販売先の選択肢を変更します。名前を変えても既存の記録の名前は変わりません。販売先の手数料は販売記録の入力時に自動で入ります。</p>
        ${masterSection(st, 'category', '分類')}
        ${masterSection(st, 'supplier', '仕入れ先')}
        ${masterSection(st, 'channel', '販売先（手数料）')}`,
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
          <p class="muted">復元すると、現在のデータはすべて置き換えられます。このバージョン（v2）で作成したバックアップのみ復元できます。</p>
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

    const { id: purchaseId } = await dbTx(['purchases'], 'readwrite', (s) => ({
      id: s.purchases.add({ purchased_on: purchasedOn, supplier, shipping_total: shippingTotal, memo }),
    }));
    await dbTx(['items'], 'readwrite', (s) => {
      rows.forEach((r) => {
        s.items.add({
          purchase_id: purchaseId,
          code: r.code,
          category: r.category,
          supplier,
          purchased_on: purchasedOn,
          price: r.price,
          shipping: r.shipping,
          memo: r.memo,
          set_id: null,
        });
      });
    });
    notify(`仕入れを登録しました（${rows.length}点）`);
    go('#/items');
  }

  async function saveItem(form) {
    const id = Number(form.dataset.id);
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

  async function saveSet(form) {
    const id = Number(form.dataset.id) || null;
    const name = fieldText(form, 'name');
    if (!name) throw new FormError('セット名を入力してください');
    const selected = new Set(
      Array.from(form.querySelectorAll('input[name="item_ids"]:checked'), (el) => Number(el.value)),
    );
    const st = await loadState();
    const existing = id == null ? null : st.sets.find((s) => s.id === id);
    if (id != null && !existing) throw new FormError('セットが見つかりません');
    if (existing && st.sales.some((s) => s.set_id === id)) throw new FormError('販売済みのセットは編集できません');
    const data = {
      status: '出品前',
      list_price: 0,
      list_channel: '',
      listed_on: '',
      ...existing,
      name,
      description: fieldText(form, 'description'),
    };
    const { id: setId } = await dbTx(['sets'], 'readwrite', (s) => ({
      id: existing ? s.sets.put(data) : s.sets.add(data),
    }));
    await assignItems(setId, selected);
    await addPhotos(form.elements.photos.files, { item_id: null, set_id: setId });
    notify(existing ? '保存しました' : '販売セットを作成しました');
    go(`#/sets/${setId}`);
  }

  async function saveListing(form) {
    const setId = Number(form.dataset.id);
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
    const setId = Number(form.dataset.id);
    const st = await loadState();
    const set = st.sets.find((s) => s.id === setId);
    if (!set) throw new FormError('セットが見つかりません');
    if (set.status !== '出品中') throw new FormError('出品中のセットだけ販売記録を入力できます');
    const existing = st.sales.find((s) => s.set_id === setId);
    const values = {
      sold_on: fieldDate(form, 'sold_on'),
      channel: fieldChoice(form, 'channel', allowed(namesOf(st, 'channel'), set.list_channel, existing?.channel)),
      sale_price: fieldInt(form, 'sale_price'),
      shipping_charged: fieldInt(form, 'shipping_charged'),
      platform_fee: fieldInt(form, 'platform_fee'),
      shipping_cost: fieldInt(form, 'shipping_cost'),
      memo: fieldText(form, 'memo'),
    };
    await dbTx(['sales'], 'readwrite', (s) => {
      if (existing) s.sales.put({ ...values, id: existing.id, set_id: setId });
      else s.sales.add({ ...values, set_id: setId });
    });
    notify(existing ? '販売内容を更新しました' : '販売を記録しました');
    render();
  }

  async function saveExpense(form) {
    const id = Number(form.dataset.id) || null;
    const data = {
      spent_on: fieldDate(form, 'spent_on'),
      category: fieldChoice(form, 'category', EXPENSE_CATEGORIES),
      amount: fieldInt(form, 'amount'),
      memo: fieldText(form, 'memo'),
    };
    await dbTx(['expenses'], 'readwrite', (s) => (
      id ? { id: s.expenses.put({ ...data, id }) } : { id: s.expenses.add(data) }
    ));
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
    const id = Number(form.dataset.id);
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
      [...d.itemRows].sort(byDateThenId('purchased_on')).map((i) => [
        i.id, i.code, i.category, i.supplier, i.purchased_on, i.price, i.shipping, i.cost, i.set_name, i.memo,
      ]),
    ],
    sets: (st, d) => [
      ['ID', 'セット名', '状態', '出品先', '出品価格', '出品日', '構成品', '原価', '販売日', '販売先', '販売価格', '送料受取', '手数料', '発送料', '利益'],
      d.setRows.map((s) => [
        s.id, s.name, s.display_status, s.list_channel, s.list_price, s.listed_on, s.item_names, s.cost,
        s.sale?.sold_on, s.sale?.channel, s.sale?.sale_price, s.sale?.shipping_charged,
        s.sale?.platform_fee, s.sale?.shipping_cost, s.profit,
      ]),
    ],
    sales: (st, d) => [
      ['ID', '販売日', 'セット名', '販売先', '販売価格', '送料受取', '手数料', '発送料', '売上合計', 'メモ'],
      [...st.sales].sort(byDateThenId('sold_on')).map((s) => [
        s.id, s.sold_on, d.setById.get(s.set_id)?.name, s.channel, s.sale_price, s.shipping_charged,
        s.platform_fee, s.shipping_cost, s.sale_price + s.shipping_charged, s.memo,
      ]),
    ],
    expenses: (st) => [
      ['ID', '日付', '分類', '金額', 'メモ'],
      [...st.expenses].sort(byDateThenId('spent_on')).map((e) => [e.id, e.spent_on, e.category, e.amount, e.memo]),
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
    if (backup.version !== BACKUP_VERSION) throw new FormError('このバージョンには対応していないバックアップです');
    const data = backup.data;
    const valid = data && [...DATA_KEYS, 'photo_files'].every((k) => Array.isArray(data[k]));
    if (!valid) throw new FormError('バックアップの内容が正しくありません');
    if (!confirm('現在のデータはすべて置き換えられます。よろしいですか？')) return;
    const blobs = await Promise.all(data.photo_files.map(async (f) => ({
      id: f.id,
      blob: await (await fetch(f.data)).blob(),
    })));
    await dbTx(STORE_NAMES, 'readwrite', (s) => {
      STORE_NAMES.forEach((name) => { s[name].clear(); });
      DATA_KEYS.forEach((k) => { data[k].forEach((r) => { s[k].put(r); }); });
      blobs.forEach((b) => { s.photo_files.put(b.blob, b.id); });
    });
    notify('復元しました');
    go('#/');
  }

  /* ---------- Dispatch ---------- */

  const formHandlers = {
    purchase: savePurchase,
    item: saveItem,
    set: saveSet,
    listing: saveListing,
    sale: saveSale,
    expense: saveExpense,
    master: saveMaster,
    'master-new': addMaster,
    restore: restoreBackup,
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
      case 'delete-item': return deleteItem(Number(data.id));
      case 'delete-set': return deleteSet(Number(data.id));
      case 'unlist': return unlistSet(Number(data.id));
      case 'cancel-sale': return cancelSale(Number(data.id));
      case 'delete-expense': return deleteExpense(Number(data.id));
      case 'delete-master': return deleteMaster(Number(data.id));
      case 'delete-photo':
        await deletePhotos([data.id]);
        return render();
      case 'csv': return exportCsv(data.kind);
      case 'backup': return downloadBackup();
      default: return undefined;
    }
  }

  function reportError(err) {
    if (err instanceof FormError) {
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
      const st = await loadState();
      const page = await view({ st, d: derive(st), id, query });
      if (seq !== renderSeq) return;
      document.title = `${page.title} | 着物販売管理`;
      main.innerHTML = page.html;
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

  window.addEventListener('hashchange', render);
  render();
})();
