(() => {
  'use strict';

  const CATEGORIES = ['きもの', '帯', '帯紐', 'その他'];
  const SET_STATUSES = ['在庫', '出品中'];
  const EXPENSE_CATEGORIES = ['梱包材', '撮影・小物', 'クリーニング・補修', '通信費', '消耗品', 'その他'];
  const DATA_KEYS = ['sets', 'items', 'sales', 'expenses', 'photos'];
  const STORE_NAMES = [...DATA_KEYS, 'photo_files'];
  const DB_NAME = 'kimono_site';
  const MAX_PHOTO_SIZE = 1600;

  const main = document.getElementById('app');
  const objectUrls = [];
  let dbPromise = null;
  let renderSeq = 0;
  let pendingFlash = '';

  class FormError extends Error {}

  /* ---------- IndexedDB ---------- */

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('sets', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('sales', { keyPath: 'id', autoIncrement: true })
            .createIndex('set_id', 'set_id', { unique: true });
          db.createObjectStore('expenses', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('photos', { keyPath: 'id' });
          db.createObjectStore('photo_files');
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
    return dbTx(DATA_KEYS, 'readonly', (s) => ({
      sets: s.sets.getAll(),
      items: s.items.getAll(),
      sales: s.sales.getAll(),
      expenses: s.expenses.getAll(),
      photos: s.photos.getAll(),
    }));
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

  /* ---------- Derived data (same rules as the former SQL) ---------- */

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

    const setRows = st.sets.map((s) => {
      const sale = saleBySet.get(s.id) || null;
      const members = membersBySet.get(s.id) || [];
      const cost = members.reduce((sum, i) => sum + i.price + i.shipping, 0);
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
        item_names: members.map((i) => i.name).join(' / '),
        display_status: sold ? '販売済み' : s.status,
        thumb: setPhotos.get(s.id)?.[0]?.id ?? null,
      };
    }).sort((a, b) => b.id - a.id);

    const itemRows = st.items.map((i) => ({
      ...i,
      cost: i.price + i.shipping,
      set_name: setById.get(i.set_id)?.name ?? null,
      thumb: itemPhotos.get(i.id)?.[0]?.id ?? null,
    })).sort((a, b) => {
      if (a.purchased_on !== b.purchased_on) return a.purchased_on < b.purchased_on ? 1 : -1;
      return b.id - a.id;
    });

    const stockCost = st.items
      .filter((i) => i.set_id == null || !saleBySet.has(i.set_id))
      .reduce((sum, i) => sum + i.price + i.shipping, 0);

    return {
      setById,
      saleBySet,
      setPhotos,
      itemPhotos,
      setRows,
      itemRows,
      stockCount: setRows.filter((s) => !s.sold).length,
      stockCost,
    };
  }

  function monthlyRows(st, year) {
    const inYear = (date) => year == null || date.startsWith(`${year}-`);
    const months = new Map();
    const month = (ym) => {
      if (!months.has(ym)) months.set(ym, { ym, income: 0, sales_cost: 0, purchase: 0, expense: 0 });
      return months.get(ym);
    };
    st.sales.filter((s) => inYear(s.sold_on)).forEach((s) => {
      const m = month(s.sold_on.slice(0, 7));
      m.income += s.sale_price + s.shipping_charged;
      m.sales_cost += s.platform_fee + s.shipping_cost;
    });
    st.items.filter((i) => inYear(i.purchased_on)).forEach((i) => {
      month(i.purchased_on.slice(0, 7)).purchase += i.price + i.shipping;
    });
    st.expenses.filter((e) => inYear(e.spent_on)).forEach((e) => {
      month(e.spent_on.slice(0, 7)).expense += e.amount;
    });
    return [...months.values()]
      .map((m) => ({ ...m, profit: m.income - m.sales_cost - m.purchase - m.expense }))
      .sort((a, b) => (a.ym < b.ym ? 1 : -1));
  }

  function totals(rows) {
    const t = { income: 0, sales_cost: 0, purchase: 0, expense: 0, profit: 0 };
    rows.forEach((r) => {
      Object.keys(t).forEach((k) => { t[k] += r[k]; });
    });
    return t;
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
  const signClass = (v) => (v >= 0 ? 'plus' : 'minus');
  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
  const kpi = (label, value, cls = '') => `<div class="card kpi"><div class="muted">${label}</div><div class="value ${cls}">${value}</div></div>`;

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function setFlash(message) {
    pendingFlash = message;
  }

  function flashHtml() {
    if (!pendingFlash) return '';
    const message = pendingFlash;
    pendingFlash = '';
    return `<div class="flash">${esc(message)}</div>`;
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
      if (arg === 'new') return { view: viewItemForm, id: null };
      return { view: viewItemForm, id: Number(arg) };
    }
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
    if (head === 'export') return { view: viewExport };
    return { view: notFound };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function fieldText(form, name) {
    return (form.elements[name]?.value ?? '').trim();
  }

  function fieldInt(form, name) {
    const raw = (form.elements[name]?.value ?? '').replace(/,/g, '').trim();
    if (!raw) return 0;
    const n = Number(raw);
    if (!Number.isInteger(n)) throw new FormError('数値で入力してください');
    return n;
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

  function notFound() {
    return {
      title: '見つかりません',
      html: '<h1>見つかりません</h1><p><a href="#/">ホームへ戻る</a></p>',
    };
  }

  /* ---------- Views ---------- */

  function viewHome({ st, d }) {
    const now = new Date();
    const yearRows = monthlyRows(st, now.getFullYear());
    const month = yearRows.find((r) => r.ym === today().slice(0, 7)) || totals([]);
    const year = totals(yearRows);
    const recentSales = [...st.sales]
      .sort((a, b) => {
        if (a.sold_on !== b.sold_on) return a.sold_on < b.sold_on ? 1 : -1;
        return b.id - a.id;
      })
      .slice(0, 5);
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
          ${kpi('未販売のセット', `${d.stockCount}件`)}
          ${kpi('未販売の原価', yen(d.stockCost))}
        </div>
        <div class="actions">
          <a class="btn" href="#/sets/new">+ 販売セットを作る</a>
          <a class="btn sub" href="#/items/new">+ 仕入れ品を登録</a>
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
            <tr><th>仕入れ日</th><th>分類</th><th>品名</th><th class="num">原価</th></tr>
            ${recentItems.map((i) => `
              <tr>
                <td>${esc(i.purchased_on)}</td>
                <td>${esc(i.category)}</td>
                <td><a href="#/items/${i.id}">${esc(i.name)}</a></td>
                <td class="num">${yen(i.cost)}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="muted">仕入れ品はまだありません</td></tr>'}
          </table>
        </div>`,
    };
  }

  async function viewItems({ d, query }) {
    const category = query.get('category') || '';
    const unset = query.get('unset') === '1';
    let rows = d.itemRows;
    if (CATEGORIES.includes(category)) rows = rows.filter((r) => r.category === category);
    if (unset) rows = rows.filter((r) => r.set_id == null);
    const urls = await photoUrls(rows.map((r) => r.thumb));
    const total = rows.reduce((sum, r) => sum + r.cost, 0);
    return {
      title: '仕入れ品',
      html: `
        <div class="actions">
          <h1>仕入れ品</h1>
          <a class="btn" href="#/items/new">+ 仕入れ品を登録</a>
        </div>
        <div class="actions">
          <a class="btn sub small" href="#/items">すべて</a>
          ${CATEGORIES.map((c) => `<a class="btn sub small" href="#/items?category=${encodeURIComponent(c)}">${esc(c)}</a>`).join('')}
          <a class="btn sub small" href="#/items?unset=1">セット未所属のみ</a>
        </div>
        <p class="muted">${rows.length}件 ／ 原価合計 ${yen(total)}</p>
        <div class="card table-wrap">
          <table>
            <tr><th>写真</th><th>品名</th><th>分類</th><th>仕入れ日</th><th>仕入れ先</th><th class="num">原価</th><th>セット</th></tr>
            ${rows.map((r) => `
              <tr>
                <td>${urls.has(r.thumb) ? `<img class="thumb" src="${urls.get(r.thumb)}" alt="">` : ''}</td>
                <td><a href="#/items/${r.id}">${esc(r.name)}</a></td>
                <td>${esc(r.category)}</td>
                <td>${esc(r.purchased_on)}</td>
                <td>${esc(r.shop)}</td>
                <td class="num">${yen(r.cost)}</td>
                <td>${r.set_id != null ? `<a href="#/sets/${r.set_id}">${esc(r.set_name)}</a>` : '<span class="muted">未所属</span>'}</td>
              </tr>`).join('') || '<tr><td colspan="7" class="muted">該当する仕入れ品はありません</td></tr>'}
          </table>
        </div>`,
    };
  }

  async function viewItemForm({ st, d, id }) {
    const item = id == null ? null : d.itemRows.find((r) => r.id === id);
    if (id != null && !item) return notFound();
    const photos = item ? d.itemPhotos.get(item.id) || [] : [];
    const urls = await photoUrls(photos.map((p) => p.id));
    const sets = [...st.sets].sort((a, b) => b.id - a.id);
    const title = item ? '仕入れ品の編集' : '仕入れ品の登録';
    const deleteButton = item ? `
      <button class="btn danger" type="button" data-action="delete-item" data-id="${item.id}" data-confirm="この仕入れ品を削除しますか？写真も削除されます。">この仕入れ品を削除</button>` : '';
    return {
      title,
      html: `
        <h1>${title}</h1>
        <form class="card grid" data-form="item"${item ? ` data-id="${item.id}"` : ''}>
          <label class="wide">品名
            <input name="name" required value="${esc(item?.name ?? '')}" placeholder="例：紺大島紬 薄手">
          </label>
          <label>分類
            <select name="category">${CATEGORIES.map((c) => opt(c, c, item?.category === c)).join('')}</select>
          </label>
          <label>仕入れ日
            <input type="date" name="purchased_on" value="${item ? esc(item.purchased_on) : today()}">
          </label>
          <label>本体価格（円）
            <input type="number" name="price" min="0" inputmode="numeric" value="${item ? item.price : 0}">
          </label>
          <label>送料（円）
            <input type="number" name="shipping" min="0" inputmode="numeric" value="${item ? item.shipping : 0}">
          </label>
          <label>仕入れ先
            <input name="shop" value="${esc(item?.shop ?? '')}" placeholder="例：ネットショップ名">
          </label>
          <label>販売セット
            <select name="set_id">
              <option value="">（未所属）</option>
              ${sets.map((s) => opt(String(s.id), s.name, item?.set_id === s.id)).join('')}
            </select>
          </label>
          <label class="wide">メモ
            <textarea name="memo">${esc(item?.memo ?? '')}</textarea>
          </label>
          <label class="wide">写真（複数選択可・スマホではカメラでの撮影も可）
            <input type="file" name="photos" accept="image/*" multiple>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">保存</button>
            <a class="btn sub" href="#/items">一覧へ戻る</a>
          </div>
        </form>
        ${item ? photoGrid(photos, urls, true) + deleteButton : ''}`,
    };
  }

  async function viewSets({ d }) {
    const urls = await photoUrls(d.setRows.map((s) => s.thumb));
    return {
      title: '販売セット',
      html: `
        <div class="actions">
          <h1>販売セット</h1>
          <a class="btn" href="#/sets/new">+ 販売セットを作る</a>
        </div>
        <div class="cards">
          ${d.setRows.map((s) => `
            <a class="card set-card" href="#/sets/${s.id}">
              ${urls.has(s.thumb) ? `<img class="cover" src="${urls.get(s.thumb)}" alt="">` : '<div class="cover">写真なし</div>'}
              <div class="name">${esc(s.name)}</div>
              <span class="badge ${s.sold ? 'sold' : 'stock'}">${esc(s.display_status)}</span>
              <div class="muted">構成 ${s.item_count}点 ／ 原価 ${yen(s.cost)}</div>
              ${s.sold
                ? `<div>利益 <b class="${signClass(s.profit)}">${yen(s.profit)}</b></div>`
                : `<div class="muted">希望価格 ${yen(s.list_price)}</div>`}
            </a>`).join('') || '<p class="muted">まだ販売セットがありません</p>'}
        </div>`,
    };
  }

  async function viewSetForm({ st, d, id }) {
    const set = id == null ? null : d.setRows.find((s) => s.id === id);
    if (id != null && !set) return notFound();
    const photos = set ? d.setPhotos.get(set.id) || [] : [];
    const urls = await photoUrls(photos.map((p) => p.id));
    const items = [...st.items].sort((a, b) => b.id - a.id);
    const title = set ? '販売セットの編集' : '販売セットの作成';
    const checks = items.map((i) => {
      const member = set != null && i.set_id === set.id;
      const other = i.set_id != null && !member;
      const note = other ? ` <span class="muted">※「${esc(d.setById.get(i.set_id)?.name)}」に所属中</span>` : '';
      return `
        <label>
          <input type="checkbox" name="item_ids" value="${i.id}"${member ? ' checked' : ''}>
          [${esc(i.category)}] ${esc(i.name)}（${yen(i.price + i.shipping)}）${note}
        </label>`;
    }).join('') || '<p class="muted">仕入れ品がまだありません。先に仕入れ品を登録してください。</p>';
    return {
      title,
      html: `
        <h1>${title}</h1>
        <form class="card grid" data-form="set"${set ? ` data-id="${set.id}"` : ''}>
          <label class="wide">セット名
            <input name="name" required value="${esc(set?.name ?? '')}" placeholder="例：紺大島・名古屋帯・帯締めセット">
          </label>
          <label>状態
            <select name="status">${SET_STATUSES.map((s) => opt(s, s, set?.status === s)).join('')}</select>
          </label>
          <label>販売希望価格（円）
            <input type="number" name="list_price" min="0" inputmode="numeric" value="${set ? set.list_price : 0}">
          </label>
          <label class="wide">説明・コーディネートのメモ
            <textarea name="description">${esc(set?.description ?? '')}</textarea>
          </label>
          <div class="wide">
            <h2>構成品（仕入れ品から選択）</h2>
            <div class="card checks">${checks}</div>
          </div>
          <label class="wide">写真を追加（複数選択可）
            <input type="file" name="photos" accept="image/*" multiple>
          </label>
          <div class="wide actions">
            <button class="btn" type="submit">保存</button>
            <a class="btn sub" href="#/sets">一覧へ戻る</a>
          </div>
        </form>
        ${set ? photoGrid(photos, urls, true) : ''}`,
    };
  }

  async function viewSetDetail({ d, id }) {
    const set = d.setRows.find((s) => s.id === id);
    if (!set) return notFound();
    const photos = d.setPhotos.get(set.id) || [];
    const urls = await photoUrls(photos.map((p) => p.id));
    const sale = set.sale;
    const itemsHtml = set.members.map((i) => `
      <tr>
        <td>${esc(i.category)}</td>
        <td><a href="#/items/${i.id}">${esc(i.name)}</a></td>
        <td>${esc(i.shop)}</td>
        <td>${esc(i.purchased_on)}</td>
        <td class="num">${yen(i.price)}</td>
        <td class="num">${yen(i.shipping)}</td>
        <td class="num">${yen(i.price + i.shipping)}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="muted">構成品がありません</td></tr>';
    const profitHtml = set.sold ? `
      <table>
        <tr><td>販売価格＋送料受取</td><td class="num">${yen(set.revenue)}</td></tr>
        <tr><td>原価（本体＋送料）</td><td class="num">-${yen(set.cost)}</td></tr>
        <tr><td>販売手数料・発送料</td><td class="num">-${yen(set.fees)}</td></tr>
        <tr><th>利益</th><th class="num ${signClass(set.profit)}">${yen(set.profit)}</th></tr>
      </table>` : '<p class="muted">販売記録を入力すると利益が表示されます。</p>';
    return {
      title: set.name,
      html: `
        <div class="actions">
          <h1>${esc(set.name)}</h1>
          <span class="badge ${set.sold ? 'sold' : 'stock'}">${esc(set.display_status)}</span>
          <a class="btn sub small" href="#/sets/${set.id}/edit">編集</a>
        </div>
        ${set.description ? `<div class="card pre">${esc(set.description)}</div>` : ''}
        ${photoGrid(photos, urls, false)}
        <h2>構成品</h2>
        <div class="card table-wrap">
          <table>
            <tr><th>分類</th><th>品名</th><th>仕入れ先</th><th>仕入れ日</th><th class="num">本体</th><th class="num">送料</th><th class="num">原価</th></tr>
            ${itemsHtml}
            <tr><th colspan="6">原価合計</th><th class="num">${yen(set.cost)}</th></tr>
          </table>
        </div>
        <h2>販売記録</h2>
        <div class="card">
          <form class="grid" data-form="sale" data-id="${set.id}">
            <label>販売日
              <input type="date" name="sold_on" value="${sale ? esc(sale.sold_on) : today()}">
            </label>
            <label>販売経路
              <input name="channel" value="${esc(sale?.channel ?? '')}" placeholder="例：自社サイト・メルカリ">
            </label>
            <label>販売価格（円）
              <input type="number" name="sale_price" min="0" inputmode="numeric" value="${sale ? sale.sale_price : set.list_price}">
            </label>
            <label>送料受取（円）
              <input type="number" name="shipping_charged" min="0" inputmode="numeric" value="${sale ? sale.shipping_charged : 0}">
            </label>
            <label>販売手数料（円）
              <input type="number" name="platform_fee" min="0" inputmode="numeric" value="${sale ? sale.platform_fee : 0}">
            </label>
            <label>発送料・実費（円）
              <input type="number" name="shipping_cost" min="0" inputmode="numeric" value="${sale ? sale.shipping_cost : 0}">
            </label>
            <label class="wide">メモ
              <textarea name="memo">${esc(sale?.memo ?? '')}</textarea>
            </label>
            <div class="wide actions">
              <button class="btn" type="submit">${set.sold ? '販売内容を更新' : '販売を記録する'}</button>
            </div>
          </form>
          ${set.sold ? `<button class="btn danger small" type="button" data-action="cancel-sale" data-id="${sale.id}" data-confirm="販売記録を取り消しますか？">販売記録を取り消す</button>` : ''}
        </div>
        <h2>利益</h2>
        <div class="card table-wrap">${profitHtml}</div>
        ${set.sold ? '' : `<button class="btn danger" type="button" data-action="delete-set" data-id="${set.id}" data-confirm="このセットを削除しますか？構成品は未所属に戻ります。">このセットを削除</button>`}`,
    };
  }

  function viewExpenses({ st, query }) {
    const year = Number(query.get('year')) || new Date().getFullYear();
    const rows = st.expenses
      .filter((e) => e.spent_on.startsWith(`${year}-`))
      .sort((a, b) => {
        if (a.spent_on !== b.spent_on) return a.spent_on < b.spent_on ? 1 : -1;
        return b.id - a.id;
      });
    const total = rows.reduce((sum, e) => sum + e.amount, 0);
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
            <select name="category">${EXPENSE_CATEGORIES.map((c) => opt(c, c, e?.category === c)).join('')}</select>
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
    const raw = query.get('year') ?? String(new Date().getFullYear());
    const year = /^\d+$/.test(raw) ? Number(raw) : null;
    const rows = monthlyRows(st, year);
    const total = totals(rows);
    return {
      title: '収支表',
      html: `
        <div class="actions">
          <h1>月別収支表</h1>
          <select data-nav="#/report?year=">
            ${yearsList(st).map((y) => opt(String(y), `${y}年`, y === year)).join('')}
            ${opt('all', '全期間', year === null)}
          </select>
          <button class="btn sub small" type="button" data-action="csv" data-kind="monthly">CSVで書き出し</button>
        </div>
        <p class="muted">売上は販売日、仕入れは仕入れ日、経費は支出日で月ごとに集計しています。</p>
        <div class="card table-wrap">
          <table>
            <tr>
              <th>年月</th><th class="num">売上</th><th class="num">手数料・発送料</th>
              <th class="num">仕入れ</th><th class="num">経費</th><th class="num">収支</th>
            </tr>
            ${rows.map((m) => `
              <tr>
                <td>${esc(m.ym)}</td>
                <td class="num">${yen(m.income)}</td>
                <td class="num">${yen(m.sales_cost)}</td>
                <td class="num">${yen(m.purchase)}</td>
                <td class="num">${yen(m.expense)}</td>
                <td class="num ${signClass(m.profit)}">${yen(m.profit)}</td>
              </tr>`).join('') || '<tr><td colspan="6" class="muted">データがありません</td></tr>'}
            ${rows.length ? `
              <tr>
                <th>合計</th>
                <th class="num">${yen(total.income)}</th>
                <th class="num">${yen(total.sales_cost)}</th>
                <th class="num">${yen(total.purchase)}</th>
                <th class="num">${yen(total.expense)}</th>
                <th class="num ${signClass(total.profit)}">${yen(total.profit)}</th>
              </tr>` : ''}
          </table>
        </div>`,
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
          <p class="muted">復元すると、現在のデータはすべて置き換えられます。</p>
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

  /* ---------- Save / delete ---------- */

  async function saveItem(form) {
    const id = Number(form.dataset.id) || null;
    const name = fieldText(form, 'name');
    if (!name) throw new FormError('品名を入力してください');
    const setValue = form.elements.set_id.value;
    const data = {
      name,
      category: fieldChoice(form, 'category', CATEGORIES),
      shop: fieldText(form, 'shop'),
      purchased_on: fieldDate(form, 'purchased_on'),
      price: fieldInt(form, 'price'),
      shipping: fieldInt(form, 'shipping'),
      set_id: setValue ? Number(setValue) : null,
      memo: fieldText(form, 'memo'),
    };
    const { id: savedId } = await dbTx(['items'], 'readwrite', (s) => (
      id ? { id: s.items.put({ ...data, id }) } : { id: s.items.add(data) }
    ));
    await addPhotos(form.elements.photos.files, { item_id: savedId, set_id: null });
    setFlash(id ? '保存しました' : '仕入れ品を登録しました');
    go(`#/items/${savedId}`);
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
    const data = {
      name,
      status: fieldChoice(form, 'status', SET_STATUSES),
      list_price: fieldInt(form, 'list_price'),
      description: fieldText(form, 'description'),
    };
    const { id: setId } = await dbTx(['sets'], 'readwrite', (s) => (
      id ? { id: s.sets.put({ ...data, id }) } : { id: s.sets.add(data) }
    ));
    const selected = new Set(
      Array.from(form.querySelectorAll('input[name="item_ids"]:checked'), (el) => Number(el.value)),
    );
    await assignItems(setId, selected);
    await addPhotos(form.elements.photos.files, { item_id: null, set_id: setId });
    setFlash(id ? '保存しました' : '販売セットを作成しました');
    go(`#/sets/${setId}`);
  }

  async function saveSale(form) {
    const setId = Number(form.dataset.id);
    const values = {
      sold_on: fieldDate(form, 'sold_on'),
      channel: fieldText(form, 'channel'),
      sale_price: fieldInt(form, 'sale_price'),
      shipping_charged: fieldInt(form, 'shipping_charged'),
      platform_fee: fieldInt(form, 'platform_fee'),
      shipping_cost: fieldInt(form, 'shipping_cost'),
      memo: fieldText(form, 'memo'),
    };
    const st = await loadState();
    const existing = st.sales.find((s) => s.set_id === setId);
    await dbTx(['sales'], 'readwrite', (s) => {
      if (existing) s.sales.put({ ...values, id: existing.id, set_id: setId });
      else s.sales.add({ ...values, set_id: setId });
    });
    setFlash('販売内容を保存しました');
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
    setFlash(id ? '保存しました' : '経費を登録しました');
    go('#/expenses');
  }

  async function deleteItem(id) {
    const st = await loadState();
    const photoIds = st.photos.filter((p) => p.item_id === id).map((p) => p.id);
    await dbTx(['items', 'photos', 'photo_files'], 'readwrite', (s) => {
      s.items.delete(id);
      photoIds.forEach((pid) => {
        s.photos.delete(pid);
        s.photo_files.delete(pid);
      });
    });
    setFlash('仕入れ品を削除しました');
    go('#/items');
  }

  async function deleteSet(id) {
    const st = await loadState();
    if (st.sales.some((s) => s.set_id === id)) {
      setFlash('販売記録があるため削除できません');
      return render();
    }
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
    setFlash('セットを削除しました。構成品は未所属に戻りました');
    go('#/sets');
  }

  async function cancelSale(saleId) {
    await dbTx(['sales'], 'readwrite', (s) => {
      s.sales.delete(saleId);
    });
    setFlash('販売記録を取り消しました');
    return render();
  }

  async function deleteExpense(id) {
    await dbTx(['expenses'], 'readwrite', (s) => {
      s.expenses.delete(id);
    });
    setFlash('経費を削除しました');
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

  const byDateThenId = (key) => (a, b) => {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
    return a.id - b.id;
  };

  const CSV_BUILDERS = {
    items: (st, d) => [
      ['ID', '品名', '分類', '仕入れ先', '仕入れ日', '本体価格', '送料', '原価', 'セット', 'メモ'],
      [...d.itemRows].sort(byDateThenId('purchased_on')).map((i) => [
        i.id, i.name, i.category, i.shop, i.purchased_on, i.price, i.shipping, i.cost, i.set_name, i.memo,
      ]),
    ],
    sets: (st, d) => [
      ['ID', 'セット名', '状態', '販売希望価格', '構成品', '原価', '販売日', '販売経路', '販売価格', '送料受取', '手数料', '発送料', '利益'],
      d.setRows.map((s) => [
        s.id, s.name, s.display_status, s.list_price, s.item_names, s.cost,
        s.sale?.sold_on, s.sale?.channel,
        s.sold ? s.sale.sale_price : '', s.sold ? s.sale.shipping_charged : '',
        s.sold ? s.sale.platform_fee : '', s.sold ? s.sale.shipping_cost : '',
        s.profit,
      ]),
    ],
    sales: (st, d) => [
      ['ID', '販売日', 'セット名', '販売経路', '販売価格', '送料受取', '手数料', '発送料', '売上合計', 'メモ'],
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
      ['年月', '売上', '手数料・発送料', '仕入れ', '経費', '収支'],
      monthlyRows(st, null).reverse().map((m) => [m.ym, m.income, m.sales_cost, m.purchase, m.expense, m.profit]),
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
      sets: s.sets.getAll(),
      items: s.items.getAll(),
      sales: s.sales.getAll(),
      expenses: s.expenses.getAll(),
      photos: s.photos.getAll(),
      fileKeys: s.photo_files.getAllKeys(),
      fileBlobs: s.photo_files.getAll(),
    }));
    const photoFiles = await Promise.all(raw.fileKeys.map(async (id, i) => ({
      id,
      data: await blobToDataUrl(raw.fileBlobs[i]),
    })));
    const backup = {
      app: 'kimono_site',
      version: 1,
      exported_at: new Date().toISOString(),
      data: {
        sets: raw.sets,
        items: raw.items,
        sales: raw.sales,
        expenses: raw.expenses,
        photos: raw.photos,
        photo_files: photoFiles,
      },
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
    const data = backup?.data;
    const valid = data && [...DATA_KEYS, 'photo_files'].every((k) => Array.isArray(data[k]));
    if (!valid) throw new FormError('着物販売管理のバックアップファイルではありません');
    if (!confirm('現在のデータはすべて置き換えられます。よろしいですか？')) return;
    const blobs = await Promise.all(data.photo_files.map(async (f) => ({
      id: f.id,
      blob: await (await fetch(f.data)).blob(),
    })));
    await dbTx(STORE_NAMES, 'readwrite', (s) => {
      STORE_NAMES.forEach((name) => { s[name].clear(); });
      data.sets.forEach((r) => { s.sets.put(r); });
      data.items.forEach((r) => { s.items.put(r); });
      data.sales.forEach((r) => { s.sales.put(r); });
      data.expenses.forEach((r) => { s.expenses.put(r); });
      data.photos.forEach((r) => { s.photos.put(r); });
      blobs.forEach((b) => { s.photo_files.put(b.blob, b.id); });
    });
    setFlash('復元しました');
    go('#/');
  }

  /* ---------- Dispatch ---------- */

  const formHandlers = {
    item: saveItem,
    set: saveSet,
    sale: saveSale,
    expense: saveExpense,
    restore: restoreBackup,
  };

  async function runAction(action, data) {
    switch (action) {
      case 'delete-item': return deleteItem(Number(data.id));
      case 'delete-set': return deleteSet(Number(data.id));
      case 'cancel-sale': return cancelSale(Number(data.id));
      case 'delete-expense': return deleteExpense(Number(data.id));
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
      main.innerHTML = flashHtml() + page.html;
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
    if (el.dataset.confirm && !confirm(el.dataset.confirm)) return;
    try {
      await runAction(el.dataset.action, el.dataset);
    } catch (err) {
      reportError(err);
    }
  });

  main.addEventListener('change', (e) => {
    const nav = e.target.dataset?.nav;
    if (nav) go(nav + encodeURIComponent(e.target.value));
  });

  main.addEventListener('submit', async (e) => {
    const form = e.target;
    const handler = formHandlers[form.dataset.form];
    if (!handler) return;
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    try {
      await handler(form);
    } catch (err) {
      reportError(err);
    } finally {
      delete form.dataset.busy;
    }
  });

  window.addEventListener('hashchange', render);
  render();
})();
