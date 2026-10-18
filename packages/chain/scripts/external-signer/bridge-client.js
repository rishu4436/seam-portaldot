// Browser side of the external-signer bridge. Plain ES module, no dependencies, so the same code runs in the page
// (with the polkadot.js extension) and in tests (with a software signer standing in for the extension).
// It only moves data: a signing payload comes in, the extension's signature goes back. It never sees a key.
export async function runBridge({ base, token, injected, appName = 'SEAM testnet run', log = () => {}, fetchImpl = fetch, stop }) {
  const ext = injected?.['polkadot-js'];
  if (!ext) throw new Error('No polkadot.js extension found in this browser. Install it, unlock it, and reload.');
  const inj = await ext.enable(appName);
  const accounts = await inj.accounts.get();
  log(`extension ready, ${accounts.length} account(s)`);
  const q = `t=${encodeURIComponent(token)}`;
  const hello = await (await fetchImpl(`${base}/api/hello?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accounts: accounts.map((a) => a.address) }) })).json();
  log(`signing for ${hello.address}`);
  let signed = 0;
  while (!(stop?.())) {
    const res = await fetchImpl(`${base}/api/next?${q}`);
    if (res.status === 204) continue;           // long-poll timeout, ask again
    if (res.status === 410) { log('run finished'); break; }
    if (!res.ok) throw new Error(`bridge said ${res.status}`);
    const job = await res.json();
    log(`signing request ${job.id}: ${job.label}`);
    let body;
    try {
      const { signature } = await inj.signer.signPayload(job.payload);   // the extension shows its own approval popup
      body = { id: job.id, signature };
      signed++;
    } catch (e) {
      body = { id: job.id, error: String(e?.message ?? e) };              // rejected in the popup
    }
    await fetchImpl(`${base}/api/signature?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  return { signed };
}
