(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ROUND = 30;

  // Difficulty settings: interval = spawn gap (ms), visible = time mole stays up (ms), perSpawn = moles per wave
  const DIFFICULTIES = {
    easy:   { interval: 1500, visible: 1200, perSpawn: 1 },
    medium: { interval: 900,  visible: 800,  perSpawn: 1 },
    hard:   { interval: 500,  visible: 400,  perSpawn: 2 },
  };
  let difficulty = 'medium';

  let score = 0, best = 0, running = false, endAt = 0, spawnTimer, clockTimer, streak = 0, lastHit = 0;
  let sound = false, audioContext;
  try { best = Number(localStorage.getItem('mole-meadow-best')) || 0; } catch {}
  const format = n => String(n).padStart(3, '0');
  $('best').textContent = format(best);
  const moleSVG = `<svg class="mole" viewBox="0 0 100 120" aria-hidden="true"><defs><radialGradient id="fur"><stop stop-color="#b19473"/><stop offset="1" stop-color="#806348"/></radialGradient></defs><ellipse cx="24" cy="33" rx="12" ry="14" fill="#806348"/><ellipse cx="76" cy="33" rx="12" ry="14" fill="#806348"/><ellipse cx="24" cy="34" rx="6" ry="8" fill="#c79584"/><ellipse cx="76" cy="34" rx="6" ry="8" fill="#c79584"/><path d="M17 115V62Q14 24 43 20L39 13 49 18 53 9 58 20Q86 23 84 62V115" fill="url(#fur)"/><ellipse cx="50" cy="88" rx="25" ry="30" fill="#c1a583"/><ellipse cx="36" cy="48" rx="4.6" ry="6" fill="#302a24"/><ellipse cx="65" cy="48" rx="4.6" ry="6" fill="#302a24"/><circle cx="37" cy="46" r="1.5" fill="white"/><circle cx="66" cy="46" r="1.5" fill="white"/><ellipse cx="30" cy="62" rx="8" ry="5" fill="#c68b79" opacity=".7"/><ellipse cx="72" cy="62" rx="8" ry="5" fill="#c68b79" opacity=".7"/><ellipse cx="50" cy="60" rx="15" ry="10" fill="#d6bca0"/><ellipse cx="50" cy="56" rx="7" ry="5" fill="#5c4036"/><path d="M50 61v5m-7-2q7 9 14 0" fill="none" stroke="#664638" stroke-width="2" stroke-linecap="round"/><ellipse cx="20" cy="91" rx="12" ry="7" fill="#b29372"/><ellipse cx="80" cy="91" rx="12" ry="7" fill="#b29372"/></svg>`;
  const holes = Array.from({ length: 9 }, (_, index) => {
    const button = document.createElement('button');
    button.className = 'hole'; button.innerHTML = moleSVG;
    // Gradients have document-wide IDs, so give every critter its own.
    button.innerHTML = button.innerHTML.replaceAll('id="fur"', `id="fur-${index}"`).replaceAll('url(#fur)', `url(#fur-${index})`);
    button.setAttribute('aria-label', `Hole ${index + 1}`);
    button.addEventListener('click', () => hit(button));
    $('garden').append(button);
    return button;
  });
  function tone(frequency, length = .08) {
    if (!sound || !audioContext) return;
    const osc = audioContext.createOscillator(), gain = audioContext.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(frequency, audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(frequency / 2, audioContext.currentTime + length);
    gain.gain.setValueAtTime(.12, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + length);
    osc.connect(gain).connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + length);
  }
  function hide(hole) {
    clearTimeout(hole.hideTimer); hole.classList.remove('up', 'hit');
    hole.setAttribute('aria-label', `Hole ${holes.indexOf(hole) + 1}`);
  }
  function hit(hole) {
    if (!running || performance.now() >= endAt) return;
    if (!hole.classList.contains('up') || hole.classList.contains('hit')) {
      streak = 0; $('combo').textContent = 'STEADY NOW. WATCH THE HOLES.'; return;
    }
    const now = performance.now(); streak = now - lastHit < 1800 ? streak + 1 : 1; lastHit = now;
    const multiplier = Math.min(3, Math.floor((streak - 1) / 3) + 1), points = 10 * multiplier;
    score += points; $('score').textContent = format(score);
    $('combo').textContent = multiplier > 1 ? `${multiplier}\u00d7 COMBO \u00b7 NICE BONKING!` : 'NICE BONK! KEEP IT GOING';
    hole.classList.add('hit'); clearTimeout(hole.hideTimer); tone(420 + multiplier * 140);
    const label = document.createElement('span'); label.className = 'hit-points'; label.textContent = `+${points}`;
    hole.append(label); setTimeout(() => label.remove(), 650);
    hole.hideTimer = setTimeout(() => hide(hole), 180);
  }
  function spawn() {
    if (!running) return;
    const elapsed = ROUND - Math.max(0, (endAt - performance.now()) / 1000);
    const cfg = DIFFICULTIES[difficulty];
    // Speed ramps up 30% over the course of the round
    const speedFactor = 1 - (elapsed / ROUND) * 0.3;
    const visibleMs = cfg.visible * speedFactor;
    const intervalMs = cfg.interval * speedFactor;
    const available = holes.filter(h => !h.classList.contains('up'));
    const count = Math.min(cfg.perSpawn, available.length);
    // Shuffle available holes and pop `count` of them
    for (let i = available.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [available[i], available[j]] = [available[j], available[i]];
    }
    for (let i = 0; i < count; i++) {
      const hole = available[i];
      hole.classList.add('up'); hole.setAttribute('aria-label', 'Whack this mole!');
      hole.hideTimer = setTimeout(() => { if (!hole.classList.contains('hit')) streak = 0; hide(hole); }, visibleMs);
    }
    spawnTimer = setTimeout(spawn, intervalMs);
  }
  function setDifficulty(d) {
    if (running) return;
    difficulty = d;
    document.querySelectorAll('.difficulty-btn').forEach(btn => {
      const active = btn.dataset.difficulty === d;
      btn.setAttribute('aria-pressed', String(active));
    });
  }
  function finish() {
    running = false; clearTimeout(spawnTimer); clearInterval(clockTimer); holes.forEach(hide);
    // Re-enable difficulty buttons
    document.querySelectorAll('.difficulty-btn').forEach(btn => { btn.disabled = false; });
    $('time').textContent = '0'; $('restart').disabled = true;
    const newBest = score > best;
    if (newBest) { best = score; try { localStorage.setItem('mole-meadow-best', String(best)); } catch {} }
    const diffLabel = difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
    $('best').textContent = format(best);
    $('overlay-label').textContent = newBest ? 'A NEW PERSONAL BEST' : 'THAT\u2019S A WRAP';
    $('overlay-title').textContent = score ? 'Beautifully bonked.' : 'The moles got away.';
    $('overlay-copy').textContent = `You scored ${score} points on ${diffLabel}. ${newBest ? 'The meadow is impressed.' : 'There\u2019s always another round.'}`;
    $('play').innerHTML = 'Play again <span>\u2197</span>'; $('overlay').hidden = false;
    $('status').textContent = `Round over. Your score is ${score}. Personal best ${best}.`;
    $('play').focus(); tone(320, .3);
  }
  function start() {
    clearTimeout(spawnTimer); clearInterval(clockTimer); holes.forEach(hide);
    document.querySelectorAll('.hit-points').forEach(el => el.remove());
    // Disable difficulty buttons mid-game
    document.querySelectorAll('.difficulty-btn').forEach(btn => { btn.disabled = true; });
    score = 0; streak = 0; lastHit = 0; running = true; endAt = performance.now() + ROUND * 1000;
    $('score').textContent = '000'; $('time').textContent = ROUND; $('overlay').hidden = true;
    $('restart').disabled = false; $('combo').textContent = 'LET\u2019S MAKE SOME MISCHIEF';
    document.querySelector('.timer-stat').classList.remove('urgent');
    $('status').textContent = 'Round started. You have 30 seconds. Click or tap the moles as they appear.';
    clockTimer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endAt - performance.now()) / 1000));
      $('time').textContent = remaining; document.querySelector('.timer-stat').classList.toggle('urgent', remaining <= 10);
      if (!remaining) finish();
    }, 100);
    spawn();
  }
  $('play').addEventListener('click', start); $('restart').addEventListener('click', start);
  // Wire up difficulty buttons
  document.querySelectorAll('.difficulty-btn').forEach(btn => {
    btn.addEventListener('click', () => setDifficulty(btn.dataset.difficulty));
  });
  // Set initial aria-pressed state
  setDifficulty(difficulty);
  $('sound').addEventListener('click', () => {
    sound = !sound;
    if (sound) { try { audioContext ||= new (window.AudioContext || window.webkitAudioContext)(); audioContext.resume(); } catch { sound = false; } }
    $('sound').setAttribute('aria-pressed', String(sound)); $('sound').setAttribute('aria-label', `Turn sound ${sound ? 'off' : 'on'}`);
    $('sound').querySelector('span').textContent = `Sound ${sound ? 'on' : 'off'}`; tone(600);
  });
})();
