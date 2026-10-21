// =====================================================================
// Piggycat — frontend configuration
// ---------------------------------------------------------------------
// Paste your Supabase project's PUBLIC values here after creating the
// project (Supabase dashboard → Project Settings → API):
//
//   SUPABASE_URL       e.g. "https://abcdefghij.supabase.co"
//   SUPABASE_ANON_KEY  the "anon / public" key (safe to expose in the
//                      browser — Row Level Security in schema.sql is
//                      what actually protects every user's Piggycat)
//
// ⚠️ NEVER put the Supabase SERVICE ROLE key in this file. It bypasses
//    all security rules. It belongs ONLY in Netlify environment
//    variables, used by netlify/functions/* (see README.md).
//
// Leaving the placeholders below in place is safe: the app detects them
// and runs in local/offline mode, saving in the visitor's browser.
// =====================================================================
window.PIGGYCAT_CONFIG = {
  SUPABASE_URL: "YOUR_SUPABASE_URL",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY"
};
