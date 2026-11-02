#!/usr/bin/env python3
"""Populate only the private hosted deployment’s secrets from explicitly supplied local files; never print values."""
import argparse, json, os, re, secrets, shlex, subprocess
from pathlib import Path
p=argparse.ArgumentParser()
p.add_argument('--stripe-key-file',type=Path)
p.add_argument('--stripe-webhook-file',type=Path)
p.add_argument('--fixtures',action='store_true')
p.add_argument('--text-key-file',type=Path)
p.add_argument('--image-key-file',type=Path)
p.add_argument('--eleven-env-file',type=Path)
p.add_argument('--eleven-key-file',type=Path)
a=p.parse_args()
root=Path(__file__).resolve().parents[2]
config=root/'wrangler.hosted.local.toml'
if not config.exists() or 'MODE = "hosted"' not in config.read_text():raise SystemExit('A private hosted local config is required')
private=Path.home()/'.config/saybook';private.mkdir(mode=0o700,parents=True,exist_ok=True)
def persistent(name,prefix=''):
 path=private/name
 if not path.exists():
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as f:f.write(prefix+secrets.token_hex(32)+'\n')
 os.chmod(path,0o600)
 return path.read_text().strip()
values={'HOSTED_AUTH_PEPPER':persistent('hosted-auth-pepper.key'),
 'HOSTED_TEST_TOKEN':persistent('hosted-test-token.key')}
if a.text_key_file:
 values['TEXT_API_KEY']=a.text_key_file.expanduser().read_text().strip()
 values['IMAGE_API_KEY']=(a.image_key_file or a.text_key_file).expanduser().read_text().strip()
if a.eleven_key_file:values['ELEVENLABS_API_KEY']=a.eleven_key_file.expanduser().read_text().strip()
if a.eleven_env_file:
 env={}
 for line in a.eleven_env_file.expanduser().read_text().splitlines():
  match=re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)=(.*)$',line)
  if match:
   parts=shlex.split(match[2],comments=True);env[match[1]]=parts[0] if parts else ''
 values['ELEVENLABS_API_KEY']=env['ELEVENLABS_API_KEY']
if a.stripe_key_file:
 key=a.stripe_key_file.expanduser().read_text().strip()
 if not re.match(r'^(sk|rk)_test_',key):raise SystemExit('This setup command accepts TEST Stripe keys only')
 values['STRIPE_SECRET_KEY']=key
if a.stripe_webhook_file:
 values['STRIPE_WEBHOOK_SECRET']=a.stripe_webhook_file.expanduser().read_text().strip()
elif a.fixtures:values['STRIPE_WEBHOOK_SECRET']=persistent('hosted-fixture-webhook.key','whsec_')
proc=subprocess.run(['wrangler','secret','bulk','--config',str(config)],cwd=root,input=json.dumps(values),text=True,capture_output=True)
# Wrangler's bulk output names bindings, never values. Still redact every supplied value defensively.
output=proc.stdout+proc.stderr
for value in values.values():
 if value:output=output.replace(value,'[redacted]')
print(output,end='')
raise SystemExit(proc.returncode)
