/* =========================================================
   배경음악 (BGM) — 혼자 하기 · 멀티플레이 공용
   ---------------------------------------------------------
   music/ 폴더의 mp3 를 골라 틀어 주는 작은 위젯이다.
   화면 오른쪽 위에 🎵 단추 하나를 띄우고, 누르면 아래에
   [켜기/끄기] · 곡 고르기 · 소리 크기 판이 펼쳐진다.

   · 혼자 하기(word_connection_game.html)와 멀티플레이(server/public/index.html)
     둘 다 이 파일 하나를 그대로 불러 쓴다. 두 화면이 서로 다른 주소(/ · /multi)에
     있어도 music/ 는 두 곳 모두에서 같은 상대 경로로 닿는다.
   · 고른 곡·켜짐 여부·소리 크기는 localStorage 에 남겨 다음에 열어도 그대로다.
   · 브라우저는 사용자가 한 번 화면을 누르기 전에는 소리를 못 내게 막는다.
     그래서 켜져 있는 상태로 열렸으면 첫 클릭·키 입력 때 이어서 시작한다.
   · 곡 파일이 없거나(파일을 직접 연 경우 등) 재생에 실패해도 게임은 그대로 돌아간다.
   ========================================================= */
(function () {
    'use strict';

    // music/ 폴더에 있는 곡. 파일 이름을 그대로 적고, 화면에는 name 을 보여 준다.
    // 곡을 더 넣으려면 mp3 를 music/ 에 두고 여기에 한 줄 더 적으면 된다.
    const TRACKS = [
        { file: 'Coin_Op Bounce.mp3',     name: 'Coin-Op Bounce' },
        { file: 'Hearthside Waltz.mp3',   name: 'Hearthside Waltz' },
        { file: 'Marimba Mornings.mp3',   name: 'Marimba Mornings' },
        { file: 'Marimba Quiz Trail.mp3', name: 'Marimba Quiz Trail' },
        { file: 'The Heather Path.mp3',   name: 'The Heather Path' },
        { file: 'The Quiet Turn.mp3',     name: 'The Quiet Turn' },
        { file: 'Ticking Rhodes.mp3',     name: 'Ticking Rhodes' }
    ];
    const MUSIC_DIR = 'music/';
    const RANDOM = 'random';
    const STORAGE_KEY = 'wordGame.bgm';
    const DEFAULTS = { on: true, track: RANDOM, volume: 0.35 };

    /* ---------- 저장 ---------- */
    function loadPrefs() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            const prefs = Object.assign({}, DEFAULTS, saved);
            // 지워진 곡을 가리키고 있으면 무작위로 되돌린다
            if (prefs.track !== RANDOM && !TRACKS.some(t => t.file === prefs.track)) prefs.track = RANDOM;
            prefs.volume = Math.min(1, Math.max(0, Number(prefs.volume)));
            if (Number.isNaN(prefs.volume)) prefs.volume = DEFAULTS.volume;
            return prefs;
        } catch (e) {
            return Object.assign({}, DEFAULTS);
        }
    }
    function savePrefs() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch (e) { /* 저장 못 해도 그만 */ }
    }

    const prefs = loadPrefs();
    const audio = new Audio();
    audio.preload = 'none';
    let currentFile = null;      // 지금 걸려 있는 곡 파일 이름
    let waitingForGesture = false; // 브라우저가 자동 재생을 막아 첫 입력을 기다리는 중
    let ui = null;

    /* ---------- 재생 ---------- */
    function pickRandom(except) {
        const pool = TRACKS.filter(t => t.file !== except);
        const list = pool.length ? pool : TRACKS;
        return list[Math.floor(Math.random() * list.length)];
    }
    function trackFor(file) {
        return TRACKS.find(t => t.file === file) || null;
    }
    function resolveTrack() {
        if (prefs.track === RANDOM) return pickRandom(currentFile);
        return trackFor(prefs.track) || TRACKS[0];
    }
    function loadTrack(track) {
        currentFile = track.file;
        audio.src = MUSIC_DIR + encodeURIComponent(track.file);
        // 한 곡만 고른 경우는 그 곡을 계속 되풀이하고, 무작위면 곡이 끝날 때 다른 곡으로 넘어간다
        audio.loop = prefs.track !== RANDOM;
        audio.volume = prefs.volume;
        render();
    }
    function play() {
        if (!currentFile) loadTrack(resolveTrack());
        audio.volume = prefs.volume;
        const attempt = audio.play();
        if (attempt && typeof attempt.then === 'function') {
            attempt.then(() => {
                waitingForGesture = false;
                render();
            }).catch(() => {
                // 자동 재생이 막힌 경우 — 첫 클릭·키 입력 때 다시 시도한다
                waitingForGesture = true;
                armGestureResume();
                render();
            });
        }
    }
    function pause() {
        audio.pause();
        waitingForGesture = false;
        render();
    }
    function setOn(on) {
        prefs.on = !!on;
        savePrefs();
        if (prefs.on) play(); else pause();
    }
    function setTrack(value) {
        prefs.track = value;
        savePrefs();
        loadTrack(resolveTrack());
        if (prefs.on) play();
    }
    function setVolume(value) {
        prefs.volume = Math.min(1, Math.max(0, Number(value)));
        audio.volume = prefs.volume;
        savePrefs();
    }

    let gestureArmed = false;
    function armGestureResume() {
        if (gestureArmed) return;
        gestureArmed = true;
        const resume = () => {
            document.removeEventListener('pointerdown', resume, true);
            document.removeEventListener('keydown', resume, true);
            gestureArmed = false;
            if (prefs.on && audio.paused) play();
        };
        document.addEventListener('pointerdown', resume, true);
        document.addEventListener('keydown', resume, true);
    }

    audio.addEventListener('ended', () => {
        // loop 가 꺼진 무작위 모드에서만 온다 — 다른 곡으로 넘어간다
        if (!prefs.on) return;
        loadTrack(pickRandom(currentFile));
        play();
    });
    audio.addEventListener('error', () => {
        // 파일을 못 찾은 경우(예: 서버가 music/ 을 안 내주는 배포). 게임은 계속 가야 하므로 조용히 멈춘다.
        waitingForGesture = false;
        render();
    });
    audio.addEventListener('play', render);
    audio.addEventListener('pause', render);

    /* ---------- 화면 ---------- */
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function buildUi() {
        const root = el('div', 'bgm-widget');
        root.id = 'bgmWidget';

        const toggleBtn = el('button', 'bgm-fab bgm-main-fab');
        toggleBtn.type = 'button';
        toggleBtn.id = 'bgmFabBtn';
        toggleBtn.setAttribute('aria-haspopup', 'true');
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.title = '배경음악 켜기/끄기와 곡 고르기';
        const fabIcon = el('span', 'bgm-fab-icon', '🎵');
        const fabLabel = el('span', 'bgm-fab-label', '배경음악');
        toggleBtn.append(fabIcon, fabLabel);

        const panel = el('div', 'bgm-panel');
        panel.id = 'bgmPanel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', '배경음악 설정');

        const head = el('div', 'bgm-panel-head');
        head.append(el('span', 'bgm-panel-title', '🎵 배경음악'));
        const closeBtn = el('button', 'bgm-close', '✕');
        closeBtn.type = 'button';
        closeBtn.title = '닫기';
        head.append(closeBtn);

        const onBtn = el('button', 'bgm-on-btn');
        onBtn.type = 'button';
        onBtn.id = 'bgmOnBtn';

        const selectLabel = el('label', 'bgm-label', '곡 고르기');
        selectLabel.htmlFor = 'bgmSelect';
        const select = el('select', 'bgm-select');
        select.id = 'bgmSelect';
        const randomOpt = el('option', null, '🔀 무작위로 섞어 듣기');
        randomOpt.value = RANDOM;
        select.append(randomOpt);
        TRACKS.forEach(t => {
            const opt = el('option', null, '🎶 ' + t.name);
            opt.value = t.file;
            select.append(opt);
        });

        const volLabel = el('label', 'bgm-label', '소리 크기');
        volLabel.htmlFor = 'bgmVolume';
        const volRow = el('div', 'bgm-vol-row');
        const volume = document.createElement('input');
        volume.type = 'range';
        volume.id = 'bgmVolume';
        volume.min = '0';
        volume.max = '1';
        volume.step = '0.05';
        volume.className = 'bgm-volume';
        const volValue = el('span', 'bgm-vol-value', '');
        volRow.append(el('span', 'bgm-vol-icon', '🔈'), volume, volValue);

        const now = el('div', 'bgm-now', '');
        now.id = 'bgmNow';

        panel.append(head, onBtn, selectLabel, select, volLabel, volRow, now);
        // 🎵 단추는 한 줄(.bgm-fab-row)에 담는다. 화면이 `data-bgm-beside` 를 붙여 둔 요소가 있으면
        // 그 줄의 왼쪽에 끌어다 놓아 나란히 보이게 한다 (혼자 하기의 🔊 효과음 단추가 이걸 쓴다).
        const fabRow = el('div', 'bgm-fab-row');
        fabRow.append(toggleBtn);
        document.querySelectorAll('[data-bgm-beside]').forEach(node => fabRow.prepend(node));
        root.append(fabRow, panel);
        document.body.appendChild(root);

        /* --- 이벤트 --- */
        const openPanel = (open) => {
            root.classList.toggle('open', open);
            toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        };
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openPanel(!root.classList.contains('open'));
        });
        closeBtn.addEventListener('click', () => openPanel(false));
        onBtn.addEventListener('click', () => setOn(!prefs.on));
        select.addEventListener('change', () => setTrack(select.value));
        volume.addEventListener('input', () => {
            setVolume(volume.value);
            volValue.textContent = Math.round(prefs.volume * 100) + '%';
        });
        // 판 바깥을 누르면 닫는다 (판 안쪽 클릭은 남긴다)
        document.addEventListener('pointerdown', (e) => {
            if (!root.classList.contains('open')) return;
            if (root.contains(e.target)) return;
            openPanel(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && root.classList.contains('open')) openPanel(false);
        });

        return { root, toggleBtn, fabIcon, fabLabel, onBtn, select, volume, volValue, now };
    }

    function render() {
        if (!ui) return;
        const playing = prefs.on && !audio.paused;
        ui.root.classList.toggle('is-on', prefs.on);
        ui.root.classList.toggle('is-playing', playing);
        ui.root.classList.toggle('is-waiting', prefs.on && waitingForGesture);
        ui.fabIcon.textContent = prefs.on ? '🎵' : '🔇';
        ui.fabLabel.textContent = prefs.on ? '배경음악' : '음악 꺼짐';
        ui.onBtn.textContent = prefs.on ? '🔇 음악 끄기' : '🔊 음악 켜기';
        ui.onBtn.classList.toggle('is-on', prefs.on);
        ui.select.value = prefs.track;
        ui.volume.value = String(prefs.volume);
        ui.volValue.textContent = Math.round(prefs.volume * 100) + '%';

        const track = trackFor(currentFile);
        if (!prefs.on) {
            ui.now.textContent = '음악이 꺼져 있어요';
        } else if (waitingForGesture) {
            ui.now.textContent = '화면을 한 번 누르면 음악이 시작돼요';
        } else if (track) {
            ui.now.textContent = (playing ? '▶ 재생 중 · ' : '⏸ ') + track.name
                + (prefs.track === RANDOM ? ' (무작위)' : '');
        } else {
            ui.now.textContent = '';
        }
    }

    function init() {
        if (ui) return;
        ui = buildUi();
        loadTrack(resolveTrack());
        if (prefs.on) play(); else render();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 다른 스크립트에서 필요하면 쓸 수 있게 최소한만 내놓는다
    window.BGM = { play: () => setOn(true), pause: () => setOn(false), get isOn() { return prefs.on; } };
})();
