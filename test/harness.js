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
  src + "\nreturn { activate, mutateStore, queueWrite, getStores, getActive, getActiveId, saveStores, currentFilter, esc, entry, reshuffleItem, reshuffleStore, dropItem, criteriaFor, recordSale, restoreCatalogue };"
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

  // --- T12: a swap stays inside the store's criteria and never duplicates
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
    if (added.price < 100 || added.price > 300 || added.type !== "weapon" || added.uuid === "Item.w4") {
      check("T12 swap respects criteria", false, `got ${added.uuid} @ ${added.price}`); break;
    }
    if (added.qty !== 2) { check("T12b swap keeps quantity", false, `qty=${added.qty}`); break; }
  }
  if (!results.some(r => r.name.startsWith("T12"))) {
    check("T12 swap respects criteria and keeps quantity", true, `${swaps.size} distinct results`);
  }

  // --- T13: with no criteria, a swap stays near the item's own price
  await mod.saveStores([{
    id: "D", name: "Picked", markup: 100, limited: true,
    items: [{ uuid: "Item.w6", name: "Weapon 6", type: "weapon", price: 300, qty: 1, remaining: 1 }],
  }]);
  const cr = mod.criteriaFor(mod.getStores()[0], mod.getStores()[0].items[0]);
  check("T13 fallback band is the item's own type and price range",
    cr.types.join() === "weapon" && cr.min === 150 && cr.max === 450, JSON.stringify(cr));

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

  let bad = 0;
  for (const r of results) { if (!r.pass) bad++; console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`); }
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
