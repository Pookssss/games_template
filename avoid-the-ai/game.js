const GAME_DURATION_MS = 10000;
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
  shareButton: document.getElementById("shareButton")
};

const state = {
  running: false,
  score: 0,
  combo: 1,
  bestScore: Number(localStorage.getItem(BEST_SCORE_KEY)) || 0,
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

function updateHud(timeRemainingMs = GAME_DURATION_MS) {
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
  elements.aiButton.style.transform = `translate3d(${state.ai.x}px, ${state.ai.y}px, 0)`;
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

function startGame() {
  audio.playStart();
  refreshButtonSize();
  state.running = true;
  state.score = 0;
  state.combo = 1;
  state.lastHitTime = 0;
  state.lastEscapeTime = 0;
  state.lastTauntTime = 0;
  state.endTime = performance.now() + GAME_DURATION_MS;
  state.lastFrameTime = performance.now();
  elements.aiButton.classList.remove("hidden");
  elements.restartButton.disabled = false;
  elements.shareButton.disabled = true;
  hideOverlay();
  setGameplayPresentation(true);
  placeAiAtCenter();
  pickTargetPosition();
  updateHud(GAME_DURATION_MS);
  setToast("Catch the AI before it predicts you.");
  cancelAnimationFrame(state.rafId);
  state.rafId = requestAnimationFrame(gameLoop);
}

function endGame() {
  state.running = false;
  cancelAnimationFrame(state.rafId);
  elements.shareButton.disabled = false;
  audio.playEnd();
  updateBestScore();
  updateHud(0);
  setToast(`Time up. Final score: ${state.score}`);
  showOverlay("Run Complete", `Final score: ${state.score}. Best score: ${state.bestScore}. Try to beat the smarter AI.`);
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

async function shareScore() {
  const shareText = `I scored ${state.score} in Avoid The AI! Can you beat me?`;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(shareText);
    } else {
      const helper = document.createElement("textarea");
      helper.value = shareText;
      helper.setAttribute("readonly", "true");
      helper.style.position = "absolute";
      helper.style.left = "-9999px";
      document.body.appendChild(helper);
      helper.select();
      document.execCommand("copy");
      helper.remove();
    }

    setToast("Score copied to clipboard.");
  } catch (error) {
    setToast("Clipboard is unavailable in this browser context.");
  }
}

function resetForIdle() {
  state.running = false;
  state.score = 0;
  state.combo = 1;
  state.pointerActive = false;
  elements.aiButton.classList.add("hidden");
  elements.shareButton.disabled = true;
  setGameplayPresentation(false);
  updateBestScore();
  updateHud(GAME_DURATION_MS);
  placeAiAtCenter();
  showOverlay("Avoid The AI", "The AI will dodge your cursor. Catch it as many times as you can in 10 seconds.");
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
elements.shareButton.addEventListener("click", shareScore);
elements.aiButton.addEventListener("click", handleAiCaught);
elements.aiButton.addEventListener("touchstart", handleAiCaught, { passive: false });
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