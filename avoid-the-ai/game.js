const BASE_DURATION_MS = 10000;
const ADD_TIME_MS = 5000;
const MAX_DURATION_MS = 60000;
const BASE_POINTS = 10;
const COMBO_WINDOW_MS = 1000;
const BEST_SCORE_KEY = "avoid-the-ai-best-score";
const AI_TAUNTS = [
  "You can't catch me!",
  "Too slow!",
  "Nice try!",
  "Human reflex detected!",
  "Predictable cursor!",
  "Processing your moves..."
];
const SMALL_VIEWPORT_QUERY = window.matchMedia("(max-width: 700px)");

const elements = {
  appShell: document.querySelector(".app-shell"),
  gameCard: document.querySelector(".game-card"),
  arena: document.getElementById("arena"),
  aiButton: document.getElementById("aiButton"),
  aiMessage: document.getElementById("aiMessage"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayText: document.getElementById("overlayText"),
  statusToast: document.getElementById("statusToast"),
  scoreValue: document.getElementById("scoreValue"),
  timeValue: document.getElementById("timeValue"),
  comboValue: document.getElementById("comboValue"),
  bestScoreValue: document.getElementById("bestScoreValue"),
  startButton: document.getElementById("startButton"),
  restartButton: document.getElementById("restartButton"),
  addTimeButton: document.getElementById("addTimeButton"),
  shareButton: document.getElementById("shareButton"),
  // Score modal
  scoreModal: document.getElementById("scoreModal"),
  modalScore: document.getElementById("modalScore"),
  modalBest: document.getElementById("modalBest"),
  modalCombo: document.getElementById("modalCombo"),
  modalNewRecord: document.getElementById("modalNewRecord"),
  modalPlayAgain: document.getElementById("modalPlayAgain"),
  modalShare: document.getElementById("modalShare")
};

const state = {
  running: false,
  score: 0,
  combo: 1,
  peakCombo: 1,
  bestScore: Number(localStorage.getItem(BEST_SCORE_KEY)) || 0,
  gameDurationMs: BASE_DURATION_MS,
  endTime: 0,
  lastFrameTime: 0,
  lastHitTime: 0,
  lastEscapeTime: 0,
  lastTauntTime: 0,
  pointerActive: false,
  rafId: 0,
  ai: {
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0,
    width: 84,
    height: 56
  },
  pointer: {
    x: 0,
    y: 0
  }
};

class AudioManager {
  constructor() {
    this.context = null;
  }

  ensureContext() {
    // Build a tiny synth on demand so the game works without external sound files.
    if (!window.AudioContext && !window.webkitAudioContext) {
      return null;
    }

    if (!this.context) {
      const Context = window.AudioContext || window.webkitAudioContext;
      this.context = new Context();
    }

    if (this.context.state === "suspended") {
      this.context.resume();
    }

    return this.context;
  }

  play({ frequency, duration, type = "sine", volume = 0.04, rampTo }) {
    const context = this.ensureContext();

    if (!context) {
      return;
    }

    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    const startTime = context.currentTime;
    const stopTime = startTime + duration;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startTime);

    if (rampTo) {
      oscillator.frequency.exponentialRampToValueAtTime(rampTo, stopTime);
    }

    gainNode.gain.setValueAtTime(volume, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, stopTime);

    oscillator.connect(gainNode);
    gainNode.connect(context.destination);
    oscillator.start(startTime);
    oscillator.stop(stopTime);
  }

  playStart() {
    this.play({ frequency: 460, rampTo: 620, duration: 0.2, type: "triangle", volume: 0.03 });
  }

  playCatch() {
    this.play({ frequency: 740, rampTo: 980, duration: 0.14, type: "square", volume: 0.025 });
  }

  playEnd() {
    this.play({ frequency: 280, rampTo: 140, duration: 0.28, type: "sawtooth", volume: 0.03 });
  }
}

const audio = new AudioManager();

function isSmallViewport() {
  return SMALL_VIEWPORT_QUERY.matches;
}

function syncResponsiveMode() {
  document.body.classList.toggle("small-viewport", isSmallViewport());

  if (!isSmallViewport() && !document.fullscreenElement) {
    document.body.classList.remove("mobile-gameplay");
  }
}

async function requestFullscreenForGame() {
  if (!isSmallViewport()) {
    return false;
  }

  const target = document.documentElement;
  const requestFullscreen = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;

  if (!requestFullscreen || document.fullscreenElement) {
    return Boolean(document.fullscreenElement);
  }

  try {
    await requestFullscreen.call(target);
    return true;
  } catch (error) {
    return false;
  }
}

function setGameplayPresentation(active) {
  if (!isSmallViewport()) {
    document.body.classList.remove("mobile-gameplay");
    return;
  }

  document.body.classList.toggle("mobile-gameplay", active);
  elements.arena.parentElement.classList.toggle("compact", active);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function getDifficulty() {
  // Scale all escape behavior from score so the AI feels smarter over time.
  if (state.score >= 200) {
    return {
      label: "Hard",
      threshold: 185,
      speed: 0.22,
      teleportCooldown: 260,
      pointerNudge: 210
    };
  }

  if (state.score >= 100) {
    return {
      label: "Medium",
      threshold: 150,
      speed: 0.18,
      teleportCooldown: 360,
      pointerNudge: 180
    };
  }

  return {
    label: "Easy",
    threshold: 120,
    speed: 0.14,
    teleportCooldown: 520,
    pointerNudge: 150
  };
}

function updateBestScore() {
  if (state.score > state.bestScore) {
    state.bestScore = state.score;
    localStorage.setItem(BEST_SCORE_KEY, String(state.bestScore));
  }

  elements.bestScoreValue.textContent = String(state.bestScore);
}

function updateHud(timeRemainingMs = state.gameDurationMs) {
  elements.scoreValue.textContent = String(state.score);
  elements.timeValue.textContent = `${Math.max(0, timeRemainingMs / 1000).toFixed(1)}s`;
  elements.comboValue.textContent = `x${state.combo}`;
  elements.comboValue.classList.toggle("hot", state.combo >= 2);
}

function setToast(message) {
  elements.statusToast.textContent = message;
}

function showOverlay(title, message) {
  elements.overlayTitle.textContent = title;
  elements.overlayText.textContent = message;
  elements.overlay.classList.remove("hidden");
}

function hideOverlay() {
  elements.overlay.classList.add("hidden");
}

function getArenaBounds() {
  return elements.arena.getBoundingClientRect();
}

function refreshButtonSize() {
  const rect = elements.aiButton.getBoundingClientRect();
  state.ai.width = rect.width || state.ai.width;
  state.ai.height = rect.height || state.ai.height;
}

function positionAiButton() {
  elements.aiButton.style.left = `${state.ai.x}px`;
  elements.aiButton.style.top = `${state.ai.y}px`;
}

function pickTargetPosition(preferredX = null, preferredY = null) {
  const bounds = getArenaBounds();
  const maxX = bounds.width - state.ai.width;
  const maxY = bounds.height - state.ai.height;
  const targetX = preferredX === null ? randomBetween(0, maxX) : clamp(preferredX, 0, maxX);
  const targetY = preferredY === null ? randomBetween(0, maxY) : clamp(preferredY, 0, maxY);

  state.ai.targetX = targetX;
  state.ai.targetY = targetY;
}

function moveAiAwayFromPointer(difficulty) {
  const bounds = getArenaBounds();
  const centerX = state.ai.x + state.ai.width / 2;
  const centerY = state.ai.y + state.ai.height / 2;
  const dx = centerX - state.pointer.x;
  const dy = centerY - state.pointer.y;
  const magnitude = Math.hypot(dx, dy) || 1;
  const unitX = dx / magnitude;
  const unitY = dy / magnitude;
  const randomTwistX = randomBetween(-50, 50);
  const randomTwistY = randomBetween(-50, 50);

  const preferredX = centerX + unitX * difficulty.pointerNudge + randomTwistX - state.ai.width / 2;
  const preferredY = centerY + unitY * difficulty.pointerNudge + randomTwistY - state.ai.height / 2;
  const maxX = bounds.width - state.ai.width;
  const maxY = bounds.height - state.ai.height;

  pickTargetPosition(clamp(preferredX, 0, maxX), clamp(preferredY, 0, maxY));
}

function showTaunt(message) {
  elements.aiMessage.textContent = message;
  elements.aiMessage.style.left = `${state.ai.x + state.ai.width / 2}px`;
  elements.aiMessage.style.top = `${state.ai.y}px`;
  elements.aiMessage.classList.remove("hidden");

  window.clearTimeout(showTaunt.timeoutId);
  showTaunt.timeoutId = window.setTimeout(() => {
    elements.aiMessage.classList.add("hidden");
  }, 850);
}

function createScorePopup(points, x, y) {
  const popup = document.createElement("div");
  popup.className = "score-popup";
  popup.textContent = `+${points}`;
  popup.style.left = `${x}px`;
  popup.style.top = `${y}px`;
  elements.arena.appendChild(popup);

  window.setTimeout(() => popup.remove(), 900);
}

function createParticles(x, y) {
  // Short-lived DOM nodes keep the click feedback lively without heavy rendering work.
  const colors = ["#74f2ce", "#ffcf66", "#7dd3fc", "#ffffff"];

  for (let index = 0; index < 8; index += 1) {
    const particle = document.createElement("span");
    particle.className = "particle";
    particle.style.left = `${x}px`;
    particle.style.top = `${y}px`;
    particle.style.background = colors[index % colors.length];
    particle.style.setProperty("--tx", `${randomBetween(-48, 48)}px`);
    particle.style.setProperty("--ty", `${randomBetween(-48, 48)}px`);
    elements.arena.appendChild(particle);
    window.setTimeout(() => particle.remove(), 520);
  }
}

function pulseHud() {
  const hudTiles = document.querySelectorAll(".hud-tile");
  hudTiles.forEach((tile) => {
    tile.classList.remove("active");
    void tile.offsetWidth;
    tile.classList.add("active");
  });
}

function registerPointerPosition(clientX, clientY) {
  const bounds = getArenaBounds();
  state.pointerActive = true;
  state.pointer.x = clientX - bounds.left;
  state.pointer.y = clientY - bounds.top;
}

function handlePointerMove(event) {
  registerPointerPosition(event.clientX, event.clientY);
}

function handleTouchMove(event) {
  const touch = event.touches[0];

  if (!touch) {
    return;
  }

  registerPointerPosition(touch.clientX, touch.clientY);
}

function placeAiAtCenter() {
  const bounds = getArenaBounds();
  refreshButtonSize();
  state.ai.x = (bounds.width - state.ai.width) / 2;
  state.ai.y = (bounds.height - state.ai.height) / 2;
  state.ai.targetX = state.ai.x;
  state.ai.targetY = state.ai.y;
  positionAiButton();
}

function placeAiAtRandom() {
  const bounds = getArenaBounds();
  refreshButtonSize();
  state.ai.x = randomBetween(0, bounds.width - state.ai.width);
  state.ai.y = randomBetween(0, bounds.height - state.ai.height);
  state.ai.targetX = state.ai.x;
  state.ai.targetY = state.ai.y;
  positionAiButton();
}

function startGame() {
  audio.playStart();
  refreshButtonSize();
  state.running = true;
  state.score = 0;
  state.combo = 1;
  state.peakCombo = 1;
  state.lastHitTime = 0;
  state.lastEscapeTime = 0;
  state.lastTauntTime = 0;
  state.endTime = performance.now() + state.gameDurationMs;
  state.lastFrameTime = performance.now();
  elements.aiButton.classList.remove("hidden");
  elements.restartButton.disabled = false;
  elements.shareButton.disabled = true;
  elements.addTimeButton.disabled = true;
  hideScoreModal();
  hideOverlay();
  setGameplayPresentation(true);
  placeAiAtRandom();
  pickTargetPosition();
  updateHud(state.gameDurationMs);
  setToast("Catch the AI before it predicts you.");
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(gameLoop);
}

function endGame() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  elements.shareButton.disabled = false;
  elements.addTimeButton.disabled = false;
  audio.playEnd();
  const isNewRecord = state.score > state.bestScore;
  updateBestScore();
  updateHud(0);
  setToast(`Time up! Final score: ${state.score}`);
  showScoreModal(isNewRecord);
}

function handleAiCaught(event) {
  if (!state.running) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const now = performance.now();
  state.combo = state.lastHitTime && now - state.lastHitTime <= COMBO_WINDOW_MS ? clamp(state.combo + 1, 1, 3) : 1;
  state.lastHitTime = now;
  if (state.combo > state.peakCombo) state.peakCombo = state.combo;

  const points = BASE_POINTS * state.combo;
  state.score += points;
  updateBestScore();
  updateHud(state.endTime - now);
  pulseHud();

  elements.aiButton.classList.remove("shake");
  void elements.aiButton.offsetWidth;
  elements.aiButton.classList.add("shake");

  const hitX = state.ai.x + state.ai.width / 2;
  const hitY = state.ai.y + state.ai.height / 2;
  createScorePopup(points, hitX, hitY);
  createParticles(hitX, hitY);
  showTaunt(AI_TAUNTS[Math.floor(Math.random() * AI_TAUNTS.length)]);
  setToast(state.combo > 1 ? `Combo x${state.combo}! Keep clicking fast.` : "Direct hit. The AI is adapting.");
  audio.playCatch();

  pickTargetPosition();
}

function showScoreModal(isNewRecord) {
  elements.modalScore.textContent = String(state.score);
  elements.modalBest.textContent = String(state.bestScore);
  elements.modalCombo.textContent = `x${state.peakCombo}`;
  elements.modalNewRecord.classList.toggle("hidden", !isNewRecord);
  elements.scoreModal.classList.remove("hidden");
  elements.scoreModal.classList.add("entering");
  window.setTimeout(() => elements.scoreModal.classList.remove("entering"), 10);
}

function hideScoreModal() {
  elements.scoreModal.classList.add("hidden");
}

function handleAddTime() {
  if (state.running) return;
  state.gameDurationMs = Math.min(state.gameDurationMs + ADD_TIME_MS, MAX_DURATION_MS);
  updateHud(state.gameDurationMs);
  setToast(`Game time set to ${state.gameDurationMs / 1000}s.`);
  elements.addTimeButton.textContent = "+5s ✓";
  window.setTimeout(() => { elements.addTimeButton.textContent = "+5s"; }, 600);
  if (state.gameDurationMs >= MAX_DURATION_MS) {
    elements.addTimeButton.disabled = true;
  }
}

function gameLoop(now) {
  if (!state.running) {
    return;
  }

  const remaining = state.endTime - now;

  if (remaining <= 0) {
    endGame();
    return;
  }

  const difficulty = getDifficulty();
  const aiCenterX = state.ai.x + state.ai.width / 2;
  const aiCenterY = state.ai.y + state.ai.height / 2;
  const pointerDistance = state.pointerActive ? Math.hypot(aiCenterX - state.pointer.x, aiCenterY - state.pointer.y) : Infinity;

  // If the player gets close enough, the AI picks a new target away from danger.
  if (state.pointerActive && pointerDistance <= difficulty.threshold && now - state.lastEscapeTime >= difficulty.teleportCooldown) {
    moveAiAwayFromPointer(difficulty);
    state.lastEscapeTime = now;

    if (now - state.lastTauntTime >= 900) {
      showTaunt(AI_TAUNTS[Math.floor(Math.random() * AI_TAUNTS.length)]);
      state.lastTauntTime = now;
    }
  }

  if (now - state.lastEscapeTime >= difficulty.teleportCooldown * 1.6) {
    pickTargetPosition();
    state.lastEscapeTime = now;
  }

  // requestAnimationFrame keeps movement smooth while the button eases toward its target.
  state.ai.x = lerp(state.ai.x, state.ai.targetX, difficulty.speed);
  state.ai.y = lerp(state.ai.y, state.ai.targetY, difficulty.speed);
  positionAiButton();
  updateHud(remaining);

  state.rafId = requestAnimationFrame(gameLoop);
}

function buildScoreCardCanvas() {
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const W = 540;
  const H = 320;
  const canvas = document.createElement("canvas");
  canvas.width = W * DPR;
  canvas.height = H * DPR;

  const ctx = canvas.getContext("2d");
  ctx.scale(DPR, DPR);

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#07101c");
  bg.addColorStop(1, "#0b1f35");
  ctx.fillStyle = bg;
  ctx.roundRect(0, 0, W, H, 24);
  ctx.fill();

  // Teal glow blob top-right
  const glow = ctx.createRadialGradient(W * 0.82, H * 0.12, 0, W * 0.82, H * 0.12, 180);
  glow.addColorStop(0, "rgba(116,242,206,0.18)");
  glow.addColorStop(1, "rgba(116,242,206,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Border
  ctx.strokeStyle = "rgba(116,242,206,0.28)";
  ctx.lineWidth = 1.5;
  ctx.roundRect(1, 1, W - 2, H - 2, 23);
  ctx.stroke();

  // Eyebrow
  ctx.fillStyle = "#74f2ce";
  ctx.font = "700 11px 'Trebuchet MS', sans-serif";
  ctx.letterSpacing = "0.24em";
  ctx.fillText("REACTION CHALLENGE", 36, 52);

  // Title
  ctx.fillStyle = "#ecf7ff";
  ctx.font = "700 38px Impact, 'Arial Narrow Bold', sans-serif";
  ctx.letterSpacing = "0.06em";
  ctx.fillText("AVOID THE AI", 36, 100);

  // Stat tiles
  const tiles = [
    { label: "SCORE", value: String(state.score), accent: false },
    { label: "BEST", value: String(state.bestScore), accent: true },
    { label: "COMBO PEAK", value: `x${state.peakCombo}`, accent: false }
  ];
  const tileW = 140;
  const tileH = 80;
  const tileY = 136;
  const tileGap = 16;
  const startX = 36;

  tiles.forEach((tile, i) => {
    const tx = startX + i * (tileW + tileGap);

    // Tile bg
    ctx.fillStyle = tile.accent ? "rgba(116,242,206,0.1)" : "rgba(12,34,60,0.8)";
    ctx.strokeStyle = tile.accent ? "rgba(116,242,206,0.3)" : "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(tx, tileY, tileW, tileH, 14);
    ctx.fill();
    ctx.stroke();

    // Label
    ctx.fillStyle = "#9bbacf";
    ctx.font = "600 10px 'Trebuchet MS', sans-serif";
    ctx.letterSpacing = "0.14em";
    ctx.fillText(tile.label, tx + 14, tileY + 22);

    // Value
    ctx.fillStyle = tile.accent ? "#74f2ce" : "#ecf7ff";
    ctx.font = `700 ${tile.value.length > 4 ? "22" : "28"}px 'Trebuchet MS', sans-serif`;
    ctx.letterSpacing = "0";
    ctx.fillText(tile.value, tx + 14, tileY + 60);
  });

  // Tagline
  ctx.fillStyle = "#9bbacf";
  ctx.font = "14px 'Trebuchet MS', sans-serif";
  ctx.letterSpacing = "0";
  ctx.fillText("Can you beat me? 🎮", 36, H - 28);

  return canvas;
}

async function shareScore() {
  setToast("Generating score card…");

  try {
    const canvas = buildScoreCardCanvas();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], "avoid-the-ai-score.png", { type: "image/png" });

    // Web Share API with file (supported on mobile Chrome/Safari, desktop Chrome)
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: "Avoid The AI",
        text: `I scored ${state.score} in Avoid The AI! Can you beat me?`
      });
      setToast("Shared successfully!");
      return;
    }

    // Fallback: download the image
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "avoid-the-ai-score.png";
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("Score card saved as PNG — share it anywhere!");
  } catch (error) {
    if (error.name !== "AbortError") {
      setToast("Could not generate score card.");
    } else {
      setToast("Share cancelled.");
    }
  }
}


function resetForIdle() {
  state.running = false;
  state.score = 0;
  state.combo = 1;
  state.peakCombo = 1;
  state.pointerActive = false;
  state.gameDurationMs = BASE_DURATION_MS;
  elements.aiButton.classList.add("hidden");
  elements.shareButton.disabled = true;
  elements.addTimeButton.disabled = false;
  elements.addTimeButton.textContent = "+5s";
  setGameplayPresentation(false);
  updateBestScore();
  updateHud(state.gameDurationMs);
  placeAiAtCenter();
  showOverlay("Avoid The AI", `The AI will dodge your cursor. Catch it as many times as you can in ${state.gameDurationMs / 1000} seconds.`);
  setToast("Press Start Game to begin.");
}

async function handleStartRequest() {
  setGameplayPresentation(true);
  const fullscreenActivated = await requestFullscreenForGame();

  if (isSmallViewport()) {
    setToast(fullscreenActivated ? "Fullscreen mode engaged." : "Immersive mode enabled.");
  }

  startGame();
}

elements.startButton.addEventListener("click", handleStartRequest);
elements.restartButton.addEventListener("click", handleStartRequest);
elements.addTimeButton.addEventListener("click", handleAddTime);
elements.shareButton.addEventListener("click", shareScore);
elements.aiButton.addEventListener("click", handleAiCaught);
elements.aiButton.addEventListener("touchstart", handleAiCaught, { passive: false });
elements.modalPlayAgain.addEventListener("click", () => { hideScoreModal(); handleStartRequest(); });
elements.modalShare.addEventListener("click", shareScore);
elements.arena.addEventListener("pointermove", handlePointerMove);
elements.arena.addEventListener("pointerdown", handlePointerMove);
elements.arena.addEventListener("touchstart", handleTouchMove, { passive: true });
elements.arena.addEventListener("touchmove", handleTouchMove, { passive: true });
window.addEventListener("resize", () => {
  syncResponsiveMode();

  if (state.running) {
    refreshButtonSize();
    pickTargetPosition(state.ai.x, state.ai.y);
  } else {
    placeAiAtCenter();
  }
});

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !state.running) {
    setGameplayPresentation(false);
  }
});

if (typeof SMALL_VIEWPORT_QUERY.addEventListener === "function") {
  SMALL_VIEWPORT_QUERY.addEventListener("change", syncResponsiveMode);
} else {
  SMALL_VIEWPORT_QUERY.addListener(syncResponsiveMode);
}

syncResponsiveMode();
updateBestScore();
resetForIdle();