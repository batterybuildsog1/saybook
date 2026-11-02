#!/usr/bin/env python3
"""Create the authorized test webhook and monthly price using the locally delivered Stripe key.
No values of keys/signatures are ever printed or passed as process arguments.
"""
import json, os, re, subprocess, urllib.request, urllib.parse, urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path.home()/'.config/saybook'
KEY=PRIVATE/'stripe-test.key'
BASE=os.environ.get('HOSTED_URL','').rstrip('/')
if not re.match(r'^https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$',BASE):raise SystemExit('Set HOSTED_URL to the HTTPS hosted test Worker URL')
URL=BASE+'/api/billing/webhook'
VERSION='2026-10-28.endive'
if not KEY.exists():raise SystemExit('Waiting for ~/.config/saybook/stripe-test.key')
secret=KEY.read_text().strip()
if not re.match(r'^(sk|rk)_test_',secret):raise SystemExit('Refusing a non-test Stripe key')
os.chmod(KEY,0o600)
def api(endpoint,params=None,idempotency=None):
 headers={'Authorization':'Bearer '+secret,'Stripe-Version':VERSION}
 data=None
 if params is not None:
  data=urllib.parse.urlencode(params,doseq=True).encode();headers['Content-Type']='application/x-www-form-urlencoded'
 if idempotency:headers['Idempotency-Key']=idempotency
 request=urllib.request.Request('https://api.stripe.com/v1'+endpoint,data=data,headers=headers)
 try:
  with urllib.request.urlopen(request,timeout=30) as response:return json.load(response)
 except urllib.error.HTTPError as e:
  try:code=json.load(e).get('error',{}).get('code','unknown')
  except:code='unknown'
  raise SystemExit(f'Stripe API {endpoint.split("?")[0]} failed: HTTP {e.code}, code {code}')
def save(name,value):
 target=PRIVATE/name
 fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as f:f.write(value)
 os.chmod(target,0o600)
setupFile=PRIVATE/'stripe-test-setup.json'
setup=json.loads(setupFile.read_text()) if setupFile.exists() else {}
# Prefer an already-created matching Saybook TEST price; never touch HVAC Calc's other products.
if setup.get('price_id'):
 price=api('/prices/'+setup['price_id'])
else:
 prices=api('/prices?active=true&limit=100&expand%5B%5D=data.product')['data']
 matches=[p for p in prices if p.get('currency')=='usd' and p.get('unit_amount')==1950 and p.get('recurring',{}).get('interval')=='month' and p.get('recurring',{}).get('interval_count',1)==1 and 'saybook' in str(p.get('product',{}).get('name','')).lower() and p.get('livemode') is False]
 if matches:price=matches[0]
 else:
  product=api('/products',{'name':'Saybook','description':'Parent-managed storybooks; first paid subscription records parental consent.','metadata[app]':'saybook'},'saybook-test-product-v1')
  price=api('/prices',{'product':product['id'],'currency':'usd','unit_amount':1950,'recurring[interval]':'month','metadata[app]':'saybook'},'saybook-test-price-1950-month-v1')
if price.get('livemode') is not False or price.get('unit_amount')!=1950 or price.get('currency')!='usd' or price.get('recurring',{}).get('interval')!='month':raise SystemExit('Unexpected price')
setup['price_id']=price['id'];setup['product_id']=price['product']['id'] if isinstance(price['product'],dict) else price['product'];setup['livemode']=False
webhookFile=PRIVATE/'stripe-test-webhook.key'
if setup.get('webhook_endpoint_id') and webhookFile.exists():
 endpoint=api('/webhook_endpoints/'+setup['webhook_endpoint_id'])
 if endpoint.get('url')!=URL:raise SystemExit('Stored webhook points at an unexpected URL')
else:
 events=['checkout.session.completed','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','invoice.paid','invoice.payment_failed']
 params={'url':URL,'api_version':VERSION,'description':'Saybook hosted TEST billing and paid parent consent'}
 params.update({f'enabled_events[{i}]':name for i,name in enumerate(events)})
 endpoint=api('/webhook_endpoints',params,'saybook-test-hosted-webhook-v1')
 if not endpoint.get('secret','').startswith('whsec_'):raise SystemExit('Stripe did not return a signing secret')
 save('stripe-test-webhook.key',endpoint.pop('secret')+'\n')
setup['webhook_endpoint_id']=endpoint['id'];setup['webhook_url']=URL;setup['api_version']=VERSION
# Create a TEST portal configuration scoped to Saybook, not the account's global default.
if not setup.get('portal_configuration_id'):
 portal=api('/billing_portal/configurations',{'business_profile[headline]':'Manage your Saybook subscription','business_profile[privacy_policy_url]':'https://saybook.app/legal/privacy','business_profile[terms_of_service_url]':'https://saybook.app/legal/terms','features[customer_update][enabled]':'true','features[customer_update][allowed_updates][0]':'email','features[payment_method_update][enabled]':'true','features[invoice_history][enabled]':'true','features[subscription_cancel][enabled]':'true','features[subscription_cancel][mode]':'at_period_end','metadata[app]':'saybook'},'saybook-test-portal-v1')
 setup['portal_configuration_id']=portal['id']
save('stripe-test-setup.json',json.dumps(setup,indent=2)+'\n')
# Send the two Stripe secrets directly over stdin, never through process arguments.
values={'STRIPE_SECRET_KEY':secret,'STRIPE_WEBHOOK_SECRET':webhookFile.read_text().strip()}
result=subprocess.run(['wrangler','secret','bulk','--config',str(ROOT/'wrangler.hosted.local.toml')],cwd=ROOT,input=json.dumps(values),text=True,capture_output=True)
output=result.stdout+result.stderr
for value in values.values():output=output.replace(value,'[redacted]')
print(output,end='')
if result.returncode:raise SystemExit(result.returncode)
print(json.dumps({'mode':'test','price_id':setup['price_id'],'webhook_endpoint_id':setup['webhook_endpoint_id'],'webhook_url':URL,'portal_configuration_id':setup['portal_configuration_id'],'signing_secret':'stored privately and uploaded as Worker secret'},indent=2))
