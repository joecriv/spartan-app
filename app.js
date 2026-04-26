'use strict';

// ─────────────────────────────────────────────────────────────
//  Clerk auth + Supabase client
// ─────────────────────────────────────────────────────────────
let currentUserId = null;   // Set after Clerk sign-in
let currentUserEmail = null;
let currentShopId = null;

// Supabase client (CDN loaded in index.html before app.js)
const _sb = window.supabase.createClient(BRAND.supabaseUrl, BRAND.supabaseKey);

// ── Debounced Supabase sync ─────────────────────────────────
// localStorage stays as the fast cache. Changes are synced to
// Supabase every 3 seconds after the last write.
let _syncTimer = null;
const SYNC_KEYS = ['spartan_v4', 'spartan_form', 'spartan_pricing', 'spartan_matdb'];

function scheduleSyncToRemote() {
    if (!currentUserId) return;
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(_syncAllToRemote, 3000);
}

async function _syncAllToRemote() {
    if (!currentUserId) return;
    // Snapshot the quote id at the START of the auto-sync. If New Quote
    // resets currentQuoteId to null while we're awaiting user_data upserts,
    // we DON'T want the post-loop check to see a stale id and clobber
    // the row with empty form data.
    const snapshotQuoteId = currentQuoteId;
    // Sync localStorage to user_data (session backup)
    for (const key of SYNC_KEYS) {
        const raw = localStorage.getItem(key);
        if (raw) {
            try {
                const { error } = await _sb.from('user_data').upsert({
                    clerk_user_id: currentUserId,
                    shop_id: currentShopId,
                    storage_key: key,
                    data: JSON.parse(raw),
                    updated_at: new Date().toISOString()
                }, { onConflict: 'clerk_user_id,storage_key' });
                if (error) console.warn('user_data sync failed for', key, error);
            } catch (e) { console.warn('user_data sync threw for', key, e); }
        }
    }
    // Auto-save to the current quote row only if BOTH the snapshot id from
    // the start of this sync AND the current id (which may have been reset
    // mid-loop) are still set and equal. Prevents the race where reset
    // happens during user_data upserts and the post-loop check still sees
    // the old id.
    if (snapshotQuoteId && snapshotQuoteId === currentQuoteId) {
        await saveQuoteToDb();
    } else if (snapshotQuoteId && !currentQuoteId) {
        console.warn('[autoSync] skipping quote save — currentQuoteId was reset mid-sync', snapshotQuoteId);
    }
}

// Force-sync now (used before page unload)
function syncNow() { clearTimeout(_syncTimer); _syncAllToRemote(); }
window.addEventListener('beforeunload', syncNow);

// Pull from Supabase → localStorage (run once on sign-in, before app init)
async function pullFromRemote() {
    if (!currentUserId) return;
    try {
        const { data: rows } = await _sb.from('user_data')
            .select('storage_key, data')
            .eq('clerk_user_id', currentUserId);
        if (rows && rows.length) {
            for (const row of rows) {
                localStorage.setItem(row.storage_key, JSON.stringify(row.data));
            }
        }
    } catch (e) { /* offline or error — use whatever is in localStorage */ }
}

// ── Seat enforcement ────────────────────────────────────────
// Returns { allowed: true, shopId } or { allowed: false, reason }
async function checkSeatAndRegister(clerkUserId, email) {
    const shopId = BRAND.shopId;
    if (!shopId) return { allowed: false, reason: 'No shop configured in config.js.' };
    // 1. Is this user already registered to THIS shop?
    const { data: existing } = await _sb.from('shop_users')
        .select('shop_id')
        .eq('clerk_user_id', clerkUserId)
        .eq('shop_id', shopId)
        .maybeSingle();
    if (existing) {
        return { allowed: true, shopId };
    }
    // 2. Check seat limit for this shop
    const { data: shop } = await _sb.from('shops')
        .select('id, name, max_seats')
        .eq('id', shopId)
        .single();
    if (!shop) return { allowed: false, reason: 'Shop not found. Contact the administrator.' };
    const { count } = await _sb.from('shop_users')
        .select('id', { count: 'exact', head: true })
        .eq('shop_id', shopId);
    if (count >= shop.max_seats) {
        return { allowed: false, reason: `Seat limit reached (${shop.max_seats}/${shop.max_seats}). Contact the administrator to add more seats.` };
    }
    // 3. Register the new user to THIS shop
    await _sb.from('shop_users').insert({
        shop_id: shopId,
        clerk_user_id: clerkUserId,
        email: email,
        role: 'member'
    });
    return { allowed: true, shopId };
}

// ── Clerk initialization ────────────────────────────────────
// Clerk CDN script loads async; we wait for it, then mount sign-in
// or proceed if already signed in. App init is deferred until auth
// is confirmed.
(function initClerk() {
    const statusEl = document.getElementById('login-status');

    async function boot() {
        try {
            // The Clerk CDN script with data-clerk-publishable-key auto-initializes.
            // window.Clerk becomes the loaded instance (not a constructor).
            // Wait until it's fully loaded.
            const clerk = window.Clerk;
            if (!clerk || typeof clerk.load !== 'function') {
                throw new Error('Clerk not initialized. typeof=' + typeof clerk);
            }
            // If not yet loaded, call load() — safe to call even if already loaded
            if (!clerk.loaded) await clerk.load();
            if (clerk.user) {
                await onSignedIn(clerk.user);
            } else {
                if (statusEl) statusEl.textContent = '';
                clerk.mountSignIn(document.getElementById('clerk-sign-in'), {
                    appearance: {
                        variables: { colorPrimary: '#b09030', colorBackground: '#141414', colorText: '#e0ddd5', colorInputBackground: '#0e0e0e', colorInputText: '#e0ddd5' }
                    }
                });
                clerk.addListener(async ({ user }) => {
                    if (user) await onSignedIn(user);
                });
            }
        } catch (e) {
            if (statusEl) { statusEl.style.color = '#e05c5c'; statusEl.textContent = 'Auth error: ' + (e.message || e); }
            console.error('Clerk init error:', e);
        }
    }

    async function onSignedIn(user) {
        const statusEl2 = document.getElementById('login-status');
        if (statusEl2) statusEl2.textContent = 'Checking seat availability...';
        currentUserId = user.id;
        currentUserEmail = user.primaryEmailAddress?.emailAddress || '';
        // Seat enforcement
        const seat = await checkSeatAndRegister(currentUserId, currentUserEmail);
        if (!seat.allowed) {
            if (statusEl2) {
                statusEl2.style.color = '#e05c5c';
                statusEl2.textContent = seat.reason;
            }
            // Sign out so they can try a different account
            window.Clerk.signOut();
            return;
        }
        currentShopId = seat.shopId;
        // Pull remote data → localStorage, then start the app
        if (statusEl2) statusEl2.textContent = 'Loading your data...';
        await pullFromRemote();
        const overlay = document.getElementById('login-overlay');
        if (overlay) overlay.remove();
        initApp();
    }

    // Clerk CDN is async + auto-initializes — poll until window.Clerk has .load
    function waitForClerk() {
        if (window.Clerk && typeof window.Clerk.load === 'function') { boot(); return; }
        setTimeout(waitForClerk, 150);
    }
    waitForClerk();
})();

// ─────────────────────────────────────────────────────────────
//  Main application
// ─────────────────────────────────────────────────────────────
// ─── Brand logo (embedded) ───────────────────────────────────
// Generate PNG logo from canvas (jsPDF can't handle SVG)
const LOGO_DATA_URL = (() => {
    const c = document.createElement('canvas'); c.width = 280; c.height = 120;
    const x = c.getContext('2d');
    // Spartan gold on dark olive
    x.fillStyle = '#b09030';
    x.font = '700 44px Raleway, Helvetica, Arial, sans-serif';
    x.letterSpacing = '8px';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('SPARTAN', 140, 45);
    x.fillStyle = '#8a7a50';
    x.font = '400 16px Raleway, Helvetica, Arial, sans-serif';
    x.letterSpacing = '6px';
    x.fillText('INSTALLATIONS', 140, 85);
    return c.toDataURL('image/png');
})();
// ─────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────
const FOOT          = 48;
const INCH          = 4;
const SNAP_PX       = 4;
const CW            = 960;
const CH            = 720;
const RULER_SZ      = 28;
const HND           = 7;
const MAX_UNDO      = 20;
const CORNER_THRESH = 18;
const EDGE_THRESH   = 16;
const JOINT_THRESH  = 6;

const EDGE_DEFS = {
    none:      { abbr: null,   label: 'None',              color: '#888'    },
    pencil:    { abbr: 'PEN',  label: 'Pencil Edge',       color: '#dd0000' },
    ogee:      { abbr: 'OGE',  label: 'Ogee Edge',         color: '#cc44cc' },
    bullnose:  { abbr: 'BN',   label: 'Bullnose Edge',     color: '#0088dd' },
    halfbull:  { abbr: 'HBN',  label: 'Half Bullnose',     color: '#00aa66' },
    bevel:     { abbr: 'BEV',  label: 'Bevel Edge',        color: '#dd8800' },
    mitered:   { abbr: 'MT',   label: 'Mitered Edge',      color: '#7a3000' },
    special:   { abbr: 'SF',   label: 'Special Finish',    color: '#228B22' },
    joint:     { abbr: 'JT',   label: 'Joint Edge',        color: '#e0457b' },
    waterfall: { abbr: 'WF',   label: 'Waterfall Edge',    color: '#006688' },
};
// All polished subtypes — used for pricing (all use same polish rate)
const POLISHED_TYPES = new Set(['pencil','ogee','bullnose','halfbull','bevel','polished']);

// ─────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────
// ─── Pages ───────────────────────────────────────────────────
let pages = [{ id:1, name:'Page 1', shapes:[], textItems:[], measurements:[], nextId:1, _undo:[] }];
let currentPageIdx = 0;

let shapes    = [];
let nextId    = 1;
let tool      = 'draw';
let selected  = null;
let undoStack = [];
let textItems    = [];       // { id, x, y, text, size }
let measurements = [];       // { id, x1, y1, x2, y2 }
let profileDiags = [];       // { id, type, x, y } — movable edge profile cross-section diagrams
let measurePt1      = null;   // first picked point during measure tool drag
let measureHover    = null;   // current hover position while picking pt2
let selectedMeasure = null;   // id of selected measurement
let selectedText = null;  // id of selected text item
let movingText = false;
let moveTextStart = null; // { mx, my, ox, oy }

let drawing = false, dStart = null, dCur = null;
// Polish Under tool drag state + selection
let drawingPU = false, puParent = null, puStart = null, puCur = null;
let selectedPU = null; // {shapeId, idx}
// Parent-bound subtype items: set when sink popup opens, consumed on confirm
let pendingItemParent = null;
let pendingPlace = null;

let moving = false, moveOff = null;
let resizing = false, resizeH = null, resizeBase = null, resizeMouse = null;
let edgeResizing = null; // { s, kind:'rect'|'l'|'u', side?, edgeIdx?, base, mouse }

let currentPopup      = null;
let editingId         = null;
let sinkMountType     = 'overmount';
let pendingCorner     = null;
let pendingEdge       = null;
let pendingJointShape = null;
let pendingJointPos   = null;
let jointOrientation  = 'v';

let hovCorner     = null;
let hovEdge       = null;
let hovCornerEdge = null;  // { s, key, px, py } for corner arc hover in edge mode
let activeEdgeType = 'pencil';
let chamferPickState = null; // { s, key, step:1|2, edgeA, edgeB, pt1, pt1Edge, hoverPt }
let selectedJoint = null;    // { s, j }
let draggingJoint = false;
let draggingJointRef = null; // { s, j }
let jointSnapCorner = null;  // { x, y } in canvas coords while a joint drag is snapped to an inside corner

// ─────────────────────────────────────────────────────────────
//  Canvas refs
// ─────────────────────────────────────────────────────────────
const cv   = document.getElementById('mainCanvas');
const ctx  = cv.getContext('2d');
const rH   = document.getElementById('rulerH');   const ctxH = rH.getContext('2d');
const rV   = document.getElementById('rulerV');   const ctxV = rV.getContext('2d');
const rC   = document.getElementById('rulerCorner'); const ctxC = rC.getContext('2d');

// ─────────────────────────────────────────────────────────────
//  Utils
// ─────────────────────────────────────────────────────────────
const snap  = v => Math.round(v / SNAP_PX) * SNAP_PX;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const byId  = id => shapes.find(s => s.id === id);

function pxToIn(px) {
    const v = px / INCH;
    return v % 1 === 0 ? v.toFixed(0) : parseFloat(v.toFixed(2)).toString();
}

// ── Fraction display + parsing (1/16" precision) ──────────────
// Format a decimal inch value as a fraction string with inch mark, rounded
// to 1/16. Whole numbers stay whole; fractions are reduced (8/16 → 1/2).
function fmtInches(v) {
    if (v == null || isNaN(v)) return '';
    const sign = v < 0 ? '-' : '';
    v = Math.abs(v);
    const total16 = Math.round(v * 16);
    const whole = Math.floor(total16 / 16);
    let num = total16 - whole * 16;
    let den = 16;
    while (num > 0 && num % 2 === 0) { num /= 2; den /= 2; }
    if (num === 0) return `${sign}${whole}"`;
    if (whole === 0) return `${sign}${num}/${den}"`;
    return `${sign}${whole} ${num}/${den}"`;
}
// Format without the trailing inch mark — for places that already render
// the mark or want the bare number.
function fmtInchesNoMark(v) {
    const s = fmtInches(v);
    return s.replace(/"$/, '');
}
// px → fraction string with inch mark
function pxToInFrac(px) { return fmtInches(px / INCH); }
// Parse a user-entered measurement. Accepts "30", "30.5", "30 1/2",
// "30-1/2", "30 1/2\"", "1/2", "1/2\"". Returns Number or NaN.
function parseInchInput(s) {
    if (s == null) return NaN;
    s = String(s).trim().replace(/[″"]+\s*$/, '').replace(/\s+/g, ' ').trim();
    if (!s) return NaN;
    if (/^-?\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    let m = s.match(/^(-?\d+)[ -](\d+)\/(\d+)$/);
    if (m) {
        const w = parseInt(m[1], 10);
        const num = parseInt(m[2], 10);
        const den = parseInt(m[3], 10);
        if (!den) return NaN;
        return (w < 0 ? -1 : 1) * (Math.abs(w) + num / den);
    }
    m = s.match(/^(-?\d+)\/(\d+)$/);
    if (m) {
        const num = parseInt(m[1], 10);
        const den = parseInt(m[2], 10);
        if (!den) return NaN;
        return num / den;
    }
    return NaN;
}

function mousePos(e) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function normRect(x, y, w, h) {
    return { x: w < 0 ? x+w : x, y: h < 0 ? y+h : y, w: Math.abs(w), h: Math.abs(h) };
}

// Farmhouse sink constants (inches)
const FS_WIDTH_IN = 30;
const FS_DEPTH_IN = 16;

// Returns the farmhouse sink cutout rect in absolute canvas coords plus
// metadata: segYAbs is the position of the outer edge line, dir is +1 if
// the cutout extends downward from segY, -1 if upward.
function farmSinkRectAbs(s) {
    if (!s.farmSink) return null;
    const fsW = FS_WIDTH_IN * INCH, fsD = FS_DEPTH_IN * INCH;
    const fs = s.farmSink;
    if (fs.edge === 'seg') {
        // L/U shapes — seg may be horizontal OR vertical.
        // The storage convention: cx = position along segment, segY = perpendicular coord.
        // Determine segment orientation from the polygon.
        const poly = s.shapeType === 'l' ? lShapePolygon(s)
                   : s.shapeType === 'u' ? uShapePolygon(s)
                   : null;
        if (!poly) return null;
        const segIdx = parseInt(String(fs.segKey || 'seg0').replace('seg',''), 10);
        const cur = poly[segIdx], nxt = poly[(segIdx + 1) % poly.length];
        const isHoriz = Math.abs(cur[1] - nxt[1]) < 0.5;
        const dir = fs.dir || 1;
        if (isHoriz) {
            const cxAbs = s.x + fs.cx;
            const segYAbs = s.y + fs.segY;
            const fsLx = cxAbs - fsW/2;
            const y1 = dir > 0 ? segYAbs : segYAbs - fsD;
            return { x: fsLx, y: y1, w: fsW, h: fsD, segYAbs, dir, cxAbs };
        }
        // vertical segment: cx is y, segY is x. Notch extends along x by dir.
        const cyAbs = s.y + fs.cx;
        const segXAbs = s.x + fs.segY;
        const fsTop = cyAbs - fsW/2;
        const x1 = dir > 0 ? segXAbs : segXAbs - fsD;
        return { x: x1, y: fsTop, w: fsD, h: fsW, segXAbs, dir, cyAbs, vertical: true };
    }
    // Rect — top / bottom / right / left
    if (fs.edge === 'top') {
        const cxAbs = s.x + fs.cx;
        return { x: cxAbs - fsW/2, y: s.y, w: fsW, h: fsD, segYAbs: s.y, dir: 1, cxAbs };
    }
    if (fs.edge === 'bottom') {
        const cxAbs = s.x + fs.cx;
        return { x: cxAbs - fsW/2, y: s.y + s.h - fsD, w: fsW, h: fsD, segYAbs: s.y + s.h, dir: -1, cxAbs };
    }
    if (fs.edge === 'right') {
        const cyAbs = s.y + fs.cx;
        return { x: s.x + s.w - fsD, y: cyAbs - fsW/2, w: fsD, h: fsW, segXAbs: s.x + s.w, dir: -1, cyAbs, vertical: true };
    }
    if (fs.edge === 'left') {
        const cyAbs = s.y + fs.cx;
        return { x: s.x, y: cyAbs - fsW/2, w: fsD, h: fsW, segXAbs: s.x, dir: 1, cyAbs, vertical: true };
    }
    return null;
}

// Returns the edge key whose line hosts the farmhouse sink — 'top'/'bottom' for
// rect, or the segment key (e.g. 'seg2') for L/U shapes.
function farmSinkEdgeKey(s) {
    if (!s.farmSink) return null;
    return s.farmSink.edge === 'seg' ? s.farmSink.segKey : s.farmSink.edge;
}

// Ensures edges[key] has fsLeft/fsRight objects. Called after placing FS so the
// two halves can receive independent profiles. fsLeft = smaller-x side.
function ensureFsHalves(s, edgeKey) {
    if (!s.edges) s.edges = {};
    const cur = s.edges[edgeKey] || { type: 'none' };
    if (!cur.fsLeft)  cur.fsLeft  = { type: cur.type && cur.type !== 'segmented' ? cur.type : 'none' };
    if (!cur.fsRight) cur.fsRight = { type: cur.type && cur.type !== 'segmented' ? cur.type : 'none' };
    s.edges[edgeKey] = cur;
}

function normalizeShape(s) {
    const base = {
        ...s,
        shapeType: s.shapeType || 'rect',
        subtype:   s.subtype   || null,
        corners:   s.corners   || { nw:0, ne:0, se:0, sw:0 },
        joints:    (s.joints   || []).map(j => ({ ...j })),
        cornerEdges: s.cornerEdges || {nw:{type:'none'},ne:{type:'none'},se:{type:'none'},sw:{type:'none'}},
        farmSink:  s.farmSink  || null, // { edge:'top'|'bottom', cx: <px from shape.x> }
        checks:    (s.checks   || []).filter(c => c.cornerKey || c.vertexIdx != null).map(c => ({ ...c })), // corner notches
    };
    if (base.shapeType === 'l') {
        base.notchW      = s.notchW      || 0;
        base.notchH      = s.notchH      || 0;
        base.notchCorner = s.notchCorner || 'ne';
        base.edges = s.edges || { seg0:{type:'none'}, seg1:{type:'none'}, seg2:{type:'none'}, seg3:{type:'none'}, seg4:{type:'none'}, seg5:{type:'none'} };
    } else if (base.shapeType === 'u') {
        base.leftW    = s.leftW    || 0;
        base.rightW   = s.rightW   || 0;
        base.uOpening = s.uOpening || 'top';
        // Asymmetric model with single bottom-strip height (90° angles only)
        const isVertOp = !s.uOpening || s.uOpening === 'top' || s.uOpening === 'bottom';
        const defOuter = isVertOp ? s.h : s.w;
        base.leftH    = s.leftH    ?? defOuter;
        base.rightH   = s.rightH   ?? defOuter;
        // floorH = bottom strip thickness (formerly channelH was depth from top)
        if (s.floorH != null) base.floorH = s.floorH;
        else if (s.channelH != null) base.floorH = defOuter - s.channelH;
        else base.floorH = 0;
        base.edges = s.edges || { seg0:{type:'none'}, seg1:{type:'none'}, seg2:{type:'none'}, seg3:{type:'none'}, seg4:{type:'none'}, seg5:{type:'none'}, seg6:{type:'none'}, seg7:{type:'none'} };
    } else if (base.shapeType === 'bsp') {
        base.edges = s.edges || { seg0:{type:'none'}, seg1:{type:'none'}, seg2:{type:'none'}, seg3:{type:'none'}, seg4:{type:'none'}, seg5:{type:'none'}, seg6:{type:'none'}, seg7:{type:'none'} };
    } else if (base.shapeType === 'circle') {
        base.edges = s.edges || { arc:{type:'none'} };
    } else {
        base.edges = s.edges || { top:{type:'none'}, right:{type:'none'}, bottom:{type:'none'}, left:{type:'none'} };
    }
    return base;
}

function shapeRadii(s) {
    const c = s.corners || { nw:0, ne:0, se:0, sw:0 };
    const mx = Math.min(s.w, s.h) / 2;
    return { nw: Math.min(c.nw||0, mx), ne: Math.min(c.ne||0, mx), se: Math.min(c.se||0, mx), sw: Math.min(c.sw||0, mx) };
}
function shapeChamfers(s) {
    const c = s.chamfers || {};
    // A-side: nw/ne along top (w), se along right (h), sw along bottom (w)
    return {
        nw: Math.min(c.nw||0, s.w/2),
        ne: Math.min(c.ne||0, s.w/2),
        se: Math.min(c.se||0, s.h/2),
        sw: Math.min(c.sw||0, s.w/2),
    };
}
function shapeChamfersB(s) {
    const a = shapeChamfers(s);
    const b = s.chamfersB || {};
    // B-side: nw/sw along left (h), ne/se along right (h) ... wait:
    //   nw-B: along left edge (h)   ne-B: along right edge (h)
    //   se-B: along bottom edge (w) sw-B: along left edge (h)
    // null = symmetric (use A value, re-clamped to B-side max)
    return {
        nw: b.nw != null ? Math.min(b.nw, s.h/2) : Math.min(a.nw, s.h/2),
        ne: b.ne != null ? Math.min(b.ne, s.h/2) : Math.min(a.ne, s.h/2),
        se: b.se != null ? Math.min(b.se, s.w/2) : Math.min(a.se, s.w/2),
        sw: b.sw != null ? Math.min(b.sw, s.h/2) : Math.min(a.sw, s.h/2),
    };
}

// Returns the two edge rays adjacent to a corner, used for chamfer 2-point picking
function getChamferPickEdges(s, key) {
    if (key.startsWith('uc')) {
        const i = parseInt(key.replace('uc', ''));
        const pts = uShapePolygon(s);
        const n = pts.length;
        const curr = pts[i];
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];
        const len1 = Math.hypot(curr[0]-prev[0], curr[1]-prev[1]);
        const len2 = Math.hypot(next[0]-curr[0], next[1]-curr[1]);
        return {
            cornerX: curr[0], cornerY: curr[1],
            edgeA: { ox:curr[0], oy:curr[1], dx:(prev[0]-curr[0])/(len1||1), dy:(prev[1]-curr[1])/(len1||1), maxDist:len1 },
            edgeB: { ox:curr[0], oy:curr[1], dx:(next[0]-curr[0])/(len2||1), dy:(next[1]-curr[1])/(len2||1), maxDist:len2 },
        };
    }
    if (key.startsWith('lc')) {
        const i = parseInt(key.replace('lc', ''));
        const pts = lShapePolygon(s);
        const n = pts.length;
        const curr = pts[i];
        const prev = pts[(i - 1 + n) % n];
        const next = pts[(i + 1) % n];
        const len1 = Math.hypot(curr[0]-prev[0], curr[1]-prev[1]);
        const len2 = Math.hypot(next[0]-curr[0], next[1]-curr[1]);
        return {
            cornerX: curr[0], cornerY: curr[1],
            edgeA: { ox:curr[0], oy:curr[1], dx:(prev[0]-curr[0])/(len1||1), dy:(prev[1]-curr[1])/(len1||1), maxDist:len1 },
            edgeB: { ox:curr[0], oy:curr[1], dx:(next[0]-curr[0])/(len2||1), dy:(next[1]-curr[1])/(len2||1), maxDist:len2 },
        };
    }
    const map = {
        ne: { cx:s.x+s.w, cy:s.y,     eA:{ ox:s.x+s.w, oy:s.y,    dx:-1, dy:0  }, eB:{ ox:s.x+s.w, oy:s.y,    dx:0, dy:1   } },
        nw: { cx:s.x,     cy:s.y,     eA:{ ox:s.x,     oy:s.y,    dx:1,  dy:0  }, eB:{ ox:s.x,     oy:s.y,    dx:0, dy:1   } },
        se: { cx:s.x+s.w, cy:s.y+s.h, eA:{ ox:s.x+s.w, oy:s.y+s.h,dx:0,  dy:-1 }, eB:{ ox:s.x+s.w, oy:s.y+s.h,dx:-1,dy:0  } },
        sw: { cx:s.x,     cy:s.y+s.h, eA:{ ox:s.x,     oy:s.y+s.h,dx:1,  dy:0  }, eB:{ ox:s.x,     oy:s.y+s.h,dx:0, dy:-1 } },
    };
    const c = map[key];
    if (!c) return null;
    // maxDist = the full length of each adjacent edge
    const edgeA = { ...c.eA, maxDist: (c.eA.dx !== 0 ? s.w : s.h) };
    const edgeB = { ...c.eB, maxDist: (c.eB.dx !== 0 ? s.w : s.h) };
    return { cornerX: c.cx, cornerY: c.cy, edgeA, edgeB };
}

// Project mouse onto edge ray and snap to nearest 0.25"
function snapOnEdge(mx, my, edge) {
    const proj = (mx - edge.ox) * edge.dx + (my - edge.oy) * edge.dy;
    const snapUnit = INCH / 4;  // 0.25" in px
    const d = Math.max(0, Math.min(edge.maxDist, Math.round(proj / snapUnit) * snapUnit));
    return { x: edge.ox + edge.dx * d, y: edge.oy + edge.dy * d, dist: d };
}

// Snaps to shape corners/vertices (threshold 12px), then to 0.25" grid
function snapMeasurePoint(mx, my) {
    const SNAP_THRESH = 12;
    let best = null, bestD = SNAP_THRESH;
    for (const s of shapes) {
        const candidates = [];
        if (s.shapeType === 'l') {
            for (const pt of lShapePolygon(s)) candidates.push([pt[0], pt[1]]);
        } else if (s.shapeType === 'u') {
            for (const pt of uShapePolygon(s)) candidates.push([pt[0], pt[1]]);
        } else if (s.shapeType === 'bsp') {
            for (const pt of bspPolygon(s))  candidates.push([pt[0], pt[1]]);
        } else if (s.shapeType === 'circle') {
            const r = s.w/2, cx = s.x+r, cy = s.y+r;
            candidates.push([cx-r,cy],[cx+r,cy],[cx,cy-r],[cx,cy+r]);
        } else {
            candidates.push([s.x,s.y],[s.x+s.w,s.y],[s.x+s.w,s.y+s.h],[s.x,s.y+s.h]);
            candidates.push([s.x+s.w/2,s.y],[s.x+s.w,s.y+s.h/2],[s.x+s.w/2,s.y+s.h],[s.x,s.y+s.h/2]);
        }
        for (const [cx,cy] of candidates) {
            const d = Math.hypot(mx-cx, my-cy);
            if (d < bestD) { bestD = d; best = { x:cx, y:cy, shapeId:s.id, rx:cx-s.x, ry:cy-s.y }; }
        }
    }
    if (best) return best;
    const su = INCH / 4;
    return { x: Math.round(mx/su)*su, y: Math.round(my/su)*su, shapeId:null, rx:0, ry:0 };
}

function resolveMeasureXY(m) {
    let x1=m.x1, y1=m.y1, x2=m.x2, y2=m.y2;
    if (m.s1) { const s=byId(m.s1); if(s){x1=s.x+m.r1x;y1=s.y+m.r1y;} }
    if (m.s2) { const s=byId(m.s2); if(s){x2=s.x+m.r2x;y2=s.y+m.r2y;} }
    return {x1,y1,x2,y2};
}

function drawOneMeasurement(m, hover) {
    const x1 = m.x1, y1 = m.y1, x2 = m.x2 ?? hover?.x, y2 = m.y2 ?? hover?.y;
    if (x2 == null) return;
    const isSelected = m.id != null && m.id === selectedMeasure;
    const userOff = m.offset || 0;

    const lenPx = Math.hypot(x2-x1, y2-y1);
    if (lenPx < INCH * 0.5) return;

    const dx = x2-x1, dy = y2-y1;
    const tx = dx/lenPx, ty = dy/lenPx;
    const onx = ty, ony = -tx;

    const OFFSET = 20 + userOff;
    const EXT = 5;
    const ARR = 7;

    const ex1 = x1 + onx*OFFSET, ey1 = y1 + ony*OFFSET;
    const ex2 = x2 + onx*OFFSET, ey2 = y2 + ony*OFFSET;

    ctx.save();
    const col = isSelected ? '#e07820' : '#445566';
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = isSelected ? 1.2 : 0.8;
    ctx.setLineDash([]);

    ctx.beginPath(); ctx.moveTo(x1 + onx*3, y1 + ony*3); ctx.lineTo(ex1 + onx*EXT, ey1 + ony*EXT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2 + onx*3, y2 + ony*3); ctx.lineTo(ex2 + onx*EXT, ey2 + ony*EXT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex1, ey1); ctx.lineTo(ex2, ey2); ctx.stroke();
    drawArrowHead(ex1, ey1, tx, ty, ARR);
    drawArrowHead(ex2, ey2, -tx, -ty, ARR);

    const mx2 = (ex1+ex2)/2, my2 = (ey1+ey2)/2;
    const rawIn = lenPx / INCH;
    const label = fmtInches(rawIn);
    const dimFs = Math.round(13 * dimSizeMultiplier);
    const dimBgH = Math.round(18 * dimSizeMultiplier);
    ctx.font = `bold ${dimFs}px Raleway,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = '#ffffff'; ctx.fillRect(mx2 - tw/2, my2 - dimBgH/2, tw, dimBgH);
    ctx.fillStyle = isSelected ? '#e07820' : '#1a2a44';
    ctx.fillText(label, mx2, my2);

    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(x1, y1, 3, 0, Math.PI*2); ctx.fill();
    if (m.x2 != null) { ctx.beginPath(); ctx.arc(x2, y2, 3, 0, Math.PI*2); ctx.fill(); }

    ctx.restore();
}

function drawMeasurements() {
    for (const m of measurements) {
        const r = resolveMeasureXY(m);
        drawOneMeasurement({...m, x1:r.x1, y1:r.y1, x2:r.x2, y2:r.y2}, null);
    }
    if (tool !== 'measure') return;
    if (measurePt1 && measureHover) {
        drawOneMeasurement({ x1:measurePt1.x, y1:measurePt1.y }, measureHover);
    } else if (measurePt1) {
        ctx.save(); ctx.fillStyle = '#cc6600'; ctx.globalAlpha = 0.85;
        ctx.beginPath(); ctx.arc(measurePt1.x, measurePt1.y, 5, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha = 1; ctx.restore();
    } else if (measureHover) {
        // Snap dot before first click
        ctx.save(); ctx.strokeStyle = '#cc6600'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.arc(measureHover.x, measureHover.y, 5, 0, Math.PI*2); ctx.stroke();
        ctx.globalAlpha = 1; ctx.restore();
    }
}

// ── Edge Profile Photos (embedded) ───────────────────────────
const EDGE_PROFILE_IMAGES = {
    pencil: "data:image/jpeg;base64,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",
    bullnose: "data:image/jpeg;base64,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",
    ogee: "data:image/jpeg;base64,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",
    bevel: "data:image/jpeg;base64,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",
    halfbull: "data:image/jpeg;base64,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",
    polished: "data:image/jpeg;base64,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",
};
const _edgeImgCache = {};
function getEdgeImg(type) {
    const url = EDGE_PROFILE_IMAGES[type];
    if (!url) return null;
    if (_edgeImgCache[type]) return _edgeImgCache[type];
    const img = new Image(); img.src = url;
    _edgeImgCache[type] = img; return img;
}
Object.keys(EDGE_PROFILE_IMAGES).forEach(getEdgeImg);
// ── Edge Profile Cross-section Diagrams (movable) ────────────
const DIAG_DEF_W = 200, DIAG_DEF_H = 140;
let selectedDiag = null, movingDiag = false, moveDiagOff = {x:0,y:0};
let selectedFarmSinkShapeId = null;
let resizingDiag = false, resizeDiagBase = null;

const EDGE_LABELS = {pencil:'PENCIL EDGE',polished:'PENCIL EDGE',ogee:'OGEE EDGE',bullnose:'BULLNOSE EDGE',halfbull:'HALF BULLNOSE EDGE',bevel:'BEVELED EDGE'};

function drawProfileDiags() {
    for (const d of profileDiags) {
        const isSel = d.id === selectedDiag;
        const dw = d.w || DIAG_DEF_W, dh = d.h || DIAG_DEF_H;
        const img = getEdgeImg(d.type);
        const barH = 24;
        const imgH = dh - barH;
        const color = EDGE_DEFS[d.type]?.color || '#fff';

        ctx.save();
        // Photo area with rounded top corners
        if (img && img.complete && img.naturalWidth > 0) {
            ctx.beginPath(); ctx.roundRect(d.x, d.y, dw, imgH, [6,6,0,0]); ctx.clip();
            ctx.drawImage(img, d.x, d.y, dw, imgH);
            ctx.restore(); ctx.save();
        } else {
            ctx.fillStyle = '#3a352e';
            ctx.beginPath(); ctx.roundRect(d.x, d.y, dw, imgH, [6,6,0,0]); ctx.fill();
        }
        // Label bar at bottom with edge color
        ctx.fillStyle = 'rgba(20,18,15,0.92)';
        ctx.beginPath(); ctx.roundRect(d.x, d.y + imgH, dw, barH, [0,0,6,6]); ctx.fill();
        const fontSize = Math.max(9, Math.min(13, dw / 16));
        ctx.font = `bold ${fontSize}px Raleway,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = color;
        ctx.fillText(EDGE_LABELS[d.type] || d.type.toUpperCase(), d.x + dw/2, d.y + imgH + barH/2);
        // Border
        ctx.strokeStyle = isSel ? '#b09030' : 'rgba(255,255,255,0.15)'; ctx.lineWidth = isSel ? 2.5 : 1;
        ctx.beginPath(); ctx.roundRect(d.x, d.y, dw, dh, 6); ctx.stroke();
        // Resize handle (bottom-right corner) when selected
        if (isSel) {
            const hx = d.x + dw - 10, hy = d.y + dh - 10;
            ctx.fillStyle = '#b09030'; ctx.globalAlpha = 0.8;
            ctx.beginPath(); ctx.moveTo(hx+10, hy); ctx.lineTo(hx+10, hy+10); ctx.lineTo(hx, hy+10); ctx.closePath(); ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.restore();
    }
}
// Diameter of the × delete button on each profile diagram, in canvas px.
const DIAG_X_SIZE = 20;
function hitDiagDelete(mx, my) {
    const r = DIAG_X_SIZE / 2;
    for (let i = profileDiags.length - 1; i >= 0; i--) {
        const d = profileDiags[i];
        const dw = d.w || DIAG_DEF_W;
        const cx = d.x + dw - r - 4, cy = d.y + r + 4;
        const ddx = mx - cx, ddy = my - cy;
        if (ddx*ddx + ddy*ddy <= r*r) return d;
    }
    return null;
}

function hitProfileDiag(mx, my) {
    for (let i = profileDiags.length - 1; i >= 0; i--) {
        const d = profileDiags[i];
        const dw = d.w || DIAG_DEF_W, dh = d.h || DIAG_DEF_H;
        if (mx >= d.x && mx <= d.x+dw && my >= d.y && my <= d.y+dh) return d;
    }
    return null;
}

function hitDiagResize(mx, my) {
    if (selectedDiag === null) return false;
    const d = profileDiags.find(d => d.id === selectedDiag);
    if (!d) return false;
    const dw = d.w || DIAG_DEF_W, dh = d.h || DIAG_DEF_H;
    return mx >= d.x + dw - 14 && my >= d.y + dh - 14;
}

function drawChamferPickUI() {
    if (!chamferPickState) return;
    const { step, edgeA, edgeB, pt1, hoverPt } = chamferPickState;
    ctx.save();

    // Draw snap dots along edge: large dots every 1", small dots every 0.25"
    const drawEdgeDots = (edge, active) => {
        const snapUnit = INCH / 4;
        for (let d = snapUnit; d <= edge.maxDist - snapUnit/2; d += snapUnit) {
            const px = edge.ox + edge.dx * d, py = edge.oy + edge.dy * d;
            const isMajor = Math.abs(Math.round(d / INCH) * INCH - d) < 0.5;
            const r = isMajor ? (active ? 4 : 3) : (active ? 2 : 1.5);
            ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2);
            ctx.fillStyle = active ? '#b09030' : '#446644';
            ctx.globalAlpha = isMajor ? (active ? 0.9 : 0.5) : (active ? 0.5 : 0.25);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    };

    if (step === 1) {
        drawEdgeDots(edgeA, true);
        drawEdgeDots(edgeB, true);
    } else {
        // step 2: active edge (remaining) + dimmed locked edge for reference
        const remaining = chamferPickState.pt1Edge === 'a' ? edgeB : edgeA;
        const locked    = chamferPickState.pt1Edge === 'a' ? edgeA : edgeB;
        drawEdgeDots(locked, false);
        drawEdgeDots(remaining, true);
    }

    // Fixed pt1
    if (pt1) {
        ctx.beginPath(); ctx.arc(pt1.x, pt1.y, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#b09030'; ctx.globalAlpha = 1; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Hover point
    if (hoverPt) {
        ctx.beginPath(); ctx.arc(hoverPt.x, hoverPt.y, 6, 0, Math.PI * 2);
        ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2; ctx.globalAlpha = 0.85; ctx.stroke();
    }

    // Preview diagonal in step 2
    if (step === 2 && pt1 && hoverPt) {
        ctx.beginPath(); ctx.moveTo(pt1.x, pt1.y); ctx.lineTo(hoverPt.x, hoverPt.y);
        ctx.setLineDash([4, 3]); ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
        ctx.globalAlpha = 0.7; ctx.stroke();
    }

    ctx.globalAlpha = 1; ctx.setLineDash([]); ctx.restore();
}

// ─────────────────────────────────────────────────────────────
//  L-Shape helpers
// ─────────────────────────────────────────────────────────────
function lShapePolygon(s) {
    const { x, y, w, h } = s;
    const nW = s.notchW || 0, nH = s.notchH || 0;
    switch (s.notchCorner || 'ne') {
        case 'ne': return [[x,y],[x+w-nW,y],[x+w-nW,y+nH],[x+w,y+nH],[x+w,y+h],[x,y+h]];
        case 'nw': return [[x+nW,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y+nH],[x+nW,y+nH]];
        case 'se': return [[x,y],[x+w,y],[x+w,y+h-nH],[x+w-nW,y+h-nH],[x+w-nW,y+h],[x,y+h]];
        case 'sw': return [[x,y],[x+w,y],[x+w,y+h],[x+nW,y+h],[x+nW,y+h-nH],[x,y+h-nH]];
    }
}
const L_SIDE_LABELS = {
    ne: ['Top','Inner Vert.','Inner Horiz.','Right','Bottom','Left'],
    nw: ['Top','Right','Bottom','Left','Inner Horiz.','Inner Vert.'],
    se: ['Top','Right','Inner Horiz.','Inner Vert.','Bottom','Left'],
    sw: ['Top','Right','Bottom','Inner Vert.','Inner Horiz.','Left'],
};
const L_CORNER_LABELS = {
    ne: ['NW','Step Top','Inner','Step Right','SE','SW'],
    nw: ['Step Top','NE','SE','SW','Step Left','Inner'],
    se: ['NW','NE','Step Right','Inner','Step Bot','SW'],
    sw: ['NW','NE','SE','Step Bot','Inner','Step Left'],
};
// Physical role of each polygon vertex index, keyed by notchCorner.
// Used to remap corner-check vertexIdx when the L-shape rotates.
const L_ROLES = {
    ne: ['NW','StepTop','Inner','StepRight','SE','SW'],
    se: ['NW','NE','StepRight','Inner','StepBot','SW'],
    sw: ['NW','NE','SE','StepBot','Inner','StepLeft'],
    nw: ['StepTop','NE','SE','SW','StepLeft','Inner'],
};
// How each role rotates under a 90° CW shape rotation.
const L_ROLE_ROT_CW = {
    NW:'NE', NE:'SE', SE:'SW', SW:'NW',
    StepTop:'StepRight', StepRight:'StepBot', StepBot:'StepLeft', StepLeft:'StepTop',
    Inner:'Inner',
};
function lVertexIdxAfterRotationCW(oldNotchCorner, oldIdx, newNotchCorner) {
    const oldRole = L_ROLES[oldNotchCorner]?.[oldIdx];
    if (!oldRole) return oldIdx;
    const newRole = L_ROLE_ROT_CW[oldRole] || oldRole;
    const newIdx = L_ROLES[newNotchCorner]?.indexOf(newRole);
    return newIdx >= 0 ? newIdx : oldIdx;
}

// Remaps an object whose keys are <prefix><i> (e.g., lc0..lc5 or seg0..seg5)
// from the old L-shape vertex/segment numbering to the new one after a 90° CW
// rotation. Both vertex- and segment-keyed properties use the same mapping
// because adjacency is preserved by the rotation.
function lRemapKeyedDataCW(oldData, prefix, oldNotch, newNotch) {
    if (!oldData) return null;
    const out = {};
    for (let i = 0; i < 6; i++) {
        const v = oldData[prefix + i];
        if (v != null) {
            const newIdx = lVertexIdxAfterRotationCW(oldNotch, i, newNotch);
            out[prefix + newIdx] = v;
        }
    }
    return out;
}

// ── Farm-sink rotation helpers ────────────────────────────────────
// Returns the FS center point and inward-normal vector in OLD shape-local
// pixels. Works for rect (top/bottom/right/left) and L/U (seg).
function fsCenterAndNormal(s, oldPolygon) {
    if (!s.farmSink) return null;
    const fs = s.farmSink;
    const fsW = FS_WIDTH_IN * INCH, fsD = FS_DEPTH_IN * INCH;
    if (fs.edge === 'top')    return { center: [fs.cx, 0],       normal: [0,  1] };
    if (fs.edge === 'bottom') return { center: [fs.cx, s.h],     normal: [0, -1] };
    if (fs.edge === 'right')  return { center: [s.w,    fs.cx],  normal: [-1, 0] };
    if (fs.edge === 'left')   return { center: [0,      fs.cx],  normal: [ 1, 0] };
    if (fs.edge === 'seg' && oldPolygon) {
        const segIdx = parseInt(String(fs.segKey || 'seg0').replace('seg',''), 10);
        if (!(segIdx >= 0 && segIdx < oldPolygon.length)) return null;
        const cur = oldPolygon[segIdx];
        const nxt = oldPolygon[(segIdx + 1) % oldPolygon.length];
        const isHoriz = Math.abs(cur[1] - nxt[1]) < 0.5;
        if (isHoriz) {
            // cx = x along seg, segY = y of seg. Center is on the segment line.
            return { center: [fs.cx, fs.segY], normal: [0, fs.dir || 1] };
        }
        // Vertical: cx = y along seg, segY = x of seg.
        return { center: [fs.segY, fs.cx], normal: [fs.dir || 1, 0] };
    }
    return null;
}

// Auto-detects which segment of newPolygon contains the given center+normal.
// Returns segIdx (>=0) on success, -1 otherwise. Handles small rounding via
// the tol arg (default 1.5px ≈ 3/8"). The normal must be axis-aligned.
function fsFindSegFromPoint(newPolygon, center, normal, tol) {
    tol = tol == null ? 1.5 : tol;
    const wantHorizSeg = Math.abs(normal[1]) > 0.5;
    const wantVertSeg  = Math.abs(normal[0]) > 0.5;
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < newPolygon.length; i++) {
        const a = newPolygon[i], b = newPolygon[(i+1) % newPolygon.length];
        const isHoriz = Math.abs(a[1] - b[1]) < 0.5;
        const isVert  = Math.abs(a[0] - b[0]) < 0.5;
        if (wantHorizSeg && !isHoriz) continue;
        if (wantVertSeg  && !isVert)  continue;
        let dist;
        if (isHoriz) {
            const segY = a[1];
            const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
            if (center[0] < minX - tol || center[0] > maxX + tol) continue;
            dist = Math.abs(center[1] - segY);
        } else {
            const segX = a[0];
            const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
            if (center[1] < minY - tol || center[1] > maxY + tol) continue;
            dist = Math.abs(center[0] - segX);
        }
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    return (bestDist <= tol * 4) ? bestIdx : -1;
}
// Strip stale fsLeft/fsRight halves from any edge that isn't the current
// FS edge. Called after rotation so leftover halves don't render on a
// segment whose role has changed.
function clearStaleFsHalves(s) {
    if (!s.edges) return;
    const fsKey = farmSinkEdgeKey(s);
    for (const k of Object.keys(s.edges)) {
        if (k === fsKey) continue;
        const e = s.edges[k];
        if (e && (e.fsLeft || e.fsRight)) {
            delete e.fsLeft;
            delete e.fsRight;
        }
    }
}
// Capture FS center in WORLD coordinates so a subsequent geometry mutation
// (resize, edge-drag) can restore the FS to the same absolute spot.
function fsCaptureWorld(s) {
    if (!s.farmSink) return null;
    const fr = farmSinkRectAbs(s);
    if (!fr) return null;
    if (fr.vertical) return { wx: fr.segXAbs,  wy: fr.cyAbs };
    return { wx: fr.cxAbs, wy: fr.segYAbs };
}
// Restore FS so its world center sits at the same point on whatever edge
// (top/bottom/left/right/seg) currently passes through it. For seg edges,
// refresh segY and clamp cx into the edge length. If the FS would land
// outside the new edge length, clamp cx to the nearest valid spot.
function fsRestoreWorld(s, snap) {
    if (!s.farmSink || !snap) return;
    const fs = s.farmSink;
    const fsW = FS_WIDTH_IN * INCH, fsD = FS_DEPTH_IN * INCH;
    const halfW = fsW / 2;
    if (fs.edge === 'top' || fs.edge === 'bottom') {
        const localX = snap.wx - s.x;
        fs.cx = Math.max(halfW, Math.min(s.w - halfW, localX));
    } else if (fs.edge === 'left' || fs.edge === 'right') {
        const localY = snap.wy - s.y;
        fs.cx = Math.max(halfW, Math.min(s.h - halfW, localY));
    } else if (fs.edge === 'seg') {
        const poly = s.shapeType === 'l' ? lShapePolygon(s)
                   : s.shapeType === 'u' ? uShapePolygon(s) : null;
        if (!poly) return;
        const segIdx = parseInt(String(fs.segKey).replace('seg',''), 10);
        if (segIdx < 0 || segIdx >= poly.length) return;
        const cur = poly[segIdx], nxt = poly[(segIdx + 1) % poly.length];
        const isHoriz = Math.abs(cur[1] - nxt[1]) < 0.5;
        if (isHoriz) {
            const minX = Math.min(cur[0], nxt[0]) - s.x;
            const maxX = Math.max(cur[0], nxt[0]) - s.x;
            fs.cx = Math.max(minX + halfW, Math.min(maxX - halfW, snap.wx - s.x));
            fs.segY = cur[1] - s.y;
        } else {
            const minY = Math.min(cur[1], nxt[1]) - s.y;
            const maxY = Math.max(cur[1], nxt[1]) - s.y;
            fs.cx = Math.max(minY + halfW, Math.min(maxY - halfW, snap.wy - s.y));
            fs.segY = cur[0] - s.x;
        }
    }
}

// Given a center point + normal in NEW shape-local pixels, builds a farm-sink
// data object compatible with the rendering. For rect, newKey is the new
// edge ('top'/'right'/'bottom'/'left'). For L/U, newKey is the segKey
// ('seg0'..) and newPolygon is the new shape's polygon.
function fsFromCenterNormal(s, center, normal, newKey, newPolygon) {
    if (newKey === 'top' || newKey === 'bottom' || newKey === 'right' || newKey === 'left') {
        const cx = (newKey === 'top' || newKey === 'bottom') ? center[0] : center[1];
        return { edge: newKey, cx };
    }
    // seg
    if (newPolygon) {
        const segIdx = parseInt(String(newKey).replace('seg',''), 10);
        if (segIdx >= 0 && segIdx < newPolygon.length) {
            const cur = newPolygon[segIdx];
            const nxt = newPolygon[(segIdx + 1) % newPolygon.length];
            const isHoriz = Math.abs(cur[1] - nxt[1]) < 0.5;
            if (isHoriz) {
                return { edge: 'seg', segKey: newKey, cx: center[0], segY: center[1], dir: normal[1] > 0 ? 1 : -1 };
            }
            return { edge: 'seg', segKey: newKey, cx: center[1], segY: center[0], dir: normal[0] > 0 ? 1 : -1 };
        }
    }
    return null;
}

// Rotates s.joints[] 90° CW. Top-left pinned + dim swap means:
//   'v' joint at pos=X  →  'h' joint at pos=X
//   'h' joint at pos=Y  →  'v' joint at pos=(oldH - Y)
//   'd' joint stays diagonal; both snap and otherSnap rotate as points.
// snap.relX/relY rotate via the standard CW shape-local transform.
// Rotate polish-under rectangles 90° CW with the parent shape.
// A rect at shape-local (rx, ry) sized (rw, rh) becomes (oldH - ry - rh, rx)
// sized (rh, rw) after the (px, py) → (oldH - py, px) shape rotation.
function rotatePolishUndersCW(s, oldH_local) {
    if (!s.polishUnders || !s.polishUnders.length) return;
    s.polishUnders = s.polishUnders.map(r => ({
        x: oldH_local - r.y - r.h,
        y: r.x,
        w: r.h,
        h: r.w
    }));
}
// Rotate parent-bound child items (sinks/cooktops/outlets/boccis) 90° CW
// with their parent. Position rotates around parent origin (top-left pinned)
// and dimensions swap so a wide item becomes tall and vice versa.
function rotateChildItemsCW(parent, oldH_local) {
    for (const child of shapes) {
        if (child.parentId !== parent.id) continue;
        const cx = child.x - parent.x;
        const cy = child.y - parent.y;
        const ch = child.h;
        child.x = parent.x + (oldH_local - cy - ch);
        child.y = parent.y + cx;
        const ow = child.w;
        child.w = child.h;
        child.h = ow;
    }
}
function rotateJointsCW(s, oldH_local) {
    if (!s.joints || !s.joints.length) return;
    const rotPt = (relX, relY) => ({ relX: oldH_local - relY, relY: relX });
    for (const j of s.joints) {
        if (j.axis === 'd') {
            if (j.snap)      j.snap      = rotPt(j.snap.relX,      j.snap.relY);
            if (j.otherSnap) j.otherSnap = rotPt(j.otherSnap.relX, j.otherSnap.relY);
            continue;
        }
        if (j.axis === 'v') {
            j.axis = 'h';
        } else if (j.axis === 'h') {
            j.axis = 'v';
            j.pos = oldH_local - j.pos;
        }
        if (j.snap) j.snap = rotPt(j.snap.relX, j.snap.relY);
    }
}
function lShapeSides(s) {
    const pts = lShapePolygon(s);
    const labels = L_SIDE_LABELS[s.notchCorner || 'ne'];
    return pts.map((p, i) => {
        const j = (i+1) % 6;
        return { key:`seg${i}`, label:labels[i], x1:p[0], y1:p[1], x2:pts[j][0], y2:pts[j][1] };
    });
}
// ─────────────────────────────────────────────────────────────
//  U-Shape helpers
// ─────────────────────────────────────────────────────────────
function uShapePolygon(s) {
    // Build canonical 'top' polygon first, then rotate based on uOpening.
    // ALL angles are 90° — bottom is flat, asymmetric arm heights show as differing top Ys.
    const op = s.uOpening || 'top';
    const isVert = (op === 'top' || op === 'bottom');
    const A  = isVert ? s.w : s.h;
    const H  = isVert ? s.h : s.w;
    const lH = s.leftH  ?? H;
    const rH = s.rightH ?? H;
    const lW = s.leftW  || 0;
    const rW = s.rightW || 0;
    // floorH = thickness of the bottom strip (from line A up to the channel floor)
    // Backward compat: if old fields exist, derive from channelH.
    let fH;
    if (s.floorH != null) fH = s.floorH;
    else if (s.channelH != null) fH = H - s.channelH; // legacy symmetric
    else fH = 0;

    const bottomY = H;          // canonical bottom = bbox height
    const floorY  = H - fH;     // top of bottom strip / floor of inner channel
    const leftTopY  = H - lH;
    const rightTopY = H - rH;

    // Canonical 'top' polygon — clockwise from bottom-left
    let pts = [
        [0, bottomY],          // 0 bottom-left
        [0, leftTopY],         // 1 top-left
        [lW, leftTopY],        // 2 top of left arm right edge
        [lW, floorY],          // 3 channel floor left
        [A - rW, floorY],      // 4 channel floor right
        [A - rW, rightTopY],   // 5 top of right arm left edge
        [A, rightTopY],        // 6 top-right
        [A, bottomY],          // 7 bottom-right
    ];
    // Rotate to actual orientation
    if (op === 'right') {
        pts = pts.map(([px, py]) => [H - py, px]);
    } else if (op === 'bottom') {
        pts = pts.map(([px, py]) => [A - px, H - py]);
    } else if (op === 'left') {
        pts = pts.map(([px, py]) => [py, A - px]);
    }
    return pts.map(([px, py]) => [s.x + px, s.y + py]);
}
const U_SIDE_LABELS = {
    top:    ['Left Outer','Left Arm','Left Inner','Channel Floor','Right Inner','Right Arm','Right Outer','Bottom'],
    bottom: ['Right Outer','Right Arm','Right Inner','Channel Floor','Left Inner','Left Arm','Left Outer','Top'],
    right:  ['Top Outer','Top Arm','Top Inner','Channel Floor','Bottom Inner','Bottom Arm','Bottom Outer','Left'],
    left:   ['Bottom Outer','Bottom Arm','Bottom Inner','Channel Floor','Top Inner','Top Arm','Top Outer','Right'],
};
// Shoelace area in pixels²
function uShapeAreaPx(s) {
    const pts = uShapePolygon(s);
    let a = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    }
    return Math.abs(a) / 2;
}
function uShapeSides(s) {
    const pts = uShapePolygon(s);
    const labels = U_SIDE_LABELS[s.uOpening || 'top'];
    return pts.map((p, i) => {
        const j = (i+1) % 8;
        return { key:`seg${i}`, label:labels[i], x1:p[0], y1:p[1], x2:pts[j][0], y2:pts[j][1] };
    });
}

// ─────────────────────────────────────────────────────────────
//  BSP (Backsplash T-shape) helpers
// ─────────────────────────────────────────────────────────────
function bspPolygon(s) {
    const px = s.pX !== undefined ? s.pX : Math.round((s.w - s.pW) / 2);
    return [
        [s.x + px,           s.y        ],   // 0: top-left of protrusion
        [s.x + px + s.pW,    s.y        ],   // 1: top-right of protrusion
        [s.x + px + s.pW,    s.y + s.pH ],   // 2: inner-right
        [s.x + s.w,          s.y + s.pH ],   // 3: far-right at step line
        [s.x + s.w,          s.y + s.h  ],   // 4: bottom-right
        [s.x,                s.y + s.h  ],   // 5: bottom-left
        [s.x,                s.y + s.pH ],   // 6: far-left at step line
        [s.x + px,           s.y + s.pH ],   // 7: inner-left
    ];
}
function bspSides(s) {
    const pts = bspPolygon(s);
    return pts.map((p, i) => {
        const j=(i+1)%8;
        return { key:`seg${i}`, x1:p[0], y1:p[1], x2:pts[j][0], y2:pts[j][1] };
    });
}

function polygonCentroid(pts) {
    let area=0, cx=0, cy=0;
    for (let i=0,n=pts.length; i<n; i++) {
        const j=(i+1)%n, c=pts[i][0]*pts[j][1]-pts[j][0]*pts[i][1];
        area+=c; cx+=(pts[i][0]+pts[j][0])*c; cy+=(pts[i][1]+pts[j][1])*c;
    }
    area/=2; return { x:cx/(6*area), y:cy/(6*area) };
}
function pointInPolygon(px, py, pts) {
    let inside=false;
    for (let i=0,j=pts.length-1; i<pts.length; j=i++) {
        const xi=pts[i][0],yi=pts[i][1],xj=pts[j][0],yj=pts[j][1];
        if (((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
}
function distToSegment(px, py, x1, y1, x2, y2) {
    const dx=x2-x1, dy=y2-y1, len2=dx*dx+dy*dy;
    if (!len2) return Math.hypot(px-x1, py-y1);
    const t=Math.max(0,Math.min(1,((px-x1)*dx+(py-y1)*dy)/len2));
    return Math.hypot(px-(x1+t*dx), py-(y1+t*dy));
}

// ─────────────────────────────────────────────────────────────
//  Undo / Persist
// ─────────────────────────────────────────────────────────────
// ── sync active page vars ↔ pages[] ──────────────────────────
function syncPageOut() {
    const p = pages[currentPageIdx];
    p.shapes       = shapes.map(s => JSON.parse(JSON.stringify(s)));
    p.textItems    = textItems.map(t => ({...t}));
    p.measurements = measurements.map(m => ({...m}));
    p.profileDiags = profileDiags.map(d => ({...d}));
    p.nextId       = nextId;
    p._undo        = undoStack.slice();
}
function syncPageIn() {
    const p = pages[currentPageIdx];
    shapes       = (p.shapes||[]).map(normalizeShape);
    textItems    = (p.textItems||[]).map(t => ({...t}));
    measurements = (p.measurements||[]).map(m => ({...m}));
    profileDiags = (p.profileDiags||[]).map(d => ({...d}));
    nextId       = p.nextId||1;
    undoStack    = (p._undo||[]).slice();
}

function pushUndo() {
    undoStack.push(JSON.stringify({ shapes, nextId, textItems, profileDiags }));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
}
function undo() {
    if (!undoStack.length) return;
    const st = JSON.parse(undoStack.pop());
    shapes = st.shapes.map(normalizeShape); nextId = st.nextId; textItems = st.textItems||[]; profileDiags = st.profileDiags||[];
    selected = null; selectedJoint = null; selectedText = null; selectedDiag = null;
    persist(); render(); updateStatus();
}
function persist() {
    syncPageOut();
    // Save pages without _undo (transient)
    const save = pages.map(p => ({ id:p.id, name:p.name, shapes:p.shapes, textItems:p.textItems, measurements:p.measurements||[], nextId:p.nextId }));
    // Include slab layout (bgImage stored as data URL — can be large but needed for session restore)
    localStorage.setItem('spartan_v4', JSON.stringify({ pages: save, currentPageIdx, slabDefs, slabPlaced, _slabNextId }));
    scheduleSyncToRemote();
}
function persistSlab() {
    try {
        const existing = JSON.parse(localStorage.getItem('spartan_v4') || '{}');
        existing.slabDefs     = slabDefs;
        existing.slabPlaced   = slabPlaced;
        existing._slabNextId  = _slabNextId;
        localStorage.setItem('spartan_v4', JSON.stringify(existing));
        scheduleSyncToRemote();
    } catch(e) { /* storage full or parse error — non-fatal */ }
}
function load() {
    try {
        // v4: multi-page format
        // TODO: Supabase — fetch latest session payload for the signed-in user
        const v4raw = localStorage.getItem('spartan_v4');
        if (v4raw) {
            const d = JSON.parse(v4raw);
            pages = (d.pages||[]).map(p => ({ id:p.id||1, name:p.name||'Page 1', shapes:(p.shapes||[]).map(normalizeShape), textItems:p.textItems||[], measurements:p.measurements||[], nextId:p.nextId||1, _undo:[] }));
            if (!pages.length) pages = [{ id:1, name:'Page 1', shapes:[], textItems:[], nextId:1, _undo:[] }];
            currentPageIdx = Math.max(0, Math.min(d.currentPageIdx||0, pages.length-1));
            // Restore slab layout
            if (d.slabDefs && d.slabDefs.length) slabDefs = d.slabDefs;
            if (d.slabPlaced) slabPlaced = d.slabPlaced;
            if (d._slabNextId) _slabNextId = d._slabNextId;
            syncPageIn();
            return;
        }
        // v3/v2: single-page legacy
        // TODO: Supabase — legacy migration path, remote store should own format versioning
        const d = JSON.parse(localStorage.getItem('spartan_v3') || localStorage.getItem('spartan_v2') || 'null');
        if (d) {
            pages[0].shapes    = (d.shapes||[]).map(normalizeShape);
            pages[0].textItems = d.textItems||[];
            pages[0].nextId    = d.nextId||1;
        }
        syncPageIn();
    } catch(e) { syncPageIn(); }
}

// ─────────────────────────────────────────────────────────────
//  Hit testing
// ─────────────────────────────────────────────────────────────
function handles(s) {
    if (s.shapeType === 'l') return [];
    if (s.shapeType === 'u') return [];
    if (s.shapeType === 'bsp') return [];
    if (s.shapeType === 'circle') return [];
    const { x, y, w, h } = s;
    return [
        { id:'nw', px:x,     py:y,     cur:'nw-resize' }, { id:'n',  px:x+w/2, py:y,     cur:'n-resize'  },
        { id:'ne', px:x+w,   py:y,     cur:'ne-resize' }, { id:'e',  px:x+w,   py:y+h/2, cur:'e-resize'  },
        { id:'se', px:x+w,   py:y+h,   cur:'se-resize' }, { id:'s',  px:x+w/2, py:y+h,   cur:'s-resize'  },
        { id:'sw', px:x,     py:y+h,   cur:'sw-resize' }, { id:'w',  px:x,     py:y+h/2, cur:'w-resize'  },
    ];
}
function hitHandle(s, mx, my) {
    const R = Math.floor(HND/2) + 2;
    return handles(s).find(h => Math.abs(mx-h.px) <= R && Math.abs(my-h.py) <= R) || null;
}
// Returns true if (x, y) lies inside any countertop piece (non-subtype shape).
// Used to constrain parent-bound items (sinks, cooktops, outlets, boccis).
function pointInsideAnyPiece(x, y) {
    for (const shape of shapes) {
        if (shape.subtype) continue;
        if (shape.shapeType === 'l') {
            if (pointInPolygon(x, y, lShapePolygon(shape))) return true;
        } else if (shape.shapeType === 'u') {
            if (pointInPolygon(x, y, uShapePolygon(shape))) return true;
        } else if (shape.shapeType === 'bsp') {
            if (pointInPolygon(x, y, bspPolygon(shape))) return true;
        } else if (shape.shapeType === 'circle') {
            const r = shape.w / 2;
            if (Math.hypot(x - (shape.x + r), y - (shape.y + r)) <= r) return true;
        } else {
            if (x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h) return true;
        }
    }
    return false;
}
// True when a parent-bound item's center lies inside ANY piece. Items
// without parentId (legacy) always pass.
function itemIsOnPiece(s) {
    if (!s.subtype || s.parentId == null) return true;
    return pointInsideAnyPiece(s.x + s.w / 2, s.y + s.h / 2);
}
function hitShape(mx, my) {
    for (let i = shapes.length-1; i >= 0; i--) {
        const s = shapes[i];
        if (s.shapeType === 'l') {
            const poly = lShapePolygon(s);
            if (pointInPolygon(mx, my, poly)) return s;
            for (let i = 0; i < poly.length; i++) {
                const j = (i+1) % poly.length;
                if (distToSegment(mx, my, poly[i][0], poly[i][1], poly[j][0], poly[j][1]) <= EDGE_THRESH) return s;
            }
        } else if (s.shapeType === 'u') {
            const poly = uShapePolygon(s);
            if (pointInPolygon(mx, my, poly)) return s;
            for (let i = 0; i < poly.length; i++) {
                const j = (i+1) % poly.length;
                if (distToSegment(mx, my, poly[i][0], poly[i][1], poly[j][0], poly[j][1]) <= EDGE_THRESH) return s;
            }
        } else if (s.shapeType === 'bsp') {
            const poly = bspPolygon(s);
            if (pointInPolygon(mx, my, poly)) return s;
            for (let i = 0; i < poly.length; i++) {
                const j = (i+1) % poly.length;
                if (distToSegment(mx, my, poly[i][0], poly[i][1], poly[j][0], poly[j][1]) <= EDGE_THRESH) return s;
            }
        } else if (s.shapeType === 'circle') {
            const r = s.w / 2;
            if (Math.hypot(mx - (s.x + r), my - (s.y + r)) <= r) return s;
        } else {
            if (mx >= s.x && mx <= s.x+s.w && my >= s.y && my <= s.y+s.h) return s;
        }
    }
    return null;
}
function nearestCorner(mx, my) {
    let best = null, bestD = CORNER_THRESH;
    for (const s of shapes) {
        if (s.shapeType === 'circle') continue;
        if (s.shapeType === 'l') {
            const poly = lShapePolygon(s);
            const lbls = L_CORNER_LABELS[s.notchCorner || 'ne'];
            poly.forEach(([px, py], i) => {
                const d = Math.hypot(mx-px, my-py);
                if (d < bestD) { bestD = d; best = { s, key:`lc${i}`, label: lbls[i], px, py }; }
            });
            continue;
        }
        if (s.shapeType === 'u') {
            const poly = uShapePolygon(s);
            poly.forEach(([px, py], i) => {
                const d = Math.hypot(mx-px, my-py);
                if (d < bestD) { bestD = d; best = { s, key:`uc${i}`, label: `U${i}`, px, py }; }
            });
            continue;
        }
        for (const [key, px, py] of [['nw',s.x,s.y],['ne',s.x+s.w,s.y],['se',s.x+s.w,s.y+s.h],['sw',s.x,s.y+s.h]]) {
            const d = Math.hypot(mx-px, my-py);
            if (d < bestD) { bestD = d; best = { s, key, px, py }; }
        }
    }
    return best;
}
function nearestEdge(mx, my) {
    let best = null, bestD = EDGE_THRESH;
    for (const s of shapes) {
        if (s.shapeType === 'circle') {
            const r = s.w / 2, cx = s.x + r, cy = s.y + r;
            const d = Math.abs(Math.hypot(mx - cx, my - cy) - r);
            if (d < bestD) { bestD = d; best = { s, key:'arc', label:'Arc', cx, cy, r }; }
        } else if (s.shapeType === 'l') {
            const sides = lShapeSides(s);
            for (const sd of sides) {
                const d = distToSegment(mx, my, sd.x1, sd.y1, sd.x2, sd.y2);
                if (d < bestD) { bestD = d; best = { s, key:sd.key, label:sd.label, x1:sd.x1, y1:sd.y1, x2:sd.x2, y2:sd.y2 }; }
            }
            // L-shape chamfer diagonals
            const lverts = lShapeVerts(s);
            for (let i = 0; i < lverts.length; i++) {
                const nv = lverts[i];
                if (nv.t <= 0 || nv.r > 0) continue;
                const dk = `diag_lc${i}`;
                const d = distToSegment(mx, my, nv.pin[0], nv.pin[1], nv.pout[0], nv.pout[1]);
                if (d < bestD) { bestD = d; best = { s, key:dk, label:'Chanfrein L'+i, x1:nv.pin[0], y1:nv.pin[1], x2:nv.pout[0], y2:nv.pout[1] }; }
            }
            // Check notch walls (per check)
            if (s.checks && s.checks.length) {
                const basePoly = lShapePolygon(s);
                for (const c of s.checks) {
                    if (c.vertexIdx == null) continue;
                    const cp = cornerCheckPoints(basePoly, c.vertexIdx, c);
                    if (!cp) continue;
                    const dac = distToSegment(mx, my, cp.A[0], cp.A[1], cp.C[0], cp.C[1]);
                    if (dac < bestD) { bestD = dac; best = { s, key: `lck${c.vertexIdx}_ac`, label: `Check ${c.vertexIdx} A`, x1:cp.A[0], y1:cp.A[1], x2:cp.C[0], y2:cp.C[1] }; }
                    const dcb = distToSegment(mx, my, cp.C[0], cp.C[1], cp.B[0], cp.B[1]);
                    if (dcb < bestD) { bestD = dcb; best = { s, key: `lck${c.vertexIdx}_cb`, label: `Check ${c.vertexIdx} B`, x1:cp.C[0], y1:cp.C[1], x2:cp.B[0], y2:cp.B[1] }; }
                }
            }
        } else if (s.shapeType === 'u') {
            const uverts = uShapeVerts(s);
            // Border segments adjusted to corner treatments (like L-shape)
            for (let i = 0; i < uverts.length; i++) {
                const v = uverts[i], nv = uverts[(i+1)%uverts.length];
                const d = distToSegment(mx, my, v.pout[0], v.pout[1], nv.pin[0], nv.pin[1]);
                if (d < bestD) { bestD = d; best = { s, key:`seg${i}`, label:(U_SIDE_LABELS[s.uOpening||'top']||[])[i]||`U${i}`, x1:v.pout[0], y1:v.pout[1], x2:nv.pin[0], y2:nv.pin[1] }; }
            }
            // Chamfer diagonals at each vertex with a chamfer treatment
            for (let i = 0; i < uverts.length; i++) {
                const nv = uverts[i];
                if (nv.t <= 0 || nv.r > 0) continue;
                const dk = `diag_uc${i}`;
                const d = distToSegment(mx, my, nv.pin[0], nv.pin[1], nv.pout[0], nv.pout[1]);
                if (d < bestD) { bestD = d; best = { s, key:dk, label:'Chanfrein U'+i, x1:nv.pin[0], y1:nv.pin[1], x2:nv.pout[0], y2:nv.pout[1] }; }
            }
            // Check notch walls
            if (s.checks && s.checks.length) {
                const basePoly = uShapePolygon(s);
                for (const c of s.checks) {
                    if (c.vertexIdx == null) continue;
                    const cp = cornerCheckPoints(basePoly, c.vertexIdx, c);
                    if (!cp) continue;
                    const dac = distToSegment(mx, my, cp.A[0], cp.A[1], cp.C[0], cp.C[1]);
                    if (dac < bestD) { bestD = dac; best = { s, key: `uck${c.vertexIdx}_ac`, label: `Check ${c.vertexIdx} A`, x1:cp.A[0], y1:cp.A[1], x2:cp.C[0], y2:cp.C[1] }; }
                    const dcb = distToSegment(mx, my, cp.C[0], cp.C[1], cp.B[0], cp.B[1]);
                    if (dcb < bestD) { bestD = dcb; best = { s, key: `uck${c.vertexIdx}_cb`, label: `Check ${c.vertexIdx} B`, x1:cp.C[0], y1:cp.C[1], x2:cp.B[0], y2:cp.B[1] }; }
                }
            }
        } else if (s.shapeType === 'bsp') {
            const sides = bspSides(s);
            for (const sd of sides) {
                const d = distToSegment(mx, my, sd.x1, sd.y1, sd.x2, sd.y2);
                if (d < bestD) { bestD = d; best = { s, key:sd.key, label:sd.key, x1:sd.x1, y1:sd.y1, x2:sd.x2, y2:sd.y2 }; }
            }
        } else {
            const r = shapeRadii(s);
            const ch = shapeChamfers(s);
            const chB2 = shapeChamfersB(s);
            const tnw = ch.nw || r.nw || 0, tne = ch.ne || r.ne || 0;
            const bsw = ch.sw || r.sw || 0, bse = ch.se || r.se || 0;
            const lnw = chB2.nw || r.nw || 0, lsw = chB2.sw || r.sw || 0;
            const rne = chB2.ne || r.ne || 0, rse = chB2.se || r.se || 0;
            const cands = [
                { key:'top',    x1:s.x+tnw,       y1:s.y,       x2:s.x+s.w-tne, y2:s.y       },
                { key:'bottom', x1:s.x+s.w-bse,   y1:s.y+s.h,   x2:s.x+bsw,     y2:s.y+s.h   },
                { key:'left',   x1:s.x,           y1:s.y+s.h-lsw, x2:s.x,        y2:s.y+lnw   },
                { key:'right',  x1:s.x+s.w,       y1:s.y+rne,   x2:s.x+s.w,     y2:s.y+s.h-rse },
            ];
            for (const c of cands) {
                const d = distToSegment(mx, my, c.x1, c.y1, c.x2, c.y2);
                if (d < bestD) { bestD = d; best = { s, key:c.key, label:c.key, x1:c.x1, y1:c.y1, x2:c.x2, y2:c.y2 }; }
            }
            const diagCands = [
                { key:'diag_nw', x1:s.x+ch.nw,     y1:s.y,           x2:s.x,          y2:s.y+chB2.nw       },
                { key:'diag_ne', x1:s.x+s.w-ch.ne, y1:s.y,           x2:s.x+s.w,      y2:s.y+chB2.ne       },
                { key:'diag_se', x1:s.x+s.w,        y1:s.y+s.h-ch.se, x2:s.x+s.w-chB2.se, y2:s.y+s.h      },
                { key:'diag_sw', x1:s.x+ch.sw,      y1:s.y+s.h,       x2:s.x,          y2:s.y+s.h-chB2.sw  },
            ];
            for (const dc of diagCands) {
                const ck = dc.key.replace('diag_','');
                if (ch[ck] <= 0) continue;
                const d = distToSegment(mx, my, dc.x1, dc.y1, dc.x2, dc.y2);
                if (d < bestD) { bestD = d; best = { s, key:dc.key, label:'Chanfrein '+ck.toUpperCase(), x1:dc.x1, y1:dc.y1, x2:dc.x2, y2:dc.y2 }; }
            }
            // Rect check notch walls — selectable for edge profiles
            if (s.checks && s.checks.length) {
                for (const c of s.checks) {
                    if (!c.cornerKey) continue;
                    const w = c.w, d = c.d;
                    let ckCands = [];
                    if (c.cornerKey === 'nw') {
                        ckCands = [
                            { key:'ck_nw_h', x1: s.x,     y1: s.y + d, x2: s.x + w, y2: s.y + d },
                            { key:'ck_nw_v', x1: s.x + w, y1: s.y + d, x2: s.x + w, y2: s.y     },
                        ];
                    } else if (c.cornerKey === 'ne') {
                        ckCands = [
                            { key:'ck_ne_v', x1: s.x + s.w - w, y1: s.y,     x2: s.x + s.w - w, y2: s.y + d },
                            { key:'ck_ne_h', x1: s.x + s.w - w, y1: s.y + d, x2: s.x + s.w,     y2: s.y + d },
                        ];
                    } else if (c.cornerKey === 'se') {
                        ckCands = [
                            { key:'ck_se_h', x1: s.x + s.w,     y1: s.y + s.h - d, x2: s.x + s.w - w, y2: s.y + s.h - d },
                            { key:'ck_se_v', x1: s.x + s.w - w, y1: s.y + s.h - d, x2: s.x + s.w - w, y2: s.y + s.h     },
                        ];
                    } else if (c.cornerKey === 'sw') {
                        ckCands = [
                            { key:'ck_sw_v', x1: s.x + w, y1: s.y + s.h,     x2: s.x + w, y2: s.y + s.h - d },
                            { key:'ck_sw_h', x1: s.x + w, y1: s.y + s.h - d, x2: s.x,     y2: s.y + s.h - d },
                        ];
                    }
                    for (const cd of ckCands) {
                        const dist = distToSegment(mx, my, cd.x1, cd.y1, cd.x2, cd.y2);
                        if (dist < bestD) { bestD = dist; best = { s, key: cd.key, label: 'Check '+c.cornerKey.toUpperCase(), x1: cd.x1, y1: cd.y1, x2: cd.x2, y2: cd.y2 }; }
                    }
                }
            }
        }
    }
    return best;
}
function nearestCornerForEdge(mx, my) {
    const THRESH = 18;
    for (const s of shapes) {
        if (s.shapeType === 'bsp' || s.shapeType === 'circle') continue;
        // L-shape: each vertex can have a radius. Pick the arc midpoint via pin/pout.
        if (s.shapeType === 'l') {
            const verts = lShapeVerts(s);
            for (let i = 0; i < verts.length; i++) {
                const nv = verts[i];
                if (!(nv.r > 0)) continue;
                // Arc midpoint ≈ midpoint of pin→pout swept around curr
                const midX = (nv.pin[0] + nv.pout[0]) / 2;
                const midY = (nv.pin[1] + nv.pout[1]) / 2;
                // Push outward from curr by a small factor so the pick point lands on the arc
                const dx = midX - nv.curr[0], dy = midY - nv.curr[1];
                const d = Math.hypot(dx, dy) || 1;
                const mpx = nv.curr[0] + (dx/d) * nv.r;
                const mpy = nv.curr[1] + (dy/d) * nv.r;
                if (Math.hypot(mx - mpx, my - mpy) < THRESH) return { s, key: `lc${i}`, px: mpx, py: mpy };
            }
            continue;
        }
        // U-shape: pick arc midpoint for radiused vertices (accurate pick point)
        if (s.shapeType === 'u') {
            const verts = uShapeVerts(s);
            for (let i = 0; i < verts.length; i++) {
                const nv = verts[i];
                if (!(nv.r > 0)) continue;
                const midX = (nv.pin[0] + nv.pout[0]) / 2;
                const midY = (nv.pin[1] + nv.pout[1]) / 2;
                const dx = midX - nv.curr[0], dy = midY - nv.curr[1];
                const d = Math.hypot(dx, dy) || 1;
                const mpx = nv.curr[0] + (dx/d) * nv.r;
                const mpy = nv.curr[1] + (dy/d) * nv.r;
                if (Math.hypot(mx - mpx, my - mpy) < THRESH) return { s, key: `uc${i}`, px: mpx, py: mpy };
            }
            continue;
        }
        // Rectangle (default)
        const r = shapeRadii(s);
        const corners = [
            { key:'nw', cx:s.x+r.nw,     cy:s.y+r.nw,     startA:Math.PI,       endA:1.5*Math.PI, r:r.nw },
            { key:'ne', cx:s.x+s.w-r.ne, cy:s.y+r.ne,     startA:1.5*Math.PI,   endA:2*Math.PI,   r:r.ne },
            { key:'se', cx:s.x+s.w-r.se, cy:s.y+s.h-r.se, startA:0,             endA:0.5*Math.PI, r:r.se },
            { key:'sw', cx:s.x+r.sw,     cy:s.y+s.h-r.sw, startA:0.5*Math.PI,   endA:Math.PI,     r:r.sw },
        ];
        for (const c of corners) {
            if (c.r <= 0) continue;
            const midA = (c.startA + c.endA) / 2;
            const mpx = c.cx + Math.cos(midA) * c.r;
            const mpy = c.cy + Math.sin(midA) * c.r;
            if (Math.hypot(mx - mpx, my - mpy) < THRESH) return { s, key: c.key, px: mpx, py: mpy };
        }
    }
    return null;
}

// Returns inside (reflex/concave) corners in canvas coords for a shape.
// Plus: corners of adjacent rectangles that land on this shape's boundary
// (common in multi-piece layouts where two rectangles meet to form an L).
function getInsideCornersForJoint(s) {
    const out = [];

    // 1. Reflex vertices of the shape's own polygon (L-shape notch, U-shape channel)
    let poly = null;
    if (s.shapeType === 'l')      poly = lShapePolygon(s);
    else if (s.shapeType === 'u') poly = uShapePolygon(s);
    else if (s.shapeType === 'bsp') poly = bspPolygon(s);
    if (poly && poly.length >= 4) {
        const n = poly.length;
        let totalCross = 0;
        for (let i = 0; i < n; i++) {
            const a = poly[i], b = poly[(i+1)%n], c = poly[(i+2)%n];
            totalCross += (b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]);
        }
        const pos = totalCross > 0;
        for (let i = 0; i < n; i++) {
            const a = poly[i], b = poly[(i+1)%n], c = poly[(i+2)%n];
            const cross = (b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0]);
            if ((pos && cross < 0) || (!pos && cross > 0)) {
                out.push({ x: b[0], y: b[1] });
            }
        }
    }

    // 2. Multi-piece layouts: corners of other rect shapes that land on THIS shape's
    //    boundary (not at a corner of this shape) — the meeting point of two pieces
    //    is an inside corner of the combined outline.
    const EPS = 0.5;
    const onSegBetween = (px, py, x1, y1, x2, y2) => {
        // Axis-aligned segments only (rectangle edges)
        if (Math.abs(x1 - x2) < EPS) {
            // vertical segment
            if (Math.abs(px - x1) > EPS) return false;
            return py > Math.min(y1, y2) + EPS && py < Math.max(y1, y2) - EPS;
        }
        if (Math.abs(y1 - y2) < EPS) {
            // horizontal segment
            if (Math.abs(py - y1) > EPS) return false;
            return px > Math.min(x1, x2) + EPS && px < Math.max(x1, x2) - EPS;
        }
        return false;
    };
    const sEdges = (s.shapeType === 'rect' || !s.shapeType)
        ? [[s.x, s.y, s.x+s.w, s.y], [s.x+s.w, s.y, s.x+s.w, s.y+s.h],
           [s.x+s.w, s.y+s.h, s.x, s.y+s.h], [s.x, s.y+s.h, s.x, s.y]]
        : null;
    if (sEdges) {
        for (const other of shapes) {
            if (other === s || other.subtype) continue;
            if (other.shapeType !== 'rect' && other.shapeType) continue;
            const corners = [
                [other.x,           other.y],
                [other.x + other.w, other.y],
                [other.x + other.w, other.y + other.h],
                [other.x,           other.y + other.h],
            ];
            for (const [cx, cy] of corners) {
                for (const [x1, y1, x2, y2] of sEdges) {
                    if (onSegBetween(cx, cy, x1, y1, x2, y2)) {
                        out.push({ x: cx, y: cy });
                        break;
                    }
                }
            }
        }
    }
    return out;
}

function hitJoint(mx, my) {
    for (const s of shapes) {
        for (const j of (s.joints || [])) {
            if (j.axis === 'v') {
                const jx = s.x + j.pos;
                if (Math.abs(mx-jx) < JOINT_THRESH && my >= s.y-2 && my <= s.y+s.h+2) return { s, j };
            } else {
                const jy = s.y + j.pos;
                if (Math.abs(my-jy) < JOINT_THRESH && mx >= s.x-2 && mx <= s.x+s.w+2) return { s, j };
            }
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
//  Resize
// ─────────────────────────────────────────────────────────────
function applyResize(pos) {
    const s = byId(selected); if (!s) return;
    const fsSnap = fsCaptureWorld(s);
    const oldX = s.x, oldY = s.y;
    const b = resizeBase;
    const dx = snap(pos.x - resizeMouse.x), dy = snap(pos.y - resizeMouse.y);
    let { x, y, w, h } = b;
    switch (resizeH) {
        case 'se': w=Math.max(INCH,b.w+dx); h=Math.max(INCH,b.h+dy); break;
        case 'sw': x=b.x+dx; w=Math.max(INCH,b.w-dx); h=Math.max(INCH,b.h+dy); break;
        case 'ne': w=Math.max(INCH,b.w+dx); y=b.y+dy; h=Math.max(INCH,b.h-dy); break;
        case 'nw': x=b.x+dx; y=b.y+dy; w=Math.max(INCH,b.w-dx); h=Math.max(INCH,b.h-dy); break;
        case 'e':  w=Math.max(INCH,b.w+dx); break;
        case 'w':  x=b.x+dx; w=Math.max(INCH,b.w-dx); break;
        case 's':  h=Math.max(INCH,b.h+dy); break;
        case 'n':  y=b.y+dy; h=Math.max(INCH,b.h-dy); break;
    }
    if (x < 0) { w += x; x = 0; } if (y < 0) { h += y; y = 0; }
    if (x+w > CW) w = CW-x; if (y+h > CH) h = CH-y;
    w = Math.max(INCH,w); h = Math.max(INCH,h);
    Object.assign(s, { x, y, w, h });
    fsRestoreWorld(s, fsSnap);
    // Move parent-bound child items by the same shift (so they stay
    // attached to the side that moved, e.g. NW/SW/W handles).
    const cdx = s.x - oldX, cdy = s.y - oldY;
    if (cdx || cdy) {
        for (const child of shapes) {
            if (child.parentId === s.id) {
                child.x += cdx;
                child.y += cdy;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────
//  Edge drag-resize — grab any edge line of a shape and move it
// ─────────────────────────────────────────────────────────────
const EDGE_DRAG_THRESH = 7;
function hitShapeLine(mx, my) {
    for (let i = shapes.length - 1; i >= 0; i--) {
        const s = shapes[i];
        if (s.subtype) continue;
        if (s.shapeType === 'rect') {
            const edges = [
                ['top',    s.x,     s.y,       s.x+s.w, s.y    ],
                ['right',  s.x+s.w, s.y,       s.x+s.w, s.y+s.h],
                ['bottom', s.x+s.w, s.y+s.h,   s.x,     s.y+s.h],
                ['left',   s.x,     s.y+s.h,   s.x,     s.y    ],
            ];
            for (const [side, x1, y1, x2, y2] of edges) {
                if (distToSegment(mx, my, x1, y1, x2, y2) < EDGE_DRAG_THRESH) {
                    return { s, kind: 'rect', side };
                }
            }
        } else if (s.shapeType === 'l') {
            const poly = lShapePolygon(s);
            for (let k = 0; k < poly.length; k++) {
                const nk = (k + 1) % poly.length;
                if (distToSegment(mx, my, poly[k][0], poly[k][1], poly[nk][0], poly[nk][1]) < EDGE_DRAG_THRESH) {
                    return { s, kind: 'l', edgeIdx: k };
                }
            }
        } else if (s.shapeType === 'u') {
            const poly = uShapePolygon(s);
            for (let k = 0; k < poly.length; k++) {
                const nk = (k + 1) % poly.length;
                if (distToSegment(mx, my, poly[k][0], poly[k][1], poly[nk][0], poly[nk][1]) < EDGE_DRAG_THRESH) {
                    return { s, kind: 'u', edgeIdx: k };
                }
            }
        } else if (s.shapeType === 'bsp') {
            const poly = bspPolygon(s);
            for (let k = 0; k < poly.length; k++) {
                const nk = (k + 1) % poly.length;
                if (distToSegment(mx, my, poly[k][0], poly[k][1], poly[nk][0], poly[nk][1]) < EDGE_DRAG_THRESH) {
                    return { s, kind: 'bsp', edgeIdx: k };
                }
            }
        }
    }
    return null;
}

function rotateCanonical(op, xc, yc, Ac, Hc) {
    switch (op) {
        case 'top':    return [xc, yc];
        case 'right':  return [Hc - yc, xc];
        case 'bottom': return [Ac - xc, Hc - yc];
        case 'left':   return [yc, Ac - xc];
    }
    return [xc, yc];
}

function applyEdgeResize(dxa, dya) {
    if (!edgeResizing) return;
    const { s, kind, base } = edgeResizing;
    const fsSnap = fsCaptureWorld(s);
    const oldX = s.x, oldY = s.y;
    if (kind === 'rect') {
        let { x, y, w, h } = base;
        switch (edgeResizing.side) {
            case 'top': {
                const ny = Math.max(0, Math.min(base.y + base.h - INCH, base.y + dya));
                y = ny; h = base.h - (ny - base.y);
                break;
            }
            case 'bottom': {
                h = Math.max(INCH, Math.min(CH - base.y, base.h + dya));
                break;
            }
            case 'left': {
                const nx = Math.max(0, Math.min(base.x + base.w - INCH, base.x + dxa));
                x = nx; w = base.w - (nx - base.x);
                break;
            }
            case 'right': {
                w = Math.max(INCH, Math.min(CW - base.x, base.w + dxa));
                break;
            }
        }
        if (x + w > CW) w = CW - x;
        if (y + h > CH) h = CH - y;
        Object.assign(s, { x, y, w, h });
    } else if (kind === 'l') {
        applyLEdgeResize(s, edgeResizing.edgeIdx, dxa, dya, base);
    } else if (kind === 'u') {
        applyUEdgeResize(s, edgeResizing.edgeIdx, dxa, dya, base);
    } else if (kind === 'bsp') {
        applyBspEdgeResize(s, edgeResizing.edgeIdx, dxa, dya, base);
    }
    fsRestoreWorld(s, fsSnap);
    const cdx = s.x - oldX, cdy = s.y - oldY;
    if (cdx || cdy) {
        for (const child of shapes) {
            if (child.parentId === s.id) { child.x += cdx; child.y += cdy; }
        }
    }
}

function applyLEdgeResize(s, edgeIdx, dxa, dya, base) {
    const corner = base.notchCorner || 'ne';
    const poly = lShapePolygon(base);
    const p1 = poly[edgeIdx], p2 = poly[(edgeIdx + 1) % poly.length];
    const isHoriz = Math.abs(p1[1] - p2[1]) < 0.5;
    const isVert  = Math.abs(p1[0] - p2[0]) < 0.5;
    const atTop    = isHoriz && Math.abs(p1[1] - base.y) < 0.5;
    const atBottom = isHoriz && Math.abs(p1[1] - (base.y + base.h)) < 0.5;
    const atLeft   = isVert  && Math.abs(p1[0] - base.x) < 0.5;
    const atRight  = isVert  && Math.abs(p1[0] - (base.x + base.w)) < 0.5;
    const innerH   = isHoriz && !atTop && !atBottom;
    const innerV   = isVert  && !atLeft && !atRight;

    let x = base.x, y = base.y, w = base.w, h = base.h;
    let notchW = base.notchW || 0, notchH = base.notchH || 0;

    if (atTop) {
        const ny = Math.max(0, Math.min(base.y + base.h - Math.max(INCH, notchH + INCH), base.y + dya));
        y = ny; h = base.h - (ny - base.y);
    } else if (atBottom) {
        h = Math.max(notchH + INCH, Math.min(CH - base.y, base.h + dya));
    } else if (atLeft) {
        const nx = Math.max(0, Math.min(base.x + base.w - Math.max(INCH, notchW + INCH), base.x + dxa));
        x = nx; w = base.w - (nx - base.x);
    } else if (atRight) {
        w = Math.max(notchW + INCH, Math.min(CW - base.x, base.w + dxa));
    } else if (innerH) {
        if (corner === 'ne' || corner === 'nw') {
            notchH = Math.max(INCH, Math.min(h - INCH, (base.notchH || 0) + dya));
        } else {
            notchH = Math.max(INCH, Math.min(h - INCH, (base.notchH || 0) - dya));
        }
    } else if (innerV) {
        if (corner === 'ne' || corner === 'se') {
            notchW = Math.max(INCH, Math.min(w - INCH, (base.notchW || 0) - dxa));
        } else {
            notchW = Math.max(INCH, Math.min(w - INCH, (base.notchW || 0) + dxa));
        }
    }
    if (x + w > CW) w = CW - x;
    if (y + h > CH) h = CH - y;
    Object.assign(s, { x, y, w, h, notchW, notchH });
}

function applyUEdgeResize(s, edgeIdx, dxa, dya, base) {
    const op = base.uOpening || 'top';
    let dxc, dyc;
    switch (op) {
        case 'top':    dxc =  dxa; dyc =  dya; break;
        case 'right':  dxc =  dya; dyc = -dxa; break;
        case 'bottom': dxc = -dxa; dyc = -dya; break;
        case 'left':   dxc = -dya; dyc =  dxa; break;
    }
    const isVert = op === 'top' || op === 'bottom';
    const bA = isVert ? base.w : base.h;
    const bH = isVert ? base.h : base.w;
    const bLW = base.leftW || 0, bRW = base.rightW || 0;
    const bLH = base.leftH ?? bH;
    const bRH = base.rightH ?? bH;
    const bFH = base.floorH ?? 0;

    let A = bA, H = bH;
    let lW = bLW, rW = bRW;
    let lH = bLH, rH = bRH, fH = bFH;
    let anchorOld = null, anchorNew = null;
    const ML = INCH;

    switch (edgeIdx) {
        case 0: { // left outer
            const maxD = bA - bLW - bRW - ML;
            const d = Math.max(-1e6, Math.min(maxD, dxc));
            A = bA - d;
            lW = Math.max(0, bLW - d);
            anchorOld = [bA, bH]; anchorNew = [A, H];
            break;
        }
        case 1: { // left arm top
            lH = Math.max(bFH + ML, Math.min(bH, bLH - dyc));
            break;
        }
        case 2: { // left inner
            lW = Math.max(0, Math.min(bA - bRW - ML, bLW + dxc));
            break;
        }
        case 3: { // floor
            fH = Math.max(ML, Math.min(Math.min(bLH, bRH) - ML, bFH - dyc));
            break;
        }
        case 4: { // right inner
            rW = Math.max(0, Math.min(bA - bLW - ML, bRW - dxc));
            break;
        }
        case 5: { // right arm top
            rH = Math.max(bFH + ML, Math.min(bH, bRH - dyc));
            break;
        }
        case 6: { // right outer
            const minD = -(bA - bLW - bRW - ML);
            const d = Math.max(minD, Math.min(1e6, dxc));
            A = bA + d;
            rW = Math.max(0, bRW + d);
            anchorOld = [0, bH]; anchorNew = [0, H];
            break;
        }
        case 7: { // bottom (extends/shrinks H)
            const minH = Math.max(bLH, bRH);
            const d = Math.max(minH - bH, dyc);
            H = bH + d;
            lH = bLH + d;
            rH = bRH + d;
            fH = bFH + d;
            anchorOld = [0, 0]; anchorNew = [0, 0];
            break;
        }
    }
    s.leftW = Math.round(lW);
    s.rightW = Math.round(rW);
    s.leftH = Math.round(lH);
    s.rightH = Math.round(rH);
    s.floorH = Math.round(fH);
    if (isVert) { s.w = Math.round(A); s.h = Math.round(H); }
    else        { s.w = Math.round(H); s.h = Math.round(A); }
    if (anchorOld) {
        const rotOld = rotateCanonical(op, anchorOld[0], anchorOld[1], bA, bH);
        const rotNew = rotateCanonical(op, anchorNew[0], anchorNew[1], A, H);
        s.x = Math.round(base.x + (rotOld[0] - rotNew[0]));
        s.y = Math.round(base.y + (rotOld[1] - rotNew[1]));
    } else {
        s.x = base.x;
        s.y = base.y;
    }
    if (s.x < 0) s.x = 0;
    if (s.y < 0) s.y = 0;
    if (s.x + s.w > CW) s.x = CW - s.w;
    if (s.y + s.h > CH) s.y = CH - s.h;
}

function applyBspEdgeResize(s, edgeIdx, dxa, dya, base) {
    let { x, y, w, h } = base;
    let pW = base.pW, pH = base.pH;
    const oldPX = base.pX !== undefined ? base.pX : Math.round((base.w - base.pW) / 2);
    let pX = oldPX;
    switch (edgeIdx) {
        case 0: { // top of protrusion
            const ny = Math.max(0, Math.min(base.y + base.h - pH - INCH, base.y + dya));
            y = ny; h = base.h - (ny - base.y);
            break;
        }
        case 1: { // right of protrusion
            const maxPW = base.w - oldPX;
            pW = Math.max(INCH, Math.min(maxPW, base.pW + dxa));
            break;
        }
        case 2: case 6: { // step (right or left)
            pH = Math.max(INCH, Math.min(base.h - INCH, base.pH + dya));
            break;
        }
        case 3: { // right of base
            const minW = oldPX + pW;
            w = Math.max(minW, Math.min(CW - base.x, base.w + dxa));
            break;
        }
        case 4: { // bottom
            h = Math.max(pH + INCH, Math.min(CH - base.y, base.h + dya));
            break;
        }
        case 5: { // left of base — preserve protrusion absolute position
            const maxNewX = base.x + base.w - pW - INCH;
            const newX = Math.max(0, Math.min(maxNewX, base.x + dxa));
            const dxEff = newX - base.x;
            x = newX;
            w = base.w - dxEff;
            pX = oldPX - dxEff;
            if (pX < 0) pX = 0;
            if (pX + pW > w) pX = Math.max(0, w - pW);
            break;
        }
        case 7: { // left of protrusion — preserve protrusion right side
            const oldRight = oldPX + base.pW;
            const newPX = Math.max(0, Math.min(oldRight - INCH, oldPX + dxa));
            pX = newPX;
            pW = oldRight - newPX;
            break;
        }
    }
    if (x + w > CW) w = CW - x;
    if (y + h > CH) h = CH - y;
    Object.assign(s, { x, y, w, h, pW, pH, pX });
}

// ─────────────────────────────────────────────────────────────
//  Border segment drawing  (ctx passed explicitly for legend)
// ─────────────────────────────────────────────────────────────
function drawBorderSegment(gctx, type, x1, y1, x2, y2, sel) {
    const len = Math.hypot(x2-x1, y2-y1);
    if (len < 0.5) return;
    gctx.save();
    gctx.setLineDash([]);

    if (!type || type === 'none') {
        gctx.strokeStyle = sel ? '#b09030' : '#222222';
        gctx.lineWidth = sel ? 2 : 0.8;
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'pencil' || type === 'polished') {
        gctx.strokeStyle = '#dd0000'; gctx.lineWidth = 2.5;
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'ogee') {
        // Wavy line
        gctx.translate(x1, y1); gctx.rotate(Math.atan2(y2-y1, x2-x1));
        gctx.strokeStyle = '#cc44cc'; gctx.lineWidth = 2.5;
        gctx.beginPath(); gctx.moveTo(0, 0);
        for (let i = 0; i < len; i += 12) { gctx.quadraticCurveTo(i+3, -3, i+6, 0); gctx.quadraticCurveTo(i+9, 3, i+12, 0); }
        gctx.stroke();

    } else if (type === 'bullnose') {
        // Thick rounded line
        gctx.strokeStyle = '#0088dd'; gctx.lineWidth = 4; gctx.lineCap = 'round';
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'halfbull') {
        // Double line
        const nx = -(y2-y1)/len, ny = (x2-x1)/len;
        gctx.strokeStyle = '#00aa66'; gctx.lineWidth = 2;
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();
        gctx.lineWidth = 1; gctx.globalAlpha = 0.5;
        gctx.beginPath(); gctx.moveTo(x1+nx*3,y1+ny*3); gctx.lineTo(x2+nx*3,y2+ny*3); gctx.stroke();
        gctx.globalAlpha = 1;

    } else if (type === 'bevel') {
        // Dash-dot pattern
        gctx.strokeStyle = '#dd8800'; gctx.lineWidth = 2.5;
        gctx.setLineDash([8, 3, 2, 3]);
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'mitered') {
        gctx.strokeStyle = '#7a3000'; gctx.lineWidth = 2;
        gctx.setLineDash([4,3]);
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'special') {
        gctx.strokeStyle = '#228B22'; gctx.lineWidth = 2.5;
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'joint') {
        gctx.strokeStyle = '#e0457b'; gctx.lineWidth = 2;
        gctx.setLineDash([5,4]);
        gctx.beginPath(); gctx.moveTo(x1,y1); gctx.lineTo(x2,y2); gctx.stroke();

    } else if (type === 'waterfall') {
        gctx.translate(x1, y1);
        gctx.rotate(Math.atan2(y2-y1, x2-x1));
        gctx.strokeStyle = '#006688'; gctx.lineWidth = 1;
        gctx.beginPath(); gctx.moveTo(0,0); gctx.lineTo(len,0); gctx.stroke();
        gctx.lineWidth = 1.5;
        for (let i = 8; i < len; i += 12) {
            gctx.beginPath(); gctx.moveTo(i-4,-4); gctx.lineTo(i,0); gctx.lineTo(i-4,4); gctx.stroke();
        }
    }
    gctx.restore();
}

// Draw a segmented edge: splits the line x1,y1→x2,y2 into portions per segment
function drawSegmentedEdge(gctx, edge, x1, y1, x2, y2, sel, edgeKey) {
    if (!edge || edge.type !== 'segmented' || !edge.segments?.length) return;
    const totalLen = Math.hypot(x2-x1, y2-y1);
    if (totalLen < 1) return;
    const dx = (x2-x1)/totalLen, dy = (y2-y1)/totalLen;
    // normal vector pointing outward (for label placement)
    let nx, ny, ALOFF = 14;
    if (edgeKey === 'top')    { nx=0; ny=-1; }
    else if (edgeKey === 'bottom') { nx=0; ny=1; }
    else if (edgeKey === 'left')   { nx=-1; ny=0; }
    else if (edgeKey === 'right')  { nx=1; ny=0; }
    else { nx = -dy; ny = dx; } // generic: perpendicular outward

    let cursor = 0;
    for (let i = 0; i < edge.segments.length; i++) {
        const seg = edge.segments[i];
        const segPx = seg.length * INCH;
        const sx = x1 + dx * cursor, sy = y1 + dy * cursor;
        const ex = x1 + dx * Math.min(cursor + segPx, totalLen), ey = y1 + dy * Math.min(cursor + segPx, totalLen);
        // Draw the segment profile
        drawBorderSegment(gctx, seg.profile, sx, sy, ex, ey, sel);
        // Label: abbreviation + length
        const def = EDGE_DEFS[seg.profile];
        if (def?.abbr) {
            const mx = (sx+ex)/2, my = (sy+ey)/2;
            const lx = mx + nx * ALOFF, ly = my + ny * ALOFF;
            gctx.save();
            gctx.font = 'bold 8px Raleway,sans-serif';
            gctx.textAlign = 'center'; gctx.textBaseline = 'middle';
            gctx.lineWidth = 3; gctx.strokeStyle = 'rgba(255,255,255,0.85)';
            const txt = `${def.abbr} ${seg.length}"`;
            gctx.strokeText(txt, lx, ly); gctx.fillStyle = def.color; gctx.fillText(txt, lx, ly);
            gctx.restore();
        }
        cursor += segPx;
        // Split dot between segments (not after last)
        if (i < edge.segments.length - 1 && cursor < totalLen) {
            const tx = x1 + dx * cursor, ty = y1 + dy * cursor;
            gctx.save();
            gctx.setLineDash([]);
            // Outer ring
            gctx.beginPath(); gctx.arc(tx, ty, 6, 0, Math.PI*2);
            gctx.fillStyle = '#b09030'; gctx.fill();
            // Inner dot
            gctx.beginPath(); gctx.arc(tx, ty, 3, 0, Math.PI*2);
            gctx.fillStyle = '#1a1a1a'; gctx.fill();
            gctx.restore();
        }
    }
}

// Draws an edge piece using edge data that may be a plain type or segmented.
// labelOffset: { dx, dy } for profile abbreviation label placement.
function drawEdgeDatum(ed, storeKey, x1, y1, x2, y2, sel, labelOffset) {
    if (ed?.type === 'segmented' && ed.segments?.length) {
        drawSegmentedEdge(ctx, ed, x1, y1, x2, y2, sel, storeKey);
        return;
    }
    const etype = ed?.type || 'none';
    drawBorderSegment(ctx, etype, x1, y1, x2, y2, sel);
    if (etype !== 'none') {
        const def = EDGE_DEFS[etype];
        if (def?.abbr) {
            const mx = (x1+x2)/2, my = (y1+y2)/2;
            let lx, ly;
            if (labelOffset) { lx = mx + labelOffset.dx; ly = my + labelOffset.dy; }
            else {
                const ex = x2-x1, ey = y2-y1, len = Math.hypot(ex,ey)||1;
                lx = mx + (ey/len) * 14;
                ly = my + (-ex/len) * 14;
            }
            ctx.save();
            ctx.font = 'bold 9px Raleway,sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.strokeText(def.abbr, lx, ly);
            ctx.fillStyle = def.color; ctx.fillText(def.abbr, lx, ly);
            ctx.restore();
        }
    }
}

// Draws a polygon edge segment that may host a farmhouse sink. When the
// farmSink lives on this segment, the edge is split into two halves around
// the cutout and each half is rendered with its own edgeData (fsLeft/fsRight).
function drawPolyEdgeMaybeFS(s, sd, segKey, sel) {
    const edgeData = s.edges?.[segKey];
    if (s.farmSink && farmSinkEdgeKey(s) === segKey) {
        const fr = farmSinkRectAbs(s);
        const baseT = edgeData?.type && edgeData.type !== 'segmented' ? edgeData.type : 'none';
        const leftData = edgeData?.fsLeft || { type: baseT };
        const rightData = edgeData?.fsRight || { type: baseT };
        const isVertSeg = Math.abs(sd.x1 - sd.x2) < 0.5;
        if (isVertSeg) {
            // Vertical edge: split at fsTopY/fsBotY along Y. fsLeft = top (smaller Y).
            const fsTopY = fr.y, fsBotY = fr.y + fr.h;
            const goingDown = sd.y2 >= sd.y1;
            if (goingDown) {
                drawEdgeDatum(leftData,  segKey + '_fsL', sd.x1, sd.y1, sd.x1, fsTopY, sel);
                drawEdgeDatum(rightData, segKey + '_fsR', sd.x2, fsBotY, sd.x2, sd.y2, sel);
            } else {
                drawEdgeDatum(rightData, segKey + '_fsR', sd.x1, sd.y1, sd.x1, fsBotY, sel);
                drawEdgeDatum(leftData,  segKey + '_fsL', sd.x2, fsTopY, sd.x2, sd.y2, sel);
            }
            return;
        }
        // Horizontal edge: split at fsLx/fsRx. fsLeft = west (smaller X).
        const fsLx = fr.x, fsRx = fr.x + fr.w;
        const goingRight = sd.x2 >= sd.x1;
        if (goingRight) {
            drawEdgeDatum(leftData,  segKey + '_fsL', sd.x1, sd.y1, fsLx, sd.y1, sel);
            drawEdgeDatum(rightData, segKey + '_fsR', fsRx, sd.y2, sd.x2, sd.y2, sel);
        } else {
            drawEdgeDatum(rightData, segKey + '_fsR', sd.x1, sd.y1, fsRx, sd.y1, sel);
            drawEdgeDatum(leftData,  segKey + '_fsL', fsLx, sd.y2, sd.x2, sd.y2, sel);
        }
        return;
    }
    drawEdgeDatum(edgeData || { type: 'none' }, segKey, sd.x1, sd.y1, sd.x2, sd.y2, sel);
}

// Draws the 3-sided dashed outline of the farmhouse sink cutout plus the
// "FARMHOUSE SINK" label. Works for all shape types.
function drawFsOutlineLabel(s) {
    if (!s.farmSink) return;
    const fr = farmSinkRectAbs(s);
    if (!fr) return;
    const fsLx = fr.x, fsRx = fr.x + fr.w;
    const fsTopY = fr.y, fsBotY = fr.y + fr.h;
    ctx.save();
    ctx.strokeStyle = '#2a8fbe'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath();
    if (fr.vertical) {
        // Vertical edge: skip the side along the shape edge.
        // dir > 0 means notch goes +x (left edge sink, cuts right)
        // dir < 0 means notch goes -x (right edge sink, cuts left)
        if (fr.dir > 0) {
            // cuts to the right — outer side is left → skip left side
            ctx.moveTo(fsLx, fsTopY);
            ctx.lineTo(fsRx, fsTopY);
            ctx.lineTo(fsRx, fsBotY);
            ctx.lineTo(fsLx, fsBotY);
        } else {
            // cuts to the left — outer side is right → skip right side
            ctx.moveTo(fsRx, fsTopY);
            ctx.lineTo(fsLx, fsTopY);
            ctx.lineTo(fsLx, fsBotY);
            ctx.lineTo(fsRx, fsBotY);
        }
    } else if (fr.dir > 0) {
        // Cut down from outer edge — skip top side (it's along the shape edge)
        ctx.moveTo(fsLx, fsTopY);
        ctx.lineTo(fsLx, fsBotY);
        ctx.lineTo(fsRx, fsBotY);
        ctx.lineTo(fsRx, fsTopY);
    } else {
        // Cut up from outer edge — skip bottom side
        ctx.moveTo(fsLx, fsBotY);
        ctx.lineTo(fsLx, fsTopY);
        ctx.lineTo(fsRx, fsTopY);
        ctx.lineTo(fsRx, fsBotY);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cx = (fsLx + fsRx) / 2;
    const cy = (fsTopY + fsBotY) / 2;
    let fsFont = Math.min(fr.h * 0.22, fr.w * 0.13);
    ctx.font = `bold ${fsFont}px Raleway,sans-serif`;
    const lbl = 'FARMHOUSE SINK';
    while (ctx.measureText(lbl).width > fr.w - 16 && fsFont > 6) {
        fsFont -= 0.5;
        ctx.font = `bold ${fsFont}px Raleway,sans-serif`;
    }
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.strokeText(lbl, cx, cy);
    ctx.fillStyle = '#2a8fbe'; ctx.fillText(lbl, cx, cy);
    if (selectedFarmSinkShapeId === s.id) {
        ctx.strokeStyle = '#e8a200'; ctx.lineWidth = 2; ctx.setLineDash([2,2]);
        ctx.strokeRect(fsLx - 2, fsTopY - 2, fr.w + 4, fr.h + 4);
    }
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────
//  Rounded rect path
// ─────────────────────────────────────────────────────────────
function roundedRectPath(gctx, x, y, w, h, r, ch, chB) {
    ch  = ch  || { nw:0, ne:0, se:0, sw:0 };
    chB = chB || ch;  // B-side defaults to A-side (symmetric)
    // A = along first-incoming side, B = along outgoing side (0 = goes to corner)
    const nwA = ch.nw > 0 ? ch.nw : r.nw,  nwB = ch.nw > 0 ? chB.nw : r.nw;
    const neA = ch.ne > 0 ? ch.ne : r.ne,  neB = ch.ne > 0 ? chB.ne : r.ne;
    const seA = ch.se > 0 ? ch.se : r.se,  seB = ch.se > 0 ? chB.se : r.se;
    const swA = ch.sw > 0 ? ch.sw : r.sw,  swB = ch.sw > 0 ? chB.sw : r.sw;
    gctx.beginPath();
    gctx.moveTo(x + nwA, y);
    gctx.lineTo(x + w - neA, y);
    if      (ch.ne > 0) gctx.lineTo(x+w, y+neB);
    else if (r.ne  > 0) gctx.arcTo(x+w, y, x+w, y+r.ne, r.ne);
    else                gctx.lineTo(x+w, y);
    gctx.lineTo(x+w, y+h-seA);
    if      (ch.se > 0) gctx.lineTo(x+w-seB, y+h);
    else if (r.se  > 0) gctx.arcTo(x+w, y+h, x+w-r.se, y+h, r.se);
    else                gctx.lineTo(x+w, y+h);
    gctx.lineTo(x+swA, y+h);
    if      (ch.sw > 0) gctx.lineTo(x, y+h-swB);
    else if (r.sw  > 0) gctx.arcTo(x, y+h, x, y+h-r.sw, r.sw);
    else                gctx.lineTo(x, y+h);
    gctx.lineTo(x, y+nwB);
    if      (ch.nw > 0) gctx.lineTo(x+nwA, y);
    else if (r.nw  > 0) gctx.arcTo(x, y, x+r.nw, y, r.nw);
    else                gctx.lineTo(x, y);
    gctx.closePath();
}

// ─────────────────────────────────────────────────────────────
//  Draw shape
// ─────────────────────────────────────────────────────────────
// Draw an arrowhead at (x,y) pointing in direction (tx,ty)
function drawArrowHead(x, y, tx, ty, size) {
    const nx = -ty, ny = tx;
    ctx.beginPath();
    ctx.moveTo(x + tx*size, y + ty*size);
    ctx.lineTo(x + nx*(size*0.4), y + ny*(size*0.4));
    ctx.lineTo(x - nx*(size*0.4), y - ny*(size*0.4));
    ctx.closePath();
    ctx.fill();
}

// Multiplier applied to dim label font size — 1 normally, >1 during proposal PDF render
let dimSizeMultiplier = 1;

let dimLabelRects = [];
let dimClickTargets = []; // { rect:[x,y,w,h], shapeId, dimKey }
function dimRectsOverlap(a, b) {
    return a[0] < b[0]+b[2] && a[0]+a[2] > b[0] && a[1] < b[1]+b[3] && a[1]+a[3] > b[1];
}

// Draw an engineering dimension line outside a shape edge.
// (x1,y1)→(x2,y2) must be a CW-wound segment so outward normal = (ty,-tx).
// lenPx is the raw pixel distance to show as an inch value.
function drawDimLine(x1, y1, x2, y2, lenPx, shapeId, dimKey) {
    const dx = x2-x1, dy = y2-y1, len = Math.hypot(dx, dy);
    if (len < INCH) return;
    // Check if this dim is hidden
    if (shapeId != null && dimKey) {
        const sh = byId(shapeId);
        if (sh && sh.hideDims && sh.hideDims[dimKey]) return;
    }
    const tx = dx/len, ty = dy/len;
    const onx = ty,   ony = -tx;

    const OFFSET = 20;
    const EXT    = 5;
    const ARR    = 7;

    const ex1 = x1 + onx*OFFSET, ey1 = y1 + ony*OFFSET;
    const ex2 = x2 + onx*OFFSET, ey2 = y2 + ony*OFFSET;

    ctx.save();
    ctx.strokeStyle = '#445566';
    ctx.fillStyle   = '#445566';
    ctx.lineWidth   = 0.8;
    ctx.setLineDash([]);

    ctx.beginPath(); ctx.moveTo(x1 + onx*3, y1 + ony*3); ctx.lineTo(ex1 + onx*EXT, ey1 + ony*EXT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x2 + onx*3, y2 + ony*3); ctx.lineTo(ex2 + onx*EXT, ey2 + ony*EXT); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex1, ey1); ctx.lineTo(ex2, ey2); ctx.stroke();
    drawArrowHead(ex1, ey1,  tx,  ty, ARR);
    drawArrowHead(ex2, ey2, -tx, -ty, ARR);

    const mx = (ex1+ex2)/2, my = (ey1+ey2)/2;
    const rawIn = lenPx / INCH;
    const label = fmtInches(rawIn);
    const dimFs = Math.round(13 * dimSizeMultiplier);
    const dimBgH = Math.round(18 * dimSizeMultiplier);
    ctx.font = `bold ${dimFs}px Raleway,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 8;
    const labelRect = [mx - tw/2 - 2, my - dimBgH/2 - 2, tw + 4, dimBgH + 4];
    if (!dimLabelRects.some(r => dimRectsOverlap(labelRect, r))) {
        dimLabelRects.push(labelRect);
        ctx.fillStyle = '#ffffff'; ctx.fillRect(mx - tw/2, my - dimBgH/2, tw, dimBgH);
        ctx.fillStyle = '#1a2a44'; ctx.fillText(label, mx, my);
        // Register click target for toggling
        if (shapeId != null && dimKey) {
            dimClickTargets.push({ rect: [mx - tw/2, my - dimBgH/2, tw, dimBgH], shapeId, dimKey });
        }
    }

    ctx.restore();
}

function lShapeVerts(s) {
    // Returns per-vertex data accounting for corner treatments (supports asymmetric chamfer)
    const pts = lShapePolygon(s);
    const n = pts.length;
    return pts.map((curr, i) => {
        const prev = pts[(i-1+n)%n], next = pts[(i+1)%n];
        const key = `lc${i}`;
        const r   = s.corners?.[key]   || 0;
        const ch  = s.chamfers?.[key]  || 0;
        const chb = s.chamfersB?.[key] || 0;  // B-side (asymmetric)
        const len1 = Math.hypot(curr[0]-prev[0], curr[1]-prev[1]);
        const len2 = Math.hypot(next[0]-curr[0], next[1]-curr[1]);
        const tIn  = ch > 0 ? ch  : r;  // distance along incoming edge (toward prev)
        const tOut = ch > 0 ? (chb != null ? chb : ch) : r;  // distance along outgoing edge (toward next)
        // Each side clamped only to its own edge length
        const tInC  = Math.min(tIn,  len1);
        const tOutC = Math.min(tOut, len2);
        const t = Math.max(tInC, tOutC);
        const tx1=(curr[0]-prev[0])/(len1||1), ty1=(curr[1]-prev[1])/(len1||1);
        const tx2=(next[0]-curr[0])/(len2||1), ty2=(next[1]-curr[1])/(len2||1);
        const pin  = tInC  > 0 ? [curr[0]-tx1*tInC,  curr[1]-ty1*tInC]  : [curr[0], curr[1]];
        const pout = tOutC > 0 ? [curr[0]+tx2*tOutC, curr[1]+ty2*tOutC] : [curr[0], curr[1]];
        return { curr, pin, pout, t, r, ch, chb };
    });
}

function drawLShape(s, sel) {
    const verts = lShapeVerts(s);
    const basePoly = lShapePolygon(s);
    const n = verts.length;
    const fill = sel ? 'rgba(201,168,76,0.12)' : 'rgba(218,230,248,0.88)';

    // Per-vertex check data (A/B/C points). Corner treatment on a vertex is
    // superseded by a check on the same vertex.
    const checkAt = new Array(n).fill(null);
    for (const c of (s.checks || [])) {
        if (c.vertexIdx != null && c.vertexIdx >= 0 && c.vertexIdx < n) {
            checkAt[c.vertexIdx] = cornerCheckPoints(basePoly, c.vertexIdx, c);
        }
    }
    const startPt = checkAt[0] ? checkAt[0].B : verts[0].pout;

    // 1. Fill with corner treatments (and carve out corner-check notches)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(startPt[0], startPt[1]);
    for (let i = 0; i < n; i++) {
        const nextI = (i+1)%n;
        const nv = verts[nextI];
        const nvCk = checkAt[nextI];
        if (nvCk) {
            ctx.lineTo(nvCk.A[0], nvCk.A[1]);
            ctx.lineTo(nvCk.C[0], nvCk.C[1]);
            ctx.lineTo(nvCk.B[0], nvCk.B[1]);
        } else {
            ctx.lineTo(nv.pin[0], nv.pin[1]);
            if (nv.t > 0) {
                if (nv.r === 0) ctx.lineTo(nv.pout[0], nv.pout[1]);
                else ctx.arcTo(nv.curr[0], nv.curr[1], nv.pout[0], nv.pout[1], nv.r);
            }
        }
    }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();

    // 1b. Carve out farmhouse sink notch
    if (s.farmSink && s.farmSink.edge === 'seg') {
        const fr = farmSinkRectAbs(s);
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
        ctx.restore();
    }

    // 2. Border — 6 sides (endpoints adjusted for corner treatments + checks)
    for (let i = 0; i < n; i++) {
        const v = verts[i], nv = verts[(i+1)%n];
        const vCk = checkAt[i], nvCk = checkAt[(i+1)%n];
        const key = `seg${i}`;
        const sd = {
            x1: vCk  ? vCk.B[0]  : v.pout[0],
            y1: vCk  ? vCk.B[1]  : v.pout[1],
            x2: nvCk ? nvCk.A[0] : nv.pin[0],
            y2: nvCk ? nvCk.A[1] : nv.pin[1],
        };
        drawPolyEdgeMaybeFS(s, sd, key, sel);
        // Draw corner treatment at nv — skipped when nv has a check
        if (nv.t > 0 && !nvCk) {
            if (nv.r === 0) {
                const diagStoreKey = `lc${(i+1)%n}`;
                const chData = s.chamferEdges?.[diagStoreKey];
                if (chData?.type === 'segmented' && chData.segments?.length) {
                    drawSegmentedEdge(ctx, chData, nv.pin[0], nv.pin[1], nv.pout[0], nv.pout[1], sel, diagStoreKey);
                } else {
                    const diagEtype = chData?.type || 'none';
                    drawBorderSegment(ctx, diagEtype, nv.pin[0], nv.pin[1], nv.pout[0], nv.pout[1], sel);
                    if (diagEtype !== 'none') {
                        const def = EDGE_DEFS[diagEtype];
                        if (def?.abbr) {
                            const dmx=(nv.pin[0]+nv.pout[0])/2, dmy=(nv.pin[1]+nv.pout[1])/2;
                            const ddx=nv.pout[0]-nv.pin[0], ddy=nv.pout[1]-nv.pin[1], dlen=Math.hypot(ddx,ddy)||1;
                            const dlx=dmx+(ddy/dlen)*14, dly=dmy+(-ddx/dlen)*14;
                            ctx.save(); ctx.font='bold 9px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                            ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
                            ctx.strokeText(def.abbr,dlx,dly); ctx.fillStyle=def.color; ctx.fillText(def.abbr,dlx,dly); ctx.restore();
                        }
                    }
                }
            } else {
                // Radius arc — honor cornerEdges[lc_i].type styling (same palette as rect corner arcs)
                const lckey = `lc${(i+1)%n}`;
                const ctype = s.cornerEdges?.[lckey]?.type || 'none';
                ctx.save();
                if (sel && ctype === 'none') { ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2; ctx.setLineDash([]); }
                else if (ctype === 'none')   { ctx.strokeStyle = '#222222'; ctx.lineWidth = 0.8; ctx.setLineDash([]); }
                else if (ctype === 'polished' || ctype === 'pencil') { ctx.strokeStyle = '#dd0000'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'ogee')      { ctx.strokeStyle = '#cc44cc'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'bullnose')  { ctx.strokeStyle = '#0088dd'; ctx.lineWidth = 4;   ctx.setLineDash([]); }
                else if (ctype === 'halfbull')  { ctx.strokeStyle = '#00aa66'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'bevel')     { ctx.strokeStyle = '#dd8800'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'mitered')   { ctx.strokeStyle = '#7a3000'; ctx.lineWidth = 2;   ctx.setLineDash([4,3]); }
                else if (ctype === 'special')   { ctx.strokeStyle = '#228B22'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'joint')     { ctx.strokeStyle = '#e0457b'; ctx.lineWidth = 2;   ctx.setLineDash([5,4]); }
                else if (ctype === 'waterfall') { ctx.strokeStyle = '#006688'; ctx.lineWidth = 2;   ctx.setLineDash([]); }
                ctx.beginPath(); ctx.moveTo(nv.pin[0],nv.pin[1]);
                ctx.arcTo(nv.curr[0],nv.curr[1],nv.pout[0],nv.pout[1],nv.r); ctx.stroke();
                // Edge profile abbreviation badge near arc midpoint
                const def = EDGE_DEFS[ctype];
                if (ctype !== 'none' && def?.abbr) {
                    const midX = (nv.pin[0] + nv.pout[0]) / 2;
                    const midY = (nv.pin[1] + nv.pout[1]) / 2;
                    const odx = midX - nv.curr[0], ody = midY - nv.curr[1];
                    const od = Math.hypot(odx, ody) || 1;
                    const arcMx = nv.curr[0] + (odx/od) * nv.r;
                    const arcMy = nv.curr[1] + (ody/od) * nv.r;
                    const ox = (odx/od) * 12, oy = (ody/od) * 12;
                    ctx.setLineDash([]);
                    ctx.font='bold 9px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
                    ctx.strokeText(def.abbr, arcMx+ox, arcMy+oy);
                    ctx.fillStyle = def.color; ctx.fillText(def.abbr, arcMx+ox, arcMy+oy);
                }
                // Radius label (only when no edge profile — otherwise it crowds the badge)
                if (ctype === 'none') {
                    const lx=nv.curr[0], ly=nv.curr[1];
                    ctx.font='8px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.8)';
                    ctx.strokeText(`R${pxToInFrac(nv.r)}`,lx,ly); ctx.fillStyle='#cc4444'; ctx.fillText(`R${pxToInFrac(nv.r)}`,lx,ly);
                }
                ctx.restore();
            }
        }
    }

    // 2b. Check notch inner walls (two perpendicular 'none' segments per notch)
    for (let i = 0; i < n; i++) {
        const c = checkAt[i];
        if (!c) continue;
        drawEdgeDatum(s.edges?.[`lck${i}_ac`] || { type:'none' }, `lck${i}_ac`, c.A[0], c.A[1], c.C[0], c.C[1], sel);
        drawEdgeDatum(s.edges?.[`lck${i}_cb`] || { type:'none' }, `lck${i}_cb`, c.C[0], c.C[1], c.B[0], c.B[1], sel);
    }

    // 3. Dimension lines (vertex to vertex — shows full physical dimension)
    const pts = lShapePolygon(s);
    for (let i=0; i<6; i++) {
        const j=(i+1)%6;
        drawDimLine(pts[i][0],pts[i][1],pts[j][0],pts[j][1], Math.hypot(pts[j][0]-pts[i][0],pts[j][1]-pts[i][1]), s.id, `dim_l${i}`);
    }

    // 4. Selection outline
    if (sel) {
        ctx.save(); ctx.strokeStyle='#b09030'; ctx.lineWidth=2; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(startPt[0], startPt[1]);
        for (let i=0; i<n; i++) {
            const nextI = (i+1)%n;
            const nv = verts[nextI];
            const nvCk = checkAt[nextI];
            if (nvCk) {
                ctx.lineTo(nvCk.A[0], nvCk.A[1]);
                ctx.lineTo(nvCk.C[0], nvCk.C[1]);
                ctx.lineTo(nvCk.B[0], nvCk.B[1]);
            } else {
                ctx.lineTo(nv.pin[0], nv.pin[1]);
                if (nv.t > 0) {
                    if (nv.r === 0) ctx.lineTo(nv.pout[0], nv.pout[1]);
                    else ctx.arcTo(nv.curr[0], nv.curr[1], nv.pout[0], nv.pout[1], nv.r);
                }
            }
        }
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }

    // Per-edge resize handles (drag any edge midpoint to resize)
    if (sel) {
        const hw = Math.floor(HND/2);
        for (let i = 0; i < basePoly.length; i++) {
            const j = (i+1) % basePoly.length;
            const mx = (basePoly[i][0] + basePoly[j][0]) / 2;
            const my = (basePoly[i][1] + basePoly[j][1]) / 2;
            ctx.fillStyle = '#fff'; ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
            ctx.fillRect(mx-hw, my-hw, HND, HND);
            ctx.strokeRect(mx-hw, my-hw, HND, HND);
        }
    }

    // 5. Farmhouse sink cutout outline + label
    drawFsOutlineLabel(s);
}

// Per-vertex data for U-shapes, mirroring lShapeVerts. Each of the 8 polygon
// vertices may carry a radius (s.corners.uc{i}) or chamfer (s.chamfers.uc{i})
// with an optional asymmetric B-side (s.chamfersB.uc{i}).
function uShapeVerts(s) {
    const pts = uShapePolygon(s);
    const n = pts.length;
    return pts.map((curr, i) => {
        const prev = pts[(i-1+n)%n], next = pts[(i+1)%n];
        const key = `uc${i}`;
        const r   = s.corners?.[key]   || 0;
        const ch  = s.chamfers?.[key]  || 0;
        const chb = s.chamfersB?.[key] || 0;
        const len1 = Math.hypot(curr[0]-prev[0], curr[1]-prev[1]);
        const len2 = Math.hypot(next[0]-curr[0], next[1]-curr[1]);
        const tIn  = ch > 0 ? ch  : r;
        const tOut = ch > 0 ? (chb != null ? chb : ch) : r;
        const tInC  = Math.min(tIn,  len1);
        const tOutC = Math.min(tOut, len2);
        const t = Math.max(tInC, tOutC);
        const tx1=(curr[0]-prev[0])/(len1||1), ty1=(curr[1]-prev[1])/(len1||1);
        const tx2=(next[0]-curr[0])/(len2||1), ty2=(next[1]-curr[1])/(len2||1);
        const pin  = tInC  > 0 ? [curr[0]-tx1*tInC,  curr[1]-ty1*tInC]  : [curr[0], curr[1]];
        const pout = tOutC > 0 ? [curr[0]+tx2*tOutC, curr[1]+ty2*tOutC] : [curr[0], curr[1]];
        return { curr, pin, pout, t, r, ch, chb };
    });
}

function drawUShape(s, sel) {
    const verts = uShapeVerts(s);
    const basePoly = uShapePolygon(s);
    const n = verts.length;
    const fill = sel ? 'rgba(201,168,76,0.12)' : 'rgba(218,230,248,0.88)';

    // Per-vertex check data (A/B/C points). Check overrides corner treatment
    // on the same vertex.
    const checkAt = new Array(n).fill(null);
    for (const c of (s.checks || [])) {
        if (c.vertexIdx != null && c.vertexIdx >= 0 && c.vertexIdx < n) {
            checkAt[c.vertexIdx] = cornerCheckPoints(basePoly, c.vertexIdx, c);
        }
    }
    const startPt = checkAt[0] ? checkAt[0].B : verts[0].pout;

    // 1. Fill with corner treatments (and carve out corner-check notches)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(startPt[0], startPt[1]);
    for (let i = 0; i < n; i++) {
        const nextI = (i+1)%n;
        const nv = verts[nextI];
        const nvCk = checkAt[nextI];
        if (nvCk) {
            ctx.lineTo(nvCk.A[0], nvCk.A[1]);
            ctx.lineTo(nvCk.C[0], nvCk.C[1]);
            ctx.lineTo(nvCk.B[0], nvCk.B[1]);
        } else {
            ctx.lineTo(nv.pin[0], nv.pin[1]);
            if (nv.t > 0) {
                if (nv.r === 0) ctx.lineTo(nv.pout[0], nv.pout[1]);
                else ctx.arcTo(nv.curr[0], nv.curr[1], nv.pout[0], nv.pout[1], nv.r);
            }
        }
    }
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.restore();

    // 1b. Carve out farmhouse sink notch
    if (s.farmSink && s.farmSink.edge === 'seg') {
        const fr = farmSinkRectAbs(s);
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
        ctx.restore();
    }

    // 2. Border — 8 sides with endpoints adjusted for corner treatments + checks
    const labels = U_SIDE_LABELS[s.uOpening || 'top'];
    for (let i = 0; i < n; i++) {
        const v = verts[i], nv = verts[(i+1)%n];
        const vCk = checkAt[i], nvCk = checkAt[(i+1)%n];
        const key = `seg${i}`;
        const sd = {
            x1: vCk  ? vCk.B[0]  : v.pout[0],
            y1: vCk  ? vCk.B[1]  : v.pout[1],
            x2: nvCk ? nvCk.A[0] : nv.pin[0],
            y2: nvCk ? nvCk.A[1] : nv.pin[1],
            label: labels[i], key
        };
        drawPolyEdgeMaybeFS(s, sd, key, sel);
        // Corner treatment rendering at nv — skipped when nv has a check
        if (nv.t > 0 && !nvCk) {
            if (nv.r === 0) {
                // Chamfer diagonal — selectable as diag_uc{index}
                const diagStoreKey = `uc${(i+1)%n}`;
                const chData = s.chamferEdges?.[diagStoreKey];
                if (chData?.type === 'segmented' && chData.segments?.length) {
                    drawSegmentedEdge(ctx, chData, nv.pin[0], nv.pin[1], nv.pout[0], nv.pout[1], sel, diagStoreKey);
                } else {
                    const diagEtype = chData?.type || 'none';
                    drawBorderSegment(ctx, diagEtype, nv.pin[0], nv.pin[1], nv.pout[0], nv.pout[1], sel);
                    if (diagEtype !== 'none') {
                        const def = EDGE_DEFS[diagEtype];
                        if (def?.abbr) {
                            const dmx=(nv.pin[0]+nv.pout[0])/2, dmy=(nv.pin[1]+nv.pout[1])/2;
                            const ddx=nv.pout[0]-nv.pin[0], ddy=nv.pout[1]-nv.pin[1], dlen=Math.hypot(ddx,ddy)||1;
                            const dlx=dmx+(ddy/dlen)*14, dly=dmy+(-ddx/dlen)*14;
                            ctx.save(); ctx.font='bold 9px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                            ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
                            ctx.strokeText(def.abbr,dlx,dly); ctx.fillStyle=def.color; ctx.fillText(def.abbr,dlx,dly); ctx.restore();
                        }
                    }
                }
            } else {
                // Radius arc — honor cornerEdges[uc_i].type styling
                const uckey = `uc${(i+1)%n}`;
                const ctype = s.cornerEdges?.[uckey]?.type || 'none';
                ctx.save();
                if (sel && ctype === 'none') { ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2; ctx.setLineDash([]); }
                else if (ctype === 'none')   { ctx.strokeStyle = '#222222'; ctx.lineWidth = 0.8; ctx.setLineDash([]); }
                else if (ctype === 'polished' || ctype === 'pencil') { ctx.strokeStyle = '#dd0000'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'ogee')      { ctx.strokeStyle = '#cc44cc'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'bullnose')  { ctx.strokeStyle = '#0088dd'; ctx.lineWidth = 4;   ctx.setLineDash([]); }
                else if (ctype === 'halfbull')  { ctx.strokeStyle = '#00aa66'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'bevel')     { ctx.strokeStyle = '#dd8800'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'mitered')   { ctx.strokeStyle = '#7a3000'; ctx.lineWidth = 2;   ctx.setLineDash([4,3]); }
                else if (ctype === 'special')   { ctx.strokeStyle = '#228B22'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
                else if (ctype === 'joint')     { ctx.strokeStyle = '#e0457b'; ctx.lineWidth = 2;   ctx.setLineDash([5,4]); }
                else if (ctype === 'waterfall') { ctx.strokeStyle = '#006688'; ctx.lineWidth = 2;   ctx.setLineDash([]); }
                ctx.beginPath(); ctx.moveTo(nv.pin[0],nv.pin[1]);
                ctx.arcTo(nv.curr[0],nv.curr[1],nv.pout[0],nv.pout[1],nv.r); ctx.stroke();
                const def = EDGE_DEFS[ctype];
                if (ctype !== 'none' && def?.abbr) {
                    const midX = (nv.pin[0] + nv.pout[0]) / 2;
                    const midY = (nv.pin[1] + nv.pout[1]) / 2;
                    const odx = midX - nv.curr[0], ody = midY - nv.curr[1];
                    const od = Math.hypot(odx, ody) || 1;
                    const arcMx = nv.curr[0] + (odx/od) * nv.r;
                    const arcMy = nv.curr[1] + (ody/od) * nv.r;
                    const ox = (odx/od) * 12, oy = (ody/od) * 12;
                    ctx.setLineDash([]);
                    ctx.font='bold 9px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
                    ctx.strokeText(def.abbr, arcMx+ox, arcMy+oy);
                    ctx.fillStyle = def.color; ctx.fillText(def.abbr, arcMx+ox, arcMy+oy);
                }
                if (ctype === 'none') {
                    const lx=nv.curr[0], ly=nv.curr[1];
                    ctx.font='8px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.8)';
                    ctx.strokeText(`R${pxToInFrac(nv.r)}`,lx,ly); ctx.fillStyle='#cc4444'; ctx.fillText(`R${pxToInFrac(nv.r)}`,lx,ly);
                }
                ctx.restore();
            }
        }
    }

    // 2b. Check notch inner walls (two perpendicular 'none' segments per notch)
    for (let i = 0; i < n; i++) {
        const c = checkAt[i];
        if (!c) continue;
        drawEdgeDatum(s.edges?.[`uck${i}_ac`] || { type:'none' }, `uck${i}_ac`, c.A[0], c.A[1], c.C[0], c.C[1], sel);
        drawEdgeDatum(s.edges?.[`uck${i}_cb`] || { type:'none' }, `uck${i}_cb`, c.C[0], c.C[1], c.B[0], c.B[1], sel);
    }

    // 3. Dimension lines — vertex to vertex
    const pts = uShapePolygon(s);
    for (let i=0;i<8;i++) {
        const j=(i+1)%8;
        drawDimLine(pts[i][0],pts[i][1],pts[j][0],pts[j][1], Math.hypot(pts[j][0]-pts[i][0],pts[j][1]-pts[i][1]), s.id, `dim_u${i}`);
    }

    // 4. Selection outline (follows the notched polygon)
    if (sel) {
        ctx.save(); ctx.strokeStyle='#b09030'; ctx.lineWidth=2; ctx.setLineDash([3,3]);
        const polyOut = injectCornerChecks(basePoly, s.checks);
        ctx.beginPath(); ctx.moveTo(polyOut[0][0], polyOut[0][1]);
        for (let i=1;i<polyOut.length;i++) ctx.lineTo(polyOut[i][0], polyOut[i][1]);
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
    }
    // Per-edge resize handles
    if (sel) {
        const hw = Math.floor(HND/2);
        for (let i = 0; i < basePoly.length; i++) {
            const j = (i+1) % basePoly.length;
            const mx = (basePoly[i][0] + basePoly[j][0]) / 2;
            const my = (basePoly[i][1] + basePoly[j][1]) / 2;
            ctx.fillStyle = '#fff'; ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
            ctx.fillRect(mx-hw, my-hw, HND, HND);
            ctx.strokeRect(mx-hw, my-hw, HND, HND);
        }
    }
    drawFsOutlineLabel(s);
}

function drawBSP(s, sel) {
    const pts = bspPolygon(s);
    // Fill
    const fill = sel ? 'rgba(201,168,76,0.12)' : 'rgba(218,230,248,0.88)';
    ctx.save();
    ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
    for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0],pts[i][1]);
    ctx.closePath(); ctx.fillStyle=fill; ctx.fill(); ctx.restore();
    // Border — 8 sides
    const sides = bspSides(s);
    for (const sd of sides) {
        const edgeData = s.edges?.[sd.key];
        if (edgeData?.type === 'segmented' && edgeData.segments?.length) {
            drawSegmentedEdge(ctx, edgeData, sd.x1, sd.y1, sd.x2, sd.y2, sel, sd.key);
        } else {
            const etype = edgeData?.type || 'none';
            drawBorderSegment(ctx, etype, sd.x1, sd.y1, sd.x2, sd.y2, sel);
            if (etype !== 'none') {
                const def = EDGE_DEFS[etype];
                if (def?.abbr) {
                    const mx=(sd.x1+sd.x2)/2, my=(sd.y1+sd.y2)/2;
                    const dx=sd.x2-sd.x1, dy=sd.y2-sd.y1, len=Math.hypot(dx,dy)||1;
                    const lx=mx+(dy/len)*14, ly=my+(-dx/len)*14;
                    ctx.save(); ctx.font='bold 9px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
                    ctx.strokeText(def.abbr,lx,ly); ctx.fillStyle=def.color; ctx.fillText(def.abbr,lx,ly); ctx.restore();
                }
            }
        }
    }
    // Dim lines for all 8 sides
    for (let i=0;i<8;i++) {
        const j=(i+1)%8;
        drawDimLine(pts[i][0],pts[i][1],pts[j][0],pts[j][1], Math.hypot(pts[j][0]-pts[i][0],pts[j][1]-pts[i][1]), s.id, `dim_b${i}`);
    }
    // Selection outline + per-edge resize handles
    if (sel) {
        ctx.save(); ctx.strokeStyle='#b09030'; ctx.lineWidth=2; ctx.setLineDash([3,3]);
        ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
        for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i][0],pts[i][1]);
        ctx.closePath(); ctx.stroke(); ctx.setLineDash([]); ctx.restore();
        const hw = Math.floor(HND/2);
        for (let i = 0; i < pts.length; i++) {
            const j = (i+1) % pts.length;
            const mx = (pts[i][0] + pts[j][0]) / 2;
            const my = (pts[i][1] + pts[j][1]) / 2;
            ctx.fillStyle = '#fff'; ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
            ctx.fillRect(mx-hw, my-hw, HND, HND);
            ctx.strokeRect(mx-hw, my-hw, HND, HND);
        }
    }
}

function drawShape(s, sel) {
    // Parent-bound subtype items get a red warning border when off any piece
    if (s.subtype && s.parentId != null && !itemIsOnPiece(s)) {
        ctx.save();
        ctx.strokeStyle = '#ff3030';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 3]);
        if (s.subtype === 'bocci') {
            const br = s.w / 2;
            ctx.beginPath(); ctx.arc(s.x + br, s.y + br, br + 3, 0, Math.PI * 2); ctx.stroke();
        } else {
            ctx.strokeRect(s.x - 3, s.y - 3, s.w + 6, s.h + 6);
        }
        ctx.restore();
    }
    if (s.shapeType === 'l') { drawLShape(s, sel); return; }
    if (s.shapeType === 'u') { drawUShape(s, sel); return; }
    if (s.shapeType === 'bsp') { drawBSP(s, sel); return; }
    if (s.shapeType === 'circle') {
        const r = s.w / 2, cx = s.x + r, cy = s.y + r;
        const fill = sel ? 'rgba(201,168,76,0.12)' : 'rgba(218,230,248,0.88)';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        // Draw circumference with edge profile style
        const arcType = s.edges?.arc?.type || 'none';
        const arcDef = EDGE_DEFS[arcType];
        ctx.save();
        ctx.setLineDash([]);
        if (arcType === 'none')      { ctx.strokeStyle = sel ? '#b09030' : '#222222'; ctx.lineWidth = sel ? 2 : 0.8; }
        else if (arcType === 'polished' || arcType === 'pencil') { ctx.strokeStyle = '#dd0000'; ctx.lineWidth = 2.5; }
        else if (arcType === 'ogee')      { ctx.strokeStyle = '#cc44cc'; ctx.lineWidth = 2.5; }
        else if (arcType === 'bullnose')  { ctx.strokeStyle = '#0088dd'; ctx.lineWidth = 4; }
        else if (arcType === 'halfbull')  { ctx.strokeStyle = '#00aa66'; ctx.lineWidth = 2.5; }
        else if (arcType === 'bevel')     { ctx.strokeStyle = '#dd8800'; ctx.lineWidth = 2.5; }
        else if (arcType === 'mitered')   { ctx.strokeStyle = '#7a3000'; ctx.lineWidth = 2; ctx.setLineDash([4,3]); }
        else if (arcType === 'special')   { ctx.strokeStyle = '#228B22'; ctx.lineWidth = 2.5; }
        else if (arcType === 'joint')     { ctx.strokeStyle = '#e0457b'; ctx.lineWidth = 2; ctx.setLineDash([5,4]); }
        else if (arcType === 'waterfall') { ctx.strokeStyle = '#006688'; ctx.lineWidth = 2; }
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        // Edge abbreviation label at top of circle
        if (arcType !== 'none' && arcDef?.abbr) {
            ctx.setLineDash([]);
            ctx.font = 'bold 9px Raleway,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.strokeText(arcDef.abbr, cx, cy - r - 10);
            ctx.fillStyle = arcDef.color; ctx.fillText(arcDef.abbr, cx, cy - r - 10);
        }
        ctx.restore();
        // Label
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = 'bold 11px Raleway,sans-serif';
        ctx.fillStyle = sel ? '#b09030' : '#e0ddd5';
        ctx.fillText(s.label, cx, cy - 7);
        const rIn = parseFloat(pxToIn(r));
        ctx.font = '10px Raleway,sans-serif'; ctx.fillStyle = '#999999';
        ctx.fillText(`r=${rIn}"`, cx, cy + 7);
        // Selection handles
        if (sel) {
            for (const [hx, hy] of [[cx-r,cy],[cx+r,cy],[cx,cy-r],[cx,cy+r]]) {
                ctx.beginPath(); ctx.arc(hx, hy, 4, 0, Math.PI*2);
                ctx.fillStyle = '#b09030'; ctx.fill();
            }
        }
        return;
    }
    const r = shapeRadii(s);
    const ch = shapeChamfers(s);
    const chB = shapeChamfersB(s);

    // 1. Fill
    let fill;
    if (s.subtype === 'sink_overmount')
        fill = sel ? 'rgba(10,25,80,0.35)' : 'rgba(18,42,120,0.82)';
    else if (s.subtype === 'sink_undermount')
        fill = sel ? 'rgba(50,180,50,0.25)' : 'rgba(160,240,140,0.90)';
    else if (s.subtype === 'cooktop')
        fill = sel ? 'rgba(210,140,40,0.18)' : 'rgba(255,240,200,0.94)';
    else
        fill = sel ? 'rgba(201,168,76,0.12)' : 'rgba(218,230,248,0.88)';
    // ── Outlet: dashed rect + label (early return, no standard border) ──
    if (s.subtype === 'outlet') {
        ctx.fillStyle = 'rgba(60,60,60,0.15)';
        ctx.fillRect(s.x, s.y, s.w, s.h);
        ctx.save(); ctx.setLineDash([3,2]);
        ctx.strokeStyle = sel ? '#b09030' : '#555'; ctx.lineWidth = sel ? 1.5 : 1;
        ctx.strokeRect(s.x, s.y, s.w, s.h); ctx.restore();
        const olx = s.x + s.w/2;
        ctx.font = 'bold 12px Raleway,sans-serif'; ctx.fillStyle = '#111';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('OUTLET', olx, s.y + s.h + 3);
        return;
    }

    // ── Bocci: circle + label (early return, no rect) ──
    if (s.subtype === 'bocci') {
        const br = s.w / 2, bcx = s.x + br, bcy = s.y + br;
        ctx.beginPath(); ctx.arc(bcx, bcy, br, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(60,60,60,0.15)'; ctx.fill();
        ctx.save(); ctx.setLineDash([3,2]);
        ctx.strokeStyle = sel ? '#b09030' : '#555'; ctx.lineWidth = sel ? 1.5 : 1;
        ctx.stroke(); ctx.restore();
        ctx.font = 'bold 12px Raleway,sans-serif'; ctx.fillStyle = '#111';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('BOCCI', bcx, bcy + br + 3);
        return;
    }

    // ── Vasque sink: blue filled circle + label ──
    if (s.subtype === 'sink_vasque') {
        const vr = s.w / 2, vcx = s.x + vr, vcy = s.y + vr;
        ctx.beginPath(); ctx.arc(vcx, vcy, vr, 0, Math.PI*2);
        ctx.fillStyle = sel ? 'rgba(30,80,200,0.3)' : 'rgba(40,100,220,0.7)'; ctx.fill();
        ctx.save(); ctx.setLineDash([4,3]);
        ctx.strokeStyle = sel ? '#b09030' : '#3366cc'; ctx.lineWidth = sel ? 2 : 1.5;
        ctx.stroke(); ctx.restore();
        ctx.font = 'bold 11px Raleway,sans-serif'; ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('VASQUE', vcx, vcy - 5);
        const rIn = parseFloat(pxToIn(vr));
        ctx.font = '10px Raleway,sans-serif'; ctx.fillStyle = '#aaccff';
        ctx.fillText(`r=${rIn}"`, vcx, vcy + 8);
        return;
    }

    // For plain rects with checks (no corner treatments / farm sink), fill
    // the notched polygon directly so the fill never bleeds into the notch —
    // the piece genuinely reads as "material removed".
    const hasAnyChamfer = ch.nw || ch.ne || ch.se || ch.sw;
    const hasAnyRadius  = r.nw  || r.ne  || r.se  || r.sw;
    const hasChecks     = (s.checks || []).length > 0;
    if (hasChecks && !hasAnyChamfer && !hasAnyRadius && !s.farmSink && (s.shapeType || 'rect') === 'rect') {
        const localPoly = buildRectPolyWithChecks(s);
        ctx.beginPath();
        ctx.moveTo(s.x + localPoly[0][0] * INCH, s.y + localPoly[0][1] * INCH);
        for (let i = 1; i < localPoly.length; i++) {
            ctx.lineTo(s.x + localPoly[i][0] * INCH, s.y + localPoly[i][1] * INCH);
        }
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
    } else {
        roundedRectPath(ctx, s.x, s.y, s.w, s.h, r, ch, chB);
        ctx.fillStyle = fill;
        ctx.fill();
    }

    // Carve out farmhouse sink notch (paint over with canvas background).
    // Works for all four edges (top/bottom/right/left) via farmSinkRectAbs.
    if (s.farmSink) {
        const fr = farmSinkRectAbs(s);
        if (fr) {
            ctx.save();
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
            ctx.restore();
        }
    }

    // (Corner-check notches: fill uses the notched polygon above; adjacent
    // border edges are naturally shortened and the two inner walls of each
    // notch are drawn separately below.)

    // 2. Border — each side drawn with its profile
    // A = along first incoming side, B = along outgoing side (0 = goes all the way to corner)
    const nwA = ch.nw > 0 ? ch.nw : r.nw,  nwB = ch.nw > 0 ? chB.nw : r.nw;
    const neA = ch.ne > 0 ? ch.ne : r.ne,  neB = ch.ne > 0 ? chB.ne : r.ne;
    const seA = ch.se > 0 ? ch.se : r.se,  seB = ch.se > 0 ? chB.se : r.se;
    const swA = ch.sw > 0 ? ch.sw : r.sw,  swB = ch.sw > 0 ? chB.sw : r.sw;
    // Corner check notches shorten the two edges meeting at that corner by
    // the check's width (along horizontal edge) and depth (along vertical
    // edge). The two perpendicular inner walls of the notch are drawn
    // separately below with plain ('none') profile.
    const ckByCorner = { nw:null, ne:null, se:null, sw:null };
    if (hasChecks && (s.shapeType || 'rect') === 'rect') {
        for (const c of s.checks) {
            if (ckByCorner.hasOwnProperty(c.cornerKey)) ckByCorner[c.cornerKey] = c;
        }
    }
    const nwCkW = ckByCorner.nw ? ckByCorner.nw.w : 0;
    const nwCkD = ckByCorner.nw ? ckByCorner.nw.d : 0;
    const neCkW = ckByCorner.ne ? ckByCorner.ne.w : 0;
    const neCkD = ckByCorner.ne ? ckByCorner.ne.d : 0;
    const seCkW = ckByCorner.se ? ckByCorner.se.w : 0;
    const seCkD = ckByCorner.se ? ckByCorner.se.d : 0;
    const swCkW = ckByCorner.sw ? ckByCorner.sw.w : 0;
    const swCkD = ckByCorner.sw ? ckByCorner.sw.d : 0;
    const sides = [
        { key:'top',    x1:s.x+nwA+nwCkW,   y1:s.y,              x2:s.x+s.w-neA-neCkW, y2:s.y               },
        { key:'right',  x1:s.x+s.w,          y1:s.y+neB+neCkD,   x2:s.x+s.w,           y2:s.y+s.h-seA-seCkD },
        { key:'bottom', x1:s.x+s.w-seB-seCkW,y1:s.y+s.h,         x2:s.x+swA+swCkW,     y2:s.y+s.h           },
        { key:'left',   x1:s.x,              y1:s.y+s.h-swB-swCkD,x2:s.x,              y2:s.y+nwB+nwCkD     },
    ];
    for (const sd of sides) {
        const edgeData = s.edges?.[sd.key];
        // Skip the cutout span on the FS edge — draw the two halves with their own profiles.
        if (s.farmSink && s.farmSink.edge === sd.key) {
            const fr = farmSinkRectAbs(s);
            const baseT = { type: edgeData?.type && edgeData.type !== 'segmented' ? edgeData.type : 'none' };
            const leftData  = edgeData?.fsLeft  || baseT;
            const rightData = edgeData?.fsRight || baseT;
            if (sd.key === 'top') {
                const fsLx = fr.x, fsRx = fr.x + fr.w;
                drawEdgeDatum(leftData,  sd.key + '_fsL', sd.x1, sd.y1, fsLx, sd.y1, sel);
                drawEdgeDatum(rightData, sd.key + '_fsR', fsRx, sd.y2, sd.x2, sd.y2, sel);
            } else if (sd.key === 'bottom') {
                const fsLx = fr.x, fsRx = fr.x + fr.w;
                drawEdgeDatum(rightData, sd.key + '_fsR', sd.x1, sd.y1, fsRx, sd.y1, sel);
                drawEdgeDatum(leftData,  sd.key + '_fsL', fsLx, sd.y2, sd.x2, sd.y2, sel);
            } else if (sd.key === 'right') {
                // right edge runs top → bottom (sd.y1 < sd.y2). FS cutout
                // covers vertical span [fr.y, fr.y + fr.h].
                const fsT = fr.y, fsB = fr.y + fr.h;
                drawEdgeDatum(leftData,  sd.key + '_fsL', sd.x1, sd.y1, sd.x1, fsT, sel);
                drawEdgeDatum(rightData, sd.key + '_fsR', sd.x2, fsB,   sd.x2, sd.y2, sel);
            } else if (sd.key === 'left') {
                // left edge runs bottom → top in the sides array (sd.y1 > sd.y2).
                const fsT = fr.y, fsB = fr.y + fr.h;
                drawEdgeDatum(rightData, sd.key + '_fsR', sd.x1, sd.y1, sd.x1, fsB, sel);
                drawEdgeDatum(leftData,  sd.key + '_fsL', sd.x2, fsT,   sd.x2, sd.y2, sel);
            }
            continue;
        }
        let labelOffset = null;
        if (sd.key === 'top')    labelOffset = { dx:0, dy:-14 };
        if (sd.key === 'bottom') labelOffset = { dx:0, dy: 14 };
        if (sd.key === 'left')   labelOffset = { dx:-14, dy:0 };
        if (sd.key === 'right')  labelOffset = { dx: 14, dy:0 };
        drawEdgeDatum(edgeData || { type: 'none' }, sd.key, sd.x1, sd.y1, sd.x2, sd.y2, sel, labelOffset);
    }
    // Draw the two perpendicular inner walls for each corner notch, with
    // plain 'none' profile. These form the L-shape that reads as carved-out.
    if (hasChecks && (s.shapeType || 'rect') === 'rect') {
        if (ckByCorner.nw) {
            const { w, d } = ckByCorner.nw;
            drawEdgeDatum(s.edges?.ck_nw_h || { type:'none' }, 'ck_nw_h', s.x,     s.y + d, s.x + w, s.y + d, sel);
            drawEdgeDatum(s.edges?.ck_nw_v || { type:'none' }, 'ck_nw_v', s.x + w, s.y + d, s.x + w, s.y,     sel);
        }
        if (ckByCorner.ne) {
            const { w, d } = ckByCorner.ne;
            drawEdgeDatum(s.edges?.ck_ne_v || { type:'none' }, 'ck_ne_v', s.x + s.w - w, s.y,     s.x + s.w - w, s.y + d, sel);
            drawEdgeDatum(s.edges?.ck_ne_h || { type:'none' }, 'ck_ne_h', s.x + s.w - w, s.y + d, s.x + s.w,     s.y + d, sel);
        }
        if (ckByCorner.se) {
            const { w, d } = ckByCorner.se;
            drawEdgeDatum(s.edges?.ck_se_h || { type:'none' }, 'ck_se_h', s.x + s.w,     s.y + s.h - d, s.x + s.w - w, s.y + s.h - d, sel);
            drawEdgeDatum(s.edges?.ck_se_v || { type:'none' }, 'ck_se_v', s.x + s.w - w, s.y + s.h - d, s.x + s.w - w, s.y + s.h,     sel);
        }
        if (ckByCorner.sw) {
            const { w, d } = ckByCorner.sw;
            drawEdgeDatum(s.edges?.ck_sw_v || { type:'none' }, 'ck_sw_v', s.x + w, s.y + s.h,     s.x + w, s.y + s.h - d, sel);
            drawEdgeDatum(s.edges?.ck_sw_h || { type:'none' }, 'ck_sw_h', s.x + w, s.y + s.h - d, s.x,     s.y + s.h - d, sel);
        }
    }

    // 2b. Corner arcs — styled per cornerEdges assignment
    const cornerDefs = [
        { key:'nw', cx:s.x+r.nw,     cy:s.y+r.nw,     r:r.nw, startA:Math.PI,     endA:1.5*Math.PI },
        { key:'ne', cx:s.x+s.w-r.ne, cy:s.y+r.ne,     r:r.ne, startA:1.5*Math.PI, endA:2*Math.PI   },
        { key:'se', cx:s.x+s.w-r.se, cy:s.y+s.h-r.se, r:r.se, startA:0,           endA:0.5*Math.PI },
        { key:'sw', cx:s.x+r.sw,     cy:s.y+s.h-r.sw, r:r.sw, startA:0.5*Math.PI, endA:Math.PI     },
    ];
    for (const cd of cornerDefs) {
        if (cd.r <= 0) continue;
        const ctype = s.cornerEdges?.[cd.key]?.type || 'none';
        const def = EDGE_DEFS[ctype];
        ctx.save();
        if (sel && ctype === 'none') { ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2; ctx.setLineDash([]); }
        else if (ctype === 'none')   { ctx.strokeStyle = '#222222'; ctx.lineWidth = 0.8; ctx.setLineDash([]); }
        else if (ctype === 'polished' || ctype === 'pencil') { ctx.strokeStyle = '#dd0000'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
        else if (ctype === 'ogee')      { ctx.strokeStyle = '#cc44cc'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
        else if (ctype === 'bullnose')  { ctx.strokeStyle = '#0088dd'; ctx.lineWidth = 4;   ctx.setLineDash([]); }
        else if (ctype === 'halfbull')  { ctx.strokeStyle = '#00aa66'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
        else if (ctype === 'bevel')     { ctx.strokeStyle = '#dd8800'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
        else if (ctype === 'mitered')  { ctx.strokeStyle = '#7a3000'; ctx.lineWidth = 2;   ctx.setLineDash([4,3]); }
        else if (ctype === 'special')  { ctx.strokeStyle = '#228B22'; ctx.lineWidth = 2.5; ctx.setLineDash([]); }
        else if (ctype === 'joint')    { ctx.strokeStyle = '#e0457b'; ctx.lineWidth = 2;   ctx.setLineDash([5,4]); }
        else if (ctype === 'waterfall'){ ctx.strokeStyle = '#006688'; ctx.lineWidth = 2;   ctx.setLineDash([]); }
        ctx.beginPath(); ctx.arc(cd.cx, cd.cy, cd.r, cd.startA, cd.endA); ctx.stroke();
        // Abbreviation label near arc midpoint (outside)
        if (ctype !== 'none' && def?.abbr) {
            const midA = (cd.startA + cd.endA) / 2;
            const mpx = cd.cx + Math.cos(midA) * cd.r;
            const mpy = cd.cy + Math.sin(midA) * cd.r;
            // outward = radial direction from center
            const ox = (mpx - cd.cx) / cd.r * 12, oy = (mpy - cd.cy) / cd.r * 12;
            ctx.setLineDash([]);
            ctx.font = 'bold 9px Raleway,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.strokeText(def.abbr, mpx + ox, mpy + oy);
            ctx.fillStyle = def.color; ctx.fillText(def.abbr, mpx + ox, mpy + oy);
        }
        ctx.restore();
    }

    // 2c. Chamfer diagonal lines + labels (asymmetric: A along first side, B along second)
    const chamferSegs = [
        { key:'nw', x1:s.x+ch.nw,     y1:s.y,           x2:s.x,         y2:s.y+nwB        },
        { key:'ne', x1:s.x+s.w-ch.ne, y1:s.y,           x2:s.x+s.w,     y2:s.y+neB        },
        { key:'se', x1:s.x+s.w,       y1:s.y+s.h-ch.se, x2:s.x+s.w-seB, y2:s.y+s.h       },
        { key:'sw', x1:s.x+ch.sw,     y1:s.y+s.h,       x2:s.x,         y2:s.y+s.h-swB   },
    ];
    for (const cd of chamferSegs) {
        if (ch[cd.key] <= 0) continue;
        const chData = s.chamferEdges?.[cd.key];
        if (chData?.type === 'segmented' && chData.segments?.length) {
            drawSegmentedEdge(ctx, chData, cd.x1, cd.y1, cd.x2, cd.y2, sel, cd.key);
        } else {
            const diagEtype = chData?.type || 'none';
            drawBorderSegment(ctx, diagEtype, cd.x1, cd.y1, cd.x2, cd.y2, sel);
            if (diagEtype !== 'none') {
                const def = EDGE_DEFS[diagEtype];
                if (def?.abbr) {
                    const emx=(cd.x1+cd.x2)/2, emy=(cd.y1+cd.y2)/2;
                    const edx=cd.x2-cd.x1, edy=cd.y2-cd.y1, elen=Math.hypot(edx,edy)||1;
                    const elx=emx+(edy/elen)*14, ely=emy+(-edx/elen)*14;
                    ctx.save(); ctx.font='bold 9px Raleway,sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
                    ctx.lineWidth=3; ctx.strokeStyle='rgba(255,255,255,0.85)';
                    ctx.strokeText(def.abbr,elx,ely); ctx.fillStyle=def.color; ctx.fillText(def.abbr,elx,ely); ctx.restore();
                }
            }
        }
    }

    // 2d. Farmhouse sink cutout interior outline (3 dashed sides + label)
    drawFsOutlineLabel(s);

    // 3. Dimension lines outside (countertop pieces only, not sinks/cooktops)
    if (!s.subtype) {
        drawDimLine(s.x,     s.y,     s.x+s.w, s.y,     s.w, s.id, 'dim_top');
        drawDimLine(s.x+s.w, s.y,     s.x+s.w, s.y+s.h, s.h, s.id, 'dim_right');
        drawDimLine(s.x+s.w, s.y+s.h, s.x,     s.y+s.h, s.w, s.id, 'dim_bottom');
        drawDimLine(s.x,     s.y+s.h, s.x,     s.y,     s.h, s.id, 'dim_left');
    }

    // 4. Shape label (joint lines drawn in a separate top-level pass)
    drawShapeLabel(s);

    // 5. Corner radius labels
    for (const [key, sx_, sy_, ox, oy] of [
        ['nw', s.x,     s.y,     1, 1],
        ['ne', s.x+s.w, s.y,    -1, 1],
        ['se', s.x+s.w, s.y+s.h,-1,-1],
        ['sw', s.x,     s.y+s.h, 1,-1],
    ]) {
        const rv = r[key];
        if (rv <= 0) continue;
        if (s.hideDims && s.hideDims[`rad_${key}`]) continue;
        const lx = sx_ + ox * (rv * 0.5 + 9);
        const ly = sy_ + oy * (rv * 0.5 + 9);
        ctx.save();
        ctx.font = '8px Raleway,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const rlabel = `R${pxToInFrac(rv)}`;
        const rtw = ctx.measureText(rlabel).width + 6;
        dimClickTargets.push({ rect: [lx - rtw/2, ly - 6, rtw, 12], shapeId: s.id, dimKey: `rad_${key}` });
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.strokeText(rlabel, lx, ly);
        ctx.fillStyle = '#cc4444'; ctx.fillText(rlabel, lx, ly);
        ctx.restore();
    }

    // 6. Selection handles
    if (sel) {
        const hw = Math.floor(HND/2);
        for (const h of handles(s)) {
            ctx.fillStyle = '#fff'; ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
            ctx.fillRect(h.px-hw, h.py-hw, HND, HND);
            ctx.strokeRect(h.px-hw, h.py-hw, HND, HND);
        }
    }
}

// ─────────────────────────────────────────────────────────────
//  Interior joint lines
// ─────────────────────────────────────────────────────────────
// ── Polish-Under areas ──────────────────────────────────────
// Each polish-under rectangle is stored shape-locally on its parent shape:
// { x, y, w, h } in shape-local pixels. drawPolishUnders renders them
// with diagonal hatching + a "POL. UNDER" label oriented along the
// rectangle's longer dimension.
function drawPolishUnders(s) {
    const arr = s.polishUnders || [];
    if (!arr.length) return;
    for (let i = 0; i < arr.length; i++) {
        const r = arr[i];
        const ax = s.x + r.x, ay = s.y + r.y, aw = r.w, ah = r.h;
        const isSel = selectedPU && selectedPU.shapeId === s.id && selectedPU.idx === i;
        ctx.save();
        ctx.beginPath(); ctx.rect(ax, ay, aw, ah); ctx.clip();
        // Diagonal hatching
        ctx.strokeStyle = isSel ? 'rgba(220,80,180,0.95)' : 'rgba(180,60,150,0.75)';
        ctx.lineWidth = 1;
        const step = 8;
        for (let d = -ah; d < aw + ah; d += step) {
            ctx.beginPath();
            ctx.moveTo(ax + d,         ay);
            ctx.lineTo(ax + d + ah,    ay + ah);
            ctx.stroke();
        }
        ctx.restore();
        // Outline
        ctx.save();
        ctx.strokeStyle = isSel ? '#dc50b4' : '#b03c96';
        ctx.lineWidth = isSel ? 2 : 1.5;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(ax, ay, aw, ah);
        ctx.setLineDash([]);
        ctx.restore();
        // Label "POL. UNDER" along longer dimension
        ctx.save();
        const cx = ax + aw / 2, cy = ay + ah / 2;
        const horizontal = aw >= ah;
        ctx.translate(cx, cy);
        if (!horizontal) ctx.rotate(-Math.PI / 2);
        // Auto-fit font size: aim for ~75% of long side
        const longSide = horizontal ? aw : ah;
        const shortSide = horizontal ? ah : aw;
        let fs = Math.min(16, longSide / 7, shortSide / 1.6);
        if (fs < 7) fs = 7;
        ctx.font = `bold ${fs}px Raleway,sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText('POL. UNDER', 0, 0);
        ctx.fillStyle = '#7a2862';
        ctx.fillText('POL. UNDER', 0, 0);
        ctx.restore();
    }
}
function drawPuPreview() {
    if (!drawingPU || !puParent || !puStart || !puCur) return;
    const x0 = Math.min(puStart.x, puCur.x), y0 = Math.min(puStart.y, puCur.y);
    const w = Math.abs(puCur.x - puStart.x), h = Math.abs(puCur.y - puStart.y);
    if (w < 0.5 || h < 0.5) return;
    const ax = puParent.x + x0, ay = puParent.y + y0;
    ctx.save();
    ctx.strokeStyle = '#dc50b4';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(ax, ay, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(220,80,180,0.18)';
    ctx.fillRect(ax, ay, w, h);
    ctx.font = 'bold 11px Raleway,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#7a2862';
    ctx.fillText(`${fmtInches(w/INCH)} × ${fmtInches(h/INCH)}`, ax + w/2, ay + h/2);
    ctx.restore();
}

function drawJointLines(s) {
    if (!s.joints || s.joints.length === 0) return;
    // Polygon used for point-in-shape tests when deciding which side of a
    // snapped corner is inside the shape.
    const polyForTest = (s.shapeType === 'l') ? lShapePolygon(s)
                      : (s.shapeType === 'u') ? uShapePolygon(s)
                      : (s.shapeType === 'bsp') ? bspPolygon(s)
                      : [[s.x, s.y], [s.x+s.w, s.y], [s.x+s.w, s.y+s.h], [s.x, s.y+s.h]];
    for (const j of s.joints) {
        const isSel = selectedJoint?.j === j;
        ctx.save();
        // Clip joint lines to the actual shape boundary
        if (s.shapeType === 'l' || s.shapeType === 'u' || s.shapeType === 'bsp') {
            const pts = polyForTest;
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let i=1; i<pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
            ctx.closePath(); ctx.clip();
        } else {
            const _r = shapeRadii(s), _ch = shapeChamfers(s), _chB = shapeChamfersB(s);
            const hasCorner = Object.values(_r).some(v=>v>0) || Object.values(_ch).some(v=>v>0);
            if (hasCorner) { roundedRectPath(ctx, s.x, s.y, s.w, s.h, _r, _ch, _chB); ctx.clip(); }
        }
        ctx.strokeStyle = '#e0457b';
        ctx.lineWidth   = isSel ? 2.5 : 1.8;
        ctx.setLineDash([5, 4]);

        if (j.axis === 'd' && j.snap && j.otherSnap) {
            const x1 = s.x + j.snap.relX,      y1 = s.y + j.snap.relY;
            const x2 = s.x + j.otherSnap.relX, y2 = s.y + j.otherSnap.relY;
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
            ctx.setLineDash([]);
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            ctx.font = 'bold 8px Raleway,sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            ctx.strokeText('JT', mx, my);
            ctx.fillStyle = '#e0457b'; ctx.fillText('JT', mx, my);
            if (isSel) {
                ctx.beginPath(); ctx.arc(mx, my, 5, 0, Math.PI*2);
                ctx.fillStyle = '#e0457b'; ctx.fill();
            }
            ctx.restore();
            continue;
        }
        if (j.axis === 'v') {
            const jx = s.x + clamp(j.pos, 2, s.w - 2);
            // Default endpoints span the bounding box; a snapped joint is
            // anchored at the corner and extends only into the shape so the
            // wall + joint read as one continuous line (two perfect rectangles
            // on either side of the cut).
            let y1 = s.y + 2, y2 = s.y + s.h - 2;
            if (j.snap) {
                const cy = s.y + j.snap.relY;
                // Probe all four quadrants around the corner, OFF the joint
                // axis, to avoid polygon-boundary ambiguity at x=jx.
                const t = 3;
                const upL = pointInPolygon(jx - t, cy - t, polyForTest);
                const upR = pointInPolygon(jx + t, cy - t, polyForTest);
                const dnL = pointInPolygon(jx - t, cy + t, polyForTest);
                const dnR = pointInPolygon(jx + t, cy + t, polyForTest);
                const upBoth = upL && upR;
                const dnBoth = dnL && dnR;
                if (dnBoth && !upBoth) y1 = cy;         // continuation runs DOWN from corner
                else if (upBoth && !dnBoth) y2 = cy;    // continuation runs UP from corner
            }
            ctx.beginPath(); ctx.moveTo(jx, y1); ctx.lineTo(jx, y2); ctx.stroke();
            ctx.setLineDash([]);
            // Label — placed just inside the visible segment's top end
            ctx.font = 'bold 8px Raleway,sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            const labelY = y1 + 2;
            ctx.strokeText('JT', jx, labelY);
            ctx.fillStyle = '#e0457b'; ctx.fillText('JT', jx, labelY);
            // Selection dot — midpoint of visible segment
            if (isSel) {
                ctx.beginPath(); ctx.arc(jx, (y1 + y2)/2, 5, 0, Math.PI*2);
                ctx.fillStyle = '#e0457b'; ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
            }
        } else {
            const jy = s.y + clamp(j.pos, 2, s.h - 2);
            let x1 = s.x + 2, x2 = s.x + s.w - 2;
            if (j.snap) {
                const cx = s.x + j.snap.relX;
                const t = 3;
                const upL = pointInPolygon(cx - t, jy - t, polyForTest);
                const upR = pointInPolygon(cx + t, jy - t, polyForTest);
                const dnL = pointInPolygon(cx - t, jy + t, polyForTest);
                const dnR = pointInPolygon(cx + t, jy + t, polyForTest);
                const leftBoth  = upL && dnL;
                const rightBoth = upR && dnR;
                if (rightBoth && !leftBoth) x1 = cx;       // continuation runs RIGHT from corner
                else if (leftBoth && !rightBoth) x2 = cx;  // continuation runs LEFT from corner
            }
            ctx.beginPath(); ctx.moveTo(x1, jy); ctx.lineTo(x2, jy); ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = 'bold 8px Raleway,sans-serif';
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
            const labelX = x1 + 3;
            ctx.strokeText('JT', labelX, jy - 2);
            ctx.fillStyle = '#e0457b'; ctx.fillText('JT', labelX, jy - 2);
            if (isSel) {
                ctx.beginPath(); ctx.arc((x1 + x2)/2, jy, 5, 0, Math.PI*2);
                ctx.fillStyle = '#e0457b'; ctx.fill();
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
            }
        }
        ctx.restore();
    }
}

// ─────────────────────────────────────────────────────────────
//  Shape label (text inside shape)
// ─────────────────────────────────────────────────────────────
function drawShapeLabel(s) {
    if (s.w < 14 || s.h < 10) return;
    const cx = s.x + s.w/2, cy = s.y + s.h/2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    if (s.subtype === 'sink_overmount' || s.subtype === 'sink_undermount') {
        const isOver = s.subtype === 'sink_overmount';
        ctx.fillStyle = isOver ? '#d0e8ff' : '#1a4a10';
        if (s.w >= 36 && s.h >= 24) {
            ctx.font = 'bold 10px Raleway,sans-serif'; ctx.fillText('SINK', cx, cy - 8);
            ctx.font = '9px Raleway,sans-serif';
            ctx.fillText(isOver ? 'OVERMOUNT' : 'UNDERMOUNT', cx, cy + 5);
            if (s.w >= 48 && s.h >= 36) {
                ctx.fillStyle = isOver ? '#a0c8e8' : '#3a7a28'; ctx.font = '8px Raleway,sans-serif';
                ctx.fillText(`${pxToInFrac(s.w)} × ${pxToInFrac(s.h)}`, cx, cy + 17);
            }
        } else { ctx.font = 'bold 8px Raleway,sans-serif'; ctx.fillText('S', cx, cy); }
        return;
    }

    if (s.subtype === 'cooktop') {
        if (s.w >= 48 && s.h >= 32) {
            const bx = s.w*0.22, by = s.h*0.22;
            const br = Math.min(bx, by) * 0.65;
            for (const [ox,oy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
                const bpx = cx+ox*bx, bpy = cy+oy*by;
                ctx.beginPath(); ctx.arc(bpx, bpy, Math.min(br,12), 0, Math.PI*2);
                ctx.strokeStyle = '#886600'; ctx.lineWidth = 1.5; ctx.stroke();
                ctx.beginPath(); ctx.arc(bpx, bpy, Math.min(br*0.38,5), 0, Math.PI*2);
                ctx.fillStyle = '#cc8800'; ctx.fill();
            }
        }
        ctx.fillStyle = '#5a3300'; ctx.font = 'bold 9px Raleway,sans-serif';
        ctx.fillText('COOKTOP', cx, s.y + 9);
        if (s.w >= 40 && s.h >= 24) {
            ctx.font = '8px Raleway,sans-serif'; ctx.fillStyle = '#997700';
            ctx.fillText(`${pxToInFrac(s.w)} × ${pxToInFrac(s.h)}`, cx, s.y + s.h - 9);
        }
        return;
    }

}

// ─────────────────────────────────────────────────────────────
//  Hover indicators
// ─────────────────────────────────────────────────────────────
function drawHoverIndicators() {
    if (tool === 'radius' && hovCorner) {
        ctx.save(); ctx.beginPath(); ctx.arc(hovCorner.px, hovCorner.py, 9, 0, Math.PI*2);
        ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8; ctx.stroke();
        ctx.globalAlpha = 1; ctx.restore();
    }
    if (tool === 'edge' || tool === 'splitedge') {
        if (hovEdge) {
            ctx.save();
            ctx.strokeStyle = tool === 'splitedge' ? '#e0a030' : '#b09030'; ctx.lineWidth = 4; ctx.globalAlpha = 0.5;
            if (hovEdge.s.shapeType === 'circle') {
                ctx.beginPath(); ctx.arc(hovEdge.cx, hovEdge.cy, hovEdge.r, 0, Math.PI * 2); ctx.stroke();
            } else {
                ctx.beginPath(); ctx.moveTo(hovEdge.x1, hovEdge.y1); ctx.lineTo(hovEdge.x2, hovEdge.y2); ctx.stroke();
            }
            ctx.globalAlpha = 1; ctx.restore();
        }
        if (hovCornerEdge) {
            ctx.save(); ctx.beginPath(); ctx.arc(hovCornerEdge.px, hovCornerEdge.py, 9, 0, Math.PI*2);
            ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.8; ctx.stroke();
            ctx.globalAlpha = 1; ctx.restore();
        }
    }

}

// ─────────────────────────────────────────────────────────────
//  Draw preview (while dragging new rect)
// ─────────────────────────────────────────────────────────────
function drawPreview() {
    if (!drawing || !dStart || !dCur) return;
    const { x, y, w, h } = normRect(dStart.x, dStart.y, dCur.x-dStart.x, dCur.y-dStart.y);
    if (w < 1 || h < 1) return;
    ctx.fillStyle = 'rgba(201,168,76,0.13)'; ctx.fillRect(x,y,w,h);
    ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
    ctx.setLineDash([5,3]); ctx.strokeRect(x,y,w,h); ctx.setLineDash([]);
    if (w >= 20 && h >= 14) {
        ctx.fillStyle = '#b09030'; ctx.font = 'bold 11px Raleway,sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(`${pxToInFrac(w)} × ${pxToInFrac(h)}`, x+w/2, y+h/2);
    }
}

function render() {
    dimLabelRects = [];
    dimClickTargets = [];
    // Grid
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, CW, CH);
    ctx.save();
    ctx.strokeStyle = 'rgba(200,210,230,0.22)'; ctx.lineWidth = 0.5; ctx.setLineDash([1,5]);
    for (let x = 0; x <= CW; x += FOOT/2) { if (x%FOOT===0) continue; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,CH); ctx.stroke(); }
    for (let y = 0; y <= CH; y += FOOT/2) { if (y%FOOT===0) continue; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(CW,y); ctx.stroke(); }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(160,175,200,0.42)'; ctx.lineWidth = 0.75;
    for (let x = 0; x <= CW; x += FOOT) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,CH); ctx.stroke(); }
    for (let y = 0; y <= CH; y += FOOT) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(CW,y); ctx.stroke(); }
    ctx.restore();

    // Draw regular shapes first, then sinks/cooktops/outlets on top
    shapes.filter(s => !s.subtype).forEach(s => drawShape(s, s.id === selected));
    shapes.filter(s => !s.subtype).forEach(s => drawJointLines(s));
    shapes.filter(s => !s.subtype).forEach(s => drawPolishUnders(s));
    shapes.filter(s => s.subtype).forEach(s => drawShape(s, s.id === selected));
    drawPuPreview();
    // Draw text annotations on top
    for (const ti of textItems) {
        const isSel = ti.id === selectedText;
        ctx.save();
        ctx.font = `bold ${ti.size||12}px Raleway,sans-serif`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        if (isSel) {
            const w = ctx.measureText(ti.text).width;
            const h = (ti.size||12) + 4;
            ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
            ctx.strokeRect(ti.x - 2, ti.y - 2, w + 4, h + 4);
            ctx.setLineDash([]);
        }
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText(ti.text, ti.x, ti.y);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillText(ti.text, ti.x, ti.y);
        ctx.restore();
    }
    // Ghost text following cursor
    if (ghostText) {
        ctx.save();
        ctx.globalAlpha = 0.55;
        ctx.font = `bold ${ghostText.size||12}px Raleway,sans-serif`;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.strokeText(ghostText.text, ghostTextPos.x, ghostTextPos.y);
        ctx.fillStyle = '#1a2a44';
        ctx.fillText(ghostText.text, ghostTextPos.x, ghostTextPos.y);
        ctx.globalAlpha = 1;
        ctx.restore();
    }
    drawHoverIndicators();
    drawPreview();
    drawMeasurements();
    drawProfileDiags();
    drawChamferPickUI();
    // When the joint tool is active, pulse gold dots on every inside corner
    // of every shape so the user knows exactly where joints can be placed.
    if (tool === 'joint') {
        ctx.save();
        for (const s of shapes) {
            if (s.subtype) continue;
            const corners = getInsideCornersForJoint(s);
            for (const c of corners) {
                // Halo
                ctx.beginPath();
                ctx.arc(c.x, c.y, 12, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(176,144,48,0.35)';
                ctx.lineWidth = 2.5;
                ctx.stroke();
                // Solid dot
                ctx.beginPath();
                ctx.arc(c.x, c.y, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#b09030';
                ctx.fill();
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#ffffff';
                ctx.stroke();
            }
        }
        ctx.restore();
    }
    // When the Check tool is active, highlight each convex corner on every
    // shape so the user can pick which corner gets the notch.
    if (tool === 'check') {
        ctx.save();
        const drawDot = (x, y) => {
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(176,144,48,0.35)';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fillStyle = '#b09030';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        };
        for (const s of shapes) {
            if (s.subtype) continue;
            const st = s.shapeType || 'rect';
            if (st === 'rect') {
                drawDot(s.x,       s.y      );
                drawDot(s.x + s.w, s.y      );
                drawDot(s.x + s.w, s.y + s.h);
                drawDot(s.x,       s.y + s.h);
            } else if (st === 'l' || st === 'u') {
                const poly = st === 'l' ? lShapePolygon(s) : uShapePolygon(s);
                for (const i of convexVertexIndices(poly)) {
                    drawDot(poly[i][0], poly[i][1]);
                }
            }
        }
        ctx.restore();
    }

    // Joint-snap indicator: gold dot + halo when a joint drag is locked to an inside corner
    if (jointSnapCorner) {
        ctx.save();
        // Halo
        ctx.beginPath();
        ctx.arc(jointSnapCorner.x, jointSnapCorner.y, 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(176,144,48,0.35)';
        ctx.lineWidth = 3;
        ctx.stroke();
        // Solid dot
        ctx.beginPath();
        ctx.arc(jointSnapCorner.x, jointSnapCorner.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#b09030';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();
    }
    // Update right-panel live sections
    if (typeof updateLiveLegend === 'function') updateLiveLegend();
}

// ─────────────────────────────────────────────────────────────
//  Rulers
// ─────────────────────────────────────────────────────────────
function drawRulerCorner() {
    ctxC.fillStyle = '#2d3a10'; ctxC.fillRect(0,0,RULER_SZ,RULER_SZ);
    ctxC.strokeStyle = '#333333'; ctxC.lineWidth = 1;
    ctxC.beginPath(); ctxC.moveTo(RULER_SZ-1,0); ctxC.lineTo(RULER_SZ-1,RULER_SZ); ctxC.stroke();
    ctxC.beginPath(); ctxC.moveTo(0,RULER_SZ-1); ctxC.lineTo(RULER_SZ,RULER_SZ-1); ctxC.stroke();
}
function drawRulerH() {
    ctxH.fillStyle = '#2d3a10'; ctxH.fillRect(0,0,CW,RULER_SZ);
    ctxH.strokeStyle = '#333333'; ctxH.lineWidth = 1;
    ctxH.beginPath(); ctxH.moveTo(0,RULER_SZ-1); ctxH.lineTo(CW,RULER_SZ-1); ctxH.stroke();
    for (let x = 0; x <= CW; x += FOOT/2) {
        const ft = x/FOOT; const major = Number.isInteger(ft);
        ctxH.strokeStyle = major?'#8a7a40':'#3a3818'; ctxH.lineWidth = 1;
        ctxH.beginPath(); ctxH.moveTo(x,RULER_SZ-1); ctxH.lineTo(x,RULER_SZ-1-(major?10:5)); ctxH.stroke();
        if (major && ft > 0) { ctxH.fillStyle='#a09048'; ctxH.font='9px Raleway,sans-serif'; ctxH.textAlign='center'; ctxH.textBaseline='middle'; ctxH.fillText(`${ft}'`,x,RULER_SZ/2-1); }
    }
}
function drawRulerV() {
    ctxV.fillStyle = '#2d3a10'; ctxV.fillRect(0,0,RULER_SZ,CH);
    ctxV.strokeStyle = '#333333'; ctxV.lineWidth = 1;
    ctxV.beginPath(); ctxV.moveTo(RULER_SZ-1,0); ctxV.lineTo(RULER_SZ-1,CH); ctxV.stroke();
    for (let y = 0; y <= CH; y += FOOT/2) {
        const ft = y/FOOT; const major = Number.isInteger(ft);
        ctxV.strokeStyle = major?'#8a7a40':'#3a3818'; ctxV.lineWidth = 1;
        ctxV.beginPath(); ctxV.moveTo(RULER_SZ-1,y); ctxV.lineTo(RULER_SZ-1-(major?10:5),y); ctxV.stroke();
        if (major && ft > 0) { ctxV.save(); ctxV.translate(RULER_SZ/2-1,y); ctxV.rotate(-Math.PI/2); ctxV.fillStyle='#a09048'; ctxV.font='9px Raleway,sans-serif'; ctxV.textAlign='center'; ctxV.textBaseline='middle'; ctxV.fillText(`${ft}'`,0,0); ctxV.restore(); }
    }
}

// ─────────────────────────────────────────────────────────────
//  Legend swatches
// ─────────────────────────────────────────────────────────────
function drawLegendSwatches() {
    for (const [type] of Object.entries(EDGE_DEFS)) {
        if (type === 'none') continue;
        const el = document.getElementById(`leg-${type}`);
        if (!el) continue;
        const lc = el.getContext('2d');
        lc.clearRect(0,0,el.width,el.height);
        lc.fillStyle = 'rgba(218,230,248,0.35)'; lc.fillRect(0,0,el.width,el.height);
        drawBorderSegment(lc, type, 3, el.height/2, el.width-3, el.height/2, false);
    }
    // Interior joint swatch
    const ijEl = document.getElementById('leg-ijoint');
    if (ijEl) {
        const lc = ijEl.getContext('2d');
        lc.clearRect(0,0,ijEl.width,ijEl.height);
        lc.fillStyle = 'rgba(218,230,248,0.35)'; lc.fillRect(0,0,ijEl.width,ijEl.height);
        lc.save();
        lc.strokeStyle = '#e0457b'; lc.lineWidth = 1.8; lc.setLineDash([5,4]);
        lc.beginPath(); lc.moveTo(ijEl.width/2, 2); lc.lineTo(ijEl.width/2, ijEl.height-2); lc.stroke();
        lc.restore();
    }
}

// ─────────────────────────────────────────────────────────────
//  Popup helpers
// ─────────────────────────────────────────────────────────────
function hideAllPopups() {
    ['size-popup','lshape-popup','ushape-popup','bsp-popup','circle-popup','sink-popup','radius-popup','edge-popup','joint-popup','check-popup','matdb-popup','text-popup'].forEach(id =>
        document.getElementById(id).style.display = 'none');
    currentPopup = null; pendingPlace = null; pendingCorner = null;
    pendingEdge = null; pendingJointShape = null; pendingJointPos = null;
    pendingCheckShape = null; pendingCheckCorner = null; pendingCheckVertex = null;
}

function screenPos(cvX, cvY) {
    const r = cv.getBoundingClientRect();
    return { x: r.left + cvX, y: r.top + cvY };
}

function showPopupAt(el, prefX, prefY) {
    el.style.display = 'block';
    // measure after display
    requestAnimationFrame(() => {
        const w = el.offsetWidth || 220, h = el.offsetHeight || 180;
        el.style.left = Math.max(8, Math.min(prefX, window.innerWidth  - w - 10)) + 'px';
        el.style.top  = Math.max(8, Math.min(prefY, window.innerHeight - h - 10)) + 'px';
    });
}

// ── Viewport-centered placement ─────────────────────────────
function centeredPos(wPx, hPx) {
    const scroller = document.querySelector('.canvas-scroll');
    const cx = scroller.scrollLeft + scroller.clientWidth  / 2 - RULER_SZ;
    const cy = scroller.scrollTop  + scroller.clientHeight / 2 - RULER_SZ;
    return {
        x: clamp(Math.round(cx - wPx / 2), 0, Math.max(0, CW - wPx)),
        y: clamp(Math.round(cy - hPx / 2), 0, Math.max(0, CH - hPx))
    };
}

// ── Size popup ──────────────────────────────────────────────
const popupSize = document.getElementById('size-popup');
const popW = document.getElementById('pop-w');
const popH = document.getElementById('pop-h');

function showSizePopup(defW, defH, editId) {
    hideAllPopups();
    editingId = editId;
    popW.value = fmtInchesNoMark(parseFloat(defW)); popH.value = fmtInchesNoMark(parseFloat(defH));
    document.getElementById('pop-title').textContent = editId !== null ? 'Edit Dimensions' : 'Set Dimensions';
    document.getElementById('pop-ok').textContent    = editId !== null ? 'Save'            : 'Add Piece';
    currentPopup = 'size';
    const cvRect = cv.getBoundingClientRect();
    let lx, ly;
    if (editId !== null) {
        const s = byId(editId);
        lx = cvRect.left + (s ? s.x + s.w/2 - 105 : cvRect.width/2 - 105);
        ly = cvRect.top  + (s ? s.y - 140          : cvRect.height/2 - 90);
    } else if (pendingPlace) {
        lx = cvRect.left + pendingPlace.x + 20; ly = cvRect.top + pendingPlace.y - 20;
    } else {
        lx = cvRect.left + cvRect.width/2 - 105; ly = cvRect.top + cvRect.height/2 - 90;
    }
    showPopupAt(popupSize, lx, ly);
    popW.focus(); popW.select();
}
function confirmSizePopup() {
    const w = parseInchInput(popW.value), h = parseInchInput(popH.value);
    if (!w || !h || w <= 0 || h <= 0) { popW.focus(); return; }
    const wPx = (w*INCH), hPx = (h*INCH);
    if (editingId !== null) {
        const s = byId(editingId);
        if (s) { pushUndo(); s.w = clamp(wPx,INCH,CW-s.x); s.h = clamp(hPx,INCH,CH-s.y); persist(); }
    } else {
        const cp = centeredPos(wPx, hPx);
        pushUndo();
        shapes.push(normalizeShape({ id:nextId, label:`P${nextId}`, x:cp.x, y:cp.y, w:wPx, h:hPx }));
        nextId++; persist();
    }
    hideAllPopups(); setTool('select'); render(); updateStatus();
}
document.getElementById('pop-ok').addEventListener('click', confirmSizePopup);
document.getElementById('pop-cancel').addEventListener('click', () => { hideAllPopups(); render(); });
[popW, popH].forEach(inp => inp.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmSizePopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); render(); }
    e.stopPropagation();
}));

// ── Sink popup ───────────────────────────────────────────────
function _sinkSetType(type) {
    sinkMountType = type;
    document.getElementById('sink-btn-over').classList.toggle('active', type === 'overmount');
    document.getElementById('sink-btn-under').classList.toggle('active', type === 'undermount');
    document.getElementById('sink-btn-vasque').classList.toggle('active', type === 'vasque');
    document.getElementById('sink-rect-fields').style.display = type === 'vasque' ? 'none' : '';
    document.getElementById('sink-vasque-fields').style.display = type === 'vasque' ? '' : 'none';
}
document.getElementById('sink-btn-over').addEventListener('click', () => _sinkSetType('overmount'));
document.getElementById('sink-btn-under').addEventListener('click', () => _sinkSetType('undermount'));
document.getElementById('sink-btn-vasque').addEventListener('click', () => _sinkSetType('vasque'));
function showSinkPopup(cvX, cvY) {
    hideAllPopups(); pendingPlace = { x:cvX, y:cvY };
    _sinkSetType('overmount');
    document.getElementById('sink-w').value = 24;
    document.getElementById('sink-h').value = 15;
    document.getElementById('sink-vasque-r').value = 8;
    currentPopup = 'sink';
    const sp = screenPos(cvX, cvY);
    showPopupAt(document.getElementById('sink-popup'), sp.x + 20, sp.y - 20);
    document.getElementById('sink-w').focus();
}
function confirmSinkPopup() {
    // Bind to the parent piece selected at click time. Position centered on
    // the click point, clamped within the parent's bounding box.
    const parent = pendingItemParent != null ? byId(pendingItemParent) : null;
    pendingItemParent = null;
    const clickX = pendingPlace ? pendingPlace.x : null;
    const clickY = pendingPlace ? pendingPlace.y : null;
    function placeChild(wPx, hPx, subtype) {
        let x, y;
        if (parent && clickX != null) {
            x = parent.x + clamp(clickX - parent.x - wPx/2, 0, Math.max(0, parent.w - wPx));
            y = parent.y + clamp(clickY - parent.y - hPx/2, 0, Math.max(0, parent.h - hPx));
        } else {
            const cp = centeredPos(wPx, hPx);
            x = cp.x; y = cp.y;
        }
        const data = { id:nextId, label:`P${nextId}`, x, y, w:wPx, h:hPx, subtype };
        if (parent) data.parentId = parent.id;
        shapes.push(normalizeShape(data));
        nextId++;
    }
    if (sinkMountType === 'vasque') {
        const r = parseInchInput(document.getElementById('sink-vasque-r').value);
        if (!r || r < 1) return;
        const dPx = (r*2*INCH);
        pushUndo();
        placeChild(dPx, dPx, 'sink_vasque');
        persist(); hideAllPopups(); setTool('select'); render(); updateStatus();
        return;
    }
    const w = parseInchInput(document.getElementById('sink-w').value);
    const h = parseInchInput(document.getElementById('sink-h').value);
    if (!w || !h) return;
    const wPx = (w*INCH), hPx = (h*INCH);
    pushUndo();
    placeChild(wPx, hPx, `sink_${sinkMountType}`);
    persist(); hideAllPopups(); setTool('select'); render(); updateStatus();
}
document.getElementById('sink-ok').addEventListener('click', confirmSinkPopup);
document.getElementById('sink-cancel').addEventListener('click', () => hideAllPopups());
['sink-w','sink-h','sink-vasque-r'].forEach(id => document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmSinkPopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
    e.stopPropagation();
}));

// ── Circle popup ─────────────────────────────────────────────
function showCirclePopup() {
    hideAllPopups();
    currentPopup = 'circle';
    const cvRect = cv.getBoundingClientRect();
    showPopupAt(document.getElementById('circle-popup'), cvRect.left + cvRect.width/2 - 110, cvRect.top + cvRect.height/2 - 80);
    const ri = document.getElementById('circle-r'); ri.focus(); ri.select();
}
function confirmCirclePopup() {
    const r = parseInchInput(document.getElementById('circle-r').value);
    if (!r || r <= 0) { document.getElementById('circle-r').focus(); return; }
    const dPx = (r*2*INCH);
    const cp = centeredPos(dPx, dPx);
    pushUndo();
    shapes.push(normalizeShape({ id:nextId, label:`P${nextId}`, x:cp.x, y:cp.y, w:dPx, h:dPx, shapeType:'circle' }));
    nextId++; persist(); hideAllPopups(); setTool('select'); render(); updateStatus();
}
let editingCircleId = null;
function showCircleEditPopup(s) {
    hideAllPopups();
    editingCircleId = s.id;
    document.getElementById('circle-r').value = fmtInchesNoMark(s.w / 2 / INCH);
    document.getElementById('circle-ok').textContent = 'Save';
    currentPopup = 'circle';
    const cvRect = cv.getBoundingClientRect();
    showPopupAt(document.getElementById('circle-popup'), cvRect.left + cvRect.width/2 - 110, cvRect.top + cvRect.height/2 - 80);
    const ri = document.getElementById('circle-r'); ri.focus(); ri.select();
}
function confirmCircleEdit() {
    const s = byId(editingCircleId);
    if (!s) return;
    const r = parseInchInput(document.getElementById('circle-r').value);
    if (!r || r <= 0) return;
    const dPx = (r*2*INCH);
    pushUndo(); s.w = dPx; s.h = dPx;
    editingCircleId = null;
    document.getElementById('circle-ok').textContent = 'Add Piece';
    persist(); hideAllPopups(); setTool('select'); render();
}
document.getElementById('circle-ok').addEventListener('click', () => {
    if (editingCircleId !== null) confirmCircleEdit(); else confirmCirclePopup();
});
document.getElementById('circle-cancel').addEventListener('click', () => {
    editingCircleId = null;
    document.getElementById('circle-ok').textContent = 'Add Piece';
    hideAllPopups(); setTool('select');
});
document.getElementById('circle-r').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); if (editingCircleId !== null) confirmCircleEdit(); else confirmCirclePopup(); }
    if (e.key === 'Escape') { e.preventDefault(); editingCircleId = null; document.getElementById('circle-ok').textContent = 'Add Piece'; hideAllPopups(); setTool('select'); }
    e.stopPropagation();
});

// ── Radius popup ─────────────────────────────────────────────
function setCornerMode(mode) {
    document.getElementById('corner-mode').value = mode;
    document.getElementById('corner-tog-round').classList.toggle('active', mode === 'round');
    document.getElementById('corner-tog-chamfer').classList.toggle('active', mode === 'chamfer');
    document.getElementById('radius-round-section').style.display   = mode === 'round'    ? '' : 'none';
    document.getElementById('radius-chamfer-section').style.display = mode === 'chamfer'  ? '' : 'none';
}
document.getElementById('corner-tog-round').addEventListener('click', () => setCornerMode('round'));
document.getElementById('corner-tog-chamfer').addEventListener('click', () => setCornerMode('chamfer'));
document.getElementById('chamfer-pick-btn').addEventListener('click', () => {
    if (!pendingCorner) return;
    const edges = getChamferPickEdges(pendingCorner.s, pendingCorner.key);
    if (!edges) return;
    chamferPickState = { s: pendingCorner.s, key: pendingCorner.key, step: 1,
        edgeA: edges.edgeA, edgeB: edges.edgeB, pt1: null, pt1Edge: null, hoverPt: null };
    hideAllPopups();
    render();
});
document.getElementById('radius-cancel2').addEventListener('click', () => hideAllPopups());

function showRadiusPopup(corner) {
    hideAllPopups(); pendingCorner = corner;
    const hasChamfer = (corner.s.chamfers?.[corner.key] || 0) > 0;
    const val = hasChamfer
        ? 0
        : parseFloat(pxToIn(corner.s.corners?.[corner.key] || 0)) || 0;
    setCornerMode(hasChamfer ? 'chamfer' : 'round');
    document.getElementById('radius-val').value = val;
    document.getElementById('radius-corner-lbl').textContent = corner.label || corner.key.toUpperCase();
    currentPopup = 'radius';
    const sp = screenPos(corner.px, corner.py);
    showPopupAt(document.getElementById('radius-popup'), sp.x + 16, sp.y - 120);
    if (!hasChamfer) { const rv = document.getElementById('radius-val'); rv.focus(); rv.select(); }
}
function confirmRadiusPopup() {
    if (!pendingCorner) return;
    const valIn = parseInchInput(document.getElementById('radius-val').value) || 0;
    const mode  = document.getElementById('corner-mode').value;
    const px    = Math.max(0, (valIn*INCH));
    pushUndo();
    if (!pendingCorner.s.corners)  pendingCorner.s.corners  = { nw:0, ne:0, se:0, sw:0 };
    if (!pendingCorner.s.chamfers) pendingCorner.s.chamfers = { nw:0, ne:0, se:0, sw:0 };
    // Round mode only — chamfer is handled by 2-point pick
    pendingCorner.s.corners[pendingCorner.key]  = px;
    pendingCorner.s.chamfers[pendingCorner.key] = 0;
    if (pendingCorner.s.chamfersB) pendingCorner.s.chamfersB[pendingCorner.key] = null;
    persist(); hideAllPopups(); setTool('select'); render();
}
document.getElementById('radius-ok').addEventListener('click', confirmRadiusPopup);
document.getElementById('radius-cancel').addEventListener('click', () => hideAllPopups());
document.getElementById('radius-val').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmRadiusPopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
    e.stopPropagation();
});

// ── Edge popup ───────────────────────────────────────────────
const edgeTypeSel = document.getElementById('edge-type-sel');
const RECT_EDGE_LABELS = { top:'Top', right:'Right', bottom:'Bottom', left:'Left' };
// ── Edge popup (original — full edge only) ──────────────
function showEdgePopup(edgeHit) {
    hideAllPopups(); pendingEdge = edgeHit;
    edgeTypeSel.value = edgeHit.s.edges?.[edgeHit.key]?.type || 'none';
    if (edgeTypeSel.value === 'segmented') edgeTypeSel.value = 'none';
    document.getElementById('miter-width-val').value = '';
    document.getElementById('miter-width-val').style.borderColor = '';
    document.getElementById('miter-width-row').style.display = edgeTypeSel.value === 'mitered' ? 'flex' : 'none';
    const lbl = edgeHit.label || RECT_EDGE_LABELS[edgeHit.key] || edgeHit.key;
    document.getElementById('edge-which-lbl').textContent = lbl;
    currentPopup = 'edge';
    const s = edgeHit.s;
    let midX = s.x+s.w/2, midY = s.y+s.h/2;
    if (s.shapeType !== 'l') {
        midX = edgeHit.key === 'left' ? s.x : edgeHit.key === 'right' ? s.x+s.w : s.x+s.w/2;
        midY = edgeHit.key === 'top'  ? s.y : edgeHit.key === 'bottom' ? s.y+s.h : s.y+s.h/2;
    }
    const sp = screenPos(midX, midY);
    showPopupAt(document.getElementById('edge-popup'), sp.x - 105, sp.y - 130);
    edgeTypeSel.focus();
}
function confirmEdgePopup() {
    if (!pendingEdge) return;
    if (edgeTypeSel.value === 'mitered') {
        const miterW = parseInchInput(document.getElementById('miter-width-val').value);
        if (!miterW || miterW <= 0) {
            document.getElementById('miter-width-val').focus();
            document.getElementById('miter-width-val').style.borderColor = '#e05c5c';
            return;
        }
        document.getElementById('miter-width-val').style.borderColor = '';
    }
    pushUndo();
    if (!pendingEdge.s.edges) {
        if (pendingEdge.s.shapeType === 'circle') pendingEdge.s.edges = {arc:{type:'none'}};
        else pendingEdge.s.edges = { top:{type:'none'}, right:{type:'none'}, bottom:{type:'none'}, left:{type:'none'} };
    }
    pendingEdge.s.edges[pendingEdge.key] = { type: edgeTypeSel.value };
    if (edgeTypeSel.value === 'mitered') {
        const s = pendingEdge.s, key = pendingEdge.key;
        const miterW = parseInchInput(document.getElementById('miter-width-val').value);
        const miterPx = miterW * INCH;
        let stripW, stripH, stripX, stripY;
        if (key === 'top' || key === 'bottom') {
            stripW = s.w; stripH = miterPx; stripX = s.x;
            stripY = key === 'top' ? s.y - miterPx - INCH/2 : s.y + s.h + INCH/2;
        } else if (key === 'left' || key === 'right') {
            stripW = miterPx; stripH = s.h; stripY = s.y;
            stripX = key === 'left' ? s.x - miterPx - INCH/2 : s.x + s.w + INCH/2;
        } else { stripW = s.w; stripH = miterPx; stripX = s.x; stripY = s.y + s.h + INCH; }
        stripX = clamp(stripX, 0, CW - stripW); stripY = clamp(stripY, 0, CH - stripH);
        shapes.push(normalizeShape({ id: nextId, label: 'Miter Strip', x: stripX, y: stripY, w: stripW, h: stripH, miterStrip: true }));
        nextId++;
    }
    persist(); hideAllPopups(); setTool('select'); render();
}
document.getElementById('edge-ok').addEventListener('click', confirmEdgePopup);
document.getElementById('edge-cancel').addEventListener('click', () => hideAllPopups());
edgeTypeSel.addEventListener('change', () => {
    const isMiter = edgeTypeSel.value === 'mitered';
    document.getElementById('miter-width-row').style.display = isMiter ? 'flex' : 'none';
    if (isMiter) { document.getElementById('miter-width-val').value = ''; document.getElementById('miter-width-val').focus(); }
});
document.getElementById('miter-width-val').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmEdgePopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
    e.stopPropagation();
});
edgeTypeSel.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmEdgePopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
    e.stopPropagation();
});

// ── Edge palette ──────────────────────────────────────────────────────────────
document.querySelectorAll('.ep-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        activeEdgeType = btn.dataset.etype;
        document.querySelectorAll('.ep-btn').forEach(b => b.classList.toggle('ep-active', b === btn));
    });
});

// ── Split Edge tool ───────────────────────────────────────────
// (splitEdgePending, edgeSegments, edgeTotalIn removed — split is now click-based)

// (Split edge popup code removed — split is now click-based via the Split Edge tool)

// ── Backsplash popup ──────────────────────────────────────────
let editingBspId = null;
let pendingBspPlace = null;

const bspDiagram = document.getElementById('bsp-diagram');
const bspDiagCtx = bspDiagram.getContext('2d');

function drawBspDiagram() {
    const dc = bspDiagCtx, dw = bspDiagram.width, dh = bspDiagram.height;
    dc.clearRect(0,0,dw,dh);
    const W  = parseInchInput(document.getElementById('bsp-W').value)||100;
    const Hb = parseInchInput(document.getElementById('bsp-Hb').value)||20;
    const Hp = parseInchInput(document.getElementById('bsp-Hp').value)||20;
    const Wp = parseInchInput(document.getElementById('bsp-Wp').value)||20;
    const Xl = parseInchInput(document.getElementById('bsp-Xl').value)||25;
    const H  = Hb + Hp;
    const pad = 28;
    const sc  = Math.min((dw-pad*2)/W, (dh-pad*2)/H);
    const ox  = (dw - W*sc)/2, oy = (dh - H*sc)/2;
    const fs  = { x:ox, y:oy, w:W*sc, h:H*sc, pW:Wp*sc, pH:Hp*sc, pX:Xl*sc };
    const pts = bspPolygon(fs);
    dc.save();
    dc.beginPath(); dc.moveTo(pts[0][0],pts[0][1]);
    for (let i=1;i<pts.length;i++) dc.lineTo(pts[i][0],pts[i][1]);
    dc.closePath();
    dc.fillStyle='rgba(200,192,176,0.12)'; dc.fill();
    dc.strokeStyle='#b09030'; dc.lineWidth=1.5; dc.stroke();
    // Labels: A=W, B=Hb, C=Hp, D=Wp, E=Xl
    const dimLabels = [
        { lbl:'D', i:0, j:1 }, { lbl:'C', i:1, j:2 },
        { lbl:'',  i:2, j:3 }, { lbl:'B', i:3, j:4 },
        { lbl:'A', i:4, j:5 }, { lbl:'B', i:5, j:6 },
        { lbl:'E', i:6, j:7 }, { lbl:'C', i:7, j:0 },
    ];
    for (const dl of dimLabels) {
        if (!dl.lbl) continue;
        const mx=(pts[dl.i][0]+pts[dl.j][0])/2, my=(pts[dl.i][1]+pts[dl.j][1])/2;
        const dx=pts[dl.j][0]-pts[dl.i][0], dy=pts[dl.j][1]-pts[dl.i][1], len=Math.hypot(dx,dy);
        if (len < 8) continue;
        const nx=dy/len, ny=-dx/len;
        const lx=mx+nx*14, ly=my+ny*14;
        dc.font='bold 9px Raleway,sans-serif'; dc.textAlign='center'; dc.textBaseline='middle';
        dc.fillStyle='#b09030'; dc.fillText(dl.lbl, lx, ly);
    }
    dc.restore();
}
['bsp-W','bsp-Hb','bsp-Hp','bsp-Wp','bsp-Xl'].forEach(id =>
    document.getElementById(id).addEventListener('input', drawBspDiagram));

function showBspPopup(defW, defHb, defHp, defWp, defXl, editId) {
    hideAllPopups();
    editingBspId = editId;
    document.getElementById('bsp-W').value  = fmtInchesNoMark(parseFloat(defW));
    document.getElementById('bsp-Hb').value = fmtInchesNoMark(parseFloat(defHb));
    document.getElementById('bsp-Hp').value = fmtInchesNoMark(parseFloat(defHp));
    document.getElementById('bsp-Wp').value = fmtInchesNoMark(parseFloat(defWp));
    document.getElementById('bsp-Xl').value = fmtInchesNoMark(parseFloat(defXl));
    document.getElementById('bsp-title').textContent = editId !== null ? 'Edit Backsplash' : 'Backsplash Dimensions';
    document.getElementById('bsp-ok').textContent    = editId !== null ? 'Save' : 'Add Piece';
    currentPopup = 'bsp';
    const cvRect = cv.getBoundingClientRect();
    showPopupAt(document.getElementById('bsp-popup'), cvRect.left + cvRect.width/2 - 145, cvRect.top + 30);
    document.getElementById('bsp-W').focus();
    drawBspDiagram();
}
function confirmBspPopup() {
    const W  = parseInchInput(document.getElementById('bsp-W').value);
    const Hb = parseInchInput(document.getElementById('bsp-Hb').value);
    const Hp = parseInchInput(document.getElementById('bsp-Hp').value);
    const Wp = parseInchInput(document.getElementById('bsp-Wp').value);
    const Xl = parseInchInput(document.getElementById('bsp-Xl').value);
    if (!W||!Hb||!Hp||!Wp||Xl<0||Wp+Xl>W) return;
    const wPx=(W*INCH), hPx=((Hb+Hp)*INCH);
    const pWpx=(Wp*INCH), pHpx=(Hp*INCH), pXpx=(Xl*INCH);
    pushUndo();
    if (editingBspId !== null) {
        const s = byId(editingBspId);
        if (s) { s.w=wPx; s.h=hPx; s.pW=pWpx; s.pH=pHpx; s.pX=pXpx; persist(); }
    } else {
        const cp = centeredPos(wPx, hPx);
        shapes.push(normalizeShape({ id:nextId, label:`P${nextId}`, x:cp.x, y:cp.y, w:wPx, h:hPx,
            shapeType:'bsp', pW:pWpx, pH:pHpx, pX:pXpx }));
        nextId++; persist();
    }
    hideAllPopups(); setTool('select'); render(); updateStatus();
}
document.getElementById('bsp-ok').addEventListener('click', confirmBspPopup);
document.getElementById('bsp-cancel').addEventListener('click', () => { hideAllPopups(); render(); });
['bsp-W','bsp-Hb','bsp-Hp','bsp-Wp','bsp-Xl'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
        if (e.key==='Enter')  { e.preventDefault(); confirmBspPopup(); }
        if (e.key==='Escape') { e.preventDefault(); hideAllPopups(); render(); }
        e.stopPropagation();
    });
});

// ── Joint popup ──────────────────────────────────────────────
function _setJointBtnActive(orientation) {
    jointOrientation = orientation;
    for (const ax of ['v', 'h', 'd']) {
        const b = document.getElementById('joint-btn-' + ax);
        if (b) b.classList.toggle('active', ax === orientation);
    }
}
document.getElementById('joint-btn-v').addEventListener('click', () => _setJointBtnActive('v'));
document.getElementById('joint-btn-h').addEventListener('click', () => _setJointBtnActive('h'));
document.getElementById('joint-btn-d').addEventListener('click', () => {
    if (document.getElementById('joint-btn-d').disabled) return;
    _setJointBtnActive('d');
});

// Returns the polygon vertex that lies along the corner's inward bisector
// from the snap corner — i.e., the natural "miter direction" pointing into
// the polygon material, away from the cut-out region. For a CW polygon in
// screen coords, the inward bisector is the sum of each adjacent edge's
// right-normal (rotate CW 90°). The chosen vertex maximizes the dot product
// of (vertex - snap)/|...| with that bisector direction.
function findClosestDiagonalVertex(s, snapCorner) {
    const poly = (s.shapeType === 'l') ? lShapePolygon(s)
              : (s.shapeType === 'u') ? uShapePolygon(s)
              : (s.shapeType === 'bsp') ? bspPolygon(s)
              : [[s.x, s.y], [s.x+s.w, s.y], [s.x+s.w, s.y+s.h], [s.x, s.y+s.h]];
    const eps = 0.5;
    // Locate the snap corner in the polygon
    let snapIdx = -1;
    for (let i = 0; i < poly.length; i++) {
        if (Math.abs(poly[i][0] - snapCorner.x) < eps && Math.abs(poly[i][1] - snapCorner.y) < eps) {
            snapIdx = i; break;
        }
    }
    if (snapIdx < 0) return null;
    const n = poly.length;
    const prev = poly[(snapIdx - 1 + n) % n];
    const cur  = poly[snapIdx];
    const next = poly[(snapIdx + 1) % n];
    const ix = cur[0] - prev[0], iy = cur[1] - prev[1];
    const ox = next[0] - cur[0], oy = next[1] - cur[1];
    const iLen = Math.hypot(ix, iy) || 1;
    const oLen = Math.hypot(ox, oy) || 1;
    // Right-normal of each edge in screen-CW (interior side of a CW polygon).
    const inN  = [-iy / iLen,  ix / iLen];
    const outN = [-oy / oLen,  ox / oLen];
    let bx = inN[0] + outN[0];
    let by = inN[1] + outN[1];
    const bLen = Math.hypot(bx, by);
    if (bLen < 1e-6) return null; // 180° corner — no defined inward direction
    bx /= bLen; by /= bLen;
    // Pick the non-aligned vertex whose direction from snap is most parallel
    // to the inward bisector (highest dot product, capped at 1).
    let best = null, bestDot = -2;
    for (const [px, py] of poly) {
        if (Math.abs(px - snapCorner.x) < eps && Math.abs(py - snapCorner.y) < eps) continue;
        if (Math.abs(px - snapCorner.x) < eps || Math.abs(py - snapCorner.y) < eps) continue;
        const dx = px - snapCorner.x, dy = py - snapCorner.y;
        const dLen = Math.hypot(dx, dy);
        if (dLen < eps) continue;
        const dot = (dx / dLen) * bx + (dy / dLen) * by;
        if (dot > bestDot) { bestDot = dot; best = [px, py]; }
    }
    return best ? { x: best[0], y: best[1] } : null;
}

function showJointPopup(shape, pos, cvX, cvY, isCornerSnap = false) {
    hideAllPopups();
    pendingJointShape = shape;
    pendingJointPos = pos;
    _setJointBtnActive('v');
    const titleEl = document.getElementById('joint-popup-title');
    const hintEl  = document.getElementById('joint-popup-hint');
    const btnV    = document.getElementById('joint-btn-v');
    const btnH    = document.getElementById('joint-btn-h');
    const btnD    = document.getElementById('joint-btn-d');
    const okBtn   = document.getElementById('joint-ok');
    // Diagonal option — only enabled for snapped corners with a valid diagonal target.
    let diagOK = false;
    if (isCornerSnap) {
        const corners = getInsideCornersForJoint(shape);
        let bestC = null, bestD = 40;
        for (const c of corners) {
            const d = Math.hypot(pos.px - c.x, pos.py - c.y);
            if (d < bestD) { bestD = d; bestC = c; }
        }
        if (bestC && findClosestDiagonalVertex(shape, bestC)) diagOK = true;
    }
    if (btnD) {
        btnD.disabled = !diagOK;
        btnD.style.opacity = diagOK ? '1' : '0.45';
    }
    if (isCornerSnap) {
        if (titleEl) titleEl.textContent = 'Split at Corner';
        if (hintEl)  hintEl.textContent  = 'Extend a wall from this inside corner — creates clean pieces.';
        if (btnV)    btnV.textContent    = '↕ Continue vertical wall';
        if (btnH)    btnH.textContent    = '↔ Continue horizontal wall';
        if (btnD)    btnD.textContent    = '⤢ Diagonal across';
        if (okBtn)   okBtn.textContent   = 'Split';
    } else {
        if (titleEl) titleEl.textContent = 'Add Joint Line';
        if (hintEl)  hintEl.textContent  = 'Place a custom joint line. Drag to reposition after.';
        if (btnV)    btnV.textContent    = '↕ Vertical';
        if (btnH)    btnH.textContent    = '↔ Horizontal';
        if (btnD)    btnD.textContent    = '⤢ Diagonal';
        if (okBtn)   okBtn.textContent   = 'Add Joint';
    }
    currentPopup = 'joint';
    const sp = screenPos(cvX, cvY);
    showPopupAt(document.getElementById('joint-popup'), sp.x + 20, sp.y - 20);
}
function confirmJointPopup() {
    if (!pendingJointShape || !pendingJointPos) return;
    const s = pendingJointShape, pos = pendingJointPos;
    // Snap to nearest inside corner on placement. Use EUCLIDEAN distance so
    // corners that tie on the axis-perpendicular coord (e.g. both U-shape
    // inside corners at the same y for a horizontal joint) disambiguate by
    // cursor position. Without this, whichever corner came first in the
    // corner list always won regardless of where the user clicked.
    const SNAP_THRESH = 40;
    let snapCorner = null;
    {
        const corners = getInsideCornersForJoint(s);
        let best = SNAP_THRESH;
        for (const c of corners) {
            const d = Math.hypot(pos.px - c.x, pos.py - c.y);
            if (d < best) { best = d; snapCorner = c; }
        }
    }
    pushUndo();
    if (!s.joints) s.joints = [];
    if (jointOrientation === 'd') {
        // Diagonal joint: requires a snap corner. Endpoint is the closest
        // non-aligned polygon vertex.
        if (!snapCorner) { hideAllPopups(); return; }
        const other = findClosestDiagonalVertex(s, snapCorner);
        if (!other) { alert('No diagonal target available from this corner.'); return; }
        s.joints.push({
            id: Date.now(),
            axis: 'd',
            pos: 0,
            snap:      { relX: snapCorner.x - s.x, relY: snapCorner.y - s.y },
            otherSnap: { relX: other.x - s.x,      relY: other.y - s.y      }
        });
    } else {
        let jpos;
        if (snapCorner) {
            jpos = jointOrientation === 'v' ? (snapCorner.x - s.x) : (snapCorner.y - s.y);
            jpos = clamp(jpos, INCH*2, jointOrientation === 'v' ? s.w - INCH*2 : s.h - INCH*2);
        } else if (jointOrientation === 'v') {
            jpos = clamp(snap(pos.px - s.x), INCH*2, s.w - INCH*2);
        } else {
            jpos = clamp(snap(pos.py - s.y), INCH*2, s.h - INCH*2);
        }
        const newJoint = { id: Date.now(), axis: jointOrientation, pos: jpos };
        if (snapCorner) newJoint.snap = { relX: snapCorner.x - s.x, relY: snapCorner.y - s.y };
        s.joints.push(newJoint);
    }
    persist(); hideAllPopups(); setTool('select'); render();
}
document.getElementById('joint-ok').addEventListener('click', confirmJointPopup);
document.getElementById('joint-cancel').addEventListener('click', () => hideAllPopups());

// ── Check (notch) popup ──────────────────────────────────────
// A "check" is a rectangular notch cut out of a CORNER of a rect piece, used
// to accommodate wall obstructions, columns, posts, etc. Stored on the shape
// as s.checks = [{ id, cornerKey, w, d }] where w/d are in pixels and
// cornerKey is 'nw'/'ne'/'se'/'sw'. w runs along the corner's horizontal
// edge (top/bottom), d runs along the corner's vertical edge (left/right).
let pendingCheckShape  = null;
let pendingCheckCorner = null;
let pendingCheckVertex = null;
function showCheckPopup(cvX, cvY) {
    hideAllPopups();
    currentPopup = 'check';
    const sp = screenPos(cvX, cvY);
    showPopupAt(document.getElementById('check-popup'), sp.x + 20, sp.y - 20);
    const widthInp = document.getElementById('check-width');
    setTimeout(() => { widthInp.focus(); widthInp.select(); }, 50);
}
function confirmCheckPopup() {
    if (!pendingCheckShape || (!pendingCheckCorner && pendingCheckVertex == null)) { hideAllPopups(); return; }
    const widthIn = Math.max(0.25, parseInchInput(document.getElementById('check-width').value) || 4);
    const depthIn = Math.max(0.25, parseInchInput(document.getElementById('check-depth').value) || 4);
    const s = pendingCheckShape;
    const wPx = widthIn * INCH, dPx = depthIn * INCH;

    // For rect, W is along horizontal edge (compared to s.w) and D is vertical (s.h).
    // For L/U, W/D are along the two adjacent polygon edges at the chosen vertex.
    const st = s.shapeType || 'rect';
    if (st === 'rect') {
        if (wPx >= s.w - 0.5) { alert(`Width ${widthIn}" is as wide as the piece (${(s.w/INCH).toFixed(2)}"). Reduce width.`); return; }
        if (dPx >= s.h - 0.5) { alert(`Depth ${depthIn}" is as tall as the piece (${(s.h/INCH).toFixed(2)}"). Reduce depth.`); return; }
    } else if (st === 'l' || st === 'u') {
        const poly = st === 'l' ? lShapePolygon(s) : uShapePolygon(s);
        const n = poly.length;
        const i = pendingCheckVertex;
        const P = poly[(i - 1 + n) % n];
        const V = poly[i];
        const N = poly[(i + 1) % n];
        const inLen = Math.hypot(V[0]-P[0], V[1]-P[1]);
        const outLen = Math.hypot(N[0]-V[0], N[1]-V[1]);
        if (wPx >= inLen - 0.5)  { alert(`Width ${widthIn}" is too large for this edge (${(inLen/INCH).toFixed(2)}"). Reduce width.`); return; }
        if (dPx >= outLen - 0.5) { alert(`Depth ${depthIn}" is too large for the adjacent edge (${(outLen/INCH).toFixed(2)}"). Reduce depth.`); return; }
    }

    if (!s.checks) s.checks = [];
    pushUndo();
    if (st === 'rect') {
        s.checks = s.checks.filter(c => c.cornerKey !== pendingCheckCorner);
        s.checks.push({ id: Date.now(), cornerKey: pendingCheckCorner, w: wPx, d: dPx });
    } else {
        s.checks = s.checks.filter(c => c.vertexIdx !== pendingCheckVertex);
        s.checks.push({ id: Date.now(), vertexIdx: pendingCheckVertex, w: wPx, d: dPx });
    }
    pendingCheckShape = null; pendingCheckCorner = null; pendingCheckVertex = null; pendingCheckVertex = null;
    persist(); hideAllPopups(); setTool('select'); render();
}
document.getElementById('check-ok').addEventListener('click', confirmCheckPopup);
document.getElementById('check-cancel').addEventListener('click', () => {
    pendingCheckShape = null; pendingCheckCorner = null; pendingCheckVertex = null;
    hideAllPopups();
});
document.getElementById('check-width').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmCheckPopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
    e.stopPropagation();
});
document.getElementById('check-depth').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmCheckPopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
    e.stopPropagation();
});

// Sum of all check (notch) areas on a shape, in pixels². Subtracted from the
// shape's gross area for sqft calculations and cutting cost.
function totalCheckAreaPx(s) {
    if (!s.checks || !s.checks.length) return 0;
    return s.checks.reduce((a, c) => a + c.w * c.d, 0);
}

// Returns absolute canvas rect {x, y, w, h} for a check on a rect shape.
function checkRectAbs(s, c) {
    if (c.cornerKey === 'nw') return { x: s.x,              y: s.y,              w: c.w, h: c.d };
    if (c.cornerKey === 'ne') return { x: s.x + s.w - c.w,  y: s.y,              w: c.w, h: c.d };
    if (c.cornerKey === 'se') return { x: s.x + s.w - c.w,  y: s.y + s.h - c.d,  w: c.w, h: c.d };
    if (c.cornerKey === 'sw') return { x: s.x,              y: s.y + s.h - c.d,  w: c.w, h: c.d };
    return null;
}

// ── L-Shape popup ────────────────────────────────────────────
let lshapeCorner    = 'ne';
let editingLShapeId = null;

// Configuration for each corner orientation.
// Letters A-F label the 6 sides clockwise from the polygon's first point.
// "computed" = the 2 inner-notch letters derived from the 4 outer measurements.
// "compute"  = function returning {computed letter: value} from all 6 values
// "fromWH"   = converts internal {W,H,nW,nH} → {A,B,C,D,E,F}
// "toWH"     = converts {A…F} → internal {W,H,nW,nH}
//
// NE: A=top, B=inner-vert(auto), C=inner-horiz(auto), D=right-partial, E=full-width, F=full-height
// NW: A=top-partial, B=full-right, C=full-width, D=left-partial, E=inner-horiz(auto), F=inner-vert(auto)
// SE: A=full-top, B=right-partial, C=inner-horiz(auto), D=inner-vert(auto), E=bottom-partial, F=full-left
// SW: A=full-top, B=full-right, C=bottom-partial, D=inner-vert(auto), E=inner-horiz(auto), F=left-partial
const L_CONF = {
    ne: { computed:['B','C'],
          compute:(v)=>({ B: v.F - v.D, C: v.E - v.A }),
          fromWH:(W,H,nW,nH)=>({A:W-nW, B:nH,  C:nW,  D:H-nH, E:W,  F:H }),
          toWH:(v)=>({W:v.E, H:v.F, nW:v.C, nH:v.B}) },
    nw: { computed:['E','F'],
          compute:(v)=>({ E: v.C - v.A, F: v.B - v.D }),
          fromWH:(W,H,nW,nH)=>({A:W-nW, B:H,   C:W,   D:H-nH, E:nW, F:nH}),
          toWH:(v)=>({W:v.C, H:v.B, nW:v.E, nH:v.F}) },
    se: { computed:['C','D'],
          compute:(v)=>({ C: v.A - v.E, D: v.F - v.B }),
          fromWH:(W,H,nW,nH)=>({A:W,   B:H-nH, C:nW,  D:nH,   E:W-nW, F:H }),
          toWH:(v)=>({W:v.A, H:v.F, nW:v.C, nH:v.D}) },
    sw: { computed:['D','E'],
          compute:(v)=>({ D: v.B - v.F, E: v.A - v.C }),
          fromWH:(W,H,nW,nH)=>({A:W,   B:H,    C:W-nW, D:nH,   E:nW, F:H-nH}),
          toWH:(v)=>({W:v.A, H:v.B, nW:v.E, nH:v.D}) },
};

const lsDiagram = document.getElementById('lshape-diagram');
const lsDiagCtx = lsDiagram.getContext('2d');

function getLsValues() {
    const r = {};
    for (const k of ['A','B','C','D','E','F']) r[k] = parseInchInput(document.getElementById(`ls-${k}`).value) || 0;
    return r;
}
function getLsWH() { return L_CONF[lshapeCorner].toWH(getLsValues()); }

function setLsFromWH(W, H, nW, nH) {
    const vals = L_CONF[lshapeCorner].fromWH(W, H, nW, nH);
    for (const k of ['A','B','C','D','E','F'])
        document.getElementById(`ls-${k}`).value = fmtInchesNoMark(vals[k] || 0);
}

function updateComputed() {
    const conf = L_CONF[lshapeCorner], v = getLsValues();
    const computed = conf.compute(v);
    for (const [k, val] of Object.entries(computed)) {
        document.getElementById(`ls-${k}`).value = val > 0 ? parseFloat(val.toFixed(2)) : '';
    }
    drawLShapeDiagram();
}

function updateComputedStyles() {
    const comp = L_CONF[lshapeCorner].computed;
    for (const k of ['A','B','C','D','E','F']) {
        const isAuto = comp.includes(k);
        document.getElementById(`ls-${k}`).classList.toggle('auto', isAuto);
        document.getElementById(`ls-${k}`).readOnly = isAuto;
        document.getElementById(`lbl-${k}`).classList.toggle('auto', isAuto);
    }
}

function setLShapeCorner(nc) {
    const wh = getLsWH(); // save current dims before switching
    lshapeCorner = nc;
    ['ne','nw','se','sw'].forEach(k =>
        document.getElementById(`lshape-${k}`).classList.toggle('active', k === nc));
    if (wh.W > 0 && wh.H > 0 && wh.nW > 0 && wh.nH > 0)
        setLsFromWH(wh.W, wh.H, wh.nW, wh.nH);
    updateComputedStyles();
    drawLShapeDiagram();
}
['ne','nw','se','sw'].forEach(k =>
    document.getElementById(`lshape-${k}`).addEventListener('click', () => setLShapeCorner(k)));

function drawLShapeDiagram() {
    const dc = lsDiagCtx, dw = lsDiagram.width, dh = lsDiagram.height;
    dc.clearRect(0, 0, dw, dh);
    const {W, H, nW, nH} = getLsWH();
    if (!W || !H || !nW || !nH) return;
    const pad = 26;
    const sc = Math.min((dw - pad*2) / W, (dh - pad*2) / H);
    const ox = (dw - W*sc) / 2, oy = (dh - H*sc) / 2;
    const ds = { x:ox, y:oy, w:W*sc, h:H*sc, notchW:nW*sc, notchH:nH*sc, notchCorner:lshapeCorner };
    const pts = lShapePolygon(ds);
    const comp = L_CONF[lshapeCorner].computed;
    // Fill + outline
    dc.save();
    dc.beginPath(); dc.moveTo(pts[0][0], pts[0][1]);
    for (let i=1; i<pts.length; i++) dc.lineTo(pts[i][0], pts[i][1]);
    dc.closePath();
    dc.fillStyle = 'rgba(200,192,176,0.12)'; dc.fill();
    dc.strokeStyle = '#b09030'; dc.lineWidth = 1.5; dc.stroke();
    dc.restore();
    // Side labels A-F at midpoint of each segment, offset outward
    const letters = ['A','B','C','D','E','F'];
    for (let i=0; i<6; i++) {
        const j = (i+1)%6;
        const mx=(pts[i][0]+pts[j][0])/2, my=(pts[i][1]+pts[j][1])/2;
        const dx=pts[j][0]-pts[i][0], dy=pts[j][1]-pts[i][1], len=Math.hypot(dx,dy)||1;
        // Outward normal (right of CW direction)
        const nx=dy/len, ny=-dx/len;
        const LOFF = 13;
        const lx=mx+nx*LOFF, ly=my+ny*LOFF;
        const letter = letters[i];
        const isComp = comp.includes(letter);
        dc.save();
        dc.font = `bold 10px Raleway,sans-serif`;
        dc.textAlign = 'center'; dc.textBaseline = 'middle';
        // Small circle background
        dc.beginPath(); dc.arc(lx, ly, 7, 0, Math.PI*2);
        dc.fillStyle = isComp ? '#1c1c1c' : '#2d3a10';
        dc.fill();
        dc.strokeStyle = isComp ? '#555555' : '#b09030'; dc.lineWidth = 1;
        dc.stroke();
        dc.fillStyle = isComp ? '#555555' : '#b09030';
        dc.fillText(letter, lx, ly);
        dc.restore();
    }
}

// Wire primary inputs to update computed fields
['A','B','C','D','E','F'].forEach(k => {
    document.getElementById(`ls-${k}`).addEventListener('input', () => {
        if (!document.getElementById(`ls-${k}`).readOnly) updateComputed();
    });
});

function showLShapePopup(defW, defH, defNW, defNH, editId) {
    hideAllPopups();
    editingLShapeId = editId;
    document.getElementById('lshape-title').textContent = editId !== null ? 'Edit L-Shape' : 'L-Shape Dimensions';
    document.getElementById('lshape-ok').textContent    = editId !== null ? 'Save' : 'Add Piece';
    setLsFromWH(defW, defH, defNW, defNH);
    updateComputedStyles();
    currentPopup = 'lshape';
    const cvRect = cv.getBoundingClientRect();
    showPopupAt(document.getElementById('lshape-popup'), cvRect.left + cvRect.width/2 - 145, cvRect.top + 30);
    // Focus first primary input
    const first = ['A','B','C','D','E','F'].find(k => !L_CONF[lshapeCorner].computed.includes(k));
    const firstEl = document.getElementById(`ls-${first}`);
    firstEl.focus(); firstEl.select();
    drawLShapeDiagram();
}
function confirmLShapePopup() {
    const {W, H, nW, nH} = getLsWH();
    if (!W||!H||!nW||!nH||nW>=W||nH>=H) return;
    const wPx=(W*INCH), hPx=(H*INCH);
    const nWpx=(nW*INCH), nHpx=(nH*INCH);
    pushUndo();
    if (editingLShapeId !== null) {
        const s = byId(editingLShapeId);
        if (s) { s.w=clamp(wPx,INCH,CW-s.x); s.h=clamp(hPx,INCH,CH-s.y); s.notchW=nWpx; s.notchH=nHpx; s.notchCorner=lshapeCorner; persist(); }
    } else {
        const cp = centeredPos(wPx, hPx);
        shapes.push(normalizeShape({ id:nextId, label:`P${nextId}`, x:cp.x, y:cp.y, w:wPx, h:hPx,
            shapeType:'l', notchW:nWpx, notchH:nHpx, notchCorner:lshapeCorner }));
        nextId++; persist();
    }
    hideAllPopups(); setTool('select'); render(); updateStatus();
}
document.getElementById('lshape-ok').addEventListener('click', confirmLShapePopup);
document.getElementById('lshape-cancel').addEventListener('click', () => { hideAllPopups(); render(); });
['A','B','C','D','E','F'].forEach(k => {
    document.getElementById(`ls-${k}`).addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmLShapePopup(); }
        if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); render(); }
        e.stopPropagation();
    });
});

// ── U-Shape popup ────────────────────────────────────────────
let uShapeOpening   = 'top';
let editingUShapeId = null;

const usDiagram = document.getElementById('ushape-diagram');
const usDiagCtx = usDiagram.getContext('2d');

// (U-shape orientation toggle removed — single 'top' direction in popup, rotate via R)

function drawUShapeDiagram() {
    const dc = usDiagCtx, dw = usDiagram.width, dh = usDiagram.height;
    dc.clearRect(0, 0, dw, dh);
    const A  = parseInchInput(document.getElementById('us-A').value) || 0;
    const lH = parseInchInput(document.getElementById('us-B').value) || 0;
    const lW = parseInchInput(document.getElementById('us-C').value) || 0;
    const fH = parseInchInput(document.getElementById('us-D').value) || 0;
    const rW = parseInchInput(document.getElementById('us-E').value) || 0;
    const rH = parseInchInput(document.getElementById('us-F').value) || 0;
    if (!A || !lH || !rH || !lW || !rW || !fH) return;
    const H = Math.max(lH, rH);
    const pad = 26;
    const sc = Math.min((dw - pad*2) / A, (dh - pad*2) / H);
    const ox = (dw - A*sc) / 2, oy = (dh - H*sc) / 2;
    const ds = {
        x:ox, y:oy, w:A*sc, h:H*sc,
        leftH:lH*sc, rightH:rH*sc,
        leftW:lW*sc, rightW:rW*sc,
        floorH:fH*sc,
        uOpening:'top'
    };
    const pts = uShapePolygon(ds);
    dc.save();
    dc.beginPath(); dc.moveTo(pts[0][0], pts[0][1]);
    for (let i=1; i<pts.length; i++) dc.lineTo(pts[i][0], pts[i][1]);
    dc.closePath();
    dc.fillStyle = 'rgba(200,192,176,0.12)'; dc.fill();
    dc.strokeStyle = '#b09030'; dc.lineWidth = 1.5; dc.stroke();
    dc.restore();
    // 0→1=B(left outer), 1→2=C(left arm top), 2→3=(skip vertical interior),
    // 3→4=D(channel floor / bottom strip top), 4→5=(skip vertical interior),
    // 5→6=E(right arm top), 6→7=F(right outer), 7→0=A(bottom)
    const dimLabels = [
        { lbl:'B', i:0, j:1 }, { lbl:'C', i:1, j:2 },
        { lbl:'D', i:3, j:4 }, { lbl:'E', i:5, j:6 },
        { lbl:'F', i:6, j:7 }, { lbl:'A', i:7, j:0 }
    ];
    for (const dl of dimLabels) {
        const mx=(pts[dl.i][0]+pts[dl.j][0])/2, my=(pts[dl.i][1]+pts[dl.j][1])/2;
        const ddx=pts[dl.j][0]-pts[dl.i][0], ddy=pts[dl.j][1]-pts[dl.i][1], len=Math.hypot(ddx,ddy)||1;
        const nx=ddy/len, ny=-ddx/len;
        // For channel floor (D), label inside the U opening (above the floor)
        const lblOffset = dl.lbl === 'D' ? -11 : 11;
        const lx=mx+nx*lblOffset, ly=my+ny*lblOffset;
        dc.save(); dc.font='bold 9px Raleway,sans-serif'; dc.textAlign='center'; dc.textBaseline='middle';
        dc.fillStyle='#b09030'; dc.fillText(dl.lbl, lx, ly); dc.restore();
    }
}

['us-A','us-B','us-C','us-D','us-E','us-F'].forEach(id => {
    document.getElementById(id).addEventListener('input', drawUShapeDiagram);
});

function showUShapePopup(defA, defB, defC, defD, defE, defF, editId) {
    hideAllPopups();
    editingUShapeId = editId;
    document.getElementById('ushape-title').textContent = editId !== null ? 'Edit U-Shape' : 'U-Shape Dimensions';
    document.getElementById('ushape-ok').textContent    = editId !== null ? 'Save' : 'Add Piece';
    document.getElementById('us-A').value = defA;
    document.getElementById('us-B').value = defB;
    document.getElementById('us-C').value = defC;
    document.getElementById('us-D').value = defD;
    document.getElementById('us-E').value = defE;
    document.getElementById('us-F').value = defF;
    currentPopup = 'ushape';
    const cvRect = cv.getBoundingClientRect();
    showPopupAt(document.getElementById('ushape-popup'), cvRect.left + cvRect.width/2 - 150, cvRect.top + 30);
    const firstEl = document.getElementById('us-A');
    firstEl.focus(); firstEl.select();
    drawUShapeDiagram();
}

function confirmUShapePopup() {
    const A  = parseInchInput(document.getElementById('us-A').value) || 0;
    const lH = parseInchInput(document.getElementById('us-B').value) || 0;
    const lW = parseInchInput(document.getElementById('us-C').value) || 0;
    const fH = parseInchInput(document.getElementById('us-D').value) || 0;
    const rW = parseInchInput(document.getElementById('us-E').value) || 0;
    const rH = parseInchInput(document.getElementById('us-F').value) || 0;
    if (!A || !lH || !rH || !lW || !rW || !fH) return;
    if (lW + rW >= A) return;
    // Bottom strip must be shorter than each arm so the arms extend above it
    if (fH >= lH || fH >= rH) return;
    const H = Math.max(lH, rH);
    const wPx = (A*INCH), hPx = (H*INCH);
    const lWpx = (lW*INCH), rWpx = (rW*INCH);
    const fHpx = (fH*INCH);
    const lHpx = (lH*INCH), rHpx = (rH*INCH);
    pushUndo();
    if (editingUShapeId !== null) {
        const s = byId(editingUShapeId);
        if (s) {
            s.w = clamp(wPx, INCH, CW - s.x);
            s.h = clamp(hPx, INCH, CH - s.y);
            s.leftW = lWpx; s.rightW = rWpx;
            s.floorH = fHpx;
            s.leftH = lHpx; s.rightH = rHpx;
            s.uOpening = 'top';
            delete s.channelH; delete s.leftCH; delete s.rightCH;
            persist();
        }
    } else {
        const cp = centeredPos(wPx, hPx);
        shapes.push(normalizeShape({
            id: nextId, label: `P${nextId}`, x: cp.x, y: cp.y, w: wPx, h: hPx,
            shapeType: 'u',
            leftW: lWpx, rightW: rWpx,
            floorH: fHpx,
            leftH: lHpx, rightH: rHpx,
            uOpening: 'top'
        }));
        nextId++; persist();
    }
    hideAllPopups(); setTool('select'); render(); updateStatus();
}

document.getElementById('ushape-ok').addEventListener('click', confirmUShapePopup);
document.getElementById('ushape-cancel').addEventListener('click', () => { hideAllPopups(); render(); });
['us-A','us-B','us-C','us-D','us-E','us-F'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmUShapePopup(); }
        if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); render(); }
        e.stopPropagation();
    });
});

// ─────────────────────────────────────────────────────────────
//  Mouse handlers
// ─────────────────────────────────────────────────────────────
cv.addEventListener('mousedown', e => {
    if (currentPopup) return;
    const p  = mousePos(e);
    const sx = snap(p.x), sy = snap(p.y);

    // ── Draw ──
    if (tool === 'draw' || tool === 'ldraw' || tool === 'udraw') {
        drawing = true; dStart = { x:sx, y:sy }; dCur = { x:sx, y:sy }; return;
    }

    // ── Polish Under: drag a rectangle inside an existing shape ──
    if (tool === 'polishUnder') {
        const hit = hitShape(p.x, p.y);
        if (!hit || hit.subtype) {
            alert('Click and drag inside a countertop piece to mark a polish-under area.');
            return;
        }
        drawingPU = true;
        puParent  = hit;
        puStart   = { x: p.x - hit.x, y: p.y - hit.y };
        puCur     = { x: p.x - hit.x, y: p.y - hit.y };
        selectedPU = null;
        return;
    }

    // ── Sink ──
    if (tool === 'sink') {
        const hit = hitShape(p.x, p.y);
        if (!hit || hit.subtype) { alert('Click on a countertop piece to place the sink.'); return; }
        pendingItemParent = hit.id;
        showSinkPopup(p.x, p.y);
        return;
    }

    // ── Farmhouse Sink — click a horizontal edge to set center ──
    if (tool === 'farmsink') {
        const eh = nearestEdge(p.x, p.y);
        if (!eh || eh.s.subtype) {
            alert('Farmhouse sink can only be placed on a horizontal edge of a rectangle, L-shape, or U-shape.');
            return;
        }
        const fsWpx = FS_WIDTH_IN * INCH;
        const fsDpx = FS_DEPTH_IN * INCH;
        if (eh.s.farmSink) {
            alert('This piece already has a farmhouse sink. Delete the existing one first.');
            return;
        }
        if (eh.s.shapeType === 'rect') {
            if (eh.key !== 'top' && eh.key !== 'bottom') {
                alert('Farmhouse sink must be placed on the TOP or BOTTOM edge of a rectangle.');
                return;
            }
            if (eh.s.w < fsWpx + 1) {
                alert(`Edge is too short. Need at least ${FS_WIDTH_IN}" of width.`);
                return;
            }
            if (eh.s.h < fsDpx + 1) {
                alert(`Piece is too shallow. Need at least ${FS_DEPTH_IN}" of depth.`);
                return;
            }
            const halfW = fsWpx / 2;
            let cx = p.x - eh.s.x;
            cx = Math.max(halfW, Math.min(eh.s.w - halfW, cx));
            pushUndo();
            eh.s.farmSink = { edge: eh.key, cx };
            ensureFsHalves(eh.s, eh.key);
            persist(); render(); setTool('select');
            return;
        }
        if (eh.s.shapeType === 'l' || eh.s.shapeType === 'u') {
            const isHoriz = Math.abs(eh.y1 - eh.y2) < 0.5;
            if (!isHoriz) {
                alert('Farmhouse sink must be placed on a HORIZONTAL edge of the shape.');
                return;
            }
            const segLenPx = Math.abs(eh.x2 - eh.x1);
            if (segLenPx < fsWpx + 1) {
                alert(`Edge is too short. Need at least ${FS_WIDTH_IN}" of width along this segment.`);
                return;
            }
            // Determine interior direction by testing points above/below segment
            const poly = eh.s.shapeType === 'l' ? lShapePolygon(eh.s) : uShapePolygon(eh.s);
            const midSegY = eh.y1;
            const midSegX = (eh.x1 + eh.x2) / 2;
            const insideBelow = pointInPolygon(midSegX, midSegY + 4, poly);
            const insideAbove = pointInPolygon(midSegX, midSegY - 4, poly);
            const dir = insideBelow ? 1 : (insideAbove ? -1 : 1); // 1 = cut down, -1 = cut up
            // Check depth: ensure cutout stays inside polygon
            const testDeepY = midSegY + dir * (fsDpx + 2);
            if (!pointInPolygon(midSegX, testDeepY, poly)) {
                alert(`Piece is too shallow at this edge. Need at least ${FS_DEPTH_IN}" of interior depth.`);
                return;
            }
            const halfW = fsWpx / 2;
            const segMinX = Math.min(eh.x1, eh.x2);
            const segMaxX = Math.max(eh.x1, eh.x2);
            let cxAbs = Math.max(segMinX + halfW, Math.min(segMaxX - halfW, p.x));
            pushUndo();
            eh.s.farmSink = {
                edge: 'seg',
                segKey: eh.key,
                cx:    cxAbs - eh.s.x,
                segY:  midSegY - eh.s.y,
                segMinX: segMinX - eh.s.x,
                segMaxX: segMaxX - eh.s.x,
                dir
            };
            ensureFsHalves(eh.s, eh.key);
            persist(); render(); setTool('select');
            return;
        }
        alert('Farmhouse sink can only be placed on a rectangle, L-shape, or U-shape.');
        return;
    }

    // ── Cooktop / Outlet / Bocci — click a piece to attach ──
    if (tool === 'cooktop' || tool === 'outlet' || tool === 'bocci') {
        const hit = hitShape(p.x, p.y);
        if (!hit || hit.subtype) {
            alert(`Click on a countertop piece to place the ${tool}.`);
            return;
        }
        let wPx, hPx, subtype;
        if (tool === 'cooktop') { wPx = 30*INCH; hPx = 20*INCH; subtype = 'cooktop'; }
        else if (tool === 'outlet') { wPx = 2*INCH; hPx = 4*INCH; subtype = 'outlet'; }
        else { wPx = 3*INCH; hPx = 3*INCH; subtype = 'bocci'; }
        // Center on click, clamped to parent bounding box
        const localX = clamp(p.x - hit.x - wPx/2, 0, Math.max(0, hit.w - wPx));
        const localY = clamp(p.y - hit.y - hPx/2, 0, Math.max(0, hit.h - hPx));
        pushUndo();
        shapes.push(normalizeShape({
            id: nextId, label: `P${nextId}`,
            x: hit.x + localX, y: hit.y + localY,
            w: wPx, h: hPx,
            subtype, parentId: hit.id
        }));
        nextId++; persist(); setTool('select'); render(); updateStatus();
        return;
    }

    // ── Radius ──
    if (tool === 'radius') {
        // Chamfer 2-point pick mode
        if (chamferPickState) {
            const { step, edgeA, edgeB } = chamferPickState;
            if (step === 1) {
                // Pick from either edge — snap to whichever is closer to mouse
                const spA = snapOnEdge(p.x, p.y, edgeA);
                const spB = snapOnEdge(p.x, p.y, edgeB);
                const dA = Math.hypot(p.x - spA.x, p.y - spA.y);
                const dB = Math.hypot(p.x - spB.x, p.y - spB.y);
                const useA = dA <= dB;
                chamferPickState.pt1 = useA ? spA : spB;
                chamferPickState.pt1Edge = useA ? 'a' : 'b';
                chamferPickState.step = 2;
                chamferPickState.hoverPt = null;
                render();
            } else {
                // Step 2: pick from the remaining edge
                const remaining = chamferPickState.pt1Edge === 'a' ? edgeB : edgeA;
                const sp2 = snapOnEdge(p.x, p.y, remaining);
                const distA = chamferPickState.pt1Edge === 'a' ? chamferPickState.pt1.dist : sp2.dist;
                const distB = chamferPickState.pt1Edge === 'b' ? chamferPickState.pt1.dist : sp2.dist;
                const { s, key } = chamferPickState;
                pushUndo();
                if (!s.corners)   s.corners   = { nw:0, ne:0, se:0, sw:0 };
                if (!s.chamfers)  s.chamfers  = { nw:0, ne:0, se:0, sw:0 };
                if (!s.chamfersB) s.chamfersB = {};
                s.chamfers[key]  = distA;
                s.chamfersB[key] = distB;
                s.corners[key]   = 0;
                chamferPickState = null;
                persist(); render();
            }
            return;
        }
        const corner = nearestCorner(p.x, p.y);
        if (corner) showRadiusPopup(corner); return;
    }

    // ── Measure ──
    if (tool === 'measure') {
        // Check if clicking near an existing measurement's dim line (not endpoints) to select it
        for (const m of measurements) {
            const rv = resolveMeasureXY(m);
            const off = m.offset || 0;
            const len = Math.hypot(rv.x2-rv.x1, rv.y2-rv.y1);
            if (len < 1) continue;
            const tx=(rv.x2-rv.x1)/len, ty=(rv.y2-rv.y1)/len;
            const onx=ty, ony=-tx, O=20+off;
            const ex1=rv.x1+onx*O, ey1=rv.y1+ony*O, ex2=rv.x2+onx*O, ey2=rv.y2+ony*O;
            const dLine = distToSegment(p.x, p.y, ex1, ey1, ex2, ey2);
            if (dLine < 10) {
                measurePt1 = null; measureHover = null;
                selectedMeasure = m.id; render(); return;
            }
        }
        selectedMeasure = null;
        const sp = snapMeasurePoint(p.x, p.y);
        if (!measurePt1) {
            measurePt1 = sp;
            measureHover = null;
        } else {
            pushUndo();
            measurements.push({ id: Date.now(),
                x1: measurePt1.x, y1: measurePt1.y, s1: measurePt1.shapeId, r1x: measurePt1.rx, r1y: measurePt1.ry,
                x2: sp.x, y2: sp.y, s2: sp.shapeId, r2x: sp.rx, r2y: sp.ry });
            measurePt1 = null; measureHover = null;
            persist(); render();
        }
        return;
    }

    // ── Edge ──
    if (tool === 'edge') {
        const ce = nearestCornerForEdge(p.x, p.y);
        if (ce) {
            pushUndo();
            if (!ce.s.cornerEdges) ce.s.cornerEdges = {nw:{type:'none'},ne:{type:'none'},se:{type:'none'},sw:{type:'none'}};
            ce.s.cornerEdges[ce.key] = { type: activeEdgeType };
            persist(); render(); return;
        }
        const eh = nearestEdge(p.x, p.y);
        if (eh) {
            // Mitered edge — prompt for width then create strip with 2" gap
            if (activeEdgeType === 'mitered' && !eh.key.startsWith('diag_')) {
                const input = prompt('Miter strip width (inches):');
                if (input === null) return; // cancelled
                const miterW = parseFloat(input);
                if (!miterW || miterW <= 0) { alert('Please enter a valid width.'); return; }
                pushUndo();
                if (!eh.s.edges) {
                    if (eh.s.shapeType === 'circle') eh.s.edges = {arc:{type:'none'}};
                    else if (eh.s.shapeType === 'l' || eh.s.shapeType === 'u') eh.s.edges = {};
                    else eh.s.edges = {top:{type:'none'},right:{type:'none'},bottom:{type:'none'},left:{type:'none'}};
                }
                // Determine the segment coordinates — if the edge is split, use only the clicked segment
                let segX1 = eh.x1, segY1 = eh.y1, segX2 = eh.x2, segY2 = eh.y2;
                const edgeData = eh.s.edges[eh.key];
                if (edgeData?.type === 'segmented' && edgeData.segments?.length) {
                    // Find which segment was clicked and apply mitered to just that one
                    const fullLen = Math.hypot(eh.x2 - eh.x1, eh.y2 - eh.y1);
                    const dx = (eh.x2 - eh.x1) / fullLen, dy = (eh.y2 - eh.y1) / fullLen;
                    const t = Math.max(0, Math.min(1, ((p.x - eh.x1)*(eh.x2-eh.x1) + (p.y - eh.y1)*(eh.y2-eh.y1)) / (fullLen*fullLen)));
                    const clickPx = t * fullLen;
                    let cursor = 0;
                    for (const seg of edgeData.segments) {
                        const segPx = seg.length * INCH;
                        if (clickPx <= cursor + segPx) {
                            seg.profile = 'mitered';
                            segX1 = eh.x1 + dx * cursor;
                            segY1 = eh.y1 + dy * cursor;
                            segX2 = eh.x1 + dx * (cursor + segPx);
                            segY2 = eh.y1 + dy * (cursor + segPx);
                            break;
                        }
                        cursor += segPx;
                    }
                } else {
                    eh.s.edges[eh.key] = { type: 'mitered' };
                }
                // Create the strip using segment coordinates (not full edge)
                const segLenPx = Math.hypot(segX2 - segX1, segY2 - segY1);
                const miterPx = miterW * INCH;
                const gapPx = 2 * INCH;
                const edx = segX2 - segX1, edy = segY2 - segY1;
                const elen = Math.hypot(edx, edy) || 1;
                const onx = edy / elen, ony = -edx / elen;
                const isHoriz = Math.abs(edx) > Math.abs(edy);
                let stripW, stripH, stripX, stripY;
                if (isHoriz) {
                    stripW = segLenPx; stripH = miterPx;
                    stripX = Math.min(segX1, segX2);
                    if (ony > 0) stripY = Math.max(segY1, segY2) + gapPx;
                    else         stripY = Math.min(segY1, segY2) - miterPx - gapPx;
                } else {
                    stripW = miterPx; stripH = segLenPx;
                    stripY = Math.min(segY1, segY2);
                    if (onx > 0) stripX = Math.max(segX1, segX2) + gapPx;
                    else         stripX = Math.min(segX1, segX2) - miterPx - gapPx;
                }
                stripX = clamp(stripX, 0, CW - stripW);
                stripY = clamp(stripY, 0, CH - stripH);
                let stripMiterEdge;
                if (eh.key === 'top') stripMiterEdge = 'bottom';
                else if (eh.key === 'bottom') stripMiterEdge = 'top';
                else if (eh.key === 'left') stripMiterEdge = 'right';
                else if (eh.key === 'right') stripMiterEdge = 'left';
                else stripMiterEdge = isHoriz ? (ony > 0 ? 'top' : 'bottom') : (onx > 0 ? 'left' : 'right');
                const stripEdges = {top:{type:'none'},right:{type:'none'},bottom:{type:'none'},left:{type:'none'}};
                stripEdges[stripMiterEdge] = {type:'mitered'};
                shapes.push(normalizeShape({
                    id: nextId, label: 'Miter Strip', x: stripX, y: stripY, w: stripW, h: stripH,
                    edges: stripEdges
                }));
                nextId++;
                persist(); render(); updateStatus();
                return;
            }
            pushUndo();
            // FS-split edge: detect which half (left/right) was clicked and update fsLeft/fsRight.
            if (eh.s.farmSink && farmSinkEdgeKey(eh.s) === eh.key && !eh.key.startsWith('diag_')) {
                ensureFsHalves(eh.s, eh.key);
                const fr = farmSinkRectAbs(eh.s);
                const isVertSeg = Math.abs(eh.x1 - eh.x2) < 0.5;
                let half, hX1, hY1, hX2, hY2;
                if (isVertSeg) {
                    const fsTopY = fr.y, fsBotY = fr.y + fr.h;
                    half = p.y < (fr.y + fr.h / 2) ? 'fsLeft' : 'fsRight';
                    const goingDown = eh.y2 >= eh.y1;
                    if (half === 'fsLeft') {
                        if (goingDown) { hX1 = eh.x1; hY1 = eh.y1; hX2 = eh.x1; hY2 = fsTopY; }
                        else           { hX1 = eh.x2; hY1 = fsTopY; hX2 = eh.x2; hY2 = eh.y2; }
                    } else {
                        if (goingDown) { hX1 = eh.x2; hY1 = fsBotY; hX2 = eh.x2; hY2 = eh.y2; }
                        else           { hX1 = eh.x1; hY1 = eh.y1; hX2 = eh.x1; hY2 = fsBotY; }
                    }
                } else {
                    const fsLx = fr.x, fsRx = fr.x + fr.w;
                    half = p.x < fr.cxAbs ? 'fsLeft' : 'fsRight';
                    const goingRight = eh.x2 >= eh.x1;
                    if (half === 'fsLeft') {
                        if (goingRight) { hX1 = eh.x1; hY1 = eh.y1; hX2 = fsLx; hY2 = eh.y1; }
                        else            { hX1 = fsLx; hY1 = eh.y2; hX2 = eh.x2; hY2 = eh.y2; }
                    } else {
                        if (goingRight) { hX1 = fsRx; hY1 = eh.y2; hX2 = eh.x2; hY2 = eh.y2; }
                        else            { hX1 = eh.x1; hY1 = eh.y1; hX2 = fsRx; hY2 = eh.y1; }
                    }
                }
                const halfData = eh.s.edges[eh.key][half];
                if (halfData?.type === 'segmented' && halfData.segments?.length) {
                    const hLen = Math.hypot(hX2 - hX1, hY2 - hY1);
                    if (hLen >= 1) {
                        const hDx = hX2 - hX1, hDy = hY2 - hY1;
                        const t = Math.max(0, Math.min(1, ((p.x - hX1)*hDx + (p.y - hY1)*hDy) / (hLen*hLen)));
                        const clickIn = t * hLen / INCH;
                        let accum = 0;
                        for (const seg of halfData.segments) {
                            if (clickIn <= accum + seg.length) { seg.profile = activeEdgeType; break; }
                            accum += seg.length;
                        }
                    }
                } else {
                    eh.s.edges[eh.key][half] = { type: activeEdgeType };
                }
                if (POLISHED_TYPES.has(activeEdgeType) && activeEdgeType !== 'polished' && !profileDiags.some(d => d.type === activeEdgeType)) {
                    profileDiags.push({ id: Date.now(), type: activeEdgeType, x: eh.s.x + eh.s.w + 20, y: eh.s.y, w: DIAG_DEF_W, h: DIAG_DEF_H });
                }
                persist(); render();
                return;
            }
            if (eh.key.startsWith('diag_')) {
                if (!eh.s.chamferEdges) eh.s.chamferEdges = {};
                const ck = eh.key.replace('diag_','');
                const chData = eh.s.chamferEdges[ck];
                if (chData?.type === 'segmented' && chData.segments?.length && eh.x1 != null) {
                    // Segmented chamfer — find clicked segment
                    const edgeLen = Math.hypot(eh.x2 - eh.x1, eh.y2 - eh.y1);
                    const dx = eh.x2 - eh.x1, dy = eh.y2 - eh.y1;
                    const t = Math.max(0, Math.min(1, ((p.x - eh.x1)*dx + (p.y - eh.y1)*dy) / (edgeLen*edgeLen)));
                    const clickIn = t * edgeLen / INCH;
                    let accum = 0;
                    for (const seg of chData.segments) {
                        if (clickIn <= accum + seg.length) { seg.profile = activeEdgeType; break; }
                        accum += seg.length;
                    }
                } else {
                    eh.s.chamferEdges[ck] = { type: activeEdgeType };
                }
            } else {
                if (!eh.s.edges) {
                    if (eh.s.shapeType === 'circle') eh.s.edges = {arc:{type:'none'}};
                    else if (eh.s.shapeType === 'l' || eh.s.shapeType === 'u') eh.s.edges = {};
                    else eh.s.edges = {top:{type:'none'},right:{type:'none'},bottom:{type:'none'},left:{type:'none'}};
                }
                const edgeData = eh.s.edges[eh.key];
                if (edgeData?.type === 'segmented' && edgeData.segments?.length && eh.x1 != null) {
                    // Segmented edge — find which segment was clicked and assign profile to just that one
                    const edgeLen = Math.hypot(eh.x2 - eh.x1, eh.y2 - eh.y1);
                    const dx = eh.x2 - eh.x1, dy = eh.y2 - eh.y1;
                    const t = Math.max(0, Math.min(1, ((p.x - eh.x1)*dx + (p.y - eh.y1)*dy) / (edgeLen*edgeLen)));
                    const clickIn = t * edgeLen / INCH;
                    let accum = 0;
                    for (const seg of edgeData.segments) {
                        if (clickIn <= accum + seg.length) { seg.profile = activeEdgeType; break; }
                        accum += seg.length;
                    }
                } else {
                    eh.s.edges[eh.key] = { type: activeEdgeType };
                }
                // Auto-add profile diagram if polished subtype and not already shown
                if (POLISHED_TYPES.has(activeEdgeType) && activeEdgeType !== 'polished' && !profileDiags.some(d => d.type === activeEdgeType)) {
                    profileDiags.push({ id: Date.now(), type: activeEdgeType, x: eh.s.x + eh.s.w + 20, y: eh.s.y, w: DIAG_DEF_W, h: DIAG_DEF_H });
                }
            }
            persist(); render();
        }
        return;
    }

    // ── Split Edge — click to place split point on any edge ──
    if (tool === 'splitedge') {
        const eh = nearestEdge(p.x, p.y);
        if (eh && eh.x1 != null) {
            const edgeLen = Math.hypot(eh.x2 - eh.x1, eh.y2 - eh.y1);
            if (edgeLen < 1) return;
            pushUndo();

            const isChamfer = eh.key.startsWith('diag_');
            // FS-split edge: treat each half as its own edge when splitting.
            let hX1 = eh.x1, hY1 = eh.y1, hX2 = eh.x2, hY2 = eh.y2;
            let container, storeKey;
            let isFsHalf = false, fsHalfParent = null, fsHalfKey = null;
            if (!isChamfer && eh.s.farmSink && farmSinkEdgeKey(eh.s) === eh.key) {
                ensureFsHalves(eh.s, eh.key);
                const fr = farmSinkRectAbs(eh.s);
                const isVertSeg = Math.abs(eh.x1 - eh.x2) < 0.5;
                let half;
                if (isVertSeg) {
                    const fsTopY = fr.y, fsBotY = fr.y + fr.h;
                    half = p.y < (fr.y + fr.h / 2) ? 'fsLeft' : 'fsRight';
                    const goingDown = eh.y2 >= eh.y1;
                    if (half === 'fsLeft') {
                        if (goingDown) { hX1 = eh.x1; hY1 = eh.y1; hX2 = eh.x1; hY2 = fsTopY; }
                        else           { hX1 = eh.x2; hY1 = fsTopY; hX2 = eh.x2; hY2 = eh.y2; }
                    } else {
                        if (goingDown) { hX1 = eh.x2; hY1 = fsBotY; hX2 = eh.x2; hY2 = eh.y2; }
                        else           { hX1 = eh.x1; hY1 = eh.y1; hX2 = eh.x1; hY2 = fsBotY; }
                    }
                } else {
                    half = p.x < fr.cxAbs ? 'fsLeft' : 'fsRight';
                    const fsLx = fr.x, fsRx = fr.x + fr.w;
                    const goingRight = eh.x2 >= eh.x1;
                    if (half === 'fsLeft') {
                        if (goingRight) { hX1 = eh.x1; hY1 = eh.y1; hX2 = fsLx; hY2 = eh.y1; }
                        else            { hX1 = fsLx; hY1 = eh.y2; hX2 = eh.x2; hY2 = eh.y2; }
                    } else {
                        if (goingRight) { hX1 = fsRx; hY1 = eh.y2; hX2 = eh.x2; hY2 = eh.y2; }
                        else            { hX1 = eh.x1; hY1 = eh.y1; hX2 = fsRx; hY2 = eh.y1; }
                    }
                }
                isFsHalf = true;
                fsHalfParent = eh.s.edges[eh.key];
                fsHalfKey = half;
                container = fsHalfParent;
                storeKey = half;
            } else if (isChamfer) {
                if (!eh.s.chamferEdges) eh.s.chamferEdges = {};
                container = eh.s.chamferEdges;
                storeKey = eh.key.replace('diag_','');
            } else {
                if (!eh.s.edges) {
                    if (eh.s.shapeType === 'circle') eh.s.edges = {arc:{type:'none'}};
                    else if (eh.s.shapeType === 'l' || eh.s.shapeType === 'u') eh.s.edges = {};
                    else eh.s.edges = {top:{type:'none'},right:{type:'none'},bottom:{type:'none'},left:{type:'none'}};
                }
                container = eh.s.edges;
                storeKey = eh.key;
            }
            // Compute split ratio based on the (possibly-half) segment
            const segLen = Math.hypot(hX2 - hX1, hY2 - hY1);
            if (segLen < 1) { render(); return; }
            const dx = hX2 - hX1, dy = hY2 - hY1;
            const t = Math.max(0.02, Math.min(0.98, ((p.x - hX1)*dx + (p.y - hY1)*dy) / (segLen*segLen)));
            const splitIn = +((t * segLen) / INCH).toFixed(2);
            const totalIn = +(segLen / INCH).toFixed(2);

            const existing = container[storeKey];
            if (existing?.type === 'segmented' && existing.segments?.length) {
                let accum = 0;
                for (let i = 0; i < existing.segments.length; i++) {
                    const seg = existing.segments[i];
                    if (splitIn <= accum + seg.length && splitIn > accum) {
                        const localSplit = +(splitIn - accum).toFixed(2);
                        const remainder = +(seg.length - localSplit).toFixed(2);
                        if (localSplit > 0.25 && remainder > 0.25) {
                            existing.segments.splice(i, 1,
                                { length: localSplit, profile: seg.profile },
                                { length: remainder, profile: seg.profile }
                            );
                        }
                        break;
                    }
                    accum += seg.length;
                }
            } else {
                const curProfile = existing?.type || 'none';
                const seg1Len = splitIn;
                const seg2Len = +(totalIn - splitIn).toFixed(2);
                if (seg1Len > 0.25 && seg2Len > 0.25) {
                    container[storeKey] = {
                        type: 'segmented',
                        segments: [
                            { length: seg1Len, profile: curProfile === 'segmented' ? 'none' : curProfile },
                            { length: seg2Len, profile: curProfile === 'segmented' ? 'none' : curProfile }
                        ]
                    };
                }
            }
            persist(); render();
        }
        return;
    }

    // ── BSP draw ──
    if (tool === 'bsp') {
        drawing = true; dStart = { x:sx, y:sy }; dCur = { x:sx, y:sy }; return;
    }

    // ── Text ghost placement ──
    if (ghostText) {
        pushUndo();
        const newId = Date.now();
        textItems.push({ id: newId, x: p.x, y: p.y, text: ghostText.text, size: ghostText.size });
        ghostText = null;
        persist();
        setTool('select');
        selectedText = newId;
        render(); return;
    }

    // ── Check (rectangular notch at a corner) ──
    if (tool === 'check') {
        const SNAP = 40;
        let best = { dist: SNAP, s: null, cornerKey: null, vertexIdx: null, cx: 0, cy: 0 };
        for (const s of shapes) {
            if (s.subtype) continue;
            const st = s.shapeType || 'rect';
            if (st === 'rect') {
                const corners = [
                    { key:'nw', x: s.x,       y: s.y       },
                    { key:'ne', x: s.x + s.w, y: s.y       },
                    { key:'se', x: s.x + s.w, y: s.y + s.h },
                    { key:'sw', x: s.x,       y: s.y + s.h },
                ];
                for (const cn of corners) {
                    const d = Math.hypot(p.x - cn.x, p.y - cn.y);
                    if (d < best.dist) best = { dist: d, s, cornerKey: cn.key, vertexIdx: null, cx: cn.x, cy: cn.y };
                }
            } else if (st === 'l' || st === 'u') {
                const poly = st === 'l' ? lShapePolygon(s) : uShapePolygon(s);
                for (const i of convexVertexIndices(poly)) {
                    const d = Math.hypot(p.x - poly[i][0], p.y - poly[i][1]);
                    if (d < best.dist) best = { dist: d, s, cornerKey: null, vertexIdx: i, cx: poly[i][0], cy: poly[i][1] };
                }
            }
        }
        if (!best.s) {
            alert('Click near a convex corner of a piece to place a check.');
            return;
        }
        // showCheckPopup calls hideAllPopups() which wipes pendingCheck*,
        // so set them AFTER opening the popup.
        showCheckPopup(best.cx, best.cy);
        pendingCheckShape   = best.s;
        pendingCheckCorner  = best.cornerKey;
        pendingCheckVertex  = best.vertexIdx;
        return;
    }

    // ── Joint ──
    if (tool === 'joint') {
        // Drag existing joint?
        const jh = hitJoint(p.x, p.y);
        if (jh) {
            selectedJoint = jh; draggingJoint = true; draggingJointRef = jh;
            pushUndo(); render(); return;
        }
        // Look for a nearby inside corner — snap there if found. Otherwise
        // fall back to free placement on whichever shape was clicked.
        const CORNER_SNAP_PX = 40;
        let bestShape = null, bestCorner = null, bestDist = CORNER_SNAP_PX;
        for (const s of shapes) {
            if (s.subtype) continue;
            const corners = getInsideCornersForJoint(s);
            for (const c of corners) {
                const d = Math.hypot(p.x - c.x, p.y - c.y);
                if (d < bestDist) { bestDist = d; bestShape = s; bestCorner = c; }
            }
        }
        if (bestShape && bestCorner) {
            showJointPopup(bestShape, { px: bestCorner.x, py: bestCorner.y }, bestCorner.x, bestCorner.y, true);
            return;
        }
        // Free placement fallback — original behavior
        const hit = hitShape(p.x, p.y);
        if (hit) {
            showJointPopup(hit, { px: p.x, py: p.y }, p.x, p.y, false);
        }
        return;
    }

    // ── Select ──
    // Click on dimension label to hide it
    for (const dt of dimClickTargets) {
        const [rx, ry, rw, rh] = dt.rect;
        if (p.x >= rx && p.x <= rx + rw && p.y >= ry && p.y <= ry + rh) {
            const sh = byId(dt.shapeId);
            if (sh) {
                pushUndo();
                if (!sh.hideDims) sh.hideDims = {};
                sh.hideDims[dt.dimKey] = true;
                persist(); render();
                return;
            }
        }
    }
    // Click on polish-under area → select it
    {
        let puHit = null;
        for (const s of shapes) {
            if (s.subtype) continue;
            const arr = s.polishUnders || [];
            for (let i = arr.length - 1; i >= 0; i--) {
                const r = arr[i];
                const rx = s.x + r.x, ry = s.y + r.y;
                if (p.x >= rx && p.x <= rx + r.w && p.y >= ry && p.y <= ry + r.h) {
                    puHit = { shapeId: s.id, idx: i }; break;
                }
            }
            if (puHit) break;
        }
        if (puHit) {
            selectedPU = puHit; selected = null; selectedJoint = null; selectedText = null;
            render(); return;
        }
        selectedPU = null;
    }

    // Measurements: click near dim line to select
    selectedMeasure = null;
    for (const m of measurements) {
        const rv = resolveMeasureXY(m);
        const off = m.offset || 0;
        const len = Math.hypot(rv.x2-rv.x1, rv.y2-rv.y1);
        if (len < 1) continue;
        const tx2=(rv.x2-rv.x1)/len, ty2=(rv.y2-rv.y1)/len;
        const onx2=ty2, ony2=-tx2, O2=20+off;
        const dLine = distToSegment(p.x, p.y, rv.x1+onx2*O2, rv.y1+ony2*O2, rv.x2+onx2*O2, rv.y2+ony2*O2);
        if (dLine < 12) { selectedMeasure = m.id; render(); return; }
    }
    // Profile diagrams — selectable/draggable/resizable
    if (hitDiagResize(p.x, p.y)) {
        const d = profileDiags.find(d => d.id === selectedDiag);
        if (d) { pushUndo(); resizingDiag = true; resizeDiagBase = { mx: p.x, my: p.y, w: d.w||DIAG_DEF_W, h: d.h||DIAG_DEF_H }; render(); return; }
    }
    const dHit = hitProfileDiag(p.x, p.y);
    if (dHit) {
        selectedDiag = dHit.id; selected = null; selectedJoint = null; selectedText = null;
        if (hitDiagResize(p.x, p.y)) {
            pushUndo(); resizingDiag = true; resizeDiagBase = { mx: p.x, my: p.y, w: dHit.w||DIAG_DEF_W, h: dHit.h||DIAG_DEF_H };
        } else {
            movingDiag = true; moveDiagOff = { x: p.x - dHit.x, y: p.y - dHit.y };
        }
        render(); return;
    }
    selectedDiag = null;
    // Text items are selectable/draggable in select mode from any non-draw tool
    selectedText = null;
    const th = hitTextItem(p.x, p.y);
    if (th) {
        selectedText = th.id; selected = null; selectedJoint = null;
        movingText = true; moveTextStart = { mx: p.x, my: p.y, ox: th.x, oy: th.y };
        render(); return;
    }
    // Check joint drag first
    const jh = hitJoint(p.x, p.y);
    if (jh) {
        selectedJoint = jh; selected = jh.s.id;
        draggingJoint = true; draggingJointRef = jh;
        pushUndo(); render(); return;
    }

    const sel = byId(selected);
    if (sel) {
        const h = hitHandle(sel, p.x, p.y);
        if (h) {
            pushUndo(); resizing = true; resizeH = h.id;
            resizeBase = { ...sel }; resizeMouse = { x:p.x, y:p.y }; return;
        }
    }
    // Edge drag-resize — grab any edge line of any shape
    const lineHit = hitShapeLine(p.x, p.y);
    if (lineHit) {
        if (selected !== lineHit.s.id) { selected = lineHit.s.id; selectedJoint = null; }
        pushUndo();
        edgeResizing = {
            s: lineHit.s, kind: lineHit.kind,
            side: lineHit.side, edgeIdx: lineHit.edgeIdx,
            base: JSON.parse(JSON.stringify(lineHit.s)),
            mouse: { x: p.x, y: p.y }
        };
        render();
        return;
    }
    const hit = hitShape(p.x, p.y);
    if (hit) {
        if (selected !== hit.id) { selected = hit.id; selectedJoint = null; render(); }
        // Check if click is inside this shape's farmhouse sink cutout
        selectedFarmSinkShapeId = null;
        if (hit.farmSink) {
            const fr = farmSinkRectAbs(hit);
            if (fr && p.x >= fr.x && p.x <= fr.x + fr.w && p.y >= fr.y && p.y <= fr.y + fr.h) {
                selectedFarmSinkShapeId = hit.id;
            }
        }
        pushUndo(); moving = true; moveOff = { x:p.x-hit.x, y:p.y-hit.y };
    } else {
        selected = null; selectedJoint = null; selectedFarmSinkShapeId = null; render();
    }
    updateStatus();
});

cv.addEventListener('mousemove', e => {
    const p = mousePos(e);
    document.getElementById('st-pos').innerHTML = `Cursor: <b>${(p.x/INCH).toFixed(1)}″, ${(p.y/INCH).toFixed(1)}″</b>`;

    if ((tool === 'draw' || tool === 'ldraw' || tool === 'udraw' || tool === 'bsp') && drawing) {
        dCur = { x:clamp(snap(p.x),0,CW), y:clamp(snap(p.y),0,CH) };
        render(); return;
    }

    if (drawingPU && puParent) {
        const lx = clamp(p.x - puParent.x, 0, puParent.w);
        const ly = clamp(p.y - puParent.y, 0, puParent.h);
        puCur = { x: lx, y: ly };
        render(); return;
    }

    if (ghostText) { ghostTextPos = { x: p.x, y: p.y }; render(); return; }

    if (resizingDiag && resizeDiagBase) {
        const d = profileDiags.find(d => d.id === selectedDiag);
        if (d) {
            d.w = Math.max(80, resizeDiagBase.w + (p.x - resizeDiagBase.mx));
            d.h = Math.max(60, resizeDiagBase.h + (p.y - resizeDiagBase.my));
            render();
        }
        return;
    }
    if (movingDiag) {
        const d = profileDiags.find(d => d.id === selectedDiag);
        if (d) { d.x = snap(p.x - moveDiagOff.x); d.y = snap(p.y - moveDiagOff.y); render(); }
        return;
    }
    if (movingText && moveTextStart) {
        const ti = textItems.find(t => t.id === selectedText);
        if (ti) {
            ti.x = snap(moveTextStart.ox + p.x - moveTextStart.mx);
            ti.y = snap(moveTextStart.oy + p.y - moveTextStart.my);
            render();
        }
        return;
    }

    if (draggingJoint && draggingJointRef) {
        const { s, j } = draggingJointRef;
        // Magnetic snap to nearest inside corner, measured by EUCLIDEAN distance
        // so that multiple corners at the same axis-perpendicular coordinate
        // (e.g. both U-shape inside corners at the same y for a horizontal
        // joint) correctly disambiguate by cursor position.
        const SNAP_THRESH = 24; // px — snap radius around the corner
        const corners = getInsideCornersForJoint(s);
        let snapped = null;
        let bestDist = SNAP_THRESH;
        for (const c of corners) {
            const relPos = j.axis === 'v' ? (c.x - s.x) : (c.y - s.y);
            const axisMin = INCH, axisMax = (j.axis === 'v' ? s.w : s.h) - INCH;
            if (relPos < axisMin || relPos > axisMax) continue;
            const d = Math.hypot(p.x - c.x, p.y - c.y);
            if (d < bestDist) { bestDist = d; snapped = { corner: c, relPos }; }
        }
        if (snapped) {
            j.pos = snapped.relPos;
            // Store the corner as shape-relative so the joint follows the shape,
            // and so drawJointLines can anchor the joint at the corner to form
            // a continuous line with the wall that ends at the corner.
            j.snap = { relX: snapped.corner.x - s.x, relY: snapped.corner.y - s.y };
            jointSnapCorner = snapped.corner;
        } else {
            if (j.axis === 'v') j.pos = clamp(snap(p.x - s.x), INCH, s.w - INCH);
            else                j.pos = clamp(snap(p.y - s.y), INCH, s.h - INCH);
            delete j.snap;
            jointSnapCorner = null;
        }
        render(); return;
    }

    if (resizing) { applyResize(p); render(); return; }
    if (edgeResizing) {
        const dxa = snap(p.x - edgeResizing.mouse.x);
        const dya = snap(p.y - edgeResizing.mouse.y);
        applyEdgeResize(dxa, dya);
        render();
        return;
    }
    if (moving) {
        const s = byId(selected);
        if (s) {
            const oldX = s.x, oldY = s.y;
            s.x = clamp(snap(p.x-moveOff.x),0,CW-s.w);
            s.y = clamp(snap(p.y-moveOff.y),0,CH-s.h);
            const dx = s.x - oldX, dy = s.y - oldY;
            if (dx || dy) {
                // Move all child items (parent-bound subtype shapes) with the parent
                for (const child of shapes) {
                    if (child.parentId === s.id) {
                        child.x += dx;
                        child.y += dy;
                    }
                }
            }
            render();
        }
        return;
    }

    if (tool === 'radius') {
        if (chamferPickState) {
            const { step, edgeA, edgeB } = chamferPickState;
            let hoverPt = null;
            if (step === 1) {
                const spA = snapOnEdge(p.x, p.y, edgeA);
                const spB = snapOnEdge(p.x, p.y, edgeB);
                const dA = Math.hypot(p.x - spA.x, p.y - spA.y);
                const dB = Math.hypot(p.x - spB.x, p.y - spB.y);
                hoverPt = dA <= dB ? spA : spB;
            } else {
                const remaining = chamferPickState.pt1Edge === 'a' ? edgeB : edgeA;
                hoverPt = snapOnEdge(p.x, p.y, remaining);
            }
            if (chamferPickState.hoverPt?.x !== hoverPt?.x || chamferPickState.hoverPt?.y !== hoverPt?.y) {
                chamferPickState.hoverPt = hoverPt;
                render();
            }
            cv.style.cursor = 'crosshair'; return;
        }
        const c = nearestCorner(p.x, p.y);
        if (c !== hovCorner) { hovCorner = c; render(); }
        cv.style.cursor = c ? 'pointer' : 'crosshair'; return;
    }
    if (tool === 'measure') {
        const sp = snapMeasurePoint(p.x, p.y);
        if (measurePt1) {
            measureHover = sp; render();
        } else {
            // Show snap dot on hover even before first click
            measureHover = sp; render();
        }
        cv.style.cursor = 'crosshair'; return;
    }
    if (tool === 'edge') {
        const e2 = nearestEdge(p.x, p.y);
        const ce = nearestCornerForEdge(p.x, p.y);
        if (e2 !== hovEdge || ce !== hovCornerEdge) { hovEdge = e2; hovCornerEdge = ce; render(); }
        cv.style.cursor = (e2 || ce) ? 'pointer' : 'crosshair'; return;
    }
    if (tool === 'splitedge') {
        const e2 = nearestEdge(p.x, p.y);
        if (e2 !== hovEdge) { hovEdge = e2; render(); }
        cv.style.cursor = e2 ? 'pointer' : 'crosshair'; return;
    }
    if (tool === 'joint') {
        const jh = hitJoint(p.x, p.y);
        if (jh) { cv.style.cursor = 'ew-resize'; return; }
        // Crosshair inside any shape (corner-snap preferred, free placement fallback)
        cv.style.cursor = hitShape(p.x, p.y) ? 'crosshair' : 'default';
        return;
    }
    if (tool === 'select') {
        if (hitJoint(p.x, p.y)) { cv.style.cursor = 'ew-resize'; return; }
        const sel = byId(selected);
        if (sel) {
            const h = hitHandle(sel, p.x, p.y);
            if (h) { cv.style.cursor = h.cur; return; }
        }
        cv.style.cursor = hitShape(p.x,p.y) ? 'move' : 'default';
    }
});

cv.addEventListener('mouseup', e => {
    const p = mousePos(e);

    if (draggingJoint) {
        draggingJoint = false; draggingJointRef = null; jointSnapCorner = null; persist(); render(); return;
    }

    if ((tool === 'draw' || tool === 'ldraw' || tool === 'udraw' || tool === 'bsp') && drawing) {
        drawing = false;
        const dx = clamp(snap(p.x),0,CW) - dStart.x, dy = clamp(snap(p.y),0,CH) - dStart.y;
        const r = normRect(dStart.x, dStart.y, dx, dy);
        const preW  = r.w >= INCH ? parseFloat(pxToIn(r.w)) : 36;
        const preH  = r.h >= INCH ? parseFloat(pxToIn(r.h)) : 25;
        const placeX = r.w >= INCH ? clamp(r.x,0,CW-r.w) : clamp(dStart.x,0,CW-preW*INCH);
        const placeY = r.h >= INCH ? clamp(r.y,0,CH-r.h) : clamp(dStart.y,0,CH-preH*INCH);
        pendingPlace = { x:placeX, y:placeY };
        dStart = null; dCur = null; render();
        if (tool === 'ldraw') {
            showLShapePopup(100, 48, 74, 22, null);
        } else if (tool === 'udraw') {
            // A=width, B=leftH, C=leftW, D=floorH (bottom strip), E=rightW, F=rightH
            showUShapePopup(120, 48, 26, 26, 26, 48, null);
        } else if (tool === 'bsp') {
            pendingBspPlace = { x: placeX, y: placeY };
            showBspPopup(100, 20, 20, 20, 25, null);
        } else {
            showSizePopup(preW, preH, null);
        }
        return;
    }
    if (drawingPU && puParent && puStart && puCur) {
        drawingPU = false;
        const x0 = Math.min(puStart.x, puCur.x), y0 = Math.min(puStart.y, puCur.y);
        const x1 = Math.max(puStart.x, puCur.x), y1 = Math.max(puStart.y, puCur.y);
        const w = x1 - x0, h = y1 - y0;
        if (w >= INCH && h >= INCH) {
            pushUndo();
            if (!puParent.polishUnders) puParent.polishUnders = [];
            puParent.polishUnders.push({ x: x0, y: y0, w, h });
            persist();
        }
        puParent = null; puStart = null; puCur = null;
        setTool('select');
        render();
        return;
    }
    if (resizingDiag) { resizingDiag = false; resizeDiagBase = null; persist(); }
    if (movingDiag) { movingDiag = false; persist(); }
    if (movingText) { movingText = false; moveTextStart = null; persist(); }
    if (moving)     { moving   = false; persist(); }
    if (resizing)   { resizing = false; resizeH = null; persist(); }
    if (edgeResizing) { edgeResizing = null; persist(); }
});

cv.addEventListener('mouseleave', () => {
    document.getElementById('st-pos').innerHTML = 'Cursor: <b>—</b>';
    if (hovCorner || hovEdge || hovCornerEdge) { hovCorner = null; hovEdge = null; hovCornerEdge = null; render(); }
    if (measureHover) { measureHover = null; render(); }
});

// Double-click: edit size OR remove joint
cv.addEventListener('dblclick', e => {
    if (currentPopup) return;
    const p = mousePos(e);
    // Remove joint on double-click in joint tool
    if (tool === 'joint') {
        const jh = hitJoint(p.x, p.y);
        if (jh) {
            pushUndo();
            jh.s.joints = jh.s.joints.filter(j => j !== jh.j);
            if (selectedJoint?.j === jh.j) selectedJoint = null;
            persist(); render(); return;
        }
    }
    // Edit size in select mode
    if (tool === 'select') {
        const hit = hitShape(p.x, p.y);
        if (!hit) return;
        selected = hit.id; render();
        if (hit.shapeType === 'l') {
            lshapeCorner = hit.notchCorner || 'ne';
            showLShapePopup(pxToIn(hit.w), pxToIn(hit.h), pxToIn(hit.notchW||0), pxToIn(hit.notchH||0), hit.id);
        } else if (hit.shapeType === 'u') {
            // Editing always presents in canonical 'top' frame
            const isVert = !hit.uOpening || hit.uOpening === 'top' || hit.uOpening === 'bottom';
            const A = isVert ? hit.w : hit.h;
            const H = isVert ? hit.h : hit.w;
            const lH = hit.leftH ?? H;
            const rH = hit.rightH ?? H;
            // Backward compat for floorH
            const fH = hit.floorH != null ? hit.floorH : (hit.channelH != null ? H - hit.channelH : 0);
            showUShapePopup(pxToIn(A), pxToIn(lH), pxToIn(hit.leftW||0), pxToIn(fH), pxToIn(hit.rightW||0), pxToIn(rH), hit.id);
        } else if (hit.shapeType === 'bsp') {
            showBspPopup(pxToIn(hit.w), pxToIn(hit.h-hit.pH), pxToIn(hit.pH), pxToIn(hit.pW), pxToIn(hit.pX), hit.id);
        } else if (hit.shapeType === 'circle') {
            showCircleEditPopup(hit);
        } else {
            showSizePopup(pxToIn(hit.w), pxToIn(hit.h), hit.id);
        }
    }
});

// ─────────────────────────────────────────────────────────────
//  Keyboard
// ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
    if (currentPopup) return;
    // Skip Quote-tab shortcuts when the Layout (slab) panel is active —
    // it has its own R/Delete/Esc handlers.
    {
        const slabPanel = document.getElementById('slab-panel');
        if (slabPanel && slabPanel.style.display !== 'none') return;
    }
    if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedJoint && document.activeElement === document.body) {
            e.preventDefault();
            pushUndo();
            selectedJoint.s.joints = selectedJoint.s.joints.filter(j => j !== selectedJoint.j);
            selectedJoint = null; persist(); render(); return;
        }
        if (document.activeElement === document.body) {
            if (selectedMeasure !== null || selectedText !== null || selected !== null || selectedDiag !== null || selectedPU) {
                e.preventDefault(); deleteSelected(); return;
            }
        }
    }
    // Rotate selected shape 90° with R key
    if ((e.key === 'r' || e.key === 'R') && selected !== null && document.activeElement === document.body) {
        const s = byId(selected);
        if (s) {
            e.preventDefault(); pushUndo();
            if (s.shapeType === 'l') {
                const oldNotch = s.notchCorner || 'ne';
                const cycle = { ne:'se', se:'sw', sw:'nw', nw:'ne' };
                const newNotch = cycle[oldNotch] || 'se';
                const oldH_local = s.h;
                // Capture old polygon + FS center/normal BEFORE we mutate the shape.
                const oldPoly = lShapePolygon(s);
                const fsCN = s.farmSink ? fsCenterAndNormal(s, oldPoly.map(p => [p[0]-s.x, p[1]-s.y])) : null;
                const oldFsSegIdx = (s.farmSink && s.farmSink.edge === 'seg')
                    ? parseInt(String(s.farmSink.segKey).replace('seg',''), 10) : -1;
                // Remap vertex- and segment-keyed properties to new polygon ordering.
                if (s.checks && s.checks.length) {
                    for (const c of s.checks) {
                        if (c.vertexIdx != null) {
                            c.vertexIdx = lVertexIdxAfterRotationCW(oldNotch, c.vertexIdx, newNotch);
                        }
                    }
                }
                if (s.corners)      s.corners      = lRemapKeyedDataCW(s.corners,      'lc',  oldNotch, newNotch);
                if (s.chamfers)     s.chamfers     = lRemapKeyedDataCW(s.chamfers,     'lc',  oldNotch, newNotch);
                if (s.chamfersB)    s.chamfersB    = lRemapKeyedDataCW(s.chamfersB,    'lc',  oldNotch, newNotch);
                if (s.cornerEdges)  s.cornerEdges  = lRemapKeyedDataCW(s.cornerEdges,  'lc',  oldNotch, newNotch);
                if (s.chamferEdges) s.chamferEdges = lRemapKeyedDataCW(s.chamferEdges, 'lc',  oldNotch, newNotch);
                if (s.edges)        s.edges        = lRemapKeyedDataCW(s.edges,        'seg', oldNotch, newNotch);
                s.notchCorner = newNotch;
                const oldW = s.w, oldH = s.h, oldNW = s.notchW, oldNH = s.notchH;
                s.w = oldH; s.h = oldW; s.notchW = oldNH; s.notchH = oldNW;
                // Rotate farm sink data
                if (fsCN) {
                    const newCenter = [oldH_local - fsCN.center[1], fsCN.center[0]];
                    const newNormal = [-fsCN.normal[1], fsCN.normal[0]];
                    const newPoly = lShapePolygon(s).map(p => [p[0]-s.x, p[1]-s.y]);
                    // Auto-detect new seg by point matching (more robust than role mapping).
                    let newSegIdx = fsFindSegFromPoint(newPoly, newCenter, newNormal);
                    if (newSegIdx < 0) newSegIdx = lVertexIdxAfterRotationCW(oldNotch, oldFsSegIdx, newNotch);
                    const newFs = fsFromCenterNormal(s, newCenter, newNormal, 'seg' + newSegIdx, newPoly);
                    if (newFs) s.farmSink = newFs;
                }
                rotateJointsCW(s, oldH_local);
                clearStaleFsHalves(s);
                if (s.farmSink) ensureFsHalves(s, farmSinkEdgeKey(s));
                rotatePolishUndersCW(s, oldH_local);
                rotateChildItemsCW(s, oldH_local);
            } else if (s.shapeType === 'u') {
                // U polygon vertex indices are stable across uOpening rotations,
                // so s.checks[].vertexIdx stays unchanged.
                const oldH_local = s.h;
                const oldPoly = uShapePolygon(s).map(p => [p[0]-s.x, p[1]-s.y]);
                const fsCN = s.farmSink ? fsCenterAndNormal(s, oldPoly) : null;
                const oldFsSegKey = (s.farmSink && s.farmSink.edge === 'seg') ? s.farmSink.segKey : null;
                const cycle = { top:'right', right:'bottom', bottom:'left', left:'top' };
                s.uOpening = cycle[s.uOpening || 'top'] || 'right';
                const oldW = s.w, oldH = s.h, oldLW = s.leftW, oldRW = s.rightW, oldCH = s.channelH;
                s.w = oldH; s.h = oldW; s.leftW = oldLW; s.rightW = oldRW; s.channelH = oldCH;
                if (fsCN) {
                    const newCenter = [oldH_local - fsCN.center[1], fsCN.center[0]];
                    const newNormal = [-fsCN.normal[1], fsCN.normal[0]];
                    const newPoly = uShapePolygon(s).map(p => [p[0]-s.x, p[1]-s.y]);
                    let newSegIdx = fsFindSegFromPoint(newPoly, newCenter, newNormal);
                    const newKey = newSegIdx >= 0 ? ('seg' + newSegIdx) : oldFsSegKey;
                    const newFs = fsFromCenterNormal(s, newCenter, newNormal, newKey, newPoly);
                    if (newFs) s.farmSink = newFs;
                }
                rotateJointsCW(s, oldH_local);
                rotatePolishUndersCW(s, oldH_local);
                rotateChildItemsCW(s, oldH_local);
                clearStaleFsHalves(s);
                if (s.farmSink) ensureFsHalves(s, farmSinkEdgeKey(s));
            } else if (s.shapeType === 'circle') {
                // No change — circles are symmetric
            } else {
                // Rect / BSP / sinks / cooktops — swap w and h, and rotate
                // every corner / edge property CW so the visual features
                // stick to the piece.
                const isRect = (s.shapeType || 'rect') === 'rect';
                const oldH_local = s.h;
                const fsCN = (isRect && s.farmSink) ? fsCenterAndNormal(s, null) : null;
                // Rect corner checks: cycle cornerKey CW and swap w↔d.
                if (s.checks && s.checks.length && isRect) {
                    const cyc = { nw:'ne', ne:'se', se:'sw', sw:'nw' };
                    for (const c of s.checks) {
                        if (c.cornerKey) {
                            c.cornerKey = cyc[c.cornerKey] || c.cornerKey;
                            const ow = c.w; c.w = c.d; c.d = ow;
                        }
                    }
                }
                if (isRect) {
                    // Corner radii — symmetric, just cycle keys.
                    // 90° CW rotation: each new corner inherits from the
                    // corner one step counter-clockwise (the corner that
                    // physically rotates INTO this position).
                    //   new NW ← old SW, NE ← NW, SE ← NE, SW ← SE
                    if (s.corners) {
                        const o = { ...s.corners };
                        s.corners = {
                            nw: o.sw || 0, ne: o.nw || 0,
                            se: o.ne || 0, sw: o.se || 0
                        };
                    }
                    // Chamfers: keys cycle the same way, BUT the A/B legs
                    // of each chamfer swap because the polygon walk reverses
                    // their role at the rotated corner.
                    if (s.chamfers || s.chamfersB) {
                        const ch  = { ...(s.chamfers  || {}) };
                        const chB = { ...(s.chamfersB || {}) };
                        s.chamfers  = {
                            nw: chB.sw || 0, ne: chB.nw || 0,
                            se: chB.ne || 0, sw: chB.se || 0
                        };
                        s.chamfersB = {
                            nw: ch.sw  || 0, ne: ch.nw  || 0,
                            se: ch.ne  || 0, sw: ch.se  || 0
                        };
                    }
                    // Corner edge profiles (the radius arc / chamfer diagonal
                    // styling) — single value per corner, same cycle.
                    const noneEd = { type: 'none' };
                    if (s.cornerEdges) {
                        const o = { ...s.cornerEdges };
                        s.cornerEdges = {
                            nw: o.sw || noneEd, ne: o.nw || noneEd,
                            se: o.ne || noneEd, sw: o.se || noneEd
                        };
                    }
                    if (s.chamferEdges) {
                        const o = { ...s.chamferEdges };
                        s.chamferEdges = {};
                        if (o.sw) s.chamferEdges.nw = o.sw;
                        if (o.nw) s.chamferEdges.ne = o.nw;
                        if (o.ne) s.chamferEdges.se = o.ne;
                        if (o.se) s.chamferEdges.sw = o.se;
                    }
                    // Side edge profiles: top → right → bottom → left → top.
                    // Segmented-edge order is preserved because adjacent edges
                    // both run forward in the CW polygon traversal.
                    if (s.edges) {
                        const o = { ...s.edges };
                        s.edges = {
                            top:    o.left   || noneEd,
                            right:  o.top    || noneEd,
                            bottom: o.right  || noneEd,
                            left:   o.bottom || noneEd
                        };
                    }
                }
                const oldW = s.w; s.w = s.h; s.h = oldW;
                rotateJointsCW(s, oldH_local);
                rotatePolishUndersCW(s, oldH_local);
                rotateChildItemsCW(s, oldH_local);
                // Rotate farm sink: rect 'top'→'right'→'bottom'→'left'.
                if (isRect && fsCN) {
                    const newCenter = [oldH_local - fsCN.center[1], fsCN.center[0]];
                    const newNormal = [-fsCN.normal[1], fsCN.normal[0]];
                    const cycEdge = { top:'right', right:'bottom', bottom:'left', left:'top' };
                    const newEdge = cycEdge[s.farmSink.edge] || 'top';
                    const newFs = fsFromCenterNormal(s, newCenter, newNormal, newEdge, null);
                    if (newFs) s.farmSink = newFs;
                }
            }
            // Keep shape within canvas
            s.x = clamp(s.x, 0, CW - s.w); s.y = clamp(s.y, 0, CH - s.h);
            persist(); render(); updateStatus(); return;
        }
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && selectedMeasure !== null && document.activeElement === document.body) {
        e.preventDefault();
        const mm = measurements.find(mm => mm.id === selectedMeasure);
        if (mm) {
            const step = e.shiftKey ? 10 : 3;
            mm.offset = (mm.offset || 0) + (e.key === 'ArrowUp' ? -step : step);
            persist(); render();
        }
        return;
    }
    if (e.key === 'Escape') {
        ghostText = null;
        selected = null; selectedJoint = null; drawing = false; dStart = null; dCur = null;
        moving = false; resizing = false; edgeResizing = null; draggingJoint = false; jointSnapCorner = null;
        hovCorner = null; hovEdge = null; hovCornerEdge = null; chamferPickState = null;
        measurePt1 = null; measureHover = null; selectedMeasure = null;
        render(); updateStatus(); return;
    }
    if (e.key === 'r' || e.key === 'R') setTool('draw');
    if (e.key === 's' || e.key === 'S') setTool('select');
});

// ─────────────────────────────────────────────────────────────
//  Tool switching
// ── Text tool ─────────────────────────────────────────────────
// ghostText = { text, size } while text is floating on cursor waiting to be placed
let ghostText    = null;
let ghostTextPos = { x: 0, y: 0 };

function hitTextItem(mx, my) {
    for (let i = textItems.length - 1; i >= 0; i--) {
        const ti = textItems[i];
        ctx.font = `bold ${ti.size||12}px Raleway,sans-serif`;
        const w = ctx.measureText(ti.text).width + 4;
        const h = (ti.size||12) + 8;
        if (mx >= ti.x - 2 && mx <= ti.x + w && my >= ti.y - 2 && my <= ti.y + h)
            return ti;
    }
    return null;
}

function openTextPopup() {
    hideAllPopups();
    currentPopup = 'text';
    document.getElementById('text-content').value = '';
    const cvRect = cv.getBoundingClientRect();
    showPopupAt(document.getElementById('text-popup'), cvRect.left + cvRect.width/2 - 110, cvRect.top + 40);
    document.getElementById('text-content').focus();
}
function confirmTextPopup() {
    const txt = document.getElementById('text-content').value.trim();
    if (!txt) { hideAllPopups(); setTool('select'); return; }
    const sz = parseInt(document.getElementById('text-size').value) || 12;
    hideAllPopups();
    // Enter "ghost" mode — text follows cursor until user clicks to drop it
    ghostText = { text: txt, size: sz };
    cv.style.cursor = 'crosshair';
    render();
}
document.getElementById('text-ok').addEventListener('click', confirmTextPopup);
document.getElementById('text-cancel').addEventListener('click', () => { hideAllPopups(); setTool('select'); });
document.getElementById('text-content').addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmTextPopup(); }
    if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); setTool('select'); }
    e.stopPropagation();
});

// ─────────────────────────────────────────────────────────────
const TOOL_BTNS = { draw:'btn-draw', ldraw:'btn-ldraw', udraw:'btn-udraw', bsp:'btn-bsp', circle:'btn-circle', select:'btn-select', radius:'btn-radius', edge:'btn-edge', splitedge:'btn-splitedge', joint:'btn-joint', check:'btn-check', polishUnder:'btn-polish-under', sink:'btn-sink', farmsink:'btn-farmsink', cooktop:'btn-cooktop', outlet:'btn-outlet', bocci:'btn-bocci', text:'btn-text', measure:'btn-measure' };
function setTool(t) {
    ghostText = null; // cancel any floating text
    measurePt1 = null; measureHover = null;
    tool = t; selected = null; selectedJoint = null; selectedMeasure = null;
    drawing = false; moving = false; resizing = false; edgeResizing = null; draggingJoint = false; jointSnapCorner = null;
    hovCorner = null; hovEdge = null; hovCornerEdge = null;
    selectedText = null;
    cv.style.cursor = ['draw','ldraw','udraw','bsp','circle','sink','farmsink','cooktop','outlet','bocci','radius','edge','splitedge','joint','check','polishUnder','measure'].includes(t) ? 'crosshair' : 'default';
    document.getElementById('edge-palette').style.display = t === 'edge' ? 'flex' : 'none';
    Object.entries(TOOL_BTNS).forEach(([k,id]) => document.getElementById(id).classList.toggle('active', k === t));
    const labels = { draw:'Draw Rectangle', ldraw:'Draw L-Shape', udraw:'Draw U-Shape', bsp:'Draw Backsplash', circle:'Draw Circle', select:'Select / Move', radius:'Add Radius', edge:'Edge Profile', splitedge:'Split Edge', joint:'Joint Line', check:'Check (notch)', polishUnder:'Polish Under Area', sink:'Sink', farmsink:'Farmhouse Sink (30×16)', cooktop:'Cooktop', outlet:'Outlet (2×4")', bocci:'Bocci Outlet (2" circle)', text:'Add Text', measure:'Outil de Mesure' };
    document.getElementById('st-tool').innerHTML = `Tool: <b>${labels[t]||t}</b>`;
    // Tool-prompt banner: instruction overlay shown when a tool is active
    const prompt = document.getElementById('tool-prompt');
    if (prompt) {
        const promptText = {
            draw:        'Click to add a rectangle',
            ldraw:       'Click to add an L-shape',
            udraw:       'Click to add a U-shape',
            bsp:         'Click to add a backsplash',
            circle:      'Click to add a circle',
            sink:        'Click on a piece to place a sink',
            cooktop:     'Click on a piece to place a cooktop',
            outlet:      'Click on a piece to place an outlet',
            bocci:       'Click on a piece to place a bocci outlet',
            farmsink:    'Click an edge of a piece to place a farmhouse sink',
            radius:      'Click a corner to add a radius',
            edge:        'Click an edge to assign the active profile',
            splitedge:   'Click an edge to add a split point',
            joint:       'Click inside a piece to place a joint line',
            check:       'Click a corner to add a check (notch)',
            polishUnder: 'Click and drag inside a piece to mark a polish-under area',
            text:        'Click anywhere to place a text annotation',
            measure:     'Click two points to measure the distance between them',
        };
        if (promptText[t]) {
            prompt.textContent = promptText[t];
            prompt.style.display = '';
        } else {
            prompt.style.display = 'none';
        }
    }
    render();
}
function deleteSelected() {
    if (selectedPU) {
        const sh = byId(selectedPU.shapeId);
        if (sh && sh.polishUnders) {
            pushUndo();
            sh.polishUnders.splice(selectedPU.idx, 1);
            selectedPU = null;
            persist(); render(); return;
        }
        selectedPU = null;
    }
    if (selectedDiag !== null) {
        pushUndo(); profileDiags = profileDiags.filter(d => d.id !== selectedDiag); selectedDiag = null;
        persist(); render(); return;
    }
    if (selectedFarmSinkShapeId !== null) {
        const s = byId(selectedFarmSinkShapeId);
        if (s && s.farmSink) {
            pushUndo(); s.farmSink = null; selectedFarmSinkShapeId = null;
            persist(); render(); return;
        }
        selectedFarmSinkShapeId = null;
    }
    if (selectedMeasure !== null) {
        pushUndo(); measurements = measurements.filter(m => m.id !== selectedMeasure); selectedMeasure = null;
        persist(); render(); return;
    }
    if (selectedText !== null) {
        pushUndo(); textItems = textItems.filter(t => t.id !== selectedText); selectedText = null;
        persist(); render(); return;
    }
    if (selected === null) return;
    pushUndo(); shapes = shapes.filter(s => s.id !== selected); selected = null;
    persist(); render(); updateStatus();
}
function updateStatus() {
    document.getElementById('st-pieces').innerHTML = `Pieces: <b>${shapes.length}</b>`;
}

// ─────────────────────────────────────────────────────────────
//  Toolbar buttons
// ─────────────────────────────────────────────────────────────
Object.entries(TOOL_BTNS).forEach(([t,id]) => document.getElementById(id).addEventListener('click', () => {
    setTool(t);
    if (t === 'text')   openTextPopup();
    if (t === 'circle') showCirclePopup();
}));
document.getElementById('btn-delete').addEventListener('click', deleteSelected);
document.getElementById('btn-undo').addEventListener('click', undo);

// ─────────────────────────────────────────────────────────────
//  Phase 3 — Right panel form
// ─────────────────────────────────────────────────────────────
const FORM_KEY    = 'spartan_form';
const PRICING_KEY = 'spartan_pricing';
// Shop-global default rates — survive new quote / quote switch.
// Saved alongside per-quote pricingData; used to seed new quotes
// instead of falling back to all-zero DEFAULT_RATES.
const RATES_KEY = 'spartan_rates';
const MATDB_KEY   = 'spartan_matdb';
let formData = { order:'', job:'', client:'', address:'', phones:[''], date:'', notes:'', materials:[] };
let matNextId = 1;
// Material database — master list of materials with prices
let matDb = []; // [{ id, name, supplier, thickness, finish, priceSqft }]
let matDbNextId = 1;

// ── Service rate definitions ─────────────────────────────────
// Each rate has: key, label (Costs tab), desc (Proposal), unit
const SERVICE_RATE_DEFS = [
    { key:'pencil',        label:'Pencil',          desc:'Finition Pencil',                                    unit:'lf' },
    { key:'coupe',         label:'Coupe',           desc:'Coupe du matériel',                                  unit:'sqft' },
    { key:'dektonCoupe',   label:'Dekton Coupe',    desc:'Coupe du matériel',                                  unit:'sqft' },
    { key:'evierOver',     label:'Evier over',      desc:'Trou pour evier sur plan (overmount)',                unit:'each' },
    { key:'evierUnder',    label:'Evier under',     desc:'Trou et polissage pour evier sous plan (undermount)',unit:'each' },
    { key:'evierVasque',   label:'Evier vasque',    desc:'Trou pour lavabo type vasque',                       unit:'each' },
    { key:'cooktop',       label:'Cooktop',         desc:'Trou pour cuisinière (cooktop)',                     unit:'each' },
    { key:'farmSink',      label:'Farmhouse sink',  desc:'Évier farmhouse (intégré)',                          unit:'each' },
    { key:'outlet',        label:'Outlet',          desc:'Outlet (2"×4")',                                     unit:'each' },
    { key:'bocci',         label:'Bocci outlet',    desc:'Bocci outlet (2" rond)',                             unit:'each' },
    { key:'fini45',        label:'Fini 45',         desc:'Finition laminée en 45',                             unit:'lf' },
    { key:'lamine',        label:'Lamine',          desc:'Assemblage des morceaux (Laminage)',                  unit:'lf' },
    { key:'polissageSous', label:'Polissage sous',  desc:'Polissage sous morceau',                             unit:'sqft' },
    { key:'installation',  label:'Installation',    desc:'Installation',                                       unit:'sqft' },
    { key:'measurements',  label:'Measurements',    desc:'Measurements',                                       unit:'flat' },
];
const DEFAULT_RATES = {};
SERVICE_RATE_DEFS.forEach(d => DEFAULT_RATES[d.key] = 0);

// ── Pricing state ─────────────────────────────────────────────
let pricingData = {
    rates: { ...DEFAULT_RATES },
    materialPrices: {},
    polissageSousQty: 0,  // user-entered quantity for polissage sous
};
let pricingNextId = 1;

function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function renderPhones() {
    const div = document.getElementById('phone-rows');
    if (!formData.phones) formData.phones = [''];
    div.innerHTML = formData.phones.map((ph, i) => `<div style="display:flex;gap:3px;align-items:center">
        <input class="fp-input phone-inp" data-i="${i}" type="tel" value="${ph||''}" placeholder="(514) 555-1234" style="flex:1">
        ${formData.phones.length > 1 ? `<span class="cost-remove phone-del" data-i="${i}" style="cursor:pointer;color:#555;font-size:14px">&times;</span>` : ''}
    </div>`).join('');
    div.querySelectorAll('.phone-inp').forEach(inp => inp.addEventListener('input', e => {
        formData.phones[+e.target.dataset.i] = e.target.value; saveForm();
    }));
    div.querySelectorAll('.phone-del').forEach(btn => btn.addEventListener('click', e => {
        formData.phones.splice(+e.target.dataset.i, 1); saveForm(); renderPhones();
    }));
}

function saveForm() {
    formData.order   = document.getElementById('f-order').value;
    formData.job     = document.getElementById('f-job').value;
    formData.client  = document.getElementById('f-client').value;
    formData.address = document.getElementById('f-address').value;
    formData.notes   = document.getElementById('f-notes').value;
    localStorage.setItem(FORM_KEY, JSON.stringify(formData));
    scheduleSyncToRemote();
}

function loadForm() {
    try {
        // TODO: Supabase — fetch form metadata for this quote
        const d = JSON.parse(localStorage.getItem(FORM_KEY));
        if (d) { formData = d; matNextId = (d.materials||[]).reduce((mx,m)=>Math.max(mx,m.id+1),1); }
    } catch(e) {}
    if (!formData.phones) formData.phones = [''];
    if (!formData.address) formData.address = '';
    migrateMaterialTypes();
    document.getElementById('f-order').value   = formData.order   || '';
    document.getElementById('f-job').value     = formData.job     || '';
    document.getElementById('f-client').value  = formData.client  || '';
    document.getElementById('f-address').value = formData.address || '';
    document.getElementById('f-date').value    = formData.date    || todayStr();
    document.getElementById('f-notes').value   = formData.notes   || '';
    if (!formData.date) { formData.date = todayStr(); saveForm(); }
    renderPhones();
    renderMaterials();
}

// Wire main field auto-save
['f-order','f-job','f-client','f-address','f-date','f-notes'].forEach(id =>
    document.getElementById(id).addEventListener('input', saveForm));
document.getElementById('add-phone-btn').addEventListener('click', () => {
    formData.phones.push(''); saveForm(); renderPhones();
});

// ── Material rows ────────────────────────────────────────────
function matHtml(m) {
    // Get unique brands
    const brands = [...new Set(matDb.map(d => d.supplier).filter(Boolean))].sort();
    const selBrand = (m.dbId ? (matDb.find(d=>d.id===m.dbId)||{}).supplier : '') || m._brand || m.supplier || '';
    // Resilience: if the stored brand isn't in the catalog (e.g., catalog not yet loaded),
    // add it to the options so the selection is visually preserved.
    const brandOpts = [...new Set([...brands, selBrand].filter(Boolean))].sort();
    // Colors for selected brand (alphabetical)
    const colors = selBrand ? matDb.filter(d => d.supplier === selBrand).sort((a,b) => (a.name||'').localeCompare(b.name||'')) : [];
    const selDbId = m.dbId || 0;
    const linked = matDb.find(d => d.id === selDbId);
    // If we have a stored color name but the catalog entry isn't present (stale matDb),
    // keep the stored color visible in the color dropdown as a fallback option.
    const fallbackColorOpt = (!linked && selDbId && m.color)
        ? `<option value="${selDbId}" selected>${m.color}</option>`
        : '';
    // Finishes + thicknesses from linked color
    const availFinishes = linked ? [...(linked.finishes||[])].sort() : [];
    const availThick = linked ? [...(linked.thicknesses||[])].sort() : [];
    const selFinish = m.finish || (availFinishes[0]||'');
    const selThick = m.thickness || (availThick[availThick.length-1]||'');
    const slabStr = linked ? `${linked.slabW||'?'}" × ${linked.slabH||'?'}"` : '';
    const costStr = linked ? `Cost/slab: ${linked.costPerSlab ? fmt$(linked.costPerSlab) : 'not set'}` : '';

    const selType = (m.type === 'option' || m.type === 'page') ? m.type : 'page';
    const optionPlaceholder = `Option ${getOptionLetter(m)} (editable)`;
    // Build the Label control: page selector for Page type, editable text for Option
    let labelControl;
    if (selType === 'page') {
        labelControl = `<select class="mat-input mat-page-sel" data-mid="${m.id}" style="width:100%">
            <option value="">— Select page —</option>
            ${pages.map(p => `<option value="${p.id}" ${m.pageId === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>`;
    } else {
        labelControl = `<input class="mat-input mat-label-inp" data-mid="${m.id}" type="text" style="width:100%" value="${(m.label||'').replace(/"/g,'&quot;')}" placeholder="${optionPlaceholder}">`;
    }
    const labelHdr = selType === 'page' ? 'Page (canvas tab)' : 'Label';
    return `<div class="mat-row" id="mat-${m.id}">
        <button class="mat-remove" onclick="removeMaterial(${m.id})" title="Remove">×</button>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px">
            <div style="flex:1;min-width:80px"><span class="mat-lbl">Type</span>
                <select class="mat-input mat-type-sel" data-mid="${m.id}" style="width:100%">
                    <option value="page"   ${selType==='page'  ?'selected':''}>Page</option>
                    <option value="option" ${selType==='option'?'selected':''}>Option</option>
                </select></div>
            <div style="flex:2;min-width:120px"><span class="mat-lbl">${labelHdr}</span>
                ${labelControl}
            </div>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
            <div style="flex:1;min-width:80px"><span class="mat-lbl">Brand</span>
                <select class="mat-input mat-brand-sel" data-mid="${m.id}" style="width:100%">
                    <option value="">— Brand —</option>
                    ${brandOpts.map(b => `<option value="${b}" ${b===selBrand?'selected':''}>${b}</option>`).join('')}
                </select></div>
            <div style="flex:2;min-width:120px"><span class="mat-lbl">Color</span>
                <select class="mat-input mat-color-sel" data-mid="${m.id}" style="width:100%">
                    <option value="0">— Color —</option>
                    ${fallbackColorOpt}
                    ${colors.map(c => `<option value="${c.id}" ${c.id===selDbId?'selected':''}>${c.name}</option>`).join('')}
                </select></div>
        </div>
        ${linked ? `<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">
            <div style="flex:1"><span class="mat-lbl">Finish</span>
                <select class="mat-input mat-finish-sel" data-mid="${m.id}" style="width:100%">
                    ${availFinishes.map(f => `<option value="${f}" ${f===selFinish?'selected':''}>${f}</option>`).join('')}
                </select></div>
            <div style="flex:1"><span class="mat-lbl">Thickness</span>
                <select class="mat-input mat-thick-sel" data-mid="${m.id}" style="width:100%">
                    ${availThick.map(t => `<option value="${t}" ${t===selThick?'selected':''}>${t}</option>`).join('')}
                </select></div>
        </div>
        <div style="color:#999;font-size:9px;margin-top:3px;padding-left:2px">
            ${linked.name} · ${slabStr} · ${costStr}
        </div>` : ''}
    </div>`;
}

function renderMaterials() {
    document.getElementById('mat-rows').innerHTML =
        (formData.materials||[]).map(matHtml).join('');
    // Type dropdown
    document.querySelectorAll('.mat-type-sel').forEach(sel => sel.addEventListener('change', e => {
        const m = formData.materials.find(m => m.id === +e.target.dataset.mid);
        if (!m) return;
        m.type = e.target.value;
        if (m.type === 'option') {
            // Switching to Option — set default label if empty or a page name
            m.pageId = null;
            if (!m.label || /^Option [A-Z]$/.test(m.label)) m.label = `Option ${getOptionLetter(m)}`;
        } else if (m.type === 'page') {
            // Switching to Page — auto-link to current page if no link exists
            if (m.pageId == null) {
                const curPage = pages[currentPageIdx] || pages[0];
                m.pageId = curPage ? curPage.id : null;
                m.label = curPage ? curPage.name : '';
            } else {
                const p = pages.find(pg => pg.id === m.pageId);
                if (p) m.label = p.name;
            }
        }
        saveForm(); renderMaterials(); renderPricingPanel();
    }));
    // Page selector (for type=page)
    document.querySelectorAll('.mat-page-sel').forEach(sel => sel.addEventListener('change', e => {
        const m = formData.materials.find(m => m.id === +e.target.dataset.mid);
        if (!m) return;
        const pid = +e.target.value;
        m.pageId = pid || null;
        const p = pages.find(pg => pg.id === pid);
        m.label = p ? p.name : '';
        saveForm(); renderPricingPanel();
    }));
    // Label input — for Option type (editable free text)
    document.querySelectorAll('.mat-label-inp').forEach(inp => inp.addEventListener('input', e => {
        const m = formData.materials.find(m => m.id === +e.target.dataset.mid);
        if (!m) return;
        m.label = e.target.value;
        saveForm(); renderPricingPanel();
    }));
    // Bind cascading dropdowns
    document.querySelectorAll('.mat-brand-sel').forEach(sel => sel.addEventListener('change', e => {
        const m = formData.materials.find(m => m.id === +e.target.dataset.mid);
        if (m) { m._brand = e.target.value; m.dbId = null; m.color = ''; m.finish = ''; m.thickness = ''; saveForm(); renderMaterials(); }
    }));
    document.querySelectorAll('.mat-color-sel').forEach(sel => sel.addEventListener('change', e => {
        const mid = +e.target.dataset.mid;
        const dbId = +e.target.value;
        linkMat(mid, dbId);
    }));
    document.querySelectorAll('.mat-finish-sel').forEach(sel => sel.addEventListener('change', e => {
        const m = formData.materials.find(m => m.id === +e.target.dataset.mid);
        if (m) { m.finish = e.target.value; saveForm(); }
    }));
    document.querySelectorAll('.mat-thick-sel').forEach(sel => sel.addEventListener('change', e => {
        const m = formData.materials.find(m => m.id === +e.target.dataset.mid);
        if (m) { m.thickness = e.target.value; saveForm(); }
    }));
}

function addMaterial() {
    // Default new materials to 'page' type, auto-linked to the current canvas page
    const curPage = (pages && pages[currentPageIdx]) || (pages && pages[0]);
    const m = {
        id: matNextId++,
        color:'', supplier:'', thickness:'3cm', finish:'Polished',
        type: 'page',
        pageId: curPage ? curPage.id : null,
        label: curPage ? curPage.name : ''
    };
    formData.materials.push(m);
    saveForm(); renderMaterials();
    // Focus first input of the new row
    const row = document.getElementById(`mat-${m.id}`);
    if (row) { const inp = row.querySelector('input'); if (inp) inp.focus(); }
}

// Helper: auto-assign Option letters (A, B, C…) based on ordinal position among Options
function getOptionLetter(mat) {
    const mats = formData.materials || [];
    const options = mats.filter(mm => (mm.type||'page') === 'option');
    const idx = options.findIndex(mm => mm.id === mat.id);
    return idx >= 0 ? String.fromCharCode(65 + idx) : '?';
}
// Resolve a Page-type material's linked page (by pageId, falling back to label==name)
function getLinkedPage(mat) {
    if (!mat) return null;
    if (mat.pageId != null) {
        const p = pages.find(pg => pg.id === mat.pageId);
        if (p) return p;
    }
    if (mat.label) {
        const p = pages.find(pg => pg.name === mat.label);
        if (p) return p;
    }
    return null;
}
function defaultLabelForType(mat) {
    const t = mat.type || 'page';
    if (t === 'option') return `Option ${getOptionLetter(mat)}`;
    if (t === 'page')   {
        const p = getLinkedPage(mat);
        return p ? p.name : 'Page';
    }
    return '';
}

// Migrate legacy materials: 'zone' type → 'page' type, auto-link to first page
function migrateMaterialTypes() {
    if (!formData.materials || !pages || !pages.length) return;
    let changed = false;
    for (const m of formData.materials) {
        const t = m.type || '';
        if (t === '' || t === 'zone') {
            m.type = 'page';
            if (m.pageId == null) m.pageId = pages[0].id;
            m.label = (pages.find(p => p.id === m.pageId) || pages[0]).name;
            changed = true;
        } else if (t === 'page' && m.pageId == null) {
            // Page-type with no pageId — try to resolve via label, else default to first page
            const byName = pages.find(p => p.name === m.label);
            m.pageId = byName ? byName.id : pages[0].id;
            if (!byName) m.label = pages[0].name;
            changed = true;
        }
    }
    if (changed) saveForm();
}

function removeMaterial(id) {
    formData.materials = formData.materials.filter(m => m.id !== id);
    saveForm(); renderMaterials();
}

function updateMat(id, field, val) {
    const m = formData.materials.find(m => m.id === id);
    if (m) { m[field] = val; saveForm(); }
}
function linkMat(matId, dbId) {
    const m = formData.materials.find(m => m.id === matId);
    if (!m) return;
    const db = matDb.find(d => d.id === dbId);
    if (db) {
        m.dbId = db.id;
        m._brand = db.supplier;
        m.color = db.name;
        m.supplier = db.supplier;
        m.finish = (db.finishes||[])[0] || '';
        m.thickness = (db.thicknesses||[])[(db.thicknesses||[]).length-1] || '';
        m.slabW = db.slabW || 0;
        m.slabH = db.slabH || 0;
    } else {
        m.dbId = null;
    }
    saveForm(); renderMaterials();
}

document.getElementById('add-mat-btn').addEventListener('click', addMaterial);

// ── Material Database ───────────────────────────────────────
function saveMatDb() { localStorage.setItem(MATDB_KEY, JSON.stringify(matDb)); scheduleSyncToRemote(); }
function loadMatDb() {
    try {
        // TODO: Supabase — fetch material catalog
        const d = JSON.parse(localStorage.getItem(MATDB_KEY));
        if (d && Array.isArray(d) && d.length > 100 && Array.isArray(d[0].thicknesses)) {
            matDb = d;
            matDbNextId = matDb.reduce((mx, m) => Math.max(mx, m.id + 1), 1);
            return;
        }
    } catch(e) {}
    // Seed: full multi-brand stone catalog (350 colours)
    // Shortcuts: P=Polished, M=Matte, t23=2cm+3cm, t123=1.2cm+2cm+3cm, d08=0.8cm+1.2cm+2cm
    const P=['Polished'],M=['Matte'],t23=['2cm','3cm'],t123=['1.2cm','2cm','3cm'],d08=['0.8cm','1.2cm','2cm'];
    function cm2in(w,h){return[Math.round(w/2.54),Math.round(h/2.54)];}
    let _id=1;
    function e(n,s,t,f,w,h){return{id:_id++,name:n,supplier:s,thicknesses:t,finishes:f,slabW:w,slabH:h,costPerSlab:0};}
    // ── SILESTONE (66) ──
    const SL='Silestone',SW=129,SH=63;
    matDb=[
    e('Calacatta Tova',SL,t23,P,SW,SH),e('Calacatta Themis',SL,t123,P,SW,SH),e('Bronze Rivers',SL,t23,P,SW,SH),
    e('Persian White',SL,t23,P,SW,SH),e('Motion Grey',SL,t23,P,SW,SH),e('Linen Cream',SL,t23,P,SW,SH),
    e('Siberian',SL,t23,P,SW,SH),e('Blanc Élysée',SL,t123,P,SW,SH),e('Jardin Emerald',SL,t23,P,SW,SH),
    e('Rivière Rose',SL,t23,P,SW,SH),e('Château Brown',SL,t23,P,SW,SH),e('Eclectic Pearl',SL,t23,P,SW,SH),
    e('Versailles Ivory',SL,t23,P,SW,SH),e('Bohemian Flame',SL,t23,P,SW,SH),e('Victorian Silver',SL,t23,P,SW,SH),
    e('Parisien Bleu',SL,t23,P,SW,SH),e('Romantic Ash',SL,t23,P,SW,SH),e('Ffrom03',SL,t23,P,SW,SH),
    e('Ffrom02',SL,t23,P,SW,SH),e('Raw A',SL,t23,P,SW,SH),e('Raw D',SL,t23,P,SW,SH),e('Raw G',SL,t23,P,SW,SH),
    e('Ffrom01',SL,t23,P,SW,SH),e('Lime Delight',SL,t23,P,SW,SH),e('Concrete Pulse',SL,t23,P,SW,SH),
    e('Cinder Craze',SL,['3cm'],P,SW,SH),e('Brass Relish',SL,t23,P,SW,SH),e('Ethereal Glow',SL,t123,P,SW,SH),
    e('Ethereal Dusk',SL,t123,P,SW,SH),e('Ethereal Haze',SL,t123,P,SW,SH),e('Ethereal Noctis',SL,t123,P,SW,SH),
    e('Cala Blue',SL,['2cm'],P,120,56),e('Miami Vena',SL,t123,P,SW,SH),e('Poblenou',SL,t23,P,SW,SH),
    e('Et Dor',SL,t23,P,SW,SH),e('Nolita',SL,t23,P,SW,SH),e('Et Bella',SL,t23,P,SW,SH),
    e('Ocean Storm',SL,t23,P,SW,SH),e('Desert Silver',SL,t23,P,SW,SH),e('Night Tebas',SL,t23,P,SW,SH),
    e('Bianco Calacatta',SL,t123,P,SW,SH),e('Pietra',SL,t23,P,SW,SH),e('Pearl Jasmine',SL,t23,P,SW,SH),
    e('Classic Calacatta',SL,t123,P,SW,SH),e('Charcoal Soapstone',SL,t23,P,SW,SH),e('Et Marquina',SL,t23,P,SW,SH),
    e('Et Calacatta Gold',SL,t123,P,SW,SH),e('Et Statuario',SL,t123,P,SW,SH),e('Ocean Jasper F',SL,t23,P,SW,SH),
    e('Miami White',SL,t123,P,SW,SH),e('Lusso',SL,t23,P,SW,SH),e('Copper Mist',SL,t23,P,SW,SH),
    e('Coral Clay',SL,t23,P,SW,SH),e('Calypso',SL,t23,P,SW,SH),e('Blanco Maple',SL,t123,P,SW,SH),
    e('Blanco Norte',SL,t123,P,SW,SH),e('White Storm',SL,t123,P,SW,SH),e('Blanco City',SL,t123,P,SW,SH),
    e('Stellar Blanco',SL,t123,P,SW,SH),e('Helix',SL,t23,P,SW,SH),e('Lyra',SL,t23,P,SW,SH),
    e('Lagoon',SL,t23,P,SW,SH),e('Yukon',SL,t23,P,SW,SH),e('Gris Expo',SL,t23,P,SW,SH),
    e('White Zeus',SL,t23,P,SW,SH),e('Marengo',SL,t23,P,SW,SH),
    // ── DEKTON (57) ──
    e('Zira','Dekton',d08,M,...cm2in(327,147)),e('Kedar','Dekton',d08,M,...cm2in(322,145)),
    e('Nara','Dekton',d08,['Velvet'],...cm2in(336,167)),e('Kovik','Dekton',d08,M,...cm2in(321,144)),
    e('Aeris','Dekton',d08,['Matte','Grip+'],...cm2in(336,167)),e('Rem','Dekton',d08,['Velvet'],...cm2in(336,167)),
    e('Laurent','Dekton',d08,M,...cm2in(332,166)),e('Bromo','Dekton',d08,M,...cm2in(322,145)),
    e('Kira','Dekton',d08,M,...cm2in(322,145)),e('Opera','Dekton',d08,['Velvet'],...cm2in(327,147)),
    e('Entzo22','Dekton',d08,M,...cm2in(336,167)),e('Kelya','Dekton',d08,M,...cm2in(332,166)),
    e('Aura','Dekton',d08,M,...cm2in(327,147)),e('Danae','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),
    e('Adia','Dekton',d08,M,...cm2in(327,147)),e('Polar','Dekton',d08,['Matte','Grip+'],...cm2in(328,148)),
    e('Nebu','Dekton',d08,M,...cm2in(327,147)),e('Trevi','Dekton',d08,M,...cm2in(328,148)),
    e('Ava','Dekton',d08,M,...cm2in(327,147)),e('Sabbia','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),
    e('Avorio','Dekton',d08,M,...cm2in(327,147)),e('Grigio','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),
    e('Sandik','Dekton',d08,['Grip+','Velvet'],...cm2in(336,167)),e('Marmorio','Dekton',d08,M,...cm2in(336,167)),
    e('Nebbia','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),e('Limbo','Dekton',d08,P,...cm2in(336,167)),
    e('Ceppo','Dekton',d08,M,...cm2in(327,147)),e('Grafite','Dekton',d08,['Matte','Grip+'],...cm2in(322,145)),
    e('Salina','Dekton',d08,P,...cm2in(336,167)),e('Marina','Dekton',d08,['Velvet'],...cm2in(336,167)),
    e('Malibu','Dekton',d08,P,...cm2in(327,147)),e('Umber','Dekton',d08,M,...cm2in(322,145)),
    e('Albarium','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),e('Nacre','Dekton',d08,['Grip+','Velvet'],...cm2in(327,147)),
    e('Somnia','Dekton',d08,M,...cm2in(332,166)),e('Awake','Dekton',d08,P,...cm2in(336,167)),
    e('Trance','Dekton',d08,P,...cm2in(336,167)),e('Morpheus','Dekton',d08,['Velvet'],...cm2in(336,167)),
    e('Lucid','Dekton',d08,P,...cm2in(336,167)),e('Neural','Dekton',d08,['Velvet'],...cm2in(336,167)),
    e('Daze','Dekton',['0.8cm'],['Velvet'],...cm2in(336,167)),e('Argentium','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),
    e('Helena','Dekton',d08,P,...cm2in(336,167)),e('Khalo','Dekton',d08,P,...cm2in(336,167)),
    e('Taga','Dekton',d08,P,...cm2in(336,167)),e('Arga','Dekton',d08,P,...cm2in(336,167)),
    e('Lunar','Dekton',d08,['Matte','Grip+'],...cm2in(327,147)),e('Kreta','Dekton',d08,['Matte','Grip+'],...cm2in(332,166)),
    e('Soke','Dekton',d08,M,...cm2in(321,144)),e('Laos','Dekton',d08,M,...cm2in(300,100)),
    e('Natura','Dekton',d08,P,...cm2in(336,167)),e('Trilium','Dekton',d08,M,...cm2in(332,166)),
    e('Bergen','Dekton',d08,P,...cm2in(336,167)),e('Keon','Dekton',d08,['Matte','Grip+'],...cm2in(322,145)),
    e('Sirius','Dekton',d08,M,...cm2in(322,145)),e('Domoos','Dekton',d08,M,...cm2in(321,144)),
    e('Zenith','Dekton',d08,M,...cm2in(327,147)),
    // ── CAESARSTONE (50) ──
    ...[['1111 Vivid White'],['1141 Pure White'],['2003 Concrete'],['2141 Blizzard'],['3100 Jet Black'],
    ['4001 Fresh Concrete'],['4003 Sleek Concrete'],['4004 Raw Concrete'],['4011 Cloudburst Concrete'],
    ['4030 Stone Grey'],['4033 Rugged Concrete'],['4043 Primordia'],['4044 Airy Concrete'],['4120 Raven'],
    ['4141 Misty Carrera'],['4600 Organic White'],['4601 Frozen Terra'],['5000 London Grey'],
    ['5003 Piatra Grey'],['5031 Statuario Maximus'],['5100 Vanilla Noir'],['5101 Empira Black'],
    ['5110 Alpine Mist'],['5111 Statuario Nuvo'],['5112 Aterra Blanca'],['5113 Solenna'],
    ['5130 Cosmopolitan White'],['5131 Calacatta Nuvo'],['5133 Symphony Grey'],['5140 Dreamy Carrara'],
    ['5141 Frosty Carrina'],['5143 White Attica'],['5151 Empira White'],['5212 Taj Royale'],
    ['5310 Brillianza'],['5810 Black Tempal'],['5820 Darcrest'],['6003 Coastal Grey'],
    ['6046 Moorland Fog'],['6131 Bianco Drift'],['6134 Georgian Bluffs'],['6141 Ocean Foam'],
    ['6270 Atlantic Salt'],['6313 Turbine Grey'],['6600 Nougat'],['6611 Himalayan Moon'],
    ['9141 Ice Snow'],['110 Whitenna'],['502 Sleet'],['503 Circa']].map(([n])=>e(n,'Caesarstone',t23,P,128,65)),
    // ── HANSTONE (57) ──
    ...['Ajanta','Serengeti','Artisan Grey','Takoda','Blackburn','Tofino','Leaden','Venetian Avorio','Pewter','Victorian Sands','Rocky Shores',
    'Aramis','Odyssey','Aspen','Silhouette','Auburn Abyss','Specchio White','Aurora Snow','Sterling Grey','Bavaria','Swan Cotton','Bianco Canvas','Tiffany Grey','Black Coral','Uptown Grey','Metropolitan',
    'Brava Marfil','Classic Statue','Rolling Stone','Fusion','Serenity','Grigio','Smoke','Indian Pearl','Tranquility','Italian Waves','Ivory Wave','Walnut Luster','Mercer','Whistler',
    'Aura','Oceana','Campina','Sedona','Empress',
    'Chantilly','Soho','Montauk','Yorkville','Monterey',
    'Markina','Cremosa','Whistler Gold','Tahitian Cream','Avora','Royale Blanc','Calacatta Extra'].map(n=>e(n,'Hanstone',t23,P,126,63)),
    // ── MSI Q PREMIUM QUARTZ (120) ──
    ...['Alabaster White','Arctic White','Aruca White','AuraTaj','Azurmatt','Babylon Gray','Bayshore Sand','Bianco Pepper',
    'Blanca Arabescato','Blanca Statuarietto','Calacatta Abezzo','Calacatta Adonia','Calacatta Aidana','Calacatta Alto',
    'Calacatta Anava','Calacatta Aravine','Calacatta Arno','Calacatta Azulean','Calacatta Bali','Calacatta Belaros',
    'Calacatta Botanica','Calacatta Castana','Calacatta Cinela','Calacatta Classique','Calacatta Delios','Calacatta Duolina',
    'Calacatta Elysio','Calacatta Fioressa','Calacatta Goa','Calacatta Idillio','Calacatta Izaro','Calacatta Jadira',
    'Calacatta Karmelo','Calacatta Lapiza','Calacatta Lavasa','Calacatta Laza','Calacatta Laza Grigio','Calacatta Laza Oro',
    'Calacatta Leon','Calacatta Luccia','Calacatta Lumanyx','Calacatta Miraggio','Calacatta Miraggio Cielo',
    'Calacatta Miraggio Cove','Calacatta Miraggio Duo','Calacatta Miraggio Gold','Calacatta Miraggio Honed',
    'Calacatta Miraggio Lusso','Calacatta Miraggio SeaGlass','Calacatta Monaco','Calacatta Ocellio','Calacatta Prado',
    'Calacatta Premata','Calacatta Rivessa','Calacatta Rusta','Calacatta Safyra','Calacatta Sierra','Calacatta Solessio',
    'Calacatta Trevi','Calacatta Ultra','Calacatta Valentin','Calacatta Vernello','Calacatta Verona','Calacatta Versailles',
    'Calacatta Vicenza','Calacatta Viraldi','Calico White','Carrara Breve','Carrara Delphi','Carrara Lumos','Carrara Marmi',
    'Carrara Miksa','Carrara Mist','Carrara Morro','Carrara Trigato','Cashmere Taj','Chakra Beige','Concerto','Eroluna',
    'Fairy White','Fossil Gray','Frost White','Galant Gray','Glacier White','Gray Lagoon','Iced Gray','Iced White',
    'IvoriTaj','LumaTaj','Macabo Gray','Manhattan Gray','MarfiTaj','Marquina Midnight','Meridian Gray','Midnight Corvo',
    'Midnight Majesty','Montclair White','New Calacatta Laza','New Calacatta Laza Gold','New Carrara Marmi',
    'Peppercorn White','Perla White','Portico Cream','Premium Plus White','Smoked Pearl','Snow White',
    'Soapstone Metropolis','Soapstone Mist','SoliTaj','Sparkling Black','Sparkling White','Statuary Classique',
    'Stellar White','TravatTaj'].map(n=>e(n,'MSI',t23,P,126,63)),
    ];
    matDbNextId = _id;
    saveMatDb();
}
// Stone types that appear in the matdb dropdown
const STONE_TYPES = ['Quartz','Granite','Marble','Quartzite','Sintered Stone'];
const STANDARD_FINISHES     = ['Polished','Matte','Honed','Leathered','Velvet','Grip+','Satin','Brushed'];
const STANDARD_THICKNESSES  = ['0.8cm','1.2cm','2cm','3cm'];

// Union of all finishes / thicknesses known across matDb + the standard starters
function allKnownFinishes() {
    const s = new Set(STANDARD_FINISHES);
    for (const m of matDb) (m.finishes || []).forEach(f => s.add(f));
    return [...s];
}
function allKnownThicknesses() {
    const s = new Set(STANDARD_THICKNESSES);
    for (const m of matDb) (m.thicknesses || []).forEach(t => s.add(t));
    // Sort numerically by the "cm" prefix number
    return [...s].sort((a, b) => parseFloat(a) - parseFloat(b));
}

function renderMatDb() {
    const container = document.getElementById('matdb-rows');
    if (!container) return;
    if (!matDb.length) {
        container.innerHTML = '<p class="price-internal-note" style="margin:0">No materials in database yet.</p>';
        return;
    }
    const allF = allKnownFinishes();
    const allT = allKnownThicknesses();
    const sorted = [...matDb].sort((a,b) => (a.supplier||'').localeCompare(b.supplier||'') || (a.name||'').localeCompare(b.name||''));
    container.innerHTML = sorted.map(m => {
        const selF = new Set(m.finishes || []);
        const selT = new Set(m.thicknesses || []);
        return `<div class="mat-row" data-dbid="${m.id}" style="padding:6px 8px">
            <button class="mat-remove matdb-remove" data-dbid="${m.id}" title="Remove">×</button>
            <!-- Row 1: name + brand + stone type -->
            <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap">
                <input class="mat-input matdb-field" data-dbid="${m.id}" data-field="name" style="flex:1;min-width:100px" value="${(m.name||'').replace(/"/g,'&quot;')}" placeholder="Color name">
                <input class="mat-input matdb-field" data-dbid="${m.id}" data-field="supplier" style="width:90px" value="${(m.supplier||'').replace(/"/g,'&quot;')}" placeholder="Brand">
                <select class="mat-input matdb-field" data-dbid="${m.id}" data-field="stoneType" style="width:120px">
                    <option value="">— Type —</option>
                    ${STONE_TYPES.map(t => `<option value="${t}" ${m.stoneType===t?'selected':''}>${t}</option>`).join('')}
                </select>
            </div>
            <!-- Row 2: cost + slab size -->
            <div style="display:flex;gap:5px;margin-top:4px;align-items:center;flex-wrap:wrap">
                <span class="mat-lbl" style="margin:0;white-space:nowrap">Cost/slab $</span>
                <input class="mat-input matdb-field" data-dbid="${m.id}" data-field="costPerSlab" type="text" inputmode="decimal" style="width:70px" value="${m.costPerSlab||''}" placeholder="0">
                <span class="mat-lbl" style="margin:0;margin-left:8px">Slab</span>
                <input class="mat-input matdb-field" data-dbid="${m.id}" data-field="slabW" type="text" inputmode="numeric" style="width:45px" value="${m.slabW||''}" placeholder="W">
                <span style="color:#777;font-size:10px">×</span>
                <input class="mat-input matdb-field" data-dbid="${m.id}" data-field="slabH" type="text" inputmode="numeric" style="width:45px" value="${m.slabH||''}" placeholder="H">
                <span style="color:#777;font-size:9px">in</span>
            </div>
            <!-- Row 3: thickness checkboxes + add custom -->
            <div style="display:flex;gap:6px;margin-top:5px;align-items:center;flex-wrap:wrap">
                <span class="mat-lbl" style="margin:0;min-width:55px">Thickness</span>
                ${allT.map(t => `<label style="display:flex;align-items:center;gap:3px;font-size:10px;color:#ccc;cursor:pointer;padding:2px 5px;background:#1a1a1a;border:1px solid ${selT.has(t)?'#b09030':'#333'};border-radius:3px">
                    <input type="checkbox" class="matdb-thk" data-dbid="${m.id}" data-value="${t}" ${selT.has(t)?'checked':''} style="cursor:pointer;margin:0">
                    ${t}
                </label>`).join('')}
                <button class="matdb-add-thk" data-dbid="${m.id}" style="padding:2px 7px;background:#2a2a2a;color:#b09030;border:1px dashed #555;border-radius:3px;font-size:10px;cursor:pointer">+ custom</button>
            </div>
            <!-- Row 4: finish checkboxes + add custom -->
            <div style="display:flex;gap:6px;margin-top:5px;align-items:center;flex-wrap:wrap">
                <span class="mat-lbl" style="margin:0;min-width:55px">Finish</span>
                ${allF.map(f => `<label style="display:flex;align-items:center;gap:3px;font-size:10px;color:#ccc;cursor:pointer;padding:2px 5px;background:#1a1a1a;border:1px solid ${selF.has(f)?'#b09030':'#333'};border-radius:3px">
                    <input type="checkbox" class="matdb-fin" data-dbid="${m.id}" data-value="${f.replace(/"/g,'&quot;')}" ${selF.has(f)?'checked':''} style="cursor:pointer;margin:0">
                    ${f}
                </label>`).join('')}
                <button class="matdb-add-fin" data-dbid="${m.id}" style="padding:2px 7px;background:#2a2a2a;color:#b09030;border:1px dashed #555;border-radius:3px;font-size:10px;cursor:pointer">+ custom</button>
            </div>
        </div>`;
    }).join('');
    const numFields = ['costPerSlab','slabW','slabH'];
    container.querySelectorAll('.matdb-field').forEach(inp => inp.addEventListener('input', e => {
        const db = matDb.find(m => m.id === +e.target.dataset.dbid);
        if (db) { db[e.target.dataset.field] = numFields.includes(e.target.dataset.field) ? (parseFloat(e.target.value)||0) : e.target.value; saveMatDb(); }
    }));
    container.querySelectorAll('.matdb-remove').forEach(btn => btn.addEventListener('click', e => {
        matDb = matDb.filter(m => m.id !== +e.target.dataset.dbid);
        saveMatDb(); renderMatDb();
    }));
    // Thickness checkbox toggles
    container.querySelectorAll('.matdb-thk').forEach(cb => cb.addEventListener('change', e => {
        const db = matDb.find(m => m.id === +e.target.dataset.dbid);
        if (!db) return;
        db.thicknesses = db.thicknesses || [];
        const v = e.target.dataset.value;
        if (e.target.checked) { if (!db.thicknesses.includes(v)) db.thicknesses.push(v); }
        else db.thicknesses = db.thicknesses.filter(x => x !== v);
        saveMatDb(); renderMatDb();
    }));
    // Finish checkbox toggles
    container.querySelectorAll('.matdb-fin').forEach(cb => cb.addEventListener('change', e => {
        const db = matDb.find(m => m.id === +e.target.dataset.dbid);
        if (!db) return;
        db.finishes = db.finishes || [];
        const v = e.target.dataset.value;
        if (e.target.checked) { if (!db.finishes.includes(v)) db.finishes.push(v); }
        else db.finishes = db.finishes.filter(x => x !== v);
        saveMatDb(); renderMatDb();
    }));
    // Add custom thickness / finish
    container.querySelectorAll('.matdb-add-thk').forEach(btn => btn.addEventListener('click', e => {
        const db = matDb.find(m => m.id === +e.target.dataset.dbid);
        if (!db) return;
        const raw = prompt('Add a custom thickness (e.g. 2cm, 1.2cm, 6cm):');
        if (!raw) return;
        const v = raw.trim();
        if (!v) return;
        db.thicknesses = db.thicknesses || [];
        if (!db.thicknesses.includes(v)) db.thicknesses.push(v);
        saveMatDb(); renderMatDb();
    }));
    container.querySelectorAll('.matdb-add-fin').forEach(btn => btn.addEventListener('click', e => {
        const db = matDb.find(m => m.id === +e.target.dataset.dbid);
        if (!db) return;
        const raw = prompt('Add a custom finish (e.g. Leathered, Satin, Anticato):');
        if (!raw) return;
        const v = raw.trim();
        if (!v) return;
        db.finishes = db.finishes || [];
        if (!db.finishes.includes(v)) db.finishes.push(v);
        saveMatDb(); renderMatDb();
    }));
}
// ── Add Material popup flow ──────────────────────────────────────
// Picked thicknesses/finishes for the popup are tracked in these Sets
// so a "+ Custom" button can append to the chip group without losing
// the user's other selections.
let _matdbPopThk = new Set();
let _matdbPopFin = new Set();

function _matdbPopRenderChips(grpId, allValues, selected, allowAddNew) {
    const grp = document.getElementById(grpId);
    if (!grp) return;
    const accent = '#b09030';
    const chipHtml = allValues.map(v => {
        const on = selected.has(v);
        return `<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:#ccc;cursor:pointer;padding:4px 9px;background:#1a1a1a;border:1px solid ${on?accent:'#444'};border-radius:3px">
            <input type="checkbox" data-val="${v.replace(/"/g,'&quot;')}" ${on?'checked':''} style="cursor:pointer;margin:0">
            ${v}
        </label>`;
    }).join('');
    const addBtn = allowAddNew
        ? `<button type="button" data-add="${grpId}" style="padding:4px 10px;background:#2a2a2a;color:${accent};border:1px dashed #555;border-radius:3px;font-size:12px;cursor:pointer;font-family:Raleway,sans-serif">+ Custom</button>`
        : '';
    grp.innerHTML = chipHtml + addBtn;
    // Wire checkboxes
    grp.querySelectorAll('input[type=checkbox]').forEach(inp => {
        inp.addEventListener('change', e => {
            const v = e.target.dataset.val;
            if (e.target.checked) selected.add(v); else selected.delete(v);
            // Re-render so the chip border updates
            _matdbPopRenderChips(grpId, allValues, selected, allowAddNew);
        });
    });
    // Wire add-new button
    if (allowAddNew) {
        const btn = grp.querySelector('button[data-add]');
        if (btn) btn.addEventListener('click', () => {
            const v = (prompt(grpId === 'matdb-pop-finish-grp' ? 'New finish name:' : 'New value:') || '').trim();
            if (!v) return;
            if (!allValues.includes(v)) allValues.push(v);
            selected.add(v);
            _matdbPopRenderChips(grpId, allValues, selected, allowAddNew);
        });
    }
}

function _matdbPopPopulateBrand() {
    const sel = document.getElementById('matdb-pop-supplier');
    const brands = [...new Set(matDb.map(d => d.supplier).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">— Select brand —</option>'
        + brands.map(b => `<option value="${b.replace(/"/g,'&quot;')}">${b}</option>`).join('')
        + '<option value="__NEW__">+ New brand…</option>';
    sel.value = '';
    sel.onchange = () => {
        if (sel.value === '__NEW__') {
            const v = (prompt('New brand name:') || '').trim();
            if (v) {
                const opt = document.createElement('option');
                opt.value = v; opt.textContent = v;
                // Insert before the "+ New brand…" option
                sel.insertBefore(opt, sel.options[sel.options.length - 1]);
                sel.value = v;
            } else {
                sel.value = '';
            }
        }
    };
}

function openMatdbPopup() {
    hideAllPopups();
    currentPopup = 'matdb';
    const typeSel = document.getElementById('matdb-pop-type');
    typeSel.innerHTML = '<option value="">— Type —</option>' +
        STONE_TYPES.map(t => `<option value="${t}">${t}</option>`).join('');
    document.getElementById('matdb-pop-name').value = '';
    typeSel.value = '';
    document.getElementById('matdb-pop-cost').value = '';
    document.getElementById('matdb-pop-slabw').value = 129;
    document.getElementById('matdb-pop-slabh').value = 63;
    _matdbPopPopulateBrand();
    _matdbPopThk = new Set(['2cm', '3cm']);
    _matdbPopFin = new Set(['Polished']);
    // Thicknesses: dropdown of known values, no custom add (per spec)
    _matdbPopRenderChips('matdb-pop-thick-grp', allKnownThicknesses(), _matdbPopThk, false);
    // Finishes: chip group + custom add (new finishes auto-persist via matDb)
    _matdbPopRenderChips('matdb-pop-finish-grp', [...allKnownFinishes()], _matdbPopFin, true);
    const el = document.getElementById('matdb-popup');
    showPopupAt(el, window.innerWidth/2 - 190, Math.max(40, window.innerHeight/2 - 290));
    setTimeout(() => document.getElementById('matdb-pop-name').focus(), 50);
}

function confirmMatdbPopup() {
    const name = document.getElementById('matdb-pop-name').value.trim();
    if (!name) { alert('Color name is required.'); return; }
    let supplier = document.getElementById('matdb-pop-supplier').value;
    if (supplier === '__NEW__') supplier = '';   // user selected the placeholder
    const stoneType = document.getElementById('matdb-pop-type').value;
    const costPerSlab = parseFloat(document.getElementById('matdb-pop-cost').value) || 0;
    const slabW = parseFloat(document.getElementById('matdb-pop-slabw').value) || 129;
    const slabH = parseFloat(document.getElementById('matdb-pop-slabh').value) || 63;
    const thicknesses = [..._matdbPopThk];
    const finishes    = [..._matdbPopFin];
    matDb.push({
        id: matDbNextId++, name, supplier, stoneType,
        thicknesses: thicknesses.length ? thicknesses : ['2cm','3cm'],
        finishes:    finishes.length    ? finishes    : ['Polished'],
        slabW, slabH, costPerSlab
    });
    saveMatDb();
    hideAllPopups();
    renderMatDb();
    renderMaterials();
    renderCostsPanel();
}

document.getElementById('matdb-add-btn').addEventListener('click', openMatdbPopup);
document.getElementById('matdb-pop-ok').addEventListener('click', confirmMatdbPopup);
document.getElementById('matdb-pop-cancel').addEventListener('click', hideAllPopups);
['matdb-pop-name','matdb-pop-cost','matdb-pop-slabw','matdb-pop-slabh'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => {
        if (e.key === 'Enter')  { e.preventDefault(); confirmMatdbPopup(); }
        if (e.key === 'Escape') { e.preventDefault(); hideAllPopups(); }
        e.stopPropagation();
    });
});
function matDbDisplayName(m) { return [m.name, (m.thicknesses||[]).join('/'), (m.finishes||[]).join('/')].filter(Boolean).join(' · ') || 'Unnamed'; }

// ── Costs panel password lock ─────────────────────────────────────
// The Costs panel (service rates, slab prices, material database) is
// password-locked to prevent accidental edits by anyone but the owner.
// Default password lives in BRAND.costsLockPassword; per-device override
// lives in localStorage (key: <storagePrefix>_costs_pw).
const COSTS_PW_KEY = (BRAND.storagePrefix || 'shop') + '_costs_pw';
let costsUnlocked = false;

function getCostsPassword() {
    return localStorage.getItem(COSTS_PW_KEY) || BRAND.costsLockPassword || '';
}

function tryUnlockCosts() {
    const pw = prompt('Enter password to unlock Costs:');
    if (pw == null) return;
    if (pw === getCostsPassword()) {
        costsUnlocked = true;
        applyCostsLockState();
    } else {
        alert('Incorrect password.');
    }
}

function lockCostsPanel() {
    costsUnlocked = false;
    applyCostsLockState();
}

function changeCostsPassword() {
    if (!costsUnlocked) return;
    const cur = prompt('Confirm CURRENT password:');
    if (cur == null) return;
    if (cur !== getCostsPassword()) { alert('Current password is incorrect.'); return; }
    const next = prompt('Enter NEW password:');
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed) { alert('Password cannot be empty.'); return; }
    localStorage.setItem(COSTS_PW_KEY, trimmed);
    alert('Password updated. It is saved on this device only.');
}

function applyCostsLockState() {
    const banner = document.getElementById('costs-lock-banner');
    const msg    = document.getElementById('costs-lock-msg');
    const btn    = document.getElementById('costs-lock-toggle');
    const pwBtn  = document.getElementById('costs-pw-change-btn');
    const panel  = document.getElementById('costs-panel');
    if (!banner || !msg || !btn || !panel) return;
    if (costsUnlocked) {
        banner.style.background  = '#1a2a1a';
        banner.style.border      = '1px solid #3a5a30';
        banner.style.color       = '#7ad080';
        msg.innerHTML            = '🔓 <b>Costs unlocked.</b> Changes you make here apply immediately.';
        btn.textContent          = 'Lock';
        btn.style.borderColor    = '#7ad080';
        btn.style.color          = '#7ad080';
        if (pwBtn) pwBtn.style.display = 'inline-block';
    } else {
        banner.style.background  = '#2a1a1a';
        banner.style.border      = '1px solid #6a3030';
        banner.style.color       = '#e0a050';
        msg.innerHTML            = '🔒 <b>Costs are locked.</b> Enter password to make changes.';
        btn.textContent          = 'Unlock';
        btn.style.borderColor    = '#b09030';
        btn.style.color          = '#b09030';
        if (pwBtn) pwBtn.style.display = 'none';
    }
    // Disable / enable every form element inside the panel except the lock button itself
    panel.querySelectorAll('input, select, textarea, button').forEach(el => {
        if (el === btn || el === pwBtn) return;
        el.disabled = !costsUnlocked;
    });
    // Visual hint: dim the locked panel
    panel.style.opacity = costsUnlocked ? '1' : '0.7';
}

document.getElementById('costs-lock-toggle').addEventListener('click', () => {
    if (costsUnlocked) lockCostsPanel();
    else tryUnlockCosts();
});
document.getElementById('costs-pw-change-btn').addEventListener('click', changeCostsPassword);
function getMatCostPerSlab(matId) {
    const m = formData.materials.find(m => m.id === matId);
    if (!m || !m.dbId) return 0;
    const db = matDb.find(d => d.id === m.dbId);
    return db ? (parseFloat(db.costPerSlab) || 0) : 0;
}
function getMatSlabSqft(matId) {
    const m = formData.materials.find(m => m.id === matId);
    if (!m || !m.dbId) return 0;
    const db = matDb.find(d => d.id === m.dbId);
    if (!db || !db.slabW || !db.slabH) return 0;
    return (db.slabW * db.slabH) / 144; // inches² to sqft
}
function getMatPriceSqft(matId) {
    const slabSqft = getMatSlabSqft(matId);
    if (slabSqft <= 0) return 0;
    return getMatCostPerSlab(matId) / slabSqft;
}

// ── Live legend ──────────────────────────────────────────────
function updateLiveLegend() {
    const used = new Set();
    let hasJoint = false;
    for (const s of shapes) {
        if (s.edges) {
            for (const side of Object.values(s.edges)) {
                if (side?.type === 'segmented' && side.segments) {
                    for (const seg of side.segments) { if (seg.profile && seg.profile !== 'none') used.add(seg.profile); }
                } else if (side?.type && side.type !== 'none') used.add(side.type);
            }
        }
        if (s.joints && s.joints.length) hasJoint = true;
    }
    const el = document.getElementById('live-legend');
    if (!el) return;
    if (used.size === 0 && !hasJoint) {
        el.innerHTML = '<span class="ll-empty">No edge profiles assigned yet.</span>';
        return;
    }
    const order = ['pencil','ogee','bullnose','halfbull','bevel','mitered','special','joint','waterfall'];
    let html = '';
    for (const type of order) {
        if (!used.has(type)) continue;
        const def = EDGE_DEFS[type];
        // Mini swatch canvas
        const cid = `ll-swatch-${type}`;
        html += `<div class="ll-row">
            <canvas id="${cid}" width="46" height="14" style="flex-shrink:0;border-radius:2px;background:#0e0e0e"></canvas>
            <span class="ll-abbr" style="color:${def.color}">${def.abbr}</span>
            <span class="ll-name">${def.label}</span>
        </div>`;
    }
    if (hasJoint) {
        html += `<div class="ll-row">
            <canvas id="ll-swatch-ijoint" width="46" height="14" style="flex-shrink:0;border-radius:2px;background:#0e0e0e"></canvas>
            <span class="ll-abbr" style="color:#e0457b">JT</span>
            <span class="ll-name">Interior Joint</span>
        </div>`;
    }
    el.innerHTML = html;
    // Draw swatches after DOM update
    requestAnimationFrame(() => {
        for (const type of order) {
            if (!used.has(type)) continue;
            const c = document.getElementById(`ll-swatch-${type}`);
            if (c) { const gc = c.getContext('2d'); drawBorderSegment(gc, type, 2, 7, 44, 7, false); }
        }
        if (hasJoint) {
            const c = document.getElementById('ll-swatch-ijoint');
            if (c) {
                const gc = c.getContext('2d');
                gc.strokeStyle='#e0457b'; gc.lineWidth=1.8; gc.setLineDash([5,4]);
                gc.beginPath(); gc.moveTo(2,7); gc.lineTo(44,7); gc.stroke(); gc.setLineDash([]);
            }
        }
    });
}


// ─────────────────────────────────────────────────────────────
//  Phase 2 — Pricing & Customer Proposal
// ─────────────────────────────────────────────────────────────

const SQFT_PX2 = 144 * INCH * INCH; // px² per square foot

function calcTotalSqft() {
    let total = 0;
    for (const p of pages) {
        for (const s of p.shapes) {
            if (s.subtype === 'sink_overmount' || s.subtype === 'sink_undermount' || s.subtype === 'sink_vasque' || s.subtype === 'cooktop') {
                total -= s.w * s.h;
            } else if (s.subtype === 'outlet') {
                total -= s.w * s.h;
            } else if (s.subtype === 'bocci') {
                total -= Math.PI * (s.w / 2) * (s.w / 2);
            } else {
                let area = s.w * s.h;
                if (s.shapeType === 'l') area -= (s.notchW || 0) * (s.notchH || 0);
                if (s.shapeType === 'u') area = uShapeAreaPx(s);
                if (s.shapeType === 'circle') area = Math.PI * (s.w / 2) * (s.h / 2);
                if (s.farmSink) area -= (FS_WIDTH_IN * INCH) * (FS_DEPTH_IN * INCH);
                area -= totalCheckAreaPx(s);
                total += area;
            }
        }
    }
    return Math.max(0, total) / SQFT_PX2;
}

function fmt$(v) {
    const n = parseFloat(v) || 0;
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function savePricing() {
    localStorage.setItem(PRICING_KEY, JSON.stringify(pricingData));
    // Mirror just the rates to a shop-global key so they seed future new quotes.
    if (pricingData.rates) localStorage.setItem(RATES_KEY, JSON.stringify(pricingData.rates));
    scheduleSyncToRemote();
}

// Returns the last-saved shop-global rates, falling back to DEFAULT_RATES.
function getSavedRates() {
    try {
        const r = JSON.parse(localStorage.getItem(RATES_KEY));
        if (r && typeof r === 'object') {
            const merged = { ...DEFAULT_RATES };
            for (const k of Object.keys(DEFAULT_RATES)) {
                if (r[k] !== undefined) merged[k] = r[k];
            }
            return merged;
        }
    } catch (_) {}
    return { ...DEFAULT_RATES };
}

function loadPricing() {
    try {
        const d = JSON.parse(localStorage.getItem(PRICING_KEY));
        if (d && d.rates) {
            pricingData = d;
            // Ensure all new rate keys exist
            for (const [k,v] of Object.entries(DEFAULT_RATES)) {
                if (pricingData.rates[k] === undefined) pricingData.rates[k] = v;
            }
            if (!pricingData.materialPrices) pricingData.materialPrices = {};
            if (pricingData.polissageSousQty === undefined) pricingData.polissageSousQty = 0;
        } else {
            // Cold start with no per-quote pricing yet — seed from the
            // shop-global rates so the Costs panel isn't all zeros.
            pricingData.rates = getSavedRates();
        }
    } catch(e) {}
}

// ── Edge & sink calculation helpers ──────────────────────────

// Edge contribution helpers used by calcPageEdgeLinearFt.
// Returns linear-px contribution of a single edge-datum for a given edgeType.
function edgeDatumPx(data, lenPx, edgeType) {
    if (!data) return 0;
    if (data.type === 'segmented' && data.segments) {
        let sum = 0;
        for (const seg of data.segments) {
            if (seg.profile === edgeType) sum += seg.length * INCH;
        }
        return sum;
    }
    if (data.type === edgeType) return lenPx;
    return 0;
}
// Computes px contribution for an edge, accounting for an FS split into
// fsLeft/fsRight halves if the shape has a farmhouse sink on this edge key.
function edgeContribPx(s, edgeKey, startX, startY, endX, endY, edgeType) {
    const edgeLen = Math.hypot(endX - startX, endY - startY);
    if (edgeLen <= 0) return 0;
    const ed = s.edges?.[edgeKey];
    if (s.farmSink && farmSinkEdgeKey(s) === edgeKey) {
        const fr = farmSinkRectAbs(s);
        if (fr) {
            const fsLx = fr.x, fsRx = fr.x + fr.w;
            const westX = Math.min(startX, endX), eastX = Math.max(startX, endX);
            const leftLen = Math.max(0, fsLx - westX);
            const rightLen = Math.max(0, eastX - fsRx);
            const baseFallback = (ed && ed.type && ed.type !== 'segmented') ? ed : { type: 'none' };
            const leftData = ed?.fsLeft || baseFallback;
            const rightData = ed?.fsRight || baseFallback;
            return edgeDatumPx(leftData, leftLen, edgeType) + edgeDatumPx(rightData, rightLen, edgeType);
        }
    }
    return edgeDatumPx(ed, edgeLen, edgeType);
}

function calcPageEdgeLinearFt(page, edgeType) {
    let totalPx = 0;
    for (const s of page.shapes) {
        if (s.subtype) continue; // skip cutouts

        if (s.shapeType === 'circle') {
            const r = s.w / 2;
            if (s.edges?.arc?.type === edgeType) totalPx += 2 * Math.PI * r;
        } else if (s.shapeType === 'l') {
            const sides = lShapeSides(s);
            for (const sd of sides) {
                totalPx += edgeContribPx(s, sd.key, sd.x1, sd.y1, sd.x2, sd.y2, edgeType);
            }
            // L-shape per-vertex corner treatments (chamfer diagonals AND radius arcs)
            if (typeof lShapeVerts === 'function') {
                const verts = lShapeVerts(s);
                for (let i = 0; i < verts.length; i++) {
                    const nv = verts[i];
                    if (nv.t > 0 && nv.r === 0) {
                        // chamfer diagonal
                        const dk = `diag_lc${i}`;
                        if (s.chamferEdges?.[dk]?.type === edgeType) {
                            totalPx += Math.hypot(nv.pout[0]-nv.pin[0], nv.pout[1]-nv.pin[1]);
                        }
                    } else if (nv.r > 0) {
                        // radius arc (quarter-circle length)
                        const ck = `lc${i}`;
                        if (s.cornerEdges?.[ck]?.type === edgeType) {
                            totalPx += Math.PI / 2 * nv.r;
                        }
                    }
                }
            }
            // L-shape check notch walls
            if (s.checks && s.checks.length) {
                const basePoly = lShapePolygon(s);
                for (const c of s.checks) {
                    if (c.vertexIdx == null) continue;
                    const cp = cornerCheckPoints(basePoly, c.vertexIdx, c);
                    if (!cp) continue;
                    if (s.edges?.[`lck${c.vertexIdx}_ac`]?.type === edgeType) totalPx += Math.hypot(cp.C[0]-cp.A[0], cp.C[1]-cp.A[1]);
                    if (s.edges?.[`lck${c.vertexIdx}_cb`]?.type === edgeType) totalPx += Math.hypot(cp.B[0]-cp.C[0], cp.B[1]-cp.C[1]);
                }
            }
        } else if (s.shapeType === 'u') {
            const sides = uShapeSides(s);
            for (const sd of sides) {
                totalPx += edgeContribPx(s, sd.key, sd.x1, sd.y1, sd.x2, sd.y2, edgeType);
            }
            // U-shape radius arcs (best-effort: rendered as polygon corners currently)
            const poly = uShapePolygon(s);
            for (let i = 0; i < poly.length; i++) {
                const rad = (s.corners && s.corners[`uc${i}`]) || 0;
                if (rad > 0 && s.cornerEdges?.[`uc${i}`]?.type === edgeType) {
                    totalPx += Math.PI / 2 * rad;
                }
            }
            // U-shape check notch walls
            if (s.checks && s.checks.length) {
                const basePoly = poly;
                for (const c of s.checks) {
                    if (c.vertexIdx == null) continue;
                    const cp = cornerCheckPoints(basePoly, c.vertexIdx, c);
                    if (!cp) continue;
                    if (s.edges?.[`uck${c.vertexIdx}_ac`]?.type === edgeType) totalPx += Math.hypot(cp.C[0]-cp.A[0], cp.C[1]-cp.A[1]);
                    if (s.edges?.[`uck${c.vertexIdx}_cb`]?.type === edgeType) totalPx += Math.hypot(cp.B[0]-cp.C[0], cp.B[1]-cp.C[1]);
                }
            }
        } else if (s.shapeType === 'bsp') {
            const sides = bspSides(s);
            for (const sd of sides) {
                const ed = s.edges?.[sd.key];
                if (ed?.type === 'segmented' && ed.segments) {
                    for (const seg of ed.segments) { if (seg.profile === edgeType) totalPx += seg.length * INCH; }
                } else if (ed?.type === edgeType) {
                    totalPx += Math.hypot(sd.x2 - sd.x1, sd.y2 - sd.y1);
                }
            }
        } else {
            // rect
            const ch = shapeChamfers(s), chB = shapeChamfersB(s), r = shapeRadii(s);
            const nwA = ch.nw > 0 ? ch.nw : r.nw, nwB = ch.nw > 0 ? chB.nw : r.nw;
            const neA = ch.ne > 0 ? ch.ne : r.ne, neB = ch.ne > 0 ? chB.ne : r.ne;
            const seA = ch.se > 0 ? ch.se : r.se, seB = ch.se > 0 ? chB.se : r.se;
            const swA = ch.sw > 0 ? ch.sw : r.sw, swB = ch.sw > 0 ? chB.sw : r.sw;
            const sideSegs = [
                { key:'top',    x1:s.x+nwA,     y1:s.y,          x2:s.x+s.w-neA, y2:s.y          },
                { key:'right',  x1:s.x+s.w,     y1:s.y+neB,      x2:s.x+s.w,     y2:s.y+s.h-seA  },
                { key:'bottom', x1:s.x+s.w-seB, y1:s.y+s.h,      x2:s.x+swA,     y2:s.y+s.h      },
                { key:'left',   x1:s.x,         y1:s.y+s.h-swB,  x2:s.x,         y2:s.y+nwB      },
            ];
            for (const sd of sideSegs) {
                totalPx += edgeContribPx(s, sd.key, sd.x1, sd.y1, sd.x2, sd.y2, edgeType);
            }
            // corner arcs
            const corners = ['nw','ne','se','sw'];
            for (const k of corners) {
                if (r[k] > 0 && s.cornerEdges?.[k]?.type === edgeType) totalPx += Math.PI / 2 * r[k];
            }
            // chamfer diagonals
            const chamferSegs = [
                { key:'nw', len: Math.hypot(ch.nw, chB.nw) },
                { key:'ne', len: Math.hypot(ch.ne, chB.ne) },
                { key:'se', len: Math.hypot(ch.se, chB.se) },
                { key:'sw', len: Math.hypot(ch.sw, chB.sw) },
            ];
            for (const cd of chamferSegs) {
                if (cd.len > 0 && s.chamferEdges?.['diag_'+cd.key]?.type === edgeType) totalPx += cd.len;
            }
            // Rect check notch walls
            if (s.checks && s.checks.length) {
                for (const c of s.checks) {
                    if (!c.cornerKey) continue;
                    const hKey = `ck_${c.cornerKey}_h`, vKey = `ck_${c.cornerKey}_v`;
                    if (s.edges?.[hKey]?.type === edgeType) totalPx += c.w;
                    if (s.edges?.[vKey]?.type === edgeType) totalPx += c.d;
                }
            }
        }
    }
    return totalPx / (INCH * 12);
}

function calcPageSinkCounts(page) {
    let overmount = 0, undermount = 0, vasque = 0, cooktops = 0, farmSinks = 0;
    let outlets = 0, boccis = 0;
    for (const s of page.shapes) {
        if (s.subtype === 'sink_overmount') overmount++;
        else if (s.subtype === 'sink_undermount') undermount++;
        else if (s.subtype === 'sink_vasque') vasque++;
        else if (s.subtype === 'cooktop') cooktops++;
        else if (s.subtype === 'outlet') outlets++;
        else if (s.subtype === 'bocci') boccis++;
        // Farmhouse sinks are a property on a countertop shape, not a separate subtype
        if (!s.subtype && s.farmSink) farmSinks++;
    }
    return { overmount, undermount, vasque, cooktops, farmSinks, outlets, boccis };
}

// ── Compute service quantities for the new rate model ────────
// Returns { pencilLf, coupeSqft, dektonCoupeSqft, evierOver, evierUnder, evierVasque, fini45Lf, lamineLf, polissageSousQty }
function calcServiceQtys() {
    let pencilLf = 0, coupeSqft = 0, dektonCoupeSqft = 0;
    let evierOver = 0, evierUnder = 0, evierVasque = 0, cooktopQty = 0, farmSinkQty = 0;
    let outletQty = 0, bocciQty = 0;
    let fini45Lf = 0, lamineLf = 0;
    let polishUnderSqft = 0;
    let totalSqft = 0;
    for (const page of pages) {
        // Pencil linear feet
        pencilLf += calcPageEdgeLinearFt(page, 'pencil') + calcPageEdgeLinearFt(page, 'polished');
        // Waterfall = fini45
        fini45Lf += calcPageEdgeLinearFt(page, 'waterfall');
        // Mitered = lamine
        lamineLf += calcPageEdgeLinearFt(page, 'mitered');
        // Sinks
        const sinks = calcPageSinkCounts(page);
        evierOver += sinks.overmount;
        evierUnder += sinks.undermount;
        evierVasque += sinks.vasque;
        cooktopQty += sinks.cooktops;
        farmSinkQty += sinks.farmSinks;
        outletQty += sinks.outlets;
        bocciQty += sinks.boccis;
        // Polish-under areas (auto-quantified from drawn rectangles)
        for (const s of page.shapes) {
            if (s.subtype) continue;
            for (const r of (s.polishUnders || [])) {
                polishUnderSqft += (r.w * r.h) / SQFT_PX2;
            }
        }
        // Material area — split by Dekton vs non-Dekton
        for (const s of page.shapes) {
            if (s.subtype) continue;
            let area = s.w * s.h;
            if (s.shapeType === 'l') area -= (s.notchW||0) * (s.notchH||0);
            if (s.shapeType === 'u') area = uShapeAreaPx(s);
            if (s.shapeType === 'circle') area = Math.PI * (s.w/2) * (s.h/2);
            if (s.farmSink) area -= (FS_WIDTH_IN * INCH) * (FS_DEPTH_IN * INCH);
            area -= totalCheckAreaPx(s);
            const sqft = area / SQFT_PX2;
            totalSqft += sqft;
            // Check if material is Dekton
            const mid = s.materialId || (formData.materials[0] && formData.materials[0].id) || 0;
            const mat = formData.materials.find(m => m.id === mid) || {};
            const isDekton = (mat.supplier || '').toLowerCase().includes('dekton') ||
                             (mat.color || '').toLowerCase().includes('dekton') ||
                             (mat.thickness || '').toLowerCase().includes('dekton') ||
                             (mat.notes || '').toLowerCase().includes('dekton');
            if (isDekton) dektonCoupeSqft += sqft;
            else coupeSqft += sqft;
        }
    }
    const measurementsQty = (pricingData.measurementsEnabled === false) ? 0 : 1;
    return {
        pencilLf, coupeSqft, dektonCoupeSqft,
        evierOver, evierUnder, evierVasque,
        cooktopQty, farmSinkQty,
        outletQty, bocciQty,
        fini45Lf, lamineLf,
        polissageSousQty: polishUnderSqft,
        installationSqft: totalSqft,
        measurementsQty
    };
}

// Map rate key → { qty, unitLabel } for pricing display
function getServiceLineItems() {
    const q = calcServiceQtys();
    const R = pricingData.rates;
    return SERVICE_RATE_DEFS.map(d => {
        let qty = 0, unitLabel = '';
        switch (d.key) {
            case 'pencil':        qty = q.pencilLf;          unitLabel = `${qty.toFixed(2)} lin ft`; break;
            case 'coupe':         qty = q.coupeSqft;         unitLabel = `${qty.toFixed(2)} sqft`; break;
            case 'dektonCoupe':   qty = q.dektonCoupeSqft;   unitLabel = `${qty.toFixed(2)} sqft`; break;
            case 'evierOver':     qty = q.evierOver;         unitLabel = `${qty} trou(s)`; break;
            case 'evierUnder':    qty = q.evierUnder;        unitLabel = `${qty} trou(s)`; break;
            case 'evierVasque':   qty = q.evierVasque;       unitLabel = `${qty} trou(s)`; break;
            case 'cooktop':       qty = q.cooktopQty;        unitLabel = `${qty} trou(s)`; break;
            case 'farmSink':      qty = q.farmSinkQty;       unitLabel = `${qty} évier(s)`; break;
            case 'outlet':        qty = q.outletQty;         unitLabel = `${qty} outlet(s)`; break;
            case 'bocci':         qty = q.bocciQty;          unitLabel = `${qty} bocci(s)`; break;
            case 'fini45':        qty = q.fini45Lf;          unitLabel = `${qty.toFixed(2)} lin ft`; break;
            case 'lamine':        qty = q.lamineLf;          unitLabel = `${qty.toFixed(2)} lin ft`; break;
            case 'polissageSous': qty = q.polissageSousQty;  unitLabel = `${qty.toFixed(2)} sqft`; break;
            case 'installation':  qty = q.installationSqft;  unitLabel = `${qty.toFixed(2)} sqft`; break;
            case 'measurements':  qty = q.measurementsQty;   unitLabel = qty ? 'flat fee' : 'disabled'; break;
        }
        const rate = R[d.key] || 0;
        let cost = qty * rate;
        // Installation minimum fee: floor the installation cost if min > 0
        if (d.key === 'installation') {
            const minFee = pricingData.installationMin || 0;
            if (minFee > 0 && cost < minFee) cost = minFee;
        }
        return { ...d, qty, rate, cost, unitLabel };
    }).filter(item => item.qty > 0 || item.rate > 0);
}

// ── Render the full pricing panel ────────────────────────────

let costBrandFilter = '';
function renderCostsPanel() {
    // ── Brand filter dropdown ───────────────────────────────────
    const brandSel = document.getElementById('cost-brand-filter');
    if (brandSel) {
        const brands = [...new Set(matDb.map(m => m.supplier).filter(Boolean))].sort();
        const prev = costBrandFilter;
        brandSel.innerHTML = '<option value="">All brands</option>' + brands.map(b => `<option value="${b}">${b}</option>`).join('');
        brandSel.value = prev;
        if (!brandSel.dataset.bound) {
            brandSel.dataset.bound = '1';
            brandSel.addEventListener('change', e => { costBrandFilter = e.target.value; renderCostsPanel(); });
        }
    }

    // ── Slab Prices (filtered) ──────────────────────────────────
    const priceContainer = document.getElementById('cost-slab-prices');
    if (priceContainer) {
        const filtered = (costBrandFilter ? matDb.filter(m => m.supplier === costBrandFilter) : [...matDb]).sort((a,b) => (a.name||'').localeCompare(b.name||''));
        if (!filtered.length) {
            priceContainer.innerHTML = '<p class="price-internal-note">' + (matDb.length ? 'No materials match this brand.' : 'No materials in database. Add materials below first.') + '</p>';
        } else {
            priceContainer.innerHTML = filtered.map(m => {
                const slabSqft = (m.slabW && m.slabH) ? ((m.slabW * m.slabH) / 144).toFixed(1) : '?';
                const perSqft = (m.costPerSlab && m.slabW && m.slabH) ? fmt$((m.costPerSlab / ((m.slabW * m.slabH) / 144))) : '—';
                return `<div style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid #333">
                    <div style="flex:1;min-width:0">
                        <div style="color:#e0ddd5;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.name||'Unnamed'}</div>
                        <div style="color:#777;font-size:9px">${m.supplier||''} · ${(m.thicknesses||[]).join(', ')} · ${(m.finishes||[]).join(', ')} · ${m.slabW||'?'}"×${m.slabH||'?'}" (${slabSqft} sqft)</div>
                    </div>
                    <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
                        <span style="color:#888;font-size:10px">$/slab</span>
                        <input class="mat-input cost-slab-inp" data-dbid="${m.id}" type="text" inputmode="decimal" style="width:75px;text-align:right" value="${m.costPerSlab||''}" placeholder="0">
                    </div>
                    <div class="cost-sqft-lbl" data-dbid="${m.id}" style="color:#999;font-size:9px;width:55px;text-align:right;flex-shrink:0">${perSqft}/sqft</div>
                </div>`;
            }).join('');
            priceContainer.querySelectorAll('.cost-slab-inp').forEach(inp => inp.addEventListener('input', e => {
                const db = matDb.find(m => m.id === +e.target.dataset.dbid);
                if (db) {
                    db.costPerSlab = parseFloat(e.target.value) || 0;
                    saveMatDb();
                    // Update just the $/sqft label
                    const lbl = priceContainer.querySelector(`.cost-sqft-lbl[data-dbid="${db.id}"]`);
                    if (lbl) {
                        const ss = (db.slabW && db.slabH) ? (db.slabW * db.slabH) / 144 : 0;
                        lbl.textContent = (db.costPerSlab && ss > 0) ? fmt$(db.costPerSlab / ss) + '/sqft' : '—/sqft';
                    }
                }
            }));
        }
    }

    // ── Service Rates ───────────────────────────────────────────
    const rateContainer = document.getElementById('cost-service-rates');
    if (rateContainer) {
        const R = pricingData.rates;
        const unitLabels = { lf:'$/lin ft', sqft:'$/sqft', each:'$ / each' };
        let html = SERVICE_RATE_DEFS.map(f => `<div style="display:flex;align-items:center;gap:6px;padding:4px 4px;border-bottom:1px solid #333">
            <span style="flex:1;color:#e0ddd5;font-size:11px">${f.label} <span style="color:#555;font-size:9px">${unitLabels[f.unit]||''}</span></span>
            <input class="mat-input cost-rate-inp" data-rkey="${f.key}" type="text" inputmode="decimal" style="width:75px;text-align:right" value="${R[f.key]||0}">
        </div>`).join('');
        // Installation minimum fee row
        html += `<div style="display:flex;align-items:center;gap:6px;padding:4px 4px;border-bottom:1px solid #333;background:#181818">
            <span style="flex:1;color:#e0ddd5;font-size:11px">Installation min. fee <span style="color:#555;font-size:9px">$ flat floor</span></span>
            <input class="mat-input cost-inst-min-inp" type="text" inputmode="decimal" style="width:75px;text-align:right" value="${pricingData.installationMin||0}">
        </div>`;
        rateContainer.innerHTML = html;
        rateContainer.querySelectorAll('.cost-rate-inp').forEach(inp => inp.addEventListener('input', e => {
            pricingData.rates[e.target.dataset.rkey] = parseFloat(e.target.value) || 0;
            savePricing();
        }));
        const instMinInp = rateContainer.querySelector('.cost-inst-min-inp');
        if (instMinInp) instMinInp.addEventListener('input', e => {
            pricingData.installationMin = parseFloat(e.target.value) || 0;
            savePricing();
        });
    }

    // ── Material Database ────────────────────────────────────────
    renderMatDb();

    // Re-apply lock state every render (re-disables newly-created inputs).
    if (typeof applyCostsLockState === 'function') applyCostsLockState();
}

function renderPricingPanel() {
    const summaryContainer = document.getElementById('pricing-summary');
    if (!summaryContainer) return;
    syncPageOut();

    // Initialize slab overrides storage
    if (!pricingData.slabOverrides) pricingData.slabOverrides = {};
    // { matId: { qty: <number>, customPrice: <number|null> } }

    let sumHtml = '';

    // ── Material costs (slab-based) ──────────────────────────
    let materialCostTotal = 0;
    let matLines = '';
    // Compute sqft per page (by page.id)
    const pageSqftById = {};
    let totalProjectSqft = 0;
    for (const page of pages) {
        let pageSqft = 0;
        for (const s of page.shapes) {
            if (s.subtype) continue;
            let area = s.w * s.h;
            if (s.shapeType === 'l') area -= (s.notchW||0) * (s.notchH||0);
            if (s.shapeType === 'u') area = uShapeAreaPx(s);
            if (s.shapeType === 'circle') area = Math.PI * (s.w/2) * (s.h/2);
            if (s.farmSink) area -= (FS_WIDTH_IN * INCH) * (FS_DEPTH_IN * INCH);
            area -= totalCheckAreaPx(s);
            pageSqft += area / SQFT_PX2;
        }
        pageSqftById[page.id] = pageSqft;
        totalProjectSqft += pageSqft;
    }

    // Build matSqftMap by material type:
    //   - Page-type material: sqft = sqft of its linked page
    //   - Option-type material: sqft = whole-project total (alternative scenarios)
    const matSqftMap = {};
    for (const mat of (formData.materials||[])) {
        const t = mat.type || 'page';
        if (t === 'page') {
            const ps = (mat.pageId != null) ? (pageSqftById[mat.pageId] || 0) : 0;
            matSqftMap[mat.id] = ps;
        } else if (t === 'option') {
            matSqftMap[mat.id] = totalProjectSqft;
        }
    }
    // Helper: build one material cost block (HTML + numbers)
    function buildMatBlock(mid, msqft) {
        const mat = formData.materials.find(m => m.id === +mid) || {};
        const matName = [mat.color, mat.thickness].filter(Boolean).join(' · ') || 'Material';
        const isDekton = (mat.supplier||'').toLowerCase().includes('dekton') ||
                         (mat.color||'').toLowerCase().includes('dekton') ||
                         (mat.thickness||'').toLowerCase().includes('dekton') ||
                         (mat.notes||'').toLowerCase().includes('dekton');
        const dbCostPerSlab = getMatCostPerSlab(+mid);
        const slabSqft = getMatSlabSqft(+mid);
        const suggestedQty = slabSqft > 0 ? Math.ceil(msqft / slabSqft) : 1;
        const ov = pricingData.slabOverrides[mid] || {};
        const slabQty = ov.qty != null ? ov.qty : suggestedQty;
        const hasDbPrice = dbCostPerSlab > 0;
        const useCustom = ov.customPrice != null && ov.customPrice >= 0;
        const pricePerSlab = useCustom ? ov.customPrice : dbCostPerSlab;
        const slabCost = slabQty * pricePerSlab;
        const cuttingRate = isDekton ? (pricingData.rates.dektonCoupe || 0) : (pricingData.rates.coupe || 0);
        const cuttingCost = msqft * cuttingRate;
        const matSubtotal = slabCost + cuttingCost;
        const html = `<div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:6px 8px;margin-bottom:4px">
            <div style="font-size:11px;font-weight:700;color:#e0ddd5;margin-bottom:4px">${matName}${isDekton ? ' <span style="color:#e0a050;font-weight:500;font-size:9px">(Dekton)</span>' : ''}</div>
            <div style="font-size:9px;color:#888;margin-bottom:4px">${msqft.toFixed(2)} sqft total · suggested ${suggestedQty} slab${suggestedQty!==1?'s':''}</div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:3px">
                <span style="font-size:10px;color:#999;min-width:50px">Qty slabs</span>
                <input class="mat-input pricing-slab-qty" data-mid="${mid}" type="text" inputmode="numeric" value="${slabQty}" style="width:60px;text-align:right">
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:4px">
                <span style="font-size:10px;color:#999;min-width:50px">$/slab</span>
                <input class="mat-input pricing-slab-price" data-mid="${mid}" type="text" inputmode="decimal" value="${pricePerSlab}" style="width:80px;text-align:right" ${hasDbPrice && !useCustom ? 'placeholder="DB: '+dbCostPerSlab.toFixed(2)+'"' : ''}>
                ${!hasDbPrice ? '<span style="font-size:8px;color:#e05c5c">no DB price</span>' : ''}
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#aaa;padding:2px 0;border-top:1px dashed #333">
                <span>Slab cost</span><span>${fmt$(slabCost)}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:10px;color:#aaa;padding:2px 0">
                <span>${isDekton ? 'Dekton cut' : 'Cut'}: ${msqft.toFixed(2)} sqft × ${fmt$(cuttingRate)}</span><span>${fmt$(cuttingCost)}</span>
            </div>
            <div style="text-align:right;margin-top:3px;font-size:11px;font-weight:700;color:#b09030;border-top:1px solid #333;padding-top:3px">Material total: ${fmt$(matSubtotal)}</div>
        </div>`;
        return { mat, html, matSubtotal };
    }

    // Group page-type blocks BY pageId (a page can have 2+ linked materials = per-page options)
    const optionsGrp = [];
    const pageBlocksByPageId = new Map(); // pageId -> array of block objects (mat + html + matSubtotal)
    const unlinkedPageBlocks = [];        // blocks with pageId missing
    for (const [mid, msqft] of Object.entries(matSqftMap)) {
        const b = buildMatBlock(mid, msqft);
        const t = (b.mat.type || 'page');
        if (t === 'option') { optionsGrp.push({ mid, ...b }); continue; }
        // page-type
        const pid = b.mat.pageId;
        if (pid == null) { unlinkedPageBlocks.push({ mid, ...b }); continue; }
        if (!pageBlocksByPageId.has(pid)) pageBlocksByPageId.set(pid, []);
        pageBlocksByPageId.get(pid).push({ mid, ...b });
    }

    // Warn about canvas pages that have shapes but no linked material
    const orphanPages = pages.filter(p => (pageSqftById[p.id] || 0) > 0 && !pageBlocksByPageId.has(p.id));
    if (orphanPages.length > 0) {
        sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px;border:1px dashed #e0a050;border-radius:6px;padding:8px;background:#1f1b10">
            <div style="color:#e0a050;font-size:11px;font-weight:700;margin-bottom:3px">⚠ Page(s) without a linked material</div>
            <div style="color:#aaa;font-size:10px">These canvas pages have shapes but no linked material: ${orphanPages.map(p=>p.name).join(', ')}. Add a material of type "Page" and link it to each page to include them in pricing.</div>
        </div>`;
    }

    // ── Pages: one section per canvas page, with 1 or more linked materials ──
    // Track per-page selected option subtotals for the "committed" total.
    // (The committed grand-total assumes the FIRST option of each multi-option page;
    //  full combinations are rendered in their own section below.)
    let anyMultiOptionPage = false;
    // Iterate in page order for a stable layout
    for (const page of pages) {
        const blocks = pageBlocksByPageId.get(page.id);
        if (!blocks || blocks.length === 0) continue;

        if (blocks.length === 1) {
            // Single-material page — render as before
            const b = blocks[0];
            materialCostTotal += b.matSubtotal;
            sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px;border:1px solid #b09030;border-radius:6px;padding:8px;background:#1f1f1f">
                <div class="price-check-label" style="color:#b09030">PAGE — ${page.name}</div>
                ${b.html}
                <div style="text-align:right;margin-top:6px;font-size:12px;font-weight:700;color:#b09030">Page subtotal: ${fmt$(b.matSubtotal)}</div>
            </div>`;
        } else {
            // Multi-option page — render side-by-side option cards
            anyMultiOptionPage = true;
            // Committed total uses the FIRST option (used for the "Committed subtotal" label only)
            materialCostTotal += blocks[0].matSubtotal;
            let optsInner = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">';
            blocks.forEach((b, i) => {
                const optLabel = `Option ${i+1}`;
                const matName = [b.mat.color, b.mat.thickness].filter(Boolean).join(' · ') || 'Material';
                optsInner += `<div style="flex:1;min-width:240px;background:#141414;border:1px solid #b09030;border-radius:4px;padding:6px;display:flex;flex-direction:column">
                    <div style="font-size:11px;font-weight:700;color:#b09030;margin-bottom:4px;text-align:center;border-bottom:1px solid #333;padding-bottom:3px">${optLabel} — ${matName}</div>
                    <div style="flex:1">${b.html}</div>
                    <div style="text-align:right;margin-top:4px;padding:5px;background:#2d3a10;border-radius:4px;font-size:12px;font-weight:700;color:#b09030">${optLabel} total: ${fmt$(b.matSubtotal)}</div>
                </div>`;
            });
            optsInner += '</div>';
            sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px;border:1px solid #b09030;border-radius:6px;padding:8px;background:#1f1f1f">
                <div class="price-check-label" style="color:#b09030">PAGE — ${page.name} · ${blocks.length} options</div>
                <p style="font-size:9px;color:#888;margin:2px 0 6px;font-style:italic">Client selects one material option for this page. Services on this page are shared across options.</p>
                ${optsInner}
            </div>`;
        }
    }

    // Unlinked page-materials (safety fallback)
    for (const b of unlinkedPageBlocks) {
        materialCostTotal += b.matSubtotal;
        sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px;border:1px dashed #e0a050;border-radius:6px;padding:8px;background:#1a1a1a">
            <div class="price-check-label" style="color:#e0a050">Unassigned material <span style="font-size:9px">(not linked to any page)</span></div>
            ${b.html}
            <div style="text-align:right;margin-top:6px;font-size:12px;font-weight:700;color:#b09030">Subtotal: ${fmt$(b.matSubtotal)}</div>
        </div>`;
    }

    // (Options section is rendered at the bottom, after all services are computed,
    //  so each Option's displayed total can include the shared baseline.)

    // ── Service line items (only show if qty > 0) ────────────
    // Exclude polissageSous, measurements, installation, coupe, dektonCoupe — each has its own block/attribution
    const allServiceItems = getServiceLineItems();
    const items = allServiceItems.filter(i => i.key !== 'polissageSous' && i.key !== 'measurements' && i.key !== 'installation' && i.key !== 'coupe' && i.key !== 'dektonCoupe' && i.qty > 0);
    let serviceCostTotal = items.reduce((s, i) => s + i.cost, 0);

    if (items.length) {
        sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px">
            <div class="price-check-label">Services</div>
            ${items.map(i => `<div class="price-check-row">
                <span class="price-check-name">${i.desc}: ${i.unitLabel} × ${fmt$(i.rate)}</span>
                <span class="price-check-val">${fmt$(i.cost)}</span>
            </div>`).join('')}
        </div>`;
    }

    // ── Polissage sous (auto-quantified from drawn Pol. Under areas) ──
    const psItem = allServiceItems.find(i => i.key === 'polissageSous');
    const psQty = psItem?.qty || 0;
    const psRate = pricingData.rates.polissageSous || 0;
    const psCost = psQty * psRate;
    if (psQty > 0) serviceCostTotal += psCost;

    sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px">
        <div class="price-check-label">Polissage sous morceau</div>
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0">
            <span style="font-size:10px;color:#999;flex:1">${psQty.toFixed(2)} sqft × ${fmt$(psRate)} <span style="font-size:8.5px;color:#666">(auto from Pol. Under tool)</span></span>
            <span style="font-size:11px;font-weight:700;color:#b09030">${fmt$(psCost)}</span>
        </div>
    </div>`;

    // ── Installation ─────────────────────────────────────────
    // Costs tab's "Installation min. fee" (pricingData.installationMin) is applied silently
    // as a floor. The Pricing tab exposes a "Custom install price" field
    // (pricingData.installationCustom) that, when set, OVERRIDES the computed value.
    const instRate = pricingData.rates.installation || 0;
    const instSqft = (allServiceItems.find(i => i.key === 'installation')?.qty) || 0;
    const instRawCost = instSqft * instRate;
    const instMin = pricingData.installationMin || 0;
    const instCustom = (pricingData.installationCustom != null && pricingData.installationCustom !== '')
        ? (parseFloat(pricingData.installationCustom) || 0) : null;
    const instCost = instCustom != null && instCustom > 0 ? instCustom : Math.max(instRawCost, instMin);
    if (instRate > 0 || instMin > 0 || (instCustom||0) > 0) serviceCostTotal += instCost;

    sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px">
        <div class="price-check-label">Installation</div>
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0">
            <span style="font-size:10px;color:#999;flex:1">${instSqft.toFixed(2)} sqft × ${fmt$(instRate)}</span>
            <span style="font-size:11px;font-weight:700;color:${instCustom != null && instCustom > 0 ? '#777' : '#b09030'};${instCustom != null && instCustom > 0 ? 'text-decoration:line-through' : ''}">${fmt$(Math.max(instRawCost, instMin))}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;padding:3px 0">
            <span style="font-size:10px;color:#999;flex:1">Custom install price <span style="font-size:8.5px;color:#666">(leave blank to use calculated)</span></span>
            <input class="mat-input" id="pricing-inst-custom" type="text" inputmode="decimal" value="${instCustom != null ? instCustom : ''}" placeholder="—" style="width:90px;text-align:right">
            <span style="font-size:11px;font-weight:700;color:#b09030;margin-left:6px">${fmt$(instCost)}</span>
        </div>
    </div>`;

    // ── Measurements toggle ──────────────────────────────────
    const mEnabled = pricingData.measurementsEnabled !== false;
    const mRate = pricingData.rates.measurements || 0;
    const mCost = mEnabled ? mRate : 0;
    if (mEnabled) serviceCostTotal += mCost;

    sumHtml += `<div class="room-pricing-section" style="margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:8px">
            <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:11px;color:#e0ddd5">
                <input type="checkbox" id="pricing-meas-toggle" ${mEnabled ? 'checked' : ''} style="cursor:pointer">
                Measurements (flat fee)
            </label>
            <span style="font-size:10px;color:#999;margin-left:auto">${mEnabled ? fmt$(mRate) : 'disabled'}</span>
            <span style="font-size:11px;font-weight:700;color:#b09030">${mEnabled ? fmt$(mCost) : ''}</span>
        </div>
    </div>`;

    // ── Grand total of committed costs (pages + services) ──
    const committedTotal = materialCostTotal + serviceCostTotal;
    const TAX = 1.14975;
    const committedWithTax = committedTotal * TAX;
    let committedLabel;
    if (optionsGrp.length > 0) committedLabel = 'Committed subtotal (shared)';
    else if (anyMultiOptionPage)  committedLabel = 'Reference total — using Option 1 of each multi-option page';
    else                           committedLabel = 'Grand Total';
    sumHtml += `<div class="room-pricing-section" style="margin-top:8px;padding:8px;background:#2d3a10;border:1px solid #b09030;border-radius:6px">
        <div class="price-check-row" style="font-weight:bold;font-size:13px">
            <span class="price-check-name">${committedLabel} (pre-tax)</span>
            <span class="price-check-val">${fmt$(committedTotal)}</span>
        </div>
        <div class="price-check-row" style="font-weight:bold;font-size:14px;color:#b09030;border-top:1px solid #555;margin-top:4px;padding-top:4px">
            <span class="price-check-name">With taxes (GST 5% + QST 9.975%)</span>
            <span class="price-check-val">${fmt$(committedWithTax)}</span>
        </div>
    </div>`;

    // ── Combinations summary (cross-product of per-page options) ──
    if (anyMultiOptionPage) {
        const pageEntries = [];
        for (const page of pages) {
            const blocks = pageBlocksByPageId.get(page.id);
            if (!blocks || blocks.length === 0) continue;
            pageEntries.push({ page, blocks });
        }
        let combos = [[]];
        for (const { page, blocks } of pageEntries) {
            const nc = [];
            for (const c of combos) {
                for (let i = 0; i < blocks.length; i++) {
                    nc.push([...c, { page, blockIdx: i, block: blocks[i] }]);
                }
            }
            combos = nc;
        }

        let combosHtml = `<div class="room-pricing-section" style="margin-top:10px;border:2px dashed #b09030;border-radius:6px;padding:8px">
            <div class="price-check-label" style="color:#b09030">COMBINATIONS — ${combos.length} possible scenario${combos.length>1?'s':''}</div>
            <p style="font-size:9px;color:#999;margin:2px 0 8px;font-style:italic">Cross-product of per-page options. Shared project services are added once per combination.</p>`;
        combos.forEach((combo, ci) => {
            let matSum = 0;
            const picks = combo.map(c => {
                matSum += c.block.matSubtotal;
                const matName = [c.block.mat.color, c.block.mat.thickness].filter(Boolean).join(' · ') || 'Material';
                const n = pageBlocksByPageId.get(c.page.id).length;
                const optLabel = n > 1 ? ` · Option ${c.blockIdx+1}` : '';
                return { name: `${c.page.name}${optLabel} (${matName})`, cost: c.block.matSubtotal };
            });
            const preT = matSum + serviceCostTotal;
            const TAX = 1.14975; // GST 5% + QST 9.975% (same as PDF)
            const withTax = preT * TAX;
            combosHtml += `<div style="margin-bottom:8px;padding:8px;background:#141414;border:1px solid #333;border-radius:4px">
                <div style="font-size:11px;font-weight:700;color:#b09030;margin-bottom:4px">Combination ${ci+1}</div>
                ${picks.map(p => `<div style="display:flex;justify-content:space-between;font-size:10px;color:#ccc;padding:2px 0">
                    <span>${p.name}</span>
                    <span>${fmt$(p.cost)}</span>
                </div>`).join('')}
                <div style="display:flex;justify-content:space-between;font-size:10px;color:#aaa;padding:2px 0;border-top:1px dashed #333;margin-top:3px">
                    <span>Project services (shared)</span>
                    <span>${fmt$(serviceCostTotal)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:11px;color:#ccc;padding:3px 6px;border-top:1px solid #333;margin-top:3px">
                    <span>Pre-tax subtotal</span>
                    <span style="font-weight:700">${fmt$(preT)}</span>
                </div>
                <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700;color:#b09030;padding:5px 6px;border-top:1px solid #b09030;margin-top:1px;background:#2d3a10;border-radius:3px">
                    <span>TOTAL with taxes — Combo ${ci+1}</span>
                    <span>${fmt$(withTax)}</span>
                </div>
                <div style="font-size:8.5px;color:#777;text-align:right;margin-top:2px;font-style:italic">GST 5% + QST 9.975% — matches client proposal PDF</div>
            </div>`;
        });
        combosHtml += '</div>';
        sumHtml += combosHtml;
    }

    // ── Options: side-by-side scenarios, each = committed baseline + option's own material ──
    if (optionsGrp.length > 0) {
        const sharedBaseline = committedTotal;
        let optInner = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">';
        optionsGrp.forEach((b) => {
            const lbl = b.mat.label || `Option ${getOptionLetter(b.mat)}`;
            const optionTotal = b.matSubtotal + sharedBaseline;
            optInner += `<div style="flex:1;min-width:240px;background:#1a1a1a;border:1px solid #b09030;border-radius:4px;padding:6px;display:flex;flex-direction:column">
                <div style="font-size:12px;font-weight:700;color:#b09030;margin-bottom:4px;text-align:center;border-bottom:1px solid #333;padding-bottom:3px">${lbl}</div>
                <div style="flex:1">${b.html}</div>
                <div style="font-size:10px;color:#999;margin-top:4px;padding:4px 0;border-top:1px dashed #333">
                    <div style="display:flex;justify-content:space-between"><span>Option material + cut</span><span>${fmt$(b.matSubtotal)}</span></div>
                    <div style="display:flex;justify-content:space-between"><span>+ Shared baseline</span><span>${fmt$(sharedBaseline)}</span></div>
                </div>
                <div style="text-align:right;margin-top:4px;padding:6px;background:#2d3a10;border-radius:4px;font-size:13px;font-weight:700;color:#b09030">${lbl} TOTAL: ${fmt$(optionTotal)}</div>
            </div>`;
        });
        optInner += '</div>';
        sumHtml += `<div class="room-pricing-section" style="margin-top:10px;border:2px dashed #b09030;border-radius:6px;padding:8px">
            <div class="price-check-label" style="color:#b09030">CLIENT OPTIONS — select one</div>
            <p style="font-size:9px;color:#999;margin:2px 0 8px;font-style:italic">Each option covers the whole project at its own slab price. The shared baseline above is added to every option.</p>
            ${optInner}
        </div>`;
    }

    summaryContainer.innerHTML = sumHtml;

    // ── Wire up interactive inputs ───────────────────────────
    // Slab qty
    // Slab qty — `change` fires on blur/Enter so typing stays focused
    summaryContainer.querySelectorAll('.pricing-slab-qty').forEach(inp => {
        inp.addEventListener('change', e => {
            const mid = e.target.dataset.mid;
            if (!pricingData.slabOverrides[mid]) pricingData.slabOverrides[mid] = {};
            pricingData.slabOverrides[mid].qty = parseInt(e.target.value) || 0;
            savePricing(); renderPricingPanel();
        });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    // Slab custom price — same treatment
    summaryContainer.querySelectorAll('.pricing-slab-price').forEach(inp => {
        inp.addEventListener('change', e => {
            const mid = e.target.dataset.mid;
            if (!pricingData.slabOverrides[mid]) pricingData.slabOverrides[mid] = {};
            pricingData.slabOverrides[mid].customPrice = parseFloat(e.target.value) || 0;
            savePricing(); renderPricingPanel();
        });
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    // Polissage sous toggle
    const psToggle = document.getElementById('pricing-ps-toggle');
    if (psToggle) psToggle.addEventListener('change', e => {
        if (e.target.checked) {
            pricingData.polissageSousQty = pricingData.polissageSousQty || 1;
        } else {
            pricingData.polissageSousQty = 0;
        }
        savePricing(); renderPricingPanel();
    });
    // Polissage sous qty
    const psQtyInp = document.getElementById('pricing-ps-qty');
    if (psQtyInp) {
        psQtyInp.addEventListener('change', e => {
            pricingData.polissageSousQty = parseInt(e.target.value) || 0;
            savePricing(); renderPricingPanel();
        });
        psQtyInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); psQtyInp.blur(); } });
    }
    // Measurements toggle
    const measToggle = document.getElementById('pricing-meas-toggle');
    if (measToggle) measToggle.addEventListener('change', e => {
        pricingData.measurementsEnabled = e.target.checked;
        savePricing(); renderPricingPanel();
    });
    // Custom install price — fires on blur/Enter (NOT input) so typing stays focused
    const instCustInp = document.getElementById('pricing-inst-custom');
    if (instCustInp) {
        instCustInp.addEventListener('change', e => {
            const raw = (e.target.value || '').toString().trim();
            if (raw === '') {
                delete pricingData.installationCustom;
            } else {
                const v = parseFloat(raw);
                pricingData.installationCustom = isNaN(v) ? '' : v;
            }
            savePricing(); renderPricingPanel();
        });
        // Commit on Enter key too
        instCustInp.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); instCustInp.blur(); }
        });
    }
}

// Re-render only the summary (not rate inputs) to avoid losing focus
// renderPricingSummaryOnly is now just an alias — same logic
function renderPricingSummaryOnly() { renderPricingPanel(); }

// ── Tab switching ─────────────────────────────────────────────
function switchPanelTab(active) {
    ['layout','slab','pricing','costs','registry'].forEach(t => {
        const btn = document.getElementById(`ptab-${t}`);
        if (btn) btn.classList.toggle('active', t === active);
    });
    document.getElementById('layout-panel').style.display    = active === 'layout'   ? '' : 'none';
    document.getElementById('slab-panel').style.display      = active === 'slab'     ? '' : 'none';
    document.getElementById('pricing-panel').style.display   = active === 'pricing'  ? '' : 'none';
    document.getElementById('costs-panel').style.display     = active === 'costs'    ? '' : 'none';
    document.getElementById('registry-panel').style.display  = active === 'registry' ? 'flex' : 'none';
    document.querySelector('.form-panel').classList.toggle('reg-mode', active === 'registry');
    document.getElementById('main-canvas-scroll').style.display = active === 'slab' ? 'none' : '';
    document.getElementById('slab-canvas-wrap').style.display   = active === 'slab' ? 'block' : 'none';
    const tb = document.querySelector('.toolbar');
    const ep = document.getElementById('edge-palette');
    if (tb) tb.style.display = active === 'slab' ? 'none' : '';
    if (ep) ep.style.display = active === 'slab' ? 'none' : (tool === 'edge' ? 'flex' : 'none');
    if (active === 'slab') { syncPageOut(); slabSyncPlacedRefs(); slabRefreshSlabList(); slabRefreshPieceList(); slabRender(); }
    if (active === 'registry') { regRefresh(); }
}
document.getElementById('ptab-layout').addEventListener('click',  () => switchPanelTab('layout'));
document.getElementById('ptab-slab').addEventListener('click',    () => switchPanelTab('slab'));
document.getElementById('ptab-pricing').addEventListener('click', () => {
    switchPanelTab('pricing');
    syncPageOut();
    renderPricingPanel();
});
document.getElementById('ptab-costs').addEventListener('click', () => {
    switchPanelTab('costs');
    renderCostsPanel();
});
document.getElementById('ptab-registry').addEventListener('click', () => switchPanelTab('registry'));

// ══════════════════════════════════════════════════════════════════════
// ── QUOTE REGISTRY ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

let currentQuoteId = localStorage.getItem('spartan_currentQuoteId') || null;  // UUID of the quote being edited
let regQuotes = [];         // cached list of quotes from Supabase
let regFilterStatus = 'all';
let regSearchTerm = '';

// Client-side UUID generator — used so every quote has a STABLE id that
// belongs to the client, not the server. This makes saves idempotent: whether
// the row exists or not, we always target the same id, and if the row is
// missing we can recreate it (see saveQuoteToDb below).
function _uuidv4() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// ── Save-status indicator (top-right toast) ────────────────────────
// Shows "Saving…", "Saved 3:42 PM", or "⚠ Save failed — retry" so the user
// always knows whether their work actually reached the database.
let _saveStatusEl = null;
function _ensureSaveStatusEl() {
    if (_saveStatusEl) return _saveStatusEl;
    const el = document.createElement('div');
    el.id = 'save-status-toast';
    el.style.cssText = 'position:fixed;top:10px;right:14px;z-index:10001;font:600 11px Raleway,sans-serif;padding:6px 10px;border-radius:4px;pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:none;max-width:320px';
    document.body.appendChild(el);
    _saveStatusEl = el;
    return el;
}
function setSaveStatus(state, extra) {
    const el = _ensureSaveStatusEl();
    el.style.display = '';
    if (state === 'saving') {
        el.style.background = '#2a2a2a';
        el.style.color = '#b09030';
        el.style.border = '1px solid #b09030';
        el.innerHTML = '⟳ Saving…';
    } else if (state === 'saved') {
        const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        // Warn loudly when we saved an empty row — that's almost always a bug
        // (user expected to save a quote they filled in but formData was empty).
        const isEmpty = !formData.client && !formData.order && !formData.job;
        const hasShapes = pages.some(p => (p.shapes||[]).length > 0);
        if (isEmpty && !hasShapes) {
            el.style.background = '#3a2a10';
            el.style.color = '#ffcc55';
            el.style.border = '1px solid #cc9930';
            el.innerHTML = `⚠ Saved EMPTY quote · ${ts}<div style="font-weight:400;font-size:9px;margin-top:3px;color:#ffd">No client/order/job/shapes — click Save only AFTER filling in the form</div>`;
            setTimeout(() => { if (_saveStatusEl && el.innerHTML.startsWith('⚠ Saved EMPTY')) el.style.display = 'none'; }, 8000);
        } else {
            el.style.background = '#1f2a0f';
            el.style.color = '#b5d070';
            el.style.border = '1px solid #3a5020';
            const label = formData.client || formData.job || formData.order || `${pages.reduce((n,p)=>n+(p.shapes||[]).length,0)} shapes`;
            el.innerHTML = `✓ Saved · ${ts}<div style="font-weight:400;font-size:9px;margin-top:3px;color:#cfd">${label}</div>`;
            setTimeout(() => { if (_saveStatusEl && el.innerHTML.startsWith('✓')) el.style.display = 'none'; }, 4000);
        }
    } else if (state === 'failed') {
        el.style.background = '#3a1a1a';
        el.style.color = '#ff8888';
        el.style.border = '1px solid #aa3030';
        const msg = (extra || 'unknown error').toString().slice(0, 120);
        el.innerHTML = `⚠ Save failed — <span style="text-decoration:underline;cursor:pointer" onclick="saveQuoteToDb().then(r=>{if(r.ok)setSaveStatus('saved')})">retry</span><div style="font-weight:400;font-size:9px;margin-top:3px;color:#faa">${msg}</div>`;
    } else {
        el.style.display = 'none';
    }
}

// Save current state as a quote to Supabase.
// Returns { ok: true, id } on success, { ok: false, error } on failure.
// Strategy:
//   1. Assign a stable client-generated UUID if none exists.
//   2. If row with that id is missing from the DB (deleted or never inserted),
//      insert it. Otherwise update. Every save path is now idempotent and
//      self-healing — a stale localStorage id won't cause silent data loss.
//   3. On ANY failure, auto-download a JSON backup so the user never loses
//      their work even if Supabase is unreachable.
async function saveQuoteToDb() {
    if (!currentShopId || !currentUserId) return { ok: false, error: 'Not signed in' };
    setSaveStatus('saving');
    saveForm();
    syncPageOut();
    const qData = {
        pages: pages.map(p => ({ id:p.id, name:p.name, shapes:p.shapes, textItems:p.textItems, measurements:p.measurements||[], profileDiags:p.profileDiags||[], nextId:p.nextId })),
        currentPageIdx,
        slabDefs, slabPlaced, _slabNextId
    };
    const fData = { ...formData };
    const pData = { ...pricingData };

    // Diagnostic — surface what's actually being saved + a stack trace so we
    // can identify which code path triggered this save.
    const _diag = {
        formData_client: formData.client,
        formData_order:  formData.order,
        formData_job:    formData.job,
        dom_client: (document.getElementById('f-client') || {}).value,
        dom_order:  (document.getElementById('f-order')  || {}).value,
        dom_job:    (document.getElementById('f-job')    || {}).value,
        shapeCount: pages.reduce((n, p) => n + (p.shapes||[]).length, 0),
        pageCount:  pages.length,
        currentQuoteId,
    };
    console.log('[saveQuoteToDb]', _diag);
    console.trace('[saveQuoteToDb] stack');

    // GUARDRAIL — refuse to UPDATE an existing row with completely empty data.
    // If formData has no client/order/job AND there are no shapes, the user
    // is almost certainly NOT trying to save anything; this guards against
    // the New-Quote-reset → auto-sync race that was clobbering rows.
    const _isEmpty = !formData.client && !formData.order && !formData.job;
    const _hasShapes = pages.some(p => (p.shapes||[]).length > 0);
    if (currentQuoteId && _isEmpty && !_hasShapes) {
        console.warn('[saveQuoteToDb] REFUSED — would clobber existing row', currentQuoteId, 'with empty data');
        setSaveStatus('saved');  // toast still shows; we're "successful" (a no-op)
        return { ok: true, id: currentQuoteId, skipped: true };
    }

    // Ensure we have a stable id. If this is a brand-new quote, mint one
    // locally and persist it so every subsequent save targets the same row.
    // Track whether the id was fresh so we can distinguish normal first-saves
    // from the "row was missing and we had to recreate it" self-heal path.
    const hadExistingId = !!currentQuoteId;
    if (!currentQuoteId) {
        currentQuoteId = _uuidv4();
        localStorage.setItem('spartan_currentQuoteId', currentQuoteId);
    }

    const row = {
        id: currentQuoteId,
        shop_id: currentShopId,
        created_by: currentUserId,
        created_by_email: currentUserEmail || '',
        order_number: formData.order || '',
        job_name: formData.job || '',
        client_name: formData.client || '',
        address: formData.address || '',
        quote_data: qData,
        form_data: fData,
        pricing_data: pData,
        updated_at: new Date().toISOString()
    };

    try {
        // Fresh id → skip the UPDATE attempt (row can't exist) and go straight
        // to INSERT. For existing ids, try UPDATE first; if it affects 0 rows
        // the row is missing (deleted or never persisted) — fall back to INSERT
        // to self-heal under the same id.
        if (hadExistingId) {
            const upd = await _sb.from('quotes').update(row).eq('id', currentQuoteId).select('id');
            if (upd.error) throw upd.error;
            if (upd.data && upd.data.length > 0) {
                setSaveStatus('saved');
                regUpdateCurrentBanner();
                return { ok: true, id: currentQuoteId };
            }
        }
        // Either a brand-new quote, or the row was missing. INSERT it.
        row.status = 'draft';
        const ins = await _sb.from('quotes').insert(row).select('id').single();
        if (ins.error) throw ins.error;
        setSaveStatus('saved');
        regUpdateCurrentBanner();
        return { ok: true, id: currentQuoteId, restored: hadExistingId };
    } catch (err) {
        console.error('saveQuoteToDb failed:', err);
        setSaveStatus('failed', err.message || err.code || String(err));
        // Emergency local backup so the user's work isn't lost even if every
        // save to the cloud fails.
        try { _downloadQuoteJson(); } catch (_) {}
        return { ok: false, error: err.message || String(err) };
    }
}

// Load a quote from Supabase into the app
async function loadQuoteFromDb(quoteId) {
    const { data: q, error: loadErr } = await _sb.from('quotes').select('*').eq('id', quoteId).maybeSingle();
    if (loadErr) { alert('Failed to load quote: ' + (loadErr.message || loadErr)); return; }
    if (!q) { alert('Quote not found — it may have been deleted.'); return; }
    // Restore quote data
    if (q.quote_data) {
        const d = q.quote_data;
        pages = (d.pages||[]).map(p => ({ id:p.id||1, name:p.name||'Page 1', shapes:(p.shapes||[]).map(normalizeShape), textItems:p.textItems||[], measurements:p.measurements||[], profileDiags:p.profileDiags||[], nextId:p.nextId||1, _undo:[] }));
        if (!pages.length) pages = [{ id:1, name:'Page 1', shapes:[], textItems:[], nextId:1, _undo:[] }];
        currentPageIdx = Math.max(0, Math.min(d.currentPageIdx||0, pages.length-1));
        if (d.slabDefs && d.slabDefs.length) slabDefs = d.slabDefs;
        if (d.slabPlaced) slabPlaced = d.slabPlaced;
        if (d._slabNextId) _slabNextId = d._slabNextId;
        syncPageIn();
    }
    // Restore form data
    if (q.form_data) {
        formData = q.form_data;
        if (!formData.phones) formData.phones = [''];
        if (!formData.materials) formData.materials = [];
        matNextId = (formData.materials||[]).reduce((mx,m)=>Math.max(mx,m.id+1),1);
        document.getElementById('f-order').value   = formData.order   || '';
        document.getElementById('f-job').value     = formData.job     || '';
        document.getElementById('f-client').value  = formData.client  || '';
        document.getElementById('f-address').value = formData.address || '';
        document.getElementById('f-date').value    = formData.date    || '';
        document.getElementById('f-notes').value   = formData.notes   || '';
        renderPhones();
        renderMaterials();
    }
    // Restore pricing
    if (q.pricing_data) {
        pricingData = q.pricing_data;
    }
    currentQuoteId = quoteId;
    localStorage.setItem('spartan_currentQuoteId', quoteId);
    _nextPageId = Math.max(...pages.map(p => p.id), 1) + 1;
    renderPageTabs();
    render(); updateStatus();
    regUpdateCurrentBanner();
    switchPanelTab('layout');
}

// Refresh the registry list from Supabase.
// Fetches BOTH active and soft-deleted rows; client-side filter tab chooses
// which bucket to display. Requires the deleted_at column from the
// supabase_migration_soft_delete.sql migration.
async function regRefresh() {
    if (!currentShopId) return;
    const { data, error } = await _sb.from('quotes')
        .select('id, order_number, job_name, client_name, status, created_by_email, created_at, updated_at, deleted_at')
        .eq('shop_id', currentShopId)
        .order('updated_at', { ascending: false });
    if (error) { console.error('regRefresh failed:', error); alert('Failed to load registry: ' + (error.message || error)); return; }
    regQuotes = data || [];
    regRenderList();
}

function regRenderList() {
    const list = document.getElementById('reg-list');
    if (!list) return;
    const viewingTrash = regFilterStatus === 'trash';
    // Active view hides deleted rows; Trash view shows ONLY deleted rows.
    let filtered = viewingTrash
        ? regQuotes.filter(q => q.deleted_at)
        : regQuotes.filter(q => !q.deleted_at);
    if (!viewingTrash && regFilterStatus !== 'all') {
        filtered = filtered.filter(q => q.status === regFilterStatus);
    }
    if (regSearchTerm) {
        const s = regSearchTerm.toLowerCase();
        filtered = filtered.filter(q =>
            (q.client_name||'').toLowerCase().includes(s) ||
            (q.job_name||'').toLowerCase().includes(s) ||
            (q.order_number||'').toLowerCase().includes(s) ||
            (q.created_by_email||'').toLowerCase().includes(s)
        );
    }
    if (!filtered.length) {
        list.innerHTML = `<div style="color:#555;font-size:11px;text-align:center;padding:20px 0">${viewingTrash ? 'Trash is empty.' : (regQuotes.length ? 'No quotes match your search.' : 'No quotes yet. Create one!')}</div>`;
        return;
    }
    list.innerHTML = filtered.map(q => {
        const isActive = q.id === currentQuoteId;
        const date = q.updated_at ? new Date(q.updated_at).toLocaleDateString() : '';
        const rep = (q.created_by_email||'').split('@')[0] || '?';
        const inTrash = !!q.deleted_at;
        const actions = inTrash
            ? `<button onclick="regRestoreQuote('${q.id}')" title="Restore from trash" style="background:#1f2a0f;color:#b5d070;border:1px solid #3a5020">Restore</button>
               <span style="flex:1"></span>
               <span style="color:#888;font-size:9px">deleted ${q.deleted_at ? new Date(q.deleted_at).toLocaleDateString() : ''}</span>`
            : `<button onclick="loadQuoteFromDb('${q.id}')" title="Load this quote">Load</button>
               <select onchange="regSetStatus('${q.id}', this.value)" style="font-size:9px;padding:1px 4px;background:#252525;border:1px solid #333;color:#888;border-radius:3px;font-family:'Raleway',sans-serif">
                   ${['draft','sent','approved','completed','cancelled'].map(s => `<option value="${s}" ${q.status===s?'selected':''}>${s}</option>`).join('')}
               </select>
               <button onclick="regOpenHistory('${q.id}')" title="View &amp; restore previous versions" style="background:#252525;border:1px solid #333;color:#888;font-size:9px;padding:2px 6px;border-radius:3px;cursor:pointer">History</button>
               <button class="reg-del" onclick="regDeleteQuote('${q.id}')" title="Move to trash">✕</button>`;
        return `<div class="reg-card ${isActive ? 'reg-active' : ''}" data-qid="${q.id}" style="${inTrash?'opacity:0.7':''}">
            <div class="reg-card-top">
                <span class="reg-card-client">${q.client_name || '(no client)'}</span>
                <span class="reg-card-order">${q.order_number || ''}</span>
            </div>
            <div class="reg-card-job">${q.job_name || '(no job name)'}</div>
            <div class="reg-card-meta">
                <span>${rep} · ${date}</span>
                <span class="reg-status reg-status-${q.status}">${q.status}</span>
            </div>
            <div class="reg-card-actions">${actions}</div>
        </div>`;
    }).join('');
}

async function regSetStatus(quoteId, status) {
    const { error } = await _sb.from('quotes').update({ status, updated_at: new Date().toISOString() }).eq('id', quoteId);
    if (error) { alert('Failed to update status: ' + (error.message || error)); return; }
    const q = regQuotes.find(q => q.id === quoteId);
    if (q) q.status = status;
    regRenderList();
}

// Soft delete — flags the row with deleted_at. Row stays in the database
// and can be restored from the Trash tab. Hard delete is blocked by RLS
// (see supabase_migration_soft_delete.sql).
async function regDeleteQuote(quoteId) {
    const q = regQuotes.find(x => x.id === quoteId);
    const label = q ? `"${q.client_name || q.job_name || q.order_number || '(no name)'}"` : 'this quote';
    if (!confirm(`Move ${label} to trash?\n\nYou can restore it from the Trash tab.`)) return;
    const { error } = await _sb.from('quotes')
        .update({ deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', quoteId);
    if (error) { alert('Failed to move to trash: ' + (error.message || error)); return; }
    if (currentQuoteId === quoteId) { currentQuoteId = null; localStorage.removeItem('spartan_currentQuoteId'); }
    const rec = regQuotes.find(q => q.id === quoteId);
    if (rec) rec.deleted_at = new Date().toISOString();
    regRenderList();
    regUpdateCurrentBanner();
}

// ── Version history (auto-recovery) ─────────────────────────────
// Backed by quotes_history table + BEFORE UPDATE trigger from
// supabase_migration_quotes_history.sql. Every save snapshots the OLD
// row, so an accidental overwrite is recoverable as long as the
// migration has been applied to Supabase.
let regHistoryQuoteId = null;
let regHistoryRows = [];
let regHistoryHasMore = false;
const REG_HISTORY_PAGE = 50;

async function regOpenHistory(quoteId) {
    if (!currentShopId) return;
    regHistoryQuoteId = quoteId;
    regHistoryRows = [];
    regHistoryHasMore = false;
    await regFetchHistoryPage();
    regShowHistoryModal();
}

// Fetches the next page of history rows (older than the oldest one we have).
async function regFetchHistoryPage() {
    const oldest = regHistoryRows.length ? regHistoryRows[regHistoryRows.length - 1].snapshot_at : null;
    let q = _sb.from('quotes_history')
        .select('history_id, snapshot_at, order_number, job_name, client_name, address, status, created_by_email, updated_at, deleted_at')
        .eq('quote_id', regHistoryQuoteId)
        .order('snapshot_at', { ascending: false })
        .limit(REG_HISTORY_PAGE + 1); // +1 sentinel to know if more exist
    if (oldest) q = q.lt('snapshot_at', oldest);
    const { data, error } = await q;
    if (error) {
        console.error('history fetch failed:', error);
        alert('Failed to load history: ' + (error.message || error) + '\n\nMake sure supabase_migration_quotes_history.sql has been run in the Supabase SQL Editor.');
        return;
    }
    const rows = data || [];
    regHistoryHasMore = rows.length > REG_HISTORY_PAGE;
    if (regHistoryHasMore) rows.pop();
    regHistoryRows = regHistoryRows.concat(rows);
}

async function regLoadMoreHistory() {
    await regFetchHistoryPage();
    regRenderHistoryList();
}

function regShowHistoryModal() {
    let overlay = document.getElementById('reg-history-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'reg-history-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:20000;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = `
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;width:620px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.7);font-family:Raleway,sans-serif">
                <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between">
                    <h3 style="margin:0;color:#e0ddd5;font-size:13px;font-weight:600">Version History</h3>
                    <button id="reg-history-close" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px">&times;</button>
                </div>
                <div id="reg-history-info" style="padding:8px 16px;color:#888;font-size:10px;border-bottom:1px solid #2a2a2a"></div>
                <div id="reg-history-list" style="flex:1;overflow-y:auto;padding:8px"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) regCloseHistory(); });
        document.getElementById('reg-history-close').addEventListener('click', regCloseHistory);
    }
    overlay.style.display = 'flex';
    const info = document.getElementById('reg-history-info');
    const liveQuote = regQuotes.find(q => q.id === regHistoryQuoteId);
    info.textContent = liveQuote
        ? `Snapshots of "${liveQuote.client_name || liveQuote.job_name || liveQuote.order_number || regHistoryQuoteId.slice(0,8)}" — every save snapshots the previous version.`
        : 'Snapshots before each save.';
    regRenderHistoryList();
}

function regRenderHistoryList() {
    const list = document.getElementById('reg-history-list');
    if (!list) return;
    if (!regHistoryRows.length) {
        list.innerHTML = '<div style="color:#666;font-size:11px;text-align:center;padding:24px 0">No history yet — every save will snapshot the previous version.</div>';
        return;
    }
    const rows = regHistoryRows.map(h => {
        const when = new Date(h.snapshot_at).toLocaleString();
        const rep = (h.created_by_email||'').split('@')[0] || '?';
        return `<div style="padding:8px 10px;border:1px solid #2a2a2a;border-radius:4px;margin-bottom:6px;background:#141414">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <div style="min-width:0;flex:1">
                    <div style="color:#ccc;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.client_name || '(no client)'} &mdash; ${h.job_name || '(no job)'}</div>
                    <div style="color:#888;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.order_number || ''} &middot; ${rep} &middot; saved ${when}</div>
                </div>
                <button onclick="regRestoreFromHistory('${h.history_id}')" style="background:#2a2a2a;border:1px solid #555;color:#b09030;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:10px;flex-shrink:0;font-family:Raleway,sans-serif">Restore</button>
            </div>
        </div>`;
    }).join('');
    const loadMore = regHistoryHasMore
        ? `<button onclick="regLoadMoreHistory()" style="width:100%;margin-top:6px;padding:8px;background:#1a1a1a;border:1px dashed #444;color:#888;border-radius:4px;cursor:pointer;font-size:11px;font-family:Raleway,sans-serif">Load older snapshots</button>`
        : `<div style="text-align:center;color:#555;font-size:9px;padding:8px;font-style:italic">${regHistoryRows.length} snapshot${regHistoryRows.length === 1 ? '' : 's'} — that's all of them.</div>`;
    list.innerHTML = rows + loadMore;
}

function regCloseHistory() {
    const overlay = document.getElementById('reg-history-overlay');
    if (overlay) overlay.style.display = 'none';
    regHistoryQuoteId = null;
    regHistoryRows = [];
}

// ── Shop-wide history search ("Find lost quote") ─────────────────
// Searches the entire quotes_history table for the current shop, so a
// quote that was overwritten or deleted entirely (and therefore doesn't
// appear in the live list or the trash) can still be found and resurrected.
let regDbHistoryRows = [];
let regDbHistorySearch = '';
let regDbHistoryHasMore = false;
const REG_DB_HISTORY_PAGE = 50;

async function regOpenDbHistory() {
    if (!currentShopId) { alert('Not signed in.'); return; }
    regDbHistoryRows = [];
    regDbHistorySearch = '';
    regDbHistoryHasMore = false;
    await regFetchDbHistoryPage();
    regShowDbHistoryModal();
}

async function regFetchDbHistoryPage() {
    const oldest = regDbHistoryRows.length ? regDbHistoryRows[regDbHistoryRows.length - 1].snapshot_at : null;
    let q = _sb.from('quotes_history')
        .select('history_id, quote_id, snapshot_at, order_number, job_name, client_name, address, status, created_by_email, deleted_at')
        .eq('shop_id', currentShopId)
        .order('snapshot_at', { ascending: false })
        .limit(REG_DB_HISTORY_PAGE + 1);
    if (oldest) q = q.lt('snapshot_at', oldest);
    if (regDbHistorySearch) {
        const s = `%${regDbHistorySearch.replace(/[%_]/g, m => '\\' + m)}%`;
        q = q.or(`job_name.ilike.${s},client_name.ilike.${s},order_number.ilike.${s},address.ilike.${s},created_by_email.ilike.${s}`);
    }
    const { data, error } = await q;
    if (error) {
        console.error('db-history fetch failed:', error);
        alert('Failed to load history: ' + (error.message || error) + '\n\nMake sure supabase_migration_quotes_history.sql has been run in the Supabase SQL Editor.');
        return;
    }
    const rows = data || [];
    regDbHistoryHasMore = rows.length > REG_DB_HISTORY_PAGE;
    if (regDbHistoryHasMore) rows.pop();
    regDbHistoryRows = regDbHistoryRows.concat(rows);
}

async function regResetDbHistorySearch(term) {
    regDbHistorySearch = (term || '').trim();
    regDbHistoryRows = [];
    regDbHistoryHasMore = false;
    await regFetchDbHistoryPage();
    regRenderDbHistoryList();
}

async function regLoadMoreDbHistory() {
    await regFetchDbHistoryPage();
    regRenderDbHistoryList();
}

function regShowDbHistoryModal() {
    let overlay = document.getElementById('reg-db-history-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'reg-db-history-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.72);z-index:20000;display:flex;align-items:center;justify-content:center';
        overlay.innerHTML = `
            <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;width:680px;max-width:94vw;max-height:84vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,0.7);font-family:Raleway,sans-serif">
                <div style="padding:12px 16px;border-bottom:1px solid #333;display:flex;align-items:center;justify-content:space-between">
                    <div>
                        <h3 style="margin:0;color:#e0ddd5;font-size:13px;font-weight:600">Find Lost Quote</h3>
                        <div style="color:#888;font-size:10px;margin-top:2px">Every save in this shop, newest first. Use this if a quote disappeared or got overwritten.</div>
                    </div>
                    <button id="reg-db-history-close" style="background:none;border:none;color:#888;font-size:20px;cursor:pointer;padding:0 4px">&times;</button>
                </div>
                <div style="padding:8px 16px;border-bottom:1px solid #2a2a2a">
                    <input id="reg-db-history-search" type="text" placeholder="Search client, job, order #, address, rep..." style="width:100%;padding:6px 8px;background:#0e0e0e;border:1px solid #333;color:#e0ddd5;border-radius:3px;font-size:11px;font-family:Raleway,sans-serif">
                </div>
                <div id="reg-db-history-list" style="flex:1;overflow-y:auto;padding:8px"></div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', e => { if (e.target === overlay) regCloseDbHistory(); });
        document.getElementById('reg-db-history-close').addEventListener('click', regCloseDbHistory);
        const searchInp = document.getElementById('reg-db-history-search');
        let _to = null;
        searchInp.addEventListener('input', e => {
            clearTimeout(_to);
            const v = e.target.value;
            _to = setTimeout(() => regResetDbHistorySearch(v), 250);
        });
    }
    overlay.style.display = 'flex';
    regRenderDbHistoryList();
}

function regCloseDbHistory() {
    const overlay = document.getElementById('reg-db-history-overlay');
    if (overlay) overlay.style.display = 'none';
    regDbHistoryRows = [];
    regDbHistorySearch = '';
}

function regRenderDbHistoryList() {
    const list = document.getElementById('reg-db-history-list');
    if (!list) return;
    if (!regDbHistoryRows.length) {
        list.innerHTML = `<div style="color:#666;font-size:11px;text-align:center;padding:24px 0">${regDbHistorySearch ? 'No snapshots match this search.' : 'No history yet.'}</div>`;
        return;
    }
    // Tag whether the live quote still exists in the local registry (active or trash).
    const liveIds = new Set(regQuotes.map(q => q.id));
    const trashIds = new Set(regQuotes.filter(q => q.deleted_at).map(q => q.id));
    const rows = regDbHistoryRows.map(h => {
        const when = new Date(h.snapshot_at).toLocaleString();
        const rep = (h.created_by_email||'').split('@')[0] || '?';
        let tag = '';
        if (!liveIds.has(h.quote_id)) tag = `<span style="color:#cc6666;font-size:9px;margin-left:6px;border:1px solid #553030;padding:1px 4px;border-radius:2px">missing</span>`;
        else if (trashIds.has(h.quote_id)) tag = `<span style="color:#aa7777;font-size:9px;margin-left:6px;border:1px solid #503838;padding:1px 4px;border-radius:2px">in trash</span>`;
        return `<div style="padding:8px 10px;border:1px solid #2a2a2a;border-radius:4px;margin-bottom:6px;background:#141414">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
                <div style="min-width:0;flex:1">
                    <div style="color:#ccc;font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.client_name || '(no client)'} &mdash; ${h.job_name || '(no job)'}${tag}</div>
                    <div style="color:#888;font-size:9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${h.order_number || ''} &middot; ${rep} &middot; saved ${when} &middot; <span style="color:#555">id:${(h.quote_id||'').slice(0,8)}</span></div>
                </div>
                <button onclick="regRestoreFromDbHistory('${h.history_id}')" style="background:#2a2a2a;border:1px solid #555;color:#b09030;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:10px;flex-shrink:0;font-family:Raleway,sans-serif">Restore</button>
            </div>
        </div>`;
    }).join('');
    const loadMore = regDbHistoryHasMore
        ? `<button onclick="regLoadMoreDbHistory()" style="width:100%;margin-top:6px;padding:8px;background:#1a1a1a;border:1px dashed #444;color:#888;border-radius:4px;cursor:pointer;font-size:11px;font-family:Raleway,sans-serif">Load older snapshots</button>`
        : `<div style="text-align:center;color:#555;font-size:9px;padding:8px;font-style:italic">${regDbHistoryRows.length} snapshot${regDbHistoryRows.length === 1 ? '' : 's'} loaded — that's everything matching.</div>`;
    list.innerHTML = rows + loadMore;
}

async function regRestoreFromDbHistory(historyId) {
    const h = regDbHistoryRows.find(r => r.history_id === historyId);
    if (!h) return;
    const lbl = `${h.client_name || '(no client)'} \u2014 ${h.job_name || '(no job)'}`;
    const restoredId = await regRestoreFromHistorySnapshot(historyId, lbl);
    if (!restoredId) return;
    regCloseDbHistory();
    await regRefresh();
    alert(`Restored "${lbl}". You can find it in the active quotes list.`);
}

// Resurrects a quote from a history snapshot. Works whether the live row
// still exists, was soft-deleted, or was hard-deleted entirely. Uses UPSERT
// keyed on quote_id so an empty quotes table still gets the row back.
async function regRestoreFromHistorySnapshot(historyId, sourceLabel) {
    const { data: full, error: fetchErr } = await _sb.from('quotes_history')
        .select('quote_id, shop_id, snapshot_at, order_number, job_name, client_name, address, status, quote_data, form_data, pricing_data, created_by, created_by_email, created_at')
        .eq('history_id', historyId)
        .single();
    if (fetchErr || !full) {
        alert('Failed to fetch snapshot: ' + ((fetchErr && fetchErr.message) || 'not found'));
        return false;
    }
    const when = new Date(full.snapshot_at).toLocaleString();
    const lbl = sourceLabel || `${full.client_name || '(no client)'} \u2014 ${full.job_name || '(no job)'}`;
    if (!confirm(`Restore this version?\n\n${lbl}\nSaved ${when}\n\nIf the quote was deleted, it will be recreated. If it still exists, the current version is snapshotted to history first (reversible).`)) return false;
    const { error: upErr } = await _sb.from('quotes').upsert({
        id:               full.quote_id,
        shop_id:          full.shop_id,
        created_by:       full.created_by,
        created_by_email: full.created_by_email,
        created_at:       full.created_at,
        order_number:     full.order_number,
        job_name:         full.job_name,
        client_name:      full.client_name,
        address:          full.address,
        status:           full.status || 'draft',
        quote_data:       full.quote_data,
        form_data:        full.form_data,
        pricing_data:     full.pricing_data,
        updated_at:       new Date().toISOString(),
        deleted_at:       null
    }, { onConflict: 'id' });
    if (upErr) {
        alert('Restore failed: ' + (upErr.message || upErr));
        return false;
    }
    return full.quote_id;
}

async function regRestoreFromHistory(historyId) {
    const h = regHistoryRows.find(r => r.history_id === historyId);
    if (!h) return;
    const restoredId = await regRestoreFromHistorySnapshot(historyId);
    if (!restoredId) return;
    regCloseHistory();
    await regRefresh();
    if (currentQuoteId === restoredId) {
        await loadQuoteFromDb(restoredId);
    }
    alert('Restored. The previous version was saved to history before the restore.');
}

// Restore a soft-deleted quote back into the active list.
async function regRestoreQuote(quoteId) {
    const { error } = await _sb.from('quotes')
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .eq('id', quoteId);
    if (error) { alert('Failed to restore: ' + (error.message || error)); return; }
    const rec = regQuotes.find(q => q.id === quoteId);
    if (rec) rec.deleted_at = null;
    regRenderList();
}

function regUpdateCurrentBanner() {
    const wrap = document.getElementById('reg-current');
    const nameEl = document.getElementById('reg-current-name');
    const metaEl = document.getElementById('reg-current-meta');
    if (!wrap) return;
    if (currentQuoteId) {
        const q = regQuotes.find(q => q.id === currentQuoteId);
        wrap.style.display = '';
        nameEl.textContent = (formData.client || formData.job || 'Untitled Quote');
        metaEl.textContent = q ? `${q.order_number || 'No order #'} · ${q.status}` : '';
    } else {
        wrap.style.display = 'none';
    }
}

// Search + filter wiring
document.getElementById('reg-search').addEventListener('input', e => {
    regSearchTerm = e.target.value.trim();
    regRenderList();
});
document.querySelectorAll('.reg-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.reg-filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        regFilterStatus = btn.dataset.status;
        regRenderList();
    });
});
document.getElementById('reg-refresh-btn').addEventListener('click', regRefresh);
document.getElementById('reg-find-lost-btn').addEventListener('click', regOpenDbHistory);
document.getElementById('reg-new-btn').addEventListener('click', async () => {
    console.log('[NEW QUOTE] click — currentQuoteId at start:', currentQuoteId);
    if (currentQuoteId && !confirm('Start a new quote? Current work will be saved first.')) {
        console.log('[NEW QUOTE] aborted at first confirm');
        return;
    }
    if (currentQuoteId) {
        console.log('[NEW QUOTE] saving current quote before reset...');
        const r = await saveQuoteToDb();
        console.log('[NEW QUOTE] save returned:', r);
        if (!r || !r.ok) {
            if (!confirm('Save failed (a JSON backup was downloaded). Continue starting a new quote anyway? Your current work may be lost.')) {
                console.log('[NEW QUOTE] aborted at second confirm');
                return;
            }
        }
    }
    console.log('[NEW QUOTE] running reset…');
    currentQuoteId = null;
    localStorage.removeItem('spartan_currentQuoteId');
    pages = [{ id:1, name:'Page 1', shapes:[], textItems:[], measurements:[], nextId:1, _undo:[] }];
    currentPageIdx = 0; _nextPageId = 2;
    formData = { order:'', job:'', client:'', address:'', date:'', phones:[''], notes:'', materials:[] };
    matNextId = 1;
    document.getElementById('f-order').value = '';
    document.getElementById('f-job').value = '';
    document.getElementById('f-client').value = '';
    document.getElementById('f-address').value = '';
    document.getElementById('f-date').value = '';
    document.getElementById('f-notes').value = '';
    renderPhones(); renderMaterials();
    syncPageIn(); renderPageTabs(); render(); updateStatus();
    regUpdateCurrentBanner();
    switchPanelTab('layout');
    console.log('[NEW QUOTE] reset complete — currentQuoteId:', currentQuoteId, 'localStorage:', localStorage.getItem('spartan_currentQuoteId'));
});

// ══════════════════════════════════════════════════════════════════════
// ── SLAB LAYOUT ENGINE ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

// Each slab: { w, h, deadZone }  (inches)
// placedPieces: [{ slabIdx, pieceRef:{pageIdx,shapeIdx}, x, y, rotated, id }]
// x,y are inches from top-left of slab (inside dead zone origin)

let slabDefs = [{ w: 126, h: 63, deadZone: 0.5 }]; // default one 10.5' x 5.25' slab
let slabPlaced = [];       // placed piece instances
let slabSelected = null;   // id of selected placed piece
let slabPickingPiece = null; // { pageIdx, shapeIdx } — piece being placed
let _slabNextId = 1;
// ── Slab remnant measure tool ─────────────────────────────────
let slabRemnantMode = false;          // tool active
let slabRemnantPoints = [];           // in-progress points (slab-local inches)
let slabRemnantSlabIdx = null;        // slab being measured
let slabRemnantHover = null;          // {slabIdx,x,y,valid}
let slabRemnantSelected = null;       // {slabIdx, idx}
let slabIncludeRemnantsInPdf = true;  // toggle for Layout PDF
let _slabSkipRemnantsInRender = false; // internal: skip remnants during one render call
let slabTransparent = false; // transparency toggle

// ── helpers ───────────────────────────────────────────────────────────
// ref = { pageIdx, shapeIdx, label, wi, hi, shapeType, segIdx (or null) }
// wi/hi and label are stored directly in the ref so segments work independently.

function slabGetPieceWH(ref, rotation) {
    const wi = ref.wi || 0;
    const hi = ref.hi || 0;
    const r = rotation || 0;
    return (r === 1 || r === 3) ? { w: hi, h: wi } : { w: wi, h: hi };
}

function slabGetPieceLabel(ref) {
    return ref.label || '?';
}

function slabGetPieceColor(ref) {
    const page = pages[ref.pageIdx];
    if (!page) return '#555';
    const s = page.shapes[ref.shapeIdx];
    if (!s) return '#555';
    return s.fill || '#cccccc';
}

const SEG_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const SLAB_KERF   = 0.5; // inches — saw clearance around every piece

// ── Generic polygon clipping (Sutherland-Hodgman, axis-aligned) ───────
function _clipPolyAxis(poly, val, isMax, axisX) {
    // Clips polygon to x≤val (isMax=true, axisX=true), x≥val (isMax=false, axisX=true),
    // y≤val or y≥val similarly.
    if (!poly.length) return [];
    const inside = p => axisX ? (isMax ? p[0]<=val : p[0]>=val) : (isMax ? p[1]<=val : p[1]>=val);
    const intersect = (a, b) => {
        const ax=a[0],ay=a[1],bx=b[0],by=b[1];
        if (axisX) { const t=(val-ax)/(bx-ax); return [val, ay+t*(by-ay)]; }
        else        { const t=(val-ay)/(by-ay); return [ax+t*(bx-ax), val]; }
    };
    const out = [];
    for (let i=0; i<poly.length; i++) {
        const cur=poly[i], nxt=poly[(i+1)%poly.length];
        const ci=inside(cur), ni=inside(nxt);
        if (ci) out.push(cur);
        if (ci!==ni) out.push(intersect(cur,nxt));
    }
    return out;
}
function clipPolyToStrip(poly, lo, hi, axisX) {
    return _clipPolyAxis(_clipPolyAxis(poly, lo, false, axisX), hi, true, axisX);
}

// Clips a polygon to one side of an arbitrary line (Sutherland-Hodgman).
// p1, p2 define the directed line. side > 0 keeps the half where the cross
// product (p2-p1) × (pt-p1) is positive (right side of the directed line).
function clipPolyByHalfPlane(poly, p1, p2, side) {
    if (!poly || poly.length < 3) return [];
    const eps = 1e-7;
    const isInside = (pt) => {
        const cross = (p2[0]-p1[0])*(pt[1]-p1[1]) - (p2[1]-p1[1])*(pt[0]-p1[0]);
        return side > 0 ? cross >= -eps : cross <= eps;
    };
    const lineIntersect = (a, b) => {
        const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
        const x3 = a[0],  y3 = a[1],  x4 = b[0],  y4 = b[1];
        const denom = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
        if (Math.abs(denom) < 1e-9) return a;
        const t = ((x1-x3)*(y3-y4) - (y1-y3)*(x3-x4)) / denom;
        return [x1 + t*(x2-x1), y1 + t*(y2-y1)];
    };
    const out = [];
    let prev = poly[poly.length - 1];
    for (const cur of poly) {
        const inCur = isInside(cur);
        const inPrev = isInside(prev);
        if (inCur) {
            if (!inPrev) out.push(lineIntersect(prev, cur));
            out.push(cur);
        } else if (inPrev) {
            out.push(lineIntersect(prev, cur));
        }
        prev = cur;
    }
    return out;
}

// Returns shape polygon in shape-local INCHES (origin = shape top-left corner)
// Inject farmhouse sink notch into a local-inches polygon for L/U shapes.
// The polygon is in shape-local inches (shape.x,y subtracted, divided by INCH).
function injectFsNotchInchesLocal(poly, s) {
    if (!s.farmSink || s.farmSink.edge !== 'seg') return poly;
    const segIdx = parseInt(String(s.farmSink.segKey || 'seg0').replace('seg',''), 10);
    if (!(segIdx >= 0 && segIdx < poly.length)) return poly;
    const cxIn  = s.farmSink.cx / INCH;
    const segYIn = s.farmSink.segY / INCH;
    const dir = s.farmSink.dir || 1;
    const cur = poly[segIdx];
    const nxt = poly[(segIdx + 1) % poly.length];
    const isHoriz = Math.abs(cur[1] - nxt[1]) < 0.005;
    const isVert  = Math.abs(cur[0] - nxt[0]) < 0.005;
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        out.push(poly[i]);
        if (i === segIdx) {
            if (isHoriz) {
                // cxIn = x along segment, segYIn = y of segment.
                const fsLx = cxIn - FS_WIDTH_IN/2, fsRx = cxIn + FS_WIDTH_IN/2;
                const notchYIn = segYIn + FS_DEPTH_IN * dir;
                const goingRight = nxt[0] > cur[0];
                if (goingRight) {
                    out.push([fsLx, segYIn]);
                    out.push([fsLx, notchYIn]);
                    out.push([fsRx, notchYIn]);
                    out.push([fsRx, segYIn]);
                } else {
                    out.push([fsRx, segYIn]);
                    out.push([fsRx, notchYIn]);
                    out.push([fsLx, notchYIn]);
                    out.push([fsLx, segYIn]);
                }
            } else if (isVert) {
                // cxIn = y along segment, segYIn = x of segment.
                const fsT = cxIn - FS_WIDTH_IN/2, fsB = cxIn + FS_WIDTH_IN/2;
                const notchXIn = segYIn + FS_DEPTH_IN * dir;
                const goingDown = nxt[1] > cur[1];
                if (goingDown) {
                    out.push([segYIn, fsT]);
                    out.push([notchXIn, fsT]);
                    out.push([notchXIn, fsB]);
                    out.push([segYIn, fsB]);
                } else {
                    out.push([segYIn, fsB]);
                    out.push([notchXIn, fsB]);
                    out.push([notchXIn, fsT]);
                    out.push([segYIn, fsT]);
                }
            }
        }
    }
    return out;
}

// Build a shape-local inches polygon for a plain rect with checks.
// Walks the 4 edges CW and injects a U-shaped notch for each check on that edge.
function buildRectPolyWithChecks(s) {
    const wi = s.w / INCH, hi = s.h / INCH;
    const byCorner = { nw: null, ne: null, se: null, sw: null };
    for (const c of (s.checks || [])) {
        if (byCorner.hasOwnProperty(c.cornerKey)) {
            byCorner[c.cornerKey] = { wIn: c.w / INCH, dIn: c.d / INCH };
        }
    }
    const out = [];
    // Walk CW starting at (or near) the top-left corner.
    // NW corner: if notched, enter the top edge at (nw.w, 0) instead of (0,0).
    if (byCorner.nw) out.push([byCorner.nw.wIn, 0]);
    else             out.push([0, 0]);
    // Top edge → NE corner
    if (byCorner.ne) {
        out.push([wi - byCorner.ne.wIn, 0]);
        out.push([wi - byCorner.ne.wIn, byCorner.ne.dIn]);
        out.push([wi,                    byCorner.ne.dIn]);
    } else {
        out.push([wi, 0]);
    }
    // Right edge → SE corner
    if (byCorner.se) {
        out.push([wi,                    hi - byCorner.se.dIn]);
        out.push([wi - byCorner.se.wIn,  hi - byCorner.se.dIn]);
        out.push([wi - byCorner.se.wIn,  hi]);
    } else {
        out.push([wi, hi]);
    }
    // Bottom edge → SW corner
    if (byCorner.sw) {
        out.push([byCorner.sw.wIn, hi]);
        out.push([byCorner.sw.wIn, hi - byCorner.sw.dIn]);
        out.push([0,               hi - byCorner.sw.dIn]);
    } else {
        out.push([0, hi]);
    }
    // Left edge → back to NW corner (close the loop)
    if (byCorner.nw) {
        out.push([0,                    byCorner.nw.dIn]);
        out.push([byCorner.nw.wIn,      byCorner.nw.dIn]);
    }
    return out;
}

// Indices of convex vertices on a CW polygon (in screen coords, y-down).
// These are the corners that can take a rectangular check notch.
function convexVertexIndices(poly) {
    const out = [];
    const n = poly.length;
    for (let i = 0; i < n; i++) {
        const P = poly[(i - 1 + n) % n];
        const V = poly[i];
        const N = poly[(i + 1) % n];
        const inx = V[0] - P[0], iny = V[1] - P[1];
        const outx = N[0] - V[0], outy = N[1] - V[1];
        if (inx * outy - iny * outx > 0) out.push(i);
    }
    return out;
}

// Compute A (entry on incoming edge), B (exit on outgoing edge), and C
// (interior corner) for a rectangular notch cut at polygon vertex i.
function cornerCheckPoints(basePoly, i, check) {
    const n = basePoly.length;
    const P = basePoly[(i - 1 + n) % n];
    const V = basePoly[i];
    const N = basePoly[(i + 1) % n];
    const inLen = Math.hypot(V[0] - P[0], V[1] - P[1]);
    const outLen = Math.hypot(N[0] - V[0], N[1] - V[1]);
    if (inLen < 1 || outLen < 1) return null;
    const W = Math.min(check.w, inLen - 0.5);
    const D = Math.min(check.d, outLen - 0.5);
    const inDx = (V[0] - P[0]) / inLen, inDy = (V[1] - P[1]) / inLen;
    const outDx = (N[0] - V[0]) / outLen, outDy = (N[1] - V[1]) / outLen;
    const A = [V[0] - W * inDx,              V[1] - W * inDy];
    const B = [V[0] + D * outDx,             V[1] + D * outDy];
    const C = [V[0] - W * inDx + D * outDx,  V[1] - W * inDy + D * outDy];
    return { A, B, C };
}

// Inject corner-check notches into a general polygon (for L/U shapes).
// Each check has { vertexIdx, w, d } keyed by its polygon index.
function injectCornerChecks(poly, checks) {
    const byIdx = new Map();
    for (const c of (checks || [])) {
        if (c.vertexIdx != null) byIdx.set(c.vertexIdx, c);
    }
    if (byIdx.size === 0) return poly.slice();
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const c = byIdx.get(i);
        if (!c) { out.push(poly[i]); continue; }
        const pts = cornerCheckPoints(poly, i, c);
        if (!pts) { out.push(poly[i]); continue; }
        out.push(pts.A, pts.C, pts.B);
    }
    return out;
}

function shapeLocalPolyInches(s) {
    const st = s.shapeType || 'rect';
    const toLocal = pts => pts.map(([x,y]) => [(x - s.x)/INCH, (y - s.y)/INCH]);
    if (st === 'l')   return injectFsNotchInchesLocal(toLocal(injectCornerChecks(lShapePolygon(s), s.checks)), s);
    if (st === 'u')   return injectFsNotchInchesLocal(toLocal(injectCornerChecks(uShapePolygon(s), s.checks)), s);
    if (st === 'bsp') return toLocal(bspPolygon(s));
    if (st === 'circle') {
        // 32-point polygon approximation of the circle for kerf/collision
        const ri = s.w / 2 / INCH; // radius in inches
        const cx = ri, cy = ri;    // center in shape-local inches
        const N = 32;
        const pts = [];
        for (let i = 0; i < N; i++) {
            const a = (i / N) * Math.PI * 2;
            pts.push([cx + ri * Math.cos(a), cy + ri * Math.sin(a)]);
        }
        return pts;
    }
    // rect / fallback — include chamfers and radii in polygon
    const wi=s.w/INCH, hi=s.h/INCH;
    const r=shapeRadii(s), ch=shapeChamfers(s), chB=shapeChamfersB(s);
    const hasChamfer = ch.nw||ch.ne||ch.se||ch.sw;
    const hasRadius  = r.nw||r.ne||r.se||r.sw;
    const hasFS      = !!s.farmSink;
    const hasChecks  = (s.checks || []).length > 0;
    if (!hasChamfer && !hasRadius && !hasFS && !hasChecks) return [[0,0],[wi,0],[wi,hi],[0,hi]];
    // Plain rect with ONLY checks (no corner treatments / farm sink) → build
    // polygon by walking each edge and injecting check notches along the way.
    if (!hasChamfer && !hasRadius && !hasFS && hasChecks) {
        return buildRectPolyWithChecks(s);
    }

    const pts = [];
    const toIn = v => v / INCH; // canvas px → inches
    // Helper: approximate a rounded corner with N arc segments
    function arcPts(cx, cy, ri, startA, endA) {
        const N = 8, out = [];
        for (let i = 0; i <= N; i++) {
            const a = startA + (endA - startA) * (i / N);
            out.push([cx + ri * Math.cos(a), cy + ri * Math.sin(a)]);
        }
        return out;
    }

    // FS notch geometry (in inches, local). FS_WIDTH/FS_DEPTH conventions:
    //   horizontal edges (top/bottom): cx is x along edge, notch is W wide × D deep.
    //   vertical edges (right/left):   cx is y along edge, notch is W tall × D deep.
    const fsEdge = hasFS ? s.farmSink.edge : null;
    const fsCxIn = hasFS ? toIn(s.farmSink.cx) : 0;
    const fsT = fsCxIn - FS_WIDTH_IN/2, fsB = fsCxIn + FS_WIDTH_IN/2;

    // NW corner
    if (ch.nw > 0) { pts.push([0, toIn(chB.nw)]); pts.push([toIn(ch.nw), 0]); }
    else if (r.nw > 0) { const ri=toIn(r.nw); pts.push(...arcPts(ri, ri, ri, Math.PI, Math.PI*1.5)); }
    else pts.push([0, 0]);

    if (fsEdge === 'top') {
        pts.push([fsT, 0]);
        pts.push([fsT, FS_DEPTH_IN]);
        pts.push([fsB, FS_DEPTH_IN]);
        pts.push([fsB, 0]);
    }

    // NE corner
    if (ch.ne > 0) { pts.push([wi - toIn(ch.ne), 0]); pts.push([wi, toIn(chB.ne)]); }
    else if (r.ne > 0) { const ri=toIn(r.ne); pts.push(...arcPts(wi-ri, ri, ri, Math.PI*1.5, Math.PI*2)); }
    else pts.push([wi, 0]);

    if (fsEdge === 'right') {
        pts.push([wi, fsT]);
        pts.push([wi - FS_DEPTH_IN, fsT]);
        pts.push([wi - FS_DEPTH_IN, fsB]);
        pts.push([wi, fsB]);
    }

    // SE corner
    if (ch.se > 0) { pts.push([wi, hi - toIn(ch.se)]); pts.push([wi - toIn(chB.se), hi]); }
    else if (r.se > 0) { const ri=toIn(r.se); pts.push(...arcPts(wi-ri, hi-ri, ri, 0, Math.PI*0.5)); }
    else pts.push([wi, hi]);

    if (fsEdge === 'bottom') {
        pts.push([fsB, hi]);
        pts.push([fsB, hi - FS_DEPTH_IN]);
        pts.push([fsT, hi - FS_DEPTH_IN]);
        pts.push([fsT, hi]);
    }

    // SW corner
    if (ch.sw > 0) { pts.push([toIn(ch.sw), hi]); pts.push([0, hi - toIn(chB.sw)]); }
    else if (r.sw > 0) { const ri=toIn(r.sw); pts.push(...arcPts(ri, hi-ri, ri, Math.PI*0.5, Math.PI)); }
    else pts.push([0, hi]);

    if (fsEdge === 'left') {
        pts.push([0, fsB]);
        pts.push([FS_DEPTH_IN, fsB]);
        pts.push([FS_DEPTH_IN, fsT]);
        pts.push([0, fsT]);
    }

    return pts;
}

// Clips shape to a vertical or horizontal strip [lo..hi] (inches from shape origin).
// Returns { poly, segW, segH } where poly is in strip-local inches (origin = strip top-left).
// Returns null if the clipped area is empty.
function clipShapeToStrip(s, lo, hi, axisX) {
    const basePoly = shapeLocalPolyInches(s);
    const clipped  = clipPolyToStrip(basePoly, lo, hi, axisX);
    if (clipped.length < 3) return null;
    const xs = clipped.map(p=>p[0]), ys = clipped.map(p=>p[1]);
    const minX=Math.min(...xs), maxX=Math.max(...xs);
    const minY=Math.min(...ys), maxY=Math.max(...ys);
    // Translate to strip-local origin
    const poly = clipped.map(([x,y]) => [+(x-minX).toFixed(6), +(y-minY).toFixed(6)]);
    const segW = +(maxX-minX).toFixed(6), segH = +(maxY-minY).toFixed(6);
    // Is it just a rectangle? (4 points at corners)
    const isRect = poly.length===4 &&
        poly.every(([x,y]) => (Math.abs(x)<1e-4||Math.abs(x-segW)<1e-4) &&
                               (Math.abs(y)<1e-4||Math.abs(y-segH)<1e-4));
    return { poly: isRect ? null : poly, segW, segH };
}

// ── Polygon-based kerf collision helpers ─────────────────────────────
// Returns piece polygon in slab-local INCHES with rotation applied.
function piecePolyInches(x, y, ref, rotation) {
    const rot = rotation || 0;
    const wi = ref.wi || 0, hi = ref.hi || 0;
    let base;
    if (ref.segPoly) {
        base = ref.segPoly;
    } else if (ref.segIdx != null) {
        // Jointed segment that's a plain rectangle — use segment dimensions, not parent shape
        base = [[0,0],[wi,0],[wi,hi],[0,hi]];
    } else {
        const page = pages[ref.pageIdx];
        const shape = page && page.shapes[ref.shapeIdx];
        base = shape ? shapeLocalPolyInches(shape) : [[0,0],[wi,0],[wi,hi],[0,hi]];
    }
    const rotPt = ([lx, ly]) => {
        switch(rot) {
            case 1: return [hi - ly, lx];
            case 2: return [wi - lx, hi - ly];
            case 3: return [ly, wi - lx];
            default: return [lx, ly];
        }
    };
    return base.map(pt => { const [rx, ry] = rotPt(pt); return [rx + x, ry + y]; });
}

function _ptInPoly(pt, poly) {
    let inside = false;
    const px = pt[0], py = pt[1];
    for (let i = 0, j = poly.length-1; i < poly.length; j = i++) {
        const xi=poly[i][0], yi=poly[i][1], xj=poly[j][0], yj=poly[j][1];
        if (((yi > py) !== (yj > py)) && px < (xj-xi)*(py-yi)/(yj-yi)+xi) inside = !inside;
    }
    return inside;
}

function _ptSegDist(p1, p2, q) {
    const dx=p2[0]-p1[0], dy=p2[1]-p1[1], len2=dx*dx+dy*dy;
    if (len2 < 1e-12) return Math.hypot(q[0]-p1[0], q[1]-p1[1]);
    const t = Math.max(0, Math.min(1, ((q[0]-p1[0])*dx+(q[1]-p1[1])*dy)/len2));
    return Math.hypot(q[0]-(p1[0]+t*dx), q[1]-(p1[1]+t*dy));
}

function polyMinDist(polyA, polyB) {
    if (_ptInPoly(polyA[0], polyB) || _ptInPoly(polyB[0], polyA)) return 0;
    let minD = Infinity;
    for (let i = 0; i < polyA.length; i++) {
        const a1=polyA[i], a2=polyA[(i+1)%polyA.length];
        for (let j = 0; j < polyB.length; j++) {
            const b1=polyB[j], b2=polyB[(j+1)%polyB.length];
            minD = Math.min(minD, _ptSegDist(a1,a2,b1), _ptSegDist(b1,b2,a1));
        }
    }
    return minD;
}

// Returns true if placing (w×h at x,y) violates SLAB_KERF clearance.
// inRef/inRot: shape data for the incoming piece (enables polygon check).
function slabPieceOverlaps(slabIdx, x, y, w, h, excludeId, inRef, inRot) {
    for (const p of slabPlaced) {
        if (p.id === excludeId || p.slabIdx !== slabIdx) continue;
        const { w:pw, h:ph } = slabGetPieceWH(p.ref, p.rotation||0);
        // Conservative AABB reject — if bboxes expanded by kerf don't touch, skip
        if (x+w+SLAB_KERF <= p.x || x-SLAB_KERF >= p.x+pw ||
            y+h+SLAB_KERF <= p.y || y-SLAB_KERF >= p.y+ph) continue;
        // Exact polygon distance check when shape data available
        if (inRef) {
            const polyA = piecePolyInches(x, y, inRef, inRot||0);
            const polyB = piecePolyInches(p.x, p.y, p.ref, p.rotation||0);
            if (polyMinDist(polyA, polyB) < SLAB_KERF) return true;
        } else {
            return true;
        }
    }
    return false;
}

// Returns true if any part of the piece extends into the dead zone of its slab.
function slabPieceInDeadZone(slabIdx, x, y, w, h, ref, rotation) {
    const sd = slabDefs[slabIdx];
    if (!sd) return false;
    const dz = sd.deadZone || 0;
    if (dz <= 0) return false;
    // Usable area in slab-local inches (piece coords are relative to the inside of the dead zone)
    const usableW = sd.w - 2 * dz;
    const usableH = sd.h - 2 * dz;
    // Check polygon vertices if available
    if (ref) {
        const poly = piecePolyInches(x, y, ref, rotation || 0);
        for (const [px, py] of poly) {
            if (px < 0 || py < 0 || px > usableW || py > usableH) return true;
        }
        return false;
    }
    // Fallback: bounding box check
    return x < 0 || y < 0 || x + w > usableW || y + h > usableH;
}

// Decompose an axis-aligned shape into non-overlapping rectangles in shape-local
// inches. Returns null for shapes that can't be cleanly decomposed (chamfered,
// rounded, circle, farmSink present, etc.) — those still go through the
// Sutherland-Hodgman fallback in slabAllPieces.
// Subtract rect B from rect A. Returns 0–4 sub-rects covering A \ B.
// Used to carve a farm-sink hole out of an L/U/BSP rect decomposition so
// the slab pieces include the cutout cleanly without resorting to SH
// clipping (which produces bowtie polygons on concave shapes).
function subtractRect(A, B) {
    const ax2 = A.x + A.w, ay2 = A.y + A.h;
    const bx2 = B.x + B.w, by2 = B.y + B.h;
    const cx1 = Math.max(A.x, B.x), cx2 = Math.min(ax2, bx2);
    const cy1 = Math.max(A.y, B.y), cy2 = Math.min(ay2, by2);
    if (cx1 >= cx2 - 1e-6 || cy1 >= cy2 - 1e-6) return [A]; // no overlap
    const out = [];
    if (A.y < cy1 - 1e-6) out.push({ x: A.x, y: A.y, w: A.w,        h: cy1 - A.y  });
    if (cy2 < ay2 - 1e-6) out.push({ x: A.x, y: cy2, w: A.w,        h: ay2 - cy2  });
    if (A.x < cx1 - 1e-6) out.push({ x: A.x, y: cy1, w: cx1 - A.x,  h: cy2 - cy1  });
    if (cx2 < ax2 - 1e-6) out.push({ x: cx2, y: cy1, w: ax2 - cx2,  h: cy2 - cy1  });
    return out.filter(r => r.w > 1e-6 && r.h > 1e-6);
}

// Returns the farm-sink cutout rect in shape-local inches, or null if there
// isn't one. Works for both rect (edge: 'top'|'bottom') and L/U (edge:'seg').
function fsRectLocalInches(s) {
    if (!s.farmSink) return null;
    const fs = s.farmSink;
    if (fs.edge === 'top') {
        return { x: fs.cx/INCH - FS_WIDTH_IN/2, y: 0, w: FS_WIDTH_IN, h: FS_DEPTH_IN };
    }
    if (fs.edge === 'bottom') {
        return { x: fs.cx/INCH - FS_WIDTH_IN/2, y: s.h/INCH - FS_DEPTH_IN, w: FS_WIDTH_IN, h: FS_DEPTH_IN };
    }
    if (fs.edge === 'right') {
        return { x: s.w/INCH - FS_DEPTH_IN, y: fs.cx/INCH - FS_WIDTH_IN/2, w: FS_DEPTH_IN, h: FS_WIDTH_IN };
    }
    if (fs.edge === 'left') {
        return { x: 0, y: fs.cx/INCH - FS_WIDTH_IN/2, w: FS_DEPTH_IN, h: FS_WIDTH_IN };
    }
    if (fs.edge === 'seg') {
        // Orientation depends on the polygon segment. Derive via farmSinkRectAbs
        // and convert to shape-local inches.
        const fr = farmSinkRectAbs(s);
        if (!fr) return null;
        return { x: (fr.x - s.x) / INCH, y: (fr.y - s.y) / INCH,
                 w: fr.w / INCH, h: fr.h / INCH };
    }
    return null;
}

function shapeLocalRects(s) {
    const st = s.shapeType || 'rect';
    const wi = s.w / INCH, hi = s.h / INCH;

    const r  = shapeRadii(s), ch = shapeChamfers(s);
    const hasChamfer = ch.nw || ch.ne || ch.se || ch.sw;
    const hasRadius  = r.nw  || r.ne  || r.se  || r.sw;
    if (hasChamfer || hasRadius) return null;
    if (st === 'circle') return null;
    // Plain rect with farm sink falls back to SH polygon clipping (the
    // single bounding rect doesn't carry a hole). For L/U/BSP we DO handle
    // farm sinks below by subtracting the FS rect from the decomposition.
    if (s.farmSink && (st === 'rect' || !st)) return null;
    // Shapes with checks can't use rect decomposition — the notches make the
    // outline non-rectangular. Fall back to SH polygon clipping which uses
    // shapeLocalPolyInches (which already injects check notches).
    if ((s.checks || []).length > 0) return null;

    let rects = null;

    if (st === 'rect' || !st) {
        rects = [{ x: 0, y: 0, w: wi, h: hi }];
    } else if (st === 'l') {
        const nW = (s.notchW || 0) / INCH, nH = (s.notchH || 0) / INCH;
        const corner = s.notchCorner || 'ne';
        switch (corner) {
            case 'ne': rects = [
                { x: 0,       y: 0,  w: wi - nW, h: hi },
                { x: wi - nW, y: nH, w: nW,      h: hi - nH },
            ]; break;
            case 'nw': rects = [
                { x: nW,      y: 0,  w: wi - nW, h: hi },
                { x: 0,       y: nH, w: nW,      h: hi - nH },
            ]; break;
            case 'se': rects = [
                { x: 0,       y: 0,  w: wi - nW, h: hi },
                { x: wi - nW, y: 0,  w: nW,      h: hi - nH },
            ]; break;
            case 'sw': rects = [
                { x: nW,      y: 0,  w: wi - nW, h: hi },
                { x: 0,       y: 0,  w: nW,      h: hi - nH },
            ]; break;
        }
    } else if (st === 'u') {
        const op = s.uOpening || 'top';
        const isVert = (op === 'top' || op === 'bottom');
        const A = isVert ? wi : hi;
        const H = isVert ? hi : wi;
        const lH = (s.leftH  ?? s.h) / INCH;
        const rH = (s.rightH ?? s.h) / INCH;
        const lW = (s.leftW  || 0)   / INCH;
        const rW = (s.rightW || 0)   / INCH;
        let fH;
        if (s.floorH != null)        fH = s.floorH   / INCH;
        else if (s.channelH != null) fH = H - s.channelH / INCH;
        else                          fH = 0;

        const floorY     = H - fH;
        const leftTopY   = H - lH;
        const rightTopY  = H - rH;

        const canonical = [
            { x: 0,        y: leftTopY,  w: lW, h: floorY - leftTopY  },
            { x: A - rW,   y: rightTopY, w: rW, h: floorY - rightTopY },
            { x: 0,        y: floorY,    w: A,  h: fH                 },
        ].filter(rc => rc.w > 0 && rc.h > 0);

        const transform = p => {
            if (op === 'top')    return p;
            if (op === 'bottom') return { x: A - p.x - p.w, y: H - p.y - p.h, w: p.w, h: p.h };
            if (op === 'right')  return { x: H - p.y - p.h, y: p.x,           w: p.h, h: p.w };
            if (op === 'left')   return { x: p.y,           y: A - p.x - p.w, w: p.h, h: p.w };
            return p;
        };
        rects = canonical.map(transform);
    } else if (st === 'bsp') {
        const pX = (s.pX !== undefined ? s.pX : Math.round((s.w - s.pW) / 2)) / INCH;
        const pW = s.pW / INCH, pH = s.pH / INCH;
        rects = [
            { x: pX, y: 0,  w: pW, h: pH },
            { x: 0,  y: pH, w: wi, h: hi - pH },
        ].filter(rc => rc.w > 0 && rc.h > 0);
    }

    if (!rects) return null;

    // Carve out the farm-sink hole, if any. For L/U/BSP shapes the FS rect
    // is contained in (or overlaps) one or two of the base rects; subtract
    // it from each. The result is still a clean rect decomposition that the
    // joint-cut + connected-components pipeline can split correctly.
    if (s.farmSink) {
        const fs = fsRectLocalInches(s);
        if (fs) {
            const out = [];
            for (const rc of rects) out.push(...subtractRect(rc, fs));
            rects = out;
        }
    }
    return rects;
}

function slabAllPieces() {
    // Returns piece entries for all placeable shapes/segments in the quote.
    // Shapes with joints are split into individual segment entries.
    const out = [];
    pages.forEach((page, pi) => {
        (page.shapes || []).forEach((s, si) => {
            const st = s.shapeType || 'rect';
            const sub = s.subtype || '';
            if (sub === 'sink_overmount' || sub === 'sink_undermount' || sub === 'sink_vasque' ||
                sub === 'cooktop' || sub === 'outlet' || sub === 'bocci') return;

            const baseLabel = s.label || `P${si+1}`;
            const pageLabel = page.name || `Page ${pi+1}`;
            const wi = s.w / INCH, hi = s.h / INCH;
            const joints = s.joints || [];

            // Split rect/BSP/L shapes at their joint lines into grid cells
            const vJoints = joints.filter(j => j.axis === 'v').map(j => j.pos / INCH).sort((a,b)=>a-b);
            const hJoints = joints.filter(j => j.axis === 'h').map(j => j.pos / INCH).sort((a,b)=>a-b);
            const dJoints = joints.filter(j => j.axis === 'd' && j.snap && j.otherSnap);
            const canSplit = (st === 'rect' || st === 'bsp' || st === 'l' || st === 'u') && joints.length > 0;

            if (!canSplit) {
                out.push({ pageIdx:pi, shapeIdx:si, label:baseLabel, pageLabel, wi, hi, shapeType:st, segIdx:null });
                return;
            }

            // ── Diagonal joint path: when any 'd' joint exists, fall back to
            //    iterative polygon clipping. Each cut splits every current
            //    piece into its two halves; non-empty halves continue.
            if (dJoints.length > 0) {
                let pieces = [shapeLocalPolyInches(s)];
                const splitBy = (p1, p2) => {
                    const next = [];
                    for (const pc of pieces) {
                        const a = clipPolyByHalfPlane(pc, p1, p2, +1);
                        const b = clipPolyByHalfPlane(pc, p1, p2, -1);
                        if (a.length >= 3) next.push(a);
                        if (b.length >= 3) next.push(b);
                    }
                    pieces = next;
                };
                for (const x of vJoints)  splitBy([x, 0], [x, hi]);
                for (const y of hJoints)  splitBy([0, y], [wi, y]);
                for (const j of dJoints)  splitBy(
                    [j.snap.relX / INCH,      j.snap.relY / INCH],
                    [j.otherSnap.relX / INCH, j.otherSnap.relY / INCH]
                );
                let segCount = 0;
                for (const piece of pieces) {
                    const cleaned = cleanClippedPolygon(piece);
                    if (cleaned.length < 3) continue;
                    const xs = cleaned.map(p=>p[0]), ys = cleaned.map(p=>p[1]);
                    const minX=Math.min(...xs), maxX=Math.max(...xs);
                    const minY=Math.min(...ys), maxY=Math.max(...ys);
                    const localPoly = cleaned.map(([x,y]) => [+(x-minX).toFixed(6), +(y-minY).toFixed(6)]);
                    out.push({ pageIdx:pi, shapeIdx:si,
                        label:`${baseLabel}-${SEG_LETTERS[segCount]||segCount+1}`,
                        pageLabel,
                        wi: +(maxX-minX).toFixed(6), hi: +(maxY-minY).toFixed(6),
                        shapeType:'rect', segIdx:segCount,
                        segOffset:{ fromX:minX, fromY:minY, toX:maxX, toY:maxY },
                        segPoly: localPoly
                    });
                    segCount++;
                }
                return;
            }

            let segCount = 0;

            // ── Rect decomposition + cut-aware connected components ──
            // 1. Decompose the shape into non-overlapping rectangles.
            // 2. Convert each joint into a cut segment (axis, position, range).
            //    Snapped joints produce HALF-LINE cuts that extend from the
            //    corner only in the direction where the wall continues. Un-
            //    snapped joints produce full-span cuts.
            // 3. Split each rect where a cut passes all the way through it.
            // 4. Sub-rects are "connected" iff they share an edge segment that
            //    is NOT covered by any cut. Connected components → pieces.
            // 5. Multi-rect pieces emit a proper polygon (union of the rects);
            //    single-rect pieces emit as a rectangle.
            const rects = shapeLocalRects(s);
            if (rects) {
                const cuts   = jointsToSlabCuts(s, joints, wi, hi);
                const subs   = sliceRectsByCuts(rects, cuts);
                const groups = groupConnectedSubRects(subs, cuts);
                for (const group of groups) {
                    if (group.length === 1) {
                        const r = group[0];
                        out.push({ pageIdx:pi, shapeIdx:si,
                            label:`${baseLabel}-${SEG_LETTERS[segCount]||segCount+1}`,
                            pageLabel,
                            wi: +r.w.toFixed(6), hi: +r.h.toFixed(6),
                            shapeType:'rect', segIdx:segCount,
                            segOffset:{ fromX:r.x, fromY:r.y, toX:r.x+r.w, toY:r.y+r.h },
                            segPoly: null
                        });
                        segCount++;
                        continue;
                    }
                    // Multi-rect group — build union polygon
                    const poly = rectUnionPolygon(group);
                    if (poly.length < 3) continue;
                    const xs = poly.map(p=>p[0]), ys = poly.map(p=>p[1]);
                    const minX=Math.min(...xs), maxX=Math.max(...xs);
                    const minY=Math.min(...ys), maxY=Math.max(...ys);
                    const localPoly = poly.map(([x,y]) => [+(x-minX).toFixed(6), +(y-minY).toFixed(6)]);
                    out.push({ pageIdx:pi, shapeIdx:si,
                        label:`${baseLabel}-${SEG_LETTERS[segCount]||segCount+1}`,
                        pageLabel,
                        wi: +(maxX-minX).toFixed(6), hi: +(maxY-minY).toFixed(6),
                        shapeType:'rect', segIdx:segCount,
                        segOffset:{ fromX:minX, fromY:minY, toX:maxX, toY:maxY },
                        segPoly: localPoly
                    });
                    segCount++;
                }
                return;
            }

            // ── Fallback: Sutherland-Hodgman for shapes we can't decompose
            //    (chamfered, rounded, circle, farmSink, etc.)
            const vCuts = vJoints.length > 0 ? [0, ...vJoints, wi] : [0, wi];
            const hCuts = hJoints.length > 0 ? [0, ...hJoints, hi] : [0, hi];
            for (let vi = 0; vi < vCuts.length - 1; vi++) {
                for (let hj = 0; hj < hCuts.length - 1; hj++) {
                    const xLo = vCuts[vi], xHi = vCuts[vi+1];
                    const yLo = hCuts[hj], yHi = hCuts[hj+1];
                    const basePoly = shapeLocalPolyInches(s);
                    let clipped = clipPolyToStrip(basePoly, xLo, xHi, true);
                    clipped = clipPolyToStrip(clipped, yLo, yHi, false);
                    clipped = cleanClippedPolygon(clipped);
                    if (clipped.length < 3) continue;
                    const xs = clipped.map(p=>p[0]), ys = clipped.map(p=>p[1]);
                    const minX=Math.min(...xs), maxX=Math.max(...xs);
                    const minY=Math.min(...ys), maxY=Math.max(...ys);
                    const poly = clipped.map(([x,y]) => [+(x-minX).toFixed(6), +(y-minY).toFixed(6)]);
                    const segW = +(maxX-minX).toFixed(6), segH = +(maxY-minY).toFixed(6);
                    const isRect = poly.length===4 &&
                        poly.every(([x,y]) => (Math.abs(x)<1e-4||Math.abs(x-segW)<1e-4) &&
                                               (Math.abs(y)<1e-4||Math.abs(y-segH)<1e-4));
                    out.push({ pageIdx:pi, shapeIdx:si,
                        label:`${baseLabel}-${SEG_LETTERS[segCount]||segCount+1}`,
                        pageLabel,
                        wi: segW, hi: segH,
                        shapeType:'rect', segIdx:segCount,
                        segOffset:{ fromX:xLo, fromY:yLo, toX:xHi, toY:yHi },
                        segPoly: isRect ? null : poly
                    });
                    segCount++;
                }
            }
        });
    });
    return out;
}

// ═══════════════════════════════════════════════════════════════════
// Rect-decomposition helpers for slab-piece generation (joint-aware).
// Keeps multi-rect shapes (U/BSP) correctly grouped, and treats snapped
// joints as half-line cuts rather than full-span cuts.
// ═══════════════════════════════════════════════════════════════════

// Convert each joint to a cut segment in shape-local inches.
// Returned spec: { axis: 'h'|'v', pos, aStart, aEnd }.
// - axis: 'h' = horizontal cut at y=pos, spans x ∈ [aStart, aEnd]
// - axis: 'v' = vertical   cut at x=pos, spans y ∈ [aStart, aEnd]
// Snapped joints produce half-line cuts whose direction is determined by
// a 4-probe test around the corner (same logic as drawJointLines).
function jointsToSlabCuts(s, joints, wi, hi) {
    const cuts = [];
    const poly = shapeLocalPolyInches(s);
    const probeT = 0.15;  // inches off-axis for interior probing
    for (const j of joints) {
        const pos = j.pos / INCH;
        if (!j.snap) {
            if (j.axis === 'h') cuts.push({ axis:'h', pos, aStart:0, aEnd:wi });
            else                 cuts.push({ axis:'v', pos, aStart:0, aEnd:hi });
            continue;
        }
        const cx = j.snap.relX / INCH;
        const cy = j.snap.relY / INCH;
        if (j.axis === 'v') {
            // Which direction is interior along the vertical axis?
            const upL = pointInPolygon(cx - probeT, cy - probeT, poly);
            const upR = pointInPolygon(cx + probeT, cy - probeT, poly);
            const dnL = pointInPolygon(cx - probeT, cy + probeT, poly);
            const dnR = pointInPolygon(cx + probeT, cy + probeT, poly);
            const upBoth = upL && upR, dnBoth = dnL && dnR;
            if (dnBoth && !upBoth)      cuts.push({ axis:'v', pos:cx, aStart:cy, aEnd:hi });
            else if (upBoth && !dnBoth) cuts.push({ axis:'v', pos:cx, aStart:0,  aEnd:cy });
            else                         cuts.push({ axis:'v', pos:cx, aStart:0,  aEnd:hi }); // fallback
        } else {
            const upL = pointInPolygon(cx - probeT, cy - probeT, poly);
            const upR = pointInPolygon(cx + probeT, cy - probeT, poly);
            const dnL = pointInPolygon(cx - probeT, cy + probeT, poly);
            const dnR = pointInPolygon(cx + probeT, cy + probeT, poly);
            const leftBoth = upL && dnL, rightBoth = upR && dnR;
            if (rightBoth && !leftBoth)     cuts.push({ axis:'h', pos:cy, aStart:cx, aEnd:wi });
            else if (leftBoth && !rightBoth) cuts.push({ axis:'h', pos:cy, aStart:0,  aEnd:cx });
            else                              cuts.push({ axis:'h', pos:cy, aStart:0,  aEnd:wi }); // fallback
        }
    }
    return cuts;
}

// For each input rect, split it at the coordinates of any cut that passes
// ALL THE WAY through it. Partial cuts (that end inside a rect) are skipped
// here — they still affect connectedness via the adjacency sever check.
function sliceRectsByCuts(rects, cuts) {
    const out = [];
    for (const r of rects) {
        const xBreaks = new Set([r.x, r.x + r.w]);
        const yBreaks = new Set([r.y, r.y + r.h]);
        for (const c of cuts) {
            if (c.axis === 'v' && c.pos > r.x + 1e-6 && c.pos < r.x + r.w - 1e-6) {
                if (c.aStart <= r.y + 1e-6 && c.aEnd >= r.y + r.h - 1e-6) xBreaks.add(c.pos);
            } else if (c.axis === 'h' && c.pos > r.y + 1e-6 && c.pos < r.y + r.h - 1e-6) {
                if (c.aStart <= r.x + 1e-6 && c.aEnd >= r.x + r.w - 1e-6) yBreaks.add(c.pos);
            }
        }
        const xs = [...xBreaks].sort((a,b)=>a-b);
        const ys = [...yBreaks].sort((a,b)=>a-b);
        for (let i = 0; i < xs.length - 1; i++) {
            for (let j = 0; j < ys.length - 1; j++) {
                out.push({ x: xs[i], y: ys[j], w: xs[i+1]-xs[i], h: ys[j+1]-ys[j] });
            }
        }
    }
    return out;
}

// Return the shared edge between two axis-aligned rects, or null.
// Shared edge spec: { axis: 'h'|'v', pos, aStart, aEnd }.
function _sharedEdge(a, b) {
    const EPS = 1e-6;
    // a below b (b.bottom == a.top)
    if (Math.abs(a.y - (b.y + b.h)) < EPS) {
        const s = Math.max(a.x, b.x), e = Math.min(a.x + a.w, b.x + b.w);
        if (e > s + EPS) return { axis:'h', pos:a.y, aStart:s, aEnd:e };
    }
    if (Math.abs(b.y - (a.y + a.h)) < EPS) {
        const s = Math.max(a.x, b.x), e = Math.min(a.x + a.w, b.x + b.w);
        if (e > s + EPS) return { axis:'h', pos:b.y, aStart:s, aEnd:e };
    }
    if (Math.abs(a.x - (b.x + b.w)) < EPS) {
        const s = Math.max(a.y, b.y), e = Math.min(a.y + a.h, b.y + b.h);
        if (e > s + EPS) return { axis:'v', pos:a.x, aStart:s, aEnd:e };
    }
    if (Math.abs(b.x - (a.x + a.w)) < EPS) {
        const s = Math.max(a.y, b.y), e = Math.min(a.y + a.h, b.y + b.h);
        if (e > s + EPS) return { axis:'v', pos:b.x, aStart:s, aEnd:e };
    }
    return null;
}

// Does any cut traverse this shared edge? Cut must have same axis + position
// and a non-zero overlap with the edge's along-axis range.
function _edgeSevered(edge, cuts) {
    const EPS = 1e-6;
    for (const c of cuts) {
        if (c.axis !== edge.axis) continue;
        if (Math.abs(c.pos - edge.pos) > EPS) continue;
        const s = Math.max(edge.aStart, c.aStart);
        const e = Math.min(edge.aEnd,   c.aEnd);
        if (e > s + EPS) return true;
    }
    return false;
}

// Union-find grouping: two sub-rects are in the same piece iff they share an
// edge that no cut passes over.
function groupConnectedSubRects(subs, cuts) {
    const n = subs.length;
    const parent = Array.from({length:n}, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const edge = _sharedEdge(subs[i], subs[j]);
            if (!edge) continue;
            if (_edgeSevered(edge, cuts)) continue;
            union(i, j);
        }
    }
    const buckets = new Map();
    subs.forEach((r, i) => {
        const root = find(i);
        if (!buckets.has(root)) buckets.set(root, []);
        buckets.get(root).push(r);
    });
    return [...buckets.values()];
}

// Build the boundary polygon of a set of non-overlapping axis-aligned rects
// that together form a single connected union. Uses a cell-grid boundary trace.
function rectUnionPolygon(rects) {
    if (!rects || rects.length === 0) return [];
    if (rects.length === 1) {
        const r = rects[0];
        return [[r.x, r.y], [r.x+r.w, r.y], [r.x+r.w, r.y+r.h], [r.x, r.y+r.h]];
    }
    const xs = new Set(), ys = new Set();
    for (const r of rects) { xs.add(r.x); xs.add(r.x + r.w); ys.add(r.y); ys.add(r.y + r.h); }
    const xList = [...xs].sort((a,b)=>a-b);
    const yList = [...ys].sort((a,b)=>a-b);
    const cols = xList.length - 1, rows = yList.length - 1;
    // Fill grid — each cell marked inside if its center is inside any rect
    const grid = [];
    for (let j = 0; j < rows; j++) {
        const row = [];
        const cy = (yList[j] + yList[j+1]) / 2;
        for (let i = 0; i < cols; i++) {
            const cx = (xList[i] + xList[i+1]) / 2;
            let inside = false;
            for (const r of rects) {
                if (cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h) { inside = true; break; }
            }
            row.push(inside);
        }
        grid.push(row);
    }
    // Collect boundary segments (exterior on the left when walking them).
    // For each horizontal grid line: if interior differs above vs. below, add a segment.
    const segments = [];
    for (let j = 0; j <= rows; j++) {
        for (let i = 0; i < cols; i++) {
            const above = j > 0    ? grid[j-1][i] : false;
            const below = j < rows ? grid[j][i]   : false;
            if (above === below) continue;
            if (below && !above) {
                // top edge of interior — walk right-to-left (so exterior (above) is on the left)
                segments.push({ x1:xList[i+1], y1:yList[j], x2:xList[i], y2:yList[j] });
            } else {
                segments.push({ x1:xList[i], y1:yList[j], x2:xList[i+1], y2:yList[j] });
            }
        }
    }
    for (let i = 0; i <= cols; i++) {
        for (let j = 0; j < rows; j++) {
            const left  = i > 0    ? grid[j][i-1] : false;
            const right = i < cols ? grid[j][i]   : false;
            if (left === right) continue;
            // CCW convention: walk the boundary so interior is always on the LEFT.
            if (right && !left) {
                // Interior is to the RIGHT → walk SOUTH (+y) so interior stays on the left.
                segments.push({ x1:xList[i], y1:yList[j], x2:xList[i], y2:yList[j+1] });
            } else {
                // Interior is to the LEFT → walk NORTH (-y).
                segments.push({ x1:xList[i], y1:yList[j+1], x2:xList[i], y2:yList[j] });
            }
        }
    }
    // Chain segments end-to-end into a ring
    if (segments.length === 0) return [];
    const used = new Set();
    const poly = [];
    let curr = segments[0];
    used.add(0);
    poly.push([curr.x1, curr.y1]);
    let safety = segments.length + 2;
    while (safety-- > 0) {
        poly.push([curr.x2, curr.y2]);
        let nextIdx = -1;
        for (let i = 0; i < segments.length; i++) {
            if (used.has(i)) continue;
            const s = segments[i];
            if (Math.abs(s.x1 - curr.x2) < 1e-6 && Math.abs(s.y1 - curr.y2) < 1e-6) { nextIdx = i; break; }
        }
        if (nextIdx === -1) break;
        used.add(nextIdx);
        curr = segments[nextIdx];
    }
    // Drop closing duplicate, then collapse collinear middles.
    return cleanClippedPolygon(poly);
}

// Removes degenerate vertices from a clipped polygon:
//   - consecutive duplicates (zero-length edges)
//   - collinear middle vertices (Sutherland-Hodgman leaves these when a clip
//     line coincides with a polygon edge, which creates a "slit" along the
//     clip line that distorts the vertex bounding box but has zero area)
// After cleanup, a polygon that encloses a pure rectangle has exactly 4
// vertices at the corners.
function cleanClippedPolygon(pts) {
    if (!pts || pts.length === 0) return pts;
    const EPS = 1e-5;
    // 1. Remove consecutive duplicates
    let out = [];
    for (let i = 0; i < pts.length; i++) {
        const [x, y] = pts[i];
        if (out.length === 0 || Math.abs(out[out.length-1][0] - x) > EPS || Math.abs(out[out.length-1][1] - y) > EPS) {
            out.push([x, y]);
        }
    }
    while (out.length > 1 && Math.abs(out[0][0] - out[out.length-1][0]) < EPS && Math.abs(out[0][1] - out[out.length-1][1]) < EPS) {
        out.pop();
    }
    // 2. Iteratively remove collinear middle vertices
    let changed = true;
    while (changed && out.length > 3) {
        changed = false;
        for (let i = 0; i < out.length; i++) {
            const prev = out[(i - 1 + out.length) % out.length];
            const curr = out[i];
            const next = out[(i + 1) % out.length];
            const cross = (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
            if (Math.abs(cross) < EPS) {
                out.splice(i, 1);
                changed = true;
                break;
            }
        }
    }
    return out;
}

// Replace each placed piece's stored ref with the current definition from
// slabAllPieces(). Called whenever the slab panel is activated or the piece
// list is refreshed, so placed pieces always reflect the latest joint/shape
// state (fixes stale segPoly/wi/hi from older placements).
function slabSyncPlacedRefs() {
    const pieces = slabAllPieces();
    let changed = false;
    for (const pl of slabPlaced) {
        if (!pl.ref) continue;
        const match = pieces.find(p =>
            p.pageIdx  === pl.ref.pageIdx  &&
            p.shapeIdx === pl.ref.shapeIdx &&
            ((p.segIdx == null && pl.ref.segIdx == null) ||
             p.segIdx === pl.ref.segIdx)
        );
        if (match) {
            pl.ref = { ...match };
            changed = true;
        }
    }
    return changed;
}

// ── slab panel UI refresh ─────────────────────────────────────────────
function slabRefreshPieceList() {
    slabSyncPlacedRefs();
    const div = document.getElementById('slab-piece-list');
    if (!div) return;
    const pieces = slabAllPieces();
    if (pieces.length === 0) {
        div.innerHTML = '<div style="color:#666;font-size:11px;padding:6px">No pieces in quote.</div>';
        return;
    }
    div.innerHTML = '';
    pieces.forEach(p => {
        const btn = document.createElement('button');
        btn.className = 'slab-piece-btn';
        const placed = slabPlaced.filter(pl =>
            pl.ref.pageIdx === p.pageIdx && pl.ref.shapeIdx === p.shapeIdx &&
            (p.segIdx == null ? pl.ref.segIdx == null : pl.ref.segIdx === p.segIdx)
        ).length;
        const typeTag = p.segIdx == null && p.shapeType === 'l' ? ' [L]' : p.segIdx == null && p.shapeType === 'u' ? ' [U]' : p.segIdx == null && p.shapeType === 'bsp' ? ' [BSP]' : '';
        btn.textContent = `${p.label}${typeTag}  ${fmtInches(p.wi)} × ${fmtInches(p.hi)}  [${p.pageLabel}]`;
        btn.title = placed ? 'Already placed — remove from slab to reuse' : 'Click to place on slab';
        if (placed) {
            btn.disabled = true;
            btn.style.cssText += ';text-decoration:line-through;color:rgba(200,60,60,0.85);opacity:0.65;cursor:not-allowed;border-color:#5a1010;';
        }
        btn.addEventListener('click', () => {
            if (placed) return;
            slabPickingPiece = { pageIdx:p.pageIdx, shapeIdx:p.shapeIdx,
                label:p.label, wi:p.wi, hi:p.hi, shapeType:p.shapeType,
                segIdx:p.segIdx, segPoly: p.segPoly || null };
            slabSelected = null;
            div.querySelectorAll('.slab-piece-btn').forEach(b => b.style.borderColor = '');
            btn.style.borderColor = '#b09030';
            slabRender();
        });
        div.appendChild(btn);
    });
}

// ── per-slab dimension rows ───────────────────────────────────────────
function slabRefreshSlabList() {
    const div = document.getElementById('slab-def-list');
    if (!div) return;
    div.innerHTML = '';
    slabDefs.forEach((sd, idx) => {
        const row = document.createElement('div');
        row.style.cssText = 'background:#1a1a1a;border:1px solid #333333;border-radius:4px;padding:6px 8px;';
        const hasImg = !!sd.bgImage;
        row.innerHTML = `
            <div style="display:flex;align-items:center;margin-bottom:5px;gap:6px">
                <span style="color:#999999;font-size:11px;font-weight:700;letter-spacing:.3px">Slab ${idx+1}</span>
                ${hasImg ? `<span style="color:#b09030;font-size:10px;font-weight:700">✦ image</span>
                    <button class="tool-btn danger slab-rm-img" data-idx="${idx}" style="font-size:10px;padding:2px 7px;">✕ img</button>`
                         : `<span style="color:#555;font-size:10px">no image</span>`}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">
                <div class="fp-field" style="margin:0">
                    <label class="fp-label">W (in)</label>
                    <input class="fp-input slab-dim-w" data-idx="${idx}" type="number" value="${sd.w}" min="12" max="240" step="1">
                </div>
                <div class="fp-field" style="margin:0">
                    <label class="fp-label">H (in)</label>
                    <input class="fp-input slab-dim-h" data-idx="${idx}" type="number" value="${sd.h}" min="12" max="120" step="1">
                </div>
                <div class="fp-field" style="margin:0">
                    <label class="fp-label">Dead (in)</label>
                    <input class="fp-input slab-dim-dead" data-idx="${idx}" type="number" value="${sd.deadZone}" min="0" max="6" step="0.25">
                </div>
            </div>`;
        div.appendChild(row);
    });
    // Wire each input individually — only affects its own slab
    div.querySelectorAll('.slab-dim-w').forEach(el => el.addEventListener('change', () => {
        const i = +el.dataset.idx; if (slabDefs[i]) { slabDefs[i].w = parseFloat(el.value)||126; slabRender(); }
    }));
    div.querySelectorAll('.slab-dim-h').forEach(el => el.addEventListener('change', () => {
        const i = +el.dataset.idx; if (slabDefs[i]) { slabDefs[i].h = parseFloat(el.value)||63; slabRender(); }
    }));
    div.querySelectorAll('.slab-dim-dead').forEach(el => el.addEventListener('change', () => {
        const i = +el.dataset.idx; if (slabDefs[i]) { slabDefs[i].deadZone = parseFloat(el.value)||0.5; slabRender(); }
    }));
    div.querySelectorAll('.slab-rm-img').forEach(el => el.addEventListener('click', () => {
        const i = +el.dataset.idx;
        if (slabDefs[i]) { slabDefs[i].bgImage = null; delete slabBgImgEls[i]; slabRefreshSlabList(); slabRender(); }
    }));
}

// ── slab panel button wiring ──────────────────────────────────────────
(function wireSlabPanel() {
    // Add slab — always uses 126×63 default; user can edit independently after
    const btnAdd = document.getElementById('slab-add-btn');
    if (btnAdd) btnAdd.addEventListener('click', () => {
        if (slabDefs.length >= 4) return;
        slabDefs.push({ w: 126, h: 63, deadZone: 0.5 });
        slabRefreshSlabList();
        slabRender();
    });
    // Remove last slab
    const btnRem = document.getElementById('slab-remove-btn');
    if (btnRem) btnRem.addEventListener('click', () => {
        if (slabDefs.length <= 1) return;
        const idx = slabDefs.length - 1;
        slabPlaced = slabPlaced.filter(p => p.slabIdx !== idx);
        slabDefs.pop();
        slabRefreshSlabList();
        slabRender();
    });
    // Refresh pieces
    const btnRef = document.getElementById('slab-refresh-btn');
    if (btnRef) btnRef.addEventListener('click', () => { slabRefreshPieceList(); slabRender(); });
    // Rotate selected
    const btnRot = document.getElementById('slab-rotate-btn');
    if (btnRot) btnRot.addEventListener('click', () => {
        if (!slabSelected) return;
        const p = slabPlaced.find(p => p.id === slabSelected);
        if (p) { p.rotation = ((p.rotation||0) + 1) % 4; slabRender(); }
    });
    // Remove selected piece
    const btnDel = document.getElementById('slab-remove-piece-btn');
    if (btnDel) btnDel.addEventListener('click', () => {
        if (!slabSelected) return;
        slabPlaced = slabPlaced.filter(p => p.id !== slabSelected);
        slabSelected = null;
        slabRefreshPieceList();
        slabRender();
    });
    // Clear all pieces
    const btnClr = document.getElementById('slab-clear-btn');
    if (btnClr) btnClr.addEventListener('click', () => {
        slabPlaced = [];
        slabSelected = null;
        slabPickingPiece = null;
        slabRefreshPieceList();
        slabRender();
    });
    // Transparency toggle
    const chkTrans = document.getElementById('slab-transparent-toggle');
    if (chkTrans) chkTrans.addEventListener('change', e => {
        slabTransparent = e.target.checked;
        slabRender();
    });
})();

// ── slab canvas rendering ─────────────────────────────────────────────
const slabCanvas = document.getElementById('slabCanvas');
const slabCtx = slabCanvas ? slabCanvas.getContext('2d') : null;

// layout constants
const SLAB_PAD = 30;       // px around each slab
const SLAB_GAP = 40;       // px between slabs
const MAX_SLAB_W_PX = 700; // max display width for one slab

function slabScale() {
    if (!slabDefs.length) return 4;
    const maxW = slabDefs.reduce((m, sd) => Math.max(m, sd.w), 0);
    return Math.min(8, MAX_SLAB_W_PX / (maxW + 4)); // px per inch
}

function slabRender(bgOverride) {
    persistSlab(); // keep slab layout + images in sync with localStorage on every redraw
    if (!slabCtx) return;
    const layout = slabGetLayout();
    if (!layout.length) return;
    const sc = layout[0].sc;
    const cols = slabDefs.length <= 2 ? 1 : 2;
    const rows = Math.ceil(slabDefs.length / cols);
    const slabPxW = slabDefs.reduce((m, sd) => Math.max(m, sd.w * sc), 0);
    const slabPxH = slabDefs.reduce((m, sd) => Math.max(m, sd.h * sc), 0);
    const canvasW = cols * (slabPxW + SLAB_PAD * 2) + (cols - 1) * SLAB_GAP + SLAB_PAD;
    const canvasH = rows * (slabPxH + SLAB_PAD * 2) + (rows - 1) * SLAB_GAP + SLAB_PAD;
    slabCanvas.width  = canvasW;
    slabCanvas.height = canvasH;
    slabCtx.clearRect(0, 0, canvasW, canvasH);
    slabCtx.fillStyle = bgOverride || '#111111';
    slabCtx.fillRect(0, 0, canvasW, canvasH);
    layout.forEach(L => slabDrawSlab(slabCtx, L.sd, L.idx, L.ox, L.oy, L.sc));

    // cursor hint
    if (slabPickingPiece) {
        slabCtx.fillStyle = '#b09030';
        slabCtx.font = '12px Raleway,sans-serif';
        slabCtx.fillText('Click on a slab to place piece  (ESC to cancel)', SLAB_PAD, canvasH - 10);
    }
}

function slabDrawSlab(ctx, sd, idx, ox, oy, sc, mockupMode) {
    const sw = sd.w * sc;
    const sh = sd.h * sc;
    const dz = sd.deadZone * sc;

    // slab background
    ctx.fillStyle = '#2d3a10';
    ctx.strokeStyle = '#444444';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(ox, oy, sw, sh);
    ctx.fill();
    ctx.stroke();

    // ── background slab image (drawn over solid fill, before dead zone) ──
    _slabImgCacheEl(idx);
    const bgEl = slabBgImgEls[idx];
    if (bgEl && bgEl.complete && bgEl.naturalWidth > 0) {
        ctx.drawImage(bgEl, ox, oy, sw, sh);
        // Re-draw slab border over the image
        ctx.strokeStyle = '#444444';
        ctx.lineWidth = 2;
        ctx.strokeRect(ox, oy, sw, sh);
    }

    // dead zone — drawn OVER the stone image so it's always visible
    if (dz > 0) {
        ctx.save();
        // hatching pattern
        ctx.strokeStyle = 'rgba(200,40,40,0.55)';
        ctx.lineWidth = 1;
        const step = 8;
        // clip to dead zone strips
        ctx.beginPath();
        ctx.rect(ox, oy, sw, dz);           // top
        ctx.rect(ox, oy+sh-dz, sw, dz);    // bottom
        ctx.rect(ox, oy+dz, dz, sh-2*dz);  // left
        ctx.rect(ox+sw-dz, oy+dz, dz, sh-2*dz); // right
        ctx.clip();
        // fill red
        ctx.fillStyle = 'rgba(180,30,30,0.38)';
        ctx.fillRect(ox, oy, sw, sh);
        // diagonal hatching
        for (let i = -sh; i < sw + sh; i += step) {
            ctx.beginPath(); ctx.moveTo(ox+i, oy); ctx.lineTo(ox+i+sh, oy+sh); ctx.stroke();
        }
        ctx.restore();
        // usable area border (bright line showing what's safe)
        ctx.strokeStyle = 'rgba(220,60,60,0.95)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4,3]);
        ctx.strokeRect(ox + dz, oy + dz, sw - 2*dz, sh - 2*dz);
        ctx.setLineDash([]);
    }

    // slab label (left) + dead zone note (right — no overlap)
    ctx.font = `bold 12px Raleway,sans-serif`;
    ctx.fillStyle = '#999999';
    ctx.textAlign = 'left';
    ctx.fillText(`Slab ${idx + 1}  —  ${sd.w}" × ${sd.h}"`, ox + 6, oy - 8);
    if (dz > 0) {
        ctx.font = `10px Raleway,sans-serif`;
        ctx.fillStyle = 'rgba(200,60,60,0.85)';
        ctx.textAlign = 'right';
        ctx.fillText(`dead zone: ${sd.deadZone}"`, ox + sw - 4, oy - 8);
        ctx.textAlign = 'left';
    }

    // placed pieces on this slab
    slabPlaced.filter(p => p.slabIdx === idx).forEach(p => {
        const { w: pw, h: ph } = slabGetPieceWH(p.ref, p.rotation||0);
        const px = ox + dz + p.x * sc;
        const py = oy + dz + p.y * sc;
        const pxw = pw * sc;
        const pxh = ph * sc;
        const isSelected = p.id === slabSelected;
        const col = slabGetPieceColor(p.ref);
        const page = pages[p.ref.pageIdx];
        const shape = page ? page.shapes[p.ref.shapeIdx] : null;
        const shapeType = shape ? (shape.shapeType || 'rect') : 'rect';
        const segPoly = p.ref.segPoly || null; // exact polygon for irregular segments
        const isOverlapping = slabPieceOverlaps(idx, p.x, p.y, pw, ph, p.id, p.ref, p.rotation||0) || slabPieceInDeadZone(idx, p.x, p.y, pw, ph, p.ref, p.rotation||0);

        ctx.save();

        // ── build exact shape path (corners, chamfers, irregular polygons) ──
        const rot = p.rotation || 0;   // 0=0° 1=90°CW 2=180° 3=270°CW
        const wi_in = p.ref.wi || 0, hi_in = p.ref.hi || 0;
        // Unified local-inches → slab canvas px converter for all 4 rotations
        function convRot(lx, ly) {
            switch(rot) {
                case 1: return [px + (hi_in - ly)*sc, py + lx*sc];
                case 2: return [px + (wi_in - lx)*sc, py + (hi_in - ly)*sc];
                case 3: return [px + ly*sc,            py + (wi_in - lx)*sc];
                default:return [px + lx*sc,            py + ly*sc];
            }
        }
        // Convert absolute main-canvas px coord to local inches then route through convRot
        function convAbs([ax, ay]) {
            return convRot((ax - shape.x)/INCH, (ay - shape.y)/INCH);
        }

        function buildPath() {
            ctx.beginPath();
            if (segPoly) {
                // Exact clipped polygon — apply 4-way rotation to local inch coords
                const pts = segPoly.map(([lx, ly]) => {
                    switch(rot) {
                        case 1: return [hi_in - ly, lx];
                        case 2: return [wi_in - lx, hi_in - ly];
                        case 3: return [ly, wi_in - lx];
                        default:return [lx, ly];
                    }
                });
                ctx.moveTo(px + pts[0][0]*sc, py + pts[0][1]*sc);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(px + pts[i][0]*sc, py + pts[i][1]*sc);
                ctx.closePath();
            } else if ((shapeType === 'l' || shapeType === 'u') && shape && p.ref.segIdx == null && shape.farmSink) {
                // L/U with farm sink — vertex-based path can't carve the FS
                // notch, so route through shapeLocalPolyInches which already
                // injects the cutout via injectFsNotchInchesLocal.
                const poly = shapeLocalPolyInches(shape);
                const pts = poly.map(([lx, ly]) => {
                    switch(rot) {
                        case 1: return [hi_in - ly, lx];
                        case 2: return [wi_in - lx, hi_in - ly];
                        case 3: return [ly, wi_in - lx];
                        default:return [lx, ly];
                    }
                });
                ctx.moveTo(px + pts[0][0]*sc, py + pts[0][1]*sc);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(px + pts[i][0]*sc, py + pts[i][1]*sc);
                ctx.closePath();
            } else if (shapeType === 'l' && shape && p.ref.segIdx == null) {
                // Full L-shape — lShapeVerts for exact corner/chamfer treatment,
                // with corner checks (A→C→B) replacing treatment at notched verts.
                const verts = lShapeVerts(shape);
                const basePoly = lShapePolygon(shape);
                const n = verts.length;
                const checkAt = new Array(n).fill(null);
                for (const c of (shape.checks || [])) {
                    if (c.vertexIdx != null && c.vertexIdx >= 0 && c.vertexIdx < n) {
                        checkAt[c.vertexIdx] = cornerCheckPoints(basePoly, c.vertexIdx, c);
                    }
                }
                const v0 = convAbs(checkAt[0] ? checkAt[0].B : verts[0].pout);
                ctx.moveTo(v0[0], v0[1]);
                for (let i = 0; i < n; i++) {
                    const nextI = (i+1)%n;
                    const nv = verts[nextI];
                    const nvCk = checkAt[nextI];
                    if (nvCk) {
                        const A = convAbs(nvCk.A), C = convAbs(nvCk.C), B = convAbs(nvCk.B);
                        ctx.lineTo(A[0], A[1]);
                        ctx.lineTo(C[0], C[1]);
                        ctx.lineTo(B[0], B[1]);
                    } else {
                        const pin = convAbs(nv.pin);
                        ctx.lineTo(pin[0], pin[1]);
                        if (nv.t > 0) {
                            if (nv.r === 0) {
                                const pout = convAbs(nv.pout);
                                ctx.lineTo(pout[0], pout[1]);
                            } else {
                                const curr = convAbs(nv.curr);
                                const pout = convAbs(nv.pout);
                                ctx.arcTo(curr[0], curr[1], pout[0], pout[1], nv.r / INCH * sc);
                            }
                        }
                    }
                }
                ctx.closePath();
            } else if (shapeType === 'u' && shape && p.ref.segIdx == null) {
                // Mirror L-shape: verts with corner treatments + check notches
                const verts = uShapeVerts(shape);
                const basePoly = uShapePolygon(shape);
                const n = verts.length;
                const checkAt = new Array(n).fill(null);
                for (const c of (shape.checks || [])) {
                    if (c.vertexIdx != null && c.vertexIdx >= 0 && c.vertexIdx < n) {
                        checkAt[c.vertexIdx] = cornerCheckPoints(basePoly, c.vertexIdx, c);
                    }
                }
                const v0p = convAbs(checkAt[0] ? checkAt[0].B : verts[0].pout);
                ctx.moveTo(v0p[0], v0p[1]);
                for (let i = 0; i < n; i++) {
                    const nextI = (i+1)%n;
                    const nv = verts[nextI];
                    const nvCk = checkAt[nextI];
                    if (nvCk) {
                        const A = convAbs(nvCk.A), C = convAbs(nvCk.C), B = convAbs(nvCk.B);
                        ctx.lineTo(A[0], A[1]);
                        ctx.lineTo(C[0], C[1]);
                        ctx.lineTo(B[0], B[1]);
                    } else {
                        const pinC = convAbs(nv.pin);
                        ctx.lineTo(pinC[0], pinC[1]);
                        if (nv.t > 0) {
                            if (nv.r === 0) {
                                const poutC = convAbs(nv.pout);
                                ctx.lineTo(poutC[0], poutC[1]);
                            } else {
                                const currC = convAbs(nv.curr);
                                const poutC = convAbs(nv.pout);
                                ctx.arcTo(currC[0], currC[1], poutC[0], poutC[1], nv.r / INCH * sc);
                            }
                        }
                    }
                }
                ctx.closePath();
            } else if (shapeType === 'bsp' && shape && p.ref.segIdx == null) {
                const pts = bspPolygon(shape);
                const first = convAbs(pts[0]);
                ctx.moveTo(first[0], first[1]);
                for (let i = 1; i < pts.length; i++) { const pt = convAbs(pts[i]); ctx.lineTo(pt[0], pt[1]); }
                ctx.closePath();
            } else if (shapeType === 'circle') {
                const r = pxw / 2;
                ctx.arc(px + r, py + r, r, 0, Math.PI * 2);
            } else if (shape && p.ref.segIdx == null && (shape.farmSink || (shape.checks || []).length > 0)) {
                // Rect with farmhouse sink OR corner-check notches — use
                // shapeLocalPolyInches so the piece outline matches the
                // true cut shape.
                const poly = shapeLocalPolyInches(shape);
                const pts = poly.map(([lx, ly]) => {
                    switch(rot) {
                        case 1: return [hi_in - ly, lx];
                        case 2: return [wi_in - lx, hi_in - ly];
                        case 3: return [ly, wi_in - lx];
                        default:return [lx, ly];
                    }
                });
                ctx.moveTo(px + pts[0][0]*sc, py + pts[0][1]*sc);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(px + pts[i][0]*sc, py + pts[i][1]*sc);
                ctx.closePath();
            } else {
                const r   = shape ? shapeRadii(shape)    : { nw:0,ne:0,se:0,sw:0 };
                const ch  = shape ? shapeChamfers(shape)  : { nw:0,ne:0,se:0,sw:0 };
                const chB = shape ? shapeChamfersB(shape) : { nw:0,ne:0,se:0,sw:0 };
                const cvt = v => v / INCH * sc;

                // For segments, only keep corners on boundary edges (cut sides stay sharp)
                const segOff = p.ref.segOffset;
                let maskNW=true, maskNE=true, maskSE=true, maskSW=true;
                if (segOff && shape) {
                    const totalW = shape.w/INCH, totalH = shape.h/INCH;
                    const isFirstX = Math.abs(segOff.fromX) < 1e-4;
                    const isLastX  = Math.abs(segOff.toX - totalW) < 0.01;
                    const isFirstY = Math.abs(segOff.fromY) < 1e-4;
                    const isLastY  = Math.abs(segOff.toY - totalH) < 0.01;
                    maskNW = isFirstX && isFirstY;
                    maskNE = isLastX  && isFirstY;
                    maskSE = isLastX  && isLastY;
                    maskSW = isFirstX && isLastY;
                }

                let effR  = { nw: maskNW?cvt(r.nw):0,  ne: maskNE?cvt(r.ne):0,  se: maskSE?cvt(r.se):0,  sw: maskSW?cvt(r.sw):0  };
                let effCh = { nw: maskNW?cvt(ch.nw):0, ne: maskNE?cvt(ch.ne):0, se: maskSE?cvt(ch.se):0, sw: maskSW?cvt(ch.sw):0 };
                let effChB= { nw: maskNW?cvt(chB.nw):0,ne: maskNE?cvt(chB.ne):0,se: maskSE?cvt(chB.se):0,sw: maskSW?cvt(chB.sw):0};

                // Corner remapping for each rotation
                // rot=1(90°CW): nw←sw, ne←nw, se←ne, sw←se
                // rot=2(180°):  nw←se, ne←sw, se←nw, sw←ne
                // rot=3(270°):  nw←ne, ne←se, se←sw, sw←nw
                const rotC = o => {
                    switch(rot) {
                        case 1: return { nw:o.sw, ne:o.nw, se:o.ne, sw:o.se };
                        case 2: return { nw:o.se, ne:o.sw, se:o.nw, sw:o.ne };
                        case 3: return { nw:o.ne, ne:o.se, se:o.sw, sw:o.nw };
                        default:return o;
                    }
                };
                if (rot) { effR=rotC(effR); effCh=rotC(effCh); effChB=rotC(effChB); }

                const x=px, y=py, w=pxw, h=pxh;
                const nwA=effCh.nw>0?effCh.nw:effR.nw, nwB=effCh.nw>0?effChB.nw:effR.nw;
                const neA=effCh.ne>0?effCh.ne:effR.ne, neB=effCh.ne>0?effChB.ne:effR.ne;
                const seA=effCh.se>0?effCh.se:effR.se, seB=effCh.se>0?effChB.se:effR.se;
                const swA=effCh.sw>0?effCh.sw:effR.sw, swB=effCh.sw>0?effChB.sw:effR.sw;
                ctx.moveTo(x+nwA, y);
                ctx.lineTo(x+w-neA, y);
                if      (effCh.ne>0) ctx.lineTo(x+w, y+neB);
                else if (effR.ne >0) ctx.arcTo(x+w, y, x+w, y+effR.ne, effR.ne);
                else                 ctx.lineTo(x+w, y);
                ctx.lineTo(x+w, y+h-seA);
                if      (effCh.se>0) ctx.lineTo(x+w-seB, y+h);
                else if (effR.se >0) ctx.arcTo(x+w, y+h, x+w-effR.se, y+h, effR.se);
                else                 ctx.lineTo(x+w, y+h);
                ctx.lineTo(x+swA, y+h);
                if      (effCh.sw>0) ctx.lineTo(x, y+h-swB);
                else if (effR.sw >0) ctx.arcTo(x, y+h, x, y+h-effR.sw, effR.sw);
                else                 ctx.lineTo(x, y+h);
                ctx.lineTo(x, y+nwB);
                if      (effCh.nw>0) ctx.lineTo(x+nwA, y);
                else if (effR.nw >0) ctx.arcTo(x, y, x+effR.nw, y, effR.nw);
                else                 ctx.lineTo(x, y);
                ctx.closePath();
            }
        }

        // ── kerf dead zone — follows actual shape outline ───────
        const kpx = SLAB_KERF * sc;
        buildPath();
        ctx.save();
        ctx.strokeStyle = isOverlapping ? 'rgba(255,50,50,0.9)' : 'rgba(200,50,50,0.5)';
        ctx.lineWidth = kpx * 2;      // stroke extends kpx outward + kpx inward
        ctx.setLineDash([3, 4]);
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // ── fill ───────────────────────────────────────────────
        buildPath();
        if (mockupMode && bgEl && bgEl.complete && bgEl.naturalWidth > 0) {
            // Mockup: clip to exact piece shape and reveal the stone image underneath.
            // The stone is drawn at exactly (ox, oy, sw, sh) — same as the background — so
            // it aligns perfectly with the slab coordinate system, no extra math needed.
            ctx.save();
            ctx.clip();
            ctx.globalAlpha = 0.97;
            ctx.drawImage(bgEl, ox, oy, sw, sh);
            ctx.globalAlpha = 1;
            ctx.restore();
        } else {
            const fillAlpha = isOverlapping ? 0.5 : (slabTransparent ? 0.22 : 0.85);
            ctx.globalAlpha = fillAlpha;
            ctx.fillStyle = isOverlapping ? '#8b1a1a' : col;
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // ── border ─────────────────────────────────────────────
        buildPath();
        ctx.strokeStyle = isSelected ? '#ffdd44' : isOverlapping ? '#ff4444' : '#fff';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        // ── Polish-Under areas (carry through with piece rotation) ──
        if (shape && shape.polishUnders && shape.polishUnders.length && p.ref.segIdx == null && !mockupMode) {
            for (const r of shape.polishUnders) {
                const lx0 = r.x / INCH, ly0 = r.y / INCH;
                const lx1 = (r.x + r.w) / INCH, ly1 = (r.y + r.h) / INCH;
                const c0 = convRot(lx0, ly0);
                const c1 = convRot(lx1, ly0);
                const c2 = convRot(lx1, ly1);
                const c3 = convRot(lx0, ly1);
                ctx.save();
                // Polygon path for clip + outline
                ctx.beginPath();
                ctx.moveTo(c0[0], c0[1]); ctx.lineTo(c1[0], c1[1]);
                ctx.lineTo(c2[0], c2[1]); ctx.lineTo(c3[0], c3[1]);
                ctx.closePath();
                // Hatching (clipped to polygon)
                ctx.save();
                ctx.clip();
                ctx.strokeStyle = 'rgba(180,60,150,0.85)';
                ctx.lineWidth = 1;
                const minX = Math.min(c0[0], c1[0], c2[0], c3[0]);
                const minY = Math.min(c0[1], c1[1], c2[1], c3[1]);
                const maxX = Math.max(c0[0], c1[0], c2[0], c3[0]);
                const maxY = Math.max(c0[1], c1[1], c2[1], c3[1]);
                const bw = maxX - minX, bh = maxY - minY, step = 8;
                for (let d = -bh; d < bw + bh; d += step) {
                    ctx.beginPath();
                    ctx.moveTo(minX + d,        minY);
                    ctx.lineTo(minX + d + bh,   minY + bh);
                    ctx.stroke();
                }
                ctx.restore();
                // Outline
                ctx.strokeStyle = '#b03c96';
                ctx.lineWidth = 1.2;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
                // Label oriented along longer side
                const sideA = Math.hypot(c1[0]-c0[0], c1[1]-c0[1]);
                const sideB = Math.hypot(c3[0]-c0[0], c3[1]-c0[1]);
                const useA = sideA >= sideB;
                const ang = useA
                    ? Math.atan2(c1[1]-c0[1], c1[0]-c0[0])
                    : Math.atan2(c3[1]-c0[1], c3[0]-c0[0]);
                const longSide  = useA ? sideA : sideB;
                const shortSide = useA ? sideB : sideA;
                let fs = Math.min(14, longSide / 7, shortSide / 1.6);
                if (fs < 6) fs = 6;
                const cx = (c0[0]+c1[0]+c2[0]+c3[0]) / 4;
                const cy = (c0[1]+c1[1]+c2[1]+c3[1]) / 4;
                ctx.save();
                ctx.translate(cx, cy);
                ctx.rotate(ang);
                ctx.font = `bold ${fs}px Raleway,sans-serif`;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
                ctx.strokeText('POL. UNDER', 0, 0);
                ctx.fillStyle = '#7a2862';
                ctx.fillText('POL. UNDER', 0, 0);
                ctx.restore();
                ctx.restore();
            }
        }

        // ── label (clipped to bounding box) ────────────────────
        ctx.beginPath();
        ctx.rect(px+2, py+2, pxw-4, pxh-4);
        ctx.clip();
        ctx.fillStyle = isSelected ? '#ffdd44' : (slabTransparent ? 'rgba(255,255,255,0.7)' : '#fff');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const lbl = p.customLabel || slabGetPieceLabel(p.ref);
        const dimStr = `${fmtInches(pw)}×${fmtInches(ph)}`;
        if (pxh > 28) {
            ctx.font = `bold ${Math.max(9, Math.min(14, pxh * 0.3))}px Raleway,sans-serif`;
            ctx.fillText(lbl, px + pxw/2, py + pxh/2 - 8);
            ctx.font = `${Math.max(8, Math.min(11, pxh * 0.2))}px Raleway,sans-serif`;
            ctx.fillText(dimStr, px + pxw/2, py + pxh/2 + 8);
        } else {
            ctx.font = `bold ${Math.max(8, Math.min(12, pxh * 0.35))}px Raleway,sans-serif`;
            ctx.fillText(`${lbl} ${dimStr}`, px + pxw/2, py + pxh/2);
        }

        // ── rotation handle (top-right, visible when selected) ─
        if (isSelected) {
            ctx.restore(); // end clip scope from label
            ctx.save();
            const hx = px + pxw + 10, hy = py - 10;
            // Circle button
            ctx.beginPath();
            ctx.arc(hx, hy, 11, 0, Math.PI * 2);
            ctx.fillStyle = '#b09030';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Rotation symbol
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('↻', hx, hy + 1);
            // Angle label below handle
            const angleLbl = ['0°','90°','180°','270°'][rot];
            ctx.font = 'bold 9px Raleway,sans-serif';
            ctx.fillStyle = '#ffdd44';
            ctx.fillText(angleLbl, hx, hy + 16);
            ctx.restore();
        } else {
            ctx.restore();
        }
    });

    // selection ring if picking
    if (slabPickingPiece) {
        ctx.strokeStyle = '#b09030';
        ctx.lineWidth = 2;
        ctx.setLineDash([6,4]);
        ctx.strokeRect(ox + dz, oy + dz, sw - 2*dz, sh - 2*dz);
        ctx.setLineDash([]);
    }

    // ── Saved remnants for this slab ─────────────────────────
    const _rems = (sd && sd.remnants) || [];
    if (!_slabSkipRemnantsInRender) {
        for (let k = 0; k < _rems.length; k++) {
            const r = _rems[k];
            const isSel = slabRemnantSelected && slabRemnantSelected.slabIdx === idx && slabRemnantSelected.idx === k;
            ctx.save();
            ctx.strokeStyle = isSel ? '#ffd060' : '#e89030';
            ctx.fillStyle = isSel ? 'rgba(255,208,96,0.10)' : 'rgba(232,144,48,0.08)';
            ctx.lineWidth = isSel ? 2.5 : 1.8;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            r.poly.forEach((p, i) => {
                const cx = ox + dz + p.x * sc;
                const cy = oy + dz + p.y * sc;
                if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
            });
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);
            // Per-edge length labels
            ctx.font = 'bold 10px Raleway,sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (let i = 0; i < r.poly.length; i++) {
                const a = r.poly[i], b = r.poly[(i+1)%r.poly.length];
                const len = Math.hypot(b.x-a.x, b.y-a.y);
                const mxC = ox + dz + (a.x + b.x) / 2 * sc;
                const myC = oy + dz + (a.y + b.y) / 2 * sc;
                ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
                const lbl = `${len.toFixed(1)}"`;
                ctx.strokeText(lbl, mxC, myC);
                ctx.fillStyle = '#ffd060';
                ctx.fillText(lbl, mxC, myC);
            }
            // Center area label
            const _lp = slabPolyLabelPos(r.poly);
            const cxC = _lp.x, cyC = _lp.y;
            const sqft = slabPolyAreaSqft(r.poly);
            const aLbl = `${sqft.toFixed(2)} sqft`;
            ctx.font = 'bold 11px Raleway,sans-serif';
            ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
            ctx.strokeText(aLbl, ox + dz + cxC * sc, oy + dz + cyC * sc);
            ctx.fillStyle = '#ffe080';
            ctx.fillText(aLbl, ox + dz + cxC * sc, oy + dz + cyC * sc);
            ctx.restore();
        }
    }

    // ── In-progress preview (live canvas only) ───────────────
    const isLiveCanvas = (ctx === slabCtx);
    if (isLiveCanvas && slabRemnantMode && slabRemnantSlabIdx === idx && slabRemnantPoints.length > 0) {
        ctx.save();
        ctx.strokeStyle = '#ffe080';
        ctx.lineWidth = 1.8;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        slabRemnantPoints.forEach((p, i) => {
            const cx = ox + dz + p.x * sc;
            const cy = oy + dz + p.y * sc;
            if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
        });
        if (slabRemnantHover && slabRemnantHover.slabIdx === idx) {
            ctx.lineTo(ox + dz + slabRemnantHover.x * sc, oy + dz + slabRemnantHover.y * sc);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        slabRemnantPoints.forEach((p, i) => {
            const isFirst = (i === 0);
            const r = isFirst && slabRemnantPoints.length >= 3 ? 7 : 4;
            ctx.fillStyle = isFirst ? '#ffd060' : '#ffe080';
            ctx.beginPath();
            ctx.arc(ox + dz + p.x * sc, oy + dz + p.y * sc, r, 0, Math.PI * 2);
            ctx.fill();
            if (isFirst && slabRemnantPoints.length >= 3) {
                ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(ox + dz + p.x * sc, oy + dz + p.y * sc, 9, 0, Math.PI * 2);
                ctx.stroke();
            }
        });
        ctx.restore();
    }
    if (isLiveCanvas && slabRemnantMode && slabRemnantHover && slabRemnantHover.slabIdx === idx) {
        ctx.save();
        ctx.fillStyle = slabRemnantHover.valid ? 'rgba(255,224,128,0.85)' : 'rgba(220,60,60,0.85)';
        ctx.beginPath();
        ctx.arc(ox + dz + slabRemnantHover.x * sc, oy + dz + slabRemnantHover.y * sc, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// ── slab canvas mouse interaction ─────────────────────────────────────
function slabCanvasXY(e) {
    const r = slabCanvas.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
}

// Returns layout info for every slab: { idx, sd, ox, oy, sw, sh, dz, sc }
function slabGetLayout() {
    const sc = slabScale();
    const cols = slabDefs.length <= 2 ? 1 : 2;
    const slabPxW = slabDefs.reduce((m, sd) => Math.max(m, sd.w * sc), 0);
    const slabPxH = slabDefs.reduce((m, sd) => Math.max(m, sd.h * sc), 0);
    return slabDefs.map((sd, idx) => {
        const col = idx % cols, row = Math.floor(idx / cols);
        const ox = SLAB_PAD + col * (slabPxW + SLAB_PAD * 2 + SLAB_GAP);
        const oy = SLAB_PAD + row * (slabPxH + SLAB_PAD * 2 + SLAB_GAP);
        return { idx, sd, ox, oy, sw: sd.w * sc, sh: sd.h * sc, dz: sd.deadZone * sc, sc };
    });
}

function slabHitTest(mx, my) {
    for (const L of slabGetLayout()) {
        if (mx >= L.ox + L.dz && mx <= L.ox + L.sw - L.dz &&
            my >= L.oy + L.dz && my <= L.oy + L.sh - L.dz) {
            return { slabIdx: L.idx,
                x: (mx - L.ox - L.dz) / L.sc,
                y: (my - L.oy - L.dz) / L.sc };
        }
    }
    return null;
}

function slabHitPiece(mx, my) {
    const layout = slabGetLayout();
    for (let i = slabPlaced.length - 1; i >= 0; i--) {
        const p = slabPlaced[i];
        const L = layout[p.slabIdx];
        if (!L) continue;
        const { w: pw, h: ph } = slabGetPieceWH(p.ref, p.rotation||0);
        const px = L.ox + L.dz + p.x * L.sc;
        const py = L.oy + L.dz + p.y * L.sc;
        if (mx >= px && mx <= px + pw * L.sc && my >= py && my <= py + ph * L.sc) return p.id;
    }
    return null;
}

// ── Remnant helpers ──────────────────────────────────────────
function slabPointOverPiece(slabIdx, x, y) {
    for (const p of slabPlaced) {
        if (p.slabIdx !== slabIdx) continue;
        const { w: pw, h: ph } = slabGetPieceWH(p.ref, p.rotation||0);
        if (x >= p.x && x <= p.x + pw && y >= p.y && y <= p.y + ph) return true;
    }
    return false;
}
function slabPolyAreaSqft(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const j = (i+1) % pts.length;
        a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(a) / 2 / 144;
}
// Returns a point guaranteed inside the polygon, suitable for placing
// labels. Uses the area centroid first, falls back to the midpoint of the
// longest interior horizontal segment for non-convex shapes (L, T, etc.).
function slabPolyLabelPos(poly) {
    let A2 = 0, cx = 0, cy = 0;
    for (let i = 0; i < poly.length; i++) {
        const j = (i+1) % poly.length;
        const cross = poly[i].x * poly[j].y - poly[j].x * poly[i].y;
        A2 += cross;
        cx += (poly[i].x + poly[j].x) * cross;
        cy += (poly[i].y + poly[j].y) * cross;
    }
    if (Math.abs(A2) > 1e-6) {
        const A = A2 / 2;
        const ax = cx / (6 * A), ay = cy / (6 * A);
        if (slabPointInPoly(ax, ay, poly)) return { x: ax, y: ay };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of poly) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    let best = { x: (minX+maxX)/2, y: (minY+maxY)/2, len: -1 };
    const N = 24;
    for (let k = 1; k < N; k++) {
        const y = minY + (maxY - minY) * k / N;
        const xs = [];
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i], b = poly[(i+1) % poly.length];
            if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
                xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
            }
        }
        xs.sort((p, q) => p - q);
        for (let s = 0; s + 1 < xs.length; s += 2) {
            const len = xs[s+1] - xs[s];
            if (len > best.len) best = { x: (xs[s] + xs[s+1]) / 2, y, len };
        }
    }
    return { x: best.x, y: best.y };
}
function slabPointInPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
}
function slabFindLayoutAt(mx, my) {
    for (const L of slabGetLayout()) {
        if (mx >= L.ox && mx <= L.ox + L.sw && my >= L.oy && my <= L.oy + L.sh) return L;
    }
    return null;
}
function slabSetRemnantMode(on) {
    slabRemnantMode = !!on;
    if (!on) { slabRemnantPoints = []; slabRemnantSlabIdx = null; slabRemnantHover = null; }
    const btn = document.getElementById('slab-remnant-btn');
    if (btn) {
        btn.style.background = on ? '#b09030' : '';
        btn.style.color = on ? '#000' : '';
        btn.style.fontWeight = on ? 'bold' : '';
    }
    if (slabCanvas) slabCanvas.style.cursor = on ? 'crosshair' : '';
    slabRender();
}

if (slabCanvas) {
    let slabDragState = null;

    slabCanvas.addEventListener('mousedown', e => {
        const { mx, my } = slabCanvasXY(e);

        // Remnant measure mode — click points on empty slab area; click near
        // the first point (or press Enter) to close the polygon.
        if (slabRemnantMode) {
            const L = slabFindLayoutAt(mx, my);
            if (!L) return;
            // Click near first point with ≥3 points → close the polygon
            if (slabRemnantPoints.length >= 3 && slabRemnantSlabIdx === L.idx) {
                const f = slabRemnantPoints[0];
                const fx = L.ox + L.dz + f.x * L.sc;
                const fy = L.oy + L.dz + f.y * L.sc;
                if (Math.hypot(mx - fx, my - fy) <= 12) {
                    const sd = slabDefs[slabRemnantSlabIdx];
                    if (!sd.remnants) sd.remnants = [];
                    sd.remnants.push({ poly: slabRemnantPoints.slice() });
                    slabRemnantPoints = [];
                    slabRemnantSlabIdx = null;
                    slabRender();
                    return;
                }
            }
            const x = (mx - L.ox - L.dz) / L.sc;
            const y = (my - L.oy - L.dz) / L.sc;
            if (slabRemnantPoints.length === 0) {
                slabRemnantSlabIdx = L.idx;
            } else if (L.idx !== slabRemnantSlabIdx) {
                return;
            }
            if (slabPointOverPiece(L.idx, x, y)) return; // reject points over pieces
            slabRemnantPoints.push({ x, y });
            slabRender();
            return;
        }

        // Click to select an existing remnant
        {
            const L = slabFindLayoutAt(mx, my);
            if (L) {
                const sd = slabDefs[L.idx];
                const rems = sd && sd.remnants || [];
                const x = (mx - L.ox - L.dz) / L.sc;
                const y = (my - L.oy - L.dz) / L.sc;
                let hit = -1;
                for (let k = rems.length - 1; k >= 0; k--) {
                    if (slabPointInPoly(x, y, rems[k].poly)) { hit = k; break; }
                }
                if (hit >= 0) {
                    slabRemnantSelected = { slabIdx: L.idx, idx: hit };
                    slabSelected = null;
                    slabRender();
                    return;
                }
            }
            slabRemnantSelected = null;
        }

        if (slabPickingPiece) {
            // place piece at click location — no restrictions
            const hit = slabHitTest(mx, my);
            if (hit) {
                const { w: pw, h: ph } = slabGetPieceWH(slabPickingPiece, 0);
                const px = Math.max(0, hit.x - pw / 2);
                const py = Math.max(0, hit.y - ph / 2);
                slabPlaced.push({
                    id: _slabNextId++,
                    slabIdx: hit.slabIdx,
                    ref: { ...slabPickingPiece }, // includes wi, hi, label, segIdx
                    x: px, y: py,
                    rotation: 0
                });
                slabPickingPiece = null;
                document.querySelectorAll('.slab-piece-btn').forEach(b => b.style.borderColor = '');
                slabRefreshPieceList();
                slabRender();
            }
            return;
        }

        // check rotation handle on selected piece first
        if (slabSelected) {
            const sp = slabPlaced.find(pl => pl.id === slabSelected);
            if (sp) {
                const sL = slabGetLayout()[sp.slabIdx];
                if (sL) {
                    const { w: spw, h: sph } = slabGetPieceWH(sp.ref, sp.rotation||0);
                    const hx = sL.ox + sL.dz + sp.x * sL.sc + spw * sL.sc + 8;
                    const hy = sL.oy + sL.dz + sp.y * sL.sc - 8;
                    if (Math.hypot(mx - hx, my - hy) <= 10) {
                        sp.rotation = ((sp.rotation||0) + 1) % 4; slabRender(); return;
                    }
                }
            }
        }

        // select / begin drag — record absolute canvas start position of piece top-left
        const hitId = slabHitPiece(mx, my);
        slabSelected = hitId;
        if (hitId) {
            const p = slabPlaced.find(pl => pl.id === hitId);
            if (p) {
                const layout = slabGetLayout();
                const L = layout[p.slabIdx];
                slabDragState = {
                    id: hitId,
                    startMx: mx, startMy: my,
                    startX: p.x, startY: p.y,
                    startSlabIdx: p.slabIdx,
                    // absolute canvas coords of piece top-left at drag start
                    startCanvX: L.ox + L.dz + p.x * L.sc,
                    startCanvY: L.oy + L.dz + p.y * L.sc,
                    sc: L.sc
                };
            }
        }
        slabRender();
    });

    slabCanvas.addEventListener('mousemove', e => {
        if (slabRemnantMode) {
            const { mx, my } = slabCanvasXY(e);
            const L = slabFindLayoutAt(mx, my);
            if (L && (slabRemnantPoints.length === 0 || L.idx === slabRemnantSlabIdx)) {
                const x = (mx - L.ox - L.dz) / L.sc;
                const y = (my - L.oy - L.dz) / L.sc;
                slabRemnantHover = { slabIdx: L.idx, x, y, valid: !slabPointOverPiece(L.idx, x, y) };
            } else {
                slabRemnantHover = null;
            }
            slabRender();
            return;
        }
        if (!slabDragState) return;
        const { mx, my } = slabCanvasXY(e);
        const p = slabPlaced.find(pl => pl.id === slabDragState.id);
        if (!p) return;

        const { w: pw, h: ph } = slabGetPieceWH(p.ref, p.rotation||0);
        const sc = slabDragState.sc;
        // Desired absolute canvas position of piece top-left
        const canvX = slabDragState.startCanvX + (mx - slabDragState.startMx);
        const canvY = slabDragState.startCanvY + (my - slabDragState.startMy);
        // Piece center in canvas coords
        const cenX = canvX + pw * sc / 2;
        const cenY = canvY + ph * sc / 2;

        // Find which slab the piece center is over (full slab area, not just usable)
        const layout = slabGetLayout();
        let targetL = null;
        for (const L of layout) {
            if (cenX >= L.ox && cenX <= L.ox + L.sw &&
                cenY >= L.oy && cenY <= L.oy + L.sh) { targetL = L; break; }
        }
        if (!targetL) return; // between slabs — freeze position

        // Compute position in target slab's usable coordinates
        // Free placement — no clamping
        const nx = (canvX - targetL.ox - targetL.dz) / sc;
        const ny = (canvY - targetL.oy - targetL.dz) / sc;

        p.slabIdx = targetL.idx;
        p.x = nx;
        p.y = ny;
        slabRender();
    });

    slabCanvas.addEventListener('mouseup', () => {
        if (slabDragState) {
            const p = slabPlaced.find(pl => pl.id === slabDragState.id);
            if (p) {
                // No snap-back — pieces can overlap and extend past slab edges
                if (false) {
                    p.slabIdx = slabDragState.startSlabIdx;
                    p.x = slabDragState.startX;
                    p.y = slabDragState.startY;
                    slabRender();
                }
            }
            slabDragState = null;
        }
    });
    slabCanvas.addEventListener('mouseleave', () => {
        if (slabDragState) {
            // Snap back to original slab/position when mouse leaves canvas
            const p = slabPlaced.find(pl => pl.id === slabDragState.id);
            if (p) {
                p.slabIdx = slabDragState.startSlabIdx;
                p.x = slabDragState.startX;
                p.y = slabDragState.startY;
            }
            slabDragState = null; slabRender();
        }
    });

    // double-click to rename a placed piece
    slabCanvas.addEventListener('dblclick', e => {
        const { mx, my } = slabCanvasXY(e);
        const hitId = slabHitPiece(mx, my);
        if (hitId) {
            const p = slabPlaced.find(pl => pl.id === hitId);
            if (p) {
                const current = p.customLabel || slabGetPieceLabel(p.ref);
                const newLabel = prompt('Rename piece:', current);
                if (newLabel !== null) {
                    p.customLabel = newLabel.trim() || null;
                    slabRender();
                }
            }
        }
    });
}

// ESC cancels picking (global)
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && slabPickingPiece) {
        slabPickingPiece = null;
        document.querySelectorAll('.slab-piece-btn').forEach(b => b.style.borderColor = '');
        slabRender();
    }
    if (e.key === 'Escape' && slabRemnantMode) {
        if (slabRemnantPoints.length > 0) {
            slabRemnantPoints = [];
            slabRemnantSlabIdx = null;
            slabRender();
        } else {
            slabSetRemnantMode(false);
        }
    }
    if (e.key === 'Enter' && slabRemnantMode && slabRemnantPoints.length >= 3 && !e.target.closest('input,textarea,select')) {
        const sd = slabDefs[slabRemnantSlabIdx];
        if (sd) {
            if (!sd.remnants) sd.remnants = [];
            sd.remnants.push({ poly: slabRemnantPoints.slice() });
        }
        slabRemnantPoints = [];
        slabRemnantSlabIdx = null;
        slabRender();
        e.preventDefault();
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && slabSelected && !e.target.closest('input,textarea,select')) {
        slabPlaced = slabPlaced.filter(p => p.id !== slabSelected);
        slabSelected = null;
        slabRefreshPieceList();
        slabRender();
    }
    if ((e.key === 'r' || e.key === 'R') && slabSelected && !e.target.closest('input,textarea,select')) {
        const sp = slabPlaced.find(pl => pl.id === slabSelected);
        if (sp) {
            sp.rotation = ((sp.rotation || 0) + 1) % 4;
            slabRender();
            e.preventDefault();
        }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && slabRemnantSelected && !e.target.closest('input,textarea,select')) {
        const sel = slabRemnantSelected;
        const sd = slabDefs[sel.slabIdx];
        if (sd && sd.remnants) sd.remnants.splice(sel.idx, 1);
        slabRemnantSelected = null;
        slabRender();
    }
});

// Wire remnant tool button + PDF toggle
{
    const rbtn = document.getElementById('slab-remnant-btn');
    if (rbtn) rbtn.addEventListener('click', () => slabSetRemnantMode(!slabRemnantMode));
    const rchk = document.getElementById('slab-remnant-pdf-toggle');
    if (rchk) {
        rchk.checked = slabIncludeRemnantsInPdf;
        rchk.addEventListener('change', () => { slabIncludeRemnantsInPdf = rchk.checked; });
    }
}

function calcPageSqft(page) {
    // Gross countertop sqft — matches the pricing tab's billable calculation.
    // Cutouts (sinks, cooktops, outlets, bocci) are NOT subtracted: you still pay
    // for the slab area around them. Farmhouse sinks remain subtracted because they
    // live at the edge of the slab and are handled as a property on the main shape.
    let total = 0;
    for (const s of page.shapes) {
        if (s.subtype) continue;  // skip sink/cooktop/outlet/bocci cutout shapes
        let area = s.w * s.h;
        if (s.shapeType === 'l') area -= (s.notchW||0) * (s.notchH||0);
        if (s.shapeType === 'u') area = uShapeAreaPx(s);
        if (s.shapeType === 'circle') area = Math.PI * (s.w / 2) * (s.h / 2);
        if (s.farmSink) area -= (FS_WIDTH_IN * INCH) * (FS_DEPTH_IN * INCH);
        area -= totalCheckAreaPx(s);
        total += area;
    }
    return Math.max(0, total) / SQFT_PX2;
}

// Returns linear footage per edge type for a page { polished:0, mitered:0, ... }
function calcPageEdgeFootage(page) {
    const totals = {};
    for (const s of page.shapes) {
        if (s.subtype) continue;

        // Helper: accumulate length in px for a given edge type
        function addSeg(type, lenPx) {
            if (!type || type === 'none' || type === 'joint') return;
            totals[type] = (totals[type] || 0) + lenPx;
        }
        // Helper: handle both single and segmented edges
        function addEdge(edgeData, lenPx) {
            if (edgeData?.type === 'segmented' && edgeData.segments) {
                for (const seg of edgeData.segments) addSeg(seg.profile, seg.length * INCH);
            } else { addSeg(edgeData?.type, lenPx); }
        }

        if (s.shapeType === 'circle') {
            const r = s.w / 2;
            addSeg(s.edges?.arc?.type, 2 * Math.PI * r);
        } else if (s.shapeType === 'l') {
            // 6 straight sides
            const sides = lShapeSides(s);
            for (const sd of sides) {
                addEdge(s.edges?.[sd.key], Math.hypot(sd.x2-sd.x1, sd.y2-sd.y1));
            }
            // L-shape per-vertex treatments (chamfer diagonals OR radius arcs)
            const verts = lShapeVerts(s);
            for (let i = 0; i < verts.length; i++) {
                const nv = verts[i];
                if (nv.t > 0 && nv.r === 0) {
                    const dk = `diag_lc${i}`;
                    addSeg(s.chamferEdges?.[dk]?.type, Math.hypot(nv.pout[0]-nv.pin[0], nv.pout[1]-nv.pin[1]));
                } else if (nv.r > 0) {
                    addSeg(s.cornerEdges?.[`lc${i}`]?.type, Math.PI / 2 * nv.r);
                }
            }
        } else if (s.shapeType === 'u') {
            const sides = uShapeSides(s);
            for (const sd of sides) {
                addEdge(s.edges?.[sd.key], Math.hypot(sd.x2-sd.x1, sd.y2-sd.y1));
            }
            // U-shape radius arcs (best-effort)
            const poly = uShapePolygon(s);
            for (let i = 0; i < poly.length; i++) {
                const rad = (s.corners && s.corners[`uc${i}`]) || 0;
                if (rad > 0) addSeg(s.cornerEdges?.[`uc${i}`]?.type, Math.PI / 2 * rad);
            }
        } else if (s.shapeType === 'bsp') {
            const sides = bspSides(s);
            for (const sd of sides) {
                addEdge(s.edges?.[sd.key], Math.hypot(sd.x2-sd.x1, sd.y2-sd.y1));
            }
        } else {
            // rect: 4 sides + corner arcs + chamfer diagonals
            const ch = shapeChamfers(s), chB = shapeChamfersB(s), r = shapeRadii(s);
            const nwA = ch.nw > 0 ? ch.nw : r.nw, nwB = ch.nw > 0 ? chB.nw : r.nw;
            const neA = ch.ne > 0 ? ch.ne : r.ne, neB = ch.ne > 0 ? chB.ne : r.ne;
            const seA = ch.se > 0 ? ch.se : r.se, seB = ch.se > 0 ? chB.se : r.se;
            const swA = ch.sw > 0 ? ch.sw : r.sw, swB = ch.sw > 0 ? chB.sw : r.sw;
            const sideSegs = [
                { key:'top',    len: s.w - nwA - neA },
                { key:'right',  len: s.h - neB - seA },
                { key:'bottom', len: s.w - seB - swA },
                { key:'left',   len: s.h - swB - nwB },
            ];
            for (const sd of sideSegs) {
                if (sd.len > 0) addEdge(s.edges?.[sd.key], sd.len);
            }
            // corner arcs
            const corners = ['nw','ne','se','sw'];
            for (const k of corners) {
                if (r[k] > 0) addSeg(s.cornerEdges?.[k]?.type, Math.PI / 2 * r[k]);
            }
            // chamfer diagonals
            const chamferSegs2 = [
                { key:'nw', len: Math.hypot(ch.nw, chB.nw) },
                { key:'ne', len: Math.hypot(ch.ne, chB.ne) },
                { key:'se', len: Math.hypot(ch.se, chB.se) },
                { key:'sw', len: Math.hypot(ch.sw, chB.sw) },
            ];
            for (const cd of chamferSegs2) {
                if (cd.len > 0) addSeg(s.chamferEdges?.['diag_'+cd.key]?.type, cd.len);
            }
        }
    }
    // Convert px → linear feet (INCH = px/inch, 12in = 1ft)
    const result = {};
    for (const [type, px] of Object.entries(totals)) {
        result[type] = px / (INCH * 12);
    }
    return result;
}

// Per-page pricing breakdown (material + per-page services + subtotal)
function calcPagePricing(page) {
    const roomSqft = calcPageSqft(page);
    const pageMat = (formData.materials||[]).find(m =>
        (m.type||'page') === 'page' && m.pageId === page.id
    );

    // Material + cutting — slab-based (matches pricing tab; respects user slab overrides)
    let matCost = 0, cutCost = 0, cutRate = 0;
    let isDekton = false;
    if (pageMat && roomSqft > 0) {
        isDekton = (pageMat.supplier||'').toLowerCase().includes('dekton')
                || (pageMat.color   ||'').toLowerCase().includes('dekton')
                || (pageMat.thickness||'').toLowerCase().includes('dekton');
        const dbCostPerSlab = getMatCostPerSlab(pageMat.id);
        const slabSqft = getMatSlabSqft(pageMat.id);
        const suggestedQty = slabSqft > 0 ? Math.ceil(roomSqft / slabSqft) : 1;
        const ov = (pricingData.slabOverrides||{})[pageMat.id] || {};
        const slabQty = ov.qty != null ? ov.qty : suggestedQty;
        const useCustom = ov.customPrice != null && ov.customPrice >= 0;
        const pricePerSlab = useCustom ? ov.customPrice : dbCostPerSlab;
        matCost = slabQty * pricePerSlab;
        cutRate = isDekton ? (pricingData.rates.dektonCoupe||0) : (pricingData.rates.coupe||0);
        cutCost = roomSqft * cutRate;
    }

    // Edge services: pencil+polished → pencil rate, waterfall → fini45, mitered → lamine
    const edgeFootage = calcPageEdgeFootage(page);
    const pencilLf = (edgeFootage.pencil || 0) + (edgeFootage.polished || 0);
    const fini45Lf = edgeFootage.waterfall || 0;
    const lamineLf = edgeFootage.mitered || 0;
    const pencilCost = pencilLf * (pricingData.rates.pencil || 0);
    const fini45Cost = fini45Lf * (pricingData.rates.fini45 || 0);
    const lamineCost = lamineLf * (pricingData.rates.lamine || 0);

    // Sink + cooktop holes
    const sinks = calcPageSinkCounts(page);
    const evierOverCost   = sinks.overmount  * (pricingData.rates.evierOver   || 0);
    const evierUnderCost  = sinks.undermount * (pricingData.rates.evierUnder  || 0);
    const evierVasqueCost = sinks.vasque     * (pricingData.rates.evierVasque || 0);
    const cooktopCost     = sinks.cooktops   * (pricingData.rates.cooktop     || 0);
    const farmSinkCost    = sinks.farmSinks  * (pricingData.rates.farmSink    || 0);
    const outletCost      = sinks.outlets    * (pricingData.rates.outlet      || 0);
    const bocciCost       = sinks.boccis     * (pricingData.rates.bocci       || 0);

    const servicesCost  = pencilCost + fini45Cost + lamineCost + evierOverCost + evierUnderCost + evierVasqueCost + cooktopCost + farmSinkCost + outletCost + bocciCost;
    const pageSubtotal  = matCost + cutCost + servicesCost;

    return {
        page, pageMat, roomSqft, isDekton,
        matCost, cutCost, cutRate,
        edgeFootage, pencilLf, fini45Lf, lamineLf, pencilCost, fini45Cost, lamineCost,
        sinks, evierOverCost, evierUnderCost, evierVasqueCost, cooktopCost, farmSinkCost,
        outletCost, bocciCost,
        servicesCost, pageSubtotal
    };
}

// Project-wide fees applied once (not attributable to a single page)
// Per-page pricing for all linked materials (multi-option pages).
// Returns shared page services + an options[] array, one entry per linked material.
// If 2+ materials are linked to the same page, they are treated as options the
// client must choose between.
function calcPageOptions(page) {
    const roomSqft = calcPageSqft(page);
    const mats = (formData.materials||[]).filter(m =>
        (m.type||'page') === 'page' && m.pageId === page.id
    );

    // Edge services (shared across options)
    const edgeFootage = calcPageEdgeFootage(page);
    const pencilLf = (edgeFootage.pencil || 0) + (edgeFootage.polished || 0);
    const fini45Lf = edgeFootage.waterfall || 0;
    const lamineLf = edgeFootage.mitered || 0;
    const pencilCost = pencilLf * (pricingData.rates.pencil || 0);
    const fini45Cost = fini45Lf * (pricingData.rates.fini45 || 0);
    const lamineCost = lamineLf * (pricingData.rates.lamine || 0);

    // Sink/cooktop/farmhouse + outlets/boccis (shared across options)
    const sinks = calcPageSinkCounts(page);
    const evierOverCost   = sinks.overmount  * (pricingData.rates.evierOver   || 0);
    const evierUnderCost  = sinks.undermount * (pricingData.rates.evierUnder  || 0);
    const evierVasqueCost = sinks.vasque     * (pricingData.rates.evierVasque || 0);
    const cooktopCost     = sinks.cooktops   * (pricingData.rates.cooktop     || 0);
    const farmSinkCost    = sinks.farmSinks  * (pricingData.rates.farmSink    || 0);
    const outletCost      = sinks.outlets    * (pricingData.rates.outlet      || 0);
    const bocciCost       = sinks.boccis     * (pricingData.rates.bocci       || 0);

    const servicesCost = pencilCost + fini45Cost + lamineCost
                       + evierOverCost + evierUnderCost + evierVasqueCost
                       + cooktopCost + farmSinkCost
                       + outletCost + bocciCost;

    // Per-option (material + cutting); services are added to each option's subtotal.
    // Material cost uses the SAME slab-based calculation as the pricing tab (respects
    // user overrides for slab qty + price per slab via pricingData.slabOverrides).
    const options = mats.map(mat => {
        const isDekton = (mat.supplier||'').toLowerCase().includes('dekton')
                      || (mat.color   ||'').toLowerCase().includes('dekton')
                      || (mat.thickness||'').toLowerCase().includes('dekton');
        // Slab-based material cost (matches buildMatBlock in renderPricingPanel)
        const dbCostPerSlab = getMatCostPerSlab(mat.id);
        const slabSqft = getMatSlabSqft(mat.id);
        const suggestedQty = slabSqft > 0 ? Math.ceil(roomSqft / slabSqft) : 1;
        const ov = (pricingData.slabOverrides||{})[mat.id] || {};
        const slabQty = ov.qty != null ? ov.qty : suggestedQty;
        const useCustom = ov.customPrice != null && ov.customPrice >= 0;
        const pricePerSlab = useCustom ? ov.customPrice : dbCostPerSlab;
        const matCost = slabQty * pricePerSlab;
        // Cutting (same formula across both views)
        const cutRate = isDekton ? (pricingData.rates.dektonCoupe||0) : (pricingData.rates.coupe||0);
        const cutCost = roomSqft * cutRate;
        const optionSubtotal = matCost + cutCost + servicesCost;
        return { material: mat, isDekton, slabQty, pricePerSlab, matCost, cutCost, cutRate, optionSubtotal };
    });

    return {
        page, roomSqft,
        edgeFootage, pencilLf, fini45Lf, lamineLf, pencilCost, fini45Cost, lamineCost,
        sinks, evierOverCost, evierUnderCost, evierVasqueCost, cooktopCost, farmSinkCost,
        servicesCost,
        options,                      // one entry per linked material (0+ entries)
        multi: options.length > 1     // convenience flag
    };
}

// Cross-product of per-page options across all pages that have shapes.
// Returns { pageOptionsList: [calcPageOptions(p), ...], combos: [[{pageOpt, optionIdx},...], ...] }.
function calcAllCombinations() {
    const pageOptionsList = [];
    for (const page of pages) {
        const po = calcPageOptions(page);
        if (po.roomSqft <= 0) continue;   // skip empty canvas pages
        pageOptionsList.push(po);
    }
    if (pageOptionsList.length === 0) return { combos: [], pageOptionsList };

    // Cross-product — pages with zero options contribute a null selection.
    let combos = [[]];
    for (const po of pageOptionsList) {
        const nextCombos = [];
        const n = Math.max(1, po.options.length);
        for (const combo of combos) {
            for (let i = 0; i < n; i++) {
                nextCombos.push([...combo, { pageOpt: po, optionIdx: po.options.length > 0 ? i : -1 }]);
            }
        }
        combos = nextCombos;
    }
    return { combos, pageOptionsList };
}

function calcProjectFees() {
    let totalSqft = 0;
    for (const page of pages) totalSqft += calcPageSqft(page);
    const installRate = pricingData.rates.installation || 0;
    const installMin  = pricingData.installationMin   || 0;
    const installRaw  = totalSqft * installRate;
    // "Custom install price" in Pricing tab wins when set (any positive value)
    const instCustomRaw = pricingData.installationCustom;
    const installCustom = (instCustomRaw != null && instCustomRaw !== '')
        ? (parseFloat(instCustomRaw) || 0) : 0;
    const installCost = installCustom > 0 ? installCustom : Math.max(installRaw, installMin);
    const installMinApplied = installCustom <= 0 && installMin > 0 && installRaw < installMin;
    const installCustomUsed = installCustom > 0;
    const measEnabled = pricingData.measurementsEnabled !== false;
    const measCost    = measEnabled ? (pricingData.rates.measurements || 0) : 0;
    const polQty      = pricingData.polissageSousQty || 0;
    const polCost     = polQty * (pricingData.rates.polissageSous || 0);
    return {
        totalSqft,
        installRate, installMin, installRaw, installCost, installMinApplied, installCustomUsed, installCustom,
        measEnabled, measCost,
        polQty, polCost,
        total: installCost + measCost + polCost
    };
}

function calcRoomPricing(page) {
    const TAX      = 1.14975; // 1 + GST(5%) + QST(9.975%)
    const roomSqft = calcPageSqft(page);

    // Find the Page-type material linked to THIS canvas page (by pageId)
    const pageMat = (formData.materials||[]).find(m =>
        (m.type||'page') === 'page' && m.pageId === page.id
    );

    const matEntries = [];
    let materialCostTotal = 0;
    if (pageMat && roomSqft > 0) {
        const isDekton = (pageMat.supplier||'').toLowerCase().includes('dekton') ||
                         (pageMat.color||'').toLowerCase().includes('dekton') ||
                         (pageMat.thickness||'').toLowerCase().includes('dekton') ||
                         (pageMat.notes||'').toLowerCase().includes('dekton');
        const pps = getMatPriceSqft(pageMat.id);
        const matCost = roomSqft * pps;
        const cuttingRate = isDekton ? (pricingData.rates.dektonCoupe || 0) : (pricingData.rates.coupe || 0);
        const cuttingCost = roomSqft * cuttingRate;
        const entryPreT = matCost + cuttingCost;
        materialCostTotal = entryPreT;
        matEntries.push({
            color:     pageMat.color     || '',
            supplier:  pageMat.supplier  || '',
            thickness: pageMat.thickness || '',
            finish:    pageMat.finish    || '',
            preT:      entryPreT,
            isDekton,
            mtype:     'page',
            mlabel:    page.name
        });
    }

    // Use new service rate model — exclude coupe/dektonCoupe (already attributed per-material)
    const serviceItems = getServiceLineItems().filter(i => i.key !== 'coupe' && i.key !== 'dektonCoupe');
    const totalAddons = serviceItems.reduce((s, i) => s + i.cost, 0);

    // Blend addons proportionally (only one entry here, but keep logic for fallback)
    for (const m of matEntries) {
        const share = materialCostTotal > 0
            ? (m.preT / materialCostTotal) * totalAddons
            : (matEntries.length > 0 ? totalAddons / matEntries.length : 0);
        m.blendedPreT = m.preT + share;
        m.total = m.blendedPreT * TAX;
    }
    // If the page has no linked material but still has services, create a single entry
    if (matEntries.length === 0 && totalAddons > 0) {
        matEntries.push({
            color:'Services', supplier:'', thickness:'', finish:'',
            preT: 0, blendedPreT: totalAddons, total: totalAddons * TAX,
            mtype: 'page', mlabel: page.name
        });
    }

    const roomTotal = matEntries.reduce((s,m) => s + m.total, 0);
    return { roomSqft, matEntries, roomTotal };
}

// ── Project-wide Options summary (used for the PDF summary page) ───
// Each option is a full-project scenario: its own slab across total sqft + cutting + all services + committed non-option materials.
function calcOptionsSummary() {
    const TAX = 1.14975;
    // Total project sqft (all shapes across all pages)
    let totalSqft = 0;
    for (const page of pages) {
        for (const s of page.shapes) {
            if (s.subtype) continue;
            let area = s.w * s.h;
            if (s.shapeType === 'l')      area -= (s.notchW||0) * (s.notchH||0);
            if (s.shapeType === 'u')      area  = uShapeAreaPx(s);
            if (s.shapeType === 'circle') area  = Math.PI * (s.w/2) * (s.h/2);
            if (s.farmSink)               area -= (FS_WIDTH_IN * INCH) * (FS_DEPTH_IN * INCH);
            area -= totalCheckAreaPx(s);
            totalSqft += area / SQFT_PX2;
        }
    }
    // Shared services (all non-cutting line items, including polissage/install/measurements)
    const serviceItems = getServiceLineItems().filter(i => i.key !== 'coupe' && i.key !== 'dektonCoupe');
    const sharedServices = serviceItems.reduce((s, i) => s + i.cost, 0);

    // Shared committed material cost — Page-type materials added to every whole-project Option scenario.
    // Uses the SAME slab-based math as the pricing tab (respects user slab qty/price overrides).
    let sharedCommittedMat = 0;
    for (const page of pages) {
        const pageMat = (formData.materials||[]).find(mm =>
            (mm.type||'page') === 'page' && mm.pageId === page.id
        );
        if (!pageMat) continue;
        const pSqft = calcPageSqft(page);
        if (pSqft <= 0) continue;
        const isDekton = (pageMat.supplier||'').toLowerCase().includes('dekton') ||
                         (pageMat.color||'').toLowerCase().includes('dekton') ||
                         (pageMat.thickness||'').toLowerCase().includes('dekton');
        const dbCostPerSlab = getMatCostPerSlab(pageMat.id);
        const slabSqft = getMatSlabSqft(pageMat.id);
        const suggestedQty = slabSqft > 0 ? Math.ceil(pSqft / slabSqft) : 1;
        const ov = (pricingData.slabOverrides||{})[pageMat.id] || {};
        const slabQty = ov.qty != null ? ov.qty : suggestedQty;
        const useCustom = ov.customPrice != null && ov.customPrice >= 0;
        const pricePerSlab = useCustom ? ov.customPrice : dbCostPerSlab;
        const matCost = slabQty * pricePerSlab;
        const cutRate = isDekton ? (pricingData.rates.dektonCoupe||0) : (pricingData.rates.coupe||0);
        sharedCommittedMat += matCost + pSqft * cutRate;
    }

    const sharedBaseline = sharedServices + sharedCommittedMat;

    // Per-option breakdowns
    const options = [];
    for (const mat of (formData.materials||[])) {
        if ((mat.type||'page') !== 'option') continue;
        const label = mat.label || `Option ${getOptionLetter(mat)}`;
        const isDekton = (mat.supplier||'').toLowerCase().includes('dekton') ||
                         (mat.color||'').toLowerCase().includes('dekton') ||
                         (mat.thickness||'').toLowerCase().includes('dekton');

        // Slab cost: prefer user overrides; else derive from DB slab size
        const dbCostPerSlab = getMatCostPerSlab(mat.id);
        const slabSqft = getMatSlabSqft(mat.id);
        const suggestedQty = slabSqft > 0 ? Math.ceil(totalSqft / slabSqft) : 1;
        const ov = (pricingData.slabOverrides||{})[mat.id] || {};
        const slabQty = ov.qty != null ? ov.qty : suggestedQty;
        const useCustom = ov.customPrice != null && ov.customPrice >= 0;
        const pricePerSlab = useCustom ? ov.customPrice : dbCostPerSlab;
        const slabCost = slabQty * pricePerSlab;

        const cutRate = isDekton ? (pricingData.rates.dektonCoupe||0) : (pricingData.rates.coupe||0);
        const cuttingCost = totalSqft * cutRate;

        const preT = slabCost + cuttingCost + sharedBaseline;
        const total = preT * TAX;

        options.push({
            label, mat, isDekton,
            color: mat.color||'', supplier: mat.supplier||'', thickness: mat.thickness||'', finish: mat.finish||'',
            sqft: totalSqft, slabQty, pricePerSlab, slabCost,
            cuttingRate: cutRate, cuttingCost,
            sharedServices, sharedCommittedMat, sharedBaseline,
            preT, total
        });
    }
    return { options, totalSqft, sharedServices, sharedCommittedMat, sharedBaseline };
}

// ── Generate Proposal PDF (customer-facing) ───────────────────
function generateProposal() {
    const jsPDFLib = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFLib) { alert('jsPDF library not loaded.'); return; }
    syncPageOut();

    const doc    = new jsPDFLib({ unit:'pt', format:'letter' });
    const PW=612, PH=792, ML=45, MR=45, CW=612-45-45, FOOTER_H=62;
    const BRAND  = [45, 58, 16];
    const ACCENT = [176, 144, 48];
    const TBL_BG = [240, 237, 216];
    const BODY_T = [38, 32, 12];

    let y = 90;

    function addPageFooter() {
        doc.setFillColor(245, 244, 240);
        doc.rect(0, PH-FOOTER_H+1, PW, FOOTER_H, 'F');
        doc.setDrawColor(...BRAND);
        doc.setLineWidth(0.6);
        doc.line(ML, PH-FOOTER_H, PW-MR, PH-FOOTER_H);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7);
        doc.setTextColor(120, 120, 120);
        doc.text('Soumission valide 30 jours. Les prix sont sujets à changement sans préavis.', PW/2, PH-48, {align:'center'});
        doc.text('Quote valid for 30 days. Prices subject to change without notice.', PW/2, PH-38, {align:'center'});
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...BRAND);
        doc.text('SPARTAN', PW/2, PH-24, {align:'center'});
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.5);
        doc.setTextColor(120, 100, 50);
        doc.text('GST 72430 5677 RT0001  /  QST 1226651001 TQ0001', PW/2, PH-12, {align:'center'});
    }

    function newPdfPage() { doc.addPage(); y = 32; addPageFooter(); }
    function checkY(n) { if (y + n > PH - FOOTER_H - 10) newPdfPage(); }
    function sectionHead(title) {
        checkY(28);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...BRAND);
        doc.text(title, ML, y);
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.75);
        doc.line(ML, y+3, PW-MR, y+3);
        y += 16;
    }

    // Header
    doc.setFillColor(...BRAND); doc.rect(0, 0, PW, 70, 'F');
    doc.setFillColor(...ACCENT); doc.rect(0, 68, PW, 2.5, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(22); doc.setTextColor(255,255,255);
    doc.text('SPARTAN', ML, 34);
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(...ACCENT);
    doc.text('SOUMISSION / ESTIMATE', ML, 52);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(255,255,255);
    doc.text(`Soumission #: ${formData.order || '—'}`, PW-MR, 22, {align:'right'});
    doc.setFont('helvetica','italic'); doc.setFontSize(7); doc.setTextColor(...ACCENT);
    doc.text(`Estimate #: ${formData.order || '—'}`, PW-MR, 31, {align:'right'});
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(255,255,255);
    doc.text(`Date : ${formData.date || todayStr()}`, PW-MR, 44, {align:'right'});
    // Valid until: +30 days
    const validUntil = (() => {
        try { const d=new Date(formData.date||new Date()); d.setDate(d.getDate()+30);
            return d.toLocaleDateString('fr-CA',{year:'numeric',month:'long',day:'numeric'}); }
        catch(e){ return ''; }
    })();
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(255,255,255);
    doc.text(`Valide jusqu'au : ${validUntil}`, PW-MR, 57, {align:'right'});
    doc.setFont('helvetica','italic'); doc.setFontSize(6.5); doc.setTextColor(...ACCENT);
    doc.text(`Valid until: ${validUntil}`, PW-MR, 65, {align:'right'});
    addPageFooter();

    // Bill To banner — full client info (client + job + address + phones)
    const phones = (formData.phones || []).filter(Boolean);
    const addrLines = formData.address ? doc.splitTextToSize(formData.address, CW/2 - 14) : [];
    const leftLines = 1 /*client*/ + (formData.job ? 1 : 0) + addrLines.length;
    const rightLines = phones.length;
    const bodyLines = Math.max(leftLines, rightLines);
    const billH = 20 /*header band*/ + bodyLines * 12 + 10 /*padding*/;

    doc.setFillColor(...TBL_BG); doc.rect(ML, y, CW, billH, 'F');
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.5); doc.rect(ML, y, CW, billH, 'S');
    // Vertical divider between left (Bill To) and right (Phone) columns
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.3);
    doc.line(ML + CW/2, y + 4, ML + CW/2, y + billH - 4);

    // Left column — FACTURÉ À
    doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...BRAND);
    doc.text('FACTURÉ À', ML+6, y+11);
    doc.setFont('helvetica','italic'); doc.setFontSize(6); doc.setTextColor(120,100,50);
    doc.text('Bill to', ML+54, y+11);
    let ly = y + 26;
    doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(...BODY_T);
    doc.text(formData.client || '—', ML+6, ly); ly += 14;
    if (formData.job) {
        doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(80,68,30);
        doc.text(formData.job, ML+6, ly); ly += 11;
    }
    if (addrLines.length > 0) {
        doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(80,68,30);
        for (const l of addrLines) { doc.text(l, ML+6, ly); ly += 10; }
    }

    // Right column — TÉLÉPHONE
    if (phones.length > 0) {
        doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...BRAND);
        doc.text('TÉLÉPHONE', ML + CW/2 + 8, y+11);
        doc.setFont('helvetica','italic'); doc.setFontSize(6); doc.setTextColor(120,100,50);
        doc.text('Phone', ML + CW/2 + 60, y+11);
        doc.setFont('helvetica','normal'); doc.setFontSize(10); doc.setTextColor(...BODY_T);
        let py = y + 28;
        for (const ph of phones) { doc.text(ph, ML + CW/2 + 8, py); py += 12; }
    }

    y += billH + 12;

    // Layout drawings — each page gets its own pricing panel (material + services + subtotal)
    const PANEL_W = 190;
    const savedIdx = currentPageIdx;
    dimSizeMultiplier = 1.5;
    // Estimate panel content height for a page with 1+ option(s) (supports multi-option pages)
    function panelContentH(po) {
        let h = 22; // room name header + separator
        h += 10; // sqft
        const edgeTypes = Object.keys(po.edgeFootage);
        if (edgeTypes.length > 0) h += 8 + edgeTypes.length * 9 + 7;
        let nServiceLines = 0;
        if (po.sinks.overmount  > 0) nServiceLines++;
        if (po.sinks.undermount > 0) nServiceLines++;
        if (po.sinks.vasque     > 0) nServiceLines++;
        if (po.sinks.cooktops   > 0) nServiceLines++;
        if (po.sinks.farmSinks  > 0) nServiceLines++;
        if (po.sinks.outlets    > 0) nServiceLines++;
        if (po.sinks.boccis     > 0) nServiceLines++;
        if (nServiceLines > 0) h += 8 + nServiceLines * 9 + 7;
        if (po.options.length === 0) {
            if (po.servicesCost > 0) h += 26;
        } else {
            po.options.forEach((opt, i) => {
                if (po.options.length > 1) h += 9; // "OPTION N" label
                h += 10; // material name
                const matDet = [opt.material.supplier, opt.material.thickness, opt.material.finish].filter(Boolean).join(' • ');
                if (matDet) h += 8;
                h += 10; // matériel + découpe
                if (po.servicesCost > 0) h += 10; // services line
                h += 26; // subtotal box
                if (i < po.options.length - 1) h += 6; // gap
            });
        }
        h += 6; // bottom padding
        return h;
    }

    // Crop canvas to shape bounding box so small rooms fill the image area
    function croppedCanvasData(page) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const s of page.shapes) {
            x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y);
            x1 = Math.max(x1, s.x + s.w); y1 = Math.max(y1, s.y + s.h);
        }
        for (const ti of (page.textItems || [])) {
            x0 = Math.min(x0, ti.x); y0 = Math.min(y0, ti.y);
            x1 = Math.max(x1, ti.x + 80); y1 = Math.max(y1, ti.y + 20);
        }
        // Include profile diagrams in bounding box
        for (const d of (page.profileDiags || [])) {
            x0 = Math.min(x0, d.x); y0 = Math.min(y0, d.y);
            x1 = Math.max(x1, d.x + (d.w || DIAG_DEF_W)); y1 = Math.max(y1, d.y + (d.h || DIAG_DEF_H));
        }
        if (!isFinite(x0)) return { dataURL: cv.toDataURL('image/png'), w: cv.width, h: cv.height };
        const pad = 100; // generous padding for dim labels (OFFSET=20 + label=27 + safety)
        const cx  = Math.max(0, Math.floor(x0 - pad));
        const cy  = Math.max(0, Math.floor(y0 - pad));
        const cx2 = Math.min(cv.width,  Math.ceil(x1 + pad));
        const cy2 = Math.min(cv.height, Math.ceil(y1 + pad));
        const cw = cx2 - cx, ch = cy2 - cy;
        const tmp = document.createElement('canvas');
        tmp.width = cw; tmp.height = ch;
        tmp.getContext('2d').drawImage(cv, cx, cy, cw, ch, 0, 0, cw, ch);
        return { dataURL: tmp.toDataURL('image/png'), w: cw, h: ch };
    }

    // Clear selection state for clean PDF render
    const _pSavedSel = selected, _pSavedDiag = selectedDiag, _pSavedText = selectedText;
    const _pSavedJoint = selectedJoint, _pSavedHovC = hovCorner, _pSavedHovE = hovEdge;
    selected = null; selectedDiag = null; selectedText = null; selectedJoint = null;
    hovCorner = null; hovEdge = null;

    // Collect per-page pricing for the final summary
    const pageOptionsByPage = []; // array of po objects

    // Project-level fees (install + measurements + polissage) are allocated into
    // each page proportionally by sqft so they appear up-front in the room breakdown.
    const projectFees    = calcProjectFees();
    const projectTotSqft = pages.reduce((s, p) => s + calcPageSqft(p), 0);
    function feeShareForPage(roomSqft) {
        if (projectTotSqft <= 0 || roomSqft <= 0) return { install: 0, meas: 0, pol: 0, total: 0 };
        const r = roomSqft / projectTotSqft;
        const install = projectFees.installCost * r;
        const meas    = projectFees.measCost    * r;
        const pol     = projectFees.polCost     * r;
        return { install, meas, pol, total: install + meas + pol };
    }

    for (let pi=0; pi<pages.length; pi++) {
        const page = pages[pi];
        currentPageIdx = pi; syncPageIn(); render();

        const { dataURL: imgData, w: natW, h: natH } = croppedCanvasData(page);
        const po = calcPageOptions(page);
        // Allocate project-level fees into this page and roll them into every subtotal
        const feeShare = feeShareForPage(po.roomSqft);
        po.feeShare   = feeShare;
        po.servicesCost += feeShare.total;
        for (const opt of po.options) opt.optionSubtotal += feeShare.total;
        pageOptionsByPage.push(po);
        const { roomSqft, edgeFootage, sinks, options } = po;
        const contentH = panelContentH(po);

        const IMG_ZONE_W = CW - PANEL_W - 10;
        const MAX_IMG_H  = 200;
        const scale = Math.min(IMG_ZONE_W / natW, MAX_IMG_H / natH);
        const imgW = natW * scale, imgH = natH * scale;
        const panelH = Math.max(imgH, contentH);
        const totalBlockH = 24 + panelH + 20;
        if (y + totalBlockH > PH - FOOTER_H - 10) newPdfPage();

        // Section header
        doc.setFont('helvetica','bold'); doc.setFontSize(9.5); doc.setTextColor(...BRAND);
        doc.text(`DISPOSITION — ${page.name.toUpperCase()}`, ML, y);
        doc.setFont('helvetica','italic'); doc.setFontSize(7); doc.setTextColor(120,100,50);
        doc.text('Layout', ML, y + 8);
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.75);
        doc.line(ML, y + 11, PW-MR, y + 11);
        y += 20;

        // Image
        const imgX = ML + Math.floor((IMG_ZONE_W - imgW) / 2);
        const imgY = y + Math.floor((panelH - imgH) / 2);
        doc.addImage(imgData, 'PNG', imgX, imgY, imgW, imgH);

        // Panel
        const px = ML + IMG_ZONE_W + 10, pw = PANEL_W;
        doc.setFillColor(...TBL_BG);
        doc.rect(px, y, pw, panelH, 'F');
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.5);
        doc.rect(px, y, pw, panelH, 'S');

        let py2 = y + 12;

        // Room name header
        doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...BRAND);
        doc.text(page.name.toUpperCase() + (options.length > 1 ? ` · ${options.length} OPTIONS` : ''), px + pw/2, py2, {align:'center'});
        py2 += 5;
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.4);
        doc.line(px+5, py2, px+pw-5, py2); py2 += 9;

        // ── Square footage ──
        doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(80,68,30);
        doc.text('Superficie / Area :', px+5, py2);
        doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...BODY_T);
        doc.text(`${roomSqft.toFixed(2)} pi² / ft²`, px+pw-5, py2, {align:'right'});
        py2 += 10;

        // ── Edge footage by profile (shared across options) ──
        const edgeTypes = Object.keys(edgeFootage);
        if (edgeTypes.length > 0) {
            doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...BRAND);
            doc.text('PROFILS — PIEDS LINÉAIRES', px+5, py2);
            py2 += 8;
            for (const etype of edgeTypes) {
                const def = EDGE_DEFS[etype];
                if (!def) continue;
                const lf = edgeFootage[etype].toFixed(2);
                const [er,eg,eb] = hexToRgb(def.color);
                doc.setFillColor(er,eg,eb);
                doc.roundedRect(px+5, py2-5, 14, 7, 1, 1, 'F');
                doc.setFont('helvetica','bold'); doc.setFontSize(5.5); doc.setTextColor(255,255,255);
                doc.text(def.abbr, px+12, py2, {align:'center'});
                doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.setTextColor(60,50,20);
                doc.text(def.label, px+22, py2);
                doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...BODY_T);
                doc.text(`${lf} pi`, px+pw-5, py2, {align:'right'});
                py2 += 9;
            }
            doc.setDrawColor(200,185,140); doc.setLineWidth(0.3);
            doc.line(px+5, py2, px+pw-5, py2); py2 += 7;
        }

        // ── Sink / cooktop services (shared across options) ──
        // Installation / measurements / polissage are NOT itemized here — they are
        // rolled silently into each option's pre-tax subtotal (see po.servicesCost
        // += feeShare.total above). The subtotal label calls this out so the
        // client knows install + measurements are already included.
        const serviceRows = [];
        if (sinks.overmount  > 0) serviceRows.push(['Évier overmount',  sinks.overmount]);
        if (sinks.undermount > 0) serviceRows.push(['Évier undermount', sinks.undermount]);
        if (sinks.vasque     > 0) serviceRows.push(['Évier vasque',     sinks.vasque]);
        if (sinks.cooktops   > 0) serviceRows.push(['Cooktop',          sinks.cooktops]);
        if (sinks.farmSinks  > 0) serviceRows.push(['Farmhouse sink',   sinks.farmSinks]);
        if (sinks.outlets    > 0) serviceRows.push(['Outlet',           sinks.outlets]);
        if (sinks.boccis     > 0) serviceRows.push(['Bocci outlet',     sinks.boccis]);
        if (serviceRows.length > 0) {
            doc.setFont('helvetica','bold'); doc.setFontSize(6.5); doc.setTextColor(...BRAND);
            doc.text('SERVICES', px+5, py2);
            py2 += 8;
            for (const [k, q] of serviceRows) {
                doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(60,50,20);
                doc.text(k, px+5, py2);
                doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...BODY_T);
                doc.text(`× ${q}`, px+pw-5, py2, {align:'right'});
                py2 += 9;
            }
            doc.setDrawColor(200,185,140); doc.setLineWidth(0.3);
            doc.line(px+5, py2, px+pw-5, py2); py2 += 7;
        }

        // ── Per-option price blocks ──
        // Note: po.servicesCost and opt.optionSubtotal already include each page's
        // sqft-proportional share of install / measurements / polissage.
        const hasFees = (po.feeShare && po.feeShare.total > 0);
        if (options.length === 0) {
            if (po.servicesCost > 0) {
                doc.setFillColor(...ACCENT);
                doc.rect(px+3, py2, pw-6, 20, 'F');
                doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...BRAND);
                doc.text('SOUS-TOTAL', px+7, py2+9);
                doc.setFont('helvetica','italic'); doc.setFontSize(5.5); doc.setTextColor(...BRAND);
                doc.text(hasFees ? 'incl. install + mesures' : 'services only', px+7, py2+16);
                doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BRAND);
                doc.text(fmt$(po.servicesCost), px+pw-7, py2+14, {align:'right'});
                py2 += 26;
            }
        } else {
            options.forEach((opt, i) => {
                if (options.length > 1) {
                    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...BRAND);
                    doc.text(`OPTION ${i+1}`, px+5, py2);
                    py2 += 9;
                }
                // Material name
                doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...BODY_T);
                doc.text(doc.splitTextToSize(opt.material.color || 'Matériau', pw-10)[0], px+5, py2);
                py2 += 10;
                const matDet = [opt.material.supplier, opt.material.thickness, opt.material.finish].filter(Boolean).join(' • ');
                if (matDet) {
                    doc.setFont('helvetica','normal'); doc.setFontSize(6.5); doc.setTextColor(100,85,40);
                    doc.text(doc.splitTextToSize(matDet, pw-10)[0], px+5, py2);
                    py2 += 8;
                }
                // Matériel + découpe
                doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(60,50,20);
                doc.text('Matériel + découpe', px+5, py2);
                doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...BODY_T);
                doc.text(fmt$(opt.matCost + opt.cutCost), px+pw-5, py2, {align:'right'});
                py2 += 10;
                // Services (sinks + allocated install/measurements/polissage)
                if (po.servicesCost > 0) {
                    doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(60,50,20);
                    doc.text('Services', px+5, py2);
                    doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...BODY_T);
                    doc.text(fmt$(po.servicesCost), px+pw-5, py2, {align:'right'});
                    py2 += 10;
                }
                // Subtotal box
                doc.setFillColor(...ACCENT);
                doc.rect(px+3, py2, pw-6, 20, 'F');
                doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(...BRAND);
                doc.text(options.length > 1 ? `OPT ${i+1} SOUS-TOTAL` : 'SOUS-TOTAL', px+7, py2+9);
                doc.setFont('helvetica','italic'); doc.setFontSize(5.5); doc.setTextColor(...BRAND);
                doc.text(hasFees ? 'pre-tax · incl. install + mesures' : 'subtotal (before tax)', px+7, py2+16);
                doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BRAND);
                doc.text(fmt$(opt.optionSubtotal), px+pw-7, py2+14, {align:'right'});
                py2 += 26;
                if (i < options.length - 1) py2 += 6;
            });
        }

        y += panelH + 16;
    }
    dimSizeMultiplier = 1; // reset
    currentPageIdx = savedIdx;
    selected = _pSavedSel; selectedDiag = _pSavedDiag; selectedText = _pSavedText;
    selectedJoint = _pSavedJoint; hovCorner = _pSavedHovC; hovEdge = _pSavedHovE;
    syncPageIn(); render();

    // ── PROJECT SUMMARY / COMBINATIONS ──
    // Skipped when whole-project Options exist (those get their own section below).
    const __preOptsum = calcOptionsSummary();
    const hasWholeProjectOptions = __preOptsum.options.length > 0;
    const pagesWithShapes = pageOptionsByPage.filter(po => po.roomSqft > 0);
    const anyMulti = pagesWithShapes.some(po => po.options.length > 1);

    if (!hasWholeProjectOptions && pagesWithShapes.length > 0) {
        const TAX = 1.14975;

        // Force summary onto a clean page so it always reads as the conclusion
        newPdfPage();
        y = 90;
        sectionHead(anyMulti ? 'SOMMAIRE — COMBINAISONS POSSIBLES / POSSIBLE COMBINATIONS' : 'SOMMAIRE DU PROJET / PROJECT SUMMARY');

        // Build cross-product of per-page options
        let combos = [[]];
        for (const po of pagesWithShapes) {
            const n = Math.max(1, po.options.length);
            const nc = [];
            for (const c of combos) {
                for (let i = 0; i < n; i++) {
                    nc.push([...c, { po, optionIdx: po.options.length > 0 ? i : -1 }]);
                }
            }
            combos = nc;
        }

        if (anyMulti) {
            doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120,100,50);
            doc.text(`${combos.length} combination${combos.length>1?'s':''} — one per possible client selection`, ML, y, {maxWidth: CW});
            y += 14;
        }

        // Render each combination as a bordered card
        combos.forEach((combo, ci) => {
            const cardH = 30 + combo.length * 12 + 28; // header + rows + total (fees are baked into page subtotals)
            if (y + cardH > PH - FOOTER_H - 10) newPdfPage();
            const cy = y;

            // Card background
            doc.setFillColor(252, 250, 243);
            doc.setDrawColor(...ACCENT); doc.setLineWidth(0.7);
            doc.roundedRect(ML, cy, CW, cardH, 4, 4, 'FD');

            // Header bar
            doc.setFillColor(...BRAND);
            doc.rect(ML, cy, CW, 18, 'F');
            doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(255,255,255);
            doc.text(anyMulti ? `COMBINAISON ${ci+1} / COMBINATION ${ci+1}` : 'SOMMAIRE / SUMMARY', ML + 10, cy + 12);

            // Combo rows — each page subtotal already includes its share of
            // install / measurements / polissage (allocated by sqft).
            let ry = cy + 30;
            let matSum = 0;
            for (const pick of combo) {
                const po2 = pick.po;
                const opt = pick.optionIdx >= 0 ? po2.options[pick.optionIdx] : null;
                const subtotal = opt ? opt.optionSubtotal : po2.servicesCost;
                matSum += subtotal;
                const pageLabel = po2.options.length > 1
                    ? `${po2.page.name} — Option ${pick.optionIdx+1}`
                    : po2.page.name;
                const matName = opt ? (opt.material.color || 'Matériau') : '(services only)';
                doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...BODY_T);
                doc.text(pageLabel, ML + 10, ry);
                doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120,100,50);
                doc.text(matName, ML + 140, ry);
                doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...BODY_T);
                doc.text(fmt$(subtotal), ML + CW - 10, ry, {align:'right'});
                ry += 12;
            }

            // Pre-tax totals line
            const preT = matSum;
            const withTax = preT * TAX;
            ry += 2;
            doc.setDrawColor(...ACCENT); doc.setLineWidth(0.4);
            doc.line(ML + 10, ry, ML + CW - 10, ry);
            ry += 6;
            doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...BODY_T);
            doc.text(`Avant taxes: ${fmt$(preT)}`, ML + CW - 10, ry, {align:'right'});
            ry += 10;

            // Total (highlighted)
            doc.setFillColor(...ACCENT);
            doc.rect(ML + 3, ry, CW - 6, 18, 'F');
            doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(...BRAND);
            doc.text(anyMulti ? `TOTAL COMBO ${ci+1}` : 'GRAND TOTAL', ML + 10, ry + 12);
            doc.setFont('helvetica','italic'); doc.setFontSize(7); doc.setTextColor(...BRAND);
            doc.text('taxes incluses / with taxes', ML + 110, ry + 12);
            doc.setFont('helvetica','bold'); doc.setFontSize(12); doc.setTextColor(...BRAND);
            doc.text(fmt$(withTax), ML + CW - 10, ry + 13, {align:'right'});
            ry += 22;

            y = cy + cardH + 10;
        });
    }

    // ── OPTIONS SUMMARY — client selects one (forced to its own final page) ──
    // Row-based layout: scales cleanly up to 5 options on a single page.
    const optsum = calcOptionsSummary();
    if (optsum.options.length > 0) {
        newPdfPage();
        y = 90;
        sectionHead('CLIENT OPTIONS — PLEASE SELECT ONE');
        doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BODY_T);
        doc.text('Chaque option couvre l\'entièreté du projet.', ML, y, {maxWidth: CW});
        y += 12;
        doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120,100,50);
        doc.text('Each option covers the entire project — please select one.', ML, y, {maxWidth: CW});
        y += 20;

        // Project summary line (shared across every option)
        doc.setFillColor(...TBL_BG); doc.rect(ML, y, CW, 18, 'F');
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.4); doc.rect(ML, y, CW, 18, 'S');
        doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(...BRAND);
        doc.text(`Superficie totale / Total area:  ${optsum.totalSqft.toFixed(2)} pi² / ft²`, ML+8, y+12);
        y += 26;

        const rowH   = 62;
        const labelW = 64;
        const totalW = 136;
        const midX   = ML + labelW + 8;
        const midW   = CW - labelW - totalW - 12;
        const tx     = ML + CW - totalW;

        for (let i = 0; i < optsum.options.length; i++) {
            const op = optsum.options[i];
            // Page break guard
            if (y + rowH > PH - FOOTER_H - 40) { newPdfPage(); y = 90; }

            const cy = y;
            // Row background + border
            doc.setFillColor(252, 250, 243);
            doc.setDrawColor(...ACCENT); doc.setLineWidth(0.7);
            doc.roundedRect(ML, cy, CW, rowH, 4, 4, 'FD');

            // Left — option label column (brand color bar)
            doc.setFillColor(...BRAND);
            doc.roundedRect(ML, cy, labelW, rowH, 4, 4, 'F');
            // Square off the right edge so it blends with the rest of the row
            doc.rect(ML + labelW - 4, cy, 4, rowH, 'F');
            doc.setFont('helvetica','bold'); doc.setFontSize(11); doc.setTextColor(255,255,255);
            doc.text(op.label, ML + labelW/2, cy + rowH/2 + 3, { align: 'center' });

            // Middle — material info + breakdown
            doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BODY_T);
            doc.text(doc.splitTextToSize(op.color || 'Matériau', midW)[0], midX, cy + 14);
            const det = [op.supplier, op.thickness, op.finish].filter(Boolean).join(' • ');
            if (det) {
                doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(100,85,40);
                doc.text(doc.splitTextToSize(det, midW)[0], midX, cy + 25);
            }
            // Breakdown lines
            doc.setFont('helvetica','normal'); doc.setFontSize(7.5); doc.setTextColor(80,68,30);
            const bd1 = `Slabs: ${op.slabQty} × ${fmt$(op.pricePerSlab)} = ${fmt$(op.slabCost)}   ·   ${op.isDekton ? 'Dekton cut' : 'Découpe'}: ${fmt$(op.cuttingCost)}`;
            doc.text(doc.splitTextToSize(bd1, midW)[0], midX, cy + 39);
            let bd2 = `Services: ${fmt$(op.sharedServices)}`;
            if (op.sharedCommittedMat > 0) bd2 += `   ·   Matériaux fixes: ${fmt$(op.sharedCommittedMat)}`;
            doc.text(doc.splitTextToSize(bd2, midW)[0], midX, cy + 51);

            // Right — totals column (accent background)
            doc.setFillColor(...ACCENT);
            doc.rect(tx, cy, totalW, rowH, 'F');
            // Rounded right edge to match card
            doc.setFillColor(...ACCENT);
            doc.roundedRect(tx + totalW - 4, cy, 4, rowH, 4, 4, 'F');
            doc.setFont('helvetica','normal'); doc.setFontSize(7); doc.setTextColor(...BRAND);
            doc.text('Avant taxes / Before tax', tx + 8, cy + 14);
            doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(...BRAND);
            doc.text(fmt$(op.preT), tx + totalW - 8, cy + 26, { align: 'right' });
            // Dividing line
            doc.setDrawColor(...BRAND); doc.setLineWidth(0.4);
            doc.line(tx + 8, cy + 33, tx + totalW - 8, cy + 33);
            doc.setFont('helvetica','bold'); doc.setFontSize(7.5); doc.setTextColor(...BRAND);
            doc.text('TOTAL — taxes incluses', tx + 8, cy + 44);
            doc.setFont('helvetica','bold'); doc.setFontSize(14); doc.setTextColor(...BRAND);
            doc.text(fmt$(op.total), tx + totalW - 8, cy + 58, { align: 'right' });

            y += rowH + 8;
        }

        y += 6;
        doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(120,100,50);
        const note = 'Veuillez choisir une option. / Please select one option — pricing reflects each scenario independently.';
        const noteLines = doc.splitTextToSize(note, CW);
        for (const ln of noteLines) { doc.text(ln, PW/2, y, { align: 'center' }); y += 11; }
    }

    // (Internal notes intentionally omitted from client-facing proposal)

    // Terms note
    checkY(20);
    y += 6;
    doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(80,68,30);
    doc.text('Tous les prix incluent les taxes TPS (5 %) et TVQ (9,975 %).', ML, y, {maxWidth:CW});
    y += 10;
    doc.setFont('helvetica','italic'); doc.setFontSize(7); doc.setTextColor(120,100,50);
    doc.text('All prices include GST (5%) and QST (9.975%).', ML, y, {maxWidth:CW});
    y += 12;

    const fname = `SI-${pdfBaseName()}_Proposal.pdf`;
    doc.save(fname);
}

document.getElementById('btn-gen-proposal').addEventListener('click', generateProposal);

// ─────────────────────────────────────────────────────────────
//  Phase 4 — Save / Load / New / Export PDF / Print
// ─────────────────────────────────────────────────────────────

function pdfBaseName() {
    const c = (formData.client || '').trim();
    if (c) return c.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '');
    const d = (formData.date || '').trim() || new Date().toISOString().slice(0, 10);
    return `Unnamed-Project-${d.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}
function quoteFilename(ext) {
    return `SI-${pdfBaseName()}.${ext}`;
}

// ── Save Quote ────────────────────────────────────────────────
async function saveQuote() {
    syncPageOut();
    const r = await saveQuoteToDb();
    regUpdateCurrentBanner();
    if (r && r.ok) {
        // saveQuoteToDb already shows the status toast; no modal alert needed.
        if (r.restored) alert('Quote row was missing — recreated under the same id. A backup copy is safe.');
    } else {
        // saveQuoteToDb already downloaded a JSON backup and showed an error toast.
        alert('Cloud save failed: ' + ((r && r.error) || 'unknown') + '\nA JSON backup was downloaded to keep your work safe.');
    }
}
function _downloadQuoteJson() {
    syncPageOut();
    const bundle = {
        version: 4,
        pages: pages.map(p => ({ id:p.id, name:p.name, shapes:p.shapes, textItems:p.textItems, nextId:p.nextId })),
        currentPageIdx,
        formData,
        pricingData,
        slabDefs,
        slabPlaced,
        _slabNextId
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = quoteFilename('json');
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Load Quote ────────────────────────────────────────────────
function loadQuote() {
    syncPageOut();
    const hasData = pages.some(p => p.shapes.length || p.textItems.length) || pages.length > 1
                 || formData.order || formData.job || formData.client;
    if (hasData && !confirm('Loading a file will replace all current canvas and form data. Continue?')) return;
    document.getElementById('load-file-input').click();
}

document.getElementById('load-file-input').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
        try {
            const bundle = JSON.parse(evt.target.result);
            pages = (bundle.pages || []).map(p => ({
                id: p.id || 1, name: p.name || 'Page 1',
                shapes: (p.shapes || []).map(normalizeShape),
                textItems: p.textItems || [], nextId: p.nextId || 1, _undo: []
            }));
            if (!pages.length) pages = [{ id:1, name:'Page 1', shapes:[], textItems:[], nextId:1, _undo:[] }];
            currentPageIdx = Math.max(0, Math.min(bundle.currentPageIdx || 0, pages.length - 1));
            _nextPageId = Math.max(...pages.map(p => p.id), 1) + 1;
            syncPageIn();
            if (bundle.formData) {
                formData = bundle.formData;
                matNextId = (formData.materials || []).reduce((mx, m) => Math.max(mx, m.id + 1), 1);
                document.getElementById('f-order').value  = formData.order  || '';
                document.getElementById('f-job').value    = formData.job    || '';
                document.getElementById('f-client').value = formData.client || '';
                document.getElementById('f-date').value   = formData.date   || todayStr();
                document.getElementById('f-notes').value  = formData.notes  || '';
                renderMaterials();
            }
            if (bundle.pricingData) {
                const pd = bundle.pricingData;
                // Migrate old format: if it has costItems/rooms but no rates, convert
                if (pd.rates) {
                    pricingData = pd;
                    if (!pricingData.materialPrices) pricingData.materialPrices = {};
                } else {
                    // Old format — fall back to the saved shop-global rates
                    pricingData = {
                        rates: getSavedRates(),
                        materialPrices: {},
                    };
                }
                savePricing();
            }
            // Restore slab layout + images
            if (bundle.slabDefs && bundle.slabDefs.length) {
                slabDefs = bundle.slabDefs;
                // Rebuild image cache for any slabs with bgImage
                slabBgImgEls = {};
                slabDefs.forEach((sd, i) => { if (sd.bgImage) _slabImgCacheEl(i); });
            }
            if (bundle.slabPlaced) slabPlaced = bundle.slabPlaced;
            if (bundle._slabNextId) _slabNextId = bundle._slabNextId;
            slabSelected = null; slabPickingPiece = null;
            selected = null; selectedJoint = null; selectedText = null;
            persist();
            renderPageTabs();
            if (document.querySelector('.tab-btn[data-tab="slab"]')?.classList.contains('active') ||
                document.getElementById('slabCanvas')) {
                slabRefreshSlabList(); slabRefreshPieceList(); slabRender();
            }
            render(); updateStatus();
        } catch (err) {
            alert('Could not load file — make sure it is a valid Spartan quote (.json) file.');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// ── New Quote ─────────────────────────────────────────────────
function newQuote() {
    if (!confirm('Start a new quote? All current canvas and form data will be cleared.')) return;
    console.log('[newQuote] resetting — was editing:', currentQuoteId);
    // CRITICAL: clear the quote-id pointer FIRST. Without this, the next
    // save would UPDATE the previous quote row instead of creating a new one
    // ("stacking"/"saves over the last one").
    currentQuoteId = null;
    localStorage.removeItem('spartan_currentQuoteId');
    pages = [{ id:1, name:'Page 1', shapes:[], textItems:[], nextId:1, _undo:[] }];
    currentPageIdx = 0; _nextPageId = 2;
    syncPageIn();
    formData = { order:'', job:'', client:'', date:todayStr(), notes:'', materials:[] };
    matNextId = 1;
    document.getElementById('f-order').value  = '';
    document.getElementById('f-job').value    = '';
    document.getElementById('f-client').value = '';
    document.getElementById('f-date').value   = formData.date;
    document.getElementById('f-notes').value  = '';
    renderMaterials();
    pricingData = {
        // Carry over the shop-global rates so a new quote starts with the
        // user's last-edited rates, not zeros.
        rates: getSavedRates(),
        materialPrices: {},
    };
    pricingNextId = 1;
    // Note: RATES_KEY is intentionally NOT cleared here — it's the
    // shop-global default that should survive new quotes.
    ['spartan_v4','spartan_v3','spartan_v2', FORM_KEY, PRICING_KEY].forEach(k => localStorage.removeItem(k));
    // Also clear remote data for this user
    if (currentUserId) {
        _sb.from('user_data').delete().eq('clerk_user_id', currentUserId).then(() => {});
    }
    selected = null; selectedJoint = null; selectedText = null;
    renderPageTabs();
    render(); updateStatus();
    regUpdateCurrentBanner();
    console.log('[newQuote] done — currentQuoteId:', currentQuoteId);
}

// ── Export PDF ────────────────────────────────────────────────
function hexToRgb(hex) {
    return [parseInt(hex.slice(1,3),16), parseInt(hex.slice(3,5),16), parseInt(hex.slice(5,7),16)];
}

function exportPDF() {
    const jsPDFLib = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFLib) { alert('jsPDF library not loaded. Check your internet connection and try again.'); return; }

    // Flush active page to pages[] before reading
    syncPageOut();

    const doc      = new jsPDFLib({ unit:'pt', format:'letter' });
    const PW = 612, PH = 792, ML = 45, MR = 45;
    const CW       = PW - ML - MR;
    const FOOTER_H = 54;
    // ── Brand palette (RGB) ──
    const BRAND  = [45, 58, 16];   // #2d3a10 — Spartan army olive
    const ACCENT = [176, 144, 48];   // #b09030 — warm khaki/gold
    const TBL_BG = [240, 237, 216];  // warm parchment table rows
    const BODY_T = [38,  32,  12];   // warm near-black body text

    let y = 84; // below header (logo height + padding)

    function newPdfPage() {
        doc.addPage();
        y = 32;
        addPageFooter();
    }
    function checkY(needed) {
        if (y + needed > PH - FOOTER_H - 10) newPdfPage();
    }
    function sectionHead(title) {
        checkY(28);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(...BRAND);
        doc.text(title, ML, y);
        doc.setDrawColor(...ACCENT);
        doc.setLineWidth(0.75);
        doc.line(ML, y + 3, PW - MR, y + 3);
        y += 15;
    }
    function addPageFooter() {
        // thin brand-green rule
        doc.setDrawColor(...BRAND);
        doc.setLineWidth(0.6);
        doc.line(ML, PH - FOOTER_H, PW - MR, PH - FOOTER_H);
        // subtle tinted background
        doc.setFillColor(245, 244, 240);
        doc.rect(0, PH - FOOTER_H + 1, PW, FOOTER_H, 'F');
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 120);
        doc.text('This quote is valid for 30 days. All measurements are approximate and subject to final field verification.', PW / 2, PH - 34, { align:'center' });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...BRAND);
        doc.text('SPARTAN', PW / 2, PH - 19, { align:'center' });
    }

    // ── Header banner (army olive) ────────────────────────────
    doc.setFillColor(...BRAND);
    doc.rect(0, 0, PW, 70, 'F');
    // khaki accent stripe at bottom
    doc.setFillColor(...ACCENT);
    doc.rect(0, 68, PW, 2.5, 'F');
    // Logo image (left side)
    // Company name + tagline (offset right of logo)
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(17);
    doc.setTextColor(255, 255, 255);
    doc.text('SPARTAN', ML + 58, 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...ACCENT);
    doc.text('Countertop Quote', ML + 58, 48);
    // right side — order & date
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(255, 255, 255);
    doc.text(`Quote #: ${formData.order || '—'}`, PW - MR, 30, { align:'right' });
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...ACCENT);
    doc.text(`Date: ${formData.date || todayStr()}`, PW - MR, 48, { align:'right' });

    addPageFooter();

    // ── Job Details ──────────────────────────────────────────
    sectionHead('JOB DETAILS');
    const fields = [['Sales Rep', formData.job], ['Client', formData.client], ['Order #', formData.order], ['Date', formData.date]];
    for (const [lbl, val] of fields) {
        checkY(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(80, 68, 30);
        doc.text(lbl.toUpperCase(), ML, y);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...BODY_T);
        doc.text(val || '—', ML + 78, y);
        y += 14;
    }

    // ── Materials (shown once) ────────────────────────────────
    if (formData.materials && formData.materials.length) {
        y += 6; sectionHead('MATERIALS');
        doc.setFillColor(...TBL_BG);
        doc.rect(ML, y - 9, CW, 13, 'F');
        doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...BRAND);
        const mc = [ML+3, ML+85, ML+210, ML+290, ML+370];
        ['TYPE / LABEL', 'COLOR / MATERIAL', 'SUPPLIER', 'THICKNESS', 'FINISH'].forEach((h, i) => doc.text(h, mc[i], y - 1));
        y += 6;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...BODY_T);
        for (const m of formData.materials) {
            checkY(13);
            const t = m.type || 'page';
            const tLabel = t === 'option'
                ? (m.label || `Option ${getOptionLetter(m)}`)
                : `Page: ${m.label||'—'}`;
            [tLabel, m.color||'—', m.supplier||'—', m.thickness||'—', m.finish||'—'].forEach((v, i) => doc.text(v, mc[i], y));
            y += 13;
        }
    }

    // ── Per-page drawings (all pages) ────────────────────────
    const savedIdx = currentPageIdx;
    const savedSel = selected;
    const savedSelDiag = selectedDiag;
    const savedSelText = selectedText;
    const savedSelJoint = selectedJoint;
    const savedHovCorner = hovCorner;
    const savedHovEdge = hovEdge;
    selected = null; selectedDiag = null; selectedText = null; selectedJoint = null;
    hovCorner = null; hovEdge = null;

    // Pre-scan ALL pages for edge types so we can render the legend on
    // page 1 alongside Tab 1 (per the desired layout).
    const usedTypes = new Set();
    let hasInternalJoint = false;
    for (const p of pages) {
        for (const s of p.shapes) {
            if (s.edges) for (const side of Object.values(s.edges)) { if (side?.type && side.type !== 'none') usedTypes.add(side.type); }
            if (s.cornerEdges) for (const ce of Object.values(s.cornerEdges)) { if (ce?.type && ce.type !== 'none') usedTypes.add(ce.type); }
            if (s.chamferEdges) for (const ce of Object.values(s.chamferEdges)) { if (ce?.type && ce.type !== 'none') usedTypes.add(ce.type); }
            if (s.joints?.length) hasInternalJoint = true;
        }
    }

    for (let pi = 0; pi < pages.length; pi++) {
        const page = pages[pi];
        currentPageIdx = pi;
        syncPageIn();
        render();
        // Tab 1 stays on PDF page 1 alongside Job Details + Materials and
        // (below) the Edge Profile Legend. Tabs 2+ each get their own PDF
        // page with a bigger layout image.
        if (pi > 0) newPdfPage();
        sectionHead(`DESSIN / DRAWING — ${page.name.toUpperCase()}`);
        const imgData = cv.toDataURL('image/png');
        const maxH    = pi === 0 ? 607 : 747; // tab 1 a bit smaller to share page 1
        const scale   = Math.min(CW / cv.width, maxH / cv.height);
        const imgW    = cv.width * scale, imgH = cv.height * scale;
        // Center the layout image horizontally.
        doc.addImage(imgData, 'PNG', ML + (CW - imgW) / 2, y, imgW, imgH);
        y += imgH + 12;

        // ── Per-page metrics: sqft + linear footage ──────────
        const pageSqft    = calcPageSqft(page);
        const pageEdge    = calcPageEdgeFootage(page);
        const edgeEntries = Object.entries(pageEdge).filter(([t]) => t !== 'joint');

        // Background box
        const metricsH = 16 + (edgeEntries.length > 0 ? 12 + edgeEntries.length * 11 : 0) + 6;
        checkY(metricsH);
        doc.setFillColor(...TBL_BG);
        doc.rect(ML, y, CW, metricsH, 'F');
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.4);
        doc.rect(ML, y, CW, metricsH, 'S');

        let mx2 = y + 11;

        // Sqft row
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...BRAND);
        doc.text('SUPERFICIE / AREA :', ML + 6, mx2);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...BODY_T);
        doc.text(`${pageSqft.toFixed(3)} pi²  /  ft²`, PW - MR - 6, mx2, { align:'right' });
        mx2 += 5;

        if (edgeEntries.length > 0) {
            doc.setDrawColor(200, 185, 140); doc.setLineWidth(0.3);
            doc.line(ML + 6, mx2, PW - MR - 6, mx2);
            mx2 += 9;

            // Column headers
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...BRAND);
            doc.text('PIEDS LINÉAIRES PAR PROFIL  /  LINEAR FEET BY EDGE PROFILE', ML + 6, mx2);
            mx2 += 10;

            const colX = [ML+6, ML+30, ML+160, PW-MR-6];
            doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5); doc.setTextColor(100, 85, 40);
            doc.text('',          colX[0], mx2);
            doc.text('PROFIL',    colX[1], mx2);
            doc.text('NOM / NAME',colX[2], mx2);
            doc.text('pi / ft',   colX[3], mx2, { align:'right' });
            mx2 += 2;
            doc.setDrawColor(180,165,120); doc.setLineWidth(0.2);
            doc.line(ML+6, mx2, PW-MR-6, mx2);
            mx2 += 8;

            for (const [etype, lf] of edgeEntries) {
                const def = EDGE_DEFS[etype];
                if (!def) continue;
                const [er, eg, eb] = hexToRgb(def.color);
                // coloured pill
                doc.setFillColor(er, eg, eb);
                doc.roundedRect(colX[0], mx2 - 5.5, 18, 7, 1, 1, 'F');
                doc.setFont('helvetica', 'bold'); doc.setFontSize(5.5); doc.setTextColor(255,255,255);
                doc.text(def.abbr, colX[0] + 9, mx2, { align:'center' });
                // label
                doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...BODY_T);
                doc.text(def.abbr,   colX[1], mx2);
                doc.text(def.label,  colX[2], mx2);
                doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
                doc.text(`${lf.toFixed(2)}`, colX[3], mx2, { align:'right' });
                mx2 += 11;
            }
        }

        y += metricsH + 10;

        // ── Cutouts: sinks, farmsink, cooktop, outlets, boccis, polish-under ─
        const cutCounts = calcPageSinkCounts(page);
        let pagePolishSqft = 0;
        for (const s of page.shapes) {
            if (s.subtype) continue;
            for (const r of (s.polishUnders || [])) {
                pagePolishSqft += (r.w * r.h) / SQFT_PX2;
            }
        }
        const cutRows = [];
        if (cutCounts.overmount  > 0) cutRows.push(['Évier overmount',  `× ${cutCounts.overmount}`]);
        if (cutCounts.undermount > 0) cutRows.push(['Évier undermount', `× ${cutCounts.undermount}`]);
        if (cutCounts.vasque     > 0) cutRows.push(['Évier vasque',     `× ${cutCounts.vasque}`]);
        if (cutCounts.farmSinks  > 0) cutRows.push(['Farmhouse sink',   `× ${cutCounts.farmSinks}`]);
        if (cutCounts.cooktops   > 0) cutRows.push(['Cooktop',          `× ${cutCounts.cooktops}`]);
        if (cutCounts.outlets    > 0) cutRows.push(['Outlet',           `× ${cutCounts.outlets}`]);
        if (cutCounts.boccis     > 0) cutRows.push(['Bocci outlet',     `× ${cutCounts.boccis}`]);
        if (pagePolishSqft > 0)      cutRows.push(['Polissage sous',   `${pagePolishSqft.toFixed(2)} sqft`]);
        if (cutRows.length > 0) {
            const cutH = 16 + cutRows.length * 11 + 6;
            checkY(cutH);
            doc.setFillColor(...TBL_BG);
            doc.rect(ML, y, CW, cutH, 'F');
            doc.setDrawColor(...ACCENT); doc.setLineWidth(0.4);
            doc.rect(ML, y, CW, cutH, 'S');
            let cy = y + 11;
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(...BRAND);
            doc.text('DÉCOUPES / CUTOUTS', ML + 6, cy);
            cy += 9;
            for (const [k, vText] of cutRows) {
                doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...BODY_T);
                doc.text(k, ML + 12, cy);
                doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
                doc.text(vText, PW - MR - 6, cy, { align:'right' });
                cy += 11;
            }
            y += cutH + 8;
        }

        // Render the Edge Profile Legend right after Tab 1's metrics so it
        // sits on PDF page 1 with Job Details / Materials / Tab 1 drawing.
        if (pi === 0 && (usedTypes.size || hasInternalJoint)) {
            y += 4; sectionHead('EDGE PROFILE LEGEND');
            const typeOrder = ['pencil','ogee','bullnose','halfbull','bevel','mitered','special','joint','waterfall'];
            for (const type of typeOrder) {
                if (!usedTypes.has(type)) continue;
                const def = EDGE_DEFS[type];
                const [r, g, b] = hexToRgb(def.color);
                checkY(12);
                doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(r, g, b);
                doc.text(def.abbr, ML + 3, y);
                doc.setFont('helvetica', 'normal'); doc.setTextColor(...BODY_T);
                doc.text(def.label, ML + 30, y);
                y += 12;
            }
            if (hasInternalJoint) {
                checkY(12);
                doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(224, 69, 123);
                doc.text('JT', ML + 3, y);
                doc.setFont('helvetica', 'normal'); doc.setTextColor(...BODY_T);
                doc.text('Interior Joint Line', ML + 30, y);
                y += 12;
            }
        }
    }
    // Restore original page + selection state
    currentPageIdx = savedIdx;
    selected = savedSel; selectedDiag = savedSelDiag; selectedText = savedSelText;
    selectedJoint = savedSelJoint; hovCorner = savedHovCorner; hovEdge = savedHovEdge;
    syncPageIn();
    render();

    // ── Notes ────────────────────────────────────────────────
    if (formData.notes && formData.notes.trim()) {
        y += 6; sectionHead('NOTES / SPECIAL INSTRUCTIONS');
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...BODY_T);
        const lines = doc.splitTextToSize(formData.notes, CW);
        for (const line of lines) {
            checkY(13);
            doc.text(line, ML, y);
            y += 13;
        }
    }

    doc.save(quoteFilename('pdf'));
}

// ── Print ─────────────────────────────────────────────────────

// ── Wire buttons ──────────────────────────────────────────────
document.getElementById('btn-save-quote').addEventListener('click', saveQuote);
document.getElementById('btn-save-desktop').addEventListener('click', () => {
    try { _downloadQuoteJson(); }
    catch (e) { alert('Failed to save file: ' + (e.message || e)); }
});
document.getElementById('btn-load-quote').addEventListener('click', loadQuote);
document.getElementById('btn-new-quote').addEventListener('click', newQuote);
document.getElementById('btn-export-pdf').addEventListener('click', exportPDF);

// ─────────────────────────────────────────────────────────────
//  Layout PDF Export
// ─────────────────────────────────────────────────────────────
async function exportLayoutPDF() {
    const jsPDFLib = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFLib) { alert('jsPDF library not loaded. Check your internet connection and try again.'); return; }

    // Honour the "Restes dans PDF" toggle: skip remnants in render output if off.
    _slabSkipRemnantsInRender = !slabIncludeRemnantsInPdf;
    // Print-friendly capture: re-render with WHITE background.
    slabRender('#ffffff');

    const doc    = new jsPDFLib({ unit:'pt', format:'letter' });
    const PW = 612, PH = 792, ML = 45, MR = 45;
    const CW     = PW - ML - MR;
    const FOOTER_H = 54;
    const BRAND  = [45, 58, 16];
    const ACCENT = [176, 144, 48];
    const TBL_BG = [240, 237, 216];
    const BODY_T = [38,  32,  12];

    let y = 84;

    function addHeader(subtitle) {
        // Print-friendly header: white background, dark text. No filled
        // header bar and no logo so B&W printers don't waste a lot of
        // toner on a solid black block.
        doc.setDrawColor(...BRAND);
        doc.setLineWidth(1.2);
        doc.line(ML, 60, PW - MR, 60);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(18);
        doc.setTextColor(...BRAND);
        doc.text('SPARTAN', ML, 32);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(80, 80, 80);
        doc.text(subtitle || 'Layout Overview', ML, 50);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(...BRAND);
        doc.text(`Quote #: ${formData.order || '—'}`, PW - MR, 32, { align:'right' });
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(80, 80, 80);
        doc.text(`Date: ${formData.date || todayStr()}`, PW - MR, 50, { align:'right' });
    }

    function addPageFooter() {
        doc.setDrawColor(...BRAND);
        doc.setLineWidth(0.6);
        doc.line(ML, PH - FOOTER_H, PW - MR, PH - FOOTER_H);
        doc.setFillColor(245, 244, 240);
        doc.rect(0, PH - FOOTER_H + 1, PW, FOOTER_H, 'F');
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.5);
        doc.setTextColor(120, 120, 120);
        doc.text('This layout is for planning purposes only. All measurements are approximate and subject to final field verification.', PW / 2, PH - 34, { align:'center' });
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...BRAND);
        doc.text('SPARTAN', PW / 2, PH - 19, { align:'center' });
    }

    function newPage(subtitle) {
        doc.addPage();
        y = 84;
        addHeader(subtitle);
        addPageFooter();
    }

    function checkY(needed) {
        if (y + needed > PH - FOOTER_H - 10) { newPage(); }
    }

    function sectionHead(title) {
        checkY(28);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9.5);
        doc.setTextColor(...BRAND);
        doc.text(title, ML, y);
        doc.setDrawColor(...ACCENT);
        doc.setLineWidth(0.75);
        doc.line(ML, y + 3, PW - MR, y + 3);
        y += 15;
    }

    // ── Page 1: Header + job details + overview canvas ───────
    addHeader('Layout Overview');
    addPageFooter();

    sectionHead('JOB DETAILS');
    const fields = [['Sales Rep', formData.job], ['Client', formData.client], ['Order #', formData.order], ['Date', formData.date]];
    for (const [lbl, val] of fields) {
        checkY(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(80, 68, 30);
        doc.text(lbl.toUpperCase(), ML, y);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...BODY_T);
        doc.text(val || '—', ML + 78, y);
        y += 14;
    }

    y += 8;
    sectionHead('SLAB LAYOUT OVERVIEW');
    const overviewData = slabCanvas.toDataURL('image/png');
    const maxOverviewH = Math.min(300, PH - FOOTER_H - y - 20);
    const ovScale = Math.min(CW / slabCanvas.width, maxOverviewH / slabCanvas.height);
    const ovW = slabCanvas.width * ovScale, ovH = slabCanvas.height * ovScale;
    checkY(ovH + 10);
    doc.addImage(overviewData, 'PNG', ML + (CW - ovW) / 2, y, ovW, ovH);
    y += ovH + 14;

    // ── Per-slab detail pages ─────────────────────────────────
    for (let si = 0; si < slabDefs.length; si++) {
        const sd = slabDefs[si];
        newPage(`Slab ${si + 1} Detail`);
        y += 4;

        // Render this slab alone on an offscreen canvas
        const SC_DETAIL = Math.min(6, 500 / Math.max(sd.w, sd.h)); // px per inch, up to 6
        const padPx = 20;
        const offW = Math.ceil(sd.w * SC_DETAIL + padPx * 2);
        const offH = Math.ceil(sd.h * SC_DETAIL + padPx * 2);
        const off = document.createElement('canvas');
        off.width  = offW;
        off.height = offH;
        const octx = off.getContext('2d');
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, offW, offH);
        slabDrawSlab(octx, sd, si, padPx, padPx, SC_DETAIL);

        const detailData = off.toDataURL('image/png');
        const maxDH = Math.min(380, PH - FOOTER_H - y - 30);
        const dScale = Math.min(CW / offW, maxDH / offH);
        const dW = offW * dScale, dH = offH * dScale;
        sectionHead(`SLAB ${si + 1}  —  ${sd.w}" × ${sd.h}"`);
        doc.addImage(detailData, 'PNG', ML + (CW - dW) / 2, y, dW, dH);
        y += dH + 14;

        // Piece table for this slab
        const slabPieces = slabPlaced.filter(p => p.slabIdx === si);
        if (slabPieces.length) {
            checkY(30);
            doc.setFillColor(...TBL_BG);
            doc.rect(ML, y - 9, CW, 13, 'F');
            doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...BRAND);
            const cols = [ML+3, ML+130, ML+240, ML+330, ML+420];
            ['PIECE NAME', 'SHAPE', 'SIZE (W × H)', 'ROTATION', 'POSITION (X, Y)'].forEach((h, i) => doc.text(h, cols[i], y - 1));
            y += 6;
            doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...BODY_T);
            for (const p of slabPieces) {
                checkY(13);
                const { w: pw, h: ph } = slabGetPieceWH(p.ref, p.rotation||0);
                const shapeName = (() => {
                    const page = pages[p.ref.pageIdx];
                    const sh = page && page.shapes[p.ref.shapeIdx];
                    return sh ? (sh.shapeType||'rect').toUpperCase() : (p.ref.segPoly ? 'SEGMENT' : 'RECT');
                })();
                const rotLbl = ['0°','90°','180°','270°'][p.rotation||0];
                const vals = [
                    p.ref.label || p.ref.name || `Piece ${p.id}`,
                    shapeName,
                    `${fmtInches(pw)} × ${fmtInches(ph)}`,
                    rotLbl,
                    `${p.x.toFixed(2)}", ${p.y.toFixed(2)}"`
                ];
                vals.forEach((v, i) => doc.text(String(v), cols[i], y));
                y += 13;
            }
        }
    }

    // ── Mockup pages — one per slab that has a stone image ───────────────
    // Strategy: render each slab using slabDrawSlab in mockupMode=true.
    // In mockup mode the fill step clips to the exact piece path (with all
    // radii/chamfers/rotations already handled by buildPath) and draws the
    // stone image at the same (ox,oy,sw,sh) as the background — guaranteed
    // pixel-perfect alignment with zero coordinate math.
    const slabsWithImg = slabDefs.map((sd, i) => ({ sd, i })).filter(({ sd }) => sd.bgImage);

    if (slabsWithImg.length) {
        // Ensure image elements are loaded
        await Promise.all(slabDefs.map((sd, i) => new Promise(res => {
            if (!sd.bgImage) return res();
            _slabImgCacheEl(i);
            const el = slabBgImgEls[i];
            if (!el) return res();
            if (el.complete && el.naturalWidth > 0) return res();
            el.onload = res; el.onerror = res;
        })));

        for (const { sd, i: si } of slabsWithImg) {
            newPage(`Stone Mockup — Slab ${si + 1}`);
            y += 4;

            // Disclaimer banner
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(8);
            const disclaimerText = 'SIMULATION ONLY - For visualization purposes only. Actual stone appearance, color variation, and piece fit may vary. This is not a guarantee of the final result.';
            const dLines = doc.splitTextToSize('** ' + disclaimerText, CW - 16);
            const bannerH = dLines.length * 10 + 10;
            doc.setFillColor(240, 238, 232);
            doc.rect(ML, y, CW, bannerH, 'F');
            doc.setDrawColor(180, 180, 180);
            doc.setLineWidth(1);
            doc.rect(ML, y, CW, bannerH, 'S');
            doc.setTextColor(80, 80, 80);
            dLines.forEach((ln, li) => doc.text(ln, ML + 8, y + 9 + li * 10));
            y += bannerH + 8;

            sectionHead(`STONE MOCKUP — SLAB ${si + 1}  (${sd.w}" × ${sd.h}")`);

            // Render the slab on an offscreen canvas in mockup mode.
            // Use the same scale logic as the detail pages.
            const SC_MK = Math.min(6, 500 / Math.max(sd.w, sd.h));
            const padPx = 20;
            const mkOffW = Math.ceil(sd.w * SC_MK + padPx * 2);
            const mkOffH = Math.ceil(sd.h * SC_MK + padPx * 2);
            const mkOff = document.createElement('canvas');
            mkOff.width  = mkOffW;
            mkOff.height = mkOffH;
            const mkCtx = mkOff.getContext('2d');
            mkCtx.fillStyle = '#111111';
            mkCtx.fillRect(0, 0, mkOffW, mkOffH);
            slabDrawSlab(mkCtx, sd, si, padPx, padPx, SC_MK, /*mockupMode=*/true);

            const mkData = mkOff.toDataURL('image/jpeg', 0.93);
            const maxMkH = PH - FOOTER_H - y - 20;
            const mkScale = Math.min(CW / mkOffW, maxMkH / mkOffH);
            const fW = mkOffW * mkScale, fH = mkOffH * mkScale;
            doc.addImage(mkData, 'JPEG', ML + (CW - fW) / 2, y, fW, fH);
            y += fH + 10;
        }
    }

    // ── Save ─────────────────────────────────────────────────
    const fname = `SI-${pdfBaseName()}_Layout.pdf`;
    doc.save(fname);
    // Restore the live slab canvas to its dark on-screen background + remnants.
    _slabSkipRemnantsInRender = false;
    slabRender();
}

document.getElementById('slab-export-pdf-btn').addEventListener('click', exportLayoutPDF);

// ─────────────────────────────────────────────────────────────
//  Page management
// ─────────────────────────────────────────────────────────────
let _nextPageId = 2;

function renderPageTabs() {
    const bar = document.getElementById('page-tabs');
    const addBtn = document.getElementById('pg-add');
    // Remove old tabs (not the add button)
    [...bar.querySelectorAll('.pg-tab')].forEach(el => el.remove());
    pages.forEach((p, idx) => {
        const tab = document.createElement('div');
        tab.className = 'pg-tab' + (idx === currentPageIdx ? ' active' : '');
        tab.dataset.idx = idx;

        const nameEl = document.createElement('span');
        nameEl.className = 'pg-tab-name';
        nameEl.textContent = p.name;
        nameEl.contentEditable = 'false';
        nameEl.spellcheck = false;

        // Double-click to rename
        nameEl.addEventListener('dblclick', e => {
            e.stopPropagation();
            nameEl.contentEditable = 'true';
            nameEl.focus();
            const range = document.createRange();
            range.selectNodeContents(nameEl);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
        });
        nameEl.addEventListener('blur', () => {
            nameEl.contentEditable = 'false';
            const newName = nameEl.textContent.trim() || p.name;
            nameEl.textContent = newName;
            p.name = newName;
            // Update any Page-type material labels linked to this page
            let matsChanged = false;
            for (const m of (formData.materials||[])) {
                if ((m.type||'page') === 'page' && m.pageId === p.id) {
                    m.label = newName; matsChanged = true;
                }
            }
            if (matsChanged) saveForm();
            persist();
            renderMaterials();
            renderPricingPanel();
        });
        nameEl.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
            if (e.key === 'Escape') { nameEl.textContent = p.name; nameEl.blur(); }
            e.stopPropagation(); // don't trigger canvas shortcuts
        });

        tab.addEventListener('mousedown', e => {
            if (nameEl.contentEditable === 'true') return;
            if (e.target.classList.contains('pg-tab-del')) return;
            switchPage(idx);
        });

        tab.appendChild(nameEl);

        // Delete button (only if more than 1 page)
        if (pages.length > 1) {
            const del = document.createElement('span');
            del.className = 'pg-tab-del';
            del.textContent = '×';
            del.title = 'Delete page';
            del.addEventListener('click', e => { e.stopPropagation(); deletePage(idx); });
            tab.appendChild(del);
        }

        bar.insertBefore(tab, addBtn);
    });
}

function switchPage(idx) {
    if (idx === currentPageIdx) return;
    // Clear transient selection state
    selected = null; selectedJoint = null; selectedText = null;
    moving = false; resizing = false; drawing = false;
    ghostText = null; pendingPlace = null;
    syncPageOut();
    currentPageIdx = idx;
    syncPageIn();
    persist();
    renderPageTabs();
    render(); updateStatus();
}

function addPage() {
    syncPageOut();
    const id = _nextPageId++;
    pages.push({ id, name: `Page ${id}`, shapes:[], textItems:[], nextId:1, _undo:[] });
    // switch to new page
    selected = null; selectedJoint = null; selectedText = null;
    currentPageIdx = pages.length - 1;
    syncPageIn();
    persist();
    renderPageTabs();
    renderMaterials(); // refresh page-selector dropdowns in material rows
    render(); updateStatus();
}

function deletePage(idx) {
    if (pages.length <= 1) return;
    if (!confirm(`Delete "${pages[idx].name}"? This cannot be undone.`)) return;
    const deletedId = pages[idx].id;
    pages.splice(idx, 1);
    if (currentPageIdx >= pages.length) currentPageIdx = pages.length - 1;
    syncPageIn();
    selected = null; selectedJoint = null; selectedText = null;
    // Unlink any Page-type materials pointing to the deleted page
    let matsChanged = false;
    for (const m of (formData.materials||[])) {
        if ((m.type||'page') === 'page' && m.pageId === deletedId) {
            m.pageId = null; m.label = ''; matsChanged = true;
        }
    }
    if (matsChanged) saveForm();
    persist();
    renderPageTabs();
    renderMaterials();
    renderPricingPanel();
    render(); updateStatus();
}

// ─────────────────────────────────────────────────────────────
//  Init — called by Clerk after successful sign-in
// ─────────────────────────────────────────────────────────────
function _initSession() {
    const hasSession = localStorage.getItem('spartan_v4') || localStorage.getItem('spartan_v3');
    if (hasSession) {
        const resume = confirm('A previous session was found.\n\nResume previous session?\n\n(Cancel = start fresh)');
        if (!resume) {
            ['spartan_v4','spartan_v3','spartan_v2', FORM_KEY, PRICING_KEY].forEach(k => localStorage.removeItem(k));
        }
    }
}
// ══════════════════════════════════════════════════════════════════════
// ── SLAB IMAGE IMPORT ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

let slabBgImgEls = {}; // idx → HTMLImageElement cache
let _slabImgState = null; // overlay state: { imgEl, corners[], sc }

// Rebuild/update HTMLImageElement cache for slab idx
function _slabImgCacheEl(idx) {
    const url = slabDefs[idx] && slabDefs[idx].bgImage;
    if (!url) { delete slabBgImgEls[idx]; return; }
    if (!slabBgImgEls[idx] || slabBgImgEls[idx]._src !== url) {
        const el = new Image();
        el._src = url;
        el.onload = () => slabRender();
        el.src = url;
        slabBgImgEls[idx] = el;
    }
}

// ── Perspective warp math ──────────────────────────────────────────────
// Gaussian elimination: solve A·x = b, returns x or null
function _gauss(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
        let mr = c;
        for (let r = c+1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[mr][c])) mr = r;
        [M[c], M[mr]] = [M[mr], M[c]];
        const p = M[c][c]; if (Math.abs(p) < 1e-10) return null;
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r][c] / p;
            for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
        }
    }
    return M.map((row, i) => row[n] / row[i]);
}

// Compute 3×3 homography from 4 pairs [[sx,sy, dx,dy], …]
function _computeH(pairs) {
    const A = [], b = [];
    for (const [sx, sy, dx, dy] of pairs) {
        A.push([-sx,-sy,-1, 0, 0, 0, dx*sx, dx*sy]); b.push(-dx);
        A.push([ 0,  0,  0,-sx,-sy,-1, dy*sx, dy*sy]); b.push(-dy);
    }
    const h = _gauss(A, b);
    if (!h) return null;
    return [[h[0],h[1],h[2]], [h[3],h[4],h[5]], [h[6],h[7],1]];
}

function _applyH(H, x, y) {
    const [r0,r1,r2] = H;
    const w = r2[0]*x + r2[1]*y + r2[2];
    return [(r0[0]*x + r0[1]*y + r0[2])/w, (r1[0]*x + r1[1]*y + r1[2])/w];
}

// Draw a textured triangle using an affine transform + clip trick (GPU-accelerated)
function _drawTexTri(octx, srcImg,
    dx0,dy0, dx1,dy1, dx2,dy2,
    sx0,sy0, sx1,sy1, sx2,sy2) {
    // Affine: maps (sx,sy) image coords → (dx,dy) canvas coords
    // ctx.setTransform(a,b,c,d,e,f): x'=a*sx+c*sy+e, y'=b*sx+d*sy+f
    const dA=dx1-dx0, dB=dx2-dx0, dC=dy1-dy0, dD=dy2-dy0;
    const sA=sx1-sx0, sB=sx2-sx0, sC=sy1-sy0, sD=sy2-sy0;
    const det = sA*sD - sB*sC;
    if (Math.abs(det) < 0.5) return;
    const a  = (dA*sD - dB*sC)/det,  cv = (dB*sA - dA*sB)/det;
    const bv = (dC*sD - dD*sC)/det,  d  = (dD*sA - dC*sB)/det;
    const e  = dx0 - a*sx0 - cv*sy0, f  = dy0 - bv*sx0 - d*sy0;
    octx.save();
    // Clip to destination triangle — expand slightly to eliminate seam gaps
    const cx3=(dx0+dx1+dx2)/3, cy3=(dy0+dy1+dy2)/3;
    const EXP=0.8; // px expansion per vertex away from centroid
    function expV(vx,vy){const ddx=vx-cx3,ddy=vy-cy3,dl=Math.hypot(ddx,ddy)||1;return[vx+ddx/dl*EXP,vy+ddy/dl*EXP];}
    const [ex0,ey0]=expV(dx0,dy0),[ex1,ey1]=expV(dx1,dy1),[ex2,ey2]=expV(dx2,dy2);
    octx.beginPath();
    octx.moveTo(ex0,ey0); octx.lineTo(ex1,ey1); octx.lineTo(ex2,ey2);
    octx.closePath(); octx.clip();
    octx.setTransform(a, bv, cv, d, e, f);
    octx.drawImage(srcImg, 0, 0);
    octx.restore();
}

// Warp srcImg to a rectangle outW×outH using 4 source corner points (TL,TR,BR,BL)
// Returns data URL of the warped image (JPEG)
function _perspectiveWarp(srcImg, srcPts, outW, outH) {
    const oc = document.createElement('canvas');
    oc.width = outW; oc.height = outH;
    const octx = oc.getContext('2d');
    // Homography: output pixel (u,v) → source image pixel (x,y)
    const H = _computeH([
        [0,    0,     srcPts[0][0], srcPts[0][1]],
        [outW, 0,     srcPts[1][0], srcPts[1][1]],
        [outW, outH,  srcPts[2][0], srcPts[2][1]],
        [0,    outH,  srcPts[3][0], srcPts[3][1]]
    ]);
    if (!H) return null;
    const N = 20; // grid subdivisions — higher = more accurate for strong perspective
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            // Output grid cell corners
            const dx00=i/N*outW,     dy00=j/N*outH;
            const dx10=(i+1)/N*outW, dy10=j/N*outH;
            const dx01=i/N*outW,     dy01=(j+1)/N*outH;
            const dx11=(i+1)/N*outW, dy11=(j+1)/N*outH;
            // Corresponding source points via homography
            const [sx00,sy00]=_applyH(H,dx00,dy00);
            const [sx10,sy10]=_applyH(H,dx10,dy10);
            const [sx01,sy01]=_applyH(H,dx01,dy01);
            const [sx11,sy11]=_applyH(H,dx11,dy11);
            // Two triangles per cell
            _drawTexTri(octx,srcImg, dx00,dy00,dx10,dy10,dx01,dy01, sx00,sy00,sx10,sy10,sx01,sy01);
            _drawTexTri(octx,srcImg, dx10,dy10,dx11,dy11,dx01,dy01, sx10,sy10,sx11,sy11,sx01,sy01);
        }
    }
    return oc.toDataURL('image/png');
}

// ── Overlay UI ────────────────────────────────────────────────────────
function slabImgOpen(imgEl) {
    const overlay = document.getElementById('slab-img-overlay');
    const canvas  = document.getElementById('slab-img-canvas');
    // Scale image to fit viewport (never upscale)
    const maxW = window.innerWidth - 4;
    const maxH = window.innerHeight - 56;
    const sc = Math.min(1, maxW / imgEl.naturalWidth, maxH / imgEl.naturalHeight);
    canvas.width  = Math.round(imgEl.naturalWidth  * sc);
    canvas.height = Math.round(imgEl.naturalHeight * sc);
    canvas.style.width  = canvas.width  + 'px';
    canvas.style.height = canvas.height + 'px';
    _slabImgState = { imgEl, corners: [], sc };
    document.getElementById('slab-img-picker').style.display = 'none';
    overlay.style.display = 'flex';
    _slabImgRender();
}

function _slabImgRender() {
    const st = _slabImgState; if (!st) return;
    const canvas = document.getElementById('slab-img-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(st.imgEl, 0, 0, canvas.width, canvas.height);

    const colors  = ['#44ee66','#eeee44','#ff6644','#44aaff'];
    const labels  = ['①TL','②TR','③BR','④BL'];

    // Draw quad outline
    if (st.corners.length >= 2) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(st.corners[0][0]*st.sc, st.corners[0][1]*st.sc);
        for (let i=1; i<st.corners.length; i++) ctx.lineTo(st.corners[i][0]*st.sc, st.corners[i][1]*st.sc);
        if (st.corners.length === 4) ctx.closePath();
        ctx.strokeStyle='rgba(255,200,50,0.85)'; ctx.lineWidth=2;
        ctx.setLineDash([7,4]); ctx.stroke(); ctx.setLineDash([]);
        ctx.restore();
    }
    // Draw corner markers
    st.corners.forEach(([ix, iy], i) => {
        const cx=ix*st.sc, cy=iy*st.sc;
        ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI*2);
        ctx.fillStyle=colors[i]; ctx.fill();
        ctx.strokeStyle='rgba(0,0,0,0.7)'; ctx.lineWidth=2; ctx.stroke();
        ctx.fillStyle='#000'; ctx.font='bold 10px sans-serif';
        ctx.textAlign='center'; ctx.textBaseline='middle';
        ctx.fillText(labels[i], cx, cy);
    });

    document.getElementById('slab-img-progress').textContent = `${st.corners.length} / 4`;
    document.getElementById('slab-img-confirm').disabled = st.corners.length !== 4;
    document.getElementById('slab-img-undo').disabled    = st.corners.length === 0;
}

function _slabImgApply(slabIdx) {
    const st = _slabImgState; if (!st) return;
    const sd = slabDefs[slabIdx];
    // Output at slab aspect ratio, max 1400px wide
    const outW = Math.min(1400, st.imgEl.naturalWidth);
    const outH = Math.round(outW * sd.h / sd.w);
    const dataUrl = _perspectiveWarp(st.imgEl, st.corners, outW, outH);
    if (!dataUrl) { alert('Image processing failed — please retry.'); return; }
    sd.bgImage = dataUrl;
    delete slabBgImgEls[slabIdx]; // force cache rebuild
    _slabImgCacheEl(slabIdx);
    document.getElementById('slab-img-overlay').style.display = 'none';
    _slabImgState = null;
    slabRefreshSlabList();
    slabRender();
}

(function _slabImgWire() {
    const canvas = document.getElementById('slab-img-canvas');

    // Click on image = place corner
    canvas.addEventListener('click', e => {
        const st = _slabImgState;
        if (!st || st.pickerActive || st.corners.length >= 4) return;
        const r = canvas.getBoundingClientRect();
        // Account for any CSS scaling of the canvas element
        const scaleX = canvas.width  / r.width;
        const scaleY = canvas.height / r.height;
        const cx = (e.clientX - r.left) * scaleX;
        const cy = (e.clientY - r.top)  * scaleY;
        st.corners.push([cx / st.sc, cy / st.sc]); // store in image pixels
        _slabImgRender();
    });

    document.getElementById('slab-img-undo').addEventListener('click', () => {
        if (_slabImgState) { _slabImgState.corners.pop(); _slabImgRender(); }
    });

    document.getElementById('slab-img-cancel').addEventListener('click', () => {
        document.getElementById('slab-img-overlay').style.display = 'none';
        _slabImgState = null;
    });

    document.getElementById('slab-img-confirm').addEventListener('click', () => {
        const st = _slabImgState;
        if (!st || st.corners.length !== 4) return;
        st.pickerActive = true;
        if (slabDefs.length === 1) {
            _slabImgApply(0);
        } else {
            // Show slab picker panel
            const picker = document.getElementById('slab-img-picker');
            const btnsDiv = document.getElementById('slab-img-picker-btns');
            btnsDiv.innerHTML = '';
            slabDefs.forEach((sd, i) => {
                const btn = document.createElement('button');
                btn.className = 'tool-btn';
                btn.style.cssText = 'font-size:12px; padding:7px 16px;';
                btn.textContent = `Slab ${i+1}  (${sd.w}"×${sd.h}")` + (sd.bgImage ? '  ✦' : '');
                btn.addEventListener('click', () => _slabImgApply(i));
                btnsDiv.appendChild(btn);
            });
            picker.style.cssText = 'display:flex; flex-direction:column; padding:14px; background:#1a2a44; color:#e0e8ff; text-align:center; flex-shrink:0;';
        }
    });

    document.getElementById('slab-img-file').addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return;
        e.target.value = '';
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload  = () => slabImgOpen(img);
        img.onerror = () => alert('Could not load image file.');
        img.src = url;
    });

    document.getElementById('slab-import-img-btn').addEventListener('click', () => {
        document.getElementById('slab-img-file').click();
    });
})();

// ══════════════════════════════════════════════════════════════════════
// ── KITCHEN LAYOUT (Lock All & Arrange) ──────────────────────────────
// ══════════════════════════════════════════════════════════════════════
(function() {

// ── State ─────────────────────────────────────────────────────────────
let kitBgColor = '#f5f5f0';
// Each captured piece: { id, label, imgCanvas, wi, hi, origRot }
let kitPieces  = [];
// Layout state per piece: kitLayout[i] = { x, y, rot }  (inches on free canvas)
let kitLayout  = [];
let kitSel     = null;   // index into kitPieces (or null)
let kitHeld    = null;   // index being dragged (or null)
let kitHeldOff = {x:0,y:0};
// Text labels: { text, x, y } — x,y in inches on free canvas
let kitLabels  = [];
let kitSelLabel  = null;  // index into kitLabels (or null)
let kitHeldLabel = null;  // index being dragged
let kitHeldLabelOff = {x:0,y:0};
let kitSc      = 6;      // px per inch
let kitOX      = 60;
let kitOY      = 60;
let kitPanning = false;
let kitPanStart= {x:0,y:0,ox:0,oy:0};
let kitCursor  = {x:0,y:0};
let kitOpen    = false;

const kitCanvas = () => document.getElementById('kit-canvas');
const kitStatus = () => document.getElementById('kit-status');
// ── Capture a piece's stone image as a cropped canvas ──────────────────
// Uses the existing slabDrawSlab path logic to clip the stone image
// Returns a canvas with transparent background, piece shape filled with stone
function capturePieceImage(p, capSc) {
    const sd  = slabDefs[p.slabIdx]; if(!sd) return null;
    const rot = p.rotation || 0;
    const {w:pw, h:ph} = slabGetPieceWH(p.ref, rot);
    const cw  = Math.ceil(pw * capSc);
    const ch  = Math.ceil(ph * capSc);
    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const ctx = off.getContext('2d');

    // Build piece path at (0,0)
    kitBuildPath(ctx, p, 0, 0, capSc, rot);
    ctx.clip();

    // Draw slab background image clipped to piece shape
    _slabImgCacheEl(p.slabIdx);
    const bgEl = slabBgImgEls[p.slabIdx];
    if (bgEl && bgEl.complete && bgEl.naturalWidth > 0) {
        // Map piece's slab position to image coordinates
        const stoneW = sd.w * capSc, stoneH = sd.h * capSc;
        ctx.drawImage(bgEl, -p.x * capSc, -p.y * capSc, stoneW, stoneH);
    } else {
        ctx.fillStyle = '#c8b890'; ctx.fill();
    }
    return off;
}

// ── Path builder (same logic as old simBuildPath) ─────────────────────
function kitBuildPath(ctx, p, px, py, sc, rotOverride) {
    const rot   = rotOverride !== undefined ? rotOverride : (p.rotation||0);
    const wi_in = p.ref.wi || 0;
    const hi_in = p.ref.hi || 0;
    const page  = pages[p.ref.pageIdx];
    const shape = page ? page.shapes[p.ref.shapeIdx] : null;
    const st    = shape ? (shape.shapeType||'rect') : 'rect';
    const segPoly = p.ref.segPoly || null;

    function convRot(lx,ly) {
        switch(rot){
            case 1:return[px+(hi_in-ly)*sc, py+lx*sc];
            case 2:return[px+(wi_in-lx)*sc, py+(hi_in-ly)*sc];
            case 3:return[px+ly*sc,          py+(wi_in-lx)*sc];
            default:return[px+lx*sc,         py+ly*sc];
        }
    }
    function convAbs([ax,ay]){return convRot((ax-shape.x)/INCH,(ay-shape.y)/INCH);}

    ctx.beginPath();
    if (segPoly) {
        const pts=segPoly.map(([lx,ly])=>{switch(rot){case 1:return[hi_in-ly,lx];case 2:return[wi_in-lx,hi_in-ly];case 3:return[ly,wi_in-lx];default:return[lx,ly];}});
        ctx.moveTo(px+pts[0][0]*sc,py+pts[0][1]*sc);
        for(let i=1;i<pts.length;i++) ctx.lineTo(px+pts[i][0]*sc,py+pts[i][1]*sc);
        ctx.closePath();
    } else if ((st==='l'||st==='u')&&shape&&p.ref.segIdx==null&&shape.farmSink) {
        // L/U with farm sink: route through shapeLocalPolyInches so the
        // FS notch is carved in the captured piece outline.
        const poly=shapeLocalPolyInches(shape);
        const pts=poly.map(([lx,ly])=>{switch(rot){case 1:return[hi_in-ly,lx];case 2:return[wi_in-lx,hi_in-ly];case 3:return[ly,wi_in-lx];default:return[lx,ly];}});
        ctx.moveTo(px+pts[0][0]*sc,py+pts[0][1]*sc);
        for(let i=1;i<pts.length;i++) ctx.lineTo(px+pts[i][0]*sc,py+pts[i][1]*sc);
        ctx.closePath();
    } else if (st==='l'&&shape&&p.ref.segIdx==null) {
        const verts=lShapeVerts(shape),basePoly=lShapePolygon(shape),n=verts.length;
        const checkAt=new Array(n).fill(null);
        for(const c of (shape.checks||[])){if(c.vertexIdx!=null&&c.vertexIdx>=0&&c.vertexIdx<n)checkAt[c.vertexIdx]=cornerCheckPoints(basePoly,c.vertexIdx,c);}
        const v0=convAbs(checkAt[0]?checkAt[0].B:verts[0].pout); ctx.moveTo(v0[0],v0[1]);
        for(let i=0;i<n;i++){const nextI=(i+1)%n,nv=verts[nextI],nvCk=checkAt[nextI];if(nvCk){const A=convAbs(nvCk.A),C=convAbs(nvCk.C),B=convAbs(nvCk.B);ctx.lineTo(A[0],A[1]);ctx.lineTo(C[0],C[1]);ctx.lineTo(B[0],B[1]);}else{const pin=convAbs(nv.pin);ctx.lineTo(pin[0],pin[1]);if(nv.t>0){if(nv.r===0){const po=convAbs(nv.pout);ctx.lineTo(po[0],po[1]);}else{const cu=convAbs(nv.curr),po=convAbs(nv.pout);ctx.arcTo(cu[0],cu[1],po[0],po[1],nv.r/INCH*sc);}}}}
        ctx.closePath();
    } else if (st==='u'&&shape&&p.ref.segIdx==null) {
        const verts=uShapeVerts(shape),basePoly=uShapePolygon(shape),n=verts.length;
        const checkAt=new Array(n).fill(null);
        for(const c of (shape.checks||[])){if(c.vertexIdx!=null&&c.vertexIdx>=0&&c.vertexIdx<n)checkAt[c.vertexIdx]=cornerCheckPoints(basePoly,c.vertexIdx,c);}
        const v0=convAbs(checkAt[0]?checkAt[0].B:verts[0].pout); ctx.moveTo(v0[0],v0[1]);
        for(let i=0;i<n;i++){const nextI=(i+1)%n,nv=verts[nextI],nvCk=checkAt[nextI];if(nvCk){const A=convAbs(nvCk.A),C=convAbs(nvCk.C),B=convAbs(nvCk.B);ctx.lineTo(A[0],A[1]);ctx.lineTo(C[0],C[1]);ctx.lineTo(B[0],B[1]);}else{const pin=convAbs(nv.pin);ctx.lineTo(pin[0],pin[1]);if(nv.t>0){if(nv.r===0){const po=convAbs(nv.pout);ctx.lineTo(po[0],po[1]);}else{const cu=convAbs(nv.curr),po=convAbs(nv.pout);ctx.arcTo(cu[0],cu[1],po[0],po[1],nv.r/INCH*sc);}}}}
        ctx.closePath();
    } else if (st==='bsp'&&shape&&p.ref.segIdx==null) {
        const pts=bspPolygon(shape),f=convAbs(pts[0]);ctx.moveTo(f[0],f[1]);
        for(let i=1;i<pts.length;i++){const pt=convAbs(pts[i]);ctx.lineTo(pt[0],pt[1]);}
        ctx.closePath();
    } else if (st==='circle') {
        const{w:ppw}=slabGetPieceWH(p.ref,rot);const r=ppw*sc/2;ctx.arc(px+r,py+r,r,0,Math.PI*2);
    } else if (shape&&p.ref.segIdx==null&&(shape.farmSink||(shape.checks||[]).length>0)) {
        // Rect with farm sink OR corner checks — use the notched polygon
        const poly=shapeLocalPolyInches(shape);
        const pts=poly.map(([lx,ly])=>{switch(rot){case 1:return[hi_in-ly,lx];case 2:return[wi_in-lx,hi_in-ly];case 3:return[ly,wi_in-lx];default:return[lx,ly];}});
        ctx.moveTo(px+pts[0][0]*sc,py+pts[0][1]*sc);
        for(let i=1;i<pts.length;i++)ctx.lineTo(px+pts[i][0]*sc,py+pts[i][1]*sc);
        ctx.closePath();
    } else {
        const r=shape?shapeRadii(shape):{nw:0,ne:0,se:0,sw:0};
        const ch=shape?shapeChamfers(shape):{nw:0,ne:0,se:0,sw:0};
        const chB=shape?shapeChamfersB(shape):{nw:0,ne:0,se:0,sw:0};
        const cvt=v=>v/INCH*sc;
        const segOff=p.ref.segOffset;
        let mNW=true,mNE=true,mSE=true,mSW=true;
        if(segOff&&shape){const totalW=shape.w/INCH,totalH=shape.h/INCH;const isFX=Math.abs(segOff.fromX)<1e-4,isLX=Math.abs(segOff.toX-totalW)<0.01;const isFY=Math.abs(segOff.fromY)<1e-4,isLY=Math.abs(segOff.toY-totalH)<0.01;mNW=isFX&&isFY;mNE=isLX&&isFY;mSE=isLX&&isLY;mSW=isFX&&isLY;}
        let eR={nw:mNW?cvt(r.nw):0,ne:mNE?cvt(r.ne):0,se:mSE?cvt(r.se):0,sw:mSW?cvt(r.sw):0};
        let eCh={nw:mNW?cvt(ch.nw):0,ne:mNE?cvt(ch.ne):0,se:mSE?cvt(ch.se):0,sw:mSW?cvt(ch.sw):0};
        let eChB={nw:mNW?cvt(chB.nw):0,ne:mNE?cvt(chB.ne):0,se:mSE?cvt(chB.se):0,sw:mSW?cvt(chB.sw):0};
        const rotC=o=>{switch(rot){case 1:return{nw:o.sw,ne:o.nw,se:o.ne,sw:o.se};case 2:return{nw:o.se,ne:o.sw,se:o.nw,sw:o.ne};case 3:return{nw:o.ne,ne:o.se,se:o.sw,sw:o.nw};default:return o;}};
        if(rot){eR=rotC(eR);eCh=rotC(eCh);eChB=rotC(eChB);}
        const{w:ppw,h:pph}=slabGetPieceWH(p.ref,rot);
        const x=px,y=py,w=ppw*sc,h=pph*sc;
        const nwA=eCh.nw>0?eCh.nw:eR.nw,nwB=eCh.nw>0?eChB.nw:eR.nw;
        const neA=eCh.ne>0?eCh.ne:eR.ne,neB=eCh.ne>0?eChB.ne:eR.ne;
        const seA=eCh.se>0?eCh.se:eR.se,seB=eCh.se>0?eChB.se:eR.se;
        const swA=eCh.sw>0?eCh.sw:eR.sw,swB=eCh.sw>0?eChB.sw:eR.sw;
        ctx.moveTo(x+nwA,y);ctx.lineTo(x+w-neA,y);
        if(eCh.ne>0)ctx.lineTo(x+w,y+neB);else if(eR.ne>0)ctx.arcTo(x+w,y,x+w,y+eR.ne,eR.ne);else ctx.lineTo(x+w,y);
        ctx.lineTo(x+w,y+h-seA);
        if(eCh.se>0)ctx.lineTo(x+w-seB,y+h);else if(eR.se>0)ctx.arcTo(x+w,y+h,x+w-eR.se,y+h,eR.se);else ctx.lineTo(x+w,y+h);
        ctx.lineTo(x+swA,y+h);
        if(eCh.sw>0)ctx.lineTo(x,y+h-swB);else if(eR.sw>0)ctx.arcTo(x,y+h,x,y+h-eR.sw,eR.sw);else ctx.lineTo(x,y+h);
        ctx.lineTo(x,y+nwB);
        if(eCh.nw>0)ctx.lineTo(x+nwA,y);else if(eR.nw>0)ctx.arcTo(x,y,x+eR.nw,y,eR.nw);else ctx.lineTo(x,y);
        ctx.closePath();
    }
}

// ── Lock All: capture every placed piece from every slab ──────────────
function kitLockAll() {
    if (!slabPlaced.length) { alert('No pieces placed on any slab.'); return; }
    // Check at least one slab has an image
    const hasAnyImg = slabDefs.some(sd => !!sd.bgImage);
    if (!hasAnyImg && !confirm('No slab images imported. Pieces will have a plain fill. Continue?')) return;

    const CAP_SC = 8; // capture resolution: 8 px per inch
    kitPieces = [];
    kitLayout = [];
    let autoX = 4, autoY = 4;

    for (const p of slabPlaced) {
        const rot = p.rotation || 0;
        const {w:pw, h:ph} = slabGetPieceWH(p.ref, rot);
        const imgCanvas = capturePieceImage(p, CAP_SC);
        kitPieces.push({
            id: p.id,
            label: p.customLabel || slabGetPieceLabel(p.ref),
            imgCanvas: imgCanvas,
            wi: pw, hi: ph,
            origRot: rot,
            slabPlacedRef: p
        });
        kitLayout.push({ x: autoX, y: autoY, rot: 0 });
        autoX += pw + 3;
        if (autoX > 100) { autoX = 4; autoY += ph + 3; }
    }

    kitSel = null; kitHeld = null;
    kitLabels = []; kitSelLabel = null; kitHeldLabel = null;
    kitSc = 6; kitOX = 60; kitOY = 60;
    kitOpen = true;
    document.getElementById('kitchen-overlay').style.display = 'flex';
    kitResizeCanvas();
    kitRefreshList();
    kitRender();
    kitSetStatus('All pieces locked. Drag to arrange your kitchen layout. R to rotate selected piece.');
}

// ── Get piece dimensions accounting for layout rotation ───────────────
function kitGetWH(idx) {
    const kp = kitPieces[idx];
    const lr = kitLayout[idx].rot;
    return (lr === 1 || lr === 3) ? { w: kp.hi, h: kp.wi } : { w: kp.wi, h: kp.hi };
}

// ── Render kitchen layout canvas ──────────────────────────────────────
function kitRender() {
    const cv = kitCanvas(); if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);

    // Background
    ctx.fillStyle = kitBgColor; ctx.fillRect(0, 0, cv.width, cv.height);

    // Subtle grid (6-inch spacing) — adapt to light/dark bg
    const bgIsDark = parseInt(kitBgColor.slice(1,3),16) < 128;
    ctx.save(); ctx.strokeStyle = bgIsDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'; ctx.lineWidth = 0.5;
    const gsc = kitSc * 6;
    const startX = (kitOX % gsc + gsc) % gsc, startY = (kitOY % gsc + gsc) % gsc;
    for (let x = startX; x < cv.width; x += gsc) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); }
    for (let y = startY; y < cv.height; y += gsc) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.width, y); ctx.stroke(); }
    ctx.restore();

    // Draw each piece
    for (let i = 0; i < kitPieces.length; i++) {
        if (kitHeld === i) continue; // draw ghost separately
        kitDrawPiece(ctx, i, false);
    }

    // Ghost (held piece follows cursor)
    if (kitHeld !== null) {
        const mx = kitCursor.x - kitHeldOff.x;
        const my = kitCursor.y - kitHeldOff.y;
        kitDrawPieceAt(ctx, kitHeld, mx, my, true);
    }

    // Draw text labels
    for (let i = 0; i < kitLabels.length; i++) {
        if (kitHeldLabel === i) continue;
        kitDrawLabel(ctx, i, false);
    }
    // Ghost label
    if (kitHeldLabel !== null) {
        kitDrawLabelAt(ctx, kitHeldLabel, kitCursor.x - kitHeldLabelOff.x, kitCursor.y - kitHeldLabelOff.y, true);
    }

    // Corner hint
    ctx.fillStyle = bgIsDark ? 'rgba(200,210,190,0.5)' : 'rgba(100,110,90,0.7)'; ctx.font = '10px Raleway,sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('Kitchen Layout — drag pieces to arrange · Scroll to zoom · Middle-drag to pan', 10, 8);
}

function kitDrawLabel(ctx, idx, isGhost) {
    const lb = kitLabels[idx];
    const cx = kitOX + lb.x * kitSc;
    const cy = kitOY + lb.y * kitSc;
    kitDrawLabelAt(ctx, idx, cx, cy, isGhost);
}
function kitDrawLabelAt(ctx, idx, cx, cy, isGhost) {
    const lb = kitLabels[idx];
    const isSel = kitSelLabel === idx;
    const fontSize = Math.max(10, 14 * (kitSc / 6));
    ctx.save();
    if (isGhost) ctx.globalAlpha = 0.6;
    ctx.font = `bold ${fontSize}px Raleway,sans-serif`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const metrics = ctx.measureText(lb.text);
    const pad = 4;
    const tw = metrics.width + pad * 2;
    const th = fontSize + pad * 2;
    // Background pill — adapt to bg
    const lbDark = parseInt(kitBgColor.slice(1,3),16) < 128;
    ctx.fillStyle = isSel ? 'rgba(200,192,176,0.35)' : (lbDark ? 'rgba(255,255,255,0.15)' : 'rgba(45,58,16,0.18)');
    ctx.beginPath();
    ctx.roundRect(cx - pad, cy - pad, tw, th, 4);
    ctx.fill();
    if (isSel) {
        ctx.strokeStyle = '#b09030'; ctx.lineWidth = 1.5;
        ctx.stroke();
    }
    // Text
    ctx.fillStyle = lbDark ? '#e0d8c0' : '#2d3a10';
    ctx.fillText(lb.text, cx, cy);
    ctx.restore();
}

function kitDrawPiece(ctx, idx, isGhost) {
    const lp = kitLayout[idx];
    const cx = kitOX + lp.x * kitSc;
    const cy = kitOY + lp.y * kitSc;
    kitDrawPieceAt(ctx, idx, cx, cy, isGhost);
}

function kitDrawPieceAt(ctx, idx, cx, cy, isGhost) {
    const kp = kitPieces[idx];
    const lr = kitLayout[idx].rot;
    const {w:pw, h:ph} = kitGetWH(idx);
    const isSel = kitSel === idx;

    ctx.save();
    if (isGhost) ctx.globalAlpha = 0.7;

    // Draw captured image, rotated
    const imgW = kp.imgCanvas.width;
    const imgH = kp.imgCanvas.height;
    const drawW = pw * kitSc;
    const drawH = ph * kitSc;

    ctx.save();
    ctx.translate(cx + drawW / 2, cy + drawH / 2);
    ctx.rotate(lr * Math.PI / 2);
    // After rotation, the image's own dimensions apply (not layout-rotated)
    const origW = kp.wi * kitSc;
    const origH = kp.hi * kitSc;
    ctx.drawImage(kp.imgCanvas, -origW / 2, -origH / 2, origW, origH);
    ctx.restore();

    // Ghost dashed outline only
    if (isGhost) {
        ctx.strokeStyle = '#b09030'; ctx.lineWidth = 2.5;
        ctx.setLineDash([6, 3]);
        ctx.strokeRect(cx, cy, drawW, drawH);
        ctx.setLineDash([]);
    }

    // Label
    ctx.font = `bold ${Math.max(10, Math.min(20, ph * kitSc * 0.2))}px Raleway,sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 6; ctx.fillStyle = '#fff';
    ctx.fillText(kp.label, cx + drawW / 2, cy + drawH / 2);
    ctx.shadowBlur = 0;

    ctx.restore();
}

// ── Hit test ──────────────────────────────────────────────────────────
function kitHitTest(mx, my) {
    for (let i = kitPieces.length - 1; i >= 0; i--) {
        const lp = kitLayout[i];
        const {w:pw, h:ph} = kitGetWH(i);
        const cx = kitOX + lp.x * kitSc, cy = kitOY + lp.y * kitSc;
        if (mx >= cx && mx <= cx + pw * kitSc && my >= cy && my <= cy + ph * kitSc) return i;
    }
    return null;
}

function kitLabelHitTest(mx, my) {
    const cv = kitCanvas(); if (!cv) return null;
    const ctx = cv.getContext('2d');
    const fontSize = Math.max(10, 14 * (kitSc / 6));
    ctx.font = `bold ${fontSize}px Raleway,sans-serif`;
    const pad = 4;
    for (let i = kitLabels.length - 1; i >= 0; i--) {
        const lb = kitLabels[i];
        const cx = kitOX + lb.x * kitSc, cy = kitOY + lb.y * kitSc;
        const tw = ctx.measureText(lb.text).width + pad * 2;
        const th = fontSize + pad * 2;
        if (mx >= cx - pad && mx <= cx - pad + tw && my >= cy - pad && my <= cy - pad + th) return i;
    }
    return null;
}

// ── Mouse handlers ────────────────────────────────────────────────────
function kitClearSel() { kitSel = null; kitSelLabel = null; kitUpdateRotBtn(); kitRefreshList(); kitRender(); }

function onKitMouseMove(e) {
    const cv = kitCanvas(), r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    kitCursor = { x: mx, y: my };
    if (kitPanning) {
        kitOX = kitPanStart.ox + (mx - kitPanStart.x);
        kitOY = kitPanStart.oy + (my - kitPanStart.y);
        kitRender(); return;
    }
    if (kitHeld !== null || kitHeldLabel !== null) kitRender();
}

function onKitMouseDown(e) {
    e.preventDefault();
    const cv = kitCanvas(), r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    kitCursor = { x: mx, y: my };

    if (e.button === 1) { kitPanning = true; kitPanStart = { x: mx, y: my, ox: kitOX, oy: kitOY }; return; }
    if (e.button === 2) { kitClearSel(); return; }

    // Drop held piece
    if (kitHeld !== null) {
        kitLayout[kitHeld] = {
            ...kitLayout[kitHeld],
            x: (mx - kitHeldOff.x - kitOX) / kitSc,
            y: (my - kitHeldOff.y - kitOY) / kitSc
        };
        kitSel = kitHeld; kitSelLabel = null; kitHeld = null;
        kitUpdateRotBtn(); kitRefreshList(); kitRender();
        kitSetStatus('Dropped. Click to select/move. R to rotate.');
        return;
    }
    // Drop held label
    if (kitHeldLabel !== null) {
        kitLabels[kitHeldLabel].x = (mx - kitHeldLabelOff.x - kitOX) / kitSc;
        kitLabels[kitHeldLabel].y = (my - kitHeldLabelOff.y - kitOY) / kitSc;
        kitSelLabel = kitHeldLabel; kitSel = null; kitHeldLabel = null;
        kitUpdateRotBtn(); kitRefreshList(); kitRender();
        kitSetStatus('Label placed. Delete key to remove.');
        return;
    }

    // Pick up label first (they sit on top visually)
    const labelHit = kitLabelHitTest(mx, my);
    if (labelHit !== null) {
        const lb = kitLabels[labelHit];
        const cx = kitOX + lb.x * kitSc, cy = kitOY + lb.y * kitSc;
        kitHeldLabelOff = { x: mx - cx, y: my - cy };
        kitHeldLabel = labelHit; kitSelLabel = labelHit; kitSel = null;
        kitUpdateRotBtn(); kitRefreshList(); kitRender();
        kitSetStatus('Holding label — click to drop. Delete to remove.');
        return;
    }

    // Pick up piece
    const hit = kitHitTest(mx, my);
    if (hit !== null) {
        const lp = kitLayout[hit];
        const cx = kitOX + lp.x * kitSc, cy = kitOY + lp.y * kitSc;
        kitHeldOff = { x: mx - cx, y: my - cy };
        kitHeld = hit; kitSel = hit; kitSelLabel = null;
        kitUpdateRotBtn(); kitRefreshList(); kitRender();
        kitSetStatus('Holding piece — click to drop. R to rotate.');
    } else {
        kitClearSel();
    }
}

function onKitMouseUp(e) { if (kitPanning) kitPanning = false; }

function onKitWheel(e) {
    if (!kitOpen) return;
    e.preventDefault();
    const cv = kitCanvas(), r = cv.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    kitOX = mx - (mx - kitOX) * factor;
    kitOY = my - (my - kitOY) * factor;
    kitSc *= factor; kitSc = Math.max(1, Math.min(30, kitSc));
    kitRender();
}

// ── Rotate selected ───────────────────────────────────────────────────
function kitRotateSel() {
    if (kitSel === null) return;
    kitLayout[kitSel].rot = (kitLayout[kitSel].rot + 1) % 4;
    // Re-capture image at new rotation
    const kp = kitPieces[kitSel];
    const p = kp.slabPlacedRef;
    const newGlobalRot = (kp.origRot + kitLayout[kitSel].rot) % 4;
    // We don't re-capture — just use CSS rotation of the captured image
    kitUpdateRotBtn(); kitRefreshList(); kitRender();
}

function kitUpdateRotBtn() {
    const btn = document.getElementById('kit-rotate-btn');
    const lbl = document.getElementById('kit-sel-label');
    if (!btn || !lbl) return;
    if (kitSel !== null) {
        btn.disabled = false;
        lbl.textContent = kitPieces[kitSel].label;
    } else { btn.disabled = true; lbl.textContent = 'none'; }
}

// ── Sidebar piece list ────────────────────────────────────────────────
function kitRefreshList() {
    const el = document.getElementById('kit-piece-list'); if (!el) return;
    let html = kitPieces.map((kp, i) => {
        const {w:pw, h:ph} = kitGetWH(i);
        const rot = kitLayout[i].rot;
        const isSel = kitSel === i;
        return `<div data-idx="${i}" style="padding:7px 8px;margin-bottom:5px;border-radius:4px;cursor:pointer;user-select:none;border:2px solid ${isSel ? '#b09030' : '#555555'};background:${isSel ? '#2a1a04' : '#1a1a1a'};">
            <div style="color:${isSel ? '#ffdd44' : '#bbbbbb'};font-size:11px;font-weight:bold;">${kp.label}</div>
            <div style="color:#777777;font-size:10px;">${fmtInches(pw)} × ${fmtInches(ph)} · ${['0°', '90°', '180°', '270°'][rot]}</div>
            <div style="color:${isSel ? '#ffaa30' : '#555555'};font-size:9px;margin-top:2px;">${isSel ? '✋ selected' : 'click to select'}</div>
        </div>`;
    }).join('');
    // Labels section
    if (kitLabels.length) {
        html += `<div style="color:#b09030;font-size:10px;font-weight:bold;letter-spacing:.5px;margin:10px 0 6px;border-top:1px solid #333333;padding-top:8px;">LABELS</div>`;
        html += kitLabels.map((lb, i) => {
            const isSel = kitSelLabel === i;
            return `<div data-label-idx="${i}" style="padding:5px 8px;margin-bottom:4px;border-radius:4px;cursor:pointer;user-select:none;border:2px solid ${isSel ? '#b09030' : '#333333'};background:${isSel ? '#2a1a04' : '#111111'};display:flex;align-items:center;gap:6px;">
                <span style="color:${isSel ? '#ffdd44' : '#aaaaaa'};font-size:11px;font-weight:bold;flex:1;">${lb.text}</span>
                <span data-del-label="${i}" style="color:#555555;font-size:13px;cursor:pointer;line-height:1;" title="Delete label">✕</span>
            </div>`;
        }).join('');
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-idx]').forEach(div => {
        div.addEventListener('click', () => {
            kitSel = +div.dataset.idx; kitSelLabel = null;
            kitUpdateRotBtn(); kitRefreshList(); kitRender();
        });
    });
    el.querySelectorAll('[data-label-idx]').forEach(div => {
        div.addEventListener('click', e => {
            if (e.target.dataset.delLabel !== undefined) return;
            kitSelLabel = +div.dataset.labelIdx; kitSel = null;
            kitUpdateRotBtn(); kitRefreshList(); kitRender();
        });
    });
    el.querySelectorAll('[data-del-label]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = +btn.dataset.delLabel;
            kitLabels.splice(idx, 1);
            if (kitSelLabel === idx) kitSelLabel = null;
            else if (kitSelLabel !== null && kitSelLabel > idx) kitSelLabel--;
            kitRefreshList(); kitRender();
        });
    });
}

function kitSetStatus(msg) { const s = kitStatus(); if (s) s.textContent = msg; }
function kitResizeCanvas() { const cv = kitCanvas(); if (!cv) return; const p = cv.parentElement; cv.width = p.clientWidth; cv.height = p.clientHeight; }
function kitClose() { document.getElementById('kitchen-overlay').style.display = 'none'; kitOpen = false; kitHeld = null; kitSel = null; }

// ── PDF Export ────────────────────────────────────────────────────────
async function kitExportPDF() {
    const jsPDFLib = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!jsPDFLib) { alert('jsPDF not loaded.'); return; }
    if (!kitPieces.length) { alert('No pieces to export.'); return; }

    const SC = 8, padPx = 40;
    // Bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < kitPieces.length; i++) {
        const lp = kitLayout[i], {w:pw, h:ph} = kitGetWH(i);
        minX = Math.min(minX, lp.x); minY = Math.min(minY, lp.y);
        maxX = Math.max(maxX, lp.x + pw); maxY = Math.max(maxY, lp.y + ph);
    }
    for (const lb of kitLabels) {
        minX = Math.min(minX, lb.x); minY = Math.min(minY, lb.y);
        maxX = Math.max(maxX, lb.x + 10); maxY = Math.max(maxY, lb.y + 2);
    }
    const bW = maxX - minX, bH = maxY - minY;
    const offW = Math.ceil(bW * SC + padPx * 2), offH = Math.ceil(bH * SC + padPx * 2);
    const off = document.createElement('canvas'); off.width = offW; off.height = offH;
    const octx = off.getContext('2d');

    // Background + grid (matches canvas bg color)
    octx.fillStyle = kitBgColor; octx.fillRect(0, 0, offW, offH);
    const pdfBgDark = parseInt(kitBgColor.slice(1,3),16) < 128;
    octx.strokeStyle = pdfBgDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'; octx.lineWidth = 0.5;
    const gsc = SC * 6;
    for (let x = padPx % gsc; x < offW; x += gsc) { octx.beginPath(); octx.moveTo(x, 0); octx.lineTo(x, offH); octx.stroke(); }
    for (let y = padPx % gsc; y < offH; y += gsc) { octx.beginPath(); octx.moveTo(0, y); octx.lineTo(offW, y); octx.stroke(); }

    for (let i = 0; i < kitPieces.length; i++) {
        const kp = kitPieces[i], lp = kitLayout[i], lr = lp.rot;
        const {w:pw, h:ph} = kitGetWH(i);
        const cx = padPx + (lp.x - minX) * SC, cy = padPx + (lp.y - minY) * SC;
        const drawW = pw * SC, drawH = ph * SC;
        const origW = kp.wi * SC, origH = kp.hi * SC;

        octx.save();
        octx.translate(cx + drawW / 2, cy + drawH / 2);
        octx.rotate(lr * Math.PI / 2);
        octx.drawImage(kp.imgCanvas, -origW / 2, -origH / 2, origW, origH);
        octx.restore();

        // Label only (no outline)
        octx.save();
        octx.font = `bold ${Math.max(12, Math.min(22, ph * SC * 0.2))}px sans-serif`;
        octx.textAlign = 'center'; octx.textBaseline = 'middle';
        octx.shadowColor = 'rgba(0,0,0,0.9)'; octx.shadowBlur = 6; octx.fillStyle = '#fff';
        octx.fillText(kp.label, cx + drawW / 2, cy + drawH / 2);
        octx.shadowBlur = 0; octx.restore();
    }

    // Draw text labels on PDF canvas
    for (const lb of kitLabels) {
        const lx = padPx + (lb.x - minX) * SC;
        const ly = padPx + (lb.y - minY) * SC;
        const fs = Math.max(12, 14 * (SC / 6));
        octx.save();
        octx.font = `bold ${fs}px sans-serif`;
        octx.textAlign = 'left'; octx.textBaseline = 'top';
        const tw = octx.measureText(lb.text).width + 8;
        const th = fs + 8;
        octx.fillStyle = 'rgba(45,58,16,0.15)';
        octx.beginPath(); octx.roundRect(lx - 4, ly - 4, tw, th, 4); octx.fill();
        octx.fillStyle = '#2d3a10';
        octx.fillText(lb.text, lx, ly);
        octx.restore();
    }

    const doc = new jsPDFLib({ unit: 'pt', format: 'letter' });
    const PW = 612, PH = 792, ML = 45, MR = 45, CW = PW - ML - MR, FOOTER_H = 54;
    const BRAND = [45, 58, 16], ACCENT = [176, 144, 48];
    doc.setFillColor(...BRAND); doc.rect(0, 0, PW, 70, 'F');
    doc.setFillColor(...ACCENT); doc.rect(0, 68, PW, 2.5, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(255, 255, 255);
    doc.text('SPARTAN', ML + 58, 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...ACCENT);
    doc.text('Stone Simulation — Kitchen Layout', ML + 58, 48);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(255, 255, 255);
    doc.text(`Quote #: ${formData.order || '—'}`, PW - MR, 30, { align: 'right' });
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...ACCENT);
    doc.text(`Date: ${formData.date || todayStr()}`, PW - MR, 48, { align: 'right' });
    doc.setDrawColor(...BRAND); doc.setLineWidth(0.6); doc.line(ML, PH - FOOTER_H, PW - MR, PH - FOOTER_H);
    doc.setFillColor(245, 244, 240); doc.rect(0, PH - FOOTER_H + 1, PW, FOOTER_H, 'F');
    doc.setFont('helvetica', 'italic'); doc.setFontSize(7.5); doc.setTextColor(120, 120, 120);
    doc.text('SIMULATION ONLY — Stone placement is manual and for visualization purposes. Actual results may vary.', PW / 2, PH - 34, { align: 'center' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7.5); doc.setTextColor(...BRAND);
    doc.text('SPARTAN', PW / 2, PH - 19, { align: 'center' });

    let y = 84;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
    const dTxt = 'SIMULATION ONLY - Manual stone arrangement. Actual stone appearance, grain, and piece fit may vary.';
    const dLines = doc.splitTextToSize('** ' + dTxt, CW - 16);
    const bxH = dLines.length * 10 + 10;
    doc.setFillColor(240, 238, 232); doc.rect(ML, y, CW, bxH, 'F');
    doc.setDrawColor(180, 180, 180); doc.setLineWidth(1); doc.rect(ML, y, CW, bxH, 'S');
    doc.setTextColor(80, 80, 80); dLines.forEach((ln, li) => doc.text(ln, ML + 8, y + 9 + li * 10));
    y += bxH + 8;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...BRAND);
    doc.text(`STONE SIMULATION — ${formData.client || 'Client'}`, ML, y);
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.75); doc.line(ML, y + 3, PW - MR, y + 3); y += 15;
    const imgData = off.toDataURL('image/jpeg', 0.93);
    const maxH = PH - FOOTER_H - y - 20;
    const sc2 = Math.min(CW / offW, maxH / offH);
    doc.addImage(imgData, 'JPEG', ML + (CW - offW * sc2) / 2, y, offW * sc2, offH * sc2);
    const fname = `SI-${pdfBaseName()}_Kitchen.pdf`;
    doc.save(fname);
}

// ── Add text label ────────────────────────────────────────────────────
function kitAddLabel() {
    const inp = document.getElementById('kit-text-input');
    const text = (inp.value || '').trim();
    if (!text) return;
    // Place near center of current view
    const cv = kitCanvas();
    const cx = cv ? (cv.width / 2 - kitOX) / kitSc : 20;
    const cy = cv ? (cv.height / 2 - kitOY) / kitSc : 20;
    kitLabels.push({ text, x: cx, y: cy });
    inp.value = '';
    kitSelLabel = kitLabels.length - 1; kitSel = null;
    kitUpdateRotBtn(); kitRefreshList(); kitRender();
    kitSetStatus(`Label "${text}" added. Drag to position.`);
}

// ══════════════════════════════════════════════════════════════════════
// Wire events
// ══════════════════════════════════════════════════════════════════════
document.getElementById('kitchen-lock-btn').addEventListener('click', kitLockAll);
document.getElementById('kit-add-text-btn').addEventListener('click', kitAddLabel);
document.getElementById('kit-bg-sel').addEventListener('change', e => { kitBgColor = e.target.value; kitRender(); });
document.getElementById('kit-close-btn').addEventListener('click', kitClose);
document.getElementById('kit-clear-btn').addEventListener('click', () => {
    // Re-auto-arrange
    let autoX = 4, autoY = 4;
    for (let i = 0; i < kitPieces.length; i++) {
        const kp = kitPieces[i];
        kitLayout[i] = { x: autoX, y: autoY, rot: 0 };
        autoX += kp.wi + 3;
        if (autoX > 100) { autoX = 4; autoY += kp.hi + 3; }
    }
    kitSel = null; kitHeld = null; kitLabels = []; kitSelLabel = null; kitHeldLabel = null;
    kitUpdateRotBtn(); kitRefreshList(); kitRender();
    kitSetStatus('Layout reset. Pieces auto-arranged.');
});
document.getElementById('kit-rotate-btn').addEventListener('click', kitRotateSel);
document.getElementById('kit-export-btn').addEventListener('click', kitExportPDF);

const cv = document.getElementById('kit-canvas');
if (cv) {
    cv.addEventListener('mousemove', onKitMouseMove);
    cv.addEventListener('mousedown', onKitMouseDown);
    cv.addEventListener('mouseup', onKitMouseUp);
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('wheel', onKitWheel, { passive: false });
}
window.addEventListener('keydown', e => {
    if (!kitOpen) return;
    const inInput = e.target.closest('input,textarea,select');
    if ((e.key === 'r' || e.key === 'R') && !inInput) kitRotateSel();
    if (e.key === 'Escape') {
        if (kitHeld !== null) { kitHeld = null; kitRender(); }
        else if (kitHeldLabel !== null) { kitHeldLabel = null; kitRender(); }
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !inInput && kitSelLabel !== null) {
        kitLabels.splice(kitSelLabel, 1);
        kitSelLabel = null;
        kitRefreshList(); kitRender();
        kitSetStatus('Label deleted.');
    }
    if (e.key === 'Enter' && e.target.id === 'kit-text-input') {
        kitAddLabel();
    }
});
window.addEventListener('resize', () => { if (kitOpen) { kitResizeCanvas(); kitRender(); } });
})();

// ─────────────────────────────────────────────────────────────
//  initApp — called by Clerk after auth + Supabase pull
// ─────────────────────────────────────────────────────────────
function initApp() {
    _initSession();
    load();
    loadMatDb();   // Load material catalog FIRST so brand/color dropdowns render with options
    loadForm();
    loadPricing();
    applyCostsLockState();   // start locked
    // Compute _nextPageId from loaded pages
    _nextPageId = Math.max(...pages.map(p => p.id), 1) + 1;
    renderPageTabs();
    document.getElementById('pg-add').addEventListener('click', addPage);
    drawRulerCorner(); drawRulerH(); drawRulerV();
    render(); updateStatus();
}
