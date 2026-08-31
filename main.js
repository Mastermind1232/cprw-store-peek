/**
 * CPR Wizards Store — Shopfront
 *
 * Decorates the Cyberpunk RED Wizards store. It does not fork or replace it;
 * every feature is additive and fails soft if the host module changes.
 *
 *   - Click an item's name to open its sheet
 *   - Named stores: a saved roster of specific items, each with a quantity
 *   - Build one by hand-picking, snapshotting the current filters, or rolling
 *   - Limited or Unlimited supply, with Restock
 *   - The GM picks which store is live; players see its name and its stock
 */

const ID = "cprw-store-peek";
const CRW = "cyberpunk-red-wizards";

const ROW = ".crw-store-item";
const NAME = ".crw-store-item-info";
const BUY = ".crw-store-btn-buy";
const DIVIDER = ".crw-store-group-divider";
const HEADER = ".crw-store-header";
const TAB = ".crw-store-tab";

/** The nine types the Wizards store is able to render. Anything else is unreachable. */
const TYPES = {
  weapon: "Weapons",
  ammo: "Ammo",
  armor: "Armor",
  clothing: "Clothing",
  gear: "Gear",
  cyberware: "Cyberware",
  program: "Programs",
  itemUpgrade: "Upgrades",
  vehicle: "Vehicles",
};

/* ------------------------------------------------------------------ */
/*  Settings                                                           */
/* ------------------------------------------------------------------ */

Hooks.once("init", () => {
  /**
   * Stores are held in an array, not an object keyed by uuid, because item
   * uuids contain dots and Foundry expands dotted keys in places.
   * [{ id, name, markup, limited, items: [{uuid,name,type,price,qty,remaining}] }]
   */
  game.settings.register(ID, "stores", { scope: "world", config: false, type: Array, default: [] });
  game.settings.register(ID, "activeStore", { scope: "world", config: false, type: String, default: "" });
});

const getStores = () => game.settings.get(ID, "stores") ?? [];
const getActiveId = () => game.settings.get(ID, "activeStore") ?? "";
const getActive = () => getStores().find((s) => s.id === getActiveId()) ?? null;
const saveStores = (s) => game.settings.set(ID, "stores", s);

async function mutateStore(id, fn) {
  const stores = foundry.utils.deepClone(getStores());
  const store = stores.find((s) => s.id === id);
  if (!store) return null;
  fn(store);
  await saveStores(stores);
  return store;
}

/* ------------------------------------------------------------------ */
/*  Item pool — borrowed from the host module so it always matches      */
/* ------------------------------------------------------------------ */

let _pool = null;

const STORE_TYPES = new Set(Object.keys(TYPES));

/** Mirrors the host module's classifyPackSource. null means never purchasable. */
function packSource(id) {
  if (id.startsWith("cyberpunk-red-core.internal_")) return null;
  if (id.startsWith("cyberpunk-red-core.other_")) return null;
  if (id.startsWith("cyberpunk-red-core.core_")) return "core";
  if (id.startsWith("cyberpunk-red-core.black-chrome_")) return "blackChrome";
  return "dlc";
}

/** Mirrors the host module's isPackExcluded. */
function packExcluded(id, excluded) {
  if (excluded[id]) return true;
  if (id.startsWith("cyberpunk-red-core.core_") && excluded["group:core"]) return true;
  if (id.startsWith("cyberpunk-red-core.black-chrome_") && excluded["group:blackChrome"]) return true;
  return false;
}

const lite = (d) => ({
  uuid: d.uuid,
  name: d.name,
  type: d.type,
  price: d.system?.price?.market ?? 0,
});

/**
 * The purchasable universe. Deliberately reimplemented rather than imported
 * from the host module: on The Forge, modules are served from a versioned CDN
 * path, so a hardcoded /modules/... import does not resolve.
 */
async function pool() {
  if (_pool) return _pool;
  ui.notifications.info("Building item list, this takes a moment...");

  const excluded = game.settings.get(CRW, "storeExcludedPacks") ?? {};
  const out = [];

  for (const pack of game.packs) {
    if (pack.metadata.type !== "Item") continue;
    if (packSource(pack.metadata.id) === null) continue;
    if (packExcluded(pack.metadata.id, excluded)) continue;
    let docs;
    try {
      docs = await pack.getDocuments();
    } catch (e) {
      console.warn(`${ID} | could not read pack ${pack.metadata.id}`, e);
      continue;
    }
    for (const d of docs) if (STORE_TYPES.has(d.type)) out.push(lite(d));
  }

  for (const d of game.items) if (STORE_TYPES.has(d.type)) out.push(lite(d));

  _pool = out;
  return out;
}

/** The store's own visibility rules, minus the transient search box. */
function currentFilter() {
  const a = game.settings.get(CRW, "storeAvailability");
  const blocked = new Set(a.blockedItems ?? []);
  return (item) => {
    if (a.categoryEnabled?.[item.type] === false) return false;
    if (blocked.has(item.uuid)) return false;
    if (a.priceMin > 0 && item.price < a.priceMin) return false;
    if (a.priceMax > 0 && item.price > a.priceMax) return false;
    return true;
  };
}

const entry = (i, qty = 1) => ({
  uuid: i.uuid, name: i.name, type: i.type, price: i.price, qty, remaining: qty,
});

/* ------------------------------------------------------------------ */
/*  Rendering                                                          */
/* ------------------------------------------------------------------ */

function wirePeek(root) {
  root.querySelectorAll(NAME).forEach((el) => {
    if (el.dataset.peekWired) return;
    el.dataset.peekWired = "1";
    el.style.cursor = "pointer";
    el.title = "Open item sheet";
    el.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const uuid = el.closest("[data-uuid]")?.dataset?.uuid;
      if (!uuid) return;
      const doc = await fromUuid(uuid).catch(() => null);
      if (doc) doc.sheet.render(true);
      else ui.notifications.warn("Could not find that item.");
    });
  });
}

function applyStore(root, store) {
  const byUuid = new Map(store.items.map((i) => [i.uuid, i]));

  root.querySelectorAll(ROW).forEach((row) => {
    const stocked = byUuid.get(row.dataset.uuid);
    if (!stocked) return row.remove();
    if (!store.limited) return;

    const left = stocked.remaining ?? 0;
    const buy = row.querySelector(BUY);
    if (left <= 0) {
      row.classList.add("crw-store-unaffordable");
      if (buy) {
        buy.disabled = true;
        buy.classList.add("crw-store-btn-disabled");
        buy.textContent = "Sold out";
      }
    } else if (!row.querySelector(".cprw-qty")) {
      const tag = document.createElement("span");
      tag.className = "cprw-qty";
      tag.style.cssText = "opacity:.55;margin-left:.5em;font-size:.85em;";
      tag.textContent = `x${left}`;
      row.querySelector(".crw-store-item-name")?.appendChild(tag);
    }
  });

  // Drop source headers left with nothing under them
  root.querySelectorAll(DIVIDER).forEach((div) => {
    let n = div.nextElementSibling;
    while (n && !n.matches(DIVIDER)) {
      if (n.matches(ROW)) return;
      n = n.nextElementSibling;
    }
    div.remove();
  });

  // Hide category tabs this store carries nothing for
  const stockedTypes = new Set(store.items.map((i) => i.type));
  root.querySelectorAll(TAB).forEach((tab) => {
    const t = tab.dataset.tab;
    if (!t || t === "settings") return;
    if (!stockedTypes.has(t)) tab.style.display = "none";
  });

  const title = root.querySelector(".window-title");
  if (title) title.textContent = store.name;
}

function wireBuy(root, store) {
  if (!store?.limited) return;
  root.querySelectorAll(BUY).forEach((btn) => {
    if (btn.dataset.cprwWired) return;
    btn.dataset.cprwWired = "1";
    btn.addEventListener("click", async () => {
      const uuid = btn.dataset.uuid;
      if (!uuid) return;
      await mutateStore(store.id, (s) => {
        const it = s.items.find((i) => i.uuid === uuid);
        if (it && it.remaining > 0) it.remaining -= 1;
      });
    }, true); // capture, so the count lands before the host handles the purchase
  });
}

function injectBar(root) {
  if (!game.user.isGM || root.querySelector(".cprw-storebar")) return;
  const header = root.querySelector(HEADER);
  if (!header) return;

  const activeId = getActiveId();
  const opts = ['<option value="">— Full catalogue —</option>']
    .concat(
      [...getStores()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => {
          const n = s.items.length;
          const supply = s.limited ? "limited" : "unlimited";
          const sel = s.id === activeId ? "selected" : "";
          return `<option value="${s.id}" ${sel}>${s.name} (${n}, ${supply})</option>`;
        })
    )
    .join("");

  const bar = document.createElement("div");
  bar.className = "cprw-storebar";
  bar.style.cssText =
    "display:flex;gap:.5em;align-items:center;padding:.4em .75em;" +
    "border-bottom:1px solid rgba(255,255,255,.15);";
  bar.innerHTML =
    `<label style="opacity:.7;font-size:.85em;letter-spacing:.05em;">STORE</label>` +
    `<select class="cprw-select crw-input" style="flex:1;min-width:0;">${opts}</select>` +
    `<button class="cprw-manage" style="flex:0 0 auto;width:auto;" title="Manage stores">` +
    `<i class="fas fa-sliders-h"></i></button>`;

  header.after(bar);

  bar.querySelector(".cprw-select").addEventListener("change", async (e) => {
    await activate(e.target.value);
  });
  bar.querySelector(".cprw-manage").addEventListener("click", (e) => {
    e.preventDefault();
    manage();
  });
}

async function activate(id) {
  await game.settings.set(ID, "activeStore", id);
  const store = getStores().find((s) => s.id === id);
  if (store) await game.settings.set(CRW, "storeMarkup", store.markup);
  rerender();
}

function rerender() {
  for (const w of Object.values(ui.windows)) {
    if (w.constructor?.name === "StoreApp") w.render(true);
  }
}

/* ------------------------------------------------------------------ */
/*  Manage dialog                                                      */
/* ------------------------------------------------------------------ */

function manage() {
  const stores = [...getStores()].sort((a, b) => a.name.localeCompare(b.name));

  const rows = stores.length
    ? stores.map((s) => {
        const total = s.items.reduce((n, i) => n + (i.qty ?? 1), 0);
        const left = s.items.reduce((n, i) => n + (i.remaining ?? 0), 0);
        const stock = s.limited ? `${left} / ${total}` : "∞";
        return `<tr data-id="${s.id}">
          <td>${s.name}</td>
          <td style="text-align:center">${s.items.length}</td>
          <td style="text-align:center">${stock}</td>
          <td style="text-align:center">${s.markup}%</td>
          <td style="text-align:right;white-space:nowrap">
            <a data-act="edit" title="Edit contents"><i class="fas fa-pen-to-square"></i></a>
            <a data-act="restock" title="Restock"><i class="fas fa-rotate"></i></a>
            <a data-act="rename" title="Rename"><i class="fas fa-i-cursor"></i></a>
            <a data-act="supply" title="Toggle limited/unlimited"><i class="fas fa-infinity"></i></a>
            <a data-act="delete" title="Delete"><i class="fas fa-trash"></i></a>
          </td></tr>`;
      }).join("")
    : `<tr><td colspan="5" style="opacity:.6;text-align:center">No stores yet.</td></tr>`;

  new Dialog({
    title: "Manage Stores",
    content: `
      <table style="width:100%;font-size:.95em">
        <thead><tr><th style="text-align:left">Name</th><th>Items</th><th>Stock</th><th>Markup</th><th></th></tr></thead>
        <tbody class="cprw-rows">${rows}</tbody>
      </table>
      <hr/>
      <p><b>New store</b></p>
      <div class="form-group"><label>Name</label>
        <input type="text" name="n" value="New Store"/></div>
      <div class="form-group"><label>Markup %</label>
        <input type="number" name="m" value="100" style="width:80px"/>
        <label style="margin-left:1em"><input type="checkbox" name="l" checked/> Limited supply</label></div>
      <p style="opacity:.65;font-size:.9em">
        <b>Snapshot</b> takes every item that passes the store's current category,
        price and hidden-item settings. <b>Roll</b> generates a random roster.
        <b>Pick</b> opens a chooser.</p>`,
    buttons: {
      pick: { icon: '<i class="fas fa-hand-pointer"></i>', label: "Pick", callback: (h) => create(h, "pick") },
      snap: { icon: '<i class="fas fa-camera"></i>', label: "Snapshot", callback: (h) => create(h, "snap") },
      roll: { icon: '<i class="fas fa-dice"></i>', label: "Roll", callback: (h) => create(h, "roll") },
    },
    default: "pick",
    render: (h) => {
      h[0].querySelectorAll(".cprw-rows a").forEach((a) => {
        a.style.cssText = "cursor:pointer;margin-left:.4em";
        a.addEventListener("click", async (ev) => {
          ev.preventDefault();
          const id = a.closest("tr").dataset.id;
          const act = a.dataset.act;
          const store = getStores().find((s) => s.id === id);
          if (!store) return;

          if (act === "delete") {
            if (!(await confirmDelete(store.name))) return;
            await saveStores(getStores().filter((s) => s.id !== id));
            if (getActiveId() === id) await game.settings.set(ID, "activeStore", "");
          } else if (act === "restock") {
            await mutateStore(id, (s) => s.items.forEach((i) => (i.remaining = i.qty)));
            ui.notifications.info(`${store.name} restocked.`);
          } else if (act === "rename") {
            const n = await promptText("Rename store", store.name);
            if (!n) return;
            await mutateStore(id, (s) => (s.name = n));
          } else if (act === "supply") {
            await mutateStore(id, (s) => (s.limited = !s.limited));
          } else if (act === "edit") {
            const picked = await picker(store.items);
            if (!picked) return;
            await mutateStore(id, (s) => (s.items = picked));
          }

          rerender();
          Object.values(ui.windows).find((w) => w.title === "Manage Stores")?.close();
          manage();
        });
      });
    },
  }).render(true);
}

function confirmDelete(name) {
  return Dialog.confirm({
    title: "Delete store",
    content: `<p>Delete <b>${name}</b>? This cannot be undone.</p>`,
  });
}

function promptText(title, initial = "") {
  return new Promise((resolve) => {
    new Dialog({
      title,
      content: `<input type="text" name="v" value="${initial}" style="width:100%"/>`,
      buttons: {
        ok: { label: "OK", callback: (h) => resolve(h[0].querySelector('[name="v"]').value.trim()) },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "ok",
      close: () => resolve(null),
    }).render(true);
  });
}

async function create(h, mode) {
  try {
    await _create(h, mode);
  } catch (err) {
    console.error(`${ID} | store creation failed`, err);
    ui.notifications.error(`Store creation failed: ${err.message}. See the console (F12).`);
  }
}

async function _create(h, mode) {
  const f = h[0];
  const name = f.querySelector('[name="n"]').value.trim() || "New Store";
  const markup = Number(f.querySelector('[name="m"]').value) || 100;
  const limited = f.querySelector('[name="l"]').checked;

  let items = null;
  if (mode === "snap") {
    items = (await pool()).filter(currentFilter()).map((i) => entry(i, 1));
    if (!items.length) return ui.notifications.warn("Nothing passes the store's current filters.");
  } else if (mode === "roll") {
    items = await rollDialog();
  } else {
    items = await picker([]);
  }
  if (!items?.length) return;

  const store = { id: foundry.utils.randomID(12), name, markup, limited, items };
  await saveStores([...getStores(), store]);
  await activate(store.id);
  ui.notifications.info(`"${name}" created with ${items.length} items.`);
}

/* ------------------------------------------------------------------ */
/*  Random roller                                                      */
/* ------------------------------------------------------------------ */

async function rollDialog() {
  const all = await pool();
  const boxes = Object.entries(TYPES)
    .map(([k, l]) => `<label style="display:inline-block;width:48%">
      <input type="checkbox" name="t" value="${k}" ${k === "weapon" ? "checked" : ""}/> ${l}</label>`)
    .join("");

  return new Promise((resolve) => {
    new Dialog({
      title: "Roll a store",
      content: `<p><b>Item types</b></p><div>${boxes}</div><hr/>
        <div class="form-group"><label>Price range (eb)</label>
          <input type="number" name="min" value="0" style="width:80px"/> to
          <input type="number" name="max" value="500" style="width:80px"/></div>
        <div class="form-group"><label>How many distinct items</label>
          <input type="number" name="count" value="12" style="width:80px"/></div>
        <div class="form-group"><label>Max quantity each</label>
          <input type="number" name="qty" value="3" style="width:80px"/></div>`,
      buttons: {
        go: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll",
          callback: (h) => {
            const f = h[0];
            const types = [...f.querySelectorAll('[name="t"]:checked')].map((i) => i.value);
            const min = Number(f.querySelector('[name="min"]').value) || 0;
            const maxRaw = Number(f.querySelector('[name="max"]').value);
            const max = maxRaw > 0 ? maxRaw : Infinity;
            const count = Number(f.querySelector('[name="count"]').value) || 10;
            const maxQty = Math.max(1, Number(f.querySelector('[name="qty"]').value) || 1);

            const bag = all.filter((i) => types.includes(i.type) && i.price >= min && i.price <= max);
            if (!bag.length) {
              ui.notifications.error("Nothing matched those filters.");
              return resolve(null);
            }
            const out = [];
            for (let n = 0; n < count && bag.length; n++) {
              const pick = bag.splice(Math.floor(Math.random() * bag.length), 1)[0];
              out.push(entry(pick, 1 + Math.floor(Math.random() * maxQty)));
            }
            resolve(out);
          },
        },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "go",
      close: () => resolve(null),
    }).render(true);
  });
}

/* ------------------------------------------------------------------ */
/*  Hand picker                                                        */
/* ------------------------------------------------------------------ */

async function picker(initial) {
  const all = await pool();
  const chosen = new Map(initial.map((i) => [i.uuid, { ...i }]));

  const typeOpts = ['<option value="">All types</option>']
    .concat(Object.entries(TYPES).map(([k, l]) => `<option value="${k}">${l}</option>`))
    .join("");

  return new Promise((resolve) => {
    const dlg = new Dialog({
      title: "Pick items",
      content: `
        <div style="display:flex;gap:.5em;margin-bottom:.5em">
          <select class="cprw-type crw-input" style="flex:0 0 40%">${typeOpts}</select>
          <input type="text" class="cprw-search crw-input" placeholder="Search..." style="flex:1"/>
        </div>
        <div class="cprw-results" style="height:220px;overflow-y:auto;border:1px solid rgba(255,255,255,.15);padding:.25em"></div>
        <p style="margin:.5em 0 .25em"><b>In this store</b> (<span class="cprw-n">0</span>)</p>
        <div class="cprw-chosen" style="height:150px;overflow-y:auto;border:1px solid rgba(255,255,255,.15);padding:.25em"></div>`,
      buttons: {
        ok: { icon: '<i class="fas fa-check"></i>', label: "Done", callback: () => resolve([...chosen.values()]) },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "ok",
      close: () => resolve(null),
      render: (h) => {
        const el = h[0];
        const results = el.querySelector(".cprw-results");
        const chosenBox = el.querySelector(".cprw-chosen");
        const counter = el.querySelector(".cprw-n");
        const typeSel = el.querySelector(".cprw-type");
        const search = el.querySelector(".cprw-search");

        function drawResults() {
          const t = typeSel.value;
          const q = search.value.trim().toLowerCase();
          let list = all.filter((i) => (!t || i.type === t) && (!q || i.name.toLowerCase().includes(q)));
          const total = list.length;
          list = list.slice(0, 150);

          results.innerHTML =
            list.map((i) =>
              `<div style="display:flex;align-items:center;gap:.5em;padding:.15em 0">
                 <a data-add="${i.uuid}" style="cursor:pointer"><i class="fas fa-plus"></i></a>
                 <span style="flex:1">${i.name}</span>
                 <span style="opacity:.5;font-size:.85em">${TYPES[i.type] ?? i.type}</span>
                 <span style="opacity:.6;width:5em;text-align:right">${i.price}eb</span>
               </div>`).join("") +
            (total > 150 ? `<p style="opacity:.5;text-align:center">${total - 150} more, narrow the search</p>` : "") +
            (total === 0 ? `<p style="opacity:.5;text-align:center">No matches</p>` : "");

          results.querySelectorAll("[data-add]").forEach((a) =>
            a.addEventListener("click", () => {
              const uuid = a.dataset.add;
              if (chosen.has(uuid)) chosen.get(uuid).qty += 1;
              else chosen.set(uuid, entry(all.find((i) => i.uuid === uuid), 1));
              chosen.get(uuid).remaining = chosen.get(uuid).qty;
              drawChosen();
            }));
        }

        function drawChosen() {
          counter.textContent = chosen.size;
          const list = [...chosen.values()].sort((a, b) => a.name.localeCompare(b.name));
          chosenBox.innerHTML = list.length
            ? list.map((i) =>
                `<div style="display:flex;align-items:center;gap:.5em;padding:.15em 0">
                   <a data-del="${i.uuid}" style="cursor:pointer"><i class="fas fa-times"></i></a>
                   <span style="flex:1">${i.name}</span>
                   <input type="number" min="1" value="${i.qty}" data-qty="${i.uuid}"
                          class="crw-input" style="width:4em"/>
                 </div>`).join("")
            : `<p style="opacity:.5;text-align:center">Nothing yet</p>`;

          chosenBox.querySelectorAll("[data-del]").forEach((a) =>
            a.addEventListener("click", () => { chosen.delete(a.dataset.del); drawChosen(); }));
          chosenBox.querySelectorAll("[data-qty]").forEach((inp) =>
            inp.addEventListener("change", () => {
              const it = chosen.get(inp.dataset.qty);
              it.qty = Math.max(1, Number(inp.value) || 1);
              it.remaining = it.qty;
            }));
        }

        typeSel.addEventListener("change", drawResults);
        search.addEventListener("input", drawResults);
        drawResults();
        drawChosen();
      },
    }, { width: 520 });
    dlg.render(true);
  });
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

Hooks.on("renderStoreApp", (app, element) => {
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  try {
    const store = getActive();
    wirePeek(root);
    injectBar(root);
    if (store) {
      applyStore(root, store);
      wireBuy(root, store);
      // Keep the store's markup in step if the GM adjusts it while it is live
      const live = game.settings.get(CRW, "storeMarkup");
      if (live !== store.markup) mutateStore(store.id, (s) => (s.markup = live));
    }
  } catch (err) {
    console.error(`${ID} | failed decorating the store`, err);
  }
});

console.log(`${ID} | ready`);
