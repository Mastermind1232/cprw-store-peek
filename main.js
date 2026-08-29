/**
 * CPR Wizards Store — Item Peek
 *
 * The Wizards store already stamps every row with data-uuid, it just never
 * listens for a click. This wires the item name up to open its sheet.
 */

const CLICKABLE = ".crw-store-item-info";

function wire(element) {
  element.querySelectorAll(CLICKABLE).forEach((el) => {
    if (el.dataset.peekWired) return;
    el.dataset.peekWired = "1";
    el.style.cursor = "pointer";
    el.title = "Open item sheet";

    el.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const uuid = el.closest("[data-uuid]")?.dataset?.uuid;
      if (!uuid) return;
      try {
        const doc = await fromUuid(uuid);
        if (doc) doc.sheet.render(true);
        else ui.notifications.warn("Could not find that item.");
      } catch (err) {
        console.error("cprw-store-peek | failed to open item", uuid, err);
      }
    });
  });
}

Hooks.on("renderStoreApp", (app, element) => {
  wire(element instanceof HTMLElement ? element : element[0]);
});

console.log("cprw-store-peek | ready");
