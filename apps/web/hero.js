const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

const baseCost = 6420 + 4800 + 680;
const overhead = document.querySelector("#overhead");
const markup = document.querySelector("#markup");
const total = document.querySelector("#estimate-price");
let displayedTotal = 15993.6;
let animationFrame;

function animateTotal(nextTotal) {
  cancelAnimationFrame(animationFrame);
  const startTotal = displayedTotal;
  const startedAt = performance.now();
  total.classList.remove("updating");
  void total.offsetWidth;
  total.classList.add("updating");

  function tick(now) {
    const progress = Math.min((now - startedAt) / 260, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    displayedTotal = startTotal + (nextTotal - startTotal) * eased;
    total.textContent = money.format(displayedTotal);
    if (progress < 1) animationFrame = requestAnimationFrame(tick);
  }
  animationFrame = requestAnimationFrame(tick);
}

function updateEstimate() {
  const overheadRate = Number(overhead.value) / 100;
  const markupRate = Number(markup.value) / 100;
  const overheadCost = baseCost * overheadRate;
  const subtotal = baseCost + overheadCost;
  const markupCost = subtotal * markupRate;
  document.querySelector("#overhead-value").textContent = `${overhead.value}%`;
  document.querySelector("#markup-value").textContent = `${markup.value}%`;
  document.querySelector("#overhead-cost").textContent = money.format(overheadCost);
  document.querySelector("#markup-cost").textContent = money.format(markupCost);
  animateTotal(subtotal + markupCost);
}

overhead?.addEventListener("input", updateEstimate);
markup?.addEventListener("input", updateEstimate);

const planSheet = document.querySelector(".plan-sheet");
const panGroup = document.querySelector(".blueprint-pan");
const zoomOutput = document.querySelector("#zoom-level");
let zoom = 1;
let panX = 0;
let panY = 0;
let dragging = false;
let originX = 0;
let originY = 0;

function renderBlueprint() {
  panGroup.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  zoomOutput.textContent = `${Math.round(zoom * 100)}%`;
}

document.querySelector(".zoom-controls")?.addEventListener("click", (event) => {
  const action = event.target.closest("button")?.dataset.zoom;
  if (!action) return;
  if (action === "in") zoom = Math.min(1.6, zoom + 0.2);
  if (action === "out") zoom = Math.max(0.8, zoom - 0.2);
  if (action === "reset") [zoom, panX, panY] = [1, 0, 0];
  renderBlueprint();
});

planSheet?.addEventListener("pointerdown", (event) => {
  if (event.target.closest("button")) return;
  dragging = true;
  originX = event.clientX - panX;
  originY = event.clientY - panY;
  planSheet.setPointerCapture(event.pointerId);
});
planSheet?.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  panX = event.clientX - originX;
  panY = event.clientY - originY;
  renderBlueprint();
});
planSheet?.addEventListener("pointerup", () => { dragging = false; });

document.querySelector(".sheet-tabs")?.addEventListener("click", (event) => {
  const next = event.target.closest(".sheet-thumb");
  if (!next) return;
  document.querySelectorAll(".sheet-thumb").forEach((thumb) => {
    const active = thumb === next;
    thumb.classList.toggle("active", active);
    thumb.setAttribute("aria-pressed", String(active));
  });
  document.querySelector(".sheet-note").textContent = `${next.dataset.sheet === "A-101" ? "DECK PLAN" : "ELEVATION"} / ${next.dataset.sheet} · SCALE 1/4″ = 1′`;
  document.querySelector(".highlight-zone").style.opacity = next.dataset.sheet === "A-101" ? "1" : ".38";
});
