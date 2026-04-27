/* ============================================================================
   Spartan — Getting Started Manual Builder
   ----------------------------------------------------------------------------
   Activates when the URL has ?manual=1. Adds a floating "Generate Manual"
   button. Clicking it drives the app through the Marie Tremblay scenario,
   captures a screenshot at each step, and downloads a single PDF training
   manual.

   Notes:
   - Runs entirely in the browser. No server-side automation.
   - Direct state mutation for reproducibility (skips UI clicks where useful).
   - Stubs Supabase saves so the run leaves no trace in the production DB.
   - Loads html2canvas from CDN for full-page screenshots.
   ============================================================================ */
(function () {
    if (!new URLSearchParams(location.search).has('manual')) return;

    // --------------------------------------------------------------- bootstrap
    const H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src; s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

    // Wait for the app to finish loading (Clerk + Supabase + initial render)
    function waitForApp() {
        return new Promise(resolve => {
            const tick = () => {
                if (typeof shapes !== 'undefined' &&
                    typeof pages  !== 'undefined' &&
                    typeof render === 'function' &&
                    typeof setTool === 'function' &&
                    document.getElementById('mainCanvas')) {
                    resolve();
                } else {
                    setTimeout(tick, 200);
                }
            };
            tick();
        });
    }

    // ----------------------------------------------------------------- styles
    const CSS = `
        #manual-fab {
            position: fixed; bottom: 22px; right: 22px; z-index: 99998;
            background: #2d3a10; color: #fff; border: 2px solid #b09030;
            border-radius: 999px; padding: 12px 22px; font: 700 13px/1 Raleway, sans-serif;
            letter-spacing: 1px; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,0.5);
        }
        #manual-fab:hover { background: #3a4a16; }
        #manual-status {
            position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
            z-index: 99999; background: #1a1a1a; color: #e0ddd5; border: 2px solid #b09030;
            border-radius: 10px; padding: 22px 30px; font: 600 13px/1.5 Raleway, sans-serif;
            min-width: 360px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.7);
            display: none;
        }
        #manual-status .ms-title { font-size: 15px; color: #b09030; margin-bottom: 8px; letter-spacing: 1px; }
        #manual-status .ms-bar  { height: 6px; background: #333; border-radius: 3px; margin-top: 14px; overflow: hidden; }
        #manual-status .ms-bar > span { display: block; height: 100%; background: #b09030; transition: width 0.25s; width: 0; }
        .manual-callout {
            position: fixed; z-index: 99997; pointer-events: none;
            background: #cc2222; color: #fff; padding: 6px 12px; border-radius: 4px;
            font: 700 12px/1 Raleway, sans-serif; letter-spacing: 0.5px;
            box-shadow: 0 4px 14px rgba(0,0,0,0.5);
        }
        .manual-callout::after {
            content: ''; position: absolute; left: -9px; top: 50%; transform: translateY(-50%);
            border: 6px solid transparent; border-right-color: #cc2222;
        }
    `;
    function injectCSS() {
        const s = document.createElement('style');
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    // -------------------------------------------------------- status overlay
    let statusEl;
    function showStatus(title, msg, pct) {
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.id = 'manual-status';
            statusEl.innerHTML = `<div class="ms-title"></div><div class="ms-msg"></div><div class="ms-bar"><span></span></div>`;
            document.body.appendChild(statusEl);
        }
        statusEl.style.display = 'block';
        statusEl.querySelector('.ms-title').textContent = title;
        statusEl.querySelector('.ms-msg').textContent = msg;
        statusEl.querySelector('.ms-bar > span').style.width = (pct || 0) + '%';
    }
    function hideStatus() { if (statusEl) statusEl.style.display = 'none'; }

    // ------------------------------------------------------- state stubs
    // Disable Supabase syncing so the manual run doesn't pollute production data.
    function stubPersistence() {
        if (typeof window.scheduleSyncToRemote === 'function') {
            window.scheduleSyncToRemote = () => {};
        }
        if (typeof window.saveQuoteToDb === 'function') {
            window.saveQuoteToDb = async () => ({ ok: true });
        }
    }

    // --------------------------------------------------- scenario seed helpers
    // 4 px = 1 inch in this app
    const INCH = 4;

    function clearScene() {
        // Reset to a single fresh page
        pages.length = 0;
        pages.push({ id: 1, name: 'Page 1', shapes: [], textItems: [], measurements: [], nextId: 1, _undo: [] });
        currentPageIdx = 0;
        if (typeof syncPageOut === 'function') syncPageOut();
        if (typeof syncPageIn  === 'function') syncPageIn();
        shapes = pages[0].shapes;
        nextId = 1;
        selected = null; selectedJoint = null; selectedText = null; selectedMeasure = null;
        if (typeof setTool === 'function') setTool('select');
        if (typeof renderPageTabs === 'function') renderPageTabs();
        render();
    }

    function syncPagesFromShapes() {
        if (typeof syncPageOut === 'function') syncPageOut();
    }

    function addRect(opts) {
        const s = {
            id: nextId++, shapeType: 'rect',
            x: opts.x, y: opts.y, w: opts.w, h: opts.h,
            label: opts.label || '',
            edges: opts.edges || {},
            checks: [], joints: [], polishUnders: [],
            hideDims: {},
        };
        shapes.push(s);
        syncPagesFromShapes();
        return s;
    }

    function addLShape(opts) {
        const s = {
            id: nextId++, shapeType: 'l',
            x: opts.x, y: opts.y, w: opts.w, h: opts.h,
            notchCorner: opts.notchCorner || 'ne',
            notchW: opts.notchW, notchH: opts.notchH,
            label: opts.label || '',
            edges: opts.edges || {},
            checks: [], joints: [], polishUnders: [],
            hideDims: {},
        };
        shapes.push(s);
        syncPagesFromShapes();
        return s;
    }

    function addJoint(parentShape, jointObj) {
        parentShape.joints = parentShape.joints || [];
        parentShape.joints.push(jointObj);
        syncPagesFromShapes();
    }

    function addSubtypeOnParent(parent, subtype, w, h, opts) {
        opts = opts || {};
        // Center the subtype inside the parent unless overridden.
        const cx = (opts.cx != null) ? opts.cx : parent.x + parent.w / 2;
        const cy = (opts.cy != null) ? opts.cy : parent.y + parent.h / 2;
        const s = {
            id: nextId++, shapeType: 'rect', subtype,
            x: cx - w / 2, y: cy - h / 2, w, h,
            parentId: parent.id,
            label: opts.label || '',
            checks: [], joints: [], polishUnders: [],
            hideDims: {}, edges: {},
            rotation: opts.rotation || 0,
        };
        if (subtype === 'farmsink') {
            s.farmSink = true;
        }
        shapes.push(s);
        syncPagesFromShapes();
        return s;
    }

    function addPageManual(name) {
        if (typeof addPage === 'function') addPage();
        // The new page is appended; switch to it
        currentPageIdx = pages.length - 1;
        pages[currentPageIdx].name = name;
        if (typeof syncPageIn === 'function') syncPageIn();
        shapes = pages[currentPageIdx].shapes;
        nextId = pages[currentPageIdx].nextId || 1;
        if (typeof renderPageTabs === 'function') renderPageTabs();
        render();
    }

    function gotoPage(idx) {
        if (typeof switchPage === 'function') switchPage(idx);
        else { currentPageIdx = idx; render(); }
    }

    function setTab(which) {
        // which: 'layout' (Quote form) | 'slab' (Canvas) | 'pricing' | 'costs' | 'registry'
        if (typeof switchPanelTab === 'function') switchPanelTab(which);
    }

    function setVal(id, v) {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ------------------------------------------------------- callout overlays
    let activeCallouts = [];
    function callout(text, x, y) {
        const el = document.createElement('div');
        el.className = 'manual-callout';
        el.textContent = text;
        el.style.left = x + 'px';
        el.style.top = y + 'px';
        document.body.appendChild(el);
        activeCallouts.push(el);
    }
    function calloutOn(elem, text, dx = 14, dy = 0) {
        if (!elem) return;
        const r = elem.getBoundingClientRect();
        callout(text, r.right + dx, r.top + r.height / 2 - 14 + dy);
    }
    function clearCallouts() {
        activeCallouts.forEach(el => el.remove());
        activeCallouts = [];
    }

    // --------------------------------------------------------------- capture
    async function captureScreen() {
        const opts = {
            scale: 1.25,
            backgroundColor: '#1a1a1a',
            logging: false,
            useCORS: true,
            windowWidth: document.documentElement.scrollWidth,
            windowHeight: document.documentElement.scrollHeight,
        };
        const c = await window.html2canvas(document.body, opts);
        return c.toDataURL('image/jpeg', 0.85);
    }

    // ------------------------------------------------------------- scenarios
    function buildScenes() {
        return [
            // --------- Section A: Setup -----------------------------------
            {
                title: '1. Quotes Database — your starting point',
                caption: 'Every Spartan session opens here. The Quotes DB tab lists every saved quote for your shop. Click "+ New Quote" to start a fresh project for Marie Tremblay.',
                hotkey: '',
                setup: async () => {
                    stubPersistence();
                    clearScene();
                    setTab('registry');
                    await wait(300);
                    const newBtn = document.getElementById('reg-new-btn');
                    if (newBtn) calloutOn(newBtn, 'Start here →', 14, 0);
                },
            },
            {
                title: '2. The Quote tab — Job Details',
                caption: 'After clicking New Quote you land on the Quote tab. The top section captures Job Details: order number, sales rep, client, address, phone, and date.',
                hotkey: '',
                setup: async () => {
                    setTab('layout');
                    await wait(300);
                    const form = document.getElementById('layout-panel');
                    if (form) form.scrollTop = 0;
                    const lbl = document.querySelector('#layout-panel h2');
                    if (lbl) calloutOn(lbl, 'Fill these first', 14, 0);
                },
            },
            {
                title: '3. Filling in the client',
                caption: 'For this walkthrough we use Marie Tremblay at 1234 Boul. St-Laurent, Montréal. Type into each field — your input autosaves as you go.',
                hotkey: '',
                setup: async () => {
                    setTab('layout');
                    setVal('f-order', '2026-001');
                    setVal('f-job',   'Joseph');
                    setVal('f-client','Marie Tremblay');
                    setVal('f-address','1234 Boul. St-Laurent, Montréal');
                    const today = new Date(); const iso = today.toISOString().slice(0,10);
                    setVal('f-date', iso);
                    await wait(300);
                    const cli = document.getElementById('f-client');
                    if (cli) calloutOn(cli, 'Marie Tremblay', 14, 0);
                },
            },
            {
                title: '4. Switching to the Layout (drawing) tab',
                caption: 'Click the "Layout" tab to open the drawing canvas. This is where you sketch every piece of countertop in the project.',
                hotkey: 'Hotkey: S = Select tool · R = Rectangle tool · Esc cancels any active tool',
                setup: async () => {
                    setTab('slab');
                    await wait(300);
                    const tab = document.getElementById('ptab-slab');
                    if (tab) calloutOn(tab, 'Layout tab', 14, 0);
                },
            },
            // --------- Section B: Drawing the kitchen L-shape -------------
            {
                title: '5. Naming the first page',
                caption: 'Every project can have multiple pages — typically one per room. Double-click the page tab to rename it. We rename Page 1 to "Kitchen".',
                hotkey: '',
                setup: async () => {
                    setTab('slab');
                    pages[0].name = 'Kitchen';
                    if (typeof renderPageTabs === 'function') renderPageTabs();
                    await wait(200);
                    const tab = document.querySelector('.pg-tab.active .pg-tab-name');
                    if (tab) calloutOn(tab, 'Double-click to rename', 14, -8);
                },
            },
            {
                title: '6. The toolbar at a glance',
                caption: 'Top row draws shapes (Rectangle, L, U, Backsplash, Circle). The middle row adds details (Radius, Edge Profile, Joint, Check, Polish-Under, Text, Mesure). The right group places fixtures (Sink, Farm Sink, Cooktop, Outlet, Bocci).',
                hotkey: 'Hotkeys: R = Rectangle · S = Select · Del = Delete selected · Ctrl+Z = Undo · Esc = Cancel any tool',
                setup: async () => {
                    setTab('slab');
                    await wait(150);
                    const drawBtn = document.getElementById('btn-draw');
                    if (drawBtn) calloutOn(drawBtn, 'Shapes start here', 14, -8);
                },
            },
            {
                title: '7. Choosing the L-Shape tool',
                caption: 'Marie\'s kitchen is L-shaped. Click "⌐ L-Shape" in the toolbar to arm the tool, then drag a rectangle on the canvas — Spartan will turn it into an L with an adjustable inner corner.',
                hotkey: '',
                setup: async () => {
                    setTab('slab');
                    setTool('ldraw');
                    await wait(200);
                    const ld = document.getElementById('btn-ldraw');
                    if (ld) calloutOn(ld, 'Click — tool armed', 14, -8);
                },
            },
            {
                title: '8. The kitchen L-shape, drawn',
                caption: 'Drag from the top-left corner of where the kitchen sits. Release and Spartan creates a full L-shape with default 96"×72" outer dimensions. You can grab any side to resize after.',
                hotkey: '',
                setup: async () => {
                    clearScene();
                    pages[0].name = 'Kitchen';
                    const Lx = 6 * INCH * 12, Ly = 6 * INCH * 12; // 6 ft margins
                    const L = addLShape({
                        x: Lx, y: Ly,
                        w: 96 * INCH, h: 72 * INCH,
                        notchCorner: 'ne',
                        notchW: 60 * INCH, notchH: 36 * INCH,
                        label: 'Kitchen L',
                    });
                    selected = L.id;
                    setTool('select');
                    if (typeof renderPageTabs === 'function') renderPageTabs();
                    render();
                    await wait(250);
                },
            },
            {
                title: '9. Using the Select tool',
                caption: 'Press S (or click "↖ Select") to leave drawing mode. With Select active you can click any piece to highlight it, drag to move, or grab the corner squares to resize.',
                hotkey: 'Hotkey: S = Select · Arrow keys nudge selection · Del removes it',
                setup: async () => {
                    setTool('select');
                    selected = shapes[0]?.id || null;
                    render();
                    await wait(200);
                    const sb = document.getElementById('btn-select');
                    if (sb) calloutOn(sb, 'Select tool', 14, -8);
                },
            },
            {
                title: '10. Adding a joint',
                caption: 'Slabs come in finite sizes, so most kitchens need a joint. Click "⋮ Joint", then click inside the L where you want the seam. A popup confirms vertical or horizontal — pick the orientation that runs across the narrower leg.',
                hotkey: '',
                setup: async () => {
                    const L = shapes[0];
                    addJoint(L, { id: 1, kind: 'rect', orientation: 'v', x: L.x + 36 * INCH });
                    setTool('select');
                    selected = L.id;
                    render();
                    await wait(200);
                    const jb = document.getElementById('btn-joint');
                    if (jb) calloutOn(jb, 'Joint tool', 14, -8);
                },
            },
            {
                title: '11. Edge profile palette',
                caption: 'The strip below the toolbar is the Active Profile palette. Pick a profile (PEN, OGE, BN, HBN, BEV, MT, SF, WF, JT) — then any edge you click becomes that profile. ✕ None clears a profile.',
                hotkey: '',
                setup: async () => {
                    setTool('edge');
                    if (typeof activeEdgeType !== 'undefined') {
                        window.activeEdgeType = 'bullnose';
                        document.querySelectorAll('.ep-btn').forEach(b => b.classList.toggle('ep-active', b.dataset.etype === 'bullnose'));
                    }
                    render();
                    await wait(200);
                    const palette = document.getElementById('edge-palette');
                    if (palette) calloutOn(palette, 'Pick → click edge', 14, -8);
                },
            },
            {
                title: '12. Assigning the bullnose profile',
                caption: 'With Bullnose (BN) active, click each visible front edge of the kitchen. A coloured letter ("B") appears along the line so a black-and-white printout still shows the profile clearly.',
                hotkey: '',
                setup: async () => {
                    const L = shapes[0];
                    L.edges = L.edges || {};
                    // Top + Right outer edges = bullnose
                    L.edges['top']        = 'bullnose';
                    L.edges['right']      = 'bullnose';
                    L.edges['bottom']     = 'bullnose';
                    L.edges['inner_h']    = 'bullnose';
                    L.edges['inner_v']    = 'bullnose';
                    setTool('select');
                    selected = L.id;
                    render();
                    await wait(200);
                },
            },
            // --------- Section C: Farmhouse sink in the kitchen ----------
            {
                title: '13. Placing a farmhouse sink',
                caption: 'Click "⊔ Farm Sink". A green banner appears: "Click to add Farm Sink". Click anywhere on the kitchen L — Spartan locks the 30"×16" cutout to that piece. Press Esc to cancel.',
                hotkey: 'Hotkey: Esc cancels the placement banner',
                setup: async () => {
                    setTool('farmsink');
                    // Show the prompt banner manually
                    const p = document.getElementById('tool-prompt');
                    if (p) {
                        p.textContent = 'Click to add Farm Sink';
                        p.style.display = 'block';
                    }
                    render();
                    await wait(250);
                },
            },
            {
                title: '14. Farmhouse sink placed inside the L',
                caption: 'The farmhouse sink lives inside its parent piece. If you delete the kitchen, the sink is removed with it. Drag the sink to reposition; it can\'t be resized (its size is fixed by the model).',
                hotkey: '',
                setup: async () => {
                    const p = document.getElementById('tool-prompt');
                    if (p) p.style.display = 'none';
                    const L = shapes[0];
                    addSubtypeOnParent(L, 'sink_undermount', 30 * INCH, 16 * INCH, {
                        cx: L.x + 18 * INCH, cy: L.y + 36 * INCH,
                        label: 'Farmhouse',
                    }).farmSink = true;
                    setTool('select');
                    render();
                    await wait(200);
                },
            },
            // --------- Section D: Vanity page ----------------------------
            {
                title: '15. Adding a second page',
                caption: 'Click the "+" button at the right end of the page tabs to start a second page. Spartan creates "Page 2" and switches to it automatically.',
                hotkey: '',
                setup: async () => {
                    addPageManual('Page 2');
                    await wait(200);
                    const addBtn = document.getElementById('pg-add');
                    if (addBtn) calloutOn(addBtn, 'Add page', 14, -8);
                },
            },
            {
                title: '16. Renaming a page — double-click the tab',
                caption: 'Double-click the page name to edit it inline. Type "Vanity" and press Enter. Renaming pages keeps your project organised and the page name appears on every PDF page header.',
                hotkey: 'Hotkey: Enter saves the new name · Esc reverts',
                setup: async () => {
                    pages[currentPageIdx].name = 'Vanity';
                    if (typeof renderPageTabs === 'function') renderPageTabs();
                    await wait(200);
                    const t = document.querySelector('.pg-tab.active .pg-tab-name');
                    if (t) calloutOn(t, 'Double-click to rename', 14, -8);
                },
            },
            {
                title: '17. Drawing the vanity rectangle',
                caption: 'A vanity is a simple rectangle. With "▭ Rectangle" armed (or press R), drag from upper-left to lower-right to set its size — typically 60"×22" for a double vanity.',
                hotkey: 'Hotkey: R = Rectangle tool',
                setup: async () => {
                    pages[currentPageIdx].shapes.length = 0;
                    pages[currentPageIdx].nextId = 1;
                    shapes = pages[currentPageIdx].shapes;
                    nextId = 1;
                    const V = addRect({
                        x: 8 * INCH * 12, y: 6 * INCH * 12,
                        w: 60 * INCH, h: 22 * INCH,
                        label: 'Vanity Top',
                        edges: { top: 'bullnose', right: 'bullnose', bottom: 'bullnose', left: 'bullnose' },
                    });
                    selected = V.id;
                    setTool('select');
                    render();
                    await wait(250);
                },
            },
            {
                title: '18. Placing an undermount sink',
                caption: 'Click "⬜ Sink" → choose "Undermount" in the popup → click the vanity rectangle. The sink is locked to the vanity and shows in light green.',
                hotkey: '',
                setup: async () => {
                    const V = shapes[0];
                    addSubtypeOnParent(V, 'sink_undermount', 18 * INCH, 12 * INCH, {
                        cx: V.x + V.w / 2, cy: V.y + V.h / 2,
                        label: 'Undermount',
                    });
                    setTool('select');
                    render();
                    await wait(200);
                },
            },
            // --------- Section E: Materials --------------------------------
            {
                title: '19. Back to the Quote tab → Materials',
                caption: 'Click the Quote tab. Scroll to "Materials". Each material row links a slab choice to a specific page (or a custom group), so the kitchen and vanity can use different stones.',
                hotkey: '',
                setup: async () => {
                    setTab('layout');
                    await wait(200);
                    const layoutPanel = document.getElementById('layout-panel');
                    if (layoutPanel) {
                        const matH = [...layoutPanel.querySelectorAll('h2')].find(h => /materials/i.test(h.textContent));
                        if (matH) {
                            matH.scrollIntoView({ behavior: 'auto', block: 'center' });
                            calloutOn(matH, 'Materials section', 14, 0);
                        }
                    }
                },
            },
            {
                title: '20. Material #1 — Silestone Calacatta Gold (Kitchen, 2 cm)',
                caption: 'Click "+ Add Material". Pick the Kitchen page, brand Silestone, color Calacatta Gold, thickness 2 cm. The price-per-square-foot fills automatically from your shop\'s material database.',
                hotkey: '',
                setup: async () => {
                    if (window.formData && Array.isArray(window.formData.materials)) {
                        window.formData.materials.length = 0;
                        window.formData.materials.push({
                            type: 'page', pageId: 1, label: 'Kitchen',
                            brand: 'Silestone', color: 'Calacatta Gold', thickness: '2cm',
                            ppsf: 95,
                        });
                        if (typeof renderMaterials === 'function') renderMaterials();
                        if (typeof saveForm === 'function') saveForm();
                    }
                    await wait(200);
                    const row = document.querySelector('#mat-rows .mat-row');
                    if (row) calloutOn(row, 'Kitchen material', 14, 0);
                },
            },
            {
                title: '21. Material #2 — Caesarstone Pure White (Vanity, 2 cm)',
                caption: 'Click "+ Add Material" again. Pick the Vanity page, brand Caesarstone, color Pure White, thickness 2 cm. Each page keeps its own material assignment so pricing and PDFs split correctly.',
                hotkey: '',
                setup: async () => {
                    if (window.formData && Array.isArray(window.formData.materials)) {
                        window.formData.materials.push({
                            type: 'page', pageId: 2, label: 'Vanity',
                            brand: 'Caesarstone', color: 'Pure White', thickness: '2cm',
                            ppsf: 78,
                        });
                        if (typeof renderMaterials === 'function') renderMaterials();
                        if (typeof saveForm === 'function') saveForm();
                    }
                    await wait(200);
                    const rows = document.querySelectorAll('#mat-rows .mat-row');
                    if (rows.length >= 2) calloutOn(rows[1], 'Vanity material', 14, 0);
                },
            },
            // --------- Section F: Pricing & Costs --------------------------
            {
                title: '22. Pricing tab — square footage and edge totals',
                caption: 'Click the "Pricing" tab. Spartan totals every piece by page, sums the linear feet of each edge profile, and applies your shop\'s rates to produce a customer-facing price.',
                hotkey: '',
                setup: async () => {
                    setTab('pricing');
                    await wait(300);
                },
            },
            {
                title: '23. Costs tab — internal cost breakdown',
                caption: 'The Costs tab is for the shop only. It shows raw material cost, labour, edge time, and margins so you know whether the proposal is profitable before sending it.',
                hotkey: '',
                setup: async () => {
                    setTab('costs');
                    await wait(300);
                },
            },
            // --------- Section G: Save & Export ----------------------------
            {
                title: '24. Saving the quote',
                caption: 'Spartan autosaves every 8 seconds, but you can force a save with the "💾 Save Quote" button on the Quote tab. A toast confirms the save.',
                hotkey: '',
                setup: async () => {
                    setTab('layout');
                    await wait(200);
                    const sb = document.getElementById('btn-save-quote');
                    if (sb) {
                        sb.scrollIntoView({ behavior: 'auto', block: 'center' });
                        calloutOn(sb, 'Click to save', 14, 0);
                    }
                },
            },
            {
                title: '25. The quote in your Quotes Database',
                caption: 'Reopen the Quotes DB tab and Marie Tremblay appears at the top of the list with the date, client, and status. Click any row to reopen and continue editing.',
                hotkey: '',
                setup: async () => {
                    clearCallouts();
                    setTab('registry');
                    await wait(400);
                },
            },
            {
                title: '26. Exporting the Internal Plans PDF',
                caption: 'Back on the Quote tab, click "📄 Export PDF (Internal)". Spartan generates a multi-page PDF — one page per layout page — with full dimensions, edge legend, joint marks, and a Cutouts box.',
                hotkey: '',
                setup: async () => {
                    setTab('layout');
                    await wait(200);
                    const ep = document.getElementById('btn-export-pdf');
                    if (ep) {
                        ep.scrollIntoView({ behavior: 'auto', block: 'center' });
                        calloutOn(ep, 'Internal Plans PDF', 14, 0);
                    }
                },
            },
            {
                title: '27. The Internal PDF — page 1 (Kitchen)',
                caption: 'Page 1 shows the kitchen L-shape: outer dimensions, joint, farmhouse sink with cutout dimensions, every edge profile labelled, and the edge legend in the corner.',
                hotkey: '',
                setup: async () => {
                    setTab('slab');
                    gotoPage(0);
                    selected = null;
                    render();
                    await wait(300);
                },
            },
            {
                title: '28. The Internal PDF — page 2 (Vanity)',
                caption: 'Page 2 shows the vanity rectangle with the undermount sink, dimensions, and the second material call-out. Each PDF page header carries the page name you chose ("Vanity").',
                hotkey: '',
                setup: async () => {
                    setTab('slab');
                    gotoPage(1);
                    selected = null;
                    render();
                    await wait(300);
                },
            },
            {
                title: '29. Generating the Client Quote PDF',
                caption: 'Click "📋 Generate Proposal" to produce the customer-facing quote: itemised pricing, materials, deposit, terms — no internal cost. This is the document Marie Tremblay receives by email.',
                hotkey: '',
                setup: async () => {
                    setTab('pricing');
                    await wait(250);
                    const gp = document.getElementById('btn-gen-proposal');
                    if (gp) {
                        gp.scrollIntoView({ behavior: 'auto', block: 'center' });
                        calloutOn(gp, 'Client Proposal PDF', 14, 0);
                    }
                },
            },
            {
                title: '30. Hotkeys cheat sheet',
                caption: 'Memorise these — they cut the most time off everyday work. Esc is the universal "get me out of here". S returns to Select. R arms Rectangle. Del removes the selection. Ctrl+Z reverses the last change.',
                hotkey: '',
                setup: async () => {
                    setTab('slab');
                    selected = null;
                    setTool('select');
                    render();
                    await wait(200);
                },
            },
        ];
    }

    // --------------------------------------------------------------- pdf gen
    function buildPDF(scenes, screenshots) {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
        const PW = 612, PH = 792;
        const M  = 36; // margin

        // ----- Cover page ------------------------------------------------
        doc.setFillColor(26, 26, 26);
        doc.rect(0, 0, PW, PH, 'F');
        doc.setTextColor(176, 144, 48);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(40);
        doc.text('SPARTAN', PW / 2, 240, { align: 'center' });
        doc.setFontSize(11);
        doc.setTextColor(170, 170, 170);
        doc.text('I N S T A L L A T I O N S', PW / 2, 264, { align: 'center' });
        doc.setTextColor(224, 221, 213);
        doc.setFontSize(22);
        doc.setFont('helvetica', 'normal');
        doc.text('Getting Started Manual', PW / 2, 360, { align: 'center' });
        doc.setFontSize(12);
        doc.setTextColor(160, 160, 160);
        doc.text('A 30-step walkthrough using the Marie Tremblay project', PW / 2, 386, { align: 'center' });
        doc.setFontSize(10);
        doc.text(new Date().toLocaleDateString(), PW / 2, 720, { align: 'center' });

        // ----- Scene pages -----------------------------------------------
        scenes.forEach((scene, i) => {
            doc.addPage();
            // Background
            doc.setFillColor(255, 255, 255);
            doc.rect(0, 0, PW, PH, 'F');
            // Header band
            doc.setFillColor(26, 26, 26);
            doc.rect(0, 0, PW, 56, 'F');
            doc.setTextColor(176, 144, 48);
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(9);
            doc.text('SPARTAN — GETTING STARTED', M, 22);
            doc.setTextColor(224, 221, 213);
            doc.setFontSize(14);
            doc.text(scene.title, M, 44);

            // Screenshot
            const img = screenshots[i];
            const maxW = PW - 2 * M;
            const maxH = PH - 56 - 180; // leave room for caption
            try {
                const props = doc.getImageProperties(img);
                let w = maxW;
                let h = w * props.height / props.width;
                if (h > maxH) {
                    h = maxH;
                    w = h * props.width / props.height;
                }
                const x = (PW - w) / 2;
                const y = 80;
                doc.setDrawColor(200, 200, 200);
                doc.rect(x - 1, y - 1, w + 2, h + 2);
                doc.addImage(img, 'JPEG', x, y, w, h);
            } catch (err) {
                doc.setTextColor(180, 0, 0);
                doc.setFontSize(11);
                doc.text('[ screenshot unavailable ]', PW / 2, 300, { align: 'center' });
            }

            // Caption
            doc.setTextColor(40, 40, 40);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(11);
            const captionLines = doc.splitTextToSize(scene.caption, PW - 2 * M);
            const capY = PH - 130;
            doc.text(captionLines, M, capY);

            // Hotkey hint
            if (scene.hotkey) {
                doc.setFillColor(245, 240, 220);
                doc.setDrawColor(176, 144, 48);
                doc.rect(M, PH - 80, PW - 2 * M, 28, 'FD');
                doc.setTextColor(110, 80, 0);
                doc.setFont('helvetica', 'bold');
                doc.setFontSize(10);
                doc.text(scene.hotkey, M + 12, PH - 62);
            }

            // Footer
            doc.setTextColor(150, 150, 150);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8);
            doc.text(`Step ${i + 1} of ${scenes.length}`, PW - M, PH - 18, { align: 'right' });
            doc.text('spartaninstallations.com', M, PH - 18);
        });

        // ----- Hotkeys cheat sheet (bonus reference page) ----------------
        doc.addPage();
        doc.setFillColor(26, 26, 26);
        doc.rect(0, 0, PW, 56, 'F');
        doc.setTextColor(176, 144, 48);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.text('SPARTAN — REFERENCE', M, 22);
        doc.setTextColor(224, 221, 213);
        doc.setFontSize(16);
        doc.text('Keyboard shortcuts', M, 44);

        const keys = [
            ['R',          'Rectangle tool'],
            ['S',          'Select tool'],
            ['Esc',        'Cancel any active tool / close popup / deselect'],
            ['Del / ⌫',    'Delete selected piece, sink, or text'],
            ['Ctrl + Z',   'Undo last change'],
            ['Arrows',     'Nudge selected piece by 1 px'],
            ['Shift+Arrow','Nudge selected piece by 10 px'],
            ['Shift (rotation handle)', 'Snap rotation to 15° increments'],
            ['Double-click page tab',   'Rename the page'],
            ['Enter (page name)',       'Save new page name'],
            ['+',          'Add a new page'],
        ];
        doc.setTextColor(40, 40, 40);
        let ky = 96;
        keys.forEach(([k, desc]) => {
            doc.setFont('helvetica', 'bold');
            doc.setFontSize(11);
            doc.text(k, M + 8, ky);
            doc.setFont('helvetica', 'normal');
            doc.text(desc, M + 160, ky);
            ky += 22;
        });

        doc.setTextColor(110, 110, 110);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(10);
        doc.text('Need a refresher? Re-open this manual any time at /?manual=1.', M, PH - 60);

        doc.setTextColor(150, 150, 150);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.text('spartaninstallations.com', M, PH - 18);

        doc.save('Spartan_Getting_Started_Manual.pdf');
    }

    // ------------------------------------------------------- main runner
    async function runManual() {
        try {
            showStatus('Preparing', 'Loading screenshot library…', 2);
            if (!window.html2canvas) await loadScript(H2C_URL);
            stubPersistence();

            const scenes = buildScenes();
            const screenshots = [];
            for (let i = 0; i < scenes.length; i++) {
                const s = scenes[i];
                clearCallouts();
                showStatus(`Capturing ${i + 1} / ${scenes.length}`, s.title, 5 + 90 * i / scenes.length);
                try {
                    await s.setup();
                } catch (err) {
                    console.warn('Scene setup failed:', s.title, err);
                }
                await wait(450);
                let img;
                try {
                    img = await captureScreen();
                } catch (err) {
                    console.warn('Capture failed:', s.title, err);
                    img = null;
                }
                screenshots.push(img);
                clearCallouts();
            }

            showStatus('Building PDF', 'Compiling 30 screens into a single PDF…', 96);
            await wait(200);
            buildPDF(scenes, screenshots);

            showStatus('Done', 'Spartan_Getting_Started_Manual.pdf has been downloaded.', 100);
            await wait(2500);
            hideStatus();
        } catch (err) {
            console.error(err);
            showStatus('Error', String(err && err.message || err), 0);
        }
    }

    function addFAB() {
        const btn = document.createElement('button');
        btn.id = 'manual-fab';
        btn.textContent = '📕 Generate Manual';
        btn.title = 'Run the 30-step walkthrough and download a PDF';
        btn.onclick = runManual;
        document.body.appendChild(btn);
    }

    // ------------------------------------------------------- bootstrap chain
    injectCSS();
    waitForApp().then(() => {
        // Hide login overlay if it's still showing — we assume the dev opens
        // ?manual=1 only after auth has succeeded.
        const lo = document.getElementById('login-overlay');
        if (lo) lo.style.display = 'none';
        addFAB();
    });
})();
