/* ============================================================
   Pyjama Dz Tag Scanner — configuration
   ------------------------------------------------------------
   Leave both values empty and the scanner runs entirely on this
   device (browser storage). Fill them in and every phone that
   opens the page shares one live database.

   Get them from your Supabase dashboard:
     Project Settings -> Data API -> Project URL
     Project Settings -> API Keys  -> anon / public key

   Run schema.sql in the Supabase SQL editor FIRST, or the tables
   will not exist.

   NOTE ON THE KEY: the anon key ships to the browser and is
   readable by anyone who opens the page. With the permissive
   policies in schema.sql, anyone who has both the page URL and
   that key can read and write your products and scans. That is
   fine for a page you keep to your own phones. If it ever goes
   somewhere public, switch to Supabase Auth and tighten the
   policies — see the README.
   ============================================================ */

window.PYJAMADZ_CONFIG = {
  /* The PROJECT url — no /rest/v1 on the end. The client appends that
     itself, so pasting the REST endpoint here sends every request to
     /rest/v1/rest/v1/... and nothing works. */
  supabaseUrl: "https://dvuabfkngomcclfxbudt.supabase.co",

  /* Project Settings -> API Keys -> the `anon` / public key.
     NEVER put the service_role key here: this file is downloaded by
     every phone that opens the page, and that key bypasses all
     row-level security. */
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR2dWFiZmtuZ29tY2NsZnhidWR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyODQ4MTAsImV4cCI6MjEwNTg2MDgxMH0.0iuy9r-wGsj6cV_q6hDonhpc4snwebAv8JuhYIzdzGI",

  /* ----------------------------------------------------------------
     TWO SEPARATE APPS

     The scanner and the database are deployed independently and meet
     only in Supabase. Put each one's public address here so they can
     link to each other across deployments.

     Leave both empty and they fall back to sibling files in the same
     folder, which is what a single combined deployment needs.

     IMPORTANT: once they are deployed separately, Supabase is no
     longer optional. Without it each app keeps its own private
     browser storage and they will not see each other's data.
     ---------------------------------------------------------------- */
  scannerUrl:  "",       // e.g. "https://pyjamadz-scan.netlify.app"
  databaseUrl: "",       // e.g. "https://pyjamadz-stock.netlify.app"

  // How many recent scans to keep on screen.
  scanWindow: 500,

  /* ----------------------------------------------------------------
     WHICH DECODER READS THE BARCODE

     "auto"   the phone's own engine if it has one (Android = Google
              Play Services), otherwise zbar-wasm, otherwise ZXing.
              Fastest, and right for most phones.

     "zbar"   always use zbar-wasm and ignore the phone's engine.
              Use this if the built-in one misreads YOUR tags — it is
              slower per frame but a different algorithm entirely.

     "cross"  STRICTEST. The phone's engine and zbar-wasm must BOTH
              read the same number before it counts. Roughly halves
              the scan rate, and all but eliminates wrong numbers,
              because two unrelated decoders rarely invent the same
              mistake. Use this if you are still seeing bad reads.

     "native" / "zxing"  force one specific engine, for comparing.

     The engine actually in use is shown when the camera starts, so
     you can tell which one produced a bad read.
     ---------------------------------------------------------------- */
  engine: "cross"
};
