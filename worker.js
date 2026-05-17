// SneakerVault — Cloudflare Worker
// Proxies requests to Anthropic so the API key never touches the client
//
// Deploy steps:
//   1. Go to https://workers.cloudflare.com and create a free account
//   2. Create a new Worker, paste this entire file in
//   3. Go to Settings → Variables → add a secret called ANTHROPIC_KEY
//      with your sk-ant-... key as the value
//   4. Deploy — note your worker URL (e.g. https://sneakervault.YOUR_NAME.workers.dev)
//   5. Paste that URL into config.js as WORKER_URL

export default {
  async fetch(request, env) {

    // Allow CORS from any origin (your GitHub Pages site)
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    try {
      const body = await request.json();

      // Forward to Anthropic with the secret key from Worker environment
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }
};
