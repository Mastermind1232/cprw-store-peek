const fs = require("fs");
const src = fs.readFileSync(process.argv[2] ?? new URL("../main.js", "file://" + __filename).pathname, "utf8");

const CRW = "cyberpunk-red-wizards";
const ID = "cprw-store-peek";

const hooks = {};
const Hooks = { once: (k, f) => (hooks[k] ??= []).push(f), on: (k, f) => (hooks[k] ??= []).push(f) };

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
  items: [], packs: [], socket: { on() {}, emit() {} },
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
  src + "\nreturn { activate, mutateStore, queueWrite, getStores, getActive, getActiveId, saveStores, currentFilter, esc, entry };"
)(Hooks, game, ui, foundry, {}, class {}, class {}, async () => null, { log() {}, warn() {}, error() {}, debug() {} });

hooks.init.forEach(f => f());

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

  // --- T11: deleting the live store must restore the catalogue
  await mod.queueWrite(async () => mod.saveStores(mod.getStores().filter(s => s.id !== "A")));
  await mod.activate("");
  check("T11 delete-then-restore returns filters",
    game.settings.get(CRW, "storeAvailability").priceMin === 50);

  let bad = 0;
  for (const r of results) { if (!r.pass) bad++; console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`); }
  console.log(`\n${results.length - bad}/${results.length} passed`);
  process.exit(bad ? 1 : 0);
})();
