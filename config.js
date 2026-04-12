// Per-shop branding — SPARTAN INSTALLATIONS
const BRAND = {

    accessCode:   'Thenry12',

    companyName:  'SPARTAN',
    tagline:      'installations',

    accentColor:  '#b09030',   // gold
    primaryColor: '#2d3a10',   // dark olive green

    storagePrefix: 'spartan',

    logoPath:     null,

    // ── SERVICE KEYS ──────────────────────────────────────────
    clerkPublishableKey: 'pk_test_Zmxvd2luZy1maWxseS02Ni5jbGVyay5hY2NvdW50cy5kZXYk',

    supabaseUrl:  'https://lhmafiizghcfefrohtvm.supabase.co',
    supabaseKey:  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxobWFmaWl6Z2hjZmVmcm9odHZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5OTM4ODIsImV4cCI6MjA5MTU2OTg4Mn0.RQ_hy9ID-99wYUvopQfC27RP-E8iZQ5faSG9-Qal-KQ',

    // Will be set after running: insert into shops (name, max_seats) values ('Spartan', 3);
    shopId: null,

};

if (typeof window !== 'undefined') { window.BRAND = BRAND; }
