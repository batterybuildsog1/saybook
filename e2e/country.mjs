// Edge E2E: deploy an isolated hosted Worker with HOSTED_ALLOWED_COUNTRY=ZZ first.
// It must refuse enrollment before parsing, collecting account data or contacting Stripe.
import fs from 'node:fs/promises';import assert from 'node:assert/strict';
const base=process.env.HOSTED_URL;if(!base)throw Error('Set HOSTED_URL to the isolated country-denial deployment');
const r=await fetch(base+'/auth/signup',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:'{}'});const body=await r.json();const pass=r.status===403&&body.error==='country_restricted';
await fs.mkdir('e2e/out/integration',{recursive:true});await fs.writeFile('e2e/out/integration/country-denial.json',JSON.stringify({at:new Date().toISOString(),base,status:r.status,error:body.error,pass},null,2));
assert.ok(pass,'Enrollment must fail at the country gate before validating or collecting account details');console.log('PASS edge country gate blocks enrollment before collection');
