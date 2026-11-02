#!/usr/bin/env python3
"""Deploy the gitignored hosted local config. Test controls require explicit flags."""
import argparse,json,subprocess,re
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--closed',action='store_true',help='Keep signup closed during lifecycle tests')
p.add_argument('--fixtures',action='store_true',help='Secret-bound synthetic Stripe snapshots and guard probes')
p.add_argument('--stripe-test',action='store_true',help='Real Stripe test key/webhook + secret-bound guard probes')
a=p.parse_args()
if a.fixtures and a.stripe_test:raise SystemExit('Choose fixtures or real Stripe test mode')
root=Path(__file__).resolve().parents[2];config=root/'wrangler.hosted.local.toml'
if not config.exists():raise SystemExit('Copy wrangler.hosted.example.toml to wrangler.hosted.local.toml and configure it first')
source=config.read_text()
if not re.search(r'^MODE\s*=\s*"hosted"',source,re.M) or re.search(r'^name\s*=\s*"YOUR_',source,re.M):raise SystemExit('Refusing an unconfigured/non-hosted target')
args=['wrangler','deploy','--config',str(config)]
variables={'HOSTED_TEST_MODE':'false','STRIPE_TEST_FIXTURES':'false'}
if a.closed:variables['HOSTED_OPEN']='false'
if a.fixtures:variables.update(HOSTED_TEST_MODE='true',STRIPE_TEST_FIXTURES='true',STRIPE_MODE='test',STRIPE_PRICE_ID='price_fixture_monthly')
if a.stripe_test:
 private=Path.home()/'.config/saybook'
 setup=json.loads((private/'stripe-test-setup.json').read_text())
 variables.update(HOSTED_TEST_MODE='true',STRIPE_TEST_FIXTURES='false',STRIPE_MODE='test',STRIPE_PRICE_ID=setup['price_id'],STRIPE_PORTAL_CONFIGURATION_ID=setup['portal_configuration_id'])
for key,value in variables.items():args.extend(['--var',f'{key}:{value}'])
raise SystemExit(subprocess.run(args,cwd=root).returncode)
