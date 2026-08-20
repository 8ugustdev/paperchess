/**
 * ====================================================================
 * PAPERCHESS APP — UI + game flow, ES5, zero dependencies.
 * Two screens: start (setup) and play. Local engraved piece sprites
 * and partial board repaints.
 * ====================================================================
 */
(function (env) { 'use strict';
    var E = env.PCEngine, Bot = env.PCBot;
    var LEVEL_NAME = { 1: 'Pawn', 2: 'Knight', 3: 'Bishop', 4: 'Rook', 5: 'Queen' };
    var PIECE_NAME = { 1: 'pawn', 2: 'knight', 3: 'bishop', 4: 'rook', 5: 'queen', 6: 'king' };
    var BOT_WAIT_MS = 350;
    var BOT_SELECT_MS = 400;

    // Hidden opponent strength for the player-rating update (not shown).
    // Linear scale: level n plays like 600 + 200n.
    function oppRating(lvl) { return 600 + 200 * lvl; }

    function pieceImg(v) {
        return 'img/' + (v > 0 ? 'w-' : 'b-') + PIECE_NAME[v > 0 ? v : -v] + '.png?v=2';
    }

    function preload() {
        var i, k, p;
        for (i = 1; i <= 6; i++) {
            for (k = 0; k < 2; k++) {
                p = new Image();
                p.src = 'img/' + (k ? 'w-' : 'b-') + PIECE_NAME[i] + '.png?v=2';
            }
        }
    }

    // ---------- storage (guarded) ----------
    var store = {
        get: function (k, d) {
            try {
                var v = localStorage.getItem(k);
                return v === null ? d : JSON.parse(v);
            } catch (e) { return d; }
        },
        set: function (k, v) {
            try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
        },
        del: function (k) {
            try { localStorage.removeItem(k); } catch (e) {}
        }
    };

    // ---------- state ----------
    var engine, bot;
    var playerSide = 'w';   // bot mode: your side; 2p mode: board orientation
    var mode = 'bot';       // 'bot' | '2p'
    var level = 1;
    var flipped = false;
    var selSq = -1, targets = [];
    var lastMove = null;
    var busy = false;
    var gameOver = false;
    var resTitle = '', resBody = '';   // header result text when over
    var elo = store.get('pc_elo', 1200);
    var moveLog = [];   // [{f,t,p}] — replay record for autosave

    // ---------- dom ----------
    var $ = function (id) { return document.getElementById(id); };
    var boardEl, sqEls = {};
    var cellPx = 40;

    // ---------- screens ----------
    function showStart() {
        $('screen-start').className = 'screen';
        $('screen-play').className = 'screen hidden';
        // preselect last-used config
        var rows = $('lvl-list').children, i;
        for (i = 0; i < rows.length; i++) {
            rows[i].className = 'lvl-row' +
                (parseInt(rows[i].getAttribute('data-v'), 10) === level ? ' on' : '');
        }
        var tiles = $('side-tiles').children;
        for (i = 0; i < tiles.length; i++) {
            tiles[i].className = 'side-tile' +
                (tiles[i].getAttribute('data-v') === playerSide ? ' on' : '');
        }
        var modes = $('mode-tiles').children;
        for (i = 0; i < modes.length; i++) {
            modes[i].className = 'side-tile' +
                (modes[i].getAttribute('data-v') === mode ? ' on' : '');
        }
        $('bot-setup').style.display = mode === '2p' ? 'none' : 'block';
        $('btn-resume').style.display = store.get('pc_save', null) ? 'table-cell' : 'none';
        $('start-btns').className = 'split' + (store.get('pc_save', null) ? ' two' : '');
        $('start-elo').innerHTML = 'Your rating: <b>' + Math.round(elo) + '</b>';
    }

    function showPlay() {
        $('screen-start').className = 'screen hidden';
        $('screen-play').className = 'screen';
        sizeBoard();
    }

    // ---------- board build ----------
    function buildBoard() {
        boardEl = $('board');
        var frag = document.createDocumentFragment();
        var r, c, tr, td;

        for (r = 0; r < 9; r++) {
            tr = document.createElement('tr');
            for (c = 0; c < 9; c++) {
                td = document.createElement('td');
                if (r === 8) {
                    td.className = 'coord';
                    td.innerHTML = (c === 0) ? '&nbsp;' : fileLabel(c - 1);
                } else if (c === 0) {
                    td.className = 'coord';
                    td.innerHTML = rankLabel(r);
                } else {
                    var sq = screenToSq(r, c - 1);
                    td.className = 'sq';
                    sqEls[sq] = td;
                    bindTap(td, sq);
                }
                tr.appendChild(td);
            }
            frag.appendChild(tr);
        }
        boardEl.innerHTML = '';
        boardEl.appendChild(frag);
    }

    function fileLabel(c) { return 'abcdefgh'.charAt(flipped ? 7 - c : c); }
    function rankLabel(r) { return flipped ? (r + 1) : (8 - r); }

    function screenToSq(r, c) {
        var br = flipped ? 7 - r : r;
        var bc = flipped ? 7 - c : c;
        return E.prototype.rcToSq(br, bc);
    }

    function bindTap(td, sq) {
        td.onclick = function () { onSquare(sq); };
    }

    function rebuildBoard() {
        sqEls = {};
        buildBoard();
        sizeBoard();
    }

    // ---------- sizing ----------
    function sizeBoard() {
        var vw = window.innerWidth || 480;
        // width-first sizing (screen caps at 560px): e-ink viewports are
        // tall enough that height never binds; wrap shrink-wraps the
        // board so the result popup centres on it
        var avail = Math.min(vw, 560) - 24;
        var size = Math.floor((avail - 32) / 8);
        if (size < 24) size = 24;
        if (size > 88) size = 88;
        cellPx = size;
        var rows = boardEl.rows, r, c, td;
        for (r = 0; r < rows.length; r++) {
            for (c = 0; c < rows[r].cells.length; c++) {
                td = rows[r].cells[c];
                if (td.className === 'coord') {
                    if (c === 0) {
                        td.style.width = '18px';
                        td.style.height = cellPx + 'px';
                    } else {
                        td.style.width = cellPx + 'px';
                        td.style.height = Math.floor(cellPx * 0.4) + 'px';
                    }
                } else {
                    td.style.width = cellPx + 'px';
                    td.style.height = cellPx + 'px';
                    td.style.fontSize = Math.floor(cellPx * 0.55) + 'px';
                }
            }
        }
    }

    // ---------- rendering ----------
    var checkSq = -1;

    function targetAt(sq) {
        var hit = null, i;
        for (i = 0; i < targets.length; i++) {
            if (targets[i].to === sq) { hit = targets[i]; break; }
        }
        return hit;
    }

    function paintSquare(sq) {
        var td = sqEls[sq];
        if (!td) return;
        var v = engine.board[sq];
        var r = E.prototype.sqToR(sq), c = E.prototype.sqToC(sq);
        var cls = 'sq ' + (((r + c) % 2 === 0) ? 'sq-l' : 'sq-d');

        if (lastMove && (sq === lastMove.from || sq === lastMove.to)) cls += ' sq-last';
        if (sq === checkSq) cls += ' sq-check';
        if (selSq === sq) cls += ' sq-sel';
        if (!v && targetAt(sq)) cls += ' sq-target';

        var html;
        if (v) {
            html = '<img src="' + pieceImg(v) + '" alt="">';
            if (targetAt(sq)) cls += ' sq-capture';
        } else if (targetAt(sq)) {
            html = '&bull;';
        } else {
            html = '&nbsp;';
        }
        td.className = cls;
        td.innerHTML = html;
    }

    function paintBoard() {
        for (var sq = 21; sq <= 98; sq++) {
            if (sqEls[sq]) paintSquare(sq);
        }
        paintCheckHighlight();
    }

    function paintCheckHighlight() {
        var prev = checkSq;
        checkSq = (!gameOver && engine.inCheck(engine.whiteToMove))
            ? engine.kingSq(engine.whiteToMove) : -1;
        if (prev >= 0 && prev !== checkSq) paintSquare(prev);
        if (checkSq >= 0) paintSquare(checkSq);
    }

    function paintStatus() {
        var turn = $('turn-label'), meta = $('match-row');
        var you = playerSide === 'w' ? 'WHITE' : 'BLACK';
        var moveNo = engine ? engine.fullmove : 1;
        var chk = (engine && !gameOver && engine.inCheck(engine.whiteToMove))
            ? ' &middot; CHECK' : '';

        if (gameOver) {
            turn.innerHTML = resTitle || 'GAME OVER';
            turn.className = 'turn fin';
        } else if (mode === '2p') {
            turn.innerHTML = (engine.whiteToMove ? 'WHITE MOVES' : 'BLACK MOVES') + chk;
            turn.className = 'turn';
        } else if (busy) {
            turn.innerHTML = 'BOT THINKING&hellip;';
            turn.className = 'turn';
        } else if ((engine.whiteToMove ? 'w' : 'b') === playerSide) {
            turn.innerHTML = 'YOUR MOVE' + chk;
            turn.className = 'turn';
        } else {
            turn.innerHTML = 'BOT MOVES';
            turn.className = 'turn';
        }
        if (gameOver) {
            meta.innerHTML = resBody + ' &middot; MOVE ' + moveNo;
            $('elo-badge').innerHTML = Math.round(elo);
        } else if (mode === '2p') {
            meta.innerHTML = '2 PLAYERS &middot; MOVE ' + moveNo;
            $('elo-badge').innerHTML = '&nbsp;';
        } else {
            meta.innerHTML = (LEVEL_NAME[level] || ('LEVEL ' + level)).toUpperCase() +
                ' &middot; MOVE ' + moveNo + ' &middot; YOU: ' + you;
            $('elo-badge').innerHTML = Math.round(elo);
        }
    }

    function paintChrome() {
        paintStatus();
    }

    // ---------- interaction ----------
    function onSquare(sq) {
        if (busy || gameOver) return;
        if (mode === 'bot' && (engine.whiteToMove ? 'w' : 'b') !== playerSide) return;

        var v = engine.board[sq];

        if (selSq >= 0 && targetAt(sq)) {
            var mv = targetAt(sq);
            if (mv.promo) {
                var from = selSq, to = sq;
                clearSelRepaint();
                askPromotion(function (promoVal) {
                    var m = engine.findPseudo(from, to, promoVal);
                    if (m) playerMove(m);
                });
                return;
            }
            clearSelRepaint();
            playerMove(mv);
            return;
        }

        if (v && (mode === '2p' || (v > 0 ? 'w' : 'b') === playerSide)) {
            if (selSq === sq) { clearSelRepaint(); return; }
            var old = selSq, oldT = targets.slice();
            selSq = sq;
            // free-form: pseudo-legal targets — the player may walk into
            // check; a captured king simply ends the game
            targets = engine.pseudoFrom(sq);
            if (old >= 0) paintSquare(old);
            var i;
            for (i = 0; i < oldT.length; i++) paintSquare(oldT[i].to);
            paintSquare(sq);
            for (i = 0; i < targets.length; i++) paintSquare(targets[i].to);
        } else {
            clearSelRepaint();
        }
    }

    function clearSelRepaint() {
        var old = selSq, oldT = targets.slice(), i;
        selSq = -1; targets = [];
        if (old >= 0) paintSquare(old);
        for (i = 0; i < oldT.length; i++) paintSquare(oldT[i].to);
    }

    function promoSide() {
        return mode === '2p' ? (engine.whiteToMove ? 'w' : 'b') : playerSide;
    }

    function askPromotion(cb) {
        var modal = $('promo-modal');
        var btns = $('promo-seg').getElementsByTagName('button'), i;
        // match sprite color to the promoting side
        var ps = promoSide();
        var pre = ps === 'w' ? 'w-' : 'b-';
        var names = { 5: 'queen', 4: 'rook', 3: 'bishop', 2: 'knight' };
        for (i = 0; i < btns.length; i++) {
            var v = parseInt(btns[i].getAttribute('data-v'), 10);
            var im = btns[i].getElementsByTagName('img')[0];
            if (im) im.src = 'img/' + pre + names[v] + '.png';
        }
        var handler = function () {
            for (var j = 0; j < btns.length; j++) btns[j].onclick = null;
            modal.className = 'overlay';
            var val = parseInt(this.getAttribute('data-v'), 10);
            cb(ps === 'w' ? val : -val);
        };
        for (i = 0; i < btns.length; i++) btns[i].onclick = handler;
        modal.className = 'overlay show';
    }

    // ---------- moves ----------
    function applyMove(m) {
        var touched = [m.from, m.to], i;
        if (m.flags & 1) touched.push(m.to + (m.piece > 0 ? 10 : -10));   // EP victim
        if (m.flags & 2) { touched.push(m.piece > 0 ? 98 : 28, m.piece > 0 ? 96 : 26); }
        if (m.flags & 4) { touched.push(m.piece > 0 ? 91 : 21, m.piece > 0 ? 94 : 24); }
        if (lastMove) { touched.push(lastMove.from, lastMove.to); }

        var notation = engine.san(m);
        engine.make(m);
        moveLog.push({ f: m.from, t: m.to, p: m.promo || 0 });
        lastMove = { from: m.from, to: m.to };

        var uniq = {}, k;
        for (i = 0; i < touched.length; i++) uniq[touched[i]] = 1;
        for (k in uniq) if (uniq.hasOwnProperty(k)) paintSquare(parseInt(k, 10));
        paintCheckHighlight();
        paintChrome();
        return notation;
    }

    function playerMove(m) {
        applyMove(m);
        saveGame();
        var res = engine.result();
        if (res) { endGame(res); return; }
        if (mode === 'bot') scheduleBot();
        else paintStatus();
    }

    function scheduleBot() {
        busy = true;
        paintStatus();
        setTimeout(function () {
            var r = bot.best();
            if (!r) {
                busy = false;
                paintStatus();
                return;
            }

            selSq = r.move.from;
            targets = [];
            paintSquare(selSq);

            setTimeout(function () {
                selSq = -1;
                applyMove(r.move);
                saveGame();
                busy = false;
                var res = engine.result();
                if (res) { endGame(res); return; }
                paintStatus();
            }, BOT_SELECT_MS);
        }, BOT_WAIT_MS);
    }

    // ---------- lifecycle ----------
    function newGame(lvl, side, md) {
        engine = new E();
        bot = new Bot(engine, lvl);
        level = lvl;
        playerSide = side;
        mode = md === '2p' ? '2p' : 'bot';
        flipped = side === 'b';
        gameOver = false;
        busy = false;
        lastMove = null;
        moveLog = [];
        selSq = -1; targets = [];
        checkSq = -1;
        resTitle = ''; resBody = '';
        store.set('pc_level', lvl);
        store.set('pc_mode', mode);
        $('over-pop').className = 'board-pop';
        showPlay();
        rebuildBoard();
        paintBoard();
        paintChrome();
        saveGame();
        if (mode === 'bot' && playerSide === 'b') scheduleBot();
    }

    function endGame(res) {
        gameOver = true;
        store.del('pc_save');

        var we = 1 / (1 + Math.pow(10, (oppRating(level) - elo) / 400));
        var score = (res.result === 'd') ? 0.5 : (res.result === playerSide ? 1 : 0);
        var delta = mode === '2p' ? 0 : Math.round(24 * (score - we));
        if (mode !== '2p') {
            elo = Math.max(100, elo + delta);
            store.set('pc_elo', elo);
        }

        var reasons = {
            checkmate: 'checkmate',
            king: 'king captured',
            stalemate: 'stalemate',
            fifty: 'fifty-move rule',
            threefold: 'threefold repetition',
            material: 'insufficient material'
        };

        var title, body;
        var dstr = (delta >= 0 ? '+' : '') + delta;
        if (mode === '2p') {
            title = res.result === 'd' ? 'DRAW'
                : (res.result === 'w' ? 'WHITE WINS' : 'BLACK WINS');
            body = 'by ' + reasons[res.reason];
        } else if (res.result === 'd') {
            title = 'DRAW';
            body = reasons[res.reason] + ' &middot; rating ' + dstr;
        } else if (res.result === playerSide) {
            title = 'YOU WIN';
            body = 'by ' + reasons[res.reason] + ' &middot; rating ' + dstr;
        } else {
            title = 'BOT WINS';
            body = 'by ' + reasons[res.reason] + ' &middot; rating ' + dstr;
        }

        // header notice + compact popup over the board centre
        resTitle = title;
        resBody = body;
        $('over-title').innerHTML = title;
        $('over-body').innerHTML = body;
        $('over-pop').className = 'board-pop show';
        paintStatus();
    }

    // ---------- persistence ----------
    function saveGame() {
        store.set('pc_save', {
            mode: mode,
            lvl: level,
            side: playerSide,
            moves: moveLog,
            elo: elo
        });
    }

    function resumeGame() {
        var s = store.get('pc_save', null);
        if (!s || !s.moves) { newGame(1, 'w', 'bot'); return; }
        engine = new E();
        bot = new Bot(engine, s.lvl || 1);
        level = s.lvl || 1;
        playerSide = s.side || 'w';
        mode = s.mode === '2p' ? '2p' : 'bot';
        flipped = playerSide === 'b';
        gameOver = false;
        busy = false;
        moveLog = [];
        lastMove = null;
        selSq = -1; targets = [];
        checkSq = -1;

        var i, m;
        for (i = 0; i < s.moves.length; i++) {
            var rec = s.moves[i];
            m = engine.findPseudo(rec.f, rec.t, rec.p || undefined);
            if (!m) break;
            engine.make(m);
            moveLog.push(rec);
            lastMove = { from: m.from, to: m.to };
        }

        resTitle = ''; resBody = '';
        $('over-pop').className = 'board-pop';
        showPlay();
        rebuildBoard();
        paintBoard();
        paintChrome();

        var res = engine.result();
        if (res) { endGame(res); return; }

        if (mode === 'bot' && (engine.whiteToMove ? 'w' : 'b') !== playerSide) {
            scheduleBot();
        } else {
            paintStatus();
        }
    }

    // ---------- controls ----------
    function undo() {
        if (busy) return;
        if (!engine.history.length) return;
        gameOver = false;
        resTitle = ''; resBody = '';
        $('over-pop').className = 'board-pop';

        var plies = 1;
        var mover = engine.whiteToMove ? 'w' : 'b';
        if (mode === 'bot' && mover === playerSide && engine.history.length >= 2) plies = 2;

        var i, m;
        for (i = 0; i < plies; i++) {
            m = engine.unmake();
            if (!m) break;
            moveLog.pop();
        }
        if (moveLog.length) {
            var last = moveLog[moveLog.length - 1];
            lastMove = { from: last.f, to: last.t };
        } else {
            lastMove = null;
        }
        clearSelRepaint();
        paintBoard();
        paintChrome();
        saveGame();

        if (mode === 'bot' && (engine.whiteToMove ? 'w' : 'b') !== playerSide && !gameOver) {
            scheduleBot();
        }
    }

    // ---------- init ----------
    var segLevel, segSide, segMode;

    function init() {
        preload();
        buildBoard();
        sizeBoard();

        segLevel = store.get('pc_level', 1);
        if (!segLevel || segLevel < 1 || segLevel > 5) segLevel = 1;
        level = segLevel;
        segSide = 'w';
        playerSide = 'w';
        segMode = store.get('pc_mode', 'bot');
        if (segMode !== '2p') segMode = 'bot';
        mode = segMode;

        $('lvl-list').onclick = function (ev) {
            var t = ev.target || window.event.srcElement;
            while (t && t !== this && t.className.indexOf('lvl-row') === -1) t = t.parentNode;
            if (!t || t === this) return;
            segLevel = parseInt(t.getAttribute('data-v'), 10);
            var rows = this.children, i;
            for (i = 0; i < rows.length; i++) rows[i].className = 'lvl-row';
            t.className = 'lvl-row on';
        };

        $('side-tiles').onclick = function (ev) {
            var t = ev.target || window.event.srcElement;
            while (t && t !== this && t.className.indexOf('side-tile') === -1) t = t.parentNode;
            if (!t || t === this) return;
            segSide = t.getAttribute('data-v');
            var tiles = this.children, i;
            for (i = 0; i < tiles.length; i++) tiles[i].className = 'side-tile';
            t.className = 'side-tile on';
        };

        $('mode-tiles').onclick = function (ev) {
            var t = ev.target || window.event.srcElement;
            while (t && t !== this && t.className.indexOf('side-tile') === -1) t = t.parentNode;
            if (!t || t === this) return;
            segMode = t.getAttribute('data-v');
            var tiles = this.children, i;
            for (i = 0; i < tiles.length; i++) tiles[i].className = 'side-tile';
            t.className = 'side-tile on';
            $('bot-setup').style.display = segMode === '2p' ? 'none' : 'block';
        };

        $('btn-start').onclick = function () { newGame(segLevel, segSide, segMode); };
        $('btn-resume').onclick = function () { resumeGame(); };
        $('btn-menu').onclick = function () { if (!busy) showStart(); };
        $('btn-new').onclick = function () {
            if (busy) return;
            newGame(level, playerSide, mode);
        };
        $('btn-undo').onclick = undo;
        $('btn-new2').onclick = function () {
            if (busy) return;
            newGame(level, playerSide, mode);
        };
        $('btn-close-pop').onclick = function () {
            $('over-pop').className = 'board-pop';
        };

        window.onresize = function () { sizeBoard(); };

        engine = new E();
        bot = new Bot(engine, 1);
        showStart();
    }

    if (document.readyState === 'complete') init();
    else env.onload = init;

    // debug hook (harmless in production)
    env.__pc = function () {
        var cell = sqEls[81];
        return {
            busy: busy, over: gameOver, sel: selSq, ntargets: targets.length,
            side: playerSide, level: level, mode: mode,
            turn: engine ? (engine.whiteToMove ? 'w' : 'b') : '?',
            board: engine ? engine.toFEN() : '?',
            history: engine ? engine.history.length : 0,
            startVisible: document.getElementById('screen-start').className.indexOf('hidden') === -1,
            td81: cell ? cell.innerHTML + '|' + cell.className : 'MISSING'
        };
    };

})(window);
