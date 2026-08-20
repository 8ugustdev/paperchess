/**
 * ====================================================================
 * PAPERCHESS ENGINE — chess rules, ES5, zero dependencies.
 * Written for Kindle e-ink browsers: plain objects, no prototype
 * chains over hot paths, minimal garbage in make/unmake.
 *
 * Board: 10x12 mailbox (120 cells). Valid squares 21..98.
 * Pieces: ints. Empty=0, wP=1..wK=6, bP=-1..bK=-6.
 * ====================================================================
 */
(function (env) { 'use strict';

    var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;

    // Offsets in 120-cell mailbox
    var KNIGHT_D = [-21, -19, -12, -8, 8, 12, 19, 21];
    var KING_D = [-11, -10, -9, -1, 1, 9, 10, 11];
    var BISHOP_D = [-11, -9, 9, 11];
    var ROOK_D = [-10, -1, 1, 10];

    // Castling rights bits
    var CR_WK = 1, CR_WQ = 2, CR_BK = 4, CR_BQ = 8;

    // Move flags
    var F_EP = 1, F_CK = 2, F_CQ = 4, F_DP = 8;

    var FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    var PIECE_CHAR = {}, CHAR_PIECE = {};
    (function () {
        var chars = { 1: 'p', 2: 'n', 3: 'b', 4: 'r', 5: 'q', 6: 'k' };
        for (var v = 1; v <= 6; v++) {
            PIECE_CHAR[v] = chars[v].toUpperCase();
            PIECE_CHAR[-v] = chars[v];
            CHAR_PIECE[chars[v].toUpperCase()] = v;
            CHAR_PIECE[chars[v]] = -v;
        }
    })();

    function onBoard(sq) { return sq >= 21 && sq <= 98 && (sq % 10) !== 0 && (sq % 10) !== 9; }
    function rcToSq(r, c) { return 21 + r * 10 + c; }   // r,c 0..7 from rank7? no: r=0 top (rank8)
    function sqToR(sq) { return Math.floor((sq - 21) / 10); }
    function sqToC(sq) { return (sq - 21) % 10; }
    function sqName(sq) {
        return 'abcdefgh'.charAt(sqToC(sq)) + (8 - sqToR(sq));
    }
    function fileChar(i) { return 'abcdefgh'.charAt(i); }

    function Engine(fen) {
        this.board = new Array(120);
        this.reset(fen || FEN_START);
    }

    Engine.prototype.reset = function (fen) {
        var i;
        for (i = 0; i < 120; i++) this.board[i] = 0;
        this.loadFEN(fen);
    };

    Engine.prototype.loadFEN = function (fen) {
        var parts = fen.split(' ');
        var ranks = parts[0].split('/');
        var r, c, ch, i;

        for (r = 0; r < 8; r++) {
            var cc = 0;
            for (i = 0; i < ranks[r].length; i++) {
                ch = ranks[r].charAt(i);
                if (ch >= '1' && ch <= '8') {
                    cc += ch.charCodeAt(0) - 48;
                } else {
                    this.board[rcToSq(r, cc)] = CHAR_PIECE[ch];
                    cc++;
                }
            }
        }
        this.whiteToMove = (parts[1] || 'w') === 'w';
        this.rights = 0;
        var cr = parts[2] || '-';
        if (cr.indexOf('K') >= 0) this.rights |= CR_WK;
        if (cr.indexOf('Q') >= 0) this.rights |= CR_WQ;
        if (cr.indexOf('k') >= 0) this.rights |= CR_BK;
        if (cr.indexOf('q') >= 0) this.rights |= CR_BQ;
        this.ep = (parts[3] && parts[3] !== '-') ? this.algebraicToSq(parts[3]) : -1;
        this.halfmove = parseInt(parts[4] || '0', 10) || 0;
        this.fullmove = parseInt(parts[5] || '1', 10) || 1;

        this.history = []; this.reps = {};
        this.reps[this.posKey()] = 1;
    };

    Engine.prototype.algebraicToSq = function (s) {
        return rcToSq(8 - parseInt(s.charAt(1), 10), 'abcdefgh'.indexOf(s.charAt(0)));
    };

    Engine.prototype.toFEN = function () {
        var out = '', r, c, blanks, v;
        for (r = 0; r < 8; r++) {
            blanks = 0;
            for (c = 0; c < 8; c++) {
                v = this.board[rcToSq(r, c)];
                if (!v) { blanks++; }
                else {
                    if (blanks) { out += blanks; blanks = 0; }
                    out += PIECE_CHAR[v];
                }
            }
            if (blanks) out += blanks;
            if (r < 7) { out += '/'; }
        }
        out += this.whiteToMove ? ' w ' : ' b ';
        var cr = '';
        if (this.rights & CR_WK) cr += 'K';
        if (this.rights & CR_WQ) cr += 'Q';
        if (this.rights & CR_BK) cr += 'k';
        if (this.rights & CR_BQ) cr += 'q';
        out += (cr || '-') + ' ';
        out += (this.ep >= 0 ? sqName(this.ep) : '-') + ' ';
        out += this.halfmove + ' ' + this.fullmove;
        return out;
    };

    // Repetition key: placement + side to move (standard simplification)
    Engine.prototype.posKey = function () {
        var s = '', i;
        for (i = 21; i <= 98; i++) {
            var v = this.board[i];
            if (v === 0 && !onBoard(i)) { continue; }
            s += (v === 0) ? '.' : PIECE_CHAR[v];
        }
        return s + (this.whiteToMove ? 'w' : 'b');
    };

    Engine.prototype.kingSq = function (white) {
        var target = white ? K : -K, i;
        for (i = 21; i <= 98; i++) {
            if (onBoard(i) && this.board[i] === target) return i;
        }
        return -1;
    };

    Engine.prototype.attacked = function (sq, byWhite) {
        var b = this.board, i, d, t, s;

        // Pawns: a white pawn at p attacks p-9 and p-11, so square sq is
        // attacked by a white pawn sitting at sq+9 or sq+11 (mirror for black).
        var pd = byWhite ? 9 : -9, pd2 = byWhite ? 11 : -11;
        if (b[sq + pd] === (byWhite ? P : -P)) return true;
        if (b[sq + pd2] === (byWhite ? P : -P)) return true;

        // Knights
        for (i = 0; i < 8; i++) {
            if (b[sq + KNIGHT_D[i]] === (byWhite ? N : -N)) return true;
        }

        // Kings
        for (i = 0; i < 8; i++) {
            if (b[sq + KING_D[i]] === (byWhite ? K : -K)) return true;
        }

        // Bishops/queens
        for (i = 0; i < 4; i++) {
            d = BISHOP_D[i]; s = sq + d;
            while (onBoard(s)) {
                t = b[s];
                if (t) {
                    if (t === (byWhite ? B : -B) || t === (byWhite ? Q : -Q)) return true;
                    break;
                }
                s += d;
            }
        }

        // Rooks/queens
        var hit = false;
        for (i = 0; i < 4 && !hit; i++) {
            d = ROOK_D[i]; s = sq + d;
            while (onBoard(s)) {
                t = b[s];
                if (t) {
                    if (t === (byWhite ? R : -R) || t === (byWhite ? Q : -Q)) { hit = true; }
                    break;
                }
                s += d;
            }
        }
        return hit;
    };

    Engine.prototype.inCheck = function (white) {
        var ks = this.kingSq(white);
        return ks >= 0 && this.attacked(ks, !white);
    };

    // Pseudo-legal moves for side to move
    Engine.prototype.genPseudo = function () {
        var list = [], b = this.board, white = this.whiteToMove;
        var sq, t, i, d, s, r, c;

        for (sq = 21; sq <= 98; sq++) {
            if (!onBoard(sq)) continue;
            t = b[sq];
            if (!t || (t > 0) !== white) continue;
            var a = t > 0 ? t : -t; // abs

            if (a === P) {
                var fwd = white ? -10 : 10;
                var startRow = white ? 6 : 1;
                var promoRow = white ? 0 : 7;
                var one = sq + fwd;
                if (onBoard(one) && !b[one]) {
                    if (sqToR(one) === promoRow) {
                        this.pushPromos(list, sq, one, t, 0);
                    } else {
                        list.push({ from: sq, to: one, piece: t, captured: 0, promo: 0, flags: 0 });
                        var two = sq + fwd + fwd;
                        if (sqToR(sq) === startRow && !b[two]) {
                            list.push({ from: sq, to: two, piece: t, captured: 0, promo: 0, flags: F_DP });
                        }
                    }
                }
                for (i = -1; i <= 1; i += 2) {
                    var cap = sq + fwd + i;
                    if (!onBoard(cap)) continue;
                    var tv = b[cap];
                    if (tv && (tv > 0) !== white) {
                        if (sqToR(cap) === promoRow) this.pushPromos(list, sq, cap, t, tv);
                        else list.push({ from: sq, to: cap, piece: t, captured: tv, promo: 0, flags: 0 });
                    } else if (cap === this.ep) {
                        list.push({ from: sq, to: cap, piece: t, captured: white ? -P : P, promo: 0, flags: F_EP });
                    }
                }
            } else if (a === N || a === K) {
                var dirs = a === N ? KNIGHT_D : KING_D;
                for (i = 0; i < dirs.length; i++) {
                    s = sq + dirs[i];
                    if (!onBoard(s)) continue;
                    tv = b[s];
                    if (!tv) {
                        list.push({ from: sq, to: s, piece: t, captured: 0, promo: 0, flags: 0 });
                    } else if ((tv > 0) !== white) {
                        list.push({ from: sq, to: s, piece: t, captured: tv, promo: 0, flags: 0 });
                    }
                }
                if (a === K) this.genCastles(list, sq, white);
            } else {
                var dirs2 = a === B ? BISHOP_D : (a === R ? ROOK_D : KING_D); // Q uses all 8
                for (i = 0; i < dirs2.length; i++) {
                    d = dirs2[i]; s = sq + d;
                    while (onBoard(s)) {
                        tv = b[s];
                        if (!tv) {
                            list.push({ from: sq, to: s, piece: t, captured: 0, promo: 0, flags: 0 });
                        } else {
                            if ((tv > 0) !== white) {
                                list.push({ from: sq, to: s, piece: t, captured: tv, promo: 0, flags: 0 });
                            }
                            break;
                        }
                        s += d;
                    }
                }
            }
        }
        return list;
    };

    Engine.prototype.pushPromos = function (moves, from, to, piece, captured) {
        var vals = [Q, R, B, N], white = piece > 0, i;
        for (i = 0; i < 4; i++) {
            moves.push({ from: from, to: to, piece: piece, captured: captured, promo: white ? vals[i] : -vals[i], flags: 0 });
        }
    };

    Engine.prototype.genCastles = function (moves, sq, white) {
        var b = this.board;
        var home = white ? 95 : 25; // e1 / e8
        if (sq !== home) return;
        var enemy = !white;

        // King must not be in check, not pass attacked squares
        if (this.attacked(sq, enemy)) return;

        if (white && (this.rights & CR_WK) && !b[96] && !b[97] &&
            !this.attacked(96, enemy) && !this.attacked(97, enemy) && b[98] === R) {
            moves.push({ from: sq, to: 97, piece: white ? K : -K, captured: 0, promo: 0, flags: F_CK });
        }
        if (white && (this.rights & CR_WQ) && !b[94] && !b[93] && !b[92] &&
            !this.attacked(94, enemy) && !this.attacked(93, enemy) && b[91] === R) {
            moves.push({ from: sq, to: 93, piece: white ? K : -K, captured: 0, promo: 0, flags: F_CQ });
        }
        if (!white && (this.rights & CR_BK) && !b[26] && !b[27] &&
            !this.attacked(26, enemy) && !this.attacked(27, enemy) && b[28] === -R) {
            moves.push({ from: sq, to: 27, piece: -K, captured: 0, promo: 0, flags: F_CK });
        }
        if (!white && (this.rights & CR_BQ) && !b[24] && !b[23] && !b[22] &&
            !this.attacked(24, enemy) && !this.attacked(23, enemy) && b[21] === -R) {
            moves.push({ from: sq, to: 23, piece: -K, captured: 0, promo: 0, flags: F_CQ });
        }
    };

    Engine.prototype.make = function (m) {
        var b = this.board;
        var white = m.piece > 0;

        var undo = {
            rights: this.rights, ep: this.ep, halfmove: this.halfmove, key: this.posKey()
        };
        this.history.push({ m: m, u: undo });

        b[m.from] = 0;
        b[m.to] = m.promo ? m.promo : m.piece;

        if (m.flags & F_EP) {
            b[m.to + (white ? 10 : -10)] = 0; // captured pawn behind target
        }
        if (m.flags & F_CK) {
            if (white) { b[98] = 0; b[96] = R; } else { b[28] = 0; b[26] = -R; }
        }
        if (m.flags & F_CQ) {
            if (white) { b[91] = 0; b[94] = R; } else { b[21] = 0; b[24] = -R; }
        }

        // Rights updates
        if (m.piece === K) this.rights &= ~(CR_WK | CR_WQ);
        if (m.piece === -K) this.rights &= ~(CR_BK | CR_BQ);
        if (m.from === 98 || m.to === 98) this.rights &= ~CR_WK;
        if (m.from === 91 || m.to === 91) this.rights &= ~CR_WQ;
        if (m.from === 28 || m.to === 28) this.rights &= ~CR_BK;
        if (m.from === 21 || m.to === 21) this.rights &= ~CR_BQ;

        // EP square
        this.ep = (m.flags & F_DP) ? (m.from + (white ? -10 : 10)) : -1;

        // Clocks
        var abs = m.piece > 0 ? m.piece : -m.piece;
        if (abs === P || m.captured) this.halfmove = 0;
        else this.halfmove++;
        if (!white) this.fullmove++;

        this.whiteToMove = !white;

        var k = this.posKey();
        this.reps[k] = (this.reps[k] || 0) + 1;
        return m;
    };

    Engine.prototype.unmake = function () {
        var h = this.history.pop();
        if (!h) return null;
        var m = h.m, u = h.u, b = this.board;
        var white = m.piece > 0;

        var k = this.posKey();
        if (this.reps[k]) {
            this.reps[k]--;
            if (!this.reps[k]) delete this.reps[k];
        }

        b[m.from] = m.piece;
        b[m.to] = 0;

        if (m.flags & F_EP) {
            b[m.to + (white ? 10 : -10)] = m.captured;
        } else if (m.captured) {
            b[m.to] = m.captured;
        }
        if (m.flags & F_CK) {
            if (white) { b[96] = 0; b[98] = R; } else { b[26] = 0; b[28] = -R; }
        }
        if (m.flags & F_CQ) {
            if (white) { b[94] = 0; b[91] = R; } else { b[24] = 0; b[21] = -R; }
        }

        this.rights = u.rights;
        this.ep = u.ep;
        this.halfmove = u.halfmove;
        this.whiteToMove = white;
        if (!white) this.fullmove--;
        return m;
    };

    Engine.prototype.legalMoves = function () {
        var pseudo = this.genPseudo(), ok = [], i;
        var white = this.whiteToMove;
        for (i = 0; i < pseudo.length; i++) {
            this.make(pseudo[i]);
            if (!this.inCheck(white)) ok.push(pseudo[i]);
            this.unmake();
        }
        return ok;
    };

    Engine.prototype.legalFrom = function (sq) {
        var all = this.legalMoves(), out = [], i;
        for (i = 0; i < all.length; i++) {
            if (all[i].from === sq) out.push(all[i]);
        }
        return out;
    };

    // Find a legal move matching from/to (promo resolved by caller)
    Engine.prototype.findMove = function (from, to, promo) {
        var all = this.legalMoves(), i, m;
        for (i = 0; i < all.length; i++) {
            m = all[i];
            if (m.from === from && m.to === to) {
                if (m.promo && promo && m.promo !== promo) continue;
                return m;
            }
        }
        return undefined;
    };

    Engine.prototype.pseudoFrom = function (sq) {
        var all = this.genPseudo(), out = [], i;
        for (i = 0; i < all.length; i++) {
            if (all[i].from === sq) out.push(all[i]);
        }
        return out;
    };

    // Match a pseudo-legal move by from/to (promo optional). Used for
    // free-form play where self-check moves are allowed.
    Engine.prototype.findPseudo = function (from, to, promo) {
        var all = this.genPseudo(), i, m;
        for (i = 0; i < all.length; i++) {
            m = all[i];
            if (m.from === from && m.to === to) {
                if (m.promo && promo && m.promo !== promo) continue;
                return m;
            }
        }
        return undefined;
    };

    // Game result: null when ongoing
    // { over: true, result: 'w'|'b'|'d', reason: 'checkmate'|'stalemate'|... }
    Engine.prototype.result = function () {
        // free-form play: a captured king ends the game at once
        if (this.kingSq(true) < 0) return { over: true, result: 'b', reason: 'king' };
        if (this.kingSq(false) < 0) return { over: true, result: 'w', reason: 'king' };
        if (this.legalMoves().length === 0) {
            if (this.inCheck(this.whiteToMove)) {
                return { over: true, result: this.whiteToMove ? 'b' : 'w', reason: 'checkmate' };
            }
            return { over: true, result: 'd', reason: 'stalemate' };
        }
        if (this.halfmove >= 100) return { over: true, result: 'd', reason: 'fifty' };
        if ((this.reps[this.posKey()] || 0) >= 3) return { over: true, result: 'd', reason: 'threefold' };
        if (this.insufficient()) return { over: true, result: 'd', reason: 'material' };
        return undefined;
    };

    Engine.prototype.insufficient = function () {
        var minors = [0, 0], i, t, a; // [white, black]
        for (i = 21; i <= 98; i++) {
            if (!onBoard(i)) continue;
            t = this.board[i];
            if (!t) continue;
            a = t > 0 ? t : -t;
            if (a === P || a === R || a === Q) return false;
            if (a === B || a === N) minors[t > 0 ? 0 : 1]++;
        }
        return minors[0] <= 1 && minors[1] <= 1;
    };

    // SAN for a legal move in current position (call BEFORE make)
    Engine.prototype.san = function (m) {
        var a = m.piece > 0 ? m.piece : -m.piece;
        var letters = { 1: '', 2: 'N', 3: 'B', 4: 'R', 5: 'Q', 6: 'K' };
        var s = '';

        if (m.flags & F_CK) s = 'O-O';
        else if (m.flags & F_CQ) s = 'O-O-O';
        else {
            if (a === P) {
                if (m.captured) s += fileChar(sqToC(m.from)) + 'x';
                s += sqName(m.to);
                if (m.promo) s += '=' + letters[m.promo > 0 ? m.promo : -m.promo];
            } else {
                s += letters[a];
                // disambiguation
                var others = [], all = this.legalMoves(), i;
                for (i = 0; i < all.length; i++) {
                    var o = all[i];
                    if (o.to === m.to && o.from !== m.from && o.piece === m.piece) others.push(o);
                }
                if (others.length) {
                    var sameFile = false, sameRank = false;
                    for (i = 0; i < others.length; i++) {
                        if (sqToC(others[i].from) === sqToC(m.from)) sameFile = true;
                        if (sqToR(others[i].from) === sqToR(m.from)) sameRank = true;
                    }
                    if (!sameFile) s += fileChar(sqToC(m.from));
                    else if (!sameRank) s += (8 - sqToR(m.from));
                    else s += sqName(m.from);
                }
                if (m.captured) s += 'x';
                s += sqName(m.to);
            }
        }

        // suffix
        var white = this.whiteToMove;
        this.make(m);
        if (this.inCheck(this.whiteToMove)) {
            s += this.legalMoves().length === 0 ? '#' : '+';
        }
        this.unmake();
        return s;
    };

    Engine.prototype.sqName = sqName;
    Engine.prototype.rcToSq = rcToSq;
    Engine.prototype.sqToR = sqToR;
    Engine.prototype.sqToC = sqToC;
    Engine.FEN_START = FEN_START;

    env.PCEngine = Engine;

})(typeof window === 'object' ? window : global);
