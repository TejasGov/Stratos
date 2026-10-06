export function createUI() {
  document.querySelector("#app")!.innerHTML = `
  <div id="scene" aria-label="Three dimensional flight world"></div><div class="vignette"></div>
  <header class="topbar"><a class="brand" href="#" aria-label="Stratos home"><svg viewBox="0 0 36 36" aria-hidden="true"><path d="M18 2 33 31 18 24 3 31Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M18 11v13" stroke="currentColor" stroke-width="2"/></svg><span>STRATOS<small>AN OPEN WORLD FLIGHT EXPERIENCE</small></span></a><div class="top-right"><span class="live-dot"></span><span id="top-status">HAVEN ARCHIPELAGO</span><button class="icon-button" id="sound" aria-label="Toggle sound" title="Toggle sound">♫</button><button class="icon-button" id="settings-button" aria-label="Settings" title="Settings">⚙</button><button class="icon-button flight-only" id="pause-button" aria-label="Pause flight" title="Pause">Ⅱ</button></div></header>
  <main id="menu" class="menu"><div class="hero"><div class="eyebrow"><span></span> YOUR NEXT HORIZON AWAITS</div><h1>OPEN<br/><em>SKIES.</em></h1><p class="intro">A plane. An endless archipelago.<br/>The freedom to find your own way.</p><div class="launch-row"><button class="primary" id="start" disabled><span id="start-label">PREPARING AIRCRAFT</span><span class="arrow">↗</span></button><button class="text-button" id="controls-button">Flight controls <span>↗</span></button></div><div class="load-track"><span id="load-progress"></span></div><div class="loading-note" id="loading-note">Loading your stealth fighter…</div></div><div class="aircraft-label"><span class="small-cross">+</span><div><span class="eyebrow">YOUR AIRCRAFT</span><h3>SF–35 <span>STEALTH FIGHTER</span></h3><p>SINGLE SEAT <span>•</span> AFTERBURNER EQUIPPED</p></div></div><div class="menu-bottom"><div class="expedition"><span class="eyebrow">CHOOSE YOUR EXPEDITION</span><span class="subtle">Or take off and see where the wind takes you.</span></div><div class="route-cards"><button class="route-card" data-route="skyline"><span class="route-number">01</span><div><span class="eyebrow">CHECKPOINT CHALLENGE</span><h3>Skyline circuit <span>↗</span></h3><p>Six gates. One perfect line.</p></div><span class="route-tag">2:30</span></button><button class="route-card" data-route="coast"><span class="route-number">02</span><div><span class="eyebrow">LOW ALTITUDE CHALLENGE</span><h3>Coastal run <span>↗</span></h3><p>Stay low. Follow the coastline.</p></div><span class="route-tag">3:00</span></button><div class="discovery-card"><span class="eyebrow">A WORLD WORTH EXPLORING</span><strong id="discovery-count">00 / 05</strong><span class="subtle">landmarks discovered</span></div></div></div></main>
  <div id="hud" class="hud" aria-hidden="true"><div class="compass"><span>W</span><i></i><span id="heading">000°</span><i></i><span>E</span><small id="region">HAVEN ARCHIPELAGO</small></div><div class="reticle"><span></span><span></span><span></span></div><div class="attitude"><div id="horizon-line"></div><span>+</span></div><div class="flight-data"><div class="data-block"><span class="eyebrow">AIRSPEED</span><strong id="speed">000</strong><small>KNOTS</small></div><div class="data-divider"></div><div class="data-block"><span class="eyebrow">ALTITUDE</span><strong id="altitude">0000</strong><small>METERS ASL</small></div><div class="throttle-block"><span class="eyebrow">THRUST <b id="throttle-value">63%</b></span><div class="throttle-track"><div id="throttle-fill"></div></div><span id="flight-mode">CRUISE</span></div></div><div class="map-panel"><div class="map-header"><span class="eyebrow">NAVIGATION</span><span id="map-scale">12 KM</span></div><canvas id="map" width="216" height="216" aria-label="Navigation map"></canvas><div class="map-footer"><span id="coordinates">00.00 N / 00.00 E</span><span>◈</span></div></div><div class="flight-hints"><span><kbd>W S</kbd> PITCH</span><span><kbd>A D</kbd> BANK</span><span><kbd>SPACE</kbd> BOOST</span><span><kbd>C</kbd> CAMERA</span><span><kbd>ESC</kbd> PAUSE</span></div><div id="objective" class="objective"><span class="eyebrow">FREE FLIGHT</span><strong>The horizon is yours.</strong><p>Explore the islands and discover landmarks.</p></div><div id="waypoint" class="waypoint"><span>◇</span><small></small></div><div id="warning" class="warning" role="status"></div></div>
  <div id="toast" class="toast" role="status"><span class="toast-icon">✧</span><div><span class="eyebrow" id="toast-type">FLIGHT LOG</span><strong id="toast-message"></strong></div></div>
  <div id="pause" class="overlay" hidden><div class="pause-card"><span class="eyebrow">TAKE A BREATHER</span><h2>HOLDING<br/>PATTERN.</h2><p>Your next horizon can wait a moment.</p><button id="resume" class="primary">RESUME FLIGHT <span>↗</span></button><button id="restart" class="secondary">Restart flight</button><button id="return-menu" class="text-button">Return to flight deck</button></div></div>
  <div id="crash" class="overlay" hidden><div class="pause-card"><span class="eyebrow">FLIGHT ENDED</span><h2>A NEW<br/>BEGINNING.</h2><p>Clear skies are just one takeoff away.</p><button id="retry" class="primary">FLY AGAIN <span>↗</span></button><button id="crash-menu" class="text-button">Return to flight deck</button></div></div>
  <dialog id="settings"><form method="dialog"><div class="dialog-head"><span class="eyebrow">FLIGHT PREFERENCES</span><button aria-label="Close settings" class="icon-button">×</button></div><h2>Make it yours.</h2><label>Graphics quality<select id="quality"><option value="medium">Balanced</option><option value="low">Performance</option><option value="high">High fidelity</option></select></label><label>Pitch controls<select id="invert"><option value="normal">W climbs / S descends</option><option value="invert">W descends / S climbs</option></select></label><label>Control sensitivity<input id="sensitivity" type="range" min="0.5" max="1.6" step="0.1" value="1"/></label><label>Engine & wind<input id="audio-setting" type="checkbox" checked/></label><label>Performance readout<input id="debug-setting" type="checkbox"/></label><p class="dialog-note">Your preferences are saved on this device.</p><button class="primary">DONE <span>↗</span></button></form></dialog>
  <dialog id="controls"><form method="dialog"><div class="dialog-head"><span class="eyebrow">FLIGHT SCHOOL / 01</span><button aria-label="Close controls" class="icon-button">×</button></div><h2>Find your wings.</h2><p>Start with gentle turns. Bank into the horizon, then climb above it.</p><div class="control-list"><span><kbd>W</kbd><kbd>S</kbd> Pitch up / down</span><span><kbd>A</kbd><kbd>D</kbd> Bank left / right</span><span><kbd>Q</kbd><kbd>E</kbd> Rudder left / right</span><span><kbd>SHIFT</kbd><kbd>CTRL</kbd> Increase / decrease thrust</span><span><kbd>SPACE</kbd> Afterburner</span><span><kbd>C</kbd> Chase / forward camera</span><span><kbd>R</kbd> Restart flight</span><span><kbd>ESC</kbd> Pause</span></div><button class="primary">READY TO EXPLORE <span>↗</span></button></form></dialog>
  <div id="debug" hidden></div><div id="fatal" class="overlay" hidden><div class="pause-card"><span class="eyebrow">FLIGHT DECK NOTICE</span><h2>Unable to launch.</h2><p id="fatal-message"></p><button class="primary" onclick="location.reload()">TRY AGAIN <span>↗</span></button></div></div><footer class="menu-footer"><span>EXPLORE WITHOUT LIMITS</span><span>UNLIMITED HORIZONS <b>◆</b> LOCAL FLIGHT</span></footer>`;
  document.querySelector("#settings .dialog-note")!.insertAdjacentHTML(
    "beforebegin",
    `
    <label>Camera shake<input id="shake-setting" type="checkbox" checked/></label>
    <label>HUD scale<input id="hud-scale" type="range" min="0.8" max="1.3" step="0.1" value="1"/></label>
    <div class="binding-settings"><span class="eyebrow">COMBAT KEYS</span>${["gun", "missile", "target", "flare"].map((action) => `<label>${action === "gun" ? "Cannon" : action === "missile" ? "Missile" : action === "target" ? "Cycle target" : "Countermeasure"}<select id="bind-${action}">${["F", "X", "T", "V", "G", "H", "J", "K", "Z"].map((key) => `<option value="Key${key}">${key}</option>`).join("")}</select></label>`).join("")}</div>`,
  );
  document
    .querySelector("#controls .control-list")!
    .insertAdjacentHTML(
      "beforeend",
      `<span><kbd>B</kbd> Start / leave combat patrol</span><span><kbd>F</kbd> Cannon (hold)</span><span><kbd>X</kbd> Guided missile</span><span><kbd>T</kbd> Cycle target</span><span><kbd>V</kbd> Countermeasure</span>`,
    );
  document
    .querySelector("#controls form > p")!
    .insertAdjacentHTML(
      "afterend",
      `<p class="dialog-note">Standard gamepad: left stick flies, right stick rudder, triggers thrust; A cannon, B missile, X countermeasure, Y target, LB boost. Press B on the keyboard to start a patrol. Combat keys can be changed in Settings.</p>`,
    );
  document
    .querySelector(".hero")!
    .insertAdjacentHTML(
      "beforeend",
      `<div class="combat-launches"><span class="eyebrow">COMBAT SORTIES</span><div><button data-combat="intercept" disabled>Intercept <span>↗</span></button><button data-combat="escort" disabled>Escort <span>↗</span></button><button data-combat="strike" disabled>Ground strike <span>↗</span></button></div></div>`,
    );
  document
    .querySelector("#hud")!
    .insertAdjacentHTML(
      "beforeend",
      `<section id="combat-panel" class="combat-panel" hidden aria-label="Combat status"><span class="eyebrow" id="combat-state">COMBAT PATROL</span><strong id="combat-target">NO TARGET</strong><p id="combat-lock">Cycle target to acquire</p><div class="combat-lock-track"><span id="combat-lock-fill"></span></div><div class="combat-resources"><span>HULL <b id="combat-health">100%</b></span><span>GUN <b id="combat-gun">—</b></span><span>MSL <b id="combat-missiles">—</b></span><span>FLARES <b id="combat-flares">—</b></span></div><p id="combat-hints"></p></section><div id="target-marker" class="target-marker" hidden aria-label="Selected target"><span>◇</span><small id="target-range"></small></div><div id="hit-confirm" class="hit-confirm" hidden>✕</div>`,
    );
  document.querySelector("#crash .pause-card p")!.id = "crash-message";
  document
    .querySelector(".combat-resources")!
    .insertAdjacentHTML(
      "beforeend",
      `<span id="combat-ally" hidden>TRANSPORT <b id="combat-ally-health">100%</b></span>`,
    );
  document
    .querySelector("#settings label")!
    .insertAdjacentHTML(
      "beforebegin",
      `<label>Flight controls<select id="control-mode"><option value="assisted">Easy — direct steering & auto level</option><option value="advanced">Advanced — bank, loops & rolls</option></select></label>`,
    );
  document.querySelector(".flight-hints")!.innerHTML =
    `<span><kbd>W S</kbd> CLIMB / DESCEND</span><span><kbd>A D</kbd> <b id="flight-turn-hint">TURN</b></span><span><kbd>G</kbd> FOLLOW TARGET</span><span><kbd>SPACE</kbd> BOOST</span><span><kbd>ESC</kbd> PAUSE</span>`;
  document
    .querySelector("#combat-hints")!
    .insertAdjacentHTML(
      "afterend",
      `<button id="target-follow" class="follow-button" aria-pressed="false">G · FOLLOW TARGET</button>`,
    );
  document
    .querySelector("#hud")!
    .insertAdjacentHTML(
      "beforeend",
      `<div id="lead-marker" class="lead-marker" aria-label="Cannon lead aim point" hidden><span>⊕</span><small>AIM</small></div>`,
    );
  document.querySelector("#controls form > p")!.textContent =
    "Easy controls: A/D turns directly; release the keys to level out. W/S climbs or descends. Move the mouse over the sky to steer. Combat starts with target follow enabled; manual steering takes over.";
  document
    .querySelector("#controls .control-list")!
    .insertAdjacentHTML(
      "beforeend",
      `<span><kbd>G</kbd> Toggle target follow (Easy mode)</span><span><kbd>LEFT CLICK</kbd> Cannon</span><span><kbd>RIGHT CLICK</kbd> Missile — tap to queue while locking</span>`,
    );
  document.querySelector("#controls .dialog-note")!.textContent +=
    " The AIM circle shows where to lead your cannon shots. Advanced controls in Settings restore full aerobatics.";
}
export const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
