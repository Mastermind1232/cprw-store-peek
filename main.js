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
const SOCKET = `module.${ID}`;

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
  game.settings.register(ID, "stores", {
    scope: "world", config: false, type: Array, default: [],
    onChange: () => rerender(),
  });
  // Where the full catalogue's own filters and markup are parked while a named
  // store is open, so the store shows its roster and nothing else.
  game.settings.register(ID, "catalogueFilters", {
    scope: "world", config: false, type: Object, default: {},
  });
  game.settings.register(ID, "activeStore", {
    scope: "world", config: false, type: String, default: "",
    onChange: () => rerender(),
  });
});

const getStores = () => game.settings.get(ID, "stores") ?? [];
const getActiveId = () => game.settings.get(ID, "activeStore") ?? "";
const getActive = () => getStores().find((s) => s.id === getActiveId()) ?? null;
const saveStores = (s) => game.settings.set(ID, "stores", s);

/**
 * All writes go through one chain. Two sales landing at once would otherwise
 * both read the same starting state and the second would overwrite the first.
 */
let _writes = Promise.resolve();

function queueWrite(fn) {
  _writes = _writes.then(fn).catch(reportErr);
  return _writes;
}

function mutateStore(id, fn) {
  return queueWrite(async () => {
    const stores = foundry.utils.deepClone(getStores());
    const store = stores.find((s) => s.id === id);
    if (!store) return null;
    fn(store);
    await saveStores(stores);
    return store;
  });
}

/** Store names are GM-typed free text and get interpolated into dialog HTML. */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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
function catalogueAvailability() {
  const parked = game.settings.get(ID, "catalogueFilters");
  if (getActiveId() && parked?.availability) return parked.availability;
  return game.settings.get(CRW, "storeAvailability");
}

function currentFilter() {
  const a = catalogueAvailability();
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

/**
 * The host loads each item's icon and then never renders it. Icons come from
 * the compendium index, which Foundry keeps in memory, so no documents are
 * loaded to draw them.
 */
function imgFor(uuid) {
  const parts = String(uuid).split(".");
  if (parts[0] === "Item") return game.items.get(parts[1])?.img ?? null;
  if (parts[0] === "Compendium") {
    const id = parts[parts.length - 1];
    const packId = parts.slice(1, -2).join(".");
    return game.packs.get(packId)?.index?.get(id)?.img ?? null;
  }
  return null;
}

let _warmed = false;

/** Most indexes are loaded at startup; any that are not get pulled in once. */
async function warmIndexes() {
  if (_warmed) return;
  _warmed = true;
  const cold = game.packs.filter((p) => p.metadata.type === "Item" && !p.indexed);
  if (!cold.length) return;
  await Promise.all(cold.map((p) => p.getIndex().catch(() => null)));
  rerender();
}

function addIcons(root) {
  let missed = false;

  root.querySelectorAll(ROW).forEach((row) => {
    if (row.querySelector(".cprw-icon")) return;
    const uuid = row.dataset.uuid;
    if (!uuid) return;

    const src = imgFor(uuid);
    if (!src) { missed = true; return; }

    const img = document.createElement("img");
    img.className = "cprw-icon";
    img.src = src;
    img.alt = "";
    img.title = "Open item sheet";
    img.style.cssText =
      "width:34px;height:34px;object-fit:contain;flex:0 0 auto;" +
      "margin-right:.6em;border:none;cursor:pointer;background:none;";
    // Dimmed rows dim only the text block, so match it here.
    if (row.classList.contains("crw-store-unaffordable")) img.style.opacity = "0.4";

    img.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const doc = await fromUuid(uuid).catch(() => null);
      if (doc) doc.sheet.render(true);
    });

    // The row is space-between, so the text block has to absorb the slack or
    // the icon and the buttons would drift apart.
    const info = row.querySelector(NAME);
    if (info) info.style.flex = "1 1 auto";
    row.prepend(img);
  });

  if (missed) warmIndexes().catch(reportErr);
}

function applyStore(root, store) {
  const byUuid = new Map(store.items.map((i) => [i.uuid, i]));

  root.querySelectorAll(ROW).forEach((row) => {
    const stocked = byUuid.get(row.dataset.uuid);
    if (!stocked) return row.remove();

    // The eye button writes to a single global blocklist, so inside a named
    // store it would hide the item everywhere. Removing it from the roster is
    // the right move instead. Left alone in the full catalogue view.
    row.querySelector(".crw-store-btn-hide")?.remove();

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
    }
    stockTag(row, store, stocked, left);
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
  let activeHidden = false;
  let firstVisible = null;
  root.querySelectorAll(TAB).forEach((tab) => {
    const t = tab.dataset.tab;
    if (!t || t === "settings") return;
    if (!stockedTypes.has(t)) {
      tab.style.display = "none";
      if (tab.classList.contains("crw-store-tab-active")) activeHidden = true;
    } else if (!firstVisible) firstVisible = tab;
  });
  // Landing on a category this store does not carry shows an empty shelf.
  if (activeHidden && firstVisible) firstVisible.click();

}

/**
 * Shows remaining stock. For the GM the number is editable in place: raising it
 * above the current maximum also raises what Restock will refill to.
 */
function stockTag(row, store, stocked, left) {
  if (row.querySelector(".cprw-qty")) return;
  const host = row.querySelector(".crw-store-item-name") ?? row.querySelector(NAME);
  if (!host) return;

  const tag = document.createElement("span");
  tag.className = "cprw-qty";
  tag.style.cssText = "margin-left:.5em;font-size:.85em;opacity:.75;font-weight:normal;";
  tag.textContent = left > 0 ? `x${left}` : "out";
  host.appendChild(tag);
  if (!game.user.isGM) return;

  tag.style.cursor = "pointer";
  tag.style.textDecoration = "underline dotted";
  tag.title = "Click to set stock";

  tag.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = String(left);
    input.className = "crw-input";
    input.style.cssText = "width:4.5em;margin-left:.5em;";
    // The row's name block opens the item sheet; keep these clicks out of it.
    ["click", "mousedown", "dblclick"].forEach((e) =>
      input.addEventListener(e, (x) => x.stopPropagation()));

    tag.replaceWith(input);
    input.focus();
    input.select();

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      const v = Math.max(0, Number(input.value) || 0);
      if (v === left) return rerender();
      mutateStore(store.id, (st) => {
        const it = st.items.find((i) => i.uuid === stocked.uuid);
        if (!it) return;
        it.remaining = v;
        if (v > (it.qty ?? 0)) it.qty = v;
      }).catch(reportErr);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      else if (e.key === "Escape") { settled = true; rerender(); }
    });
  });
}

/**
 * Buying opens a confirmation dialog, and gifting is instant, so a click is not
 * proof of a sale. A click only registers an intent; the intent is redeemed by
 * the createItem hook when the item actually appears on the buyer.
 * Keyed by actor and item name, queued so repeat buys of one item each count.
 */
const pending = new Map();
const INTENT_TTL = 5 * 60 * 1000;

function intendSale(root, store, uuid, name) {
  const actorId = root.querySelector(".crw-store-actor-select")?.value;
  if (!actorId || !name) return;

  const now = Date.now();
  for (const [k, queue] of pending) {
    const kept = queue.filter((i) => now - i.at < INTENT_TTL);
    if (kept.length) pending.set(k, kept);
    else pending.delete(k);
  }

  const key = `${actorId}|${name}`;
  if (!pending.has(key)) pending.set(key, []);
  pending.get(key).push({ storeId: store.id, uuid, at: now });
}

function wireBuy(root, store) {
  if (!store?.limited) return;
  // The gift button hands the item over for free, but it still leaves the shelf.
  root.querySelectorAll(`${BUY}, .crw-store-btn-loot`).forEach((btn) => {
    if (btn.dataset.cprwWired) return;
    btn.dataset.cprwWired = "1";
    btn.addEventListener("click", () => {
      const uuid = btn.dataset.uuid;
      const name = btn.closest(ROW)?.querySelector(".crw-store-item-name")?.childNodes?.[0]?.textContent?.trim();
      if (uuid && name) intendSale(root, store, uuid, name);
    }, true);
  });
}

/**
 * Rolled and snapshotted stores remember what they were built from, so a
 * reshuffle can draw a genuinely comparable replacement. Hand-picked stores
 * have no such rule, so a swap stays in the item's own type and price band.
 */
function criteriaFor(store, item) {
  const c = store.criteria;
  if (c?.types?.length) {
    return { types: c.types, min: c.min || 0, max: c.max || Infinity };
  }
  if (item) {
    return {
      types: [item.type],
      min: Math.floor(item.price * 0.5),
      max: Math.ceil(item.price * 1.5) || Infinity,
    };
  }
  return {
    types: [...new Set(store.items.map((i) => i.type))],
    min: 0,
    max: Infinity,
  };
}

function drawFrom(all, { types, min, max }, exclude) {
  return all.filter(
    (i) => types.includes(i.type) && i.price >= min && i.price <= max && !exclude.has(i.uuid)
  );
}

async function reshuffleItem(storeId, uuid) {
  const store = getStores().find((s) => s.id === storeId);
  const old = store?.items.find((i) => i.uuid === uuid);
  if (!old) return;

  const bag = drawFrom(await pool(), criteriaFor(store, old), new Set(store.items.map((i) => i.uuid)));
  if (!bag.length) return ui.notifications.warn("Nothing else matches this store's criteria.");

  const pick = bag[Math.floor(Math.random() * bag.length)];
  await mutateStore(storeId, (st) => {
    const idx = st.items.findIndex((i) => i.uuid === uuid);
    if (idx >= 0) st.items[idx] = entry(pick, old.qty ?? 1);
  });
  ui.notifications.info(`${old.name} swapped for ${pick.name}.`);
}

async function reshuffleStore(storeId) {
  const store = getStores().find((s) => s.id === storeId);
  if (!store?.items.length) return;

  const qtys = store.items.map((i) => i.qty ?? 1);
  const bag = drawFrom(await pool(), criteriaFor(store, null), new Set());
  if (!bag.length) return ui.notifications.warn("Nothing matches this store's criteria.");

  const fresh = [];
  for (let n = 0; n < qtys.length && bag.length; n++) {
    const pick = bag.splice(Math.floor(Math.random() * bag.length), 1)[0];
    fresh.push(entry(pick, qtys[n]));
  }
  await mutateStore(storeId, (st) => (st.items = fresh));
  ui.notifications.info(`${store.name} reshuffled: ${fresh.length} new items.`);
}

async function dropItem(storeId, uuid) {
  await mutateStore(storeId, (st) => {
    st.items = st.items.filter((i) => i.uuid !== uuid);
  });
}

/** Swap and remove, for the GM, on each row of a named store. */
function addRowTools(root, store) {
  if (!game.user.isGM) return;

  root.querySelectorAll(ROW).forEach((row) => {
    const actions = row.querySelector(".crw-store-item-actions");
    const uuid = row.dataset.uuid;
    if (!actions || !uuid || actions.querySelector(".cprw-drop")) return;

    const make = (cls, icon, title, fn) => {
      const b = document.createElement("button");
      // Borrow the host's button styling so these sit correctly in the row.
      b.className = `crw-store-btn-hide ${cls}`;
      b.type = "button";
      b.title = title;
      b.innerHTML = `<i class="fas ${icon}"></i>`;
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn().catch(reportErr);
      });
      return b;
    };

    actions.append(
      make("cprw-shuffle", "fa-shuffle", "Swap this for a different item",
        () => reshuffleItem(store.id, uuid)),
      make("cprw-drop", "fa-xmark", "Remove this item from this store",
        () => dropItem(store.id, uuid))
    );
  });
}

/** One list instead of a block per compendium. */
function mergeSections(root) {
  const list = root.querySelector(".crw-store-items");
  if (!list) return;
  const rows = [...list.querySelectorAll(ROW)];
  if (rows.length < 2) return;

  list.querySelectorAll(DIVIDER).forEach((d) => d.remove());
  const nameOf = (r) =>
    r.querySelector(".crw-store-item-name")?.childNodes?.[0]?.textContent?.trim() ?? "";
  rows.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  rows.forEach((r) => list.appendChild(r));
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
          return `<option value="${s.id}" ${sel}>${esc(s.name)} — ${n} items, ${supply}, ${s.markup}%</option>`;
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
    `<button class="cprw-refresh" style="flex:0 0 auto;width:auto;" ` +
    `title="Re-read this store's items from the compendium"><i class="fas fa-arrows-rotate"></i></button>` +
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
  bar.querySelector(".cprw-refresh").addEventListener("click", (e) => {
    e.preventDefault();
    refreshItems().catch(reportErr);
  });
}

/** Set while a switch is in flight, so the markup write-back stays out of it. */
let _switching = false;

async function activate(id) {
  _switching = true;
  try {
    const wasActive = getActiveId();

    // Park the catalogue's settings the first time we leave it.
    if (id && !wasActive) {
      await game.settings.set(ID, "catalogueFilters", {
        availability: foundry.utils.deepClone(game.settings.get(CRW, "storeAvailability")),
        markup: game.settings.get(CRW, "storeMarkup"),
      });
    }

    // The host's settings are settled first. Announcing the new store before
    // its markup had landed let the re-render read the old store's markup and
    // write it onto the new one.
    if (id) {
      const store = getStores().find((s) => s.id === id);
      if (store) await game.settings.set(CRW, "storeMarkup", store.markup);
      await blankFilters();
    } else {
      await restoreCatalogue();
    }

    await game.settings.set(ID, "activeStore", id);
  } finally {
    _switching = false;
  }
  rerender();
}

/** A named store's roster is the whole filter, so nothing else may narrow it. */
async function blankFilters() {
  const a = foundry.utils.deepClone(game.settings.get(CRW, "storeAvailability"));
  a.categoryEnabled ??= {};
  for (const k of Object.keys(TYPES)) a.categoryEnabled[k] = true;
  for (const k of Object.keys(a.categoryEnabled)) a.categoryEnabled[k] = true;
  a.blockedItems = [];
  a.priceMin = 0;
  a.priceMax = 0;
  await game.settings.set(CRW, "storeAvailability", a);
}

async function restoreCatalogue() {
  const parked = game.settings.get(ID, "catalogueFilters");
  if (!parked?.availability) return;
  await game.settings.set(CRW, "storeAvailability", foundry.utils.deepClone(parked.availability));
  if (typeof parked.markup === "number") await game.settings.set(CRW, "storeMarkup", parked.markup);
  await game.settings.set(ID, "catalogueFilters", {});
}

/** Those filters are parked, so editing them here would only be overwritten. */
function lockFilterSettings(root, store) {
  if (!store) return;
  for (const sec of root.querySelectorAll(".crw-store-settings-section")) {
    const isFilter =
      sec.querySelector(".crw-store-price-range") ||
      sec.querySelector(".crw-store-category-grid") ||
      sec.querySelector('[data-action="restoreAllItems"]') ||
      sec.querySelector(".crw-store-hidden-list");
    if (!isFilter || sec.querySelector(".cprw-locked")) continue;

    sec.style.opacity = "0.4";
    sec.style.pointerEvents = "none";
    const note = document.createElement("p");
    note.className = "cprw-locked crw-store-hint";
    note.style.cssText = "font-style:italic;pointer-events:none;";
    note.textContent = `Paused while "${store.name}" is open. It shows its own item list. Switch to Full catalogue to change these.`;
    sec.prepend(note);
  }
}

/**
 * Re-reads the roster from source. Item sheets are always live, since opening
 * one fetches the document, so the only stale values are the name and price in
 * the list: the host module caches its whole item list on the window instance
 * and clears it only on close, so a fresh window is what forces the re-read.
 */
async function refreshItems() {
  _pool = null;
  const store = getActive();
  const dropped = [];

  if (store) {
    const found = new Map();
    for (const it of store.items) {
      const doc = await fromUuid(it.uuid).catch(() => null);
      if (doc) found.set(it.uuid, doc);
      else dropped.push(it.name);
    }
    await mutateStore(store.id, (st) => {
      st.items = st.items.filter((it) => {
        const doc = found.get(it.uuid);
        if (!doc) return false;
        it.name = doc.name;
        it.type = doc.type;
        it.price = doc.system?.price?.market ?? it.price;
        return true;
      });
    });
  }

  const app =
    foundry.applications?.instances?.get("crw-store") ??
    [...(foundry.applications?.instances?.values?.() ?? [])].find(
      (w) => w?.constructor?.name === "StoreApp"
    );
  if (app) {
    const Cls = app.constructor;
    await app.close();
    Cls.open();
  }

  ui.notifications.info(
    dropped.length
      ? `Refreshed. Dropped ${dropped.length} item(s) no longer in the compendium: ${dropped.join(", ")}.`
      : "Refreshed from the compendium."
  );
}

function rerender() {
  // StoreApp is an ApplicationV2, so it never appears in ui.windows.
  const open = [
    ...Object.values(ui.windows ?? {}),
    ...(foundry.applications?.instances?.values?.() ?? []),
  ];
  for (const w of open) {
    if (w?.constructor?.name === "StoreApp") w.render(true);
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
          <td>${esc(s.name)}</td>
          <td style="text-align:center">${s.items.length}</td>
          <td style="text-align:center">${stock}</td>
          <td style="text-align:center">
            <input type="number" data-markup min="0" value="${s.markup}" style="width:4.5em"/>%
          </td>
          <td style="text-align:right;white-space:nowrap">
            <a data-act="edit" title="Edit contents"><i class="fas fa-pen-to-square"></i></a>
            <a data-act="reshuffle" title="Reshuffle every item"><i class="fas fa-shuffle"></i></a>
            <a data-act="restock" title="Restock"><i class="fas fa-rotate"></i></a>
            <a data-act="rename" title="Rename"><i class="fas fa-i-cursor"></i></a>
            <a data-act="supply" title="Toggle limited/unlimited"><i class="fas fa-infinity"></i></a>
            <a data-act="delete" title="Delete"><i class="fas fa-trash"></i></a>
          </td></tr>`;
      }).join("")
    : `<tr><td colspan="5" style="opacity:.6;text-align:center">No stores yet.</td></tr>`;

  let dlg;
  dlg = new Dialog({
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
        <b>Snapshot</b> takes every item that passes the full catalogue's category,
        price and hidden-item settings. <b>Roll</b> generates a random roster.
        <b>Pick</b> opens a chooser.</p>`,
    buttons: {
      pick: { icon: '<i class="fas fa-hand-pointer"></i>', label: "Pick", callback: (h) => create(h, "pick") },
      snap: { icon: '<i class="fas fa-camera"></i>', label: "Snapshot", callback: (h) => create(h, "snap") },
      roll: { icon: '<i class="fas fa-dice"></i>', label: "Roll", callback: (h) => create(h, "roll") },
    },
    default: "pick",
    render: (h) => {
      h[0].querySelectorAll(".cprw-rows [data-markup]").forEach((inp) => {
        inp.addEventListener("change", async () => {
          const id = inp.closest("tr").dataset.id;
          const v = Math.max(0, Number(inp.value) || 0);
          await mutateStore(id, (st) => (st.markup = v));
          // If this store is live, the displayed prices have to follow it.
          if (getActiveId() === id) await game.settings.set(CRW, "storeMarkup", v);
        });
      });

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
            const wasLive = getActiveId() === id;
            await queueWrite(async () => saveStores(getStores().filter((s) => s.id !== id)));
            // activate("") is what restores the parked catalogue filters.
            if (wasLive) await activate("");
          } else if (act === "restock") {
            await mutateStore(id, (s) => s.items.forEach((i) => (i.remaining = i.qty)));
            ui.notifications.info(`${store.name} restocked.`);
          } else if (act === "rename") {
            const n = await promptText("Rename store", store.name);
            if (!n) return;
            await mutateStore(id, (s) => (s.name = n));
          } else if (act === "reshuffle") {
            await reshuffleStore(id);
          } else if (act === "supply") {
            await mutateStore(id, (s) => (s.limited = !s.limited));
          } else if (act === "edit") {
            const picked = await picker(store.items);
            if (!picked) return;
            await mutateStore(id, (s) => (s.items = picked));
          }

          rerender();
          dlg?.close();
          manage();
        });
      });
    },
  }).render(true);
}

function confirmDelete(name) {
  return Dialog.confirm({
    title: "Delete store",
    content: `<p>Delete <b>${esc(name)}</b>? This cannot be undone.</p>`,
  });
}

function promptText(title, initial = "") {
  return new Promise((resolve) => {
    new Dialog({
      title,
      content: `<input type="text" name="v" value="${esc(initial)}" style="width:100%"/>`,
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
  let criteria = null;

  if (mode === "snap") {
    items = (await pool()).filter(currentFilter()).map((i) => entry(i, 1));
    if (!items.length) return ui.notifications.warn("Nothing passes the store's current filters.");
    // Remember the shape of the snapshot so the store can be reshuffled later.
    const a = catalogueAvailability();
    criteria = {
      types: Object.keys(TYPES).filter((t) => a.categoryEnabled?.[t] !== false),
      min: a.priceMin || 0,
      max: a.priceMax || 0,
    };
  } else if (mode === "roll") {
    const rolled = await rollDialog();
    items = rolled?.items ?? null;
    criteria = rolled?.criteria ?? null;
  } else {
    items = await picker([]);
  }
  if (items && !items.length) {
    return ui.notifications.warn("No items chosen, so no store was created.");
  }
  if (!items) return;

  const store = { id: foundry.utils.randomID(12), name, markup, limited, items, criteria };
  await queueWrite(async () => saveStores([...getStores(), store]));
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
            resolve({ items: out, criteria: { types, min, max: maxRaw > 0 ? maxRaw : 0 } });
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
          // Cheapest first, so the 150-row cap shows the affordable end rather
          // than whatever order the compendiums happened to load in.
          list.sort((a, b) => (a.price - b.price) || a.name.localeCompare(b.name));
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
            (total > 150 ? `<p style="opacity:.5;text-align:center">${total - 150} more above this price, narrow the search</p>` : "") +
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

/**
 * Stock lives in a world setting, which only a GM may write. A player buying
 * something therefore has to ask a GM's client to do the decrement for them.
 */
function recordSale(storeId, uuid) {
  const decrement = (s) => {
    const it = s.items.find((i) => i.uuid === uuid);
    if (it && it.remaining > 0) it.remaining -= 1;
  };
  if (game.user.isGM) mutateStore(storeId, decrement).catch(reportErr);
  else game.socket.emit(SOCKET, { action: "buy", storeId, uuid });
}

const reportErr = (err) => console.error(`${ID} | ${err?.message ?? err}`, err);

Hooks.once("ready", () => {
  Hooks.on("createItem", (item, options, userId) => {
    if (userId !== game.user.id) return;      // only the client that bought reports it
    if (!(item.parent instanceof Actor)) return;
    const queue = pending.get(`${item.parent.id}|${item.name}`);
    if (!queue?.length) return;
    const intent = queue.shift();
    recordSale(intent.storeId, intent.uuid);
  });

  game.socket.on(SOCKET, (data) => {
    // Exactly one GM acts, otherwise every logged-in GM decrements the same sale.
    const actingGM = game.users.find((u) => u.isGM && u.active);
    if (actingGM?.id !== game.user.id) return;
    if (data?.action !== "buy") return;
    recordSale(data.storeId, data.uuid);
  });

  if (!game.users.some((u) => u.isGM && u.active) && !game.user.isGM) {
    console.warn(`${ID} | no GM online, limited-supply counts will not decrement`);
  }
});

Hooks.on("renderStoreApp", (app, element) => {
  const root = element instanceof HTMLElement ? element : element?.[0];
  if (!root) return;
  try {
    const store = getActive();
    wirePeek(root);
    injectBar(root);

    const title = root.querySelector(".window-title");
    if (title) title.textContent = store?.name ?? app.title ?? "Store";

    if (store) {
      applyStore(root, store);
      wireBuy(root, store);
      lockFilterSettings(root, store);
      // Keep the store's markup in step if the GM adjusts it while it is live
      if (game.user.isGM && !_switching) {
        const live = game.settings.get(CRW, "storeMarkup");
        if (live !== store.markup) mutateStore(store.id, (s) => (s.markup = live));
      }
    }

    if (store) addRowTools(root, store);

    // Last, so rows the store filtered out are never decorated.
    mergeSections(root);
    addIcons(root);
  } catch (err) {
    console.error(`${ID} | failed decorating the store`, err);
  }
});

console.log(`${ID} | ready`);
