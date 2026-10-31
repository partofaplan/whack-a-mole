(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const ROUND = 30;

  // Difficulty settings: interval = spawn gap (ms), visible = time mole stays up (ms, minimum enforced below), perSpawn = moles per wave
  const DIFFICULTIES = {
    easy:   { interval: 1500, visible: 1200, perSpawn: 1 },
    medium: { interval: 900,  visible: 800,  perSpawn: 1 },
    hard:   { interval: 500,  visible: 600,  perSpawn: 2 },  // visible floored at 350ms after ramp
  };
  // Minimum time a mole stays visible (ensures it's hittable even late in a hard round)
  const MIN_VISIBLE_MS = 350;
  let difficulty = 'medium';

  let score = 0, running = false, endAt = 0, spawnTimer, clockTimer, streak = 0, lastHit = 0;
  let sound = false, audioContext;
  // Personal best tracked separately per difficulty
  function bestKey(d) { return `mole-meadow-best-${d}`; }
  function loadBest(d) { try { return Number(localStorage.getItem(bestKey(d))) || 0; } catch { return 0; } }
  function saveBest(d, val) { try { localStorage.setItem(bestKey(d), String(val)); } catch {} }
  let best = loadBest(difficulty);
  const format = n => String(n).padStart(3, '0');
  $('best').textContent = format(best);
  const moleSVG = `<svg class="mole" viewBox="0 0 100 120" aria-hidden="true">
    <defs>
      <radialGradient id="fur" cx="48%" cy="72%" rx="62%" ry="78%">
        <stop stop-color="#806047"/>
        <stop offset=".46" stop-color="#6b4226"/>
        <stop offset=".8" stop-color="#3d2b1f"/>
        <stop offset="1" stop-color="#252321"/>
      </radialGradient>
    </defs>
    <path d="M18 118C15 102 13 84 17 65C19 54 23 45 26 35C29 20 39 14 50 14C63 14 73 24 75 37C78 49 84 60 85 76C88 94 83 108 82 118Z" fill="url(#fur)"/>
    <ellipse cx="50" cy="82" rx="28" ry="35" fill="#8b6a50" opacity=".18"/>
    <path d="M48 62C38 66 31 82 32 99L34 119H67C71 103 69 83 61 70C57 64 53 61 48 62Z" fill="#b38c6b" opacity=".65"/>
    <path d="M49 70C39 79 38 99 41 118H60C64 103 61 84 55 74Z" fill="#d4a88a" opacity=".5"/>
    <path d="M27 40C21 36 22 30 26 29C30 28 33 34 32 38M69 38C68 33 71 29 74 31C78 34 76 39 73 42" fill="#493326"/>
    <path d="M27 37Q24 32 27 32Q30 33 29 38M72 38Q71 33 73 34L74 37" fill="#c47a6e" opacity=".65"/>
    <path d="M25 49C24 30 35 18 49 18C64 17 75 32 76 49C71 62 62 67 50 67C37 66 28 59 25 49Z" fill="url(#fur)"/>
    <path d="M31 40Q35 35 41 40M60 40Q65 36 70 42" fill="none" stroke="#292420" stroke-width="3" stroke-linecap="round"/>
    <circle cx="36" cy="43" r="1.8" fill="#141311"/>
    <circle cx="65" cy="43" r="1.7" fill="#141311"/>
    <circle cx="35.6" cy="42.6" r=".45" fill="#b1a18d" opacity=".65"/>
    <circle cx="64.6" cy="42.6" r=".4" fill="#b1a18d" opacity=".55"/>
    <path d="M39 49C42 44 55 43 60 49C63 54 59 63 55 70C53 74 48 74 45 70C41 63 36 55 39 49Z" fill="#a77860"/>
    <path d="M41 49C45 46 53 46 57 50C59 55 54 64 52 69C51 71 48 70 47 68C44 62 39 54 41 49Z" fill="#d4a88a"/>
    <path d="M44 50Q48 47 52 50L50 64Q46 59 44 50Z" fill="#ead0b5" opacity=".55"/>
    <path d="M44 67C45 63 54 63 57 67C59 71 55 75 51 75C47 75 42 72 44 67Z" fill="#c47a6e"/>
    <path d="M46 67Q50 65 54 68" fill="none" stroke="#e6b1a2" stroke-width="1.5" stroke-linecap="round"/>
    <ellipse cx="46.5" cy="70" rx="1.2" ry=".85" fill="#78483f"/>
    <ellipse cx="54" cy="70" rx="1.2" ry=".85" fill="#78483f"/>
    <g fill="none" stroke="#b3977c" stroke-width=".6" stroke-linecap="round" opacity=".55">
      <path d="M40 58L26 54M40 61L23 61M41 64L28 68M60 58L74 54M59 61L77 62M58 64L71 69"/>
    </g>
    <g fill="none" stroke="#b28c66" stroke-width=".8" stroke-linecap="round" opacity=".3">
      <path d="M33 29L36 25M39 25L41 22M47 23L48 19M55 24L54 20M62 29L60 25M28 48L30 52M30 57L33 60M69 52L71 48M66 59L69 56M23 70L25 76M21 81L23 87M26 92L28 97M75 72L73 78M79 84L77 90M72 96L70 101M38 78L37 84M60 80L62 87M40 95L41 102M57 105L56 112"/>
    </g>
    <path d="M24 79C17 80 13 85 12 91L26 99L34 90Z M76 79C83 80 87 85 88 91L74 99L66 90Z" fill="url(#fur)"/>
    <path d="M23 86C19 85 12 87 9 91C6 95 8 99 12 101C18 104 27 103 31 99C35 95 30 90 23 86Z M77 86C81 85 88 87 91 91C94 95 92 99 88 101C82 104 73 103 69 99C65 95 70 90 77 86Z" fill="#b5876e"/>
    <path d="M12 91Q19 87 26 93L29 97Q19 100 11 96Z M88 91Q81 87 74 93L71 97Q81 100 89 96Z" fill="#d4a88a"/>
    <g fill="none" stroke="#edd7bc" stroke-width="2" stroke-linecap="round">
      <path d="M11 96L8 100M16 98L14 103M22 99L21 104M27 98L28 102M89 96L92 100M84 98L86 103M78 99L79 104M73 98L72 102"/>
    </g>
    <path d="M13 91L16 94M19 90L21 94M87 91L84 94M81 90L79 94" fill="none" stroke="#986c58" stroke-width=".8" stroke-linecap="round"/>
  </svg>`;
  const holes = Array.from({ length: 9 }, (_, index) => {
    const button = document.createElement('button');
    button.className = 'hole'; button.innerHTML = moleSVG;
    // Gradients have document-wide IDs, so give every critter its own.
    button.innerHTML = button.innerHTML.replaceAll('id="fur"', `id="fur-${index}"`).replaceAll('url(#fur)', `url(#fur-${index})`);
    button.setAttribute('aria-label', `Hole ${index + 1}`);
    button.addEventListener('click', () => hit(button));
    button.addEventListener('touchstart', event => {
      event.preventDefault();
      hit(button);
    }, { passive: false });
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
    const visibleMs = Math.max(MIN_VISIBLE_MS, cfg.visible * speedFactor);
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
    best = loadBest(d);
    $('best').textContent = format(best);
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
    if (newBest) { best = score; saveBest(difficulty, best); }
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
