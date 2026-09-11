const fs = require("fs");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "..", "main.js"), "utf8");

const CRW = "cyberpunk-red-wizards";
const ID = "cprw-store-peek";

const hooks = {};
const Hooks = { once: (k, f) => (hooks[k] ??= []).push(f), on: (k, f) => (hooks[k] ??= []).push(f) };

const emitted = [];
const store = new Map();
const reg = new Map();
let writeLog = [];

const game = {
  settings: {
    register(m, k, c) { reg.set(`${m}.${k}`, c); if (!store.has(`${m}.${k}`)) store.set(`${m}.${k}`, c.default); },
    get(m, k) { return structuredClone(store.get(`${m}.${k}`)); },
    async set(m, k, v) {
      await new Promise(r => setTimeout(r, 1));           // settings writes are async
      store.set(`${m}.${k}`, structuredClone(v));
      writeLog.push(`${m}.${k}`);
      reg.get(`${m}.${k}`)?.onChange?.(v);
    },
  },
  user: { isGM: true, id: "gm1" },
  users: [{ id: "gm1", isGM: true, active: true }],
  items: [], packs: [], socket: { on() {}, emit(...a) { emitted.push(a); } },
};
const ui = { notifications: { info() {}, warn() {}, error() {} }, windows: {} };
const foundry = {
  utils: { deepClone: structuredClone, randomID: () => "id" + Math.random().toString(36).slice(2, 8) },
  applications: { instances: new Map() },
};

// Host settings, as the Wizards module would have registered them
reg.set(`${CRW}.storeAvailability`, {});
reg.set(`${CRW}.storeMarkup`, {});
reg.set(`${CRW}.storeExcludedPacks`, {});
store.set(`${CRW}.storeAvailability`, {
  categoryEnabled: { weapon: true, armor: false }, blockedItems: ["Compendium.x.y.Item.blocked"],
  priceMin: 50, priceMax: 500,
});
store.set(`${CRW}.storeMarkup`, 120);
store.set(`${CRW}.storeExcludedPacks`, {});

const mod = new Function(
  "Hooks", "game", "ui", "foundry", "document", "Dialog", "Actor", "fromUuid", "console",
  src + "\nreturn { activate, mutateStore, queueWrite, getStores, getActive, getActiveId, saveStores, currentFilter, esc, entry, reshuffleItem, reshuffleStore, dropItem, criteriaFor, recordSale, restoreCatalogue, nightMarket, nmMatches, NM_CATS, shiftBand, drawFrom, lite };"
)(Hooks, game, ui, foundry, {}, class {}, class {}, async () => null, { log() {}, warn() {}, error() {}, debug() {} });

hooks.init.forEach(f => f());

// A small world-item catalogue for the reshuffle tests
for (let i = 1; i <= 12; i++) {
  game.items.push({
    uuid: `Item.w${i}`, name: `Weapon ${i}`, type: "weapon",
    system: { price: { market: i * 50 } },
  });
}
game.items.push({ uuid: "Item.a1", name: "Vest", type: "armor", system: { price: { market: 100 } } });
// Bandmates: more Premium weapons (51-100), plus one whose system category outranks its price
game.items.push({ uuid: "Item.p1", name: "Premium 1", type: "weapon", system: { price: { market: 60 } } });
game.items.push({ uuid: "Item.p2", name: "Premium 2", type: "weapon", system: { price: { market: 80 } } });
game.items.push({ uuid: "Item.x1", name: "Odd One", type: "weapon", system: { price: { market: 100, category: "expensive" } } });

const results = [];
const check = (name, pass, detail = "") => results.push({ name, pass, detail });

(async () => {
  // Seed two stores
  await mod.saveStores([
    { id: "A", name: "Buck's Bus", markup: 100, limited: true,
      items: [{ uuid: "u1", name: "Bow", type: "weapon", price: 100, qty: 3, remaining: 3 }] },
    { id: "B", name: 'The "Fixer"', markup: 250, limited: false,
      items: [{ uuid: "u2", name: "SMG", type: "weapon", price: 500, qty: 1, remaining: 1 }] },
  ]);

  // --- T1: activating a store parks the catalogue's filters and markup
  await mod.activate("A");
  const parked = game.settings.get(ID, "catalogueFilters");
  check("T1 catalogue filters parked",
    parked?.availability?.priceMin === 50 && parked.markup === 120,
    JSON.stringify(parked?.availability?.priceMin) + "/" + parked?.markup);

  // --- T2: while a store is live the host filters are blank
  const live = game.settings.get(CRW, "storeAvailability");
  check("T2 host filters blanked while store live",
    live.priceMin === 0 && live.priceMax === 0 && live.blockedItems.length === 0 &&
    live.categoryEnabled.armor === true,
    JSON.stringify(live));

  // --- T3: markup follows the store
  check("T3 markup switched to store A", game.settings.get(CRW, "storeMarkup") === 100,
    String(game.settings.get(CRW, "storeMarkup")));

  // --- T4: snapshot still reads the PARKED filters, not the blank ones
  const f = mod.currentFilter();
  check("T4 snapshot uses parked filters",
    f({ uuid: "z", type: "weapon", price: 100 }) === true &&
    f({ uuid: "z", type: "weapon", price: 10 }) === false &&
    f({ uuid: "z", type: "armor", price: 100 }) === false &&
    f({ uuid: "Compendium.x.y.Item.blocked", type: "weapon", price: 100 }) === false);

  // --- T5: THE RACE. Switching A -> B must not write A's markup onto B.
  writeLog = [];
  await mod.activate("B");
  const b = mod.getStores().find(s => s.id === "B");
  check("T5 switching stores keeps target markup", b.markup === 250, `B.markup=${b.markup}`);
  check("T5b activeStore written last",
    writeLog.lastIndexOf(`${ID}.activeStore`) > writeLog.lastIndexOf(`${CRW}.storeMarkup`),
    writeLog.join(" > "));

  // --- T6: switching A -> B must NOT re-park (the parked copy is the catalogue's)
  const stillParked = game.settings.get(ID, "catalogueFilters");
  check("T6 parked copy survives store-to-store switch",
    stillParked?.availability?.priceMin === 50 && stillParked.markup === 120);

  // --- T7: returning to the catalogue restores everything and clears the park
  await mod.activate("");
  const back = game.settings.get(CRW, "storeAvailability");
  check("T7 filters restored", back.priceMin === 50 && back.priceMax === 500 &&
    back.blockedItems.length === 1 && back.categoryEnabled.armor === false, JSON.stringify(back));
  check("T7b markup restored", game.settings.get(CRW, "storeMarkup") === 120);
  check("T7c park cleared", !game.settings.get(ID, "catalogueFilters")?.availability);

  // --- T8: concurrent sales must not overwrite each other
  await mod.activate("A");
  await mod.mutateStore("A", s => (s.items[0].remaining = 5));
  const sales = Array.from({ length: 5 }, () =>
    mod.mutateStore("A", s => { const i = s.items[0]; if (i.remaining > 0) i.remaining -= 1; }));
  await Promise.all(sales);
  const a = mod.getStores().find(s => s.id === "A");
  check("T8 five concurrent sales all counted", a.items[0].remaining === 0,
    `remaining=${a.items[0].remaining}, expected 0`);

  // --- T9: stock never goes negative
  await Promise.all(Array.from({ length: 3 }, () =>
    mod.mutateStore("A", s => { const i = s.items[0]; if (i.remaining > 0) i.remaining -= 1; })));
  check("T9 oversell floors at zero",
    mod.getStores().find(s => s.id === "A").items[0].remaining === 0);

  // --- T10: quote in a store name cannot break the dialog markup
  check("T10 name escaping", mod.esc('The "Fixer" <b>') === "The &quot;Fixer&quot; &lt;b&gt;",
    mod.esc('The "Fixer" <b>'));

  // --- T12: a swap stays inside the item's own price band, whatever the store's criteria say
  await mod.saveStores([{
    id: "C", name: "Rolled", markup: 100, limited: true,
    criteria: { types: ["weapon"], min: 100, max: 300 },
    items: [
      { uuid: "Item.w2", name: "Weapon 2", type: "weapon", price: 100, qty: 2, remaining: 2 },
      { uuid: "Item.w4", name: "Weapon 4", type: "weapon", price: 200, qty: 1, remaining: 1 },
    ],
  }]);
  let swaps = new Set();
  for (let n = 0; n < 30; n++) {
    await mod.saveStores(mod.getStores().map(s => s.id === "C"
      ? { ...s, items: [{ uuid: "Item.w2", name: "Weapon 2", type: "weapon", price: 100, qty: 2, remaining: 2 },
                        { uuid: "Item.w4", name: "Weapon 4", type: "weapon", price: 200, qty: 1, remaining: 1 }] } : s));
    await mod.reshuffleItem("C", "Item.w2");
    const c = mod.getStores().find(s => s.id === "C");
    const added = c.items.find(i => i.uuid !== "Item.w4");
    swaps.add(added.uuid);
    if (added.band !== "premium" || added.price < 51 || added.price > 100 || added.type !== "weapon" ||
        added.uuid === "Item.w4" || added.uuid === "Item.w2" || added.uuid === "Item.x1") {
      check("T12 swap stays in the item's band", false, `got ${added.uuid} @ ${added.price} (${added.band})`); break;
    }
    if (added.qty !== 2) { check("T12b swap keeps quantity", false, `qty=${added.qty}`); break; }
  }
  if (!results.some(r => r.name.startsWith("T12"))) {
    check("T12 swap stays in the item's band and keeps quantity", true, `${swaps.size} distinct results`);
  }

  // --- T13: a swap's criteria are the item's own type and exact band, even for old rows with no band
  await mod.saveStores([{
    id: "D", name: "Picked", markup: 100, limited: true,
    items: [{ uuid: "Item.w6", name: "Weapon 6", type: "weapon", price: 300, qty: 1, remaining: 1 }],
  }]);
  const cr = mod.criteriaFor(mod.getStores()[0], mod.getStores()[0].items[0]);
  check("T13 swap criteria are the item's type and exact band",
    cr.types.join() === "weapon" && cr.band === "expensive" && cr.min === undefined, JSON.stringify(cr));
  // T13b: the system's own category wins over the ladder; a store-wide reshuffle still uses the store's criteria
  const odd = mod.entry({ uuid: "Item.x1", name: "Odd One", type: "weapon", price: 100, band: "expensive" }, 1);
  const crStore = mod.criteriaFor({ criteria: { types: ["weapon"], min: 100, max: 300 }, items: [] }, null);
  check("T13b category beats ladder; store reshuffle keeps store criteria",
    odd.band === "expensive" && crStore.band === undefined && crStore.min === 100 && crStore.max === 300,
    JSON.stringify({ odd: odd.band, crStore }));

  // --- T14: reshuffle all keeps the count and the quantities
  await mod.saveStores([{
    id: "E", name: "Roll2", markup: 100, limited: true,
    criteria: { types: ["weapon"], min: 0, max: 0 },
    items: [
      { uuid: "Item.w1", name: "W1", type: "weapon", price: 50, qty: 3, remaining: 1 },
      { uuid: "Item.w2", name: "W2", type: "weapon", price: 100, qty: 2, remaining: 2 },
      { uuid: "Item.w3", name: "W3", type: "weapon", price: 150, qty: 1, remaining: 0 },
    ],
  }]);
  await mod.reshuffleStore("E");
  const e = mod.getStores().find(s => s.id === "E");
  check("T14 reshuffle all keeps count and quantities",
    e.items.length === 3 && e.items.map(i => i.qty).join() === "3,2,1" &&
    e.items.every(i => i.type === "weapon") &&
    new Set(e.items.map(i => i.uuid)).size === 3,
    JSON.stringify(e.items.map(i => `${i.uuid}:${i.qty}`)));
  check("T14b reshuffle refills stock", e.items.every(i => i.remaining === i.qty));

  // --- T15: removing an item takes out only that one
  await mod.dropItem("E", e.items[1].uuid);
  const e2 = mod.getStores().find(s => s.id === "E");
  check("T15 remove drops exactly one", e2.items.length === 2 &&
    !e2.items.some(i => i.uuid === e.items[1].uuid));

  // --- T16: a player must never write world state, only ask a GM to
  await mod.saveStores([{ id: "P", name: "Shop", markup: 100, limited: true,
    items: [{ uuid: "Item.w1", name: "W1", type: "weapon", price: 50, qty: 2, remaining: 2 }] }]);
  emitted.length = 0;
  game.user.isGM = false;
  mod.recordSale("P", "Item.w1");
  await new Promise(r => setTimeout(r, 20));
  const untouched = mod.getStores().find(s => s.id === "P").items[0].remaining;
  check("T16 player emits instead of writing",
    untouched === 2 && emitted.length === 1 && emitted[0][1]?.action === "buy",
    `remaining=${untouched}, emits=${emitted.length}`);
  game.user.isGM = true;
  mod.recordSale("P", "Item.w1");
  await new Promise(r => setTimeout(r, 20));
  check("T16b GM writes directly",
    mod.getStores().find(s => s.id === "P").items[0].remaining === 1);

  // --- T17: stranded catalogue filters can be recovered
  await game.settings.set(ID, "catalogueFilters",
    { availability: { categoryEnabled: { weapon: false }, blockedItems: [], priceMin: 7, priceMax: 9 }, markup: 42 });
  await game.settings.set(ID, "activeStore", "");
  await mod.restoreCatalogue();
  check("T17 stranded filters restored",
    game.settings.get(CRW, "storeAvailability").priceMin === 7 &&
    game.settings.get(CRW, "storeMarkup") === 42 &&
    !game.settings.get(ID, "catalogueFilters")?.availability);

  // --- T11: deleting the live store must still restore the catalogue.
  // Self-contained: records the state going in, so it does not depend on
  // whatever the tests above left behind.
  const before = game.settings.get(CRW, "storeAvailability");
  const beforeMarkup = game.settings.get(CRW, "storeMarkup");
  await mod.saveStores([{ id: "Z", name: "Doomed", markup: 300, limited: false,
    items: [{ uuid: "Item.w1", name: "W1", type: "weapon", price: 50, qty: 1, remaining: 1 }] }]);
  await mod.activate("Z");
  const blanked = game.settings.get(CRW, "storeAvailability").priceMin === 0;
  await mod.queueWrite(async () => mod.saveStores(mod.getStores().filter(s => s.id !== "Z")));
  await mod.activate("");                       // what the delete handler does
  const after = game.settings.get(CRW, "storeAvailability");
  check("T11 delete-then-restore returns filters",
    blanked &&
    after.priceMin === before.priceMin && after.priceMax === before.priceMax &&
    game.settings.get(CRW, "storeMarkup") === beforeMarkup,
    `blanked=${blanked} before=${before.priceMin}/${before.priceMax} after=${after.priceMin}/${after.priceMax}`);

  // --- T18: Night Market generator, on a synthetic pool with a seeded rng
  const nmPool = [
    { uuid: "W.mp", name: "Medium Pistol", type: "weapon", price: 50, band: "costly", sub: "mediumpistol", quality: "standard" },
    { uuid: "W.mpp", name: "Medium Pistol (Poor)", type: "weapon", price: 20, band: "everyday", sub: "mediumpistol", quality: "poor" },
    { uuid: "W.mpe", name: "Medium Pistol (Excellent)", type: "weapon", price: 500, band: "expensive", sub: "mediumpistol", quality: "excellent" },
    { uuid: "W.hp", name: "Heavy Pistol", type: "weapon", price: 100, band: "premium", sub: "heavypistol" },
    { uuid: "W.smg", name: "SMG", type: "weapon", price: 100, band: "premium", sub: "smg" },
    { uuid: "W.hsmg", name: "Heavy SMG", type: "weapon", price: 100, band: "premium", sub: "heavysmg" },
    { uuid: "W.sg", name: "Shotgun", type: "weapon", price: 500, band: "expensive", sub: "shotgun" },
    { uuid: "W.ar", name: "Assault Rifle", type: "weapon", price: 500, band: "expensive", sub: "assaultrifle" },
    { uuid: "W.lm", name: "Light Melee Weapon", type: "weapon", price: 50, band: "costly", sub: "lightmelee" },
    { uuid: "W.hm", name: "Heavy Melee Weapon", type: "weapon", price: 100, band: "premium", sub: "heavymelee" },
    { uuid: "W.vhm", name: "Very Heavy Melee Weapon", type: "weapon", price: 100, band: "premium", sub: "veryheavymelee" },
    { uuid: "A.1", name: "Kevlar", type: "armor", price: 100, band: "premium", sub: "" },
    { uuid: "A.2", name: "Light Armorjack", type: "armor", price: 100, band: "premium", sub: "" },
    { uuid: "A.3", name: "Heavy Armorjack", type: "armor", price: 500, band: "expensive", sub: "" },
    { uuid: "M.1", name: "Basic Ammunition (Medium Pistol)", type: "ammo", price: 10, band: "cheap", sub: "" },
    { uuid: "M.2", name: "Basic Ammunition (Shotgun)", type: "ammo", price: 10, band: "cheap", sub: "" },
    { uuid: "C.eye", name: "Cybereye", type: "cyberware", price: 100, band: "premium", sub: "cybereye", foundational: true },
    { uuid: "C.opt", name: "Image Enhance", type: "cyberware", price: 500, band: "expensive", sub: "cybereye" },
    { uuid: "C.opt2", name: "Low Light / Infrared / UV", type: "cyberware", price: 500, band: "expensive", sub: "cybereye" },
    { uuid: "G.agent", name: "Agent", type: "gear", price: 100, band: "premium", sub: "" },
    { uuid: "G.flash", name: "Flashlight", type: "gear", price: 20, band: "everyday", sub: "" },
  ];
  // deterministic rng
  let seed = 7; const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

  // (a) forced category 3, every row, small stock
  const m3 = mod.nightMarket(nmPool, { cats: [3], perCat: 20, maxQty: 3, sample: 2 }, rng);
  const ids3 = m3.items.map(i => i.uuid);
  check("T18 market draws only from the rolled category's types and never duplicates",
    m3.items.every(i => ["weapon", "armor", "ammo", "itemUpgrade"].includes(i.type)) &&
    new Set(ids3).size === ids3.length && m3.cats.join() === "3",
    JSON.stringify(ids3));
  check("T18b quantities stay within 1..max and stock starts full",
    m3.items.every(i => i.qty >= 1 && i.qty <= 3 && i.remaining === i.qty));
  check("T18c a named weapon brings its quality variants",
    ["W.mp", "W.mpp", "W.mpe"].every(u => ids3.includes(u)), JSON.stringify(ids3));
  check("T18d class rows are sampled to the limit",
    m3.items.filter(i => i.type === "armor" && i.price <= 100).length <= 2);
  check("T18e GM's-choice rows are noted; rows nothing fit get a stand-in of their type instead of a blank",
    m3.blanks.some(b => /Exotic/.test(b.row)) && !m3.blanks.some(b => /Sniper/.test(b.row)) &&
    m3.log.some(l => /Sniper.*-> 1$/.test(l)),
    JSON.stringify(m3.blanks.map(b => b.row)) + " " + JSON.stringify(m3.log.filter(l => /Sniper/.test(l))));
  check("T18f criteria carry the types found so a store reshuffle works",
    m3.criteria.types.includes("weapon") && m3.criteria.min === 0 && m3.criteria.max === 0);

  // (b) rolled categories: exactly two, distinct, and only those
  const seen = new Set();
  for (let n = 0; n < 40; n++) {
    const m = mod.nightMarket(nmPool, { perCat: 1 }, rng);
    if (m.cats.length !== 2 || m.cats[0] === m.cats[1]) { check("T18g rolls two distinct categories", false, JSON.stringify(m.cats)); break; }
    m.cats.forEach(c => seen.add(c));
  }
  if (!results.some(r => r.name.startsWith("T18g"))) check("T18g rolls two distinct categories", true, `saw ${[...seen].sort().join(",")}`);

  // (c) a cybereye option brings the Cybereye foundational along
  const m4 = mod.nightMarket(nmPool, { cats: [4], perCat: 20, maxQty: 1 }, rng);
  const ids4 = m4.items.map(i => i.uuid);
  check("T18h a cybereye option brings its foundational",
    (ids4.includes("C.opt") || ids4.includes("C.opt2")) && ids4.includes("C.eye"), JSON.stringify(ids4));

  // (d) matcher edge: "SMG" does not match "Heavy SMG"; "Heavy Melee" does not match "Very Heavy Melee"
  const smgRow = mod.NM_CATS[3].rows[2], hmRow = mod.NM_CATS[3].rows[13];
  check("T18i name regexes keep SMG and Heavy Melee distinct from their heavier cousins",
    mod.nmMatches(nmPool[4], smgRow) && !mod.nmMatches(nmPool[5], smgRow) &&
    mod.nmMatches(nmPool[9], hmRow) && !mod.nmMatches(nmPool[10], hmRow));

  const mw = mod.nightMarket(nmPool, { cats: [3, 4], perCat: 20, maxQty: 1, sample: 9, min: 500, max: 1000 }, rng);
  check("T18j a price window keeps every item inside it and records it for swaps",
    mw.items.length > 0 && mw.items.every(i => i.price >= 500 && i.price <= 1000) &&
    mw.criteria.min === 500 && mw.criteria.max === 1000,
    JSON.stringify(mw.items.map(i => [i.uuid, i.price])));
  const mn = mod.nightMarket(nmPool, { cats: [3], perCat: 20, maxQty: 1, sample: 9 }, rng);
  check("T18k no window means no filtering", mn.items.some(i => i.price < 500) && mn.criteria.min === 0 && mn.criteria.max === 0);

  check("T19 band ladder steps one tier and stops at the ends",
    mod.shiftBand("expensive", -1) === "premium" && mod.shiftBand("expensive", 1) === "veryExpensive" &&
    mod.shiftBand("veryExpensive", 1) === "luxury" && mod.shiftBand("free", -1) === null && mod.shiftBand("superLuxury", 1) === null);
  check("T19b a tier-down draw returns only the cheaper band of the same type",
    mod.drawFrom(nmPool, { types: ["cyberware"], band: mod.shiftBand("expensive", -1) }, new Set()).every(i => i.band === "premium" && i.type === "cyberware"));
  check("T19c cyberware subtype hint comes from system.type, not the junk weaponType",
    mod.lite({ uuid: "x", name: "Pain Editor", type: "cyberware", system: { price: { market: 1000 }, weaponType: "assaultRifle", type: "neuralWare" } }).sub === "neuralware" &&
    mod.lite({ uuid: "y", name: "SMG", type: "weapon", system: { price: { market: 100 }, weaponType: "smg" } }).sub === "smg" &&
    mod.lite({ uuid: "z", name: "Jacket", type: "clothing", system: { price: { market: 100 }, type: "jacket", style: "bagLadyChic" } }).sub === "jacket bagladychic");

  {
    // "Cybereye Option of exactly 1,000eb": the pool has none at 1,000, so it eases to 1,000 or less within the family.
    const spec = mod.NM_CATS[4].rows.find(r => /Cybereye Option of exactly/.test(r.label));
    const eyePool = nmPool.filter(i => i.type === "cyberware");
    const m = mod.nightMarket(eyePool, { cats: [4], perCat: 20, maxQty: 1, sample: 9 }, rng);
    check("T20 an 'exactly' row with no match eases to 'or less' in the same family before any stand-in",
      spec && m.log.some(l => /Cybereye Option of exactly 1,000eb eased to 1000eb or less/.test(l)) &&
      m.items.some(i => ["C.eye", "C.opt", "C.opt2"].includes(i.uuid) && i.price <= 1000),
      JSON.stringify(m.log.filter(l => /Cybereye Option/.test(l))));
  }

  {
    // Hidden items never come back through a swap.
    const avail = game.settings.get(CRW, "storeAvailability");
    avail.blockedItems = ["Item.p1"];   // Premium 1 is hidden; Premium 2 and Weapon 2 remain
    await game.settings.set(CRW, "storeAvailability", avail);
    const st = { id: "hid", name: "Hid", markup: 100, limited: true, items: [mod.entry({ uuid: "Item.w2", name: "Weapon 2", type: "weapon", price: 100 })] };
    await mod.saveStores([...mod.getStores(), st]);
    let picked = new Set();
    for (let k = 0; k < 25; k++) {
      await mod.reshuffleItem("hid", mod.getStores().find(s => s.id === "hid").items[0].uuid);
      picked.add(mod.getStores().find(s => s.id === "hid").items[0].uuid);
    }
    const blocked = new Set(avail.blockedItems);
    check("T21 swaps never draw a hidden item", picked.has("Item.p2") && [...picked].every(u => !blocked.has(u)), JSON.stringify([...picked]));
    avail.blockedItems = [];
    await game.settings.set(CRW, "storeAvailability", avail);
  }

  let bad = 0;
  for (const r of results) { if (!r.pass) bad++; console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`); }
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
