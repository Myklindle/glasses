(() => {
  'use strict';

  const SHOWS = [
    { key: 'newshour', name: 'PBS News Hour', channelId: 'UC6ZFN9Tx6xh-skXCuRHCDpQ' },
    { key: 'washingtonweek', name: 'Washington Week', channelId: 'UC2s0uKOc2WgB9eGta7cUUEA' },
    { key: 'compasspoints', name: 'Compass Points', channelId: 'UC6ZFN9Tx6xh-skXCuRHCDpQ', playlistId: 'PLgawtcOBBjr-KZydGcRYKOGXvR7xKhm1m' },
    { key: 'horizons', name: 'Horizons', channelId: 'UC6ZFN9Tx6xh-skXCuRHCDpQ', playlistId: 'PLgawtcOBBjr9HbB4Qa0Y_BDsCADC_v00X' },
  ];
  const SEEK_BACK = 15;
  const SEEK_FWD = 30;
  const POS_KEY = 'positions.v1';
  const MAX_POSITIONS = 20;

  // YouTube IFrame API player states.
  const ENDED = 0, PLAYING = 1, PAUSED = 2, BUFFERING = 3, CUED = 5;

  const $ = (id) => document.getElementById(id);
  const els = {
    home: $('home'), today: $('today'), cards: $('cards'),
    homeStatus: $('home-status'), retry: $('retry'),
    player: $('player'), title: $('now-playing'), mount: $('player-mount'),
    playerStatus: $('player-status'), controls: $('controls'),
    back: $('btn-back'), toggle: $('btn-toggle'), fwd: $('btn-fwd'),
    chapter: $('chapter'), storyControls: $('story-controls'),
    prev: $('btn-prev'), next: $('btn-next'),
  };

  const NO_CHAPTER_JUMP = 300; // seconds, when an episode has no chapters

  let episodes = {};     // show key -> { videoId, title }, from latest.json
  let current = null;    // what the player screen is showing
  let lastShowKey = null;
  let player = null;     // YT.Player
  let playerToken = 0;   // guards against async work finishing after the player closed
  let saveTimer = null;
  let apiPromise = null;
  let chapters = [];     // [{start, title}] for the current episode, possibly empty
  let pendingSeek = null; // {idx, at}: a chapter jump whose time the player may not report yet
  let uiTimer = null;
  let shownIdx = -2;
  const IDLE_MS = 4000;  // hide the overlay this long after the last input while playing
  let idleTimer = null;
  let overlayHidden = false;

  // ---------- small helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // "PBS News Hour full episode, Nov. 12, 2026" -> "Nov. 12, 2026"
  function episodeDate(title) {
    const m = /full episode,?\s*(.+)$/i.exec(title || '');
    return m ? m[1] : title || '';
  }

  // ---------- resume positions (localStorage can fail or be cleared) ----------

  function readPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (e) { return {}; }
  }

  function writePosition(id, sec) {
    try {
      const all = readPositions();
      delete all[id];
      all[id] = sec;
      const ids = Object.keys(all);
      while (ids.length > MAX_POSITIONS) delete all[ids.shift()];
      localStorage.setItem(POS_KEY, JSON.stringify(all));
    } catch (e) { /* ignore: resume is a convenience */ }
  }

  function clearPosition(id) {
    try {
      const all = readPositions();
      delete all[id];
      localStorage.setItem(POS_KEY, JSON.stringify(all));
    } catch (e) { /* ignore */ }
  }

  // ---------- home screen ----------

  function orderedShows() {
    const friday = new Date().getDay() === 5;
    const list = SHOWS.slice();
    if (friday) list.sort((a, b) => (a.key === 'washingtonweek' ? -1 : 1) - (b.key === 'washingtonweek' ? -1 : 1));
    return list;
  }

  function renderHome() {
    els.today.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'long', month: 'short', day: 'numeric',
    }).format(new Date());

    const positions = readPositions();
    els.cards.replaceChildren();
    for (const show of orderedShows()) {
      const ep = episodes[show.key];
      const card = el('button', 'card');
      card.type = 'button';
      card.dataset.show = show.key;
      card.append(el('span', 'card-name', show.name));
      card.append(el('span', 'card-sub', ep ? episodeDate(ep.title) : 'Latest uploads'));
      const pos = ep && positions[ep.videoId];
      if (pos > 30) card.append(el('span', 'card-resume', 'Resume at ' + fmt(pos)));
      card.addEventListener('click', () => openPlayer(show.key));
      els.cards.append(card);
    }
  }

  function focusHome() {
    const target = (lastShowKey && els.cards.querySelector('[data-show="' + lastShowKey + '"]'))
      || els.cards.firstElementChild;
    if (target) target.focus({ preventScroll: true });
  }

  function showHome() {
    stopPlayer();
    els.player.hidden = true;
    els.home.hidden = false;
    renderHome();
    focusHome();
  }

  async function loadEpisodes() {
    try {
      const res = await fetch('latest.json?ts=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      episodes = (data && data.shows) || {};
      els.homeStatus.textContent = '';
      els.retry.hidden = true;
    } catch (err) {
      episodes = {};
      els.homeStatus.textContent = "Couldn't load the episode list. The cards open each show's latest uploads instead.";
      els.retry.hidden = false;
    }
  }

  async function init() {
    await loadEpisodes();
    renderHome();
    focusHome();
    loadApi().catch(() => { /* retried when a video opens */ });
  }

  // ---------- player screen ----------

  function openPlayer(key) {
    history.pushState({ screen: 'player', show: key }, '');
    showPlayer(key);
  }

  function showPlayer(key) {
    const show = SHOWS.find((s) => s.key === key);
    if (!show) { showHome(); return; }
    const ep = episodes[key];
    lastShowKey = key;
    current = {
      show,
      videoId: ep ? ep.videoId : null,
      playlistId: ep ? null : (show.playlistId || 'UU' + show.channelId.slice(2)),
      title: ep ? show.name + ' \u00b7 ' + episodeDate(ep.title) : show.name + ' (latest uploads)',
    };

    els.home.hidden = true;
    els.player.hidden = false;
    els.title.textContent = current.title;
    els.controls.hidden = false;
    els.storyControls.hidden = false;
    chapters = window.Chapters.clean(ep && ep.chapters);
    pendingSeek = null;
    shownIdx = -2;
    els.prev.textContent = chapters.length ? 'Prev story' : '\u2212' + NO_CHAPTER_JUMP / 60 + ' min';
    els.next.textContent = chapters.length ? 'Next story' : '+' + NO_CHAPTER_JUMP / 60 + ' min';
    els.chapter.hidden = true;
    els.toggle.textContent = 'Play';
    setPlayerStatus('Loading\u2026');
    startPlayer();
    wakeOverlay();
    els.toggle.focus({ preventScroll: true });
  }

  // ---------- auto-hiding overlay: title, chapter and buttons fade out during playback ----------
  // Fades with opacity only, so layout does not shift and the focused button keeps focus.
  function setOverlayHidden(hide) {
    overlayHidden = hide;
    els.player.classList.toggle('idle', hide);
  }
  function wakeOverlay() {
    setOverlayHidden(false);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      let state = -1;
      try { state = player && player.getPlayerState(); } catch (e) { /* ignore */ }
      if (els.player.hidden || !els.mount.classList.contains('api')) return;
      if (state === PLAYING) setOverlayHidden(true); else wakeOverlay(); // stay up while paused
    }, IDLE_MS);
  }
  function stopOverlayTimer() {
    clearTimeout(idleTimer);
    setOverlayHidden(false);
  }
  // Any input from the band (key, tap, pointer, focus move) wakes the overlay. The input
  // that wakes it is not passed on as a button press, so a hidden button is never hit blind.
  function onWakeInput(e) {
    if (els.player.hidden) return;
    const wasHidden = overlayHidden;
    wakeOverlay();
    if (!wasHidden) return;
    const activate = e.type === 'click' || e.type === 'pointerup' || e.type === 'mouseup'
      || (e.type === 'keydown' && (e.key === 'Enter' || e.key === ' '));
    if (activate) { e.preventDefault(); e.stopPropagation(); }
  }
  for (const type of ['keydown', 'click', 'pointerdown', 'pointermove', 'touchstart', 'wheel', 'focusin']) {
    document.addEventListener(type, onWakeInput, { capture: true, passive: false });
  }
  function setPlayerStatus(text) {
    els.playerStatus.textContent = text;
    els.playerStatus.hidden = !text;
  }

  // A short message that clears itself, for things like "last story".
  let flashTimer = null;
  function flashStatus(text) {
    setPlayerStatus(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      if (els.playerStatus.textContent === text) setPlayerStatus('');
    }, 3000);
  }

  function savedStart() {
    if (!current.videoId) return 0;
    const pos = readPositions()[current.videoId];
    return pos > 30 ? Math.max(0, Math.floor(pos) - 5) : 0;
  }

  function loadApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { apiPromise = null; reject(new Error('timeout')); }, 8000);
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        clearTimeout(timer);
        if (typeof previous === 'function') previous();
        resolve();
      };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => { clearTimeout(timer); apiPromise = null; reject(new Error('load failed')); };
      document.head.append(script);
    });
    return apiPromise;
  }

  function startPlayer() {
    const token = ++playerToken;
    els.mount.replaceChildren();
    els.mount.classList.remove('api');
    const holder = el('div');
    holder.id = 'yt';
    els.mount.append(holder);

    loadApi()
      .then(() => { if (token === playerToken) createApiPlayer(token); })
      .catch(() => { if (token === playerToken) createPlainIframe(); });
  }

  function createApiPlayer(token) {
    const vars = {
      autoplay: 1, playsinline: 1, rel: 0, controls: 0, disablekb: 1, fs: 0,
      iv_load_policy: 3, modestbranding: 1,
    };
    if (/^https?:$/.test(location.protocol)) vars.origin = location.origin;
    if (current.videoId) {
      vars.start = savedStart();
    } else {
      vars.listType = 'playlist';
      vars.list = current.playlistId;
    }
    els.mount.classList.add('api');
    player = new YT.Player('yt', {
      width: '100%',
      height: '100%',
      videoId: current.videoId || undefined,
      playerVars: vars,
      events: {
        onReady: () => { if (token === playerToken) onPlayerReady(); },
        onStateChange: (e) => { if (token === playerToken) onPlayerState(e.data); },
        onError: (e) => { if (token === playerToken) onPlayerError(e.data); },
      },
    });
  }

  function onPlayerReady() {
    try { player.getIframe().tabIndex = -1; } catch (e) { /* ignore */ }
    const id = current.videoId;
    const pos = id && readPositions()[id];
    const dur = player.getDuration();
    if (pos && dur && pos > dur - 30) player.seekTo(0, true); // finished last time
    setPlayerStatus('');
    player.playVideo(); // autoplay can be refused; the Play button covers that
    clearInterval(saveTimer);
    saveTimer = setInterval(saveNow, 5000);
    clearInterval(uiTimer);
    uiTimer = setInterval(updateChapterLabel, 1000);
  }

  function onPlayerState(state) {
    if (state === PLAYING || state === BUFFERING) {
      els.toggle.textContent = 'Pause';
      setPlayerStatus('');
    } else {
      els.toggle.textContent = 'Play';
    }
    if (state === PAUSED) saveNow();
    if (state === ENDED && current.videoId) clearPosition(current.videoId);
    if (state === CUED) setPlayerStatus('Select Play to start.');
  }

  function onPlayerError(code) {
    setPlayerStatus("Can't play this video here (error " + code + ").");
  }

  // Used when the YouTube API script can't load: a plain embed with YouTube's own controls.
  function createPlainIframe() {
    const frame = document.createElement('iframe');
    const params = 'autoplay=1&playsinline=1&rel=0';
    frame.src = current.videoId
      ? 'https://www.youtube.com/embed/' + encodeURIComponent(current.videoId) + '?' + params + '&start=' + savedStart()
      : 'https://www.youtube.com/embed/videoseries?' + params + '&list=' + encodeURIComponent(current.playlistId);
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.title = current.title;
    els.mount.replaceChildren(frame);
    els.controls.hidden = true;
    els.storyControls.hidden = true;
    els.chapter.hidden = true;
    stopOverlayTimer();
    setPlayerStatus('Basic player (YouTube API unavailable). Resume is off.');
  }

  function saveNow() {
    if (!player || !current || !current.videoId || typeof player.getCurrentTime !== 'function') return;
    try {
      const t = Math.floor(player.getCurrentTime());
      if (t >= 10) writePosition(current.videoId, t);
    } catch (e) { /* player not ready */ }
  }

  function stopPlayer() {
    playerToken++;
    clearInterval(saveTimer);
    clearInterval(uiTimer);
    stopOverlayTimer();
    saveNow();
    try { if (player && player.destroy) player.destroy(); } catch (e) { /* ignore */ }
    player = null;
    els.mount.replaceChildren();
  }

  // ---------- controls ----------

  els.toggle.addEventListener('click', () => {
    if (!player || typeof player.getPlayerState !== 'function') return;
    const s = player.getPlayerState();
    if (s === PLAYING || s === BUFFERING) player.pauseVideo(); else player.playVideo();
  });

  function seekBy(delta) {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    let t = player.getCurrentTime() + delta;
    const dur = player.getDuration();
    if (dur) t = Math.min(t, dur - 1);
    player.seekTo(Math.max(0, t), true);
  }
  els.back.addEventListener('click', () => seekBy(-SEEK_BACK));
  els.fwd.addEventListener('click', () => seekBy(SEEK_FWD));
  els.retry.addEventListener('click', init);

  // ---------- story (chapter) skipping ----------

  // Which chapter we're in and how far into it. Right after a jump the player can
  // still report the old time, so trust the jump for a couple of seconds.
  function where() {
    if (pendingSeek && Date.now() - pendingSeek.at < 2000) {
      return { idx: pendingSeek.idx, secondsIn: 0 };
    }
    const t = player.getCurrentTime();
    const idx = window.Chapters.indexAt(chapters, t);
    return { idx, secondsIn: idx >= 0 ? t - chapters[idx].start : t };
  }

  function jumpToChapter(idx) {
    pendingSeek = { idx, at: Date.now() };
    player.seekTo(chapters[idx].start, true);
    showChapter(idx);
  }

  function showChapter(idx) {
    shownIdx = idx;
    if (idx < 0) { els.chapter.hidden = true; return; }
    els.chapter.textContent = (idx + 1) + '/' + chapters.length + '  ' + chapters[idx].title;
    els.chapter.hidden = false;
  }

  function updateChapterLabel() {
    if (!chapters.length || !player || typeof player.getCurrentTime !== 'function') return;
    let idx;
    try { idx = where().idx; } catch (e) { return; }
    if (idx !== shownIdx) showChapter(idx);
  }

  els.next.addEventListener('click', () => {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    if (!chapters.length) { seekBy(NO_CHAPTER_JUMP); return; }
    const to = window.Chapters.nextIndex(chapters, where().idx);
    if (to >= 0) jumpToChapter(to); else flashStatus('That was the last story.');
  });

  els.prev.addEventListener('click', () => {
    if (!player || typeof player.getCurrentTime !== 'function') return;
    if (!chapters.length) { seekBy(-NO_CHAPTER_JUMP); return; }
    const w = where();
    jumpToChapter(window.Chapters.prevIndex(chapters, w.idx, w.secondsIn));
  });

  // ---------- history: the glasses' Back action calls history.back() ----------

  history.replaceState({ screen: 'home' }, '');
  window.addEventListener('popstate', (e) => {
    const state = e.state;
    if (state && state.screen === 'player') showPlayer(state.show); else showHome();
  });
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  init();
})();
