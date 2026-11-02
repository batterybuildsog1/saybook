#!/usr/bin/env python3
"""PTY integration: interactive setup must not echo keys, must keep API keys out
of config, must provision only isolated resources and apply core migrations.
Uses a command-boundary Wrangler double; no Cloudflare changes or real keys.
"""
from pathlib import Path
import os,pty,select,time,json,tempfile,shutil,subprocess
root=Path(__file__).resolve().parents[1]
out=root/'e2e/out'/time.strftime('%Y-%m-%dT%H-%M-%S-setup',time.gmtime());out.mkdir(parents=True)
checks=[]
def check(name,passed):checks.append({'name':name,'pass':bool(passed)})
with tempfile.TemporaryDirectory(prefix='saybook-setup-e2e-') as folder:
 work=Path(folder)
 for d in ['scripts','src','migrations','bin']:(work/d).mkdir()
 for f in ['scripts/setup.mjs','src/config.js','wrangler.toml','package.json']:
  shutil.copy(root/f,work/f)
 for f in (root/'migrations').glob('*.sql'):shutil.copy(f,work/'migrations'/f.name)
 stub=work/'bin/npx'
 stub.write_text('''#!/usr/bin/env python3
import sys,json,os
args=sys.argv[1:]
with open(os.environ['SETUP_COMMAND_LOG'],'a') as f:f.write(json.dumps(args)+'\\n')
if 'secret' in args:
 value=sys.stdin.read()
 if not value.strip():sys.exit(2)
if args[1:3]==['d1','create']:print('database_id = "00000000-0000-0000-0000-000000000001"')
''');stub.chmod(0o755)
 env=dict(os.environ,PATH=str(work/'bin')+':'+os.environ['PATH'],SETUP_COMMAND_LOG=str(work/'calls.jsonl'))
 master,slave=pty.openpty()
 child=subprocess.Popen(['node',str(work/'scripts/setup.mjs')],stdin=slave,stdout=slave,stderr=slave,env=env,start_new_session=True);os.close(slave)
 transcript=''
 def until(marker):
  global transcript
  deadline=time.monotonic()+30
  while marker not in transcript:
   if time.monotonic()>deadline:raise RuntimeError('Prompt timeout: '+marker)
   if select.select([master],[],[],1)[0]:
    try:b=os.read(master,65536)
    except OSError:break
    if not b:break
    transcript+=b.decode(errors='replace')
  if marker not in transcript:raise RuntimeError('Missing prompt: '+marker)
 def answer(marker,value):
  until(marker);os.write(master,(value+'\r').encode())
 answer('Worker name [storybook]:','saybook-setup-e2e')
 answer('Text API base','')
 answer('Text/vision model','')
 answer('Image API base','')
 answer('Image model','')
 fake_key='fake-value-for-hidden-input-check-only'
 fake_pass='fake-pass-for-hidden-input-check-only'
 answer('Text API key (hidden):',fake_key)
 answer('Image API key (hidden, Enter uses text key):','')
 answer('OpenAI TTS key (hidden, Enter uses text key):','')
 answer('ElevenLabs key (hidden, Enter uses OpenAI TTS):','')
 answer('Family passcode (hidden, Enter leaves this self-host publicly accessible):',fake_pass)
 until('Ready. Open the workers.dev URL above.')
 child.wait(timeout=10);os.close(master)
 calls=[json.loads(x) for x in (work/'calls.jsonl').read_text().splitlines()]
 config=(work/'wrangler.local.toml').read_text()
 check('interactive setup completes',child.returncode==0)
 check('secret prompts never echo fake key or passcode',fake_key not in transcript and fake_pass not in transcript)
 check('resource config contains no secret input',fake_key not in config and fake_pass not in config)
 check('D1 id is parsed into ignored local config','00000000-0000-0000-0000-000000000001' in config)
 check('only named isolated D1 R2 and queue are created',all(x in str(calls) for x in ['saybook-setup-e2e','saybook-setup-e2e-media','saybook-setup-e2e-paint']))
 check('both core migrations are applied',all(x in str(calls) for x in ['0001-core.sql','0002-shares.sql']))
 check('hosted migrations are not applied','hosted-001.sql' not in str(calls))
 check('required text key and optional passcode are sent only to Wrangler secret put',len([x for x in calls if x[1:3]==['secret','put']])==2)
 check('final deploy follows secret installation',calls[-1][1]=='deploy' and next(i for i,x in enumerate(calls) if 'PASSCODE' in x)<len(calls)-1)
 (out/'commands.json').write_text(json.dumps(calls,indent=2)+'\n')
 (out/'transcript.txt').write_text(transcript)
(out/'report.json').write_text(json.dumps({'checks':checks,'passed':sum(c['pass'] for c in checks),'total':len(checks)},indent=2)+'\n')
for c in checks:print(('PASS' if c['pass'] else 'FAIL')+' '+c['name'])
print(out)
raise SystemExit(0 if all(c['pass'] for c in checks) else 1)
