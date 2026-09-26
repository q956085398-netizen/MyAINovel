import pathlib, subprocess, json
root=pathlib.Path.cwd(); dest=root/'app/.t63-commit-check'
paths=subprocess.check_output(['git','ls-tree','-r','--name-only','HEAD','app/src']).decode().splitlines()
for path in paths:
    target=dest/pathlib.Path(path).relative_to('app'); target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes(subprocess.check_output(['git','show','HEAD:'+path]))
config=json.loads((root/'app/tsconfig.json').read_text(encoding='utf-8-sig')); config['references']=[]
(dest/'tsconfig.json').write_text(json.dumps(config),encoding='utf-8')
