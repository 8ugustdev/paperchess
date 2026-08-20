/**
 * ====================================================================
 * PAPERCHESS BOT — alpha-beta search with quiescence, ES5.
 * Tuned for Kindle CPUs: hard time + node budgets, aborts cleanly
 * and returns the best move found so far (iterative deepening).
 *
 * Levels (strength rises with depth):
 *   1 : depth 1, 40% random legal move, tiny eval noise
 *   2 : depth 2, 20% random
 *   3 : depth 3, no randomness
 *   4 : depth 4 + quiescence
 *   5 : depth 5 + quiescence + extended budget
 * ====================================================================
 */
(function (env) { 'use strict';

    var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;

    // Piece worth in centipawns (play-tested blend).
    var VAL = [0, 100, 325, 340, 510, 950, 20000];

    // Positional scores come from small symmetric formulas (centre
    // distance, rank push, shelter bonus) instead of transcribed
    // lookup tables, so every tuning knob lives in one obvious place.
    // Tables are laid out from white's viewpoint: row 0 = rank 8.
    function buildPst(scoreFn) {
        var cells = [], r, c;
        for (r = 0; r < 8; r++) {
            for (c = 0; c < 8; c++) cells.push(scoreFn(8 - r, c + 1));
        }
        return cells;
    }

    function distFromCentre(rank, file) {
        return Math.abs(rank - 4.5) + Math.abs(file - 4.5);
    }

    // Reward for a white pawn sitting on rank rr (1..8).
    var PAWN_PUSH = [0, 0, 0, 3, 8, 16, 32, 58, 0];

    var PST_P = buildPst(function (rr, cf) {
        return PAWN_PUSH[rr] + (cf >= 3 && cf <= 6 ? 4 : -2);
    });
    var PST_N = buildPst(function (rr, cf) {
        return Math.round((7 - distFromCentre(rr, cf)) * 4) + (rr === 1 ? -8 : 0);
    });
    var PST_B = buildPst(function (rr, cf) {
        var diag = (rr === cf || rr + cf === 9) ? 8 : 0;
        return Math.round((7 - distFromCentre(rr, cf)) * 3) + diag;
    });
    var PST_R = buildPst(function (rr, cf) {
        return (rr === 7 ? 18 : 0) + (cf >= 3 && cf <= 6 ? 3 : 0);
    });
    var PST_Q = buildPst(function (rr, cf) {
        return Math.round((7 - distFromCentre(rr, cf)) * 2);
    });
    var PST_K_MID = buildPst(function (rr, cf) {
        var keep = (rr === 1 && (cf === 3 || cf === 7)) ? 20 : 0;
        return Math.round(-distFromCentre(rr, cf) * 5) + keep + (rr <= 2 ? 4 : -12);
    });
    var PST_K_END = buildPst(function (rr, cf) {
        return Math.round((7 - distFromCentre(rr, cf)) * 4);
    });

    var PST = {};
    PST[P] = PST_P; PST[N] = PST_N; PST[B] = PST_B;
    PST[R] = PST_R; PST[Q] = PST_Q; PST[K] = PST_K_MID;

    var LEVELS = {
        1: { depth: 1, q: false, rand: 0.40, noise: 30, budget: 400 },
        2: { depth: 2, q: false, rand: 0.20, noise: 15, budget: 800 },
        3: { depth: 3, q: false, rand: 0,    noise: 0,  budget: 2500 },
        4: { depth: 4, q: true,  rand: 0,    noise: 0,  budget: 6000 },
        5: { depth: 5, q: true,  rand: 0,    noise: 0,  budget: 15000 }
    };

    function Bot(engine, level) {
        this.e = engine;
        this.setLevel(level || 1);
        this.count = 0;
        this.deadline = 0;
        this.aborted = false;
    }

    Bot.prototype.setLevel = function (lvl) {
        this.level = LEVELS[lvl] ? lvl : 1;
        this.cfg = LEVELS[this.level];
    };

    Bot.prototype.eval = function () {
        var e = this.e, b = e.board, score = 0, i, v, a;
        var bigMaterial = 0;

        // Endgame detection: no queens on board
        for (i = 21; i <= 98; i++) {
            v = b[i];
            if (v === Q || v === -Q) { bigMaterial = 1; break; }
        }
        var endgame = !bigMaterial;

        for (i = 21; i <= 98; i++) {
            v = b[i];
            if (!v) continue;
            a = v > 0 ? v : -v;
            var white = v > 0;
            var table = (a === K && endgame) ? PST_K_END : PST[a];
            var val = VAL[a] + table[pstIndex(white, i)];
            score += white ? val : -val;
        }

        return e.whiteToMove ? score : -score;
    };

    function sqToPstIdx(sq) {
        var r = Math.floor((sq - 21) / 10), c = (sq - 21) % 10;
        return r * 8 + c;
    }
    // PSTs are written from white's view (row 0 = rank 8).
    // White pieces index vertically mirrored; black pieces use raw index.
    function pstIndex(white, sq) {
        var idx = sqToPstIdx(sq);
        return white ? (56 - 8 * Math.floor(idx / 8) + (idx % 8)) : idx;
    }

    Bot.prototype.timeUp = function () {
        return (this.count & 1023) === 0 && Date.now() > this.deadline;
    };

    // MVV-LVA-ish ordering: captures by victim value desc, then promos
    Bot.prototype.order = function (list) {
        var i, m, s;
        for (i = 0; i < list.length; i++) {
            m = list[i];
            s = 0;
            if (m.captured) s = 100000 + VAL[m.captured > 0 ? m.captured : -m.captured] * 10 - VAL[m.piece > 0 ? m.piece : -m.piece];
            if (m.promo) s += 90000 + VAL[m.promo > 0 ? m.promo : -m.promo];
            m.score = s;
        }
        list.sort(function (a, b2) { return b2.score - a.score; });
        return list;
    };

    Bot.prototype.qsearch = function (lo, hi) {
        this.count++;
        var stand = this.eval();
        if (stand >= hi) return hi;
        if (stand > lo) lo = stand;

        var e = this.e;
        var raw = e.genPseudo(), caps = [], i;
        for (i = 0; i < raw.length; i++) {
            if (raw[i].captured) caps.push(raw[i]);
        }
        this.order(caps);

        var white = e.whiteToMove;
        for (i = 0; i < caps.length; i++) {
            e.make(caps[i]);
            if (e.inCheck(white)) { e.unmake(); continue; }
            var sc = -this.qsearch(-hi, -lo);
            e.unmake();
            if (sc >= hi) return hi;
            if (sc > lo) lo = sc;
        }
        return lo;
    };

    Bot.prototype.search = function (depth, lo, hi) {
        if (this.aborted) return lo;
        this.count++;
        if (this.timeUp()) { this.aborted = true; return lo; }

        var e = this.e;
        if (depth <= 0) {
            return this.cfg.q ? this.qsearch(lo, hi) : this.eval();
        }

        var moves = this.order(e.genPseudo());
        var white = e.whiteToMove;
        var best = -100000, any = false, i;

        for (i = 0; i < moves.length; i++) {
            e.make(moves[i]);
            if (e.inCheck(white)) { e.unmake(); continue; }
            any = true;
            var sc = -this.search(depth - 1, -hi, -lo);
            e.unmake();
            if (this.aborted) return lo;
            if (sc > best) best = sc;
            if (best > lo) lo = best;
            if (lo >= hi) break;
        }

        if (!any) {
            // mate or stalemate
            return e.inCheck(white) ? -99000 - depth * 100 : 0;
        }
        return best;
    };

    /** Returns {move, san} — best move for side to move. */
    Bot.prototype.best = function () {
        var e = this.e;
        var legal = e.legalMoves();
        if (!legal.length) return null;

        // weak-level blunder: uniform random legal move
        if (this.cfg.rand > 0 && Math.random() < this.cfg.rand) {
            var rm = legal[Math.floor(Math.random() * legal.length)];
            return { move: rm, san: e.san(rm), random: true };
        }

        this.count = 0;
        this.aborted = false;
        this.deadline = Date.now() + this.cfg.budget;

        var bestMove = null, bestScore = -100000, depth, d;
        for (d = 1; d <= this.cfg.depth; d++) {
            depth = d;
            var moves = this.order(e.legalMoves());
            var lo = -100000, curBest = null, curScore = -100000, i;
            for (i = 0; i < moves.length; i++) {
                e.make(moves[i]);
                var sc = -this.search(depth - 1, -100000, -lo);
                e.unmake();
                if (this.aborted) break;
                if (this.cfg.noise) sc += Math.floor((Math.random() - 0.5) * 2 * this.cfg.noise);
                if (sc > curScore) { curScore = sc; curBest = moves[i]; }
                if (sc > lo) lo = sc;
            }
            if (curBest && !this.aborted) {
                bestMove = curBest; bestScore = curScore;
            } else if (this.aborted && !bestMove && curBest) {
                bestMove = curBest; bestScore = curScore;
            }
            if (this.aborted) break;
            if (bestScore > 90000) break; // found mate
        }

        if (!bestMove) bestMove = legal[0];
        return { move: bestMove, san: e.san(bestMove), score: bestScore };
    };

    env.PCBot = Bot;

})(typeof window === 'object' ? window : global);
