/**
 * CPR Wizards Store — Shopfront
 *
 * Decorates the Cyberpunk RED Wizards store. It does not fork or replace it;
 * every feature is additive and fails soft if the host module changes.
 *
 *   - Click an item's name to open its sheet
 *   - Named stores: a saved roster of specific items, each with a quantity
 *   - Build one by hand-picking, snapshotting the current filters, rolling,
 *     or rolling a Night Market on the core rulebook's tables
 *   - Limited or Unlimited supply, with Restock
 *   - The GM picks which store is live; players see its name and its stock
 */

const ID = "cprw-store-peek";
const CRW = "cyberpunk-red-wizards";
const SOCKET = `module.${ID}`;

function reportErr(err) {
  console.error(`${ID} |`, err);
  ui.notifications?.error(`Shopfront: ${err?.message ?? err}. See the console (F12).`);
}

/**
 * Wraps an async DOM handler. Without this a throw becomes an unhandled
 * rejection: the click appears to do nothing at all and says nothing.
 */
const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (err) { reportErr(err); }
};

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

/**
 * The book's price ladder. Every item carries a band: the system's own price
 * category when it has one, otherwise the band its base price falls in. A
 * swap only ever draws from the same band as the item it replaces.
 */
const BANDS = [
  ["free", 0], ["dirtCheap", 9], ["cheap", 10], ["everyday", 20], ["costly", 50],
  ["premium", 100], ["expensive", 500], ["veryExpensive", 1000], ["luxury", 5000],
];
function bandFor(price) {
  const n = Number(price) || 0;
  for (const [name, max] of BANDS) if (n <= max) return name;
  return "superLuxury";
}
const bandOf = (i) => i.band || bandFor(i.price);
const BAND_ORDER = [...BANDS.map((b) => b[0]), "superLuxury"];
/** The band `shift` steps up (+) or down (-) the ladder, or null past either end. */
function shiftBand(band, shift) {
  const idx = BAND_ORDER.indexOf(band);
  if (idx < 0) return null;
  const j = idx + shift;
  return j >= 0 && j < BAND_ORDER.length ? BAND_ORDER[j] : null;
}

const lite = (d) => ({
  uuid: d.uuid,
  name: d.name,
  type: d.type,
  price: d.system?.price?.market ?? 0,
  band: d.system?.price?.category || bandFor(d.system?.price?.market ?? 0),
  // Optional hints, read defensively: the system's subtype, style or quality
  // fields when they exist. The Night Market matcher falls back to names.
  sub: (d.type === "weapon" ? [d.system?.weaponType] : [d.system?.type, d.system?.style])
    .filter((x) => typeof x === "string" && x).join(" ").toLowerCase(),
  quality: String(d.system?.quality ?? "").toLowerCase(),
  foundational: d.system?.isFoundational === true,
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

  // The Items sidebar is the GM's own library, edits included. When a sidebar
  // item has the same name and type as a compendium item, the sidebar copy is
  // the one that sells and the compendium copy is left out.
  const worldKeys = new Set(game.items.filter((d) => STORE_TYPES.has(d.type)).map(twinKey));

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
    for (const d of docs) if (STORE_TYPES.has(d.type) && !worldKeys.has(twinKey(d))) out.push(lite(d));
  }

  for (const d of game.items) if (STORE_TYPES.has(d.type)) out.push(lite(d));

  _pool = out;
  return out;
}
const twinKey = (d) => `${d.type}|${d.name}`;
function resetPool() { _pool = null; }

/** Hide compendium rows that the sidebar already covers, so the catalogue shows each item once. */
function dropTwins(root) {
  const worldKeys = new Set(game.items.filter((d) => STORE_TYPES.has(d.type)).map(twinKey));
  if (!worldKeys.size) return;
  root.querySelectorAll(ROW).forEach((row) => {
    const uuid = row.dataset.uuid ?? "";
    if (!uuid.startsWith("Compendium.")) return;
    let e = null;
    try { e = fromUuidSync(uuid); } catch (err) { return; }
    if (e && worldKeys.has(twinKey(e))) row.remove();
  });
}

/** The store's own visibility rules, minus the transient search box. */
function catalogueAvailability() {
  const parked = game.settings.get(ID, "catalogueFilters");
  if (getActiveId() && parked?.availability) return parked.availability;
  return game.settings.get(CRW, "storeAvailability");
}

/** The pool minus the items the GM has hidden in the Wizards store. Rolls and swaps never touch hidden items. */
async function sellable() {
  const blocked = new Set(catalogueAvailability()?.blockedItems ?? []);
  return (await pool()).filter((i) => !blocked.has(i.uuid));
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
  uuid: i.uuid, name: i.name, type: i.type, price: i.price, band: bandOf(i), qty, remaining: qty,
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
    el.addEventListener("click", guard(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const uuid = el.closest("[data-uuid]")?.dataset?.uuid;
      if (!uuid) return;
      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc) return ui.notifications.warn("Could not find that item.");
      doc.sheet.render(true);
    }));
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

    img.addEventListener("click", guard(async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const doc = await fromUuid(uuid).catch(() => null);
      if (!doc) return ui.notifications.warn("Could not find that item.");
      doc.sheet.render(true);
    }));

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

  if (!store.items.length) {
    const list = root.querySelector(".crw-store-items");
    if (list && !list.querySelector(".cprw-empty")) {
      const note = document.createElement("p");
      note.className = "cprw-empty";
      note.style.cssText = "opacity:.6;text-align:center;padding:2em 0";
      note.textContent = game.user.isGM
        ? `"${store.name}" has no items in it. Add some from Manage Stores.`
        : "Nothing for sale right now.";
      list.appendChild(note);
    }
  }

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
const INTENT_TTL = 90 * 1000;   // long enough to answer a confirm box, short enough not to catch an unrelated item later

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
 * Swapping one item draws only from that item's own type and price band, no
 * matter how the store was built: a Premium weapon comes back as a Premium
 * weapon. Reshuffling a whole store uses what the store was built from, and
 * a hand-picked store falls back to the types it already carries.
 */
function criteriaFor(store, item) {
  if (item) return { types: [item.type], band: bandOf(item) };
  const c = store.criteria;
  if (c?.types?.length) {
    return { types: c.types, min: c.min || 0, max: c.max || Infinity };
  }
  return {
    types: [...new Set(store.items.map((i) => i.type))],
    min: 0,
    max: Infinity,
  };
}

function drawFrom(all, { types, band, min = 0, max = Infinity }, exclude) {
  return all.filter((i) => {
    if (!types.includes(i.type) || exclude.has(i.uuid)) return false;
    if (band) return bandOf(i) === band;
    return i.price >= min && i.price <= max;
  });
}

/** shift 0 swaps within the item's band; -1 or +1 swaps for the next band down or up. */
async function reshuffleItem(storeId, uuid, shift = 0) {
  const store = getStores().find((s) => s.id === storeId);
  const old = store?.items.find((i) => i.uuid === uuid);
  if (!old) return;

  const band = shift ? shiftBand(bandOf(old), shift) : bandOf(old);
  if (!band) return ui.notifications.warn(`${old.name} is already at the ${shift < 0 ? "cheapest" : "priciest"} tier.`);
  const bag = drawFrom(await sellable(), { types: [old.type], band }, new Set(store.items.map((i) => i.uuid)));
  if (!bag.length) return ui.notifications.warn(`Nothing in the ${band} band to swap ${old.name} for.`);

  const pick = bag[Math.floor(Math.random() * bag.length)];
  await mutateStore(storeId, (st) => {
    const idx = st.items.findIndex((i) => i.uuid === uuid);
    if (idx >= 0) st.items[idx] = entry(pick, old.qty ?? 1);
  });
  ui.notifications.info(`${old.name} swapped for ${pick.name} (${pick.price}eb).`);
}

async function reshuffleStore(storeId) {
  const store = getStores().find((s) => s.id === storeId);
  if (!store?.items.length) return;

  const qtys = store.items.map((i) => i.qty ?? 1);
  const bag = drawFrom(await sellable(), criteriaFor(store, null), new Set());
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

/** Foundry's drag payload, on v12 or v13. */
function dragData(ev) {
  try {
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    return TE.getDragEventData(ev);
  } catch (err) {
    try { return JSON.parse(ev.dataTransfer.getData("text/plain")); } catch (e) { return null; }
  }
}

/** Drop an item from the sidebar or a compendium onto the store window to stock it. Again to add another. */
function wireDrop(root, store) {
  if (!game.user.isGM || root.dataset.cprwDrop) return;
  root.dataset.cprwDrop = "1";
  root.addEventListener("dragover", (ev) => ev.preventDefault());
  root.addEventListener("drop", guard(async (ev) => {
    const data = dragData(ev);
    if (data?.type !== "Item" || !data.uuid) return;
    ev.preventDefault();
    const doc = await fromUuid(data.uuid);
    if (!doc) return ui.notifications.warn("Could not read that item.");
    if (doc.parent) return ui.notifications.warn("Drag it from the Items sidebar or a compendium, not off a character.");
    if (!STORE_TYPES.has(doc.type)) return ui.notifications.warn(`The store cannot sell ${doc.type} items.`);
    const live = getActive();
    if (!live) return;
    await mutateStore(live.id, (st) => {
      const have = st.items.find((i) => i.uuid === doc.uuid);
      if (have) { have.qty = (have.qty ?? 1) + 1; have.remaining = (have.remaining ?? 0) + 1; }
      else st.items.push(entry(lite(doc), 1));
    });
    ui.notifications.info(`${doc.name} added to ${live.name}.`);
  }));
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
      make("cprw-down", "fa-arrow-down", "Swap this for something one price tier cheaper",
        () => reshuffleItem(store.id, uuid, -1)),
      make("cprw-up", "fa-arrow-up", "Swap this for something one price tier pricier",
        () => reshuffleItem(store.id, uuid, +1)),
      make("cprw-shuffle", "fa-shuffle", "Swap this for a different item in the same price tier",
        () => reshuffleItem(store.id, uuid)),
      make("cprw-drop", "fa-xmark", "Remove this item from this store",
        () => dropItem(store.id, uuid))
    );
  });
}

/** The viewer's chosen sort, kept per browser. */
const SORT_KEY = `${ID}.sort`;
function sortMode() { try { return localStorage.getItem(SORT_KEY) || "price"; } catch (err) { return "price"; } }

/** One list instead of a block per compendium, in the viewer's chosen order. */
function mergeSections(root) {
  const list = root.querySelector(".crw-store-items");
  if (!list) return;
  const rows = [...list.querySelectorAll(ROW)];
  if (rows.length < 2) return;

  list.querySelectorAll(DIVIDER).forEach((d) => d.remove());
  const nameOf = (r) =>
    r.querySelector(".crw-store-item-name")?.childNodes?.[0]?.textContent?.trim() ?? "";
  const priceOf = (r) => Number((r.querySelector(BUY)?.textContent ?? "").replace(/[^\d]/g, "")) || 0;
  const byName = (a, b) => nameOf(a).localeCompare(nameOf(b));
  const mode = sortMode();
  rows.sort((a, b) => (mode === "price" ? (priceOf(b) - priceOf(a)) || byName(a, b) : byName(a, b)));
  rows.forEach((r) => list.appendChild(r));
}

/** A Sort dropdown in the store header, for everyone. */
function injectSort(root) {
  if (root.querySelector(".cprw-sort")) return;
  const header = root.querySelector(HEADER);
  if (!header) return;
  const sel = document.createElement("select");
  sel.className = "cprw-sort";
  sel.title = "Sort the list";
  sel.style.cssText = "flex:0 0 auto;width:auto;margin-left:.5em";
  sel.innerHTML = '<option value="price">Price</option><option value="name">Alphabetical</option>';
  sel.value = sortMode();
  sel.addEventListener("change", () => {
    try { localStorage.setItem(SORT_KEY, sel.value); } catch (err) { /* private mode */ }
    mergeSections(root);
  });
  header.appendChild(sel);
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

  bar.querySelector(".cprw-select").addEventListener("change", guard(async (e) => {
    await activate(e.target.value);
  }));
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
        it.band = doc.system?.price?.category || bandFor(it.price);
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
        <b>Pick</b> opens a chooser. <b>Night Market</b> rolls one on the book's tables.</p>`,
    buttons: {
      pick: { icon: '<i class="fas fa-hand-pointer"></i>', label: "Pick", callback: (h) => create(h, "pick") },
      snap: { icon: '<i class="fas fa-camera"></i>', label: "Snapshot", callback: (h) => create(h, "snap") },
      roll: { icon: '<i class="fas fa-dice"></i>', label: "Roll", callback: (h) => create(h, "roll") },
      market: { icon: '<i class="fas fa-store"></i>', label: "Night Market", callback: (h) => create(h, "market") },
    },
    default: "pick",
    render: (h) => {
      h[0].querySelectorAll(".cprw-rows [data-markup]").forEach((inp) => {
        inp.addEventListener("change", guard(async () => {
          const id = inp.closest("tr").dataset.id;
          const v = Math.max(0, Number(inp.value) || 0);
          await mutateStore(id, (st) => (st.markup = v));
          // If this store is live, the displayed prices have to follow it.
          if (getActiveId() === id) await game.settings.set(CRW, "storeMarkup", v);
        }));
      });

      h[0].querySelectorAll(".cprw-rows a").forEach((a) => {
        a.style.cssText = "cursor:pointer;margin-left:.4em";
        a.addEventListener("click", guard(async (ev) => {
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
        }));
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
  } else if (mode === "market") {
    const m = await marketDialog();
    items = m?.items ?? null;
    criteria = m?.criteria ?? null;
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
  const all = await sellable();
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
/*  Night Market generator (core rulebook tables)                      */
/* ------------------------------------------------------------------ */

/**
 * The six markets, d6 in book order. Each row is a d100 band and a spec that
 * turns the book's wording into a search of the pool. Specs:
 *   t: item type(s) the store can show   n: name regex   p: price {eq|max|min}
 *   sub: subtype/style keyword (matched against the hint field or the name)
 *   found: foundational cyberware that must come along (book rule)
 *   gm: true when the book says "GM's choice"; the row is listed for the GM
 * A row can carry several specs (any of them may match).
 */
const NM_STEPS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
const NM_CATS = {
  1: { label: "Food and Drugs", rows: [
    { label: "Canned Goods", t: "gear", n: /canned/i },
    { label: "Packaged Goods", t: "gear", n: /packaged/i },
    { label: "Frozen Goods", t: "gear", n: /frozen/i },
    { label: "Bags of Grain", t: "gear", n: /grain/i },
    { label: "Kibble Pack", t: "gear", n: /kibble/i },
    { label: "Bags of Prepak", t: "gear", n: /prepak/i },
    { label: "Street Drugs of 20eb or less", t: "gear", n: /drug/i, p: { max: 20 }, gm: true },
    { label: "Poor Quality Alcohol", t: "gear", n: /alcohol/i, p: { eq: 10 } },
    { label: "Alcohol", t: "gear", n: /alcohol/i, p: { eq: 20 } },
    { label: "Excellent Quality Alcohol", t: "gear", n: /alcohol/i, p: { eq: 100 } },
    { label: "MRE", t: "gear", n: /\bMRE\b/i },
    { label: "Live Chicken", t: "gear", n: /chicken/i },
    { label: "Live Fish", t: "gear", n: /\bfish/i },
    { label: "Fresh Fruits", t: "gear", n: /fruit/i, p: { eq: 50 } },
    { label: "Fresh Vegetables", t: "gear", n: /vegetable/i, p: { eq: 50 } },
    { label: "Root Vegetables", t: "gear", n: /root vegetable/i },
    { label: "Live Pigs", t: "gear", n: /\bpig/i },
    { label: "Exotic Fruits", t: "gear", n: /fruit/i, p: { eq: 100 } },
    { label: "Exotic Vegetables", t: "gear", n: /vegetable/i, p: { eq: 100 } },
    { label: "Street Drugs of exactly 50eb", t: "gear", n: /drug/i, p: { eq: 50 }, gm: true },
  ] },
  2: { label: "Personal Electronics", rows: [
    { label: "Agent", t: "gear", n: /^agent\b/i },
    { label: "Programs or Hardware of 100eb or less", t: ["program", "itemUpgrade"], p: { max: 100 }, sample: 4 },
    { label: "Audio Recorder", t: "gear", n: /audio recorder/i },
    { label: "Bug Detector", t: "gear", n: /bug detector/i },
    { label: "Chemical Analyzer", t: "gear", n: /chemical analy/i },
    { label: "Computer", t: "gear", n: /^computer/i },
    { label: "Cyberdeck", t: ["gear", "cyberdeck"], n: /cyberdeck/i, gm: true },
    { label: "Disposable Cell Phone", t: "gear", n: /disposable cell/i },
    { label: "Electric Guitar or Other Instrument", t: "gear", n: /guitar|instrument/i },
    { label: "Programs or Hardware of exactly 500eb", t: ["program", "itemUpgrade"], p: { eq: 500 }, sample: 4 },
    { label: "Medscanner", t: "gear", n: /medscanner/i },
    { label: "Homing Tracer", t: "gear", n: /homing tracer/i },
    { label: "Radio Communicator", t: "gear", n: /radio communicator/i },
    { label: "Techscanner", t: "gear", n: /techscanner/i },
    { label: "Smart Glasses", t: "gear", n: /smart glasses/i },
    { label: "Radar Detector", t: "gear", n: /radar detector/i },
    { label: "Scrambler/Descrambler", t: "gear", n: /scrambler/i },
    { label: "Radio Scanner/Music Player", t: "gear", n: /radio scanner|music player/i },
    { label: "Braindance Viewer", t: "gear", n: /braindance viewer/i },
    { label: "Virtuality Goggles", t: "gear", n: /virtuality goggles/i },
  ] },
  3: { label: "Weapons and Armor", rows: [
    { label: "Medium Pistol", t: "weapon", n: /medium pistol/i },
    { label: "Heavy Pistol or Very Heavy Pistol", t: "weapon", n: /heavy pistol/i },
    { label: "SMG", t: "weapon", n: /^smg\b|(?<!heavy )\bsmg\b/i },
    { label: "Heavy SMG", t: "weapon", n: /heavy smg/i },
    { label: "Shotgun", t: "weapon", n: /shotgun/i },
    { label: "Assault Rifle", t: "weapon", n: /assault rifle/i },
    { label: "Sniper Rifle", t: "weapon", n: /sniper rifle/i },
    { label: "Bows or Crossbow", t: "weapon", n: /\bbow\b|crossbow/i },
    { label: "Grenade Launcher or Rocket Launcher", t: "weapon", n: /grenade launcher|rocket launcher/i },
    { label: "Ammunition of 500eb or less", t: "ammo", p: { max: 500 }, sample: 4 },
    { label: "A Single Exotic Weapon of GM's choice", t: "weapon", n: /exotic/i, gm: true },
    { label: "Light Melee Weapon", t: "weapon", n: /light melee/i },
    { label: "Medium Melee Weapon", t: "weapon", n: /medium melee/i },
    { label: "Heavy Melee Weapon", t: "weapon", n: /(?<!very )heavy melee/i },
    { label: "Very Heavy Melee Weapon", t: "weapon", n: /very heavy melee/i },
    { label: "Armor of 100eb or less", t: "armor", p: { max: 100 }, sample: 4 },
    { label: "Armor of exactly 500eb", t: "armor", p: { eq: 500 }, sample: 4 },
    { label: "Armor of exactly 1,000eb", t: "armor", p: { eq: 1000 }, sample: 4 },
    { label: "Weapon Attachments of 100eb or less", t: "itemUpgrade", p: { max: 100 }, sample: 4 },
    { label: "Weapon Attachments of 500eb or higher", t: "itemUpgrade", p: { min: 500 }, sample: 4 },
  ] },
  4: { label: "Cyberware", rows: [
    { label: "Cybereye", t: "cyberware", n: /^cybereye$/i },
    { label: "Cyberaudio Suite", t: "cyberware", n: /^cyberaudio suite$/i },
    { label: "Neural Link", t: "cyberware", n: /^neural link$/i },
    { label: "Cyberarm", t: "cyberware", n: /^cyberarm$/i },
    { label: "Cyberleg", t: "cyberware", n: /^cyberleg$/i },
    { label: "External Cyberware of exactly 1,000eb", t: "cyberware", sub: "external", p: { eq: 1000 }, sample: 4 },
    { label: "External Cyberware of 500eb or less", t: "cyberware", sub: "external", p: { max: 500 }, sample: 4 },
    { label: "Internal Cyberware of exactly 1,000eb", t: "cyberware", sub: "internal", p: { eq: 1000 }, sample: 4 },
    { label: "Internal Cyberware of 500eb or less", t: "cyberware", sub: "internal", p: { max: 500 }, sample: 4 },
    { label: "Cybereye Option of exactly 1,000eb", t: "cyberware", sub: "cybereye", p: { eq: 1000 }, sample: 4, found: /^cybereye$/i },
    { label: "Cybereye Option of 500eb or less", t: "cyberware", sub: "cybereye", p: { max: 500 }, sample: 4, found: /^cybereye$/i },
    { label: "Cyberaudio Option of exactly 1,000eb", t: "cyberware", sub: "cyberaudio", p: { eq: 1000 }, sample: 4, found: /^cyberaudio suite$/i },
    { label: "Cyberaudio Option of 500eb or less", t: "cyberware", sub: "cyberaudio", p: { max: 500 }, sample: 4, found: /^cyberaudio suite$/i },
    { label: "Neuralware Option of exactly 1,000eb", t: "cyberware", sub: "neural", p: { eq: 1000 }, sample: 4, found: /^neural link$/i },
    { label: "Neuralware Option of 500eb or less", t: "cyberware", sub: "neural", p: { max: 500 }, sample: 4, found: /^neural link$/i },
    { label: "Cyberlimb Option of exactly 1,000eb", t: "cyberware", sub: "cyberarm|cyberleg|cyberlimb", p: { eq: 1000 }, sample: 4, found: /^cyber(arm|leg)$/i },
    { label: "Cyberlimb Option of 500eb or less", t: "cyberware", sub: "cyberarm|cyberleg|cyberlimb", p: { max: 500 }, sample: 4, found: /^cyber(arm|leg)$/i },
    { label: "Fashionware of GM's Choice", t: "cyberware", sub: "fashionware", sample: 3, gm: true },
    { label: "Borgware of GM's Choice", t: "cyberware", sub: "borgware", sample: 2, gm: true },
    { label: "Any Cyberware of GM's Choice", t: "cyberware", gm: true },
  ] },
  5: { label: "Clothing and Fashionware", rows: [
    { label: "Bag Lady Chic", t: "clothing", sub: "bag lady|bagladychic|bag_lady", sample: 4 },
    { label: "Gang Colors", t: "clothing", sub: "gang colors|gangcolors|gang_colors", sample: 4 },
    { label: "Generic Chic", t: "clothing", sub: "generic chic|genericchic|generic_chic", sample: 4 },
    { label: "Bohemian", t: "clothing", sub: "bohemian", sample: 4 },
    { label: "Leisurewear", t: "clothing", sub: "leisurewear", sample: 4 },
    { label: "Nomad Leathers", t: "clothing", sub: "nomad", sample: 4 },
    { label: "Asia Pop", t: "clothing", sub: "asia pop|asiapop|asia_pop", sample: 4 },
    { label: "Urban Flash", t: "clothing", sub: "urban flash|urbanflash|urban_flash", sample: 4 },
    { label: "Businesswear", t: "clothing", sub: "businesswear", sample: 4 },
    { label: "High Fashion", t: "clothing", sub: "high fashion|highfashion|high_fashion", sample: 4 },
    { label: "Biomonitor", t: "cyberware", n: /biomonitor/i },
    { label: "Chemskin", t: "cyberware", n: /chemskin/i },
    { label: "EMP Threading", t: "cyberware", n: /emp threading/i },
    { label: "Light Tattoo", t: "cyberware", n: /light tattoo/i },
    { label: "Shift Tacts", t: "cyberware", n: /shift tacts/i },
    { label: "Skinwatch", t: "cyberware", n: /skinwatch/i },
    { label: "Techhair", t: "cyberware", n: /techhair/i },
    { label: "Generic Chic", t: "clothing", sub: "generic chic|genericchic|generic_chic", sample: 4 },
    { label: "Leisurewear", t: "clothing", sub: "leisurewear", sample: 4 },
    { label: "Gang Colors", t: "clothing", sub: "gang colors|gangcolors|gang_colors", sample: 4 },
  ] },
  6: { label: "Survival Gear", rows: [
    { label: "Anti-Smog Breathing Mask", t: "gear", n: /anti-?smog/i },
    { label: "Auto Level Dampening Ear Protectors", t: "gear", n: /ear protectors/i },
    { label: "Binoculars", t: "gear", n: /binoculars/i },
    { label: "Carryall", t: "gear", n: /carryall/i },
    { label: "Flashlight", t: "gear", n: /flashlight/i },
    { label: "Duct Tape", t: "gear", n: /duct tape/i },
    { label: "Inflatable Bed Sleep-bag", t: "gear", n: /inflatable bed|sleep-?bag/i },
    { label: "Lock Picking Set", t: "gear", n: /lock ?pick/i },
    { label: "Handcuffs", t: "gear", n: /handcuffs/i },
    { label: "Medtech Bag", t: "gear", n: /medtech bag/i },
    { label: "Tent and Camping Equipment", t: "gear", n: /tent/i },
    { label: "Rope (60m/yds)", t: "gear", n: /^rope/i },
    { label: "Techtool", t: "gear", n: /techtool/i },
    { label: "Personal CarePak", t: "gear", n: /carepak/i },
    { label: "Radiation Suit", t: "gear", n: /radiation suit/i },
    { label: "Road Flare", t: "gear", n: /road flare/i },
    { label: "Grapple Gun", t: "gear", n: /grapple gun/i },
    { label: "Tech Bag", t: "gear", n: /tech bag/i },
    { label: "Shovel or Axe", t: "gear", n: /shovel|\baxe\b/i },
    { label: "Airhypo", t: "gear", n: /airhypo/i },
  ] },
};

/** d100 band index: 0-5 -> row 0, 6-10 -> row 1, ... 96-100 -> row 19. */
const nmRowFor = (d100) => NM_STEPS.findIndex((max) => d100 <= max);

/** Does a pool item satisfy a spec? Names are the reliable signal; hints help when present. */
function nmMatches(item, spec) {
  const types = Array.isArray(spec.t) ? spec.t : [spec.t];
  if (!types.includes(item.type)) return false;
  if (spec.p) {
    if (spec.p.eq !== undefined && item.price !== spec.p.eq) return false;
    if (spec.p.max !== undefined && item.price > spec.p.max) return false;
    if (spec.p.min !== undefined && item.price < spec.p.min) return false;
  }
  if (spec.n && !spec.n.test(item.name)) return false;
  if (spec.sub) {
    const re = new RegExp(spec.sub, "i");
    if (!re.test(item.sub || "") && !re.test(item.name)) return false;
  }
  return true;
}

/**
 * Roll a Night Market from a pool. Pure: takes its randomness so it can be
 * tested. cfg: { cats: [1..6] | null (roll two), perCat: number | null (roll
 * 1d10), maxQty, sample }. Returns { items, criteria, blanks, log }.
 */
function nightMarket(all, cfg = {}, rng = Math.random) {
  const die = (n) => 1 + Math.floor(rng() * n);
  const shuffle = (arr) => arr.map((v) => [rng(), v]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const maxQty = Math.max(1, cfg.maxQty ?? 3);
  const sampleDefault = Math.max(1, cfg.sample ?? 4);
  // Optional price window. The book's rows carry their own prices, so this
  // only narrows what may fill a row; a row nothing fits becomes a blank.
  const min = cfg.min > 0 ? cfg.min : 0;
  const max = cfg.max > 0 ? cfg.max : 0;
  if (min || max) all = all.filter((i) => (!min || i.price >= min) && (!max || i.price <= max));

  let cats = (cfg.cats ?? []).filter((c) => NM_CATS[c]);
  if (!cats.length) {
    cats = [die(6)];
    while (cats.length < 2) { const c = die(6); if (!cats.includes(c)) cats.push(c); }
  }

  const items = new Map();
  const blanks = [];
  const log = [];
  const add = (i) => { if (!items.has(i.uuid)) items.set(i.uuid, entry(i, die(maxQty))); };

  for (const c of cats) {
    const cat = NM_CATS[c];
    const count = Math.max(1, cfg.perCat ?? die(10));
    const rows = new Set();
    while (rows.size < Math.min(count, cat.rows.length)) rows.add(nmRowFor(die(100)));
    for (const r of rows) {
      const spec = cat.rows[r];
      let hits = all.filter((i) => nmMatches(i, spec));
      // A named item brings its quality variants along, as the book says.
      if (spec.n && hits.length) {
        const base = hits[0].name.replace(/\s*\((poor|excellent)[^)]*\)\s*$/i, "");
        const variants = all.filter((i) => i.type === hits[0].type && i.name.replace(/\s*\((poor|excellent)[^)]*\)\s*$/i, "") === base);
        hits = [...new Set([...hits, ...variants])];
      } else if (hits.length > (spec.sample ?? sampleDefault)) {
        hits = shuffle(hits).slice(0, spec.sample ?? sampleDefault);
      }
      if (!hits.length && spec.p?.eq !== undefined) {
        // "Exactly 1,000eb" with nothing at that price: the same family at
        // that price or less, as the GM ruled.
        const eased = { ...spec, p: { max: spec.p.eq } };
        hits = shuffle(all.filter((i) => nmMatches(i, eased))).slice(0, spec.sample ?? sampleDefault);
        if (hits.length) log.push(`${cat.label}: ${spec.label} eased to ${spec.p.eq}eb or less`);
      }
      if (!hits.length) {
        // Nothing fit the row at all: stand in one item of the row's type
        // so the roll finishes on its own. The arrows can move it afterwards.
        const types = Array.isArray(spec.t) ? spec.t : [spec.t];
        const standIns = shuffle(all.filter((i) => types.includes(i.type) && !items.has(i.uuid)));
        hits = standIns.slice(0, 1);
      }
      log.push(`${cat.label}: ${spec.label} -> ${hits.length}`);
      if (spec.gm) blanks.push({ cat: cat.label, row: spec.label, found: hits.length });
      hits.forEach(add);
      if (spec.found && hits.length) all.filter((i) => i.type === "cyberware" && spec.found.test(i.name)).forEach(add);
    }
  }

  const types = [...new Set([...items.values()].map((i) => i.type))];
  return { items: [...items.values()], criteria: { types, min, max }, blanks, log, cats };
}

async function marketDialog() {
  const all = await sellable();
  const boxes = Object.entries(NM_CATS)
    .map(([k, c]) => `<label style="display:flex;align-items:center;gap:.4em;white-space:nowrap;margin:0">
      <input type="checkbox" name="c" value="${k}" style="margin:0"/> ${c.label}</label>`)
    .join("");

  return new Promise((resolve) => {
    new Dialog({
      title: "Night Market",
      content: `
        <p><b>What is sold</b></p>
        <label><input type="radio" name="how" value="roll" checked/> Roll two categories, as the book does</label><br/>
        <label><input type="radio" name="how" value="pick"/> Use the categories ticked below</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.3em .8em;margin:.4em 0 .6em .5em">${boxes}</div>
        <hr/>
        <div class="form-group" title="How many rows of the table to roll in each category. The book rolls 1d10."><label>Rolls per category</label>
          <input type="number" name="per" placeholder="1d10" style="width:80px"/></div>
        <div class="form-group" title="Each item gets a random stock count from 1 up to this."><label>Stock per item, up to</label>
          <input type="number" name="qty" value="3" style="width:80px"/></div>
        <div class="form-group" title="When a row names a group rather than one item, such as Armor of 500eb, this many are pulled from the group."><label>Picks per group row</label>
          <input type="number" name="sample" value="4" style="width:80px"/></div>
        <div class="form-group" title="Only items priced inside this window are used. Leave blank for no limit."><label>Price, min to max</label>
          <input type="number" name="min" placeholder="any" style="width:80px"/>
          <input type="number" name="max" placeholder="any" style="width:80px"/></div>`,
      buttons: {
        go: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll it",
          callback: (h) => {
            const f = h[0];
            const how = f.querySelector('[name="how"]:checked')?.value ?? "roll";
            const cats = how === "pick" ? [...f.querySelectorAll('[name="c"]:checked')].map((i) => Number(i.value)) : null;
            if (how === "pick" && !cats.length) { ui.notifications.warn("Tick at least one category, or let it roll."); return resolve(null); }
            const perRaw = Number(f.querySelector('[name="per"]').value);
            const cfg = {
              cats,
              perCat: perRaw > 0 ? perRaw : null,
              maxQty: Math.max(1, Number(f.querySelector('[name="qty"]').value) || 3),
              sample: Math.max(1, Number(f.querySelector('[name="sample"]').value) || 4),
              min: Number(f.querySelector('[name="min"]').value) || 0,
              max: Number(f.querySelector('[name="max"]').value) || 0,
            };
            const m = nightMarket(all, cfg);
            console.log(`${ID} | Night Market`, m.log);
            if (!m.items.length) { ui.notifications.error("The rolls found nothing the compendiums can supply."); return resolve(null); }
            resolve(m);
          },
        },
        cancel: { label: "Cancel", callback: () => resolve(null) },
      },
      default: "go",
      close: () => resolve(null),
    }).render(true);
  });
}

/** Rows the compendiums could not answer, for the GM to fill by hand. */
function showBlanks(blanks) {
  const picked = blanks.filter((b) => b.found);
  const empty = blanks.filter((b) => !b.found);
  const li = (b, note) => `<li><b>${esc(b.cat)}</b>: ${esc(b.row)} ${note}</li>`;
  const content =
    (picked.length ? `<p><b>The book says "GM's choice" for these.</b> ${picked.length === 1 ? "It" : "Each"} got random picks for now; use the row buttons to swap or drop them.</p><ul>${picked.map((b) => li(b, `(${b.found} added)`)).join("")}</ul>` : "") +
    (empty.length ? `<p><b>Nothing in the compendiums fit these rows.</b> Add something by hand through Pick, or leave them empty.</p><ul>${empty.map((b) => li(b, "")).join("")}</ul>` : "");
  new Dialog({
    title: "Night Market: rows to check",
    content,
    buttons: { ok: { label: "OK" } },
    default: "ok",
  }).render(true);
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

          const keep = results.scrollTop;
          results.innerHTML =
            list.map((i) => {
              const held = chosen.get(i.uuid)?.qty ?? 0;
              return `<div style="display:flex;align-items:center;gap:.5em;padding:.15em 0${
                held ? ";font-weight:bold" : ""}">
                 <a data-add="${i.uuid}" style="cursor:pointer"><i class="fas fa-plus"></i></a>
                 <span style="flex:1">${i.name}${
                   held ? ` <span style="opacity:.7">(x${held} in store)</span>` : ""}</span>
                 <span style="opacity:.5;font-size:.85em">${TYPES[i.type] ?? i.type}</span>
                 <span style="opacity:.6;width:5em;text-align:right">${i.price}eb</span>
               </div>`;
            }).join("") +
            (total > 150 ? `<p style="opacity:.5;text-align:center">${total - 150} more above this price, narrow the search</p>` : "") +
            (total === 0 ? `<p style="opacity:.5;text-align:center">No matches</p>` : "");
          results.scrollTop = keep;

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
          drawResults();
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
              drawResults();   // keep the "(xN in store)" counts honest
            }));
        }

        typeSel.addEventListener("change", drawResults);
        search.addEventListener("input", drawResults);
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

Hooks.once("ready", () => {
  // A switch interrupted midway (browser closed, session dropped) can leave the
  // catalogue's filters parked with no store live to explain it. Put them back.
  if (game.user.isGM && !getActiveId()) {
    const parked = game.settings.get(ID, "catalogueFilters");
    if (parked?.availability) {
      console.warn(`${ID} | catalogue filters were left parked, restoring them`);
      restoreCatalogue().catch(reportErr);
    }
  }

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

    if (store) { addRowTools(root, store); wireDrop(root, store); }

    // Last, so rows the store filtered out are never decorated.
    dropTwins(root);
    mergeSections(root);
    injectSort(root);
    addIcons(root);
  } catch (err) {
    console.error(`${ID} | failed decorating the store`, err);
  }
});

console.log(`${ID} | ready`);
